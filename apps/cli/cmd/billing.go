// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"io"
	"os"
	"strconv"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var billingCmd = &cobra.Command{
	Use:   "billing",
	Short: "Show the active organization's billing state",
	Long: `Display the active organization's billing: its plan, subscription status, seat
count, Stripe subscription id, and the trial / current-period boundaries. Read-only —
manage the subscription from the console. Use --output json for scripting.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		if err := runBilling(api.NewClient(token), os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to get billing: %v", err)
		}
	},
}

// runBilling fetches the billing state and renders it as a Field/Value card (table/csv)
// or the typed object (json).
func runBilling(c apiClient, out io.Writer, format string) error {
	billing, err := c.GetBilling()
	if err != nil {
		return err
	}
	seats := ui.SymbolDash
	if billing.Seats != nil {
		seats = strconv.Itoa(*billing.Seats)
	}
	rows := [][]string{
		{"Plan", billing.Plan},
		{"Status", billing.Status},
		{"Seats", seats},
		{"Subscription", ui.OrDash(billing.StripeSubscriptionID)},
		{"Trial ends", ui.RelativeTime(billing.TrialEndsAt)},
		{"Period ends", ui.RelativeTime(billing.CurrentPeriodEnd)},
	}
	return ui.RenderCard(out, format, "alethia · billing", rows, billing)
}

func init() {
	rootCmd.AddCommand(billingCmd)
}
