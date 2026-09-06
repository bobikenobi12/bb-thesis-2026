// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/charmbracelet/huh"
)

// The prompt gate, and the one rule that keeps it from splitting in two again.
//
// A huh form is usable only when three things hold at once: nobody passed --no-input, stdin is a
// terminal somebody is at, and the stream the FORM DRAWS ON is a terminal. requireInteractiveForm
// is the only predicate that answers all three. requireInteractive and noInputMode each answer part
// of it, and a call site that asks one of them is asking a question whose "yes" does not mean the
// form will be visible.
//
// This was not hypothetical. Thirty-seven production call sites read the partial predicates — 26
// naming requireInteractive and 11 reading noInputMode — and every
// one of them gated a form. `alethia jobs get 2> err.log` from an interactive shell wrote 844
// bytes of picker into the log file and then waited, against a terminal showing nothing. A rename
// or a semantic split has no compiler behind it, so the sweep needs a guard or it un-sweeps.

// gateOwnerFile is the one file allowed to name the partial predicates: the file that defines them.
const gateOwnerFile = "output.go"

// gatePartialPredicates are the names that answer only part of "may this command prompt".
var gatePartialPredicates = []string{"requireInteractive", "noInputMode"}

// gateProductionFiles returns the package's non-test .go files, by base name.
//
// An empty result is a FAILURE and never a pass: this guard's whole verdict is "no file outside
// output.go names these", and a walk that found no files would report exactly that while having
// looked at nothing.
func gateProductionFiles(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read the package directory: %v", err)
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		out = append(out, name)
	}
	sort.Strings(out)
	if len(out) == 0 {
		t.Fatal("no production .go file was found in the package — every assertion below would " +
			"be vacuous, so an empty walk is a failure rather than a clean sweep")
	}
	return out
}

// gatePartialPredicateUses returns, for one file, the source positions at which each partial
// predicate is named in CODE, keyed by the predicate. A file that only mentions them in prose maps
// to nothing.
//
// It walks the AST rather than grepping, because the names appear in the comments that explain the
// rule and a text match would either fail on those or need an exception that also hides a real one.
// go/ast hands back identifiers alone: a comment is not an *ast.Ident.
//
// Keyed by NAME rather than returned as one flat list so the mutation test below can assert that
// each predicate is seen, not merely that the total is non-zero — a walk that had lost one of the
// two names would leave that one's call sites unguarded behind a healthy-looking count.
func gatePartialPredicateUses(t *testing.T, file string) map[string][]string {
	t.Helper()
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, file, nil, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}
	banned := map[string]bool{}
	for _, name := range gatePartialPredicates {
		banned[name] = true
	}
	hits := map[string][]string{}
	ast.Inspect(parsed, func(n ast.Node) bool {
		// A selector's field half (x.requireInteractive) is not this package's identifier;
		// descending into the X half alone keeps the walk from reporting an unrelated struct
		// field or another package's symbol that happens to share the name.
		if sel, ok := n.(*ast.SelectorExpr); ok {
			ast.Inspect(sel.X, func(inner ast.Node) bool {
				if id, ok := inner.(*ast.Ident); ok && banned[id.Name] {
					hits[id.Name] = append(hits[id.Name], fset.Position(id.Pos()).String())
				}
				return true
			})
			return false
		}
		id, ok := n.(*ast.Ident)
		if !ok || !banned[id.Name] {
			return true
		}
		hits[id.Name] = append(hits[id.Name], fset.Position(id.Pos()).String())
		return true
	})
	return hits
}

// TestHygCliGate_PromptsUseTheFormPredicate is the sweep's guard: outside output.go, no production
// file in this package may name a partial predicate.
//
// The check is deliberately negative space rather than "every form has a gate". A positive rule
// would need an allowlist — selectOrgInteractive, pickConnectedIdentity, askLine and
// environmentFormGroups all open forms their CALLERS gate — and a hand-written allowlist of what a
// guard excuses stops covering silently. Negative space needs no list: the only way to reach a
// prompt decision from another file is through requireInteractiveForm or canPromptForm, both of
// which answer all three conditions.
func TestHygCliGate_PromptsUseTheFormPredicate(t *testing.T) {
	files := gateProductionFiles(t)

	sawOwner := false
	scanned := 0
	for _, file := range files {
		if file == gateOwnerFile {
			sawOwner = true
			continue
		}
		scanned++
		for name, positions := range gatePartialPredicateUses(t, file) {
			for _, at := range positions {
				t.Errorf("%s names the partial prompt predicate %q at %s.\n"+
					"requireInteractive and noInputMode each answer only part of \"may this "+
					"command prompt\": neither knows whether the stream the form draws on is a "+
					"terminal. Use requireInteractiveForm() to refuse, or canPromptForm() to "+
					"choose.", file, name, at)
			}
		}
	}
	if !sawOwner {
		t.Fatalf("%s is not in the package any more — this guard's exception names a file that is "+
			"gone, so it is excusing nothing and hiding whatever replaced it", gateOwnerFile)
	}
	if scanned == 0 {
		t.Fatal("no file was scanned — the walk found only the owner file, so the rule was applied " +
			"to nothing")
	}
}

// TestHygCliGate_TheGuardCanFail proves the walk above sees what it claims to see.
//
// A negative-space guard passes when it is broken in exactly the same way it passes when the tree
// is clean, so the walk is driven here against a file that DOES name the predicates — output.go,
// the one file the rule excuses. If gatePartialPredicateUses returned nothing for it, the loop
// above would be reporting "clean" for every file in the package.
//
// It calls the same function the guard calls rather than re-implementing the walk: a mutation test
// that carries its own copy of the check verifies the copy.
func TestHygCliGate_TheGuardCanFail(t *testing.T) {
	hits := gatePartialPredicateUses(t, gateOwnerFile)
	// Each name, not the total: a walk that had lost one of the two would still report a healthy
	// count from the other while leaving that one's call sites unguarded everywhere.
	for _, name := range gatePartialPredicates {
		if len(hits[name]) == 0 {
			t.Errorf("the walk found no use of %q in %s, which defines it — so the guard above "+
				"is reporting every other file clean without being able to see %q at all",
				name, gateOwnerFile, name)
		}
	}

	// And a use it must NOT count: the names appear throughout this package's comments, and a
	// text match would have reported the prose in seams.go as a violation.
	if hits := gatePartialPredicateUses(t, "seams.go"); len(hits) != 0 {
		t.Errorf("seams.go names the predicates only in prose, but the walk counted %v — the "+
			"guard is matching comments, which makes its verdict a spelling check", hits)
	}
}

// TestRequireInteractiveForm_ReadsTheStreamAFormDrawsOn pins WHICH stream the gate consults.
//
// This is the assertion the first cut of the gate would have failed. It read stdoutIsTTY, and a huh
// form does not draw on stdout: huh v0.8.0 builds its bubbletea program with
// tea.WithOutput(os.Stderr) while bubbletea's own default — what ui.ShowTable gets — is os.Stdout.
// Reading the wrong one is wrong in BOTH directions, so both are driven here:
//
//   - a redirected STDOUT must not refuse. Measured against the shipped binary:
//     `alethia cluster get -o json > f` under a pty exited 1 while its picker would have drawn
//     perfectly well on the still-attached stderr.
//   - a redirected FORM STREAM must refuse. Measured the same way: `alethia jobs get 2> err.log`
//     put 844 bytes of picker into the log and then hung.
func TestRequireInteractiveForm_ReadsTheStreamAFormDrawsOn(t *testing.T) {
	prevNoInput, prevOut, prevForm := noInputMode, stdoutIsTTY, interactiveOutIsTTY
	t.Cleanup(func() { noInputMode, stdoutIsTTY, interactiveOutIsTTY = prevNoInput, prevOut, prevForm })

	cases := []struct {
		name     string
		noInput  bool
		stdoutOK bool
		formOK   bool
		want     error
	}{
		{"a terminal on both streams prompts", false, true, true, nil},
		{"a redirected stdout still prompts", false, false, true, nil},
		{"a redirected form stream refuses", false, true, false, errNoTTY},
		{"--no-input refuses before the stream is even asked", true, true, false, errNoInput},
		{"--no-input outranks a perfectly good terminal", true, true, true, errNoInput},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			noInputMode = tc.noInput
			stdoutIsTTY = func() bool { return tc.stdoutOK }
			interactiveOutIsTTY = func() bool { return tc.formOK }

			err := requireInteractiveForm()
			if tc.want == nil {
				if err != nil {
					t.Fatalf("requireInteractiveForm() = %v, want nil", err)
				}
			} else if !errors.Is(err, tc.want) {
				t.Fatalf("requireInteractiveForm() = %v, want %v", err, tc.want)
			}

			// canPromptForm must be the same answer, not a second opinion.
			if got := canPromptForm(); got != (err == nil) {
				t.Errorf("canPromptForm() = %v but requireInteractiveForm() = %v", got, err)
			}
		})
	}
}

// TestRequireInteractiveForm_StdoutIsNeverConsulted is the sharper form of the row above: no value
// of stdoutIsTTY may change the gate's answer, in any other posture.
//
// The table version could pass with the gate reading stdout AND the form stream, because every row
// that expects nil happens to have the form stream open. This drives stdout both ways with
// everything else held fixed, which is the only shape that can catch an ADDED stdout condition.
func TestRequireInteractiveForm_StdoutIsNeverConsulted(t *testing.T) {
	prevNoInput, prevOut, prevForm := noInputMode, stdoutIsTTY, interactiveOutIsTTY
	t.Cleanup(func() { noInputMode, stdoutIsTTY, interactiveOutIsTTY = prevNoInput, prevOut, prevForm })

	for _, noInput := range []bool{false, true} {
		for _, formOK := range []bool{false, true} {
			noInputMode = noInput
			interactiveOutIsTTY = func() bool { return formOK }

			stdoutIsTTY = func() bool { return true }
			withTTY := requireInteractiveForm()
			stdoutIsTTY = func() bool { return false }
			withoutTTY := requireInteractiveForm()

			if !errors.Is(withTTY, withoutTTY) || !errors.Is(withoutTTY, withTTY) {
				t.Errorf("noInput=%v formStream=%v: the gate changed its answer with stdout "+
					"(%v vs %v) — a form does not draw on stdout",
					noInput, formOK, withTTY, withoutTTY)
			}
		}
	}
}

// TestInteractiveOutput_IsTheStreamTheSeamWatches closes the loop between the two packages.
//
// ui.InteractiveOutput is what huh is told to draw on, and interactiveOutIsTTY asks isatty about that same
// descriptor. Stating the fd here means a huh upgrade that moved the default cannot silently invert
// the gate: whoever changes ui.InteractiveOutput changes the gate with it.
func TestInteractiveOutput_IsTheStreamTheSeamWatches(t *testing.T) {
	if got := ui.InteractiveOutput(); got != os.Stderr {
		t.Fatalf("ui.InteractiveOutput() = %v, want os.Stderr — huh v0.8.0 draws forms there "+
			"(tea.WithOutput(os.Stderr), form.go:112). If this legitimately moved, the seam in "+
			"seams.go and every comment naming stderr move with it", got.Name())
	}
	if ui.InteractiveOutput() == os.Stdout {
		t.Fatal("the form stream and the table stream must not be the same file, or " +
			"interactiveTable and requireInteractiveForm are asking one question twice")
	}
}

// TestConfirm_IsGatedOnTheFormPredicate pins the confirm dialog specifically.
//
// confirm IS a huh form, so it needs a stream to draw on like any other. It used to read
// noInputMode alone, which is how `alethia alerts delete r1 2> log` came to open a Yes/No into the
// log file. Both arms are here because the two answers are different actions: confirm declines
// quietly, confirmDestructive dies on the fatal path so a scripted teardown cannot no-op.
func TestConfirm_IsGatedOnTheFormPredicate(t *testing.T) {
	prevNoInput, prevForm := noInputMode, interactiveOutIsTTY
	t.Cleanup(func() { noInputMode, interactiveOutIsTTY = prevNoInput, prevForm })
	noInputMode = false
	interactiveOutIsTTY = func() bool { return false }

	forms := 0
	prevForms := runHuhForm
	runHuhForm = func(...*huh.Group) error { forms++; return nil }
	t.Cleanup(func() { runHuhForm = prevForms })

	if confirm("Delete the rule?", "") {
		t.Error("confirm must decline when the form has nowhere visible to draw")
	}
	if forms != 0 {
		t.Errorf("confirm opened %d form(s) into a redirected stream", forms)
	}

	code := -1
	prevExit := exitFunc
	exitFunc = func(c int) { code = c }
	t.Cleanup(func() { exitFunc = prevExit })

	if confirmDestructive(false, "Destroy?", "") {
		t.Error("confirmDestructive must not proceed unconfirmed")
	}
	if code != 1 {
		t.Errorf("confirmDestructive exit code = %d, want 1 — a scripted destroy that exits 0 "+
			"having done nothing is the defect errConfirmRequiresYes exists to prevent", code)
	}
	if forms != 0 {
		t.Errorf("confirmDestructive opened %d form(s) into a redirected stream", forms)
	}

	// The accept arm, same posture minus the redirect: --yes proceeds without any form at all.
	code = -1
	if !confirmDestructive(true, "Destroy?", "") {
		t.Error("--yes must proceed")
	}
	if code != -1 {
		t.Errorf("--yes took the fatal path (exit %d)", code)
	}
	if forms != 0 {
		t.Errorf("--yes opened %d form(s); it is the answer, not a reason to ask again", forms)
	}
}
