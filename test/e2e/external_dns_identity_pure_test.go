// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestExternalDNSIdentityKeysMatchTheTenantIdentityTable(t *testing.T) {
	for _, cloud := range []string{"aws", "gcp", "azure"} {
		got, err := externalDNSAddOnIdentityForProvider(cloud)
		if err != nil {
			t.Fatal(err)
		}
		want, err := tenantIdentityForProvider(cloud)
		if err != nil {
			t.Fatal(err)
		}
		if got.SAAnnotation != want.SAAnnotation {
			t.Errorf("%s: got %q, want %q", cloud, got.SAAnnotation, want.SAAnnotation)
		}
	}
}

func TestExternalDNSAddOnSANameMatchesCatalog(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not resolve test path")
	}
	root := filepath.Join(filepath.Dir(file), "..", "..")
	catalog, err := os.ReadFile(filepath.Join(root, "apps", "console", "lib", "addons", "catalog.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(catalog), `EXTERNAL_DNS_ADDON_SA = "`+externalDNSAddOnSAName+`"`) {
		t.Fatalf("catalog SA name drifted")
	}
	if externalDNSAddOnSAName == "external-dns-sa" {
		t.Fatal("marketplace add-on must not own the platform rail ServiceAccount")
	}
}

func TestEveryFixtureCloudDeclaresAnExternalDNSIdentityContract(t *testing.T) {
	for _, cloud := range []string{"aws", "gcp", "azure", "hetzner", "alibaba"} {
		b, err := externalDNSAddOnIdentityForProvider(cloud)
		if err != nil {
			t.Fatal(err)
		}
		if (b.SAAnnotation != "") == b.TokenPath {
			t.Errorf("%s contract is ambiguous", cloud)
		}
		if len(strings.TrimSpace(b.Reason)) < 20 {
			t.Errorf("%s reason too short", cloud)
		}
	}
	if _, err := externalDNSAddOnIdentityForProvider("digitalocean"); err == nil {
		t.Error("unknown provider accepted")
	}
}

func TestOtherCloudsIdentityAnnotationsIsNotEmpty(t *testing.T) {
	for _, cloud := range []string{"aws", "gcp", "azure", "hetzner"} {
		if len(otherCloudsIdentityAnnotations(cloud)) == 0 {
			t.Errorf("%s absence list empty", cloud)
		}
	}
}
