// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package table provides the reusable inline cursor-paged table used by CLI list commands.
package table

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/ui/theme"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	bubblesTable "github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

var borderStyle = lipgloss.NewStyle().BorderStyle(theme.BorderRounded).BorderForeground(theme.InkMuted)

// Page is one fetched page and its cursor metadata.
type Page struct {
	Rows []bubblesTable.Row
	Info api.PageInfo
}

// FetchPage is the adapter used to retrieve one page by opaque cursor.
type FetchPage func(cursor string) (Page, error)

// PageDataMsg delivers a successful fetch to Model. Commands normally create it internally;
// it is exported so callers can drive the module through Bubble Tea test messages.
type PageDataMsg struct {
	Page Page
}

// PageErrMsg delivers a failed fetch to Model.
type PageErrMsg struct {
	Err error
}

// Model is an inline cursor-paged table. It owns cursor history, loading/error transitions,
// keyboard affordances, and the truthful footer; callers only provide pages and a fetch adapter.
type Model struct {
	table    bubblesTable.Model
	columns  []bubblesTable.Column
	rows     []bubblesTable.Row
	entity   string
	fetch    FetchPage
	cursors  []string
	page     int
	info     api.PageInfo
	loading  bool
	err      error
	quitting bool
}

// New constructs an inline table whose initial page is already available.
func New(columns []bubblesTable.Column, initial Page, entity string, fetch FetchPage) Model {
	m := Model{
		columns: columns,
		rows:    cloneRows(initial.Rows),
		entity:  entity,
		fetch:   fetch,
		cursors: []string{""},
		page:    1,
		info:    initial.Info,
	}
	m.table = newTable(columns, m.markedRows())
	return m
}

// Init implements tea.Model without entering the alternate screen.
func (m Model) Init() tea.Cmd { return nil }

// Update implements cursor navigation, retry, loading/error messages, and row focus.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch value := msg.(type) {
	case tea.KeyMsg:
		switch value.String() {
		case "q", "ctrl+c":
			m.quitting = true
			return m, tea.Quit
		case "n":
			if !m.loading && m.err == nil && m.info.HasMore() {
				m.cursors = append(m.cursors, m.info.NextCursor)
				m.page++
				m.loading = true
				return m, m.fetchPage(m.info.NextCursor)
			}
		case "p":
			if !m.loading && m.err == nil && len(m.cursors) > 1 {
				m.cursors = m.cursors[:len(m.cursors)-1]
				m.page--
				m.loading = true
				return m, m.fetchPage(m.cursors[len(m.cursors)-1])
			}
		case "r":
			if m.err != nil && !m.loading {
				m.loading = true
				return m, m.fetchPage(m.cursors[len(m.cursors)-1])
			}
		}
	case PageDataMsg:
		m.loading = false
		m.err = nil
		m.rows = cloneRows(value.Page.Rows)
		m.info = value.Page.Info
		m.table.SetRows(m.markedRows())
		return m, nil
	case PageErrMsg:
		m.loading = false
		m.err = value.Err
		return m, nil
	}

	var cmd tea.Cmd
	m.table, cmd = m.table.Update(msg)
	m.table.SetRows(m.markedRows())
	return m, cmd
}

// View renders the table and footer inline in normal terminal scrollback.
func (m Model) View() string {
	if m.quitting {
		return ""
	}
	footer := m.footer()
	return "\n" + borderStyle.Render(m.table.View()) + "\n" + footer + "\n"
}

// fetchPage adapts the caller's fetcher into a Bubble Tea message command.
func (m Model) fetchPage(cursor string) tea.Cmd {
	return func() tea.Msg {
		page, err := m.fetch(cursor)
		if err != nil {
			return PageErrMsg{Err: err}
		}
		return PageDataMsg{Page: page}
	}
}

// footer states the known count and legal key hints without inventing a denominator.
func (m Model) footer() string {
	if m.loading {
		return "  Loading…"
	}
	if m.err != nil {
		return fmt.Sprintf("  Error: %v · r: retry · q: quit", m.err)
	}
	count := fmt.Sprintf("%d", m.info.Total)
	if m.info.IsCapped() {
		count += "+"
	}
	footer := fmt.Sprintf("  %s %s", count, m.entity)
	if m.page > 1 || m.info.HasMore() {
		footer += fmt.Sprintf(" · page %d", m.page)
	}
	if m.info.HasMore() {
		footer += " · n: next"
	}
	if len(m.cursors) > 1 {
		footer += " · p: previous"
	}
	return footer + " · q: quit · ↑↓/jk: navigate"
}

// markedRows adds a grayscale-safe bracket focus marker around the selected row.
func (m Model) markedRows() []bubblesTable.Row {
	rows := cloneRows(m.rows)
	selected := m.table.Cursor()
	for index := range rows {
		if index == selected {
			if len(rows[index]) > 0 {
				rows[index][0] = "[ " + rows[index][0]
				rows[index][len(rows[index])-1] += " ]"
			}
		}
	}
	return rows
}

// newTable builds the shared Bubble Tea table treatment for all callers.
func newTable(columns []bubblesTable.Column, rows []bubblesTable.Row) bubblesTable.Model {
	height := len(rows) + 1
	if height > 20 {
		height = 20
	}
	model := bubblesTable.New(
		bubblesTable.WithColumns(columns),
		bubblesTable.WithRows(rows),
		bubblesTable.WithFocused(true),
		bubblesTable.WithHeight(height),
	)
	styles := bubblesTable.DefaultStyles()
	styles.Header = styles.Header.Foreground(theme.InkMuted).Bold(true)
	styles.Selected = lipgloss.NewStyle().Foreground(theme.InkPrimary).Bold(true)
	model.SetStyles(styles)
	return model
}

// cloneRows prevents the module from mutating a caller-owned page.
func cloneRows(rows []bubblesTable.Row) []bubblesTable.Row {
	clone := make([]bubblesTable.Row, len(rows))
	for index, row := range rows {
		clone[index] = append(bubblesTable.Row(nil), row...)
	}
	return clone
}
