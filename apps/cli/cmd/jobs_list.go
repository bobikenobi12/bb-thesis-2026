// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"
)

var jobListColumns = []string{"Type", "Status", "Project", "Runner", "Created", "Duration"}

var (
	jobsListStatus string
	jobsListLimit  int
)

// jobTypeLabels maps every provision_job_type to a friendly table label. Keyed by the
// generated types.JobType constants so a removed enum value is a compile error here; a
// test (TestJobTypeLabels_CoverAllJobTypes) asserts every job type has a label, so an
// added one fails the build.
var jobTypeLabels = map[string]string{
	string(types.JobTypePlan):          "Plan",
	string(types.JobTypeDeploy):        "Deploy",
	string(types.JobTypeDestroy):       "Destroy",
	string(types.JobTypeAnalyzeRepo):   "Analyze Repo",
	string(types.JobTypeDetectDrift):   "Detect Drift",
	string(types.JobTypeAudit):         "Audit",
	string(types.JobTypeDeployRunner):  "Deploy Runner",
	string(types.JobTypeUpdateRunner):  "Update Runner",
	string(types.JobTypeDestroyRunner): "Destroy Runner",
	string(types.JobTypeChartScan):     "Chart Scan",
	string(types.JobTypeIacScan):       "IaC Scan",
	string(types.JobTypeStateSurgery):  "State Surgery",
	string(types.JobTypeProbeCluster):  "Probe Cluster",
	string(types.JobTypeBuild):         "Build",
}

var jobsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all provisioning jobs",
	Run: func(cmd *cobra.Command, args []string) {
		// Validated against the generated enum before the request. The server answers a
		// misspelled status with an empty page, which reads as "you have no jobs" rather than
		// "you typed PROCESSNG" — and no job can carry a status outside the enum, so refusing
		// one here can never hide a job that exists.
		if jobsListStatus != "" && !containsFold(jobStatusValues(), jobsListStatus) {
			failf("invalid --status %q (want one of: %s)", jobsListStatus, strings.Join(jobStatusValues(), ", "))
		}
		// Upper-cased for the wire. The column is a Postgres enum compared as text, so `success`
		// would match no row — accepting a spelling and then sending it verbatim would turn a
		// friendly flag into a silent empty page.
		status := strings.ToUpper(jobsListStatus)

		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		pageSize := jobsListLimit
		if pageSize <= 0 {
			pageSize = 20
		}

		var page *api.JobsPage

		runSpinner("Fetching jobs...", func() {
			page, err = apiClient.GetJobs(status, pageSize, 0)
		})

		if err != nil {
			failf("Failed to fetch jobs: %v", err)
		}

		if !interactiveTable(cmd) {
			if err := renderJobs(os.Stdout, outputFormat(cmd), page.Jobs); err != nil {
				fail(err)
			}
			return
		}

		if page.Total == 0 {
			ui.Muted("No jobs found.")
			return
		}

		columns := jobColumns()
		rows := jobRows(page.Jobs)

		m := ui.NewPaginatedTableModel(columns, rows, "jobs", page.Total, pageSize)

		p := tea.NewProgram(jobsPaginatedModel{
			PaginatedTableModel: m,
			apiClient:           apiClient,
			pageSize:            pageSize,
			status:              status,
		})
		if _, err := p.Run(); err != nil {
			failf("Table error: %v", err)
		}
	},
}

// renderJobs writes a page of jobs to out in the requested format. Pagination is
// interactive-only; non-interactive output returns up to --limit jobs.
func renderJobs(out io.Writer, outFormat string, jobs []api.ProvisionJob) error {
	if len(jobs) == 0 && outFormat == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No jobs found."))
		return nil
	}
	return ui.Render(out, outFormat, ui.TableSpec{
		Columns: jobListColumns,
		Rows:    jobRowsPlain(jobs, outFormat),
	}, jobs)
}

// jobRowsPlain projects each job into a plain table row.
func jobRowsPlain(jobs []api.ProvisionJob, outFmt string) [][]string {
	rows := make([][]string, len(jobs))
	for i, j := range jobs {
		typeLabel := jobTypeLabels[j.JobType]
		if typeLabel == "" {
			typeLabel = j.JobType
		}

		project := j.ProjectName
		if project == "" && j.ProjectID != "" {
			project = ui.TruncID(j.ProjectID)
		}
		if project == "" {
			project = ui.SymbolDash
		}

		runner := j.RunnerName
		if runner == "" && j.RunnerID != "" {
			runner = ui.TruncID(j.RunnerID)
		}
		if runner == "" {
			runner = ui.SymbolDash
		}

		rows[i] = []string{
			typeLabel,
			j.Status,
			project,
			runner,
			ui.Cell(outFmt, wireTime(j.CreatedAt), ui.SmartTime(j.CreatedAt)),
			formatDuration(j.StartedAt, j.CompletedAt),
		}
	}
	return rows
}

// formatDuration renders how long a job ran, with "…" while it is still running.
//
// The elapsed rule itself is `packages/core/format.Duration` and no longer lives here. It was
// the last hand-written copy of it in the CLI, and it is the rule the epic ruled ON: a job that
// takes two hours reads `2h 5m`, not `125m 5s`, on BOTH surfaces. What stays local is the part
// that is genuinely this command's — the dash for a job that never started, and the ellipsis
// that says the number is still climbing. `apps/cli/pkg/utils/ui/render.go` records why this
// function was left out of the render hoist: its rule was about to be replaced wholesale, and
// this is that replacement.
func formatDuration(started, completed *time.Time) string {
	if started == nil {
		return ui.SymbolDash
	}
	end := time.Now()
	suffix := "…"
	if completed != nil {
		end = *completed
		suffix = ""
	}
	return format.Duration(end.Sub(*started)) + suffix
}

func init() {
	jobsCmd.AddCommand(jobsListCmd)
	// The status vocabulary is read from the generated enum, not typed here. The literal list
	// this replaced was already a hand-maintained copy of provision_job_status, and a hand-typed
	// list of a generated set is a list that stops covering it silently.
	jobsListCmd.Flags().StringVar(&jobsListStatus, "status", "",
		"Filter by status ("+strings.Join(jobStatusValues(), ", ")+")")
	jobsListCmd.Flags().IntVarP(&jobsListLimit, "limit", "n", 20, "Jobs per page")
}
