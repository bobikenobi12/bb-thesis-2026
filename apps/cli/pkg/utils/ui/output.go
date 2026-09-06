// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// Output formats accepted by the global --output flag.
const (
	FormatTable = "table"
	FormatJSON  = "json"
	FormatCSV   = "csv"
)

// validFormats is the accepted --output set as DATA rather than as switch arms, so that
// ValidFormat and the test that pins HumanReadable range over the same one thing.
//
// A switch cannot be enumerated. While this was a switch, a test asking "every format this file
// accepts" had to re-type the list and could then only filter its own guesses through
// ValidFormat — so a fourth format whose spelling was not already guessed left the test green,
// which is precisely the decay the test was written to prevent.
var validFormats = []string{FormatTable, FormatJSON, FormatCSV}

// ValidFormat reports whether s is a supported --output value.
func ValidFormat(s string) bool {
	return slices.Contains(validFormats, s)
}

// HumanReadable reports whether outFmt is a format a PERSON reads, so a row builder knows whether
// to humanise a cell at all. See Render's doc for the rule this asks about.
//
// Phrased as "is this for a person" and not "is this csv" on purpose: the answer a builder needs
// is about the READER, and a fourth format added to this file gets the human default rather than
// silently inheriting csv's raw one.
func HumanReadable(outFmt string) bool {
	return outFmt != FormatCSV
}

// TableSpec is the columnar projection of a result set: header titles plus the
// matching plain-string cells per row (no ANSI — widths must compute correctly).
type TableSpec struct {
	Columns []string
	Rows    [][]string
}

var tableHeaderTextStyle = lipgloss.NewStyle().Foreground(InkMuted).Bold(true)

// Render writes a result set to out in the requested format. `table` renders a
// static grayscale table (pipe- and test-safe — unlike the interactive Bubble Tea
// tables used for TTY browsing); `json` marshals the typed records so consumers
// get whole objects, not just table cells; `csv` writes RFC-4180 rows. An empty
// format defaults to table; an unknown format is an error.
//
// ── THE HOUSE RULE FOR spec.Rows, AND WHY IT IS STATED HERE ─────────────────────
//
// CSV CARRIES THE WIRE VALUE. The branch below writes spec.Rows VERBATIM, so every
// display decision a row builder makes reaches a script: a date becomes
// `9 Mar 2026, 15:04`, which no longer sorts or parses and has dropped the seconds
// and the zone; an absent optional becomes `—` (U+2014), which a reader has to
// special-case where an empty cell already means absent; an amount becomes
// `$1,234.56/mo`, which stops parsing as a float. `-o json` is unaffected either
// way — it marshals `records` and never looks at spec.Rows.
//
// So a row builder whose cells read differently for a machine TAKES outFmt and
// decides here, where the format is known, rather than inside a formatter that
// cannot see it: cost.go's costRows, verify_receipt.go's receiptRows,
// staged.go's stagedRows, chart.go's chartRows and usage.go's usageRows all do,
// and config.go dashes inside its table branch alone. HumanReadable below is the
// question they ask.
//
// It is already the DOCUMENTED contract for one command:
// `apps/docs/content/docs/cli/configuration.mdx` says an unset key "prints as `—`
// in the table and as an empty string under `-o json` and `-o csv`. The dash is
// for a person reading a column; a script tests the machine formats for
// emptiness." That is this rule, and it was true of `config get` alone.
//
// The rule lives on Render and not in each of those files because it was enforced
// three times on whichever PR a reviewer happened to open — #3736 shipped a
// humanised cell into a shared row builder and was corrected for exactly this —
// and a rule re-derived per review is a rule that holds wherever review looked.
// Not every builder is converted, and the list below is the set that was MEASURED, not a closed
// one — naming a remainder as though it were exhaustive is the same failure mode as the
// per-review enforcement this paragraph replaces, so check the builder you are editing.
//
// Time formatters still humanising unconditionally: RelativeTime in activity.go,
// connector_list.go and runner_list.go, SmartTime in project_list.go, StampOrDash in token.go.
// Separately and more widely, the OrDash/StrOrDash/SymbolDash family substitutes U+2014 into
// rows that reach the CSV branch unconditionally in a dozen more files — addon.go,
// project_env.go, cloud.go, jobs_list.go, grants.go, clusters_list.go, probes.go, repo.go,
// fleet.go, promotion.go, project_component.go and classification.go among them.
func Render(out io.Writer, format string, spec TableSpec, records any) error {
	switch format {
	case "", FormatTable:
		return renderStaticTable(out, spec)
	case FormatJSON:
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(records)
	case FormatCSV:
		w := csv.NewWriter(out)
		if len(spec.Columns) > 0 {
			if err := w.Write(spec.Columns); err != nil {
				return err
			}
		}
		for _, row := range spec.Rows {
			if err := w.Write(row); err != nil {
				return err
			}
		}
		w.Flush()
		return w.Error()
	default:
		return fmt.Errorf("unknown output format %q (want table, json, or csv)", format)
	}
}

// MaxColWidth bounds a table cell's displayed width so a long value (a joined
// list, a long name) can't blow the table past the terminal. Display-only —
// json/csv keep the full value.
const MaxColWidth = 40

// Truncate shortens s to at most max display columns, appending an ellipsis when
// it cuts. Width-aware (counts display width, ignores ANSI), so plain cells only.
func Truncate(s string, max int) string {
	if max <= 0 || lipgloss.Width(s) <= max {
		return s
	}
	if max == 1 {
		return "…"
	}
	r := []rune(s)
	// Trim rune-by-rune until the ellipsis fits within max display columns.
	for len(r) > 0 && lipgloss.Width(string(r))+1 > max {
		r = r[:len(r)-1]
	}
	return string(r) + "…"
}

// staticCell prepares a raw value for the static table. Every cursor-moving
// control character (newline, carriage return, tab, vertical tab, form feed,
// backspace) collapses to a space first, so the cell stays on one physical line
// and lipgloss.Width — which reports the widest *line* of a multi-line string —
// measures what the terminal will actually print; only then is the value capped
// to MaxColWidth.
func staticCell(s string) string {
	flat := strings.Map(func(r rune) rune {
		switch r {
		case '\n', '\r', '\t', '\v', '\f', '\b':
			return ' '
		default:
			return r
		}
	}, s)
	return Truncate(flat, MaxColWidth)
}

// renderStaticTable writes a left-aligned, two-space-gutter grayscale table. It
// is intentionally non-interactive so it works in pipes, CI, and tests. Cells are
// flattened to a single line and capped to MaxColWidth, so one row is always one
// output line and a long value never overflows the terminal. A failed write is
// returned rather than swallowed, matching the json and csv branches.
func renderStaticTable(out io.Writer, spec TableSpec) error {
	if len(spec.Columns) == 0 {
		return nil
	}
	widths := make([]int, len(spec.Columns))
	for i, h := range spec.Columns {
		widths[i] = lipgloss.Width(staticCell(h))
	}
	for _, row := range spec.Rows {
		for i, cell := range row {
			if i < len(widths) {
				if w := lipgloss.Width(staticCell(cell)); w > widths[i] {
					widths[i] = w
				}
			}
		}
	}

	var b strings.Builder
	for i, h := range spec.Columns {
		b.WriteString(tableHeaderTextStyle.Render(padCell(staticCell(h), widths[i])))
		if i < len(spec.Columns)-1 {
			b.WriteString("  ")
		}
	}
	if _, err := fmt.Fprintln(out, strings.TrimRight(b.String(), " ")); err != nil {
		return err
	}

	for _, row := range spec.Rows {
		b.Reset()
		for i, cell := range row {
			w := 0
			if i < len(widths) {
				w = widths[i]
			}
			b.WriteString(padCell(staticCell(cell), w))
			if i < len(row)-1 {
				b.WriteString("  ")
			}
		}
		if _, err := fmt.Fprintln(out, strings.TrimRight(b.String(), " ")); err != nil {
			return err
		}
	}
	return nil
}

// padCell right-pads s with spaces to the given display width.
func padCell(s string, w int) string {
	gap := w - lipgloss.Width(s)
	if gap <= 0 {
		return s
	}
	return s + strings.Repeat(" ", gap)
}
