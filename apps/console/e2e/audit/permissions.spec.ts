// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// T7 — "a forbidden page renders a deliberate state, not a blank."
//
// WHICH PERSONA IS FORBIDDEN ANYTHING IS A MEASUREMENT, AND THE FIRST ANSWER WAS WRONG.
//
// This spec first ran (#3894) with a Better Auth `member`, which `MEMBERSHIP_ROLE_ALIASES`
// resolves to Alethia's `viewer`. It found nothing: all 27 org-only routes came back
// `no-restricted-surface`, T7 rendered `—`, and a predicate that cannot fail is not yet a check
// (#3898). Neither the fixture nor the predicate was the gap. The gap was the PRIVILEGE LADDER the
// predicate assumed, and there isn't one.
//
// MEASURED against `lib/authz/registry.ts` — whose role bundles are DERIVED below rather than
// re-typed here, so a registry edit moves this file's answer instead of silently outdating it:
//
//   · The console refuses a route at RENDER TIME in exactly three places. Each is a server
//     component that awaits a bootstrap, catches `ForbiddenError`, and renders a deliberate
//     no-access `Alert` — which is precisely the thing T7 exists to measure:
//
//         app/(private)/[org]/~/alerts/page.tsx           needs `alert:view_alerts`
//         app/(private)/[org]/~/settings/roles/page.tsx   needs `member:view`
//         app/(private)/[org]/~/settings/sso/page.tsx     needs `member:view`
//
//     Everywhere else the console authorizes at the ACTION level: the page renders for anybody in
//     the org and a capability flag (`canManage`, `canManageCaps`, `seeAll`, `canInvite`) takes
//     affordances away rather than refusing the route. `~/settings/billing` and `~/settings/activity`
//     are client panels whose read actions resolve `currentActor()` and enforce nothing at all.
//
//   · A `viewer` holds BOTH `member:view` and `alert:view_alerts`, so it is refused none of the
//     three — which is the whole of #3898's `—`. An `operator` holds neither of the member-
//     management ones, so it is refused TWO of them. The two roles are INCOMPARABLE, and
//     `org-access-control.ts` says so in `toPdpRole`'s own doc ("a viewer may read members and
//     activity; an operator may deploy"): "least privileged" is not a total order here, and the
//     least-privileged actor for the console's route-level gates is the operator, not the viewer.
//
//   · `~/alerts` is refused to NO built-in role. Only a custom (Enterprise) role or a member left
//     with zero grants (#3754) can reach that branch, and neither is a persona this spec builds.
//     Recorded, not measured — see the arithmetic test below, which counts the subjects it has.
//
// So the persona is an `operator` (PERSONA_ROLE), invited through the same endpoint the console's
// own invite dialog calls, with a role that dialog offers. AND NOTHING IS SEEDED FOR IT: both
// surfaces it is refused exist in every org on every plan with no rows written. That is what makes
// #3898's answer "the persona was wrong" rather than "the fixture was thin" — there was no thin
// fixture to thicken.
//
// The persona has to be REAL. There is no second persona anywhere in this repo today
// (`e2e/global-setup.ts` says so in a comment: it creates ownerHobby and, best-effort, ownerTeam,
// and leaves member "for a later step"), so this spec builds one — and it builds it through the
// PRODUCT'S OWN endpoints, better-auth's organization plugin, the same ones the invite dialog
// calls, from two real cookie-bearing browser contexts. Nothing is written straight into `member`:
// a raw row would skip whatever the accept path does to provision access, and the persona would
// then be denied EVERYWHERE for a reason that has nothing to do with roles.
//
// TWO THINGS THIS RAN INTO, both measured:
//
//   · **Inviting is a PAID feature, enforced at the endpoint.** `app/api/auth/[...all]/route.ts`
//     gates `invite-member` on the `organizations` entitlement, so a fresh Hobby org gets
//     `403 upgrade_required` — not from the dialog, from the API. So the fixture grants this org's
//     billing record `plan=team, status=active` first. That is a fixture, not a bypass: the gate
//     itself is exercised (an unentitled org really is refused, which is how this was found), and
//     the audit's own org is untouched — T7 works in an org of its OWN, created here, so the
//     empty-org pass in `routes.spec.ts` cannot be disturbed by a plan change or by a second member.
//
//   · **A member with NO access renders the org's 404 on every route**, every one of those is
//     "a deliberate state", and T7 would report a column of PASSes while measuring nothing about
//     permissions. So the run asserts FIRST that the persona can load a route normally. If it
//     cannot, the instrument is broken and this spec says so instead of scoring.
//
// And for the same reason RESTRICTION IS MEASURED AS A DIFFERENCE. Every route is driven twice —
// once as the persona, once as the OWNER of the same org — and a route counts as restricted only
// where the two disagree. A redirect on its own proves nothing: `/dashboard` and `~/settings`
// redirect every caller, so reading "the persona was bounced" as refusal scored T7 PASS on routes
// that restrict nobody.

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
	BUILT_IN_ROLES,
	PERMISSIONS,
	type BuiltInRole,
	type PermissionKey,
} from "@/lib/authz/registry";
import { existsSync } from "node:fs";
import path from "node:path";
import { closeDb, db, orgIdBySlug } from "../helpers/db";
import { signUpWithOtp } from "../fixtures/auth";
import { materialize, needsOnlyOrg, type AuditContext } from "./context";
import { consoleRoutes, repoRoot } from "./manifest";
import { rendersSharedErrorState, visibleText } from "./error-state";
import { createReport } from "./report";

const manifest = consoleRoutes();
const ctx: AuditContext = { orgSlug: "", owner: { userId: "", orgId: "" } };
// This spec's OWN verdict buffer — see report.ts on why it must not be module state.
const report = createReport();
const record = report.record;

/**
 * The role T7's persona is invited with — the least-privileged actor for the console's
 * ROUTE-LEVEL gates, which is not the least-privileged role overall. See the header.
 *
 * It is a `BuiltInRole`, not a string: a role this repo has renamed or dropped must be a compile
 * error here, not a 400 from `invite-member` two minutes into a run.
 */
const PERSONA_ROLE: BuiltInRole = "operator";

/**
 * The permission each of the console's render-time gates enforces, with the file that enforces it.
 *
 * HAND-MAINTAINED, and that is a liability this comment names rather than hides: the gates are a
 * `try { await bootstrap() } catch (e) { if (e instanceof ForbiddenError) … }` shape, which no grep
 * derives honestly. So it decays in both directions — a gate the console GROWS is missing here, and
 * a gate the console DELETES lingers here, which would leave the arithmetic below claiming a
 * subject T7 no longer has. That second one is the dangerous direction, and it is why these routes
 * double as T7'S POSITIVE CONTROL: a route on this list whose permission the persona provably lacks
 * and that nevertheless reads as unrestricted FAILS its own test (see the per-route branch below),
 * rather than recording a quiet N/A. A stale entry therefore turns the run RED and names itself; it
 * cannot manufacture a subject that only exists in this array.
 */
const ROUTE_LEVEL_GATES: readonly { route: string; permission: PermissionKey; file: string }[] = [
	{
		route: "/[org]/~/alerts",
		permission: "alert:view_alerts",
		file: "app/(private)/[org]/~/alerts/page.tsx",
	},
	{
		route: "/[org]/~/settings/roles",
		permission: "member:view",
		file: "app/(private)/[org]/~/settings/roles/page.tsx",
	},
	{
		route: "/[org]/~/settings/sso",
		permission: "member:view",
		file: "app/(private)/[org]/~/settings/sso/page.tsx",
	},
];

/** The permission keys a built-in role grants, read out of the registry (`"*"` = all of them). */
function bundleOf(role: BuiltInRole): ReadonlySet<PermissionKey> {
	const grant = BUILT_IN_ROLES[role];
	return new Set(grant === "*" ? PERMISSIONS.map((p) => p.key) : grant);
}

let personaContext: BrowserContext | null = null;
let personaPage: Page | null = null;
let personaEmail = "";
// The OWNER stays open for the whole spec. T7's question is comparative — see `observe` below —
// and answering it needs the same route driven by somebody who is not the persona.
let ownerContext: BrowserContext | null = null;
let ownerPage: Page | null = null;

/**
 * Signs an account up, retrying the whole walk — WITH A FRESH ADDRESS EACH TIME.
 *
 * `signUpWithOtp` waits 5s for the consent banner and 30s for the OTP, and on a contended runner
 * the first of those is genuinely tight; `e2e/global-setup.ts` wraps every persona in the same
 * shape for the same reason ("transient recompile 500s, slow OTP"). A T7 persona that fails to be
 * born takes the whole predicate with it.
 *
 * THE ADDRESS MUST CHANGE PER ATTEMPT, and this is not tidiness. `signUpWithOtp` creates the
 * account at OTP verification and then still has to walk onboarding, the clickwrap and the org
 * hand-off. A failure in any of those — precisely the transient case the retry exists for — leaves
 * a REAL account behind. Retried on the same address the flow is a SIGN-IN, `/onboarding` never
 * appears, and the fixture's `waitForURL(/\/onboarding/)` times out after 30s. Every later attempt
 * is then guaranteed to fail, and the run spends two 35s sleeps and two 30s timeouts proving it
 * inside a 180s test budget. So the caller gets back the address that actually worked.
 */
async function signUpWithRetry(
	page: Page,
	emailFor: (attempt: number) => string,
	attempts = 3,
): Promise<{ email: string; orgSlug: string }> {
	let last: unknown;
	for (let i = 1; i <= attempts; i++) {
		const email = emailFor(i);
		try {
			const { orgSlug } = await withTestEmail(email, () => signUpWithOtp(page));
			return { email, orgSlug };
		} catch (err) {
			last = err;
			const why = err instanceof Error ? err.message : String(err);
			// WHERE it stopped, not just that it did. A bare "locator timed out" sends the reader to
			// the locator; the URL and the first line of the page say whether the walk was on the
			// signup form at all — which is how the "already signed in, so /signup redirected"
			// case tells itself apart from "the consent button was renamed".
			const where = await page
				.evaluate(() => `${location.pathname} :: ${document.body.innerText.trim().slice(0, 160)}`)
				.catch(() => "(page unreadable)");
			console.warn(`[audit/T7] signup ${email} attempt ${i}/${attempts}: ${why}\n    at ${where}`);
			await page.context().clearCookies();
			// 35s, not 2s. Better Auth caps OTP issuance at 5 sends / 60s per IP
			// (`lib/config/auth.ts`), and a retry inside that window gets "Too many requests" and
			// burns an attempt without ever asking for a code. Measured: three attempts, 2s apart,
			// all three refused by the rate limiter.
			await page.waitForTimeout(35_000);
		}
	}
	throw last;
}

/**
 * Runs `fn` with `signUpWithOtp` pointed at `email`.
 *
 * `fixtures/auth.ts` reads `TEST_USER_EMAIL` and otherwise invents an address. Setting it around
 * the call is how this spec reuses the whole vetted signup walk — consent, OTP, onboarding, the
 * clickwrap — for an address it has to choose, instead of writing a second copy of it that would
 * drift the first time the gate changes.
 */
async function withTestEmail<T>(email: string, fn: () => Promise<T>): Promise<T> {
	const prior = process.env.TEST_USER_EMAIL;
	process.env.TEST_USER_EMAIL = email;
	try {
		return await fn();
	} finally {
		if (prior === undefined) delete process.env.TEST_USER_EMAIL;
		else process.env.TEST_USER_EMAIL = prior;
	}
}

/**
 * Calls a better-auth organization endpoint from inside the page, so the request carries the
 * session cookie exactly as the console's own client does.
 */
async function authApi(page: Page, endpoint: string, body: unknown): Promise<{ status: number; text: string }> {
	return page.evaluate(
		async ([path, payload]) => {
			const res = await fetch(`/api/auth/organization/${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			return { status: res.status, text: (await res.text()).slice(0, 400) };
		},
		[endpoint, body] as const,
	);
}

test.beforeAll(async ({ browser }, testInfo) => {
	// `storageState: undefined` is LOAD-BEARING, and it is the opposite of what the API reads like.
	// Playwright's `browser` fixture applies the project's `use` to every context made through it,
	// so `browser.newContext()` here inherits the audit project's `storageState` — the audit
	// PERSONA's session. Measured: the T7 owner signup opened `/signup` and was redirected straight
	// into the persona's org, already signed in, so the consent step never appeared; three retries
	// later it invited from the WRONG org and got a 403 for an entitlement the fixture had granted
	// to a different one. Clearing it is what makes this a genuinely new account.
	const baseURL = testInfo.project.use.baseURL;
	// An org of its OWN, not the audit persona's: T7 needs a paid plan and a second member, and
	// both would change what `routes.spec.ts` measures on the org it deliberately keeps empty.
	ownerContext = await browser.newContext({ baseURL, storageState: undefined });
	// A local binding as well as the module-level one: the module-level `ownerPage` is nullable
	// (T7's per-route comparison reads it), and narrowing it once here keeps the setup readable.
	const asOwner = await ownerContext.newPage();
	ownerPage = asOwner;
	{
		const stamp = Date.now();
		const owner = await signUpWithRetry(asOwner, (i) => `e2e-audit-owner-${stamp}-${i}@alethia.test`);
		ctx.orgSlug = owner.orgSlug;
		const orgId = await orgIdBySlug(ctx.orgSlug);
		expect(orgId, `no organization row for "${ctx.orgSlug}"`).toBeTruthy();
		if (!orgId) return;
		ctx.owner.orgId = orgId;

		// The paid-plan fixture. `resolveEntitlements` reads the org's billing record and only
		// `trialing`/`active` grant the plan's entitlements, so anything less leaves the invite
		// endpoint returning 403 and T7 unmeasurable.
		await db()`
			insert into organization_billing (organization_id, plan, status)
			values (${orgId}, 'team', 'active')
			on conflict (organization_id) do update set plan = 'team', status = 'active'`;
		const granted = await db()<{ plan: string; status: string }[]>`
			select plan, status from organization_billing where organization_id = ${orgId}`;
		expect(granted[0], `no organization_billing row for ${orgId} after the grant`).toBeTruthy();
		// Best-effort, and deliberately NOT asserted: this build answers 404 on
		// `organization/set-active`, and it does not matter — a freshly onboarded account has
		// exactly one membership, and `[org]/layout.tsx` re-syncs the session's active org to the
		// `{org}` segment on every request anyway. Asserted, it would fail the whole predicate for
		// a call that changes nothing.
		await authApi(asOwner, "set-active", { organizationId: orgId });

		// THE INVITEE SIGNS UP FIRST, then is invited at whatever address it ended up with. The
		// other order coupled the invitation to an address chosen before the signup ran, so a retry
		// that (correctly) minted a fresh one would have invited an account that does not exist.
		personaContext = await browser.newContext({ baseURL, storageState: undefined });
		const invitee = await personaContext.newPage();
		personaPage = invitee;
		const persona = await signUpWithRetry(invitee, (i) => `e2e-audit-${PERSONA_ROLE}-${stamp}-${i}@alethia.test`);
		personaEmail = persona.email;

		// `PERSONA_ROLE`, not better-auth's default `member`. The organization plugin is configured
		// with OUR role vocabulary (`ee/src/index.ts`: `ac: core.orgAc, roles: core.orgRoles`), and
		// `components/settings/members/invite-member-dialog.tsx` offers exactly this role — so this
		// is the product's own invitation, not a role invented for a test.
		const invited = await authApi(asOwner, "invite-member", {
			email: personaEmail,
			role: PERSONA_ROLE,
			organizationId: orgId,
		});
		expect(
			invited.status,
			`inviting the ${PERSONA_ROLE} persona failed (${invited.status}): ${invited.text}\n` +
				`  org ${ctx.orgSlug} (${orgId}) billing=${JSON.stringify(granted[0])}\n` +
				`  A 400 naming the ROLE means the organization plugin is not carrying our vocabulary:\n` +
				`  better-auth's own roles are owner/admin/member, and "${PERSONA_ROLE}" exists only\n` +
				`  because ee/src/index.ts passes \`ac: core.orgAc, roles: core.orgRoles\`. Same cause as\n` +
				`  the 403 below — @alethia/ee did not load — so check that first.\n` +
				`  A 403 "upgrade_required" WITH a team/active billing row means the console resolved\n` +
				`  COMMUNITY entitlements, which happens when it did not load @alethia/ee: without the\n` +
				`  enterprise module lib/auth/scope.ts falls back to { orgId: userId }, an org with no\n` +
				`  billing record. Build it (\`pnpm -F @alethia/ee build\`) and restart the console. Note\n` +
				`  that ee/dist is gitignored, so an rsync-based deploy can delete it — measured on a\n` +
				`  sandbox env, where \`pnpm env:push\` left the console silently in community scope.\n` +
				`  T7 cannot be measured without the persona — do not let this become a skipped predicate.`,
		).toBeLessThan(400);

		// Not `helpers/db.ts:pendingInvitationId` — it quotes `"organizationId"`, and the real column
		// is `organization_id` (the drizzle instance maps the schema's camelCase keys through
		// `casing: "snake_case"`), so that helper throws on every call. Flagged; out of scope here.
		const pending = await db()<{ id: string }[]>`
			select id from invitation
			where organization_id = ${orgId} and email = ${personaEmail} and status = 'pending'
			order by created_at desc limit 1`;
		const invitationId = pending[0]?.id ?? null;
		expect(invitationId, `no pending invitation for ${personaEmail} in ${orgId}`).toBeTruthy();
		const accepted = await authApi(invitee, "accept-invitation", { invitationId });
		expect(accepted.status, `accepting the invitation failed (${accepted.status}): ${accepted.text}`).toBeLessThan(400);
		// Same: best-effort. The persona now belongs to two orgs, and the org layout resolves the
		// scope from the URL segment, so the routes below are driven in the audited org regardless.
		await authApi(invitee, "set-active", { organizationId: orgId });

		const role = await db()<{ role: string }[]>`
			select role from member
			where organization_id = ${orgId} and user_id = (select id from "user" where email = ${personaEmail})`;
		const stored = role[0]?.role;
		expect(stored, `${personaEmail} is not a member row in ${orgId}`).toBeTruthy();
		// THE STORED ROLE, not just the row. `member.role` DEFAULTS to better-auth's `member` — which
		// aliases to `viewer`, which is refused nothing — so a plugin that quietly dropped the invited
		// role would rebuild #3898's persona exactly, and T7 would go back to reporting 27 N/A with
		// nothing anywhere saying why. Read the way the product reads it (the org plugin stores a
		// comma-joined list and splits on read), so a legitimate multi-role value is not a failure.
		expect(
			(stored ?? "").split(",").map((r) => r.trim()),
			`${personaEmail} was invited as "${PERSONA_ROLE}" and stored as "${stored}". T7's subject ` +
				`is the set of routes this role is refused; a different role means a different subject, ` +
				`and possibly none at all.`,
		).toContain(PERSONA_ROLE);
	}
});

test.afterAll(async () => {
	await personaContext?.close();
	await ownerContext?.close();
	report.write(ctx.orgSlug, "ui-audit-permissions.json");
	await closeDb();
});

/** What a persona sees on a route: the content region, reduced to the things T7 asks about. */
interface Observation {
	path: string;
	text: string;
	length: number;
	sharedErrorState: boolean;
	sharedEmpty: boolean;
	denialCopy: boolean;
}

async function observe(page: Page): Promise<Observation> {
	const sharedErrorState = await rendersSharedErrorState(page);
	// `visibleText` (innerText), NOT textContent: the document carries tens of kilobytes of inline
	// script source, so a textContent-based "is this blank?" answers "no" for a genuinely blank
	// page — which is the entire question T7 asks. Measured, see e2e/audit/error-state.ts.
	const text = await visibleText(page);
	const sharedEmpty = await page.evaluate(
		() => !!(document.querySelector("main") ?? document.body).querySelector('[data-slot="empty"]'),
	);
	return {
		path: new URL(page.url()).pathname,
		text: text.slice(0, 240),
		length: text.length,
		sharedEmpty,
		sharedErrorState,
		denialCopy:
			// NOT a bare /permission/: `~/settings/roles` is a page ABOUT permissions and says the
			// word all over its ordinary content, so the loose form would read a page the persona is
			// fully allowed to see as a refusal — and then score T7 PASS on it.
			/(don'?t have (access|permission)|do not have (access|permission)|not authori[sz]ed|no permission|forbidden|403|not found|404|ask an (owner|admin))/i.test(
				text,
			),
	};
}

/** Loads `url` in `page` and reports what a person would see there. */
async function visit(page: Page, url: string): Promise<Observation> {
	await page.goto(url, { waitUntil: "domcontentloaded" });
	await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
	return observe(page);
}

// THE PREDICATE MUST HAVE A SUBJECT, and this is the test that says so out loud.
//
// #3898's finding was not a failing route. It was a column of N/A: the persona was refused nothing,
// so T7 rendered `—` and could not fail. Nothing anywhere distinguished that from "not run yet",
// and nothing would have noticed if the console's last route-level gate were deleted tomorrow.
//
// So the subject is COUNTED, from the registry's own role bundles, and an empty count is a FAILURE
// rather than a quiet column of dashes. It drives no page: the question is arithmetic — does this
// role lack a permission some page refuses on? — so its answer cannot be lost to a flaky render.
//
// ONE MORE WAY IT CAN MEASURE NOTHING, and the arithmetic above cannot see it.
//
// `refused` is derived from ROUTE_LEVEL_GATES, which is a list typed by hand. The per-route
// checks below iterate `manifest.routes.filter(needsOnlyOrg)` instead — so a gated route that is
// DELETED, RENAMED, or gains a second parameter leaves the manifest and is never driven, while it
// stays in ROUTE_LEVEL_GATES and keeps counting toward the subject. T7 then reports 0 measured and
// 27 N/A with every assertion green: #3898 again, arrived at from the other direction.
//
// The list decays silently because nothing compares it to its source. So compare it — first, and
// as its own failure, so the count below can never be computed from a route that is not driven.
test("every route-level gate is a route the audit actually drives — otherwise the subject is fiction", () => {
	const driven = new Set(manifest.routes.filter(needsOnlyOrg).map((r) => r.route));
	const undriven = ROUTE_LEVEL_GATES.filter((g) => !driven.has(g.route));
	expect(
		undriven.map((g) => `${g.route} (${g.permission}, ${g.file})`),
		`ROUTE_LEVEL_GATES names ${undriven.length} route(s) the audit never visits — they are not ` +
			`in the manifest, or no longer satisfy needsOnlyOrg. Each still counts toward T7's ` +
			`subject while measuring nothing, which is exactly the shape #3898 was filed about.\n` +
			`  Fix the LIST, not this assertion: if the page moved, re-point the entry; if it was ` +
			`deleted, delete the entry. If deleting it empties the list, the test below says so.`,
	).toEqual([]);
});

// The gate list also names a FILE, and that name is the reader's only route back to the enforcing
// code. It is checked separately and against the filesystem, so this still fails if the manifest
// and needsOnlyOrg both change under it — two independent ways to be wrong, two assertions.
test("every route-level gate names an enforcing file that exists", () => {
	const consoleRoot = path.join(repoRoot(), "apps", "console");
	const missing = ROUTE_LEVEL_GATES.filter((g) => !existsSync(path.join(consoleRoot, g.file)));
	expect(
		missing.map((g) => `${g.route} → ${g.file}`),
		`a gate names an enforcing file that is not in the tree. The permission it claims is ` +
			`enforced there cannot be, so the subject T7 counts is not the surface it measures.`,
	).toEqual([]);
});

test(`the ${PERSONA_ROLE} persona is refused something — otherwise T7 has no subject and can only report "—"`, () => {
	const held = bundleOf(PERSONA_ROLE);
	// Restricted to DRIVEN routes on purpose. The test above fails first when the two disagree,
	// but if it is ever weakened this keeps the count honest rather than inheriting the fiction.
	const driven = new Set(manifest.routes.filter(needsOnlyOrg).map((r) => r.route));
	const refused = ROUTE_LEVEL_GATES.filter((g) => driven.has(g.route) && !held.has(g.permission));
	expect(
		refused.map((g) => `${g.route} (${g.permission}, ${g.file})`),
		`"${PERSONA_ROLE}" holds every permission the console's route-level gates enforce ` +
			`(${ROUTE_LEVEL_GATES.map((g) => g.permission).join(", ")}), so every route below will ` +
			`record N/A "no-restricted-surface" and T7 will measure nothing — exactly #3898.\n` +
			`  This is a FACT ABOUT THE CONSOLE, not a broken test: either the gates changed, or the ` +
			`role bundles in lib/authz/registry.ts did. Re-derive which role is refused what and ` +
			`re-point PERSONA_ROLE (and RUBRIC.md's T7 row) at it — do NOT relax this assertion.`,
	).not.toEqual([]);
});

test(`the ${PERSONA_ROLE} persona really is in the org — otherwise T7 measures the org 404, not permissions`, async () => {
	expect(personaPage, "no persona page was created").not.toBeNull();
	if (!personaPage) return;
	const seen = await visit(personaPage, `/${ctx.orgSlug}`);
	expect(
		seen.path.startsWith(`/${ctx.orgSlug}`),
		`the persona was bounced off the org overview to ${seen.path} — it has no access to the ` +
			`audited org at all, so every T7 verdict below would be about the org 404. Fix the ` +
			`invitation path before believing any T7 number.`,
	).toBe(true);
	expect(
		seen.sharedErrorState || seen.denialCopy,
		`the org overview rendered a denial for the ${PERSONA_ROLE} persona: "${seen.text}". It holds ` +
			`project:view, so this is the instrument breaking, not a permission being enforced.`,
	).toBe(false);
});

test.describe(`T7 · what the ${PERSONA_ROLE} persona gets on each route`, () => {
	for (const route of manifest.routes.filter(needsOnlyOrg)) {
		test(`${route.route}`, async () => {
			expect(personaPage).not.toBeNull();
			if (!personaPage) return;
			// A redirect-only route has no surface to restrict: it exists to send the caller
			// somewhere else, and reading that redirect as "the persona was refused" would score a
			// T7 PASS on the product working normally.
			if (route.isRedirectOnly) {
				record({
					route: route.route,
					url: materialize(route, ctx),
					predicate: "T7",
					verdict: "N/A",
					reason: "no-restricted-surface",
					evidence: { redirectOnly: true },
				});
				return;
			}
			const url = materialize(route, ctx);
			const seen = await visit(personaPage, url);

			// RESTRICTION IS A DIFFERENCE, NOT A REDIRECT.
			//
			// The first version read "the persona was redirected" as evidence of refusal on its own,
			// and that scores a PASS on routes that redirect EVERYONE: `/dashboard` is the app's
			// "where do I belong" hop (JSX beside its `redirect()`, so `isRedirectOnly` does not
			// catch it) and `~/settings` sends every caller to its default tab. Both bounced the
			// persona, both were recorded restricted-and-deliberate, and T7 reported green over a
			// route that restricted nothing — the exact column-of-PASSes failure this file's header
			// warns about.
			//
			// So the same URL is driven by the OWNER of the same org, and only a difference counts:
			// the persona ends up somewhere the owner does not, or sees a denial the owner does not.
			const byOwner = ownerPage ? await visit(ownerPage, url) : null;
			const personaRedirected = !seen.path.startsWith(url.replace(/\/$/, ""));
			const ownerRedirectedSameWay = byOwner !== null && byOwner.path === seen.path;
			const redirectedAway = personaRedirected && !ownerRedirectedSameWay;
			const deniedWhereOwnerIsNot =
				(seen.sharedErrorState && !(byOwner?.sharedErrorState ?? false)) ||
				(seen.denialCopy && !(byOwner?.denialCopy ?? false));
			const restricted = redirectedAway || deniedWhereOwnerIsNot;
			const evidence = { persona: seen, owner: byOwner, redirectedAway, deniedWhereOwnerIsNot };

			if (!restricted) {
				record({
					route: route.route,
					url,
					predicate: "T7",
					verdict: "N/A",
					reason: "no-restricted-surface",
					evidence,
				});
				// THE POSITIVE CONTROL, and the record above stands whichever way this goes: the run
				// really did observe no restricted surface, and saying otherwise would be inventing a
				// verdict. What must not happen is this observation passing QUIETLY on a route the
				// registry says the persona cannot load — that is #3898's column of N/A with nothing
				// red anywhere, one route at a time.
				const gate = ROUTE_LEVEL_GATES.find((g) => g.route === route.route);
				const provablyRefused = gate !== undefined && !bundleOf(PERSONA_ROLE).has(gate.permission);
				expect(
					provablyRefused,
					`T7 ${route.route}: "${PERSONA_ROLE}" does not hold \`${gate?.permission}\`, which ` +
						`${gate?.file} enforces at render — so this page must have refused it, and it did ` +
						`not. Three things do this, in the order worth checking:\n` +
						`  1. the gate was DELETED or now enforces something else — fix ROUTE_LEVEL_GATES, ` +
						`and re-derive whether ${PERSONA_ROLE} is still the right persona at all;\n` +
						`  2. the persona is not really a ${PERSONA_ROLE} — an invitation that lands with no ` +
						`grant (#3754) or the default role would both leave it reading as a viewer;\n` +
						`  3. the observation missed the refusal — the no-access Alert is plain page copy, so ` +
						`a slow render inside the 4s networkidle window looks identical to no refusal.\n` +
						`  Do NOT drop the route from ROUTE_LEVEL_GATES to make this green: that is exactly ` +
						`how T7 went back to measuring nothing.`,
				).toBe(false);
				return;
			}
			// A blank is never a deliberate state — that is the whole of T7.
			const deliberate = redirectedAway || seen.sharedErrorState || seen.sharedEmpty || seen.length >= 20;
			record({
				route: route.route,
				url,
				predicate: "T7",
				verdict: deliberate ? "PASS" : "FAIL",
				evidence,
			});
			expect(
				deliberate,
				`T7 ${route.route}: the ${PERSONA_ROLE} persona is refused this page and it renders a BLANK ` +
					`(${seen.length} characters in <main>), not a state.`,
			).toBe(true);
		});
	}
});
