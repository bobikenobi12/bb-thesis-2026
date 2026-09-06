// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// The interactive half of the ops field spec: one prompt per opsFields row, and one resolver per
// id an operator would otherwise have to copy from somewhere else.
//
// TWO RULES HOLD FOR EVERY PROMPT IN THIS FILE, and both come from what ops is FOR.
//
//  1. A prompt is never the only way through. Break-glass runs from a pipeline, a `screen` session
//     with redirected output, or a runbook as often as from a keyboard; if the terminal cannot
//     answer, the command says which flag would have and exits non-zero. It never blocks and never
//     exits 0 having done nothing. The ONE exception is `state-surgery`'s `--note`, which is
//     optional: an absent answer is a valid answer, so an unattended run gets no note rather than
//     a refusal.
//
//  2. The gate is requireInteractiveFORM, not requireInteractive. noInputMode is derived from
//     stdin alone, so `alethia ops … 2> err.log` from a real shell leaves prompting "enabled": a
//     huh form then draws its ANSI frames into the redirected file, the terminal shows nothing, and
//     the command looks hung.
//
//     The stream is STDERR. huh v0.8.0 builds its bubbletea program with `tea.WithOutput(os.Stderr)`
//     (form.go:112), which #3712 established by driving the real binary under a pty rather than
//     reading the gate's name. An earlier version of this comment said stdout, and a gate written
//     against stdout is wrong in BOTH directions — it refuses a picker that would have rendered
//     fine, and it lets through the redirect that actually hangs. The predicate is corrected in
//     #3712 across all 37 sites; nothing in this file re-implements it.
//
//     `opsConfirm` below delegates to `confirmDestructive`, which is one of those sites. It is
//     deliberately NOT fixed here: two lanes fixing one shared helper is a merge conflict at best
//     and two disagreeing gates at worst.

// opsReasonMinLength and opsReasonMaxLength mirror `reason: z.string().min(8).max(1000)` in
// apps/console/lib/validations/breakglass.ts.
//
// Enforced locally because these are bounds the server CERTAINLY rejects, and the round trip it
// saves is a round trip in an incident: without them `--reason x` opens a session, takes a 400 with
// a zod issue list, and the operator retypes the whole invocation. The CLI never rejects more than
// this — anything at least eight characters goes to the server unexamined.
const (
	opsReasonMinLength = 8
	opsReasonMaxLength = 1000
)

// opsValidateReason returns nil for a reason the server will accept on length.
func opsValidateReason(reason string) error {
	trimmed := strings.TrimSpace(reason)
	if len(trimmed) < opsReasonMinLength {
		return fmt.Errorf("a reason is at least %d characters — it is what the next person reading the audit has to go on", opsReasonMinLength)
	}
	if len(trimmed) > opsReasonMaxLength {
		return fmt.Errorf("a reason is at most %d characters (got %d)", opsReasonMaxLength, len(trimmed))
	}
	return nil
}

// opsAsk runs a single-question form for one spec field, seeded with `current` and validated by
// `validate` (nil for anything non-empty). It returns the answer.
//
// The title and the description come from the spec, never from the call site, so the question the
// operator reads and the row the docs carry are the same sentence by construction.
func opsAsk(f opsField, current string, validate func(string) error) (string, error) {
	if validate == nil {
		validate = func(v string) error {
			if strings.TrimSpace(v) == "" {
				return fmt.Errorf("%s is required", strings.ToLower(f.Title))
			}
			return nil
		}
	}
	value := current
	err := runHuhForm(
		huh.NewGroup(
			huh.NewInput().
				Title(f.Title).
				Description(f.Description).
				Value(&value).
				Validate(validate),
		),
	)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(value), nil
}

// opsSetter names the way a value can be supplied without a form: `--reason`, or `[job-id]`.
func opsSetter(f opsField) string {
	if f.Flag != "" {
		return "--" + f.Flag
	}
	return f.Arg
}

// opsScripted is the refusal when a value was not supplied and nothing may be prompted. It names
// the flag or positional that would have answered, because the reader of this message is at a
// terminal that cannot be asked and needs the next command, not a diagnosis.
func opsScripted(f opsField, why error) error {
	return fmt.Errorf("no %s given, and interactive prompts are unavailable (%v): pass %s",
		strings.ToLower(f.Title), why, opsSetter(f))
}

// opsRequire resolves a free-text value: the one already supplied, else a prompt, else a refusal
// naming the flag. No listing exists for these — a state key, a Stripe event id and a two-person
// approval token are not things this CLI can offer you a menu of.
func opsRequire(f opsField, supplied string, validate func(string) error) (string, error) {
	if strings.TrimSpace(supplied) != "" {
		if validate != nil {
			if err := validate(supplied); err != nil {
				return "", fmt.Errorf("%s: %w", opsSetter(f), err)
			}
		}
		return strings.TrimSpace(supplied), nil
	}
	if err := requireInteractiveForm(); err != nil {
		return "", opsScripted(f, err)
	}
	return opsAsk(f, "", validate)
}

// opsReason resolves the reason every break-glass verb requires.
//
// Resolved FIRST, before any credential is read or any listing is fetched: the answer does not
// depend on what the server holds, so a scripted invocation missing it should be refused
// immediately rather than after two round trips.
func opsReason(cmd *cobra.Command) string {
	f := mustOpsField(cmd.CommandPath(), opsKeyReason)
	supplied, _ := cmd.Flags().GetString(f.Flag)
	reason, err := opsRequire(f, supplied, opsValidateReason)
	if err != nil {
		fail(err)
		return ""
	}
	return reason
}

// opsApproval resolves the two-person approval token the high-blast verbs require.
func opsApproval(cmd *cobra.Command) string {
	f := mustOpsField(cmd.CommandPath(), opsKeyApproval)
	supplied, _ := cmd.Flags().GetString(f.Flag)
	approval, err := opsRequire(f, supplied, nil)
	if err != nil {
		fail(err)
		return ""
	}
	return approval
}

// ── resolvers: an id the operator would otherwise have to copy ──────────────────────────────────

// opsResolveID answers "which one" for a positional id.
//
// An id ON THE COMMAND LINE IS THE ANSWER: it is passed through byte for byte and `pick` is never
// called, so no listing request is made for a value the caller already gave. That matters more here
// than anywhere else in the CLI — these ids come out of an alert for a tenant the operator is not a
// member of, and no listing this CLI can make would contain them.
func opsResolveID(f opsField, args []string, pick func() (string, error)) (string, error) {
	if len(args) > 0 && strings.TrimSpace(args[0]) != "" {
		return strings.TrimSpace(args[0]), nil
	}
	if err := requireInteractiveForm(); err != nil {
		return "", opsScripted(f, err)
	}
	return pick()
}

// opsPick runs a Select over already-built options and returns the chosen value.
//
// The option VALUE is the index rather than the id, so the answer needs no lookup and there is no
// "the picker returned something I do not recognise" branch to write or get wrong: huh can only
// write back one of the values it was given, and every index it was given is in range.
func opsPick(title, description string, labels []string) (int, error) {
	options := make([]huh.Option[int], len(labels))
	for i, l := range labels {
		options[i] = huh.NewOption(l, i)
	}
	chosen := 0
	err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[int]().
				Title(title).
				Description(description).
				Options(options...).
				Value(&chosen),
		),
	)
	if err != nil {
		return 0, err
	}
	return chosen, nil
}

// The slices of the API client each picker needs, kept small so the resolution is unit-testable
// against a fake. The concrete *api.Client satisfies all three, and so does one test double.
//
// There is no opsJobLister: the jobs group already declares `jobLister` for the same call, and a
// second name for one method would be a second thing to keep in step.
type (
	opsRunnerLister  interface{ GetRunners() ([]api.Runner, error) }
	opsProjectLister interface {
		GetConfigurations() ([]types.ConfigurationSummary, error)
	}
	opsEnvLister interface {
		ListEnvironments(project string) ([]api.Environment, error)
	}
)

// opsPickJobID lists the org's recent jobs and returns the chosen id.
//
// It reuses jobOptionLabel and jobSelectorPageSize from the jobs group rather than rendering a
// second, differently-shaped job line: a job must read the same in this picker as it does in
// `jobs list`, or the operator is being shown two products.
//
// The list is the CALLER's organization. Break-glass is cross-tenant and this listing is not, which
// is exactly why an id given on the command line skips it: the menu is a convenience for the common
// case (your own stuck job), never the only way to name one.
func opsPickJobID(client jobLister) (string, error) {
	var page *api.JobsPage
	var err error
	runSpinner("Fetching jobs...", func() {
		page, err = client.GetJobs("", jobSelectorPageSize, 0)
	})
	if err != nil {
		return "", fmt.Errorf("failed to fetch jobs: %w", err)
	}
	if page == nil || len(page.Jobs) == 0 {
		return "", fmt.Errorf("no jobs in the last %d for this organization — pass the job id instead (break-glass reaches jobs this listing does not)", jobSelectorPageSize)
	}
	labels := make([]string, len(page.Jobs))
	for i, j := range page.Jobs {
		labels[i] = jobOptionLabel(j)
	}
	i, err := opsPick("Select Job", "Most recent first, in this organization", labels)
	if err != nil {
		return "", err
	}
	return page.Jobs[i].ID, nil
}

// opsPickRunnerID lists the org's runners and returns the chosen id.
//
// Every runner is offered, including the offline ones — unlike the job-dispatch picker, which
// offers only runners that can take work. A drain or a restart is aimed at the runner that is
// WRONG, so filtering to the healthy ones would hide every candidate.
func opsPickRunnerID(client opsRunnerLister, verb string) (string, error) {
	var runners []api.Runner
	var err error
	runSpinner("Fetching runners...", func() {
		runners, err = client.GetRunners()
	})
	if err != nil {
		return "", fmt.Errorf("failed to fetch runners: %w", err)
	}
	if len(runners) == 0 {
		return "", fmt.Errorf("no runners in this organization — pass the runner id instead")
	}
	labels := make([]string, len(runners))
	for i, r := range runners {
		// ui.PlainGlyph and not the styled ui.Status: this is a huh Select option, and an option
		// label carrying ANSI fights the widget's own cursor styling and its width arithmetic —
		// which is the whole reason the CLI has had an unstyled glyph since before #3660. The
		// styled ui.StatusDot this replaced was the odd one out, not the rule.
		label := fmt.Sprintf("%s %s %s %s %s %s",
			ui.PlainGlyph(r.Status), r.Name,
			ui.SymbolBullet, r.Status,
			ui.SymbolBullet, runnerOperatorLabel(r))
		if r.IsDefault {
			label += ui.DefaultBadge()
		}
		labels[i] = label
	}
	i, err := opsPick("Select Runner", verb, labels)
	if err != nil {
		return "", err
	}
	return runners[i].ID, nil
}

// opsPickProjectID lists the org's projects and returns the chosen id.
func opsPickProjectID(client opsProjectLister, description string) (string, error) {
	var configs []types.ConfigurationSummary
	var err error
	runSpinner("Fetching projects...", func() {
		configs, err = client.GetConfigurations()
	})
	if err != nil {
		return "", fmt.Errorf("failed to fetch projects: %w", err)
	}
	if len(configs) == 0 {
		return "", fmt.Errorf("no projects in this organization — pass the project id instead")
	}
	labels := make([]string, len(configs))
	for i, c := range configs {
		labels[i] = fmt.Sprintf("%s %s %s %s %s %s",
			ui.PlainGlyph(string(c.Status)), c.ProjectName,
			ui.SymbolBullet, c.EnvironmentStage,
			ui.SymbolBullet, ui.TruncID(c.ID))
	}
	i, err := opsPick("Select Project", description, labels)
	if err != nil {
		return "", err
	}
	return configs[i].ID, nil
}

// opsPickEnvironmentID picks a project, then one of its environments, and returns the environment
// id together with the status it is currently in.
//
// The status comes back because `unstick-env` needs it: the CAS precondition defaults to the status
// the environment is ACTUALLY in, which is the answer in every case where the operator picked the
// environment out of a list rather than reading it off a dashboard.
func opsPickEnvironmentID(projects opsProjectLister, envs opsEnvLister) (id, status string, err error) {
	projectID, err := opsPickProjectID(projects, "Which project the stuck environment belongs to")
	if err != nil {
		return "", "", err
	}
	var list []api.Environment
	runSpinner("Fetching environments...", func() {
		list, err = envs.ListEnvironments(projectID)
	})
	if err != nil {
		return "", "", fmt.Errorf("failed to fetch environments: %w", err)
	}
	if len(list) == 0 {
		return "", "", fmt.Errorf("project %s has no environments — pass the environment id instead", ui.TruncID(projectID))
	}
	labels := make([]string, len(list))
	for i, e := range list {
		labels[i] = fmt.Sprintf("%s %s %s %s %s %s",
			ui.PlainGlyph(e.Status), e.Name,
			ui.SymbolBullet, ui.OrDash(e.Status),
			ui.SymbolBullet, ui.TruncID(e.ID))
	}
	i, err := opsPick("Select Environment", "Which environment is stuck", labels)
	if err != nil {
		return "", "", err
	}
	return list[i].ID, list[i].Status, nil
}

// ── the project_status enum, the third and fourth renderings ────────────────────────────────────

// opsStatusValues is every project_status, from the generated enum mirror.
//
// From packages/core/types and not a list typed here: `--from`/`--to` are `z.enum(projectStatus)`
// server-side, and the docs page shipped an example passing DEPLOYING and READY, neither of which
// has ever been a project_status. A hand-written set here is how that happens again.
func opsStatusValues() []string {
	out := make([]string, len(types.AllProjectStatuses))
	for i, s := range types.AllProjectStatuses {
		out[i] = string(s)
	}
	return out
}

// opsValidateStatuses rejects a value outside the enum.
//
// This is the "provable subset" rule: the CLI may reject only what the server would CERTAINLY
// reject. A status outside project_status is refused by the zod schema on every call, so refusing
// it here hides nothing — while the server's answer is an issue list a reader has to decode.
func opsValidateStatuses(field string, values []string) error {
	allowed := opsStatusValues()
	for _, v := range values {
		if !containsFold(allowed, v) {
			return fmt.Errorf("--%s %q is not a project status (want one of: %s)",
				field, v, strings.Join(allowed, ", "))
		}
	}
	return nil
}

// opsSplitStatuses turns "PROVISIONING, FAILED" into its non-empty, upper-cased members.
func opsSplitStatuses(raw string) []string {
	var out []string
	for _, s := range strings.Split(raw, ",") {
		if t := strings.TrimSpace(s); t != "" {
			out = append(out, strings.ToUpper(t))
		}
	}
	return out
}

// opsAskStatuses asks for the CAS precondition as a multi-select over the enum, pre-selecting the
// status the environment is in.
func opsAskStatuses(f opsField, preselect string) ([]string, error) {
	values := opsStatusValues()
	options := make([]huh.Option[string], len(values))
	for i, v := range values {
		options[i] = huh.NewOption(v, v)
	}
	chosen := []string{}
	if preselect != "" && containsFold(values, preselect) {
		chosen = append(chosen, strings.ToUpper(preselect))
	}
	err := runHuhForm(
		huh.NewGroup(
			huh.NewMultiSelect[string]().
				Title(f.Title).
				Description(f.Description).
				Options(options...).
				Value(&chosen).
				Validate(func(v []string) error {
					if len(v) == 0 {
						return fmt.Errorf("choose at least one status the move may start from")
					}
					return nil
				}),
		),
	)
	if err != nil {
		return nil, err
	}
	return chosen, nil
}

// opsAskStatus asks for a single target status as a Select over the enum.
func opsAskStatus(f opsField) (string, error) {
	values := opsStatusValues()
	i, err := opsPick(f.Title, f.Description, values)
	if err != nil {
		return "", err
	}
	return values[i], nil
}

// ── the confirmation ────────────────────────────────────────────────────────────────────────────

// opsConfirm asks the operator to confirm one break-glass action, and reports whether it may
// proceed. It is confirmDestructive with the ops group's own wording rules applied.
//
// "Are you sure?" on a state unlock is not a confirmation. The title NAMES THE RESOURCE and the
// description NAMES THE CONSEQUENCE, because the operator typing this has already decided to do
// something dangerous and the only useful question is whether they are doing it to the right thing.
// Under --no-input without --yes this dies on the standard fatal path (errConfirmRequiresYes)
// rather than cancelling quietly — a break-glass command that exits 0 having done nothing is how an
// incident gets longer.
func opsConfirm(path, resource, consequence string) bool {
	action, ok := opsActionFor(path)
	if !ok || action.ReadOnly {
		return true
	}
	verb := strings.TrimPrefix(path, "alethia ops ")
	title := fmt.Sprintf("%s %s?", verb, resource)
	detail := consequence
	if action.RequiresApproval {
		detail += fmt.Sprintf(" (blast radius: %s, two-person)", action.Blast)
	} else {
		detail += fmt.Sprintf(" (blast radius: %s)", action.Blast)
	}
	return confirmDestructive(opsYesFor(path), title, detail)
}

// ── the resolvers each verb calls ───────────────────────────────────────────────────────────────

// opsClient builds an API client from the stored credential, for a picker that needs a listing.
//
// Deferred until a picker actually runs: a verb given its id on the command line never reaches it,
// which is what makes "an id passes through with no listing call" true rather than merely intended.
func opsClient() (*api.Client, error) {
	token, err := getAuthToken()
	if err != nil {
		return nil, err
	}
	return api.NewClient(token), nil
}

// opsArgAt returns args[i] as a one-element slice, or nil when it was not given. It is how a
// command with two positionals resolves each of them through the same one-value path.
func opsArgAt(args []string, i int) []string {
	if i < len(args) {
		return args[i : i+1]
	}
	return nil
}

// opsResolveArg resolves a positional free-text value: the one given, else a prompt, else a
// refusal naming the positional.
func opsResolveArg(cmd *cobra.Command, key string, args []string, validate func(string) error) string {
	f := mustOpsField(cmd.CommandPath(), key)
	v, err := opsResolveID(f, args, func() (string, error) { return opsAsk(f, "", validate) })
	if err != nil {
		fail(err)
		return ""
	}
	return v
}

// opsResolveJobID resolves the job a job verb acts on.
func opsResolveJobID(cmd *cobra.Command, args []string) string {
	f := mustOpsField(cmd.CommandPath(), opsKeyJob)
	id, err := opsResolveID(f, args, func() (string, error) {
		client, err := opsClient()
		if err != nil {
			return "", err
		}
		return opsPickJobID(client)
	})
	if err != nil {
		fail(err)
		return ""
	}
	return id
}

// opsResolveRunnerID resolves the runner a runner verb acts on.
func opsResolveRunnerID(cmd *cobra.Command, args []string) string {
	f := mustOpsField(cmd.CommandPath(), opsKeyRunner)
	id, err := opsResolveID(f, args, func() (string, error) {
		client, err := opsClient()
		if err != nil {
			return "", err
		}
		return opsPickRunnerID(client, f.Description)
	})
	if err != nil {
		fail(err)
		return ""
	}
	return id
}

// opsResolveProjectID resolves the project an orphan verb is scoped to. Unlike the ids above this
// one arrives as a FLAG, because orphan detection has no natural positional — the scope is the
// scan, not a thing being acted on.
func opsResolveProjectID(cmd *cobra.Command) string {
	f := mustOpsField(cmd.CommandPath(), opsKeyProject)
	supplied, _ := cmd.Flags().GetString(f.Flag)
	if strings.TrimSpace(supplied) != "" {
		return strings.TrimSpace(supplied)
	}
	if err := requireInteractiveForm(); err != nil {
		fail(opsScripted(f, err))
		return ""
	}
	client, err := opsClient()
	if err != nil {
		fail(err)
		return ""
	}
	id, err := opsPickProjectID(client, f.Description)
	if err != nil {
		fail(err)
		return ""
	}
	return id
}

// opsResolveEnvironment resolves the environment `unstick-env` moves, and the status it is
// currently in when the CLI was the one that found it.
//
// The status is EMPTY when the id came from the command line: the CLI did not look the environment
// up, so it does not know, and inventing a default for the compare-and-swap precondition out of
// nothing is the one thing a CAS exists to prevent.
func opsResolveEnvironment(cmd *cobra.Command, args []string) (id, status string) {
	f := mustOpsField(cmd.CommandPath(), opsKeyEnv)
	if len(args) > 0 && strings.TrimSpace(args[0]) != "" {
		return strings.TrimSpace(args[0]), ""
	}
	if err := requireInteractiveForm(); err != nil {
		fail(opsScripted(f, err))
		return "", ""
	}
	client, err := opsClient()
	if err != nil {
		fail(err)
		return "", ""
	}
	id, status, err = opsPickEnvironmentID(client, client)
	if err != nil {
		fail(err)
		return "", ""
	}
	return id, status
}
