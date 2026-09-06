// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var chartCmd = &cobra.Command{
	Use:     "chart",
	Aliases: []string{"charts"},
	Short:   "Inspect a project's BYO Helm charts",
	Long: `BYO charts are your OWN Helm charts (pulled from a connected git repo) deployed into an
environment via ArgoCD, alongside the marketplace add-ons. List the charts attached to an
environment (defaults to the project's default environment; pass --env for another).`,
}

var chartListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the BYO Helm charts attached to a project environment",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		// Format first, then the picker: interactiveTable is both the "may I draw a rich table"
		// question and the "may I open a form on stdout" one, and they have the same answer.
		outFmt := outputFormat(cmd)
		rich := interactiveTable(cmd)
		project, err := byoProject(cmd, token, rich)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		client := api.NewClient(token)
		if rich {
			var view *api.ProjectByoCharts
			runSpinner("Fetching charts...", func() {
				view, err = client.GetProjectByoCharts(project, env)
			})
			if err != nil {
				failf("Failed to list charts: %v", err)
			}
			if view == nil || len(view.Charts) == 0 {
				ui.Muted("No BYO charts attached.")
				return
			}
			_ = ui.ShowTable(chartColumns, chartRows(view.Charts, ui.FormatTable), "charts")
			return
		}
		if err := runChartList(client, os.Stdout, outFmt, project, env); err != nil {
			failf("Failed to list charts: %v", err)
		}
	},
}

var chartColumns = []string{"Chart", "Repo", "Path", "Ref", "Status", "Scan"}

// chartRows projects BYO charts into plain table cells.
//
// OrDash on the two OPTIONAL cells, for a person. An OCI chart carries no path and a chart
// tracking its repository's default branch carries no ref, and both rendered as an empty cell —
// which reads as missing data rather than as "this chart does not have one".
//
// outFmt is taken for the reason ui.Render's doc states: its CSV branch writes these rows
// VERBATIM, so the dash would reach a script as `—` (U+2014). That is exactly the ambiguity the
// glyph resolves for a person and exactly the one it CREATES for a parser, which already reads an
// empty cell as absent and would now have to know one product's sentinel.
func chartRows(charts []api.ByoChart, outFmt string) [][]string {
	rows := make([][]string, len(charts))
	for i, c := range charts {
		path, ref := c.ChartPath, c.Ref
		if ui.HumanReadable(outFmt) {
			path, ref = ui.OrDash(path), ui.OrDash(ref)
		}
		rows[i] = []string{c.ID, c.RepoURL, path, ref, c.Status, c.ScanStatus}
	}
	return rows
}

// runChartList fetches and renders a project environment's BYO charts. json emits the whole view;
// table/csv emit the chart rows.
func runChartList(c apiClient, out io.Writer, format, project, env string) error {
	view, err := c.GetProjectByoCharts(project, env)
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, view)
	}
	if (view == nil || len(view.Charts) == 0) && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No BYO charts attached."))
		return nil
	}
	var charts []api.ByoChart
	if view != nil {
		charts = view.Charts
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: chartColumns,
		Rows:    chartRows(charts, format),
	}, charts)
}

func init() {
	chartCmd.PersistentFlags().StringP("project", "p", "", byoFlagUsage("alethia chart", byoKeyProject))
	chartCmd.PersistentFlags().StringP("env", "e", "", byoFlagUsage("alethia chart", byoKeyEnv))
	chartCmd.AddCommand(chartListCmd)
	rootCmd.AddCommand(chartCmd)
}
