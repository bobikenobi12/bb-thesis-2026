// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"fmt"
	"strings"
)

type externalDNSAddOnIdentity struct {
	SAName       string
	SAAnnotation string
	TokenPath    bool
	Reason       string
}

const externalDNSAddOnNamespace = "external-dns"
const externalDNSAddOnSAName = "addon-external-dns"

func externalDNSAddOnIdentityForProvider(provider string) (externalDNSAddOnIdentity, error) {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "aws":
		return externalDNSAddOnIdentity{SAName: externalDNSAddOnSAName, SAAnnotation: "eks.amazonaws.com/role-arn", Reason: "AWS IRSA role trusted for the marketplace ServiceAccount"}, nil
	case "gcp":
		return externalDNSAddOnIdentity{SAName: externalDNSAddOnSAName, SAAnnotation: "iam.gke.io/gcp-service-account", Reason: "GKE Workload Identity service account binding"}, nil
	case "azure":
		return externalDNSAddOnIdentity{SAName: externalDNSAddOnSAName, SAAnnotation: "azure.workload.identity/client-id", Reason: "Azure Workload Identity federated credential"}, nil
	case "hetzner":
		return externalDNSAddOnIdentity{SAName: externalDNSAddOnSAName, TokenPath: true, Reason: "Hetzner external-dns uses its webhook token and no cloud identity"}, nil
	case "alibaba":
		return externalDNSAddOnIdentity{SAName: externalDNSAddOnSAName, TokenPath: true, Reason: "Alibaba has no native external-dns provider and uses the token path"}, nil
	default:
		return externalDNSAddOnIdentity{}, fmt.Errorf("no external-dns identity contract for provider %q", provider)
	}
}

func otherCloudsIdentityAnnotations(provider string) []string {
	var out []string
	for _, cloud := range []string{"aws", "gcp", "azure"} {
		if strings.EqualFold(cloud, provider) {
			continue
		}
		identity, err := externalDNSAddOnIdentityForProvider(cloud)
		if err == nil {
			out = append(out, identity.SAAnnotation)
		}
	}
	return out
}
