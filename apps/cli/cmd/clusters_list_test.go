// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// clusterCell reads one column of one row by its column NAME, so a test says which column it
// means rather than which index it happens to be at. An index drifts silently when a column is
// inserted; a name fails loudly when one is renamed.
func clusterCell(t *testing.T, row []string, column string) string {
	t.Helper()
	for i, c := range clusterListColumns {
		if c == column {
			if i >= len(row) {
				t.Fatalf("row has %d cells, column %q is at %d: %+v", len(row), column, i, row)
			}
			return row[i]
		}
	}
	t.Fatalf("no column named %q in %v", column, clusterListColumns)
	return ""
}

// TestClusterRowsCells covers the projection cell by cell: the shared project label, the inline
// status message, the ArgoCD posture and the cost.
func TestClusterRowsCells(t *testing.T) {
	cost := 128.0
	withExtras := []api.ClusterSummary{{
		ProjectName: "web", Environment: "prod", ClusterName: "web-eks",
		ClusterVersion: "1.30", Status: "FAILED", StatusMessage: "node pool exhausted",
		EstimatedMonthlyCost: &cost, Region: "eu-central-1",
	}}
	row := clusterRows(withExtras, ui.FormatTable)[0]

	if got := clusterCell(t, row, "Project"); got != "web (prod)" {
		t.Errorf("project cell = %q — it must be the same label the card and the picker use", got)
	}
	status := clusterCell(t, row, "Status")
	if !strings.Contains(status, "node pool exhausted") || !strings.Contains(status, ui.SymbolError) {
		t.Errorf("status cell should carry the glyph and the message, got %q", status)
	}
	// A provisioned cluster with no managed-ingress URL reads "port-fwd".
	if got := clusterCell(t, row, "ArgoCD"); got != "port-fwd" {
		t.Errorf("argocd cell = %q, want port-fwd", got)
	}
	// Minor units, from packages/core/format — the console renders the same figure the same way.
	if got := clusterCell(t, row, "Cost"); got != "$128.00/mo" {
		t.Errorf("cost cell = %q, want $128.00/mo", got)
	}
	if got := clusterCell(t, row, "Nodes"); got != "0/0/0" {
		t.Errorf("nodes cell = %q", got)
	}

	bare := clusterRows([]api.ClusterSummary{{ProjectName: "x", Status: "ACTIVE"}}, ui.FormatTable)[0]
	for _, column := range []string{"Cost", "ArgoCD", "Cluster", "Version"} {
		if got := clusterCell(t, bare, column); got != ui.SymbolDash {
			// One sentinel, one glyph: an unset cell must be the hoisted SymbolDash and never a
			// local "-", "N/A" or a second em dash literal.
			t.Errorf("unset %s cell = %q, want the shared sentinel %q", column, got, ui.SymbolDash)
		}
	}
}

// TestClusterRowsCostRoundsLikeTheConsole pins the defect this change exists for at the LIST cell
// as well as the card: the two renderings of one number must not diverge again.
//
// $12.50 is the case named in packages/format/conformance/format-cases.json as
// `monthlyRate/estimate/HALF-CENT-ROUNDS-AWAY-FROM-ZERO`; `fmt.Sprintf("$%.0f/mo", 12.5)` — what
// this cell used to be — renders `$12`, because Go's %f rounds half to EVEN.
func TestClusterRowsCostRoundsLikeTheConsole(t *testing.T) {
	for _, c := range []struct {
		amount float64
		want   string
	}{
		{12.5, "$12.50/mo"},
		{13.5, "$13.50/mo"},
		{0.02, "<$1/mo"},
		{0, "$0/mo"},
	} {
		amount := c.amount
		row := clusterRows([]api.ClusterSummary{{ProjectName: "p", EstimatedMonthlyCost: &amount}}, ui.FormatTable)[0]
		if got := clusterCell(t, row, "Cost"); got != c.want {
			t.Errorf("cost cell for %v = %q, want %q", c.amount, got, c.want)
		}
	}
}

// TestRenderClustersEmptyState pins that both renderings of "nothing here" say the same sentence,
// and that json/csv still emit a body rather than the prose.
func TestRenderClustersEmptyState(t *testing.T) {
	var buf bytes.Buffer
	if err := renderClusters(&buf, ui.FormatTable, nil); err != nil {
		t.Fatalf("renderClusters(table, empty): %v", err)
	}
	if !strings.Contains(buf.String(), clusterEmptyState) {
		t.Errorf("empty table should print the shared empty state, got %q", buf.String())
	}

	buf.Reset()
	if err := renderClusters(&buf, "json", nil); err != nil {
		t.Fatalf("renderClusters(json, empty): %v", err)
	}
	if strings.Contains(buf.String(), clusterEmptyState) {
		t.Errorf("json must stay machine-readable when empty, got %q", buf.String())
	}
}

// TestRenderClustersColumnsAreTheHeaders pins the header row against the same list the projection
// is indexed by, so a column added to one and not the other cannot ship.
func TestRenderClustersColumnsAreTheHeaders(t *testing.T) {
	var buf bytes.Buffer
	clusters := []api.ClusterSummary{{ProjectName: "web", Environment: "prod", ClusterName: "web-eks", Status: "ACTIVE"}}
	if err := renderClusters(&buf, ui.FormatTable, clusters); err != nil {
		t.Fatalf("renderClusters: %v", err)
	}
	if len(clusterListColumns) == 0 {
		t.Fatal("no columns declared — every assertion below would be vacuous")
	}
	for _, column := range clusterListColumns {
		if !strings.Contains(buf.String(), column) {
			t.Errorf("header %q missing from the rendered table:\n%s", column, buf.String())
		}
	}
	if got := len(clusterRows(clusters, ui.FormatTable)[0]); got != len(clusterListColumns) {
		t.Errorf("a row has %d cells for %d columns", got, len(clusterListColumns))
	}
}
