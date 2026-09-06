// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// TestGCPNightlyLocationContract pins the zonal cluster location and regional service consumers.
//
// Each contract states the literals that must be present, and `wantRe` states one that must not be
// pinned as FORMATTED TEXT. Two of these used to under-assert in different ways, and both are worth
// naming because they are the two ways a file-contents test goes wrong:
//
//   - Asserting a rendering rather than the thing. The firestore contract matched
//     `location_id   = …` with `terraform fmt`'s alignment baked in, so adding a longer attribute
//     anywhere in that block reds this test on an unrelated PR — and reformatting could equally
//     hide a real change.
//   - Asserting the INPUT to a behaviour instead of the behaviour. The cleanup contract matched
//     only the zone the self-test passes in; deleting the normalization the self-test exists to
//     exercise left it green, so the case did not pin what its own name claimed.
func TestGCPNightlyLocationContract(t *testing.T) {
	root := filepath.Join(e2ePackageDir(t), "..", "..")
	contracts := []struct {
		name   string
		path   string
		want   []string
		wantRe *regexp.Regexp
	}{
		{
			name: "the nightly defaults GCP to a zone so GKE is zonal and capacity is checked",
			path: filepath.Join(root, ".github", "workflows", "e2e-nightly.yml"),
			want: []string{`gcp)     DEFAULT_REGION="europe-west3-a" ;;`},
		},
		{
			name: "the nightly gcp floor pins the whole node shape, instance type included",
			path: filepath.Join(root, ".github", "workflows", "e2e-nightly.yml"),
			// A node pool's counts are PER ZONE, so regional europe-west3 was delivering 3x what it
			// declared, and #3566 restated 3/6/3 on e2-small to keep the zonal switch capacity-neutral.
			// #3855 then showed that shape is why gcp's floor is the only red one: argocd-repo-server
			// never renders one manifest inside a ~900 Mi slot. What is pinned now is the RESHAPE —
			// 1 x e2-medium instead of 3 x e2-small.
			//
			// THE INSTANCE TYPE IS PART OF THE PIN, and it was not before. That is the correction, not
			// an addition: with the location zonal the counts are literal, so `1/2/1` alone says
			// nothing about what is bought — 1/2/1 on an e2-small is a THIRD of the capacity at the
			// very numbers this contract would have accepted. Pinning the pair is what makes a silent
			// shrink impossible in whichever PR happens to touch this line, which is the whole job.
			want: []string{`"instance_types":["e2-medium"],"node_min_size":1,"node_max_size":2,"node_desired_size":1`},
		},
		{
			name: "Firestore derives its regional default from the zonal cluster location",
			path: filepath.Join(root, "infra", "templates", "project", "gcp", "firestore.tf"),
			// The ATTRIBUTE, not its alignment: `location_id` = the derived region key.
			wantRe: regexp.MustCompile(`location_id\s*=\s*var\.firestore_location_id != "" \? var\.firestore_location_id : local\.gcp_region_key`),
		},
		{
			name: "brownfield subnet discovery matches the derived region rather than the zone",
			path: filepath.Join(root, "infra", "templates", "project", "gcp", "existing-network.tf"),
			want: []string{`if length(regexall("/regions/${local.gcp_region_key}/", s)) > 0`},
		},
		{
			name: "cleanup self-tests the zone-to-region normalization used by regional APIs",
			path: filepath.Join(root, "scripts", "e2e", "gcp-cleanup.sh"),
			// BOTH halves. The zone is only the self-test's INPUT; the normalization is the thing
			// under test, and asserting the input alone let deleting it pass.
			want: []string{
				`ALETHIA_E2E_REGION="europe-west3-a"`,
				`*-[a-z]) REGION="${REGION%-?}" ;;`,
			},
		},
	}

	for _, contract := range contracts {
		t.Run(contract.name, func(t *testing.T) {
			raw, err := os.ReadFile(contract.path)
			if err != nil {
				t.Fatalf("read %s: %v", contract.path, err)
			}
			if contract.wantRe == nil && len(contract.want) == 0 {
				t.Fatal("contract asserts nothing")
			}
			for _, want := range contract.want {
				if !strings.Contains(string(raw), want) {
					t.Errorf("%s no longer contains the location contract:\n%s", contract.path, want)
				}
			}
			if contract.wantRe != nil && !contract.wantRe.Match(raw) {
				t.Errorf("%s no longer satisfies the location contract:\n%s", contract.path, contract.wantRe)
			}
		})
	}
}
