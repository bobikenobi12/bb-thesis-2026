// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/spf13/cobra"

// The job verbs. Each takes the job id as an OPTIONAL positional: given one it passes through byte
// for byte and makes no listing call, and given none on a terminal it offers the organization's
// recent jobs — the same line `jobs list` shows, through the same renderer.

var opsInspectJobCmd = &cobra.Command{
	Use:   "inspect-job [job-id]",
	Short: "Read a job's full row cross-tenant (blast: none)",
	Long: "Read one job's full row, bypassing row-level security, for diagnosis. Read-only: nothing is\n" +
		"mutated, no typed-confirm is sent, and no confirmation is asked for.",
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		jobID := opsResolveJobID(cmd, args)
		runOpsAction(opsRequest{Cmd: cmd, ResourceID: jobID, Reason: reason})
	},
}

var opsRetryJobCmd = &cobra.Command{
	Use:   "retry-job [job-id]",
	Short: "Re-enqueue a fresh job from a stuck/failed one (blast: low)",
	Args:  cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		jobID := opsResolveJobID(cmd, args)
		runOpsAction(opsRequest{
			Cmd: cmd, ResourceID: jobID, Reason: reason,
			Resource:    "job " + jobID,
			Consequence: "A fresh job is queued from it and the work runs again; the poison counter resets",
		})
	},
}

var opsCancelJobCmd = &cobra.Command{
	Use:   "cancel-job [job-id]",
	Short: "Cancel a job and signal its runner to stop mid-flight (blast: low)",
	Args:  cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		jobID := opsResolveJobID(cmd, args)
		runOpsAction(opsRequest{
			Cmd: cmd, ResourceID: jobID, Reason: reason,
			Resource:    "job " + jobID,
			Consequence: "Its runner is signalled to stop mid-flight; work already applied is not rolled back",
		})
	},
}

func init() {
	registerOpsVerb(opsInspectJobCmd)
	registerOpsVerb(opsRetryJobCmd)
	registerOpsVerb(opsCancelJobCmd)
}
