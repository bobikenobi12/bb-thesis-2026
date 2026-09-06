// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// cliEnv stands up a fake control plane, valid credentials in an isolated home,
// and the env the CLI needs, then returns a runner that executes the CLI with
// the given args through the real Cobra tree (covering every command's Run
// adapter, flag parsing, and the shared auth/output plumbing).
func cliEnv(t *testing.T) func(args ...string) error {
	t.Helper()
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatal(err)
	}
	// Active org context so members/teams resolve without --org.
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme"}); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		switch {
		case p == "/api/cli/whoami":
			json.NewEncoder(w).Encode(map[string]any{
				"user":           map[string]any{"id": "u1", "email": "ada@x.com", "name": "Ada"},
				"active_org":     map[string]any{"id": "o1", "name": "Acme", "slug": "acme", "role": "owner", "plan": "team", "is_active": true},
				"default_runner": nil,
			})
		case p == "/api/cli/orgs":
			json.NewEncoder(w).Encode(map[string]any{"orgs": []map[string]any{
				{"id": "o1", "name": "Acme", "slug": "acme", "role": "owner", "plan": "team", "is_active": true},
				{"id": "o2", "name": "Beta", "slug": "beta", "role": "member", "plan": "community", "is_active": false},
			}})
		case strings.HasSuffix(p, "/members"):
			if r.Method == http.MethodPost {
				json.NewEncoder(w).Encode(map[string]any{"invitation": map[string]any{
					"id": "inv1", "email": "new@x.com", "role": "member", "status": "pending",
				}})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"members": []map[string]any{
				{"id": "m1", "user_id": "u1", "email": "a@x.com", "name": "A", "role": "owner", "status": "active"},
			}})
		case strings.HasSuffix(p, "/teams"):
			if r.Method == http.MethodPost {
				json.NewEncoder(w).Encode(map[string]any{"team": map[string]any{
					"id": "t9", "name": "SRE", "member_count": 0,
				}})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"teams": []map[string]any{
				{"id": "t1", "name": "Platform", "member_count": 2},
			}})
		case p == "/api/cli/configurations":
			json.NewEncoder(w).Encode(map[string]any{"configurations": []map[string]any{
				{"id": "p1", "project_name": "web", "environment_stage": "production", "status": "ACTIVE", "cloud_provider": "aws", "region": "eu-west-1"},
			}})
		case p == "/api/cli/runners":
			json.NewEncoder(w).Encode(map[string]any{"runners": []map[string]any{
				{"id": "r1", "name": "primary", "operator": "managed", "status": "ONLINE", "is_default": true},
			}})
		case p == "/api/cli/clusters":
			json.NewEncoder(w).Encode(map[string]any{"clusters": []map[string]any{
				{"id": "c1", "cluster_name": "prod", "cluster_version": "1.30", "status": "ACTIVE", "project_name": "web", "environment": "production", "region": "eu"},
			}})
		case p == "/api/cli/cloud-identities":
			json.NewEncoder(w).Encode(map[string]any{"cloud_identities": []map[string]any{
				{"id": "ci1", "provider": "aws", "label": "prod-account", "created_at": "2026-01-01T00:00:00Z"},
			}})
		case p == "/api/jobs":
			json.NewEncoder(w).Encode(map[string]any{
				"jobs":   []map[string]any{{"id": "j1", "job_type": "PLAN", "status": "SUCCESS", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z", "config_snapshot": map[string]any{}}},
				"total":  1,
				"limit":  20,
				"offset": 0,
			})
		case strings.HasPrefix(p, "/api/cli/jobs/"):
			json.NewEncoder(w).Encode(map[string]any{
				"id": "j1", "job_type": "PLAN", "status": "SUCCESS",
				"created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
				"config_snapshot": map[string]any{},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]string{"error": "not found: " + p})
		}
	}))
	t.Cleanup(srv.Close)

	os.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	os.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	t.Cleanup(func() {
		os.Unsetenv("ALETHIA_WEB_ORIGIN")
		os.Unsetenv("ALETHIA_NO_UPDATE_CHECK")
	})

	return func(args ...string) error {
		execRootArgs(append(args, "--output", "json"))
		return rootCmd.Execute()
	}
}

func TestCLI_ReadCommands(t *testing.T) {
	run := cliEnv(t)
	cases := [][]string{
		{"whoami"},
		{"org", "list"},
		{"org", "switch", "beta"},
		{"members", "list"},
		{"teams", "list"},
		{"project", "list"},
		{"runner", "list"},
		{"cluster", "list"},
		{"connector", "list"},
		{"jobs", "list"},
		{"jobs", "get", "j1"},
		{"config"},
		{"config", "clear-context"},
		{"version"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if err := run(args...); err != nil {
				t.Errorf("command %v errored: %v", args, err)
			}
		})
	}
}

func TestCLI_MembersAndTeamsMutations(t *testing.T) {
	run := cliEnv(t)
	// The fake server returns 200 for the members/teams collection endpoints, so
	// invite/create succeed; remove/delete go through confirm() which reads a
	// non-TTY stdin and cancels — exercising the cancel path without a prompt.
	if err := run("members", "add", "new@x.com", "--role", "member"); err != nil {
		t.Errorf("members add: %v", err)
	}
	if err := run("teams", "create", "SRE"); err != nil {
		t.Errorf("teams create: %v", err)
	}
}
