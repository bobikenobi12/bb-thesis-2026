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

var repoCmd = &cobra.Command{
	Use:     "repo",
	Aliases: []string{"repos", "repositories"},
	Short:   "Browse the git repositories Alethia can see",
	Long: `List the repositories reachable through a connected git provider
(GitHub, GitLab, or Bitbucket). These are the repos you can point a project at
when authoring its infrastructure.`,
}

var repoListCmd = &cobra.Command{
	Use:   "list",
	Short: "List repositories for a connected git provider",
	Run: func(cmd *cobra.Command, args []string) {
		provider, _ := cmd.Flags().GetString("provider")
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var repos []api.Repository
			runSpinner("Fetching repositories...", func() {
				repos, err = client.GetRepositories(provider)
			})
			if err != nil {
				failf("Failed to list repositories: %v", err)
			}
			if len(repos) == 0 {
				ui.Muted(fmt.Sprintf("No %s repositories found.", provider))
				return
			}
			_ = ui.ShowTable(repoColumns, repoRows(repos, ui.FormatTable), "repositories")
			return
		}
		if err := runRepoList(client, os.Stdout, outputFormat(cmd), provider); err != nil {
			failf("Failed to list repositories: %v", err)
		}
	},
}

var repoColumns = []string{"Name", "Visibility", "Default branch", "URL"}

// repoRows projects repositories into table cells.
func repoRows(repos []api.Repository, outFmt string) [][]string {
	rows := make([][]string, len(repos))
	for i, r := range repos {
		visibility := "public"
		if r.Private {
			visibility = "private"
		}
		name := r.FullName
		if name == "" {
			name = r.Name
		}
		rows[i] = []string{name, visibility, ui.Cell(outFmt, r.DefaultBranch, ui.OrDash(r.DefaultBranch)), r.URL}
	}
	return rows
}

// runRepoList fetches and renders repositories for the given provider in the
// requested output format.
func runRepoList(c apiClient, out io.Writer, format, provider string) error {
	repos, err := c.GetRepositories(provider)
	if err != nil {
		return err
	}
	if len(repos) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render(fmt.Sprintf("No %s repositories found.", provider)))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: repoColumns,
		Rows:    repoRows(repos, format),
	}, repos)
}

func init() {
	repoListCmd.Flags().String("provider", gitProviders[0], byoFlagUsage("alethia repo list", byoKeyProvider)+" ("+gitProvidersLabel()+")")
	repoCmd.AddCommand(repoListCmd)
	rootCmd.AddCommand(repoCmd)
}
