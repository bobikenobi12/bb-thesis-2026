// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// One field spec, four renderings — the shell's.
//
// shell_fields.go is the source. This holds the other three renderings to it: the FLAG registered
// on the command, the DOCS row on every page that carries one, and the leaf ledger that says which
// commands take a value at all. The fourth rendering, an interactive form, is where this group
// differs from every other: the shell's one field has a default, so it is answered rather than
// asked, and that is recorded rather than assumed.

// shellDocsRead reads a docs page. An unreadable one is a FAILURE, never a skip: "I could not look"
// and "I looked and it was fine" must not be the same verdict.
func shellDocsRead(t *testing.T, page string) string {
	t.Helper()
	path := filepath.Join(docsRepoRoot(), filepath.FromSlash(page))
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v — this guard's verdict depends on the file, so an absent one is a "+
			"failure rather than a pass", path, err)
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		t.Fatalf("%s is empty", path)
	}
	return string(b)
}

// TestHygCliShell_SpecIsWellFormed pins the spec's own shape before anything is checked against it.
func TestHygCliShell_SpecIsWellFormed(t *testing.T) {
	if len(shellFields) == 0 {
		t.Fatal("the spec is empty — every assertion in this file would be vacuous")
	}
	seen := map[string]bool{}
	for _, f := range shellFields {
		id := f.Command + "/" + f.Key
		if seen[id] {
			t.Errorf("%s is specified twice", id)
		}
		seen[id] = true

		if (f.Flag == "") == (f.Arg == "") {
			t.Errorf("%s sets %s — exactly one of Flag and Arg must be set, because a value is "+
				"either supplied by a flag or written as a positional",
				id, map[bool]string{true: "neither Flag nor Arg", false: "both Flag and Arg"}[f.Flag == ""])
		}
		if f.Docs == "" {
			t.Errorf("%s has no Docs sentence, so the row on its page is unchecked", id)
		}
		if len(f.Pages) == 0 {
			t.Errorf("%s names no page — the docs rendering of this field is unchecked", id)
		}
		if f.Flag != "" && f.Usage == "" {
			t.Errorf("%s is a flag with no Usage, so `--help` would say nothing about it", id)
		}
		if len(f.Shorthand) > 1 {
			t.Errorf("%s has shorthand %q; a shorthand is one letter", id, f.Shorthand)
		}
	}
}

// TestHygCliShell_EveryFieldIsAFlagOrAnAcceptedPositional pins the FLAG rendering.
//
// The complete-contract rule for this group: anything the shell can take, a flag or a positional
// can supply, so `--no-input` can always do it. A field naming a flag that is not on the command
// is the rule broken in the way nothing else notices — the docs promise it and `--help` does not.
func TestHygCliShell_EveryFieldIsAFlagOrAnAcceptedPositional(t *testing.T) {
	checked := 0
	for _, f := range shellFields {
		tokens := strings.Fields(f.Command)[1:] // drop "alethia"
		cmd, _, err := rootCmd.Find(tokens)
		if err != nil {
			t.Errorf("%s names a command that does not resolve: %v", f.Command, err)
			continue
		}
		if len(tokens) > 0 && cmd.CommandPath() != f.Command {
			t.Errorf("%s resolved to %q", f.Command, cmd.CommandPath())
			continue
		}
		checked++

		if f.Flag != "" {
			flag := cmd.Flags().Lookup(f.Flag)
			if flag == nil {
				flag = cmd.PersistentFlags().Lookup(f.Flag)
			}
			if flag == nil {
				t.Errorf("%s: `%s` has no --%s flag, so nothing can supply this value "+
					"non-interactively", f.Command, cmd.CommandPath(), f.Flag)
				continue
			}
			if flag.Shorthand != f.Shorthand {
				t.Errorf("--%s has shorthand %q, the spec says %q", f.Flag, flag.Shorthand, f.Shorthand)
			}
			// The usage string is the spec's, because the flag is REGISTERED from the spec. This
			// asserts that registration actually happened rather than a copy being kept in step.
			if flag.Usage != f.Usage {
				t.Errorf("--%s prints %q in --help, the spec says %q — the flag is not being "+
					"registered from the spec", f.Flag, flag.Usage, f.Usage)
			}
			continue
		}

		// A positional: the placeholder must appear in the command's own Use string, which is what
		// `--help` shows, and the command must actually accept an argument there.
		if !strings.Contains(cmd.Use, f.Arg) {
			t.Errorf("%s: the spec writes the positional as %q but `%s` has Use %q",
				f.Command, f.Arg, cmd.CommandPath(), cmd.Use)
		}
		if err := cmd.ValidateArgs([]string{f.Default}); err != nil {
			t.Errorf("%s: `%s` does not accept its own documented default %q: %v",
				f.Command, cmd.CommandPath(), f.Default, err)
		}
	}
	if checked == 0 {
		t.Fatal("no field was checked — every assertion above was vacuous")
	}
}

// TestHygCliShell_EveryFieldHasItsDocsRow pins the DOCS rendering: every page a field names carries
// a row for it, and every such row carries the spec's ONE sentence.
//
// The one sentence is the point. `--output` was described as "Output format." on one page and
// "Output format. `json`/`csv` print static, machine-readable output." on another, so a reader who
// found the first had no way to know the second said more.
func TestHygCliShell_EveryFieldHasItsDocsRow(t *testing.T) {
	pages := map[string]string{}
	checked := 0
	for _, f := range shellFields {
		for _, page := range f.Pages {
			body, ok := pages[page]
			if !ok {
				body = shellDocsRead(t, page)
				pages[page] = body
			}
			checked++

			// The token as the page writes it. For a POSITIONAL there is no flag spelling to fall
			// back to, and building one anyway gave `"-- "` — a string a prose page contains by
			// accident, which made this arm pass without looking at anything.
			// A pipe inside a Markdown TABLE CELL must be written `\|`: GFM splits a row on its
			// pipes before any inline parsing, so a backtick span does not protect one, and the
			// row silently loses a column. `[console|docs]` is therefore spelled two legal ways
			// depending on where it appears — raw in prose, escaped in a table — and this guard
			// accepts both rather than forcing the page to choose the one that renders wrong.
			//
			// Which of the two a given row must use is NOT this guard's question. That is a
			// structural property of the table and it is enforced by
			// TestHygCliDocs_EveryTableRowHasItsHeadersColumns, which counts cells. Answering it
			// here with a substring match is what let the broken row through in the first place.
			token := "`" + f.Arg + "`"
			mentioned := strings.Contains(body, token) || strings.Contains(body, docsEscapePipes(token))
			if f.Flag != "" {
				token = "`--" + f.Flag + "`"
				mentioned = strings.Contains(body, token) || strings.Contains(body, "--"+f.Flag+" ")
			}
			if !mentioned {
				t.Errorf("%s does not mention %s at all", page, token)
				continue
			}
			if !strings.Contains(body, f.Docs) {
				t.Errorf("%s does not carry the spec's sentence for %s:\n      want: %s",
					page, token, f.Docs)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no docs row was checked — every assertion above was vacuous")
	}
}

// TestHygCliShell_TheGlobalFlagTablesCountTheirOwnRows is the sentence-level version of the same
// defect, and the one that was actually wrong.
//
// Both global-flag tables opened "Every command accepts TWO persistent flags" while three were
// registered — a claim about a number, in prose, next to the list that contradicts it. Prose cannot
// be derived, so what is checked is that it does not name a WRONG number: the count in the sentence
// must be the count in the spec.
func TestHygCliShell_TheGlobalFlagTablesCountTheirOwnRows(t *testing.T) {
	globals := 0
	for _, f := range shellFields {
		if f.Command == "alethia" && f.Flag != "" {
			globals++
		}
	}
	if globals == 0 {
		t.Fatal("the spec holds no global flags, so this guard is checking a count of nothing")
	}
	words := map[int]string{1: "one", 2: "two", 3: "three", 4: "four", 5: "five"}
	correct, ok := words[globals]
	if !ok {
		t.Fatalf("no word for %d global flags — extend the table above", globals)
	}

	for _, page := range shellGlobalFlagPages {
		body := strings.ToLower(shellDocsRead(t, page))
		for n, word := range words {
			if n == globals {
				continue
			}
			for _, phrase := range []string{word + " persistent flags", word + " global flags"} {
				if strings.Contains(body, phrase) {
					t.Errorf("%s says %q, but %d persistent flags are registered — the sentence "+
						"beside the table has to be right or the table is not the answer",
						page, phrase, globals)
				}
			}
		}
		if !strings.Contains(body, correct+" persistent flags") {
			t.Errorf("%s does not say %q anywhere near its global-flags table", page,
				correct+" persistent flags")
		}
	}
}

// TestHygCliShell_EveryShellLeafIsAccountedFor pins the LEDGER: every runnable shell command either
// has a field or a recorded reason for having none.
//
// Derived from the live tree rather than listed, for the reason hyg_cli_confirm_test.go records at
// length: a hand-written list of what a guard watches stops covering silently. A new shell command
// joins this check by existing.
func TestHygCliShell_EveryShellLeafIsAccountedFor(t *testing.T) {
	leaves := shellCommands(rootCmd)
	if len(leaves) == 0 {
		t.Fatal("the shell has no runnable commands — either the roots are wrong or this walk " +
			"cannot see them, and either way every assertion here says nothing")
	}
	if len(leaves) < len(shellRoots) {
		t.Errorf("%d roots produced only %d runnable commands", len(shellRoots), len(leaves))
	}

	hasField := map[string]bool{}
	for _, f := range shellFields {
		hasField[f.Command] = true
	}
	for _, cmd := range leaves {
		path := cmd.CommandPath()
		reason, recorded := shellLeafTakesNoInput[path]
		switch {
		case hasField[path] && recorded:
			t.Errorf("%s both has a field and is recorded as taking no input", path)
		case hasField[path], recorded && strings.TrimSpace(reason) != "":
			// Accounted for.
		case recorded:
			t.Errorf("%s is recorded as taking no input with an empty reason — the record exists "+
				"to carry the reason", path)
		default:
			t.Errorf("%s has no entry in shellFields and no entry in shellLeafTakesNoInput. "+
				"Every leaf that takes a value from a person gets one; a leaf that takes none "+
				"says so, so an omission cannot look like a decision", path)
		}
	}

	// The ledger only grows against the live tree: an entry naming a command that is gone is
	// excusing nothing.
	live := map[string]bool{}
	for _, cmd := range leaves {
		live[cmd.CommandPath()] = true
	}
	for path := range shellLeafTakesNoInput {
		if !live[path] {
			t.Errorf("shellLeafTakesNoInput names %q, which is not a runnable shell command", path)
		}
	}
}

// TestHygCliShell_NoInputCanStillDoEverything is the complete-contract rule, driven.
//
// Every shell leaf must run to completion with --no-input and nothing else — no flag, no
// positional, no prompt. That is what "flags stay a complete contract" means for a group whose one
// field has a default: the default IS the non-interactive answer, and if any leaf refused here the
// group would have a value only a person could supply.
func TestHygCliShell_NoInputCanStillDoEverything(t *testing.T) {
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	resetFlagsAroundTest(t)

	code := -1
	prevExit := exitFunc
	exitFunc = func(c int) { code = c }
	t.Cleanup(func() { exitFunc = prevExit })

	prevOpen := openBrowser
	openBrowser = func(string) error { return nil }
	t.Cleanup(func() { openBrowser = prevOpen })

	// `update` is deliberately not driven: it is the one leaf whose Run reaches the network and
	// replaces the binary. Its --no-input behaviour is the development-build refusal, which
	// runUpdate is unit-tested for directly; driving it here would either hit the control plane or
	// need a seam that exists for no other reason.
	for _, args := range [][]string{
		{"version"},
		{"open"},
		{"open", "console"},
		{"open", "docs"},
	} {
		code = -1
		execRootArgs(append(append([]string{}, args...), "--no-input"))
		if err := rootCmd.Execute(); err != nil {
			t.Errorf("`alethia %s --no-input`: %v", strings.Join(args, " "), err)
		}
		if code != -1 {
			t.Errorf("`alethia %s --no-input` took the fatal path (exit %d) — a shell leaf must "+
				"not need a person", strings.Join(args, " "), code)
		}
	}
}

// docsEscapePipes spells a token the way a Markdown table cell must carry it.
func docsEscapePipes(s string) string { return strings.ReplaceAll(s, "|", "\\|") }
