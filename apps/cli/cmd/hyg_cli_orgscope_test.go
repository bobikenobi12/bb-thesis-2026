// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// `--org` is a GLOBAL, and this file holds the three things that make that word true.
//
// It was documented as one on eleven pages and registered on two commands (#3817). Promoting it to
// the root fixes that, but it introduces two new ways to be quietly wrong, and neither of them
// fails visibly:
//
//   - A group registering its OWN `--org` again. Cobra resolves a flag to the nearest definition,
//     so `members` would bind a different variable from every other command — same spelling, two
//     meanings, and `alethia members list --org x` would still "work" while sending the wrong
//     header. This is the shape the flag had BEFORE, so it is the shape it would regress to.
//   - A subcommand growing its own PersistentPreRun. Cobra runs only the NEAREST one, so the root's
//     would stop running and `--org` would parse fine and reach nothing.
//
// Both are asserted against the live tree rather than a list of commands, so a group added next
// month is covered by existing.

// orgScopeRunnable returns every runnable command in the tree, cobra's own `help`/`completion`
// excepted — they are generated and take no scope.
func orgScopeRunnable(root *cobra.Command) []*cobra.Command {
	var out []*cobra.Command
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		for _, sub := range c.Commands() {
			if sub.Name() == "help" || sub.Name() == "completion" {
				continue
			}
			if sub.Runnable() {
				out = append(out, sub)
			}
			walk(sub)
		}
	}
	walk(root)
	return out
}

// TestHygCliOrgScope_EveryCommandInheritsTheOneOrgFlag pins the registration in both directions:
// the root has it, and nothing else does.
func TestHygCliOrgScope_EveryCommandInheritsTheOneOrgFlag(t *testing.T) {
	if rootCmd.PersistentFlags().Lookup("org") == nil {
		t.Fatal("--org is not a root persistent flag — every assertion below is about a flag that " +
			"does not exist, and `alethia cluster list --org x` is back to an unknown-flag error")
	}

	cmds := orgScopeRunnable(rootCmd)
	if len(cmds) == 0 {
		t.Fatal("the walk found no runnable commands — this guard is not seeing the tree")
	}
	checked := 0
	for _, cmd := range cmds {
		checked++
		// LOCAL, not "not inherited": a command that re-registers `--org` has it in BOTH sets, and
		// asking only about InheritedFlags would report the shadowed root flag and pass.
		if f := cmd.LocalFlags().Lookup("org"); f != nil {
			t.Errorf("`%s` registers its own --org, shadowing the root's. Cobra binds the NEAREST "+
				"definition, so this command would read a different variable from the rest of the "+
				"tree while spelling the flag the same way — which is the defect #3817 removed.",
				cmd.CommandPath())
			continue
		}
		if cmd.InheritedFlags().Lookup("org") == nil {
			t.Errorf("`%s` does not inherit --org", cmd.CommandPath())
		}
	}
	if checked == 0 {
		t.Fatal("no command was checked — every assertion above was vacuous")
	}
}

// TestHygCliOrgScope_TheRootOwnsTheOnlyPersistentPreRun pins the hook that applies the flag.
//
// applyOrgScope runs there and nowhere else. Cobra walks from the command being executed up to the
// root and runs the FIRST PersistentPreRun it finds, so any second one in the tree silently
// replaces the root's for its whole subtree — the flag would still parse, and the header would
// still be the active org.
func TestHygCliOrgScope_TheRootOwnsTheOnlyPersistentPreRun(t *testing.T) {
	if rootCmd.PersistentPreRun == nil && rootCmd.PersistentPreRunE == nil {
		t.Fatal("the root has no PersistentPreRun — nothing applies --org")
	}
	var offenders []string
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		for _, sub := range c.Commands() {
			if sub.PersistentPreRun != nil || sub.PersistentPreRunE != nil {
				offenders = append(offenders, sub.CommandPath())
			}
			walk(sub)
		}
	}
	walk(rootCmd)
	if len(offenders) > 0 {
		t.Errorf("these commands define their own PersistentPreRun, which REPLACES the root's for "+
			"their subtree — --org (and --no-input) would stop being applied there: %s\n"+
			"      If one is genuinely needed, it has to call applyOrgScope and resolveInputMode "+
			"itself.", strings.Join(offenders, ", "))
	}
}

// TestHygCliOrgScope_DrivingTheTreeAppliesTheFlag is the end-to-end arm: the value a person typed
// reaches the API client that sends the header.
//
// Driven through `alethia version`, which is the one leaf that runs to completion without a
// credential or a network call, so what is being measured is the WIRING and nothing else.
func TestHygCliOrgScope_DrivingTheTreeAppliesTheFlag(t *testing.T) {
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	resetFlagsAroundTest(t)
	t.Cleanup(func() { api.SetOrgOverride("") })

	// `fail` would otherwise take the process out from under the suite.
	code := -1
	prevExit := exitFunc
	exitFunc = func(c int) { code = c }
	t.Cleanup(func() { exitFunc = prevExit })

	execRootArgs([]string{"version", "--org", "org_from_the_command_line"})
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("`alethia version --org …`: %v", err)
	}
	if code != -1 {
		t.Fatalf("`alethia version --org …` took the fatal path (exit %d)", code)
	}
	if got := api.OrgOverride(); got != "org_from_the_command_line" {
		t.Errorf("after driving the tree with --org, the api client's override is %q — the flag "+
			"parses and reaches nothing", got)
	}

	// And the other direction, which is the one a stale global gets wrong: an invocation WITHOUT
	// --org must clear the previous one rather than inherit it. Without this arm the test above
	// would pass on a build where applyOrgScope only ever set the value.
	execRootArgs([]string{"version"})
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("`alethia version`: %v", err)
	}
	if got := api.OrgOverride(); got != "" {
		t.Errorf("an invocation with no --org left the override at %q", got)
	}
}
