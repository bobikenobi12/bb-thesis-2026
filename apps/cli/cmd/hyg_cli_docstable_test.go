// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// A GFM table row is split on its pipes BEFORE any inline parsing happens, so a backtick span
// does NOT protect a pipe inside it. `[console|docs]` in a three-column table yields FOUR cells,
// GFM drops the excess, and the row silently loses its last column when the page renders.
//
// This shipped in this PR and the existing docs guards could not see it: they ask whether a flag
// or a field appears in the page TEXT, and the row is present as text — it is only the RENDERING
// that is wrong. A guard whose question is "is this string here" can never answer "does this page
// display correctly", so the question has to be asked structurally, over cells rather than bytes.
//
// The rule the sibling pages already follow is `<table\|json\|csv>` (cli/index.mdx,
// cli/configuration.mdx). This makes that convention enforced rather than remembered.

var docsTableDelimiter = regexp.MustCompile(`^\|[\s:\-|]+\|$`)

// docsTableCells counts a row's cells the way GFM does: split on unescaped pipes, then discard the
// leading and trailing empties the outer pipes produce.
//
// The negative lookbehind Go's regexp cannot express is done by hand — a pipe preceded by a
// backslash is content, not a separator. Splitting with a naive strings.Split is exactly the bug
// this file exists to catch, one level up.
func docsTableCells(line string) int {
	line = strings.TrimSpace(line)
	var cells []string
	var cur strings.Builder
	escaped := false
	for _, r := range line {
		switch {
		case escaped:
			cur.WriteRune(r)
			escaped = false
		case r == '\\':
			cur.WriteRune(r)
			escaped = true
		case r == '|':
			cells = append(cells, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	cells = append(cells, cur.String())
	if len(cells) > 0 && strings.TrimSpace(cells[0]) == "" {
		cells = cells[1:]
	}
	if len(cells) > 0 && strings.TrimSpace(cells[len(cells)-1]) == "" {
		cells = cells[:len(cells)-1]
	}
	return len(cells)
}

// TestHygCliDocs_EveryTableRowHasItsHeadersColumns fails when a row's cell count differs from its
// header's — which is what an unescaped pipe produces.
func TestHygCliDocs_EveryTableRowHasItsHeadersColumns(t *testing.T) {
	root := filepath.Join("..", "..", "docs", "content", "docs", "cli")
	var pages, tables, rows int

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".mdx") {
			return nil
		}
		pages++
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		lines := strings.Split(string(raw), "\n")
		for i := 0; i+1 < len(lines); i++ {
			header := strings.TrimSpace(lines[i])
			if !strings.HasPrefix(header, "|") || !docsTableDelimiter.MatchString(strings.TrimSpace(lines[i+1])) {
				continue
			}
			tables++
			want := docsTableCells(header)
			for j := i + 2; j < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[j]), "|"); j++ {
				rows++
				if got := docsTableCells(lines[j]); got != want {
					t.Errorf("%s:%d has %d cells against a %d-column header — an unescaped `|` "+
						"inside a cell splits the row and the page drops the excess. Write it `\\|`, "+
						"as cli/index.mdx does for `<table\\|json\\|csv>`.\n  %s",
						path, j+1, got, want, strings.TrimSpace(lines[j]))
				}
			}
			i = i + 1
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", root, err)
	}

	// A ZERO CENSUS IS A FAILURE, not a pass. If the docs move, or the walk stops matching, this
	// guard would otherwise report success having checked nothing — which is the failure mode it
	// was written in response to.
	if pages == 0 || tables == 0 || rows == 0 {
		t.Fatalf("scanned %d pages, %d tables, %d rows under %s — the guard found nothing to check, "+
			"so its silence means nothing", pages, tables, rows, root)
	}
}
