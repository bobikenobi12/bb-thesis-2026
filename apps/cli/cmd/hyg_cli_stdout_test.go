// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
)

// A machine-readable run's stdout is the document, and nothing else.
//
// This is a guard on the PROPERTY rather than on any function. The defect that prompted it was
// ui.RunSpinner writing its frames to os.Stdout — `alethia jobs list -o json > jobs.json` produced a
// file beginning with eight ANSI sequences and "⣽  Fetching jobs..." ahead of the "[", and jq
// answered "Invalid numeric literal at line 1, column 2" — but the spinner is not the only thing
// that can write there. A `fmt.Println` of a progress note, a lipgloss-styled warning, a stray
// ui.Info before the payload: each is the same defect wearing a different function's name, and a
// guard aimed at the spinner would catch none of them.
//
// It can genuinely FAIL, which is the part worth stating because it is not obvious. Under `go test`
// most bubbletea widgets refuse to start — ShowTable and huh's forms return "could not open a new
// TTY" — so a naive stream assertion would pass on a broken tree and be worthless. The SPINNER does
// not: it passes tea.WithInput(nil), so nothing ever tries to open /dev/tty and it renders happily
// into a plain pipe. Measured: 75 bytes into stdout, 8 of them escapes, from a headless process.
// So this guard was red before the fix and is green after it, in-process, with no terminal.
//
// What it does NOT cover, stated so nobody reads more into a green: the widgets that DO need a TTY
// are inert here, so it says nothing about what `ui.ShowTable` would write, and lipgloss disables
// colour on a non-terminal, so a styled string that would carry escapes on a real terminal carries
// none here. Those need the pty harness, not this.

// stdoutCapture runs fn with os.Stdout replaced by a pipe and returns what was written.
//
// A pipe rather than a buffer, because the thing being caught writes to the FILE os.Stdout names
// rather than through any writer the command was handed — which is exactly why it was invisible to
// every test in this package that renders through an io.Writer parameter.
func stdoutCapture(t *testing.T, fn func()) []byte {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	orig := os.Stdout
	os.Stdout = w

	// A pipe holds 64KB; a large json document would block the writer before fn returns. Draining
	// concurrently is not optional here — without it this guard would deadlock on exactly the
	// commands with the most to say.
	done := make(chan []byte, 1)
	go func() {
		b, _ := io.ReadAll(r)
		done <- b
	}()

	fn()
	os.Stdout = orig
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return <-done
}

// TestHygCliStdout_CaptureActuallyCaptures is the control.
//
// "Nothing was written to stdout" and "the capture is broken" are the same result, and every
// assertion below is of that shape. This proves the machinery sees both a plain write and an
// escape byte.
func TestHygCliStdout_CaptureActuallyCaptures(t *testing.T) {
	got := stdoutCapture(t, func() { _, _ = os.Stdout.WriteString("\x1b[2K{\"ok\":true}") })
	if !bytes.Contains(got, []byte(`{"ok":true}`)) {
		t.Fatalf("the capture missed a write it was pointed at, got %q", got)
	}
	if !bytes.ContainsRune(got, 0x1b) {
		t.Fatal("the capture dropped the escape byte, so no assertion below could ever see one")
	}
}

// TestHygCliStdout_JSONRunsEmitOnlyTheirDocument drives every read-only command with `-o json` and
// requires its stdout to be exactly a JSON document.
func TestHygCliStdout_JSONRunsEmitOnlyTheirDocument(t *testing.T) {
	run := miscEnv(t, miscFull)

	nonEmpty := 0
	for _, args := range miscReadCommands() {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			var runErr error
			got := stdoutCapture(t, func() {
				runErr = run(append(append([]string{}, args...), "--output", "json", "--no-input")...)
			})
			if runErr != nil {
				t.Fatalf("%v: %v", args, runErr)
			}
			if i := bytes.IndexRune(got, 0x1b); i >= 0 {
				t.Fatalf("stdout carries an ANSI escape at byte %d — a redirect of this command "+
					"produces a file no parser can read:\n%q", i, got[:min(len(got), 240)])
			}
			if len(bytes.TrimSpace(got)) == 0 {
				return // a command with nothing to report is allowed to say nothing
			}
			nonEmpty++
			var doc any
			if err := json.Unmarshal(got, &doc); err != nil {
				t.Fatalf("stdout is not a JSON document: %v\n%q", err, got[:min(len(got), 240)])
			}
		})
	}
	if nonEmpty == 0 {
		t.Fatal("no command produced any stdout at all — the parse assertion above ran against " +
			"nothing, so it proved nothing")
	}
}

// TestHygCliStdout_TheSpinnerIsNotInTheDocument is the same property aimed at the exact path, so a
// failure names the cause instead of only the symptom.
//
// It drives runSpinner in the posture the fix is about — a terminal is present, so the spinner
// really does draw — and requires the drawing to land somewhere other than stdout.
func TestHygCliStdout_TheSpinnerIsNotInTheDocument(t *testing.T) {
	prev := interactiveOutIsTTY
	interactiveOutIsTTY = func() bool { return true }
	t.Cleanup(func() { interactiveOutIsTTY = prev })

	ran := false
	got := stdoutCapture(t, func() {
		runSpinner("Fetching jobs...", func() { ran = true })
		_, _ = os.Stdout.WriteString(`{"jobs":[]}`)
	})

	if !ran {
		t.Fatal("the action did not run")
	}
	if !bytes.Equal(got, []byte(`{"jobs":[]}`)) {
		t.Errorf("stdout is not exactly the document — the spinner is in it:\n%q", got)
	}
}
