// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	projectDestroyProjectRef string
	projectDestroyProjectID  string
	projectDestroyRunnerID   string
	projectDestroyEnv        string
	projectDestroyWait       bool
	// projectDestroyYes is the --yes opt-in: skip the confirmation prompt (and make
	// the command usable with --no-input).
	projectDestroyYes bool
)

var projectDestroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Destroy a project's infrastructure",
	Long:  `Queues a DESTROY job to tear down all cloud resources for a project. This cannot be undone.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		projectDestroyProjectID, err = projectIDForJob(api.NewClient(token), token, projectDestroyProjectRef, projectDestroyProjectID)
		if err != nil {
			fail(err)
		}

		if !confirmDestructive(
			projectDestroyYes,
			"Are you sure you want to destroy this project?",
			"This will tear down all cloud resources. It cannot be undone.",
		) {
			return
		}

		// The runner picker cannot be answered with prompting disabled, and the
		// assignment is optional — an empty id is the picker's own "Any available"
		// default — so a scripted teardown simply leaves the job unassigned.
		if projectDestroyRunnerID == "" && canPromptForm() {
			projectDestroyRunnerID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
		}

		apiClient := api.NewClient(token)

		envID, err := resolveEnvironmentID(apiClient, projectDestroyProjectID, projectDestroyEnv)
		if err != nil {
			fail(err)
		}

		params := api.QueueJobParams{
			JobType:         "DESTROY",
			ConfigurationID: projectDestroyProjectID,
			EnvironmentID:   envID,
		}
		if projectDestroyRunnerID != "" {
			params.AssignedRunnerID = projectDestroyRunnerID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			failf("Error: %v", err)
		}

		if projectDestroyWait {
			ui.JobQueued("DESTROY", job.ID)
			if err := waitForJob(apiClient, job.ID); err != nil {
				exitFunc(1)
			}
		} else {
			ui.JobQueued("DESTROY", job.ID)
		}
	},
}

func init() {
	addYesFlag(projectDestroyCmd, &projectDestroyYes)
	projectCmd.AddCommand(projectDestroyCmd)
	jobProjectFlags(projectDestroyCmd, &projectDestroyProjectRef, &projectDestroyProjectID, "destroy")
	projectDestroyCmd.Flags().StringVar(&projectDestroyRunnerID, "runner-id", "", "Assign to a specific runner")
	projectDestroyCmd.Flags().StringVar(&projectDestroyEnv, "env", "", "Target environment name (default: the project's default environment)")
	projectDestroyCmd.Flags().BoolVarP(&projectDestroyWait, "wait", "w", false, "Wait for job completion")
}
