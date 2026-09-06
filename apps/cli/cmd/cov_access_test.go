// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Who may do what, and on whose behalf: grants, roles, members, teams and the active org.
//
// The refusal arms are as much the subject as the happy ones. An access command that fails open is
// worse than one that fails, so every mutation here is driven in both directions.

// TestMisc_AccessSurfaceReads pins `grants list` and `roles list` in all three arms —
// interactive table, json, and the muted note when the org has none.
func TestMisc_AccessSurfaceReads(t *testing.T) {
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
			for _, args := range [][]string{{"grants", "list"}, {"roles", "list"}} {
				if err := run(append(args, "--output", tc.out)...); err != nil {
					t.Errorf("%v: %v", args, err)
				}
			}
		})
	}
}

// TestMisc_AccessSurfaceMutations pins the grant and role write verbs: a grant binds
// either a role or a single permission (never both), and revoking one only calls the
// control plane after the operator confirms.
func TestMisc_AccessSurfaceMutations(t *testing.T) {
	miscRestoreFlagState(t)
	run := miscAdminEnv(t, miscAdminOpts{})
	miscAlwaysConfirm(t, true)

	for _, args := range [][]string{
		// Real uuids: `--principal` and `--role` are lookup keys now, and a value that is not
		// already a uuid is resolved against the org rather than posted to a `z.uuid()` field.
		{"grants", "add", "--principal", "11111111-1111-4111-8111-111111111111", "--role", "33333333-3333-4333-8333-333333333333", "--permission", "", "--resource", "44444444-4444-4444-8444-444444444444", "--resource-type", "project"},
		{"grants", "add", "--principal", "22222222-2222-4222-8222-222222222222", "--principal-type", "team", "--role", "", "--permission", "project:destroy", "--effect", "deny", "--resource", ""},
		{"grants", "remove", "g1"},
		{"roles", "create", "deployer", "--permission", "project:deploy"},
		{"roles", "delete", "role2"},
	} {
		if err := run(append(args, "--output", "json")...); err != nil {
			t.Errorf("%v: %v", args, err)
		}
	}
}

// TestMisc_AccessSurfaceRefusals pins that a grant binding neither (or both) of a role and
// a permission is refused before any call, a declined confirmation revokes nothing, and a
// refusing control plane is fatal on every access verb.
func TestMisc_AccessSurfaceRefusals(t *testing.T) {
	miscRestoreFlagState(t)

	t.Run("role and permission are exclusive", func(t *testing.T) {
		miscRestoreFlagState(t)
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
		for _, args := range [][]string{
			{"grants", "add", "--principal", "u1", "--role", "", "--permission", ""},
			{"grants", "add", "--principal", "u1", "--role", "role1", "--permission", "project:deploy"},
		} {
			if !exits(append(args, "--output", "json")...) {
				t.Errorf("%v: expected a refusal", args)
			}
		}
	})

	t.Run("declined confirmation revokes nothing", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, false)
		for _, args := range [][]string{{"grants", "remove", "g1"}, {"roles", "delete", "role2"}} {
			if err := run(append(args, "--output", "json")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		}
	})

	t.Run("a refusing control plane is fatal", func(t *testing.T) {
		miscRestoreFlagState(t)
		miscAlwaysConfirm(t, true)
		for _, tc := range []struct {
			failOn string
			args   []string
		}{
			{"/grants", []string{"grants", "list"}},
			{"/grants", []string{"grants", "add", "--principal", "u1", "--role", "role1", "--permission", ""}},
			{"/grants", []string{"grants", "remove", "g1"}},
			{"/roles", []string{"roles", "list"}},
			{"/roles", []string{"roles", "create", "x"}},
			{"/roles", []string{"roles", "delete", "role2"}},
		} {
			exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: tc.failOn}))
			if !exits(append(tc.args, "--output", "json")...) {
				t.Errorf("%v: expected the failure to be fatal", tc.args)
			}
		}
	})

	t.Run("a refusing control plane is fatal on the interactive arm too", func(t *testing.T) {
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/cli/"}))
		miscTTY(t)
		for _, args := range [][]string{
			{"grants", "list"}, {"roles", "list"}, {"teams", "list"}, {"members", "list"}, {"fleet", "list"},
		} {
			if !exits(append(args, "--output", "table")...) {
				t.Errorf("%v: expected the failure to be fatal", args)
			}
		}
	})
}

// TestMisc_OrgMembershipSurface pins the members and teams verbs in every arm: the three
// output formats, the interactive table, the empty org, and the write verbs (whose delete
// is gated on a confirmation).
func TestMisc_OrgMembershipSurface(t *testing.T) {
	miscRestoreFlagState(t)

	t.Run("reads", func(t *testing.T) {
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
				for _, args := range [][]string{{"members", "list"}, {"teams", "list"}, {"org", "settings"}} {
					if err := run(append(args, "--output", tc.out)...); err != nil {
						t.Errorf("%v: %v", args, err)
					}
				}
			})
		}
	})

	t.Run("writes", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		miscAlwaysConfirm(t, true)
		for _, args := range [][]string{
			{"members", "add", "new@x.com", "--role", "operator"},
			{"members", "remove", "m1"},
			{"teams", "create", "SRE"},
			{"teams", "delete", "t1"},
		} {
			if err := run(append(args, "--output", "json")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		}
	})

	t.Run("an explicit --org overrides the active context", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		for _, args := range [][]string{{"members", "list", "--org", "o2"}, {"teams", "list", "--org", "o2"}} {
			if err := run(append(args, "--output", "json")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		}
	})

	t.Run("without an org context every verb refuses", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		if err := types.SaveCliConfig(types.CliConfig{}); err != nil {
			t.Fatal(err)
		}
		exits := miscFatalRunner(run)
		for _, args := range [][]string{
			{"members", "list", "--org", ""}, {"members", "add", "a@x.com", "--org", ""},
			{"members", "remove", "m1", "--org", ""}, {"teams", "list", "--org", ""},
			{"teams", "create", "x", "--org", ""}, {"teams", "delete", "t1", "--org", ""},
		} {
			if !exits(append(args, "--output", "json")...) {
				t.Errorf("%v: expected a missing org context to be fatal", args)
			}
		}
	})

	t.Run("a refusing control plane is fatal", func(t *testing.T) {
		miscAlwaysConfirm(t, true)
		for _, args := range [][]string{
			{"members", "list"}, {"members", "add", "a@x.com"}, {"members", "remove", "m1"},
			{"teams", "list"}, {"teams", "create", "x"}, {"teams", "delete", "t1"},
			{"org", "settings"},
		} {
			exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/cli/"}))
			if !exits(append(args, "--output", "json")...) {
				t.Errorf("%v: expected the failure to be fatal", args)
			}
		}
	})
}

// TestMisc_OrgSwitchResolvesATarget pins how `org switch` resolves its argument: an id, a
// slug or a name all match, an unknown target is fatal, and with no argument and prompts
// disabled it refuses rather than guessing.
func TestMisc_OrgSwitchResolvesATarget(t *testing.T) {
	run := miscAdminEnv(t, miscAdminOpts{})
	for _, target := range []string{"o2", "beta", "Beta"} {
		if err := run("org", "switch", target, "--output", "json"); err != nil {
			t.Errorf("switch %q: %v", target, err)
		}
		if got := types.LoadCliConfig().ActiveOrgID; got != "o2" {
			t.Errorf("switch %q: active org = %q, want o2", target, got)
		}
	}

	exits := miscFatalRunner(run)
	for _, args := range [][]string{
		{"org", "switch", "nope"}, // no such org
		{"org", "switch"},         // needs the picker, which --no-input refuses
	} {
		if !exits(append(args, "--output", "json", "--no-input")...) {
			t.Errorf("%v: expected a refusal", args)
		}
	}

	noOrgs := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{empty: true}))
	if !noOrgs("org", "switch", "acme", "--output", "json") {
		t.Error("expected an empty org list to be fatal")
	}
}

// TestMisc_OrgSwitchPickerFailureIsReported pins that when `org switch` has no argument and
// prompts ARE enabled, a picker that cannot open is surfaced as an error rather than
// leaving the active organization silently unchanged.
func TestMisc_OrgSwitchPickerFailureIsReported(t *testing.T) {
	// No miscStubForm here on purpose: the real huh form is what fails headlessly, which
	// is exactly the arm under test.
	exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{}))
	miscTTY(t)
	if !exits("org", "switch", "--output", "json") {
		t.Error("expected a picker that cannot open to be reported")
	}
}
