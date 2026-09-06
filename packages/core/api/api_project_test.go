// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// --- CreateProject ---

func TestCreateProject_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/projects" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["project_name"] != "api" || body["region"] != "eu-west-1" {
			t.Errorf("unexpected body: %+v", body)
		}
		if body["cloud_identity_id"] != "ci1" {
			t.Errorf("expected cloud_identity_id in body: %+v", body)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"project": map[string]any{
				"id": "p1", "project_name": "api", "slug": "api", "region": "eu-west-1",
				"iac_version": "1.11.4", "cloud_identity_id": "ci1", "cloud_provider": "aws",
				"environment_stage": "development", "status": "DRAFT",
				"estimated_monthly_cost": nil,
				"created_at":             "2026-01-01T00:00:00.000Z",
				"updated_at":             "2026-01-01T00:00:00.000Z",
			},
		})
	}))
	p, err := client.CreateProject(CreateProjectParams{
		ProjectName: "api", Region: "eu-west-1", CloudIdentityID: "ci1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.ID != "p1" || p.Slug != "api" || p.CloudProvider != "aws" {
		t.Errorf("unexpected project: %+v", p)
	}
}

func TestCreateProject_Error(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "bad"})
	}))
	if _, err := client.CreateProject(CreateProjectParams{ProjectName: "x", Region: "y"}); err == nil {
		t.Fatal("expected error")
	}
}

// --- Environments ---

func TestListEnvironments_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/api/environments" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"environments": []map[string]any{
				{"id": "e1", "name": "development", "stage": "development", "status": "DRAFT", "is_default": true, "region": nil},
			},
		})
	}))
	envs, err := client.ListEnvironments("api")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(envs) != 1 || !envs[0].IsDefault || envs[0].Region != nil {
		t.Errorf("unexpected envs: %+v", envs)
	}
}

func TestAddEnvironment_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/projects/api/environments" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "staging" || body["stage"] != "staging" {
			t.Errorf("unexpected body: %+v", body)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"environment": map[string]any{
				"id": "e2", "name": "staging", "stage": "staging", "status": "DRAFT",
				"is_default": false, "region": "us-east-1",
			},
		})
	}))
	env, err := client.AddEnvironment(AddEnvironmentParams{Project: "api", Name: "staging", Stage: "staging"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if env.ID != "e2" || env.Region == nil || *env.Region != "us-east-1" {
		t.Errorf("unexpected env: %+v", env)
	}
}

// --- Components ---

func TestListComponents_Filtered(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/api/components" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("kind") != "databases" {
			t.Errorf("expected kind=databases, got %q", r.URL.Query().Get("kind"))
		}
		json.NewEncoder(w).Encode(map[string]any{
			"components": []map[string]any{
				{"id": "c1", "kind": "databases", "name": "main", "status": "PENDING",
					"cloud_identity_id": nil, "config": map[string]any{"engine": "postgres"}},
			},
		})
	}))
	comps, err := client.ListComponents("api", "databases", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(comps) != 1 || comps[0].Config["engine"] != "postgres" || comps[0].CloudIdentityID != nil {
		t.Errorf("unexpected components: %+v", comps)
	}
}

func TestListComponents_WalksAllPagesWithFilters(t *testing.T) {
	var requests int
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		requests++
		if r.URL.Path != "/api/cli/projects/api/components" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("kind") != "databases" || r.URL.Query().Get("env") != "production" {
			t.Errorf("filters were not preserved on request %d: %q", requests, r.URL.RawQuery)
		}
		if requests == 1 {
			if cursor := r.URL.Query().Get("cursor"); cursor != "" {
				t.Errorf("first request carried cursor %q", cursor)
			}
			json.NewEncoder(w).Encode(map[string]any{
				"components": []map[string]any{{"id": "c1", "kind": "databases", "name": "first", "status": "ACTIVE", "cloud_identity_id": nil, "config": map[string]any{}}},
				"page":       map[string]any{"mode": "exact", "limit": 1, "total": 2, "next_cursor": "next-components"},
			})
			return
		}
		if cursor := r.URL.Query().Get("cursor"); cursor != "next-components" {
			t.Errorf("second request carried cursor %q", cursor)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"components": []map[string]any{{"id": "c2", "kind": "databases", "name": "second", "status": "ACTIVE", "cloud_identity_id": nil, "config": map[string]any{}}},
			"page":       map[string]any{"mode": "exact", "limit": 1, "total": 2, "next_cursor": nil},
		})
	}))

	components, err := client.ListComponents("api", "databases", "production")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if requests != 2 {
		t.Fatalf("expected two page requests, got %d", requests)
	}
	if len(components) != 2 || components[0].ID != "c1" || components[1].ID != "c2" {
		t.Errorf("pages were not accumulated in order: %+v", components)
	}
}

func TestListComponents_PageErrorReturnsNoPartialRows(t *testing.T) {
	var requests int
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if requests == 1 {
			json.NewEncoder(w).Encode(map[string]any{
				"components": []map[string]any{{"id": "c1", "kind": "cluster", "name": "cluster", "status": "ACTIVE", "cloud_identity_id": nil, "config": map[string]any{}}},
				"page":       map[string]any{"mode": "exact", "limit": 1, "total": 2, "next_cursor": "next-components"},
			})
			return
		}
		http.Error(w, "page failed", http.StatusInternalServerError)
	}))

	components, err := client.ListComponents("api", "", "")
	if err == nil || !strings.Contains(err.Error(), "paging: page 2") || !strings.Contains(err.Error(), "failed to list components") {
		t.Fatalf("expected named second-page error, got %v", err)
	}
	if components != nil {
		t.Errorf("partial rows escaped with an error: %+v", components)
	}
}

func TestAddComponent_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "POST" || r.URL.Path != "/api/cli/projects/api/components/databases" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]interface{}
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "main" {
			t.Errorf("unexpected name: %+v", body)
		}
		fields, _ := body["fields"].(map[string]interface{})
		if fields["engine"] != "postgres" {
			t.Errorf("unexpected fields: %+v", fields)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"component": map[string]any{
				"id": "c1", "kind": "databases", "name": "main", "status": "PENDING",
				"cloud_identity_id": nil, "config": map[string]any{},
			},
		})
	}))
	comp, err := client.AddComponent("api", "databases", "main", "", map[string]interface{}{"engine": "postgres"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if comp.ID != "c1" || comp.Kind != "databases" {
		t.Errorf("unexpected component: %+v", comp)
	}
}

func TestRemoveComponent_Singleton(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		// Singleton: no name segment.
		if r.Method != "DELETE" || r.URL.Path != "/api/cli/projects/api/components/network" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	if err := client.RemoveComponent("api", "network", "", ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRemoveComponent_Named(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.Method != "DELETE" || r.URL.Path != "/api/cli/projects/api/components/databases/main" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	if err := client.RemoveComponent("api", "databases", "main", ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// The env query param is the whole point of the component write path: without it the CLI can only
// author into the project's default environment, so a two-tier project (dev and staging pointing at
// different overlays) cannot be expressed from the terminal at all. These pin BOTH halves — that a
// named environment travels, and that an empty one adds no parameter, so a single-environment script
// keeps hitting the server's default-environment path byte for byte.
func TestComponentWrites_CarryTheEnvParam(t *testing.T) {
	cases := []struct {
		name      string
		env       string
		wantQuery string
	}{
		{"named environment travels", "staging", "env=staging"},
		{"a name needing escaping is encoded", "my env/1", "env=my+env%2F1"},
		{"empty adds no parameter", "", ""},
		{"whitespace-only is treated as empty", "   ", ""},
	}
	for _, tc := range cases {
		t.Run("add/"+tc.name, func(t *testing.T) {
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if got := r.URL.RawQuery; got != tc.wantQuery {
					t.Errorf("query = %q, want %q", got, tc.wantQuery)
				}
				w.WriteHeader(http.StatusCreated)
				json.NewEncoder(w).Encode(map[string]any{"component": map[string]any{
					"id": "c1", "kind": "databases", "name": "main", "status": "PENDING",
					"cloud_identity_id": nil, "config": map[string]any{},
				}})
			}))
			if _, err := client.AddComponent("api", "databases", "main", tc.env, nil); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
		t.Run("remove/"+tc.name, func(t *testing.T) {
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if got := r.URL.RawQuery; got != tc.wantQuery {
					t.Errorf("query = %q, want %q", got, tc.wantQuery)
				}
				// The name segment must survive the query append — a naive concatenation would put
				// the parameter before it.
				if r.URL.Path != "/api/cli/projects/api/components/databases/main" {
					t.Errorf("path = %q", r.URL.Path)
				}
				json.NewEncoder(w).Encode(map[string]bool{"ok": true})
			}))
			if err := client.RemoveComponent("api", "databases", "main", tc.env); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestByoChartClient(t *testing.T) {
	t.Run("attach posts every field and returns the resolved id", func(t *testing.T) {
		var got map[string]interface{}
		var query string
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assertAuth(t, r)
			query = r.URL.RawQuery
			json.NewDecoder(r.Body).Decode(&got)
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "id": "api"})
		}))
		res, err := client.AttachChart(AttachChartParams{
			Project: "shop", Env: "dev", ID: "API!", RepoURL: "https://github.com/acme/charts",
			ChartPath: "charts/api", Ref: "v1", Namespace: "api",
			ValuesYAML: "a: b\n", GitCredID: "cred-1",
			Values: map[string]interface{}{"replicas": 2},
		})
		if err != nil {
			t.Fatalf("AttachChart: %v", err)
		}
		if query != "env=dev" {
			t.Errorf("query = %q", query)
		}
		// The server slugifies, so the RESOLVED id is what a caller must get back.
		if res.ID != "api" || !res.OK {
			t.Errorf("unexpected result: %+v", res)
		}
		for k, want := range map[string]string{
			"repo_url": "https://github.com/acme/charts", "chart_path": "charts/api",
			"ref": "v1", "namespace": "api", "values_yaml": "a: b\n", "git_credential_id": "cred-1",
		} {
			if got[k] != want {
				t.Errorf("%s = %v, want %q", k, got[k], want)
			}
		}
	})

	t.Run("attach omits every empty optional", func(t *testing.T) {
		var got map[string]interface{}
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			json.NewDecoder(r.Body).Decode(&got)
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "id": "api"})
		}))
		if _, err := client.AttachChart(AttachChartParams{Project: "s", ID: "api", RepoURL: "oci://r/x"}); err != nil {
			t.Fatalf("AttachChart: %v", err)
		}
		for _, k := range []string{"chart_path", "ref", "namespace", "values_yaml", "git_credential_id", "values"} {
			if _, present := got[k]; present {
				t.Errorf("%q must be omitted when unset: %+v", k, got)
			}
		}
	})

	t.Run("detach DELETEs with the id in the body", func(t *testing.T) {
		var got map[string]interface{}
		var method string
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			method = r.Method
			json.NewDecoder(r.Body).Decode(&got)
			json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		}))
		if err := client.DetachChart("shop", "dev", "api"); err != nil {
			t.Fatalf("DetachChart: %v", err)
		}
		if method != "DELETE" || got["id"] != "api" {
			t.Errorf("got %s %+v", method, got)
		}
	})

	t.Run("scan posts to the scan path and returns the job", func(t *testing.T) {
		var path string
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path = r.URL.Path
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "job_id": "job-1"})
		}))
		res, err := client.ScanChart("shop", "", "api")
		if err != nil {
			t.Fatalf("ScanChart: %v", err)
		}
		if !strings.HasSuffix(path, "/byo-charts/scan") || res.JobID != "job-1" {
			t.Errorf("path %q result %+v", path, res)
		}
	})

	t.Run("all three surface a server error", func(t *testing.T) {
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotImplemented)
			json.NewEncoder(w).Encode(map[string]string{"error": "not enabled"})
		}))
		if _, err := client.AttachChart(AttachChartParams{Project: "s", ID: "a", RepoURL: "https://x"}); err == nil {
			t.Error("attach")
		}
		if err := client.DetachChart("s", "", "a"); err == nil {
			t.Error("detach")
		}
		if _, err := client.ScanChart("s", "", "a"); err == nil {
			t.Error("scan")
		}
	})
}

func TestByoIacClient(t *testing.T) {
	t.Run("attach posts every field", func(t *testing.T) {
		var got map[string]interface{}
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assertAuth(t, r)
			json.NewDecoder(r.Body).Decode(&got)
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "id": "iac-1"})
		}))
		res, err := client.AttachIac(AttachIacParams{
			Project: "shop", Env: "dev", RepoURL: "https://github.com/acme/infra",
			Ref: "main", Path: "iac/aws", GitCredID: "cred-1",
			VarValues: map[string]interface{}{"region": "eu-west-1"},
		})
		if err != nil {
			t.Fatalf("AttachIac: %v", err)
		}
		if res.ID != "iac-1" {
			t.Errorf("unexpected result: %+v", res)
		}
		if got["repo_url"] == nil || got["ref"] != "main" || got["path"] != "iac/aws" {
			t.Errorf("unexpected body: %+v", got)
		}
		if _, ok := got["var_values"].(map[string]interface{}); !ok {
			t.Errorf("var_values missing: %+v", got)
		}
	})

	t.Run("attach omits every empty optional", func(t *testing.T) {
		var got map[string]interface{}
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			json.NewDecoder(r.Body).Decode(&got)
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "id": "i"})
		}))
		if _, err := client.AttachIac(AttachIacParams{Project: "s", RepoURL: "https://x"}); err != nil {
			t.Fatalf("AttachIac: %v", err)
		}
		for _, k := range []string{"ref", "path", "git_credential_id", "var_values"} {
			if _, present := got[k]; present {
				t.Errorf("%q must be omitted when unset: %+v", k, got)
			}
		}
	})

	t.Run("detach DELETEs with no body", func(t *testing.T) {
		var method string
		var length int64
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			method, length = r.Method, r.ContentLength
			json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		}))
		if err := client.DetachIac("shop", "dev"); err != nil {
			t.Fatalf("DetachIac: %v", err)
		}
		// The environment is the whole address — an environment holds at most one source.
		if method != "DELETE" || length > 0 {
			t.Errorf("got %s with %d bytes", method, length)
		}
	})

	t.Run("scan posts to the scan path", func(t *testing.T) {
		var path string
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path = r.URL.Path
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "job_id": "job-2"})
		}))
		res, err := client.ScanIac("shop", "dev")
		if err != nil {
			t.Fatalf("ScanIac: %v", err)
		}
		if !strings.HasSuffix(path, "/byo-iac/scan") || res.JobID != "job-2" {
			t.Errorf("path %q result %+v", path, res)
		}
	})

	t.Run("all three surface a server error", func(t *testing.T) {
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]string{"error": "template state"})
		}))
		if _, err := client.AttachIac(AttachIacParams{Project: "s", RepoURL: "https://x"}); err == nil {
			t.Error("attach")
		}
		if err := client.DetachIac("s", ""); err == nil {
			t.Error("detach")
		}
		if _, err := client.ScanIac("s", ""); err == nil {
			t.Error("scan")
		}
	})

	// doDeleteWithBody's transport arm, which no other test reaches.
	t.Run("detachChart surfaces a transport error", func(t *testing.T) {
		client := NewClient("t")
		client.baseURL = "http://127.0.0.1:1/api"
		if err := client.DetachChart("s", "", "a"); err == nil {
			t.Fatal("expected a transport error")
		}
	})
}

func TestEnableAddon(t *testing.T) {
	t.Run("posts every field and carries env", func(t *testing.T) {
		var got map[string]interface{}
		var query, method string
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assertAuth(t, r)
			method, query = r.Method, r.URL.RawQuery
			json.NewDecoder(r.Body).Decode(&got)
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]any{"ok": true})
		}))
		err := client.EnableAddon(EnableAddonParams{
			Project: "shop", Env: "staging", AddonID: "loki", Mode: "managed",
			Values:     map[string]interface{}{"retention_days": 7},
			ValuesYAML: "loki:\n  auth_enabled: false\n",
		})
		if err != nil {
			t.Fatalf("EnableAddon: %v", err)
		}
		if method != "POST" || query != "env=staging" {
			t.Errorf("got %s ?%s", method, query)
		}
		if got["addon_id"] != "loki" || got["mode"] != "managed" {
			t.Errorf("unexpected body: %+v", got)
		}
		if _, ok := got["values"].(map[string]interface{}); !ok {
			t.Errorf("values missing: %+v", got)
		}
		if got["values_yaml"] == nil {
			t.Errorf("values_yaml missing: %+v", got)
		}
	})

	// The optional fields must be OMITTED when unset, so the server's own defaults apply rather than
	// an empty string failing its enum.
	t.Run("omits the optional fields", func(t *testing.T) {
		var got map[string]interface{}
		var query string
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			query = r.URL.RawQuery
			json.NewDecoder(r.Body).Decode(&got)
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]any{"ok": true})
		}))
		if err := client.EnableAddon(EnableAddonParams{Project: "shop", AddonID: "loki"}); err != nil {
			t.Fatalf("EnableAddon: %v", err)
		}
		if query != "" {
			t.Errorf("an empty env must add no query, got %q", query)
		}
		for _, k := range []string{"mode", "values", "values_yaml"} {
			if _, present := got[k]; present {
				t.Errorf("%q must be omitted when unset: %+v", k, got)
			}
		}
	})

	t.Run("surfaces a server error", func(t *testing.T) {
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "unknown add-on"})
		}))
		if err := client.EnableAddon(EnableAddonParams{Project: "p", AddonID: "nope"}); err == nil {
			t.Fatal("expected an error")
		}
	})
}

func TestApplyDesign(t *testing.T) {
	doc := json.RawMessage(`{"project":{"project_name":"shop"}}`)

	t.Run("posts the document verbatim", func(t *testing.T) {
		var body []byte
		var query string
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assertAuth(t, r)
			body, _ = io.ReadAll(r.Body)
			query = r.URL.RawQuery
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "mode": "applied", "changes": []any{}})
		}))
		res, err := client.ApplyDesign(ApplyDesignParams{Project: "shop", Env: "dev", Document: doc})
		if err != nil {
			t.Fatalf("ApplyDesign: %v", err)
		}
		// Verbatim: the server validates the shape with the console form's own schema, so the CLI must
		// not reshape or re-serialize it on the way through.
		if strings.TrimSpace(string(body)) != string(doc) {
			t.Errorf("document altered:\n got %s\nwant %s", body, doc)
		}
		if query != "env=dev" || res.Mode != "applied" {
			t.Errorf("query %q mode %q", query, res.Mode)
		}
	})

	t.Run("the mode flags become query params", func(t *testing.T) {
		for _, tc := range []struct {
			name   string
			params ApplyDesignParams
			want   []string
		}{
			{"dry run with an env", ApplyDesignParams{Project: "p", Env: "dev", Document: doc, DryRun: true}, []string{"env=dev", "dry_run=1"}},
			{"dry run with no env", ApplyDesignParams{Project: "p", Document: doc, DryRun: true}, []string{"dry_run=1"}},
			{"stage with no env", ApplyDesignParams{Project: "p", Document: doc, Stage: true}, []string{"stage=1"}},
			{"both", ApplyDesignParams{Project: "p", Env: "dev", Document: doc, DryRun: true, Stage: true}, []string{"env=dev", "dry_run=1", "stage=1"}},
		} {
			t.Run(tc.name, func(t *testing.T) {
				var query string
				client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					query = r.URL.RawQuery
					json.NewEncoder(w).Encode(map[string]any{"ok": true, "mode": "dry-run", "changes": []any{}})
				}))
				if _, err := client.ApplyDesign(tc.params); err != nil {
					t.Fatalf("ApplyDesign: %v", err)
				}
				for _, want := range tc.want {
					if !strings.Contains(query, want) {
						t.Errorf("query %q missing %q", query, want)
					}
				}
				// The separators must be well-formed however many params there are — this is where a
				// hand-built query string usually goes wrong.
				if strings.Contains(query, "??") || strings.Contains(query, "&&") {
					t.Errorf("malformed query: %q", query)
				}
			})
		}
	})

	t.Run("decodes the plan rows", func(t *testing.T) {
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "mode": "dry-run",
				"changes": []any{
					map[string]any{"kind": "databases", "name": "orders", "action": "UPDATE"},
					map[string]any{"kind": "network", "name": nil, "action": "CREATE"},
				},
			})
		}))
		res, err := client.ApplyDesign(ApplyDesignParams{Project: "p", Document: doc, DryRun: true})
		if err != nil {
			t.Fatalf("ApplyDesign: %v", err)
		}
		if len(res.Changes) != 2 {
			t.Fatalf("expected 2 changes, got %+v", res.Changes)
		}
		// A nil name must stay nil, not become "": a singleton component has no name, and printing an
		// empty one as a name would read as a component called nothing.
		if res.Changes[0].Name == nil || *res.Changes[0].Name != "orders" {
			t.Errorf("named change: %+v", res.Changes[0])
		}
		if res.Changes[1].Name != nil {
			t.Errorf("a singleton's name must decode as nil, got %v", *res.Changes[1].Name)
		}
	})

	t.Run("surfaces a server error", func(t *testing.T) {
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "Invalid design document at cluster.node_min_size"})
		}))
		if _, err := client.ApplyDesign(ApplyDesignParams{Project: "p", Document: doc}); err == nil {
			t.Fatal("expected an error")
		}
	})
}

func TestDisableAddon(t *testing.T) {
	t.Run("DELETEs with the id in the body", func(t *testing.T) {
		var got map[string]interface{}
		var method, ctype string
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assertAuth(t, r)
			method, ctype = r.Method, r.Header.Get("Content-Type")
			json.NewDecoder(r.Body).Decode(&got)
			json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		}))
		if err := client.DisableAddon("shop", "dev", "falco"); err != nil {
			t.Fatalf("DisableAddon: %v", err)
		}
		if method != "DELETE" {
			t.Errorf("method = %q", method)
		}
		// doDeleteWithBody must send a JSON content type, or the route's req.json() sees nothing.
		if ctype != "application/json" {
			t.Errorf("Content-Type = %q", ctype)
		}
		if got["addon_id"] != "falco" {
			t.Errorf("unexpected body: %+v", got)
		}
	})

	t.Run("surfaces a server error", func(t *testing.T) {
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]string{"error": "nope"})
		}))
		if err := client.DisableAddon("shop", "", "falco"); err == nil {
			t.Fatal("expected an error")
		}
	})

	// A transport failure must surface too — the request never reaching a server is a distinct arm
	// from the server refusing it.
	t.Run("surfaces a transport error", func(t *testing.T) {
		client := NewClient("t")
		client.baseURL = "http://127.0.0.1:1/api"
		if err := client.DisableAddon("shop", "", "falco"); err == nil {
			t.Fatal("expected a transport error")
		}
	})
}

func TestRegisterRunner(t *testing.T) {
	t.Run("posts the name and returns the token", func(t *testing.T) {
		var got map[string]interface{}
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assertAuth(t, r)
			if r.Method != "POST" || r.URL.Path != "/api/cli/runners/register" {
				t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			}
			json.NewDecoder(r.Body).Decode(&got)
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]any{
				"runner": map[string]any{
					"id": "r1", "name": "box", "operator": "self", "provisioning": "registered",
					"supported_providers": nil, "status": "OFFLINE", "last_heartbeat": nil,
					"version": "", "is_default": false, "created_at": "2026-01-01T00:00:00.000Z",
				},
				"runner_token": "tok-xyz",
			})
		}))
		reg, err := client.RegisterRunner("box", "ci-1")
		if err != nil {
			t.Fatalf("RegisterRunner: %v", err)
		}
		if got["name"] != "box" || got["cloud_identity_id"] != "ci-1" {
			t.Errorf("unexpected body: %+v", got)
		}
		if reg.RunnerToken != "tok-xyz" || reg.Runner.ID != "r1" {
			t.Errorf("unexpected registration: %+v", reg)
		}
	})

	// An empty identity must be OMITTED, not sent as "": the server validates the field as a uuid
	// when present, so an empty string would turn an optional field into a 400.
	t.Run("omits an empty cloud identity", func(t *testing.T) {
		var got map[string]interface{}
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			json.NewDecoder(r.Body).Decode(&got)
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]any{
				"runner": map[string]any{
					"id": "r1", "name": "box", "operator": "self", "provisioning": "registered",
					"supported_providers": nil, "status": "OFFLINE", "last_heartbeat": nil,
					"version": "", "is_default": false, "created_at": "2026-01-01T00:00:00.000Z",
				},
				"runner_token": "t",
			})
		}))
		if _, err := client.RegisterRunner("box", ""); err != nil {
			t.Fatalf("RegisterRunner: %v", err)
		}
		if _, present := got["cloud_identity_id"]; present {
			t.Errorf("cloud_identity_id must be omitted when empty, got %+v", got)
		}
	})

	t.Run("surfaces a server error", func(t *testing.T) {
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]string{"error": "nope"})
		}))
		if _, err := client.RegisterRunner("box", ""); err == nil {
			t.Fatal("expected an error")
		}
	})
}
