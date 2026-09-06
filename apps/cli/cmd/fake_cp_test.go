// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
)

// The path-aware fake control plane, as a REGISTRY.
//
// It used to be one `switch` inside the env helper, ~40 arms and 220 lines, and it was the second
// reason this package could not be worked on in parallel: a lane that needed one new endpoint had
// to edit the middle of a function every other lane's env helper also went through, and git reports
// the whole switch as a single conflict hunk. Taking either side of that conflict silently drops the
// other lane's endpoint — the same failure mode CLAUDE.md records for docsFencedExamples.
//
// So the endpoints are registered instead. A lane adds a PACK — a function returning its own
// subject's routes — and one line in cpRoutePacks. Two lanes adding two packs conflict on one line
// that is a list, where taking both sides is the obviously right resolution.
//
// The envelope fake (miscEnvelope) is the other half of this package's control plane and is
// deliberately NOT merged into this one. It answers every path with a single object because ~25
// endpoints decode it into their own narrow struct; these routes exist because four commands want
// DIFFERENT values under the same `status` key and cannot share one envelope. That is a real
// difference in what is being faked, not two ways of spelling the same thing.

// cpState is what a route may read while building its answer: the caller's options, and the
// per-run counters a poll loop needs.
type cpState struct {
	opts miscAdminOpts
	// jobPolls counts GetJob calls so jobStatusAfter can flip the verdict on the second one. The
	// fake is only ever driven by the single-threaded command under test, so it needs no lock.
	jobPolls int
}

// list returns full, or an empty slice when the caller asked for empty collections.
func (s *cpState) list(full []map[string]any) []map[string]any {
	if s.opts.empty {
		return []map[string]any{}
	}
	return full
}

// cpRoute is one endpoint of the fake control plane.
//
// Name is not decoration: it is what the fake's 404 lists, so a command that reached an
// unregistered path is told which paths DO exist rather than only which one it wanted.
type cpRoute struct {
	Name  string
	Match func(r *http.Request) bool
	Body  func(s *cpState, r *http.Request) any
}

// cpRoutePacks is the registry. Order is significant WITHIN a pack — `/api/cli/runners/deploy` must
// be offered before the `/api/cli/runners/` prefix — and the packs are disjoint by path, so their
// order relative to each other is not.
//
// Add a pack here; do not grow another one with an endpoint that is not its subject.
var cpRoutePacks = []func() []cpRoute{
	cpIdentityRoutes,
	cpAccessRoutes,
	cpOrgRoutes,
	cpBillingRoutes,
	cpFleetRoutes,
	cpProviderRoutes,
	cpRunnerRoutes,
	cpProjectRoutes,
	cpBreakglassRoutes,
	cpJobRoutes,
}

// cpRoutes flattens the registry.
func cpRoutes() []cpRoute {
	var out []cpRoute
	for _, pack := range cpRoutePacks {
		out = append(out, pack()...)
	}
	return out
}

// cpPathIs matches an exact path, optionally narrowed to one HTTP method.
func cpPathIs(path string, methods ...string) func(*http.Request) bool {
	return func(r *http.Request) bool {
		if r.URL.Path != path {
			return false
		}
		if len(methods) == 0 {
			return true
		}
		for _, m := range methods {
			if r.Method == m {
				return true
			}
		}
		return false
	}
}

// cpPathHasPrefix matches any path under a prefix.
func cpPathHasPrefix(prefix string) func(*http.Request) bool {
	return func(r *http.Request) bool { return strings.HasPrefix(r.URL.Path, prefix) }
}

// cpPathHasSuffix matches any path ending in suffix, optionally narrowed to one HTTP method.
func cpPathHasSuffix(suffix string, methods ...string) func(*http.Request) bool {
	return func(r *http.Request) bool {
		if !strings.HasSuffix(r.URL.Path, suffix) {
			return false
		}
		if len(methods) == 0 {
			return true
		}
		for _, m := range methods {
			if r.Method == m {
				return true
			}
		}
		return false
	}
}

// cpPathContains matches any path containing sub.
func cpPathContains(sub string) func(*http.Request) bool {
	return func(r *http.Request) bool { return strings.Contains(r.URL.Path, sub) }
}

// cpStatic builds a route whose answer does not depend on the state.
func cpStatic(body any) func(*cpState, *http.Request) any {
	return func(*cpState, *http.Request) any { return body }
}

// --- the packs -------------------------------------------------------------------------------

// cpIdentityRoutes: who the caller is.
func cpIdentityRoutes() []cpRoute {
	return []cpRoute{{
		Name:  "GET /api/cli/whoami",
		Match: cpPathIs("/api/cli/whoami"),
		Body: cpStatic(map[string]any{
			"user":       map[string]any{"id": "u1", "email": "ada@x.com", "name": "Ada"},
			"active_org": map[string]any{"id": "o1", "name": "Acme", "slug": "acme", "role": "owner"},
		}),
	}, {
		Name:  "GET /api/cli/orgs",
		Match: cpPathIs("/api/cli/orgs"),
		Body: func(s *cpState, _ *http.Request) any {
			return map[string]any{"orgs": s.list([]map[string]any{
				{"id": "o1", "name": "Acme", "slug": "acme", "role": "owner", "plan": "team", "is_active": true},
				{"id": "o2", "name": "Beta", "slug": "beta", "role": "member", "plan": "community"},
			})}
		},
	}}
}

// cpAccessRoutes: grants and roles.
func cpAccessRoutes() []cpRoute {
	return []cpRoute{{
		Name:  "POST /api/cli/grants",
		Match: cpPathIs("/api/cli/grants", http.MethodPost),
		Body: cpStatic(map[string]any{"grant": map[string]any{
			"id": "g9", "principal_type": "user", "principal_id": "u1", "effect": "allow",
			"role": "operator", "resource_type": "project", "resource_id": "p1",
		}}),
	}, {
		Name:  "GET /api/cli/grants",
		Match: cpPathIs("/api/cli/grants"),
		Body: func(s *cpState, _ *http.Request) any {
			return map[string]any{"grants": s.list([]map[string]any{
				{
					"id": "g1", "principal_type": "user", "principal_id": "u1", "effect": "allow",
					"role": "operator", "resource_type": "project", "resource_id": "p1",
				},
				{
					"id": "g2", "principal_type": "team", "principal_id": "t1", "effect": "deny",
					"permission_key": "project:destroy", "resource_type": "org",
				},
			})}
		},
	}, {
		Name:  "DELETE /api/cli/grants/{id}",
		Match: cpPathHasPrefix("/api/cli/grants/"),
		Body:  cpStatic(map[string]any{}),
	}, {
		Name:  "POST /api/cli/roles",
		Match: cpPathIs("/api/cli/roles", http.MethodPost),
		Body: cpStatic(map[string]any{"role": map[string]any{
			"id": "role9", "name": "deployer", "permission_keys": []string{"project:deploy"},
		}}),
	}, {
		Name:  "GET /api/cli/roles",
		Match: cpPathIs("/api/cli/roles"),
		Body: func(s *cpState, _ *http.Request) any {
			return map[string]any{"roles": s.list([]map[string]any{
				{"id": "role1", "name": "owner", "is_builtin": true, "permission_keys": []string{"a", "b", "c"}},
				{"id": "role2", "name": "deployer", "permission_keys": []string{"project:deploy"}},
			})}
		},
	}, {
		Name:  "DELETE /api/cli/roles/{id}",
		Match: cpPathHasPrefix("/api/cli/roles/"),
		Body:  cpStatic(map[string]any{}),
	}}
}

// cpOrgRoutes: members, teams and org settings.
func cpOrgRoutes() []cpRoute {
	return []cpRoute{{
		Name:  "POST …/members",
		Match: cpPathHasSuffix("/members", http.MethodPost),
		Body: cpStatic(map[string]any{"invitation": map[string]any{
			"id": "inv1", "email": "new@x.com", "role": "operator", "status": "pending",
		}}),
	}, {
		Name:  "GET …/members",
		Match: cpPathHasSuffix("/members"),
		Body: func(s *cpState, _ *http.Request) any {
			return map[string]any{"members": s.list([]map[string]any{
				{"id": "m1", "user_id": "u1", "email": "ada@x.com", "name": "Ada", "role": "owner", "status": "active"},
			})}
		},
	}, {
		Name:  "DELETE …/members/{id}",
		Match: cpPathContains("/members/"),
		Body:  cpStatic(map[string]any{}),
	}, {
		Name:  "POST …/teams",
		Match: cpPathHasSuffix("/teams", http.MethodPost),
		Body:  cpStatic(map[string]any{"team": map[string]any{"id": "t9", "name": "SRE", "member_count": 0}}),
	}, {
		Name:  "GET …/teams",
		Match: cpPathHasSuffix("/teams"),
		Body: func(s *cpState, _ *http.Request) any {
			return map[string]any{"teams": s.list([]map[string]any{
				{"id": "t1", "name": "Platform", "member_count": 2},
			})}
		},
	}, {
		Name:  "DELETE …/teams/{id}",
		Match: cpPathContains("/teams/"),
		Body:  cpStatic(map[string]any{}),
	}, {
		Name:  "GET /api/cli/org-settings",
		Match: cpPathIs("/api/cli/org-settings"),
		Body: func(s *cpState, _ *http.Request) any {
			if s.opts.empty {
				return map[string]any{"settings": nil}
			}
			return map[string]any{"settings": map[string]any{
				"name": "Acme", "slug": "acme", "description": "", "region": "eu-west-1",
				"default_env": "production", "terraform_version": "1.9.0",
			}}
		},
	}}
}

// cpBillingRoutes: the plan and the meter.
func cpBillingRoutes() []cpRoute {
	return []cpRoute{{
		Name:  "GET /api/cli/usage",
		Match: cpPathIs("/api/cli/usage"),
		Body: cpStatic(map[string]any{"usage": map[string]any{
			"seats_used": 3, "seats_cap": 10, "runner_minutes": 412,
			"projects": 2, "ai_credits_used": 100, "ai_credits_granted": 500,
		}}),
	}, {
		Name:  "GET /api/cli/billing",
		Match: cpPathIs("/api/cli/billing"),
		Body: func(s *cpState, _ *http.Request) any {
			if s.opts.empty {
				return map[string]any{"billing": map[string]any{"plan": "community", "status": "active"}}
			}
			return map[string]any{"billing": map[string]any{
				"plan": "team", "status": "active", "seats": 5,
				"stripe_subscription_id": "sub_1", "trial_ends_at": miscTS, "current_period_end": miscTS,
			}}
		},
	}}
}

// cpFleetRoutes: the warm pools.
func cpFleetRoutes() []cpRoute {
	return []cpRoute{{
		Name:  "PATCH /api/cli/fleet/{provider}",
		Match: cpPathHasPrefix("/api/cli/fleet/"),
		Body:  func(*cpState, *http.Request) any { return map[string]any{"pool": miscFleetPool()} },
	}, {
		Name:  "GET /api/cli/fleet",
		Match: cpPathIs("/api/cli/fleet"),
		Body: func(s *cpState, _ *http.Request) any {
			return map[string]any{"pools": s.list([]map[string]any{
				miscFleetPool(),
				{"provider": "gcp", "warm_min": 0, "max": 4, "slots_per_runner": 1, "channel": "stable"},
				{"provider": "azure", "warm_min": 0, "max": 1, "slots_per_runner": 1},
			})}
		},
	}}
}

// cpProviderRoutes: the connection probe and its re-verification.
//
// Every field of every provider's status shape is in the one answer on purpose: each provider
// command decodes the whole body into its own struct and reads the three keys it cares about.
func cpProviderRoutes() []cpRoute {
	return []cpRoute{{
		Name:  "GET …/status",
		Match: cpPathHasSuffix("/status"),
		Body: func(s *cpState, _ *http.Request) any {
			return map[string]any{
				"connected": s.opts.connected, "identityId": "ci-aws",
				"accountId": "123456789012", "roleArn": "arn:aws:iam::123456789012:role/alethia",
				"projectId": "gcp-proj", "serviceAccountEmail": "sa@gcp-proj.iam.gserviceaccount.com",
				"tenantId": "tid", "clientId": "cid", "subscriptionId": "sid",
			}
		},
	}, {
		Name:  "POST …/verify",
		Match: cpPathHasSuffix("/verify"),
		Body: func(s *cpState, _ *http.Request) any {
			body := map[string]any{
				"identity_id": "ci-aws", "verified": s.opts.verified, "status": s.opts.verifyStatus,
			}
			if !s.opts.verified {
				body["error"] = "assume-role denied"
				body["missing_permissions"] = []string{"eks:CreateCluster", "iam:PassRole"}
			}
			return body
		},
	}}
}

// cpRunnerRoutes: the runner inventory, a deploy, and the linked cloud accounts.
func cpRunnerRoutes() []cpRoute {
	return []cpRoute{{
		Name:  "POST /api/cli/runners/deploy",
		Match: cpPathIs("/api/cli/runners/deploy"),
		Body: cpStatic(map[string]any{
			"runner": map[string]any{"id": "rn9", "name": "runner-ci"},
			"job":    map[string]any{"id": "j9", "status": "QUEUED", "created_at": miscTS},
		}),
	}, {
		Name:  "GET /api/cli/runners",
		Match: cpPathIs("/api/cli/runners"),
		Body: func(s *cpState, _ *http.Request) any {
			return map[string]any{"runners": s.list(s.opts.runners)}
		},
	}, {
		Name:  "DELETE /api/cli/runners/{id}",
		Match: cpPathHasPrefix("/api/cli/runners/"),
		Body:  cpStatic(map[string]any{}),
	}, {
		Name:  "GET /api/cli/cloud-identities",
		Match: cpPathIs("/api/cli/cloud-identities"),
		Body: func(s *cpState, _ *http.Request) any {
			return map[string]any{"cloud_identities": s.list(s.opts.identities)}
		},
	}, {
		Name:  "GET …/inventory",
		Match: cpPathHasSuffix("/inventory"),
		Body:  func(s *cpState, _ *http.Request) any { return miscInventory(s.opts.empty) },
	}}
}

// cpProjectRoutes: the configuration export.
func cpProjectRoutes() []cpRoute {
	return []cpRoute{{
		Name:  "GET …/export",
		Match: cpPathHasSuffix("/export"),
		Body:  cpStatic(map[string]any{"content": "project: web\n", "filename": "web.yaml", "format": "legacy-yaml"}),
	}}
}

// cpBreakglassRoutes: the audited break-glass surface.
func cpBreakglassRoutes() []cpRoute {
	return []cpRoute{{
		Name:  "POST …/breakglass/session",
		Match: cpPathHasSuffix("/breakglass/session"),
		Body:  cpStatic(map[string]any{"sessionId": "s1", "expiresAt": miscTS, "operator": "ops@x.com"}),
	}, {
		Name:  "POST …/breakglass/approval",
		Match: cpPathHasSuffix("/breakglass/approval"),
		Body:  cpStatic(map[string]any{"approvalId": "ap1", "note": "pass --approval ap1", "expiresAt": miscTS}),
	}, {
		Name:  "POST …/breakglass/execute",
		Match: cpPathHasSuffix("/breakglass/execute"),
		Body:  cpStatic(map[string]any{"ok": true, "detail": "action executed"}),
	}}
}

// cpJobRoutes: the job list, one job, its logs and its cancellation.
func cpJobRoutes() []cpRoute {
	return []cpRoute{{
		Name:  "GET …/logs",
		Match: cpPathHasSuffix("/logs"),
		Body: func(s *cpState, _ *http.Request) any {
			return map[string]any{"logs": s.list([]map[string]any{
				{"id": 1, "job_id": "j1", "log_chunk": "planning\n", "stream_type": "STDOUT"},
				{"id": 2, "job_id": "j1", "log_chunk": "warning: drift\n", "stream_type": "STDERR"},
				{"id": 3, "job_id": "j1", "log_chunk": "runner claimed\n", "stream_type": "SYSTEM"},
			})}
		},
	}, {
		Name:  "POST …/cancel",
		Match: cpPathHasSuffix("/cancel"),
		Body:  cpStatic(map[string]any{}),
	}, {
		Name:  "POST /api/jobs",
		Match: cpPathIs("/api/jobs", http.MethodPost),
		Body: cpStatic(map[string]any{"job": map[string]any{
			"id": "j9", "job_type": "DESTROY_RUNNER", "status": "QUEUED", "created_at": miscTS,
		}}),
	}, {
		Name:  "GET /api/jobs",
		Match: cpPathIs("/api/jobs"),
		Body: func(s *cpState, _ *http.Request) any {
			return map[string]any{
				"jobs":  s.list([]map[string]any{{"id": "j1", "job_type": "PLAN", "status": "SUCCESS", "created_at": miscTS}}),
				"total": miscJobTotal(s.opts.empty), "limit": 20, "offset": 0,
			}
		},
	}, {
		Name:  "GET /api/cli/jobs/{id}",
		Match: cpPathHasPrefix("/api/cli/jobs/"),
		Body: func(s *cpState, _ *http.Request) any {
			s.jobPolls++
			status := s.opts.jobStatus
			if s.opts.jobStatusAfter != "" && s.jobPolls > 1 {
				status = s.opts.jobStatusAfter
			}
			return map[string]any{
				"id": "j1", "job_type": "DEPLOY_RUNNER", "status": status,
				"created_at": miscTS, "updated_at": miscTS,
				"error_message":      "the template did not apply",
				"execution_metadata": map[string]any{"cost_breakdown": "€72/mo"},
				"config_snapshot":    map[string]any{},
			}
		},
	}}
}

// --- the server ------------------------------------------------------------------------------

// cpServer stands up the registered fake control plane and returns it. The caller closes it.
//
// failOn is applied ahead of the registry rather than as a route, because it is not an endpoint —
// it is a posture the whole control plane takes, and expressing it as a route would mean every pack
// had to remember to honour it.
func cpServer(t *testing.T, o miscAdminOpts) *httptest.Server {
	t.Helper()
	state := &cpState{opts: o}
	routes := cpRoutes()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		write := func(v any) { _ = json.NewEncoder(w).Encode(v) }

		if o.failOn != "" && strings.Contains(r.URL.Path, o.failOn) {
			w.WriteHeader(http.StatusInternalServerError)
			write(map[string]string{"error": "control plane refused"})
			return
		}
		for _, route := range routes {
			if route.Match(r) {
				write(route.Body(state, r))
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
		write(map[string]string{
			"error": "no route registered for " + r.Method + " " + r.URL.Path +
				" — add it to a pack in fake_cp_test.go. Registered: " +
				strings.Join(cpRouteNames(routes), ", "),
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// cpRouteNames lists the registry, for the 404 body and for the guards below.
func cpRouteNames(routes []cpRoute) []string {
	out := make([]string, len(routes))
	for i, r := range routes {
		out[i] = r.Name
	}
	return out
}

// TestFakeCp_TheRegistryIsWellFormed pins the registry itself.
//
// It is the "nothing found is not nothing wrong" case for a fake: an empty registry, or a pack that
// silently returned no routes after a bad merge, would leave every command in the admin suite
// hitting the 404 arm — which several of those tests assert as a FATAL path and would therefore
// still pass. The registry has to be checked directly, because the suite cannot see it.
func TestFakeCp_TheRegistryIsWellFormed(t *testing.T) {
	if len(cpRoutePacks) == 0 {
		t.Fatal("no route packs are registered")
	}
	routes := cpRoutes()
	if len(routes) < len(cpRoutePacks) {
		t.Fatalf("%d packs produced only %d routes — a pack returned nothing",
			len(cpRoutePacks), len(routes))
	}
	for i, pack := range cpRoutePacks {
		if len(pack()) == 0 {
			t.Errorf("route pack %d contributed no routes", i)
		}
	}

	seen := map[string]int{}
	for _, r := range routes {
		if r.Name == "" {
			t.Error("a route has no name — the 404 that lists the registry would show a blank")
		}
		if r.Match == nil || r.Body == nil {
			t.Errorf("route %q is not runnable (Match=%v Body=%v)", r.Name, r.Match != nil, r.Body != nil)
		}
		seen[r.Name]++
	}
	var dupes []string
	for name, n := range seen {
		if n > 1 {
			dupes = append(dupes, name)
		}
	}
	sort.Strings(dupes)
	if len(dupes) > 0 {
		t.Errorf("two packs registered the same endpoint, so the second is unreachable: %v", dupes)
	}
}

// TestFakeCp_OrderSensitiveRoutesStillResolve pins the three pairs where a prefix route would
// swallow a more specific one if the packs were ever reordered inside themselves.
//
// Each pair is a real ambiguity in the paths the CLI actually calls, and each was an ORDERED case
// of the switch this registry replaced — the property that made the switch correct is invisible in
// a list, so it is asserted rather than assumed.
func TestFakeCp_OrderSensitiveRoutesStillResolve(t *testing.T) {
	routes := cpRoutes()
	resolve := func(method, path string) string {
		req, err := http.NewRequest(method, "http://cp"+path, nil)
		if err != nil {
			t.Fatalf("build request: %v", err)
		}
		for _, r := range routes {
			if r.Match(req) {
				return r.Name
			}
		}
		return "<unregistered>"
	}
	cases := []struct{ method, path, want string }{
		{http.MethodPost, "/api/cli/runners/deploy", "POST /api/cli/runners/deploy"},
		{http.MethodDelete, "/api/cli/runners/rn1", "DELETE /api/cli/runners/{id}"},
		{http.MethodPost, "/api/cli/grants", "POST /api/cli/grants"},
		{http.MethodGet, "/api/cli/grants", "GET /api/cli/grants"},
		{http.MethodPost, "/api/cli/roles", "POST /api/cli/roles"},
		{http.MethodGet, "/api/cli/roles", "GET /api/cli/roles"},
		{http.MethodPost, "/api/jobs", "POST /api/jobs"},
		{http.MethodGet, "/api/jobs", "GET /api/jobs"},
		{http.MethodGet, "/api/cli/jobs/j1/logs", "GET …/logs"},
		{http.MethodGet, "/api/cli/orgs/o1/teams", "GET …/teams"},
		{http.MethodPost, "/api/cli/orgs/o1/teams", "POST …/teams"},
	}
	for _, tc := range cases {
		if got := resolve(tc.method, tc.path); got != tc.want {
			t.Errorf("%s %s resolved to %q, want %q", tc.method, tc.path, got, tc.want)
		}
	}
}
