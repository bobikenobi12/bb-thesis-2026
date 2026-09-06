// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var teamsCmd = &cobra.Command{
	Use:     "teams",
	Aliases: []string{"team"},
	Short:   "Manage organization teams",
	Long:    `List, create, and delete teams within the active organization.`,
}

var teamsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List teams in the active organization",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		orgID, err := currentOrgID()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var teams []api.Team
			runSpinner("Fetching teams...", func() { teams, err = client.ListTeams(orgID) })
			if err != nil {
				failf("Failed to list teams: %v", err)
			}
			if len(teams) == 0 {
				ui.Muted("No teams found.")
				return
			}
			_ = ui.ShowTable(teamListColumns, teamRows(teams), "teams")
			return
		}
		if err := runTeamsList(client, os.Stdout, outputFormat(cmd), orgID); err != nil {
			failf("Failed to list teams: %v", err)
		}
	},
}

var teamListColumns = []string{"ID", "Name", "Members"}

// teamRows projects teams into plain table rows. The ID column is for a script that wants the team
// id in `-o json`/`-o csv`; a person never needs to copy it, because `teams delete` takes `--name`
// and offers a picker.
func teamRows(teams []api.Team) [][]string {
	rows := make([][]string, len(teams))
	for i, t := range teams {
		rows[i] = []string{t.ID, t.Name, strconv.Itoa(t.MemberCount)}
	}
	return rows
}

// runTeamsList fetches and renders the teams of an organization
// (non-interactive path).
func runTeamsList(c apiClient, out io.Writer, format, orgID string) error {
	teams, err := c.ListTeams(orgID)
	if err != nil {
		return err
	}
	if len(teams) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No teams found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: teamListColumns,
		Rows:    teamRows(teams),
	}, teams)
}

var teamsCreateCmd = &cobra.Command{
	Use:   "create [name]",
	Short: "Create a team in the active organization",
	Long: `Create a team in the active organization. Pass the name to run without a terminal; with
no name, the form asks for one.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		orgID, err := currentOrgID()
		if err != nil {
			fail(err)
		}
		name := ""
		if len(args) > 0 {
			name = args[0]
		}
		if name == "" {
			name, err = promptName("alethia teams create", orgFieldKeyName)
			if err != nil {
				fail(err)
			}
		}
		if err := runTeamsCreate(api.NewClient(token), os.Stdout, orgID, name); err != nil {
			failf("Failed to create team: %v", err)
		}
	},
}

// runTeamsCreate creates a team in the org.
func runTeamsCreate(c apiClient, out io.Writer, orgID, name string) error {
	team, err := c.CreateTeam(orgID, name)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Created team "+team.Name))
	return nil
}

// teamsDeleteYes is the --yes opt-in: skip the confirmation prompt (and make the
// command usable with --no-input).
var teamsDeleteYes bool

// teamsDeleteName is the --name selector: name the team to delete instead of copying a team id out
// of `teams list`.
var teamsDeleteName string

var teamsDeleteCmd = &cobra.Command{
	Use:   "delete [team_id]",
	Short: "Delete a team from the active organization",
	Long: `Delete a team from the active organization. Pass the team id, or --name to name it; with
neither, pick from the org's teams.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		orgID, err := currentOrgID()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		id := ""
		if len(args) > 0 {
			id = args[0]
		}
		ref, err := resolveOrgChoice(teamPickSpec, id, teamsDeleteName, teamChoices(client, orgID))
		if err != nil {
			fail(err)
		}
		announceResolvedChoice(ref.Summary, "Deleting")
		if !confirmDestructive(teamsDeleteYes, "Delete this team?", "Members will lose their team grants. This cannot be undone.") {
			return
		}
		if err := runTeamsDelete(client, os.Stdout, orgID, ref.ID); err != nil {
			failf("Failed to delete team: %v", err)
		}
	},
}

// runTeamsDelete deletes a team from the org.
func runTeamsDelete(c apiClient, out io.Writer, orgID, teamID string) error {
	if err := c.DeleteTeam(orgID, teamID); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Team deleted"))
	return nil
}

func init() {
	addYesFlag(teamsDeleteCmd, &teamsDeleteYes)
	// No `--org` here — it is a ROOT persistent flag now (shell_fields.go, #3817). See the note in
	// members.go's init for why a second registration on the group would be worse than none.
	teamsDeleteCmd.Flags().StringVar(&teamsDeleteName, "name", "",
		"Delete the team with this name, instead of naming a team id")
	teamsCmd.AddCommand(teamsListCmd)
	teamsCmd.AddCommand(teamsCreateCmd)
	teamsCmd.AddCommand(teamsDeleteCmd)
	rootCmd.AddCommand(teamsCmd)
}
