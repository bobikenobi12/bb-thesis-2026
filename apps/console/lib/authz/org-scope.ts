// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE URL DECIDES THE TENANT, NOT THE SESSION (#4133).
//
// `app/(private)/[org]/layout.tsx` resolved the URL's `{org}` segment and then threw the answer
// away: every reader below it re-derived its tenant from the session instead. So when the session
// said tenant A and the URL said tenant B, nothing refused — the readers rendered **A's data under
// B's address**, with B's slug in the breadcrumb and B's name in the org switcher. That is what
// turned #4089 from a visible glitch into a silent cross-tenant write: the user had every reason to
// believe they were in B.
//
// WHY THE URL WINS RATHER THAN THE MISMATCH THROWING. A refusal reads like the stricter choice and
// is the weaker one, twice over:
//
//   · It breaks the org switcher. `use-workspace-store.ts` writes the session and then navigates,
//     so a correct switch spends a moment with the session on B and the address bar still on A.
//     A refusal fires there — on the one flow that is behaving exactly as designed.
//   · It leaves the session as a tenancy input. Whatever the guard's shape, `currentActor()` would
//     still be READING `active_organization_id` to decide, and the next reader added would still
//     inherit it. Sourcing the scope from the address means a mis-scoped session is not something
//     to be caught: it is not consulted.
//
// So `currentActor()` prefers this module's answer and falls back to the session only where there
// is no org in the address — `/dashboard`, `/cli/login`, `/api/**`, the MCP token path.
//
// WHAT IS STILL A REFUSAL. A URL that names an org the caller is not a member of yields no id and
// no fallback: it throws. Falling back to the session there would answer a request for someone
// else's tenant with the caller's own data — a wrong answer wearing a 200, which is the shape this
// whole issue is about.

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ORG_PATH_HEADER } from "@/lib/authz/org-path";
import { getServiceDb } from "@/lib/db";
import { member, organization } from "@/lib/db/schema";
import { PERSONAL_ORG_SLUG, RESERVED_SLUGS } from "@/lib/routing";

/**
 * Is this the "called outside a request" error, as opposed to a real failure?
 *
 * Next throws for a `headers()` call with no request context — a script, a unit test, a module
 * evaluated at build time. That is the only condition the null fallback below is written for.
 * Matched on the message because Next exports no error type for it; a message that stops matching
 * turns this into a rethrow, which is the safe direction: a loud failure rather than a silent
 * return to session-derived tenancy.
 *
 * Exported so `tests/unit/org-scope-outside-request.test.ts` can drive it with Next's OWN text,
 * read out of the installed package. An earlier version of that test scraped this regex from the
 * source as a string, which `check-test-imports.mjs` correctly refused: a test that reads a file
 * rather than calling a function asserts what the source SAYS, not what it DOES.
 */
export function isOutsideRequestScope(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /outside a request scope|was called outside a request|headers\(\) .*outside/i.test(message);
}

/** The `{org}` segment of the current request, or null when the address names no org. */
async function urlOrgSlug(): Promise<string | null> {
	let path: string | null = null;
	try {
		path = (await headers()).get(ORG_PATH_HEADER);
	} catch (err) {
		// NARROW ON PURPOSE. `return null` here means "the address names no org", which sends
		// `currentActor()` back to the session — i.e. every failure inside `headers()` would
		// silently restore the exact defect this module removes. That is the inverse of the rule
		// stated two files away (`guard.ts`: "A lookup that FAILS is never reported that way"), so
		// only the one condition the fallback is FOR is swallowed: there is no request to read.
		// Anything else propagates.
		if (!isOutsideRequestScope(err)) throw err;
		return null;
	}
	if (!path) return null;
	const first = path.split("/").filter(Boolean)[0];
	if (!first) return null;
	if (first === PERSONAL_ORG_SLUG) return first;
	// Every non-org first segment is reserved by construction — `RESERVED_SLUGS` is what
	// `pickFreeSlug` refuses to mint, so "not reserved" and "is an org slug" are the same predicate
	// and cannot drift apart the way a second hand-written list of route prefixes would.
	return RESERVED_SLUGS.has(first) ? null : first;
}

/**
 * Resolve the address's `{org}` segment to an org id the caller may actually use.
 *
 * Memoized per render pass with React `cache()`: `currentActor()` is called many times in one
 * request and this must not become a query per call.
 *
 * @returns the org id, or null when the address names no org (→ the caller falls back to the
 *          session). NEVER null for an org segment that resolved to nothing — that throws.
 */
export const urlScopedOrgId = cache(
	async (userId: string): Promise<string | null> => {
		const slug = await urlOrgSlug();
		if (slug === null) return null;
		if (slug === PERSONAL_ORG_SLUG) return userId;

		const [org] = await getServiceDb()
			.select({ id: organization.id })
			.from(organization)
			.innerJoin(
				member,
				and(
					eq(member.organizationId, organization.id),
					eq(member.userId, userId),
				),
			)
			.where(eq(organization.slug, slug))
			.limit(1);

		// NOT a fallback. Answering a request addressed to an org the caller is not in with the
		// caller's OWN tenant is the substitution this issue exists to remove, and it would be
		// invisible: a 200, with the wrong tenant's rows under the requested org's slug. The page
		// tree turns this into the 404 it already renders for an unknown org
		// (`[org]/layout.tsx` → `notFound()`); a reader reached some other way gets an error.
		if (!org) {
			// `notFound()`, NOT a ForbiddenError — and the landing is the whole of the change.
			//
			// The refusal itself was right: answering a request addressed to an org the caller is not
			// in with the caller's OWN tenant is the substitution this issue removes. What was wrong
			// was where it landed. `[org]/layout.tsx` catches only around its own `resolveOrgScope`
			// call, and Next renders layout and page CONCURRENTLY — it does not wait for the layout to
			// settle before invoking the page. So for `/{an-org-i-am-not-in}` both fired: the layout's
			// `notFound()`, and a `ForbiddenError` out of every reader on the page, which escapes the
			// layout entirely. `onRequestError` filters `NEXT_NOT_FOUND`, not `ForbiddenError`, so
			// every stale link, every shared URL and every crawler hit answered 500 and flooded error
			// tracking — the exact behaviour `app/server/actions/resolve.ts` says it was shaped to
			// avoid, on the same condition, one function away.
			//
			// AN `error.tsx` CANNOT DO THIS, which is worth writing down because it is the obvious
			// suggestion. A route-level error boundary is a CLIENT component, and Next replaces a
			// server error's message with a generic string before it crosses that boundary, leaving
			// only `digest`. There is no supported way to ask "was this a ForbiddenError?" there, so
			// the mapping has to happen on the server, at the throw.
			//
			// SAFE HERE SPECIFICALLY, because this branch cannot run outside a page render:
			// `urlOrgSlug()` returns null whenever the address names no org — `/api/**`, `/dashboard`,
			// `/cli/login` and every other `RESERVED_SLUGS` prefix — and `currentActor()` falls back to
			// the session on null without ever reaching this query. A route handler therefore still
			// gets its catchable `ForbiddenError` from `enforce()`; only a `/{org}/` page reaches here.
			//
			// And 404 rather than 403 is the better answer on its own terms: a 403 confirms the slug
			// exists, so a stranger could enumerate org names by reading status codes. The unknown-org
			// and not-a-member cases are now indistinguishable from outside, which is what they should
			// have been.
			notFound();
		}
		return org.id;
	},
);
