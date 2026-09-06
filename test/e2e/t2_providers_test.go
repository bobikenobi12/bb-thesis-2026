// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Untagged unit proof for the T2 provider table (BYOC A0.1): every provider row's
// credential detection, region default + override, timeout defaults, the REQUIRE=1
// fatal-vs-skip decision, and the ALETHIA_E2E_CLUSTER_JSON merge (valid + malformed)
// are exercised WITHOUT a cloud, a token, or the e2e_t2 build tag — so a bare
// `go test ./...` in test/e2e catches a regression in the seam before the nightly does.
//
// The keystone is TestT2HetznerPathUnchanged: it asserts the hetzner row, resolved from
// EXACTLY the env the current nightly sets, produces the effective config the nightly is
// expected to run with (region nbg1, cluster-ready "8m", wait 40m, overall ctx 56m30s) — so
// the row cannot drift by accident. The wait was 25m until the `imager_image` snapshot
// deadline blew twice; see that test for why it moved.
package e2e

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// allCredEnvVars is every credential env var any provider row reads. Each test clears
// them all first (t.Setenv "") so an ambient AWS_*/ARM_* on the developer's shell or the
// CI runner cannot leak into a "creds absent" assertion.
var allCredEnvVars = []string{
	"HCLOUD_TOKEN", "HETZNER_S3_ACCESS_KEY", "HETZNER_S3_SECRET_KEY",
	"ALETHIA_E2E_AWS_READY", "AWS_ACCESS_KEY_ID", "AWS_ROLE_ARN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"ARM_CLIENT_ID", "ARM_TENANT_ID", "ARM_SUBSCRIPTION_ID",
	"ALICLOUD_ACCESS_KEY", "ALICLOUD_OIDC_TOKEN_FILE", "ALICLOUD_ROLE_ARN",
}

// allResolutionEnvVars is every env knob the resolvers read, cleared before each test so
// the row default is what's under test unless the case sets an override.
var allResolutionEnvVars = []string{
	"ALETHIA_E2E_REGION", "ALETHIA_E2E_HCLOUD_REGION",
	"ALETHIA_CLUSTER_READY_TIMEOUT", "ALETHIA_E2E_T2_WAIT",
	"ALETHIA_E2E_T2_REQUIRE", "ALETHIA_E2E_CLUSTER_JSON",
	"ALETHIA_E2E_NETWORK_JSON",
	"ALETHIA_E2E_ARGO_TIMEOUT",
	// The hetzner row's credential gate is dimension-aware (the `bucket` kind only exists on a
	// max-config run), so the dimension switches have to be cleared like any other resolver input.
	"ALETHIA_E2E_MAX_CONFIG", "ALETHIA_E2E_ALL_ADDONS",
}

// clearT2Env blanks every credential + resolution env var for a hermetic subtest.
func clearT2Env(t *testing.T) {
	t.Helper()
	for _, k := range allCredEnvVars {
		t.Setenv(k, "")
	}
	for _, k := range allResolutionEnvVars {
		t.Setenv(k, "")
	}
}

// TestT2ProviderTableComplete pins the exact rows the table must expose, so a dropped or
// renamed provider fails loudly.
func TestT2ProviderTableComplete(t *testing.T) {
	want := map[string]struct {
		region       string
		clusterReady string
		waitTimeout  time.Duration
	}{
		"hetzner": {"nbg1", "8m", 40 * time.Minute},
		"aws":     {"us-east-1", "15m", 50 * time.Minute},
		"gcp":     {"europe-west3-a", "15m", 50 * time.Minute},
		"azure":   {"westeurope", "15m", 50 * time.Minute},
		"alibaba": {"eu-central-1", "15m", 50 * time.Minute},
	}
	if len(t2ProviderTable) != len(want) {
		t.Fatalf("provider table has %d rows, want %d (%s)", len(t2ProviderTable), len(want), t2SupportedProviders())
	}
	for name, w := range want {
		p, ok := t2LookupProvider(name)
		if !ok {
			t.Fatalf("provider %q missing from the table", name)
		}
		if p.defaultRegion != w.region {
			t.Errorf("%s default region = %q, want %q", name, p.defaultRegion, w.region)
		}
		if p.clusterReadyTimeout != w.clusterReady {
			t.Errorf("%s cluster-ready timeout = %q, want %q", name, p.clusterReadyTimeout, w.clusterReady)
		}
		if p.waitTimeout != w.waitTimeout {
			t.Errorf("%s wait timeout = %v, want %v", name, p.waitTimeout, w.waitTimeout)
		}
	}
	if _, ok := t2LookupProvider("digitalocean"); ok {
		t.Fatal("t2LookupProvider returned ok for an unknown provider")
	}
}

// TestT2CredsPresent drives each row's credential detector through its present + absent
// shapes (including alibaba's key-OR-OIDC alternatives and aws's ready-AND-handle pair).
func TestT2CredsPresent(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		env      map[string]string
		wantOK   bool
	}{
		{"hetzner present", "hetzner", map[string]string{"HCLOUD_TOKEN": "tok"}, true},
		{"hetzner absent", "hetzner", nil, false},

		// FULL BAR adds the `bucket` kind, which is real Hetzner Object Storage behind the
		// aminueza/minio provider — a credential pair HCLOUD_TOKEN cannot stand in for, that
		// Hetzner has no API to mint, and that nothing used to check. The gate cleared on the API
		// token alone and the leg died at the bucket having already provisioned a whole cluster.
		{"hetzner full-bar with S3 keys", "hetzner", map[string]string{
			"HCLOUD_TOKEN": "tok", "ALETHIA_E2E_MAX_CONFIG": "1",
			"HETZNER_S3_ACCESS_KEY": "ak", "HETZNER_S3_SECRET_KEY": "sk",
		}, true},
		{"hetzner full-bar missing BOTH S3 keys", "hetzner", map[string]string{
			"HCLOUD_TOKEN": "tok", "ALETHIA_E2E_MAX_CONFIG": "1",
		}, false},
		{"hetzner full-bar missing the S3 secret key", "hetzner", map[string]string{
			"HCLOUD_TOKEN": "tok", "ALETHIA_E2E_MAX_CONFIG": "1", "HETZNER_S3_ACCESS_KEY": "ak",
		}, false},
		{"hetzner full-bar missing the S3 access key", "hetzner", map[string]string{
			"HCLOUD_TOKEN": "tok", "ALETHIA_E2E_MAX_CONFIG": "1", "HETZNER_S3_SECRET_KEY": "sk",
		}, false},
		// …and the FLOOR run must not gain a new prerequisite: it seeds no bucket, so the minio
		// provider is declared and never exercised. Gating the cheap nightly on a credential it
		// does not use would be its own kind of dishonesty.
		{"hetzner floor needs no S3 keys", "hetzner", map[string]string{"HCLOUD_TOKEN": "tok"}, true},
		{"hetzner all-addons alone is not full bar", "hetzner", map[string]string{
			"HCLOUD_TOKEN": "tok", "ALETHIA_E2E_ALL_ADDONS": "1",
		}, true},

		{"aws ready+key", "aws", map[string]string{"ALETHIA_E2E_AWS_READY": "1", "AWS_ACCESS_KEY_ID": "AKIA"}, true},
		{"aws ready+role", "aws", map[string]string{"ALETHIA_E2E_AWS_READY": "true", "AWS_ROLE_ARN": "arn:aws:iam::1:role/x"}, true},
		{"aws ready no handle", "aws", map[string]string{"ALETHIA_E2E_AWS_READY": "1"}, false},
		{"aws handle not ready", "aws", map[string]string{"AWS_ACCESS_KEY_ID": "AKIA"}, false},
		{"aws absent", "aws", nil, false},

		{"gcp present", "gcp", map[string]string{"GOOGLE_APPLICATION_CREDENTIALS": "/tmp/key.json"}, true},
		{"gcp absent", "gcp", nil, false},

		{"azure complete", "azure", map[string]string{"ARM_CLIENT_ID": "c", "ARM_TENANT_ID": "t", "ARM_SUBSCRIPTION_ID": "s"}, true},
		{"azure partial", "azure", map[string]string{"ARM_CLIENT_ID": "c", "ARM_TENANT_ID": "t"}, false},
		{"azure absent", "azure", nil, false},

		{"alibaba static key", "alibaba", map[string]string{"ALICLOUD_ACCESS_KEY": "LTAI"}, true},
		{"alibaba oidc pair", "alibaba", map[string]string{"ALICLOUD_OIDC_TOKEN_FILE": "/tmp/tok", "ALICLOUD_ROLE_ARN": "acs:ram::1:role/x"}, true},
		{"alibaba oidc file only", "alibaba", map[string]string{"ALICLOUD_OIDC_TOKEN_FILE": "/tmp/tok"}, false},
		{"alibaba absent", "alibaba", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearT2Env(t)
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			p, ok := t2LookupProvider(tc.provider)
			if !ok {
				t.Fatalf("unknown provider %q", tc.provider)
			}
			gotOK, msg := p.credsPresent()
			if gotOK != tc.wantOK {
				t.Fatalf("credsPresent = %v, want %v", gotOK, tc.wantOK)
			}
			if !gotOK && msg == "" {
				t.Error("a missing-creds decision must carry a non-empty message")
			}
		})
	}
}

// TestHetznerFullBarCredsMessageNamesTheS3Pair pins WHAT the refusal says, not just that it refuses.
// The whole value of a pre-spend gate is that the human reading a red nightly at 05:00 knows which
// two secrets to create — and these two cannot be derived from anything else the run holds, because
// Hetzner has no API that mints them.
func TestHetznerFullBarCredsMessageNamesTheS3Pair(t *testing.T) {
	clearT2Env(t)
	t.Setenv("HCLOUD_TOKEN", "tok")
	t.Setenv("ALETHIA_E2E_MAX_CONFIG", "1")

	hz, ok := t2LookupProvider("hetzner")
	if !ok {
		t.Fatal("hetzner row missing from the provider table")
	}
	okCreds, msg := hz.credsPresent()
	if okCreds {
		t.Fatal("a full-bar hetzner run without the Object Storage keys must NOT pass the credential gate: the `bucket` kind is CarriedByTofu, so the run would provision a cluster and then fail at the bucket")
	}
	for _, name := range hetznerS3CredEnv {
		if !strings.Contains(msg, name) {
			t.Errorf("the refusal must name %q so the fix is actionable from the log alone; got: %s", name, msg)
		}
	}
}

// TestHetznerBucketCellHasNoUnprovenEscape is the structural half of the same guarantee: there must
// be no verdict under which a hetzner run reports success while `bucket` was never proven. The cell
// is CarriedByTofu, and AssertMaxConfigKindsInState requires a CarriedByTofu kind's resource to be
// in state — no exclusion, no "skipped", no soft path. If someone were to soften the credential gate
// by re-verdicting the cell instead, this fails.
func TestHetznerBucketCellHasNoUnprovenEscape(t *testing.T) {
	for _, k := range MaxConfigKinds {
		if k.Kind != "bucket" {
			continue
		}
		cell, ok := k.Cell("hetzner")
		if !ok {
			t.Fatal("bucket has no hetzner column")
		}
		if cell.Carriage != CarriedByTofu {
			t.Fatalf("hetzner's bucket cell is %q, want %q — Object Storage is a REAL Hetzner product that a real apply must create. "+
				"If this was softened to avoid needing HETZNER_S3_ACCESS_KEY/HETZNER_S3_SECRET_KEY, that trades a loud pre-spend failure for a run that reports green having proven nothing about buckets.",
				cell.Carriage, CarriedByTofu)
		}
		return
	}
	t.Fatal("no bucket kind in MaxConfigKinds — this guard has stopped guarding anything")
}

// TestT2ResolveRegion covers the default, the generalized override, the hetzner-only
// legacy fallback, and that the legacy name is IGNORED for the other clouds.
func TestT2ResolveRegion(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		env      map[string]string
		want     string
	}{
		{"hetzner default", "hetzner", nil, "nbg1"},
		{"hetzner legacy fallback", "hetzner", map[string]string{"ALETHIA_E2E_HCLOUD_REGION": "fsn1"}, "fsn1"},
		{"hetzner generalized wins over legacy", "hetzner", map[string]string{"ALETHIA_E2E_REGION": "hel1", "ALETHIA_E2E_HCLOUD_REGION": "fsn1"}, "hel1"},
		{"aws default", "aws", nil, "us-east-1"},
		{"aws override", "aws", map[string]string{"ALETHIA_E2E_REGION": "eu-west-2"}, "eu-west-2"},
		{"aws ignores legacy hcloud name", "aws", map[string]string{"ALETHIA_E2E_HCLOUD_REGION": "fsn1"}, "us-east-1"},
		{"gcp default", "gcp", nil, "europe-west3-a"},
		{"azure default", "azure", nil, "westeurope"},
		{"alibaba override", "alibaba", map[string]string{"ALETHIA_E2E_REGION": "ap-southeast-1"}, "ap-southeast-1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearT2Env(t)
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			p, _ := t2LookupProvider(tc.provider)
			if got := resolveT2Region(p); got != tc.want {
				t.Fatalf("resolveT2Region = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestT2ResolveTimeouts covers the per-provider defaults and the env overrides for both
// the cluster-ready string and the WaitTerminal duration.
func TestT2ResolveTimeouts(t *testing.T) {
	t.Run("defaults", func(t *testing.T) {
		clearT2Env(t)
		hz, _ := t2LookupProvider("hetzner")
		aws, _ := t2LookupProvider("aws")
		if got := resolveT2ClusterReadyTimeout(hz); got != "8m" {
			t.Errorf("hetzner cluster-ready = %q, want 8m", got)
		}
		if got := resolveT2WaitTimeout(hz); got != 40*time.Minute {
			t.Errorf("hetzner wait = %v, want 40m", got)
		}
		if got := resolveT2ClusterReadyTimeout(aws); got != "15m" {
			t.Errorf("aws cluster-ready = %q, want 15m", got)
		}
		if got := resolveT2WaitTimeout(aws); got != 50*time.Minute {
			t.Errorf("aws wait = %v, want 50m", got)
		}
	})
	t.Run("overrides win", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_CLUSTER_READY_TIMEOUT", "20m")
		t.Setenv("ALETHIA_E2E_T2_WAIT", "70m")
		hz, _ := t2LookupProvider("hetzner")
		if got := resolveT2ClusterReadyTimeout(hz); got != "20m" {
			t.Errorf("override cluster-ready = %q, want 20m", got)
		}
		if got := resolveT2WaitTimeout(hz); got != 70*time.Minute {
			t.Errorf("override wait = %v, want 70m", got)
		}
	})
	t.Run("malformed wait falls back to default", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_E2E_T2_WAIT", "not-a-duration")
		hz, _ := t2LookupProvider("hetzner")
		if got := resolveT2WaitTimeout(hz); got != 40*time.Minute {
			t.Errorf("malformed override wait = %v, want the 40m default", got)
		}
	})
}

// TestT2RequireDecision proves ALETHIA_E2E_T2_REQUIRE flips a missing prerequisite from
// a clean skip (unset) to a HARD FAIL (truthy) — the vacuity defense.
func TestT2RequireDecision(t *testing.T) {
	cases := []struct {
		val  string
		hard bool
	}{
		{"", false}, {"0", false}, {"false", false}, {"no", false},
		{"1", true}, {"true", true}, {"yes", true}, {"on", true}, {"TRUE", true},
	}
	for _, tc := range cases {
		t.Run("REQUIRE="+tc.val, func(t *testing.T) {
			clearT2Env(t)
			t.Setenv("ALETHIA_E2E_T2_REQUIRE", tc.val)
			if got := t2RequireIsHard(); got != tc.hard {
				t.Fatalf("t2RequireIsHard(%q) = %v, want %v", tc.val, got, tc.hard)
			}
		})
	}
}

// TestT2MergeClusterJSON covers the no-op (absent env), a valid object merge into an
// empty and a pre-seeded cluster block, and — the vacuity defense — that malformed or
// non-object JSON is a LOUD error rather than a silent wrong-shape provision.
func TestT2MergeClusterJSON(t *testing.T) {
	t.Run("absent is a no-op", func(t *testing.T) {
		clearT2Env(t)
		snap := map[string]any{"provider": "aws"}
		if err := t2MergeClusterJSON(snap); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if _, ok := snap["cluster"]; ok {
			t.Error("absent CLUSTER_JSON must not add a cluster block")
		}
	})
	t.Run("valid object merges into empty snapshot", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_E2E_CLUSTER_JSON", `{"instance_types":["t3.small"],"node_desired_size":2}`)
		snap := map[string]any{"provider": "aws"}
		if err := t2MergeClusterJSON(snap); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		cluster, ok := snap["cluster"].(map[string]any)
		if !ok {
			t.Fatalf("cluster block missing/wrong type: %#v", snap["cluster"])
		}
		if got := cluster["node_desired_size"]; got != float64(2) {
			t.Errorf("node_desired_size = %v, want 2", got)
		}
		types, ok := cluster["instance_types"].([]any)
		if !ok || len(types) != 1 || types[0] != "t3.small" {
			t.Errorf("instance_types = %#v, want [t3.small]", cluster["instance_types"])
		}
	})
	t.Run("merges over a pre-seeded cluster block", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_E2E_CLUSTER_JSON", `{"node_desired_size":3}`)
		snap := map[string]any{
			"cluster": map[string]any{"cluster_version": "1.30", "node_desired_size": float64(1)},
		}
		if err := t2MergeClusterJSON(snap); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		cluster := snap["cluster"].(map[string]any)
		if cluster["cluster_version"] != "1.30" {
			t.Errorf("pre-seeded key was dropped: %#v", cluster)
		}
		if cluster["node_desired_size"] != float64(3) {
			t.Errorf("override did not win: node_desired_size = %v", cluster["node_desired_size"])
		}
	})
	t.Run("malformed JSON is a loud error", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_E2E_CLUSTER_JSON", `{not valid json`)
		if err := t2MergeClusterJSON(map[string]any{}); err == nil {
			t.Fatal("malformed CLUSTER_JSON must be a loud error, got nil")
		}
	})
	t.Run("non-object JSON is a loud error", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_E2E_CLUSTER_JSON", `[1,2,3]`)
		if err := t2MergeClusterJSON(map[string]any{}); err == nil {
			t.Fatal("a JSON array must be rejected (cluster override must be an object)")
		}
	})
}

// TestT2MergeAzureAdminGroup covers the A2.2 AKS self-admin wiring: non-azure and absent env are
// no-ops; for azure it lands the object id at cluster.provider_config.aks_admin_group_object_ids;
// and it APPENDS (deduped) to any id already supplied via ALETHIA_E2E_CLUSTER_JSON.
func TestT2MergeAzureAdminGroup(t *testing.T) {
	const oid = "11111111-1111-1111-1111-111111111111"

	t.Run("non-azure is a no-op", func(t *testing.T) {
		t.Setenv("ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID", oid)
		snap := map[string]any{"provider": "aws"}
		t2MergeAzureAdminGroup(snap, "aws")
		if _, ok := snap["cluster"]; ok {
			t.Error("non-azure provider must not add a cluster block")
		}
	})
	t.Run("absent env is a no-op", func(t *testing.T) {
		t.Setenv("ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID", "")
		snap := map[string]any{"provider": "azure"}
		t2MergeAzureAdminGroup(snap, "azure")
		if _, ok := snap["cluster"]; ok {
			t.Error("absent env must not add a cluster block")
		}
	})
	t.Run("azure lands the object id in provider_config", func(t *testing.T) {
		t.Setenv("ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID", oid)
		snap := map[string]any{"provider": "azure"}
		t2MergeAzureAdminGroup(snap, "azure")
		pc := snap["cluster"].(map[string]any)["provider_config"].(map[string]any)
		ids, ok := pc["aks_admin_group_object_ids"].([]any)
		if !ok || len(ids) != 1 || ids[0] != oid {
			t.Fatalf("aks_admin_group_object_ids = %#v, want [%s]", pc["aks_admin_group_object_ids"], oid)
		}
	})
	t.Run("appends deduped to a cluster-json-supplied id", func(t *testing.T) {
		const other = "22222222-2222-2222-2222-222222222222"
		t.Setenv("ALETHIA_E2E_AZURE_ADMIN_GROUP_OBJECT_ID", oid)
		snap := map[string]any{
			"cluster": map[string]any{
				"provider_config": map[string]any{
					"aks_admin_group_object_ids": []any{other, oid}, // oid already present ⇒ deduped
				},
			},
		}
		t2MergeAzureAdminGroup(snap, "azure")
		ids := snap["cluster"].(map[string]any)["provider_config"].(map[string]any)["aks_admin_group_object_ids"].([]any)
		if len(ids) != 2 || ids[0] != other || ids[1] != oid {
			t.Fatalf("aks_admin_group_object_ids = %#v, want [%s %s] (deduped, appended)", ids, other, oid)
		}
	})
}

// TestT2MergeNetworkJSON covers the network-block sibling of the cluster merge: the no-op
// (absent env), a valid object merge into empty + pre-seeded network blocks, and the loud
// error on malformed / non-object JSON.
func TestT2MergeNetworkJSON(t *testing.T) {
	t.Run("absent is a no-op", func(t *testing.T) {
		clearT2Env(t)
		snap := map[string]any{"provider": "aws"}
		if err := t2MergeNetworkJSON(snap); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if _, ok := snap["network"]; ok {
			t.Error("absent NETWORK_JSON must not add a network block")
		}
	})
	t.Run("single_nat_gateway merges into empty snapshot", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_E2E_NETWORK_JSON", `{"single_nat_gateway":true}`)
		snap := map[string]any{"provider": "aws"}
		if err := t2MergeNetworkJSON(snap); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		network, ok := snap["network"].(map[string]any)
		if !ok {
			t.Fatalf("network block missing/wrong type: %#v", snap["network"])
		}
		if network["single_nat_gateway"] != true {
			t.Errorf("single_nat_gateway = %v, want true", network["single_nat_gateway"])
		}
	})
	t.Run("merges over a pre-seeded network block", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_E2E_NETWORK_JSON", `{"single_nat_gateway":true}`)
		snap := map[string]any{
			"network": map[string]any{"network_cidr": "10.0.0.0/16", "single_nat_gateway": false},
		}
		if err := t2MergeNetworkJSON(snap); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		network := snap["network"].(map[string]any)
		if network["network_cidr"] != "10.0.0.0/16" {
			t.Errorf("pre-seeded key was dropped: %#v", network)
		}
		if network["single_nat_gateway"] != true {
			t.Errorf("override did not win: single_nat_gateway = %v", network["single_nat_gateway"])
		}
	})
	t.Run("malformed JSON is a loud error", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_E2E_NETWORK_JSON", `{not valid json`)
		if err := t2MergeNetworkJSON(map[string]any{}); err == nil {
			t.Fatal("malformed NETWORK_JSON must be a loud error, got nil")
		}
	})
	t.Run("non-object JSON is a loud error", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_E2E_NETWORK_JSON", `[1,2,3]`)
		if err := t2MergeNetworkJSON(map[string]any{}); err == nil {
			t.Fatal("a JSON array must be rejected (network override must be an object)")
		}
	})
}

// TestT2HetznerPathUnchanged is the keystone guard on the hetzner row: resolving it from EXACTLY
// the env the nightly sets must produce the config below, so an edit that drifts any of these
// fails here rather than in tonight's nightly. It also proves ALETHIA_E2E_REGION=nbg1 leaves the
// resolved region identical.
//
// The wait was 25m and the ctx 40m — the values the pre-table hard-coded path used, pinned here so
// the table could be proven bit-for-bit equivalent to it. That equivalence has now been
// DELIBERATELY broken: `imager_image` blew a 15m snapshot deadline twice (#2458, and the scheduled
// floor run 33080748841), so image.tf's create timeout is 25m and this wait has to contain it. See
// the hetzner row in t2_providers.go for the arithmetic.
//
// The pin stays a pin. What this guard is worth is that the number cannot move by ACCIDENT — the
// answer to a deliberate change is to update it here and say why, never to relax the assertion.
func TestT2HetznerPathUnchanged(t *testing.T) {
	hz, ok := t2LookupProvider("hetzner")
	if !ok {
		t.Fatal("hetzner row missing")
	}

	const (
		wantRegion       = "nbg1"
		wantClusterReady = "8m"
		wantWait         = 40 * time.Minute
		// deploy wait 40m + argo 12m30s + 7m headroom. The argo term was 8m until #3580: the lean
		// tier derived its budget from ZERO add-on charts while converging three — the ungated
		// external-secrets-operator, the reloader every tier seeds, and metrics-server where it
		// renders — so it bought argoBudgetBase's time for argoBudgetBase's work plus three real
		// upstream charts. Written out rather than recomputed from argoBudgetFor here on purpose:
		// a literal is the only version of this number that can disagree with the derivation and
		// say so.
		//
		// Containment is unaffected: the failing gcp leg of run 33487970328 reported
		// "ctx 1h18m0s < go 2h8m0s < step 2h13m0s < job 2h28m0s", so 4m30s more sits far inside
		// every rung, and TestArgoBudgetCeilingFitsTheWorkflowCaps still proves the ceiling itself.
		wantOverallCtx = 59*time.Minute + 30*time.Second
	)

	t.Run("current workflow env (legacy region name)", func(t *testing.T) {
		clearT2Env(t)
		// Exactly what e2e-nightly.yml sets today for the hetzner matrix row.
		t.Setenv("HCLOUD_TOKEN", "fake-token-value")
		t.Setenv("ALETHIA_E2E_HCLOUD_REGION", "nbg1")
		t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")

		if credsOK, _ := hz.credsPresent(); !credsOK {
			t.Fatal("hetzner creds should be present with HCLOUD_TOKEN set")
		}
		if got := resolveT2Region(hz); got != wantRegion {
			t.Errorf("region = %q, want %q", got, wantRegion)
		}
		if got := resolveT2ClusterReadyTimeout(hz); got != wantClusterReady {
			t.Errorf("cluster-ready = %q, want %q", got, wantClusterReady)
		}
		wait := resolveT2WaitTimeout(hz)
		if wait != wantWait {
			t.Errorf("wait = %v, want %v", wait, wantWait)
		}
		if got := wait + ArgoAssertTimeout() + 7*time.Minute; got != wantOverallCtx {
			t.Errorf("overall ctx = %v, want %v", got, wantOverallCtx)
		}
		if !t2RequireIsHard() {
			t.Error("REQUIRE=1 must make a missing prereq a hard fail")
		}
	})

	t.Run("new workflow env (generalized region name) is identical", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("HCLOUD_TOKEN", "fake-token-value")
		t.Setenv("ALETHIA_E2E_REGION", "nbg1") // what this PR adds to the workflow
		t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")

		if got := resolveT2Region(hz); got != wantRegion {
			t.Errorf("region = %q, want %q", got, wantRegion)
		}
		if got := resolveT2ClusterReadyTimeout(hz); got != wantClusterReady {
			t.Errorf("cluster-ready = %q, want %q", got, wantClusterReady)
		}
		if got := resolveT2WaitTimeout(hz); got != wantWait {
			t.Errorf("wait = %v, want %v", got, wantWait)
		}
	})
}

// TestT2ValidateClusterName pins the per-provider cluster-name check (BYOC A0.1 seam for
// the AWS/GCP/Azure waves): Talos/ACK are an exact `<project>-<env>`; EKS/GKE/AKS are the
// `<kind>-<regionShort>-<env>-<project>` shape asserted by kind-prefix + unique suffix.
// The negative cases prove it is NOT vacuous — a stale/misnamed/wrong-kind name fails.
func TestT2ValidateClusterName(t *testing.T) {
	const project, env = "alethia-nl", "12345-1"
	cases := []struct {
		name          string
		provider, got string
		wantOK        bool
	}{
		// Bare-name clouds (exact match, mirrors the runner label).
		{"hetzner exact", "hetzner", "alethia-nl-12345-1", true},
		{"alibaba exact", "alibaba", "alethia-nl-12345-1", true},
		{"hetzner wrong", "hetzner", "alethia-nl-99999-9", false},
		{"hetzner empty", "hetzner", "", false},
		// EKS/GKE/AKS: kind prefix + unique `-<env>-<project>` suffix, any regionShort.
		{"aws ue1", "aws", "eks-ue1-12345-1-alethia-nl", true},
		{"aws ec1", "aws", "eks-ec1-12345-1-alethia-nl", true},
		{"gcp ew3", "gcp", "gke-ew3-12345-1-alethia-nl", true},
		{"azure gwc", "azure", "aks-gwc-12345-1-alethia-nl", true},
		// Non-vacuity: wrong kind, wrong run (stale), missing suffix, empty.
		{"aws wrong kind", "aws", "gke-ue1-12345-1-alethia-nl", false},
		{"aws stale env", "aws", "eks-ue1-99999-9-alethia-nl", false},
		{"aws wrong project", "aws", "eks-ue1-12345-1-other", false},
		{"aws no suffix", "aws", "eks-ue1", false},
		{"aws empty", "aws", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := t2ValidateClusterName(tc.provider, project, env, tc.got)
			if tc.wantOK && err != nil {
				t.Fatalf("t2ValidateClusterName(%s, %q) = %v, want ok", tc.provider, tc.got, err)
			}
			if !tc.wantOK && err == nil {
				t.Fatalf("t2ValidateClusterName(%s, %q) = ok, want error", tc.provider, tc.got)
			}
		})
	}
}

// TestT2RequireCostShape covers the cost guard (BYOC F4): managed clouds must pin a cheapest
// shape via ALETHIA_E2E_CLUSTER_JSON; missing it is fatal ONLY under REQUIRE. Hetzner is
// exempt (proven cents/run default).
func TestT2RequireCostShape(t *testing.T) {
	cases := []struct {
		name               string
		provider           string
		clusterJSON        string
		require            bool
		wantFatal, wantMsg bool
	}{
		{"aws no shape, require ⇒ fatal", "aws", "", true, true, true},
		{"aws no shape, local ⇒ warn only", "aws", "", false, false, true},
		{"aws with shape ⇒ ok", "aws", `{"instance_types":["t3.large"]}`, true, false, false},
		{"gcp no shape, require ⇒ fatal", "gcp", "", true, true, true},
		{"azure no shape, require ⇒ fatal", "azure", "", true, true, true},
		{"alibaba no shape, require ⇒ fatal", "alibaba", "", true, true, true},
		{"hetzner exempt (no shape, require)", "hetzner", "", true, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearT2Env(t)
			if tc.clusterJSON != "" {
				t.Setenv("ALETHIA_E2E_CLUSTER_JSON", tc.clusterJSON)
			}
			if tc.require {
				t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")
			}
			fatal, msg := t2RequireCostShape(tc.provider)
			if fatal != tc.wantFatal {
				t.Errorf("fatal = %v, want %v", fatal, tc.wantFatal)
			}
			if (msg != "") != tc.wantMsg {
				t.Errorf("msg present = %v, want %v (msg=%q)", msg != "", tc.wantMsg, msg)
			}
		})
	}
}

// TestT2SweeperNameMatchesRealScripts pins the sweeper table against the files on disk.
//
// The bug this replaces printed `hcloud-cleanup` on EVERY provider, so an aws run whose in-test
// destroy was interrupted pointed the reader at hetzner's script — at the exact moment they were
// diagnosing a possible leak.
//
// The first fix was worse than the bug in one case: deriving `<provider>-cleanup.sh` yields
// `hetzner-cleanup.sh`, which does not exist, because hetzner's sweeper is named after the API.
// So this asserts against the FILESYSTEM rather than against a naming rule — a table that drifts
// from the scripts is the same defect wearing a different name.
func TestT2SweeperNameMatchesRealScripts(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the test file")
	}
	dir := filepath.Join(filepath.Dir(thisFile), "..", "..", "scripts", "e2e")

	for provider := range t2ProviderTable {
		t.Run(provider, func(t *testing.T) {
			name := t2SweeperName(provider)
			if strings.HasPrefix(name, "(no sweeper") {
				t.Fatalf("every provider in the T2 table needs a sweeper mapping; %q has none", provider)
			}
			if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
				t.Errorf("t2SweeperName(%q) = %q, which is not a file in scripts/e2e: %v", provider, name, err)
			}
		})
	}

	t.Run("an unmapped provider does not get a plausible-looking path", func(t *testing.T) {
		got := t2SweeperName("nosuchcloud")
		if strings.HasSuffix(got, ".sh") {
			t.Errorf("an unknown provider must not be given something that reads as a script path, got %q", got)
		}
	})
}

// TestT2TeardownFailureLineNamesAnExpiredWindow is the offline proof for the only branch of the
// teardown that has ever run in anger, and the only one that cannot be reached without spending on
// a cloud.
//
// aws/floor run 33155063965 reported `tofu destroy failed: signal: interrupt` and it was read twice
// as a destroy that ERRORED. It was a destroy that was still working: terraform-exec cancels its
// child with SIGINT, so a window that runs out and a tofu that crashed produce the same sentence.
// The ctx's own error is the only thing that separates them, so the line is required to USE it.
//
// Probed in BOTH directions on purpose. A message that always mentioned the window would be just as
// wrong as one that never did — it would relabel every genuine destroy error as a timeout — so the
// non-expired case asserts the window is ABSENT, not merely that the error text survives.
func TestT2TeardownFailureLineNamesAnExpiredWindow(t *testing.T) {
	const window = 45 * time.Minute
	interrupted := errors.New("tofu destroy failed: signal: interrupt")

	t.Run("the window expired", func(t *testing.T) {
		got := t2TeardownFailureLine("aws", window, context.DeadlineExceeded, interrupted)
		for _, want := range []string{
			"WINDOW EXPIRED",
			"45m0s",
			"ALETHIA_E2E_T2_TEARDOWN",
			"teardownTimeout",
			"aws-cleanup.sh",
		} {
			if !strings.Contains(got, want) {
				t.Errorf("an expired teardown window must name %q; got:\n%s", want, got)
			}
		}
	})

	t.Run("the destroy reported its own error", func(t *testing.T) {
		derr := errors.New("error deleting EC2 Subnet: DependencyViolation: has dependencies and cannot be deleted")
		got := t2TeardownFailureLine("aws", window, nil, derr)
		if !strings.Contains(got, "DependencyViolation") {
			t.Errorf("a real destroy error must survive verbatim; got:\n%s", got)
		}
		if strings.Contains(got, "WINDOW EXPIRED") || strings.Contains(got, window.String()) {
			t.Errorf("a destroy that reported its own error must NOT be relabelled as a timeout; got:\n%s", got)
		}
		if !strings.Contains(got, "aws-cleanup.sh") {
			t.Errorf("the sweeper still has to be named; got:\n%s", got)
		}
	})

	t.Run("a cancelled ctx is not a deadline", func(t *testing.T) {
		// context.Canceled is what a caller-side cancel produces. It is NOT the window running out,
		// and reporting it as one would send the reader to widen a budget that was never the cause.
		got := t2TeardownFailureLine("aws", window, context.Canceled, interrupted)
		if strings.Contains(got, "WINDOW EXPIRED") {
			t.Errorf("context.Canceled is not a deadline; got:\n%s", got)
		}
	})

	t.Run("the sweeper follows the provider", func(t *testing.T) {
		got := t2TeardownFailureLine("gcp", window, context.DeadlineExceeded, interrupted)
		if !strings.Contains(got, "gcp-cleanup.sh") {
			t.Errorf("the expired-window line must name THIS cloud's sweeper; got:\n%s", got)
		}
		if strings.Contains(got, "aws-cleanup.sh") {
			t.Errorf("the expired-window line named the wrong cloud's sweeper; got:\n%s", got)
		}
	})
}

// TestT2TeardownWindowExceedsTheDeployProvidersOwnCeilings pins the RELATION the 45m exists for,
// rather than the number alone — the number is already pinned by TestT2ProviderTableTeardownBudgets.
//
// A managed destroy is not one wait; it is a serialized prelude (workdir + init + state pull +
// refresh + plan, ~9m20s measured on run 33155063965) followed by resources that each carry their
// cloud provider's OWN delete ceiling — 20m for an AWS subnet and internet gateway. A window shorter
// than prelude + ceiling can only ever end in SIGINT, which is the one outcome that names nothing.
// 30m was exactly that, and it was not obviously that: it looked generous.
//
// hetzner is excluded by NAME rather than by "whatever is under 30m": its teardown is 18 flat
// resources with no managed control plane in front of them, and a rule that silently skipped any
// short row would go quietly vacuous the moment a managed row was lowered.
func TestT2TeardownWindowExceedsTheDeployProvidersOwnCeilings(t *testing.T) {
	// Measured on aws/floor run 33155063965; see the teardownTimeout field comment. Each term is
	// separate because the SUM is the claim: a destroy reaches a verdict only after the prelude, plus
	// however late the long-pole resource starts, plus that resource's own ceiling.
	const (
		// workdir prep + `tofu init` + state pull + refresh of 130 resources + plan render, before
		// a single resource is deleted. Observed ~9m20s.
		preludeObserved = 10 * time.Minute
		// The VPC layer is not first: the subnets began deleting ~3m40s into the apply, behind the
		// node group and the ENI holders.
		longPoleStartOffset = 4 * time.Minute
		// The AWS provider's own delete ceiling for aws_subnet and aws_internet_gateway — the point
		// at which tofu stops retrying and returns the DependencyViolation naming what still holds
		// the subnet. This is the answer the window exists to let the harness receive.
		resourceCeiling  = 20 * time.Minute
		minManagedWindow = preludeObserved + longPoleStartOffset + resourceCeiling
	)
	managed := []string{"aws", "gcp", "azure", "alibaba"}

	var checked int
	for _, cloud := range managed {
		p, ok := t2LookupProvider(cloud)
		if !ok {
			t.Fatalf("no provider row for %q — this guard would silently stop covering it", cloud)
		}
		checked++
		if got := p.teardownTimeout; got < minManagedWindow {
			t.Errorf("%s teardown window is %s, which cannot contain a destroy that reaches its own "+
				"verdict: ~%s of workdir+init+refresh+plan before anything is deleted, +%s before the "+
				"long-pole resource even starts, + its provider's own %s delete ceiling = %s. Below "+
				"that the only reachable outcome is SIGINT, and `signal: interrupt` names no resource "+
				"and no cloud error (run 33155063965).",
				cloud, got, preludeObserved, longPoleStartOffset, resourceCeiling, minManagedWindow)
		}
	}
	if checked != len(managed) {
		t.Fatalf("checked %d of %d managed clouds", checked, len(managed))
	}

	// The window is only useful if the PROCESS deadline still contains it — a widened window that
	// the go-timeout does not reserve is killed by go instead of by the ctx, which loses even more.
	// TestT2BudgetReservesTeardownInGoTimeout proves the reservation tracks the window; this asserts
	// the reserved amount is at least what the relation above demands.
	for _, v := range T2BudgetScenarioEnv() {
		t.Setenv(v, "")
	}
	t.Setenv("ALETHIA_E2E_T2_TEARDOWN", "")
	for _, cloud := range managed {
		b, err := ResolveT2Budget(cloud, "ladder")
		if err != nil {
			t.Fatalf("%s: %v", cloud, err)
		}
		if reserved := b.GoTimeout - b.Ctx - t2GoTimeoutMargin; reserved < minManagedWindow {
			t.Errorf("%s reserves only %s of the process deadline for teardown, want at least %s\n  %s",
				cloud, reserved, minManagedWindow, b.Describe())
		}
	}
}
