// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The CLI half of #3889 (register the request before the browser opens, so the consent
// screen has something to name) and #3887 (surface RFC 8628's access_denied, so a refusal
// reaches the terminal instead of leaving it to spin to its own timeout).
//
// Every identifier here carries the consent prefix so it cannot collide with the authCov
// group's helpers in this package.

// consentCapture records what the fake control plane was asked, so a test can assert on
// the REGISTRATION rather than only on whether the login completed. The mutex-free
// atomics are enough: httptest serialises nothing, but each test drives one request at a
// time through the paths it inspects.
type consentCapture struct {
	startCalls atomic.Int32
	startBody  atomic.Value // map[string]string
	startAgent atomic.Value // string
}

// consentServer stands up a control plane that answers the registration and the exchange,
// recording the registration. `start` decides what /api/auth/cli/start answers.
func consentServer(t *testing.T, cap *consentCapture, start func(http.ResponseWriter)) *httptest.Server {
	t.Helper()
	return authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/api/auth/cli/start") {
			cap.startCalls.Add(1)
			body, _ := io.ReadAll(r.Body)
			var parsed map[string]string
			_ = json.Unmarshal(body, &parsed)
			cap.startBody.Store(parsed)
			cap.startAgent.Store(r.Header.Get("User-Agent"))
			start(w)
			return
		}
		authCovExchange("ada@x.com")(w, r)
	})
}

// --- login.go · registerDeviceRequest ----------------------------------------

// TestConsent_RegisterSendsTheCodesAndTheClaim pins what the registration carries. The
// user_code is the reason it exists: it used to live only in the URL, where the console
// checked its SHAPE and never compared it against anything, so the code on the consent
// screen carried no server-verified meaning. The client name/version and the User-Agent
// are the fields that let a person tell "the terminal on this laptop" from a device on
// another continent — RFC 8628's threat model is a phished link.
func TestConsent_RegisterSendsTheCodesAndTheClaim(t *testing.T) {
	cap := &consentCapture{}
	srv := consentServer(t, cap, func(w http.ResponseWriter) {
		authCovJSON(w, http.StatusOK, map[string]any{"expires_in": 600, "interval": 2})
	})

	if err := registerDeviceRequest(srv.URL+"/api/auth/cli/start", "dev-code", "BCDF-GHJK"); err != nil {
		t.Fatalf("registerDeviceRequest: %v", err)
	}

	body, _ := cap.startBody.Load().(map[string]string)
	if body["device_code"] != "dev-code" || body["user_code"] != "BCDF-GHJK" {
		t.Errorf("registration body = %#v, want both codes", body)
	}
	if body["client_name"] != deviceClientName {
		t.Errorf("client_name = %q, want %q", body["client_name"], deviceClientName)
	}
	agent, _ := cap.startAgent.Load().(string)
	if !strings.Contains(agent, deviceClientName) {
		t.Errorf("User-Agent = %q, should name the client", agent)
	}
	// The OS/arch pair is the part that does the work on the consent screen.
	if !strings.Contains(deviceUserAgent(), "; ") {
		t.Errorf("user agent %q should carry an os/arch pair", deviceUserAgent())
	}
}

// TestConsent_RegisterReportsAServerRefusal pins that a non-2xx is an ERROR rather than a
// silent success. `alethia login` continues past it — that is the caller's decision, and
// the next test pins it — but it must be able to tell that the registration did not
// happen, or the warning it prints would be unreachable.
func TestConsent_RegisterReportsAServerRefusal(t *testing.T) {
	cap := &consentCapture{}
	srv := consentServer(t, cap, func(w http.ResponseWriter) {
		authCovJSON(w, http.StatusConflict, map[string]string{
			"error": "This device code is already registered",
		})
	})

	err := registerDeviceRequest(srv.URL+"/api/auth/cli/start", "dev-code", "BCDF-GHJK")
	if err == nil {
		t.Fatal("a 409 from the control plane must be reported, not swallowed")
	}
	if !strings.Contains(err.Error(), "already registered") {
		t.Errorf("error should carry the server's reason, got %v", err)
	}
}

// TestConsent_RegisterReportsAnUnreachableControlPlane pins the transport arm the same
// way: an unreachable control plane is a reported failure, not a registration.
func TestConsent_RegisterReportsAnUnreachableControlPlane(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL + "/api/auth/cli/start"
	srv.Close()

	if err := registerDeviceRequest(url, "dev-code", "BCDF-GHJK"); err == nil {
		t.Fatal("an unreachable control plane must be reported")
	}
}

// --- login.go · performLoginFlow registers before the browser opens ----------

// TestConsent_LoginFlowRegistersBeforeOpeningTheBrowser pins the ordering that makes the
// whole thing worth anything: the request is registered BEFORE the URL is printed and the
// browser is opened, so the screen the user is about to look at already has a
// server-verified code and a requester to name.
func TestConsent_LoginFlowRegistersBeforeOpeningTheBrowser(t *testing.T) {
	isolatedHome(t)
	savePreferences(cliPreferences{HideLoginWarning: true})
	cap := &consentCapture{}
	consentServer(t, cap, func(w http.ResponseWriter) {
		authCovJSON(w, http.StatusOK, map[string]any{"expires_in": 600, "interval": 2})
	})
	authCovHeadless(t)

	// openBrowser is the observation point: it can only have been reached after the
	// registration, so recording the count AT that moment proves the order rather than
	// merely proving both happened.
	var registeredWhenOpened int32
	prevBrowser := openBrowser
	openBrowser = func(string) error {
		registeredWhenOpened = cap.startCalls.Load()
		return nil
	}
	t.Cleanup(func() { openBrowser = prevBrowser })

	if err := performLoginFlow(); err != nil {
		t.Fatalf("performLoginFlow: %v", err)
	}
	if registeredWhenOpened != 1 {
		t.Errorf("registrations before the browser opened = %d, want 1", registeredWhenOpened)
	}
	body, _ := cap.startBody.Load().(map[string]string)
	if body["user_code"] == "" {
		t.Error("the registration must carry the user_code the terminal is about to print")
	}
}

// TestConsent_LoginFlowSurvivesAControlPlaneWithoutTheRoute pins the compatibility
// direction: a new CLI against a control plane that predates /api/auth/cli/start gets a
// 404, and must still be able to log in. What is lost is the detail on the consent
// screen, not the ability to sign in — so the failure is WARNED about on stderr and the
// flow continues.
func TestConsent_LoginFlowSurvivesAControlPlaneWithoutTheRoute(t *testing.T) {
	credsPath := isolatedHome(t)
	savePreferences(cliPreferences{HideLoginWarning: true})
	cap := &consentCapture{}
	consentServer(t, cap, func(w http.ResponseWriter) {
		authCovJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	})
	authCovHeadless(t)

	restore := consentCaptureStderr(t)
	err := performLoginFlow()
	warning := restore()

	if err != nil {
		t.Fatalf("a control plane without the route must not break login: %v", err)
	}
	if _, statErr := os.Stat(credsPath); statErr != nil {
		t.Fatalf("the login should still have written credentials: %v", statErr)
	}
	if !strings.Contains(warning, "could not register") {
		t.Errorf("the degraded registration must be reported, stderr = %q", warning)
	}
}

// consentCaptureStderr redirects os.Stderr into a pipe and returns a function that
// restores it and yields what was written. The pipe is drained on a goroutine because a
// pipe with nobody reading it blocks the writer once the buffer fills — which would hang
// the test rather than fail it.
func consentCaptureStderr(t *testing.T) func() string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	prev := os.Stderr
	os.Stderr = w
	done := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	return func() string {
		os.Stderr = prev
		_ = w.Close()
		out := <-done
		_ = r.Close()
		return out
	}
}

// --- login.go · pollForToken surfaces a refusal ------------------------------

// TestConsent_PollStopsOnAccessDenied pins #3887's signalling half. The refusal used to
// reach nothing: "This isn't me" set browser-local state, the server was never told, and
// this loop polled to its own ten-minute timeout — so the person who refused gave the
// terminal (in the phishing case, the ATTACKER's terminal) no signal at all.
//
// Two claims, and the second is the one a status check alone would miss: the message has
// to SAY a person refused, and the poll has to stop on the FIRST answer rather than
// treating it as another reason to wait.
func TestConsent_PollStopsOnAccessDenied(t *testing.T) {
	prev := loginPollInterval
	loginPollInterval = time.Millisecond
	t.Cleanup(func() { loginPollInterval = prev })

	var polls atomic.Int32
	srv := authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
		polls.Add(1)
		authCovJSON(w, http.StatusForbidden, map[string]string{
			"error":             deviceAccessDenied,
			"error_description": "The sign-in was refused in the browser.",
		})
	})

	msg := pollForToken("dev-code", srv.URL+"/api/auth/cli/exchange")()
	bad, is := msg.(authErrorMsg)
	if !is {
		t.Fatalf("msg = %#v, want authErrorMsg", msg)
	}
	text := bad.err.Error()
	if !strings.Contains(text, "refused in the browser") {
		t.Errorf("the message must say a person refused, got %q", text)
	}
	if !strings.Contains(text, "no token was issued") {
		t.Errorf("the message must say nothing was issued, got %q", text)
	}
	if got := polls.Load(); got != 1 {
		t.Errorf("access_denied is terminal: polls = %d, want 1", got)
	}
}

// TestConsent_PollFallsThroughOnAnUnrelatedForbidden pins that the refusal arm is matched
// on the RFC 8628 error code and not on the 403 alone. A forbidden that is not a refusal
// must not be reported to the user as a decision somebody made.
func TestConsent_PollFallsThroughOnAnUnrelatedForbidden(t *testing.T) {
	srv := authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
		authCovJSON(w, http.StatusForbidden, map[string]string{"error": "trusted_ip_unavailable"})
	})

	msg := pollForToken("dev-code", srv.URL+"/api/auth/cli/exchange")()
	bad, is := msg.(authErrorMsg)
	if !is {
		t.Fatalf("msg = %#v, want authErrorMsg", msg)
	}
	if strings.Contains(bad.err.Error(), "refused in the browser") {
		t.Errorf("an unrelated 403 must not read as a refusal, got %q", bad.err)
	}
	if !strings.Contains(bad.err.Error(), "trusted_ip_unavailable") {
		t.Errorf("the server's reason should survive, got %q", bad.err)
	}
}
