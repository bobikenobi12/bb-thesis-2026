// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestRunAddonEnable(t *testing.T) {
	t.Run("forwards every field", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		p := api.EnableAddonParams{
			Project: "shop", Env: "staging", AddonID: "loki", Mode: "managed",
			Values:     map[string]interface{}{"retention_days": float64(7)},
			ValuesYAML: "loki:\n  auth_enabled: false\n",
		}
		if err := runAddonEnable(f, &buf, p); err != nil {
			t.Fatalf("runAddonEnable: %v", err)
		}
		if !reflect.DeepEqual(f.enabledAddon, p) {
			t.Errorf("params dropped:\n got %#v\nwant %#v", f.enabledAddon, p)
		}
		out := buf.String()
		if !strings.Contains(out, "Enabled add-on loki") || !strings.Contains(out, "in staging") {
			t.Errorf("confirmation should name the add-on and the environment: %q", out)
		}
	})

	t.Run("requires an add-on id", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runAddonEnable(f, &buf, api.EnableAddonParams{Project: "shop"}); err == nil {
			t.Fatal("an empty add-on id must be refused locally")
		}
		if f.enabledAddon.AddonID != "" {
			t.Error("the client must not be called without an add-on id")
		}
	})

	t.Run("surfaces a server error", func(t *testing.T) {
		var buf bytes.Buffer
		if err := runAddonEnable(&fakeClient{err: errBoom}, &buf, api.EnableAddonParams{AddonID: "loki"}); err == nil {
			t.Fatal("expected the server error to surface")
		}
	})

	// No environment named → the confirmation must not invent one.
	t.Run("omits the environment when none was given", func(t *testing.T) {
		var buf bytes.Buffer
		if err := runAddonEnable(&fakeClient{}, &buf, api.EnableAddonParams{AddonID: "loki"}); err != nil {
			t.Fatalf("runAddonEnable: %v", err)
		}
		if strings.Contains(buf.String(), " in ") {
			t.Errorf("confirmation invented an environment: %q", buf.String())
		}
	})
}

func TestRunAddonDisable(t *testing.T) {
	t.Run("forwards the arguments", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runAddonDisable(f, &buf, "shop", "dev", "falco"); err != nil {
			t.Fatalf("runAddonDisable: %v", err)
		}
		if f.disabledAddonProj != "shop" || f.disabledAddonEnv != "dev" || f.disabledAddonID != "falco" {
			t.Errorf("args dropped: %q/%q/%q", f.disabledAddonProj, f.disabledAddonEnv, f.disabledAddonID)
		}
		if !strings.Contains(buf.String(), "Disabled add-on falco in dev") {
			t.Errorf("unexpected confirmation: %q", buf.String())
		}
	})

	t.Run("requires an add-on id", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runAddonDisable(f, &buf, "shop", "", ""); err == nil {
			t.Fatal("an empty add-on id must be refused locally")
		}
		if f.disabledAddonID != "" {
			t.Error("the client must not be called without an add-on id")
		}
	})

	t.Run("surfaces a server error", func(t *testing.T) {
		var buf bytes.Buffer
		if err := runAddonDisable(&fakeClient{err: errBoom}, &buf, "shop", "", "falco"); err == nil {
			t.Fatal("expected the server error to surface")
		}
	})
}

func TestReadAddonValuesFile(t *testing.T) {
	t.Run("no path yields no override", func(t *testing.T) {
		got, err := readAddonValuesFile("")
		if err != nil || got != "" {
			t.Fatalf("readAddonValuesFile(\"\") = (%q, %v)", got, err)
		}
	})

	t.Run("reads the file verbatim", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "values.yaml")
		content := "loki:\n  auth_enabled: false\n"
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		got, err := readAddonValuesFile(path)
		if err != nil {
			t.Fatalf("readAddonValuesFile: %v", err)
		}
		// Verbatim, NOT parsed: the server validates it as a YAML mapping through the same action the
		// console uses, and a local pre-parse would be a second opinion that can disagree with the one
		// that decides.
		if got != content {
			t.Errorf("content altered:\n got %q\nwant %q", got, content)
		}
	})

	t.Run("a missing file is a clear error", func(t *testing.T) {
		_, err := readAddonValuesFile(filepath.Join(t.TempDir(), "nope.yaml"))
		if err == nil || !strings.Contains(err.Error(), "--values-file") {
			t.Fatalf("want an error naming the flag, got %v", err)
		}
	})
}

// addonEnv stands up isolated credentials and a fake control plane serving the addons collection,
// recording the last request so a test can assert the method and body the CLI actually sent.
func addonEnv(t *testing.T, status int) (func(args ...string) error, *addonRec) {
	t.Helper()
	rec := &addonRec{}
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/addons") {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "not found: " + r.URL.Path})
			return
		}
		rec.method = r.Method
		rec.query = r.URL.RawQuery
		_ = json.NewDecoder(r.Body).Decode(&rec.body)
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	prevMode, prevSet, prevFile, prevYes := addonEnableMode, addonEnableSet, addonEnableValuesFile, addonDisableYes
	t.Cleanup(func() {
		addonEnableMode, addonEnableSet, addonEnableValuesFile, addonDisableYes = prevMode, prevSet, prevFile, prevYes
	})
	addonEnableMode, addonEnableSet, addonEnableValuesFile, addonDisableYes = "", nil, "", false
	// cobra never resets a PERSISTENT flag between Execute calls, so without this one test's
	// --project leaks into the next and the "no project" arm becomes unreachable.
	resetAddonPersistentFlags(t)

	return func(args ...string) error {
		execRootArgs(args)
		return rootCmd.Execute()
	}, rec
}

type addonRec struct {
	method string
	query  string
	body   map[string]interface{}
}

func TestAddonEnableCmd(t *testing.T) {
	t.Run("POSTs the add-on with its knobs and env", func(t *testing.T) {
		run, rec := addonEnv(t, http.StatusCreated)
		exited, code, err := connInvoke(t, run, "addon", "enable", "loki",
			"--project", "shop", "--env", "staging", "--mode", "managed", "--set", "retention_days=7")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatalf("unexpected fatal exit (code %d)", code)
		}
		if rec.method != "POST" {
			t.Errorf("method = %q, want POST", rec.method)
		}
		if rec.query != "env=staging" {
			t.Errorf("query = %q, want env=staging", rec.query)
		}
		if rec.body["addon_id"] != "loki" || rec.body["mode"] != "managed" {
			t.Errorf("unexpected body: %+v", rec.body)
		}
		vals, _ := rec.body["values"].(map[string]interface{})
		if vals["retention_days"] != float64(7) {
			t.Errorf("--set not coerced to a number: %+v", vals)
		}
	})

	t.Run("a --values-file is sent verbatim", func(t *testing.T) {
		run, rec := addonEnv(t, http.StatusCreated)
		path := filepath.Join(t.TempDir(), "v.yaml")
		if err := os.WriteFile(path, []byte("loki:\n  auth_enabled: false\n"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		exited, _, err := connInvoke(t, run, "addon", "enable", "loki", "--project", "shop", "--values-file", path)
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatal("unexpected fatal exit")
		}
		if got, _ := rec.body["values_yaml"].(string); !strings.Contains(got, "auth_enabled: false") {
			t.Errorf("values_yaml not forwarded: %q", got)
		}
	})

	t.Run("a bad --set is fatal before the request", func(t *testing.T) {
		run, rec := addonEnv(t, http.StatusCreated)
		exited, code, err := connInvoke(t, run, "addon", "enable", "loki", "--project", "shop", "--set", "novalue")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("a malformed --set must exit fatally, got exited=%v code=%d", exited, code)
		}
		if rec.method != "" {
			t.Error("nothing should have been sent")
		}
	})

	t.Run("a missing --values-file is fatal", func(t *testing.T) {
		run, _ := addonEnv(t, http.StatusCreated)
		exited, code, err := connInvoke(t, run, "addon", "enable", "loki", "--project", "shop",
			"--values-file", filepath.Join(t.TempDir(), "nope.yaml"))
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("expected a fatal exit, got exited=%v code=%d", exited, code)
		}
	})

	t.Run("a server refusal is fatal", func(t *testing.T) {
		run, _ := addonEnv(t, http.StatusBadRequest)
		exited, code, err := connInvoke(t, run, "addon", "enable", "nope", "--project", "shop")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("expected a fatal exit, got exited=%v code=%d", exited, code)
		}
	})
}

func TestAddonDisableCmd(t *testing.T) {
	t.Run("DELETEs with the add-on in the body", func(t *testing.T) {
		run, rec := addonEnv(t, http.StatusOK)
		exited, code, err := connInvoke(t, run, "addon", "disable", "falco", "--project", "shop", "--env", "dev", "--yes")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatalf("unexpected fatal exit (code %d)", code)
		}
		if rec.method != "DELETE" {
			t.Errorf("method = %q, want DELETE", rec.method)
		}
		// The id travels in the BODY because the route is a collection endpoint, not .../addons/<id>.
		if rec.body["addon_id"] != "falco" {
			t.Errorf("addon_id not in the body: %+v", rec.body)
		}
	})

	// Without --yes and without a TTY the confirmation must refuse rather than proceed.
	t.Run("no --yes and no TTY sends nothing", func(t *testing.T) {
		run, rec := addonEnv(t, http.StatusOK)
		if _, _, err := connInvoke(t, run, "addon", "disable", "falco", "--project", "shop"); err != nil {
			t.Fatalf("execute: %v", err)
		}
		if rec.method != "" {
			t.Errorf("a destructive disable must not proceed unconfirmed (sent %s)", rec.method)
		}
	})

	t.Run("a server refusal is fatal", func(t *testing.T) {
		run, _ := addonEnv(t, http.StatusForbidden)
		exited, code, err := connInvoke(t, run, "addon", "disable", "falco", "--project", "shop", "--yes")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("expected a fatal exit, got exited=%v code=%d", exited, code)
		}
	})
}

// TestAddonWritesRequireAuth covers the getAuthToken arm on both commands.
func TestAddonWritesRequireAuth(t *testing.T) {
	for _, args := range [][]string{
		{"addon", "enable", "loki", "--project", "shop"},
		{"addon", "disable", "falco", "--project", "shop", "--yes"},
	} {
		t.Run(args[1], func(t *testing.T) {
			isolatedHome(t) // no credentials written
			t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
			addonEnableMode, addonEnableSet, addonEnableValuesFile, addonDisableYes = "", nil, "", false
			run := func(a ...string) error {
				execRootArgs(a)
				return rootCmd.Execute()
			}
			exited, code, err := connInvoke(t, run, args...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if !exited || code == 0 {
				t.Fatalf("an unauthenticated write must exit fatally, got exited=%v code=%d", exited, code)
			}
		})
	}
}

// resetAddonPersistentFlags clears the addon group's persistent --project/--env before and after a
// test. They live on addonCmd, which is a package global whose flag values survive Execute.
func resetAddonPersistentFlags(t *testing.T) {
	t.Helper()
	reset := func() {
		_ = addonCmd.PersistentFlags().Set("project", "")
		_ = addonCmd.PersistentFlags().Set("env", "")
	}
	reset()
	t.Cleanup(reset)
}

// TestAddonEnableRequiresProject covers the currentProject arm: --project is not optional, and the
// command must say so rather than requesting /projects//addons.
func TestAddonEnableRequiresProject(t *testing.T) {
	run, rec := addonEnv(t, http.StatusCreated)
	exited, code, err := connInvoke(t, run, "addon", "enable", "loki")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code == 0 {
		t.Fatalf("expected a fatal exit, got exited=%v code=%d", exited, code)
	}
	if rec.method != "" {
		t.Errorf("nothing should have been sent, got %s", rec.method)
	}
}

// TestAddonDisableRequiresProject is the same for disable, past the confirmation.
func TestAddonDisableRequiresProject(t *testing.T) {
	run, rec := addonEnv(t, http.StatusOK)
	exited, code, err := connInvoke(t, run, "addon", "disable", "falco", "--yes")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code == 0 {
		t.Fatalf("expected a fatal exit, got exited=%v code=%d", exited, code)
	}
	if rec.method != "" {
		t.Errorf("nothing should have been sent, got %s", rec.method)
	}
}

// TestAddonDisableDeclinedSendsNothing covers the answered-NO arm. Without a TTY confirmDestructive
// fails outright, so reaching the plain `return` needs an interactive session that answers no.
func TestAddonDisableDeclinedSendsNothing(t *testing.T) {
	run, rec := addonEnv(t, http.StatusOK)
	connStubConfirm(t, false)
	exited, code, err := connInvoke(t, run, "addon", "disable", "falco", "--project", "shop")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("declining must return cleanly, not exit fatally (code %d)", code)
	}
	if rec.method != "" {
		t.Errorf("a declined disable must send nothing, got %s", rec.method)
	}
}
