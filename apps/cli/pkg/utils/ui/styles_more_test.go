// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"strings"
	"testing"
)

func TestEyebrow(t *testing.T) {
	got := Eyebrow("control plane")
	// Uppercased and letter-spaced.
	if !strings.Contains(got, "C") || !strings.Contains(got, "O") {
		t.Errorf("eyebrow not uppercased: %q", got)
	}
	if !strings.Contains(got, "C O") {
		t.Errorf("eyebrow not letter-spaced: %q", got)
	}
}

func TestRenderMark(t *testing.T) {
	if !strings.Contains(RenderMark(), Mark) {
		t.Errorf("RenderMark missing %q: %q", Mark, RenderMark())
	}
}

// TestPlainGlyph covers the unstyled half. Three rows differ from what PlainStatusDot returned
// and each is a defect it closed: DRAINING (the contested case, decided the console's way),
// DESTROYED (was the em dash it shared with "we could not fill this cell"), and the two
// lower-case rows, which used to miss every arm of an unfolded switch.
//
// DESTROYED is `◌` and not `·`: the middot is ui.SymbolBullet, the separator inside a picker
// label, and the label starts with this glyph. See TestStatusGlyphsAreDisjointFromSymbols.
func TestPlainGlyph(t *testing.T) {
	cases := map[string]string{
		"ONLINE":       SymbolOnline,
		"ACTIVE":       SymbolOnline,
		"DRAINING":     SymbolOffline,
		"PROVISIONING": SymbolPending,
		"QUEUED":       SymbolPending,
		"FAILED":       SymbolError,
		"DESTROYED":    "◌",
		"WHATEVER":     SymbolOffline,
		"active":       SymbolOnline,
		"AcTiVe":       SymbolOnline,
		"":             SymbolOffline,
	}
	for status, want := range cases {
		if got := PlainGlyph(status); got != want {
			t.Errorf("PlainGlyph(%q) = %q, want %q", status, got, want)
		}
	}
}

// The message helpers print to stdout; exercise them so a regression in the
// styling pipeline (e.g. a nil style) surfaces as a panic in tests.
func TestMessageHelpersDoNotPanic(t *testing.T) {
	Success("ok")
	Error("bad")
	Warning("warn")
	Info("info")
	Muted("muted")
	JobQueued("PLAN", "job-1")
}
