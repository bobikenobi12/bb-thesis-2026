// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/runners"
	"github.com/spf13/cobra"
)

var (
	deployCloudAccount    string
	deployCloudIdentityID string
	deployRunnerName      string
	deployRegion          string
	deployAssignedRunner  string
	deployAssignedID      string
	deployRunnerWait      bool
)

// deployRegionDefault is the region a deploy falls back to — the value the interactive form
// already offers as its placeholder, so pressing Enter through the form and running with
// --no-input land in the same place.
const deployRegionDefault = "eu-west-1"

// deployHostname is os.Hostname, as a seam. Measured, not assumed: os.Hostname does not fail on
// this machine or in CI, so the empty arm below is unreachable from a test without it — and that
// arm is the one that decides whether a scripted deploy is named `runner-` or `runner`.
var deployHostname = os.Hostname

// deployDefaultName is the runner name a deploy falls back to. Derived from the hostname of the
// machine that asked for the deploy, which is what the form has always offered.
func deployDefaultName() string {
	hostname, err := deployHostname()
	if err != nil || hostname == "" {
		// "runner-" alone is a name nobody can pick out of `alethia runner list`.
		return "runner"
	}
	return fmt.Sprintf("runner-%s", hostname)
}

var runnerDeployCmd = &cobra.Command{
	Use:   "deploy",
	Short: fmt.Sprintf("Deploy a new runner to an %s cloud account", runners.DeployProvidersLabel()),
	Long: fmt.Sprintf(`Creates a runner record and queues a DEPLOY_RUNNER job using the latest stable release.

Deployed runners are %s only — Alethia holds runner infrastructure templates for no other
cloud. Everywhere else, run "alethia runner register" instead: it provisions nothing, and a
runner you operate yourself runs on any cloud. Omitting --cloud-account lists only the
accounts a runner can be built into; naming one for another cloud is refused here, and a raw
--cloud-identity-id for another cloud is refused by the server before a runner or a job is
created.

Every field below can be set by a flag, so the command runs under --no-input: --name and
--region take their defaults when omitted, and an omitted --assigned-runner leaves the job for
any available runner.`, runners.DeployProvidersLabel()),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		apiClient := api.NewClient(token)

		identityID, err := runnerDeployIdentityID(apiClient, deployCloudAccount, deployCloudIdentityID)
		if err != nil {
			fail(err)
		}
		if identityID == "" {
			if !canPromptForm() {
				// Naming the flag matters more than naming the mode: the reader of a CI log needs
				// the thing to add, not a restatement of the switch they already passed.
				failf("no cloud account given: pass --cloud-account (its label or its id), "+
					"or --cloud-identity-id (%s only)", runners.DeployProvidersLabel())
			}
			// Deliberately NOT selectCloudIdentity: that lists EVERY linked cloud, which is right
			// for `project create` and wrong here. Only a cloud with a runner template can be
			// built into, and offering the rest is the defect #1794 names.
			identityID, err = selectRunnerDeployCloudIdentity(token)
			if err != nil {
				fail(err)
			}
		}

		if err := runnerAskOrDefault(&deployRunnerName,
			"Runner name", "How this runner appears in `alethia runner list`", deployDefaultName()); err != nil {
			fail(err)
		}
		if err := runnerAskOrDefault(&deployRegion,
			"Region", "Cloud region to deploy the runner into", deployRegionDefault); err != nil {
			fail(err)
		}

		assignedID, err := runnerIDFrom(apiClient, deployAssignedRunner, deployAssignedID,
			"--assigned-runner", "--assigned-runner-id")
		if err != nil {
			fail(err)
		}
		if assignedID == "" && canPromptForm() {
			// As in `runner destroy`: the executor picker cannot be answered with prompting
			// disabled, and an empty id leaves the deployment job for any available runner. Before
			// this guard the picker ran unconditionally, so `runner deploy --no-input` died on a
			// TTY error no combination of the other flags could avoid — a runner had to be named
			// even when "any available" was the wanted answer.
			assignedID, err = selectRunner(token, "")
			if err != nil {
				fail(err)
			}
		}

		resp, err := apiClient.DeployRunner(deployRunnerName, identityID, deployRegion, assignedID)
		if err != nil {
			failf("Error: %v", err)
		}

		ui.Success(fmt.Sprintf("Runner %q created (ID: %s)", resp.Runner.Name, resp.Runner.ID))
		ui.JobQueued("DEPLOY_RUNNER", resp.Job.ID)
		if deployRunnerWait {
			if err := waitForJob(apiClient, resp.Job.ID); err != nil {
				exitFunc(1)
			}
		}
	},
}

func init() {
	runnerCmd.AddCommand(runnerDeployCmd)
	runnerDeployCmd.Flags().StringVar(&deployCloudAccount, "cloud-account", "",
		fmt.Sprintf("Cloud account to deploy into, by LABEL or id (%s only; asked for on a terminal when omitted)",
			runners.DeployProvidersLabel()))
	runnerDeployCmd.Flags().StringVar(&deployCloudIdentityID, "cloud-identity-id", "",
		"Cloud identity id to deploy into (prefer --cloud-account, which also takes the label)")
	runnerDeployCmd.Flags().StringVar(&deployRunnerName, "name", "",
		"Runner name (default: runner-<hostname>)")
	runnerDeployCmd.Flags().StringVar(&deployRegion, "region", "",
		"Cloud region (default: "+deployRegionDefault+")")
	runnerDeployCmd.Flags().StringVar(&deployAssignedRunner, "assigned-runner", "",
		"Runner that executes the deployment, by NAME or id (any available when omitted)")
	runnerDeployCmd.Flags().StringVar(&deployAssignedID, "assigned-runner-id", "",
		"Runner id that executes the deployment (prefer --assigned-runner, which also takes the name)")
	runnerDeployCmd.Flags().BoolVarP(&deployRunnerWait, "wait", "w", false, "Wait for job completion")
}
