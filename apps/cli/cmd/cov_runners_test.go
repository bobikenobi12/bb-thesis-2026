// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/runners"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// The runner noun group (#3705).
//
// Two defects share one shape and this file pins both:
//
//   - a field the interactive form can ask for that no flag can set, so `--no-input` reaches a
//     prompt. `runner deploy` ran the EXECUTOR picker unconditionally, so a scripted deploy died
//     on `could not open a new TTY` no combination of the other flags could avoid;
//   - a value one command prints that has to be pasted into the next. Every runner command took
//     an opaque id, and the only place to get one is `runner list`.
//
// The assertions below drive the REAL cobra tree against a fake control plane, so what they see is
// what a user's shell would do.

// ---------------------------------------------------------------------------
// The resolvers, at unit level
// ---------------------------------------------------------------------------

// runnerFakeLister is a runnerLister that records how many times it was asked. The count is the
// assertion for the paths that must NOT list — a resolver that quietly fetched the world to hand
// back an id it was already given is a network round trip per command.
type runnerFakeLister struct {
	list  []api.Runner
	err   error
	calls int
}

func (f *runnerFakeLister) GetRunners() ([]api.Runner, error) {
	f.calls++
	return f.list, f.err
}

// runnerFakeIdentities is a cloudIdentityLister with the same recording.
type runnerFakeIdentities struct {
	list  []api.CloudIdentity
	err   error
	calls int
}

func (f *runnerFakeIdentities) GetCloudIdentities() ([]api.CloudIdentity, error) {
	f.calls++
	return f.list, f.err
}

// runnerRefFixture is the listing the resolver assertions run against. "eu-runner" is unique,
// "twin" is shared by two runners, and "solo" has an id that is nobody's name.
//
// The ORDER is load-bearing and was wrong once: with "eu-runner" first, "return the runner whose
// name matched" and "return the first runner in the list" are the same value, so a resolver
// mutated to `return list[0].ID` stayed green here. The unique name is deliberately NOT first.
func runnerRefFixture() []api.Runner {
	return []api.Runner{
		{ID: "r-a", Name: "twin", Status: "ONLINE"},
		{ID: "r-eu", Name: "eu-runner", Status: "ONLINE"},
		{ID: "r-b", Name: "twin", Status: "OFFLINE"},
		{ID: "r-orphan", Name: "solo", Status: "OFFLINE"},
	}
}

func TestRunnerRef_ResolvesANameToThatRunnersID(t *testing.T) {
	f := &runnerFakeLister{list: runnerRefFixture()}
	got, err := resolveRunnerRef(f, "--runner", "eu-runner")
	if err != nil {
		t.Fatalf("resolveRunnerRef: %v", err)
	}
	// The IDENTITY, not merely "some non-empty id". A resolver that returned the first listed
	// runner would satisfy a non-empty check and destroy the wrong machine.
	if got != "r-eu" {
		t.Errorf("resolveRunnerRef(%q) = %q, want %q", "eu-runner", got, "r-eu")
	}
}

func TestRunnerRef_ResolvesAnIDToItselfByteForByte(t *testing.T) {
	f := &runnerFakeLister{list: runnerRefFixture()}
	got, err := resolveRunnerRef(f, "--runner", "r-orphan")
	if err != nil {
		t.Fatalf("resolveRunnerRef: %v", err)
	}
	if got != "r-orphan" {
		t.Errorf("an id must come back unreshaped: got %q, want %q", got, "r-orphan")
	}
}

func TestRunnerRef_AnEmptyRefAsksNothing(t *testing.T) {
	f := &runnerFakeLister{list: runnerRefFixture()}
	got, err := resolveRunnerRef(f, "--runner", "")
	if err != nil || got != "" {
		t.Fatalf("resolveRunnerRef(\"\") = %q, %v; want \"\", nil", got, err)
	}
	if f.calls != 0 {
		t.Errorf("an empty ref made %d listing call(s); the caller's own picker has not run yet", f.calls)
	}
}

func TestRunnerRef_AnAmbiguousNameIsRefusedNamingBothIDs(t *testing.T) {
	f := &runnerFakeLister{list: runnerRefFixture()}
	_, err := resolveRunnerRef(f, "--runner", "twin")
	if err == nil {
		t.Fatal("two runners share the name; picking one would destroy a plausible, wrong runner")
	}
	for _, want := range []string{"r-a", "r-b"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal must name %q so the caller can pass an id: %v", want, err)
		}
	}
}

func TestRunnerRef_AnUnknownNameListsTheNamesThatExist(t *testing.T) {
	f := &runnerFakeLister{list: runnerRefFixture()}
	_, err := resolveRunnerRef(f, "--runner", "eu-runnr")
	if err == nil {
		t.Fatal("a typo must not be sent to the server as an id")
	}
	// De-duplicated: "twin" is two runners and one name to offer.
	if got := strings.Count(err.Error(), "twin"); got != 1 {
		t.Errorf("the known-name list must offer a shared name once, got %d: %v", got, err)
	}
	for _, want := range []string{"eu-runner", "solo"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the known-name list is missing %q: %v", want, err)
		}
	}
}

func TestRunnerRef_AnEmptyListingSaysHowToGetARunner(t *testing.T) {
	f := &runnerFakeLister{list: nil}
	_, err := resolveRunnerRef(f, "--runner", "anything")
	if err == nil {
		t.Fatal("no runners at all is still a refusal")
	}
	// "have: " followed by nothing is the message that made this arm worth its own case.
	for _, want := range []string{"runner deploy", "runner register"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("an empty listing must name the way out (%q): %v", want, err)
		}
	}
}

func TestRunnerRef_TheErrorNamesTheFLAGThatWasWrong(t *testing.T) {
	f := &runnerFakeLister{list: runnerRefFixture()}
	_, aErr := resolveRunnerRef(f, "--runner", "nope")
	_, bErr := resolveRunnerRef(f, "--assigned-runner", "nope")
	if aErr == nil || bErr == nil {
		t.Fatal("both must fail")
	}
	if !strings.Contains(aErr.Error(), "--runner") || !strings.Contains(bErr.Error(), "--assigned-runner") {
		t.Fatalf("each error must name its own flag:\n  %v\n  %v", aErr, bErr)
	}
	if aErr.Error() == bErr.Error() {
		t.Error("one command line names the runner twice; two identical errors cannot say which half was wrong")
	}
}

func TestRunnerRef_AListingFailureSurfaces(t *testing.T) {
	f := &runnerFakeLister{err: errBoom}
	_, err := resolveRunnerRef(f, "--runner", "eu-runner")
	if err == nil {
		t.Fatal("a listing failure must surface, not resolve to nothing")
	}
	if !strings.Contains(err.Error(), "eu-runner") {
		t.Errorf("the wrapped error must still name what was being resolved: %v", err)
	}
}

func TestRunnerIDFrom_RefusesBothFormsOfOneField(t *testing.T) {
	f := &runnerFakeLister{list: runnerRefFixture()}
	_, err := runnerIDFrom(f, "eu-runner", "r-a", "--runner", "--runner-id")
	if err == nil {
		t.Fatal("--runner and --runner-id name the same field; precedence would let the wrong belief survive a destroy")
	}
	for _, want := range []string{"--runner", "--runner-id"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal must name %q: %v", want, err)
		}
	}
	if f.calls != 0 {
		t.Errorf("the mistake is visible in the flags alone; it made %d listing call(s)", f.calls)
	}
}

func TestRunnerIDFrom_TheIDFormIsPassedThroughUnresolved(t *testing.T) {
	f := &runnerFakeLister{list: runnerRefFixture()}
	got, err := runnerIDFrom(f, "", "r-not-listed", "--runner", "--runner-id")
	if err != nil {
		t.Fatalf("runnerIDFrom: %v", err)
	}
	if got != "r-not-listed" {
		t.Errorf("the raw id form is the server's to reject, got %q", got)
	}
	if f.calls != 0 {
		t.Errorf("the raw id form must make no listing call, made %d", f.calls)
	}
}

// ---------------------------------------------------------------------------
// The deploy cloud-account resolver, and its narrowing
// ---------------------------------------------------------------------------

func runnerIdentityFixture() []api.CloudIdentity {
	return []api.CloudIdentity{
		{ID: "ci-aws", Provider: "aws", Label: "prod-account"},
		{ID: "ci-gcp", Provider: "gcp", Label: "gcp-account"},
		{ID: "ci-aws2", Provider: "aws", Label: "twin-account"},
		{ID: "ci-aws3", Provider: "aws", Label: "twin-account"},
	}
}

func TestRunnerDeployIdentity_ResolvesADeployableLabel(t *testing.T) {
	f := &runnerFakeIdentities{list: runnerIdentityFixture()}
	got, err := runnerDeployIdentityID(f, "prod-account", "")
	if err != nil {
		t.Fatalf("runnerDeployIdentityID: %v", err)
	}
	if got != "ci-aws" {
		t.Errorf("label %q = %q, want %q", "prod-account", got, "ci-aws")
	}
}

// The narrowing is the point: the picker cannot offer a GCP account, so the flag must not accept
// one. A flag path that skipped the narrowing makes the two halves of one field disagree.
func TestRunnerDeployIdentity_RefusesACloudWithNoRunnerTemplate(t *testing.T) {
	if runners.IsDeployProvider("gcp") {
		t.Skip("gcp gained a runner template; this case needs a cloud that has none")
	}
	f := &runnerFakeIdentities{list: runnerIdentityFixture()}
	_, err := runnerDeployIdentityID(f, "gcp-account", "")
	if err == nil {
		t.Fatal("a GCP account cannot host a deployed runner; the picker never offers one")
	}
	// Word for word with the console's refusal, via runners.UnsupportedMessage — a user who hits
	// this wall in the CLI and the same wall in the UI must read one sentence, not two.
	if !strings.Contains(err.Error(), runners.UnsupportedMessage("gcp")) {
		t.Errorf("the refusal must be the shared message, got: %v", err)
	}
}

func TestRunnerDeployIdentity_AnUnknownLabelListsTheDeployableOnes(t *testing.T) {
	f := &runnerFakeIdentities{list: runnerIdentityFixture()}
	_, err := runnerDeployIdentityID(f, "nope", "")
	if err == nil {
		t.Fatal("an unknown label must be refused")
	}
	if !strings.Contains(err.Error(), "prod-account") {
		t.Errorf("the offer must list the deployable labels: %v", err)
	}
	if strings.Contains(err.Error(), "gcp-account") {
		t.Errorf("the offer must NOT list a label the command would then refuse: %v", err)
	}
}

func TestRunnerDeployIdentity_AnAmbiguousLabelIsRefusedNamingBothIDs(t *testing.T) {
	f := &runnerFakeIdentities{list: runnerIdentityFixture()}
	_, err := runnerDeployIdentityID(f, "twin-account", "")
	if err == nil {
		t.Fatal("two accounts share the label; deploying into one of them at random is a bill in the wrong account")
	}
	for _, want := range []string{"ci-aws2", "ci-aws3"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal must name %q: %v", want, err)
		}
	}
}

func TestRunnerDeployIdentity_TheRawIDFormMakesNoListingCall(t *testing.T) {
	f := &runnerFakeIdentities{list: runnerIdentityFixture()}
	got, err := runnerDeployIdentityID(f, "", "ci-whatever")
	if err != nil {
		t.Fatalf("runnerDeployIdentityID: %v", err)
	}
	if got != "ci-whatever" {
		t.Errorf("the raw id form must pass through unreshaped, got %q", got)
	}
	if f.calls != 0 {
		t.Errorf("the raw id form made %d listing call(s)", f.calls)
	}
}

func TestRunnerDeployIdentity_RefusesBothFormsOfOneField(t *testing.T) {
	f := &runnerFakeIdentities{list: runnerIdentityFixture()}
	if _, err := runnerDeployIdentityID(f, "prod-account", "ci-aws"); err == nil {
		t.Fatal("--cloud-account and --cloud-identity-id name the same field")
	}
}

// register binds to ANY cloud — nothing is provisioned, so the deploy narrowing must not leak
// into it. A GCP account is exactly what `runner register` exists for.
func TestRegisterIdentity_BindsToACloudADeployCannotUse(t *testing.T) {
	f := &runnerFakeIdentities{list: runnerIdentityFixture()}
	got, err := registerIdentityID(f, "gcp-account", "")
	if err != nil {
		t.Fatalf("registerIdentityID: %v", err)
	}
	if got != "ci-gcp" {
		t.Errorf("register must bind a GCP account, got %q", got)
	}
}

func TestRegisterIdentity_RefusesBothFormsOfOneField(t *testing.T) {
	f := &runnerFakeIdentities{list: runnerIdentityFixture()}
	if _, err := registerIdentityID(f, "prod-account", "ci-aws"); err == nil {
		t.Fatal("--cloud-account and --cloud-identity-id name the same field")
	}
}

// ---------------------------------------------------------------------------
// runnerAskOrDefault — the "form asks, --no-input takes the default" seam
// ---------------------------------------------------------------------------

func TestRunnerAskOrDefault_TakesTheDefaultWithoutOpeningAForm(t *testing.T) {
	opened := 0
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { opened++; return nil }
	t.Cleanup(func() { runHuhForm = prev })
	hygCliConfirmSetNoInput(t, true)

	var got string
	if err := runnerAskOrDefault(&got, "Region", "d", "eu-west-1"); err != nil {
		t.Fatalf("runnerAskOrDefault: %v", err)
	}
	if got != "eu-west-1" {
		t.Errorf("value = %q, want the default", got)
	}
	if opened != 0 {
		t.Errorf("a form was opened %d time(s) with prompting disabled — this is the TTY error", opened)
	}
}

// The precondition for the case above: with prompting ENABLED the form does run, so a stub that
// is simply never reached cannot make the previous test pass.
func TestRunnerAskOrDefault_AsksWhenPromptingIsEnabled(t *testing.T) {
	opened := 0
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { opened++; return nil }
	t.Cleanup(func() { runHuhForm = prev })
	hygCliConfirmSetNoInput(t, false)

	var got string
	if err := runnerAskOrDefault(&got, "Region", "d", "eu-west-1"); err != nil {
		t.Fatalf("runnerAskOrDefault: %v", err)
	}
	if opened != 1 {
		t.Fatalf("form opened %d time(s), want 1", opened)
	}
	// An unanswered form still lands on the default — that is what pressing Enter does.
	if got != "eu-west-1" {
		t.Errorf("value = %q, want the default after an unanswered form", got)
	}
}

func TestRunnerAskOrDefault_AGivenValueIsNeverOverwritten(t *testing.T) {
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { t.Fatal("a field the caller already set must not be asked"); return nil }
	t.Cleanup(func() { runHuhForm = prev })
	hygCliConfirmSetNoInput(t, false)

	got := "us-east-1"
	if err := runnerAskOrDefault(&got, "Region", "d", "eu-west-1"); err != nil {
		t.Fatalf("runnerAskOrDefault: %v", err)
	}
	if got != "us-east-1" {
		t.Errorf("value = %q, want the caller's own", got)
	}
}

func TestDeployDefaultName_IsNeverJustThePrefix(t *testing.T) {
	// os.Hostname can fail, and "runner-" alone is a name nobody can pick out of a list.
	if got := deployDefaultName(); got == "runner-" || got == "" {
		t.Errorf("deployDefaultName() = %q", got)
	}
	host, err := os.Hostname()
	if err == nil && host != "" && deployDefaultName() != "runner-"+host {
		t.Errorf("deployDefaultName() = %q, want %q", deployDefaultName(), "runner-"+host)
	}
}

// ---------------------------------------------------------------------------
// The whole group, driven under --no-input against a fake control plane
// ---------------------------------------------------------------------------

// runnerEnvServer records every request, with the body of the ones that carry one.
type runnerEnvServer struct {
	mu       sync.Mutex
	requests []string
	bodies   map[string][]byte
}

func (s *runnerEnvServer) record(r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := r.Method + " " + r.URL.Path
	s.requests = append(s.requests, key)
	if r.Body != nil {
		b, _ := io.ReadAll(r.Body)
		if s.bodies == nil {
			s.bodies = map[string][]byte{}
		}
		s.bodies[key] = b
	}
}

func (s *runnerEnvServer) saw(method, path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, req := range s.requests {
		if req == method+" "+path {
			return true
		}
	}
	return false
}

func (s *runnerEnvServer) body(method, path string) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bodies[method+" "+path]
}

func (s *runnerEnvServer) forget() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests, s.bodies = nil, nil
}

func (s *runnerEnvServer) seen() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.requests...)
}

// runnerEnv stands up isolated credentials, a fake control plane that answers every runner
// endpoint, and a runner that drives the REAL cobra tree.
//
// It reuses hyg_cli_confirm_test.go's exit trap and flag reset deliberately: cobra never clears a
// flag between Execute calls, so a --yes or a --runner left set here would decide a later test in
// this package.
func runnerEnv(t *testing.T) (*runnerEnvServer, func(args ...string) int) {
	t.Helper()
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	if err := types.SaveCliConfig(types.CliConfig{
		ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme",
	}); err != nil {
		t.Fatalf("SaveCliConfig: %v", err)
	}

	s := &runnerEnvServer{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.record(r)
		enc := json.NewEncoder(w)
		switch p := r.URL.Path; {
		case p == "/api/cli/runners" && r.Method == http.MethodGet:
			_ = enc.Encode(map[string]interface{}{"runners": []map[string]interface{}{
				// r-us is FIRST so that "resolved the name" and "took the first row" are
				// different answers — see runnerRefFixture for the run where they were not.
				{"id": "r-us", "name": "us-runner", "operator": "managed",
					"status": "OFFLINE", "created_at": "2026-01-01T00:00:00Z"},
				{"id": "r-eu", "name": "eu-runner", "operator": "self", "provisioning": "deployed",
					"status": "ONLINE", "version": "1.2.3", "is_default": true,
					"last_heartbeat": "2026-01-01T00:00:00Z", "created_at": "2026-01-01T00:00:00Z"},
			}})
		case p == "/api/cli/cloud-identities":
			_ = enc.Encode(map[string]interface{}{"cloud_identities": []map[string]interface{}{
				{"id": "ci-aws", "provider": "aws", "label": "prod-account", "created_at": "2026-01-01T00:00:00Z"},
			}})
		case p == "/api/cli/runners/deploy":
			_ = enc.Encode(map[string]interface{}{
				"runner": map[string]interface{}{"id": "r-new", "name": "eu-runner-2"},
				"job":    map[string]interface{}{"id": "j-deploy", "status": "PENDING", "created_at": "2026-01-01T00:00:00Z"},
			})
		case p == "/api/cli/runners/register":
			_ = enc.Encode(map[string]interface{}{
				"runner":       map[string]interface{}{"id": "r-reg", "name": "box-1"},
				"runner_token": "tok-xyz",
			})
		case p == "/api/jobs" && r.Method == http.MethodPost:
			_ = enc.Encode(map[string]interface{}{"job": map[string]interface{}{
				"id": "j-destroy", "job_type": "DESTROY_RUNNER", "status": "PENDING",
				"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
			}})
		default:
			_ = enc.Encode(map[string]interface{}{"ok": true})
		}
	}))
	t.Cleanup(srv.Close)

	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	prevExit := exitFunc
	exitFunc = func(code int) { panic(hygCliConfirmExit{code: code}) }
	t.Cleanup(func() {
		exitFunc = prevExit
		hygCliConfirmResetFlags()
		runnerResetGroupFlags()
	})

	return s, func(args ...string) (code int) {
		defer func() {
			hygCliConfirmResetFlags()
			runnerResetGroupFlags()
			if r := recover(); r != nil {
				e, ok := r.(hygCliConfirmExit)
				if !ok {
					panic(r)
				}
				code = e.code
			}
		}()
		hygCliConfirmResetFlags()
		runnerResetGroupFlags()
		// execRootArgs, not rootCmd.SetArgs: it returns --output, --no-input and --token to their
		// defaults first. cobra keeps a flag's value AND its Changed bit across Execute calls, so
		// a --no-input one file passed becomes the next file's default.
		execRootArgs(args)
		if err := rootCmd.Execute(); err != nil {
			return 1
		}
		return 0
	}
}

// runnerResetGroupFlags clears the group's flag-bound globals. hygCliConfirmResetFlags walks the
// cobra tree and resets what was Changed, which covers the flags; these are listed explicitly for
// the same reason its own explicit list exists — a value assigned directly by a test would
// otherwise decide the next one.
func runnerResetGroupFlags() {
	deployCloudAccount, deployCloudIdentityID = "", ""
	deployRunnerName, deployRegion = "", ""
	deployAssignedRunner, deployAssignedID = "", ""
	destroyRunner, destroyRunnerID = "", ""
	destroyAssignedRunner, destroyRunnerAssignedID = "", ""
	runnerRemoveRef = ""
	registerRunnerName, registerCloudAccount, registerCloudIdentity = "", "", ""
}

// runnerNoInputCases is one complete, unattended invocation per leaf of the group: every field
// named by a flag, nothing left for a prompt.
//
// The names are the point. Not one of these lines carries an id, and the ids the fake control
// plane holds appear only in the ASSERTIONS — so a resolver that returned the wrong runner cannot
// pass by echoing back what the command line already said.
var runnerNoInputCases = []struct {
	leaf   string
	args   []string
	method string
	path   string
}{
	{
		leaf: "deploy",
		args: []string{"runner", "deploy",
			"--cloud-account", "prod-account", "--name", "eu-runner-2", "--region", "eu-west-1"},
		method: http.MethodPost, path: "/api/cli/runners/deploy",
	},
	{
		leaf:   "register",
		args:   []string{"runner", "register", "box-1", "--cloud-account", "prod-account"},
		method: http.MethodPost, path: "/api/cli/runners/register",
	},
	{
		leaf:   "list",
		args:   []string{"runner", "list"},
		method: http.MethodGet, path: "/api/cli/runners",
	},
	{
		leaf:   "destroy",
		args:   []string{"runner", "destroy", "--runner", "eu-runner", "--yes"},
		method: http.MethodPost, path: "/api/jobs",
	},
	{
		leaf:   "remove",
		args:   []string{"runner", "remove", "--runner", "eu-runner", "--yes"},
		method: http.MethodDelete, path: "/api/cli/runners/r-eu",
	},
}

// runnerLeaves returns every runnable leaf of the `runner` group, from the cobra tree.
func runnerLeaves(t *testing.T) []string {
	t.Helper()
	var out []string
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		for _, sub := range c.Commands() {
			if sub.Hidden || sub.Name() == "help" || sub.Name() == "completion" {
				continue
			}
			if sub.Runnable() {
				out = append(out, sub.Name())
			}
			walk(sub)
		}
	}
	walk(runnerCmd)
	sort.Strings(out)
	return out
}

// TestRunnerField_TheNoInputCensusIsTheWholeGroup keeps the list above from decaying.
//
// A hand-written list of what a guard covers stops covering silently the moment a leaf is added.
// The SET comes from the cobra tree; the list only supplies the arguments.
func TestRunnerField_TheNoInputCensusIsTheWholeGroup(t *testing.T) {
	leaves := runnerLeaves(t)
	if len(leaves) == 0 {
		t.Fatal("the runner group has no runnable leaves — every assertion in this file is vacuous")
	}
	covered := map[string]bool{}
	for _, tc := range runnerNoInputCases {
		covered[tc.leaf] = true
	}
	for _, leaf := range leaves {
		if !covered[leaf] {
			t.Errorf("`alethia runner %s` has no unattended case — a leaf that can still reach a "+
				"prompt under --no-input would ship invisible", leaf)
		}
	}
	known := map[string]bool{}
	for _, leaf := range leaves {
		known[leaf] = true
	}
	for _, tc := range runnerNoInputCases {
		if !known[tc.leaf] {
			t.Errorf("the census names %q, which is not a leaf of the runner group — a renamed "+
				"command must be a failure, not a silently-skipped row", tc.leaf)
		}
	}
}

// TestRunnerField_EveryLeafRunsUnattended is the regression this lane exists for: with every field
// given as a flag, no command in the group reaches a prompt, and each one gets through to the
// control plane.
//
// runHuhForm is stubbed to FAIL rather than to answer. A prompt reached here is a prompt that
// would hang a CI job until its context killed it, so "it was opened" is the whole finding — what
// it would have returned does not matter.
func TestRunnerField_EveryLeafRunsUnattended(t *testing.T) {
	if len(runnerNoInputCases) == 0 {
		t.Fatal("no cases — every assertion below is vacuous")
	}
	s, run := runnerEnv(t)

	for _, tc := range runnerNoInputCases {
		t.Run(tc.leaf, func(t *testing.T) {
			s.forget()
			opened := 0
			prevForm := runHuhForm
			runHuhForm = func(...*huh.Group) error { opened++; return nil }
			prevConfirm := confirm
			confirm = func(string, string) bool { opened++; return false }
			t.Cleanup(func() { runHuhForm, confirm = prevForm, prevConfirm })

			if got := run(append(append([]string{}, tc.args...), "--no-input")...); got != 0 {
				t.Fatalf("exit code = %d, want 0; requests = %v", got, s.seen())
			}
			if opened != 0 {
				t.Errorf("%d prompt(s) were opened with --no-input; in CI that hangs until the "+
					"context kills it", opened)
			}
			if !s.saw(tc.method, tc.path) {
				t.Errorf("no %s %s; requests = %v", tc.method, tc.path, s.seen())
			}
		})
	}
}

// TestRunnerField_ANameReachesTheRightRunner is the handoff removal, asserted as an IDENTITY.
//
// `--runner eu-runner` must address r-eu. The fixture holds a second runner so "it addressed a
// runner" is not the same answer as "it addressed the right one", and the id never appears on the
// command line, so the assertion cannot pass by echo.
func TestRunnerField_ANameReachesTheRightRunner(t *testing.T) {
	s, run := runnerEnv(t)

	t.Run("remove deletes that runner's record", func(t *testing.T) {
		s.forget()
		if got := run("runner", "remove", "--runner", "eu-runner", "--no-input", "--yes"); got != 0 {
			t.Fatalf("exit code = %d, want 0; requests = %v", got, s.seen())
		}
		if !s.saw(http.MethodDelete, "/api/cli/runners/r-eu") {
			t.Fatalf("the name did not resolve to r-eu; requests = %v", s.seen())
		}
		if s.saw(http.MethodDelete, "/api/cli/runners/r-us") {
			t.Fatal("it removed the OTHER runner")
		}
	})

	t.Run("destroy queues the job against that runner's id", func(t *testing.T) {
		s.forget()
		if got := run("runner", "destroy", "--runner", "eu-runner",
			"--assigned-runner", "us-runner", "--no-input", "--yes"); got != 0 {
			t.Fatalf("exit code = %d, want 0; requests = %v", got, s.seen())
		}
		raw := s.body(http.MethodPost, "/api/jobs")
		if len(raw) == 0 {
			t.Fatalf("no DESTROY_RUNNER job was queued; requests = %v", s.seen())
		}
		var payload struct {
			JobType          string            `json:"job_type"`
			AssignedRunnerID string            `json:"assigned_runner_id"`
			ConfigSnapshot   map[string]string `json:"config_snapshot"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("decode job payload: %v (%s)", err, raw)
		}
		if payload.JobType != "DESTROY_RUNNER" {
			t.Errorf("job_type = %q", payload.JobType)
		}
		// Both halves, and they must differ: the subject and the executor are two fields, and a
		// resolver wired to the wrong variable would put one id in both slots.
		if payload.ConfigSnapshot["runner_id"] != "r-eu" {
			t.Errorf("config_snapshot.runner_id = %q, want r-eu", payload.ConfigSnapshot["runner_id"])
		}
		if payload.AssignedRunnerID != "r-us" {
			t.Errorf("assigned_runner_id = %q, want r-us", payload.AssignedRunnerID)
		}
	})

	t.Run("deploy binds the cloud account its label names", func(t *testing.T) {
		s.forget()
		if got := run("runner", "deploy", "--cloud-account", "prod-account",
			"--name", "eu-runner-2", "--region", "eu-west-1", "--no-input"); got != 0 {
			t.Fatalf("exit code = %d, want 0; requests = %v", got, s.seen())
		}
		raw := s.body(http.MethodPost, "/api/cli/runners/deploy")
		var payload map[string]string
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("decode deploy payload: %v (%s)", err, raw)
		}
		if payload["cloud_identity_id"] != "ci-aws" {
			t.Errorf("cloud_identity_id = %q, want ci-aws", payload["cloud_identity_id"])
		}
		if payload["region"] != "eu-west-1" || payload["name"] != "eu-runner-2" {
			t.Errorf("deploy payload lost a field: %v", payload)
		}
		// An omitted --assigned-runner leaves the job for any available runner. It must NOT have
		// been filled in by the picker, which is the arm that used to run unconditionally.
		if _, ok := payload["assigned_runner_id"]; ok {
			t.Errorf("an omitted executor became %q", payload["assigned_runner_id"])
		}
	})
}

// TestRunnerField_DeployDefaultsItsOwnFieldsUnderNoInput pins the second half of the deploy fix:
// --name and --region have defaults, so a scripted deploy that omits them still runs.
func TestRunnerField_DeployDefaultsItsOwnFieldsUnderNoInput(t *testing.T) {
	s, run := runnerEnv(t)
	opened := 0
	prevForm := runHuhForm
	runHuhForm = func(...*huh.Group) error { opened++; return nil }
	t.Cleanup(func() { runHuhForm = prevForm })

	if got := run("runner", "deploy", "--cloud-account", "prod-account", "--no-input"); got != 0 {
		t.Fatalf("exit code = %d, want 0; requests = %v", got, s.seen())
	}
	if opened != 0 {
		t.Errorf("%d prompt(s) opened for fields that have defaults", opened)
	}
	var payload map[string]string
	if err := json.Unmarshal(s.body(http.MethodPost, "/api/cli/runners/deploy"), &payload); err != nil {
		t.Fatalf("decode deploy payload: %v", err)
	}
	if payload["region"] != deployRegionDefault {
		t.Errorf("region = %q, want the documented default %q", payload["region"], deployRegionDefault)
	}
	if payload["name"] != deployDefaultName() {
		t.Errorf("name = %q, want %q", payload["name"], deployDefaultName())
	}
}

// runnerCaptureStdout runs fn with os.Stdout replaced by a pipe and returns what was written.
//
// The CLI's fatal path is ui.Error, which fmt.Printf's to the process's stdout rather than to a
// writer a caller supplies, so a test that wants to read a refusal has to take the file
// descriptor. Without this the assertions below could only see the EXIT CODE — and an exit code
// cannot tell "refused, and here is the flag to add" apart from "refused, interactive input
// required", which is the whole difference this lane is making.
func runnerCaptureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	prev := os.Stdout
	os.Stdout = w
	done := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	func() {
		defer func() {
			os.Stdout = prev
			_ = w.Close()
		}()
		fn()
	}()
	out := <-done
	_ = r.Close()
	return out
}

// TestRunnerField_ARefusalNamesTheFlagToAdd is the arm an exit code cannot carry.
//
// Every one of these commands ALREADY exited 1 when a required field was missing — the picker it
// fell through to reported `interactive input required but --no-input is set`. So an assertion on
// the exit code alone passes with the fix and passes without it: it is a true statement about the
// wrong thing. What changed is that the refusal now names the flag to add, and that is what a
// reader of a CI log needs.
func TestRunnerField_ARefusalNamesTheFlagToAdd(t *testing.T) {
	cases := []struct {
		name  string
		args  []string
		wants []string
		// forbidden is the request that must NOT have happened.
		method, path string
	}{
		{
			name:   "deploy has no default cloud account",
			args:   []string{"runner", "deploy", "--name", "x", "--region", "eu-west-1", "--no-input"},
			wants:  []string{"--cloud-account", "--cloud-identity-id"},
			method: http.MethodPost, path: "/api/cli/runners/deploy",
		},
		{
			name:   "destroy has no default runner",
			args:   []string{"runner", "destroy", "--no-input", "--yes"},
			wants:  []string{"--runner", "--runner-id"},
			method: http.MethodPost, path: "/api/jobs",
		},
		{
			name:   "remove has no default runner",
			args:   []string{"runner", "remove", "--no-input", "--yes"},
			wants:  []string{"--runner"},
			method: http.MethodDelete, path: "/api/cli/runners/r-eu",
		},
		{
			name:   "register has no default name",
			args:   []string{"runner", "register", "--no-input"},
			wants:  []string{"--name"},
			method: http.MethodPost, path: "/api/cli/runners/register",
		},
	}

	s, run := runnerEnv(t)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s.forget()
			var code int
			out := runnerCaptureStdout(t, func() { code = run(tc.args...) })
			if code != 1 {
				t.Fatalf("exit code = %d, want 1; requests = %v", code, s.seen())
			}
			if s.saw(tc.method, tc.path) {
				t.Errorf("a command that refused still reached %s %s", tc.method, tc.path)
			}
			for _, want := range tc.wants {
				if !strings.Contains(out, want) {
					t.Errorf("the refusal does not name %s — %q is not a flag the reader can add:\n%s",
						want, "interactive input required", out)
				}
			}
		})
	}
}

// TestRunnerField_AnAmbiguousCommandLineIsRefusedBeforeAnyMutation pins that naming one field
// twice never reaches the control plane — the command being run is `destroy`.
func TestRunnerField_AnAmbiguousCommandLineIsRefusedBeforeAnyMutation(t *testing.T) {
	s, run := runnerEnv(t)
	if got := run("runner", "destroy", "--runner", "eu-runner", "--runner-id", "r-us",
		"--no-input", "--yes"); got != 1 {
		t.Fatalf("exit code = %d, want 1; requests = %v", got, s.seen())
	}
	if s.saw(http.MethodPost, "/api/jobs") {
		t.Error("a DESTROY_RUNNER job was queued from a command line that named two different runners")
	}
}

// TestRunnerField_TheLegacyIDFormStillWorks pins the compatibility half: the flags scripts already
// pass keep working, unresolved, exactly as before.
func TestRunnerField_TheLegacyIDFormStillWorks(t *testing.T) {
	s, run := runnerEnv(t)
	if got := run("runner", "remove", "r-us", "--no-input", "--yes"); got != 0 {
		t.Fatalf("exit code = %d, want 0; requests = %v", got, s.seen())
	}
	if !s.saw(http.MethodDelete, "/api/cli/runners/r-us") {
		t.Errorf("a raw id positional must still address that runner; requests = %v", s.seen())
	}
}

// TestRunnerField_RemoveRefusesTwoNamesForOneRunner pins the positional/flag pair the same way as
// the two flags on destroy.
func TestRunnerField_RemoveRefusesTwoNamesForOneRunner(t *testing.T) {
	s, run := runnerEnv(t)
	if got := run("runner", "remove", "r-us", "--runner", "eu-runner", "--no-input", "--yes"); got != 1 {
		t.Fatalf("exit code = %d, want 1; requests = %v", got, s.seen())
	}
	if s.saw(http.MethodDelete, "/api/cli/runners/r-us") || s.saw(http.MethodDelete, "/api/cli/runners/r-eu") {
		t.Error("a removal happened from a command line that named two different runners")
	}
}

// TestRunnerField_RegisterAsksForTheNameOnATerminal pins the interactive path `register` never
// had. With prompting enabled and no name, it must ASK; with --no-input it must refuse naming the
// flag rather than reach a form.
func TestRunnerField_RegisterAsksForTheNameOnATerminal(t *testing.T) {
	s, run := runnerEnv(t)

	t.Run("asks", func(t *testing.T) {
		s.forget()
		hygCliConfirmInteractive(t)
		asked := 0
		prevForm := runHuhForm
		runHuhForm = func(...*huh.Group) error { asked++; return nil }
		t.Cleanup(func() { runHuhForm = prevForm })

		// The stub answers nothing, so the name stays empty and the registration is refused — the
		// assertion is that it ASKED, which is the path that did not exist before.
		run("runner", "register")
		if asked == 0 {
			t.Error("`runner register` with no name must ask for one on a terminal")
		}
		if s.saw(http.MethodPost, "/api/cli/runners/register") {
			t.Error("an unanswered form must not register a nameless runner")
		}
	})

	t.Run("refuses under --no-input without reaching a form", func(t *testing.T) {
		s.forget()
		opened := 0
		prevForm := runHuhForm
		runHuhForm = func(...*huh.Group) error { opened++; return nil }
		t.Cleanup(func() { runHuhForm = prevForm })

		if got := run("runner", "register", "--no-input"); got != 1 {
			t.Fatalf("exit code = %d, want 1", got)
		}
		if opened != 0 {
			t.Errorf("%d form(s) opened with prompting disabled", opened)
		}
	})
}

// TestRunnerField_RegisterRefusesTwoDifferentNames pins the argument/flag pair.
func TestRunnerField_RegisterRefusesTwoDifferentNames(t *testing.T) {
	s, run := runnerEnv(t)
	if got := run("runner", "register", "box-1", "--name", "box-2", "--no-input"); got != 1 {
		t.Fatalf("exit code = %d, want 1; requests = %v", got, s.seen())
	}
	if s.saw(http.MethodPost, "/api/cli/runners/register") {
		t.Error("a registration ran from a command line that gave two different names")
	}
}

// ---------------------------------------------------------------------------
// The docs page is part of the group
// ---------------------------------------------------------------------------

// runnerDocsPage is the group's page. The `## `alethia runner …“ sections, the leaf coverage and
// the runnability of every fenced example are asserted by hyg_cli_docs_test.go, which this lane
// registers the group with; what is left, and what that guard does not ask, is whether each
// command's own FLAG TABLE matches the flags that command registers.
const runnerDocsPage = "../../docs/content/docs/cli/commands/runners.mdx"

// TestRunnerDocs_FlagTableMatchesTheRegisteredFlags compares both directions, per SECTION.
//
// The helpers are the connector group's (connDocsSections, connDocsRowFlags, connDocsFlagRef) —
// shared rather than copied, because a second implementation of "which flags does this section's
// table have a row for" is a second thing to keep correct. The SUBJECT is the cobra tree and the
// ORACLE is the file on disk, so neither is derived from the other.
func TestRunnerDocs_FlagTableMatchesTheRegisteredFlags(t *testing.T) {
	raw, err := os.ReadFile(runnerDocsPage)
	if err != nil {
		t.Fatalf("read %s: %v — this guard's verdict depends on the file, so an unreadable one is "+
			"a failure and never a pass", runnerDocsPage, err)
	}
	body := string(raw)
	sections := connDocsSections(body)
	if len(sections) == 0 {
		t.Fatalf("%s has no `## `alethia …`` sections — every assertion below is vacuous", runnerDocsPage)
	}

	scannedFlags, scannedSections := 0, 0
	registered := map[string]bool{}
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		subs := c.Commands()
		if len(subs) == 0 {
			section, documented := sections[c.CommandPath()]
			rowFlags := connDocsRowFlags(section)
			if !documented {
				t.Errorf("%s has no `## `%s`` section in %s", c.CommandPath(), c.CommandPath(), runnerDocsPage)
			}
			scannedSections++
			c.Flags().VisitAll(func(f *pflag.Flag) {
				// LocalFlags, not "absent from InheritedFlags": a flag that SHADOWS a root one
				// still binds here and is still this command's to document.
				if c.LocalFlags().Lookup(f.Name) == nil {
					return
				}
				if connDocsAutoFlags["--"+f.Name] {
					return
				}
				registered["--"+f.Name] = true
				scannedFlags++
				if documented && !rowFlags["--"+f.Name] {
					t.Errorf("%s registers --%s and its section in %s has no table row for it — a "+
						"reader scanning that command's flag table would not find it",
						c.CommandPath(), f.Name, runnerDocsPage)
				}
			})
			return
		}
		for _, sub := range subs {
			walk(sub)
		}
	}
	walk(runnerCmd)

	// Direction 2: page-wide, because the prose and the callouts are outside every section and are
	// exactly where a renamed flag survives longest.
	for _, m := range connDocsFlagRef.FindAllStringSubmatch(body, -1) {
		flag := m[1]
		if registered[flag] || connDocsGlobalFlags[flag] {
			continue
		}
		t.Errorf("%s documents %s, which no command in the runner group registers — a renamed or "+
			"deleted flag leaves an instruction behind that does not work", runnerDocsPage, flag)
	}

	if scannedFlags == 0 || scannedSections == 0 {
		t.Fatalf("scanned %d flags across %d sections — this guard is not seeing the command tree",
			scannedFlags, scannedSections)
	}
}

// TestRunnerDocs_NoExampleAsksTheReaderToCopyAnID is the programme's own definition of done for
// this group: a `<placeholder>` in a runnable example is a token the reader must fetch from
// another command's output, and that handoff is the thing being deleted.
func TestRunnerDocs_NoExampleAsksTheReaderToCopyAnID(t *testing.T) {
	raw, err := os.ReadFile(runnerDocsPage)
	if err != nil {
		t.Fatalf("read %s: %v", runnerDocsPage, err)
	}
	examples := docsFencedExamples(string(raw))
	if len(examples) == 0 {
		t.Fatalf("%s shows no `alethia …` invocation — the assertion below is vacuous", runnerDocsPage)
	}
	for _, example := range examples {
		if strings.Contains(example, "<id>") || strings.Contains(example, "<runner_id>") ||
			strings.Contains(example, "<cloud-identity-id>") {
			t.Errorf("%q asks the reader to copy an id out of another command's output", example)
		}
	}
}

// ---------------------------------------------------------------------------
// The failure arms
//
// Each of these is a branch whose whole job is to report; a resolver that failed and was then
// ignored would take the empty string forward and address the wrong thing, or nothing.
// ---------------------------------------------------------------------------

func TestRunnerDeployIdentity_AListingFailureSurfaces(t *testing.T) {
	f := &runnerFakeIdentities{err: errBoom}
	_, err := runnerDeployIdentityID(f, "prod-account", "")
	if err == nil {
		t.Fatal("a listing failure must surface, not resolve to nothing")
	}
	if !strings.Contains(err.Error(), "prod-account") {
		t.Errorf("the wrapped error must name what was being resolved: %v", err)
	}
}

// --cloud-account takes the label OR the id, so a deployable account named by its id resolves
// through the same path — and must come back unreshaped.
func TestRunnerDeployIdentity_TakesADeployableAccountsOwnID(t *testing.T) {
	f := &runnerFakeIdentities{list: runnerIdentityFixture()}
	got, err := runnerDeployIdentityID(f, "ci-aws", "")
	if err != nil {
		t.Fatalf("runnerDeployIdentityID: %v", err)
	}
	if got != "ci-aws" {
		t.Errorf("--cloud-account with an id = %q, want %q", got, "ci-aws")
	}
}

// With every linked account on a cloud that has no runner template, "not found" is the wrong
// story: there is nothing to name, and the next step is `runner register`.
func TestRunnerDeployIdentity_NoDeployableAccountAtAllNamesTheWayOut(t *testing.T) {
	if runners.IsDeployProvider("gcp") {
		t.Skip("gcp gained a runner template; this case needs a cloud that has none")
	}
	f := &runnerFakeIdentities{list: []api.CloudIdentity{{ID: "ci-gcp", Provider: "gcp", Label: "only-gcp"}}}
	_, err := runnerDeployIdentityID(f, "nope", "")
	if err == nil {
		t.Fatal("an unknown label with nothing deployable is still a refusal")
	}
	if !strings.Contains(err.Error(), "runner register") {
		t.Errorf("with nothing deployable the refusal must name the way out: %v", err)
	}
}

func TestOfferRunnerCloudBinding_AListingFailureRegistersUnbound(t *testing.T) {
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error {
		t.Fatal("a picker must not be opened over a listing that failed")
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })

	f := &runnerFakeIdentities{err: errBoom}
	got, err := offerRunnerCloudBinding(f)
	// The binding is optional and the registration is not: refusing to register a runner because
	// an OPTIONAL offer could not be rendered would be a worse answer than registering it unbound.
	if err != nil {
		t.Fatalf("a failed optional offer must not fail the registration: %v", err)
	}
	if got != "" {
		t.Errorf("identity = %q, want unbound", got)
	}
}

func TestOfferRunnerCloudBinding_NoAccountsAsksNothing(t *testing.T) {
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error {
		t.Fatal("a picker with only the `none` option is a question with one answer")
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })

	got, err := offerRunnerCloudBinding(&runnerFakeIdentities{})
	if err != nil || got != "" {
		t.Fatalf("offerRunnerCloudBinding() = %q, %v; want \"\", nil", got, err)
	}
}

func TestOfferRunnerCloudBinding_OffersNoneFirstAndSurfacesAFormError(t *testing.T) {
	var seen []*huh.Group
	prev := runHuhForm
	runHuhForm = func(groups ...*huh.Group) error { seen = groups; return errBoom }
	t.Cleanup(func() { runHuhForm = prev })

	f := &runnerFakeIdentities{list: runnerIdentityFixture()}
	if _, err := offerRunnerCloudBinding(f); err == nil {
		t.Fatal("a form error must surface")
	}
	if len(seen) != 1 {
		t.Fatalf("the picker was opened with %d group(s), want 1", len(seen))
	}
}

// TestRunnerField_AFailedResolutionStopsTheCommand drives each fail(err) arm through the real
// cobra tree: a resolver that errored must stop the run, not carry an empty id forward.
func TestRunnerField_AFailedResolutionStopsTheCommand(t *testing.T) {
	cases := []struct {
		name         string
		args         []string
		method, path string
	}{
		{
			name:   "deploy, unknown cloud account",
			args:   []string{"runner", "deploy", "--cloud-account", "nope", "--no-input"},
			method: http.MethodPost, path: "/api/cli/runners/deploy",
		},
		{
			name: "deploy, unknown executor",
			args: []string{"runner", "deploy", "--cloud-account", "prod-account",
				"--assigned-runner", "nope", "--no-input"},
			method: http.MethodPost, path: "/api/cli/runners/deploy",
		},
		{
			name: "destroy, unknown executor",
			args: []string{"runner", "destroy", "--runner", "eu-runner",
				"--assigned-runner", "nope", "--no-input", "--yes"},
			method: http.MethodPost, path: "/api/jobs",
		},
		{
			name:   "register, unknown cloud account",
			args:   []string{"runner", "register", "box-1", "--cloud-account", "nope", "--no-input"},
			method: http.MethodPost, path: "/api/cli/runners/register",
		},
	}

	s, run := runnerEnv(t)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s.forget()
			if got := run(tc.args...); got != 1 {
				t.Fatalf("exit code = %d, want 1; requests = %v", got, s.seen())
			}
			if s.saw(tc.method, tc.path) {
				t.Errorf("a failed resolution still reached %s %s", tc.method, tc.path)
			}
		})
	}
}

// TestRunnerField_RegisterSurfacesAFormError pins the two interactive arms of `register`: a form
// that errors stops the run, and the optional binding picker's answer is what gets registered.
func TestRunnerField_RegisterSurfacesAFormError(t *testing.T) {
	s, run := runnerEnv(t)
	hygCliConfirmInteractive(t)

	t.Run("the name form", func(t *testing.T) {
		s.forget()
		prev := runHuhForm
		runHuhForm = func(...*huh.Group) error { return errBoom }
		t.Cleanup(func() { runHuhForm = prev })

		if got := run("runner", "register"); got != 1 {
			t.Fatalf("exit code = %d, want 1", got)
		}
		if s.saw(http.MethodPost, "/api/cli/runners/register") {
			t.Error("a failed name form still registered a runner")
		}
	})

	t.Run("the optional binding picker", func(t *testing.T) {
		s.forget()
		prev := runHuhForm
		// The name comes from the argument, so the only form this run opens is the binding one.
		runHuhForm = func(...*huh.Group) error { return errBoom }
		t.Cleanup(func() { runHuhForm = prev })

		if got := run("runner", "register", "box-1"); got != 1 {
			t.Fatalf("exit code = %d, want 1", got)
		}
		if s.saw(http.MethodPost, "/api/cli/runners/register") {
			t.Error("a failed binding picker still registered a runner")
		}
	})
}

func TestDeployDefaultName_FallsBackWhenTheHostnameIsUnavailable(t *testing.T) {
	prev := deployHostname
	t.Cleanup(func() { deployHostname = prev })

	deployHostname = func() (string, error) { return "", errBoom }
	if got := deployDefaultName(); got != "runner" {
		t.Errorf("with no hostname, deployDefaultName() = %q, want %q", got, "runner")
	}
	deployHostname = func() (string, error) { return "", nil }
	if got := deployDefaultName(); got != "runner" {
		t.Errorf("with an EMPTY hostname, deployDefaultName() = %q — `runner-` is a name nobody "+
			"can pick out of a list", got)
	}
	deployHostname = func() (string, error) { return "box-7", nil }
	if got := deployDefaultName(); got != "runner-box-7" {
		t.Errorf("deployDefaultName() = %q, want %q", got, "runner-box-7")
	}
}

// TestRunnerField_ADestroyIsNotConfirmedBeforeItsFlagsAreChecked pins the ordering: a command line
// that names the executor twice is wrong whatever the answer to "are you sure" would be, so the
// user is never asked to confirm a teardown that was never going to run.
func TestRunnerField_ADestroyIsNotConfirmedBeforeItsFlagsAreChecked(t *testing.T) {
	s, run := runnerEnv(t)
	hygCliConfirmInteractive(t)
	asked := 0
	prev := confirm
	confirm = func(string, string) bool { asked++; return true }
	t.Cleanup(func() { confirm = prev })

	if got := run("runner", "destroy", "--runner", "eu-runner",
		"--assigned-runner", "us-runner", "--assigned-runner-id", "r-eu"); got != 1 {
		t.Fatalf("exit code = %d, want 1; requests = %v", got, s.seen())
	}
	if asked != 0 {
		t.Errorf("the user was asked to confirm %d time(s) a teardown that could never run", asked)
	}
	if s.saw(http.MethodPost, "/api/jobs") {
		t.Error("a DESTROY_RUNNER job was queued from a command line that named two executors")
	}
}

// TestRunnerField_ADestroyIsNeverAssignedToItself pins the exclusion the PICKER already applies:
// selectRunner drops the runner being destroyed from the options, and the flag path must refuse the
// same thing rather than accept silently what the picker will not offer. A runner tearing down its
// own cloud resources mid-job does not fail cleanly — the control plane sees a DESTROY_RUNNER that
// stops reporting, and whether it completed is not answerable from outside.
//
// Both spellings of the executor field are driven, because they reach it by different routes: the
// name form resolves through the listing, the id form is passed through unresolved. And --yes is not
// what stops it — the refusal is checked with the prompt skipped and with it live.
func TestRunnerField_ADestroyIsNeverAssignedToItself(t *testing.T) {
	s, run := runnerEnv(t)
	hygCliConfirmInteractive(t)
	asked := 0
	prev := confirm
	confirm = func(string, string) bool { asked++; return true }
	t.Cleanup(func() { confirm = prev })

	// The name form on both sides, with --yes — the command line from the finding, and the one a
	// person actually types.
	if got := run("runner", "destroy", "--runner", "eu-runner",
		"--assigned-runner", "eu-runner", "--yes"); got != 1 {
		t.Fatalf("name form: exit code = %d, want 1; requests = %v", got, s.seen())
	}
	if s.saw(http.MethodPost, "/api/jobs") {
		t.Error("a DESTROY_RUNNER job was queued naming the runner being destroyed as its own executor")
	}

	// The id form, reaching the same field unresolved, with the confirmation live: the refusal must
	// still land BEFORE the prompt, so the user is never asked about a teardown that cannot run.
	s.forget()
	if got := run("runner", "destroy", "--runner", "eu-runner",
		"--assigned-runner-id", "r-eu"); got != 1 {
		t.Fatalf("id form: exit code = %d, want 1; requests = %v", got, s.seen())
	}
	if asked != 0 {
		t.Errorf("the user was asked to confirm %d time(s) a teardown that was never going to run", asked)
	}
	if s.saw(http.MethodPost, "/api/jobs") {
		t.Error("id form: a DESTROY_RUNNER job was queued naming the runner being destroyed as its own executor")
	}
}
