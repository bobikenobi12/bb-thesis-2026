// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Three names in this package ARE identities of objects that are already applied in customer
// clusters — an AppProject, an Application, and the Helm release the Application creates. Moving
// any of them renames the live object on the next deploy, orphans the old one, and (for a managed
// add-on) makes PruneManagedAddOns delete it, because that prune deletes every managed Application
// NOT in ManagedAddOnNames.
//
// Every `want` below was produced by RUNNING the pre-#3665 implementations over the corpus, not by
// reasoning about them. The corpus is free-text project DISPLAY NAMES, which is what these
// functions receive: types.Configuration.ProjectName is projects.project_name, not a slug.

var legacyDisplayNames = []struct {
	name   string
	byo    string
	tenant string // namespaceTenantName("tenant", name, "dev-1")
}{
	{"boutique", "byo-boutique", "tenant-boutique-dev-1"},
	{"Acme - Prod", "byo-acme---prod", "tenant-acme---prod-dev-1"},
	{"Bob's Project", "byo-bob-s-project", "tenant-bob-s-project-dev-1"},
	{"Foo--Bar", "byo-foo--bar", "tenant-foo--bar-dev-1"},
	{"café", "byo-caf", "tenant-caf-dev-1"},
	{"  Padded  ", "byo-padded", "tenant-padded-dev-1"},
	{"UPPER", "byo-upper", "tenant-upper-dev-1"},
	{"a b c", "byo-a-b-c", "tenant-a-b-c-dev-1"},
	{"Ünïcøde Näme", "byo-n-c-de-n-me", "tenant-n-c-de-n-me-dev-1"},
	{"中文", "byo-project", "tenant-dev-1"},
	{"", "byo-project", "tenant-dev-1"},
	{"---", "byo-project", "tenant-dev-1"},
}

// TestLegacyObjectNamesAreUnchanged pins both composed names over the display-name corpus.
func TestLegacyObjectNamesAreUnchanged(t *testing.T) {
	if len(legacyDisplayNames) == 0 {
		t.Fatal("empty corpus — this test would pass without asserting anything")
	}
	for _, c := range legacyDisplayNames {
		t.Run(c.name, func(t *testing.T) {
			if got := ByoProjectName(c.name); got != c.byo {
				t.Errorf("ByoProjectName(%q) = %q, want %q (the name of an AppProject that already exists)", c.name, got, c.byo)
			}
			if got := namespaceTenantName("tenant", c.name, "dev-1"); got != c.tenant {
				t.Errorf("namespaceTenantName(%q) = %q, want %q (the name of an Application that already exists)", c.name, got, c.tenant)
			}
		})
	}
}

// TestLegacyObjectNamesStayBounded pins the 63-char behaviour, including the trailing hyphen the
// cut can expose — the one place these names are allowed to be lossy.
func TestLegacyObjectNamesStayBounded(t *testing.T) {
	long := strings.Repeat("very-long-project-name-", 5)
	byo := ByoProjectName(long)
	if want := "byo-very-long-project-name-very-long-project-name-very-long-pro"; byo != want {
		t.Errorf("ByoProjectName(<115 chars>) = %q, want %q", byo, want)
	}
	if len(byo) != 63 {
		t.Errorf("ByoProjectName produced %d characters; the bound is 63", len(byo))
	}
	tenant := namespaceTenantName("tenant", long, "dev-1")
	if want := "tenant-very-long-project-name-very-long-project-name-very-long"; tenant != want {
		t.Errorf("namespaceTenantName(<115 chars>) = %q, want %q", tenant, want)
	}
	if strings.HasSuffix(tenant, "-") {
		t.Errorf("the cut left a trailing hyphen: %q", tenant)
	}
}

// TestAddOnAppNameIsUnbounded pins the decision reached on #3714's review.
//
// An Application is a CRD instance, so Kubernetes validates its name as a DNS-1123 SUBDOMAIN
// (≤253), not a label — an `addon-<70 chars>` Application applies today, and a BYO chart attached
// before the id gained a cap has exactly such a name. Truncating here would not prevent an
// impossible name; it would rename a live object and, via ManagedAddOnNames -> PruneManagedAddOns,
// delete it.
func TestAddOnAppNameIsUnbounded(t *testing.T) {
	id := strings.Repeat("a", 70)
	got := AddOnAppName(id)
	if want := "addon-" + id; got != want {
		t.Errorf("AddOnAppName truncated a long id: got %q (%d chars), want the id verbatim (%d chars)",
			got, len(got), len(want))
	}
	// And the same string is what the prune compares against, so a truncation here would silently
	// remove the live Application from the desired set.
	names := ManagedAddOnNames([]types.AddOnInstall{{ID: id, Mode: "managed"}})
	if len(names) != 1 || names[0] != "addon-"+id {
		t.Errorf("ManagedAddOnNames = %v; the prune's desired set must carry the SAME name the "+
			"renderer writes, or PruneManagedAddOns deletes the live Application", names)
	}
}
