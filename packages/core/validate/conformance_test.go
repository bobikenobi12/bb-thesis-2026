// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Go half of the shared-validation conformance table (#3670).
//
// testdata/validation-cases.json is written by apps/console/scripts/gen-go-validation.ts by RUNNING
// the console's own `.refine()` / `.transform()` closures over named inputs. Go cannot write it, so
// Go has no way to make itself right: a Go-only change reds this test, a TS-only change reds the CI
// diff-gate on the generator, and neither side can drift alone.
//
// This is what the "table" disposition BUYS. A rule that crosses over as a table is not shared code
// — the two implementations are independent — so the only thing making them one rule is this file
// agreeing with that one.

package validate

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
)

// casesVersion must match the generator's CASES_VERSION. A shape change bumps it there and fails
// here, rather than being absorbed by a lenient decode.
const casesVersion = 1

type caseRow struct {
	ID   string          `json:"id"`
	In   string          `json:"in"`
	Arg  *int            `json:"arg,omitempty"`
	Want json.RawMessage `json:"want"`
}

type ruleTable struct {
	Kind  string    `json:"kind"`
	Cases []caseRow `json:"cases"`
}

type casesDoc struct {
	Doc     string               `json:"_doc"`
	Version int                  `json:"version"`
	Rules   map[string]ruleTable `json:"rules"`
}

func loadCases(t *testing.T) casesDoc {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "validation-cases.json"))
	if err != nil {
		t.Fatalf("read the conformance table: %v", err)
	}
	var doc casesDoc
	dec := json.NewDecoder(bytes.NewReader(raw))
	// Strict: an unexpected field means the generator's shape moved and this test is reading
	// something other than what it thinks.
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("decode the conformance table: %v", err)
	}
	if doc.Version != casesVersion {
		t.Fatalf("conformance table version %d, this test reads version %d — the shape changed", doc.Version, casesVersion)
	}
	return doc
}

// TestConformanceTableIsNotVacuous fails on the shapes that would make every other assertion in
// this file pass while proving nothing: no rules, a rule with no cases, or a rule whose kind this
// file would silently skip.
func TestConformanceTableIsNotVacuous(t *testing.T) {
	doc := loadCases(t)
	if len(doc.Rules) == 0 {
		t.Fatal("the conformance table has no rules at all — zero rules and zero disagreements are not the same result")
	}
	for name, table := range doc.Rules {
		if len(table.Cases) == 0 {
			t.Errorf("rule %q has zero cases", name)
		}
		if table.Kind != "predicate" && table.Kind != "transform" {
			t.Errorf("rule %q has kind %q, which the runner below does not evaluate — it would be SKIPPED", name, table.Kind)
		}
	}
}

// TestConformance runs every case against this package's implementation.
func TestConformance(t *testing.T) {
	doc := loadCases(t)
	ran := 0

	for _, name := range sortedKeys(doc.Rules) {
		table := doc.Rules[name]
		t.Run(name, func(t *testing.T) {
			switch table.Kind {
			case "transform":
				fn, ok := LookupTransform(name)
				if !ok {
					t.Fatalf("no transform %q in this package's registry", name)
				}
				for _, c := range table.Cases {
					var want string
					if err := json.Unmarshal(c.Want, &want); err != nil {
						t.Fatalf("%s: want is not a string: %v", c.ID, err)
					}
					if got := fn(c.In); got != want {
						t.Errorf("%s: %q -> %q, the console says %q", c.ID, c.In, got, want)
					}
					ran++
				}
			case "predicate":
				fn, ok := LookupPredicate(name)
				if !ok {
					t.Fatalf("no predicate %q in this package's registry", name)
				}
				for _, c := range table.Cases {
					var want bool
					if err := json.Unmarshal(c.Want, &want); err != nil {
						t.Fatalf("%s: want is not a bool: %v", c.ID, err)
					}
					if got := fn(c.In, c.Arg); got != want {
						t.Errorf("%s: %q (arg %v) -> %v, the console says %v", c.ID, c.In, argString(c.Arg), got, want)
					}
					ran++
				}
			default:
				t.Fatalf("unhandled rule kind %q", table.Kind)
			}
		})
	}

	if ran == 0 {
		t.Fatal("ran zero cases — a green run and an empty run must not share an exit code")
	}
	t.Logf("%d conformance cases across %d rules", ran, len(doc.Rules))
}

// TestEveryTableRuleIsReferencedBySomeSpec closes the loop in the direction the table cannot see:
// a rule with a beautiful table that no Spec names is validation nothing runs.
func TestEveryTableRuleIsReferencedBySomeSpec(t *testing.T) {
	doc := loadCases(t)
	referenced := referencedRules()

	for name := range doc.Rules {
		if !referenced[name] {
			t.Errorf("the table covers rule %q, but no Spec references it — the cases pass and nothing uses the rule", name)
		}
	}
	for name := range referenced {
		if _, ok := doc.Rules[name]; !ok {
			t.Errorf("Specs reference rule %q, which has no conformance table — it crossed over untested", name)
		}
	}
	if len(referenced) == 0 {
		t.Fatal("no Spec references any rule — nothing here is being checked")
	}
}

// TestNoOrphanRuleImplementations derives the set of implementations from the registries themselves
// rather than from a list somebody maintains, so an implementation added and never wired up is
// reported instead of sitting there looking like coverage.
func TestNoOrphanRuleImplementations(t *testing.T) {
	referenced := referencedRules()
	for name := range predicates {
		if !referenced[name] {
			t.Errorf("predicate %q is implemented but no Spec references it", name)
		}
	}
	for name := range transforms {
		if !referenced[name] {
			t.Errorf("transform %q is implemented but no Spec references it", name)
		}
	}
	if len(predicates)+len(transforms) == 0 {
		t.Fatal("the rule registries are empty")
	}
}

// referencedRules is the set of rule names any Spec's steps name.
func referencedRules() map[string]bool {
	out := map[string]bool{}
	for _, spec := range Specs {
		for _, step := range spec.Steps {
			if step.Kind == StepRule || step.Kind == StepTransform {
				out[step.Rule] = true
			}
		}
	}
	return out
}

func sortedKeys(m map[string]ruleTable) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func argString(arg *int) string {
	if arg == nil {
		return "none"
	}
	return strconv.Itoa(*arg)
}
