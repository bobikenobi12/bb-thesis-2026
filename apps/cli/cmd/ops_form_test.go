// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charmbracelet/huh"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

// The break-glass group's forms, and the three other renderings of the same fields.
//
// Every identifier here carries the opsForm prefix so it cannot collide with another group's
// helpers in this package. The forms are DRIVEN, not stubbed — see the note at the top of
// hyg_cli_authform_test.go for why, and for the two bubbletea mechanics that make it work. This
// file reuses that harness (authFormAnswer / authFormScript / authFormType) rather than growing a
// second one.

// ── the environment ─────────────────────────────────────────────────────────────────────────────

// opsFormServer records every request the CLI made, as "METHOD path".
type opsFormServer struct {
	mu       sync.Mutex
	requests []string
	bodies   map[string][]string
}

func (s *opsFormServer) record(r *http.Request) {
	// The body is read and PUT BACK. A handler downstream decodes it, and a recorder that consumed
	// it would make every such handler see an empty document — a fake that breaks the thing it is
	// observing. Recording is additive: no existing assertion changes shape.
	var raw []byte
	if r.Body != nil {
		raw, _ = io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(raw))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := r.Method + " " + r.URL.Path
	s.requests = append(s.requests, key)
	if len(raw) > 0 {
		if s.bodies == nil {
			s.bodies = map[string][]string{}
		}
		s.bodies[key] = append(s.bodies[key], string(raw))
	}
}

// body returns the single body posted to this route, failing when there was not exactly one.
//
// Exactly one, deliberately: "the first of several" hides a command that posted twice, and a
// helper that returns "" for none would let an assertion about the payload pass against a request
// that never happened.
func (s *opsFormServer) body(t *testing.T, method, path string) string {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	got := s.bodies[method+" "+path]
	if len(got) != 1 {
		t.Fatalf("%s %s: recorded %d bodies, want exactly 1 (all requests: %v)", method, path, len(got), s.requests)
	}
	return got[0]
}

// saw reports whether the CLI made this exact request.
func (s *opsFormServer) saw(method, path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, req := range s.requests {
		if req == method+" "+path {
			return true
		}
	}
	return false
}

// sawAny reports whether any request's path contains the fragment. Used for the negative
// assertions — "no listing call was made" — where the exact query string does not matter.
func (s *opsFormServer) sawAny(fragment string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, req := range s.requests {
		if strings.Contains(req, fragment) {
			return true
		}
	}
	return false
}

// all returns every request the CLI made, for a failure message.
func (s *opsFormServer) all() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.requests...)
}

// opsFormExit is the sentinel a trapped exitFunc panics with, so a fatal path is observable as an
// exit code instead of killing the test binary.
type opsFormExit struct{ code int }

// opsFormEnv stands up isolated credentials, an active org and a fake control plane, traps
// exitFunc, and returns the recorder, a pointer to the decoded execute body (zero-valued until one
// is posted), and a runner that drives the real cobra tree and reports the exit code the command
// asked for.
func opsFormEnv(t *testing.T) (*opsFormServer, *api.BreakglassExecuteParams, func(args ...string) int) {
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

	s := &opsFormServer{}
	executed := &api.BreakglassExecuteParams{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.record(r)
		enc := json.NewEncoder(w)
		switch p := r.URL.Path; {
		case p == "/api/jobs":
			_ = enc.Encode(map[string]any{"jobs": []map[string]any{
				{"id": "job-alpha", "job_type": "DEPLOY", "status": "PROCESSING", "project_name": "web", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"},
				{"id": "job-beta", "job_type": "PLAN", "status": "FAILED", "project_name": "api", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"},
			}, "total": 2, "limit": 50, "offset": 0})
		case p == "/api/cli/runners":
			_ = enc.Encode(map[string]any{"runners": []map[string]any{
				{"id": "runner-alpha", "name": "eu-1", "operator": "managed", "status": "ONLINE", "is_default": true, "created_at": "2026-01-01T00:00:00Z"},
				{"id": "runner-beta", "name": "eu-2", "operator": "self", "provisioning": "deployed", "status": "OFFLINE", "created_at": "2026-01-01T00:00:00Z"},
			}})
		case p == "/api/cli/configurations":
			_ = enc.Encode(map[string]any{"configurations": []map[string]any{
				{"id": "project-alpha", "project_name": "web", "environment_stage": "production", "status": "ACTIVE", "region": "eu-central-1", "cloud_provider": "aws", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"},
			}})
		case strings.HasSuffix(p, "/environments"):
			_ = enc.Encode(map[string]any{"environments": []map[string]any{
				{"id": "env-alpha", "name": "prod", "stage": "production", "status": "PROVISIONING", "is_default": true, "placement_mode": "namespace"},
			}})
		case p == "/api/breakglass/session":
			_ = enc.Encode(map[string]any{"sessionId": "sess-1", "expiresAt": "2026-01-01T01:00:00Z", "operator": "ops@alethialabs.io"})
		case p == "/api/breakglass/approval":
			_ = enc.Encode(map[string]any{"approvalId": "appr-1", "action": "state_surgery", "resourceId": "k1", "expiresAt": "2026-01-01T01:00:00Z", "approver": "second@alethialabs.io", "note": "different person"})
		case p == "/api/breakglass/execute":
			var got api.BreakglassExecuteParams
			_ = json.NewDecoder(r.Body).Decode(&got)
			*executed = got
			_ = enc.Encode(map[string]any{"ok": true, "detail": "done", "data": map[string]any{"rows": 1}})
		default:
			_ = enc.Encode(map[string]any{"ok": true})
		}
	}))
	t.Cleanup(srv.Close)

	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	prevExit := exitFunc
	exitFunc = func(code int) { panic(opsFormExit{code: code}) }
	t.Cleanup(func() {
		exitFunc = prevExit
		hygCliConfirmResetFlags()
	})

	run := func(args ...string) (code int) {
		defer func() {
			hygCliConfirmResetFlags()
			if r := recover(); r != nil {
				e, ok := r.(opsFormExit)
				if !ok {
					panic(r)
				}
				code = e.code
			}
		}()
		hygCliConfirmResetFlags()
		// execRootArgs, not rootCmd.SetArgs: it returns --output, --no-input and --token to their
		// defaults first. cobra keeps a flag's value AND its Changed bit across Execute calls, so a
		// --no-input this file passes becomes the next file's default.
		execRootArgs(args)
		if err := rootCmd.Execute(); err != nil {
			return 1
		}
		return 0
	}
	return s, executed, run
}

// opsFormInteractive makes both stdin and stdout look like terminals, which is what
// requireInteractiveForm asks for. A headless `go test` process has neither.
func opsFormInteractive(t *testing.T) {
	t.Helper()
	prevIn, prevOut := stdinIsTTY, stdoutIsTTY
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return true }
	t.Cleanup(func() { stdinIsTTY, stdoutIsTTY = prevIn, prevOut })
}

// opsFormAlwaysConfirm answers every confirmation with yes, for the tests whose subject is the
// prompting rather than the confirmation. The confirmation itself has its own file.
func opsFormAlwaysConfirm(t *testing.T) {
	t.Helper()
	prev := confirm
	confirm = func(string, string) bool { return true }
	t.Cleanup(func() { confirm = prev })
}

// ── rendering 1 · the flags and positionals ─────────────────────────────────────────────────────

// TestOpsForm_EveryFieldNamesARealFlagOrPositional is the "flags stay a COMPLETE contract" half:
// anything a form can ask, the command line can set.
//
// It resolves each spec entry against the LIVE cobra tree. The flags are registered FROM this
// table (registerOpsVerb), so the flag half of this assertion cannot fail for a spelling mismatch —
// what it does catch, and what would otherwise be silent, is a verb added to the group with
// opsCmd.AddCommand instead of registerOpsVerb: it would carry no --reason at all, and every entry
// naming it would fail here. The help-text assertion has the same character, and is stated as such
// rather than dressed up as a drift check.
//
// The POSITIONAL half is NOT derived — Use strings are written by hand — so that one is a real
// mismatch check, and it is the one that fails when a spec row and a command disagree.
func TestOpsForm_EveryFieldNamesARealFlagOrPositional(t *testing.T) {
	if len(opsFields) == 0 {
		t.Fatal("opsFields is empty — every assertion below would pass having checked nothing")
	}
	for _, f := range opsFields {
		t.Run(f.Command+"/"+f.Key, func(t *testing.T) {
			if (f.Flag == "") == (f.Arg == "") {
				t.Fatalf("exactly one of Flag and Arg must be set; got Flag=%q Arg=%q", f.Flag, f.Arg)
			}
			if strings.TrimSpace(f.Title) == "" || strings.TrimSpace(f.Description) == "" {
				t.Fatalf("a field with no title or no description renders as an unlabelled question")
			}
			cmd, _, err := rootCmd.Find(opsCommandPath(f.Command))
			if err != nil || cmd.CommandPath() != f.Command {
				t.Fatalf("no command %q in the tree (found %q, err %v)", f.Command, cmd.CommandPath(), err)
			}
			if f.Flag != "" {
				flag := cmd.Flags().Lookup(f.Flag)
				if flag == nil {
					t.Errorf("%s asks for %q in its form and has NO --%s flag.\n"+
						"      A form field a flag cannot set means --no-input can never answer it, so the\n"+
						"      command is unusable from a runbook for the one value it exists to take.",
						f.Command, f.Title, f.Flag)
					return
				}
				if flag.Usage != f.Description {
					t.Errorf("%s --%s help text is %q; the spec says %q — the third rendering has drifted",
						f.Command, f.Flag, flag.Usage, f.Description)
				}
				return
			}
			if !strings.Contains(cmd.Use, f.Arg) {
				t.Errorf("%s asks for %q in its form and its Use %q does not carry the positional %q",
					f.Command, f.Title, cmd.Use, f.Arg)
			}
		})
	}
}

// opsFormLeafTakesInput records, for every leaf in the group, whether it takes a value from the
// person running it. The SET is derived from the command tree; only the answer is written down, so
// a new `alethia ops …` subcommand fails this test until somebody decides which side it is on.
//
// Every one of them is `true`, and that is the point: a break-glass verb with no input would be a
// verb that acts on something it was never told about.
var opsFormLeafTakesInput = map[string]bool{
	"alethia ops session":            true,
	"alethia ops approve":            true,
	"alethia ops inspect-job":        true,
	"alethia ops retry-job":          true,
	"alethia ops cancel-job":         true,
	"alethia ops unstick-env":        true,
	"alethia ops drain-runner":       true,
	"alethia ops restart-runner":     true,
	"alethia ops force-release-lock": true,
	"alethia ops state-surgery":      true,
	"alethia ops orphan-detect":      true,
	"alethia ops orphan-clean":       true,
	"alethia ops replay-webhook":     true,
}

// TestOpsForm_EveryGroupLeafIsClassified closes the gap between "the group has a field spec" and
// "the field spec covers the group".
//
// The derived set and the table must match EXACTLY, in both directions. A count floor would not do:
// every leaf here can be named, and a floor passes with the interesting half deleted.
func TestOpsForm_EveryGroupLeafIsClassified(t *testing.T) {
	commands := opsGroupCommands(rootCmd)
	if len(commands) == 0 {
		t.Fatal("the walk found no commands under `ops` — every assertion below is vacuous")
	}

	fieldsFor := map[string]int{}
	for _, f := range opsFields {
		fieldsFor[f.Command]++
	}

	seen := map[string]bool{}
	for _, c := range commands {
		path := c.CommandPath()
		seen[path] = true
		takesInput, classified := opsFormLeafTakesInput[path]
		if !classified {
			t.Errorf("%s is a leaf of this group and nothing says whether it takes input.\n"+
				"      Classify it in opsFormLeafTakesInput: a leaf that takes a value needs an\n"+
				"      interactive path and rows in opsFields; one that takes none needs neither.", path)
			continue
		}
		if takesInput && fieldsFor[path] == 0 {
			t.Errorf("%s takes input and has no opsFields rows — nothing describes the questions it asks", path)
		}
		if !takesInput && fieldsFor[path] > 0 {
			t.Errorf("%s is recorded as taking no input and has %d opsFields entries", path, fieldsFor[path])
		}
	}
	for path := range opsFormLeafTakesInput {
		if !seen[path] {
			t.Errorf("opsFormLeafTakesInput names %q, which the walk did not reach — it is gone or renamed", path)
		}
	}
}

// ── rendering 2 · the docs ──────────────────────────────────────────────────────────────────────

// TestOpsForm_DocsFieldTablesMirrorTheSpec is the docs half of "one field spec, four renderings".
//
// A docs page is the only one of the four renderings a compiler cannot see, which is why it is the
// one that goes stale. This page had shipped `--from PROVISIONING,DEPLOYING --to READY` as its
// worked example, and neither DEPLOYING nor READY has ever been a project_status.
func TestOpsForm_DocsFieldTablesMirrorTheSpec(t *testing.T) {
	page := filepath.Join(authFormRepoRoot(t), docsOpsPage)

	byCommand := map[string][]opsField{}
	var order []string
	for _, f := range opsFields {
		if _, ok := byCommand[f.Command]; !ok {
			order = append(order, f.Command)
		}
		byCommand[f.Command] = append(byCommand[f.Command], f)
	}
	if len(order) == 0 {
		t.Fatal("no commands carry fields — this guard would check nothing")
	}

	for _, command := range order {
		fields := byCommand[command]
		t.Run(command, func(t *testing.T) {
			marker := "{/* fieldspec: " + command + " */}"
			rows, ok := authFormTable(t, page, marker)
			if !ok {
				t.Fatalf("ops.mdx carries no table after %s.\n"+
					"      The form asks %d question(s) that nothing in the docs describes.",
					marker, len(fields))
			}
			if len(rows) != len(fields) {
				t.Fatalf("ops.mdx documents %d field(s) after %s; the form asks %d.\n      docs: %v",
					len(rows), marker, len(fields), rows)
			}
			for i, f := range fields {
				setter := "`" + f.Arg + "`"
				if f.Flag != "" {
					setter = "`--" + f.Flag + "`"
				}
				want := []string{f.Title, f.Description, setter}
				got := rows[i]
				if len(got) < 3 {
					t.Errorf("row %d has %d cells, want at least 3: %v", i+1, len(got), got)
					continue
				}
				for j, w := range want {
					if got[j] != w {
						t.Errorf("%s row %d cell %d:\n       docs: %q\n       spec: %q",
							command, i+1, j+1, got[j], w)
					}
				}
			}
		})
	}
}

// TestOpsForm_NoPlaceholderHandoffsRemain is the "<placeholder> handoffs go to zero" half.
//
// A token a reader must copy out of a previous command's output is the thing the programme exists
// to remove, and a `<job_id>` in a runnable example is exactly that handoff written down. The
// fenced blocks are the lines a reader copies, so those are the lines held to it; the fieldspec
// TABLES still carry `[job-id]`, which is the positional's name and not a value to substitute.
func TestOpsForm_NoPlaceholderHandoffsRemain(t *testing.T) {
	body, err := os.ReadFile(filepath.Join(authFormRepoRoot(t), docsOpsPage))
	if err != nil {
		t.Fatalf("read ops.mdx: %v", err)
	}
	examples := docsFencedExamples(string(body))
	if len(examples) == 0 {
		t.Fatal("ops.mdx shows no `alethia …` invocation — every assertion below is vacuous")
	}
	for _, example := range examples {
		for _, bad := range []string{"<", ">", "…", "[", "]"} {
			if strings.Contains(example, bad) {
				t.Errorf("%q carries %q — a runnable example must be runnable as written, not a "+
					"template a reader fills in from a previous command's output", example, bad)
			}
		}
	}
}

// ── behaviour · the reason ──────────────────────────────────────────────────────────────────────

// TestOpsForm_ReasonIsAskedForAndUsed drives the prompt every verb needs.
func TestOpsForm_ReasonIsAskedForAndUsed(t *testing.T) {
	_, executed, run := opsFormEnv(t)
	opsFormInteractive(t)
	opsFormAlwaysConfirm(t)
	scripts := authFormAnswer(t, &authFormScript{keys: authFormType("incident-4711-runner-wedged")})

	if got := run("ops", "cancel-job", "job-alpha"); got != 0 {
		t.Fatalf("exit code = %d, want 0", got)
	}
	if !scripts[0].ran {
		t.Fatal("no form was opened for the reason")
	}
	if executed.Reason != "incident-4711-runner-wedged" {
		t.Errorf("reason reached the server as %q, want the answer that was typed", executed.Reason)
	}
}

// TestOpsForm_ScriptedWithoutAReasonNamesTheFlag pins the arm a pipeline hits.
func TestOpsForm_ScriptedWithoutAReasonNamesTheFlag(t *testing.T) {
	s, _, run := opsFormEnv(t)
	if got := run("ops", "cancel-job", "job-alpha", "--no-input", "--yes"); got != 1 {
		t.Fatalf("exit code = %d, want 1 — a break-glass verb with no reason must not proceed", got)
	}
	if s.sawAny("/api/breakglass") {
		t.Errorf("the refusal cost a round trip: %v", s.all())
	}
}

// TestOpsForm_TooShortAReasonIsRefusedBeforeTheRoundTrip pins the length bound the server enforces.
//
// The CLI rejects only what the server certainly rejects. An eight-character reason is accepted and
// goes unexamined; a seven-character one is refused here rather than costing a session, a 400 and a
// zod issue list in the middle of an incident.
func TestOpsForm_TooShortAReasonIsRefusedBeforeTheRoundTrip(t *testing.T) {
	s, executed, run := opsFormEnv(t)
	if got := run("ops", "cancel-job", "job-alpha", "--reason", "sevench", "--no-input", "--yes"); got != 1 {
		t.Fatalf("exit code = %d, want 1", got)
	}
	if s.sawAny("/api/breakglass") {
		t.Errorf("a reason the server would refuse still cost a round trip: %v", s.all())
	}

	s2, executed2, run2 := opsFormEnv(t)
	_ = executed
	if got := run2("ops", "cancel-job", "job-alpha", "--reason", "eightchr", "--no-input", "--yes"); got != 0 {
		t.Fatalf("exit code = %d, want 0 — eight characters is what the server accepts", got)
	}
	if !s2.saw(http.MethodPost, "/api/breakglass/execute") {
		t.Errorf("an acceptable reason did not reach the server: %v", s2.all())
	}
	if executed2.Reason != "eightchr" {
		t.Errorf("reason = %q, want %q", executed2.Reason, "eightchr")
	}
}

// ── behaviour · the ids ─────────────────────────────────────────────────────────────────────────

// TestOpsForm_AnIdOnTheCommandLineMakesNoListingCall is the rule that matters most for this group:
// break-glass reaches resources no listing of yours contains, so an id you supplied is the answer
// and nothing is fetched to second-guess it.
func TestOpsForm_AnIdOnTheCommandLineMakesNoListingCall(t *testing.T) {
	cases := map[string]struct {
		args     []string
		listPath string
		// wantResource is what must reach the server as the audited resource id, byte for byte.
		// Empty for the verbs that carry their scope in the action input instead.
		wantResource string
		wantProject  string
	}{
		"inspect-job":    {args: []string{"ops", "inspect-job", "job-from-an-alert", "--reason", "incident-4711"}, listPath: "/api/jobs", wantResource: "job-from-an-alert"},
		"cancel-job":     {args: []string{"ops", "cancel-job", "job-from-an-alert", "--reason", "incident-4711", "--yes"}, listPath: "/api/jobs", wantResource: "job-from-an-alert"},
		"drain-runner":   {args: []string{"ops", "drain-runner", "runner-from-an-alert", "--reason", "incident-4711", "--yes"}, listPath: "/api/cli/runners", wantResource: "runner-from-an-alert"},
		"restart-runner": {args: []string{"ops", "restart-runner", "runner-from-an-alert", "--reason", "incident-4711", "--yes"}, listPath: "/api/cli/runners", wantResource: "runner-from-an-alert"},
		"orphan-detect":  {args: []string{"ops", "orphan-detect", "--project", "project-from-an-alert", "--reason", "incident-4711"}, listPath: "/api/cli/configurations", wantProject: "project-from-an-alert"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			s, executed, run := opsFormEnv(t)
			opsFormInteractive(t)
			opsFormAlwaysConfirm(t)
			authFormNoForm(t)

			if got := run(tc.args...); got != 0 {
				t.Fatalf("exit code = %d, want 0", got)
			}
			if s.sawAny(tc.listPath) {
				t.Errorf("a listing (%s) was fetched for an id the caller supplied: %v", tc.listPath, s.all())
			}
			if tc.wantResource != "" && executed.ResourceID != tc.wantResource {
				t.Errorf("resource id = %q, want %q passed through byte for byte", executed.ResourceID, tc.wantResource)
			}
			if tc.wantProject != "" {
				if executed.Input == nil || executed.Input.ProjectID != tc.wantProject {
					t.Errorf("project scope = %+v, want %q passed through byte for byte", executed.Input, tc.wantProject)
				}
			}
		})
	}
}

// TestOpsForm_PickersOfferTheLiveListing drives the other arm: no id, a terminal, a menu.
func TestOpsForm_PickersOfferTheLiveListing(t *testing.T) {
	cases := map[string]struct {
		args     []string
		listPath string
		want     string
	}{
		"inspect-job":  {[]string{"ops", "inspect-job", "--reason", "incident-4711"}, "/api/jobs", "job-alpha"},
		"drain-runner": {[]string{"ops", "drain-runner", "--reason", "incident-4711"}, "/api/cli/runners", "runner-alpha"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			s, executed, run := opsFormEnv(t)
			opsFormInteractive(t)
			opsFormAlwaysConfirm(t)
			// The picker's Select is seeded at index 0, so an unanswered form selects the first
			// option. That is what makes the RESOLVED id assertable: it is the first row the fake
			// listing returned, and it differs from the second.
			authFormAnswer(t, &authFormScript{})

			if got := run(tc.args...); got != 0 {
				t.Fatalf("exit code = %d, want 0", got)
			}
			if !s.sawAny(tc.listPath) {
				t.Errorf("no listing was fetched although no id was given: %v", s.all())
			}
			if executed.ResourceID != tc.want {
				t.Errorf("resolved resource id = %q, want %q (the first row of the listing)", executed.ResourceID, tc.want)
			}
		})
	}
}

// TestOpsForm_ScriptedWithoutAnIdNamesThePositional pins the refusal a runbook gets.
func TestOpsForm_ScriptedWithoutAnIdNamesThePositional(t *testing.T) {
	s, _, run := opsFormEnv(t)
	if got := run("ops", "inspect-job", "--reason", "incident-4711", "--no-input"); got != 1 {
		t.Fatalf("exit code = %d, want 1", got)
	}
	if s.sawAny("/api/jobs") {
		t.Errorf("a listing was fetched with prompting disabled: %v", s.all())
	}
}

// TestOpsForm_NoStreamToDrawOnRefusesRatherThanDrawingAForm is the requireInteractiveFORM half, and
// it is a real defect elsewhere in this package rather than a hypothetical.
//
// noInputMode is derived from STDIN alone, so with stdin a terminal a picker gated on
// requireInteractive() alone considers prompting enabled, draws its ANSI frames where nobody is
// looking, and hangs waiting for a selection the operator cannot see.
//
// "WHERE NOBODY IS LOOKING" IS THE FORM'S STREAM, NOT STDOUT. This arm stubbed stdoutIsTTY, which
// was the right lever until #3847 re-pointed requireInteractiveForm at the stream a huh form
// actually draws on. Stubbing stdout after that leaves the parameter named for a stream the gate no
// longer reads — the same way the addon picker's arm lost its teeth in that PR's review.
//
// The behaviour change is deliberate and this test now records it rather than resisting it: a
// redirected stdout no longer refuses, because `alethia ops inspect-job -o json > out.json` from a
// real terminal can draw its picker on the still-attached stderr perfectly well. Refusing there
// would refuse a question the CLI can ask.
func TestOpsForm_NoStreamToDrawOnRefusesRatherThanDrawingAForm(t *testing.T) {
	s, _, run := opsFormEnv(t)
	prevIn, prevOut := stdinIsTTY, interactiveOutIsTTY
	stdinIsTTY = func() bool { return true }
	interactiveOutIsTTY = func() bool { return false }
	t.Cleanup(func() { stdinIsTTY, interactiveOutIsTTY = prevIn, prevOut })
	authFormNoForm(t)

	if got := run("ops", "inspect-job", "--reason", "incident-4711", "-o", "json"); got != 1 {
		t.Fatalf("exit code = %d, want 1 — with nowhere to draw the form the command must refuse", got)
	}
	if s.sawAny("/api/jobs") {
		t.Errorf("the listing was fetched for a picker that could never be shown: %v", s.all())
	}
}

// TestOpsForm_RedirectedStdoutStillAsks is the control for the arm above.
//
// Re-pointing a stub is indistinguishable from deleting the assertion unless something proves the
// OTHER direction still holds. stdout redirected, the form's stream still a terminal: the picker
// must get PAST the gate and reach the control plane for its listing. If this refuses, the gate has
// been aimed at the wrong stream and the arm above would still pass.
func TestOpsForm_RedirectedStdoutStillAsks(t *testing.T) {
	_, _, run := opsFormEnv(t)
	prevIn, prevOut := stdinIsTTY, stdoutIsTTY
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return false }
	t.Cleanup(func() { stdinIsTTY, stdoutIsTTY = prevIn, prevOut })

	// NOT authFormNoForm: that helper fails the test when a form opens, which is the opposite of
	// what this arm asserts. Here reaching the form IS the pass condition, so the stub records
	// rather than refuses.
	opened := false
	prevForm := runHuhForm
	runHuhForm = func(...*huh.Group) error {
		opened = true
		return nil
	}
	t.Cleanup(func() { runHuhForm = prevForm })

	_ = run("ops", "inspect-job", "--reason", "incident-4711", "-o", "json")
	if !opened {
		t.Error("a redirected stdout short-circuited the picker; the form draws on the form's " +
			"stream, which is still a terminal here, so the gate must let it through")
	}
}

// ── behaviour · unstick-env, the compare-and-swap ───────────────────────────────────────────────

// TestOpsForm_UnstickEnvRejectsAStatusOutsideTheEnum pins the provable-subset rule.
//
// DEPLOYING and READY were in the documented example for this command and neither is a
// project_status, so the page shipped an invocation the server refuses.
func TestOpsForm_UnstickEnvRejectsAStatusOutsideTheEnum(t *testing.T) {
	for _, args := range [][]string{
		{"ops", "unstick-env", "env-alpha", "--from", "DEPLOYING", "--to", "FAILED", "--reason", "incident-4711", "--yes", "--no-input"},
		{"ops", "unstick-env", "env-alpha", "--from", "PROVISIONING", "--to", "READY", "--reason", "incident-4711", "--yes", "--no-input"},
	} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			s, _, run := opsFormEnv(t)
			if got := run(args...); got != 1 {
				t.Fatalf("exit code = %d, want 1", got)
			}
			if s.sawAny("/api/breakglass") {
				t.Errorf("a status the server refuses still cost a round trip: %v", s.all())
			}
		})
	}
}

// TestOpsForm_UnstickEnvAcceptsTheEnumAndNormalisesIt pins the accepted arm, and that the CAS
// precondition reaches the server as the list the operator meant.
func TestOpsForm_UnstickEnvAcceptsTheEnumAndNormalisesIt(t *testing.T) {
	_, executed, run := opsFormEnv(t)
	if got := run("ops", "unstick-env", "env-alpha", "--from", "provisioning, queued ", "--to", "failed",
		"--reason", "incident-4711", "--yes", "--no-input"); got != 0 {
		t.Fatalf("exit code = %d, want 0", got)
	}
	if executed.Input == nil {
		t.Fatal("no action input reached the server")
	}
	if strings.Join(executed.Input.ExpectedFrom, ",") != "PROVISIONING,QUEUED" {
		t.Errorf("expectedFrom = %v, want [PROVISIONING QUEUED]", executed.Input.ExpectedFrom)
	}
	if executed.Input.To != "FAILED" {
		t.Errorf("to = %q, want FAILED", executed.Input.To)
	}
}

// TestOpsForm_UnstickEnvScriptedWithAnIdStillNeedsTheCasSides is the decision the CAS depends on:
// given an id, the CLI has not looked the environment up, so it does not invent a precondition.
func TestOpsForm_UnstickEnvScriptedWithAnIdStillNeedsTheCasSides(t *testing.T) {
	s, _, run := opsFormEnv(t)
	if got := run("ops", "unstick-env", "env-alpha", "--to", "FAILED", "--reason", "incident-4711", "--yes", "--no-input"); got != 1 {
		t.Fatalf("exit code = %d, want 1 — a compare-and-swap with no precondition is a raw UPDATE", got)
	}
	if s.sawAny("/api/breakglass") {
		t.Errorf("the refusal cost a round trip: %v", s.all())
	}
}

// TestOpsForm_UnstickEnvPickerSeedsThePreconditionFromTheLiveStatus is the interactive arm: the
// operator picked the environment, so the CLI knows what status it is in and starts there.
func TestOpsForm_UnstickEnvPickerSeedsThePreconditionFromTheLiveStatus(t *testing.T) {
	_, executed, run := opsFormEnv(t)
	opsFormInteractive(t)
	opsFormAlwaysConfirm(t)
	// Four forms: project, environment, the from multi-select (pre-seeded, accepted as-is), the to
	// select (index 0 = DRAFT).
	authFormAnswer(t, &authFormScript{}, &authFormScript{}, &authFormScript{}, &authFormScript{})

	if got := run("ops", "unstick-env", "--reason", "incident-4711"); got != 0 {
		t.Fatalf("exit code = %d, want 0", got)
	}
	if executed.ResourceID != "env-alpha" {
		t.Errorf("resource id = %q, want env-alpha", executed.ResourceID)
	}
	if executed.Input == nil || len(executed.Input.ExpectedFrom) != 1 || executed.Input.ExpectedFrom[0] != "PROVISIONING" {
		t.Errorf("expectedFrom = %+v, want the status the environment is actually in (PROVISIONING)", executed.Input)
	}
}

// ── behaviour · approve ─────────────────────────────────────────────────────────────────────────

// TestOpsForm_ApproveRefusesAnActionThatTakesNoApproval pins the closed set, which is derived from
// the catalog rather than typed.
func TestOpsForm_ApproveRefusesAnActionThatTakesNoApproval(t *testing.T) {
	s, _, run := opsFormEnv(t)
	if got := run("ops", "approve", "cancel_job", "job-alpha", "--reason", "incident-4711", "--no-input"); got != 1 {
		t.Fatalf("exit code = %d, want 1 — the approval endpoint answers 400 for a low-blast action", got)
	}
	if s.sawAny("/api/breakglass/approval") {
		t.Errorf("the refusal cost a round trip: %v", s.all())
	}
}

// TestOpsForm_ApproveAcceptsEveryHighBlastAction is the other direction, over the DERIVED set — so
// a fourth high-blast action added to the catalog is exercised here without anyone editing a list.
func TestOpsForm_ApproveAcceptsEveryHighBlastAction(t *testing.T) {
	actions := opsApprovalActions()
	if len(actions) == 0 {
		t.Fatal("no action requires an approval — this test would check nothing")
	}
	for _, action := range actions {
		t.Run(action, func(t *testing.T) {
			s, _, run := opsFormEnv(t)
			if got := run("ops", "approve", action, "resource-1", "--reason", "incident-4711", "--no-input"); got != 0 {
				t.Fatalf("exit code = %d, want 0", got)
			}
			if !s.saw(http.MethodPost, "/api/breakglass/approval") {
				t.Errorf("no approval was minted: %v", s.all())
			}
		})
	}
}

// TestOpsForm_ApprovePicksTheActionFromTheCatalog drives the picker arm.
func TestOpsForm_ApprovePicksTheActionFromTheCatalog(t *testing.T) {
	s, _, run := opsFormEnv(t)
	opsFormInteractive(t)
	// Two forms: the action select (index 0), then the resource input.
	authFormAnswer(t, &authFormScript{}, &authFormScript{keys: authFormType("projects/acme/prod.tfstate")})

	if got := run("ops", "approve", "--reason", "incident-4711"); got != 0 {
		t.Fatalf("exit code = %d, want 0", got)
	}
	if !s.saw(http.MethodPost, "/api/breakglass/approval") {
		t.Errorf("no approval was minted: %v", s.all())
	}
}

// ── behaviour · the output ──────────────────────────────────────────────────────────────────────

// TestOpsForm_JsonOutputCarriesNoStyledPreamble is a real defect this pass removed: `ui.Success`
// was printed unconditionally, ahead of a raw json.MarshalIndent of the payload, so `-o json`
// emitted a styled sentence and then a document. That is not JSON, and `-o json` is what an
// operator pipes into `jq` while an incident is running.
//
// BOTH ARMS, and the table arm is what makes the json arm mean anything: it proves the success
// glyph is emitted at all, so its absence under `-o json` is a suppression rather than a command
// that happened to print nothing.
//
// It asserts on the glyph and on the document, and NOT on the whole stream, because
// ui.RunSpinner writes its bubbletea frames to stdout regardless of the output format. That is a
// separate defect, older and wider than this group — 52 call sites across cmd/ — and it is
// reported as a handover rather than fixed from here.
func TestOpsForm_JsonOutputCarriesNoStyledPreamble(t *testing.T) {
	for _, tc := range []struct {
		format    string
		wantGlyph bool
	}{
		{"table", true},
		{"json", false},
	} {
		t.Run(tc.format, func(t *testing.T) {
			_, _, run := opsFormEnv(t)
			out, code := opsFormCaptureStdout(t, func() int {
				return run("ops", "inspect-job", "job-alpha", "--reason", "incident-4711", "--no-input", "-o", tc.format)
			})
			if code != 0 {
				t.Fatalf("exit code = %d, want 0", code)
			}
			if strings.TrimSpace(out) == "" {
				t.Fatal("nothing was written to stdout — this assertion would be vacuous")
			}

			if got := strings.Contains(out, ui.SymbolSuccess); got != tc.wantGlyph {
				t.Errorf("-o %s: the styled success line was emitted = %v, want %v.\n       stdout: %q",
					tc.format, got, tc.wantGlyph, out)
			}
			if tc.format != "json" {
				// The table arm also proves the payload reaches the reader, through the shared
				// card rather than a hand-rolled dump.
				if !strings.Contains(out, "rows") {
					t.Errorf("-o table dropped the payload:\n%s", out)
				}
				return
			}
			brace := strings.Index(out, "{")
			if brace < 0 {
				t.Fatalf("-o json rendered no document at all:\n%s", out)
			}
			var decoded map[string]any
			if err := json.Unmarshal([]byte(out[brace:]), &decoded); err != nil {
				t.Fatalf("-o json did not emit a JSON document:\n%s\n(%v)", out[brace:], err)
			}
			if decoded["detail"] != "done" {
				t.Errorf("the document dropped the detail line: %v", decoded)
			}
		})
	}
}

// opsFormCaptureStdout runs fn with stdout redirected to a pipe and returns what it wrote.
//
// The pipe is drained on a goroutine: a command that writes more than the pipe buffer would
// otherwise block forever on the write while this function waits for it to return.
func opsFormCaptureStdout(t *testing.T, fn func() int) (string, int) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	prev := os.Stdout
	os.Stdout = w

	done := make(chan string, 1)
	go func() {
		var b strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			b.Write(buf[:n])
			if err != nil {
				done <- b.String()
				return
			}
		}
	}()

	code := fn()
	os.Stdout = prev
	_ = w.Close()
	out := <-done
	_ = r.Close()
	return out, code
}

// ── the panics ──────────────────────────────────────────────────────────────────────────────────

// TestOpsForm_MustOpsFieldPanicsOnAMiss and its sibling pin the two loud failures. Both are
// programming errors reachable only from constants in this package, and the alternative to a panic
// is a form that opens with an empty title, or a mutating verb classified read-only.
func TestOpsForm_MustOpsFieldPanicsOnAMiss(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("mustOpsField returned a zero field for a key that does not exist")
		}
	}()
	_ = mustOpsField("alethia ops session", opsKeyApproval)
}

func TestOpsForm_MustOpsActionPanicsOnAMiss(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("mustOpsAction returned a zero action for a command with no catalog entry")
		}
	}()
	_ = mustOpsAction("alethia ops session")
}

// TestOpsForm_RegisterOpsVerbRefusesAnUnspecifiedCommand pins the init-time guard.
func TestOpsForm_RegisterOpsVerbRefusesAnUnspecifiedCommand(t *testing.T) {
	for name, cmd := range map[string]*cobra.Command{
		"no Use":    {Use: ""},
		"no fields": {Use: "not-in-the-spec"},
	} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Error("registerOpsVerb accepted a command its spec does not describe")
				}
			}()
			registerOpsVerb(cmd)
		})
	}
}

// TestOpsForm_ApproveNormalisesTheActionToTheCatalogSpelling pins what is POSTED, not that a POST
// happened.
//
// The match is case-insensitive on purpose — an operator typing STATE_SURGERY during an incident
// should not be refused for the shift key. But `mintApprovalSchema.action` is
// `z.enum(breakglassAction.enumValues)`, lowercase snake_case, so returning the caller's spelling
// converts an argument the CLI accepted into a 400 and a zod issue list from the server. This lands
// on the two-person approval that is the ONLY gate on force-release-lock, state-surgery and
// orphan-clean.
//
// The sibling assertion "an approval was minted" cannot see this: the request is made either way.
func TestOpsForm_ApproveNormalisesTheActionToTheCatalogSpelling(t *testing.T) {
	actions := opsApprovalActions()
	if len(actions) == 0 {
		t.Fatal("no action requires an approval — this test would check nothing")
	}
	for _, canonical := range actions {
		shouted := strings.ToUpper(canonical)
		if shouted == canonical {
			t.Fatalf("%q is unchanged by ToUpper, so this case cannot distinguish the caller's "+
				"spelling from the catalog's", canonical)
		}
		t.Run(shouted, func(t *testing.T) {
			s, _, run := opsFormEnv(t)
			if got := run("ops", "approve", shouted, "resource-1", "--reason", "incident-4711", "--no-input"); got != 0 {
				t.Fatalf("exit code = %d, want 0 — a shouted action must be accepted", got)
			}
			body := s.body(t, http.MethodPost, "/api/breakglass/approval")
			var posted struct {
				Action string `json:"action"`
			}
			if err := json.Unmarshal([]byte(body), &posted); err != nil {
				t.Fatalf("approval body is not JSON: %v (%s)", err, body)
			}
			if posted.Action != canonical {
				t.Errorf("posted action = %q, want the catalog spelling %q — the server enum is "+
					"lowercase snake_case and would answer 400", posted.Action, canonical)
			}
		})
	}
}
