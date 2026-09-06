#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// A workflow file must MEAN what it says: every step carries a `run:` or a `uses:`, every
// `permissions:` scope is one Actions accepts, no `name:` loses half of itself to an unquoted `#`,
// and no step in a job with `services:` runs past a failed `Initialize containers` to report a
// cause that was never true.
//
// WHY THIS EXISTS. A workflow file can be VALID YAML and still be REJECTED by Actions:
//
//     - name: Compute aggregate Go coverage → badge JSON
//       run: node scripts/go-coverage-badge.mjs
//     - name: Commit the badge if it changed        ← no `run:`, no `uses:`
//     - name: Publish the badge
//       run: |
//
// That is a well-formed mapping with one key, so every YAML parser accepts it. Actions does not —
// it rejects the whole file. The run completes as `completed/failure` with `jobs total_count: 0`.
//
// THE ZERO IS THE DANGEROUS PART. No jobs means not one of the nine required checks ever reports,
// so the PR does not go RED — it sits BLOCKED with an EMPTY status rollup, which reads exactly like
// "CI hasn't started yet". Nothing in the checks list names the cause. It is this repo's recurring
// shape: a failure that leaves no red signal.
//
// `yaml.parse()` passes on this input, which is the whole point — parsing is not validation, and a
// verification note saying "ci.yml parses" is true and worthless here.
//
//   node scripts/ci/check-workflow-shape.mjs
//   node scripts/ci/check-workflow-shape.mjs --self-test
//
// Line-based, because `yaml` is a dependency of apps/console and not of the root while this runs
// under plain `node` — the same constraint and the same shape as check-guards-independent.mjs. A
// line parser that stops matching finds nothing and reports success, so the blindness guards below
// are not optional decoration; they are what makes a green result mean anything.

import fs from "node:fs";
import path from "node:path";

const DIR = ".github/workflows";

/**
 * Walk one workflow's steps.
 *
 * Deliberately shallow: it tracks indentation rather than modelling YAML, because the only question
 * asked is "does this list item carry a run/uses key". Anything it cannot confidently read is
 * REPORTED, never skipped.
 *
 * @param {string} text
 * @returns {{jobs: number, steps: number, problems: {line: number, name: string}[], readable: boolean}}
 */
/**
 * The GITHUB_TOKEN permission scopes Actions accepts. Closed set, from the workflow syntax
 * reference — there is no way to enumerate it at runtime, and getting it wrong in the PERMISSIVE
 * direction is the only mistake that matters here.
 */
export const PERMISSION_SCOPES = new Set([
	"actions",
	"attestations",
	"checks",
	"contents",
	"deployments",
	"discussions",
	"id-token",
	"issues",
	"models",
	"packages",
	"pages",
	"pull-requests",
	"repository-projects",
	"security-events",
	"statuses",
]);

/** The three access levels a scope may be granted. */
const PERMISSION_LEVELS = new Set(["read", "write", "none"]);

/** Shorthands that stand in for the whole mapping. */
const PERMISSION_SHORTHANDS = new Set(["read-all", "write-all", "{}"]);

/**
 * Nearest valid scope by edit distance, so a refusal can say what was probably meant. A guard that
 * only says no is one people learn to route around; `administration` → `attestations` is not a
 * useful suggestion, so anything past a small distance is left unsuggested rather than guessed.
 */
function nearestScope(key) {
	let best = null;
	let bestD = Infinity;
	for (const scope of PERMISSION_SCOPES) {
		const d = editDistance(key, scope);
		if (d < bestD) {
			bestD = d;
			best = scope;
		}
	}
	return bestD <= 3 ? best : null;
}

function editDistance(a, b) {
	const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0];
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j];
			prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return prev[b.length];
}

/**
 * Every `permissions:` mapping in one workflow, top-level and per-job, as `{line, key, value}`.
 *
 * WHY THIS IS WORTH A CHECK. An unrecognised permission scope does not degrade — Actions rejects
 * the WHOLE FILE, and the run completes with zero jobs and an empty status rollup. On 2026-08-28 an
 * `administration: read` added to workflow-health.yml (#3229, chasing a ruleset read that does not
 * need it) took the daily health workflow off the air entirely. Four runs failed with no jobs and
 * no annotation anyone saw, on `dev` and on three feature branches, and it was noticed only because
 * somebody went looking at that workflow for an unrelated reason.
 *
 * That is the same failure this file already guards for a step with no `run:`/`uses:` — a workflow
 * that stops existing rather than going red — arriving through a different key. `yaml.parse()`
 * accepts it, so parsing proves nothing here either.
 *
 * Line-scanned, matching the rest of this file: a `permissions:` key, then the indented `k: v`
 * pairs beneath it until the indentation returns.
 */
/**
 * Every `name:` whose written text is NOT what YAML parses — because an unquoted `#` preceded by
 * whitespace opens a comment and the rest of the line is dropped.
 *
 * WHY THIS IS WORTH A CHECK, given that the step still runs. Two names in this repo cite an
 * incident, and the citation is the entire reason they are worded that way:
 *
 *     written: Worktree lease guard — replays incident #1247
 *     parsed : Worktree lease guard — replays incident
 *     written: Post the result to #2843
 *     parsed : Post the result to
 *
 * The Actions UI shows the parsed form, so the reference a reader needs when the step goes red is
 * exactly the half that disappears. Same family as the rest of this file: a workflow that says
 * something it does not mean, and `yaml.parse()` agrees with the file rather than with the author.
 *
 * THE RULE IS "`#` PRECEDED BY WHITESPACE", NOT "CONTAINS `#`". `IP-activation markers still match
 * the legal prose (#2366)` is CORRECT — the `#` follows `(`, so it is part of the scalar and
 * nothing is lost. Four such names exist here, and a contains-`#` rule would "fix" all four.
 * A quoted scalar (`name: 'Post the result to #2843'`) is likewise fine.
 *
 * @param {string} text
 * @returns {{line: number, written: string, parsed: string}[]}
 */
export function scanNameTruncation(text) {
	const out = [];
	text.split("\n").forEach((line, i) => {
		const m = line.match(/^\s*(?:-\s+)?name:\s*(\S.*?)\s*$/);
		if (m === null) return;
		const scalar = m[1];
		if (scalar.startsWith("'") || scalar.startsWith('"') || scalar.startsWith(">") || scalar.startsWith("|")) return;
		const cut = scalar.search(/\s#/);
		if (cut === -1) return;
		out.push({ line: i + 1, written: scalar, parsed: scalar.slice(0, cut).trimEnd() });
	});
	return out;
}

export function scanPermissions(text) {
	const lines = text.split("\n");
	const entries = [];
	for (let i = 0; i < lines.length; i++) {
		const head = lines[i].match(/^(\s*)permissions:\s*(\S.*)?$/);
		if (head === null) continue;
		const indent = head[1].length;
		const inline = (head[2] ?? "").replace(/\s*#.*$/, "").trim();
		if (inline !== "") {
			// `permissions: read-all` / `write-all` / `{}` — a whole-mapping shorthand, not a scope.
			entries.push({ line: i + 1, key: null, shorthand: inline });
			continue;
		}
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].trim() === "" || /^\s*#/.test(lines[j])) continue;
			const lead = lines[j].match(/^(\s*)/)?.[1].length ?? 0;
			if (lead <= indent) break;
			const pair = lines[j].match(/^\s*([A-Za-z0-9_-]+):\s*([^#]*?)\s*(?:#.*)?$/);
			if (pair === null) break;
			entries.push({ line: j + 1, key: pair[1], value: pair[2] });
		}
	}
	return entries;
}

export function scanWorkflow(text) {
	const lines = text.split("\n");
	const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
	if (jobsAt === -1) return { jobs: 0, steps: 0, problems: [], readable: false };

	let jobs = 0;
	let steps = 0;
	const problems = [];

	for (let i = jobsAt + 1; i < lines.length; i++) {
		if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) jobs += 1;
		// A steps list item, at any indent — jobs nest their `steps:` at a known depth, but matrix
		// and reusable-workflow shapes vary, so the item marker is what is matched.
		const head = lines[i].match(/^(\s+)-\s+(\S.*)$/);
		if (head === null) continue;
		const indent = head[1].length;
		// Only list items INSIDE a steps: block count. Walk back to the nearest key at a shallower
		// indent and require it to be `steps:`; this is what keeps `on:`/`with:`/`paths:` lists out.
		let owner = null;
		for (let b = i - 1; b > jobsAt; b--) {
			const key = lines[b].match(/^(\s*)([A-Za-z0-9_-]+):\s*$/);
			if (key === null) continue;
			if (key[1].length < indent) {
				owner = key[2];
				break;
			}
		}
		if (owner !== "steps") continue;

		steps += 1;
		// The step's own keys run from its head line to the next item at the same indent, or to a
		// line at a shallower indent (the end of the list).
		let hasAction = /^(run|uses):/.test(head[2]);
		let name = head[2];
		for (let j = i + 1; j < lines.length; j++) {
			if (new RegExp(`^\\s{${indent}}-\\s`).test(lines[j])) break;
			if (lines[j].trim() !== "" && (lines[j].match(/^(\s*)/)?.[1].length ?? 0) <= indent && !/^\s*#/.test(lines[j])) break;
			if (new RegExp(`^\\s{${indent + 2}}(run|uses):`).test(lines[j])) hasAction = true;
			const n = lines[j].match(/^\s+name:\s*(.+)$/);
			if (n && !/^name:/.test(name)) name = n[1];
		}
		if (!hasAction) {
			problems.push({ line: i + 1, name: name.replace(/^name:\s*/, "").trim() });
		}
	}
	return { jobs, steps, problems, readable: true };
}

/**
 * Steps in a SERVICE-BEARING job whose `if:` survives a **setup** failure without also asking
 * whether anything was ever set up.
 *
 * WHY THIS IS WORTH A CHECK. `services:` are started by the runner in `Initialize containers`,
 * which is step ZERO — it runs BEFORE `actions/checkout`. When a service image fails to pull, that
 * step fails and every real step in the job is SKIPPED, workspace included. A step written
 * `if: ${{ !cancelled() }}` is not skipped: `cancelled()` is false, so it runs against an EMPTY
 * checkout. Run 33710964528's `UI conformance audit` is the whole shape in one job list:
 *
 *     1.Set up job=success | 2.Initialize containers=FAILURE | 3.actions/checkout=SKIPPED
 *     … 4–15 all SKIPPED …
 *     16.Per-predicate summary of the audit=FAILURE | 17.Upload the audit report=success
 *
 * Step 16 reported `Cannot find module … apps/console/scripts/audit-report.mjs` for a file that is
 * present on `dev` at 173450 bytes, so the log's last line accused the console of a missing script.
 * Step 17 is the milder half of the same class: it "succeeded" having uploaded nothing.
 *
 * `always()` is scanned as well as `!cancelled()`, and that is deliberate rather than thorough. A
 * guard that watched only `!cancelled()` would have `always()` as its cheapest escape route — a
 * one-word edit that silences the check and makes the defect strictly worse, because the step then
 * also runs on a cancel. Both are accepted the moment the expression additionally tests a
 * `steps.<id>.outcome`/`.conclusion`/`.outputs`, which is the in-repo fix: `ci.yml`'s `guards` job
 * carries `!cancelled() && steps.setup.outcome == 'success'` on 135 steps, and e2e-nightly's
 * `provision` job conjoins every one of its `always()` steps the same way.
 *
 * Scoped to jobs that declare `services:` on purpose. A job with no service container has no step
 * ahead of `checkout` that can fail, so `!cancelled()` there means what it says.
 *
 * @param {string} text
 * @returns {{serviceJobs: number, problems: {line: number, job: string, name: string, expr: string}[]}}
 */
export function scanServiceGuards(text) {
	const lines = text.split("\n");
	const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
	if (jobsAt === -1) return { serviceJobs: 0, problems: [] };

	// Pass one: which jobs declare `services:`. Separate from the step walk because nothing orders
	// a job's keys — `services:` may sit after `steps:`, and often does not.
	const withServices = new Set();
	let job = null;
	for (let i = jobsAt + 1; i < lines.length; i++) {
		const head = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
		if (head !== null) {
			job = head[1];
			continue;
		}
		if (job !== null && /^ {4}services:\s*$/.test(lines[i])) withServices.add(job);
	}

	// Pass two: the steps of those jobs.
	const problems = [];
	job = null;
	for (let i = jobsAt + 1; i < lines.length; i++) {
		const head = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
		if (head !== null) {
			job = head[1];
			continue;
		}
		if (job === null || !withServices.has(job)) continue;
		const item = lines[i].match(/^(\s+)-\s+(\S.*)$/);
		if (item === null) continue;
		const indent = item[1].length;
		// Only list items inside a `steps:` block — the same nearest-shallower-key walk scanWorkflow
		// uses, and for the same reason: `on:`/`with:`/`paths:` lists are not steps.
		let owner = null;
		for (let b = i - 1; b > jobsAt; b--) {
			const key = lines[b].match(/^(\s*)([A-Za-z0-9_-]+):\s*$/);
			if (key === null) continue;
			if (key[1].length < indent) {
				owner = key[2];
				break;
			}
		}
		if (owner !== "steps") continue;

		// The step's own keys, re-based so a top-level key of the step sits at column 0. Anything
		// nested under `with:`/`env:`/`run: |` keeps its indent and cannot be mistaken for one.
		const own = [{ text: item[2], line: i + 1 }];
		for (let j = i + 1; j < lines.length; j++) {
			if (new RegExp(`^\\s{${indent}}-\\s`).test(lines[j])) break;
			if (lines[j].trim() !== "" && (lines[j].match(/^(\s*)/)?.[1].length ?? 0) <= indent && !/^\s*#/.test(lines[j])) break;
			own.push({ text: lines[j].slice(indent + 2), line: j + 1 });
		}

		let name = /^name:/.test(item[2]) ? item[2].replace(/^name:\s*/, "").trim() : item[2].trim();
		let expr = null;
		let exprLine = i + 1;
		for (let k = 0; k < own.length; k++) {
			const nm = own[k].text.match(/^name:\s*(\S.*?)\s*$/);
			if (nm !== null) name = nm[1];
			const iff = own[k].text.match(/^if:\s*(.*?)\s*$/);
			if (iff === null) continue;
			let v = iff[1];
			// A folded/literal block scalar (`if: >-`) puts the expression on the following lines.
			if (v === "" || /^[|>][-+]?\d*$/.test(v)) {
				const parts = [];
				for (let m = k + 1; m < own.length; m++) {
					if (own[m].text.trim() === "" || !/^\s/.test(own[m].text)) break;
					parts.push(own[m].text.trim());
				}
				v = parts.join(" ");
			}
			expr = v;
			exprLine = own[k].line;
		}
		if (expr === null) continue;

		const survivesFailure = /!\s*cancelled\s*\(\s*\)/.test(expr) || /(^|[^.\w])always\s*\(\s*\)/.test(expr);
		if (!survivesFailure) continue;
		// Any test of an earlier step's result is enough — the point is that SOMETHING ran, not
		// which spelling was used.
		if (/steps\.[A-Za-z0-9_-]+\.(outcome|conclusion|outputs)\b/.test(expr)) continue;
		problems.push({ line: exprLine, job, name: name.replace(/^name:\s*/, "").trim(), expr });
	}
	return { serviceJobs: withServices.size, problems };
}

/** @returns {string[]} failures */
export function check(dir = DIR, readdir = fs.readdirSync, readFile = (p) => fs.readFileSync(p, "utf8")) {
	const out = [];
	let files;
	try {
		files = readdir(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
	} catch {
		return [`${dir} could not be read — this check cannot run, which is not the same as passing.`];
	}
	// A repo with no workflows is not a repo this check should pass in silence.
	if (files.length === 0) {
		return [`no workflow files found in ${dir} — the matcher has stopped matching, or the directory moved.`];
	}

	let totalSteps = 0;
	let unreadable = 0;
	let permissionEntries = 0;
	let serviceJobs = 0;
	for (const f of files.sort()) {
		const text = readFile(path.join(dir, f));
		const { jobs, steps, problems, readable } = scanWorkflow(text);
		if (!readable) {
			// A workflow with no `jobs:` block at all is a shape this parser does not understand.
			// Counted and reported rather than skipped — see the total-steps guard below.
			unreadable += 1;
			continue;
		}
		totalSteps += steps;
		for (const p of scanPermissions(text)) {
			permissionEntries += 1;
			if (p.key === null) {
				if (!PERMISSION_SHORTHANDS.has(p.shorthand)) {
					out.push(
						`${dir}/${f}:${p.line}: \`permissions: ${p.shorthand}\` is not one of ${[...PERMISSION_SHORTHANDS].join(", ")}. ` +
							"Actions REJECTS the whole file for an unrecognised permissions value — the workflow stops running entirely, " +
							"with zero jobs and no red step to explain it.",
					);
				}
				continue;
			}
			if (!PERMISSION_SCOPES.has(p.key)) {
				const near = nearestScope(p.key);
				out.push(
					`${dir}/${f}:${p.line}: \`${p.key}\` is not a GITHUB_TOKEN permission scope${near ? `. Did you mean \`${near}\`?` : "."} ` +
						"An unknown key does not degrade — Actions REJECTS the whole file, so the workflow silently stops running: " +
						"zero jobs, an empty status rollup, and nothing red anywhere. That is how #3229 took workflow-health off the air. " +
						`The scopes are: ${[...PERMISSION_SCOPES].join(", ")}.`,
				);
				continue;
			}
			if (!PERMISSION_LEVELS.has(p.value)) {
				out.push(
					`${dir}/${f}:${p.line}: \`${p.key}: ${p.value}\` — the level must be one of ${[...PERMISSION_LEVELS].join(", ")}. ` +
						"An unrecognised value rejects the file exactly as an unknown key does.",
				);
			}
		}
		if (jobs === 0) {
			out.push(`${dir}/${f}: a \`jobs:\` block with no jobs under it — Actions would reject this file, producing a run with zero jobs and an EMPTY status rollup.`);
		}
		for (const t of scanNameTruncation(text)) {
			out.push(
				`${dir}/${f}:${t.line}: this name is silently truncated by YAML — written \`${t.written}\`, ` +
					`parsed \`${t.parsed}\`. An unquoted \`#\` preceded by whitespace opens a comment, so the ` +
					"Actions UI drops everything after it — including the issue reference the name exists to carry. " +
					`Quote it: \`name: '${t.written}'\`.`,
			);
		}
		const guards = scanServiceGuards(text);
		serviceJobs += guards.serviceJobs;
		for (const g of guards.problems) {
			out.push(
				`${dir}/${f}:${g.line}: the step \`${g.name}\` in job \`${g.job}\` runs on \`${g.expr}\`, and that job declares ` +
					"`services:`. A service container that fails to pull fails `Initialize containers` — step ZERO, BEFORE " +
					"`actions/checkout` — so every real step is SKIPPED and this one is not: it runs against an EMPTY workspace. " +
					"Run 33710964528's `UI conformance audit` ended by reporting `Cannot find module` for a script that is present " +
					"on dev, and its upload step reported SUCCESS having uploaded nothing. Conjoin a step-outcome test, as the " +
					"`guards` job does on 135 steps: `if: ${{ !cancelled() && steps.<id>.outcome == 'success' }}` — giving the " +
					"job's `actions/checkout` an `id:` if it has none.",
			);
		}
		for (const p of problems) {
			out.push(
				`${dir}/${f}:${p.line}: the step \`${p.name}\` has neither \`run:\` nor \`uses:\`. ` +
					"Actions REJECTS the whole file for this — the run completes with zero jobs, so not one required " +
					"check reports and the PR sits BLOCKED with an empty rollup instead of going red.",
			);
		}
	}

	// THE BLINDNESS GUARD. Every failure above is "this file is wrong"; this one is "I am wrong".
	// A parser that stopped understanding the layout finds no steps and reports a clean bill of
	// health, which is precisely the shape this whole check exists to remove from the repo.
	if (totalSteps === 0) {
		out.push(
			`parsed ${files.length} workflow file(s) and found ZERO steps. There are hundreds, so this ` +
				"parser has stopped matching — fix it rather than trusting the green.",
		);
	}
	// The same blindness guard, for the permissions scanner. Every workflow in this repo declares
	// permissions; finding none means the scanner stopped matching, and a scanner that finds nothing
	// reports a clean bill of health.
	if (permissionEntries === 0) {
		out.push(
			`parsed ${files.length} workflow file(s) and found ZERO \`permissions:\` entries. Every workflow here declares them, ` +
				"so this scanner has stopped matching — fix it rather than trusting the green.",
		);
	}
	// And once more for the service-guard scanner. It is the only one of the three whose subject is
	// RARE — a handful of jobs, not hundreds of steps — so "found none" and "found nothing wrong"
	// are otherwise the same green line, and this repo has shipped that failure repeatedly.
	if (serviceJobs === 0) {
		out.push(
			`parsed ${files.length} workflow file(s) and found ZERO jobs declaring \`services:\`. This repo runs Postgres as a ` +
				"service container in several jobs, so the setup-failure scanner has stopped matching — fix it rather than trusting the green.",
		);
	}
	if (unreadable === files.length) {
		out.push(`none of the ${files.length} workflow files had a \`jobs:\` block this parser could find.`);
	}
	return out;
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
function selfTest() {
	let fails = 0;
	const ok = (name, cond, detail = "") => {
		if (cond) console.log(`ok   - ${name}`);
		else {
			console.error(`FAIL - ${name} ${detail}`);
			fails++;
		}
	};

	// THE EXACT INPUT THAT PRODUCED THIS ISSUE, from feat/badge-honesty.
	const BAD = `name: x
jobs:
  badge:
    runs-on: ubuntu-latest
    steps:
      - name: Compute aggregate Go coverage
        run: node scripts/go-coverage-badge.mjs
      - name: Commit the badge if it changed
      - name: Publish the badge
        run: |
          echo hi
`;
	const bad = scanWorkflow(BAD);
	ok("the known-bad step is found", bad.problems.length === 1, JSON.stringify(bad.problems));

	// ── permissions (#3229's regression, and the class) ───────────────────────────────────────────
	//
	// The negatives first. An unknown scope does not degrade — Actions rejects the WHOLE file, the
	// run completes with ZERO jobs, and nothing goes red: on 2026-08-28 an `administration: read`
	// took workflow-health off the air across dev and three branches, and it was found only because
	// somebody opened that workflow for an unrelated reason.
	const permsOf = (body) => scanPermissions(`name: x\n${body}jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n`);
	// The fixture job carries a `services:` block so the service-guard blindness check below is
	// satisfied — otherwise every `.length === 0` assertion here would be measuring that guard
	// rather than the thing it names.
	const checkOne = (body) =>
		check(
			"wf",
			() => ["w.yml"],
			() => `name: x\n${body}jobs:\n  a:\n    runs-on: ubuntu-latest\n    services:\n      postgres:\n        image: postgres:17-alpine\n    steps:\n      - run: true\n`,
		);

	const REAL = "permissions:\n  contents: read\n  administration: read # the #3229 regression\n  issues: write\n";
	ok("the exact #3229 line is refused", checkOne(REAL).some((p) => /`administration` is not a GITHUB_TOKEN permission scope/.test(p)), JSON.stringify(checkOne(REAL)));
	// A refusal that does not name the consequence reads as pedantry, and this consequence is the
	// entire reason the check exists: the workflow stops running rather than failing.
	ok("...and it names the consequence, not just the rule", checkOne(REAL).some((p) => /zero jobs/.test(p)));
	ok("...and lists the scopes that ARE accepted", checkOne(REAL).some((p) => /pull-requests/.test(p)));

	ok("a near-miss gets a suggestion", checkOne("permissions:\n  content: read\n").some((p) => /Did you mean `contents`\?/.test(p)));
	// And a key that resembles nothing gets no invented suggestion. `administration` → `attestations`
	// would be a confident wrong answer, which is worse than none.
	ok("...and a key resembling nothing is not given a guessed one", !checkOne(REAL).some((p) => /Did you mean/.test(p)));

	ok("a bad LEVEL is refused too", checkOne("permissions:\n  contents: readonly\n").some((p) => /the level must be one of/.test(p)));

	// The positives. A rule that fires on the repo's own workflows is not a check.
	ok("every real scope passes", checkOne("permissions:\n  contents: read\n  id-token: write\n  pull-requests: write\n  security-events: write\n  none-check: none\n".replace("  none-check: none\n", "  checks: none\n")).length === 0);
	ok("a trailing comment does not become part of the level", checkOne("permissions:\n  contents: read # a comment mentioning administration\n").length === 0);
	ok("the read-all shorthand passes", checkOne("permissions: read-all\n").length === 0);
	ok("the write-all shorthand passes", checkOne("permissions: write-all\n").length === 0);
	ok("the empty-mapping shorthand passes", checkOne("permissions: {}\n").length === 0);
	ok("an unknown shorthand is refused", checkOne("permissions: all\n").some((p) => /is not one of/.test(p)));

	// Job-level permissions are the same key at a deeper indent, and are just as fatal.
	const JOBLEVEL = `name: x
jobs:
  a:
    runs-on: ubuntu-latest
    permissions:
      administration: read
    steps:
      - run: true
`;
	ok("a JOB-level bad scope is refused", check("wf", () => ["w.yml"], () => JOBLEVEL).some((p) => /`administration`/.test(p)));

	// The scanner must stop at the end of the mapping, or it swallows the rest of the file and
	// reports every key in the workflow as a bad permission scope.
	ok("the scan stops at the end of the block", permsOf("permissions:\n  contents: read\non:\n  push:\n").length === 1, JSON.stringify(permsOf("permissions:\n  contents: read\non:\n  push:\n")));

	// THE BLINDNESS GUARD, which is what makes a green result mean anything.
	ok(
		"a tree whose permissions cannot be found FAILS rather than passing",
		check("wf", () => ["w.yml"], () => "name: x\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n").some((p) => /ZERO `permissions:` entries/.test(p)),
	);
	ok("...and it is named", bad.problems[0]?.name === "Commit the badge if it changed", JSON.stringify(bad.problems));
	ok("...and its siblings are not", bad.steps === 3, `steps=${bad.steps}`);

	const GOOD = BAD.replace("      - name: Commit the badge if it changed\n", "      - name: Commit the badge if it changed\n        run: git commit -am badge\n");
	ok("the same file with the step fixed is clean", scanWorkflow(GOOD).problems.length === 0, JSON.stringify(scanWorkflow(GOOD).problems));

	// A `uses:` step is as valid as a `run:` one.
	ok("a uses-only step is fine", scanWorkflow(`jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n`).problems.length === 0);
	ok("an inline `- run:` with no name is fine", scanWorkflow(`jobs:\n  a:\n    steps:\n      - run: pnpm i\n`).problems.length === 0);
	ok("a step with with: and uses: is fine",
		scanWorkflow(`jobs:\n  a:\n    steps:\n      - uses: x@v1\n        with:\n          k: v\n`).problems.length === 0);
	// A step whose `if:` comes first still needs an action.
	ok("an if-first step with a run is fine",
		scanWorkflow(`jobs:\n  a:\n    steps:\n      - name: n\n        if: \${{ !cancelled() }}\n        run: x\n`).problems.length === 0);
	ok("...and without one is caught",
		scanWorkflow(`jobs:\n  a:\n    steps:\n      - name: n\n        if: \${{ !cancelled() }}\n`).problems.length === 1);

	// ── a setup failure that a step does not skip (#4084) ────────────────────────────────────────
	//
	// The two cases above only ask whether an if-first step still carries an action. This asks what
	// the `if:` MEANS in a job with `services:`. Those containers start in `Initialize containers`,
	// step ZERO, BEFORE `actions/checkout`: a failed pull skips every real step and leaves an EMPTY
	// workspace, while `cancelled()` stays false — so `!cancelled()` runs the step anyway. In run
	// 33710964528 that made the last line of a failed `UI conformance audit` read
	// `Cannot find module … apps/console/scripts/audit-report.mjs`, accusing the console of a
	// missing script that is present on dev at 173450 bytes.
	const svcJob = (step, services = "    services:\n      postgres:\n        image: postgres:17-alpine\n") =>
		`name: x\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n${services}    steps:\n      - uses: actions/checkout@v7\n${step}`;
	const guardsOf = (step, services) => scanServiceGuards(svcJob(step, services)).problems;

	// The offending step, verbatim from ci.yml's `ui-audit` job as it stood for that run.
	const BARE =
		"      - name: Per-predicate summary of the audit, against the recorded baseline\n" +
		"        if: ${{ !cancelled() }}\n" +
		"        run: node apps/console/scripts/audit-report.mjs\n";
	// A guard written alongside its fix passes for the wrong reason unless the FAILING input is the
	// one that came off the branch. Assert the catch first, then the fix.
	ok("the bare !cancelled() step in a service-bearing job is caught", guardsOf(BARE).length === 1, JSON.stringify(guardsOf(BARE)));
	ok("...and it is named by its `name:`, not by its list item", guardsOf(BARE)[0]?.name === "Per-predicate summary of the audit, against the recorded baseline", JSON.stringify(guardsOf(BARE)));
	ok("...and the job is named too", guardsOf(BARE)[0]?.job === "a");

	const FIXED = BARE.replace("if: ${{ !cancelled() }}", "if: ${{ !cancelled() && steps.setup.outcome == 'success' }}");
	const ALWAYS = BARE.replace("${{ !cancelled() }}", "${{ always() }}");
	const ALWAYS_GATED = BARE.replace("${{ !cancelled() }}", "always() && steps.capture.outcome == 'success'");
	const OUTPUTS = BARE.replace("${{ !cancelled() }}", "always() && steps.gate.outputs.run == 'false'");
	// A mutation that silently failed to apply produces four copies of the same passing case.
	ok("the fixture mutations actually applied", FIXED !== BARE && ALWAYS !== BARE && ALWAYS_GATED !== BARE && OUTPUTS !== BARE);

	ok("the in-repo fix shape (the `guards` job's) is clean", guardsOf(FIXED).length === 0, JSON.stringify(guardsOf(FIXED)));
	// `always()` is the one-word edit that would otherwise silence this check while making the step
	// run on a cancel as well — a cheaper escape route than fixing it.
	ok("a bare always() is caught too", guardsOf(ALWAYS).length === 1, JSON.stringify(guardsOf(ALWAYS)));
	ok("...and e2e-nightly's conjoined always() is clean", guardsOf(ALWAYS_GATED).length === 0, JSON.stringify(guardsOf(ALWAYS_GATED)));
	ok("...and a steps.<id>.outputs test gates it just as well", guardsOf(OUTPUTS).length === 0, JSON.stringify(guardsOf(OUTPUTS)));

	// The scope. A job with no service container has nothing that can fail ahead of checkout, so
	// `!cancelled()` there means exactly what it says and must not be reported.
	ok("the same step in a job with NO services is not reported", guardsOf(BARE, "").length === 0, JSON.stringify(guardsOf(BARE, "")));

	// False-positive directions, each of which a text-only matcher gets wrong.
	ok("a step with no if: at all is not reported", guardsOf("      - run: pnpm test\n").length === 0);
	ok("an unrelated if: is not reported", guardsOf("      - if: github.event_name == 'push'\n        run: x\n").length === 0);
	ok("`always()` inside a run: body is not an if:", guardsOf('      - name: n\n        run: |\n          echo "if: always()"\n').length === 0);
	ok(
		"a `with:` sub-key called name: does not become the step's name",
		guardsOf("      - name: Upload the audit report\n        if: ${{ !cancelled() }}\n        uses: actions/upload-artifact@v7\n        with:\n          name: ui-audit\n")[0]?.name ===
			"Upload the audit report",
	);

	// A folded `if: >-` puts the expression on the FOLLOWING lines; reading only the key's own line
	// would score every one of them as ungated.
	ok(
		"a folded block-scalar if: is read whole",
		guardsOf("      - name: n\n        if: >-\n          !cancelled()\n          && steps.setup.outcome == 'success'\n        run: x\n").length === 0,
		JSON.stringify(guardsOf("      - name: n\n        if: >-\n          !cancelled()\n          && steps.setup.outcome == 'success'\n        run: x\n")),
	);
	ok("...and a folded BARE one is still caught", guardsOf("      - name: n\n        if: >-\n          !cancelled()\n        run: x\n").length === 1);

	// Nothing orders a job's keys, and several jobs here put `services:` after `steps:`.
	ok(
		"a `services:` block declared AFTER `steps:` is still found",
		scanServiceGuards(`name: x\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${BARE}    services:\n      postgres:\n        image: postgres:17-alpine\n`).problems.length === 1,
	);

	// End to end, and the refusal must name the CAUSE — "add a conjunct" without "Initialize
	// containers runs before checkout" is a rule nobody can check themselves.
	const viaCheck = check("wf", () => ["w.yml"], () => svcJob(BARE));
	ok("the bare step is refused through check()", viaCheck.some((p) => /Per-predicate summary of the audit/.test(p) && /declares `services:`/.test(p)), JSON.stringify(viaCheck));
	ok("...and the refusal names the cause", viaCheck.some((p) => /Initialize containers/.test(p) && /BEFORE/.test(p)));
	ok("...and points at the in-repo fix", viaCheck.some((p) => /steps\.<id>\.outcome == 'success'/.test(p)));

	// Blindness, again: this scanner's subject is a handful of jobs rather than hundreds of steps,
	// so "found none" and "found nothing wrong" are otherwise the same green line.
	const noSvc = check("d", () => ["a.yml"], () => "name: x\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: true\n");
	ok("a tree where no job declares services: FAILS rather than passing", noSvc.some((p) => /ZERO jobs declaring `services:`/.test(p)), JSON.stringify(noSvc));

	// Lists that are NOT steps must not be scanned — this is where a naive matcher goes wrong.
	const NOTSTEPS = `on:
  push:
    branches: [main]
    paths:
      - "apps/**"
      - "packages/**"
jobs:
  a:
    strategy:
      matrix:
        include:
          - project: console
          - project: cli
    steps:
      - run: echo hi
`;
	ok("on:/paths: list items are not steps", scanWorkflow(NOTSTEPS).problems.length === 0, JSON.stringify(scanWorkflow(NOTSTEPS).problems));
	ok("...and a matrix include is not a step either", scanWorkflow(NOTSTEPS).steps === 1, `steps=${scanWorkflow(NOTSTEPS).steps}`);

	// Name truncation. The false-positive direction is the one that matters: a `#` inside
	// parentheses is part of the scalar and four correct names in this repo carry one, so a rule
	// that merely looked for `#` would rewrite all four and teach people the check is noise.
	ok(
		"a whitespace-preceded # truncates the name",
		scanNameTruncation("      - name: Worktree lease guard — replays incident #1247\n")[0]?.parsed ===
			"Worktree lease guard — replays incident",
	);
	ok("a # after ( is part of the scalar", scanNameTruncation("      - name: markers still match the prose (#2366)\n").length === 0);
	ok("a single-quoted name is safe", scanNameTruncation("      - name: 'Post the result to #2843'\n").length === 0);
	ok("a double-quoted name is safe", scanNameTruncation('      - name: "Post the result to #2843"\n').length === 0);
	ok("a name with no # is not reported", scanNameTruncation("      - name: Run the guards\n").length === 0);
	ok("a job-level name is scanned too", scanNameTruncation("    name: Authz guards for #1\n").length === 1);
	ok(
		"the real ci.yml name is reported when unquoted, through check()",
		check("d", () => ["a.yml"], () => "jobs:\n  a:\n    steps:\n      - name: replays incident #1247\n        run: true\n").some((p) =>
			/silently truncated by YAML/.test(p),
		),
	);
	ok(
		"...and not when quoted",
		!check("d", () => ["a.yml"], () => "jobs:\n  a:\n    steps:\n      - name: 'replays incident #1247'\n        run: true\n").some((p) =>
			/silently truncated by YAML/.test(p),
		),
	);

	// Blindness. Each of these would otherwise be a clean report.
	ok("a file with no jobs: block is unreadable, not clean", scanWorkflow("name: x\non: push\n").readable === false);
	const noDir = check("nope", () => { throw new Error("ENOENT"); });
	ok("an unreadable directory fails", /cannot run, which is not the same as passing/.test(noDir[0] ?? ""), JSON.stringify(noDir));
	const empty = check("d", () => []);
	ok("an empty directory fails", /no workflow files found/.test(empty[0] ?? ""), JSON.stringify(empty));
	const noSteps = check("d", () => ["a.yml"], () => "jobs:\n  a:\n    runs-on: x\n");
	ok("finding zero steps across every file fails", noSteps.some((p) => /found ZERO steps/.test(p)), JSON.stringify(noSteps));

	if (fails > 0) {
		console.error(`\ncheck-workflow-shape self-test: ${fails} failure(s)`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────
if (process.argv.includes("--self-test")) {
	selfTest();
} else {
	const problems = check();
	for (const p of problems) console.error(`::error::workflow-shape: ${p}`);
	if (problems.length > 0) {
		console.error(
			`\n${problems.length} problem(s). Each is a workflow that does not mean what it says: either Actions rejects the file ` +
				"outright — zero jobs, an empty rollup, nothing red — or a step runs past a failed `Initialize containers` and reports " +
				"a cause that was never true.",
		);
		process.exit(1);
	}
	const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
	let steps = 0;
	let perms = 0;
	let svcJobs = 0;
	for (const f of files) {
		const text = fs.readFileSync(path.join(DIR, f), "utf8");
		steps += scanWorkflow(text).steps;
		perms += scanPermissions(text).length;
		svcJobs += scanServiceGuards(text).serviceJobs;
	}
	// The counts are printed because a green line that names no quantity is indistinguishable from a
	// green line produced by a scanner that matched nothing.
	console.log(
		`workflow-shape: ${files.length} workflow(s), ${steps} steps, every one carrying a \`run:\` or \`uses:\`; ` +
			`${perms} permission entr(ies), every scope and level one Actions accepts; ` +
			`${svcJobs} job(s) with \`services:\`, none of them running a step past a failed \`Initialize containers\`; ` +
			"no `name:` losing text to an unquoted `#`",
	);
}
