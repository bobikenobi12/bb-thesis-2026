// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Alethia ink ramp transcribed to sRGB hex.
 *
 * `packages/brand/src/tokens.css` is the source of truth and every in-page surface
 * should read the CSS custom properties from it. This file exists only for the
 * three places that provably cannot:
 *
 * - **Email** — no mail client supports `oklch()` or custom properties.
 * - **Stripe Elements** — themed across a cross-origin iframe boundary, so it
 *   takes literal colour strings.
 * - **`next/og` images** — Satori renders outside the document.
 *
 * Those three had each hand-written their own transcription and disagreed: the
 * console's Stripe theme used `#0a0a0a` and `#171717` for the dark surface, and
 * the brand icons used `#1A1A1A`, none of which are ramp values at all.
 *
 * Values are computed, not eyeballed. With chroma 0 an OKLCH colour is a neutral
 * grey, so Oklab a=b=0 gives LMS = L³, linear sRGB = L³, and the sRGB transfer
 * function gives the byte below. Keep the `oklch()` comment on each line: it is
 * what makes a drift against tokens.css checkable by hand.
 */
export const RAMP = {
	gray0: "#ffffff", // oklch(1 0 0)
	gray25: "#fcfcfc", // oklch(0.992 0 0)
	gray50: "#fafafa", // oklch(0.985 0 0)
	gray100: "#f4f4f4", // oklch(0.967 0 0)
	gray200: "#e7e7e7", // oklch(0.928 0 0)
	gray300: "#d8d8d8", // oklch(0.882 0 0)
	gray400: "#bababa", // oklch(0.788 0 0)
	gray500: "#939393", // oklch(0.664 0 0)
	gray550: "#838383", // oklch(0.610 0 0)
	gray600: "#737373", // oklch(0.556 0 0)
	gray625: "#6b6b6b", // oklch(0.527 0 0)
	gray700: "#525252", // oklch(0.440 0 0)
	gray800: "#393939", // oklch(0.345 0 0)
	gray900: "#262626", // oklch(0.268 0 0)
	gray950: "#171717", // oklch(0.205 0 0)
	gray1000: "#0e0e0e", // oklch(0.165 0 0)
	gray1050: "#070707", // oklch(0.130 0 0)
	gray1100: "#040404", // oklch(0.108 0 0)
	black: "#020202", // oklch(0.09 0 0)
} as const;

/** The semantic layer, per theme — mirrors the `:root` / `.dark` blocks in tokens.css. */
export const RAMP_THEME = {
	light: {
		background: RAMP.gray50,
		surface: RAMP.gray0,
		surfaceMuted: RAMP.gray100,
		textPrimary: RAMP.gray1000,
		textSecondary: RAMP.gray700,
		textTertiary: RAMP.gray625,
		border: RAMP.gray200,
		borderStrong: RAMP.gray300,
		ink: RAMP.gray950,
		inkForeground: RAMP.gray50,
	},
	dark: {
		background: RAMP.gray1050,
		surface: RAMP.gray1000,
		surfaceMuted: RAMP.gray950,
		textPrimary: RAMP.gray50,
		textSecondary: RAMP.gray500,
		textTertiary: RAMP.gray550,
		border: RAMP.gray900,
		borderStrong: RAMP.gray800,
		ink: RAMP.gray50,
		inkForeground: RAMP.gray1000,
	},
} as const;

/**
 * The single brand black, for app icons, OG images and the PWA manifest.
 * Three different values were in use — `#0A0A0A`, `#1A1A1A` and the real
 * `oklch(0.130 0 0)` — so the icon, the manifest and the page never matched.
 */
export const BRAND_BLACK = RAMP.gray1050;

/** The ink the mark is drawn in on that black. */
export const BRAND_INK = RAMP.gray50;
