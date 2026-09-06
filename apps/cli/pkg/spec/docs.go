// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package spec

import (
	"fmt"
	"sort"
	"strings"
)

// The docs rendering, and the manifest-key rendering — the third and fourth of the four.
//
// # The marker convention already exists, and this generates into it
//
// `apps/docs/content/docs/cli/**` carries fifty `{/* fieldspec: <command> */}` markers, each
// followed by a GFM table whose rows five near-identical Go tests assert cell-for-cell:
// hyg_cli_authform_test.go, hyg_cli_byoform_test.go, hyg_cli_govform_test.go,
// hyg_cli_orgform_test.go and ops_form_test.go, plus jobs_select_test.go and
// cov_connectors_test.go.
//
// Generating the table rather than asserting it collapses those into one mechanism: the CI diff-gate
// IS the assertion, and a table that disagrees with its spec cannot be committed rather than being
// caught by whichever of five tests happens to cover that group. Five copies of one check is how one
// of them stops being maintained.
//
// The direction is the reason this is a Go generator and not another `apps/console/scripts/gen-go-*`
// tsx one. The house pattern is TS -> Go, because the console owns the data those generators
// project. Here the SPEC is the source and it is Go, so the generator has to be — but the
// discipline is the same one gen-go-brand.ts states: only the write is conditional, so `--check`
// and the write path cannot answer differently.

// DocsHeader is the table header every fieldspec table carries. It is the header the existing
// hand-written tables already use, so a converted group's page does not churn.
var DocsHeader = []string{"Field", "What it is", "Set without the form"}

// DocsRows renders one spec's rows, in spec order.
//
// Spec order and not sorted: the order a form asks the questions is the order a reader meets them,
// and a table sorted differently from the form is a third thing to keep in sync.
func (s Spec) DocsRows() [][]string {
	rows := make([][]string, 0, len(s.Fields))
	for _, f := range s.Fields {
		rows = append(rows, []string{f.Title, f.DocsText(), f.Token()})
	}
	return rows
}

// MarkerFor is the MDX comment that anchors a command's table.
func MarkerFor(command string) string {
	return "{/* fieldspec: " + command + " */}"
}

// RenderDocsTable renders a spec as the GFM table that follows its marker.
//
// Columns are padded to a common width because that is what the existing hand-written tables do and
// a generator that reflowed all fifty of them would bury its own first diff in noise.
func (s Spec) RenderDocsTable() string {
	rows := append([][]string{DocsHeader}, s.DocsRows()...)
	widths := make([]int, len(DocsHeader))
	for _, r := range rows {
		for i, cell := range r {
			if n := len([]rune(cell)); n > widths[i] {
				widths[i] = n
			}
		}
	}
	var b strings.Builder
	writeRow := func(cells []string) {
		b.WriteString("|")
		for i, cell := range cells {
			fmt.Fprintf(&b, " %-*s |", widths[i], cell)
		}
		b.WriteString("\n")
	}
	writeRow(DocsHeader)
	b.WriteString("|")
	for _, w := range widths {
		b.WriteString(" " + strings.Repeat("-", w) + " |")
	}
	b.WriteString("\n")
	for _, r := range s.DocsRows() {
		writeRow(r)
	}
	return b.String()
}

// ManifestKeys is the fourth rendering: the field keys as they appear in `alethia.yaml`.
//
// Returned sorted by KEY PATH rather than in spec order, because this one is read as a file layout
// and not as a sequence of questions — the manifest's shape is what a person edits, and a dotted
// namespace that jumps around is harder to scan than an alphabetised one.
//
// The reader that consumes these is #3662's (`apps/cli/pkg/manifest`). Declaring the keys here and
// now is deliberate: it is the half that has to agree with the flags, and leaving it for the lane
// that writes the reader is how the fifth spelling of a field name gets invented.
func (s Spec) ManifestKeys() map[string]Field {
	out := map[string]Field{}
	for _, f := range s.Fields {
		if f.ManifestKey == "" {
			continue
		}
		out[f.ManifestKey] = f
	}
	return out
}

// ManifestKeyPaths is every manifest key this spec declares, sorted.
func (s Spec) ManifestKeyPaths() []string {
	keys := s.ManifestKeys()
	out := make([]string, 0, len(keys))
	for k := range keys {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
