// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolving a brand token to the sRGB hex pair a terminal can actually set.
 *
 * Two jobs, both small and both worth doing here rather than at a call site:
 *
 * 1. **Follow the `var()` chain.** `--primary` is `var(--ink)` is `var(--gray-950)` is
 *    `oklch(0.205 0 0)`. Half the semantic layer is one or two hops from a value.
 * 2. **Convert OKLCH to sRGB.** Every colour in this system has chroma 0, which is what makes
 *    the conversion exact rather than a gamut negotiation: with a = b = 0 the Oklab→LMS step is
 *    the identity, so linear sRGB is L³ on all three channels and the only thing left is the
 *    sRGB transfer function. `packages/brand/src/ramp-srgb.ts` states the same derivation and
 *    hand-computes the same seventeen bytes — an independently written second opinion the
 *    generator's test asserts against, so an arithmetic slip here shows up as a disagreement
 *    with a human rather than as a plausible-looking hex.
 *
 * Chroma is not assumed. A non-zero chroma is REFUSED (see `oklchToHex`) rather than silently
 * approximated: the day somebody adds a hue to this palette, the CLI should be told to decide
 * what to do with it, not handed a grey that quietly drops it.
 */

/** A token's terminal projection: one sRGB hex per theme. */
export interface ColorPair {
	light: string;
	dark: string;
}

/** The sRGB transfer function (linear → gamma-encoded), per IEC 61966-2-1. */
function srgbEncode(linear: number): number {
	return linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
}

/** Clamps to [0,255] and renders two lowercase hex digits. */
function byte(v: number): string {
	const n = Math.min(255, Math.max(0, Math.round(v * 255)));
	return n.toString(16).padStart(2, "0");
}

/** A parsed colour: sRGB bytes plus the alpha the source declared. */
export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

/**
 * Converts a zero-chroma `oklch(L C H[ / A])` to sRGB.
 *
 * Throws on a non-zero chroma. That is deliberate: this generator's whole claim is that the
 * projection is EXACT, and it is exact only because chroma is zero. Approximating a hue would
 * make the claim false in a way nothing downstream could detect.
 */
export function oklchToRgba(css: string): Rgba {
	const m = /^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*(?:\/\s*([0-9.]+)\s*)?\)$/.exec(css.trim());
	if (m === null) throw new Error(`not an oklch() colour: ${css}`);
	const l = Number(m[1]);
	const c = Number(m[2]);
	const a = m[4] === undefined ? 1 : Number(m[4]);
	if (c !== 0) {
		throw new Error(
			`${css} has chroma ${c}. The Alethia palette is zero-chroma by rule, and this converter is exact ONLY at chroma 0 — it will not guess a hue. Decide what the CLI does with a coloured token before adding one.`,
		);
	}
	if (!Number.isFinite(l) || l < 0 || l > 1) throw new Error(`${css} has a lightness outside [0,1]`);
	if (!Number.isFinite(a) || a < 0 || a > 1) throw new Error(`${css} has an alpha outside [0,1]`);
	// Chroma 0 ⇒ Oklab a = b = 0 ⇒ L' = M' = S' = L ⇒ LMS = L³ ⇒ linear sRGB = L³ on every
	// channel (the LMS→linear-sRGB matrix rows each sum to 1).
	const linear = l * l * l;
	const v = srgbEncode(linear);
	return { r: v, g: v, b: v, a };
}

/** Renders an opaque colour as `#rrggbb`. Alpha must already be resolved away. */
export function hex(c: Rgba): string {
	return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}`;
}

/**
 * Flattens `fg` (which may carry alpha) onto an opaque `bg`.
 *
 * Compositing happens in gamma-encoded sRGB, which is what a browser does for
 * `background-color` by default — so the flattened byte is the byte a screenshot of the
 * console would contain, not a physically-linear ideal that would disagree with it.
 */
export function flatten(fg: Rgba, bg: Rgba): Rgba {
	return {
		r: fg.a * fg.r + (1 - fg.a) * bg.r,
		g: fg.a * fg.g + (1 - fg.a) * bg.g,
		b: fg.a * fg.b + (1 - fg.a) * bg.b,
		a: 1,
	};
}

/** A theme's declarations: token name → declared value, after `@theme`/`:root`/`.dark` layering. */
export type ThemeMap = ReadonlyMap<string, string>;

/**
 * Resolves a token to a colour, following `var()` hops.
 *
 * `transparent` resolves to alpha 0 over black, which `flatten` then turns into the ground —
 * the correct answer, and one that needs no special case at the call site.
 */
export function resolveColor(token: string, map: ThemeMap, seen: readonly string[] = []): Rgba {
	if (seen.includes(token)) {
		throw new Error(`var() cycle resolving ${token}: ${[...seen, token].join(" -> ")}`);
	}
	const raw = map.get(token);
	if (raw === undefined) throw new Error(`${token} is not declared in this theme`);
	const value = raw.trim();

	if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

	const varRef = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,([\s\S]*))?\)$/.exec(value);
	if (varRef !== null) {
		const target = varRef[1];
		if (!map.has(target)) {
			const fallback = varRef[2]?.trim();
			if (fallback === undefined || fallback === "") {
				throw new Error(`${token} points at ${target}, which is not declared and has no fallback`);
			}
			// A fallback that is itself a colour is resolvable; `currentColor` is not, and a
			// token whose only value is `currentColor` is not a colour token at all.
			if (/^oklch\(/.test(fallback)) return oklchToRgba(fallback);
			throw new Error(`${token} falls back to ${fallback}, which is not a resolvable colour`);
		}
		return resolveColor(target, map, [...seen, token]);
	}

	if (/^oklch\(/.test(value)) return oklchToRgba(value);
	throw new Error(`${token} resolves to ${value}, which is not a colour this generator understands`);
}

/**
 * The colour pair a terminal sets for `token`: resolved in both themes and, where the value
 * carries alpha, flattened onto that theme's `--background`.
 */
export function colorPair(token: string, light: ThemeMap, dark: ThemeMap, groundToken = "--background"): ColorPair {
	const grounds = {
		light: resolveColor(groundToken, light),
		dark: resolveColor(groundToken, dark),
	};
	return {
		light: hex(flatten(resolveColor(token, light), grounds.light)),
		dark: hex(flatten(resolveColor(token, dark), grounds.dark)),
	};
}

/** True when the token's declared value carries alpha in either theme — the `lossy` trigger. */
export function carriesAlpha(token: string, light: ThemeMap, dark: ThemeMap): boolean {
	return resolveColor(token, light).a < 1 || resolveColor(token, dark).a < 1;
}
