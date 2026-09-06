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
	"github.com/alethialabs-io/alethialabs/packages/core/runners"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var (
	registerRunnerName    string
	registerCloudAccount  string
	registerCloudIdentity string
)

var runnerRegisterCmd = &cobra.Command{
	Use:   "register [name]",
	Short: "Register a runner you run yourself, on any cloud",
	Args:  cobra.MaximumNArgs(1),
	Long: fmt.Sprintf(`Registers a self-operated runner and prints its token once.

Nothing is provisioned: you run the runner, anywhere that can reach the control plane —
a VM on any cloud, a container, or your own hardware. That is what makes this the answer
for the clouds `+"`runner deploy`"+` cannot reach. Deployed runners are %s only, because
Alethia holds runner infrastructure templates for no other cloud; a registered runner has
no such limit.

On a terminal the name is asked for when omitted, and an optional cloud account is offered.
Both are flags too, so the command runs unattended: pass the name (as the argument or --name)
and, if the runner should be bound to a cloud account, --cloud-account by its label.

The token is shown ONCE. Only its SHA-256 is stored, so it cannot be recovered — if you
lose it, register another runner and remove this one.`, runners.DeployProvidersLabel()),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		apiClient := api.NewClient(token)

		name := registerRunnerName
		if len(args) == 1 && args[0] != "" {
			if name != "" && name != args[0] {
				fail(fmt.Errorf(
					"the name argument (%q) and --name (%q) disagree: pass one", args[0], name))
			}
			name = args[0]
		}
		if name == "" {
			// The interactive path this command never had. Before it, an omitted name exited 1
			// with the flag spelled out — correct for a script and useless at a terminal, where
			// the whole group's other commands ask.
			if !canPromptForm() {
				failf("a runner name is required: pass it as the argument, or --name")
			}
			if err := runHuhForm(
				huh.NewGroup(
					huh.NewInput().
						Title("Runner name").
						Description("How this runner appears in `alethia runner list`").
						Value(&name).
						Placeholder("my-box-1"),
				),
			); err != nil {
				fail(err)
			}
			name = strings.TrimSpace(name)
		}

		identityID, err := registerIdentityID(apiClient, registerCloudAccount, registerCloudIdentity)
		if err != nil {
			fail(err)
		}
		if identityID == "" && canPromptForm() {
			identityID, err = offerRunnerCloudBinding(apiClient)
			if err != nil {
				fail(err)
			}
		}

		if err := runRunnerRegister(apiClient, os.Stdout, name, identityID); err != nil {
			failf("Failed to register runner: %v", err)
		}
	},
}

// registerIdentityID resolves the cloud account a registration binds to, from the LABEL-or-id
// ref or the raw id form. A registered runner may bind to ANY cloud — it is not narrowed the way
// `runner deploy` is, because nothing is provisioned and no runner template is involved.
func registerIdentityID(c cloudIdentityLister, ref, id string) (string, error) {
	if ref != "" && id != "" {
		return "", fmt.Errorf(
			"--cloud-account and --cloud-identity-id both name the cloud account: pass one " +
				"(--cloud-account takes the label or the id)")
	}
	if ref != "" {
		return resolveCloudIdentityID(c, ref)
	}
	return id, nil
}

// offerRunnerCloudBinding asks, on a terminal, whether to bind the new runner to a cloud
// account, and returns the chosen id ("" for none).
//
// A listing failure is a WARNING here and not a fatal error, because the binding is optional and
// the registration is not: refusing to register a runner because an optional offer could not be
// rendered would be a worse answer than registering it unbound, which is what omitting the flag
// already means. The warning is printed so the skip is visible rather than silent.
func offerRunnerCloudBinding(c cloudIdentityLister) (string, error) {
	var identities []api.CloudIdentity
	var err error
	runSpinner("Fetching cloud accounts...", func() {
		identities, err = c.GetCloudIdentities()
	})
	if err != nil {
		ui.Warning(fmt.Sprintf(
			"Could not list cloud accounts (%v) — registering the runner unbound. "+
				"Pass --cloud-account to bind it.", err))
		return "", nil
	}
	if len(identities) == 0 {
		return "", nil
	}

	options := make([]huh.Option[string], 0, len(identities)+1)
	// The "none" option is first and is the default: a registered runner does not need a cloud
	// account, and a picker whose first entry is an account would make the common answer the one
	// that takes extra keystrokes to avoid.
	options = append(options, huh.NewOption("— none (the runner is not bound to a cloud account) —", ""))
	for _, id := range identities {
		options = append(options, huh.NewOption(
			fmt.Sprintf("%s — %s", strings.ToUpper(id.Provider), id.Label), id.ID))
	}
	var chosen string
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Bind to a cloud account?").
				Description("Optional — it records which account this runner operates in").
				Options(options...).
				Value(&chosen),
		),
	); err != nil {
		return "", err
	}
	return chosen, nil
}

// runRunnerRegister registers the runner and prints the credentials the operator must copy.
//
// The token goes to STDOUT as `ALETHIA_RUNNER_ID` / `ALETHIA_RUNNER_TOKEN` assignments rather than as
// prose, because the next thing that happens to it is being pasted into an env file or a systemd
// unit — and a value a reader has to extract from a sentence is a value they can get wrong.
func runRunnerRegister(c apiClient, out io.Writer, name, cloudIdentityID string) error {
	if name == "" {
		return fmt.Errorf("a runner name is required (pass it as the argument, or --name)")
	}
	reg, err := c.RegisterRunner(name, cloudIdentityID)
	if err != nil {
		return err
	}
	if reg == nil {
		return fmt.Errorf("the server returned no runner registration")
	}

	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Registered runner %s (%s)", reg.Runner.Name, reg.Runner.ID)))
	fmt.Fprintln(out)
	fmt.Fprintf(out, "ALETHIA_RUNNER_ID=%s\n", reg.Runner.ID)
	fmt.Fprintf(out, "ALETHIA_RUNNER_TOKEN=%s\n", reg.RunnerToken)
	fmt.Fprintln(out)
	fmt.Fprintln(out, ui.MutedStyle.Render("The token is shown once — only its hash is stored. Copy it now."))
	fmt.Fprintln(out, ui.MutedStyle.Render("Give both to the runner process, then check `alethia runner list` for its heartbeat."))
	return nil
}

func init() {
	runnerRegisterCmd.Flags().StringVar(&registerRunnerName, "name", "", "Runner name (or pass it as the argument)")
	runnerRegisterCmd.Flags().StringVar(&registerCloudAccount, "cloud-account", "",
		"Bind the runner to a cloud account, by LABEL or id (optional)")
	runnerRegisterCmd.Flags().StringVar(&registerCloudIdentity, "cloud-identity-id", "",
		"Cloud identity id to bind to (prefer --cloud-account, which also takes the label)")
	runnerCmd.AddCommand(runnerRegisterCmd)
}
