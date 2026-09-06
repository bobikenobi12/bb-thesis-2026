#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The ONE definition of "the console's private route set", shared by every consumer in the
// console-UI conformance wave: the static shared-surface matchers, the route-state gate, the live
// Playwright audit project, and the scoreboard generator.
//
// It is a separate module for the same reason `scripts/lib/ts-coverage-measure.mjs` is: there is
// more than one consumer, and when two of them define the subject differently, one of them is
// lying — and here the subject IS the denominator of every score the wave reports. A route the
// audit never visited and a route that scored zero are indistinguishable in a report whose route
// list came from somewhere else.
//
//   node scripts/lib/console-routes.mjs              # print the manifest as JSON
//   node scripts/lib/console-routes.mjs --json       # the same, said out loud
//   node scripts/lib/console-routes.mjs --summary    # one line per route, for eyeballing
//   node scripts/lib/console-routes.mjs --self-test
//   node scripts/lib/console-routes.mjs --help
//
// `pnpm check:console-routes` runs it over the real tree (every raise below is a CI failure) and
// CI runs `--self-test` beside it — see the two steps in `.github/workflows/ci.yml`'s
// `Authz / open-core guards` job. A self-test nothing re-runs asserts only that the file was
// correct on the day it was written.
//
// An argument this list does not name is an ERROR (exit 2), not a shrug that falls through to the
// JSON. `--summry` printing a perfectly valid manifest and exiting 0 is the same silent success
// the next paragraph exists to prevent, one layer up. `parseCliArgs` below is the whole parser and
// the self-test drives it.
//
// Do NOT pipe it. `node scripts/lib/console-routes.mjs | tail` reports TAIL's exit code, which is
// always 0, and every raise below becomes invisible.
//
// ── WHY IT RAISES INSTEAD OF RETURNING [] ────────────────────────────────────────────────────
//
// A scan that finds nothing and a tree with nothing wrong produce the same value, and the whole
// wave is built on top of this one. If `app/(private)` is renamed, moved into another route group,
// or simply mistyped by a caller, every downstream check would report a clean bill of health over
// zero files — the exact failure `scripts/check-shared-surface.mjs` grew census floors to prevent
// and `apps/console/scripts/check-dead-code.mjs` grew entry-glob assertions to prevent. So:
// zero routes RAISES, an unreadable directory RAISES, and a page whose segment chain cannot be
// resolved RAISES. There is no "0 routes, all good" branch in this file, deliberately.
//
// ── WHAT IS DERIVED VS. WHAT IS DECLARED ─────────────────────────────────────────────────────
//
// Everything about the route tree is derived by walking it. The one thing that could have been a
// hand-written list — WHICH components count as a page shell — is derived too, by scanning
// `apps/console/components/**` for an exported `*Shell` and matching the layout chain against
// what it finds. A typed list of four shell names would stop covering the day a fifth shipped,
// and it would stop covering SILENTLY, which is the failure mode this repo has paid for most
// often. `AuthShell` and `ConnectSheetShell` are FOUND by that scan and carry no exclusion in code:
// they simply never appear in a `(private)` layout chain today, because AuthShell wraps `(public)`
// and ConnectSheetShell is a sheet rather than a page shell. That is exclusion by SCOPE — a
// property of the tree being walked, not a rule this file enforces — so either would become a
// route's `shell` the day a private layout mounted it. Stated rather than implied, because an
// earlier draft of this comment said AuthShell "is excluded", which reads as a guarantee that
// nothing here provides.

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bumped when a record field changes meaning. A consumer that pins a version cannot silently read
 * a field that now means something else.
 */
export const RECORD_VERSION = 1;

/** Next.js segment-level files whose nearest ancestor-or-self occurrence a page inherits. */
const BOUNDARY_FILES = /** @type {const} */ ([
	"layout",
	"loading",
	"error",
	"not-found",
	"template",
]);

/**
 * The extensions Next.js resolves a routing file from — its `pageExtensions` default, which
 * `apps/console/next.config.ts` does not override.
 *
 * This is not pedantry about a case the console does not have today. Matching `page.tsx` ALONE
 * makes the manifest under-count, and an under-counting manifest is worse than no manifest at
 * all, because every downstream check in the wave reads its route list as complete: a page the
 * audit never visited and a page that does not exist are the same absence. Measured: against a
 * tree holding `page.tsx` and `app/(private)/[org]/go/page.ts`, the `page.tsx`-only walker
 * returned ONE route where Next serves two and raised nothing — the scan's own silent-green
 * failure mode, in the file whose header argues against exactly that. `loading.js` and
 * `error.jsx` read as "no boundary" the same way, which flips predicate T1 from FAIL to a
 * passing "nothing to inherit". The self-test now fails in three places if this list shrinks.
 *
 * Ordering is irrelevant — no member is a suffix of another, so `endsWith` cannot be ambiguous
 * (`page.tsx` does not end in `.ts`, `page.jsx` does not end in `.js`).
 *
 * EXPORTED because `check-route-states.mjs` resolves a `not-found.<ext>` in a directory the
 * record does not name (the segment ABOVE a layout that throws), and a second hand-typed copy of
 * this list would stop matching the day this one changes — silently, in the direction that reads
 * "no boundary there" as "nothing to report".
 */
export const PAGE_EXTENSIONS = /** @type {const} */ (["tsx", "ts", "jsx", "js"]);

/**
 * `"page.tsx"` → `"page"`, `"loading.js"` → `"loading"`, `"styles.css"` → `null`.
 *
 * @param {string} filename
 * @returns {string|null} the routing-file base name, or null when the file is not one Next
 *   resolves a route or a boundary from.
 */
function routeFileBase(filename) {
	for (const ext of PAGE_EXTENSIONS) {
		const suffix = `.${ext}`;
		if (filename.endsWith(suffix)) return filename.slice(0, -suffix.length);
	}
	return null;
}

/** Directories under `app/` that never contribute a URL segment. */
const isRouteGroup = (seg) => seg.startsWith("(") && seg.endsWith(")");
/** `@slot` — a parallel route. None exist today; if one appears the caller should know. */
const isParallelSlot = (seg) => seg.startsWith("@");
/** `_private` — a Next.js private folder, opted out of routing entirely. */
const isPrivateFolder = (seg) => seg.startsWith("_");

/**
 * JSX is present iff the source closes or self-closes a tag. Deliberately NOT `<[A-Za-z]`, which
 * matches `Array<string>` and every other TypeScript generic — the redirect-only pages this
 * distinguishes are full of `Promise<{ org: string }>`.
 */
const hasJsx = (src) => /<\/[A-Za-z]/.test(src) || /\/>/.test(src);

/**
 * True when every quote character is closed before `index` on this line — i.e. `index` is NOT
 * inside a string literal that opened on this line. Deliberately conservative in the LOUD
 * direction: an apostrophe in JSX text leaves the counts odd, so a comment after it is scanned as
 * code and can only produce a false positive, never a skipped line.
 */
function quotesClosedBefore(line, index) {
	let dq = 0;
	let sq = 0;
	let bt = 0;
	for (let i = 0; i < index; i++) {
		const c = line[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === '"') dq++;
		else if (c === "'") sq++;
		else if (c === "`") bt++;
	}
	return dq % 2 === 0 && sq % 2 === 0 && bt % 2 === 0;
}

/**
 * Blank every comment, line by line, keeping one output line per input line.
 *
 * ── THE ONE DEFINITION OF "IS THIS A COMMENT", AND WHY IT LIVES HERE ─────────────────────────
 *
 * This is the reviewed implementation. A naive `source.replace(/\/\*[\s\S]*?\*\//g, "")` plus a
 * brace count was written first and RAISED on `components/agent/agent-knowledge-panel.tsx` — 12
 * opens against 13 closes — because a bare `/*` mid-line is indistinguishable from a glob inside
 * a string (`"apps/*\/**"`), and blanking from there swallows live code. Two definitions of "is
 * this a comment" means one of them is wrong, and the wrong one does not report a finding: it
 * refuses a file, or silently blanks the code a predicate was going to read.
 *
 * It was a COPY of `scripts/check-shared-surface.mjs`'s own stripper until #3787 (closing #3689),
 * which deleted that copy and made the checker import this one. There is now ONE definition, and
 * a change to it is made in one place. A differential harness over 2,726 repo files plus 18
 * adversarial cases found 0 divergences before they were collapsed, so nothing was lost.
 *
 * THE DIRECTION IS FORCED, AND IT IS NOT AN ACCIDENT OF WHO IMPORTED WHOM FIRST. This module is a
 * library: importing it runs no check and prints nothing. `check-shared-surface.mjs` is a guard —
 * importing it is importing a program. That asymmetry is the reason the definition lives here and
 * not there, and it does not depend on whether the checker happens to carry an entrypoint guard on
 * any given day. If you are tempted to move this function into the checker and import it back,
 * that is the second import path #3689 existed to remove.
 *
 * @returns {{lines: string[], unterminated: boolean}} `unterminated` when a block comment was
 *   still open at EOF — the one state in which this has blanked live code, so the caller must
 *   refuse the file rather than read it.
 */
export function stripCommentLines(source) {
	/** @type {string[]} */
	const out = [];
	let inBlock = false;
	for (const line of source.split("\n")) {
		if (inBlock) {
			const end = line.indexOf("*/");
			if (end === -1) {
				out.push("");
				continue;
			}
			inBlock = false;
			out.push(line.slice(end + 2));
			continue;
		}
		const trimmed = line.trimStart();
		if (trimmed.startsWith("//")) {
			out.push("");
			continue;
		}
		// `{/*` is taken anywhere on the line PROVIDED the quotes ahead of it are closed: a brace
		// followed by a block-comment open, outside a string, is a JSX comment and can be nothing
		// else. A bare `/*` is only taken when it OPENS the line.
		const jsx = line.indexOf("{/*");
		const jsxOpen = jsx !== -1 && quotesClosedBefore(line, jsx) ? jsx + 1 : -1;
		const open = jsxOpen !== -1 ? jsxOpen : trimmed.startsWith("/*") ? line.indexOf("/*") : -1;
		if (open === -1) {
			out.push(line);
			continue;
		}
		const end = line.indexOf("*/", open + 2);
		if (end === -1) {
			inBlock = true;
			out.push(line.slice(0, open));
			continue;
		}
		out.push(line.slice(0, open) + line.slice(end + 2));
	}
	return { lines: out, unterminated: inBlock };
}

/** `stripCommentLines`, raising on the one state where it has blanked live code. */
function stripComments(src, label) {
	const { lines, unterminated } = stripCommentLines(src);
	if (unterminated) {
		throw new Error(
			`${label}: a block comment is still open at EOF — refusing to read it, because ` +
				`everything after the opener has been blanked and would silently stop matching`,
		);
	}
	return lines.join("\n");
}

function readDirOrRaise(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		// An unreadable directory RAISES. Counting it as empty is how a scan reports green over a
		// tree it never read.
		throw new Error(`cannot read ${dir}: ${err.message}`);
	}
}

function readFileOrRaise(file) {
	try {
		return readFileSync(file, "utf8");
	} catch (err) {
		throw new Error(`cannot read ${file}: ${err.message}`);
	}
}

/**
 * Every exported `*Shell` component under `apps/console/components/**`, as
 * `{ name, file }`. Derived, never typed — see the header.
 */
export function discoverShells(componentsDir) {
	/** @type {{name: string, file: string}[]} */
	const found = [];
	const walk = (dir) => {
		for (const entry of readDirOrRaise(dir)) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			// A shell renders JSX, so it lives in a `.tsx`/`.jsx` file. Both, for the same reason
			// `PAGE_EXTENSIONS` has four members: the scan must not go quiet on a spelling.
			if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".jsx")) continue;
			const src = stripComments(readFileOrRaise(full), full);
			for (const m of src.matchAll(
				/export\s+(?:async\s+)?(?:function|const)\s+([A-Z][A-Za-z0-9]*Shell)\b/g,
			)) {
				found.push({ name: m[1], file: full });
			}
		}
	};
	walk(componentsDir);
	if (found.length === 0) {
		throw new Error(
			`no exported *Shell component found under ${componentsDir} — the shell scan is broken, ` +
				`not the tree (every private page is wrapped by one)`,
		);
	}
	return found;
}

/**
 * Resolve one page file into a route record.
 *
 * @param {object} args
 * @param {string} args.appDir      absolute path to `apps/console/app`
 * @param {string} args.pageFile    absolute path to a `page.<PAGE_EXTENSIONS>`
 * @param {Map<string, Map<string, string>>} args.boundaries  dir → boundary name → the FILENAME
 *   that provides it. The filename, not merely the name, because `layout.js` and `layout.tsx` are
 *   the same boundary and reporting the wrong one names a file that does not exist.
 * @param {{name: string, file: string}[]} args.shells
 * @param {string} args.repoRoot
 */
function toRecord({ appDir, pageFile, boundaries, shells, repoRoot }) {
	const dir = path.dirname(pageFile);
	const rel = path.relative(appDir, dir);
	// `path.relative` gives "" for the app root itself; split would then yield [""].
	const segments = rel === "" ? [] : rel.split(path.sep);

	for (const seg of segments) {
		if (isParallelSlot(seg)) {
			throw new Error(
				`${pageFile}: parallel route slot "${seg}" — no consumer of this manifest handles ` +
					`slots, and silently flattening one would report a route that does not exist`,
			);
		}
		if (isPrivateFolder(seg)) {
			throw new Error(`${pageFile}: lives under private folder "${seg}" but declares a page`);
		}
	}

	const urlSegments = segments.filter((s) => !isRouteGroup(s));
	const route = urlSegments.length === 0 ? "/" : `/${urlSegments.join("/")}`;

	// `[org]` → org · `[...rest]` → rest (catch-all) · `[[...rest]]` → rest (optional catch-all)
	const params = urlSegments
		.filter((s) => s.startsWith("[") || s.startsWith("[["))
		.map((s) => ({
			segment: s,
			name: s.replace(/^\[+\.{0,3}/, "").replace(/\]+$/, ""),
			catchAll: s.includes("..."),
			optional: s.startsWith("[["),
		}));

	// ── Nearest ancestor-or-self boundary, per Next.js segment semantics ─────────────────────
	// A `loading.tsx` at a segment covers that segment AND everything nested below it, so the one
	// a page actually renders is the CLOSEST, not merely "one exists somewhere above". Predicate
	// T1 turns on that distinction: `~/jobs/[id]` has an ancestor loading and it is the wrong one.
	/** @type {Record<string, {file: string|null, own: boolean, distance: number|null}>} */
	const inherited = {};
	/** @type {string[]} */
	const layoutChain = [];

	for (const name of BOUNDARY_FILES) {
		inherited[name] = { file: null, own: false, distance: null };
	}

	// Walk self → root. `depth` counts segments above the page's own directory.
	for (let depth = 0; depth <= segments.length; depth++) {
		const ancestorSegments = segments.slice(0, segments.length - depth);
		const ancestorDir = path.join(appDir, ...ancestorSegments);
		const present = boundaries.get(ancestorDir) ?? new Map();
		for (const name of BOUNDARY_FILES) {
			const filename = present.get(name);
			if (filename === undefined) continue;
			const relFile = path.relative(repoRoot, path.join(ancestorDir, filename));
			if (inherited[name].file === null) {
				inherited[name] = { file: relFile, own: depth === 0, distance: depth };
			}
			if (name === "layout") layoutChain.unshift(relFile);
		}
	}

	// ── Which shell owns this page ───────────────────────────────────────────────────────────
	// The innermost shell mounted anywhere in the layout chain. It is the innermost one that owns
	// the content width (predicates S1–S4): `[project]/settings/layout.tsx` mounts SettingsShell
	// inside ProjectShell inside AppShell, and the 1200px belongs to the SettingsShell.
	/** @type {string[]} */
	const shellChain = [];
	for (const layoutRel of layoutChain) {
		const src = stripComments(
			readFileOrRaise(path.join(repoRoot, layoutRel)),
			layoutRel,
		);
		// ORDER BY POSITION IN THE SOURCE, NOT BY DISCOVERY ORDER, AND LET A RE-MOUNT MOVE.
		//
		// `shell` below is `shellChain[last]` and is read as the innermost — the width owner. Two
		// shapes broke that, and both are one refactor away rather than hypothetical:
		//   · one layout mounting two shells (`<AppShell><SettingsShell>`) pushed them in `shells`
		//     DISCOVERY order, which is filesystem order over components/**, so the outer one could
		//     land last and be reported as the owner;
		//   · `!shellChain.includes(name)` pinned a shell to its OUTERMOST appearance, so a shell
		//     re-mounted at a deeper layout kept the ancestor's slot.
		// Sorting this layout's mounts by their index in the source fixes the first; deleting a
		// prior occurrence before pushing fixes the second. Layouts are walked outermost-first, so
		// appending per layout keeps the chain in nesting order.
		const mountedHere = shells
			.map((shell) => ({ name: shell.name, at: src.search(new RegExp(`<${shell.name}\\b`)) }))
			// A JSX mount (`<AppShell`), not a mere import — a layout may import a type or a helper
			// from the same module without rendering it.
			.filter((hit) => hit.at >= 0)
			.sort((a, b) => a.at - b.at);
		for (const hit of mountedHere) {
			const prior = shellChain.indexOf(hit.name);
			if (prior >= 0) shellChain.splice(prior, 1);
			shellChain.push(hit.name);
		}
	}

	const pageSrcRaw = readFileOrRaise(pageFile);
	const pageSrc = stripComments(pageSrcRaw, pageFile);

	return {
		route,
		file: path.relative(repoRoot, pageFile),
		dir: path.relative(repoRoot, dir),
		segments,
		urlSegments,
		params,
		/** No JSX anywhere and a `redirect()` call: the page renders nothing a user can look at. */
		isRedirectOnly: /\bredirect\s*\(/.test(pageSrc) && !hasJsx(pageSrc),
		/**
		 * T4. `generateMetadata` may live on a sibling layout for a client page — hence both.
		 *
		 * A TITLE, NOT MERELY A `metadata` EXPORT. The export alone does not answer T4: a metadata
		 * object may declare only `robots`, `openGraph` or `alternates` and never name the page.
		 * `app/(private)/layout.tsx` is exactly that shape, and because T4 is declared never-N/A
		 * ("a redirect still owns a title"), a noindex-only layout scored PASS with no title
		 * anywhere — the predicate reporting satisfied on evidence that does not bear on it.
		 *
		 * `generateMetadata` is accepted on sight because it is a function: what it returns cannot
		 * be read statically, and refusing it would flip the error to the other side and fail every
		 * page that computes its title. Only the object form is inspected for a `title`.
		 */
		hasMetadata: declaresTitle(pageSrc) ||
			(inherited.layout.own &&
				declaresTitle(
					stripComments(
						readFileOrRaise(path.join(repoRoot, inherited.layout.file)),
						inherited.layout.file,
					),
				)),
		boundaries: inherited,
		layoutChain,
		shellChain,
		/** The width owner, or `null` when no known shell wraps the page at all. */
		shell: shellChain.length ? shellChain[shellChain.length - 1] : null,
	};
}

/**
 * Does this source name the page — i.e. satisfy T4 — rather than merely export a metadata object?
 *
 * `export async function generateMetadata` and `export function generateMetadata` count on sight:
 * the title is computed at request time and cannot be read out of the source, so demanding a literal
 * would fail every page that builds its title from data. `export const metadata` is inspected, and
 * only a `title` key in it counts — an object declaring `robots`/`openGraph`/`alternates` and no
 * title does not name the page, which is the whole of T4.
 *
 * @param {string} src comment-stripped source
 * @returns {boolean}
 */
function declaresTitle(src) {
	if (/\bexport\s+(?:async\s+function|function)\s+generateMetadata\b/.test(src)) return true;
	const m = src.match(/\bexport\s+const\s+metadata\b[^=]*=\s*(\{[\s\S]*?\n\})/);
	if (m) return /(^|[{,\s])title\s*:/.test(m[1]);
	// `export const metadata: Metadata = someIdentifier` — not an object literal we can read. Accept
	// it for the same reason as generateMetadata: unreadable is not the same as absent, and refusing
	// here would fail a page whose metadata is composed elsewhere.
	return /\bexport\s+const\s+metadata\b/.test(src);
}

/**
 * Collect every private console route.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]  repository root; defaults to two levels above this file
 * @param {string} [opts.scope]     app subdirectory to walk, relative to `apps/console/app`
 * @returns {{version: number, appDir: string, scope: string, routes: object[], shells: object[]}}
 */
export function collectConsoleRoutes(opts = {}) {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const repoRoot = opts.repoRoot ?? path.resolve(here, "..", "..");
	const scope = opts.scope ?? "(private)";
	const appDir = path.join(repoRoot, "apps", "console", "app");
	const scopeDir = path.join(appDir, scope);
	const componentsDir = path.join(repoRoot, "apps", "console", "components");

	// Fail on the SCOPE, not on the app root: `app/` existing proves nothing about `(private)`
	// still being called that.
	let scopeStat;
	try {
		scopeStat = statSync(scopeDir);
	} catch {
		throw new Error(
			`${scopeDir} does not exist — the private route group has moved or been renamed. Every ` +
				`consumer of this manifest would otherwise report a clean tree over zero routes.`,
		);
	}
	if (!scopeStat.isDirectory()) throw new Error(`${scopeDir} is not a directory`);

	const shells = discoverShells(componentsDir);

	/** @type {string[]} */
	const pageFiles = [];
	/** @type {Map<string, Map<string, string>>} */
	const boundaries = new Map();

	// Boundaries are collected from the WHOLE app tree, not just the scope: a page inside
	// `(private)` inherits `app/error.tsx` and `app/layout.tsx`, which sit above it.
	const walk = (dir, inScope) => {
		/** @type {Map<string, string>} */
		const here = new Map();
		for (const entry of readDirOrRaise(dir)) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full, inScope || full === scopeDir);
				continue;
			}
			const base = routeFileBase(entry.name);
			if (base === null) continue;
			if (base === "page") {
				if (inScope) pageFiles.push(full);
				continue;
			}
			if (!BOUNDARY_FILES.includes(base)) continue;
			// Two spellings of one boundary in one directory: Next resolves exactly one of them and
			// the losing file is dead. Picking one here would silently attribute behaviour to a file
			// that never renders, so it RAISES — the same reason two pages on one URL do.
			const already = here.get(base);
			if (already !== undefined) {
				throw new Error(
					`${dir}: both ${already} and ${entry.name} provide the "${base}" boundary — Next ` +
						`renders one and ignores the other, and this manifest cannot say which.`,
				);
			}
			here.set(base, entry.name);
		}
		if (here.size) boundaries.set(dir, here);
	};
	walk(appDir, false);

	if (pageFiles.length === 0) {
		throw new Error(
			`no page.{${PAGE_EXTENSIONS.join(",")}} found under ${scopeDir} — this is a broken scan, ` +
				`not an empty app. Refusing to hand every downstream check a zero-route manifest it ` +
				`would report green over.`,
		);
	}

	const routes = pageFiles
		.sort()
		.map((pageFile) => toRecord({ appDir, pageFile, boundaries, shells, repoRoot }));

	// Two routes resolving to one URL means the resolver dropped a distinguishing segment.
	const seen = new Map();
	for (const r of routes) {
		if (seen.has(r.route)) {
			throw new Error(
				`route "${r.route}" is produced by two page files — ${seen.get(r.route)} and ${r.file}. ` +
					`The segment resolver has dropped something that distinguishes them.`,
			);
		}
		seen.set(r.route, r.file);
	}

	return {
		version: RECORD_VERSION,
		appDir: path.relative(repoRoot, appDir),
		scope,
		routes,
		shells: shells.map((s) => ({ name: s.name, file: path.relative(repoRoot, s.file) })),
	};
}

// ── CLI argument parsing ─────────────────────────────────────────────────────────────────────

/** What the CLI was asked to do, or why the arguments were refused. */
export const USAGE = [
	"Usage: node scripts/lib/console-routes.mjs [--json|--summary|--self-test|--help]",
	"",
	"  (no argument)  print the private-route manifest as JSON",
	"  --json         the same, said out loud",
	"  --summary      one line per route, for eyeballing",
	"  --self-test    run the fixture suite; exit 1 on any failure",
	"  --help, -h     this text",
].join("\n");

/**
 * The whole argument parser, pulled out of the entrypoint so the self-test can drive it.
 *
 * An unrecognised argument is an ERROR, never a fall-through to the default mode. Before this,
 * `--summry` (and `--help`) printed a valid-looking manifest and exited 0: the caller's typo was
 * indistinguishable from a successful run, in the one tool every later conformance check in this
 * wave is driven by. Exactly one mode may be named, because `--summary --json` has no honest
 * answer and picking one silently is the same defect wearing a different hat.
 *
 * @param {string[]} argv  arguments after the script name (`process.argv.slice(2)`)
 * @returns {{mode: "json"|"summary"|"self-test"|"help", error: null} |
 *           {mode: null, error: string}}
 */
export function parseCliArgs(argv) {
	/** @type {Record<string, "json"|"summary"|"self-test"|"help">} */
	const MODES = {
		"--json": "json",
		"--summary": "summary",
		"--self-test": "self-test",
		"--help": "help",
		"-h": "help",
	};
	if (argv.length === 0) return { mode: "json", error: null };
	const unknown = argv.filter((a) => !(a in MODES));
	if (unknown.length > 0) {
		return {
			mode: null,
			error: `unrecognised argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
		};
	}
	// `--help` anywhere wins: asking for help and being handed an error about the OTHER flag is
	// the least useful thing this could do.
	if (argv.some((a) => MODES[a] === "help")) return { mode: "help", error: null };
	const distinct = [...new Set(argv.map((a) => MODES[a]))];
	if (distinct.length > 1) {
		return { mode: null, error: `${distinct.join(" and ")} cannot both be asked for` };
	}
	return { mode: distinct[0], error: null };
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────
// Fixtures over a real temporary tree, not mocks: the thing under test is filesystem walking and
// Next.js segment semantics, and a mocked `readdirSync` would prove only that the mock agrees with
// itself. Every assertion that matters here is about the NEAREST boundary, because that is the
// distinction predicate T1 rests on and the one an "an ancestor exists" implementation gets wrong.

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

	const root = mkdtempSync(path.join(tmpdir(), "console-routes-"));
	const app = path.join(root, "apps", "console", "app");
	const components = path.join(root, "apps", "console", "components");
	const put = (rel, body) => {
		const full = path.join(root, rel);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, body);
	};

	put("apps/console/components/shell/app-shell.tsx", "export function AppShell() { return null; }");
	put(
		"apps/console/components/settings/settings-shell.tsx",
		"export function SettingsShell() { return null; }",
	);
	// A `.jsx` shell. The scan matched `.tsx` alone and would have missed this one silently.
	put("apps/console/components/legacy/legacy-shell.jsx", "export function LegacyShell() { return null; }");
	put("apps/console/app/layout.tsx", "export default function L() { return null; }");
	put("apps/console/app/error.tsx", "export default function E() { return null; }");
	put("apps/console/app/(private)/layout.tsx", "export default function P() { return null; }");
	put(
		"apps/console/app/(private)/[org]/layout.tsx",
		"import { AppShell } from '@/components/shell/app-shell';\nexport default function O() { return <AppShell />; }",
	);
	put("apps/console/app/(private)/[org]/loading.tsx", "export default function Sk() { return <div />; }");
	put("apps/console/app/(private)/[org]/page.tsx", "export const metadata = {};\nexport default function Pg() { return <div />; }");
	// A nested page with NO own loading — must inherit [org]'s at distance 2, not claim its own.
	put("apps/console/app/(private)/[org]/~/deep/page.tsx", "export default function D() { return <div />; }");
	// A nested page WITH its own loading — nearest must be itself, distance 0.
	put("apps/console/app/(private)/[org]/~/near/loading.tsx", "export default function N() { return <div />; }");
	put("apps/console/app/(private)/[org]/~/near/page.tsx", "export default function N2() { return <div />; }");
	// Settings subtree: innermost shell must win over the outer AppShell.
	put(
		"apps/console/app/(private)/[org]/~/settings/layout.tsx",
		"import { SettingsShell } from '@/components/settings/settings-shell';\nexport default function S() { return <SettingsShell />; }",
	);
	// The generic here is `Record<string, …>`, NOT `Promise<{ … }>`, and the difference is the whole
	// assertion. `<{` cannot match a naive `/<[A-Za-z]/` JSX detector, so a fixture using only
	// `Promise<{ org: string }>` passes whether the detector is right or wrong — measured: mutating
	// `hasJsx` to the naive form left the self-test fully green. `Record<string,` is what the real
	// `/dashboard/[[...rest]]` page contains and what actually separates the two implementations.
	put(
		"apps/console/app/(private)/[org]/~/settings/page.tsx",
		"import { redirect } from 'next/navigation';\n" +
			"export default async function SI({ searchParams }: { searchParams: Promise<Record<string, string[] | undefined>> }) {\n" +
			"  const sp = await searchParams; redirect(`/x/${Object.keys(sp).length}`);\n}",
	);

	// ── The non-.tsx routing files Next also resolves ────────────────────────────────────────
	// `pageExtensions` defaults to tsx/ts/jsx/js. A walker matching `page.tsx` alone returns
	// FEWER routes than Next serves and raises nothing — the manifest's own silent-green failure,
	// and the one every downstream check reads as a complete route list. These two pages exist to
	// fail that walker: mutate `PAGE_EXTENSIONS` back to `["tsx"]` and the count assertion below
	// drops from 6 to 4 while every other assertion here stays green.
	put(
		"apps/console/app/(private)/[org]/go/page.ts",
		"import { redirect } from 'next/navigation';\nexport default function G() { redirect('/x'); }",
	);
	put("apps/console/app/(private)/[org]/~/legacy/page.jsx", "export default function J() { return <div />; }");
	// ...and the boundaries beside them, in the other two spellings. A `loading.js` read as "no
	// boundary" turns predicate T1 from FAIL into a passing "nothing to inherit".
	put("apps/console/app/(private)/[org]/~/legacy/loading.js", "export default function JL() { return null; }");
	put("apps/console/app/(private)/[org]/~/legacy/error.jsx", "export default function JE() { return <div />; }");

	const m = collectConsoleRoutes({ repoRoot: root });
	// RAISES ON A LOST ROUTE RATHER THAN RETURNING undefined. Every assertion below dereferences
	// this immediately (`by("/[org]").params[0]`), so a route the walker stopped producing threw a
	// TypeError out of the self-test: no FAIL line, no tally, and the `rmSync` cleanup never ran —
	// a crash where the whole point was a verdict. Failing here names the missing route and lets the
	// harness report it as a failure like any other.
	const by = (r) => {
		const found = m.routes.find((x) => x.route === r);
		if (!found) {
			throw new Error(
				`self-test: the walker produced no route ${r}. Routes seen: ${m.routes.map((x) => x.route).join(", ") || "(none)"}`,
			);
		}
		return found;
	};

	// Six pages are placed above: [org], [org]/~/deep, [org]/~/near, [org]/~/settings, and the
	// two non-.tsx ones ([org]/go as page.ts, [org]/~/legacy as page.jsx).
	// Asserted against that count and not against whatever the walker returned — a self-test whose
	// expected value is read back out of the thing under test proves only that it is consistent.
	ok("walks the private scope and finds every page", m.routes.length === 6);
	ok("a page.ts route is not dropped", !!by("/[org]/go"));
	ok("a page.jsx route is not dropped", !!by("/[org]/~/legacy"));
	ok(
		"a loading.js is a boundary, not an absence",
		by("/[org]/~/legacy").boundaries.loading.own === true &&
			(by("/[org]/~/legacy").boundaries.loading.file ?? "").endsWith("loading.js"),
	);
	ok(
		"an error.jsx is a boundary, and is named by the file that actually exists",
		(by("/[org]/~/legacy").boundaries.error.file ?? "").endsWith("error.jsx") &&
			by("/[org]/~/legacy").boundaries.error.distance === 0,
	);
	ok("a redirect-only page.ts is still read as source", by("/[org]/go").isRedirectOnly === true);
	ok("route groups are dropped from the URL", !!by("/[org]"));
	ok("a literal `~` segment survives", !!by("/[org]/~/deep"));
	ok("dynamic params are named", by("/[org]").params[0]?.name === "org");

	ok(
		"a page with NO own loading inherits the NEAREST ancestor's",
		by("/[org]/~/deep").boundaries.loading.own === false &&
			by("/[org]/~/deep").boundaries.loading.distance === 2,
	);
	ok(
		"a page WITH its own loading resolves to itself at distance 0",
		by("/[org]/~/near").boundaries.loading.own === true &&
			by("/[org]/~/near").boundaries.loading.distance === 0,
	);
	ok(
		"an ancestor error boundary at the app root is found across the route group",
		by("/[org]").boundaries.error.distance === 2,
	);
	ok("a missing boundary is null, not a false positive", by("/[org]").boundaries["not-found"].file === null);

	ok("the innermost shell wins", by("/[org]/~/settings").shell === "SettingsShell");
	ok("the outer shell is still recorded in the chain", by("/[org]/~/settings").shellChain.includes("AppShell"));
	ok("shells are discovered, not typed", m.shells.length === 3);
	ok("a .jsx shell is discovered too", m.shells.some((s) => s.name === "LegacyShell"));

	ok("a redirect-only page is flagged", by("/[org]/~/settings").isRedirectOnly === true);
	ok("a rendering page is NOT flagged as redirect-only", by("/[org]").isRedirectOnly === false);
	ok(
		"a TypeScript generic is not mistaken for JSX",
		by("/[org]/~/settings").isRedirectOnly === true, // its source is full of `Promise<{ org: string }>`
	);
	ok("metadata is detected", by("/[org]").hasMetadata === true);
	ok("absent metadata is not invented", by("/[org]/~/deep").hasMetadata === false);

	// ── the anti-green controls: each must RAISE, not return empty ──────────────────────────
	const empty = mkdtempSync(path.join(tmpdir(), "console-routes-empty-"));
	mkdirSync(path.join(empty, "apps", "console", "app", "(private)"), { recursive: true });
	mkdirSync(path.join(empty, "apps", "console", "components"), { recursive: true });
	raises(
		"an empty components tree RAISES rather than finding no shells",
		() => collectConsoleRoutes({ repoRoot: empty }),
		"shell scan is broken",
	);

	const noShellNeeded = mkdtempSync(path.join(tmpdir(), "console-routes-nopages-"));
	mkdirSync(path.join(noShellNeeded, "apps", "console", "app", "(private)"), { recursive: true });
	mkdirSync(path.join(noShellNeeded, "apps", "console", "components"), { recursive: true });
	writeFileSync(
		path.join(noShellNeeded, "apps", "console", "components", "s.tsx"),
		"export function AppShell() { return null; }",
	);
	raises(
		"zero pages RAISES rather than returning an empty manifest",
		() => collectConsoleRoutes({ repoRoot: noShellNeeded }),
		"broken scan, not an empty app",
	);

	raises(
		"a missing scope directory RAISES and names the rename",
		() => collectConsoleRoutes({ repoRoot: root, scope: "(nope)" }),
		"has moved or been renamed",
	);

	const badComment = mkdtempSync(path.join(tmpdir(), "console-routes-comment-"));
	mkdirSync(path.join(badComment, "apps", "console", "components"), { recursive: true });
	writeFileSync(
		path.join(badComment, "apps", "console", "components", "s.tsx"),
		"/* opened and never closed\nexport function AppShell() { return null; }",
	);
	mkdirSync(path.join(badComment, "apps", "console", "app", "(private)"), { recursive: true });
	raises(
		"an unterminated block comment REFUSES its file",
		() => collectConsoleRoutes({ repoRoot: badComment }),
		"still open at EOF",
	);

	// A mutation the real tree cannot exercise: two pages resolving to one URL.
	const dup = mkdtempSync(path.join(tmpdir(), "console-routes-dup-"));
	const dupPut = (rel, body) => {
		const full = path.join(dup, rel);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, body);
	};
	dupPut("apps/console/components/s.tsx", "export function AppShell() { return null; }");
	dupPut("apps/console/app/(private)/(a)/x/page.tsx", "export default function A() { return <div />; }");
	dupPut("apps/console/app/(private)/(b)/x/page.tsx", "export default function B() { return <div />; }");
	raises(
		"two pages resolving to one URL RAISES",
		() => collectConsoleRoutes({ repoRoot: dup }),
		"produced by two page files",
	);

	// Two spellings of one page in one directory. Next resolves one; a manifest that lists both
	// has invented a route, and one that silently drops either has lost one.
	const dupExt = mkdtempSync(path.join(tmpdir(), "console-routes-dupext-"));
	const dupExtPut = (rel, body) => {
		const full = path.join(dupExt, rel);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, body);
	};
	dupExtPut("apps/console/components/s.tsx", "export function AppShell() { return null; }");
	dupExtPut("apps/console/app/(private)/x/page.tsx", "export default function A() { return <div />; }");
	dupExtPut("apps/console/app/(private)/x/page.ts", "export default function B() { return null; }");
	raises(
		"page.tsx and page.ts in ONE directory RAISES rather than picking one",
		() => collectConsoleRoutes({ repoRoot: dupExt }),
		"produced by two page files",
	);

	const dupBoundary = mkdtempSync(path.join(tmpdir(), "console-routes-dupbound-"));
	const dupBoundaryPut = (rel, body) => {
		const full = path.join(dupBoundary, rel);
		mkdirSync(path.dirname(full), { recursive: true });
		writeFileSync(full, body);
	};
	dupBoundaryPut("apps/console/components/s.tsx", "export function AppShell() { return null; }");
	dupBoundaryPut("apps/console/app/(private)/y/page.tsx", "export default function A() { return <div />; }");
	dupBoundaryPut("apps/console/app/(private)/y/loading.tsx", "export default function L1() { return null; }");
	dupBoundaryPut("apps/console/app/(private)/y/loading.js", "export default function L2() { return null; }");
	raises(
		"two spellings of one boundary in one directory RAISES",
		() => collectConsoleRoutes({ repoRoot: dupBoundary }),
		'provide the "loading" boundary',
	);

	// ── the CLI parser ───────────────────────────────────────────────────────────────────────
	// Driven directly, because the defect it replaced was invisible from the outside: an
	// unrecognised flag fell through to the manifest and exited 0, so the failing case and the
	// succeeding case printed the same thing.
	ok("no argument means JSON", parseCliArgs([]).mode === "json");
	ok("--summary is a mode", parseCliArgs(["--summary"]).mode === "summary");
	ok("--self-test is a mode", parseCliArgs(["--self-test"]).mode === "self-test");
	ok("--json is a mode", parseCliArgs(["--json"]).mode === "json");
	ok("--help is help, NOT the manifest", parseCliArgs(["--help"]).mode === "help");
	ok("-h is help", parseCliArgs(["-h"]).mode === "help");
	ok(
		"a typo'd flag is an ERROR, not the default mode",
		parseCliArgs(["--summry"]).mode === null &&
			(parseCliArgs(["--summry"]).error ?? "").includes("--summry"),
	);
	ok(
		"a bare positional argument is an ERROR too",
		parseCliArgs(["apps/console"]).mode === null,
	);
	ok(
		"two modes at once is an ERROR rather than a silent pick",
		parseCliArgs(["--summary", "--json"]).mode === null,
	);
	ok("--help wins over a second mode", parseCliArgs(["--summary", "--help"]).mode === "help");
	ok("the same mode twice is not a conflict", parseCliArgs(["--json", "--json"]).mode === "json");
	ok("USAGE names every flag the parser accepts", ["--json", "--summary", "--self-test", "--help"].every((f) => USAGE.includes(f)));

	for (const d of [root, empty, noShellNeeded, badComment, dup, dupExt, dupBoundary])
		rmSync(d, { recursive: true, force: true });

	console.log(failures === 0 ? "\nself-test: all passed" : `\nself-test: ${failures} FAILED`);
	return failures === 0 ? 0 : 1;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
const invokedDirectly =
	process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
	const parsed = parseCliArgs(process.argv.slice(2));
	if (parsed.error !== null) {
		console.error(`console-routes: ${parsed.error}\n\n${USAGE}`);
		process.exit(2);
	}
	if (parsed.mode === "help") {
		console.log(USAGE);
		process.exit(0);
	}
	if (parsed.mode === "self-test") {
		// A THROW IS A FAILING SELF-TEST, NOT A CRASH. Every assertion dereferences its subject
		// immediately, so a route the walker stopped producing used to escape as a TypeError: no
		// FAIL line, no tally, and a non-zero exit that read like the harness itself was broken
		// rather than like the thing under test. Catching here turns any escape into the verdict
		// the mode exists to produce.
		try {
			process.exit(selfTest());
		} catch (err) {
			console.error(`\nFAIL - the self-test raised before it could report: ${err.message}`);
			console.error("self-test: 1 FAILED (an assertion's subject was missing, not merely wrong)");
			process.exit(1);
		}
	}
	const manifest = collectConsoleRoutes();
	if (parsed.mode === "summary") {
		console.log(`${manifest.routes.length} private routes · shells: ${manifest.shells.map((s) => s.name).join(", ")}\n`);
		for (const r of manifest.routes) {
			const ld = r.boundaries.loading;
			const loading = ld.file === null ? "no-loading" : ld.own ? "own" : `inherited+${ld.distance}`;
			console.log(
				[
					r.route.padEnd(42),
					(r.shell ?? "NO-SHELL").padEnd(15),
					loading.padEnd(13),
					r.hasMetadata ? "meta" : "NO-META",
					r.isRedirectOnly ? " redirect-only" : "",
				].join(" "),
			);
		}
	} else {
		console.log(JSON.stringify(manifest, null, "\t"));
	}
}
