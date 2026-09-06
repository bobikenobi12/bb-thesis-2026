// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"fmt"
	"io"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

var cardBorderStyle = lipgloss.NewStyle().
	Border(lipgloss.RoundedBorder()).
	BorderForeground(InkMuted).
	Padding(0, 2)

// RenderCard renders a single record as a bordered grayscale key/value "card"
// for the table format — the polished counterpart to the list tables. json emits
// the typed record; csv emits Field/Value rows. This keeps single-record views
// (whoami, config, job get) at the same visual level as the list tables.
func RenderCard(out io.Writer, format, title string, rows [][]string, record any) error {
	switch format {
	case FormatJSON:
		return Render(out, format, TableSpec{}, record)
	case FormatCSV:
		return Render(out, format, TableSpec{Columns: []string{"Field", "Value"}, Rows: rows}, record)
	}

	keyW := 0
	for _, r := range rows {
		if len(r) > 0 && lipgloss.Width(r[0]) > keyW {
			keyW = lipgloss.Width(r[0])
		}
	}

	var b strings.Builder
	if title != "" {
		b.WriteString(Eyebrow(title))
		b.WriteString("\n\n")
	}
	for i, r := range rows {
		if len(r) < 2 {
			continue
		}
		b.WriteString(MutedStyle.Render(padCell(r[0], keyW)))
		b.WriteString("  ")
		b.WriteString(ValueStyle.Render(r[1]))
		if i < len(rows)-1 {
			b.WriteByte('\n')
		}
	}
	// Returned rather than swallowed, matching renderStaticTable and the json and
	// csv branches above. A card's whole job is to carry a value a reader is about
	// to act on — `alethia token create` prints the token's id and prefix through
	// here — so a failed write must not read as a successfully rendered empty card.
	_, err := fmt.Fprintln(out, cardBorderStyle.Render(b.String()))
	return err
}
