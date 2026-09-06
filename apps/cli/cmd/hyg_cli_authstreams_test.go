// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The two stream-discipline holes on the AUTH path (#3912), and — the more valuable
// half — the two structural reasons neither was visible to a guard.
//
// Every identifier here carries the hygCliAuthstreams prefix so it cannot collide with
// another lane's helpers in this package.
//
// ── Why these needed new guards rather than new assertions ─────────────────────
//
// 1. The refresh notice is on a branch NO command-level test could reach. Every fixture
//    in this package mints a token an hour out (miscEnv, connEnv, projHarness …), so
//    `if time.Unix(exp,0).Before(time.Now().Add(1*time.Minute))` was false in every run
//    the suite has ever made. The branch was not under-asserted; it was unreachable.
//    hygCliAuthstreamsEnv mints a token THIRTY SECONDS from expiry instead — inside the
//    window, not yet expired, which is the state the report describes — and re-plants it
//    before each command, so the whole read-command sweep now runs THROUGH the refresh.
//
//    A clock seam was considered and deliberately NOT added: the predicate is relative,
//    so varying the token moves it just as well as varying the clock, and seams.go's
//    standing rule is that a seam must be justified by measurement rather than by
//    convenience. See the note on hygCliAuthstreamsEnv.
//
// 2. The login confirm's missing gate is an ABSENCE. A guard that walks the package for
//    files NAMING requireInteractiveForm / noInputMode can only ever find a WRONG call;
//    login.go named neither, so the walk had nothing to match — and the form itself lives
//    in pkg/utils/ui, outside the scanned package. So the property is asserted at the
//    SEAM instead: authRequiredPrompt is replaced with a spy, and the claim is that it is
//    never CALLED when the confirm has no stream to draw on. A spy records an absence; a
//    walk cannot.
//
//    That assertion is trivially satisfiable by a resolveLogin which never prompts at
//    all, so every spy case below is paired with a control that proves the same spy DOES
//    fire once a terminal is present.

// --- fixtures ----------------------------------------------------------------

// hygCliAuthstreamsEnv stands up a fake control plane that serves both the token-refresh
// endpoint and the misc envelope, and returns a runner for the real cobra tree, a replant
// function that puts an ABOUT-TO-EXPIRE credential back on disk, and the number of
// refreshes the control plane has served.
//
// The expiry is 30 seconds out rather than an hour ago on purpose: an already-expired
// token proves the same branch, but "in its last minute" is the case the report is about
// and the one a user actually hits mid-session. Re-planting is required because a
// successful refresh WRITES the fresh hour-long token back, so the second command in a
// sweep would otherwise take the happy path and quietly stop testing anything.
func hygCliAuthstreamsEnv(t *testing.T) (run func(args ...string) error, replant func(), refreshes *atomic.Int32) {
	t.Helper()
	credsPath := isolatedHome(t)
	if err := types.SaveCliConfig(types.CliConfig{
		ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme",
	}); err != nil {
		t.Fatalf("save cli config: %v", err)
	}

	fresh := makeToken(t, time.Now().Add(time.Hour))
	body := miscEnvelope(miscFull)
	var served atomic.Int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/api/auth/cli/refresh") {
			served.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]string{"access_token": fresh})
			return
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)

	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	replant = func() {
		expiring := makeToken(t, time.Now().Add(30*time.Second))
		if err := saveCredentials(credsPath, types.ExchangeResponse{
			AccessToken: expiring, RefreshToken: "refresh-tok",
		}); err != nil {
			t.Fatalf("plant expiring credentials: %v", err)
		}
	}
	run = func(args ...string) error {
		execRootArgs(args)
		return rootCmd.Execute()
	}
	return run, replant, &served
}

// hygCliAuthstreamsDecodeAll reports whether s is nothing but JSON — a stream of one or
// more complete JSON values and no other bytes.
//
// A stream rather than a single value because the read commands are not uniform: some
// render one object, some render one array. What both must never carry is a line of
// English, which is exactly what a decoder rejects and what `jq` would reject too.
func hygCliAuthstreamsDecodeAll(s string) error {
	if strings.TrimSpace(s) == "" {
		return errors.New("stdout was empty; the command emitted no document at all")
	}
	dec := json.NewDecoder(strings.NewReader(s))
	for {
		var v any
		err := dec.Decode(&v)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// hygCliAuthstreamsSpinnerOnStdout is a DEFECT LEDGER, not an exemption: these two read
// commands already corrupt their own `-o json` document with a huh spinner drawn on
// stdout, before any token is refreshed and with `--no-input` passed. The document starts
// with ESC [ ? 2 5 l — bubbletea hiding the cursor — so `jq` rejects it exactly as it
// would reject the refresh notice.
//
// It is a different defect with a different owner (the spinner stream sweep, #3847, which
// moves every transient widget to ui.InteractiveOutput()) and it lives in pkg/utils/ui,
// outside this unit's scope. Recording it keeps this guard honest about what it can prove
// today without either laundering the noise away — which would blind it to the very class
// of defect it exists to catch — or going red for a fix that is someone else's to make.
//
// The ledger is checked in BOTH directions: a command listed here whose document has
// become clean fails too, so the list cannot quietly outlive the defect it names.
//
// #3847 LANDED (dev bce91194) and moved those spinners to ui.InteractiveOutput(), so both
// entries were removed — the both-directions check above is what reported it, exactly as
// designed. The map stays declared and empty: emptiness is the claim that every command
// under this guard emits a clean document, and a later regression re-earns its entry here
// with an issue number rather than silently widening the guard.
var hygCliAuthstreamsSpinnerOnStdout = map[string]string{}

// hygCliAuthstreamsStreams pins what the CLI believes about its terminals for one test:
// whether stdin and the form's stream are terminals, and whether --no-input was passed.
//
// formStream drives interactiveOutIsTTY, which is the predicate requireInteractiveForm
// actually consults — NOT stdoutIsTTY. A huh form draws on stderr and the Bubble Tea table
// draws on stdout, so stubbing stdout alone left the gate reading the real terminal and the
// confirm was reached with its stream redirected. stdoutIsTTY is stubbed to the same answer
// so a command whose spinner reads stdout sees one consistent story.
func hygCliAuthstreamsStreams(t *testing.T, stdin, formStream, noInput bool) {
	t.Helper()
	prevIn, prevOut, prevForm, prevMode := stdinIsTTY, stdoutIsTTY, interactiveOutIsTTY, noInputMode
	stdinIsTTY = func() bool { return stdin }
	stdoutIsTTY = func() bool { return formStream }
	interactiveOutIsTTY = func() bool { return formStream }
	noInputMode = noInput
	t.Cleanup(func() {
		stdinIsTTY, stdoutIsTTY, interactiveOutIsTTY, noInputMode = prevIn, prevOut, prevForm, prevMode
	})
}

// hygCliAuthstreamsSpy replaces the "log in now?" confirm with a stub that records
// whether it was reached, and answers `answer` if it is.
func hygCliAuthstreamsSpy(t *testing.T, answer bool) *bool {
	t.Helper()
	called := false
	prev := authRequiredPrompt
	authRequiredPrompt = func() (bool, error) {
		called = true
		return answer, nil
	}
	t.Cleanup(func() { authRequiredPrompt = prev })
	return &called
}

// --- 1 · the refresh notice must not enter the document ----------------------

// TestHygCliAuthstreams_RefreshNoticeGoesToStderrNotStdout is the unit-level statement of
// the first hole: getAuthTokenInternal announced the refresh with fmt.Println, so the
// announcement was part of whatever the command was piping.
//
// It asserts stdout is EMPTY rather than merely notice-free. This function returns a
// token; it is not a renderer, and nothing it prints belongs in the document.
func TestHygCliAuthstreams_RefreshNoticeGoesToStderrNotStdout(t *testing.T) {
	credsPath := isolatedHome(t)
	fresh := makeToken(t, time.Now().Add(time.Hour))

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/cli/refresh" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"access_token": fresh})
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)

	// 30 seconds out: inside the one-minute refresh window, not yet expired.
	expiring := makeToken(t, time.Now().Add(30*time.Second))
	if err := saveCredentials(credsPath, types.ExchangeResponse{
		AccessToken: expiring, RefreshToken: "refresh-tok",
	}); err != nil {
		t.Fatal(err)
	}

	var got string
	var err error
	out, diag := captureStreams(t, func() { got, err = getAuthTokenInternal(false) })

	// Precondition: the branch under test actually ran. Without this, a token that
	// never refreshed would satisfy every assertion below.
	if err != nil {
		t.Fatalf("getAuthTokenInternal: %v", err)
	}
	if got != fresh {
		t.Fatalf("the refresh branch did not run: token = %q, want the refreshed one", got)
	}

	if out != "" {
		t.Errorf("the refresh path wrote to STDOUT, which is the document: %q", out)
	}
	if !strings.Contains(diag, "Access token expired, refreshing") {
		t.Errorf("the refresh notice never reached stderr; stderr = %q", diag)
	}
}

// TestHygCliAuthstreams_ExpiringTokenLeavesTheJSONDocumentParseable is the guard the
// report asks for: every read command in the group, driven end to end through the real
// cobra tree with a credential in its last minute, must still emit a document `jq` will
// take. This is `alethia … -o json > out.json` at the moment the session rolls over.
//
// The sweep is over miscReadCommands() deliberately — the same list the existing
// stdout-hygiene tests drive — because the point of the unit is that this fixture reaches
// a branch that list could not previously reach at all.
func TestHygCliAuthstreams_ExpiringTokenLeavesTheJSONDocumentParseable(t *testing.T) {
	run, replant, refreshes := hygCliAuthstreamsEnv(t)

	for _, args := range miscReadCommands() {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			replant()
			before := refreshes.Load()

			var runErr error
			out, diag := captureStreams(t, func() {
				runErr = run(append(append([]string{}, args...), "--output", "json", "--no-input")...)
			})
			if runErr != nil {
				t.Fatalf("%v: %v", args, runErr)
			}

			// Precondition, not decoration: if the refresh never happened this test is
			// measuring the ordinary happy path and cannot see the defect.
			if refreshes.Load() == before {
				t.Fatalf("%v: the token never refreshed — the fixture is not exercising the branch", args)
			}

			key := strings.Join(args, " ")
			decodeErr := hygCliAuthstreamsDecodeAll(out)
			if known, listed := hygCliAuthstreamsSpinnerOnStdout[key]; listed {
				if decodeErr == nil {
					t.Errorf("%q emits a clean JSON document now — its %s no longer reaches stdout, so "+
						"delete its entry from hygCliAuthstreamsSpinnerOnStdout. A stale ledger entry "+
						"hides the regression it was written to describe.", key, known)
				}
			} else if decodeErr != nil {
				t.Errorf("%v: stdout is not a JSON document (%v). stdout was:\n%s", args, decodeErr, out)
			}

			// This one holds for EVERY command, ledgered or not: whatever else is wrong with
			// a document, the session rolling over must not be part of it.
			if strings.Contains(out, "refreshing") {
				t.Errorf("%v: the refresh notice landed in the document:\n%s", args, out)
			}
			if !strings.Contains(diag, "Access token expired, refreshing") {
				t.Errorf("%v: the refresh notice never reached stderr; stderr = %q", args, diag)
			}
		})
	}
}

// --- 2 · the login confirm must not be drawn where it cannot be seen ---------

// TestHygCliAuthstreams_LoginConfirmIsNotDrawnWithoutAStream is the second hole stated as
// a property at the seam: authRequiredPrompt must not be CALLED when the confirm has
// nowhere to draw.
//
// getAuthToken hardcodes getAuthTokenInternal(true), so before the gate resolveLogin
// opened this form on stdin-is-a-terminal alone. With the form's stream redirected the
// frames went to the redirection and the process blocked on a keystroke against a blank
// terminal — a hang with no prompt, which is the worst failure mode of the set.
func TestHygCliAuthstreams_LoginConfirmIsNotDrawnWithoutAStream(t *testing.T) {
	for _, tc := range []struct {
		name       string
		stdin      bool
		formStream bool
		noInput    bool
		want       error
	}{
		{
			// `alethia … 2> log` from an interactive shell: stdin IS a terminal, so
			// noInputMode is false and nothing else in the CLI reports a problem.
			name: "the form's stream is redirected", stdin: true, formStream: false,
			noInput: false, want: errNoTTY,
		},
		{
			// --no-input is a promise that nothing will be asked. A confirm is a question.
			name: "prompts are disabled", stdin: true, formStream: true,
			noInput: true, want: errNoInput,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			credsPath := isolatedHome(t)
			hygCliAuthstreamsStreams(t, tc.stdin, tc.formStream, tc.noInput)
			// The spy answers YES. If the gate is removed, resolveLogin proceeds into the
			// device flow rather than refusing, so the failure is loud rather than
			// coincidentally identical to a refusal.
			called := hygCliAuthstreamsSpy(t, true)

			got, err := resolveLogin(credsPath, true)

			if *called {
				t.Error("authRequiredPrompt was called with no stream to draw the confirm on")
			}
			if err == nil {
				t.Fatalf("resolveLogin should refuse, got token %q", got)
			}
			if got != "" {
				t.Errorf("token = %q, want the empty string on a refusal", got)
			}
			if !errors.Is(err, tc.want) {
				t.Errorf("error = %v, want one carrying %v", err, tc.want)
			}
			if !strings.Contains(err.Error(), "alethia login") {
				t.Errorf("error should point at `alethia login`, got %v", err)
			}
		})
	}

	// The control. Every assertion above is satisfied by a resolveLogin that has stopped
	// prompting altogether, so prove the same spy still fires when the confirm CAN be
	// drawn — and that the refusal it then produces is the user's answer, not the gate's.
	t.Run("control: a terminal on both ends still reaches the confirm", func(t *testing.T) {
		credsPath := isolatedHome(t)
		hygCliAuthstreamsStreams(t, true, true, false)
		called := hygCliAuthstreamsSpy(t, false)

		_, err := resolveLogin(credsPath, true)

		if !*called {
			t.Fatal("authRequiredPrompt was never reached even with a terminal on both ends")
		}
		if err == nil {
			t.Fatal("declining the confirm should still refuse")
		}
		if errors.Is(err, errNoTTY) || errors.Is(err, errNoInput) {
			t.Errorf("the refusal came from the gate, not from the declined confirm: %v", err)
		}
	})
}

// TestHygCliAuthstreams_GetAuthTokenRefusesRatherThanPrompting closes the loop from the
// caller every command actually uses. getAuthToken passes promptLogin=true
// unconditionally, so resolveLogin is the ONLY thing standing between an expired session
// and a form drawn into a redirected stream — this is that path, not a helper next to it.
func TestHygCliAuthstreams_GetAuthTokenRefusesRatherThanPrompting(t *testing.T) {
	isolatedHome(t) // deliberately no credentials: the unauthenticated branch
	hygCliAuthstreamsStreams(t, true, false, false)
	called := hygCliAuthstreamsSpy(t, true)

	var tok string
	var err error
	out, _ := captureStreams(t, func() { tok, err = getAuthToken() })

	if *called {
		t.Error("getAuthToken opened the login confirm with the form's stream redirected")
	}
	if err == nil {
		t.Fatalf("getAuthToken should refuse, got token %q", tok)
	}
	if !errors.Is(err, errNoTTY) {
		t.Errorf("error = %v, want one carrying errNoTTY", err)
	}
	if out != "" {
		t.Errorf("the refusal path wrote to stdout: %q", out)
	}
}
