// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package theme

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// The binding's only real risk is INCOMPLETENESS: the generated projection grows a shape or a
// rung, nothing here handles it, and the map lookup returns a zero value that renders as "no
// border" or "unstyled text" — a defect that looks like a styling choice. So the two coverage
// tests walk the GENERATED maps rather than a list typed here; a list would decay in exactly
// the direction it exists to catch.

// TestBorderForCoversEveryProjectedShape drives the coverage from types.BrandRadii.
func TestBorderForCoversEveryProjectedShape(t *testing.T) {
	if len(types.BrandRadii) == 0 {
		t.Fatal("types.BrandRadii is empty — the projection carries no radii, so this test proves nothing")
	}
	shapes := map[types.BrandBorder]bool{}
	for token, shape := range types.BrandRadii {
		shapes[shape] = true
		border, ok := BorderFor[shape]
		if !ok {
			t.Errorf("%s projects to the shape %q, which BorderFor does not handle — it would render "+
				"with no border at all", token, shape)
			continue
		}
		if border.Top == "" || border.Left == "" || border.TopLeft == "" {
			t.Errorf("%s -> %q resolves to a border with empty edges, which draws nothing", token, shape)
		}
	}
	if len(BorderFor) != len(shapes) {
		t.Errorf("BorderFor handles %d shapes but only %d are projected — an entry here answers a "+
			"question the projection no longer asks", len(BorderFor), len(shapes))
	}
}

// TestBorderSetsAreVisiblyDifferent pins the claim the collapse makes: SIX radii become TWO
// borders, so the two had better not draw the same thing. If they did, the honest projection
// would be one border and the table would be overstating what the terminal preserves.
func TestBorderSetsAreVisiblyDifferent(t *testing.T) {
	square := lipgloss.NewStyle().Border(BorderSquare).Render("x")
	rounded := lipgloss.NewStyle().Border(BorderRounded).Render("x")
	if square == rounded {
		t.Errorf("BorderSquare and BorderRounded render identically:\n%s", square)
	}
	if !strings.Contains(rounded, BorderRounded.TopLeft) {
		t.Errorf("the rounded border's corner %q did not reach the rendering:\n%s", BorderRounded.TopLeft, rounded)
	}
}

// TestEmphasisForCoversEveryProjectedRung is the sibling of the border coverage test, driven
// from types.BrandEmphasisLadder.
func TestEmphasisForCoversEveryProjectedRung(t *testing.T) {
	if len(types.BrandEmphasisLadder) == 0 {
		t.Fatal("types.BrandEmphasisLadder is empty — this test would pass while covering nothing")
	}
	rungs := map[types.BrandEmphasis]bool{}
	for token, rung := range types.BrandEmphasisLadder {
		rungs[rung] = true
		if _, ok := EmphasisFor[rung]; !ok {
			t.Errorf("%s projects to the rung %q, which EmphasisFor does not handle — it would render "+
				"as unstyled body copy", token, rung)
		}
	}
	if len(EmphasisFor) != len(rungs) {
		t.Errorf("EmphasisFor handles %d rungs but only %d are projected", len(EmphasisFor), len(rungs))
	}
}

// TestEmphasisRungsRankVisibly pins what the ladder is FOR. A size scale that collapses onto
// three treatments has to keep three distinguishable renderings, or the ranking it claims to
// preserve is gone and every heading in the CLI reads at the same level.
func TestEmphasisRungsRankVisibly(t *testing.T) {
	// Under a test binary lipgloss detects termenv.Ascii and Styled() returns the string
	// UNCHANGED — every rung would render as "Deploy" and this test would fail for a reason
	// that has nothing to do with the ladder. Force the profile a real terminal reports, so
	// what is compared is what a person sees.
	restore := lipgloss.ColorProfile()
	lipgloss.SetColorProfile(termenv.TrueColor)
	defer lipgloss.SetColorProfile(restore)
	seen := map[string][]types.BrandEmphasis{}
	for rung, treatment := range EmphasisFor {
		out := treatment.Render("Deploy")
		seen[out] = append(seen[out], rung)
	}
	for out, rungs := range seen {
		if len(rungs) > 1 {
			t.Errorf("rungs %v all render as %q — the ladder ranks nothing", rungs, out)
		}
	}
	display := EmphasisFor[types.EmphasisDisplay].Render("Deploy")
	if !strings.Contains(display, "DEPLOY") {
		t.Errorf("the display rung did not uppercase its text: %q", display)
	}
	// And it must NOT space the letters out: --tracking-display is negative and projects to
	// nothing, so a spaced display heading would be wearing the eyebrow's device.
	if strings.Contains(display, "D E P L O Y") {
		t.Errorf("the display rung tracked its text out, which belongs to --tracking-eyebrow: %q", display)
	}
	heading := EmphasisFor[types.EmphasisHeading].Render("Deploy")
	if strings.Contains(heading, "DEPLOY") {
		t.Errorf("the heading rung uppercased its text; only the display rung does: %q", heading)
	}
}

// TestTrackSpacesByExactlyOneCell pins the eyebrow projection against a hand-written
// expectation rather than against a second join.
func TestTrackSpacesByExactlyOneCell(t *testing.T) {
	if got, want := Track("PLANE"), "P L A N E"; got != want {
		t.Errorf("Track(%q) = %q, want %q", "PLANE", got, want)
	}
	if got := Track(""); got != "" {
		t.Errorf("Track(\"\") = %q, want an empty string", got)
	}
	if got, want := Track("A"), "A"; got != want {
		t.Errorf("Track(%q) = %q, want %q — a single letter has nothing to be spaced from", "A", got, want)
	}
}

// TestInkRampBindsTheGeneratedValues proves the five CLI ink names still point at the five
// console roles they claim to. It compares against the generated pairs, which are themselves
// checked against the hand-computed ramp on the TypeScript side — so this asserts the WIRING,
// which is the part a person types and can get wrong.
func TestInkRampBindsTheGeneratedValues(t *testing.T) {
	for _, c := range []struct {
		name string
		got  lipgloss.AdaptiveColor
		want types.BrandColor
	}{
		{"InkPrimary", InkPrimary, types.ColorTextPrimary},
		{"InkSecondary", InkSecondary, types.ColorTextSecondary},
		{"InkMuted", InkMuted, types.ColorTextTertiary},
		{"InkFaint", InkFaint, types.ColorTextDisabled},
		{"InkInverse", InkInverse, types.ColorTextOnInk},
	} {
		if c.got.Light != c.want.Light || c.got.Dark != c.want.Dark {
			t.Errorf("%s = {%s %s}, want {%s %s}", c.name, c.got.Light, c.got.Dark, c.want.Light, c.want.Dark)
		}
	}
	// The five must be five DIFFERENT inks in at least one theme, or two roles collapsed and
	// the CLI lost a level of contrast without anything failing.
	pairs := map[string]bool{}
	for _, ink := range []lipgloss.AdaptiveColor{InkPrimary, InkSecondary, InkMuted, InkFaint, InkInverse} {
		pairs[ink.Light+"/"+ink.Dark] = true
	}
	if len(pairs) != 5 {
		t.Errorf("the five ink roles resolve to %d distinct pairs — two roles are the same ink", len(pairs))
	}
}
