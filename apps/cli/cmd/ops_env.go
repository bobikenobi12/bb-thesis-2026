// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var opsUnstickEnvCmd = &cobra.Command{
	Use:   "unstick-env [environment-id]",
	Short: "Move a stuck environment via the set_env_status CAS (blast: medium)",
	Long: "Move a stuck environment to a target status via the compare-and-swap primitive (never a\n" +
		"raw UPDATE). The expected-from set and the target are both explicit; a CAS miss is refused,\n" +
		"which is what makes this safe to run against an environment that is moving under you.\n\n" +
		"Picked interactively, the expected-from set starts at the status the environment is\n" +
		"actually in. Given an id on the command line the CLI has not looked it up and does not\n" +
		"guess: --from is then required, because inventing a precondition is the one thing a\n" +
		"compare-and-swap exists to prevent.",
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		reason := opsReason(cmd)
		envID, current := opsResolveEnvironment(cmd, args)
		from := opsResolveExpectedFrom(cmd, current)
		to := opsResolveTargetStatus(cmd)

		input := &api.BreakglassActionInput{ExpectedFrom: from, To: to}
		runOpsAction(opsRequest{
			Cmd: cmd, ResourceID: envID, Reason: reason, Input: input,
			Resource: "environment " + envID,
			Consequence: "Its status moves " + strings.Join(from, "/") + " " + ui.SymbolArrow + " " + to +
				"; a compare-and-swap miss refuses the move rather than forcing it",
		})
	},
}

// opsResolveExpectedFrom resolves the compare-and-swap precondition.
//
// `preselect` is the status the environment is currently in, and is EMPTY when the id came from the
// command line — see opsResolveEnvironment. An empty preselect with no --from is a refusal, not a
// default: a CAS whose precondition is "whatever it happens to be" is a raw UPDATE wearing a
// compare-and-swap's name.
func opsResolveExpectedFrom(cmd *cobra.Command, preselect string) []string {
	f := mustOpsField(cmd.CommandPath(), opsKeyFrom)
	supplied, _ := cmd.Flags().GetString(f.Flag)
	if strings.TrimSpace(supplied) != "" {
		values := opsSplitStatuses(supplied)
		if len(values) == 0 {
			failf("--%s was given no statuses", f.Flag)
			return nil
		}
		if err := opsValidateStatuses(f.Flag, values); err != nil {
			fail(err)
			return nil
		}
		return values
	}
	if err := requireInteractiveForm(); err != nil {
		fail(opsScripted(f, err))
		return nil
	}
	values, err := opsAskStatuses(f, preselect)
	if err != nil {
		fail(err)
		return nil
	}
	return values
}

// opsResolveTargetStatus resolves the status the environment moves to.
func opsResolveTargetStatus(cmd *cobra.Command) string {
	f := mustOpsField(cmd.CommandPath(), opsKeyTo)
	supplied, _ := cmd.Flags().GetString(f.Flag)
	if strings.TrimSpace(supplied) != "" {
		to := strings.ToUpper(strings.TrimSpace(supplied))
		if err := opsValidateStatuses(f.Flag, []string{to}); err != nil {
			fail(err)
			return ""
		}
		return to
	}
	if err := requireInteractiveForm(); err != nil {
		fail(opsScripted(f, err))
		return ""
	}
	to, err := opsAskStatus(f)
	if err != nil {
		fail(err)
		return ""
	}
	return to
}

func init() {
	registerOpsVerb(opsUnstickEnvCmd)
}
