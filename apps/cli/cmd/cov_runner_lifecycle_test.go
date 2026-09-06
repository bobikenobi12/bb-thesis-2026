// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"testing"
)

// A runner's life: deploy, destroy, remove.
//
// The three verbs are one subject because they share the job poller and the confirmation contract,
// and because "remove" and "destroy" are the pair most easily confused — one forgets a runner, the
// other tears down the infrastructure behind it.

// miscResetDeployFlags clears the package variables `runner deploy` binds its flags to.
// They are globals, so a value one run passed is the next run's default — and the whole
// point of the picker arms below is that the flag was NOT supplied.
func miscResetDeployFlags() {
	deployCloudIdentityID, deployRunnerName, deployRegion, deployAssignedID = "", "", "", ""
	deployRunnerWait = false
}

// miscResetDestroyFlags does the same for `runner destroy`.
func miscResetDestroyFlags() {
	destroyRunnerID, destroyRunnerAssignedID = "", ""
	destroyRunnerWait = false
}

// TestMisc_RunnerDeploy pins `runner deploy`: fully-flagged it creates the runner and
// queues one DEPLOY_RUNNER job, --wait follows that job to its terminal state, and a
// failed job exits non-zero rather than reporting a deploy that did not happen.
func TestMisc_RunnerDeploy(t *testing.T) {
	miscRestoreFlagState(t)
	miscFastPolls(t)

	fullFlags := []string{
		"--cloud-identity-id", "ci-aws", "--name", "runner-ci",
		"--region", "eu-west-1", "--assigned-runner-id", "r1",
	}

	t.Run("every flag supplied", func(t *testing.T) {
		miscResetDeployFlags()
		run := miscAdminEnv(t, miscAdminOpts{})
		if err := run(append([]string{"runner", "deploy"}, append(fullFlags, "--output", "json")...)...); err != nil {
			t.Error(err)
		}
	})

	t.Run("--wait follows the job to success", func(t *testing.T) {
		miscResetDeployFlags()
		run := miscAdminEnv(t, miscAdminOpts{jobStatus: "PROCESSING", jobStatusAfter: "SUCCESS"})
		if err := run(append([]string{"runner", "deploy", "--wait"}, append(fullFlags, "--output", "json")...)...); err != nil {
			t.Error(err)
		}
	})

	t.Run("--wait on a failed job exits non-zero", func(t *testing.T) {
		miscResetDeployFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{jobStatus: "FAILED"}))
		if !exits(append([]string{"runner", "deploy", "--wait"}, append(fullFlags, "--output", "json")...)...) {
			t.Error("expected a failed deploy job to exit non-zero")
		}
	})

	t.Run("--wait on a cancelled job exits non-zero", func(t *testing.T) {
		miscResetDeployFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{jobStatus: "CANCELLED"}))
		if !exits(append([]string{"runner", "deploy", "--wait"}, append(fullFlags, "--output", "json")...)...) {
			t.Error("expected a cancelled deploy job to exit non-zero")
		}
	})

	t.Run("omitted flags run the pickers", func(t *testing.T) {
		miscResetDeployFlags()
		run := miscAdminEnv(t, miscAdminOpts{})
		miscTTY(t)
		miscStubForm(t)
		if err := run("runner", "deploy", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("the cloud picker refuses without prompts", func(t *testing.T) {
		miscResetDeployFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
		if !exits("runner", "deploy", "--no-input", "--output", "json") {
			t.Error("expected the picker to refuse under --no-input")
		}
	})

	t.Run("a cloud with no runner template is refused", func(t *testing.T) {
		miscResetDeployFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{identities: []map[string]any{
			{"id": "ci-gcp", "provider": "gcp", "label": "analytics", "created_at": miscTS},
		}}))
		miscTTY(t)
		miscStubForm(t)
		if !exits("runner", "deploy", "--output", "json") {
			t.Error("expected a non-deployable cloud to be refused")
		}
	})

	t.Run("no linked cloud accounts is refused", func(t *testing.T) {
		miscResetDeployFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{empty: true}))
		miscTTY(t)
		miscStubForm(t)
		if !exits("runner", "deploy", "--output", "json") {
			t.Error("expected an empty cloud-account list to be refused")
		}
	})

	t.Run("a refusing control plane is fatal", func(t *testing.T) {
		miscResetDeployFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/runners/deploy"}))
		if !exits(append([]string{"runner", "deploy"}, append(fullFlags, "--output", "json")...)...) {
			t.Error("expected a refused deploy to be fatal")
		}
	})

	t.Run("an unreachable runner list is fatal", func(t *testing.T) {
		miscResetDeployFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/cli/runners"}))
		miscTTY(t)
		miscStubForm(t)
		if !exits("runner", "deploy", "--cloud-identity-id", "ci-aws", "--name", "n", "--region", "eu", "--output", "json") {
			t.Error("expected an unreachable runner list to be fatal")
		}
	})
}

// TestMisc_RunnerDestroy pins `runner destroy`: it queues one DESTROY_RUNNER job only
// after an explicit confirmation, refuses the picker's "Any available" answer (a teardown
// must name its target), and follows the job with --wait.
func TestMisc_RunnerDestroy(t *testing.T) {
	miscRestoreFlagState(t)
	miscFastPolls(t)

	t.Run("confirmed with both ids", func(t *testing.T) {
		miscResetDestroyFlags()
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, true)
		if err := run("runner", "destroy", "--runner-id", "r1", "--assigned-runner-id", "r2", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("declining confirms nothing", func(t *testing.T) {
		miscResetDestroyFlags()
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, false)
		if err := run("runner", "destroy", "--runner-id", "r1", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("the executor is picked when omitted", func(t *testing.T) {
		miscResetDestroyFlags()
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, true)
		miscTTY(t)
		miscStubForm(t)
		if err := run("runner", "destroy", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("a target of Any available is refused", func(t *testing.T) {
		miscResetDestroyFlags()
		// No default ONLINE runner, so the picker's pre-selected value is the empty
		// "Any available" option — which is not a thing you can tear down.
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{runners: []map[string]any{
			{"id": "r2", "name": "spare", "operator": "self", "status": "DRAINING"},
		}}))
		miscTTY(t)
		miscStubForm(t)
		if !exits("runner", "destroy", "--output", "json") {
			t.Error("expected an unnamed destroy target to be refused")
		}
	})

	t.Run("the picker refuses without prompts", func(t *testing.T) {
		miscResetDestroyFlags()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
		if !exits("runner", "destroy", "--no-input", "--output", "json") {
			t.Error("expected the picker to refuse under --no-input")
		}
	})

	t.Run("--wait follows the job", func(t *testing.T) {
		miscResetDestroyFlags()
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, true)
		if err := run("runner", "destroy", "--runner-id", "r1", "--assigned-runner-id", "r2", "--wait", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("--wait on a failed job exits non-zero", func(t *testing.T) {
		miscResetDestroyFlags()
		miscAlwaysConfirm(t, true)
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{jobStatus: "FAILED"}))
		if !exits("runner", "destroy", "--runner-id", "r1", "--assigned-runner-id", "r2", "--wait", "--output", "json") {
			t.Error("expected a failed teardown job to exit non-zero")
		}
	})

	t.Run("a refused queue is fatal", func(t *testing.T) {
		miscResetDestroyFlags()
		miscAlwaysConfirm(t, true)
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/jobs"}))
		if !exits("runner", "destroy", "--runner-id", "r1", "--assigned-runner-id", "r2", "--output", "json") {
			t.Error("expected a refused queue to be fatal")
		}
	})
}

// TestMisc_RunnerRemove pins `runner remove`: it deletes only the record, always behind a
// confirmation, and — like destroy — refuses to act on the picker's "Any available".
func TestMisc_RunnerRemove(t *testing.T) {
	miscRestoreFlagState(t)

	t.Run("by argument", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, true)
		if err := run("runner", "remove", "r1", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("declining removes nothing", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, false)
		if err := run("runner", "remove", "r1", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("by picker", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, true)
		miscTTY(t)
		miscStubForm(t)
		if err := run("runner", "remove", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("a target of Any available is refused", func(t *testing.T) {
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{runners: []map[string]any{
			{"id": "r3", "name": "cold", "operator": "self", "status": "OFFLINE"},
		}}))
		miscTTY(t)
		miscStubForm(t)
		if !exits("runner", "remove", "--output", "json") {
			t.Error("expected an unnamed removal target to be refused")
		}
	})

	t.Run("the picker refuses without prompts", func(t *testing.T) {
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
		if !exits("runner", "remove", "--no-input", "--output", "json") {
			t.Error("expected the picker to refuse under --no-input")
		}
	})

	t.Run("a refused delete is fatal", func(t *testing.T) {
		miscAlwaysConfirm(t, true)
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/cli/runners/"}))
		if !exits("runner", "remove", "r1", "--output", "json") {
			t.Error("expected a refused delete to be fatal")
		}
	})
}
