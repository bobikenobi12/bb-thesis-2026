#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The console FILTER STANDARD, measured — RUBRIC.md's family F (F1–F7).
//
//   pnpm check:filter-standard              scan the tree, print the census, fail on a BROKEN
//                                           derivation (not on a non-conforming surface)
//   pnpm check:filter-standard --json       the derived view, for a caller
//   node scripts/check-filter-standard.mjs --self-test
//
// Do NOT pipe it. `node scripts/check-filter-standard.mjs | tail` reports TAIL's exit code.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────────
//
// Before it, NOTHING in the tree measured any of F1–F7. `apps/console/scripts/audit-report.mjs`
// declared all seven `kind: "none"` and the scoreboard rendered the whole F column as `—`,
// naming #3796. That is the failure this wave exists to close: a report whose "nothing found"
// branch is indistinguishable from "nothing measured".
//
// The header of `audit-report.mjs` also said, of F1–F7, "nothing in the tree implements this
// family at all". THAT WAS WRONG, and the wrongness is the finding this unit starts from: the
// console has FIFTEEN filter surfaces built on `createFilterStore`, a shared `useFilterUrlSync`,
// a shared `@repo/ui` bar vocabulary and a documented server half. The standard was implemented
// and unmeasured, not absent — so this file scores what is there rather than reporting a family
// nobody had built.
//
// ── THE SUBJECT IS A SURFACE, NOT A ROUTE ────────────────────────────────────────────────────
//
// RUBRIC.md's own N/A rule for family F is structural: a page is N/A with reason
// `not-a-list-page`, "derivable from the absence of a `lib/stores/use-*-filters.ts` store, never
// from how the page looks". So the store IS the subject anchor. But the store MODULE is the wrong
// granularity — `lib/stores/use-settings-filters.ts` holds SEVEN stores and
// `lib/stores/use-alerts-filters.ts` holds three, so a per-module verdict would pool ten
// surfaces into two. The unit is therefore one `createFilterStore` CALL SITE:
//
//     export const useTeamsFilters = createFilterStore<TeamsFilters>({ … })
//
// DERIVED, never typed. A hand-kept list of list pages decays silently, and this repo has paid
// for that more than once. Measured on `dev` at the time of writing: 15 surfaces across 7 store
// modules. `deriveSurfaces()` raises if it finds none — an empty subject set is a broken read,
// not a console with no list pages, and every predicate below would otherwise score `null` while
// looking like a clean board.
//
// ── THE NEIGHBOURHOOD, AND WHY IT IS NOT THE ROUTE'S CLOSURE ─────────────────────────────────
//
// F2–F6 ask about the code around ONE surface. The obvious join — the owning route's module
// closure, which `audit-report.mjs` already computes for the H family — is useless here and the
// measurement says so: a console route's page closure runs to 381 files, so
// `/[org]/[project]/architecture` "contains" `useFilterUrlSync`, `normalize*Query` and
// `keepPreviousData` while having no filter bar at all. H survives that because an H finding is a
// DEFECT anywhere in the closure; an F predicate is a property of one surface's own wiring, and
// presence-somewhere-in-381-files is not evidence of it.
//
// So the neighbourhood of a surface is the modules that NAME its store symbol, plus the store
// module itself. Measured: 1–3 modules per surface. That is tight enough to attribute and wide
// enough to reach the three places the standard actually lives — the page client (URL sync), the
// query hook (debounce, key, placeholder dim) and the bar (the shared primitives).
//
// A surface whose symbol NOTHING outside its store module names is a finding, not a skip: a
// filter store nobody reads is dead state, and it would otherwise score N/A on everything and
// vanish.
//
// ── THE PREDICATES, AND THE NEGATIVE FORM OF EACH ────────────────────────────────────────────
//
// Every matcher below is stated with the shape that makes it FAIL, because a predicate with no
// reachable negative form is a predicate that reports green by construction. `positiveControl()`
// drives each one in both directions over fixtures and is a precondition of any scan.
//
//   F1  the store is built by `createFilterStore`.
//       FAILS on a `use-*-filters.ts` export built with a bare zustand `create(` — the hand-rolled
//       store the factory replaced, which persists nothing and has no `reset`.
//
//   F2  `useFilterUrlSync(<thisStore>, …)` is called somewhere in the neighbourhood.
//       Matched PER SYMBOL, not per file: `components/alerts/alerts-filters.ts` wires three
//       stores, and a file-level `useFilterUrlSync(` would pass all three the moment one of them
//       was wired. FAILS on a surface whose store is never handed to the hook.
//
//   F3  search is debounced AND the normalized query object is the TanStack key. Two clauses,
//       because they fail independently and the second is the one that bites:
//         (a) if the surface's filter shape carries a free-text `search` field, that value goes
//             through `useDebouncedValue(`. A surface with no search box is not asked for a
//             debounce — decided from the store's DEFAULTS module, which is structural, not from
//             whether a search input is rendered, which is the thing being measured;
//         (b) an identifier bound from `normalize*Query(` appears INSIDE a `qk.*(…)` call.
//       FAILS — measured on `dev` — where a page computes the normalized query and then keys on
//       `qk.teams(org)` anyway: every filtered view then shares one cache entry.
//
//   F4  the bar is built from the shared primitives.
//       The sanctioned set is DERIVED from `packages/ui/src/*.tsx` (the modules whose names carry
//       `filter`/`facet`/`funnel`/`combobox`/`range`), never typed here — `FunnelFilter`,
//       `GroupedFilterSheet`, `QuickRangeFilter` and `MultiCombobox` are all part of this
//       vocabulary and a hand-written list would have missed them, marking the evidence page (the
//       rubric's own reference implementation, which composes `FunnelFilter`) a FAIL.
//       FAILS on a surface with no `<FilterBar>` at all, and on `lib/query/README.md`'s two named
//       bans inside the bar region — a Radix `<Select>` and a stat-card strip.
//
//   F5  the result count renders through the count pill.
//       Through `<CountPill>` directly, or through the `count=` prop of `SectionHeading` /
//       `PageToolbar`, which mount the same primitive — CLAUDE.md §6 dropped the console's page
//       titles and that is where a list page's count went. FAILS on a surface with no count at
//       all, and on the standard's own named anti-pattern: "N of M" prose inside the bar.
//
//   F6  `keepPreviousData` plus the `opacity-60` dim on `isPlaceholderData`.
//       The URL→RSC variant `lib/query/README.md` blesses is admitted in its own terms —
//       `useTransition`'s `isPending` "plays the keepPreviousData dim" — so that shape passes on
//       `isPending` + `opacity-60`. Admitting it is not a loosening: refusing it would fail a
//       surface for using the form the standard tells it to use, which is the shape of guard whose
//       cheapest escape route is to deepen the defect.
//
//   F7  the server builder issues a rows pass AND a separate unfiltered facet pass.
//       NOT MATCHED HERE, deliberately. RUBRIC.md's "Family F" section says F7 is a unit test and
//       gives the reason (cited by section, not by the `RUBRIC.md:165` #3796 quotes — that note is
//       at 271 now, moved by this unit's own edit to the file):
//       "a facet pass sees only the scope predicates" is a BEHAVIOUR, and the only honest way to
//       assert it is to run the builder and look at what the second query was given. So the
//       verdict is produced by `apps/console/tests/lib/queries/filter-standard-facets.test.ts`,
//       and what this file contributes is the JOIN and the SUBJECT CHECK — see below.
//
// ── F7: WHAT A STATIC FILE CAN HONESTLY SAY ABOUT A BEHAVIOUR ────────────────────────────────
//
// Two sets are derived here, and compared:
//
//   * the facet-bearing server builders — every exported async function under
//     `apps/console/lib/queries/` or `apps/console/app/server/actions/` whose body returns an
//     object with a `facets:` key. Derived, so a new list page's builder joins the subject set by
//     existing;
//   * the builders the F7 test DRIVES, read out of that test's own `DRIVEN` table.
//
// A builder in the first set and not the second is reported, and `F7_UNDRIVEN` is the only way to
// be in that position without failing this check — a table of exactly which builders are
// knowingly not driven, each with its reason. It is checked in BOTH directions: an entry naming a
// builder that no longer exists fails as loudly as a builder nobody declared. A route whose only
// facet source is an undriven builder scores **NOT MEASURED** on F7 — never PASS, and never N/A,
// because "the instrument did not reach this builder" is a claim about the instrument and N/A is
// a claim about the page (RUBRIC.md's rule 2).
//
// The soundness of a PASS is conditional and stated: a route reaching a DRIVEN builder passes F7
// because the test that drives it is green, and the scoreboard is only ever generated from a tree
// whose tests pass. Break a facet pass and the test reds — which is the gate — while this file
// keeps saying PASS. That is the same bargain RUBRIC.md's live half already makes with its
// imported records, and it is why the subject check above matters more than it looks: the one
// failure this arrangement could hide is a builder that quietly leaves the driven set, and that
// is exactly what is checked in both directions.
//
// ── WHAT THIS FILE FAILS ON, AND WHAT IT ONLY REPORTS ────────────────────────────────────────
//
// It exits 1 on a BROKEN DERIVATION — no surfaces, no builders, a store nobody reads, a builder
// nobody drives and nobody declared, a stale `F7_UNDRIVEN` row, an unreadable console tree. It
// does NOT exit 1 on a non-conforming surface, and that is a division of labour rather than a
// softness: the per-surface F1–F6 verdicts are scored per ROUTE by
// `apps/console/scripts/audit-report.mjs` into `ui-conformance-baseline.json`, which CI diffs
// against the tree on every PR. A conformance regression therefore reds as a stale artifact
// naming the route it moved, which is a better failure than a wall of findings with no owner.
// The census is printed on every run, pass or fail, so a collapse this file's floors cannot see
// is visible in the diff of two CI logs.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripCommentLines } from "./lib/console-routes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

/** RUBRIC.md family F, in the order it declares them. */
export const PREDICATES = /** @type {const} */ (["F1", "F2", "F3", "F4", "F5", "F6", "F7"]);

/**
 * The ONLY N/A reason family F declares (RUBRIC.md, "Family F"). RUBRIC.md's rule 1 makes a
 * reason outside a predicate's declared set an error rather than an N/A, so this list is the
 * whole vocabulary and `scoreRoutes()` emits nothing else.
 */
export const NA_REASONS = /** @type {const} */ (["not-a-list-page"]);

/** Where a filter store may live. One directory, one filename shape — both are the console's. */
const STORE_DIR = "apps/console/lib/stores";
const STORE_FILE = /^use-[a-z0-9-]+-filters\.ts$/;

/** Where a facet-bearing server builder may live. */
const BUILDER_DIRS = ["apps/console/lib/queries", "apps/console/app/server/actions"];

/** The F7 unit test — the instrument for the one predicate this file does not match. */
export const F7_TEST = "apps/console/tests/lib/queries/filter-standard-facets.test.ts";

/** `packages/ui/src` modules whose exports make up the sanctioned filter-bar vocabulary. */
const UI_DIR = "packages/ui/src";
const UI_FILTER_MODULE = /(filter|facet|funnel|combobox|range)/;

/**
 * The console directories scanned for a surface's neighbourhood.
 *
 * `scripts/`, `tests/`, `e2e/` and `docs/` are OUT: a test that names a store symbol is not a
 * consumer of it, and admitting them would let a surface pass F2 on the strength of its own test
 * fixture. Named as roots rather than "everything under apps/console minus a deny list", so the
 * census below reports one number per root and an emptying root is visible.
 */
const CONSOLE_ROOTS = ["apps/console/app", "apps/console/components", "apps/console/hooks", "apps/console/lib"];

/** Directory names never descended into, under any root. */
const NEVER = new Set(["node_modules", ".next", "coverage", "test-results", "playwright-report", "__snapshots__"]);

/**
 * Anchor modules the scan MUST have read. A census floor answers "did we read enough files"; this
 * answers "did we read the right ones" — a root renamed out from under this file leaves the
 * counts plausible and every predicate silently unmeasurable.
 */
const ANCHORS = [
	"apps/console/lib/stores/create-filter-store.ts",
	"apps/console/hooks/use-filter-url-sync.ts",
	"apps/console/hooks/use-debounced-value.ts",
];

/**
 * The facet-bearing builders knowingly NOT driven by the F7 test, each with its reason.
 *
 * Checked in both directions by `checkF7Subject()`: a builder here that no longer exists fails as
 * loudly as a builder that is neither driven nor declared. Routes whose only facet source is one
 * of these score NOT MEASURED on F7 — the honest verdict for a behaviour nothing ran.
 */
export const F7_UNDRIVEN = /** @type {const} */ ({
	getJobsPage: {
		file: "apps/console/app/server/actions/jobs.ts",
		owner: "#3796",
		why:
			"a `\"use server\"` action that opens its own transaction and resolves the actor before it " +
			"reads, rather than a `lib/queries` builder taking `(orgId, query)`. Driving it needs the " +
			"auth bootstrap `tests/actions/list-page-reads.test.ts` mocks, which is a second fixture " +
			"shape, not a second row in this one.",
	},
	queryProjects: {
		file: "apps/console/app/server/actions/projects.ts",
		owner: "#3796",
		why:
			"the org overview's URL→RSC read. Its facets are tallied IN MEMORY over the org's whole " +
			"project set rather than by a second SQL pass, so the invariant holds by a different " +
			"mechanism and needs a different assertion — the facet set must not shrink as the query " +
			"narrows — rather than the two-pass predicate check the other builders take.",
	},
});

// ── reading the tree ─────────────────────────────────────────────────────────────────────────

/**
 * Default IO, rooted at the repo. Injectable so `--self-test` drives the whole pipeline over
 * fixtures rather than over the console.
 *
 * @param {string} repoRoot
 */
export function fsIo(repoRoot) {
	return {
		readFile: (rel) => readFileSync(path.join(repoRoot, rel), "utf8"),
		/** @returns {{name: string, dir: boolean}[]} */
		listDir: (rel) => {
			/** @type {import("node:fs").Dirent[]} */
			let entries;
			try {
				entries = readdirSync(path.join(repoRoot, rel), { withFileTypes: true });
			} catch (err) {
				// ENOENT/ENOTDIR is how a caller asks "is there a directory here?". Everything else —
				// EACCES on an unreadable directory, a dangling symlink — is rethrown: swallowing it
				// drops a whole subtree from the scan and still prints a census that looks fine.
				if (err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return [];
				throw err;
			}
			return entries.filter((e) => e.isDirectory() || e.isFile()).map((e) => ({ name: e.name, dir: e.isDirectory() }));
		},
		exists: (rel) => {
			try {
				statSync(path.join(repoRoot, rel));
				return true;
			} catch {
				return false;
			}
		},
	};
}

/**
 * Every console `.ts`/`.tsx` module under {@link CONSOLE_ROOTS}, comment-stripped.
 *
 * Comments are blanked before ANY matcher runs. Without that, the prose in
 * `lib/stores/use-settings-filters.ts` — which names `useFilterUrlSync` in three sentences —
 * passes F2 for all seven of its surfaces on the strength of its own documentation.
 *
 * @param {ReturnType<typeof fsIo>} io
 * @returns {{sources: Map<string, string>, census: [string, number][], unterminated: string[]}}
 */
export function readConsole(io) {
	/** @type {Map<string, string>} */
	const sources = new Map();
	/** @type {[string, number][]} */
	const census = [];
	/** @type {string[]} */
	const unterminated = [];
	for (const root of CONSOLE_ROOTS) {
		let n = 0;
		/** @param {string} dir */
		const walk = (dir) => {
			for (const e of io.listDir(dir)) {
				if (NEVER.has(e.name)) continue;
				const rel = `${dir}/${e.name}`;
				if (e.dir) {
					walk(rel);
					continue;
				}
				if (!/\.tsx?$/.test(e.name) || /\.d\.ts$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
				const { lines, unterminated: open } = stripCommentLines(io.readFile(rel));
				// An unterminated block comment blanks everything after the opener, so the module's
				// wiring has NOT been read. Recorded rather than swallowed: a short read reports
				// exactly like a surface that does not do the thing.
				if (open) unterminated.push(rel);
				sources.set(rel, lines.join("\n"));
				n += 1;
			}
		};
		walk(root);
		census.push([root, n]);
	}
	return { sources, census, unterminated };
}

// ── the subject sets, all derived ────────────────────────────────────────────────────────────

/** One `createFilterStore` call site — the unit every F1–F6 verdict is about. */
/**
 * @typedef {object} Surface
 * @property {string} symbol   the exported store hook, e.g. `useTeamsFilters`
 * @property {string} file     the store module, repo-relative
 * @property {string} factory  what created it — `createFilterStore` or a bare `create`
 * @property {string[]} consumers modules naming `symbol`, excluding the store module
 */

/**
 * Every filter surface in the console.
 *
 * The pattern matches BOTH the sanctioned factory and a bare zustand `create`, because F1's
 * whole content is which of the two it was. Matching only `createFilterStore` would make F1
 * unfailable — the subject set would be defined as the set of things that pass it.
 *
 * @param {Map<string, string>} sources comment-stripped
 * @returns {Surface[]}
 */
export function deriveSurfaces(sources) {
	/** @type {Surface[]} */
	const surfaces = [];
	for (const [file, text] of [...sources].sort(([a], [b]) => a.localeCompare(b))) {
		if (path.dirname(file) !== STORE_DIR || !STORE_FILE.test(path.basename(file))) continue;
		const re = /export const (use\w+)\s*=\s*(createFilterStore|create)\b/g;
		let m;
		while ((m = re.exec(text)) !== null) surfaces.push({ symbol: m[1], file, factory: m[2], consumers: [] });
	}
	/** @type {Map<string, Surface>} */
	const bySymbol = new Map();
	for (const s of surfaces) {
		if (bySymbol.has(s.symbol)) {
			throw new Error(
				`two filter stores are both exported as \`${s.symbol}\` (${bySymbol.get(s.symbol).file}, ${s.file}). ` +
					"A symbol naming two surfaces makes every per-surface verdict below ambiguous.",
			);
		}
		bySymbol.set(s.symbol, s);
		for (const [file, text] of sources) {
			if (file === s.file) continue;
			if (new RegExp(`\\b${s.symbol}\\b`).test(text)) s.consumers.push(file);
		}
		// ONE HOP, into the surface's OWN query hook and nothing else.
		//
		// Why a hop at all: `lib/query/README.md`'s table puts the per-resource hooks in
		// `lib/query/use-*-query.ts`, and a page that hands its normalized query to one as an
		// ARGUMENT never names its own store there. Measured — the jobs page's `keepPreviousData`
		// and its parameterised `qk.jobsPage(org, query)` both live in `use-jobs-page-query.ts`,
		// which does not mention `useJobsFilters`, so F3 and F6 read as absent on a page that does
		// the thing correctly.
		//
		// Why it is matched by NAME and not by "every query hook the consumer imports": the greedy
		// form was written first and it is wrong in the direction that matters. `members-table.tsx`
		// imports `use-classification-query.ts` for an unrelated panel, and that module's
		// parameterised key flipped the members surface — which really does key on `qk.members(org)`
		// while computing a normalized query it then ignores — from FAIL to PASS. A neighbourhood
		// that admits a sibling's evidence is the 381-file closure this file rejected, in miniature.
		//
		// The name rule is the console's own convention, both halves of it: `use-<resource>-filters`
		// pairs with `use-<resource>*-query`. A surface whose hook does not follow it simply gets no
		// hop and is judged on the modules that name it — the closed direction.
		//
		// The stem is taken from the SYMBOL as well as from the file, and the symbol is the half
		// that carries the seven settings surfaces: they all live in `use-settings-filters.ts`, so
		// a file-derived stem of `settings` matches no query hook at all and `useSsoFilters` never
		// reaches `use-sso-query.ts`. `useSsoFilters` → `sso` does.
		const stems = new Set([
			path.basename(s.file).replace(/^use-/, "").replace(/-filters\.ts$/, ""),
			s.symbol
				.replace(/^use/, "")
				.replace(/Filters$/, "")
				.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
				.toLowerCase(),
		]);
		for (const file of [...s.consumers]) {
			for (const m of (sources.get(file) ?? "").matchAll(/["']@\/(lib\/query\/use-[a-z0-9-]+-query)["']/g)) {
				const hop = `apps/console/${m[1]}.ts`;
				if (![...stems].some((stem) => path.basename(hop).startsWith(`use-${stem}`))) continue;
				if (sources.has(hop) && !s.consumers.includes(hop)) s.consumers.push(hop);
			}
		}
		s.consumers.sort();
	}
	return surfaces;
}

/**
 * The sanctioned filter-bar vocabulary, read out of `packages/ui/src`.
 *
 * DERIVED for a measured reason: a hand-written {FilterBar, FilterSearch, FacetFilter,
 * FilterChipGroup, FilterBarReset} — RUBRIC.md's own F4 row, quoted verbatim — misses
 * `FunnelFilter`, `GroupedFilterSheet`, `QuickRangeFilter`, `DateRangeFilter` and
 * `MultiCombobox`, four of which are in bars on `dev` today and one of which is in the evidence
 * page's bar, which the rubric names as the reference implementation. The rubric's list is an
 * illustration; the package is the vocabulary.
 *
 * @param {ReturnType<typeof fsIo>} io
 * @returns {Set<string>}
 */
export function deriveBarPrimitives(io) {
	/** @type {Set<string>} */
	const names = new Set();
	for (const e of io.listDir(UI_DIR)) {
		if (e.dir || !/\.tsx$/.test(e.name) || !UI_FILTER_MODULE.test(e.name)) continue;
		const { lines } = stripCommentLines(io.readFile(`${UI_DIR}/${e.name}`));
		const text = lines.join("\n");
		for (const m of text.matchAll(/export (?:function|const) ([A-Z]\w*)/g)) names.add(m[1]);
	}
	return names;
}

/** One facet-bearing server builder. */
/**
 * @typedef {object} Builder
 * @property {string} name
 * @property {string} file repo-relative
 */

/**
 * One function's own body, by brace depth from its signature.
 *
 * Slicing "from this `export async function` to the NEXT one" is the obvious thing and it is
 * WRONG, measured: `app/server/actions/projects.ts` declares `interface ProjectsPage { … facets:
 * … }` BETWEEN `getProjects` and `queryProjects`, so the naive slice made `getProjects` — which
 * returns `ProjectWithProvider[]` and no facets at all — a facet-bearing builder, and F7's subject
 * set gained a function there is nothing to assert about. Depth-matching from the signature's own
 * opening brace cannot pick up a sibling declaration.
 *
 * Falls back to the naive slice if the braces never balance (a template literal holding an unmatched
 * brace, say): over-reporting a builder is a line in the `F7_UNDRIVEN` table, under-reporting one
 * is a facet pass nobody ever runs.
 *
 * @param {string} text comment-stripped source
 * @param {number} from index of the `export` keyword
 * @param {number} until index of the next declaration, the fallback bound
 */
function functionBody(text, from, until) {
	const open = text.indexOf("{", text.indexOf(")", from));
	if (open === -1 || open > until) return text.slice(from, until);
	let depth = 0;
	for (let i = open; i < text.length; i += 1) {
		if (text[i] === "{") depth += 1;
		else if (text[i] === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(open, i + 1);
		}
	}
	return text.slice(from, until);
}

/**
 * Every server read that returns facet options.
 *
 * The test is the RETURN SHAPE — an exported async function that returns an object carrying a
 * `facets` key — not the name. `query*Page` would have been the obvious pattern and it is wrong
 * in both directions: it misses `getJobsPage` and `getProjects`, which return facets from
 * `app/server/actions`, and it would admit `queryProvisionedHours`, which returns none.
 *
 * BOTH property forms are matched, because the console uses both: `facets: { sizes }` in the five
 * builders that build the object inline, and the SHORTHAND `return { projects, facets }` in
 * `getProjects`, which tallies into a local first. A `facets:`-only pattern silently drops that
 * one — and dropping a builder from the subject set is indistinguishable from a builder that
 * needs no test.
 *
 * @param {ReturnType<typeof fsIo>} io
 * @returns {Builder[]}
 */
export function deriveBuilders(io) {
	/** @type {Builder[]} */
	const builders = [];
	for (const dir of BUILDER_DIRS) {
		for (const e of io.listDir(dir).sort((a, b) => a.name.localeCompare(b.name))) {
			if (e.dir || !/\.ts$/.test(e.name) || /\.test\.ts$/.test(e.name)) continue;
			const file = `${dir}/${e.name}`;
			const { lines } = stripCommentLines(io.readFile(file));
			const text = lines.join("\n");
			const heads = [...text.matchAll(/export async function (\w+)\s*\(/g)];
			for (const [i, m] of heads.entries()) {
				const until = heads[i + 1]?.index ?? text.length;
				const body = functionBody(text, m.index, until);
				if (/\breturn\b[\s\S]*?\bfacets\b\s*[,:}]/.test(body)) builders.push({ name: m[1], file });
			}
		}
	}
	return builders;
}

/**
 * The builders the F7 test drives, read out of the test's own `DRIVEN` table.
 *
 * Read from the TEST rather than restated here, so the two cannot disagree: the table this parses
 * is the same object the test iterates, which is the only arrangement in which "the guard says it
 * is driven" and "the test drives it" are the same fact.
 *
 * @param {ReturnType<typeof fsIo>} io
 * @returns {Set<string>}
 */
export function deriveDrivenBuilders(io) {
	/** @type {string} */
	let text;
	try {
		text = io.readFile(F7_TEST);
	} catch {
		throw new Error(
			`${F7_TEST} is missing. It is the ONLY instrument for F7 — RUBRIC.md's "Family F" says so and gives ` +
				"the reason — so without it the predicate is not merely unmeasured, it is unmeasurable, and " +
				"every route that reaches a builder would be scored from nothing.",
		);
	}
	const at = text.indexOf("const DRIVEN");
	if (at === -1) {
		throw new Error(
			`${F7_TEST} no longer declares a \`const DRIVEN\` table. That table is what this guard reads to ` +
				"know which builders the behaviour test actually runs; without it the subject check below " +
				"would pass by finding nothing, which is the exact failure this file exists to prevent.",
		);
	}
	const names = new Set();
	// The table's keys are the builder names, one `name: {` per row.
	for (const m of text.slice(at).matchAll(/(^|\n)\t*(\w+)\s*:\s*\{/g)) names.add(m[2]);
	return names;
}

// ── the predicates ───────────────────────────────────────────────────────────────────────────

/** A JSX region: `<Tag …>` through its closing tag, or to EOF if it never closes. */
function regionOf(text, tag) {
	const open = text.search(new RegExp(`<${tag}[\\s>]`));
	if (open === -1) return null;
	const close = text.indexOf(`</${tag}>`, open);
	return close === -1 ? text.slice(open) : text.slice(open, close);
}

/** `lib/query/README.md`'s two named bans inside a filter bar. */
const BANNED_IN_BAR = [
	{ re: /<Select[\s>]/, what: "a Radix `<Select>`" },
	{ re: /<Stat(Card|Strip)?[\s>]/, what: "a stat-card strip" },
];

/** "N of M" prose: two interpolations either side of a bare `of`. */
const N_OF_M = /\{[^{}]+\}\s*of\s*\{[^{}]+\}/;

/**
 * Score F1–F6 for one surface over its neighbourhood.
 *
 * @param {Surface} surface
 * @param {Map<string, string>} sources comment-stripped
 * @param {Set<string>} barPrimitives
 * @returns {Record<string, {verdict: "PASS"|"FAIL", detail?: string}>}
 */
export function scoreSurface(surface, sources, barPrimitives) {
	const neighbourhood = [surface.file, ...surface.consumers];
	const text = neighbourhood.map((f) => sources.get(f) ?? "").join("\n\n");
	const has = (re) => re.test(text);

	/** @type {Record<string, {verdict: "PASS"|"FAIL", detail?: string}>} */
	const out = {};
	/** @param {string} id @param {boolean} ok @param {string} detail */
	const verdict = (id, ok, detail) => {
		out[id] = ok ? { verdict: "PASS" } : { verdict: "FAIL", detail };
	};

	// F1 — the factory.
	verdict(
		"F1",
		surface.factory === "createFilterStore",
		`\`${surface.symbol}\` is built with a bare \`${surface.factory}(\`, not \`createFilterStore\` — ` +
			"so it has no sessionStorage persistence, no `patch`, and no `reset` for `FilterBarReset` to call",
	);

	// F2 — URL sync, per symbol.
	verdict(
		"F2",
		new RegExp(`useFilterUrlSync\\(\\s*${surface.symbol}\\b`).test(text),
		`nothing calls \`useFilterUrlSync(${surface.symbol}, …)\` — a filtered view of this surface is not linkable`,
	);

	// F3 — debounced search, and the normalized query IS the key.
	// The debounce clause applies only where the surface HAS free text, and that is read from the
	// store's own defaults module rather than from whether a search input is rendered: the render
	// is downstream of the thing being measured, the shape is not.
	const wantsDebounce = /\bsearch\s*:/.test(sources.get(surface.file) ?? "") || has(/\bfilters\.search\b/);
	const debounced = !wantsDebounce || has(/useDebouncedValue\s*\(/);
	// Clause (b) is two facts, and BOTH are needed: the surface normalizes its filters into a
	// query object at all, and the key it builds carries more than the org.
	//
	// It is deliberately NOT "the identifier bound from `normalize*Query()` appears inside the
	// `qk.*()` call". That was the first form and it is wrong across a module boundary: the jobs
	// page normalizes in `jobs-client.tsx` and keys in `use-jobs-page-query.ts`, where the same
	// object is a PARAMETER with a different name. `qk.foo(org)` versus `qk.foo(org, q)` is the
	// distinction the standard actually draws — "unsorted arrays fragment the cache" is about
	// what is IN the key — and it survives the rename.
	const normalizes = has(/normalize\w*Query\s*\(/);
	const parameterisedKey = neighbourhood.some((file) =>
		[...(sources.get(file) ?? "").matchAll(/qk\.\w+\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].some(
			(m) => m[1].split(",").filter((a) => a.trim() !== "").length > 1,
		),
	);
	verdict(
		"F3",
		debounced && normalizes && parameterisedKey,
		!debounced
			? "the surface has a free-text `search` filter that never goes through `useDebouncedValue` — every keystroke is a request"
			: !normalizes
				? "no `normalize*Query()` — the filters reach the server (and the cache key) in whatever shape the store holds them"
				: "the normalized query object is not in the TanStack key: every `qk.*()` call in this surface's " +
					"neighbourhood takes the org and nothing else, so every filtered view shares one cache entry",
	);

	// F4 — the bar, from the shared vocabulary.
	const barFile = neighbourhood.find((f) => /<FilterBar[\s>]/.test(sources.get(f) ?? ""));
	const bar = barFile === undefined ? null : regionOf(sources.get(barFile) ?? "", "FilterBar");
	const banned = bar === null ? [] : BANNED_IN_BAR.filter((b) => b.re.test(bar)).map((b) => b.what);
	const primitives = bar === null ? [] : [...new Set([...bar.matchAll(/<([A-Z]\w*)/g)].map((m) => m[1]))].filter((n) => barPrimitives.has(n) && n !== "FilterBar");
	verdict(
		"F4",
		bar !== null && banned.length === 0 && primitives.length > 0,
		bar === null
			? "no `<FilterBar>` in this surface's neighbourhood — the row is hand-rolled"
			: banned.length > 0
				? `${banned.join(" and ")} inside the \`<FilterBar>\` — \`lib/query/README.md\` bans both from a filter bar`
				: "the `<FilterBar>` composes no `@repo/ui` filter primitive at all",
	);

	// F5 — the count pill, and not "N of M" in the bar.
	const pill =
		has(/<CountPill[\s>]/) ||
		has(/<SectionHeading\b[\s\S]{0,800}?\bcount=/) ||
		has(/<PageToolbar\b[\s\S]{0,800}?\bcount=/);
	const prose = bar !== null && N_OF_M.test(bar);
	verdict(
		"F5",
		pill && !prose,
		prose
			? '"N of M" prose inside the `<FilterBar>` — the count belongs in the pill above the list, not in the bar'
			: "no result count renders through `CountPill` (directly, or as `SectionHeading`/`PageToolbar`'s `count`)",
	);

	// F6 — keepPreviousData plus the dim. The URL→RSC variant is admitted in the README's own terms.
	const kept = has(/keepPreviousData/);
	const dimmed = has(/isPlaceholderData/) && has(/opacity-60/);
	const rscVariant = has(/useTransition\s*\(/) && has(/\bisPending\b/) && has(/opacity-60/);
	verdict(
		"F6",
		(kept && dimmed) || rscVariant,
		!kept
			? "no `keepPreviousData` — the list unmounts to a skeleton on every filter change"
			: "`keepPreviousData` without the `opacity-60` dim on `isPlaceholderData` — a stale list renders as a current one",
	);

	return out;
}

// ── the F7 subject check ─────────────────────────────────────────────────────────────────────

/**
 * Every way the F7 instrument can stop covering its subject, in both directions.
 *
 * @param {Builder[]} builders
 * @param {Set<string>} driven
 * @param {typeof F7_UNDRIVEN} [undriven] injectable so `--self-test` drives both directions over a
 *   fixture tree, which does not contain the console's two real exemptions
 * @returns {string[]} one line per problem
 */
export function checkF7Subject(builders, driven, undriven = F7_UNDRIVEN) {
	/** @type {string[]} */
	const problems = [];
	const known = new Set(builders.map((b) => b.name));
	for (const b of builders) {
		if (driven.has(b.name) || b.name in undriven) continue;
		problems.push(
			`${b.file}: \`${b.name}\` returns facets and ${F7_TEST} does not drive it. F7 is a BEHAVIOUR — ` +
				`add it to that test's \`DRIVEN\` table, or to \`F7_UNDRIVEN\` with the reason. A builder in ` +
				"neither is a facet pass nobody ever ran.",
		);
	}
	for (const name of driven) {
		if (!known.has(name)) {
			problems.push(
				`${F7_TEST} drives \`${name}\`, which is not a facet-bearing server builder in the tree. Either ` +
					"it was renamed, or it stopped returning facets — in both cases the test is now asserting " +
					"about something other than what it claims.",
			);
		}
	}
	for (const [name, row] of Object.entries(undriven)) {
		if (!known.has(name)) {
			problems.push(
				`F7_UNDRIVEN names \`${name}\` (${row.file}), which no longer returns facets. Delete the row in ` +
					"the same commit — a table of exemptions nobody is forced to shrink stops being true.",
			);
		}
		if (driven.has(name)) {
			problems.push(`\`${name}\` is both declared undriven and driven by ${F7_TEST}. It cannot be both.`);
		}
	}
	return problems;
}

// ── the scan ─────────────────────────────────────────────────────────────────────────────────

/**
 * Everything derived from one tree, plus every reason it should not be believed.
 *
 * @param {ReturnType<typeof fsIo>} io
 * @param {typeof F7_UNDRIVEN} [undriven] injectable so `--self-test` drives the whole pipeline
 *   over a fixture tree, which does not hold the console's two real exemptions
 */
export function scan(io, undriven = F7_UNDRIVEN) {
	const { sources, census, unterminated } = readConsole(io);

	/** @type {string[]} */
	const problems = [];

	// VACUITY, first. "Found nothing" and "read nothing" must never share an exit code.
	const total = census.reduce((n, [, c]) => n + c, 0);
	if (total === 0) problems.push("the console scan read ZERO modules — a broken root, not a console with no code.");
	for (const [root, n] of census) {
		if (n === 0) problems.push(`no modules under \`${root}\` — that root has moved or been renamed, and every predicate over it is now unmeasurable.`);
	}
	for (const anchor of ANCHORS) {
		if (!sources.has(anchor)) {
			problems.push(
				`\`${anchor}\` was not read. It is one of the modules the filter standard IS, so a scan that ` +
					"misses it has not read the console — whatever the file counts say.",
			);
		}
	}
	for (const file of unterminated) {
		problems.push(`${file}: a block comment is still open at EOF, so everything after the opener was blanked and this module's wiring was NOT read.`);
	}

	const surfaces = problems.length > 0 ? [] : deriveSurfaces(sources);
	if (problems.length === 0 && surfaces.length === 0) {
		problems.push(
			`no filter surfaces found under \`${STORE_DIR}\`. RUBRIC.md's family F is N/A for a page with no ` +
				"store, so an empty subject set scores the whole family `null` while looking exactly like a " +
				"clean board — which is the report this unit exists to stop producing.",
		);
	}
	for (const s of surfaces) {
		if (s.consumers.length === 0) {
			problems.push(
				`${s.file}: \`${s.symbol}\` is exported and nothing outside its own module names it. A filter ` +
					"store nobody reads is dead state, and it would otherwise score N/A on everything and vanish.",
			);
		}
	}

	const barPrimitives = problems.length > 0 ? new Set() : deriveBarPrimitives(io);
	if (problems.length === 0 && barPrimitives.size === 0) {
		problems.push(
			`no filter primitives found under \`${UI_DIR}\`. F4 asks whether a bar is built from them; with an ` +
				"empty vocabulary every bar fails, which is a verdict about this scan and not about any page.",
		);
	}

	const builders = problems.length > 0 ? [] : deriveBuilders(io);
	if (problems.length === 0 && builders.length === 0) {
		problems.push(
			`no facet-bearing server builder found under ${BUILDER_DIRS.join(" or ")}. F7's subject set is empty, ` +
				"so the predicate cannot fail — and a predicate that cannot fail is the `—` this unit replaces.",
		);
	}
	// `deriveDrivenBuilders` RAISES on a missing or shapeless F7 test, and it is called even when
	// the scan already has problems: "the instrument is gone" must not be reportable as one more
	// line in a list nobody reads to the end.
	const driven = deriveDrivenBuilders(io);
	problems.push(...checkF7Subject(builders, driven, undriven));

	/** @type {Record<string, Record<string, {verdict: string, detail?: string}>>} */
	const perSurface = {};
	for (const s of surfaces) perSurface[s.symbol] = scoreSurface(s, sources, barPrimitives);

	return { sources, census, surfaces, builders, driven, barPrimitives, perSurface, problems };
}

// ── the route join ───────────────────────────────────────────────────────────────────────────

/**
 * Family F's verdicts, per route.
 *
 * A route OWNS a surface when its page closure reaches both the surface's store module and at
 * least one module that names the surface's symbol. Both halves are needed and the second is what
 * makes the join usable: seven settings surfaces share one store module, so the module alone
 * would hand all seven to every settings route.
 *
 * A route owning no surface is N/A `not-a-list-page` — RUBRIC.md's one declared reason for this
 * family, and structural exactly as it requires.
 *
 * F7 joins the route's own closure to the builder sets: a DRIVEN builder is a PASS (the test that
 * drives it is green, or the tree this ran on does not ship), an UNDRIVEN one is NOT MEASURED,
 * and a list page whose closure reaches no facet-bearing builder at all is a FAIL — it filters
 * server-side with no facet pass to be unfiltered.
 *
 * @param {ReturnType<typeof scan>} scanned
 * @param {Map<string, Set<string>>} pageClosures route → repo-relative files
 * @param {string[]} routeOrder
 * @returns {{route: string, predicate: string, verdict: "PASS"|"FAIL"|"N/A"|"NOT MEASURED", reason?: string, detail?: string}[]}
 */
export function scoreRoutes(scanned, pageClosures, routeOrder) {
	/** @type {{route: string, predicate: string, verdict: "PASS"|"FAIL"|"N/A"|"NOT MEASURED", reason?: string, detail?: string}[]} */
	const verdicts = [];

	for (const route of routeOrder) {
		const closure = pageClosures.get(route) ?? new Set();
		const owned = scanned.surfaces.filter((s) => closure.has(s.file) && s.consumers.some((c) => closure.has(c)));

		if (owned.length === 0) {
			for (const id of PREDICATES) verdicts.push({ route, predicate: id, verdict: "N/A", reason: "not-a-list-page" });
			continue;
		}

		// F1–F6: the conjunction over the route's surfaces. A page carrying two list surfaces is
		// as good as its worst one — a filter bar that is not linkable is not excused by a sibling
		// on the same page that is.
		for (const id of PREDICATES.filter((p) => p !== "F7")) {
			const failures = owned
				.map((s) => ({ symbol: s.symbol, ...scanned.perSurface[s.symbol][id] }))
				.filter((v) => v.verdict === "FAIL");
			if (failures.length === 0) {
				verdicts.push({ route, predicate: id, verdict: "PASS" });
				continue;
			}
			verdicts.push({
				route,
				predicate: id,
				verdict: "FAIL",
				detail: failures.map((f) => `${f.symbol}: ${f.detail}`).join(" · "),
			});
		}

		// F7: the builders this page's closure actually reaches.
		//
		// The names below are read off the DERIVED builder records and rendered into the detail
		// string, never parsed back out of it. A guard that re-reads its own rendering is matching a
		// rendering rather than the thing, which this repo has shipped more than once.
		const reached = scanned.builders.filter((b) => closure.has(b.file));
		const drivenHere = reached.filter((b) => scanned.driven.has(b.name));
		const undrivenHere = reached.filter((b) => b.name in F7_UNDRIVEN);
		if (drivenHere.length > 0) {
			verdicts.push({
				route,
				predicate: "F7",
				verdict: "PASS",
				detail: `${drivenHere.map((b) => b.name).sort().join(", ")} — driven by ${F7_TEST}`,
			});
		} else if (undrivenHere.length > 0) {
			verdicts.push({
				route,
				predicate: "F7",
				verdict: "NOT MEASURED",
				reason: `the only facet-bearing builder(s) this page reaches (${undrivenHere.map((b) => b.name).sort().join(", ")}) are declared undriven — F7 is a behaviour and nothing ran it here`,
			});
		} else {
			verdicts.push({
				route,
				predicate: "F7",
				verdict: "FAIL",
				detail:
					`this page owns ${owned.map((s) => s.symbol).join(", ")} and its closure reaches no server read that ` +
					"returns facets — so its filter options come from somewhere other than the unfiltered universe",
			});
		}
	}
	return verdicts;
}

// ── the positive control ─────────────────────────────────────────────────────────────────────

/** The minimum well-formed console a fixture needs, so a fixture never trips a vacuity floor. */
function fixtureIo(overrides = {}) {
	/** @type {Record<string, string>} */
	const files = {
		"apps/console/lib/stores/create-filter-store.ts": "export function createFilterStore() {}",
		"apps/console/hooks/use-filter-url-sync.ts": "export function useFilterUrlSync() {}",
		"apps/console/hooks/use-debounced-value.ts": "export function useDebouncedValue() {}",
		"apps/console/lib/stores/use-widgets-filters.ts":
			'export const useWidgetFilters = createFilterStore({ name: "w", defaults: { search: "" } });',
		"apps/console/components/widgets-client.tsx": [
			"import { useWidgetFilters } from '@/lib/stores/use-widgets-filters';",
			"useFilterUrlSync(useWidgetFilters, DEFAULTS);",
			"const q = useMemo(() => normalizeWidgetsQuery({ ...filters, search }), []);",
			"const search = useDebouncedValue(filters.search, 300);",
			"useQuery({ queryKey: qk.widgets(org, q), placeholderData: keepPreviousData });",
			'<SectionHeading title="Widgets" count={n} />',
			'<div className={isPlaceholderData ? "opacity-60" : ""}>',
			"<FilterBar><FilterSearch /><FacetFilter /><FilterBarReset /></FilterBar>",
		].join("\n"),
		// Ballast: one module per root that no predicate reads, so a mutation that DELETES the
		// fixture's client is testing the matcher and not the "this root emptied" floor.
		"apps/console/components/unrelated-card.tsx": "export function UnrelatedCard() { return null; }",
		"apps/console/lib/unrelated.ts": "export const UNRELATED = 1;",
		"apps/console/app/page.tsx": "export default function P() { return null; }",
		"apps/console/lib/queries/widgets.ts": [
			"export async function queryWidgetsPage(orgId, query) {",
			"\treturn { rows: [], facets: { kinds: [] } };",
			"}",
		].join("\n"),
		"packages/ui/src/filter-bar.tsx": "export function FilterBar() {}\nexport function FilterBarReset() {}",
		"packages/ui/src/filter-search.tsx": "export function FilterSearch() {}",
		"packages/ui/src/facet-filter.tsx": "export function FacetFilter() {}",
		[F7_TEST]: "const DRIVEN = {\n\tqueryWidgetsPage: { module: '@/lib/queries/widgets' },\n};",
		...overrides,
	};
	for (const [k, v] of Object.entries(overrides)) if (v === null) delete files[k];
	/** @type {ReturnType<typeof fsIo>} */
	return {
		readFile: (rel) => {
			if (!(rel in files)) throw Object.assign(new Error(`ENOENT ${rel}`), { code: "ENOENT" });
			return files[rel];
		},
		listDir: (rel) => {
			/** @type {Map<string, boolean>} */
			const seen = new Map();
			for (const f of Object.keys(files)) {
				if (!f.startsWith(`${rel}/`)) continue;
				const rest = f.slice(rel.length + 1);
				const cut = rest.indexOf("/");
				if (cut === -1) seen.set(rest, false);
				else seen.set(rest.slice(0, cut), true);
			}
			return [...seen].map(([name, dir]) => ({ name, dir }));
		},
		exists: (rel) => rel in files,
	};
}

/**
 * Every matcher, driven in BOTH directions over fixtures.
 *
 * The clean fixture is built to PASS all six, and each mutation below breaks exactly one. A guard
 * whose expected values are built out of its own matcher is tautological, so the fixture is
 * written as the console's own reference implementation reads — not as the regexes read.
 *
 * @returns {string[]} one line per broken control
 */
export function positiveControl() {
	/** @type {string[]} */
	const problems = [];
	const CLIENT = "apps/console/components/widgets-client.tsx";
	const STORE = "apps/console/lib/stores/use-widgets-filters.ts";

	/** @param {string} what @param {object} overrides @param {(v: Record<string, {verdict: string}>) => boolean} want */
	const drive = (what, overrides, want) => {
		const scanned = scan(fixtureIo(overrides), {});
		if (scanned.problems.length > 0 && Object.keys(overrides).length === 0) {
			problems.push(`${what}: the clean fixture reported ${scanned.problems.length} problem(s) — ${scanned.problems[0]}`);
			return;
		}
		const v = scanned.perSurface.useWidgetFilters;
		if (v === undefined) {
			problems.push(`${what}: the fixture surface disappeared from the scan.`);
			return;
		}
		if (!want(v)) problems.push(`${what}: ${JSON.stringify(v)}`);
	};

	const clean = fixtureIo();
	const base = scan(clean, {});
	if (base.problems.length > 0) problems.push(`the clean fixture is not clean: ${base.problems.join(" | ")}`);
	drive("the clean fixture passes every predicate", {}, (v) => PREDICATES.filter((p) => p !== "F7").every((p) => v[p].verdict === "PASS"));

	drive(
		"F1 fires on a bare zustand `create(`",
		{ [STORE]: 'export const useWidgetFilters = create({ search: "" });' },
		(v) => v.F1.verdict === "FAIL" && v.F2.verdict === "PASS",
	);
	drive(
		"F2 fires when the URL sync names ANOTHER store",
		{ [CLIENT]: clean.readFile(CLIENT).replace("useFilterUrlSync(useWidgetFilters,", "useFilterUrlSync(useOtherFilters,") },
		(v) => v.F2.verdict === "FAIL" && v.F3.verdict === "PASS",
	);
	drive(
		"F3 fires when the normalized query is not in the key",
		{ [CLIENT]: clean.readFile(CLIENT).replace("qk.widgets(org, q)", "qk.widgets(org)") },
		(v) => v.F3.verdict === "FAIL" && v.F2.verdict === "PASS",
	);
	drive(
		"F3 fires when a free-text surface never debounces",
		{ [CLIENT]: clean.readFile(CLIENT).replace("const search = useDebouncedValue(filters.search, 300);", "const search = filters.search;") },
		(v) => v.F3.verdict === "FAIL",
	);
	drive(
		"F3 does NOT ask a search-less surface to debounce",
		{
			[STORE]: 'export const useWidgetFilters = createFilterStore({ name: "w", defaults: { kinds: [] } });',
			[CLIENT]: clean.readFile(CLIENT).replace("const search = useDebouncedValue(filters.search, 300);", ""),
		},
		(v) => v.F3.verdict === "PASS",
	);
	drive(
		"F4 fires on a hand-rolled bar",
		{ [CLIENT]: clean.readFile(CLIENT).replace(/<FilterBar>.*<\/FilterBar>/, '<div className="flex gap-2"><input /></div>') },
		(v) => v.F4.verdict === "FAIL",
	);
	drive(
		"F4 fires on a Radix Select inside the bar",
		{ [CLIENT]: clean.readFile(CLIENT).replace("<FacetFilter />", "<FacetFilter /><Select />") },
		(v) => v.F4.verdict === "FAIL",
	);
	drive(
		"F5 fires with no count pill anywhere",
		{ [CLIENT]: clean.readFile(CLIENT).replace('<SectionHeading title="Widgets" count={n} />', '<SectionHeading title="Widgets" />') },
		(v) => v.F5.verdict === "FAIL",
	);
	drive(
		'F5 fires on "N of M" prose in the bar',
		{ [CLIENT]: clean.readFile(CLIENT).replace("<FilterSearch />", "<FilterSearch />{shown} of {total}") },
		(v) => v.F5.verdict === "FAIL",
	);
	drive(
		"F6 fires without keepPreviousData",
		{ [CLIENT]: clean.readFile(CLIENT).replace("placeholderData: keepPreviousData", "placeholderData: undefined") },
		(v) => v.F6.verdict === "FAIL",
	);
	drive(
		"F6 fires when the dim is missing",
		{ [CLIENT]: clean.readFile(CLIENT).replace('isPlaceholderData ? "opacity-60" : ""', '""') },
		(v) => v.F6.verdict === "FAIL",
	);
	drive(
		"F6 admits the blessed URL→RSC variant",
		{
			[CLIENT]: clean
				.readFile(CLIENT)
				.replace("placeholderData: keepPreviousData", "placeholderData: undefined")
				.replace('isPlaceholderData ? "opacity-60" : ""', 'isPending ? "opacity-60" : ""')
				.concat("\nconst [isPending, start] = useTransition();"),
		},
		(v) => v.F6.verdict === "PASS",
	);

	// A comment must never satisfy a predicate. `use-settings-filters.ts` names `useFilterUrlSync`
	// in its own header three times, so without comment stripping seven surfaces pass F2 on prose.
	const commented = scan(
		fixtureIo({
			[CLIENT]: clean.readFile(CLIENT).replace("useFilterUrlSync(useWidgetFilters, DEFAULTS);", "// useFilterUrlSync(useWidgetFilters, DEFAULTS);"),
		}),
		{},
	);
	if (commented.perSurface.useWidgetFilters.F2.verdict !== "FAIL") {
		problems.push("a COMMENTED-OUT `useFilterUrlSync(…)` satisfied F2 — comments are not being stripped before the matchers run.");
	}

	// ── the vacuity floors, each one exercised ────────────────────────────────────────────────
	/** @param {string} what @param {object} overrides @param {RegExp} expect */
	const refuses = (what, overrides, expect) => {
		/** @type {ReturnType<typeof scan>} */
		let out;
		try {
			out = scan(fixtureIo(overrides), {});
		} catch (err) {
			if (!expect.test(String(err.message))) problems.push(`${what}: raised, but not about that — ${err.message}`);
			return;
		}
		if (!out.problems.some((p) => expect.test(p))) {
			problems.push(`${what}: reported ${out.problems.length} problem(s), none matching ${expect} — ${out.problems.join(" | ")}`);
		}
	};
	refuses("an empty store directory", { [STORE]: null }, /no filter surfaces found/);
	refuses("a store nobody reads", { [CLIENT]: null }, /nothing outside its own module names it/);
	refuses("no facet-bearing builder", { "apps/console/lib/queries/widgets.ts": null }, /no facet-bearing server builder/);
	refuses(
		"a builder the F7 test does not drive",
		{ [F7_TEST]: "const DRIVEN = {\n};" },
		/does not drive it/,
	);
	refuses(
		"an F7 test driving a builder that does not exist",
		{ [F7_TEST]: "const DRIVEN = {\n\tqueryGhostsPage: { module: 'x' },\n};" },
		/which is not a facet-bearing server builder/,
	);
	refuses("a missing anchor module", { "apps/console/hooks/use-debounced-value.ts": null }, /was not read/);
	refuses(
		"an unterminated block comment",
		{ [CLIENT]: `/* open\n${clean.readFile(CLIENT)}` },
		/block comment is still open at EOF/,
	);

	// The F7 test having no DRIVEN table at all must RAISE, not read as zero driven builders.
	try {
		scan(fixtureIo({ [F7_TEST]: "// nothing here" }), {});
		problems.push("an F7 test with no `DRIVEN` table was accepted — the subject check would then pass by finding nothing.");
	} catch (err) {
		if (!/no longer declares a `const DRIVEN` table/.test(String(err.message))) {
			problems.push(`an F7 test with no DRIVEN table raised the wrong error: ${err.message}`);
		}
	}
	try {
		scan(fixtureIo({ [F7_TEST]: null }), {});
		problems.push("a MISSING F7 test was accepted — F7 would then be scored from nothing.");
	} catch (err) {
		if (!/is missing/.test(String(err.message))) problems.push(`a missing F7 test raised the wrong error: ${err.message}`);
	}

	// The route join: a page with no surface must be N/A, and a list page must not be.
	const joined = scoreRoutes(
		base,
		new Map([
			["/list", new Set([STORE, CLIENT, "apps/console/lib/queries/widgets.ts"])],
			["/plain", new Set(["apps/console/app/page.tsx"])],
		]),
		["/list", "/plain"],
	);
	const na = joined.filter((v) => v.route === "/plain");
	if (na.length !== PREDICATES.length || !na.every((v) => v.verdict === "N/A" && v.reason === "not-a-list-page")) {
		problems.push("a page with no filter store did not score N/A `not-a-list-page` on all seven predicates.");
	}
	if (na.some((v) => !NA_REASONS.includes(v.reason))) {
		problems.push("the route join emitted an N/A reason family F does not declare — RUBRIC.md's rule 1 makes that an error, not a verdict.");
	}
	const list = joined.filter((v) => v.route === "/list");
	if (!list.every((v) => v.verdict === "PASS")) {
		problems.push(`the clean fixture's list page did not pass every predicate: ${JSON.stringify(list.filter((v) => v.verdict !== "PASS"))}`);
	}
	const noBuilder = scoreRoutes(base, new Map([["/list", new Set([STORE, CLIENT])]]), ["/list"]);
	if (noBuilder.find((v) => v.predicate === "F7")?.verdict !== "FAIL") {
		problems.push("a list page whose closure reaches NO facet-bearing builder did not FAIL F7.");
	}

	return problems;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Parse argv, refusing an unknown flag.
 *
 * `process.argv.includes("--self-test")` is how a typo becomes a full scan reported as a
 * self-test — `check-shared-surface.mjs` carries that incident. So the flags are parsed, and
 * anything unrecognised exits 2 before a byte of the tree is read.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
	const known = new Set(["--self-test", "--json"]);
	const unknown = argv.filter((a) => a.startsWith("-") && !known.has(a));
	if (unknown.length > 0) return { error: `unknown flag(s): ${unknown.join(", ")}. Known: ${[...known].join(", ")}.` };
	return { selfTest: argv.includes("--self-test"), json: argv.includes("--json") };
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.error !== undefined) {
		console.error(`::error::filter-standard: ${args.error}`);
		process.exit(2);
	}

	if (args.selfTest) {
		const problems = positiveControl();
		for (const p of problems) console.error(`FAIL - ${p}`);
		if (problems.length > 0) {
			console.error(`\n${problems.length} control(s) broken.`);
			process.exit(1);
		}
		console.log("ok   - check-filter-standard: every F1–F6 matcher fires in both directions, every vacuity floor refuses, and the route join emits only RUBRIC.md's declared N/A reason.");
		return;
	}

	const scanned = scan(fsIo(REPO_ROOT));
	if (args.json) {
		console.log(
			JSON.stringify(
				{
					census: scanned.census,
					surfaces: scanned.surfaces.map((s) => ({ symbol: s.symbol, file: s.file, factory: s.factory, consumers: s.consumers })),
					builders: scanned.builders,
					driven: [...scanned.driven].sort(),
					undriven: Object.keys(F7_UNDRIVEN).sort(),
					perSurface: scanned.perSurface,
					problems: scanned.problems,
				},
				null,
				"\t",
			),
		);
		process.exit(scanned.problems.length > 0 ? 1 : 0);
	}

	// The census is printed on EVERY run, pass or fail. A collapse the floors above cannot see —
	// one root emptying while another grows — is then visible in the diff of two CI logs.
	const roots = scanned.census.map(([r, n]) => `${r.replace("apps/console/", "")} ${n}`).join(", ");
	for (const p of scanned.problems) console.error(`::error::filter-standard: ${p}`);
	if (scanned.problems.length > 0) {
		console.error(`\n${scanned.problems.length} problem(s) (modules per root — ${roots}).`);
		process.exit(1);
	}

	/** @type {Record<string, {pass: number, fail: number}>} */
	const tally = {};
	for (const id of PREDICATES.filter((p) => p !== "F7")) tally[id] = { pass: 0, fail: 0 };
	for (const verdicts of Object.values(scanned.perSurface)) {
		for (const [id, v] of Object.entries(verdicts)) tally[id][v.verdict === "PASS" ? "pass" : "fail"] += 1;
	}
	console.log(
		`✓ check-filter-standard: ${scanned.surfaces.length} filter surface(s) across ` +
			`${new Set(scanned.surfaces.map((s) => s.file)).size} store module(s); ${scanned.builders.length} ` +
			`facet-bearing server builder(s), ${scanned.driven.size} driven by ${F7_TEST} and ` +
			`${Object.keys(F7_UNDRIVEN).length} declared undriven. Per surface — ` +
			`${PREDICATES.filter((p) => p !== "F7").map((id) => `${id} ${tally[id].pass}/${tally[id].pass + tally[id].fail}`).join(", ")} ` +
			`(modules per root — ${roots}).`,
	);
	console.log(
		"  F1–F6 are SCORED, not gated, here: `apps/console/scripts/audit-report.mjs` joins them to the route\n" +
			"  set and CI diffs `apps/console/ui-conformance-baseline.json` against the tree, so a conformance\n" +
			"  regression reds there naming the route it moved. What this check fails on is a broken subject set.",
	);
	for (const [symbol, verdicts] of Object.entries(scanned.perSurface)) {
		const fails = Object.entries(verdicts).filter(([, v]) => v.verdict === "FAIL");
		if (fails.length === 0) continue;
		console.log(`  ${symbol}: ${fails.map(([id, v]) => `${id} — ${v.detail}`).join("\n      ")}`);
	}
}

// This module is imported by `apps/console/scripts/audit-report.mjs`. Without the entrypoint
// guard an `import` of this file would be an INVOCATION of the guard, and could `process.exit`
// before the caller ran a line — the obstacle `check-shared-surface.mjs` still forces that file's
// callers to work around with a child process.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
