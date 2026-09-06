// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

import (
	"fmt"
	"regexp"
	"testing"
)

// The generated file is data, so these tests do not check the arithmetic that produced it —
// that is checked on the TypeScript side against the hand-computed ramp in
// packages/brand/src/ramp-srgb.ts. What they check is that the TABLE and the VALUES still
// describe each other, and that the product-level claims the projection makes out loud
// (six radii become two borders; the layer scale is an order) are true of what shipped.

var hexPair = regexp.MustCompile(`^#[0-9a-f]{6}$`)

// TestBrandProjectionsCoverEveryKindHonestly pins the shape of every row: a decision, a
// reason, and a target exactly when there is something to target.
func TestBrandProjectionsCoverEveryKindHonestly(t *testing.T) {
	if len(BrandProjections) == 0 {
		t.Fatal("BrandProjections is empty — the generator emitted a table describing nothing")
	}
	seen := map[string]bool{}
	kinds := map[BrandProjectionKind]int{}
	for _, p := range BrandProjections {
		if seen[p.Token] {
			t.Errorf("%s appears twice in BrandProjections", p.Token)
		}
		seen[p.Token] = true
		kinds[p.Kind]++

		switch p.Kind {
		case BrandExact, BrandLossy:
			if p.Target == "" {
				t.Errorf("%s is %s but names no Go identifier", p.Token, p.Kind)
			}
		case BrandNone:
			if p.Target != "" {
				t.Errorf("%s is none but names the target %q — none means nothing is emitted", p.Token, p.Target)
			}
		default:
			t.Errorf("%s carries the unknown kind %q", p.Token, p.Kind)
		}
		if p.Note == "" {
			t.Errorf("%s carries no note. A lossy entry must say what it collapses to and why; "+
				"a none entry is an answer only when it says why", p.Token)
		}
	}
	// All three kinds must be in use. An all-exact table would mean somebody projected the
	// unprojectable; an all-none one would mean the CLI shares nothing and the file is theatre.
	for _, k := range []BrandProjectionKind{BrandExact, BrandLossy, BrandNone} {
		if kinds[k] == 0 {
			t.Errorf("no token is marked %s — the vocabulary has a word nothing uses", k)
		}
	}
}

// TestBrandProjectionsAndValuesDescribeEachOther is the consistency gate between the census
// and the emitted values, in BOTH directions: a row that claims a projection must have one,
// and a value must not exist for a token the table calls unprojected. Either half alone would
// pass while the file was half-generated.
func TestBrandProjectionsAndValuesDescribeEachOther(t *testing.T) {
	// Every place a projected token's value can land.
	projected := map[string]string{}
	add := func(token, where string) {
		if prev, dup := projected[token]; dup {
			t.Errorf("%s is projected twice — into %s and %s", token, prev, where)
		}
		projected[token] = where
	}
	for k := range BrandColors {
		add(k, "BrandColors")
	}
	for k := range BrandLayers {
		add(k, "BrandLayers")
	}
	for k := range BrandDurations {
		add(k, "BrandDurations")
	}
	for k := range BrandRadii {
		add(k, "BrandRadii")
	}
	for k := range BrandEmphasisLadder {
		add(k, "BrandEmphasisLadder")
	}
	for k := range BrandFocusMarkers {
		add(k, "BrandFocusMarkers")
	}
	// The eyebrow's tracking projects to a pair of scalars rather than into a map, because one
	// token cannot be a map worth indexing. It is named here so the sweep below stays total.
	add("--tracking-eyebrow", "TrackingEyebrowEm/EyebrowSeparator")

	inTable := map[string]BrandProjectionKind{}
	for _, p := range BrandProjections {
		inTable[p.Token] = p.Kind
		_, has := projected[p.Token]
		if p.Kind == BrandNone && has {
			t.Errorf("%s is marked none but a value was emitted for it in %s", p.Token, projected[p.Token])
		}
		if p.Kind != BrandNone && !has {
			t.Errorf("%s is marked %s but no value was emitted for it", p.Token, p.Kind)
		}
	}
	for token, where := range projected {
		if _, ok := inTable[token]; !ok {
			t.Errorf("%s has a value in %s but no row in BrandProjections", token, where)
		}
	}
}

// TestBrandColorsAreOpaqueSRGBPairs pins the contract lipgloss depends on. A cell takes a
// literal colour: an empty member silently renders as the terminal default, which reads as
// "the theme is fine" rather than as a missing value.
func TestBrandColorsAreOpaqueSRGBPairs(t *testing.T) {
	for token, c := range BrandColors {
		for member, v := range map[string]string{"Light": c.Light, "Dark": c.Dark} {
			if !hexPair.MatchString(v) {
				t.Errorf("%s.%s is %q, which is not a lowercase #rrggbb", token, member, v)
			}
		}
	}
}

// TestBrandInkRampStaysOrdered proves the semantic text ramp is a RAMP: strictly darkening in
// the light theme and strictly lightening in the dark one. Two tokens swapped in the
// projection table would leave every other test green and make the CLI's "muted" ink darker
// than its "body" ink.
func TestBrandInkRampStaysOrdered(t *testing.T) {
	ramp := []struct {
		token string
		color BrandColor
	}{
		{"--text-primary", ColorTextPrimary},
		{"--text-secondary", ColorTextSecondary},
		{"--text-tertiary", ColorTextTertiary},
		{"--text-disabled", ColorTextDisabled},
	}
	lum := func(hexColor string) int {
		var r, g, b int
		if _, err := fmt.Sscanf(hexColor, "#%02x%02x%02x", &r, &g, &b); err != nil {
			t.Fatalf("unparseable colour %q: %v", hexColor, err)
		}
		return r + g + b
	}
	for i := 1; i < len(ramp); i++ {
		prev, cur := ramp[i-1], ramp[i]
		// --text-tertiary is deliberately ONE ink in both themes (the console declares the same
		// value in :root and .dark), so the step into and out of it is allowed to be flat in one
		// direction. Everything else must move, and nothing may move backwards.
		if lum(cur.color.Light) < lum(prev.color.Light) {
			t.Errorf("light theme: %s (%s) is darker than %s (%s) — the ramp runs backwards",
				cur.token, cur.color.Light, prev.token, prev.color.Light)
		}
		if lum(cur.color.Dark) > lum(prev.color.Dark) {
			t.Errorf("dark theme: %s (%s) is lighter than %s (%s) — the ramp runs backwards",
				cur.token, cur.color.Dark, prev.token, prev.color.Dark)
		}
	}
	if lum(ColorTextPrimary.Light) >= lum(ColorTextDisabled.Light) {
		t.Error("light theme: the ends of the text ramp did not separate at all")
	}
	if lum(ColorTextPrimary.Dark) <= lum(ColorTextDisabled.Dark) {
		t.Error("dark theme: the ends of the text ramp did not separate at all")
	}
}

// TestBrandLayersAreAStrictOrder pins the reason the layer scale is worth projecting at all:
// bubbletea composites by hand, so the rungs have to answer "which covers which" by number.
// Two rungs sharing a value would make an overlay beat a header only by accident of ordering,
// which is exactly the accident the named scale exists to remove.
func TestBrandLayersAreAStrictOrder(t *testing.T) {
	order := []struct {
		token string
		layer BrandLayer
	}{
		{"--z-sticky-head", LayerStickyHead},
		{"--z-raised", LayerRaised},
		{"--z-sticky-bar", LayerStickyBar},
		{"--z-header", LayerHeader},
		{"--z-rail", LayerRail},
		{"--z-grain", LayerGrain},
		{"--z-frame", LayerFrame},
		{"--z-overlay", LayerOverlay},
		{"--z-overlay-nested", LayerOverlayNested},
		{"--z-toast", LayerToast},
	}
	if len(order) != len(BrandLayers) {
		t.Fatalf("the projection carries %d rungs and this test names %d — a rung was added or "+
			"removed and its position in the order was never decided", len(BrandLayers), len(order))
	}
	for i, rung := range order {
		if got, ok := BrandLayers[rung.token]; !ok || got != rung.layer {
			t.Errorf("BrandLayers[%s] = %d, want the constant %d", rung.token, got, rung.layer)
		}
		if i > 0 && rung.layer <= order[i-1].layer {
			t.Errorf("%s (%d) does not outrank %s (%d)", rung.token, rung.layer, order[i-1].token, order[i-1].layer)
		}
	}
	// The three relationships the stylesheet argues for by name, restated where Go can see them.
	if LayerOverlay <= LayerFrame {
		t.Error("an overlay must cover the page frame — a dropdown opened over the frame would be clipped")
	}
	if LayerOverlayNested <= LayerOverlay {
		t.Error("an overlay opened from inside another overlay must cover it")
	}
	if LayerToast <= LayerOverlayNested {
		t.Error("a toast reports on everything above, so it must outrank everything above")
	}
}

// TestBrandRadiiCollapseSixOntoTwo pins the single most visible decision in the projection,
// by NAME rather than by count: --radius-sm and --radius-md render as the same border on
// purpose, and a reader who "fixes" that will fail here with the reason attached.
func TestBrandRadiiCollapseSixOntoTwo(t *testing.T) {
	square := []string{"--radius-xs", "--radius-sm", "--radius-md"}
	rounded := []string{"--radius-lg", "--radius-xl", "--radius"}

	if len(BrandRadii) != len(square)+len(rounded) {
		t.Fatalf("the projection carries %d radii and this test names %d — a radius was added to "+
			"tokens.css and nobody decided which border it collapses onto", len(BrandRadii), len(square)+len(rounded))
	}
	for _, token := range square {
		if BrandRadii[token] != BorderSquare {
			t.Errorf("BrandRadii[%s] = %q, want BorderSquare — a cell has no sub-pixel below ~4px", token, BrandRadii[token])
		}
	}
	for _, token := range rounded {
		if BrandRadii[token] != BorderRounded {
			t.Errorf("BrandRadii[%s] = %q, want BorderRounded", token, BrandRadii[token])
		}
	}
	if BorderSquare == BorderRounded {
		t.Error("the two borders are the same value — the six-onto-two collapse became six-onto-one")
	}
}

// TestBrandEmphasisLadderHasThreeDistinctRungs pins the other collapse: a size scale becomes a
// ranking, and a ranking whose rungs are equal ranks nothing.
//
// THE TOKEN COUNT AND THE RUNG COUNT ARE TWO NUMBERS, and this test used to compare both against
// one `len(want)`. That was true only while the ladder was exactly one token per rung, and it
// stopped being true when the console's UI type scale landed (#3733): --text-ui-lg and
// --text-ui-xl are the console's two heading rungs, and in a terminal — which has one cell size —
// a heading is bold, so both collapse onto EmphasisHeading beside the display ladder's middle
// step. #3806 then added a FOURTH display rung, --text-display-xs, for display voice rendered
// inside the console shell; the browser tells it from --text-display-sm by four pixels and a
// terminal has no cells to spend on that, so it joins EmphasisBand. SIX tokens, THREE rungs.
// Collapsing is what this port is FOR; what must not happen is the rungs themselves collapsing,
// which is the assertion below and is unchanged.
func TestBrandEmphasisLadderHasThreeDistinctRungs(t *testing.T) {
	want := map[string]BrandEmphasis{
		"--text-display-lg": EmphasisDisplay,
		"--text-display-md": EmphasisHeading,
		"--text-display-sm": EmphasisBand,
		"--text-display-xs": EmphasisBand,
		"--text-ui-lg":      EmphasisHeading,
		"--text-ui-xl":      EmphasisHeading,
	}
	if len(BrandEmphasisLadder) != len(want) {
		t.Fatalf("the ladder carries %d tokens and this test names %d", len(BrandEmphasisLadder), len(want))
	}
	for token, rung := range want {
		if BrandEmphasisLadder[token] != rung {
			t.Errorf("BrandEmphasisLadder[%s] = %q, want %q", token, BrandEmphasisLadder[token], rung)
		}
	}
	distinct := map[BrandEmphasis]bool{}
	for _, rung := range BrandEmphasisLadder {
		distinct[rung] = true
	}
	// Three, named as a literal rather than derived from `want`: deriving it would make this
	// assertion agree with whatever the table says, which is the one thing it must not do.
	const rungs = 3
	if len(distinct) != rungs {
		t.Errorf("the ladder's %d tokens collapse onto %d rungs, want %d — a size scale that ranks nothing", len(want), len(distinct), rungs)
	}
}

// TestBrandDurationsAreNonZero pins the failure mode a duration has: a zero interval is a tick
// that never fires, which renders as a spinner that never spins rather than as an error.
func TestBrandDurationsAreNonZero(t *testing.T) {
	if len(BrandDurations) == 0 {
		t.Fatal("no durations were projected")
	}
	for token, d := range BrandDurations {
		if d <= 0 {
			t.Errorf("%s projects to %v — a non-positive tick interval never fires", token, d)
		}
	}
	if Dur1 >= Dur2 || Dur2 >= Dur3 || Dur3 >= Dur4 {
		t.Errorf("the motion vocabulary is not ordered: %v %v %v %v", Dur1, Dur2, Dur3, Dur4)
	}
}

// TestBrandFocusMarkersAreDistinctGlyphs pins the ring collapse: focus and invalid-focus are
// told apart by SHAPE here, because the palette is grayscale and cannot tell them apart by hue.
func TestBrandFocusMarkersAreDistinctGlyphs(t *testing.T) {
	if len(BrandFocusMarkers) == 0 {
		t.Fatal("nothing projects onto a focus marker — this test would pass while covering nothing")
	}
	// Swept from the generated map rather than from the two names below, so a THIRD marker
	// added later is held to the same two rules without anybody remembering to add it here.
	glyphs := map[string][]string{}
	for token, glyph := range BrandFocusMarkers {
		if glyph == "" {
			t.Errorf("%s projects to an empty marker — focus would be invisible rather than "+
				"differently drawn", token)
		}
		glyphs[glyph] = append(glyphs[glyph], token)
	}
	for glyph, tokens := range glyphs {
		if len(tokens) > 1 {
			t.Errorf("%v all draw %q, and the grayscale palette has no hue left to tell them apart with",
				tokens, glyph)
		}
	}
	if BrandFocusMarkers["--ring"] != FocusMarker || BrandFocusMarkers["--ring-invalid"] != FocusInvalidMarker {
		t.Errorf("BrandFocusMarkers does not match the constants: %v", BrandFocusMarkers)
	}
}

// TestEyebrowSeparatorIsOneCell pins what --tracking-eyebrow becomes. The token asks for
// letters pushed apart; the cell grid's smallest unit of "apart" is one cell, and a separator
// of zero or two would be a different device.
func TestEyebrowSeparatorIsOneCell(t *testing.T) {
	if EyebrowSeparator != " " {
		t.Errorf("EyebrowSeparator = %q, want a single space", EyebrowSeparator)
	}
	if TrackingEyebrowEm <= 0 {
		t.Errorf("TrackingEyebrowEm = %v — the eyebrow projects because its tracking is POSITIVE; "+
			"a non-positive value has nothing a cell grid can spend", TrackingEyebrowEm)
	}
}
