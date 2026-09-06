// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"
)

// The break-glass surface: `alethia ops …`.
//
// Every verb opens an audited session and executes exactly one action against the single audited
// endpoint. The guardrails — a required --reason, a two-person --approval for the high-blast verbs,
// a --project scope for the orphan verbs, both CAS sides for unstick-env — are a subject of their
// own, because each is refused BEFORE any call to the control plane and that is the property that
// matters.

// TestMisc_OpsVerbs pins the break-glass surface: each verb opens an audited session and
// executes exactly one action against the single audited endpoint.
func TestMisc_OpsVerbs(t *testing.T) {
	run := miscEnv(t, miscFull)
	// --yes on every MUTATING verb, and on none of the read-only ones. #3702 gave the break-glass
	// group the same confirmation contract as the rest of the CLI: with prompts disabled a verb
	// that changes something must be opted into, or it exits non-zero having changed nothing. A
	// scripted case here without it is asserting the OLD behaviour.
	//
	// The statuses are project_status values, which is what the server's zod schema accepts.
	// This table said `--from APPLYING`, and APPLYING has never been one.
	cases := [][]string{
		{"ops"},
		{"ops", "approve", "state_surgery", "k1", "--reason", "incident-1"},
		{"ops", "session", "--reason", "incident-1"},
		{"ops", "inspect-job", "j1", "--reason", "incident-1"},
		{"ops", "retry-job", "j1", "--reason", "incident-1", "--yes"},
		{"ops", "cancel-job", "j1", "--reason", "incident-1", "--yes"},
		{"ops", "drain-runner", "r1", "--reason", "incident-1", "--yes"},
		{"ops", "restart-runner", "r1", "--reason", "incident-1", "--yes"},
		{"ops", "replay-webhook", "evt_1", "--reason", "incident-1", "--yes"},
		{"ops", "replay-webhook", "evt_1", "--reason", "incident-1", "--send-emails", "--yes"},
		{"ops", "unstick-env", "e1", "--reason", "incident-1", "--from", "PROVISIONING, ", "--to", "FAILED", "--yes"},
		{"ops", "force-release-lock", "k1", "--reason", "incident-1", "--approval", "ap1", "--yes"},
		{"ops", "state-surgery", "k1", "--reason", "incident-1", "--approval", "ap1", "--note", "rebind the address", "--yes"},
		{"ops", "state-surgery", "k1", "--reason", "incident-1", "--approval", "ap1", "--note", "", "--yes"},
		{"ops", "orphan-detect", "--reason", "incident-1", "--project", "p1"},
		{"ops", "orphan-clean", "--reason", "incident-1", "--project", "p1", "--approval", "ap1", "--yes"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if err := run(append(append([]string{}, args...), "--output", "json", "--no-input")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
	}
}

// TestMisc_OpsResultWithoutData pins that a result carrying no data payload prints the
// detail line alone, instead of an empty json block.
func TestMisc_OpsResultWithoutData(t *testing.T) {
	run := miscEnv(t, miscEmpty)
	if err := run("ops", "inspect-job", "j1", "--reason", "incident-1", "--output", "json", "--no-input"); err != nil {
		t.Fatalf("ops inspect-job: %v", err)
	}
}

// TestMisc_OpsRefusesMissingSafetyFlags pins the guardrails on the break-glass verbs: an
// incident --reason is always required, high-blast verbs need a two-person --approval,
// orphan verbs need a --project scope, and unstick-env needs both CAS sides. Each is
// refused before any call to the control plane.
func TestMisc_OpsRefusesMissingSafetyFlags(t *testing.T) {
	run := miscTrapExit(t, miscEnv(t, miscFull))
	cases := [][]string{
		{"ops", "approve", "state_surgery", "k1", "--reason="},
		{"ops", "session", "--reason="},
		{"ops", "inspect-job", "j1", "--reason="},
		{"ops", "force-release-lock", "k1", "--reason", "i", "--approval="},
		{"ops", "state-surgery", "k1", "--reason", "i", "--approval="},
		{"ops", "orphan-detect", "--reason", "i", "--project="},
		{"ops", "orphan-clean", "--reason", "i", "--project="},
		{"ops", "orphan-clean", "--reason", "i", "--project", "p1", "--approval="},
		{"ops", "unstick-env", "e1", "--reason", "i", "--from=", "--to="},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if !run(append(append([]string{}, args...), "--output", "json", "--no-input")...) {
				t.Errorf("%v: expected the fatal path", args)
			}
		})
	}
}

// TestMisc_OpsFailuresExit pins that a refused session or a refused action is fatal — a
// break-glass verb must never look like it succeeded.
func TestMisc_OpsFailuresExit(t *testing.T) {
	run := miscTrapExit(t, miscEnv(t, miscFail))
	for _, args := range [][]string{
		{"ops", "approve", "state_surgery", "k1", "--reason", "i"},
		{"ops", "session", "--reason", "i"},
		{"ops", "inspect-job", "j1", "--reason", "i"},
	} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if !run(append(append([]string{}, args...), "--output", "json", "--no-input")...) {
				t.Errorf("%v: expected the fatal path", args)
			}
		})
	}
}

// TestMisc_OpsActionRefusedAfterTheSessionOpens pins the second failure point of a
// break-glass verb: the audited session opens, and it is the ACTION the server refuses.
// That is a different arm from a refused session, and it must still be fatal.
func TestMisc_OpsActionRefusedAfterTheSessionOpens(t *testing.T) {
	exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/breakglass/execute"}))
	if !exits("ops", "inspect-job", "j1", "--reason", "incident-1", "--output", "json") {
		t.Error("expected a refused action to be fatal")
	}
}

// TestMisc_OpsActionsFailClosedWithoutCredentials pins that the shared break-glass action
// path checks for a token before it opens an audited session — the verbs route through one
// helper, so this is the only place that check runs.
func TestMisc_OpsActionsFailClosedWithoutCredentials(t *testing.T) {
	isolatedHome(t) // deliberately no saveCredentials
	t.Setenv("ALETHIA_WEB_ORIGIN", "http://127.0.0.1:1")
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	prev := authRequiredPrompt
	authRequiredPrompt = func() (bool, error) { return false, nil }
	t.Cleanup(func() { authRequiredPrompt = prev })

	exits := miscTrapExit(t, func(args ...string) error {
		miscResetNoInput()
		execRootArgs(args)
		return rootCmd.Execute()
	})
	for _, args := range [][]string{
		{"ops", "inspect-job", "j1", "--reason", "incident-1"},
		{"ops", "orphan-detect", "--reason", "incident-1", "--project", "p1"},
	} {
		if !exits(append(args, "--output", "json")...) {
			t.Errorf("%v: expected the missing-credentials path to exit non-zero", args)
		}
	}
}
