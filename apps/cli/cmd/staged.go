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

var stagedCmd = &cobra.Command{
	Use:   "staged",
	Short: "Inspect an environment's staged (pending) canvas changes",
	Long: `Staged changes are the durable diff between a project environment's edited canvas and
its live config — the Pending Changes an apply would push. List them for an environment (defaults
to the project's default environment; pass --env for another).`,
}

var stagedListCmd = &cobra.Command{
	Use:   "list",
	Short: "List an environment's staged changes",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		outFmt := outputFormat(cmd)
		rich := interactiveTable(cmd)
		project, err := byoProject(cmd, token, rich)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		client := api.NewClient(token)
		if rich {
			var view *api.StagedChanges
			runSpinner("Fetching staged changes...", func() {
				view, err = client.GetProjectStagedChanges(project, env)
			})
			if err != nil {
				failf("Failed to list staged changes: %v", err)
			}
			if view == nil || len(view.Changes) == 0 {
				ui.Muted("No staged changes.")
				return
			}
			_ = ui.ShowTable(stagedColumns, stagedRows(view.Changes, ui.FormatTable), "staged changes")
			return
		}
		if err := runStagedList(client, os.Stdout, outFmt, project, env); err != nil {
			failf("Failed to list staged changes: %v", err)
		}
	},
}

var stagedColumns = []string{"Op", "Component", "Component ID", "Created"}

// stagedRows projects staged changes into plain table cells.
//
// outFmt is taken for the reason ui.Render's doc states: its CSV branch writes these rows
// VERBATIM, so both humanised cells here are cells a script receives.
//
//   - Created is `9 Mar 2026, 15:04` for a person — the console's spelling of the same instant,
//     which is why it stopped being the wire's RFC3339 echoed back — and the wire's RFC3339 for a
//     machine, which is the only form that sorts, parses, and still carries the seconds and zone.
//   - Component ID is the dash for a person and an EMPTY cell for a machine. A CREATE has no
//     component id yet; "" is already how CSV says "absent", and `—` is a value a reader would
//     have to special-case.
func stagedRows(changes []api.StagedChange, outFmt string) [][]string {
	rows := make([][]string, len(changes))
	for i, c := range changes {
		id, created := ptrOrEmpty(c.ComponentID), c.CreatedAt
		if ui.HumanReadable(outFmt) {
			id, created = ui.StrOrDash(c.ComponentID), ui.Stamp(c.CreatedAt)
		}
		rows[i] = []string{c.Op, c.ComponentType, id, created}
	}
	return rows
}

// ptrOrEmpty is the machine reading of a nullable string cell: the value, or "" when there is not
// one. The counterpart to ui.StrOrDash, which is the person's.
func ptrOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// runStagedList fetches and renders an environment's staged changes. json emits the whole view;
// table/csv emit the change rows.
func runStagedList(c apiClient, out io.Writer, format, project, env string) error {
	view, err := c.GetProjectStagedChanges(project, env)
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, view)
	}
	if (view == nil || len(view.Changes) == 0) && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No staged changes."))
		return nil
	}
	var changes []api.StagedChange
	if view != nil {
		changes = view.Changes
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: stagedColumns,
		Rows:    stagedRows(changes, format),
	}, changes)
}

func init() {
	stagedCmd.PersistentFlags().StringP("project", "p", "", byoFlagUsage("alethia staged", byoKeyProject))
	stagedCmd.PersistentFlags().StringP("env", "e", "", byoFlagUsage("alethia staged", byoKeyEnv))
	stagedCmd.AddCommand(stagedListCmd)
	rootCmd.AddCommand(stagedCmd)
}
