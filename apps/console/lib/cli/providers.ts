// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { isEnumMember } from "@/lib/coerce";
import { verifyCliToken } from "@/lib/cli/auth";
import { getActiveScope } from "@/lib/auth/scope";
import { getPdp } from "@/lib/authz";
import type { Action, Resource } from "@/lib/authz/registry";
import { ensureCliOrgAccess } from "@/lib/authz/guard";
import { type Actor, ForbiddenError } from "@/lib/authz/types";
import type { CloudProvider } from "@/lib/cloud-providers/connections";
import { NextResponse } from "next/server";

/**
 * The clouds the CLI's `/api/cli/providers/[provider]/*` routes serve.
 *
 * This list — not the routes themselves — was why `alethia connector hetzner` did not exist. The
 * `/connect` route has always handled the token clouds (`case "digitalocean": case "hetzner":
 * case "civo":` → `conn.saveTokenCloudIdentity`), and `initIdentity` is provider-generic. But
 * `resolveCliProvider` rejected anything outside these four with a 400, so `/init`, `/connect`,
 * `/status`, `/verify` and `/disconnect` all refused hetzner while the code below them was ready.
 *
 * Hetzner matters disproportionately here: it is the cheapest cloud to demo on and its connector is
 * the simplest in the tree — paste a token, no Cloud Shell, no cloud CLI, no Terraform module. It was
 * the one cloud you had to leave the terminal for.
 *
 * The real authority on what a token cloud is remains `TOKEN_CLOUDS` in
 * lib/cloud-providers/connections.ts; this list only says which the CLI surface exposes.
 */
const PROVIDERS: readonly CloudProvider[] = [
	"aws",
	"gcp",
	"azure",
	"alibaba",
	"hetzner",
	"digitalocean",
	"civo",
];

export function isCloudProvider(value: string): value is CloudProvider {
	return isEnumMember(value, PROVIDERS);
}

type Resolved =
	| {
			userId: string;
			scope: Actor;
			provider: CloudProvider;
			errorResponse: null;
	  }
	| { userId: null; scope: null; provider: null; errorResponse: Response };

/** 403, in the one shape `authorizeCli` answers with. */
function forbidden(): Response {
	return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
}

/**
 * Verifies the CLI bearer token and validates the `[provider]` route segment.
 * Returns the user id, the actor's org-scope (cloud connections are org-scoped),
 * and the typed provider, or a ready-to-return error response.
 *
 * `scope` is a full `Actor`, not the narrower `ConnScope`, because it is now also the
 * subject of the permission decision — see `enforceProviderPermission`. It stays
 * assignable to `ConnScope`, so the `conn.*` call sites are unchanged.
 */
export async function resolveCliProvider(
	req: Request,
	params: Promise<{ provider: string }>,
): Promise<Resolved> {
	const { payload, error } = await verifyCliToken(req);
	if (error) {
		return { userId: null, scope: null, provider: null, errorResponse: error };
	}

	const userId = payload?.sub;
	if (!userId) {
		return {
			userId: null,
			scope: null,
			provider: null,
			errorResponse: NextResponse.json(
				{ error: "Invalid token payload" },
				{ status: 401 },
			),
		};
	}

	const { provider } = await params;
	if (!isCloudProvider(provider)) {
		return {
			userId: null,
			scope: null,
			provider: null,
			errorResponse: NextResponse.json(
				{ error: `Unsupported provider: ${provider}` },
				{ status: 400 },
			),
		};
	}

	// ── WHICH ORG THIS CALL IS SCOPED TO ──
	//
	// These five routes are the only `/api/cli/*` surface that RESOLVES ITS OWN ORG SCOPE without
	// going through `authorizeCli`, so the header handling that guard owns has to be mirrored here
	// rather than inherited. Getting this wrong is not a 500: it is the right answer computed about
	// the wrong tenant.
	//
	// "Resolves its own scope" is the load-bearing half of that sentence, not "does not go through
	// `authorizeCli`". Three more routes bypass the guard — `api/cli/repositories/{github,gitlab,
	// bitbucket}/route.ts` each call `verifyCliToken` directly and then read `X-Provider-Token` —
	// and they are correctly exempt because they resolve NO scope at all: they list what the
	// caller's git account can see, which is not an org-scoped question, so there is nothing here
	// for them to mirror. Stated because the shorter claim reads as a complete enumeration, and an
	// auditor asking "which routes must mirror this membership check" would close the surface three
	// routes early.
	//
	// A SERVICE TOKEN SCOPES TO ITS OWN ORG, not the creator's default one, and it WINS.
	// `getActiveScope(userId)` with no org resolves whichever org that PERSON last had active —
	// which for a machine credential is somebody else's session state, and is not the org the token
	// was issued for. A CONFLICTING header is refused with a 403 rather than ignored, and
	// `verifyCliToken` already does that at the chokepoint (lib/cli/auth.ts), so by the time we are
	// here a service token's header either matched or never arrived. Re-deriving that refusal a
	// second time would be a second thing to keep in step, not a second layer of safety.
	const pinnedOrg =
		typeof payload?.service_token_org_id === "string" && payload.service_token_org_id
			? payload.service_token_org_id
			: undefined;
	if (pinnedOrg) {
		// THE MINTING PROFILE'S MEMBERSHIP IS RE-CHECKED ON EVERY REQUEST, and until #4041 it was
		// not — this branch resolved the pinned scope and returned. `authorizeCli` has always done
		// the re-check (guard.ts, the `service_token_org_id` branch) and says why: a token acts as
		// the profile that created it, so it must stop working the moment that profile stops being
		// a member. These five provider routes deliberately bypass `authorizeCli`, so they
		// inherited none of it — and they are the routes that CREATE AND RESET CLOUD IDENTITIES.
		//
		// The case is offboarding, which is the one a service token most needs to get right: a
		// token is dropped into CI, its author leaves, nobody revokes it because revoking tokens is
		// not part of removing a person. Reachable with NO header at all, from every scripted
		// `connector` call in existence.
		//
		// THE ACTOR PASSED IN IS THE DEFAULT SCOPE, NOT THE PINNED ONE, and that is the whole
		// correctness of it — the same reasoning the header branch below states at length.
		// `ensureCliOrgAccess` opens with `if (actor.orgId === orgId) return null`, a fast path
		// sound only when `actor` was resolved from something the caller did not supply. Hand it a
		// scope resolved FROM `pinnedOrg` and it compares the pin to itself, returns null, and the
		// membership query never runs: the check would trust exactly the input it exists to verify.
		//
		// That fast path cannot mask an offboarded caller here. `getActiveScope(userId)` with no
		// org resolves the caller's earliest REMAINING membership, else their personal org
		// (ee/src/scope.ts, case 3) — never an org they have been removed from. So a departed
		// member's default can never equal the pin, the query always runs for them, and the answer
		// is a 403. A still-member whose default happens to BE the pin takes the fast path, which
		// is the correct answer by a cheaper route.
		//
		// Absence is not error: `resolveActiveScope` lets a failed lookup propagate rather than
		// reporting it as a missing membership, so a database blip surfaces as a 500 and never as
		// a silent refusal or a silent fallback.
		const defaultScope = await getActiveScope(userId);
		const denied = await ensureCliOrgAccess(defaultScope, userId, pinnedOrg);
		if (denied) {
			return { userId: null, scope: null, provider: null, errorResponse: denied };
		}
		return { userId, scope: await getActiveScope(userId, pinnedOrg), provider, errorResponse: null };
	}

	// An interactive session picks its org with `X-Alethia-Org` — the CLI's `--org` flag. It is safe
	// only because a human's MEMBERSHIPS bound it, so it is honoured strictly after that check and
	// refused with a 403 otherwise. The check is the guard's own exported `ensureCliOrgAccess` and
	// NOT a second copy of the membership query on purpose: a copy would have to be corrected twice,
	// and #3863 is currently correcting exactly that predicate.
	const headerOrg = req.headers.get("X-Alethia-Org")?.trim() || undefined;
	// THE DEFAULT SCOPE IS RESOLVED FIRST AND THAT SECOND RESOLUTION BELOW IS NOT REDUNDANT.
	//
	// It looks like one: with a header we resolve a scope here and again three lines down, and the
	// obvious tightening is to resolve once WITH the header and hand that to `ensureCliOrgAccess`.
	// That would be a hole. Its first line is `if (actor.orgId === orgId) return null` — a fast path
	// that is sound only because `actor` is the caller's DEFAULT scope, resolved from a value they
	// did not supply. Pass it a scope resolved FROM the header and the check compares the header to
	// itself, returns null, and the membership query never runs: the guard would trust exactly the
	// input it exists to verify. That is the shape of #3863, one rung lower.
	//
	// Calling `isOrgMember` directly instead would skip the extra resolution honestly, but it puts a
	// second copy of the membership predicate in the tree while #3863 is correcting the first.
	const defaultScope = await getActiveScope(userId);
	if (!headerOrg) {
		return { userId, scope: defaultScope, provider, errorResponse: null };
	}
	const denied = await ensureCliOrgAccess(defaultScope, userId, headerOrg);
	if (denied) {
		return { userId: null, scope: null, provider: null, errorResponse: denied };
	}
	return { userId, scope: await getActiveScope(userId, headerOrg), provider, errorResponse: null };
}

/**
 * Enforces `action` on `resource` for the actor `resolveCliProvider` already resolved.
 *
 * WHY NOT `authorizeUserId`, which these routes used to call: it resolves the DEFAULT scope
 * (`getActiveScope(userId)`, no org). That was harmless while the provider routes had no way to
 * name another org — the decision and the write were about the same tenant by construction. Once
 * `--org` moves the write, a decision taken in the default org is a decision about the WRONG one:
 * `PostgresRbacPDP` filters grants by `g.org_id = actor.orgId`, so an owner of org A who is only a
 * viewer in org B would pass `manage_identities` on the strength of A and then write into B.
 *
 * Passing the resolved actor makes the subject of the decision and the target of the write the same
 * object, so they cannot drift apart again.
 */
export async function enforceProviderPermission(
	actor: Actor,
	action: Action,
	resource: { type: Resource; id?: string },
): Promise<Response | null> {
	try {
		await getPdp().enforce(actor, action, { type: resource.type, id: resource.id });
	} catch (e) {
		if (e instanceof ForbiddenError) return forbidden();
		throw e;
	}
	return null;
}

/** Maps a thrown error to a JSON error response with the given status. */
export function errorResponse(err: unknown, status = 400): NextResponse {
	const message = err instanceof Error ? err.message : "Internal Server Error";
	return NextResponse.json({ error: message }, { status });
}
