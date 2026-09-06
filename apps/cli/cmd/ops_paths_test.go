// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// The failure branches of the break-glass resolvers.
//
// A diagnostic's FAILURE branch is its main branch: the operator who reaches one of these is
// already having a bad day, and the message is the whole product at that moment. Every branch below
// is one an incident reaches — an expired credential, a listing that 500s, an organization with no
// runners, a prompt abandoned with ctrl-c — and none of them is exercised by the happy-path suites.
//
// Everything here calls the resolvers DIRECTLY rather than through cobra, because the interesting
// input is a client that fails and a form that is abandoned, and neither is expressible as an
// argument list.

// opsPathsTrapExit replaces exitFunc with one that RECORDS rather than panics, so the statements
// after a fail() run exactly as they do in a test binary — and returns a pointer to the code.
//
// Recording rather than panicking is deliberate: fail() is followed by an explicit `return` at
// every call site, and a panic would jump over it. Those returns are unreachable in production —
// os.Exit does not come back — and they are what stops a resolver from carrying on with an empty
// value if exitFunc is ever anything else.
func opsPathsTrapExit(t *testing.T) *int {
	t.Helper()
	code := -1
	prev := exitFunc
	exitFunc = func(c int) { code = c }
	t.Cleanup(func() { exitFunc = prev })
	return &code
}

// opsPathsNoInput pins noInputMode for a direct (non-cobra) call and restores it.
func opsPathsNoInput(t *testing.T, v bool) {
	t.Helper()
	prev := noInputMode
	noInputMode = v
	t.Cleanup(func() { noInputMode = prev })
}

// opsPathsFormFails makes every form return err, which is what huh reports when a prompt is
// abandoned or when there is no TTY to open.
func opsPathsFormFails(t *testing.T, err error) {
	t.Helper()
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return err }
	t.Cleanup(func() { runHuhForm = prev })
}

// opsPathsFormAccepts makes every form return nil, leaving the bound values at their seeds — which
// for a Select is index 0 and for an Input is whatever the caller pre-filled.
func opsPathsFormAccepts(t *testing.T) {
	t.Helper()
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return nil }
	t.Cleanup(func() { runHuhForm = prev })
}

// opsPathsCmd resolves one ops command out of the live tree, with its inherited flags merged in.
//
// The merge is not a formality. cobra's Flags() carries a command's OWN flags; the root's
// persistent --output reaches it only once the flag sets have been merged, which Execute does and a
// direct Find does not. Without it every direct call here reads --output as "" and dies inside
// outputFormat — which is a fatal path, so a test asserting "this took the fatal path" would pass
// for entirely the wrong reason. It did, once, before this line existed.
func opsPathsCmd(t *testing.T, path string) *cobra.Command {
	t.Helper()
	cmd, _, err := rootCmd.Find(opsCommandPath(path))
	if err != nil || cmd.CommandPath() != path {
		t.Fatalf("find %s: %v", path, err)
	}
	if err := cmd.ParseFlags(nil); err != nil {
		t.Fatalf("merge inherited flags for %s: %v", path, err)
	}
	if f := cmd.Flags().Lookup("output"); f == nil {
		t.Fatalf("%s cannot see the root's --output; every render below would die inside outputFormat", path)
	}
	// The cobra tree is a package global and nothing clears it between suites: `TestMisc_OpsVerbs`
	// leaves `--project p1` on `orphan-detect`, and a resolver test that expected the picker then
	// got p1 instead. Cleared here rather than in each test, and restored afterwards, so this
	// file's subject is the resolver rather than whatever ran before it.
	opsPathsClearFlags(t, cmd)
	return cmd
}

// opsPathsClearFlags returns a command's flags to their defaults, and puts them back afterwards.
func opsPathsClearFlags(t *testing.T, cmd *cobra.Command) {
	t.Helper()
	reset := func() {
		cmd.Flags().VisitAll(func(f *pflag.Flag) {
			if !f.Changed {
				return
			}
			_ = f.Value.Set(f.DefValue)
			f.Changed = false
		})
	}
	reset()
	t.Cleanup(reset)
}

// ── the fakes ───────────────────────────────────────────────────────────────────────────────────

var errOpsPathsBoom = errors.New("control plane exploded")

type opsPathsJobs struct {
	page *api.JobsPage
	err  error
}

func (f opsPathsJobs) GetJobs(string, int, int) (*api.JobsPage, error) { return f.page, f.err }

type opsPathsRunners struct {
	runners []api.Runner
	err     error
}

func (f opsPathsRunners) GetRunners() ([]api.Runner, error) { return f.runners, f.err }

type opsPathsProjects struct {
	configs []types.ConfigurationSummary
	err     error
}

func (f opsPathsProjects) GetConfigurations() ([]types.ConfigurationSummary, error) {
	return f.configs, f.err
}

type opsPathsEnvs struct {
	envs []api.Environment
	err  error
}

func (f opsPathsEnvs) ListEnvironments(string) ([]api.Environment, error) { return f.envs, f.err }

// ── the reason ──────────────────────────────────────────────────────────────────────────────────

// TestOpsPaths_ReasonLengthBounds pins both ends of the bound the server enforces, and the two
// values either side of each — so a `<` that became a `<=` fails here.
func TestOpsPaths_ReasonLengthBounds(t *testing.T) {
	cases := []struct {
		name    string
		reason  string
		wantErr bool
	}{
		{"empty", "", true},
		{"seven", strings.Repeat("a", 7), true},
		{"eight", strings.Repeat("a", 8), false},
		{"padded seven", "  " + strings.Repeat("a", 7) + "  ", true},
		{"thousand", strings.Repeat("a", 1000), false},
		{"thousand and one", strings.Repeat("a", 1001), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := opsValidateReason(tc.reason)
			if (err != nil) != tc.wantErr {
				t.Errorf("opsValidateReason(%d chars) = %v, wantErr %v", len(tc.reason), err, tc.wantErr)
			}
		})
	}
}

// TestOpsPaths_AskAppliesTheDefaultValidator drives the closure opsAsk installs when a caller
// passes none: an empty answer is refused, a real one is accepted and trimmed.
func TestOpsPaths_AskAppliesTheDefaultValidator(t *testing.T) {
	f := mustOpsField("alethia ops force-release-lock", opsKeyStateKey)

	// Empty: the real form is driven, so the real Validate runs and the form does not complete.
	scripts := authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})
	if _, err := opsAsk(f, "", nil); err != nil {
		t.Fatalf("opsAsk: %v", err)
	}
	if scripts[0].state == huh.StateCompleted {
		t.Error("an empty answer completed the form; the default validator did not refuse it")
	}

	// A real answer completes, and comes back trimmed.
	scripts = authFormAnswer(t, &authFormScript{keys: authFormKey(authFormType("  projects/acme/prod.tfstate  "), tea.KeyEnter)})
	got, err := opsAsk(f, "", nil)
	if err != nil {
		t.Fatalf("opsAsk: %v", err)
	}
	if got != "projects/acme/prod.tfstate" {
		t.Errorf("opsAsk = %q, want the answer trimmed", got)
	}
	if scripts[0].state != huh.StateCompleted {
		t.Error("a valid answer did not complete the form")
	}
}

// TestOpsPaths_AskReportsAnAbandonedForm pins the arm where the operator presses ctrl-c.
func TestOpsPaths_AskReportsAnAbandonedForm(t *testing.T) {
	opsPathsFormFails(t, errOpsPathsBoom)
	if _, err := opsAsk(mustOpsField("alethia ops session", opsKeyReason), "", nil); !errors.Is(err, errOpsPathsBoom) {
		t.Errorf("opsAsk error = %v, want the form's own error", err)
	}
}

// TestOpsPaths_RequireRejectsASuppliedValueTheServerWouldRefuse pins the arm where a flag WAS given
// and is invalid: the message must name the flag, because the reader typed it.
func TestOpsPaths_RequireRejectsASuppliedValueTheServerWouldRefuse(t *testing.T) {
	f := mustOpsField("alethia ops session", opsKeyReason)
	_, err := opsRequire(f, "short", opsValidateReason)
	if err == nil {
		t.Fatal("a reason the server refuses was accepted")
	}
	if !strings.Contains(err.Error(), "--reason") {
		t.Errorf("error %q does not name the flag the reader typed", err)
	}
}

// TestOpsPaths_ReasonAndApprovalTakeTheFatalPath covers the two thin wrappers' failure arms.
func TestOpsPaths_ReasonAndApprovalTakeTheFatalPath(t *testing.T) {
	opsPathsNoInput(t, true)

	code := opsPathsTrapExit(t)
	if got := opsReason(opsPathsCmd(t, "alethia ops session")); got != "" {
		t.Errorf("opsReason = %q, want an empty string after the fatal path", got)
	}
	if *code != 1 {
		t.Errorf("exit code = %d, want 1", *code)
	}

	code2 := opsPathsTrapExit(t)
	if got := opsApproval(opsPathsCmd(t, "alethia ops state-surgery")); got != "" {
		t.Errorf("opsApproval = %q, want an empty string after the fatal path", got)
	}
	if *code2 != 1 {
		t.Errorf("exit code = %d, want 1", *code2)
	}
}

// ── the pickers ─────────────────────────────────────────────────────────────────────────────────

// TestOpsPaths_PickersReportAFailedListing pins the arm where the control plane is the thing that
// is broken — which, during an incident, is the likely one.
func TestOpsPaths_PickersReportAFailedListing(t *testing.T) {
	if _, err := opsPickJobID(opsPathsJobs{err: errOpsPathsBoom}); err == nil ||
		!strings.Contains(err.Error(), "fetch jobs") {
		t.Errorf("opsPickJobID error = %v, want one naming the fetch", err)
	}
	if _, err := opsPickRunnerID(opsPathsRunners{err: errOpsPathsBoom}, "d"); err == nil ||
		!strings.Contains(err.Error(), "fetch runners") {
		t.Errorf("opsPickRunnerID error = %v, want one naming the fetch", err)
	}
	if _, err := opsPickProjectID(opsPathsProjects{err: errOpsPathsBoom}, "d"); err == nil ||
		!strings.Contains(err.Error(), "fetch projects") {
		t.Errorf("opsPickProjectID error = %v, want one naming the fetch", err)
	}
}

// TestOpsPaths_PickersOnAnEmptyListNameTheWayThrough is the branch that matters most for this
// group: break-glass reaches resources your own listings do not contain, so "there is nothing to
// pick" must point at the positional rather than reading as a dead end.
func TestOpsPaths_PickersOnAnEmptyListNameTheWayThrough(t *testing.T) {
	cases := map[string]func() (string, error){
		"jobs, nil page":   func() (string, error) { return opsPickJobID(opsPathsJobs{}) },
		"jobs, empty page": func() (string, error) { return opsPickJobID(opsPathsJobs{page: &api.JobsPage{}}) },
		"runners":          func() (string, error) { return opsPickRunnerID(opsPathsRunners{}, "d") },
		"projects":         func() (string, error) { return opsPickProjectID(opsPathsProjects{}, "d") },
	}
	for name, call := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := call()
			if err == nil {
				t.Fatal("an empty listing produced no error")
			}
			if !strings.Contains(err.Error(), "instead") {
				t.Errorf("error %q does not tell the operator what to pass instead", err)
			}
		})
	}
}

// TestOpsPaths_PickersReportAnAbandonedPrompt covers the select's own error arm for each picker.
func TestOpsPaths_PickersReportAnAbandonedPrompt(t *testing.T) {
	opsPathsFormFails(t, errOpsPathsBoom)
	jobs := opsPathsJobs{page: &api.JobsPage{Jobs: []api.ProvisionJob{{ID: "j1", JobType: "PLAN", Status: "FAILED"}}}}
	runners := opsPathsRunners{runners: []api.Runner{{ID: "r1", Name: "eu-1", Status: "ONLINE", IsDefault: true}}}
	projects := opsPathsProjects{configs: []types.ConfigurationSummary{{ID: "p1", ProjectName: "web"}}}

	if _, err := opsPickJobID(jobs); !errors.Is(err, errOpsPathsBoom) {
		t.Errorf("opsPickJobID error = %v, want the form's own", err)
	}
	if _, err := opsPickRunnerID(runners, "d"); !errors.Is(err, errOpsPathsBoom) {
		t.Errorf("opsPickRunnerID error = %v, want the form's own", err)
	}
	if _, err := opsPickProjectID(projects, "d"); !errors.Is(err, errOpsPathsBoom) {
		t.Errorf("opsPickProjectID error = %v, want the form's own", err)
	}
	if _, _, err := opsPickEnvironmentID(projects, opsPathsEnvs{}); !errors.Is(err, errOpsPathsBoom) {
		t.Errorf("opsPickEnvironmentID error = %v, want the form's own", err)
	}
}

// TestOpsPaths_RunnerPickerOffersEveryRunner pins the choice that separates this picker from the
// job-dispatch one: an OFFLINE runner is a candidate here, because a drain is aimed at the runner
// that is wrong.
func TestOpsPaths_RunnerPickerOffersEveryRunner(t *testing.T) {
	opsPathsFormAccepts(t)
	runners := opsPathsRunners{runners: []api.Runner{
		{ID: "r-offline", Name: "eu-2", Status: "OFFLINE", Operator: "self", Provisioning: "deployed"},
		{ID: "r-online", Name: "eu-1", Status: "ONLINE", Operator: "managed", IsDefault: true},
	}}
	got, err := opsPickRunnerID(runners, "d")
	if err != nil {
		t.Fatalf("opsPickRunnerID: %v", err)
	}
	// Index 0 is the seed, and index 0 is the offline runner: a filtered picker could not return it.
	if got != "r-offline" {
		t.Errorf("opsPickRunnerID = %q, want r-offline — the offline runner must be offerable", got)
	}
}

// TestOpsPaths_EnvironmentPickerReportsEachStage covers the environment picker's own arms: the
// project listing failing, the environment listing failing, and a project with no environments.
func TestOpsPaths_EnvironmentPickerReportsEachStage(t *testing.T) {
	projects := opsPathsProjects{configs: []types.ConfigurationSummary{{ID: "p1", ProjectName: "web"}}}

	t.Run("project listing fails", func(t *testing.T) {
		opsPathsFormAccepts(t)
		if _, _, err := opsPickEnvironmentID(opsPathsProjects{err: errOpsPathsBoom}, opsPathsEnvs{}); err == nil ||
			!strings.Contains(err.Error(), "fetch projects") {
			t.Errorf("error = %v, want one naming the project fetch", err)
		}
	})
	t.Run("environment listing fails", func(t *testing.T) {
		opsPathsFormAccepts(t)
		if _, _, err := opsPickEnvironmentID(projects, opsPathsEnvs{err: errOpsPathsBoom}); err == nil ||
			!strings.Contains(err.Error(), "fetch environments") {
			t.Errorf("error = %v, want one naming the environment fetch", err)
		}
	})
	t.Run("no environments", func(t *testing.T) {
		opsPathsFormAccepts(t)
		_, _, err := opsPickEnvironmentID(projects, opsPathsEnvs{})
		if err == nil || !strings.Contains(err.Error(), "instead") {
			t.Errorf("error = %v, want one naming the positional", err)
		}
	})
	t.Run("resolves the id and the live status", func(t *testing.T) {
		opsPathsFormAccepts(t)
		id, status, err := opsPickEnvironmentID(projects, opsPathsEnvs{envs: []api.Environment{
			{ID: "e1", Name: "prod", Status: "PROVISIONING"},
			{ID: "e2", Name: "staging", Status: "ACTIVE"},
		}})
		if err != nil {
			t.Fatalf("opsPickEnvironmentID: %v", err)
		}
		if id != "e1" || status != "PROVISIONING" {
			t.Errorf("got (%q, %q), want (e1, PROVISIONING)", id, status)
		}
	})
	t.Run("an environment with no status still renders", func(t *testing.T) {
		opsPathsFormAccepts(t)
		id, status, err := opsPickEnvironmentID(projects, opsPathsEnvs{envs: []api.Environment{{ID: "e3", Name: "dev"}}})
		if err != nil {
			t.Fatalf("opsPickEnvironmentID: %v", err)
		}
		if id != "e3" || status != "" {
			t.Errorf("got (%q, %q), want (e3, \"\")", id, status)
		}
	})
}

// ── the statuses ────────────────────────────────────────────────────────────────────────────────

// TestOpsPaths_SplitStatuses pins the parsing of the comma-separated form.
func TestOpsPaths_SplitStatuses(t *testing.T) {
	cases := map[string][]string{
		"":                          nil,
		" , ,":                      nil,
		"active":                    {"ACTIVE"},
		" provisioning , queued , ": {"PROVISIONING", "QUEUED"},
	}
	for in, want := range cases {
		got := opsSplitStatuses(in)
		if strings.Join(got, "|") != strings.Join(want, "|") {
			t.Errorf("opsSplitStatuses(%q) = %v, want %v", in, got, want)
		}
	}
}

// TestOpsPaths_AskStatusesRefusesAnEmptySelection drives the multi-select's own Validate, which is
// the arm that stops a compare-and-swap from being submitted with no precondition at all.
func TestOpsPaths_AskStatusesRefusesAnEmptySelection(t *testing.T) {
	f := mustOpsField("alethia ops unstick-env", opsKeyFrom)

	scripts := authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})
	if _, err := opsAskStatuses(f, ""); err != nil {
		t.Fatalf("opsAskStatuses: %v", err)
	}
	if scripts[0].state == huh.StateCompleted {
		t.Error("a multi-select with nothing chosen completed; the CAS would have no precondition")
	}

	// Pre-seeded from the live status, the same keystroke completes.
	scripts = authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})
	got, err := opsAskStatuses(f, "provisioning")
	if err != nil {
		t.Fatalf("opsAskStatuses: %v", err)
	}
	if len(got) != 1 || got[0] != "PROVISIONING" {
		t.Errorf("opsAskStatuses = %v, want [PROVISIONING] seeded from the live status", got)
	}
	if scripts[0].state != huh.StateCompleted {
		t.Error("a seeded multi-select did not complete")
	}
}

// TestOpsPaths_AskStatusesIgnoresAStatusOutsideTheEnum pins the seed's own bound: a status the
// enum does not carry cannot be pre-selected, because huh can only write back a value it was given.
func TestOpsPaths_AskStatusesIgnoresAStatusOutsideTheEnum(t *testing.T) {
	opsPathsFormAccepts(t)
	got, err := opsAskStatuses(mustOpsField("alethia ops unstick-env", opsKeyFrom), "DEPLOYING")
	if err != nil {
		t.Fatalf("opsAskStatuses: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("opsAskStatuses seeded %v from a status outside project_status", got)
	}
}

// TestOpsPaths_AskStatusReportsAnAbandonedPrompt covers the single-select's error arm.
func TestOpsPaths_AskStatusReportsAnAbandonedPrompt(t *testing.T) {
	opsPathsFormFails(t, errOpsPathsBoom)
	if _, err := opsAskStatus(mustOpsField("alethia ops unstick-env", opsKeyTo)); !errors.Is(err, errOpsPathsBoom) {
		t.Errorf("opsAskStatus error = %v, want the form's own", err)
	}
	if _, err := opsAskStatuses(mustOpsField("alethia ops unstick-env", opsKeyFrom), ""); !errors.Is(err, errOpsPathsBoom) {
		t.Errorf("opsAskStatuses error = %v, want the form's own", err)
	}
}

// TestOpsPaths_AskStatusReturnsTheEnumsFirstValue pins the accepted arm.
func TestOpsPaths_AskStatusReturnsTheEnumsFirstValue(t *testing.T) {
	opsPathsFormAccepts(t)
	got, err := opsAskStatus(mustOpsField("alethia ops unstick-env", opsKeyTo))
	if err != nil {
		t.Fatalf("opsAskStatus: %v", err)
	}
	if want := opsStatusValues()[0]; got != want {
		t.Errorf("opsAskStatus = %q, want %q", got, want)
	}
}

// ── the resolvers' fatal arms ───────────────────────────────────────────────────────────────────

// TestOpsPaths_ResolversDieWhenThereIsNoCredential covers the opsClient() arm of every picker-backed
// resolver: an expired or absent credential is what an on-call operator meets first.
func TestOpsPaths_ResolversDieWhenThereIsNoCredential(t *testing.T) {
	cases := map[string]func(t *testing.T){
		"job": func(t *testing.T) {
			if got := opsResolveJobID(opsPathsCmd(t, "alethia ops inspect-job"), nil); got != "" {
				t.Errorf("resolved %q with no credential", got)
			}
		},
		"runner": func(t *testing.T) {
			if got := opsResolveRunnerID(opsPathsCmd(t, "alethia ops drain-runner"), nil); got != "" {
				t.Errorf("resolved %q with no credential", got)
			}
		},
		"project": func(t *testing.T) {
			if got := opsResolveProjectID(opsPathsCmd(t, "alethia ops orphan-detect")); got != "" {
				t.Errorf("resolved %q with no credential", got)
			}
		},
		"environment": func(t *testing.T) {
			if id, status := opsResolveEnvironment(opsPathsCmd(t, "alethia ops unstick-env"), nil); id != "" || status != "" {
				t.Errorf("resolved (%q, %q) with no credential", id, status)
			}
		},
	}
	for name, call := range cases {
		t.Run(name, func(t *testing.T) {
			isolatedHome(t) // a config dir with no credentials in it
			opsPathsNoInput(t, false)
			prevOut := stdoutIsTTY
			stdoutIsTTY = func() bool { return true }
			t.Cleanup(func() { stdoutIsTTY = prevOut })
			// The credential is read before any form opens, so no form may be opened at all.
			authFormNoForm(t)
			code := opsPathsTrapExit(t)

			call(t)

			if *code != 1 {
				t.Errorf("exit code = %d, want 1", *code)
			}
		})
	}
}

// TestOpsPaths_ResolversDieWhenNothingCanBePrompted covers the scripted arm of every resolver, and
// asserts the message names the flag or positional that would have answered.
func TestOpsPaths_ResolversDieWhenNothingCanBePrompted(t *testing.T) {
	opsPathsNoInput(t, true)
	authFormNoForm(t)

	t.Run("project", func(t *testing.T) {
		code := opsPathsTrapExit(t)
		if got := opsResolveProjectID(opsPathsCmd(t, "alethia ops orphan-clean")); got != "" {
			t.Errorf("resolved %q with prompting disabled", got)
		}
		if *code != 1 {
			t.Errorf("exit code = %d, want 1", *code)
		}
	})
	t.Run("environment", func(t *testing.T) {
		code := opsPathsTrapExit(t)
		if id, status := opsResolveEnvironment(opsPathsCmd(t, "alethia ops unstick-env"), nil); id != "" || status != "" {
			t.Errorf("resolved (%q, %q) with prompting disabled", id, status)
		}
		if *code != 1 {
			t.Errorf("exit code = %d, want 1", *code)
		}
	})
	t.Run("positional", func(t *testing.T) {
		code := opsPathsTrapExit(t)
		if got := opsResolveArg(opsPathsCmd(t, "alethia ops force-release-lock"), opsKeyStateKey, nil, nil); got != "" {
			t.Errorf("resolved %q with prompting disabled", got)
		}
		if *code != 1 {
			t.Errorf("exit code = %d, want 1", *code)
		}
	})
	t.Run("expected-from", func(t *testing.T) {
		code := opsPathsTrapExit(t)
		if got := opsResolveExpectedFrom(opsPathsCmd(t, "alethia ops unstick-env"), ""); got != nil {
			t.Errorf("resolved %v with prompting disabled", got)
		}
		if *code != 1 {
			t.Errorf("exit code = %d, want 1", *code)
		}
	})
	t.Run("target status", func(t *testing.T) {
		code := opsPathsTrapExit(t)
		if got := opsResolveTargetStatus(opsPathsCmd(t, "alethia ops unstick-env")); got != "" {
			t.Errorf("resolved %q with prompting disabled", got)
		}
		if *code != 1 {
			t.Errorf("exit code = %d, want 1", *code)
		}
	})
}

// TestOpsPaths_ResolversReportAnAbandonedPrompt covers the arms where a form opens and is
// abandoned, which reach the resolvers' second fail() rather than their first.
func TestOpsPaths_ResolversReportAnAbandonedPrompt(t *testing.T) {
	opsPathsNoInput(t, false)
	prevOut := stdoutIsTTY
	stdoutIsTTY = func() bool { return true }
	t.Cleanup(func() { stdoutIsTTY = prevOut })
	opsPathsFormFails(t, errOpsPathsBoom)

	t.Run("positional", func(t *testing.T) {
		code := opsPathsTrapExit(t)
		if got := opsResolveArg(opsPathsCmd(t, "alethia ops replay-webhook"), opsKeyEvent, nil, nil); got != "" {
			t.Errorf("resolved %q from an abandoned prompt", got)
		}
		if *code != 1 {
			t.Errorf("exit code = %d, want 1", *code)
		}
	})
	t.Run("expected-from", func(t *testing.T) {
		code := opsPathsTrapExit(t)
		if got := opsResolveExpectedFrom(opsPathsCmd(t, "alethia ops unstick-env"), ""); got != nil {
			t.Errorf("resolved %v from an abandoned prompt", got)
		}
		if *code != 1 {
			t.Errorf("exit code = %d, want 1", *code)
		}
	})
	t.Run("target status", func(t *testing.T) {
		code := opsPathsTrapExit(t)
		if got := opsResolveTargetStatus(opsPathsCmd(t, "alethia ops unstick-env")); got != "" {
			t.Errorf("resolved %q from an abandoned prompt", got)
		}
		if *code != 1 {
			t.Errorf("exit code = %d, want 1", *code)
		}
	})
	t.Run("note", func(t *testing.T) {
		code := opsPathsTrapExit(t)
		if got := opsResolveNote(opsPathsCmd(t, "alethia ops state-surgery")); got != "" {
			t.Errorf("resolved %q from an abandoned prompt", got)
		}
		if *code != 1 {
			t.Errorf("exit code = %d, want 1", *code)
		}
	})
	t.Run("approval action", func(t *testing.T) {
		code := opsPathsTrapExit(t)
		if got := opsResolveApprovalAction(opsPathsCmd(t, "alethia ops approve"), nil); got != "" {
			t.Errorf("resolved %q from an abandoned prompt", got)
		}
		if *code != 1 {
			t.Errorf("exit code = %d, want 1", *code)
		}
	})
}

// TestOpsPaths_ExpectedFromRejectsAnEmptyFlag pins the one arm the enum check cannot reach: a
// --from that was given and holds only separators.
func TestOpsPaths_ExpectedFromRejectsAnEmptyFlag(t *testing.T) {
	cmd := opsPathsCmd(t, "alethia ops unstick-env")
	f := cmd.Flags().Lookup("from")
	if err := f.Value.Set(" , , "); err != nil {
		t.Fatalf("set --from: %v", err)
	}
	f.Changed = true
	t.Cleanup(func() { _ = f.Value.Set(""); f.Changed = false })

	code := opsPathsTrapExit(t)
	if got := opsResolveExpectedFrom(cmd, ""); got != nil {
		t.Errorf("resolved %v from a --from holding only separators", got)
	}
	if *code != 1 {
		t.Errorf("exit code = %d, want 1", *code)
	}
}

// TestOpsPaths_NoteIsOptionalEverywhere pins the one field that may be empty. It must not refuse a
// scripted run, and it must not open a prompt when it was supplied.
func TestOpsPaths_NoteIsOptionalEverywhere(t *testing.T) {
	cmd := opsPathsCmd(t, "alethia ops state-surgery")

	t.Run("scripted and absent", func(t *testing.T) {
		opsPathsNoInput(t, true)
		authFormNoForm(t)
		code := opsPathsTrapExit(t)
		if got := opsResolveNote(cmd); got != "" {
			t.Errorf("opsResolveNote = %q, want an empty string", got)
		}
		if *code != -1 {
			t.Errorf("an absent optional note took the fatal path (exit %d)", *code)
		}
	})

	t.Run("supplied", func(t *testing.T) {
		f := cmd.Flags().Lookup("note")
		if err := f.Value.Set("  import the orphaned RDS instance  "); err != nil {
			t.Fatalf("set --note: %v", err)
		}
		f.Changed = true
		t.Cleanup(func() { _ = f.Value.Set(""); f.Changed = false })
		authFormNoForm(t)
		if got := opsResolveNote(cmd); got != "import the orphaned RDS instance" {
			t.Errorf("opsResolveNote = %q, want the supplied value trimmed", got)
		}
	})
}

// ── the result rendering ────────────────────────────────────────────────────────────────────────

// TestOpsPaths_DataRows covers every shape a break-glass payload can arrive in. The action decides
// the shape, not this CLI, so "something I cannot flatten" is a case rather than an impossibility.
func TestOpsPaths_DataRows(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want [][]string
	}{
		{"absent", "", nil},
		{"null", "null", nil},
		{"object, keys sorted", `{"rows":2,"key":"projects/acme"}`, [][]string{{"key", "projects/acme"}, {"rows", "2"}}},
		{"empty string renders as a dash", `{"note":""}`, [][]string{{"note", ui.SymbolDash}}},
		{"nested value stays JSON", `{"orphans":[{"id":"i-1"}]}`, [][]string{{"orphans", `[{"id":"i-1"}]`}}},
		{"a bare list is one row", `[1,2]`, [][]string{{"data", "[1,2]"}}},
		{"unparseable is still shown", `not json`, [][]string{{"data", "not json"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := opsDataRows(json.RawMessage(tc.raw))
			if len(got) != len(tc.want) {
				t.Fatalf("opsDataRows(%q) = %v, want %v", tc.raw, got, tc.want)
			}
			for i := range got {
				if got[i][0] != tc.want[i][0] || got[i][1] != tc.want[i][1] {
					t.Errorf("row %d = %v, want %v", i, got[i], tc.want[i])
				}
			}
		})
	}
}

// TestOpsPaths_RenderTakesTheFatalPathOnAFailedWrite covers the arm where stdout has gone away —
// a closed pipe, which is what a `| head` leaves behind.
func TestOpsPaths_RenderTakesTheFatalPathOnAFailedWrite(t *testing.T) {
	cmd := opsPathsCmd(t, "alethia ops inspect-job")
	_, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	_ = w.Close()
	prev := os.Stdout
	os.Stdout = w
	t.Cleanup(func() { os.Stdout = prev })

	code := opsPathsTrapExit(t)
	renderOpsResult(cmd, &api.BreakglassResult{OK: true, Detail: "done", Data: json.RawMessage(`{"rows":1}`)})
	if *code != 1 {
		t.Errorf("a failed write to stdout did not take the fatal path (exit %d)", *code)
	}

	// The control: the SAME call against a stdout that works must not exit. Without it this test
	// passes for any reason renderOpsResult exits — including one that has nothing to do with the
	// write, which is exactly what happened while opsPathsCmd was not merging the root's --output.
	os.Stdout = prev
	working := opsPathsTrapExit(t)
	_, _ = opsFormCaptureStdout(t, func() int {
		renderOpsResult(cmd, &api.BreakglassResult{OK: true, Detail: "done", Data: json.RawMessage(`{"rows":1}`)})
		return 0
	})
	if *working != -1 {
		t.Errorf("rendering to a working stdout exited %d — the assertion above was not about the write", *working)
	}
}

// TestOpsPaths_RenderSkipsTheCardWhenThereIsNothingToShow pins the early return: a result with no
// payload prints its detail line and stops, instead of an empty bordered box.
func TestOpsPaths_RenderSkipsTheCardWhenThereIsNothingToShow(t *testing.T) {
	cmd := opsPathsCmd(t, "alethia ops inspect-job")
	out, _ := opsFormCaptureStdout(t, func() int {
		renderOpsResult(cmd, &api.BreakglassResult{OK: true, Detail: "nothing to report"})
		return 0
	})
	if strings.Contains(out, "╭") {
		t.Errorf("an empty payload still drew a card:\n%s", out)
	}
	if !strings.Contains(out, "nothing to report") {
		t.Errorf("the detail line was dropped:\n%s", out)
	}
}

// ── the small helpers ───────────────────────────────────────────────────────────────────────────

// TestOpsPaths_YesForAnUnregisteredCommandIsFalse pins the safe default: no opt-in recorded means
// nobody opted in, so an interactive run asks and a scripted one is refused.
func TestOpsPaths_YesForAnUnregisteredCommandIsFalse(t *testing.T) {
	if opsYesFor("alethia ops session") {
		t.Error("a verb with no --yes flag reported an opt-in")
	}
	if opsYesFor("alethia ops not-a-verb") {
		t.Error("an unknown path reported an opt-in")
	}
}

// TestOpsPaths_ConfirmIsATrueNoOpForAReadOnlyVerb pins the arm that keeps diagnosis one command.
func TestOpsPaths_ConfirmIsATrueNoOpForAReadOnlyVerb(t *testing.T) {
	prev := confirm
	confirm = func(string, string) bool {
		t.Error("a read-only verb asked for a confirmation")
		return false
	}
	t.Cleanup(func() { confirm = prev })

	if !opsConfirm("alethia ops inspect-job", "job j1", "reads a row") {
		t.Error("a read-only verb was refused")
	}
	if !opsConfirm("alethia ops session", "", "") {
		t.Error("a command with no catalog entry was refused")
	}
}

// TestOpsPaths_GroupCommandsWalkIsBounded pins the walk's own edges: an unknown root yields
// nothing, and neither cobra's generated `help` nor a hidden command joins the group.
func TestOpsPaths_GroupCommandsWalkIsBounded(t *testing.T) {
	if got := opsGroupCommands(&cobra.Command{Use: "empty"}); got != nil {
		t.Errorf("a tree with no `ops` yielded %d commands", len(got))
	}
	for _, c := range opsGroupCommands(rootCmd) {
		if c.Hidden || c.Name() == "help" || c.Name() == "completion" {
			t.Errorf("%s should not be in the group", c.CommandPath())
		}
	}
	if len(opsGroupCommands(rootCmd)) != len(opsFormLeafTakesInput) {
		t.Errorf("the walk found %d commands and the classification names %d",
			len(opsGroupCommands(rootCmd)), len(opsFormLeafTakesInput))
	}
}

// ── the arms that need a control plane ──────────────────────────────────────────────────────────

// opsPathsFormFailsAfter makes the first n forms succeed (leaving their seeds) and every later one
// fail. It is how a two-step picker's SECOND step is reached with the first one answered.
func opsPathsFormFailsAfter(t *testing.T, n int, err error) {
	t.Helper()
	prev := runHuhForm
	seen := 0
	runHuhForm = func(...*huh.Group) error {
		seen++
		if seen <= n {
			return nil
		}
		return err
	}
	t.Cleanup(func() { runHuhForm = prev })
}

// opsPathsRefusingServer points the CLI at a control plane that refuses everything, with a valid
// stored credential — so the failure under test is the CALL, not the login.
func opsPathsRefusingServer(t *testing.T) {
	t.Helper()
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"break-glass is not armed on this deployment"}`))
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
}

// TestOpsPaths_EnvironmentPickerReportsAnAbandonedSecondStep reaches opsPickEnvironmentID's own
// select, which the all-forms-fail stub cannot: the project step fails first and returns early.
func TestOpsPaths_EnvironmentPickerReportsAnAbandonedSecondStep(t *testing.T) {
	opsPathsFormFailsAfter(t, 1, errOpsPathsBoom)
	projects := opsPathsProjects{configs: []types.ConfigurationSummary{{ID: "p1", ProjectName: "web"}}}
	envs := opsPathsEnvs{envs: []api.Environment{{ID: "e1", Name: "prod", Status: "ACTIVE"}}}

	if _, _, err := opsPickEnvironmentID(projects, envs); !errors.Is(err, errOpsPathsBoom) {
		t.Errorf("opsPickEnvironmentID error = %v, want the environment select's own", err)
	}
}

// TestOpsPaths_ProjectAndEnvironmentResolversReportAnAbandonedPicker covers the two resolvers whose
// picker sits behind a credential read, on both arms: abandoned, and answered.
func TestOpsPaths_ProjectAndEnvironmentResolversReportAnAbandonedPicker(t *testing.T) {
	t.Run("project abandoned", func(t *testing.T) {
		_, _, _ = opsFormEnv(t)
		opsFormInteractive(t)
		// noInputMode is resolved by cobra at Execute; these call the resolver directly, so it is
		// whatever the previous suite left behind. Two of these three arms passed for exactly that
		// reason — they exited 1 on "prompting is disabled" while claiming to prove the picker's
		// own failure — before this line existed.
		opsPathsNoInput(t, false)
		opsPathsFormFails(t, errOpsPathsBoom)
		code := opsPathsTrapExit(t)
		if got := opsResolveProjectID(opsPathsCmd(t, "alethia ops orphan-detect")); got != "" {
			t.Errorf("resolved %q from an abandoned picker", got)
		}
		if *code != 1 {
			t.Errorf("exit code = %d, want 1", *code)
		}
	})
	t.Run("project answered", func(t *testing.T) {
		_, _, _ = opsFormEnv(t)
		opsFormInteractive(t)
		// noInputMode is resolved by cobra at Execute; these call the resolver directly, so it is
		// whatever the previous suite left behind. Two of these three arms passed for exactly that
		// reason — they exited 1 on "prompting is disabled" while claiming to prove the picker's
		// own failure — before this line existed.
		opsPathsNoInput(t, false)
		opsPathsFormAccepts(t)
		code := opsPathsTrapExit(t)
		if got := opsResolveProjectID(opsPathsCmd(t, "alethia ops orphan-detect")); got != "project-alpha" {
			t.Errorf("opsResolveProjectID = %q, want project-alpha", got)
		}
		if *code != -1 {
			t.Errorf("an answered picker took the fatal path (exit %d)", *code)
		}
	})
	t.Run("environment abandoned", func(t *testing.T) {
		_, _, _ = opsFormEnv(t)
		opsFormInteractive(t)
		// noInputMode is resolved by cobra at Execute; these call the resolver directly, so it is
		// whatever the previous suite left behind. Two of these three arms passed for exactly that
		// reason — they exited 1 on "prompting is disabled" while claiming to prove the picker's
		// own failure — before this line existed.
		opsPathsNoInput(t, false)
		opsPathsFormFails(t, errOpsPathsBoom)
		code := opsPathsTrapExit(t)
		if id, status := opsResolveEnvironment(opsPathsCmd(t, "alethia ops unstick-env"), nil); id != "" || status != "" {
			t.Errorf("resolved (%q, %q) from an abandoned picker", id, status)
		}
		if *code != 1 {
			t.Errorf("exit code = %d, want 1", *code)
		}
	})
}

// TestOpsPaths_NoteIsAskedForAndAccepted drives the note prompt's own validator — the one that
// accepts an empty answer, because the note is the group's only optional field — and its success
// arm.
func TestOpsPaths_NoteIsAskedForAndAccepted(t *testing.T) {
	cmd := opsPathsCmd(t, "alethia ops state-surgery")
	opsPathsNoInput(t, false)
	prevOut := stdoutIsTTY
	stdoutIsTTY = func() bool { return true }
	t.Cleanup(func() { stdoutIsTTY = prevOut })

	scripts := authFormAnswer(t,
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(authFormType("import the orphaned RDS instance"), tea.KeyEnter)},
	)
	if got := opsResolveNote(cmd); got != "" {
		t.Errorf("opsResolveNote = %q, want an empty answer to be accepted", got)
	}
	if scripts[0].state != huh.StateCompleted {
		t.Error("an empty note did not complete the form; the note must stay optional")
	}
	if got := opsResolveNote(cmd); got != "import the orphaned RDS instance" {
		t.Errorf("opsResolveNote = %q, want the typed note", got)
	}
}

// TestOpsPaths_ApprovalActionRefusalReturnsEmpty covers the statement AFTER the failf, which the
// panicking exit trap in the cobra suites jumps straight over.
func TestOpsPaths_ApprovalActionRefusalReturnsEmpty(t *testing.T) {
	code := opsPathsTrapExit(t)
	if got := opsResolveApprovalAction(opsPathsCmd(t, "alethia ops approve"), []string{"cancel_job"}); got != "" {
		t.Errorf("opsResolveApprovalAction = %q for an action that takes no approval", got)
	}
	if *code != 1 {
		t.Errorf("exit code = %d, want 1", *code)
	}
}

// TestOpsPaths_VerbsDieWhenTheCredentialIsGone covers the getAuthToken arm of the three paths that
// read one directly: the shared executor, `approve`, and `session`.
//
// It is the first thing an on-call operator meets at 3am with a stale credential, and each of the
// three used to be a `fail(err); return` nobody had run.
func TestOpsPaths_VerbsDieWhenTheCredentialIsGone(t *testing.T) {
	cases := map[string]func(t *testing.T){
		"executor": func(t *testing.T) {
			runOpsAction(opsRequest{
				Cmd: opsPathsCmd(t, "alethia ops inspect-job"), ResourceID: "j1", Reason: "incident-4711",
			})
		},
		"approve": func(t *testing.T) {
			cmd := opsPathsCmd(t, "alethia ops approve")
			opsPathsSetFlag(t, cmd, "reason", "incident-4711")
			cmd.Run(cmd, []string{"state_surgery", "k1"})
		},
		"session": func(t *testing.T) {
			cmd := opsPathsCmd(t, "alethia ops session")
			opsPathsSetFlag(t, cmd, "reason", "incident-4711")
			cmd.Run(cmd, nil)
		},
	}
	for name, call := range cases {
		t.Run(name, func(t *testing.T) {
			isolatedHome(t) // a config dir with no credentials in it
			opsPathsNoInput(t, true)
			code := opsPathsTrapExit(t)
			call(t)
			if *code != 1 {
				t.Errorf("exit code = %d, want 1", *code)
			}
		})
	}
}

// opsPathsSetFlag sets one flag on a shared cobra command and restores it afterwards. The tree is a
// package global, so a value left behind would decide a later test.
func opsPathsSetFlag(t *testing.T, cmd *cobra.Command, name, value string) {
	t.Helper()
	f := cmd.Flags().Lookup(name)
	if f == nil {
		t.Fatalf("%s has no --%s", cmd.CommandPath(), name)
	}
	if err := f.Value.Set(value); err != nil {
		t.Fatalf("set --%s: %v", name, err)
	}
	f.Changed = true
	t.Cleanup(func() { _ = f.Value.Set(f.DefValue); f.Changed = false })
}

// TestOpsPaths_ApproveAndSessionReportAFailedControlPlane covers the two commands' own error arms
// against a control plane that refuses.
func TestOpsPaths_ApproveAndSessionReportAFailedControlPlane(t *testing.T) {
	cases := map[string]func(t *testing.T){
		"approve": func(t *testing.T) {
			cmd := opsPathsCmd(t, "alethia ops approve")
			opsPathsSetFlag(t, cmd, "reason", "incident-4711")
			cmd.Run(cmd, []string{"state_surgery", "k1"})
		},
		"session": func(t *testing.T) {
			cmd := opsPathsCmd(t, "alethia ops session")
			opsPathsSetFlag(t, cmd, "reason", "incident-4711")
			cmd.Run(cmd, nil)
		},
	}
	for name, call := range cases {
		t.Run(name, func(t *testing.T) {
			opsPathsRefusingServer(t)
			opsPathsNoInput(t, true)
			code := opsPathsTrapExit(t)
			call(t)
			if *code != 1 {
				t.Errorf("exit code = %d, want 1 — a refused break-glass call must not read as success", *code)
			}
		})
	}
}

// TestOpsPaths_ApproveAndSessionTakeTheFatalPathOnAFailedWrite covers the render arm of the two
// commands that render outside runOpsAction.
func TestOpsPaths_ApproveAndSessionTakeTheFatalPathOnAFailedWrite(t *testing.T) {
	cases := map[string]func(t *testing.T){
		"approve": func(t *testing.T) {
			cmd := opsPathsCmd(t, "alethia ops approve")
			opsPathsSetFlag(t, cmd, "reason", "incident-4711")
			cmd.Run(cmd, []string{"state_surgery", "k1"})
		},
		"session": func(t *testing.T) {
			cmd := opsPathsCmd(t, "alethia ops session")
			opsPathsSetFlag(t, cmd, "reason", "incident-4711")
			cmd.Run(cmd, nil)
		},
	}
	for name, call := range cases {
		t.Run(name, func(t *testing.T) {
			_, _, _ = opsFormEnv(t)
			opsPathsNoInput(t, true)

			_, w, err := os.Pipe()
			if err != nil {
				t.Fatalf("pipe: %v", err)
			}
			_ = w.Close()
			prev := os.Stdout
			os.Stdout = w
			t.Cleanup(func() { os.Stdout = prev })

			code := opsPathsTrapExit(t)
			call(t)
			if *code != 1 {
				t.Errorf("a failed write to stdout did not take the fatal path (exit %d)", *code)
			}
		})
	}
}

// TestOpsPaths_GroupWalkSkipsHiddenAndGeneratedCommands drives the branch the live tree cannot: the
// real `ops` group has no hidden verb, so the skip is only reachable against a built one.
func TestOpsPaths_GroupWalkSkipsHiddenAndGeneratedCommands(t *testing.T) {
	root := &cobra.Command{Use: "alethia"}
	group := &cobra.Command{Use: "ops"}
	root.AddCommand(group)
	group.AddCommand(&cobra.Command{Use: "visible", Run: func(*cobra.Command, []string) {}})
	group.AddCommand(&cobra.Command{Use: "secret", Hidden: true, Run: func(*cobra.Command, []string) {}})
	group.AddCommand(&cobra.Command{Use: "help", Run: func(*cobra.Command, []string) {}})
	group.AddCommand(&cobra.Command{Use: "completion", Run: func(*cobra.Command, []string) {}})
	group.AddCommand(&cobra.Command{Use: "not-runnable"})

	got := opsGroupCommands(root)
	if len(got) != 1 || got[0].Name() != "visible" {
		names := make([]string, len(got))
		for i, c := range got {
			names[i] = c.Name()
		}
		t.Errorf("opsGroupCommands = %v, want [visible]", names)
	}
}

// TestOpsPaths_ApprovalActionScriptedWithNoArgumentNamesThePositional covers the one scripted
// refusal the resolver table above does not reach: `ops approve` with nothing to approve.
func TestOpsPaths_ApprovalActionScriptedWithNoArgumentNamesThePositional(t *testing.T) {
	opsPathsNoInput(t, true)
	authFormNoForm(t)
	code := opsPathsTrapExit(t)
	if got := opsResolveApprovalAction(opsPathsCmd(t, "alethia ops approve"), nil); got != "" {
		t.Errorf("opsResolveApprovalAction = %q with prompting disabled", got)
	}
	if *code != 1 {
		t.Errorf("exit code = %d, want 1", *code)
	}
}

// TestOpsPaths_ExecutorReportsARefusedSession covers the arm an operator meets on a deployment
// where break-glass is not armed: the session open is the FIRST call, and its refusal is the whole
// message.
//
// Both halves are asserted: the exit code, and that the executor stopped there rather than carrying
// on to execute an action with an empty session id — which the server would refuse for a second,
// less legible reason.
func TestOpsPaths_ExecutorReportsARefusedSession(t *testing.T) {
	opsPathsRefusingServer(t)
	opsPathsNoInput(t, true)
	code := opsPathsTrapExit(t)

	out, _ := opsFormCaptureStdout(t, func() int {
		runOpsAction(opsRequest{
			Cmd: opsPathsCmd(t, "alethia ops inspect-job"), ResourceID: "j1", Reason: "incident-4711",
		})
		return 0
	})
	if *code != 1 {
		t.Errorf("exit code = %d, want 1", *code)
	}
	if strings.Contains(out, "result") {
		t.Errorf("the executor rendered a result after the session was refused:\n%s", out)
	}
}
