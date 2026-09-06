// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func iptr(v int) *int { return &v }

func TestRunProtectionList(t *testing.T) {
	c := &fakeClient{protection: []api.ProtectionRule{
		{Environment: "production", RequirePredecessor: true, RequireVerifyPass: true, RequireApproval: true, MinCount: iptr(2), SoakMinutes: iptr(30), CostDeltaThreshold: f64(100)},
		{Environment: "staging", RequirePredecessor: false, RequireVerifyPass: true, RequireApproval: false},
	}}
	var buf bytes.Buffer
	if err := runProtectionList(c, &buf, "table", "proj"); err != nil {
		t.Fatalf("runProtectionList: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"production", "staging", "$100.00", "30", "2"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestRunProtectionListJSON(t *testing.T) {
	c := &fakeClient{protection: []api.ProtectionRule{{Environment: "production", RequireApproval: true}}}
	var buf bytes.Buffer
	if err := runProtectionList(c, &buf, "json", "proj"); err != nil {
		t.Fatalf("runProtectionList json: %v", err)
	}
	if !strings.Contains(buf.String(), `"require_approval": true`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunProtectionListEmpty(t *testing.T) {
	c := &fakeClient{protection: nil}
	var buf bytes.Buffer
	if err := runProtectionList(c, &buf, "table", "proj"); err != nil {
		t.Fatalf("runProtectionList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No protection rules") {
		t.Errorf("expected empty notice, got: %q", buf.String())
	}
}

func TestRunProtectionListError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runProtectionList(c, &bytes.Buffer{}, "table", "proj"); err == nil {
		t.Error("expected error to propagate")
	}
}

// gateGlyph / intOrDash / floatOrDash render nil limits and off-gates as the dash glyph.
func TestProtectionCellHelpers(t *testing.T) {
	if ui.GateGlyph(false) != ui.SymbolDash || ui.GateGlyph(true) != ui.SymbolSuccess {
		t.Error("gateGlyph glyphs wrong")
	}
	if ui.IntOrDash(nil) != ui.SymbolDash || ui.IntOrDash(iptr(5)) != "5" {
		t.Error("intOrDash wrong")
	}
	if ui.FloatOrDash(nil) != ui.SymbolDash || ui.FloatOrDash(f64(1.5)) != "$1.50" {
		t.Error("floatOrDash wrong")
	}
}
