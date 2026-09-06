// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// connectorRemoveYes is the --yes opt-in: skip the confirmation prompt (and make
// the command usable with --no-input).
var connectorRemoveYes bool

var connectorRemoveCmd = &cobra.Command{
	Use:   "remove [provider]",
	Short: "Disconnect a cloud account",
	Long: `Disconnect a cloud account, resetting it to a pending state and orphaning
any projects that referenced it. Pass a provider to skip the picker.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		apiClient := api.NewClient(token)

		var identities []api.CloudIdentity
		runSpinner("Fetching cloud connections...", func() {
			identities, err = apiClient.GetCloudIdentities()
		})
		if err != nil {
			fail(err)
		}
		if len(identities) == 0 {
			ui.Muted("No cloud accounts connected.")
			return
		}

		selected, err := pickIdentity(identities, args)
		if err != nil {
			fail(err)
		}

		if !confirmDestructive(
			connectorRemoveYes,
			fmt.Sprintf("Disconnect %s?", selected.Label),
			"Projects using this account will be orphaned.",
		) {
			return
		}

		if err := apiClient.DisconnectProviderIdentity(selected.Provider, selected.ID); err != nil {
			fail(err)
		}
		ui.Success(fmt.Sprintf("Disconnected %s", selected.Label))
	},
}

// pickIdentity resolves the identity to remove from a provider argument, or via
// an interactive picker when none is given.
func pickIdentity(identities []api.CloudIdentity, args []string) (*api.CloudIdentity, error) {
	if len(args) == 1 {
		provider := strings.ToLower(args[0])
		for i := range identities {
			if identities[i].Provider == provider {
				return &identities[i], nil
			}
		}
		return nil, fmt.Errorf("no connected %s account found", provider)
	}

	// Refuse before opening a form that can never be answered. Without this the scripted
	// no-argument case died on huh's raw "could not open a new TTY" — a message about a device
	// file, for a user whose actual mistake was omitting the provider argument.
	if err := requireInteractiveForm(); err != nil {
		return nil, fmt.Errorf(
			"no connection given: pass a provider (%s) as the argument (%w)",
			strings.Join(connectorProviderNames(), ", "), err,
		)
	}

	chosenID, err := pickConnectedIdentity("Select a connection to remove", identities)
	if err != nil {
		return nil, err
	}

	for i := range identities {
		if identities[i].ID == chosenID {
			return &identities[i], nil
		}
	}
	return nil, fmt.Errorf("no connection selected")
}

func init() {
	connectorCmd.AddCommand(connectorRemoveCmd)
	addYesFlag(connectorRemoveCmd, &connectorRemoveYes)
}
