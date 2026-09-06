#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An e2e exclusion's tracking issue must still be OPEN, and nothing checked it.
//
// `test/e2e/addon_exclusions.go` withholds a catalog add-on from the `addons` dimension's
// convergence assertion, and each entry carries an `Issue` so the exclusion cannot become
// permanent by being forgotten. The field's own docstring states the contract:
//
//     It must be OPEN: a CLOSED issue defeats the whole point of the field, and that is not
//     hypothetical — external-dns cited #2734 for two days after #2777 closed it by fixing the
//     very gap the Why described.
//
// `addon_exclusions_pure_test.go` checks `^#\d+$` — the SHAPE. Shape is not state, so the contract
// the docstring spells out was enforced by nobody, and it was already violated on `dev`: the sole
// entry cited #2717, closed on 2026-08-29. The prose said the right thing for six days and the
// tree disagreed with it.
//
// WHY THIS IS NOT A GO TEST. The question needs the network, and every existing check in
// `addon_exclusions_pure_test.go` is pure by design — the file is `_pure_test.go` and runs on every
// PR with no credentials. Putting a GitHub call in it would make the whole file conditional on the
// API, which is how a pure guard becomes a flaky one. So the state question lives here, beside the
// other CI guards, where failing closed on an unreachable API costs a re-run and not a suite.
//
// THREE MODES, NOT TWO — the maintainer's ruling on #3591. `test/e2e/t2_cli_demo.go` carries an
// `Issue` field too, and all four of its numbers are ALSO closed. This guard used to say nothing
// about that file at all, because "is a closed tracker acceptable here?" is a ruling and not a
// thing a guard may assume. The ruling is now made, and it splits the file ROW BY ROW:
//
//     A `CLIGap` row requires an OPEN tracker; a `CloudManual` row requires only that one is filed.
//
// The reason is the difference between a debt and a fact:
//
//   - `CLIGap` is OUR debt — "the product genuinely does this, and the CLI cannot reach it". Debt
//     must be able to CLOSE, and letting its tracker close while the gap still stands is exactly
//     how debt becomes permanent by being forgotten. That is the very failure the addon_exclusions
//     must-be-OPEN rule above exists to prevent, so the same rule applies, for the same reason.
//   - `CloudManual` is a FACT ABOUT A CLOUD — "no API exists; a human opens that cloud's console".
//     The ceiling does not lift because somebody closed the issue, and #2332 (hetzner Object
//     Storage keys) and #2333 (alibaba prepaid CR EE) are permanent. Requiring OPEN there would
//     red the build over four entries that are legitimately closed, and reopening them to satisfy
//     a guard would be the guard editing reality to match itself.
//
// The other half of #3591 — "must the field be split so a gap is distinguishable from a ceiling?"
// — was already answered by the code before the issue was filed: `CLIReach` separates `CLIGap`
// from `CloudManual`, and `SatisfiedBy *CeilingProbe` is required on `CloudManual` and forbidden
// everywhere else (`DemoStep.Validate`, enforced by `TestEveryShippedCeilingCarriesAProbe`). The
// verdict IS the split. This guard reads it rather than adding a second one.
//
// ⚠️ THE ENFORCED ARM IS VACUOUS ON TODAY'S TABLE, ON PURPOSE. There are ZERO `CLIGap` rows — the
// CLI debt was cleared by #2331 — so a live run proves only that the table is empty. That is the
// intended state and must not be dressed up as a clean one: an empty enforced arm prints its own
// distinct line, and the arm's power to discriminate is proven by `--self-test`, which mutates the
// REAL table's source into a `CLIGap` row citing a closed issue and asserts it goes red.
//
// FAIL-CLOSED. An issue whose state cannot be read is an ERROR, not an "assume open". A guard that
// answers "no problem" for "I could not ask" is the defect class this repository has paid for more
// than once: the report and the silence must not render the same.
//
// Usage:
//   node scripts/check-exclusion-issues.mjs              # the check (needs `gh` + a token)
//   node scripts/check-exclusion-issues.mjs --scan-only  # the scans against the real files, no network
//   node scripts/check-exclusion-issues.mjs --self-test  # the pure halves, no network

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The file whose contract is "the Issue must be OPEN", and the field that carries it. */
const GUARDED = "test/e2e/addon_exclusions.go";

/**
 * The file whose contract is PER-ROW, and the two verdicts that divide it.
 *
 * `enforced` is our own debt and must be able to close, so its tracker must be OPEN. `reported` is
 * a cloud ceiling, which no amount of work on this product removes, so its tracker need only be
 * FILED — its state is printed and never enforced. See the ruling at the top of this file.
 *
 * The two verdict names are checked against the `CLIReach` constants the file itself declares
 * (`reachConstants`), so renaming one there fails this guard loudly instead of silently reducing
 * it to a no-op — a hand-written list of what a guard watches stops covering in silence.
 */
const SPLIT = {
	file: "test/e2e/t2_cli_demo.go",
	/** The verdict whose tracker must be OPEN. */
	enforced: "CLIGap",
	/** The verdict whose tracker need only be filed. */
	reported: "CloudManual",
};

/**
 * Every issue number a Go source file records in an `Issue:` struct field.
 *
 * It matches the FIELD, not a bare `#1234` — the exclusion files are dense with prose citing runs
 * and issues by number, and a text scan would hand this guard forty numbers it has no contract
 * over. Anchoring on `Issue:` mirrors the emitter: the struct field is the promise, the prose is
 * commentary.
 *
 * @param {string} source the file's contents
 * @returns {number[]} the issue numbers, de-duplicated, in ascending order
 */
export function issueNumbersIn(source) {
	const found = new Set();
	// `Issue:` then optional whitespace then a quoted "#<digits>".
	//
	// NOT LINE-ANCHORED, and that is a correction rather than a preference. The first version was
	// `^\s*Issue:\s*"#(\d+)"\s*,`, which matched the gofmt-aligned multi-line entries this file
	// happens to contain today and matched NOTHING in a single-line composite literal
	// (`{Kind: NeedsUserConfig, Issue: "#42"}`) — a shape Go accepts and the test file already uses.
	// A future single-line entry would have been silently unchecked, which is the same "guard
	// matches a rendering rather than the thing" failure this guard exists to catch one level down.
	//
	// The boundary is kept — a `{`, a `,` or start-of-line before `Issue:` — so an identifier
	// ending in `Issue` (`TrackingIssue: "#1"`) is not read as this field. The trailing comma is
	// gone with the anchor: a single-line literal's LAST field has none.
	for (const m of source.matchAll(/(?:^|[{,])\s*Issue:\s*"#(\d+)"/gm)) found.add(Number(m[1]));
	return [...found].sort((a, b) => a - b);
}

/**
 * Every line that MENTIONS the field, whether or not the scan above could parse a number from it.
 *
 * This is the emitter-mirror: the pattern above decides what gets checked, and nothing said what
 * happened to an `Issue:` it could not read. A field written in a shape the regex misses would be
 * skipped in exactly the same silence as a file with no exclusions at all — and this guard's whole
 * argument is that those two must not render alike.
 *
 * @param {string} source comment-stripped Go source
 * @returns {string[]} the trimmed lines carrying an `Issue:` field
 */
export function issueFieldLines(source) {
	return source
		.split("\n")
		.filter((line) => /(?:^|[{,])\s*Issue:/.test(line))
		.map((line) => line.trim());
}

/**
 * How many times the field OCCURS, and how many of those the number scan could read.
 *
 * COUNT OCCURRENCES, NOT LINES, AND DO NOT DE-DUPLICATE. The emitter-mirror below used to compare
 * `issueFieldLines().length` (raw lines) against `issueNumbersIn().length` (a de-duplicated Set),
 * which are not the same quantity in either direction:
 *
 *   - two exclusions citing the SAME issue — legitimate, and the reason the Set exists — give two
 *     lines and one number, so the guard failed the build claiming a field was unreadable and then
 *     printed two perfectly readable identical lines;
 *   - one single-line composite carrying two fields (`{Kind: A, Issue: "#1"}, {Kind: B, Issue: "#2"}`)
 *     gives one line and two numbers, which is the very shape `issueNumbersIn` dropped its line
 *     anchor to support.
 *
 * Both directions are false failures in the BLOCKING `--scan-only` step, i.e. this guard redding
 * other people's PRs over a file it can read perfectly well. The quantity the mirror actually wants
 * is "did every occurrence of the field yield a number", so both sides count occurrences with the
 * same boundary and neither collapses duplicates.
 *
 * @param {string} source comment-stripped Go source
 * @returns {{fields: number, readable: number}} occurrence counts, not de-duplicated
 */
export function issueFieldOccurrences(source) {
	const fields = [...source.matchAll(/(?:^|[{,])\s*Issue:/gm)].length;
	const readable = [...source.matchAll(/(?:^|[{,])\s*Issue:\s*"#(\d+)"/gm)].length;
	return { fields, readable };
}

/**
 * Strip `//` line comments so a number quoted inside prose cannot be read as a field.
 *
 * Deliberately line-comments only: this repository's Go has no `/* *\/` blocks in these files, and
 * a half-right block-comment stripper that mangles a string literal would silently drop a REAL
 * field — which is the failure direction that matters, because a dropped field is an unchecked
 * exclusion.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripLineComments(source) {
	return source.split("\n").map(stripLineComment).join("\n");
}

/**
 * Strip one line's `//` comment, ignoring a `//` that falls INSIDE a string literal.
 *
 * `line.indexOf("//")` was not enough, and the failure direction is the bad one: a `Why` string
 * citing a URL truncates its own line, so `{Why: "https://…", Issue: "#5"}` has its `Issue:` deleted
 * before the scan ever sees it — and the guard reports success over an entry it never read. The
 * `Why` strings in addon_exclusions.go already cite file paths and are one edit from citing a URL.
 *
 * Double quotes and backticks only, which is every string Go has. A rune literal cannot contain
 * `//` in one character, so `'` is deliberately not tracked — treating it as a quote would swallow
 * the rest of a line containing an apostrophe in a comment.
 *
 * @param {string} line
 * @returns {string}
 */
function stripLineComment(line) {
	let quote = "";
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (quote) {
			// Backslash escapes apply inside "..." but NOT inside a raw `...` literal.
			if (quote === '"' && ch === "\\") i += 1;
			else if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
	}
	return line;
}

// ── The per-row half: reading a verdict off `test/e2e/t2_cli_demo.go` ─────────────────────────────

/**
 * The `CLIReach` verdict names the file itself declares, DERIVED rather than typed here.
 *
 * A guard that carries a hand-written list of the values it watches stops covering the moment one
 * is renamed, and it stops covering in silence. Reading the const block means a rename either shows
 * up here as a name this guard does not know — which the caller turns into an error — or it does
 * not matter. Matches `Name CLIReach = "…"`, which is the only shape the type is declared in.
 *
 * @param {string} source comment-stripped Go source
 * @returns {string[]} the constant identifiers, in declaration order
 */
export function reachConstants(source) {
	return [...source.matchAll(/^\s*([A-Za-z_]\w*)\s+CLIReach\s*=\s*"/gm)].map((m) => m[1]);
}

/** `Reach: <ident>` — the verdict, at the top level of one composite literal. */
const REACH_FIELD = /Reach:\s*([A-Za-z_]\w*)/y;
/** `Issue:` — the field is MENTIONED, whatever shape its value is in. */
const ISSUE_MENTION = /Issue:\s*/y;
/** `Issue: "#<digits>"` — the field is mentioned in a shape this scan can READ. */
const ISSUE_NUMBER = /Issue:\s*"#(\d+)"/y;

/**
 * Every composite-literal entry that states a `Reach:` or an `Issue:`, with the two paired.
 *
 * WHY A BRACE WALK AND NOT A REGEX PAIR. The obvious implementation — scan for `Issue:`, attribute
 * it to the nearest `Reach:` above it — encodes the way this table is written TODAY rather than
 * what Go means. Go accepts a struct literal's fields in any order, so an entry that happens to put
 * `Issue:` before `Reach:` would be attributed to the PREVIOUS row's verdict, and a `CLIGap` would
 * be silently checked under the ceiling contract. That is the "guard matches a rendering, not the
 * thing" failure this whole file exists one level down to catch.
 *
 * So the pairing is structural: a row is a balanced `{…}` region, and only fields at that region's
 * OWN level count. A nested `&CeilingProbe{…}` or `[]string{…}` is its own region, states neither
 * field, and is therefore not a row. Field order inside a row is irrelevant by construction.
 *
 * Quote-aware for the same reason `stripLineComment` is: a `Why` string containing a brace, or the
 * words `Reach:` or `Issue:`, must not be read as structure. `stripLineComments` should be applied
 * first so a commented-out row is not read as a live one.
 *
 * @param {string} source comment-stripped Go source
 * @returns {{reach: string, issue: number|null, mentions: number, readable: number, line: number,
 *   unbalanced?: boolean}[]} one entry per row, in source order, plus a flagged sentinel if the
 *   brace walk never balanced
 */
export function demoRows(source) {
	/** @type {{reach: string, issue: number|null, mentions: number, readable: number, line: number, unbalanced?: boolean}[]} */
	const rows = [];
	/** @type {typeof rows} */
	const stack = [];
	let quote = "";
	let line = 1;
	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		if (ch === "\n") line += 1;
		if (quote) {
			// Backslash escapes apply inside "…" but NOT inside a raw `…` literal — same rule, and
			// the same reason, as stripLineComment.
			if (quote === '"' && ch === "\\") i += 1;
			else if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "{") {
			stack.push({ reach: "", issue: null, mentions: 0, readable: 0, line });
			continue;
		}
		if (ch === "}") {
			const done = stack.pop();
			// A region that states NEITHER field is not a row — it is an Argv slice, a probe, a
			// function body or the enclosing []DemoStep literal itself.
			if (done && (done.reach !== "" || done.mentions > 0)) rows.push(done);
			continue;
		}
		if (stack.length === 0) continue;
		// A field name must start at a non-word boundary, so `TrackingIssue:` is not this field —
		// the same boundary `issueNumbersIn` keeps, for the same reason. `.` is included so a
		// method-ish `s.Reach` in code cannot be read as a field either.
		if (i > 0 && /[\w.]/.test(source[i - 1])) continue;
		const top = stack[stack.length - 1];
		REACH_FIELD.lastIndex = i;
		const r = REACH_FIELD.exec(source);
		if (r) {
			top.reach = r[1];
			continue;
		}
		ISSUE_MENTION.lastIndex = i;
		if (!ISSUE_MENTION.exec(source)) continue;
		top.mentions += 1;
		ISSUE_NUMBER.lastIndex = i;
		const n = ISSUE_NUMBER.exec(source);
		if (n) {
			top.readable += 1;
			top.issue = Number(n[1]);
		}
	}
	// An unbalanced walk means the scan lost track of the structure, and EVERY row it produced is
	// suspect — a `{` swallowed by a quote-tracking mistake merges two rows into one and pairs a
	// verdict with the next row's Issue. It is emitted as an explicitly flagged row rather than a
	// silent `return`: the first draft pushed a blank row here and the caller's mirror, which only
	// looks at mentions-vs-readable, walked straight past it. A tripwire that the consumer cannot
	// see is not a tripwire.
	if (stack.length > 0) {
		rows.push({ reach: "", issue: null, mentions: 0, readable: 0, line: stack[0].line, unbalanced: true });
	}
	return rows;
}

/**
 * Split the rows by contract and bucket each one's tracker state.
 *
 * `enforced` rows are held to the OPEN rule; `reported` rows have their state recorded and never
 * enforced. A row carrying an `Issue` under NEITHER verdict is neither — it is listed, because a
 * guard that drops what it has no contract over is indistinguishable from one that passed it.
 *
 * @param {ReturnType<typeof demoRows>} rows
 * @param {Map<number, string>} states issue number → "OPEN" | "CLOSED" | "" (unreadable)
 * @param {{enforced: string, reported: string}} contract
 * @returns {{
 *   enforced: {open: number[], closed: number[], unreadable: number[]},
 *   reported: {open: number[], closed: number[], unreadable: number[]},
 *   uncontracted: {reach: string, issue: number}[],
 *   unattributable: {line: number, mentions: number, readable: number, reach: string, unbalanced: boolean}[],
 * }}
 */
export function splitVerdict(rows, states, contract) {
	const bucketOf = () => ({ open: [], closed: [], unreadable: [] });
	const out = {
		enforced: bucketOf(),
		reported: bucketOf(),
		/** @type {{reach: string, issue: number}[]} */ uncontracted: [],
		/** @type {{line: number, mentions: number, readable: number, reach: string, unbalanced: boolean}[]} */ unattributable: [],
	};
	for (const row of rows) {
		// A row that mentions the field more times than the scan could read it, that carries an
		// Issue with no verdict to judge it under, or that came from a brace walk that never
		// balanced, is UNATTRIBUTABLE — not "fine". This is the emitter mirror at row level: the
		// pattern decides what gets checked, so the pattern must also say what it could not.
		if (row.unbalanced || row.mentions !== row.readable || (row.mentions > 0 && row.reach === "")) {
			out.unattributable.push({
				line: row.line,
				mentions: row.mentions,
				readable: row.readable,
				reach: row.reach,
				unbalanced: row.unbalanced === true,
			});
			continue;
		}
		if (row.issue === null) continue;
		const bucket = row.reach === contract.enforced ? out.enforced : row.reach === contract.reported ? out.reported : null;
		if (bucket === null) {
			out.uncontracted.push({ reach: row.reach, issue: row.issue });
			continue;
		}
		const state = states.get(row.issue);
		if (state === "OPEN") bucket.open.push(row.issue);
		else if (state === "CLOSED") bucket.closed.push(row.issue);
		// Anything else — absent, empty, an unexpected verb — is NOT open. Bucketing it with open
		// is the guard answering a question it never got an answer to.
		else bucket.unreadable.push(row.issue);
	}
	return out;
}

/**
 * THE VACUITY FLOOR. The line the enforced arm prints — and the two cases MUST NOT render alike.
 *
 * Today `test/e2e/t2_cli_demo.go` carries zero `CLIGap` rows, so the arm runs over an empty set and
 * has proven nothing about anything. A guard whose "nothing found" branch is its "nothing wrong"
 * branch is the dominant defect class in this repository, and it is exactly the failure the Go side
 * already refuses (`t2_cli_ceiling_pure_test.go`: "the table carries no ceilings at all, so this
 * test asserted nothing"). An empty arm is NOT an error here — zero CLI debt is the intended state,
 * and #2331 is what put it there — but it is said out loud, in its own words, with no ✓.
 *
 * THREE renderings, not two, and the third is a correction: the first draft printed the ✓ line
 * whenever the arm covered any row at all, so a run that had just emitted a CLOSED-tracker error
 * followed it with "✓ every CLIGap tracker is OPEN (0 of 1)" — the summary contradicting the
 * finding directly above it. Found by driving the red case end-to-end rather than by reading it.
 *
 * @param {{checked: number, open: number, findings: number}} counts rows covered, of which open,
 *   and how many produced a finding (closed or unreadable)
 * @param {{enforced: string}} contract
 * @param {string} file
 * @returns {string}
 */
export function enforcedArmLine({ checked, open, findings }, contract, file) {
	if (checked === 0) {
		return `◻ the OPEN arm asserted NOTHING — ${file} carries no ${contract.enforced} row at all.`;
	}
	if (findings > 0) {
		return `✗ ${findings} of ${checked} ${contract.enforced} tracker(s) in ${file} are not OPEN (see above).`;
	}
	return `✓ every ${contract.enforced} tracker in ${file} is OPEN (${open} of ${checked}).`;
}

/**
 * Rewrite the FIRST `Reach: <from>` into `Reach: <to>`, for the self-test's mutation.
 *
 * The fixture it builds is the REAL table's source with one row's verdict changed, not a
 * hand-written approximation of it. A guard tested against a fixture its own author wrote to suit
 * it proves that two things the same author wrote agree; mutating the shipped artifact proves the
 * scan handles the shape that actually exists — gofmt alignment, continued `Why` strings, a nested
 * probe literal and all.
 *
 * @param {string} source
 * @param {string} from the verdict identifier to replace
 * @param {string} to the verdict identifier to write
 * @returns {{source: string, applied: boolean}}
 */
export function mutateOneReach(source, from, to) {
	let applied = false;
	const out = source.replace(new RegExp(`((?:^|[{,])\\s*Reach:\\s*)${from}\\b`, "m"), (_m, lead) => {
		applied = true;
		return `${lead}${to}`;
	});
	return { source: out, applied };
}

/**
 * The verdict, given each issue's state. Pure — the part that decides is separated from the part
 * that asks, because only the deciding part can be wrong in a way a test can catch.
 *
 * @param {Map<number, string>} states issue number → "OPEN" | "CLOSED" | "" (unreadable)
 * @returns {{closed: number[], unreadable: number[], open: number[]}}
 */
export function verdict(states) {
	const closed = [];
	const unreadable = [];
	const open = [];
	for (const [n, state] of [...states.entries()].sort(([a], [b]) => a - b)) {
		if (state === "OPEN") open.push(n);
		else if (state === "CLOSED") closed.push(n);
		// Anything else — an empty string, an unexpected verb, a null — is NOT closed and NOT open.
		// Bucketing it with either would be the guard answering a question it did not get an answer
		// to; it is an error, and the caller exits non-zero on it.
		else unreadable.push(n);
	}
	return { closed, unreadable, open };
}

/**
 * Ask GitHub for one issue's state.
 *
 * @param {number} n
 * @returns {string} "OPEN", "CLOSED", or "" when the state could not be read
 */
function readState(n) {
	try {
		const out = execFileSync("gh", ["issue", "view", String(n), "--json", "state", "--jq", ".state"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { state: out.trim(), error: "" };
	} catch (err) {
		// KEPT, not discarded. A bare `catch` threw away gh's own diagnostic and the caller then
		// asserted one cause — "needs a token" — that it had not measured. `gh` is missing, the
		// token lacks `issues: read`, the issue was deleted, the API is rate-limited and the network
		// is down all land here, and they send an operator to five different places.
		const e = /** @type {{stderr?: Buffer|string, message?: string}} */ (err);
		const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf8");
		const reason = (stderr || e.message || String(err)).trim().split("\n")[0];
		return { state: "", error: reason || "gh failed with no diagnostic" };
	}
}

// ── --self-test ───────────────────────────────────────────────────────────────────────────────────
//
// The two halves that can be wrong without the network: what the scan FINDS, and what the verdict
// MAKES of it. Both are driven in each direction — a guard whose only exercised branch is the one
// it was designed around has been shown to fire, not to be right.
if (process.argv.includes("--self-test")) {
	let pass = 0;
	let fail = 0;
	/** @param {boolean} cond @param {string} what */
	const t = (cond, what) => {
		if (cond) {
			pass += 1;
			console.log(`  ✓ ${what}`);
		} else {
			fail += 1;
			console.error(`  ✗ ${what}`);
		}
	};

	console.log("check-exclusion-issues --self-test\n\n the scan");
	t(
		JSON.stringify(issueNumbersIn('\t\tIssue:  "#2717",\n\t\tIssue: "#3524",\n')) === "[2717,3524]",
		"finds every Issue field, sorted",
	);
	t(JSON.stringify(issueNumbersIn('\t\tIssue:  "#42",\n\t\tIssue: "#42",\n')) === "[42]", "de-duplicates");
	t(JSON.stringify(issueNumbersIn("no fields here\n")) === "[]", "an empty file yields nothing");
	// The reason it anchors on the FIELD: these files quote dozens of run ids and issue numbers in
	// prose, and a bare `#\d+` scan would hand the guard numbers it has no contract over.
	t(
		JSON.stringify(issueNumbersIn('\t\tWhy: "see #2811 and run 33095437088",\n\t\tIssue: "#7",\n')) === "[7]",
		"a number quoted in another FIELD is not read as a tracking issue",
	);
	t(
		JSON.stringify(issueNumbersIn(stripLineComments('\t\t// Issue: "#999" used to be here\n\t\tIssue: "#7",\n'))) ===
			"[7]",
		"a number in a COMMENT is not read as a tracking issue",
	);
	// THE HOLE THE FIRST VERSION HAD. `^\s*Issue:` matched nothing here, so a single-line entry —
	// a shape Go accepts, and one the test file already uses — was silently unchecked.
	t(
		JSON.stringify(issueNumbersIn('ex := map[string]AddOnExclusion{app: {Kind: K, Issue: "#42"}}\n')) === "[42]",
		"a SINGLE-LINE composite literal is read (the anchor bug)",
	);
	t(
		JSON.stringify(issueNumbersIn('\t\t{Kind: K, Issue: "#42", Clouds: nil},\n')) === "[42]",
		"…including one whose Issue is not the last field",
	);
	// …without the anchor swallowing a DIFFERENT field that happens to end in "Issue".
	t(
		JSON.stringify(issueNumbersIn('\t\tTrackingIssue: "#99",\n\t\tIssue: "#7",\n')) === "[7]",
		"a longer field name ending in Issue is not read as this field",
	);

	console.log("\n the emitter mirror");
	t(issueFieldLines('\t\tIssue: "#7",\n\t\tWhy: "x",\n').length === 1, "counts a readable field line");
	t(issueFieldLines('\t\tIssue: someConst,\n').length === 1, "counts an UNREADABLE field line too — that is the point");
	t(issueNumbersIn('\t\tIssue: someConst,\n').length === 0, "…which the number scan does not read, so the counts disagree");
	t(issueFieldLines('\t\tTrackingIssue: "#99",\n').length === 0, "does not count a different field");

	// THE MIRROR COMPARES OCCURRENCES, NOT LINES-VS-A-DEDUPED-SET. Both of the next two are files
	// this guard can read perfectly, and both used to FAIL the blocking --scan-only step: the first
	// because two entries citing one issue collapse in the Set, the second because one line can
	// carry two fields. A guard that reds other people's PRs over a file it understands is worse
	// than the unreadable field it was written to catch.
	{
		const twoEntriesOneIssue = '\t\tIssue: "#42",\n\t\tIssue: "#42",\n';
		const o = issueFieldOccurrences(twoEntriesOneIssue);
		t(o.fields === o.readable, "two entries citing the SAME issue do not trip the mirror");
		t(issueNumbersIn(twoEntriesOneIssue).length === 1 && o.fields === 2, "…even though the number scan de-duplicates to one");

		const oneLineTwoFields = 'ex := map[string]E{a: {Kind: K, Issue: "#1"}, b: {Kind: K, Issue: "#2"}}\n';
		const p = issueFieldOccurrences(oneLineTwoFields);
		t(p.fields === p.readable && p.fields === 2, "two fields on ONE line do not trip the mirror");
	}
	// …and it still fires on the thing it exists for.
	{
		const unreadable = '\t\tIssue: "#7",\n\t\tIssue: someConst,\n';
		const o = issueFieldOccurrences(unreadable);
		t(o.fields === 2 && o.readable === 1, "an UNREADABLE field still trips the mirror");
	}
	// The failure direction that matters: a real field must survive comment-stripping.
	t(
		stripLineComments('\t\tIssue: "#7", // was #999\n').includes('Issue: "#7",'),
		"stripping a trailing comment leaves the field intact",
	);
	// A `//` INSIDE a string must not truncate the line. The Why strings in this file already cite
	// paths and are one edit from citing a URL, and combined with the single-line literal form that
	// deletes a real `Issue:` before the scan ever sees it.
	t(
		stripLineComments('\t\tWhy: "see https://x/y",') === '\t\tWhy: "see https://x/y",',
		"a // inside a double-quoted string is not a comment",
	);
	t(
		JSON.stringify(issueNumbersIn(stripLineComments('{Why: "https://x", Issue: "#5"}\n'))) === "[5]",
		"…so a URL on the same line does not hide the field behind it",
	);
	t(
		stripLineComments("\t\tWhy: `raw//not a comment`,") === "\t\tWhy: `raw//not a comment`,",
		"a // inside a RAW (backtick) string is not a comment either",
	);
	t(
		stripLineComments('\t\tWhy: "he said \\"//\\" once", // real') === '\t\tWhy: "he said \\"//\\" once", ',
		"an escaped quote does not end the string early",
	);
	t(
		stripLineComments("\t\t// it's fine") === "\t\t",
		"an apostrophe in a comment does not open a string (rune literals are not tracked)",
	);

	// ── The per-row split: the contract #3591 ruled on. ──────────────────────────────────────────
	console.log("\n the per-row split");
	{
		const decl =
			'const (\n\tCLIDriven CLIReach = "cli"\n\tCLIGap CLIReach = "cli_gap"\n' +
			'\tCloudManual CLIReach = "cloud_manual"\n\tConsoleOnly CLIReach = "console_only"\n)\n';
		t(
			JSON.stringify(reachConstants(decl)) === '["CLIDriven","CLIGap","CloudManual","ConsoleOnly"]',
			"the verdict names are DERIVED from the file that declares them, not typed here",
		);
		t(reachConstants("var x = 1\n").length === 0, "…and a file declaring none yields none");

		// A nested literal is not a row. Without this the probe and the Argv slice would each be
		// counted, and the mirror below would report rows that state nothing.
		const table =
			"var CLIDemoSteps = []DemoStep{\n" +
			'\t{\n\t\tID: "a",\n\t\tReach: CLIDriven,\n\t\tArgv: []string{"whoami"},\n\t},\n' +
			'\t{\n\t\tID: "b",\n\t\tReach: CloudManual,\n\t\tIssue: "#2332",\n' +
			"\t\tSatisfiedBy: &CeilingProbe{\n\t\t\tKind: ProbeEnvTruthy,\n\t\t},\n\t},\n}\n";
		const rows = demoRows(table);
		t(rows.length === 2, `a nested Argv/probe literal is not a row (saw ${rows.length}, want 2)`);
		t(rows[1].reach === "CloudManual" && rows[1].issue === 2332, "a row pairs its own Reach with its own Issue");
		t(rows[0].issue === null, "a row with no Issue carries none — it is not inherited from a sibling");

		// FIELD ORDER IS IRRELEVANT, and this is the case a "nearest Reach above" scan gets WRONG:
		// the second row's Issue would be attributed to the FIRST row's CloudManual, and a CLIGap
		// would be silently checked under the ceiling contract.
		const outOfOrder = '[]DemoStep{\n\t{Reach: CloudManual, Issue: "#1"},\n\t{Issue: "#2", Reach: CLIGap},\n}\n';
		const oo = demoRows(outOfOrder);
		t(oo.length === 2, "two single-line rows are two rows");
		t(
			oo[1].reach === "CLIGap" && oo[1].issue === 2,
			"a row stating Issue BEFORE Reach is attributed to its OWN verdict",
		);

		// A Why string is prose. It may contain a brace, and it may quote the words this scan looks
		// for — the real table's Why strings already quote issue numbers and file paths.
		const trickyWhy =
			'{\n\tReach: CloudManual,\n\tIssue: "#5",\n' +
			'\tWhy: "a brace { and the words Reach: CLIGap and Issue: \\"#99\\" written in prose",\n}\n';
		const tw = demoRows(trickyWhy);
		t(tw.length === 1 && tw[0].reach === "CloudManual" && tw[0].issue === 5, "a Why string cannot fake a verdict");
		t(tw[0].mentions === 1, "…nor an extra Issue field");

		// The row-level emitter mirror: a field the scan cannot read is COUNTED, not skipped.
		const unreadableRow = "{\n\tReach: CLIGap,\n\tIssue: trackerConst,\n}\n";
		const ur = demoRows(unreadableRow);
		t(ur.length === 1 && ur[0].mentions === 1 && ur[0].readable === 0, "an Issue in an unreadable shape is still counted");
		t(
			splitVerdict(ur, new Map(), SPLIT).unattributable.length === 1,
			"…and lands in unattributable rather than passing silently",
		);
		t(
			splitVerdict(demoRows('{\n\tIssue: "#8",\n}\n'), new Map(), SPLIT).unattributable.length === 1,
			"an Issue on a row with NO verdict is unattributable too — there is no contract to judge it under",
		);

		// AN UNBALANCED WALK IS NOT A PASS. The first draft pushed a blank sentinel row here, and
		// the mirror — which only compares mentions against readable — walked straight past it: a
		// truncated or mis-quoted file would have been reported clean. A tripwire the consumer
		// cannot see is not a tripwire.
		const truncated = '[]DemoStep{\n\t{Reach: CLIGap, Issue: "#9"},\n';
		const tr = demoRows(truncated);
		t(tr.some((r) => r.unbalanced === true), "an unclosed literal is flagged, not silently dropped");
		t(
			splitVerdict(tr, new Map([[9, "OPEN"]]), SPLIT).unattributable.some((r) => r.unbalanced),
			"…and the unbalanced flag reaches the caller's mirror, which reds",
		);
		t(
			demoRows('[]DemoStep{\n\t{Reach: CLIGap, Issue: "#9"},\n}\n').every((r) => r.unbalanced !== true),
			"…while a balanced file raises it for nobody",
		);

		// THE RULING ITSELF, in both directions and on the same state.
		const ruled = demoRows(
			'[]DemoStep{\n\t{Reach: CLIGap, Issue: "#11"},\n\t{Reach: CloudManual, Issue: "#22"},\n\t{Reach: ConsoleOnly, Issue: "#33"},\n}\n',
		);
		const s = splitVerdict(ruled, new Map([[11, "CLOSED"], [22, "CLOSED"], [33, "OPEN"]]), SPLIT);
		t(JSON.stringify(s.enforced.closed) === "[11]", "a CLIGap row citing a CLOSED issue is a FINDING — our debt must be able to close");
		t(JSON.stringify(s.reported.closed) === "[22]", "…and a CloudManual row on the SAME state is recorded, never enforced");
		t(JSON.stringify(s.uncontracted) === '[{"reach":"ConsoleOnly","issue":33}]', "a verdict under neither contract is listed, not dropped");
		const open = splitVerdict(demoRows('{Reach: CLIGap, Issue: "#11"}\n'), new Map([[11, "OPEN"]]), SPLIT);
		t(JSON.stringify(open.enforced.open) === "[11]" && open.enforced.closed.length === 0, "a CLIGap row citing an OPEN issue is clean");
		// FAIL-CLOSED here too: the enforced arm must not read an unanswered question as open.
		const dunno = splitVerdict(demoRows('{Reach: CLIGap, Issue: "#11"}\n'), new Map([[11, ""]]), SPLIT);
		t(JSON.stringify(dunno.enforced.unreadable) === "[11]" && dunno.enforced.open.length === 0, "an unreadable state on a CLIGap row is an error, not an assumed open");
	}

	// ── The vacuity floor. ───────────────────────────────────────────────────────────────────────
	console.log("\n the vacuity floor");
	{
		const empty = enforcedArmLine({ checked: 0, open: 0, findings: 0 }, SPLIT, SPLIT.file);
		const clean = enforcedArmLine({ checked: 2, open: 2, findings: 0 }, SPLIT, SPLIT.file);
		const red = enforcedArmLine({ checked: 1, open: 0, findings: 1 }, SPLIT, SPLIT.file);
		t(empty !== clean, "an EMPTY enforced arm and a CLEAN one do not render alike");
		t(!empty.startsWith("✓"), "…and the empty one carries no tick");
		t(clean.startsWith("✓"), "…while the clean one does");
		t(empty.includes("asserted NOTHING"), "the empty rendering says so in words, not by omission");
		// The correction: the first draft printed the ✓ line for a RED arm too, so a CLOSED-tracker
		// error was immediately contradicted by "✓ every CLIGap tracker is OPEN (0 of 1)".
		t(new Set([empty, clean, red]).size === 3, "empty, clean and RED are three distinct renderings");
		t(!red.startsWith("✓"), "a red arm never carries a tick");
	}

	// ── The enforced arm against the REAL table, by mutation. ────────────────────────────────────
	//
	// This is the whole difficulty of the unit. The live table has ZERO CLIGap rows, so running the
	// new arm over it proves only that the table is empty. The proof has to come from a mutation —
	// and the thing mutated is the SHIPPED source, not a fixture written to suit the scan, because
	// a guard tested only against its author's own fixture proves that two things one author wrote
	// agree with each other.
	console.log("\n the enforced arm, against the REAL table");
	{
		const real = stripLineComments(readFileSync(path.join(ROOT, SPLIT.file), "utf8"));
		const names = reachConstants(real);
		t(
			names.includes(SPLIT.enforced) && names.includes(SPLIT.reported),
			`${SPLIT.file} still declares ${SPLIT.enforced} and ${SPLIT.reported} (saw ${names.join(", ") || "none"})`,
		);
		const realRows = demoRows(real);
		const withIssue = realRows.filter((r) => r.readable > 0);
		t(withIssue.length > 0, `the real table still carries tracking issues (${withIssue.length})`);
		const control = splitVerdict(realRows, new Map(), SPLIT);
		t(control.unattributable.length === 0, "every Issue field in the real table is attributable to a verdict");
		const enforcedRows =
			control.enforced.open.length + control.enforced.closed.length + control.enforced.unreadable.length;
		// THE MEASURED FACT this unit turns on, asserted rather than asserted-about.
		t(
			enforcedRows === 0,
			`the real table carries ${enforcedRows} ${SPLIT.enforced} row(s) — zero is why the mutation below is the proof`,
		);

		const { source: mutated, applied } = mutateOneReach(real, SPLIT.reported, SPLIT.enforced);
		// PROVE THE MUTATION APPLIED. A mutation gate whose mutation silently did not apply passes
		// for the wrong reason, and reads exactly like one that works.
		t(applied, "the mutation APPLIED to the real source");
		t(mutated !== real, "…and changed it");
		const mutatedRows = demoRows(mutated);
		const flipped = mutatedRows.filter((r) => r.reach === SPLIT.enforced && r.issue !== null);
		t(flipped.length === 1, `exactly one real row flipped to ${SPLIT.enforced} (saw ${flipped.length})`);
		const allClosed = new Map(mutatedRows.filter((r) => r.issue !== null).map((r) => [r.issue, "CLOSED"]));
		const after = splitVerdict(mutatedRows, allClosed, SPLIT);
		t(after.enforced.closed.length === 1, "a synthetic CLIGap row citing a CLOSED issue REDS the enforced arm");
		t(
			after.reported.closed.length === withIssue.length - 1,
			`…while the remaining ${withIssue.length - 1} CloudManual row(s) on the same CLOSED state do not (saw ${after.reported.closed.length})`,
		);
		t(after.unattributable.length === 0, "…and the mutated source is still fully attributable");
	}

	console.log("\n the verdict");
	// verdict() takes states; readState() now returns {state, error} so gh's own words survive. The
	// bare `catch` that discarded them let the caller assert a cause it had not measured.
	const v = verdict(new Map([[1, "OPEN"], [2, "CLOSED"], [3, ""], [4, "SOMETHING_ELSE"]]));
	t(JSON.stringify(v.open) === "[1]", "OPEN is open");
	t(JSON.stringify(v.closed) === "[2]", "CLOSED is closed");
	// THE FAIL-CLOSED CASE, both shapes. An unreadable state must never be bucketed with open —
	// that is the guard reporting green over a question it never got an answer to.
	t(JSON.stringify(v.unreadable) === "[3,4]", "an empty OR unexpected state is unreadable, not open");
	t(!v.open.includes(3) && !v.open.includes(4), "an unreadable state is never counted as open");
	t(!v.closed.includes(3) && !v.closed.includes(4), "…and never as closed either");
	t(JSON.stringify(verdict(new Map()).unreadable) === "[]", "no issues yields no findings");

	console.log("");
	if (fail === 0) {
		console.log(`check-exclusion-issues self-test: all ${pass} passed`);
		process.exit(0);
	}
	console.error(`check-exclusion-issues self-test: ${fail} of ${pass + fail} FAILED`);
	process.exit(1);
}

// ── the check ─────────────────────────────────────────────────────────────────────────────────────

// TWO MODES, because the two halves have different failure characteristics and belong in different
// CI steps.
//
//   --scan-only   reads the file and validates the SCAN. Pure — no network, no token — so it is the
//                 BLOCKING step. It was previously reachable only from the network step, which is
//                 `continue-on-error`, so the "found NO Issue fields" tripwire — the one whose own
//                 message says "a guard that silently checks nothing is worse than no guard" —
//                 could never red the build. A regex that stopped matching produced an annotation
//                 on a green job and nothing else.
//   (default)     the same scan, then the GitHub call. Advisory in CI: an issue closing is a state
//                 change in GitHub, not in the diff.
const scanOnly = process.argv.includes("--scan-only");

/**
 * Read one guarded file, or die NAMING it.
 *
 * NAMED, not a raw Node stack. If the file is renamed or moved, "ENOENT ... at Object.readFileSync"
 * tells a reader nothing about what this guard wanted, and the guard's own contract — that it must
 * not silently check nothing — is exactly what a crash here would obscure.
 *
 * @param {string} rel repo-relative path
 * @param {string} constant the name of the constant in this script that must be updated
 * @returns {string}
 */
function readSubject(rel, constant) {
	try {
		return readFileSync(path.join(ROOT, rel), "utf8");
	} catch (err) {
		console.error(`::error::check-exclusion-issues: cannot read ${rel} (${err instanceof Error ? err.message : String(err)}).`);
		console.error(`  If that file was renamed or moved, update ${constant} in this script in the same PR.`);
		console.error("  This is an error rather than a skip: a guard that cannot find its subject has");
		console.error("  checked nothing, and must not report success.");
		process.exit(1);
	}
}

const source = stripLineComments(readSubject(GUARDED, "GUARDED"));
const numbers = issueNumbersIn(source);

// An empty scan is an ERROR. `addOnExclusions` may legitimately become empty — that is the whole
// point of the ratchet above it — but a scan that finds nothing is indistinguishable from a regex
// that stopped matching after a gofmt change, and this guard reporting "all clear" over a broken
// scan is exactly what it exists to prevent one level down.
if (numbers.length === 0) {
	console.error(`::error::check-exclusion-issues: found NO Issue fields in ${GUARDED}.`);
	console.error("  Either every exclusion has been removed — in which case delete this check in the");
	console.error("  same PR — or the scan has stopped matching the field. It is an error either way:");
	console.error("  a guard that silently checks nothing is worse than no guard.");
	process.exit(1);
}

// EVERY mention accounted for. A line that names the field but yields no number is a field the
// scan could not read, and skipping it silently is the one failure mode this guard cannot afford:
// its own "all clear" would then be a statement about the regex, not about the file.
const mentions = issueFieldLines(source);
const { fields, readable } = issueFieldOccurrences(source);
if (fields !== readable) {
	console.error(
		`::error::check-exclusion-issues: ${GUARDED} names the Issue field ${fields} time(s) but ` +
			`${readable} of those are in a shape this scan can read — at least one is unreadable.`,
	);
	console.error('  The expected shape is `Issue: "#<digits>"`. Lines seen:');
	for (const line of mentions) console.error(`    ${line}`);
	console.error("  This is an error rather than a skip: an unreadable field is unchecked, and an");
	console.error("  unchecked field is indistinguishable from a checked one in the output below.");
	process.exit(1);
}

// ── the per-row file: the same scan, then the split the ruling on #3591 makes ─────────────────────

const splitSource = stripLineComments(readSubject(SPLIT.file, "SPLIT.file"));

// The two verdict names this guard holds contracts over must still be names the FILE declares.
// A guard carrying a hand-written list of what it watches stops covering in silence the moment one
// is renamed — and "CLIGap no longer exists" would otherwise reduce the enforced arm to a
// permanent, invisible no-op that looks exactly like today's legitimate zero.
const reachNames = reachConstants(splitSource);
const unknownContract = [SPLIT.enforced, SPLIT.reported].filter((name) => !reachNames.includes(name));
if (unknownContract.length > 0) {
	console.error(
		`::error::check-exclusion-issues: ${SPLIT.file} does not declare ${unknownContract.join(", ")} — ` +
			`this guard holds a contract over a verdict that no longer exists.`,
	);
	console.error(`  It declares: ${reachNames.join(", ") || "(no CLIReach constants at all)"}`);
	console.error("  Update SPLIT in this script in the same PR as the rename. This is an error rather");
	console.error("  than a skip: an arm that matches nothing renders exactly like an arm with nothing");
	console.error("  to find, and one of those is a broken guard.");
	process.exit(1);
}

const splitRows = demoRows(splitSource);
const splitIssueRows = splitRows.filter((r) => r.mentions > 0);
if (splitIssueRows.length === 0) {
	console.error(`::error::check-exclusion-issues: found NO Issue fields in ${SPLIT.file}.`);
	console.error("  Either every gap and every ceiling has been removed — in which case the bar is met");
	console.error("  and this arm should be deleted in the same PR — or the row scan has stopped");
	console.error("  matching. It is an error either way: a guard that silently checks nothing is worse");
	console.error("  than no guard.");
	process.exit(1);
}

// The row-level emitter mirror, run BEFORE any state is asked for so it reds in --scan-only too.
const splitShape = splitVerdict(splitRows, new Map(), SPLIT);
if (splitShape.unattributable.length > 0) {
	console.error(
		`::error::check-exclusion-issues: ${SPLIT.file} has ${splitShape.unattributable.length} row(s) whose ` +
			"Issue field this scan cannot attribute to a verdict.",
	);
	for (const r of splitShape.unattributable) {
		if (r.unbalanced) {
			console.error(
				`    the brace walk never balanced — it ended inside a literal opened near line ${r.line}. ` +
					"Every row above it is suspect, not just this one.",
			);
			continue;
		}
		console.error(
			`    line ~${r.line}: verdict ${r.reach || "(none stated at this level)"}, ` +
				`Issue mentioned ${r.mentions}×, readable ${r.readable}×`,
		);
	}
	console.error('  The expected shape is a struct literal stating `Reach: <verdict>` and `Issue: "#<digits>"`');
	console.error("  at the SAME level. An unattributable row is unchecked, and an unchecked row is");
	console.error("  indistinguishable from a checked one in the output below.");
	process.exit(1);
}

const splitNumbers = [...new Set(splitIssueRows.map((r) => r.issue).filter((n) => n !== null))].sort((a, b) => a - b);

if (scanOnly) {
	console.log(`✓ scan: ${numbers.length} tracking issue(s) read from ${GUARDED} (${numbers.map((n) => `#${n}`).join(", ")})`);
	const enforcedSeen = splitRows.filter((r) => r.reach === SPLIT.enforced).length;
	const reportedSeen = splitRows.filter((r) => r.reach === SPLIT.reported).length;
	console.log(
		`✓ scan: ${splitNumbers.length} tracking issue(s) read from ${SPLIT.file} across ${splitRows.length} row(s) — ` +
			`${enforcedSeen} ${SPLIT.enforced} (OPEN enforced), ${reportedSeen} ${SPLIT.reported} (filed only)`,
	);
	console.log("  Their STATE is not checked here — that needs the GitHub API. See the step after this one.");
	process.exit(0);
}

// One state read per issue, shared by both files: the same number can legitimately appear in both,
// and asking GitHub twice for it is a rate limit spent to learn nothing.
const allNumbers = [...new Set([...numbers, ...splitNumbers])].sort((a, b) => a - b);
const states = new Map(allNumbers.map((n) => [n, readState(n)]));
const reasons = new Map([...states.entries()].map(([n, r]) => [n, r.error]));
const stateOf = new Map([...states.entries()].map(([n, r]) => [n, r.state]));
const { closed, unreadable, open } = verdict(new Map(numbers.map((n) => [n, stateOf.get(n) ?? ""])));

for (const n of open) console.log(`  ✓ #${n} is OPEN`);

let bad = false;
if (unreadable.length > 0) {
	bad = true;
	console.error(`::error::check-exclusion-issues: could not read the state of ${unreadable.map((n) => `#${n}`).join(", ")}.`);
	// gh's OWN words, per issue. The previous message asserted one cause ("needs a token") that it
	// had not measured; a missing `gh`, a token without `issues: read`, a deleted issue, a rate
	// limit and a dead network all land here and send an operator to five different places.
	for (const n of unreadable) {
		console.error(`    #${n}: ${reasons.get(n) || "(gh reported no diagnostic)"}`);
	}
	console.error("  This is NOT a pass. Without an answer the check cannot tell an open issue from a");
	console.error("  closed one, and assuming open is how a stale exclusion survives the guard written");
	console.error("  to catch it. If the diagnostics above mention permissions, the job needs `issues: read`.");
}
if (closed.length > 0) {
	bad = true;
	console.error(`::error::check-exclusion-issues: ${GUARDED} cites CLOSED issue(s): ${closed.map((n) => `#${n}`).join(", ")}.`);
	console.error("  The Issue field's contract is that it stays OPEN — an exclusion whose tracker is");
	console.error("  closed has nothing left to make it come off the list, which is how it becomes");
	console.error("  permanent. Either the exclusion is no longer true (delete the entry), or it is");
	console.error("  still true and needs a tracking issue that is still open (file one and point at it).");
}

if (!bad) {
	console.log(`✓ every tracking issue in ${GUARDED} is open (${open.length})`);
}

// ── the per-row arms ──────────────────────────────────────────────────────────────────────────────

const split = splitVerdict(splitRows, stateOf, SPLIT);
const enforcedChecked = split.enforced.open.length + split.enforced.closed.length + split.enforced.unreadable.length;

for (const n of split.enforced.open) console.log(`  ✓ #${n} (${SPLIT.enforced}) is OPEN`);

if (split.enforced.unreadable.length > 0) {
	bad = true;
	console.error(
		`::error::check-exclusion-issues: could not read the state of ${split.enforced.unreadable.map((n) => `#${n}`).join(", ")} ` +
			`cited by a ${SPLIT.enforced} row in ${SPLIT.file}.`,
	);
	for (const n of split.enforced.unreadable) console.error(`    #${n}: ${reasons.get(n) || "(gh reported no diagnostic)"}`);
	console.error("  Fail-closed: an unanswered question is not an open issue.");
}
if (split.enforced.closed.length > 0) {
	bad = true;
	console.error(
		`::error::check-exclusion-issues: ${SPLIT.file} has a ${SPLIT.enforced} row citing CLOSED ` +
			`issue(s): ${split.enforced.closed.map((n) => `#${n}`).join(", ")}.`,
	);
	console.error(`  A ${SPLIT.enforced} is OUR debt — the product does this and the CLI cannot reach it — so its`);
	console.error("  tracker must stay OPEN. Letting it close while the gap stands is how debt becomes");
	console.error("  permanent by being forgotten, which is the same failure the addon_exclusions rule");
	console.error("  above exists to prevent. Either the gap is closed (change the verdict to CLIDriven and");
	console.error("  name the Argv that proves it), or it is still open and needs a tracker that is too.");
	console.error(`  NOTE: a ${SPLIT.reported} row is deliberately NOT held to this — see the ruling at the top.`);
}

// THE VACUITY FLOOR. Today the enforced arm covers zero rows, and that must not read as a pass.
console.log(
	enforcedArmLine(
		{
			checked: enforcedChecked,
			open: split.enforced.open.length,
			findings: split.enforced.closed.length + split.enforced.unreadable.length,
		},
		SPLIT,
		SPLIT.file,
	),
);
if (enforcedChecked === 0) {
	console.log(`  Zero ${SPLIT.enforced} rows is the INTENDED state — the CLI debt was cleared by #2331 — so it is`);
	console.log("  not an error. It is printed in its own words because a run that found nothing and a run");
	console.log("  that found nothing WRONG must not render alike. That this arm can still discriminate is");
	console.log(`  proven by --self-test, which flips a real ${SPLIT.reported} row to ${SPLIT.enforced} and asserts it reds.`);
}

// …and the reported arm, which records and never enforces.
if (split.reported.closed.length + split.reported.unreadable.length + split.reported.open.length > 0) {
	console.log(
		`  NOTE — ${SPLIT.reported} rows in ${SPLIT.file} need only be FILED, not open, so their state is ` +
			"recorded here and never enforced:",
	);
	for (const n of split.reported.open) console.log(`    #${n} OPEN`);
	for (const n of split.reported.closed) console.log(`    #${n} CLOSED — legitimate: a cloud ceiling does not lift because its issue did`);
	for (const n of split.reported.unreadable) console.log(`    #${n} state unreadable (${reasons.get(n) || "no diagnostic"})`);
}
if (split.uncontracted.length > 0) {
	console.log(`  NOTE — no contract here over: ${split.uncontracted.map((r) => `#${r.issue} (${r.reach})`).join(", ")}`);
}

process.exit(bad ? 1 : 0);
