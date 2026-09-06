// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/charmbracelet/huh"
)

func strptr(s string) *string { return &s }

// clustersSetNoInput pins the terminal posture for the duration of a test and restores it: both
// noInputMode and the stream a form draws on, which requireInteractiveForm reads too. The package
// shares these globals and the tests in it are not parallel, so a leaked value would decide a LATER
// test's interactive arm.
//
// The form stream follows the mode — `v == false` means "prompting is on", which also requires a
// screen. A test that wants the two to DISAGREE (prompting on, the form's stream redirected) uses
// withInteractiveOutputRedirected; TestPickClusterRequiresATerminal does.
//
// It is interactiveOutIsTTY and NOT stdoutIsTTY: huh draws on stderr, so a redirected STDOUT never
// stopped this picker and never should. `alethia cluster get -o json > clusters.json` at a terminal
// is a working invocation, and the earlier spelling of this helper refused it.
func clustersSetNoInput(t *testing.T, v bool) {
	t.Helper()
	prev, prevOut := noInputMode, interactiveOutIsTTY
	noInputMode = v
	interactiveOutIsTTY = func() bool { return !v }
	t.Cleanup(func() { noInputMode, interactiveOutIsTTY = prev, prevOut })
}

// clustersStubForm replaces the huh runner with one that returns err and records that it ran.
//
// A stub can never answer the form: huh writes the selection through a pointer the group owns.
// That is why pickCluster's default is a real cluster rather than a zero value — it is what makes
// the SELECTED arm reachable here at all, and the test below asserts the default is the FIRST
// candidate rather than merely non-nil.
func clustersStubForm(t *testing.T, err error) *int {
	t.Helper()
	runs := 0
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error {
		runs++
		return err
	}
	t.Cleanup(func() { runHuhForm = prev })
	return &runs
}

// clusterMatchable pulls the bracketed selectors out of an error's candidate list, and fails when
// there are none rather than passing over an empty set.
//
// It exists so the assertion can be the real one — every value an error offers must RESOLVE —
// rather than a spelling check against a string the same test typed.
func clusterMatchable(t *testing.T, msg string) []string {
	t.Helper()
	var out []string
	rest := msg
	for {
		i := strings.Index(rest, "[")
		if i < 0 {
			break
		}
		rest = rest[i+1:]
		j := strings.Index(rest, "]")
		if j < 0 {
			break
		}
		out = append(out, rest[:j])
		rest = rest[j+1:]
	}
	if len(out) == 0 {
		t.Fatalf("no candidate selector in %q — the assertion it feeds would be vacuous", msg)
	}
	return out
}

// twoEnvsOneProject is the ordinary ambiguity: one project, two environments, two clusters, and
// the same project name on both. The old matcher returned whichever the API listed first.
var twoEnvsOneProject = []api.ClusterSummary{
	{ID: "clu_prod", ProjectName: "web", Environment: "production", ClusterName: "web-prod", Status: "ACTIVE"},
	{ID: "clu_stg", ProjectName: "web", Environment: "staging", ClusterName: "web-stg", Status: "CREATING"},
}

// TestClusterMatches covers the selector grammar: exact on project/cluster/id, the substring
// fallback, case-insensitivity, the empty selector, and — the reason it returns a SET — the
// project whose two environments both answer to the same name.
func TestClusterMatches(t *testing.T) {
	clusters := []api.ClusterSummary{
		{ID: "clu_1", ProjectName: "web", ClusterName: "web-eks"},
		{ID: "clu_2", ProjectName: "payments-api", ClusterName: "pay-eks"},
	}

	one := func(t *testing.T, got []api.ClusterSummary, wantID string) {
		t.Helper()
		if len(got) != 1 || got[0].ID != wantID {
			t.Fatalf("want exactly [%s], got %+v", wantID, got)
		}
	}

	one(t, clusterMatches(clusters, "WEB"), "clu_1")
	one(t, clusterMatches(clusters, "pay-eks"), "clu_2")
	one(t, clusterMatches(clusters, "clu_1"), "clu_1")
	one(t, clusterMatches(clusters, "  payments  "), "clu_2")

	if got := clusterMatches(clusters, "nope"); len(got) != 0 {
		t.Errorf("a selector that names nothing must match nothing, got %+v", got)
	}
	if got := clusterMatches(clusters, ""); len(got) != 0 {
		t.Errorf("an empty selector is the ask-me signal, not a wildcard; got %+v", got)
	}
	if got := clusterMatches(clusters, "   "); len(got) != 0 {
		t.Errorf("a whitespace selector is empty too; got %+v", got)
	}

	// Both environments of one project answer to the project name.
	if got := clusterMatches(twoEnvsOneProject, "web"); len(got) != 2 {
		t.Fatalf("an ambiguous selector must return every candidate, got %d: %+v", len(got), got)
	}

	// An exact hit SUPPRESSES the substring hits: `web` must not also drag in `web-internal`.
	mixed := []api.ClusterSummary{
		{ID: "clu_a", ProjectName: "web"},
		{ID: "clu_b", ProjectName: "web-internal"},
	}
	one(t, clusterMatches(mixed, "web"), "clu_a")
	// …and with no exact hit, the substring arm still finds both.
	if got := clusterMatches(mixed, "we"); len(got) != 2 {
		t.Fatalf("substring fallback should return both, got %+v", got)
	}
}

// TestResolveClusterErrors covers every arm that must NOT return a cluster. Exiting 0 on a miss is
// the failure this replaced: `alethia cluster get typo` printed a muted line and reported success.
func TestResolveClusterErrors(t *testing.T) {
	clustersSetNoInput(t, true)

	if _, err := resolveCluster(nil, "web"); !errors.Is(err, errNoClusters) {
		t.Errorf("an org with no clusters must say so, got %v", err)
	}

	_, err := resolveCluster(twoEnvsOneProject, "nope")
	if err == nil {
		t.Fatal("a selector that names nothing must be an error, not an empty screen")
	}
	// "so the next attempt can succeed" is the whole assertion: the candidates have to include a
	// value clusterMatches ACCEPTS. `web (production)` is a label and matches nothing.
	for _, want := range []string{"no cluster matches", "web (production)", "[web-prod]", "[web-stg]"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the miss %q is missing %q", err, want)
		}
	}
	for _, choice := range clusterMatchable(t, err.Error()) {
		if len(clusterMatches(twoEnvsOneProject, choice)) != 1 {
			t.Errorf("the miss offers %q, which does not name exactly one cluster", choice)
		}
	}

	// Ambiguous with prompting off: refuse and name both, rather than pick for the caller.
	_, err = resolveCluster(twoEnvsOneProject, "web")
	if err == nil {
		t.Fatal("an ambiguous selector with --no-input must refuse")
	}
	for _, want := range []string{"matches 2 clusters", "web (production)", "web (staging)"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("ambiguity error %q is missing %q", err, want)
		}
	}
	// …and the remedy it names has to work. Both candidates carry the same project name, so a
	// candidate list of labels alone would offer only strings that re-raise this same error.
	choices := clusterMatchable(t, err.Error())
	if len(choices) != 2 {
		t.Fatalf("both candidates need a selector, got %v", choices)
	}
	for _, choice := range choices {
		if len(clusterMatches(twoEnvsOneProject, choice)) != 1 {
			t.Errorf("the ambiguity error offers %q, which is still ambiguous", choice)
		}
	}

	// No selector with prompting off: the form can never be answered, so say what to pass.
	if _, err := resolveCluster(twoEnvsOneProject, ""); !errors.Is(err, errNoInput) {
		t.Errorf("an absent selector with --no-input must be errNoInput, got %v", err)
	}
}

// TestResolveClusterAsks covers the two arms that open the picker, and proves the form actually
// RAN rather than the value arriving some other way.
func TestResolveClusterAsks(t *testing.T) {
	clustersSetNoInput(t, false)

	runs := clustersStubForm(t, nil)
	got, err := resolveCluster(twoEnvsOneProject, "")
	if err != nil {
		t.Fatalf("absent selector at a terminal should ask, got %v", err)
	}
	if *runs != 1 {
		t.Fatalf("the picker must have run; runs = %d", *runs)
	}
	if got.ID != "clu_prod" {
		t.Errorf("the default selection is the FIRST candidate, got %s", got.ID)
	}

	// Ambiguous at a terminal: the picker is offered the MATCHES, not the whole list.
	//
	// The unrelated cluster is FIRST in the list on purpose. Offering the whole list would default
	// to it, and a fixture where the matches happen to lead cannot tell the two apart — the
	// mutation that passes `clusters` instead of `matches` survived exactly that ordering.
	withUnrelated := []api.ClusterSummary{
		{ID: "clu_other", ProjectName: "api", Environment: "production"},
		twoEnvsOneProject[0],
		twoEnvsOneProject[1],
	}
	got, err = resolveCluster(withUnrelated, "web")
	if err != nil {
		t.Fatalf("ambiguous selector at a terminal should ask, got %v", err)
	}
	if *runs != 2 {
		t.Fatalf("the picker must have run again; runs = %d", *runs)
	}
	if got.ID != "clu_prod" {
		t.Errorf("the picker must be offered the MATCHES, not the whole list — got %s", got.ID)
	}

	// A single match never asks.
	got, err = resolveCluster(twoEnvsOneProject, "web-stg")
	if err != nil {
		t.Fatalf("unambiguous selector: %v", err)
	}
	if got.ID != "clu_stg" {
		t.Errorf("got %s, want clu_stg", got.ID)
	}
	if *runs != 2 {
		t.Errorf("an unambiguous selector must not open a form; runs = %d", *runs)
	}
}

// TestPickClusterPropagatesFormError pins that an aborted or broken prompt is an error, not a
// silently-defaulted choice.
func TestPickClusterPropagatesFormError(t *testing.T) {
	clustersSetNoInput(t, false)
	boom := errors.New("tty exploded")
	clustersStubForm(t, boom)

	if _, err := pickCluster(twoEnvsOneProject, "Which?"); !errors.Is(err, boom) {
		t.Errorf("a failed form must surface, got %v", err)
	}
}

// TestClusterLabel pins the one human name a cluster has, in every place that renders one.
func TestClusterLabel(t *testing.T) {
	if got := clusterLabel(api.ClusterSummary{ProjectName: "web", Environment: "prod"}); got != "web (prod)" {
		t.Errorf("label = %q", got)
	}
	if got := clusterLabel(api.ClusterSummary{ProjectName: "web"}); got != "web" {
		t.Errorf("no environment ⇒ no parenthetical, got %q", got)
	}
	if got := clusterChoices(twoEnvsOneProject); got != "web (production) [web-prod], web (staging) [web-stg]" {
		t.Errorf("choices = %q", got)
	}
	// A cluster still being provisioned has no cluster name yet; the id is the selector then, and
	// clusterMatches accepts it.
	unnamed := []api.ClusterSummary{{ID: "clu_new", ProjectName: "web", Environment: "production"}}
	if got := clusterChoices(unnamed); got != "web (production) [clu_new]" {
		t.Errorf("a nameless cluster must fall back to its id, got %q", got)
	}
	if len(clusterMatches(unnamed, clusterSelector(unnamed[0]))) != 1 {
		t.Error("clusterSelector must return a value clusterMatches accepts")
	}
}

// TestPickClusterRequiresATerminal pins the arm noInputMode cannot see: prompting is on — nobody
// passed --no-input and stdin is a terminal — but the stream the form draws on is redirected, so
// the frames land in the caller's file and the screen shows nothing.
//
// `alethia cluster get 2> err.log` from an interactive shell is the whole case. It is stderr and
// not stdout: huh constructs its program with tea.WithOutput(os.Stderr), which ui.InteractiveOutput now
// states once for the whole CLI.
func TestPickClusterRequiresATerminal(t *testing.T) {
	clustersSetNoInput(t, false)
	withInteractiveOutputRedirected(t)
	runs := clustersStubForm(t, nil)

	_, err := resolveCluster(twoEnvsOneProject, "")
	if !errors.Is(err, errNoTTY) {
		t.Fatalf("a redirected form stream must refuse before opening a form, got %v", err)
	}
	if *runs != 0 {
		t.Errorf("the form must not have run; runs = %d", *runs)
	}
	if errors.Is(err, errNoInput) {
		t.Error("this is not the --no-input refusal — the next step a reader is given differs")
	}
}

// TestPickClusterAcceptsARedirectedStdout is the other half, and the arm the first spelling of this
// gate got WRONG: stdout is a file and the form's own stream is still a terminal, so the picker is
// perfectly drawable and must open.
//
// Measured against the shipped binary before this was written: `alethia cluster get -o json > f`
// under a real pty exited 1 with "stdout is not a terminal" while the picker it refused to show
// would have rendered on the still-attached stderr.
func TestPickClusterAcceptsARedirectedStdout(t *testing.T) {
	clustersSetNoInput(t, false)
	prev := stdoutIsTTY
	stdoutIsTTY = func() bool { return false }
	t.Cleanup(func() { stdoutIsTTY = prev })
	runs := clustersStubForm(t, nil)

	got, err := resolveCluster(twoEnvsOneProject, "")
	if err != nil {
		t.Fatalf("a redirected stdout must not stop a form that draws on stderr: %v", err)
	}
	if *runs != 1 {
		t.Errorf("the picker must have opened exactly once; runs = %d", *runs)
	}
	if got == nil {
		t.Fatal("the picker returned no cluster")
	}
}

// TestClusterFieldRows covers the present-only projection: the full field set plus the
// ArgoCD block (URL vs port-forward) and the minimal un-provisioned case.
func TestClusterFieldRows(t *testing.T) {
	cost := 96.0
	full := &api.ClusterSummary{
		ProjectName: "web", Environment: "prod", ClusterName: "web-eks",
		ClusterVersion: "1.30", Status: "ACTIVE", StatusMessage: "rolling",
		Region: "eu-central-1", NodeMinSize: 1, NodeDesiredSize: 3, NodeMaxSize: 5,
		EstimatedMonthlyCost: &cost, ArgocdURL: "https://argo.example",
	}
	rows := clusterFieldRows(full, nil, ui.FormatTable)
	got := map[string]string{}
	for _, r := range rows {
		got[r[0]] = r[1]
	}
	for _, key := range []string{"Status", "Message", "Cluster", "Version", "Region", "Nodes", "Est. cost", "ArgoCD", "ArgoCD admin"} {
		if _, ok := got[key]; !ok {
			t.Errorf("expected field %q in rows, got %+v", key, got)
		}
	}
	if got["ArgoCD"] != "https://argo.example" {
		t.Errorf("ArgoCD row should be the managed URL, got %q", got["ArgoCD"])
	}
	// Minor units, because the console shows minor units for the same number.
	if got["Est. cost"] != "$96.00/mo" {
		t.Errorf("cost row = %q, want $96.00/mo", got["Est. cost"])
	}

	// Un-provisioned (no cluster name): no ArgoCD block, no optional fields.
	bare := clusterFieldRows(&api.ClusterSummary{ProjectName: "x", Status: "QUEUED"}, nil, ui.FormatTable)
	for _, r := range bare {
		if r[0] == "ArgoCD" || r[0] == "ArgoCD admin" || r[0] == "Message" || r[0] == "Cluster" {
			t.Errorf("un-provisioned cluster should not emit %q", r[0])
		}
	}

	// Provisioned but no managed ingress ⇒ port-forward note.
	pf := clusterFieldRows(&api.ClusterSummary{ProjectName: "y", ClusterName: "y-eks", Status: "ACTIVE"}, nil, ui.FormatTable)
	var argocd string
	for _, r := range pf {
		if r[0] == "ArgoCD" {
			argocd = r[1]
		}
	}
	if !strings.Contains(argocd, "port-forward") {
		t.Errorf("no-ingress ArgoCD row should mention port-forward, got %q", argocd)
	}
}

// conformanceCase is one row of the committed formatter conformance table.
type conformanceCase struct {
	ID       string  `json:"id"`
	Amount   float64 `json:"amount"`
	Style    string  `json:"style"`
	Currency string  `json:"currency"`
	Want     string  `json:"want"`
}

// TestClusterCostAgreesWithTheConformanceTable drives the cluster cost cell against the table the
// CONSOLE generates (packages/format/conformance/format-cases.json), not against a value computed
// from the CLI's own code.
//
// That is the whole point. `fmt.Sprintf("$%.0f/mo", 12.5)` rendered `$12` — Go's %f rounds half to
// even — while the billing page rendered `$12.50`, and a test that compared the cell against
// `format.MonthlyRate(...)` would have agreed with whichever answer the CLI happened to produce.
// The expected strings here come from a file the CLI cannot write.
func TestClusterCostAgreesWithTheConformanceTable(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "format", "conformance", "format-cases.json"))
	if err != nil {
		t.Fatalf("read the conformance table: %v — it is the subject of this test, so an absent "+
			"file is a failure and never a skip", err)
	}
	var table struct {
		Cases struct {
			MonthlyRate []conformanceCase `json:"monthlyRate"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &table); err != nil {
		t.Fatalf("parse the conformance table: %v", err)
	}

	// The cluster cost is an ESTIMATE priced in USD, so those are the rows that bind it.
	const halfCent = "monthlyRate/estimate/HALF-CENT-ROUNDS-AWAY-FROM-ZERO"
	exercised, sawHalfCent := 0, false
	for _, c := range table.Cases.MonthlyRate {
		if c.Style != "estimate" || c.Currency != clusterCostCurrency {
			continue
		}
		exercised++
		if c.ID == halfCent {
			sawHalfCent = true
		}
		if got := clusterCost(c.Amount); got != c.Want {
			t.Errorf("%s: clusterCost(%v) = %q, the console renders %q", c.ID, c.Amount, got, c.Want)
		}
	}
	if exercised == 0 {
		t.Fatalf("no estimate/%s rows in the conformance table — every assertion above was vacuous",
			clusterCostCurrency)
	}
	if !sawHalfCent {
		t.Fatalf("%q is gone from the conformance table: it is the case this whole change exists "+
			"for, so its absence is a failure rather than one fewer row", halfCent)
	}
}

// TestGitopsRows covers each posture branch: failed step, unknown (no snapshot), the
// synced/healthy summary with revision truncation, and the apps-repo row.
func TestGitopsRows(t *testing.T) {
	// Failure banner with message.
	failed := gitopsRows(&api.ClusterGitops{
		LastDeployFailed: true, FailedStep: strptr("apply"), FailureMessage: strptr("quota"),
	})
	if !strings.Contains(failed[0][1], "failed at apply") || !strings.Contains(failed[0][1], "quota") {
		t.Errorf("failure line = %q", failed[0][1])
	}

	// Unknown — no trustworthy snapshot.
	unknown := gitopsRows(&api.ClusterGitops{StatusAvailable: false})
	if !strings.Contains(unknown[0][1], "unknown") {
		t.Errorf("unknown line = %q", unknown[0][1])
	}

	// Healthy summary with long revision truncated to 7 chars + apps repo row.
	ok := gitopsRows(&api.ClusterGitops{
		StatusAvailable: true, Total: 4, Synced: 4, Healthy: 3,
		Revision: strptr("abcdef1234567890"), AppsRepo: strptr("github.com/acme/apps"),
	})
	if !strings.Contains(ok[0][1], "4/4 synced") || !strings.Contains(ok[0][1], "3/4 healthy") {
		t.Errorf("summary line = %q", ok[0][1])
	}
	if !strings.Contains(ok[0][1], "rev abcdef1") || strings.Contains(ok[0][1], "abcdef12") {
		t.Errorf("revision should be truncated to 7 chars, got %q", ok[0][1])
	}
	if len(ok) < 2 || ok[1][0] != "Apps repo" || ok[1][1] != "github.com/acme/apps" {
		t.Errorf("apps-repo row missing/wrong: %+v", ok)
	}
}

// TestRenderCluster covers the three output formats and the with/without-gitops record shape.
func TestRenderCluster(t *testing.T) {
	c := &api.ClusterSummary{ProjectName: "web", Environment: "prod", ClusterName: "web-eks", Status: "ACTIVE"}
	g := &api.ClusterGitops{StatusAvailable: true, Total: 1, Synced: 1, Healthy: 1}

	for _, outFormat := range []string{"table", "json", "csv"} {
		var buf bytes.Buffer
		if err := renderCluster(&buf, outFormat, c, g); err != nil {
			t.Fatalf("renderCluster(%s) error: %v", outFormat, err)
		}
		if buf.Len() == 0 {
			t.Errorf("renderCluster(%s) wrote nothing", outFormat)
		}
	}

	// The card is titled with the shared label, so the header and a picker option agree.
	// RenderCard upper-cases and letter-spaces its title, so the comparison drops the spacing
	// rather than pinning a presentation the card owns.
	var card bytes.Buffer
	if err := renderCluster(&card, "table", c, g); err != nil {
		t.Fatalf("renderCluster(table): %v", err)
	}
	squashed := strings.ReplaceAll(card.String(), " ", "")
	if !strings.Contains(squashed, "WEB(PROD)") {
		t.Errorf("card title should be the shared cluster label, got %q", card.String())
	}

	// Without gitops the plain cluster is still rendered.
	var buf bytes.Buffer
	if err := renderCluster(&buf, "json", c, nil); err != nil {
		t.Fatalf("renderCluster(json, no gitops) error: %v", err)
	}
	if !strings.Contains(buf.String(), "web-eks") {
		t.Errorf("json output should contain the cluster name, got %q", buf.String())
	}
}

// ── End to end, through the real cobra tree ────────────────────────────────────────────────────
//
// The tests above drive the resolver directly. These drive `alethia cluster get` itself against a
// fake control plane, because the thing being asserted is the EXIT CODE, and an exit code is a
// property of the command, not of the function it calls. `miscEnv` / `miscTrapExit` / `miscTTY`
// are the package's harness for exactly this (cov_misc_test.go).

// clustersCLI is miscEnv plus the flag reset it does not do.
//
// rootCmd is a package global and cobra never clears a flag between Execute calls, so a
// `--no-input` this file passes stays Changed for every LATER test in the package. Measured, not
// assumed: without this, three TestConn_* cases in cov_connectors_test.go took the
// "prompting is disabled" fatal arm, because Go orders a package's test files alphabetically and
// clusters_get_test.go runs before cov_connectors_test.go. hygCliConfirmResetFlags is the
// package's existing undo for exactly this.
func clustersCLI(t *testing.T, mode miscMode) func(args ...string) error {
	t.Helper()
	run := miscEnv(t, mode)
	t.Cleanup(hygCliConfirmResetFlags)
	return func(args ...string) error {
		defer hygCliConfirmResetFlags()
		return run(args...)
	}
}

// TestClusterGetE2E_MissIsFatal pins the defect this group closed: a selector that names no
// cluster used to print a muted line and exit 0, so `alethia cluster get typo || echo missing`
// never printed "missing" and a script could not tell a typo from a healthy cluster.
func TestClusterGetE2E_MissIsFatal(t *testing.T) {
	run := miscTrapExit(t, clustersCLI(t, miscFull))
	if !run("cluster", "get", "no-such-project", "--output", "table", "--no-input") {
		t.Error("a selector that matches nothing must exit non-zero")
	}
}

// TestClusterGetE2E_NoClustersIsFatal pins the other miss: the org has nothing to show. Same
// verdict, different sentence — and it must not be an empty card.
func TestClusterGetE2E_NoClustersIsFatal(t *testing.T) {
	run := miscTrapExit(t, clustersCLI(t, miscEmpty))
	if !run("cluster", "get", "web", "--output", "table", "--no-input") {
		t.Error("an org with no clusters must exit non-zero from `cluster get`")
	}
}

// TestClusterGetE2E_NoSelectorWithNoInputIsFatal pins the --no-input half of the field spec: with
// prompting refused and nothing passed, the command fails and says what to pass. It must never
// block on a form that can never be answered, and never pick a cluster for the caller.
func TestClusterGetE2E_NoSelectorWithNoInputIsFatal(t *testing.T) {
	run := miscTrapExit(t, clustersCLI(t, miscFull))
	if !run("cluster", "get", "--output", "table", "--no-input") {
		t.Error("no selector with --no-input must exit non-zero")
	}
}

// TestClusterGetE2E_ServerErrorIsFatal pins that a refused control plane is fatal rather than a
// half-rendered card. `cluster get` left miscReadCommands, so this arm is asserted here.
func TestClusterGetE2E_ServerErrorIsFatal(t *testing.T) {
	run := miscTrapExit(t, clustersCLI(t, miscFail))
	if !run("cluster", "get", "web", "--output", "json", "--no-input") {
		t.Error("a 500 from the control plane must exit non-zero")
	}
}

// TestClusterGetE2E_MatchRenders pins the success arm in both the static and the interactive
// input modes, and that the rendered cost is the console's rendering of the same number.
func TestClusterGetE2E_MatchRenders(t *testing.T) {
	run := clustersCLI(t, miscFull)
	for _, mode := range []string{"--no-input", "--no-input=false"} {
		t.Run(mode, func(t *testing.T) {
			if mode == "--no-input=false" {
				miscTTY(t)
			}
			if err := run("cluster", "get", "web", "--output", "table", mode); err != nil {
				t.Fatalf("cluster get web: %v", err)
			}
		})
	}

	// The selector also resolves by cluster name and by id, which is what makes a docs page able
	// to say "the name you saw in the list" without qualifying which name.
	for _, selector := range []string{"prod-eks", "c1"} {
		if err := run("cluster", "get", selector, "--output", "json", "--no-input"); err != nil {
			t.Fatalf("cluster get %s: %v", selector, err)
		}
	}
}

// TestClusterGetE2E_AcceptsZeroOrOneArgument pins the argument arity the docs and the form both
// depend on: zero args is legal (it asks), one is legal, two is a usage error rather than a
// silently ignored word.
func TestClusterGetE2E_AcceptsZeroOrOneArgument(t *testing.T) {
	for _, c := range []struct {
		args    []string
		wantErr bool
	}{
		{[]string{}, false},
		{[]string{"web"}, false},
		{[]string{"web", "extra"}, true},
	} {
		err := clusterGetCmd.ValidateArgs(c.args)
		if (err != nil) != c.wantErr {
			t.Errorf("ValidateArgs(%v) = %v, wantErr = %v", c.args, err, c.wantErr)
		}
	}
	if err := clusterListCmd.ValidateArgs([]string{"web"}); err == nil {
		t.Error("`cluster list` takes no arguments — a stray word must be a usage error")
	}
}
