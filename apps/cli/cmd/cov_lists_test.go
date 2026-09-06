// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// The ~40 list commands all share one shape:
//
//	if interactiveTable(cmd) { RunSpinner(fetch); empty-check; ShowTable/tea; return }
//
// That arm only runs when stdin AND stdout are terminals, which they never are under
// `go test` — so the whole block was dark. Forcing the two TTY seams reaches it. Measured,
// not assumed: ui.RunSpinner runs its action and returns nil, and ui.ShowTable /
// tea.NewProgram return the "could not open a new TTY" error which every call site
// discards, so the block runs to completion without blocking.

// covListExit is the sentinel a trapped exitFunc panics with, so a fatal path is
// observable instead of killing the test binary.
type covListExit struct{ code int }

// covListForceTTY makes interactiveTable(cmd) answer true for the rest of the test,
// restoring the real isatty probes afterwards.
func covListForceTTY(t *testing.T) {
	t.Helper()
	oldIn, oldOut := stdinIsTTY, stdoutIsTTY
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return true }
	t.Cleanup(func() { stdinIsTTY, stdoutIsTTY = oldIn, oldOut })
}

// covListTrapExit swaps os.Exit for a panic carrying the code, so a failf inside a
// command surfaces as a test failure rather than a killed process.
func covListTrapExit(t *testing.T) {
	t.Helper()
	old := exitFunc
	exitFunc = func(code int) { panic(covListExit{code: code}) }
	t.Cleanup(func() { exitFunc = old })
}

// covListResetFlags puts the package-global command tree back to its default flag
// state. rootCmd is shared by every test in the package and cobra keeps parsed
// values, so a --project set here would otherwise leak into an unrelated test.
func covListResetFlags() {
	reset := func(c *cobra.Command) {
		c.Flags().VisitAll(func(f *pflag.Flag) {
			if !f.Changed {
				return
			}
			if sv, ok := f.Value.(pflag.SliceValue); ok {
				_ = sv.Replace(nil)
			} else {
				_ = f.Value.Set(f.DefValue)
			}
			f.Changed = false
		})
	}
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		reset(c)
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	walk(rootCmd)
}

// covListBody returns the JSON body the fake control plane serves for one path.
// When populated is false every collection comes back empty, which is what drives
// the "nothing found" arm of each interactive block.
func covListBody(p string, populated bool) (map[string]interface{}, bool) {
	rows := func(items ...map[string]interface{}) []map[string]interface{} {
		if !populated {
			return []map[string]interface{}{}
		}
		return items
	}
	total := 0
	if populated {
		total = 1
	}

	switch {
	case p == "/api/cli/orgs":
		return map[string]interface{}{"orgs": rows(map[string]interface{}{
			"id": "o1", "name": "Acme", "slug": "acme", "role": "owner", "plan": "team", "is_active": true,
		})}, true
	case p == "/api/cli/configurations":
		return map[string]interface{}{"configurations": rows(map[string]interface{}{
			"id": "p1", "project_name": "web", "environment_stage": "production",
			"status": "ACTIVE", "cloud_provider": "aws", "region": "eu-west-1",
		})}, true
	case strings.HasPrefix(p, "/api/cli/configurations/by-project-name/"):
		return map[string]interface{}{"configuration": map[string]interface{}{
			"id": "p1", "project_name": "web", "environment_stage": "production",
			"container_platform": "eks", "cloud_account_id": "1234", "region": "eu-west-1",
			"iac_version": "1.9.0", "user_id": "u1",
		}}, true
	case p == "/api/cli/runners":
		return map[string]interface{}{"runners": rows(map[string]interface{}{
			"id": "r1", "name": "primary", "operator": "managed", "status": "ONLINE", "is_default": true,
		})}, true
	case p == "/api/cli/clusters":
		return map[string]interface{}{"clusters": rows(map[string]interface{}{
			"id": "c1", "cluster_name": "prod", "cluster_version": "1.30", "status": "ACTIVE",
			"project_name": "web", "environment": "production", "region": "eu-west-1",
		})}, true
	case p == "/api/cli/cloud-identities":
		return map[string]interface{}{"cloud_identities": rows(map[string]interface{}{
			"id": "ci1", "provider": "aws", "label": "prod-account", "created_at": "2026-01-01T00:00:00Z",
		})}, true
	case p == "/api/cli/channels":
		return map[string]interface{}{"channels": rows(map[string]interface{}{
			"id": "ch1", "name": "oncall", "type": "slack", "is_verified": true, "enabled": true,
		})}, true
	case p == "/api/cli/alerts":
		return map[string]interface{}{"alert_rules": rows(map[string]interface{}{
			"id": "al1", "name": "deploy failures", "severity": "critical",
			"event_patterns": []string{"job.failed"}, "channel_ids": []string{"ch1"}, "enabled": true,
		})}, true
	case p == "/api/cli/activity":
		return map[string]interface{}{"activity": rows(map[string]interface{}{
			"ts": "2026-01-01T00:00:00Z", "actor_id": "u1", "actor_email": "ada@x.com",
			"action": "project.deploy", "resource_type": "project", "resource_id": "p1", "decision": true,
		})}, true
	case p == "/api/cli/roles":
		return map[string]interface{}{"roles": rows(map[string]interface{}{
			"id": "ro1", "name": "deployer", "is_builtin": false, "permission_keys": []string{"project:deploy"},
		})}, true
	case p == "/api/cli/grants":
		return map[string]interface{}{"grants": rows(map[string]interface{}{
			"id": "g1", "principal_type": "user", "principal_id": "u1", "effect": "allow", "role": "deployer",
		})}, true
	case p == "/api/cli/sso":
		return map[string]interface{}{"sso_providers": rows(map[string]interface{}{
			"id": "s1", "provider_type": "oidc", "domain": "acme.com", "issuer": "https://idp", "enabled": true,
		})}, true
	case p == "/api/cli/fleet":
		return map[string]interface{}{"pools": rows(map[string]interface{}{
			"provider": "hetzner", "enabled": true, "warm_min": 1, "max": 4,
			"slots_per_runner": 2, "locations": []string{"fsn1"}, "channel": "stable",
		})}, true
	case p == "/api/cli/agents":
		return map[string]interface{}{"agents": rows(map[string]interface{}{
			"id": "ag1", "persona": "sre", "tool_scope": []string{"plan"},
			"memory_namespace": "acme", "version": 1,
		})}, true
	case p == "/api/cli/classification/dimensions":
		return map[string]interface{}{"dimensions": rows(map[string]interface{}{
			"key": "sensitivity", "label": "Sensitivity", "multi": false,
			"applies_to": []string{"project"},
			"values":     []map[string]interface{}{{"value": "high", "label": "High"}},
		})}, true
	case p == "/api/cli/classification/assignments":
		return map[string]interface{}{"assignments": rows(map[string]interface{}{
			"dimension_label": "Sensitivity", "value_label": "High",
		})}, true
	case strings.HasPrefix(p, "/api/cli/repositories/"):
		return map[string]interface{}{"repositories": rows(map[string]interface{}{
			"name": "app", "full_name": "acme/app", "private": true,
			"default_branch": "main", "url": "https://github.com/acme/app",
		})}, true
	case strings.HasSuffix(p, "/members"):
		return map[string]interface{}{"members": rows(map[string]interface{}{
			"id": "m1", "user_id": "u1", "email": "a@x.com", "name": "A", "role": "owner", "status": "active",
		})}, true
	case strings.HasSuffix(p, "/teams"):
		return map[string]interface{}{"teams": rows(map[string]interface{}{
			"id": "t1", "name": "Platform", "member_count": 2,
		})}, true
	case strings.HasSuffix(p, "/environments"):
		return map[string]interface{}{"environments": rows(map[string]interface{}{
			"id": "e1", "name": "production", "stage": "production", "status": "ACTIVE",
			"is_default": true, "region": "eu-west-1",
		})}, true
	case strings.HasSuffix(p, "/components"):
		return map[string]interface{}{"components": rows(map[string]interface{}{
			"kind": "cluster", "name": "prod", "status": "ACTIVE",
		})}, true
	case strings.HasSuffix(p, "/protection"):
		return map[string]interface{}{"rules": rows(map[string]interface{}{
			"environment": "production", "require_predecessor": true, "require_verify_pass": true,
			"require_approval": true, "min_count": 2,
		})}, true
	case strings.HasSuffix(p, "/probes"):
		return map[string]interface{}{"probes": rows(map[string]interface{}{
			"environment_id": "e1", "environment": "production", "reachable": true,
			"probed_at": "2026-01-01T00:00:00Z",
		})}, true
	case strings.HasSuffix(p, "/addons"):
		return map[string]interface{}{
			"environment": "production",
			"addons": rows(map[string]interface{}{
				"addon_id": "argocd", "enabled": true, "mode": "managed",
				"version": "7.0.0", "status": "INSTALLED", "health": "Healthy",
			}),
		}, true
	case strings.HasSuffix(p, "/byo-charts"):
		return map[string]interface{}{
			"environment": "production",
			"charts": rows(map[string]interface{}{
				"id": "bc1", "repo_url": "https://github.com/acme/charts", "chart_path": "charts/api",
				"ref": "main", "namespace": "api", "status": "SYNCED", "scan_status": "PASS",
			}),
		}, true
	case strings.HasSuffix(p, "/promotions"):
		return map[string]interface{}{"promotions": rows(map[string]interface{}{
			"id": "pr1", "source": "staging", "target": "production",
			"status": "PENDING", "created_at": "2026-01-01T00:00:00Z",
		})}, true
	case strings.HasSuffix(p, "/staged"):
		return map[string]interface{}{
			"environment": "production",
			"changes": rows(map[string]interface{}{
				"op": "add", "component_type": "cache", "component_id": "cmp1",
				"created_at": "2026-01-01T00:00:00Z",
			}),
		}, true
	case p == "/api/jobs":
		return map[string]interface{}{
			"jobs": rows(map[string]interface{}{
				"id": "j1", "job_type": "PLAN", "status": "SUCCESS",
				"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
				"config_snapshot": map[string]interface{}{},
			}),
			"total": total, "limit": 20, "offset": 0,
		}, true
	}
	return nil, false
}

// covListMode selects what the fake control plane serves.
type covListMode int

const (
	// covListPopulated serves one row per collection: the render arm.
	covListPopulated covListMode = iota
	// covListEmpty serves empty collections: the "nothing found" arm.
	covListEmpty
	// covListBroken serves 500s: the fetch-failure arm inside each block.
	covListBroken
)

// covListEnv stands up the fake control plane every interactive list command reads,
// with valid credentials in an isolated home and an active org, and returns a runner
// that drives the real cobra tree with the interactive table arm enabled. The runner
// returns the exit code a fatal path asked for, or 0.
func covListEnv(t *testing.T, mode covListMode) func(args ...string) int {
	t.Helper()
	return covListEnvFormat(t, mode, "table")
}

// covListEnvFormat is covListEnv with the --output value chosen by the caller, so
// the same fake control plane can drive the non-interactive render arm ("json")
// as well as the interactive table one.
func covListEnvFormat(t *testing.T, mode covListMode, format string) func(args ...string) int {
	t.Helper()
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatal(err)
	}
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme"}); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if mode == covListBroken {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"error": "control plane unavailable"})
			return
		}
		body, ok := covListBody(r.URL.Path, mode == covListPopulated)
		if !ok {
			t.Errorf("fake control plane got an unmapped path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			body = map[string]interface{}{"error": "not found"}
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)

	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	covListForceTTY(t)
	covListTrapExit(t)
	t.Cleanup(covListResetFlags)

	return func(args ...string) (code int) {
		// BOTH ends. Resetting only on the way out protects the next invocation but leaves this
		// one at the mercy of whichever file `go test` reached first: TestList_ProjectScopedListsRequireProject
		// drops --project from each command's arguments and asserts the refusal, and under
		// `-shuffle` it found `addon list` still carrying a --project set two files earlier.
		covListResetFlags()
		defer func() {
			covListResetFlags()
			if r := recover(); r != nil {
				e, ok := r.(covListExit)
				if !ok {
					panic(r)
				}
				code = e.code
			}
		}()
		execRootArgs(append(args, "--output", format))
		if err := rootCmd.Execute(); err != nil {
			t.Errorf("%v: %v", args, err)
		}
		return 0
	}
}

// covListCase is one list command's interactive-table arm.
type covListCase struct {
	args []string
	// fatalOnTableError marks the commands that build the bubbletea program inline
	// and call failf on its error, instead of discarding it the way ui.ShowTable's
	// callers do with `_ =`. On a headless terminal the program cannot start, so
	// these five exit 1 while the rest return cleanly.
	fatalOnTableError bool
}

// covListCommands is every list command whose interactive-table arm this file
// exercises, with the arguments each one needs to resolve its target.
var covListCommands = []covListCase{
	{args: []string{"activity"}},
	{args: []string{"addon", "list", "--project", "web"}},
	{args: []string{"agent", "list"}},
	{args: []string{"alerts", "list"}},
	{args: []string{"channels", "list"}},
	{args: []string{"chart", "list", "--project", "web"}},
	{args: []string{"classification", "dimensions"}},
	{args: []string{"classification", "show", "project", "p1"}},
	{args: []string{"cluster", "list"}, fatalOnTableError: true},
	{args: []string{"connector", "list"}, fatalOnTableError: true},
	{args: []string{"fleet", "list"}},
	{args: []string{"grants", "list"}},
	{args: []string{"jobs", "list"}, fatalOnTableError: true},
	{args: []string{"members", "list"}},
	{args: []string{"org", "list"}},
	{args: []string{"probes", "list", "--project", "web"}},
	{args: []string{"project", "component", "list", "--project", "web"}},
	{args: []string{"project", "env", "list", "--project", "web"}},
	{args: []string{"project", "list"}, fatalOnTableError: true},
	{args: []string{"promotion", "list", "--project", "web"}},
	{args: []string{"protection", "list", "--project", "web"}},
	{args: []string{"repo", "list"}},
	{args: []string{"roles", "list"}},
	{args: []string{"runner", "list"}, fatalOnTableError: true},
	{args: []string{"sso", "list"}},
	{args: []string{"staged", "list", "--project", "web"}},
	{args: []string{"teams", "list"}},
}

// TestList_InteractiveTableRendersEveryList pins that, on a terminal with prompts
// enabled and a non-empty result, every list command takes the interactive-table
// arm: the spinner runs the fetch, the rows are projected, and the table program is
// started. Commands whose call site discards the program's error return cleanly;
// the five that pass it to failf exit 1.
func TestList_InteractiveTableRendersEveryList(t *testing.T) {
	run := covListEnv(t, covListPopulated)
	for _, tc := range covListCommands {
		t.Run(strings.Join(tc.args, "_"), func(t *testing.T) {
			want := 0
			if tc.fatalOnTableError {
				want = 1
			}
			if got := run(tc.args...); got != want {
				t.Errorf("exit code = %d, want %d", got, want)
			}
		})
	}
}

// TestList_InteractiveTableEmptyResultShortCircuits pins the other arm: with an
// empty result every list command prints its "nothing found" note and returns
// before building any table, so none of them can fail on the table program.
func TestList_InteractiveTableEmptyResultShortCircuits(t *testing.T) {
	run := covListEnv(t, covListEmpty)
	for _, tc := range covListCommands {
		t.Run(strings.Join(tc.args, "_"), func(t *testing.T) {
			if got := run(tc.args...); got != 0 {
				t.Errorf("exit code = %d, want 0", got)
			}
		})
	}
}

// TestList_InteractiveTableFetchFailureIsFatal pins the third arm: when the control
// plane rejects the fetch, the interactive block reports it fatally rather than
// rendering an empty table.
func TestList_InteractiveTableFetchFailureIsFatal(t *testing.T) {
	run := covListEnv(t, covListBroken)
	for _, tc := range covListCommands {
		t.Run(strings.Join(tc.args, "_"), func(t *testing.T) {
			if got := run(tc.args...); got != 1 {
				t.Errorf("exit code = %d, want 1", got)
			}
		})
	}
}

// TestList_ProjectScopedListsRequireProject pins that the project-scoped lists fail
// fast when neither --project nor an argument names a project, instead of calling
// the control plane with an empty project.
func TestList_ProjectScopedListsRequireProject(t *testing.T) {
	run := covListEnv(t, covListPopulated)
	for _, tc := range covListCommands {
		trimmed := []string{}
		scoped := false
		for i := 0; i < len(tc.args); i++ {
			if tc.args[i] == "--project" {
				scoped = true
				i++
				continue
			}
			trimmed = append(trimmed, tc.args[i])
		}
		if !scoped {
			continue
		}
		t.Run(strings.Join(trimmed, "_"), func(t *testing.T) {
			if got := run(trimmed...); got != 1 {
				t.Errorf("exit code = %d, want 1", got)
			}
		})
	}
}

// TestList_UnauthenticatedListIsFatal pins that every list command stops at the
// token check when there are no stored credentials and the "log in now?" prompt is
// declined — none of them reach the control plane unauthenticated.
func TestList_UnauthenticatedListIsFatal(t *testing.T) {
	isolatedHome(t) // no credentials written
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	covListForceTTY(t)
	covListTrapExit(t)
	t.Cleanup(covListResetFlags)

	oldPrompt := authRequiredPrompt
	authRequiredPrompt = func() (bool, error) { return false, nil }
	t.Cleanup(func() { authRequiredPrompt = oldPrompt })

	run := func(args ...string) (code int) {
		defer func() {
			covListResetFlags()
			if r := recover(); r != nil {
				e, ok := r.(covListExit)
				if !ok {
					panic(r)
				}
				code = e.code
			}
		}()
		execRootArgs(append(args, "--output", "table"))
		if err := rootCmd.Execute(); err != nil {
			t.Errorf("%v: %v", args, err)
		}
		return 0
	}

	for _, tc := range covListCommands {
		t.Run(strings.Join(tc.args, "_"), func(t *testing.T) {
			if got := run(tc.args...); got != 1 {
				t.Errorf("exit code = %d, want 1", got)
			}
		})
	}
}

// TestList_ProjectGetDeclinesBrowserPromptOnTTY pins that `project get` only offers
// the "Open in Browser?" prompt on an interactive terminal, and that a prompt which
// cannot be answered (no TTY behind the seam) leaves the browser unopened.
func TestList_ProjectGetDeclinesBrowserPromptOnTTY(t *testing.T) {
	run := covListEnv(t, covListPopulated)
	opened := false
	oldOpen := openBrowser
	openBrowser = func(string) error { opened = true; return nil }
	t.Cleanup(func() { openBrowser = oldOpen })

	run("project", "get", "web")

	if opened {
		t.Error("browser opened even though the confirm prompt was never answered")
	}
}

// TestList_ProjectGetOpensBrowserWhenConfirmed pins the confirmed arm: answering the
// interactive prompt yes opens the dashboard URL.
func TestList_ProjectGetOpensBrowserWhenConfirmed(t *testing.T) {
	run := covListEnv(t, covListPopulated)
	oldConfirm := confirm
	confirm = func(string, string) bool { return true }
	t.Cleanup(func() { confirm = oldConfirm })

	var got string
	oldOpen := openBrowser
	openBrowser = func(url string) error { got = url; return nil }
	t.Cleanup(func() { openBrowser = oldOpen })

	run("project", "get", "web")

	if !strings.HasSuffix(got, "/dashboard") {
		t.Errorf("openBrowser url = %q, want the dashboard URL", got)
	}
	if !strings.HasPrefix(got, os.Getenv("ALETHIA_WEB_ORIGIN")) {
		t.Errorf("openBrowser url = %q, want it rooted at the configured web origin", got)
	}
}

// covListWithBrokenStdout runs fn with os.Stdout pointed at a read-only handle, so
// every write to it fails with EBADF.
//
// This is the only way to reach the `if err := render…(os.Stdout, …); err != nil`
// arms of the list commands: the writer is not a parameter, and ui.Render's own
// error return is otherwise unreachable because outputFormat() already rejects an
// unknown format before the render is ever called. Only the json/csv encoders
// propagate a write error — the static table renderer discards it — so callers of
// this helper must ask for json.
//
// os.Stdout is restored on the way out rather than via t.Cleanup, to keep the
// window in which the testing package's own reporting could hit the broken handle
// as narrow as possible.
func covListWithBrokenStdout(t *testing.T, fn func()) {
	t.Helper()
	f, err := os.OpenFile(os.DevNull, os.O_RDONLY, 0)
	if err != nil {
		t.Fatalf("open %s read-only: %v", os.DevNull, err)
	}
	old := os.Stdout
	os.Stdout = f
	defer func() {
		os.Stdout = old
		_ = f.Close()
	}()
	fn()
}

// covListInlineRenderCommands are the list commands that render inline in the
// non-interactive arm — `renderX(os.Stdout, …)` straight in the RunE body rather
// than inside a run*List helper whose error the fetch already exercises. For these
// the render error is the only way into their fail(err) branch.
var covListInlineRenderCommands = [][]string{
	{"cluster", "list"},
	{"connector", "list"},
	{"jobs", "list"},
	{"project", "list"},
	{"runner", "list"},
}

// TestList_RenderWriteFailureIsFatal pins that a list command which cannot write
// its rendered output reports that fatally instead of exiting 0 having printed
// nothing. Each command is run twice against the same populated control plane —
// once with a working stdout, which must succeed, and once with a stdout that
// rejects every write, which must exit 1 — so the difference is attributable to
// the render and not to an earlier stage.
func TestList_RenderWriteFailureIsFatal(t *testing.T) {
	run := covListEnvFormat(t, covListPopulated, "json")
	for _, args := range covListInlineRenderCommands {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if got := run(args...); got != 0 {
				t.Fatalf("baseline exit code = %d, want 0", got)
			}
			var got int
			covListWithBrokenStdout(t, func() { got = run(args...) })
			if got != 1 {
				t.Errorf("exit code with an unwritable stdout = %d, want 1", got)
			}
		})
	}
}

// TestList_NoInputSkipsTheInteractiveTable pins that --no-input beats a terminal:
// even with both TTY probes forced true, the list commands take the static render
// arm. It is observable because `cluster list` is one of the commands that treats
// a failed table program as fatal — interactive it exits 1 on this headless
// terminal, non-interactive it renders and exits 0.
func TestList_NoInputSkipsTheInteractiveTable(t *testing.T) {
	run := covListEnv(t, covListPopulated)

	// noInputMode is a package global the root PersistentPreRun writes. Every run
	// through rootCmd recomputes it, but restore it anyway so a test that never
	// executes a command cannot inherit this one's --no-input.
	oldNoInput := noInputMode
	t.Cleanup(func() { noInputMode = oldNoInput })

	if got := run("cluster", "list"); got != 1 {
		t.Fatalf("interactive exit code = %d, want 1 (the table program cannot start headless)", got)
	}
	if got := run("cluster", "list", "--no-input"); got != 0 {
		t.Errorf("--no-input exit code = %d, want 0 (static render, no table program)", got)
	}
}
