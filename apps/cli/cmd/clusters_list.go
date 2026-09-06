// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"
)

var clusterListColumns = []string{"Project", "Cluster", "Version", "Status", "ArgoCD", "Nodes", "Region", "Cost"}

var clusterListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all project clusters",
	Long: `List every cluster across your projects, one row per project environment.

The command takes no input of its own: at a terminal it opens the navigable table, and in a pipe
or with --no-input it prints the static one. Use ` + "`alethia cluster get`" + ` for a single cluster.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
			return
		}

		apiClient := api.NewClient(token)
		var clusters []api.ClusterSummary

		runSpinner("Fetching clusters...", func() {
			clusters, err = apiClient.GetClusters()
		})

		if err != nil {
			failf("Failed to fetch clusters: %v", err)
			return
		}

		if interactiveTable(cmd) {
			if len(clusters) == 0 {
				ui.Muted(clusterEmptyState)
				return
			}
			columns := make([]table.Column, len(clusterListColumns))
			widths := []int{22, 20, 10, 26, 11, 12, 12, 12}
			for i, title := range clusterListColumns {
				columns[i] = table.Column{Title: title, Width: widths[i]}
			}
			plain := clusterRows(clusters, ui.FormatTable)
			rows := make([]table.Row, len(plain))
			for i, r := range plain {
				rows[i] = table.Row(r)
			}
			m := ui.NewTableModel(columns, rows, "clusters", "project", 0)
			if _, err := tea.NewProgram(m).Run(); err != nil {
				failf("Table error: %v", err)
			}
			return
		}

		if err := renderClusters(os.Stdout, outputFormat(cmd), clusters); err != nil {
			fail(err)
		}
	},
}

// clusterRows projects each cluster summary into a plain table row.
func clusterRows(clusters []api.ClusterSummary, outFmt string) [][]string {
	rows := make([][]string, len(clusters))
	for i, c := range clusters {
		clusterName := ui.Cell(outFmt, c.ClusterName, ui.OrDash(c.ClusterName))
		version := ui.Cell(outFmt, c.ClusterVersion, ui.OrDash(c.ClusterVersion))
		nodes := fmt.Sprintf("%d/%d/%d", c.NodeMinSize, c.NodeDesiredSize, c.NodeMaxSize)
		// Surface the status message inline — it's the actionable detail when a
		// cluster is FAILED/degraded (the raw field is also in -o json).
		status := ui.Cell(outFmt, c.Status, ui.StatusCell(c.Status))
		if c.StatusMessage != "" {
			status = ui.Cell(outFmt, c.Status, ui.StatusCell(c.Status)+" — "+c.StatusMessage)
		}
		// The dash is rendered inline rather than through a helper on purpose: a `clusterCostCell`
		// returning ui.SymbolDash would be a second DEFINITION of the empty-value sentinel living
		// in a command file, which is what hoisting the render helpers (#3694) ended. The costed
		// arm goes through the one money rule — see clusterCost.
		cost := ui.Cell(outFmt, "", ui.SymbolDash)
		if c.EstimatedMonthlyCost != nil {
			cost = ui.Cell(outFmt, fmt.Sprintf("%.2f", *c.EstimatedMonthlyCost), clusterCost(*c.EstimatedMonthlyCost))
		}
		// ArgoCD (cluster-side GitOps CD) is installed on every provisioned cluster;
		// "exposed" = a managed-ingress URL exists (see `cluster get`), else port-forward.
		argocd := ui.Cell(outFmt, "", ui.SymbolDash)
		if c.ClusterName != "" {
			if c.ArgocdURL != "" {
				argocd = "exposed"
			} else {
				argocd = "port-fwd"
			}
		}
		rows[i] = []string{
			clusterLabel(c),
			clusterName,
			version,
			status,
			argocd,
			nodes,
			c.Region,
			cost,
		}
	}
	return rows
}

// renderClusters writes the cluster list to out in the requested format.
func renderClusters(out io.Writer, outFormat string, clusters []api.ClusterSummary) error {
	if len(clusters) == 0 && outFormat == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render(clusterEmptyState))
		return nil
	}
	return ui.Render(out, outFormat, ui.TableSpec{
		Columns: clusterListColumns,
		Rows:    clusterRows(clusters, outFormat),
	}, clusters)
}

func init() {
	clusterCmd.AddCommand(clusterListCmd)
}
