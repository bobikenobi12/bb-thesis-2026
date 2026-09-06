// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"io"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// argoValuesFileRe pulls the shell-quoted `-f <path>` arguments back off the helm command line, in
// order. The paths are ShellQuote'd (utils.ShellQuote wraps in single quotes) and live under
// os.MkdirTemp, so they never contain a quote to escape.
//
// This exists because the install now carries MORE THAN ONE values file. Every test here used to
// find "the" one with `strings.Index(command, " -f ")` and take the rest of the string, which
// silently swallowed the second file's flag into the first file's PATH the moment a second
// appeared. The helpers below are the disambiguator, and they live in this file because this is the
// change that introduced the ambiguity.
var argoValuesFileRe = regexp.MustCompile(`-f '([^']+)'`)

// argoValuesFiles returns the contents of every `-f`'d values file on a helm command, in the order
// helm would merge them.
//
// Read INSIDE the executeCommand stub, always: installArgoCD defers os.RemoveAll on its scratch
// dir, so after it returns there is nothing on disk. A test that read the files afterwards would
// see "no such file" and could only assert on the command string — which is how a values file that
// is referenced but empty slips through.
func argoValuesFiles(t *testing.T, command string) []string {
	t.Helper()
	var out []string
	for _, m := range argoValuesFileRe.FindAllStringSubmatch(command, -1) {
		b, err := os.ReadFile(m[1])
		if err != nil {
			t.Errorf("values file %s named on the helm command line could not be read: %v", m[1], err)
			continue
		}
		out = append(out, string(b))
	}
	return out
}

// argoUnconditionalValues is every values file installArgoCD writes on EVERY install, whatever the
// cloud and whether or not there is an ingress. Kept as one list because two different tests need
// "is this file one of the unconditional ones" and a second hand-written copy of the answer is how
// the next unconditional file gets missed by one of them.
func argoUnconditionalValues() []string {
	return []string{argocd.InstallProbeValues(), argocd.InstallResourceValues()}
}

// argoIngressValues returns the PER-CLOUD INGRESS values file, or "" when the install rendered
// none. Identified by content — everything that is not one of the unconditional files — rather
// than by filename or position, so it cannot drift if either changes.
func argoIngressValues(t *testing.T, command string) string {
	t.Helper()
	unconditional := argoUnconditionalValues()
	for _, c := range argoValuesFiles(t, command) {
		if !slices.Contains(unconditional, c) {
			return c
		}
	}
	return ""
}

// captureArgoInstall runs installArgoCD with the command seam stubbed and returns the helm install
// command plus the CONTENTS of every `-f` values file it named.
//
// Reading the files INSIDE the stub is load-bearing: installArgoCD defers os.RemoveAll on its
// scratch dir, so by the time it returns there is nothing left on disk to read. A test that read
// them afterwards would see "file not found" and could only ever assert on the command string,
// which is how a values file that is referenced but empty would slip through.
func captureArgoInstall(t *testing.T, vc *types.ProjectConfig, outputs map[string]interface{}) (string, []string) {
	t.Helper()
	resetDeploySeams(t)

	executeCommandWithOutput = func(string, string, []string) (string, error) {
		return "existing-auth", nil
	}
	var install string
	var contents []string
	executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
		if !strings.Contains(command, "helm upgrade --install argo-cd") {
			return nil
		}
		install = command
		contents = argoValuesFiles(t, command)
		return nil
	}

	if err := installArgoCD(context.Background(), vc, outputs, &PlanResult{}, io.Discard, io.Discard); err != nil {
		t.Fatalf("installArgoCD: %v", err)
	}
	if install == "" {
		t.Fatal("installArgoCD never issued a `helm upgrade --install argo-cd` command")
	}
	return install, contents
}

// TestInstallArgoCDAlwaysCarriesTheUnconditionalValues is the wiring guard, and the case that
// matters is the FIRST one: a project with no DNS at all.
//
// Both unconditional files describe the same kind of fact. The chart's default probes restart-loop
// argocd-server and argocd-repo-server on a small burstable node, and the chart's empty `resources`
// leaves argocd-repo-server BestEffort at the cgroup share floor (#3855). Both are properties of the
// NODE and the CONTAINER — not of DNS, of a certificate or of a cloud. The natural place to have put
// either was next to the per-cloud ingress values, and that would have shipped the fix to only the
// subset of projects that configure a domain, while the e2e floor runs that measured both defects
// are exactly the ones that do not. Hence a case per shape, and both files asserted per case.
func TestInstallArgoCDAlwaysCarriesTheUnconditionalValues(t *testing.T) {
	for _, tc := range []struct {
		name    string
		vc      *types.ProjectConfig
		outputs map[string]interface{}
	}{
		{
			name: "no DNS, no ingress — the bare install every other cloud takes",
			vc:   &types.ProjectConfig{},
		},
		{
			name: "DNS enabled but no certificate output — ingress skipped, probes still needed",
			vc:   &types.ProjectConfig{DNS: types.ProjectDNSConfig{Enabled: true, DomainName: "example.com"}},
		},
		{
			name:    "aws ALB ingress (--set flags, no values file of its own)",
			vc:      &types.ProjectConfig{DNS: types.ProjectDNSConfig{Enabled: true, DomainName: "example.com"}},
			outputs: map[string]interface{}{"acm_certificate_arn": "arn:aws:acm:region:acct:certificate/123"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, contents := captureArgoInstall(t, tc.vc, tc.outputs)
			// Named per file, not counted: "2 of 2 present" and "the same file twice" are the same
			// number, and the failure has to say WHICH protection was dropped.
			for _, want := range []struct{ name, body, cost string }{
				{"probe", argocd.InstallProbeValues(), "the chart's 1-second liveness timeout would restart-loop argocd-server on a burstable node"},
				{"resource", argocd.InstallResourceValues(), "argocd-repo-server would stay BestEffort at the cgroup CPU-share floor and first in the node's eviction ranking (#3855)"},
			} {
				if !slices.Contains(contents, want.body) {
					t.Errorf("the helm install carried %d values file(s), none of them the %s values — %s.\ngot: %#v", len(contents), want.name, want.cost, contents)
				}
			}
		})
	}
}

// TestInstallArgoCDOrdersProbeValuesBeforeTheIngressValues pins the merge order on the one path
// that ships a per-cloud values file. helm merges `-f` left to right, so a per-cloud file must be
// able to win on any key it also sets. Today nothing overlaps; this is what keeps that true.
//
// The two unconditional files BOTH set `repoServer`, which is why the order between them is not
// asserted as a precedence: helm deep-merges maps, so `repoServer.readinessProbe` and
// `repoServer.resources` coexist rather than one replacing the other. What is asserted is that the
// per-cloud file is LAST, which is the only ordering that carries a decision.
func TestInstallArgoCDOrdersProbeValuesBeforeTheIngressValues(t *testing.T) {
	// The GKE branch is gated on a gcp-only output PLUS cert-manager's readiness, so the identity
	// outputs below are what make CertManagerEnabled() true — without them the switch falls through
	// and no ingress values file is rendered at all.
	install, contents := captureArgoInstall(t,
		&types.ProjectConfig{
			Provider: "gcp",
			DNS:      types.ProjectDNSConfig{Enabled: true, DomainName: "example.com", ManagedCertificate: true},
		},
		map[string]interface{}{
			"gke_cluster_name":             "gke-test",
			"external_dns_service_account": "edns@demo.iam.gserviceaccount.com",
			"gcp_project_id":               "demo",
			"cloud_dns_zone_name":          "demo-zone",
		})

	unconditional := argoUnconditionalValues()
	if len(contents) != len(unconditional)+1 {
		t.Fatalf("GKE install carried %d values files, want %d (the unconditional ones, then the ingress):\n%s", len(contents), len(unconditional)+1, install)
	}
	for i, want := range unconditional {
		if contents[i] != want {
			t.Errorf("values file %d is not the unconditional file it should be — a per-cloud file can now override one of its keys:\n%s", i, contents[i])
		}
	}
	if last := contents[len(contents)-1]; !strings.Contains(last, "ingressClassName: gce") {
		t.Errorf("the LAST values file is not the GKE ingress values:\n%s", last)
	}
}
