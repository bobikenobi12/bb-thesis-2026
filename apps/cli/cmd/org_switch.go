// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var orgSwitchCmd = &cobra.Command{
	Use:   "switch [org]",
	Short: "Switch the active organization",
	Long: `Set the active organization context. Pass an org id, slug, or name; with no
argument, pick one interactively. The selection is persisted locally and sent as
the X-Alethia-Org header on subsequent commands.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		target := ""
		if len(args) > 0 {
			target = args[0]
		}
		if err := runOrgSwitch(api.NewClient(token), os.Stdout, target); err != nil {
			fail(err)
		}
	},
}

// runOrgSwitch resolves target (id/slug/name, or an interactive pick when empty)
// to one of the caller's orgs and persists it as the active context.
func runOrgSwitch(c apiClient, out io.Writer, target string) error {
	// Refused BEFORE the fetch: whether a scripted caller may be asked to pick does not depend on
	// what the server holds, so asking it would only slow the refusal down — and "no organizations
	// available" is a badly wrong thing to tell someone whose real problem is --no-input.
	if target == "" && !canPromptForm() {
		return refuseNoForm(mustOrgField("alethia org switch", orgFieldKeyOrg))
	}
	orgs, err := c.ListOrgs()
	if err != nil {
		return err
	}
	if len(orgs) == 0 {
		return fmt.Errorf("no organizations available")
	}

	var chosen *api.OrgSummary
	if target == "" {
		// The form gate and not requireInteractive: the picker needs somewhere to DRAW, which is
		// stderr and not stdout (ui.InteractiveOutput records the measurement). Without it
		// `alethia org switch 2> log` from an interactive shell sent the form's ANSI frames into
		// the log and looked hung. Already answered above, before the fetch.
		chosen, err = selectOrgInteractive(orgs)
		if err != nil {
			return err
		}
	} else {
		chosen = matchOrg(orgs, target)
		if chosen == nil {
			return fmt.Errorf("no organization matching %q", target)
		}
	}

	if err := saveActiveOrg(*chosen); err != nil {
		return fmt.Errorf("failed to save active organization: %w", err)
	}
	fmt.Fprintln(out, ui.FormatSuccess("Active organization set to "+chosen.Name))
	return nil
}

// matchOrg returns the org whose id, slug, or name equals target, or nil.
func matchOrg(orgs []api.OrgSummary, target string) *api.OrgSummary {
	for i := range orgs {
		if orgs[i].ID == target || orgs[i].Slug == target || orgs[i].Name == target {
			return &orgs[i]
		}
	}
	return nil
}

func init() {
	orgCmd.AddCommand(orgSwitchCmd)
}
