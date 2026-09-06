// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// exitFunc is the process-exit hook the fatal-error path calls. It is os.Exit in
// production — behaviour is unchanged — and exists only so tests can observe a
// fatal path without the test binary being killed by a real exit.
var exitFunc = os.Exit

// fail prints err in the standard grayscale error style and exits non-zero.
// This is the single fatal-error path for the CLI.
func fail(err error) {
	ui.Error(err.Error())
	exitFunc(1)
}

// failf formats a message, prints it in the error style, and exits non-zero.
func failf(format string, args ...any) {
	ui.Error(fmt.Sprintf(format, args...))
	exitFunc(1)
}

// confirm shows a yes/no dialog and reports whether the user confirmed. It
// returns false on a negative answer or an aborted/errored prompt, printing a
// short "Cancelled." note so callers can simply `return` on false.
//
// It is a variable for the reason seams.go records, with one addition specific to
// it: stubbing runHuhForm keeps the prompt from blocking, but no stub can answer
// "yes" on the caller's behalf — the answer is written through a pointer the huh
// group owns and never exposes — so the *confirmed* branch of every destructive
// command is unreachable otherwise. The default below is the real prompt, so
// production behaviour is unchanged.
var confirm = func(title, description string) bool {
	// Prompting is off, or the form has nowhere visible to draw: it can never be
	// answered, so decline without opening it. Callers for which a silent decline
	// would be wrong go through confirmDestructive instead.
	//
	// canPromptForm and not noInputMode: a confirm IS a huh form, so it draws on the
	// stream ui.InteractiveOutput names and needs a terminal there. Reading noInputMode let
	// `alethia alerts delete r1 2> log` open a Yes/No into the log file and wait for a
	// keystroke against a blank terminal.
	if !canPromptForm() {
		ui.Muted("Cancelled.")
		return false
	}
	var ok bool
	err := runHuhForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title(title).
				Description(description).
				Value(&ok),
		),
	)
	if err != nil || !ok {
		ui.Muted("Cancelled.")
		return false
	}
	return true
}

// errConfirmRequiresYes is the fatal error a destructive command reports when
// prompting is disabled and the caller did not opt in with --yes.
//
// Failing is the only safe answer here. Proceeding unprompted would make every
// scripted invocation destructive; exiting 0 having done nothing — the behaviour
// this replaced — let a scripted teardown silently no-op while the cloud
// resources it was meant to destroy kept billing.
var errConfirmRequiresYes = errors.New(
	"this command is destructive and interactive prompts are unavailable " +
		"(--no-input, or stdin is not a terminal, or the stream the prompt draws on is redirected): " +
		"pass --yes to confirm",
)

// confirmDestructive reports whether a destructive action may proceed. yes is the
// command's --yes flag: when set the action runs unprompted. Otherwise, with
// prompting disabled the command dies on the standard fatal path rather than
// silently cancelling, and on an interactive terminal it asks through confirm.
func confirmDestructive(yes bool, title, description string) bool {
	if yes {
		return true
	}
	if !canPromptForm() {
		fail(errConfirmRequiresYes)
		return false
	}
	return confirm(title, description)
}

// addYesFlag registers the standard --yes/-y opt-in on a destructive command, so
// every one of them spells the flag and its help text the same way.
func addYesFlag(cmd *cobra.Command, target *bool) {
	cmd.Flags().BoolVarP(target, "yes", "y", false, "Skip the confirmation prompt (required with --no-input)")
}
