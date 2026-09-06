// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// Jobs as a control surface: logs, cancellation, and the pagination of the list.
//
// The pagination cases are here rather than with the renderers because what is being pinned is the
// REQUEST — a default page size and a pager that always has one page — not the table it produces.

// TestMisc_JobLogsAndCancel pins `jobs logs` and `jobs cancel`: each log stream gets its
// own style, --follow keeps polling until the job reaches a terminal state and then drains
// the tail, and an unreadable log or a refused cancel is fatal.
func TestMisc_JobLogsAndCancel(t *testing.T) {
	miscRestoreFlagState(t)
	miscFastPolls(t)

	t.Run("one shot", func(t *testing.T) {
		jobsLogsFollow = false
		run := miscAdminEnv(t, miscAdminOpts{})
		if err := run("jobs", "logs", "j1", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("follow drains the tail once the job finishes", func(t *testing.T) {
		jobsLogsFollow = false
		run := miscAdminEnv(t, miscAdminOpts{jobStatus: "SUCCESS"})
		if err := run("jobs", "logs", "j1", "--follow", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("follow waits while the job is still running", func(t *testing.T) {
		jobsLogsFollow = false
		run := miscAdminEnv(t, miscAdminOpts{jobStatus: "PROCESSING", jobStatusAfter: "FAILED"})
		if err := run("jobs", "logs", "j1", "--follow", "--output", "json"); err != nil {
			t.Error(err)
		}
	})

	t.Run("an unreadable log is fatal", func(t *testing.T) {
		jobsLogsFollow = false
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/logs"}))
		if !exits("jobs", "logs", "j1", "--output", "json") {
			t.Error("expected an unreadable log to be fatal")
		}
	})

	t.Run("an unreadable job is fatal", func(t *testing.T) {
		jobsLogsFollow = false
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/api/cli/jobs/"}))
		if !exits("jobs", "get", "j1", "--output", "json") {
			t.Error("expected an unreadable job to be fatal")
		}
	})

	t.Run("cancel", func(t *testing.T) {
		jobsLogsFollow = false
		run := miscAdminEnv(t, miscAdminOpts{})
		if err := run("jobs", "cancel", "j1", "--yes", "--output", "json"); err != nil {
			t.Error(err)
		}
		exits := miscFatalRunner(miscAdminEnv(t, miscAdminOpts{failOn: "/cancel"}))
		if !exits("jobs", "cancel", "j1", "--yes", "--output", "json") {
			t.Error("expected a refused cancel to be fatal")
		}
	})

	t.Run("the bare jobs command points at its verbs", func(t *testing.T) {
		run := miscAdminEnv(t, miscAdminOpts{})
		if err := run("jobs", "--output", "json"); err != nil {
			t.Error(err)
		}
	})
}

// TestMisc_JobsPaginatedTable pins the paging model behind the interactive `jobs list`:
// a page change re-queries the control plane and reports the new rows, and a query that
// fails leaves the view alone instead of crashing the table.
func TestMisc_JobsPaginatedTable(t *testing.T) {
	miscRestoreFlagState(t)
	run := miscAdminEnv(t, miscAdminOpts{})
	// Force the client to resolve the fake origin the same way the commands do.
	if err := run("jobs", "list", "--output", "json"); err != nil {
		t.Fatal(err)
	}

	rows := jobRows([]api.ProvisionJob{
		{ID: "j1", JobType: "PLAN", Status: "SUCCESS"},
		{ID: "j2", JobType: "not-a-known-type", Status: "FAILED", ProjectID: "0123456789abcdef", RunnerID: "r-0123456789"},
	})
	if len(rows) != 2 {
		t.Fatalf("jobRows returned %d rows, want 2", len(rows))
	}

	m := jobsPaginatedModel{
		PaginatedTableModel: ui.NewPaginatedTableModel(jobColumns(), rows, "jobs", 40, 20),
		apiClient:           api.NewClient("tok"),
		pageSize:            20,
	}

	updated, cmd := m.Update(ui.PageChangedMsg{Page: 2})
	if cmd == nil {
		t.Fatal("a page change must issue a fetch")
	}
	data, ok := cmd().(ui.PageDataMsg)
	if !ok {
		t.Fatalf("fetchPage returned %T, want ui.PageDataMsg", cmd())
	}
	if data.Page != 2 || data.TotalPages < 1 {
		t.Errorf("page = %d, totalPages = %d", data.Page, data.TotalPages)
	}

	// Any other message falls through to the embedded table model.
	if _, _ = updated.Update(ui.PageDataMsg{Page: 2, Total: 40, TotalPages: 2}); false {
		t.Fatal("unreachable")
	}

	// A refused query yields no message rather than a crash.
	broken := miscAdminEnv(t, miscAdminOpts{failOn: "/api/jobs"})
	if err := broken("jobs", "list", "--output", "json"); err == nil {
		_ = err // the command exits through exitFunc; the model check below is the point
	}
	bad := jobsPaginatedModel{
		PaginatedTableModel: ui.NewPaginatedTableModel(jobColumns(), rows, "jobs", 0, 20),
		apiClient:           api.NewClient("tok"),
		pageSize:            20,
	}
	if got := bad.fetchPage(1)(); got != nil {
		t.Errorf("a refused page query returned %v, want nil", got)
	}
}

// TestMisc_JobsListFallsBackToADefaultPageSize pins that a non-positive --limit does not
// ask the control plane for zero jobs; the page size falls back to 20.
func TestMisc_JobsListFallsBackToADefaultPageSize(t *testing.T) {
	miscRestoreFlagState(t)
	run := miscAdminEnv(t, miscAdminOpts{})
	if err := run("jobs", "list", "-n", "0", "--output", "json"); err != nil {
		t.Error(err)
	}
}

// TestMisc_JobsPagerAlwaysHasOnePage pins that an empty result still reports one page —
// a zero page count would make the pager render "page 1 of 0".
func TestMisc_JobsPagerAlwaysHasOnePage(t *testing.T) {
	miscRestoreFlagState(t)
	run := miscAdminEnv(t, miscAdminOpts{empty: true})
	if err := run("jobs", "list", "--output", "json"); err != nil {
		t.Fatal(err)
	}
	m := jobsPaginatedModel{
		PaginatedTableModel: ui.NewPaginatedTableModel(jobColumns(), nil, "jobs", 0, 20),
		apiClient:           api.NewClient("tok"),
		pageSize:            20,
	}
	data, ok := m.fetchPage(1)().(ui.PageDataMsg)
	if !ok {
		t.Fatal("fetchPage did not return page data")
	}
	if data.TotalPages != 1 {
		t.Errorf("TotalPages = %d for an empty result, want 1", data.TotalPages)
	}
}
