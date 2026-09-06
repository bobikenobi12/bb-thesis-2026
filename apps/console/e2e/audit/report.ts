// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One verdict record per (route, predicate), written to `test-results/ui-audit*.json`.
//
// The scoreboard generator does not exist yet (`apps/console/docs/ui-conformance/RUBRIC.md` says
// so, in the future tense, on purpose). This file is the shape it will read, and it enforces the
// rubric's N/A rules at the point a verdict is recorded rather than at the point one is reported:
//
//   · every N/A carries a machine-readable reason from the predicate's DECLARED set — a reason
//     outside that set is an ERROR, not an N/A;
//   · N/A is counted per predicate as a first-class number, because a predicate whose N/A count
//     grows is a predicate being escaped, and the rubric's whole warning is that escaping one makes
//     a page's score go UP with nothing red anywhere;
//   · a predicate whose POSITIVE CONTROL is red publishes NOT MEASURED and nothing else. Before
//     #3804 the audit emitted R3 FAILs for real routes in the same run in which R3's own control
//     was failing — a verdict from an instrument already known to be broken. `withhold()` makes
//     that impossible at the recorder rather than asking every call site to remember.
//
// EACH SPEC OWNS ITS OWN BUFFER. This started as one module-level array, which is a bug the moment
// two specs share a worker — and `playwright.config.ts` sets `workers: 1` in CI, so all three audit
// specs load into one process and one module instance. Playwright runs files in sorted order, so
// `permissions.spec` recorded ~35 T7 verdicts, then `routes.spec` appended 360 of its own to the
// SAME array and wrote all 395 into `ui-audit.json` — the primary scoreboard silently gaining a T7
// column measured in a different organisation, and every T7 verdict reported twice across the two
// files. A report that says something it did not measure is the exact failure this header argues
// against, so the buffer is per-`createReport()` and the module holds no state at all.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A verdict, plus the thing that is neither a verdict nor an escape.
 *
 * `NOT MEASURED` is what a predicate reports when its own POSITIVE CONTROL is red. It is not a
 * PASS (nothing was proven), it is not a FAIL (nothing was found), and it is emphatically not an
 * N/A — an N/A says "this predicate does not apply to this page", which is a claim about the page.
 * This is a claim about the instrument. Keeping it separate is the point: a withheld predicate must
 * not be able to disappear into any column that already exists.
 */
export type Verdict = "PASS" | "FAIL" | "N/A" | "NOT MEASURED";

/**
 * The live predicates this project owns, and the N/A reasons each one may use.
 *
 * Copied from the rubric's own per-predicate "N/A when" column, EXACTLY — including the three that
 * declare no reason at all. R5, R6 and R7 are "never N/A" there, and that is honoured even for the
 * four redirect-only routes: hitting one of those URLs is a navigation a person really makes, so
 * the console errors it produces, the responses it fires and the time it takes to land are all real
 * and all measurable. What is NOT measurable on them is geometry (R1/R3/R4) and the states
 * (T5/T6/T7), and each of those declares its own reason below.
 *
 * A reason that is not in a predicate's list is an ERROR, not an N/A — `record()` enforces it.
 */
export const NA_REASONS = {
	R1: ["redirect-only"],
	R2: ["opens-no-overlay"],
	R3: ["redirect-only"],
	R4: ["redirect-only"],
	R5: [],
	R6: [],
	R7: [],
	T5: ["no-empty-state"],
	T6: ["redirect-only"],
	T7: ["no-restricted-surface"],
} as const;

export type PredicateId = keyof typeof NA_REASONS;

export interface VerdictRecord {
	route: string;
	url: string;
	predicate: PredicateId;
	verdict: Verdict;
	/** Required for N/A (from the predicate's declared set) and for NOT MEASURED; forbidden otherwise. */
	reason?: string;
	/** Whatever the measurement saw — the diagnostic a reader acts on. */
	evidence?: unknown;
}

export interface PredicateTally {
	pass: number;
	fail: number;
	na: number;
	/** Verdicts withheld because the predicate's positive control was red. Never folded into `na`. */
	notMeasured: number;
	score: number | null;
}

/** One spec's verdicts. Created per spec so two specs sharing a worker cannot pool their records. */
export interface Report {
	/**
	 * Record one verdict.
	 *
	 * Raises on an N/A with no reason, on an N/A whose reason the predicate has not declared, and
	 * on a PASS/FAIL carrying one — the three ways the rubric says a rubric goes wrong.
	 */
	record(entry: VerdictRecord): VerdictRecord;
	/**
	 * Refuse to score `predicates` for the rest of the run: every later `record()` for one of them
	 * is rewritten to `NOT MEASURED` carrying `why`, whatever verdict the caller computed.
	 *
	 * Rewriting at the recorder rather than at each call site is deliberate. `routes.spec.ts`
	 * records ten verdicts per route from seven places; a gate spelled out at each of them is a
	 * gate that will be missed by the eleventh. This way a caller CANNOT publish a verdict for a
	 * predicate whose instrument is known to be broken, even by forgetting.
	 */
	withhold(predicates: readonly PredicateId[], why: string): void;
	/** The predicates currently withheld, and why. */
	withheld(): ReadonlyMap<PredicateId, string>;
	/** Everything recorded so far. */
	all(): readonly VerdictRecord[];
	/**
	 * PASS ÷ (PASS + FAIL) per predicate, plus the N/A count the rubric wants as its own column and
	 * the NOT MEASURED count. A predicate scored from nothing scores `null`, never 1.
	 */
	summarise(over?: readonly VerdictRecord[]): Record<string, PredicateTally>;
	/**
	 * Write these records where a scoreboard generator (and a CI artifact) can read them.
	 *
	 * MERGES with what is already in `filename` when `runKey` matches. Playwright discards a worker
	 * after a test times out and starts the next test in a fresh one, and each worker holds its own
	 * `Report` — so a plain overwrite would hand the reader the LAST worker's records and silently
	 * drop everything measured before the restart. The key is the run's org slug (a new org per
	 * run), so a file left over from a previous run is replaced rather than merged into.
	 */
	write(runKey: string, filename?: string, outDir?: string): string;
}

/** A fresh, isolated verdict buffer. */
export function createReport(): Report {
	const records: VerdictRecord[] = [];
	const withheldPredicates = new Map<PredicateId, string>();

	const summarise = (over: readonly VerdictRecord[] = records): Record<string, PredicateTally> => {
		const out: Record<string, PredicateTally> = {};
		for (const r of over) {
			const row = (out[r.predicate] ??= { pass: 0, fail: 0, na: 0, notMeasured: 0, score: null });
			if (r.verdict === "PASS") row.pass++;
			else if (r.verdict === "FAIL") row.fail++;
			else if (r.verdict === "NOT MEASURED") row.notMeasured++;
			else row.na++;
		}
		for (const row of Object.values(out)) {
			const denom = row.pass + row.fail;
			row.score = denom === 0 ? null : row.pass / denom;
		}
		return out;
	};

	return {
		record(entry) {
			// The gate comes FIRST, before the N/A rules: a withheld predicate publishes nothing,
			// including a well-formed N/A. What the caller computed is dropped on purpose — it was
			// computed by an instrument that has been shown not to work.
			const why = withheldPredicates.get(entry.predicate);
			if (why !== undefined) {
				const withheldEntry: VerdictRecord = {
					route: entry.route,
					url: entry.url,
					predicate: entry.predicate,
					verdict: "NOT MEASURED",
					reason: why,
					evidence: entry.evidence,
				};
				records.push(withheldEntry);
				return withheldEntry;
			}
			if (entry.verdict === "NOT MEASURED") {
				throw new Error(
					`${entry.predicate} on ${entry.route}: NOT MEASURED is the recorder's to write, not a ` +
						`caller's. Call withhold() with the control failure that justifies it.`,
				);
			}
			const allowed: readonly string[] = NA_REASONS[entry.predicate];
			if (entry.verdict === "N/A") {
				if (!entry.reason) {
					throw new Error(`${entry.predicate} on ${entry.route}: an N/A with no reason is not an N/A.`);
				}
				if (!allowed.includes(entry.reason)) {
					const declared = allowed.length ? allowed.join(", ") : "none — this predicate is never N/A";
					throw new Error(
						`${entry.predicate} on ${entry.route}: "${entry.reason}" is not a declared N/A reason ` +
							`for ${entry.predicate} (declared: ${declared}). Change the rubric, or the verdict — ` +
							`not the reason.`,
					);
				}
			} else if (entry.reason) {
				throw new Error(
					`${entry.predicate} on ${entry.route}: a ${entry.verdict} must not carry an N/A reason.`,
				);
			}
			records.push(entry);
			return entry;
		},
		withhold(predicates, why) {
			if (!why.trim()) {
				throw new Error("withhold() without a reason is indistinguishable from not scoring at all.");
			}
			for (const predicate of predicates) withheldPredicates.set(predicate, why);
		},
		withheld: () => withheldPredicates,
		all: () => records,
		summarise,
		write(runKey, filename = "ui-audit.json", outDir = path.join(process.cwd(), "test-results")) {
			mkdirSync(outDir, { recursive: true });
			const file = path.join(outDir, filename);
			let carried: VerdictRecord[] = [];
			if (existsSync(file)) {
				const prior: unknown = JSON.parse(readFileSync(file, "utf8"));
				if (
					typeof prior === "object" &&
					prior !== null &&
					"runKey" in prior &&
					prior.runKey === runKey &&
					"records" in prior &&
					Array.isArray(prior.records)
				) {
					carried = prior.records;
				}
			}
			// This worker's verdict wins for a (route, predicate) it measured; anything it did not
			// measure is carried forward from the worker that did.
			const merged = new Map<string, VerdictRecord>();
			for (const r of [...carried, ...records]) merged.set(`${r.route} ${r.predicate}`, r);
			const all = [...merged.values()];
			writeFileSync(
				file,
				`${JSON.stringify(
					{ runKey, generatedAt: new Date().toISOString(), summary: summarise(all), records: all },
					null,
					2,
				)}\n`,
			);
			return file;
		},
	};
}
