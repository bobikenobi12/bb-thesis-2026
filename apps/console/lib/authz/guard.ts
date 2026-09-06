// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { getOwnerScope } from "@/lib/auth/owner";
import { getActiveScope } from "@/lib/auth/scope";
import { getPdp } from "@/lib/authz";
import { getInjectedActor } from "@/lib/authz/actor-context";
import { urlScopedOrgId } from "@/lib/authz/org-scope";
import type { Action, Resource } from "@/lib/authz/registry";
import { type Actor, ForbiddenError, type ResourceRef } from "@/lib/authz/types";
import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { member } from "@/lib/db/schema";

/**
 * Resolves the verified caller into an Actor (identity → active tenancy scope).
 * Use for list views, which then call getPdp().listAccessible(...) for the id-set.
 *
 * An actor bound via runWithActor() (the MCP server's token path) takes precedence
 * over the session — already PDP-scoped, so no re-resolution is needed.
 */
export async function currentActor(): Promise<Actor> {
	const injected = getInjectedActor();
	if (injected) return injected;
	const { userId, activeOrgId } = await getOwnerScope();
	// THE ADDRESS DECIDES THE TENANT (#4133). `active_organization_id` is a per-session default and
	// was the only input here, so a session pointing at A while the URL named B rendered A's data
	// under B's slug — silently, because nothing compared the two. Where the address names an org,
	// that is the scope; the session is the fallback only where it names none (`/dashboard`,
	// `/cli/login`, `/api/**`, the MCP token path). See `lib/authz/org-scope.ts` for why the URL
	// wins rather than the mismatch throwing.
	const urlOrgId = await urlScopedOrgId(userId);
	if (urlOrgId === null) return getActiveScope(userId, activeOrgId);

	// WHAT COUNTS AS THE RESOLVER AGREEING. `getActiveScope` treats its org argument as a
	// PREFERENCE and substitutes on a miss — deliberately, so a stale session cannot lock anyone
	// out — so the answer has to be checked rather than trusted. But the check is THREE-WAY here,
	// not the two-way `resolveNamedOrgScope` applies to a CLI `--org` header, and the third arm is
	// the difference between this working and the open-core build serving nothing at all:
	const actor = await getActiveScope(userId, urlOrgId);

	// 1. It landed on the org the address named. The multi-tenant answer.
	if (actor.orgId === urlOrgId) return actor;

	// 2. It collapsed to the PERSONAL scope — which is what a single-tenant edition means, not a
	//    substitution. `lib/auth/scope.ts` ignores its org argument entirely when `getEnterprise()`
	//    is null and always answers `orgId === userId`, while community still provisions real
	//    organizations with real slugs and real `member` rows (`lib/auth/onboarding.ts`
	//    provisionPrimaryOrg). So in community EVERY org slug resolves here, and refusing this arm
	//    would 500 every `/{org}/…` page in the AGPL build. The membership join in
	//    `org-scope.ts` has already proved the caller belongs to the named org; community simply
	//    has one tenant to put them in.
	//
	//    ⚠ THIS ARM IS ONLY IN `currentActor()`. `resolveNamedOrgScope` below is still strictly
	//    two-way, so in community it returns null for every real org id — which is why the CLI's
	//    `X-Alethia-Org` path and `authorizeInOrg` refuse there. That is not a regression (both
	//    behaved the same before this change) and `requireHostedBilling` bounds the billing case,
	//    but it is an inconsistency, not a symmetry, and saying otherwise would be a comment
	//    asserting a property the code does not have.
	if (actor.orgId === userId) return actor;

	// 3. A DIFFERENT named org. That is the substitution, and following it would answer a request
	//    addressed to B from some third org's scope — #3863, on the CLI's `--org` header, reaching
	//    the console by a second route.
	//
	//    A ForbiddenError, not a bare Error, on two counts: API and CLI routes classify on that
	//    type to answer 403, and `[org]/layout.tsx` matches the bare string "Unauthorized" EXACTLY
	//    to bounce to sign-in — which this is not. The session is fine; the address is not the
	//    caller's to ask for.
	//
	//    ⚠ It does NOT become a 404 on a page render. `[org]/layout.tsx`'s try/catch wraps only
	//    `resolveOrgScope`, which never calls this; a throw from a page's own reader escapes to
	//    `app/error.tsx`. Reaching this at all means the layout's own membership check has already
	//    passed and the RESOLVER then disagreed, which is a genuine internal inconsistency and not
	//    a stale link — so a 500 is arguably the honest answer. Stated because the alternative is a
	//    comment claiming a landing the tree does not provide.
	throw new ForbiddenError(
		"view",
		{ type: "org", id: urlOrgId },
		"the scope resolver landed on a different organization; the request was NOT served from it",
	);
}

/**
 * The single authorization entry point for server actions / routes: resolve the
 * actor and enforce `action` on `resource` (throws ForbiddenError → 403 on deny).
 * Returns the actor so the caller can scope its query (actor.userId for
 * withOwnerScope). Replaces ad-hoc `.eq(user_id)` ownership checks.
 */
export async function authorize(
	action: Action,
	resource: { type: Resource; id?: string },
): Promise<Actor> {
	const actor = await currentActor();
	const ref: ResourceRef = { type: resource.type, id: resource.id };
	await getPdp().enforce(actor, action, ref);
	return actor;
}

/**
 * Like {@link authorize}, but enforces the permission *without* recording an
 * activity-log entry or emitting an action event (it uses `can()` instead of
 * `enforce()`). For setup / no-op steps that gate on a manage permission but are
 * not themselves user-meaningful events — e.g. seeding a pending cloud identity
 * just to open the connect sheet, which should never show up in the activity feed.
 */
export async function authorizeQuiet(
	action: Action,
	resource: { type: Resource; id?: string },
): Promise<Actor> {
	const actor = await currentActor();
	const ref: ResourceRef = { type: resource.type, id: resource.id };
	const decision = await getPdp().can(actor, action, ref);
	if (!decision.allowed) throw new ForbiddenError(action, ref, decision.reason);
	return actor;
}

function forbidden(): Response {
	return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
}

/** True if `userId` has a `member` row in `orgId` (the personal org — orgId === userId
 *  — is always the user's own, so it needs no membership row).
 *
 *  Passing this is NOT the same as being scoped to `orgId`: the personal-org branch is true
 *  for a value every caller can supply about themselves, and #3863 rode exactly that gap.
 *  {@link resolveNamedOrgScope} is what turns a named org into the scope actually served. */
async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
	if (orgId === userId) return true;
	const [m] = await getServiceDb()
		.select({ id: member.id })
		.from(member)
		.where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
		.limit(1);
	return Boolean(m);
}

/**
 * Resolves `userId`'s scope for an org THE REQUEST NAMED — a CLI `--org` header, a service token's
 * org pin, or the console URL's `{org}` segment (#4133) — and returns null when resolution landed
 * on any other org.
 *
 * The scope resolver treats its org argument as a PREFERENCE: it also serves the console session,
 * whose stored `activeOrganizationId` can name an org the user has since left, and locking somebody
 * out of the console over stale session state would be the wrong trade — so on a miss it falls back
 * to an org they do belong to. A header is not a preference. It is an assertion about this one
 * request, and following the fallback there answers the request from a scope the caller never named.
 *
 * That is #3863: a personal org's id IS the user's id, so `X-Alethia-Org: <own user id>` passed
 * {@link isOrgMember}, found no `member` row, and came back scoped to a TEAM org — on a path
 * `jobs cancel --latest` also walks. ee/src/scope.ts now resolves the personal org explicitly, and
 * this refuses whatever else the resolver may substitute rather than serving it.
 *
 * `null` means exactly "resolution did not land on the org you named". A lookup that FAILS is never
 * reported that way: getActiveScope's rejection propagates, so a database outage surfaces as an
 * error, not as a denial and not as a different tenant's rows.
 *
 * The console URL joined this list in #4133. It belongs here for the same reason the CLI header
 * does and the SESSION does not: `/{org}/…` is what the user is looking at while they act, so it
 * is an assertion about this request. `active_organization_id` is a preference that survives
 * between them, and reading tenancy from it is how a stale one served another org's rows under
 * this org's address.
 */
async function resolveNamedOrgScope(userId: string, orgId: string): Promise<Actor | null> {
	const actor = await getActiveScope(userId, orgId);
	return actor.orgId === orgId ? actor : null;
}

/**
 * Like {@link authorize}, but for an org the CALLER NAMED rather than the one the request is
 * addressed to — and it enforces the permission in THAT org, not in the ambient scope.
 *
 * Exactly one flow needs this, and it is the flow #4133 broke: creating an organization opens a
 * sheet on the CURRENT org's page (`components/org-switcher.tsx` renders `CreateOrgSheet` inside
 * the shell), calls `setActiveOrganization(new)`, and then finishes the subscription against the
 * NEW org from that same page. While the tenant came from the session that worked, because the
 * write had already landed. Now the tenant comes from the address — which still names the old org,
 * correctly, because that is the page the user is on — so `actor.orgId !== input.orgId` and the
 * flow would refuse itself.
 *
 * The old guard was `authorize(verb)` in the ambient scope plus `actor.orgId === input.orgId`. That
 * is not weaker in intent, only in expression: it asked for the verb wherever the session happened
 * to be pointing and then checked that this was the org meant. Naming the org makes the same
 * question order-independent, and `resolveNamedOrgScope` refuses a substituted org rather than
 * enforcing the verb somewhere the caller never named (#3863).
 */
export async function authorizeInOrg(
	action: Action,
	resource: { type: Resource; id?: string },
	orgId: string,
): Promise<Actor> {
	const { userId } = await getOwnerScope();
	const actor = await resolveNamedOrgScope(userId, orgId);
	if (!actor) {
		throw new ForbiddenError(action, { type: resource.type, id: resource.id }, `not scoped to organization ${orgId}`);
	}
	await getPdp().enforce(actor, action, { type: resource.type, id: resource.id });
	return actor;
}

/**
 * Tenancy guard for CLI routes whose path carries an `[id]` org segment: allow only
 * when the resolved scope already targets `orgId`, or the caller is a member of it.
 * Returns a 403 Response to return on denial, or null when access is permitted.
 */
export async function ensureCliOrgAccess(
	actor: Actor,
	userId: string,
	orgId: string,
): Promise<Response | null> {
	if (actor.orgId === orgId) return null;
	if (await isOrgMember(userId, orgId)) return null;
	return forbidden();
}

/**
 * CLI-route authorization: verify the CLI token, resolve the actor, and enforce.
 * Returns `{ actor }` on success or `{ error }` (the Response to return). CLI routes
 * query via getServiceDb() (no RLS), so the caller MUST also scope its query by
 * `actor.orgId` — enforce() is the permission gate, org_id is the tenancy boundary.
 *
 * An optional `X-Alethia-Org` header selects which org the call is scoped to (the CLI
 * `--org` flag). It is honoured only after verifying the caller is a member of that org
 * (else 403) AND that the resolved scope is that same org — a resolver that falls back to
 * some other org of theirs is a 403 here, never a silent substitution (#3863). Absent,
 * behaviour is identical to resolving the default active scope.
 *
 * A SERVICE-ACCOUNT token overrides that entirely: its org is fixed at mint time, a conflicting
 * header is refused rather than ignored, and the minting profile's membership is re-checked on every
 * request. See the branch below.
 */
export async function authorizeCli(
	req: Request,
	action: Action,
	resource: { type: Resource; id?: string },
): Promise<{ actor: Actor } | { error: Response }> {
	const { payload, error } = await verifyCliToken(req);
	if (error) return { error };
	const userId = payload?.sub;
	if (!userId) {
		return {
			error: new Response(JSON.stringify({ error: "Invalid token payload" }), {
				status: 400,
			}),
		};
	}
	const headerOrg = req.headers.get("X-Alethia-Org")?.trim();

	// ── A SERVICE TOKEN'S ORG IS FIXED AT MINT TIME AND WINS. ──
	//
	// The header exists so a HUMAN can pick which of their orgs a call is scoped to, and the
	// membership check below is what makes that safe. A service token has no human behind it: its
	// org was chosen when it was minted, and letting a request re-point it would mean a token issued
	// to one tenant could act on another — the tenancy boundary these routes rest on, since CLI
	// routes query via getServiceDb() with no RLS underneath them.
	//
	// A CONFLICTING header is REFUSED, not silently ignored. Ignoring it would let a pipeline
	// believe it is writing to org B while every write lands in org A, and that is worse than an
	// error: it is a wrong answer that looks like a right one.
	const serviceOrg = payload?.service_token_org_id;
	if (typeof serviceOrg === "string" && serviceOrg) {
		if (headerOrg && headerOrg !== serviceOrg) {
			return { error: forbidden() };
		}
		// Re-checked on EVERY request rather than trusted from mint time. A token acts as the
		// profile that created it, so it must stop working the moment that profile stops being a
		// member — otherwise revoking somebody's access would leave their tokens live, which is
		// exactly the offboarding hole long-lived credentials are known for.
		if (!(await isOrgMember(userId, serviceOrg))) {
			return { error: forbidden() };
		}
		// The pin is a named org like a header is, so it gets the same treatment: a scope that
		// resolves to anything other than the pinned org is refused, never substituted.
		const serviceActor = await resolveNamedOrgScope(userId, serviceOrg);
		if (!serviceActor) return { error: forbidden() };
		try {
			await getPdp().enforce(serviceActor, action, { type: resource.type, id: resource.id });
		} catch (e) {
			if (e instanceof ForbiddenError) return { error: forbidden() };
			throw e;
		}
		return { actor: serviceActor };
	}

	if (headerOrg && !(await isOrgMember(userId, headerOrg))) {
		return { error: forbidden() };
	}
	// With a header the org is part of the REQUEST, so the resolved scope must BE it (see
	// resolveNamedOrgScope). Without one there is nothing to compare against: resolving the
	// caller's default scope is the whole intent, and that path is left alone.
	const actor = headerOrg
		? await resolveNamedOrgScope(userId, headerOrg)
		: await getActiveScope(userId);
	if (!actor) return { error: forbidden() };
	try {
		await getPdp().enforce(actor, action, { type: resource.type, id: resource.id });
	} catch (e) {
		if (e instanceof ForbiddenError) return { error: forbidden() };
		throw e;
	}
	return { actor };
}

/**
 * Enforces `action` on `resource` for an already-resolved userId (e.g. provider
 * routes that authenticated via resolveCliProvider). Returns a 403 Response on
 * denial, or null when allowed. Callers that also need explicit org scoping should
 * resolve the actor via getActiveScope (or use authorizeCli, which returns it).
 */
export async function authorizeUserId(
	userId: string,
	action: Action,
	resource: { type: Resource; id?: string },
): Promise<Response | null> {
	const actor = await getActiveScope(userId);
	try {
		await getPdp().enforce(actor, action, { type: resource.type, id: resource.id });
	} catch (e) {
		if (e instanceof ForbiddenError) return forbidden();
		throw e;
	}
	return null;
}
