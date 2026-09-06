// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// opsCmd groups the break-glass (privileged incident recovery) verbs. Every verb hits the SAME
// audited /api/breakglass/* endpoints as the operator UI, with the SAME bearer auth + append-only
// audit — terminal-first operators during an incident. The entire surface is gated behind
// ALETHIA_BREAKGLASS_ENABLED + the BREAKGLASS_OPERATORS allowlist server-side; a non-operator (or a
// disabled deployment) is refused with 403/404.
var opsCmd = &cobra.Command{
	Use:   "ops",
	Short: "Break-glass incident recovery (privileged, audited, gated)",
	Long: "Break-glass incident-recovery actions for on-call operators.\n\n" +
		"Every action is audited (append-only, written before the act), requires a --reason, and\n" +
		"typed-confirms the resource id server-side. Every MUTATING action also asks you to confirm\n" +
		"it at the terminal, naming the resource and the consequence; --yes is how a runbook or a\n" +
		"pipeline opts in ahead of time. High-blast actions (force-release-lock, state-surgery,\n" +
		"orphan-clean) additionally require a two-person --approval token minted by a DIFFERENT\n" +
		"operator via `alethia ops approve`.",
	Run: func(cmd *cobra.Command, args []string) {
		_ = cmd.Help()
	},
}

func init() {
	rootCmd.AddCommand(opsCmd)
}

// mustOpsAction returns the catalog entry for a command path.
//
// It panics on a miss for the reason mustOpsField does: the path is the cobra tree's own, so a miss
// is a programming error, and the alternative — a zero opsAction — is a MUTATING break-glass verb
// silently classified read-only and shipped with no confirmation at all. ops_form_test.go resolves
// every leaf, so an unmapped one cannot ship.
func mustOpsAction(path string) opsAction {
	if a, ok := opsActionFor(path); ok {
		return a
	}
	panic(fmt.Sprintf("no opsAction for %q — see opsActions in ops_fields.go", path))
}

// opsRequest is one break-glass invocation, assembled by a verb and executed by runOpsAction.
//
// The action name and whether it mutates are NOT fields: both are read from the catalog by the
// command's own path, so a verb cannot dispatch one action while confirming as another, and a
// mutating verb cannot be wired as read-only by forgetting an argument. That was previously two
// bare positional parameters — `runOpsAction("cancel_job", …, false)` — and the last one, the one
// that decides whether the typed-confirm is sent at all, was a bare boolean at every call site.
type opsRequest struct {
	// Cmd is the verb being run. Its CommandPath resolves the catalog entry and the output format.
	Cmd *cobra.Command
	// ResourceID is the audited target. Mutating actions echo it back as the typed confirmation.
	ResourceID string
	// Reason is the audit reason, already resolved and validated.
	Reason string
	// ApprovalID is the two-person token, empty for the actions that need none.
	ApprovalID string
	// Input is the action's typed input block.
	Input *api.BreakglassActionInput
	// Resource names the target in the confirmation prompt: "job 8f3c1d2e", "runner ci-eu-1".
	Resource string
	// Consequence is what the confirmation promises will happen, in one clause.
	Consequence string
}

// runOpsAction is the shared path for every ops verb: it confirms, opens a fresh time-boxed
// break-glass session (recording the reason), then executes the action against the single audited
// endpoint. The typed-confirm is satisfied by sending confirm == resourceId (the server enforces
// the equality).
//
// The confirmation happens BEFORE the session is opened, and that ordering is the contract: a
// declined or unconfirmed action must leave no trace, and an opened session is an audit row.
func runOpsAction(req opsRequest) {
	action := mustOpsAction(req.Cmd.CommandPath())

	if !action.ReadOnly && !opsConfirm(req.Cmd.CommandPath(), req.Resource, req.Consequence) {
		return
	}

	// The reason is NOT re-validated here. opsReason is the single gate — it checks the supplied
	// flag and validates the prompt's answer against the same bound — and a second copy of the rule
	// on a path nothing can reach with an invalid value is a branch no test can honestly drive.
	token, err := getAuthToken()
	if err != nil {
		fail(err)
		return
	}
	client := api.NewClient(token)

	var session *api.BreakglassSession
	runSpinner("Opening break-glass session...", func() {
		session, err = client.OpenBreakglassSession(req.Reason)
	})
	if err != nil {
		failf("Failed to open break-glass session: %v", err)
		return
	}

	params := api.BreakglassExecuteParams{
		SessionID:  session.SessionID,
		Action:     action.Action,
		ResourceID: req.ResourceID,
		Reason:     req.Reason,
		ApprovalID: req.ApprovalID,
		Input:      req.Input,
	}
	// Typed-confirm: mutating actions must echo the exact resource id (server-enforced).
	if !action.ReadOnly && req.ResourceID != "" {
		params.Confirm = req.ResourceID
	}

	var result *api.BreakglassResult
	runSpinner(fmt.Sprintf("Executing %s...", action.Action), func() {
		result, err = client.ExecuteBreakglass(params)
	})
	if err != nil {
		failf("Action refused/failed: %v", err)
		return
	}

	renderOpsResult(req.Cmd, result)
}

// renderOpsResult prints one break-glass outcome through the shared surface.
//
// The success line is TABLE-ONLY. It used to be printed unconditionally, ahead of a raw
// json.MarshalIndent of the payload, so `alethia ops inspect-job … -o json` emitted a styled
// sentence and then a document — which is not JSON, and is the one output an operator is most
// likely to be piping into `jq` during an incident.
func renderOpsResult(cmd *cobra.Command, result *api.BreakglassResult) {
	format := outputFormat(cmd)
	rows := opsDataRows(result.Data)

	if format == ui.FormatTable {
		ui.Success(result.Detail)
		if len(rows) == 0 {
			return
		}
	}
	if err := ui.RenderCard(os.Stdout, format, "result", rows, result); err != nil {
		fail(err)
	}
}

// opsDataRows renders a break-glass result payload as ordered Field/Value rows.
//
// The payload's shape is the ACTION's, not one this CLI can name in advance — a job row, a list of
// orphan candidates, a rotated fencing token — so it is read as JSON and flattened one level, keys
// sorted so two runs of the same action read the same way. A non-object payload (a list, a bare
// value) becomes a single row rather than being dropped: a reader who cannot see it has no way to
// know it was there.
func opsDataRows(raw json.RawMessage) [][]string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return [][]string{{"data", trimmed}}
	}
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	rows := make([][]string, 0, len(keys))
	for _, k := range keys {
		rows = append(rows, []string{k, opsScalar(fields[k])})
	}
	return rows
}

// opsScalar renders one JSON value for a card cell: a string without its quotes, anything else as
// the compact JSON it is.
func opsScalar(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return ui.OrDash(s)
	}
	return strings.TrimSpace(string(raw))
}
