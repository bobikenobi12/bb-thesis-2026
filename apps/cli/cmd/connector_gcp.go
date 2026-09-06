// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/cloudshell"
	"github.com/alethialabs-io/alethialabs/apps/cli/internal/connector"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	connectorGcpProject   string
	connectorGcpWifConfig string
	connectorGcpManual    bool
)

var connectorGcpCmd = &cobra.Command{
	Use:   "gcp",
	Short: "Connect a Google Cloud project",
	Long: `Connect a GCP project using Workload Identity Federation.

The installer runs inside your Google Cloud Shell (authenticated as you), creates
a provisioner service account and a workload identity pool that trusts Alethia,
and returns a credential config — no service account keys are ever created.

Requires a local, authenticated gcloud. Use --manual to instead run the
installer in the browser Cloud Shell and paste the result, or --wif-config to submit
a credential config you already have — the flag form of that same paste, so the
command works under --no-input with no gcloud on the machine.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := refuseMultipleModes(
			modeFlag{"--wif-config", strings.TrimSpace(connectorGcpWifConfig) != ""},
			modeFlag{"--manual", connectorGcpManual},
		); err != nil {
			fail(err)
		}

		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		apiClient := api.NewClient(token)
		steps := []string{"Project", "Cloud Shell setup", "Connection test"}

		ui.PrintStepper(steps, 0)
		if connectorGcpProject == "" {
			if err := requireInteractiveForm(); err != nil {
				failf("no project given: pass --project (%v)", err)
			}
			if err := runHuhForm(huh.NewGroup(
				huh.NewInput().
					Title("GCP Project ID").
					Description("The project Alethia should provision into").
					Value(&connectorGcpProject),
			)); err != nil {
				fail(err)
			}
		}
		connectorGcpProject = strings.TrimSpace(connectorGcpProject)
		if connectorGcpProject == "" {
			failf("A project ID is required")
		}

		initResp, err := initProviderIdentity(apiClient, "gcp")
		if err != nil {
			fail(err)
		}

		ui.PrintStepper(steps, 1)
		var wifJSON string
		switch {
		case connectorGcpWifConfig != "":
			// The flag half of the manual flow: the pool and provisioner already exist, so
			// there is nothing to install and nothing to paste.
			wifJSON, err = readWifConfig(connectorGcpWifConfig, os.Stdin)
		case connectorGcpManual:
			wifJSON, err = gcpManualFlow(connectorGcpProject)
		default:
			wifJSON, err = gcpCloudShellFlow(connectorGcpProject)
		}
		if err != nil {
			fail(err)
		}

		var wif interface{}
		if err := json.Unmarshal([]byte(wifJSON), &wif); err != nil {
			failf("%s", "Captured WIF config is not valid JSON: "+err.Error())
		}

		ui.PrintStepper(steps, 2)
		if err := finalizeConnection(apiClient, "gcp", initResp.IdentityID,
			map[string]interface{}{"wif_config": wif}); err != nil {
			fail(err)
		}

		ui.Success(fmt.Sprintf("GCP project %q connected", connectorGcpProject))
	},
}

// gcpCloudShellFlow runs the installer in the user's Google Cloud Shell.
func gcpCloudShellFlow(projectID string) (string, error) {
	if err := cloudshell.EnsureGcloud(); err != nil {
		switch {
		case errors.Is(err, cloudshell.ErrGcloudNotFound):
			ui.Error("gcloud CLI not found on PATH")
			ui.Muted("Install it: https://cloud.google.com/sdk/docs/install")
		case errors.Is(err, cloudshell.ErrGcloudNotAuthed):
			ui.Error("gcloud is not authenticated")
			ui.Muted("Run this, then retry:\n\n  gcloud auth login")
		}
		ui.Muted("Or re-run with --manual to set it up in the browser Cloud Shell.")
		return "", err
	}

	ui.Info("Running installer via gcloud Cloud Shell (the first run can take a minute)...")
	return cloudshell.RunGcpSetupInCloudShell(connector.GcpSetupScript, projectID)
}

// gcpManualFlow guides the user through running the installer in the browser
// Cloud Shell and pasting the resulting WIF config.
func gcpManualFlow(projectID string) (string, error) {
	ui.Info("Manual setup:")
	fmt.Printf("  1. Open Cloud Shell: %s\n", ui.LinkStyle.Render(gcpCloudShellURL))
	fmt.Printf(
		"  2. Run:\n\n     curl -sO %s/alethia-gcp-setup.sh && bash alethia-gcp-setup.sh %s\n\n",
		connectorBaseURL, projectID,
	)
	fmt.Println("  3. Paste the config it prints (between START CONFIG and END CONFIG) below.")

	if err := requireInteractiveForm(); err != nil {
		return "", fmt.Errorf("no WIF config given: pass --wif-config <path|-> (%w)", err)
	}

	var wifJSON string
	if err := runHuhForm(huh.NewGroup(
		huh.NewText().
			Title("WIF credential config JSON").
			Value(&wifJSON),
	)); err != nil {
		return "", err
	}
	if strings.TrimSpace(wifJSON) == "" {
		return "", fmt.Errorf("no WIF config provided")
	}
	return wifJSON, nil
}

// readWifConfig loads the WIF credential config the --wif-config flag names: a file path, or
// "-" for stdin.
//
// A PATH rather than the JSON itself, deliberately. The form asks for a pasted blob of about
// a kilobyte; the same value on a command line lands in the shell history and the process
// list, and every shell in the world would need it quoted correctly. A path (or a pipe) is
// the same field in the form a script can actually supply.
func readWifConfig(ref string, stdin io.Reader) (string, error) {
	if ref == "-" {
		raw, err := io.ReadAll(stdin)
		if err != nil {
			return "", fmt.Errorf("read WIF config from stdin: %w", err)
		}
		if strings.TrimSpace(string(raw)) == "" {
			return "", fmt.Errorf("no WIF config on stdin")
		}
		return string(raw), nil
	}
	raw, err := os.ReadFile(ref)
	if err != nil {
		return "", fmt.Errorf("read WIF config %q: %w", ref, err)
	}
	if strings.TrimSpace(string(raw)) == "" {
		return "", fmt.Errorf("WIF config %q is empty", ref)
	}
	return string(raw), nil
}

func init() {
	connectorCmd.AddCommand(connectorGcpCmd)
	connectorGcpCmd.Flags().StringVar(&connectorGcpProject, "project", "", "GCP project ID")
	connectorGcpCmd.Flags().StringVar(&connectorGcpWifConfig, "wif-config", "", "Path to a WIF credential config JSON you already have (or - for stdin) — the flag form of --manual")
	connectorGcpCmd.Flags().BoolVar(&connectorGcpManual, "manual", false, "Run the installer in the browser Cloud Shell and paste the result")
}
