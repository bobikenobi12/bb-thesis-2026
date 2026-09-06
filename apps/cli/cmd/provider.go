// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var providerCmd = &cobra.Command{
	Use:     "provider",
	Aliases: []string{"providers"},
	Short:   "Inspect connected cloud provider identities",
	Long: `Show the connection status of a cloud provider identity, or re-run the
server-side health probe (auth + provisioning-capability check) against it.

Use 'alethia connector' to create or change a connection; these commands only
read and re-verify an existing one.`,
}

var providerStatusCmd = &cobra.Command{
	Use:   "status [provider]",
	Short: "Show the connection status of a cloud provider identity",
	Long: `Show the connection status of a cloud provider identity.

Omit the provider for a picker over the accounts you have connected.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		provider, err := resolveProviderRef(client, args)
		if err != nil {
			fail(err)
		}
		if err := runProviderStatus(client, os.Stdout, outputFormat(cmd), provider); err != nil {
			failf("Failed to get %s status: %v", provider, err)
		}
	},
}

// resolveProviderRef turns the optional `[provider]` argument into a provider slug, showing a
// picker over the CONNECTED accounts when it is omitted.
//
// The picker lists what you have connected rather than every provider Alethia supports: these
// two commands read and re-probe an existing connection, so offering a provider with no
// identity behind it can only ever produce "no connected X identity".
func resolveProviderRef(lister cloudIdentityLister, args []string) (string, error) {
	if len(args) == 1 {
		return args[0], nil
	}
	if err := requireInteractiveForm(); err != nil {
		return "", fmt.Errorf(
			"no provider given: pass one (%s) as the argument (%w)",
			strings.Join(connectorProviderNames(), ", "), err,
		)
	}

	var identities []api.CloudIdentity
	var err error
	runSpinner("Fetching cloud connections...", func() {
		identities, err = lister.GetCloudIdentities()
	})
	if err != nil {
		return "", fmt.Errorf("failed to fetch cloud connections: %w", err)
	}
	if len(identities) == 0 {
		return "", fmt.Errorf("no cloud accounts connected — run `alethia connector` first")
	}

	chosenID, err := pickConnectedIdentity("Select a cloud account", identities)
	if err != nil {
		return "", err
	}
	for _, id := range identities {
		if id.ID == chosenID {
			return id.Provider, nil
		}
	}
	return "", fmt.Errorf("no cloud account selected")
}

// providerStatusRows projects a ProviderStatus into field/value cells, showing
// only the identity fields relevant to the connected provider.
func providerStatusRows(s *api.ProviderStatus, outFmt string) [][]string {
	connected := "disconnected"
	if s.Connected {
		connected = "connected"
	}
	rows := [][]string{
		{"status", connected},
		{"identity", ui.Cell(outFmt, s.IdentityID, ui.OrDash(s.IdentityID))},
	}
	add := func(label, value string) {
		if value != "" {
			rows = append(rows, []string{label, value})
		}
	}
	add("account id", s.AccountID)
	add("role arn", s.RoleArn)
	add("project id", s.ProjectID)
	add("service account", s.ServiceAccountEmail)
	add("tenant id", s.TenantID)
	add("client id", s.ClientID)
	add("subscription id", s.SubscriptionID)
	return rows
}

// runProviderStatus fetches and renders a provider's connection status.
func runProviderStatus(c apiClient, out io.Writer, format, provider string) error {
	status, err := c.GetProviderStatus(provider)
	if err != nil {
		return err
	}
	return ui.RenderCard(out, format, "alethia · "+provider+" status", providerStatusRows(status, format), status)
}

var providerVerifyCmd = &cobra.Command{
	Use:   "verify [provider]",
	Short: "Re-run the server-side health probe against a connected identity",
	Long: `Re-run the server-side health probe (auth + provisioning-capability check) against
the connected identity for a provider.

Omit the provider for a picker over the accounts you have connected.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		provider, err := resolveProviderRef(client, args)
		if err != nil {
			fail(err)
		}
		if err := runProviderVerify(client, os.Stdout, outputFormat(cmd), provider); err != nil {
			failf("%v", err)
		}
	},
}

// runProviderVerify resolves the connected identity for a provider and re-runs
// the server-side verification, rendering the verdict. It returns an error (so
// the process exits non-zero) when there is nothing to verify or the probe
// reports the identity is not connected.
func runProviderVerify(c apiClient, out io.Writer, format, provider string) error {
	status, err := c.GetProviderStatus(provider)
	if err != nil {
		return fmt.Errorf("failed to get %s status: %w", provider, err)
	}
	if !status.Connected || status.IdentityID == "" {
		return fmt.Errorf("no connected %s identity to verify — run `alethia connector` first", provider)
	}

	result, err := c.VerifyProviderIdentity(provider, status.IdentityID)
	if err != nil {
		return fmt.Errorf("failed to verify %s connection: %w", provider, err)
	}

	rows := [][]string{
		{"identity", result.IdentityID},
		{"status", result.Status},
		{"verified", fmt.Sprintf("%t", result.Verified)},
	}
	if len(result.MissingPermissions) > 0 {
		rows = append(rows, []string{"missing permissions", strings.Join(result.MissingPermissions, ", ")})
	}
	if result.Error != "" {
		rows = append(rows, []string{"error", result.Error})
	}
	if err := ui.RenderCard(out, format, "alethia · "+provider+" verify", rows, result); err != nil {
		return err
	}

	if !result.Verified {
		return fmt.Errorf("%s connection failed verification (%s)", provider, result.Status)
	}
	if result.Status == "degraded" {
		ui.Warning("Connected, but missing some provisioning permissions.")
	}
	return nil
}

func init() {
	providerCmd.AddCommand(providerStatusCmd)
	providerCmd.AddCommand(providerVerifyCmd)
	rootCmd.AddCommand(providerCmd)
}
