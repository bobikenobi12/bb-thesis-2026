// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"testing"
)

// The alert-rule mutations: create, delete, and the refusals.
//
// Split out of cov_misc_test.go, where "alerts" was the first word of a twenty-noun list.

// TestMisc_AlertsCreateAndDelete pins the alert-rule mutations: create reports the new
// rule, and delete only calls the control plane once the operator has confirmed.
func TestMisc_AlertsCreateAndDelete(t *testing.T) {
	run := miscEnv(t, miscFull)
	// This test passes --yes; clear it again so it cannot pre-confirm a later test.
	hygCliConfirmClearYes(t, alertsDeleteCmd)

	if err := run("alerts", "create", "job failures",
		"--event", "system.job.failed", "--channel", "ch1", "--severity", "critical",
		"--output", "json", "--no-input"); err != nil {
		t.Fatalf("alerts create: %v", err)
	}

	// The prompt cannot be answered headlessly, so a scripted delete without the
	// explicit --yes opt-in is fatal — it must never exit 0 having deleted nothing.
	// See hyg_cli_confirm_test.go for the contract this belongs to.
	trapped := miscTrapExit(t, run)
	if !trapped("alerts", "delete", "ar1", "--output", "json", "--no-input") {
		t.Error("alerts delete without --yes: expected the fatal path")
	}

	// With the operator opting in, the delete goes through.
	if err := run("alerts", "delete", "ar1", "--yes", "--output", "json", "--no-input"); err != nil {
		t.Fatalf("alerts delete (confirmed): %v", err)
	}
}

// TestMisc_AlertsMutationFailuresExit pins that a refused create/delete is fatal, not a
// silent success.
func TestMisc_AlertsMutationFailuresExit(t *testing.T) {
	run := miscTrapExit(t, miscEnv(t, miscFail))
	// This test passes --yes; clear it again so it cannot pre-confirm a later test.
	hygCliConfirmClearYes(t, alertsDeleteCmd)
	if !run("alerts", "create", "x", "--event", "e", "--channel", "c", "--output", "json", "--no-input") {
		t.Error("alerts create: expected the fatal path")
	}
	// --yes carries the delete past the confirmation, so the failure under test is
	// the refused control-plane call rather than the missing opt-in.
	if !run("alerts", "delete", "ar1", "--yes", "--output", "json", "--no-input") {
		t.Error("alerts delete: expected the fatal path")
	}
}
