// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var opsOrphanDetectCmd = &cobra.Command{
	Use:   "orphan-detect",
	Short: "List orphan candidates for a single project (read-only, run-scoped; blast: none)",
	Long: "List cached cloud resources for one project's run scope whose environment is gone or\n" +
		"destroyed. Read-only and run-scoped — never account-wide.",
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		project := opsResolveProjectID(cmd)
		runOpsAction(opsRequest{
			Cmd: cmd, Reason: reason,
			Input: &api.BreakglassActionInput{ProjectID: project},
		})
	},
}

var opsOrphanCleanCmd = &cobra.Command{
	Use:   "orphan-clean",
	Short: "Force-destroy detected orphans (blast: HIGH; ships INERT/fail-closed)",
	Long: "Cross-cloud force-destroy — the most dangerous action. Ships INERT: it refuses unless the\n" +
		"deployment is separately armed (ALETHIA_BREAKGLASS_ORPHAN_CLEAN_ENABLED), and even then is\n" +
		"unimplemented rather than performing an unscoped delete. Requires a two-person --approval.",
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		project := opsResolveProjectID(cmd)
		approval := opsApproval(cmd)
		// Bind the approval + audit to the project scope (resourceId == project).
		runOpsAction(opsRequest{
			Cmd: cmd, ResourceID: project, Reason: reason, ApprovalID: approval,
			Input:       &api.BreakglassActionInput{ProjectID: project},
			Resource:    "project " + project,
			Consequence: "Every orphan detected in this project is force-destroyed across clouds; the resources do not come back",
		})
	},
}

func init() {
	registerOpsVerb(opsOrphanDetectCmd)
	registerOpsVerb(opsOrphanCleanCmd)
}
