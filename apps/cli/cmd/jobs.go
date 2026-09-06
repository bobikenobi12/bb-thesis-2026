// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/spf13/cobra"
)

var jobsCmd = &cobra.Command{
	Use:   "jobs",
	Short: "Manage provisioning jobs",
	Long: `Provisioning jobs are the unit of work the Runner executes: a plan, a deploy, a
destroy, a drift detection, a scan.

` + "`alethia jobs list`" + ` shows them. ` + "`get`" + `, ` + "`logs`" + ` and ` + "`cancel`" + ` act on one — named by
its id, chosen from a picker, or resolved with ` + "`--latest`" + ` so a script never has to copy an
id out of another command's output.`,
}

func init() {
	rootCmd.AddCommand(jobsCmd)
}
