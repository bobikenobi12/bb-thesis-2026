// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// The questions the BYO group asks, and the seams that make their answers testable.
//
// `askLine` and `askYesNo` (project.go) already cover a typed line and a yes/no. A SELECT had no
// seam, and this group is where the missing one hurts: the two values a person most often copies
// out of one command and pastes into the next — a repository URL and an attached chart's id — are
// both chosen from a list the CLI can already fetch. `askChoice` is deliberately shaped like its
// two siblings so the lane that hoists all three into one kit (#3661) finds three of the same
// thing rather than three different things.

// askChoice puts one select question and returns the chosen value.
//
// A package var for the reason project.go's askLine records: stubbing runHuhForm keeps a form from
// blocking but cannot ANSWER one — huh writes the answer through a pointer it owns and never
// exposes — so without a seam here every branch that reads a CHOSEN value is unreachable from a
// test. The default below is the real prompt, so production behaviour is unchanged.
var askChoice = func(title, description string, options []huh.Option[string]) (string, error) {
	var value string
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title(title).
				Description(description).
				Options(options...).
				Value(&value),
		),
	); err != nil {
		return "", err
	}
	return value, nil
}

// gitProviders are the git providers `repo list` browses and the repository picker offers.
//
// One list, two renderings: the `--provider` flag's help text is BUILT from it, so a provider
// added here reaches the help without a second edit, and the docs guard runs the page's examples
// against the flag. It is not a validation set — an unknown provider is refused by the server, and
// the CLI holds no second opinion about which providers exist (see the CLI programme's rule: the
// client may only ever reject what the server would certainly reject).
var gitProviders = []string{"github", "gitlab", "bitbucket"}

// gitProvidersLabel renders the providers for a help string: "github, gitlab, bitbucket".
func gitProvidersLabel() string {
	label := ""
	for i, p := range gitProviders {
		if i > 0 {
			label += ", "
		}
		label += p
	}
	return label
}

// byoTypeARepoURL is the escape hatch at the bottom of the repository picker.
//
// Its VALUE is the empty string, which is also what a dismissed picker leaves behind — and that is
// deliberate rather than a collision. Both mean "the list did not answer this", and both must lead
// to the same place: a typed line. A repository with no URL is skipped when the options are built,
// so no real choice can land on it.
const byoTypeARepoURL = "Type a URL instead…"

// repoLister is the slice of the API client the repository picker needs.
type repoLister func(provider string) ([]api.Repository, error)

// promptRepoURL asks for a repository URL, offering the repositories Alethia can already see.
//
// This is the group's copied placeholder, closed. `chart attach --repo` and `iac attach --repo`
// take a URL that `repo list` prints, so the documented flow was: run one command, read a URL off
// the terminal, type it into the next. The picker asks the same question against the same API.
//
// It DEGRADES rather than fails. A caller may legitimately attach a public repository through no
// connected provider at all, and an org that has linked nothing would otherwise be told to pick
// from an empty list. So a provider that returns an error or no repositories falls through to the
// typed line — the answer the flag would have carried — instead of aborting the attach.
//
// The provider question comes first because GetRepositories takes exactly one provider; asking is
// cheaper than issuing three calls and merging lists that name their repos differently.
func promptRepoURL(list repoLister, f byoField) (string, error) {
	providerField := mustByoField("alethia repo list", byoKeyProvider)
	options := make([]huh.Option[string], len(gitProviders))
	for i, p := range gitProviders {
		options[i] = huh.NewOption(p, p)
	}
	provider, err := askChoice(providerField.Title, "Where to look for "+f.Title+"; anything else can still be typed in", options)
	if err != nil {
		return "", err
	}

	var repos []api.Repository
	if provider != "" {
		// A failure here is NOT fatal: it means "we could not offer a list", not "you may not
		// attach a repository". The typed line below is the same answer --repo would have given.
		repos, _ = list(provider)
	}

	repoOptions := make([]huh.Option[string], 0, len(repos)+1)
	for _, r := range repos {
		if r.URL == "" {
			continue
		}
		name := r.FullName
		if name == "" {
			name = r.Name
		}
		visibility := "public"
		if r.Private {
			visibility = "private"
		}
		repoOptions = append(repoOptions, huh.NewOption(fmt.Sprintf("%s (%s)", name, visibility), r.URL))
	}
	if len(repoOptions) == 0 {
		return askLine(f.Title, f.Description)
	}
	repoOptions = append(repoOptions, huh.NewOption(byoTypeARepoURL, ""))

	chosen, err := askChoice(f.Title, f.Description, repoOptions)
	if err != nil {
		return "", err
	}
	if chosen == "" {
		return askLine(f.Title, f.Description)
	}
	return chosen, nil
}

// byoProject resolves the project a BYO command reads: the --project flag when it carries a value,
// otherwise the shared project picker.
//
// It delegates to `promptProjectRef` — the picker the project group already owns — rather than
// growing this group a second one, and to `currentProject` for the refusal, so a script that omits
// --project reads the same sentence it always has.
//
// `mayPick` is the caller's `interactiveTable` verdict, and it is a correctness gate rather than a
// nicety — the reason `resolveCostProject` states beside it (#3736): ui.NewForm and ui.RunSpinner
// both default to os.Stdout, so a picker opened for `-o json` or for a table redirected into a file
// writes its frames into the machine-readable stream ahead of the document. When picking is not
// allowed, an omitted --project is refused exactly the way --no-input refuses it.
//
// It is NOT `projectFromFlag`, which gates on noInputMode alone. That difference is the redirected
// stdout above; the two should converge, and converging them is a decision about the project
// group's behaviour rather than this one's.
func byoProject(cmd *cobra.Command, token string, mayPick bool) (string, error) {
	if p, err := currentProject(cmd); err == nil {
		return p, nil
	}
	if !mayPick {
		return currentProject(cmd)
	}
	return promptProjectRef(token)
}

// chartLister is the slice of the API client the attached-chart picker needs.
type chartLister func() (*api.ProjectByoCharts, error)

// promptChartID asks WHICH attached chart a command acts on, from the environment's own list.
//
// `chart detach` and `chart scan` took an id whose only source was `chart list`'s first column, so
// both commands required a reader to copy a token off the terminal. The id is still accepted as a
// positional — the flag surface stays a complete contract — but it no longer has to be typed.
//
// An empty environment is a hard error and not an empty picker: "there is nothing here to detach"
// is a fact the caller needs, and a select with no options is a prompt that cannot be answered.
func promptChartID(list chartLister, f byoField, env string) (string, error) {
	view, err := list()
	if err != nil {
		return "", err
	}
	if view == nil || len(view.Charts) == 0 {
		return "", fmt.Errorf("no BYO charts are attached%s — attach one with `alethia chart attach`", envSuffix(env))
	}
	options := make([]huh.Option[string], 0, len(view.Charts))
	for _, c := range view.Charts {
		if c.ID == "" {
			continue
		}
		options = append(options, huh.NewOption(byoChartLabel(c), c.ID))
	}
	if len(options) == 0 {
		// Every attached chart came back without an id. Nothing here can be selected, and sending
		// an empty id would ask the server to detach a chart the caller never named.
		return "", fmt.Errorf("the attached charts%s have no ids to select them by", envSuffix(env))
	}
	chosen, err := askChoice(f.Title, f.Description, options)
	if err != nil {
		return "", err
	}
	if chosen == "" {
		return "", fmt.Errorf("no chart was selected")
	}
	return chosen, nil
}

// byoChartLabel renders one chart as a picker option: the id, then where it comes from.
//
// The id ALONE is what the command needs and is not enough to choose by — two charts attached from
// different refs of the same repository are told apart by the ref and by nothing else. The scan
// status is included because it decides whether the chart is deployable, which is the reason most
// people are looking at this list.
func byoChartLabel(c api.ByoChart) string {
	where := c.RepoURL
	if c.ChartPath != "" {
		where += "/" + c.ChartPath
	}
	if c.Ref != "" {
		where += "@" + c.Ref
	}
	if where == "" {
		return fmt.Sprintf("%s (%s)", c.ID, c.ScanStatus)
	}
	return fmt.Sprintf("%s — %s (%s)", c.ID, where, c.ScanStatus)
}
