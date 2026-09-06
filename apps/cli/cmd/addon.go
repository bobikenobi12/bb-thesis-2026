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

var addonCmd = &cobra.Command{
	Use:     "addon",
	Aliases: []string{"addons"},
	Short:   "Inspect a project's installed add-ons",
	Long: `Add-ons are the marketplace OSS Helm charts (observability, databases, caches, …)
installed into an environment via ArgoCD. List the add-ons installed in an environment (defaults
to the project's default environment; pass --env for another).`,
}

var addonListCmd = &cobra.Command{
	Use:   "list",
	Short: "List the add-ons installed in a project environment",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := projectFromFlag(cmd, token)
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var view *api.ProjectAddons
			runSpinner("Fetching add-ons...", func() {
				view, err = client.GetProjectAddons(project, env)
			})
			if err != nil {
				failf("Failed to list add-ons: %v", err)
			}
			if view == nil || len(view.Addons) == 0 {
				ui.Muted("No add-ons installed.")
				return
			}
			_ = ui.ShowTable(addonColumns, addonRows(view.Addons, ui.FormatTable), "add-ons")
			return
		}
		if err := runAddonList(client, os.Stdout, outputFormat(cmd), project, env); err != nil {
			failf("Failed to list add-ons: %v", err)
		}
	},
}

// addonColumns are the table's columns. SYNC is here and was not, and that is the one change
// worth stating: the wire has carried `sync` and `last_synced_at` since the endpoint was written
// and the table rendered neither, so the CLI showed an ArgoCD add-on's HEALTH as the only signal.
//
// Those two say different things. Health is the workload's own report — a chart with no readiness
// probe is "Healthy" the moment its pods schedule. Sync is whether ArgoCD has applied the manifest
// the control plane asked for at all, and an add-on stuck OutOfSync is the failure an operator is
// actually looking for: it renders, it says Healthy, and the change never reached the cluster.
var addonColumns = []string{"Add-on", "Enabled", "Mode", "Version", "Status", "Sync", "Health", "Last synced"}

// addonRows projects installed add-ons into plain table cells.
func addonRows(addons []api.Addon, outFmt string) [][]string {
	rows := make([][]string, len(addons))
	for i, a := range addons {
		rows[i] = []string{
			a.AddonID,
			ui.Cell(outFmt, ui.WireBool(a.Enabled), ui.GateGlyph(a.Enabled)),
			ui.Cell(outFmt, a.Mode, ui.OrDash(a.Mode)),
			ui.Cell(outFmt, ui.Wire(a.Version), ui.StrOrDash(a.Version)),
			ui.Cell(outFmt, a.Status, ui.OrDash(a.Status)),
			ui.Cell(outFmt, ui.Wire(a.Sync), ui.StrOrDash(a.Sync)),
			ui.Cell(outFmt, ui.Wire(a.Health), ui.StrOrDash(a.Health)),
			// "never" and not a dash: an add-on that has never synced is a DIFFERENT statement
			// from one whose last sync we failed to read, and it is the one that explains an
			// Application sitting Progressing since it was enabled.
			ui.Cell(outFmt, ui.Wire(a.LastSyncedAt), ui.StampOrNever(a.LastSyncedAt)),
		}
	}
	return rows
}

// runAddonList fetches and renders a project environment's installed add-ons. json emits the
// whole view; table/csv emit the add-on rows.
func runAddonList(c apiClient, out io.Writer, format, project, env string) error {
	view, err := c.GetProjectAddons(project, env)
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, view)
	}
	if (view == nil || len(view.Addons) == 0) && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No add-ons installed."))
		return nil
	}
	var addons []api.Addon
	if view != nil {
		addons = view.Addons
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: addonColumns,
		Rows:    addonRows(addons, format),
	}, addons)
}

func init() {
	addonCmd.PersistentFlags().StringP("project", "p", "", "Project name or id")
	addonCmd.PersistentFlags().StringP("env", "e", "", "Environment name, stage, or id (default: the project's default environment)")
	addonCmd.AddCommand(addonListCmd)
	rootCmd.AddCommand(addonCmd)
}
