// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func newTestClient(t *testing.T, handler http.Handler) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	os.Setenv("ALETHIA_WEB_ORIGIN", server.URL)
	t.Cleanup(func() { os.Unsetenv("ALETHIA_WEB_ORIGIN") })
	return NewClient("test-token")
}

func assertAuth(t *testing.T, r *http.Request) {
	t.Helper()
	if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
		t.Errorf("expected Bearer test-token, got %s", got)
	}
}

// --- GetRunners ---

func TestGetRunners_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/runners" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("expected GET, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"runners": []map[string]any{
				{"id": "w1", "name": "runner-a", "operator": "self", "provisioning": "registered", "status": "ONLINE", "is_default": true},
				{"id": "w2", "name": "runner-b", "operator": "managed", "status": "OFFLINE", "is_default": false},
			},
		})
	}))

	runners, err := client.GetRunners()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(runners) != 2 {
		t.Fatalf("expected 2 runners, got %d", len(runners))
	}
	if runners[0].Name != "runner-a" {
		t.Errorf("expected runner-a, got %s", runners[0].Name)
	}
	if !runners[0].IsDefault {
		t.Error("expected first runner to be default")
	}
	if runners[1].Operator != "managed" {
		t.Errorf("expected managed, got %s", runners[1].Operator)
	}
}

func TestGetRunners_ServerError(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "db down"})
	}))

	_, err := client.GetRunners()
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
}

// --- RemoveRunner ---

func TestRemoveRunner_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/runners/w1" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "DELETE" {
			t.Errorf("expected DELETE, got %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
	}))

	if err := client.RemoveRunner("w1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRemoveRunner_NotFound(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "not found"})
	}))

	if err := client.RemoveRunner("bad-id"); err == nil {
		t.Fatal("expected error for 404 response")
	}
}

// --- DeployRunner ---

func TestDeployRunner_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/runners/deploy" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}

		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "my-runner" {
			t.Errorf("expected name my-runner, got %s", body["name"])
		}
		if body["cloud_identity_id"] != "ci-1" {
			t.Errorf("expected cloud_identity_id ci-1, got %s", body["cloud_identity_id"])
		}
		if body["region"] != "eu-west-1" {
			t.Errorf("expected region eu-west-1, got %s", body["region"])
		}

		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"runner": map[string]string{"id": "t1", "name": "my-runner"},
			"job":    map[string]string{"id": "j1", "status": "QUEUED", "created_at": "2026-01-01T00:00:00Z"},
		})
	}))

	resp, err := client.DeployRunner("my-runner", "ci-1", "eu-west-1", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.Runner.ID != "t1" {
		t.Errorf("expected runner id t1, got %s", resp.Runner.ID)
	}
	if resp.Job.ID != "j1" {
		t.Errorf("expected job id j1, got %s", resp.Job.ID)
	}
}

func TestDeployRunner_WithAssigned(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["assigned_runner_id"] != "w-exec" {
			t.Errorf("expected assigned_runner_id w-exec, got %s", body["assigned_runner_id"])
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"runner": map[string]string{"id": "t1", "name": "t"},
			"job":    map[string]string{"id": "j1", "status": "QUEUED"},
		})
	}))

	_, err := client.DeployRunner("t", "ci", "us-east-1", "w-exec")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- GetClusters ---

func TestGetClusters_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/clusters" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"clusters": []map[string]any{
				{
					"id":                "vc1",
					"cluster_name":      "prod-eks",
					"cluster_version":   "1.29",
					"status":            "ACTIVE",
					"node_min_size":     2,
					"node_max_size":     10,
					"node_desired_size": 3,
					"project_name":      "my-app",
					"environment":       "production",
					"region":            "eu-west-1",
				},
			},
		})
	}))

	clusters, err := client.GetClusters()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(clusters) != 1 {
		t.Fatalf("expected 1 cluster, got %d", len(clusters))
	}
	if clusters[0].ClusterName != "prod-eks" {
		t.Errorf("expected prod-eks, got %s", clusters[0].ClusterName)
	}
	if clusters[0].ProjectName != "my-app" {
		t.Errorf("expected my-app, got %s", clusters[0].ProjectName)
	}
}

// TestGetClusters_WalksEveryPage proves GetClusters is a WALK, not one request.
//
// The endpoint returned the whole collection until #3672 and now returns a page. A client that
// read `clusters` and stopped would silently truncate at the server's default page size — a
// plausible, short list with no error, which is the failure mode AllPages exists to remove. The
// previous test above still passes against a paged server BECAUSE its response carries no `page`
// object, so it proves back-compatibility and says nothing about paging.
//
// The cursor is asserted as SENT, not just as followed: a walk that re-requested page 1 forever
// would be caught by AllPages' visited set as a re-issued cursor, but a walk that dropped the
// cursor and got page 1 again from a server that ignores it would not.
func TestGetClusters_WalksEveryPage(t *testing.T) {
	var cursors []string
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/clusters" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		cursor := r.URL.Query().Get("cursor")
		cursors = append(cursors, cursor)
		if cursor == "" {
			json.NewEncoder(w).Encode(map[string]any{
				"clusters": []map[string]any{{"id": "c1", "cluster_name": "one"}},
				"page": map[string]any{
					"mode": "exact", "limit": 1, "total": 2, "next_cursor": "CURSOR-2",
				},
			})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"clusters": []map[string]any{{"id": "c2", "cluster_name": "two"}},
			"page": map[string]any{
				"mode": "exact", "limit": 1, "total": 2, "next_cursor": nil,
			},
		})
	}))

	clusters, err := client.GetClusters()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(clusters) != 2 {
		t.Fatalf("expected both pages' rows, got %d: %+v", len(clusters), clusters)
	}
	if clusters[0].ID != "c1" || clusters[1].ID != "c2" {
		t.Errorf("pages concatenated out of order: %+v", clusters)
	}
	// Two requests, and the second carried the cursor the first handed back.
	if len(cursors) != 2 || cursors[0] != "" || cursors[1] != "CURSOR-2" {
		t.Errorf("expected [\"\", \"CURSOR-2\"], got %q", cursors)
	}
}

// TestGetClustersPage_AbsentPageBecomesAnExactSinglePage covers the state the WIRE cannot produce
// but the DECODER can.
//
// `page` is a value, not a pointer, so a response from a control plane older than #3672 — which
// sends no `page` object at all — decodes to the ZERO PageInfo. That is harmless to GetClusters
// (NextCursor is "", so the walk stops after one request) and silently wrong to anything that
// renders it: Total 0 beside a screenful of rows, and a Mode that is neither "exact" nor "capped".
// The server's schema makes `mode` required precisely so a renderer never meets a third state;
// without the fill-in the CLIENT reintroduces one.
//
// Driven through GetClustersPage rather than asserted on a PageInfo literal, because the method is
// where the fill-in lives and the pager is the caller that reaches it.
func TestGetClustersPage_AbsentPageBecomesAnExactSinglePage(t *testing.T) {
	cases := []struct {
		name string
		rows []map[string]any
		want PageInfo
	}{
		{
			name: "the whole collection, as a pre-#3672 server sends it",
			rows: []map[string]any{
				{"id": "c1", "cluster_name": "one"},
				{"id": "c2", "cluster_name": "two"},
				{"id": "c3", "cluster_name": "three"},
			},
			want: PageInfo{Mode: PageModeExact, Limit: 3, Total: 3, NextCursor: ""},
		},
		{
			// A whole-collection response with nothing in it. Limit 0 is not a page size the
			// server served; it is the honest reading of "everything, and everything is none".
			name: "an empty collection",
			rows: []map[string]any{},
			want: PageInfo{Mode: PageModeExact, Limit: 0, Total: 0, NextCursor: ""},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assertAuth(t, r)
				if r.URL.Path != "/api/cli/clusters" {
					t.Errorf("unexpected path: %s", r.URL.Path)
				}
				// No `page` key at all — the shape this test exists for.
				json.NewEncoder(w).Encode(map[string]any{"clusters": tc.rows})
			}))

			page, err := client.GetClustersPage(PageOpts{})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(page.Clusters) != len(tc.rows) {
				t.Fatalf("expected %d clusters, got %d", len(tc.rows), len(page.Clusters))
			}
			if page.Page != tc.want {
				t.Errorf("Page = %+v, want %+v", page.Page, tc.want)
			}
			// The two things a pager reads, stated as the properties rather than as the struct:
			// Total must match the rows on screen, and there must be nothing to follow, because a
			// legacy response IS the whole collection.
			if page.Page.Total != len(page.Clusters) {
				t.Errorf("Total %d disagrees with the %d rows returned", page.Page.Total, len(page.Clusters))
			}
			if page.Page.HasMore() {
				t.Error("HasMore() on a whole-collection response: the walk would never end")
			}
			// Neither "exact" nor "capped" is the third state the vocabulary forbids, and it is
			// what an un-filled zero PageInfo would leave here.
			if page.Page.Mode != PageModeExact && page.Page.Mode != PageModeCapped {
				t.Errorf("Mode %q is neither %q nor %q", page.Page.Mode, PageModeExact, PageModeCapped)
			}
		})
	}
}

// TestGetClustersPage_RealPageIsNotRewritten is the NEGATIVE CONTROL for the test above, and the
// reason the fill-in keys on Mode rather than on a zero-looking number.
//
// A capped page is the case that would hurt: Total is a FLOOR there — the server stopped counting
// at its ceiling — so a discriminator of `Total == 0` or `Limit == 0`, or an unconditional
// overwrite, turns "1000+" into the two rows in hand. That is a wrong answer that looks precise,
// which is the exact failure PageModeCapped exists to prevent.
func TestGetClustersPage_RealPageIsNotRewritten(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		json.NewEncoder(w).Encode(map[string]any{
			"clusters": []map[string]any{
				{"id": "c1", "cluster_name": "one"},
				{"id": "c2", "cluster_name": "two"},
			},
			"page": map[string]any{
				"mode": "capped", "limit": 2, "total": 1000, "next_cursor": "CURSOR-2",
			},
		})
	}))

	page, err := client.GetClustersPage(PageOpts{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := PageInfo{Mode: PageModeCapped, Limit: 2, Total: 1000, NextCursor: "CURSOR-2"}
	if page.Page != want {
		t.Errorf("Page = %+v, want %+v", page.Page, want)
	}
	// Said as the property too: the floor survives, and it is NOT the row count.
	if page.Page.Total == len(page.Clusters) {
		t.Errorf("the capped floor was overwritten with the %d rows in hand", len(page.Clusters))
	}
	if !page.Page.IsCapped() {
		t.Error("IsCapped() false on a page the server marked capped")
	}
}

// --- GetCloudIdentities ---

func TestGetCloudIdentities_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/cloud-identities" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"cloud_identities": []map[string]any{
				{"id": "ci1", "provider": "aws", "label": "AWS (123456)"},
				{"id": "ci2", "provider": "gcp", "label": "GCP (my-project)"},
			},
		})
	}))

	ids, err := client.GetCloudIdentities()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(ids) != 2 {
		t.Fatalf("expected 2 identities, got %d", len(ids))
	}
	if ids[0].Provider != "aws" {
		t.Errorf("expected aws, got %s", ids[0].Provider)
	}
	if ids[1].Label != "GCP (my-project)" {
		t.Errorf("expected GCP label, got %s", ids[1].Label)
	}
}

func TestGetCloudIdentities_Empty(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"cloud_identities": []any{}})
	}))

	ids, err := client.GetCloudIdentities()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("expected 0, got %d", len(ids))
	}
}

// --- QueueJobWithParams ---

func TestQueueJob_Plan(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/jobs" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}

		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["job_type"] != "PLAN" {
			t.Errorf("expected PLAN, got %v", body["job_type"])
		}
		if body["configuration_id"] != "project-1" {
			t.Errorf("expected project-1, got %v", body["configuration_id"])
		}
		if _, ok := body["plan_job_id"]; ok {
			t.Error("plan_job_id should not be sent when empty")
		}

		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"job": map[string]any{"id": "job-1", "status": "QUEUED", "job_type": "PLAN"},
		})
	}))

	job, err := client.QueueJobWithParams(QueueJobParams{
		JobType:         "PLAN",
		ConfigurationID: "project-1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if job.ID != "job-1" {
		t.Errorf("expected job-1, got %s", job.ID)
	}
}

func TestQueueJob_DeployWithAssigned(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["assigned_runner_id"] != "w-1" {
			t.Errorf("expected assigned_runner_id w-1, got %v", body["assigned_runner_id"])
		}
		if body["plan_job_id"] != "plan-1" {
			t.Errorf("expected plan_job_id plan-1, got %v", body["plan_job_id"])
		}

		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"job": map[string]any{"id": "job-2", "status": "QUEUED", "job_type": "DEPLOY"},
		})
	}))

	_, err := client.QueueJobWithParams(QueueJobParams{
		JobType:          "DEPLOY",
		ConfigurationID:  "project-1",
		AssignedRunnerID: "w-1",
		PlanJobID:        "plan-1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- GetJobs ---

func TestGetJobs_WithFilters(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/jobs" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("status") != "SUCCESS" {
			t.Errorf("expected status=SUCCESS, got %s", r.URL.Query().Get("status"))
		}
		if r.URL.Query().Get("limit") != "20" {
			t.Errorf("expected limit=20, got %s", r.URL.Query().Get("limit"))
		}
		json.NewEncoder(w).Encode(map[string]any{
			"jobs":   []map[string]any{{"id": "j1", "status": "SUCCESS", "job_type": "PLAN", "project_name": "my-app"}},
			"total":  1,
			"limit":  20,
			"offset": 0,
		})
	}))

	page, err := client.GetJobs("SUCCESS", 20, 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(page.Jobs) != 1 {
		t.Fatalf("expected 1 job, got %d", len(page.Jobs))
	}
	if page.Total != 1 {
		t.Errorf("expected total 1, got %d", page.Total)
	}
	if page.Jobs[0].ProjectName != "my-app" {
		t.Errorf("expected project_name my-app, got %s", page.Jobs[0].ProjectName)
	}
}

func TestGetJobs_Pagination(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("offset") != "20" {
			t.Errorf("expected offset=20, got %s", r.URL.Query().Get("offset"))
		}
		json.NewEncoder(w).Encode(map[string]any{
			"jobs": []any{}, "total": 50, "limit": 20, "offset": 20,
		})
	}))

	page, err := client.GetJobs("", 20, 20)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if page.Total != 50 {
		t.Errorf("expected total 50, got %d", page.Total)
	}
}

// --- GetJob ---

func TestGetJob_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/jobs/job-abc" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"id": "job-abc", "status": "PROCESSING", "job_type": "DEPLOY",
		})
	}))

	job, err := client.GetJob("job-abc")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if job.Status != "PROCESSING" {
		t.Errorf("expected PROCESSING, got %s", job.Status)
	}
}

func TestGetJob_NotFound(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "not found"})
	}))

	_, err := client.GetJob("bad")
	if err == nil {
		t.Fatal("expected error for 404")
	}
}

// --- GetJobLogs ---

func TestGetJobLogs_WithAfterID(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/jobs/j1/logs" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("after") != "42" {
			t.Errorf("expected after=42, got %s", r.URL.Query().Get("after"))
		}
		json.NewEncoder(w).Encode(map[string]any{
			"logs": []map[string]any{
				{"id": 43, "job_id": "j1", "log_chunk": "hello", "stream_type": "STDOUT"},
			},
		})
	}))

	logs, err := client.GetJobLogs("j1", 42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("expected 1 log, got %d", len(logs))
	}
	if logs[0].LogChunk != "hello" {
		t.Errorf("expected hello, got %s", logs[0].LogChunk)
	}
}

func TestGetJobLogs_NoAfter(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("after") != "" {
			t.Errorf("expected no after param, got %s", r.URL.Query().Get("after"))
		}
		json.NewEncoder(w).Encode(map[string]any{"logs": []any{}})
	}))

	_, err := client.GetJobLogs("j1", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- CancelJob ---

func TestCancelJob_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/jobs/j1/cancel" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
	}))

	if err := client.CancelJob("j1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCancelJob_Failed(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "job already completed"})
	}))

	if err := client.CancelJob("j1"); err == nil {
		t.Fatal("expected error for completed job")
	}
}

// --- GetConfiguration ---

func TestGetConfiguration_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/configurations/by-project-name/my-app" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"configuration": map[string]any{
				"id":                "cfg-1",
				"project_name":      "my-app",
				"environment_stage": "production",
			},
		})
	}))

	config, err := client.GetConfiguration("my-app")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if config.ProjectName != "my-app" {
		t.Errorf("expected my-app, got %s", config.ProjectName)
	}
}

// --- ExportConfiguration ---

// The default is `json`. It used to be `legacy-yaml`, and this test locked that in — which is part of
// how the bug survived: the default named a format with NO producer anywhere in the repo, and the route
// it was sent to did not exist, so the command 404'd for its whole life while its tests passed against
// a fake that answered whatever it was asked.
func TestExportConfiguration_DefaultFormat(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("format") != "json" {
			t.Errorf("expected format=json, got %s", r.URL.Query().Get("format"))
		}
		json.NewEncoder(w).Encode(map[string]string{
			"content": "{}", "filename": "config.json", "format": "json",
		})
	}))

	export, err := client.ExportConfiguration("my-app", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if export.Content != "{}" {
		t.Errorf("expected the JSON content, got %s", export.Content)
	}
	if export.Format != "json" {
		t.Errorf("expected format json, got %s", export.Format)
	}
}

// An explicit format is still forwarded, so a caller can ask for one the server may add later — and
// a caller who pins the old `legacy-yaml` reaches a server that refuses it BY NAME rather than one
// that quietly returns JSON labelled as YAML.
func TestExportConfiguration_ExplicitFormatIsForwarded(t *testing.T) {
	var got string
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Query().Get("format")
		json.NewEncoder(w).Encode(map[string]string{
			"content": "{}", "filename": "c.json", "format": "json",
		})
	}))
	if _, err := client.ExportConfiguration("my-app", "legacy-yaml"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "legacy-yaml" {
		t.Errorf("an explicit format must be forwarded verbatim, got %q", got)
	}
}

// --- Cloud Provider Connections ---

func TestInitProviderIdentity_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/providers/gcp/init" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"identity_id": "id-123",
			"external_id": "ext-abc",
		})
	}))

	resp, err := client.InitProviderIdentity("gcp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.IdentityID != "id-123" {
		t.Errorf("expected identity id-123, got %s", resp.IdentityID)
	}
	if resp.ExternalID != "ext-abc" {
		t.Errorf("expected external ext-abc, got %s", resp.ExternalID)
	}
}

func TestConnectProviderIdentity_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/providers/aws/connect" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}

		var body struct {
			IdentityID  string                 `json:"identity_id"`
			Credentials map[string]interface{} `json:"credentials"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode body: %v", err)
		}
		if body.IdentityID != "id-123" {
			t.Errorf("expected identity_id id-123, got %s", body.IdentityID)
		}
		if body.Credentials["role_arn"] != "arn:aws:iam::123456789012:role/Alethia" {
			t.Errorf("unexpected credentials: %v", body.Credentials)
		}

		// Synchronous verdict — no job_id.
		json.NewEncoder(w).Encode(map[string]any{
			"identity_id":         "id-123",
			"verified":            true,
			"status":              "connected",
			"error":               nil,
			"missing_permissions": []string{},
		})
	}))

	resp, err := client.ConnectProviderIdentity("aws", "id-123", map[string]interface{}{
		"role_arn": "arn:aws:iam::123456789012:role/Alethia",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.Verified || resp.Status != "connected" {
		t.Errorf("expected verified connected, got verified=%v status=%s", resp.Verified, resp.Status)
	}
	if resp.IdentityID != "id-123" {
		t.Errorf("expected id-123, got %s", resp.IdentityID)
	}
}

func TestDisconnectProviderIdentity_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/providers/gcp/disconnect" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))

	if err := client.DisconnectProviderIdentity("gcp", "id-1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGetProviderStatus_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/providers/aws/status" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("expected GET, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"connected": true,
			"accountId": "123456789012",
			"roleArn":   "arn:aws:iam::123456789012:role/Alethia",
		})
	}))

	status, err := client.GetProviderStatus("aws")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !status.Connected {
		t.Errorf("expected connected=true")
	}
	if status.AccountID != "123456789012" {
		t.Errorf("expected accountId 123456789012, got %s", status.AccountID)
	}
	if status.RoleArn != "arn:aws:iam::123456789012:role/Alethia" {
		t.Errorf("unexpected roleArn: %s", status.RoleArn)
	}
}

func TestVerifyProviderIdentity_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/providers/aws/verify" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "POST" {
			t.Errorf("expected POST, got %s", r.Method)
		}
		var body struct {
			IdentityID string `json:"identity_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("failed to decode body: %v", err)
		}
		if body.IdentityID != "id-123" {
			t.Errorf("expected identity_id id-123, got %s", body.IdentityID)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"identity_id":         "id-123",
			"verified":            true,
			"status":              "connected",
			"error":               nil,
			"missing_permissions": []string{},
		})
	}))

	resp, err := client.VerifyProviderIdentity("aws", "id-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.Verified || resp.Status != "connected" {
		t.Errorf("expected verified connected, got verified=%v status=%s", resp.Verified, resp.Status)
	}
}

func TestVerifyProviderIdentity_ErrorPropagates(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{"error": "identity not found"})
	}))

	if _, err := client.VerifyProviderIdentity("aws", "missing"); err == nil {
		t.Error("expected error to propagate")
	}
}

func TestGetRepositories_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/repositories/github" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != "GET" {
			t.Errorf("expected GET, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"repositories": []map[string]any{
				{"id": "1", "name": "app", "full_name": "acme/app", "url": "u", "private": true, "default_branch": "main", "provider": "github"},
			},
		})
	}))

	repos, err := client.GetRepositories("github")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(repos) != 1 || repos[0].FullName != "acme/app" {
		t.Errorf("unexpected repos: %+v", repos)
	}
}

func TestConnectProviderIdentity_ErrorPropagates(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]any{
			"error": "Invalid format. Expected: arn:aws:iam::123456789012:role/RoleName",
		})
	}))

	_, err := client.ConnectProviderIdentity("aws", "id-123", map[string]interface{}{
		"role_arn": "bad-arn",
	})
	if err == nil {
		t.Fatal("expected an error, got nil")
	}
	if !strings.Contains(err.Error(), "Invalid format") {
		t.Errorf("expected error to contain the server message, got %q", err.Error())
	}
}

func TestGetProjectDrift_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/drift" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("env") != "production" {
			t.Errorf("expected env=production, got %q", r.URL.Query().Get("env"))
		}
		json.NewEncoder(w).Encode(map[string]any{
			"evaluated":   true,
			"in_sync":     false,
			"drifted":     1,
			"scanned_at":  "2026-01-01T00:00:00.000Z",
			"environment": "production",
			"details":     []map[string]any{{"address": "aws_s3_bucket.x", "type": "aws_s3_bucket", "kind": "modified"}},
		})
	}))

	posture, err := client.GetProjectDrift("my-proj", "production")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !posture.Evaluated || posture.Drifted != 1 || len(posture.Details) != 1 {
		t.Errorf("unexpected posture: %+v", posture)
	}
	if posture.Details[0].Kind != "modified" {
		t.Errorf("unexpected detail kind: %s", posture.Details[0].Kind)
	}
}

func TestGetEnvironmentCost_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/cost" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"priced":        true,
			"total_monthly": 42.5,
			"currency":      "USD",
			"captured_at":   "2026-01-01T00:00:00.000Z",
			"plan_job_id":   "job-1",
			"environment":   "staging",
			"resources":     []map[string]any{{"address": "aws_db_instance.main", "resource_type": "aws_db_instance", "monthly_cost": 42.5}},
		})
	}))

	cost, err := client.GetEnvironmentCost("my-proj", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cost.Priced || cost.TotalMonthly == nil || *cost.TotalMonthly != 42.5 {
		t.Errorf("unexpected cost: %+v", cost)
	}
	if len(cost.Resources) != 1 || cost.Resources[0].ResourceType != "aws_db_instance" {
		t.Errorf("unexpected resources: %+v", cost.Resources)
	}
}

func TestGetProjectProtection_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/protection" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"rules": []map[string]any{{
				"environment_id":       "env-1",
				"environment":          "production",
				"require_predecessor":  true,
				"require_verify_pass":  true,
				"require_approval":     true,
				"min_count":            2,
				"soak_minutes":         30,
				"cost_delta_threshold": 100.0,
			}},
		})
	}))

	rules, err := client.GetProjectProtection("my-proj")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(rules) != 1 || rules[0].Environment != "production" || !rules[0].RequireApproval {
		t.Errorf("unexpected rules: %+v", rules)
	}
	if rules[0].MinCount == nil || *rules[0].MinCount != 2 {
		t.Errorf("unexpected min_count: %+v", rules[0].MinCount)
	}
}

func TestGetProjectProbes_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/probes" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"probes": []map[string]any{
				{"environment_id": "env-1", "environment": "production", "reachable": true, "message": nil, "probed_at": "2026-01-01T00:00:00.000Z"},
				{"environment_id": "env-2", "environment": "dev", "reachable": nil, "message": nil, "probed_at": nil},
			},
		})
	}))

	probes, err := client.GetProjectProbes("my-proj")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(probes) != 2 {
		t.Fatalf("expected 2 probes, got %d", len(probes))
	}
	if probes[0].Reachable == nil || !*probes[0].Reachable {
		t.Errorf("expected production reachable=true, got %+v", probes[0].Reachable)
	}
	if probes[1].Reachable != nil {
		t.Errorf("expected dev reachable=nil (never probed), got %+v", probes[1].Reachable)
	}
}

func TestGetProjectAddons_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/addons" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"environment": "production",
			"addons": []map[string]any{
				{"addon_id": "cnpg", "enabled": true, "mode": "managed", "version": nil, "namespace": "cnpg", "status": "READY", "health": "Healthy", "sync": "Synced", "last_synced_at": nil},
			},
		})
	}))

	view, err := client.GetProjectAddons("my-proj", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if view.Environment != "production" || len(view.Addons) != 1 || view.Addons[0].AddonID != "cnpg" {
		t.Errorf("unexpected view: %+v", view)
	}
}

func TestGetProjectByoCharts_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/byo-charts" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"environment": "production",
			"charts": []map[string]any{
				{"id": "payments", "repo_url": "u", "chart_path": "charts/payments", "ref": "main", "namespace": "payments", "status": "READY", "health": nil, "sync": nil, "scan_status": "done", "scanned_at": nil},
			},
		})
	}))

	view, err := client.GetProjectByoCharts("my-proj", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(view.Charts) != 1 || view.Charts[0].ID != "payments" {
		t.Errorf("unexpected charts: %+v", view.Charts)
	}
}

func TestGetProjectIacSource_Present(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/byo-iac" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"source": map[string]any{
				"id": "src-1", "environment": "production", "name": "networking", "repo_url": "u",
				"ref": nil, "path": "envs/prod", "commit_sha": nil, "deployed_commit_sha": nil,
				"enabled": true, "scan_status": "done", "scanned_at": nil, "status": "READY", "status_message": nil,
			},
		})
	}))

	src, err := client.GetProjectIacSource("my-proj", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src == nil || src.Name != "networking" {
		t.Errorf("unexpected source: %+v", src)
	}
}

func TestGetProjectIacSource_None(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"source": nil})
	}))

	src, err := client.GetProjectIacSource("my-proj", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src != nil {
		t.Errorf("expected nil source, got %+v", src)
	}
}

func TestGetProjectPromotions_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/promotions" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"promotions": []map[string]any{
				{"id": "p1", "source": "staging", "target": "production", "status": "DEPLOYED", "error_message": nil, "created_at": "2026-01-01T00:00:00.000Z", "completed_at": nil},
			},
		})
	}))

	promos, err := client.GetProjectPromotions("my-proj", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(promos) != 1 || promos[0].Target != "production" {
		t.Errorf("unexpected promotions: %+v", promos)
	}
}

func TestGetPromotion_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/promotions/p1" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"promotion": map[string]any{
				"id": "p1", "source": "staging", "target": "production", "status": "PENDING_APPROVAL",
				"initiator": "Ivo", "error_message": nil, "approved": 1, "required": 2,
				"approvals": []map[string]any{
					{"id": "a1", "status": "approved", "name": "Ivo", "required_role": "admin", "comment": nil, "decided_at": "2026-01-01T01:00:00.000Z"},
				},
				"created_at": "2026-01-01T00:00:00.000Z", "completed_at": nil,
			},
		})
	}))

	p, err := client.GetPromotion("my-proj", "p1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.Approved != 1 || p.Required != 2 || len(p.Approvals) != 1 {
		t.Errorf("unexpected promotion detail: %+v", p)
	}
}

func TestGetProjectStagedChanges_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/projects/my-proj/staged" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"environment": "production",
			"changes": []map[string]any{
				{"component_type": "database", "op": "create", "component_id": nil, "created_at": "2026-01-01T00:00:00.000Z"},
			},
		})
	}))

	view, err := client.GetProjectStagedChanges("my-proj", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if view.Environment != "production" || len(view.Changes) != 1 || view.Changes[0].Op != "create" {
		t.Errorf("unexpected staged changes: %+v", view)
	}
}

// TestProjectPagedRoutes_FollowCursor covers the shared cursor loop and each project list route's
// query construction. The first response deliberately advertises another page so the client must
// issue a second request with the returned cursor.
func TestProjectPagedRoutes_FollowCursor(t *testing.T) {
	seen := make(map[string]int)
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		seen[path]++
		if seen[path] == 2 && r.URL.Query().Get("cursor") != "next" {
			t.Errorf("expected cursor=next on second request for %s, got %q", path, r.URL.Query().Get("cursor"))
		}
		if seen[path] > 2 {
			t.Fatalf("unexpected third request for %s", path)
		}
		last := seen[path] == 2
		page := map[string]any{"page": map[string]any{"next_cursor": func() string {
			if last {
				return ""
			}
			return "next"
		}()}}
		switch path {
		case "/api/cli/projects/p/environments":
			page["environments"] = []map[string]any{{"id": "env" + fmt.Sprint(seen[path])}}
		case "/api/cli/projects/p/addons":
			page["environment"] = "production"
			page["addons"] = []map[string]any{{"addon_id": "a" + fmt.Sprint(seen[path])}}
		case "/api/cli/projects/p/byo-charts":
			page["environment"] = "production"
			page["charts"] = []map[string]any{{"id": "c" + fmt.Sprint(seen[path])}}
		case "/api/cli/projects/p/promotions":
			page["promotions"] = []map[string]any{{"id": "pr" + fmt.Sprint(seen[path])}}
		case "/api/cli/projects/p/staged":
			page["environment"] = "production"
			page["changes"] = []map[string]any{{"op": "create"}}
		default:
			t.Fatalf("unexpected path: %s", path)
		}
		_ = json.NewEncoder(w).Encode(page)
	}))

	if got, err := client.ListEnvironments("p"); err != nil || len(got) != 2 {
		t.Fatalf("environments: got %d rows, err %v", len(got), err)
	}
	if got, err := client.GetProjectAddons("p", "prod"); err != nil || len(got.Addons) != 2 {
		t.Fatalf("addons: got %+v, err %v", got, err)
	}
	if got, err := client.GetProjectByoCharts("p", "prod"); err != nil || len(got.Charts) != 2 {
		t.Fatalf("charts: got %+v, err %v", got, err)
	}
	if got, err := client.GetProjectPromotions("p", "prod"); err != nil || len(got) != 2 {
		t.Fatalf("promotions: got %d rows, err %v", len(got), err)
	}
	if got, err := client.GetProjectStagedChanges("p", "prod"); err != nil || len(got.Changes) != 2 {
		t.Fatalf("staged: got %+v, err %v", got, err)
	}
}

// TestProjectPagedRoutes_Empty covers the valid empty-universe result for aggregating routes.
func TestProjectPagedRoutes_Empty(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"environment": "production",
			"addons":      []any{},
			"charts":      []any{},
			"changes":     []any{},
			"page":        map[string]any{},
		})
	}))
	if got, err := client.GetProjectAddons("p", ""); err != nil || got == nil {
		t.Fatalf("empty addons: got %+v, err %v", got, err)
	}
	if got, err := client.GetProjectByoCharts("p", ""); err != nil || got == nil {
		t.Fatalf("empty charts: got %+v, err %v", got, err)
	}
	if got, err := client.GetProjectStagedChanges("p", ""); err != nil || got == nil {
		t.Fatalf("empty staged: got %+v, err %v", got, err)
	}
}

func TestGetCloudInventory_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/cloud-identities/id-1/inventory" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"networks": []map[string]any{{"native_id": "vpc-1", "name": "main", "region": "eu-west-1", "provider": "aws", "cidr_block": "10.0.0.0/16", "is_default": true}},
			"subnets":  []map[string]any{{"native_id": "subnet-1", "name": nil, "region": "eu-west-1", "availability_zone": "eu-west-1a", "cidr_block": "10.0.1.0/24", "is_public": true}},
			"regions":  []string{"eu-west-1"},
		})
	}))

	inv, err := client.GetCloudInventory("id-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(inv.Networks) != 1 || inv.Networks[0].NativeID != "vpc-1" || len(inv.Subnets) != 1 || len(inv.Regions) != 1 {
		t.Errorf("unexpected inventory: %+v", inv)
	}
}

func TestGetOrgSettings_Present(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/org-settings" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"settings": map[string]any{"name": "Acme", "slug": "acme", "description": "", "logo": nil, "region": "eu-west-1", "default_env": "staging", "terraform_version": "1.9.5"},
		})
	}))

	s, err := client.GetOrgSettings()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s == nil || s.Name != "Acme" {
		t.Errorf("unexpected settings: %+v", s)
	}
}

func TestGetOrgSettings_Community(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"settings": nil})
	}))

	s, err := client.GetOrgSettings()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if s != nil {
		t.Errorf("expected nil settings in community mode, got %+v", s)
	}
}

func TestListAgents_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/agents" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"agents": []map[string]any{{"id": "ag-1", "persona": "provisioner", "mission": "m", "tool_scope": []string{"plan"}, "memory_namespace": "ns", "project_id": nil, "version": 1, "created_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-01T00:00:00.000Z"}},
		})
	}))

	agents, err := client.ListAgents()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(agents) != 1 || agents[0].Persona != "provisioner" {
		t.Errorf("unexpected agents: %+v", agents)
	}
}

func TestGetAgent_Success(t *testing.T) {
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assertAuth(t, r)
		if r.URL.Path != "/api/cli/agents/ag-1" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"agent": map[string]any{"id": "ag-1", "persona": "provisioner", "mission": "m", "tool_scope": []string{"plan", "apply"}, "memory_namespace": "ns", "project_id": nil, "version": 2, "created_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-01T00:00:00.000Z"},
		})
	}))

	a, err := client.GetAgent("ag-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if a.Version != 2 || len(a.ToolScope) != 2 {
		t.Errorf("unexpected agent: %+v", a)
	}
}
