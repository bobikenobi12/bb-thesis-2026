// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// The shared harness for this package's command-level tests.
//
// Two things live here, and both exist because `cmd` is a package of GLOBALS: one cobra tree, one
// noInputMode, one set of terminal seams. A test that leaves any of them changed decides a later
// test's behaviour, in a file it has never heard of, by selecting a different code ARM rather than
// by failing.

// TestMain sets the package-wide terminal posture, then runs the suite.
//
// Under `go test` no standard stream is a terminal. The package models "a person is at this
// terminal" by stubbing the seams — but fourteen files express that intent as `noInputMode = false`
// ALONE, which was a complete statement while the prompt gate read noInputMode and stopped being
// one when it grew a second condition (the stream a huh form draws on; see requireInteractiveForm).
//
// Leaving the real isatty under those files would silently move every one of them into a third
// state none of them is trying to test: prompting enabled, form invisible. So the form-output seam
// defaults to "a terminal" for the whole package, which is the state those files mean.
//
// This deliberately makes the gate's REFUSING arm the one that needs asking for. It is asked for
// explicitly, against the real function with the seam stubbed both ways, in
// TestRequireInteractiveForm_ReadsTheStreamAFormDrawsOn — so the arm this default hides is the arm
// that file exists to drive.
func TestMain(m *testing.M) {
	interactiveOutIsTTY = func() bool { return true }
	captureFlagDefaults(rootCmd)
	os.Exit(m.Run())
}

// withInteractiveOutputRedirected models the case this package's default hides: prompting is enabled and
// the stream a huh form draws on is NOT a terminal, because it was redirected to a file.
func withInteractiveOutputRedirected(t *testing.T) {
	t.Helper()
	prev := interactiveOutIsTTY
	interactiveOutIsTTY = func() bool { return false }
	t.Cleanup(func() { interactiveOutIsTTY = prev })
}

// flagDefault is one flag's value as it was before any test ran.
//
// Slices are held separately because pflag's stringArray does not round-trip through Set: the
// second Set APPENDS, and DefValue for an empty array is the literal "[]", so restoring by
// `Set(DefValue)` gives a one-element slice containing "[]". SliceValue.Replace is the accessor
// that actually replaces.
type flagDefault struct {
	flag    *pflag.Flag
	scalar  string
	slice   []string
	isSlice bool
}

// flagDefaults is the whole cobra tree's pristine state, captured by TestMain before the first
// test runs. Captured rather than derived from DefValue for the reason above, and because a flag
// bound to a package variable with a non-zero initial value has a DefValue that is a rendering of
// it rather than the value itself.
var flagDefaults []flagDefault

// captureFlagDefaults walks the whole command tree once and records every flag's starting value.
//
// The WHOLE tree, derived from the tree itself. The helper this replaced named twenty-one package
// variables by hand and covered the commands whose lane happened to write it; a hand-written list
// of what a reset covers stops covering silently, and the next lane to add a flag would have had to
// know this function exists.
func captureFlagDefaults(cmd *cobra.Command) {
	record := func(f *pflag.Flag) {
		d := flagDefault{flag: f, scalar: f.Value.String()}
		if sv, ok := f.Value.(pflag.SliceValue); ok {
			d.isSlice, d.slice = true, append([]string{}, sv.GetSlice()...)
		}
		flagDefaults = append(flagDefaults, d)
	}
	cmd.PersistentFlags().VisitAll(record)
	cmd.Flags().VisitAll(record)
	for _, sub := range cmd.Commands() {
		captureFlagDefaults(sub)
	}
}

// resetAllFlags returns every flag in the tree — and every package variable bound to one — to the
// state captured before the suite started, including pflag's "was this passed?" bit.
//
// That bit is the one that bites. cobra's MarkFlagRequired is satisfied by Changed, and Changed is
// never cleared between Execute calls, so `alerts create` passed its required-flag check in every
// test that ran after the one which supplied --event and --channel. Splitting cov_misc_test.go by
// subject moved those two apart and the leak surfaced as a test that had been passing for the wrong
// reason: it believed it was exercising the missing-credentials path and was really being refused
// for a missing flag before it ever got there.
func resetAllFlags() {
	for _, d := range flagDefaults {
		if d.isSlice {
			if sv, ok := d.flag.Value.(pflag.SliceValue); ok {
				_ = sv.Replace(append([]string{}, d.slice...))
			}
		} else {
			_ = d.flag.Value.Set(d.scalar)
		}
		d.flag.Changed = false
	}
	// noInputMode is derived rather than bound, and is recomputed by the next PersistentPreRun.
	noInputMode = false
	// So is the api package's org override: --org is bound to orgFlag, which the loop above has
	// just reset, but the copy applyOrgScope handed to the api package is only refreshed by the
	// next PersistentPreRun. A test that calls a Run function directly would otherwise inherit the
	// previous test's --org and send its header — the same leak the Changed bit caused above, in
	// the one place where it would pick a different TENANT rather than a different code arm.
	api.SetOrgOverride("")
}

// resetRootPersistentFlags returns --output, --no-input and --token to their defaults.
//
// The ROOT's persistent flags specifically, and before every invocation. They are the three every
// command in the tree inherits, they are the ones every test passes explicitly when it wants them,
// and a leaked one selects a different code ARM rather than failing: a --no-input left set by an
// earlier file turns the next file's interactive arm into a fatal one, invisibly, because cobra
// keeps both the value and pflag's Changed bit across Execute calls.
//
// It is deliberately NARROWER than resetAllFlags. A test that sets a command's own flag through the
// package variable it binds to and then runs the tree is a normal pattern here, and a full reset
// before every invocation would silently undo it.
func resetRootPersistentFlags() {
	for _, d := range flagDefaults {
		if rootCmd.PersistentFlags().Lookup(d.flag.Name) != d.flag {
			continue
		}
		if d.isSlice {
			if sv, ok := d.flag.Value.(pflag.SliceValue); ok {
				_ = sv.Replace(append([]string{}, d.slice...))
			}
		} else {
			_ = d.flag.Value.Set(d.scalar)
		}
		d.flag.Changed = false
	}
}

// execRootArgs points the shared root command at one invocation's arguments.
//
// Every test-side invocation of the cobra tree goes through here, and it resets the root's
// persistent flags on the way. That is the point: the reset used to be an opt-in each env helper
// could forget, and about half of them did — under `go test -shuffle` a dozen cases across four
// files took the wrong arm because an earlier file had left --no-input set. A reset that is part of
// the only way to start the tree cannot be forgotten by the lane that adds the next env.
//
// TestHygCliHarness_NothingBypassesTheSharedRunner keeps it the only way.
func execRootArgs(args []string) {
	resetRootPersistentFlags()
	rootCmd.SetArgs(args)
}

// resetFlagsAroundTest puts the tree in its pristine state now AND after the test.
//
// Both ends, deliberately. Cleaning up afterwards protects the NEXT test; cleaning up first is what
// makes this test's result independent of whichever file the runner reached before it, which is the
// half that was missing.
func resetFlagsAroundTest(t *testing.T) {
	t.Helper()
	resetAllFlags()
	t.Cleanup(resetAllFlags)
}
