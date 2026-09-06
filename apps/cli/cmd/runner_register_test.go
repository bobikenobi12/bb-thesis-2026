// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestRunRunnerRegister(t *testing.T) {
	t.Run("prints the id and token as env assignments", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runRunnerRegister(f, &buf, "box-1", "ci-1"); err != nil {
			t.Fatalf("runRunnerRegister: %v", err)
		}
		if f.regRunnerName != "box-1" || f.regRunnerIdentity != "ci-1" {
			t.Errorf("args not forwarded: %q / %q", f.regRunnerName, f.regRunnerIdentity)
		}
		out := buf.String()
		// Env-assignment form, because the next thing that happens to these is being pasted into an
		// env file or a systemd unit.
		for _, want := range []string{"ALETHIA_RUNNER_ID=run1", "ALETHIA_RUNNER_TOKEN=tok-abc123"} {
			if !strings.Contains(out, want) {
				t.Errorf("output missing %q:\n%s", want, out)
			}
		}
		// The one-shot warning is load-bearing: only the hash is stored, so a discarded token is gone.
		if !strings.Contains(out, "shown once") {
			t.Errorf("output must warn the token is shown once:\n%s", out)
		}
	})

	t.Run("an empty cloud identity is not sent", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runRunnerRegister(f, &buf, "box-2", ""); err != nil {
			t.Fatalf("runRunnerRegister: %v", err)
		}
		if f.regRunnerIdentity != "" {
			t.Errorf("empty identity became %q", f.regRunnerIdentity)
		}
	})

	t.Run("requires a name", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runRunnerRegister(f, &buf, "", ""); err == nil {
			t.Fatal("a nameless runner must be refused locally")
		}
		if f.regRunnerName != "" {
			t.Error("the client must not be called without a name")
		}
	})

	t.Run("surfaces a server error", func(t *testing.T) {
		var buf bytes.Buffer
		if err := runRunnerRegister(&fakeClient{err: errBoom}, &buf, "box-3", ""); err == nil {
			t.Fatal("expected the server error to surface")
		}
	})

	// A nil registration with no error would otherwise panic on reg.Runner — the shape a stubbed or
	// half-implemented server can produce.
	t.Run("a nil registration is an error, not a panic", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{registration: nil}
		// Force the nil path: the fake substitutes a default when registration is nil, so use a
		// client that returns (nil, nil) directly.
		if err := runRunnerRegister(nilRegClient{}, &buf, "box-4", ""); err == nil {
			t.Fatal("expected an error for a nil registration")
		}
		_ = f
	})
}

// nilRegClient returns (nil, nil) from RegisterRunner and panics on anything else, so the test can
// only exercise the path it names.
type nilRegClient struct{ apiClient }

func (nilRegClient) RegisterRunner(string, string) (*api.RunnerRegistration, error) {
	return nil, nil
}

// regEnv stands up isolated credentials and a fake control plane that serves ONLY
// /api/cli/runners/register, then returns a runner over the real cobra tree. Self-contained rather
// than bolted onto covListEnv, whose handler treats an unmapped path as a test failure.
func regEnv(t *testing.T, status int, body map[string]any) func(args ...string) error {
	t.Helper()
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/cli/runners/register" {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "not found: " + r.URL.Path})
			return
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	prevName, prevID := registerRunnerName, registerCloudIdentity
	t.Cleanup(func() { registerRunnerName, registerCloudIdentity = prevName, prevID })
	registerRunnerName, registerCloudIdentity = "", ""
	return func(args ...string) error {
		execRootArgs(args)
		return rootCmd.Execute()
	}
}

func regOKBody() map[string]any {
	return map[string]any{
		"runner": map[string]any{
			"id": "r1", "name": "box", "operator": "self", "provisioning": "registered",
			"supported_providers": nil, "status": "OFFLINE", "last_heartbeat": nil,
			"version": "", "is_default": false, "created_at": "2026-01-01T00:00:00.000Z",
		},
		"runner_token": "tok-xyz",
	}
}

// TestRunnerRegisterCmd drives the cobra closure — the arm the unit tests above cannot reach,
// because it resolves the auth token and builds a real client.
func TestRunnerRegisterCmd(t *testing.T) {
	t.Run("name as a positional argument", func(t *testing.T) {
		run := regEnv(t, http.StatusCreated, regOKBody())
		exited, code, err := connInvoke(t, run, "runner", "register", "box")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatalf("unexpected fatal exit (code %d)", code)
		}
	})

	t.Run("name via --name", func(t *testing.T) {
		run := regEnv(t, http.StatusCreated, regOKBody())
		exited, code, err := connInvoke(t, run, "runner", "register", "--name", "box", "--cloud-identity-id", "ci-1")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatalf("unexpected fatal exit (code %d)", code)
		}
	})

	t.Run("no name is fatal", func(t *testing.T) {
		run := regEnv(t, http.StatusCreated, regOKBody())
		exited, code, err := connInvoke(t, run, "runner", "register")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("a nameless register must exit fatally, got exited=%v code=%d", exited, code)
		}
	})

	t.Run("a server refusal is fatal", func(t *testing.T) {
		run := regEnv(t, http.StatusForbidden, map[string]any{"error": "nope"})
		exited, code, err := connInvoke(t, run, "runner", "register", "box")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("a refused register must exit fatally, got exited=%v code=%d", exited, code)
		}
	})

	t.Run("unauthenticated is fatal", func(t *testing.T) {
		isolatedHome(t) // no credentials
		t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
		run := func(args ...string) error {
			execRootArgs(args)
			return rootCmd.Execute()
		}
		exited, code, err := connInvoke(t, run, "runner", "register", "box")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("expected a fatal exit, got exited=%v code=%d", exited, code)
		}
	})
}
