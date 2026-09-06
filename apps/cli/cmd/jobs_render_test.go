// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
)

// What the jobs group PRINTS. Two of these renderings were the defects this unit exists to fix:
// a duration rule written a second time in this package, and a cost line that was not a
// rendering at all.

// TestFormatDuration_RollsIntoHours pins the elapsed rule against `packages/core/format`.
//
// The expected strings are literals, not calls to format.Duration: asserting the subject against
// itself would pass with the two rules disagreeing, which is the disagreement the epic ruled on.
func TestFormatDuration_RollsIntoHours(t *testing.T) {
	start := time.Date(2026, 3, 9, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name string
		d    time.Duration
		want string
	}{
		{"under a minute", 47 * time.Second, "47s"},
		{"a whole minute", time.Minute, "1m 0s"},
		{"minutes and seconds", 3*time.Minute + 20*time.Second, "3m 20s"},
		{"one second short of an hour", time.Hour - time.Second, "59m 59s"},
		{"exactly an hour", time.Hour, "1h 0m"},
		// The ruling: a two-hour provision reads 2h 5m, and the seconds go, because at an hour
		// they stop being information. The console rendered this as 125m 5s.
		{"over an hour", 2*time.Hour + 5*time.Minute + 41*time.Second, "2h 5m"},
		{"zero", 0, "0s"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			end := start.Add(tc.d)
			if got := formatDuration(&start, &end); got != tc.want {
				t.Errorf("formatDuration over %s = %q, want %q", tc.d, got, tc.want)
			}
		})
	}
}

// TestFormatDuration_UnstartedAndRunning pins the two parts that are NOT the shared rule: a job
// that never started is the dash, and a running one carries the ellipsis that says the number is
// still climbing.
func TestFormatDuration_UnstartedAndRunning(t *testing.T) {
	if got := formatDuration(nil, nil); got != ui.SymbolDash {
		t.Errorf("formatDuration(nil, nil) = %q, want the shared dash sentinel", got)
	}
	completed := time.Now()
	if got := formatDuration(nil, &completed); got != ui.SymbolDash {
		t.Errorf("a completed-but-never-started job = %q, want the dash", got)
	}

	started := time.Now().Add(-90 * time.Second)
	running := formatDuration(&started, nil)
	if !strings.HasSuffix(running, "…") {
		t.Errorf("a running job = %q, want a trailing ellipsis", running)
	}
	if strings.HasSuffix(strings.TrimSuffix(running, "…"), "…") {
		t.Errorf("a running job = %q, want exactly one ellipsis", running)
	}
	if !strings.HasPrefix(running, "1m ") {
		t.Errorf("a job running for 90s = %q, want it to start at 1m", running)
	}

	done := started.Add(90 * time.Second)
	if got := formatDuration(&started, &done); strings.Contains(got, "…") {
		t.Errorf("a finished job = %q, want no ellipsis", got)
	}
}

// TestJobStamp_MatchesTheSharedDateShape pins the absolute-timestamp rendering. The literal is
// the shape `@repo/format` produces on the console, which is the whole point of moving off the
// local `2006-01-02 15:04:05` layout this card used to carry.
func TestJobStamp_MatchesTheSharedDateShape(t *testing.T) {
	at := time.Date(2026, 3, 9, 15, 4, 5, 0, time.UTC)
	if got, want := jobStamp(at), "9 Mar 2026, 15:04"; got != want {
		t.Errorf("jobStamp = %q, want %q", got, want)
	}
	// The zone is a parameter and not the host's, so two people reading one job read one time.
	tokyo := at.In(time.FixedZone("JST", 9*3600))
	if got, want := jobStamp(tokyo), "9 Mar 2026, 15:04"; got != want {
		t.Errorf("jobStamp of the same instant in another zone = %q, want %q", got, want)
	}
	if got := jobStamp(time.Time{}); got != format.Dash {
		t.Errorf("jobStamp of the zero time = %q, want the dash rather than a year 1 date", got)
	}
}

// jobsMeta wraps a metadata map the way the API client hands it over.
func jobsMeta(m map[string]interface{}) *map[string]interface{} { return &m }

// TestJobCostSummary_RendersTheBreakdown is the fix for job_wait.go's raw `%v` over a decoded
// map. The input here is the shape `packages/core/infracost.CostBreakdown` marshals to, which
// is what the Runner actually writes to execution_metadata.
func TestJobCostSummary_RendersTheBreakdown(t *testing.T) {
	for _, tc := range []struct {
		name string
		meta map[string]interface{}
		want string
	}{
		{
			name: "summary total and resource counts",
			meta: map[string]interface{}{"cost_breakdown": map[string]interface{}{
				"currency":         "USD",
				"totalMonthlyCost": "124.56",
				"summary": map[string]interface{}{
					"total_monthly": 124.56, "resources_with_cost": 12.0, "resources_free": 3.0,
				},
			}},
			want: "$124.56/mo (12 priced, 3 free)",
		},
		{
			name: "no summary — the decimal string is parsed",
			meta: map[string]interface{}{"cost_breakdown": map[string]interface{}{
				"currency": "EUR", "totalMonthlyCost": "72.00",
			}},
			want: "€72.00/mo",
		},
		{
			// The half-away-from-zero rule the shared formatter exists for. Go's own %.0f
			// rounds half to EVEN and would render 12.
			name: "a half unit rounds the way the console rounds",
			meta: map[string]interface{}{"cost_breakdown": map[string]interface{}{
				"currency": "USD", "totalMonthlyCost": "12.505",
			}},
			want: "$12.51/mo",
		},
		{
			// Sub-unit: `$0.00/mo` would read as free, which is the one answer that is worse
			// than a number nobody expected.
			name: "under one unit is not rounded to free",
			meta: map[string]interface{}{"cost_breakdown": map[string]interface{}{
				"currency": "USD", "summary": map[string]interface{}{"total_monthly": 0.4},
			}},
			want: "<$1/mo",
		},
		{
			name: "zero is zero, not 'less than'",
			meta: map[string]interface{}{"cost_breakdown": map[string]interface{}{
				"currency": "USD", "summary": map[string]interface{}{"total_monthly": 0.0},
			}},
			want: "$0/mo",
		},
		{
			// A currency with no symbol keeps the number and states the code. It never guesses
			// a glyph onto an amount.
			name: "an unknown currency keeps its ISO code",
			meta: map[string]interface{}{"cost_breakdown": map[string]interface{}{
				"currency": "HUF", "totalMonthlyCost": "4500",
			}},
			want: "4,500.00 HUF/mo",
		},
		{
			name: "no currency defaults to USD",
			meta: map[string]interface{}{"cost_breakdown": map[string]interface{}{
				"totalMonthlyCost": "10.00",
			}},
			want: "$10.00/mo",
		},
		{
			name: "a numeric total, not a string",
			meta: map[string]interface{}{"cost_breakdown": map[string]interface{}{
				"currency": "USD", "totalMonthlyCost": 8.5,
			}},
			want: "$8.50/mo",
		},
		{
			// The counts are omitted rather than printed as zero: "0 free" is noise.
			name: "zero counts are left out",
			meta: map[string]interface{}{"cost_breakdown": map[string]interface{}{
				"currency": "USD",
				"summary": map[string]interface{}{
					"total_monthly": 5.0, "resources_with_cost": 1.0, "resources_free": 0.0,
				},
			}},
			want: "$5.00/mo (1 priced)",
		},
		{
			name: "a plain string is passed through, not dropped",
			meta: map[string]interface{}{"cost_breakdown": "  €72/mo  "},
			want: "€72/mo",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := jobCostSummary(jobsMeta(tc.meta)); got != tc.want {
				t.Errorf("jobCostSummary = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestJobCostSummary_SaysNothingRatherThanZero pins the silent cases. A breakdown the CLI cannot
// read is not a project that costs nothing, so the line is omitted rather than rendered as $0.
func TestJobCostSummary_SaysNothingRatherThanZero(t *testing.T) {
	for _, tc := range []struct {
		name string
		meta *map[string]interface{}
	}{
		{"no metadata at all", nil},
		{"metadata without the key", jobsMeta(map[string]interface{}{"plan_completed": true})},
		{"an explicit null", jobsMeta(map[string]interface{}{"cost_breakdown": nil})},
		{"a shape nobody expects", jobsMeta(map[string]interface{}{"cost_breakdown": 42})},
		{"an object with no total", jobsMeta(map[string]interface{}{
			"cost_breakdown": map[string]interface{}{"currency": "USD", "version": "0.2"},
		})},
		{"an unparsable total", jobsMeta(map[string]interface{}{
			"cost_breakdown": map[string]interface{}{"currency": "USD", "totalMonthlyCost": "n/a"},
		})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := jobCostSummary(tc.meta); got != "" {
				t.Errorf("jobCostSummary = %q, want the line to be omitted", got)
			}
		})
	}
}

// TestJobFieldRows_CarriesTheCostEstimate pins that the card and `--wait` read the SAME
// renderer: the row exists, and it holds what jobCostSummary returned.
func TestJobFieldRows_CarriesTheCostEstimate(t *testing.T) {
	meta := map[string]interface{}{"cost_breakdown": map[string]interface{}{
		"currency": "USD", "totalMonthlyCost": "31.00",
	}}
	rows := jobFieldRows(&api.ProvisionJob{
		ID: "j1", JobType: "PLAN", Status: "SUCCESS",
		CreatedAt: time.Date(2026, 3, 9, 15, 4, 5, 0, time.UTC), ExecutionMetadata: &meta,
	})
	found := ""
	for _, r := range rows {
		if r[0] == "Cost estimate" {
			found = r[1]
		}
	}
	if found != "$31.00/mo" {
		t.Errorf("the Cost estimate row = %q, want $31.00/mo", found)
	}

	// A job with no cost data carries no row — an empty cell would claim we asked and got nothing.
	bare := jobFieldRows(&api.ProvisionJob{ID: "j2", JobType: "PLAN", Status: "QUEUED"})
	for _, r := range bare {
		if r[0] == "Cost estimate" {
			t.Errorf("a job with no cost data still rendered a Cost estimate row: %q", r[1])
		}
	}
}

// TestWriteJobLogs_RendersEachStreamAndAdvances covers the log loop's projection. It used to be
// two byte-identical copies of this switch — the polling pass and the final drain — so a change
// to how STDERR renders had to be made in both or the two halves of one stream disagreed.
func TestWriteJobLogs_RendersEachStreamAndAdvances(t *testing.T) {
	var buf bytes.Buffer
	logs := []api.JobLog{
		{ID: 3, StreamType: "STDOUT", LogChunk: "plan: 3 to add\n"},
		{ID: 7, StreamType: "STDERR", LogChunk: "Error: quota exceeded\n"},
		{ID: 5, StreamType: "SYSTEM", LogChunk: "runner claimed\n"},
		{ID: 9, StreamType: "SOMETHING_NEW", LogChunk: "unknown stream\n"},
	}
	last := writeJobLogs(&buf, logs, 2)
	if last != 9 {
		t.Errorf("writeJobLogs returned %d, want the HIGHEST id (9) so the next fetch resumes after it", last)
	}
	out := buf.String()
	for _, want := range []string{"plan: 3 to add", "Error: quota exceeded", "runner claimed", "unknown stream"} {
		if !strings.Contains(out, want) {
			t.Errorf("output is missing %q — a stream type was dropped", want)
		}
	}
	// Order is the order the server sent, not the order of the ids.
	if idx := strings.Index(out, "runner claimed"); idx < strings.Index(out, "Error: quota exceeded") {
		t.Error("writeJobLogs reordered the stream")
	}

	// A batch that is entirely older than lastID must not rewind the cursor.
	if got := writeJobLogs(&buf, []api.JobLog{{ID: 1, LogChunk: "stale\n"}}, 9); got != 9 {
		t.Errorf("writeJobLogs rewound the cursor to %d", got)
	}
	if got := writeJobLogs(&buf, nil, 4); got != 4 {
		t.Errorf("an empty batch moved the cursor to %d", got)
	}
}

// TestIsTerminalJobStatus names the states `--follow` stops on, and one that it must not.
func TestIsTerminalJobStatus(t *testing.T) {
	for _, s := range []string{"SUCCESS", "FAILED", "CANCELLED"} {
		if !isTerminalJobStatus(s) {
			t.Errorf("isTerminalJobStatus(%q) = false — --follow would never return", s)
		}
	}
	for _, s := range []string{"QUEUED", "CLAIMED", "PROCESSING", "", "success"} {
		if isTerminalJobStatus(s) {
			t.Errorf("isTerminalJobStatus(%q) = true — --follow would stop on a live job", s)
		}
	}
}

// TestJobsListStatusHelpIsDerivedFromTheEnum pins that the `jobs list --status` help text is
// built from the generated vocabulary rather than typed. The literal list it replaced was
// already a copy of provision_job_status, and a copy stops covering it silently.
func TestJobsListStatusHelpIsDerivedFromTheEnum(t *testing.T) {
	f := jobsListCmd.Flags().Lookup("status")
	if f == nil {
		t.Fatal("`jobs list` has no --status flag")
	}
	for _, s := range jobStatusValues() {
		if !strings.Contains(f.Usage, s) {
			t.Errorf("--status help does not list %q: %q", s, f.Usage)
		}
	}
	if len(jobStatusValues()) == 0 {
		t.Fatal("the status vocabulary is empty — this test covered nothing")
	}
}
