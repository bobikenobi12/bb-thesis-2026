// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	projectPlanProjectRef string
	projectPlanProjectID  string
	projectPlanRunnerID   string
	projectPlanEnv        string
	projectPlanWait       bool
)

var projectPlanCmd = &cobra.Command{
	Use:   "plan",
	Short: "Queue a plan (dry-run) job for a project",
	Long:  `Plan runs a Terraform plan with cost analysis without applying changes.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		projectPlanProjectID, err = projectIDForJob(api.NewClient(token), token, projectPlanProjectRef, projectPlanProjectID)
		if err != nil {
			fail(err)
		}

		// The runner picker cannot be answered with prompting disabled, and the assignment is
		// OPTIONAL — an empty id is the picker's own "Any available" default — so a scripted
		// run simply leaves the job unassigned. Without this guard `--no-input` could not queue
		// a PLAN at all without also naming a runner, which is a flag for a field the command
		// does not require. `project destroy` already had it; these two did not.
		if projectPlanRunnerID == "" && canPromptForm() {
			projectPlanRunnerID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
		}

		apiClient := api.NewClient(token)

		envID, err := resolveEnvironmentID(apiClient, projectPlanProjectID, projectPlanEnv)
		if err != nil {
			fail(err)
		}

		params := api.QueueJobParams{
			JobType:         "PLAN",
			ConfigurationID: projectPlanProjectID,
			EnvironmentID:   envID,
		}
		if projectPlanRunnerID != "" {
			params.AssignedRunnerID = projectPlanRunnerID
		}

		job, err := apiClient.QueueJobWithParams(params)
		if err != nil {
			failf("Error: %v", err)
		}

		if projectPlanWait {
			ui.JobQueued("PLAN", job.ID)
			if err := waitForJob(apiClient, job.ID); err != nil {
				exitFunc(1)
			}
		} else {
			ui.JobQueued("PLAN", job.ID)
		}
	},
}

func init() {
	projectCmd.AddCommand(projectPlanCmd)
	jobProjectFlags(projectPlanCmd, &projectPlanProjectRef, &projectPlanProjectID, "plan")
	projectPlanCmd.Flags().StringVar(&projectPlanRunnerID, "runner-id", "", "Assign to a specific runner")
	projectPlanCmd.Flags().StringVar(&projectPlanEnv, "env", "", "Target environment name (default: the project's default environment)")
	projectPlanCmd.Flags().BoolVarP(&projectPlanWait, "wait", "w", false, "Wait for job completion")
}
