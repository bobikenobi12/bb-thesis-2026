// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The rendered predicates R1, R3, R4 and T5, measured in the page.
//
// Every measurement NAMES what it found rather than answering yes/no. The reason is the failure
// branch: "R4 failed" sends the next reader to open 40 pages by hand; "R4: button.Deploy @312,180
// 96x32 overlaps a[href=…] @330,190 120x28 by 78x18" sends them to one line of one component.
//
// One `page.evaluate` does all four, for two reasons. It is one round trip per viewport rather than
// four, and — load-bearing — the describe/visible helpers are declared INSIDE the evaluated
// function. They cannot be shared via a closure (evaluate serializes the function it is given) and
// they must not be shared via `new Function(...)`: that is `eval`, and it is subject to the page's
// own Content-Security-Policy, so the whole measurement would start throwing the day the console
// tightens `script-src` — a live audit that fails for a reason that has nothing to do with the
// pages it audits.

import type { Page } from "@playwright/test";

/** The viewport widths R1 is measured at, from the rubric. Height is fixed so R3 is comparable. */
export const R1_WIDTHS = [768, 1280, 1440, 1920] as const;
export const AUDIT_VIEWPORT_HEIGHT = 900;

export interface OverflowMeasurement {
	scrollWidth: number;
	clientWidth: number;
	/** The widest elements sticking out past the viewport — the diagnostic, not the verdict. */
	offenders: { description: string; right: number; width: number }[];
}

export interface ScrollContainer {
	description: string;
	/** True when the element is the shell's own scroll region (`<main>`), or the document itself. */
	isShellScroller: boolean;
	scrollHeight: number;
	clientHeight: number;
	overflowY: string;
}

export interface OverlapPair {
	a: string;
	b: string;
	overlapWidth: number;
	overlapHeight: number;
}

export interface EmptyStateMeasurement {
	/** Visible `@repo/ui/empty` regions in the content area. */
	shared: number;
	/** Regions that READ as an empty state but are not `@repo/ui/empty`. */
	handRolled: { description: string; text: string }[];
	/** Rows/items found in the content area — a populated list cannot answer T5. */
	items: number;
}

/** Everything the rendered predicates need from one viewport, in one round trip. */
export interface PageMeasurement {
	width: number;
	overflow: OverflowMeasurement;
	scrollContainers: ScrollContainer[];
	overlaps: OverlapPair[];
	empty: EmptyStateMeasurement;
}

/**
 * Measure R1, R3, R4 and T5 against the page as it currently stands.
 *
 * The caller sets the viewport and settles the page first; this reads, it does not wait.
 */
export async function measurePage(page: Page, width: number): Promise<PageMeasurement> {
	const measured = await page.evaluate(() => {
		const describe = (el: Element): string => {
			const id = el.id ? `#${el.id}` : "";
			const slotAttr = el.getAttribute("data-slot");
			const slot = slotAttr ? `[data-slot=${slotAttr}]` : "";
			const cls =
				typeof el.className === "string" && el.className.trim()
					? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
					: "";
			const label = el.getAttribute("aria-label") ?? el.getAttribute("name") ?? "";
			const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
			const r = el.getBoundingClientRect();
			return (
				el.tagName.toLowerCase() +
				id +
				slot +
				cls +
				(label ? `[aria-label="${label}"]` : "") +
				(text ? ` "${text}"` : "") +
				` @${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`
			);
		};
		const visible = (el: Element): boolean => {
			const r = el.getBoundingClientRect();
			if (r.width <= 0 || r.height <= 0) return false;
			const s = getComputedStyle(el);
			if (s.visibility === "hidden" || s.display === "none") return false;
			return Number(s.opacity) >= 0.05;
		};

		const all = Array.from(document.querySelectorAll("*"));

		// ── R1: what sticks out past the viewport's right edge. A negative-left element (an
		// off-canvas drawer parked at -100%) does not widen the document and is not an offender.
		const clientWidth = document.body.clientWidth;
		const offenders: { description: string; right: number; width: number }[] = [];
		for (const el of all) {
			if (!visible(el)) continue;
			const r = el.getBoundingClientRect();
			if (r.right > clientWidth + 1) {
				offenders.push({ description: describe(el), right: Math.round(r.right), width: Math.round(r.width) });
			}
		}
		offenders.sort((a, b) => b.right - a.right);

		// ── R3: elements ACTUALLY scrolling. A container declared `overflow-y-auto` whose content
		// fits is a declaration, not a scroll container.
		const scrollingEl = document.scrollingElement;
		const scrollContainers: ScrollContainer[] = [];
		// `all` is `querySelectorAll("*")`, which ALREADY contains `<html>`. Prepending
		// `documentElement` visited it twice, and both visits pass the `scrolls` test — so any page
		// whose DOCUMENT scrolls reported two identical containers and failed R3 for having "two
		// scroll containers", naming the same element twice. The self-test could not see it: its
		// one-scroller fixture never makes the document overflow.
		for (const el of all) {
			const s = getComputedStyle(el);
			const scrolls =
				el === document.documentElement || s.overflowY === "auto" || s.overflowY === "scroll";
			if (!scrolls) continue;
			if (el !== document.documentElement && !visible(el)) continue;
			if (el.scrollHeight <= el.clientHeight + 1) continue;
			scrollContainers.push({
				description: describe(el),
				isShellScroller: el.tagName.toLowerCase() === "main" || el === scrollingEl,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				overflowY: s.overflowY,
			});
		}

		// ── R4: interactive boxes that intersect. Excluded, with reasons, because each would
		// otherwise be a false FAIL that teaches people to ignore the predicate:
		//  · a pair where one CONTAINS the other — a button inside a link is a nesting question,
		//    which axe (R5) already owns;
		//  · anything inside an open overlay — an overlay is SUPPOSED to sit over the page (R2);
		//  · boxes under 8x8 or effectively invisible (`sr-only` is a 1px clipped box);
		//  · `pointer-events: none`, which cannot take a click and so cannot steal one.
		// 2px of intersection in EACH axis is required, so sub-pixel layout rounding is not a find.
		const INTERACTIVE =
			'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
			'[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"], ' +
			'[role="checkbox"], [tabindex]:not([tabindex="-1"])';
		const OVERLAY =
			'[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"], ' +
			'[data-slot="popover-content"], [data-slot="dropdown-menu-content"], ' +
			'[data-slot="dropdown-menu-sub-content"], [data-slot="tooltip-content"], ' +
			'[data-slot="hover-card-content"], [data-slot="select-content"]';
		const candidates = Array.from(document.querySelectorAll(INTERACTIVE)).filter((el) => {
			if (!visible(el)) return false;
			if (el.closest(OVERLAY)) return false;
			if (el.hasAttribute("disabled")) return false;
			if (getComputedStyle(el).pointerEvents === "none") return false;
			const r = el.getBoundingClientRect();
			return r.width >= 8 && r.height >= 8;
		});
		const overlaps: OverlapPair[] = [];
		outer: for (let i = 0; i < candidates.length; i++) {
			for (let j = i + 1; j < candidates.length; j++) {
				const a = candidates[i];
				const b = candidates[j];
				if (a.contains(b) || b.contains(a)) continue;
				const ra = a.getBoundingClientRect();
				const rb = b.getBoundingClientRect();
				const ow = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
				const oh = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
				if (ow <= 2 || oh <= 2) continue;
				overlaps.push({
					a: describe(a),
					b: describe(b),
					overlapWidth: Math.round(ow),
					overlapHeight: Math.round(oh),
				});
				if (overlaps.length >= 12) break outer;
			}
		}

		// ── T5: how the page renders its empty regions (driven against an EMPTY org).
		//
		// KNOWN LIMIT, stated rather than hidden: the hand-rolled arm is a SHAPE plus a phrasing
		// test — a centred, item-less block whose text reads like an empty state. A hand-rolled
		// empty state phrased outside that shape reads as N/A, not FAIL. That is exactly why the
		// rubric makes the per-predicate N/A count a first-class column: a growing T5 N/A count is
		// this limit being hit, and it is visible without anyone auditing for it.
		const root: Element = document.querySelector("main") ?? document.body;
		const sharedEmpty = Array.from(root.querySelectorAll('[data-slot="empty"]')).filter(visible).length;
		const items = Array.from(
			root.querySelectorAll('tbody tr, [role="row"], li[data-slot], [data-slot="card"]'),
		).filter(visible).length;
		const EMPTY_COPY =
			/\b(no|none|nothing|zero)\b[\s\S]{0,80}?\b(yet|found|to show|to display|here|available|created|configured|connected|match)\b|\byou (haven'?t|have not)\b/i;
		const handRolled: { description: string; text: string }[] = [];
		for (const el of Array.from(root.querySelectorAll("div, section, p"))) {
			if (!visible(el)) continue;
			if (el.closest('[data-slot="empty"]')) continue;
			const s = getComputedStyle(el);
			const centred =
				s.textAlign === "center" ||
				(s.display.includes("flex") && s.alignItems === "center" && s.justifyContent === "center");
			if (!centred) continue;
			const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
			if (text.length < 8 || text.length > 240) continue;
			if (!EMPTY_COPY.test(text)) continue;
			// Only the OUTERMOST match: a centred block's centred children would each report.
			if (handRolled.some((h) => h.text.includes(text.slice(0, 120)))) continue;
			handRolled.push({ description: describe(el), text: text.slice(0, 120) });
		}

		return {
			overflow: { scrollWidth: document.body.scrollWidth, clientWidth, offenders: offenders.slice(0, 6) },
			scrollContainers,
			overlaps,
			empty: { shared: sharedEmpty, handRolled: handRolled.slice(0, 4), items },
		};
	});
	return { width, ...measured };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The positive control for the four predicates `measurePage` scores.
//
// It lives HERE, next to the instrument, and it runs on every audit invocation — the shape
// `scripts/check-route-states.mjs` already uses (`positiveControl()` at its entry point, which
// refuses to score the tree when a predicate has stopped firing). A check that can no longer fail
// cannot tell a clean page from a page it stopped reading, and the audit was publishing R3
// verdicts for real routes while R3's own control was red (#3804).
//
// It used to live only in `predicate-selftest.spec.ts`, which made it a TEST — something that goes
// red beside the run rather than something the run consults. `routes.spec.ts` calls it before it
// scores anything, and withholds the predicates it names.

/** The measurement `measurementControl` drives. Injectable so the control's own failure branch is testable. */
export type Measure = (page: Page, width: number) => Promise<PageMeasurement>;

/**
 * Which predicate each `PageMeasurement` field is scored from.
 *
 * Keyed by the field rather than by the predicate on purpose: the self-test asserts that every
 * field `measurePage` actually returns (bar `width`) is named here, so a fifth measurement added
 * without a control fails the audit instead of being scored by nothing.
 */
export const MEASURED_BY = {
	overflow: "R1",
	scrollContainers: "R3",
	overlaps: "R4",
	empty: "T5",
} as const satisfies Record<Exclude<keyof PageMeasurement, "width">, string>;

export type MeasuredPredicate = (typeof MEASURED_BY)[keyof typeof MEASURED_BY];

export interface ControlResult {
	/** The predicates whose control did not fire. Empty means every measurement still works. */
	broken: MeasuredPredicate[];
	/** One line per failure, naming what the control expected and what it measured. */
	lines: string[];
}

/**
 * Wrap fixture markup in the document the CONSOLE serves.
 *
 * `page.setContent("<div>…</div>")` produces a document with **no doctype**, which Chromium renders
 * in quirks mode (`document.compatMode === "BackCompat"`). That is not a cosmetic difference for
 * R3: in quirks mode `document.scrollingElement` is `<body>`, the viewport's overflow is attributed
 * to `<body>` — whose `overflow-y` is `visible`, so the `scrolls` test skips it — and
 * `documentElement.scrollHeight` equals its own `clientHeight`, so the `<html>` candidate is
 * skipped too. A 4000px-tall fixture then reports ZERO scroll containers where the same markup
 * under a doctype reports exactly one (#3804, measured: BackCompat → html 4016/4016, body
 * 4016/400, 0 containers; CSS1Compat → html 4000/400, 1 container).
 *
 * The answer is to make the fixture render the way the product renders, not to teach the walk about
 * `<body>`: the console is a Next.js app and serves `<!DOCTYPE html>`, so `documentElement` is the
 * correct candidate there. A control that only passes in a mode the product never enters is not a
 * control. The `margin: 0` is the same argument — R1 reads `document.body.clientWidth`, and the UA
 * default 8px body margin would make it 1264 in a 1280 viewport, which the console's Tailwind
 * preflight never does.
 */
export function controlFixture(body: string): string {
	return `<!doctype html><html><head><style>body{margin:0}</style></head><body>${body}</body></html>`;
}

/**
 * Drive every `measurePage` predicate against a page that VIOLATES it and a page that does not, and
 * report the ones that no longer answer.
 *
 * Both directions, always. A predicate that has stopped firing and a predicate looking at a clean
 * page produce the same empty result, which is the whole reason this exists.
 *
 * The page is left on the last fixture — callers hand over a scratch page, never one under audit.
 */
export async function measurementControl(page: Page, measure: Measure = measurePage): Promise<ControlResult> {
	const broken = new Set<MeasuredPredicate>();
	const lines: string[] = [];
	const check = (predicate: MeasuredPredicate, ok: boolean, what: string, saw: unknown): void => {
		if (ok) return;
		broken.add(predicate);
		lines.push(`${predicate}: ${what} — measured ${JSON.stringify(saw)}`);
	};

	await page.setViewportSize({ width: 1280, height: 400 });

	// ── R1 ────────────────────────────────────────────────────────────────────────────────────
	await page.setContent(controlFixture(`<main><div style="width: 2400px; height: 40px">wide</div></main>`));
	const wide = (await measure(page, 1280)).overflow;
	check("R1", wide.scrollWidth > wide.clientWidth + 1, "a 2400px child should overflow a 1280px viewport", wide);
	check("R1", wide.offenders.length > 0, "the overflowing element should be NAMED", wide.offenders);

	await page.setContent(controlFixture(`<main><div style="width: 100%; height: 40px">narrow</div></main>`));
	const narrow = (await measure(page, 1280)).overflow;
	check("R1", narrow.scrollWidth <= narrow.clientWidth + 1, "a page that fits should not overflow", narrow);
	check("R1", narrow.offenders.length === 0, "a page that fits should name no offender", narrow.offenders);

	// ── R3 ────────────────────────────────────────────────────────────────────────────────────
	await page.setContent(
		controlFixture(`
			<main style="height: 300px; overflow-y: auto"><div style="height: 2000px">a</div></main>
			<aside style="height: 200px; overflow-y: auto"><div style="height: 2000px">b</div></aside>`),
	);
	const two = (await measure(page, 1280)).scrollContainers;
	check("R3", two.length > 1, "two scrolling regions should read as two containers", two);

	await page.setContent(
		controlFixture(`<main style="height: 300px; overflow-y: auto"><div style="height: 2000px">a</div></main>`),
	);
	const one = (await measure(page, 1280)).scrollContainers;
	check("R3", one.length === 1, "one scrolling <main> should read as exactly one container", one);
	check("R3", one[0]?.isShellScroller === true, "the one scroller is the shell's <main>", one);

	await page.setContent(
		controlFixture(`<main style="height: 300px; overflow-y: auto"><div style="height: 10px">a</div></main>`),
	);
	const declared = (await measure(page, 1280)).scrollContainers;
	check("R3", declared.length === 0, "a container DECLARED scrollable whose content fits is not scrolling", declared);

	// THE DOCUMENT SCROLLING IS **ONE** CONTAINER, not two. `querySelectorAll("*")` already contains
	// `<html>`, so an explicit `[documentElement, ...all]` visited it twice and every page whose
	// document scrolls failed R3 for "two" containers, naming the same element both times.
	await page.setContent(controlFixture(`<div style="height: 4000px">tall</div>`));
	const doc = (await measure(page, 1280)).scrollContainers;
	check("R3", doc.length === 1, "a document that overflows is ONE container, not zero and not two", doc);
	check("R3", doc[0]?.isShellScroller === true, "the document IS the shell scroller here", doc);

	// ── R4 ────────────────────────────────────────────────────────────────────────────────────
	await page.setViewportSize({ width: 1280, height: AUDIT_VIEWPORT_HEIGHT });
	await page.setContent(
		controlFixture(`
			<main style="position: relative; height: 400px">
				<button style="position: absolute; left: 40px; top: 40px; width: 120px; height: 40px">one</button>
				<button style="position: absolute; left: 100px; top: 60px; width: 120px; height: 40px">two</button>
			</main>`),
	);
	const overlapping = (await measure(page, 1280)).overlaps;
	check("R4", overlapping.length === 1, "two overlapping buttons should read as one overlapping pair", overlapping);
	check("R4", (overlapping[0]?.overlapWidth ?? 0) > 2, "the overlap should be measured, not just counted", overlapping);

	await page.setContent(
		controlFixture(`
			<main style="position: relative; height: 400px">
				<a href="#" style="position: absolute; left: 40px; top: 40px; width: 200px; height: 80px">
					<button style="width: 60px; height: 30px">nested</button>
				</a>
				<button style="position: absolute; left: 400px; top: 40px; width: 120px; height: 40px">far</button>
			</main>`),
	);
	const disjoint = (await measure(page, 1280)).overlaps;
	check("R4", disjoint.length === 0, "nesting is not overlapping", disjoint);

	// ── T5 ────────────────────────────────────────────────────────────────────────────────────
	await page.setContent(
		controlFixture(
			`<main><div style="text-align: center; padding: 40px">No clusters yet. Deploy one to get started.</div></main>`,
		),
	);
	const rolled = (await measure(page, 1280)).empty;
	check("T5", rolled.shared === 0, "a hand-rolled empty state is not @repo/ui/empty", rolled);
	check("T5", rolled.handRolled.length > 0, "the hand-rolled empty region should be NAMED", rolled);

	await page.setContent(
		controlFixture(`<main><div data-slot="empty" style="text-align: center; padding: 40px">No clusters yet.</div></main>`),
	);
	const shared = (await measure(page, 1280)).empty;
	check("T5", shared.shared === 1, "@repo/ui/empty should read as the shared component", shared);
	check("T5", shared.handRolled.length === 0, "content INSIDE the shared component is not a finding", shared);

	return { broken: [...broken], lines };
}
