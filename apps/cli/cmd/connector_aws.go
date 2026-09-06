// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"net/url"
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
	connectorAwsRegion   string
	connectorAwsRoleName string
	connectorAwsRoleArn  string
	connectorAwsManual   bool
	connectorAwsScript   bool
)

const defaultAwsRoleName = "AlethiaProvisionerRole"

var connectorAwsCmd = &cobra.Command{
	Use:   "aws",
	Short: "Connect an AWS account",
	Long: `Connect an AWS account using a keyless, issuer-direct IAM role.

Alethia deploys a CloudFormation stack that creates an IAM OIDC provider trusting
the Alethia issuer and a role Alethia assumes via AssumeRoleWithWebIdentity — no
access keys and no external id.

By default the stack is deployed with your local aws CLI. Use --manual to deploy
it from the AWS console and paste back the role ARN, or --role-arn to submit a role
you already created — the flag form of that same paste, so the command works under
--no-input with no aws CLI on the machine.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := refuseMultipleModes(
			modeFlag{"--role-arn", strings.TrimSpace(connectorAwsRoleArn) != ""},
			modeFlag{"--manual", connectorAwsManual},
			modeFlag{"--script", connectorAwsScript},
		); err != nil {
			fail(err)
		}

		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		apiClient := api.NewClient(token)
		steps := []string{"Initialize", "Create IAM role", "Connection test"}

		ui.PrintStepper(steps, 0)
		initResp, err := initProviderIdentity(apiClient, "aws")
		if err != nil {
			fail(err)
		}

		// The customer's role trusts THIS control plane's issuer (derived from the web origin).
		origin, _ := types.ResolveWebOrigin()
		issuerURL := strings.TrimRight(origin, "/") + "/api/oidc"

		ui.PrintStepper(steps, 1)
		var roleArn string
		switch {
		case strings.TrimSpace(connectorAwsRoleArn) != "":
			// The flag half of the manual flow: the role already exists, so there is nothing to
			// create and nothing to prompt for.
			roleArn = strings.TrimSpace(connectorAwsRoleArn)
		case connectorAwsManual:
			roleArn, err = awsManualFlow(issuerURL)
		case connectorAwsScript:
			roleArn, err = awsScriptFlow(issuerURL)
		default:
			roleArn, err = awsLocalFlow(issuerURL)
		}
		if err != nil {
			fail(err)
		}

		ui.PrintStepper(steps, 2)
		if err := finalizeConnection(apiClient, "aws", initResp.IdentityID,
			map[string]interface{}{"role_arn": roleArn}); err != nil {
			fail(err)
		}

		ui.Success(fmt.Sprintf("AWS account connected (role %s)", roleArn))
	},
}

// awsLocalFlow deploys the CloudFormation stack with the local aws CLI and
// returns the created role ARN.
func awsLocalFlow(issuerURL string) (string, error) {
	if err := cloudshell.EnsureAws(); err != nil {
		ui.Error("aws CLI not found on PATH")
		ui.Muted("Install it: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html")
		ui.Muted("Or re-run with --manual to deploy from the AWS console.")
		return "", err
	}

	roleName := connectorAwsRoleName
	if roleName == "" {
		roleName = defaultAwsRoleName
	}

	ui.Info("Deploying the CloudFormation stack via the local aws CLI...")
	return cloudshell.RunAwsBootstrap(
		connector.AwsBootstrapTemplate,
		issuerURL,
		connectorAwsRegion,
		roleName,
		"AlethiaConnect",
	)
}

// awsScriptFlow runs the aws-CLI setup script locally (federating to the given issuer) and
// returns the created role ARN — an alternative to the CloudFormation stack for users who
// prefer the shell path (mirrors the console's "AWS CLI / CloudShell" tab).
func awsScriptFlow(issuerURL string) (string, error) {
	if err := cloudshell.EnsureAws(); err != nil {
		ui.Error("aws CLI not found on PATH")
		ui.Muted("Install it: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html")
		ui.Muted(fmt.Sprintf("Or run it in AWS CloudShell (%s) with --manual.", awsCloudShellURL))
		return "", err
	}
	ui.Info("Running the setup script via the local aws CLI...")
	return cloudshell.RunAwsSetupScript(connector.AwsSetupScript, issuerURL)
}

// awsManualFlow prints a CloudFormation quick-create link and prompts for the
// resulting role ARN.
func awsManualFlow(issuerURL string) (string, error) {
	templateURL := connectorBaseURL + "/alethia-bootstrap.yaml"
	quickCreate := fmt.Sprintf(
		"https://console.aws.amazon.com/cloudformation/home#/stacks/quickcreate?templateURL=%s&stackName=AlethiaConnect&param_IssuerUrl=%s",
		url.QueryEscape(templateURL), url.QueryEscape(issuerURL),
	)

	ui.Info("Manual setup:")
	fmt.Printf("  1. Open the CloudFormation quick-create link:\n\n     %s\n\n", ui.LinkStyle.Render(quickCreate))
	fmt.Println("  2. Create the stack (it trusts the Alethia issuer — no external id), then copy its RoleArn output below.")

	if err := requireInteractiveForm(); err != nil {
		return "", fmt.Errorf("no role ARN given: pass --role-arn (%w)", err)
	}

	var roleArn string
	if err := runHuhForm(huh.NewGroup(
		huh.NewInput().
			Title("Role ARN").
			Placeholder("arn:aws:iam::123456789012:role/AlethiaProvisionerRole-...").
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
	connectorCmd.AddCommand(connectorAwsCmd)
	connectorAwsCmd.Flags().StringVar(&connectorAwsRegion, "region", "", "AWS region for the CloudFormation stack")
	connectorAwsCmd.Flags().StringVar(&connectorAwsRoleName, "role-name", defaultAwsRoleName, "Name for the cross-account IAM role")
	connectorAwsCmd.Flags().StringVar(&connectorAwsRoleArn, "role-arn", "", "ARN of a role you already created — submits it instead of prompting (the flag form of --manual)")
	connectorAwsCmd.Flags().BoolVar(&connectorAwsManual, "manual", false, "Deploy from the AWS console and paste the role ARN")
	connectorAwsCmd.Flags().BoolVar(&connectorAwsScript, "script", false, "Use the aws-CLI setup script instead of the CloudFormation stack")
}
