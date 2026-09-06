// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Marketing path-list drift guard. apps/console/microfrontends.json is the single source
// of truth for the paths the marketing zone owns. RESERVED_SLUGS (lib/routing.ts) is
// DERIVED from it (lib/marketing-zone.ts), so the org-slug reservation can never drift —
// no check needed there. This guard keeps the other two encodings honest:
//   1. every marketing app/ route is registered in microfrontends.json (so a new page
//      can't ship unrouted / unreserved), and
//   2. the Caddy mirror's @marketing path list matches marketing-zones.json.
// Plus a cheap asset-prefix consistency check across the three. Run from apps/console
// (the `check:marketing-routes` script): cwd is apps/console.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";

const MF_PATH = "marketing-zones.json";
const MARKETING_APP = "../marketing/app";
const CADDY_FILES = [
	"../../deploy/caddy/marketing.caddy.example",
	"../../deploy/caddy/Caddyfile.dev",
	"../../deploy/prod/Caddyfile.tunnel",
];
const MARKETING_NEXT_CONFIG = "../marketing/next.config.ts";
const REPO_ROOT = "../..";

const failures = [];

// ── Source of truth: microfrontends.json ────────────────────────────────────────────
const mf = JSON.parse(readFileSync(MF_PATH, "utf8"));
const marketing = mf.applications?.marketing;
if (!marketing?.routing) {
	console.error(`✗ ${MF_PATH}: applications.marketing.routing is missing.`);
	process.exit(1);
}
const assetPrefix = marketing.assetPrefix; // e.g. "mkt-assets"
const mfPaths = marketing.routing.flatMap((r) => r.paths);

/** Canonicalize a path so the microfrontends `:path*` syntax and Caddy `*` compare equal. */
const canon = (p) => p.replace(/\/:[A-Za-z]+[*+]?/g, "/*");
const mfCanon = new Set(mfPaths.map(canon));
/** First URL segment of a path ("/contact/:path*" → "contact", "/" → ""). */
const firstSeg = (p) => p.replace(/^\//, "").split("/")[0];
const mfSegments = new Set(mfPaths.map(firstSeg));

// ── Check 1: every marketing app/ route is registered in microfrontends.json ─────────
/** Does this route subtree produce a page/route handler? */
function hasRoute(dir) {
	for (const e of readdirSync(dir)) {
		const full = join(dir, e);
		if (statSync(full).isDirectory()) {
			if (hasRoute(full)) return true;
		} else if (/^(page|route)\.(tsx?|jsx?)$/.test(e)) {
			return true;
		}
	}
	return false;
}
/** Top-level URL segments served by the marketing app (route groups `(x)` / slots `@x`
 * are transparent; `_private` and dotfiles are skipped; bare app/page.tsx → ""). */
function collectSegments(dir, includeMetadata = false) {
	const segs = new Set();
	const metadataRoute =
		/^(icon|apple-icon|opengraph-image|twitter-image|manifest|sitemap|robots|favicon)\.(?:tsx?|jsx?|ico|png|jpe?g|svg|json|webmanifest|txt|xml)$/;
	for (const e of readdirSync(dir)) {
		const full = join(dir, e);
		if (statSync(full).isDirectory()) {
			if (/^[_.]/.test(e)) continue;
			if (/^\(.*\)$/.test(e) || e.startsWith("@")) {
				for (const s of collectSegments(full, includeMetadata)) segs.add(s);
			} else if (hasRoute(full)) {
				segs.add(e);
			}
		} else if (/^page\.(tsx?|jsx?)$/.test(e)) {
			segs.add("");
		} else if (includeMetadata && metadataRoute.test(e)) {
			// Metadata convention files are URL-producing routes even without page/route handlers.
			// They are checked here only when directly encountered in an app root (or route group),
			// matching the top-level segment collection used by the shadowing guard.
			segs.add(
				e.replace(/\.(?:tsx?|jsx?|ico|png|jpe?g|svg|json|webmanifest|txt|xml)$/, ""),
			);
		}
	}
	return segs;
}
if (existsSync(MARKETING_APP)) {
	for (const seg of collectSegments(MARKETING_APP)) {
		if (!mfSegments.has(seg)) {
			failures.push(
				`Marketing route "/${seg}" (apps/marketing/app/${seg}) is not registered in ${MF_PATH}.\n` +
					`    → add "/${seg}" to applications.marketing.routing[].paths (and the Caddy mirror).`,
			);
		}
	}
} else {
	failures.push(`Marketing app dir not found at ${MARKETING_APP}.`);
}

// ── Check 2: the Caddy mirror's @marketing path list matches microfrontends.json ──────
for (const caddyPath of CADDY_FILES) {
	if (!existsSync(caddyPath)) {
		failures.push(`Caddy mirror not found at ${caddyPath}.`);
		continue;
	}
	const caddy = readFileSync(caddyPath, "utf8");
	const line = caddy.split("\n").find((l) => l.trim().startsWith("@marketing path"));
	if (!line) {
		failures.push(`${caddyPath}: no "@marketing path …" matcher line found.`);
		continue;
	}
	const caddyPaths = line.trim().replace(/^@marketing path\s+/, "").split(/\s+/);
	const caddyCanon = new Set(caddyPaths.map(canon));
	for (const p of mfCanon) {
		if (!caddyCanon.has(p)) {
			failures.push(
				`Path "${p}" is in ${MF_PATH} but missing from the Caddy @marketing matcher (${caddyPath}).`,
			);
		}
	}
	for (const p of caddyCanon) {
		if (!mfCanon.has(p)) {
			failures.push(
				`Path "${p}" is in the Caddy @marketing matcher (${caddyPath}) but not in ${MF_PATH}.`,
			);
		}
	}
}

// ── Check 3: asset prefix is consistent across json / Caddy / marketing next.config ───
if (assetPrefix) {
	if (!mfCanon.has(`/${assetPrefix}/*`)) {
		failures.push(
			`assetPrefix "${assetPrefix}" has no "/${assetPrefix}/:path*" route in ${MF_PATH}.`,
		);
	}
	if (existsSync(MARKETING_NEXT_CONFIG)) {
		const cfg = readFileSync(MARKETING_NEXT_CONFIG, "utf8");
		const re = new RegExp(`assetPrefix:\\s*["']/${assetPrefix}["']`);
		if (!re.test(cfg)) {
			failures.push(
				`apps/marketing/next.config.ts assetPrefix does not match microfrontends.json ("/${assetPrefix}").`,
			);
		}
	}
} else {
	failures.push(`${MF_PATH}: applications.marketing.assetPrefix is missing.`);
}

// ── Check 4: every static first-party navigation target resolves ──────────────────────
/** Recursively collect files accepted by `include`. */
function collectFiles(dir, include) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (["node_modules", ".next", "coverage", "test-results", "playwright-report"].includes(entry.name)) {
			continue;
		}
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...collectFiles(full, include));
		else if (include(full)) files.push(full);
	}
	return files;
}

/** Turn a Next app-router page/route file into its URL pattern. */
function nextRoute(root, file, prefix = "") {
	const segments = relative(root, dirname(file))
		.split(sep)
		.filter(Boolean)
		.filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith("@"));
	return `${prefix}/${segments.join("/")}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

/** Convert a Next dynamic route into a matcher while preserving catch-all semantics. */
function routeRegex(route) {
	if (route === "/") return /^\/$/;
	let pattern = "^";
	for (const segment of route.split("/").filter(Boolean)) {
		if (/^\[\[\.\.\..+\]\]$/.test(segment)) {
			pattern += "(?:/.*)?";
		} else if (/^\[\.\.\..+\]$/.test(segment)) {
			pattern += "/.+";
		} else if (/^\[.+\]$/.test(segment)) {
			pattern += "/[^/]+";
		} else {
			pattern += `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
		}
	}
	return new RegExp(`${pattern}/?$`);
}

const routePatterns = [];
for (const [root, prefix] of [
	[join(REPO_ROOT, "apps/marketing/app"), ""],
	[join(REPO_ROOT, "apps/blog/app"), "/blog"],
]) {
	for (const file of collectFiles(root, (candidate) => /\/(?:page|route)\.(?:tsx?|jsx?)$/.test(candidate))) {
		routePatterns.push(routeRegex(nextRoute(root, file, prefix)));
	}
}

// Console-owned static/compatibility routes are valid public targets. Deliberately
// exclude the /[org] tree: a missing marketing page must not pass merely because the
// console would interpret its first segment as an organization slug.
const consoleApp = join(REPO_ROOT, "apps/console/app");
for (const file of collectFiles(consoleApp, (candidate) => /\/(?:page|route)\.(?:tsx?|jsx?)$/.test(candidate))) {
	const route = nextRoute(consoleApp, file);
	if (!route.includes("[org]")) routePatterns.push(routeRegex(route));
}

const docsContent = join(REPO_ROOT, "apps/docs/content/docs");
for (const file of collectFiles(docsContent, (candidate) => extname(candidate) === ".mdx")) {
	const rel = relative(docsContent, file).split(sep).join("/").replace(/\.mdx$/, "");
	const suffix = rel === "index" ? "" : rel.replace(/\/index$/, "");
	routePatterns.push(routeRegex(`/docs${suffix ? `/${suffix}` : ""}`));
}
routePatterns.push(/^\/robots\.txt$/, /^\/sitemap\.xml$/);
for (const publicRoot of [
	join(REPO_ROOT, "apps/console/public"),
	join(REPO_ROOT, "apps/marketing/public"),
]) {
	if (!existsSync(publicRoot)) continue;
	for (const file of collectFiles(publicRoot, () => true)) {
		const publicPath = `/${relative(publicRoot, file).split(sep).join("/")}`;
		routePatterns.push(routeRegex(publicPath));
	}
}

/** Normalize a local or canonical first-party URL to its path, without query/hash. */
function firstPartyPath(value) {
	if (value === "#") return "#";
	if (value.startsWith("https://alethialabs.io/")) return new URL(value).pathname;
	if (!value.startsWith("/")) return null;
	return value.split(/[?#]/, 1)[0] || "/";
}

/** Extract static navigation literals without treating arbitrary prose/code strings as links. */
function navigationTargets(file) {
	const source = readFileSync(file, "utf8");
	const found = [];
	const patterns = [
		/\bhref\s*=\s*["']([^"']+)["']/g,
		/\bhref\s*:\s*["']([^"']+)["']/g,
		/\b(?:redirect|permanentRedirect|push|replace|legalUrl)\(\s*["']([^"']+)["']/g,
		/\bnew URL\(\s*["']([^"']+)["']/g,
	];
	if (file.endsWith("footer.tsx")) patterns.push(/\breturn\s+["']([^"']+)["']/g);
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) found.push(match[1]);
	}
	for (const match of source.matchAll(/https:\/\/alethialabs\.io\/[A-Za-z0-9_~./?%=&-]*/g)) {
		found.push(match[0]);
	}
	if (/(?:href|redirect|push|replace)[^\n]{0,100}["']#["']/.test(source)) found.push("#");
	return found;
}

const navigationRoots = [
	join(REPO_ROOT, "apps/marketing"),
	join(REPO_ROOT, "apps/console"),
	join(REPO_ROOT, "packages/support/src/emails"),
];
const seenBroken = new Set();
for (const root of navigationRoots) {
	for (const file of collectFiles(root, (candidate) => /\.(?:tsx?|jsx?)$/.test(candidate) && !candidate.includes("/tests/") && !candidate.includes("/e2e/"))) {
		for (const target of navigationTargets(file)) {
			const pathname = firstPartyPath(target);
			if (!pathname) continue;
			const key = `${relative(REPO_ROOT, file)}\0${target}`;
			if (seenBroken.has(key)) continue;
			if (pathname === "#") {
				failures.push(`${relative(REPO_ROOT, file)}: bare "#" navigation target.`);
				seenBroken.add(key);
				continue;
			}
			if (!routePatterns.some((pattern) => pattern.test(pathname))) {
				failures.push(
					`${relative(REPO_ROOT, file)}: first-party navigation target "${target}" has no route.`,
				);
				seenBroken.add(key);
			}
		}
	}
}

// ── Check 5: every top-level CONSOLE route is a reserved org slug ────────────────────
//
// The success line below reports this count, because a green that mentions only the marketing
// half says nothing about whether this half ran.
let consoleSegmentCount = 0;
//
// The marketing half of this file has been guarded since it was written; the console's own routes
// never were, and #4133 is the bill. `RESERVED_SLUGS` is what tells a first path segment naming an
// ORG from one naming a ROUTE, and five `(public)` segments — accept-terms, login, onboarding,
// signup, sso — had never been in it. An org could be minted shadowing `/login`, and anything
// reading segment 0 as an org slug read `accept-terms` as one.
//
// The severity is not uniform across the five, which is why this is a guard and not a one-time
// list edit: `(private)/layout.tsx` redirects EVERY private route to /accept-terms while a Terms
// version is unaccepted. So the omission that matters most is the one nobody would have picked out
// of the five by inspection, and the next route added is equally unpredictable.
//
// NOTE the asymmetry with check 1. Marketing routes must be in microfrontends.json, which FEEDS
// RESERVED_SLUGS. Console routes have no such registry — they are reserved by hand — so this
// compares the app tree against the static list directly.
const CONSOLE_APP = "app";
const routingSrc = readFileSync("lib/routing.ts", "utf8");

/**
 * Strip comments so a quoted word inside PROSE is never read as a slug.
 *
 * LINE COMMENTS FIRST, and the order is not stylistic. `lib/routing.ts` carries the line
 *
 *     // PostHog reverse-proxy path (next.config.ts rewrites /ingest/* → eu.i.posthog.com).
 *
 * and `/ingest/*` opens a block comment as far as a naive block pass is concerned. Stripping
 * blocks first therefore deleted from there to the next `*&#47;` far below — taking the rest of the
 * array and its closing bracket with it, and leaving a list that ran on into the NEXT array in the
 * file. Removing line comments first leaves that `/*` nothing to open.
 */
function stripComments(src) {
	return src.replace(/(^|[^:])\/\/[^\n]*/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * The literals in `const <name> = [ … ]`, read by BALANCING BRACKETS rather than by a regex.
 *
 * Both details are bought experience, from a review of the first version of this very check:
 *
 *  · A regex over the raw text counted any double-quoted token inside a COMMENT as a slug. The
 *    array's own comment discusses `/login`; one edit from backticks to quotes and this guard went
 *    green on the exact entry it exists to protect. Comments are stripped first.
 *  · `/\[([\s\S]*?)\n\];/` terminates on `\n];`, so writing `] as const;` did not fail — the lazy
 *    match ran on to the NEXT array in the file and silently absorbed its contents. Balancing
 *    brackets ends where the array ends, however it is punctuated.
 *
 * Returns null when the declaration is absent, which the caller treats as a failure — a check that
 * stops finding its input must not report the same thing as a check that found nothing wrong.
 */
function arrayLiterals(src, name) {
	const start = src.indexOf(`const ${name} = [`);
	if (start === -1) return null;
	let depth = 0;
	let i = src.indexOf("[", start);
	const open = i;
	for (; i < src.length; i++) {
		if (src[i] === "[") depth++;
		else if (src[i] === "]" && --depth === 0) break;
	}
	if (depth !== 0) return null;
	return [...src.slice(open, i).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const staticList = arrayLiterals(stripComments(routingSrc), "STATIC_RESERVED_SLUGS");
if (staticList === null) {
	failures.push(
		"lib/routing.ts: could not read `const STATIC_RESERVED_SLUGS = [ … ]`. This check reads that\n" +
			"    declaration from source; if it was renamed or reshaped, update this guard rather than\n" +
			"    deleting it — a route-shadow check that silently stops finding its input is worse than none.",
	);
} else {
	const staticSlugs = new Set(staticList);
	// PERSONAL_ORG_SLUG is referenced by name, not as a literal, so it is not in the matches above.
	staticSlugs.add("~");
	// GUARD THE GUARD. Everything below is a set difference, and an empty or truncated left side
	// makes it vacuously green. `dashboard` has been in this list since it was written; its absence
	// means the read went wrong, not that the route stopped being reserved.
	if (!staticSlugs.has("dashboard") || staticSlugs.size < 8) {
		failures.push(
			`lib/routing.ts: read only ${staticSlugs.size} slug(s) from STATIC_RESERVED_SLUGS and no ` +
				"`dashboard`. That is a parse failure, not a small list — refusing rather than reporting\n" +
				"    every console route as unreserved, or none of them.",
		);
	}
	const consoleSegments = existsSync(CONSOLE_APP) ? collectSegments(CONSOLE_APP, true) : null;
	consoleSegmentCount = consoleSegments === null ? 0 : consoleSegments.size;
	if (consoleSegments === null) {
		failures.push(`Console app dir not found at ${CONSOLE_APP}.`);
	} else {
		for (const seg of consoleSegments) {
			// "" is `app/page.tsx`, the root. `[org]` IS the org segment, not a shadow of one.
			if (seg === "" || /^\[.*\]$/.test(seg)) continue;
			if (staticSlugs.has(seg) || mfSegments.has(seg)) continue;
			failures.push(
				`Console route "/${seg}" (apps/console/app/…/${seg}) is not a reserved org slug.\n` +
					`    → add "${seg}" to STATIC_RESERVED_SLUGS in apps/console/lib/routing.ts.\n` +
					"    Until it is, an organization can be minted with that slug and shadow the route, and\n" +
					"    anything reading the first path segment as an org (lib/authz/org-scope.ts) reads this\n" +
					"    route as an org slug and fails to resolve it. See #4133.",
			);
		}
	}
}

// ── Report ───────────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
	console.error(
		"Marketing path list out of sync (source of truth: apps/console/microfrontends.json):",
	);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(
		"\nKeep apps/console/marketing-zones.json, every Caddy marketing matcher, the marketing app,\n" +
			"and first-party navigation targets in sync. RESERVED_SLUGS derives from the route map automatically.",
	);
	process.exit(1);
}

console.log(
	`OK — ${mfPaths.length} marketing paths and static first-party navigation targets resolve across every route mirror,` +
		` and all ${consoleSegmentCount} top-level console route(s) are reserved org slugs.`,
);
