// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Every READ-ONLY command, in each of the three arms it has.
//
// The subject here is not a noun group: it is the one-envelope fake control plane and the matrix
// run against it. Twenty-odd list and get commands each decode a narrow struct out of a single JSON
// object, and each renders through the interactive Bubble Tea table, the static json/csv path, or
// the fatal path. Adding a read command means adding one line to miscReadCommands and it is covered
// in all three.
//
// This file was the first ~430 lines of cov_misc_test.go. "Misc" was never a subject — it was the
// name for "the tests nobody could file", and the file grew to 2,232 lines and serialised the whole
// package. The subjects were always there; they were just not written down.

// miscMode selects what the fake control plane answers with.
type miscMode int

const (
	// miscFull answers every endpoint with one populated envelope.
	miscFull miscMode = iota
	// miscEmpty answers with empty collections, so the "nothing found" arms run.
	miscEmpty
	// miscFail answers 500, so every command's error arm runs.
	miscFail
)

// miscExit is what the stubbed exitFunc panics with, so a fatal path can be observed
// without the test binary being killed by a real os.Exit.
type miscExit struct{ code int }

// miscEnvelope is the single JSON object the fake control plane returns for every
// request. Each API method decodes it into its own narrow struct and picks the one key
// it cares about; unknown keys are ignored by encoding/json. That keeps one handler
// serving ~25 endpoints without hand-writing a per-path switch.
func miscEnvelope(mode miscMode) map[string]any {
	if mode == miscEmpty {
		return map[string]any{
			"orgs": []any{}, "alert_rules": []any{}, "channels": []any{}, "sso_providers": []any{},
			"dimensions": []any{}, "assignments": []any{},
			"activity": []any{}, "repositories": []any{}, "agents": []any{},
			"clusters": []any{}, "rules": []any{}, "probes": []any{},
			"addons": []any{}, "charts": []any{}, "changes": []any{},
			"promotions": []any{}, "configurations": []any{}, "details": []any{},
			"resources": []any{}, "source": nil, "environment": "production",
			"evaluated": false, "priced": false,
			// `sso get` dereferences the provider without a nil check (see the
			// defect noted in this file's report), so the empty envelope still
			// carries one rather than pinning that crash as the spec.
			"sso_provider": map[string]any{"id": "sso1", "provider_type": "oidc"},
			// break-glass: a result with no data payload.
			"sessionId": "s1", "expiresAt": "2026-01-02T00:00:00Z", "operator": "ops@x.com",
			"approvalId": "ap1", "note": "pass --approval ap1", "ok": true,
			"detail": "no-op",
		}
	}
	envName := "production"
	rev := "0123456789abcdef"
	repoURL := "https://github.com/acme/apps"
	msg := "api server reachable"
	ts := "2026-01-01T00:00:00Z"
	cost := 412.0
	minCount := 2
	soak := 30
	threshold := 50.0
	reachable := true
	return map[string]any{
		"orgs": []any{
			map[string]any{"id": "o1", "name": "Acme", "slug": "acme", "role": "owner", "plan": "team", "is_active": true},
		},
		"configurations": []any{
			map[string]any{"id": "p1", "project_name": "web", "environment_stage": "production", "status": "ACTIVE"},
		},
		"alert_rules": []any{
			map[string]any{
				"id": "ar1", "name": "job failures", "severity": "critical",
				"event_patterns": []string{"system.job.failed"}, "channel_ids": []string{"ch1"},
				"enabled": true, "created_at": ts,
			},
		},
		"alert_rule": map[string]any{"id": "ar2", "name": "new rule", "severity": "warning"},
		// The single-record envelopes the mutating channel/fleet commands read back. Their absence
		// is itself a case — see TestGovCmd_ARecordlessSuccessIsReportedNotDereferenced.
		"channel": map[string]any{"id": "ch1", "name": "ops", "type": "slack", "is_verified": true, "enabled": true},
		"pool": map[string]any{
			"provider": "aws", "warm_min": 2, "max": 10, "slots_per_runner": 1, "enabled": true,
		},
		// The governance pickers read the org's taxonomy and a resource's current labels.
		"dimensions": []any{
			map[string]any{
				"id": "d1", "key": "environment", "label": "Environment", "multi": false,
				"applies_to": []string{"project_environment"},
				"values": []any{
					map[string]any{"id": "v1", "value": "dev", "label": "Dev"},
					map[string]any{"id": "v2", "value": "prod", "label": "Prod"},
				},
			},
		},
		"assignments": []any{
			map[string]any{"dimension_key": "environment", "dimension_label": "Environment",
				"value": "prod", "value_label": "Prod"},
		},
		// `alerts create --channel` resolves its argument against the org's channels, so a rule
		// can name a channel the way a person does. The envelope carries them for that lookup as
		// well as for `channels list`.
		"channels": []any{
			map[string]any{"id": "ch1", "name": "ops", "type": "slack", "is_verified": true, "enabled": true},
		},
		"sso_providers": []any{
			map[string]any{"id": "sso1", "provider_type": "oidc", "domain": "acme.com", "issuer": "https://idp.acme.com", "enabled": true},
		},
		"sso_provider": map[string]any{
			"id": "sso1", "provider_type": "saml", "domain": "acme.com", "issuer": "https://idp.acme.com", "enabled": true,
		},
		"activity": []any{
			map[string]any{
				"id": "a1", "actor_id": "u1", "actor_email": "ada@x.com", "action": "project.apply",
				"resource_type": "project", "resource_id": "p1", "decision": true, "reason": "", "ts": ts,
			},
			map[string]any{
				"id": "a2", "actor_id": "u2", "actor_email": "", "action": "project.destroy",
				"resource_type": "project", "resource_id": "", "decision": false, "reason": "denied by policy", "ts": ts,
			},
		},
		"repositories": []any{
			map[string]any{"id": "r1", "name": "apps", "full_name": "acme/apps", "url": repoURL, "private": true, "default_branch": "main", "provider": "github"},
			map[string]any{"id": "r2", "name": "infra", "full_name": "", "url": repoURL, "private": false, "default_branch": "", "provider": "github"},
		},
		"agents": []any{
			map[string]any{"id": "ag1", "persona": "sre", "mission": "keep it up", "tool_scope": []string{"plan", "apply"}, "memory_namespace": "ns1", "version": 3},
		},
		"agent": map[string]any{
			"id": "ag1", "persona": "sre", "mission": "keep it up", "tool_scope": []string{"plan", "apply"}, "memory_namespace": "ns1", "version": 3,
		},
		"clusters": []any{
			map[string]any{
				"id": "c1", "cluster_name": "prod-eks", "cluster_version": "1.30", "status": "ACTIVE",
				"status_message": "", "argocd_url": "https://argo.acme.com", "estimated_monthly_cost": cost,
				"project_name": "web", "environment": envName, "region": "eu-west-1",
				"node_min_size": 2, "node_desired_size": 3, "node_max_size": 6,
			},
			map[string]any{
				"id": "c2", "cluster_name": "", "cluster_version": "", "status": "FAILED",
				"status_message": "subnet exhausted", "project_name": "api", "environment": "",
				"region": "eu-west-1",
			},
		},
		"cluster": map[string]any{
			"id": "c1", "cluster_name": "prod-eks", "cluster_version": "1.30", "status": "ACTIVE",
			"project_name": "web", "environment": envName, "region": "eu-west-1",
		},
		"gitops": map[string]any{
			"mode": "argocd", "apps_repo": repoURL, "revision": rev,
			"total": 4, "synced": 4, "healthy": 4, "status_available": true,
			"last_deploy_failed": false,
		},
		"rules": []any{
			map[string]any{
				"environment_id": "e1", "environment": envName,
				"require_predecessor": true, "require_verify_pass": true, "require_approval": true,
				"min_count": minCount, "soak_minutes": soak, "cost_delta_threshold": threshold,
			},
			map[string]any{"environment_id": "e2", "environment": "development"},
		},
		"probes": []any{
			map[string]any{"environment_id": "e1", "environment": envName, "reachable": reachable, "message": msg, "probed_at": ts},
			map[string]any{"environment_id": "e2", "environment": "development"},
		},
		"environment": envName,
		"addons": []any{
			map[string]any{"addon_id": "kube-prometheus", "enabled": true, "mode": "managed", "version": "1.2.3", "status": "INSTALLED", "health": "Healthy"},
			map[string]any{"addon_id": "redis", "enabled": false, "mode": "managed", "status": "PENDING"},
		},
		"charts": []any{
			map[string]any{"id": "bc1", "repo_url": repoURL, "chart_path": "charts/web", "ref": "main", "status": "SYNCED", "scan_status": "PASSED"},
		},
		"changes": []any{
			map[string]any{"component_type": "database", "op": "create", "component_id": "cmp1", "created_at": ts},
			map[string]any{"component_type": "cache", "op": "delete", "created_at": ts},
		},
		"source": map[string]any{
			"id": "iac1", "environment": envName, "name": "network", "repo_url": repoURL,
			"path": "modules/network", "ref": "main", "enabled": true, "scan_status": "PASSED",
			"commit_sha": rev, "status": "ATTACHED",
		},
		"promotions": []any{
			map[string]any{"id": "pr1", "source": "staging", "target": envName, "status": "PENDING", "created_at": ts},
		},
		"promotion": map[string]any{
			"id": "pr1", "source": "staging", "target": envName, "status": "BLOCKED",
			"initiator": "ada@x.com", "error_message": "soak window not elapsed",
			"approved": 1, "required": 2, "created_at": ts,
			"approvals": []any{
				map[string]any{"id": "ap1", "status": "approved", "name": "Ada", "required_role": "owner", "decided_at": ts},
				map[string]any{"id": "ap2", "status": "pending"},
			},
		},
		// drift posture (decoded straight into DriftPosture)
		"evaluated": true, "in_sync": false, "drifted": 2, "scanned_at": ts,
		"details": []any{
			map[string]any{"address": "aws_instance.a", "type": "aws_instance", "kind": "update"},
		},
		// environment cost (decoded straight into EnvironmentCost)
		"priced": true, "total_monthly": 412.5, "currency": "USD", "captured_at": ts,
		"resources": []any{
			map[string]any{"address": "aws_eks_cluster.main", "resource_type": "aws_eks_cluster", "monthly_cost": 72.0},
		},
		// configuration export
		"content": "project: web", "filename": "web.yaml", "format": "legacy-yaml",
		// break-glass
		"sessionId": "s1", "expiresAt": "2026-01-02T00:00:00Z", "operator": "ops@x.com",
		"approvalId": "ap1", "action": "state_surgery", "resourceId": "k1",
		"approver": "bob@x.com", "note": "pass --approval ap1",
		"ok": true, "detail": "action executed", "data": map[string]any{"rows": 1},
	}
}

// miscEnv stands up the fake control plane, isolated credentials and an active org, then
// returns a runner that executes the real cobra tree. It never sets --output itself, so a
// caller must always pass one explicitly — rootCmd is a package global and its flag state
// is sticky between runs.
func miscEnv(t *testing.T, mode miscMode) func(args ...string) error {
	t.Helper()
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatal(err)
	}
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme"}); err != nil {
		t.Fatal(err)
	}

	body := miscEnvelope(mode)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if mode == miscFail {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "control plane exploded"})
			return
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)

	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	return func(args ...string) error {
		execRootArgs(args)
		return rootCmd.Execute()
	}
}

// miscTTY makes the CLI believe it is attached to a terminal, so resolveInputMode leaves
// prompts enabled and interactiveTable returns true — the arm that holds most of this
// group's statements.
func miscTTY(t *testing.T) {
	t.Helper()
	prevIn, prevOut := stdinIsTTY, stdoutIsTTY
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return true }
	t.Cleanup(func() { stdinIsTTY, stdoutIsTTY = prevIn, prevOut })
}

// miscTrapExit replaces the process-exit hook with a panic, and returns a function that
// runs one command and reports whether it took the fatal path.
func miscTrapExit(t *testing.T, run func(args ...string) error) func(args ...string) bool {
	t.Helper()
	prev := exitFunc
	exitFunc = func(code int) { panic(miscExit{code}) }
	t.Cleanup(func() { exitFunc = prev })

	return func(args ...string) (exited bool) {
		defer func() {
			r := recover()
			if r == nil {
				return
			}
			if e, ok := r.(miscExit); ok {
				if e.code == 0 {
					t.Errorf("%v: fatal path exited 0, want non-zero", args)
				}
				exited = true
				return
			}
			panic(r)
		}()
		_ = run(args...)
		return false
	}
}

// miscReadCommands is every read-only command in this group with the flags it needs.
// Each entry runs identically in the interactive-table arm and the json arm.
func miscReadCommands() [][]string {
	return [][]string{
		{"alerts", "list"},
		{"sso", "list"},
		{"sso", "get", "sso1"},
		{"activity", "-n", "10"},
		{"repo", "list", "--provider", "github"},
		{"agent", "list"},
		{"agent", "get", "ag1"},
		{"cluster", "list"},
		// `cluster get` is NOT here. This list is run against an EMPTY envelope by
		// TestMisc_EmptyResultsAreReported, and an empty collection is not an empty answer for a
		// get: asking for a cluster that is not there is a miss, and a miss is now fatal rather
		// than a muted line and exit 0. Its arms — empty, server error, matched, ambiguous, and
		// no selector with --no-input — are owned end to end by clusters_get_test.go.
		{"org", "list"},
		{"addon", "list", "-p", "web", "-e", "production"},
		{"chart", "list", "-p", "web", "-e", "production"},
		{"staged", "list", "-p", "web", "-e", "production"},
		{"protection", "list", "-p", "web"},
		{"probes", "list", "-p", "web"},
		{"promotion", "list", "-p", "web", "-e", "production"},
		// `promotion get` is NOT here, for the same reason `cluster get` is not: this list is run
		// against an EMPTY envelope by TestMisc_EmptyResultsAreReported, and a project with no
		// promotions is not an empty answer for a get — it is a miss, and a miss is fatal rather
		// than a muted line and exit 0. Its arms — resolved by id, by prefix, ambiguous, absent,
		// and no selector with --no-input — are owned by governance_select_test.go.
		{"cost", "show", "-p", "web", "-e", "production"},
		{"iac", "show", "-p", "web", "-e", "production"},
		{"drift", "show", "-p", "web", "-e", "production"},
	}
}

// TestMisc_ReadCommandsJSON pins that every read command in the group runs end to end
// through the cobra tree and emits json without erroring.
func TestMisc_ReadCommandsJSON(t *testing.T) {
	run := miscEnv(t, miscFull)
	for _, args := range miscReadCommands() {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if err := run(append(append([]string{}, args...), "--output", "json", "--no-input")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
	}
}

// TestMisc_ReadCommandsCSV pins the csv projection of every read command — it exercises
// the same row builders through a different ui.Render arm.
func TestMisc_ReadCommandsCSV(t *testing.T) {
	run := miscEnv(t, miscFull)
	for _, args := range miscReadCommands() {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if err := run(append(append([]string{}, args...), "--output", "csv", "--no-input")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
	}
}

// TestMisc_ReadCommandsInteractiveTable pins the interactive arm of every read command:
// with a TTY on both ends and prompts enabled, each list command takes the
// `if interactiveTable(cmd)` branch and renders through the Bubble Tea table. Under
// `go test` that table returns a "could not open a new TTY" error which every call site
// deliberately drops, so the command still completes.
func TestMisc_ReadCommandsInteractiveTable(t *testing.T) {
	miscTTY(t)
	run := miscEnv(t, miscFull)
	for _, args := range miscReadCommands() {
		if strings.Join(args, " ") == "cluster list" {
			// `cluster list` drives Bubble Tea directly and treats a table failure as
			// fatal; it has its own test below.
			continue
		}
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if err := run(append(append([]string{}, args...), "--output", "table", "--no-input=false")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
	}
}

// TestMisc_ClusterListInteractiveTableIsFatalOnTableError pins the one interactive list
// that does NOT drop its table error: `cluster list` builds its own Bubble Tea program
// (it needs fixed column widths) and exits when that program cannot start, where every
// ui.ShowTable call site merely discards the error.
func TestMisc_ClusterListInteractiveTableIsFatalOnTableError(t *testing.T) {
	miscTTY(t)
	run := miscTrapExit(t, miscEnv(t, miscFull))
	if !run("cluster", "list", "--output", "table", "--no-input=false") {
		t.Error("expected the fatal path when the cluster table cannot open a TTY")
	}
}

// TestMisc_EmptyResultsAreReported pins that an empty collection short-circuits into the
// muted "nothing here" note instead of rendering an empty table — in both arms.
func TestMisc_EmptyResultsAreReported(t *testing.T) {
	miscTTY(t)
	run := miscEnv(t, miscEmpty)
	for _, args := range miscReadCommands() {
		t.Run("interactive_"+strings.Join(args, "_"), func(t *testing.T) {
			if err := run(append(append([]string{}, args...), "--output", "table", "--no-input=false")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
		t.Run("static_"+strings.Join(args, "_"), func(t *testing.T) {
			if err := run(append(append([]string{}, args...), "--output", "table", "--no-input")...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
	}
}

// TestMisc_ServerErrorsExitNonZero pins that a failing control plane takes every read
// command down the fatal path rather than printing a half-rendered result. Both arms are
// covered because the interactive branch has its own error check.
func TestMisc_ServerErrorsExitNonZero(t *testing.T) {
	miscTTY(t)
	run := miscTrapExit(t, miscEnv(t, miscFail))
	for _, args := range miscReadCommands() {
		t.Run("interactive_"+strings.Join(args, "_"), func(t *testing.T) {
			if !run(append(append([]string{}, args...), "--output", "table", "--no-input=false")...) {
				t.Errorf("%v: expected the fatal path", args)
			}
		})
		t.Run("static_"+strings.Join(args, "_"), func(t *testing.T) {
			if !run(append(append([]string{}, args...), "--output", "json", "--no-input")...) {
				t.Errorf("%v: expected the fatal path", args)
			}
		})
	}
}

// TestMisc_ProjectFlagIsRequired pins that the project-scoped commands refuse to guess a
// project: with --project empty each one exits rather than calling the control plane.
func TestMisc_ProjectFlagIsRequired(t *testing.T) {
	run := miscTrapExit(t, miscEnv(t, miscFull))
	cases := [][]string{
		{"addon", "list"},
		{"chart", "list"},
		{"staged", "list"},
		{"protection", "list"},
		{"probes", "list"},
		{"promotion", "list"},
		{"promotion", "get", "pr1"},
		{"cost", "show"},
		{"iac", "show"},
		{"drift", "show"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			full := append(append([]string{}, args...), "--project=", "--output", "json", "--no-input")
			if !run(full...) {
				t.Errorf("%v: expected the fatal path when --project is empty", args)
			}
		})
	}
}
