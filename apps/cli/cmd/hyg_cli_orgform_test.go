// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
)

// The org group's forms, its resolvers, and the other renderings of the same fields.
//
// Every identifier here carries the orgForm prefix so it cannot collide with another group's
// helpers in this package. The bubbletea form pump is NOT re-created: authFormAnswer/authFormType/
// authFormPump in hyg_cli_authform_test.go already type into the real widgets, and a second copy of
// a 25ms-deadline command pump is exactly the duplication this programme removes.

// ── the fixtures ────────────────────────────────────────────────────────────────────────────────

// The ids are real uuids because the grants route types principal_id, role_id and resource_id as
// `z.uuid()`. A fixture that used "u1" would be testing a shape the server refuses, and the
// resolution these tests exist to prove turns exactly that non-uuid into a lookup.
const (
	orgFormUserID   = "11111111-1111-4111-8111-111111111111"
	orgFormMemberID = "aaaaaaaa-1111-4111-8111-111111111111"
	orgFormTeamID   = "22222222-2222-4222-8222-222222222222"
	orgFormRoleID   = "33333333-3333-4333-8333-333333333333"
	orgFormGrantID  = "44444444-4444-4444-8444-444444444444"
	orgFormSsoID    = "55555555-5555-4555-8555-555555555555"
	orgFormOwnerID  = "66666666-6666-4666-8666-666666666666"
)

// orgFormServer records every request the CLI made, as "METHOD path".
type orgFormServer struct {
	mu       sync.Mutex
	requests []string
	bodies   map[string]string
	failing  map[string]bool
}

// fail makes one endpoint answer 500, so a test can drive the arm where the control plane says no.
func (s *orgFormServer) fail(method, path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failing == nil {
		s.failing = map[string]bool{}
	}
	s.failing[method+" "+path] = true
}

// refuses reports whether this request is one the test asked to fail.
func (s *orgFormServer) refuses(r *http.Request) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.failing[r.Method+" "+r.URL.Path]
}

func (s *orgFormServer) record(r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := r.Method + " " + r.URL.Path
	s.requests = append(s.requests, key)
	if r.Body != nil {
		b, _ := io.ReadAll(r.Body)
		if s.bodies == nil {
			s.bodies = map[string]string{}
		}
		s.bodies[key] = string(b)
	}
}

func (s *orgFormServer) saw(method, path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, req := range s.requests {
		if req == method+" "+path {
			return true
		}
	}
	return false
}

func (s *orgFormServer) body(method, path string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bodies[method+" "+path]
}

func (s *orgFormServer) mutations() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, req := range s.requests {
		switch strings.SplitN(req, " ", 2)[0] {
		case http.MethodPost, http.MethodDelete, http.MethodPatch, http.MethodPut:
			out = append(out, req)
		}
	}
	return out
}

func (s *orgFormServer) forget() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests, s.bodies = nil, nil
}

// orgFormPayloads is what the fake control plane answers with. Each field is a whole response so a
// test can empty one list without the others changing.
type orgFormPayloads struct {
	orgs    []map[string]any
	members []map[string]any
	teams   []map[string]any
	roles   []map[string]any
	grants  []map[string]any
	sso     []map[string]any
}

// orgFormDefaultPayloads is one org with one of everything, plus the four built-in role templates
// the roles route always returns first.
func orgFormDefaultPayloads() orgFormPayloads {
	return orgFormPayloads{
		orgs: []map[string]any{{
			"id": "o1", "name": "Acme", "slug": "acme",
			"role": "owner", "plan": "pro", "is_active": true,
		}},
		members: []map[string]any{{
			"id": orgFormMemberID, "user_id": orgFormUserID,
			"email": "ada@example.com", "name": "Ada Lovelace",
			"role": "owner", "status": "active",
		}},
		teams: []map[string]any{{
			"id": orgFormTeamID, "name": "platform", "member_count": 3,
		}},
		roles: []map[string]any{
			{
				"id": orgFormOwnerID, "name": "owner", "description": "Full control.",
				"is_builtin": true,
				// The owner template's keys ARE the whole catalog: the route expands its "*" to
				// every registered permission key. permissionCatalog reads exactly this.
				"permission_keys": []string{"project:deploy", "project:plan", "member:view"},
			},
			{
				"id": orgFormRoleID, "name": "deployers", "description": "",
				"is_builtin": false, "permission_keys": []string{"project:deploy"},
			},
		},
		grants: []map[string]any{{
			"id": orgFormGrantID, "principal_type": "user", "principal_id": orgFormUserID,
			"effect": "allow", "role": "deployers", "permission_key": nil,
			"resource_type": "org", "resource_id": nil,
		}},
		sso: []map[string]any{{
			"id": orgFormSsoID, "provider_type": "oidc", "domain": "example.com",
			"issuer": "https://idp.example.com", "enabled": true,
		}},
	}
}

// orgFormEnv stands up isolated credentials, an active org and a fake control plane, traps exitFunc,
// and returns the recorder plus a runner that drives the REAL cobra tree and reports the exit code
// together with everything the CLI printed.
//
// The output matters as much as the code: this group's whole claim is that a scripted caller is told
// which flag to pass, and an exit code cannot carry that.
func orgFormEnv(t *testing.T, p orgFormPayloads) (*orgFormServer, func(args ...string) (int, string)) {
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

	s := &orgFormServer{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.record(r)
		if s.refuses(r) {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "refused"})
			return
		}
		enc := json.NewEncoder(w)
		path := r.URL.Path
		switch {
		case strings.HasSuffix(path, "/members") && r.Method == http.MethodGet:
			_ = enc.Encode(map[string]any{"members": p.members})
		case strings.HasSuffix(path, "/members") && r.Method == http.MethodPost:
			_ = enc.Encode(map[string]any{"invitation": map[string]any{
				"id": "i1", "email": "x@example.com", "role": "operator", "status": "pending",
			}})
		case strings.HasSuffix(path, "/teams") && r.Method == http.MethodGet:
			_ = enc.Encode(map[string]any{"teams": p.teams})
		case strings.HasSuffix(path, "/teams") && r.Method == http.MethodPost:
			_ = enc.Encode(map[string]any{"team": map[string]any{
				"id": orgFormTeamID, "name": "platform", "member_count": 0,
			}})
		case path == "/api/cli/roles" && r.Method == http.MethodGet:
			_ = enc.Encode(map[string]any{"roles": p.roles})
		case path == "/api/cli/roles" && r.Method == http.MethodPost:
			_ = enc.Encode(map[string]any{"role": map[string]any{
				"id": orgFormRoleID, "name": "deployers", "description": "",
				"is_builtin": false, "permission_keys": []string{"project:deploy"},
			}})
		case path == "/api/cli/grants" && r.Method == http.MethodGet:
			_ = enc.Encode(map[string]any{"grants": p.grants})
		case path == "/api/cli/grants" && r.Method == http.MethodPost:
			_ = enc.Encode(map[string]any{"grant": p.grants[0]})
		case path == "/api/cli/sso" && r.Method == http.MethodGet:
			_ = enc.Encode(map[string]any{"sso_providers": p.sso})
		case strings.HasPrefix(path, "/api/cli/sso/"):
			_ = enc.Encode(map[string]any{"sso_provider": p.sso[0]})
		case path == "/api/cli/orgs" && r.Method == http.MethodGet:
			_ = enc.Encode(map[string]any{"orgs": p.orgs})
		default:
			_ = enc.Encode(map[string]any{"ok": true})
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
	})

	return s, func(args ...string) (code int, out string) {
		read := orgFormCaptureStdout(t)
		defer func() {
			out = read()
			hygCliConfirmResetFlags()
			if r := recover(); r != nil {
				e, ok := r.(hygCliConfirmExit)
				if !ok {
					panic(r)
				}
				code = e.code
			}
		}()
		hygCliConfirmResetFlags()
		execRootArgs(args)
		if err := rootCmd.Execute(); err != nil {
			return 1, ""
		}
		return 0, ""
	}
}

// orgSelectClearActiveOrg empties the persisted active org, for the arms that must work — or must
// refuse — without one.
func orgSelectClearActiveOrg(t *testing.T) {
	t.Helper()
	if err := types.SaveCliConfig(types.CliConfig{}); err != nil {
		t.Fatalf("SaveCliConfig: %v", err)
	}
}

// orgFormAnsi strips the terminal styling lipgloss may add, so an assertion is about the words.
var orgFormAnsi = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)

// orgFormCaptureStdout redirects os.Stdout into a pipe and returns a func that restores it and
// yields everything written.
//
// ui.Error goes through fmt.Printf, which resolves os.Stdout at call time, so swapping the package
// variable is what catches it. The pipe is drained on its own goroutine: a refusal is short, but a
// test that deadlocks on a full pipe buffer would look like a hang rather than a failure.
func orgFormCaptureStdout(t *testing.T) func() string {
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
	var once sync.Once
	restore := func() string {
		var text string
		once.Do(func() {
			os.Stdout = prev
			_ = w.Close()
			text = orgFormAnsi.ReplaceAllString(<-done, "")
			_ = r.Close()
		})
		return text
	}
	t.Cleanup(func() { restore() })
	return restore
}

// orgFormInteractive puts the process in the state a terminal user is in: both streams a TTY and
// prompting on.
//
// BOTH streams, because the pickers go through requireInteractiveForm, which reads stdout as well —
// a form drawing into a redirected file is the failure that check exists for.
func orgFormInteractive(t *testing.T) {
	t.Helper()
	prevIn, prevOut, prevMode := stdinIsTTY, stdoutIsTTY, noInputMode
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return true }
	noInputMode = false
	t.Cleanup(func() { stdinIsTTY, stdoutIsTTY, noInputMode = prevIn, prevOut, prevMode })
}

// orgFormScripted disables prompting the way --no-input does.
func orgFormScripted(t *testing.T) {
	t.Helper()
	prev := noInputMode
	noInputMode = true
	t.Cleanup(func() { noInputMode = prev })
}

// ── rendering 1 · the flags ─────────────────────────────────────────────────────────────────────

// TestHygCliOrgForm_EveryFieldNamesARealFlagOrPositional is the "flags stay a COMPLETE contract"
// half: anything a form can ask, the command line can set.
//
// It resolves each spec entry against the LIVE cobra tree rather than against a list, so renaming
// --principal-type without touching the spec fails here.
func TestHygCliOrgForm_EveryFieldNamesARealFlagOrPositional(t *testing.T) {
	if len(orgFields) == 0 {
		t.Fatal("orgFields is empty — every assertion below would pass having checked nothing")
	}
	for _, f := range orgFields {
		t.Run(f.Command+"/"+f.Key, func(t *testing.T) {
			if (f.Flag == "") == (f.Arg == "") {
				t.Fatalf("exactly one of Flag and Arg must be set; got Flag=%q Arg=%q", f.Flag, f.Arg)
			}
			if strings.TrimSpace(f.Title) == "" || strings.TrimSpace(f.Description) == "" {
				t.Fatalf("a field with no title or no description renders as an unlabelled question")
			}
			cmd, _, err := rootCmd.Find(strings.Fields(strings.TrimPrefix(f.Command, "alethia ")))
			if err != nil || cmd.CommandPath() != f.Command {
				t.Fatalf("no command %q in the tree (found %q, err %v)", f.Command, cmd.CommandPath(), err)
			}
			if f.Flag != "" {
				if cmd.Flags().Lookup(f.Flag) == nil {
					t.Errorf("%s asks for %q in its form and has NO --%s flag.\n"+
						"      A form field a flag cannot set means --no-input can never answer it, so the\n"+
						"      command is unusable from a script for the one value it exists to take.",
						f.Command, f.Title, f.Flag)
				}
			} else if !strings.Contains(cmd.Use, f.Arg) {
				t.Errorf("%s asks for %q in its form and its Use %q does not carry the positional %q",
					f.Command, f.Title, cmd.Use, f.Arg)
			}
			if f.Selector == "" {
				return
			}
			// A selector is what the refusal tells a scripted caller to pass. One that does not
			// exist is worse than none: the error names a flag and the flag is rejected.
			if cmd.Flags().Lookup(f.Selector) == nil {
				t.Errorf("%s names --%s as the way to select %q without an id, and has no such flag",
					f.Command, f.Selector, f.Title)
			}
			if f.Flag != "" {
				t.Errorf("%s/%s carries both a Flag and a Selector; a selector names an id-shaped "+
					"POSITIONAL by something readable, so a field that is already a flag has no use for one",
					f.Command, f.Key)
			}
		})
	}
}

// orgFormLeafTakesInput records, for every runnable command in the group, whether it takes a value
// from the person running it. The SET is derived from the command tree; only the answer is written
// down, so a new `alethia grants …` subcommand fails this test until somebody decides which side it
// is on.
//
// The list verbs are `false` even though `members list` and `teams list` accept `--org`: that flag
// scopes an invocation and is answered by the active context when nobody passes it, so it is not a
// value the command exists to take. The fields that would be unanswered without a person are the
// ones this table calls input.
var orgFormLeafTakesInput = map[string]bool{
	"alethia whoami":         false,
	"alethia org list":       false,
	"alethia org switch":     true,
	"alethia org settings":   false,
	"alethia members list":   false,
	"alethia members add":    true,
	"alethia members remove": true,
	"alethia teams list":     false,
	"alethia teams create":   true,
	"alethia teams delete":   true,
	"alethia roles list":     false,
	"alethia roles create":   true,
	"alethia roles delete":   true,
	"alethia grants list":    false,
	"alethia grants add":     true,
	"alethia grants remove":  true,
	"alethia sso list":       false,
	"alethia sso get":        true,
}

// TestHygCliOrgForm_EveryGroupLeafIsClassified closes the gap between "the group has a field spec"
// and "the field spec covers the group".
//
// The derived set and the table must match EXACTLY, in both directions. A count floor would not do:
// every command here can be named, and a floor passes with the interesting half deleted.
func TestHygCliOrgForm_EveryGroupLeafIsClassified(t *testing.T) {
	commands := orgGroupCommands(rootCmd)
	if len(commands) == 0 {
		t.Fatal("the walk found no commands under org/members/teams/roles/grants/sso/whoami — " +
			"every assertion below is vacuous")
	}

	contributed := map[string]bool{}
	seen := map[string]bool{}
	fieldsFor := map[string]int{}
	for _, f := range orgFields {
		fieldsFor[f.Command]++
	}

	for _, c := range commands {
		path := c.CommandPath()
		seen[path] = true
		contributed[strings.Fields(path)[1]] = true
		takesInput, classified := orgFormLeafTakesInput[path]
		if !classified {
			t.Errorf("%s is a runnable command of this group and nothing says whether it takes input.\n"+
				"      Classify it in orgFormLeafTakesInput: one that takes a value needs an interactive\n"+
				"      path and a row in orgFields; one that takes none needs neither.", path)
			continue
		}
		if !takesInput && fieldsFor[path] > 0 {
			t.Errorf("%s is recorded as taking no input and has %d orgFields entries", path, fieldsFor[path])
		}
		if takesInput && fieldsFor[path] == 0 {
			t.Errorf("%s takes input and has no orgFields row — the form, the refusal and the docs "+
				"table have nothing to read", path)
		}
	}

	for _, r := range orgGroupRoots {
		if !contributed[r] {
			t.Errorf("`alethia %s` contributed no runnable command — it is gone, renamed, or no "+
				"longer registered", r)
		}
	}
	for path := range orgFormLeafTakesInput {
		if !seen[path] {
			t.Errorf("orgFormLeafTakesInput names %q, which the walk did not reach — it is gone or renamed", path)
		}
	}
}

// ── rendering 2 · the docs ──────────────────────────────────────────────────────────────────────

// TestHygCliOrgForm_DocsFieldTablesMirrorTheSpec is the docs half of "one field spec, four
// renderings".
//
// Every command with fields must carry a table on the page its spec names, and that table must be
// the same rows in the same order, including the "Name it by" column. A docs page is the only one of
// the renderings a compiler cannot see, which is why it is the one that goes stale.
//
// It reads the table with authFormTable — the auth group's reader, reused rather than re-created;
// a second markdown-table parser in this package would be a second thing to keep correct.
func TestHygCliOrgForm_DocsFieldTablesMirrorTheSpec(t *testing.T) {
	root := authFormRepoRoot(t)
	byCommand := map[string][]orgField{}
	var order []string
	for _, f := range orgFields {
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
			page := fields[0].Page
			for _, f := range fields {
				if f.Page != page {
					t.Fatalf("%s splits its fields across %s and %s; one command documents its form in one place",
						command, page, f.Page)
				}
			}
			marker := "{/* fieldspec: " + command + " */}"
			rows, ok := authFormTable(t, filepath.Join(root, page), marker)
			if !ok {
				t.Fatalf("%s carries no table after %s.\n"+
					"      The command takes %d value(s) that nothing in the docs describes.",
					page, marker, len(fields))
			}
			if len(rows) != len(fields) {
				t.Fatalf("%s documents %d field(s) after %s; the spec has %d.\n      docs: %v",
					page, len(rows), marker, len(fields), rows)
			}
			for i, f := range fields {
				want := []string{f.Title, f.Description, "`" + orgFieldToken(f) + "`", orgFormSelectorCell(f)}
				got := rows[i]
				if len(got) < len(want) {
					t.Errorf("%s row %d has %d cells, want %d: %v", page, i+1, len(got), len(want), got)
					continue
				}
				for j, w := range want {
					if got[j] != w {
						t.Errorf("%s row %d cell %d:\n       docs: %q\n       spec: %q",
							page, i+1, j+1, got[j], w)
					}
				}
			}
		})
	}
}

// orgFormSelectorCell renders the docs table's "Name it by" cell: the selector flag, or the
// empty-value sentinel when the field has none.
func orgFormSelectorCell(f orgField) string {
	if f.Selector == "" {
		return "—"
	}
	return "`--" + f.Selector + "`"
}

// TestHygCliOrgForm_DocsShowNoCopiedId is the "placeholder handoffs go to zero" half, and it is
// checked by SHAPE rather than against a list of the placeholders that happen to be there today.
//
// A token a reader must replace by hand — `<user-id>`, `mbr_123`, `3f1c…` — is the signature of a
// command whose only address is an id fetched from a previous command. Those are exactly what this
// pass removed, and a page that grows one back has grown the handoff back with it.
func TestHygCliOrgForm_DocsShowNoCopiedId(t *testing.T) {
	root := authFormRepoRoot(t)
	pages := map[string]bool{}
	for _, f := range orgFields {
		pages[f.Page] = true
	}
	if len(pages) == 0 {
		t.Fatal("no pages to check — every assertion below is vacuous")
	}
	checked := 0
	for page := range pages {
		body, err := os.ReadFile(filepath.Join(root, page))
		if err != nil {
			t.Fatalf("read %s: %v — a page this guard cannot read is a failure, not a pass", page, err)
		}
		examples := docsFencedExamples(string(body))
		if len(examples) == 0 {
			t.Errorf("%s shows no `alethia …` invocation — a page this guard cannot check", page)
			continue
		}
		for _, example := range examples {
			checked++
			for _, token := range strings.Fields(example) {
				switch {
				case strings.HasPrefix(token, "<") && strings.HasSuffix(token, ">"):
					t.Errorf("%s: %q makes the reader substitute %s by hand.\n"+
						"      Every command on this page takes a name, a flag, or offers a picker, so an\n"+
						"      example never has to hand the reader an id to go and find.", page, example, token)
				case strings.HasSuffix(token, "…"):
					t.Errorf("%s: %q shows a truncated id (%s), which a reader can only get by copying "+
						"it out of another command's output", page, example, token)
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("no example was inspected — every assertion above was vacuous")
	}
}

// ── rendering 3 · the refusals ──────────────────────────────────────────────────────────────────

// orgFormRefusalArgs is the invocation for each command that must refuse under --no-input, minus the
// --no-input itself.
//
// A hand-written ARGS table is unavoidable — every command needs its own valid invocation, and
// nothing can derive those. What is avoidable is the table also deciding the SET: the set is derived
// below from the spec and the live flag defaults, and a gap names the missing command.
var orgFormRefusalArgs = map[string][]string{
	"alethia org switch":     {"org", "switch"},
	"alethia members add":    {"members", "add"},
	"alethia members remove": {"members", "remove"},
	"alethia teams create":   {"teams", "create"},
	"alethia teams delete":   {"teams", "delete"},
	"alethia roles create":   {"roles", "create"},
	"alethia roles delete":   {"roles", "delete"},
	"alethia grants add":     {"grants", "add"},
	"alethia grants remove":  {"grants", "remove"},
	"alethia sso get":        {"sso", "get"},
}

// orgFormUnanswerable returns the fields of one command that NOTHING answers when the caller types
// no value: every positional, plus every flag whose registered default is empty.
//
// Derived from the live cobra tree, not written down. `--role` on `members add` defaults to
// `member`, so a scripted invitation is complete without it and must NOT be refused; `--principal`
// on `grants add` defaults to nothing, so it must. Reading the default off the real flag is what
// keeps that distinction true when a default changes.
func orgFormUnanswerable(t *testing.T, command string) []orgField {
	t.Helper()
	cmd, _, err := rootCmd.Find(strings.Fields(strings.TrimPrefix(command, "alethia ")))
	if err != nil {
		t.Fatalf("find %s: %v", command, err)
	}
	var out []orgField
	for _, f := range orgFields {
		if f.Command != command {
			continue
		}
		if f.Flag == "" {
			out = append(out, f)
			continue
		}
		flag := cmd.Flags().Lookup(f.Flag)
		if flag != nil && flag.DefValue == "" {
			out = append(out, f)
		}
	}
	return out
}

// TestHygCliOrgForm_ScriptedRefusalNamesWhatToPass is the contract that makes --no-input usable.
//
// A command that cannot ask must not say "interactive input required": that tells the caller they
// are stuck without telling them how to become unstuck, and the flag they need is exactly the one
// they cannot guess. So for every command in the derived set, the refusal must exit non-zero, change
// nothing, and NAME a token from that command's own spec.
func TestHygCliOrgForm_ScriptedRefusalNamesWhatToPass(t *testing.T) {
	s, run := orgFormEnv(t, orgFormDefaultPayloads())

	need := 0
	for command := range orgFormLeafTakesInput {
		if !orgFormLeafTakesInput[command] {
			continue
		}
		unanswerable := orgFormUnanswerable(t, command)
		if len(unanswerable) == 0 {
			continue
		}
		need++
		args, ok := orgFormRefusalArgs[command]
		if !ok {
			t.Errorf("%s has %d value(s) nothing answers and NO entry in orgFormRefusalArgs, so its "+
				"--no-input refusal is never driven", command, len(unanswerable))
			continue
		}
		t.Run(command, func(t *testing.T) {
			s.forget()
			code, out := run(append(append([]string{}, args...), "--no-input")...)
			if code == 0 {
				t.Fatalf("exit code = 0; a command that cannot ask for a required value must fail")
			}
			if muts := s.mutations(); len(muts) > 0 {
				t.Errorf("state changed although the command could not be told what to act on: %v", muts)
			}
			named := false
			for _, f := range unanswerable {
				if strings.Contains(out, orgFieldToken(f)) {
					named = true
					break
				}
			}
			if !named {
				var want []string
				for _, f := range unanswerable {
					want = append(want, orgFieldToken(f))
				}
				t.Errorf("the refusal names none of %v.\n       said: %q", want, strings.TrimSpace(out))
			}
			if strings.Contains(out, errNoInput.Error()) || strings.Contains(out, errNoTTY.Error()) {
				t.Errorf("the refusal is the package's generic one, which names no flag:\n       %q",
					strings.TrimSpace(out))
			}
		})
	}
	if need < 9 {
		t.Errorf("only %d commands were found to require a value nothing answers; this group has ten, "+
			"so a count this low means the derivation stopped matching", need)
	}
	for command := range orgFormRefusalArgs {
		if len(orgFormUnanswerable(t, command)) == 0 {
			t.Errorf("orgFormRefusalArgs names %q, which has no unanswered value — delete the entry", command)
		}
	}
}

// TestHygCliOrgForm_ScriptedSelectorAnswersTheRefusal is the other half, and the one that makes the
// test above mean something.
//
// A CLI that refused every scripted invocation would pass the refusal test perfectly. These are the
// same commands, under --no-input, answered by the flag the refusal names — and each must reach the
// control plane.
func TestHygCliOrgForm_ScriptedSelectorAnswersTheRefusal(t *testing.T) {
	cases := []struct {
		name   string
		args   []string
		method string
		path   string
	}{
		{"members remove --email", []string{"members", "remove", "--email", "ada@example.com", "--yes"},
			http.MethodDelete, "/api/cli/orgs/o1/members/" + orgFormMemberID},
		{"teams delete --name", []string{"teams", "delete", "--name", "platform", "--yes"},
			http.MethodDelete, "/api/cli/orgs/o1/teams/" + orgFormTeamID},
		{"roles delete --name", []string{"roles", "delete", "--name", "deployers", "--yes"},
			http.MethodDelete, "/api/cli/roles/" + orgFormRoleID},
		{"sso get --domain", []string{"sso", "get", "--domain", "example.com"},
			http.MethodGet, "/api/cli/sso/" + orgFormSsoID},
		{"grants add --principal <email>", []string{"grants", "add", "--principal", "ada@example.com", "--role", "deployers"},
			http.MethodPost, "/api/cli/grants"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, run := orgFormEnv(t, orgFormDefaultPayloads())
			code, out := run(append(append([]string{}, tc.args...), "--no-input", "--output", "json")...)
			if code != 0 {
				t.Fatalf("exit code = %d, want 0\n       said: %q", code, strings.TrimSpace(out))
			}
			if !s.saw(tc.method, tc.path) {
				t.Errorf("the selector resolved to the wrong thing: no %s %s\n       requests = %v",
					tc.method, tc.path, s.requests)
			}
		})
	}
}

// ── the identities, asserted rather than assumed ────────────────────────────────────────────────

// TestHygCliOrgForm_GrantPrincipalResolvesToTheUserId pins the identity this group is easiest to get
// wrong: for a `user` principal the grant carries the USER id, not the member id.
//
// The PDP reads `principal_type = 'user' and principal_id = <user id>`, and the console's grants
// query joins principal_id to user.id. A member id here produces a grant that is stored, syncs a
// tuple, and grants nobody anything — a failure with no error anywhere, which is why the id is
// asserted against the posted BODY and not merely against a 200.
func TestHygCliOrgForm_GrantPrincipalResolvesToTheUserId(t *testing.T) {
	s, run := orgFormEnv(t, orgFormDefaultPayloads())
	code, out := run("grants", "add", "--principal", "ada@example.com", "--role", "deployers",
		"--no-input", "--output", "json")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0\n       said: %q", code, strings.TrimSpace(out))
	}
	body := s.body(http.MethodPost, "/api/cli/grants")
	if body == "" {
		t.Fatal("no grant was posted")
	}
	if !strings.Contains(body, orgFormUserID) {
		t.Errorf("the grant does not carry the user id %s:\n       %s", orgFormUserID, body)
	}
	if strings.Contains(body, orgFormMemberID) {
		t.Errorf("the grant carries the MEMBER id %s; the PDP matches on the user id, so this grant "+
			"would be stored and grant nobody anything:\n       %s", orgFormMemberID, body)
	}
	// The role name resolved too — the same lookup rule, the other field.
	if !strings.Contains(body, orgFormRoleID) {
		t.Errorf("--role deployers did not resolve to %s:\n       %s", orgFormRoleID, body)
	}
}

// TestHygCliOrgForm_BuiltInRoleIsNotDeletable pins the silent no-op this pass found.
//
// `DELETE /api/cli/roles/:id` filters on `is_builtin = false`, so naming a template deletes nothing
// and still answers `{ok: true}` — `alethia roles delete owner` printed "Role deleted". Both arms
// are asserted: the name is refused, and NO delete reaches the control plane.
func TestHygCliOrgForm_BuiltInRoleIsNotDeletable(t *testing.T) {
	s, run := orgFormEnv(t, orgFormDefaultPayloads())
	code, out := run("roles", "delete", "--name", "owner", "--yes", "--no-input")
	if code == 0 {
		t.Fatalf("exit code = 0; naming a built-in template must be refused, not reported as a deletion\n"+
			"       said: %q", strings.TrimSpace(out))
	}
	for _, req := range s.requests {
		if strings.HasPrefix(req, http.MethodDelete+" /api/cli/roles/") {
			t.Errorf("a delete was sent for a built-in template: %s", req)
		}
	}
	if !strings.Contains(out, "deployers") {
		t.Errorf("the refusal does not say which roles CAN be deleted:\n       %q", strings.TrimSpace(out))
	}
}

// TestHygCliOrgForm_NoCustomRolesIsItsOwnAnswer pins the empty case, which the test above cannot
// reach: with no custom roles at all, `roles delete` must say so rather than offering an empty
// picker or a bare "not found".
func TestHygCliOrgForm_NoCustomRolesIsItsOwnAnswer(t *testing.T) {
	p := orgFormDefaultPayloads()
	p.roles = p.roles[:1] // the owner template alone
	s, run := orgFormEnv(t, p)
	code, out := run("roles", "delete", "--name", "deployers", "--yes", "--no-input")
	if code == 0 {
		t.Fatalf("exit code = 0 with no custom role to delete\n       said: %q", strings.TrimSpace(out))
	}
	if !strings.Contains(out, "built-in") {
		t.Errorf("the message does not explain that the templates are not deletable:\n       %q",
			strings.TrimSpace(out))
	}
	if muts := s.mutations(); len(muts) > 0 {
		t.Errorf("state changed although there was nothing to delete: %v", muts)
	}
}

// ── the resolver's arms, unit ───────────────────────────────────────────────────────────────────

// orgFormChoices is a fixed candidate list for the resolver's own arms.
func orgFormChoices() []orgChoice {
	return []orgChoice{
		{ID: "id-web", Label: "web · 2 members", Keys: []string{"web"}},
		{ID: "id-platform", Label: "platform · 3 members", Keys: []string{"platform"}},
	}
}

func TestHygCliOrgForm_ResolveArms(t *testing.T) {
	spec := teamPickSpec
	list := func() ([]orgChoice, error) { return orgFormChoices(), nil }

	t.Run("an id passes through and fetches nothing", func(t *testing.T) {
		fetched := 0
		ref, err := resolveOrgChoice(spec, "id-web", "", func() ([]orgChoice, error) {
			fetched++
			return orgFormChoices(), nil
		})
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		if ref.ID != "id-web" {
			t.Errorf("id = %q, want %q", ref.ID, "id-web")
		}
		if ref.Summary != "" {
			t.Errorf("summary = %q; nothing is announced for an id the caller typed", ref.Summary)
		}
		if fetched != 0 {
			t.Errorf("the candidate list was fetched %d time(s) for a caller who already had the id", fetched)
		}
	})

	t.Run("the selector resolves and is announced", func(t *testing.T) {
		ref, err := resolveOrgChoice(spec, "", "platform", list)
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		if ref.ID != "id-platform" {
			t.Errorf("id = %q, want %q", ref.ID, "id-platform")
		}
		if ref.Summary == "" {
			t.Error("a choice the CLI made must carry a summary, or a destructive command cannot say " +
				"what it is about to act on")
		}
	})

	t.Run("the selector is case-insensitive", func(t *testing.T) {
		ref, err := resolveOrgChoice(spec, "", "PLATFORM", list)
		if err != nil || ref.ID != "id-platform" {
			t.Errorf("resolve = %v, %v; a team name is not a case-sensitive token", ref, err)
		}
	})

	t.Run("both is refused, and refused before the fetch", func(t *testing.T) {
		fetched := 0
		_, err := resolveOrgChoice(spec, "id-web", "platform", func() ([]orgChoice, error) {
			fetched++
			return orgFormChoices(), nil
		})
		if err == nil {
			t.Fatal("passing an id AND a selector must be refused; silently preferring one deletes " +
				"the thing the caller did not name")
		}
		if fetched != 0 {
			t.Errorf("the list was fetched %d time(s) before an answer that does not depend on it", fetched)
		}
	})

	t.Run("an unknown name lists the ones that exist", func(t *testing.T) {
		_, err := resolveOrgChoice(spec, "", "nope", list)
		if err == nil {
			t.Fatal("an unmatched selector must be an error")
		}
		for _, want := range []string{"web", "platform"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("the error does not name the available %q: %v", want, err)
			}
		}
		if strings.Contains(err.Error(), "id-web") {
			t.Errorf("the error offers an ID as an alternative, which is what the caller was avoiding: %v", err)
		}
	})

	t.Run("an empty list is the spec's own sentence", func(t *testing.T) {
		_, err := resolveOrgChoice(spec, "", "web", func() ([]orgChoice, error) { return nil, nil })
		if err == nil || err.Error() != spec.Empty {
			t.Errorf("err = %v, want %q", err, spec.Empty)
		}
	})

	t.Run("a fetch failure is reported, never read as empty", func(t *testing.T) {
		// The assertion is on WHICH error, not on there being one. A resolver that dropped the
		// fetch error would fall through to the empty-list branch and still return something
		// non-nil — so `err != nil` passes while the caller is told "this organization has no
		// teams" about an org whose teams simply could not be read. The mutation that deletes the
		// `if err != nil` survived exactly that weaker assertion.
		errBoom := errors.New("the control plane refused the read")
		boom := func() ([]orgChoice, error) { return nil, errBoom }
		_, err := resolveOrgChoice(spec, "", "web", boom)
		if !errors.Is(err, errBoom) {
			t.Fatalf("err = %v, want the fetch error; a list that could not be READ must never be "+
				"reported as a list that is EMPTY", err)
		}
	})

	t.Run("nothing named, nothing promptable, names the flag", func(t *testing.T) {
		orgFormScripted(t)
		_, err := resolveOrgChoice(spec, "", "", list)
		if err == nil {
			t.Fatal("with no id, no selector and no prompt there is no answer")
		}
		if !strings.Contains(err.Error(), "--"+spec.Field.Selector) {
			t.Errorf("the refusal does not name --%s: %v", spec.Field.Selector, err)
		}
		if !strings.Contains(err.Error(), spec.ListCmd) {
			t.Errorf("the refusal does not say where to look (%s): %v", spec.ListCmd, err)
		}
	})

	t.Run("a spec with no selector refuses without inventing one", func(t *testing.T) {
		orgFormScripted(t)
		_, err := resolveOrgChoice(grantPickSpec, "", "", list)
		if err == nil {
			t.Fatal("expected a refusal")
		}
		if strings.Contains(err.Error(), "to name it") {
			t.Errorf("a grant has no selector flag and the refusal must not offer one: %v", err)
		}
		if !strings.Contains(err.Error(), grantPickSpec.Field.Arg) {
			t.Errorf("the refusal does not name the positional %s: %v", grantPickSpec.Field.Arg, err)
		}
	})
}

// TestHygCliOrgForm_ResolveByNameOrIDPassesAUuidStraightThrough pins the rule that makes
// `--principal` and `--role` safe to treat as lookup keys: a uuid is already the answer.
func TestHygCliOrgForm_ResolveByNameOrIDPassesAUuidStraightThrough(t *testing.T) {
	fetched := 0
	list := func() ([]orgChoice, error) { fetched++; return orgFormChoices(), nil }

	ref, err := resolveByNameOrID(teamPickSpec, orgFormTeamID, list)
	if err != nil || ref.ID != orgFormTeamID {
		t.Fatalf("resolve = %v, %v; a uuid is the id the server wants", ref, err)
	}
	if fetched != 0 {
		t.Errorf("a uuid cost %d round trip(s)", fetched)
	}

	if ref, err := resolveByNameOrID(teamPickSpec, "", list); err != nil || ref.ID != "" {
		t.Errorf("an empty value resolves to nothing, not to an error: %v, %v", ref, err)
	}
	if fetched != 0 {
		t.Errorf("an empty value cost %d round trip(s)", fetched)
	}

	if ref, err := resolveByNameOrID(teamPickSpec, "platform", list); err != nil || ref.ID != "id-platform" {
		t.Errorf("a name must be looked up: %v, %v", ref, err)
	}
	if fetched != 1 {
		t.Errorf("the name cost %d round trip(s), want 1", fetched)
	}

	// Which error, not whether there is one — the same weakness that let a dropped fetch error
	// survive in resolveOrgChoice, one function along.
	errBoom := errors.New("the control plane refused the read")
	_, err = resolveByNameOrID(teamPickSpec, "platform", func() ([]orgChoice, error) { return nil, errBoom })
	if !errors.Is(err, errBoom) {
		t.Errorf("err = %v, want the fetch error; a lookup that could not READ the list must not "+
			"report the list as EMPTY", err)
	}
}

// TestHygCliOrgForm_LooksLikeUUIDMatchesTheWireShape pins the discriminator itself against the shape
// `z.uuid()` accepts, in both directions. It is the whole basis for "not a uuid means look it up".
func TestHygCliOrgForm_LooksLikeUUIDMatchesTheWireShape(t *testing.T) {
	yes := []string{
		orgFormUserID,
		"00000000-0000-0000-0000-000000000000",
		"F47AC10B-58CC-4372-A567-0E02B2C3D479",
	}
	no := []string{
		"", "u1", "ada@example.com", "platform", "deployers",
		"11111111-1111-4111-8111-11111111111",   // one short
		"11111111-1111-4111-8111-1111111111111", // one long
		"11111111_1111_4111_8111_111111111111",  // wrong separators
		"11111111-1111-4111-8111-11111111111g",  // not hex
	}
	for _, v := range yes {
		if !looksLikeUUID(v) {
			t.Errorf("looksLikeUUID(%q) = false; the server would have taken it", v)
		}
	}
	for _, v := range no {
		if looksLikeUUID(v) {
			t.Errorf("looksLikeUUID(%q) = true; it would be posted to a z.uuid() field and 400", v)
		}
	}
}

// TestHygCliOrgForm_ClosedSetsMirrorTheRoute pins --principal-type and --effect against the enums in
// createGrantBody, in both directions, and pins that --resource-type is NOT validated.
//
// The last part is the one worth stating: `resource_type` is `z.string().min(1)` on the wire, so a
// CLI that refused a kind outside its own suggestion list would be refusing something the control
// plane stores. The suggestions exist to fill a picker, not to gate a flag.
func TestHygCliOrgForm_ClosedSetsMirrorTheRoute(t *testing.T) {
	for _, v := range grantPrincipalTypes {
		if err := requireOneOf("principal-type", v, grantPrincipalTypes); err != nil {
			t.Errorf("%q is in the set and was refused: %v", v, err)
		}
	}
	if err := requireOneOf("principal-type", "USER", grantPrincipalTypes); err != nil {
		t.Errorf("the check is case-sensitive, so `--principal-type USER` is refused: %v", err)
	}
	err := requireOneOf("principal-type", "service", grantPrincipalTypes)
	if err == nil {
		t.Fatal("a principal kind outside the route's z.enum must be refused")
	}
	for _, want := range []string{"--principal-type", "service", "user", "team"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not name %q: %v", want, err)
		}
	}
	if err := requireOneOf("effect", "audit", grantEffects); err == nil {
		t.Error("an effect outside allow/deny must be refused")
	}

	s, run := orgFormEnv(t, orgFormDefaultPayloads())
	code, out := run("grants", "add", "--principal", orgFormUserID, "--role", orgFormRoleID,
		"--resource-type", "something_new", "--resource", orgFormGrantID, "--no-input", "--output", "json")
	if code != 0 {
		t.Fatalf("a resource kind the CLI has never heard of must reach the server, which stores it; "+
			"exit = %d, said %q", code, strings.TrimSpace(out))
	}
	if !s.saw(http.MethodPost, "/api/cli/grants") {
		t.Errorf("the grant was not sent; requests = %v", s.requests)
	}
}

// TestHygCliOrgForm_PermissionCatalogIsTheServersOwn pins where the permission checklist comes from.
//
// The union over the returned roles, de-duplicated and sorted — and the owner template alone already
// carries every key, because the route expands its "*". Nothing here is a list typed into the CLI,
// which is what stops the checklist from going stale when a permission is added to the product.
func TestHygCliOrgForm_PermissionCatalogIsTheServersOwn(t *testing.T) {
	roles := []struct {
		name string
		keys []string
	}{
		{"owner", []string{"project:deploy", "project:plan", "member:view"}},
		{"deployers", []string{"project:deploy"}},
		{"empty", nil},
	}
	var in []apiRoleForCatalog
	for _, r := range roles {
		in = append(in, apiRoleForCatalog{Name: r.name, PermissionKeys: r.keys})
	}
	got := permissionCatalog(orgFormRoles(in))
	want := []string{"member:view", "project:deploy", "project:plan"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("catalog = %v, want %v (sorted, de-duplicated)", got, want)
	}
	if len(permissionCatalog(nil)) != 0 {
		t.Error("no roles is an empty catalog, which callers answer with an error rather than an " +
			"unanswerable empty checklist")
	}
}

// ── the forms, driven ───────────────────────────────────────────────────────────────────────────

// TestHygCliOrgForm_TeamsCreateAsksForTheName drives the real Input widget the production code
// built, with real key messages, and reads what lands in the bound variable.
//
// A stub of runHuhForm returning nil cannot answer a form — the value is written through a pointer
// huh owns — so it can only ever prove what happens when the user abandons the prompt. That is how a
// form gets wired to the wrong variable and stays green.
func TestHygCliOrgForm_TeamsCreateAsksForTheName(t *testing.T) {
	orgFormInteractive(t)
	keys := authFormType("platform")
	keys = authFormKey(keys, tea.KeyEnter)
	script := &authFormScript{keys: keys}
	authFormAnswer(t, script)

	name, err := promptName("alethia teams create", orgFieldKeyName)
	if err != nil {
		t.Fatalf("promptName: %v", err)
	}
	if !script.ran {
		t.Fatal("no form was opened")
	}
	if name != "platform" {
		t.Errorf("name = %q, want %q — the input is bound to a different variable than it is read from", name, "platform")
	}
}

// TestHygCliOrgForm_TeamsCreateRejectsABlankName pins the validator: a form that accepted an empty
// answer would create a team the org cannot tell apart from any other.
func TestHygCliOrgForm_TeamsCreateRejectsABlankName(t *testing.T) {
	orgFormInteractive(t)
	script := &authFormScript{keys: authFormKey(nil, tea.KeyEnter)}
	authFormAnswer(t, script)

	if _, err := promptName("alethia teams create", orgFieldKeyName); err != nil {
		t.Fatalf("promptName: %v", err)
	}
	if script.state == huh.StateCompleted {
		t.Error("the form completed on an empty name; nothing validates the input")
	}
}

// TestHygCliOrgForm_MembersAddAsksForBothFields drives the two-question form and asserts BOTH
// answers, because a form that asked for the email and then discarded the role would look identical
// from the outside.
func TestHygCliOrgForm_MembersAddAsksForBothFields(t *testing.T) {
	orgFormInteractive(t)
	// One form, two groups: the email page, then the role page. Enter submits the first and huh
	// moves to the second, so the whole thing is a single script.
	keys := authFormType("newcomer@example.com")
	keys = authFormKey(keys, tea.KeyEnter, tea.KeyDown, tea.KeyEnter)
	script := &authFormScript{keys: keys}
	authFormAnswer(t, script)

	client := orgFormFakeRoles{roles: orgFormRoles([]apiRoleForCatalog{
		{Name: "owner", PermissionKeys: []string{"project:deploy"}},
		{Name: "deployers", PermissionKeys: []string{"project:deploy"}},
	})}
	email, role, err := promptMembersAdd(client, "", "member", true)
	if err != nil {
		t.Fatalf("promptMembersAdd: %v", err)
	}
	if !script.ran {
		t.Fatal("no form was opened")
	}
	if email != "newcomer@example.com" {
		t.Errorf("email = %q", email)
	}
	// The caller's current value is offered first (it is not one of the org's role names), so one
	// Down lands on the first real role.
	if role != "owner" {
		t.Errorf("role = %q, want %q — the select is bound to a different variable than it is read from", role, "owner")
	}
}

// TestHygCliOrgForm_MembersAddRejectsANonAddress pins the email validator, and pins that it is
// SHALLOW on purpose: it catches the blank and the missing @, and does not out-guess the server's
// own z.string().email().
func TestHygCliOrgForm_MembersAddRejectsANonAddress(t *testing.T) {
	if err := requireEmail(""); err == nil {
		t.Error("an empty answer is not an address")
	}
	if err := requireEmail("newcomer"); err == nil {
		t.Error("a bare word is not an address")
	}
	if err := requireEmail(" ada@example.com "); err != nil {
		t.Errorf("a padded address is one the server accepts: %v", err)
	}
}

// TestHygCliOrgForm_RolePermissionsOffersTheServerCatalog drives the multi-select and asserts what
// it wrote back, plus the empty-catalog refusal — the arm where a form would otherwise open a box
// with no options in it.
func TestHygCliOrgForm_RolePermissionsOffersTheServerCatalog(t *testing.T) {
	orgFormInteractive(t)
	// space selects the focused option, enter submits.
	keys := []tea.KeyMsg{{Type: tea.KeyRunes, Runes: []rune{' '}}}
	keys = authFormKey(keys, tea.KeyEnter)
	script := &authFormScript{keys: keys}
	authFormAnswer(t, script)

	client := orgFormFakeRoles{roles: orgFormRoles([]apiRoleForCatalog{
		{Name: "owner", PermissionKeys: []string{"project:plan", "member:view"}},
	})}
	got, err := promptRolePermissions(client, nil)
	if err != nil {
		t.Fatalf("promptRolePermissions: %v", err)
	}
	if !script.ran {
		t.Fatal("no form was opened")
	}
	// Sorted, so the first option is member:view.
	if len(got) != 1 || got[0] != "member:view" {
		t.Errorf("selected = %v, want [member:view] — the multi-select is bound to a different "+
			"variable than it is read from", got)
	}

	empty := orgFormFakeRoles{roles: orgFormRoles([]apiRoleForCatalog{{Name: "owner"}})}
	if _, err := promptRolePermissions(empty, nil); err == nil {
		t.Error("an empty catalog must be an error naming --permission, not a checklist with no rows")
	}

	// A roles call that FAILED must not become "there are no permissions": the operator would be
	// told to pass --permission by hand for a control plane that is simply unreachable.
	errBoom := errors.New("the control plane refused the read")
	if _, err := promptRolePermissions(orgFormFakeRoles{err: errBoom}, nil); !errors.Is(err, errBoom) {
		t.Errorf("err = %v, want the fetch error", err)
	}
}

// TestHygCliOrgForm_FormsRefuseByNamingTheFlagWhenScripted pins that every prompt in this group
// answers a scripted caller with the flag to pass, not with "interactive input required".
//
// It drives the prompts DIRECTLY rather than through cobra, so it covers the ones a command reaches
// only after other work — and it asserts the message, which is the whole contract.
func TestHygCliOrgForm_FormsRefuseByNamingTheFlagWhenScripted(t *testing.T) {
	orgFormScripted(t)
	client := orgFormFakeRoles{roles: orgFormRoles([]apiRoleForCatalog{{Name: "owner", PermissionKeys: []string{"a:b"}}})}

	if _, _, err := promptMembersAdd(client, "", "member", true); err == nil {
		t.Error("promptMembersAdd must refuse when no form can be shown")
	} else if !strings.Contains(err.Error(), "[email]") {
		t.Errorf("the refusal does not name the positional: %v", err)
	}
	if _, err := promptName("alethia teams create", orgFieldKeyName); err == nil {
		t.Error("promptName must refuse when no form can be shown")
	} else if !strings.Contains(err.Error(), "[name]") {
		t.Errorf("the refusal does not name the positional: %v", err)
	}
	if _, err := promptRolePermissions(client, nil); err == nil {
		t.Error("promptRolePermissions must refuse when no form can be shown")
	} else if !strings.Contains(err.Error(), "--permission") {
		t.Errorf("the refusal does not name the flag: %v", err)
	}
}

// TestHygCliOrgForm_FormAvailabilityReadsBothStreams pins the condition the pickers use.
//
// noInputMode is derived from stdin alone, so `alethia teams delete 2> log` from an interactive
// shell left prompting "enabled" and drew the form's ANSI frames into the log file.
//
// The second stream is the one a form DRAWS on, which is STDERR — huh v0.8.0 builds its bubbletea
// program with tea.WithOutput(os.Stderr), and ui.InteractiveOutput states that once for the CLI.
// This test read stdout when it was written, which is wrong in both directions: it refused
// `alethia teams delete -o json > f`, whose picker would have rendered fine on the attached stderr,
// and it permitted the redirect that actually hangs. Measured against the shipped binary under a
// real pty before this was corrected.
//
// The tables are the one widget that does read stdout, and correctly: ui.ShowTable takes
// bubbletea's own default output, and a table is not narration — it IS the answer.
func TestHygCliOrgForm_FormAvailabilityReadsBothStreams(t *testing.T) {
	prevIn, prevOut, prevForm, prevMode := stdinIsTTY, stdoutIsTTY, interactiveOutIsTTY, noInputMode
	t.Cleanup(func() {
		stdinIsTTY, stdoutIsTTY, interactiveOutIsTTY, noInputMode = prevIn, prevOut, prevForm, prevMode
	})

	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return true }
	interactiveOutIsTTY = func() bool { return true }
	noInputMode = false
	if !canPromptForm() {
		t.Error("both streams a terminal and prompting on: a form can be shown")
	}

	interactiveOutIsTTY = func() bool { return false }
	if canPromptForm() {
		t.Error("the form's stream redirected: it would draw into the redirection and the user " +
			"would see nothing")
	}

	interactiveOutIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return false }
	if !canPromptForm() {
		t.Error("a redirected STDOUT must not stop a form that draws on stderr — " +
			"`alethia teams delete -o json > f` at a terminal is a working invocation")
	}

	stdoutIsTTY = func() bool { return true }
	noInputMode = true
	if canPromptForm() {
		t.Error("--no-input: no form may be shown")
	}
}

// ── the announcement ────────────────────────────────────────────────────────────────────────────

// TestHygCliOrgForm_ResolvedTargetIsAnnouncedOnStderr pins where the "which one did it pick" line
// goes, and that it goes nowhere when the caller named the target themselves.
//
// Stdout would break `-o json` and land in the middle of a grep; and describing an id back at the
// person who typed it is noise.
func TestHygCliOrgForm_ResolvedTargetIsAnnouncedOnStderr(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	prev := os.Stderr
	os.Stderr = w
	announceResolvedChoice("platform · 3 members", "Deleting")
	announceResolvedChoice("", "Deleting")
	os.Stderr = prev
	_ = w.Close()
	b, _ := io.ReadAll(r)
	_ = r.Close()

	out := orgFormAnsi.ReplaceAllString(string(b), "")
	if !strings.Contains(out, "Deleting platform") {
		t.Errorf("the resolved target was not announced on stderr: %q", out)
	}
	if strings.Count(out, "Deleting") != 1 {
		t.Errorf("an empty summary must announce nothing; got %q", out)
	}
}

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────

// apiRoleForCatalog is the two fields the catalog and the role picker read. It exists so a test can
// build roles without naming every wire field; orgFormRoles converts it to the REAL api.Role, so the
// production code is never handed a substitute shape.
type apiRoleForCatalog struct {
	Name           string
	PermissionKeys []string
}

// orgFormRoles builds real api.Role values from the shorthand above.
func orgFormRoles(in []apiRoleForCatalog) []api.Role {
	out := make([]api.Role, len(in))
	for i, r := range in {
		out[i] = api.Role{
			ID:             "role-" + r.Name,
			Name:           r.Name,
			IsBuiltin:      r.Name == "owner",
			PermissionKeys: r.PermissionKeys,
		}
	}
	return out
}

// orgFormFakeRoles satisfies roleLister with a fixed answer.
type orgFormFakeRoles struct {
	roles []api.Role
	err   error
}

func (f orgFormFakeRoles) ListRoles() ([]api.Role, error) { return f.roles, f.err }
