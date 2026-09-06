// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/runners"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
)

// runHuhForm runs an interactive huh form. It is a variable so a test can supply the
// answer a user would have given.
//
// Measured, not assumed: under `go test` the real implementation returns
// `huh: could not open a new TTY: open /dev/tty: device not configured` — it does NOT
// block. So a test may call straight through and get the error arm; the seam is only
// needed to reach what happens AFTER a successful selection.
//
// Production behaviour is exactly ui.NewForm(groups...).Run().
var runHuhForm = func(groups ...*huh.Group) error {
	return ui.NewForm(groups...).Run()
}

// envLister is the slice of the API client resolveEnvironmentID needs — kept small so the
// resolution logic is unit-testable with a fake (the concrete *api.Client satisfies it).
type envLister interface {
	ListEnvironments(project string) ([]api.Environment, error)
}

// resolveEnvironmentID maps an environment NAME to its id within a project, for the `--env`
// flag on plan/apply/destroy (the decoupled env-model, #843). An empty name returns "" so the
// server resolves the project's default environment (back-compat). An unknown name is a hard
// error that lists the available environments, so a typo never silently targets the default.
func resolveEnvironmentID(client envLister, projectID, envName string) (string, error) {
	if envName == "" {
		return "", nil
	}
	envs, err := client.ListEnvironments(projectID)
	if err != nil {
		return "", fmt.Errorf("resolve --env %q: %w", envName, err)
	}
	for _, e := range envs {
		if e.Name == envName {
			return e.ID, nil
		}
	}
	names := make([]string, len(envs))
	for i, e := range envs {
		names[i] = e.Name
	}
	return "", fmt.Errorf("environment %q not found in project (have: %s)", envName, strings.Join(names, ", "))
}

// runnerOperatorLabel renders a runner's operator/provisioning as a short label:
// "managed", "self·deployed", or "self·registered".
func runnerOperatorLabel(w api.Runner) string {
	if w.Operator == "managed" {
		return "managed"
	}
	if w.Provisioning != "" {
		return "self·" + w.Provisioning
	}
	return "self"
}

// selectProject runs the interactive project picker shared by the project
// plan/apply/destroy commands. Projects are listed flat (top-level projects).
func selectProject(token string) (projectID string, err error) {
	if err := requireInteractiveForm(); err != nil {
		return "", err
	}
	var configs []types.ConfigurationSummary

	runSpinner("Fetching projects...", func() {
		configs, err = api.NewClient(token).GetConfigurations()
	})

	if err != nil {
		return "", fmt.Errorf("failed to fetch projects: %w", err)
	}

	projectOptions := []huh.Option[string]{}
	for _, c := range configs {
		projectOptions = append(projectOptions, huh.NewOption(
			fmt.Sprintf("%s (%s)", c.ProjectName, c.EnvironmentStage),
			c.ID,
		))
	}

	if len(projectOptions) == 0 {
		return "", fmt.Errorf("no projects found — create one through Alethia")
	}

	err = runHuhForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Project").
				Description("Which project to operate on").
				Options(projectOptions...).
				Value(&projectID),
		),
	)

	return projectID, err
}

var (
	statusOnline   = ui.SuccessStyle.Render(ui.SymbolOnline)
	statusOffline  = ui.MutedStyle.Render(ui.SymbolOffline)
	statusDraining = ui.WarningStyle.Render(ui.SymbolPending)
)

func selectRunner(token string, excludeID string) (runnerID string, err error) {
	if err := requireInteractiveForm(); err != nil {
		return "", err
	}
	apiClient := api.NewClient(token)

	var runners []api.Runner

	runSpinner("Fetching runners...", func() {
		runners, err = apiClient.GetRunners()
	})

	if err != nil {
		return "", fmt.Errorf("failed to fetch runners: %w", err)
	}

	options := []huh.Option[string]{
		huh.NewOption(fmt.Sprintf("%s Any available", statusOnline), ""),
	}

	defaultValue := ""

	for _, w := range runners {
		if w.ID == excludeID {
			continue
		}

		var dot string
		switch w.Status {
		case "ONLINE":
			dot = statusOnline
		case "DRAINING":
			dot = statusDraining
		default:
			dot = statusOffline
		}

		label := fmt.Sprintf("%s %s (%s)", dot, w.Name, runnerOperatorLabel(w))
		if w.IsDefault {
			label += ui.DefaultBadge()
		}

		opt := huh.NewOption(label, w.ID)
		if w.Status != "ONLINE" {
			opt = opt.Selected(false)
		}
		options = append(options, opt)

		if w.IsDefault && w.Status == "ONLINE" {
			defaultValue = w.ID
		}
	}

	runnerID = defaultValue

	err = runHuhForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Runner").
				Description("Choose which runner runs this job").
				Options(options...).
				Value(&runnerID),
		),
	)

	return runnerID, err
}

// selectOrgInteractive shows a picker for the active organization.
func selectOrgInteractive(orgs []api.OrgSummary) (*api.OrgSummary, error) {
	options := make([]huh.Option[string], len(orgs))
	for i, o := range orgs {
		label := fmt.Sprintf("%s (%s)", o.Name, o.Role)
		if o.IsActive {
			label += ui.DefaultBadge()
		}
		options[i] = huh.NewOption(label, o.ID)
	}
	var id string
	err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Organization").
				Description("Set the active organization context").
				Options(options...).
				Value(&id),
		),
	)
	if err != nil {
		return nil, err
	}
	return matchOrg(orgs, id), nil
}

// selectCloudIdentity picks from EVERY linked cloud account. This is the right list for
// `project create`, which can target any cloud — it is the WRONG list for `runner deploy`,
// which can only build where a runner template exists (see selectRunnerDeployCloudIdentity).
func selectCloudIdentity(token string) (identityID string, err error) {
	return pickCloudIdentity(token, "Which cloud account to provision into", nil)
}

// selectRunnerDeployCloudIdentity picks from only the cloud accounts a runner can actually be
// deployed into. `infra/templates/runner/` holds `aws` alone, so offering the unfiltered list
// here let a user choose GCP and get a refusal from the server (and, before the server gate
// existed, a job that died in the runner's logs) — the defect #1794 names. The list of clouds
// comes from packages/core/runners, whose test pins it to the template directories.
func selectRunnerDeployCloudIdentity(token string) (identityID string, err error) {
	return pickCloudIdentity(token, "Which cloud account to deploy the runner into", runners.FilterDeployable)
}

// pickCloudIdentity fetches the caller's cloud accounts, narrows them with `narrow` (nil keeps
// all of them) and shows the picker. The empty cases are separate errors on purpose: "you have
// no cloud accounts" and "none of your cloud accounts can host a deployed runner" need
// different next steps from the user.
func pickCloudIdentity(
	token string,
	description string,
	narrow func([]api.CloudIdentity) []api.CloudIdentity,
) (identityID string, err error) {
	if err := requireInteractiveForm(); err != nil {
		return "", err
	}
	apiClient := api.NewClient(token)

	var identities []api.CloudIdentity

	runSpinner("Fetching cloud accounts...", func() {
		identities, err = apiClient.GetCloudIdentities()
	})

	if err != nil {
		return "", fmt.Errorf("failed to fetch cloud identities: %w", err)
	}

	if len(identities) == 0 {
		return "", fmt.Errorf("no cloud accounts linked — connect one through Alethia first")
	}

	if narrow != nil {
		identities = narrow(identities)
		if len(identities) == 0 {
			return "", fmt.Errorf(
				"none of your linked cloud accounts can host a deployed runner — deployed runners are %s only. Register a runner you run yourself instead (Console → Runners → Add runner → Register your own); it runs on any cloud",
				runners.DeployProvidersLabel(),
			)
		}
	}

	options := make([]huh.Option[string], len(identities))
	for i, id := range identities {
		options[i] = huh.NewOption(id.Label, id.ID)
	}

	err = runHuhForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Cloud Account").
				Description(description).
				Options(options...).
				Value(&identityID),
		),
	)

	return identityID, err
}
