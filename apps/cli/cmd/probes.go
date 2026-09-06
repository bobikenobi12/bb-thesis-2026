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

var probesCmd = &cobra.Command{
	Use:     "probes",
	Aliases: []string{"probe"},
	Short:   "Inspect a project's cluster-alive probes",
	Long: `Probes are the "is it still up?" half of day-2 (alongside drift's "has it diverged?").
A PROBE_CLUSTER job dials each environment's cluster API server; this lists the latest result
per environment.`,
}

var probesListCmd = &cobra.Command{
	Use:   "list",
	Short: "List a project's latest per-environment cluster probes",
	Long: `List the latest cluster-alive probe for each of a project's environments. Name the
project with --project; omit it on a terminal and you are asked which.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := projectFromFlag(cmd, token)
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var probes []api.ProbeState
			runSpinner("Fetching probes...", func() {
				probes, err = client.GetProjectProbes(project)
			})
			if err != nil {
				failf("Failed to list probes: %v", err)
			}
			if len(probes) == 0 {
				ui.Muted("No environments found.")
				return
			}
			_ = ui.ShowTable(probeColumns, probeRows(probes, ui.FormatTable), "probes")
			return
		}
		if err := runProbesList(client, os.Stdout, outputFormat(cmd), project); err != nil {
			failf("Failed to list probes: %v", err)
		}
	},
}

var probeColumns = []string{"Environment", "Reachable", "Message", "Probed"}

// reachableLabel renders a nullable reachability as up/down/unprobed.
func reachableLabel(reachable *bool) string {
	if reachable == nil {
		return ui.SymbolDash + " never probed"
	}
	if *reachable {
		return ui.SymbolOnline + " up"
	}
	return ui.SymbolOffline + " down"
}

// wireReachable returns the machine form of a nullable probe result.
func wireReachable(reachable *bool) string {
	if reachable == nil {
		return ""
	}
	return ui.WireBool(*reachable)
}

// probeRows projects probe states into plain table cells.
//
// Both nullable cells go through the shared render surface rather than repeating its two branches
// inline. The Probed cell changes what a reader sees: it used to print the wire's raw RFC3339
// string, so a table of five environments carried five copies of `2026-09-01T14:03:22.114Z` where
// every other timestamp in the CLI reads `2026-09-01 14:03`.
func probeRows(probes []api.ProbeState, outFmt string) [][]string {
	rows := make([][]string, len(probes))
	for i, p := range probes {
		rows[i] = []string{
			p.Environment,
			ui.Cell(outFmt, wireReachable(p.Reachable), reachableLabel(p.Reachable)),
			ui.Cell(outFmt, ui.Wire(p.Message), ui.StrOrDash(p.Message)),
			ui.Cell(outFmt, ui.Wire(p.ProbedAt), ui.StampOrDash(p.ProbedAt)),
		}
	}
	return rows
}

// runProbesList fetches and renders a project's latest per-environment probes (non-interactive path).
func runProbesList(c apiClient, out io.Writer, format, project string) error {
	probes, err := c.GetProjectProbes(project)
	if err != nil {
		return err
	}
	if len(probes) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No environments found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: probeColumns,
		Rows:    probeRows(probes, format),
	}, probes)
}

func init() {
	probesCmd.PersistentFlags().StringP("project", "p", "",
		mustGovField("alethia probes list", fieldKeyGovProject).Description+" (name or id)")
	probesCmd.AddCommand(probesListCmd)
	rootCmd.AddCommand(probesCmd)
}
