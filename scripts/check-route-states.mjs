#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The route-state gate: predicates S1–S4 and T1–T4 of
// `apps/console/docs/ui-conformance/RUBRIC.md`, scored over every private console route.
//
//   node scripts/check-route-states.mjs                 # score the real tree against the baseline
//   node scripts/check-route-states.mjs --json          # the same, as JSON
//   node scripts/check-route-states.mjs --routes        # one line per route per predicate
//   node scripts/check-route-states.mjs --print-baseline# the YAML the current tree would need
//   node scripts/check-route-states.mjs --self-test     # the fixture suite
//   node scripts/check-route-states.mjs --help
//
// `pnpm check:route-states` is the bare form above, and `Authz / open-core guards` in
// `.github/workflows/ci.yml` runs BOTH — the check and the `--self-test` — as two separate steps,
// because one step that does both cannot distinguish "nothing found" from "nothing ran" (#3759).
// Do not pipe either into `tail`/`head`: a pipe reports the exit code of its LAST command.
//
// ── WHY IT READS THE MANIFEST AND DOES NOT WALK THE TREE ─────────────────────────────────────
//
// The route set comes from `scripts/lib/console-routes.mjs` and from nowhere else. Two definitions
// of "the console's private routes" means two denominators, and a score whose denominator came
// from somewhere else cannot distinguish a route that failed from a route that was never visited.
// The manifest RAISES on a zero-route tree; this file does not catch that into a green — a throw
// out of `collectConsoleRoutes()` exits non-zero here with the manifest's own message.
//
// ── WHAT THIS FILE READS THAT THE MANIFEST DOES NOT ──────────────────────────────────────────
//
// Predicates S2–S4 are about a max-width, and the manifest carries no width. So this file resolves
// one, from files the RECORD names: the page (`record.file`), the nearest loading boundary
// (`record.boundaries.loading.file`), the layouts (`record.layoutChain`) and the shells
// (`manifest.shells`). It never discovers a file by walking — every path it opens was handed to it.
//
// A "content width" is a centred block: a class list carrying BOTH `mx-auto` and a `max-w-*`.
// That discriminator is not decoration. `max-w-[380px]` on a table cell, `max-w-md` on an empty
// state and `max-w-xs` on a truncating column are widths of things inside the page, not of the
// page, and a predicate that counted them would report nearly every route as "sets a width" and
// measure nothing. Measured over the real tree, `mx-auto` + `max-w-*` selects exactly one width
// per file and zero of those inner constraints.
//
// Requiring `w-full` as well was tried and REJECTED: `[project]/environments/loading.tsx` is
// `mx-auto max-w-3xl` and `~/support/page.tsx` is `relative mx-auto max-w-4xl`, and both are page
// containers. A rule requiring `w-full` is blind to two of the defects this gate exists to find,
// including one the issue itself names.
//
// ── T3 READS LAYOUTS, AND WHAT IT DELIBERATELY DOES NOT MEASURE ──────────────────────────────
//
// T3's placement half (see the note on the predicate) needs to know which layouts in a route's
// chain call `notFound()`, so this file reads `record.layoutChain` as well as the page. Two bounds
// are stated here rather than left to be inferred, because an unstated exception is how the next
// reader concludes the whole predicate is enforced:
//
//   1. THE N/A GATE IS STILL THE PAGE'S. `callsNotFound` is the page source and only the page
//      source, so a route whose page never calls `notFound()` is N/A even when a layout above it
//      does. `[org]/layout.tsx` throws for an unknown org and its throw escapes `[org]/not-found.tsx`
//      by exactly the mechanism below — that defect is real and T3 does not report it, on any of
//      the ~30 routes it touches. Widening the gate would charge one layout's defect to every
//      route beneath it; the org boundary is its own unit of work.
//   2. ONLY LAYOUTS AT OR BELOW THE ROUTE'S FRAME COUNT — the innermost dynamic segment, or the
//      page's own segment for a static route. A layout above the frame throws about an OUTER
//      resource, and whether ITS boundary is placed right is measured on the routes whose
//      innermost segment that one is, not here. Without this bound `[org]/layout.tsx` would fail
//      every project route for a reason that has nothing to do with the project.
//
// ── THE PERMANENT POSITIVE CONTROL ───────────────────────────────────────────────────────────
//
// EVERY run — not just `--self-test` — scores two fixture trees before it scores the real one:
// a `probe` tree in which each predicate has a route it MUST fail, and an `antiProbe` tree in
// which each has a route it MUST pass. If a predicate stops firing, the gate refuses to report on
// the real tree at all. This is what keeps the check honest after the baseline reaches zero: a
// predicate that can no longer fail is indistinguishable from a clean tree, and every other guard
// in this repo that got that wrong reported green for months.
//
// ── THE ONE FINDING THAT IS NOT PER-ROUTE ────────────────────────────────────────────────────
//
// `layoutBoundaryEscapes()` is scored per LAYOUT, is not baselined, and is not one of the eight
// predicates. It reports a layout that calls `notFound()` with no `not-found.tsx` at the segment
// ABOVE it — the throw then escapes every boundary written for that segment and lands on the root
// `app/not-found.tsx`, so the user gets the generic page-not-found (#3880 at `[project]`, #3891 at
// `[org]`, where it covered 38 of 40 routes).
//
// It is deliberately NOT a predicate, and the reason is the whole point of separating it. T3 is
// bounded to layouts at or below the route's frame, so one layout's defect is never charged to
// every route beneath it — a gate that reports 38 routes broken for one cause trains people to
// ignore it. The same bound is what made `[org]/layout.tsx` invisible to T3, before and after its
// fix. A per-layout invariant restores the coverage at the right granularity: one finding per
// defect, named at the file that holds it.
//
// It is also not baselined, because after #3891 the tree holds zero of them and a ratchet at zero
// is just an assertion with a file behind it.
//
// Do NOT pipe it. `node scripts/check-route-states.mjs | tail` reports TAIL's exit code.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_EXTENSIONS, collectConsoleRoutes, stripCommentLines } from "./lib/console-routes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const BASELINE_FILE = path.join("apps", "console", "route-states-baseline.yaml");

/** The predicates this file implements, in rubric order. */
export const PREDICATES = /** @type {const} */ (["S1", "S2", "S3", "S4", "T1", "T2", "T3", "T4"]);

/** One line of the rubric's table, for the report. */
const TITLES = {
	S1: "the page renders inside a known shell",
	S2: "exactly one max-width governs the content, and it comes from the shell",
	S3: "the loading skeleton is the same width as the page",
	S4: "no page-local duplicate of a shell constraint",
	T1: "the loading skeleton is the page's own, or a correct ancestor's",
	T2: "an error boundary covers the segment",
	T3: "notFound() has a not-found.tsx scoped to the same resource",
	T4: "the page declares metadata",
};

/**
 * The FIXED set of N/A reasons each predicate may return — RUBRIC.md's "N/A is where a rubric goes
 * wrong", rule 1. A reason outside its predicate's set is an ERROR, not an N/A: the failure this
 * closes is a caveat added to make a hard page stop failing, which raises the score by shrinking
 * the denominator and shows up nowhere.
 *
 * T2 and T4 declare the EMPTY set on purpose. The rubric says "never" for both — every route can
 * throw, and a redirect still owns a title — so a redirect-only page is scored, not excused.
 */
export const NA_REASONS = /** @type {const} */ ({
	S1: ["redirect-only"],
	S2: ["redirect-only"],
	S3: ["redirect-only", "no-loading-boundary"],
	S4: ["redirect-only"],
	T1: ["redirect-only"],
	T2: [],
	T3: ["does-not-call-not-found"],
	T4: [],
});

// ── width resolution ─────────────────────────────────────────────────────────────────────────

/**
 * One string literal — quote-KIND aware, escape aware, and matched WITHIN A SINGLE LINE.
 *
 * Both properties are load-bearing, and both are here because the naive `["`'][^"`']*?["`']`
 * this started as pairs quote CHARACTERS across the whole file: one apostrophe in JSX text
 * (`You don't have any projects`) shifts the pairing for every literal below it, and every width
 * after that point disappears. That is a false PASS, not a loud one — a page whose width is
 * invisible reads as "sets none", which is S4's PASS branch and can be S3's. `console-routes.mjs`
 * solved the same problem with `quotesClosedBefore()`, which is per-line for the same reason.
 *
 * The cost, stated: a class list split ACROSS lines inside one template literal is not seen. It
 * never was — a `cn("mx-auto", "max-w-4xl")` is two literals and was already invisible — and a
 * scanner that reads across lines is the one that mis-pairs.
 */
const LITERAL = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/**
 * A centred content container is a class list carrying both of these.
 *
 * Each is anchored to a whole class token — `(?:^|\s)` in front, `(?=\s|$)` behind, with any
 * variant prefixes (`lg:`, `dark:`) skipped — rather than to a `\b`. A `\b`-anchored
 * `max-w-(?:\[…\]|[a-z0-9]+)` stops at the first `-`, so `max-w-screen-lg` and `max-w-screen-sm`
 * both read as `max-w-screen` and S3 reports a mismatched skeleton as equal: the one thing S3
 * exists to catch, failing in the quiet direction. The bracket alternative runs to its `]` rather
 * than to the first space, so `max-w-[calc(100% - 2rem)]` is one width and not nothing.
 */
const MX_AUTO = /(?:^|\s)(?:[\w-]+:)*mx-auto(?=\s|$)/;
const MAX_W = /(?:^|\s)(?:[\w-]+:)*(max-w-(?:\[[^\]]*\]|[a-z0-9]+(?:-[a-z0-9]+)*))(?=\s|$)/;

/**
 * Read a file through the manifest's comment stripper as LINES, or null when it does not exist.
 *
 * @returns {string[]|null}
 */
function readStrippedLines(abs) {
	if (!existsSync(abs)) return null;
	const { lines, unterminated } = stripCommentLines(readFileSync(abs, "utf8"));
	if (unterminated) {
		throw new Error(
			`${abs}: a block comment is still open at EOF — refusing to read it, because everything ` +
				`after the opener has been blanked and would silently stop matching`,
		);
	}
	return lines;
}

/**
 * The same source as one string — for the import scan, which is not width-sensitive.
 */
function readStripped(abs) {
	const lines = readStrippedLines(abs);
	return lines === null ? null : lines.join("\n");
}

/**
 * Source of a file the MANIFEST said exists, or a raised error.
 *
 * `readStripped` answers `null` for "not there", which is a legitimate answer when the caller is
 * asking whether a boundary exists. It is NOT a legitimate answer here: every path handed to this
 * comes from the manifest's own filesystem walk, so an unreadable one means the tree moved under us
 * or the walk is wrong. Coalescing that to `""` would make the regex below find no `notFound()` and
 * report the route CLEAN — absence and error giving the same answer, which is the shape that keeps
 * biting this repo. Raise instead: a scan that cannot read its own subject has not scored it.
 */
function readManifestFile(abs) {
	const src = readStripped(abs);
	if (src === null) {
		throw new Error(
			`${abs}: the route manifest names this file but it could not be read — refusing to score, ` +
				`because "unreadable" and "contains no notFound()" must not look the same`,
		);
	}
	return src;
}

/**
 * Every content-width token declared by one file, as `max-w-…` strings.
 *
 * @param {string} abs absolute path
 * @returns {string[]} deduplicated, in source order
 */
function widthsIn(abs) {
	const lines = readStrippedLines(abs);
	if (lines === null) return [];
	/** @type {string[]} */
	const out = [];
	for (const line of lines) {
		for (const m of line.matchAll(LITERAL)) {
			const s = m[0].slice(1, -1);
			if (!MX_AUTO.test(s)) continue;
			const w = s.match(MAX_W);
			if (w && !out.includes(w[1])) out.push(w[1]);
		}
	}
	return out;
}

const MODULE_EXTENSIONS = ["tsx", "ts", "jsx", "js"];

/**
 * Resolve one import specifier to a file inside `apps/console`, or null.
 *
 * Only `./`, `../` and the `@/` alias are resolved, and only to a file that exists — a package
 * specifier (`@repo/ui/button`, `next/navigation`) is somebody else's tree and is not read.
 */
function resolveImport(repoRoot, fromFile, spec) {
	let base;
	if (spec.startsWith("./") || spec.startsWith("../")) {
		base = path.resolve(path.dirname(fromFile), spec);
	} else if (spec.startsWith("@/")) {
		base = path.resolve(repoRoot, "apps", "console", spec.slice(2));
	} else {
		return null;
	}
	const consoleDir = path.resolve(repoRoot, "apps", "console");
	if (!base.startsWith(consoleDir + path.sep)) return null;
	for (const ext of MODULE_EXTENSIONS) if (existsSync(`${base}.${ext}`)) return `${base}.${ext}`;
	for (const ext of MODULE_EXTENSIONS) {
		const idx = path.join(base, `index.${ext}`);
		if (existsSync(idx)) return idx;
	}
	return null;
}

/**
 * A routing file's own width, or the width of a module it DIRECTLY imports.
 *
 * ONE LEVEL, deliberately and statedly. A console page is overwhelmingly a server component whose
 * whole body is `return <SomethingClient … />`, so the container that owns the page width lives in
 * that one import — `~/alerts` is `<AlertsPage/>` and the 1200px is in `alerts-page.tsx`, `~/new`
 * is `<CreateProjectForm/>` and the `max-w-5xl` is in `create-project-form.tsx`. Reading the page
 * file alone would report 35 of 36 pages as "sets no width", which is not a measurement of
 * anything. Following the graph transitively would drag in the whole component tree and start
 * counting a dialog's `mx-auto max-w-md` as the page width. One level is where the signal is; a
 * container that hides two levels down is a miss this file does not claim to catch.
 *
 * @returns {{width: string|null, sites: string[]}}
 */
function resolveWidth(repoRoot, relFile) {
	const abs = path.join(repoRoot, relFile);
	const src = readStripped(abs);
	if (src === null) return { width: null, sites: [] };
	/** @type {string[]} */
	const sites = [];
	/** @type {string|null} */
	let width = null;
	const consider = (file) => {
		for (const w of widthsIn(file)) {
			if (width === null) width = w;
			sites.push(`${path.relative(repoRoot, file)}:${w}`);
		}
	};
	consider(abs);
	/** @type {Set<string>} */
	const seen = new Set();
	for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
		const resolved = resolveImport(repoRoot, abs, m[1]);
		if (resolved === null || seen.has(resolved)) continue;
		seen.add(resolved);
		consider(resolved);
	}
	return { width, sites };
}

/**
 * The innermost shell whose layout is an ancestor-or-self of `dir`, and the width it declares.
 *
 * Scoped rather than simply `record.shell`, because a `loading.tsx` inherited from an ancestor
 * segment renders where IT sits, not where the page sits: `[org]/loading.tsx` replaces everything
 * below `[org]/layout.tsx`, so it renders inside AppShell and NOT inside the SettingsShell that
 * wraps `~/settings/classification`. Comparing the skeleton against the page's own shell width
 * would silently attribute a width to a skeleton that never renders inside it.
 *
 * @returns {{shell: string|null, width: string|null}}
 */
function shellInScope(repoRoot, record, shellsByName, dirRel) {
	const dirAbs = path.resolve(repoRoot, dirRel);
	/** @type {string|null} */
	let shell = null;
	for (const layoutRel of record.layoutChain) {
		const layoutDir = path.resolve(repoRoot, path.dirname(layoutRel));
		const applies = dirAbs === layoutDir || dirAbs.startsWith(layoutDir + path.sep);
		if (!applies) continue;
		const src = readStripped(path.join(repoRoot, layoutRel));
		if (src === null) continue;
		const mounted = [...shellsByName.keys()]
			.map((name) => ({ name, at: src.search(new RegExp(`<${name}\\b`)) }))
			.filter((hit) => hit.at >= 0)
			.sort((a, b) => a.at - b.at);
		// Layouts are walked outermost-first and each layout's mounts are ordered by position, so
		// the last one assigned is the innermost — the same rule the manifest uses for `shell`.
		for (const hit of mounted) shell = hit.name;
	}
	return { shell, width: shell === null ? null : (shellsByName.get(shell) ?? null) };
}

// ── the evaluation context ───────────────────────────────────────────────────────────────────

/**
 * Everything the eight predicates read, resolved once per route.
 *
 * @param {object} manifest the value of `collectConsoleRoutes()`
 * @param {string} repoRoot
 */
export function buildContexts(manifest, repoRoot) {
	// A shell's width is resolved the SAME way a page's is — its own file, then the modules it
	// directly imports. Reading the shell file alone made the two halves ask different questions:
	// a `SettingsShell` refactored to `return <PageContainer>{children}</PageContainer>`, with the
	// `mx-auto max-w-[1200px]` one import away, would report "declares none" and flip every page
	// under it to an S2 failure — a large, wrong baseline swing produced by a refactor that broke
	// nothing.
	/** @type {Map<string,string|null>} */
	const shellsByName = new Map();
	for (const s of manifest.shells) {
		shellsByName.set(s.name, resolveWidth(repoRoot, s.file).width);
	}
	/** Every width some known shell owns — the set a page must not hand-roll (S4). */
	const shellOwnedWidths = new Set([...shellsByName.values()].filter((w) => w !== null));

	/** dir (repo-relative) → the route whose page.tsx sits in it. */
	const routeByDir = new Map(manifest.routes.map((r) => [r.dir, r]));

	return manifest.routes.map((record) => {
		const pageSrc = readManifestFile(path.join(repoRoot, record.file));
		const page = resolveWidth(repoRoot, record.file);
		const shellWidth = record.shell === null ? null : (shellsByName.get(record.shell) ?? null);

		const ld = record.boundaries.loading;
		const loading = ld.file === null ? { width: null, sites: [] } : resolveWidth(repoRoot, ld.file);
		const loadingDir = ld.file === null ? null : path.dirname(ld.file);
		const loadingShell =
			loadingDir === null
				? { shell: null, width: null }
				: shellInScope(repoRoot, record, shellsByName, loadingDir);
		// The page that OWNS the inherited skeleton, if any. T1 turns on whether that page is a
		// real page (whose skeleton is its own) or a redirect/absent one (whose skeleton exists
		// only to serve the subtree beneath it).
		const loadingOwner = loadingDir === null ? undefined : routeByDir.get(loadingDir);

		// The directory of the page's innermost dynamic segment — the resource a bad slug names.
		/** @type {string|null} */
		let innermostParamDir = null;
		for (let i = record.segments.length; i > 0; i--) {
			if (record.segments[i - 1].startsWith("[")) {
				innermostParamDir = path.join(manifest.appDir, ...record.segments.slice(0, i));
				break;
			}
		}

		// The frame T3 measures this route's boundary against: the innermost dynamic segment when
		// there is one, else the page's own segment. A layout ABOVE the frame throws about an
		// OUTER resource, and its boundary is the business of the routes whose innermost segment
		// that one is — not of this route. See the T3 note in this file's header.
		const frameDir = innermostParamDir ?? record.dir;
		// The layouts in this route's chain, at or below that frame, whose body calls notFound().
		// The manifest hands over every path opened here; nothing is discovered by walking.
		const notFoundThrowingLayouts = record.layoutChain.filter((layoutRel) => {
			const layoutDir = path.dirname(layoutRel);
			const inFrame = layoutDir === frameDir || layoutDir.startsWith(frameDir + path.sep);
			if (!inFrame) return false;
			return /\bnotFound\s*\(/.test(readManifestFile(path.join(repoRoot, layoutRel)));
		});

		return {
			record,
			shellWidth,
			shellOwnedWidths,
			pageWidth: page.width,
			pageWidthSites: page.sites,
			loadingWidth: loading.width,
			loadingShellWidth: loadingShell.width,
			/**
			 * true = the segment that owns that skeleton has a real page of its own, so this route
			 * is rendering somebody else's. false = no page owns that directory, or the one that
			 * does only redirects — the skeleton was written for the subtree beneath it.
			 */
			loadingOwnerIsOwnPage: loadingOwner === undefined ? false : !loadingOwner.isRedirectOnly,
			callsNotFound: /\bnotFound\s*\(/.test(pageSrc),
			innermostParamDir,
			/**
			 * Repo-relative layout files whose notFound() this route's boundary must be able to
			 * catch — the placement half of T3. A LAYOUT's throw unwinds outside its own segment's
			 * not-found.tsx, so this is not the same question as the page's.
			 */
			notFoundThrowingLayouts,
		};
	});
}

// ── the predicates ───────────────────────────────────────────────────────────────────────────

const PASS = (detail) => ({ verdict: "PASS", reason: null, detail: detail ?? "" });
const FAIL = (detail) => ({ verdict: "FAIL", reason: null, detail: detail ?? "" });
const NA = (reason) => ({ verdict: "N/A", reason, detail: "" });

/**
 * Each predicate is a pure function of the context above. Every N/A branch returns a reason from
 * `NA_REASONS`, and every one of those reasons is STRUCTURAL — `isRedirectOnly` and
 * `boundaries.loading.file === null` are properties of the route record, not readings of how the
 * page looks. RUBRIC.md rule 2: "This page has no empty state" is the thing being measured;
 * "this page is redirect-only" is not.
 */
export const CHECKS = {
	S1: (c) => {
		if (c.record.isRedirectOnly) return NA("redirect-only");
		return c.record.shell !== null ? PASS(c.record.shell) : FAIL("no known shell in the layout chain");
	},

	S2: (c) => {
		if (c.record.isRedirectOnly) return NA("redirect-only");
		if (c.shellWidth !== null && c.pageWidth === null) return PASS(`${c.record.shell} ${c.shellWidth}`);
		if (c.shellWidth === null && c.pageWidth === null) {
			return FAIL(`no max-width anywhere — ${c.record.shell ?? "no shell"} declares none`);
		}
		if (c.shellWidth === null) {
			return FAIL(`the page declares ${c.pageWidth}; ${c.record.shell ?? "no shell"} declares none`);
		}
		return FAIL(`two widths: ${c.record.shell} ${c.shellWidth} and the page's ${c.pageWidth}`);
	},

	S3: (c) => {
		if (c.record.isRedirectOnly) return NA("redirect-only");
		// The declared reason is `no-loading-boundary`, and it means what it says: the double-count
		// RUBRIC.md forbids is T1's "no loading.tsx anywhere" being charged a second time as "the
		// skeleton is the wrong width", when there is no skeleton. Where a boundary EXISTS but is
		// the wrong one, T1 and S3 report two different facts — `~/jobs/[id]` renders the list
		// skeleton (T1) and that skeleton is unconstrained against a page that is too (S3 PASSes) —
		// so N/A-ing them would excuse a predicate on 3 routes and shrink its denominator, which is
		// rule 1's failure, not its remedy. RUBRIC.md's S3 row states this bound.
		if (c.record.boundaries.loading.file === null) return NA("no-loading-boundary");
		const page = c.pageWidth ?? c.shellWidth;
		const skeleton = c.loadingWidth ?? c.loadingShellWidth;
		return page === skeleton
			? PASS(page ?? "neither constrains")
			: FAIL(`page ${page ?? "unconstrained"} vs skeleton ${skeleton ?? "unconstrained"}`);
	},

	S4: (c) => {
		if (c.record.isRedirectOnly) return NA("redirect-only");
		if (c.pageWidth === null) return PASS();
		// A DUPLICATE, not merely a second width — RUBRIC.md: "the page file and its direct children
		// declare no `max-w-*` **that a shell above them already sets**". Failing every page-declared
		// width under a width-owning shell would charge `~/support` (SupportShell 1200px, the page
		// `max-w-4xl`) twice for one defect: S2 already reports "two widths". S4's own row is the
		// narrower fact — the page wrote out a number a shell owns — which is the one a lane fixes by
		// DELETING the class rather than by moving it.
		if (c.pageWidth === c.shellWidth) {
			return FAIL(`${c.record.shell} already owns the width; the page re-declares ${c.pageWidth}`);
		}
		if (c.shellOwnedWidths.has(c.pageWidth)) {
			return FAIL(`the page hand-rolls ${c.pageWidth}, a width a shell already owns`);
		}
		return PASS(c.pageWidth);
	},

	T1: (c) => {
		if (c.record.isRedirectOnly) return NA("redirect-only");
		const ld = c.record.boundaries.loading;
		if (ld.own) return PASS("its own");
		if (ld.file === null) return FAIL("no loading.tsx anywhere in its chain");
		// An inherited skeleton is correct when the segment it belongs to has no page of its own to
		// have been written for — a redirect-only page, or no page at all. `[project]/settings` only
		// redirects, so `[project]/settings/loading.tsx` was written for the sub-pages and they PASS.
		// `~/jobs` is a real list page, so `~/jobs/loading.tsx` is the LIST's skeleton and `[id]`
		// inheriting it renders somebody else's.
		return c.loadingOwnerIsOwnPage
			? FAIL(`renders ${ld.file} at distance ${ld.distance} — that segment's own page skeleton`)
			: PASS(`inherited from a segment with no page of its own (distance ${ld.distance})`);
	},

	T2: (c) =>
		c.record.boundaries.error.file !== null
			? PASS(`${c.record.boundaries.error.file}@${c.record.boundaries.error.distance}`)
			: FAIL("no error.tsx anywhere in its chain"),

	// T3 has TWO halves, and the second one is the reason a `not-found.tsx` existing beside the
	// throw is not the predicate. SCOPE: the boundary must answer for the resource the innermost
	// dynamic segment names — `[org]/not-found.tsx` says "Organization not found" for a project
	// that is missing while its org is fine. PLACEMENT: the boundary must be able to FIRE.
	//
	// A segment's `not-found.tsx` is handed to the `LayoutRouter` for that segment's CHILDREN slot
	// (`next/dist/server/app-render/create-component-tree.js`: `notFoundComponent =
	// isChildrenRouteKey ? notFoundElement : undefined`), so the boundary mounts INSIDE that
	// segment's own layout. A page's throw is inside it; that segment's OWN LAYOUT's throw is not,
	// and unwinds to the next boundary above. The only case that wraps a segment's own layout is
	// `isRootLayoutWithChildrenSlotAndAtLeastOneMoreSlot`, whose own comment calls it a hack for
	// unmatched parallel routes and which requires the ROOT layout with more than one slot.
	//
	// So a layout at segment X that throws needs a boundary STRICTLY ABOVE X — and when X is the
	// innermost dynamic segment, that is unsatisfiable together with the scope half: no file can
	// be both above `[project]` and scoped to it. That is not a gap in the rule, it is the finding
	// (#3880), and it is why nine `[project]/**` routes failed while a `not-found.tsx` beside the
	// layout would have flipped them all to a false PASS.
	T3: (c) => {
		if (!c.callsNotFound) return NA("does-not-call-not-found");
		const nf = c.record.boundaries["not-found"];
		if (nf.file === null) return FAIL("calls notFound() with no not-found.tsx in its chain");
		const nfDir = path.dirname(nf.file);
		// ── placement ───────────────────────────────────────────────────────────────────────
		// The unsatisfiable case first, so it is reported as itself rather than as whichever half
		// happens to be tested first: a layout throwing AT the resource's own segment.
		const atFrame = c.notFoundThrowingLayouts.find(
			(rel) => c.innermostParamDir !== null && path.dirname(rel) === c.innermostParamDir,
		);
		if (atFrame !== undefined) {
			return FAIL(
				`${atFrame} calls notFound() at ${c.innermostParamDir}; that segment's own ` +
					`not-found.tsx mounts inside it and cannot catch it, and one above it answers ` +
					`for a different resource`,
			);
		}
		for (const rel of c.notFoundThrowingLayouts) {
			if (!path.dirname(rel).startsWith(nfDir + path.sep)) {
				return FAIL(
					`${rel} calls notFound() and ${nf.file} is not above it — the throw unwinds ` +
						`past that boundary`,
				);
			}
		}
		// ── scope ───────────────────────────────────────────────────────────────────────────
		if (c.innermostParamDir === null) return PASS(nf.file);
		const scoped = nfDir === c.innermostParamDir || nfDir.startsWith(c.innermostParamDir + path.sep);
		return scoped
			? PASS(nf.file)
			: FAIL(`resolves to ${nf.file}, which is above ${c.innermostParamDir}`);
	},

	T4: (c) => (c.record.hasMetadata ? PASS() : FAIL("no metadata title on the page or its own layout")),
};

/**
 * Score every route against every predicate.
 *
 * Raises when a predicate returns an N/A reason outside its declared set — RUBRIC.md rule 1. That
 * is an error rather than a finding on purpose: an undeclared reason means somebody added an escape
 * hatch, and the whole point of the fixed set is that adding one cannot be quiet.
 */
export function score(contexts) {
	/** @type {Record<string, {pass: string[], fail: {route: string, detail: string}[], na: Record<string, string[]>}>} */
	const out = {};
	for (const id of PREDICATES) out[id] = { pass: [], fail: [], na: {} };
	for (const c of contexts) {
		for (const id of PREDICATES) {
			const r = CHECKS[id](c);
			if (r.verdict === "PASS") {
				out[id].pass.push(c.record.route);
			} else if (r.verdict === "FAIL") {
				out[id].fail.push({ route: c.record.route, detail: r.detail });
			} else {
				const allowed = NA_REASONS[id];
				if (!allowed.includes(r.reason)) {
					throw new Error(
						`${id} returned N/A for ${c.record.route} with reason "${r.reason}", which is not ` +
							`in its declared set [${allowed.join(", ") || "(none — this predicate is never N/A)"}]. ` +
							`An undeclared N/A raises the score by shrinking the denominator; RUBRIC.md rule 1.`,
					);
				}
				(out[id].na[r.reason] ??= []).push(c.record.route);
			}
		}
	}
	return out;
}

/**
 * Flatten a scoring into the shape the baseline records: the MEMBERS, not the counts.
 *
 * A count cancels. One PR that adds `mx-auto max-w-3xl` to `~/evidence` and deletes the hand-rolled
 * `max-w-[1200px]` from `~/usage` leaves `S2.fail` at 17 and `S4.fail` at 2, so a ratchet reading
 * integers passes it green with a new defect landed — and the both-directions check that exists to
 * catch exactly that never sees it. `check-shared-surface.mjs`'s allowlist names its members for
 * the same reason. The other half of the payment is that a baseline edit becomes a readable diff
 * instead of eight integers.
 *
 * An N/A entry carries its REASON as well as its route (`/x: redirect-only`), because a route
 * silently changing which escape hatch it uses is the same defect one level down.
 */
function tally(scored) {
	/** @type {Record<string, {pass: number, fail: string[], na: string[]}>} */
	const t = {};
	for (const id of PREDICATES) {
		t[id] = {
			pass: scored[id].pass.length,
			fail: scored[id].fail.map((f) => f.route).sort(),
			na: Object.entries(scored[id].na)
				.flatMap(([reason, routes]) => routes.map((route) => `${route}: ${reason}`))
				.sort(),
		};
	}
	return t;
}

// ── the baseline ─────────────────────────────────────────────────────────────────────────────

/**
 * A deliberately tiny, deliberately STRICT parser for the baseline file — the worktree is
 * de-hydrated, so there is no YAML dependency to reach for, and the format is four scalars plus
 * eight blocks of two route LISTS.
 *
 * Strict in the loud direction: an unknown key, a missing predicate, a duplicate entry, a
 * malformed list item and an unreadable file all RAISE. A baseline this cannot read must never be
 * read as "no findings" — that is the shape of every silently-green guard this repo has shipped.
 */
export function parseBaseline(text, label) {
	const raise = (msg) => {
		throw new Error(`${label}: ${msg}`);
	};
	/** @type {Record<string, number>} */
	const top = {};
	/** @type {Record<string, {fail?: string[], na?: string[]}>} */
	const preds = {};
	/** @type {string|null} */
	let current = null;
	/** @type {"fail"|"na"|null} */
	let currentList = null;
	let inPredicates = false;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i].replace(/\s+#.*$/, "").replace(/^#.*$/, "");
		if (raw.trim() === "") continue;
		const indent = raw.length - raw.trimStart().length;
		const line = raw.trim();

		if (line.startsWith("- ")) {
			if (indent !== 6 || current === null || currentList === null) {
				raise(`line ${i + 1}: a list item with no "fail:" or "na:" block above it at 4 spaces`);
			}
			const entry = line.slice(2).trim();
			// A `fail` entry is a route; an `na` entry is `route: reason`, so that a route silently
			// switching escape hatches is a diff and not a no-op. Routes carry no ":" and no space.
			const shape = currentList === "fail" ? /^\S+$/ : /^\S+: [a-z][a-z0-9-]*$/;
			if (!shape.test(entry)) {
				raise(
					`line ${i + 1}: "${entry}" is not a valid ${current}.${currentList} entry ` +
						`(expected ${currentList === "fail" ? "a route" : "`<route>: <reason>`"})`,
				);
			}
			if (currentList === "na") {
				const reason = entry.slice(entry.indexOf(": ") + 2);
				if (!NA_REASONS[current].includes(reason)) {
					raise(
						`line ${i + 1}: ${current} declares no N/A reason "${reason}" ` +
							`[${NA_REASONS[current].join(", ") || "(none — this predicate is never N/A)"}]`,
					);
				}
			}
			if (preds[current][currentList].includes(entry)) raise(`line ${i + 1}: "${entry}" appears twice`);
			preds[current][currentList].push(entry);
			continue;
		}

		const m = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
		if (!m) raise(`line ${i + 1}: cannot parse "${line}"`);
		const [, key, value] = m;
		if (indent === 0) {
			inPredicates = key === "predicates";
			current = null;
			currentList = null;
			if (inPredicates) {
				if (value !== "") raise(`line ${i + 1}: "predicates:" takes a block, not a value`);
				continue;
			}
			if (!/^\d+$/.test(value)) raise(`line ${i + 1}: ${key} must be a non-negative integer`);
			if (key in top) raise(`line ${i + 1}: ${key} appears twice`);
			top[key] = Number(value);
			continue;
		}
		if (!inPredicates) raise(`line ${i + 1}: indented "${key}" outside the predicates block`);
		if (indent === 2) {
			if (value !== "") raise(`line ${i + 1}: "${key}:" takes a block, not a value`);
			if (key in preds) raise(`line ${i + 1}: predicate ${key} appears twice`);
			if (!PREDICATES.includes(key)) raise(`unknown predicate "${key}"`);
			preds[key] = {};
			current = key;
			currentList = null;
			continue;
		}
		if (indent === 4) {
			if (current === null) raise(`line ${i + 1}: "${key}" with no predicate above it`);
			if (key !== "fail" && key !== "na") raise(`line ${i + 1}: unknown predicate key "${key}"`);
			if (value !== "" && value !== "[]") {
				raise(`line ${i + 1}: ${current}.${key} takes a list, not "${value}" — "[]" when empty`);
			}
			if (key in preds[current]) raise(`line ${i + 1}: ${current}.${key} appears twice`);
			preds[current][key] = [];
			currentList = value === "[]" ? null : key;
			continue;
		}
		raise(`line ${i + 1}: unexpected indentation (${indent} spaces)`);
	}

	for (const key of ["version", "routes", "redirectOnly", "real"]) {
		if (!(key in top)) raise(`missing "${key}"`);
	}
	for (const key of Object.keys(top)) {
		if (!["version", "routes", "redirectOnly", "real"].includes(key)) raise(`unknown key "${key}"`);
	}
	if (top.version !== 1) raise(`version ${top.version} is not 1`);
	for (const id of PREDICATES) {
		if (!(id in preds)) raise(`missing predicate ${id}`);
		if (!("fail" in preds[id])) raise(`${id} is missing "fail"`);
		if (!("na" in preds[id])) raise(`${id} is missing "na"`);
	}
	for (const id of Object.keys(preds)) {
		if (!PREDICATES.includes(id)) raise(`unknown predicate "${id}"`);
	}
	return { ...top, predicates: preds };
}

/**
 * Compare a tally against the baseline in BOTH directions, as SETS.
 *
 * A new member is a regression, and a member the tree no longer has is a failure too until the
 * baseline drops it in the same commit. A one-directional ratchet lets a fix land with a stale
 * baseline, and a stale baseline is a gate that has stopped measuring the thing it names — the
 * next regression back into the old entry reports green.
 *
 * Sets rather than counts because counts CANCEL: one fix and one regression inside the same
 * predicate leave the integer where it was, and the both-directions check never fires. N/A
 * membership is compared the same way, and carries its reason, for the reason RUBRIC.md gives: a
 * predicate being escaped must not be able to happen quietly.
 *
 * @returns {string[]} one line per violation; empty means clean
 */
export function compareToBaseline(baseline, tallied, totals) {
	/** @type {string[]} */
	const problems = [];
	const cmp = (label, actual, expected, hint) => {
		if (actual === expected) return;
		problems.push(
			`${label}: baseline says ${expected}, tree has ${actual} — ` +
				(actual > expected ? `a REGRESSION. ${hint}` : `an IMPROVEMENT. Lower the baseline in the same commit as the fix.`),
		);
	};
	/** Both differences between two entry lists, each reported with what to do about it. */
	const cmpSet = (label, actual, expected, hint) => {
		const added = actual.filter((x) => !expected.includes(x));
		const gone = expected.filter((x) => !actual.includes(x));
		if (added.length > 0) {
			problems.push(`${label}: NOT in the baseline — ${added.join(", ")} — a REGRESSION. ${hint}`);
		}
		if (gone.length > 0) {
			problems.push(
				`${label}: in the baseline, no longer in the tree — ${gone.join(", ")} — an IMPROVEMENT. ` +
					`Delete the line in the same commit as the fix.`,
			);
		}
	};
	cmp("routes", totals.routes, baseline.routes, "A new route starts at the current floor: record it.");
	cmp("redirectOnly", totals.redirectOnly, baseline.redirectOnly, "Record it.");
	cmp("real", totals.real, baseline.real, "Record it.");
	for (const id of PREDICATES) {
		cmpSet(`${id}.fail`, tallied[id].fail, baseline.predicates[id].fail, "Fix the page, do not add the line.");
		cmpSet(`${id}.na`, tallied[id].na, baseline.predicates[id].na, "An N/A that grows is a predicate being escaped.");
	}
	return problems;
}

/** The YAML the current tree would need — printed, never written. */
function renderBaseline(tallied, totals) {
	const lines = [
		"# SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>",
		"# SPDX-License-Identifier: AGPL-3.0-only",
		"#",
		"# The route-state ratchet: RUBRIC.md predicates S1-S4 and T1-T4, scored over the private",
		"# console route set by `node scripts/check-route-states.mjs`.",
		"#",
		"# EVERY LINE HERE IS CHECKED IN BOTH DIRECTIONS, AS A SET. A route that appears is a",
		"# regression; a route that stops failing without this file changing in the SAME commit is",
		"# also a failure, because a stale baseline has stopped measuring the thing it names and the",
		"# next regression back into that line reports green. The members are recorded rather than",
		"# the counts because counts cancel: one fix and one new defect in the same predicate leave",
		"# the integer where it was. `na` carries its reason for the reason RUBRIC.md gives — a",
		"# predicate being escaped must not be able to happen quietly.",
		"#",
		"# `node scripts/check-route-states.mjs --print-baseline` prints what the tree scores today.",
		"# It prints; it never writes. Regenerating this file over a red run is how a ratchet becomes",
		"# a rubber stamp — read the diff and only accept lines your change actually moved.",
		"version: 1",
		`routes: ${totals.routes}`,
		`redirectOnly: ${totals.redirectOnly}`,
		`real: ${totals.real}`,
		"predicates:",
	];
	for (const id of PREDICATES) {
		lines.push(`  ${id}:`);
		for (const key of ["fail", "na"]) {
			const entries = tallied[id][key];
			if (entries.length === 0) {
				lines.push(`    ${key}: []`);
				continue;
			}
			lines.push(`    ${key}:`);
			for (const entry of entries) lines.push(`      - ${entry}`);
		}
	}
	return lines.join("\n") + "\n";
}

// ── the layout boundary-escape invariant ─────────────────────────────────────────────────────

/**
 * The `not-found` boundary file in ONE directory, by filename, or null when it holds none.
 *
 * The extension list is the manifest's `PAGE_EXTENSIONS`, imported rather than retyped: a second
 * copy stops matching the day the first one changes, and it does so in the quiet direction —
 * "no boundary file here" reads as "nothing to report" and this whole invariant goes green.
 *
 * @param {string} dirAbs
 * @returns {string|null}
 */
function notFoundFileIn(dirAbs) {
	for (const ext of PAGE_EXTENSIONS) {
		if (existsSync(path.join(dirAbs, `not-found.${ext}`))) return `not-found.${ext}`;
	}
	return null;
}

/**
 * Every layout that calls `notFound()`, and whether anything can catch that throw.
 *
 * ── THE MECHANISM, SO THE RULE IS NOT MISTAKEN FOR A STYLE PREFERENCE ────────────────────────
 *
 * `create-component-tree.js` builds a segment's `not-found` element and passes it ONLY to the
 * `children` parallel route (`const notFoundComponent = isChildrenRouteKey ? notFoundElement :
 * undefined`). So a segment's own `not-found.tsx` mounts INSIDE that segment's layout, wrapping
 * what the layout renders as `{children}`. A `notFound()` thrown by the layout itself is thrown
 * outside that wrapper and cannot be caught by it — it unwinds to the nearest boundary at a
 * segment strictly ABOVE, and, absent one, to the root `app/not-found.tsx`.
 *
 * ── WHY "THE PARENT SEGMENT", AND NOT "SOME ANCESTOR" ────────────────────────────────────────
 *
 * `app/not-found.tsx` exists and always will, so "some ancestor has one" is satisfied by every
 * layout in the tree and the predicate can never fire. That is exactly the state `[org]` shipped
 * in: a root boundary answered, the org-specific page one segment down was unreachable, and the
 * user was told "Page not found" for a URL whose org simply did not resolve. The parent segment is
 * the nearest place a boundary CAN be put for this layout, so it is where one has to be.
 *
 * The escapes this leaves are all healthy: stop throwing from the layout (#3880's shape, where
 * the pages below guard themselves), or put a `not-found.tsx` at the segment above (#3891's, where
 * 38 pages do not). Neither deepens the defect. Deleting the layout's own `not-found.tsx` does not
 * silence it, because the own-segment file is not what is being looked for.
 *
 * @param {{routes: {layoutChain: string[]}[], appDir: string}} manifest
 * @param {string} repoRoot
 * @returns {{scanned: string[], throwing: string[], escapes: string[]}}
 */
export function layoutBoundaryEscapes(manifest, repoRoot) {
	const scanned = [...new Set(manifest.routes.flatMap((r) => r.layoutChain))].sort();
	// "No layouts" is not "no findings". Every private route renders through at least the root
	// layout, so an empty set means the record's layoutChain stopped being populated and this
	// invariant has quietly stopped reading anything at all.
	if (scanned.length === 0) {
		throw new Error(
			"no layout appears in any route's layoutChain — the manifest has stopped reporting " +
				"layouts, so this invariant would report a clean tree over nothing.",
		);
	}
	/** @type {string[]} */
	const throwing = [];
	/** @type {string[]} */
	const escapes = [];
	for (const layoutRel of scanned) {
		const src = readStripped(path.join(repoRoot, layoutRel));
		if (src === null) {
			throw new Error(`${layoutRel}: named in a route's layoutChain but not readable`);
		}
		// The same matcher `callsNotFound` uses on a page, for the same reason: `notFound` is only
		// ever the navigation helper, and matching the call rather than the import survives a
		// re-export or an aliased import of something else from `next/navigation`.
		if (!/\bnotFound\s*\(/.test(src)) continue;
		throwing.push(layoutRel);

		const ownDir = path.dirname(layoutRel); // the segment this layout governs
		const parentDir = path.dirname(ownDir); // the segment whose boundary could catch it
		const atAppRoot = path.resolve(repoRoot, ownDir) === path.resolve(repoRoot, manifest.appDir);
		const caught = atAppRoot ? null : notFoundFileIn(path.join(repoRoot, parentDir));
		if (caught !== null) continue;

		// What DOES answer, so the report names the page the user actually sees rather than only
		// the one they do not. Walk strictly above the layout's own segment, up to `app/`.
		/** @type {string|null} */
		let answers = null;
		let cursor = atAppRoot ? null : parentDir;
		while (cursor !== null) {
			const hit = notFoundFileIn(path.join(repoRoot, cursor));
			if (hit !== null) {
				answers = path.join(cursor, hit);
				break;
			}
			if (path.resolve(repoRoot, cursor) === path.resolve(repoRoot, manifest.appDir)) break;
			cursor = path.dirname(cursor);
		}
		const own = notFoundFileIn(path.join(repoRoot, ownDir));
		const under = manifest.routes.filter((r) => r.layoutChain.includes(layoutRel)).length;
		escapes.push(
			`${layoutRel} calls notFound(), and ${parentDir} has no not-found.tsx — the throw is ` +
				`raised OUTSIDE the boundary this segment's own file provides` +
				(own === null ? "" : ` (${path.join(ownDir, own)}, which cannot catch it)`) +
				`, so ${answers === null ? "Next's built-in not-found" : answers} answers instead, on ` +
				`${under} route${under === 1 ? "" : "s"}. Put a not-found.tsx at ${parentDir}, or stop ` +
				`throwing here and let the pages below call notFound() themselves.`,
		);
	}
	return { scanned, throwing, escapes };
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────

/** Score one tree. Never catches the manifest's raises — a zero-route tree must not report green. */
export function runOver(repoRoot) {
	const manifest = collectConsoleRoutes({ repoRoot });
	const contexts = buildContexts(manifest, repoRoot);
	const scored = score(contexts);
	const redirectOnly = manifest.routes.filter((r) => r.isRedirectOnly).length;
	return {
		manifest,
		contexts,
		scored,
		tallied: tally(scored),
		escapes: layoutBoundaryEscapes(manifest, repoRoot),
		totals: {
			routes: manifest.routes.length,
			redirectOnly,
			real: manifest.routes.length - redirectOnly,
		},
	};
}

// ── the permanent positive control ───────────────────────────────────────────────────────────

const put = (root, rel, body) => {
	const full = path.join(root, rel);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, body);
};

const PAGE = (extra = "") => `${extra}export default function P() { return <div />; }\n`;
const META = 'export const metadata = { title: "T" };\n';
const REDIRECT =
	"import { redirect } from 'next/navigation';\nexport default function R() { redirect('/x'); }\n";

/**
 * A tree in which every predicate has a route it MUST fail.
 *
 * There is no `app/error.tsx` — that is what lets T2 fail at all. Every route here consequently
 * fails T2; only the designated assertions below are checked, so that is harmless.
 */
function buildProbeTree() {
	const root = mkdtempSync(path.join(tmpdir(), "route-states-probe-"));
	put(root, "apps/console/components/shell/app-shell.tsx",
		'export function AppShell({ children }) { return <div className="mx-auto w-full max-w-[1200px]">{children}</div>; }\n');
	put(root, "apps/console/components/plain/plain-shell.tsx",
		"export function PlainShell({ children }) { return <div className=\"p-6\">{children}</div>; }\n");
	put(root, "apps/console/components/narrow/narrow-shell.tsx",
		'export function NarrowShell({ children }) { return <div className="mx-auto w-full max-w-[800px]">{children}</div>; }\n');
	put(root, "apps/console/app/layout.tsx", "export default function L({ children }) { return <div>{children}</div>; }\n");
	put(root, "apps/console/app/(private)/layout.tsx", "export default function PL({ children }) { return <div>{children}</div>; }\n");
	// THE BOUNDARY-ESCAPE PROBE, half one: a ROOT not-found.tsx that exists. Without it, an
	// implementation asking "does SOME ancestor have one" would report the escape below anyway and
	// the control could not tell the two rules apart — and "some ancestor" is the rule that scores
	// the real console green, because `app/not-found.tsx` is always there.
	put(root, "apps/console/app/not-found.tsx", "export default function RNF() { return <div />; }\n");
	// S1 · T2 · T4 — no shell above it, no error boundary anywhere, no metadata.
	put(root, "apps/console/app/(private)/loose/page.tsx", PAGE());
	// S2, branch "the shell declares no width".
	put(root, "apps/console/app/(private)/plain/layout.tsx",
		"import { PlainShell } from '@/components/plain/plain-shell';\nexport default function X({ children }) { return <PlainShell>{children}</PlainShell>; }\n");
	put(root, "apps/console/app/(private)/plain/page.tsx", META + PAGE());
	// S4, branch "the page hand-rolls a width a shell owns" IN ISOLATION — PlainShell owns none, so
	// the other branch cannot fire and a mutation that deletes this one is caught here and only here.
	put(root, "apps/console/app/(private)/plain/copy/page.tsx",
		META + 'export default function C() { return <div className="mx-auto max-w-[1200px]" />; }\n');
	// THE BOUNDARY-ESCAPE PROBE, half two: the console's own pre-#3891 shape. The layout throws,
	// `(private)` above it holds no not-found.tsx, and the segment's OWN not-found.tsx below is
	// exactly the file that cannot catch it. An implementation that credited the own-segment file,
	// or any ancestor, reports nothing here.
	put(root, "apps/console/app/(private)/[org]/layout.tsx",
		"import { AppShell } from '@/components/shell/app-shell';\nimport { notFound } from 'next/navigation';\nexport default function O({ children, ok }) { if (!ok) notFound(); return <AppShell>{children}</AppShell>; }\n");
	put(root, "apps/console/app/(private)/[org]/not-found.tsx", "export default function NF() { return <div />; }\n");
	// S2, branch "the page declares its own on top of the shell's".
	put(root, "apps/console/app/(private)/[org]/wide/page.tsx",
		META + 'export default function W() { return <div className="mx-auto max-w-4xl" />; }\n');
	// S3 — an inherited skeleton renders inside a DIFFERENT shell from the page it covers.
	// `[org]/loading.tsx` sits at `[org]`, so it replaces everything below `[org]/layout.tsx` and
	// renders inside AppShell (1200px) — NOT inside the NarrowShell (800px) that wraps the page.
	// This is `~/settings/classification`'s shape, and it is the only fixture that separates
	// "credit the skeleton with the shell IT renders inside" from "credit it with the page's".
	put(root, "apps/console/app/(private)/[org]/loading.tsx", "export default function OL() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/inner/layout.tsx",
		"import { NarrowShell } from '@/components/narrow/narrow-shell';\nexport default function I({ children }) { return <NarrowShell>{children}</NarrowShell>; }\n");
	put(root, "apps/console/app/(private)/[org]/inner/page.tsx", META + PAGE());
	// S3 — the skeleton is a different width from the page.
	put(root, "apps/console/app/(private)/[org]/skew/page.tsx", META + PAGE());
	put(root, "apps/console/app/(private)/[org]/skew/loading.tsx",
		'export default function S() { return <div className="mx-auto max-w-3xl" />; }\n');
	// S4 — the page hand-rolls the width the shell already owns.
	put(root, "apps/console/app/(private)/[org]/dup/page.tsx",
		META + 'export default function D() { return <div className="mx-auto max-w-[1200px]" />; }\n');
	// T1 — a real list page's skeleton, inherited by the detail page below it.
	put(root, "apps/console/app/(private)/[org]/list/page.tsx", META + PAGE());
	put(root, "apps/console/app/(private)/[org]/list/loading.tsx", "export default function LS() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/list/detail/page.tsx", META + PAGE());
	// T3 — calls notFound(), and the nearest not-found.tsx is scoped to [org], not to [thing].
	put(root, "apps/console/app/(private)/[org]/[thing]/page.tsx",
		META + "import { notFound } from 'next/navigation';\nexport default function T() { notFound(); return <div />; }\n");
	// T3's PLACEMENT half — the shape the old rule scored as a PASS and #3880 found. The LAYOUT at
	// the innermost dynamic segment throws, and a not-found.tsx sits right beside it. That file is
	// handed to the segment's CHILDREN slot, so it mounts inside the very layout that throws and
	// can never catch it; a boundary above `[res]` could catch it but would answer for `[org]`.
	// A rule that only asked "is the nearest not-found.tsx at or below the innermost param dir"
	// passes this route, which is the whole defect.
	put(root, "apps/console/app/(private)/[org]/sec/[res]/layout.tsx",
		"import { notFound } from 'next/navigation';\nexport default function RL({ children }) { notFound(); return <div>{children}</div>; }\n");
	put(root, "apps/console/app/(private)/[org]/sec/[res]/not-found.tsx", "export default function RNF() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/sec/[res]/page.tsx",
		META + "import { notFound } from 'next/navigation';\nexport default function R() { notFound(); return <div />; }\n");
	// The SAME defect one level below the resource segment, which is the branch that is NOT the
	// unsatisfiable one: `[thing]/sub/layout.tsx` throws and `[thing]/sub/not-found.tsx` sits in
	// the same directory, so the scope half passes (it is below `[thing]`) and the placement half
	// still fails — a boundary at `[thing]` WOULD have caught this one. Without this fixture the
	// "strictly above" arm of the rule is never driven, and only the unsatisfiable arm is.
	put(root, "apps/console/app/(private)/[org]/[thing]/sub/layout.tsx",
		"import { notFound } from 'next/navigation';\nexport default function SL({ children }) { notFound(); return <div>{children}</div>; }\n");
	put(root, "apps/console/app/(private)/[org]/[thing]/sub/not-found.tsx", "export default function SNF() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/[thing]/sub/page.tsx",
		META + "import { notFound } from 'next/navigation';\nexport default function S() { notFound(); return <div />; }\n");
	return root;
}

/** A tree in which every predicate has a route it MUST pass. */
function buildAntiProbeTree() {
	const root = mkdtempSync(path.join(tmpdir(), "route-states-anti-"));
	put(root, "apps/console/components/shell/app-shell.tsx",
		'export function AppShell({ children }) { return <div className="mx-auto w-full max-w-[1200px]">{children}</div>; }\n');
	put(root, "apps/console/app/layout.tsx", "export default function L({ children }) { return <div>{children}</div>; }\n");
	put(root, "apps/console/app/error.tsx", "export default function E() { return <div />; }\n");
	put(root, "apps/console/app/(private)/layout.tsx", "export default function PL({ children }) { return <div>{children}</div>; }\n");
	// The org layout THROWS, exactly as the console's does. Two separate rules are controlled by
	// this one file, and both statements have to survive together.
	//
	// #3890's: the throw escapes `[org]/not-found.tsx` by the same mechanism as every other
	// layout's, and it is out of frame for every route below `[org]` whose own innermost segment
	// is deeper. That is the control on bound 2 in the header — a rule that read the whole layout
	// chain instead of the part at or below the route's frame would fail `/[org]/[thing]` here for
	// a defect belonging to `[org]`.
	//
	// #3933's: this is also the boundary-escape antiprobe, so it carries the one file that FIXES
	// the escape — a not-found.tsx at the segment ABOVE. Without it the per-layout invariant fails
	// on the tree whose entire purpose is that every predicate passes. There is deliberately no
	// ROOT not-found.tsx, so the invariant cannot be passing by finding that one instead; and the
	// segment's own not-found.tsx below is present too, because having one does not make a
	// layout's throw catchable and must not make it un-reportable either.
	put(root, "apps/console/app/(private)/not-found.tsx", "export default function PNF() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/layout.tsx",
		"import { notFound } from 'next/navigation';\nimport { AppShell } from '@/components/shell/app-shell';\nexport default function O({ children }) { if (!children) notFound(); return <AppShell>{children}</AppShell>; }\n");
	put(root, "apps/console/app/(private)/[org]/loading.tsx", "export default function LS() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/not-found.tsx", "export default function NF() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/page.tsx", META + PAGE());
	// T3 — a not-found.tsx scoped to the resource whose slug the page resolves.
	put(root, "apps/console/app/(private)/[org]/[thing]/loading.tsx", "export default function TL() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/[thing]/not-found.tsx", "export default function TNF() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/[thing]/page.tsx",
		META + "import { notFound } from 'next/navigation';\nexport default function T() { notFound(); return <div />; }\n");
	// T3's PLACEMENT half, the OTHER direction: a layout that throws is fine when the boundary is
	// STRICTLY ABOVE it. `[thing]/deep/layout.tsx` throws and `[thing]/not-found.tsx` is one
	// segment up, so it does catch — and it still names the resource `[thing]`. Without this
	// fixture "any layout in the chain calls notFound() → FAIL" would pass the control, and that
	// rule would fail every correctly-nested boundary in the tree.
	put(root, "apps/console/app/(private)/[org]/[thing]/deep/layout.tsx",
		"import { notFound } from 'next/navigation';\nexport default function DL({ children }) { notFound(); return <div>{children}</div>; }\n");
	put(root, "apps/console/app/(private)/[org]/[thing]/deep/page.tsx",
		META + "import { notFound } from 'next/navigation';\nexport default function D() { notFound(); return <div />; }\n");
	// T1 — a redirect-only segment whose loading.tsx exists only for the sub-pages beneath it.
	put(root, "apps/console/app/(private)/[org]/sect/page.tsx", REDIRECT);
	put(root, "apps/console/app/(private)/[org]/sect/loading.tsx", "export default function SL() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/sect/leaf/page.tsx", META + PAGE());
	// S3's SHELL FALLBACK, isolated. The page names the shell's width out loud and the skeleton
	// names none, so the two agree only if the skeleton is credited with the shell it renders
	// inside. An implementation that compared the declared widths alone reads 1200 against nothing
	// and fails this page; nothing else in either tree separates those two implementations.
	put(root, "apps/console/app/(private)/[org]/matchw/loading.tsx", "export default function ML() { return <div />; }\n");
	put(root, "apps/console/app/(private)/[org]/matchw/page.tsx",
		META + 'export default function M() { return <div className="mx-auto max-w-[1200px]" />; }\n');
	return root;
}

/**
 * The control that runs on EVERY invocation. Each predicate must fire against a probe it must
 * catch and stay quiet against one it must not, or this file refuses to report on the real tree.
 *
 * @returns {string[]} one line per broken control; empty means the instrument works
 */
export function positiveControl() {
	/** @type {string[]} */
	const problems = [];
	const probe = buildProbeTree();
	const anti = buildAntiProbeTree();
	try {
		const p = runOver(probe);
		const a = runOver(anti);
		const verdict = (run, route, id) => {
			const s = run.scored[id];
			if (s.fail.some((f) => f.route === route)) return "FAIL";
			if (s.pass.includes(route)) return "PASS";
			for (const [reason, routes] of Object.entries(s.na)) if (routes.includes(route)) return `N/A:${reason}`;
			return "MISSING";
		};
		const expect = (run, label, route, id, want) => {
			const got = verdict(run, route, id);
			if (got !== want) problems.push(`${label} ${id} on ${route}: expected ${want}, got ${got}`);
		};

		// ── the probes: each predicate MUST catch its violation ─────────────────────────────
		expect(p, "probe", "/loose", "S1", "FAIL");
		expect(p, "probe", "/plain", "S2", "FAIL"); // the shell declares no width
		expect(p, "probe", "/[org]/wide", "S2", "FAIL"); // the page declares its own as well
		expect(p, "probe", "/[org]/skew", "S3", "FAIL");
		expect(p, "probe", "/[org]/inner", "S3", "FAIL"); // the skeleton renders in a wider shell
		expect(p, "probe", "/plain/copy", "S4", "FAIL"); // the page hand-rolls a shell's own number
		expect(p, "probe", "/[org]/dup", "S4", "FAIL"); // the page re-declares its own shell's width
		expect(p, "probe", "/[org]/list/detail", "T1", "FAIL");
		expect(p, "probe", "/loose", "T2", "FAIL");
		expect(p, "probe", "/[org]/[thing]", "T3", "FAIL");
		// T3's placement half: a not-found.tsx BESIDE a throwing layout scores the scope half
		// perfectly and still cannot fire. This is the fixture that separates the two rules.
		expect(p, "probe", "/[org]/sec/[res]", "T3", "FAIL");
		// …and the other arm: a throwing layout BELOW the resource segment, whose own directory's
		// not-found.tsx is scoped correctly and still cannot catch it.
		expect(p, "probe", "/[org]/[thing]/sub", "T3", "FAIL");
		expect(p, "probe", "/loose", "T4", "FAIL");

		// S4's BOUNDARY, asserted in the probe tree because that is where the shape lives:
		// `/[org]/wide` declares `max-w-4xl` under a shell that owns `max-w-[1200px]`. Two widths
		// govern it, so S2 fails — but `max-w-4xl` is not a width any shell sets, so it is not the
		// DUPLICATE S4 measures. An S4 that failed here would charge one defect to two predicates,
		// and the mutation that reintroduces that is caught here and only here.
		expect(p, "probe", "/[org]/wide", "S4", "PASS");

		// ── the antiProbes: no predicate may fire on a page that does the thing ─────────────
		for (const id of ["S1", "S2", "S3", "S4", "T1", "T2", "T4"]) expect(a, "antiProbe", "/[org]", id, "PASS");
		expect(a, "antiProbe", "/[org]", "T3", "N/A:does-not-call-not-found");
		expect(a, "antiProbe", "/[org]/[thing]", "T3", "PASS"); // the PAGE throws, inside the boundary
		expect(a, "antiProbe", "/[org]/[thing]/deep", "T3", "PASS"); // a layout throws BELOW it
		expect(a, "antiProbe", "/[org]/sect/leaf", "T1", "PASS");
		expect(a, "antiProbe", "/[org]/matchw", "S3", "PASS");

		// ── the N/A control: redirect-only excuses S1–S4 and T1, and NOTHING else ──────────
		for (const id of ["S1", "S2", "S3", "S4", "T1"]) {
			expect(a, "antiProbe", "/[org]/sect", id, "N/A:redirect-only");
		}
		expect(a, "antiProbe", "/[org]/sect", "T2", "PASS");
		expect(a, "antiProbe", "/[org]/sect", "T4", "FAIL"); // "a redirect still owns a title"

		// ── the layout boundary-escape invariant: it must fire, and it must stay quiet ──────
		//
		// Both trees hold the same throwing `[org]/layout.tsx`. They differ in one file: the
		// antiProbe has `(private)/not-found.tsx` and the probe has `app/not-found.tsx` instead.
		// So this pair separates "a boundary at the parent segment" from "a boundary somewhere
		// above", which is the only distinction that matters — the second rule scores the real
		// console green while a bad org slug renders the wrong page.
		//
		// The three assertions below are MEMBERSHIP, not counts, and that is deliberate. They were
		// written as `length === 1` when `[org]/layout.tsx` was the only throwing layout in either
		// tree; #3890 then added `[org]/[thing]/sub/layout.tsx` and `[org]/sec/[res]/layout.tsx` to
		// drive ITS rule, and an exact count made this fail for a reason that has nothing to do
		// with what it measures. The property was never "there is exactly one" — it is "the one
		// this invariant exists for is found, and its escape is reported". A count is a statement
		// about the fixture; membership is a statement about the matcher.
		//
		// The quiet branch below stays EXACT (`=== 0`), because there the count IS the property:
		// one spurious report is the whole failure.
		const escapeAt = path.join("apps", "console", "app", "(private)", "[org]", "layout.tsx");
		if (!p.escapes.throwing.includes(escapeAt)) {
			problems.push(
				`probe boundary-escape: expected ${escapeAt} among the layouts calling notFound(), got ` +
					`[${p.escapes.throwing.join(", ")}] — the layout matcher has stopped matching`,
			);
		}
		if (!p.escapes.escapes.some((e) => e.startsWith(escapeAt))) {
			problems.push(
				`probe boundary-escape: expected an escape reported at ${escapeAt}, got ` +
					`${p.escapes.escapes.length}: [${p.escapes.escapes.join(" | ")}]`,
			);
		}
		// Membership on the SAME file as above, not a bare count. `length >= 1` would be satisfied
		// by #3890's other throwing layouts even if the one this invariant exists for were deleted
		// from the fixed tree — a green that proves nothing about the quiet branch, which is the
		// exact shape this whole rule was written to catch.
		if (!a.escapes.throwing.includes(escapeAt)) {
			problems.push(
				`antiProbe boundary-escape: the fixed tree must still hold the throwing ${escapeAt}, ` +
					`or the quiet branch below proves nothing — got [${a.escapes.throwing.join(", ")}]`,
			);
		}
		if (a.escapes.escapes.length !== 0) {
			problems.push(
				`antiProbe boundary-escape: a layout whose PARENT segment holds a not-found.tsx must ` +
					`not be reported — got [${a.escapes.escapes.join(" | ")}]`,
			);
		}
	} finally {
		for (const d of [probe, anti]) rmSync(d, { recursive: true, force: true });
	}
	return problems;
}

// ── reporting ────────────────────────────────────────────────────────────────────────────────

function report(run, { routes = false } = {}) {
	const { scored, tallied, totals, escapes } = run;
	console.log(
		`${totals.routes} private routes · ${totals.redirectOnly} redirect-only · ${totals.real} real pages`,
	);
	// Stated on every run, green included: "0 escapes" and "the scan read nothing" have to look
	// different, so the counts it examined are printed rather than only the findings.
	console.log(
		`${escapes.scanned.length} layouts · ${escapes.throwing.length} call notFound() · ` +
			`${escapes.escapes.length} boundary escape(s)\n`,
	);
	console.log("  id   PASS  FAIL   N/A   score  predicate");
	for (const id of PREDICATES) {
		const t = tallied[id];
		const denom = t.pass + t.fail.length;
		const s = denom === 0 ? "  —  " : (t.pass / denom).toFixed(2);
		console.log(
			`  ${id}  ${String(t.pass).padStart(4)}  ${String(t.fail.length).padStart(4)}  ${String(t.na.length).padStart(4)}   ${s}   ${TITLES[id]}`,
		);
	}
	for (const id of PREDICATES) {
		if (scored[id].fail.length === 0) continue;
		console.log(`\n${id} — ${TITLES[id]}`);
		for (const f of scored[id].fail) console.log(`  FAIL ${f.route.padEnd(38)} ${f.detail}`);
	}
	for (const id of PREDICATES) {
		const reasons = Object.entries(scored[id].na);
		if (reasons.length === 0) continue;
		console.log(
			`\n${id} N/A: ${reasons.map(([r, xs]) => `${r}=${xs.length}`).join(", ")}`,
		);
	}
	if (escapes.escapes.length > 0) {
		console.log("\nlayout boundary escapes — a notFound() nothing at or above the segment can catch");
		for (const line of escapes.escapes) console.log(`  FAIL ${line}`);
	}
	if (routes) {
		console.log("\nroute × predicate");
		for (const c of run.contexts) {
			const cells = PREDICATES.map((id) => {
				const r = CHECKS[id](c);
				return `${id}:${r.verdict === "N/A" ? "n/a" : r.verdict === "PASS" ? "ok " : "FAIL"}`;
			});
			console.log(`  ${c.record.route.padEnd(38)} ${cells.join(" ")}`);
		}
	}
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────

function selfTest() {
	let failures = 0;
	const ok = (label, cond) => {
		console.log(`${cond ? "ok  " : "FAIL"} - ${label}`);
		if (!cond) failures++;
	};
	const raises = (label, fn, needle) => {
		try {
			fn();
			console.log(`FAIL - ${label} (did not raise)`);
			failures++;
		} catch (err) {
			const hit = !needle || err.message.includes(needle);
			console.log(`${hit ? "ok  " : "FAIL"} - ${label}${hit ? "" : ` (wrong message: ${err.message})`}`);
			if (!hit) failures++;
		}
	};

	// The positive control is the self-test's first assertion as well as every run's. Reported
	// per-line here so a broken instrument names the predicate that stopped firing.
	const control = positiveControl();
	ok(`the positive control is intact (${control.length} problems)`, control.length === 0);
	for (const line of control) console.log(`     ${line}`);

	// ── N/A discipline ──────────────────────────────────────────────────────────────────────
	ok(
		"every N/A reason a predicate can return is in its declared set",
		PREDICATES.every((id) => Array.isArray(NA_REASONS[id])),
	);
	ok("T2 and T4 declare NO N/A reason at all", NA_REASONS.T2.length === 0 && NA_REASONS.T4.length === 0);
	// Driven by REPLACING a predicate with one that invents a reason, because that is the actual
	// shape of the defect being guarded against: somebody adds an N/A branch nobody declared, the
	// page stops failing, and the score goes UP because the denominator went down. Asserting the
	// declaration list matches itself would prove nothing; this proves `score()` refuses.
	/** A redirect-only stub: N/A for S1–S4 and T1, scored for T2 and T4. */
	const stub = () => [
		{
			record: {
				route: "/x",
				isRedirectOnly: true,
				shell: null,
				hasMetadata: true,
				segments: [],
				boundaries: {
					loading: { file: null, own: false, distance: null },
					error: { file: "apps/console/app/error.tsx", distance: 0 },
					"not-found": { file: null, own: false, distance: null },
				},
			},
			shellWidth: null,
			shellOwnedWidths: new Set(),
			pageWidth: null,
			pageWidthSites: [],
			loadingWidth: null,
			loadingShellWidth: null,
			loadingOwnerIsOwnPage: false,
			callsNotFound: false,
			innermostParamDir: null,
			notFoundThrowingLayouts: [],
		},
	];
	const withCheck = (id, impl, fn) => {
		const real = CHECKS[id];
		CHECKS[id] = impl;
		try {
			return fn();
		} finally {
			CHECKS[id] = real;
		}
	};
	ok("the stub scores cleanly with the real predicates", score(stub()).S1.na["redirect-only"].length === 1);
	raises(
		"an undeclared N/A reason is an ERROR, not an N/A",
		() => withCheck("S1", () => NA("this-page-is-hard"), () => score(stub())),
		"not in its declared set",
	);
	raises(
		"a never-N/A predicate refuses even a reason another predicate declares",
		() => withCheck("T2", () => NA("redirect-only"), () => score(stub())),
		"this predicate is never N/A",
	);

	// ── the baseline parser ─────────────────────────────────────────────────────────────────
	/** A tally in the shape `tally()` returns: two routes failing, one N/A that every predicate allows. */
	const fixtureTally = () =>
		Object.fromEntries(
			PREDICATES.map((id) => [
				id,
				{
					pass: 1,
					fail: ["/a", "/b"],
					na: NA_REASONS[id].length === 0 ? [] : [`/c: ${NA_REASONS[id][0]}`],
				},
			]),
		);
	const good = renderBaseline(fixtureTally(), { routes: 40, redirectOnly: 4, real: 36 });
	const parsed = parseBaseline(good, "fixture");
	ok(
		"a well-formed baseline round-trips",
		parsed.routes === 40 && parsed.predicates.S3.na[0] === "/c: redirect-only" && parsed.predicates.T4.na.length === 0,
	);
	raises("a missing predicate RAISES", () => parseBaseline(good.replace(/  T4:\n(?:    \w+: \[\]\n|    \w+:\n(?:      - .*\n)+)+/, ""), "fixture"), "missing predicate T4");
	raises("an unknown predicate RAISES", () => parseBaseline(good + "  S9:\n    fail: []\n    na: []\n", "fixture"), "unknown predicate");
	raises("an unknown top-level key RAISES", () => parseBaseline(good + "extra: 1\n", "fixture"), 'unknown key "extra"');
	raises("a non-integer top-level scalar RAISES", () => parseBaseline(good.replace("routes: 40", "routes: forty"), "fixture"), "non-negative integer");
	raises("a COUNT where a list belongs RAISES", () => parseBaseline(good.replace("    fail:\n", "    fail: 2\n"), "fixture"), "takes a list");
	raises("a duplicated route RAISES", () => parseBaseline(good.replace("      - /b\n", "      - /a\n"), "fixture"), 'appears twice');
	raises(
		"an N/A reason the predicate does not declare RAISES",
		() => parseBaseline(good.replace("/c: redirect-only", "/c: this-page-is-hard"), "fixture"),
		"declares no N/A reason",
	);
	raises("a truncated file RAISES rather than defaulting", () => parseBaseline("version: 1\n", "fixture"), 'missing "routes"');
	raises("an empty file RAISES", () => parseBaseline("", "fixture"), 'missing "version"');

	// ── the ratchet, in BOTH directions ─────────────────────────────────────────────────────
	const base = parseBaseline(good, "fixture");
	const flat = fixtureTally();
	const totals = { routes: 40, redirectOnly: 4, real: 36 };
	ok("an unchanged tree is clean", compareToBaseline(base, flat, totals).length === 0);
	const worse = { ...flat, S2: { pass: 0, fail: ["/a", "/b", "/d"], na: flat.S2.na } };
	const grewProblems = compareToBaseline(base, worse, totals);
	ok(
		"one MORE failing route is a REGRESSION, and it is NAMED",
		grewProblems.length === 1 && grewProblems[0].includes("S2.fail") && grewProblems[0].includes("/d") && grewProblems[0].includes("REGRESSION"),
	);
	const better = { ...flat, S2: { pass: 2, fail: ["/a"], na: flat.S2.na } };
	const shrankProblems = compareToBaseline(base, better, totals);
	ok(
		"one FEWER failing route ALSO fails, demanding the line be deleted",
		shrankProblems.length === 1 && shrankProblems[0].includes("/b") && shrankProblems[0].includes("Delete the line"),
	);
	// THE REASON THE BASELINE NAMES ITS MEMBERS. A count-based ratchet reads this as 2 = 2 and
	// reports green with a new defect landed; that is the both-directions check being cancelled by
	// arithmetic, and it is the only assertion here a set is needed for.
	const swapped = { ...flat, S2: { pass: 1, fail: ["/a", "/d"], na: flat.S2.na } };
	const swappedProblems = compareToBaseline(base, swapped, totals);
	ok(
		"a fix and a regression in the SAME predicate do not cancel",
		swappedProblems.some((p) => p.includes("REGRESSION") && p.includes("/d")) &&
			swappedProblems.some((p) => p.includes("IMPROVEMENT") && p.includes("/b")),
	);
	const escaped = { ...flat, T3: { pass: 1, fail: ["/a"], na: ["/c: does-not-call-not-found", "/b: does-not-call-not-found"] } };
	const escapedProblems = compareToBaseline(base, escaped, totals);
	ok(
		"an N/A that GROWS fails, even though the FAIL count fell",
		escapedProblems.some((p) => p.includes("T3.na") && p.includes("REGRESSION")) &&
			escapedProblems.some((p) => p.includes("T3.fail")),
	);
	// A route keeping its N/A but swapping the reason is the same escape one level down.
	const rereasoned = { ...flat, S3: { pass: 1, fail: flat.S3.fail, na: ["/c: no-loading-boundary"] } };
	ok(
		"an N/A route that CHANGES its reason is not silent",
		compareToBaseline(base, rereasoned, totals).some((p) => p.includes("S3.na") && p.includes("no-loading-boundary")),
	);
	ok(
		"a route added without recording it fails",
		compareToBaseline(base, flat, { ...totals, routes: 41 }).some((p) => p.startsWith("routes:")),
	);

	// ── the boundary-escape invariant's own silent-green branch ──────────────────────────────
	//
	// Every other assertion about it lives in the positive control, which runs on every
	// invocation. This one cannot: it is the branch where the invariant reads NOTHING, and the
	// probe trees always give it something to read. A manifest whose records stopped carrying a
	// layoutChain would otherwise hand back `escapes: []` — indistinguishable from a clean tree.
	raises(
		"a manifest with no layouts RAISES rather than reporting zero escapes",
		() => layoutBoundaryEscapes({ routes: [], appDir: path.join("apps", "console", "app") }, REPO_ROOT),
		"stopped reporting layouts",
	);
	raises(
		"a layoutChain naming a file that is not there RAISES rather than skipping it",
		() =>
			layoutBoundaryEscapes(
				{ routes: [{ layoutChain: [path.join("apps", "console", "app", "no-such-layout.tsx")] }], appDir: path.join("apps", "console", "app") },
				REPO_ROOT,
			),
		"not readable",
	);

	// ── the manifest's zero-route raise is NOT caught into a green ───────────────────────────
	const emptyRoot = mkdtempSync(path.join(tmpdir(), "route-states-empty-"));
	mkdirSync(path.join(emptyRoot, "apps", "console", "app", "(private)"), { recursive: true });
	mkdirSync(path.join(emptyRoot, "apps", "console", "components"), { recursive: true });
	writeFileSync(
		path.join(emptyRoot, "apps", "console", "components", "s.tsx"),
		"export function AppShell() { return null; }",
	);
	raises(
		"a zero-route manifest RAISES out of runOver rather than scoring 0/0 green",
		() => runOver(emptyRoot),
		"broken scan, not an empty app",
	);
	rmSync(emptyRoot, { recursive: true, force: true });

	// ── width resolution, on fixtures that separate right from wrong ─────────────────────────
	const wRoot = mkdtempSync(path.join(tmpdir(), "route-states-width-"));
	put(wRoot, "a.tsx", 'const x = <div className="mx-auto max-w-3xl" />;\n');
	put(wRoot, "b.tsx", 'const x = <td className="max-w-[380px] truncate" />;\n');
	put(wRoot, "c.tsx", 'const x = <div className="relative mx-auto max-w-4xl px-2 pt-14" />;\n');
	put(wRoot, "d.tsx", '// <div className="mx-auto max-w-2xl" />\nconst x = 1;\n');
	ok("a centred container is a width", widthsIn(path.join(wRoot, "a.tsx"))[0] === "max-w-3xl");
	ok("a truncating cell is NOT a width", widthsIn(path.join(wRoot, "b.tsx")).length === 0);
	ok(
		"a container without w-full is still a width",
		widthsIn(path.join(wRoot, "c.tsx"))[0] === "max-w-4xl",
	);
	ok("a commented-out container is not a width", widthsIn(path.join(wRoot, "d.tsx")).length === 0);
	// An apostrophe in JSX TEXT used to pair with the opening quote of the next `className`, and
	// every width below it in the file vanished — a page reading as "sets no width" PASSES S4 and
	// can PASS S3, so the miss is silent. The two files differ in exactly that apostrophe.
	put(wRoot, "e.tsx", '<p>You don\'t have any projects</p>\n<div className="mx-auto w-full max-w-4xl" />\n');
	put(wRoot, "f.tsx", '<p>You do not have any projects</p>\n<div className="mx-auto w-full max-w-4xl" />\n');
	ok(
		"an apostrophe in JSX text does not hide the widths below it",
		widthsIn(path.join(wRoot, "e.tsx"))[0] === "max-w-4xl" &&
			widthsIn(path.join(wRoot, "f.tsx"))[0] === "max-w-4xl",
	);
	// A two-part scale collapsing to its first segment made two DIFFERENT widths compare equal,
	// which is S3 passing the mismatched skeleton it exists to catch.
	put(wRoot, "g.tsx", 'const x = <div className="mx-auto max-w-screen-lg" />;\n');
	put(wRoot, "h.tsx", 'const x = <div className="mx-auto max-w-screen-sm" />;\n');
	ok(
		"a two-part width scale keeps both of its segments",
		widthsIn(path.join(wRoot, "g.tsx"))[0] === "max-w-screen-lg" &&
			widthsIn(path.join(wRoot, "h.tsx"))[0] === "max-w-screen-sm",
	);
	put(wRoot, "i.tsx", 'const x = <div className="mx-auto max-w-[calc(100% - 2rem)] p-4" />;\n');
	ok(
		"an arbitrary value containing spaces is one width, not none",
		widthsIn(path.join(wRoot, "i.tsx"))[0] === "max-w-[calc(100% - 2rem)]",
	);
	put(wRoot, "j.tsx", 'const x = <div className="mx-auto lg:max-w-[1200px]" />;\n');
	ok(
		"a variant prefix is not part of the width",
		widthsIn(path.join(wRoot, "j.tsx"))[0] === "max-w-[1200px]",
	);
	rmSync(wRoot, { recursive: true, force: true });

	console.log(failures === 0 ? "\nself-test: all passed" : `\nself-test: ${failures} FAILED`);
	return failures === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

export const USAGE = [
	"Usage: node scripts/check-route-states.mjs [--json|--routes|--print-baseline|--self-test|--help]",
	"",
	"  (no argument)     score the private route set against apps/console/route-states-baseline.yaml",
	"  --json            the scoring as JSON",
	"  --routes          add a route × predicate grid to the report",
	"  --print-baseline  print the baseline the current tree would need (never writes it)",
	"  --self-test       run the fixture suite; exit 1 on any failure",
	"  --help, -h        this text",
].join("\n");

/**
 * The whole argument parser. An unrecognised argument is an ERROR (exit 2), never a fall-through
 * to the default mode — the same rule, and the same reason, as `console-routes.mjs`: a caller's
 * typo must not be indistinguishable from a successful run.
 */
export function parseCliArgs(argv) {
	const MODES = {
		"--json": "json",
		"--routes": "routes",
		"--print-baseline": "print-baseline",
		"--self-test": "self-test",
		"--help": "help",
		"-h": "help",
	};
	if (argv.length === 0) return { mode: "check", error: null };
	const unknown = argv.filter((a) => !(a in MODES));
	if (unknown.length > 0) {
		return { mode: null, error: `unrecognised argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}` };
	}
	if (argv.some((a) => MODES[a] === "help")) return { mode: "help", error: null };
	const distinct = [...new Set(argv.map((a) => MODES[a]))];
	if (distinct.length > 1) return { mode: null, error: `${distinct.join(" and ")} cannot both be asked for` };
	return { mode: distinct[0], error: null };
}

const invokedDirectly =
	process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
	const parsed = parseCliArgs(process.argv.slice(2));
	if (parsed.error !== null) {
		console.error(`check-route-states: ${parsed.error}\n\n${USAGE}`);
		process.exit(2);
	}
	if (parsed.mode === "help") {
		console.log(USAGE);
		process.exit(0);
	}
	if (parsed.mode === "self-test") {
		try {
			process.exit(selfTest());
		} catch (err) {
			console.error(`\nFAIL - the self-test raised before it could report: ${err.message}`);
			console.error("self-test: 1 FAILED");
			process.exit(1);
		}
	}

	// The instrument first, always. A predicate that has stopped firing must not be allowed to
	// report a clean tree.
	const control = positiveControl();
	if (control.length > 0) {
		console.error("check-route-states: THE POSITIVE CONTROL IS BROKEN — refusing to score the tree.\n");
		for (const line of control) console.error(`  ${line}`);
		console.error(
			"\nA predicate that no longer fires cannot tell a clean tree from a tree it stopped reading.",
		);
		process.exit(1);
	}

	const run = runOver(REPO_ROOT);

	if (parsed.mode === "print-baseline") {
		process.stdout.write(renderBaseline(run.tallied, run.totals));
		process.exit(0);
	}
	if (parsed.mode === "json") {
		console.log(
			JSON.stringify(
				{ totals: run.totals, tallied: run.tallied, scored: run.scored, escapes: run.escapes },
				null,
				"\t",
			),
		);
		process.exit(0);
	}

	report(run, { routes: parsed.mode === "routes" });

	const baselinePath = path.join(REPO_ROOT, BASELINE_FILE);
	let baseline;
	try {
		baseline = parseBaseline(readFileSync(baselinePath, "utf8"), BASELINE_FILE);
	} catch (err) {
		console.error(`\ncheck-route-states: ${err.message}`);
		console.error(
			`\nThe baseline is the gate. An unreadable one is not "no findings" — run ` +
				`\`node scripts/check-route-states.mjs --print-baseline\` and reconcile it by hand.`,
		);
		process.exit(1);
	}

	// Not baselined and not negotiable: the tree holds zero of these, and a layout that starts
	// throwing where nothing above it can catch reds the check on the PR that adds it.
	if (run.escapes.escapes.length > 0) {
		console.error(
			`\ncheck-route-states: ${run.escapes.escapes.length} layout boundary escape(s)\n`,
		);
		for (const line of run.escapes.escapes) console.error(`  ${line}`);
		console.error(
			`\nA segment's own not-found.tsx mounts INSIDE its layout, so a notFound() thrown by the ` +
				`layout escapes it and the root app/not-found.tsx answers instead — the generic page, ` +
				`not the one written for that segment (#3880, #3891).`,
		);
		process.exit(1);
	}

	const problems = compareToBaseline(baseline, run.tallied, run.totals);
	if (problems.length > 0) {
		console.error(`\ncheck-route-states: ${problems.length} baseline mismatch(es)\n`);
		for (const line of problems) console.error(`  ${line}`);
		console.error(
			`\nThe baseline SHRINKS ONLY, and it is checked in both directions, as a SET: a lane's PR ` +
				`must move a LINE in the same commit as its code (RUBRIC.md, "The scoreboard and the ratchet").` +
				`\nRun \`node scripts/check-route-states.mjs --print-baseline\` to see what this tree scores.`,
		);
		process.exit(1);
	}
	console.log(`\ncheck-route-states: matches ${BASELINE_FILE}`);
}
