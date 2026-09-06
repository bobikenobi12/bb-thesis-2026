// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/mattn/go-isatty"
)

// Test seams for the CLI's terminal surface.
//
// Each variable holds the exact call it replaced, so production behaviour is byte-identical.
// They exist because a third of this package is otherwise unreachable from a test — not
// because the code is untestable, but because a TTY check decides which branch runs.
//
// Every seam here was justified by MEASUREMENT, not by assumption. Three candidates were
// probed headlessly and then deliberately NOT added, because they turned out not to need one:
//
//   - ui.RunSpinner returns nil with its action executed. (Seaming it would also have
//     defeated the errcheck exclusion in .golangci.yml that names it by symbol.) Commands reach
//     it through cmd.runSpinner, which declines to draw when interactiveOutIsTTY is false.
//   - ui.ShowTable returns `could not open a new TTY: open /dev/tty: device not configured`.
//   - huh's Form.Run() returns the same TTY error.
//
// None of them block, so a test may call straight through them and simply get the error arm.
// If you are tempted to add a seam "because it would hang", probe it first — that belief was
// wrong for all three.
//
// What genuinely does need a seam is below: os.Exit terminates the test binary, and isatty
// decides the branch before any of the above is ever reached.
var (
	// stdinIsTTY reports whether stdin is a terminal. Drives resolveInputMode, and through it
	// every requireInteractive and interactiveTable decision. In a test process stdin is never
	// a terminal, so without this the interactive arms cannot be reached at all.
	stdinIsTTY = func() bool { return isatty.IsTerminal(os.Stdin.Fd()) }

	// stdoutIsTTY reports whether stdout is a terminal. Drives interactiveTable's final arm,
	// because the rich Bubble Tea table draws on STDOUT (bubbletea's own default output).
	stdoutIsTTY = func() bool { return isatty.IsTerminal(os.Stdout.Fd()) }

	// interactiveOutIsTTY reports whether the stream a huh FORM draws on is a terminal. Drives
	// requireInteractiveForm.
	//
	// It is a separate seam from stdoutIsTTY because it is a separate FILE DESCRIPTOR, which is
	// the whole point: huh draws on stderr and the table draws on stdout (ui.InteractiveOutput records
	// the measurement). Asking stdoutIsTTY on behalf of a form is wrong in BOTH directions — it
	// refuses `alethia cluster get -o json > out.json`, whose picker would have drawn perfectly
	// well on the still-attached stderr, and it permits `alethia jobs get 2> err.log`, whose
	// picker goes into the log file while the terminal shows nothing and the command looks hung.
	//
	// The fd comes from ui.InteractiveOutput() rather than from os.Stderr written again here, so this
	// gate and the form it gates read the same stream by construction.
	interactiveOutIsTTY = func() bool { return isatty.IsTerminal(ui.InteractiveOutput().Fd()) }
)
