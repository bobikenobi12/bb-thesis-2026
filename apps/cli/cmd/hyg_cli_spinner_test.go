// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// Progress is not part of the document.
//
// huh's spinner passes a nil writer to bubbletea, which resolves it to os.Stdout, so every one of
// the 46 `ui.RunSpinner` call sites in this package wrote its frames into the caller's stdout.
// MEASURED against the shipped binary under a real pty: `alethia jobs list -o json > jobs.json`
// produced a 1,315-byte file beginning with eight ANSI escape sequences and the frame
// "⣽  Fetching jobs..." ahead of the "[", and `jq` answered
// "Invalid numeric literal at line 1, column 2".
//
// Two changes fix it and neither is sufficient alone. ui.RunSpinner now draws on
// ui.InteractiveOutput (stderr), which keeps the document clean; cmd.runSpinner declines to draw at
// all when there is no terminal on that stream, which keeps the frames out of a CI log and out of a
// `2>&1` capture. This file holds both.

// spinnerOwnerFile is the one file allowed to call ui.RunSpinner: the file defining the wrapper.
const spinnerOwnerFile = "output.go"

// spinnerDirectCalls returns the positions at which a file calls ui.RunSpinner.
//
// AST rather than text, for the same reason the prompt-gate guard walks: the symbol is named in the
// prose of seams.go, cost.go and output.go itself, and a text match would report those and be given
// an exception list that then hides a real one. A selector expression is a structure, so it can be
// asked for exactly.
func spinnerDirectCalls(t *testing.T, file string) []string {
	t.Helper()
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, file, nil, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}
	var hits []string
	ast.Inspect(parsed, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok || sel.Sel == nil || sel.Sel.Name != "RunSpinner" {
			return true
		}
		pkg, ok := sel.X.(*ast.Ident)
		if !ok || pkg.Name != "ui" {
			return true
		}
		hits = append(hits, fset.Position(sel.Pos()).String())
		return true
	})
	return hits
}

// TestHygCliSpinner_NoCommandCallsTheSpinnerDirectly fails on a spinner that skips the wrapper.
func TestHygCliSpinner_NoCommandCallsTheSpinnerDirectly(t *testing.T) {
	files := gateProductionFiles(t)
	sawOwner := false
	scanned := 0
	for _, file := range files {
		if file == spinnerOwnerFile {
			sawOwner = true
			continue
		}
		scanned++
		for _, at := range spinnerDirectCalls(t, file) {
			t.Errorf("%s calls ui.RunSpinner directly at %s.\n"+
				"      Use runSpinner: it declines to draw when there is no terminal on the\n"+
				"      stream widgets draw on, which is what keeps spinner frames out of a CI\n"+
				"      log and out of a `2>&1` capture of a -o json run.", file, at)
		}
	}
	if !sawOwner {
		t.Fatalf("%s is not in the package any more — the exemption names a file that is gone",
			spinnerOwnerFile)
	}
	if scanned == 0 {
		t.Fatal("no file was scanned — the rule was applied to nothing")
	}
}

// TestHygCliSpinner_TheWalkSeesTheCall is the mutation test, driven against the file that DOES make
// the call, using the same function the guard uses.
func TestHygCliSpinner_TheWalkSeesTheCall(t *testing.T) {
	if len(spinnerDirectCalls(t, spinnerOwnerFile)) == 0 {
		t.Fatalf("%s wraps ui.RunSpinner, so the walk must find the call there; finding none "+
			"means the guard above reports every file clean", spinnerOwnerFile)
	}
	// seams.go names ui.RunSpinner in prose only. A guard that counted it would be a spelling
	// check wearing a structure check's name.
	if hits := spinnerDirectCalls(t, "seams.go"); len(hits) != 0 {
		t.Errorf("seams.go mentions ui.RunSpinner only in a comment, but the walk counted %v", hits)
	}
}

// TestRunSpinner_RunsTheActionOnBothArms pins the wrapper's contract.
//
// The action must run exactly once whether or not a spinner is drawn. That is the whole risk in the
// change: every one of these 46 call sites is a FETCH, and a wrapper that skipped the action when
// it decided not to draw would turn "no terminal" into "no data" — silently, because each call site
// reads the result out of a captured variable rather than a return value.
func TestRunSpinner_RunsTheActionOnBothArms(t *testing.T) {
	prev := interactiveOutIsTTY
	t.Cleanup(func() { interactiveOutIsTTY = prev })

	for _, tty := range []bool{true, false} {
		interactiveOutIsTTY = func() bool { return tty }
		runs := 0
		fetched := ""
		runSpinner("Fetching...", func() { runs++; fetched = "the payload" })
		if runs != 1 {
			t.Errorf("terminal=%v: the action ran %d times, want exactly 1", tty, runs)
		}
		if fetched != "the payload" {
			t.Errorf("terminal=%v: the action's result did not reach the caller (%q)", tty, fetched)
		}
	}
}

// TestRunSpinner_DrawsNothingWithoutATerminal is the half a run-count cannot see.
//
// With no terminal on the widget stream the wrapper must not reach ui.RunSpinner at all. Asserted
// through the seam rather than by capturing the stream, because under `go test` bubbletea fails to
// open a TTY and writes nothing either way — so a test that watched the bytes would pass with the
// gate deleted. What is observable is WHETHER the decision was consulted.
func TestRunSpinner_DrawsNothingWithoutATerminal(t *testing.T) {
	prev := interactiveOutIsTTY
	t.Cleanup(func() { interactiveOutIsTTY = prev })

	asked := 0
	interactiveOutIsTTY = func() bool { asked++; return false }
	runSpinner("Fetching...", func() {})
	if asked != 1 {
		t.Fatalf("the wrapper consulted the terminal seam %d times, want 1 — it is not asking "+
			"whether there is anywhere to draw", asked)
	}
}
