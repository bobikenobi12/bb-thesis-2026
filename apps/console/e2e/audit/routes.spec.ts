// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The live half of the console UI conformance rubric: R1–R7 plus T5 and T6, driven against every
// route `scripts/lib/console-routes.mjs` reports.
//
// Two passes, in this order, and the order is the point:
//
//   1. **the empty-org pass** — every route that needs nothing but `[org]`, against the org exactly
//      as onboarding left it. T5 ("the empty state renders through `EmptyState`") has no other
//      moment: once anything has been written, a list page renders rows and cannot answer it. This
//      is what `pnpm env:up --empty` is for.
//   2. **the parameterised pass** — one project, one job, one support case are written, and the
//      routes carrying `[project]` / `[id]` are audited against real rows. A route visited with an
//      id that does not exist renders a not-found, and every predicate would then be measured
//      against a page nobody asked about.
//
// The `audit` project sets `fullyParallel: false`, which is what makes "in this order" true rather
// than hoped-for: tests in one file run in declaration order in one worker.

import { expect, test, type Page } from "@playwright/test";
import {
	materialize,
	needsOnlyOrg,
	resolveOrgSlug,
	resolveOwner,
	restoreContext,
	saveContext,
	seedRouteFixtures,
	type AuditContext,
} from "./context";
import { loadWithInjectedFault, rendersSharedErrorState, type FaultResult } from "./error-state";
import { consoleRoutes, type RouteRecord } from "./manifest";
import {
	AUDIT_VIEWPORT_HEIGHT,
	measurePage,
	measurementControl,
	R1_WIDTHS,
	type ControlResult,
	type PageMeasurement,
} from "./predicates";
import { describeOverlayMisses, probeOverlays } from "./overlays";
import { createReport, type PredicateId } from "./report";
import {
	attachSignals,
	navigationsFor,
	p95,
	r6Failures,
	R7_BUDGET_MS,
	requireAxe,
	scanRoute,
} from "./signals";
import { closeDb } from "../helpers/db";
import { STORAGE_STATE } from "../fixtures/auth";

const manifest = consoleRoutes();
const ctx: AuditContext = { orgSlug: "", owner: { userId: "", orgId: "" } };
// This spec's OWN verdict buffer. In CI every audit spec loads into one worker, so a module-level
// buffer would pool `permissions.spec`'s T7 verdicts into this file's report — see report.ts.
const report = createReport();
const record = report.record;
/** What the rendered predicates' positive control said, read by the first test in the file. */
let control: ControlResult = { broken: [], lines: [] };

test.beforeAll(async ({ browser }, testInfo) => {
	// R5's scanner must be REAL before a single route is scored. `helpers/a11y.ts` answers `[]` when
	// axe cannot be imported, and an empty result is indistinguishable from a clean page — so every
	// route would score a11y-clean on the strength of the scanner being missing.
	await requireAxe();
	// `browser.newContext()` does NOT inherit the project's `use`, so the baseURL has to be handed
	// over explicitly. Taken from the resolved project options rather than re-read from the
	// environment: a second reading of E2E_BASE_URL is a second definition of "where the console is".
	const context = await browser.newContext({
		baseURL: testInfo.project.use.baseURL,
		storageState: STORAGE_STATE,
	});
	const page = await context.newPage();
	try {
		// R1, R3, R4 and T5 next, and for the same reason: the instrument BEFORE the tree.
		// `measurementControl` drives each of them against a page that violates it and a page that
		// does not, and names the ones that no longer answer. Anything it names is withheld for the
		// whole run — those routes report NOT MEASURED rather than a verdict.
		//
		// This runs before `resolveOrgSlug` navigates, on this throwaway context's page, because the
		// control replaces the document with its own fixtures.
		//
		// WHAT THIS DOES NOT COVER, stated rather than implied: R2, R5, R6, R7 and T6 are not
		// measured by `measurePage` and are not gated here. R5 has its own instrument check one line
		// above (`requireAxe`), T6 has one at the bottom of this file (a 404 must still be recognised
		// as the shared ErrorState), and R2/R6/R7 have no control yet — their self-tests are still
		// only tests. Those are gaps, not exemptions.
		control = await measurementControl(page);
		if (control.broken.length > 0) {
			report.withhold(control.broken, `positive control failed: ${control.lines.join("; ")}`);
			console.error(
				`ui-audit: THE POSITIVE CONTROL IS BROKEN for ${control.broken.join(", ")} — refusing to ` +
					`score ${control.broken.join("/")} on any route.\n  ${control.lines.join("\n  ")}`,
			);
		}
		ctx.orgSlug = await resolveOrgSlug(page);
		ctx.owner = await resolveOwner(ctx.orgSlug);
		// A worker that started AFTER the seeding step picks the ids back up here; a worker that
		// started before it finds nothing and carries on.
		restoreContext(ctx);
	} finally {
		await context.close();
	}
});

test.afterAll(async () => {
	const file = report.write(ctx.orgSlug);
	console.log(`ui-audit: ${file}`);
	for (const [predicate, why] of report.withheld()) {
		console.log(`ui-audit: ${predicate} was NOT MEASURED on any route — ${why}`);
	}
	await closeDb();
});

/** Load the page and wait until it has stopped changing, or until the cap. */
async function settle(page: Page): Promise<void> {
	await page.waitForLoadState("load").catch(() => {});
	// `networkidle` is deprecated for assertions but is exactly right for "the page has stopped
	// fetching", which is what "interactive" means here. The cap is a BUDGET, not a guess: a page
	// that polls (the jobs list) never goes idle, and four widths x 40 routes x an unbounded wait is
	// the difference between a nightly job that finishes and one nobody runs twice.
	await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
	await page.waitForTimeout(250);
}

/**
 * Audit one route: R1, R3, R4, T5 at four widths; then R5, R6, R7; then R2 by hit test; then T6.
 *
 * Every predicate records its verdict BEFORE anything can throw, and the assertions come at the
 * end, so a FAIL on one predicate still leaves the other nine in the report. A run that stops at
 * the first failure produces a report whose zeroes and whose blanks look the same.
 */
async function auditRoute(page: Page, route: RouteRecord): Promise<void> {
	const url = materialize(route, ctx);
	const signals = attachSignals(page);
	const measurements: PageMeasurement[] = [];
	const interactiveMs: number[] = [];
	let t6: FaultResult | null = null;

	for (const width of R1_WIDTHS) {
		await page.setViewportSize({ width, height: AUDIT_VIEWPORT_HEIGHT });
		const started = Date.now();
		await page.goto(url, { waitUntil: "domcontentloaded" });
		// R7'S SAMPLE STOPS AT `load`, BEFORE `settle`. It used to be taken after it, which put the
		// INSTRUMENT'S OWN WAITING inside the number: `settle` always spends 250ms and up to 4,000ms
		// in `networkidle`, and its own comment says a polling page (the jobs list) never goes idle
		// — so such a route carried a fixed 4,250ms of the 8,000ms budget, a page that became usable
		// in a healthy 3.8s was reported as 8.05s, and nothing in the evidence let a reader see
		// which part was the harness. `load` is the page's own signal.
		await page.waitForLoadState("load").catch(() => {});
		interactiveMs.push(Date.now() - started);
		// Settle AFTER the sample: it is a pre-condition for the geometry predicates, not part of
		// what R7 measures.
		await settle(page);
		measurements.push(await measurePage(page, width));
	}
	const landedOn = new URL(page.url()).pathname;

	// ── R1 ────────────────────────────────────────────────────────────────────────────────────
	const overflowing = measurements.filter((m) => m.overflow.scrollWidth > m.overflow.clientWidth + 1);
	if (route.isRedirectOnly) {
		record({ route: route.route, url, predicate: "R1", verdict: "N/A", reason: "redirect-only" });
	} else {
		record({
			route: route.route,
			url,
			predicate: "R1",
			verdict: overflowing.length === 0 ? "PASS" : "FAIL",
			evidence: measurements.map((m) => ({ width: m.width, ...m.overflow })),
		});
	}

	// ── R3 ────────────────────────────────────────────────────────────────────────────────────
	// Zero scrolling containers is a page that fits; that is not a defect. Two or more is the
	// defect the predicate names, and so is one that is not the shell's.
	const badScroll = measurements.filter(
		(m) => m.scrollContainers.length > 1 || (m.scrollContainers.length === 1 && !m.scrollContainers[0].isShellScroller),
	);
	if (route.isRedirectOnly) {
		record({ route: route.route, url, predicate: "R3", verdict: "N/A", reason: "redirect-only" });
	} else {
		record({
			route: route.route,
			url,
			predicate: "R3",
			verdict: badScroll.length === 0 ? "PASS" : "FAIL",
			evidence: measurements.map((m) => ({ width: m.width, containers: m.scrollContainers })),
		});
	}

	// ── R4 ────────────────────────────────────────────────────────────────────────────────────
	const overlaps = measurements.flatMap((m) => m.overlaps.map((o) => ({ width: m.width, ...o })));
	if (route.isRedirectOnly) {
		record({ route: route.route, url, predicate: "R4", verdict: "N/A", reason: "redirect-only" });
	} else {
		record({
			route: route.route,
			url,
			predicate: "R4",
			verdict: overlaps.length === 0 ? "PASS" : "FAIL",
			evidence: overlaps.slice(0, 8),
		});
	}

	// ── T5 ────────────────────────────────────────────────────────────────────────────────────
	const empty = measurements[1]?.empty ?? measurements[0].empty; // the 1280 pass
	if (empty.shared > 0) {
		record({ route: route.route, url, predicate: "T5", verdict: "PASS", evidence: empty });
	} else if (empty.handRolled.length > 0) {
		record({ route: route.route, url, predicate: "T5", verdict: "FAIL", evidence: empty });
	} else {
		record({
			route: route.route,
			url,
			predicate: "T5",
			verdict: "N/A",
			reason: "no-empty-state",
			evidence: empty,
		});
	}

	// ── R5 ────────────────────────────────────────────────────────────────────────────────────
	await page.setViewportSize({ width: 1280, height: AUDIT_VIEWPORT_HEIGHT });
	const violations = await scanRoute(page);
	record({
		route: route.route,
		url,
		predicate: "R5",
		verdict: violations.length === 0 ? "PASS" : "FAIL",
		evidence: violations,
	});

	// ── R6 ────────────────────────────────────────────────────────────────────────────────────
	const r6 = r6Failures(signals);
	record({
		route: route.route,
		url,
		predicate: "R6",
		verdict: r6.length === 0 ? "PASS" : "FAIL",
		evidence: r6.slice(0, 10),
	});

	// ── R7 ────────────────────────────────────────────────────────────────────────────────────
	// The FIRST load of a route is a warm-up and is excluded. Measured on the sandbox, whose
	// console is served by a dev server: `/[org]/[project]/settings/activity` took 49s on its first
	// hit and about 3s on every hit after, because the first one includes compiling the route. That
	// is a property of the server the audit happened to be pointed at, not of the page — CI drives
	// a built console where it does not happen — and a budget that fires on it is a budget people
	// learn to override. The samples are all recorded either way.
	const budgeted = interactiveMs.slice(1);
	const measuredP95 = p95(budgeted);
	record({
		route: route.route,
		url,
		predicate: "R7",
		verdict: measuredP95 <= R7_BUDGET_MS ? "PASS" : "FAIL",
		evidence: {
			samples: interactiveMs,
			warmUpExcluded: interactiveMs[0],
			measuredTo: "load",
			p95: measuredP95,
			budgetMs: R7_BUDGET_MS,
			navigations: navigationsFor(signals.perf, "/").slice(-6),
		},
	});

	// ── R2 ────────────────────────────────────────────────────────────────────────────────────
	// LAST of the rendered predicates: opening overlays changes the page, so everything measured
	// against the untouched render happens first.
	const overlayReport = await probeOverlays(page);
	if (overlayReport.measured === 0) {
		record({
			route: route.route,
			url,
			predicate: "R2",
			verdict: "N/A",
			reason: "opens-no-overlay",
			evidence: overlayReport.probes,
		});
	} else {
		record({
			route: route.route,
			url,
			predicate: "R2",
			verdict: overlayReport.misses.length === 0 ? "PASS" : "FAIL",
			evidence: overlayReport.probes,
		});
	}

	// ── T6 ────────────────────────────────────────────────────────────────────────────────────
	if (route.isRedirectOnly) {
		record({ route: route.route, url, predicate: "T6", verdict: "N/A", reason: "redirect-only" });
	} else {
		const fault = await loadWithInjectedFault(page, url);
		record({
			route: route.route,
			url,
			predicate: "T6",
			verdict: fault.rendersSharedErrorState ? "PASS" : "FAIL",
			evidence: fault,
		});
		t6 = fault;
	}

	// ── The assertions ────────────────────────────────────────────────────────────────────────
	// A withheld predicate asserts NOTHING. A red `expect.soft` IS a published verdict — it is the
	// line a reader acts on — so a predicate the recorder is refusing to score must not be able to
	// turn a broken instrument into a page finding. `withheld()` is the same map `record()` reads,
	// so the report and the failures cannot disagree about which predicates were measured.
	const withheld = report.withheld();
	const scored = (predicate: PredicateId): boolean => !withheld.has(predicate);
	//
	// SOFT, every one of them. A route that fails R1 usually fails R5 too, and a hard `expect`
	// would report the first and hide the rest — so the next reader fixes one thing, re-runs, and
	// discovers the second. The test still fails; it fails with everything it knows.
	if (scored("R1")) {
		expect.soft(
			overflowing.map((m) => ({ width: m.width, by: m.overflow.scrollWidth - m.overflow.clientWidth, offenders: m.overflow.offenders })),
			`R1 ${route.route} (landed on ${landedOn}): horizontal overflow`,
		).toEqual([]);
	}
	if (scored("R3")) {
		expect.soft(
			badScroll.map((m) => ({ width: m.width, containers: m.scrollContainers })),
			`R3 ${route.route}: expected exactly one scroll container and for it to be the shell's <main>`,
		).toEqual([]);
	}
	if (scored("R4")) {
		expect.soft(overlaps, `R4 ${route.route}: interactive elements overlap`).toEqual([]);
	}
	expect.soft(violations, `R5 ${route.route}: serious/critical axe violations`).toEqual([]);
	expect.soft(r6, `R6 ${route.route}: console errors / failed requests`).toEqual([]);
	expect.soft(
		measuredP95,
		`R7 ${route.route}: p95 interactive ${measuredP95}ms over ${budgeted.join("ms, ")}ms ` +
			`(warm-up ${interactiveMs[0]}ms excluded)`,
	).toBeLessThanOrEqual(R7_BUDGET_MS);
	expect.soft(
		overlayReport.misses.length,
		`R2 ${route.route}: an overlay did NOT compute above the chrome — the hit test landed ` +
			`outside it:\n${describeOverlayMisses(overlayReport)}`,
	).toBe(0);
	if (t6) {
		expect.soft(
			t6.rendersSharedErrorState,
			`T6 ${route.route}: with the client render made to throw, the page did not render ` +
				`components/errors/error-state. It rendered ${
					t6.errorish ? `a different error surface: "${t6.errorish}"` : `${t6.visibleLength} visible characters`
				}.`,
		).toBe(true);
	}
}

// The instrument, before any page is scored. `beforeAll` has already withheld whatever this names,
// so the run still produces a full report — it just reports NOT MEASURED for the broken predicates
// instead of verdicts. This test is what makes that LOUD: a withheld predicate is a red line here,
// not a quiet column in a JSON file.
test("the rendered predicates' positive control still fires", () => {
	expect(
		control.lines,
		"a predicate that no longer fires cannot tell a clean page from a page it stopped reading. " +
			`R1/R3/R4/T5 verdicts are WITHHELD for this whole run (${control.broken.join(", ")}).`,
	).toEqual([]);
});

// ── Pass 1: the empty org ────────────────────────────────────────────────────────────────────
const orgOnly = manifest.routes.filter(needsOnlyOrg);
const parameterised = manifest.routes.filter((r) => !needsOnlyOrg(r));

test.describe("pass 1 · every route that needs only [org], against an EMPTY org", () => {
	for (const route of orgOnly) {
		test(`${route.route}`, async ({ page }) => {
			await auditRoute(page, route);
		});
	}
});

// The seam raises on a zero-route scan, and this is the belt: a filter that silently matched
// nothing would turn the whole pass into a green run over no pages at all.
test("pass 1 audited every org-only route the manifest names", () => {
	expect(orgOnly.length, "no org-only routes — the manifest or the filter is broken").toBeGreaterThan(0);
	expect(orgOnly.length + parameterised.length).toBe(manifest.routes.length);
});

test("seed the rows the parameterised routes need (ends the empty-org pass)", async () => {
	await seedRouteFixtures(ctx);
	saveContext(ctx);
	expect(ctx.projectSlug, "no project slug was seeded").toBeTruthy();
	expect(ctx.jobId, "no job was seeded").toBeTruthy();
	expect(ctx.supportCaseId, "no support case was seeded").toBeTruthy();
});

// ── Pass 2: the parameterised routes ─────────────────────────────────────────────────────────
test.describe("pass 2 · routes carrying [project] / [id], against real rows", () => {
	for (const route of parameterised) {
		test(`${route.route}`, async ({ page }) => {
			await auditRoute(page, route);
		});
	}
});

test("the shared error component is still recognisable", async ({ page }) => {
	// The T6 detector derives its signature from `components/errors/error-state.tsx`. Prove the
	// derivation still finds that component in a page that definitely renders it — a 404 — so a
	// restyle turns T6 into a red line here rather than into 36 quiet FAILs on real pages.
	await page.goto(`/${ctx.orgSlug}/~/this-route-does-not-exist`, { waitUntil: "domcontentloaded" });
	await settle(page);
	expect(
		await rendersSharedErrorState(page),
		"the T6 detector no longer recognises ErrorState on a page that renders one (a 404). Its " +
			"signature is derived from components/errors/error-state.tsx — update e2e/audit/error-state.ts.",
	).toBe(true);
});
