// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package names

import (
	"bytes"
	"encoding/json"
	"os"
	"sort"
	"testing"
)

// The conformance table this package is held to. Written by apps/console/scripts/gen-go-names.ts
// from the REAL TypeScript implementation, so Go has no way to make itself right: a Go-only change
// reds these tests, and a TypeScript-only change reds the CI diff-gate on the committed table.

const casesPath = "testdata/name-cases.json"

type slugCase struct {
	ID   string `json:"id"`
	In   string `json:"in"`
	Max  int    `json:"max"`
	Want string `json:"want"`
}

type namespaceCase struct {
	ID          string `json:"id"`
	In          string `json:"in"`
	WantProblem string `json:"wantProblem"`
}

type environmentNameCase struct {
	ID             string `json:"id"`
	In             string `json:"in"`
	WantNormalized string `json:"wantNormalized"`
	WantProblem    string `json:"wantProblem"`
}

type nameCases struct {
	// Doc is the generator's own "DO NOT EDIT" banner. Decoded rather than ignored, because
	// DisallowUnknownFields below is what makes an undecoded section fail loudly.
	Doc     string `json:"_doc"`
	Version int    `json:"version"`
	Cases   struct {
		Slug            []slugCase            `json:"slug"`
		Namespace       []namespaceCase       `json:"namespace"`
		EnvironmentName []environmentNameCase `json:"environmentName"`
	} `json:"cases"`
}

// loadCases reads the table, and fails the test rather than skipping when it cannot.
//
// A missing or unreadable table is the single most likely way this whole file becomes decorative:
// `t.Skip` would leave a green run that proves nothing about a package whose entire job is to
// agree with another language.
func loadCases(t *testing.T) nameCases {
	t.Helper()
	raw, err := os.ReadFile(casesPath)
	if err != nil {
		t.Fatalf("cannot read %s (%v) — this table IS the contract packages/core/names is held to; "+
			"regenerate it with `pnpm -C apps/console run gen:go-names`", casesPath, err)
	}
	// Unknown fields are an error: a section added on the TypeScript side that this file does not
	// decode would otherwise be silently unenforced, which is exactly how a mirror stops mirroring.
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var doc nameCases
	if err := dec.Decode(&doc); err != nil {
		t.Fatalf("cannot decode %s: %v\n\nIf the generator grew a section, teach THIS file to decode "+
			"and assert it — an undecoded section is an unenforced one.", casesPath, err)
	}
	if doc.Version != 1 {
		t.Fatalf("%s is schema version %d; this file understands version 1", casesPath, doc.Version)
	}
	return doc
}

// TestTableIsNotVacuous fails when a section is empty, BEFORE any section is iterated.
//
// Every table-driven test below passes trivially over an empty slice. "Ran 0 cases" and "every
// case passed" must not share an exit code, and the only place that distinction can be made is
// here, by name.
func TestTableIsNotVacuous(t *testing.T) {
	doc := loadCases(t)
	sizes := map[string]int{
		"slug":            len(doc.Cases.Slug),
		"namespace":       len(doc.Cases.Namespace),
		"environmentName": len(doc.Cases.EnvironmentName),
	}
	names := make([]string, 0, len(sizes))
	for name := range sizes {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if sizes[name] == 0 {
			t.Errorf("section %q has zero cases; the table test for it would pass without asserting anything", name)
		}
	}
}

// TestSlugifyMatchesTheTable drives SlugifyOrEmpty over every generated slug case.
func TestSlugifyMatchesTheTable(t *testing.T) {
	for _, c := range loadCases(t).Cases.Slug {
		t.Run(c.ID, func(t *testing.T) {
			if got := SlugifyOrEmpty(c.In, c.Max); got != c.Want {
				t.Errorf("SlugifyOrEmpty(%q, %d) = %q, TypeScript says %q", c.In, c.Max, got, c.Want)
			}
		})
	}
}

// TestNamespaceProblemMatchesTheTable drives NamespaceProblem, message and all: the console shows
// that text to the operator, and a CLI that phrases the same refusal differently is two products.
func TestNamespaceProblemMatchesTheTable(t *testing.T) {
	for _, c := range loadCases(t).Cases.Namespace {
		t.Run(c.ID, func(t *testing.T) {
			if got := NamespaceProblem(c.In); got != c.WantProblem {
				t.Errorf("NamespaceProblem(%q) = %q, TypeScript says %q", c.In, got, c.WantProblem)
			}
			// IsNamespace must agree with its own message function, or one of the two call sites in
			// this repo enforces something the other does not.
			if got, want := IsNamespace(c.In), c.WantProblem == ""; got != want {
				t.Errorf("IsNamespace(%q) = %v but NamespaceProblem says %q", c.In, got, c.WantProblem)
			}
		})
	}
}

// TestEnvironmentNameMatchesTheTable drives both halves of the env-name rule.
func TestEnvironmentNameMatchesTheTable(t *testing.T) {
	for _, c := range loadCases(t).Cases.EnvironmentName {
		t.Run(c.ID, func(t *testing.T) {
			if got := NormalizeEnvironmentName(c.In); got != c.WantNormalized {
				t.Errorf("NormalizeEnvironmentName(%q) = %q, TypeScript says %q", c.In, got, c.WantNormalized)
			}
			if got := EnvironmentNameProblem(c.In); got != c.WantProblem {
				t.Errorf("EnvironmentNameProblem(%q) = %q, TypeScript says %q", c.In, got, c.WantProblem)
			}
		})
	}
}
