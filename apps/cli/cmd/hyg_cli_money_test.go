// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// A hand-rolled money render is a currency GLYPH welded to a format verb — `"$%.2f"`,
// `"$%.0f/mo"`. Two things are wrong with every one of them, and neither is visible at the call
// site:
//
//   - The glyph is a CONSTANT. `cost.go` rendered `$12.00/mo EUR` — a hardcoded `$` AND the wire's
//     ISO code in one string, so a euro organization was told two different currencies about one
//     number, and neither of them was reliably the right one.
//   - `%f` rounds half to EVEN. `fmt.Sprintf("%.2f", 0.125)` is `0.12`; the console's
//     `formatMonthlyRate` gives `$0.13`, because JavaScript rounds half away from zero. That claim
//     is measured rather than remembered — TestCostMoneyRoundsTheWayTheConsoleDoes in cost_test.go
//     drives both.
//
// `packages/core/format` answers both: `MonthlyRate(amount, style, currency)` renders the symbol
// when it knows one and the ISO code when it does not, never both, and rounds the way the console
// rounds. It is held to a conformance table the TypeScript side generates, so agreeing with it IS
// agreeing with the console.
//
// SCOPE. This guard reads `apps/cli/cmd` and `apps/cli/pkg/utils/ui` — the CLI's whole render
// surface. It does NOT reach into `packages/core`, whose renders belong to a different module and a
// different lane; a guard that claims a boundary it does not walk is worse than one that states a
// narrow one.
//
// STRUCTURE, NOT TEXT. It parses each file and looks only at string LITERALS. The first cut was a
// grep, and it flagged four PROSE COMMENTS — including the two in cost.go and render.go that
// explain this very defect — so the guard could only be made green by deleting the explanation of
// what it prevents. A comment quoting `"$%.2f"` renders nothing.

// moneyLiteral matches a currency glyph immediately followed by a printf verb: the shape of a
// render that has decided the currency in advance.
//
// The flag class is deliberately wide (`%-8.2f`, `%+.0f`) and the verb class is every verb that can
// print a number, `%v` included, because `fmt.Sprintf("$%v", x)` is the same mistake spelled
// lazily.
var moneyLiteral = regexp.MustCompile(`[$€£¥]%[-+ #0-9.*']*[a-zA-Z]`)

// moneyExemptions are files that still hold a hand-rolled money render, each with the reason it is
// not fixed here. An exemption is a decision, not a mute button: TestHygCliMoney_ExemptionsAreLive
// fails when one names a file that no longer matches, so the list cannot rot into a permanent
// allowance. It only ever shrinks.
// EMPTY, and that is the finished state rather than an unwritten one. #3659 paid off both entries:
//
//   - `project_list.go` rendered `$%.0f/mo`, the live half-to-even defect — 12.5 printed `$12/mo`
//     against a billing page showing `$12.50`. It is `format.MonthlyRate(…, Estimate, "USD")` now.
//   - `../pkg/utils/ui/render.go`'s `ui.FloatOrDash` carried `$%.2f`. Its exemption named the real
//     obstacle — `MonthlyRate` appends `/mo`, which the `Cost Δ` column must not claim — and the
//     answer was `format.Money`, the register with no suffix, in minor units.
//
// An entry here is a DECISION with a reason, and TestHygCliMoney_ExemptionsAreLive fails on one
// that names a file no longer matching, so the list can only shrink. Adding to it needs the same
// justification these two carried: which lane owns the swap, and what blocks it today.
var moneyExemptions = map[string]string{}

// moneyScanDirs are the directories walked, relative to apps/cli/cmd.
var moneyScanDirs = []string{".", "../pkg/utils/ui"}

// scanMoneyLiterals returns, per file (keyed the way moneyExemptions is), the offending string
// literals, plus the number of files it actually parsed.
func scanMoneyLiterals(t *testing.T) (map[string][]string, int) {
	t.Helper()
	found := map[string][]string{}
	parsed := 0
	for _, dir := range moneyScanDirs {
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
			ast.Inspect(file, func(n ast.Node) bool {
				lit, ok := n.(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					return true
				}
				// Unquote so an escaped literal is judged on what it PRINTS. A raw string
				// literal that will not unquote is judged on its source text rather than
				// skipped: skipping is how a guard reports green on the one shape it cannot
				// read.
				value := lit.Value
				if unquoted, err := strconv.Unquote(lit.Value); err == nil {
					value = unquoted
				}
				if moneyLiteral.MatchString(value) {
					found[key] = append(found[key], value)
				}
				return true
			})
		}
	}
	return found, parsed
}

func TestHygCliMoney_NoCommandRendersMoneyWithAHardcodedCurrency(t *testing.T) {
	found, parsed := scanMoneyLiterals(t)

	for file, literals := range found {
		if reason, exempt := moneyExemptions[file]; exempt {
			if strings.TrimSpace(reason) == "" {
				t.Errorf("%s is exempted with no reason", file)
			}
			continue
		}
		t.Errorf("%s renders money with a hardcoded currency glyph: %q\n"+
			"      The glyph is a constant and %%f rounds half to EVEN, so this cell can name the wrong\n"+
			"      currency AND the wrong amount. Use packages/core/format.MonthlyRate(amount, style,\n"+
			"      currency) — format.Exact for a billed or itemised figure, format.Estimate for a\n"+
			"      projection — or add an entry to moneyExemptions saying why not.",
			file, literals)
	}

	// Vacuity. A walk that parsed nothing would pass having checked nothing, and this guard's whole
	// value is that it keeps checking as the CLI grows. apps/cli/cmd alone is over ninety files.
	if parsed < 60 {
		t.Fatalf("parsed only %d files across %v — the walk is not seeing the CLI, so every assertion "+
			"above is vacuous", parsed, moneyScanDirs)
	}
}

func TestHygCliMoney_ExemptionsAreLive(t *testing.T) {
	found, _ := scanMoneyLiterals(t)
	for file := range moneyExemptions {
		if len(found[file]) == 0 {
			t.Errorf("exemption %q matches no money literal any more — delete the entry; the list only shrinks", file)
		}
	}
}

// TestHygCliMoney_DetectorSpeaks drives the detector itself against inputs whose verdict is known.
//
// Without it, a regex that had stopped matching anything would leave the guard above passing, the
// exemption list is the only thing that would notice, and it would notice by failing for a reason
// that reads as "someone fixed clusters_get.go". A detector that cannot speak must say so in its
// own voice.
func TestHygCliMoney_DetectorSpeaks(t *testing.T) {
	cases := map[string]bool{
		// Real shapes taken from the tree, past and present.
		"$%.2f":                 true,
		"$%.0f/mo":              true,
		"Cost%s: $%.2f/mo %s%s": true,
		"$%v":                   true,
		"€%.2f":                 true,
		"£%-8.2f":               true,
		"¥%d":                   true,
		"$%*.f":                 true,
		// Not a money render: no verb behind the glyph, or no glyph in front of the verb.
		"$12.00":                      false,
		"%.2f":                        false,
		"total $ and %d resources":    false,
		"cost_delta_threshold ($/mo)": false,
		"%s%s":                        false,
	}
	for input, want := range cases {
		if got := moneyLiteral.MatchString(input); got != want {
			t.Errorf("moneyLiteral.MatchString(%q) = %v, want %v", input, got, want)
		}
	}
}

// TestHygCliMoney_ProseIsNotARender pins the thing that made the first cut of this guard
// unshippable: the comments explaining the defect quote the defect.
//
// It reads the two files that carry such a comment and asserts they are NOT in the census — a
// grep-based detector would report both, and the only way to green it would be to delete the
// explanation.
func TestHygCliMoney_ProseIsNotARender(t *testing.T) {
	found, _ := scanMoneyLiterals(t)
	for _, file := range []string{"cost.go"} {
		source, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		if !moneyLiteral.Match(source) {
			t.Fatalf("%s no longer contains the prose this test exists to protect — if the comment "+
				"explaining the hardcoded-currency defect was deleted, this test is asserting nothing",
				file)
		}
		if len(found[file]) != 0 {
			t.Errorf("%s is flagged for %q, but its only match is a COMMENT — the detector is reading "+
				"text rather than string literals", file, found[file])
		}
	}
}
