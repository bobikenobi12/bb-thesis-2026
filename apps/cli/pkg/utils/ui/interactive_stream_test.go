// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"bytes"
	"io"
	"os"
	"testing"
)

// The stream the transient widgets draw on, pinned at the source.
//
// stdout carries the answer; stderr carries the narration. huh's spinner did not agree: it passes a
// nil writer to bubbletea, which resolves to os.Stdout, so `alethia jobs list -o json > jobs.json`
// wrote eight ANSI sequences and a spinner frame into the file ahead of the "[" and jq answered
// "Invalid numeric literal at line 1, column 2".
//
// This is the assertion that would have caught it, and it needs no terminal: bubbletea renders into
// a plain pipe quite happily — the spinner passes tea.WithInput(nil), so nothing ever tries to open
// /dev/tty. Measured on the unfixed function: 75 bytes into stdout, 8 of them escape sequences.

// captureStdoutBytes runs fn with os.Stdout replaced by a pipe and returns the RAW bytes written to
// it. config_printer_test.go's captureStdout returns a string; escape sequences are the subject
// here, so the bytes are kept as bytes.
func captureStdoutBytes(t *testing.T, fn func()) []byte {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	orig := os.Stdout
	os.Stdout = w
	fn()
	os.Stdout = orig
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	return out
}

// TestRunSpinner_WritesNothingToStdout is the property, at the one function that broke it.
func TestRunSpinner_WritesNothingToStdout(t *testing.T) {
	ran := false
	got := captureStdoutBytes(t, func() { _ = RunSpinner("Fetching jobs...", func() { ran = true }) })

	if !ran {
		t.Fatal("the action did not run — the spinner is the decoration, the action is the point")
	}
	if len(got) != 0 {
		t.Errorf("the spinner wrote %d byte(s) to stdout, which is where the document goes:\n%q",
			len(got), got)
	}
	if bytes.ContainsRune(got, 0x1b) {
		t.Error("the spinner wrote ANSI escapes into stdout — a `-o json` run redirected to a " +
			"file would not parse")
	}
}

// TestCaptureStdoutBytes_ActuallyCaptures is the control the test above cannot do without.
//
// "The spinner wrote nothing to stdout" and "the capture is broken and everything reads as nothing"
// are the same result. This proves the machinery sees a write.
func TestCaptureStdoutBytes_ActuallyCaptures(t *testing.T) {
	got := captureStdoutBytes(t, func() { _, _ = os.Stdout.WriteString("\x1b[2K the document") })
	if !bytes.Contains(got, []byte("the document")) {
		t.Fatalf("the capture missed a write it was pointed at, got %q", got)
	}
	if !bytes.ContainsRune(got, 0x1b) {
		t.Error("the capture dropped the escape byte, so the assertion above could not see one")
	}
}
