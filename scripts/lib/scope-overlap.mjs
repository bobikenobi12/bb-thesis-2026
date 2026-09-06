#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The scope-glob matcher — ONE predicate for the board's anti-tangle invariant.
//
// .claude/COORDINATION.md states the invariant as: "No two open+claimable issues in a wave may
// share a scope glob — that is how the mega-commit tangle is prevented." Three call sites need to
// decide that question, and until #4115 they answered it three different ways:
//
//   · scripts/decompose-validate.mjs — the real matcher (normalize + segment walk, `**` as
//     zero-or-more, prefix subsumption, wildcard siblings), applied ONCE at seed time to a
//     proposal. Every function was module-private, so nothing else could call it.
//   · scripts/board-dashboard.mjs — a second, weaker copy: `startsWith` with no separator, so
//     `apps/console/lib` "overlapped" `apps/console/library`, and no intra-path wildcard support
//     at all, so `infra/templates/*/aws/**` matched nothing it should have.
//   · scripts/coordinate.sh — NOTHING. COORDINATION.md said its report flagged "two claimed
//     issues sharing `mutex:migration` or an overlapping `scope:`". The second half had never
//     been written, and the absence of a warning line read as an all-clear.
//
// scripts/lib/board-pr.sh's header names the hazard this file exists to close: one protocol
// duplicated across call sites, drifting silently into a false ALLOW. So the predicate lives here
// once and the three callers import or shell out to it.
//
// ── THREE OUTCOMES, NEVER TWO ────────────────────────────────────────────────────────────────
// A scope check has a third state that a collision/no-collision report cannot express: the unit
// whose scope could not be READ. A board unit with no `scope:` line, one whose declaration is
// wrapped in backticks (board #4089, live at the time of writing), one whose globs are prose —
// none of those can be compared with anything, and printing nothing for them is the same defect
// one level down. So `auditBoard` reports four verdicts and `formatAudit` always emits a line:
//
//   CLEAN            every claimable unit's scope was read; no two overlap        (exit 0)
//   COLLISIONS       at least one overlapping pair, named with the globs          (exit 3)
//   NOT-CHECKED      nothing was comparable — no claimable units, or not one      (exit 4)
//                    of them declares a readable `scope:`
//   CLEAN-WITH-GAPS  what could be read does not overlap, but N units could not   (exit 5)
//                    be read — a partial pass, reported as a partial pass
//
// ── KNOWN GAP, stated rather than silently carried ───────────────────────────────────────────
// The declaration regex is `decompose-validate.mjs`'s, character for character, because a looser
// or stricter one here would make the seed-time verdict and the continuous verdict disagree —
// which is the drift this file exists to end. That regex does NOT strip fenced code blocks, so a
// ```-fenced `scope:` line at column 0 is read as a declaration (coordinate.sh's `blocked-by:`
// parser DOES strip fences, after #3639 bit exactly that way). The failure direction is
// over-reporting a phantom glob, which is visible in the report and fails closed; the
// `blocked-by:` case failed OPEN, which is why it was worth the asymmetry there. Fixing it means
// moving BOTH parsers together, deliberately, not this one alone.
//
// Usage:
//   gh issue list --state open --limit 300 --json number,title,labels,body \
//     | node scripts/lib/scope-overlap.mjs --report      # human report  (coordinate.sh's caller)
//   … | node scripts/lib/scope-overlap.mjs --json        # the audit model
//   node scripts/lib/scope-overlap.mjs --self-test       # fixtures + mutation controls, no I/O

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ── the predicate (lifted verbatim from decompose-validate.mjs) ───────────────────────────────

/** Normalize a scope glob: trim, drop a leading `./`, collapse `//`, drop a trailing `/`. */
export function normalizeGlob(glob) {
	return String(glob)
		.trim()
		.replace(/^\.\//, "")
		.replace(/\/{2,}/g, "/")
		.replace(/\/+$/, "");
}

/**
 * Parse a machine-readable scope declaration from a board issue body.
 *
 * THE ANCHOR IS THE CONTRACT. `scope:` is a machine-read line that must start at column 0 (a
 * leading indent is tolerated); a `scope:` token inside prose is not a declaration, for the same
 * reason a prose `blocked-by:` is not one. Callers that need to know an unreadable declaration
 * from an absent one want `readScope` instead — this returns `[]` for both.
 */
export function scopeGlobs(body) {
	const match = String(body ?? "").match(/^[ \t]*scope:[ \t]*(.+)$/im);
	return match ? match[1].trim().split(/\s+/).filter(Boolean) : [];
}

/** Compile one path SEGMENT (no `/`) into an anchored regex; `*` → any run of non-slash chars. */
function segToRegex(seg) {
	const body = seg
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join("[^/]*");
	return new RegExp(`^${body}$`);
}

/**
 * Do two path segments overlap — i.e. is there a filename matching both? `**` is handled by the
 * caller (multi-segment), so here a segment is a literal or a single-segment `*`-glob. Conservative
 * on purpose: when both carry intra-segment wildcards we test a few witness strings and treat them
 * as overlapping if any is matched by both, because a MISSED overlap is what causes the tangle.
 */
export function segMatch(a, b) {
	if (a === b) return true;
	if (a === "*" || b === "*") return true;
	const hasWildA = a.includes("*");
	const hasWildB = b.includes("*");
	if (!hasWildA && !hasWildB) return false; // two distinct literals — disjoint
	const rxA = segToRegex(a);
	const rxB = segToRegex(b);
	// Witnesses: each pattern with `*` collapsed to "" and to a filler run.
	const witnesses = [
		a.replace(/\*/g, ""),
		a.replace(/\*/g, "x9z"),
		b.replace(/\*/g, ""),
		b.replace(/\*/g, "x9z"),
	];
	return witnesses.some((w) => rxA.test(w) && rxB.test(w));
}

/**
 * Do two normalized globs overlap? Segment-by-segment match where `**` matches zero-or-more
 * segments; catches exact equality, prefix subsumption (`a/lib/**` ⊇ `a/lib/db/**`), and
 * wildcard siblings, while keeping disjoint dirs (`a/x/**` vs `a/y/**`) disjoint.
 */
export function globsOverlap(g1, g2) {
	const a = normalizeGlob(g1).split("/");
	const b = normalizeGlob(g2).split("/");
	/** Recursive segment matcher over the remaining segments of each glob. */
	const walk = (i, j) => {
		if (i >= a.length && j >= b.length) return true;
		if (i >= a.length) return b.slice(j).every((s) => s === "**");
		if (j >= b.length) return a.slice(i).every((s) => s === "**");
		if (a[i] === "**") return walk(i + 1, j) || walk(i, j + 1);
		if (b[j] === "**") return walk(i, j + 1) || walk(i + 1, j);
		if (segMatch(a[i], b[j])) return walk(i + 1, j + 1);
		return false;
	};
	return walk(0, 0);
}

/**
 * The first overlapping pair between two glob LISTS, or null. The list-level convenience the
 * dashboard needs; `globsOverlap` remains the single decision underneath it.
 */
export function scopeListsOverlap(a, b) {
	for (const g1 of a ?? []) {
		for (const g2 of b ?? []) {
			if (globsOverlap(g1, g2)) return { g1, g2 };
		}
	}
	return null;
}

// ── reading a scope declaration, WITH its failure modes ───────────────────────────────────────

/**
 * Characters a path glob can be made of. Anything else — a backtick, a comma, an apostrophe, a
 * markdown emphasis run — means the token came out of prose or decoration rather than out of a
 * declaration, and comparing it would be comparing noise. Deliberately a whitelist: a blacklist
 * of "characters we have seen go wrong" is a hand-written list, and those decay.
 *
 * PARENTHESES AND SQUARE BRACKETS ARE PATH CHARACTERS IN THIS REPO, not prose. The console is a
 * Next.js App Router tree, so `apps/console/app/(private)/[org]/~/support/**` is an ordinary
 * scope: a route group and two dynamic segments. The first cut of this list rejected them and the
 * live board came back with five units "unreadable" that were declared perfectly well — a guard
 * over-reporting into noise, which is how a report stops being read. The cost of admitting them is
 * that a prose fragment like `(and` is taken for a glob; it matches no file anyone owns, so at
 * worst it is one extra glob in the count, never a missed overlap.
 */
const PATH_GLOB_CHARS = /^[A-Za-z0-9._\-/*?@+~()[\]{}!]+$/;

/**
 * Classify one declared token: `null` when it is a usable glob, else the reason it is not.
 *
 * `*` and `**` alone are rejected rather than accepted-as-everything on purpose. Accepting them
 * is not wrong — a unit claiming the whole repo genuinely collides with every other unit — but it
 * turns one malformed declaration into N false collision lines, and a report nobody can read is a
 * report nobody reads. Rejected, it shows up once, in the NOT CHECKED line, naming the unit.
 */
export function globDefect(token) {
	const g = normalizeGlob(token);
	if (g === "") return "empty after normalization";
	if (!PATH_GLOB_CHARS.test(g)) return "contains characters no path glob can (markdown or prose?)";
	if (g === "*" || g === "**") return "matches the entire repository — that is not a scope";
	return null;
}

/**
 * Read a unit's scope declaration into a three-state answer.
 *
 * @returns {{status: "declared"|"missing"|"mentioned-not-declared", globs: string[],
 *            unusable: {token: string, reason: string}[]}}
 *   `status: "mentioned-not-declared"` is the case worth separating out: the body says `scope:`
 *   somewhere but never at the start of a line, which is what a backtick-wrapped or indented-in-a
 *   -bullet declaration looks like to the parser. Board #4089 was exactly this on 2026-09-03 —
 *   a unit that reads to a human as scoped and to every parser as unscoped.
 */
export function readScope(body) {
	const text = String(body ?? "");
	const tokens = scopeGlobs(text);
	if (tokens.length === 0) {
		return {
			status: /scope:/i.test(text) ? "mentioned-not-declared" : "missing",
			globs: [],
			unusable: [],
		};
	}
	const globs = [];
	const unusable = [];
	for (const token of tokens) {
		const reason = globDefect(token);
		if (reason) unusable.push({ token, reason });
		else globs.push(normalizeGlob(token));
	}
	return { status: "declared", globs, unusable };
}

// ── the live-board audit ──────────────────────────────────────────────────────────────────────

/**
 * Labels that take a unit out of the simultaneously-workable set.
 *
 * MIRRORS THE EMITTER — claim-work.sh's `ready` filter (scripts/claim-work.sh:203-215), which
 * excludes claimed / blocked / needs:human / epic and requires a `class:` label — with ONE
 * deliberate difference: `claimed` is NOT excluded here. claim-work.sh excludes it because a
 * claimed unit cannot be handed out again; this audit includes it because a claimed unit is the
 * one somebody is editing files in RIGHT NOW. A claimed unit overlapping a ready one, or two
 * claimed units overlapping each other, is precisely the tangle the invariant forbids.
 */
const NOT_WORKABLE_LABELS = ["blocked", "needs:human", "epic"];

/** Is this open issue a board unit that could be worked right now (claimed or ready)? */
export function isWorkableBoardUnit(issue) {
	const labels = (issue?.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
	if (!labels.some((l) => l.startsWith("class:"))) return false;
	return NOT_WORKABLE_LABELS.every((l) => !labels.includes(l));
}

/** The wave label of an issue, without the prefix, or "—". */
function waveOf(labels) {
	const wave = labels.find((l) => l.startsWith("wave:"));
	return wave ? wave.slice("wave:".length) : "—";
}

/**
 * Audit an open board for overlapping scope globs among the units that can be worked at once.
 *
 * @param {Array} board `gh issue list --json number,title,labels,body` output.
 * @returns the audit model: `verdict` is one of CLEAN / COLLISIONS / CLEAN-WITH-GAPS /
 *   NOT-CHECKED, and `gaps` is never folded into `collisions` — an unread unit is not a clean one.
 */
export function auditBoard(board) {
	if (!Array.isArray(board)) {
		return {
			verdict: "NOT-CHECKED",
			reason: "the board input was not a JSON array — nothing could be compared",
			units: [],
			compared: [],
			gaps: [],
			collisions: [],
			pairs: 0,
		};
	}
	const units = board.filter(isWorkableBoardUnit).map((issue) => {
		const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name)).filter(Boolean);
		return {
			number: issue.number,
			title: String(issue.title ?? "(untitled)"),
			state: labels.includes("claimed") ? "claimed" : "ready",
			wave: waveOf(labels),
			...readScope(issue.body),
		};
	});
	const compared = units.filter((u) => u.globs.length > 0);
	const gaps = units.filter((u) => u.globs.length === 0 || u.unusable.length > 0);

	const collisions = [];
	for (let i = 0; i < compared.length; i++) {
		for (let j = i + 1; j < compared.length; j++) {
			const hit = scopeListsOverlap(compared[i].globs, compared[j].globs);
			if (hit) collisions.push({ a: compared[i], b: compared[j], ...hit });
		}
	}
	const pairs = (compared.length * (compared.length - 1)) / 2;

	let verdict;
	let reason = "";
	if (units.length === 0) {
		verdict = "NOT-CHECKED";
		reason = "the board read yielded no claimed-or-ready board units at all";
	} else if (compared.length === 0) {
		verdict = "NOT-CHECKED";
		reason = `not one of the ${units.length} claimed-or-ready units declares a readable \`scope:\` line`;
	} else if (collisions.length > 0) {
		verdict = "COLLISIONS";
	} else if (gaps.length > 0) {
		verdict = "CLEAN-WITH-GAPS";
	} else {
		verdict = "CLEAN";
	}
	return { verdict, reason, units, compared, gaps, collisions, pairs };
}

/**
 * Why a unit could not be (fully) compared, as one short clause.
 *
 * Exported because board-dashboard.mjs renders the same gap set in HTML: a second wording for the
 * same condition is how two surfaces start describing different boards.
 *
 * @param {{status: string, globs: string[], unusable: {token: string, reason: string}[]}} unit
 */
export function scopeGapReason(unit) {
	if (unit.status === "missing") return "no `scope:` line";
	if (unit.status === "mentioned-not-declared") {
		return "mentions `scope:` but not as a declaration at the start of a line (backticks? a bullet?)";
	}
	if (unit.globs.length === 0) {
		return `no usable glob — ${unit.unusable.map((u) => `"${u.token}" ${u.reason}`).join("; ")}`;
	}
	return `partly read — ${unit.unusable.map((u) => `"${u.token}" ${u.reason}`).join("; ")}`;
}

/** The exit code a verdict maps to, so a caller can branch without re-parsing the text. */
export const VERDICT_EXIT = { CLEAN: 0, COLLISIONS: 3, "NOT-CHECKED": 4, "CLEAN-WITH-GAPS": 5 };

/**
 * Render the audit as report lines (two-space indented, to sit inside coordinate.sh's report).
 *
 * EVERY verdict produces output. The whole point of #4115 is that "checked and clean" and "never
 * checked" were the same silence, so there is no branch here that returns an empty array.
 */
export function formatAudit(audit) {
	const lines = ["  ── scope collisions (the anti-tangle invariant) ──"];
	if (audit.verdict === "NOT-CHECKED") {
		lines.push(`  ⚠ scope collisions NOT CHECKED: ${audit.reason}.`);
	}
	for (const c of audit.collisions) {
		lines.push(
			`  ⚠ SCOPE COLLISION: #${c.a.number} (${c.a.state}, wave:${c.a.wave}) glob "${c.g1}" overlaps ` +
				`#${c.b.number} (${c.b.state}, wave:${c.b.wave}) glob "${c.g2}"`,
		);
		lines.push(`      #${c.a.number} ${c.a.title}`);
		lines.push(`      #${c.b.number} ${c.b.title}`);
	}
	if (audit.compared.length > 0) {
		const verb = audit.collisions.length > 0 ? "compared" : "compared, no overlap:";
		lines.push(
			`  ${audit.collisions.length > 0 ? "·" : "✓"} ${verb} ${audit.compared.length} of ` +
				`${audit.units.length} claimed-or-ready units (${audit.pairs} pair(s), ` +
				`${audit.compared.reduce((n, u) => n + u.globs.length, 0)} glob(s)).`,
		);
	}
	if (audit.gaps.length > 0) {
		lines.push(`  ⚠ NOT CHECKED — ${audit.gaps.length} unit(s) whose scope could not be read:`);
		for (const g of audit.gaps) lines.push(`      #${g.number} ${scopeGapReason(g)}`);
		lines.push(
			"      An unread scope is not a disjoint one. Add a `scope:` line at column 0 (no backticks)" +
				" to the issue body, or the invariant is unenforced for that unit.",
		);
	}
	return lines;
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────

const FIXTURES = new URL("./board-body-fixtures.json", import.meta.url);

/**
 * Fixtures + MUTATION CONTROLS.
 *
 * A self-test whose expected values are computed by the implementation under test proves only
 * that the implementation agrees with itself (`.claude` memory: "a guard shipped with its fix is
 * tautological"). So every expected value below is hand-authored DATA in
 * scripts/lib/board-body-fixtures.json, and the suite additionally runs the overlap fixtures
 * against two DELIBERATELY WRONG matchers — byte equality, and the `startsWith`-with-no-separator
 * predicate board-dashboard.mjs actually shipped — and FAILS if either of them passes the suite.
 * If a broken matcher can satisfy the fixtures, the fixtures do not discriminate and a green here
 * means nothing.
 */
function runSelfTest() {
	let fails = 0;
	let checks = 0;
	/** Assert `actual` deep-equals `expected`, printing an ok/FAIL line. */
	const eq = (name, actual, expected) => {
		checks++;
		const a = JSON.stringify(actual);
		const e = JSON.stringify(expected);
		if (a === e) {
			console.log(`ok   - ${name}`);
		} else {
			fails++;
			console.error(`FAIL - ${name}: want ${e} got ${a}`);
		}
	};

	let fixtures;
	try {
		fixtures = JSON.parse(readFileSync(FIXTURES, "utf8"));
	} catch (error) {
		console.error(`self-test: could not read ${FIXTURES.pathname}: ${error.message}`);
		console.error("  Unreadable fixtures are a FAILURE, not an empty suite.");
		process.exit(1);
	}

	const scopeCases = Array.isArray(fixtures.scopeCases) ? fixtures.scopeCases : [];
	const overlapCases = Array.isArray(fixtures.overlapCases) ? fixtures.overlapCases : [];
	const boardCases = Array.isArray(fixtures.boardCases) ? fixtures.boardCases : [];
	// AN EMPTY SUITE IS A FAILURE — the same rule coordinate.sh's --self-test already applies to
	// its own cases. Asserting nothing is not passing.
	for (const [name, list] of [
		["scopeCases", scopeCases],
		["overlapCases", overlapCases],
		["boardCases", boardCases],
	]) {
		if (list.length === 0) {
			console.error(`self-test: ${FIXTURES.pathname} carries NO ${name} — asserting nothing is not passing.`);
			process.exit(1);
		}
	}

	// (1) the declaration parser, including its two failure modes.
	for (const c of scopeCases) {
		const got = readScope(c.body);
		eq(`scope parse: ${c.name}`, { status: got.status, globs: got.globs }, { status: c.status, globs: c.globs });
		if (Array.isArray(c.unusable)) {
			eq(`scope parse (unusable): ${c.name}`, got.unusable.map((u) => u.token), c.unusable);
		}
	}

	// (2) the overlap predicate, both directions, against hand-authored expectations.
	for (const c of overlapCases) {
		eq(`overlap: ${c.name}`, globsOverlap(c.a, c.b), c.overlap);
		eq(`overlap (commuted): ${c.name}`, globsOverlap(c.b, c.a), c.overlap);
	}

	// (3) MUTATION CONTROLS — the fixtures must be able to tell a right matcher from a wrong one.
	const naiveEquality = (a, b) => normalizeGlob(a) === normalizeGlob(b);
	/** The predicate board-dashboard.mjs shipped before #4115: prefix match with no separator. */
	const naivePrefix = (a, b) => {
		const norm = (g) => g.replace(/\*+$/g, "").replace(/\/+$/g, "");
		const x = norm(a);
		const y = norm(b);
		return x === y || x.startsWith(y) || y.startsWith(x);
	};
	for (const [name, mutant] of [
		["byte equality", naiveEquality],
		["dashboard's separator-less prefix match", naivePrefix],
	]) {
		checks++;
		const disagreements = overlapCases.filter((c) => mutant(c.a, c.b) !== c.overlap);
		if (disagreements.length > 0) {
			console.log(`ok   - mutation control: ${name} fails ${disagreements.length} fixture(s) — the suite discriminates`);
		} else {
			fails++;
			console.error(
				`FAIL - mutation control: ${name} PASSES every overlap fixture. The fixtures do not ` +
					"discriminate a correct matcher from a broken one, so a green above proves nothing. " +
					"Add a case the broken predicate gets wrong.",
			);
		}
	}

	// (4) the board audit's four verdicts, and the report text each one produces.
	for (const c of boardCases) {
		const audit = auditBoard(c.board);
		eq(`board verdict: ${c.name}`, audit.verdict, c.verdict);
		eq(
			`board collisions: ${c.name}`,
			audit.collisions.map((x) => [x.a.number, x.b.number]),
			c.collisions ?? [],
		);
		eq(`board gaps: ${c.name}`, audit.gaps.map((g) => g.number), c.gaps ?? []);
		eq(`board exit code: ${c.name}`, VERDICT_EXIT[audit.verdict], VERDICT_EXIT[c.verdict]);

		// The report must SAY something for every verdict — that is the whole defect #4115 names.
		const text = formatAudit(audit).join("\n");
		checks++;
		if (formatAudit(audit).length >= 2 && text.trim() !== "") {
			console.log(`ok   - board report is non-empty: ${c.name}`);
		} else {
			fails++;
			console.error(`FAIL - board report is non-empty: ${c.name}: the report printed nothing`);
		}
		// …and a board that could not be checked must NEVER render the clean marker. This is the
		// failing case the issue is about: silence, or a ✓, standing in for a check that never ran.
		checks++;
		const claimsClean = /✓ compared, no overlap/.test(text);
		const shouldClaimClean = c.verdict === "CLEAN" || c.verdict === "CLEAN-WITH-GAPS";
		if (claimsClean === shouldClaimClean) {
			console.log(`ok   - clean marker only when clean: ${c.name}`);
		} else {
			fails++;
			console.error(
				`FAIL - clean marker only when clean: ${c.name}: verdict ${audit.verdict} ` +
					`${claimsClean ? "printed" : "withheld"} the ✓ marker`,
			);
		}
		// A NOT-CHECKED or gapped board must name the units it could not read, by number.
		if ((c.gaps ?? []).length > 0) {
			checks++;
			const named = (c.gaps ?? []).every((n) => text.includes(`#${n}`));
			if (named) {
				console.log(`ok   - unreadable units are named: ${c.name}`);
			} else {
				fails++;
				console.error(`FAIL - unreadable units are named: ${c.name}: report omits one of ${c.gaps.join(", ")}`);
			}
		}
	}

	// (5) the workable-unit filter mirrors claim-work.sh's ready filter (minus the claimed rule).
	const unit = (labels) => ({ number: 1, title: "t", labels: labels.map((name) => ({ name })), body: "scope: a/**" });
	eq("workable: a ready class unit", isWorkableBoardUnit(unit(["class:backend", "wave:W1"])), true);
	eq("workable: a CLAIMED class unit is still workable", isWorkableBoardUnit(unit(["class:backend", "claimed"])), true);
	eq("workable: blocked is not", isWorkableBoardUnit(unit(["class:backend", "blocked"])), false);
	eq("workable: needs:human is not", isWorkableBoardUnit(unit(["class:backend", "needs:human"])), false);
	eq("workable: an epic is not", isWorkableBoardUnit(unit(["class:backend", "epic"])), false);
	eq("workable: no class: label is not a board unit", isWorkableBoardUnit(unit(["wave:W1"])), false);

	if (fails > 0) {
		console.error(`self-test: ${fails} of ${checks} check(s) FAILED`);
		process.exit(1);
	}
	console.log(`self-test: all ${checks} passed`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

/** Read all of stdin as a string. */
function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch (error) {
		console.error(`could not read the board JSON from stdin: ${error.message}`);
		process.exit(1);
	}
}

// `pathToFileURL`, not string concatenation: a checkout path with a space or a non-ASCII
// character produces a different href than `file://` + the raw path, and the CLI would then
// silently do nothing — a script that exits 0 having performed nothing is the shape this module
// is written to make impossible.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const arg = process.argv[2] ?? "--report";
	if (arg === "--self-test") {
		runSelfTest();
	} else if (arg === "--report" || arg === "--json") {
		let board;
		try {
			board = JSON.parse(readStdin());
		} catch (error) {
			console.error(`the board JSON on stdin did not parse: ${error.message}`);
			process.exit(1);
		}
		const audit = auditBoard(board);
		if (arg === "--json") {
			console.log(JSON.stringify(audit, null, 2));
		} else {
			for (const line of formatAudit(audit)) console.log(line);
		}
		process.exit(VERDICT_EXIT[audit.verdict] ?? 1);
	} else {
		console.error(`unknown arg: ${arg}\nusage: scope-overlap.mjs [--report|--json|--self-test]`);
		process.exit(2);
	}
}
