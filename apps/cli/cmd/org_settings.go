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

var orgSettingsCmd = &cobra.Command{
	Use:   "settings",
	Short: "Show the active organization's general settings",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runOrgSettings(api.NewClient(token), os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to get org settings: %v", err)
		}
	},
}

// runOrgSettings fetches and renders the active org's general settings. json emits the whole
// object (or null in community mode); table/csv render the field/value card.
func runOrgSettings(c apiClient, out io.Writer, format string) error {
	s, err := c.GetOrgSettings()
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, s)
	}
	if s == nil {
		fmt.Fprintln(out, ui.MutedStyle.Render("Not in an organization (community mode)."))
		return nil
	}
	rows := [][]string{
		{"name", s.Name},
		{"slug", s.Slug},
		{"description", ui.OrDash(s.Description)},
		{"region", s.Region},
		{"default env", s.DefaultEnv},
		{"terraform", s.TerraformVersion},
	}
	return ui.RenderCard(out, format, "alethia · org settings", rows, s)
}

func init() {
	orgCmd.AddCommand(orgSettingsCmd)
}
