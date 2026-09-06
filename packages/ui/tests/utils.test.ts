// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { cn } from "../src/utils";

const TOKENS = join(dirname(fileURLToPath(import.meta.url)), "../../brand/src/tokens.css");

/**
 * The rungs are READ FROM `tokens.css`, not typed here.
 *
 * A hand-written list of what a test covers stops covering silently: the twelfth rung gets added to
 * the ladder by someone who never opens this file, and its call sites start losing their colour with
 * a green suite. Deriving the subjects from the source and keeping the ASSERTION independent is what
 * makes this test survive the next rung.
 */
function laddersFromTokens(): { ui: string[]; display: string[] } {
	const css = readFileSync(TOKENS, "utf8");
	const found = [...css.matchAll(/--text-((?:ui|display)-[a-z0-9]+)\s*:/g)].map((m) => m[1]);
	const uniq = [...new Set(found)];
	return {
		ui: uniq.filter((r) => r.startsWith("ui-")),
		display: uniq.filter((r) => r.startsWith("display-")),
	};
}

describe("cn — the type ladders are font sizes, not colours", () => {
	const { ui, display } = laddersFromTokens();
	const rungs = [...ui, ...display];

	it("reads both ladders out of tokens.css", () => {
		// Guards the derivation itself: a regex that silently matched nothing would make every
		// `it.each` below vacuous and the suite would still be green.
		expect(ui.length).toBeGreaterThanOrEqual(7);
		expect(display.length).toBeGreaterThanOrEqual(4);
	});

	// The defect, in the direction #4065 reported it.
	it.each(rungs)("keeps text-%s when a colour follows it", (rung) => {
		expect(cn(`text-${rung}`, "text-foreground").split(" ")).toEqual([
			`text-${rung}`,
			"text-foreground",
		]);
	});

	// And the direction it did not: order decided WHICH of the two was deleted, so a fix verified
	// one way round would have looked complete while half the call sites still lost their size.
	it.each(rungs)("keeps text-%s when a colour precedes it", (rung) => {
		expect(cn("text-foreground", `text-${rung}`).split(" ")).toEqual([
			"text-foreground",
			`text-${rung}`,
		]);
	});

	it("still collapses one rung onto another", () => {
		// The rungs must land in the font-size group specifically, not merely somewhere that is not
		// the colour group. Overriding an inherited size is most of why a component calls `cn` at
		// all, so this is the assertion that pins the ladders to a real identity.
		expect(cn("text-ui-xs", "text-ui-lg")).toBe("text-ui-lg");
		expect(cn("text-ui-sm", "text-display-lg")).toBe("text-display-lg");
		expect(cn("text-sm", "text-ui-md")).toBe("text-ui-md");
	});

	it("leaves the merges that already worked alone", () => {
		expect(cn("text-foreground", "text-destructive")).toBe("text-destructive");
		expect(cn("text-sm", "text-lg")).toBe("text-lg");
		expect(cn("text-sm", "text-foreground")).toBe("text-sm text-foreground");
		// The arbitrary-value form these rungs replaced was never broken — which is what makes the
		// conversion in #3809 the cause rather than the discovery.
		expect(cn("text-[11px]", "text-foreground")).toBe("text-[11px] text-foreground");
	});

	it("merges non-text utilities as before", () => {
		expect(cn("px-2", "px-4")).toBe("px-4");
		// clsx's object and array forms still reach twMerge (`flex`/`hidden` would legitimately
		// collapse — they are one display group — so this pair is deliberately non-conflicting).
		expect(cn("flex", { "gap-2": true }, ["items-center"])).toBe("flex gap-2 items-center");
		expect(cn("bg-red-500", "bg-blue-500")).toBe("bg-blue-500");
	});
});
