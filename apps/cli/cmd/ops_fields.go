// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
)

// The field spec for the `ops` break-glass group.
//
// A CLI command that takes a value renders that value FOUR times: as a flag or a positional, as a
// question in an interactive form, as the key the server reads it under, and as a row in the docs.
// Nothing made those four agree here, and they had already drifted:
//
//   - every verb REQUIRED `--reason`, and no verb could ask for one, so the first thing an operator
//     does in an incident is re-type the command;
//   - `unstick-env`'s documented example passed `--from PROVISIONING,DEPLOYING --to READY`, and
//     neither DEPLOYING nor READY is a project_status — the page documented an invocation the
//     server refuses;
//   - every id was a REQUIRED positional, so `ops cancel-job` was the second half of a copy out of
//     an alert or out of `jobs list`.
//
// This file is the one place those fields are described. The forms read their titles and
// descriptions from here rather than repeating them, so the form and the spec cannot disagree by
// construction; ops_form_test.go checks the other two renderings — that the flag or positional
// named here exists on the command, and that ops.mdx carries the same rows in the same order.

// opsField is one value an ops command takes from a person.
// opsField is spec.Field. The struct declared here was one of five near-identical copies across the
// noun groups, each carrying a comment naming #3661 as where they converge. This is that
// convergence; an ALIAS rather than a new type so every literal in this file and every call site
// elsewhere reads unchanged. What the columns mean is documented once, on spec.Field.
type opsField = spec.Field

// Field keys. Constants rather than literals so a typo is a compile error and a rename reaches the
// form and the spec together.
const (
	opsKeyReason     = "reason"
	opsKeyJob        = "job"
	opsKeyRunner     = "runner"
	opsKeyEnv        = "environment"
	opsKeyProject    = "project"
	opsKeyStateKey   = "state-key"
	opsKeyEvent      = "event"
	opsKeyApproval   = "approval"
	opsKeyFrom       = "from"
	opsKeyTo         = "to"
	opsKeyNote       = "note"
	opsKeySendEmails = "send-emails"
	opsKeyAction     = "action"
	opsKeyResource   = "resource"
)

// docsOpsPage is the group's page, relative to the repository root.
const docsOpsPage = "apps/docs/content/docs/cli/commands/ops.mdx"

// opsReasonDescription is the one sentence that describes `--reason`, written once because eleven
// commands take it and eleven copies is eleven chances to describe the same field differently.
const opsReasonDescription = "Why you are breaking glass; it is written to the immutable audit before the act"

// opsApprovalDescription likewise for `--approval`, which three commands take.
//
// It says where the token comes from, because this is the ONE value in the group that a person
// must type from somewhere else and that is not a defect: a two-person approval is minted by a
// DIFFERENT operator, on their own terminal, and handed over. There is no listing endpoint for it
// and there must not be one — a token this CLI could fetch for you would not be two-person.
const opsApprovalDescription = "The approval id a second operator read out to you from their own ops approve run"

// opsFields is the spec. One entry per value a command in this group takes from a person, in the
// order the form asks them and the docs table lists them.
var opsFields = []opsField{
	// ── session ──
	{Command: "alethia ops session", Key: opsKeyReason, Title: "Reason", Description: opsReasonDescription, Flag: "reason"},

	// ── approve ──
	{Command: "alethia ops approve", Key: opsKeyAction, Title: "Action", Description: "Which high-blast action this approval lets the other operator perform", Arg: "[action]"},
	{Command: "alethia ops approve", Key: opsKeyResource, Title: "Resource", Description: "The exact resource the approval is bound to; a different one is refused", Arg: "[resource-id]"},
	{Command: "alethia ops approve", Key: opsKeyReason, Title: "Reason", Description: opsReasonDescription, Flag: "reason"},

	// ── jobs ──
	{Command: "alethia ops inspect-job", Key: opsKeyJob, Title: "Job", Description: "The job to read; pick one, or pass an id an alert gave you", Arg: "[job-id]"},
	{Command: "alethia ops inspect-job", Key: opsKeyReason, Title: "Reason", Description: opsReasonDescription, Flag: "reason"},

	{Command: "alethia ops retry-job", Key: opsKeyJob, Title: "Job", Description: "The job to re-enqueue; a fresh job is created and the poison counter resets", Arg: "[job-id]"},
	{Command: "alethia ops retry-job", Key: opsKeyReason, Title: "Reason", Description: opsReasonDescription, Flag: "reason"},

	{Command: "alethia ops cancel-job", Key: opsKeyJob, Title: "Job", Description: "The job to cancel; its runner is signalled to stop mid-flight", Arg: "[job-id]"},
	{Command: "alethia ops cancel-job", Key: opsKeyReason, Title: "Reason", Description: opsReasonDescription, Flag: "reason"},

	// ── environments ──
	{Command: "alethia ops unstick-env", Key: opsKeyEnv, Title: "Environment", Description: "The environment to move; pick one, or pass its id", Arg: "[environment-id]"},
	{Command: "alethia ops unstick-env", Key: opsKeyFrom, Title: "Expected from", Description: "The statuses the move is allowed to start from; a compare-and-swap miss is refused", Flag: "from"},
	{Command: "alethia ops unstick-env", Key: opsKeyTo, Title: "Move to", Description: "The status to move the environment to", Flag: "to"},
	{Command: "alethia ops unstick-env", Key: opsKeyReason, Title: "Reason", Description: opsReasonDescription, Flag: "reason"},

	// ── runners ──
	{Command: "alethia ops drain-runner", Key: opsKeyRunner, Title: "Runner", Description: "The runner to drain; it finishes what it holds and claims nothing new", Arg: "[runner-id]"},
	{Command: "alethia ops drain-runner", Key: opsKeyReason, Title: "Reason", Description: opsReasonDescription, Flag: "reason"},

	{Command: "alethia ops restart-runner", Key: opsKeyRunner, Title: "Runner", Description: "The runner to roll; it is drained and the scaler wakes to replace it", Arg: "[runner-id]"},
	{Command: "alethia ops restart-runner", Key: opsKeyReason, Title: "Reason", Description: opsReasonDescription, Flag: "reason"},

	// ── state ──
	{Command: "alethia ops force-release-lock", Key: opsKeyStateKey, Title: "State key", Description: "The locked state object; the fencing token rotates so a zombie writer is fenced out", Arg: "[state-key]"},
	{Command: "alethia ops force-release-lock", Key: opsKeyApproval, Title: "Approval", Description: opsApprovalDescription, Flag: "approval"},
	{Command: "alethia ops force-release-lock", Key: opsKeyReason, Title: "Reason", Description: opsReasonDescription, Flag: "reason"},

	{Command: "alethia ops state-surgery", Key: opsKeyStateKey, Title: "State key", Description: "The state object the surgery job will operate on", Arg: "[state-key]"},
	{Command: "alethia ops state-surgery", Key: opsKeyApproval, Title: "Approval", Description: opsApprovalDescription, Flag: "approval"},
	{Command: "alethia ops state-surgery", Key: opsKeyNote, Title: "Repair note", Description: "What the repair is meant to do; recorded in the audit and read by whoever reviews it", Flag: "note"},
	{Command: "alethia ops state-surgery", Key: opsKeyReason, Title: "Reason", Description: opsReasonDescription, Flag: "reason"},

	// ── orphans ──
	{Command: "alethia ops orphan-detect", Key: opsKeyProject, Title: "Project", Description: "The project to scan; detection is run-scoped and never account-wide", Flag: "project"},
	{Command: "alethia ops orphan-detect", Key: opsKeyReason, Title: "Reason", Description: opsReasonDescription, Flag: "reason"},

	{Command: "alethia ops orphan-clean", Key: opsKeyProject, Title: "Project", Description: "The project whose detected orphans are force-destroyed", Flag: "project"},
	{Command: "alethia ops orphan-clean", Key: opsKeyApproval, Title: "Approval", Description: opsApprovalDescription, Flag: "approval"},
	{Command: "alethia ops orphan-clean", Key: opsKeyReason, Title: "Reason", Description: opsReasonDescription, Flag: "reason"},

	// ── webhooks ──
	{Command: "alethia ops replay-webhook", Key: opsKeyEvent, Title: "Stripe event", Description: "The stored event to re-dispatch through the live idempotent handler", Arg: "[stripe-event-id]"},
	{Command: "alethia ops replay-webhook", Key: opsKeySendEmails, Title: "Re-send emails", Description: "Branded emails are the one non-idempotent side effect, so they are suppressed unless you ask", Flag: "send-emails", Bool: true},
	{Command: "alethia ops replay-webhook", Key: opsKeyReason, Title: "Reason", Description: opsReasonDescription, Flag: "reason"},
}

// mustOpsField returns the spec for one field.
//
// It panics on a miss, and that is the right failure: both arguments are constants in this package,
// so a miss is a programming error, and the alternative — a zero opsField — is a form that opens
// with an empty title and asks the operator for something unnamed, in an incident. The behavioural
// tests drive every prompt, so an unresolvable key cannot ship.
func mustOpsField(command, key string) opsField {
	return opsGroup().Must(command, key)
}

// opsGroup wraps the ops group's table in the shared kit, so the lookup, the flag
// registration and the docs rendering are the ones every other group uses rather than five copies
// of each.
func opsGroup() spec.Group {
	return spec.Group{Name: "ops", Source: "ops_fields.go", Fields: opsFields}
}

// ── the action catalog ──────────────────────────────────────────────────────────────────────────

// opsAction mirrors one entry of BREAKGLASS_CATALOG in apps/console/lib/breakglass/catalog.ts, the
// server's single source of truth for what an action costs and what it requires.
//
// It is a MIRROR, not a second opinion. `ops_catalog_test.go` parses the TypeScript and fails on
// any disagreement, including an action the server has and this table does not — which is how a
// break-glass verb added server-side stops being invisible to the CLI's own guards.
type opsAction struct {
	// Command is the cobra command path, e.g. "alethia ops cancel-job".
	Command string
	// Action is the server enum value the command dispatches, e.g. "cancel_job".
	Action string
	// Blast is the catalog's blastRadius: none, low, medium, high.
	Blast string
	// ReadOnly is the catalog's readOnly. It is the CLI's definition of "needs a confirmation":
	// every mutating break-glass action confirms, every read-only one does not.
	ReadOnly bool
	// RequiresApproval is the catalog's requiresApproval — the two-person gate, enforced server-side.
	RequiresApproval bool
}

// opsActions is every dispatchable break-glass action, in catalog order.
var opsActions = []opsAction{
	{Command: "alethia ops inspect-job", Action: "inspect_job", Blast: "none", ReadOnly: true},
	{Command: "alethia ops retry-job", Action: "retry_job", Blast: "low"},
	{Command: "alethia ops cancel-job", Action: "cancel_job", Blast: "low"},
	{Command: "alethia ops unstick-env", Action: "unstick_env", Blast: "medium"},
	{Command: "alethia ops drain-runner", Action: "drain_runner", Blast: "low"},
	{Command: "alethia ops restart-runner", Action: "restart_runner", Blast: "medium"},
	{Command: "alethia ops replay-webhook", Action: "replay_webhook", Blast: "low"},
	{Command: "alethia ops force-release-lock", Action: "force_release_state_lock", Blast: "high", RequiresApproval: true},
	{Command: "alethia ops state-surgery", Action: "state_surgery", Blast: "high", RequiresApproval: true},
	{Command: "alethia ops orphan-detect", Action: "orphan_detect", Blast: "none", ReadOnly: true},
	{Command: "alethia ops orphan-clean", Action: "orphan_clean", Blast: "high", RequiresApproval: true},
}

// opsApprovalActions is the closed set `ops approve` offers, DERIVED from the catalog rather than
// typed a second time.
//
// The set is what the server's approval endpoint accepts: it refuses to mint an approval for an
// action that does not require one. Typing the three names here as well is how the CLI's picker
// comes to offer a fourth after the catalog gains one.
func opsApprovalActions() []string {
	var out []string
	for _, a := range opsActions {
		if a.RequiresApproval {
			out = append(out, a.Action)
		}
	}
	return out
}

// opsActionFor returns the catalog entry for a cobra command path, and whether there is one.
// `ops session` and `ops approve` have none — neither is a dispatched action.
func opsActionFor(path string) (opsAction, bool) {
	for _, a := range opsActions {
		if a.Command == path {
			return a, true
		}
	}
	return opsAction{}, false
}

// ── the --yes opt-ins ───────────────────────────────────────────────────────────────────────────

// opsYes holds the --yes opt-in for each mutating verb, keyed by cobra command path.
//
// A map rather than one package variable per command for a reason the confirm suite records at
// length: every --yes global has to be reset between tests, and a hand-written reset list is a list
// that stops covering. resetOpsConfirmFlags below clears the whole map, so a verb added to
// opsActions joins the reset without anyone remembering.
var opsYes = map[string]*bool{}

// addOpsYesFlag registers the standard --yes/-y on a mutating ops verb and remembers its target.
func addOpsYesFlag(cmd *cobra.Command, path string) {
	v := new(bool)
	opsYes[path] = v
	addYesFlag(cmd, v)
}

// opsYesFor reads a command's --yes opt-in. A verb with no registered flag reads false, which is
// the safe answer: it means "nobody opted in", so an interactive run asks and a scripted one is
// refused.
func opsYesFor(path string) bool {
	if v, ok := opsYes[path]; ok {
		return *v
	}
	return false
}

// resetOpsConfirmFlags clears every ops --yes opt-in. Called from the confirm suite's flag reset:
// cobra never clears a flag between Execute calls, and a --yes left set by one test would silently
// pre-confirm a destructive command in the next.
func resetOpsConfirmFlags() {
	for _, v := range opsYes {
		*v = false
	}
}

// ── the group ───────────────────────────────────────────────────────────────────────────────────

// opsGroupCommands returns every runnable command under `ops`, derived from the live tree rather
// than listed, so a new verb joins the guards without anyone remembering to add it.
func opsGroupCommands(root *cobra.Command) []*cobra.Command {
	group, _, err := root.Find([]string{"ops"})
	if err != nil || group == root {
		return nil
	}
	var out []*cobra.Command
	for _, c := range group.Commands() {
		if c.Hidden || c.Name() == "help" || c.Name() == "completion" {
			continue
		}
		if c.Run != nil || c.RunE != nil {
			out = append(out, c)
		}
	}
	return out
}

// opsCommandPath renders a cobra path back to the argument slice rootCmd.Find takes.
func opsCommandPath(path string) []string {
	return strings.Fields(strings.TrimPrefix(path, "alethia "))
}

// registerOpsVerb registers one break-glass verb: every flag-backed field its spec names, the
// standard --yes on the mutating ones, and the command itself under `ops`.
//
// The flags are DERIVED from opsFields, including their `--help` text, which is the third of the
// four renderings. Before this, eleven `--reason` flags were registered by hand and described in
// eight different ways; `--project` was "Project id to scope the scan/clean to (required)" on one
// command and "(required)" on the other while neither would prompt for it.
//
// It panics on a verb with no fields, and on one with no catalog entry, for the reason mustOpsField
// does: both are programming errors reachable only at init, and the alternative is a break-glass
// verb that silently registers no --reason or confirms as read-only.
func registerOpsVerb(cmd *cobra.Command) {
	fields := strings.Fields(cmd.Use)
	if len(fields) == 0 {
		panic("an ops verb with an empty Use cannot be resolved against its spec")
	}
	path := "alethia ops " + fields[0]

	registered := 0
	for _, f := range opsFields {
		if f.Command != path || f.Flag == "" {
			continue
		}
		registered++
		if f.Bool {
			cmd.Flags().Bool(f.Flag, false, f.Description)
			continue
		}
		cmd.Flags().String(f.Flag, "", f.Description)
	}
	if registered == 0 {
		panic(fmt.Sprintf("%s has no flag-backed fields in opsFields — every ops verb takes at least --reason", path))
	}

	// `session` and `approve` are not dispatched actions and have no catalog entry; every other
	// verb must, and a mutating one gets the confirmation opt-in.
	if a, ok := opsActionFor(path); ok && !a.ReadOnly {
		addOpsYesFlag(cmd, path)
	}
	opsCmd.AddCommand(cmd)
}
