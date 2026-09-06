// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * THE PROJECTION TABLE — what each brand token becomes in a terminal, or why it becomes
 * nothing.
 *
 * Every custom property declared in `packages/brand/src/tokens.css` carries exactly one of:
 *
 *   exact — the terminal can carry the token's meaning without loss (an ink, a z-order, a
 *           duration). The generated Go holds the value.
 *   lossy — the terminal carries the INTENT but not the value, and the entry must name what
 *           it collapses to and why. The generated Go carries that sentence, so a reader who
 *           finds `--radius-sm` and `--radius-md` rendering as the same border can see that it
 *           is deliberate rather than "fix" it.
 *   none  — the terminal has no analogue, and the one-line reason is the honest answer. A
 *           spinner has no easing curve; a CLI cannot set a font.
 *
 * `none` is not a shrug. It is the entry that makes the census complete, and completeness is
 * the whole point: `gen-go-brand.ts` refuses to emit when a declared token has no entry here,
 * so a token added to the stylesheet fails CI until somebody decides what the CLI does with it.
 *
 * This file is a SPECIFICATION, not a derivation. With one deliberate exception (the
 * `--color-*` Tailwind utility bindings, below) every token is listed by name, because a
 * pattern that classifies tokens it has never seen is exactly the silent gap this table exists
 * to close.
 */

import type { TokenDeclaration } from "./css-tokens";

/**
 * Which Go block a projected token joins. `none` tokens join none of them.
 *
 * The array is the source and the type is derived from it, not the other way round: a port added
 * to the union but not to the array would be a port the audit and the tests below never sweep,
 * and nothing would say so.
 */
export const PROJECTION_PORTS = ["color", "layer", "duration", "tracking", "border", "emphasis", "focus"] as const;
export type ProjectionPort = (typeof PROJECTION_PORTS)[number];

/**
 * The ports that fold SEVERAL tokens onto ONE Go constant. Their constant is named by the
 * entry's `to`, because deriving it from the token would give six names for two borders and
 * hide the collapse this whole file exists to make visible.
 *
 * Every OTHER port gives each token its own constant, named from the token itself, and an entry
 * there has nothing to point `to`: `identFor` derives the name, so a `to` written there would be
 * silently discarded and `BrandProjections.Target` would publish a symbol the table does not
 * name. `auditProjections` refuses that; both it and `identFor` ask `collapses()`, so the guard
 * and the emitter cannot disagree about which ports collapse.
 */
export const COLLAPSING_PORTS = ["border", "emphasis", "focus"] as const;
export type CollapsingPort = (typeof COLLAPSING_PORTS)[number];
export type DerivingPort = Exclude<ProjectionPort, CollapsingPort>;

/** True when `port` names its Go constant through the entry's `to` rather than from the token. */
export function collapses(port: ProjectionPort): port is CollapsingPort {
	return COLLAPSING_PORTS.some((p) => p === port);
}

export type Projection =
	| { kind: "exact"; port: ProjectionPort; note: string }
	| { kind: "lossy"; port: ProjectionPort; to?: string; why: string }
	| { kind: "none"; why: string };

/** Shorthand for a token the terminal renders as a colour, unchanged. */
const ink = (note: string): Projection => ({ kind: "exact", port: "color", note });

/**
 * Shorthand for a colour whose value carries alpha in one of the two themes. A terminal cell
 * has no alpha channel — it is one foreground on one background — so the value is flattened
 * against `--background` for that theme. That is a real loss (the same token over a card and
 * over the page are different colours in the browser and one colour here), so it is `lossy`
 * and says so rather than quietly rounding.
 */
const composited = (): Projection => ({
	kind: "lossy",
	port: "color",
	why: "carries alpha in one theme; a terminal cell has no alpha channel, so the value is flattened against --background for that theme. Over a raised surface the browser resolves it lighter than this.",
});

/**
 * The reason an absorbed binding carries into the generated Go.
 *
 * Kept short on purpose: it is repeated once per `--color-*` token, and a paragraph repeated
 * fifty-two times in the generated Go is a wall the reader learns to skip past — including
 * past the entries that are NOT this one.
 *
 * The LAST sentence is the one a reader follows, so it is written from the target's own entry
 * rather than assuming the target is a colour. It is not: `--color-sidebar` points at a token
 * that projects to nothing and `--color-ring` at one that projects to a glyph, and a flat "the
 * colour is projected at --sidebar" sends the reader to a `none` row looking for an ink.
 */
function tailwindBindingWhy(target: string, projection: Projection): string {
	const head = `Tailwind \`@theme inline\` utility binding for ${target} — it exists so \`bg-…\`/\`text-…\` compile, and holds no value of its own.`;
	if (projection.kind === "none") return `${head} ${target} projects to nothing either; its own entry says why.`;
	if (projection.port === "color") return `${head} The colour is projected at ${target}.`;
	return `${head} ${target} is projected on the ${projection.port} port, not as a colour.`;
}

const SIDEBAR =
	"the CLI has no persistent sidebar chrome; its navigation is the command tree, drawn per invocation. The inks this names are projected at --ink, --surface-muted and --text-primary.";

const CHART_TRIPWIRE =
	"TRIPWIRE — the CLI renders no charts today, so this projects to nothing. The FIRST chart written gets a projection here (a luminance-ordered ramp, read by lightness like the console's), not an inline colour at the call site.";

/**
 * The `--color-*` block is the one derived rule, and it is derived from STRUCTURE rather than
 * from the name: an entry qualifies only if its declared value is exactly `var(--other)`,
 * `--other` is itself a declared token, AND `--other` carries a decision of its own in the
 * table below. That is what makes it sound — it cannot absorb a NEW token carrying a value of
 * its own (`--color-brand-blue: oklch(0.6 0.2 250)` matches the name and fails the structure),
 * which is the case a bare `startsWith("--color-")` wildcard would have swallowed silently.
 *
 * The third condition is what keeps the DERIVATION honest rather than merely the structure: a
 * binding inherits its target's decision, so there has to BE one. A binding onto another
 * binding, or onto a token nobody has decided yet, is refused here and lands in the audit under
 * its own name — which is where the decision belongs.
 */
export function tailwindBinding(
	name: string,
	decls: readonly TokenDeclaration[],
	census: ReadonlySet<string>,
	table: Readonly<Record<string, Projection>> = PROJECTIONS,
): Projection | null {
	if (!name.startsWith("--color-")) return null;
	const mine = decls.filter((d) => d.name === name);
	if (mine.length !== 1) return null;
	const m = /^var\((--[A-Za-z0-9_-]+)\)$/.exec(mine[0].value);
	if (m === null || !census.has(m[1])) return null;
	const target = table[m[1]];
	if (target === undefined) return null;
	return { kind: "none", why: tailwindBindingWhy(m[1], target) };
}

/** The table. Order is irrelevant — the emitter walks the stylesheet, not this object. */
export const PROJECTIONS: Readonly<Record<string, Projection>> = {
	// ── The ink ramp ──────────────────────────────────────────────────────────────────────
	// Zero-chroma OKLCH is a neutral grey, so each step converts to one sRGB byte with no
	// gamut question to answer. A 24-bit terminal renders them exactly; lipgloss degrades
	// them to the 256- or 16-colour cube itself when the terminal cannot.
	"--gray-0": ink("ink ramp step"),
	"--gray-25": ink("ink ramp step"),
	"--gray-50": ink("ink ramp step"),
	"--gray-100": ink("ink ramp step"),
	"--gray-200": ink("ink ramp step"),
	"--gray-300": ink("ink ramp step"),
	"--gray-400": ink("ink ramp step"),
	"--gray-500": ink("ink ramp step"),
	"--gray-550": ink("ink ramp step"),
	"--gray-600": ink("ink ramp step"),
	"--gray-625": ink("ink ramp step"),
	"--gray-700": ink("ink ramp step"),
	"--gray-800": ink("ink ramp step"),
	"--gray-900": ink("ink ramp step"),
	"--gray-950": ink("ink ramp step"),
	"--gray-1000": ink("ink ramp step"),
	"--gray-1050": ink("ink ramp step"),
	"--gray-1100": ink("ink ramp step"),
	"--black": ink("the brand black — app icons, OG images, the PWA manifest"),

	// ── Semantic surfaces, text and ink ───────────────────────────────────────────────────
	"--surface": ink("the plate a panel is drawn on"),
	"--surface-raised": ink("a panel lifted off the plate"),
	"--surface-sunken": ink("a well — a scroll region, a code block"),
	"--surface-muted": ink("a quiet fill — a selected row, an inactive tab"),
	"--text-primary": ink("headings, values, emphasis — the CLI's InkPrimary"),
	"--text-secondary": ink("body text — the CLI's InkSecondary"),
	"--text-tertiary": ink("labels and rules — the CLI's InkMuted"),
	"--text-disabled": ink("the dimmest readable ink — the CLI's InkFaint"),
	"--text-on-ink": ink("foreground on an inverted (ink) surface — the CLI's InkInverse"),
	"--ink": ink("the solid emphasis fill"),
	"--ink-hover": ink("its hover step; the CLI reuses it for a focused row's fill"),
	"--ink-foreground": ink("foreground on the ink fill"),
	"--border-strong": composited(),
	"--border-faint": composited(),

	// ── Status signals ────────────────────────────────────────────────────────────────────
	// Grayscale by design: status is read through glyph and label, never hue. That rule is
	// what makes these project without loss — the CLI already renders status by shape.
	"--signal-strong": ink("an active/online subject"),
	"--signal-mute": ink("a pending subject"),
	"--signal-faint": ink("a disabled subject"),
	"--signal-critical": ink("a failed subject — paired with ✗, never with red"),
	"--signal-critical-surface": composited(),

	// ── The layer scale ───────────────────────────────────────────────────────────────────
	// The one group that is MORE useful in the terminal than in the browser. bubbletea has no
	// stacking context: a view composites its children by hand, so "the dropdown covers the
	// panel covers the page" is a decision somebody makes at every call site, and before this
	// it was made by argument order. Ordering constants make it one decision, and the same
	// decision the console already made.
	"--z-sticky-head": { kind: "exact", port: "layer", note: "a sticky table header inside a scroll region" },
	"--z-raised": { kind: "exact", port: "layer", note: "table chrome, an overlapping badge" },
	"--z-sticky-bar": { kind: "exact", port: "layer", note: "an in-place action bar" },
	"--z-header": { kind: "exact", port: "layer", note: "the command's header band" },
	"--z-rail": { kind: "exact", port: "layer", note: "the vertical edge rail" },
	"--z-grain": { kind: "exact", port: "layer", note: "the grain wash" },
	"--z-frame": { kind: "exact", port: "layer", note: "the hairline frame" },
	"--z-overlay": { kind: "exact", port: "layer", note: "a prompt, a select, a confirm — huh's own surfaces" },
	"--z-overlay-nested": { kind: "exact", port: "layer", note: "an overlay opened from inside another overlay" },
	"--z-toast": { kind: "exact", port: "layer", note: "reports on everything above, so it outranks everything above" },

	// ── Motion ────────────────────────────────────────────────────────────────────────────
	// A duration IS a duration. bubbletea's cadence is a tick interval, so these arrive as
	// frame intervals with no conversion and no rounding.
	"--dur-1": { kind: "exact", port: "duration", note: "a state swap on a control — the fastest honest tick" },
	"--dur-2": { kind: "exact", port: "duration", note: "the standard spinner frame interval" },
	"--dur-3": { kind: "exact", port: "duration", note: "a considered settle — a progress step" },
	"--dur-4": { kind: "exact", port: "duration", note: "a screen-level entrance" },
	"--ease": {
		kind: "none",
		why: "a spinner has no easing curve. A terminal frame is a discrete redraw with no interpolated intermediate, so there is nothing for a cubic-bezier to shape — the CLI's cadence comes from --dur-* alone.",
	},
	"--ease-out": {
		kind: "none",
		why: "same as --ease: no interpolated frame to decelerate. An arrival in the terminal is one redraw.",
	},
	"--ease-press": {
		kind: "none",
		why: "same as --ease: no interpolated frame to accelerate. A press in the terminal is a keystroke and a redraw.",
	},

	// ── Tracking ──────────────────────────────────────────────────────────────────────────
	"--tracking-eyebrow": {
		kind: "exact",
		port: "tracking",
		note: "the eyebrow device is 'uppercase, tracked out'. Positive tracking survives a cell grid intact — the terminal's unit of tracking is one cell, so `ui.Eyebrow()` inserts a space between letters and the device reads the same",
	},
	"--tracking-display": {
		kind: "none",
		why: "negative tracking. The eyebrow's positive tracking projects because a cell can be ADDED; there is no sub-cell to remove, so tightening a display headline has nothing to spend.",
	},
	"--leading-display": {
		kind: "none",
		why: "line-height 0.96. A terminal row is one row; there is no leading to compress.",
	},

	// ── Radii → two borders ───────────────────────────────────────────────────────────────
	"--radius-xs": {
		kind: "lossy",
		port: "border",
		to: "BorderSquare",
		why: "0 — no corner at all.",
	},
	"--radius-sm": {
		kind: "lossy",
		port: "border",
		to: "BorderSquare",
		why: "2px. A cell has no sub-pixel: below one cell's worth of corner there is nothing the terminal can draw but a square angle. DELIBERATELY the same border as --radius-md — that is not a bug to fix.",
	},
	"--radius-md": {
		kind: "lossy",
		port: "border",
		to: "BorderSquare",
		why: "3px. Same collapse as --radius-sm, and deliberately identical to it.",
	},
	"--radius-lg": {
		kind: "lossy",
		port: "border",
		to: "BorderRounded",
		why: "4px. From here up the console's corner is legible, so the terminal spends its one rounded border set (╭╮╰╯) on it. DELIBERATELY the same border as --radius-xl and --radius.",
	},
	"--radius-xl": {
		kind: "lossy",
		port: "border",
		to: "BorderRounded",
		why: "6px. Same collapse as --radius-lg, and deliberately identical to it.",
	},
	"--radius": {
		kind: "lossy",
		port: "border",
		to: "BorderRounded",
		why: "0.25rem — the shadcn base radius, 4px at the default root size. Same collapse as --radius-lg.",
	},

	// ── The type scale → an emphasis ladder ───────────────────────────────────────────────
	"--text-display-lg": {
		kind: "lossy",
		port: "emphasis",
		to: "EmphasisDisplay",
		// Deliberately NOT tracked out: --tracking-display is NEGATIVE and projects to none (see
		// its entry), so a display headline that arrived spaced out would be carrying the
		// eyebrow's treatment under the display's name.
		why: "56px. Every cell in a terminal is the same size, so a size ladder becomes a WEIGHT-and-CASE ladder: the largest step is bold + uppercase, the treatment that reads as 'this is the headline' with no size to spend.",
	},
	"--text-display-md": {
		kind: "lossy",
		port: "emphasis",
		to: "EmphasisHeading",
		why: "40px. The middle step is bold alone — the second rung of the same ladder.",
	},
	"--text-display-sm": {
		kind: "lossy",
		port: "emphasis",
		to: "EmphasisBand",
		why: "30px. The quietest display step is normal weight in primary ink; it is a heading only by contrast with the faint body around it.",
	},
	"--text-display-xs": {
		kind: "lossy",
		port: "emphasis",
		to: "EmphasisBand",
		why: "24px — display voice rendered INSIDE the console shell: a plan name, a price, an onboarding or purchase heading. It collapses onto the SAME constant as --text-display-sm because the browser separates them by four pixels and a terminal cannot: both are the quiet display step, normal weight in primary ink, and inventing a fourth emphasis constant to carry a size difference the terminal has no cells to spend would publish a distinction the CLI cannot draw.",
	},

	// ── The UI type scale → ink, mostly, and two rungs of the same weight ladder ──────────
	// Seven rungs of 9–17px, derived from where the console's 1,079 hardcoded sizes cluster
	// (#3733). A terminal cell is ONE size, so a size ladder cannot arrive as one — and unlike
	// the display ladder above, five of these seven are not an emphasis ladder either. What
	// separates an 11px label from a 13px value in the console is that the label is also
	// `--text-tertiary` and the value is `--text-primary`; the CLI already carries that
	// distinction EXACTLY, at those two tokens, which is why `none` here is the complete answer
	// rather than a gap. The two heading rungs are different: a heading has a terminal analogue,
	// and it is the weight ladder the display sizes already project onto.
	"--text-ui-3xs": {
		kind: "none",
		why: "9px — a mono eyebrow or a badge caption, the smallest thing on a console screen. A terminal cell has one size, and the CLI's eyebrow device is already its own treatment (case and tracking, at --tracking-eyebrow); what makes this ink quiet in the console is --text-tertiary, which is projected exactly.",
	},
	"--text-ui-2xs": {
		kind: "none",
		why: "10px — a mono label over a value, or a column header. Same answer as --text-ui-3xs: the terminal separates a label from its value by INK and not by size, and that ink is projected exactly at --text-tertiary.",
	},
	"--text-ui-xs": {
		kind: "none",
		why: "11px — secondary metadata: a timestamp, a hint, a helper line. The console's most common rung, and in a terminal it is the same cell as the body it sits under; --text-secondary is what distinguishes it and is projected exactly.",
	},
	"--text-ui-sm": {
		kind: "none",
		why: "12px — control text: a chip, a filter, a small button. A terminal control is drawn from the same cells as everything else, so this rung buys the CLI nothing a border style and an ink do not already carry.",
	},
	"--text-ui-md": {
		kind: "none",
		why: "13px — the console's body rung, which in a terminal is simply the text. It is the size everything else is measured against, and the thing a terminal has exactly one of.",
	},
	"--text-ui-lg": {
		kind: "lossy",
		port: "emphasis",
		to: "EmphasisHeading",
		why: "15px — the SECTION-HEADING rung (@repo/ui/section-heading renders it). With no size to spend, a heading in a terminal is bold, so this joins the weight ladder at the same rung --text-display-md takes: a console section heading and a marketing h2 are one treatment here, and the console's own step down from 15px to its 13px body is carried by weight rather than by size.",
	},
	"--text-ui-xl": {
		kind: "lossy",
		port: "emphasis",
		to: "EmphasisHeading",
		why: "17px — the largest heading a console page carries, a dialog or sheet title. It collapses onto the SAME constant as --text-ui-lg because the terminal's ladder has three rungs and the console's has seven: bold is bold, and EmphasisDisplay is reserved for the display voice so a sheet title cannot arrive shouting in uppercase.",
	},

	// ── The focus ring → an indicator, not an outline ─────────────────────────────────────
	"--ring": {
		kind: "lossy",
		port: "focus",
		to: "FocusMarker",
		why: "a coloured outline around a control. A terminal cannot draw a ring around a cell run without stealing a row above and below, so focus is carried by a leading ▸ plus bold weight — the affordance survives, the geometry does not.",
	},
	"--ring-invalid": {
		kind: "lossy",
		port: "focus",
		to: "FocusInvalidMarker",
		why: "the invalid-state ring. Same geometry loss as --ring, and the invalid state is carried by the ✗ glyph rather than by colour — the brand reads status by shape, never hue, so nothing is lost by the grayscale palette here.",
	},

	// ── shadcn aliases ────────────────────────────────────────────────────────────────────
	// These resolve to the semantic tokens above, so their generated pairs are identical to
	// their targets' by construction — which is itself the check that the alias graph is
	// intact. They are projected rather than dismissed because half the console's components
	// name only these, and the CLI's next lanes will port from those components.
	"--background": ink("the terminal's own ground"),
	"--foreground": ink("alias of --text-primary"),
	"--card": ink("alias of --surface"),
	"--card-foreground": ink("alias of --text-primary"),
	"--popover": ink("alias of --surface-raised"),
	"--popover-foreground": ink("alias of --text-primary"),
	"--primary": ink("alias of --ink"),
	"--primary-foreground": ink("alias of --ink-foreground"),
	"--secondary": ink("alias of --surface-muted"),
	"--secondary-foreground": ink("alias of --text-primary"),
	"--muted": ink("alias of --surface-muted"),
	"--muted-foreground": ink("alias of --text-secondary"),
	"--accent": ink("alias of --surface-muted"),
	"--accent-foreground": ink("alias of --text-primary"),
	"--destructive": ink("alias of --signal-critical — grayscale, paired with ✗"),
	"--border": composited(),
	"--input": composited(),

	// ── No terminal analogue ──────────────────────────────────────────────────────────────
	"--overlay": {
		kind: "none",
		why: "the scrim behind a modal — a translucent black wash over the page. A terminal cannot dim what is behind a prompt: the cells either hold the prompt or hold what was there. huh redraws the region instead.",
	},
	"--input-fill": {
		kind: "none",
		why: "the fill of a bordered control, `transparent` in light and a 4.5% white lift in dark. A cell's background is either set or inherited; a lift that subtle lands on the same 256-colour index as the ground on most terminals, so projecting it would claim a difference nobody sees.",
	},
	"--input-fill-hover": {
		kind: "none",
		why: "the hover step of --input-fill. There is no hover in a terminal — the CLI's equivalent state is focus, and focus is carried by FocusMarker.",
	},

	// ── The sidebar ───────────────────────────────────────────────────────────────────────
	"--sidebar": { kind: "none", why: SIDEBAR },
	"--sidebar-foreground": { kind: "none", why: SIDEBAR },
	"--sidebar-primary": { kind: "none", why: SIDEBAR },
	"--sidebar-primary-foreground": { kind: "none", why: SIDEBAR },
	"--sidebar-accent": { kind: "none", why: SIDEBAR },
	"--sidebar-accent-foreground": { kind: "none", why: SIDEBAR },
	"--sidebar-border": { kind: "none", why: SIDEBAR },
	"--sidebar-ring": { kind: "none", why: SIDEBAR },

	// ── Charts — the tripwire ─────────────────────────────────────────────────────────────
	"--chart-1": { kind: "none", why: CHART_TRIPWIRE },
	"--chart-2": { kind: "none", why: CHART_TRIPWIRE },
	"--chart-3": { kind: "none", why: CHART_TRIPWIRE },
	"--chart-4": { kind: "none", why: CHART_TRIPWIRE },
	"--chart-5": { kind: "none", why: CHART_TRIPWIRE },

	// ── Typefaces ─────────────────────────────────────────────────────────────────────────
	"--font-sans": {
		kind: "none",
		why: "the CLI cannot set a font. The typeface is the terminal emulator's, chosen by the person running it, and no escape sequence changes it.",
	},
	"--font-mono": {
		kind: "none",
		why: "the CLI cannot set a font — and a terminal is already monospaced, so the one thing this token buys the console it gets for free.",
	},
	"--font-display": {
		kind: "none",
		why: "the CLI cannot set a font. The display voice projects as EmphasisDisplay (weight and case), not as a face.",
	},
	"--font-grotesk": {
		kind: "none",
		why: "the CLI cannot set a font. Space Grotesk is the display lockup's face; in the terminal the lockup is the [·] mark and the eyebrow device.",
	},

	// ── Page geometry ─────────────────────────────────────────────────────────────────────
	"--frame-inset": {
		kind: "none",
		why: "10px of air between the viewport edge and the hairline frame. The terminal's frame sits on the cell grid with no sub-cell inset to give it, and stealing a whole row and column for air would cost more than it buys on an 80-column screen.",
	},
	"--wrap-max": {
		kind: "none",
		why: "1180px of maximum content width. The terminal's content width is the window's, reported by the tty and not ours to cap — a CLI that refused to use the width you gave it would be wrong.",
	},
	"--wrap-pad": {
		kind: "none",
		why: "64px of page gutter, sized to clear the vertical rail's glyphs. Terminal padding is measured in cells and set per style; there is no page to gutter.",
	},

	// ── The clamp device's own knobs ──────────────────────────────────────────────────────
	// Local variables of the .vx-clamp corner-mark rule rather than theme tokens. They are
	// listed anyway, because "it looked component-local to me" is not a check — the census is
	// every declaration in the sheet, and a scoping heuristic is one more thing to get wrong.
	"--cl-len": {
		kind: "none",
		why: "arm length in px of the [·] clamp's corner marks. The clamp is drawn from a masked border at sub-cell geometry; the terminal's focus affordance is FocusMarker (see --ring), which is a glyph, not a mark.",
	},
	"--cl-gap": {
		kind: "none",
		why: "how far outside the box the clamp's marks rest, in px. Sub-cell geometry; see --cl-len.",
	},
	"--cl-reach": {
		kind: "none",
		why: "the clamp's resting scale — an animated transform. Nothing in a terminal scales; see --cl-len and --ease.",
	},
	"--cl-op": {
		kind: "none",
		why: "the clamp's resting opacity. A cell has no alpha (see the composited colours above), and the clamp itself does not project; see --cl-len.",
	},
	"--cl-ink": {
		kind: "none",
		why: "the ink the clamp's marks are drawn in, overridable per control. The clamp does not project, so its ink has nothing to colour; see --cl-len.",
	},
};
