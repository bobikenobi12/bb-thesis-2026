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
	"github.com/spf13/cobra"
)

func TestRunChartAttach(t *testing.T) {
	t.Run("forwards every field", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		p := api.AttachChartParams{
			Project: "shop", Env: "dev", ID: "api", RepoURL: "https://github.com/acme/charts",
			ChartPath: "charts/api", Ref: "v1.2.3", Namespace: "api",
			// GitCredID stays exercised here on purpose: the SERVER still accepts the field
			// (#2788 withdrew the CLI flag, not the API), so the transport must keep carrying
			// it. Nothing in the CLI sets it any more — see the flag-surface test below.
			ValuesYAML: "image:\n  tag: v1\n", GitCredID: "cred-1",
			Values: map[string]interface{}{"replicas": float64(2)},
		}
		if err := runChartAttach(f, &buf, p); err != nil {
			t.Fatalf("runChartAttach: %v", err)
		}
		if !reflect.DeepEqual(f.attachedChart, p) {
			t.Errorf("params dropped:\n got %#v\nwant %#v", f.attachedChart, p)
		}
		if !strings.Contains(buf.String(), "Attached chart api in dev") {
			t.Errorf("unexpected confirmation: %q", buf.String())
		}
		// A chart is refused at deploy until it has been scanned, so the next step belongs in the output.
		if !strings.Contains(buf.String(), "chart scan api") {
			t.Errorf("output should point at the scan: %q", buf.String())
		}
	})

	// The server SLUGIFIES the id, so the confirmation must echo what it stored — otherwise the id the
	// caller is told to scan is not the id that exists.
	t.Run("echoes the server's resolved id", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{attachResult: &api.ByoAttachResult{OK: true, ID: "my-api"}}
		if err := runChartAttach(f, &buf, api.AttachChartParams{ID: "My API!", RepoURL: "oci://r/x"}); err != nil {
			t.Fatalf("runChartAttach: %v", err)
		}
		if !strings.Contains(buf.String(), "my-api") || strings.Contains(buf.String(), "My API!") {
			t.Errorf("the confirmation must use the stored id: %q", buf.String())
		}
	})

	for _, tc := range []struct {
		name string
		p    api.AttachChartParams
		// names is what the refusal must SAY. "both are required" told a caller writing a script
		// that something was missing without telling them which — and this command is now also
		// reachable with neither, from a run that could not open a form.
		names []string
	}{
		{"no id", api.AttachChartParams{RepoURL: "https://x"}, []string{"chart id"}},
		{"no repo", api.AttachChartParams{ID: "api"}, []string{"--repo"}},
		{"neither", api.AttachChartParams{}, []string{"chart id", "--repo"}},
	} {
		t.Run("refuses with "+tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			f := &fakeClient{}
			err := runChartAttach(f, &buf, tc.p)
			if err == nil {
				t.Fatal("expected a local refusal")
			}
			for _, want := range tc.names {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("the refusal must name %q: %v", want, err)
				}
			}
			if f.attachedChart.ID != "" || f.attachedChart.RepoURL != "" {
				t.Error("the client must not be called")
			}
		})
	}

	t.Run("surfaces a server error", func(t *testing.T) {
		var buf bytes.Buffer
		if err := runChartAttach(&fakeClient{err: errBoom}, &buf,
			api.AttachChartParams{ID: "api", RepoURL: "https://x"}); err == nil {
			t.Fatal("expected the server error to surface")
		}
	})
}

func TestRunChartDetachAndScan(t *testing.T) {
	t.Run("detach forwards and confirms", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runChartDetach(f, &buf, "shop", "dev", "api"); err != nil {
			t.Fatalf("runChartDetach: %v", err)
		}
		if len(f.byoDetached) != 1 || f.byoDetached[0] != "chart:shop:dev:api" {
			t.Errorf("unexpected detach: %v", f.byoDetached)
		}
		if !strings.Contains(buf.String(), "Detached chart api in dev") {
			t.Errorf("unexpected confirmation: %q", buf.String())
		}
	})

	t.Run("scan prints the job to follow", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runChartScan(f, &buf, "shop", "dev", "api"); err != nil {
			t.Fatalf("runChartScan: %v", err)
		}
		out := buf.String()
		// The job id is still printed — a scan is asynchronous, and a script polling a SPECIFIC job
		// needs the handle. The follow-up line no longer REPEATS it: `jobs logs --latest --follow`
		// resolves the same job without a token the reader has to carry between two commands, which
		// is the copied-placeholder handoff the CLI programme is removing.
		if !strings.Contains(out, "job-1") {
			t.Errorf("output must name the queued job: %q", out)
		}
		if !strings.Contains(out, "jobs logs --latest --follow") {
			t.Errorf("output must say how to follow it without an id: %q", out)
		}
		if strings.Contains(out, "jobs logs job-1") {
			t.Errorf("the follow-up must not ask the reader to copy the id back in: %q", out)
		}
	})

	t.Run("both refuse an empty id locally", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runChartDetach(f, &buf, "shop", "", ""); err == nil {
			t.Error("detach must refuse an empty id")
		}
		if err := runChartScan(f, &buf, "shop", "", ""); err == nil {
			t.Error("scan must refuse an empty id")
		}
		if len(f.byoDetached) != 0 || len(f.byoScanned) != 0 {
			t.Error("the client must not be called")
		}
	})

	t.Run("both surface a server error", func(t *testing.T) {
		var buf bytes.Buffer
		if err := runChartDetach(&fakeClient{err: errBoom}, &buf, "s", "", "api"); err == nil {
			t.Error("expected an error from detach")
		}
		if err := runChartScan(&fakeClient{err: errBoom}, &buf, "s", "", "api"); err == nil {
			t.Error("expected an error from scan")
		}
	})
}

func TestRunIacWrites(t *testing.T) {
	t.Run("attach forwards every field", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		p := api.AttachIacParams{
			Project: "shop", Env: "dev", RepoURL: "https://github.com/acme/infra",
			Ref: "main", Path: "iac/drift/aws", GitCredID: "cred-1",
			VarValues: map[string]interface{}{"region": "eu-west-1", "count": float64(2)},
		}
		if err := runIacAttach(f, &buf, p); err != nil {
			t.Fatalf("runIacAttach: %v", err)
		}
		if !reflect.DeepEqual(f.attachedIac, p) {
			t.Errorf("params dropped:\n got %#v\nwant %#v", f.attachedIac, p)
		}
		if !strings.Contains(buf.String(), "iac scan") {
			t.Errorf("output should point at the scan: %q", buf.String())
		}
	})

	t.Run("attach refuses without a repo", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runIacAttach(f, &buf, api.AttachIacParams{Project: "shop"}); err == nil {
			t.Fatal("expected a local refusal")
		}
		if f.attachedIac.RepoURL != "" {
			t.Error("the client must not be called")
		}
	})

	t.Run("detach and scan forward", func(t *testing.T) {
		var buf bytes.Buffer
		f := &fakeClient{}
		if err := runIacDetach(f, &buf, "shop", "dev"); err != nil {
			t.Fatalf("runIacDetach: %v", err)
		}
		if err := runIacScan(f, &buf, "shop", "dev"); err != nil {
			t.Fatalf("runIacScan: %v", err)
		}
		if len(f.byoDetached) != 1 || f.byoDetached[0] != "iac:shop:dev" {
			t.Errorf("unexpected detach: %v", f.byoDetached)
		}
		if !strings.Contains(buf.String(), "job-2") {
			t.Errorf("scan output must name the job: %q", buf.String())
		}
	})

	t.Run("all three surface a server error", func(t *testing.T) {
		var buf bytes.Buffer
		bad := &fakeClient{err: errBoom}
		if _, err := bad.AttachIac(api.AttachIacParams{}); err == nil {
			t.Error("attach")
		}
		if err := runIacDetach(bad, &buf, "s", ""); err == nil {
			t.Error("detach")
		}
		if err := runIacScan(bad, &buf, "s", ""); err == nil {
			t.Error("scan")
		}
	})
}

func TestPrintScanQueued(t *testing.T) {
	// A nil result must not panic and must not invent a job id.
	var buf bytes.Buffer
	printScanQueued(&buf, "chart x", "", nil)
	if strings.Contains(buf.String(), "Job ID") {
		t.Errorf("a nil result must not print a job id: %q", buf.String())
	}
	if !strings.Contains(buf.String(), "Queued a scan of the chart x") {
		t.Errorf("unexpected output: %q", buf.String())
	}
}

func TestReadChartValuesFile(t *testing.T) {
	if got, err := readChartValuesFile(""); err != nil || got != "" {
		t.Fatalf(`readChartValuesFile("") = (%q, %v)`, got, err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "v.yaml")
	content := "image:\n  tag: v1\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	got, err := readChartValuesFile(path)
	if err != nil || got != content {
		t.Fatalf("content altered: (%q, %v)", got, err)
	}
	if _, err := readChartValuesFile(filepath.Join(dir, "nope.yaml")); err == nil ||
		!strings.Contains(err.Error(), "--values-file") {
		t.Fatalf("want an error naming the flag, got %v", err)
	}
}

// byoEnv stands up isolated credentials and a fake control plane serving every byo endpoint, and
// records each request so a test can assert the method, path and body the CLI actually sent.
func byoEnv(t *testing.T, status int) (func(args ...string) error, *byoRec) {
	t.Helper()
	rec := &byoRec{}
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		rec.calls = append(rec.calls, byoCall{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, body: body})
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "id": "api", "job_id": "job-9"})
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	resetByoFlags(t)
	return func(args ...string) error {
		execRootArgs(args)
		return rootCmd.Execute()
	}, rec
}

type byoCall struct {
	method, path, query string
	body                map[string]interface{}
}
type byoRec struct{ calls []byoCall }

func (r *byoRec) last() byoCall {
	if len(r.calls) == 0 {
		return byoCall{}
	}
	return r.calls[len(r.calls)-1]
}

// resetByoFlags clears the flag state, including the chart/iac groups' PERSISTENT --project/--env.
// cobra never resets a persistent flag between Execute calls, so without this one test's --project
// leaks into the next and the "no --project" arm becomes unreachable while the test reads as passing.
func resetByoFlags(t *testing.T) {
	t.Helper()
	reset := func() {
		chartAttachRepo, chartAttachPath, chartAttachRef = "", "", ""
		chartAttachNamespace, chartAttachValuesFile = "", ""
		chartAttachSet, chartDetachYes = nil, false
		iacAttachRepo, iacAttachRef, iacAttachPath = "", "", ""
		iacAttachVar, iacDetachYes = nil, false
		for _, c := range []*cobra.Command{chartCmd, iacCmd} {
			_ = c.PersistentFlags().Set("project", "")
			_ = c.PersistentFlags().Set("env", "")
		}
	}
	reset()
	t.Cleanup(reset)
}

func TestByoWriteCommands(t *testing.T) {
	t.Run("chart attach POSTs the chart", func(t *testing.T) {
		run, rec := byoEnv(t, http.StatusCreated)
		exited, code, err := connInvoke(t, run, "chart", "attach", "api", "-p", "shop", "-e", "dev",
			"--repo", "https://github.com/acme/charts", "--chart-path", "charts/api", "--set", "replicas=2")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatalf("unexpected fatal exit (code %d)", code)
		}
		c := rec.last()
		if c.method != "POST" || !strings.HasSuffix(c.path, "/byo-charts") || c.query != "env=dev" {
			t.Errorf("unexpected request: %+v", c)
		}
		if c.body["id"] != "api" || c.body["chart_path"] != "charts/api" {
			t.Errorf("unexpected body: %+v", c.body)
		}
	})

	t.Run("chart detach DELETEs with the id in the body", func(t *testing.T) {
		run, rec := byoEnv(t, http.StatusOK)
		exited, _, err := connInvoke(t, run, "chart", "detach", "api", "-p", "shop", "--yes")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatal("unexpected fatal exit")
		}
		if c := rec.last(); c.method != "DELETE" || c.body["id"] != "api" {
			t.Errorf("unexpected request: %+v", c)
		}
	})

	t.Run("chart scan POSTs to the scan endpoint", func(t *testing.T) {
		run, rec := byoEnv(t, http.StatusOK)
		exited, _, err := connInvoke(t, run, "chart", "scan", "api", "-p", "shop")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatal("unexpected fatal exit")
		}
		if c := rec.last(); !strings.HasSuffix(c.path, "/byo-charts/scan") || c.body["id"] != "api" {
			t.Errorf("unexpected request: %+v", c)
		}
	})

	t.Run("iac attach POSTs the source", func(t *testing.T) {
		run, rec := byoEnv(t, http.StatusCreated)
		exited, _, err := connInvoke(t, run, "iac", "attach", "-p", "shop", "-e", "dev",
			"--repo", "https://github.com/acme/infra", "--path", "iac/drift/aws", "--var", "region=eu-west-1")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatal("unexpected fatal exit")
		}
		c := rec.last()
		if c.method != "POST" || !strings.HasSuffix(c.path, "/byo-iac") {
			t.Errorf("unexpected request: %+v", c)
		}
		vars, _ := c.body["var_values"].(map[string]interface{})
		if vars["region"] != "eu-west-1" {
			t.Errorf("--var not forwarded: %+v", c.body)
		}
	})

	t.Run("iac detach DELETEs with no body", func(t *testing.T) {
		run, rec := byoEnv(t, http.StatusOK)
		exited, _, err := connInvoke(t, run, "iac", "detach", "-p", "shop", "--yes")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatal("unexpected fatal exit")
		}
		// The environment is the whole address — an environment holds at most one source.
		if c := rec.last(); c.method != "DELETE" || len(c.body) != 0 {
			t.Errorf("unexpected request: %+v", c)
		}
	})

	t.Run("iac scan POSTs to the scan endpoint", func(t *testing.T) {
		run, rec := byoEnv(t, http.StatusOK)
		exited, _, err := connInvoke(t, run, "iac", "scan", "-p", "shop")
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if exited {
			t.Fatal("unexpected fatal exit")
		}
		if c := rec.last(); !strings.HasSuffix(c.path, "/byo-iac/scan") {
			t.Errorf("unexpected request: %+v", c)
		}
	})
}

// TestByoWritesFailLoudly walks every fatal arm: a missing --project, a server refusal, a malformed
// --set/--var, a missing values file, and an unconfirmed destructive detach.
func TestByoWritesFailLoudly(t *testing.T) {
	fatal := []struct {
		name   string
		status int
		args   []string
		sends  bool // whether a request is expected before the failure
	}{
		// --project is required by every one of the six, and each has its own arm to prove it.
		{"chart attach without --project", http.StatusCreated, []string{"chart", "attach", "api", "--repo", "https://x"}, false},
		{"chart detach without --project", http.StatusOK, []string{"chart", "detach", "api", "--yes"}, false},
		{"chart scan without --project", http.StatusOK, []string{"chart", "scan", "api"}, false},
		{"iac attach without --project", http.StatusCreated, []string{"iac", "attach", "--repo", "https://x"}, false},
		{"iac detach without --project", http.StatusOK, []string{"iac", "detach", "--yes"}, false},
		{"iac scan without --project", http.StatusOK, []string{"iac", "scan"}, false},
		{"chart attach without --repo", http.StatusCreated, []string{"chart", "attach", "api", "-p", "shop"}, false},
		{"chart attach with a bad --set", http.StatusCreated, []string{"chart", "attach", "api", "-p", "shop", "--repo", "https://x", "--set", "novalue"}, false},
		{"chart attach refused", http.StatusBadRequest, []string{"chart", "attach", "api", "-p", "shop", "--repo", "https://x"}, true},
		{"chart detach refused", http.StatusForbidden, []string{"chart", "detach", "api", "-p", "shop", "--yes"}, true},
		{"chart scan refused", http.StatusNotImplemented, []string{"chart", "scan", "api", "-p", "shop"}, true},
		{"iac attach without --repo", http.StatusCreated, []string{"iac", "attach", "-p", "shop"}, false},
		{"iac attach with a bad --var", http.StatusCreated, []string{"iac", "attach", "-p", "shop", "--repo", "https://x", "--var", "novalue"}, false},
		{"iac attach refused", http.StatusConflict, []string{"iac", "attach", "-p", "shop", "--repo", "https://x"}, true},
		{"iac detach refused", http.StatusForbidden, []string{"iac", "detach", "-p", "shop", "--yes"}, true},
		{"iac scan refused", http.StatusNotImplemented, []string{"iac", "scan", "-p", "shop"}, true},
	}
	for _, tc := range fatal {
		t.Run(tc.name, func(t *testing.T) {
			run, rec := byoEnv(t, tc.status)
			exited, code, err := connInvoke(t, run, tc.args...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if !exited || code == 0 {
				t.Fatalf("expected a fatal exit, got exited=%v code=%d", exited, code)
			}
			if !tc.sends && len(rec.calls) != 0 {
				t.Errorf("nothing should have been sent, got %+v", rec.calls)
			}
		})
	}

	t.Run("chart attach with a missing --values-file", func(t *testing.T) {
		run, rec := byoEnv(t, http.StatusCreated)
		exited, code, err := connInvoke(t, run, "chart", "attach", "api", "-p", "shop",
			"--repo", "https://x", "--values-file", filepath.Join(t.TempDir(), "nope.yaml"))
		if err != nil {
			t.Fatalf("execute: %v", err)
		}
		if !exited || code == 0 {
			t.Fatalf("expected a fatal exit, got exited=%v code=%d", exited, code)
		}
		if len(rec.calls) != 0 {
			t.Error("nothing should have been sent")
		}
	})

	// Destructive detaches must not proceed without confirmation.
	for _, args := range [][]string{
		{"chart", "detach", "api", "-p", "shop"},
		{"iac", "detach", "-p", "shop"},
	} {
		t.Run("unconfirmed "+args[0]+" detach sends nothing", func(t *testing.T) {
			run, rec := byoEnv(t, http.StatusOK)
			if _, _, err := connInvoke(t, run, args...); err != nil {
				t.Fatalf("execute: %v", err)
			}
			if len(rec.calls) != 0 {
				t.Errorf("a destructive detach must not proceed unconfirmed: %+v", rec.calls)
			}
		})
		t.Run("declined "+args[0]+" detach sends nothing", func(t *testing.T) {
			run, rec := byoEnv(t, http.StatusOK)
			connStubConfirm(t, false)
			exited, _, err := connInvoke(t, run, args...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if exited {
				t.Fatal("declining must return cleanly")
			}
			if len(rec.calls) != 0 {
				t.Errorf("a declined detach must send nothing: %+v", rec.calls)
			}
		})
	}

	t.Run("unauthenticated writes are fatal", func(t *testing.T) {
		for _, args := range [][]string{
			{"chart", "attach", "api", "-p", "shop", "--repo", "https://x"},
			{"chart", "detach", "api", "-p", "shop", "--yes"},
			{"chart", "scan", "api", "-p", "shop"},
			{"iac", "attach", "-p", "shop", "--repo", "https://x"},
			{"iac", "detach", "-p", "shop", "--yes"},
			{"iac", "scan", "-p", "shop"},
		} {
			isolatedHome(t)
			t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
			resetByoFlags(t)
			run := func(a ...string) error {
				execRootArgs(a)
				return rootCmd.Execute()
			}
			exited, code, err := connInvoke(t, run, args...)
			if err != nil {
				t.Fatalf("%v: execute: %v", args, err)
			}
			if !exited || code == 0 {
				t.Errorf("%v must exit fatally, got exited=%v code=%d", args, exited, code)
			}
		}
	})
}

// The `--git-credential-id` flag is GONE from both attach verbs (#2788).
//
// It accepted a value that nothing in the product could produce: `project_git_credentials` is
// only ever SELECTed, so the table is empty, and both `project_addons` and `project_iac_sources`
// carry a foreign key to it. Any value therefore reached the database and came back as a raw
// foreign-key violation — while telling the user their private repo needed a credential set up
// somewhere, and there was nowhere.
//
// What actually authorizes a private clone is the job-time token minted from the owner's linked
// OAuth account, scoped to the repositories the project declares. The attach verbs now say so.
//
// Asserted on the flag SET rather than on a string in help text: a flag can be re-added without
// touching the prose, and this must fail if it is.
func TestByoAttachOffersNoGitCredentialFlag(t *testing.T) {
	for _, c := range []struct {
		name string
		cmd  *cobra.Command
	}{{"chart attach", chartAttachCmd}, {"iac attach", iacAttachCmd}} {
		if f := c.cmd.Flags().Lookup("git-credential-id"); f != nil {
			t.Errorf("%s still offers --git-credential-id; the credential it names cannot be created (#2788)", c.name)
		}
		// And the real mechanism must be discoverable at the point of use, or removing the flag
		// just leaves the user with no answer instead of a wrong one.
		if !strings.Contains(c.cmd.Long, "linked GitHub/GitLab account") {
			t.Errorf("%s help does not say how a private repository is authorized", c.name)
		}
	}
}
