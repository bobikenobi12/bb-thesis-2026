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

var orgListCmd = &cobra.Command{
	Use:   "list",
	Short: "List organizations you belong to",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var orgs []api.OrgSummary
			runSpinner("Fetching organizations...", func() { orgs, err = client.ListOrgs() })
			if err != nil {
				failf("Failed to list organizations: %v", err)
			}
			if len(orgs) == 0 {
				ui.Muted("No organizations found.")
				return
			}
			_ = ui.ShowTable(orgListColumns, orgRows(orgs, ui.FormatTable), "organizations")
			return
		}
		if err := runOrgList(client, os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list organizations: %v", err)
		}
	},
}

var orgListColumns = []string{"Name", "Slug", "Role", "Plan", "Active"}

// orgRows projects organizations into plain table rows; the active org is flagged
// with the brand's default marker.
func orgRows(orgs []api.OrgSummary, outFmt string) [][]string {
	rows := make([][]string, len(orgs))
	for i, o := range orgs {
		rows[i] = []string{o.Name, o.Slug, o.Role, o.Plan, ui.Cell(outFmt, ui.WireBool(o.IsActive), ui.DefaultCell(o.IsActive))}
	}
	return rows
}

// runOrgList fetches and renders the caller's organizations (non-interactive
// path: static table / json / csv).
func runOrgList(c apiClient, out io.Writer, format string) error {
	orgs, err := c.ListOrgs()
	if err != nil {
		return err
	}
	if len(orgs) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No organizations found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: orgListColumns,
		Rows:    orgRows(orgs, format),
	}, orgs)
}

func init() {
	orgCmd.AddCommand(orgListCmd)
}
