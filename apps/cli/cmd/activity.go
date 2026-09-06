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

var activityLimit int

var activityCmd = &cobra.Command{
	Use:   "activity",
	Short: "Show the organization's delivery/activity log",
	Long: `Read the active organization's activity log — every recorded action and
denial, newest first — including alert deliveries. Use -n/--limit to cap the
number of rows.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var entries []api.ActivityEntry
			runSpinner("Fetching activity...", func() { entries, err = client.ListActivity(activityLimit) })
			if err != nil {
				failf("Failed to read activity: %v", err)
			}
			if len(entries) == 0 {
				ui.Muted("No activity found.")
				return
			}
			_ = ui.ShowTable(activityColumns, activityRows(entries, ui.FormatTable), "activity")
			return
		}
		if err := runActivity(client, os.Stdout, outputFormat(cmd), activityLimit); err != nil {
			failf("Failed to read activity: %v", err)
		}
	},
}

var activityColumns = []string{"Time", "Actor", "Action", "Resource", "Decision", "Reason"}

// activityCSVColumns is the machine table, and it is one column WIDER than the human one.
//
// The Resource cell a reader sees is `project 4f3c1a92…` — a type and an id joined by a space, with
// the id cut to eight characters and an ellipsis appended. That is the one cell in the CLI that
// destroys data rather than merely inconveniencing a parser: a script reading a resource id out of
// `-o csv` got eight characters and a U+2026, and no amount of parsing recovers the rest.
//
// Neither half can be dropped, and there is no separator to weld them with that a script could
// split on safely — a space appears inside neither field today, which is exactly the kind of
// guarantee that quietly stops being true. So the machine rendering carries the two fields in two
// columns, and says so in its own header row. `-o csv` and `-o table` describing the same rows with
// different columns is not a divergence: the header is the contract, and a machine format that
// cannot state its own shape is the problem being fixed here.
var activityCSVColumns = []string{"Time", "Actor", "Action", "Resource", "Resource ID", "Decision", "Reason"}

// activityRows projects activity entries into plain table rows for the given output format. The
// actor prefers the email (falling back to the actor id); the decision renders allow/deny. The
// Reason column is the point of a deny row, so it is always shown.
//
// Under FormatCSV the row carries activityCSVColumns' seven cells; otherwise the human six.
func activityRows(entries []api.ActivityEntry, outFmt string) [][]string {
	rows := make([][]string, len(entries))
	for i, e := range entries {
		actor := e.ActorEmail
		if actor == "" {
			actor = e.ActorID
		}
		ts := ui.Cell(outFmt, e.Ts, ui.RelativeTime(e.Ts))
		decision := decisionLabel(e.Decision)
		reason := ui.Cell(outFmt, e.Reason, ui.OrDash(e.Reason))
		if outFmt == ui.FormatCSV {
			rows[i] = []string{ts, actor, e.Action, e.ResourceType, e.ResourceID, decision, reason}
			continue
		}
		resource := e.ResourceType
		if e.ResourceID != "" {
			resource += " " + ui.TruncID(e.ResourceID)
		}
		rows[i] = []string{ts, actor, e.Action, resource, decision, reason}
	}
	return rows
}

// activityColumnsFor is the header that matches activityRows' arity for a format.
func activityColumnsFor(outFmt string) []string {
	if outFmt == ui.FormatCSV {
		return activityCSVColumns
	}
	return activityColumns
}

// decisionLabel maps the PDP decision boolean to a human label.
func decisionLabel(allowed bool) string {
	if allowed {
		return "allow"
	}
	return "deny"
}

// runActivity fetches and renders the activity log (non-interactive path).
func runActivity(c apiClient, out io.Writer, outFmt string, limit int) error {
	entries, err := c.ListActivity(limit)
	if err != nil {
		return err
	}
	if len(entries) == 0 && outFmt == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No activity found."))
		return nil
	}
	return ui.Render(out, outFmt, ui.TableSpec{
		Columns: activityColumnsFor(outFmt),
		Rows:    activityRows(entries, outFmt),
	}, entries)
}

func init() {
	activityCmd.Flags().IntVarP(&activityLimit, "limit", "n", 50,
		mustGovField("alethia activity", fieldKeyGovLimit).Description)
	rootCmd.AddCommand(activityCmd)
}
