// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every URL the header breadcrumb links to must be a route — with ONE stated exclusion, below.
//
// THE DEFECT THIS EXISTS FOR (#3805, R6). The trail mints an `<a href>` for each ancestor segment
// of the current path — it assumes a path PREFIX of a route is itself a route. For
// `/[org]/~/support/cases/[id]` that is false: `app/(private)/[org]/~/support/cases/` holds `[id]/`
// and no `page.tsx`, so the "Cases" crumb pointed at a 404. Next's `<Link>` prefetches the RSC
// payload for every link it can see, a FAILED prefetch is not cached, and so every re-entry into
// the viewport asked again — `404 GET /<org>/~/support/cases?_rsc=…` seventy times in one visit of
// the audit. The count was the retry, not seventy links.
//
// WHY A SWEEP AND NOT AN ASSERTION ABOUT THAT ONE CRUMB. Nothing in the breadcrumb's source says
// which of the URLs it mints exist; only the ROUTE SET does. A test naming `support/cases` would
// pass forever and say nothing about the next directory-only segment somebody adds. So the
// denominator comes from `scripts/lib/console-routes.mjs` — the ONE definition of the console's
// private route set (#3636), shelled out to rather than re-walked, exactly as
// `e2e/audit/manifest.ts` does and for the same reason: the seam RAISES on a broken scan, and
// `execFileSync` turns that raise into a throw instead of an empty sweep reporting green over
// nothing.
//
// The second test is the reason to believe the first. A sweep that has never been seen to fail is
// indistinguishable from one that cannot: it removes the redirect that fixes the defect and
// requires the sweep to find it again, naming the exact URL.
//
// WHAT THIS SWEEP DOES NOT COVER, said here so a clean result is not read as covering it: the
// legacy `/dashboard/*` branch of `buildCrumbs`. `concretePath` drops an optional catch-all, so the
// only dashboard pathname visited is `/dashboard`, and `buildCrumbs("/dashboard")` returns `[]`;
// and `/dashboard/[[...rest]]`'s matcher compiles to `^/dashboard(?:/[^?#]+)?/?$`, which matches
// every `/dashboard/*` URL, so no href minted in that branch could be expressible as dead even if
// one were. The branch is unreachable — its page is a server `redirect()`, so the topbar never
// renders on such a pathname — and `breadcrumb-trail.ts`'s own header carries the same note beside
// the code. Two documents agreeing is the only thing that keeps that exclusion visible.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ANCESTOR_REDIRECTS,
	buildCrumbs,
} from "@/components/shell/breadcrumb-trail";

/** A route parameter as the seam reports it. */
interface SeamParam {
	segment: string;
	name: string;
	catchAll: boolean;
	optional: boolean;
}

/** Only the fields this sweep reads. */
interface SeamRoute {
	route: string;
	params: SeamParam[];
}

/** Structural check on one param record — narrowed, never cast. */
function isSeamParam(value: unknown): value is SeamParam {
	return (
		typeof value === "object" &&
		value !== null &&
		"segment" in value &&
		typeof value.segment === "string" &&
		"name" in value &&
		typeof value.name === "string" &&
		"catchAll" in value &&
		typeof value.catchAll === "boolean" &&
		"optional" in value &&
		typeof value.optional === "boolean"
	);
}

/** Structural check on one route record — the fields this sweep reads, and nothing more. */
function isSeamRoute(value: unknown): value is SeamRoute {
	return (
		typeof value === "object" &&
		value !== null &&
		"route" in value &&
		typeof value.route === "string" &&
		"params" in value &&
		Array.isArray(value.params) &&
		value.params.every(isSeamParam)
	);
}

/**
 * The seam's `RECORD_VERSION` this sweep was written against.
 *
 * Held as a local constant compared against the manifest's emitted `version`, exactly as
 * `e2e/audit/manifest.ts` pins it — the seam is ESM and importing it here to read one number would
 * couple a vitest suite to the module resolution of a script it otherwise only ever executes. The
 * seam exports the constant "so a consumer that pins a version cannot silently read a field that
 * now means something else", and every field this file reads is exactly that kind of field: a
 * `params[].segment` that stopped carrying the bracketed literal would make the whole sweep walk
 * route PATTERNS and report them clean. A bump must be read, not absorbed.
 */
const EXPECTED_RECORD_VERSION = 1;

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
);

/**
 * Every private console route, straight from the seam.
 *
 * Raises rather than returning an empty list: a sweep with no denominator must not be allowed to
 * look like a sweep that found nothing wrong.
 */
function consoleRoutes(): SeamRoute[] {
	const seam = path.join(REPO_ROOT, "scripts", "lib", "console-routes.mjs");
	const raw = execFileSync(process.execPath, [seam, "--json"], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	const parsed: unknown = JSON.parse(raw);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("routes" in parsed) ||
		!Array.isArray(parsed.routes)
	) {
		throw new Error(`${seam} did not produce a route manifest`);
	}
	if (!("version" in parsed) || parsed.version !== EXPECTED_RECORD_VERSION) {
		throw new Error(
			`${seam} emits record version ${JSON.stringify(
				"version" in parsed ? parsed.version : undefined,
			)}; this sweep reads version ${EXPECTED_RECORD_VERSION}. Re-read the record shape — ` +
				`a field that changed meaning is exactly what this pin exists to stop being absorbed.`,
		);
	}
	const routes: SeamRoute[] = [];
	for (const r of parsed.routes) {
		if (!isSeamRoute(r)) {
			throw new Error(
				`${seam} produced a record this sweep cannot read: ${JSON.stringify(r)}`,
			);
		}
		routes.push({ route: r.route, params: r.params });
	}
	if (routes.length === 0) throw new Error(`${seam} reported zero routes`);
	return routes;
}

/** A v4-shaped id, the console's id shape in a URL. */
const ID = "3f2b1a90-7c4d-4e8f-9a1b-2c3d4e5f6a7b";

/** A non-id dynamic segment — the shape a slug route has in production. */
const SLUG = "a-slug";

/**
 * How an unnamed dynamic segment is filled in.
 *
 * NOT a cosmetic choice: `buildCrumbs` branches on `isIdSegment(s)`, which decides between the
 * branch that MINTS an href and the branch that pushes a label with none. A sweep that only ever
 * fills UUIDs therefore exercises the opposite branch from the app on every route whose dynamic
 * segment is a slug in production, and a dead ancestor href under such a route is structurally
 * invisible to it. Every route is swept once per fill for that reason.
 */
type Fill = "id" | "slug";

/** How each NAMED dynamic segment is filled in. These are slugs in production either way. */
const PARAM_VALUES: Record<string, string> = { org: "acme", project: "web" };

/**
 * The route's URL segments paired with the param record each dynamic one resolves to.
 *
 * RAISES on a `[`-prefixed segment that resolves to no param, and that raise is the point.
 * Everything downstream assumes `params[].segment` is the bracketed literal (`"[org]"`), which
 * `isSeamRoute` cannot check — it only asserts the field is a string. If the seam ever reported
 * the bare param name instead, `concretePath` and `routeMatcher` would degrade IN LOCKSTEP:
 * `concretePath` would hand back the raw pattern `/[org]/~/support/cases/[id]`, and `routeMatcher`
 * would escape `[org]` into a literal that matches it. Every assertion in this file — the
 * denominator, the verdict and the negative control — would pass while the sweep visited not one
 * concrete URL. So both callers walk the route through here, and the check lives once rather than
 * twice, because two copies of it are two chances for them to stop agreeing.
 */
function routeSegments(
	r: SeamRoute,
): { seg: string; param: SeamParam | undefined }[] {
	const bySegment = new Map(r.params.map((p) => [p.segment, p]));
	return r.route
		.split("/")
		.filter(Boolean)
		.map((seg) => {
			const param = bySegment.get(seg);
			if (!param && seg.startsWith("[")) {
				throw new Error(
					`${r.route}: dynamic segment ${seg} matches no param record — the seam's ` +
						`params[].segment no longer carries the bracketed literal, so this sweep ` +
						`would walk route PATTERNS and report them clean`,
				);
			}
			return { seg, param };
		});
}

/** A concrete pathname for a route pattern, with dynamic segments filled in. */
function concretePath(r: SeamRoute, fill: Fill): string {
	const out: string[] = [];
	for (const { seg, param } of routeSegments(r)) {
		if (!param) {
			out.push(seg);
			continue;
		}
		// An OPTIONAL catch-all matches the bare parent too, and that is the shape the console
		// actually links to (`/dashboard`), so it is the one worth sweeping.
		if (param.catchAll && param.optional) continue;
		if (param.catchAll) out.push("a", "b");
		else out.push(PARAM_VALUES[param.name] ?? (fill === "id" ? ID : SLUG));
	}
	return `/${out.join("/")}`;
}

/** A route pattern as a matcher over concrete pathnames. */
function routeMatcher(r: SeamRoute): RegExp {
	let src = "^";
	for (const { seg, param } of routeSegments(r)) {
		if (!param) {
			src += `/${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
		} else if (param.catchAll && param.optional) {
			src += "(?:/[^?#]+)?";
		} else if (param.catchAll) {
			src += "/[^?#]+";
		} else {
			src += "/[^/?#]+";
		}
	}
	return new RegExp(`${src}/?$`);
}

interface MintedHref {
	route: string;
	fill: Fill;
	pathname: string;
	label: string;
	href: string;
}

/** Both fills, so each route is visited on both sides of `buildCrumbs`'s id/non-id branch. */
const FILLS: Fill[] = ["id", "slug"];

/** Every href the trail mints across every route and BOTH fills, and whether each resolves. */
function sweep(routes: SeamRoute[]): {
	minted: MintedHref[];
	dead: MintedHref[];
} {
	const matchers = routes.map(routeMatcher);
	const minted: MintedHref[] = [];
	const dead: MintedHref[] = [];
	for (const r of routes) {
		for (const fill of FILLS) {
			const pathname = concretePath(r, fill);
			for (const crumb of buildCrumbs(pathname)) {
				const { href } = crumb;
				if (!href) continue;
				const record = {
					route: r.route,
					fill,
					pathname,
					label: crumb.label,
					href,
				};
				minted.push(record);
				if (!matchers.some((m) => m.test(href))) dead.push(record);
			}
		}
	}
	return { minted, dead };
}

describe("header breadcrumb hrefs", () => {
	const routes = consoleRoutes();

	it("mints an ancestor link on the routes that have ancestors, under BOTH fills", () => {
		// The denominator, asserted BEFORE the verdict that rests on it. A sweep that collected no
		// hrefs would otherwise report the same clean result as a sweep that collected them all —
		// and `/[org]/~/support/cases/[id]` is named specifically because it is the route the
		// finding was measured on: if the trail ever stops linking its parent, this sweep stops
		// being able to see the defect it was written for, and should say so here rather than
		// by going quietly green.
		const { minted } = sweep(routes);
		expect(minted.length).toBeGreaterThan(0);

		// Asserted PER FILL rather than over the union, because the union cannot tell "both sides
		// of the id/non-id branch were walked" from "the UUID side was walked twice". The id fill
		// reaching this route is what pins `isIdSegment` as exercised on purpose; the slug fill
		// reaching it is what proves the second pass is not silently collapsing onto the first.
		for (const fill of FILLS) {
			const forFill = minted.filter((m) => m.fill === fill);
			expect(forFill.length).toBeGreaterThan(0);
			expect(forFill.map((m) => m.route)).toContain(
				"/[org]/~/support/cases/[id]",
			);
		}

		// And the two passes really do visit different URLs for that route — otherwise `Fill` is
		// a parameter the sweep threads through and never applies.
		const casePaths = new Set(
			minted
				.filter((m) => m.route === "/[org]/~/support/cases/[id]")
				.map((m) => m.pathname),
		);
		expect(casePaths.size).toBe(2);
	});

	it("links only to URLs that are routes", () => {
		const { dead } = sweep(routes);
		expect(
			dead.map((d) => `${d.route} [${d.fill}]: "${d.label}" -> ${d.href}`),
		).toStrictEqual([]);
	});

	it("would catch the defect it was written for", () => {
		// Not a restatement of the fix: it removes the fix and requires the sweep to fail, with the
		// URL the CI artifact reported. Without this, "no dead hrefs" and "cannot detect a dead
		// href" are the same green.
		const saved = { ...ANCESTOR_REDIRECTS };
		for (const key of Object.keys(ANCESTOR_REDIRECTS))
			delete ANCESTOR_REDIRECTS[key];
		try {
			const { dead } = sweep(routes);
			// The UNIQUE set, because both fills now walk `/[org]/~/support/cases/[id]` and both
			// mint the same ancestor — the dead URL does not contain the segment the fills vary.
			// Deduplicating is what keeps this an assertion about WHICH url is dead rather than
			// about how many times the sweep passes over it; the count is pinned by the
			// denominator test above instead, where it means something.
			expect([...new Set(dead.map((d) => d.href))]).toStrictEqual([
				"/acme/~/support/cases",
			]);
			// Both fills reached it, so the control is not proving the id pass alone can see the
			// defect while the slug pass silently mints nothing.
			expect(new Set(dead.map((d) => d.fill))).toStrictEqual(
				new Set<Fill>(["id", "slug"]),
			);
		} finally {
			Object.assign(ANCESTOR_REDIRECTS, saved);
		}
	});
});
