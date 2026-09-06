// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import "github.com/spf13/cobra"

// The `cluster` group is read-only: it lists the clusters an org's projects have, and shows one.
//
// ── THE FIELD SPEC ─────────────────────────────────────────────────────────────────────────────
//
// The group takes exactly ONE piece of input from a user — which cluster — and it has four
// renderings, all of which must say the same thing:
//
//	argument   `alethia cluster get [selector]`, matching project name, cluster name or id.
//	           The complete contract: anything the form can ask, the argument can set, so
//	           `--no-input` always works and a script never needs a terminal.
//	form       the picker in clusters_get.go, opened when the selector is absent or ambiguous
//	           at a terminal. It never asks something the argument cannot answer.
//	manifest   none, and deliberately: a cluster is not declared, it is the OUTPUT of a project's
//	           environment. `alethia.yaml` has no cluster key to keep in step with this one.
//	docs       apps/docs/content/docs/cli/commands/clusters.mdx, whose examples are executed
//	           against this tree by TestHygCliDocs_EveryDocumentedExampleResolves.
//
// `cluster list` takes no input beyond the global flags, so it has no form — there is nothing to
// ask. Its interactive rendering is the navigable table, not a prompt.
var clusterCmd = &cobra.Command{
	Use:     "cluster",
	Aliases: []string{"clusters"},
	Short:   "View project cluster information",
	Long: `List and inspect the Kubernetes clusters provisioned for your projects.

A cluster is created by provisioning a project environment; this group only reads. Run
` + "`alethia cluster get`" + ` with no selector at a terminal and the CLI asks which one.`,
}

// clusterCostCurrency is the currency the estimated monthly cost is priced in.
//
// It is not on the wire: `/cli/clusters` returns `estimated_monthly_cost` as a bare number. The
// figure is the Infracost total the console persists in `environmentCost`, which pins
// `currency: "USD"` at the single site that writes it (apps/console/app/server/actions/cost.ts).
// Naming it here means the assumption is visible where it is used, rather than implied by a `$`.
const clusterCostCurrency = "USD"

// clusterEmptyState is the one sentence both renderings of an empty list print.
//
// It is a constant because there are two of them — the navigable table's early return and the
// static renderer's — and a list that says one thing on a terminal and another in a pipe is the
// same product telling a user two stories.
const clusterEmptyState = "No clusters found. Create a project with a cluster through Alethia."

func init() {
	rootCmd.AddCommand(clusterCmd)
}
