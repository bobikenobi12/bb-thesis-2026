// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// force-release-lock and state-surgery are HIGH-blast: they require a two-person --approval token
// minted by a DIFFERENT operator via `alethia ops approve`.
//
// A state key is not pickable and never will be — there is no listing endpoint for the state
// backend's objects, and a break-glass unlock is aimed at a key an operator read off a stranded
// apply. So the interactive path here is a PROMPT, not a menu: the question is asked, the answer is
// typed, and `--no-input` is told which positional would have answered it.

var opsForceReleaseLockCmd = &cobra.Command{
	Use:   "force-release-lock [state-key]",
	Short: "Force-release a stranded tofu state lock (blast: HIGH, two-person)",
	Long: "Rotates the fencing token + bumps generation (never a naive delete), so a zombie writer is\n" +
		"fenced out. Requires a two-person --approval token from a different operator.",
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		stateKey := opsResolveArg(cmd, opsKeyStateKey, args, nil)
		approval := opsApproval(cmd)
		runOpsAction(opsRequest{
			Cmd: cmd, ResourceID: stateKey, Reason: reason, ApprovalID: approval,
			Resource:    "state lock " + stateKey,
			Consequence: "The fencing token rotates and the generation bumps; a writer still holding this lock is fenced out mid-apply",
		})
	},
}

var opsStateSurgeryCmd = &cobra.Command{
	Use:   "state-surgery [state-key]",
	Short: "Queue a privileged STATE_SURGERY job through the pipeline (blast: HIGH, two-person; INERT)",
	Long: "Enqueues a privileged STATE_SURGERY job through the NORMAL runner/state pipeline (fencing\n" +
		"intact). The runner-side executor ships INERT (fail-closed) — the job will fail cleanly\n" +
		"without mutating state. Requires a two-person --approval token from a different operator.",
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		stateKey := opsResolveArg(cmd, opsKeyStateKey, args, nil)
		approval := opsApproval(cmd)
		note := opsResolveNote(cmd)

		var input *api.BreakglassActionInput
		if note != "" {
			input = &api.BreakglassActionInput{SurgeryNote: note}
		}
		runOpsAction(opsRequest{
			Cmd: cmd, ResourceID: stateKey, Reason: reason, ApprovalID: approval, Input: input,
			Resource:    "state " + stateKey,
			Consequence: "A privileged STATE_SURGERY job is queued against it through the normal runner pipeline",
		})
	},
}

// opsResolveNote resolves the optional audit note.
//
// OPTIONAL is the whole difference from every other resolver here: an empty answer is a valid
// answer, so a scripted run with no --note is not refused and the prompt accepts an empty string.
// It is still asked interactively, because the person who will read the audit is not the person
// running this, and "state_surgery, no note" is the row that gets escalated.
func opsResolveNote(cmd *cobra.Command) string {
	f := mustOpsField(cmd.CommandPath(), opsKeyNote)
	supplied, _ := cmd.Flags().GetString(f.Flag)
	if strings.TrimSpace(supplied) != "" {
		return strings.TrimSpace(supplied)
	}
	if err := requireInteractiveForm(); err != nil {
		return ""
	}
	note, err := opsAsk(f, "", func(string) error { return nil })
	if err != nil {
		fail(err)
		return ""
	}
	return note
}

func init() {
	registerOpsVerb(opsForceReleaseLockCmd)
	registerOpsVerb(opsStateSurgeryCmd)
}
