// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/cloudshell"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/connector"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	connectorAzureSubscription string
	connectorAzureTenantID     string
	connectorAzureClientID     string
	connectorAzureManual       bool
)

var connectorAzureCmd = &cobra.Command{
	Use:   "azure",
	Short: "Connect an Azure subscription",
	Long: `Connect an Azure subscription using federated identity.

The setup creates a user-assigned managed identity in your subscription (a plain ARM
resource — no App Registration, no client secret) with a federated credential trusting
Alethia's OIDC issuer, and grants it a least-privilege role. There is no platform Entra
app: Alethia authenticates AS your managed identity, whose client id the setup prints.

By default the setup runs with your local az CLI. Use --manual to run it in
Azure Cloud Shell and paste back the tenant, client, and subscription IDs, or pass
--tenant-id and --client-id for a managed identity you already created — the flag
form of that same paste, so the command works under --no-input with no az CLI on the
machine.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := refuseMultipleModes(
			modeFlag{"--tenant-id/--client-id", strings.TrimSpace(connectorAzureTenantID) != "" ||
				strings.TrimSpace(connectorAzureClientID) != ""},
			modeFlag{"--manual", connectorAzureManual},
		); err != nil {
			fail(err)
		}

		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		apiClient := api.NewClient(token)
		steps := []string{"Subscription", "Create managed identity", "Connection test"}

		ui.PrintStepper(steps, 0)
		if connectorAzureSubscription == "" {
			if err := requireInteractiveForm(); err != nil {
				failf("no subscription given: pass --subscription (%v)", err)
			}
			if err := runHuhForm(huh.NewGroup(
				huh.NewInput().
					Title("Azure Subscription ID").
					Description("The subscription Alethia should provision into").
					Value(&connectorAzureSubscription),
			)); err != nil {
				fail(err)
			}
		}
		connectorAzureSubscription = strings.TrimSpace(connectorAzureSubscription)
		if connectorAzureSubscription == "" {
			failf("A subscription ID is required")
		}

		initResp, err := initProviderIdentity(apiClient, "azure")
		if err != nil {
			fail(err)
		}

		ui.PrintStepper(steps, 1)
		var ids *cloudshell.AzureIDs
		switch {
		case connectorAzureTenantID != "" || connectorAzureClientID != "":
			// The flag half of the manual flow: the managed identity already exists, so there
			// is nothing to create and nothing to paste. Both ids are required together — a
			// half-given pair is a mistake, not a partial instruction.
			ids, err = azureFlagIDs(connectorAzureTenantID, connectorAzureClientID, connectorAzureSubscription)
		case connectorAzureManual:
			ids, err = azureManualFlow(connectorAzureSubscription)
		default:
			ids, err = azureLocalFlow(connectorAzureSubscription)
		}
		if err != nil {
			fail(err)
		}

		ui.PrintStepper(steps, 2)
		creds := map[string]interface{}{
			"tenant_id":       ids.TenantID,
			"client_id":       ids.ClientID,
			"subscription_id": ids.SubscriptionID,
		}
		if err := finalizeConnection(apiClient, "azure", initResp.IdentityID, creds); err != nil {
			fail(err)
		}

		ui.Success(fmt.Sprintf("Azure subscription %q connected", ids.SubscriptionID))
	},
}

// azureLocalFlow runs the setup script with the local az CLI. The script creates the
// managed identity in the subscription and prints its client id (captured from output).
func azureLocalFlow(subscriptionID string) (*cloudshell.AzureIDs, error) {
	if err := cloudshell.EnsureAz(); err != nil {
		ui.Error("az CLI not found on PATH")
		ui.Muted("Install it: https://learn.microsoft.com/cli/azure/install-azure-cli")
		ui.Muted("Or re-run with --manual to set it up in Azure Cloud Shell.")
		return nil, err
	}

	ui.Info("Running setup via the local az CLI...")
	return cloudshell.RunAzureSetup(connector.AzureSetupScript, subscriptionID)
}

// azureManualFlow guides the user through Azure Cloud Shell and prompts for the
// resulting tenant/client/subscription IDs. The client id is the managed identity the
// script creates in the subscription (printed in its output), not a platform app.
func azureManualFlow(subscriptionID string) (*cloudshell.AzureIDs, error) {
	ui.Info("Manual setup:")
	fmt.Printf("  Open Azure Cloud Shell (%s) and run:\n\n", ui.LinkStyle.Render(azureCloudShellURL))
	fmt.Printf(
		"     curl -sO %s/alethia-azure-setup.sh && bash alethia-azure-setup.sh %s\n\n",
		connectorBaseURL, subscriptionID,
	)
	fmt.Println("  Then paste the values it prints below.")

	if err := requireInteractiveForm(); err != nil {
		return nil, fmt.Errorf("no identity ids given: pass --tenant-id and --client-id (%w)", err)
	}

	ids := &cloudshell.AzureIDs{SubscriptionID: subscriptionID}
	if err := runHuhForm(huh.NewGroup(
		huh.NewInput().Title("Tenant ID").Value(&ids.TenantID),
		huh.NewInput().Title("Client ID").Description("The managed identity's application id").Value(&ids.ClientID),
		huh.NewInput().Title("Subscription ID").Value(&ids.SubscriptionID),
	)); err != nil {
		return nil, err
	}

	ids.TenantID = strings.TrimSpace(ids.TenantID)
	ids.ClientID = strings.TrimSpace(ids.ClientID)
	ids.SubscriptionID = strings.TrimSpace(ids.SubscriptionID)
	if ids.TenantID == "" || ids.ClientID == "" || ids.SubscriptionID == "" {
		return nil, fmt.Errorf("tenant, client, and subscription IDs are all required")
	}
	return ids, nil
}

// azureFlagIDs validates the flag-supplied triple. It requires the tenant and client ids
// TOGETHER: a connection made with one of them missing would be stored and then fail its
// health probe with an Azure-side message, which reads as a cloud fault rather than as the
// missing flag it is.
func azureFlagIDs(tenantID, clientID, subscriptionID string) (*cloudshell.AzureIDs, error) {
	ids := &cloudshell.AzureIDs{
		TenantID:       strings.TrimSpace(tenantID),
		ClientID:       strings.TrimSpace(clientID),
		SubscriptionID: strings.TrimSpace(subscriptionID),
	}
	var missing []string
	if ids.TenantID == "" {
		missing = append(missing, "--tenant-id")
	}
	if ids.ClientID == "" {
		missing = append(missing, "--client-id")
	}
	if ids.SubscriptionID == "" {
		missing = append(missing, "--subscription")
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("missing %s — the tenant, client and subscription ids are required together", strings.Join(missing, " and "))
	}
	return ids, nil
}

func init() {
	connectorCmd.AddCommand(connectorAzureCmd)
	connectorAzureCmd.Flags().StringVar(&connectorAzureSubscription, "subscription", "", "Azure subscription ID")
	connectorAzureCmd.Flags().StringVar(&connectorAzureTenantID, "tenant-id", "", "Azure tenant ID of a managed identity you already created (with --client-id)")
	connectorAzureCmd.Flags().StringVar(&connectorAzureClientID, "client-id", "", "Client (application) ID of a managed identity you already created (with --tenant-id)")
	connectorAzureCmd.Flags().BoolVar(&connectorAzureManual, "manual", false, "Run setup in Azure Cloud Shell and paste the result")
}
