// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// byoLookupFlag resolves a long flag name on a command, wherever it is declared.
//
// THREE sets, and all three are needed. cobra's Flags() carries a command's own local flags; a
// group's `--project` is on its PersistentFlags and is only merged into Flags() during an Execute,
// so a guard that inspects a tree it never ran sees neither the group's own persistent flag nor a
// leaf's inherited one. Reading only Flags() made the first cut of this file report that `alethia
// chart` has no --project flag — a false failure that a tired reader fixes by deleting the check.
func byoLookupFlag(cmd *cobra.Command, name string) *pflag.Flag {
	if f := cmd.Flags().Lookup(name); f != nil {
		return f
	}
	if f := cmd.PersistentFlags().Lookup(name); f != nil {
		return f
	}
	return cmd.InheritedFlags().Lookup(name)
}

// The BYO group's four renderings of one field spec, held to each other.
//
// Every identifier here carries the byoForm prefix so it cannot collide with another group's
// helpers in this package.
//
// The markdown-table reader is `authFormTable`, reused rather than rewritten. A second reader for
// the same file format would be a second opinion about what a docs table IS, and the two would
// disagree the first time one of them learned about an escaped pipe.

// ── rendering 1 · the flags and positionals ────────────────────────────────────────────────────

// TestHygCliByoForm_EveryFieldNamesARealFlagOrPositional is the "flags stay a COMPLETE contract"
// half: anything a form can ask, the command line can set.
//
// It resolves each spec entry against the LIVE cobra tree rather than against a list, so renaming
// --chart-path without touching the spec fails here.
func TestHygCliByoForm_EveryFieldNamesARealFlagOrPositional(t *testing.T) {
	if len(byoFields) == 0 {
		t.Fatal("byoFields is empty — every assertion below would pass having checked nothing")
	}
	for _, f := range byoFields {
		t.Run(f.Command+"/"+f.Key, func(t *testing.T) {
			if (f.Flag == "") == (f.Arg == "") {
				t.Fatalf("exactly one of Flag and Arg must be set; got Flag=%q Arg=%q", f.Flag, f.Arg)
			}
			if strings.TrimSpace(f.Title) == "" || strings.TrimSpace(f.Description) == "" {
				t.Fatalf("a field with no title or no description renders as an unlabelled question")
			}
			cmd, _, err := rootCmd.Find(strings.Fields(strings.TrimPrefix(f.Command, "alethia ")))
			if err != nil || cmd.CommandPath() != f.Command {
				t.Fatalf("no command %q in the tree (found %q, err %v)", f.Command, cmd.CommandPath(), err)
			}
			if f.Flag != "" {
				if byoLookupFlag(cmd, f.Flag) == nil {
					t.Errorf("%s asks for %q in its form and has NO --%s flag.\n"+
						"      A form field a flag cannot set means --no-input can never answer it, so the\n"+
						"      command is unusable from a script for the one value it exists to take.",
						f.Command, f.Title, f.Flag)
				}
				return
			}
			if !strings.Contains(cmd.Use, f.Arg) {
				t.Errorf("%s asks for %q in its form and its Use %q does not carry the positional %q",
					f.Command, f.Title, cmd.Use, f.Arg)
			}
		})
	}
}

// TestHygCliByoForm_EveryPositionalFieldIsOptional pins the half of "a positional can be asked for"
// that the spelling alone does not prove.
//
// A `[id]` in the Use string is prose. What decides whether the form can ever run is the command's
// Args validator: with `ExactArgs(1)` cobra refuses the invocation before Run is reached, so the
// question is unreachable and the page describing it is fiction. All three of these commands had
// exactly that shape until this pass.
func TestHygCliByoForm_EveryPositionalFieldIsOptional(t *testing.T) {
	checked := 0
	for _, f := range byoFields {
		if f.Arg == "" {
			continue
		}
		checked++
		t.Run(f.Command+"/"+f.Key, func(t *testing.T) {
			cmd, _, err := rootCmd.Find(strings.Fields(strings.TrimPrefix(f.Command, "alethia ")))
			if err != nil {
				t.Fatalf("no command %q in the tree: %v", f.Command, err)
			}
			if !strings.HasPrefix(f.Arg, "[") || !strings.HasSuffix(f.Arg, "]") {
				t.Errorf("%s's positional is written %q; a field a form can ask for is optional and "+
					"is spelled in square brackets", f.Command, f.Arg)
			}
			if err := cmd.ValidateArgs(nil); err != nil {
				t.Errorf("%s asks for %q in its form, and refuses to run without the argument: %v\n"+
					"      The Args validator rejects the invocation before Run, so the question can\n"+
					"      never be put and the interactive path is unreachable.", f.Command, f.Title, err)
			}
			if err := cmd.ValidateArgs([]string{"an-id"}); err != nil {
				t.Errorf("%s must still accept the argument it documents: %v", f.Command, err)
			}
		})
	}
	if checked == 0 {
		t.Fatal("no positional field was checked — every assertion above was vacuous")
	}
}

// TestHygCliByoForm_EveryFlagCarriesItsFieldDescription is the fourth rendering: `--help`.
//
// A flag's usage string and a form's helper line describe the same value to the same person, and
// neither is compiled, so typed twice they drift invisibly. Here the flag's usage is BUILT from the
// spec (byoFlagUsage), and this asserts it stayed that way — a hand-typed usage string that happens
// to read similarly is exactly the state this replaces.
//
// A PREFIX and not an equality, for one stated reason: a flag may append machine-derived detail a
// form's helper line should not repeat, and `--provider` appends the accepted values, which come
// from `gitProviders` rather than from prose.
func TestHygCliByoForm_EveryFlagCarriesItsFieldDescription(t *testing.T) {
	checked := 0
	for _, f := range byoFields {
		if f.Flag == "" {
			continue
		}
		checked++
		t.Run(f.Command+"/"+f.Key, func(t *testing.T) {
			cmd, _, err := rootCmd.Find(strings.Fields(strings.TrimPrefix(f.Command, "alethia ")))
			if err != nil {
				t.Fatalf("no command %q in the tree: %v", f.Command, err)
			}
			flag := byoLookupFlag(cmd, f.Flag)
			if flag == nil {
				t.Fatalf("%s has no --%s flag", f.Command, f.Flag)
			}
			if !strings.HasPrefix(flag.Usage, f.Description) {
				t.Errorf("--%s on %s describes itself differently from the form that asks for it:\n"+
					"       --help: %q\n"+
					"        spec : %q", f.Flag, f.Command, flag.Usage, f.Description)
			}
		})
	}
	if checked == 0 {
		t.Fatal("no flag-backed field was checked — every assertion above was vacuous")
	}
}

// ── the group, classified ──────────────────────────────────────────────────────────────────────

// byoLeafTakesOwnInput records, for every leaf in the group, whether it takes a value of its OWN —
// beyond the --project/--env selectors its group registers for all of them.
//
// The SET is derived from the command tree; only the answer is written down, so a new `alethia
// chart …` subcommand fails this test until somebody decides which side it is on.
//
// "Of its own" is the load-bearing qualifier. Every project-scoped leaf takes --project, so a
// classification that counted it would answer `true` for all eleven and distinguish nothing — a
// map that cannot be wrong is not a check.
var byoLeafTakesOwnInput = map[string]bool{
	"alethia chart list":   false,
	"alethia chart attach": true,
	"alethia chart detach": true,
	"alethia chart scan":   true,
	"alethia iac show":     false,
	"alethia iac attach":   true,
	"alethia iac detach":   false,
	"alethia iac scan":     false,
	"alethia repo list":    true,
	"alethia drift show":   false,
	"alethia staged list":  false,
}

// TestHygCliByoForm_EveryGroupLeafIsClassified closes the gap between "the group has a field spec"
// and "the field spec covers the group".
//
// The derived set and the table must match EXACTLY, in both directions. A count floor would not do:
// every leaf here can be named, and a floor passes with the interesting half deleted.
func TestHygCliByoForm_EveryGroupLeafIsClassified(t *testing.T) {
	commands := byoGroupCommands(rootCmd)
	if len(commands) == 0 {
		t.Fatal("the walk found no commands under chart/iac/repo/drift/staged — every assertion below is vacuous")
	}

	ownFields := map[string]int{}
	for _, f := range byoFields {
		ownFields[f.Command]++
	}

	contributed := map[string]bool{}
	seen := map[string]bool{}
	for _, c := range commands {
		path := c.CommandPath()
		seen[path] = true
		contributed[strings.Fields(path)[1]] = true
		takesInput, classified := byoLeafTakesOwnInput[path]
		if !classified {
			t.Errorf("%s is a leaf of this group and nothing says whether it takes input of its own.\n"+
				"      Classify it in byoLeafTakesOwnInput: a leaf that takes a value needs an\n"+
				"      interactive path and rows in byoFields; one that takes none needs neither.", path)
			continue
		}
		if !takesInput && ownFields[path] > 0 {
			t.Errorf("%s is recorded as taking no input of its own and has %d byoFields entries",
				path, ownFields[path])
		}
		if takesInput && ownFields[path] == 0 {
			t.Errorf("%s takes input of its own and has no byoFields row describing it", path)
		}
	}

	for _, r := range byoGroupRoots {
		if !contributed[r] {
			t.Errorf("`alethia %s` contributed no leaf — it is gone, renamed, or no longer registered", r)
		}
	}
	for path := range byoLeafTakesOwnInput {
		if !seen[path] {
			t.Errorf("byoLeafTakesOwnInput names %q, which the walk did not reach — it is gone or renamed", path)
		}
	}
}

// TestHygCliByoForm_EveryProjectScopedLeafInheritsBothSelectors is the group half of the spec.
//
// Which leaves are project-scoped is DERIVED — a leaf that can see a `--project` flag is one — so a
// new project-scoped command in this group is covered the moment it is registered. Each such leaf's
// GROUP must carry both selector rows, which is what makes describing them once per group honest
// rather than a place two of the four copies went missing.
func TestHygCliByoForm_EveryProjectScopedLeafInheritsBothSelectors(t *testing.T) {
	byGroup := map[string]map[string]bool{}
	for _, f := range byoFields {
		if byGroup[f.Command] == nil {
			byGroup[f.Command] = map[string]bool{}
		}
		byGroup[f.Command][f.Key] = true
	}
	scoped := 0
	for _, c := range byoGroupCommands(rootCmd) {
		path := c.CommandPath()
		if byoLookupFlag(c, "project") == nil {
			continue
		}
		scoped++
		group := byoGroupOf(path)
		for _, key := range []string{byoKeyProject, byoKeyEnv} {
			if !byGroup[group][key] {
				t.Errorf("%s takes --%s and its group %q has no byoFields row for it — the docs "+
					"table for that group therefore describes a flag it does not have", path, key, group)
			}
		}
	}
	if scoped == 0 {
		t.Fatal("no project-scoped leaf was found — the derivation stopped matching and this guard checked nothing")
	}
}

// ── rendering 2 · the docs ─────────────────────────────────────────────────────────────────────

// TestHygCliByoForm_DocsFieldTablesMirrorTheSpec is the docs half of "one field spec, four
// renderings".
//
// Every command with fields must carry a table on the page its spec names, and that table must be
// the same rows in the same order. A docs page is the only one of the four renderings a compiler
// cannot see, which is why it is the one that goes stale.
func TestHygCliByoForm_DocsFieldTablesMirrorTheSpec(t *testing.T) {
	root := authFormRepoRoot(t)
	byCommand := map[string][]byoField{}
	var order []string
	for _, f := range byoFields {
		if _, ok := byCommand[f.Command]; !ok {
			order = append(order, f.Command)
		}
		byCommand[f.Command] = append(byCommand[f.Command], f)
	}
	if len(order) == 0 {
		t.Fatal("no commands carry fields — this guard would check nothing")
	}

	for _, command := range order {
		fields := byCommand[command]
		t.Run(command, func(t *testing.T) {
			page := fields[0].Page
			for _, f := range fields {
				if f.Page != page {
					t.Fatalf("%s splits its fields across %s and %s; one command documents its form in one place",
						command, page, f.Page)
				}
			}
			marker := "{/* fieldspec: " + command + " */}"
			rows, ok := authFormTable(t, filepath.Join(root, page), marker)
			if !ok {
				t.Fatalf("%s carries no table after %s.\n"+
					"      The form asks %d question(s) that nothing in the docs describes.",
					page, marker, len(fields))
			}
			if len(rows) != len(fields) {
				t.Fatalf("%s documents %d field(s) after %s; the spec has %d.\n      docs: %v",
					page, len(rows), marker, len(fields), rows)
			}
			for i, f := range fields {
				want := []string{f.Title, f.Description, "`" + f.Arg + "`"}
				if f.Flag != "" {
					want[2] = "`--" + f.Flag + "`"
				}
				got := rows[i]
				if len(got) < 3 {
					t.Errorf("%s row %d has %d cells, want at least 3: %v", page, i+1, len(got), got)
					continue
				}
				for j, w := range want {
					if got[j] != w {
						t.Errorf("%s row %d cell %d:\n       docs: %q\n       spec: %q",
							page, i+1, j+1, got[j], w)
					}
				}
			}
		})
	}
}

// TestHygCliByoForm_MustByoFieldPanicsOnAMiss pins the failure mode of the spec lookup.
//
// The alternative to panicking is a zero byoField, which is a form that opens with an empty title
// and asks the user for something unnamed — a defect that renders and does not crash.
func TestHygCliByoForm_MustByoFieldPanicsOnAMiss(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("mustByoField returned for a key that does not exist; a zero field is an unlabelled question")
		}
	}()
	_ = mustByoField("alethia chart attach", "no-such-key")
}
