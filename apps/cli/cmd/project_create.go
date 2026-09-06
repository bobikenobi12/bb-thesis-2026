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

var (
	projectCreateRegion     string
	projectCreateIdentity   string
	projectCreateAccount    string
	projectCreateStage      string
	projectCreateIacVersion string
	projectCreatePlacement  string
	projectCreateEnvs       []string
)

// This is the command the programme was started over. The complaint, verbatim:
//
//	alethia project create boutique \
//	  --region <your-region> --cloud-identity-id <your-identity-id> \
//	  --env prod:production:dedicated \
//	  --env dev-1:development:namespace:boutique-dev-1
//
// A four-field colon tuple typed three times, with two opaque ids copied out of other
// commands' output. Three things changed, and none of them removed a flag:
//
//   - the tuple is ASKED FOR, one environment at a time, from pickers built out of the
//     generated enums — and the equivalent `--env` line is printed back, so the answer to
//     "what do I commit to my repo" is on screen rather than in the docs;
//   - `--cloud-account` takes the account's LABEL, so the identity id never has to be
//     copied out of `alethia connector list`;
//   - a mis-typed rung or stage is refused HERE, against the same generated enum the
//     server's zod enum is generated from, instead of coming back as an opaque 400.
//
// What did not change: every question has a flag, so `--no-input` still drives the whole
// command. TestHygCliProject_EveryLeafThatAsksCanBeScripted holds that.

var projectCreateCmd = &cobra.Command{
	Use:   "create [name]",
	Short: "Create a new project",
	Long: `Create a new project (an infrastructure app) in the active organization.

Pass --region and --cloud-account, or omit them on a terminal to be asked. --env declares
the whole environment matrix in one command; omit it on a terminal and each environment is
asked for in turn, then printed back as the flags that would produce the same project.

A default environment is created with the project; add component resources afterwards with
"alethia project component add".`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		ask := promptsEnabled()
		asked := false

		name := ""
		if len(args) == 1 {
			name = strings.TrimSpace(args[0])
		}
		if name == "" {
			if !ask {
				failf("a project name is required (pass it as the argument)")
			}
			if name, err = promptProjectName(); err != nil {
				fail(err)
			}
			asked = true
		}

		// No `&& ask` guard: promptRegion short-circuits through requireInteractive, so a
		// scripted run with no --region dies naming the flag instead of sending an empty
		// region the server refuses with "Invalid request body". The region is REQUIRED and
		// has no server-side default, which is what separates it from the cloud account below.
		region := projectCreateRegion
		if region == "" {
			if region, err = promptRegion(); err != nil {
				fail(err)
			}
			asked = true
		}

		// --cloud-account (a label or an id) and the older --cloud-identity-id (an id) both
		// land here. The id flag is kept working rather than removed: scripts pass it today,
		// and this lane's job is to stop REQUIRING an id, not to break the ones that have one.
		identity := projectCreateIdentity
		accountRef := projectCreateAccount
		// Both flags name the SAME field, so passing both is refused rather than resolved by
		// precedence — the same rule projectIDForJob applies to --project/--project-id, for a
		// sharper reason here: preferring the id skips resolving the label (an unknown or
		// ambiguous one would never be reported), and createReplayArgs then prints
		// `--cloud-account <label>`, a line that links a DIFFERENT account than the run did.
		if identity != "" && accountRef != "" {
			failf("--cloud-account and --cloud-identity-id both name the cloud account: pass one (--cloud-account takes the label or the id)")
		}
		if identity == "" && accountRef != "" {
			if identity, err = resolveCloudIdentityID(client, accountRef); err != nil {
				fail(err)
			}
		}
		if identity == "" && ask {
			// Best-effort: a project may be created with no cloud account linked, so a
			// dismissed picker is not fatal.
			identity, _ = selectCloudIdentity(token)
			asked = true
		}

		if err := validateOneOf("stage", projectCreateStage, environmentStages()); err != nil {
			fail(err)
		}
		if err := validateOneOf("placement-mode", projectCreatePlacement, placementModes()); err != nil {
			fail(err)
		}

		matrix := projectCreateEnvs
		if len(matrix) == 0 && ask {
			if matrix, err = promptEnvMatrix(); err != nil {
				fail(err)
			}
			if len(matrix) > 0 {
				asked = true
			}
		}
		environments, err := parseEnvMatrix(matrix)
		if err != nil {
			fail(err)
		}

		params := api.CreateProjectParams{
			ProjectName:     name,
			Region:          region,
			CloudIdentityID: identity,
			Stage:           projectCreateStage,
			IacVersion:      projectCreateIacVersion,
			Placement:       projectCreatePlacement,
			Environments:    environments,
		}
		if err := runProjectCreate(client, os.Stdout, outputFormat(cmd), params); err != nil {
			failf("Failed to create project: %v", err)
		}
		printReplay(os.Stdout, outputFormat(cmd), asked, createReplayArgs(params, accountRef, matrix)...)
	},
}

// createReplayArgs renders the `project create` that would have produced this project.
//
// It takes the SENT params rather than a hand-picked subset of them, because a replay line is
// only worth printing if running it reproduces the run: --stage, --placement-mode and
// --iac-version each change the project that comes out, and a line that dropped them invited
// the reader to commit a command that creates a `development` project on the server's default
// placement with an unpinned OpenTofu version.
//
// It prefers the LABEL the caller (or the picker) used over the resolved identity id,
// because a replay line carrying a UUID is the thing this command exists to stop printing.
// The id appears only when that is all we have — the picker returns one — and the docs say
// so rather than the line pretending otherwise.
func createReplayArgs(params api.CreateProjectParams, accountRef string, envs []string) []string {
	args := []string{"alethia", "project", "create", params.ProjectName}
	if params.Region != "" {
		args = append(args, "--region", params.Region)
	}
	switch {
	case accountRef != "":
		args = append(args, "--cloud-account", accountRef)
	case params.CloudIdentityID != "":
		args = append(args, "--cloud-identity-id", params.CloudIdentityID)
	}
	if params.Stage != "" {
		args = append(args, "--stage", params.Stage)
	}
	if params.Placement != "" {
		args = append(args, "--placement-mode", params.Placement)
	}
	if params.IacVersion != "" {
		args = append(args, "--iac-version", params.IacVersion)
	}
	for _, e := range envs {
		args = append(args, "--env", e)
	}
	return args
}

// parseEnvMatrix turns repeatable `--env name:stage[:mode[:namespace]]` flags into the environment
// MATRIX the create front door fans out. Nothing is defaulted here beyond the placement mode: the
// server validates the matrix with the console form's own schema, so inventing values locally would
// only move a rejection further from the thing that decides it.
//
// The first entry is the DEFAULT environment. The matrix is what makes a two-tier project cost one
// cluster instead of two — without it every environment comes out `dedicated`.
//
//	--env prod:production                          → dedicated (the default mode for a first env)
//	--env dev:development:namespace:boutique-dev   → placed as a namespace on the shared Fabric
//	--env staging:staging:vcluster                 → placed as a vcluster, namespace derived
//
// The stage and the mode ARE checked against the generated enums (see validateOneOf), because a
// typo in a positional tuple is otherwise a 400 that names neither the entry nor the field. The
// name and the namespace are not: their grammar is #3665's single implementation and a copy here
// would be the second opinion that lane exists to delete.
func parseEnvMatrix(specs []string) ([]api.EnvironmentSpec, error) {
	if len(specs) == 0 {
		return nil, nil
	}
	out := make([]api.EnvironmentSpec, 0, len(specs))
	seen := map[string]bool{}
	for _, raw := range specs {
		parts := strings.Split(raw, ":")
		if len(parts) < 2 || len(parts) > 4 {
			return nil, fmt.Errorf("invalid --env %q (want name:stage[:mode[:namespace]])", raw)
		}
		name := strings.TrimSpace(parts[0])
		stage := strings.TrimSpace(parts[1])
		if name == "" || stage == "" {
			return nil, fmt.Errorf("invalid --env %q — name and stage are both required", raw)
		}
		if seen[name] {
			return nil, fmt.Errorf("--env lists %q twice", name)
		}
		seen[name] = true

		spec := api.EnvironmentSpec{
			Name:  name,
			Stage: stage,
			// The FIRST entry owns the Fabric it provisions, so it defaults to `dedicated`; a later
			// entry defaults to `namespace`, the cheap rung. Both are overridable per entry.
			PlacementMode: defaultPlacementFor(len(out) == 0),
			IsDefault:     len(out) == 0,
		}
		if len(parts) >= 3 && strings.TrimSpace(parts[2]) != "" {
			spec.PlacementMode = strings.TrimSpace(parts[2])
		}
		if len(parts) == 4 {
			spec.Namespace = strings.TrimSpace(parts[3])
		}
		if err := validateOneOf("--env stage", spec.Stage, environmentStages()); err != nil {
			return nil, fmt.Errorf("in --env %q: %w", raw, err)
		}
		if err := validateOneOf("--env placement mode", spec.PlacementMode, placementModes()); err != nil {
			return nil, fmt.Errorf("in --env %q: %w", raw, err)
		}
		out = append(out, spec)
	}
	return out, nil
}

// promptEnvMatrix asks for the environment matrix one environment at a time, and returns it in
// `--env` syntax so the SAME parser handles the answered and the typed forms.
//
// Returning tuples rather than []api.EnvironmentSpec is the deliberate part. A form that built
// the wire shape directly would be a second implementation of the matrix rules — the first-entry
// default, the duplicate-name check, the field ordering — and the two would drift. Round-tripping
// through parseEnvMatrix means the interactive path is tested by everything that tests the flag,
// and TestProj_EnvFormAndEnvFlagAreOneSpec proves the two agree rather than assuming it.
func promptEnvMatrix() ([]string, error) {
	if err := requireInteractiveForm(); err != nil {
		return nil, err
	}
	declare, err := askYesNo(
		"Declare the environment matrix now?",
		"Otherwise the server creates its default Production + Preview pair")
	if err != nil {
		return nil, err
	}
	if !declare {
		return nil, nil
	}

	var tuples []string
	for {
		a := envAnswers{}
		if err := askEnvironmentSpec(&a, len(tuples) == 0); err != nil {
			return nil, err
		}
		tuple, err := envTuple(a)
		if err != nil {
			return nil, err
		}
		tuples = append(tuples, tuple)

		// Parse what we have SO FAR, so a duplicate name or a bad rung is reported while the
		// person is still answering questions rather than after the last one. The check is
		// the real parser, not a copy of its rules.
		if _, err := parseEnvMatrix(tuples); err != nil {
			return nil, err
		}

		more, err := askYesNo("Add another environment?",
			fmt.Sprintf("So far: %s", strings.Join(tuples, "  ")))
		if err != nil {
			return nil, err
		}
		if !more {
			return tuples, nil
		}
	}
}

// promptProjectName asks for the project's name when it was not passed as the argument.
func promptProjectName() (string, error) {
	if err := requireInteractiveForm(); err != nil {
		return "", err
	}
	name, err := askLine("Project name", "The app this infrastructure belongs to, e.g. boutique")
	if err != nil {
		return "", err
	}
	if name == "" {
		return "", fmt.Errorf("a project name is required")
	}
	return name, nil
}

// promptRegion asks for the project's region when it wasn't passed (TTY only).
//
// An empty answer is NOT refused here the way an empty project name is: the server's own
// error for a missing region names the field, and refusing locally would turn a dismissed
// form into a message about a flag the person was in the middle of answering.
func promptRegion() (string, error) {
	if err := requireInteractiveForm(); err != nil {
		return "", err
	}
	return askLine("Region", "The cloud region to provision into (e.g. eu-west-1)")
}

// runProjectCreate creates the project and renders it as a card (non-interactive path).
func runProjectCreate(c apiClient, out io.Writer, format string, params api.CreateProjectParams) error {
	project, err := c.CreateProject(params)
	if err != nil {
		return err
	}
	return renderProjectCard(out, format, project)
}

// renderProjectCard renders a single project as a Field/Value card (table/csv) or the typed
// object (json).
func renderProjectCard(out io.Writer, format string, p *api.Project) error {
	provider := ui.SymbolDash
	if p.CloudProvider != "" {
		provider = strings.ToUpper(p.CloudProvider)
	}
	rows := [][]string{
		{"Project", p.ProjectName},
		{"Slug", ui.OrDash(p.Slug)},
		{"Status", p.Status},
		{"Provider", provider},
		{"Region", p.Region},
		{"Env", p.EnvironmentStage},
		{"IaC", p.IacVersion},
		{"ID", p.ID},
	}
	return ui.RenderCard(out, format, "alethia · project", rows, p)
}

func init() {
	projectCreateCmd.Flags().StringVar(&projectCreateRegion, "region", "", "Cloud region to provision into (asked for on a terminal when omitted)")
	projectCreateCmd.Flags().StringVar(&projectCreateAccount, "cloud-account", "", "Cloud account to link, by its LABEL or its id (asked for on a terminal when omitted)")
	projectCreateCmd.Flags().StringVar(&projectCreateIdentity, "cloud-identity-id", "", "Cloud account id to link (prefer --cloud-account, which also takes the label)")
	projectCreateCmd.Flags().StringVar(&projectCreateStage, "stage", string(stageDevelopment), "Initial environment stage ("+oneOf(environmentStages())+")")
	projectCreateCmd.Flags().StringVar(&projectCreateIacVersion, "iac-version", "", "OpenTofu version to pin (defaults server-side)")
	projectCreateCmd.Flags().StringVar(&projectCreatePlacement, "placement-mode", "", "Placement of the default environment: "+oneOf(placementModes())+" (default dedicated)")
	projectCreateCmd.Flags().StringArrayVar(&projectCreateEnvs, "env", nil, "Environment as name:stage[:mode[:namespace]] (repeatable; the first is the default). Asked for on a terminal when omitted; without it the Production+Preview pair is created")
	projectCmd.AddCommand(projectCreateCmd)
}
