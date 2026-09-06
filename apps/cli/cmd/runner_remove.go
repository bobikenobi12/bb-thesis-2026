// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	// runnerRemoveRef is --runner: the runner to remove, by NAME or id.
	runnerRemoveRef string
	// runnerRemoveYes is the --yes opt-in: skip the confirmation prompt (and make the
	// command usable with --no-input).
	runnerRemoveYes bool
)

var runnerRemoveCmd = &cobra.Command{
	Use:   "remove [runner-id]",
	Short: "Remove a runner record (no cloud teardown)",
	Args:  cobra.MaximumNArgs(1),
	Long: `Removes the runner's database record only. Use 'alethia runner destroy' to tear down cloud resources first.

Name the runner with --runner, which takes its NAME as shown by "alethia runner list" — no id
has to be copied between commands. The positional argument still takes the raw id for scripts
that already pass one; passing both is refused rather than resolved by precedence.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		apiClient := api.NewClient(token)

		positional := ""
		if len(args) > 0 {
			positional = args[0]
		}
		runnerID, err := runnerIDFrom(apiClient, runnerRemoveRef, positional, "--runner", "the runner-id argument")
		if err != nil {
			fail(err)
		}

		if runnerID == "" {
			if !canPromptForm() {
				failf("no runner given: pass --runner (its name or its id), or the runner id as the argument")
			}
			runnerID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
			if runnerID == "" {
				failf("Select a specific runner to remove, not %q.", "Any available")
			}
		}

		if !confirmDestructive(
			runnerRemoveYes,
			"Remove this runner record?",
			"This only removes the database record. Cloud resources will NOT be torn down.",
		) {
			return
		}

		runSpinner("Removing runner...", func() {
			err = apiClient.RemoveRunner(runnerID)
		})

		if err != nil {
			failf("Error: %v", err)
		}

		ui.Success(fmt.Sprintf("Runner record removed (ID: %s)", runnerID))
	},
}

func init() {
	addYesFlag(runnerRemoveCmd, &runnerRemoveYes)
	runnerCmd.AddCommand(runnerRemoveCmd)
	runnerRemoveCmd.Flags().StringVar(&runnerRemoveRef, "runner", "",
		"Runner to remove, by NAME or id (asked for on a terminal when omitted)")
}
