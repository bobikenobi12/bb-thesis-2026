// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"io"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// externalDNSWithPlaceholder is the shape the console's fixture generator emits for a
// workload-identity cloud: the annotation key for that cloud, holding the sentinel.
func externalDNSWithPlaceholder(annKey string) []types.AddOnInstall {
	return []types.AddOnInstall{
		{ID: "reloader", Values: map[string]interface{}{"replicas": 1}},
		{ID: "external-dns", Values: map[string]interface{}{
			"provider": map[string]interface{}{"name": "aws"},
			"serviceAccount": map[string]interface{}{
				"name":        "addon-external-dns-sa",
				"annotations": map[string]interface{}{annKey: CloudIdentityPlaceholder},
			},
		}},
	}
}

func saAnnotations(t *testing.T, a types.AddOnInstall) map[string]interface{} {
	t.Helper()
	sa, ok := a.Values["serviceAccount"].(map[string]interface{})
	if !ok {
		t.Fatalf("no serviceAccount block on %s", a.ID)
	}
	anns, ok := sa["annotations"].(map[string]interface{})
	if !ok {
		t.Fatalf("no annotations on %s's serviceAccount", a.ID)
	}
	return anns
}

// TestResolveAddOnCloudIdentityNeverTouchesACustomerValue is FIRST because it is the property that
// makes this safe to ship at all. A customer who pastes their own role ARN must get exactly that
// ARN, whatever this cluster's outputs say.
func TestResolveAddOnCloudIdentityNeverTouchesACustomerValue(t *testing.T) {
	t.Parallel()
	const customer = "arn:aws:iam::123456789012:role/their-own-external-dns"
	addons := externalDNSWithPlaceholder("eks.amazonaws.com/role-arn")
	saAnnotations(t, addons[1])["eks.amazonaws.com/role-arn"] = customer

	ResolveAddOnCloudIdentity(addons, &InfraFacts{Provider: "aws", IRSAExternalDNSArn: "arn:aws:iam::000000000000:role/ours"}, io.Discard, io.Discard)

	if got := saAnnotations(t, addons[1])["eks.amazonaws.com/role-arn"]; got != customer {
		t.Errorf("a customer-supplied identity was overwritten with the platform's: got %v, want %q", got, customer)
	}
}

func TestResolveAddOnCloudIdentitySubstitutesPerCloud(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		provider, annKey, want string
		facts                  InfraFacts
	}{
		{"aws", "eks.amazonaws.com/role-arn", "arn:aws:iam::0:role/eks-ue1-x-external-dns",
			InfraFacts{Provider: "aws", IRSAExternalDNSArn: "arn:aws:iam::0:role/eks-ue1-x-external-dns"}},
		{"gcp", "iam.gke.io/gcp-service-account", "external-dns@p.iam.gserviceaccount.com",
			InfraFacts{Provider: "gcp", GCPExternalDNSSA: "external-dns@p.iam.gserviceaccount.com"}},
		{"azure", "azure.workload.identity/client-id", "8f14e45f-ceea-467a-9f1e-1b9cbeef0000",
			InfraFacts{Provider: "azure", AzureExternalDNSClient: "8f14e45f-ceea-467a-9f1e-1b9cbeef0000"}},
	} {
		t.Run(tc.provider, func(t *testing.T) {
			addons := externalDNSWithPlaceholder(tc.annKey)
			ResolveAddOnCloudIdentity(addons, &tc.facts, io.Discard, io.Discard)
			if got := saAnnotations(t, addons[1])[tc.annKey]; got != tc.want {
				t.Errorf("annotation %s = %v, want %q", tc.annKey, got, tc.want)
			}
			// The negative control: no other add-on's values were touched.
			if addons[0].Values["replicas"] != 1 {
				t.Error("a different add-on's values were modified")
			}
		})
	}
}

// THE FAIL-SAFE. A missing output must not leave the sentinel standing: on AWS the SDK would try
// to assume a role literally named `alethia-infra:…`, and on every cloud an annotation holding a
// placeholder makes a broken install look configured.
func TestResolveAddOnCloudIdentityFailsClosedWhenTheFactIsMissing(t *testing.T) {
	t.Parallel()
	addons := externalDNSWithPlaceholder("eks.amazonaws.com/role-arn")
	addons[1].Values["podLabels"] = map[string]interface{}{"azure.workload.identity/use": "true"}
	var warn strings.Builder

	// aws, but the output never came back.
	err := ResolveAddOnCloudIdentity(addons, &InfraFacts{Provider: "aws"}, io.Discard, &warn)

	if err == nil || !strings.Contains(err.Error(), "exports no external-dns workload identity") {
		t.Fatalf("expected missing identity to fail closed, got %v", err)
	}
	if _, still := addons[1].Values["serviceAccount"]; !still {
		t.Error("failed resolution must not partially remove the serviceAccount block")
	}
}

// hetzner and alibaba provision no external-dns identity at all, so "" is a FACT there rather than
// a missing output — and the same fail-safe applies.
func TestExternalDNSWorkloadIdentityIsEmptyOnTokenClouds(t *testing.T) {
	t.Parallel()
	for _, p := range []string{"hetzner", "alibaba", "civo", ""} {
		f := InfraFacts{Provider: p, IRSAExternalDNSArn: "arn:aws:iam::0:role/should-not-leak"}
		if got := f.ExternalDNSWorkloadIdentity(); got != "" {
			t.Errorf("provider %q returned %q — a cloud with no external-dns identity must not "+
				"inherit another cloud's field", p, got)
		}
	}
}

// An add-on that is not external-dns is never touched, whatever its values look like.
func TestResolveAddOnCloudIdentityIsScopedToExternalDNS(t *testing.T) {
	t.Parallel()
	addons := []types.AddOnInstall{{ID: "harbor", Values: map[string]interface{}{
		"serviceAccount": map[string]interface{}{
			"annotations": map[string]interface{}{"eks.amazonaws.com/role-arn": CloudIdentityPlaceholder},
		},
	}}}
	ResolveAddOnCloudIdentity(addons, &InfraFacts{Provider: "aws", IRSAExternalDNSArn: "arn:aws:iam::0:role/ours"}, io.Discard, io.Discard)
	if got := saAnnotations(t, addons[0])["eks.amazonaws.com/role-arn"]; got != CloudIdentityPlaceholder {
		t.Errorf("a non-external-dns add-on was rewritten: %v", got)
	}
}
