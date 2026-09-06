// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/spf13/cobra"
)

// noInputMode is set once per invocation from the --no-input flag (or a non-TTY
// stdin) and read by the interactive selectors so scripting/CI fails fast
// instead of blocking on a prompt that can never be answered.
var noInputMode bool

// errNoInput is returned by selectors when interactive prompts are disabled.
//
// It names BOTH ways that happens. noInputMode is set by --no-input and equally by a stdin that is
// not a terminal, so "--no-input is set" was a false statement to the larger half of the people who
// saw it: a pipeline that never passed the flag was told it had.
var errNoInput = errors.New("interactive input required but prompts are disabled " +
	"(--no-input, or stdin is not a terminal): pass the id/name as a flag/argument")

// resolveInputMode computes noInputMode from the command's --no-input flag and
// whether stdin is a terminal. Wired as the root PersistentPreRun.
func resolveInputMode(cmd *cobra.Command) {
	if v, _ := cmd.Flags().GetBool("no-input"); v {
		noInputMode = true
		return
	}
	noInputMode = !stdinIsTTY()
}

// outputFormat returns the validated --output value, exiting on an invalid one.
func outputFormat(cmd *cobra.Command) string {
	f, _ := cmd.Flags().GetString("output")
	if !ui.ValidFormat(f) {
		failf("invalid --output %q (want table, json, or csv)", f)
	}
	return f
}

// interactiveTable reports whether a list command should render the rich,
// navigable Bubble Tea table rather than a static one — true only for the table
// format on a TTY with prompts enabled. json/csv/--no-input/pipes get Render.
func interactiveTable(cmd *cobra.Command) bool {
	if outputFormat(cmd) != ui.FormatTable {
		return false
	}
	if noInputMode {
		return false
	}
	return stdoutIsTTY()
}

// requireInteractive answers only the FIRST half of "may this command prompt": did the operator
// disable prompting, either with --no-input or by handing the command a stdin no person is behind?
//
// It is NOT the gate a prompt should use, and it is unexported and unused outside this file for
// that reason — requireInteractiveForm is the gate, and TestHygCliGate_PromptsUseTheFormPredicate
// fails if this name or noInputMode is referenced from any other production file in the package.
// Every one of the 37 call sites that used to read one of them was gating a huh form.
func requireInteractive() error {
	if noInputMode {
		return errNoInput
	}
	return nil
}

// errNoTTY is the answer when prompts are enabled but the form has nowhere visible to draw.
//
// It is a different statement from errNoInput — nobody passed --no-input and stdin may well be a
// terminal — and it has a different next step, so it is a different error.
var errNoTTY = errors.New("interactive input required but the terminal the prompt draws on (stderr) is redirected (pass the id/name as a flag/argument)")

// requireInteractiveForm is the gate for anything that opens a huh form: requireInteractive, plus
// the condition a form needs to be VISIBLE — a terminal on the stream it draws on.
//
// noInputMode is derived from stdin alone, so `alethia jobs get 2> err.log` from an interactive
// shell left prompts "enabled": the picker's ANSI frames went into the redirected file, the
// terminal showed nothing, and the command sat there waiting for a keystroke nobody knew to give.
// Measured end to end against a real pty: 844 bytes of picker into the log, and the process still
// running when the harness killed it.
//
// The stream is interactiveOutIsTTY and NOT stdoutIsTTY, and that correction is the whole fix. The
// first cut of this gate read stdout, which is wrong in BOTH directions: a huh form draws on
// stderr (ui.InteractiveOutput records the measurement) while the Bubble Tea table draws on stdout,
// so `cluster get -o json > f` was refused although its picker would have rendered perfectly well,
// and `jobs get 2> err.log` was permitted and hung. Both arms are pinned in
// TestRequireInteractiveForm_ReadsTheStreamAFormDrawsOn.
func requireInteractiveForm() error {
	if err := requireInteractive(); err != nil {
		return err
	}
	if !interactiveOutIsTTY() {
		return errNoTTY
	}
	return nil
}

// runSpinner runs action, showing the loading spinner while it works — but only when there is a
// terminal to show it on.
//
// Every spinner in this package goes through here rather than calling ui.RunSpinner, and the reason
// is a defect a user could see. The spinner is transient: it paints a frame and then erases it, so
// on a terminal it costs nothing and on anything else it is pure noise written into somebody's
// file. `alethia jobs list -o json > jobs.json` from an interactive shell produced a file that
// began with eight ANSI sequences and "⣽  Fetching jobs..." before the "[", and jq answered
// "Invalid numeric literal at line 1, column 2".
//
// Moving the spinner to stderr (ui.InteractiveOutput) fixes the redirected-stdout case. This gate
// fixes the rest of them: a redirected stderr, a CI log, `2>&1` into a file. Neither alone is
// enough — the first still writes frames into a log nobody reads, the second still lets them into
// the document — so the CLI does both.
//
// The error is dropped, as it was at all 46 call sites before, and now in ONE place instead of 46.
// A spinner that will not start is not a reason to fail the command it was decorating.
//
// The non-terminal arm calls action DIRECTLY rather than letting a spinner it does not want run it.
// huh runs the action as a step INSIDE its bubbletea program, so a program that failed to start
// would leave the fetch undone — and every one of these call sites reads its result out of a
// captured variable rather than a return value, so an undone fetch reads as an empty answer.
func runSpinner(title string, action func()) {
	if !interactiveOutIsTTY() {
		action()
		return
	}
	_ = ui.RunSpinner(title, action)
}

// canPromptForm is requireInteractiveForm as a predicate, for the call sites that choose between
// asking and defaulting rather than between asking and failing.
//
// It exists so those sites read the same gate as the failing ones. They used to test noInputMode
// directly, which is the same defect one level down: `alethia project plan 2> log` would decide to
// open the runner picker and then draw it into the log.
//
// The fields it serves are the ones with a working answer when nobody types one — `--role` on
// `members add` defaults to `member`, `roles create` accepts an empty permission set, `project
// plan` leaves the runner unassigned. A scripted caller must not be REFUSED for omitting any of
// them, because the flag contract is complete without them, but a person at a terminal should
// still be asked: a default is rarely what they meant. The fields with no default use
// requireInteractiveForm and refuse, naming the flag to pass.
//
// The org group arrived at the same predicate independently and called it formAvailable (#3807);
// the two are converged here, because two names for one gate is how a group comes to disagree with
// the rest of the product about when it may ask a question.
func canPromptForm() bool { return requireInteractiveForm() == nil }
