// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// The project group's shared spine — the vocabulary, the reference resolvers and the
// replay renderer that every `alethia project …` command uses.
//
// TWO RULES HOLD THE GROUP TOGETHER.
//
// **No opaque id ever has to leave the terminal.** The complaint this whole programme
// started over was a create line carrying `--cloud-identity-id <your-identity-id>` — a
// UUID a reader copies out of one command's output and pastes into another's flags.
// Every reference in this group now takes the NAME a human already knows, resolves it
// against the live list, and keeps accepting the id for the scripts that already pass
// one.
//
// **A name is a lookup key, not an assertion.** resolveProjectID and
// resolveCloudIdentityID never guess. Zero matches names what does exist; TWO matches is
// a hard error listing the ids, because #3145 permits two projects to share a name and
// the wrong answer here is queued as a DESTROY. Picking the first match would be a
// silent, plausible, irreversible mistake — which is the only kind worth building a
// guard against.
//
// The vocabulary below is READ from packages/core/types/enums_gen.go, which is generated
// from the drizzle enum SSOT. It is not retyped here, so a new placement rung reaches the
// flag help, the interactive form and (via TestHygCliProject_DocsSpeakTheGeneratedVocabulary)
// the docs page without anyone remembering three places.

var projectCmd = &cobra.Command{
	Use:   "project",
	Short: "Manage projects (infrastructure configurations)",
	Long: `Projects are infrastructure configurations.

Use the subcommands to list, view, plan, apply, or destroy project infrastructure.

Every reference takes a NAME: --project accepts a project's name or its id, and
--cloud-account accepts a cloud account's label or its id. Omit one on a terminal and
you are asked, so nothing has to be copied out of another command's output.`,
}

// The individual values this group names in a DEFAULT or a branch, aliased to the generated
// constants rather than written as string literals. Referencing the constant is what makes a
// removed enum value fail to COMPILE here instead of turning into a request the server
// refuses at runtime.
const (
	placementNamespace = types.PlacementModeNamespace
	placementDedicated = types.PlacementModeDedicated
	stageDevelopment   = types.EnvironmentStageDevelopment
)

// placementModes is every placement rung, as plain strings, in schema order.
//
// Read from the generated enum rather than retyped: `namespace|vcluster|dedicated`
// appeared as a hand-written string in four places (two flag helps, the docs page and the
// form), and a hand-written list of a finite set stops covering silently.
func placementModes() []string {
	out := make([]string, len(types.AllPlacementModes))
	for i, m := range types.AllPlacementModes {
		out[i] = string(m)
	}
	return out
}

// environmentStages is every environment stage, as plain strings, in schema order.
func environmentStages() []string {
	out := make([]string, len(types.AllEnvironmentStages))
	for i, s := range types.AllEnvironmentStages {
		out[i] = string(s)
	}
	return out
}

// oneOf renders an allowed set for flag help and error text: `namespace|vcluster|dedicated`.
func oneOf(allowed []string) string { return strings.Join(allowed, "|") }

// validateOneOf refuses a value outside a finite, generated set, naming the whole set.
//
// This is the ONE kind of local validation the epic's subset invariant permits without
// argument: these sets are `z.enum(placementMode.enumValues)` and
// `z.enum(environmentStage.enumValues)` on the create route, generated from the same
// drizzle enums this reads, so a value this refuses is a value the server certainly
// refuses. The CLI may only ever be a SUBSET of the server's acceptance; it can drift
// permissive (the server catches that) and must never drift strict.
//
// Deliberately NOT validated here: environment names and namespaces. Their grammar —
// the K8s-exact namespace rule and the unified env-name rules — is #3665's single
// implementation, and a second opinion typed in this file is the exact defect that lane
// exists to end. An empty value is left alone too: empty means "the server's default",
// which every caller of this depends on.
func validateOneOf(flag, value string, allowed []string) error {
	if value == "" {
		return nil
	}
	for _, a := range allowed {
		if value == a {
			return nil
		}
	}
	return fmt.Errorf("invalid %s %q (want %s)", flag, value, oneOf(allowed))
}

// projectLister is the slice of the API client the project resolver needs, kept narrow so
// resolution is unit-testable against a fake.
type projectLister interface {
	GetConfigurations() ([]types.ConfigurationSummary, error)
}

// cloudIdentityLister is the slice of the API client the cloud-account resolvers need — kept
// small so resolution is unit-testable with a fake (the concrete *api.Client satisfies it), and
// so neither group needs an edit to the shared apiClient interface.
//
// Shared by the project group (resolveCloudIdentityID), the connector group
// (resolveCloudIdentityRef) and provider.go (resolveProviderRef): one package, one declaration.
type cloudIdentityLister interface {
	GetCloudIdentities() ([]api.CloudIdentity, error)
}

// resolveProjectID maps a project reference — its NAME or its id — to the id the jobs API
// wants. An empty ref returns empty so the caller's own "then prompt" arm runs.
//
// An id is passed through without a lookup ONLY when it matches a listed project's id.
// Anything else is looked up by name, and both failure modes are loud:
//
//   - no match lists the names that do exist, so a typo is a correction and not a mystery;
//   - two matches is a hard error naming both ids. Two projects MAY share a name (#3145),
//     and the caller of this function queues a DESTROY with what it returns. Choosing the
//     first match would tear down a plausible, wrong project and report success.
func resolveProjectID(c projectLister, ref string) (string, error) {
	if ref == "" {
		return "", nil
	}
	configs, err := c.GetConfigurations()
	if err != nil {
		return "", fmt.Errorf("resolve --project %q: %w", ref, err)
	}
	var matches []types.ConfigurationSummary
	for _, cfg := range configs {
		if cfg.ID == ref {
			return cfg.ID, nil
		}
		if cfg.ProjectName == ref {
			matches = append(matches, cfg)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0].ID, nil
	case 0:
		return "", fmt.Errorf("project %q not found (have: %s)", ref, knownProjectNames(configs))
	default:
		return "", fmt.Errorf(
			"project name %q is ambiguous — %d projects share it (%s). Pass the id with --project instead",
			ref, len(matches), joinIDs(matches))
	}
}

// knownProjectNames renders the project names a resolution failure should offer, sorted and
// de-duplicated so a name shared by two projects is offered once.
func knownProjectNames(configs []types.ConfigurationSummary) string {
	seen := map[string]bool{}
	names := make([]string, 0, len(configs))
	for _, c := range configs {
		if c.ProjectName == "" || seen[c.ProjectName] {
			continue
		}
		seen[c.ProjectName] = true
		names = append(names, c.ProjectName)
	}
	if len(names) == 0 {
		return "none — create one with `alethia project create`"
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// joinIDs renders the ids of an ambiguous match, in full. They are truncated everywhere else
// in the CLI; here the whole point is that the reader can paste one back, so TruncID would
// make the error unactionable.
func joinIDs(configs []types.ConfigurationSummary) string {
	ids := make([]string, len(configs))
	for i, c := range configs {
		ids[i] = c.ID
	}
	sort.Strings(ids)
	return strings.Join(ids, ", ")
}

// resolveCloudIdentityID maps a cloud-account reference — its LABEL or its id — to the id
// the create payload wants. An empty ref returns empty (a project may be created unlinked).
//
// The same discipline as resolveProjectID, and for the same reason: a label is a lookup key.
// Labels are user-chosen and nothing stops two accounts sharing one, so an ambiguous label is
// refused rather than resolved to whichever came back first.
func resolveCloudIdentityID(c cloudIdentityLister, ref string) (string, error) {
	if ref == "" {
		return "", nil
	}
	identities, err := c.GetCloudIdentities()
	if err != nil {
		return "", fmt.Errorf("resolve --cloud-account %q: %w", ref, err)
	}
	var matches []api.CloudIdentity
	for _, id := range identities {
		if id.ID == ref {
			return id.ID, nil
		}
		if id.Label == ref {
			matches = append(matches, id)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0].ID, nil
	case 0:
		return "", fmt.Errorf("cloud account %q not found (have: %s)", ref, knownIdentityLabels(identities))
	default:
		ids := make([]string, len(matches))
		for i, m := range matches {
			ids[i] = m.ID
		}
		sort.Strings(ids)
		return "", fmt.Errorf(
			"cloud account label %q is ambiguous — %d accounts share it (%s). Pass the id instead",
			ref, len(matches), strings.Join(ids, ", "))
	}
}

// knownIdentityLabels renders the cloud-account labels a resolution failure should offer.
func knownIdentityLabels(identities []api.CloudIdentity) string {
	if len(identities) == 0 {
		return "none — link one with `alethia connector add`"
	}
	labels := make([]string, 0, len(identities))
	for _, id := range identities {
		labels = append(labels, id.Label)
	}
	sort.Strings(labels)
	return strings.Join(labels, ", ")
}

// projectRefFor returns the SHORTEST reference that unambiguously names one project: its
// name when no other listed project shares that name, otherwise its id.
//
// This is what keeps a picked project out of the replay line as a UUID. Preferring the name
// is not an assumption — uniqueness is decided against the list that was just fetched, and
// a name shared by two projects (#3145) falls back to the id rather than printing a command
// that would resolve to either.
func projectRefFor(configs []types.ConfigurationSummary, id string) string {
	name := ""
	for _, c := range configs {
		if c.ID == id {
			name = c.ProjectName
			break
		}
	}
	if name == "" {
		return id
	}
	shared := 0
	for _, c := range configs {
		if c.ProjectName == name {
			shared++
		}
	}
	if shared == 1 {
		return name
	}
	return id
}

// projectsForPicker fetches the projects both project pickers offer, reporting "none" as the
// thing to do about it rather than as an empty list to select from.
func projectsForPicker(token string) ([]types.ConfigurationSummary, error) {
	var configs []types.ConfigurationSummary
	var err error
	runSpinner("Fetching projects...", func() {
		configs, err = api.NewClient(token).GetConfigurations()
	})
	if err != nil {
		return nil, fmt.Errorf("failed to fetch projects: %w", err)
	}
	if len(configs) == 0 {
		return nil, fmt.Errorf("no projects found — create one with `alethia project create`")
	}
	return configs, nil
}

// promptProjectNameRef shows the project picker for the leaves that resolve a project by NAME
// and nothing else, and returns that name.
//
// A separate function from promptProjectRef because the id fallback that one makes for a shared
// name (#3145) is not a reference every route accepts: `project get` reads
// GET /cli/configurations/by-project-name/{name}, whose resolver filters on project_name alone
// (apps/console/lib/queries/cli-config.ts) — so an id handed to it 404s on a project the picker
// had just offered.
//
// A name shared by two projects is REFUSED rather than sent. That route answers a duplicate name
// with the oldest row, so picking the younger one and being shown the older one's region, cluster
// endpoint and apps repo is a silent wrong read — the case cli-config.ts records as worse than an
// error for a provisioning tool.
func promptProjectNameRef(token string) (string, error) {
	if err := requireInteractiveForm(); err != nil {
		return "", err
	}
	configs, err := projectsForPicker(token)
	if err != nil {
		return "", err
	}
	// The option VALUE is the id: two projects sharing a name would otherwise be two options
	// that cannot be told apart, and the ambiguity below could not be reported against the row
	// that was actually picked.
	options := make([]huh.Option[string], len(configs))
	for i, c := range configs {
		options[i] = huh.NewOption(
			fmt.Sprintf("%s (%s)", c.ProjectName, c.EnvironmentStage),
			c.ID,
		)
	}
	var id string
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Project").
				Description("Which project to print").
				Options(options...).
				Value(&id),
		),
	); err != nil {
		return "", err
	}
	name := ""
	for _, c := range configs {
		if c.ID == id {
			name = c.ProjectName
			break
		}
	}
	if name == "" {
		return "", fmt.Errorf("that project has no name, and this command looks a project up by name")
	}
	shared := 0
	for _, c := range configs {
		if c.ProjectName == name {
			shared++
		}
	}
	if shared > 1 {
		return "", fmt.Errorf(
			"%d projects are named %q and this command looks a project up by name, which would read whichever is older — rename one to tell them apart",
			shared, name)
	}
	return name, nil
}

// promptProjectRef shows the project picker and returns a reference the --project flag
// accepts — a name where that is unambiguous, an id where it is not.
//
// A separate function from selectProject (which the job commands use) because they answer
// different questions: selectProject must return an ID, since a job's configuration_id is an
// id and nothing else. This one feeds a flag the server resolves either way, and its answer
// is printed back to a human.
func promptProjectRef(token string) (string, error) {
	if err := requireInteractiveForm(); err != nil {
		return "", err
	}
	configs, err := projectsForPicker(token)
	if err != nil {
		return "", err
	}
	options := make([]huh.Option[string], len(configs))
	for i, c := range configs {
		options[i] = huh.NewOption(
			fmt.Sprintf("%s (%s)", c.ProjectName, c.EnvironmentStage),
			projectRefFor(configs, c.ID),
		)
	}
	var ref string
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Select Project").
				Description("Which project to operate on").
				Options(options...).
				Value(&ref),
		),
	); err != nil {
		return "", err
	}
	if ref == "" {
		// Not a dismissal check — huh binds a Select to its first option when the form is
		// built, so a dismissed picker still comes back with one. This is the malformed-row
		// case: a listed project with neither a name nor an id resolves to no reference at
		// all, and sending an empty --project asks the server to resolve nothing, which it
		// reports as a confusing 404 against the whole project.
		return "", fmt.Errorf("that project has neither a name nor an id to select it by")
	}
	return ref, nil
}

// jobProjectFlags registers the project reference on a job command (plan / apply / destroy).
//
// TWO flags for one thing, which needs its reason stated. `--project-id` is what these three
// commands have always taken, and scripts pass it; removing it to tidy the surface would
// break them for an ergonomic gain. `--project` is the one a person uses, takes the name, and
// is what every other command in the group already calls the same field. So: the new flag is
// the documented one, the old flag keeps working, and passing BOTH is refused rather than
// resolved by precedence — see projectIDForJob.
func jobProjectFlags(cmd *cobra.Command, ref, id *string, verb string) {
	cmd.Flags().StringVar(ref, "project", "", "Project to "+verb+", by NAME or id (asked for on a terminal when omitted)")
	cmd.Flags().StringVar(id, "project-id", "", "Project id to "+verb+" (prefer --project, which also takes the name)")
}

// projectIDForJob resolves the configuration_id a job command queues against.
//
// The order is: refuse an ambiguous instruction, then the name, then the id, then ask.
//
// Passing both flags is an ERROR and not a precedence rule. They name the same field, so a
// caller who set both either believes one of them is being ignored or has an unnoticed leak
// from a wrapper script — and the command they are calling is `destroy`. Silently preferring
// one would make the wrong belief survive until it had torn down the other project.
func projectIDForJob(c projectLister, token, ref, id string) (string, error) {
	if ref != "" && id != "" {
		return "", fmt.Errorf("--project and --project-id both name the project: pass one (--project takes the name or the id)")
	}
	if ref != "" {
		return resolveProjectID(c, ref)
	}
	if id != "" {
		return id, nil
	}
	return selectProject(token)
}

// ── the question seams ──────────────────────────────────────────────────────────────────
//
// The interactive paths in this group are LOOPS — "another environment?", "another field?" —
// and a loop is where the real branching lives: which entry is the first, whether a name is
// already taken, what the running summary says. That logic is worth testing and the terminal
// plumbing under it is not.
//
// So each question is a package var, the way `confirm` and `runHuhForm` already are in this
// package, and for a sharper version of the same reason. Stubbing runHuhForm keeps a form
// from blocking but cannot ANSWER one: huh writes the answer through a pointer it owns and
// never exposes, and driving a multi-field group with synthetic key messages does not move
// focus off the first field — measured, not assumed. So without these seams the loop bodies
// are unreachable in a test, and the branch that matters most (a second environment) has
// never run.
//
// The defaults below are the real prompts; production behaviour is unchanged.

// askLine puts one single-line question and returns the trimmed answer.
//
// Three prompts were the same eleven lines with a different title — the project name, the
// region, the design document's path. One seam, three call sites: the wording still differs
// per question, the plumbing does not, and a test can supply the answer.
var askLine = func(title, description string) (string, error) {
	var value string
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewInput().
				Title(title).
				Description(description).
				Value(&value),
		),
	); err != nil {
		return "", err
	}
	return strings.TrimSpace(value), nil
}

// askYesNo puts one yes/no question and returns the answer.
var askYesNo = func(title, description string) (bool, error) {
	var yes bool
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title(title).
				Description(description).
				Affirmative("Yes").
				Negative("No").
				Value(&yes),
		),
	); err != nil {
		return false, err
	}
	return yes, nil
}

// ── the replay line ─────────────────────────────────────────────────────────────────────
//
// Every interactive path in this group ends by printing the flags that would have produced
// the same result. That is what keeps "flags are a COMPLETE contract" honest rather than
// aspirational: the form cannot ask for anything the printed line cannot express, because
// the line is built from the same values the request was, and a guard walks the group
// asserting each form has one.
//
// It also closes the loop the tutorial opened. Someone who answers the questions once ends
// up holding the exact command to commit to a repository — which is the thing the four-field
// colon tuple was being hand-assembled for.

// shellQuote renders one argument so a shell reproduces it verbatim.
//
// Single quotes, because the values here — a namespace, a `--set` value like
// `instance_types=["t3.medium"]`, a label with a space — contain characters a shell would
// otherwise glob, split or expand. An embedded single quote is closed, escaped and reopened
// ('\”) which is the only form POSIX sh accepts; there is no escape for ' INSIDE single
// quotes.
func shellQuote(s string) string {
	if s == "" {
		return "''"
	}
	if !strings.ContainsAny(s, " \t\n'\"\\$`*?[]{}()<>|&;#~!") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// replayLine renders a runnable command from its already-split arguments.
func replayLine(args ...string) string {
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = shellQuote(a)
	}
	return strings.Join(quoted, " ")
}

// printReplay writes the equivalent non-interactive command after a run that asked questions.
//
// TWO conditions, and they are different conditions. `asked` is false for a run that already
// passed every flag — reading them back to a caller who typed them is noise. `format` gates it
// on the HUMAN output: the replay line is prose, and printing prose into a `--output json`
// stream corrupts the document the caller is piping into jq. That is the same split the rest
// of the CLI makes for its "No environments found." notices.
func printReplay(out io.Writer, format string, asked bool, args ...string) {
	if !asked || format != ui.FormatTable {
		return
	}
	fmt.Fprintln(out, ui.MutedStyle.Render("Same result, without the questions:"))
	fmt.Fprintln(out, ui.MutedStyle.Render("  "+replayLine(args...)))
}

// promptsEnabled reports whether this invocation may ask a question.
//
// The SHARED gate, deliberately. The obvious extra condition — "and the output format is
// table" — would make the project group the only group in the CLI whose prompting depends on
// --output, and every other selector in the tree (selectProject, selectRunner,
// pickCloudIdentity) consults canPromptForm and nothing else. A group that disagrees with the
// rest of the product about when it may ask a question is the "two implementations of one
// product" defect this epic exists to close, one directory down. The format split belongs to
// what is PRINTED, which is where printReplay above applies it.
func promptsEnabled() bool {
	return canPromptForm()
}

func init() {
	rootCmd.AddCommand(projectCmd)
}
