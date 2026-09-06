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
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestReadDesignDocument(t *testing.T) {
	t.Run("requires -f", func(t *testing.T) {
		if _, err := readDesignDocument("", strings.NewReader("")); err == nil ||
			!strings.Contains(err.Error(), "-f is required") {
			t.Fatalf("want an error naming the flag, got %v", err)
		}
	})

	t.Run("reads a file", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "d.json")
		if err := os.WriteFile(path, []byte(`{"project":{}}`), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		got, err := readDesignDocument(path, strings.NewReader(""))
		if err != nil || string(got) != `{"project":{}}` {
			t.Fatalf("readDesignDocument = (%s, %v)", got, err)
		}
	})

	t.Run("reads stdin for -", func(t *testing.T) {
		got, err := readDesignDocument("-", strings.NewReader(`{"a":1}`))
		if err != nil || string(got) != `{"a":1}` {
			t.Fatalf("readDesignDocument = (%s, %v)", got, err)
		}
	})

	t.Run("a missing file is a clear error", func(t *testing.T) {
		if _, err := readDesignDocument(filepath.Join(t.TempDir(), "nope.json"), nil); err == nil {
			t.Fatal("expected an error")
		}
	})

	// Invalid JSON is caught locally because the failure is unambiguous and the message can name the
	// command that produces the right shape. The SHAPE is still the server's to judge.
	t.Run("rejects non-JSON and names the producer", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "d.json")
		if err := os.WriteFile(path, []byte("project: {}\n"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		_, err := readDesignDocument(path, nil)
		if err == nil || !strings.Contains(err.Error(), "config export") {
			t.Fatalf("want an error pointing at config export, got %v", err)
		}
	})
}

func TestRunDesignApply(t *testing.T) {
	doc := json.RawMessage(`{"project":{}}`)

	t.Run("applied", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runDesignApply(f, &buf, api.ApplyDesignParams{Project: "shop", Env: "dev", Document: doc}); err != nil {
			t.Fatalf("runDesignApply: %v", err)
		}
		if f.appliedDesign.Project != "shop" || string(f.appliedDesign.Document) != string(doc) {
			t.Errorf("params dropped: %+v", f.appliedDesign)
		}
		if !strings.Contains(buf.String(), "Applied the design in dev") {
			t.Errorf("unexpected output: %q", buf.String())
		}
	})

	t.Run("staged", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runDesignApply(f, &buf, api.ApplyDesignParams{Project: "shop", Document: doc, Stage: true}); err != nil {
			t.Fatalf("runDesignApply: %v", err)
		}
		if !strings.Contains(buf.String(), "Staged the design") {
			t.Errorf("unexpected output: %q", buf.String())
		}
	})

	// A dry run writes nothing, so the ROWS are the output — printing only "ok" would make the mode
	// useless.
	t.Run("dry run prints the plan", func(t *testing.T) {
		var buf bytes.Buffer
		name := "orders"
		f := &fakeClient{designResult: &api.DesignApplyResult{
			OK: true, Mode: "dry-run",
			Changes: []api.DesignChange{
				{Kind: "databases", Name: &name, Action: "UPDATE"},
				{Kind: "network", Name: nil, Action: "CREATE"},
			},
		}}
		if err := runDesignApply(f, &buf, api.ApplyDesignParams{Project: "shop", Document: doc, DryRun: true}); err != nil {
			t.Fatalf("runDesignApply: %v", err)
		}
		out := buf.String()
		for _, want := range []string{"2 change(s)", "UPDATE", "databases orders", "CREATE", "network", "Nothing was written"} {
			if !strings.Contains(out, want) {
				t.Errorf("output missing %q:\n%s", want, out)
			}
		}
	})

	t.Run("dry run with no changes says so", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{designResult: &api.DesignApplyResult{OK: true, Mode: "dry-run"}}
		if err := runDesignApply(f, &buf, api.ApplyDesignParams{Document: doc, DryRun: true}); err != nil {
			t.Fatalf("runDesignApply: %v", err)
		}
		if !strings.Contains(buf.String(), "already matches") {
			t.Errorf("unexpected output: %q", buf.String())
		}
	})

	t.Run("refuses an empty document", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runDesignApply(f, &buf, api.ApplyDesignParams{Project: "shop"}); err == nil {
			t.Fatal("expected a local refusal")
		}
		if f.appliedDesign.Project != "" {
			t.Error("the client must not be called")
		}
	})

	t.Run("surfaces a server error", func(t *testing.T) {
		var buf bytes.Buffer
		if err := runDesignApply(&fakeClient{err: errBoom}, &buf,
			api.ApplyDesignParams{Document: doc}); err == nil {
			t.Fatal("expected the server error to surface")
		}
	})

	// A nil result with no error would otherwise panic on res.Mode.
	t.Run("a nil result is an error, not a panic", func(t *testing.T) {
		var buf bytes.Buffer
		if err := runDesignApply(nilDesignClient{}, &buf, api.ApplyDesignParams{Document: doc}); err == nil {
			t.Fatal("expected an error for a nil result")
		}
	})
}

type nilDesignClient struct{ apiClient }

func (nilDesignClient) ApplyDesign(api.ApplyDesignParams) (*api.DesignApplyResult, error) {
	return nil, nil
}

// designEnv stands up isolated credentials and a fake control plane serving the design endpoint,
// recording the request so a test can assert what the CLI sent.
func designEnv(t *testing.T, status int, body map[string]any) (func(args ...string) error, *designRec) {
	t.Helper()
	rec := &designRec{}
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.query = r.URL.RawQuery
		rec.body, _ = io.ReadAll(r.Body)
		rec.hits++
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	resetDesignFlags(t)
	return func(args ...string) error {
		execRootArgs(args)
		return rootCmd.Execute()
	}, rec
}

type designRec struct {
	query string
	body  []byte
	hits  int
}

// resetDesignFlags clears the design group's flags including the PERSISTENT --project/--env, which
// cobra never resets between Execute calls.
func resetDesignFlags(t *testing.T) {
	t.Helper()
	reset := func() {
		designApplyFile, designApplyDryRun, designApplyStage = "", false, false
		_ = projectDesignCmd.PersistentFlags().Set("project", "")
		_ = projectDesignCmd.PersistentFlags().Set("env", "")
	}
	reset()
	t.Cleanup(reset)
}

func writeDesignDoc(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "d.json")
	if err := os.WriteFile(path, []byte(`{"project":{"project_name":"shop"}}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return path
}

func TestProjectDesignApplyCmd(t *testing.T) {
	ok := map[string]any{"ok": true, "mode": "applied", "changes": []any{}}

	t.Run("applies a document from a file", func(t *testing.T) {
		run, rec := designEnv(t, http.StatusOK, ok)
		exited, code, err := connInvoke(t, run, "project", "design", "apply", "-p", "shop", "-e", "dev", "-f", writeDesignDoc(t))
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatalf("unexpected fatal exit (code %d)", code)
		}
		if rec.query != "env=dev" || !strings.Contains(string(rec.body), "shop") {
			t.Errorf("query %q body %s", rec.query, rec.body)
		}
	})

	t.Run("--dry-run adds the query param", func(t *testing.T) {
		run, rec := designEnv(t, http.StatusOK, map[string]any{"ok": true, "mode": "dry-run", "changes": []any{}})
		exited, _, err := connInvoke(t, run, "project", "design", "apply", "-p", "shop", "-f", writeDesignDoc(t), "--dry-run")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatal("unexpected fatal exit")
		}
		if !strings.Contains(rec.query, "dry_run=1") {
			t.Errorf("query = %q", rec.query)
		}
	})

	t.Run("--stage adds the query param", func(t *testing.T) {
		run, rec := designEnv(t, http.StatusOK, map[string]any{"ok": true, "mode": "staged", "changes": []any{}})
		exited, _, err := connInvoke(t, run, "project", "design", "apply", "-p", "shop", "-f", writeDesignDoc(t), "--stage")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatal("unexpected fatal exit")
		}
		if !strings.Contains(rec.query, "stage=1") {
			t.Errorf("query = %q", rec.query)
		}
	})

	// The two modes contradict each other — one writes nothing, the other writes to the review tray —
	// so passing both is refused rather than silently resolved to one of them.
	t.Run("--dry-run with --stage is fatal and sends nothing", func(t *testing.T) {
		run, rec := designEnv(t, http.StatusOK, ok)
		exited, code, err := connInvoke(t, run, "project", "design", "apply", "-p", "shop",
			"-f", writeDesignDoc(t), "--dry-run", "--stage")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("expected a fatal exit, got exited=%v code=%d", exited, code)
		}
		if rec.hits != 0 {
			t.Error("nothing should have been sent")
		}
	})

	for _, tc := range []struct {
		name   string
		args   []string
		status int
	}{
		{"no -f", []string{"project", "design", "apply", "-p", "shop"}, http.StatusOK},
		{"no --project", []string{"project", "design", "apply", "-f", "/dev/null"}, http.StatusOK},
		{"server refusal", nil, http.StatusBadRequest},
	} {
		t.Run(tc.name+" is fatal", func(t *testing.T) {
			run, _ := designEnv(t, tc.status, map[string]any{"error": "nope"})
			args := tc.args
			if args == nil {
				args = []string{"project", "design", "apply", "-p", "shop", "-f", writeDesignDoc(t)}
			}
			exited, code, err := connInvoke(t, run, args...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if !exited || code == 0 {
				t.Fatalf("expected a fatal exit, got exited=%v code=%d", exited, code)
			}
		})
	}

	t.Run("unauthenticated is fatal", func(t *testing.T) {
		isolatedHome(t)
		t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
		resetDesignFlags(t)
		path := writeDesignDoc(t)
		run := func(a ...string) error {
			execRootArgs(a)
			return rootCmd.Execute()
		}
		exited, code, err := connInvoke(t, run, "project", "design", "apply", "-p", "shop", "-f", path)
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("expected a fatal exit, got exited=%v code=%d", exited, code)
		}
	})
}
