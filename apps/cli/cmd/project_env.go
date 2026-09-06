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
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var projectEnvCmd = &cobra.Command{
	Use:   "env",
	Short: "Manage a project's environments",
	Long: `A project owns N independently-provisionable environments (development, staging,
production, …). List a project's environments or add a new one. The project is named with
--project (its name or id); omit it on a terminal and you are asked.`,
}

// currentProject resolves the project a command operates on from the --project flag, which
// takes the project's NAME or its id — the server accepts either, so nothing is resolved
// client-side here and the CLI holds no second opinion about which project a name means.
//
// Kept flag-only, and kept at this signature: commands outside the project group call it
// (chart, byo, …) and each belongs to a lane that has not adopted the picker yet — the addon
// group adopted projectFromFlag in #3710, and the rest follow one lane at a time.
// The project group asks through projectFromFlag below.
func currentProject(cmd *cobra.Command) (string, error) {
	if p, _ := cmd.Flags().GetString("project"); strings.TrimSpace(p) != "" {
		return strings.TrimSpace(p), nil
	}
	return "", fmt.Errorf("--project is required (pass the project name or id)")
}

// projectFromFlag is currentProject with a question attached: omitted on a terminal, the
// project is ASKED FOR rather than refused.
//
// There is still no implicit "active project" — the picker names one explicitly and the
// answer is echoed back in the replay line, so the project a command acted on is always
// visible. With prompting disabled it stays exactly the hard error it was, because a script
// must say which project it means and a form is not something a script can answer.
func projectFromFlag(cmd *cobra.Command, token string) (string, error) {
	if p, err := currentProject(cmd); err == nil {
		return p, nil
	}
	if !promptsEnabled() {
		return currentProject(cmd)
	}
	return promptProjectRef(token)
}

var projectEnvListCmd = &cobra.Command{
	Use:   "list",
	Short: "List a project's environments",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := projectFromFlag(cmd, token)
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var envs []api.Environment
			runSpinner("Fetching environments...", func() { envs, err = client.ListEnvironments(project) })
			if err != nil {
				failf("Failed to list environments: %v", err)
			}
			if len(envs) == 0 {
				ui.Muted("No environments found.")
				return
			}
			// FormatTable: the interactive browser is a person looking at a screen, never a pipe.
			_ = ui.ShowTable(envListColumns, envRows(envs, ui.FormatTable), "environments")
			return
		}
		if err := runProjectEnvList(client, os.Stdout, outputFormat(cmd), project); err != nil {
			failf("Failed to list environments: %v", err)
		}
	},
}

// Placement, Namespace and Fabric sit next to each other deliberately: read across a row and
// you get the whole claim — this tier is a namespace, in boutique-dev-1, on the Fabric named
// prod, which the row above owns. Without them the list answered Name/Stage/Status/Default/
// Region, none of which distinguishes an environment that bought a cluster from one that
// cost nothing, which is the single thing the isolation ladder exists to show.
var envListColumns = []string{
	"Name", "Stage", "Placement", "Namespace", "Fabric", "Status", "Default", "Region",
}

// envRows projects environments into plain table rows.
//
// Status goes through ui.Cell: `runner list` and `clusters list` have drawn a glyph beside the
// word since #3694 and this table printed the bare shouting enum, so one product said a status
// two ways. The Cell split is what makes that safe — `-o csv` still carries the raw `ACTIVE` a
// script parses, and only the human table gets `● active`.
//
// Default is DefaultCell, not ui.YesNo. The column asks WHICH ONE, and answering it per-row with
// the status vocabulary's `● / ·` both put a glyph on every line and made this the only table in
// the product to mark its default environment with something other than `◆`.
func envRows(envs []api.Environment, outFmt string) [][]string {
	rows := make([][]string, len(envs))
	for i, e := range envs {
		rows[i] = []string{
			e.Name,
			e.Stage,
			ui.OrDash(e.PlacementMode),
			ui.StrOrDash(e.Namespace),
			ui.StrOrDash(e.Fabric),
			ui.Cell(outFmt, e.Status, ui.StatusCell(e.Status)),
			ui.DefaultCell(e.IsDefault),
			ui.StrOrDash(e.Region),
		}
	}
	return rows
}

// runProjectEnvList fetches and renders a project's environments (non-interactive path).
func runProjectEnvList(c apiClient, out io.Writer, format, project string) error {
	envs, err := c.ListEnvironments(project)
	if err != nil {
		return err
	}
	if len(envs) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No environments found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: envListColumns,
		Rows:    envRows(envs, format),
	}, envs)
}

// ── the environment spec, asked once and rendered four ways ─────────────────────────────
//
// An environment is FOUR fields, and until this form existed the only way to say them was
// the colon tuple the programme was started over:
//
//	--env prod:production:dedicated --env dev-1:development:namespace:boutique-dev-1
//
// One spec, four renderings, and all four are here or one hop away: the flag (`--env`, and
// the `--stage`/`--placement-mode`/`--namespace` trio on `env add`), the interactive form
// below, the wire shape (api.EnvironmentSpec), and the docs table — which
// TestHygCliProject_DocsSpeakTheGeneratedVocabulary holds to the same generated enums the
// form's options are built from.
//
// The form and the flag are proven to be the same spec rather than asserted to be:
// envTuple renders the form's answers back into `--env` syntax, and
// TestProj_EnvFormAndEnvFlagAreOneSpec round-trips them through parseEnvMatrix — the real
// parser, not a copy of it — and compares the resulting api.EnvironmentSpec.

// envAnswers is one environment as the form collects it: exactly the four fields the `--env`
// tuple can express, and deliberately not one more. A form that could ask for something no
// flag can set would break the --no-input contract silently, which is the failure mode this
// group's whole design is arranged against — so `lifecycle`, `fabric` and `region` stay
// flag-only on `env add` rather than being asked for here.
type envAnswers struct {
	Name          string
	Stage         string
	PlacementMode string
	Namespace     string
}

// placementDescriptions annotates each rung with what it COSTS, because that is the fact a
// person picking one needs and the reason a mis-typed tuple was expensive: `dedicated` is a
// whole cluster with its own OpenTofu state, and every environment the CLI created was one
// before the matrix existed.
//
// Keyed by the generated enum's values. A rung with no entry here still appears in the
// picker with its bare name — the vocabulary is the enum's, never this map's — and
// TestProj_EveryPlacementRungIsDescribed fails so the description gets written.
var placementDescriptions = map[string]string{
	"namespace": "a namespace on the Fabric that already exists — no new cluster",
	"vcluster":  "a virtual cluster on the existing Fabric — isolation without a new cluster",
	"dedicated": "a NEW cluster of its own, with its own state — the rung with a bill",
}

// placementSelectOptions builds the placement picker from the generated enum.
func placementSelectOptions() []huh.Option[string] {
	modes := placementModes()
	opts := make([]huh.Option[string], len(modes))
	for i, m := range modes {
		label := m
		if d, ok := placementDescriptions[m]; ok {
			label = m + " — " + d
		}
		opts[i] = huh.NewOption(label, m)
	}
	return opts
}

// stageSelectOptions builds the stage picker from the generated enum.
func stageSelectOptions() []huh.Option[string] {
	stages := environmentStages()
	opts := make([]huh.Option[string], len(stages))
	for i, s := range stages {
		opts[i] = huh.NewOption(s, s)
	}
	return opts
}

// defaultPlacementFor is the rung an unanswered form starts on. The FIRST environment of a
// project owns the Fabric it provisions, so it starts `dedicated`; every later one starts on
// the cheap rung. Same rule as parseEnvMatrix applies to a tuple that omits the mode, stated
// once here and consumed by both.
func defaultPlacementFor(isFirst bool) string {
	if isFirst {
		return string(placementDedicated)
	}
	return string(placementNamespace)
}

// environmentFormGroups builds the question groups for one environment, seeded from a. It is
// separated from the run so the QUESTIONS can be asserted without a terminal: a stubbed
// runHuhForm answers nothing (huh owns the pointer), so a test that only drove the form would
// be pinning the stub rather than the options.
//
// The namespace question is asked unconditionally rather than hidden for `dedicated`. huh
// decides which fields to show when the form is BUILT, and the placement answer does not
// exist yet at that moment — so hiding it here would hide it based on the SEED value and
// silently drop a namespace the user then had no way to give. It is labelled as ignored for
// dedicated instead, and normaliseEnvAnswers drops it after the answers are in.
func environmentFormGroups(a *envAnswers, isFirst bool) []*huh.Group {
	which := "another environment"
	if isFirst {
		which = "the first environment (it owns the Fabric the project provisions)"
	}
	return []*huh.Group{
		huh.NewGroup(
			huh.NewInput().
				Title("Environment name").
				Description("Names "+which+", e.g. prod, dev-1").
				Value(&a.Name),
			huh.NewSelect[string]().
				Title("Stage").
				Description("What this environment IS, which is not the same as what it is called").
				Options(stageSelectOptions()...).
				Value(&a.Stage),
			huh.NewSelect[string]().
				Title("Placement").
				Description("How it is placed onto a Fabric — this is the field with a bill").
				Options(placementSelectOptions()...).
				Value(&a.PlacementMode),
			huh.NewInput().
				Title("Destination namespace").
				Description("Optional; derived from the name when blank. Ignored for a dedicated placement").
				Value(&a.Namespace),
		),
	}
}

// normaliseEnvAnswers trims the answers and drops a namespace that cannot apply.
//
// A `dedicated` environment owns a new Fabric and has no destination namespace on a shared
// one, so carrying the answer through would put a field in the request that the server
// ignores and in the replay line that the reader would then believe had an effect.
func normaliseEnvAnswers(a envAnswers) envAnswers {
	a.Name = strings.TrimSpace(a.Name)
	a.Stage = strings.TrimSpace(a.Stage)
	a.PlacementMode = strings.TrimSpace(a.PlacementMode)
	a.Namespace = strings.TrimSpace(a.Namespace)
	if a.PlacementMode == string(placementDedicated) {
		a.Namespace = ""
	}
	return a
}

// askEnvironmentSpec is the environment question as a seam, so the matrix LOOP that calls it
// can be driven with answers a stubbed huh form cannot supply. See the question seams in
// project.go for why. The default is promptEnvironmentSpec — the real form.
var askEnvironmentSpec = promptEnvironmentSpec

// promptEnvironmentSpec asks the four environment questions, seeded from a, and writes the
// answers back through it.
func promptEnvironmentSpec(a *envAnswers, isFirst bool) error {
	if err := requireInteractiveForm(); err != nil {
		return err
	}
	if a.Stage == "" {
		a.Stage = string(stageDevelopment)
	}
	if a.PlacementMode == "" {
		a.PlacementMode = defaultPlacementFor(isFirst)
	}
	if err := runHuhForm(environmentFormGroups(a, isFirst)...); err != nil {
		return err
	}
	*a = normaliseEnvAnswers(*a)
	if a.Name == "" {
		return fmt.Errorf("an environment needs a name")
	}
	return validateEnvAnswers(*a)
}

// validateEnvAnswers refuses a stage or placement outside the generated enums. The name and
// the namespace are NOT checked here — see validateOneOf on why that grammar is #3665's.
func validateEnvAnswers(a envAnswers) error {
	if err := validateOneOf("stage", a.Stage, environmentStages()); err != nil {
		return err
	}
	return validateOneOf("placement-mode", a.PlacementMode, placementModes())
}

// envTuple renders one environment back into `--env name:stage[:mode[:namespace]]` — the flag
// spelling of the answers the form just collected, for the replay line.
//
// It REFUSES a field containing a colon rather than emitting a tuple that would parse into
// something else. The tuple's separator is its whole grammar, so an environment called
// `a:b` would render as a four-part tuple whose namespace is a stage; the replay line would
// be a plausible command that does a different thing, which is worse than no replay line.
// (The server independently refuses such a name; this is about never PRINTING a lie.)
func envTuple(a envAnswers) (string, error) {
	parts := []string{a.Name, a.Stage, a.PlacementMode}
	if a.Namespace != "" {
		parts = append(parts, a.Namespace)
	}
	for _, p := range parts {
		if strings.Contains(p, ":") {
			return "", fmt.Errorf("%q contains a colon, which is the --env separator — pass this environment with `project env add` instead", p)
		}
	}
	return strings.Join(parts, ":"), nil
}

// envSpecFrom turns collected answers into the wire spec. isDefault is positional and not
// asked: the first environment of a create is the default one.
func envSpecFrom(a envAnswers, isDefault bool) api.EnvironmentSpec {
	return api.EnvironmentSpec{
		Name:          a.Name,
		Stage:         a.Stage,
		PlacementMode: a.PlacementMode,
		Namespace:     a.Namespace,
		IsDefault:     isDefault,
	}
}

var (
	projectEnvStage     string
	projectEnvRegion    string
	projectEnvPlacement string
	projectEnvFabric    string
	projectEnvNamespace string
	projectEnvLifecycle string
)

var projectEnvAddCmd = &cobra.Command{
	Use:   "add [name]",
	Short: "Add an environment to a project",
	Long: `Add an environment to a project and place it onto a Fabric.

Pass the name, --stage and --placement-mode, or omit them on a terminal to be asked. The
questions and the flags are the same four fields, and the equivalent command is printed
back so it can be committed to a script.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		project, err := projectFromFlag(cmd, token)
		if err != nil {
			fail(err)
		}

		answers := envAnswers{
			Stage:         projectEnvStage,
			PlacementMode: projectEnvPlacement,
			Namespace:     projectEnvNamespace,
		}
		if len(args) == 1 {
			answers.Name = args[0]
		}

		// Ask when something is missing and there is somebody to ask. `--stage` carries a
		// default, so "did the caller say it" is Changed and not emptiness — a defaulted
		// stage that was never chosen is exactly the silent answer this form exists to stop.
		asked := false
		if promptsEnabled() && (answers.Name == "" || !cmd.Flags().Changed("stage") || answers.PlacementMode == "") {
			if err := promptEnvironmentSpec(&answers, false); err != nil {
				fail(err)
			}
			asked = true
		}
		if answers.Name == "" {
			failf("an environment name is required (pass it as the argument)")
		}
		answers = normaliseEnvAnswers(answers)
		if err := validateEnvAnswers(answers); err != nil {
			fail(err)
		}

		if err := runProjectEnvAdd(api.NewClient(token), os.Stdout, api.AddEnvironmentParams{
			Project:   project,
			Name:      answers.Name,
			Stage:     answers.Stage,
			Region:    projectEnvRegion,
			Placement: answers.PlacementMode,
			Fabric:    projectEnvFabric,
			Namespace: answers.Namespace,
			Lifecycle: projectEnvLifecycle,
		}); err != nil {
			failf("Failed to add environment: %v", err)
		}
		printReplay(os.Stdout, outputFormat(cmd), asked, envAddReplayArgs(project, answers, projectEnvRegion, projectEnvFabric, projectEnvLifecycle)...)
	},
}

// envAddReplayArgs renders the `project env add` that would have produced this result. Only
// the fields that were actually set appear, so the line is the shortest one that reproduces
// it rather than a transcript of every flag the command has.
func envAddReplayArgs(project string, a envAnswers, region, fabric, lifecycle string) []string {
	args := []string{"alethia", "project", "env", "add", a.Name, "--project", project}
	for _, kv := range [][2]string{
		{"--stage", a.Stage},
		{"--placement-mode", a.PlacementMode},
		{"--namespace", a.Namespace},
		{"--region", region},
		{"--fabric", fabric},
		{"--lifecycle", lifecycle},
	} {
		if kv[1] != "" {
			args = append(args, kv[0], kv[1])
		}
	}
	return args
}

// runProjectEnvAdd adds an environment and confirms it. The confirmation names the PLACEMENT, because
// that is the field with a cost: a `dedicated` environment is a whole new cluster with its own state
// key, and until this flag existed every CLI-added environment silently became one.
func runProjectEnvAdd(c apiClient, out io.Writer, params api.AddEnvironmentParams) error {
	env, err := c.AddEnvironment(params)
	if err != nil {
		return err
	}
	placement := params.Placement
	if placement == "" {
		placement = string(placementNamespace)
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Added environment %s (%s, %s placement)", env.Name, env.Stage, placement)))
	return nil
}

func init() {
	projectEnvCmd.PersistentFlags().String("project", "", "Project name or id (asked for on a terminal when omitted)")
	projectEnvAddCmd.Flags().StringVar(&projectEnvStage, "stage", string(stageDevelopment), "Environment stage ("+oneOf(environmentStages())+")")
	projectEnvAddCmd.Flags().StringVar(&projectEnvRegion, "region", "", "Region (inherits the project's region when omitted)")
	projectEnvAddCmd.Flags().StringVar(&projectEnvPlacement, "placement-mode", "", "Placement onto a Fabric: "+oneOf(placementModes())+" (default namespace — `dedicated` provisions a NEW cluster)")
	projectEnvAddCmd.Flags().StringVar(&projectEnvFabric, "fabric", "", "Fabric to place onto, by name (default: the Fabric the project's default environment is on)")
	projectEnvAddCmd.Flags().StringVar(&projectEnvNamespace, "namespace", "", "ArgoCD destination namespace for a shared placement (default: derived from the name)")
	projectEnvAddCmd.Flags().StringVar(&projectEnvLifecycle, "lifecycle", "", "persistent|ephemeral (default persistent)")
	projectEnvCmd.AddCommand(projectEnvListCmd)
	projectEnvCmd.AddCommand(projectEnvAddCmd)
	projectCmd.AddCommand(projectEnvCmd)
}
