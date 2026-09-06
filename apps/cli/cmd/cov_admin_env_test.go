// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
)

// The harness for the commands that need a PATH-AWARE control plane.
//
// These commands do not share the one-envelope fake in cov_envelope_test.go: `provider status`,
// `provider verify`, `jobs get` and `runner deploy` each decode the whole response body into their
// own struct, and three of them want a different value under the same `status` key.
//
// What the fake ANSWERS is in fake_cp_test.go, as a registry a lane extends with a pack. What is in
// this file is the process-level state around it — isolated credentials, an active org, the exit
// hook, and the flag resets that stop one test deciding the next one's code arm.

// miscAdminOpts tunes the path-aware fake control plane: which collections come back
// empty, which endpoint answers 500, what the runner and cloud-account inventories look
// like, and what verdict the job poller and the provider probe report.
type miscAdminOpts struct {
	// empty makes every collection endpoint answer with a zero-length list.
	empty bool
	// failOn is a path substring the server answers 500 for ("" = never fail).
	failOn string
	// runners is the runner inventory the picker sees.
	runners []map[string]any
	// identities is the linked-cloud-account inventory the picker sees.
	identities []map[string]any
	// jobStatus is what GetJob reports. Empty means SUCCESS.
	jobStatus string
	// jobStatusAfter, when set, is reported from the second GetJob onwards, so a poll
	// loop runs its wait-and-retry arm exactly once.
	jobStatusAfter string
	// connected is the provider probe's connection verdict.
	connected bool
	// verified and verifyStatus are the re-verification verdict.
	verified     bool
	verifyStatus string
}

// miscAdminEnv stands up the path-aware fake control plane with isolated credentials and
// an active org, and returns a runner that executes the real cobra tree. As with miscEnv,
// the caller must always pass --output explicitly: rootCmd is a package global whose flag
// state is sticky between runs.
func miscAdminEnv(t *testing.T, o miscAdminOpts) func(args ...string) error {
	t.Helper()
	credsPath := isolatedHome(t)
	if err := saveCredentials(credsPath, types.ExchangeResponse{
		AccessToken: makeToken(t, time.Now().Add(time.Hour)), RefreshToken: "r",
	}); err != nil {
		t.Fatal(err)
	}
	if err := types.SaveCliConfig(types.CliConfig{
		ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme",
	}); err != nil {
		t.Fatal(err)
	}
	if o.jobStatus == "" {
		o.jobStatus = "SUCCESS"
	}
	if o.runners == nil {
		o.runners = miscRunnerInventory()
	}
	if o.identities == nil {
		o.identities = []map[string]any{
			{"id": "ci-aws", "provider": "aws", "label": "prod-account", "created_at": miscTS},
			{"id": "ci-gcp", "provider": "gcp", "label": "analytics", "created_at": miscTS},
		}
	}

	// The endpoints live in fake_cp_test.go as a REGISTRY, not as a switch here. This function
	// stands the server up and owns the process-level state around it (credentials, the active
	// org, the exit hook, the flag reset); what the control plane ANSWERS is a separate concern
	// that every noun lane extends.
	srv := cpServer(t, o)

	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	// Substitute the process-exit hook for the whole env, so a command that takes a fatal
	// path is reported to the caller instead of killing the test binary — even in a test
	// that expected the command to succeed.
	prevExit := exitFunc
	exitFunc = func(code int) { panic(miscExit{code}) }
	t.Cleanup(func() { exitFunc = prevExit })
	t.Cleanup(miscResetNoInput)

	return func(args ...string) (err error) {
		defer func() {
			r := recover()
			if r == nil {
				return
			}
			e, ok := r.(miscExit)
			if !ok {
				panic(r)
			}
			if e.code == 0 {
				t.Errorf("%v: fatal path exited 0, want non-zero", args)
			}
			err = errMiscExited
		}()
		miscResetNoInput()
		execRootArgs(args)
		return rootCmd.Execute()
	}
}

// errMiscExited reports that a command took the fatal path (it called exitFunc).
var errMiscExited = errors.New("command exited")

// miscFatalRunner adapts a runner into a predicate: true when the command exited.
func miscFatalRunner(run func(args ...string) error) func(args ...string) bool {
	return func(args ...string) bool { return errors.Is(run(args...), errMiscExited) }
}

// miscResetNoInput clears --no-input on rootCmd. It is a persistent flag on a package
// global, so one test passing it would otherwise disable prompts for every later test —
// which silently turns an interactive arm into a fatal one.
func miscResetNoInput() {
	f := rootCmd.PersistentFlags().Lookup("no-input")
	if f == nil {
		return
	}
	_ = f.Value.Set("false")
	f.Changed = false
}

// miscTS is the one timestamp every fixture uses, so no assertion can depend on the clock.
const miscTS = "2026-01-01T00:00:00Z"

// miscRunnerInventory is the default runner list: one ONLINE default (which the picker
// pre-selects), plus a DRAINING and an OFFLINE one so every status glyph arm renders.
func miscRunnerInventory() []map[string]any {
	return []map[string]any{
		{"id": "r1", "name": "primary", "operator": "managed", "status": "ONLINE", "is_default": true},
		{"id": "r2", "name": "spare", "operator": "self", "provisioning": "registered", "status": "DRAINING"},
		{"id": "r3", "name": "cold", "operator": "self", "provisioning": "deployed", "status": "OFFLINE"},
	}
}

// miscFleetPool is a fully populated warm pool (pinned version + locations).
func miscFleetPool() map[string]any {
	return map[string]any{
		"provider": "aws", "warm_min": 2, "max": 10, "slots_per_runner": 2,
		"locations": []string{"eu-west-1", "us-east-1"}, "version": "1.4.2", "enabled": true,
	}
}

// miscInventory is a cloud identity's discovered networking, or an empty one.
func miscInventory(empty bool) map[string]any {
	if empty {
		return map[string]any{"networks": []any{}, "subnets": []any{}, "regions": []any{}}
	}
	name, region, cidr, az := "prod-vpc", "eu-west-1", "10.0.0.0/16", "eu-west-1a"
	return map[string]any{
		"networks": []any{
			map[string]any{"native_id": "vpc-1", "name": name, "region": region, "provider": "aws", "cidr_block": cidr, "is_default": true},
			map[string]any{"native_id": "vpc-2", "provider": "aws"},
		},
		"subnets": []any{
			map[string]any{"native_id": "sub-1", "name": "public-a", "region": region, "availability_zone": az, "cidr_block": "10.0.1.0/24", "is_public": true},
			map[string]any{"native_id": "sub-2"},
		},
		"regions": []string{"eu-west-1", "us-east-1"},
	}
}

// miscJobTotal reports the job count matching the empty/populated fixture.
func miscJobTotal(empty bool) int {
	if empty {
		return 0
	}
	return 1
}

// miscAlwaysConfirm answers yes to every destructive confirmation, and restores the real
// prompt afterwards. No stub of runHuhForm can do this: the answer is written through a
// pointer the huh group owns and never exposes.
func miscAlwaysConfirm(t *testing.T, answer bool) {
	t.Helper()
	// A destructive command consults noInputMode before it prompts, so the stubbed
	// answer is only reachable with the terminal seams on.
	miscTTY(t)
	prev := confirm
	confirm = func(string, string) bool { return answer }
	t.Cleanup(func() { confirm = prev })
}

// miscStubForm makes every huh form return immediately without touching a terminal, so a
// selector runs its whole option-building body and then returns its default value.
func miscStubForm(t *testing.T) {
	t.Helper()
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return nil }
	t.Cleanup(func() { runHuhForm = prev })
}

// miscFastPolls shrinks the two job poll intervals so a wait loop cannot add wall-clock
// time to the suite, and restores them afterwards.
func miscFastPolls(t *testing.T) {
	t.Helper()
	prevJob, prevLogs := jobPollInterval, jobsLogsPollInterval
	jobPollInterval, jobsLogsPollInterval = time.Millisecond, time.Millisecond
	t.Cleanup(func() { jobPollInterval, jobsLogsPollInterval = prevJob, prevLogs })
}

// miscRestoreFlagState puts the command tree in its pristine state for the duration of a test.
//
// It is resetFlagsAroundTest under this package's older name, kept because a dozen tests call it.
// The version it replaced listed twenty-one package variables by hand and restored them only on the
// way OUT, so a test's own starting state was whatever the previous file had left behind.
func miscRestoreFlagState(t *testing.T) {
	t.Helper()
	resetFlagsAroundTest(t)
	t.Cleanup(miscClearFleetChanged)
}

// miscClearFleetChanged resets pflag's Changed bits on `fleet set`. buildFleetUpdate reads
// them to decide what to send, and they are never cleared within a process.
func miscClearFleetChanged() {
	for _, name := range []string{"warm-min", "max", "slots", "enabled", "channel", "version"} {
		if f := fleetSetCmd.Flags().Lookup(name); f != nil {
			f.Changed = false
		}
	}
}

// miscAdminCommands is every command in this group that reaches for a token before it does
// anything else, with the flags each one needs to get past cobra's argument validation.
func miscAdminCommands() [][]string {
	return [][]string{
		{"whoami"},
		{"org", "list"}, {"org", "settings"}, {"org", "switch", "acme"},
		{"members", "list"}, {"members", "add", "new@x.com"}, {"members", "remove", "m1"},
		{"teams", "list"}, {"teams", "create", "SRE"}, {"teams", "delete", "t1"},
		{"grants", "list"}, {"grants", "add", "--principal", "u1", "--role", "role1"}, {"grants", "remove", "g1"},
		{"roles", "list"}, {"roles", "create", "deployer"}, {"roles", "delete", "role2"},
		{"fleet", "list"}, {"fleet", "set", "aws", "--max", "4"},
		{"provider", "status", "aws"}, {"provider", "verify", "aws"},
		{"runner", "list"}, {"runner", "remove", "r1"},
		{"runner", "deploy", "--cloud-identity-id", "ci-aws", "--name", "n", "--region", "eu-west-1", "--assigned-runner-id", "r1"},
		{"runner", "destroy", "--runner-id", "r1", "--assigned-runner-id", "r2"},
		{"jobs", "list"}, {"jobs", "get", "j1"}, {"jobs", "logs", "j1"}, {"jobs", "cancel", "j1", "--yes"},
		{"usage"}, {"billing"}, {"cloud", "inventory", "ci-aws"},
		{"project", "list"}, {"connector", "list"}, {"cluster", "list"}, {"config", "export", "web"},
		{"activity"}, {"repo", "list"}, {"agent", "list"}, {"agent", "get", "ag1"},
		// `alerts create` needs its two required flags HERE. Without them cobra refuses the
		// command before the credential check this list exists to drive, and the entry passed
		// only while a test earlier in the same file had already set pflag's Changed bit on
		// them — which the split by subject moved apart and exposed.
		{"alerts", "list"}, {"alerts", "create", "rule", "--event", "e", "--channel", "c"},
		{"alerts", "delete", "ar1"},
		{"sso", "list"}, {"sso", "get", "sso1"},
		{"addon", "list", "-p", "web"}, {"chart", "list", "-p", "web"}, {"staged", "list", "-p", "web"},
		{"protection", "list", "-p", "web"}, {"probes", "list", "-p", "web"},
		{"promotion", "list", "-p", "web"}, {"promotion", "get", "pr1", "-p", "web"},
		{"cost", "show", "-p", "web"}, {"iac", "show", "-p", "web"}, {"drift", "show", "-p", "web"},
		{"cluster", "get", "web"},
		{"ops", "session", "--reason", "incident-1"},
		{"ops", "approve", "state_surgery", "k1", "--reason", "incident-1"},
	}
}

// TestMisc_EveryCommandFailsClosedWithoutCredentials pins the single most repeated branch
// in this package: with no credentials on disk and prompting refused, every authenticated
// command exits non-zero at the token check rather than calling the control plane with an
// empty token.
func TestMisc_EveryCommandFailsClosedWithoutCredentials(t *testing.T) {
	isolatedHome(t) // deliberately no saveCredentials
	miscRestoreFlagState(t)
	t.Setenv("ALETHIA_WEB_ORIGIN", "http://127.0.0.1:1")
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	prev := authRequiredPrompt
	authRequiredPrompt = func() (bool, error) { return false, nil }
	t.Cleanup(func() { authRequiredPrompt = prev })

	run := miscTrapExit(t, func(args ...string) error {
		execRootArgs(args)
		return rootCmd.Execute()
	})

	for _, args := range miscAdminCommands() {
		if !run(append(append([]string{}, args...), "--output", "json")...) {
			t.Errorf("%v: expected the missing-credentials path to exit non-zero", args)
		}
	}
}
