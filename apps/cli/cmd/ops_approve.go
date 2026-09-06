// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// opsApproveCmd is run by the SECOND operator to mint a two-person approval token for a high-blast
// action. The acting operator then passes the printed id as `--approval`. The server enforces that
// the approver and the actor are different people.
var opsApproveCmd = &cobra.Command{
	Use:   "approve [action] [resource-id]",
	Short: "Mint a two-person approval for a high-blast action (run by a SECOND operator)",
	Long: "Mint a single-use, TTL'd approval bound to a high-blast action + resource. The acting\n" +
		"operator (a DIFFERENT person) then passes the printed id as --approval.\n\n" +
		"Run with no arguments on a terminal it offers the actions that take an approval, read from\n" +
		"the same catalog the server enforces, so the list cannot offer one the server refuses to\n" +
		"mint.",
	Args: cobra.MaximumNArgs(2),
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		action := opsResolveApprovalAction(cmd, args)
		resourceID := opsResolveArg(cmd, opsKeyResource, opsArgAt(args, 1), nil)

		token, err := getAuthToken()
		if err != nil {
			fail(err)
			return
		}
		client := api.NewClient(token)

		var approval *api.BreakglassApproval
		runSpinner("Minting approval...", func() {
			approval, err = client.MintBreakglassApproval(action, resourceID, reason, nil)
		})
		if err != nil {
			failf("Failed to mint approval: %v", err)
			return
		}

		format := outputFormat(cmd)
		if format == ui.FormatTable {
			ui.Success(fmt.Sprintf("Approval minted (expires %s)", ui.Stamp(approval.ExpiresAt)))
		}
		rows := [][]string{
			{"approval id", ui.OrDash(approval.ApprovalID)},
			{"action", ui.OrDash(approval.Action)},
			{"resource", ui.OrDash(approval.ResourceID)},
			{"approver", ui.OrDash(approval.Approver)},
			// ui.Stamp, not ui.OrDash: `expiresAt` is a TIMESTAMP, and the string helper echoed the
			// wire's RFC3339 into a row a person reads while dashing correctly. Stamp already
			// returns the dash for an empty value, so the OrDash wrapper had nothing left to add.
			{"expires", ui.Stamp(approval.ExpiresAt)},
			{"note", ui.OrDash(approval.Note)},
		}
		if err := ui.RenderCard(os.Stdout, format, "approval", rows, approval); err != nil {
			fail(err)
		}
	},
}

// opsResolveApprovalAction resolves which high-blast action the approval is for.
//
// The offered set is DERIVED from the catalog (opsApprovalActions), so it cannot list an action the
// server's approval endpoint refuses to mint — it answers 400 for anything whose spec does not
// require an approval. Validating a value given on the command line against the same set is the
// "provable subset" rule: this is a refusal the server certainly makes, and its version of it is a
// zod issue list.
func opsResolveApprovalAction(cmd *cobra.Command, args []string) string {
	f := mustOpsField(cmd.CommandPath(), opsKeyAction)
	allowed := opsApprovalActions()

	if len(args) > 0 && strings.TrimSpace(args[0]) != "" {
		action := strings.TrimSpace(args[0])
		canonical, ok := opsMatchAction(allowed, action)
		if !ok {
			failf("%q does not take a two-person approval (want one of: %s)", action, strings.Join(allowed, ", "))
			return ""
		}
		// The CANONICAL spelling, not the caller's. The match is case-insensitive so an operator
		// typing STATE_SURGERY at 3am is not refused for it, but `mintApprovalSchema.action` is
		// `z.enum(breakglassAction.enumValues)` — lowercase snake_case — so posting the caller's
		// spelling turns an accepted argument into a 400 and a zod issue list at the server. That
		// is the round trip this command removes for --reason and --from/--to, landing on the only
		// gate `force-release-lock`, `state-surgery` and `orphan-clean` have.
		return canonical
	}
	if err := requireInteractiveForm(); err != nil {
		fail(opsScripted(f, err))
		return ""
	}
	i, err := opsPick(f.Title, f.Description, allowed)
	if err != nil {
		fail(err)
		return ""
	}
	return allowed[i]
}

// opsSessionCmd opens a standalone break-glass session (the action verbs open their own; this is
// for inspecting/warming a session or scripts that reuse one).
var opsSessionCmd = &cobra.Command{
	Use:   "session",
	Short: "Open a standalone time-boxed break-glass session",
	Args:  cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		token, err := getAuthToken()
		if err != nil {
			fail(err)
			return
		}
		client := api.NewClient(token)

		var session *api.BreakglassSession
		runSpinner("Opening break-glass session...", func() {
			session, err = client.OpenBreakglassSession(reason)
		})
		if err != nil {
			failf("Failed to open session: %v", err)
			return
		}

		format := outputFormat(cmd)
		if format == ui.FormatTable {
			ui.Success(fmt.Sprintf("Session opened for %s", ui.OrDash(session.Operator)))
		}
		rows := [][]string{
			{"session id", ui.OrDash(session.SessionID)},
			{"operator", ui.OrDash(session.Operator)},
			{"expires", ui.Stamp(session.ExpiresAt)},
		}
		if err := ui.RenderCard(os.Stdout, format, "session", rows, session); err != nil {
			fail(err)
		}
	},
}

func init() {
	registerOpsVerb(opsApproveCmd)
	registerOpsVerb(opsSessionCmd)
}

// opsMatchAction resolves a caller-supplied action to the catalog's own spelling, case-insensitively.
//
// Separate from containsFold (jobs_select.go) because the answer needed here is the matched VALUE,
// not whether one exists — a predicate cannot normalise, and the normalisation is the point.
func opsMatchAction(allowed []string, v string) (string, bool) {
	for _, a := range allowed {
		if strings.EqualFold(a, v) {
			return a, true
		}
	}
	return "", false
}
