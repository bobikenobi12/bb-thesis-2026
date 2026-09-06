// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The test harness's own guards.
//
// This package is a package of GLOBALS — one cobra tree, one noInputMode, one set of terminal
// seams — and `go test` runs its files in ALPHABETICAL order. That combination produced a class of
// defect nothing in CI could see: a test passing because of state a test in another file had left
// behind. It does not fail; it selects a different code ARM.
//
// Measured, on origin/dev at 70f131df: `go test ./cmd/ -shuffle=N` failed for every seed tried,
// with up to four cases going the wrong way. `TestMisc_EveryCommandFailsClosedWithoutCredentials`
// believed it was driving the missing-credentials path for `alerts create` and was really being
// refused for a missing required flag, because an earlier test in the same file had set pflag's
// Changed bit on --event and --channel and nothing ever clears it.
//
// The fix is structural rather than a rule: there is one way to start the tree from a test, and it
// resets the root's persistent flags. This file keeps it the only way.

// harnessRunnerOwner is the file that defines the shared runner, and the only one allowed to touch
// the cobra tree's argument vector directly.
const harnessRunnerOwner = "harness_test.go"

// harnessDirectSetArgs matches a call that points the shared root command at arguments without
// going through the reset.
var harnessDirectSetArgs = regexp.MustCompile(`\brootCmd\.SetArgs\(`)

// TestHygCliHarness_NothingBypassesTheSharedRunner fails on a test-side invocation that skips the
// flag reset.
//
// It is a text match rather than an AST walk, and that is the cheaper SOUND question here: the
// thing being matched is a method call on a package global with a fixed spelling, so there is no
// structure to get wrong, and the only false positive available — the name inside a comment — is
// checked for below rather than assumed absent.
func TestHygCliHarness_NothingBypassesTheSharedRunner(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read the package directory: %v", err)
	}
	scanned := 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, "_test.go") || name == harnessRunnerOwner {
			continue
		}
		scanned++
		body, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, loc := range harnessDirectSetArgs.FindAllIndex(body, -1) {
			line := 1 + strings.Count(string(body[:loc[0]]), "\n")
			t.Errorf("%s:%d calls rootCmd.SetArgs directly.\n"+
				"      Use execRootArgs, which returns --output, --no-input and --token to their\n"+
				"      defaults first. cobra keeps a flag's value AND its Changed bit across\n"+
				"      Execute calls, so a --no-input this file passed becomes the next file's\n"+
				"      default and turns its interactive arm into a fatal one.", name, line)
		}
	}
	if scanned == 0 {
		t.Fatal("no test file was scanned — this guard's verdict would be clean for a package it " +
			"never opened")
	}
}

// TestHygCliHarness_TheGuardCanFail drives the matcher against the spelling it exists to catch and
// against the one it must not claim, using the same regexp the guard uses.
func TestHygCliHarness_TheGuardCanFail(t *testing.T) {
	// Assembled rather than written out. This file is itself scanned by the guard above — it has to
	// be, or the exemption list becomes the escape route — so a literal of the banned call here
	// would be a violation of the rule it is testing. Splitting the token is the smallest thing
	// that keeps both true.
	banned := "root" + "Cmd.SetArgs("
	if !harnessDirectSetArgs.MatchString("\t\t" + banned + "args)") {
		t.Error("the matcher does not see the call it exists to catch")
	}
	if !harnessDirectSetArgs.MatchString("\t" + banned + "nil)") {
		t.Error("the matcher does not see the no-argument spelling")
	}
	if harnessDirectSetArgs.MatchString(`	execRootArgs(args)`) {
		t.Error("the matcher claims the shared runner itself")
	}
	if harnessDirectSetArgs.MatchString(`	otherCmd.SetArgs(args)`) {
		t.Error("the matcher claims a SetArgs on a command that is not the shared tree")
	}
	// And the owner file really does contain the call, so exempting it exempts something.
	body, err := os.ReadFile(harnessRunnerOwner)
	if err != nil {
		t.Fatalf("read %s: %v", harnessRunnerOwner, err)
	}
	if !harnessDirectSetArgs.Match(body) {
		t.Errorf("%s does not call rootCmd.SetArgs — the exemption above names a file that no "+
			"longer defines the runner, so the guard is excusing nothing", harnessRunnerOwner)
	}
}

// TestHygCliHarness_TheResetIsNarrow pins what resetRootPersistentFlags does and does NOT touch.
//
// Both halves matter. It must clear a leaked --no-input, or the leak the guard above prevents comes
// back through the reset being inert. And it must NOT clear a command's own flag, because a test
// that sets a package variable and then runs the tree is the normal pattern in this package and a
// wider reset would silently undo it — the reset would then be a second, invisible defect of
// exactly the kind it was written to end.
func TestHygCliHarness_TheResetIsNarrow(t *testing.T) {
	noInput := rootCmd.PersistentFlags().Lookup("no-input")
	if noInput == nil {
		t.Fatal("--no-input is not a persistent flag of the root command any more")
	}
	output := rootCmd.PersistentFlags().Lookup("output")
	if output == nil {
		t.Fatal("--output is not a persistent flag of the root command any more")
	}
	own := alertsCreateCmd.Flags().Lookup("severity")
	if own == nil {
		t.Fatal("alerts create has no --severity flag any more; pick another command-owned flag")
	}

	prevNoInput, prevNoInputChanged := noInput.Value.String(), noInput.Changed
	prevOutput, prevOutputChanged := output.Value.String(), output.Changed
	prevOwn, prevOwnChanged := own.Value.String(), own.Changed
	t.Cleanup(func() {
		_ = noInput.Value.Set(prevNoInput)
		noInput.Changed = prevNoInputChanged
		_ = output.Value.Set(prevOutput)
		output.Changed = prevOutputChanged
		_ = own.Value.Set(prevOwn)
		own.Changed = prevOwnChanged
	})

	_ = noInput.Value.Set("true")
	noInput.Changed = true
	_ = output.Value.Set("json")
	output.Changed = true
	_ = own.Value.Set("critical")
	own.Changed = true

	resetRootPersistentFlags()

	if noInput.Value.String() != "false" || noInput.Changed {
		t.Errorf("--no-input survived the reset: value=%q changed=%v — this is the leak the whole "+
			"harness exists to stop", noInput.Value.String(), noInput.Changed)
	}
	if noInput.Value.String() != noInput.DefValue {
		t.Errorf("--no-input was reset to %q, not to its default %q",
			noInput.Value.String(), noInput.DefValue)
	}
	if output.Value.String() != output.DefValue || output.Changed {
		t.Errorf("--output survived the reset: value=%q changed=%v",
			output.Value.String(), output.Changed)
	}
	if own.Value.String() != "critical" || !own.Changed {
		t.Errorf("the reset reached a COMMAND's own flag (--severity is now %q, changed=%v). "+
			"It must not: a test that sets a command flag and then runs the tree would have it "+
			"silently undone", own.Value.String(), own.Changed)
	}
}

// TestHygCliHarness_TheSharedRunnerActuallyResets drives execRootArgs itself.
//
// Found by mutation: deleting the resetRootPersistentFlags call from execRootArgs left the whole
// default-order suite GREEN, because TestHygCliHarness_TheResetIsNarrow calls the reset directly
// and never asks whether the runner does. Only `-shuffle` caught it, and CI runs in file order.
//
// The guard above proves nobody bypasses the runner; this proves the runner is worth not bypassing.
// Between them there is no arrangement of the two that reports clean while a --no-input leaks.
func TestHygCliHarness_TheSharedRunnerActuallyResets(t *testing.T) {
	noInput := rootCmd.PersistentFlags().Lookup("no-input")
	if noInput == nil {
		t.Fatal("--no-input is not a persistent flag of the root command any more")
	}
	prev, prevChanged := noInput.Value.String(), noInput.Changed
	t.Cleanup(func() {
		_ = noInput.Value.Set(prev)
		noInput.Changed = prevChanged
		execRootArgs(nil)
	})

	// The state a previous test would have left behind.
	_ = noInput.Value.Set("true")
	noInput.Changed = true

	execRootArgs([]string{"version"})

	if noInput.Value.String() != noInput.DefValue || noInput.Changed {
		t.Errorf("execRootArgs did not reset --no-input (value=%q changed=%v). Every env helper in "+
			"this package starts an invocation through it, so a leak that survives here reaches "+
			"the whole suite and shows up as a test taking the fatal arm instead of the "+
			"interactive one", noInput.Value.String(), noInput.Changed)
	}
}

// TestHygCliHarness_FlagDefaultsWereCaptured is the "nothing found is not nothing wrong" check on
// the reset's input.
//
// resetRootPersistentFlags iterates flagDefaults. If TestMain had not run, or the walk had found
// nothing, the loop would do nothing and every assertion that depends on a clean tree would pass
// for the wrong reason — including the one above, whose "did it clear --no-input" arm would fail,
// but only that one. The count is checked here so the failure names the cause.
func TestHygCliHarness_FlagDefaultsWereCaptured(t *testing.T) {
	if len(flagDefaults) == 0 {
		t.Fatal("no flag defaults were captured — TestMain did not run, or captureFlagDefaults " +
			"walked an empty tree, and every reset in this package is a no-op")
	}
	// The tree has well over a hundred flags; a capture that saw only the root's three would mean
	// the recursion into subcommands had stopped.
	if len(flagDefaults) < 50 {
		t.Errorf("only %d flags were captured — captureFlagDefaults is not descending into the "+
			"command tree", len(flagDefaults))
	}
	names := map[string]bool{}
	for _, d := range flagDefaults {
		names[d.flag.Name] = true
	}
	for _, want := range []string{"no-input", "output", "token", "yes", "project", "event"} {
		if !names[want] {
			t.Errorf("the capture missed --%s", want)
		}
	}
}
