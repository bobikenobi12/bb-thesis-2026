// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// TestVerifySummary covers every branch of the elench verify-report projection.
func TestVerifySummary(t *testing.T) {
	if got := verifySummary(nil); got != "" {
		t.Errorf("nil meta should be empty, got %q", got)
	}

	noKey := map[string]interface{}{"other": 1}
	if got := verifySummary(&noKey); got != "" {
		t.Errorf("missing verify_result should be empty, got %q", got)
	}

	wrongType := map[string]interface{}{"verify_result": "not-a-map"}
	if got := verifySummary(&wrongType); got != "" {
		t.Errorf("non-object verify_result should be empty, got %q", got)
	}

	noVerdict := map[string]interface{}{"verify_result": map[string]interface{}{"catalog_version": "v1"}}
	if got := verifySummary(&noVerdict); got != "" {
		t.Errorf("missing verdict should be empty, got %q", got)
	}

	verdictOnly := map[string]interface{}{"verify_result": map[string]interface{}{"verdict": "pass"}}
	if got := verifySummary(&verdictOnly); got != "pass" {
		t.Errorf("verdict-only should be %q, got %q", "pass", got)
	}

	full := map[string]interface{}{"verify_result": map[string]interface{}{
		"verdict": "fail",
		"summary": map[string]interface{}{
			"fail": float64(2), "pass": float64(5), "warn": float64(0), "not_evaluable": float64(1),
		},
	}}
	got := verifySummary(&full)
	if !strings.HasPrefix(got, "fail (") || !strings.Contains(got, "2 fail") ||
		!strings.Contains(got, "5 pass") || !strings.Contains(got, "1 n/a") {
		t.Errorf("full summary malformed: %q", got)
	}
	if strings.Contains(got, "0 warn") {
		t.Errorf("zero-count buckets should be omitted: %q", got)
	}
}

// TestJobFieldRowsProviderAndVerify covers the Provider/Duration/Verify rows.
func TestJobFieldRowsProviderAndVerify(t *testing.T) {
	started := time.Now().Add(-2 * time.Minute)
	completed := time.Now()
	meta := map[string]interface{}{"verify_result": map[string]interface{}{"verdict": "pass"}}
	job := &api.ProvisionJob{
		ID: "j1", JobType: "DEPLOY", Status: "SUCCEEDED", CreatedAt: time.Now(),
		Provider: "aws", StartedAt: &started, CompletedAt: &completed,
		ExecutionMetadata: &meta,
	}
	seen := map[string]string{}
	for _, r := range jobFieldRows(job) {
		seen[r[0]] = r[1]
	}
	for _, k := range []string{"Provider", "Duration", "Completed", "Verify"} {
		if _, ok := seen[k]; !ok {
			t.Errorf("jobFieldRows missing %q", k)
		}
	}
	if seen["Provider"] != "aws" {
		t.Errorf("provider = %q", seen["Provider"])
	}
	if seen["Verify"] != "pass" {
		t.Errorf("verify = %q", seen["Verify"])
	}
}

// TestActivityRowsReason covers the Reason column and resource-id enrichment.
func TestActivityRowsReason(t *testing.T) {
	entries := []api.ActivityEntry{{
		Ts: "2026-01-01T00:00:00Z", ActorEmail: "a@b.co", Action: "promote",
		ResourceType: "project_environment", ResourceID: "abcdefgh1234", Decision: false,
		Reason: "gate not satisfied",
	}}
	row := activityRows(entries, ui.FormatTable)[0]
	resource, reason := row[3], row[5]
	if !strings.HasPrefix(resource, "project_environment ") {
		t.Errorf("resource should include the id, got %q", resource)
	}
	if reason != "gate not satisfied" {
		t.Errorf("reason = %q", reason)
	}

	noReason := activityRows([]api.ActivityEntry{{Ts: "", ActorID: "u1", Action: "x", Decision: true}}, ui.FormatTable)[0]
	if noReason[5] != ui.SymbolDash {
		t.Errorf("empty reason should be dash, got %q", noReason[5])
	}
}

// TestDimensionRowsSlugs covers the value-slug projection.
func TestDimensionRowsSlugs(t *testing.T) {
	dims := []api.ClassificationDimension{{
		Key: "sensitivity", Label: "Sensitivity", Multi: true,
		AppliesTo: []string{"project_environment"},
		Values:    []api.ClassificationValue{{Value: "public"}, {Value: "restricted"}},
	}}
	row := dimensionRows(dims, ui.FormatTable)[0]
	if row[2] != "multi" {
		t.Errorf("mode = %q, want multi", row[2])
	}
	if !strings.Contains(row[4], "public") || !strings.Contains(row[4], "restricted") {
		t.Errorf("values cell should list slugs, got %q", row[4])
	}

	empty := dimensionRows([]api.ClassificationDimension{{Key: "k", Label: "K"}}, ui.FormatTable)[0]
	if empty[4] != ui.SymbolDash {
		t.Errorf("valueless dimension should show dash, got %q", empty[4])
	}
	if empty[3] != "all resources" {
		t.Errorf("no applies-to should read 'all resources', got %q", empty[3])
	}
}

// TestRunnerRowsHeartbeat covers heartbeat humanization + the empty fallback.
func TestRunnerRowsHeartbeat(t *testing.T) {
	live := runnerRows([]api.Runner{{Name: "r1", Status: "ONLINE", LastHeartbeat: "2026-01-01T00:00:00Z"}}, ui.FormatTable)[0]
	if live[5] == "2026-01-01T00:00:00Z" || live[5] == ui.SymbolDash {
		t.Errorf("heartbeat should be humanized, got %q", live[5])
	}
	dead := runnerRows([]api.Runner{{Name: "r2", Status: "OFFLINE", LastHeartbeat: ""}}, ui.FormatTable)[0]
	if dead[5] != ui.SymbolDash {
		t.Errorf("missing heartbeat should be dash, got %q", dead[5])
	}
}
