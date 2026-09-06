// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W1 services CONTRACT-LOCK (#572), Go half. The console vitest
// (apps/console/tests/e2e-fixtures/w1-services-contract.test.ts) drives the REAL
// buildConfigSnapshot and freezes its emitted `services` wire into
// fixtures/w1_services.json; this untagged pure test proves that wire unmarshals into
// types.ProjectServiceConfig with no silent zero-filling — the same decode the runner's
// snapshotToProjectConfig performs for this subtree. Since #1962 that function REJECTS an unknown
// key at the snapshot root (and inside the hand-enumerated singletons like `cluster`) unless
// `consoleOnlySnapshotKeys` names it. Since #1974 it rejects one inside the component LISTS too:
// the console now emits an explicit pick of each `project_*` row instead of spreading it, so this
// fixture no longer carries the bookkeeping columns (id / project_id / status / created_at / …).
// What still tolerates them is `legacyComponentRowKeys` in apps/runner/internal/agent/runner.go —
// a CLOSED list, kept only because reconcile/drift/probe/reap/retry re-dispatch STORED pre-pick
// snapshots verbatim. TestSnapshotToProjectConfig_W1ServicesWireDecodes locks the decode in from
// the runner's side, and config_snapshot_components.aws.json covers all ten lists at once.
//
//   - Value asserts catch RENAME drift: a TS-side key rename regenerates the fixture, the Go
//     decode zero-fills the field, and the assert here reds until the Go struct catches up.
//   - The re-marshal key check catches Go-side ORPHAN drift: a Go field whose JSON tag the wire
//     no longer carries emits a key absent from the fixture (the maximal `web` service keeps
//     every omitempty field populated so every Go key is exercised).
package e2e

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// w1LoadServices decodes the shared fixture both bare and wrapped as a ProjectConfig, proving
// the top-level `services` key and returning the wrapped slice plus the raw per-service objects.
func w1LoadServices(t *testing.T) ([]types.ProjectServiceConfig, []map[string]json.RawMessage) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("fixtures", "w1_services.json"))
	if err != nil {
		t.Fatalf("read w1_services.json (regenerate: UPDATE_FIXTURES=1 pnpm -C apps/console run test w1-services-contract): %v", err)
	}
	var bare []types.ProjectServiceConfig
	if err := json.Unmarshal(raw, &bare); err != nil {
		t.Fatalf("fixture does not unmarshal into []ProjectServiceConfig: %v", err)
	}
	var cfg types.ProjectConfig
	if err := json.Unmarshal([]byte(`{"services":`+string(raw)+`}`), &cfg); err != nil {
		t.Fatalf("wrapped fixture does not unmarshal into ProjectConfig: %v", err)
	}
	if len(cfg.Services) != len(bare) {
		t.Fatalf("ProjectConfig.Services decoded %d services, bare decode %d", len(cfg.Services), len(bare))
	}
	var wires []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &wires); err != nil {
		t.Fatalf("fixture is not an array of objects: %v", err)
	}
	return cfg.Services, wires
}

func TestW1ServicesContract_FieldsSurviveDecode(t *testing.T) {
	services, _ := w1LoadServices(t)
	if len(services) != 2 {
		t.Fatalf("expected 2 services in the fixture, got %d", len(services))
	}

	web, worker := services[0], services[1]

	// web — the maximal repo-source deployment. Every zero value here means the wire key no
	// longer reaches the Go field (renamed/retyped upstream).
	if web.Name != "web" || web.Type != "deployment" {
		t.Errorf("web identity drifted: name=%q type=%q", web.Name, web.Type)
	}
	if web.CloudProvider != "hetzner" || web.CloudIdentityID != "ci-1" || web.Region != "nbg1" {
		t.Errorf("web resolved placement drifted: %+v", web.Placement)
	}
	if web.Source.Kind != "repo" || web.Source.RepoURL != "https://github.com/acme/web" || web.Source.Path != "apps/web" {
		t.Errorf("web source drifted: %+v", web.Source)
	}
	if web.Source.Image != "" {
		t.Errorf("repo source must not carry an image, got %q", web.Source.Image)
	}
	if web.Build == nil || web.Build.Dockerfile != "Dockerfile" || web.Build.Context != "apps/web" {
		t.Errorf("web build drifted: %+v", web.Build)
	}
	if len(web.Env) != 2 || web.Env[0].Name != "LOG_LEVEL" || web.Env[0].Value != "info" {
		t.Errorf("web env drifted: %+v", web.Env)
	}
	if len(web.Ports) != 2 ||
		web.Ports[0].Name != "http" || web.Ports[0].ContainerPort != 8080 || web.Ports[0].Protocol != "TCP" ||
		web.Ports[1].Name != "metrics" || web.Ports[1].ContainerPort != 9090 || web.Ports[1].Protocol != "UDP" {
		t.Errorf("web ports drifted: %+v", web.Ports)
	}
	if web.Replicas != 3 {
		t.Errorf("web replicas drifted: %d", web.Replicas)
	}
	if web.Resources == nil ||
		web.Resources.Requests != (types.ServiceResourceQuantities{CPU: "100m", Memory: "128Mi"}) ||
		web.Resources.Limits != (types.ServiceResourceQuantities{CPU: "500m", Memory: "512Mi"}) {
		t.Errorf("web resources drifted: %+v", web.Resources)
	}
	if web.Probe == nil || web.Probe.Type != "http" || web.Probe.Path != "/healthz" || web.Probe.Port != 8080 {
		t.Errorf("web probe drifted: %+v", web.Probe)
	}

	// worker — the image-source variant with the nullable fields NULL.
	if worker.Name != "worker" || worker.Type != "job" {
		t.Errorf("worker identity drifted: name=%q type=%q", worker.Name, worker.Type)
	}
	if worker.Source.Kind != "image" || worker.Source.Image != "ghcr.io/acme/worker:1.2.3" {
		t.Errorf("worker source drifted: %+v", worker.Source)
	}
	if worker.Source.RepoURL != "" || worker.Source.Path != "" {
		t.Errorf("image source must not carry repo fields: %+v", worker.Source)
	}
	if worker.Build != nil {
		t.Errorf("worker build must decode NULL → nil, got %+v", worker.Build)
	}
	if worker.Resources != nil {
		t.Errorf("worker resources must decode NULL → nil, got %+v", worker.Resources)
	}
	if len(worker.Env) != 0 || len(worker.Ports) != 0 {
		t.Errorf("worker env/ports must be empty: %+v / %+v", worker.Env, worker.Ports)
	}
	if worker.Replicas != 1 {
		t.Errorf("worker replicas drifted: %d", worker.Replicas)
	}
	if worker.Probe == nil || worker.Probe.Type != "tcp" || worker.Probe.Port != 9000 || worker.Probe.Path != "" {
		t.Errorf("worker probe drifted: %+v", worker.Probe)
	}
}

func TestW1ServicesContract_NoOrphanGoKeys(t *testing.T) {
	services, wires := w1LoadServices(t)
	for i, svc := range services {
		out, err := json.Marshal(svc)
		if err != nil {
			t.Fatalf("re-marshal service %d: %v", i, err)
		}
		var got map[string]json.RawMessage
		if err := json.Unmarshal(out, &got); err != nil {
			t.Fatalf("re-decode service %d: %v", i, err)
		}
		for k := range got {
			if _, ok := wires[i][k]; !ok {
				t.Errorf("service %d (%s): Go struct emits key %q absent from the wire fixture (field removed/renamed upstream?)", i, svc.Name, k)
			}
		}
	}
}
