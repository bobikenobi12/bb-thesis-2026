// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The governance group's field spec, and the three other renderings of the same fields.
//
// Every identifier here carries the govForm prefix so it cannot collide with another group's
// helpers in this package. The docs-table reader (authFormTable) and the repo-root resolver
// (authFormRepoRoot) are REUSED from hyg_cli_authform_test.go rather than copied: two groups
// asserting "the docs mirror the spec" with two readers of the same markdown is two chances to
// disagree about what a table row is, and the failure mode would be a guard that passes on a page
// the other guard would fail.

// ── rendering 1 · the flags ───────────────────────────────────────────────────────────────────

// TestHygCliGovForm_EveryFieldNamesARealFlagOrPositional is the "flags stay a COMPLETE contract"
// half: anything a form can ask, the command line can set.
//
// It resolves each spec entry against the LIVE cobra tree rather than against a list, so renaming
// --warm-min or dropping the [channel] positional without touching the spec fails here.
func TestHygCliGovForm_EveryFieldNamesARealFlagOrPositional(t *testing.T) {
	if len(govFields) == 0 {
		t.Fatal("govFields is empty — every assertion below would pass having checked nothing")
	}
	for _, f := range govFields {
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
				// Flags(), then InheritedFlags(): --project and --env are PERSISTENT on the
				// group, so a Flags()-only lookup would report every project-scoped field in
				// this spec as missing.
				if cmd.Flags().Lookup(f.Flag) == nil && cmd.InheritedFlags().Lookup(f.Flag) == nil {
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

// govFormLeafTakesInput records, for every runnable command in the group, whether it takes a value
// from the person running it.
//
// The SET is derived from the command tree by govGroupCommands; only the ANSWER is written down.
// A new `alethia channels …` subcommand therefore fails this test until somebody decides which
// side it is on — which is the difference between a guard and a list.
var govFormLeafTakesInput = map[string]bool{
	"alethia protection list":           true,
	"alethia probes list":               true,
	"alethia promotion list":            true,
	"alethia promotion get":             true,
	"alethia classification dimensions": false,
	"alethia classification show":       true,
	"alethia classification assign":     true,
	"alethia classification unassign":   true,
	"alethia activity":                  true,
	"alethia alerts list":               false,
	"alethia alerts create":             true,
	"alethia alerts delete":             true,
	"alethia channels list":             false,
	"alethia channels create":           true,
	"alethia channels verify":           true,
	"alethia channels delete":           true,
	"alethia fleet list":                false,
	"alethia fleet set":                 true,
}

// TestHygCliGovForm_EveryLeafTakingInputHasASpec closes the gap a spec cannot close on its own: a
// command that takes a value and has no entry.
//
// Both directions are checked, and the second is the one that rots. A command dropped from the
// tree leaves a map entry that quietly describes nothing; a command ADDED to the tree with no map
// entry would otherwise be judged by no assertion at all.
func TestHygCliGovForm_EveryLeafTakingInputHasASpec(t *testing.T) {
	commands := govGroupCommands(rootCmd)
	if len(commands) == 0 {
		t.Fatal("govGroupCommands found nothing — the group roots do not resolve and every " +
			"assertion below is vacuous")
	}
	withFields := map[string]bool{}
	for _, f := range govFields {
		withFields[f.Command] = true
	}

	seen := map[string]bool{}
	for _, cmd := range commands {
		path := cmd.CommandPath()
		seen[path] = true
		takesInput, recorded := govFormLeafTakesInput[path]
		if !recorded {
			t.Errorf("`%s` is a runnable command in this group and nothing says whether it takes "+
				"input.\n      Add it to govFormLeafTakesInput — the set is derived from the tree so "+
				"that a new subcommand cannot join the group without joining its guards.", path)
			continue
		}
		if takesInput && !withFields[path] {
			t.Errorf("`%s` takes input and has no govFields entry — its flags, its form and its "+
				"docs table have nothing holding them together", path)
		}
		if !takesInput && withFields[path] {
			t.Errorf("`%s` is recorded as taking no input but carries govFields entries", path)
		}
	}
	for path := range govFormLeafTakesInput {
		if !seen[path] {
			t.Errorf("govFormLeafTakesInput names `%s`, which is not a runnable command in this "+
				"group any more — delete the entry", path)
		}
	}
}

// ── rendering 2 · the docs ────────────────────────────────────────────────────────────────────

// TestHygCliGovForm_DocsFieldTablesMirrorTheSpec is the docs half of "one field spec, four
// renderings".
//
// Every command with fields must carry a table on the page its spec names, and that table must be
// the same rows in the same order. A docs page is the only one of the four renderings a compiler
// cannot see, which is why it is the one that goes stale.
func TestHygCliGovForm_DocsFieldTablesMirrorTheSpec(t *testing.T) {
	root := authFormRepoRoot(t)
	byCommand := map[string][]govField{}
	var order []string
	for _, f := range govFields {
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
					"      The command takes %d value(s) that nothing in the docs describes.",
					page, marker, len(fields))
			}
			if len(rows) != len(fields) {
				t.Fatalf("%s documents %d field(s) after %s; the command takes %d.\n      docs: %v",
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

// ── rendering 3 · the form ────────────────────────────────────────────────────────────────────

// TestHygCliGovForm_EveryFormLookupResolves drives every mustGovField call the forms make.
//
// mustGovField PANICS on a miss, and that is the right failure for a programming error — but only
// if something reaches it. A form field whose key was renamed in the spec and not at the call site
// would otherwise panic the first time a user opened that form, on their terminal, rather than
// here. The pairs below are the call sites, and TestHygCliGovForm_LookupsCoverEveryCallSite pins
// that this list has not fallen behind them.
func TestHygCliGovForm_EveryFormLookupResolves(t *testing.T) {
	lookups := govFormCallSites()
	if len(lookups) == 0 {
		t.Fatal("no lookups listed — this guard would drive nothing")
	}
	for _, l := range lookups {
		t.Run(l.command+"/"+l.key, func(t *testing.T) {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("mustGovField(%q, %q) panicked: %v", l.command, l.key, r)
				}
			}()
			f := mustGovField(l.command, l.key)
			if f.Title == "" {
				t.Errorf("mustGovField(%q, %q) resolved to a field with no title", l.command, l.key)
			}
		})
	}
}

// govFormLookup is one (command, key) pair a form or a flag registration resolves.
type govFormLookup struct{ command, key string }

// govFormCallSites is every mustGovField pair the production code uses.
func govFormCallSites() []govFormLookup {
	return []govFormLookup{
		{"alethia protection list", fieldKeyGovProject},
		{"alethia probes list", fieldKeyGovProject},
		{"alethia promotion list", fieldKeyGovProject},
		{"alethia promotion list", fieldKeyGovEnv},
		{"alethia activity", fieldKeyGovLimit},
		{"alethia channels create", fieldKeyChannelName},
		{"alethia channels create", fieldKeyChannelType},
		{"alethia channels create", fieldKeyChannelRecipient},
		{"alethia channels create", fieldKeyChannelURL},
		{"alethia channels create", fieldKeyChannelRoutingKey},
		{"alethia alerts create", fieldKeyAlertName},
		{"alethia alerts create", fieldKeyAlertEvent},
		{"alethia alerts create", fieldKeyAlertChannel},
		{"alethia alerts create", fieldKeyAlertSeverity},
		{"alethia classification assign", fieldKeyClassDimension},
		{"alethia classification assign", fieldKeyClassValue},
		{"alethia classification unassign", fieldKeyClassValue},
		{"alethia fleet set", fieldKeyFleetProvider},
		{"alethia fleet set", fieldKeyFleetWarmMin},
		{"alethia fleet set", fieldKeyFleetMax},
		{"alethia fleet set", fieldKeyFleetSlots},
		{"alethia fleet set", fieldKeyFleetEnabled},
		{"alethia fleet set", fieldKeyFleetChannel},
		{"alethia fleet set", fieldKeyFleetVersion},
	}
}

// TestHygCliGovForm_LookupsCoverEveryCallSite derives the mustGovField pairs from the SOURCE and
// compares them with the hand-written list above.
//
// The list is hand-written because a (command, key) pair is a pair of constants and no runtime
// walk can find it; that is exactly the shape that stops covering silently. So the SET comes from
// the source text and only the list is typed — the same split govFormLeafTakesInput makes.
func TestHygCliGovForm_LookupsCoverEveryCallSite(t *testing.T) {
	found := govScanMustGovFieldCalls(t)
	if len(found) == 0 {
		t.Fatal("the scan found no mustGovField call in apps/cli/cmd — either the forms stopped " +
			"reading the spec, or this scan cannot see the directory")
	}
	listed := map[govFormLookup]bool{}
	for _, l := range govFormCallSites() {
		listed[l] = true
	}
	for l := range found {
		if !listed[l] {
			t.Errorf("mustGovField(%q, %q) is called in the source and is not in govFormCallSites "+
				"— it is therefore never driven, and a renamed key would panic on a user's terminal",
				l.command, l.key)
		}
	}
	for l := range listed {
		if !found[l] {
			t.Errorf("govFormCallSites lists mustGovField(%q, %q), which nothing calls any more — "+
				"delete it; the list only shrinks", l.command, l.key)
		}
	}
}

// ── the closed sets ───────────────────────────────────────────────────────────────────────────

// TestHygCliGovForm_ClosedSetsComeFromTheSchema pins that the channel types, the severities and
// the providers the CLI offers are the GENERATED sets, not a subset typed here.
//
// The defect this replaces was visible in --help: `--type` advertised "webhook, email, slack,
// pagerduty, …", four of nine, and the ellipsis was the only hint that five chat integrations
// existed. The assertion is on the CONTENT rather than on a count, because a count floor passes
// with every protected value replaced by a duplicate.
func TestHygCliGovForm_ClosedSetsComeFromTheSchema(t *testing.T) {
	cases := []struct {
		name string
		got  []string
		want []string
	}{
		{"channel types", channelTypeNames(), stringsOf(types.AllAlertChannelTypes)},
		{"severities", alertSeverityNames(), stringsOf(types.AllAlertSeveritys)},
		{"providers", cloudProviderNames(), stringsOf(types.AllCloudProviders)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if len(tc.got) == 0 {
				t.Fatal("the set is empty — every assertion about it is vacuous")
			}
			if strings.Join(tc.got, ",") != strings.Join(tc.want, ",") {
				t.Errorf("got %v, want the generated set %v", tc.got, tc.want)
			}
		})
	}

	// The two the flag help renders. Named values, not a count: `pagerduty` and `googlechat`
	// were both behind the ellipsis, and `critical` is the severity an operator most needs to
	// find. If the enum ever drops one the compiler catches it here, which is the point of
	// referencing the generated constants.
	for _, want := range []string{
		string(types.AlertChannelTypePagerduty),
		string(types.AlertChannelTypeGooglechat),
		string(types.AlertChannelTypeRocketchat),
	} {
		if !containsFold(channelTypeNames(), want) {
			t.Errorf("channelTypeNames() does not offer %q", want)
		}
	}
	if !containsFold(alertSeverityNames(), string(types.AlertSeverityCritical)) {
		t.Error("alertSeverityNames() does not offer critical")
	}
}

// TestHygCliGovForm_FlagHelpNamesEveryValue pins the rendering the closed sets exist for: the
// --type and --severity help strings must name every value, not an abbreviation.
func TestHygCliGovForm_FlagHelpNamesEveryValue(t *testing.T) {
	cases := []struct {
		command string
		flag    string
		values  []string
	}{
		{"alethia channels create", "type", channelTypeNames()},
		{"alethia alerts create", "severity", alertSeverityNames()},
	}
	for _, tc := range cases {
		t.Run(tc.command+"/--"+tc.flag, func(t *testing.T) {
			cmd, _, err := rootCmd.Find(strings.Fields(strings.TrimPrefix(tc.command, "alethia ")))
			if err != nil {
				t.Fatalf("no command %q: %v", tc.command, err)
			}
			f := cmd.Flags().Lookup(tc.flag)
			if f == nil {
				t.Fatalf("`%s` has no --%s", tc.command, tc.flag)
			}
			if len(tc.values) == 0 {
				t.Fatal("the value set is empty — this assertion would be vacuous")
			}
			for _, v := range tc.values {
				if !strings.Contains(f.Usage, v) {
					t.Errorf("--%s help %q does not name %q — a user cannot discover it",
						tc.flag, f.Usage, v)
				}
			}
			if strings.Contains(f.Usage, "…") {
				t.Errorf("--%s help %q abbreviates the set with an ellipsis", tc.flag, f.Usage)
			}
		})
	}
}

// stringsOf converts a generated enum slice to plain strings.
func stringsOf[T ~string](values []T) []string {
	out := make([]string, len(values))
	for i, v := range values {
		out[i] = string(v)
	}
	return out
}

// govScanMustGovFieldCalls parses apps/cli/cmd and returns every (command, key) pair a
// mustGovField call resolves.
//
// STRUCTURE, NOT TEXT, for the reason hyg_cli_money_test.go records at length: this file and the
// docs both quote `mustGovField(...)` in prose, and a grep-based scan would report those and could
// only be greened by deleting the explanation. It parses, walks call expressions, and resolves the
// second argument through the const block in governance_fields.go — a literal there would be a
// typo waiting to happen, which is why the spec uses constants and why this has to follow them.
//
// _test.go files are excluded: the pairs listed in govFormCallSites live in one, and a scan that
// read it would find them by construction and prove nothing.
func govScanMustGovFieldCalls(t *testing.T) map[govFormLookup]bool {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	fset := token.NewFileSet()
	consts := map[string]string{}
	var files []*ast.File
	parsed := 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		parsed++
		files = append(files, file)
		// Collect every untyped string constant in the package, so the key idents below resolve.
		for _, decl := range file.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || gen.Tok != token.CONST {
				continue
			}
			for _, spec := range gen.Specs {
				vs, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for i, ident := range vs.Names {
					if i >= len(vs.Values) {
						continue
					}
					lit, ok := vs.Values[i].(*ast.BasicLit)
					if !ok || lit.Kind != token.STRING {
						continue
					}
					if v, err := strconv.Unquote(lit.Value); err == nil {
						consts[ident.Name] = v
					}
				}
			}
		}
	}
	if parsed < 60 {
		t.Fatalf("parsed only %d command files — apps/cli/cmd has over ninety, so this scan is "+
			"not seeing the directory", parsed)
	}

	found := map[govFormLookup]bool{}
	for _, file := range files {
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			fn, ok := call.Fun.(*ast.Ident)
			if !ok || fn.Name != "mustGovField" || len(call.Args) != 2 {
				return true
			}
			lit, ok := call.Args[0].(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				t.Errorf("mustGovField's command argument at %s is not a string literal — the "+
					"scan cannot resolve it, so this call would go undriven",
					fset.Position(call.Pos()))
				return true
			}
			command, err := strconv.Unquote(lit.Value)
			if err != nil {
				t.Errorf("mustGovField's command argument at %s does not unquote: %v",
					fset.Position(call.Pos()), err)
				return true
			}
			ident, ok := call.Args[1].(*ast.Ident)
			if !ok {
				t.Errorf("mustGovField's key argument at %s is not an identifier — the spec's keys "+
					"are constants so that a typo is a compile error", fset.Position(call.Pos()))
				return true
			}
			key, ok := consts[ident.Name]
			if !ok {
				t.Errorf("mustGovField's key %s at %s resolves to no string constant in this package",
					ident.Name, fset.Position(call.Pos()))
				return true
			}
			found[govFormLookup{command: command, key: key}] = true
			return true
		})
	}
	return found
}
