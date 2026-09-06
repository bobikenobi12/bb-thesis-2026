// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	projectApplyProjectRef string
	projectApplyProjectID  string
	projectApplyRunnerID   string
	projectApplyPlanJobID  string
	projectApplyEnv        string
	projectApplyWait       bool
)

var projectApplyCmd = &cobra.Command{
	Use:   "apply",
	Short: "Apply infrastructure changes for a project",
	Long:  `Queues a DEPLOY job to provision or update a project's infrastructure.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		projectApplyProjectID, err = projectIDForJob(api.NewClient(token), token, projectApplyProjectRef, projectApplyProjectID)
		if err != nil {
			fail(err)
		}

		// The runner picker cannot be answered with prompting disabled, and the assignment is
		// OPTIONAL — an empty id is the picker's own "Any available" default — so a scripted
		// run simply leaves the job unassigned. Without this guard `--no-input` could not queue
		// a DEPLOY at all without also naming a runner, which is a flag for a field the command
		// does not require. `project destroy` already had it; these two did not.
		if projectApplyRunnerID == "" && canPromptForm() {
			projectApplyRunnerID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
		}

		apiClient := api.NewClient(token)

		envID, err := resolveEnvironmentID(apiClient, projectApplyProjectID, projectApplyEnv)
		if err != nil {
			fail(err)
		}

		params := api.QueueJobParams{
			JobType:         "DEPLOY",
			ConfigurationID: projectApplyProjectID,
			EnvironmentID:   envID,
		}
		if projectApplyRunnerID != "" {
			params.AssignedRunnerID = projectApplyRunnerID
		}
		if projectApplyPlanJobID != "" {
			params.PlanJobID = projectApplyPlanJobID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			failf("Error: %v", err)
		}

		if projectApplyWait {
			ui.JobQueued("DEPLOY", job.ID)
			if err := waitForJob(apiClient, job.ID); err != nil {
				exitFunc(1)
			}
		} else {
			ui.JobQueued("DEPLOY", job.ID)
		}
	},
}

func init() {
	projectCmd.AddCommand(projectApplyCmd)
	jobProjectFlags(projectApplyCmd, &projectApplyProjectRef, &projectApplyProjectID, "deploy")
	projectApplyCmd.Flags().StringVar(&projectApplyRunnerID, "runner-id", "", "Assign to a specific runner")
	projectApplyCmd.Flags().StringVar(&projectApplyPlanJobID, "plan-job-id", "", "Reference a prior PLAN job")
	projectApplyCmd.Flags().StringVar(&projectApplyEnv, "env", "", "Target environment name (default: the project's default environment)")
	projectApplyCmd.Flags().BoolVarP(&projectApplyWait, "wait", "w", false, "Wait for job completion")
}
