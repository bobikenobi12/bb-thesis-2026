// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// The project/classification/channels command bodies live inside package-level
// `var x = &cobra.Command{Run: func…}` literals, so the only way to execute them is
// to drive the real cobra tree. This file does exactly that against a fake control
// plane, with the committed seams (stdinIsTTY/stdoutIsTTY, exitFunc, confirm,
// runHuhForm, openBrowser) supplying the terminal answers a test process cannot.

// projExit is the sentinel the stubbed exitFunc panics with, so a fatal arm can be
// observed instead of killing the test binary.
type projExit struct{ code int }

// projServer is the mutable fake control plane the TestProj_ suite drives. Each field
// is what the matching endpoint returns; failOn injects a 500 on any request whose
// path contains one of its substrings.
type projServer struct {
	mu     sync.Mutex
	failOn []string
	// configs overrides the project list; nil means the single default project.
	configs []map[string]any
	// designChanges overrides the plan a design apply reports. nil means the default plan,
	// which includes a DELETE; an empty (non-nil) slice is an add-only plan. The distinction
	// is the whole subject of the delete gate, so it has to be expressible.
	designChanges []map[string]any
	// posts records the body of every mutating request, so a test can compare what an
	// ANSWERED FORM sent with what the equivalent flags sent. Two paths that claim to be one
	// spec are only one spec if they put the same bytes on the wire.
	posts       []projPost
	config      map[string]any
	envs        []map[string]any
	comps       []map[string]any
	dims        []map[string]any
	assigns     []map[string]any
	channels    []map[string]any
	jobStatuses []string
	jobIdx      int
	jobErrMsg   string
	jobMeta     map[string]any
}

// jobBody returns the next polled job document, advancing through jobStatuses and
// repeating the last one, so `--wait` sees a real QUEUED→PROCESSING→terminal walk.
func (s *projServer) jobBody() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	status := "SUCCESS"
	if len(s.jobStatuses) > 0 {
		i := s.jobIdx
		if i >= len(s.jobStatuses) {
			i = len(s.jobStatuses) - 1
		}
		s.jobIdx++
		status = s.jobStatuses[i]
	}
	body := map[string]any{
		"id": "j1", "job_type": "PLAN", "status": status,
		"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
		"config_snapshot": map[string]any{},
	}
	if s.jobErrMsg != "" {
		body["error_message"] = s.jobErrMsg
	}
	if s.jobMeta != nil {
		body["execution_metadata"] = s.jobMeta
	}
	return body
}

// shouldFail reports whether this path is one the test asked to 500.
func (s *projServer) shouldFail(path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, f := range s.failOn {
		if strings.Contains(path, f) {
			return true
		}
	}
	return false
}

// snapshot copies the response slices under the lock (the handler runs on the
// server's goroutine while the test mutates the struct between invocations).
func (s *projServer) snapshot() (envs, comps, dims, assigns, channels []map[string]any, config map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.envs, s.comps, s.dims, s.assigns, s.channels, s.config
}

// projPost is one recorded mutating request.
type projPost struct {
	Method string
	Path   string
	Body   map[string]any
	// DryRun marks a request the server treats as write-nothing. `project design apply`
	// preflights its own plan with one, so "a POST happened" stopped being the same statement
	// as "something was written".
	DryRun bool
}

// recordPost notes a mutating request's decoded body. A body that does not decode is recorded
// as nil rather than dropped, so "the request was never made" and "the request was malformed"
// stay distinguishable.
func (s *projServer) recordPost(r *http.Request) {
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return
	}
	var body map[string]any
	if r.Body != nil {
		raw, err := io.ReadAll(r.Body)
		if err == nil && len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.posts = append(s.posts, projPost{
		Method: r.Method, Path: r.URL.Path, Body: body,
		DryRun: r.URL.Query().Get("dry_run") == "1",
	})
}

// lastPost returns the most recent mutating request, or false when none was made.
func (s *projServer) lastPost() (projPost, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.posts) == 0 {
		return projPost{}, false
	}
	return s.posts[len(s.posts)-1], true
}

// forgetPosts clears the record so consecutive runs in one test assert independently.
func (s *projServer) forgetPosts() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.posts = nil
}

func (s *projServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	s.recordPost(r)
	enc := json.NewEncoder(w)
	if s.shouldFail(p) {
		w.WriteHeader(http.StatusInternalServerError)
		_ = enc.Encode(map[string]string{"error": "boom: " + p})
		return
	}
	envs, comps, dims, assigns, channels, config := s.snapshot()
	s.mu.Lock()
	configs, designChanges := s.configs, s.designChanges
	s.mu.Unlock()

	switch {
	case p == "/api/cli/whoami":
		_ = enc.Encode(map[string]any{
			"user":       map[string]any{"id": "u1", "email": "ada@x.com", "name": "Ada"},
			"active_org": map[string]any{"id": "o1", "name": "Acme", "slug": "acme", "role": "owner"},
		})
	case p == "/api/cli/configurations":
		// Overridable so a test can express an empty organization, or two projects sharing a
		// name — neither of which the single-project default can say, and both of which are
		// arms the resolvers must refuse rather than guess through.
		list := configs
		if list == nil {
			list = []map[string]any{
				{"id": "p1", "project_name": "web", "environment_stage": "production", "status": "ACTIVE"},
			}
		}
		_ = enc.Encode(map[string]any{"configurations": list})
	case strings.HasPrefix(p, "/api/cli/configurations/by-project-name/"):
		_ = enc.Encode(map[string]any{"configuration": config})
	case p == "/api/cli/runners":
		_ = enc.Encode(map[string]any{"runners": []map[string]any{
			{"id": "r1", "name": "primary", "operator": "managed", "status": "ONLINE", "is_default": true},
			{"id": "r2", "name": "edge", "operator": "self", "provisioning": "deployed", "status": "DRAINING"},
			{"id": "r3", "name": "old", "operator": "self", "status": "OFFLINE"},
		}})
	case p == "/api/cli/cloud-identities":
		_ = enc.Encode(map[string]any{"cloud_identities": []map[string]any{
			{"id": "ci1", "provider": "aws", "label": "prod-account"},
		}})
	case p == "/api/cli/projects":
		_ = enc.Encode(map[string]any{"project": map[string]any{
			"id": "p1", "project_name": "api", "slug": "api", "region": "eu-west-1",
			"cloud_provider": "aws", "environment_stage": "development", "status": "DRAFT",
			"iac_version": "1.11.4",
		}})
	case strings.HasSuffix(p, "/environments"):
		if r.Method == http.MethodPost {
			_ = enc.Encode(map[string]any{"environment": map[string]any{
				"id": "e9", "name": "staging", "stage": "staging", "status": "DRAFT",
			}})
			return
		}
		_ = enc.Encode(map[string]any{"environments": envs})
	case strings.HasSuffix(p, "/design"):
		// The mode is read back off the query, so a dry run cannot be mistaken for an apply
		// in a test the way it must not be in the product: the CLI prints a different thing
		// for each, and a fake that always said "applied" would let the dry-run arm rot.
		mode := "applied"
		switch {
		case r.URL.Query().Get("dry_run") == "1":
			mode = "dry-run"
		case r.URL.Query().Get("stage") == "1":
			mode = "staged"
		}
		changes := designChanges
		if changes == nil {
			changes = []map[string]any{
				{"kind": "databases", "name": "orders", "action": "UPDATE"},
				{"kind": "storage_buckets", "name": "receipts", "action": "DELETE"},
			}
		}
		_ = enc.Encode(map[string]any{"ok": true, "mode": mode, "changes": changes})
	case strings.Contains(p, "/components"):
		switch r.Method {
		case http.MethodPost:
			_ = enc.Encode(map[string]any{"component": map[string]any{
				"id": "comp1", "kind": "databases", "name": "main", "status": "PENDING",
			}})
		case http.MethodDelete:
			w.WriteHeader(http.StatusOK)
		default:
			_ = enc.Encode(map[string]any{"components": comps})
		}
	case p == "/api/jobs":
		_ = enc.Encode(map[string]any{"job": map[string]any{
			"id": "j1", "job_type": "PLAN", "status": "QUEUED",
			"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
		}})
	case strings.HasPrefix(p, "/api/cli/jobs/"):
		_ = enc.Encode(s.jobBody())
	case strings.HasSuffix(p, "/verify"):
		_ = enc.Encode(map[string]any{"channel": map[string]any{
			"id": "ch1", "name": "ops", "type": "webhook", "is_verified": true, "enabled": true,
		}})
	case p == "/api/cli/channels":
		if r.Method == http.MethodPost {
			_ = enc.Encode(map[string]any{"channel": map[string]any{
				"id": "ch1", "name": "ops", "type": "webhook", "is_verified": true, "enabled": true,
			}})
			return
		}
		_ = enc.Encode(map[string]any{"channels": channels})
	case strings.HasPrefix(p, "/api/cli/channels/"):
		w.WriteHeader(http.StatusOK)
	case p == "/api/cli/classification/dimensions":
		_ = enc.Encode(map[string]any{"dimensions": dims})
	case p == "/api/cli/classification/assignments":
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusOK)
			return
		}
		_ = enc.Encode(map[string]any{"assignments": assigns})
	default:
		w.WriteHeader(http.StatusNotFound)
		_ = enc.Encode(map[string]string{"error": "not found: " + p})
	}
}

// projHarness is one configured CLI-under-test: a runner over the real cobra tree,
// the fake control plane it talks to, and the path of its isolated credentials.
type projHarness struct {
	run   func(args ...string) bool
	srv   *projServer
	creds string
}

// projResetFlags clears every sticky flag target these commands bind to. rootCmd is a
// package global whose parsed flag values survive an Execute, so without this one
// invocation leaks its flags into the next.
func projResetFlags() {
	projectPlanProjectID, projectPlanRunnerID, projectPlanEnv, projectPlanWait = "", "", "", false
	projectApplyProjectID, projectApplyRunnerID, projectApplyPlanJobID = "", "", ""
	projectApplyEnv, projectApplyWait = "", false
	projectDestroyProjectID, projectDestroyRunnerID, projectDestroyEnv, projectDestroyWait = "", "", "", false
	componentListKind = ""
	componentAddKind, componentAddName, componentAddSet = "", "", nil
	componentRemoveKind, componentRemoveName = "", ""
	// `project create`'s flags are generated from projectCreateSpec, so they are reset through the
	// binder that owns them rather than named one by one. That is the point: the list below stopped
	// covering a flag the moment somebody added one without remembering this function, which is what
	// the #3699 note underneath records happening. Reset() zeroes whatever is actually bound.
	//
	// `stage` resets to EMPTY rather than to stageDevelopment because the default is no longer a
	// cobra default — it is applied by spec.Resolve, after the form, so that a form still asks about
	// a field that has one.
	projectCreateBinder.Reset()
	projectEnvStage, projectEnvRegion = string(stageDevelopment), ""
	// Added with #3699. Every one of these leaked between runs before it was listed here, and
	// the symptom was four tests that PASSED alone and FAILED in the suite — a --cloud-account
	// left set by an earlier run silently linking a later project, which is the same class of
	// defect the flags themselves are arranged against.
	projectPlanProjectRef, projectApplyProjectRef, projectDestroyProjectRef = "", "", ""
	projectEnvPlacement, projectEnvFabric = "", ""
	projectEnvNamespace, projectEnvLifecycle = "", ""
	designApplyFile = ""
	designApplyDryRun, designApplyStage, designApplyYes = false, false, false
	componentRemoveYes, projectDestroyYes = false, false
	channelType, channelURL, channelSigningSecret, channelRoutingKey = "", "", "", ""
	channelRecipients = nil
	_ = projectComponentCmd.PersistentFlags().Set("project", "")
	_ = projectEnvCmd.PersistentFlags().Set("project", "")
	_ = projectGetCmd.Flags().Set("open", "false")
	_ = rootCmd.PersistentFlags().Set("output", "table")
	_ = rootCmd.PersistentFlags().Set("no-input", "false")
	projClearChanged(rootCmd)
	execRootArgs(nil)
}

// projClearChanged resets every flag in the tree to its default AND clears cobra's `Changed`
// bit, which the assignments above do not.
//
// `Changed` is not bookkeeping — it is the only way to tell "the caller said `--stage
// development`" from "the flag defaulted to development", and `project env add` asks its
// questions on exactly that distinction. Resetting the VALUE while leaving `Changed` set left
// a later run believing the caller had chosen a stage they never typed: measured, as one test
// that passed alone and failed in the suite because an earlier test had passed --stage.
func projClearChanged(root *cobra.Command) {
	var walk func(*cobra.Command)
	walk = func(c *cobra.Command) {
		reset := func(f *pflag.Flag) {
			if !f.Changed {
				return
			}
			if sv, ok := f.Value.(pflag.SliceValue); ok {
				_ = sv.Replace(nil)
			} else {
				_ = f.Value.Set(f.DefValue)
			}
			f.Changed = false
		}
		c.Flags().VisitAll(reset)
		c.PersistentFlags().VisitAll(reset)
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	walk(root)
}

// projEnv stands up the fake control plane, isolated credentials, and the exit seam,
// then returns a harness whose run() executes the real cobra tree and reports whether
// the invocation took a fatal (exitFunc) arm.
func projEnv(t *testing.T, s *projServer) projHarness {
	t.Helper()
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme"}); err != nil {
		t.Fatalf("SaveCliConfig: %v", err)
	}

	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	prevExit, prevPoll, prevNoInput := exitFunc, jobPollInterval, noInputMode
	exitFunc = func(code int) { panic(projExit{code}) }
	jobPollInterval = time.Millisecond
	projResetFlags()
	t.Cleanup(func() {
		exitFunc, jobPollInterval, noInputMode = prevExit, prevPoll, prevNoInput
		projResetFlags()
	})

	run := func(args ...string) (exited bool) {
		defer func() {
			if r := recover(); r != nil {
				if _, ok := r.(projExit); !ok {
					panic(r)
				}
				exited = true
			}
		}()
		projResetFlags()
		execRootArgs(args)
		if err := rootCmd.Execute(); err != nil {
			t.Errorf("execute %v: %v", args, err)
		}
		return false
	}
	return projHarness{run: run, srv: s, creds: credsPath}
}

// projTTY forces the terminal seams on, which is what makes the `interactiveTable`
// arm of every list command and the huh-backed selectors reachable at all.
//
// noInputMode is SET here, not merely saved. It is derived from stdin rather than bound to a flag,
// so stubbing stdinIsTTY does not change it until the next PersistentPreRun — and the tests that
// call a selector directly never reach one. It was reading whatever the previously-run test file
// had left behind, which is a pass that depends on the alphabet: splitting cov_misc_test.go by
// subject changed which file ran before this one and four subtests here started refusing with
// "--no-input is set".
func projTTY(t *testing.T) {
	t.Helper()
	prevIn, prevOut, prevNoInput := stdinIsTTY, stdoutIsTTY, noInputMode
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return true }
	noInputMode = false
	t.Cleanup(func() {
		stdinIsTTY, stdoutIsTTY, noInputMode = prevIn, prevOut, prevNoInput
	})
}

// projConfirm pins the destructive-command confirmation to a fixed answer; no stub of
// runHuhForm can do this, because huh owns the pointer the answer is written through.
func projConfirm(t *testing.T, answer bool) {
	t.Helper()
	// A destructive command consults noInputMode before it prompts, so the stubbed
	// answer is only reachable with the terminal seams on.
	projTTY(t)
	prev := confirm
	confirm = func(string, string) bool { return answer }
	t.Cleanup(func() { confirm = prev })
}

// projForm makes every huh form succeed without a terminal, so what happens AFTER a
// successful selection (rather than the TTY-error arm) is what runs.
func projForm(t *testing.T) {
	t.Helper()
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return nil }
	t.Cleanup(func() { runHuhForm = prev })
}

// projFormSeq makes runHuhForm answer a fixed sequence of results, so an EARLIER
// selector can succeed while a LATER one fails — which is the only way to reach the
// runner-picker's fatal arm, since a blanket failure stops at the project picker.
// The last entry repeats once the sequence is exhausted.
func projFormSeq(t *testing.T, results ...error) {
	t.Helper()
	prev := runHuhForm
	call := 0
	runHuhForm = func(...*huh.Group) error {
		r := results[len(results)-1]
		if call < len(results) {
			r = results[call]
		}
		call++
		return r
	}
	t.Cleanup(func() { runHuhForm = prev })
}

// projClosedStdout points os.Stdout at an already-closed file. A write error is the
// only way ui.Render/ui.RenderCard can fail, so this is what makes the "rendering the
// result failed" fatal arm reachable at all.
func projClosedStdout(t *testing.T) {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "closed")
	if err != nil {
		t.Fatalf("temp file: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close temp file: %v", err)
	}
	prev := os.Stdout
	os.Stdout = f
	t.Cleanup(func() { os.Stdout = prev })
}

// projNoAuth removes the stored credentials and answers "no" to the login prompt, so
// getAuthToken returns an error and the caller's fatal arm runs.
func projNoAuth(t *testing.T, h projHarness) {
	t.Helper()
	if err := os.Remove(h.creds); err != nil {
		t.Fatalf("remove credentials: %v", err)
	}
	prev := authRequiredPrompt
	authRequiredPrompt = func() (bool, error) { return false, nil }
	t.Cleanup(func() { authRequiredPrompt = prev })
}

// --- fixtures ---

func projSampleComponents() []map[string]any {
	return []map[string]any{
		{"id": "c1", "kind": "databases", "name": "main", "status": "READY", "cloud_identity_id": "ci1"},
		{"id": "c2", "kind": "network", "name": "net", "status": "", "cloud_identity_id": nil},
	}
}

func projSampleEnvs() []map[string]any {
	return []map[string]any{
		{"id": "e1", "name": "production", "stage": "production", "status": "READY", "is_default": true, "region": "eu-west-1"},
		{"id": "e2", "name": "dev", "stage": "development", "status": "DRAFT", "is_default": false, "region": nil},
	}
}

func projSampleDims() []map[string]any {
	return []map[string]any{
		{"id": "d1", "key": "tier", "label": "Tier", "multi": false, "applies_to": []string{"project_environment"},
			"values": []map[string]any{{"id": "v1", "value": "gold", "label": "Gold"}}},
		{"id": "d2", "key": "owner", "label": "Owner", "multi": true, "applies_to": []string{}, "values": []map[string]any{}},
	}
}

func projSampleChannels() []map[string]any {
	return []map[string]any{
		{"id": "ch1", "name": "ops", "type": "webhook", "is_verified": true, "enabled": true},
		{"id": "ch2", "name": "mail", "type": "email", "is_verified": false, "enabled": false},
	}
}

func projSampleConfig() map[string]any {
	return map[string]any{
		"id": "p1", "project_name": "web", "environment_stage": "production",
		"container_platform": "eks", "cloud_account_id": "acct-1", "region": "eu-west-1",
		"iac_version": "1.11.4", "user_id": "u1",
		"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-02-01T00:00:00Z",
	}
}

// --- project component ---

// TestProj_ComponentKinds pins that `project component kinds` renders the kind registry
// in both the table and the json projection.
func TestProj_ComponentKinds(t *testing.T) {
	h := projEnv(t, &projServer{})
	for _, format := range []string{"table", "json", "csv"} {
		if h.run("project", "component", "kinds", "--output", format) {
			t.Errorf("kinds --output %s exited fatally", format)
		}
	}
}

// TestProj_ComponentListInteractive pins the TTY arm of `project component list`: the
// spinner-backed fetch, the populated table, and the empty-list notice.
func TestProj_ComponentListInteractive(t *testing.T) {
	s := &projServer{comps: projSampleComponents()}
	h := projEnv(t, s)
	projTTY(t)

	if h.run("project", "component", "list", "--project", "web", "--output", "table") {
		t.Error("interactive component list exited fatally")
	}
	if h.run("project", "component", "list", "--project", "web", "--kind", "databases", "--output", "table") {
		t.Error("filtered component list exited fatally")
	}
	s.comps = nil
	if h.run("project", "component", "list", "--project", "web", "--output", "table") {
		t.Error("empty component list exited fatally")
	}
}

// TestProj_ComponentListNonInteractive pins the scripting arm (json) and that a server
// error on either arm is fatal.
func TestProj_ComponentListNonInteractive(t *testing.T) {
	s := &projServer{comps: projSampleComponents()}
	h := projEnv(t, s)

	if h.run("project", "component", "list", "--project", "web", "--output", "json") {
		t.Error("json component list exited fatally")
	}
	s.failOn = []string{"/components"}
	if !h.run("project", "component", "list", "--project", "web", "--output", "json") {
		t.Error("json component list should exit on a server error")
	}
	projTTY(t)
	if !h.run("project", "component", "list", "--project", "web", "--output", "table") {
		t.Error("interactive component list should exit on a server error")
	}
}

// TestProj_ComponentListMissingProject pins that --project is required: there is no
// implicit active project, so the command exits rather than guessing one.
func TestProj_ComponentListMissingProject(t *testing.T) {
	h := projEnv(t, &projServer{})
	if !h.run("project", "component", "list", "--output", "json") {
		t.Error("component list without --project should exit")
	}
}

// TestProj_ComponentAdd pins `project component add`: the happy path with typed --set
// values, a malformed --set, a missing --kind, and a server error.
func TestProj_ComponentAdd(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if h.run("project", "component", "add", "--project", "web", "--kind", "databases",
		"--name", "main", "--set", "port=5432", "--set", "engine=postgres", "--output", "json") {
		t.Error("component add exited fatally")
	}
	if !h.run("project", "component", "add", "--project", "web", "--kind", "databases", "--set", "bogus", "--output", "json") {
		t.Error("component add with a malformed --set should exit")
	}
	if !h.run("project", "component", "add", "--project", "web", "--output", "json") {
		t.Error("component add without --kind should exit")
	}
	if !h.run("project", "component", "add", "--output", "json") {
		t.Error("component add without --project should exit")
	}
	s.failOn = []string{"/components"}
	if !h.run("project", "component", "add", "--project", "web", "--kind", "caches", "--name", "r", "--output", "json") {
		t.Error("component add should exit on a server error")
	}
}

// TestProj_ComponentRemove pins `project component remove`: a declined confirmation is a
// no-op, a confirmed one deletes, a missing --kind and a server error are both fatal.
func TestProj_ComponentRemove(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	projConfirm(t, false)
	if h.run("project", "component", "remove", "--project", "web", "--kind", "databases", "--name", "main", "--output", "json") {
		t.Error("declined component remove should not exit")
	}
	if !h.run("project", "component", "remove", "--project", "web", "--output", "json") {
		t.Error("component remove without --kind should exit")
	}
	if !h.run("project", "component", "remove", "--output", "json") {
		t.Error("component remove without --project should exit")
	}

	confirm = func(string, string) bool { return true }
	if h.run("project", "component", "remove", "--project", "web", "--kind", "network", "--output", "json") {
		t.Error("confirmed singleton remove exited fatally")
	}
	if h.run("project", "component", "remove", "--project", "web", "--kind", "databases", "--name", "main", "--output", "json") {
		t.Error("confirmed named remove exited fatally")
	}
	s.failOn = []string{"/components"}
	if !h.run("project", "component", "remove", "--project", "web", "--kind", "databases", "--name", "main", "--output", "json") {
		t.Error("component remove should exit on a server error")
	}
}

// --- project env ---

// TestProj_EnvListInteractive pins the TTY arm of `project env list`, populated and empty.
func TestProj_EnvListInteractive(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)
	projTTY(t)

	if h.run("project", "env", "list", "--project", "web", "--output", "table") {
		t.Error("interactive env list exited fatally")
	}
	s.envs = nil
	if h.run("project", "env", "list", "--project", "web", "--output", "table") {
		t.Error("empty env list exited fatally")
	}
}

// TestProj_EnvListNonInteractive pins the json arm and the fatal server-error arms.
func TestProj_EnvListNonInteractive(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)

	if h.run("project", "env", "list", "--project", "web", "--output", "json") {
		t.Error("json env list exited fatally")
	}
	if !h.run("project", "env", "list", "--output", "json") {
		t.Error("env list without --project should exit")
	}
	s.failOn = []string{"/environments"}
	if !h.run("project", "env", "list", "--project", "web", "--output", "json") {
		t.Error("json env list should exit on a server error")
	}
	projTTY(t)
	if !h.run("project", "env", "list", "--project", "web", "--output", "table") {
		t.Error("interactive env list should exit on a server error")
	}
}

// TestProj_EnvAdd pins `project env add`, including the missing --project and
// server-error fatal arms.
func TestProj_EnvAdd(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if h.run("project", "env", "add", "staging", "--project", "web", "--stage", "staging", "--region", "eu-west-1", "--output", "json") {
		t.Error("env add exited fatally")
	}
	if !h.run("project", "env", "add", "staging", "--output", "json") {
		t.Error("env add without --project should exit")
	}
	s.failOn = []string{"/environments"}
	if !h.run("project", "env", "add", "staging", "--project", "web", "--output", "json") {
		t.Error("env add should exit on a server error")
	}
}

// --- classification ---

// TestProj_ClassificationDimensions pins both render arms of `classification dimensions`
// plus the empty and server-error arms.
func TestProj_ClassificationDimensions(t *testing.T) {
	s := &projServer{dims: projSampleDims()}
	h := projEnv(t, s)

	if h.run("classification", "dimensions", "--output", "json") {
		t.Error("json dimensions exited fatally")
	}
	projTTY(t)
	if h.run("classification", "dimensions", "--output", "table") {
		t.Error("interactive dimensions exited fatally")
	}
	s.dims = nil
	if h.run("classification", "dimensions", "--output", "table") {
		t.Error("empty dimensions exited fatally")
	}
	s.failOn = []string{"/classification/dimensions"}
	if !h.run("classification", "dimensions", "--output", "table") {
		t.Error("interactive dimensions should exit on a server error")
	}
	if !h.run("classification", "dimensions", "--output", "json") {
		t.Error("json dimensions should exit on a server error")
	}
}

// TestProj_ClassificationShow pins `classification show <kind> <id>` on both arms, with
// the not-classified notice and the fatal server error.
func TestProj_ClassificationShow(t *testing.T) {
	s := &projServer{assigns: []map[string]any{
		{"dimension_key": "tier", "dimension_label": "Tier", "value": "gold", "value_label": "Gold"},
	}}
	h := projEnv(t, s)

	if h.run("classification", "show", "project_environment", "e1", "--output", "json") {
		t.Error("json show exited fatally")
	}
	projTTY(t)
	if h.run("classification", "show", "project_environment", "e1", "--output", "table") {
		t.Error("interactive show exited fatally")
	}
	s.assigns = nil
	if h.run("classification", "show", "project_environment", "e1", "--output", "table") {
		t.Error("unclassified show exited fatally")
	}
	s.failOn = []string{"/classification/assignments"}
	if !h.run("classification", "show", "project_environment", "e1", "--output", "table") {
		t.Error("interactive show should exit on a server error")
	}
	if !h.run("classification", "show", "project_environment", "e1", "--output", "json") {
		t.Error("json show should exit on a server error")
	}
}

// TestProj_ClassificationAssignUnassign pins the two mutating classification commands and
// their fatal server-error arms.
func TestProj_ClassificationAssignUnassign(t *testing.T) {
	// `assign` resolves its dimension key and value slug against the org's taxonomy before it
	// posts, so the fake control plane must hold the `tier`/`gold` pair the case names.
	s := &projServer{dims: projSampleDims()}
	h := projEnv(t, s)

	if h.run("classification", "assign", "project_environment", "e1", "tier", "gold", "--output", "json") {
		t.Error("assign exited fatally")
	}
	if h.run("classification", "unassign", "project_environment", "e1", "gold", "--yes", "--output", "json") {
		t.Error("unassign exited fatally")
	}
	s.failOn = []string{"/classification/assignments"}
	if !h.run("classification", "assign", "project_environment", "e1", "tier", "gold", "--output", "json") {
		t.Error("assign should exit on a server error")
	}
	if !h.run("classification", "unassign", "project_environment", "e1", "gold", "--yes", "--output", "json") {
		t.Error("unassign should exit on a server error")
	}
}

// --- channels ---

// TestProj_ChannelsList pins both render arms of `channels list`, the empty notice, and
// the fatal server-error arms.
func TestProj_ChannelsList(t *testing.T) {
	s := &projServer{channels: projSampleChannels()}
	h := projEnv(t, s)

	if h.run("channels", "list", "--output", "json") {
		t.Error("json channels list exited fatally")
	}
	projTTY(t)
	if h.run("channels", "list", "--output", "table") {
		t.Error("interactive channels list exited fatally")
	}
	s.channels = nil
	if h.run("channels", "list", "--output", "table") {
		t.Error("empty channels list exited fatally")
	}
	s.failOn = []string{"/cli/channels"}
	if !h.run("channels", "list", "--output", "table") {
		t.Error("interactive channels list should exit on a server error")
	}
	if !h.run("channels", "list", "--output", "json") {
		t.Error("json channels list should exit on a server error")
	}
}

// TestProj_ChannelsCreateVerify pins `channels create` (every config-carrying flag) and
// `channels verify`, plus both fatal server-error arms.
func TestProj_ChannelsCreateVerify(t *testing.T) {
	// `verify` resolves its argument against the org's channels before calling, so the server
	// must actually hold ch1 — an id nothing lists is now refused before the request.
	s := &projServer{channels: projSampleChannels()}
	h := projEnv(t, s)

	if h.run("channels", "create", "ops", "--type", "webhook", "--url", "https://x/y",
		"--signing-secret", "s3cr3t", "--output", "json") {
		t.Error("channels create exited fatally")
	}
	if h.run("channels", "create", "mail", "--type", "email", "--recipient", "a@x.com",
		"--recipient", "b@x.com", "--output", "json") {
		t.Error("email channel create exited fatally")
	}
	if h.run("channels", "create", "pd", "--type", "pagerduty", "--routing-key", "rk", "--output", "json") {
		t.Error("pagerduty channel create exited fatally")
	}
	if h.run("channels", "verify", "ch1", "--output", "json") {
		t.Error("channels verify exited fatally")
	}
	s.failOn = []string{"/cli/channels"}
	if !h.run("channels", "create", "ops", "--type", "webhook", "--url", "https://x/y", "--output", "json") {
		t.Error("channels create should exit on a server error")
	}
	if !h.run("channels", "verify", "ch1", "--output", "json") {
		t.Error("channels verify should exit on a server error")
	}
}

// TestProj_ChannelsDelete pins that a declined confirmation is a no-op, a confirmed one
// deletes, and a server error is fatal.
func TestProj_ChannelsDelete(t *testing.T) {
	// As in TestProj_ChannelsCreateVerify: `delete` resolves ch1 against the list first, so the
	// confirmation can name the channel it is about to remove.
	s := &projServer{channels: projSampleChannels()}
	h := projEnv(t, s)

	projConfirm(t, false)
	if h.run("channels", "delete", "ch1", "--output", "json") {
		t.Error("declined channel delete should not exit")
	}
	confirm = func(string, string) bool { return true }
	if h.run("channels", "delete", "ch1", "--output", "json") {
		t.Error("confirmed channel delete exited fatally")
	}
	s.failOn = []string{"/cli/channels"}
	if !h.run("channels", "delete", "ch1", "--output", "json") {
		t.Error("channel delete should exit on a server error")
	}
}

// --- project get ---

// TestProj_GetScriptingFormats pins that json/csv emit the record and never reach the
// interactive browser prompt.
func TestProj_GetScriptingFormats(t *testing.T) {
	h := projEnv(t, &projServer{config: projSampleConfig()})
	projTTY(t)
	for _, format := range []string{"json", "csv"} {
		if h.run("project", "get", "web", "--output", format) {
			t.Errorf("project get --output %s exited fatally", format)
		}
	}
}

// TestProj_GetTableOpensBrowser pins the TTY arm: the rendered project, the "open in
// browser?" prompt, and the --open shortcut that skips it.
func TestProj_GetTableOpensBrowser(t *testing.T) {
	h := projEnv(t, &projServer{config: projSampleConfig()})
	projTTY(t)
	projConfirm(t, true)

	opened := []string{}
	prev := openBrowser
	openBrowser = func(url string) error { opened = append(opened, url); return nil }
	t.Cleanup(func() { openBrowser = prev })

	if h.run("project", "get", "web", "--output", "table") {
		t.Error("project get exited fatally")
	}
	if len(opened) != 1 || !strings.HasSuffix(opened[0], "/dashboard") {
		t.Errorf("expected one /dashboard open, got %v", opened)
	}
	if h.run("project", "get", "web", "--open", "--output", "table") {
		t.Error("project get --open exited fatally")
	}
	if len(opened) != 2 {
		t.Errorf("--open should open the browser too, got %v", opened)
	}
}

// TestProj_GetBrowserFailureIsNotFatal pins that a browser that refuses to launch is
// reported but does not fail the command.
func TestProj_GetBrowserFailureIsNotFatal(t *testing.T) {
	h := projEnv(t, &projServer{config: projSampleConfig()})
	projTTY(t)
	prev := openBrowser
	openBrowser = func(string) error { return errBoom }
	t.Cleanup(func() { openBrowser = prev })

	if h.run("project", "get", "web", "--open", "--output", "table") {
		t.Error("a failed browser launch should not be fatal")
	}
}

// TestProj_GetMissingAndError pins the "no project found" notice and the fatal fetch error.
func TestProj_GetMissingAndError(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if h.run("project", "get", "nope", "--output", "table") {
		t.Error("a missing project should not be fatal")
	}
	s.failOn = []string{"by-project-name"}
	if !h.run("project", "get", "web", "--output", "table") {
		t.Error("project get should exit on a fetch error")
	}
}

// --- project create ---

// TestProj_CreateWithFlags pins the fully-flagged create path (no prompting) and the
// fatal server-error arm.
func TestProj_CreateWithFlags(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if h.run("project", "create", "api", "--region", "eu-west-1",
		"--cloud-identity-id", "ci1", "--stage", "development", "--iac-version", "1.11.4", "--output", "json") {
		t.Error("project create exited fatally")
	}
	s.failOn = []string{"/cli/projects"}
	if !h.run("project", "create", "api", "--region", "eu-west-1", "--cloud-identity-id", "ci1", "--output", "json") {
		t.Error("project create should exit on a server error")
	}
}

// TestProj_CreatePromptsOnTTY pins that an omitted --region opens the region form and an
// omitted --cloud-identity-id opens the cloud-account picker when prompting is allowed.
func TestProj_CreatePromptsOnTTY(t *testing.T) {
	h := projEnv(t, &projServer{})
	projTTY(t)
	projForm(t)
	previousPrompt := projectCreatePrompt
	projectCreatePrompt = func(f spec.Field, token, accountRef string) (string, error) {
		if f.Key == "region" {
			return "eu-west-1", nil
		}
		return defaultProjectCreatePrompt(f, token, accountRef)
	}
	t.Cleanup(func() { projectCreatePrompt = previousPrompt })

	if h.run("project", "create", "api", "--output", "json") {
		t.Error("prompted project create exited fatally")
	}
}

// TestProj_CreateRegionPromptFatal pins that a region prompt which cannot run — because
// prompting is disabled — is a hard error rather than an empty region.
func TestProj_CreateRegionPromptFatal(t *testing.T) {
	h := projEnv(t, &projServer{})
	if !h.run("project", "create", "api", "--no-input", "--output", "json") {
		t.Error("project create without --region and without prompts should exit")
	}
}

// --- plan / apply / destroy ---

// TestProj_PlanQueuesJob pins `project plan` with both ids supplied: no selector runs and
// the job is queued.
func TestProj_PlanQueuesJob(t *testing.T) {
	h := projEnv(t, &projServer{})
	if h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--output", "json") {
		t.Error("project plan exited fatally")
	}
}

// TestProj_PlanResolvesEnv pins that --env is resolved to an environment id, and that an
// unknown name is fatal rather than silently targeting the default.
func TestProj_PlanResolvesEnv(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)

	if h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--env", "production", "--output", "json") {
		t.Error("project plan --env exited fatally")
	}
	if !h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--env", "nope", "--output", "json") {
		t.Error("an unknown --env should exit")
	}
}

// TestProj_PlanQueueErrorIsFatal pins that a refused queue call exits non-zero.
func TestProj_PlanQueueErrorIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{failOn: []string{"/api/jobs"}})
	if !h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--output", "json") {
		t.Error("a refused queue call should exit")
	}
}

// TestProj_PlanSelectorsRun pins that omitting both ids runs the project and runner
// pickers, and that a picker which cannot open is fatal.
func TestProj_PlanSelectorsRun(t *testing.T) {
	h := projEnv(t, &projServer{})
	projTTY(t)
	projForm(t)
	if h.run("project", "plan", "--output", "json") {
		t.Error("plan through the pickers exited fatally")
	}

	runHuhForm = func(...*huh.Group) error { return errBoom }
	if !h.run("project", "plan", "--output", "json") {
		t.Error("plan should exit when the project picker cannot run")
	}
}

// TestProj_PlanWaitSucceeds pins `--wait`: the poll loop walks the status changes and
// reports the cost estimate carried in the job's execution metadata.
func TestProj_PlanWaitSucceeds(t *testing.T) {
	h := projEnv(t, &projServer{
		jobStatuses: []string{"QUEUED", "PROCESSING", "SUCCESS"},
		jobMeta:     map[string]any{"cost_breakdown": "42.00 USD"},
	})
	if h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("plan --wait exited fatally on a successful job")
	}
}

// TestProj_PlanWaitFailsIsFatal pins that a FAILED job makes `--wait` exit non-zero and
// surfaces the server's error message.
func TestProj_PlanWaitFailsIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{
		jobStatuses: []string{"CLAIMED", "FAILED"},
		jobErrMsg:   "terraform exploded",
	})
	if !h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("plan --wait should exit on a failed job")
	}
}

// TestProj_PlanWaitCancelledIsFatal pins the CANCELLED terminal state, and the
// unknown-error default when the server reports no message.
func TestProj_PlanWaitCancelledIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{jobStatuses: []string{"CANCELLED"}})
	if !h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("plan --wait should exit on a cancelled job")
	}
	h2 := projEnv(t, &projServer{jobStatuses: []string{"FAILED"}})
	if !h2.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("plan --wait should exit on a failed job with no message")
	}
}

// TestProj_PlanWaitPollErrorIsFatal pins that losing the control plane mid-wait exits
// rather than looping forever.
func TestProj_PlanWaitPollErrorIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{failOn: []string{"/api/cli/jobs/"}})
	if !h.run("project", "plan", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("plan --wait should exit when polling fails")
	}
}

// TestProj_ApplyQueuesJob pins `project apply`, including --plan-job-id and --wait.
func TestProj_ApplyQueuesJob(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)

	if h.run("project", "apply", "--project-id", "p1", "--runner-id", "r1",
		"--plan-job-id", "j0", "--env", "production", "--output", "json") {
		t.Error("project apply exited fatally")
	}
	if h.run("project", "apply", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("project apply --wait exited fatally")
	}
	if !h.run("project", "apply", "--project-id", "p1", "--runner-id", "r1", "--env", "nope", "--output", "json") {
		t.Error("an unknown --env should exit")
	}
}

// TestProj_ApplySelectorsAndQueueError pins apply's picker arms and the refused queue call.
func TestProj_ApplySelectorsAndQueueError(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)
	projTTY(t)
	projForm(t)

	if h.run("project", "apply", "--output", "json") {
		t.Error("apply through the pickers exited fatally")
	}
	runHuhForm = func(...*huh.Group) error { return errBoom }
	if !h.run("project", "apply", "--output", "json") {
		t.Error("apply should exit when the project picker cannot run")
	}
	s.failOn = []string{"/api/jobs"}
	if !h.run("project", "apply", "--project-id", "p1", "--runner-id", "r1", "--output", "json") {
		t.Error("a refused queue call should exit")
	}
}

// TestProj_DestroyDeclined pins that declining the confirmation tears nothing down.
func TestProj_DestroyDeclined(t *testing.T) {
	h := projEnv(t, &projServer{})
	projConfirm(t, false)
	if h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--output", "json") {
		t.Error("a declined destroy should not exit")
	}
}

// TestProj_DestroyConfirmed pins the confirmed destroy path, --env resolution, --wait, and
// the fatal arms for an unknown env and a refused queue call.
func TestProj_DestroyConfirmed(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)
	projConfirm(t, true)

	if h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--env", "production", "--output", "json") {
		t.Error("project destroy exited fatally")
	}
	if h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("project destroy --wait exited fatally")
	}
	if !h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--env", "nope", "--output", "json") {
		t.Error("an unknown --env should exit")
	}
	s.failOn = []string{"/api/jobs"}
	if !h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--output", "json") {
		t.Error("a refused queue call should exit")
	}
}

// TestProj_DestroySelectors pins destroy's project and runner pickers, either succeeding
// or failing to open.
func TestProj_DestroySelectors(t *testing.T) {
	h := projEnv(t, &projServer{})
	projTTY(t)
	projForm(t)
	projConfirm(t, true)

	if h.run("project", "destroy", "--output", "json") {
		t.Error("destroy through the pickers exited fatally")
	}
	runHuhForm = func(...*huh.Group) error { return errBoom }
	if !h.run("project", "destroy", "--output", "json") {
		t.Error("destroy should exit when the project picker cannot run")
	}
}

// TestProj_RunnerPickerFailureIsFatal pins the second selector's fatal arm on all three
// job commands: the project picker answered, but the runner picker could not run, so the
// command exits rather than queueing a job against an unchosen runner.
func TestProj_RunnerPickerFailureIsFatal(t *testing.T) {
	for _, sub := range []string{"plan", "apply", "destroy"} {
		t.Run(sub, func(t *testing.T) {
			h := projEnv(t, &projServer{})
			projTTY(t)
			projConfirm(t, true)
			// The project picker answers, the runner picker refuses.
			projFormSeq(t, nil, errBoom)
			if !h.run("project", sub, "--output", "json") {
				t.Errorf("project %s should exit when the runner picker cannot run", sub)
			}
		})
	}
}

// TestProj_ApplyWaitFailsIsFatal pins that `apply --wait` on a job that ends FAILED exits
// non-zero rather than reporting a successful deploy.
func TestProj_ApplyWaitFailsIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{
		jobStatuses: []string{"PROCESSING", "FAILED"},
		jobErrMsg:   "apply exploded",
	})
	if !h.run("project", "apply", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("apply --wait should exit on a failed job")
	}
}

// TestProj_DestroyWaitFailsIsFatal pins the same for `destroy --wait`.
func TestProj_DestroyWaitFailsIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{jobStatuses: []string{"CANCELLED"}})
	projConfirm(t, true)
	if !h.run("project", "destroy", "--project-id", "p1", "--runner-id", "r1", "--wait", "--output", "json") {
		t.Error("destroy --wait should exit on a cancelled job")
	}
}

// TestProj_ComponentKindsRenderErrorIsFatal pins that a failed write of the kind registry
// is reported and fatal, not swallowed into a silently empty listing.
func TestProj_ComponentKindsRenderErrorIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{})
	projClosedStdout(t)
	if !h.run("project", "component", "kinds", "--output", "json") {
		t.Error("component kinds should exit when the result cannot be written")
	}
}

// TestProj_GetRenderErrorIsFatal pins the same for `project get` on a scripting format:
// a project that cannot be written is an error, not a success with no output.
func TestProj_GetRenderErrorIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{config: projSampleConfig()})
	projClosedStdout(t)
	if !h.run("project", "get", "web", "--output", "json") {
		t.Error("project get should exit when the record cannot be written")
	}
}

// TestProj_UnauthenticatedIsFatal pins the shared first arm of every command in this
// scope: no usable credentials and a declined login prompt exits before any API call.
func TestProj_UnauthenticatedIsFatal(t *testing.T) {
	h := projEnv(t, &projServer{config: projSampleConfig()})
	projNoAuth(t, h)

	cases := [][]string{
		{"project", "component", "list", "--project", "web"},
		{"project", "component", "add", "--project", "web", "--kind", "databases"},
		{"project", "component", "remove", "--project", "web", "--kind", "databases"},
		{"project", "env", "list", "--project", "web"},
		{"project", "env", "add", "staging", "--project", "web"},
		{"project", "get", "web"},
		{"project", "create", "api", "--region", "eu-west-1"},
		{"project", "plan", "--project-id", "p1"},
		{"project", "apply", "--project-id", "p1"},
		{"project", "destroy", "--project-id", "p1"},
		{"classification", "dimensions"},
		{"classification", "show", "project_environment", "e1"},
		{"classification", "assign", "project_environment", "e1", "tier", "gold"},
		{"classification", "unassign", "project_environment", "e1", "gold", "--yes"},
		{"channels", "list"},
		{"channels", "create", "ops", "--type", "webhook", "--url", "https://x/y"},
		{"channels", "verify", "ch1"},
		{"channels", "delete", "ch1"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args[:2], "_"), func(t *testing.T) {
			if !h.run(append(args, "--output", "json")...) {
				t.Errorf("%v should exit when unauthenticated", args)
			}
		})
	}
}

// ════════════════════════════════════════════════════════════════════════════════════════
// The project group's field spec — one spec, four renderings
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Everything below was added with #3699. The tests above drive the command bodies; these
// pin the CONTRACT the group now holds: a reference is a lookup key and never a guess, the
// interactive form and the flag are the same spec, and the docs page is a fourth rendering
// of the same vocabulary rather than a hand-maintained copy of it.

// projFakeLister answers GetConfigurations from a fixed slice, so resolution can be driven
// past cases the fake control plane cannot express — two projects sharing a name, chiefly,
// which is the case that matters and which #3145 permits.
type projFakeLister struct {
	configs []types.ConfigurationSummary
	err     error
}

func (f projFakeLister) GetConfigurations() ([]types.ConfigurationSummary, error) {
	return f.configs, f.err
}

// projFakeIdentities answers GetCloudIdentities from a fixed slice.
type projFakeIdentities struct {
	identities []api.CloudIdentity
	err        error
}

func (f projFakeIdentities) GetCloudIdentities() ([]api.CloudIdentity, error) {
	return f.identities, f.err
}

// TestProj_ResolveProjectIDNeverGuesses is the money test of this lane.
//
// resolveProjectID feeds `configuration_id` on a queued DESTROY. Every arm is named rather
// than counted, and the ambiguous arm asserts what is NOT returned: an id. A resolver that
// picked the first of two same-named projects would satisfy "returns an id without error"
// and would tear down the wrong cluster.
func TestProj_ResolveProjectIDNeverGuesses(t *testing.T) {
	shop := types.ConfigurationSummary{ID: "id-shop", ProjectName: "shop"}
	twinA := types.ConfigurationSummary{ID: "id-twin-a", ProjectName: "twin"}
	twinB := types.ConfigurationSummary{ID: "id-twin-b", ProjectName: "twin"}
	all := []types.ConfigurationSummary{shop, twinA, twinB}

	cases := []struct {
		name    string
		ref     string
		want    string
		wantErr []string // every fragment the error must carry
		listErr error
		configs []types.ConfigurationSummary
	}{
		{name: "empty ref resolves to empty so the caller can prompt", ref: "", want: "", configs: all},
		{name: "a unique name resolves to its id", ref: "shop", want: "id-shop", configs: all},
		{name: "an id passes through", ref: "id-shop", want: "id-shop", configs: all},
		{
			name:    "an unknown name names what does exist",
			ref:     "shopp",
			wantErr: []string{"shopp", "not found", "shop", "twin"},
			configs: all,
		},
		{
			name:    "a shared name is refused, naming BOTH ids",
			ref:     "twin",
			wantErr: []string{"ambiguous", "id-twin-a", "id-twin-b"},
			configs: all,
		},
		{
			name:    "an empty org says how to make a project rather than listing nothing",
			ref:     "shop",
			wantErr: []string{"not found", "alethia project create"},
			configs: nil,
		},
		{
			name:    "a failed list is reported as a failed list",
			ref:     "shop",
			listErr: errProjTestBoom,
			wantErr: []string{"resolve --project", "boom"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveProjectID(projFakeLister{configs: tc.configs, err: tc.listErr}, tc.ref)
			if len(tc.wantErr) == 0 {
				if err != nil {
					t.Fatalf("resolveProjectID(%q) = error %v, want %q", tc.ref, err, tc.want)
				}
				if got != tc.want {
					t.Errorf("resolveProjectID(%q) = %q, want %q", tc.ref, got, tc.want)
				}
				return
			}
			if err == nil {
				t.Fatalf("resolveProjectID(%q) = %q with no error; this value is queued as a DESTROY", tc.ref, got)
			}
			if got != "" {
				t.Errorf("resolveProjectID(%q) returned %q ALONGSIDE an error — a caller reading the id would act on it", tc.ref, got)
			}
			for _, frag := range tc.wantErr {
				if !strings.Contains(err.Error(), frag) {
					t.Errorf("error %q does not mention %q", err.Error(), frag)
				}
			}
		})
	}
}

// errProjTestBoom is the injected list failure.
var errProjTestBoom = errProjBoom{}

type errProjBoom struct{}

func (errProjBoom) Error() string { return "boom" }

// TestProj_ResolveCloudIdentityIDNeverGuesses pins the same discipline for the cloud
// account. Labels are user-chosen, so nothing stops two accounts sharing one; linking a
// project to the wrong cloud account is where its infrastructure gets provisioned.
func TestProj_ResolveCloudIdentityIDNeverGuesses(t *testing.T) {
	all := []api.CloudIdentity{
		{ID: "ci-prod", Label: "prod-account"},
		{ID: "ci-a", Label: "shared"},
		{ID: "ci-b", Label: "shared"},
	}
	cases := []struct {
		name    string
		ref     string
		want    string
		wantErr []string
	}{
		{name: "empty stays empty — a project may be unlinked", ref: "", want: ""},
		{name: "a unique label resolves", ref: "prod-account", want: "ci-prod"},
		{name: "an id passes through", ref: "ci-prod", want: "ci-prod"},
		{name: "an unknown label lists the labels", ref: "staging-account", wantErr: []string{"not found", "prod-account", "shared"}},
		{name: "a shared label is refused, naming both ids", ref: "shared", wantErr: []string{"ambiguous", "ci-a", "ci-b"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveCloudIdentityID(projFakeIdentities{identities: all}, tc.ref)
			if len(tc.wantErr) == 0 {
				if err != nil || got != tc.want {
					t.Fatalf("resolveCloudIdentityID(%q) = (%q, %v), want (%q, nil)", tc.ref, got, err, tc.want)
				}
				return
			}
			if err == nil {
				t.Fatalf("resolveCloudIdentityID(%q) = %q with no error", tc.ref, got)
			}
			for _, frag := range tc.wantErr {
				if !strings.Contains(err.Error(), frag) {
					t.Errorf("error %q does not mention %q", err.Error(), frag)
				}
			}
		})
	}
}

// TestProj_ResolveCloudIdentityIDReportsAFailedList pins the arm the table above cannot
// reach: the fetch itself failing, which must be reported as a fetch failure rather than
// as "no such account".
func TestProj_ResolveCloudIdentityIDReportsAFailedList(t *testing.T) {
	_, err := resolveCloudIdentityID(projFakeIdentities{err: errProjTestBoom}, "prod-account")
	if err == nil || !strings.Contains(err.Error(), "resolve --cloud-account") {
		t.Fatalf("err = %v, want one naming the resolution that failed", err)
	}
}

// TestProj_ProjectRefForPrefersANameOnlyWhenItIsUnique pins the rule that keeps a UUID out
// of the replay line without ever printing an ambiguous command.
func TestProj_ProjectRefForPrefersANameOnlyWhenItIsUnique(t *testing.T) {
	configs := []types.ConfigurationSummary{
		{ID: "id-shop", ProjectName: "shop"},
		{ID: "id-twin-a", ProjectName: "twin"},
		{ID: "id-twin-b", ProjectName: "twin"},
	}
	if got := projectRefFor(configs, "id-shop"); got != "shop" {
		t.Errorf("unique name: got %q, want %q", got, "shop")
	}
	if got := projectRefFor(configs, "id-twin-a"); got != "id-twin-a" {
		t.Errorf("shared name must fall back to the id; got %q", got)
	}
	if got := projectRefFor(configs, "id-unknown"); got != "id-unknown" {
		t.Errorf("an id that is not in the list must come back unchanged; got %q", got)
	}
	// An empty project name is not a name. Preferring it would produce `--project ''`.
	nameless := []types.ConfigurationSummary{{ID: "id-x", ProjectName: ""}}
	if got := projectRefFor(nameless, "id-x"); got != "id-x" {
		t.Errorf("a nameless project must render as its id; got %q", got)
	}
}

// TestProj_ProjectIDForJobRefusesTwoAnswers walks the four flag combinations. Both flags at
// once is the one that matters: they name the same field, and a precedence rule would let a
// caller who believes --project won queue a DESTROY against whatever --project-id held.
func TestProj_ProjectIDForJobRefusesTwoAnswers(t *testing.T) {
	lister := projFakeLister{configs: []types.ConfigurationSummary{{ID: "id-shop", ProjectName: "shop"}}}

	if _, err := projectIDForJob(lister, "tok", "shop", "id-shop"); err == nil {
		t.Error("--project and --project-id together must be refused, even when they agree")
	}
	if _, err := projectIDForJob(lister, "tok", "shop", "id-other"); err == nil {
		t.Error("--project and --project-id together must be refused when they DISAGREE")
	}
	if got, err := projectIDForJob(lister, "tok", "shop", ""); err != nil || got != "id-shop" {
		t.Errorf("--project alone = (%q, %v), want (id-shop, nil)", got, err)
	}
	if got, err := projectIDForJob(lister, "tok", "", "id-raw"); err != nil || got != "id-raw" {
		t.Errorf("--project-id alone must pass through unresolved; got (%q, %v)", got, err)
	}
	// Neither: falls through to the picker, which refuses when prompting is disabled.
	hygCliConfirmSetNoInput(t, true)
	if _, err := projectIDForJob(lister, "tok", "", ""); err == nil {
		t.Error("neither flag with prompting disabled must be an error, not an empty id")
	}
}

// TestProj_ShellQuoteIsRunnableBySh drives a real /bin/sh rather than asserting against a
// second copy of the quoting rules.
//
// A quoting helper tested against my own expectations proves I can restate them. The only
// thing worth knowing is whether a POSIX shell hands the argument back unchanged, so this
// asks one. The embedded-single-quote case is the whole reason the helper is not just
// strconv.Quote — there is no escape for ' inside single quotes, and the '\” dance is the
// only form sh accepts.
func TestProj_ShellQuoteIsRunnableBySh(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skipf("no POSIX sh on PATH: %v", err)
	}
	values := []string{
		"boutique",
		"eu-west-1",
		"prod:production:dedicated",
		`instance_types=["t3.medium"]`,
		"a name with spaces",
		"it's mine",
		"weird$(echo pwned)",
		"back\\slash",
		"*",
		"",
	}
	for _, v := range values {
		t.Run(v, func(t *testing.T) {
			out, err := exec.Command("sh", "-c", "printf %s "+shellQuote(v)).Output()
			if err != nil {
				t.Fatalf("sh refused %s: %v", shellQuote(v), err)
			}
			if string(out) != v {
				t.Errorf("sh read %s as %q, want %q — the replay line would not reproduce the run",
					shellQuote(v), string(out), v)
			}
		})
	}
}

// TestProj_EnvFormAndEnvFlagAreOneSpec is the "one spec, four renderings" claim, proven.
//
// The form collects four answers; envTuple renders them into `--env` syntax; parseEnvMatrix
// — the REAL parser the flag uses, not a copy — reads them back. If the two renderings ever
// disagree about what an environment is, the round trip stops being an identity.
func TestProj_EnvFormAndEnvFlagAreOneSpec(t *testing.T) {
	cases := []struct {
		name    string
		answers envAnswers
		first   bool
	}{
		{"first environment, dedicated", envAnswers{Name: "prod", Stage: "production", PlacementMode: "dedicated"}, true},
		{"later environment, namespace with an explicit namespace", envAnswers{Name: "dev-1", Stage: "development", PlacementMode: "namespace", Namespace: "boutique-dev-1"}, false},
		{"later environment, namespace derived", envAnswers{Name: "dev-2", Stage: "development", PlacementMode: "namespace"}, false},
		{"vcluster", envAnswers{Name: "staging", Stage: "staging", PlacementMode: "vcluster"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := normaliseEnvAnswers(tc.answers)
			tuple, err := envTuple(a)
			if err != nil {
				t.Fatalf("envTuple: %v", err)
			}
			specs, err := parseEnvMatrix([]string{tuple})
			if err != nil {
				t.Fatalf("parseEnvMatrix(%q): %v", tuple, err)
			}
			if len(specs) != 1 {
				t.Fatalf("parseEnvMatrix(%q) returned %d specs, want 1", tuple, len(specs))
			}
			want := envSpecFrom(a, true)
			if specs[0] != want {
				t.Errorf("the form and the flag disagree about %q:\n  flag: %+v\n  form: %+v", tuple, specs[0], want)
			}
		})
	}
}

// TestProj_EnvTupleRefusesAColonRatherThanLying pins the case that would make the replay
// line a plausible command doing something else: a field carrying the tuple's own separator.
func TestProj_EnvTupleRefusesAColonRatherThanLying(t *testing.T) {
	for _, a := range []envAnswers{
		{Name: "a:b", Stage: "development", PlacementMode: "namespace"},
		{Name: "dev", Stage: "development", PlacementMode: "namespace", Namespace: "ns:1"},
	} {
		tuple, err := envTuple(a)
		if err == nil {
			t.Errorf("envTuple(%+v) = %q with no error — that tuple parses into a different environment", a, tuple)
		}
	}
}

// TestProj_NormaliseEnvAnswersDropsANamespaceThatCannotApply pins that a dedicated
// environment carries no destination namespace: it owns a new Fabric, so the field would
// appear in the replay line as though it had an effect.
func TestProj_NormaliseEnvAnswersDropsANamespaceThatCannotApply(t *testing.T) {
	got := normaliseEnvAnswers(envAnswers{Name: " prod ", Stage: " production ", PlacementMode: "dedicated", Namespace: "boutique-prod"})
	if got.Namespace != "" {
		t.Errorf("namespace = %q, want it dropped for a dedicated placement", got.Namespace)
	}
	if got.Name != "prod" || got.Stage != "production" {
		t.Errorf("surrounding whitespace survived: %+v", got)
	}
	kept := normaliseEnvAnswers(envAnswers{Name: "dev", Stage: "development", PlacementMode: "namespace", Namespace: "boutique-dev"})
	if kept.Namespace != "boutique-dev" {
		t.Errorf("namespace = %q, want it kept for a shared placement", kept.Namespace)
	}
}

// TestProj_ParseEnvMatrixRefusesAValueTheServerWouldRefuse pins the local enum check. Both
// halves matter: a bad rung must be refused NAMING the entry it was in, and a good matrix
// must still parse — a validator that refused everything would also pass the first half.
func TestProj_ParseEnvMatrixRefusesAValueTheServerWouldRefuse(t *testing.T) {
	if _, err := parseEnvMatrix([]string{"prod:production:dedicted"}); err == nil {
		t.Error("a mistyped placement rung must be refused locally")
	} else if !strings.Contains(err.Error(), "prod:production:dedicted") || !strings.Contains(err.Error(), "dedicated") {
		t.Errorf("error %q must name the offending --env entry and the allowed set", err)
	}
	if _, err := parseEnvMatrix([]string{"prod:prodution"}); err == nil {
		t.Error("a mistyped stage must be refused locally")
	}
	if _, err := parseEnvMatrix([]string{"prod:production", "dev:development:namespace:boutique-dev"}); err != nil {
		t.Errorf("a valid matrix must still parse: %v", err)
	}
	if _, err := parseEnvMatrix([]string{"prod:production", "prod:development"}); err == nil {
		t.Error("a duplicate environment name must still be refused")
	}
}

// TestProj_EveryPlacementRungIsDescribed keeps the picker's cost annotations complete as the
// generated enum grows. A new rung with no description still appears — the vocabulary is the
// enum's — but a person choosing it would not be told what it costs, which is the one fact
// the picker exists to surface.
func TestProj_EveryPlacementRungIsDescribed(t *testing.T) {
	modes := placementModes()
	if len(modes) == 0 {
		t.Fatal("no placement rungs — the generated enum is not being read, so every assertion here is vacuous")
	}
	for _, m := range modes {
		if strings.TrimSpace(placementDescriptions[m]) == "" {
			t.Errorf("placement rung %q has no description; a picker that offers a rung without saying what it costs is how a dedicated cluster gets chosen by accident", m)
		}
	}
	for m := range placementDescriptions {
		if err := validateOneOf("rung", m, modes); err != nil {
			t.Errorf("placementDescriptions describes %q, which is not a rung any more — delete it", m)
		}
	}
}

// TestProj_PickerOptionsAreTheGeneratedVocabulary pins BOTH halves: the options are wired to
// the generated enum, and the enum is currently these values.
//
// The literal list is the point. Asserting only "the options equal placementModes()" compares
// the code to itself and passes for any vocabulary at all; the literal is what makes a
// changed enum show up in a diff, next to the docs table and the descriptions that have to
// change with it.
func TestProj_PickerOptionsAreTheGeneratedVocabulary(t *testing.T) {
	wantModes := []string{"namespace", "vcluster", "dedicated"}
	wantStages := []string{"development", "staging", "production"}

	if got := placementModes(); !equalStrings(got, wantModes) {
		t.Errorf("the placement vocabulary changed: %v (was %v).\n"+
			"      That is allowed — update this literal, placementDescriptions, and the docs table\n"+
			"      in apps/docs/content/docs/cli/commands/project.mdx together.", got, wantModes)
	}
	if got := environmentStages(); !equalStrings(got, wantStages) {
		t.Errorf("the stage vocabulary changed: %v (was %v). Update this literal and the docs table.", got, wantStages)
	}

	for _, o := range placementSelectOptions() {
		if err := validateOneOf("rung", o.Value, placementModes()); err != nil {
			t.Errorf("the placement picker offers %q, which is not in the generated enum", o.Value)
		}
		if !strings.HasPrefix(o.Key, o.Value) {
			t.Errorf("option label %q does not start with its value %q — the label must not rename the rung", o.Key, o.Value)
		}
	}
	if len(placementSelectOptions()) != len(wantModes) {
		t.Errorf("the picker offers %d rungs, the enum has %d", len(placementSelectOptions()), len(wantModes))
	}
	if len(stageSelectOptions()) != len(wantStages) {
		t.Errorf("the stage picker offers %d stages, the enum has %d", len(stageSelectOptions()), len(wantStages))
	}
}

// equalStrings compares two string slices element-wise, in order.
func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestProj_DefaultPlacementFollowsPosition pins the one rule parseEnvMatrix and the form
// share: the first environment owns the Fabric it provisions, later ones share it.
func TestProj_DefaultPlacementFollowsPosition(t *testing.T) {
	if got := defaultPlacementFor(true); got != "dedicated" {
		t.Errorf("first environment defaults to %q, want dedicated", got)
	}
	if got := defaultPlacementFor(false); got != "namespace" {
		t.Errorf("a later environment defaults to %q, want namespace — the cheap rung", got)
	}
	specs, err := parseEnvMatrix([]string{"prod:production", "dev:development"})
	if err != nil {
		t.Fatalf("parseEnvMatrix: %v", err)
	}
	if specs[0].PlacementMode != defaultPlacementFor(true) || !specs[0].IsDefault {
		t.Errorf("first entry = %+v, want the dedicated default and IsDefault", specs[0])
	}
	if specs[1].PlacementMode != defaultPlacementFor(false) || specs[1].IsDefault {
		t.Errorf("second entry = %+v, want the namespace default and not IsDefault", specs[1])
	}
}

// TestProj_RemovalDescriptionNamesTheComponentAndTheTier pins the confirmation text. A
// confirmation that does not name its object is read as "yes"; the tier is the half that
// matters, because remove touches ONE environment and the default is implicit.
func TestProj_RemovalDescriptionNamesTheComponentAndTheTier(t *testing.T) {
	got := removalDescription("databases", "main", "staging")
	for _, want := range []string{"databases main", "staging"} {
		if !strings.Contains(got, want) {
			t.Errorf("%q does not name %q", got, want)
		}
	}
	// A singleton has no name; naming one would describe a component that does not exist.
	if got := removalDescription("network", "ignored", ""); strings.Contains(got, "ignored") {
		t.Errorf("%q names a singleton's --name, which the server ignores", got)
	}
	if got := removalDescription("network", "", ""); !strings.Contains(got, "default environment") {
		t.Errorf("%q does not say which environment an omitted --env means", got)
	}
}

// TestProj_ComponentReplayLineReproducesTheRun round-trips the answers a form collected
// through the replay line's own arguments and the real --set parser.
func TestProj_ComponentReplayLineReproducesTheRun(t *testing.T) {
	spec := componentAddSpec{
		Kind: "databases", Name: "main", Env: "staging",
		Sets: []string{"engine=postgres", "port=5432", `instance_types=["t3.medium"]`},
	}
	args := componentAddReplayArgs("boutique", spec)
	line := replayLine(args...)
	for _, want := range []string{"--kind databases", "--name main", "--env staging", "--project boutique"} {
		if !strings.Contains(line, want) {
			t.Errorf("replay line %q is missing %q", line, want)
		}
	}
	// Every --set the run used must be back in the line, and parse back to the same fields.
	var sets []string
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "--set" {
			sets = append(sets, args[i+1])
		}
	}
	want, err := parseSetValues(spec.Sets)
	if err != nil {
		t.Fatalf("parseSetValues: %v", err)
	}
	got, err := parseSetValues(sets)
	if err != nil {
		t.Fatalf("parseSetValues(replayed): %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("replayed %d fields, the run set %d", len(got), len(want))
	}
	// reflect.DeepEqual, not !=: a JSON array decodes to []interface{}, which is
	// uncomparable, and == on it panics rather than reporting a difference. The array case
	// is the one worth testing, because it is the one whose shell quoting could go wrong.
	for k, v := range want {
		if !reflect.DeepEqual(got[k], v) {
			t.Errorf("field %q replayed as %#v, the run set %#v", k, got[k], v)
		}
	}

	// A singleton carries no --name: the server ignores it, so printing one would tell the
	// reader it did something.
	single := componentAddReplayArgs("boutique", componentAddSpec{Kind: "cluster"})
	if strings.Contains(replayLine(single...), "--name") {
		t.Errorf("singleton replay line carries --name: %q", replayLine(single...))
	}
}

// TestProj_ComponentKindOptionsSayWhichNeedAName pins that the picker answers the question
// its next prompt depends on, and that it offers the whole cached registry.
func TestProj_ComponentKindOptionsSayWhichNeedAName(t *testing.T) {
	opts := componentKindOptions("")
	if len(opts) != len(componentKinds) {
		t.Fatalf("the kind picker offers %d of %d kinds", len(opts), len(componentKinds))
	}
	if len(opts) == 0 {
		t.Fatal("no component kinds — every assertion here is vacuous")
	}
	for _, o := range opts {
		want := "multi"
		if singletonKinds[o.Value] {
			want = "singleton"
		}
		if !strings.Contains(o.Key, want) {
			t.Errorf("kind %q is offered as %q, which does not say it is a %s", o.Value, o.Key, want)
		}
	}

	// A kind the cache has not caught up with is still offered, because huh writes its FIRST
	// option back through the bound pointer when the seed matches none of them — so a picker
	// that dropped the seed would turn `--kind helm_registries` into a `network` component.
	// componentKinds is documented as a cache the server registry has already drifted from,
	// and the escape hatch is only real if the picker cannot silently overwrite it.
	seeded := componentKindOptions("helm_registries")
	if len(seeded) != len(componentKinds)+1 {
		t.Fatalf("a seed outside the cache produced %d options, want %d", len(seeded), len(componentKinds)+1)
	}
	if got := seeded[len(seeded)-1].Value; got != "helm_registries" {
		t.Errorf("the seed is offered as %q, want it verbatim", got)
	}
	// A seed the cache DOES hold is not offered twice.
	if got := componentKindOptions("databases"); len(got) != len(componentKinds) {
		t.Errorf("a cached seed produced %d options, want %d", len(got), len(componentKinds))
	}
}

// TestProj_SetsSoFarDistinguishesNothingSetFromSomething pins the loop's prompt: an empty
// list must not render as an empty "So far:", which reads as a bug rather than a state.
func TestProj_SetsSoFarDistinguishesNothingSetFromSomething(t *testing.T) {
	if got := setsSoFar(nil); !strings.Contains(got, "Nothing set") {
		t.Errorf("empty description = %q", got)
	}
	if got := setsSoFar([]string{"engine=postgres"}); !strings.Contains(got, "engine=postgres") {
		t.Errorf("populated description = %q, want it to name what is set", got)
	}
}

// TestProj_PrintReplayIsSilentUnlessItHasSomethingToSay pins both gates. The format gate is
// the load-bearing one: prose in a --output json stream corrupts the document the caller is
// piping into jq.
func TestProj_PrintReplayIsSilentUnlessItHasSomethingToSay(t *testing.T) {
	render := func(format string, asked bool) string {
		var b strings.Builder
		printReplay(&b, format, asked, "alethia", "project", "list")
		return b.String()
	}
	if got := render(ui.FormatTable, false); got != "" {
		t.Errorf("a run that asked nothing printed %q", got)
	}
	if got := render(ui.FormatJSON, true); got != "" {
		t.Errorf("prose leaked into a json stream: %q", got)
	}
	if got := render(ui.FormatCSV, true); got != "" {
		t.Errorf("prose leaked into a csv stream: %q", got)
	}
	got := render(ui.FormatTable, true)
	if !strings.Contains(got, "alethia project list") {
		t.Errorf("the replay line was not printed for an interactive table run: %q", got)
	}
}

// TestProj_EnvAddReplayArgsOmitWhatWasNotSet pins that the printed line is the SHORTEST one
// that reproduces the run, not a transcript of every flag the command has.
func TestProj_EnvAddReplayArgsOmitWhatWasNotSet(t *testing.T) {
	line := replayLine(envAddReplayArgs("boutique",
		envAnswers{Name: "dev-1", Stage: "development", PlacementMode: "namespace"}, "", "", "")...)
	for _, want := range []string{"env add dev-1", "--project boutique", "--stage development", "--placement-mode namespace"} {
		if !strings.Contains(line, want) {
			t.Errorf("%q is missing %q", line, want)
		}
	}
	for _, unwanted := range []string{"--region", "--fabric", "--lifecycle", "--namespace"} {
		if strings.Contains(line, unwanted) {
			t.Errorf("%q names %s, which the run never set", line, unwanted)
		}
	}
	full := replayLine(envAddReplayArgs("boutique",
		envAnswers{Name: "dev-1", Stage: "development", PlacementMode: "namespace", Namespace: "boutique-dev-1"},
		"eu-west-1", "shared", "ephemeral")...)
	for _, want := range []string{"--namespace boutique-dev-1", "--region eu-west-1", "--fabric shared", "--lifecycle ephemeral"} {
		if !strings.Contains(full, want) {
			t.Errorf("%q is missing %q", full, want)
		}
	}
}

// TestProj_CreateReplayPrefersTheLabelOverTheId pins the whole point of --cloud-account: the
// line a person is invited to commit must not carry the identity UUID when a label was used.
func TestProj_CreateReplayPrefersTheLabelOverTheId(t *testing.T) {
	// A label resolves to an id, and only ONE of the two flags may be passed (the command
	// refuses both), so the label is what the replay names.
	withLabel := replayLine(createReplayArgs(
		api.CreateProjectParams{ProjectName: "boutique", Region: "eu-west-1", CloudIdentityID: "ci-uuid-1"},
		"prod-account", nil)...)
	if strings.Contains(withLabel, "ci-uuid-1") {
		t.Errorf("%q carries the resolved id although a label was given", withLabel)
	}
	if !strings.Contains(withLabel, "--cloud-account prod-account") {
		t.Errorf("%q does not carry the label", withLabel)
	}
	// The picker returns an id and there is no label, so the id is all we have. Printing it
	// is honest; printing nothing would produce a command that creates an unlinked project.
	fromPicker := replayLine(createReplayArgs(
		api.CreateProjectParams{ProjectName: "boutique", Region: "eu-west-1", CloudIdentityID: "ci-uuid-1"},
		"", nil)...)
	if !strings.Contains(fromPicker, "--cloud-identity-id ci-uuid-1") {
		t.Errorf("%q dropped the only account reference there was", fromPicker)
	}
	withEnvs := replayLine(createReplayArgs(
		api.CreateProjectParams{ProjectName: "boutique", Region: "eu-west-1"},
		"prod-account", []string{"prod:production:dedicated", "dev-1:development:namespace:boutique-dev-1"})...)
	if strings.Count(withEnvs, "--env ") != 2 {
		t.Errorf("%q does not carry both --env entries", withEnvs)
	}
}

// TestProj_CreateReplayNamesEveryFlagThatShapedTheProject pins the other half of a replay
// line: it must reproduce the run, not just avoid printing a UUID.
//
// --stage, --placement-mode and --iac-version are each sent in the create payload and each
// change the project that comes out. A line that dropped them told the reader to commit a
// command producing a `development` project on the server's default placement with an
// unpinned OpenTofu version — a different project, presented as the same one.
func TestProj_CreateReplayNamesEveryFlagThatShapedTheProject(t *testing.T) {
	line := replayLine(createReplayArgs(api.CreateProjectParams{
		ProjectName: "boutique",
		Region:      "eu-west-1",
		Stage:       "production",
		Placement:   "dedicated",
		IacVersion:  "1.8.2",
	}, "", nil)...)
	for _, want := range []string{
		"--region eu-west-1", "--stage production", "--placement-mode dedicated", "--iac-version 1.8.2",
	} {
		if !strings.Contains(line, want) {
			t.Errorf("%q is missing %q, so running it would not reproduce the project", line, want)
		}
	}
	// What was not passed is not invented: the server defaults these, and naming a default
	// the caller never chose pins it into a script that would then stop tracking the server.
	bare := replayLine(createReplayArgs(
		api.CreateProjectParams{ProjectName: "boutique", Region: "eu-west-1"}, "", nil)...)
	for _, unwanted := range []string{"--stage", "--placement-mode", "--iac-version"} {
		if strings.Contains(bare, unwanted) {
			t.Errorf("%q names %s although nothing set it", bare, unwanted)
		}
	}
}

// ════════════════════════════════════════════════════════════════════════════════════════
// The derived guards
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Each of these DERIVES its subject from the command tree or from the docs file, because a
// hand-written list of what a guard watches stops covering silently — that is how three
// destructive commands shipped with no confirmation behind a test called "every destructive
// command offers --yes".
//
// The invocation table below is data, not the definition of the set: the set is walked out
// of rootCmd, and a project leaf with no entry FAILS rather than being skipped.

// projectLeafSpec is how to drive one leaf of the project group two ways.
//
//   - `interactive` is the shortest invocation that should ASK something on a terminal.
//   - `scripted` is the same command said entirely in flags, which must ask NOTHING and
//     succeed with --no-input.
//
// A leaf that takes no input at all sets asks=false and gives only `scripted`.
type projectLeafSpec struct {
	interactive []string
	scripted    []string
	asks        bool
	why         string // required when asks is false
}

var projectLeafSpecs = map[string][]projectLeafSpec{
	"alethia project list": {{
		scripted: []string{"project", "list"},
		why:      "reads every project in the active org; there is nothing to ask",
	}},
	"alethia project get": {{
		interactive: []string{"project", "get"},
		scripted:    []string{"project", "get", "web"},
		asks:        true,
	}},
	"alethia project create": {{
		interactive: []string{"project", "create"},
		scripted: []string{"project", "create", "api", "--region", "eu-west-1",
			"--cloud-account", "prod-account", "--stage", "development",
			"--placement-mode", "dedicated", "--iac-version", "1.11.4",
			"--env", "prod:production:dedicated", "--env", "dev:development:namespace:api-dev"},
		asks: true,
	}},
	"alethia project plan": {{
		interactive: []string{"project", "plan"},
		scripted:    []string{"project", "plan", "--project", "web", "--runner-id", "r1", "--env", "production"},
		asks:        true,
	}},
	"alethia project apply": {{
		interactive: []string{"project", "apply"},
		scripted:    []string{"project", "apply", "--project", "web", "--runner-id", "r1", "--env", "production", "--plan-job-id", "j0"},
		asks:        true,
	}},
	"alethia project destroy": {{
		interactive: []string{"project", "destroy"},
		scripted:    []string{"project", "destroy", "--project", "web", "--runner-id", "r1", "--env", "production", "--yes"},
		asks:        true,
	}},
	"alethia project env list": {{
		interactive: []string{"project", "env", "list"},
		scripted:    []string{"project", "env", "list", "--project", "web"},
		asks:        true,
	}},
	"alethia project env add": {{
		interactive: []string{"project", "env", "add", "--project", "web"},
		scripted: []string{"project", "env", "add", "staging", "--project", "web",
			"--stage", "staging", "--placement-mode", "namespace", "--namespace", "web-staging",
			"--region", "eu-west-1", "--fabric", "shared", "--lifecycle", "persistent"},
		asks: true,
	}},
	"alethia project component kinds": {{
		scripted: []string{"project", "component", "kinds"},
		why:      "renders the cached kind registry; it takes no input at all",
	}},
	"alethia project component list": {{
		interactive: []string{"project", "component", "list"},
		scripted:    []string{"project", "component", "list", "--project", "web", "--kind", "databases", "--env", "production"},
		asks:        true,
	}},
	"alethia project component add": {{
		interactive: []string{"project", "component", "add", "--project", "web"},
		scripted: []string{"project", "component", "add", "--project", "web", "--kind", "databases",
			"--name", "main", "--env", "production", "--set", "engine=postgres"},
		asks: true,
	}},
	"alethia project component remove": {{
		interactive: []string{"project", "component", "remove", "--project", "web"},
		scripted: []string{"project", "component", "remove", "--project", "web", "--kind", "databases",
			"--name", "main", "--env", "production", "--yes"},
		asks: true,
	}},
	"alethia project design apply": {{
		interactive: []string{"project", "design", "apply", "--project", "web"},
		scripted:    []string{"project", "design", "apply", "--project", "web", "--env", "production", "--file", projDesignDocSentinel, "--dry-run"},
		asks:        true,
	}},
}

// projDesignDocSentinel stands in for a design document path in the table above; projRunArgs
// swaps it for a real file. The table is data a reader compares against the docs page, so a
// t.TempDir() path baked into it would make it unreadable.
const projDesignDocSentinel = "@design-document"

// projRunArgs materialises the sentinel into a temp file holding an empty design document.
func projRunArgs(t *testing.T, args []string) []string {
	t.Helper()
	out := append([]string{}, args...)
	for i, a := range out {
		if a != projDesignDocSentinel {
			continue
		}
		path := filepath.Join(t.TempDir(), "design.json")
		if err := os.WriteFile(path, []byte(`{"components":[]}`), 0o600); err != nil {
			t.Fatalf("write design document: %v", err)
		}
		out[i] = path
	}
	return out
}

// projectLeaves walks the project group's runnable leaves out of the real command tree.
func projectLeaves(t *testing.T) []*cobra.Command {
	t.Helper()
	var out []*cobra.Command
	for _, c := range walkLeaves(rootCmd) {
		if strings.HasPrefix(c.CommandPath(), "alethia project") {
			out = append(out, c)
		}
	}
	// Vacuity: a walk that finds nothing would pass every assertion below having checked
	// none of them, and the whole reason the set is derived is that nobody has to remember
	// to extend it.
	if len(out) < 10 {
		t.Fatalf("walked only %d project leaves; the group has thirteen, so this walk is not "+
			"seeing the tree and every assertion below is vacuous", len(out))
	}
	return out
}

// TestHygCliProject_EveryLeafIsClassified fails when a project leaf has no entry in the
// table above — which is what makes the table data rather than the definition of the set.
func TestHygCliProject_EveryLeafIsClassified(t *testing.T) {
	known := map[string]bool{}
	for _, c := range projectLeaves(t) {
		path := c.CommandPath()
		known[path] = true
		specs, ok := projectLeafSpecs[path]
		if !ok {
			t.Errorf("%s is a project leaf with no entry in projectLeafSpecs.\n"+
				"      Add one: `interactive` is the shortest invocation that should ASK something,\n"+
				"      `scripted` is the same command said entirely in flags. A leaf that takes no\n"+
				"      input sets asks=false and says why.", path)
			continue
		}
		for _, s := range specs {
			if !s.asks && strings.TrimSpace(s.why) == "" {
				t.Errorf("%s claims to take no input with no reason given", path)
			}
			if s.asks && len(s.interactive) == 0 {
				t.Errorf("%s claims to ask but names no interactive invocation", path)
			}
			if len(s.scripted) == 0 {
				t.Errorf("%s names no scripted invocation; the --no-input contract cannot be checked", path)
			}
		}
	}
	for path := range projectLeafSpecs {
		if !known[path] {
			t.Errorf("projectLeafSpecs describes %q, which is not a project leaf any more — delete it", path)
		}
	}
}

// projFormCounter replaces runHuhForm with one that counts how many forms were OPENED and
// answers none of them. Counting the opens is the observable that matters here: huh writes
// an answer through a pointer it owns, so no stub can supply one, but "a form was put in
// front of the user" is exactly what an interactive path IS.
func projFormCounter(t *testing.T) *int {
	t.Helper()
	opened := 0
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { opened++; return nil }
	t.Cleanup(func() { runHuhForm = prev })
	return &opened
}

// TestHygCliProject_EveryLeafTakingInputAsksForIt is the form-coverage guard.
//
// Before this lane, `project component add` — the command that authors a project's actual
// infrastructure — was flag-or-nothing, and `--project` was a hard error on five leaves
// rather than a question. The epic's `cli_ux` ratchet counts form coverage; this is the
// project group's half of it, derived rather than tallied.
//
// BOUNDARY, stated because an unstated one is how a guard gets believed past its reach: this
// asserts a leaf ASKS SOMETHING, not that it asks for everything. `project create` puts four
// questions and a leaf that lost one of them would still open a form and still pass here. The
// per-field claim is held instead by TestHygCliProject_EveryLeafThatAsksCanBeScripted (the
// flags are complete) and by TestHygCliProject_DocsNameEveryFlag (the fields are all named);
// proven by mutation — removing `project create`'s ability to ask at all turns this red.
func TestHygCliProject_EveryLeafTakingInputAsksForIt(t *testing.T) {
	for _, c := range projectLeaves(t) {
		for _, spec := range projectLeafSpecs[c.CommandPath()] {
			if !spec.asks {
				continue
			}
			t.Run(strings.ReplaceAll(c.CommandPath(), " ", "_"), func(t *testing.T) {
				h := projEnv(t, &projServer{})
				projTTY(t)
				opened := projFormCounter(t)
				// The exit code is not asserted: an unanswered form leaves the command with
				// nothing to act on, so most of these take a fatal arm. What is asserted is
				// that a question was PUT, which is the thing that did not exist before.
				h.run(projRunArgs(t, spec.interactive)...)
				if *opened == 0 {
					t.Errorf("%s opened no form for %v.\n"+
						"      Every leaf that takes input gets an interactive path: omitted on a\n"+
						"      terminal, the value is asked for rather than refused.", c.CommandPath(), spec.interactive)
				}
			})
		}
	}
}

// TestHygCliProject_EveryLeafThatAsksCanBeScripted is the other half, and the one that keeps
// the flags a COMPLETE contract: said entirely in flags, no leaf asks anything, and none of
// them needs a terminal.
//
// A form that could collect something no flag can set would pass the test above and silently
// break `--no-input`. This is what stops that.
func TestHygCliProject_EveryLeafThatAsksCanBeScripted(t *testing.T) {
	for _, c := range projectLeaves(t) {
		for _, spec := range projectLeafSpecs[c.CommandPath()] {
			t.Run(strings.ReplaceAll(c.CommandPath(), " ", "_"), func(t *testing.T) {
				h := projEnv(t, &projServer{config: projSampleConfig(), envs: projSampleEnvs()})
				opened := projFormCounter(t)
				args := append(projRunArgs(t, spec.scripted), "--no-input")
				if exited := h.run(args...); exited {
					t.Errorf("%s exited fatally for the fully-flagged %v — the flags are not a complete contract",
						c.CommandPath(), spec.scripted)
				}
				if *opened != 0 {
					t.Errorf("%s opened %d form(s) for a fully-flagged, --no-input run of %v",
						c.CommandPath(), *opened, spec.scripted)
				}
			})
		}
	}
}

// ── the docs page as a fourth rendering ─────────────────────────────────────────────────

// projectDocsPath is the group's docs page, which the issue puts in this lane's scope
// deliberately: a group whose commands change and whose page does not is how the
// `<placeholder>` handoffs survive.
const projectDocsPath = "../../../apps/docs/content/docs/cli/commands/project.mdx"

// readProjectDocs loads the page, failing loudly rather than treating an unreadable file as
// an empty one — a guard whose "nothing found" branch is the same as its "nothing wrong"
// branch reports green on a file it never opened.
func readProjectDocs(t *testing.T) string {
	t.Helper()
	body, err := os.ReadFile(projectDocsPath)
	if err != nil {
		t.Fatalf("read %s: %v", projectDocsPath, err)
	}
	if len(body) < 2000 {
		t.Fatalf("%s is %d bytes — too short to be the project page, so every assertion below is vacuous",
			projectDocsPath, len(body))
	}
	return string(body)
}

// projectGlobalFlag reports whether a flag is one this group is responsible for documenting.
//
// Two exclusions, both derived rather than listed. rootCmd's persistent flags (--output,
// --no-input, --org) belong to the shell and are documented once at the top of the page.
// `--help` is generated by cobra on every command in every CLI ever written with it, and a
// per-page table restating it teaches nobody anything — it is excluded by name because
// cobra gives it no other marker, and the guard's own output named it, which is the guard
// working.
func projectGlobalFlag(name string) bool {
	return name == "help" || rootCmd.PersistentFlags().Lookup(name) != nil
}

// TestHygCliProject_DocsNameEveryFlag walks the group's real flags and fails on one the page
// does not mention. One field spec, four renderings: this is the fourth.
func TestHygCliProject_DocsNameEveryFlag(t *testing.T) {
	docs := readProjectDocs(t)
	checked := 0
	for _, c := range projectLeaves(t) {
		c.Flags().VisitAll(func(f *pflag.Flag) {
			if projectGlobalFlag(f.Name) {
				return
			}
			checked++
			if !strings.Contains(docs, "`--"+f.Name+"`") {
				t.Errorf("%s takes --%s and %s never names it.\n"+
					"      A flag a person cannot find is a flag that does not exist. Add it to the\n"+
					"      command's table, in backticks.", c.CommandPath(), f.Name, projectDocsPath)
			}
		})
	}
	// Vacuity: the walk above finding no flags would pass having checked nothing.
	if checked < 20 {
		t.Fatalf("checked only %d flags across the project group; it has well over twenty, so the "+
			"walk is not seeing them", checked)
	}
}

// projectDocsFlagRe finds every long flag the page mentions in backticks.
var projectDocsFlagRe = regexp.MustCompile("`--([a-z][a-z0-9-]*)`")

// TestHygCliProject_DocsNameNoFlagThatDoesNotExist is the other direction: a flag the page
// promises and the binary does not have is worse than an undocumented one, because the
// reader types it and gets "unknown flag".
func TestHygCliProject_DocsNameNoFlagThatDoesNotExist(t *testing.T) {
	docs := readProjectDocs(t)
	// The whole tree, not just the project group: the page legitimately shows neighbouring
	// commands (`alethia config export --out …`) while explaining how a document is produced.
	exists := map[string]bool{}
	var walk func(*cobra.Command)
	walk = func(c *cobra.Command) {
		c.Flags().VisitAll(func(f *pflag.Flag) { exists[f.Name] = true })
		c.PersistentFlags().VisitAll(func(f *pflag.Flag) { exists[f.Name] = true })
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	walk(rootCmd)
	if len(exists) < 50 {
		t.Fatalf("collected only %d flag names from the tree — the walk is not seeing it", len(exists))
	}

	matches := projectDocsFlagRe.FindAllStringSubmatch(docs, -1)
	if len(matches) < 20 {
		t.Fatalf("found only %d backticked flags in %s — the pattern is not matching the page",
			len(matches), projectDocsPath)
	}
	for _, m := range matches {
		if !exists[m[1]] {
			t.Errorf("%s documents --%s, which no command in the binary has", projectDocsPath, m[1])
		}
	}
}

// TestHygCliProject_DocsSpeakTheGeneratedVocabulary holds the docs page to the same generated
// enums the flag help and the picker are built from, so a new placement rung or stage cannot
// reach the product with the page still describing the old set.
//
// BOUNDARY: it asserts the PAGE names each value, not that a particular table lists it — a
// value mentioned in prose satisfies it. Mutation-proving this made the boundary visible:
// replacing ONE of several `vcluster` mentions leaves the guard green, and correctly so,
// because the claim it makes is still true. Tightening it to "the placement table's row" means
// parsing the tables, which trades a sound cheap question for a brittle precise one.
func TestHygCliProject_DocsSpeakTheGeneratedVocabulary(t *testing.T) {
	docs := readProjectDocs(t)
	vocab := append(placementModes(), environmentStages()...)
	if len(vocab) < 6 {
		t.Fatalf("read only %d vocabulary values from the generated enums — they are not being read", len(vocab))
	}
	for _, v := range vocab {
		if !strings.Contains(docs, "`"+v+"`") {
			t.Errorf("%s never names the value %q in backticks.\n"+
				"      It comes from packages/core/types/enums_gen.go, which the flag help and the\n"+
				"      interactive picker already read. The page is the one rendering that does not\n"+
				"      update itself.", projectDocsPath, v)
		}
	}
}

// projectDocsFenceRe matches every fenced code block on the page.
var projectDocsFenceRe = regexp.MustCompile("(?s)```[a-z]*\n(.*?)```")

// projectDocsHandoffRe matches a `<placeholder>` token.
var projectDocsHandoffRe = regexp.MustCompile(`<[a-z][a-z_-]*>`)

// TestHygCliProject_NoHandoffSurvivesInAnExample is the handoff census, and the number the
// epic's `cli_ux` ratchet counts for this page.
//
// A HANDOFF is a `<placeholder>` inside an example a reader would COPY — a token they must
// fill from a previous command's output. `--cloud-identity-id <your-identity-id>` is the one
// the whole programme was started over. A placeholder in a flag-SPEC table is not a handoff:
// `[project_name]` there is the argument's name, which is what a spec table is for.
//
// Vacuity is checked in both directions: the scanner must find blocks, and it must be able to
// see a handoff at all — a regex that matched nothing would report this page perfect and
// would report the OLD page perfect too.
//
// BOUNDARY: it reads the FENCED BLOCKS only. A handoff in prose is not caught, and neither is
// a bare `id` used as a literal value. What is caught is the shape the tutorial actually
// carried — a copyable command line with a token to fill in.
func TestHygCliProject_NoHandoffSurvivesInAnExample(t *testing.T) {
	docs := readProjectDocs(t)
	blocks := projectDocsFenceRe.FindAllStringSubmatch(docs, -1)
	if len(blocks) < 8 {
		t.Fatalf("found only %d fenced blocks in %s — the scanner is not seeing the examples",
			len(blocks), projectDocsPath)
	}
	// The scanner can see one. Without this, a broken pattern reports every page clean.
	if !projectDocsHandoffRe.MatchString("alethia project create x --cloud-identity-id <your-identity-id>") {
		t.Fatal("the handoff pattern does not match the very line this lane exists to delete")
	}

	found := 0
	for _, b := range blocks {
		for _, tok := range projectDocsHandoffRe.FindAllString(b[1], -1) {
			found++
			t.Errorf("%s: the copyable example contains the handoff %s.\n"+
				"      A token a reader must copy from another command's output is the thing this\n"+
				"      programme exists to remove. Name it: --project boutique, --cloud-account\n"+
				"      prod-account. The command takes the name.\n      In: %s",
				projectDocsPath, tok, strings.TrimSpace(b[1]))
		}
	}
	if found > 0 {
		t.Logf("%d handoff(s) remain; this count may only decrease", found)
	}
}

// ── the interactive loops, driven through their seams ───────────────────────────────────
//
// These are the branches nothing could reach before the seams existed: a SECOND environment,
// a second --set field, the running summary, and the refusals inside a loop. Measured: huh
// writes an answer through a pointer it owns, and driving a multi-field group with synthetic
// key messages leaves focus on the first field — so a runHuhForm stub can open a form and
// can never answer one.

// projScriptYesNo answers the yes/no questions in order; the last answer repeats, so a loop
// that asks once more than the script expects terminates instead of hanging the suite.
func projScriptYesNo(t *testing.T, answers ...bool) *[]string {
	t.Helper()
	asked := []string{}
	prev := askYesNo
	i := 0
	askYesNo = func(title, _ string) (bool, error) {
		asked = append(asked, title)
		a := answers[len(answers)-1]
		if i < len(answers) {
			a = answers[i]
		}
		i++
		return a, nil
	}
	t.Cleanup(func() { askYesNo = prev })
	return &asked
}

// projScriptEnvSpecs answers the environment question with a fixed sequence, recording the
// isFirst flag it was asked with — which is the input the placement default turns on.
func projScriptEnvSpecs(t *testing.T, specs ...envAnswers) *[]bool {
	t.Helper()
	firsts := []bool{}
	prev := askEnvironmentSpec
	i := 0
	askEnvironmentSpec = func(a *envAnswers, isFirst bool) error {
		firsts = append(firsts, isFirst)
		if i >= len(specs) {
			return fmt.Errorf("the matrix loop asked for environment %d and the script has %d", i+1, len(specs))
		}
		*a = normaliseEnvAnswers(specs[i])
		i++
		return nil
	}
	t.Cleanup(func() { askEnvironmentSpec = prev })
	return &firsts
}

// TestProj_PromptEnvMatrixBuildsTheTuplesTheFlagWouldHaveTaken drives the matrix loop and
// asserts what it produces is `--env` syntax — the same strings a person would otherwise
// have hand-assembled, which is the complaint this lane exists to answer.
func TestProj_PromptEnvMatrixBuildsTheTuplesTheFlagWouldHaveTaken(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	asked := projScriptYesNo(t, true, true, false) // declare? yes · another? yes · another? no
	firsts := projScriptEnvSpecs(t,
		envAnswers{Name: "prod", Stage: "production", PlacementMode: "dedicated"},
		envAnswers{Name: "dev-1", Stage: "development", PlacementMode: "namespace", Namespace: "boutique-dev-1"},
	)

	got, err := promptEnvMatrix()
	if err != nil {
		t.Fatalf("promptEnvMatrix: %v", err)
	}
	want := []string{"prod:production:dedicated", "dev-1:development:namespace:boutique-dev-1"}
	if !equalStrings(got, want) {
		t.Errorf("promptEnvMatrix = %v, want %v — these are the exact tuples the issue's\n"+
			"      complaint had to be typed by hand", got, want)
	}
	// The first entry must be asked as the first: that is what makes it default to the rung
	// that owns the Fabric, and it is the only input defaultPlacementFor has.
	if !equalStrings(boolsToStrings(*firsts), []string{"true", "false"}) {
		t.Errorf("isFirst sequence = %v, want [true false]", *firsts)
	}
	// The running summary is what the second question shows; without it a person answering
	// "add another?" cannot see what they have.
	if len(*asked) < 3 {
		t.Fatalf("only %d questions were put: %v", len(*asked), *asked)
	}
}

// boolsToStrings renders a bool slice for comparison with equalStrings.
func boolsToStrings(bs []bool) []string {
	out := make([]string, len(bs))
	for i, b := range bs {
		out[i] = fmt.Sprintf("%v", b)
	}
	return out
}

// TestProj_PromptEnvMatrixDeclinedLeavesTheServerDefault pins the arm that must NOT invent a
// matrix: answering "no" returns nothing, and an empty matrix is what makes the server create
// its Production + Preview pair.
func TestProj_PromptEnvMatrixDeclinedLeavesTheServerDefault(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	projScriptYesNo(t, false)
	projScriptEnvSpecs(t) // asking for even one environment is a scripted error
	got, err := promptEnvMatrix()
	if err != nil {
		t.Fatalf("promptEnvMatrix: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("a declined matrix produced %v; the server's default pair is what must happen", got)
	}
}

// TestProj_PromptEnvMatrixRefusesADuplicateWhileStillAsking pins that the loop validates as
// it goes, with the REAL parser, so a duplicate name is reported while the person is still
// answering rather than after the last question.
func TestProj_PromptEnvMatrixRefusesADuplicateWhileStillAsking(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	projScriptYesNo(t, true, true, true)
	projScriptEnvSpecs(t,
		envAnswers{Name: "prod", Stage: "production", PlacementMode: "dedicated"},
		envAnswers{Name: "prod", Stage: "development", PlacementMode: "namespace"},
	)
	if _, err := promptEnvMatrix(); err == nil {
		t.Fatal("two environments called prod must be refused")
	} else if !strings.Contains(err.Error(), "twice") {
		t.Errorf("error %q does not say the name was listed twice", err)
	}
}

// TestProj_PromptEnvMatrixPropagatesAColonRatherThanEmittingIt pins the loop's other refusal.
func TestProj_PromptEnvMatrixPropagatesAColonRatherThanEmittingIt(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	projScriptYesNo(t, true, false)
	projScriptEnvSpecs(t, envAnswers{Name: "a:b", Stage: "production", PlacementMode: "dedicated"})
	if _, err := promptEnvMatrix(); err == nil {
		t.Fatal("an environment name carrying the tuple separator must not be turned into a tuple")
	}
}

// TestProj_PromptEnvMatrixRefusesWhenPromptingIsDisabled pins the short circuit: the loop
// must not open anything a script cannot answer.
func TestProj_PromptEnvMatrixRefusesWhenPromptingIsDisabled(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	opened := projFormCounter(t)
	if _, err := promptEnvMatrix(); err == nil {
		t.Fatal("promptEnvMatrix must refuse with prompting disabled")
	}
	if *opened != 0 {
		t.Errorf("it opened %d form(s) with prompting disabled", *opened)
	}
}

// TestProj_PromptSetValuesLoopsUntilToldToStop drives the --set loop, which is the other half
// of what the tutorial hand-typed three times.
func TestProj_PromptSetValuesLoopsUntilToldToStop(t *testing.T) {
	asked := projScriptYesNo(t, true, true, false)
	prev := askKeyValue
	pairs := [][2]string{{"engine", "postgres"}, {"port", "5432"}}
	i := 0
	askKeyValue = func() (string, string, error) {
		if i >= len(pairs) {
			return "", "", fmt.Errorf("the loop asked for field %d and the script has %d", i+1, len(pairs))
		}
		p := pairs[i]
		i++
		return p[0], p[1], nil
	}
	t.Cleanup(func() { askKeyValue = prev })

	got, err := promptSetValues(nil)
	if err != nil {
		t.Fatalf("promptSetValues: %v", err)
	}
	if !equalStrings(got, []string{"engine=postgres", "port=5432"}) {
		t.Errorf("promptSetValues = %v, want the --set syntax the flag takes", got)
	}
	// The first question and the later ones read differently, so a person knows whether they
	// have set anything.
	if len(*asked) < 2 || (*asked)[0] == (*asked)[1] {
		t.Errorf("the loop asked %v; the first question must not read like the later ones", *asked)
	}
	// Values collected this way must parse the way the flag's do — same parser, no second copy.
	fields, err := parseSetValues(got)
	if err != nil {
		t.Fatalf("parseSetValues: %v", err)
	}
	if fields["port"] != float64(5432) {
		t.Errorf("port parsed as %#v, want the number 5432", fields["port"])
	}
}

// TestProj_PromptSetValuesKeepsWhatTheFlagsAlreadySet pins that answering questions ADDS to
// --set rather than replacing it: a caller who passed one field and wants to be asked for the
// rest must not silently lose the one they typed.
func TestProj_PromptSetValuesKeepsWhatTheFlagsAlreadySet(t *testing.T) {
	projScriptYesNo(t, false)
	prev := askKeyValue
	askKeyValue = func() (string, string, error) { return "", "", fmt.Errorf("must not be asked") }
	t.Cleanup(func() { askKeyValue = prev })

	got, err := promptSetValues([]string{"engine=postgres"})
	if err != nil {
		t.Fatalf("promptSetValues: %v", err)
	}
	if !equalStrings(got, []string{"engine=postgres"}) {
		t.Errorf("promptSetValues dropped what --set already carried: %v", got)
	}
}

// TestProj_PromptSetValuesRefusesANamelessField pins the one refusal in the loop.
func TestProj_PromptSetValuesRefusesANamelessField(t *testing.T) {
	projScriptYesNo(t, true, false)
	prev := askKeyValue
	askKeyValue = func() (string, string, error) { return "  ", "postgres", nil }
	t.Cleanup(func() { askKeyValue = prev })
	if _, err := promptSetValues(nil); err == nil {
		t.Fatal("a field with no name must be refused, not stored as `=postgres`")
	}
}

// projFailingYesNo makes every yes/no question fail, which is what a dismissed form does.
func projFailingYesNo(t *testing.T) {
	t.Helper()
	prev := askYesNo
	askYesNo = func(string, string) (bool, error) { return false, fmt.Errorf("dismissed") }
	t.Cleanup(func() { askYesNo = prev })
}

// TestProj_ADismissedQuestionStopsTheLoop pins that a dismissed prompt aborts rather than
// being read as "no" — the difference between "I do not want a matrix" and "I pressed
// escape", which must not both mean "create the default pair".
func TestProj_ADismissedQuestionStopsTheLoop(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	projFailingYesNo(t)
	if _, err := promptEnvMatrix(); err == nil {
		t.Error("a dismissed matrix question must be an error, not an empty matrix")
	}
	if _, err := promptSetValues(nil); err == nil {
		t.Error("a dismissed --set question must be an error, not an empty field list")
	}
}

// TestProj_AskYesNoReadsAnAnsweredForm pins the real seam rather than only its stubs: huh
// fills the bound value from a key message with no terminal involved, so the default
// implementation is driven here the way confirm's affirmative arm is.
func TestProj_AskYesNoReadsAnAnsweredForm(t *testing.T) {
	prev := runHuhForm
	runHuhForm = func(groups ...*huh.Group) error {
		f := huh.NewForm(groups...)
		f.Init()
		f.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'y'}})
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })

	yes, err := askYesNo("Declare the matrix?", "")
	if err != nil || !yes {
		t.Fatalf("askYesNo = (%v, %v), want (true, nil)", yes, err)
	}

	runHuhForm = func(...*huh.Group) error { return fmt.Errorf("dismissed") }
	if _, err := askYesNo("Declare the matrix?", ""); err == nil {
		t.Error("a dismissed form must surface as an error")
	}
}

// TestProj_ComponentEnvOptionsOfferTheRealEnvironments pins the picker that replaced a
// free-text --env: authoring into the wrong tier is silent, and the next thing that reads it
// is a deploy.
func TestProj_ComponentEnvOptionsOfferTheRealEnvironments(t *testing.T) {
	envs := []api.Environment{
		{ID: "e1", Name: "production", Stage: "production", IsDefault: true},
		{ID: "e2", Name: "dev", Stage: "development"},
	}
	opts := componentEnvOptions(envs, "")
	if len(opts) != 3 {
		t.Fatalf("offered %d options, want the two environments plus the default", len(opts))
	}
	// The first option is the empty value: "the project's default environment", which is what
	// an omitted --env means. Dropping it would make the picker unable to express the default.
	if opts[0].Value != "" {
		t.Errorf("the first option is %q, want the empty (default-environment) value", opts[0].Value)
	}
	if opts[1].Value != "production" || opts[2].Value != "dev" {
		t.Errorf("options carry %q and %q, want the environment NAMES --env takes", opts[1].Value, opts[2].Value)
	}
	if !strings.Contains(opts[1].Key, "production") {
		t.Errorf("label %q does not name the environment", opts[1].Key)
	}
}

// TestProj_ComponentEnvSeedSurvivesThePicker pins the half that makes --env mean what its help
// says it means. `--env` takes an id, a NAME or a STAGE; the picker's option values are names.
//
// huh binds a Select to its FIRST option when the bound value matches none of them, and the
// first option here is "the project's default environment" — so a seed the picker could not
// express was silently discarded and the component authored into the DEFAULT tier, which is
// the exact silent mis-targeting the picker was added to prevent.
func TestProj_ComponentEnvSeedSurvivesThePicker(t *testing.T) {
	envs := []api.Environment{
		{ID: "e1", Name: "prod-1", Stage: "production", IsDefault: true},
		{ID: "e2", Name: "dev", Stage: "development"},
		{ID: "e3", Name: "dev-2", Stage: "development"},
	}
	for seed, want := range map[string]string{
		"":           "",       // no seed: the default environment
		"dev":        "dev",    // a name is already an option value
		"e1":         "prod-1", // an id resolves onto the option that names it
		"production": "prod-1", // a stage exactly one environment carries
	} {
		if got := componentEnvSeedValue(envs, seed); got != want {
			t.Errorf("--env %q resolved to %q, want %q", seed, got, want)
		}
	}
	// A stage TWO environments share names neither: resolving it here would be the CLI
	// inventing the answer the server resolves.
	if got := componentEnvSeedValue(envs, "development"); got != "development" {
		t.Errorf("an ambiguous stage resolved to %q, want it left for the server", got)
	}
	// And whatever it could not place is still offered, so huh cannot overwrite it.
	opts := componentEnvOptions(envs, "development")
	if len(opts) != len(envs)+2 {
		t.Fatalf("offered %d options, want the environments, the default, and the seed", len(opts))
	}
	if got := opts[len(opts)-1].Value; got != "development" {
		t.Errorf("the unplaceable seed is offered as %q, want it verbatim", got)
	}
	// A seed that IS an option value is not offered twice.
	if got := componentEnvOptions(envs, "dev"); len(got) != len(envs)+1 {
		t.Errorf("a seed already on the list produced %d options, want %d", len(got), len(envs)+1)
	}
}

// TestProj_PromptComponentAddRefusesAMultiKindWithNoName pins the one thing the form must
// decide for itself, because the two questions are in separate forms: whether a name was
// needed depends on the kind, which is only known after the first is answered.
func TestProj_PromptComponentAddRefusesAMultiKindWithNoName(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	projForm(t) // every form succeeds, answering nothing
	projScriptYesNo(t, false)
	f := &fakeClient{environments: []api.Environment{{ID: "e1", Name: "production", Stage: "production"}}}

	if _, err := promptComponentAdd(f, "boutique", componentAddSpec{Kind: "databases"}); err == nil {
		t.Error("a multi kind with no name must be refused before the request is built")
	}
	// A singleton needs none, and a seeded one is dropped rather than sent.
	got, err := promptComponentAdd(f, "boutique", componentAddSpec{Kind: "cluster", Name: "ignored"})
	if err != nil {
		t.Fatalf("promptComponentAdd(singleton): %v", err)
	}
	if got.Name != "" {
		t.Errorf("a singleton kept the name %q, which the server ignores", got.Name)
	}
}

// TestProj_PromptComponentAddRefusesWhenPromptingIsDisabled pins the short circuit.
func TestProj_PromptComponentAddRefusesWhenPromptingIsDisabled(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	opened := projFormCounter(t)
	if _, err := promptComponentAdd(&fakeClient{}, "boutique", componentAddSpec{}); err == nil {
		t.Fatal("promptComponentAdd must refuse with prompting disabled")
	}
	if *opened != 0 {
		t.Errorf("it opened %d form(s) with prompting disabled", *opened)
	}
}

// TestProj_PromptsShortCircuitWhenPromptingIsDisabled sweeps the remaining single-question
// prompts. Each must refuse through requireInteractive and open nothing: a form a script
// cannot answer is a hang, which is the failure --no-input exists to prevent.
func TestProj_PromptsShortCircuitWhenPromptingIsDisabled(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	opened := projFormCounter(t)
	cases := map[string]func() error{
		"promptProjectName": func() error { _, err := promptProjectName(); return err },
		"promptRegion":      func() error { _, err := promptRegion(); return err },
		"promptDesignFile":  func() error { _, err := promptDesignFile(); return err },
		"promptComponentKind": func() error {
			_, err := promptComponentKind()
			return err
		},
		"promptProjectRef":      func() error { _, err := promptProjectRef("tok"); return err },
		"promptProjectNameRef":  func() error { _, err := promptProjectNameRef("tok"); return err },
		"promptEnvironmentSpec": func() error { a := envAnswers{}; return promptEnvironmentSpec(&a, true) },
	}
	for name, fn := range cases {
		t.Run(name, func(t *testing.T) {
			if err := fn(); err == nil {
				t.Errorf("%s returned no error with prompting disabled", name)
			}
		})
	}
	if *opened != 0 {
		t.Errorf("%d form(s) were opened with prompting disabled", *opened)
	}
}

// TestProj_PromptsRefuseAnEmptyAnswerRatherThanSendingIt pins what happens when the form
// runs and the person answers nothing. An empty project name would be POSTed and refused by
// the server; an empty environment name would be too.
func TestProj_PromptsRefuseAnEmptyAnswerRatherThanSendingIt(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	projForm(t)
	if _, err := promptProjectName(); err == nil {
		t.Error("an unanswered project-name form must not produce an empty name")
	}
	a := envAnswers{}
	if err := promptEnvironmentSpec(&a, true); err == nil {
		t.Error("an unanswered environment form must not produce a nameless environment")
	}
	// promptProjectRef is exercised in TestProj_PromptProjectRefRefusesWhatItCannotName; huh
	// binds a Select to its first option at build time, so "unanswered" is not "empty" here.
}

// TestProj_PromptEnvironmentSpecSeedsTheDefaults pins that the form starts on the right rung
// before anybody answers.
//
// The seed is not cosmetic: a form that is opened and dismissed leaves its seeded values in
// place, and those are what the request would carry. A first environment seeded `namespace`
// would quietly share a Fabric that does not exist yet; a later one seeded `dedicated` would
// quietly buy a cluster. The name is written by the test rather than answered, because no
// stub can answer a huh form — what is under test is the seeding either side of it.
func TestProj_PromptEnvironmentSpecSeedsTheDefaults(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	projForm(t)

	first := envAnswers{Name: "prod"}
	if err := promptEnvironmentSpec(&first, true); err != nil {
		t.Fatalf("promptEnvironmentSpec(first): %v", err)
	}
	if first.PlacementMode != defaultPlacementFor(true) {
		t.Errorf("a first environment seeded %q, want %q", first.PlacementMode, defaultPlacementFor(true))
	}
	if first.Stage != string(stageDevelopment) {
		t.Errorf("stage seeded %q, want %q", first.Stage, stageDevelopment)
	}

	later := envAnswers{Name: "dev"}
	if err := promptEnvironmentSpec(&later, false); err != nil {
		t.Fatalf("promptEnvironmentSpec(later): %v", err)
	}
	if later.PlacementMode != defaultPlacementFor(false) {
		t.Errorf("a later environment seeded %q, want %q", later.PlacementMode, defaultPlacementFor(false))
	}

	// A seeded value the caller already had is NOT overwritten: `env add --placement-mode
	// dedicated` that then asks for the name must keep the rung the caller chose.
	chosen := envAnswers{Name: "prod", Stage: "production", PlacementMode: "vcluster"}
	if err := promptEnvironmentSpec(&chosen, false); err != nil {
		t.Fatalf("promptEnvironmentSpec(chosen): %v", err)
	}
	if chosen.PlacementMode != "vcluster" || chosen.Stage != "production" {
		t.Errorf("the seed overwrote what the caller passed: %+v", chosen)
	}

	// Whatever the form leaves behind must still be a value the server accepts.
	if err := validateEnvAnswers(first); err != nil {
		t.Errorf("a seeded-but-unanswered environment is not valid: %v", err)
	}
}

// ── the interactive path and the flags, compared on the wire ────────────────────────────
//
// The claim these tests exist for is the one the whole lane rests on: the questions and the
// flags are TWO RENDERINGS OF ONE SPEC. Everything else asserts that in pieces — the tuple
// round-trips, the replay line reproduces the run. These assert it where it counts, by
// running the real command both ways against the fake control plane and comparing the bytes
// it sent.
//
// A form that quietly sent something different from the flags would satisfy every other test
// in this file.

// TestProj_CreateAnsweredAndFlaggedSendTheSameRequest is the headline.
//
// Interactively: the matrix is answered one environment at a time. Scripted: the same matrix
// is the colon tuples from the issue's complaint. The POSTed body must be identical.
func TestProj_CreateAnsweredAndFlaggedSendTheSameRequest(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	// --- answered ---
	projTTY(t)
	// The identity picker opens unanswered. huh binds a Select to its FIRST option when the
	// form is built, so this lands on the fake's only cloud account (ci1 / prod-account) —
	// which is what a person pressing enter would get. Measured, not assumed: the first cut
	// of this test named no account on the flagged side and the two bodies differed by
	// exactly that field.
	projForm(t)
	projScriptYesNo(t, true, true, false)
	projScriptEnvSpecs(t,
		envAnswers{Name: "prod", Stage: "production", PlacementMode: "dedicated"},
		envAnswers{Name: "dev-1", Stage: "development", PlacementMode: "namespace", Namespace: "boutique-dev-1"},
	)
	if h.run("project", "create", "boutique", "--region", "eu-west-1") {
		t.Fatal("the answered create exited fatally")
	}
	answered, ok := s.lastPost()
	if !ok {
		t.Fatal("the answered create sent no request")
	}
	s.forgetPosts()

	// --- flagged: the command line from the issue, minus the opaque id ---
	if h.run("project", "create", "boutique", "--region", "eu-west-1", "--no-input",
		"--cloud-account", "prod-account",
		"--env", "prod:production:dedicated",
		"--env", "dev-1:development:namespace:boutique-dev-1") {
		t.Fatal("the flagged create exited fatally")
	}
	flagged, ok := s.lastPost()
	if !ok {
		t.Fatal("the flagged create sent no request")
	}

	if !reflect.DeepEqual(answered.Body, flagged.Body) {
		t.Errorf("the questions and the flags are not one spec.\n  answered: %#v\n  flagged:  %#v",
			answered.Body, flagged.Body)
	}
	// Vacuity: a comparison of two nil bodies would pass having compared nothing.
	envs, _ := answered.Body["environments"].([]any)
	if len(envs) != 2 {
		t.Fatalf("the compared body carries %d environments, want 2 — the assertion above compared nothing meaningful", len(envs))
	}
	if answered.Body["cloud_identity_id"] != "ci1" {
		t.Fatalf("the compared body carries no resolved cloud account (%#v), so the comparison "+
			"missed the field the issue's complaint was about", answered.Body["cloud_identity_id"])
	}
}

// TestProj_EnvAddAnsweredAndFlaggedSendTheSameRequest does the same for `project env add`.
func TestProj_EnvAddAnsweredAndFlaggedSendTheSameRequest(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)

	projTTY(t)
	// The form opens seeded and is dismissed unanswered, so the seeds are what it carries:
	// the name from the argument, the placement from the flag, the stage from its default.
	projForm(t)
	if h.run("project", "env", "add", "staging", "--project", "web",
		"--placement-mode", "vcluster", "--namespace", "web-staging") {
		t.Fatal("the answered env add exited fatally")
	}
	answered, ok := s.lastPost()
	if !ok {
		t.Fatal("the answered env add sent no request")
	}
	s.forgetPosts()

	if h.run("project", "env", "add", "staging", "--project", "web", "--no-input",
		"--stage", "development", "--placement-mode", "vcluster", "--namespace", "web-staging") {
		t.Fatal("the flagged env add exited fatally")
	}
	flagged, ok := s.lastPost()
	if !ok {
		t.Fatal("the flagged env add sent no request")
	}
	if !reflect.DeepEqual(answered.Body, flagged.Body) {
		t.Errorf("env add disagrees with itself.\n  answered: %#v\n  flagged:  %#v", answered.Body, flagged.Body)
	}
	if answered.Body["placement_mode"] != "vcluster" {
		t.Fatalf("the compared body carries placement %#v, want vcluster — the assertion above compared nothing meaningful",
			answered.Body["placement_mode"])
	}
}

// TestProj_ComponentAddAnsweredAndFlaggedSendTheSameRequest does the same for the command
// the tutorial calls three times with hand-typed --set pairs.
func TestProj_ComponentAddAnsweredAndFlaggedSendTheSameRequest(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)

	projTTY(t)
	projForm(t) // the kind and details forms open seeded from the flags and are dismissed
	projScriptYesNo(t, true, true, false)
	prev := askKeyValue
	pairs := [][2]string{{"engine", "postgres"}, {"port", "5432"}}
	i := 0
	askKeyValue = func() (string, string, error) {
		p := pairs[i]
		i++
		return p[0], p[1], nil
	}
	t.Cleanup(func() { askKeyValue = prev })

	if h.run("project", "component", "add", "--project", "web",
		"--kind", "databases", "--name", "main", "--env", "production") {
		t.Fatal("the answered component add exited fatally")
	}
	answered, ok := s.lastPost()
	if !ok {
		t.Fatal("the answered component add sent no request")
	}
	s.forgetPosts()

	if h.run("project", "component", "add", "--project", "web", "--no-input",
		"--kind", "databases", "--name", "main", "--env", "production",
		"--set", "engine=postgres", "--set", "port=5432") {
		t.Fatal("the flagged component add exited fatally")
	}
	flagged, ok := s.lastPost()
	if !ok {
		t.Fatal("the flagged component add sent no request")
	}
	if !reflect.DeepEqual(answered.Body, flagged.Body) {
		t.Errorf("component add disagrees with itself.\n  answered: %#v\n  flagged:  %#v",
			answered.Body, flagged.Body)
	}
	fields, _ := answered.Body["fields"].(map[string]any)
	if len(fields) != 2 {
		t.Fatalf("the compared body carries %d fields, want 2 — the assertion above compared nothing meaningful", len(fields))
	}
	// The typed coercion must survive the ANSWERED path too: a port arriving as the string
	// "5432" is what the server refuses.
	if fields["port"] != float64(5432) {
		t.Errorf("an answered port arrived as %#v, want the number 5432", fields["port"])
	}
}

// ── the job commands take a name ────────────────────────────────────────────────────────

// TestProj_JobCommandsTakeAProjectName pins the handoff this removes: `project plan
// --project-id <id>` needed an id copied out of `project list`.
func TestProj_JobCommandsTakeAProjectName(t *testing.T) {
	for _, verb := range []string{"plan", "apply", "destroy"} {
		t.Run(verb, func(t *testing.T) {
			s := &projServer{}
			h := projEnv(t, s)
			args := []string{"project", verb, "--project", "web", "--no-input"}
			if verb == "destroy" {
				args = append(args, "--yes")
			}
			if h.run(args...) {
				t.Fatalf("project %s --project web exited fatally", verb)
			}
			post, ok := s.lastPost()
			if !ok {
				t.Fatalf("project %s queued nothing", verb)
			}
			// The fake control plane's only project is `web`, whose id is p1. A resolver that
			// passed the NAME through would send "web" and the server would 404.
			if post.Body["configuration_id"] != "p1" {
				t.Errorf("queued configuration_id = %#v, want the resolved id p1", post.Body["configuration_id"])
			}
		})
	}
}

// TestProj_JobCommandsRefuseANameTheyCannotResolve pins the two loud failures. Both matter
// more than usual here: what this resolves is queued as a DESTROY.
func TestProj_JobCommandsRefuseANameTheyCannotResolve(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if !h.run("project", "destroy", "--project", "not-a-project", "--yes", "--no-input") {
		t.Error("an unknown project name must be fatal")
	}
	if posts := len(s.posts); posts > 0 {
		t.Errorf("an unresolvable name still sent %d request(s): %+v", posts, s.posts)
	}
	s.forgetPosts()

	if !h.run("project", "destroy", "--project", "web", "--project-id", "p1", "--yes", "--no-input") {
		t.Error("--project and --project-id together must be fatal, even when they agree")
	}
	if posts := len(s.posts); posts > 0 {
		t.Errorf("two answers still sent %d request(s): %+v", posts, s.posts)
	}
}

// TestProj_JobCommandsStillTakeAnId pins that the flag scripts already pass keeps working:
// this lane stops REQUIRING an id, it does not stop accepting one.
func TestProj_JobCommandsStillTakeAnId(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)
	if h.run("project", "plan", "--project-id", "p-not-in-the-list", "--no-input") {
		t.Fatal("--project-id must pass through unresolved")
	}
	post, ok := s.lastPost()
	if !ok {
		t.Fatal("nothing was queued")
	}
	if post.Body["configuration_id"] != "p-not-in-the-list" {
		t.Errorf("configuration_id = %#v; --project-id must not be looked up", post.Body["configuration_id"])
	}
}

// ── the remaining prompt arms ───────────────────────────────────────────────────────────

// TestProj_GetAsksWhichProject pins `project get` with no argument, which used to be a cobra
// arity error naming nothing a person could act on.
func TestProj_GetAsksWhichProject(t *testing.T) {
	s := &projServer{config: projSampleConfig()}
	h := projEnv(t, s)
	projTTY(t)
	opened := projFormCounter(t)
	h.run("project", "get")
	if *opened == 0 {
		t.Error("project get with no argument opened no picker")
	}

	h2 := projEnv(t, s)
	if !h2.run("project", "get", "--no-input") {
		t.Error("project get with no argument and no prompts must be fatal, naming the argument")
	}
}

// TestProj_DesignApplyAsksForTheFile pins the -f prompt.
func TestProj_DesignApplyAsksForTheFile(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)
	projTTY(t)
	prev := askLine
	path := filepath.Join(t.TempDir(), "design.json")
	if err := os.WriteFile(path, []byte(`{"components":[]}`), 0o600); err != nil {
		t.Fatalf("write design document: %v", err)
	}
	askLine = func(string, string) (string, error) { return path, nil }
	t.Cleanup(func() { askLine = prev })

	if h.run("project", "design", "apply", "--project", "web", "--dry-run") {
		t.Fatal("an answered design apply exited fatally")
	}
	if post, ok := s.lastPost(); !ok || !strings.HasSuffix(post.Path, "/design") {
		t.Errorf("the answered path was not applied; last post = %+v", post)
	}
}

// TestProj_DesignApplyPrintsWhatItDeleted pins the safety report. `apply` is not in the
// CLI's destructive-verb set and carries no --yes — a design document is what CI replays, and
// a confirmation there would break the workflow the command exists for — so REPORTING what
// went is the whole safety story, and it used to print only for --dry-run.
func TestProj_DesignApplyPrintsWhatItDeleted(t *testing.T) {
	var out strings.Builder
	res := &api.DesignApplyResult{OK: true, Mode: "applied", Changes: []api.DesignChange{
		{Kind: "storage_buckets", Name: strPtr("receipts"), Action: "DELETE"},
	}}
	c := &fakeClient{designResult: res}
	if err := runDesignApply(c, &out, api.ApplyDesignParams{Project: "shop", Env: "dev", Document: []byte("{}")}); err != nil {
		t.Fatalf("runDesignApply: %v", err)
	}
	for _, want := range []string{"DELETE", "storage_buckets", "receipts"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("a real apply printed %q, which never names %q — the deletion is invisible", out.String(), want)
		}
	}
}

// strPtr is a pointer to a string literal, for the optional wire fields.
func strPtr(s string) *string { return &s }

// TestProj_KnownProjectNamesAndLabelsHandleAnEmptyOrg pins the empty case of both "have:"
// renderings. An error reading "have: " with nothing after it tells a new user their name is
// wrong rather than that they have no projects yet.
func TestProj_KnownProjectNamesAndLabelsHandleAnEmptyOrg(t *testing.T) {
	if got := knownProjectNames(nil); !strings.Contains(got, "project create") {
		t.Errorf("empty project list rendered %q; it must say how to make one", got)
	}
	if got := knownIdentityLabels(nil); !strings.Contains(got, "connector add") {
		t.Errorf("empty account list rendered %q; it must say how to link one", got)
	}
	// Sorted and de-duplicated, so a shared name is offered once and the order is stable.
	got := knownProjectNames([]types.ConfigurationSummary{
		{ID: "1", ProjectName: "shop"}, {ID: "2", ProjectName: "api"}, {ID: "3", ProjectName: "shop"},
	})
	if got != "api, shop" {
		t.Errorf("knownProjectNames = %q, want %q", got, "api, shop")
	}
}

// TestProj_PromptProjectRefHandlesAnEmptyOrgAndAFailedList pins the picker's two refusals.
func TestProj_PromptProjectRefHandlesAnEmptyOrgAndAFailedList(t *testing.T) {
	s := &projServer{}
	projEnv(t, s)
	projTTY(t)
	projForm(t)

	s.failOn = []string{"/configurations"}
	if _, err := promptProjectRef("tok"); err == nil {
		t.Error("a failed project list must be reported, not shown as an empty picker")
	}
}

// TestProj_ValidateEnvAnswersRefusesEitherField pins both arms; the stage arm was reachable
// only through the form, so nothing exercised it.
func TestProj_ValidateEnvAnswersRefusesEitherField(t *testing.T) {
	if err := validateEnvAnswers(envAnswers{Stage: "prodution", PlacementMode: "namespace"}); err == nil {
		t.Error("a mistyped stage must be refused")
	}
	if err := validateEnvAnswers(envAnswers{Stage: "production", PlacementMode: "dedicted"}); err == nil {
		t.Error("a mistyped placement must be refused")
	}
	if err := validateEnvAnswers(envAnswers{Stage: "production", PlacementMode: "dedicated"}); err != nil {
		t.Errorf("a valid pair was refused: %v", err)
	}
	// Empty means "the server's default" for both, and every caller depends on that.
	if err := validateEnvAnswers(envAnswers{}); err != nil {
		t.Errorf("empty values must be left to the server: %v", err)
	}
}

// TestProj_CreateRefusesAValueTheServerWouldRefuseBeforeSending pins the flag-level checks,
// which turn an opaque 400 into a message naming the allowed set.
func TestProj_CreateRefusesAValueTheServerWouldRefuseBeforeSending(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)
	for _, args := range [][]string{
		{"project", "create", "api", "--region", "eu-west-1", "--stage", "prodution"},
		{"project", "create", "api", "--region", "eu-west-1", "--placement-mode", "dedicted"},
		{"project", "create", "api", "--region", "eu-west-1", "--env", "prod:prodution"},
	} {
		s.forgetPosts()
		if !h.run(append(args, "--no-input")...) {
			t.Errorf("%v should have been refused locally", args)
		}
		if len(s.posts) > 0 {
			t.Errorf("%v reached the control plane: %+v", args, s.posts)
		}
	}
}

// TestProj_CreateResolvesACloudAccountLabel pins --cloud-account end to end: the label goes
// in, the identity id goes on the wire.
func TestProj_CreateResolvesACloudAccountLabel(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)
	if h.run("project", "create", "api", "--region", "eu-west-1",
		"--cloud-account", "prod-account", "--no-input") {
		t.Fatal("create with a cloud-account label exited fatally")
	}
	post, ok := s.lastPost()
	if !ok {
		t.Fatal("nothing was created")
	}
	if post.Body["cloud_identity_id"] != "ci1" {
		t.Errorf("cloud_identity_id = %#v, want the id the label ci1/prod-account resolves to", post.Body["cloud_identity_id"])
	}

	s.forgetPosts()
	if !h.run("project", "create", "api", "--region", "eu-west-1",
		"--cloud-account", "no-such-account", "--no-input") {
		t.Error("an unknown cloud-account label must be fatal")
	}
	if len(s.posts) > 0 {
		t.Errorf("an unresolvable label still created something: %+v", s.posts)
	}
}

// ── the refusal arms ────────────────────────────────────────────────────────────────────
//
// Every prompt has three outcomes and only one of them is the happy path: the person answers,
// the person dismisses, or there is nobody to ask. The dismissal arm is the one that rots,
// because it is invisible until somebody presses escape — and a dismissal read as an ANSWER
// is how an empty region, a nameless environment or an unlinked project gets sent.

// projDismissForms makes every huh form fail, which is what a dismissed prompt does.
func projDismissForms(t *testing.T) {
	t.Helper()
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return fmt.Errorf("dismissed") }
	t.Cleanup(func() { runHuhForm = prev })
}

// projAnswerLines answers the single-line questions in order; the last answer repeats.
func projAnswerLines(t *testing.T, answers ...string) *[]string {
	t.Helper()
	asked := []string{}
	prev := askLine
	i := 0
	askLine = func(title, _ string) (string, error) {
		asked = append(asked, title)
		a := answers[len(answers)-1]
		if i < len(answers) {
			a = answers[i]
		}
		i++
		return a, nil
	}
	t.Cleanup(func() { askLine = prev })
	return &asked
}

// TestProj_CreateAsksForTheNameAndRegionItWasNotGiven drives the two single-line prompts
// through the command body, and pins that a scripted run with neither is fatal rather than a
// request with an empty name.
func TestProj_CreateAsksForTheNameAndRegionItWasNotGiven(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)
	projTTY(t)
	projForm(t)
	asked := projAnswerLines(t, "boutique", "eu-west-1")
	projScriptYesNo(t, false) // decline the matrix

	if h.run("project", "create") {
		t.Fatal("an answered create exited fatally")
	}
	post, ok := s.lastPost()
	if !ok {
		t.Fatal("nothing was created")
	}
	if post.Body["project_name"] != "boutique" || post.Body["region"] != "eu-west-1" {
		t.Errorf("the answers did not reach the request: %#v", post.Body)
	}
	if len(*asked) != 2 {
		t.Errorf("%d single-line questions were put: %v", len(*asked), *asked)
	}

	s.forgetPosts()
	if !h.run("project", "create", "--no-input") {
		t.Error("create with no name and no prompts must be fatal")
	}
	if len(s.posts) > 0 {
		t.Errorf("a nameless create still reached the control plane: %+v", s.posts)
	}
}

// TestProj_CreateSurfacesADismissedQuestion pins that dismissing any of create's prompts
// stops the command instead of creating a project from the defaults.
func TestProj_CreateSurfacesADismissedQuestion(t *testing.T) {
	for _, name := range []string{"the name prompt", "the matrix loop"} {
		t.Run(name, func(t *testing.T) {
			s := &projServer{}
			h := projEnv(t, s)
			projTTY(t)
			projForm(t)
			args := []string{"project", "create"}
			if name == "the name prompt" {
				projDismissForms(t)
			} else {
				projAnswerLines(t, "boutique")
				projFailingYesNo(t)
				args = append(args, "--region", "eu-west-1")
			}
			if !h.run(args...) {
				t.Error("a dismissed question must stop the command")
			}
			if len(s.posts) > 0 {
				t.Errorf("a dismissed question still created something: %+v", s.posts)
			}
		})
	}
}

// TestProj_PromptEnvMatrixSurfacesADismissedEnvironment pins the loop's first refusal arm:
// dismissing the environment form itself, rather than the yes/no around it.
func TestProj_PromptEnvMatrixSurfacesADismissedEnvironment(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	projScriptYesNo(t, true, false)
	projScriptEnvSpecs(t) // the script holds no environments, so the first ask fails
	if _, err := promptEnvMatrix(); err == nil {
		t.Fatal("a dismissed environment form must stop the matrix")
	}
}

// TestProj_PromptEnvironmentSpecSurfacesADismissedForm pins the same one level down.
func TestProj_PromptEnvironmentSpecSurfacesADismissedForm(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	projDismissForms(t)
	a := envAnswers{Name: "dev"}
	if err := promptEnvironmentSpec(&a, false); err == nil {
		t.Fatal("a dismissed environment form must be an error, not the seeded defaults")
	}
}

// TestProj_AskLineSurfacesADismissedForm pins the shared single-line seam's own error arm.
func TestProj_AskLineSurfacesADismissedForm(t *testing.T) {
	projDismissForms(t)
	if _, err := askLine("Region", ""); err == nil {
		t.Fatal("a dismissed line prompt must be an error, not an empty answer")
	}
}

// TestProj_EnvAddRefusalArms walks `env add`'s three ways of not proceeding.
func TestProj_EnvAddRefusalArms(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)

	t.Run("a dismissed form stops it", func(t *testing.T) {
		projTTY(t)
		projDismissForms(t)
		s.forgetPosts()
		if !h.run("project", "env", "add", "staging", "--project", "web") {
			t.Error("a dismissed environment form must stop env add")
		}
		if len(s.posts) > 0 {
			t.Errorf("it still added an environment: %+v", s.posts)
		}
	})

	t.Run("no name and no prompts is fatal", func(t *testing.T) {
		s.forgetPosts()
		if !h.run("project", "env", "add", "--project", "web", "--no-input") {
			t.Error("env add with no name and no prompts must be fatal")
		}
		if len(s.posts) > 0 {
			t.Errorf("it still added a nameless environment: %+v", s.posts)
		}
	})

	t.Run("a value outside the generated enum is refused locally", func(t *testing.T) {
		s.forgetPosts()
		if !h.run("project", "env", "add", "staging", "--project", "web", "--no-input",
			"--placement-mode", "dedicted") {
			t.Error("a mistyped placement rung must be refused")
		}
		if len(s.posts) > 0 {
			t.Errorf("it reached the control plane: %+v", s.posts)
		}
	})
}

// TestProj_PromptProjectRefRefusesWhatItCannotName pins the picker's two remaining arms: an
// organization with no projects, and a listed project carrying neither a name nor an id.
func TestProj_PromptProjectRefRefusesWhatItCannotName(t *testing.T) {
	t.Run("an empty organization", func(t *testing.T) {
		s := &projServer{configs: []map[string]any{}}
		projEnv(t, s)
		projTTY(t)
		projForm(t)
		_, err := promptProjectRef("tok")
		if err == nil || !strings.Contains(err.Error(), "project create") {
			t.Fatalf("err = %v, want one that says how to make a project", err)
		}
	})

	t.Run("a project with neither a name nor an id", func(t *testing.T) {
		s := &projServer{configs: []map[string]any{{"id": "", "project_name": "", "environment_stage": "production"}}}
		projEnv(t, s)
		projTTY(t)
		projForm(t)
		if _, err := promptProjectRef("tok"); err == nil {
			t.Fatal("a project with no reference must be refused rather than sent as an empty --project")
		}
	})
}

// TestProj_GetPickerReturnsAReferenceItsRouteCanResolve pins why `project get` has a picker of
// its own rather than promptProjectRef's.
//
// promptProjectRef falls back to a project's ID when two listed projects share a name (#3145).
// Every other consumer of it hits an id-or-name route; `get` reads
// GET /cli/configurations/by-project-name/{name}, whose resolver filters on project_name and
// nothing else — so the id would 404 on a project the picker had just offered. huh binds a
// Select to its first option when the form is built, which is what these subtests select.
func TestProj_GetPickerReturnsAReferenceItsRouteCanResolve(t *testing.T) {
	t.Run("a unique name comes back as the name", func(t *testing.T) {
		projEnv(t, &projServer{configs: []map[string]any{
			{"id": "p1", "project_name": "web", "environment_stage": "production"},
			{"id": "p2", "project_name": "shop", "environment_stage": "development"},
		}})
		projTTY(t)
		projForm(t)
		got, err := promptProjectNameRef("tok")
		if err != nil {
			t.Fatalf("promptProjectNameRef: %v", err)
		}
		if got != "web" {
			t.Errorf("the picker returned %q, want the NAME the by-project-name route resolves", got)
		}
	})

	t.Run("a shared name is refused rather than read as whichever is older", func(t *testing.T) {
		projEnv(t, &projServer{configs: []map[string]any{
			{"id": "p1", "project_name": "boutique", "environment_stage": "production"},
			{"id": "p2", "project_name": "boutique", "environment_stage": "development"},
		}})
		projTTY(t)
		projForm(t)
		_, err := promptProjectNameRef("tok")
		if err == nil {
			t.Fatal("a name two projects share must be refused: the route answers it with the older one")
		}
		if !strings.Contains(err.Error(), "boutique") {
			t.Errorf("err = %v, want one that names the project it cannot tell apart", err)
		}
	})

	t.Run("a project with no name", func(t *testing.T) {
		projEnv(t, &projServer{configs: []map[string]any{
			{"id": "p1", "project_name": "", "environment_stage": "production"},
		}})
		projTTY(t)
		projForm(t)
		if _, err := promptProjectNameRef("tok"); err == nil {
			t.Fatal("a nameless project must be refused rather than looked up by an empty name")
		}
	})

	t.Run("an empty organization", func(t *testing.T) {
		projEnv(t, &projServer{configs: []map[string]any{}})
		projTTY(t)
		projForm(t)
		_, err := promptProjectNameRef("tok")
		if err == nil || !strings.Contains(err.Error(), "project create") {
			t.Fatalf("err = %v, want one that says how to make a project", err)
		}
	})
}

// TestProj_ComponentAddRefusalArms walks the add form's ways of not proceeding.
func TestProj_ComponentAddRefusalArms(t *testing.T) {
	t.Run("a dismissed kind form stops it", func(t *testing.T) {
		s := &projServer{envs: projSampleEnvs()}
		h := projEnv(t, s)
		projTTY(t)
		projDismissForms(t)
		if !h.run("project", "component", "add", "--project", "web") {
			t.Error("a dismissed kind form must stop component add")
		}
		if len(s.posts) > 0 {
			t.Errorf("it still added a component: %+v", s.posts)
		}
	})

	t.Run("a dismissed details form stops it", func(t *testing.T) {
		hygCliConfirmSetNoInput(t, false)
		projFormSeq(t, nil, fmt.Errorf("dismissed"))
		if _, err := promptComponentAdd(&fakeClient{}, "web", componentAddSpec{Kind: "cluster"}); err == nil {
			t.Error("a dismissed details form must be an error")
		}
	})

	t.Run("a dismissed field loop stops it", func(t *testing.T) {
		hygCliConfirmSetNoInput(t, false)
		projForm(t)
		projFailingYesNo(t)
		if _, err := promptComponentAdd(&fakeClient{}, "web", componentAddSpec{Kind: "cluster"}); err == nil {
			t.Error("a dismissed --set question must be an error")
		}
	})

	t.Run("a dismissed key/value form stops the loop", func(t *testing.T) {
		projScriptYesNo(t, true, false)
		prev := askKeyValue
		askKeyValue = func() (string, string, error) { return "", "", fmt.Errorf("dismissed") }
		t.Cleanup(func() { askKeyValue = prev })
		if _, err := promptSetValues(nil); err == nil {
			t.Error("a dismissed field form must be an error, not a field list without it")
		}
	})
}

// TestProj_ComponentEnvFallsBackToATextBox pins the deliberate soft failure: when the
// environment list cannot be read, the form still asks — refusing to author a component
// because a PICKER could not be built would be a worse answer than accepting a name the
// server resolves anyway.
func TestProj_ComponentEnvFallsBackToATextBox(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	projForm(t)
	projScriptYesNo(t, false)
	got, err := promptComponentAdd(&fakeClient{err: errProjTestBoom}, "web", componentAddSpec{Kind: "cluster"})
	if err != nil {
		t.Fatalf("a failed environment list must not stop the form: %v", err)
	}
	if got.Kind != "cluster" {
		t.Errorf("the seeded kind was lost: %+v", got)
	}
}

// TestProj_AskKeyValueReadsTheForm drives the real seam rather than only its stubs.
func TestProj_AskKeyValueReadsTheForm(t *testing.T) {
	prev := runHuhForm
	runHuhForm = func(groups ...*huh.Group) error {
		f := huh.NewForm(groups...)
		f.Init()
		for _, r := range "engine" {
			f.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		}
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })
	key, _, err := askKeyValue()
	if err != nil {
		t.Fatalf("askKeyValue: %v", err)
	}
	if key != "engine" {
		t.Errorf("key = %q, want what was typed", key)
	}

	runHuhForm = func(...*huh.Group) error { return fmt.Errorf("dismissed") }
	if _, _, err := askKeyValue(); err == nil {
		t.Error("a dismissed field form must surface as an error")
	}
}

// TestProj_ComponentRemoveNeedsAKindItCanName pins that remove without --kind and without a
// terminal is fatal, and that on a terminal the kind is ASKED before the confirmation — a
// confirmation that does not yet know what it is confirming is a confirmation of nothing.
func TestProj_ComponentRemoveNeedsAKindItCanName(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if !h.run("project", "component", "remove", "--project", "web", "--no-input", "--yes") {
		t.Error("remove with no --kind and no prompts must be fatal")
	}
	if len(s.posts) > 0 {
		t.Errorf("it still removed something: %+v", s.posts)
	}

	s.forgetPosts()
	order := []string{}
	projTTY(t)
	prevForm := runHuhForm
	runHuhForm = func(...*huh.Group) error { order = append(order, "kind asked"); return nil }
	t.Cleanup(func() { runHuhForm = prevForm })
	prevConfirm := confirm
	confirm = func(string, string) bool { order = append(order, "confirmed"); return true }
	t.Cleanup(func() { confirm = prevConfirm })

	if h.run("project", "component", "remove", "--project", "web") {
		t.Fatal("an answered remove exited fatally")
	}
	if len(order) != 2 || order[0] != "kind asked" || order[1] != "confirmed" {
		t.Errorf("order = %v, want the kind asked BEFORE the confirmation", order)
	}
}

// TestProj_ComponentRemoveNamesTheMultiKindItDeletes pins the other half of the same
// confirmation: a multi kind is deleted BY NAME.
//
// `remove` asked for the kind and never for the name, so the interactive path dead-ended for
// the 8 multi kinds — it confirmed "Deletes the databases configuration", naming no component,
// and the server then refused the nameless DELETE with "databases components are removed by
// name (pass --name)". A confirmation whose object is a whole KIND cannot be read as anything
// but yes.
func TestProj_ComponentRemoveNamesTheMultiKindItDeletes(t *testing.T) {
	t.Run("scripted with no --name is refused before the request", func(t *testing.T) {
		s := &projServer{}
		h := projEnv(t, s)
		if !h.run("project", "component", "remove", "--project", "web", "--kind", "databases",
			"--no-input", "--yes") {
			t.Error("a nameless multi-kind remove must be fatal, not sent for the server to refuse")
		}
		if len(s.posts) > 0 {
			t.Errorf("it still issued the delete: %+v", s.posts)
		}
	})

	t.Run("on a terminal the name is asked and lands in the confirmation", func(t *testing.T) {
		s := &projServer{comps: projSampleComponents()}
		h := projEnv(t, s)
		projTTY(t)
		projForm(t) // the kind form leaves `databases`; the name picker binds its first option
		var described string
		prevConfirm := confirm
		confirm = func(_, description string) bool { described = description; return true }
		t.Cleanup(func() { confirm = prevConfirm })

		if h.run("project", "component", "remove", "--project", "web", "--kind", "databases") {
			t.Fatal("an answered multi-kind remove exited fatally")
		}
		if !strings.Contains(described, "main") {
			t.Errorf("the confirmation said %q, which names no component", described)
		}
		last, ok := s.lastPost()
		if !ok {
			t.Fatal("nothing was deleted")
		}
		// The name is a PATH SEGMENT: a nameless delete is `/components/databases`, which is
		// the request the server refuses.
		if last.Method != http.MethodDelete || !strings.HasSuffix(last.Path, "/components/databases/main") {
			t.Errorf("sent %s %s, want DELETE …/components/databases/main", last.Method, last.Path)
		}
	})

	t.Run("a singleton still needs no name", func(t *testing.T) {
		s := &projServer{}
		h := projEnv(t, s)
		projConfirm(t, true)
		if h.run("project", "component", "remove", "--project", "web", "--kind", "network") {
			t.Error("a singleton remove must not have grown a name requirement")
		}
		if _, ok := s.lastPost(); !ok {
			t.Error("the singleton delete was never sent")
		}
	})
}

// TestProj_ComponentNameOptionsOfferWhatExists pins the picker behind that question, including
// the two arms that send it to a text box instead.
func TestProj_ComponentNameOptionsOfferWhatExists(t *testing.T) {
	f := &fakeClient{components: []api.Component{
		{ID: "c1", Kind: "databases", Name: "main", Status: "READY"},
		// The same component name exists in every environment that holds one, and with no
		// --env the listing spans them all: two identical options would ask the reader to
		// choose between them.
		{ID: "c2", Kind: "databases", Name: "main", Status: "READY"},
		{ID: "c3", Kind: "databases", Name: "sessions"},
		{ID: "c4", Kind: "databases", Name: ""},
	}}
	opts := componentNameOptions(f, "boutique", "databases", "")
	if len(opts) != 2 {
		t.Fatalf("offered %d options, want one per distinct named component", len(opts))
	}
	if opts[0].Value != "main" || opts[1].Value != "sessions" {
		t.Errorf("options carry %q and %q, want the component NAMES --name takes", opts[0].Value, opts[1].Value)
	}
	if !strings.Contains(opts[0].Key, "READY") {
		t.Errorf("label %q drops the status, which is what a person is choosing between", opts[0].Key)
	}
	// A failed list is not a reason a delete cannot be typed: no options means "ask".
	if got := componentNameOptions(&fakeClient{err: errProjTestBoom}, "boutique", "databases", ""); len(got) != 0 {
		t.Errorf("a failed list produced %d options", len(got))
	}
	if got := componentNameOptions(&fakeClient{}, "boutique", "databases", ""); len(got) != 0 {
		t.Errorf("an empty list produced %d options", len(got))
	}

	// And the question is still PUT when there is nothing to offer — a text box, not a
	// refusal. A component the list cannot see is still one the server can delete.
	hygCliConfirmSetNoInput(t, false)
	projForm(t)
	got, err := promptComponentName(&fakeClient{err: errProjTestBoom}, "boutique", "databases", "staging")
	if err != nil {
		t.Fatalf("a failed list must fall back to a text box, not stop the delete: %v", err)
	}
	if got != "" {
		t.Errorf("an unanswered text box produced %q", got)
	}
}

// TestProj_ComponentRemoveDismissedKindStopsIt pins the dismissal arm.
func TestProj_ComponentRemoveDismissedKindStopsIt(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)
	projTTY(t)
	projDismissForms(t)
	if !h.run("project", "component", "remove", "--project", "web") {
		t.Error("a dismissed kind picker must stop remove")
	}
	if len(s.posts) > 0 {
		t.Errorf("it still removed something: %+v", s.posts)
	}
}

// TestProj_GetRefusesAnUnnameableProject pins project get's own refusal arm.
func TestProj_GetRefusesAnUnnameableProject(t *testing.T) {
	s := &projServer{configs: []map[string]any{}}
	h := projEnv(t, s)
	projTTY(t)
	projForm(t)
	if !h.run("project", "get") {
		t.Error("project get with no argument and no projects must be fatal")
	}
}

// TestProj_DesignApplyRefusesADismissedPath pins design apply's prompt arm.
func TestProj_DesignApplyRefusesADismissedPath(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)
	projTTY(t)
	projDismissForms(t)
	if !h.run("project", "design", "apply", "--project", "web", "--dry-run") {
		t.Error("a dismissed document path must stop design apply")
	}
	if len(s.posts) > 0 {
		t.Errorf("it still applied something: %+v", s.posts)
	}
}

// TestProj_PromptEnvMatrixSurfacesADismissedContinuation pins the arm between the two the
// tests above cover: the FIRST environment is answered and the "add another?" question is
// then dismissed. Read as "no", it would create a one-environment matrix the person never
// confirmed; read as an error, it stops.
func TestProj_PromptEnvMatrixSurfacesADismissedContinuation(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	prev := askYesNo
	call := 0
	askYesNo = func(string, string) (bool, error) {
		call++
		if call == 1 {
			return true, nil // yes, declare the matrix
		}
		return false, fmt.Errorf("dismissed") // then escape out of "add another?"
	}
	t.Cleanup(func() { askYesNo = prev })
	projScriptEnvSpecs(t, envAnswers{Name: "prod", Stage: "production", PlacementMode: "dedicated"})

	if _, err := promptEnvMatrix(); err == nil {
		t.Fatal("a dismissed continuation must stop the matrix, not silently accept the environments so far")
	}
}

// TestProj_EnvAddPrintsTheReplayLineForAnAnsweredRun pins that `env add` reports what it asked
// — the flags that reproduce it — and stays silent for a run that was already fully flagged.
func TestProj_EnvAddPrintsTheReplayLineForAnAnsweredRun(t *testing.T) {
	s := &projServer{envs: projSampleEnvs()}
	h := projEnv(t, s)

	out := projCaptureStdout(t)
	projTTY(t)
	projForm(t)
	if h.run("project", "env", "add", "staging", "--project", "web", "--placement-mode", "vcluster") {
		t.Fatal("an answered env add exited fatally")
	}
	got := out()
	if !strings.Contains(got, "alethia project env add staging") {
		t.Errorf("an answered env add printed no replay line:\n%s", got)
	}
	if !strings.Contains(got, "--placement-mode vcluster") {
		t.Errorf("the replay line does not carry the placement that was used:\n%s", got)
	}
}

// TestProj_CreateRefusesBothCloudAccountFlags pins the refusal --cloud-account grew when it
// was added beside the older --cloud-identity-id.
//
// They name the SAME field, so a caller who set both either believes one is being ignored or
// has an unnoticed leak from a wrapper script. Resolving that by precedence is worse than it
// looks: preferring the id skips resolveCloudIdentityID entirely, so an unknown or ambiguous
// label is never reported, and createReplayArgs still prints `--cloud-account <label>` — a
// line inviting the reader to commit a command that links a DIFFERENT account than the run
// did. The refusal happens before anything is sent.
func TestProj_CreateRefusesBothCloudAccountFlags(t *testing.T) {
	s := &projServer{}
	h := projEnv(t, s)

	if !h.run("project", "create", "boutique", "--region", "eu-west-1",
		"--cloud-account", "prod-account", "--cloud-identity-id", "ci1",
		"--no-input", "--output", "json") {
		t.Error("both account flags at once must be fatal, not resolved by precedence")
	}
	if len(s.posts) > 0 {
		t.Errorf("it still created the project: %+v", s.posts)
	}

	// And the refusal is about the PAIR, not about either flag: the label alone still
	// resolves to the identity the project is linked to.
	s.forgetPosts()
	if h.run("project", "create", "boutique", "--region", "eu-west-1",
		"--cloud-account", "prod-account", "--no-input", "--output", "json") {
		t.Fatal("--cloud-account alone exited fatally")
	}
	last, ok := s.lastPost()
	if !ok {
		t.Fatal("--cloud-account alone created nothing")
	}
	if got := last.Body["cloud_identity_id"]; got != "ci1" {
		t.Errorf("the payload carries cloud_identity_id %v, want the id the label resolved to", got)
	}
}

// TestProj_GetPickerDismissalIsNotASelection pins the arm `project get`'s own picker shares
// with every other form: a dismissed one returns the dismissal, not a project.
//
// promptProjectNameRef reads the picked NAME back out of the listing, and a form that never
// ran leaves the bound id empty — which would fall through to "that project has no name",
// reporting a malformed listing for what was actually a person pressing escape.
func TestProj_GetPickerDismissalIsNotASelection(t *testing.T) {
	projEnv(t, &projServer{configs: []map[string]any{
		{"id": "p1", "project_name": "web", "environment_stage": "production"},
	}})
	projTTY(t)
	projFormSeq(t, errProjTestBoom)

	got, err := promptProjectNameRef("tok")
	if err == nil {
		t.Fatal("a dismissed project picker must be reported, not read as a selection")
	}
	if got != "" {
		t.Errorf("it returned %q alongside an error — a caller acting on it would look up a project nobody picked", got)
	}
}

// TestProj_PromptComponentNameRefusalArms walks the three ways the multi-kind name question
// does not produce a name. Each matters because the answer feeds a DELETE: a prompt that
// swallowed its own failure would hand `remove` an empty name, which is the nameless request
// the server refuses with "<kind> components are removed by name".
func TestProj_PromptComponentNameRefusalArms(t *testing.T) {
	f := &fakeClient{components: []api.Component{
		{ID: "c1", Kind: "databases", Name: "main", Status: "READY"},
	}}

	t.Run("prompting disabled refuses instead of opening a form", func(t *testing.T) {
		hygCliConfirmSetNoInput(t, true)
		opened := projFormCounter(t)
		got, err := promptComponentName(f, "boutique", "databases", "")
		if err == nil {
			t.Fatal("a scripted run must be refused, not asked: a form it cannot answer is a hang")
		}
		if got != "" {
			t.Errorf("it returned %q with prompting disabled", got)
		}
		if *opened != 0 {
			t.Errorf("it opened %d form(s) with prompting disabled", *opened)
		}
	})

	t.Run("a dismissed picker is reported", func(t *testing.T) {
		hygCliConfirmSetNoInput(t, false)
		projFormSeq(t, errProjTestBoom)
		got, err := promptComponentName(f, "boutique", "databases", "")
		if err == nil {
			t.Fatal("a dismissed component picker must be reported")
		}
		if got != "" {
			t.Errorf("it returned %q alongside an error", got)
		}
	})

	t.Run("a dismissed text box is reported", func(t *testing.T) {
		// Nothing to list, so this is the free-text arm rather than the picker.
		hygCliConfirmSetNoInput(t, false)
		projFormSeq(t, errProjTestBoom)
		got, err := promptComponentName(&fakeClient{err: errProjTestBoom}, "boutique", "databases", "")
		if err == nil {
			t.Fatal("a dismissed component-name box must be reported")
		}
		if got != "" {
			t.Errorf("it returned %q alongside an error", got)
		}
	})
}

// TestProj_ComponentRemoveDismissedNameStopsIt pins what the command does with that
// dismissal: it stops, and nothing is deleted.
//
// The name picker sits BEFORE the confirmation, so a dismissal that fell through would reach
// confirmDestructive with an empty name — a prompt naming a whole KIND, which is the
// unreadable confirmation the name question was added to remove.
func TestProj_ComponentRemoveDismissedNameStopsIt(t *testing.T) {
	s := &projServer{comps: projSampleComponents()}
	h := projEnv(t, s)
	projTTY(t)
	projFormSeq(t, errProjTestBoom)
	asked := false
	prevConfirm := confirm
	confirm = func(string, string) bool { asked = true; return true }
	t.Cleanup(func() { confirm = prevConfirm })

	if !h.run("project", "component", "remove", "--project", "web", "--kind", "databases") {
		t.Error("a dismissed name picker must stop the remove")
	}
	if asked {
		t.Error("it confirmed a removal whose object was never chosen")
	}
	if len(s.posts) > 0 {
		t.Errorf("it still issued the delete: %+v", s.posts)
	}
}

// projCaptureStdout redirects os.Stdout to a pipe and returns a reader for what was written.
// The commands write through os.Stdout directly (they are cobra Run bodies, not run* helpers
// taking an io.Writer), so this is the only way to read what a user would see.
func projCaptureStdout(t *testing.T) func() string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	prev := os.Stdout
	os.Stdout = w
	done := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	var captured string
	read := false
	t.Cleanup(func() {
		if !read {
			os.Stdout = prev
			_ = w.Close()
			<-done
		}
	})
	return func() string {
		if read {
			return captured
		}
		read = true
		os.Stdout = prev
		_ = w.Close()
		captured = <-done
		return captured
	}
}

// ════════════════════════════════════════════════════════════════════════════════════════
// The design-apply delete gate (maintainer ruling, 2026-09-02)
// ════════════════════════════════════════════════════════════════════════════════════════
//
// "Confirm only when it would DELETE." An apply that adds or updates runs unprompted, as CI
// replay needs; one whose plan removes a component requires --yes under --no-input.
//
// The two arms are tested as EQUALS. Only asserting the refusal would leave a gate that
// refused everything looking correct — and a gate that prompts on every replay is the exact
// failure the ruling exists to avoid, not a safe over-approximation of it.

// projDesignDoc writes a design document and returns its path.
func projDesignDoc(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "design.json")
	if err := os.WriteFile(path, []byte(`{"components":[]}`), 0o600); err != nil {
		t.Fatalf("write design document: %v", err)
	}
	return path
}

// projRealWrites counts the recorded requests that were not dry runs.
func projRealWrites(s *projServer) []projPost {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []projPost
	for _, p := range s.posts {
		if !p.DryRun {
			out = append(out, p)
		}
	}
	return out
}

// TestProj_DesignApplyAddOnlyRunsUnprompted is the arm the ruling protects, and the one a
// flat "confirm every apply" rule would have broken. A pipeline replaying a document that
// only adds a cache must not need a human in it.
func TestProj_DesignApplyAddOnlyRunsUnprompted(t *testing.T) {
	s := &projServer{designChanges: []map[string]any{
		{"kind": "caches", "name": "sessions", "action": "CREATE"},
		{"kind": "databases", "name": "orders", "action": "UPDATE"},
	}}
	h := projEnv(t, s)
	asked := 0
	prev := confirm
	confirm = func(string, string) bool { asked++; return false }
	t.Cleanup(func() { confirm = prev })

	if h.run("project", "design", "apply", "--project", "web", "-f", projDesignDoc(t), "--no-input") {
		t.Fatal("an add-only apply must run under --no-input without --yes")
	}
	if asked != 0 {
		t.Errorf("an add-only apply asked %d confirmation(s)", asked)
	}
	if len(projRealWrites(s)) != 1 {
		t.Errorf("an add-only apply made %d real write(s), want exactly 1: %+v", len(projRealWrites(s)), s.posts)
	}
}

// TestProj_DesignApplyDeletingIsRefusedWithoutYes is the other arm.
func TestProj_DesignApplyDeletingIsRefusedWithoutYes(t *testing.T) {
	s := &projServer{designChanges: []map[string]any{
		{"kind": "storage_buckets", "name": "receipts", "action": "DELETE"},
	}}
	h := projEnv(t, s)

	if !h.run("project", "design", "apply", "--project", "web", "-f", projDesignDoc(t), "--no-input") {
		t.Fatal("an apply whose plan removes a component must be refused without --yes")
	}
	// The preflight is allowed; the apply is not.
	if w := projRealWrites(s); len(w) != 0 {
		t.Errorf("the refused apply still wrote: %+v", w)
	}
	if len(s.posts) != 1 || !s.posts[0].DryRun {
		t.Errorf("want exactly one request and it a dry-run preflight; got %+v", s.posts)
	}
}

// TestProj_DesignApplyDeletingProceedsWithYes pins the opt-in. Without this the test above
// would be satisfied by a gate that refuses unconditionally.
func TestProj_DesignApplyDeletingProceedsWithYes(t *testing.T) {
	s := &projServer{designChanges: []map[string]any{
		{"kind": "storage_buckets", "name": "receipts", "action": "DELETE"},
	}}
	h := projEnv(t, s)

	if h.run("project", "design", "apply", "--project", "web", "-f", projDesignDoc(t), "--no-input", "--yes") {
		t.Fatal("--yes must let a deleting apply through")
	}
	if len(projRealWrites(s)) != 1 {
		t.Errorf("--yes did not reach the control plane: %+v", s.posts)
	}
}

// TestProj_DesignApplyRefusalNamesWhyYesIsNeeded pins the wording the ruling asked for.
//
// A pipeline author reading "this command is destructive, pass --yes" adds the flag
// permanently, which converts every later replay into one that may remove components. The
// refusal has to say that the flag is required for THIS PLAN.
func TestProj_DesignApplyRefusalNamesWhyYesIsNeeded(t *testing.T) {
	err := errDesignApplyWouldDelete([]api.DesignChange{
		{Kind: "storage_buckets", Name: strPtr("receipts"), Action: "DELETE"},
	})
	msg := err.Error()
	for _, want := range []string{"--yes", "DELETE", "THIS PLAN", "only adds or updates runs unprompted"} {
		if !strings.Contains(msg, want) {
			t.Errorf("the scripted refusal never says %q:\n%s", want, msg)
		}
	}
	// It must NOT read as a blanket statement about the command.
	if !strings.Contains(msg, "not because") {
		t.Errorf("the refusal does not distinguish this plan from the command in general:\n%s", msg)
	}
}

// TestProj_DesignApplyGateArms drives the gate directly, which is the only way to reach the
// interactive decline and the fail-closed preflight.
func TestProj_DesignApplyGateArms(t *testing.T) {
	deleting := &api.DesignApplyResult{OK: true, Mode: "dry-run", Changes: []api.DesignChange{
		{Kind: "storage_buckets", Name: strPtr("receipts"), Action: "DELETE"},
	}}
	addOnly := &api.DesignApplyResult{OK: true, Mode: "dry-run", Changes: []api.DesignChange{
		{Kind: "caches", Name: strPtr("sessions"), Action: "CREATE"},
	}}
	params := api.ApplyDesignParams{Project: "shop", Env: "dev", Document: []byte("{}")}

	t.Run("an interactive decline is a quiet no-op", func(t *testing.T) {
		projConfirm(t, false)
		var out strings.Builder
		got, err := designApplyGate(&fakeClient{designResult: deleting}, &out, params, false)
		if err != nil {
			t.Fatalf("a declined confirmation is not an error: %v", err)
		}
		if got != designApplyDeclined {
			t.Errorf("gate = %v, want declined", got)
		}
		// The prompt is only meaningful if the reader can see WHAT goes.
		for _, want := range []string{"DELETE", "storage_buckets", "receipts"} {
			if !strings.Contains(out.String(), want) {
				t.Errorf("the gate never named %q before asking:\n%s", want, out.String())
			}
		}
	})

	t.Run("an interactive accept proceeds", func(t *testing.T) {
		projConfirm(t, true)
		var out strings.Builder
		got, err := designApplyGate(&fakeClient{designResult: deleting}, &out, params, false)
		if err != nil || got != designApplyProceed {
			t.Fatalf("gate = (%v, %v), want (proceed, nil)", got, err)
		}
	})

	t.Run("an add-only plan is never asked about", func(t *testing.T) {
		asked := 0
		prev := confirm
		confirm = func(string, string) bool { asked++; return false }
		t.Cleanup(func() { confirm = prev })
		var out strings.Builder
		got, err := designApplyGate(&fakeClient{designResult: addOnly}, &out, params, false)
		if err != nil || got != designApplyProceed {
			t.Fatalf("gate = (%v, %v), want (proceed, nil)", got, err)
		}
		if asked != 0 {
			t.Errorf("an add-only plan was asked about %d time(s)", asked)
		}
		// Nothing printed either: a pipeline log that gains a paragraph per replay is its own
		// regression, and this is the path every CI run takes.
		if out.String() != "" {
			t.Errorf("an add-only plan printed %q", out.String())
		}
	})

	t.Run("an unreadable preflight fails closed", func(t *testing.T) {
		var out strings.Builder
		got, err := designApplyGate(&fakeClient{err: errProjTestBoom}, &out, params, false)
		if err == nil {
			t.Fatal("an unreadable plan must be refused, not applied blind")
		}
		if got != designApplyDeclined {
			t.Errorf("gate = %v, want declined", got)
		}
		for _, want := range []string{"--yes", "--dry-run", "remove components"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("the fail-closed refusal never says %q:\n%s", want, err.Error())
			}
		}
	})

	t.Run("an unreadable preflight with --yes proceeds", func(t *testing.T) {
		var out strings.Builder
		got, err := designApplyGate(&fakeClient{err: errProjTestBoom}, &out, params, true)
		if err != nil || got != designApplyProceed {
			t.Fatalf("gate = (%v, %v), want (proceed, nil) — --yes is the escape hatch", got, err)
		}
	})

	t.Run("a nil result fails closed too", func(t *testing.T) {
		var out strings.Builder
		if _, err := designApplyGate(projNilDesignClient{}, &out, params, false); err == nil {
			t.Fatal("a server that returned no plan must be refused, not applied blind")
		}
	})
}

// TestProj_DesignApplyPreflightAsksForAPlanAndNotAWrite pins the shape of the preflight
// itself: it must carry dry_run, and it must never carry --stage, or the "check" would write
// the document to the review tray as a side effect of checking it.
func TestProj_DesignApplyPreflightAsksForAPlanAndNotAWrite(t *testing.T) {
	f := &fakeClient{designResult: &api.DesignApplyResult{OK: true, Mode: "dry-run"}}
	var out strings.Builder
	if _, err := designApplyGate(f, &out, api.ApplyDesignParams{
		Project: "shop", Env: "dev", Document: []byte("{}"), Stage: true,
	}, false); err != nil {
		t.Fatalf("designApplyGate: %v", err)
	}
	if !f.appliedDesign.DryRun {
		t.Error("the preflight did not ask for a dry run — it would have APPLIED the document")
	}
	if f.appliedDesign.Stage {
		t.Error("the preflight carried --stage; checking a plan must not write it to the review tray")
	}
	if f.appliedDesign.Project != "shop" || f.appliedDesign.Env != "dev" {
		t.Errorf("the preflight asked about %s/%s, not the environment being applied to",
			f.appliedDesign.Project, f.appliedDesign.Env)
	}
}

// projNilDesignClient answers ApplyDesign with (nil, nil) — a server that reported neither a
// plan nor an error. The shared fakeClient cannot express it, and fake_test.go belongs to
// another lane, so the interface is embedded to inherit every other method: none of them is
// called on this path, and a nil embedded interface panics loudly rather than silently
// answering if that ever stops being true.
type projNilDesignClient struct{ apiClient }

func (projNilDesignClient) ApplyDesign(api.ApplyDesignParams) (*api.DesignApplyResult, error) {
	return nil, nil
}

// TestProj_DesignDeletionsMatchTheActionNotItsSpelling pins the classifier. Under-matching
// costs a silent removal; over-matching costs a confirmation nobody needed, so the classifier
// is exact about the SAFE actions and lenient about their case.
//
// `DELETED_STALE` was recorded here as a NON-deletion, on the reasoning that a prefix match would
// over-match it. That reasoning was about the wrong axis: the fix for a bad prefix match is an
// exact one, not a lenient direction, and the exact match let every unrecognised action through as
// safe. It is a deletion now, along with every other action outside the safe set.
func TestProj_DesignDeletionsMatchTheActionNotItsSpelling(t *testing.T) {
	changes := []api.DesignChange{
		{Kind: "a", Action: "DELETE"},
		{Kind: "b", Action: "delete"},
		{Kind: "c", Action: " DELETE "},
		{Kind: "d", Action: "CREATE"},
		{Kind: "e", Action: "UPDATE"},
		{Kind: "f", Action: "DELETED_STALE"},
	}
	got := designDeletions(changes)
	if len(got) != 4 {
		t.Fatalf("designDeletions found %d, want the three spellings of DELETE plus the "+
			"unrecognised action: %+v", len(got), got)
	}
	for _, ch := range got {
		if ch.Kind == "d" || ch.Kind == "e" {
			t.Errorf("%q was read as a deletion", ch.Action)
		}
	}
	if len(designDeletions(nil)) != 0 {
		t.Error("an empty plan has no deletions")
	}
}

// TestProj_DesignApplyGateIsSkippedForDryRunAndStage pins that neither mode pays for a
// preflight. `--dry-run` writes nothing and `--stage` goes to a review tray where a person
// sees the removals before they take effect; a confirmation in front of either would be
// asking about something that is not about to happen.
func TestProj_DesignApplyGateIsSkippedForDryRunAndStage(t *testing.T) {
	for _, mode := range []string{"--dry-run", "--stage"} {
		t.Run(mode, func(t *testing.T) {
			s := &projServer{designChanges: []map[string]any{
				{"kind": "storage_buckets", "name": "receipts", "action": "DELETE"},
			}}
			h := projEnv(t, s)
			asked := 0
			prev := confirm
			confirm = func(string, string) bool { asked++; return false }
			t.Cleanup(func() { confirm = prev })

			if h.run("project", "design", "apply", "--project", "web", "-f", projDesignDoc(t), mode, "--no-input") {
				t.Fatalf("%s must not be gated", mode)
			}
			if asked != 0 {
				t.Errorf("%s asked %d confirmation(s)", mode, asked)
			}
			if len(s.posts) != 1 {
				t.Errorf("%s made %d request(s), want exactly 1 — it must not pay for a preflight: %+v",
					mode, len(s.posts), s.posts)
			}
		})
	}
}

// projAnsi strips ANSI escape sequences.
var projAnsi = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)

// projFlatten renders styled terminal output as one whitespace-normalised line.
//
// Needed because lipgloss styles and may hard-wrap what it renders, so a phrase that is one
// line in the source can arrive split across two with padding in between. Asserting on the raw
// bytes would make these tests fail on a change to the terminal width rather than to the
// message, and asserting on single words would let a rewritten sentence pass.
func projFlatten(s string) string {
	return strings.Join(strings.Fields(projAnsi.ReplaceAllString(s, "")), " ")
}

// TestProj_DesignApplyRefusalTheCOMMANDPrintsNamesTheReason is the assertion that
// TestProj_DesignApplyRefusalNamesWhyYesIsNeeded is NOT.
//
// That one drives errDesignApplyWouldDelete directly and proves the sentence can be
// constructed. It says nothing about whether the command ever reaches it — and it does not,
// if the `noInputMode && !yes` check is removed: confirmDestructive is still underneath and
// still refuses, with the generic "this command is destructive" wording. The command would
// keep exiting 1, every other test here would stay green, and the one thing the ruling asked
// for — that a pipeline author be told adding --yes is not a blanket weakening — would be
// silently gone. Measured: deleting that check leaves this file green except for this test.
func TestProj_DesignApplyRefusalTheCOMMANDPrintsNamesTheReason(t *testing.T) {
	s := &projServer{designChanges: []map[string]any{
		{"kind": "storage_buckets", "name": "receipts", "action": "DELETE"},
	}}
	h := projEnv(t, s)
	out := projCaptureStdout(t)

	if !h.run("project", "design", "apply", "--project", "web", "-f", projDesignDoc(t), "--no-input") {
		t.Fatal("a deleting apply must be refused without --yes")
	}
	got := projFlatten(out())
	for _, want := range []string{
		"--yes",
		"THIS PLAN removes components",
		"an apply that only adds or updates runs unprompted",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the refusal the command printed never says %q.\n  printed: %s", want, got)
		}
	}
	// The generic wording alone is the failure mode: it leads a pipeline author to add --yes
	// permanently, which opts every later replay into removing components.
	if strings.Contains(got, "this command is destructive and interactive prompts are disabled") {
		t.Errorf("the command fell through to the GENERIC destructive refusal:\n  %s", got)
	}
}

// TestProj_DesignDeletionsFailClosedOnAnUnrecognisedAction pins the DIRECTION the classifier fails
// in. An exact match against "DELETE" reads every other spelling as non-destructive, so a server
// that starts sending `REMOVE` or `DELETE_ORPHAN` would apply removals unprompted — and the same
// function already fails CLOSED on an unreadable preflight, so the two halves disagreed.
//
// The safe set is the closed TS union the wire is generated from — CREATE and UPDATE
// (apps/console/lib/config-diff.ts) — and everything outside it is a removal. An action nobody
// recognises costs at most a confirmation, or a refusal under --no-input that NAMES the plan; the
// other direction costs a component.
func TestProj_DesignDeletionsFailClosedOnAnUnrecognisedAction(t *testing.T) {
	for _, action := range []string{"REMOVE", "DELETE_ORPHAN", "DETACH", "", "  ", "destroy"} {
		t.Run("action="+action, func(t *testing.T) {
			got := designDeletions([]api.DesignChange{{Kind: "storage_buckets", Action: action}})
			if len(got) != 1 {
				t.Errorf("action %q was read as non-destructive; an action this build does not "+
					"recognise must reach the confirmation, not bypass it", action)
			}
		})
	}
	// The other direction, so "everything is a deletion" cannot pass this: the two safe ops stay
	// safe under any case, which is what keeps an add-only apply running unprompted in CI.
	for _, action := range []string{"CREATE", "create", " UPDATE ", "Update"} {
		t.Run("safe="+action, func(t *testing.T) {
			if got := designDeletions([]api.DesignChange{{Kind: "a", Action: action}}); len(got) != 0 {
				t.Errorf("action %q was read as a removal; an add-only apply must run unprompted", action)
			}
		})
	}
}
