// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"math"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
)

// jobsPaginatedModel is the interactive Bubble Tea view for `jobs list` on a TTY:
// it pages through jobs by re-querying the API on n/p. This is irreducible TUI
// glue (excluded from the logic-coverage badge); the data projection it renders
// (jobRowsPlain) and the non-interactive renderJobs path live in jobs_list.go and
// are unit-tested.
type jobsPaginatedModel struct {
	ui.PaginatedTableModel
	apiClient *api.Client
	pageSize  int
	status    string
}

func (m jobsPaginatedModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case ui.PageChangedMsg:
		return m, m.fetchPage(msg.Page)
	}
	updated, cmd := m.PaginatedTableModel.Update(msg)
	m.PaginatedTableModel = updated.(ui.PaginatedTableModel)
	return m, cmd
}

func (m jobsPaginatedModel) fetchPage(page int) tea.Cmd {
	return func() tea.Msg {
		offset := (page - 1) * m.pageSize
		result, err := m.apiClient.GetJobs(m.status, m.pageSize, offset)
		if err != nil {
			return nil
		}
		totalPages := int(math.Ceil(float64(result.Total) / float64(m.pageSize)))
		if totalPages < 1 {
			totalPages = 1
		}
		return ui.PageDataMsg{
			Rows:       jobRows(result.Jobs),
			Total:      result.Total,
			Page:       page,
			TotalPages: totalPages,
		}
	}
}

func jobColumns() []table.Column {
	return []table.Column{
		{Title: "Type", Width: 16},
		{Title: "Status", Width: 12},
		{Title: "Project", Width: 18},
		{Title: "Runner", Width: 16},
		{Title: "Created", Width: 16},
		{Title: "Duration", Width: 10},
	}
}

// jobRows projects jobs into Bubble Tea table rows (TUI path).
func jobRows(jobs []api.ProvisionJob) []table.Row {
	plain := jobRowsPlain(jobs, ui.FormatTable)
	rows := make([]table.Row, len(plain))
	for i, r := range plain {
		rows[i] = table.Row(r)
	}
	return rows
}
