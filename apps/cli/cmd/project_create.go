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

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
)

// projectCreateSpec is what `project create` takes from a person, declared ONCE and rendered four
// ways: the flags below are generated from it, the form reads its titles and descriptions, the
// manifest keys are its ManifestKey column, and the docs table on project.mdx is generated from it.
//
// This is the command the programme was started over, and the first consumer of the kit. Before it,
// the seven flag usages were hand-typed here while the form's questions were hand-typed in the
// prompt helpers below — two lists nothing compared.
//
// The literal is DATA ONLY, which is measured rather than stylistic: see the pkg/spec package doc.
// docsProjectPage is the reference page `project create`'s field table lives on. It is the one big
// command that had NO fieldspec marker at all — its flag table on project.mdx was hand-written and
// outside every guard.
const docsProjectPage = "apps/docs/content/docs/cli/commands/project.mdx"

var projectCreateSpec = spec.Spec{
	Command: "alethia project create",
	Fields: []spec.Field{
		{Command: "alethia project create", Key: "name", Title: "Project name",
			Description: "What to call the project", Arg: "[name]", Required: true,
			ManifestKey: "project", Page: docsProjectPage},
		{Command: "alethia project create", Key: "region", Title: "Region",
			Description: "Cloud region to provision into (asked for on a terminal when omitted)",
			Flag:        "region", Required: true, EnvVar: "ALETHIA_REGION",
			ManifestKey: "cloud.region", Page: docsProjectPage},
		{Command: "alethia project create", Key: "account", Title: "Cloud account",
			Description: "Cloud account to link, by its LABEL or its id (asked for on a terminal when omitted)",
			Flag:        "cloud-account", Selector: "label", Page: docsProjectPage},
		{Command: "alethia project create", Key: "identity", Title: "Cloud account id",
			Description: "Cloud account id to link (prefer --cloud-account, which also takes the label)",
			Flag:        "cloud-identity-id", Page: docsProjectPage},
		{Command: "alethia project create", Key: "stage", Title: "Stage",
			Description: "Initial environment stage", Flag: "stage",
			Default: string(stageDevelopment), Options: "stages",
			ManifestKey: "stage", Page: docsProjectPage},
		{Command: "alethia project create", Key: "iac-version", Title: "OpenTofu version",
			Description: "OpenTofu version to pin (defaults server-side)", Flag: "iac-version",
			ManifestKey: "iac.version", Page: docsProjectPage},
		{Command: "alethia project create", Key: "placement", Title: "Placement",
			Description: "Placement of the default environment (default dedicated)",
			Flag:        "placement-mode", Options: "placements",
			ManifestKey: "placement", Page: docsProjectPage},
		{Command: "alethia project create", Key: "env", Title: "Environments",
			Description: "Environment as name:stage[:mode[:namespace]] (repeatable; the first is the default). " +
				"Asked for on a terminal when omitted; without it the Production+Preview pair is created",
			Flag: "env", Repeated: true, Page: docsProjectPage},
	},
	// Derived from the generated enums rather than listed, so a new stage or placement mode reaches
	// the flag help, the refusal message and the docs table together.
	Options: map[string][]string{
		"stages":     environmentStages(),
		"placements": placementModes(),
	},
}

// projectCreateBinder holds the flag targets projectCreateSpec generated. Set in init().
var projectCreateBinder *spec.Binder

// projectCreatePrompt is the form adapter used by the shared resolver. It is a seam so command
// tests can answer a field by key; huh owns the destination pointer inside askLine, so merely
// stubbing the form runner can open an input but cannot supply its value.
var projectCreatePrompt = defaultProjectCreatePrompt

// defaultProjectCreatePrompt renders one unresolved project-create field through the existing
// project forms. Optional fields return an empty answer and fall through to their defaults.
func defaultProjectCreatePrompt(f spec.Field, token, accountRef string) (string, error) {
	switch f.Key {
	case "name":
		return promptProjectName()
	case "region":
		return promptRegion()
	case "identity":
		if accountRef != "" {
			return "", nil
		}
		id, _ := selectCloudIdentity(token)
		return id, nil
	}
	return "", nil
}

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
		b := projectCreateBinder

		// The positional is seeded as if it were a flag, so the resolver cannot tell
		// `project create boutique` and a `--name boutique` apart: both are the most explicit
		// thing the person did and must win the same rung.
		if len(args) == 1 {
			b.SetArg("name", strings.TrimSpace(args[0]))
		}

		// --cloud-account (a label or an id) and the older --cloud-identity-id (an id) both name
		// the SAME field, so passing both is refused rather than resolved by precedence. This is
		// a CROSS-FIELD rule and deliberately not something the kit models: preferring the id
		// would skip resolving the label (an unknown or ambiguous one would never be reported),
		// and createReplayArgs would then print `--cloud-account <label>`, a line that links a
		// DIFFERENT account than the run did.
		flagIdentity, _ := b.String("identity")
		accountRef, _ := b.String("account")
		if flagIdentity != "" && accountRef != "" {
			failf("--cloud-account and --cloud-identity-id both name the cloud account: pass one (--cloud-account takes the label or the id)")
		}

		// The form is a source like any other, and the kit asks it only for what the flags, the
		// environment and the manifest left unset — in the ruled order. `ask` is
		// canPromptForm()'s answer through promptsEnabled(); a nil Prompt IS --no-input, so
		// there is no second predicate here and the hygiene guard that forbids one stays happy.
		src := spec.Sources{Env: os.LookupEnv}
		if promptsEnabled() {
			src.Prompt = func(f spec.Field) (string, error) {
				return projectCreatePrompt(f, token, accountRef)
			}
		}

		values, err := spec.Resolve(b, src)
		if err != nil {
			// A MissingError names EVERY unresolved required field rather than the first, which
			// is what a scripted run needs: one round trip, not one per flag. The region is the
			// field that makes this matter — it is required and has no server-side default, so
			// before the kit a scripted run with no --region sent an empty region and the server
			// answered "Invalid request body".
			fail(err)
		}

		name := values.Get("name")
		region := values.Get("region")
		identity := values.Get("identity")
		asked := values.Asked()

		if identity == "" && accountRef != "" {
			if identity, err = resolveCloudIdentityID(client, accountRef); err != nil {
				fail(err)
			}
		}

		// --env is REPEATED, so it has no single value and no merge rule across sources; it is a
		// flag or it is the form. Its colon tuple is #3662's to replace outright.
		matrix, _ := b.Strings("env")
		if len(matrix) == 0 && promptsEnabled() {
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
			Stage:           values.Get("stage"),
			IacVersion:      values.Get("iac-version"),
			Placement:       values.Get("placement"),
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
	// The seven hand-written registrations these replace each repeated a usage string the form also
	// held, in a different file, with nothing comparing them. Generating them makes "anything a form
	// can ask, a flag can set" true by construction rather than by assertion.
	projectCreateBinder = spec.RegisterFlags(projectCreateCmd, projectCreateSpec)
	projectCmd.AddCommand(projectCreateCmd)
}
