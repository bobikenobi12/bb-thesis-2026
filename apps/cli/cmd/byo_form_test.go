// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

// The BYO group's interactive paths, driven.
//
// Every stub here answers BY THE QUESTION'S TITLE rather than by call order. That is deliberate and
// it is what makes these tests able to fail: a form wired to the wrong variable — the `--ref`
// question storing into Namespace — passes an order-keyed script perfectly, because the script
// hands out the same values in the same sequence either way. Keying on the title means each
// assertion below is "the answer to the Git ref question ended up in Ref", which is the property
// that actually matters.

// byoFormAnswers stubs askLine and askChoice for one test, answering by title, and records the
// titles it was asked in order.
type byoFormAnswers struct {
	lines   map[string]string
	choices map[string]string
	asked   []string
	// lineErr, when set for a title, makes that question fail.
	lineErr map[string]error
	// options records the huh options each select was offered, so a test can assert what the
	// picker actually put in front of the user.
	options map[string][]huh.Option[string]
}

// install replaces the two question seams for the duration of the test.
func (a *byoFormAnswers) install(t *testing.T) {
	t.Helper()
	if a.options == nil {
		a.options = map[string][]huh.Option[string]{}
	}
	prevLine, prevChoice := askLine, askChoice
	askLine = func(title, description string) (string, error) {
		a.asked = append(a.asked, title)
		if err, ok := a.lineErr[title]; ok {
			return "", err
		}
		v, ok := a.lines[title]
		if !ok {
			t.Errorf("askLine was asked an unexpected question %q — the form put a question this "+
				"test never scripted, which means it is asking for something nobody described", title)
		}
		return v, nil
	}
	askChoice = func(title, description string, options []huh.Option[string]) (string, error) {
		a.asked = append(a.asked, title)
		a.options[title] = options
		v, ok := a.choices[title]
		if !ok {
			t.Errorf("askChoice was asked an unexpected question %q", title)
		}
		return v, nil
	}
	t.Cleanup(func() { askLine, askChoice = prevLine, prevChoice })
}

// byoFormNoQuestions installs seams that FAIL the test if anything is asked. It is how the
// --no-input arm is proved to be silent rather than merely to have produced the right answer.
func byoFormNoQuestions(t *testing.T) {
	t.Helper()
	prevLine, prevChoice := askLine, askChoice
	askLine = func(title, _ string) (string, error) {
		t.Errorf("a question (%q) was put with prompting disabled", title)
		return "", nil
	}
	askChoice = func(title, _ string, _ []huh.Option[string]) (string, error) {
		t.Errorf("a picker (%q) was opened with prompting disabled", title)
		return "", nil
	}
	t.Cleanup(func() { askLine, askChoice = prevLine, prevChoice })
}

// byoFormTTY makes BOTH standard streams look like a terminal for the rest of the test.
//
// Stdin alone is not enough, and the difference is the whole reason `byoProject` and
// `resolveChartID` gate on `interactiveTable` rather than on `noInputMode`: prompting is enabled by
// stdin, but a form DRAWS on stdout, so a redirected stdout means the question would go into the
// file the caller is piping. A test that stubbed only stdin would take the refusal arm and report
// that the picker does not work.
func byoFormTTY(t *testing.T) {
	t.Helper()
	prevIn, prevOut := stdinIsTTY, stdoutIsTTY
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return true }
	t.Cleanup(func() { stdinIsTTY, stdoutIsTTY = prevIn, prevOut })
}

// byoFormRepos is a two-repository listing for the picker.
func byoFormRepos() repoLister {
	return func(provider string) ([]api.Repository, error) {
		return []api.Repository{
			{Name: "charts", FullName: "acme/charts", URL: "https://github.com/acme/charts", Private: true},
			{Name: "infra", FullName: "acme/infra", URL: "https://github.com/acme/infra"},
		}, nil
	}
}

// ── chart attach ───────────────────────────────────────────────────────────────────────────────

func TestByoForm_ChartAttachAsksForEveryMissingField(t *testing.T) {
	a := &byoFormAnswers{
		lines: map[string]string{
			"Chart id":   "api",
			"Chart path": "charts/api",
			"Git ref":    "v1.2.3",
			"Namespace":  "shop-api",
		},
		choices: map[string]string{
			"Provider":   "github",
			"Repository": "https://github.com/acme/charts",
		},
	}
	a.install(t)

	got, asked, err := askChartAttach(api.AttachChartParams{Project: "shop", Env: "dev"}, byoFormRepos(), true)
	if err != nil {
		t.Fatalf("askChartAttach: %v", err)
	}
	if !asked {
		t.Error("asked must be true — the replay line is gated on it, and a run that answered five questions and reports asking none prints nothing")
	}
	// Each answer must land in the field whose question produced it.
	for _, tc := range []struct{ field, got, want string }{
		{"ID", got.ID, "api"},
		{"RepoURL", got.RepoURL, "https://github.com/acme/charts"},
		{"ChartPath", got.ChartPath, "charts/api"},
		{"Ref", got.Ref, "v1.2.3"},
		{"Namespace", got.Namespace, "shop-api"},
	} {
		if tc.got != tc.want {
			t.Errorf("%s = %q, want %q — the answer to that question was stored somewhere else",
				tc.field, tc.got, tc.want)
		}
	}
	if got.Project != "shop" || got.Env != "dev" {
		t.Errorf("the form must not disturb the resolved project/env: %q %q", got.Project, got.Env)
	}
}

func TestByoForm_ChartAttachDoesNotRequestionASetFlag(t *testing.T) {
	a := &byoFormAnswers{
		lines:   map[string]string{"Namespace": "shop-api"},
		choices: map[string]string{},
	}
	a.install(t)

	got, asked, err := askChartAttach(api.AttachChartParams{
		ID: "api", RepoURL: "https://github.com/acme/charts", ChartPath: "charts/api", Ref: "main",
	}, byoFormRepos(), true)
	if err != nil {
		t.Fatalf("askChartAttach: %v", err)
	}
	if !asked {
		t.Error("the namespace was still missing, so the run did ask")
	}
	if strings.Join(a.asked, ",") != "Namespace" {
		t.Errorf("only the missing field may be asked for; asked %v", a.asked)
	}
	if got.Ref != "main" || got.ID != "api" {
		t.Errorf("a value passed as a flag was overwritten: %+v", got)
	}
}

// TestByoForm_ChartAttachReportsAskingForEachFieldOnItsOwn walks the fields ONE AT A TIME.
//
// It exists because a "all fields missing" test cannot see a single field forgetting to set
// `asked`: four other questions set it on the way past, so the flag is true for the wrong reason
// and the replay line still prints. Measured — dropping `asked = true` from the id question
// survived every other test in this file. One missing field per case is the only shape that can
// fail, and `asked` is what gates the whole replay line, so a field that forgets it is a run that
// answered a question and printed nothing back.
func TestByoForm_ChartAttachReportsAskingForEachFieldOnItsOwn(t *testing.T) {
	full := api.AttachChartParams{
		ID: "api", RepoURL: "https://github.com/acme/charts", ChartPath: "charts/api",
		Ref: "main", Namespace: "shop",
	}
	for title, blank := range map[string]func(p *api.AttachChartParams){
		"Chart id":   func(p *api.AttachChartParams) { p.ID = "" },
		"Chart path": func(p *api.AttachChartParams) { p.ChartPath = "" },
		"Git ref":    func(p *api.AttachChartParams) { p.Ref = "" },
		"Namespace":  func(p *api.AttachChartParams) { p.Namespace = "" },
	} {
		t.Run(title, func(t *testing.T) {
			a := &byoFormAnswers{lines: map[string]string{title: "answered"}, choices: map[string]string{}}
			a.install(t)
			p := full
			blank(&p)
			got, asked, err := askChartAttach(p, byoFormRepos(), true)
			if err != nil {
				t.Fatalf("askChartAttach: %v", err)
			}
			if strings.Join(a.asked, ",") != title {
				t.Fatalf("want exactly the %q question, asked %v", title, a.asked)
			}
			if !asked {
				t.Errorf("the %q question was put and the run reports asking nothing — the replay "+
					"line is gated on that flag, so it would print nothing", title)
			}
			if !strings.Contains(strings.Join(chartAttachReplayArgs(got), " "), "answered") {
				t.Errorf("the answer did not reach the params: %+v", got)
			}
		})
	}
}

// The same shape for the repository, which is asked through the picker rather than a typed line.
func TestByoForm_ChartAttachReportsAskingForTheRepository(t *testing.T) {
	a := &byoFormAnswers{
		lines:   map[string]string{},
		choices: map[string]string{"Provider": "github", "Repository": "https://github.com/acme/infra"},
	}
	a.install(t)
	got, asked, err := askChartAttach(api.AttachChartParams{
		ID: "api", ChartPath: "charts/api", Ref: "main", Namespace: "shop",
	}, byoFormRepos(), true)
	if err != nil {
		t.Fatalf("askChartAttach: %v", err)
	}
	if !asked {
		t.Error("the repository was picked and the run reports asking nothing")
	}
	if got.RepoURL != "https://github.com/acme/infra" {
		t.Errorf("RepoURL = %q", got.RepoURL)
	}
}

// And for `iac attach`, whose three fields have the same hazard.
func TestByoForm_IacAttachReportsAskingForEachFieldOnItsOwn(t *testing.T) {
	full := api.AttachIacParams{RepoURL: "https://github.com/acme/infra", Path: "iac/aws", Ref: "main"}
	for title, blank := range map[string]func(p *api.AttachIacParams){
		"Module path": func(p *api.AttachIacParams) { p.Path = "" },
		"Git ref":     func(p *api.AttachIacParams) { p.Ref = "" },
	} {
		t.Run(title, func(t *testing.T) {
			a := &byoFormAnswers{lines: map[string]string{title: "answered"}, choices: map[string]string{}}
			a.install(t)
			p := full
			blank(&p)
			_, asked, err := askIacAttach(p, byoFormRepos(), true)
			if err != nil {
				t.Fatalf("askIacAttach: %v", err)
			}
			if strings.Join(a.asked, ",") != title {
				t.Fatalf("want exactly the %q question, asked %v", title, a.asked)
			}
			if !asked {
				t.Errorf("the %q question was put and the run reports asking nothing", title)
			}
		})
	}
}

func TestByoForm_IacAttachReportsAskingForTheRepository(t *testing.T) {
	a := &byoFormAnswers{
		lines:   map[string]string{},
		choices: map[string]string{"Provider": "github", "Repository": "https://github.com/acme/infra"},
	}
	a.install(t)
	_, asked, err := askIacAttach(api.AttachIacParams{Path: "iac/aws", Ref: "main"}, byoFormRepos(), true)
	if err != nil {
		t.Fatalf("askIacAttach: %v", err)
	}
	if !asked {
		t.Error("the repository was picked and the run reports asking nothing")
	}
}

func TestByoForm_ChartAttachSkipsTheChartPathForAnOCIRepo(t *testing.T) {
	a := &byoFormAnswers{
		lines:   map[string]string{"Chart id": "api", "Git ref": "", "Namespace": ""},
		choices: map[string]string{},
	}
	a.install(t)

	got, _, err := askChartAttach(api.AttachChartParams{RepoURL: "OCI://registry.example.com/acme/api"}, byoFormRepos(), true)
	if err != nil {
		t.Fatalf("askChartAttach: %v", err)
	}
	for _, title := range a.asked {
		if title == "Chart path" {
			t.Error("an OCI chart is named by its URL's last segment; asking for a path invites a value the server ignores")
		}
	}
	if got.ChartPath != "" {
		t.Errorf("ChartPath = %q, want empty", got.ChartPath)
	}
}

func TestByoForm_ChartAttachAsksNothingWhenPromptingIsOff(t *testing.T) {
	byoFormNoQuestions(t)
	in := api.AttachChartParams{Project: "shop"}
	got, asked, err := askChartAttach(in, byoFormRepos(), false)
	if err != nil {
		t.Fatalf("askChartAttach: %v", err)
	}
	if asked {
		t.Error("asked must be false — nothing was asked")
	}
	if !reflect.DeepEqual(got, in) {
		t.Errorf("the params must be returned untouched: %+v", got)
	}
}

func TestByoForm_ChartAttachPropagatesAQuestionsError(t *testing.T) {
	a := &byoFormAnswers{
		lines:   map[string]string{},
		lineErr: map[string]error{"Chart id": fmt.Errorf("prompt closed")},
	}
	a.install(t)
	if _, _, err := askChartAttach(api.AttachChartParams{}, byoFormRepos(), true); err == nil {
		t.Fatal("an abandoned prompt must abort the attach, not send an empty id to the server")
	}
}

// TestByoForm_ChartAttachReplayCoversEveryFlagBackedField is the "flags are a COMPLETE contract"
// proof, taken from the RESOLVED params rather than from a list typed here.
//
// The set of flags the line must carry is DERIVED from byoFields, so a field added to the spec and
// forgotten in the replay builder fails here. Each token is then resolved against the real command,
// so a flag renamed in cobra and left in the builder fails too.
func TestByoForm_ChartAttachReplayCoversEveryFlagBackedField(t *testing.T) {
	prevFile, prevSet := chartAttachValuesFile, chartAttachSet
	chartAttachValuesFile, chartAttachSet = "./api-values.yaml", []string{"replicas=2"}
	t.Cleanup(func() { chartAttachValuesFile, chartAttachSet = prevFile, prevSet })

	p := api.AttachChartParams{
		Project: "shop", Env: "dev", ID: "api",
		RepoURL: "https://github.com/acme/charts", ChartPath: "charts/api",
		Ref: "v1.2.3", Namespace: "shop-api",
	}
	args := chartAttachReplayArgs(p)
	line := strings.Join(args, " ")

	if args[0] != "alethia" || args[1] != "chart" || args[2] != "attach" || args[3] != "api" {
		t.Fatalf("the replay must start with the command and its positional: %v", args[:4])
	}

	cmd, _, err := rootCmd.Find([]string{"chart", "attach"})
	if err != nil {
		t.Fatalf("resolve chart attach: %v", err)
	}
	expected := 0
	for _, f := range byoFields {
		if f.Flag == "" {
			continue
		}
		if f.Command != "alethia chart attach" && f.Command != "alethia chart" {
			continue
		}
		expected++
		if !strings.Contains(line, "--"+f.Flag+" ") {
			t.Errorf("the replay line omits --%s, a field the form can set:\n      %s", f.Flag, line)
		}
	}
	if expected == 0 {
		t.Fatal("no flag-backed field was derived — this assertion checked nothing")
	}
	for _, token := range args {
		if !strings.HasPrefix(token, "--") {
			continue
		}
		if docsLookupFlag(cmd, token) == nil {
			t.Errorf("the replay line passes %s, which `alethia chart attach` does not accept", token)
		}
	}
}

// ── iac attach ─────────────────────────────────────────────────────────────────────────────────

func TestByoForm_IacAttachAsksForEveryMissingField(t *testing.T) {
	a := &byoFormAnswers{
		lines: map[string]string{
			"Module path": "iac/aws",
			"Git ref":     "main",
		},
		choices: map[string]string{
			"Provider":   "github",
			"Repository": "https://github.com/acme/infra",
		},
	}
	a.install(t)

	got, asked, err := askIacAttach(api.AttachIacParams{Project: "shop", Env: "dev"}, byoFormRepos(), true)
	if err != nil {
		t.Fatalf("askIacAttach: %v", err)
	}
	if !asked {
		t.Error("asked must be true")
	}
	if got.RepoURL != "https://github.com/acme/infra" {
		t.Errorf("RepoURL = %q", got.RepoURL)
	}
	if got.Path != "iac/aws" {
		t.Errorf("Path = %q — the answer to the Module path question landed elsewhere", got.Path)
	}
	if got.Ref != "main" {
		t.Errorf("Ref = %q — the answer to the Git ref question landed elsewhere", got.Ref)
	}
}

// An EMPTY module path is a real answer — it means the repository root — and must not be re-asked
// or turned into an error. The question exists so a reader learns the field is there.
func TestByoForm_IacAttachAcceptsAnEmptyModulePath(t *testing.T) {
	a := &byoFormAnswers{
		lines:   map[string]string{"Module path": "", "Git ref": ""},
		choices: map[string]string{"Provider": "github", "Repository": "https://github.com/acme/infra"},
	}
	a.install(t)

	got, _, err := askIacAttach(api.AttachIacParams{}, byoFormRepos(), true)
	if err != nil {
		t.Fatalf("askIacAttach: %v", err)
	}
	if got.Path != "" || got.Ref != "" {
		t.Errorf("an empty answer must be kept as empty: %+v", got)
	}
	if got.RepoURL == "" {
		t.Error("the repository is the one field the attach cannot do without")
	}
}

func TestByoForm_IacAttachAsksNothingWhenPromptingIsOff(t *testing.T) {
	byoFormNoQuestions(t)
	in := api.AttachIacParams{Project: "shop", RepoURL: ""}
	got, asked, err := askIacAttach(in, byoFormRepos(), false)
	if err != nil {
		t.Fatalf("askIacAttach: %v", err)
	}
	if asked || got.RepoURL != "" {
		t.Errorf("nothing may be filled in with prompting off: asked=%v %+v", asked, got)
	}
}

func TestByoForm_IacAttachReplayCoversEveryFlagBackedField(t *testing.T) {
	prevVar := iacAttachVar
	iacAttachVar = []string{"region=eu-west-1"}
	t.Cleanup(func() { iacAttachVar = prevVar })

	args := iacAttachReplayArgs(api.AttachIacParams{
		Project: "shop", Env: "dev", RepoURL: "https://github.com/acme/infra",
		Path: "iac/aws", Ref: "main",
	})
	line := strings.Join(args, " ")
	cmd, _, err := rootCmd.Find([]string{"iac", "attach"})
	if err != nil {
		t.Fatalf("resolve iac attach: %v", err)
	}
	expected := 0
	for _, f := range byoFields {
		if f.Flag == "" || (f.Command != "alethia iac attach" && f.Command != "alethia iac") {
			continue
		}
		expected++
		if !strings.Contains(line, "--"+f.Flag+" ") {
			t.Errorf("the replay line omits --%s:\n      %s", f.Flag, line)
		}
	}
	if expected == 0 {
		t.Fatal("no flag-backed field was derived — this assertion checked nothing")
	}
	for _, token := range args {
		if strings.HasPrefix(token, "--") && docsLookupFlag(cmd, token) == nil {
			t.Errorf("the replay line passes %s, which `alethia iac attach` does not accept", token)
		}
	}
}

// ── the repository picker ──────────────────────────────────────────────────────────────────────

func TestByoForm_RepoPickerOffersTheConnectedRepositories(t *testing.T) {
	a := &byoFormAnswers{
		lines:   map[string]string{},
		choices: map[string]string{"Provider": "github", "Repository": "https://github.com/acme/infra"},
	}
	a.install(t)

	got, err := promptRepoURL(byoFormRepos(), mustByoField("alethia iac attach", byoKeyRepo))
	if err != nil {
		t.Fatalf("promptRepoURL: %v", err)
	}
	if got != "https://github.com/acme/infra" {
		t.Errorf("got %q", got)
	}
	opts := a.options["Repository"]
	if len(opts) != 3 {
		t.Fatalf("want two repositories plus the escape hatch, got %d options", len(opts))
	}
	// The option VALUE is what reaches --repo, so it must be the URL and not the display name.
	for _, o := range opts[:2] {
		if !strings.HasPrefix(o.Value, "https://") {
			t.Errorf("option %q carries the value %q; the picker must hand back a URL", o.Key, o.Value)
		}
	}
	if opts[2].Key != byoTypeARepoURL || opts[2].Value != "" {
		t.Errorf("the last option must be the typed-URL escape hatch, got %q/%q", opts[2].Key, opts[2].Value)
	}
	// The label has to distinguish a private repository from a public one, because that is the
	// difference that decides whether a token is needed at job time.
	if !strings.Contains(opts[0].Key, "private") || !strings.Contains(opts[1].Key, "public") {
		t.Errorf("the labels must state visibility: %q, %q", opts[0].Key, opts[1].Key)
	}
}

func TestByoForm_RepoPickerEscapeHatchFallsBackToATypedLine(t *testing.T) {
	a := &byoFormAnswers{
		lines:   map[string]string{"Repository": "https://git.example.com/x/y"},
		choices: map[string]string{"Provider": "github", "Repository": ""},
	}
	a.install(t)

	got, err := promptRepoURL(byoFormRepos(), mustByoField("alethia iac attach", byoKeyRepo))
	if err != nil {
		t.Fatalf("promptRepoURL: %v", err)
	}
	if got != "https://git.example.com/x/y" {
		t.Errorf("choosing the escape hatch must open a typed line, got %q", got)
	}
}

// A listing failure is NOT an attach failure. An org that has connected no git provider, or a
// provider API having a bad minute, must still be able to attach a public repository by URL.
func TestByoForm_RepoPickerDegradesToATypedLine(t *testing.T) {
	for name, list := range map[string]repoLister{
		"the listing fails": func(string) ([]api.Repository, error) {
			return nil, fmt.Errorf("provider not connected")
		},
		"nothing is connected": func(string) ([]api.Repository, error) { return nil, nil },
		"every repo lacks a URL": func(string) ([]api.Repository, error) {
			return []api.Repository{{Name: "broken"}}, nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			a := &byoFormAnswers{
				lines:   map[string]string{"Repository": "https://github.com/acme/public"},
				choices: map[string]string{"Provider": "github"},
			}
			a.install(t)
			got, err := promptRepoURL(list, mustByoField("alethia iac attach", byoKeyRepo))
			if err != nil {
				t.Fatalf("promptRepoURL: %v", err)
			}
			if got != "https://github.com/acme/public" {
				t.Errorf("got %q, want the typed answer", got)
			}
			if _, opened := a.options["Repository"]; opened {
				t.Error("a picker with nothing to pick must not be opened")
			}
		})
	}
}

// The provider question's options are the shared list, so a provider added to gitProviders reaches
// both the picker and `repo list --provider`'s help without a second edit.
func TestByoForm_RepoPickerOffersEveryKnownProvider(t *testing.T) {
	a := &byoFormAnswers{
		lines:   map[string]string{},
		choices: map[string]string{"Provider": "github", "Repository": "https://github.com/acme/infra"},
	}
	a.install(t)
	if _, err := promptRepoURL(byoFormRepos(), mustByoField("alethia iac attach", byoKeyRepo)); err != nil {
		t.Fatalf("promptRepoURL: %v", err)
	}
	opts := a.options["Provider"]
	if len(opts) != len(gitProviders) {
		t.Fatalf("the picker offers %d providers, gitProviders has %d", len(opts), len(gitProviders))
	}
	for i, p := range gitProviders {
		if opts[i].Value != p {
			t.Errorf("option %d is %q, want %q", i, opts[i].Value, p)
		}
		if !strings.Contains(repoListCmd.Flags().Lookup("provider").Usage, p) {
			t.Errorf("--provider's help does not mention %q; the two renderings of gitProviders disagree", p)
		}
	}
}

// ── the attached-chart picker ──────────────────────────────────────────────────────────────────

func TestByoForm_ChartPickerOffersTheAttachedCharts(t *testing.T) {
	a := &byoFormAnswers{
		lines:   map[string]string{},
		choices: map[string]string{"Chart": "web"},
	}
	a.install(t)

	list := func() (*api.ProjectByoCharts, error) {
		return &api.ProjectByoCharts{Charts: []api.ByoChart{
			{ID: "api", RepoURL: "https://github.com/acme/charts", ChartPath: "charts/api", Ref: "main", ScanStatus: "done"},
			{ID: "web", RepoURL: "https://github.com/acme/charts", ChartPath: "charts/api", Ref: "v2", ScanStatus: "unscanned"},
		}}, nil
	}
	got, err := promptChartID(list, mustByoField("alethia chart detach", byoKeyChartID), "dev")
	if err != nil {
		t.Fatalf("promptChartID: %v", err)
	}
	if got != "web" {
		t.Errorf("got %q, want the chosen id", got)
	}
	opts := a.options["Chart"]
	if len(opts) != 2 {
		t.Fatalf("want two options, got %d", len(opts))
	}
	if opts[0].Value != "api" || opts[1].Value != "web" {
		t.Errorf("the option VALUES must be the ids the command sends: %q, %q", opts[0].Value, opts[1].Value)
	}
	// The label is asserted TERM BY TERM, not by comparing the two rows to each other. Both charts
	// here carry distinct ids, so "the labels differ" is true however much of the label is dropped —
	// an aggregate that cannot fail. What has to be there is the ref (these two come from the same
	// repository and the same path, and it is the only thing that separates them), the path, and the
	// scan status, which is what decides whether the chart is deployable at all.
	for _, want := range []string{"api", "charts/api", "https://github.com/acme/charts", "main", "done"} {
		if !strings.Contains(opts[0].Key, want) {
			t.Errorf("the label %q does not name %q", opts[0].Key, want)
		}
	}
	for _, want := range []string{"web", "v2", "unscanned"} {
		if !strings.Contains(opts[1].Key, want) {
			t.Errorf("the label %q does not name %q", opts[1].Key, want)
		}
	}
}

func TestByoForm_ChartPickerRefusesAnEmptyEnvironment(t *testing.T) {
	for name, list := range map[string]chartLister{
		"nothing attached": func() (*api.ProjectByoCharts, error) { return &api.ProjectByoCharts{}, nil },
		"nil view":         func() (*api.ProjectByoCharts, error) { return nil, nil },
		"charts with no ids": func() (*api.ProjectByoCharts, error) {
			return &api.ProjectByoCharts{Charts: []api.ByoChart{{RepoURL: "https://x/y"}}}, nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			byoFormNoQuestions(t)
			_, err := promptChartID(list, mustByoField("alethia chart detach", byoKeyChartID), "dev")
			if err == nil {
				t.Fatal("a picker with nothing to pick must be an error, not an empty prompt")
			}
			if !strings.Contains(err.Error(), "dev") {
				t.Errorf("the refusal must name the environment it looked in: %v", err)
			}
		})
	}
}

func TestByoForm_ChartPickerPropagatesAListingError(t *testing.T) {
	byoFormNoQuestions(t)
	_, err := promptChartID(func() (*api.ProjectByoCharts, error) {
		return nil, fmt.Errorf("boom")
	}, mustByoField("alethia chart detach", byoKeyChartID), "dev")
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("a listing failure must surface, got %v", err)
	}
}

// ── resolving which chart ──────────────────────────────────────────────────────────────────────

// An id on the command line is a LOOKUP KEY: it is passed through byte for byte and no listing call
// is made for it. Resolving it against a list would let a listing failure block a command that had
// already been told its answer.
func TestByoForm_ResolveChartIDPassesAnExplicitIDThrough(t *testing.T) {
	byoFormNoQuestions(t)
	f := &fakeClient{err: fmt.Errorf("the listing endpoint must not be called")}
	got, err := resolveChartID(f, "My Chart", "shop", "dev", true, byoKeyChartID, "alethia chart detach")
	if err != nil {
		t.Fatalf("resolveChartID: %v", err)
	}
	if got != "My Chart" {
		t.Errorf("got %q, want the id byte for byte", got)
	}
}

func TestByoForm_ResolveChartIDRefusesToGuessWhenItCannotAsk(t *testing.T) {
	byoFormNoQuestions(t)
	f := &fakeClient{}
	_, err := resolveChartID(f, "", "shop", "dev", false, byoKeyChartID, "alethia chart detach")
	if err == nil {
		t.Fatal("with no id and no way to ask, the command must refuse rather than send an empty id")
	}
	if !strings.Contains(err.Error(), "argument") {
		t.Errorf("the refusal must name what to pass: %v", err)
	}
}

func TestByoForm_ResolveChartIDAsksWhenItCan(t *testing.T) {
	a := &byoFormAnswers{lines: map[string]string{}, choices: map[string]string{"Chart": "api"}}
	a.install(t)
	f := &fakeClient{byoCharts: &api.ProjectByoCharts{Charts: []api.ByoChart{{ID: "api"}}}}
	got, err := resolveChartID(f, "", "shop", "dev", true, byoKeyChartID, "alethia chart scan")
	if err != nil {
		t.Fatalf("resolveChartID: %v", err)
	}
	if got != "api" {
		t.Errorf("got %q", got)
	}
}

// ── end to end, through the real cobra tree ────────────────────────────────────────────────────

// TestByoForm_ChartDetachNamesTheChartItResolved drives the whole path: no id on the command line,
// a terminal, the picker, and then a confirmation that must NAME what it is about to detach.
//
// The naming is the point. A prompt that says "Detach this chart?" after the user chose from a list
// is asking them to confirm a selection they can no longer see, and the id is the only thing that
// distinguishes two charts from the same repository.
func TestByoForm_ChartDetachNamesTheChartItResolved(t *testing.T) {
	s, run := hygCliConfirmEnv(t)
	byoFormTTY(t)

	a := &byoFormAnswers{lines: map[string]string{}, choices: map[string]string{"Chart": "c1"}}
	a.install(t)

	var title string
	prev := confirm
	confirm = func(ti, _ string) bool { title = ti; return true }
	t.Cleanup(func() { confirm = prev })

	if code := run("chart", "detach", "--project", "p1", "--env", "e1"); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if !strings.Contains(title, "c1") {
		t.Errorf("the confirmation must name the resolved chart, got %q", title)
	}
	// The id travels in the DELETE's BODY, not its path, so the path alone cannot tell which chart
	// went. This is the assertion that distinguishes "detached the chart the user picked" from
	// "detached whatever the listing returned first".
	if !s.saw("DELETE", "/api/cli/projects/p1/byo-charts") {
		t.Errorf("no detach reached the control plane; requests: %v", s.mutations())
	}
	if !s.sentBody(`"id":"c1"`) {
		t.Error("the detach did not carry the id the picker resolved")
	}
}

// The other half: with prompting disabled and no id, the command must refuse — not detach whichever
// chart the listing happened to return first.
func TestByoForm_ChartDetachScriptedWithoutAnIDRefuses(t *testing.T) {
	s, run := hygCliConfirmEnv(t)
	if code := run("chart", "detach", "--project", "p1", "--env", "e1", "--yes", "--no-input"); code == 0 {
		t.Fatal("a scripted detach with no id must fail")
	}
	if muts := s.mutations(); len(muts) > 0 {
		t.Errorf("nothing may be detached: %v", muts)
	}
}

// `chart scan` shares resolveChartID with detach and is not destructive, so its no-id arm has to be
// driven separately: nothing else in the suite reaches it.
func TestByoForm_ChartScanPicksWhenGivenNoID(t *testing.T) {
	s, run := hygCliConfirmEnv(t)
	byoFormTTY(t)
	a := &byoFormAnswers{lines: map[string]string{}, choices: map[string]string{"Chart": "c1"}}
	a.install(t)

	if code := run("chart", "scan", "--project", "p1", "--env", "e1"); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if !s.saw("POST", "/api/cli/projects/p1/byo-charts/scan") {
		t.Errorf("no scan reached the control plane; requests: %v", s.mutations())
	}
	if !s.sentBody(`"id":"c1"`) {
		t.Error("the scan did not carry the id the picker resolved")
	}
}

// ── the shared surface, in the cells a person reads ────────────────────────────────────────────

// TestByoForm_ChartRowsDashTheOptionalCells pins the two cells that are legitimately empty.
//
// An OCI chart has no path and a chart tracking its repository's default branch has no ref. Both
// used to render as a blank cell, which reads as missing data rather than as "this chart does not
// have one" — the exact distinction ui.OrDash exists to make, and the reason the CLI has one
// empty-value sentinel instead of three.
func TestByoForm_ChartRowsDashTheOptionalCells(t *testing.T) {
	rows := chartRows([]api.ByoChart{
		{ID: "api", RepoURL: "oci://registry.example.com/acme/api", Status: "Synced", ScanStatus: "done"},
		{ID: "web", RepoURL: "https://github.com/acme/charts", ChartPath: "charts/web", Ref: "v2", Status: "Synced", ScanStatus: "done"},
	}, ui.FormatTable)
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	if rows[0][2] != ui.SymbolDash || rows[0][3] != ui.SymbolDash {
		t.Errorf("an OCI chart with no ref must dash both cells, got %q and %q", rows[0][2], rows[0][3])
	}
	if rows[1][2] != "charts/web" || rows[1][3] != "v2" {
		t.Errorf("a present value must be shown, not dashed: %v", rows[1])
	}
}

// TestByoForm_StagedRowsRenderTheConsolesDate pins the Created cell.
//
// It printed the wire's RFC3339 verbatim — `2026-03-09T15:04:05Z` in a column a person reads —
// while the console showed `9 Mar 2026, 15:04` for the same instant. That is the "two
// implementations of one product" the CLI programme exists to close, in one table cell.
func TestByoForm_StagedRowsRenderTheConsolesDate(t *testing.T) {
	id := "cmp-1"
	rows := stagedRows([]api.StagedChange{
		{Op: "update", ComponentType: "cluster", ComponentID: &id, CreatedAt: "2026-03-09T15:04:05Z"},
		{Op: "create", ComponentType: "cluster", CreatedAt: ""},
	}, ui.FormatTable)
	if rows[0][3] != "9 Mar 2026, 15:04" {
		t.Errorf("Created = %q, want the console's absolute-date rule", rows[0][3])
	}
	if rows[0][2] != "cmp-1" {
		t.Errorf("Component ID = %q", rows[0][2])
	}
	// A create has no component id and no useful stamp; both must be the ONE sentinel.
	if rows[1][2] != ui.SymbolDash || rows[1][3] != ui.SymbolDash {
		t.Errorf("an absent value must be the shared dash: %v", rows[1])
	}
}

// ── resolving the project ──────────────────────────────────────────────────────────────────────

// byoFormProjectCmd builds a command carrying the group's --project flag, so byoProject can be
// driven without executing the real tree.
func byoFormProjectCmd(t *testing.T, value string) *cobra.Command {
	t.Helper()
	c := &cobra.Command{Use: "show"}
	c.Flags().StringP("project", "p", "", "Project")
	if value != "" {
		if err := c.Flags().Set("project", value); err != nil {
			t.Fatalf("set --project: %v", err)
		}
	}
	return c
}

func TestByoForm_ProjectFlagWinsAndIsNeverAskedFor(t *testing.T) {
	got, err := byoProject(byoFormProjectCmd(t, "  shop  "), "tok", true)
	if err != nil {
		t.Fatalf("byoProject: %v", err)
	}
	if got != "shop" {
		t.Errorf("got %q — the flag's value is trimmed and used as given", got)
	}
}

// With picking disallowed — --no-input, `-o json`, or a redirected stdout — an omitted --project is
// the same hard refusal it has always been, and it names the flag.
func TestByoForm_ProjectRefusalNamesTheFlagWhenItCannotAsk(t *testing.T) {
	_, err := byoProject(byoFormProjectCmd(t, ""), "tok", false)
	if err == nil {
		t.Fatal("an omitted --project with no way to ask must refuse")
	}
	if !strings.Contains(err.Error(), "--project") {
		t.Errorf("the refusal must name the flag: %v", err)
	}
}

// ── the destructive contract, both arms ────────────────────────────────────────────────────────

// TestByoForm_DetachHonoursNo drives the DECLINE arm of the group's two destructive commands.
//
// It is not redundant with the derived confirm guard, and the gap it closes was measured: replacing
// `if !confirmDestructive(…) { return }` with `_ = confirmDestructive(…)` — a confirmation wired in
// front of a call that happens anyway — left the whole confirm suite green. `--no-input` without
// `--yes` still dies inside confirmDestructive, so the fatal test cannot see it; the only arm that
// can is a terminal where the operator says NO.
//
// A destructive command that asks "are you sure?" and proceeds when told no is a worse failure than
// one that never asked, because the operator has been given a reason to believe they were heard.
func TestByoForm_DetachHonoursNo(t *testing.T) {
	for name, args := range map[string][]string{
		"chart detach": {"chart", "detach", "c1", "--project", "p1", "--env", "e1"},
		"iac detach":   {"iac", "detach", "--project", "p1", "--env", "e1"},
	} {
		t.Run(name, func(t *testing.T) {
			s, run := hygCliConfirmEnv(t)
			byoFormTTY(t)
			prev := confirm
			confirm = func(string, string) bool { return false }
			t.Cleanup(func() { confirm = prev })

			if code := run(args...); code != 0 {
				t.Fatalf("exit code = %d, want 0 — a declined prompt is a choice, not an error", code)
			}
			if muts := s.mutations(); len(muts) > 0 {
				t.Errorf("%s was declined and still changed state: %v", name, muts)
			}
		})
	}
}

// The other half of the same seam: told YES, the command must actually act. A confirmation in front
// of a call that then never happens would satisfy the test above perfectly.
func TestByoForm_DetachActsOnYes(t *testing.T) {
	for name, tc := range map[string]struct {
		args   []string
		method string
		path   string
	}{
		"chart detach": {[]string{"chart", "detach", "c1", "--project", "p1", "--env", "e1", "--yes"},
			"DELETE", "/api/cli/projects/p1/byo-charts"},
		"iac detach": {[]string{"iac", "detach", "--project", "p1", "--env", "e1", "--yes"},
			"DELETE", "/api/cli/projects/p1/byo-iac"},
	} {
		t.Run(name, func(t *testing.T) {
			s, run := hygCliConfirmEnv(t)
			if code := run(tc.args...); code != 0 {
				t.Fatalf("exit code = %d, want 0", code)
			}
			if !s.saw(tc.method, tc.path) {
				t.Errorf("%s was confirmed and sent nothing: %v", name, s.mutations())
			}
		})
	}
}

// The `iac detach` confirmation names the ENVIRONMENT it is about to stop managing. There is only
// one source per environment, so there is no id to name — the environment is the whole answer to
// "which one", and a run that omitted --env is acting on the project's default.
func TestByoForm_IacDetachNamesTheEnvironment(t *testing.T) {
	_, run := hygCliConfirmEnv(t)
	byoFormTTY(t)
	var title string
	prev := confirm
	confirm = func(ti, _ string) bool { title = ti; return false }
	t.Cleanup(func() { confirm = prev })

	if code := run("iac", "detach", "--project", "p1", "--env", "prod"); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if !strings.Contains(title, "prod") {
		t.Errorf("the confirmation must name the environment, got %q", title)
	}
}

// ── the abandoned-prompt arms ──────────────────────────────────────────────────────────────────
//
// Every question in this group can be walked away from — ctrl-C, or a terminal that vanishes — and
// each one has to abort the command rather than carry an empty answer into a request. They are
// grouped here because the failure is identical in every case and worth stating once: an abandoned
// `--repo` question that returned "" would send an attach with no repository, and the server's
// refusal would name a field the user never got to answer.

// byoFormAbandon makes both question seams fail, as an abandoned prompt does.
func byoFormAbandon(t *testing.T) {
	t.Helper()
	prevLine, prevChoice := askLine, askChoice
	askLine = func(string, string) (string, error) { return "", fmt.Errorf("form abandoned") }
	askChoice = func(string, string, []huh.Option[string]) (string, error) {
		return "", fmt.Errorf("form abandoned")
	}
	t.Cleanup(func() { askLine, askChoice = prevLine, prevChoice })
}

func TestByoForm_AnAbandonedPromptAbortsTheCommand(t *testing.T) {
	byoFormAbandon(t)
	repoField := mustByoField("alethia iac attach", byoKeyRepo)

	if _, err := promptRepoURL(byoFormRepos(), repoField); err == nil {
		t.Error("an abandoned provider question must abort, not fall through to an empty URL")
	}
	if _, err := promptChartID(func() (*api.ProjectByoCharts, error) {
		return &api.ProjectByoCharts{Charts: []api.ByoChart{{ID: "api"}}}, nil
	}, mustByoField("alethia chart detach", byoKeyChartID), "dev"); err == nil {
		t.Error("an abandoned chart picker must abort, not return an empty id")
	}
	// Each attach must surface the abandonment from whichever question was reached first.
	if _, _, err := askChartAttach(api.AttachChartParams{RepoURL: "oci://r/x", ID: "api"}, byoFormRepos(), true); err == nil {
		t.Error("chart attach must abort when a later question is abandoned")
	}
	if _, _, err := askIacAttach(api.AttachIacParams{RepoURL: "https://x/y"}, byoFormRepos(), true); err == nil {
		t.Error("iac attach must abort when the path question is abandoned")
	}
	if _, _, err := askIacAttach(api.AttachIacParams{}, byoFormRepos(), true); err == nil {
		t.Error("iac attach must abort when the repository question is abandoned")
	}
}

// The repository picker's own abandonment, distinct from the provider question's: the list was
// offered and the user walked away from it.
func TestByoForm_AnAbandonedRepositoryPickerAborts(t *testing.T) {
	prevLine, prevChoice := askLine, askChoice
	askChoice = func(title string, _ string, _ []huh.Option[string]) (string, error) {
		if title == "Provider" {
			return "github", nil
		}
		return "", fmt.Errorf("form abandoned")
	}
	askLine = func(string, string) (string, error) {
		t.Error("an abandoned picker must not silently fall through to a typed line")
		return "", nil
	}
	t.Cleanup(func() { askLine, askChoice = prevLine, prevChoice })

	if _, err := promptRepoURL(byoFormRepos(), mustByoField("alethia iac attach", byoKeyRepo)); err == nil {
		t.Error("the abandonment must surface")
	}
}

// A picker that comes back with nothing selected is not the same as one that errored, and it must
// not send an empty id. huh binds a select to its first option, so this is the malformed case
// rather than a dismissal — which is exactly why it needs its own answer.
func TestByoForm_ChartPickerRefusesAnEmptySelection(t *testing.T) {
	prevChoice := askChoice
	askChoice = func(string, string, []huh.Option[string]) (string, error) { return "", nil }
	t.Cleanup(func() { askChoice = prevChoice })

	_, err := promptChartID(func() (*api.ProjectByoCharts, error) {
		return &api.ProjectByoCharts{Charts: []api.ByoChart{{ID: "api"}}}, nil
	}, mustByoField("alethia chart scan", byoKeyChartID), "dev")
	if err == nil {
		t.Fatal("no selection must be an error, never an empty id sent to the server")
	}
}

// TestByoForm_AskChoiceRunsTheRealSelect drives the production seam, not a stub of it.
//
// runHuhForm returns a TTY error under `go test` — measured, it does not block — so both arms of
// the real askChoice are reachable: the error path here, and the value path when the form succeeds.
// Without this the shipped implementation of the group's only new prompt is never executed at all.
func TestByoForm_AskChoiceRunsTheRealSelect(t *testing.T) {
	opts := []huh.Option[string]{huh.NewOption("github", "github")}

	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return fmt.Errorf("no tty") }
	t.Cleanup(func() { runHuhForm = prev })
	if _, err := askChoice("Provider", "which", opts); err == nil {
		t.Error("a form that cannot run must surface its error")
	}

	runHuhForm = func(...*huh.Group) error { return nil }
	got, err := askChoice("Provider", "which", opts)
	if err != nil {
		t.Fatalf("askChoice: %v", err)
	}
	// MEASURED, not assumed: huh binds a Select to its FIRST option when the group is built, so a
	// form that never ran still comes back holding "github" rather than the zero value. That is
	// why `promptRepoURL` cannot treat "the picker returned something" as "the user chose it", and
	// why the escape hatch carries the empty string — the one value no option can produce.
	if got != "github" {
		t.Errorf("got %q, want the option huh bound at construction", got)
	}
}

// byoGroupOf is defensive about a path with no group. Its guard is not reachable from the live
// tree — every command in this group is at least two words — so it is driven directly rather than
// left as a branch nobody has run.
func TestByoForm_GroupOfHandlesAShortPath(t *testing.T) {
	if got := byoGroupOf("alethia chart attach"); got != "alethia chart" {
		t.Errorf("got %q", got)
	}
	if got := byoGroupOf("alethia"); got != "alethia" {
		t.Errorf("a path with no group is returned whole, got %q", got)
	}
}
