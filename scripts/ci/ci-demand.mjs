// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ci-demand — how much CI this repo ASKS FOR, and how long it waits to get it.
//
// ── WHY THIS EXISTS ──
//
// CI was the throughput ceiling for about two months and nobody could say why, because the two
// numbers that answer it were never being taken. Measured 2026-09-03 over 500 runs / 6h24m and
// 1,396 jobs:
//
//   job execution   1,802 minutes   median  1.9 min
//   job WAITING     5,376 minutes   median 17.7 min
//
// Three quarters of CI wall-clock is waiting for a runner. So the currency is **runner slots
// REQUESTED, not minutes consumed** — a five-second job that waits twenty minutes holds a slot for
// twenty minutes, and a workflow that costs nothing to run still costs a slot to schedule. Every
// intuition built on "minutes" prices this repo's CI wrongly.
//
// The composition of that demand, same sample:
//
//   feature-branch PRs        236  47%   the real work
//   Mergify speculative       148  29%
//   promotion PR (head=dev)   112  22%   re-validating a promotion nobody was promoting
//   cancelled, of all runs     77  15%   started, took a slot, thrown away
//
// ── THE ONE NUMBER, AND TWO WRONG ONES I TRIED FIRST ──
//
// `rootWaits` — for every job that was READY THE MOMENT THE RUN WAS CREATED, how long it waited for
// a runner. Pooled across the sample, its percentiles are the capacity signal.
//
// "Ready at creation" is derived structurally, not from a list of job names: a job with `needs:` is
// created when its DEPENDENCY FINISHES, so root jobs are exactly those sharing the run's earliest
// `created_at`. A hard-coded list of "jobs with no `needs:`" would be a copy of ci.yml that goes
// stale silently, and this file would then report a confident number about the wrong set.
//
// TWO EARLIER DEFINITIONS WERE WRONG, and the real data caught both — recorded because each looked
// obviously right and each reported a HEALTHY repo:
//
//   1. "min wait across all jobs in the run" → reported 0.0 min against a measured 15-minute
//      median. A dependent job is created late and starts at once, so its ~0 wait dominated the
//      minimum. `created_at` does not mean the same thing for every job in a run.
//   2. "min wait across ROOT jobs" → still 0.0. GitHub grants SOME runners immediately and rations
//      the rest, so every run has one root job that started instantly while its siblings waited
//      15-36 minutes. Time-to-FIRST-runner is not the constraint; time-to-ENOUGH-runners is.
//
// Hence pooling every root job's wait, plus `runFullyDispatched` — the MAX root wait per run, which
// is when the run actually became useful. A run is not running because one job of twenty is.
//
// On 2026-09-03 the pooled distribution was bimodal: a third of root jobs started within seconds,
// the rest waited 4-36 minutes. Bimodal is the signature of demand-driven throttling — the pool is
// not slow, it is rationed, and the ration improves when total demand falls. That is the whole
// theory of the cuts this instrument exists to check.
//
// ── WHAT IT REFUSES TO DO ──
//
// Report a clean number from no data. An empty sample, or one with no timing at all, EXITS
// NON-ZERO. This repo's dominant defect is a guard whose "nothing found" branch is indistinguishable
// from "nothing wrong", and an instrument built to measure that class must not join it.
//
//   node scripts/ci/ci-demand.mjs --input runs-with-jobs.json
//   node scripts/ci/ci-demand.mjs --self-test
//
// The input is a JSON array of {id, name, event, head_branch, conclusion, created_at, jobs:[…]}.
// `.github/workflows/workflow-health.yml` collects it; keeping fetch out of this file is what makes
// the classifier testable without a network.

/** Where a run came from. The buckets are the levers — each one is fixed differently. */
export function origin(run) {
	const head = run.head_branch ?? "";
	if (run.event === "merge_group") return "speculative";
	if (run.event === "pull_request" || run.event === "pull_request_target") return "feature";
	if (run.event === "push" && head.startsWith("mergify/merge-queue/")) return "speculative";
	// A promotion PR's head IS an integration branch, so every merge into it re-fires the PR's
	// whole workflow set against a diff that matches nearly every path filter. That is how one
	// open PR became 22% of all CI.
	if (head === "dev" || head === "staging") return "promotion-pr";
	if (head === "main") return "main";
	return "feature";
}

/**
 * Wait, in seconds, for each job that was ready the moment the run was created — [] when the run
 * has no job that ever started (queued, cancelled before dispatch, or a fixture with no timings).
 *
 * An empty array is not a zero wait and must never be averaged as one: a run that never got a
 * runner is the worst case, not the best, and folding it in as 0 makes a starved sample read as an
 * instant one.
 */
export function rootWaits(run) {
	const timed = (run.jobs ?? []).filter((j) => j.created_at && j.started_at);
	if (timed.length === 0) return [];
	const earliest = Math.min(...timed.map((j) => Date.parse(j.created_at)));
	return timed
		// One second of slack: jobs created with the run carry the same timestamp, but equality on
		// a wire format is a brittle thing to hang a metric on.
		.filter((j) => Date.parse(j.created_at) <= earliest + 1000)
		.map((j) => (Date.parse(j.started_at) - Date.parse(j.created_at)) / 1000)
		.filter((s) => Number.isFinite(s) && s >= 0);
}

/**
 * When the run actually became useful: the LAST of its ready jobs to get a runner, in seconds.
 *
 * The max, not the min — a twenty-job run with one job running is not running. This is the number
 * a person waiting on CI experiences.
 */
export function runFullyDispatched(run) {
	const w = rootWaits(run);
	return w.length === 0 ? null : Math.max(...w);
}

/** @param {number[]} xs @param {number} q */
export function percentile(xs, q) {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(Math.floor(s.length * q), s.length - 1)];
}

/**
 * Summarise a sample. THROWS on an empty or untimed sample rather than returning zeros.
 * @param {Array<object>} runs
 */
export function summarise(runs) {
	if (!Array.isArray(runs) || runs.length === 0) {
		throw new Error(
			"ci-demand: the sample is empty. That is a collection failure, not a quiet repo — " +
				"refusing to report a demand of zero.",
		);
	}
	const byOrigin = {};
	for (const r of runs) byOrigin[origin(r)] = (byOrigin[origin(r)] ?? 0) + 1;

	// Pooled across the sample: every job that was ready when its run was created.
	const waits = runs.flatMap(rootWaits);
	const dispatched = runs.map(runFullyDispatched).filter((w) => w !== null);
	if (waits.length === 0) {
		throw new Error(
			`ci-demand: ${runs.length} run(s) and not one job with both created_at and started_at. ` +
				"The wait cannot be computed, and reporting the composition alone would read as a " +
				"clean bill of health for the number that actually matters.",
		);
	}
	const cancelled = runs.filter((r) => r.conclusion === "cancelled").length;
	return {
		runs: runs.length,
		byOrigin,
		cancelledPct: Math.round((cancelled * 100) / runs.length),
		// Runs with no timing at all. Reported, never folded into the wait as a zero.
		neverDispatched: runs.length - dispatched.length,
		rootJobs: waits.length,
		waitSeconds: {
			median: percentile(waits, 0.5),
			p90: percentile(waits, 0.9),
			max: Math.max(...waits),
			// The bimodality, made visible. A reader can otherwise not tell "most jobs start at
			// once" from "the median happens to land low", and on this repo those are the two
			// halves of the same distribution.
			instantPct: Math.round((waits.filter((w) => w <= 5).length * 100) / waits.length),
		},
		fullyDispatchedSeconds: {
			median: percentile(dispatched, 0.5),
			p90: percentile(dispatched, 0.9),
		},
	};
}

/** Render for a step summary / issue body. */
export function render(s) {
	const o = Object.entries(s.byOrigin).sort((a, b) => b[1] - a[1]);
	const lines = [
		`**${s.runs} runs** · ${s.cancelledPct}% cancelled · ${s.neverDispatched} never got a runner`,
		"",
		"| origin | runs | share |",
		"|---|---:|---:|",
		...o.map(([k, v]) => `| ${k} | ${v} | ${Math.round((v * 100) / s.runs)}% |`),
		"",
		`**Runner wait**, across ${s.rootJobs} jobs that were ready when their run was created — the capacity signal:`,
		"",
		`- median **${(s.waitSeconds.median / 60).toFixed(1)} min** · p90 ${(s.waitSeconds.p90 / 60).toFixed(1)} min · max ${(s.waitSeconds.max / 60).toFixed(1)} min`,
		`- ${s.waitSeconds.instantPct}% got a runner within 5s — the rest are the ration`,
		`- a run had all its ready jobs running after **${(s.fullyDispatchedSeconds.median / 60).toFixed(1)} min** median · ${(s.fullyDispatchedSeconds.p90 / 60).toFixed(1)} min p90`,
	];
	return lines.join("\n");
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
function selfTest() {
	let fails = 0;
	const ok = (name, cond, detail = "") => {
		if (cond === true) console.log(`ok   - ${name}`);
		else { console.error(`FAIL - ${name} ${typeof cond === "string" ? cond : detail}`); fails++; }
	};
	const raises = (name, fn, needle) => {
		try { fn(); console.error(`FAIL - ${name} (did not throw)`); fails++; }
		catch (e) { ok(name, String(e.message).includes(needle), `message was: ${e.message}`); }
	};
	const run = (head, jobs, extra = {}) => ({ head_branch: head, jobs, ...extra });
	const job = (created, started) => ({ created_at: created, started_at: started });

	ok("a merge-group run is speculative", origin(run("mergify/merge-queue/abc", [], { event: "merge_group" })) === "speculative");
	ok("...a promotion PR's head is an integration branch", origin(run("dev", [])) === "promotion-pr" && origin(run("staging", [])) === "promotion-pr");
	ok("...and anything else is feature work", origin(run("feat/x", [])) === "feature");

	// ⭐ THE DEFECT THAT SHIPPED TWICE, pinned. A job with `needs:` is created when its DEPENDENCY
	// finishes, so it starts at once and its ~0 wait says nothing about runner availability. Both
	// earlier definitions of this metric were dominated by exactly this and reported 0.0 min
	// against a measured 15-minute median.
	ok(
		"a job created LATE (it was waiting on a dependency) is not counted as a fast dispatch",
		JSON.stringify(
			rootWaits(run("f", [
				job("2026-01-01T00:00:00Z", "2026-01-01T00:20:00Z"), // root: waited 20 min
				job("2026-01-01T00:20:00Z", "2026-01-01T00:20:01Z"), // dependent: created late
			])),
		) === "[1200]",
	);
	ok(
		"...and every job created WITH the run is counted, not just the luckiest one",
		JSON.stringify(
			rootWaits(run("f", [
				job("2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z"),
				job("2026-01-01T00:00:00Z", "2026-01-01T00:30:00Z"),
			])),
		) === "[1,1800]",
	);
	// GitHub grants SOME runners at once and rations the rest, so a run with one job running is not
	// running. The max is what a person waiting on CI actually experiences.
	ok(
		"a run is fully dispatched only when its LAST ready job has a runner",
		runFullyDispatched(run("f", [
			job("2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z"),
			job("2026-01-01T00:00:00Z", "2026-01-01T00:30:00Z"),
		])) === 1800,
	);
	// A run nobody ever gave a runner to is the WORST case. Counting it as 0 would make a starved
	// sample read as an instant one — the exact inversion this file is written to prevent.
	ok("a run with no started job yields no wait, never a 0", JSON.stringify(rootWaits(run("f", [{ created_at: "x" }]))) === "[]");
	ok("...and an empty job list too", runFullyDispatched(run("f", [])) === null);

	const sample = [
		run("feat/a", [job("2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z")]),
		run("dev", [job("2026-01-01T00:00:00Z", "2026-01-01T00:10:00Z")]),
		run("mergify/merge-queue/z", [job("2026-01-01T00:00:00Z", "2026-01-01T00:30:00Z")], { event: "merge_group" }),
		run("feat/b", [], { conclusion: "cancelled" }),
	];
	const s = summarise(sample);
	ok("composition is counted per origin", s.byOrigin.feature === 2 && s.byOrigin["promotion-pr"] === 1 && s.byOrigin.speculative === 1);
	ok("...cancelled share is of ALL runs", s.cancelledPct === 25);
	ok("...and a run that never got a runner is reported, not dropped silently", s.neverDispatched === 1);
	ok("the median wait ignores the never-dispatched run rather than scoring it 0", s.waitSeconds.median === 600);
	ok("...and `instantPct` separates 'started at once' from 'median happens to be low'", s.waitSeconds.instantPct === 33);

	// THE REFUSALS. Both are states that would otherwise render as a healthy repo.
	raises("an EMPTY sample raises rather than reporting zero demand", () => summarise([]), "the sample is empty");
	raises(
		"...and a sample with no timings raises rather than reporting composition alone",
		() => summarise([run("feat/a", [{ created_at: "2026-01-01T00:00:00Z" }])]),
		"not one job with both created_at and started_at",
	);

	ok("render names the capacity signal", render(s).includes("Runner wait"));

	if (fails > 0) { console.error(`\nci-demand self-test: ${fails} failure(s)`); process.exit(1); }
	console.log("\nself-test: all passed");
}

if (process.argv.includes("--self-test")) {
	selfTest();
} else {
	const i = process.argv.indexOf("--input");
	if (i === -1 || !process.argv[i + 1]) {
		console.error("usage: ci-demand.mjs --input <runs-with-jobs.json> | --self-test");
		process.exit(2);
	}
	const { readFileSync } = await import("node:fs");
	console.log(render(summarise(JSON.parse(readFileSync(process.argv[i + 1], "utf8")))));
}
