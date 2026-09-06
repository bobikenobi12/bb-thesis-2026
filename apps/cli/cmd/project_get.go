// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

var projectGetCmd = &cobra.Command{
	Use:   "get [project_name]",
	Short: "Get a specific project by project name",
	Long: `Print a project's full configuration.

The project is named by its positional NAME. Omit it on a terminal and you are asked, so
the name never has to be copied out of another command's output.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		projectName := ""
		if len(args) == 1 {
			projectName = args[0]
		}
		if projectName == "" {
			if !promptsEnabled() {
				failf("a project name is required (pass it as the argument)")
			}
			// promptProjectNameRef, not promptProjectRef: GetConfiguration below resolves by
			// project NAME only, so the id that one falls back to for a shared name would 404.
			if projectName, err = promptProjectNameRef(token); err != nil {
				fail(err)
			}
		}

		format := outputFormat(cmd)
		openInBrowser, _ := cmd.Flags().GetBool("open")

		config, err := api.NewClient(token).GetConfiguration(projectName)
		if err != nil {
			failf("Failed to fetch project: %v", err)
		}

		if config == nil || config.ID == "" {
			ui.Muted(fmt.Sprintf("No project found for project: %s", projectName))
			return
		}

		// json/csv are scripting formats: emit the record and skip the
		// interactive browser prompt entirely.
		if format != ui.FormatTable {
			if err := ui.RenderCard(os.Stdout, format, "", projectSummaryRows(*config), config); err != nil {
				fail(err)
			}
			return
		}

		ui.PrintConfiguration(*config)

		// Only offer the browser prompt on an interactive TTY; scripting/piped
		// invocations get the rendered project and nothing that would block.
		if !openInBrowser && interactiveTable(cmd) {
			openInBrowser = confirm("Open in Browser?", "View this project in the Alethia web UI")
		}

		if openInBrowser {
			url := fmt.Sprintf("%s/dashboard", WebOrigin())
			fmt.Printf("Opening in browser: %s\n", url)
			if err := openBrowser(url); err != nil {
				ui.Error(fmt.Sprintf("Failed to open browser: %v", err))
			}
		}
	},
}

// projectSummaryRows returns the scalar summary fields of a project config for
// the csv projection (json emits the full typed object).
func projectSummaryRows(c types.Configuration) [][]string {
	rows := [][]string{
		{"ID", c.ID},
		{"Project", c.ProjectName},
		{"Environment", string(c.EnvironmentStage)},
		{"Container Platform", c.ContainerPlatform},
		{"Cloud Account ID", c.CloudAccountID},
		{"Region", c.Region},
		{"IaC Version", c.IacVersion},
	}
	if !c.UpdatedAt.IsZero() {
		// `2006-01-02 15:04:05` was one of five copies of that layout in the CLI. One absolute
		// date, the console's, in UTC — the host zone would make the same project print two
		// different times on two machines.
		rows = append(rows, []string{"Last Updated", format.Date(c.UpdatedAt, format.DateTime, time.UTC)})
	}
	return rows
}

func init() {
	projectCmd.AddCommand(projectGetCmd)
	// Note: -o is reserved for the global --output flag, so --open is long-only.
	projectGetCmd.Flags().Bool("open", false, "Open the project in the web browser")
}
