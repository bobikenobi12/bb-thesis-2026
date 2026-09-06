// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strconv"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// milliCPU and mebibytes are DELIBERATELY NARROW parsers, not a re-implementation of Kubernetes
// quantities. `k8s.io/apimachinery` is not a dependency of this module and one is not worth adding
// for a test, and a permissive parser would be the wrong tool anyway: what these assert is that the
// values are written in the two spellings the kubelet reads unambiguously (`<n>m` for CPU, `<n>Mi`
// for memory). Anything else fails the test rather than being silently coerced, which is the same
// posture as the values file itself — a quantity the kubelet cannot parse is a pod it rejects.
func milliCPU(t *testing.T, q string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(strings.TrimSuffix(q, "m"), 10, 64)
	if !strings.HasSuffix(q, "m") || err != nil {
		t.Fatalf("cpu request %q is not written as whole millicores (`100m`) — the kubelet rejects a quantity it cannot parse, and this test will not guess at one", q)
	}
	return n
}

func mebibytes(t *testing.T, q string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(strings.TrimSuffix(q, "Mi"), 10, 64)
	if !strings.HasSuffix(q, "Mi") || err != nil {
		t.Fatalf("memory request %q is not written as whole mebibytes (`256Mi`) — `M` is 10^6 and `Mi` is 2^20, and the two silently differ by 5%%", q)
	}
	return n
}

// Everything below is parsed OUT OF THE RENDERED YAML rather than read back off the constants, for
// the reason install_probes_test.go states: a test that asserts `X == X` is true by construction and
// says nothing about what helm receives. The constants appear here only where a value has to be
// compared against something, and then the comparison is against an INDEPENDENT number — the node's
// allocatable capacity — never against the constant itself.
type resourceBlock struct {
	Requests map[string]string `yaml:"requests"`
	Limits   map[string]string `yaml:"limits"`
}

type resourceComponent struct {
	Resources *resourceBlock `yaml:"resources"`
}

func parseResourceValues(t *testing.T) map[string]resourceComponent {
	t.Helper()
	var got map[string]resourceComponent
	if err := yaml.Unmarshal([]byte(InstallResourceValues()), &got); err != nil {
		t.Fatalf("InstallResourceValues is not valid YAML — helm would reject the whole values file: %v\n%s", err, InstallResourceValues())
	}
	return got
}

// TestInstallResourceValuesRequestForRepoServerOnly pins BOTH halves of the decision.
//
// The positive half is the QoS class: repo-server must carry a cpu AND a memory request, because a
// container with neither is BestEffort — it runs at the cgroup CPU-share floor and sits first in the
// node's eviction ranking. That is the mechanism behind #3855's two proximate errors.
//
// The negative half is not tidiness. Requesting for every component would put the capacity back on
// the node that has least to spare and would restore the tie this exists to break, so a values key
// appearing for anything else is a defect, not an improvement.
func TestInstallResourceValuesRequestForRepoServerOnly(t *testing.T) {
	got := parseResourceValues(t)

	if len(got) != 1 {
		t.Fatalf("the values file configures %d component(s), want exactly repoServer: %#v", len(got), got)
	}
	repo, ok := got["repoServer"]
	if !ok {
		t.Fatalf("no `repoServer` key — the component that runs `helm template` is the one that starves: %#v", got)
	}
	if repo.Resources == nil {
		t.Fatal("repoServer carries no `resources` block, so the container stays BestEffort")
	}
	for _, key := range []string{"cpu", "memory"} {
		if repo.Resources.Requests[key] == "" {
			t.Errorf("repoServer has no %s request — QoS is decided per RESOURCE, so a pod missing either one is not Burstable for it", key)
		}
	}
}

// TestInstallResourceValuesSetNoLimits is the asymmetry, asserted as its own case because it is the
// half a reviewer is most likely to "fix".
//
// A CPU limit throttles exactly the `helm template` this exists to let finish; a memory limit
// OOM-kills a large render outright. Both convert a slow render into a failed one — which is the
// defect, not a fix for it. A request is a FLOOR the scheduler honours; a limit is a CEILING the
// kernel enforces, and only the floor was missing.
func TestInstallResourceValuesSetNoLimits(t *testing.T) {
	repo := parseResourceValues(t)["repoServer"]
	if repo.Resources == nil {
		t.Fatal("no resources block at all")
	}
	if len(repo.Resources.Limits) != 0 {
		t.Errorf("the values file sets limits %v — a cpu limit throttles the render this exists to let finish, and a memory limit OOM-kills it", repo.Resources.Limits)
	}
}

// TestInstallResourceValuesFitTheSmallestFloorNode is the half that stops the fix becoming the next
// defect: a request too large for the node turns a badly-running pod into a permanently Pending one,
// which is strictly worse than what is being fixed.
//
// Judged against the SMALLEST node the floor runs on, computed from GKE's published reservation
// formula rather than from the constants under test — 25% of the first 4 GiB of memory plus a 100
// MiB eviction threshold, and a flat 1060 mCPU on every E2 shared-core type. For a gcp `e2-medium`
// (2 shared vCPU, 4096 MiB) that is ~940m and ~2972 MiB allocatable.
//
// The bound is a QUARTER of allocatable, and it is deliberately loose. The claim being defended is
// only "this cannot make a running pod Pending"; a tight bound would be a working-set assertion, and
// nobody has measured repo-server's working set on this node — the workflow's gcp shape says so.
func TestInstallResourceValuesFitTheSmallestFloorNode(t *testing.T) {
	const (
		e2MediumAllocatableMilliCPU = 2*1000 - 1060
		e2MediumAllocatableMiB      = 4096 - 4096/4 - 100
	)
	repo := parseResourceValues(t)["repoServer"]
	if repo.Resources == nil {
		t.Fatal("no resources block at all")
	}

	cpu := milliCPU(t, repo.Resources.Requests["cpu"])
	mem := mebibytes(t, repo.Resources.Requests["memory"])

	if limit := int64(e2MediumAllocatableMilliCPU / 4); cpu > limit {
		t.Errorf("the cpu request is %dm, over a quarter of an e2-medium's ~%dm allocatable (%dm) — a request this large competes with kube-system for the node rather than joining it",
			cpu, int64(e2MediumAllocatableMilliCPU), limit)
	}
	if limit := int64(e2MediumAllocatableMiB / 4); mem > limit {
		t.Errorf("the memory request is %d MiB, over a quarter of an e2-medium's ~%d MiB allocatable (%d MiB) — the pod could go Pending, which is worse than the starvation being fixed",
			mem, int64(e2MediumAllocatableMiB), limit)
	}
	// A zero request is not a small request: it is the BestEffort class this file exists to leave,
	// and it would pass every ceiling above.
	if cpu <= 0 || mem <= 0 {
		t.Errorf("a request of %dm / %d MiB leaves the container BestEffort — the ceilings above cannot see that, because zero is under all of them", cpu, mem)
	}
}
