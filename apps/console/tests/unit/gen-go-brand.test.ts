// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the brand → Go projection generator.
 *
 * The thing actually worth testing here is the REFUSAL. `gen-go-brand.ts` claims that a token
 * added to `tokens.css` with no projection entry cannot reach a green build; a guard whose
 * "nothing found" branch is indistinguishable from "nothing wrong" is worth nothing, so the
 * cases below drive the failing branch with hand-written inputs and assert on WHICH token is
 * named, not on a count.
 *
 * Two things are deliberately NOT re-implemented here:
 *
 *   - the CSS scanner is exercised against hand-written stylesheets whose declarations are
 *     listed by hand. A test that re-derived the expected set with the same regex would agree
 *     with any bug it shared;
 *   - the OKLCH→sRGB arithmetic is checked against `packages/brand/src/ramp-srgb.ts` — a
 *     separately written transcription of the same seventeen steps, kept for the surfaces that
 *     provably cannot read a custom property (email, Stripe Elements, `next/og`), and itself
 *     held to `tokens.css` by a third implementation of the transfer function in
 *     `scripts/check-ramp-transcription.mjs`. Agreement between implementations nobody wrote
 *     from the other is evidence; comparing the generator against its own output would not be.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RAMP } from "@repo/brand/ramp-srgb";
import { describe, expect, it } from "vitest";

import {
	collapses,
	PROJECTION_PORTS,
	PROJECTIONS,
	tailwindBinding,
	type DerivingPort,
	type Projection,
} from "../../scripts/lib/brand-projection";
import { carriesAlpha, colorPair, flatten, hex, oklchToRgba, resolveColor } from "../../scripts/lib/brand-resolve";
import { parseDeclarations, stripComments, tokenCensus } from "../../scripts/lib/css-tokens";
import {
	alignRows,
	auditColorClaims,
	auditProjections,
	build,
	generate,
	identFor,
	millis,
	pascal,
	themeMaps,
} from "../../scripts/gen-go-brand";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS_CSS = resolve(HERE, "../../../../packages/brand/src/tokens.css");
const css = readFileSync(TOKENS_CSS, "utf8");

describe("the CSS declaration scanner", () => {
	it("finds every declaration on a line that carries three", () => {
		// This is the exact shape the line-anchored grep it replaces gets wrong: the two
		// breakpoint blocks in tokens.css put every display size on ONE physical line — three
		// of them when this was written, four since #3806 added --text-display-xs. The fixture
		// stays at three: what it pins is that the scanner does not stop at the first
		// declaration, not how many the real sheet happens to carry.
		const sheet = ":root { --a: 1px; --b: 2px; --c: 3px; }";
		expect(parseDeclarations(sheet).map((d) => d.name)).toEqual(["--a", "--b", "--c"]);
	});

	it("does not mistake a var() USE for a declaration", () => {
		const sheet = ".x { color: var(--text-primary); border-color: var(--border, currentColor); }";
		expect(parseDeclarations(sheet)).toEqual([]);
	});

	it("keeps a declaration whose block omits the final semicolon", () => {
		expect(parseDeclarations(":root { --a: 1px }").map((d) => d.name)).toEqual(["--a"]);
	});

	it("reads a declaration through a comment that interrupts it", () => {
		const decls = parseDeclarations(":root { --dur-1: /* the fastest */ 120ms; }");
		expect(decls).toHaveLength(1);
		expect(decls[0].value).toBe("120ms");
	});

	it("treats braces inside a string as data, not as block structure", () => {
		const sheet = `.x { content: "}{"; } :root { --a: 1px; }`;
		expect(parseDeclarations(sheet).map((d) => d.name)).toEqual(["--a"]);
	});

	it("keeps commas inside a parenthesised value with the value", () => {
		const decls = parseDeclarations(":root { --ease: cubic-bezier(0.2, 0, 0, 1); }");
		expect(decls[0].value).toBe("cubic-bezier(0.2, 0, 0, 1)");
	});

	it("marks the theme, root, dark and media scopes apart", () => {
		const sheet = `
			@theme inline { --t: 1; }
			:root { --r: 2; }
			.dark { --r: 3; }
			.vx-clamp { --l: 4; }
			@media (max-width: 620px) { :root { --r: 5; } }
		`;
		expect(parseDeclarations(sheet).map((d) => [d.name, d.scope, d.inMedia])).toEqual([
			["--t", "theme", false],
			["--r", "root", false],
			["--r", "dark", false],
			["--l", "local", false],
			["--r", "root", true],
		]);
	});

	it("stops at an unterminated comment rather than reading past it", () => {
		// A browser swallows the rest of the sheet too. Mirroring that keeps the census honest:
		// tokens that the browser never applies must not be reported as projectable.
		expect(stripComments(":root { --a: 1; } /* oops").trim()).toBe(":root { --a: 1; }");
	});

	it("censuses each name once, in first-declaration order", () => {
		const sheet = ":root { --b: 1; --a: 2; } .dark { --a: 3; --c: 4; }";
		expect(tokenCensus(sheet)).toEqual(["--b", "--a", "--c"]);
	});
});

describe("OKLCH to sRGB", () => {
	it("reproduces every step of the hand-computed ramp in packages/brand/src/ramp-srgb.ts", () => {
		const { light } = themeMaps(parseDeclarations(css));
		const generated: Record<string, string> = {};
		for (const [token, key] of [
			["--gray-0", "gray0"],
			["--gray-25", "gray25"],
			["--gray-50", "gray50"],
			["--gray-100", "gray100"],
			["--gray-200", "gray200"],
			["--gray-300", "gray300"],
			["--gray-400", "gray400"],
			["--gray-500", "gray500"],
			["--gray-550", "gray550"],
			["--gray-600", "gray600"],
			["--gray-625", "gray625"],
			["--gray-700", "gray700"],
			["--gray-800", "gray800"],
			["--gray-900", "gray900"],
			["--gray-950", "gray950"],
			["--gray-1000", "gray1000"],
			["--gray-1050", "gray1050"],
			["--gray-1100", "gray1100"],
			["--black", "black"],
		] as const) {
			generated[key] = hex(resolveColor(token, light));
		}
		expect(generated).toEqual({ ...RAMP });
	});

	it("refuses a chroma it cannot convert exactly rather than dropping the hue", () => {
		expect(() => oklchToRgba("oklch(0.6 0.2 250)")).toThrow(/chroma 0\.2/);
	});

	it("parses the alpha a token declares", () => {
		expect(oklchToRgba("oklch(1 0 0 / 0.17)").a).toBeCloseTo(0.17, 10);
		expect(oklchToRgba("oklch(1 0 0)").a).toBe(1);
	});

	it("flattens alpha onto the ground in sRGB, the way a browser paints it", () => {
		// 0.17 × 255 + 0.83 × 7 = 49.16 → 0x31. Hand-computed, not read off the generator.
		const fg = oklchToRgba("oklch(1 0 0 / 0.17)");
		const bg = oklchToRgba("oklch(0.130 0 0)");
		expect(hex(flatten(fg, bg))).toBe("#313131");
	});

	it("follows a var() chain to the value at the end of it", () => {
		const map = new Map([
			["--a", "var(--b)"],
			["--b", "var(--c)"],
			["--c", "oklch(0.205 0 0)"],
		]);
		expect(hex(resolveColor("--a", map))).toBe("#171717");
	});

	it("names the cycle rather than recursing forever", () => {
		const map = new Map([
			["--a", "var(--b)"],
			["--b", "var(--a)"],
		]);
		expect(() => resolveColor("--a", map)).toThrow(/cycle/);
	});

	it("resolves `transparent` to the ground it is painted on", () => {
		const light = new Map([
			["--x", "transparent"],
			["--background", "oklch(0.985 0 0)"],
		]);
		expect(colorPair("--x", light, light).light).toBe("#fafafa");
	});
});

/** A stylesheet plus a table, for driving the audit's failing branches. */
function audit(sheet: string, table: Record<string, Projection>): string[] {
	return auditProjections(tokenCensus(sheet), parseDeclarations(sheet), table);
}

describe("the no-silent-gap guard", () => {
	it("names a declared token that has no projection", () => {
		const problems = audit(":root { --a: 1px; --brand-new: 2px; }", {
			"--a": { kind: "none", why: "no analogue" },
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("--brand-new");
		expect(problems[0]).toContain("has no projection");
	});

	it("names a projection whose token no longer exists", () => {
		const problems = audit(":root { --a: 1px; }", {
			"--a": { kind: "none", why: "no analogue" },
			"--gone": { kind: "none", why: "no analogue" },
		});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("--gone");
		expect(problems[0]).toContain("no longer declared");
	});

	it("refuses a lossy entry that does not say why", () => {
		const problems = audit(":root { --a: 1px; }", {
			"--a": { kind: "lossy", port: "border", to: "BorderSquare", why: "  " },
		});
		expect(problems).toEqual([expect.stringContaining("--a is marked lossy with an empty reason")]);
	});

	it("refuses a lossy entry that names no collapse target", () => {
		const problems = audit(":root { --a: 1px; }", {
			"--a": { kind: "lossy", port: "border", why: "it collapses" },
		});
		expect(problems).toEqual([expect.stringContaining("names no collapse target")]);
	});

	it("refuses a collapse target on EVERY port that does not collapse", () => {
		// The mirror of the rule above. `identFor` derives the constant's name on these ports, so
		// a `to` written here is DISCARDED — the author is made to name a target that the
		// generated Target then contradicts. The set is derived from PROJECTION_PORTS rather than
		// typed out, because the rule that used to be here read `port !== "color"` and got the
		// other three deriving ports wrong; a hand-written list would go the same way.
		//
		// The expected identifiers are written out rather than read back from identFor: a message
		// checked against the function that built it agrees with any bug the two share.
		const emitted: Record<DerivingPort, string> = {
			color: "ColorZA",
			layer: "LayerA",
			duration: "ZA",
			tracking: "TrackingZAEm",
		};
		const deriving = PROJECTION_PORTS.filter((p) => !collapses(p));
		expect(deriving.slice().sort()).toEqual(Object.keys(emitted).sort());
		for (const port of deriving) {
			const problems = audit(":root { --z-a: 1px; }", {
				"--z-a": { kind: "lossy", port, to: "SomethingElse", why: "it collapses" },
			});
			expect(problems).toEqual([
				expect.stringContaining(`--z-a names the collapse target SomethingElse on the ${port} port, which does not collapse`),
			]);
			// And it names the constant that IS emitted, so the fix is one edit rather than a hunt.
			expect(problems[0]).toContain(emitted[port]);
			expect(identFor("--z-a", { kind: "lossy", port, why: "it collapses" })).toBe(emitted[port]);
		}
	});

	it("accepts a lossy entry with no target on a port that derives its name", () => {
		// The other half of the same rule: the author is no longer FORCED to name a target on
		// these ports, which is what made the discarded `to` inevitable.
		expect(
			audit(":root { --z-a: 1; }", {
				"--z-a": { kind: "lossy", port: "layer", why: "a rung, approximately" },
			}),
		).toEqual([]);
	});

	it("refuses a none entry that does not say why", () => {
		const problems = audit(":root { --a: 1px; }", { "--a": { kind: "none", why: "" } });
		expect(problems).toEqual([expect.stringContaining("'none' is an answer only when it says why")]);
	});

	it("refuses an exact entry with an empty note", () => {
		const problems = audit(":root { --a: 1px; }", { "--a": { kind: "exact", port: "layer", note: "" } });
		expect(problems).toEqual([expect.stringContaining("marked exact with an empty note")]);
	});

	it("passes a stylesheet every one of whose tokens is decided", () => {
		// The green branch, driven explicitly — so "no problems" is a result the test has seen
		// this function produce, not an assumption about the shape of its output.
		expect(
			audit(":root { --a: 1px; --b: 2px; }", {
				"--a": { kind: "none", why: "no analogue" },
				"--b": { kind: "exact", port: "layer", note: "a rung" },
			}),
		).toEqual([]);
	});
});

describe("the --color-* structural rule", () => {
	const decls = (sheet: string) => parseDeclarations(sheet);
	/** Runs the rule against a hand-written sheet and an explicit table. */
	const bind = (name: string, sheet: string, table: Record<string, Projection> = {}) =>
		tailwindBinding(name, decls(sheet), new Set(tokenCensus(sheet)), table);

	it("absorbs a binding that is exactly var(--declared-token)", () => {
		const sheet = "@theme inline { --color-surface: var(--surface); } :root { --surface: oklch(1 0 0); }";
		const p = bind("--color-surface", sheet, { "--surface": { kind: "exact", port: "color", note: "a plate" } });
		expect(p?.kind).toBe("none");
		expect(p?.kind === "none" ? p.why : "").toContain("The colour is projected at --surface.");
	});

	it("REFUSES a --color-* token carrying a value of its own", () => {
		// The case a bare startsWith("--color-") wildcard would have swallowed: a hue enters the
		// grayscale palette and nobody is asked what the CLI does with it.
		const sheet = "@theme inline { --color-brand-blue: oklch(0.6 0.2 250); }";
		expect(bind("--color-brand-blue", sheet)).toBeNull();
	});

	it("REFUSES a binding that points at a token nothing declares", () => {
		const sheet = "@theme inline { --color-ghost: var(--ghost); }";
		expect(bind("--color-ghost", sheet)).toBeNull();
	});

	it("REFUSES a binding whose target carries no decision of its own", () => {
		// The binding INHERITS its target's decision, so there has to be one. Absorbing an
		// undecided target would put a token into the census under a decision nobody made — and
		// it is `--color-*`, so it would never be reported under its target's name either.
		const sheet = "@theme inline { --color-undecided: var(--undecided); } :root { --undecided: 10px; }";
		expect(bind("--color-undecided", sheet)).toBeNull();
	});

	it("does not apply to a token outside the --color-* namespace", () => {
		const sheet = ":root { --alias: var(--surface); --surface: oklch(1 0 0); }";
		expect(bind("--alias", sheet, { "--surface": { kind: "exact", port: "color", note: "a plate" } })).toBeNull();
	});

	describe("the note it writes is the target's OWN answer, not an assumed colour", () => {
		// Driven three ways because the rule has three answers, and the wrong one is unfalsifiable
		// from the generated file: "the colour is projected at --sidebar" reads fine and sends the
		// reader to a `none` row that holds no colour.
		const sheet = "@theme inline { --color-x: var(--x); } :root { --x: oklch(1 0 0); }";
		const why = (target: Projection): string => {
			const p = bind("--color-x", sheet, { "--x": target });
			return p?.kind === "none" ? p.why : "";
		};

		it("points at the colour when the target IS projected as a colour", () => {
			expect(why({ kind: "exact", port: "color", note: "a plate" })).toContain("The colour is projected at --x.");
		});

		it("says the target projects to nothing when it does", () => {
			const text = why({ kind: "none", why: "no terminal analogue" });
			expect(text).toContain("--x projects to nothing either");
			expect(text).not.toContain("The colour is projected");
		});

		it("names the port when the target is projected as something that is not a colour", () => {
			const text = why({ kind: "lossy", port: "focus", to: "FocusMarker", why: "a ring becomes a marker" });
			expect(text).toContain("--x is projected on the focus port, not as a colour.");
			expect(text).not.toContain("The colour is projected");
		});
	});
});

describe("the exact/lossy claim about a colour is checked against the colour", () => {
	const light = new Map([
		["--background", "oklch(0.985 0 0)"],
		["--solid", "oklch(0.5 0 0)"],
		["--washed", "oklch(0 0 0 / 0.4)"],
	]);

	it("flags a colour marked exact whose value carries alpha", () => {
		const p: Projection = { kind: "exact", port: "color", note: "an ink" };
		const problems = auditColorClaims([{ name: "--washed", projection: p, ident: "ColorWashed" }], light, light);
		expect(problems).toEqual([expect.stringContaining("--washed is marked exact but its value carries alpha")]);
	});

	it("flags a colour marked lossy that loses nothing", () => {
		const p: Projection = { kind: "lossy", port: "color", why: "composited" };
		const problems = auditColorClaims([{ name: "--solid", projection: p, ident: "ColorSolid" }], light, light);
		expect(problems).toEqual([expect.stringContaining("resolves opaque in both themes")]);
	});

	it("accepts each claim when it matches its value", () => {
		expect(
			auditColorClaims(
				[
					{ name: "--solid", projection: { kind: "exact", port: "color", note: "an ink" }, ident: "ColorSolid" },
					{ name: "--washed", projection: { kind: "lossy", port: "color", why: "composited" }, ident: "ColorWashed" },
				],
				light,
				light,
			),
		).toEqual([]);
	});
});

describe("Go rendering details", () => {
	it("pascal-cases a token without splitting its digits off", () => {
		expect(pascal("--gray-1050")).toBe("Gray1050");
		expect(pascal("--text-display-lg")).toBe("TextDisplayLg");
	});

	it("names a layer constant without repeating the z", () => {
		expect(identFor("--z-sticky-head", { kind: "exact", port: "layer", note: "x" })).toBe("LayerStickyHead");
	});

	it("names a lossy collapse after its target, not after the token", () => {
		// Six radii must not produce six constant names — that would hide the collapse.
		const to = { kind: "lossy", port: "border", to: "BorderSquare", why: "x" } as const;
		expect(identFor("--radius-sm", to)).toBe("BorderSquare");
		expect(identFor("--radius-md", to)).toBe("BorderSquare");
	});

	it("IGNORES a collapse target on a port that derives its identifier", () => {
		// The other half of the same contract, and the half that used to be silent. Only the
		// collapsing ports have a constant to point at; on the rest the const block emits a name
		// derived from the token, so honouring `to` here would make BrandProjections.Target
		// publish a symbol no const block declares. The audit refuses such an entry outright —
		// this pins the behaviour identFor itself has, because the audit's message is built from
		// it and would otherwise quote a target it is telling the author to drop.
		expect(identFor("--z-probe", { kind: "lossy", port: "layer", to: "LayerSomethingElse", why: "x" })).toBe("LayerProbe");
		expect(identFor("--dur-9", { kind: "lossy", port: "duration", to: "Whatever", why: "x" })).toBe("Dur9");
	});

	it("refuses a duration it cannot read rather than emitting a stopped tick", () => {
		expect(() => millis("0.5s")).toThrow(/whole number of milliseconds/);
		expect(millis("260ms")).toBe(260);
	});

	it("pads columns the way gofmt does, and leaves the last column alone", () => {
		expect(
			alignRows([
				["a", "=", "1", "// one"],
				["bbb", "=", "22", "// two"],
			]),
		).toBe(["\ta   = 1  // one", "\tbbb = 22 // two"].join("\n"));
	});
});

/**
 * The whole pipeline, driven against the REAL stylesheet with one thing changed.
 *
 * `generate` is what both `gen:go-brand` and `gen:go-brand:check` call, and it is what these
 * tests call — so a refusal proven here is a refusal the check runs. That is the point of the
 * function existing: `--check` used to return after the audit, and every refusal that lives in
 * the emitter (the focus glyph, `millis`, `layer`, `ems`, `baseValue`) was invisible to it, so
 * it printed "no gaps" for a stylesheet the generator would not emit from.
 */
describe("the generator refuses a stylesheet it cannot project — on the check path too", () => {
	/** Applies one edit to the live stylesheet, and fails if the edit did not land. */
	function mutate(find: string, replace: string): string {
		const out = css.replace(find, replace);
		expect(out, `the mutation ${JSON.stringify(find)} did not apply`).not.toBe(css);
		return out;
	}

	it("renders the committed stylesheet, which is what a green check means", () => {
		// The green branch driven explicitly: `go` is a real file, not an absence of complaints.
		const { go, problems } = generate(css);
		expect(problems).toEqual([]);
		expect(go).toContain("package types");
		expect(go).toContain("var BrandProjections = []BrandProjection{");
	});

	it("refuses a duration that is not whole milliseconds", () => {
		const sheet = mutate("--dur-1: 120ms;", "--dur-5: 1.5s;\n  --dur-1: 120ms;");
		const { go, problems } = generate(sheet, {
			...PROJECTIONS,
			"--dur-5": { kind: "exact", port: "duration", note: "a probe" },
		});
		expect(problems).toEqual([expect.stringContaining("--dur-* value 1.5s is not a whole number of milliseconds")]);
		expect(go).toBeNull();
	});

	it("refuses a z-index that is not an integer", () => {
		const sheet = mutate("--z-toast: 300;", "--z-toast: 300;\n  --z-probe: calc(1px);");
		const { go, problems } = generate(sheet, {
			...PROJECTIONS,
			"--z-probe": { kind: "exact", port: "layer", note: "a probe" },
		});
		expect(problems).toEqual([expect.stringContaining("--z-* value calc(1px) is not an integer")]);
		expect(go).toBeNull();
	});

	it("refuses a focus target with no glyph", () => {
		const { go, problems } = generate(css, {
			...PROJECTIONS,
			"--ring": { kind: "lossy", port: "focus", to: "FocusUnglyphed", why: "a ring becomes a marker" },
		});
		expect(problems).toEqual([expect.stringContaining("FocusUnglyphed, which has no glyph in FOCUS_GLYPHS")]);
		expect(go).toBeNull();
	});

	it("refuses a value-reading token whose only declaration sits inside an @media block", () => {
		const sheet = mutate("--z-toast: 300;", "--z-toast: 300; }\n@media (max-width: 620px) { :root { --z-probe: 400;");
		const { go, problems } = generate(sheet, {
			...PROJECTIONS,
			"--z-probe": { kind: "exact", port: "layer", note: "a probe" },
		});
		expect(problems).toEqual([expect.stringContaining("--z-probe has no unconditional declaration")]);
		expect(go).toBeNull();
	});
});

describe("a lossy entry's reason and target survive into the generated file", () => {
	it("derives the constant from the token and carries the reason to it", () => {
		// The reviewer's repro. `LayerProbe` is what the const block emits, so `Target` must say
		// LayerProbe — and the reason must land on the const's own doc comment rather than leaving
		// it a dangling em dash, which is the one place a reader looks for why it is lossy.
		const sheet = css.replace("--z-toast: 300;", "--z-toast: 300;\n  --z-probe: 400;");
		expect(sheet).not.toBe(css);
		const { go, problems } = generate(sheet, {
			...PROJECTIONS,
			"--z-probe": { kind: "lossy", port: "layer", why: "THE REASON THAT MUST SURVIVE" },
		});
		expect(problems).toEqual([]);
		expect(go).toContain('{Token: "--z-probe", Kind: BrandLossy, Target: "LayerProbe", Note: "THE REASON THAT MUST SURVIVE"}');
		expect(go).toContain("BrandLayer = 400 // --z-probe — THE REASON THAT MUST SURVIVE");
	});
});

describe("the committed table against the live stylesheet", () => {
	it("decides every token declared in packages/brand/src/tokens.css", () => {
		const { problems, tokens } = build(css);
		expect(problems).toEqual([]);
		expect(tokens.length).toBe(tokenCensus(css).length);
	});

	it("keeps every kind populated — an all-exact or all-none table would mean the vocabulary is unused", () => {
		const { tokens } = build(css);
		const kinds = new Set(tokens.map((t) => t.projection.kind));
		expect([...kinds].sort()).toEqual(["exact", "lossy", "none"]);
	});

	it("marks the ten chart tokens none, with the tripwire the next chart has to trip over", () => {
		const { tokens } = build(css);
		const charts = tokens.filter((t) => /^--(color-)?chart-\d+$/.test(t.name));
		expect(charts.map((t) => t.name).sort()).toEqual([
			"--chart-1",
			"--chart-2",
			"--chart-3",
			"--chart-4",
			"--chart-5",
			"--color-chart-1",
			"--color-chart-2",
			"--color-chart-3",
			"--color-chart-4",
			"--color-chart-5",
		]);
		for (const c of charts) expect(c.projection.kind).toBe("none");
		// The five that carry the ramp itself say what the first chart must do; the five
		// Tailwind bindings point at them.
		for (const c of charts.filter((t) => !t.name.startsWith("--color-"))) {
			expect(c.projection.kind === "none" ? c.projection.why : "").toContain("TRIPWIRE");
		}
	});

	it("projects --tracking-eyebrow and refuses --tracking-display, for opposite-signed reasons", () => {
		expect(PROJECTIONS["--tracking-eyebrow"].kind).toBe("exact");
		const display = PROJECTIONS["--tracking-display"];
		expect(display.kind).toBe("none");
		expect(display.kind === "none" ? display.why : "").toContain("negative");
	});

	it("points every binding's note at what its target ACTUALLY projects", () => {
		// Read off the RENDERED file, not off the table: the note is the sentence a reader
		// follows, and the generated Go is where they read it. Plenty of the bindings point at a
		// target that is not a projected colour — the sidebar set, the chart set, the overlay and
		// input fills project to nothing, and the two rings project to a glyph.
		const { go } = generate(css);
		const claimed = [...(go ?? "").matchAll(/The colour is projected at (--[A-Za-z0-9-]+)\./g)].map((m) => m[1]);
		const notAColour = [...new Set(claimed)].filter((t) => {
			const p = PROJECTIONS[t];
			return p === undefined || p.kind === "none" || p.port !== "color";
		});
		// Named, not counted: a failure here prints the tokens the file sends a reader to look
		// for an ink that is not there.
		expect(notAColour).toEqual([]);

		// And the other two answers are present, so this is not green because the sentence
		// vanished from the file altogether.
		for (const target of ["--sidebar", "--sidebar-border", "--chart-1", "--overlay", "--input-fill", "--input-fill-hover"]) {
			expect(go).toContain(`${target} projects to nothing either`);
		}
		for (const target of ["--ring", "--ring-invalid"]) {
			expect(go).toContain(`${target} is projected on the focus port, not as a colour.`);
		}
	});

	it("names every token that carries alpha, and marks each of them lossy or none", () => {
		// Named, not counted. Ten tokens declare a wash; nine more inherit one through a
		// Tailwind binding. NONE of them may be `exact` — a terminal cell has no alpha — and
		// the sweep is written out so that a token GAINING a wash later shows up here as a
		// list that changed rather than as a number that moved.
		const { light, dark } = themeMaps(parseDeclarations(css));
		const alpha = tokenCensus(css).filter((t) => {
			try {
				return carriesAlpha(t, light, dark);
			} catch {
				return false; // not a colour token at all
			}
		});
		expect(alpha.sort()).toEqual([
			"--border",
			"--border-faint",
			"--border-strong",
			"--color-border",
			"--color-border-faint",
			"--color-border-strong",
			"--color-input",
			"--color-input-fill",
			"--color-input-fill-hover",
			"--color-overlay",
			"--color-ring-invalid",
			"--color-sidebar-border",
			"--input",
			"--input-fill",
			"--input-fill-hover",
			"--overlay",
			"--ring-invalid",
			"--sidebar-border",
			"--signal-critical-surface",
		]);
		for (const token of alpha) {
			expect(PROJECTIONS[token]?.kind ?? "none").not.toBe("exact");
		}
	});
});
