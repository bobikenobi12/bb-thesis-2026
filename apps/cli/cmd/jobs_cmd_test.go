// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// End to end through the real cobra tree, because the thing this unit changed lives in the
// command closures: which job each verb acts on, and what it says about a job it chose itself.
// The unit tests above drive resolveJob directly; these prove the commands are wired to it.

// jobsCmdExit is the sentinel a trapped exitFunc panics with, so a fatal path is observable as
// an exit code instead of killing the test binary.
type jobsCmdExit struct{ code int }

// jobsCmdServer is a control plane that serves the jobs endpoints and records what was asked.
type jobsCmdServer struct {
	mu       sync.Mutex
	requests []string
	// listQuery is the raw query string of the last GET /api/jobs.
	listQuery string
}

func (s *jobsCmdServer) record(r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, r.Method+" "+r.URL.Path)
	if r.URL.Path == "/api/jobs" {
		s.listQuery = r.URL.RawQuery
	}
}

func (s *jobsCmdServer) saw(method, path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, req := range s.requests {
		if req == method+" "+path {
			return true
		}
	}
	return false
}

func (s *jobsCmdServer) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.requests)
}

// jobsCmdResetFlags puts the jobs subtree back to its defaults. rootCmd is a package global and
// both the flags and the variables they bind survive an Execute, so a --latest or a --yes left
// set would silently steer the next run in this package.
func jobsCmdResetFlags() {
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		c.Flags().VisitAll(func(f *pflag.Flag) {
			if !f.Changed {
				return
			}
			_ = f.Value.Set(f.DefValue)
			f.Changed = false
		})
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	walk(rootCmd)
	// The selector structs and --yes are bound to flags, so the walk above clears them; they are
	// re-zeroed here anyway because a test that assigns one directly would otherwise leak it into
	// the next run, which is exactly the failure the explicit list in hyg_cli_confirm_test.go
	// exists to prevent.
	jobsGetSelector, jobsLogsSelector, jobsCancelSelector = jobSelector{}, jobSelector{}, jobSelector{}
	jobsCancelYes, jobsLogsFollow = false, false
	jobsListStatus, jobsListLimit = "", 20
}

// jobsCmdJob is the job the fake control plane serves, newest of two.
func jobsCmdJob(id, jobType, status string) map[string]any {
	return map[string]any{
		"id": id, "job_type": jobType, "status": status,
		"project_id": "p-web-0001", "project_name": "web",
		"created_at": "2026-03-09T12:00:00Z", "updated_at": "2026-03-09T12:00:00Z",
		"config_snapshot": map[string]any{},
		"execution_metadata": map[string]any{
			"cost_breakdown": map[string]any{"currency": "USD", "totalMonthlyCost": "124.56"},
		},
	}
}

// jobsCmdEnv stands up isolated credentials, an active org and a fake control plane, traps
// exitFunc, and returns the recorder plus a runner that drives the real cobra tree and reports
// the exit code the command asked for (0 when it never exits).
func jobsCmdEnv(t *testing.T) (*jobsCmdServer, func(args ...string) int) {
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

	s := &jobsCmdServer{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.record(r)
		enc := json.NewEncoder(w)
		switch p := r.URL.Path; {
		case p == "/api/jobs":
			_ = enc.Encode(map[string]any{
				"jobs": []map[string]any{
					jobsCmdJob("job-newest", string(types.JobTypeDeploy), "PROCESSING"),
					jobsCmdJob("job-older", string(types.JobTypePlan), "SUCCESS"),
				},
				"total": 2, "limit": 50, "offset": 0,
			})
		case strings.HasSuffix(p, "/logs"):
			_ = enc.Encode(map[string]any{"logs": []map[string]any{
				{"id": 1, "job_id": "job-newest", "log_chunk": "tofu plan: 3 to add\n",
					"stream_type": "STDOUT", "created_at": "2026-03-09T12:00:01Z"},
			}})
		case strings.HasSuffix(p, "/cancel"):
			_ = enc.Encode(map[string]any{"ok": true})
		case strings.HasPrefix(p, "/api/cli/jobs/"):
			_ = enc.Encode(jobsCmdJob("job-newest", string(types.JobTypeDeploy), "PROCESSING"))
		default:
			_ = enc.Encode(map[string]any{"ok": true})
		}
	}))
	t.Cleanup(srv.Close)

	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	prevExit := exitFunc
	exitFunc = func(code int) { panic(jobsCmdExit{code: code}) }
	t.Cleanup(func() {
		exitFunc = prevExit
		jobsCmdResetFlags()
	})

	return s, func(args ...string) (code int) {
		defer func() {
			jobsCmdResetFlags()
			if r := recover(); r != nil {
				e, ok := r.(jobsCmdExit)
				if !ok {
					panic(r)
				}
				code = e.code
			}
		}()
		jobsCmdResetFlags()
		execRootArgs(args)
		if err := rootCmd.Execute(); err != nil {
			return 1
		}
		return 0
	}
}

// captureStreams runs fn with both standard streams replaced and returns what each received.
//
// BOTH, because where a line goes is part of the contract here: the tofu output is the document
// and belongs on stdout, while "which job did --latest pick" is a diagnostic and belongs on
// stderr, where a pipe or a `-o json` parse never sees it.
func captureStreams(t *testing.T, fn func()) (stdout, stderr string) {
	t.Helper()
	drain := func(target **os.File) (*os.File, *os.File, chan string) {
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatalf("os.Pipe: %v", err)
		}
		prev := *target
		*target = w
		done := make(chan string, 1)
		go func() {
			var b strings.Builder
			buf := make([]byte, 4096)
			for {
				n, err := r.Read(buf)
				if n > 0 {
					b.Write(buf[:n])
				}
				if err != nil {
					break
				}
			}
			done <- b.String()
		}()
		return prev, w, done
	}
	prevOut, wOut, outCh := drain(&os.Stdout)
	prevErr, wErr, errCh := drain(&os.Stderr)
	fn()
	os.Stdout, os.Stderr = prevOut, prevErr
	_ = wOut.Close()
	_ = wErr.Close()
	return <-outCh, <-errCh
}

// TestJobsCmd_LogsLatestNeedsNoCopiedID is the golden path this unit exists for: tail the job
// you just queued without any id ever leaving the previous command's output.
func TestJobsCmd_LogsLatestNeedsNoCopiedID(t *testing.T) {
	s, run := jobsCmdEnv(t)
	var code int
	out, diag := captureStreams(t, func() { code = run("jobs", "logs", "--latest") })
	if code != 0 {
		t.Fatalf("`jobs logs --latest` exited %d", code)
	}
	if !s.saw(http.MethodGet, "/api/jobs") {
		t.Error("--latest never listed the jobs")
	}
	if !s.saw(http.MethodGet, "/api/cli/jobs/job-newest/logs") {
		t.Error("--latest did not resolve to the newest job's logs")
	}
	if !strings.Contains(out, "tofu plan: 3 to add") {
		t.Errorf("the log chunk was not printed: %q", out)
	}
	// A --latest tail is a wall of tofu output; the command has to say whose — on stderr, so a
	// reader piping the logs into grep still gets only the logs.
	if !strings.Contains(diag, "Deploy") || !strings.Contains(diag, "web") {
		t.Errorf("stderr does not name the job --latest chose: %q", diag)
	}
	if strings.Contains(out, "Deploy ·") {
		t.Errorf("the resolution line landed in the piped log output: %q", out)
	}
}

// TestJobsCmd_LogsWithAnIDSaysNothingExtra pins the other side: an id the user typed is not
// described back at them, so piping the output stays clean.
func TestJobsCmd_LogsWithAnIDSaysNothingExtra(t *testing.T) {
	s, run := jobsCmdEnv(t)
	var code int
	out, diag := captureStreams(t, func() { code = run("jobs", "logs", "job-older") })
	if code != 0 {
		t.Fatalf("`jobs logs <id>` exited %d", code)
	}
	if s.saw(http.MethodGet, "/api/jobs") {
		t.Error("an explicit id still listed the jobs")
	}
	if !strings.Contains(out, "tofu plan: 3 to add") {
		t.Errorf("the log chunk was not printed: %q", out)
	}
	// No resolution line at all — not an empty one. The CLI did not choose this job, so it has
	// nothing to report about how it was chosen.
	if strings.Contains(diag, "Tailing") {
		t.Errorf("an id the user typed produced a resolution line: %q", diag)
	}
	if strings.Contains(out+diag, "Deploy ·") {
		t.Errorf("an id the user typed was described back at them: %q / %q", out, diag)
	}
}

// TestJobsCmd_GetLatestRendersTheCard covers `jobs get --latest`, including the cost row that
// used to be a Go map literal.
func TestJobsCmd_GetLatestRendersTheCard(t *testing.T) {
	_, run := jobsCmdEnv(t)
	var code int
	out, _ := captureStreams(t, func() { code = run("jobs", "get", "--latest", "--output", "csv") })
	if code != 0 {
		t.Fatalf("`jobs get --latest` exited %d", code)
	}
	if !strings.Contains(out, "job-newest") {
		t.Errorf("the card is not the resolved job: %q", out)
	}
	if !strings.Contains(out, "$124.56/mo") {
		t.Errorf("the cost estimate is not rendered as a monthly rate: %q", out)
	}
	if strings.Contains(out, "map[") {
		t.Errorf("a Go map literal reached the terminal: %q", out)
	}
}

// TestJobsCmd_CancelLatestNamesWhatItCancels pins the destructive case. `--yes` skips the
// confirmation, so the only thing that can tell the reader which job was cancelled is the
// command itself.
func TestJobsCmd_CancelLatestNamesWhatItCancels(t *testing.T) {
	s, run := jobsCmdEnv(t)
	var code int
	_, diag := captureStreams(t, func() { code = run("jobs", "cancel", "--latest", "--type", "DEPLOY", "--yes") })
	if code != 0 {
		t.Fatalf("`jobs cancel --latest --yes` exited %d", code)
	}
	if !s.saw(http.MethodPost, "/api/cli/jobs/job-newest/cancel") {
		t.Error("the cancel never reached the resolved job")
	}
	if !strings.Contains(diag, "Deploy") || !strings.Contains(diag, "web") {
		t.Errorf("a --yes cancellation did not name the job it chose: %q", diag)
	}
}

// TestJobsCmd_SelectorRefusalsAreFatal walks every verb that takes a job. A refusal from the
// resolver must reach the fatal path, not be swallowed into a request against job "".
func TestJobsCmd_SelectorRefusalsAreFatal(t *testing.T) {
	verbs := []string{"get", "logs", "cancel"}
	for _, verb := range verbs {
		t.Run(verb+"/unknown type", func(t *testing.T) {
			s, run := jobsCmdEnv(t)
			if code := run("jobs", verb, "--latest", "--type", "NOT_A_TYPE"); code == 0 {
				t.Error("an unknown --type was accepted")
			}
			if s.count() != 0 {
				t.Errorf("the command made %d requests for a value it could refuse offline", s.count())
			}
		})
		t.Run(verb+"/id and latest", func(t *testing.T) {
			_, run := jobsCmdEnv(t)
			if code := run("jobs", verb, "job-older", "--latest"); code == 0 {
				t.Error("an id together with --latest was accepted")
			}
		})
		t.Run(verb+"/no id, no latest, no terminal", func(t *testing.T) {
			s, run := jobsCmdEnv(t)
			if code := run("jobs", verb, "--no-input"); code == 0 {
				t.Error("a scripted invocation with no way to name a job exited 0")
			}
			if s.count() != 0 {
				t.Errorf("the command made %d requests before refusing", s.count())
			}
		})
	}
}

// TestJobsCmd_ListStatusIsValidatedAndUpperCased pins both halves of the `jobs list --status`
// change: a value outside the enum is refused offline, and a value inside it reaches the server
// upper-cased, because the column is compared as text and `success` matches no row.
func TestJobsCmd_ListStatusIsValidatedAndUpperCased(t *testing.T) {
	s, run := jobsCmdEnv(t)
	if code := run("jobs", "list", "--status", "PROCESSNG", "--output", "json"); code == 0 {
		t.Error("a misspelled --status was accepted")
	}
	if s.count() != 0 {
		t.Errorf("the command made %d requests for a status it could refuse offline", s.count())
	}

	s2, run2 := jobsCmdEnv(t)
	if code := run2("jobs", "list", "--status", "success", "--output", "json"); code != 0 {
		t.Fatalf("`jobs list --status success` exited %d", code)
	}
	if !strings.Contains(s2.listQuery, "status=SUCCESS") {
		t.Errorf("the request carried %q, want status=SUCCESS", s2.listQuery)
	}
}
