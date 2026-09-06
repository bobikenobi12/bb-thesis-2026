// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// END-TO-END through cobra, so the `Run:` closures themselves execute.
//
// token_pure_test.go drives runTokenList / runTokenCreate / runTokenRevoke directly, which is where
// the behaviour lives. It does NOT execute the closures that wire them to the command tree — flag
// reading, credential resolution, the client construction — and those are real statements that can
// break: a mistyped flag name or a `Run:` that forgets to pass `--expires-in-days` would leave every
// direct test green.
//
// Same harness the byo-write commands use.

type tokenSrvCall struct {
	method, path string
	body         map[string]any
}

func tokenEnv(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) (func(args ...string) error, *[]tokenSrvCall) {
	t.Helper()
	calls := &[]tokenSrvCall{}
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		*calls = append(*calls, tokenSrvCall{method: r.Method, path: r.URL.Path, body: body})
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	// $ALETHIA_TOKEN would short-circuit credential resolution entirely, and an ambient one from the
	// developer's shell would make these tests exercise a different path than they claim to.
	t.Setenv(ServiceTokenEnv, "")

	// cobra never resets flag state between Execute calls, so one test's --name would leak into the
	// next and the "no --name" arm would become unreachable while reading as passing.
	prevName, prevExpiry := tokenCreateName, tokenCreateExpires
	t.Cleanup(func() { tokenCreateName, tokenCreateExpires = prevName, prevExpiry })
	tokenCreateName, tokenCreateExpires = "", 0

	return func(args ...string) error {
		execRootArgs(args)
		return rootCmd.Execute()
	}, calls
}

func TestTokenListCommand(t *testing.T) {
	run, calls := tokenEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tokens": []map[string]any{{"id": "t1", "name": "ci", "token_prefix": "alethia_sat_abc12345", "created_at": "2026-08-26T09:00:00Z"}},
		})
	})
	if err := run("token", "list", "-o", "json"); err != nil {
		t.Fatalf("token list: %v", err)
	}
	if len(*calls) != 1 || (*calls)[0].path != "/api/cli/tokens" || (*calls)[0].method != http.MethodGet {
		t.Errorf("unexpected calls: %+v", *calls)
	}
}

func TestTokenCreateCommand(t *testing.T) {
	run, calls := tokenEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "t1", "name": "ci", "token_prefix": "alethia_sat_abc12345", "token": "alethia_sat_abc12345-rest",
		})
	})
	if err := run("token", "create", "--name", "ci", "--expires-in-days", "30", "-o", "json"); err != nil {
		t.Fatalf("token create: %v", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("unexpected calls: %+v", *calls)
	}
	// The flags must actually REACH the request. A `Run:` that read the wrong variable would leave
	// every direct test on runTokenCreate green while minting an unnamed, non-expiring token.
	if (*calls)[0].body["name"] != "ci" {
		t.Errorf("--name did not reach the request: %+v", (*calls)[0].body)
	}
	if (*calls)[0].body["expires_in_days"] != float64(30) {
		t.Errorf("--expires-in-days did not reach the request: %+v", (*calls)[0].body)
	}
}

func TestTokenRevokeCommand(t *testing.T) {
	run, calls := tokenEnv(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"revoked": true, "id": "t1"})
	})
	if err := run("token", "revoke", "t1"); err != nil {
		t.Fatalf("token revoke: %v", err)
	}
	if len(*calls) != 1 || (*calls)[0].method != http.MethodDelete || (*calls)[0].path != "/api/cli/tokens/t1" {
		t.Errorf("unexpected calls: %+v", *calls)
	}
}

// THE ERROR ARMS. Each `Run:` has two: one for credential resolution and one for the call itself,
// and both end in `fail`/`failf` → exitFunc. They are ordinary statements that can be wrong — a
// swapped message, or an arm that returns instead of exiting and lets the command continue with a
// nil client — so they are executed rather than left as the only unexercised lines in the file.
//
// exitFunc is swapped for a panic, the established pattern in cov_lists_test.go: a failf then
// surfaces as a catchable value instead of killing the test binary.
func TestTokenCommandsExitOnFailure(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
	}{
		{"list", []string{"token", "list"}},
		{"create", []string{"token", "create", "--name", "ci"}},
		{"revoke", []string{"token", "revoke", "t1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run, _ := tokenEnv(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": "boom"})
			})
			old := exitFunc
			exited := -1
			exitFunc = func(code int) { panic(tokenExit{code}) }
			t.Cleanup(func() { exitFunc = old })

			func() {
				defer func() {
					if r := recover(); r != nil {
						if e, ok := r.(tokenExit); ok {
							exited = e.code
							return
						}
						panic(r)
					}
				}()
				_ = run(tc.args...)
			}()

			if exited != 1 {
				t.Errorf("a failing %s exited with %d, want 1 — the error arm must terminate, not fall through", tc.name, exited)
			}
		})
	}
}

type tokenExit struct{ code int }
