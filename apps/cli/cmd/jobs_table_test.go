// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestJobStatusRendersThroughTheOneVocabulary covers what `--wait` and `jobs logs --follow` print.
//
// It replaces TestFormatJobStatus, which asserted only that the status TEXT survived — an
// assertion formatJobStatus passed while rendering SUCCESS and FAILED in the identical bold
// strong ink, because three of its five lipgloss styles are one style in a grayscale palette. The
// word surviving was never the property worth pinning; the two statuses being TELLABLE APART is.
func TestJobStatusRendersThroughTheOneVocabulary(t *testing.T) {
	for _, status := range []string{"QUEUED", "CLAIMED", "PROCESSING", "SUCCESS", "FAILED", "CANCELLED", "SOMETHING_NEW"} {
		t.Run(status, func(t *testing.T) {
			got := ui.Status(status)
			if !strings.Contains(got, strings.ToLower(status)) {
				t.Errorf("ui.Status(%q) = %q; the status word must survive styling", status, got)
			}
		})
	}
	if ui.Status("SUCCESS") == ui.Status("FAILED") {
		t.Error("`job wait` renders SUCCESS and FAILED identically — that was formatJobStatus's defect, not something to carry forward")
	}
	// The pair that made it a defect rather than a cosmetic complaint: the palette has no hue, so
	// two statuses are told apart by SHAPE or not at all.
	if !strings.Contains(ui.Status("SUCCESS"), ui.SymbolOnline) || !strings.Contains(ui.Status("FAILED"), ui.SymbolError) {
		t.Errorf("SUCCESS = %q and FAILED = %q must carry their own glyphs", ui.Status("SUCCESS"), ui.Status("FAILED"))
	}
}

// TestJobColumnsMatchRowWidth covers the TUI table projection: jobRows must emit
// exactly one cell per declared column, or the Bubble Tea table renders skewed.
func TestJobColumnsMatchRowWidth(t *testing.T) {
	cols := jobColumns()
	if len(cols) == 0 {
		t.Fatal("jobColumns returned no columns")
	}
	started := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	completed := started.Add(90 * time.Second)
	rows := jobRows([]api.ProvisionJob{
		{ID: "j1", JobType: "DEPLOY", Status: "SUCCESS", ProjectName: "web", RunnerName: "r1",
			CreatedAt: started, StartedAt: &started, CompletedAt: &completed},
		{ID: "j2", JobType: "PLAN", Status: "QUEUED", CreatedAt: started},
	})
	if len(rows) != 2 {
		t.Fatalf("jobRows returned %d rows, want 2", len(rows))
	}
	for i, r := range rows {
		if len(r) != len(cols) {
			t.Errorf("row %d has %d cells, want %d (one per column)", i, len(r), len(cols))
		}
	}
	if rows[0][0] != "DEPLOY" && rows[0][0] == "" {
		t.Errorf("row 0 type cell is empty: %v", rows[0])
	}
}

// TestJobRowsEmpty covers the empty-page projection.
func TestJobRowsEmpty(t *testing.T) {
	if got := jobRows(nil); len(got) != 0 {
		t.Errorf("jobRows(nil) = %v, want no rows", got)
	}
}

// TestProjectSummaryRows covers the csv projection of `project get`: the scalar
// fields are always present and the timestamp row only appears when set.
func TestProjectSummaryRows(t *testing.T) {
	base := types.Configuration{
		ID:                "cfg-1",
		ProjectName:       "web",
		EnvironmentStage:  types.EnvironmentStage("development"),
		ContainerPlatform: "eks",
		CloudAccountID:    "acct-1",
		Region:            "eu-west-1",
		IacVersion:        "1.9.0",
	}

	rows := projectSummaryRows(base)
	if len(rows) != 7 {
		t.Fatalf("projectSummaryRows without a timestamp returned %d rows, want 7", len(rows))
	}
	fields := map[string]string{}
	for _, r := range rows {
		if len(r) != 2 {
			t.Fatalf("row %v is not a field/value pair", r)
		}
		fields[r[0]] = r[1]
	}
	for field, want := range map[string]string{
		"ID":          "cfg-1",
		"Project":     "web",
		"Environment": "development",
		"Region":      "eu-west-1",
		"IaC Version": "1.9.0",
	} {
		if fields[field] != want {
			t.Errorf("field %q = %q, want %q", field, fields[field], want)
		}
	}

	withTime := base
	withTime.UpdatedAt = time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	rows = projectSummaryRows(withTime)
	if len(rows) != 8 {
		t.Fatalf("projectSummaryRows with a timestamp returned %d rows, want 8", len(rows))
	}
	last := rows[len(rows)-1]
	// `4 Mar 2026, 05:06` since #3659 — the console's one absolute date, in UTC. It was
	// `2006-01-02 15:04:05`, one of five copies of that layout literal in the CLI.
	if last[0] != "Last Updated" || last[1] != "4 Mar 2026, 05:06" {
		t.Errorf("last row = %v, want the formatted Last Updated row", last)
	}
}
