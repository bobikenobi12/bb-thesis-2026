// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// CloudIdentityPlaceholder is what the console stores in an add-on's `workloadIdentity` knob when
// the identity is one this PLATFORM provisions, rather than one the customer pasted.
//
// The console cannot know it: an IRSA role ARN, a GSA email and a managed-identity client id are
// all per-run values that exist only after `tofu apply`, and the add-on is installed by the same
// deploy job. So the catalog stores a sentinel and the runner — which holds the tofu outputs —
// substitutes the real value just before the Applications render.
//
// ⚠️ MIRRORED IN TypeScript at apps/console/lib/addons/catalog-export.ts. The two spellings are
// pinned against each other by a test, because a drifted sentinel does not fail: it renders an
// annotation whose value is the literal placeholder, external-dns constructs its provider, and the
// add-on reports Healthy while writing nothing — the exact defect this machinery removes.
//
// Deliberately a shape no cloud identity can take, so it can never collide with a real one.
const CloudIdentityPlaceholder = "alethia-infra:external-dns-workload-identity"

// externalDNSAddOnID is the catalog id whose identity this file resolves. Gated on the id rather
// than applied to every add-on: the facts substituted here are external-dns's, not a general
// "cloud identity" that any chart could ask for.
const externalDNSAddOnID = "external-dns"

// ExternalDNSWorkloadIdentity is the identity external-dns assumes on THIS cloud, or "" where the
// concept does not apply.
//
// hetzner and alibaba return "" and that is a fact, not a gap: neither template provisions an
// external-dns identity at all (their external-dns authenticates with a token), so there is
// nothing to substitute and the caller drops the ServiceAccount block rather than inventing one.
func (f *InfraFacts) ExternalDNSWorkloadIdentity() string {
	switch f.Provider {
	case "aws":
		return f.IRSAExternalDNSArn
	case "gcp":
		return f.GCPExternalDNSSA
	case "azure":
		return f.AzureExternalDNSClient
	default:
		return ""
	}
}

// ResolveAddOnCloudIdentity replaces the placeholder in the external-dns add-on's ServiceAccount
// annotations with this run's real cloud identity, in place, before the Applications render.
//
// ⚠️ A REAL CUSTOMER'S PASTED IDENTITY IS UNTOUCHED, by construction: only a value EQUAL to
// CloudIdentityPlaceholder is replaced, and `arn:aws:iam::123456789012:role/whatever` is not that
// value. That is the property that makes this safe to ship, and it is what the unit test asserts
// first.
//
// ⚠️ AND IT IS KEY-AGNOSTIC. It walks the annotations map and matches on the VALUE, never on the
// annotation key. The provider→key table (`eks.amazonaws.com/role-arn`,
// `iam.gke.io/gcp-service-account`, `azure.workload.identity/client-id`) stays in exactly one
// place — EXTERNAL_DNS_PROVIDERS in the console catalog — instead of being restated here where the
// two copies could disagree about a cloud.
//
// WHEN THE FACT IS MISSING the whole serviceAccount block is dropped, not left holding the
// placeholder and not set to "". An annotation whose value is a sentinel is worse than no
// annotation: on AWS the SDK would try to assume a role named `alethia-infra:…`, and on every
// cloud it makes a broken install look configured. Dropping the block degrades to exactly the
// shape the add-on had before any of this existed — the chart's own ServiceAccount, no identity —
// which is a state the operator is warned about rather than misled by.
func ResolveAddOnCloudIdentity(addons []types.AddOnInstall, f *InfraFacts, stdout, stderr io.Writer) error {
	if f == nil {
		return fmt.Errorf("infra facts are missing")
	}
	identity := f.ExternalDNSWorkloadIdentity()
	for i := range addons {
		if addons[i].ID != externalDNSAddOnID {
			continue
		}
		sa, ok := addons[i].Values["serviceAccount"].(map[string]interface{})
		if !ok {
			continue
		}
		anns, ok := sa["annotations"].(map[string]interface{})
		if !ok {
			continue
		}
		placeheld := false
		for k, v := range anns {
			if s, isStr := v.(string); isStr && s == CloudIdentityPlaceholder {
				placeheld = true
				if identity != "" {
					anns[k] = identity
				}
			}
		}
		if !placeheld {
			continue // a customer-supplied identity, or none — nothing of ours to resolve
		}
		if identity == "" {
			return fmt.Errorf("provider %q exports no external-dns workload identity", f.Provider)
		}
		fmt.Fprintf(stdout, "   external-dns add-on: bound to this cluster's workload identity.\n")
	}
	return nil
}
