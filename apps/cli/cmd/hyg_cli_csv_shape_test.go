// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// A row builder that humanises a cell and cannot see the output format is the whole of #4033.
//
// `ui.Render`'s CSV branch writes `spec.Rows` VERBATIM, so a cell built for a person is also what a
// script receives. The behavioural half of this guard lives in hyg_cli_csv_test.go and drives the
// builders that exist today; this half is the shape test that keeps the NEXT table from starting
// the drift again, because a behavioural test can only assert about a builder somebody remembered
// to write a case for.
//
// THE QUESTION IT ASKS is deliberately the cheapest sound one: a function that RETURNS [][]string —
// the row-builder shape, the thing TableSpec.Rows takes — and calls one of the ui helpers that
// humanises, and has no parameter through which a format could reach it. Every defect this issue
// fixed had exactly that shape.
//
// It OVER-REPORTS on purpose. A row builder that is genuinely table-only (an interactive picker, a
// card pinned to FormatTable) is flagged and gets an exemption naming why, because the alternative
// — proving statically that a builder's rows never reach the CSV branch — means following its
// return value through call sites into ui.Render, and a guard that gives up on the hard cases
// reports green on precisely the ones worth knowing about.
//
// STRUCTURE, NOT TEXT, for the same reason hyg_cli_money_test.go parses instead of grepping: this
// file and render.go are full of prose naming `ui.TruncID` and `ui.StatusCell`, and a grep would be
// made green by deleting the explanation of the defect.

// csvHumanisers are the ui helpers whose output is FOR A READER. Each has a machine counterpart —
// the wire value itself for most, ui.Wire/WireBool/WireInt/WireFloat for the nullable and boolean
// ones — and ui.Cell(outFmt, machine, human) is the seam that picks between them.
var csvHumanisers = map[string]string{
	"OrDash":       "the em dash; a machine wants an empty field",
	"StrOrDash":    "the em dash; use ui.Wire for the machine arm",
	"IntOrDash":    "the em dash; use ui.WireInt",
	"FloatOrDash":  "a currency glyph and the em dash; use ui.WireFloat",
	"StampOrDash":  "`9 Mar 2026, 15:04` — not RFC3339, and the COMMA shifts every `cut -d,` reader",
	"StampOrNever": "the word `never`; a machine wants the absence",
	"Stamp":        "`9 Mar 2026, 15:04` — not RFC3339, and it contains a comma",
	"SmartTime":    "relative inside a week, a bare date beyond it; neither sorts",
	"RelativeTime": "`3 minutes ago`; a machine wants the RFC3339 it was handed",
	"StatusCell":   "a glyph welded to a case-folded status; a machine wants the wire status",
	"YesNo":        "a glyph for a boolean; use ui.WireBool",
	"DefaultCell":  "`◆` on one row and empty on the rest; use ui.WireBool",
	"GateGlyph":    "`✓`/`—` for a boolean; use ui.WireBool",
	"TruncID":      "EIGHT CHARACTERS AND AN ELLIPSIS — the one cell that destroys data outright",
}

// csvHumanisingSymbols are the sentinel constants, which humanise without a call.
var csvHumanisingSymbols = map[string]string{
	"SymbolDash":    "the em dash; a machine wants an empty field",
	"SymbolDefault": "`◆`; use ui.WireBool",
	"SymbolSuccess": "`✓`; use ui.WireBool",
	"SymbolArrow":   "`→` welds two fields into a cell nothing can split",
}

// csvShapeExemptions are row builders that humanise and take no format, each with the reason.
//
// An exemption is a DECISION, not a mute button: TestHygCliCsvShape_ExemptionsAreLive fails on an
// entry whose function no longer matches, so the list cannot rot into a permanent allowance. It
// only ever shrinks.
//
// EVERY ENTRY BELOW IS MEASURED DRIFT, NOT A RULING — the distinction is the one CLAUDE.md draws
// between the shared-surface allowlist's `reason:` and `lifts:` ledgers, and it is load-bearing.
// None of these says "this surface is genuinely different"; each says "#4192 will remove this", and
// #4192 exists, names all nineteen, and carries the shape they convert to.
//
// They are here because #4033's scope: glob is eight tables and these are seventeen other files
// owned by other noun groups. Narrowing the SCAN to the eight instead would have reported green on
// all of them — the guard would then be measuring the fix rather than the defect, which is how a
// guard's cheapest escape route becomes deepening what it guards against.
//
// The count is the point. #4033's body said "eight tables"; Render's own doc said its list was
// "MEASURED, not a closed one" and named about twelve files. The real number was nineteen builders
// across seventeen files, and nothing counted it until this guard ran.
var csvShapeExemptions = map[string]string{}

// csvShapeScanDirs are the directories walked, relative to apps/cli/cmd.
var csvShapeScanDirs = []string{".", "../pkg/utils/ui"}

type csvShapeHit struct {
	where  string // "file.go:funcName"
	helper string
}

// scanCSVRowBuilders returns every [][]string-returning function that humanises without a format,
// plus the number of files parsed and the number of row builders seen at all.
func scanCSVRowBuilders(t *testing.T) (hits []csvShapeHit, parsed, builders int) {
	t.Helper()
	for _, dir := range csvShapeScanDirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("readdir %s: %v", dir, err)
		}
		for _, e := range entries {
			name := e.Name()
			if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				continue
			}
			path := filepath.Join(dir, name)
			file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
			if err != nil {
				t.Fatalf("parse %s: %v", path, err)
			}
			parsed++
			key := name
			if dir != "." {
				key = dir + "/" + name
			}
			for _, decl := range file.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || fn.Body == nil || !returnsRows(fn) {
					continue
				}
				builders++
				if takesAFormat(fn) {
					continue
				}
				for _, helper := range humanisersUsedBy(fn) {
					hits = append(hits, csvShapeHit{where: key + ":" + fn.Name.Name, helper: helper})
				}
			}
		}
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].where < hits[j].where })
	return hits, parsed, builders
}

// returnsRows reports whether fn returns [][]string — the shape TableSpec.Rows takes.
func returnsRows(fn *ast.FuncDecl) bool {
	if fn.Type.Results == nil {
		return false
	}
	for _, r := range fn.Type.Results.List {
		outer, ok := r.Type.(*ast.ArrayType)
		if !ok || outer.Len != nil {
			continue
		}
		inner, ok := outer.Elt.(*ast.ArrayType)
		if !ok || inner.Len != nil {
			continue
		}
		if id, ok := inner.Elt.(*ast.Ident); ok && id.Name == "string" {
			return true
		}
	}
	return false
}

// takesAFormat reports whether any string parameter could carry the output format.
//
// By NAME and not by position, because that is the only thing a parse can see — and the name is
// also the convention every converted builder follows. `format` is accepted alongside `outFmt`
// because several pre-existing signatures use it, even though it shadows the packages/core/format
// package for the body and the newer ones deliberately do not.
func takesAFormat(fn *ast.FuncDecl) bool {
	if fn.Type.Params == nil {
		return false
	}
	for _, p := range fn.Type.Params.List {
		id, ok := p.Type.(*ast.Ident)
		if !ok || id.Name != "string" {
			continue
		}
		for _, n := range p.Names {
			switch n.Name {
			case "outFmt", "format", "outFormat":
				return true
			}
		}
	}
	return false
}

// humanisersUsedBy returns the humanising ui helpers and sentinels fn reaches for, deduplicated.
//
// A selector on ANY receiver spelled `ui` is counted, plus a bare call inside package ui itself,
// where the helpers are unqualified.
func humanisersUsedBy(fn *ast.FuncDecl) []string {
	seen := map[string]bool{}
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		pkg, ok := sel.X.(*ast.Ident)
		if !ok || pkg.Name != "ui" {
			return true
		}
		if _, is := csvHumanisers[sel.Sel.Name]; is {
			seen[sel.Sel.Name] = true
		}
		if _, is := csvHumanisingSymbols[sel.Sel.Name]; is {
			seen[sel.Sel.Name] = true
		}
		return true
	})
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func TestHygCliCsvShape_NoRowBuilderHumanisesBlind(t *testing.T) {
	hits, parsed, builders := scanCSVRowBuilders(t)

	for _, h := range hits {
		file := strings.SplitN(h.where, ":", 2)[0]
		if reason, exempt := csvShapeExemptions[h.where]; exempt {
			if strings.TrimSpace(reason) == "" {
				t.Errorf("%s is exempted with no reason", h.where)
			}
			continue
		}
		why := csvHumanisers[h.helper]
		if why == "" {
			why = csvHumanisingSymbols[h.helper]
		}
		t.Errorf("%s builds rows with ui.%s and cannot see the output format.\n"+
			"      ui.%s renders %s.\n"+
			"      Render's CSV branch writes these rows VERBATIM, so this is what `-o csv` emits.\n"+
			"      Take an `outFmt string` parameter and pick with ui.Cell(outFmt, machine, human),\n"+
			"      or add %q to csvShapeExemptions with the reason its rows never reach CSV.",
			h.where, h.helper, h.helper, why, h.where)
		_ = file
	}

	// Vacuity, both halves. A walk that parsed nothing, or that found no row builders at all,
	// would pass having checked nothing — and "no row builders" is exactly what a refactor that
	// renames the shape looks like from here.
	if parsed < 60 {
		t.Fatalf("parsed only %d files across %v — the walk is not seeing the CLI, so every "+
			"assertion above is vacuous", parsed, csvShapeScanDirs)
	}
	if builders < 10 {
		t.Fatalf("found only %d [][]string-returning functions — the shape test is not matching "+
			"the CLI's row builders, so it is asserting nothing", builders)
	}
}

func TestHygCliCsvShape_ExemptionsAreLive(t *testing.T) {
	hits, _, _ := scanCSVRowBuilders(t)
	live := map[string]bool{}
	for _, h := range hits {
		live[h.where] = true
	}
	for where := range csvShapeExemptions {
		if !live[where] {
			t.Errorf("exemption %q matches no blind row builder any more — delete the entry; "+
				"the list only shrinks", where)
		}
	}
}

// TestHygCliCsvShape_TheDetectorSpeaks drives the two predicates against known verdicts, so a
// change that makes the scan silent fails here rather than passing as an all-clear.
func TestHygCliCsvShape_TheDetectorSpeaks(t *testing.T) {
	cases := map[string]struct{ rows, format bool }{
		"func f() [][]string { return nil }":                   {rows: true, format: false},
		"func f(outFmt string) [][]string { return nil }":      {rows: true, format: true},
		"func f(format string) [][]string { return nil }":      {rows: true, format: true},
		"func f(n int) [][]string { return nil }":              {rows: true, format: false},
		"func f(name string) [][]string { return nil }":        {rows: true, format: false},
		"func f() []string { return nil }":                     {rows: false, format: false},
		"func f() [][]byte { return nil }":                     {rows: false, format: false},
		"func f() ([][]string, error) { return nil, nil }":     {rows: true, format: false},
		"func f(a, outFmt string) [][]string { return nil }":   {rows: true, format: true},
		"func f() [3][]string { var x [3][]string; return x }": {rows: false, format: false},
	}
	for src, want := range cases {
		file, err := parser.ParseFile(token.NewFileSet(), "x.go", "package p\n"+src, 0)
		if err != nil {
			t.Fatalf("parse %q: %v", src, err)
		}
		fn := file.Decls[0].(*ast.FuncDecl)
		if got := returnsRows(fn); got != want.rows {
			t.Errorf("returnsRows(%q) = %v, want %v", src, got, want.rows)
		}
		if got := takesAFormat(fn); got != want.format {
			t.Errorf("takesAFormat(%q) = %v, want %v", src, got, want.format)
		}
	}
}
