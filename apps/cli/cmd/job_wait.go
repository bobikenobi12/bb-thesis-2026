// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// jobPollInterval is how often `--wait` polls a job's status. It is a variable so a
// test can shorten it; nothing in production assigns to it, so the interval is the
// same 3 seconds it always was.
var jobPollInterval = 3 * time.Second

func waitForJob(apiClient *api.Client, jobID string) error {
	fmt.Printf("\n%s Waiting for job %s...\n", ui.MutedStyle.Render(ui.SymbolPoint), jobID)

	lastStatus := ""
	for {
		job, err := apiClient.GetJob(jobID)
		if err != nil {
			return fmt.Errorf("failed to poll job status: %w", err)
		}

		if job.Status != lastStatus {
			lastStatus = job.Status
			fmt.Printf("  Status: %s\n", ui.StatusVerbatim(job.Status))
		}

		switch job.Status {
		case "SUCCESS":
			ui.Success("Job completed successfully")
			// Through jobCostSummary (jobs_get.go), the same renderer the job card uses. This line
			// used to be `fmt.Printf("  Cost estimate: %v\n", costBreakdown)` over the decoded
			// `any`, so the last thing a successful `project apply --wait` said was a Go map
			// literal several hundred characters long.
			if c := jobCostSummary(job.ExecutionMetadata); c != "" {
				fmt.Printf("  Cost estimate: %s\n", c)
			}
			return nil
		case "FAILED":
			errMsg := "unknown error"
			if job.ErrorMessage != nil {
				errMsg = *job.ErrorMessage
			}
			ui.Error(fmt.Sprintf("Job failed: %s", errMsg))
			return fmt.Errorf("job failed: %s", errMsg)
		case "CANCELLED":
			ui.Error("Job was cancelled")
			return fmt.Errorf("job was cancelled")
		}

		time.Sleep(jobPollInterval)
	}
}

// formatJobStatus is DELETED. It was the third status renderer — a switch over five job statuses
// that returned the status TEXT in one of five lipgloss styles and drew no glyph at all. Three of
// those styles (SuccessStyle, ErrorStyle, CyanStyle) are the same bold strong ink in a grayscale
// palette, so `job wait` printed SUCCESS and FAILED identically and `jobs logs --follow` closed
// with a line that said nothing a reader could act on. ui.Status renders the glyph and the word
// in the tier's ink, over the generated vocabulary, and every command says it the same way.
