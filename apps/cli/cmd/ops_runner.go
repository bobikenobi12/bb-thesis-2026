// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/spf13/cobra"

// The runner verbs. The picker offers EVERY runner, including the offline ones — a drain or a
// restart is aimed at the runner that is wrong, so the job-dispatch picker's "only runners that can
// take work" filter would hide every candidate.

var opsDrainRunnerCmd = &cobra.Command{
	Use:   "drain-runner [runner-id]",
	Short: "Mark an ONLINE runner DRAINING so it stops claiming jobs (blast: low)",
	Args:  cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		runnerID := opsResolveRunnerID(cmd, args)
		runOpsAction(opsRequest{
			Cmd: cmd, ResourceID: runnerID, Reason: reason,
			Resource:    "runner " + runnerID,
			Consequence: "It finishes the jobs it already holds and claims no new ones; queued work waits for another runner",
		})
	},
}

var opsRestartRunnerCmd = &cobra.Command{
	Use:   "restart-runner [runner-id]",
	Short: "Drain a runner and wake the scaler to roll a replacement (blast: medium)",
	Args:  cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		runnerID := opsResolveRunnerID(cmd, args)
		runOpsAction(opsRequest{
			Cmd: cmd, ResourceID: runnerID, Reason: reason,
			Resource:    "runner " + runnerID,
			Consequence: "It is drained and the fleet scaler wakes to roll a replacement; this runner does not come back",
		})
	},
}

func init() {
	registerOpsVerb(opsDrainRunnerCmd)
	registerOpsVerb(opsRestartRunnerCmd)
}
