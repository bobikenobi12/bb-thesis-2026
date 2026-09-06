// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestFormatSuccess_ContainsSymbolAndMessage(t *testing.T) {
	result := FormatSuccess("operation completed")
	if !strings.Contains(result, SymbolSuccess) {
		t.Errorf("expected %s in output, got: %s", SymbolSuccess, result)
	}
	if !strings.Contains(result, "operation completed") {
		t.Errorf("expected message in output, got: %s", result)
	}
}

func TestFormatError_ContainsSymbolAndMessage(t *testing.T) {
	result := FormatError("something broke")
	if !strings.Contains(result, SymbolError) {
		t.Errorf("expected %s in output, got: %s", SymbolError, result)
	}
	if !strings.Contains(result, "something broke") {
		t.Errorf("expected message in output, got: %s", result)
	}
}

// TestStatus drives the ONE styled renderer over the seven cases Go and the console were measured
// to disagree about (#3660), plus the two they always agreed on and the unknown-word fallback.
//
// The want values are written out as the glyph the CONSOLE draws for that tier, not read back
// from types.StatusGlyphOf: a test that asked the implementation what it does would pass for any
// vocabulary, including the wrong one this unit exists to replace.
func TestStatus(t *testing.T) {
	cases := []struct {
		status string
		glyph  string
		why    string
	}{
		{"ONLINE", SymbolOnline, "agreed before and after"},
		{"ACTIVE", SymbolOnline, "agreed before and after"},
		{"OFFLINE", SymbolOffline, "agreed before and after"},
		{"CREATING", SymbolPending, "agreed before and after"},
		{"FAILED", SymbolError, "agreed before and after"},
		// case 1 — CONTESTED. Go drew ◐; the console says idle, and the console owns the
		// vocabulary. Recorded here so the ruling is visible where the behaviour is.
		{"DRAINING", SymbolOffline, "case 1: the console's answer wins; Go used to draw the pending half-dot"},
		// case 2 — the em dash was the absence sentinel and is no longer a status glyph at all.
		{"DESTROYED", types.StatusGlyphDisabled, "case 2: was the em dash, which also means 'we could not fill this cell'"},
		// case 3 — one word, three renderings; now one.
		{"SUCCESS", SymbolOnline, "case 3: was ○ in jobs list and bold text in job wait"},
		// cases 4 and 5 — words the Go switch never had, so they fell to its default arm.
		{"PROCESSING", SymbolPending, "case 4: fell through to ○"},
		{"CLAIMED", SymbolPending, "case 4: fell through to ○"},
		{"DESTROYING", SymbolPending, "case 5: fell through to ○ while CREATING was ◐"},
		{"PENDING", SymbolPending, "case 5: fell through to ○"},
		// case 6 — the wire shouts for six pgEnums and whispers for the rest. Both are one word.
		{"active", SymbolOnline, "case 6: a lower-case pgEnum value used to hit the default arm"},
		{"provisioning", SymbolPending, "case 6: same"},
		// case 7 — a promotion status is an ordinary word and needed a renderer, not a special case.
		{"DEPLOYING", SymbolPending, "case 7: promotion.go printed the raw enum"},
		{"SUCCEEDED", SymbolOnline, "case 7: same"},
		// The promotion vocabulary — six enum values that had no word at all and drew the idle
		// hollow dot on both surfaces, which is a WRONG signal rather than a missing one on the
		// table an operator reads to find what is holding a promotion up. #4117.
		{"APPROVED", SymbolOnline, "promotion: a decision was made and it was yes; drew ○"},
		{"approved", SymbolOnline, "the approval slot's own lower-case spelling of the same word"},
		{"BLOCKED", SymbolError, "promotion: a hard gate failed — terminal and negative; drew ○"},
		{"rejected", SymbolError, "the approval slot's terminal negative; drew ○, same as approved"},
		{"PENDING_APPROVAL", SymbolPending, "waiting on a human, which is not its final answer; drew ○"},
		{"PENDING_PLAN", SymbolPending, "a PLAN job is queued — genuinely in flight; drew ○"},
		// The fallback, which is silent by design on both surfaces.
		{"SOMETHING_ELSE", SymbolOffline, "unknown words resolve to idle, as they do in the console"},
	}
	for _, c := range cases {
		t.Run(c.status, func(t *testing.T) {
			got := Status(c.status)
			if !strings.Contains(got, c.glyph) {
				t.Errorf("Status(%q) = %q, want the glyph %q — %s", c.status, got, c.glyph, c.why)
			}
			// The word has to survive the styling. formatJobStatus was deleted for rendering the
			// text with no glyph; a renderer with a glyph and no text is the same defect mirrored.
			if !strings.Contains(got, strings.ToLower(c.status)) {
				t.Errorf("Status(%q) = %q, want it to carry the status word", c.status, got)
			}
		})
	}
}

// TestStatusIsStatusCellInInk pins that the styled renderer and the table cell cannot disagree.
// Two renderers that agreed on ACTIVE and not on DESTROYED is exactly what this unit deleted.
func TestStatusIsStatusCellInInk(t *testing.T) {
	for _, status := range []string{"ACTIVE", "DRAINING", "FAILED", "DESTROYED", "whatever", ""} {
		if !strings.Contains(Status(status), StatusCell(status)) {
			t.Errorf("Status(%q) = %q does not carry StatusCell(%q) = %q", status, Status(status), status, StatusCell(status))
		}
	}
}

// TestStatusInkCoversEveryTier reads the tier list OUT OF THE GENERATED FILE, so a tier added to
// the console fails here rather than rendering in lipgloss's zero style — which is not a different
// weight, it is no weight at all, and looks exactly like a tier somebody decided should be plain.
func TestStatusInkCoversEveryTier(t *testing.T) {
	if len(types.AllStatusTiers) == 0 {
		t.Fatal("types.AllStatusTiers is empty — this test would pass by measuring nothing")
	}
	for _, tier := range types.AllStatusTiers {
		if _, ok := statusInk[tier]; !ok {
			t.Errorf("the tier %q has no entry in statusInk — decide what weight the terminal draws it in", tier)
		}
	}
	if len(statusInk) != len(types.AllStatusTiers) {
		t.Errorf("statusInk has %d entries for %d tiers — one of them names a tier the console no longer has",
			len(statusInk), len(types.AllStatusTiers))
	}
}

// TestSymbolsMirrorTheVocabulary pins the four aliases. They are separate names for the generated
// glyphs, kept because ~30 call sites spell them this way, and a name that stopped tracking its
// value would be the second definition this unit removed.
func TestSymbolsMirrorTheVocabulary(t *testing.T) {
	cases := map[string][2]string{
		"SymbolOnline":  {SymbolOnline, types.StatusGlyphActive},
		"SymbolOffline": {SymbolOffline, types.StatusGlyphIdle},
		"SymbolPending": {SymbolPending, types.StatusGlyphPending},
		"SymbolError":   {SymbolError, types.StatusGlyphFailed},
	}
	for name, pair := range cases {
		if pair[0] != pair[1] {
			t.Errorf("%s = %q but the generated vocabulary says %q", name, pair[0], pair[1])
		}
	}
	// The dash is the one glyph that must NOT be a tier's, because it is what every OrDash helper
	// returns for a cell nobody could fill.
	for tier, glyph := range types.StatusGlyphs {
		if glyph == SymbolDash {
			t.Errorf("the tier %q draws the empty-value sentinel %q — a status and an unknown value would be the same cell", tier, SymbolDash)
		}
	}
}

func TestDefaultBadge_ContainsMark(t *testing.T) {
	result := DefaultBadge()
	if !strings.Contains(result, SymbolDefault) {
		t.Errorf("expected default mark, got: %s", result)
	}
}

func TestSymbolConstants(t *testing.T) {
	if SymbolSuccess != "✓" {
		t.Errorf("SymbolSuccess should be ✓, got %s", SymbolSuccess)
	}
	if SymbolError != "✗" {
		t.Errorf("SymbolError should be ✗, got %s", SymbolError)
	}
	if SymbolOnline != "●" {
		t.Errorf("SymbolOnline should be ●, got %s", SymbolOnline)
	}
	if SymbolOffline != "○" {
		t.Errorf("SymbolOffline should be ○, got %s", SymbolOffline)
	}
}

// TestStatusGlyphsAreDisjointFromSymbols is the half of the collision question the generator
// cannot ask. `gen-go-vocab.ts` refuses an undeclared collision BETWEEN TWO TIERS, because both
// sides of that one are in the table it owns; the CLI's other symbols are not, and one of them
// collided anyway.
//
// The measured case: `StatusGlyphDisabled` was `·`, `SymbolBullet` is `·`, and `opsPickProjectID`
// builds a label as `PlainGlyph(status) + name + SymbolBullet + …` — so a DESTROYED project read
// as `· my-project · prod · a1b2c3d4`, its leading glyph indistinguishable from a separator and
// the label appearing to open on an empty field. Same shape in opsPickEnvironmentID and
// pickCluster, and in any row that puts a disabled status cell beside a bulleted one.
//
// The four status-named symbols are deliberately EXCLUDED: SymbolOnline, SymbolOffline,
// SymbolPending and SymbolError are aliases OF these glyphs, so including them would fail by
// construction and the test would have to be deleted rather than obeyed.
func TestStatusGlyphsAreDisjointFromSymbols(t *testing.T) {
	if len(types.StatusGlyphs) == 0 {
		t.Fatal("types.StatusGlyphs is empty — this test would pass by measuring nothing")
	}
	nonStatus := map[string]string{
		"SymbolSuccess": SymbolSuccess,
		"SymbolDefault": SymbolDefault,
		"SymbolDash":    SymbolDash,
		"SymbolBullet":  SymbolBullet,
		"SymbolArrow":   SymbolArrow,
		"SymbolPoint":   SymbolPoint,
	}
	for tier, glyph := range types.StatusGlyphs {
		for name, symbol := range nonStatus {
			if glyph == symbol {
				t.Errorf("the %q tier draws %q, which is also %s. A status and a %s are two meanings in one rune, "+
					"and they meet inside a picker label (ops_prompt.go) where the reader cannot tell them apart. "+
					"Move the TIER (apps/console/scripts/lib/status-vocab.ts) rather than the symbol — the symbols "+
					"are the older and wider convention — then regenerate.",
					tier, glyph, name, strings.TrimPrefix(name, "Symbol"))
			}
		}
	}
}

// TestStatusVerbatimKeepsTheWireCasing pins the plain-text contract that `Status` broke.
//
// `jobs logs --follow` closes with `--- Job <status> ---` and `job wait` prints `  Status: …`;
// NEITHER command has a machine format, so those lines ARE the machine contract and `grep -q
// SUCCESS` in somebody's CI script is the consumer. Routing them through the table cell
// lower-cased the word. The glyph is gained, the word is untouched.
func TestStatusVerbatimKeepsTheWireCasing(t *testing.T) {
	for _, status := range []string{"SUCCESS", "FAILED", "CANCELLED", "PROCESSING", "active"} {
		got := StatusVerbatim(status)
		if !strings.Contains(got, status) {
			t.Errorf("StatusVerbatim(%q) = %q, which does not carry the status as the wire spelled it — "+
				"`grep -q %s` in a CI script stops matching", status, got, status)
		}
		if !strings.Contains(got, PlainGlyph(status)) {
			t.Errorf("StatusVerbatim(%q) = %q, want it to lead with the glyph %q", status, got, PlainGlyph(status))
		}
	}
	// The distinction from Status, stated both ways: same glyph, different spelling. A shouting
	// status is the case that separates them, so it is the one asserted.
	if StatusVerbatim("SUCCESS") == Status("SUCCESS") {
		t.Error("StatusVerbatim and Status render a shouting status identically — one of them has stopped doing its job")
	}
	if !strings.Contains(Status("SUCCESS"), "success") {
		t.Error("Status no longer lower-cases; the table cell and the plain-text line have converged the wrong way")
	}
}
