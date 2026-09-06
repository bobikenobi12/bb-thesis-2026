// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

func testCmd(output string, noInput bool) *cobra.Command {
	c := &cobra.Command{Use: "x"}
	c.Flags().String("output", output, "")
	c.Flags().Bool("no-input", noInput, "")
	return c
}

func TestOutputFormat(t *testing.T) {
	if got := outputFormat(testCmd("json", false)); got != "json" {
		t.Errorf("expected json, got %q", got)
	}
	if got := outputFormat(testCmd("table", false)); got != "table" {
		t.Errorf("expected table, got %q", got)
	}
}

func TestInteractiveTable(t *testing.T) {
	// Non-table format is never interactive.
	if interactiveTable(testCmd("json", false)) {
		t.Error("json should not be interactive")
	}
	// In the test process stdout is not a TTY, so table is also non-interactive.
	if interactiveTable(testCmd("table", false)) {
		t.Error("non-TTY table should not be interactive")
	}
	// no-input forces non-interactive.
	prev := noInputMode
	noInputMode = true
	defer func() { noInputMode = prev }()
	if interactiveTable(testCmd("table", true)) {
		t.Error("no-input should not be interactive")
	}
}

func TestResolveInputMode(t *testing.T) {
	prev := noInputMode
	defer func() { noInputMode = prev }()

	resolveInputMode(testCmd("table", true))
	if !noInputMode {
		t.Error("--no-input should set noInputMode")
	}
	// Without the flag, a non-TTY stdin (the test process) also yields no-input.
	resolveInputMode(testCmd("table", false))
	if !noInputMode {
		t.Error("non-TTY stdin should set noInputMode")
	}
}

func TestRequireInteractive(t *testing.T) {
	prev := noInputMode
	defer func() { noInputMode = prev }()

	noInputMode = true
	if err := requireInteractive(); err == nil {
		t.Error("expected errNoInput when no-input")
	}
	noInputMode = false
	if err := requireInteractive(); err != nil {
		t.Errorf("expected nil when interactive, got %v", err)
	}
}

func TestRunnerOperatorLabel(t *testing.T) {
	cases := []struct {
		in   api.Runner
		want string
	}{
		{api.Runner{Operator: "managed"}, "managed"},
		{api.Runner{Operator: "self", Provisioning: "deployed"}, "self·deployed"},
		{api.Runner{Operator: "self", Provisioning: "registered"}, "self·registered"},
		{api.Runner{Operator: "self"}, "self"},
	}
	for _, c := range cases {
		if got := runnerOperatorLabel(c.in); got != c.want {
			t.Errorf("runnerOperatorLabel(%+v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestTruncID(t *testing.T) {
	if got := ui.TruncID("0123456789"); got != "01234567…" {
		t.Errorf("truncID long: %q", got)
	}
	if got := ui.TruncID("short"); got != "short" {
		t.Errorf("truncID short: %q", got)
	}
}

func TestFormatDuration(t *testing.T) {
	start := time.Now().Add(-90 * time.Second)
	end := time.Now()
	if got := formatDuration(&start, &end); got == ui.SymbolDash {
		t.Error("expected a duration, got dash")
	}
	if got := formatDuration(nil, nil); got != ui.SymbolDash {
		t.Errorf("nil start should be dash, got %q", got)
	}
	// Running (no completion) gets the ellipsis suffix.
	s2 := time.Now().Add(-30 * time.Second)
	if got := formatDuration(&s2, nil); got[len(got)-len("…"):] != "…" {
		t.Errorf("running duration should end with ellipsis, got %q", got)
	}
	// Hour-scale.
	hs := time.Now().Add(-2 * time.Hour)
	he := time.Now()
	if got := formatDuration(&hs, &he); got == "" {
		t.Error("expected hour-scale duration")
	}
}

func TestFormatTime(t *testing.T) {
	if got := ui.SmartTime(time.Time{}); got != ui.SymbolDash {
		t.Errorf("zero time should be dash, got %q", got)
	}
	if got := ui.SmartTime(time.Now()); got == ui.SymbolDash {
		t.Error("recent time should be humanized")
	}
	// A FIXED instant and a LITERAL. This asserted `len(got) != len("2006-01-02")`, which was
	// already a weak test — it passed for any ten-character string — and became a wrong one when
	// #3659 moved the absolute rendering to `format.Date(DateOnly)`, where a two-digit day is
	// eleven characters and a one-digit day is ten. A length is not a format.
	old := time.Date(2020, 3, 9, 15, 4, 5, 0, time.UTC)
	if got := ui.SmartTime(old); got != "9 Mar 2020" {
		t.Errorf("old time should be the console's absolute date, got %q want %q", got, "9 Mar 2020")
	}
}

func TestFormatCreatedAt(t *testing.T) {
	if got := ui.RelativeTime(""); got != ui.SymbolDash {
		t.Errorf("empty should be dash, got %q", got)
	}
	if got := ui.RelativeTime("not-a-time"); got != "not-a-time" {
		t.Errorf("unparseable should pass through, got %q", got)
	}
	if got := ui.RelativeTime("2026-01-01T00:00:00Z"); got == "" {
		t.Error("valid time should humanize")
	}
}

func TestJobFieldRows(t *testing.T) {
	msg := "kaboom"
	started := time.Now()
	job := &api.ProvisionJob{
		ID: "j1", JobType: "DEPLOY", Status: "FAILED",
		CreatedAt: time.Now(), StartedAt: &started,
		ProjectID: "p1", RunnerID: "r1", PlanJobID: "pj1",
		ErrorMessage: &msg,
	}
	rows := jobFieldRows(job)
	want := map[string]bool{"ID": false, "Type": false, "Status": false, "Created": false, "Started": false, "Project ID": false, "Runner ID": false, "Plan Job ID": false, "Error": false}
	for _, r := range rows {
		if _, ok := want[r[0]]; ok {
			want[r[0]] = true
		}
	}
	for k, seen := range want {
		if !seen {
			t.Errorf("jobFieldRows missing %q", k)
		}
	}

	// A bare job omits the optional fields.
	bare := &api.ProvisionJob{ID: "j2", JobType: "PLAN", Status: "QUEUED", CreatedAt: time.Now()}
	if len(jobFieldRows(bare)) != 4 {
		t.Errorf("bare job should have 4 field rows, got %d", len(jobFieldRows(bare)))
	}
}

func TestJobTypeLabels(t *testing.T) {
	if jobTypeLabels["PLAN"] != "Plan" {
		t.Error("expected PLAN label")
	}
	if _, ok := jobTypeLabels["DEPLOY_RUNNER"]; !ok {
		t.Error("expected DEPLOY_RUNNER label")
	}
}
