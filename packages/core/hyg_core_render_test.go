// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package core_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// renderExemptions are the files whose human renders this guard has SEEN and a named issue owns.
// An exemption is an issue-backed decision, not a mute list: the staleness check at the end of
// TestHygCoreRender_NoUnsharedHumanRenders fails when an entry names a file that no longer
// produces a finding, so the list cannot rot into a permanent allowance — it only shrinks.
//
// #3892 asked for this guard to ship with an EMPTY list, on the measurement that #3888 had already
// migrated the runner's money and elapsed spans onto packages/core/format. #3888 is still OPEN, so
// that measurement was taken against a tree that does not exist yet: the four #3888 entries below
// are what packages/core actually contains today, and #3888 touches exactly those four files.
// Each is deleted when #3888 lands — that PR's own diff is what makes the entry stale, and the
// staleness check turns "forgot to delete it" into a red run rather than a silent allowance.
// The four #3888 entries are GONE, which is the staleness check doing its job. Each said
// "remove this entry when #3888 lands"; #3888 landed, the four files now render through
// packages/core/format, and the check below failed on all four at once — "names a file that
// produces no finding — delete it; the list only shrinks".
//
// That is the property worth keeping: an exemption written against a tree that has since moved
// cannot sit here reading as evidence the defect survives.
var renderExemptions = map[string]string{
	"infracost/infracost.go": "#3768: Infracost's external summary remains a documented migration exception",
}

var moneyLiteral = regexp.MustCompile(`[$€£¥]%[-+ #0-9.*']*[a-zA-Z]`)

type renderFinding struct {
	kind string
	text string
}

// scanCoreSource finds human-facing duration and currency renders in one Go source file.
func scanCoreSource(filename, source string) []renderFinding {
	file, err := parser.ParseFile(token.NewFileSet(), filename, source, 0)
	if err != nil {
		return []renderFinding{{kind: "parse", text: err.Error()}}
	}
	findings := make([]renderFinding, 0)
	ast.Inspect(file, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.BasicLit:
			if n.Kind == token.STRING && moneyLiteral.MatchString(strings.Trim(n.Value, "`\"")) {
				findings = append(findings, renderFinding{kind: "money", text: n.Value})
			}
		case *ast.CallExpr:
			at := printfFormatIndex(n)
			if at < 0 || len(n.Args) <= at {
				return true
			}
			format, ok := n.Args[at].(*ast.BasicLit)
			if !ok || format.Kind != token.STRING || !strings.Contains(format.Value, "%") {
				return true
			}
			for _, arg := range n.Args[at+1:] {
				if containsDuration(arg) {
					findings = append(findings, renderFinding{kind: "duration", text: format.Value})
					break
				}
			}
		}
		return true
	})
	return findings
}

// printfFormatIndex reports which argument of a Printf-family call carries the human-facing format
// string, or -1 when the call is not one.
//
// Both halves of this were wrong in the first cut, and they hid each other. It accepted only
// Printf/Sprintf — of which packages/core has 396, not one of them taking a duration — so the
// duration half of the guard matched zero real sites while reporting green. The four human duration
// renders here are three fmt.Errorf and one fmt.Fprintf. And Fprintf's format is its SECOND
// argument: reading argument 0 as the format finds a writer, fails the string-literal test and
// returns quietly, so merely adding the name to the old one-index check would still have missed
// provisioner/destroy_loadbalancers.go. The index is the fix; the name list alone is not.
func printfFormatIndex(call *ast.CallExpr) int {
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return -1
	}
	switch selector.Sel.Name {
	case "Printf", "Sprintf", "Errorf":
		return 0
	case "Fprintf":
		return 1
	}
	return -1
}

// containsDuration reports whether an expression exposes a duration to a human formatter.
func containsDuration(node ast.Expr) bool {
	var found bool
	ast.Inspect(node, func(child ast.Node) bool {
		call, ok := child.(*ast.CallExpr)
		if !ok {
			return true
		}
		if selector, ok := call.Fun.(*ast.SelectorExpr); ok {
			if selector.Sel.Name == "Duration" {
				if ident, ok := selector.X.(*ast.Ident); ok && ident.Name == "format" {
					return false
				}
			}
			if selector.Sel.Name == "Since" {
				if ident, ok := selector.X.(*ast.Ident); ok && ident.Name == "time" {
					found = true
				}
			}
			if selector.Sel.Name == "String" && durationReceiver(selector.X) {
				found = true
			}
		}
		return !found
	})
	return found
}

// durationReceiver identifies the direct duration-producing expressions this guard can prove safely.
func durationReceiver(node ast.Expr) bool {
	call, ok := node.(*ast.CallExpr)
	if !ok {
		return false
	}
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	if selector.Sel.Name == "Since" {
		ident, ok := selector.X.(*ast.Ident)
		return ok && ident.Name == "time"
	}
	if selector.Sel.Name == "Duration" {
		ident, ok := selector.X.(*ast.Ident)
		return ok && ident.Name == "time"
	}
	return false
}

func TestHygCoreRender_NoUnsharedHumanRenders(t *testing.T) {
	findings := map[string][]renderFinding{}
	scanned := 0
	err := filepath.Walk(".", func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if path == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") || path == "hyg_core_render_test.go" {
			return nil
		}
		source, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		scanned++
		if matches := scanCoreSource(path, string(source)); len(matches) > 0 {
			findings[path] = matches
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if scanned < 100 {
		t.Fatalf("scanned only %d core files — the guard is not seeing packages/core, so its census is vacuous", scanned)
	}
	for file, matches := range findings {
		if reason, exempt := renderExemptions[file]; exempt {
			if strings.TrimSpace(reason) == "" {
				t.Errorf("%s is exempted with no issue-backed reason", file)
			}
			continue
		}
		t.Errorf("%s contains unshared human render(s): %v — use packages/core/format", file, matches)
	}
	// A stale exemption is its own failure. renderExemptions is consulted only for files that
	// PRODUCED a finding, so an entry whose file no longer matches is never read — it sits forever
	// excusing nothing, while the list still reads as a set of live decisions. That is how the four
	// #3888 entries above would outlive #3888. apps/cli/cmd/hyg_cli_render_test.go makes the same
	// assertion about its own list; the direction is the same here: the list only shrinks.
	for file := range renderExemptions {
		if _, produced := findings[file]; !produced {
			t.Errorf("exemption %q names a file that produces no finding — delete it; the list only shrinks", file)
		}
	}
}

func TestHygCoreRender_DetectorSpeaksAndRespectsMachineBoundaries(t *testing.T) {
	cases := map[string]bool{
		`package p; import ("fmt"; "time"); func f(){ fmt.Printf("elapsed: %s", time.Since(time.Now())) }`:                  true,
		`package p; import ("fmt"; "time"); func f(){ fmt.Printf("elapsed: %s", format.Duration(time.Since(time.Now()))) }`: false,
		`package p; import ("fmt"; "time"); func f(){ fmt.Printf("cost: $%.2f", 1.25) }`:                                    true,
		"package p; func f(){ _ = \"cost: $12.50\" }":                                                                       false,
		`package p; import ("os/exec"; "time"); func f(){ exec.Command("tool", time.Since(time.Now()).String()) }`:          false,

		// The shapes packages/core actually uses. Every real duration render here is an Errorf or an
		// Fprintf, and every one of them rounds first — so a detector that handles neither passes the
		// three cases above and still matches nothing in the tree it is guarding.
		`package p; import ("fmt"; "time"); func f() error { return fmt.Errorf("still waiting after %s", time.Since(time.Now())) }`:                    true,
		`package p; import ("fmt"; "time"); func f() error { return fmt.Errorf("still waiting after %s", time.Since(time.Now()).Round(time.Second)) }`: true,
		`package p; import ("fmt"; "os"; "time"); func f(){ fmt.Fprintf(os.Stdout, "released after %s", time.Since(time.Now()).Round(time.Second)) }`:  true,

		// Fprintf's writer is not its format. If argument 0 were read as the format string these two
		// would flip: the first would go quiet (a writer is not a string literal) and the second would
		// start scanning the format itself as a value argument.
		`package p; import ("fmt"; "os"; "time"); func f(){ fmt.Fprintf(os.Stdout, "released after %s", format.Duration(time.Since(time.Now()))) }`: false,
		`package p; import ("fmt"; "os"); func f(){ fmt.Fprintf(os.Stdout) }`:                                                                       false,
	}
	for source, want := range cases {
		got := len(scanCoreSource("fixture.go", source)) > 0
		if got != want {
			t.Errorf("scanCoreSource() = %v for %q, want %v", got, source, want)
		}
	}
}
