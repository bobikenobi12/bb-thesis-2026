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

var protectionCmd = &cobra.Command{
	Use:     "protection",
	Aliases: []string{"protect"},
	Short:   "Inspect a project's promotion protection rules",
	Long: `Protection rules gate promotion into an environment: require the predecessor stage to
be deployed and in-sync, require a passing elench verify report, require human approval, a soak
window, or a cost-delta ceiling. List the rules configured per environment.`,
}

var protectionListCmd = &cobra.Command{
	Use:   "list",
	Short: "List a project's per-environment protection rules",
	Long: `List the protection rules configured for each of a project's environments. Name the
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
			var rules []api.ProtectionRule
			runSpinner("Fetching protection rules...", func() {
				rules, err = client.GetProjectProtection(project)
			})
			if err != nil {
				failf("Failed to list protection rules: %v", err)
			}
			if len(rules) == 0 {
				ui.Muted("No protection rules configured.")
				return
			}
			_ = ui.ShowTable(protectionColumns, protectionRows(rules, ui.FormatTable), "protection rules")
			return
		}
		if err := runProtectionList(client, os.Stdout, outputFormat(cmd), project); err != nil {
			failf("Failed to list protection rules: %v", err)
		}
	},
}

var protectionColumns = []string{"Environment", "Predecessor", "Verify", "Approval", "Approvers", "Soak (min)", "Cost Δ"}

// protectionRows projects protection rules into plain table cells for the given output format.
//
// Every cell but the environment name was humanised unconditionally, and Render's CSV branch writes
// these rows verbatim — so this is the table where `-o csv` was least usable: three gates as `✓`/`—`
// (a boolean rendered as two glyphs, neither of which is a boolean), two limits as `—`, and a
// threshold as `$100.00` (a currency symbol on a number the operator typed as `50`).
//
// A reader gets all of that back; a script gets `true`/`false`, an empty field for an unset limit,
// and a bare fixed-point number. See ui.WireBool and ui.WireFloat for why each machine form is what
// it is.
func protectionRows(rules []api.ProtectionRule, outFmt string) [][]string {
	rows := make([][]string, len(rules))
	for i, r := range rules {
		rows[i] = []string{
			r.Environment,
			ui.Cell(outFmt, ui.WireBool(r.RequirePredecessor), ui.GateGlyph(r.RequirePredecessor)),
			ui.Cell(outFmt, ui.WireBool(r.RequireVerifyPass), ui.GateGlyph(r.RequireVerifyPass)),
			ui.Cell(outFmt, ui.WireBool(r.RequireApproval), ui.GateGlyph(r.RequireApproval)),
			ui.Cell(outFmt, ui.WireInt(r.MinCount), ui.IntOrDash(r.MinCount)),
			ui.Cell(outFmt, ui.WireInt(r.SoakMinutes), ui.IntOrDash(r.SoakMinutes)),
			ui.Cell(outFmt, ui.WireFloat(r.CostDeltaThreshold), ui.FloatOrDash(r.CostDeltaThreshold)),
		}
	}
	return rows
}

// runProtectionList fetches and renders a project's protection rules (non-interactive path).
func runProtectionList(c apiClient, out io.Writer, outFmt, project string) error {
	rules, err := c.GetProjectProtection(project)
	if err != nil {
		return err
	}
	if len(rules) == 0 && outFmt == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No protection rules configured."))
		return nil
	}
	return ui.Render(out, outFmt, ui.TableSpec{
		Columns: protectionColumns,
		Rows:    protectionRows(rules, outFmt),
	}, rules)
}

func init() {
	protectionCmd.PersistentFlags().StringP("project", "p", "",
		mustGovField("alethia protection list", fieldKeyGovProject).Description+" (name or id)")
	protectionCmd.AddCommand(protectionListCmd)
	rootCmd.AddCommand(protectionCmd)
}
