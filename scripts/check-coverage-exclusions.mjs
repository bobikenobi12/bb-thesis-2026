#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An exclusion's CLAIM is prose, and prose is not machine-read (#3262, lane A of #2649).
//
// `scripts/ts-coverage.mjs --self-test` already checks that a coverage exclusion still names a
// real FILE. Nothing checked the claim the exclusion carries. Those claims are TypeScript comments
// in the vitest configs — "verified by tests/integration/reconcile-b2c.test.ts (real Postgres)" —
// and one of them was measurably false: that suite imports `@/lib/reconcile/converge` and
// `@/lib/reconcile/reap` and NEVER imports `@/lib/reconcile/gc`; its retention-GC tests call the
// raw SQL functions directly, so the TypeScript wrappers are not executed. Two of gc.ts's three
// exports are reached by nothing at all — their only test reference is a `vi.mock`.
//
// That matters because the ratchet (#2649/T3) records floors over whatever scope the config leaves
// behind. A floor taken over a dishonest scope permanently blesses the hole it exists to close.
//
// So every exclusion gets an entry in a per-project `coverage-exclusions.yaml`, and the SECTION IS
// THE DECISION — the same vocabulary, for the same reason, as infra/offer-exclusions.yaml:
//
//   infrastructural:  not product code. The class is the argument; no evidence required.
//   tier_separation:  proven by another tier. Carries `suite:` and `symbols:`, and BOTH are
//                     re-read from the suite's own imports on every run.
//   baseline:         real debt. Carries `issue:` and `state:`, and is shrink-only.
//
// An entry is a DECISION, not a mute button. `baseline:` is what "we haven't got to it yet" is
// for; putting such a file in `tier_separation:` is the failure this guard exists to make loud.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CHECKS
//
//   D0  the config and the manifest agree in BOTH directions. A new exclusion with no manifest
//       entry fails; a manifest entry whose exclusion was removed from the config fails. A
//       coverage-emitting project with exclusions and NO manifest fails too, unless the project
//       itself carries a `coverage-exclusions.pending` marker — otherwise "every exclusion is
//       manifested" is a claim about the one project that happens to carry a manifest.
//   D1  every literal (non-glob) entry still names a real file. Globs stay unchecked HERE — see
//       the comment at ts-coverage.mjs:855, preserved: a glob matching nothing is
//       indistinguishable from a directory that emptied, and either way it misleads nobody. That
//       reasoning holds only for `infrastructural:`; a section carrying `suite:` and `symbols:`
//       must name one FILE, and `entryTarget` refuses a glob or a directory there.
//   D2  the named suite actually REACHES the module: a VALUE import of the module and of every
//       name in `symbols:`. `import type` is not evidence, `import { type X }` is not evidence,
//       `typeof import("m")` is not evidence, and a module the suite `vi.mock`s is not evidence —
//       a mock REPLACES the module, so the real code never runs and v8 records nothing. Adding
//       another `vi.mock` would satisfy "a test names it" while changing the coverage by exactly
//       zero. A `suite:` must also be a file vitest RUNS.
//   D2b a `baseline:` entry must still BE debt. Each `state:` is verified PER SYMBOL, and the
//       section is shrink-only: a listed export that a non-mocking test value-imports fails and
//       asks to be moved up.
//   D3  an `include` allowlist is an exclusion with the sign flipped: a file absent from a
//       hand-listed `include` is excluded just as surely, and the existing sweep, which walks
//       `coverage.exclude`, sees nothing at all.
//   D4  a `symbols:` list must be COMPLETE. Every runtime export of an excluded file is
//       accounted for in `symbols:` or in `baseline:`, and every name claimed is one the module
//       really exports. A list of 2 of 7 exports reads exactly like a list of all 7.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY IT REUSES ts-coverage.mjs's PARSER RATHER THAN GROWING ITS OWN
//
// `coverageArrayKey`/`coverageExcludes` carry two fixes bought with real defects: #2549 — a
// quoted phrase inside the coverage block's own prose comments is NOT an exclusion (the first
// version of that sweep "found" five stale paths that were comments); and #2724 — an array with
// CONTENT that parses to no entries returns null, and null is a FAILURE, never "no exclusions".
// A second copy of that parser is a place for both fixes to be missing from.
//
// Dependency-free for the same reason ts-coverage.mjs is: it must run in a DE-HYDRATED worktree
// with no node_modules, which is where it is cheapest to run and most likely to be run. That is
// also why the YAML reader below is hand-rolled and refuses anything it cannot parse.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// VACUITY
//
// Zero configs examined, zero manifests read, or zero entries checked is a FAILURE, never a pass.
// "Found nothing" and "looked at nothing" report identically otherwise, and a guard whose silent
// branch is indistinguishable from its green branch is the dominant defect class in this repo's
// own guards. Every run prints what it examined.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { coverageArrayKey, coverageExcludes, stripTsComments } from "./ts-coverage.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

/** The per-project manifest filename. One per coverage-emitting vitest project. */
const MANIFEST = "coverage-exclusions.yaml";

/** The only sections a manifest may declare. An unknown section is a FAILURE, not an ignore. */
const SECTIONS = ["infrastructural", "tier_separation", "baseline"];

/**
 * The `state:` vocabulary for a `baseline:` entry, and what each one asserts about the tests.
 *
 * Both are CHECKED, and that is the whole point. #1864 is the cautionary case from the offer
 * matrix: a claim nothing re-read could be discharged by RECLASSIFYING a measured gap rather than
 * fixing it — green either way. A `state:` the guard verifies cannot be used that way.
 */
const BASELINE_STATES = {
	"mock-only": "the only test reference is a `vi.mock`; the real module never runs",
	"no-test": "nothing in the project's tests names the module at all",
	// The third state exists because the first two are about the MODULE and the completeness check
	// (D4) asks about an EXPORT. `lib/fleet/queue.ts` is executed by six integration suites and
	// five of its sixteen exports are value-imported by none of them; recording those five as
	// `no-test` would be false and `mock-only` would be false, so without this state the only way
	// to account for them was to leave them out — which is the hole D4 exists to close.
	"untested-export": "a test executes the module, but no test value-imports these exports",
};

/** Extensions the resolver will try, in order, for a specifier with none. */
const EXTS = [".ts", ".tsx", ".mts", ".js", ".jsx"];

/** Source extensions a coverage `include` allowlist can be hand-listing. */
const SOURCE_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/** What vitest will actually run. A `suite:` naming anything else proves nothing about coverage. */
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/**
 * The classes `infrastructural:` may be used for, and why each one needs no evidence.
 *
 * `infrastructural:` is the one section that requires nothing — no suite, no symbols, no issue —
 * because the CLASS is the argument. That makes it the mute button the manifest's own header says
 * an entry is not, unless entering it is itself a checked claim: measured, moving
 * `lib/reconcile/gc.ts` (the headline defect of #3262) from `tier_separation:` into
 * `infrastructural:` with `reason: not product code` returned zero problems and stopped D2, D4,
 * the `state:` verification and the shrink-only rule all at once. That is exactly the #1864 shape
 * the BASELINE_STATES comment above cites: a measured gap discharged by RECLASSIFYING it.
 *
 * So the path must MATCH one of these classes. The patterns are matched as globs against the
 * entry's own path, which is how a manifest writes them (`**\/*.d.ts`, `lib/db/migrations/**`).
 *
 * @type {Array<{pattern: string, why: string}>}
 */
const INFRASTRUCTURAL_CLASSES = [
	{ pattern: "**/*.d.ts", why: "type declarations — erased entirely, no runtime statement exists" },
	{ pattern: "**/*.config.*", why: "build and tooling configuration, exercised by running the tools" },
	{ pattern: "tests/**", why: "the tests themselves — counting them inflates the number with the measurement" },
	{ pattern: "**/migrations/**", why: "generated migrations and snapshots, never hand-written" },
	{ pattern: "**/seed/**", why: "development seed data, not shipped product code" },
];

/**
 * The per-project pending-enrolment marker. One per coverage-emitting project that hides files —
 * behind an `include` allowlist, behind `exclude:` entries, or both — and is NOT yet enrolled in a
 * manifest.
 *
 * `packages/ui` hand-lists 12 files as its coverage scope while `src/` holds 60, and its floor is
 * armed over that hand-picked scope. `apps/marketing` and `ee` carry three and two `exclude:`
 * entries respectively; `ee` is the paid tier whose floor the ratchet enforces. Recording all of
 * that is a SCOPE decision about somebody else's package and it lands as its own PR, so that the
 * manifest format and the classifications are separately attributable — the same split #2649
 * requires between the guard and any change that moves the published number.
 *
 * WHY A FILE AND NOT A LIST IN THIS SCRIPT (#4103). The record used to be a `Map` literal here,
 * which made every enrolment PR an edit to THIS file: three projects, three lanes, one file, and
 * the two claimable enrolment units (#4104, #4105) serialised behind each other on a conflict they
 * had no other reason to have. A marker beside the project it describes is deleted by the lane
 * that enrols that project and by nobody else, so the units are disjoint by construction.
 *
 * It is also DERIVED rather than typed. The set of pending projects is whatever markers the tree
 * carries — read out of `git ls-files`, never out of a list in this file — because a guard's
 * hand-written list of what it watches stops covering silently.
 *
 * THE FORMAT, in full — a marker is read by the same kind of hand-rolled reader as the manifest,
 * and REFUSES anything it cannot parse:
 *
 *     # whole-line comments are allowed, and are the place for the measurement
 *     issue: #4104
 *     reason: one line, in the product's voice          (optional)
 *
 * `issue:` is required, appears exactly once, and must be `#<digits>` — a marker pointing at prose
 * ("the coverage epic", "TBD") records nothing anybody can chase. `reason:` is optional and is
 * echoed in the note. Any other key is a FAILURE, not an ignore.
 *
 * This is not a mute button and it cannot go slack. It fails in FIVE directions: a project that
 * hides files and carries no marker fails; a marked project that has since GAINED a manifest
 * fails, asking for the marker to be deleted; a marked project that hides nothing any more — no
 * allowlist, no exclusions — fails the same way; a marker beside a project that declares no
 * coverage block fails; and a marker that does not parse fails NAMING the parse error, which is
 * how "this project is recorded" stays distinguishable from "this project could not be read".
 * The measured count is printed on every run, so the size of the hole is visible rather than
 * remembered.
 */
const MARKER = "coverage-exclusions.pending";

/** The only keys a marker may declare. An unknown key is a FAILURE, not an ignore. */
const MARKER_KEYS = ["issue", "reason"];

/**
 * How many pending-enrolment markers the tree may carry. RATCHETED IN BOTH DIRECTIONS.
 *
 * WHY A NUMBER AT ALL. Every other failure direction here fires on a marker that is WRONG — one
 * naming a project with no coverage block, one whose project has since gained a manifest, one that
 * now hides nothing. None of them fires on a marker that is merely NEW. So a PR could add
 * `packages/foo/vitest.config.ts` with an `exclude:` plus a `coverage-exclusions.pending` beside
 * it, and turn what would have been a hard failure into a note — with the only trace being one
 * digit in the summary line. Before #4103 that took editing this guard; a per-project file made it
 * cheaper, and the count has to become a claim rather than a readout to compensate.
 *
 * DOWNWARDS TOO, and that is the half that keeps it honest: enrolling a project has to LOWER this
 * number in the same diff, so the win is banked and cannot be spent again on a different project.
 * That is the same rule `apps/console/shared-surface-allowlist.yaml`'s `debt:` follows.
 *
 * Three today — ee (#4105), packages/ui (#4104), apps/marketing (#4103) — one per open enrolment
 * issue, which is the invariant worth holding: a marker with no issue behind it is a mute.
 */
const PENDING_MARKER_CEILING = 3;

/**
 * Read one pending-enrolment marker.
 *
 * THROWS on anything it cannot read, and that is the point: a reader that shrugs at a line it does
 * not understand turns a typo'd marker into an absent one, and an absent marker is a project that
 * silently stops being recorded — the exact hole the marker exists to keep visible. A marker that
 * fails here is reported as a marker problem, which is a different message from the one an
 * unrecorded project gets, so "recorded" and "unreadable" never report identically.
 *
 * @param {string} text the marker source
 * @param {string} rel the marker path, for messages
 * @returns {{issue: string, reason: string|null}}
 */
export function parsePendingMarker(text, rel) {
	/** @type {Record<string, string>} */
	const fields = {};
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const raw = lines[i].replace(/\r$/, "");
		const at = `${rel}:${i + 1}`;
		if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
		const field = /^([a-z_]+):[ \t]*(.*)$/.exec(raw);
		if (!field) {
			throw new Error(
				`${at}: cannot parse this line — ${JSON.stringify(raw)}\n` +
					`  A ${MARKER} holds whole-line \`#\` comments and \`key: value\` at column 0, nothing else.`,
			);
		}
		if (!MARKER_KEYS.includes(field[1])) {
			throw new Error(`${at}: unknown key \`${field[1]}\` — the only keys are ${MARKER_KEYS.join(", ")}`);
		}
		if (field[1] in fields) throw new Error(`${at}: key \`${field[1]}\` given twice`);
		fields[field[1]] = field[2].trim();
	}
	if (!("issue" in fields)) {
		throw new Error(`${rel}: no \`issue:\` — a pending record must name the issue that will delete it, as \`issue: #1234\`.`);
	}
	if (!/^#[0-9]+$/.test(fields.issue)) {
		throw new Error(
			`${rel}: \`issue: ${fields.issue || "(empty)"}\` is not an issue reference — it must be \`#\` followed by digits.\n` +
				"  Prose here records nothing anybody can chase, which is what the marker is for.",
		);
	}
	return { issue: fields.issue, reason: fields.reason ?? null };
}

/**
 * Derive the pending-enrolment set from the tree.
 *
 * The SET is whatever markers the repository carries — not a list in this file. A marker that does
 * not parse yields a problem and NO entry, so the project it sits beside is then treated as
 * unrecorded and fails again for that too: an unreadable record must never be worth more than no
 * record at all.
 *
 * @param {string} root
 * @param {string[]} files every tracked file, repo-relative
 * @returns {{pending: Map<string, {issue: string, reason: string|null, rel: string}>, problems: string[]}}
 */
export function derivePending(root, files) {
	/** @type {Map<string, {issue: string, reason: string|null, rel: string}>} */
	const pending = new Map();
	/** @type {string[]} */
	const problems = [];
	for (const rel of files) {
		if (path.basename(rel) !== MARKER) continue;
		const projectRel = path.dirname(rel);
		try {
			const parsed = parsePendingMarker(readFileSync(path.join(root, rel), "utf8"), rel);
			pending.set(projectRel, { ...parsed, rel });
		} catch (err) {
			problems.push(`${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { pending, problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The manifest reader
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Read the flat YAML subset the manifests are written in.
 *
 * Hand-rolled because a de-hydrated worktree has no js-yaml, and REFUSING rather than skipping
 * anything it cannot parse, because a reader that shrugs at a line it does not understand turns a
 * typo'd entry into an absent one — which is exactly how an exclusion goes unrecorded while the
 * file still looks full.
 *
 * The subset, deliberately narrow enough that a real YAML parser reads it identically:
 *
 *     section:
 *       - path: lib/foo.ts
 *         suite: [tests/integration/a.test.ts]
 *         symbols: [alpha, beta]
 *         reason: one line, in the product's voice
 *
 * A whole-line `#` is a comment. An inline `#` is NOT — it stays in the value — so a value that
 * would need one has to be quoted, and a bare scalar containing `: ` or opening with a YAML
 * indicator is REFUSED with a message asking for quotes rather than silently diverging from what
 * a real parser would do.
 *
 * @param {string} text the manifest source
 * @param {string} rel the manifest path, for messages
 * @returns {Map<string, Array<Record<string, string|string[]>>>} section -> entries
 */
export function parseManifest(text, rel) {
	/** @type {Map<string, Array<Record<string, string|string[]>>>} */
	const out = new Map();
	/** @type {Array<Record<string, string|string[]>>|null} */
	let items = null;
	/** @type {Record<string, string|string[]>|null} */
	let item = null;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const raw = lines[i].replace(/\r$/, "");
		const at = `${rel}:${i + 1}`;
		if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;

		const section = /^([a-z_]+):[ \t]*$/.exec(raw);
		if (section) {
			if (!SECTIONS.includes(section[1])) {
				throw new Error(`${at}: unknown section \`${section[1]}\` — the only sections are ${SECTIONS.join(", ")}`);
			}
			if (out.has(section[1])) throw new Error(`${at}: section \`${section[1]}\` declared twice`);
			items = [];
			out.set(section[1], items);
			item = null;
			continue;
		}

		const first = /^ {2}- ([a-z_]+):[ \t]*(.*)$/.exec(raw);
		if (first) {
			if (items === null) throw new Error(`${at}: an entry before any section heading`);
			const joined = joinFlowList(first[2], lines, i, at);
			i = joined.line;
			item = { [first[1]]: parseValue(joined.value, first[1], at) };
			items.push(item);
			continue;
		}

		const field = /^ {4}([a-z_]+):[ \t]*(.*)$/.exec(raw);
		if (field) {
			if (item === null) throw new Error(`${at}: a field before any \`- \` entry`);
			if (field[1] in item) throw new Error(`${at}: field \`${field[1]}\` given twice on one entry`);
			const joined = joinFlowList(field[2], lines, i, at);
			i = joined.line;
			item[field[1]] = parseValue(joined.value, field[1], at);
			continue;
		}

		throw new Error(
			`${at}: cannot parse this line — ${JSON.stringify(raw)}\n` +
				"  The manifest is read by a hand-rolled parser (no node_modules in a de-hydrated\n" +
				"  worktree), so it is restricted to `section:` at column 0, `  - key: value` and\n" +
				"  `    key: value`. An unparseable line is refused rather than skipped, because a\n" +
				"  skipped line is an exclusion that silently stops being recorded.",
		);
	}
	return out;
}

/**
 * Fold a flow list that spans several lines back onto one.
 *
 * A `symbols:` list of eleven exports does not fit on a line anyone will read, and YAML lets a
 * `[...]` run across lines, so the reader has to as well — a parser that refuses a construct real
 * YAML accepts pushes the manifest into a shape written for the tool rather than for the person.
 * An unterminated list still THROWS at end of file rather than quietly taking the rest.
 *
 * @param {string} head the text after `key:` on the opening line
 * @param {string[]} lines every line of the manifest
 * @param {number} start index of the opening line
 * @param {string} at file:line of the opening line, for messages
 * @returns {{value: string, line: number}} the folded value and the last line consumed
 */
function joinFlowList(head, lines, start, at) {
	let value = head.trim();
	let from = start;
	// `key:` with the `[` on the NEXT line is how a long list is normally wrapped.
	if (value === "" && (lines[start + 1] ?? "").trim().startsWith("[")) {
		from = start + 1;
		value = lines[from].trim();
	}
	if (!value.startsWith("[") || value.includes("]")) return { value: value === "" ? head : value, line: from };
	for (let i = from + 1; i < lines.length; i += 1) {
		value += ` ${lines[i].trim()}`;
		if (lines[i].includes("]")) return { value, line: i };
	}
	throw new Error(`${at}: a flow list opens here and never closes`);
}

/**
 * Parse one manifest scalar or flow list, refusing anything a real YAML parser would read
 * differently.
 *
 * @param {string} rawValue the text after `key:`
 * @param {string} key the field name, for messages
 * @param {string} at file:line, for messages
 * @returns {string|string[]}
 */
function parseValue(rawValue, key, at) {
	const v = rawValue.trim();
	if (v === "") throw new Error(`${at}: field \`${key}\` has no value`);
	if (v.startsWith("[")) {
		if (!v.endsWith("]")) throw new Error(`${at}: field \`${key}\` has text after the end of its flow list`);
		const inner = v.slice(1, -1).trim();
		if (inner === "") return [];
		// A trailing comma is what a multi-line list is normally written with; it is not an item.
		return inner.replace(/,\s*$/, "").split(",").map((part) => {
			const p = part.trim();
			if (p === "") throw new Error(`${at}: field \`${key}\` has an empty item in its list`);
			return unquote(p, key, at);
		});
	}
	return unquote(v, key, at);
}

/**
 * Unquote one scalar, or refuse a bare one whose meaning would depend on the parser.
 *
 * @param {string} v
 * @param {string} key
 * @param {string} at
 * @returns {string}
 */
function unquote(v, key, at) {
	if (v.startsWith('"')) {
		if (!v.endsWith('"') || v.length < 2) throw new Error(`${at}: field \`${key}\` has an unterminated quoted value`);
		return v.slice(1, -1);
	}
	if (/^[[\]{}#&*!|>%@`'"]/.test(v)) {
		throw new Error(`${at}: field \`${key}\` starts with a YAML indicator (${v[0]}) — quote it: ${key}: "${v}"`);
	}
	if (v.includes(": ")) {
		throw new Error(`${at}: field \`${key}\` is a bare scalar containing ": " — quote it, or a real YAML parser reads it as a map`);
	}
	return v;
}

/**
 * Check one manifest against the schema each section's decision requires.
 *
 * @param {Map<string, Array<Record<string, string|string[]>>>} sections
 * @param {string} rel the manifest path, for messages
 * @returns {string[]} problems, empty when the manifest is well-formed
 */
export function validateManifest(sections, rel) {
	/** @type {Record<string, {required: string[], lists: string[]}>} */
	const schema = {
		infrastructural: { required: ["path", "reason"], lists: [] },
		tier_separation: { required: ["path", "suite", "symbols", "reason"], lists: ["suite", "symbols"] },
		baseline: { required: ["path", "symbols", "issue", "state", "reason"], lists: ["symbols"] },
	};
	/** @type {string[]} */
	const problems = [];
	/** @type {Map<string, Set<string>>} path -> every symbol claimed for it, across sections */
	const symbolsPerPath = new Map();
	for (const [section, entries] of sections) {
		const spec = schema[section];
		/** @type {Set<string>} */
		const seen = new Set();
		for (const entry of entries) {
			const where = `${rel} [${section}] ${String(entry.path ?? "<no path>")}`;
			for (const field of spec.required) {
				if (!(field in entry)) problems.push(`${where}: missing required field \`${field}\``);
			}
			for (const field of Object.keys(entry)) {
				if (!spec.required.includes(field)) problems.push(`${where}: field \`${field}\` is not part of a \`${section}\` entry`);
			}
			for (const field of spec.lists) {
				const value = entry[field];
				if (value !== undefined && !Array.isArray(value)) problems.push(`${where}: \`${field}\` must be a list, e.g. ${field}: [a, b]`);
				else if (Array.isArray(value) && value.length === 0) problems.push(`${where}: \`${field}\` is empty — an entry with no ${field} states nothing`);
			}
			if (typeof entry.path === "string") {
				// A `baseline:` path may appear once PER STATE. `lib/reconcile/gc.ts` really is two
				// records: two exports whose only reference is a mock, and one nothing names at
				// all. Forcing them into one entry would make whichever state was chosen false for
				// the other half, which is the granularity this whole manifest exists to buy. The
				// SYMBOL is still the thing that may not be claimed twice — that would be two
				// records of the same fact, which is what the duplicate rule is actually for.
				const key = section === "baseline" ? `${entry.path}\u0000${String(entry.state ?? "")}` : entry.path;
				if (seen.has(key)) problems.push(`${where}: listed twice in \`${section}\`${section === "baseline" ? ` with the same state` : ""}`);
				seen.add(key);
				if (Array.isArray(entry.symbols)) {
					const claimedFor = symbolsPerPath.get(entry.path) ?? new Set();
					symbolsPerPath.set(entry.path, claimedFor);
					for (const symbol of entry.symbols) {
						if (claimedFor.has(symbol)) problems.push(`${where}: claims \`${symbol}\` twice — one export, one record.`);
						claimedFor.add(symbol);
					}
				}
			}
			// Entering the no-evidence section is itself a checked claim — see INFRASTRUCTURAL_CLASSES.
			if (section === "infrastructural" && typeof entry.path === "string") {
				const cls = INFRASTRUCTURAL_CLASSES.find((c) => globToRegExp(c.pattern).test(entry.path));
				if (cls === undefined) {
					problems.push(
						`${where}: \`infrastructural\` requires no evidence because the CLASS is the argument, and this path is in none of them.\n` +
							`${INFRASTRUCTURAL_CLASSES.map((c) => `    ${c.pattern} — ${c.why}`).join("\n")}\n` +
							"  Product code belongs in `tier_separation:` with the suite that proves it, or in `baseline:`\n" +
							"  with an owning issue. Reclassifying a measured gap into here is green either way, which is\n" +
							"  the one thing this manifest is written to prevent.",
					);
				}
			}
			if (section === "baseline") {
				if (typeof entry.issue !== "string" || !/^#\d+$/.test(entry.issue)) {
					problems.push(`${where}: \`issue\` must be "#NNNN" — a baseline entry with no owning issue is an amnesty nothing comes back to collect`);
				}
				if (typeof entry.state !== "string" || !(entry.state in BASELINE_STATES)) {
					problems.push(`${where}: \`state\` must be one of ${Object.keys(BASELINE_STATES).join(", ")}`);
				}
			}
		}
	}
	return problems;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Import resolution — mirroring what vitest actually does
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Read the `alias:` map out of a vitest config, so a specifier resolves the way vitest resolves
 * it rather than the way a guard guesses.
 *
 * MIRROR THE EMITTER. `apps/console/vitest.config.ts` maps `@` to the project root and stubs
 * `server-only` (which throws under vitest); `packages/ui/vitest.config.ts` puts its alias under
 * `test.alias` instead. Hard-coding "`@/` means the project root" would be a rendering of that
 * map, and would go quietly wrong the day a project aliases something else — which is the failure
 * shape this repo keeps paying for.
 *
 * Both spellings the repo uses are read: `path.resolve(__dirname, "x")` and
 * `fileURLToPath(new URL("./x", import.meta.url))`. An alias whose target this cannot read is
 * REPORTED, not skipped, because an unread alias makes every specifier through it unresolvable
 * and "unresolvable" would otherwise read as "external, ignore".
 *
 * @param {string} rawSrc the vitest config source
 * @param {string} projectDir absolute path to the project
 * @returns {{aliases: Map<string,string>, problems: string[]}}
 */
export function readAliases(rawSrc, projectDir) {
	const src = stripTsComments(rawSrc);
	/** @type {Map<string,string>} */
	const aliases = new Map();
	/** @type {string[]} */
	const problems = [];
	let searchFrom = 0;
	for (;;) {
		const at = src.indexOf("alias: {", searchFrom);
		if (at === -1) break;
		let depth = 0;
		let end = -1;
		for (let i = src.indexOf("{", at); i < src.length; i += 1) {
			if (src[i] === "{") depth += 1;
			else if (src[i] === "}") {
				depth -= 1;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		if (end === -1) {
			problems.push("alias block is not brace-balanced — this parser has stopped understanding the config");
			break;
		}
		const block = src.slice(at + "alias: {".length, end);
		searchFrom = end + 1;
		// Split on top-level commas so a value spanning several lines stays with its key.
		for (const chunk of splitTopLevel(block)) {
			const text = chunk.trim();
			if (text === "") continue;
			const key = /^["']([^"']+)["']\s*:/.exec(text) ?? /^([A-Za-z_$][\w$]*)\s*:/.exec(text);
			if (key === null) {
				problems.push(`alias entry has no readable key: ${JSON.stringify(text.slice(0, 60))}`);
				continue;
			}
			const value = text.slice(text.indexOf(":", key[0].length - 1) + 1).trim();
			const resolved =
				/^path\.resolve\(\s*__dirname\s*,\s*["']([^"']*)["']\s*\)$/.exec(value) ??
				/^fileURLToPath\(\s*new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)\s*\)$/.exec(value) ??
				/^["']([^"']+)["']$/.exec(value);
			if (resolved === null) {
				problems.push(`alias \`${key[1]}\` has a target this parser cannot read: ${JSON.stringify(value.slice(0, 80))}`);
				continue;
			}
			aliases.set(key[1], path.resolve(projectDir, resolved[1]));
		}
	}
	return { aliases, problems };
}

/**
 * Split an object-literal body on its TOP-LEVEL commas, so a `path.resolve(a, b)` value is not
 * cut in half at its own argument separator.
 *
 * @param {string} block
 * @returns {string[]}
 */
function splitTopLevel(block) {
	/** @type {string[]} */
	const parts = [];
	let depth = 0;
	let start = 0;
	let inStr = /** @type {false|string} */ (false);
	for (let i = 0; i < block.length; i += 1) {
		const c = block[i];
		if (inStr) {
			if (c === "\\") i += 1;
			else if (c === inStr) inStr = false;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") inStr = c;
		else if (c === "(" || c === "[" || c === "{") depth += 1;
		else if (c === ")" || c === "]" || c === "}") depth -= 1;
		else if (c === "," && depth === 0) {
			parts.push(block.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(block.slice(start));
	return parts;
}

/**
 * Every spelling of a vitest module mock, and the specifier it replaces.
 *
 * Kept as one named constant because `parseModuleGraph` has to run it twice — once to collect the
 * mocks, once to blank them out of the source the dynamic-import sweep reads — and two copies of a
 * regex is two places for the next spelling to be added to only one of.
 */
const MOCK_CALL = /\b(?:vi|vitest)\s*\.\s*(?:mock|doMock)\s*\(\s*(?:await\s+)?(?:import\s*\(\s*)?[`"']([^`"']+)[`"']/g;

/**
 * The imports, re-exports and mocks of one module, classified by whether they EXECUTE anything.
 *
 * `import type { X }` and `import { type X }` are erased by the compiler: they emit no require,
 * load no module, and record no coverage. They are read here and thrown away deliberately, so the
 * classifier can say WHY a claim failed rather than only that it did.
 *
 * The clause is captured as `[^;]*?` rather than `[\s\S]*?`. A lazy match over everything crosses
 * statement boundaries: given `import "./a";` followed by `import { b } from "./c";` it happily
 * reads the whole pair as ONE import of "./c" whose clause is the previous statement, and then
 * classifies that garbage. A clause cannot contain a semicolon; a gap between two statements
 * always does.
 *
 * THE MOCK SPELLINGS MIRROR THE EMITTER, not a memory of it. @vitest/mocker 2.1.9
 * (dist/node.js:693-696) declares `utilsObjectNames = ["vi", "vitest"]` and
 * `dynamicImportMockMethodNames = ["mock", "unmock", "doMock", "doUnmock"]`, and node.js:909-923
 * rewrites `vi.mock(import("m"))` to `vi.mock("m")` before it runs. The first version of this
 * regex was `/\bvi\.(?:do)?mock/`, which matches the non-existent `vi.domock` and misses the three
 * spellings vitest really accepts: `vi.doMock`, `vitest.mock`, and `vi.mock(import("…"))`. Each
 * one really replaces the module, so each one is really non-evidence, and each one passed.
 *
 * `typeof import("m")` is a TYPE QUERY, not a dynamic import: TypeScript erases it entirely, no
 * module loads, v8 records nothing. It is the same non-evidence as `import type`, reached by a
 * spelling the first version read as a namespace import that proved EVERY export at once —
 * `apps/console/tests/components/design-project/connector-select.test.tsx:55` already contains
 * one over a `@/lib/…` module, so the bypass was live rather than hypothetical.
 *
 * The dynamic-import sweep runs over a copy with every mock CALL blanked out, so
 * `vi.mock(import("m"))` cannot be counted as a mock and as a namespace import of the same module
 * in one pass. Only the call head up to the specifier is blanked; a `vi.mock("m", async () => { …
 * await importOriginal() … })` factory body is left intact.
 *
 * @param {string} rawSrc
 * @returns {{value: Array<{spec: string, symbols: Set<string>|"*", bindings: Map<string,string>|"*"|null, reexport: boolean}>, mocks: string[]}}
 */
export function parseModuleGraph(rawSrc) {
	const src = stripTsComments(rawSrc);
	/** @type {Array<{spec: string, symbols: Set<string>|"*", bindings: Map<string,string>|"*"|null, reexport: boolean}>} */
	const value = [];
	/** @type {string[]} */
	const mocks = [];

	for (const m of src.matchAll(/^[ \t]*import\s+([^;]*?)\bfrom\s*["']([^"']+)["']/gm)) {
		const clause = clauseSymbols(m[1]);
		if (clause !== null) value.push({ spec: m[2], symbols: clause, bindings: null, reexport: false });
	}
	for (const m of src.matchAll(/^[ \t]*export\s+([^;]*?)\bfrom\s*["']([^"']+)["']/gm)) {
		const clause = clauseSymbols(m[1]);
		if (clause !== null) value.push({ spec: m[2], symbols: clause, bindings: reexportBindings(m[1]), reexport: true });
	}
	// A bare `import "x"` executes the module for its side effects: real coverage, no named symbol.
	for (const m of src.matchAll(/^[ \t]*import\s*["']([^"']+)["'];?[ \t]*$/gm)) value.push({ spec: m[1], symbols: new Set(), bindings: null, reexport: false });

	// Mocks first, so the dynamic-import sweep below can be run over a source with the mock calls
	// removed rather than over one where a mocked module also looks namespace-imported.
	let blanked = src;
	for (const m of src.matchAll(MOCK_CALL)) {
		mocks.push(m[1]);
		blanked = blanked.slice(0, m.index) + " ".repeat(m[0].length) + blanked.slice(m.index + m[0].length);
	}
	// `await import("x")` binds the whole namespace, so every export is reachable through it —
	// tests/integration/authz-seed.test.ts does exactly this to defeat a run-once module guard.
	// The leading `typeof` is captured rather than excluded by a lookbehind so the reason a match
	// was dropped is visible in the pattern itself.
	for (const m of blanked.matchAll(/(\btypeof\s+)?\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
		if (m[1] !== undefined) continue; // `typeof import("m")` is erased — no module loads.
		value.push({ spec: m[2], symbols: "*", bindings: null, reexport: false });
	}

	return { value, mocks };
}

/**
 * Classify an import/export clause into the symbols it VALUE-binds, or null when it binds none.
 *
 * @param {string} rawClause the text between `import`/`export` and `from`
 * @returns {Set<string>|"*"|null} null for a type-only clause
 */
function clauseSymbols(rawClause) {
	const clause = rawClause.trim();
	if (/^type\b/.test(clause)) return null;
	if (/\*\s*as\s+/.test(clause) || clause === "*") return "*";
	/** @type {Set<string>} */
	const symbols = new Set();
	const braceAt = clause.indexOf("{");
	if (braceAt === -1) {
		// A bare default binding: `import Db from "…"`.
		if (clause !== "") symbols.add("default");
		return symbols;
	}
	const head = clause.slice(0, braceAt).replace(/,\s*$/, "").trim();
	if (head !== "") symbols.add("default");
	const closeAt = clause.lastIndexOf("}");
	for (const part of clause.slice(braceAt + 1, closeAt === -1 ? undefined : closeAt).split(",")) {
		const spec = part.trim();
		if (spec === "" || /^type\b/.test(spec)) continue;
		const name = /^([A-Za-z_$][\w$]*)/.exec(spec);
		if (name !== null) symbols.add(name[1]);
	}
	// `import { type X } from "m"` binds no value. TypeScript elides it, so nothing loads and v8
	// records nothing — the same non-evidence as `import type { X }`, reached by a different
	// spelling. Returning an EMPTY set instead would mark the module "reached but proving no
	// symbol", which is a subtly different and less honest failure message.
	return symbols.size === 0 ? null : symbols;
}

/**
 * Map a re-export clause from the name it EXPOSES to the name it takes from the target.
 *
 * `clauseSymbols` cannot answer this: it collapses `export { alpha as a } from "./mod"` to the
 * source name and loses which name an importer of the barrel would have to write. Crossing a
 * barrel, the symbols proven on the TARGET are the ones the suite asked the barrel for — not
 * every name the barrel happens to forward — and matching those two lists needs both halves.
 *
 * @param {string} rawClause the text between `export` and `from`
 * @returns {Map<string,string>|"*"|null} exposed -> source, `"*"` for `export * from`, null when
 *   the clause is type-only and binds nothing at runtime
 */
function reexportBindings(rawClause) {
	const clause = rawClause.trim();
	if (/^type\b/.test(clause)) return null;
	// `export * as ns from "m"` exposes ONE name bound to the whole namespace; `export * from "m"`
	// forwards every runtime export under its own name and can only be resolved against the
	// target's own export list, which is why it answers `"*"` rather than a map.
	const star = /^\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
	if (star !== null) return new Map([[star[1], "*"]]);
	if (clause === "*" || /^\*\s*$/.test(clause)) return "*";
	const braceAt = clause.indexOf("{");
	if (braceAt === -1) return null;
	/** @type {Map<string,string>} */
	const bindings = new Map();
	const closeAt = clause.lastIndexOf("}");
	for (const part of clause.slice(braceAt + 1, closeAt === -1 ? undefined : closeAt).split(",")) {
		const spec = part.trim();
		if (spec === "" || /^type\b/.test(spec)) continue;
		const renamed = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/.exec(spec);
		if (renamed !== null) bindings.set(renamed[2], renamed[1]);
		else {
			const name = /^([A-Za-z_$][\w$]*)/.exec(spec);
			if (name !== null) bindings.set(name[1], name[1]);
		}
	}
	return bindings.size === 0 ? null : bindings;
}

/**
 * The RUNTIME exports of one module — the names a `symbols:` list has to account for.
 *
 * `symbols:` was checked in one direction only: every name listed had to be value-imported, and
 * nothing asked whether the list was COMPLETE. Measured on the manifest as first written, 26
 * runtime exports across 9 entries appeared in neither `symbols:` nor `baseline:` — a single entry
 * claiming 2 of `lib/billing/queries.ts`'s 7 exports read exactly like one claiming all 7. That is
 * #2676's "one line asserted twelve things and nobody could see which were true" at symbol
 * granularity, inside the manifest written to retire it.
 *
 * TYPE-ONLY EXPORTS ARE NOT RUNTIME EXPORTS. `export type`, `export interface`, `export declare`
 * and `const enum` are erased by the compiler: no binding exists, so nothing can execute and
 * nothing can be claimed. Requiring them in `symbols:` would make the list longer and less true.
 *
 * An `export` this cannot classify is REPORTED, never skipped — a parser that shrugs at a shape it
 * does not know under-reports the export set, and under-reporting here reads as "the manifest is
 * complete". `export * from "…"` is the one shape that cannot be answered locally at all: it
 * forwards a list only the target knows, so it is reported rather than guessed at.
 *
 * @param {string} rawSrc the module source
 * @param {string} rel the module path, for messages
 * @returns {{names: Set<string>, problems: string[]}}
 */
export function moduleExports(rawSrc, rel) {
	const src = stripTsComments(rawSrc);
	/** @type {Set<string>} */
	const names = new Set();
	/** @type {string[]} */
	const problems = [];
	for (const m of src.matchAll(/^[ \t]*export\b[ \t]*/gm)) {
		const from = m.index + m[0].length;
		const rest = src.slice(from, from + 4096);
		// Erased entirely — no runtime binding exists to be covered or claimed.
		if (/^(?:type[\s{]|interface\b|declare\b|const[ \t]+enum\b)/.test(rest)) continue;
		if (/^default\b/.test(rest)) {
			names.add("default");
			continue;
		}
		const named = /^(?:async[ \t]+)?(?:abstract[ \t]+)?(?:function[ \t]*\*?|class|enum)[ \t]+([A-Za-z_$][\w$]*)/.exec(rest);
		if (named !== null) {
			names.add(named[1]);
			continue;
		}
		const decl = /^(?:const|let|var)[ \t]+/.exec(rest);
		if (decl !== null) {
			// The whole statement, so `export const a = 1, b = 2;` yields both, and a destructuring
			// pattern is refused rather than silently contributing one wrong name.
			for (const found of declaratorNames(readStatement(src, from + decl[0].length))) {
				if (found.name !== null) names.add(found.name);
				else problems.push(`${rel}: cannot read the name(s) exported by \`${found.text.trim().slice(0, 60)}\``);
			}
			continue;
		}
		const starAs = /^\*[ \t]*as[ \t]+([A-Za-z_$][\w$]*)/.exec(rest);
		if (starAs !== null) {
			names.add(starAs[1]);
			continue;
		}
		if (/^\*/.test(rest)) {
			problems.push(
				`${rel}: \`export * from …\` forwards a list only the target module knows, so the export set here cannot be enumerated.\n` +
					"  Name the exports explicitly, or the completeness check cannot tell a full `symbols:` list from a partial one.",
			);
			continue;
		}
		if (/^\{/.test(rest)) {
			const bindings = reexportBindings(readStatement(src, from).replace(/\bfrom\b[\s\S]*$/, ""));
			if (bindings === "*" || bindings === null) continue;
			for (const exposed of bindings.keys()) names.add(exposed);
			continue;
		}
		problems.push(`${rel}: an \`export\` this parser cannot classify: ${JSON.stringify(rest.split("\n")[0].slice(0, 80))}`);
	}
	return { names, problems };
}

/**
 * Read one statement from `at` to its terminating top-level `;`, or to the end of the line when it
 * is already balanced.
 *
 * A declaration is not a line: `export const MAX_REAP_ATTEMPTS = (() => { … })();` spans several,
 * and cutting it at the first newline would take an initialiser's contents for a second declarator.
 *
 * @param {string} src
 * @param {number} at
 * @returns {string}
 */
function readStatement(src, at) {
	let depth = 0;
	let inStr = /** @type {false|string} */ (false);
	for (let i = at; i < src.length; i += 1) {
		const c = src[i];
		if (inStr) {
			if (c === "\\") i += 1;
			else if (c === inStr) inStr = false;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") inStr = c;
		else if (c === "(" || c === "[" || c === "{") depth += 1;
		else if (c === ")" || c === "]" || c === "}") depth -= 1;
		else if (depth === 0 && (c === ";" || c === "\n")) return src.slice(at, i);
	}
	return src.slice(at);
}

/**
 * The names declared by one `const`/`let`/`var` declarator list.
 *
 * A plain top-level-comma split is wrong here, and measurably so: `export const
 * EFFECTIVE_RETENTION_DAYS: Readonly<Record<string, number>> = {…}` splits inside the TYPE
 * ANNOTATION and reports a second export called `number`. So the scan tracks where it is —
 * a declarator's name, then its annotation (where `<…>` really are brackets), then its
 * initialiser — and only a comma in the last of those starts a new declarator.
 *
 * A declarator that does not open with a plain identifier is a destructuring pattern. It is
 * reported with `name: null` rather than skipped: skipping would drop real exports and the
 * completeness check would read a short `symbols:` list as a full one.
 *
 * @param {string} text the text after `const`/`let`/`var`
 * @returns {Array<{name: string|null, text: string}>}
 */
function declaratorNames(text) {
	/** @type {Array<{name: string|null, text: string}>} */
	const out = [];
	let depth = 0;
	let angle = 0;
	let state = /** @type {"name"|"type"|"init"} */ ("name");
	let inStr = /** @type {false|string} */ (false);
	let start = 0;
	const push = (end) => {
		const part = text.slice(start, end);
		const name = /^\s*([A-Za-z_$][\w$]*)/.exec(part);
		if (part.trim() !== "") out.push({ name: name === null ? null : name[1], text: part });
	};
	for (let i = 0; i < text.length; i += 1) {
		const c = text[i];
		if (inStr) {
			if (c === "\\") i += 1;
			else if (c === inStr) inStr = false;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") inStr = c;
		else if (c === "(" || c === "[" || c === "{") depth += 1;
		else if (c === ")" || c === "]" || c === "}") depth -= 1;
		else if (depth === 0 && state === "type" && c === "<") angle += 1;
		else if (depth === 0 && state === "type" && c === ">") angle -= 1;
		else if (depth === 0 && angle === 0) {
			if (c === ":" && state === "name") state = "type";
			else if (c === "=" && text[i + 1] !== "=" && text[i - 1] !== "=") state = "init";
			else if (c === ",") {
				push(i);
				start = i + 1;
				state = "name";
			}
		}
	}
	push(text.length);
	return out;
}

/**
 * Resolve a specifier the way vitest would, or say that it cannot be resolved.
 *
 * The distinction that matters: a BARE specifier (`vitest`, `drizzle-orm`, `node:crypto`) is
 * external and carries no claim about this repo, so it is skipped. A relative or aliased one that
 * lands on no file is UNRESOLVED, and unresolved is a failure — a resolver that quietly downgrades
 * "I could not follow this" to "nothing there" would let a renamed helper hide a broken claim.
 *
 * @param {string} spec
 * @param {string} fromFile absolute path of the importing file
 * @param {Map<string,string>} aliases
 * @returns {{kind: "external"}|{kind: "file", file: string}|{kind: "unresolved"}}
 */
export function resolveSpecifier(spec, fromFile, aliases) {
	/** @type {string|null} */
	let base = null;
	if (spec.startsWith("./") || spec.startsWith("../")) {
		base = path.resolve(path.dirname(fromFile), spec);
	} else {
		// Longest matching alias wins, so `@/x` and `@repo/ui` cannot be confused for each other.
		let bestKey = "";
		for (const key of aliases.keys()) {
			if ((spec === key || spec.startsWith(`${key}/`)) && key.length > bestKey.length) bestKey = key;
		}
		if (bestKey === "") return { kind: "external" };
		const target = aliases.get(bestKey) ?? "";
		base = spec === bestKey ? target : path.join(target, spec.slice(bestKey.length + 1));
	}
	const found = tryExtensions(base);
	return found === null ? { kind: "unresolved" } : { kind: "file", file: found };
}

/**
 * Try the extensions and index files a bundler would, including the `.js`-means-`.ts` rewrite
 * that NodeNext-style TypeScript imports use.
 *
 * @param {string} base
 * @returns {string|null}
 */
function tryExtensions(base) {
	/** @type {string[]} */
	const candidates = [base];
	for (const ext of EXTS) candidates.push(base + ext);
	if (/\.js$/.test(base)) for (const ext of EXTS) candidates.push(base.replace(/\.js$/, ext));
	for (const ext of EXTS) candidates.push(path.join(base, `index${ext}`));
	for (const cand of candidates) {
		if (existsSync(cand) && statSync(cand).isFile()) return cand;
	}
	return null;
}

/**
 * Walk one suite's reach: what it value-imports, directly or through its own helper modules.
 *
 * TWO TRAVERSAL RULES, and the difference between them is the whole calibration of D2:
 *
 *   · a RELATIVE import from a suite file is part of the suite — `tests/integration/db.ts` is
 *     the shared fixture helper every integration suite pulls in, and code it imports is code
 *     the suite runs. Followed transitively.
 *   · an ALIASED import (`@/lib/…`) is a dependency, and "my dependency imports it" is not "my
 *     suite exercises it". Only its RE-EXPORTS are followed, because a re-export is the same
 *     module surface under another name, not a new claim.
 *
 * Following aliased imports transitively would have made this guard useless on the very defect it
 * was written for: `tests/integration/reconcile-b2c.test.ts` imports `@/lib/db`, and a transitive
 * walk out of the schema barrel reaches most of `lib/`, at which point every exclusion in the
 * project is "verified" by every suite.
 *
 * A BARREL FORWARDS ONLY WHAT THE IMPORTER ASKED FOR. The first version credited a re-export
 * clause's own symbols to the target without intersecting them with what the suite took from the
 * barrel, so `export { alpha, beta } from "./mod"` plus a suite importing only `beta` proved
 * `alpha` — a symbol no file in the project value-imports — and `export * from "./mod"` proved
 * every export of the target at once. That is the gc.ts shape (module reached, symbol not) coming
 * back through the one edge the walker follows. So a remote node carries `want`: the names its
 * importer actually asked of it, mapped back through the clause's `exposed -> source` bindings.
 *
 * With `want` bounding the credit, the one-level cap on re-export chains is no longer what keeps
 * this honest, and it was buying a wrong message: a two-level barrel reported "the suite never
 * value-imports it", naming the walker's own truncation as the suite's failure. Chains are
 * followed to their end; `seen` terminates a cycle.
 *
 * @param {string[]} entryFiles absolute paths of the suite's own files
 * @param {Map<string,string>} aliases
 * @param {Map<string, {graph: ReturnType<typeof parseModuleGraph>, exports: Set<string>}>} [cache]
 *   parsed-module cache, shared across walks. D2b walks every test file in the project separately
 *   — 434 of them in apps/console — and they overwhelmingly share the same fixture helpers.
 * @returns {{evidence: Map<string, Set<string>|"*">, mocked: Set<string>, unresolved: Array<{file: string, spec: string}>, walked: number}}
 */
export function walkSuite(entryFiles, aliases, cache = new Map()) {
	/** @type {Map<string, Set<string>|"*">} */
	const evidence = new Map();
	/** @type {Set<string>} */
	const mocked = new Set();
	/** @type {Array<{file: string, spec: string}>} */
	const unresolved = [];
	/** @type {Set<string>} */
	const seen = new Set();
	/** @type {Array<{file: string, local: boolean, want: Set<string>|"*"}>} */
	const queue = entryFiles.map((file) => ({ file, local: true, want: /** @type {Set<string>|"*"} */ ("*") }));
	let walked = 0;

	/** Read and parse one module once per process, however many suites walk through it. */
	const readModule = (file) => {
		const hit = cache.get(file);
		if (hit !== undefined) return hit;
		const src = readFileSync(file, "utf8");
		const entry = { graph: parseModuleGraph(src), exports: moduleExports(src, file).names };
		cache.set(file, entry);
		return entry;
	};

	/** Record that `file` is value-imported with `symbols`. */
	const record = (file, symbols) => {
		const prior = evidence.get(file);
		if (prior === "*" || symbols === "*") evidence.set(file, "*");
		else evidence.set(file, new Set([...(prior ?? []), ...symbols]));
	};

	while (queue.length > 0) {
		const next = queue.shift();
		if (next === undefined) break;
		// The wanted set is part of the key: the same barrel reached asking for different names
		// forwards different names, so a walk keyed on the path alone would drop the second visit.
		const key = `${next.local ? "L" : "R"}:${next.want === "*" ? "*" : [...next.want].sort().join(",")}:${next.file}`;
		if (seen.has(key)) continue;
		seen.add(key);
		if (!existsSync(next.file)) continue;
		walked += 1;
		const { graph } = readModule(next.file);
		for (const mock of next.local ? graph.mocks : []) {
			const target = resolveSpecifier(mock, next.file, aliases);
			if (target.kind === "file") mocked.add(target.file);
			else if (target.kind === "unresolved") unresolved.push({ file: next.file, spec: mock });
		}
		for (const imp of graph.value) {
			// A module reached across an aliased edge contributes ONLY its re-exports. Its own
			// plain imports are its dependencies, and "my dependency imports it" is not "my suite
			// exercises it" — reading them as evidence is what would make every exclusion in a
			// project "verified" by every suite that touches the schema barrel.
			if (!next.local && !imp.reexport) continue;
			const target = resolveSpecifier(imp.spec, next.file, aliases);
			if (target.kind === "external") continue;
			if (target.kind === "unresolved") {
				unresolved.push({ file: next.file, spec: imp.spec });
				continue;
			}
			if (next.local) {
				record(target.file, imp.symbols);
				const relative = imp.spec.startsWith("./") || imp.spec.startsWith("../");
				queue.push({ file: target.file, local: relative, want: relative ? "*" : imp.symbols });
				continue;
			}
			const forwarded = forwardedSymbols(imp.bindings, next.want, () => readModule(target.file).exports);
			if (forwarded === null) continue;
			record(target.file, forwarded);
			queue.push({ file: target.file, local: false, want: forwarded });
		}
	}
	return { evidence, mocked, unresolved, walked };
}

/**
 * The names a re-export clause actually forwards to its target, given what its importer asked for.
 *
 * `export * from "./mod"` is resolved against the TARGET'S own export list rather than answered
 * with `"*"`: the importer asked for specific names, and only the ones the target really exports
 * came from there. Answering `"*"` is what let one barrel import prove every export of a module.
 *
 * @param {Map<string,string>|"*"|null} bindings exposed -> source, from `reexportBindings`
 * @param {Set<string>|"*"} want the names the importer asked of the barrel
 * @param {() => Set<string>} targetExports the target module's own runtime exports, read lazily
 * @returns {Set<string>|"*"|null} null when the clause forwards nothing the importer asked for
 */
function forwardedSymbols(bindings, want, targetExports) {
	if (bindings === null) return null;
	if (bindings === "*") {
		if (want === "*") return "*";
		const exports = targetExports();
		const hit = new Set([...want].filter((name) => exports.has(name)));
		return hit.size === 0 ? null : hit;
	}
	/** @type {Set<string>} */
	const forwarded = new Set();
	for (const [exposed, source] of bindings) {
		if (want !== "*" && !want.has(exposed)) continue;
		if (source === "*") return "*"; // `export * as ns from "m"` binds the whole namespace.
		forwarded.add(source);
	}
	return forwarded.size === 0 ? null : forwarded;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Globs
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A path with no glob metacharacter — the kind that can silently stop matching anything. */
export function isLiteralPath(entry) {
	return !/[*?{}[\]!]/.test(entry);
}

/**
 * Compile a vitest/tinyglobby-style glob to a regular expression over project-relative paths.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
	let re = "";
	let braces = 0;
	for (let i = 0; i < glob.length; i += 1) {
		if (glob.startsWith("**/", i)) {
			re += "(?:.*/)?";
			i += 2;
		} else if (glob.startsWith("**", i)) {
			re += ".*";
			i += 1;
		} else {
			const c = glob[i];
			if (c === "*") re += "[^/]*";
			else if (c === "?") re += "[^/]";
			else if (c === "{") {
				braces += 1;
				re += "(?:";
			} else if (c === "}") {
				braces -= 1;
				re += ")";
			} else if (c === "," && braces > 0) re += "|";
			else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The checks
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Run D0, D1 and D2 for one manifested project.
 *
 * @param {string} root repository root
 * @param {string} projectRel project path relative to root
 * @param {string} configRel the project's vitest config, relative to root
 * @param {string[]} testFiles project-relative test files, for the baseline check
 * @returns {{problems: string[], counts: Record<string, number>}}
 */
export function checkProject(root, projectRel, configRel, testFiles) {
	const projectDir = path.join(root, projectRel);
	/** @type {string[]} */
	const problems = [];
	const counts = { entries: 0, literals: 0, tierSuites: 0, symbols: 0, walked: 0, baselineSymbols: 0, exports: 0 };

	const configSrc = readFileSync(path.join(root, configRel), "utf8");
	const excludes = coverageExcludes(configSrc);
	if (excludes === null) {
		problems.push(`${configRel}: the coverage exclude block did not parse — treated as a FAILURE, never as "no exclusions" (#2724)`);
		return { problems, counts };
	}

	const manifestRel = path.join(projectRel, MANIFEST);
	/** @type {Map<string, Array<Record<string, string|string[]>>>} */
	let sections;
	try {
		sections = parseManifest(readFileSync(path.join(root, manifestRel), "utf8"), manifestRel);
	} catch (err) {
		problems.push(err instanceof Error ? err.message : String(err));
		return { problems, counts };
	}
	problems.push(...validateManifest(sections, manifestRel));

	/** @type {Map<string, string[]>} manifest path -> the sections claiming it */
	const claimed = new Map();
	for (const [section, entries] of sections) {
		counts.entries += entries.length;
		for (const entry of entries) {
			if (typeof entry.path !== "string") continue;
			claimed.set(entry.path, [...(claimed.get(entry.path) ?? []), section]);
		}
	}

	// ── D0 · both directions ──
	for (const entry of excludes) {
		if (!claimed.has(entry)) {
			problems.push(
				`${configRel}: coverage excludes \`${entry}\` with no entry in ${MANIFEST}.\n` +
					`  Add it under infrastructural (not product code), tier_separation (proven by a named\n` +
					"  suite) or baseline (real debt, with an owning issue). The section is the decision.",
			);
		}
	}
	for (const [entryPath, inSections] of claimed) {
		if (!excludes.includes(entryPath)) {
			problems.push(
				`${manifestRel}: \`${entryPath}\` is recorded in [${inSections.join(", ")}] but is no longer excluded by ${configRel}.\n` +
					"  The exclusion was removed or renamed — delete the manifest entry in the same PR, or the\n" +
					"  manifest starts describing a scope that no longer exists.",
			);
		}
	}

	// ── D1 · a literal entry still names a real file ──
	//
	// Globs stay deliberately unchecked, preserving the reason ts-coverage.mjs:855 states: a glob
	// matching nothing is indistinguishable from a directory that emptied, and either way it
	// excludes nothing and misleads nobody. A LITERAL path is different — it becomes a lie the
	// moment its file is renamed, and it reads exactly like a live one.
	for (const entryPath of claimed.keys()) {
		if (!isLiteralPath(entryPath)) continue;
		counts.literals += 1;
		if (!existsSync(path.join(projectDir, entryPath))) {
			problems.push(`${manifestRel}: \`${entryPath}\` names no file under ${projectRel}/`);
		}
	}

	const { aliases, problems: aliasProblems } = readAliases(configSrc, projectDir);
	for (const p of aliasProblems) problems.push(`${configRel}: ${p}`);

	// ── D2 · the named suite REACHES the module ──
	//
	// The parse cache is shared with D2b below: D2b walks every test file in the project
	// separately, and they overwhelmingly re-read the same fixture helpers.
	/** @type {Map<string, {graph: ReturnType<typeof parseModuleGraph>, exports: Set<string>}>} */
	const cache = new Map();
	for (const entry of sections.get("tier_separation") ?? []) {
		const entryPath = entry.path;
		const suites = entry.suite;
		const symbols = entry.symbols;
		if (typeof entryPath !== "string" || !Array.isArray(suites) || !Array.isArray(symbols)) continue;
		const target = entryTarget(projectDir, entryPath, "tier_separation", manifestRel, problems);
		if (target === null) continue;
		/** @type {Set<string>} */
		const proven = new Set();
		let namespaceProven = false;
		for (const suiteRel of suites) {
			counts.tierSuites += 1;
			const suiteAbs = path.join(projectDir, suiteRel);
			if (!existsSync(suiteAbs)) {
				problems.push(`${manifestRel}: [tier_separation] \`${entryPath}\` names suite \`${suiteRel}\`, which does not exist`);
				continue;
			}
			// A `suite:` must be a file vitest RUNS. Nothing but the extension says so from here —
			// there is no test runner in a de-hydrated worktree to ask — and without the check the
			// claim can be discharged by production code that merely imports the module:
			// `apps/console/lib/reconcile/loop.ts` imports `@/lib/reconcile/gc`, so `suite:
			// [lib/reconcile/loop.ts]` would have proven the gc.ts entry with a file no runner
			// ever executes. That is a mistake one character away from a real suite path.
			if (!TEST_FILE.test(suiteRel)) {
				problems.push(
					`${manifestRel}: [tier_separation] \`${entryPath}\` names suite \`${suiteRel}\`, which is not a test file.\n` +
						"  Only a `*.test.*` file is executed by vitest; production code that imports the module\n" +
						"  proves nothing about coverage, however faithfully it reaches it.",
				);
				continue;
			}
			const walk = walkSuite([suiteAbs], aliases, cache);
			counts.walked += walk.walked;
			for (const u of walk.unresolved) {
				problems.push(
					`${path.relative(root, u.file)}: cannot resolve \`${u.spec}\`.\n` +
						"  An unresolvable project specifier is a FAILURE, not a skip — a resolver that reads it\n" +
						'  as "nothing there" lets a renamed helper hide a broken tier-separation claim.',
				);
			}
			if (walk.mocked.has(target)) {
				problems.push(
					`${manifestRel}: [tier_separation] \`${entryPath}\` cites \`${suiteRel}\`, which \`vi.mock\`s it.\n` +
						"  A mock REPLACES the module, so the real code never runs and v8 records nothing for it.\n" +
						"  Adding another mock satisfies \"a test names it\" while changing the coverage by exactly zero.\n" +
						"  If nothing executes this module, it belongs in `baseline:` with an owning issue.",
				);
				continue;
			}
			const got = walk.evidence.get(target);
			if (got === undefined) {
				problems.push(
					`${manifestRel}: [tier_separation] \`${entryPath}\` cites \`${suiteRel}\`, which never value-imports it.\n` +
						"  `import type { X }` and `import { type X }` are erased by the compiler: they load no\n" +
						"  module and record no coverage, so they are not evidence either.\n" +
						"  Name the suite that actually executes it, or move the file to `baseline:`.",
				);
				continue;
			}
			if (got === "*") namespaceProven = true;
			else for (const s of got) proven.add(s);
		}
		for (const symbol of symbols) {
			counts.symbols += 1;
			if (namespaceProven || proven.has(symbol)) continue;
			problems.push(
				`${manifestRel}: [tier_separation] \`${entryPath}\` claims \`${symbol}\`, which none of its suites value-imports.\n` +
					`  Imported names seen: ${proven.size === 0 ? "(none)" : [...proven].sort().join(", ")}`,
			);
		}
	}

	// ── D2b · a baseline entry must still BE debt ──
	//
	// Shrink-only in the direction that matters: if a symbol recorded as unproven acquires a real
	// test, this fails and asks for it to move to `tier_separation:`. Without that, "the gap was
	// closed" and "the record went stale" look identical, and a baseline section decays into the
	// amnesty it is written not to be.
	//
	// A MOCK IS CLASSIFIED PER TEST FILE, exactly as D2 classifies it per suite. The first version
	// walked all 434 of the console's test files as ONE suite and unioned their mocks, which made
	// the shrink-only rule structurally unreachable for `state: mock-only` — the only state the
	// repo actually uses. Its guard read `covered && !mocked`, and `mocked` was true for the whole
	// project the moment any single file mocked the module, which for `lib/reconcile/gc.ts` is
	// permanent (tests/lib/reconcile/loop.test.ts:16). So the day somebody wrote the integration
	// test this manifest asks for, the entry would have gone on claiming "executed by no test" and
	// CI would have stayed green — the stale claim #3262 exists to end, reappearing inside its own
	// fix. Evidence now counts only from test files that do NOT mock the module.
	const baseline = sections.get("baseline") ?? [];
	if (baseline.length > 0) {
		/** @type {Map<string, Set<string>|"*">} evidence from test files that do NOT mock the module */
		const real = new Map();
		/** @type {Map<string, Set<string>|"*">} evidence from test files that DO mock the module */
		const throughMock = new Map();
		/** @type {Set<string>} */
		const mockedAnywhere = new Set();
		for (const rel of testFiles) {
			const walk = walkSuite([path.join(root, rel)], aliases, cache);
			counts.walked += walk.walked;
			for (const file of walk.mocked) mockedAnywhere.add(file);
			for (const [file, symbols] of walk.evidence) mergeEvidence(walk.mocked.has(file) ? throughMock : real, file, symbols);
		}
		/** Is `symbol` value-imported by a test, in the given evidence map? */
		const imports = (from, target, symbol) => {
			const got = from.get(target);
			return got === "*" || (got instanceof Set && got.has(symbol));
		};
		for (const entry of baseline) {
			const entryPath = entry.path;
			const symbols = entry.symbols;
			if (typeof entryPath !== "string" || !Array.isArray(symbols)) continue;
			const target = entryTarget(projectDir, entryPath, "baseline", manifestRel, problems);
			if (target === null) continue;
			for (const symbol of symbols) {
				counts.baselineSymbols += 1;
				// SHRINK-ONLY, and it is the one rule every state shares: a listed symbol that a
				// non-mocking test value-imports is no longer debt, whatever the entry says.
				if (imports(real, target, symbol)) {
					problems.push(
						`${manifestRel}: [baseline] \`${entryPath}\` records \`${symbol}\` as untested, but a test that does NOT mock the module value-imports it.\n` +
							"  Move it to `tier_separation:` with the suite that proves it. A baseline is shrink-only.",
					);
					continue;
				}
				// Each state is then verified on the SYMBOL, not just on the module. A state
				// checked only at module granularity is not checked at all for a module that is
				// partly proven: `lib/reconcile/gc.ts` is executed for real by the authz-activity
				// suites AND mocked by loop.test.ts, so "the module is mocked somewhere" is true
				// of every export it has, including one no test mentions.
				if (entry.state === "mock-only" && !imports(throughMock, target, symbol)) {
					problems.push(
						`${manifestRel}: [baseline] \`${entryPath}\` records \`${symbol}\` as \`mock-only\` — ${BASELINE_STATES["mock-only"]} — but no test imports that name from the mocked module.\n` +
							"  Nothing names it at all now: `untested-export` (the module runs, this export is not asserted)\n" +
							"  or `no-test` (nothing names the module) is the honest state.",
					);
				}
				if (entry.state === "untested-export" && imports(throughMock, target, symbol)) {
					problems.push(
						`${manifestRel}: [baseline] \`${entryPath}\` records \`${symbol}\` as \`untested-export\`, but a test imports that name from a \`vi.mock\` of the module.\n` +
							"  `mock-only` is the sharper record: the name IS referenced, through a mock that replaces it.",
					);
				}
			}
			if (entry.state === "mock-only" && !mockedAnywhere.has(target)) {
				problems.push(
					`${manifestRel}: [baseline] \`${entryPath}\` is state \`mock-only\` — ${BASELINE_STATES["mock-only"]} — but no test mocks it.\n` +
						"  The state changed shape; re-read the tests and record what is true now.",
				);
			}
			if (entry.state === "no-test" && (mockedAnywhere.has(target) || real.has(target) || throughMock.has(target))) {
				problems.push(
					`${manifestRel}: [baseline] \`${entryPath}\` is state \`no-test\` — ${BASELINE_STATES["no-test"]} — but a test does name it.\n` +
						"  `mock-only` is probably the honest state now.",
				);
			}
			// `untested-export` asserts the OPPOSITE premise to the other two: the module is
			// executed for real, and these exports are the part of it that is not. Its failure
			// direction is the module going dark — at which point the honest record is `no-test`
			// or `mock-only` and this entry is describing a shape that no longer exists.
			if (entry.state === "untested-export" && !real.has(target)) {
				problems.push(
					`${manifestRel}: [baseline] \`${entryPath}\` is state \`untested-export\` — ${BASELINE_STATES["untested-export"]} — but no test executes the module for real.\n` +
						"  `no-test` or `mock-only` is the honest state now.",
				);
			}
		}
	}

	// ── D4 · a `symbols:` list must be COMPLETE ──
	//
	// The other direction of D2. D2 asks whether every name LISTED is value-imported; D4 asks
	// whether every runtime export is listed at all, in `symbols:` or in `baseline:`. Without it a
	// single entry claiming 2 of `lib/billing/queries.ts`'s 7 exports reads exactly like one
	// claiming all 7 — and that was the measured state of this manifest as first written: 26
	// runtime exports across 9 entries appeared in neither list. It is #2676's "one line asserted
	// twelve things and nobody could see which were true" at symbol granularity, reappearing
	// inside the manifest written to retire it.
	//
	// The reverse direction is checked too: a `symbols:` name the module does not export is a
	// claim about something that no longer exists, and a rename is exactly how one appears.
	/** @type {Map<string, Set<string>>} module path -> every symbol claimed for it, any section */
	const claimedSymbols = new Map();
	for (const [section, entries] of sections) {
		if (section === "infrastructural") continue;
		for (const entry of entries) {
			if (typeof entry.path !== "string" || !Array.isArray(entry.symbols)) continue;
			claimedSymbols.set(entry.path, new Set([...(claimedSymbols.get(entry.path) ?? []), ...entry.symbols]));
		}
	}
	for (const [entryPath, claimedNames] of claimedSymbols) {
		const target = tryExtensions(path.join(projectDir, entryPath));
		if (target === null) continue; // already reported by D1 or entryTarget.
		const { names, problems: exportProblems } = moduleExports(readFileSync(target, "utf8"), `${projectRel}/${entryPath}`);
		problems.push(...exportProblems);
		counts.exports += names.size;
		const unaccounted = [...names].filter((name) => !claimedNames.has(name)).sort();
		if (unaccounted.length > 0) {
			problems.push(
				`${manifestRel}: \`${entryPath}\` excludes ${names.size} runtime export(s) and accounts for ${names.size - unaccounted.length}.\n` +
					`  Unaccounted: ${unaccounted.join(", ")}\n` +
					"  Every export the exclusion hides is a claim. List it in `symbols:` of the suite that\n" +
					"  value-imports it, or record it in `baseline:` with an owning issue and a state — a\n" +
					"  partial list reads exactly like a complete one, which is what makes it worth nothing.",
			);
		}
		const gone = [...claimedNames].filter((name) => !names.has(name)).sort();
		if (gone.length > 0) {
			problems.push(
				`${manifestRel}: \`${entryPath}\` claims ${gone.join(", ")}, which the module does not export.\n` +
					"  The export was renamed or removed — update the claim in the same PR, or it goes on\n" +
					"  asserting something about a name that no longer exists.",
			);
		}
	}

	// ── vacuity, per project ──
	//
	// The global floor below counts configs, manifests and entries, and every one of those can be
	// non-zero while nothing was actually re-read: a manifest of pure `infrastructural:` entries,
	// or one whose `tier_separation:` paths were collapsed back into a glob, walks no suite and
	// checks no symbol and still prints a ✓. Printing a zero is not asserting a non-zero.
	if ((sections.get("tier_separation") ?? []).length > 0 && (counts.tierSuites === 0 || counts.symbols === 0)) {
		problems.push(
			`${manifestRel}: declares ${(sections.get("tier_separation") ?? []).length} \`tier_separation:\` entr(ies) and checked ${counts.tierSuites} suite claim(s) and ${counts.symbols} symbol claim(s).\n` +
				"  Zero of either means the entries were skipped, not that they passed.",
		);
	}
	if (baseline.length > 0 && counts.baselineSymbols === 0) {
		problems.push(`${manifestRel}: declares ${baseline.length} \`baseline:\` entr(ies) and checked 0 baseline symbol(s) — they were skipped, not passed.`);
	}

	return { problems, counts };
}

/**
 * Resolve a `tier_separation:`/`baseline:` entry's path to the single FILE its per-symbol claim is
 * about, or report why it is not one.
 *
 * D1 deliberately leaves a glob unchecked, for a reason that holds only for `infrastructural:`: a
 * glob matching nothing excludes nothing and misleads nobody. It does NOT hold for a section that
 * carries `suite:` and `symbols:`, because both blocks used to open with
 * `if (target === null) continue; // D1 already reported it` — and D1 had reported nothing. A glob
 * path therefore skipped D2 and D2b in silence: measured, `path: lib/queries/**` with a suite that
 * imports nothing and three invented symbols returned zero problems. The manifest itself records
 * that this block "USED TO BE ONE GLOB, `lib/queries/**`", so collapsing the twelve per-file
 * entries back into one line was an ordinary edit that disarmed the check for twelve files.
 *
 * A DIRECTORY is the quieter half of the same hole: `path: lib/queries` is a literal, D1's
 * `existsSync` passes on the directory, and `tryExtensions` then returns null for a path that
 * exists — so nothing at all was reported.
 *
 * @param {string} projectDir
 * @param {string} entryPath
 * @param {string} section
 * @param {string} manifestRel
 * @param {string[]} problems appended to
 * @returns {string|null} the resolved file, or null when the entry cannot carry a symbol claim
 */
function entryTarget(projectDir, entryPath, section, manifestRel, problems) {
	if (!isLiteralPath(entryPath)) {
		problems.push(
			`${manifestRel}: [${section}] \`${entryPath}\` is a glob, and a glob cannot carry a per-symbol claim.\n` +
				"  `suite:` and `symbols:` are about one module's exports. Give each file its own entry —\n" +
				"  one line asserting twelve things is how six unproven files hid behind six proven ones.",
		);
		return null;
	}
	const target = tryExtensions(path.join(projectDir, entryPath));
	if (target !== null) return target;
	if (existsSync(path.join(projectDir, entryPath))) {
		problems.push(`${manifestRel}: [${section}] \`${entryPath}\` names a directory, not a file — a per-symbol claim is about one module.`);
	}
	return null; // otherwise it names nothing, and D1 has already said so.
}

/** Merge one module's imported names into an evidence map, `"*"` absorbing everything. */
function mergeEvidence(into, file, symbols) {
	const prior = into.get(file);
	if (prior === "*" || symbols === "*") into.set(file, "*");
	else into.set(file, new Set([...(prior ?? []), ...symbols]));
}

/**
 * D3 — read a coverage `include` as the exclusion it is when it hand-lists files.
 *
 * A file absent from a hand-listed `include` is excluded exactly as surely as one named in
 * `exclude`, and the existing sweep, which walks `coverage.exclude`, cannot see it at all.
 * `packages/ui` names 12 files while `src/` holds 60, and its floor is armed at 98.83% over the 12
 * somebody picked.
 *
 * TWO THINGS MAKE IT AN ALLOWLIST: a literal file in `include`, and at least one PEER of that file
 * left unmeasured. The sweep is NON-RECURSIVE, and that is the classifier rather than an economy —
 * measured: sweeping the include roots recursively instead finds 42 unmeasured files under
 * `apps/marketing/app/**` and reclassifies marketing as an allowlist, which is the one thing this
 * rule exists to avoid. The cost is that a file in a SUBDIRECTORY of an allowlisted directory is
 * invisible here; `packages/ui/src` is flat today (60 files, 0 nested), so nothing is missed, and
 * the day it nests, that file is unmeasured and unreported. `apps/marketing`
 * also has a literal in its `include` (`proxy.ts`) and is NOT an allowlist: its scope is
 * `["proxy.ts", "lib/**"]`, a deliberate logic-surface choice whose own comment records why the
 * tempting tight scope was refused. What separates the two is the PEER SET — the files sitting in
 * the same directory as the literal, which is the set the author was choosing among. Marketing's
 * root peers are all `*.config.*` and already excluded; `packages/ui/src`'s peers are 48 real
 * components.
 *
 * @param {string} root
 * @param {string} projectRel
 * @param {string} configRel
 * @param {string[]} projectFiles project-relative paths of every tracked file in the project
 * @returns {{problems: string[], allowlist: boolean, unlisted: string[]}}
 */
export function checkIncludeAllowlist(root, projectRel, configRel, projectFiles) {
	const projectDir = path.join(root, projectRel);
	const src = readFileSync(path.join(root, configRel), "utf8");
	const include = coverageArrayKey(src, "include");
	const exclude = coverageArrayKey(src, "exclude");
	if (include === null || exclude === null) {
		return {
			problems: [`${configRel}: the coverage include/exclude block did not parse — a FAILURE, never "nothing to check" (#2724)`],
			allowlist: false,
			unlisted: [],
		};
	}
	// No `include` at all means "measure everything", which is the honest default and not an
	// allowlist. An include of pure globs is a TIER decision, also not an allowlist.
	if (!include.found) return { problems: [], allowlist: false, unlisted: [] };
	const literals = include.entries.filter((e) => isLiteralPath(e) && existsSync(path.join(projectDir, e)) && statSync(path.join(projectDir, e)).isFile());
	if (literals.length === 0) return { problems: [], allowlist: false, unlisted: [] };

	const includeRes = include.entries.map(globToRegExp);
	const excludeRes = exclude.entries.map(globToRegExp);
	/** @type {Set<string>} */
	const unlisted = new Set();
	for (const dir of new Set(literals.map((e) => path.dirname(e)))) {
		for (const rel of projectFiles) {
			if (path.dirname(rel) !== dir) continue; // peers only — see the header.
			if (!SOURCE_EXTS.has(path.extname(rel))) continue;
			if (excludeRes.some((re) => re.test(rel))) continue;
			if (includeRes.some((re) => re.test(rel))) continue;
			unlisted.add(rel);
		}
	}
	// A literal include that leaves NO peer unmeasured is not an allowlist — it is a scope that
	// happens to be spelled out. That is the whole marketing/ui distinction, expressed as the
	// measurement rather than as a judgement about which project meant well.
	return { problems: [], allowlist: unlisted.size > 0, unlisted: [...unlisted].sort() };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every tracked file in the repository, project-relative per project.
 *
 * `git ls-files` rather than a directory walk, so a build artefact or a stray local file never
 * counts as source. A failure here THROWS: a guard that cannot enumerate its own input has not
 * passed, it has not run.
 *
 * @param {string} root
 * @returns {string[]}
 */
function trackedFiles(root) {
	const out = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return out.split("\n").filter(Boolean);
}

/**
 * Run every check over a repository tree.
 *
 * The pending-enrolment set is DERIVED from the tree's `coverage-exclusions.pending` markers, so
 * the self-test exercises every one of its failure directions by writing a real marker into a
 * hermetic fixture — the same input the repository gives it. There is no parameter to override it
 * with, because a record only reachable by passing it in is a record no fixture proves.
 *
 * @param {string} root
 * @param {string[]} files every tracked file, repo-relative
 * @returns {{problems: string[], notes: string[], counts: Record<string, number>}}
 */
export function run(root, files, opts = {}) {
	/** @type {string[]} */
	const problems = [];
	/** @type {string[]} */
	const notes = [];
	const counts = { configs: 0, manifests: 0, entries: 0, literals: 0, tierSuites: 0, symbols: 0, walked: 0, baselineSymbols: 0, exports: 0, allowlists: 0, unmanifestedExcludes: 0, pendingMarkers: 0 };
	const derived = derivePending(root, files);
	const pending = derived.pending;
	problems.push(...derived.problems);
	counts.pendingMarkers = pending.size;
	// The count is a CLAIM, not a readout — see PENDING_MARKER_CEILING. Both directions fail, and
	// the message says which way it moved, because "expected 3, got 4" does not tell the reader
	// whether they added a hole or closed one.
	//
	// PASSED IN RATHER THAN READ FROM MODULE SCOPE, so a fixture tree makes no claim at all. A
	// ceiling is a fact about THIS repository; baking it into `run` would have made every one of
	// the self-test's fixtures — which carry nought or one marker — fail against a 3 that has
	// nothing to do with them. (It did: 21 assertions, before this was a parameter.)
	const ceiling = opts.pendingCeiling;
	if (ceiling === undefined) {
		// no claim to check
	} else if (counts.pendingMarkers > ceiling) {
		problems.push(
			`${counts.pendingMarkers} pending-enrolment marker(s) against a ceiling of ${ceiling}: a project was recorded as pending rather than enrolled.\n` +
				`  That converts a hard failure into a note, which is the one thing ${MARKER} must not be able to do quietly.\n` +
				`  If the enrolment really is a follow-up, raise PENDING_MARKER_CEILING in this file in the same diff and say why in the PR.`,
		);
	} else if (counts.pendingMarkers < ceiling) {
		problems.push(
			`${counts.pendingMarkers} pending-enrolment marker(s) against a ceiling of ${ceiling} — a project was enrolled. A win.\n` +
				`  Lower PENDING_MARKER_CEILING to ${counts.pendingMarkers} and commit it, so the slack cannot be spent on a different project later.`,
		);
	}
	/** @type {string[]} projects whose manifest was actually opened and re-read */
	const manifested = [];
	/** @type {Set<string>} unenrolled projects that hide files behind an `include` allowlist */
	const owedAllowlist = new Set();
	/** @type {Set<string>} unenrolled projects that carry `exclude:` entries with no manifest */
	const owedExcludes = new Set();
	/**
	 * @type {Set<string>} projects whose coverage block did NOT parse.
	 *
	 * Kept apart from the two `owed*` sets because "we could not read it" is not "it hides
	 * nothing", and the marker audit below cannot tell those apart from absence alone. Without
	 * this, an unparseable `exclude: [...SHARED]` produced the correct #2724 failure AND a third,
	 * false one instructing the reader to delete the project's marker — and the remedy that
	 * instruction now names is `rm` on a file, not an edit to a Map.
	 */
	const unparsedCoverage = new Set();

	const configs = files.filter((f) => f.endsWith("vitest.config.ts"));
	/** @type {Array<{projectRel: string, configRel: string}>} */
	const emitting = [];
	for (const configRel of configs) {
		const src = readFileSync(path.join(root, configRel), "utf8");
		if (!/\bcoverage\s*:\s*\{/.test(stripTsComments(src))) continue;
		emitting.push({ projectRel: path.dirname(configRel), configRel });
	}
	counts.configs = emitting.length;

	for (const { projectRel, configRel } of emitting) {
		const projectFiles = files.filter((f) => f.startsWith(`${projectRel}/`)).map((f) => f.slice(projectRel.length + 1));
		const hasManifest = existsSync(path.join(root, projectRel, MANIFEST));

		if (hasManifest) {
			counts.manifests += 1;
			manifested.push(projectRel);
			const testFiles = files.filter((f) => f.startsWith(`${projectRel}/`) && TEST_FILE.test(f));
			const res = checkProject(root, projectRel, configRel, testFiles);
			problems.push(...res.problems);
			for (const [k, v] of Object.entries(res.counts)) counts[k] += v;
		} else {
			// D0 IN THE UNENROLLED DIRECTION. `checkProject` only ran `if (hasManifest)`, so a
			// coverage-emitting project with no manifest owed nothing and was recorded nowhere —
			// and the success line went on saying "every coverage exclusion is manifested" over
			// six exclusions in three projects it had never opened (apps/marketing 3, ee 2,
			// packages/ui 1, measured). D3 got the pending record with three failure directions and
			// this direction got nothing, which made the un-enrolled projects an untracked hole
			// rather than a named one. `ee` is the paid tier whose floor the ratchet enforces: an
			// `exclude: ["src/license.ts"]` added there would have passed this guard in silence.
			const excludes = coverageExcludes(readFileSync(path.join(root, configRel), "utf8"));
			if (excludes === null) {
				unparsedCoverage.add(projectRel);
				problems.push(`${configRel}: the coverage exclude block did not parse — treated as a FAILURE, never as "no exclusions" (#2724)`);
			} else if (excludes.length > 0) {
				counts.unmanifestedExcludes += excludes.length;
				owedExcludes.add(projectRel);
				const record = pending.get(projectRel);
				if (record === undefined) {
					problems.push(
						`${configRel}: coverage excludes ${excludes.length} path(s) and this project has no ${MANIFEST}.\n` +
							`  ${excludes.join(", ")}\n` +
							`  Add ${projectRel}/${MANIFEST} classifying each, or record the project with a ${projectRel}/${MARKER} naming the owning issue.`,
					);
				} else {
					notes.push(
						`${configRel}: ${excludes.length} coverage exclusion(s) are UNMANIFESTED — ${excludes.join(", ")}.\n` +
							`  Recorded by ${record.rel} under ${record.issue}${record.reason ? ` — ${record.reason}` : ""}. This is not a mute: adding ${projectRel}/${MANIFEST}\n` +
							"  makes every one of them FAIL until it is classified, and the count above is what is unchecked today.",
					);
				}
			}
		}

		// ── D3 ──
		const d3 = checkIncludeAllowlist(root, projectRel, configRel, projectFiles);
		problems.push(...d3.problems);
		if (!d3.allowlist) continue; // whether that leaves the record with nothing to hold is decided below.
		owedAllowlist.add(projectRel);
		counts.allowlists += 1;
		if (hasManifest) {
			// An enrolled project owes a manifest entry for every file its allowlist excludes, the
			// same way it owes one for every `exclude:` entry.
			const manifestRel = path.join(projectRel, MANIFEST);
			/** @type {Set<string>} */
			let claimed = new Set();
			try {
				const sections = parseManifest(readFileSync(path.join(root, manifestRel), "utf8"), manifestRel);
				for (const entries of sections.values()) for (const e of entries) if (typeof e.path === "string") claimed.add(e.path);
			} catch {
				claimed = new Set(); // the parse failure is already reported by checkProject.
			}
			const missing = d3.unlisted.filter((f) => !claimed.has(f));
			if (missing.length > 0) {
				problems.push(
					`${configRel}: the coverage \`include\` hand-lists files, and ${missing.length} peer file(s) are excluded by their ABSENCE from it with no manifest entry.\n` +
						`  ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? `, … (+${missing.length - 8})` : ""}\n` +
						"  An include allowlist is an exclusion with the sign flipped: record each one under a section.",
				);
			}
		} else if (pending.has(projectRel)) {
			const record = pending.get(projectRel);
			notes.push(
				`${configRel}: coverage \`include\` is a hand-listed allowlist — ${d3.unlisted.length} peer file(s) are excluded by their ABSENCE from it, and the exclude sweep cannot see any of them.\n` +
					`  Recorded by ${record.rel} under ${record.issue}${record.reason ? ` — ${record.reason}` : ""}: the manifest for this project is a follow-up PR, because classifying those files is a decision about this package's scope and it must be separately attributable from the guard.\n` +
					`  This is not a mute: adding ${projectRel}/${MANIFEST} makes the ${d3.unlisted.length} unlisted files FAIL until each is classified, and removing the allowlist fails too.`,
			);
		} else {
			problems.push(
				`${configRel}: coverage \`include\` is a hand-listed allowlist and this project has no ${MANIFEST}.\n` +
					`  ${d3.unlisted.length} peer file(s) are excluded by their ABSENCE from it: ${d3.unlisted.slice(0, 8).join(", ")}${d3.unlisted.length > 8 ? `, … (+${d3.unlisted.length - 8})` : ""}\n` +
					`  Add ${projectRel}/${MANIFEST} classifying each, or record the project with a ${projectRel}/${MARKER} naming the owning issue.`,
			);
		}
	}

	// The record fails in three directions, over BOTH kinds of unmanifested exclusion it now holds:
	// a project that owes one and carries no marker fails above; a marked project that has since
	// gained a manifest fails; and a marked project that no longer owes anything — its allowlist
	// went away AND its `exclude:` emptied — fails, asking for the marker to go. A record that can
	// only be added to is the mute button it is written not to be. (A marker that does not PARSE
	// has already failed in `derivePending`, and left no entry here, so its project fails as
	// unrecorded too: an unreadable record is worth less than none, never more.)
	for (const [projectRel, record] of pending) {
		if (!emitting.some((e) => e.projectRel === projectRel)) {
			problems.push(`${record.rel}: \`${projectRel}\` declares no vitest coverage block, so this marker records a hole that does not exist — delete it.`);
		} else if (existsSync(path.join(root, projectRel, MANIFEST))) {
			problems.push(
				`${record.rel}: \`${projectRel}\` now has a ${MANIFEST}.\n` +
					"  Delete this marker: the project is enrolled, and its exclusions are enforced from here on.",
			);
		} else if (unparsedCoverage.has(projectRel)) {
			// SILENT ON PURPOSE. The parse failure is already reported above, and it is the only
			// thing known about this project — whether the marker still holds a real hole is
			// exactly what could not be read. Saying "delete it" here would be a guess presented
			// as an instruction, and the instruction is destructive.
		} else if (!owedAllowlist.has(projectRel) && !owedExcludes.has(projectRel)) {
			problems.push(
				`${record.rel}: \`${projectRel}\` now hides nothing: its coverage \`include\` no longer hand-lists files and its \`exclude\` is empty.\n` +
					`  Delete ${record.rel}.`,
			);
		}
	}

	// ── every manifest in the tree must have been READ ──
	//
	// Manifests are discovered by `existsSync` inside the loop over coverage-emitting projects, so
	// a manifest whose project stops emitting coverage is never opened again and nothing notices.
	// Reproduced: a project with a full `tier_separation:` manifest naming a non-existent suite and
	// an invented symbol returned zero problems once its config lost its `coverage: {}` block. The
	// global `manifests === 0` floor hides that only while one project is enrolled.
	for (const rel of files) {
		if (path.basename(rel) !== MANIFEST) continue;
		if (manifested.includes(path.dirname(rel))) continue;
		problems.push(
			`${rel}: this manifest was never read — ${path.dirname(rel)} declares no vitest coverage block, so nothing it records is checked.\n` +
				"  Delete it, or restore the coverage block it describes. A manifest nobody opens is prose again.",
		);
	}

	// ── vacuity ──
	if (counts.configs === 0) problems.push("no vitest config in this tree declares a coverage block — that is not a pass, the sweep or the layout changed.");
	if (counts.manifests === 0) problems.push(`no project carries a ${MANIFEST} — that is not a pass, it means nothing was checked.`);
	if (counts.manifests > 0 && counts.entries === 0) problems.push("every manifest read is empty — nothing was checked.");

	return { problems, notes, counts };
}

/** Print a run's result and return the process exit code. */
function report(result) {
	for (const note of result.notes) process.stdout.write(`\n! ${note}\n`);
	for (const problem of result.problems) process.stderr.write(`\n✗ ${problem}\n`);
	const c = result.counts;
	const summary =
		`${c.configs} coverage-emitting config(s) · ${c.manifests} manifest(s) · ${c.entries} entr(ies) · ` +
		`${c.literals} literal path(s) · ${c.tierSuites} suite claim(s) · ${c.symbols} symbol claim(s) · ` +
		`${c.symbols + c.baselineSymbols} of ${c.exports} excluded export(s) accounted for · ` +
		`${c.baselineSymbols} baseline symbol(s) · ${c.walked} module(s) walked · ${c.allowlists} include allowlist(s) · ` +
		`${c.pendingMarkers} pending-enrolment marker(s)`;
	if (result.problems.length > 0) {
		process.stderr.write(`\n${result.problems.length} coverage-exclusion problem(s). Examined: ${summary}\n`);
		return 1;
	}
	// The claim is narrowed to what actually ran. "Every exclusion is manifested" was false while
	// four coverage-emitting projects carried unmanifested exclusions the guard never opened, and
	// a ✓ that overstates its own scope is the failure mode this file exists to catch.
	const pendingCount = c.unmanifestedExcludes;
	process.stdout.write(
		`\n✓ check-coverage-exclusions: every manifested exclusion is re-read${pendingCount > 0 ? `; ${pendingCount} exclusion(s) stand recorded as pending enrolment above` : ""}.\n  Examined: ${summary}\n`,
	);
	return 0;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SELF-TEST — hermetic. Fixtures on a temp tree; no repo state, no network, no node_modules.
//
// Every case below makes the guard FAIL in a direction it must fail in, or PASS in one it must
// not confuse with failing. The D2 cases deliberately hold the PATH constant and vary only the
// import FORM — same module, same symbol, same directory — so a green result proves the
// classifier rather than proving that a file happened to be findable.
// ─────────────────────────────────────────────────────────────────────────────────────────────

let failures = 0;

/**
 * Evaluate a case, turning a throw into a recorded failure.
 *
 * Without this one unexpected exception ends the whole self-test at the line it was thrown on, and
 * the assertions after it never run — a partial run whose output stops mid-section reads far too
 * much like a passing one.
 *
 * @param {() => boolean} fn
 * @returns {boolean|string} false-y with the error text when it threw
 */
function attempt(fn) {
	try {
		return fn();
	} catch (err) {
		return `threw: ${err instanceof Error ? err.message : String(err)}`;
	}
}

/**
 * Assert, recording rather than throwing so every case runs.
 *
 * A STRING condition is a FAILURE carrying its own detail, never a truthy pass. `attempt` returns
 * the error text when a case throws, and a plain truthiness test would have turned every one of
 * those into a green tick — a self-test that reports loudest exactly where it broke.
 *
 * @param {string} name
 * @param {boolean|string} cond
 * @param {string} [detail]
 */
function check(name, cond, detail) {
	if (cond === true) process.stdout.write(`  ✓ ${name}\n`);
	else {
		failures += 1;
		const why = typeof cond === "string" ? cond : (detail ?? "");
		process.stdout.write(`  ✗ ${name}${why ? ` — ${why}` : ""}\n`);
	}
}

/** Write a file, creating its directories. */
function put(root, rel, body) {
	const abs = path.join(root, rel);
	mkdirSync(path.dirname(abs), { recursive: true });
	writeFileSync(abs, body);
	return abs;
}

/** A minimal vitest config with the given coverage keys and the console's `@` alias. */
function configFixture(keys) {
	return [
		'import path from "path";',
		'import { defineConfig } from "vitest/config";',
		"export default defineConfig({",
		"\ttest: {",
		'\t\texclude: ["**/node_modules/**"],',
		"\t\tcoverage: {",
		'\t\t\tprovider: "v8",',
		...keys,
		"\t\t},",
		"\t},",
		"\tresolve: {",
		"\t\talias: {",
		'\t\t\t"@": path.resolve(__dirname, "."),',
		"\t\t},",
		"\t},",
		"});",
		"",
	].join("\n");
}

/**
 * Build a fixture tree and run the guard over it.
 *
 * The enrolment record is DERIVED from the tree, so a fixture that wants a project recorded writes
 * the marker file the repository would write. There is nothing to pass in and nothing that could
 * leak in: a fixture tree contains no `packages/ui`, so it carries no marker unless a case put one
 * there.
 *
 * @param {Record<string,string>} files
 */
function runFixture(files, opts = {}) {
	const root = mkdtempSync(path.join(tmpdir(), "cov-excl-"));
	for (const [rel, body] of Object.entries(files)) put(root, rel, body);
	const list = Object.keys(files);
	try {
		return run(root, list, opts);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** A well-formed marker body naming `issue`. */
function markerFixture(issue, extra = "") {
	return `# measured: 2 peer file(s) hidden by the include allowlist\nissue: ${issue}\n${extra}`;
}

/** The shared shape every D2 case varies exactly one thing inside. */
function d2Fixture(suiteBody, extra = {}) {
	return {
		"p/vitest.config.ts": configFixture(['\t\t\tinclude: ["lib/**"],', '\t\t\texclude: ["lib/mod.ts"],']),
		// ONE export, so that the D4 completeness rule is satisfied by the single-symbol claim and
		// every case below still varies exactly the import FORM. The "wrong symbol" case imports a
		// `beta` this module does not export, which is what a stale claim looks like from the
		// suite's side and is precisely the shape D2 has to name.
		"p/lib/mod.ts": "export function alpha() { return 1; }\n",
		"p/tests/suite.test.ts": suiteBody,
		"p/coverage-exclusions.yaml": [
			"tier_separation:",
			"  - path: lib/mod.ts",
			"    suite: [tests/suite.test.ts]",
			"    symbols: [alpha]",
			"    reason: proven by the integration tier",
			"",
		].join("\n"),
		...extra,
	};
}

function runSelfTest() {
	process.stdout.write("check-coverage-exclusions --self-test\n\n manifest parsing — an unreadable line is refused, never skipped\n");

	const good = ["infrastructural:", '  - path: "**/*.d.ts"', "    reason: not product code", ""].join("\n");
	check("a quoted glob entry parses", attempt(() => parseManifest(good, "m.yaml").get("infrastructural")?.[0]?.path === "**/*.d.ts"));
	check("a flow list parses into an array", attempt(() => {
		const m = parseManifest("baseline:\n  - path: a.ts\n    symbols: [x, y]\n", "m.yaml");
		const s = m.get("baseline")?.[0]?.symbols;
		return Array.isArray(s) && s.join() === "x,y";
	}));
	check("a flow list folded over several lines parses the same, trailing comma and all", attempt(() => {
		const m = parseManifest("baseline:\n  - path: a.ts\n    symbols:\n      [\n        x,\n        y,\n      ]\n    reason: r\n", "m.yaml");
		const e = m.get("baseline")?.[0];
		return Array.isArray(e?.symbols) && e.symbols.join() === "x,y" && e.reason === "r";
	}));
	for (const [name, body] of [
		["a stray line", "infrastructural:\n  path: a.ts\n"],
		["a three-space indent", "infrastructural:\n   - path: a.ts\n"],
		["an unknown section", "muted:\n  - path: a.ts\n"],
		["a duplicate field", "infrastructural:\n  - path: a.ts\n    path: b.ts\n"],
		["a field before any entry", "infrastructural:\n    reason: x\n"],
		["an unquoted `#`", "baseline:\n  - issue: #123\n"],
		['an unquoted ": "', "infrastructural:\n  - reason: note: this\n"],
		["an empty value", "infrastructural:\n  - path:\n"],
		["an unterminated flow list", "tier_separation:\n  - symbols: [a,\n"],
	]) {
		let threw = false;
		try {
			parseManifest(body, "m.yaml");
		} catch {
			threw = true;
		}
		check(`${name} is a parse FAILURE`, threw);
	}
	check("a well-formed entry validates clean", validateManifest(parseManifest("tier_separation:\n  - path: a.ts\n    suite: [t.ts]\n    symbols: [x]\n    reason: r\n", "m.yaml"), "m.yaml").length === 0);
	check("a tier_separation entry with no symbols is REFUSED", validateManifest(parseManifest("tier_separation:\n  - path: a.ts\n    suite: [t.ts]\n    symbols: []\n    reason: r\n", "m.yaml"), "m.yaml").length > 0);
	check("a baseline entry with no issue is REFUSED", validateManifest(parseManifest("baseline:\n  - path: a.ts\n    symbols: [x]\n    state: no-test\n    reason: r\n", "m.yaml"), "m.yaml").length > 0);
	check("a baseline entry with an invented state is REFUSED", validateManifest(parseManifest('baseline:\n  - path: a.ts\n    symbols: [x]\n    issue: "#1"\n    state: soon\n    reason: r\n', "m.yaml"), "m.yaml").length > 0);

	process.stdout.write("\n D0 — the config and the manifest must agree in BOTH directions\n");
	const base = {
		"p/vitest.config.ts": configFixture(['\t\t\tinclude: ["lib/**"],', '\t\t\texclude: ["lib/mod.ts"],']),
		"p/lib/mod.ts": "export const alpha = 1;\n",
		"p/tests/suite.test.ts": 'import { alpha } from "@/lib/mod";\nconsole.log(alpha);\n',
	};
	const manifest = ["tier_separation:", "  - path: lib/mod.ts", "    suite: [tests/suite.test.ts]", "    symbols: [alpha]", "    reason: r", ""].join("\n");
	check("agreeing config + manifest PASS", runFixture({ ...base, "p/coverage-exclusions.yaml": manifest }).problems.length === 0, JSON.stringify(runFixture({ ...base, "p/coverage-exclusions.yaml": manifest }).problems));
	check(
		"an exclusion with no manifest entry FAILS",
		runFixture({
			...base,
			"p/vitest.config.ts": configFixture(['\t\t\tinclude: ["lib/**"],', '\t\t\texclude: ["lib/mod.ts", "lib/other.ts"],']),
			"p/lib/other.ts": "export const gamma = 1;\n",
			"p/coverage-exclusions.yaml": manifest,
		}).problems.some((p) => p.includes("lib/other.ts") && p.includes("no entry")),
	);
	check(
		"a manifest entry whose exclusion was REMOVED FAILS",
		runFixture({
			...base,
			"p/vitest.config.ts": configFixture(['\t\t\tinclude: ["lib/**"],', '\t\t\texclude: ["**/*.d.ts"],']),
			"p/coverage-exclusions.yaml": manifest,
		}).problems.some((p) => p.includes("no longer excluded")),
	);

	process.stdout.write("\n D1 — a literal entry must still name a file; a glob is deliberately unchecked\n");
	check(
		"a literal entry naming a deleted file FAILS",
		runFixture({
			"p/vitest.config.ts": configFixture(['\t\t\texclude: ["lib/gone.config.ts"],']),
			"p/lib/kept.ts": "export const a = 1;\n",
			"p/coverage-exclusions.yaml": "infrastructural:\n  - path: lib/gone.config.ts\n    reason: r\n",
		}).problems.some((p) => p.includes("names no file")),
	);
	check(
		"a glob matching nothing PASSES — same reason ts-coverage.mjs states",
		runFixture({
			"p/vitest.config.ts": configFixture(['\t\t\texclude: ["lib/nothing/migrations/**"],']),
			"p/lib/kept.ts": "export const a = 1;\n",
			"p/coverage-exclusions.yaml": "infrastructural:\n  - path: lib/nothing/migrations/**\n    reason: r\n",
		}).problems.length === 0,
	);

	process.stdout.write("\n D2 — the classifier, with the PATH held constant and only the import FORM varied\n");
	const d2 = (body, extra) => runFixture(d2Fixture(body, extra)).problems;
	check("a VALUE import of the symbol is evidence", d2('import { alpha } from "@/lib/mod";\nconsole.log(alpha);\n').length === 0, JSON.stringify(d2('import { alpha } from "@/lib/mod";\n')));
	check("`import type { alpha }` is NOT evidence", d2('import type { alpha } from "@/lib/mod";\n').some((p) => p.includes("never value-imports")));
	check("`import { type alpha }` is NOT evidence", d2('import { type alpha } from "@/lib/mod";\n').some((p) => p.includes("never value-imports")));
	check(
		"a side-effect `import \"x\"` before a named import does not swallow it",
		d2('import "./setup";\nimport { alpha } from "@/lib/mod";\nconsole.log(alpha);\n', { "p/tests/setup.ts": "export const s = 1;\n" }).length === 0,
	);
	check(
		"a vi.mock of the SAME module and symbol is NOT evidence",
		d2('import { vi } from "vitest";\nvi.mock("@/lib/mod", () => ({ alpha: vi.fn() }));\nimport { alpha } from "@/lib/mod";\nconsole.log(alpha);\n').some((p) => p.includes("vi.mock")),
	);
	check("a value import of the WRONG symbol names the missing one", d2('import { beta } from "@/lib/mod";\nconsole.log(beta);\n').some((p) => p.includes("claims `alpha`")));
	check("a namespace import proves every symbol", d2('import * as mod from "@/lib/mod";\nconsole.log(mod);\n').length === 0);
	check("`await import()` proves every symbol", d2('const mod = await import("@/lib/mod");\nconsole.log(mod);\n').length === 0);
	check(
		"a re-export barrel is followed ONE level",
		d2('import { alpha } from "@/lib/barrel";\nconsole.log(alpha);\n', { "p/lib/barrel.ts": 'export { alpha } from "./mod";\n' }).length === 0,
	);
	check(
		"a TYPE re-export through the same barrel is NOT evidence",
		d2('import { alpha } from "@/lib/barrel";\nconsole.log(alpha);\n', { "p/lib/barrel.ts": 'export type { alpha } from "./mod";\n' }).some((p) => p.includes("never value-imports")),
	);
	check(
		"a suite reaching the module through its own relative helper is evidence",
		d2('import { alpha } from "./helper";\nconsole.log(alpha);\n', { "p/tests/helper.ts": 'export { alpha } from "@/lib/mod";\n' }).length === 0,
	);
	check(
		"a DEPENDENCY importing the module is NOT evidence — aliased edges are not walked transitively",
		d2('import { gamma } from "@/lib/dep";\nconsole.log(gamma);\n', { "p/lib/dep.ts": 'import { alpha } from "./mod";\nexport const gamma = alpha;\n' }).some((p) => p.includes("never value-imports")),
	);
	check(
		"an unresolvable project specifier is a FAILURE, not a skip",
		d2('import { alpha } from "@/lib/mod";\nimport { nope } from "@/lib/does-not-exist";\nconsole.log(alpha, nope);\n').some((p) => p.includes("cannot resolve")),
	);
	check(
		"a bare npm specifier is external, not unresolvable",
		d2('import { describe } from "vitest";\nimport { eq } from "drizzle-orm";\nimport { alpha } from "@/lib/mod";\nconsole.log(describe, eq, alpha);\n').length === 0,
	);
	check(
		"a suite named in the manifest that does not exist FAILS",
		runFixture({
			...d2Fixture('import { alpha } from "@/lib/mod";\n'),
			"p/coverage-exclusions.yaml": "tier_separation:\n  - path: lib/mod.ts\n    suite: [tests/ghost.test.ts]\n    symbols: [alpha]\n    reason: r\n",
		}).problems.some((p) => p.includes("does not exist")),
	);

	process.stdout.write("\n D2b — a baseline entry must still BE debt\n");
	// `mock-only` is what tests/lib/reconcile/loop.test.ts does: mock the module, then import the
	// mocked names to assert call counts. The fixture spells that out because the state's check is
	// now per SYMBOL — "the module is mocked somewhere" is true of every export a partly-proven
	// module has, including ones no test mentions.
	const MOCK_AND_IMPORT = 'import { vi } from "vitest";\nvi.mock("@/lib/mod");\nimport { alpha } from "@/lib/mod";\nconsole.log(alpha);\n';
	const baselineFixture = (state, suiteBody) => ({
		"p/vitest.config.ts": configFixture(['\t\t\tinclude: ["lib/**"],', '\t\t\texclude: ["lib/mod.ts"],']),
		"p/lib/mod.ts": "export const alpha = 1;\n",
		"p/tests/suite.test.ts": suiteBody,
		"p/coverage-exclusions.yaml": `baseline:\n  - path: lib/mod.ts\n    symbols: [alpha]\n    issue: "#1"\n    state: ${state}\n    reason: nothing executes it\n`,
	});
	check("`no-test` over a module no test names PASSES", runFixture(baselineFixture("no-test", 'import { it } from "vitest";\nit("x", () => {});\n')).problems.length === 0);
	check(
		"`no-test` over a module a test MOCKS FAILS",
		runFixture(baselineFixture("no-test", 'import { vi } from "vitest";\nvi.mock("@/lib/mod");\n')).problems.some((p) => p.includes("no-test")),
	);
	check(
		"`mock-only` over a module nothing mocks FAILS",
		runFixture(baselineFixture("mock-only", 'import { it } from "vitest";\nit("x", () => {});\n')).problems.some((p) => p.includes("mock-only")),
	);
	check(
		"`mock-only` over a module whose mocked names a test imports PASSES",
		runFixture(baselineFixture("mock-only", MOCK_AND_IMPORT)).problems.length === 0,
		JSON.stringify(runFixture(baselineFixture("mock-only", MOCK_AND_IMPORT)).problems),
	);
	check(
		"a baseline symbol that gained a REAL test FAILS — a baseline is shrink-only",
		runFixture(baselineFixture("no-test", 'import { alpha } from "@/lib/mod";\nconsole.log(alpha);\n')).problems.some((p) => p.includes("shrink-only")),
	);

	process.stdout.write("\n D3 — an include allowlist is an exclusion with the sign flipped\n");
	const allowlist = {
		"q/vitest.config.ts": configFixture(['\t\t\tinclude: ["src/kept.ts"],', '\t\t\texclude: ["src/**/*.d.ts"],']),
		"q/src/kept.ts": "export const a = 1;\n",
		"q/src/hidden.ts": "export const b = 2;\n",
		"q/src/also-hidden.tsx": "export const c = 3;\n",
		"p/vitest.config.ts": configFixture(['\t\t\texclude: ["lib/mod.config.ts"],']),
		"p/lib/mod.config.ts": "export const alpha = 1;\n",
		"p/coverage-exclusions.yaml": "infrastructural:\n  - path: lib/mod.config.ts\n    reason: r\n",
	};
	const d3 = runFixture(allowlist);
	check("a hand-listed include with unmanifested peers FAILS", d3.problems.some((p) => p.includes("hand-listed allowlist")), JSON.stringify(d3.problems));
	check("...and it NAMES every unlisted peer", d3.problems.some((p) => p.includes("hidden.ts") && p.includes("also-hidden.tsx")));
	// `q` gains a manifest in the two PASSING cases below, because its `exclude:` is now owed one
	// whether or not its `include:` is an allowlist — D0 runs in the unenrolled direction too.
	check(
		"a glob-only include is NOT an allowlist",
		attempt(() => {
			const res = runFixture({
				...allowlist,
				"q/vitest.config.ts": configFixture(['\t\t\tinclude: ["src/**"],', '\t\t\texclude: ["src/**/*.d.ts"],']),
				"q/coverage-exclusions.yaml": 'infrastructural:\n  - path: "src/**/*.d.ts"\n    reason: r\n',
			});
			return res.problems.length === 0 || JSON.stringify(res.problems);
		}),
	);
	check(
		"a literal include whose peers are all excluded is NOT an allowlist — the apps/marketing shape",
		attempt(() => {
			const res = runFixture({
				...allowlist,
				"q/vitest.config.ts": configFixture(['\t\t\tinclude: ["proxy.ts", "lib/**"],', '\t\t\texclude: ["**/*.config.*"],']),
				"q/coverage-exclusions.yaml": 'infrastructural:\n  - path: "**/*.config.*"\n    reason: r\n',
				"q/proxy.ts": "export const a = 1;\n",
				"q/next.config.ts": "export default {};\n",
				"q/lib/thing.ts": "export const b = 2;\n",
			});
			return res.problems.length === 0 || JSON.stringify(res.problems);
		}),
	);
	check("the allowlist peer sweep is NON-recursive — a nested dir is not a peer", attempt(() => {
		const res = runFixture({ ...allowlist, "q/src/deep/nested.ts": "export const d = 4;\n" });
		return res.problems.some((p) => p.includes("hidden.ts") && !p.includes("nested.ts"));
	}));

	// ── the pending-enrolment MARKER (#4103) ──
	//
	// The record used to be a `Map` literal in this file, passed into `run` as a parameter. It is
	// now a per-project FILE, derived from the tree, so that the three enrolment PRs each delete a
	// different file instead of all three editing this one. Every case below writes the marker the
	// repository would write, which is the only way the derivation itself is under test: a record
	// handed in as an argument proves the branch that consumes it and nothing about the branch
	// that FINDS it.
	process.stdout.write(`\n ${MARKER} — a per-project record, derived from the tree, failing in five directions\n`);
	const marked = { ...allowlist, [`q/${MARKER}`]: markerFixture("#4104") };
	check("an unenrolled allowlist with NO marker FAILS", runFixture(allowlist).problems.some((p) => p.includes("no coverage-exclusions.yaml")));
	check("...and the failure NAMES the marker as the way to record it", runFixture(allowlist).problems.some((p) => p.includes(`q/${MARKER} naming the owning issue`)));
	check("a marked project is a NOTE carrying the marker's path and issue, not a pass in silence", attempt(() => {
		const res = runFixture(marked);
		return (
			(res.problems.length === 0 || JSON.stringify(res.problems)) &&
			res.notes.some((n) => n.includes(`q/${MARKER}`) && n.includes("#4104") && n.includes("2 peer file(s)"))
		);
	}));
	check("...and the derived count is reported, so the size of the hole is measured not remembered", runFixture(marked).counts.pendingMarkers === 1);

	// ── the count is a CLAIM (PENDING_MARKER_CEILING) ──
	//
	// Reporting the number was not enough: none of the five failure directions above fires on a
	// marker that is merely NEW, so a project could be recorded rather than enrolled and turn a
	// hard failure into a note, leaving one changed digit in the summary as the only trace. These
	// two cases are the claim, and they run in BOTH directions on purpose — a ceiling that only
	// caught growth would let an enrolment leave slack behind for the next project to spend.
	check(
		"a marker ABOVE the ceiling fails, and the message says a hole was added",
		attempt(() => {
			const res = runFixture(marked, { pendingCeiling: 0 });
			const hit = res.problems.find((x) => x.includes("against a ceiling of 0"));
			if (!hit) return JSON.stringify(res.problems);
			return hit.includes("recorded as pending rather than enrolled") || hit;
		}),
	);
	check(
		"a marker BELOW the ceiling fails too, so an enrolment has to bank the win",
		attempt(() => {
			const res = runFixture(marked, { pendingCeiling: 2 });
			const hit = res.problems.find((x) => x.includes("against a ceiling of 2"));
			if (!hit) return JSON.stringify(res.problems);
			return hit.includes("Lower PENDING_MARKER_CEILING to 1") || hit;
		}),
	);
	check(
		"...and with no ceiling passed, a fixture makes no claim at all",
		runFixture(marked).problems.every((x) => !x.includes("against a ceiling of")),
	);
	check("an optional `reason:` is echoed into the note", attempt(() => {
		const res = runFixture({ ...allowlist, [`q/${MARKER}`]: markerFixture("#4104", "reason: shadcn re-exports, classified in the enrolment PR\n") });
		return res.notes.some((n) => n.includes("shadcn re-exports"));
	}));
	check(
		"a marked project that GAINED a manifest FAILS, asking for the marker to go",
		runFixture({ ...marked, "q/coverage-exclusions.yaml": "infrastructural:\n  - path: src/hidden.ts\n    reason: r\n" }).problems.some((p) => p.includes("now has a")),
	);
	check(
		"a marked project whose allowlist WENT AWAY FAILS too",
		runFixture({ ...marked, "q/vitest.config.ts": configFixture(['\t\t\tinclude: ["src/**"],']) }).problems.some((p) => p.includes("no longer hand-lists")),
	);
	check(
		"a marker beside a project that emits no coverage at all FAILS",
		runFixture({ ...allowlist, [`nowhere/${MARKER}`]: markerFixture("#1") }).problems.some((p) => p.includes("declares no vitest coverage block")),
	);
	// The MUTATION cases. Everything above proves the marker is read; these prove it is CHECKED —
	// that a marker which cannot be trusted fails, rather than quietly recording the project. Each
	// one is a single field of the fixture that passes two cases up, mutated.
	check(
		"a marker with NO `issue:` FAILS — a record that names no owner is not a record",
		runFixture({ ...allowlist, [`q/${MARKER}`]: "# nothing but prose\n" }).problems.some((p) => p.includes("must name the issue that will delete it")),
	);
	check(
		"...and PROSE where the issue goes FAILS — `issue: the coverage epic` is not chaseable",
		runFixture({ ...allowlist, [`q/${MARKER}`]: "issue: the coverage epic\n" }).problems.some((p) => p.includes("is not an issue reference")),
	);
	check(
		"an UNKNOWN key FAILS rather than being ignored — a typo'd `issue` is an absent one",
		runFixture({ ...allowlist, [`q/${MARKER}`]: "isue: #4104\n" }).problems.some((p) => p.includes("unknown key `isue`")),
	);
	check(
		"an unparseable LINE FAILS, naming the line, never skipped",
		runFixture({ ...allowlist, [`q/${MARKER}`]: "issue: #4104\nthis line is not a field\n" }).problems.some((p) => p.includes("cannot parse this line")),
	);
	// The direction that makes the four above matter. An unreadable marker must be worth LESS than
	// no marker, never more: if a bad parse still recorded the project, the cheapest way past this
	// guard would be to corrupt the file it complains about.
	check(
		"an unreadable marker leaves the project UNRECORDED — it fails for the parse AND for the hole",
		attempt(() => {
			const res = runFixture({ ...allowlist, [`q/${MARKER}`]: "isue: #4104\n" });
			return (
				(res.problems.some((p) => p.includes("unknown key")) && res.problems.some((p) => p.includes("hand-listed allowlist and this project has no"))) ||
				JSON.stringify(res.problems)
			);
		}),
	);
	check("...and it is NOT counted as a pending marker", runFixture({ ...allowlist, [`q/${MARKER}`]: "isue: #4104\n" }).counts.pendingMarkers === 0);

	process.stdout.write("\n vacuity — found nothing must never read like looked at nothing\n");
	check("a tree with no coverage-emitting config FAILS", runFixture({ "p/README.md": "x\n" }).problems.some((p) => p.includes("declares a coverage block")));
	check(
		"a tree with configs but no manifest FAILS",
		runFixture({ "p/vitest.config.ts": configFixture(['\t\t\texclude: ["lib/mod.ts"],']), "p/lib/mod.ts": "export const a = 1;\n" }).problems.some((p) => p.includes(`no project carries a ${MANIFEST}`)),
	);
	check(
		"an EMPTY manifest FAILS rather than passing vacuously",
		runFixture({
			"p/vitest.config.ts": configFixture(['\t\t\texclude: ["lib/mod.ts"],']),
			"p/lib/mod.ts": "export const a = 1;\n",
			"p/coverage-exclusions.yaml": "# nothing here\n",
		}).problems.some((p) => p.includes("nothing was checked")),
	);
	check(
		"an unparseable coverage exclude block FAILS, never reads as `no exclusions` (#2724)",
		runFixture({
			"p/vitest.config.ts": configFixture(["\t\t\texclude: [...SHARED],"]),
			"p/lib/mod.config.ts": "export const a = 1;\n",
			"p/coverage-exclusions.yaml": "infrastructural:\n  - path: lib/mod.config.ts\n    reason: r\n",
		}).problems.some((p) => p.includes("did not parse")),
	);
	check("a run over a real tree reports what it examined", attempt(() => {
		const res = runFixture({ ...base, "p/coverage-exclusions.yaml": manifest });
		return res.counts.configs === 1 && res.counts.manifests === 1 && res.counts.entries === 1 && res.counts.walked > 0;
	}));


	process.stdout.write("\n D2 — the spellings that erase, replace, or narrow what a suite reaches\n");
	// `typeof import("m")` is a TYPE QUERY. The first version's dynamic-import regex could not tell
	// it from `await import("m")` and credited a namespace import, proving EVERY export at once —
	// through the one spelling the original fixtures never varied, and one that is already live in
	// the console's own tests.
	check(
		'`typeof import("m")` is NOT evidence — it is erased, like `import type`',
		d2('import type { alpha } from "@/lib/mod";\nlet m: typeof import("@/lib/mod");\nconsole.log(m);\n').some((p) => p.includes("never value-imports")),
	);
	check(
		'…and it does not become evidence next to a real `await import()` of something else',
		d2('let m: typeof import("@/lib/mod");\nconst other = await import("./setup");\nconsole.log(m, other);\n', { "p/tests/setup.ts": "export const s = 1;\n" }).some((p) =>
			p.includes("never value-imports"),
		),
	);
	// Every mock spelling @vitest/mocker 2.1.9 accepts. The PATH, the module and the symbol are
	// identical across all four; only the spelling of the mock varies, so a green result proves
	// the classifier rather than proving the file was findable.
	for (const [name, why, body] of [
		["vi.doMock(\"m\")", "the real API — the old regex was case-sensitive and matched only the non-existent `vi.domock`", 'import { vi } from "vitest";\nvi.doMock("@/lib/mod");\nconst m = await import("@/lib/mod");\nconsole.log(m);\n'],
		["vitest.mock(\"m\")", "`vitest` is the other utils object name the mocker declares", 'import { vitest } from "vitest";\nvitest.mock("@/lib/mod");\nimport { alpha } from "@/lib/mod";\nconsole.log(alpha);\n'],
		['vi.mock(import("m"))', "the mocker rewrites it to the string form before it runs", 'import { vi } from "vitest";\nvi.mock(import("@/lib/mod"));\nimport { alpha } from "@/lib/mod";\nconsole.log(alpha);\n'],
		["vi.mock(`m`)", "a template literal evaluates to the same string at runtime", 'import { vi } from "vitest";\nvi.mock(`@/lib/mod`);\nimport { alpha } from "@/lib/mod";\nconsole.log(alpha);\n'],
	]) {
		check(`\`${name}\` is NOT evidence — ${why}`, d2(body).some((p) => p.includes("vi.mock")));
	}
	check(
		'…and `vi.mock(import("m"))` is not ALSO counted as a namespace import of the same module',
		d2('import { vi } from "vitest";\nvi.mock(import("@/lib/mod"));\nimport { alpha } from "@/lib/mod";\nconsole.log(alpha);\n').some((p) => p.includes("claims `alpha`")),
	);
	// The blanking has its own failure direction, and D2 cannot see it: D2 bails at the mock before
	// it consults the evidence, so the spare `"*"` only shows up where mocked evidence is read per
	// SYMBOL. A suite that mocks the module and imports NO name from it must leave every name
	// unreferenced — with the `import(…)` inside the mock call still counted, all of them would
	// look imported-through-the-mock and any `mock-only` claim would pass.
	check(
		'the `import(…)` inside a `vi.mock` call is not spare namespace evidence',
		runFixture({
			"p/vitest.config.ts": configFixture(['\t\t\tinclude: ["lib/**"],', '\t\t\texclude: ["lib/mod.ts"],']),
			"p/lib/mod.ts": "export const alpha = 1;\n",
			"p/tests/suite.test.ts": 'import { vi } from "vitest";\nvi.mock(import("@/lib/mod"));\n',
			"p/coverage-exclusions.yaml": 'baseline:\n  - path: lib/mod.ts\n    symbols: [alpha]\n    issue: "#1"\n    state: mock-only\n    reason: r\n',
		}).problems.some((p) => p.includes("no test imports that name")),
	);
	// A barrel forwards only what its importer asked for. Both cases hold the barrel's own exports
	// constant and vary WHICH NAME the suite takes through it.
	const barrel = (barrelBody, claim) =>
		runFixture({
			...d2Fixture('import { beta } from "@/lib/barrel";\nconsole.log(beta);\n', {
				"p/lib/barrel.ts": barrelBody,
				"p/lib/mod.ts": "export function alpha() { return 1; }\nexport function beta() { return 2; }\n",
			}),
			"p/coverage-exclusions.yaml": `tier_separation:\n  - path: lib/mod.ts\n    suite: [tests/suite.test.ts]\n    symbols: [${claim}]\n    reason: r\n`,
		}).problems;
	check(
		"a re-export barrel proves only the name the suite took THROUGH it",
		barrel('export { alpha, beta } from "./mod";\n', "beta, alpha").some((p) => p.includes("claims `alpha`")),
	);
	check("…and the name it DID take still passes, with the other one recorded as debt", attempt(() => {
		const res = runFixture({
			...d2Fixture('import { beta } from "@/lib/barrel";\nconsole.log(beta);\n', {
				"p/lib/barrel.ts": 'export { alpha, beta } from "./mod";\n',
				"p/lib/mod.ts": "export function alpha() { return 1; }\nexport function beta() { return 2; }\n",
			}),
			"p/coverage-exclusions.yaml":
				"tier_separation:\n  - path: lib/mod.ts\n    suite: [tests/suite.test.ts]\n    symbols: [beta]\n    reason: r\n" +
				'baseline:\n  - path: lib/mod.ts\n    symbols: [alpha]\n    issue: "#1"\n    state: untested-export\n    reason: r\n',
		});
		return res.problems.length === 0 || JSON.stringify(res.problems);
	}));
	check(
		"`export * from` proves the asked-for name, not every export of the target",
		barrel('export * from "./mod";\n', "beta, alpha").some((p) => p.includes("claims `alpha`")),
	);
	check(
		"a RENAMED re-export maps the exposed name back to the source name",
		runFixture({
			...d2Fixture('import { b } from "@/lib/barrel";\nconsole.log(b);\n', { "p/lib/barrel.ts": 'export { alpha as b } from "./mod";\n' }),
		}).problems.length === 0,
	);
	check(
		"a barrel chain is followed to its end, rather than reported as the suite's failure",
		runFixture({
			...d2Fixture('import { alpha } from "@/lib/index";\nconsole.log(alpha);\n', {
				"p/lib/index.ts": 'export { alpha } from "./sub";\n',
				"p/lib/sub.ts": 'export { alpha } from "./mod";\n',
			}),
		}).problems.length === 0,
	);
	check(
		"a `suite:` that is not a test file proves nothing, however faithfully it imports the module",
		runFixture({
			...d2Fixture('import { it } from "vitest";\nit("x", () => {});\n', { "p/lib/importer.ts": 'import { alpha } from "./mod";\nexport const g = alpha;\n' }),
			"p/coverage-exclusions.yaml": "tier_separation:\n  - path: lib/mod.ts\n    suite: [lib/importer.ts]\n    symbols: [alpha]\n    reason: r\n",
		}).problems.some((p) => p.includes("not a test file")),
	);

	process.stdout.write("\n D2/D2b — an entry that carries a per-symbol claim must name ONE FILE\n");
	// Both blocks used to open `if (target === null) continue; // D1 already reported it`, and D1
	// reports nothing for a glob — so a glob path skipped every check in silence. The manifest
	// records that the lib/queries block "USED TO BE ONE GLOB", which makes this an ordinary edit.
	const globEntry = (section, extra) =>
		runFixture({
			"p/vitest.config.ts": configFixture(['\t\t\tinclude: ["lib/**"],', '\t\t\texclude: ["lib/queries/**"],']),
			"p/lib/queries/a.ts": "export const alpha = 1;\n",
			"p/tests/suite.test.ts": 'import { it } from "vitest";\nit("x", () => {});\n',
			"p/coverage-exclusions.yaml": `${section}:\n  - path: lib/queries/**\n${extra}    reason: r\n`,
		}).problems;
	check("a GLOB in tier_separation FAILS rather than skipping D2", globEntry("tier_separation", "    suite: [tests/suite.test.ts]\n    symbols: [alpha, invented]\n").some((p) => p.includes("cannot carry a per-symbol claim")));
	check("a GLOB in baseline FAILS rather than skipping D2b", globEntry("baseline", '    symbols: [alpha]\n    issue: "#1"\n    state: no-test\n').some((p) => p.includes("cannot carry a per-symbol claim")));
	check(
		"a DIRECTORY path FAILS too — it is a literal, so D1's existsSync passes on it",
		runFixture({
			"p/vitest.config.ts": configFixture(['\t\t\tinclude: ["lib/**"],', '\t\t\texclude: ["lib/queries"],']),
			"p/lib/queries/a.ts": "export const alpha = 1;\n",
			"p/tests/suite.test.ts": 'import { it } from "vitest";\nit("x", () => {});\n',
			"p/coverage-exclusions.yaml": "tier_separation:\n  - path: lib/queries\n    suite: [tests/suite.test.ts]\n    symbols: [alpha]\n    reason: r\n",
		}).problems.some((p) => p.includes("names a directory, not a file")),
	);
	check(
		"…and a manifest that checked ZERO suite claims fails on that alone",
		globEntry("tier_separation", "    suite: [tests/suite.test.ts]\n    symbols: [alpha]\n").some((p) => p.includes("were skipped, not that they passed")),
	);

	process.stdout.write("\n D4 — a `symbols:` list must be COMPLETE, and must name real exports\n");
	const d4 = (modBody, claim) =>
		runFixture({
			...d2Fixture('import { alpha } from "@/lib/mod";\nconsole.log(alpha);\n', { "p/lib/mod.ts": modBody }),
			"p/coverage-exclusions.yaml": `tier_separation:\n  - path: lib/mod.ts\n    suite: [tests/suite.test.ts]\n    symbols: [${claim}]\n    reason: r\n`,
		}).problems;
	check(
		"an export in neither `symbols:` nor `baseline:` FAILS — the gc.ts defect on a new export",
		d4("export function alpha() {}\nexport function gcAuditLogs() {}\n", "alpha").some((p) => p.includes("Unaccounted: gcAuditLogs")),
	);
	check("…and accounting for it in `baseline:` satisfies the rule", attempt(() => {
		const res = runFixture({
			...d2Fixture('import { alpha } from "@/lib/mod";\nconsole.log(alpha);\n', { "p/lib/mod.ts": "export function alpha() {}\nexport function gcAuditLogs() {}\n" }),
			"p/coverage-exclusions.yaml":
				"tier_separation:\n  - path: lib/mod.ts\n    suite: [tests/suite.test.ts]\n    symbols: [alpha]\n    reason: r\n" +
				'baseline:\n  - path: lib/mod.ts\n    symbols: [gcAuditLogs]\n    issue: "#1"\n    state: untested-export\n    reason: r\n',
		});
		return res.problems.length === 0 || JSON.stringify(res.problems);
	}));
	check("a TYPE-only export is not a runtime export and need not be listed", d4("export function alpha() {}\nexport type Row = { a: number };\nexport interface Shape { b: string }\n", "alpha").length === 0);
	check("a claimed symbol the module does not export FAILS — the shape a rename leaves", d4("export function alpha() {}\n", "alpha, renamedAway").some((p) => p.includes("does not export")));
	check("a type annotation's own comma does not invent an export", attempt(() => {
		const res = moduleExports("export const A: Readonly<Record<string, number>> = {};\n", "m.ts");
		return res.problems.length === 0 && [...res.names].join() === "A";
	}));
	check("`export * from` is REPORTED, never silently under-counted", moduleExports('export * from "./other";\n', "m.ts").problems.some((p) => p.includes("cannot be enumerated")));

	process.stdout.write("\n infrastructural — the section that needs no evidence is itself a checked claim\n");
	const infra = (entryPath) =>
		runFixture({
			"p/vitest.config.ts": configFixture([`\t\t\texclude: ["${entryPath}"],`]),
			"p/lib/reconcile/gc.ts": "export const alpha = 1;\n",
			"p/coverage-exclusions.yaml": `infrastructural:\n  - path: "${entryPath}"\n    reason: r\n`,
		}).problems;
	check("product code moved into `infrastructural:` FAILS — the #3262 defect, re-hidden in one line", infra("lib/reconcile/gc.ts").some((p) => p.includes("this path is in none of them")));
	check("…while a declared class passes with no evidence at all", infra("**/*.d.ts").length === 0, JSON.stringify(infra("**/*.d.ts")));

	process.stdout.write("\n D2b — the shrink-only rule reaches `mock-only`, the state the repo uses\n");
	// Reproducing the gc.ts shape exactly: one test mocks the module, a NEW one really imports it.
	// The first version unioned mocks across all 434 console test files, so `covered && !mocked`
	// could never be true for a mocked module and the ratchet was dead code for every `mock-only`
	// entry — while the same fixture recorded as `no-test` went red, which is why the original
	// case passed. The fixture varies the STATE, holding the tree constant.
	const shrink = (state) => ({
		"p/vitest.config.ts": configFixture(['\t\t\tinclude: ["lib/**"],', '\t\t\texclude: ["lib/mod.ts"],']),
		"p/lib/mod.ts": "export const alpha = 1;\n",
		"p/tests/loop.test.ts": 'import { vi } from "vitest";\nvi.mock("@/lib/mod");\nimport { alpha } from "@/lib/mod";\nconsole.log(alpha);\n',
		"p/tests/real.test.ts": 'import { alpha } from "@/lib/mod";\nconsole.log(alpha);\n',
		"p/coverage-exclusions.yaml": `baseline:\n  - path: lib/mod.ts\n    symbols: [alpha]\n    issue: "#1"\n    state: ${state}\n    reason: r\n`,
	});
	check("a `mock-only` symbol that gained a REAL test FAILS", runFixture(shrink("mock-only")).problems.some((p) => p.includes("shrink-only")));
	check("an `untested-export` symbol that gained a REAL test FAILS", runFixture(shrink("untested-export")).problems.some((p) => p.includes("shrink-only")));
	check(
		"`mock-only` over a name no test imports from the mock FAILS — the state is checked per SYMBOL",
		runFixture(baselineFixture("mock-only", 'import { vi } from "vitest";\nvi.mock("@/lib/mod");\n')).problems.some((p) => p.includes("no test imports that name")),
	);
	check(
		"`untested-export` PASSES when the module runs for real and the export is not asserted",
		attempt(() => {
			const res = runFixture({
				"p/vitest.config.ts": configFixture(['\t\t\tinclude: ["lib/**"],', '\t\t\texclude: ["lib/mod.ts"],']),
				"p/lib/mod.ts": "export const alpha = 1;\nexport const beta = 2;\n",
				"p/tests/suite.test.ts": 'import { alpha } from "@/lib/mod";\nconsole.log(alpha);\n',
				"p/coverage-exclusions.yaml":
					"tier_separation:\n  - path: lib/mod.ts\n    suite: [tests/suite.test.ts]\n    symbols: [alpha]\n    reason: r\n" +
					'baseline:\n  - path: lib/mod.ts\n    symbols: [beta]\n    issue: "#1"\n    state: untested-export\n    reason: r\n',
			});
			return res.problems.length === 0 || JSON.stringify(res.problems);
		}),
	);
	check(
		"`untested-export` over a module NOTHING executes FAILS — its premise is the opposite one",
		runFixture(baselineFixture("untested-export", 'import { it } from "vitest";\nit("x", () => {});\n')).problems.some((p) => p.includes("no test executes the module for real")),
	);
	check(
		"`untested-export` over a name imported THROUGH a mock FAILS — `mock-only` is sharper",
		runFixture(baselineFixture("untested-export", 'import { vi } from "vitest";\nvi.mock("@/lib/mod");\nimport { alpha } from "@/lib/mod";\nconsole.log(alpha);\n')).problems.some((p) =>
			p.includes("from a `vi.mock` of the module"),
		),
	);
	check("the same baseline path may be recorded once per STATE, and not twice under one", attempt(() => {
		const twice = validateManifest(
			parseManifest('baseline:\n  - path: a.ts\n    symbols: [x]\n    issue: "#1"\n    state: no-test\n    reason: r\n  - path: a.ts\n    symbols: [y]\n    issue: "#1"\n    state: no-test\n    reason: r\n', "m.yaml"),
			"m.yaml",
		);
		const differing = validateManifest(
			parseManifest('baseline:\n  - path: a.ts\n    symbols: [x]\n    issue: "#1"\n    state: no-test\n    reason: r\n  - path: a.ts\n    symbols: [y]\n    issue: "#1"\n    state: mock-only\n    reason: r\n', "m.yaml"),
			"m.yaml",
		);
		return twice.some((p) => p.includes("same state")) && differing.length === 0;
	}));
	check("one symbol may not be claimed twice for the same path", attempt(() => {
		const dup = validateManifest(
			parseManifest('baseline:\n  - path: a.ts\n    symbols: [x]\n    issue: "#1"\n    state: no-test\n    reason: r\n  - path: a.ts\n    symbols: [x]\n    issue: "#1"\n    state: mock-only\n    reason: r\n', "m.yaml"),
			"m.yaml",
		);
		return dup.some((p) => p.includes("twice"));
	}));

	process.stdout.write("\n D0 — an UNENROLLED project's exclusions are a named hole, not a silent one\n");
	// `checkProject` ran only `if (hasManifest)`, so a coverage-emitting project without one owed
	// nothing and was recorded nowhere, while the success line claimed every exclusion was
	// manifested. Measured on the real tree at the time: six exclusions across three projects.
	const unenrolled = {
		...base,
		"p/coverage-exclusions.yaml": manifest,
		"r/vitest.config.ts": configFixture(['\t\t\texclude: ["src/license.ts"],']),
		"r/src/license.ts": "export const seats = 1;\n",
	};
	check("an exclusion in a project with no manifest FAILS", runFixture(unenrolled).problems.some((p) => p.includes("src/license.ts") && p.includes("no coverage-exclusions.yaml")));
	check("…and is a NOTE naming its count once the project carries a marker", attempt(() => {
		const res = runFixture({ ...unenrolled, [`r/${MARKER}`]: markerFixture("#1") });
		return (res.problems.length === 0 && res.notes.some((n) => n.includes("UNMANIFESTED") && n.includes("src/license.ts"))) || JSON.stringify(res.problems);
	}));
	check(
		"a marked project that hides NOTHING any more FAILS, asking for the marker to go",
		runFixture({
			...base,
			"p/coverage-exclusions.yaml": manifest,
			"r/vitest.config.ts": configFixture(['\t\t\tinclude: ["src/**"],']),
			"r/src/a.ts": "export const a = 1;\n",
			[`r/${MARKER}`]: markerFixture("#1"),
		}).problems.some((p) => p.includes("now hides nothing")),
	);
	check(
		"an unenrolled project whose exclude block does not PARSE fails too (#2724)",
		runFixture({ ...base, "p/coverage-exclusions.yaml": manifest, "r/vitest.config.ts": configFixture(["\t\t\texclude: [...SHARED],"]) }).problems.some((p) => p.includes("did not parse")),
	);
	check(
		"a manifest whose project stopped emitting coverage FAILS — nothing would ever open it again",
		runFixture({
			...base,
			"p/coverage-exclusions.yaml": manifest,
			"r/vitest.config.ts": 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: {} });\n',
			"r/coverage-exclusions.yaml": "tier_separation:\n  - path: lib/ghost.ts\n    suite: [tests/nope.test.ts]\n    symbols: [invented]\n    reason: r\n",
		}).problems.some((p) => p.includes("never read")),
	);

	process.stdout.write("\n the entry-point gate — a SYMLINKED invocation must still run\n");
	// The gate decides whether this file does anything at all, and its failure mode is silence: a
	// wrong comparison exits 0 having printed nothing, which no caller can tell from a pass — a
	// self-test that cannot detect its own non-execution. It cannot be asserted in-process, so the
	// case SPAWNS the guard through a symlinked directory, the shape that broke it.
	{
		const link = path.join(mkdtempSync(path.join(tmpdir(), "cov-excl-link-")), "wt");
		try {
			symlinkSync(ROOT, link);
			// An unknown argument is proof the CLI RAN and needs no repository state to reach.
			execFileSync(process.execPath, [path.join(link, "scripts", "check-coverage-exclusions.mjs"), "--nope"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			check("a symlinked invocation is not silently skipped", false, "expected the usage error, got a clean exit");
		} catch (err) {
			const e = /** @type {{status?: number, stderr?: string}} */ (err);
			check(
				"a symlinked invocation runs the guard rather than exiting 0 in silence",
				e.status === 2 && (e.stderr ?? "").includes("unknown argument"),
				`status ${String(e.status)}, stderr ${JSON.stringify(e.stderr ?? "")}`,
			);
		} finally {
			rmSync(path.dirname(link), { recursive: true, force: true });
		}
	}

	process.stdout.write("\n reuse — the shared parser is the one ts-coverage.mjs hardened\n");
	check("stripTsComments still hides a quoted phrase in prose (#2549)", coverageExcludes('coverage: { // "lib/ghost.ts"\n exclude: ["lib/real.ts"] }') ?.join() === "lib/real.ts");
	check("coverageArrayKey distinguishes an ABSENT include from an empty one", attempt(() => {
		const absent = coverageArrayKey('coverage: { exclude: ["a"] }', "include");
		const empty = coverageArrayKey('coverage: { include: [], exclude: ["a"] }', "include");
		return absent?.found === false && empty?.found === true && empty?.entries.length === 0;
	}));

	process.stdout.write(`\n${failures === 0 ? "✓ all self-test assertions passed" : `✗ ${failures} self-test assertion(s) FAILED`}\n`);
	process.exit(failures === 0 ? 0 : 1);
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Parse argv and run. Never pipe this — `cmd | tail` reports tail's status, not the guard's.
 *
 * GATED ON BEING THE ENTRY POINT, compared REALPATH-RESOLVED. The ESM loader realpaths the main
 * module before deriving `import.meta.filename`; `path.resolve` does not follow a symlink at all,
 * so the two disagree for any invocation whose path crosses one — a symlinked checkout, a
 * container bind-mount, macOS's own `/tmp` -> `/private/tmp`. The disagreement is SILENT: node
 * exits 0 having printed nothing and run nothing, and `--self-test` becomes a self-test that
 * cannot detect its own non-execution. Measured before the fix: `node <symlink>/scripts/…
 * --self-test` exited 0 with zero output.
 */
function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--self-test")) {
		runSelfTest();
		return;
	}
	const unknown = argv.filter((a) => a !== "--self-test");
	if (unknown.length > 0) {
		process.stderr.write(`check-coverage-exclusions: unknown argument ${unknown[0]}\n`);
		process.exit(2);
	}
	process.exit(report(run(ROOT, trackedFiles(ROOT), { pendingCeiling: PENDING_MARKER_CEILING })));
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) main();
