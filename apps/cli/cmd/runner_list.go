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

var runnerListColumns = []string{"Name", "Operator", "Status", "Version", "Default", "Last Heartbeat"}

var runnerListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all runners",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		var runners []api.Runner

		runSpinner("Fetching runners...", func() {
			runners, err = apiClient.GetRunners()
		})

		if err != nil {
			failf("Failed to fetch runners: %v", err)
		}

		if interactiveTable(cmd) {
			if len(runners) == 0 {
				ui.Muted("No runners found. Deploy one with `alethia runner deploy`.")
				return
			}
			columns := make([]table.Column, len(runnerListColumns))
			widths := []int{24, 16, 12, 12, 8, 20}
			for i, title := range runnerListColumns {
				columns[i] = table.Column{Title: title, Width: widths[i]}
			}
			plain := runnerRows(runners, ui.FormatTable)
			rows := make([]table.Row, len(plain))
			for i, r := range plain {
				rows[i] = table.Row(r)
			}
			m := ui.NewTableModel(columns, rows, "runners", "name", 0)
			if _, err := tea.NewProgram(m).Run(); err != nil {
				failf("Table error: %v", err)
			}
			return
		}

		if err := renderRunners(os.Stdout, outputFormat(cmd), runners); err != nil {
			fail(err)
		}
	},
}

// runnerRows projects each runner into a plain table row for the given output format.
//
// Five of the six cells were humanised unconditionally and Render writes these rows verbatim into
// its CSV branch, so a script reading `runner list -o csv` received a `◆` for the default runner, a
// `● active` status welded to its glyph, `3 minutes ago` where a timestamp belongs, and — the one
// that loses data outright — `self·hetzner`, which is api.Runner's Operator and Provisioning fields
// joined by U+00B7. The Operator column's machine form is the Operator field; a script that wants
// the provisioner reads `-o json`, where it has never stopped being its own key.
func runnerRows(runners []api.Runner, outFmt string) [][]string {
	rows := make([][]string, len(runners))
	for i, w := range runners {
		rows[i] = []string{
			w.Name,
			ui.Cell(outFmt, w.Operator, runnerOperatorLabel(w)),
			ui.Cell(outFmt, w.Status, ui.StatusCell(w.Status)),
			ui.Cell(outFmt, w.Version, ui.OrDash(w.Version)),
			ui.Cell(outFmt, ui.WireBool(w.IsDefault), ui.DefaultCell(w.IsDefault)),
			ui.Cell(outFmt, w.LastHeartbeat, ui.RelativeTime(w.LastHeartbeat)),
		}
	}
	return rows
}

// renderRunners writes the runner list to out in the requested format.
func renderRunners(out io.Writer, outFmt string, runners []api.Runner) error {
	if len(runners) == 0 && outFmt == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No runners found. Deploy one with `alethia runner deploy`."))
		return nil
	}
	return ui.Render(out, outFmt, ui.TableSpec{
		Columns: runnerListColumns,
		Rows:    runnerRows(runners, outFmt),
	}, runners)
}

func init() {
	runnerCmd.AddCommand(runnerListCmd)
}
