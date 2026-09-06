// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// R5 (axe), R6 (console + network) and R7 (interactive budget) — the three predicates that come
// from instrumenting the page rather than measuring its geometry.
//
// All three REUSE the existing helpers (`helpers/a11y.ts`, `helpers/console-errors.ts`,
// `helpers/perf.ts`) rather than growing a second copy. Where a helper's behaviour is wrong for a
// GATE — as opposed to wrong for the QA report it was written for — this file says so out loud and
// closes the gap here, because those helpers are shared with suites that are not gates.

import type { Page } from "@playwright/test";
import { scanA11y, type A11yViolation } from "../helpers/a11y";
import { attachConsoleGuard, type CapturedError, type ConsoleGuard } from "../helpers/console-errors";
import { attachPerf, type PerfCollector, type PerfRecord } from "../helpers/perf";

/**
 * R5's precondition: axe must actually be there.
 *
 * `helpers/a11y.ts` returns `[]` when `@axe-core/playwright` cannot be imported — deliberately, so
 * the QA suite still runs without it. For a GATE that is the worst possible behaviour: a silent
 * empty result is indistinguishable from a clean page, so every route would score R5 PASS on the
 * strength of the scanner being absent. The helper is outside this unit's scope, so the raise lives
 * here: the audit refuses to start unless the import resolves.
 *
 * Called once per run, from the audit's `beforeAll`, so the run dies at the top rather than 40
 * routes later.
 */
export async function requireAxe(): Promise<void> {
	try {
		const mod = await import("@axe-core/playwright");
		if (typeof mod.default !== "function") {
			throw new Error("@axe-core/playwright resolved but exports no default AxeBuilder");
		}
	} catch (err) {
		throw new Error(
			"R5 cannot be measured: @axe-core/playwright did not import, so `scanA11y()` would return " +
				"[] and EVERY route would score a clean a11y pass on the strength of the scanner being " +
				"missing. Install it (apps/console devDependency) before running the audit.\n  cause: " +
				String(err),
		);
	}
}

/** R5 — serious/critical axe violations at wcag2a/wcag2aa, via the shared helper. */
export async function scanRoute(page: Page): Promise<A11yViolation[]> {
	return scanA11y(page);
}

export interface RouteSignals {
	guard: ConsoleGuard;
	perf: PerfCollector;
	/** Console errors the SHARED helper's dev-noise allowlist suppresses but a gate must not. */
	suppressedButReal: CapturedError[];
}

/**
 * Attach R6 + R7 instrumentation to a page, for the lifetime of that page.
 *
 * `attachConsoleGuard` carries an ALLOWLIST of dev-mode noise — including `/hydration/i` and
 * `validateDOMNesting`. That is a reasonable default for the QA report it was written for, and
 * wrong for THIS gate: the CI job drives a BUILT console, where a hydration mismatch is a shipped
 * defect and not a warning a developer sees and dismisses. So the guard is reused for capture, and
 * one extra listener re-captures exactly the classes it drops that this run must not treat as
 * noise. It is not a second console guard — it never grows past this list, and the list is here so
 * the next reader can see what it is compensating for.
 *
 * (A sandbox environment serves the console from a development server, so those classes really can
 * be noise there. They are still reported: a finding a reader can dismiss beats one nobody is shown.)
 */
export function attachSignals(page: Page): RouteSignals {
	const guard = attachConsoleGuard(page);
	const perf = attachPerf(page);
	const suppressedButReal: CapturedError[] = [];
	const REAL_IN_PRODUCTION = [/hydration/i, /validateDOMNesting/i];
	const capture = (text: string, kind: CapturedError["kind"]) => {
		if (!REAL_IN_PRODUCTION.some((re) => re.test(text))) return;
		// ONLY WHAT THE GUARD ACTUALLY DROPPED. These patterns are deliberately broader than the
		// guard's — its entry is `/Warning: .*validateDOMNesting/i`, and React 19 logs most of those
		// without the `Warning: ` prefix — so a message the guard already captured would be counted
		// a second time here, appearing twice in the R6 evidence and inflating the failure count.
		// Mirroring the guard's exact regexes would be a copy that decays; asking what it captured
		// is the same question, answered by the emitter.
		if (guard.errors.some((e) => e.text === text)) return;
		suppressedButReal.push({ kind, text, at: new Date().toISOString() });
	};
	page.on("console", (msg) => {
		if (msg.type() === "error") capture(msg.text(), "console");
	});
	page.on("pageerror", (err) => capture(err.message ?? String(err), "pageerror"));
	return { guard, perf, suppressedButReal };
}

/** Everything R6 counts against a route: console errors, page errors, and responses >= 400. */
export function r6Failures(signals: RouteSignals): CapturedError[] {
	return [...signals.guard.errors, ...signals.suppressedButReal];
}

/**
 * R7 — nearest-rank p95 of the route's interactive times.
 *
 * NOTHING IS HIDDEN BY THE STATISTIC. A route is loaded once per viewport width and the first load
 * is excluded as a warm-up (see routes.spec.ts), so n = 3 and the nearest-rank p95
 * (`ceil(0.95 · 3)` = 3) is the SLOWEST of the three. That is said here rather than left for a
 * reader to work out, because a "p95" over three samples that quietly reported the median would let
 * the worst viewport regress without moving the number.
 */
export function p95(samples: number[]): number {
	if (samples.length === 0) return Number.NaN;
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
}

/**
 * The budget a route's p95 interactive time must come in under.
 *
 * ONE default rather than a per-route table, deliberately: a hand-written per-route budget list is
 * a subject list that decays — a route added later gets no entry and no gate. The default is a
 * CEILING that catches a pathological regression (a page that went from ~1s to ~8s), not a
 * performance target; the scoreboard records the measured p95 per route so the ratchet, when it
 * lands, tightens from real numbers rather than from a guess made today.
 *
 * `AUDIT_R7_BUDGET_MS` overrides it for a slow or contended machine.
 */
export const R7_BUDGET_MS = Number(process.env.AUDIT_R7_BUDGET_MS ?? 8_000);

/** Navigation records perf.ts collected for one path — the request-level evidence behind R7. */
export function navigationsFor(perf: PerfCollector, sincePathPrefix: string): PerfRecord[] {
	return perf.records.filter((r) => r.kind === "navigation" && r.path.startsWith(sincePathPrefix));
}
