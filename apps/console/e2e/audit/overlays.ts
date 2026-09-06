// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// R2 — every overlay computes ABOVE the chrome, measured by HIT-TESTING.
//
// This is the reason the live half of the rubric exists. Grepping for `z-[var(--z-overlay)]`
// matches a *rendering of the intent*, not the stacking that happened, and the two have already
// come apart in this codebase: `packages/ui/src/popover.tsx` carries the incident in a comment —
// base-ui positions the popup via an absolute Positioner and leaves the Popup itself
// `position: static`, on which **z-index is a no-op**, so a popover opened inside the fullscreen
// Elench dialog rendered BEHIND it while its class name said `z-[var(--z-overlay)]` the whole time.
// The fix was a `relative`, which no z-index matcher looks at.
//
// So the question this file asks is the only one that can tell: with the overlay open, what does
// `document.elementFromPoint()` return at its centre and its four inset corners? If the answer is
// not inside the overlay, something paints over it — whatever the class list says.

import type { ElementHandle, Locator, Page } from "@playwright/test";

/** Trigger `data-slot` → the `data-slot` of the layer it opens, and how to provoke it. */
const OVERLAY_KINDS: { trigger: string; content: string; action: "click" | "hover" }[] = [
	{ trigger: "dialog-trigger", content: "dialog-content", action: "click" },
	{ trigger: "alert-dialog-trigger", content: "alert-dialog-content", action: "click" },
	{ trigger: "sheet-trigger", content: "sheet-content", action: "click" },
	{ trigger: "popover-trigger", content: "popover-content", action: "click" },
	{ trigger: "dropdown-menu-trigger", content: "dropdown-menu-content", action: "click" },
	{ trigger: "select-trigger", content: "select-content", action: "click" },
	{ trigger: "tooltip-trigger", content: "tooltip-content", action: "hover" },
	{ trigger: "hover-card-trigger", content: "hover-card-content", action: "hover" },
];

/** How many triggers one route is probed for. A page with 40 menu buttons is 40 of the same layer. */
const MAX_TRIGGERS_PER_KIND = 2;

export interface HitTestPoint {
	name: "centre" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
	x: number;
	y: number;
	/** What `elementFromPoint` returned there. */
	hit: string | null;
	inside: boolean;
}

export interface OverlayProbe {
	kind: string;
	triggerIndex: number;
	trigger: string;
	/** `opened` when the layer appeared; otherwise why it was not measured. */
	status: "measured" | "did-not-open" | "off-screen";
	/** The overlay's own `pointer-events` had to be relaxed to hit-test it (tooltips). */
	pointerEventsRelaxed?: boolean;
	points: HitTestPoint[];
	/** Points whose topmost element was NOT inside the overlay — the R2 defect. */
	misses: HitTestPoint[];
}

export interface OverlayReport {
	probes: OverlayProbe[];
	/** Overlays that actually opened and were hit-tested. R2 is N/A when this is zero. */
	measured: number;
	misses: OverlayProbe[];
}

/**
 * Hit-test one open overlay at its centre and four inset corners.
 *
 * The inset is 25% of the box, capped at 12px: a 2px inset lands on the border-radius of a rounded
 * popover and reports the element behind it, which would be a false FAIL — and a false FAIL on the
 * one predicate this whole project exists for is how people learn to disable it.
 *
 * `pointer-events: none` (tooltips are usually declared that way so they never eat a click) makes a
 * hit test structurally blind: `elementFromPoint` skips the element and returns whatever is behind
 * it, which is indistinguishable from the defect. So when the overlay declares it, the probe sets
 * `pointer-events: auto` on the OVERLAY ELEMENT ONLY for the duration of the read and records that
 * it did. Nothing about the chrome is touched, so the stacking being measured is the real one.
 *
 * IT TAKES THE ELEMENT, NOT A SELECTOR. Re-querying `document.querySelector('[data-slot=…]')` here
 * returned the FIRST node in DOM order, while the caller had waited on the locator's first VISIBLE
 * one — and several of these layers stay mounted-but-hidden while closed. The two are then
 * different nodes, the hidden one measures 0x0, the probe files itself as `off-screen`, and a route
 * whose only overlay was open and perfectly measurable records R2 as N/A "opens-no-overlay". The
 * element measured must be the element opened.
 */
async function hitTest(
	page: Page,
	// The union `Locator.elementHandle()` returns. Both members carry `style` and
	// `getBoundingClientRect`, which is everything this reads.
	overlay: ElementHandle<SVGElement | HTMLElement>,
): Promise<{ points: HitTestPoint[]; pointerEventsRelaxed: boolean } | "off-screen"> {
	const result = await page.evaluate((el: SVGElement | HTMLElement) => {
		const r = el.getBoundingClientRect();
		if (r.width < 8 || r.height < 8) return "off-screen" as const;

		const relaxed = getComputedStyle(el).pointerEvents === "none";
		const prior = el.style.pointerEvents;
		if (relaxed) el.style.pointerEvents = "auto";

		const insetX = Math.min(12, r.width * 0.25);
		const insetY = Math.min(12, r.height * 0.25);
		const spots: { name: HitTestPoint["name"]; x: number; y: number }[] = [
			{ name: "centre", x: r.left + r.width / 2, y: r.top + r.height / 2 },
			{ name: "top-left", x: r.left + insetX, y: r.top + insetY },
			{ name: "top-right", x: r.right - insetX, y: r.top + insetY },
			{ name: "bottom-left", x: r.left + insetX, y: r.bottom - insetY },
			{ name: "bottom-right", x: r.right - insetX, y: r.bottom - insetY },
		];
		const describe = (n: Element | null): string | null => {
			if (!n) return null;
			const slotAttr = n.getAttribute("data-slot");
			const cls =
				typeof n.className === "string" && n.className.trim()
					? `.${n.className.trim().split(/\s+/).slice(0, 3).join(".")}`
					: "";
			const text = (n.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
			return (
				n.tagName.toLowerCase() + (slotAttr ? `[data-slot=${slotAttr}]` : "") + cls + (text ? ` "${text}"` : "")
			);
		};
		const points = spots.map((s) => {
			const x = Math.round(s.x);
			const y = Math.round(s.y);
			// A point outside the viewport cannot be hit-tested; report it as a miss with a null
			// hit rather than silently dropping it — a dropped point is a point that always passes.
			const node = x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight
				? null
				: document.elementFromPoint(x, y);
			return { name: s.name, x, y, hit: describe(node), inside: !!node && (node === el || el.contains(node)) };
		});

		if (relaxed) el.style.pointerEvents = prior;
		return { points, pointerEventsRelaxed: relaxed };
	}, overlay);

	if (result === "off-screen") return "off-screen";
	return result;
}

/**
 * Escape, unconditionally, without waiting on any particular layer.
 *
 * Used on the paths where the expected content never appeared: something may still be open, and it
 * is by definition not the thing this probe knows how to wait for.
 */
async function dismissAnything(page: Page, content: Locator): Promise<void> {
	await page.keyboard.press("Escape").catch(() => {});
	await content.first().waitFor({ state: "hidden", timeout: 500 }).catch(() => {});
	await page.mouse.move(2, 2).catch(() => {});
}

/** Dismisses whatever is open, and waits for it to go. */
async function dismiss(page: Page, content: Locator): Promise<void> {
	await page.keyboard.press("Escape").catch(() => {});
	await content.first().waitFor({ state: "hidden", timeout: 1_500 }).catch(async () => {
		// A layer that will not take Escape (a hover card) closes when the pointer leaves it.
		await page.mouse.move(2, 2).catch(() => {});
		await content.first().waitFor({ state: "hidden", timeout: 1_500 }).catch(() => {});
	});
}

/**
 * Open every overlay the page offers and hit-test each one.
 *
 * Returns a REPORT, not a verdict: the caller decides PASS/FAIL/N/A so the N/A reason
 * (`opens-no-overlay`) is recorded in one place with everything else.
 */
export async function probeOverlays(page: Page): Promise<OverlayReport> {
	const probes: OverlayProbe[] = [];

	for (const kind of OVERLAY_KINDS) {
		const triggers = page.locator(`[data-slot="${kind.trigger}"]`);
		const total = await triggers.count();
		const content = page.locator(`[data-slot="${kind.content}"]`);
		for (let i = 0; i < Math.min(total, MAX_TRIGGERS_PER_KIND); i++) {
			const trigger = triggers.nth(i);
			if (!(await trigger.isVisible().catch(() => false))) continue;
			if (await trigger.isDisabled().catch(() => false)) continue;
			// A trigger that is also a link navigates away instead of opening a layer; probing it
			// would take the audit off the route it is auditing.
			const href = await trigger.getAttribute("href").catch(() => null);
			if (href) continue;
			const label = ((await trigger.innerText().catch(() => "")) || (await trigger.getAttribute("aria-label").catch(() => "")) || "")
				.trim()
				.replace(/\s+/g, " ")
				.slice(0, 40);

			try {
				if (kind.action === "hover") await trigger.hover({ timeout: 2_000 });
				else await trigger.click({ timeout: 2_000 });
			} catch {
				// DISMISS EVEN HERE. "The content slot I was waiting for never became visible" is
				// not "nothing opened": a trigger whose menu is built on a different slot (or has
				// been renamed) leaves a real, modal layer over the page. Every later trigger then
				// fails `isVisible`/`click` behind it, the route reports `measured === 0`, and R2
				// records N/A "opens-no-overlay" for a page that opens overlays — which is the one
				// escape hatch R2 has. An unconditional Escape removes the coupling entirely.
				await dismissAnything(page, content);
				probes.push({ kind: kind.content, triggerIndex: i, trigger: label, status: "did-not-open", points: [], misses: [] });
				continue;
			}

			const visibleOverlay = content.first();
			const opened = await visibleOverlay
				.waitFor({ state: "visible", timeout: 2_000 })
				.then(() => true)
				.catch(() => false);
			if (!opened) {
				await dismissAnything(page, content);
				probes.push({ kind: kind.content, triggerIndex: i, trigger: label, status: "did-not-open", points: [], misses: [] });
				continue;
			}

			// The handle comes from the SAME locator that was waited on, so the node measured is the
			// node that opened — see the note on `hitTest`.
			const handle = await visibleOverlay.elementHandle().catch(() => null);
			const measured = handle ? await hitTest(page, handle) : "off-screen";
			await handle?.dispose();
			if (measured === "off-screen") {
				probes.push({ kind: kind.content, triggerIndex: i, trigger: label, status: "off-screen", points: [], misses: [] });
			} else {
				const misses = measured.points.filter((p) => !p.inside);
				probes.push({
					kind: kind.content,
					triggerIndex: i,
					trigger: label,
					status: "measured",
					pointerEventsRelaxed: measured.pointerEventsRelaxed,
					points: measured.points,
					misses,
				});
			}
			await dismiss(page, content);
		}
	}

	const measured = probes.filter((p) => p.status === "measured");
	return { probes, measured: measured.length, misses: measured.filter((p) => p.misses.length > 0) };
}

/** Renders an R2 report as the failure message a reader can act on. */
export function describeOverlayMisses(report: OverlayReport): string {
	return report.misses
		.map(
			(p) =>
				`  · ${p.kind} from "${p.trigger}" (#${p.triggerIndex})` +
				(p.pointerEventsRelaxed ? " [pointer-events relaxed to read]" : "") +
				"\n" +
				p.misses
					.map((m) => `      ${m.name} (${m.x},${m.y}) → ${m.hit ?? "nothing (outside the viewport)"}`)
					.join("\n"),
		)
		.join("\n");
}

export { hitTest };
