// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The PRODUCER half of #4099 — `e2e/helpers/a11y.ts` keeping axe's per-node check data.
//
// The consumer half (`scripts/audit-report.mjs`'s R5 summary) is proven by that file's own
// `--self-test`, against violation rows written by hand. On its own that proves only that the
// summariser renders the shape its author had in mind. This file closes the loop from the other
// end: it drives the real `groupNodes` with a VERBATIM axe `color-contrast` node payload — field
// names, value types and formats exactly as axe-core 4.13 emits them, including
// `contrastRatio` as a number and `expectedContrastRatio` as the string "4.5:1" — and then feeds
// the result to the REAL `summariseLiveEvidence`. Nothing between the two halves is authored by
// the fix, so "the artifact names a failing colour pair" is measured rather than assumed.
//
// jsdom cannot run axe for contrast (no layout — axe returns the check as INCOMPLETE, never a
// ratio), which is why this drives the grouping function directly rather than a real scan. The
// live measurement is the `ui-audit` Playwright job; this is the part that can be held at unit
// speed, and it is the part that regressed.

import { describe, expect, it } from "vitest";
import { A11Y_GROUP_CAP, groupNodes } from "../../e2e/helpers/a11y";
import { summariseLiveEvidence } from "../../scripts/audit-report.mjs";

/** One axe NodeResult for a `color-contrast` violation, verbatim in shape. */
const contrastNode = (fg: string, bg: string, ratio: number, target: string) => ({
	html: `<span class="x">Label</span>`,
	impact: "serious",
	target: [target],
	any: [
		{
			id: "color-contrast",
			impact: "serious",
			message: `Element has insufficient color contrast of ${ratio}`,
			data: {
				fgColor: fg,
				bgColor: bg,
				contrastRatio: ratio,
				fontSize: "9.0pt (12px)",
				fontWeight: "normal",
				messageKey: null,
				expectedContrastRatio: "4.5:1",
			},
			relatedNodes: [],
		},
	],
	all: [],
	none: [],
});

describe("groupNodes — what survives the reduction", () => {
	it("keeps the colour data axe attached, which the old shape dropped entirely", () => {
		const { groups, omittedNodes } = groupNodes([contrastNode("#8a8f98", "#0d0f12", 3.71, "span.a")]);
		expect(omittedNodes).toBe(0);
		expect(groups).toHaveLength(1);
		expect(groups[0].checks[0].id).toBe("color-contrast");
		expect(groups[0].checks[0].data).toMatchObject({
			fgColor: "#8a8f98",
			bgColor: "#0d0f12",
			contrastRatio: 3.71,
			expectedContrastRatio: "4.5:1",
		});
	});

	it("collapses nodes that share a colour pair, so 30 nodes cost one row and keep their count", () => {
		const nodes = Array.from({ length: 30 }, (_, i) => contrastNode("#8a8f98", "#0d0f12", 3.71, `span.n${i}`));
		const { groups, omittedNodes } = groupNodes(nodes);
		expect(groups).toHaveLength(1);
		expect(groups[0].count).toBe(30);
		expect(omittedNodes).toBe(0);
	});

	it("does NOT collapse distinct colour pairs — one token fix does not answer for another", () => {
		const { groups } = groupNodes([
			contrastNode("#8a8f98", "#0d0f12", 3.71, "span.a"),
			contrastNode("#6b7280", "#111318", 2.9, "span.b"),
		]);
		expect(groups).toHaveLength(2);
		expect(new Set(groups.map((g) => JSON.stringify(g.checks[0].data)))).toHaveProperty("size", 2);
	});

	// The whole point of a cap being IN the record: `omittedNodes: 0` and `omittedNodes: 4` are
	// different artifacts, so "we kept everything" is never confused with "we kept the first few".
	it("reports what the cap withheld, in nodes, rather than dropping it silently", () => {
		const distinct = Array.from({ length: A11Y_GROUP_CAP + 4 }, (_, i) =>
			contrastNode(`#00000${i.toString(16)}`, "#0d0f12", 3 + i / 100, `span.n${i}`),
		);
		const { groups, omittedNodes } = groupNodes(distinct);
		expect(groups).toHaveLength(A11Y_GROUP_CAP);
		expect(omittedNodes).toBe(4);
	});

	// axe puts a violated "must not pass" check in `none`, not `any` — a helper that read only
	// `any`/`all` would reproduce this issue for a different rule.
	it("captures a `none` check too, not only `any` and `all`", () => {
		const { groups } = groupNodes([
			{ target: ["div.z"], any: [], all: [], none: [{ id: "aria-hidden-focus", impact: "serious", message: "m", data: { role: "button" } }] },
		]);
		expect(groups[0].checks.map((c) => c.id)).toEqual(["aria-hidden-focus"]);
	});

	// It must not throw mid-scan — but it must not swallow either. A node it could not read is
	// COUNTED as withheld, because "we kept everything" and "we dropped two and said nothing" are
	// the two states this whole unit exists to keep apart.
	it("survives a node shape it does not recognise, and counts it as withheld rather than as kept", () => {
		const { groups, omittedNodes } = groupNodes([null, "nonsense", contrastNode("#8a8f98", "#0d0f12", 3.71, "span.a")]);
		expect(groups).toHaveLength(1);
		expect(groups[0].count).toBe(1);
		expect(omittedNodes).toBe(2);
	});
});

describe("producer → consumer, end to end", () => {
	it("a real axe payload becomes a summary that NAMES the colour pair and ratio", () => {
		const nodes = Array.from({ length: 9 }, (_, i) => contrastNode("#8a8f98", "#0d0f12", 3.7148, `span.n${i}`));
		const { groups, omittedNodes } = groupNodes(nodes);
		const detail = summariseLiveEvidence("R5", [
			{ id: "color-contrast", impact: "serious", nodes: nodes.length, groups, omittedNodes },
		]);
		expect(detail).toBe("color-contrast (serious) ×9 [#8a8f98 on #0d0f12 — 3.71:1, wants 4.5:1]");
	});

	// The state R5 was in before this unit: measured, scored, and saying nothing a person could act
	// on. The summariser refuses it, so the two halves cannot silently come apart again.
	it("and a producer that stops keeping the data makes the summary REFUSE, not shrug", () => {
		const stripped = groupNodes([contrastNode("#8a8f98", "#0d0f12", 3.71, "span.a")]).groups.map((g) => ({ ...g, checks: [] }));
		expect(() =>
			summariseLiveEvidence("R5", [{ id: "color-contrast", impact: "serious", nodes: 1, groups: stripped, omittedNodes: 0 }]),
		).toThrow(/names no colour pair/);
	});
});
