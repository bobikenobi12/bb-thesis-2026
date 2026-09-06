// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Error paths for every mutating/list run* function (the `if err != nil` branch).

func TestRunFunctionsPropagateErrors(t *testing.T) {
	f := &fakeClient{err: errBoom}
	var b bytes.Buffer
	checks := []func() error{
		func() error { return runWhoami(f, &b, "table") },
		func() error { return runOrgList(f, &b, "table") },
		func() error { return runMembersList(f, &b, "table", "o1") },
		func() error { return runMembersAdd(f, &b, "o1", "x@y.com", "member") },
		func() error { return runMembersRemove(f, &b, "o1", "m1") },
		func() error { return runTeamsList(f, &b, "table", "o1") },
		func() error { return runTeamsCreate(f, &b, "o1", "x") },
		func() error { return runTeamsDelete(f, &b, "o1", "t1") },
		func() error { return runOrgSwitch(f, &b, "x") },
	}
	for i, fn := range checks {
		if err := fn(); err == nil {
			t.Errorf("check %d: expected error to propagate", i)
		}
	}
}

// runOrgSwitch with no target and prompts disabled hits the requireInteractive guard.
func TestRunOrgSwitchNoInputGuard(t *testing.T) {
	prev := noInputMode
	noInputMode = true
	defer func() { noInputMode = prev }()

	var b bytes.Buffer
	if err := runOrgSwitch(&fakeClient{orgs: sampleOrgs()}, &b, ""); err == nil {
		t.Error("expected errNoInput when switching with no target and --no-input")
	}
}

// projectRows fills the dash glyph for missing provider/region/status and a draft default.
func TestProjectRowsMissingFields(t *testing.T) {
	rows := projectRows([]types.ConfigurationSummary{{ProjectName: "bare"}}, ui.FormatTable)
	if len(rows) != 1 {
		t.Fatal("expected 1 row")
	}
	row := rows[0]
	// provider, region cells are the dash; status defaults to "draft".
	if row[3] != ui.SymbolDash || row[4] != ui.SymbolDash {
		t.Errorf("expected dash for empty provider/region: %v", row)
	}
	if !strings.Contains(row[2], "draft") {
		t.Errorf("expected draft default status: %v", row[2])
	}
}

// jobRowsPlain falls back to a truncated id, then the dash, for project/runner.
func TestJobRowsPlainFallbacks(t *testing.T) {
	// Only ids present → truncated id.
	rows := jobRowsPlain([]api.ProvisionJob{{JobType: "PLAN", Status: "QUEUED", ProjectID: "0123456789", RunnerID: "abcdefghij"}}, ui.FormatTable)
	if rows[0][2] != "01234567…" || rows[0][3] != "abcdefgh…" {
		t.Errorf("expected truncated ids: %v", rows[0])
	}
	// Nothing present → dash.
	rows = jobRowsPlain([]api.ProvisionJob{{JobType: "X", Status: "Y"}}, ui.FormatTable)
	if rows[0][2] != ui.SymbolDash || rows[0][3] != ui.SymbolDash {
		t.Errorf("expected dashes: %v", rows[0])
	}
	// Unknown job type passes through unmapped.
	if rows[0][0] != "X" {
		t.Errorf("expected raw job type, got %q", rows[0][0])
	}
}
