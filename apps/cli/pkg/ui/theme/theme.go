// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package theme binds the generated brand projection (packages/core/types/brand_gen.go) to
// lipgloss.
//
// The split is deliberate. `packages/core/types` is shared with the runner and the e2e harness,
// which have no terminal and must not grow a TUI dependency, so it holds the projection as DATA
// — hex pairs, ordering constants, durations, and the collapse tables that say which six radii
// become which two borders. This package is the only place that turns that data into
// lipgloss.AdaptiveColor, lipgloss.Border and a rendered string.
//
// Nothing here decides anything. Every value below is read from the generated file, whose
// decisions come from `packages/brand/src/tokens.css` by way of
// `apps/console/scripts/lib/brand-projection.ts`. If a colour looks wrong, the fix is in the
// stylesheet or the projection table — never here, and never a hex literal at a call site.
package theme

import (
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/lipgloss"
)

// Adaptive binds a generated ink to lipgloss, which picks the light or dark member from the
// terminal's reported background. Both members are opaque sRGB: a token whose CSS carried
// alpha was flattened by the generator and marked lossy there, because a cell has no alpha.
func Adaptive(c types.BrandColor) lipgloss.AdaptiveColor {
	return lipgloss.AdaptiveColor{Light: c.Light, Dark: c.Dark}
}

// The ink ramp the CLI reads by. These are the SAME five roles the console's text layer names,
// resolved from the same tokens — before this they were five hand-typed hex values, none of
// which was a value in the ramp they claimed to project.
var (
	// InkPrimary is the strongest foreground — headings, values, emphasis. (--text-primary)
	InkPrimary = Adaptive(types.ColorTextPrimary)
	// InkSecondary is standard body text. (--text-secondary)
	InkSecondary = Adaptive(types.ColorTextSecondary)
	// InkMuted is labels, borders and rules. (--text-tertiary)
	InkMuted = Adaptive(types.ColorTextTertiary)
	// InkFaint is the dimmest readable ink — disabled, hints. (--text-disabled)
	InkFaint = Adaptive(types.ColorTextDisabled)
	// InkInverse is the foreground for text on an inverted (ink) surface. (--text-on-ink)
	InkInverse = Adaptive(types.ColorTextOnInk)
)

// Track spaces a label out by one cell per letter — the terminal projection of
// --tracking-eyebrow. Positive tracking is the one typographic measure that survives a cell
// grid: the grid cannot give you 0.16 of a cell, but the device asks for letters pushed apart,
// and a whole cell does that. (Negative tracking has nothing to spend, which is why
// --tracking-display projects to nothing.)
func Track(label string) string {
	return strings.Join(strings.Split(label, ""), types.EyebrowSeparator)
}

// The two border sets the console's six radii collapse onto. Named here rather than inlined so
// the collapse has one spelling; the reasoning is on types.BorderSquare / types.BorderRounded.
var (
	// BorderSquare draws --radius-xs, --radius-sm and --radius-md. All three, deliberately.
	BorderSquare = lipgloss.NormalBorder()
	// BorderRounded draws --radius-lg, --radius-xl and --radius. All three, deliberately.
	BorderRounded = lipgloss.RoundedBorder()
)

// BorderFor resolves a projected shape to its border set.
//
// It must cover every distinct value in types.BrandRadii, and theme_test.go proves it does by
// walking that generated map rather than a list typed here — so a THIRD shape added to the
// projection fails the test instead of silently resolving to a zero Border, which renders as no
// border at all and would read as a styling bug three lanes downstream.
var BorderFor = map[types.BrandBorder]lipgloss.Border{
	types.BorderSquare:  BorderSquare,
	types.BorderRounded: BorderRounded,
}

// Treatment is one rung of the emphasis ladder — how a terminal says "this outranks that" when
// every cell is the same size and there is no type size to spend.
type Treatment struct {
	// Bold renders the rung in bold weight.
	Bold bool
	// Upper uppercases the text, the loudest device a cell grid has after weight.
	Upper bool
	// Ink is the rung's foreground.
	Ink lipgloss.AdaptiveColor
}

// Render applies the rung to text.
func (t Treatment) Render(text string) string {
	if t.Upper {
		text = strings.ToUpper(text)
	}
	return lipgloss.NewStyle().Foreground(t.Ink).Bold(t.Bold).Render(text)
}

// EmphasisFor resolves a projected rung to its treatment.
//
// Exhaustive over types.BrandEmphasisLadder, and proved so by theme_test.go against that
// generated map — the same reason as BorderFor: a rung with no treatment renders as unstyled
// text, which is indistinguishable from body copy and therefore invisible as a defect.
var EmphasisFor = map[types.BrandEmphasis]Treatment{
	// The display rung is bold and uppercased and NOT spaced out: --tracking-display is
	// negative, so the eyebrow's cell-spacing device would be the wrong borrowing here.
	types.EmphasisDisplay: {Bold: true, Upper: true, Ink: InkPrimary},
	types.EmphasisHeading: {Bold: true, Ink: InkPrimary},
	types.EmphasisBand:    {Ink: InkPrimary},
}
