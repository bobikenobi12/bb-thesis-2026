// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package spec

import (
	"strings"
	"testing"
)

func TestDocsRowsAreInSpecOrder(t *testing.T) {
	rows := probe().DocsRows()
	if len(rows) != 5 {
		t.Fatalf("got %d rows, want one per field", len(rows))
	}
	// Spec order, not sorted: the order a form asks is the order a reader meets them, and a table
	// sorted differently from the form is a third thing to keep in sync.
	want := []string{"Name", "Region", "Stage", "Force", "Note"}
	for i, w := range want {
		if rows[i][0] != w {
			t.Errorf("row %d is %q, want %q — the table must follow spec order", i, rows[i][0], w)
		}
	}
	// The overriding field's table cell is the Docs text, not the terser --help one.
	if rows[4][1] != "an optional note (for the table)" {
		t.Errorf("the Note row's description = %q, want the Docs override", rows[4][1])
	}
	if rows[0][2] != "`[name]`" {
		t.Errorf("a positional's token = %q", rows[0][2])
	}
	if rows[1][2] != "`--region`" {
		t.Errorf("a flag's token = %q", rows[1][2])
	}
}

func TestRenderDocsTableIsAValidPaddedGFMTable(t *testing.T) {
	out := probe().RenderDocsTable()
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 7 {
		t.Fatalf("got %d lines, want a header, a delimiter and five rows:\n%s", len(lines), out)
	}
	for i, l := range lines {
		if !strings.HasPrefix(l, "|") || !strings.HasSuffix(l, "|") {
			t.Errorf("line %d is not a table row: %q", i, l)
		}
		if got := strings.Count(l, "|"); got != 4 {
			t.Errorf("line %d has %d pipes, want 4 for three columns: %q", i, got, l)
		}
	}
	if !strings.Contains(lines[0], "Field") || !strings.Contains(lines[0], "Set without the form") {
		t.Errorf("header = %q, want the house columns", lines[0])
	}
	if !strings.HasPrefix(lines[1], "| ---") {
		t.Errorf("delimiter = %q", lines[1])
	}
	// Every line is padded to the same width, which is what the fifty hand-written tables already
	// do — a generator that reflowed them all would bury its own first diff in noise.
	width := len([]rune(lines[0]))
	for i, l := range lines {
		if got := len([]rune(l)); got != width {
			t.Errorf("line %d is %d runes wide, want %d — the columns are not aligned:\n%s", i, got, width, out)
		}
	}
}

func TestMarkerForMatchesTheConventionAlreadyInTheDocs(t *testing.T) {
	// Fifty of these exist in apps/docs today; the generator must produce the same string or it
	// anchors nothing.
	if got := MarkerFor("alethia token create"); got != "{/* fieldspec: alethia token create */}" {
		t.Errorf("MarkerFor = %q", got)
	}
}

func TestManifestKeysAreDeclaredHereAndSorted(t *testing.T) {
	s := probe()
	keys := s.ManifestKeys()
	if len(keys) != 2 {
		t.Fatalf("got %d manifest keys, want the two fields that declare one", len(keys))
	}
	if f, ok := keys["cloud.region"]; !ok || f.Key != "region" {
		t.Errorf("cloud.region maps to %+v", f)
	}
	if _, ok := keys["stage"]; ok {
		t.Error("a field with no ManifestKey must not appear")
	}

	// Sorted by key path: this rendering is read as a file layout, not as a sequence of questions.
	paths := s.ManifestKeyPaths()
	want := []string{"cloud.region", "name"}
	if strings.Join(paths, ",") != strings.Join(want, ",") {
		t.Errorf("ManifestKeyPaths() = %v, want %v sorted", paths, want)
	}
}

func TestAllPagesCollectsBothColumns(t *testing.T) {
	f := Field{Page: "a.mdx", Pages: []string{"b.mdx", "c.mdx"}}
	if got := f.AllPages(); strings.Join(got, ",") != "a.mdx,b.mdx,c.mdx" {
		t.Errorf("AllPages = %v", got)
	}
	if got := (Field{}).AllPages(); len(got) != 0 {
		t.Errorf("a field on no page = %v, want empty", got)
	}
	if got := (Field{Pages: []string{"only.mdx"}}).AllPages(); strings.Join(got, ",") != "only.mdx" {
		t.Errorf("AllPages with no Page = %v", got)
	}
}

func TestDefaultUsageAppendsTheAllowedSet(t *testing.T) {
	s := probe()
	if got := DefaultUsage(s, s.MustField("stage")); got != "which stage (development | production | staging)" {
		t.Errorf("DefaultUsage(constrained) = %q", got)
	}
	if got := DefaultUsage(s, s.MustField("region")); got != "where to run" {
		t.Errorf("DefaultUsage(unconstrained) = %q, want no parenthetical", got)
	}
}
