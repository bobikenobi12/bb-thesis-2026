// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

package e2e

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func assertMarketplaceExternalDnsIdentity(t *testing.T, ctx context.Context, kc, provider, clusterName string) {
	t.Helper()
	want, err := externalDNSAddOnIdentityForProvider(provider)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Minute)
	var out []byte
	for {
		out, err = kubectlRead(ctx, 60*time.Second, kc, "-n", externalDNSAddOnNamespace, "get", "serviceaccount", want.SAName, "-o", "json")
		if err == nil {
			break
		}
		if !strings.Contains(strings.ToLower(err.Error()), "not found") {
			t.Fatalf("could not read external-dns ServiceAccount: %v", err)
		}
		if time.Now().After(deadline) {
			t.Fatalf("ServiceAccount %s/%s not found: %v", externalDNSAddOnNamespace, want.SAName, err)
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Second):
		}
	}
	var obj struct {
		Metadata struct {
			Annotations map[string]string `json:"annotations"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(out, &obj); err != nil {
		t.Fatalf("invalid ServiceAccount JSON: %v", err)
	}
	anns := obj.Metadata.Annotations
	for _, key := range otherCloudsIdentityAnnotations(provider) {
		if _, ok := anns[key]; ok {
			t.Errorf("foreign identity annotation %s present", key)
		}
	}
	if want.TokenPath {
		for _, key := range []string{"eks.amazonaws.com/role-arn", "iam.gke.io/gcp-service-account", "azure.workload.identity/client-id"} {
			if _, ok := anns[key]; ok {
				t.Errorf("token cloud has identity annotation %s", key)
			}
		}
		return
	}
	got, ok := anns[want.SAAnnotation]
	if !ok || strings.TrimSpace(got) == "" {
		t.Fatalf("missing %s annotation on %s/%s", want.SAAnnotation, externalDNSAddOnNamespace, want.SAName)
	}
	if got == "alethia-infra:external-dns-workload-identity" {
		t.Fatal("identity substitution placeholder survived render")
	}
	if err := checkExternalDNSIdentityShape(provider, got, clusterName); err != nil {
		t.Error(err)
	}
}

func checkExternalDNSIdentityShape(provider, got, clusterName string) error {
	switch strings.ToLower(provider) {
	case "aws":
		if !strings.HasPrefix(got, "arn:aws:iam::") {
			return fmt.Errorf("invalid AWS role ARN %q", got)
		}
		if clusterName != "" && !strings.HasSuffix(got, ":role/"+clusterName+"-external-dns") {
			return fmt.Errorf("role %q is not for cluster %q", got, clusterName)
		}
	case "gcp":
		if !strings.Contains(got, "@") || !strings.HasSuffix(got, ".iam.gserviceaccount.com") {
			return fmt.Errorf("invalid GCP service account %q", got)
		}
	case "azure":
		parts := strings.Split(got, "-")
		if len(parts) != 5 || len(parts[0]) != 8 || len(parts[4]) != 12 {
			return fmt.Errorf("invalid Azure client id %q", got)
		}
	}
	return nil
}
