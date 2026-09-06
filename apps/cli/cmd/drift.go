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

var driftCmd = &cobra.Command{
	Use:   "drift",
	Short: "Inspect a project's day-2 drift posture",
	Long: `Drift is the "keep proving it" half of Alethia: a DETECT_DRIFT job runs a
refresh-only plan and records which managed resources have diverged from their provisioned
state. Show the latest posture for a project (optionally one environment).`,
}

var driftShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Show the latest drift posture for a project",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		// Format first, then the picker — the order `cost show` states beside the same pair: a
		// picker opened for `-o json` writes its frames into the document the caller is piping.
		outFmt := outputFormat(cmd)
		project, err := byoProject(cmd, token, interactiveTable(cmd))
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		if err := runDriftShow(api.NewClient(token), os.Stdout, outFmt, project, env); err != nil {
			failf("Failed to get drift: %v", err)
		}
	},
}

var driftColumns = []string{"Address", "Type", "Change"}

// driftRows projects drifted resources into plain table cells.
func driftRows(details []api.DriftDetail) [][]string {
	rows := make([][]string, len(details))
	for i, d := range details {
		rows[i] = []string{d.Address, d.Type, d.Kind}
	}
	return rows
}

// driftSummary renders the one-line posture headline (evaluated / in-sync / drifted count).
func driftSummary(p *api.DriftPosture) string {
	scope := ""
	if p.Environment != nil && *p.Environment != "" {
		scope = fmt.Sprintf(" [%s]", *p.Environment)
	}
	if !p.Evaluated {
		return ui.MutedStyle.Render(fmt.Sprintf("Drift%s: not evaluated — no drift scan has run yet.", scope))
	}
	when := ""
	if p.ScannedAt != nil {
		// The scan stamp went out as the raw wire string. ui.Stamp returns it VERBATIM if it does
		// not parse, so a wire problem stays reportable rather than becoming a blank.
		when = fmt.Sprintf(" (scanned %s)", ui.Stamp(*p.ScannedAt))
	}
	if p.InSync {
		return ui.FormatSuccess(fmt.Sprintf("Drift%s: in sync%s", scope, when))
	}
	return ui.WarningStyle.Render(fmt.Sprintf("Drift%s: %d resource(s) drifted%s", scope, p.Drifted, when))
}

// runDriftShow fetches and renders a project's drift posture. json emits the whole posture;
// table prints a summary headline then the drifted-resource table; csv emits the resource rows.
func runDriftShow(c apiClient, out io.Writer, format, project, env string) error {
	posture, err := c.GetProjectDrift(project, env)
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, posture)
	}
	if format == ui.FormatTable {
		fmt.Fprintln(out, driftSummary(posture))
		if len(posture.Details) == 0 {
			return nil
		}
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: driftColumns,
		Rows:    driftRows(posture.Details),
	}, posture.Details)
}

func init() {
	driftCmd.PersistentFlags().StringP("project", "p", "", byoFlagUsage("alethia drift", byoKeyProject))
	driftCmd.PersistentFlags().StringP("env", "e", "", byoFlagUsage("alethia drift", byoKeyEnv))
	driftCmd.AddCommand(driftShowCmd)
	rootCmd.AddCommand(driftCmd)
}
