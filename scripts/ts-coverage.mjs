#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-directory TypeScript statement-coverage RATCHET. Coverage may rise, or stay flat. It may
// not fall.
//
// There is no absolute target. A directory at 3% is fine, as long as it does not become 2%. This
// tool only ever asks "did you make it worse". It is the TypeScript half of the design proven by
// scripts/go-coverage.sh (epic #1988), ported clause for clause rather than re-invented.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY IT PARSES coverage-final.json AND NEVER coverage-summary.json
//
// See the header of scripts/lib/ts-coverage-measure.mjs. Short version: coverage-final.json is
// the artefact vitest emits by DEFAULT, it is the raw statement map rather than a rollup of it
// (so its internal consistency can be CHECKED), and computing statements from it keeps the metric
// identical across providers where `summary.lines` would silently differ.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY FLOORS ARE INTEGER PAIRS AND NOT PERCENTAGES
//
// Floors store `covered` and `total` as integers and the comparison is a cross-multiplication:
//
//     PASS  <=>  covered_now * total_floor  >=  covered_floor * total_now
//
// No division, no float, no rounding ever enters the decision. `packages/core/git` is
// 185/291 = 63.5739%, which every tool DISPLAYS as "63.6%". Store the displayed value and the
// gate fails with zero code change, on every PR, forever. Percentages appear in messages only.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE JSON LAYOUT IS LOAD-BEARING
//
// JSON.stringify(x, null, 2) renders every directory record as exactly four lines:
//
//     "lib/authz": {
//       "covered": 812,
//       "total": 1043
//     },
//
// That guarantees at least two unchanged lines between any two directories' "covered" lines,
// which is what git's 3-way merge needs so that two PRs raising DIFFERENT, ADJACENT directories
// merge clean. Without it every concurrent TypeScript PR conflicts on a generated file nobody is
// allowed to hand-resolve. Asserted with a real `git merge-file` in --self-test.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY EVERY ERROR PATH IS FAIL-OPEN
//
// This runs inside `TypeScript (lint · types · test · docs)`, a REQUIRED check with no path
// filter — it gates every pull request in the repository, not only TypeScript ones. A false
// failure does not inconvenience one author; it stops the merge queue for everyone.
//
// So the rule is: THE ONLY CONDITION THAT MAY EXIT NON-ZERO is a directory present in BOTH the
// floors and the measurement, whose ratio genuinely fell, measured in an environment matching the
// one that recorded the floors. Everything else warns and exits 0. The escapes are enumerated
// F1..F10 below and each one is reached deliberately by --self-test.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ARMING A PROJECT IS RACY, AND THAT IS INHERENT
//
// Floors are a SNAPSHOT of a measurement taken on one commit. Anything that merges between the
// probe run and the floors PR merging can invalidate them — and not only a coverage-SCOPE change,
// which is the obvious case. Ordinary code does it too: a new file, or new statements in an
// existing directory, raises the denominator while `covered` stays put, and the ratio falls.
//
// Measured, on this ratchet's own arming PR: #2681 landed between the probe and the PR, adding
// `lib/promotions/env-ownership.ts` (+18 statements) and growing `app/server/actions` (+9). Both
// are verified by the INTEGRATION tier, which contributes nothing to this unit measurement, so
// both read as uncovered here:
//
//     app/server/actions  57.2% -> 57.1%   (7048/12327 -> 7048/12336)
//     lib/promotions      81.6% -> 78.2%   (337/413    -> 337/431)
//
// That is the gate working, not misfiring: new statements with no unit coverage ARE a ratio
// regression, and the fix is a fresh probe rather than a weakened comparison. Do not add a grace
// margin to make arming easier — a floor that tolerates "a little" drift tolerates it forever.
//
// So: arm in a quiet window, expect to re-probe if the branch loses the race, and remember that
// gains are never locked until floors are REGENERATED. The same applies to a routine re-record.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// NOT COMPATIBLE WITH TEST SHARDING
//
// Each shard would write a partial coverage-final.json, which F8 would (correctly) demote —
// turning the gate off rather than wrong, but off. If sharding ever lands, teach this to accept
// several artefacts and merge them by path BEFORE measuring.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	formatPct,
	measure,
	regressed,
	UnusableCoverageError,
	measureByFile,
} from "./lib/ts-coverage-measure.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BANNER =
	"GENERATED by scripts/ts-coverage.mjs --update. Do not hand-edit. " +
	"Do not hand-merge a conflict here — re-run the generator instead.";

/**
 * The fingerprint axes. ONLY axes that plausibly move the number belong here: every extra key is
 * another way to accidentally demote a genuine regression into a warning.
 *
 * Unlike the Go tool's "more tools can only help" asymmetry, EVERY axis here demotes in BOTH
 * directions. `ee_dist` is the reason: with ee/dist present the console takes the success path in
 * lib/enterprise.ts, without it the catch path — both are statements in scope and neither
 * dominates. A key recorded as "unknown" (absent from an older floors file) never demotes, so an
 * old floors file cannot silently disarm the gate.
 */
const FINGERPRINT_KEYS = ["os", "node", "coverage_provider", "ee_dist", "edition"];

/** @returns {string} the installed @vitest/coverage-v8 version, or "unknown". */
function coverageProviderVersion(projectDir) {
	for (const base of [projectDir, ROOT]) {
		const pkg = path.join(base, "node_modules/@vitest/coverage-v8/package.json");
		try {
			const parsed = JSON.parse(readFileSync(pkg, "utf8"));
			if (typeof parsed.version === "string") return `@vitest/coverage-v8@${parsed.version}`;
		} catch {
			// fall through to the next candidate
		}
	}
	return "unknown";
}

/**
 * Describe the environment this measurement is being taken in.
 *
 * @param {string} projectDir absolute project root
 * @returns {Record<string, string|boolean>}
 */
function currentEnv(projectDir) {
	return {
		// Spelled like `uname -s` so a reader can compare this against the Go floors side by side.
		os: process.platform === "darwin" ? "Darwin" : process.platform === "linux" ? "Linux" : process.platform,
		// MAJOR only. setup-node floats the patch, and recording the full version would demote
		// every failure to a warning on the next Node patch release — silently disarming the gate.
		node: process.versions.node.split(".")[0],
		coverage_provider: coverageProviderVersion(projectDir),
		// The console resolves EE scope only when this dist exists, so it changes which statements
		// execute in lib/enterprise.ts and therefore what the numbers mean.
		//
		// The divergence is NOT local-vs-CI. It is turbo-vs-direct, and it runs the other way from
		// what this comment used to claim:
		//
		//   pnpm exec turbo run test   -> dist PRESENT   (ci.yml:138, and a laptop running turbo)
		//   pnpm -C apps/console run test       -> dist ABSENT    (scripts/env.sh, i.e. `pnpm env:check`)
		//
		// apps/console declares @alethia/ee under **optionalDependencies**, and turbo.json declares
		// `test.dependsOn: ["^build"]` — so turbo builds the dist as part of the test task. That is
		// why no explicit `Build @alethia/ee` step appears in the `typescript` job even though the
		// floors are reachable there. ci.yml (~:186) carries the measured evidence; it is not
		// restated here, so the two cannot drift apart again.
		//
		// This comment previously asserted the exact opposite, and that is the part worth keeping:
		// an inverted rationale on a fingerprint key does not merely mislead, it SURVIVES
		// verification — a reader who checks finds ci.yml listing both explicit ee builds in other
		// jobs and concludes the comment was right. Two sessions did exactly that on 2026-08-26 and
		// both got it backwards. scripts/check-floors-reproducible.mjs now answers the question
		// mechanically rather than leaving it to prose.
		ee_dist: existsSync(path.join(ROOT, "ee/dist/index.js")),
		edition: process.env.ALETHIA_EDITION ?? "unset",
	};
}

/** @returns {string} the floors path for a project. */
function floorsPath(projectDir) {
	return path.join(projectDir, "coverage-floors.json");
}

/** @returns {string} the coverage artefact path for a project. */
function coveragePath(projectDir) {
	return path.join(projectDir, "coverage/coverage-final.json");
}

/**
 * Render floors deterministically: 2-space indent (the 4-line record property), keys sorted.
 *
 * @param {string} project repo-relative project path
 * @param {Map<string, {covered: number, total: number}>} dirs
 * @param {Record<string, string|boolean>} env
 * @returns {string}
 */
function renderFloors(project, dirs, env) {
	/** @type {Record<string, {covered: number, total: number}>} */
	const directories = {};
	for (const [k, v] of [...dirs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		directories[k] = { covered: v.covered, total: v.total };
	}
	return `${JSON.stringify({ _: BANNER, project, metric: "statements", env, directories }, null, 2)}\n`;
}

/**
 * Emit a single-line GitHub annotation. A literal newline truncates a workflow command.
 *
 * STDERR, NOT STDOUT — and that is load-bearing, not tidiness. Actions parses workflow commands on
 * both streams, but stdout here is a DATA channel: `--print` writes `<dir> <covered> <total>` rows
 * that `scripts/ci/ts-coverage-probe.sh` consumes as `$TSCOV --print | sed "s|^|$p |"`.
 *
 * With annotations on stdout, a warning became a row. `assert_measured` matches `$1 == project`,
 * and `sed` had just made `$1` the project name — so `packages/foo ::warning::…` satisfied the
 * assertion, and the probe could report "every recorded project produced measured rows" having
 * measured nothing at all. A diagnostic whose failure branch reports success is worse than no
 * diagnostic: it is the reason #3342 was un-diagnosable rather than merely broken.
 *
 * `assert_measured` now also checks the row SHAPE, so the two fixes are independent — but a data
 * channel that carries commentary is the defect, and this is where it is fixed.
 */
function annotate(level, file, line, message) {
	const flat = message.replace(/\r?\n/g, " ").trim();
	const loc = file ? `file=${file}${line ? `,line=${line}` : ""}` : "";
	process.stderr.write(`::${level}${loc ? ` ${loc}` : ""}::${flat}\n`);
}

/**
 * Find the 1-based line of a directory's "covered" entry in a rendered floors file, so the
 * annotation lands on the failing number in the file diff rather than at the top of the file.
 *
 * @returns {number|undefined}
 */
function coveredLineOf(floorsText, dir) {
	const lines = floorsText.split("\n");
	const needle = `    ${JSON.stringify(dir)}: {`;
	const at = lines.findIndex((l) => l === needle);
	return at === -1 ? undefined : at + 2;
}

/** Exit 0 with a warning: the fail-open path. @returns {never} */
function failOpen(code, message) {
	annotate("warning", null, null, `ts-coverage ${code}: ${message}`);
	process.exit(0);
}

/** Exit 0 with a notice: not armed / nothing to say. @returns {never} */
function notArmed(code, message) {
	annotate("notice", null, null, `ts-coverage ${code}: ${message}`);
	process.exit(0);
}

/**
 * Read and parse the coverage artefact into per-directory pairs, or fail open.
 *
 * @returns {Map<string, {covered: number, total: number}>}
 */
/**
 * Per-FILE covered/total for one directory, straight from the coverage artefact.
 *
 * WHY (#3079). The failure line says a directory "fell to 54.6% from 54.6% (957/1753 vs
 * 958/1753)". One statement, out of 1753, somewhere in 31 files. That is true and nearly
 * unactionable: the reader's first move is to guess which file, and on a promotion PR the
 * directory is often one the diff never touched — so the honest answer is "none of them, this
 * wobbled", which costs an investigation to reach.
 *
 * Naming the files turns a directory-shaped number into a place to look. It cannot say WHICH
 * statement moved (the floors record a ratio, not a per-file baseline), so it deliberately does
 * not pretend to: it prints the breakdown and lets the reader compare against the diff they
 * already have.
 *
 * @returns {{file: string, covered: number, total: number}[]} sorted by uncovered count, worst first
 */
function perFileBreakdown(projectDir, dir) {
	try {
		const raw = JSON.parse(readFileSync(coveragePath(projectDir), "utf8"));
		const abs = path.resolve(ROOT, projectDir);
		// THE SAME WALK THE GATE USED. This was a third, independent traversal of the artefact, and
		// it disagreed with the other two in three ways that all point the same direction — quieter:
		// it took `total` from `s` rather than `statementMap` (so the F6 length-mismatch tripwire was
		// invisible here), it counted a non-integer hit as uncovered instead of throwing, and it
		// `continue`d past an out-of-root path instead of throwing. An engineer comparing a failing
		// ratchet's breakdown against `--print --per-file` could get two different tables for the
		// same files with nothing saying which one the gate actually read.
		const out = [];
		for (const [rel, v] of measureByFile(raw, abs).entries()) {
			const owner = path.posix.dirname(rel) === "." ? "." : path.posix.dirname(rel);
			if (owner !== dir) continue;
			out.push({ file: path.posix.basename(rel), covered: v.covered, total: v.total });
		}
		return out.sort((a, b) => b.total - b.covered - (a.total - a.covered));
	} catch {
		// A breakdown we cannot produce is not a reason to change the verdict, and an empty list
		// renders as "not available" rather than as "no files".
		return [];
	}
}

function measureOrFailOpen(projectDir, project, measureFn = measure) {
	const cov = coveragePath(projectDir);
	// F2 — no artefact. The only ways here: the `Unit tests` step already failed (and already
	// failed the job — failing twice misattributes the cause), the project has no coverage config,
	// or the "json" reporter was removed. None of them is a coverage regression.
	if (!existsSync(cov)) {
		failOpen("F2", `${project}: no coverage/coverage-final.json — nothing measured, not a regression`);
	}
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(cov, "utf8"));
	} catch (err) {
		// F4 — truncated or invalid JSON. The json reporter streams `{`, records, `}`, so an
		// interrupted write leaves invalid JSON. That is the GOOD failure: it is detectable.
		failOpen("F4", `${project}: coverage-final.json is not valid JSON (truncated write?): ${err.message}`);
	}
	try {
		return measureFn(parsed, projectDir);
	} catch (err) {
		if (err instanceof UnusableCoverageError) {
			// F6 — the artefact is structurally untrustworthy. A ratchet must not compare against a
			// map it cannot vouch for.
			failOpen("F6", `${project}: coverage artefact is not internally consistent — ${err.message}`);
		}
		throw err;
	}
}

/** The check mode. Exits non-zero ONLY on a genuine, in-environment regression. */
function runCheck(project) {
	const projectDir = path.join(ROOT, project);
	const fp = floorsPath(projectDir);

	// F1 — not armed. Landing inert is the whole bootstrap strategy.
	if (!existsSync(fp)) {
		notArmed("F1", `${project}: no coverage-floors.json — ratchet not armed. Run --update to arm it.`);
	}

	let floorsText;
	let floors;
	try {
		floorsText = readFileSync(fp, "utf8");
		floors = JSON.parse(floorsText);
	} catch (err) {
		// F3 — unparseable floors. The likeliest cause is `<<<<<<< HEAD` left in a generated file
		// by a hand-resolved conflict. That must never red every PR in the repository.
		failOpen("F3", `${project}: coverage-floors.json is unparseable (a hand-resolved merge conflict?): ${err.message}`);
	}
	if (typeof floors !== "object" || floors === null) {
		failOpen("F3", `${project}: coverage-floors.json did not parse to an object`);
	}
	// Belt and braces: a Go floors file has `module` and no `project`.
	if (floors.module !== undefined && floors.project === undefined) {
		failOpen("F3", `${project}: coverage-floors.json looks like a GO floors file (has "module") — wrong tool`);
	}
	const recorded = floors.directories;
	if (typeof recorded !== "object" || recorded === null) {
		failOpen("F3", `${project}: coverage-floors.json has no "directories" map`);
	}

	const measured = measureOrFailOpen(projectDir, project);

	// F5 — parsed to nothing. Left alone this reads as "every directory collapsed to 0%".
	if (measured.size === 0) {
		failOpen("F5", `${project}: coverage parsed to zero directories (truncated artefact?)`);
	}

	// F7 — FINGERPRINT DRIFT, checked before any comparison.
	const cur = currentEnv(projectDir);
	const recordedEnv = typeof floors.env === "object" && floors.env !== null ? floors.env : {};
	/** @type {string[]} */
	const drift = [];
	for (const key of FINGERPRINT_KEYS) {
		const was = recordedEnv[key];
		// "unknown" (an older floors file predating the key) must NOT demote — otherwise an old
		// file silently disarms the gate.
		if (was === undefined) continue;
		if (String(was) !== String(cur[key])) drift.push(`${key}: recorded ${String(was)}, now ${String(cur[key])}`);
	}
	// Track WHY we demote, not merely THAT we do. A demote message naming the wrong cause sends
	// the reader to look at the wrong thing — the F8 (truncated artefact) case reported "the
	// environment differs" until this was split.
	/** @type {string[]} */
	const demoteReasons = [];
	if (drift.length > 0) demoteReasons.push("the environment differs from the one that recorded these floors");

	// F8 — PLAUSIBILITY, before any comparison. A partial artefact does not parse to nothing (F5
	// covers that); it parses to a PARTIAL — directories missing, denominators collapsed — which
	// compared naively is a catastrophic fake regression across the whole project. The
	// discriminator is the DENOMINATOR: a directory's `total` is its statement count and can only
	// change when code changes. Safe because vitest's `coverage.all` defaults to true, so a
	// directory leaves the measurement by losing all its FILES, never by losing its tests.
	/** @type {string[]} */
	const suspect = [];
	for (const [dir, floor] of Object.entries(recorded)) {
		const now = measured.get(dir);
		if (!now) {
			suspect.push(`${dir}: floored but absent from this measurement`);
			continue;
		}
		if (now.total * 2 < floor.total) {
			suspect.push(`${dir}: total collapsed ${floor.total} -> ${now.total} (more than halved)`);
		}
	}
	if (suspect.length > 0) demoteReasons.push("the coverage artefact looks partial (a floored directory vanished, or a denominator collapsed)");

	/** @type {{dir: string, now: {covered: number, total: number}, floor: {covered: number, total: number}}[]} */
	const failures = [];
	for (const [dir, floor] of Object.entries(recorded)) {
		const now = measured.get(dir);
		if (!now) continue; // already recorded as suspect above
		if (typeof floor?.covered !== "number" || typeof floor?.total !== "number") {
			failOpen("F3", `${project}: floor for ${dir} is not a covered/total pair`);
		}
		if (regressed(now, floor)) failures.push({ dir, now, floor });
	}

	// F9 — a directory with no floor. A PR must never be blocked by a file it had no way to know
	// it must edit. Pressure to arm comes from --update, not from this gate.
	for (const [dir, now] of measured.entries()) {
		if (recorded[dir] === undefined) {
			annotate("notice", null, null, `ts-coverage F9: ${project}/${dir} is new at ${formatPct(now)} — no floor yet; run --update to arm it`);
		}
	}

	for (const s of suspect) annotate("warning", null, null, `ts-coverage F8: ${project} ${s}`);
	for (const d of drift) annotate("warning", null, null, `ts-coverage F7: ${project} ${d}`);

	if (failures.length === 0) {
		process.stdout.write(`✓ ts-coverage ${project}: no directory regressed (${measured.size} measured, ${Object.keys(recorded).length} floored)\n`);
		process.exit(0);
	}

	const summary = failures
		.map((f) => `${f.dir} ${formatPct(f.now)} < floor ${formatPct(f.floor)} (${f.now.covered}/${f.now.total} vs ${f.floor.covered}/${f.floor.total})`)
		.join(" · ");

	if (demoteReasons.length > 0) {
		// The measurement is not comparable to the floors, so a "regression" here is not evidence
		// about the code. Demote rather than blame coverage for a scope change or a partial file.
		annotate("warning", null, null, `ts-coverage: ${failures.length} directory(ies) regressed, but ${demoteReasons.join(" and ")} — DEMOTED to a warning: ${summary}`);
		process.exit(0);
	}

	const relFloors = path.relative(ROOT, fp);
	for (const f of failures) {
		annotate("error", relFloors, coveredLineOf(floorsText, f.dir), `ts-coverage: ${project}/${f.dir} fell to ${formatPct(f.now)} from a floor of ${formatPct(f.floor)} (${f.now.covered}/${f.now.total} vs ${f.floor.covered}/${f.floor.total})`);
	}
	const report = [
		"",
		`  ts-coverage: ${failures.length} directory(ies) lost coverage in ${project}`,
		"",
		...failures.flatMap((f) => {
			const head = `    ${f.dir}  ${formatPct(f.floor)} -> ${formatPct(f.now)}   (${f.floor.covered}/${f.floor.total} -> ${f.now.covered}/${f.now.total})`;
			const files = perFileBreakdown(projectDir, f.dir);
			if (files.length === 0) return [head];
			// Only the files with something uncovered can account for a drop; a fully covered file
			// cannot have lost anything, and listing it buries the ones that could.
			const movers = files.filter((x) => x.covered < x.total);
			if (movers.length === 0) return [head];
			return [
				head,
				...movers.slice(0, 8).map((x) => `        ${x.file}  ${x.covered}/${x.total}`),
				...(movers.length > 8 ? [`        … and ${movers.length - 8} more with uncovered statements`] : []),
			];
		}),
		"",
		// A ONE-STATEMENT MOVE WITH AN UNCHANGED TOTAL IS THE SIGNATURE OF NOISE (#3079), and
		// saying so is not permission to ignore it — it is the difference between "you regressed"
		// and "this wobbled", which the reader would otherwise spend an investigation establishing.
		...(failures.some((f) => f.now.total === f.floor.total && Math.abs(f.now.covered - f.floor.covered) === 1)
			? [
					"  NOTE: a directory above moved by exactly ONE statement with its total unchanged.",
					"  That is the shape of a nondeterministic test rather than a real regression (#3079) —",
					"  especially if your diff does not touch that directory. Re-run before assuming it is",
					"  yours; if a re-run is green, say so on #3079 rather than lowering the floor.",
					"",
				]
			: []),
		"  Add tests until the ratio is back at or above its floor. If the drop is intended and",
		"  correct, record it deliberately:",
		"",
		`      node scripts/ts-coverage.mjs --project ${project} --accept-regression`,
		"",
		"  which lowers the floor IN THE COMMITTED DIFF, where a reviewer sees it. That visibility",
		"  is the entire reason the floors are a checked-in file.",
		"",
	].join("\n");
	process.stderr.write(`${report}\n`);
	if (process.env.GITHUB_STEP_SUMMARY) {
		try {
			writeFileSync(process.env.GITHUB_STEP_SUMMARY, report, { flag: "a" });
		} catch {
			// A summary we cannot write is not a reason to change the verdict.
		}
	}
	process.exit(1);
}

/** --update / --accept-regression. */
function runUpdate(project, { allowLower }) {
	const projectDir = path.join(ROOT, project);
	const measured = measureOrFailOpen(projectDir, project);
	if (measured.size === 0) failOpen("F5", `${project}: coverage parsed to zero directories — refusing to write floors`);

	const fp = floorsPath(projectDir);
	/** @type {Record<string, {covered: number, total: number}>} */
	let existing = {};
	if (existsSync(fp)) {
		try {
			existing = JSON.parse(readFileSync(fp, "utf8")).directories ?? {};
		} catch {
			process.stderr.write(`  (existing floors unparseable — regenerating from scratch)\n`);
		}
	}

	/** @type {Map<string, {covered: number, total: number}>} */
	const next = new Map();
	for (const [dir, now] of measured.entries()) {
		const floor = existing[dir];
		if (floor && regressed(now, floor)) {
			if (allowLower) {
				process.stdout.write(`  LOWERED ${dir} ${formatPct(floor)} -> ${formatPct(now)}\n`);
				next.set(dir, now);
			} else {
				process.stdout.write(`  NOT LOWERED ${dir} ${formatPct(floor)} -> ${formatPct(now)} (use --accept-regression if intended)\n`);
				next.set(dir, floor);
			}
		} else {
			if (floor && (floor.covered !== now.covered || floor.total !== now.total)) {
				process.stdout.write(`  raised  ${dir} ${formatPct(floor)} -> ${formatPct(now)}\n`);
			}
			next.set(dir, now);
		}
	}

	const env = currentEnv(projectDir);
	if (env.os !== "Linux") {
		annotate("warning", null, null, `ts-coverage: recording floors on ${String(env.os)}, not Linux. CI records Linux — these floors will make CI DEMOTE its own failures rather than fail them. Record from the determinism probe instead.`);
	}
	writeFileSync(fp, renderFloors(project, next, env));
	process.stdout.write(`✓ wrote ${path.relative(ROOT, fp)} (${next.size} directories)\n`);
}

/**
 * `<dir> <covered> <total>` rows on stdout — the data channel `scripts/ci/ts-coverage-probe.sh`
 * consumes. Annotations go to stderr precisely so they cannot arrive here looking like rows.
 *
 * `--per-file` prints `<file> <covered> <total>` instead. The floors are per DIRECTORY, so the
 * ratchet can only ever say "apps/console/lib/billing moved by one statement" — a hundred files and
 * no culprit. Diffing two per-file runs names the flapping file in one command, which is what
 * #3342 needed and did not have:
 *
 *   set -e
 *   for i in 1 2; do
 *     pnpm -C apps/console run test
 *     node scripts/ts-coverage.mjs --project apps/console --print --per-file >"run.$i"
 *   done
 *   diff run.1 run.2
 *
 * `pnpm -C apps/console run test` — NOT `pnpm vitest --project apps/console`, which was written here first
 * and cannot run: the root package.json declares no `test` script and no vitest dependency, there
 * is no root vitest config, and the invocation fails with `Command "vitest" not found` AND EXITS 0.
 * The original recipe also sent that to /dev/null, so a follower got two empty files (or two stale
 * ones), diffed them, and read "nothing flaps" from a run that measured nothing — the exact defect
 * class this flag was added to close. `set -e` and un-silenced output are the load-bearing parts;
 * console coverage is opt-in and only the `-F console test` script passes `--coverage`.
 */
function runPrint(project, perFile = false) {
	const projectDir = path.join(ROOT, project);
	const measured = measureOrFailOpen(projectDir, project, perFile ? measureByFile : measure);
	for (const [key, v] of measured.entries()) process.stdout.write(`${key} ${v.covered} ${v.total}\n`);
}

/**
 * Strip `//` and block comments from TypeScript source, IGNORING both inside string literals.
 *
 * Not decoration. The first version of the exclusion check extracted every quoted string inside the
 * coverage block and promptly "found" five stale paths that were prose — quoted phrases inside the
 * block's own explanatory comments, including one that quoted an import path. That is the same
 * defect closed in #2549, where a guard was satisfied by a comment the very same PR had added:
 * match the rendered SHAPE, never a substring of the raw text.
 *
 * String-awareness matters in the other direction too — stripping a `//` out of a value would
 * leave an unbalanced quote and desynchronise everything after it.
 *
 * @param {string} src
 * @returns {string} src with comments replaced by spaces (offsets preserved)
 */
export function stripTsComments(src) {
	let out = "";
	let inStr = /** @type {false|string} */ (false);
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < src.length; i += 1) {
		const c = src[i];
		const n = src[i + 1];
		if (inLine) {
			if (c === "\n") {
				inLine = false;
				out += c;
			} else out += " ";
			continue;
		}
		if (inBlock) {
			if (c === "*" && n === "/") {
				inBlock = false;
				out += "  ";
				i += 1;
			} else out += c === "\n" ? c : " ";
			continue;
		}
		if (inStr) {
			out += c;
			if (c === "\\") {
				out += src[i + 1] ?? "";
				i += 1;
			} else if (c === inStr) inStr = false;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			inStr = c;
			out += c;
			continue;
		}
		if (c === "/" && n === "/") {
			inLine = true;
			out += "  ";
			i += 1;
			continue;
		}
		if (c === "/" && n === "*") {
			inBlock = true;
			out += "  ";
			i += 1;
			continue;
		}
		out += c;
	}
	return out;
}

/**
 * Extract the entries of one string-array key from a vitest config's COVERAGE block.
 *
 * Deliberately parses the coverage block only. `test.exclude` and `coverage.exclude` are different
 * keys with different meanings, and a regex that finds "the first exclude array" reads the wrong
 * one — `apps/console/vitest.config.ts` has both, and the test one comes first.
 *
 * Hand-rolled rather than via the TypeScript AST because this must run in a DE-HYDRATED worktree
 * with no node_modules — that is where the guard is cheapest to run and most likely to be run. It
 * returns null when it cannot find the block, and callers treat null as a FAILURE rather than as
 * "no entries", because a parser that silently reports nothing is the vacuity this guard exists to
 * catch.
 *
 * GENERALISED FROM `exclude` to any key by #3262, which needs `include` read by the same parser
 * rather than by a second one: an `include` allowlist is an exclusion with the sign flipped, and a
 * separate reader for it would be a second place for the #2549 (prose is not a value) and #2724
 * (collapse is not emptiness) fixes to be missing from.
 *
 * `found` distinguishes an ABSENT key from a present-but-empty one, which the two callers need to
 * read in opposite directions: an absent `exclude` excludes nothing, an absent `include` includes
 * everything.
 *
 * @param {string} rawSrc the config file's source
 * @param {string} key the coverage-block key to read, e.g. "exclude" or "include"
 * @returns {{found: boolean, entries: string[]}|null} null when the block or the array is unparsed
 */
export function coverageArrayKey(rawSrc, key) {
	// Comments first — see stripTsComments. A quoted phrase in prose is not an entry.
	const src = stripTsComments(rawSrc);
	const covAt = src.indexOf("coverage: {");
	if (covAt === -1) return null;
	// Brace-match to the end of the coverage block so a later `exclude:` cannot be picked up.
	let depth = 0;
	let covEnd = -1;
	for (let i = src.indexOf("{", covAt); i < src.length; i += 1) {
		if (src[i] === "{") depth += 1;
		else if (src[i] === "}") {
			depth -= 1;
			if (depth === 0) {
				covEnd = i;
				break;
			}
		}
	}
	if (covEnd === -1) return null;
	const block = src.slice(covAt, covEnd);
	const opener = `${key}: [`;
	const exAt = block.indexOf(opener);
	if (exAt === -1) return { found: false, entries: [] };
	const close = block.indexOf("]", exAt);
	if (close === -1) return null;
	const inner = block.slice(exAt + opener.length, close);
	const entries = [...inner.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	// COLLAPSE IS NOT EMPTINESS (#2724). `exclude: []` is legitimately empty and returns []. But an
	// exclude block with CONTENT that yields no entries means this parser has stopped understanding
	// the block — a different quote style, a spread, a variable — and returning [] there would make
	// "the parser broke" indistinguishable from "there is nothing to exclude". Both then report
	// "none stale" and mean nothing. Callers treat null as unparsed and FAIL, which is the honest
	// answer. This is what the `literals >= 10` floor was standing in for, and it is a relationship
	// rather than a magnitude, so it cannot go slack.
	if (entries.length === 0 && inner.trim() !== "") return null;
	return { found: true, entries };
}

/**
 * The `exclude: [...]` entries of a vitest config's coverage block.
 *
 * An ABSENT `exclude` and an empty one mean the same thing — nothing is excluded — so both come
 * back as `[]` and the `found` flag is dropped here. null still means unparsed, and callers still
 * treat it as a FAILURE.
 *
 * @param {string} rawSrc the config file's source
 * @returns {string[]|null} the quoted entries, or null when the coverage/exclude block is absent
 */
export function coverageExcludes(rawSrc) {
	const read = coverageArrayKey(rawSrc, "exclude");
	return read === null ? null : read.entries;
}

/** The committed record of which vitest projects declare a coverage block (#2724). */
export const SWEEP_RECORD = "scripts/ts-coverage-sweep.json";

/**
 * Read the recorded coverage-emitting project set.
 *
 * THROWS on absence or malformation, deliberately. If a missing record read as an empty set, the
 * two assertions built on it would both pass vacuously — "nothing missing" and "nothing
 * unrecorded" are trivially true of an empty list — and deleting the file would silence the very
 * tripwire it exists to arm. The caller's `catch` turns a throw into a FAILED assertion, which is
 * the honest outcome: a check that cannot read its own baseline has not passed.
 */
function readSweepRecord() {
	const raw = readFileSync(path.join(ROOT, SWEEP_RECORD), "utf8");
	const parsed = JSON.parse(raw);
	const list = parsed?.coverage_emitting_projects;
	if (!Array.isArray(list) || list.length === 0) {
		throw new Error(`${SWEEP_RECORD}: coverage_emitting_projects must be a non-empty array`);
	}
	return list;
}

/** A path with no glob metacharacter — the kind that can silently stop matching anything. */
function isLiteralPath(entry) {
	return !/[*?{}[\]!]/.test(entry);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SELF-TEST — hermetic. No suites, no network, no node_modules, no repo state.
//
// A passing self-test proves the ARITHMETIC and the fail-open set. It does not prove the wiring:
// that is proven separately by deliberately regressing a real file and watching the required
// check go red.
// ─────────────────────────────────────────────────────────────────────────────────────────────

let failures = 0;
/** Assert, recording rather than throwing so every case runs. */
function check(name, cond, detail) {
	if (cond) {
		process.stdout.write(`  ✓ ${name}\n`);
	} else {
		failures += 1;
		process.stdout.write(`  ✗ ${name}${detail ? ` — ${detail}` : ""}\n`);
	}
}

/** Build a minimal coverage-final.json fixture. */
function fixture(files) {
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const [rel, hits] of Object.entries(files)) {
		/** @type {Record<string, unknown>} */
		const statementMap = {};
		/** @type {Record<string, number>} */
		const s = {};
		hits.forEach((h, i) => {
			statementMap[String(i)] = { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 10 } };
			s[String(i)] = h;
		});
		out[`/abs/proj/${rel}`] = { path: `/abs/proj/${rel}`, statementMap, s, fnMap: {}, f: {}, branchMap: {}, b: {} };
	}
	return out;
}

function runSelfTest() {
	process.stdout.write("ts-coverage --self-test\n\n measurement\n");

	const m = measure(fixture({ "lib/a.ts": [1, 0, 3], "lib/b.ts": [0, 0], "root.ts": [1] }), "/abs/proj");
	check("directory is the unit", m.get("lib")?.covered === 2 && m.get("lib")?.total === 5, JSON.stringify([...m]));
	check("root-level file keys to '.'", m.get(".")?.covered === 1 && m.get(".")?.total === 1);
	const nested = measure(fixture({ "lib/authz/a.ts": [1], "lib/authz/fga/b.ts": [0] }), "/abs/proj");
	check("nested dirs are DISTINCT keys, not recursive", nested.get("lib/authz")?.total === 1 && nested.get("lib/authz/fga")?.total === 1);
	check("keys come back sorted", [...measure(fixture({ "z/a.ts": [1], "a/b.ts": [1] }), "/abs/proj").keys()].join() === "a,z");

	process.stdout.write("\n exclusion parsing — collapse is not emptiness (#2724)\n");
	const ex = (src) => { const r = coverageExcludes(src); return r === null ? "null" : JSON.stringify(r); };
	check("no coverage block reads as null", ex("export default {}") === "null");
	check("a coverage block with no exclude is legitimately empty", ex('coverage: { provider: "v8" }') === "[]");
	check("...and so is an explicitly empty one", ex("coverage: { exclude: [] }") === "[]");
	check("normal entries parse", ex('coverage: { exclude: ["a.ts", "b/**"] }') === '["a.ts","b/**"]', ex('coverage: { exclude: ["a.ts", "b/**"] }'));
	// THE COLLAPSE. Before #2724 each of these returned [] — indistinguishable from "nothing to
	// exclude" — so the staleness sweep below reported "none stale" having read nothing. That is
	// what the `literals >= 10` floor was standing in for, badly.
	check("single-quoted entries are a PARSE FAILURE, not an empty list", ex("coverage: { exclude: ['a.ts', 'b.ts'] }") === "null", ex("coverage: { exclude: ['a.ts', 'b.ts'] }"));
	check("a spread the parser cannot read is a failure too", ex("coverage: { exclude: [...SHARED] }") === "null", ex("coverage: { exclude: [...SHARED] }"));
	check("a template literal is a failure too", ex("coverage: { exclude: [`a.ts`] }") === "null", ex("coverage: { exclude: [`a.ts`] }"));

	process.stdout.write("\n corruption tripwire (F6 feeds on these)\n");
	const bad = fixture({ "lib/a.ts": [1, 1] });
	delete bad["/abs/proj/lib/a.ts"].s["1"];
	check("statementMap/s length mismatch throws", (() => { try { measure(bad, "/abs/proj"); return false; } catch (e) { return e instanceof UnusableCoverageError; } })());
	check("path outside the project root throws", (() => { try { measure({ "/elsewhere/x.ts": { statementMap: {}, s: {} } }, "/abs/proj"); return false; } catch (e) { return e instanceof UnusableCoverageError; } })());
	check("missing statementMap throws", (() => { try { measure({ "/abs/proj/a.ts": { s: {} } }, "/abs/proj"); return false; } catch (e) { return e instanceof UnusableCoverageError; } })());
	check("non-integer hit count throws", (() => { try { measure({ "/abs/proj/a.ts": { statementMap: { 0: {} }, s: { 0: "x" } }, }, "/abs/proj"); return false; } catch (e) { return e instanceof UnusableCoverageError; } })());

	process.stdout.write("\n arithmetic — integer, never a percentage\n");
	check("equal ratio does not regress", !regressed({ covered: 2, total: 4 }, { covered: 1, total: 2 }));
	check("one fewer covered DOES regress", regressed({ covered: 184, total: 291 }, { covered: 185, total: 291 }));
	check("one more covered does not", !regressed({ covered: 186, total: 291 }, { covered: 185, total: 291 }));
	// THE ROUNDING TRAP: 185/291 = 63.5739%, displayed as "63.6%". A percentage-based gate storing
	// the displayed value fails its own floor with zero code change, forever.
	check("185/291 passes its own floor (the 63.6% display trap)", !regressed({ covered: 185, total: 291 }, { covered: 185, total: 291 }));
	check("growing code with proportional cover does not regress", !regressed({ covered: 370, total: 582 }, { covered: 185, total: 291 }));
	check("0/0 vs 0/0 passes (no division ever happens)", !regressed({ covered: 0, total: 0 }, { covered: 0, total: 0 }));
	check("0% cannot fall below 0%", !regressed({ covered: 0, total: 50 }, { covered: 0, total: 10 }));
	check("BigInt scale (1e9) is exact", regressed({ covered: 999999998, total: 1000000000 }, { covered: 999999999, total: 1000000000 }));

	process.stdout.write("\n floors layout — the 4-line record property\n");
	const dirs = new Map([["lib/a", { covered: 1, total: 2 }], ["lib/b", { covered: 3, total: 4 }]]);
	const text = renderFloors("apps/console", dirs, { os: "Linux" });
	check("valid JSON", (() => { try { JSON.parse(text); return true; } catch { return false; } })());
	check("carries the do-not-hand-merge banner", JSON.parse(text)._ === BANNER);
	// Count DIRECTORY record openings specifically: a bare /^ {4}"/ also matches the env block's
	// keys, which sit at the same indent. That is the sort of near-miss that makes an assertion
	// pass for the wrong reason, so it is anchored on the "covered" line that must follow.
	const recLines = [...text.matchAll(/\n {4}"[^"]+": \{\n {6}"covered":/g)].length;
	check("one opening line per directory", recLines === 2, `${recLines}`);
	check("each record spans exactly 4 lines", /\n {4}"lib\/a": \{\n {6}"covered": 1,\n {6}"total": 2\n {4}\},\n/.test(text));
	check("coveredLineOf points at the covered line", text.split("\n")[coveredLineOf(text, "lib/b") - 1].includes('"covered": 3'));

	process.stdout.write("\n floors layout — a REAL 3-way merge of two divergent raises\n");
	const tmp = mkdtempSync(path.join(tmpdir(), "ts-cov-"));
	try {
		const base = renderFloors("p", new Map([["lib/a", { covered: 1, total: 10 }], ["lib/b", { covered: 1, total: 10 }]]), {});
		const ours = renderFloors("p", new Map([["lib/a", { covered: 9, total: 10 }], ["lib/b", { covered: 1, total: 10 }]]), {});
		const theirs = renderFloors("p", new Map([["lib/a", { covered: 1, total: 10 }], ["lib/b", { covered: 8, total: 10 }]]), {});
		const f = (n, c) => { const p = path.join(tmp, n); writeFileSync(p, c); return p; };
		const [o, b, t] = [f("ours", ours), f("base", base), f("theirs", theirs)];
		let merged = "";
		let clean = true;
		try {
			execFileSync("git", ["merge-file", "-p", o, b, t], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
			merged = execFileSync("git", ["merge-file", "-p", o, b, t], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		} catch (e) {
			clean = false;
			merged = e.stdout ?? "";
		}
		check("two PRs raising DIFFERENT adjacent directories merge clean", clean && !merged.includes("<<<<<<<"));
		check("both raises survive the merge", merged.includes('"covered": 9') && merged.includes('"covered": 8'));
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}

	process.stdout.write("\n annotation format\n");
	check("annotation is a single line even from multi-line input", !`::error file=a,line=2::${"x\ny".replace(/\r?\n/g, " ")}`.slice(8).includes("\n"));

	// THE STREAM SPLIT, DRIVEN THROUGH THE REAL FUNCTION.
	//
	// The case above asserts a property of a string literal it builds inline — it never calls
	// `annotate`, so reverting the stream back to stdout left it green. That mattered: stdout is the
	// DATA channel `--print` feeds the determinism probe through, and an annotation landing there is
	// the whole defect #3444 existed to fix. A fix whose own test cannot observe it is not covered.
	{
		const outChunks = [];
		const errChunks = [];
		const realOut = process.stdout.write.bind(process.stdout);
		const realErr = process.stderr.write.bind(process.stderr);
		process.stdout.write = (c) => { outChunks.push(String(c)); return true; };
		process.stderr.write = (c) => { errChunks.push(String(c)); return true; };
		try {
			annotate("warning", null, null, "ts-coverage F2: proj: no coverage/coverage-final.json");
			annotate("error", "apps/console/coverage-floors.json", 12, "line one\nline two");
		} finally {
			process.stdout.write = realOut;
			process.stderr.write = realErr;
		}
		check("annotate writes NOTHING to stdout — that stream is the probe's data channel", outChunks.length === 0);
		check("annotate writes the workflow command to stderr", errChunks.join("").includes("::warning::ts-coverage F2:"));
		check("annotate keeps file/line on stderr too", errChunks.join("").includes("::error file=apps/console/coverage-floors.json,line=12::"));
		check("a multi-line message is still one line", errChunks.every((c) => c.split("\n").filter(Boolean).length === 1));
	}

	process.stdout.write("\n scope — every coverage-emitting project must have a ratchet step\n");
	try {
		const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
		const configs = execFileSync("git", ["ls-files", "*vitest.config.ts"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean);
		/** @type {string[]} */
		const emitting = [];
		/** @type {string[]} */
		const ungated = [];
		for (const cfg of configs) {
			const src = readFileSync(path.join(ROOT, cfg), "utf8");
			if (!/\bcoverage\s*:\s*\{/.test(src)) continue;
			const proj = path.dirname(cfg);
			emitting.push(proj);
			if (!ci.includes(`--project ${proj}`)) ungated.push(proj);
		}
		// THE VACUITY CHECK, AND IT COMES FIRST.
		//
		// Without it this whole block passes on an EMPTY input: `configs` empty means the loop body
		// never runs, `ungated` stays empty, and "no project lacks a ratchet step" reports green
		// having examined ZERO projects. The `catch` below does not cover it either — it handles
		// git THROWING, not git succeeding and printing nothing (a `git ls-files` from outside a
		// work tree, a future rename of the config file, a pathspec that stops matching).
		//
		// That is the exact defect this script exists to prevent elsewhere: a "nothing found"
		// branch indistinguishable from "nothing wrong". Asserting the denominator makes the
		// difference visible — an empty sweep now FAILS instead of congratulating itself.
		//
		// THE DENOMINATOR IS A RECORDED SET, NOT A FLOOR (#2724).
		//
		// This was `emitting.length >= 3`, and a hand-typed floor guarding a number that changes
		// whenever a project gains coverage can only ever go slack — silently, because slack passes.
		// It did, twice, within hours: #2695 set it at exactly 3; #2720 correctly added
		// apps/marketing and ee (real count 5); by the time #2724 was fixed packages/format had made
		// it 6. A tripwire written to catch ONE project leaving the sweep was tolerating THREE.
		//
		// A recorded SET cannot drift that way, and it says WHICH project vanished rather than only
		// that the number got smaller. A project appearing fails too, asking for the record to be
		// updated in a reviewed diff — the same ratchet discipline coverage-floors.json already
		// applies to the numbers, applied to the sweep that guards them.
		const recorded = readSweepRecord();
		const missing = recorded.filter((p) => !emitting.includes(p));
		const unrecorded = emitting.filter((p) => !recorded.includes(p));
		check(
			"the scope sweep found every project recorded as coverage-emitting",
			missing.length === 0,
			missing.length > 0
				? `${missing.join(", ")} declared coverage when ${SWEEP_RECORD} was written and does not now — either its coverage block went away (record that here) or this sweep has stopped seeing it`
				: `found all ${recorded.length}: ${emitting.join(", ")}`,
		);
		check(
			"...and no coverage-emitting project is missing from that record",
			unrecorded.length === 0,
			unrecorded.length > 0
				? `${unrecorded.join(", ")} declares coverage but is not in ${SWEEP_RECORD} — add it there in this PR so the set stays reviewed`
				: "",
		);
		check("no coverage-emitting vitest project lacks a ratchet step in ci.yml", ungated.length === 0, ungated.join(", "));

		// ── every LITERAL coverage exclusion must still name a file that exists ──
		//
		// A glob cannot go stale: `lib/queries/**` matching nothing is indistinguishable from a
		// directory that emptied, and either way it excludes nothing and misleads nobody. A LITERAL
		// path is different — it becomes a lie the moment its file is renamed, and it reads exactly
		// like a live one.
		//
		// This has already cost eight weeks: `app/server/actions/{specs,zones}.ts` sat in the
		// console's exclude list long after both files were deleted (#2656), found by somebody
		// happening to look rather than by anything catching it. #2700 then replaced one glob with
		// six literal paths, which is the right call for checkability but triples the number of
		// entries that can rot.
		/** @type {string[]} */
		const stale = [];
		let literals = 0;
		/** @type {string[]} */
		const unparsed = [];
		// Re-derived from `configs` rather than reusing the loop above's list, so this block stands
		// on its own and does not couple to how the sweep happens to be written.
		for (const cfg of configs) {
			const src = readFileSync(path.join(ROOT, cfg), "utf8");
			if (!/\bcoverage\s*:\s*\{/.test(src)) continue;
			const entries = coverageExcludes(src);
			// null means the parser could not find the block it was told to read. Treated as a
			// FAILURE, never as "no exclusions" — a parser that silently reports nothing is exactly
			// the vacuity this section exists to close.
			if (entries === null) {
				unparsed.push(cfg);
				continue;
			}
			for (const entry of entries) {
				if (!isLiteralPath(entry)) continue;
				literals += 1;
				if (!existsSync(path.join(ROOT, path.dirname(cfg), entry))) stale.push(`${path.dirname(cfg)}/${entry}`);
			}
		}
		check("every vitest coverage block parsed", unparsed.length === 0, unparsed.join(", "));
		// The floor that used to sit here (`literals >= 10`) is GONE, replaced by a relationship
		// (#2724). It was a vacuity tripwire against the parser collapsing, expressed as a
		// magnitude — and a magnitude is the wrong shape twice over. It went slack (10 against 17
		// real, tolerating seven disappearing), and it pointed the wrong way: FEWER exclusions is an
		// improvement, so a shrinking count is not evidence of anything wrong.
		//
		// What it was actually protecting is now enforced where it belongs, in coverageExcludes:
		// an exclude block with content that parses to no entries returns null and lands in
		// `unparsed` above, which fails and names the config. That catches the collapse this floor
		// was aiming at, without a number anyone has to remember to raise.
		check("the exclusion sweep examined a non-empty set of configs", emitting.length > 0, `${emitting.length} coverage-emitting config(s)`);
		check("every literal coverage exclusion still names a real file", stale.length === 0, stale.join(", "));
	} catch (err) {
		check("scope check could run", false, err.message);
	}

	process.stdout.write("\n the entry-point gate — a SYMLINKED invocation must still run\n");
	// The gate decides whether this file does anything at all, and its failure mode is silence:
	// a wrong comparison exits 0 having printed nothing, which no caller distinguishes from a
	// pass. It cannot be asserted in-process — the gate has already been evaluated by the time
	// this line runs — so the case SPAWNS the script through a symlinked directory, the shape
	// that broke it (`path.resolve` does not follow a symlink; the ESM loader realpaths
	// `import.meta.filename`, so the two disagreed and `runCli` never ran).
	{
		const link = path.join(mkdtempSync(path.join(tmpdir(), "tscov-link-")), "wt");
		try {
			symlinkSync(ROOT, link);
			// `--project` is deliberately omitted: the usage error is proof the CLI RAN, and it
			// needs no repository state, no coverage artefact and no network to reach.
			const out = execFileSync(process.execPath, [path.join(link, "scripts", "ts-coverage.mjs")], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			check("a symlinked invocation is not silently skipped", false, `expected the usage error, got a clean exit: ${JSON.stringify(out)}`);
		} catch (err) {
			const e = /** @type {{status?: number, stderr?: string}} */ (err);
			check(
				"a symlinked invocation runs the CLI rather than exiting 0 in silence",
				e.status === 2 && (e.stderr ?? "").includes("--project"),
				`status ${String(e.status)}, stderr ${JSON.stringify(e.stderr ?? "")}`,
			);
		} finally {
			rmSync(path.dirname(link), { recursive: true, force: true });
		}
	}

	process.stdout.write(`\n${failures === 0 ? "✓ all self-test assertions passed" : `✗ ${failures} self-test assertion(s) FAILED`}\n`);
	process.exit(failures === 0 ? 0 : 1);
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Parse argv and run the requested mode.
 *
 * GATED ON BEING THE ENTRY POINT (#3262). This block used to be bare top-level statements, which
 * made the module unimportable: `import { coverageExcludes } from "./ts-coverage.mjs"` ran the CLI
 * as a side effect of the import, found no `--project` in the IMPORTER's argv, and exited 2 before
 * the importing guard had executed a line. scripts/check-coverage-exclusions.mjs reuses this
 * file's parser rather than growing a second one — the #2549 and #2724 fixes live in it and a
 * copy is a place for them to be missing from — so the reuse has to be possible.
 *
 * `process.argv[1]` is compared REALPATH-RESOLVED, not `path.resolve`d. The ESM loader realpaths
 * the main module before it derives `import.meta.filename`, and `path.resolve` does not follow a
 * symlink at all, so the two disagree for every invocation whose path crosses one — a symlinked
 * checkout, a container bind-mount, or macOS's own `/tmp` -> `/private/tmp`. A disagreeing gate is
 * SILENT: node exits 0 having printed nothing and run nothing, which no caller can tell from a
 * pass. Measured before the fix: `node <symlink>/scripts/ts-coverage.mjs --self-test` exited 0 with
 * zero output while the same file through its real path ran every assertion. `fs.realpathSync` is
 * the idiom scripts/check-e2e-spend-guard.mjs and scripts/programme-rollup.mjs already use.
 */
function runCli() {
	const argv = process.argv.slice(2);
	/** @type {string|undefined} */
	let project;
	let mode = "check";
	// `--print` only. Declared in the parser rather than sniffed out of process.argv later, because
	// the `else` below REFUSES an argument it does not know — an unregistered flag would exit 2 with
	// "unknown argument", which is the correct behaviour and the reason it must be registered here.
	let perFile = false;
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === "--project") { project = argv[i + 1]; i += 1; }
		else if (a.startsWith("--project=")) project = a.slice("--project=".length);
		else if (a === "--update") mode = "update";
		else if (a === "--accept-regression") mode = "accept";
		else if (a === "--print") mode = "print";
		else if (a === "--per-file") perFile = true;
		else if (a === "--self-test") mode = "self-test";
		else {
			process.stderr.write(`ts-coverage: unknown argument ${a}\n`);
			process.exit(2);
		}
	}

	// `--per-file` only means anything to `--print`. It is registered in the loop above so the
	// parser's `else` cannot reject it, and that registration is exactly how it became the one flag
	// that escapes the strictness the registration was justified by: `--update --per-file` parsed
	// fine, dropped the flag, and wrote per-DIRECTORY floors while exiting 0. Refusing here restores
	// the property — an argument that cannot take effect is an error, not a no-op.
	if (perFile && mode !== "print") {
		process.stderr.write(`ts-coverage: --per-file applies to --print only (mode is --${mode})\n`);
		process.exit(2);
	}

	if (mode === "self-test") runSelfTest();
	else if (!project) {
		process.stderr.write("ts-coverage: --project <path> is required (e.g. --project apps/console)\n");
		process.exit(2);
	} else if (!existsSync(path.join(ROOT, project))) {
		process.stderr.write(`ts-coverage: no such project directory: ${project}\n`);
		process.exit(2);
	} else if (mode === "check") runCheck(project);
	else if (mode === "print") runPrint(project, perFile);
	else runUpdate(project, { allowLower: mode === "accept" });
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) runCli();
