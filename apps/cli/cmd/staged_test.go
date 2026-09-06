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

func TestRunStagedList(t *testing.T) {
	cid := "comp-1"
	c := &fakeClient{staged: &api.StagedChanges{
		Environment: "production",
		Changes: []api.StagedChange{
			{ComponentType: "database", Op: "create", CreatedAt: "2026-01-01T00:00:00.000Z"},
			{ComponentType: "cache", Op: "update", ComponentID: &cid, CreatedAt: "2026-01-02T00:00:00.000Z"},
		},
	}}
	var buf bytes.Buffer
	if err := runStagedList(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runStagedList: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"database", "create", "cache", "update", "comp-1"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestRunStagedListJSON(t *testing.T) {
	c := &fakeClient{staged: &api.StagedChanges{Environment: "prod", Changes: []api.StagedChange{{ComponentType: "queue", Op: "delete", CreatedAt: "2026-01-01T00:00:00.000Z"}}}}
	var buf bytes.Buffer
	if err := runStagedList(c, &buf, "json", "proj", ""); err != nil {
		t.Fatalf("runStagedList json: %v", err)
	}
	if !strings.Contains(buf.String(), `"component_type": "queue"`) || !strings.Contains(buf.String(), `"op": "delete"`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunStagedListEmpty(t *testing.T) {
	c := &fakeClient{staged: &api.StagedChanges{Environment: "prod", Changes: nil}}
	var buf bytes.Buffer
	if err := runStagedList(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runStagedList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No staged changes") {
		t.Errorf("expected empty notice, got: %q", buf.String())
	}
}

func TestRunStagedListError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runStagedList(c, &bytes.Buffer{}, "table", "proj", ""); err == nil {
		t.Error("expected error to propagate")
	}
}

// TestRunStagedListCSVKeepsTheWireValues pins the machine reading of `staged list`.
//
// ui.Render writes spec.Rows VERBATIM in its CSV branch, so every cell stagedRows humanises is a
// cell a script receives. `Created` must stay the wire's RFC3339 — `9 Mar 2026, 15:04` neither
// sorts nor parses and has dropped the seconds and the zone — and a CREATE's absent `Component ID`
// must stay an EMPTY cell, because "—" (U+2014) is a value a script has to special-case where ""
// already means absent.
func TestRunStagedListCSVKeepsTheWireValues(t *testing.T) {
	c := &fakeClient{staged: &api.StagedChanges{
		Environment: "production",
		Changes: []api.StagedChange{
			{ComponentType: "database", Op: "create", CreatedAt: "2026-03-09T15:04:05Z"},
		},
	}}
	var buf bytes.Buffer
	if err := runStagedList(c, &buf, ui.FormatCSV, "proj", ""); err != nil {
		t.Fatalf("runStagedList csv: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "2026-03-09T15:04:05Z") {
		t.Errorf("csv Created is not the wire stamp:\n%s", out)
	}
	if strings.Contains(out, ui.SymbolDash) {
		t.Errorf("csv carries the dash glyph %q where an empty cell means absent:\n%s", ui.SymbolDash, out)
	}
	// The premise: the TABLE cell for the same instant is the humanised one, so the split is
	// guarding a difference that exists. Without this the assertions above would still pass with
	// stagedRows humanising nothing at all, which is a different defect.
	var tbl bytes.Buffer
	if err := runStagedList(c, &tbl, ui.FormatTable, "proj", ""); err != nil {
		t.Fatalf("runStagedList table: %v", err)
	}
	if !strings.Contains(tbl.String(), "9 Mar 2026, 15:04") {
		t.Fatalf("premise broken: the table Created cell is not the humanised stamp:\n%s", tbl.String())
	}
	if !strings.Contains(tbl.String(), ui.SymbolDash) {
		t.Fatalf("premise broken: the table Component ID cell is not the dash:\n%s", tbl.String())
	}
}
