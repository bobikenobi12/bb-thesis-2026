// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/spf13/cobra"
)

var jobsGetSelector jobSelector

var jobsGetCmd = &cobra.Command{
	Use:   "get [job_id]",
	Short: "Get details of a specific job",
	Long: `Show one job: type, status, runner, timestamps, the verify verdict and the cost estimate.

The id is optional. Without it, ` + "`--latest`" + ` takes the most recent matching job and a
terminal gets a picker — so nothing has to be copied out of another command's output.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		ref, err := resolveJob(apiClient, args, jobsGetSelector)
		if err != nil {
			fail(err)
		}

		var job *api.ProvisionJob

		runSpinner("Fetching job details...", func() {
			job, err = apiClient.GetJob(ref.ID)
		})

		if err != nil {
			failf("Failed to fetch job: %v", err)
		}

		if err := renderJob(os.Stdout, outputFormat(cmd), job); err != nil {
			fail(err)
		}
	},
}

// renderJob writes a single job to out: a bordered KV card for the table format,
// the typed object for json, Field/Value rows for csv.
// The format parameter is spelled `outFormat` here and in renderJobs: `format` is now the
// imported shared formatter package, and a parameter of that name would shadow it inside the
// only functions that render a job.
func renderJob(out io.Writer, outFormat string, job *api.ProvisionJob) error {
	return ui.RenderCard(out, outFormat, "Job "+job.ID, jobFieldRows(job), job)
}

// jobStamp renders one of a job's absolute timestamps.
//
// `packages/core/format` rather than a local layout string: this card printed
// `2026-03-09 15:04:05` while the console printed `9 Mar 2026, 15:04` for the same instant, which
// is the "two implementations of one product" the CLI programme exists to end. The zone is UTC
// and not the host's, so two people reading the same job read the same time.
func jobStamp(t time.Time) string {
	return format.Date(t, format.DateTime, time.UTC)
}

// jobFieldRows returns the present-only key/value fields of a job.
func jobFieldRows(job *api.ProvisionJob) [][]string {
	rows := [][]string{
		{"ID", job.ID},
		{"Type", job.JobType},
		{"Status", job.Status},
		{"Created", jobStamp(job.CreatedAt)},
	}
	if job.Provider != "" {
		rows = append(rows, []string{"Provider", job.Provider})
	}
	if job.StartedAt != nil {
		rows = append(rows, []string{"Started", jobStamp(*job.StartedAt)})
	}
	if job.CompletedAt != nil {
		rows = append(rows, []string{"Completed", jobStamp(*job.CompletedAt)})
	}
	if job.StartedAt != nil {
		rows = append(rows, []string{"Duration", formatDuration(job.StartedAt, job.CompletedAt)})
	}
	if job.ProjectID != "" {
		rows = append(rows, []string{"Project ID", job.ProjectID})
	}
	if job.RunnerID != "" {
		rows = append(rows, []string{"Runner ID", job.RunnerID})
	}
	if job.PlanJobID != "" {
		rows = append(rows, []string{"Plan Job ID", job.PlanJobID})
	}
	if v := verifySummary(job.ExecutionMetadata); v != "" {
		rows = append(rows, []string{"Verify", v})
	}
	if c := jobCostSummary(job.ExecutionMetadata); c != "" {
		rows = append(rows, []string{"Cost estimate", c})
	}
	if job.ErrorMessage != nil && *job.ErrorMessage != "" {
		rows = append(rows, []string{"Error", *job.ErrorMessage})
	}
	return rows
}

// verifySummary renders the elench verify gate result (attached to a job's
// execution_metadata as "verify_result") as a compact "verdict (n fail, n pass…)"
// line. Returns "" when the job carries no verify report.
func verifySummary(meta *map[string]interface{}) string {
	if meta == nil {
		return ""
	}
	raw, ok := (*meta)["verify_result"]
	if !ok {
		return ""
	}
	vr, ok := raw.(map[string]interface{})
	if !ok {
		return ""
	}
	verdict, _ := vr["verdict"].(string)
	if verdict == "" {
		return ""
	}
	var parts []string
	if s, ok := vr["summary"].(map[string]interface{}); ok {
		add := func(label, key string) {
			if n, ok := s[key].(float64); ok && n > 0 {
				parts = append(parts, fmt.Sprintf("%d %s", int(n), label))
			}
		}
		add("fail", "fail")
		add("pass", "pass")
		add("warn", "warn")
		add("n/a", "not_evaluable")
	}
	if len(parts) > 0 {
		return fmt.Sprintf("%s (%s)", verdict, strings.Join(parts, ", "))
	}
	return verdict
}

// jobCostSummary renders the Infracost breakdown a PLAN or DEPLOY job attaches to its
// execution_metadata as "cost_breakdown", as a monthly rate: "$124.56/mo (12 priced, 3 free)".
//
// This is the fix for the one line in the jobs group that was not a render at all. `--wait`
// printed `fmt.Printf("  Cost estimate: %v\n", costBreakdown)` over the decoded `any` — so the
// last thing a successful `project apply --wait` said to an operator was a Go map literal:
//
//	Cost estimate: map[currency:USD projects:[map[breakdown:map[resources:[map[...
//
// The amount comes from summary.total_monthly (a number) in preference to totalMonthlyCost (a
// decimal STRING), because the string is what Infracost printed and the number is what it meant.
// It is rendered through `packages/core/format.MonthlyRate` in Estimate style: this is a
// projection, so a sub-unit total reads `<$1/mo` rather than a rounded `$0.00/mo` that looks free.
//
// A non-object value is returned as-is after trimming. The wire shape is an object today, but a
// scalar is information a person can read, and dropping it would be a worse answer than passing
// it through.
func jobCostSummary(meta *map[string]interface{}) string {
	if meta == nil {
		return ""
	}
	raw, ok := (*meta)["cost_breakdown"]
	if !ok || raw == nil {
		return ""
	}
	cb, ok := raw.(map[string]interface{})
	if !ok {
		if s, ok := raw.(string); ok {
			return strings.TrimSpace(s)
		}
		return ""
	}

	currency, _ := cb["currency"].(string)
	if currency == "" {
		currency = "USD"
	}

	amount, ok := costMonthlyTotal(cb)
	if !ok {
		return ""
	}
	out := format.MonthlyRate(amount, format.Estimate, currency)

	if s, ok := cb["summary"].(map[string]interface{}); ok {
		var parts []string
		if n, ok := s["resources_with_cost"].(float64); ok && n > 0 {
			parts = append(parts, fmt.Sprintf("%d priced", int(n)))
		}
		if n, ok := s["resources_free"].(float64); ok && n > 0 {
			parts = append(parts, fmt.Sprintf("%d free", int(n)))
		}
		if len(parts) > 0 {
			out += " (" + strings.Join(parts, ", ") + ")"
		}
	}
	return out
}

// costMonthlyTotal pulls the monthly total out of a decoded cost_breakdown, preferring the
// numeric summary over the decimal string Infracost renders. Reports false when neither is
// present or parsable, so the caller can say nothing rather than say zero — a breakdown we
// cannot read is not a project that costs nothing.
func costMonthlyTotal(cb map[string]interface{}) (float64, bool) {
	if s, ok := cb["summary"].(map[string]interface{}); ok {
		if v, ok := s["total_monthly"].(float64); ok {
			return v, true
		}
	}
	if s, ok := cb["totalMonthlyCost"].(string); ok {
		if v, err := strconv.ParseFloat(strings.TrimSpace(s), 64); err == nil {
			return v, true
		}
	}
	if v, ok := cb["totalMonthlyCost"].(float64); ok {
		return v, true
	}
	return 0, false
}

func init() {
	addJobSelectorFlags(jobsGetCmd, &jobsGetSelector)
	jobsCmd.AddCommand(jobsGetCmd)
}
