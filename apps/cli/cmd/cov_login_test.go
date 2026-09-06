// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
)

// --- shared fixtures for the auth/device-login coverage group -----------------
//
// Every identifier here carries the authCov prefix so it cannot collide with
// another group's helpers in this package.

// authCovExit is the sentinel a trapped exitFunc panics with, so a fatal CLI path
// can be observed without os.Exit killing the test binary.
type authCovExit struct{ code int }

// authCovTrapExit replaces exitFunc with a panicking stub for the test's duration.
func authCovTrapExit(t *testing.T) {
	t.Helper()
	prev := exitFunc
	exitFunc = func(code int) { panic(authCovExit{code}) }
	t.Cleanup(func() { exitFunc = prev })
}

// authCovWantExit runs fn and asserts it reached the fatal path (exitFunc), which
// the trap turns into an authCovExit panic. Any other panic is re-raised.
func authCovWantExit(t *testing.T, what string, fn func()) {
	t.Helper()
	exited := false
	func() {
		defer func() {
			r := recover()
			if r == nil {
				return
			}
			if e, ok := r.(authCovExit); ok {
				exited = true
				if e.code != 1 {
					t.Errorf("%s: exit code = %d, want 1", what, e.code)
				}
				return
			}
			panic(r)
		}()
		fn()
	}()
	if !exited {
		t.Errorf("%s: expected the fatal path (exitFunc), it returned normally", what)
	}
}

// authCovTTY pretends stdin and stdout are terminals so the interactive arms —
// requireInteractive, and through it every selector — are reachable.
func authCovTTY(t *testing.T) {
	t.Helper()
	prevIn, prevOut, prevMode := stdinIsTTY, stdoutIsTTY, noInputMode
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return true }
	noInputMode = false
	t.Cleanup(func() {
		stdinIsTTY, stdoutIsTTY, noInputMode = prevIn, prevOut, prevMode
	})
}

// authCovForm swaps runHuhForm for a stub returning err, standing in for the
// answer a user would have given at the prompt.
func authCovForm(t *testing.T, err error) {
	t.Helper()
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return err }
	t.Cleanup(func() { runHuhForm = prev })
}

// authCovConfirmYes swaps runHuhForm for a stub that drives the REAL huh widgets
// with the "y" key — the answer a user gives at a confirm — rather than returning
// a canned nil. A bare *huh.Group carries no keymap (huh binds one only when a
// Form runs it), so the default keymap is applied first; without it no key matches
// and the bound value is never written.
func authCovConfirmYes(t *testing.T) {
	t.Helper()
	prev := runHuhForm
	runHuhForm = func(groups ...*huh.Group) error {
		for _, g := range groups {
			grp := g.WithKeyMap(huh.NewDefaultKeyMap())
			_ = grp.Init()
			grp.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("y")})
		}
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })
}

// authCovKilledProgram makes the device-login Bubble Tea program fail to run, so
// performLoginFlow returns an error instead of completing.
func authCovKilledProgram(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	authCovHeadless(t, tea.WithContext(ctx))
}

// authCovOrigin points the CLI's control-plane origin at the given URL.
func authCovOrigin(t *testing.T, url string) {
	t.Helper()
	t.Setenv("ALETHIA_WEB_ORIGIN", url)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
}

// authCovServer starts a fake control plane and points the CLI at it.
func authCovServer(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	authCovOrigin(t, srv.URL)
	return srv
}

// authCovJSON writes v as a JSON body with the given status.
func authCovJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// authCovHeadless makes performLoginFlow run its Bubble Tea program off the
// terminal and never open a real browser.
func authCovHeadless(t *testing.T, opts ...tea.ProgramOption) {
	t.Helper()
	prevOpts, prevBrowser := loginProgramOptions, openBrowser
	loginProgramOptions = append([]tea.ProgramOption{
		tea.WithInput(nil),
		tea.WithOutput(io.Discard),
		tea.WithoutSignalHandler(),
	}, opts...)
	openBrowser = func(string) error { return nil }
	t.Cleanup(func() { loginProgramOptions, openBrowser = prevOpts, prevBrowser })
}

// authCovExchange is a handler that answers the device-code exchange with a
// successful token payload.
func authCovExchange(email string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authCovJSON(w, http.StatusOK, types.ExchangeResponse{
			AccessToken: "access-tok", RefreshToken: "refresh-tok", UserEmail: email,
		})
	}
}

// authCovRunCLI executes the real Cobra tree with args, restoring the sticky
// package-global flag state the login command binds to.
func authCovRunCLI(t *testing.T, args ...string) error {
	t.Helper()
	prevForce, prevOrigin := forceLogin, loginWebOrigin
	t.Cleanup(func() {
		forceLogin, loginWebOrigin = prevForce, prevOrigin
		execRootArgs(nil)
	})
	execRootArgs(args)
	return rootCmd.Execute()
}

// --- login.go · the Bubble Tea model -----------------------------------------

// TestAuth_ModelInitAndView pins the device-login model's three rendered states:
// the spinner while waiting, the welcome line once authenticated, and the error
// line when the exchange failed.
func TestAuth_ModelInitAndView(t *testing.T) {
	m := initialModel()
	if !m.loading || m.done {
		t.Fatalf("initialModel should start loading and not done: %+v", m)
	}
	if m.Init() == nil {
		t.Error("Init should return the spinner tick command")
	}
	if got := m.View(); !strings.Contains(got, "Waiting for authentication") {
		t.Errorf("loading view = %q", got)
	}

	done := model{done: true, userEmail: "ada@x.com"}
	if got := done.View(); !strings.Contains(got, "ada@x.com") {
		t.Errorf("done view should welcome the user, got %q", got)
	}

	failed := model{err: errors.New("boom")}
	if got := failed.View(); !strings.Contains(got, "boom") {
		t.Errorf("error view should show the error, got %q", got)
	}

	if got := (model{}).View(); got != "" {
		t.Errorf("an idle model should render nothing, got %q", got)
	}
}

// TestAuth_ModelUpdateSuccessPersists pins that the success message ends the
// program AND writes the credentials file — the only place the device flow
// persists a token.
func TestAuth_ModelUpdateSuccessPersists(t *testing.T) {
	credsPath := isolatedHome(t)

	next, cmd := initialModel().Update(authSuccessMsg{response: &types.ExchangeResponse{
		AccessToken: "a1", RefreshToken: "r1", UserEmail: "ada@x.com",
	}})
	m, ok := next.(model)
	if !ok {
		t.Fatalf("Update returned %T, want model", next)
	}
	if m.loading || !m.done || m.userEmail != "ada@x.com" {
		t.Errorf("success should stop the spinner and record the email: %+v", m)
	}
	if cmd == nil {
		t.Error("success should quit the program")
	}

	data, err := os.ReadFile(credsPath)
	if err != nil {
		t.Fatalf("credentials should have been written: %v", err)
	}
	var got types.ExchangeResponse
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.AccessToken != "a1" {
		t.Errorf("stored token = %q, want a1", got.AccessToken)
	}
}

// TestAuth_ModelUpdateErrorAndKeys pins the remaining Update arms: a failed
// exchange records the error and quits, ctrl-c/esc quit, any other key is
// ignored, and unknown messages are forwarded to the spinner.
func TestAuth_ModelUpdateErrorAndKeys(t *testing.T) {
	next, cmd := initialModel().Update(authErrorMsg{err: errors.New("denied")})
	m, ok := next.(model)
	if !ok {
		t.Fatalf("Update returned %T, want model", next)
	}
	if m.loading || m.err == nil {
		t.Errorf("an auth error should stop the spinner and record the error: %+v", m)
	}
	if cmd == nil {
		t.Error("an auth error should quit the program")
	}

	for _, kt := range []tea.KeyType{tea.KeyCtrlC, tea.KeyEsc} {
		if _, quit := initialModel().Update(tea.KeyMsg{Type: kt}); quit == nil {
			t.Errorf("key %v should quit the program", kt)
		}
	}
	if _, quit := initialModel().Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'x'}}); quit != nil {
		t.Error("an unrelated key should not quit the program")
	}
	if _, tick := initialModel().Update(spinner.TickMsg{}); tick == nil {
		t.Error("an unknown message should be forwarded to the spinner")
	}
}

// --- login.go · pollForToken --------------------------------------------------

// TestAuth_PollForTokenSuccess pins that a 200 from the exchange endpoint yields
// the success message carrying the token payload.
func TestAuth_PollForTokenSuccess(t *testing.T) {
	srv := authCovServer(t, authCovExchange("ada@x.com"))

	msg := pollForToken("dev-code", srv.URL+"/api/auth/cli/exchange")()
	ok, is := msg.(authSuccessMsg)
	if !is {
		t.Fatalf("msg = %#v, want authSuccessMsg", msg)
	}
	if ok.response.UserEmail != "ada@x.com" {
		t.Errorf("response = %+v", ok.response)
	}
}

// TestAuth_PollForTokenPendingThenSuccess pins the "pending" contract: a 404 is
// not an error, it means the user has not approved yet, so the poller sleeps and
// retries until the exchange succeeds.
func TestAuth_PollForTokenPendingThenSuccess(t *testing.T) {
	prev := loginPollInterval
	loginPollInterval = time.Millisecond
	t.Cleanup(func() { loginPollInterval = prev })

	var calls atomic.Int32
	srv := authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < 3 {
			authCovJSON(w, http.StatusNotFound, map[string]string{"error": "pending"})
			return
		}
		authCovExchange("late@x.com")(w, r)
	})

	msg := pollForToken("dev-code", srv.URL+"/api/auth/cli/exchange")()
	ok, is := msg.(authSuccessMsg)
	if !is {
		t.Fatalf("msg = %#v, want authSuccessMsg after the pending polls", msg)
	}
	if ok.response.UserEmail != "late@x.com" {
		t.Errorf("response = %+v", ok.response)
	}
	if got := calls.Load(); got != 3 {
		t.Errorf("expected 3 polls (two pending), got %d", got)
	}
}

// TestAuth_PollForTokenDenied pins that any non-404 status is fatal — a denied or
// expired device code must stop the poll instead of spinning forever.
func TestAuth_PollForTokenDenied(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"denied", http.StatusForbidden, "access_denied"},
		{"expired", http.StatusGone, "expired_token"},
		{"malformed", http.StatusBadRequest, "invalid_request"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
				authCovJSON(w, tc.status, map[string]string{"error": tc.body})
			})
			msg := pollForToken("dev-code", srv.URL+"/api/auth/cli/exchange")()
			bad, is := msg.(authErrorMsg)
			if !is {
				t.Fatalf("msg = %#v, want authErrorMsg", msg)
			}
			if !strings.Contains(bad.err.Error(), tc.body) {
				t.Errorf("error should carry the server reason, got %v", bad.err)
			}
		})
	}
}

// TestAuth_PollForTokenTransportError pins that an unreachable control plane is
// reported as a connection failure rather than retried forever.
func TestAuth_PollForTokenTransportError(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL + "/api/auth/cli/exchange"
	srv.Close()

	msg := pollForToken("dev-code", url)()
	bad, is := msg.(authErrorMsg)
	if !is {
		t.Fatalf("msg = %#v, want authErrorMsg", msg)
	}
	if !strings.Contains(bad.err.Error(), "failed to connect to server") {
		t.Errorf("error = %v", bad.err)
	}
}

// --- login.go · saveTokens fatal arms ----------------------------------------

// TestAuth_SaveTokensFatalArms pins that saveTokens takes the fatal path — not a
// silent no-op — when the credentials path cannot be resolved, its directory
// cannot be created, or the file cannot be opened.
func TestAuth_SaveTokensFatalArms(t *testing.T) {
	authCovTrapExit(t)
	tokens := &types.ExchangeResponse{AccessToken: "a"}

	t.Run("unresolvable path", func(t *testing.T) {
		t.Setenv("HOME", "")
		t.Setenv("XDG_CONFIG_HOME", "")
		authCovWantExit(t, "saveTokens without a home", func() { saveTokens(tokens) })
	})

	t.Run("directory blocked by a file", func(t *testing.T) {
		dir := t.TempDir()
		t.Setenv("HOME", dir)
		t.Setenv("XDG_CONFIG_HOME", dir)
		credsPath, err := getCredentialsPath()
		if err != nil {
			t.Fatal(err)
		}
		parent := filepath.Dir(credsPath)
		if err := os.MkdirAll(filepath.Dir(parent), 0o755); err != nil {
			t.Fatal(err)
		}
		// A regular file where the config directory must go: MkdirAll fails.
		if err := os.WriteFile(parent, []byte("not a directory"), 0o600); err != nil {
			t.Fatal(err)
		}
		authCovWantExit(t, "saveTokens over a file", func() { saveTokens(tokens) })
	})

	t.Run("credentials path is a directory", func(t *testing.T) {
		credsPath := isolatedHome(t)
		if err := os.MkdirAll(credsPath, 0o755); err != nil {
			t.Fatal(err)
		}
		authCovWantExit(t, "saveTokens onto a directory", func() { saveTokens(tokens) })
	})
}

// --- login.go · performLoginFlow ---------------------------------------------

// TestAuth_PerformLoginFlowWritesCredentials pins the whole device flow end to
// end: the first-run warning is shown, the browser is offered the login URL, the
// poller exchanges the device code, and the token lands in the credentials file.
func TestAuth_PerformLoginFlowWritesCredentials(t *testing.T) {
	credsPath := isolatedHome(t)
	authCovServer(t, authCovExchange("ada@x.com"))
	authCovHeadless(t)
	authCovForm(t, nil)

	if err := performLoginFlow(); err != nil {
		t.Fatalf("performLoginFlow: %v", err)
	}
	data, err := os.ReadFile(credsPath)
	if err != nil {
		t.Fatalf("credentials should exist after a successful flow: %v", err)
	}
	if !strings.Contains(string(data), "ada@x.com") {
		t.Errorf("credentials = %s", data)
	}
}

// TestAuth_PerformLoginFlowSkipsHiddenWarning pins that the saved
// hide_login_warning preference suppresses the first-run notice, and that a
// browser that refuses to open is not fatal — the URL is printed instead.
func TestAuth_PerformLoginFlowSkipsHiddenWarning(t *testing.T) {
	isolatedHome(t)
	savePreferences(cliPreferences{HideLoginWarning: true})
	authCovServer(t, authCovExchange("ada@x.com"))
	authCovHeadless(t)
	// The form must NOT be consulted when the warning is hidden.
	authCovForm(t, errors.New("the hidden-warning path must not prompt"))

	prevBrowser := openBrowser
	openBrowser = func(string) error { return errors.New("no display") }
	t.Cleanup(func() { openBrowser = prevBrowser })

	if err := performLoginFlow(); err != nil {
		t.Fatalf("a browser that cannot open must not fail the flow: %v", err)
	}
}

// TestAuth_PerformLoginFlowProgramError pins that a Bubble Tea program that
// cannot run is surfaced as a login error rather than a silent success.
func TestAuth_PerformLoginFlowProgramError(t *testing.T) {
	isolatedHome(t)
	savePreferences(cliPreferences{HideLoginWarning: true})
	authCovServer(t, authCovExchange("ada@x.com"))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	authCovHeadless(t, tea.WithContext(ctx))

	err := performLoginFlow()
	if err == nil {
		t.Fatal("a killed program should surface as a login error")
	}
	if !strings.Contains(err.Error(), "an error occurred during login") {
		t.Errorf("error = %v", err)
	}
}

// --- login.go · resolveLogin --------------------------------------------------

// TestAuth_ResolveLoginPromptRefused pins that declining (or failing) the "log in
// now?" prompt refuses with the `alethia login` hint instead of starting a flow.
func TestAuth_ResolveLoginPromptRefused(t *testing.T) {
	for _, tc := range []struct {
		name string
		ok   bool
		err  error
	}{
		{"declined", false, nil},
		{"prompt failed", false, errors.New("no tty")},
		{"prompt errored but said yes", true, errors.New("no tty")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			credsPath := isolatedHome(t)
			// resolveLogin now REFUSES before the prompt when the confirm has no terminal
			// to draw on, and a test process never has one. Without this the assertions
			// below would still pass — on the gate's refusal, never reaching the prompt
			// they exist to describe.
			authCovTTY(t)
			prev := authRequiredPrompt
			authRequiredPrompt = func() (bool, error) { return tc.ok, tc.err }
			t.Cleanup(func() { authRequiredPrompt = prev })

			got, err := resolveLogin(credsPath, true)
			if err == nil {
				t.Fatalf("resolveLogin should refuse, got token %q", got)
			}
			if !strings.Contains(err.Error(), "alethia login") {
				t.Errorf("error should point at `alethia login`, got %v", err)
			}
		})
	}
}

// TestAuth_ResolveLoginReturnsFreshToken pins the accepted path: the device flow
// runs and the token it persisted is read back and returned to the caller.
func TestAuth_ResolveLoginReturnsFreshToken(t *testing.T) {
	credsPath := isolatedHome(t)
	authCovServer(t, authCovExchange("ada@x.com"))
	authCovHeadless(t)
	authCovForm(t, nil)
	authCovTTY(t) // the confirm needs a terminal before resolveLogin will open it

	prev := authRequiredPrompt
	authRequiredPrompt = func() (bool, error) { return true, nil }
	t.Cleanup(func() { authRequiredPrompt = prev })

	got, err := resolveLogin(credsPath, true)
	if err != nil {
		t.Fatalf("resolveLogin: %v", err)
	}
	if got != "access-tok" {
		t.Errorf("token = %q, want access-tok", got)
	}
}

// TestAuth_ResolveLoginCredentialsUnusableAfterFlow pins the two ways a flow can
// "succeed" without leaving a usable credentials file: the file is absent (the
// user cancelled or the exchange was denied) or it is unparseable. Both must be
// reported, never returned as an empty token.
func TestAuth_ResolveLoginCredentialsUnusableAfterFlow(t *testing.T) {
	// The exchange refuses, so the program ends on an authErrorMsg and nothing is
	// written — performLoginFlow still returns nil.
	deny := func(w http.ResponseWriter, r *http.Request) {
		authCovJSON(w, http.StatusForbidden, map[string]string{"error": "access_denied"})
	}

	t.Run("missing", func(t *testing.T) {
		credsPath := isolatedHome(t)
		savePreferences(cliPreferences{HideLoginWarning: true})
		authCovServer(t, deny)
		authCovHeadless(t)
		authCovTTY(t) // the confirm needs a terminal before resolveLogin will open it
		prev := authRequiredPrompt
		authRequiredPrompt = func() (bool, error) { return true, nil }
		t.Cleanup(func() { authRequiredPrompt = prev })

		_, err := resolveLogin(credsPath, true)
		if err == nil || !strings.Contains(err.Error(), "reading credentials file after login") {
			t.Fatalf("err = %v, want a read failure", err)
		}
	})

	t.Run("unparseable", func(t *testing.T) {
		credsPath := isolatedHome(t)
		savePreferences(cliPreferences{HideLoginWarning: true})
		if err := os.WriteFile(credsPath, []byte("{not json"), 0o600); err != nil {
			t.Fatal(err)
		}
		authCovServer(t, deny)
		authCovHeadless(t)
		authCovTTY(t) // the confirm needs a terminal before resolveLogin will open it
		prev := authRequiredPrompt
		authRequiredPrompt = func() (bool, error) { return true, nil }
		t.Cleanup(func() { authRequiredPrompt = prev })

		_, err := resolveLogin(credsPath, true)
		if err == nil || !strings.Contains(err.Error(), "parsing credentials file after login") {
			t.Fatalf("err = %v, want a parse failure", err)
		}
	})
}

// TestAuth_PreferencesWithoutHome pins that an unresolvable config directory
// degrades to the zero preferences instead of failing the CLI.
func TestAuth_PreferencesWithoutHome(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")

	if _, err := getPreferencesPath(); err == nil {
		t.Error("getPreferencesPath should fail without a config directory")
	}
	savePreferences(cliPreferences{HideLoginWarning: true}) // must not panic
	if prefs := loadPreferences(); prefs.HideLoginWarning {
		t.Error("preferences should be the zero value when the path is unresolvable")
	}
}

// --- login.go · the cobra command --------------------------------------------

// TestAuth_LoginCmdAlreadyAuthenticated pins the short-circuit: with a valid
// session `alethia login` reports who you are and does not re-run the flow.
func TestAuth_LoginCmdAlreadyAuthenticated(t *testing.T) {
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{
		AccessToken: tok, RefreshToken: "r", UserEmail: "ada@x.com",
	}); err != nil {
		t.Fatal(err)
	}
	authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("an authenticated login must not call the control plane (%s)", r.URL.Path)
	})
	authCovHeadless(t)

	forceLogin = false
	if err := authCovRunCLI(t, "login"); err != nil {
		t.Fatalf("login: %v", err)
	}
}

// TestAuth_LoginCmdForcePersistsWebOrigin pins `--web-origin`: the URL is saved to
// the CLI config before the flow, and `--force` re-runs the device login even
// though a valid session exists.
func TestAuth_LoginCmdForcePersistsWebOrigin(t *testing.T) {
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok}); err != nil {
		t.Fatal(err)
	}
	srv := authCovServer(t, authCovExchange("forced@x.com"))
	authCovHeadless(t)
	authCovForm(t, nil)

	if err := authCovRunCLI(t, "login", "--force", "--web-origin", srv.URL); err != nil {
		t.Fatalf("login --force: %v", err)
	}
	if got := types.LoadCliConfig().WebOrigin; got != srv.URL {
		t.Errorf("persisted web-origin = %q, want %q", got, srv.URL)
	}
	data, err := os.ReadFile(credsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "forced@x.com") {
		t.Errorf("--force should have re-authenticated, got %s", data)
	}
}

// TestAuth_LoginCmdRejectsBadWebOrigin pins that a malformed --web-origin is
// fatal before any device code is minted.
func TestAuth_LoginCmdRejectsBadWebOrigin(t *testing.T) {
	isolatedHome(t)
	authCovTrapExit(t)
	authCovOrigin(t, "http://127.0.0.1:1")
	authCovHeadless(t)

	authCovWantExit(t, "login --web-origin ftp://nope", func() {
		_ = authCovRunCLI(t, "login", "--web-origin", "ftp://nope")
	})
}

// TestAuth_LoginCmdFailedFlowIsFatal pins that a device flow that cannot run
// exits non-zero rather than reporting success.
func TestAuth_LoginCmdFailedFlowIsFatal(t *testing.T) {
	isolatedHome(t)
	savePreferences(cliPreferences{HideLoginWarning: true})
	authCovTrapExit(t)
	authCovServer(t, authCovExchange("ada@x.com"))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	authCovHeadless(t, tea.WithContext(ctx))

	authCovWantExit(t, "login --force with a dead program", func() {
		_ = authCovRunCLI(t, "login", "--force")
	})
}

// --- logout.go ----------------------------------------------------------------

// TestAuth_LogoutRemovesCredentials pins the two ordinary logout outcomes: a
// stored session is deleted, and logging out twice is a plain notice, not a
// failure.
func TestAuth_LogoutRemovesCredentials(t *testing.T) {
	credsPath := isolatedHome(t)
	authCovOrigin(t, "http://127.0.0.1:1")
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: "a"}); err != nil {
		t.Fatal(err)
	}

	if err := authCovRunCLI(t, "logout"); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if _, err := os.Stat(credsPath); !os.IsNotExist(err) {
		t.Errorf("credentials should be gone, stat err = %v", err)
	}

	if err := authCovRunCLI(t, "logout"); err != nil {
		t.Fatalf("logout when logged out should be a no-op, got %v", err)
	}
}

// TestAuth_LogoutFatalArms pins that logout exits non-zero when the credentials
// path cannot be resolved, or when the file it found cannot be deleted.
func TestAuth_LogoutFatalArms(t *testing.T) {
	authCovTrapExit(t)

	t.Run("unresolvable path", func(t *testing.T) {
		authCovOrigin(t, "http://127.0.0.1:1")
		t.Setenv("HOME", "")
		t.Setenv("XDG_CONFIG_HOME", "")
		authCovWantExit(t, "logout without a home", func() {
			_ = authCovRunCLI(t, "logout")
		})
	})

	t.Run("undeletable credentials", func(t *testing.T) {
		credsPath := isolatedHome(t)
		authCovOrigin(t, "http://127.0.0.1:1")
		// A non-empty directory where the credentials file is expected: os.Stat
		// succeeds, os.Remove refuses.
		if err := os.MkdirAll(filepath.Join(credsPath, "child"), 0o755); err != nil {
			t.Fatal(err)
		}
		authCovWantExit(t, "logout over an undeletable path", func() {
			_ = authCovRunCLI(t, "logout")
		})
	})
}

// --- init.go ------------------------------------------------------------------

// TestAuth_PromptWebOriginHonorsNoInput pins that --no-input skips the prompt and
// returns the already-resolved origin, so `alethia init` is scriptable.
func TestAuth_PromptWebOriginHonorsNoInput(t *testing.T) {
	isolatedHome(t)
	authCovOrigin(t, "https://cp.example.com")
	prev := noInputMode
	noInputMode = true
	t.Cleanup(func() { noInputMode = prev })

	got, err := promptWebOrigin("")
	if err != nil {
		t.Fatalf("promptWebOrigin: %v", err)
	}
	if got != "https://cp.example.com" {
		t.Errorf("origin = %q, want the resolved origin", got)
	}
}

// TestAuth_PromptWebOriginPrompts pins the interactive arm: the resolved origin
// is offered as the editable default, and an aborted prompt yields no origin.
func TestAuth_PromptWebOriginPrompts(t *testing.T) {
	t.Run("accepted", func(t *testing.T) {
		isolatedHome(t)
		authCovOrigin(t, "https://cp.example.com")
		authCovTTY(t)
		authCovForm(t, nil)

		got, err := promptWebOrigin("")
		if err != nil {
			t.Fatalf("promptWebOrigin: %v", err)
		}
		if got != "https://cp.example.com" {
			t.Errorf("origin = %q, want the resolved default", got)
		}
	})

	t.Run("aborted", func(t *testing.T) {
		isolatedHome(t)
		authCovOrigin(t, "https://cp.example.com")
		authCovTTY(t)
		authCovForm(t, errors.New("aborted"))

		got, err := promptWebOrigin("")
		if err == nil {
			t.Fatalf("an aborted prompt should error, got %q", got)
		}
		if got != "" {
			t.Errorf("origin = %q, want the empty string on abort", got)
		}
	})
}

// TestAuth_InitCmdPersistsOriginAndLogsIn pins `alethia init`: it saves the
// chosen control-plane URL and then runs the device login in one pass.
func TestAuth_InitCmdPersistsOriginAndLogsIn(t *testing.T) {
	credsPath := isolatedHome(t)
	srv := authCovServer(t, authCovExchange("init@x.com"))
	authCovTTY(t)
	authCovForm(t, nil)
	authCovHeadless(t)

	if err := authCovRunCLI(t, "init"); err != nil {
		t.Fatalf("init: %v", err)
	}
	if got := types.LoadCliConfig().WebOrigin; got != srv.URL {
		t.Errorf("persisted web-origin = %q, want %q", got, srv.URL)
	}
	data, err := os.ReadFile(credsPath)
	if err != nil {
		t.Fatalf("init should have logged in: %v", err)
	}
	if !strings.Contains(string(data), "init@x.com") {
		t.Errorf("credentials = %s", data)
	}
}

// TestAuth_InitCmdFatalArms pins that init stops at the first failure: an aborted
// URL prompt, or a URL the config layer refuses.
func TestAuth_InitCmdFatalArms(t *testing.T) {
	authCovTrapExit(t)

	t.Run("aborted prompt", func(t *testing.T) {
		isolatedHome(t)
		authCovOrigin(t, "http://127.0.0.1:1")
		authCovTTY(t)
		authCovForm(t, errors.New("aborted"))
		authCovWantExit(t, "init with an aborted prompt", func() {
			_ = authCovRunCLI(t, "init")
		})
	})

	t.Run("invalid origin", func(t *testing.T) {
		isolatedHome(t)
		authCovOrigin(t, "not-a-url")
		authCovTTY(t)
		authCovForm(t, nil)
		authCovWantExit(t, "init with an unusable origin", func() {
			_ = authCovRunCLI(t, "init")
		})
	})
}

// --- auth_utils.go ------------------------------------------------------------

// TestAuth_CredentialsPathNeedsConfigDir pins that an unresolvable user config
// directory is reported by both the path helper and the token resolver.
func TestAuth_CredentialsPathNeedsConfigDir(t *testing.T) {
	t.Setenv("HOME", "")
	t.Setenv("XDG_CONFIG_HOME", "")

	if _, err := getCredentialsPath(); err == nil {
		t.Error("getCredentialsPath should fail without a config directory")
	}
	if _, err := getAuthTokenInternal(false); err == nil {
		t.Error("getAuthTokenInternal should fail without a config directory")
	}
}

// TestAuth_GetAuthTokenUnreadableCredentials pins that a credentials path that
// exists but cannot be read is a hard error, not a silent re-login.
func TestAuth_GetAuthTokenUnreadableCredentials(t *testing.T) {
	credsPath := isolatedHome(t)
	if err := os.MkdirAll(credsPath, 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := getAuthTokenInternal(false)
	if err == nil || !strings.Contains(err.Error(), "reading credentials file") {
		t.Fatalf("err = %v, want a read failure", err)
	}
}

// TestAuth_GetAuthTokenNeedsLoginStates pins every stored-credential shape that
// means "you are not logged in": unparseable JSON, an empty token, a token that
// is not a JWT, and an expired token with nothing to refresh with. All must route
// to the login prompt rather than be handed to the API as a bearer token.
func TestAuth_GetAuthTokenNeedsLoginStates(t *testing.T) {
	expired := makeToken(t, time.Now().Add(-time.Hour))

	cases := []struct {
		name string
		body string
	}{
		{"unparseable", "{not json"},
		{"empty token", `{"access_token":"","refresh_token":"r"}`},
		{"not a jwt", `{"access_token":"opaque-token","refresh_token":"r"}`},
		{"expired without refresh", `{"access_token":"` + expired + `","refresh_token":""}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			credsPath := isolatedHome(t)
			if err := os.WriteFile(credsPath, []byte(tc.body), 0o600); err != nil {
				t.Fatal(err)
			}
			got, err := getAuthTokenInternal(false)
			if err == nil {
				t.Fatalf("expected a login refusal, got token %q", got)
			}
			if !strings.Contains(err.Error(), "alethia login") {
				t.Errorf("error should point at `alethia login`, got %v", err)
			}
		})
	}
}

// TestAuth_GetAuthTokenRefreshRejected pins that a refresh the server rejects
// falls back to requiring a fresh login instead of surfacing the HTTP error.
func TestAuth_GetAuthTokenRefreshRejected(t *testing.T) {
	credsPath := isolatedHome(t)
	authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
		authCovJSON(w, http.StatusUnauthorized, map[string]string{"error": "refresh expired"})
	})
	expired := makeToken(t, time.Now().Add(-time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{
		AccessToken: expired, RefreshToken: "refresh-tok",
	}); err != nil {
		t.Fatal(err)
	}

	got, err := getAuthTokenInternal(false)
	if err == nil {
		t.Fatalf("expected a login refusal, got token %q", got)
	}
	if !strings.Contains(err.Error(), "alethia login") {
		t.Errorf("error = %v", err)
	}
}

// TestAuth_GetAuthTokenRefreshUnsavable pins that a refreshed token which cannot
// be persisted is an error — returning it while the file still holds the expired
// one would make the next invocation silently re-refresh.
func TestAuth_GetAuthTokenRefreshUnsavable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root ignores the read-only mode bit this test relies on")
	}
	credsPath := isolatedHome(t)
	fresh := makeToken(t, time.Now().Add(time.Hour))
	authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
		authCovJSON(w, http.StatusOK, map[string]string{"access_token": fresh})
	})
	expired := makeToken(t, time.Now().Add(-time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{
		AccessToken: expired, RefreshToken: "refresh-tok",
	}); err != nil {
		t.Fatal(err)
	}
	// Readable but not writable: the refresh succeeds, the save cannot.
	if err := os.Chmod(credsPath, 0o400); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(credsPath, 0o600) })

	_, err := getAuthTokenInternal(false)
	if err == nil || !strings.Contains(err.Error(), "failed to save new credentials") {
		t.Fatalf("err = %v, want a save failure", err)
	}
}

// TestAuth_RefreshAccessTokenTransportError pins that an unreachable control
// plane during refresh is returned as the transport error.
func TestAuth_RefreshAccessTokenTransportError(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	authCovOrigin(t, url)

	if _, err := refreshAccessToken("refresh-tok"); err == nil {
		t.Error("expected a transport error from an unreachable control plane")
	}
}

// TestAuth_SaveCredentialsUncreatable pins that saveCredentials reports a path it
// cannot open rather than dropping the token on the floor.
func TestAuth_SaveCredentialsUncreatable(t *testing.T) {
	dir := t.TempDir()
	if err := saveCredentials(dir, types.ExchangeResponse{AccessToken: "a"}); err == nil {
		t.Error("saveCredentials onto a directory should error")
	}
}

// --- selectors.go -------------------------------------------------------------

// TestAuth_RunHuhFormDefaultIsTheRealForm pins that the runHuhForm seam's default
// really is the themed form — headless it reports the missing TTY rather than
// silently succeeding.
func TestAuth_RunHuhFormDefaultIsTheRealForm(t *testing.T) {
	var ok bool
	err := runHuhForm(huh.NewGroup(huh.NewConfirm().Title("probe").Value(&ok)))
	if err == nil {
		t.Error("the real form cannot run without a TTY; expected an error")
	}
	if ok {
		t.Error("nothing should have been confirmed")
	}
}

// TestAuth_SelectProjectPicker pins the project picker: it lists the caller's
// projects, refuses with a create hint when there are none, and surfaces a fetch
// failure instead of showing an empty list.
func TestAuth_SelectProjectPicker(t *testing.T) {
	t.Run("lists projects", func(t *testing.T) {
		authCovTTY(t)
		authCovForm(t, nil)
		authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
			authCovJSON(w, http.StatusOK, map[string]any{"configurations": []map[string]any{
				{"id": "p1", "project_name": "web", "environment_stage": "production"},
				{"id": "p2", "project_name": "api", "environment_stage": "staging"},
			}})
		})
		if _, err := selectProject("tok"); err != nil {
			t.Fatalf("selectProject: %v", err)
		}
	})

	t.Run("no projects", func(t *testing.T) {
		authCovTTY(t)
		authCovForm(t, nil)
		authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
			authCovJSON(w, http.StatusOK, map[string]any{"configurations": []map[string]any{}})
		})
		_, err := selectProject("tok")
		if err == nil || !strings.Contains(err.Error(), "no projects found") {
			t.Fatalf("err = %v, want the no-projects refusal", err)
		}
	})

	t.Run("fetch fails", func(t *testing.T) {
		authCovTTY(t)
		authCovForm(t, nil)
		authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
			authCovJSON(w, http.StatusInternalServerError, map[string]string{"error": "boom"})
		})
		_, err := selectProject("tok")
		if err == nil || !strings.Contains(err.Error(), "failed to fetch projects") {
			t.Fatalf("err = %v, want the fetch failure", err)
		}
	})
}

// TestAuth_SelectRunnerPicker pins the runner picker: "Any available" is always
// offered, the excluded runner is dropped, every status gets its own dot, and an
// online default is pre-selected.
func TestAuth_SelectRunnerPicker(t *testing.T) {
	authCovTTY(t)
	authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
		authCovJSON(w, http.StatusOK, map[string]any{"runners": []map[string]any{
			{"id": "r1", "name": "primary", "operator": "managed", "status": "ONLINE", "is_default": true},
			{"id": "r2", "name": "drain", "operator": "self", "provisioning": "deployed", "status": "DRAINING"},
			{"id": "r3", "name": "gone", "operator": "self", "provisioning": "registered", "status": "OFFLINE"},
			{"id": "r4", "name": "self", "operator": "self", "status": "ONLINE", "is_default": true},
			{"id": "excluded", "name": "skip", "operator": "managed", "status": "ONLINE"},
		}})
	})

	// The stub leaves the value untouched, so the pre-selected default survives —
	// that is what pins "an online default runner is chosen for you".
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return nil }
	t.Cleanup(func() { runHuhForm = prev })

	got, err := selectRunner("tok", "excluded")
	if err != nil {
		t.Fatalf("selectRunner: %v", err)
	}
	if got != "r4" {
		t.Errorf("selectRunner = %q, want the last online default (r4)", got)
	}
}

// TestAuth_SelectRunnerFetchFails pins that a runner list the control plane
// refuses is surfaced, not shown as "no runners".
func TestAuth_SelectRunnerFetchFails(t *testing.T) {
	authCovTTY(t)
	authCovForm(t, nil)
	authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
		authCovJSON(w, http.StatusInternalServerError, map[string]string{"error": "boom"})
	})
	_, err := selectRunner("tok", "")
	if err == nil || !strings.Contains(err.Error(), "failed to fetch runners") {
		t.Fatalf("err = %v, want the fetch failure", err)
	}
}

// TestAuth_SelectOrgInteractive pins the org picker: it builds one option per
// membership (badging the active one), resolves the highlighted option back to
// its org, and propagates an aborted prompt.
func TestAuth_SelectOrgInteractive(t *testing.T) {
	orgs := []api.OrgSummary{
		{ID: "o1", Name: "Acme", Slug: "acme", Role: "owner", IsActive: true},
		{ID: "o2", Name: "Beta", Slug: "beta", Role: "member"},
	}

	authCovForm(t, nil)
	got, err := selectOrgInteractive(orgs)
	if err != nil {
		t.Fatalf("selectOrgInteractive: %v", err)
	}
	// With no keystroke the first option stays highlighted, and the picker must
	// map that option's id back to the membership it came from.
	if got == nil || got.ID != "o1" {
		t.Errorf("selectOrgInteractive = %+v, want the first membership", got)
	}

	authCovForm(t, errors.New("aborted"))
	if _, err := selectOrgInteractive(orgs); err == nil {
		t.Error("an aborted org prompt should error")
	}
}

// TestAuth_PickCloudIdentity pins the two cloud-account pickers. `project create`
// offers every linked account; `runner deploy` offers only the clouds a runner
// template exists for, and says so — the #1794 defect was offering the rest.
func TestAuth_PickCloudIdentity(t *testing.T) {
	serve := func(t *testing.T, identities []map[string]any) {
		t.Helper()
		authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
			authCovJSON(w, http.StatusOK, map[string]any{"cloud_identities": identities})
		})
	}
	aws := map[string]any{"id": "ci-aws", "provider": "aws", "label": "prod (aws)"}
	gcp := map[string]any{"id": "ci-gcp", "provider": "gcp", "label": "prod (gcp)"}

	t.Run("all accounts", func(t *testing.T) {
		authCovTTY(t)
		authCovForm(t, nil)
		serve(t, []map[string]any{aws, gcp})
		if _, err := selectCloudIdentity("tok"); err != nil {
			t.Fatalf("selectCloudIdentity: %v", err)
		}
	})

	t.Run("deployable accounts", func(t *testing.T) {
		authCovTTY(t)
		authCovForm(t, nil)
		serve(t, []map[string]any{aws, gcp})
		if _, err := selectRunnerDeployCloudIdentity("tok"); err != nil {
			t.Fatalf("selectRunnerDeployCloudIdentity: %v", err)
		}
	})

	t.Run("none deployable", func(t *testing.T) {
		authCovTTY(t)
		authCovForm(t, nil)
		serve(t, []map[string]any{gcp})
		_, err := selectRunnerDeployCloudIdentity("tok")
		if err == nil || !strings.Contains(err.Error(), "can host a deployed runner") {
			t.Fatalf("err = %v, want the not-deployable refusal", err)
		}
	})

	t.Run("no accounts", func(t *testing.T) {
		authCovTTY(t)
		authCovForm(t, nil)
		serve(t, []map[string]any{})
		_, err := selectCloudIdentity("tok")
		if err == nil || !strings.Contains(err.Error(), "no cloud accounts linked") {
			t.Fatalf("err = %v, want the no-accounts refusal", err)
		}
	})

	t.Run("fetch fails", func(t *testing.T) {
		authCovTTY(t)
		authCovForm(t, nil)
		authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
			authCovJSON(w, http.StatusInternalServerError, map[string]string{"error": "boom"})
		})
		_, err := selectCloudIdentity("tok")
		if err == nil || !strings.Contains(err.Error(), "failed to fetch cloud identities") {
			t.Fatalf("err = %v, want the fetch failure", err)
		}
	})
}

// --- gap closers: the arms the first pass left uncovered -----------------------

// TestAuth_PerformLoginFlowSavesHideWarningPreference pins the "don't show this
// again" arm: answering yes at the first-run confirm persists
// hide_login_warning, so the next login skips the notice. The prompt is driven
// through the real huh Confirm, not a canned return, so the bound value is the
// one the widget actually wrote.
func TestAuth_PerformLoginFlowSavesHideWarningPreference(t *testing.T) {
	isolatedHome(t)
	authCovServer(t, authCovExchange("ada@x.com"))
	authCovHeadless(t)
	authCovConfirmYes(t)

	if loadPreferences().HideLoginWarning {
		t.Fatal("precondition: the warning should not start hidden")
	}
	if err := performLoginFlow(); err != nil {
		t.Fatalf("performLoginFlow: %v", err)
	}
	if !loadPreferences().HideLoginWarning {
		t.Error("answering yes at the confirm should persist hide_login_warning")
	}
}

// TestAuth_ResolveLoginSurfacesFlowFailure pins that when the user accepts the
// "log in now?" prompt but the device flow itself fails, resolveLogin returns
// that failure verbatim — it must not fall through to reading credentials, and
// must not be disguised as the generic `alethia login` refusal.
func TestAuth_ResolveLoginSurfacesFlowFailure(t *testing.T) {
	credsPath := isolatedHome(t)
	savePreferences(cliPreferences{HideLoginWarning: true})
	authCovServer(t, authCovExchange("ada@x.com"))
	authCovKilledProgram(t)
	authCovTTY(t) // the confirm needs a terminal before resolveLogin will open it

	prev := authRequiredPrompt
	authRequiredPrompt = func() (bool, error) { return true, nil }
	t.Cleanup(func() { authRequiredPrompt = prev })

	got, err := resolveLogin(credsPath, true)
	if err == nil {
		t.Fatalf("a failed device flow should surface, got token %q", got)
	}
	if got != "" {
		t.Errorf("token = %q, want the empty string on failure", got)
	}
	if !strings.Contains(err.Error(), "an error occurred during login") {
		t.Errorf("error = %v, want the flow's own failure", err)
	}
	if strings.Contains(err.Error(), "credentials file after login") {
		t.Error("resolveLogin must stop at the failed flow, not read credentials")
	}
}

// TestAuth_InitCmdFatalWhenLoginFails pins the last step of `alethia init`: the
// control-plane URL is already persisted, so a device login that fails must exit
// non-zero rather than report a completed setup.
func TestAuth_InitCmdFatalWhenLoginFails(t *testing.T) {
	isolatedHome(t)
	srv := authCovServer(t, authCovExchange("init@x.com"))
	savePreferences(cliPreferences{HideLoginWarning: true})
	authCovTTY(t)
	authCovForm(t, nil)
	authCovKilledProgram(t)
	authCovTrapExit(t)

	authCovWantExit(t, "init whose login flow fails", func() {
		_ = authCovRunCLI(t, "init")
	})
	if got := types.LoadCliConfig().WebOrigin; got != srv.URL {
		t.Errorf("the origin should be persisted before login runs; got %q", got)
	}
}
