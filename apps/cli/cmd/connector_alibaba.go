// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/cloudshell"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/connector"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	connectorAlibabaRegion    string
	connectorAlibabaDir       string
	connectorAlibabaRoleArn   string
	connectorAlibabaManual    bool
	connectorAlibabaTerraform bool
)

const defaultAlibabaRegion = "cn-hangzhou"

var connectorAlibabaCmd = &cobra.Command{
	Use:   "alibaba",
	Short: "Connect an Alibaba Cloud account",
	Long: `Connect an Alibaba Cloud account using keyless AssumeRoleWithOIDC.

Alethia is its own OIDC issuer. A setup script creates, in your Alibaba account, a RAM
OIDC provider trusting Alethia plus a RAM role; Alethia assumes the role with a
short-lived minted assertion — no AccessKey, nothing stored but the role ARN. Keyless +
account-free: Alethia holds no Alibaba account.

By default the setup runs with your local aliyun CLI. Use --manual to run it in the
Alibaba Cloud Shell and paste back the role ARN, or --terraform to apply the OpenTofu
module instead. Pass --role-arn to submit a role you already created — the flag form of
that same paste, so the command works under --no-input with no aliyun CLI on the
machine.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := refuseMultipleModes(
			modeFlag{"--role-arn", strings.TrimSpace(connectorAlibabaRoleArn) != ""},
			modeFlag{"--terraform", connectorAlibabaTerraform},
			modeFlag{"--manual", connectorAlibabaManual},
		); err != nil {
			fail(err)
		}

		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		apiClient := api.NewClient(token)
		steps := []string{"Initialize", "Create RAM role", "Connection test"}

		origin, _ := types.ResolveWebOrigin()
		issuer := strings.TrimRight(origin, "/") + "/api/oidc"

		ui.PrintStepper(steps, 0)
		initResp, err := initProviderIdentity(apiClient, "alibaba")
		if err != nil {
			fail(err)
		}

		ui.PrintStepper(steps, 1)
		var roleArn string
		switch {
		case strings.TrimSpace(connectorAlibabaRoleArn) != "":
			// The flag half of the manual/terraform flows: the RAM role already exists, so
			// there is nothing to create and nothing to prompt for.
			roleArn = strings.TrimSpace(connectorAlibabaRoleArn)
		case connectorAlibabaTerraform:
			roleArn, err = alibabaTerraformFlow(issuer)
		case connectorAlibabaManual:
			roleArn, err = alibabaManualFlow(issuer)
		default:
			roleArn, err = alibabaLocalFlow(issuer)
		}
		if err != nil {
			fail(err)
		}

		ui.PrintStepper(steps, 2)
		if err := finalizeConnection(apiClient, "alibaba", initResp.IdentityID,
			map[string]interface{}{"role_arn": roleArn}); err != nil {
			fail(err)
		}

		ui.Success(fmt.Sprintf("Alibaba Cloud account connected (role %s)", roleArn))
	},
}

// alibabaLocalFlow runs the setup script with the local aliyun CLI (federating to this
// control plane's issuer) and returns the created RAM role ARN parsed from its output.
func alibabaLocalFlow(issuer string) (string, error) {
	if err := cloudshell.EnsureAliyun(); err != nil {
		ui.Error("aliyun CLI not found on PATH")
		ui.Muted("Install it: https://www.alibabacloud.com/help/en/cli/install-cli")
		ui.Muted("Or re-run with --manual to set it up in the Alibaba Cloud Shell.")
		return "", err
	}
	ui.Info("Running setup via the local aliyun CLI...")
	return cloudshell.RunAlibabaSetup(connector.AlibabaSetupScript, issuer)
}

// alibabaManualFlow guides the user through the Alibaba Cloud Shell and prompts for the
// resulting RAM role ARN.
func alibabaManualFlow(issuer string) (string, error) {
	ui.Info("Manual setup:")
	fmt.Printf("  Open the Alibaba Cloud Shell (%s) and run:\n\n", ui.LinkStyle.Render(alibabaCloudShellURL))
	fmt.Printf(
		"     curl -sO %s/alethia-alibaba-setup.sh && bash alethia-alibaba-setup.sh %s\n\n",
		connectorBaseURL, issuer,
	)
	fmt.Printf("  Then paste the %s it prints below.\n", ui.ValueStyle.Render("role_arn"))

	return promptAlibabaRoleArn()
}

// alibabaTerraformFlow writes the connector module to a local directory, guides the user to apply
// it in their Alibaba account (with the issuer URL of THIS control plane), and prompts for the
// resulting RAM role ARN.
func alibabaTerraformFlow(issuer string) (string, error) {
	dir := connectorAlibabaDir
	if dir == "" {
		dir = "alethia-alibaba-connector"
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create module dir: %w", err)
	}
	modulePath := filepath.Join(dir, "main.tf")
	if err := os.WriteFile(modulePath, []byte(connector.AlibabaConnectorModule), 0o644); err != nil {
		return "", fmt.Errorf("write module: %w", err)
	}

	region := connectorAlibabaRegion
	if region == "" {
		region = defaultAlibabaRegion
	}

	ui.Info("Apply the connector module in your Alibaba account:")
	fmt.Printf("  1. Authenticate to Alibaba (aliyun CLI, or ALICLOUD_ACCESS_KEY / ALICLOUD_SECRET_KEY).\n")
	fmt.Printf("  2. Run:\n\n     cd %s\n     tofu init\n     tofu apply -var \"region=%s\" -var \"alethia_issuer_url=%s\"\n\n",
		dir, region, issuer)
	fmt.Printf("  3. Copy the %s output below.\n", ui.ValueStyle.Render("role_arn"))

	return promptAlibabaRoleArn()
}

// promptAlibabaRoleArn asks the user to paste the RAM role ARN and validates it is non-empty.
func promptAlibabaRoleArn() (string, error) {
	if err := requireInteractiveForm(); err != nil {
		return "", fmt.Errorf("no role ARN given: pass --role-arn (%w)", err)
	}
	var roleArn string
	if err := runHuhForm(huh.NewGroup(
		huh.NewInput().
			Title("RAM Role ARN").
			Placeholder("acs:ram::123456789012:role/AlethiaProvisioner").
			Value(&roleArn),
	)); err != nil {
		return "", err
	}
	roleArn = strings.TrimSpace(roleArn)
	if roleArn == "" {
		return "", fmt.Errorf("no Role ARN provided")
	}
	return roleArn, nil
}

func init() {
	connectorCmd.AddCommand(connectorAlibabaCmd)
	connectorAlibabaCmd.Flags().StringVar(&connectorAlibabaRegion, "region", "", "Alibaba region for the RAM provider (default cn-hangzhou)")
	connectorAlibabaCmd.Flags().StringVar(&connectorAlibabaRoleArn, "role-arn", "", "ARN of a RAM role you already created — submits it instead of prompting (the flag form of --manual)")
	connectorAlibabaCmd.Flags().StringVar(&connectorAlibabaDir, "dir", "", "Directory to write the OpenTofu module into (--terraform; default ./alethia-alibaba-connector)")
	connectorAlibabaCmd.Flags().BoolVar(&connectorAlibabaManual, "manual", false, "Run setup in the Alibaba Cloud Shell and paste the result")
	connectorAlibabaCmd.Flags().BoolVar(&connectorAlibabaTerraform, "terraform", false, "Apply the OpenTofu module instead of running the setup script")
}
