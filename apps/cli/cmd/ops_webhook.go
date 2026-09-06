// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var opsReplayWebhookCmd = &cobra.Command{
	Use:   "replay-webhook [stripe-event-id]",
	Short: "Re-dispatch a stored Stripe webhook event idempotently (blast: low)",
	Long: "Replays a stored Stripe event through the SAME idempotent handler the live webhook uses.\n" +
		"Branded emails are SUPPRESSED by default (the one non-idempotent side effect); pass\n" +
		"--send-emails to re-send them.",
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		eventID := opsResolveArg(cmd, opsKeyEvent, args, nil)
		sendEmails, _ := cmd.Flags().GetBool(mustOpsField(cmd.CommandPath(), opsKeySendEmails).Flag)
		suppress := !sendEmails

		// The consequence differs between the two arms, and it is the difference that matters: the
		// handler is idempotent, the emails are not. A confirmation that said the same thing either
		// way would be describing the safe run to the operator about to do the unsafe one.
		consequence := "The stored event runs through the live handler again; the handler is idempotent and branded emails are suppressed"
		if sendEmails {
			consequence = "The stored event runs through the live handler again AND its branded emails are re-sent to the customer"
		}
		runOpsAction(opsRequest{
			Cmd: cmd, ResourceID: eventID, Reason: reason,
			Input:       &api.BreakglassActionInput{SuppressEmails: &suppress},
			Resource:    "Stripe event " + eventID,
			Consequence: consequence,
		})
	},
}

func init() {
	registerOpsVerb(opsReplayWebhookCmd)
}
