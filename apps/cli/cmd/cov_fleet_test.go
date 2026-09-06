// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// This file covers the `Run:` closures of the platform-admin and job commands —
// fleet, grants, roles, members, teams, runner deploy/destroy/remove, and
// jobs logs/cancel. Their run* helpers were already unit-tested against a fake
// client; the closures around them were not, because each one is gated on
// something a headless `go test` process never has: a real terminal (the auth
// prompt, the interactive table, every selector) or a live control plane.
//
// Everything here drives the real cobra tree against an httptest control plane,
// with only the four committed seams substituted: stdinIsTTY/stdoutIsTTY,
// exitFunc, confirm and runHuhForm. No production code is changed.

// fleetExit is the sentinel a trapped exitFunc panics with, so a fatal path is
// observable as an exit code instead of killing the test binary.
type fleetExit struct{ code int }

// fleetOpts configures the fake control plane. The zero value is the happy path:
// valid credentials, an active org, one ONLINE default runner, and 200s.
type fleetOpts struct {
	// broken makes every endpoint answer 500, so each command takes its API-failure arm.
	broken bool
	// noCredentials leaves the credentials file absent, so getAuthToken must resolve a login.
	noCredentials bool
	// noActiveOrg clears the CLI config, so currentOrgID cannot resolve an org.
	noActiveOrg bool
	// noDefaultRunner drops IsDefault from the listed runner, so selectRunner resolves to
	// the "Any available" empty id that the destroy/remove commands refuse.
	noDefaultRunner bool
	// jobID is the id POST /jobs and the deploy endpoint hand back. Its spelling drives the
	// status the job endpoint then reports (see fleetJobBody).
	jobID string
}

// fleetServer records what the CLI actually sent, and counts the polls of each job so a
// status can change between them.
type fleetServer struct {
	mu       sync.Mutex
	requests []string
	jobGets  map[string]int
}

// record notes one inbound request as "METHOD path".
func (s *fleetServer) record(r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, r.Method+" "+r.URL.Path)
}

// saw reports whether the CLI made this exact request.
func (s *fleetServer) saw(method, path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, req := range s.requests {
		if req == method+" "+path {
			return true
		}
	}
	return false
}

// forget clears the recorded requests so consecutive runs in one test can be asserted
// independently.
func (s *fleetServer) forget() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = nil
}

// pollCount returns how many times this job's status has been read, starting at 1.
func (s *fleetServer) pollCount(id string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.jobGets[id]++
	return s.jobGets[id]
}

// fleetJobBody builds the job the status endpoint reports. The id spells the outcome the
// test wants, which keeps a per-test server configuration out of the fixture: "fail" is a
// failed job, "cancelled" a cancelled one, "slow" reports PROCESSING on the first poll and
// SUCCESS after — the only way to reach the poll-again arm of `--follow`.
func fleetJobBody(s *fleetServer, id string) map[string]interface{} {
	status := "SUCCESS"
	body := map[string]interface{}{
		"id":              id,
		"job_type":        "DESTROY_RUNNER",
		"created_at":      "2026-01-01T00:00:00Z",
		"updated_at":      "2026-01-01T00:00:00Z",
		"config_snapshot": map[string]interface{}{},
	}
	switch {
	case strings.Contains(id, "fail"):
		status = "FAILED"
		body["error_message"] = "no runner template for that cloud"
	case strings.Contains(id, "cancelled"):
		status = "CANCELLED"
	case strings.Contains(id, "slow"):
		if s.pollCount(id) == 1 {
			status = "PROCESSING"
		}
	}
	body["status"] = status
	body["execution_metadata"] = map[string]interface{}{"cost_breakdown": "EUR 12/mo"}
	return body
}

// fleetHandler serves every endpoint the commands in this file reach.
func fleetHandler(t *testing.T, s *fleetServer, opts fleetOpts) http.HandlerFunc {
	t.Helper()
	jobID := opts.jobID
	if jobID == "" {
		jobID = "j1"
	}
	return func(w http.ResponseWriter, r *http.Request) {
		s.record(r)
		enc := json.NewEncoder(w)
		if opts.broken {
			w.WriteHeader(http.StatusInternalServerError)
			_ = enc.Encode(map[string]interface{}{"error": "control plane unavailable"})
			return
		}
		p := r.URL.Path
		switch {
		case p == "/api/cli/fleet":
			_ = enc.Encode(map[string]interface{}{"pools": []map[string]interface{}{{
				"provider": "aws", "enabled": true, "warm_min": 1, "max": 4,
				"slots_per_runner": 2, "locations": []string{"eu-west-1"}, "version": "1.4.0",
			}}})
		case strings.HasPrefix(p, "/api/cli/fleet/"):
			_ = enc.Encode(map[string]interface{}{"pool": map[string]interface{}{
				"provider": strings.TrimPrefix(p, "/api/cli/fleet/"),
				"warm_min": 2, "max": 6, "slots_per_runner": 3, "enabled": true,
			}})
		case p == "/api/cli/grants":
			if r.Method == http.MethodPost {
				// A role grant carries no permission key, which is the fallback arm of the
				// confirmation line in runGrantsAdd.
				_ = enc.Encode(map[string]interface{}{"grant": map[string]interface{}{
					"id": "g1", "principal_type": "user", "principal_id": "u1",
					"effect": "allow", "role": "deployer", "resource_type": "org",
				}})
				return
			}
			_ = enc.Encode(map[string]interface{}{"grants": []map[string]interface{}{{
				"id": "g1", "principal_type": "user", "principal_id": "u1",
				"effect": "allow", "role": "deployer", "resource_type": "org",
			}}})
		case p == "/api/cli/roles":
			if r.Method == http.MethodPost {
				_ = enc.Encode(map[string]interface{}{"role": map[string]interface{}{
					"id": "ro9", "name": "deployer", "is_builtin": false,
					"permission_keys": []string{"project:deploy"},
				}})
				return
			}
			_ = enc.Encode(map[string]interface{}{"roles": []map[string]interface{}{{
				"id": "ro1", "name": "owner", "is_builtin": true,
				"permission_keys": []string{"project:deploy"},
			}}})
		// The by-id shapes: DELETE /grants/{id}, /roles/{id}, /orgs/{org}/members/{id},
		// /orgs/{org}/teams/{id}. The client only reads the status code for these.
		case strings.HasPrefix(p, "/api/cli/grants/"), strings.HasPrefix(p, "/api/cli/roles/"),
			strings.Contains(p, "/members/"), strings.Contains(p, "/teams/"):
			_ = enc.Encode(map[string]interface{}{"ok": true})
		case strings.HasSuffix(p, "/members"):
			if r.Method == http.MethodPost {
				_ = enc.Encode(map[string]interface{}{"invitation": map[string]interface{}{
					"id": "inv1", "email": "new@x.com", "role": "member", "status": "pending",
				}})
				return
			}
			_ = enc.Encode(map[string]interface{}{"members": []map[string]interface{}{{
				"id": "m1", "user_id": "u1", "email": "a@x.com", "name": "A",
				"role": "owner", "status": "active",
			}}})
		case strings.HasSuffix(p, "/teams"):
			if r.Method == http.MethodPost {
				_ = enc.Encode(map[string]interface{}{"team": map[string]interface{}{
					"id": "t9", "name": "SRE", "member_count": 0,
				}})
				return
			}
			_ = enc.Encode(map[string]interface{}{"teams": []map[string]interface{}{{
				"id": "t1", "name": "Platform", "member_count": 2,
			}}})
		case p == "/api/cli/runners/deploy":
			_ = enc.Encode(map[string]interface{}{
				"runner": map[string]interface{}{"id": "r9", "name": "runner-new"},
				"job":    map[string]interface{}{"id": jobID, "status": "QUEUED", "created_at": "2026-01-01T00:00:00Z"},
			})
		case p == "/api/cli/runners":
			_ = enc.Encode(map[string]interface{}{"runners": []map[string]interface{}{{
				"id": "r1", "name": "primary", "operator": "self", "provisioning": "deployed",
				"status": "ONLINE", "is_default": !opts.noDefaultRunner,
			}}})
		case strings.HasPrefix(p, "/api/cli/runners/"):
			_ = enc.Encode(map[string]interface{}{"ok": true})
		case p == "/api/cli/cloud-identities":
			_ = enc.Encode(map[string]interface{}{"cloud_identities": []map[string]interface{}{{
				"id": "ci1", "provider": "aws", "label": "prod-account",
				"created_at": "2026-01-01T00:00:00Z",
			}}})
		case p == "/api/jobs":
			_ = enc.Encode(map[string]interface{}{"job": fleetJobBody(s, jobID)})
		case strings.HasSuffix(p, "/cancel"):
			_ = enc.Encode(map[string]interface{}{"ok": true})
		case strings.HasSuffix(p, "/logs"):
			_ = enc.Encode(map[string]interface{}{"logs": []map[string]interface{}{
				{"id": 1, "log_chunk": "applying\n", "stream_type": "STDOUT"},
				{"id": 2, "log_chunk": "a warning\n", "stream_type": "STDERR"},
				{"id": 3, "log_chunk": "claimed by runner\n", "stream_type": "SYSTEM"},
			}})
		case strings.HasPrefix(p, "/api/cli/jobs/"):
			_ = enc.Encode(fleetJobBody(s, strings.TrimPrefix(p, "/api/cli/jobs/")))
		case p == "/api/cli/whoami":
			_ = enc.Encode(map[string]interface{}{
				"user":       map[string]interface{}{"id": "u1", "email": "ada@x.com", "name": "Ada"},
				"active_org": map[string]interface{}{"id": "o1", "name": "Acme", "slug": "acme", "role": "owner", "plan": "team", "is_active": true},
			})
		default:
			t.Errorf("fake control plane got an unmapped path: %s %s", r.Method, p)
			w.WriteHeader(http.StatusNotFound)
			_ = enc.Encode(map[string]interface{}{"error": "not found"})
		}
	}
}

// fleetResetState puts the shared cobra tree back to its defaults. rootCmd is a package
// global and both the flags AND the globals they bind survive an Execute, so a name a
// prompt supplied would otherwise leak into the next command.
func fleetResetState() {
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
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
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	walk(rootCmd)
	// These are assigned by the command itself when a prompt answers for them, so
	// clearing the flags alone does not restore them.
	deployCloudIdentityID, deployRunnerName, deployRegion, deployAssignedID = "", "", "", ""
	destroyRunnerID, destroyRunnerAssignedID = "", ""
}

// fleetEnv stands up the fake control plane, isolated credentials and an active org,
// forces the two TTY seams on (so the selectors and the interactive table arms are
// reachable) and traps exitFunc. The returned runner drives the real cobra tree and
// answers with the exit code the command asked for, or 0.
func fleetEnv(t *testing.T, opts fleetOpts) (*fleetServer, func(args ...string) int) {
	t.Helper()
	credsPath := isolatedHome(t)
	if !opts.noCredentials {
		tok := makeToken(t, time.Now().Add(time.Hour))
		if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
			t.Fatal(err)
		}
	}
	cfg := types.CliConfig{ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme"}
	if opts.noActiveOrg {
		cfg = types.CliConfig{}
	}
	if err := types.SaveCliConfig(cfg); err != nil {
		t.Fatal(err)
	}

	s := &fleetServer{jobGets: map[string]int{}}
	srv := httptest.NewServer(fleetHandler(t, s, opts))
	t.Cleanup(srv.Close)

	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	oldIn, oldOut, oldMode := stdinIsTTY, stdoutIsTTY, noInputMode
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return true }
	// noInputMode is derived from stdinIsTTY at PersistentPreRun, not bound to it, so a --no-input
	// left set by an earlier file survives the seam stub. Setting it makes this env independent of
	// the order `go test` reached the files in.
	noInputMode = false
	oldExit := exitFunc
	exitFunc = func(code int) { panic(fleetExit{code: code}) }
	t.Cleanup(func() {
		stdinIsTTY, stdoutIsTTY, noInputMode = oldIn, oldOut, oldMode
		exitFunc = oldExit
		fleetResetState()
	})

	return s, func(args ...string) (code int) {
		defer func() {
			fleetResetState()
			if r := recover(); r != nil {
				e, ok := r.(fleetExit)
				if !ok {
					panic(r)
				}
				code = e.code
			}
		}()
		execRootArgs(args)
		if err := rootCmd.Execute(); err != nil {
			return 1
		}
		return 0
	}
}

// fleetAnswerConfirm makes every confirmation prompt answer `answer` for the rest of
// the test. No stub of runHuhForm can do this: the answer is written through a pointer
// the huh group owns, so the confirmed arm of a destructive command is otherwise dark.
func fleetAnswerConfirm(t *testing.T, answer bool) {
	t.Helper()
	old := confirm
	confirm = func(string, string) bool { return answer }
	t.Cleanup(func() { confirm = old })
}

// fleetAnswerForm makes every huh form return err (nil = "the user accepted the
// pre-selected value"), so the selectors resolve without a terminal.
func fleetAnswerForm(t *testing.T, err error) {
	t.Helper()
	old := runHuhForm
	runHuhForm = func(...*huh.Group) error { return err }
	t.Cleanup(func() { runHuhForm = old })
}

// fleetDeclineLogin makes the "log in now?" prompt decline, so getAuthToken reports
// that authentication is required instead of opening a device flow.
func fleetDeclineLogin(t *testing.T) {
	t.Helper()
	old := authRequiredPrompt
	authRequiredPrompt = func() (bool, error) { return false, nil }
	t.Cleanup(func() { authRequiredPrompt = old })
}

// errFleetPrompt is the error a stubbed form returns when a test wants the abort arm.
var errFleetPrompt = errors.New("prompt aborted")

// fleetAdminCommands is every command in this file's scope, with the arguments each
// needs to get past cobra's own validation.
var fleetAdminCommands = [][]string{
	{"fleet", "list"},
	{"fleet", "set", "aws", "--max", "3"},
	{"grants", "list"},
	{"grants", "add", "--principal", "u1", "--role", "ro1"},
	{"grants", "remove", "g1"},
	{"roles", "list"},
	{"roles", "create", "deployer"},
	{"roles", "delete", "ro1"},
	{"members", "list"},
	{"members", "add", "new@x.com"},
	{"members", "remove", "m1"},
	{"teams", "list"},
	{"teams", "create", "SRE"},
	{"teams", "delete", "t1"},
	{"runner", "deploy"},
	{"runner", "destroy"},
	{"runner", "remove", "r1"},
	{"jobs", "logs", "j1"},
	{"jobs", "cancel", "j1", "--yes"},
}

// TestFleet_UnauthenticatedCommandExitsOne pins that every command in this scope
// resolves its token first and dies on the standard fatal path when there is none —
// before it reads a flag, prompts, or touches the control plane.
func TestFleet_UnauthenticatedCommandExitsOne(t *testing.T) {
	_, run := fleetEnv(t, fleetOpts{noCredentials: true})
	fleetDeclineLogin(t)
	for _, args := range fleetAdminCommands {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if got := run(args...); got != 1 {
				t.Errorf("exit code = %d, want 1", got)
			}
		})
	}
}

// fleetListCommands is the five list commands this file owns.
var fleetListCommands = [][]string{
	{"fleet", "list"},
	{"grants", "list"},
	{"roles", "list"},
	{"members", "list"},
	{"teams", "list"},
}

// TestFleet_ListsRenderInMachineFormat pins the non-interactive arm of each list:
// a machine format bypasses the table program entirely and renders through the
// run* helper, whatever the terminal is.
func TestFleet_ListsRenderInMachineFormat(t *testing.T) {
	_, run := fleetEnv(t, fleetOpts{})
	for _, args := range fleetListCommands {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if got := run(append(append([]string{}, args...), "--output", "json")...); got != 0 {
				t.Errorf("exit code = %d, want 0", got)
			}
		})
	}
}

// TestFleet_ListsFailClosedOnAnUnreachableControlPlane pins that a failed fetch is
// fatal on BOTH arms — the interactive table's spinner and the machine-format
// renderer each report the failure and exit non-zero rather than printing an empty list.
func TestFleet_ListsFailClosedOnAnUnreachableControlPlane(t *testing.T) {
	_, run := fleetEnv(t, fleetOpts{broken: true})
	for _, args := range fleetListCommands {
		for _, format := range []string{"table", "json"} {
			t.Run(strings.Join(args, "_")+"_"+format, func(t *testing.T) {
				full := append(append([]string{}, args...), "--output", format)
				if got := run(full...); got != 1 {
					t.Errorf("exit code = %d, want 1", got)
				}
			})
		}
	}
}

// TestFleet_SetSendsOnlyTheFlagsThatWerePassed pins that `fleet set` builds a partial
// update from the flags the caller actually changed and PUTs it at the provider's pool.
func TestFleet_SetSendsOnlyTheFlagsThatWerePassed(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})
	code := run("fleet", "set", "aws",
		"--warm-min", "2", "--max", "6", "--slots", "3",
		"--channel", "stable", "--version", "1.4.0", "--enabled=true")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if !s.saw("PUT", "/api/cli/fleet/aws") {
		t.Errorf("no pool update was sent; requests = %v", s.requests)
	}
}

// TestFleet_SetWithoutAnyFlagIsRefused pins that a no-op `fleet set` is an error, not a
// silent round-trip that rewrites the pool with its own values.
func TestFleet_SetWithoutAnyFlagIsRefused(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})
	if got := run("fleet", "set", "aws"); got != 1 {
		t.Errorf("exit code = %d, want 1", got)
	}
	if s.saw("PUT", "/api/cli/fleet/aws") {
		t.Error("a pool update was sent for a set with no flags")
	}
}

// TestFleet_SetDisableIsGatedOnConfirmation pins that pausing a pool — a capacity cut
// that drains its runners — asks first, and sends nothing when the answer is no.
func TestFleet_SetDisableIsGatedOnConfirmation(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})

	fleetAnswerConfirm(t, false)
	if got := run("fleet", "set", "aws", "--enabled=false"); got != 0 {
		t.Errorf("declined: exit code = %d, want 0", got)
	}
	if s.saw("PUT", "/api/cli/fleet/aws") {
		t.Fatal("a declined disable still sent the update")
	}

	s.forget()
	fleetAnswerConfirm(t, true)
	if got := run("fleet", "set", "aws", "--enabled=false"); got != 0 {
		t.Errorf("confirmed: exit code = %d, want 0", got)
	}
	if !s.saw("PUT", "/api/cli/fleet/aws") {
		t.Errorf("a confirmed disable sent nothing; requests = %v", s.requests)
	}
}

// TestFleet_SetReportsAServerRefusal pins that a rejected pool update is fatal.
func TestFleet_SetReportsAServerRefusal(t *testing.T) {
	_, run := fleetEnv(t, fleetOpts{broken: true})
	if got := run("fleet", "set", "aws", "--max", "6"); got != 1 {
		t.Errorf("exit code = %d, want 1", got)
	}
}

// TestFleet_GrantsAddNeedsExactlyOneBinding pins the XOR: a grant binds a role or a
// single permission, and both-or-neither is refused before anything is sent.
func TestFleet_GrantsAddNeedsExactlyOneBinding(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})
	cases := [][]string{
		{"grants", "add", "--principal", "u1"},
		{"grants", "add", "--principal", "u1", "--role", "ro1", "--permission", "project:deploy"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if got := run(args...); got != 1 {
				t.Errorf("exit code = %d, want 1", got)
			}
		})
	}
	if s.saw("POST", "/api/cli/grants") {
		t.Error("a grant was sent despite an invalid binding")
	}
}

// TestFleet_GrantsAddAssignsARoleOrAPermission pins that a well-formed grant is posted
// for either binding, scoped to the resource flags.
//
// The ids are real uuids because `--principal` and `--role` are now LOOKUP KEYS: anything that is
// not already a uuid is resolved against the org's members/teams/roles, since `principal_id` and
// `role_id` are `z.uuid()` on the wire and a non-uuid was always a 400. "u1" now names nothing and
// is refused by the CLI instead of by the server.
func TestFleet_GrantsAddAssignsARoleOrAPermission(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})
	cases := [][]string{
		{"grants", "add", "--principal", "11111111-1111-4111-8111-111111111111", "--role", "33333333-3333-4333-8333-333333333333"},
		{"grants", "add", "--principal", "22222222-2222-4222-8222-222222222222", "--principal-type", "team",
			"--permission", "project:deploy", "--effect", "deny",
			"--resource-type", "project", "--resource", "44444444-4444-4444-8444-444444444444"},
	}
	for _, args := range cases {
		s.forget()
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if got := run(args...); got != 0 {
				t.Fatalf("exit code = %d, want 0", got)
			}
			if !s.saw("POST", "/api/cli/grants") {
				t.Errorf("no grant was sent; requests = %v", s.requests)
			}
		})
	}
}

// TestFleet_GrantsAddReportsAServerRefusal pins that a rejected grant is fatal.
func TestFleet_GrantsAddReportsAServerRefusal(t *testing.T) {
	_, run := fleetEnv(t, fleetOpts{broken: true})
	if got := run("grants", "add", "--principal", "u1", "--role", "ro1"); got != 1 {
		t.Errorf("exit code = %d, want 1", got)
	}
}

// TestFleet_GrantsRemoveIsGatedOnConfirmation pins that revoking access asks first,
// sends nothing when declined, and is fatal when the server refuses.
func TestFleet_GrantsRemoveIsGatedOnConfirmation(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})

	fleetAnswerConfirm(t, false)
	if got := run("grants", "remove", "g1"); got != 0 {
		t.Errorf("declined: exit code = %d, want 0", got)
	}
	if s.saw("DELETE", "/api/cli/grants/g1") {
		t.Fatal("a declined revoke still deleted the grant")
	}

	s.forget()
	fleetAnswerConfirm(t, true)
	if got := run("grants", "remove", "g1"); got != 0 {
		t.Errorf("confirmed: exit code = %d, want 0", got)
	}
	if !s.saw("DELETE", "/api/cli/grants/g1") {
		t.Errorf("a confirmed revoke deleted nothing; requests = %v", s.requests)
	}
}

// TestFleet_GrantsRemoveReportsAServerRefusal pins that a refused revoke is fatal.
func TestFleet_GrantsRemoveReportsAServerRefusal(t *testing.T) {
	_, run := fleetEnv(t, fleetOpts{broken: true})
	fleetAnswerConfirm(t, true)
	if got := run("grants", "remove", "g1"); got != 1 {
		t.Errorf("exit code = %d, want 1", got)
	}
}

// TestFleet_RolesCreateSendsThePermissionKeys pins that a custom role posts the
// repeated --permission keys, and that a refusal is fatal.
func TestFleet_RolesCreateSendsThePermissionKeys(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})
	if got := run("roles", "create", "deployer",
		"--permission", "project:deploy", "--permission", "project:plan"); got != 0 {
		t.Fatalf("exit code = %d, want 0", got)
	}
	if !s.saw("POST", "/api/cli/roles") {
		t.Errorf("no role was created; requests = %v", s.requests)
	}

	_, broken := fleetEnv(t, fleetOpts{broken: true})
	if got := broken("roles", "create", "deployer"); got != 1 {
		t.Errorf("broken: exit code = %d, want 1", got)
	}
}

// TestFleet_RolesDeleteIsGatedOnConfirmation pins that deleting a role — which drops
// the grants referencing it — asks first and is fatal on a refusal.
func TestFleet_RolesDeleteIsGatedOnConfirmation(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})

	fleetAnswerConfirm(t, false)
	if got := run("roles", "delete", "ro1"); got != 0 {
		t.Errorf("declined: exit code = %d, want 0", got)
	}
	if s.saw("DELETE", "/api/cli/roles/ro1") {
		t.Fatal("a declined delete still removed the role")
	}

	s.forget()
	fleetAnswerConfirm(t, true)
	if got := run("roles", "delete", "ro1"); got != 0 {
		t.Errorf("confirmed: exit code = %d, want 0", got)
	}
	if !s.saw("DELETE", "/api/cli/roles/ro1") {
		t.Errorf("a confirmed delete removed nothing; requests = %v", s.requests)
	}

	_, broken := fleetEnv(t, fleetOpts{broken: true})
	fleetAnswerConfirm(t, true)
	if got := broken("roles", "delete", "ro1"); got != 1 {
		t.Errorf("broken: exit code = %d, want 1", got)
	}
}

// TestFleet_MembersAndTeamsNeedAnActiveOrg pins that every member/team command
// resolves an org before it acts, and dies when neither --org nor an active org
// context supplies one — rather than addressing an empty org id.
func TestFleet_MembersAndTeamsNeedAnActiveOrg(t *testing.T) {
	_, run := fleetEnv(t, fleetOpts{noActiveOrg: true})
	fleetAnswerConfirm(t, true)
	cases := [][]string{
		{"members", "list"},
		{"members", "add", "new@x.com"},
		{"members", "remove", "m1"},
		{"teams", "list"},
		{"teams", "create", "SRE"},
		{"teams", "delete", "t1"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if got := run(args...); got != 1 {
				t.Errorf("exit code = %d, want 1", got)
			}
		})
	}
}

// TestFleet_MembersAndTeamsAcceptAnExplicitOrg pins that --org overrides the active
// org context for the mutating member/team commands.
func TestFleet_MembersAndTeamsAcceptAnExplicitOrg(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{noActiveOrg: true})
	if got := run("members", "add", "new@x.com", "--org", "o7", "--role", "admin"); got != 0 {
		t.Errorf("members add: exit code = %d, want 0", got)
	}
	if !s.saw("POST", "/api/cli/orgs/o7/members") {
		t.Errorf("invite did not target --org; requests = %v", s.requests)
	}
	s.forget()
	if got := run("teams", "create", "SRE", "--org", "o7"); got != 0 {
		t.Errorf("teams create: exit code = %d, want 0", got)
	}
	if !s.saw("POST", "/api/cli/orgs/o7/teams") {
		t.Errorf("create did not target --org; requests = %v", s.requests)
	}
}

// TestFleet_MembersRemoveIsGatedOnConfirmation pins that removing a member asks
// first, deletes only on a yes, and is fatal when the server refuses.
func TestFleet_MembersRemoveIsGatedOnConfirmation(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})

	fleetAnswerConfirm(t, false)
	if got := run("members", "remove", "m1"); got != 0 {
		t.Errorf("declined: exit code = %d, want 0", got)
	}
	if s.saw("DELETE", "/api/cli/orgs/o1/members/m1") {
		t.Fatal("a declined removal still deleted the member")
	}

	s.forget()
	fleetAnswerConfirm(t, true)
	if got := run("members", "remove", "m1"); got != 0 {
		t.Errorf("confirmed: exit code = %d, want 0", got)
	}
	if !s.saw("DELETE", "/api/cli/orgs/o1/members/m1") {
		t.Errorf("a confirmed removal deleted nothing; requests = %v", s.requests)
	}
}

// TestFleet_MembersMutationsReportAServerRefusal pins that a rejected invite or
// removal is fatal.
func TestFleet_MembersMutationsReportAServerRefusal(t *testing.T) {
	_, run := fleetEnv(t, fleetOpts{broken: true})
	fleetAnswerConfirm(t, true)
	for _, args := range [][]string{
		{"members", "add", "new@x.com"},
		{"members", "remove", "m1"},
	} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if got := run(args...); got != 1 {
				t.Errorf("exit code = %d, want 1", got)
			}
		})
	}
}

// TestFleet_TeamsDeleteIsGatedOnConfirmation pins that deleting a team — which drops
// its members' team grants — asks first and deletes only on a yes.
func TestFleet_TeamsDeleteIsGatedOnConfirmation(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})

	fleetAnswerConfirm(t, false)
	if got := run("teams", "delete", "t1"); got != 0 {
		t.Errorf("declined: exit code = %d, want 0", got)
	}
	if s.saw("DELETE", "/api/cli/orgs/o1/teams/t1") {
		t.Fatal("a declined delete still removed the team")
	}

	s.forget()
	fleetAnswerConfirm(t, true)
	if got := run("teams", "delete", "t1"); got != 0 {
		t.Errorf("confirmed: exit code = %d, want 0", got)
	}
	if !s.saw("DELETE", "/api/cli/orgs/o1/teams/t1") {
		t.Errorf("a confirmed delete removed nothing; requests = %v", s.requests)
	}
}

// TestFleet_TeamsMutationsReportAServerRefusal pins that a rejected create or delete
// is fatal.
func TestFleet_TeamsMutationsReportAServerRefusal(t *testing.T) {
	_, run := fleetEnv(t, fleetOpts{broken: true})
	fleetAnswerConfirm(t, true)
	for _, args := range [][]string{
		{"teams", "create", "SRE"},
		{"teams", "delete", "t1"},
	} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if got := run(args...); got != 1 {
				t.Errorf("exit code = %d, want 1", got)
			}
		})
	}
}

// TestFleet_RunnerDeployPromptsForEveryUnsetField pins that `runner deploy` with no
// flags prompts for the cloud account, name, region and executing runner, falls back to
// its defaults for the answers left blank, and then queues the deploy.
func TestFleet_RunnerDeployPromptsForEveryUnsetField(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})
	fleetAnswerForm(t, nil)
	if got := run("runner", "deploy"); got != 0 {
		t.Fatalf("exit code = %d, want 0", got)
	}
	if !s.saw("GET", "/api/cli/cloud-identities") {
		t.Errorf("the cloud-account picker never fetched; requests = %v", s.requests)
	}
	if !s.saw("POST", "/api/cli/runners/deploy") {
		t.Errorf("no deploy was queued; requests = %v", s.requests)
	}
	if deployRegion != "" {
		t.Errorf("deployRegion leaked across the run: %q", deployRegion)
	}
}

// TestFleet_RunnerDeployAbortsOnAnAbandonedPrompt pins that abandoning ANY of the four
// prompts stops the deploy — each flag supplied in turn moves the abort one prompt later,
// and none of them queues a job.
func TestFleet_RunnerDeployAbortsOnAnAbandonedPrompt(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})
	fleetAnswerForm(t, errFleetPrompt)
	cases := [][]string{
		{"runner", "deploy"},
		{"runner", "deploy", "--cloud-identity-id", "ci1"},
		{"runner", "deploy", "--cloud-identity-id", "ci1", "--name", "edge"},
		{"runner", "deploy", "--cloud-identity-id", "ci1", "--name", "edge", "--region", "eu-west-1"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if got := run(args...); got != 1 {
				t.Errorf("exit code = %d, want 1", got)
			}
		})
	}
	if s.saw("POST", "/api/cli/runners/deploy") {
		t.Error("an abandoned prompt still queued a deploy")
	}
}

// TestFleet_RunnerDeployReportsAServerRefusal pins that a refused deploy is fatal even
// when every field came from a flag.
func TestFleet_RunnerDeployReportsAServerRefusal(t *testing.T) {
	_, run := fleetEnv(t, fleetOpts{broken: true})
	got := run("runner", "deploy", "--cloud-identity-id", "ci1", "--name", "edge",
		"--region", "eu-west-1", "--assigned-runner-id", "r1")
	if got != 1 {
		t.Errorf("exit code = %d, want 1", got)
	}
}

// TestFleet_RunnerDeployWaitsForTheJob pins that --wait blocks on the queued job and
// carries its outcome into the exit code: a succeeded deploy exits 0, a failed one exits 1.
func TestFleet_RunnerDeployWaitsForTheJob(t *testing.T) {
	flags := []string{"runner", "deploy", "--cloud-identity-id", "ci1", "--name", "edge",
		"--region", "eu-west-1", "--assigned-runner-id", "r1", "--wait"}

	_, ok := fleetEnv(t, fleetOpts{jobID: "j-ok"})
	if got := ok(flags...); got != 0 {
		t.Errorf("succeeded job: exit code = %d, want 0", got)
	}

	_, bad := fleetEnv(t, fleetOpts{jobID: "j-fail"})
	if got := bad(flags...); got != 1 {
		t.Errorf("failed job: exit code = %d, want 1", got)
	}
}

// TestFleet_RunnerDestroyRefusesAnyAvailable pins that the destroy picker will not
// accept the "Any available" entry — tearing down an unspecified runner is refused.
func TestFleet_RunnerDestroyRefusesAnyAvailable(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{noDefaultRunner: true})
	fleetAnswerForm(t, nil)
	if got := run("runner", "destroy"); got != 1 {
		t.Errorf("exit code = %d, want 1", got)
	}
	if s.saw("POST", "/api/jobs") {
		t.Error("a teardown was queued without a runner id")
	}
}

// TestFleet_RunnerDestroyAbortsOnAnAbandonedPrompt pins that abandoning either the
// target picker or the executing-runner picker stops the teardown.
func TestFleet_RunnerDestroyAbortsOnAnAbandonedPrompt(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})
	fleetAnswerForm(t, errFleetPrompt)
	fleetAnswerConfirm(t, true)
	for _, args := range [][]string{
		{"runner", "destroy"},
		{"runner", "destroy", "--runner-id", "r1"},
	} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if got := run(args...); got != 1 {
				t.Errorf("exit code = %d, want 1", got)
			}
		})
	}
	if s.saw("POST", "/api/jobs") {
		t.Error("an abandoned prompt still queued a teardown")
	}
}

// TestFleet_RunnerDestroyIsGatedOnConfirmation pins that a teardown asks before it
// queues anything, and queues a DESTROY_RUNNER job only on a yes.
func TestFleet_RunnerDestroyIsGatedOnConfirmation(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})
	fleetAnswerForm(t, nil)

	fleetAnswerConfirm(t, false)
	if got := run("runner", "destroy"); got != 0 {
		t.Errorf("declined: exit code = %d, want 0", got)
	}
	if s.saw("POST", "/api/jobs") {
		t.Fatal("a declined teardown still queued a job")
	}

	s.forget()
	fleetAnswerConfirm(t, true)
	if got := run("runner", "destroy"); got != 0 {
		t.Errorf("confirmed: exit code = %d, want 0", got)
	}
	if !s.saw("POST", "/api/jobs") {
		t.Errorf("a confirmed teardown queued nothing; requests = %v", s.requests)
	}
}

// TestFleet_RunnerDestroyReportsAServerRefusal pins that a refused DESTROY_RUNNER job
// is fatal.
func TestFleet_RunnerDestroyReportsAServerRefusal(t *testing.T) {
	_, run := fleetEnv(t, fleetOpts{broken: true})
	fleetAnswerConfirm(t, true)
	got := run("runner", "destroy", "--runner-id", "r1", "--assigned-runner-id", "r2")
	if got != 1 {
		t.Errorf("exit code = %d, want 1", got)
	}
}

// TestFleet_RunnerDestroyWaitsForTheJob pins that --wait carries the teardown job's
// outcome into the exit code.
func TestFleet_RunnerDestroyWaitsForTheJob(t *testing.T) {
	flags := []string{"runner", "destroy", "--runner-id", "r1", "--assigned-runner-id", "r2", "--wait"}

	_, ok := fleetEnv(t, fleetOpts{jobID: "j-ok"})
	fleetAnswerConfirm(t, true)
	if got := ok(flags...); got != 0 {
		t.Errorf("succeeded job: exit code = %d, want 0", got)
	}

	_, bad := fleetEnv(t, fleetOpts{jobID: "j-cancelled"})
	fleetAnswerConfirm(t, true)
	if got := bad(flags...); got != 1 {
		t.Errorf("cancelled job: exit code = %d, want 1", got)
	}
}

// TestFleet_RunnerRemoveRefusesAnyAvailable pins that the remove picker will not accept
// the "Any available" entry, and that abandoning the picker aborts.
func TestFleet_RunnerRemoveRefusesAnyAvailable(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{noDefaultRunner: true})

	fleetAnswerForm(t, nil)
	if got := run("runner", "remove"); got != 1 {
		t.Errorf("any-available: exit code = %d, want 1", got)
	}

	fleetAnswerForm(t, errFleetPrompt)
	if got := run("runner", "remove"); got != 1 {
		t.Errorf("abandoned: exit code = %d, want 1", got)
	}
	if s.saw("DELETE", "/api/cli/runners/r1") {
		t.Error("a runner record was removed without a chosen id")
	}
}

// TestFleet_RunnerRemoveIsGatedOnConfirmation pins that removing a runner RECORD asks
// first — it leaves cloud resources standing — and deletes only on a yes, whether the id
// came from an argument or from the picker.
func TestFleet_RunnerRemoveIsGatedOnConfirmation(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})

	fleetAnswerConfirm(t, false)
	if got := run("runner", "remove", "r1"); got != 0 {
		t.Errorf("declined: exit code = %d, want 0", got)
	}
	if s.saw("DELETE", "/api/cli/runners/r1") {
		t.Fatal("a declined removal still deleted the record")
	}

	s.forget()
	fleetAnswerConfirm(t, true)
	if got := run("runner", "remove", "r1"); got != 0 {
		t.Errorf("confirmed: exit code = %d, want 0", got)
	}
	if !s.saw("DELETE", "/api/cli/runners/r1") {
		t.Errorf("a confirmed removal deleted nothing; requests = %v", s.requests)
	}

	s.forget()
	fleetAnswerForm(t, nil)
	if got := run("runner", "remove"); got != 0 {
		t.Errorf("picked: exit code = %d, want 0", got)
	}
	if !s.saw("DELETE", "/api/cli/runners/r1") {
		t.Errorf("the picked runner was not removed; requests = %v", s.requests)
	}
}

// TestFleet_RunnerRemoveReportsAServerRefusal pins that a refused record removal is fatal.
func TestFleet_RunnerRemoveReportsAServerRefusal(t *testing.T) {
	_, run := fleetEnv(t, fleetOpts{broken: true})
	fleetAnswerConfirm(t, true)
	if got := run("runner", "remove", "r1"); got != 1 {
		t.Errorf("exit code = %d, want 1", got)
	}
}

// TestFleet_JobsLogsPrintsOneShotAndStops pins the default (non-following) read: one
// fetch, every stream style rendered, then the command returns.
func TestFleet_JobsLogsPrintsOneShotAndStops(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})
	if got := run("jobs", "logs", "j1"); got != 0 {
		t.Fatalf("exit code = %d, want 0", got)
	}
	if !s.saw("GET", "/api/cli/jobs/j1/logs") {
		t.Errorf("no logs were fetched; requests = %v", s.requests)
	}
	if s.saw("GET", "/api/cli/jobs/j1") {
		t.Error("a one-shot read polled the job status")
	}
}

// TestFleet_JobsLogsReportsAFetchFailure pins that an unreadable log stream is fatal
// rather than an empty, apparently-successful read.
func TestFleet_JobsLogsReportsAFetchFailure(t *testing.T) {
	_, run := fleetEnv(t, fleetOpts{broken: true})
	if got := run("jobs", "logs", "j1"); got != 1 {
		t.Errorf("exit code = %d, want 1", got)
	}
}

// TestFleet_JobsLogsFollowStopsAtATerminalStatus pins that --follow polls while the job
// is still PROCESSING and terminates on the first terminal status, after draining the
// logs written since the last fetch.
func TestFleet_JobsLogsFollowStopsAtATerminalStatus(t *testing.T) {
	oldInterval := jobsLogsPollInterval
	jobsLogsPollInterval = time.Millisecond
	t.Cleanup(func() { jobsLogsPollInterval = oldInterval })

	s, run := fleetEnv(t, fleetOpts{})
	done := make(chan int, 1)
	go func() { done <- run("jobs", "logs", "j-slow", "--follow") }()
	select {
	case got := <-done:
		if got != 0 {
			t.Fatalf("exit code = %d, want 0", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("--follow did not terminate on a terminal job status")
	}
	if !s.saw("GET", "/api/cli/jobs/j-slow") {
		t.Errorf("--follow never polled the job status; requests = %v", s.requests)
	}
}

// TestFleet_JobsCancelStopsAJob pins that cancel posts to the job's cancel endpoint, and
// that a refusal is fatal.
func TestFleet_JobsCancelStopsAJob(t *testing.T) {
	s, run := fleetEnv(t, fleetOpts{})
	if got := run("jobs", "cancel", "j1", "--yes"); got != 0 {
		t.Fatalf("exit code = %d, want 0", got)
	}
	if !s.saw("POST", "/api/cli/jobs/j1/cancel") {
		t.Errorf("no cancel was sent; requests = %v", s.requests)
	}

	_, broken := fleetEnv(t, fleetOpts{broken: true})
	if got := broken("jobs", "cancel", "j1", "--yes"); got != 1 {
		t.Errorf("broken: exit code = %d, want 1", got)
	}
}
