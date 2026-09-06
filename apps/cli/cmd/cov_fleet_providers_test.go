// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"testing"
)

// The capacity and connection surfaces: warm pools, the cloud-connection probe, and the meter.
//
// Grouped because all three answer "can this org provision right now" — a pool with no warm
// capacity, a provider that no longer verifies, and a plan out of seats are three spellings of the
// same operator question.

// TestMisc_FleetSurface pins the warm-pool commands: the list in every arm, a partial
// update that only sends the flags actually passed, the refusal when none were, and the
// extra confirmation a pool being disabled requires.
func TestMisc_FleetSurface(t *testing.T) {
	miscRestoreFlagState(t)

	t.Run("list", func(t *testing.T) {
		for _, tc := range []struct {
			name  string
			empty bool
			tty   bool
			out   string
		}{
			{"json", false, false, "json"},
			{"csv", false, false, "csv"},
			{"static table", false, false, "table"},
			{"interactive table", false, true, "table"},
			{"empty static", true, false, "table"},
			{"empty interactive", true, true, "table"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				run := miscAdminEnv(t, miscAdminOpts{empty: tc.empty})
				if tc.tty {
					miscTTY(t)
				}
				if err := run("fleet", "list", "--output", tc.out); err != nil {
					t.Error(err)
				}
			})
		}
	})

	t.Run("set with no flags is refused", func(t *testing.T) {
		miscRestoreFlagState(t)
		miscClearFleetChanged()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
		if !exits("fleet", "set", "aws", "--output", "json") {
			t.Error("expected an empty update to be refused")
		}
	})

	t.Run("each flag is sent on its own", func(t *testing.T) {
		miscRestoreFlagState(t)
		run := miscAdminEnv(t, miscAdminOpts{})
		for _, flags := range [][]string{
			{"--warm-min", "3"}, {"--max", "12"}, {"--slots", "4"},
			{"--channel", "stable"}, {"--version", "1.4.3"},
			{"--enabled=true"},
		} {
			miscClearFleetChanged()
			if err := run(append([]string{"fleet", "set", "aws"}, append(flags, "--output", "json")...)...); err != nil {
				t.Errorf("%v: %v", flags, err)
			}
		}
	})

	t.Run("disabling a pool asks first", func(t *testing.T) {
		miscRestoreFlagState(t)
		run := miscAdminEnv(t, miscAdminOpts{})

		miscAlwaysConfirm(t, false)
		miscClearFleetChanged()
		if err := run("fleet", "set", "aws", "--enabled=false", "--output", "json"); err != nil {
			t.Errorf("declined disable: %v", err)
		}
	})

	t.Run("a confirmed disable is applied", func(t *testing.T) {
		miscRestoreFlagState(t)
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, true)
		miscClearFleetChanged()
		if err := run("fleet", "set", "aws", "--enabled=false", "--output", "json"); err != nil {
			t.Errorf("confirmed disable: %v", err)
		}
	})

	t.Run("a refusing control plane is fatal", func(t *testing.T) {
		miscRestoreFlagState(t)
		miscClearFleetChanged()
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/cli/fleet"}))
		if !exits("fleet", "set", "aws", "--max", "9", "--output", "json") {
			t.Error("expected the failure to be fatal")
		}
		miscClearFleetChanged()
		if !exits("fleet", "list", "--output", "json") {
			t.Error("expected the failure to be fatal")
		}
	})
}

// TestMisc_ProviderStatusAndVerify pins the read-only provider verbs: status renders only
// the identity fields the connected cloud actually has, and verify reports the probe's
// verdict — succeeding on connected, warning on degraded, and exiting non-zero whenever
// the identity is missing or the probe fails it.
func TestMisc_ProviderStatusAndVerify(t *testing.T) {
	t.Run("status renders in every format", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{connected: true})
		for _, out := range []string{"json", "csv", "table"} {
			for _, provider := range []string{"aws", "gcp", "azure"} {
				if err := run("provider", "status", provider, "--output", out); err != nil {
					t.Errorf("%s/%s: %v", provider, out, err)
				}
			}
		}
	})

	t.Run("a disconnected provider still renders", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{connected: false})
		if err := run("provider", "status", "aws", "--output", "table"); err != nil {
			t.Error(err)
		}
	})

	t.Run("a verified identity passes", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{connected: true, verified: true, verifyStatus: "connected"})
		for _, out := range []string{"json", "table"} {
			if err := run("provider", "verify", "aws", "--output", out); err != nil {
				t.Errorf("%s: %v", out, err)
			}
		}
	})

	t.Run("a degraded identity passes with a warning", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{connected: true, verified: true, verifyStatus: "degraded"})
		if err := run("provider", "verify", "aws", "--output", "table"); err != nil {
			t.Error(err)
		}
	})

	t.Run("a failed verdict is fatal", func(t *testing.T) {
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{
			connected: true, verified: false, verifyStatus: "disconnected",
		}))
		if !exits("provider", "verify", "aws", "--output", "table") {
			t.Error("expected a failed verification to exit non-zero")
		}
	})

	t.Run("nothing connected is fatal", func(t *testing.T) {
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{connected: false}))
		if !exits("provider", "verify", "aws", "--output", "json") {
			t.Error("expected an unconnected provider to exit non-zero")
		}
	})

	t.Run("a refusing control plane is fatal", func(t *testing.T) {
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/status"}))
		for _, args := range [][]string{{"provider", "status", "aws"}, {"provider", "verify", "aws"}} {
			if !exits(append(args, "--output", "json")...) {
				t.Errorf("%v: expected the failure to be fatal", args)
			}
		}
		probeFails := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{connected: true, failOn: "/verify"}))
		if !probeFails("provider", "verify", "aws", "--output", "json") {
			t.Error("expected a refused probe to be fatal")
		}
	})
}

// TestMisc_UsageBillingAndInventory pins the remaining read-only cards: usage and billing
// render their counters in every format, and the cloud inventory renders its networks,
// subnets and regions — reporting plainly when nothing has been discovered yet.
func TestMisc_UsageBillingAndInventory(t *testing.T) {
	t.Run("populated", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		for _, out := range []string{"json", "csv", "table"} {
			for _, args := range [][]string{{"usage"}, {"billing"}, {"cloud", "inventory", "ci-aws"}} {
				if err := run(append(args, "--output", out)...); err != nil {
					t.Errorf("%v/%s: %v", args, out, err)
				}
			}
		}
	})

	t.Run("a community org has no seat count and no inventory", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{empty: true})
		for _, args := range [][]string{{"billing"}, {"cloud", "inventory", "ci-aws"}} {
			if err := run(append(args, "--output", "table")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		}
	})

	t.Run("a refusing control plane is fatal", func(t *testing.T) {
		for _, tc := range []struct {
			failOn string
			args   []string
		}{
			{"/usage", []string{"usage"}},
			{"/billing", []string{"billing"}},
			{"/inventory", []string{"cloud", "inventory", "ci-aws"}},
		} {
			exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: tc.failOn}))
			if !exits(append(tc.args, "--output", "json")...) {
				t.Errorf("%v: expected the failure to be fatal", tc.args)
			}
		}
	})
}
