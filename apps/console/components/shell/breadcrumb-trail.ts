// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The header breadcrumb's TRAIL, split out of `components/header-breadcrumbs.tsx` as a pure
// function so it can be driven without rendering React.
//
// WHY IT IS SPLIT. The trail mints an `<a href>` for every ancestor segment of the current path, on
// the assumption that a path prefix of a route is itself a route. That assumption is false, and
// where it is false Next's `<Link>` prefetches an RSC payload for a URL that 404s — which is #3805's
// R6 finding: `404 GET /<org>/~/support/cases?_rsc=…`, seventy times in one visit of
// `/[org]/~/support/cases/[id]`. A failed prefetch is not cached, so every re-entry into the
// viewport asks again; the count is the retry, not seventy links.
//
// The remedy is a guard, not a one-line patch, because nothing in the source of a breadcrumb says
// which of the URLs it mints exist. Only the ROUTE SET does. As a pure `(pathname) => Crumb[]` the
// trail can be swept against `scripts/lib/console-routes.mjs` — the one definition of the console's
// private route set (#3636) — so the next ancestor segment that stops being a route fails a test
// instead of silently costing a prefetch storm. See
// `tests/components/breadcrumb-trail-hrefs.test.ts`.
//
// THE LEGACY `/dashboard/*` BRANCH AT THE BOTTOM IS OUTSIDE THAT SWEEP, DELIBERATELY, and saying
// so here is the point — otherwise "0 dead of N minted" reads as covering it. It is unreachable:
// `app/(private)/dashboard/[[...rest]]/page.tsx` is a server `redirect()` that canonicalizes to
// `/{org}/~/…`, so the topbar never renders on a `/dashboard/*` pathname. It is ALSO unmeasurable,
// in two independent ways: the sweep drops an optional catch-all, so the only dashboard pathname it
// visits is `/dashboard`, and `buildCrumbs("/dashboard")` returns `[]`; and even if it were
// visited, `/dashboard/[[...rest]]` compiles to a matcher that matches EVERY `/dashboard/*` URL, so
// no href minted there is expressible as dead. The branch does not consult `ANCESTOR_REDIRECTS`
// either, so it would re-acquire this very defect if it were reachable — which is a reason to
// delete it when the redirect page goes, not a reason to change behaviour a guard cannot see.
//
// Deliberately free of React and of every `@/` import: `jobLabel` is injected rather than reaching
// for `JOB_TYPES` and `useJobsQuery`, so the module a guard imports is the module the console
// renders, with nothing mocked in between.

/** One entry in the header trail. `href` absent means it is not a link. */
export interface Crumb {
	label: string;
	href?: string;
}

/** Resolves a job UUID to its display label, or `undefined` when the job is not loaded. */
export type JobLabelResolver = (id: string) => string | undefined;

const SEGMENT_LABELS: Record<string, string> = {
	new: "New project",
	clusters: "Clusters",
	jobs: "Jobs",
	connectors: "Connectors",
	alerts: "Alerts",
	runners: "Runners",
	settings: "Settings",
	general: "General",
	members: "Members",
	teams: "Teams",
	roles: "Roles",
	access: "Access",
	sso: "Single Sign-On",
	activity: "Activity",
	billing: "Billing",
	usage: "Usage",
	agent: "Agent",
	// The support shell, added with #3733. Every other segment here was mapped because the
	// fallback (`seg[0].toUpperCase() + seg.slice(1)`) does not read as a page name — and these
	// six were the ones where that mattered least until the console stopped painting page titles.
	// Now the crumb is the ONLY thing naming these routes, and the fallback prints `My-cases`,
	// hyphen and all, where the deleted heading said "My cases". Neither support route has a
	// sidebar entry either: both are reached from the support hub.
	support: "Support",
	"my-cases": "My cases",
	cases: "Cases",
	abuse: "Report abuse",
	submit: "Submit a case",
	ask: "Ask",
};

/**
 * Ancestor trails that are NOT routes, and where the crumb should point instead.
 *
 * Keyed on the trail BELOW the branch root — everything after `/{org}/~/` for an org-global page,
 * everything after `/{org}/{project}/` for a project page — and applied to both, so a project
 * route that later acquires a directory-only segment is covered by the same mechanism rather than
 * re-acquiring the defect in the branch nobody edited. The two key spaces overlap only if the same
 * trail exists under both roots AND wants a different destination; nothing does today, and the
 * sweep in `tests/components/breadcrumb-trail-hrefs.test.ts` is what would say so.
 *
 * THE TARGET IS A `trail`, NOT AN `href`, AND THE NAME IS LOAD-BEARING. It is relative to whichever
 * branch root the crumb hangs off — `ancestorCrumb` concatenates it as `` `${base}${trail}` `` —
 * so `"support/my-cases"` is the whole value and a LEADING SLASH would be wrong. This used to be
 * typed `Crumb & { href: string }`, reusing the field whose documented meaning four lines up is the
 * absolute path handed to `<Link href>`; the two readings agreed only because today's single entry
 * happens to be rootless. Written the way that type reads, the next entry would silently mint
 * `/acme/web//acme/~/settings` and link it — and no test would name the cause, because the sweep
 * would report a dead URL nobody would connect to a type mismatch.
 *
 * IT IS ALSO WHY THE "APPLIED TO BOTH KEY SPACES" NOTE ABOVE IS NARROWER THAN IT READS: because the
 * target resolves against the CALLER's base, a directory-only segment in the project tree whose
 * real list lives at an org-global URL cannot be expressed by this map at all. That is a real
 * limit, not an oversight — the day something needs it, the value has to grow a root, and this
 * comment is the warning that it cannot simply be written with a slash in front.
 *
 * The LABEL moves with the target on purpose. A crumb reading "Cases" that navigates to a page
 * whose own crumb reads "My cases" is a second, quieter defect — and `cases/[id]/not-found.tsx`
 * already decided, in this tree, that the way back from a case is "My cases".
 */
export const ANCESTOR_REDIRECTS: Record<
	string,
	{ label: string; trail: string }
> = {
	// `app/(private)/[org]/~/support/cases/` holds `[id]/` and nothing else — there is no
	// `page.tsx`, so `/{org}/~/support/cases` is a 404 and the case list lives at `my-cases`.
	"support/cases": { trail: "support/my-cases", label: "My cases" },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `seg` is a v4-shaped UUID — the console's id shape in a URL. */
function isIdSegment(seg: string): boolean {
	return UUID_RE.test(seg);
}

/** A nice label for a URL segment: the map first, else a capitalized fallback. */
function segmentLabel(seg: string): string {
	return SEGMENT_LABELS[seg] ?? seg.charAt(0).toUpperCase() + seg.slice(1);
}

/**
 * One non-leaf crumb: the label and href for `rest[0..j]`, after any ancestor redirect.
 *
 * @param base   the branch root the trail hangs off, with a trailing slash (`/acme/~/`)
 * @param rest   the segments below that root
 * @param j      index of the segment being resolved
 */
function ancestorCrumb(base: string, rest: string[], j: number): Crumb {
	const trail = rest.slice(0, j + 1).join("/");
	const redirect = ANCESTOR_REDIRECTS[trail];
	if (redirect) return { label: redirect.label, href: `${base}${redirect.trail}` };
	return { label: segmentLabel(rest[j]), href: `${base}${trail}` };
}

/**
 * The header trail for `pathname`.
 *
 * @param pathname  the current URL path
 * @param jobLabel  resolves a job UUID to its type label; ids it cannot resolve fall back to a
 *                  truncated form, exactly as the header did before the split
 */
export function buildCrumbs(
	pathname: string,
	jobLabel: JobLabelResolver = () => undefined,
): Crumb[] {
	// C2 slug drilldown `/{org}/{project}/{env}` — resolve the project name from the
	// store (the OrgSwitcher already shows the org, so the trail starts at the project).
	const segs = pathname.split("/").filter(Boolean);
	if (segs.length >= 1 && segs[0] !== "dashboard") {
		const [orgSeg, second] = segs;

		// Bare org overview `/{org}` — the trail is just the current page.
		if (segs.length === 1) return [{ label: "Overview" }];

		// `/{org}/~/{page}[/…]` — an org-global page. Label from SEGMENT_LABELS
		// (jobs/runners/settings/general/…), resolving job UUIDs by type.
		if (second === "~") {
			const rest = segs.slice(2);
			const base = `/${orgSeg}/~/`;
			const out: Crumb[] = [];
			for (let j = 0; j < rest.length; j++) {
				const s = rest[j];
				const isLast = j === rest.length - 1;
				if (!isIdSegment(s)) {
					out.push(
						isLast ? { label: segmentLabel(s) } : ancestorCrumb(base, rest, j),
					);
				} else if (rest[j - 1] === "jobs") {
					out.push({ label: jobLabel(s) ?? `${s.slice(0, 8)}…` });
				} else {
					out.push({ label: s });
				}
			}
			return out;
		}

		// `/{org}/{project}` — the canvas IS the project's Overview (the project name is
		// already shown in the Project switcher). Deeper `/{org}/{project}/{sub}...` pages
		// show only the sub-page labels — the project name is not repeated here. (Env now
		// lives in `?environment_id=`, not a path segment, so there's no env crumb.)
		const [, projectSlug, ...rest] = segs;
		if (rest.length === 0) return [{ label: "Overview" }];
		const base = `/${orgSeg}/${projectSlug}/`;
		const out: Crumb[] = [];
		for (let j = 0; j < rest.length; j++) {
			const isLast = j === rest.length - 1;
			out.push(
				isLast ? { label: segmentLabel(rest[j]) } : ancestorCrumb(base, rest, j),
			);
		}
		return out;
	}

	const raw = pathname
		.replace(/^\/dashboard\/?/, "")
		.split("/")
		.filter(Boolean);
	if (raw.length === 0) return [];

	const result: Crumb[] = [];
	let i = 0;

	while (i < raw.length) {
		const seg = raw[i];

		if (SEGMENT_LABELS[seg]) {
			const isLast = i === raw.length - 1;
			result.push({
				label: SEGMENT_LABELS[seg],
				href: isLast ? undefined : `/dashboard/${raw.slice(0, i + 1).join("/")}`,
			});
			i++;
			continue;
		}

		if (isIdSegment(seg) && raw[i - 1] === "jobs") {
			result.push({ label: jobLabel(seg) ?? `${seg.slice(0, 8)}…` });
			i++;
			continue;
		}

		result.push({ label: seg });
		i++;
	}

	return result;
}
