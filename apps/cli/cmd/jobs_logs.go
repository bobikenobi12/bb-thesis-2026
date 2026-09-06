// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	jobsLogsFollow   bool
	jobsLogsSelector jobSelector
)

// jobsLogsPollInterval is how long `--follow` waits between log fetches. It is a
// variable so a test can shorten it; nothing in production assigns to it, so the
// interval is the same 2 seconds it always was.
var jobsLogsPollInterval = 2 * time.Second

// The two log-stream renderings, from the shared styles rather than a lipgloss style built here.
// Byte-identical to what they replaced — ui.StrongStyle IS InkPrimary + bold — but they now move
// with the brand projection instead of pinning a copy of it in this file.
var (
	jobLogStderrStyle = ui.StrongStyle
	jobLogSystemStyle = ui.MutedStyle.Italic(true)
)

var jobsLogsCmd = &cobra.Command{
	Use:   "logs [job_id]",
	Short: "View logs for a job",
	Long: `Stream a job's Runner output — the tofu plan/apply, the resource progress, the errors.

The id is optional. ` + "`alethia jobs logs --latest --follow`" + ` tails the job you just queued
without copying its id out of the previous command; on a terminal, running it bare opens a picker.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		ref, err := resolveJob(apiClient, args, jobsLogsSelector)
		if err != nil {
			fail(err)
		}
		// The CLI chose this job, so it says which one before the output starts. Otherwise a
		// `--latest` tail is a wall of tofu output with nothing identifying whose it is.
		announceResolvedJob(ref, "Tailing")

		lastID := 0
		for {
			logs, err := apiClient.GetJobLogs(ref.ID, lastID)
			if err != nil {
				failf("Error fetching logs: %v", err)
			}
			lastID = writeJobLogs(os.Stdout, logs, lastID)

			if !jobsLogsFollow {
				break
			}

			job, err := apiClient.GetJob(ref.ID)
			if err == nil && isTerminalJobStatus(job.Status) {
				// One last drain: the status flipped between our last fetch and this poll, so
				// the final chunks may already be written and would otherwise be lost.
				final, _ := apiClient.GetJobLogs(ref.ID, lastID)
				writeJobLogs(os.Stdout, final, lastID)
				fmt.Printf("\n--- Job %s ---\n", ui.StatusVerbatim(job.Status))
				return
			}

			time.Sleep(jobsLogsPollInterval)
		}
	},
}

// writeJobLogs prints one batch of chunks and returns the highest log id seen, so the next
// fetch resumes after it.
//
// It exists because the loop above used to carry two byte-identical copies of this switch — the
// polling one and the final drain — and a change to how STDERR renders had to be made twice or
// the two halves of one stream would disagree.
func writeJobLogs(w io.Writer, logs []api.JobLog, lastID int) int {
	for _, log := range logs {
		switch log.StreamType {
		case "STDERR":
			fmt.Fprint(w, jobLogStderrStyle.Render(log.LogChunk))
		case "SYSTEM":
			fmt.Fprint(w, jobLogSystemStyle.Render(log.LogChunk))
		default:
			fmt.Fprint(w, log.LogChunk)
		}
		if log.ID > lastID {
			lastID = log.ID
		}
	}
	return lastID
}

// isTerminalJobStatus reports whether a job has stopped moving, so `--follow` can return.
func isTerminalJobStatus(status string) bool {
	switch status {
	case "SUCCESS", "FAILED", "CANCELLED":
		return true
	default:
		return false
	}
}

func init() {
	jobsCmd.AddCommand(jobsLogsCmd)
	jobsLogsCmd.Flags().BoolVarP(&jobsLogsFollow, "follow", "f", false, "Keep polling for new logs")
	addJobSelectorFlags(jobsLogsCmd, &jobsLogsSelector)
}
