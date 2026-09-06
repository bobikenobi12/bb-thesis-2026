// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/spf13/cobra"
)

var usageCmd = &cobra.Command{
	Use:   "usage",
	Short: "Show the active organization's current usage",
	Long: `Display the active organization's current usage: billable seats used vs the
purchased cap, managed-runner minutes consumed this period, the project count, and AI
credits used vs the plan's weekly grant. Read-only. Use --output json for scripting.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runUsage(api.NewClient(token), os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to get usage: %v", err)
		}
	},
}

// usageRows projects the usage counters into Field/Value card rows for the given output format.
//
// Runner minutes go through format.Minutes for the TABLE card, so 120 reads `2h` and 47 reads
// `47 min` instead of a bare integer with no unit. That is the rule the console's usage meter
// applies to the same number: `120` is a number the code happens to hold, not an answer to "how
// much have I used".
//
// CSV keeps the raw integer, and the format parameter exists for exactly that. ui.RenderCard feeds
// these same rows to the CSV branch, so humanising them unconditionally would have changed
// `alethia usage -o csv` from `120` to `2h` — a value `awk`/`ParseFloat` can no longer do
// arithmetic on, with no error and no deprecation. A person reads the card; a script reads the CSV.
//
// format.Minutes admits a `<1 min` case, and this call site can never reach it: the wire's
// `runner_minutes` is an int and the server rounds before serialising (`Math.round(job_minutes)`),
// so 0.943 minutes arrives here as `1` and reads `1 min`. That is a wire fact, not a render one —
// the sub-minute case would need a float on the wire, which is a contract change.
//
// They are deliberately NOT rendered as a quota, and the reason is a wire fact rather than an
// omission. api.Usage pairs seats_used with seats_cap and ai_credits_used with ai_credits_granted,
// and carries NO runner-minute allowance at all — the console's `/ 200 min` comes from the plan
// catalogue, which the CLI does not have and the API does not send. `2h / 0 min` would assert an
// allowance of zero and `2h / 200 min` would assert one nobody sent; a quota here needs an
// `included_minutes` field, which is a contract change and belongs to its own unit.
//
// Seats and AI credits stay bare counts on both sides of the slash: they are people and credits,
// not durations, and the console renders the seats meter as the same `used / cap` pair.
func usageRows(u *api.Usage, outFmt string) [][]string {
	runnerMinutes := strconv.Itoa(u.RunnerMinutes)
	if outFmt == ui.FormatTable {
		runnerMinutes = format.Minutes(float64(u.RunnerMinutes))
	}
	return [][]string{
		{"Seats", fmt.Sprintf("%d / %d", u.SeatsUsed, u.SeatsCap)},
		{"Runner minutes", runnerMinutes},
		{"Projects", strconv.Itoa(u.Projects)},
		{"AI credits", fmt.Sprintf("%d / %d", u.AICreditsUsed, u.AICreditsGranted)},
	}
}

// runUsage fetches the usage counters and renders them as a Field/Value card (table/csv)
// or the typed object (json). Seats and AI credits show as "used / cap" ratios.
func runUsage(c apiClient, out io.Writer, outFmt string) error {
	usage, err := c.GetUsage()
	if err != nil {
		return err
	}
	return ui.RenderCard(out, outFmt, "alethia · usage", usageRows(usage, outFmt), usage)
}

func init() {
	rootCmd.AddCommand(usageCmd)
}
