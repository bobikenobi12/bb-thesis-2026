// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Negative-path proof for the ArgoCD health assertion (BYOC A0.2): the parsing +
// decision logic is exercised against synthetic `applications.argoproj.io` JSON and
// metadata shapes WITHOUT a cluster — healthy, degraded, out-of-sync, missing app,
// and (crucially) the empty-expected-set vacuity guard, so the assertion itself is
// proven able to fail before any tier relies on it. UNTAGGED: runs under a bare
// `go test ./...` in test/e2e (no docker/kind/postgres needed).
package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// argoAppsJSON builds a minimal `kubectl get applications -o json` document from
// (name, health, sync) triples, in the exact shape parseArgoApps consumes.
func argoAppsJSON(items ...[3]string) []byte {
	var b strings.Builder
	b.WriteString(`{"items":[`)
	for i, it := range items {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"metadata":{"name":"` + it[0] + `"},"status":{"health":{"status":"` + it[1] + `"},"sync":{"status":"` + it[2] + `"}}}`)
	}
	b.WriteString(`]}`)
	return []byte(b.String())
}

func TestParseArgoApps(t *testing.T) {
	raw := []byte(`{"items":[
		{"metadata":{"name":"addon-reloader"},
		 "status":{"health":{"status":"Healthy"},"sync":{"status":"Synced"}}},
		{"metadata":{"name":"metrics-server"},
		 "status":{"health":{"status":"Degraded"},"sync":{"status":"OutOfSync"},
		           "conditions":[{"type":"SyncError","message":"one or more objects failed to apply"}]}},
		{"metadata":{"name":"just-created"},"status":{}}
	]}`)
	observed, err := parseArgoApps(raw)
	if err != nil {
		t.Fatalf("parseArgoApps: %v", err)
	}
	if got := observed["addon-reloader"]; got.Health != "Healthy" || got.Sync != "Synced" {
		t.Fatalf("addon-reloader = %+v, want Healthy/Synced", got)
	}
	deg := observed["metrics-server"]
	if deg.Health != "Degraded" || deg.Sync != "OutOfSync" {
		t.Fatalf("metrics-server = %+v, want Degraded/OutOfSync", deg)
	}
	if len(deg.Conditions) != 1 || !strings.Contains(deg.Conditions[0], "SyncError") {
		t.Fatalf("metrics-server conditions = %v, want the SyncError condition", deg.Conditions)
	}
	// An app with no status yet must normalise to Unknown (mirrors health.go), so it
	// FAILS the assertion rather than being skipped or misread.
	if got := observed["just-created"]; got.Health != "Unknown" || got.Sync != "Unknown" {
		t.Fatalf("just-created = %+v, want Unknown/Unknown", got)
	}
}

func TestParseArgoApps_BadJSON(t *testing.T) {
	if _, err := parseArgoApps([]byte("kubectl exploded")); err == nil {
		t.Fatal("expected an error for non-JSON input")
	}
}

func TestEvaluateArgoApps_AllHealthy(t *testing.T) {
	observed, err := parseArgoApps(argoAppsJSON(
		[3]string{"addon-reloader", "Healthy", "Synced"},
		[3]string{"addon-sealed-secrets", "Healthy", "Synced"},
		// An UNEXPECTED degraded app must not fail the assertion — only the derived
		// expected set is required (metrics-server is not part of the honest derivation).
		[3]string{"metrics-server", "Degraded", "Synced"},
	))
	if err != nil {
		t.Fatal(err)
	}
	losers, everr := evaluateArgoApps(observed, []string{"addon-reloader", "addon-sealed-secrets"})
	if everr != nil || len(losers) != 0 {
		t.Fatalf("want pass, got losers=%v err=%v", losers, everr)
	}
}

func TestEvaluateArgoApps_DegradedFails(t *testing.T) {
	observed, _ := parseArgoApps(argoAppsJSON(
		[3]string{"addon-reloader", "Degraded", "Synced"},
		[3]string{"addon-sealed-secrets", "Healthy", "Synced"},
	))
	losers, err := evaluateArgoApps(observed, []string{"addon-reloader", "addon-sealed-secrets"})
	if err == nil {
		t.Fatal("a Degraded expected app must fail the evaluation")
	}
	if len(losers) != 1 || losers[0] != "addon-reloader" {
		t.Fatalf("losers = %v, want [addon-reloader]", losers)
	}
	if !strings.Contains(err.Error(), "health=Degraded") {
		t.Fatalf("error must report the failing health, got: %v", err)
	}
}

func TestEvaluateArgoApps_OutOfSyncFails(t *testing.T) {
	// Healthy but OutOfSync is still a failure — sync must be asserted, not just health
	// (a self-heal that never converges shows exactly this shape).
	observed, _ := parseArgoApps(argoAppsJSON([3]string{"external-dns", "Healthy", "OutOfSync"}))
	losers, err := evaluateArgoApps(observed, []string{"external-dns"})
	if err == nil || len(losers) != 1 {
		t.Fatalf("Healthy+OutOfSync must fail, got losers=%v err=%v", losers, err)
	}
}

func TestEvaluateArgoApps_MissingAppFails(t *testing.T) {
	observed, _ := parseArgoApps(argoAppsJSON([3]string{"addon-reloader", "Healthy", "Synced"}))
	losers, err := evaluateArgoApps(observed, []string{"addon-reloader", "addon-vanished"})
	if err == nil {
		t.Fatal("a missing expected app must fail the evaluation")
	}
	if len(losers) != 1 || losers[0] != "addon-vanished" {
		t.Fatalf("losers = %v, want [addon-vanished]", losers)
	}
	if !strings.Contains(err.Error(), "MISSING") {
		t.Fatalf("error must call out the missing app, got: %v", err)
	}
}

func TestEvaluateArgoApps_EmptyExpectedIsVacuous(t *testing.T) {
	observed, _ := parseArgoApps(argoAppsJSON([3]string{"addon-reloader", "Healthy", "Synced"}))
	if _, err := evaluateArgoApps(observed, nil); err == nil || !strings.Contains(err.Error(), "VACUOUS") {
		t.Fatalf("an empty expected set must be refused as vacuous, got: %v", err)
	}
}

func TestAssertArgoAppsHealthy_EmptyExpectedIsVacuous(t *testing.T) {
	// The poll wrapper must refuse an empty set BEFORE touching any cluster — this call
	// must fail immediately with no kubeconfig and no kubectl.
	err := AssertArgoAppsHealthy(context.Background(), "/nonexistent/kubeconfig", nil, time.Minute)
	if err == nil || !strings.Contains(err.Error(), "VACUOUS") {
		t.Fatalf("want an immediate vacuity error, got: %v", err)
	}
}

func TestDeriveExpectedArgoApps(t *testing.T) {
	// The T1/T2 hetzner shape: every app-shipping infra service skipped, storage-class
	// installed (no Application of its own), two seeded add-ons. The always-rendered
	// platform apps must be expected regardless.
	meta := []byte(`{
		"cluster_name": "alethia-e2t1abc",
		"infra_services": [
			{"service":"external-dns","status":"skipped","reason":"DNS is disabled"},
			{"service":"external-secrets-store","status":"skipped","reason":"no cloud secret store"},
			{"service":"ingress","status":"skipped","reason":"install ingress-nginx"},
			{"service":"storage-class","status":"installed","reason":"hcloud-volumes default"},
			{"service":"argocd-url","status":"skipped","reason":"port-forward"}
		],
		"addon_status": {
			"addon-sealed-secrets": {"health":"Progressing","sync":"Synced"},
			"addon-reloader": {"health":"Unknown","sync":"Unknown"}
		}
	}`)
	got, err := DeriveExpectedArgoApps("hetzner", meta)
	if err != nil {
		t.Fatalf("DeriveExpectedArgoApps: %v", err)
	}
	want := []string{"addon-reloader", "addon-sealed-secrets", "external-secrets-operator", "metrics-server"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("derived = %v, want %v (sorted; storage-class must NOT map to an app; always-rendered apps must be present)", got, want)
	}
}

func TestDeriveExpectedArgoApps_InstalledInfraServicesMap(t *testing.T) {
	// The AWS-flavoured shape: installed decisions map to their Application names
	// (argocd-url is whitelisted as shipping no Application of its own).
	meta := []byte(`{
		"infra_services": [
			{"service":"external-dns","status":"installed","reason":"provider aws"},
			{"service":"external-secrets-store","status":"installed","reason":"AWS Secrets Manager"},
			{"service":"ingress","status":"installed","reason":"ALB controller"},
			{"service":"argocd-url","status":"installed","reason":"ALB ingress"}
		]
	}`)
	got, err := DeriveExpectedArgoApps("aws", meta)
	if err != nil {
		t.Fatalf("DeriveExpectedArgoApps: %v", err)
	}
	want := []string{"aws-load-balancer-controller", "external-dns", "external-secrets-operator", "metrics-server"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("derived = %v, want %v", got, want)
	}
}

func TestDeriveExpectedArgoApps_XacctStore(t *testing.T) {
	// REGRESSION (#1268): externalSecretsXacctStoreDecision records an
	// "external-secrets-store-xacct" decision whenever the project selects a cross-account
	// secret manager. Before that service was mapped, this metadata hard-errored — so every
	// T2 run that enabled the connector went RED here, before reaching any xacct assertion.
	meta := []byte(`{
		"infra_services": [
			{"service":"external-secrets-store","status":"installed","reason":"AWS Secrets Manager"},
			{"service":"external-secrets-store-xacct","status":"installed","reason":"cross-account AWS Secrets Manager"}
		]
	}`)
	got, err := DeriveExpectedArgoApps("aws", meta)
	if err != nil {
		t.Fatalf("DeriveExpectedArgoApps: %v", err)
	}
	// The cross-account store ships no Application of its own — it rides the operator's.
	want := []string{"external-secrets-operator", "metrics-server"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("derived = %v, want %v", got, want)
	}
}

func TestDeriveExpectedArgoApps_LeanPathStillAssertsPlatformApps(t *testing.T) {
	// All app-shipping services skipped + no add-ons: the derivation must still expect
	// the always-rendered platform Applications (they have no render gate), so the
	// assertion can never go vacuous even without seeded add-ons.
	meta := []byte(`{
		"cluster_name": "x",
		"infra_services": [
			{"service":"external-dns","status":"skipped","reason":"r"},
			{"service":"storage-class","status":"installed","reason":"r"}
		]
	}`)
	got, err := DeriveExpectedArgoApps("hetzner", meta)
	if err != nil {
		t.Fatalf("DeriveExpectedArgoApps: %v", err)
	}
	want := []string{"external-secrets-operator", "metrics-server"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("derived = %v, want exactly the always-rendered apps %v", got, want)
	}

	// The SAME lean shape on a cloud that ships its own metrics-server (#1722): the set
	// shrinks to the operator alone. This is the half that matters — before the gate, the
	// assertion waited for a metrics-server Application that GKE/AKS/ACK deploys never
	// render, so it could only ever time out.
	gotGCP, err := DeriveExpectedArgoApps("gcp", meta)
	if err != nil {
		t.Fatalf("DeriveExpectedArgoApps(gcp): %v", err)
	}
	wantGCP := []string{"external-secrets-operator"}
	if strings.Join(gotGCP, ",") != strings.Join(wantGCP, ",") {
		t.Fatalf("derived on gcp = %v, want %v (GKE ships its own metrics-server)", gotGCP, wantGCP)
	}
}

// TestMetricsServerGateMatchesTemplate pins metricsServerProviders to the actual gate in
// infra/templates/argocd/metrics-server.yaml, by parsing the template rather than trusting
// a comment.
//
// The two live in different modules and are edited months apart, and they fail in opposite
// directions: widen the template without widening the map and the assertion stops checking
// a real app; narrow the template without narrowing the map and every run on that cloud
// waits the full ArgoCD timeout for an Application nobody rendered. Neither shows up as a
// compile error, and #1722 is precisely the second failure arriving by accident.
func TestMetricsServerGateMatchesTemplate(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Join(filepath.Dir(thisFile), "..", "..")
	path := filepath.Join(root, "infra", "templates", "argocd", "metrics-server.yaml")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}

	// The gate is the first `{{- if ... }}` action in the file. Read the providers out of
	// it rather than the whole file, so a provider named in the explanatory comment above
	// cannot be mistaken for one the gate actually admits.
	gate := regexp.MustCompile(`\{\{-?\s*if\s+([^}]*?)\s*-?\}\}`).FindSubmatch(b)
	if gate == nil {
		t.Fatalf("no {{ if }} gate found in %s — metrics-server renders unconditionally again, which is the #1722 regression", path)
	}
	found := map[string]bool{}
	for _, m := range regexp.MustCompile(`eq\s+\.Provider\s+"([a-z]+)"`).FindAllSubmatch(gate[1], -1) {
		found[string(m[1])] = true
	}
	if len(found) == 0 {
		t.Fatalf("gate %q names no provider — cannot pin it to metricsServerProviders", gate[1])
	}

	if !equalStringSets(found, metricsServerProviders) {
		t.Fatalf("metrics-server gate DRIFT:\n  template %s admits: %v\n  metricsServerProviders:  %v\nThey must match — see the comment block in the template.",
			path, sortedKeys(found), sortedKeys(metricsServerProviders))
	}
}

func equalStringSets(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if v != b[k] {
			return false
		}
	}
	return true
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		if v {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func TestDeriveExpectedArgoApps_UnknownProviderFails(t *testing.T) {
	// FAIL-CLOSED on the new parameter: the provider decides metrics-server membership,
	// so a typo'd or empty one must hard-error rather than quietly answer "not expected"
	// — that would drop a real app from the assertion on aws/hetzner and turn a genuine
	// regression into a pass.
	meta := []byte(`{"infra_services":[{"service":"external-dns","status":"skipped","reason":"r"}]}`)
	for _, bad := range []string{"", "gpc", "AWS"} {
		if _, err := DeriveExpectedArgoApps(bad, meta); err == nil || !strings.Contains(err.Error(), "unknown provider") {
			t.Fatalf("provider %q: want an unknown-provider error, got: %v", bad, err)
		}
	}
}

func TestDeriveExpectedArgoApps_UnrecognizedInstalledServiceFails(t *testing.T) {
	// FAIL-CLOSED: an "installed" decision that is in neither infraServiceArgoApps nor
	// infraServiceNoApp must hard-error — a renamed or newly added service in
	// decisions.go must widen the assertion, never silently shrink it.
	meta := []byte(`{
		"infra_services": [
			{"service":"brand-new-service","status":"installed","reason":"r"}
		]
	}`)
	if _, err := DeriveExpectedArgoApps("aws", meta); err == nil || !strings.Contains(err.Error(), "unrecognized installed infra service") {
		t.Fatalf("want a fail-closed error for an unmapped installed service, got: %v", err)
	}
	// The same unknown service SKIPPED is fine — only installed services must map.
	skipped := []byte(`{"infra_services":[{"service":"brand-new-service","status":"skipped","reason":"r"}]}`)
	if _, err := DeriveExpectedArgoApps("aws", skipped); err != nil {
		t.Fatalf("a skipped unknown service must not error, got: %v", err)
	}
}

// ssotFactVariants are the InfraFacts inputs TestInfraServiceMapsCoverDecisionsSSOT
// enumerates to reach every service InfraServiceDecisions can record.
//
// Zero-value facts are NOT sufficient. Most decisions are unconditional (the service
// name is emitted whatever the facts say, only status/reason vary), but a decision may
// be CONDITIONALLY APPENDED — externalSecretsXacctStoreDecision returns ok=false unless
// the project selected a cross-account secret manager, so it is invisible to a
// zero-value enumeration and the "stale service" check below would reject its map entry
// as unrecognized. A new conditionally-appended decision must add a variant here that
// turns it on, or this guard silently stops covering it.
var ssotFactVariants = map[string]*argocd.InfraFacts{
	"zero value": {},
	// turns on externalSecretsXacctStoreDecision (any provider — the service name is
	// the same on all of them; only the reason differs)
	"cross-account secret store selected": {
		Provider:               "aws",
		IRSAExternalSecretsArn: "arn:aws:iam::111111111111:role/eks-ue1-dev-x-secrets-operator",
		SecretsXacctRef:        "arn:aws:iam::222222222222:role/AlethiaSecretsReadRole",
	},
	// Everything ON. The two variants above leave nearly every decision "skipped", and the
	// map coverage that matters is over INSTALLED decisions — a skipped service is never
	// looked up, so a variant set that installs nothing proves nothing about the lookup.
	// Every cloud's identity/certificate/WAF fact is set at once: TestInfraServiceMapsCover-
	// DecisionsSSOT overrides Provider per iteration, and a fact belonging to another cloud is
	// simply unread by the arm that runs.
	"every installable service turned on": {
		DNSEnabled:             true,
		DomainName:             "example.com",
		DNSCredentialPresent:   true,
		AppsDestinationRepo:    "https://github.com/acme/apps",
		ACMCertificateArn:      "arn:aws:acm:us-east-1:111111111111:certificate/abc",
		WAFWebACLArn:           "arn:aws:wafv2:us-east-1:111111111111:regional/webacl/app/0c4e-1",
		IRSAExternalSecretsArn: "arn:aws:iam::111111111111:role/eks-ue1-dev-x-secrets-operator",
		// ManagedCertificate is the canvas ASK, and on gcp/azure it is now the whole certificate
		// story — both converged onto cert-manager, so there is no per-cloud certificate fact to
		// set. The solver's per-cloud identity/zone facts below are what make CertManagerEnabled
		// true on each, and without them "every installable service turned on" would quietly not
		// include the ingress on either cloud.
		ManagedCertificate:            true,
		ClusterName:                   "mock-cluster",
		GCPExternalDNSSA:              "external-dns@mock-project.iam.gserviceaccount.com",
		GCPExternalSecretsSA:          "external-secrets@mock-project.iam.gserviceaccount.com",
		GCPProjectID:                  "mock-project",
		GCPDNSZoneName:                "mock-zone",
		GCPArmorPolicy:                "alethia-nl-production-armor-policy",
		AzureExternalDNSClient:        "11111111-2222-3333-4444-555555555555",
		AzureExternalSecretsClient:    "66666666-7777-8888-9999-000000000000",
		AzureKeyVaultURI:              "https://mock-kv.vault.azure.net/",
		AzureResourceGroup:            "rg-mock",
		AzureSubscriptionID:           "99999999-8888-7777-6666-555555555555",
		AzureTenantID:                 "12121212-3434-5656-7878-909090909090",
		AzureIngressClient:            "22222222-3333-4444-5555-666666666666",
		AzureAppGatewayName:           "agw-mock",
		AlibabaExternalSecretsRoleArn: "acs:ram::111111111111:role/alethia-eso",
	},
}

func TestInfraServiceMapsCoverDecisionsSSOT(t *testing.T) {
	// Tie infraServiceArgoApps + infraServiceNoApp to the REAL decision list: every service
	// InfraServiceDecisions can record must resolve, ON EVERY CLOUD, to exactly one of "this
	// Application" or "no Application here" — and the maps must contain nothing else, so a
	// rename/add/remove in decisions.go breaks this test instead of silently shrinking the
	// assertion.
	//
	// The enumeration crosses the variants with every provider rather than trusting each
	// variant's own Provider field. Both maps are provider-keyed now — "ingress" is an
	// Application on AWS and nothing at all on GKE — so a service-level check would pass while
	// a cloud in between resolved to neither, which is the exact hole that lets a run wait out
	// the ArgoCD timeout on an app nobody rendered.
	seen := map[string]struct{}{}
	for _, provider := range t2AllProviders() {
		for name, base := range ssotFactVariants {
			facts := *base
			facts.Provider = provider
			for _, d := range argocd.InfraServiceDecisions(&facts) {
				seen[d.Service] = struct{}{}
				// The exactly-one rule binds where the derivation actually LOOKS: on an
				// installed decision. A skipped one is `continue`d before either map is
				// consulted, and demanding an entry for it would force every lane to claim
				// something about a cloud it does not ship on.
				if d.Status != "installed" {
					continue
				}
				_, hasApp := argoAppForInfraService(provider, d.Service)
				noApp := infraServiceShipsNoApp(provider, d.Service)
				if hasApp == noApp { // neither, or both
					t.Errorf("service %q on provider %q (facts: %s) must resolve to exactly one of an Application or infraServiceNoApp (hasApp=%v noApp=%v)", d.Service, provider, name, hasApp, noApp)
				}
			}
		}
	}
	// Independently of any cloud: a service the decisions can record must be KNOWN to at least
	// one of the maps. Without this, a brand-new service that happens never to be "installed"
	// in the variants above would slip through the per-cloud loop entirely and only be caught
	// on a live run.
	for s := range seen {
		_, hasApp := infraServiceArgoApps[s]
		_, noApp := infraServiceNoApp[s]
		if !hasApp && !noApp {
			t.Errorf("service %q is recorded by InfraServiceDecisions but appears in neither infraServiceArgoApps nor infraServiceNoApp", s)
		}
	}
	for s := range infraServiceArgoApps {
		if _, ok := seen[s]; !ok {
			t.Errorf("infraServiceArgoApps has stale service %q — not recorded by InfraServiceDecisions", s)
		}
	}
	for s := range infraServiceNoApp {
		if _, ok := seen[s]; !ok {
			t.Errorf("infraServiceNoApp has stale service %q — not recorded by InfraServiceDecisions", s)
		}
	}
}

func TestSeedAddOnsPinnedToCatalog(t *testing.T) {
	// The seeded add-ons must be EXACTLY what the console emits for the same ids.
	//
	// This used to string-grep apps/console/lib/addons/catalog.ts for four scalar fields
	// (version/chartRepo/chart/namespace) against a hand-written Go literal. That pin is what let
	// #643 through: it gave reloader real knob defaults, and `values` was not in the four-field list,
	// so the literal kept emitting `{}` and this test stayed green for three weeks (#1965). A pin
	// that silently omits the field that drifted is worse than no pin, because it reads as coverage.
	//
	// Now both sides come from the generated fixture, so the comparison can be TOTAL — every field of
	// the install spec, including `values`, with no hand-maintained field list to fall out of date.
	// The fixture↔catalog.ts edge is held by the console's own catalog-export.test.ts, which
	// regenerates in-memory and deep-equals; this asserts the Go seed sits on that same artifact.
	catalog, err := AllCatalogAddOns()
	if err != nil {
		t.Fatalf("load generated add-on catalog: %v", err)
	}
	byID := make(map[string]types.AddOnInstall, len(catalog))
	for _, a := range catalog {
		byID[a.ID] = a
	}
	for _, a := range seedAddOns() {
		want, ok := byID[a.ID]
		if !ok {
			t.Errorf("seeded add-on %q is not in the generated catalog fixture — regenerate: pnpm -C apps/console run export:addon-catalog", a.ID)
			continue
		}
		if !reflect.DeepEqual(a, want) {
			t.Errorf("seeded add-on %q diverges from the console's install spec.\n seeded: %+v\ncatalog: %+v\n"+
				"the seed should DERIVE from the generated fixture (CatalogAddOn), never restate it", a.ID, a, want)
		}
	}
}

func TestDeriveExpectedArgoApps_EmptyMetadataFails(t *testing.T) {
	if _, err := DeriveExpectedArgoApps("aws", nil); err == nil {
		t.Fatal("want an error for empty execution_metadata")
	}
	if _, err := DeriveExpectedArgoApps("aws", []byte("{not json")); err == nil {
		t.Fatal("want an error for malformed execution_metadata")
	}
}

// ── the provider-keyed infraServiceArgoApps map ──────────────────────────────────

// t2AllProviders lists the provider keys the derivation accepts, sorted, so the guards below
// enumerate the SAME set DeriveExpectedArgoApps will refuse to answer for.
func t2AllProviders() []string {
	out := make([]string, 0, len(t2ProviderTable))
	for k := range t2ProviderTable {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Every cloud whose "ingress" decision is INSTALLED must either name the Application it renders
// or be recorded as shipping none ON THAT CLOUD. This is the metricsServerProviders lesson
// (#1722) applied to the seam the per-cloud ingress lanes land on: the decision lives in
// packages/core, the Application name lives in this module, they are edited in different PRs,
// and a cloud that installs a controller nobody named here would make every run on that cloud
// wait out the full ArgoCD timeout for an app that was never rendered.
//
// "Or ships none" is not a loophole — it is the GKE case, where the Ingress controller runs in
// the Google-managed control plane and Alethia installs nothing. Saying so EXPLICITLY, per
// cloud, is what keeps it from becoming one: a cloud that is in neither map still fails.
//
// It reads the REAL decision (not a copy of the table), so a lane cannot satisfy it by
// editing a list.
func TestInstalledIngressDecisionsNameAnApplication(t *testing.T) {
	for _, provider := range t2AllProviders() {
		facts := &argocd.InfraFacts{Provider: provider}
		for _, d := range argocd.InfraServiceDecisions(facts) {
			if d.Service != "ingress" || d.Status != "installed" {
				continue
			}
			app, ok := argoAppForInfraService(provider, "ingress")
			if !ok {
				if !infraServiceShipsNoApp(provider, "ingress") {
					t.Errorf("provider %q installs an ingress controller (%s) but neither infraServiceArgoApps[\"ingress\"] nor infraServiceNoApp[\"ingress\"] has an entry for it — name the Application it renders, or record that it renders none, or the T2 run waits out the full ArgoCD timeout for an app nobody created", provider, d.Reason)
				}
				continue
			}
			if app == "" {
				t.Errorf("provider %q resolves to an EMPTY ingress Application name", provider)
			}
		}
	}
	// The two entries that exist today, asserted explicitly so a bad refactor that made the loop
	// above vacuous (e.g. every decision suddenly "skipped") still fails.
	if app, ok := argoAppForInfraService("aws", "ingress"); !ok || app != "aws-load-balancer-controller" {
		t.Errorf("argoAppForInfraService(aws, ingress) = (%q, %v), want the ALB controller", app, ok)
	}
	if !infraServiceShipsNoApp("gcp", "ingress") {
		t.Error("gcp's built-in GKE Ingress must be recorded in infraServiceNoApp — it installs no Application")
	}
	// …and the no-app entry must NOT leak: it is keyed on gcp alone, so a lane that ships an
	// Azure or Alibaba controller is still forced to name it.
	for _, provider := range []string{"aws", "azure", "alibaba", "hetzner"} {
		if infraServiceShipsNoApp(provider, "ingress") {
			t.Errorf("provider %q inherited gcp's \"ingress ships no Application\" entry — the no-app whitelist must stay per-cloud", provider)
		}
	}
}

// The provider-keyed lookup must fall back to the anyProvider entry for cloud-agnostic
// services, and must NOT leak a per-cloud entry to another cloud.
func TestArgoAppForInfraService_ProviderResolution(t *testing.T) {
	// The clouds that ship their own ingress controller, and the Application each renders. The
	// point of the loop below is that a cloud gets ITS OWN entry or nothing at all — the ALB
	// controller must never resolve on azure, nor AGIC on aws.
	ingressApps := map[string]string{
		"aws":   "aws-load-balancer-controller",
		"azure": "ingress-azure",
	}
	for _, provider := range t2AllProviders() {
		if app, ok := argoAppForInfraService(provider, "external-dns"); !ok || app != "external-dns" {
			t.Errorf("%s: cloud-agnostic service did not fall back to the anyProvider entry: (%q, %v)", provider, app, ok)
		}
		app, ok := argoAppForInfraService(provider, "ingress")
		want, hasController := ingressApps[provider]
		switch {
		case hasController && (!ok || app != want):
			t.Errorf("%s: ingress resolved to (%q, %v), want %q", provider, app, ok, want)
		case !hasController && ok:
			t.Errorf("%s: resolved another cloud's ingress Application %q — a per-cloud entry must not leak across clouds", provider, app)
		}
	}
	if _, ok := argoAppForInfraService("aws", "no-such-service"); ok {
		t.Error("an unknown service must not resolve to an Application")
	}
}

// FAIL-CLOSED across the provider dimension: an "installed" ingress on a cloud with no entry
// is a hard derivation error, exactly like an unknown service. This is the guard that stops a
// lane shipping a controller whose Application the assertion never checks.
func TestDeriveExpectedArgoApps_InstalledIngressOnUnmappedCloudFails(t *testing.T) {
	meta := []byte(`{"infra_services":[{"service":"ingress","status":"installed","reason":"a controller this test invented"}]}`)
	// ⚠️ THE FIXTURE CLOUD MOVES EVERY TIME AN INGRESS LANE LANDS, and it has moved twice: gcp →
	// azure (gcp became mapped as "installs no Application", its controller being in the managed
	// control plane) → alibaba (azure became mapped to the AGIC Application). Using a MAPPED cloud
	// here does not fail the test — it makes it pass for the wrong reason, which is worse.
	//
	// alibaba is the durable choice rather than the next one along: it is unmapped ON PURPOSE and
	// expected to stay that way, because ACK ships its own nginx-ingress-controller and a second
	// one from Alethia would be the #1722 ownership collision. If a lane ever does map it, pick
	// another genuinely-unmapped cloud — never one that merely has not landed yet.
	if _, err := DeriveExpectedArgoApps("alibaba", meta); err == nil {
		t.Fatal("expected a hard error for an installed ingress on a cloud in neither infraServiceArgoApps nor infraServiceNoApp")
	}
	// gcp, in contrast, derives CLEANLY and adds nothing — the no-app path, pinned so a future
	// edit cannot turn it back into an error or into a phantom Application.
	gcpApps, gcpErr := DeriveExpectedArgoApps("gcp", meta)
	if gcpErr != nil {
		t.Fatalf("gcp: an installed ingress that ships no Application must derive cleanly: %v", gcpErr)
	}
	for _, a := range gcpApps {
		if strings.Contains(a, "ingress") || a == "" {
			t.Errorf("gcp expected set %v contains an ingress Application — GKE's controller renders none", gcpApps)
		}
	}
	// The same record on AWS resolves, so the failure above is about the PROVIDER, not the
	// service name — otherwise this guard would pass for the wrong reason.
	apps, err := DeriveExpectedArgoApps("aws", meta)
	if err != nil {
		t.Fatalf("aws: %v", err)
	}
	if !containsString(apps, "aws-load-balancer-controller") {
		t.Errorf("aws expected set = %v, want the ALB controller", apps)
	}
}

// The WAF attach is an ANNOTATION on the ArgoCD ingress, not an Application — an installed
// "waf" decision must derive cleanly and add nothing to the expected set.
func TestDeriveExpectedArgoApps_WAFShipsNoApplication(t *testing.T) {
	meta := []byte(`{"infra_services":[{"service":"waf","status":"installed","reason":"attached"}],"addon_status":{"addon-reloader":{}}}`)
	apps, err := DeriveExpectedArgoApps("aws", meta)
	if err != nil {
		t.Fatalf("DeriveExpectedArgoApps: %v", err)
	}
	for _, a := range apps {
		if strings.Contains(a, "waf") {
			t.Errorf("expected set %v contains a WAF Application — the attach is an annotation, it renders none", apps)
		}
	}
}

// containsString lives in maxconfig.go: the in-cluster carriage verdict needs it in NON-test code
// (it checks an ArgoCD Application name against the converged set), so the test-local copy that used
// to sit here would now be a redeclaration.

// The AGIC Application name is a THREE-WAY constant: the template's `metadata.name`, the
// infraServiceArgoApps entry this assertion derives the expected set from, and — through
// `fullnameOverride` — the ServiceAccount name the azure template's federated identity credential
// trusts. A rename in one place and not the others produces either a run that waits out the whole
// ArgoCD timeout for an Application nobody rendered (the #1722 shape, one dimension over) or a
// controller whose token exchange silently fails. Parsed from the template, like
// TestMetricsServerGateMatchesTemplate, rather than restated.
func TestAGICApplicationNameMatchesTemplate(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root := filepath.Join(filepath.Dir(thisFile), "..", "..")
	path := filepath.Join(root, "infra", "templates", "argocd", "azure-application-gateway-ingress.yaml")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}

	name := regexp.MustCompile(`(?m)^metadata:\n\s+name:\s+(\S+)`).FindSubmatch(b)
	if name == nil {
		t.Fatalf("no Application metadata.name found in %s", path)
	}
	want, ok := argoAppForInfraService("azure", "ingress")
	if !ok {
		t.Fatalf("azure has no infraServiceArgoApps entry for \"ingress\" — the decision would resolve to nothing and hard-error the derivation")
	}
	if got := string(name[1]); got != want {
		t.Fatalf("AGIC Application name DRIFT:\n  template %s renders: %q\n  infraServiceArgoApps[\"ingress\"][\"azure\"]: %q", path, got, want)
	}

	// fullnameOverride is what pins the chart's ServiceAccount name; the azure template's
	// federated identity credential trusts `system:serviceaccount:agic:<that name>`.
	if !regexp.MustCompile(`fullnameOverride:\s+` + regexp.QuoteMeta(want)).Match(b) {
		t.Errorf("%s must set fullnameOverride: %s — without it the chart derives its ServiceAccount name from the Helm release name and the federated credential's subject no longer matches", path, want)
	}
	if !regexp.MustCompile(`namespace:\s+agic`).Match(b) {
		t.Errorf("%s must deploy into the `agic` namespace named by the federated credential's subject", path)
	}

	// The gate must be azure-only. A missing provider term would render the Application on every
	// cloud, where the chart has no gateway to reconcile onto.
	gate := regexp.MustCompile(`\{\{-?\s*if\s+([^}]*?)\s*-?\}\}`).FindSubmatch(b)
	if gate == nil {
		t.Fatalf("no {{ if }} gate found in %s — AGIC would render on every cloud", path)
	}
	if !regexp.MustCompile(`eq\s+\.Provider\s+"azure"`).Match(gate[1]) {
		t.Errorf("AGIC gate %q must be azure-only", gate[1])
	}
}

// TestRequireAllAddOnsExpected pins the guard that stops a full-surface run reporting the floor.
//
// Run 32883521925 PASSED the `addons` dimension having asserted four Applications —
// [addon-byo-e2e apps external-secrets-operator metrics-server] — because the expected set is
// derived from execution_metadata.addon_status and that persistence had silently failed. Four is
// not zero, so DeriveExpectedArgoApps's "never empty" check did not fire.
//
// The axis varied here is THE COMPLETENESS OF THE SET, not whether it is empty — an empty-set test
// would have passed against the bug.
func TestRequireAllAddOnsExpected(t *testing.T) {
	catalog, err := AllCatalogAddOns()
	if err != nil {
		t.Fatalf("catalog fixture: %v", err)
	}
	var wantApps []string
	for _, a := range catalog {
		if a.Mode == "managed" && !a.IsManifestSource() {
			wantApps = append(wantApps, argocd.AddOnAppName(a.ID))
		}
	}
	if len(wantApps) < 2 {
		t.Fatalf("the catalog fixture yields %d Application-bearing add-ons — this test would be vacuous", len(wantApps))
	}

	t.Run("off by default: the lean tier is not required to carry the catalog", func(t *testing.T) {
		t.Setenv("ALETHIA_E2E_ALL_ADDONS", "")
		if err := RequireAllAddOnsExpected([]string{"external-secrets-operator"}); err != nil {
			t.Errorf("the lean tier must not be held to the full surface: %v", err)
		}
	})

	t.Run("THE REGRESSION: the real four-app set is refused", func(t *testing.T) {
		t.Setenv("ALETHIA_E2E_ALL_ADDONS", "1")
		err := RequireAllAddOnsExpected([]string{"addon-byo-e2e", "apps", "external-secrets-operator", "metrics-server"})
		if err == nil {
			t.Fatal("a full-surface run asserting four Applications must be refused — this is run 32883521925")
		}
		// The failure has to name what is missing; "incomplete" alone sends the reader to a cluster.
		if !strings.Contains(err.Error(), "ABSENT") {
			t.Errorf("the failure must say what is absent, got %q", err)
		}
		for _, probe := range wantApps[:2] {
			if !strings.Contains(err.Error(), probe) {
				t.Errorf("the failure must NAME the missing add-on %q, got %q", probe, err)
			}
		}
		// And it must point at the cause, which is not the assertion.
		if !strings.Contains(err.Error(), "recordAddonHealth") {
			t.Errorf("the failure should point at the persistence that shrank the set, got %q", err)
		}
	})

	t.Run("the complete set passes", func(t *testing.T) {
		t.Setenv("ALETHIA_E2E_ALL_ADDONS", "1")
		full := append([]string{"external-secrets-operator", "metrics-server"}, wantApps...)
		if err := RequireAllAddOnsExpected(full); err != nil {
			t.Errorf("a complete set must pass: %v", err)
		}
	})

	t.Run("ONE missing add-on is still refused", func(t *testing.T) {
		// The interesting boundary is not four-of-twenty; it is nineteen-of-twenty, which a
		// count-based check tuned to "roughly the right size" would wave through.
		t.Setenv("ALETHIA_E2E_ALL_ADDONS", "1")
		full := append([]string{"external-secrets-operator", "metrics-server"}, wantApps[1:]...)
		err := RequireAllAddOnsExpected(full)
		if err == nil {
			t.Fatal("a single missing add-on must still fail — the surface is not 'roughly complete'")
		}
		if !strings.Contains(err.Error(), wantApps[0]) {
			t.Errorf("the one missing add-on must be named, got %q", err)
		}
	})
}

// TestArgoReportNamesOutOfSyncResources pins the diagnosis that a Healthy-but-OutOfSync app needs.
//
// On 2026-08-26 three add-ons sat Healthy/OutOfSync on BOTH hetzner and aws — argo-rollouts,
// kyverno and tempo. The workload is up, nothing in the cluster is wrong, and the run still loses
// its verdict. The report named the Applications and not what differed, so acting on it meant
// reaching for a live cluster.
//
// The answer was already in the payload this assertion fetches: `.status.resources[]` carries a
// per-resource sync status, and it was being discarded.
func TestArgoReportNamesOutOfSyncResources(t *testing.T) {
	raw := []byte(`{"items":[
	  {"metadata":{"name":"addon-kyverno"},"status":{
	     "health":{"status":"Healthy"},"sync":{"status":"OutOfSync"},
	     "resources":[
	       {"group":"apiextensions.k8s.io","kind":"CustomResourceDefinition","name":"policies.kyverno.io","status":"OutOfSync"},
	       {"group":"apps","kind":"Deployment","name":"kyverno-admission-controller","status":"Synced"},
	       {"group":"apiextensions.k8s.io","kind":"CustomResourceDefinition","name":"policies.kyverno.io","status":"OutOfSync"}
	     ]}}
	]}`)
	observed, err := parseArgoApps(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	st := observed["addon-kyverno"]

	if len(st.OutOfSyncResources) != 1 {
		t.Fatalf("want the OutOfSync resource named once (deduped), got %v", st.OutOfSyncResources)
	}
	if st.OutOfSyncResources[0] != "apiextensions.k8s.io/CustomResourceDefinition/policies.kyverno.io" {
		t.Errorf("the label must carry group/kind/name so the resource class is identifiable, got %q", st.OutOfSyncResources[0])
	}

	// A SYNCED resource inside an OutOfSync app is the part that is fine, and must not be listed.
	for _, r := range st.OutOfSyncResources {
		if strings.Contains(r, "kyverno-admission-controller") {
			t.Errorf("a Synced resource must not appear in the OutOfSync list: %v", st.OutOfSyncResources)
		}
	}

	_, err = evaluateArgoApps(observed, []string{"addon-kyverno"})
	if err == nil {
		t.Fatal("a Healthy/OutOfSync app must still fail the assertion")
	}
	if !strings.Contains(err.Error(), "policies.kyverno.io") {
		t.Errorf("the failure must NAME the differing resource — that is the whole diagnosis:\n%s", err)
	}
}

// TestArgoReportSaysWhenNoResourceDetail — an OutOfSync app whose resource list is empty must say
// so. Silence there reads as a clean diff, which is the defect class this repo keeps paying for.
func TestArgoReportSaysWhenNoResourceDetail(t *testing.T) {
	raw := []byte(`{"items":[{"metadata":{"name":"addon-x"},"status":{
	  "health":{"status":"Healthy"},"sync":{"status":"OutOfSync"},"resources":[]}}]}`)
	observed, err := parseArgoApps(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	_, err = evaluateArgoApps(observed, []string{"addon-x"})
	if err == nil {
		t.Fatal("still a failure")
	}
	if !strings.Contains(err.Error(), "no per-resource detail") {
		t.Errorf("an empty resource list must be reported as absent detail, not as nothing differing:\n%s", err)
	}
}

// TestArgoReportOmitsResourceLineWhenSynced — a Healthy+Synced app is not in the report at all, and
// a Degraded-but-Synced one must not grow a misleading empty OutOfSync line.
func TestArgoReportOmitsResourceLineWhenSynced(t *testing.T) {
	raw := []byte(`{"items":[{"metadata":{"name":"addon-y"},"status":{
	  "health":{"status":"Degraded"},"sync":{"status":"Synced"},"resources":[]}}]}`)
	observed, _ := parseArgoApps(raw)
	_, err := evaluateArgoApps(observed, []string{"addon-y"})
	if err == nil {
		t.Fatal("Degraded must fail")
	}
	if strings.Contains(err.Error(), "OutOfSync:") {
		t.Errorf("a Synced app must not carry an OutOfSync detail line:\n%s", err)
	}
}

// TestKubectlTargetIncludesTheGroup — a bare `kubectl get customresourcedefinition/x` is ambiguous
// once a CRD of the same Kind exists in another group, and the dump would fetch the wrong object or
// nothing. Varying the GROUP is the axis that matters here.
func TestKubectlTargetIncludesTheGroup(t *testing.T) {
	cases := []struct {
		ref  outOfSyncRef
		want string
	}{
		{outOfSyncRef{Kind: "Secret", Name: "addon-minio"}, "secret/addon-minio"},
		{outOfSyncRef{Group: "apps", Kind: "StatefulSet", Name: "addon-tempo"}, "statefulset.apps/addon-tempo"},
		{outOfSyncRef{Group: "batch", Kind: "CronJob", Name: "kyverno-cleanup-admission-reports"}, "cronjob.batch/kyverno-cleanup-admission-reports"},
		{outOfSyncRef{Group: "apiextensions.k8s.io", Kind: "CustomResourceDefinition", Name: "rollouts.argoproj.io"},
			"customresourcedefinition.apiextensions.k8s.io/rollouts.argoproj.io"},
	}
	for _, tc := range cases {
		if got := tc.ref.kubectlTarget(); got != tc.want {
			t.Errorf("kubectlTarget() = %q, want %q", got, tc.want)
		}
	}
}

// TestRefsForLosersTakesOnlyTheLosers — dumping a Synced app's resources would bury the failing
// ones in noise, and dumping nothing would make the whole diagnostic inert.
func TestRefsForLosersTakesOnlyTheLosers(t *testing.T) {
	observed := map[string]argoAppState{
		"addon-tempo": {Health: "Healthy", Sync: "OutOfSync", OutOfSyncRefs: []outOfSyncRef{
			{Group: "apps", Kind: "StatefulSet", Name: "addon-tempo", Namespace: "tempo"},
		}},
		"addon-keda": {Health: "Healthy", Sync: "Synced"},
	}
	refs := refsForLosers(observed, []string{"addon-tempo"})
	if len(refs) != 1 || refs[0].Name != "addon-tempo" || refs[0].Namespace != "tempo" {
		t.Fatalf("refsForLosers = %+v, want the one tempo StatefulSet with its namespace", refs)
	}
	// A loser with no recorded refs (Missing, never rendered) must not panic or invent one.
	if got := refsForLosers(observed, []string{"addon-velero"}); len(got) != 0 {
		t.Errorf("an app absent from the observed map yielded refs: %+v", got)
	}
	if got := refsForLosers(observed, nil); len(got) != 0 {
		t.Errorf("no losers yielded refs: %+v", got)
	}
}

// TestDumpOutOfSyncResourcesIsANoOpWithNothingToDump — this runs on an already-failing path, so an
// empty ref set must cost nothing and add no confusing header. Proven by passing a kubeconfig path
// that cannot work: if it ever shelled out, this would not return empty.
func TestDumpOutOfSyncResourcesIsANoOpWithNothingToDump(t *testing.T) {
	if got := dumpOutOfSyncResources(t.Context(), "/nonexistent/kubeconfig", nil); got != "" {
		t.Errorf("empty ref set produced output: %q", got)
	}
}

// #2866: falco's `scap_init` sub-errors scrolled off a 40-line tail, so a paid run could not say
// WHICH probe requirement the kernel refused. The longer tail and the `--previous` fetch are both
// gated on this predicate, so a wrong answer here silently restores the old blindness — a pod that
// is crash-looping but reads as healthy gets 40 lines and no crashed-instance log.
func TestCrashLooping(t *testing.T) {
	// Whitespace-split lines exactly as the custom-columns listing produces them:
	// NS NAME PHASE READY RESTARTS REASON
	cases := []struct {
		name string
		line string
		want bool
	}{
		{
			// The shape that motivated this: falco on Talos, one container ready and one not.
			"crashloopbackoff with restarts",
			"falco addon-falco-2fqps Running false,true 10,0 CrashLoopBackOff",
			true,
		},
		{
			// Sampled mid-restart: the kubelet is not WAITING, so there is no reason at all, and
			// only the restart count carries the signal.
			"restarts but no reason yet",
			"falco addon-falco-2fqps Running false,true 3,0 <none>",
			true,
		},
		{
			// The mirror case: killed once, backing off, count not yet meaningful.
			"reason but no restarts yet",
			"falco addon-falco-2fqps Pending false 0 CrashLoopBackOff",
			true,
		},
		{
			// A non-zero count in the SECOND container only — the reason a bare
			// `fields[4] != "0"` string comparison is not enough.
			"restart on a later container only",
			"harbor addon-harbor-core-x Running true,false 0,7 <none>",
			true,
		},
		{
			// Unhealthy for a reason that is NOT a crash: the pod never started, so there is no
			// previous instance to fetch and nothing scrolled off.
			"pending on image pull is not a crash loop",
			"velero addon-velero-x Pending false 0 ImagePullBackOff",
			false,
		},
		{
			"healthy pod",
			"reloader addon-reloader-x Running true 0 <none>",
			false,
		},
		{
			"no restarts across several containers",
			"harbor addon-harbor-core-x Running true,true 0,0 <none>",
			false,
		},
		{
			// This path runs while a run is ALREADY failing; a short line must not panic.
			"truncated line",
			"ns pod Running",
			false,
		},
		{
			"empty line",
			"",
			false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := crashLooping(strings.Fields(tc.line)); got != tc.want {
				t.Fatalf("crashLooping(%q) = %v, want %v", tc.line, got, tc.want)
			}
		})
	}
}

// The `argocd app diff` dump execs into the argocd-server Deployment, and the name it used —
// `argocd-server` — does not exist. The chart is installed as `helm upgrade --install argo-cd
// argo/argo-cd`, so the real Deployment is `argo-cd-argocd-server`, and every diff came back
// `Error from server (NotFound)`. Five Applications sat Healthy+OutOfSync across three PAID runs
// with the differing field still unknown, because the diagnostic that would name it could never run.
//
// These pin the reporting contract rather than the exec: a resolution failure must read as "could
// not ask", never as "nothing differs" — those are opposite findings and #2778 is explicit that a
// GUESSED ignoreDifferences entry can mask real drift.
func TestArgoDiffResolutionFailureIsNotSilence(t *testing.T) {
	// interpretArgoDiff's "could not ask" branch, for contrast with the two real verdicts below.
	got := interpretArgoDiff("addon-tempo", "", errors.New("could not resolve the argocd-server Deployment"))
	if !strings.Contains(got, "addon-tempo") {
		t.Errorf("the report must name the Application; got %q", got)
	}
	for _, forbidden := range []string{"no difference", "nothing differs", "in sync"} {
		if strings.Contains(strings.ToLower(got), forbidden) {
			t.Errorf("a failure to ASK rendered as a finding of no difference (%q): %s", forbidden, got)
		}
	}
}

func TestArgoDiffVerdictsAreDistinct(t *testing.T) {
	// exit 1 WITH output is the success case — a diff was found. Anything that treats a non-nil
	// error as a failure here throws away the only output the whole path exists to produce.
	found := interpretArgoDiff("addon-tempo", "  spec:\n-   replicas: 1\n+   replicas: 2\n", &exec.ExitError{})
	// exit 0 with no output: ArgoCD genuinely sees no difference despite the app reporting
	// OutOfSync. Real and specific, and NOT the same as the case above or the one below.
	none := interpretArgoDiff("addon-tempo", "", nil)
	// Neither may be indistinguishable from a failure to look.
	broken := interpretArgoDiff("addon-tempo", "", errors.New("boom"))

	if found == none || found == broken || none == broken {
		t.Errorf("the three outcomes must be distinguishable:\nfound=%q\nnone=%q\nbroken=%q", found, none, broken)
	}
	if !strings.Contains(found, "replicas") {
		t.Errorf("the diff body must survive into the report; got %q", found)
	}
}

// The three outcomes of resolving the argocd-server Deployment. Two of them are easy to collapse
// into each other and they send someone to different places — "kubectl failed" versus "kubectl
// succeeded and matched nothing" — and NEITHER may end up rendering as "there is no diff".
func TestPickArgoDiffWorkload(t *testing.T) {
	t.Run("takes the first match", func(t *testing.T) {
		got, err := pickArgoDiffWorkload("statefulset.apps/argo-cd-argocd-application-controller\n", nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		// The release-name prefix is the whole point: the hardcoded `argocd-server` never existed.
		if got != "statefulset.apps/argo-cd-argocd-application-controller" {
			t.Errorf("got %q", got)
		}
	})

	t.Run("two installs in one namespace still resolves", func(t *testing.T) {
		got, err := pickArgoDiffWorkload("statefulset.apps/a-argocd-application-controller\ndeployment.apps/b-argocd-application-controller\n", nil)
		if err != nil || got != "statefulset.apps/a-argocd-application-controller" {
			t.Errorf("got %q, %v", got, err)
		}
	})

	t.Run("kubectl failed is reported as a failure to ASK", func(t *testing.T) {
		_, err := pickArgoDiffWorkload("Error from server (Forbidden)", errors.New("exit 1"))
		if err == nil {
			t.Fatal("a kubectl failure must not resolve to a deployment")
		}
		// The stderr carries the actual reason (forbidden, no such namespace, bad kubeconfig) and
		// those are three different remedies; a bare exit status is not actionable.
		if !strings.Contains(err.Error(), "Forbidden") {
			t.Errorf("the underlying reason must survive; got %v", err)
		}
	})

	t.Run("matched nothing is its own finding, not a kubectl failure", func(t *testing.T) {
		_, err := pickArgoDiffWorkload("   \n", nil)
		if err == nil {
			t.Fatal("empty output must not resolve to a deployment")
		}
		if !strings.Contains(err.Error(), "app.kubernetes.io/name=argocd-application-controller") {
			t.Errorf("the message must name the label that matched nothing; got %v", err)
		}
	})
}

// Covers the exec wrapper's failure path. Hermetic by construction: whether kubectl is absent or
// the kubeconfig does not exist, both are errors, and the contract asserted is only that a failure
// to ASK never resolves to a deployment ref — which is what would silently send `kubectl exec` at
// an empty target.
func TestArgoDiffWorkloadUnreachableIsAnError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	got, err := argoDiffWorkload(ctx, filepath.Join(t.TempDir(), "no-such-kubeconfig"))
	if err == nil {
		t.Fatalf("an unreachable cluster must not resolve a deployment; got %q", got)
	}
	if got != "" {
		t.Errorf("a failed resolution must return no target, got %q", got)
	}
}

// #2910's verdicts. The distinction this pins is the whole bug: an ABSENT `automated` policy and one
// PRESENT with both sub-options false look almost identical in a manifest and mean opposite things —
// never synced at all, versus synced once and then left alone.
func TestInterpretByoSyncPolicy(t *testing.T) {
	yes, no := true, false

	t.Run("absent is the regression, and says why", func(t *testing.T) {
		err := interpretByoSyncPolicy("addon-byo-e2e", nil)
		if err == nil {
			t.Fatal("a missing automated policy must fail — it is the silent no-op")
		}
		// The message has to name the consequence, not just the field: a reader who only sees
		// "syncPolicy.automated is nil" has no reason to think anything is broken.
		if !strings.Contains(err.Error(), "deploy nothing") {
			t.Errorf("the failure must say what it costs the customer; got %v", err)
		}
	})

	t.Run("present with both false is correct", func(t *testing.T) {
		if err := interpretByoSyncPolicy("addon-byo-e2e", &byoAutoSyncPolicy{Prune: &no, SelfHeal: &no}); err != nil {
			t.Errorf("prune=false selfHeal=false is the intended policy, got %v", err)
		}
	})

	t.Run("prune true is the opposite regression", func(t *testing.T) {
		err := interpretByoSyncPolicy("addon-byo-e2e", &byoAutoSyncPolicy{Prune: &yes, SelfHeal: &no})
		if err == nil {
			t.Fatal("prune=true would delete a customer's workload once their chart stopped declaring it")
		}
	})

	t.Run("selfHeal true is rejected too", func(t *testing.T) {
		err := interpretByoSyncPolicy("addon-byo-e2e", &byoAutoSyncPolicy{Prune: &no, SelfHeal: &yes})
		if err == nil {
			t.Fatal("selfHeal=true would revert an operator debugging their own chart")
		}
	})

	t.Run("an empty automated block is ACCEPTED — absent means false", func(t *testing.T) {
		// REVERSED, with a measured reason. This asserted that `{}` must be rejected ("both must be
		// explicitly false"), and that rule was unsatisfiable on a live cluster: hetzner/floor run
		// 33092056761 read back
		//
		//	observed spec.syncPolicy.automated: {}
		//
		// from an Application whose manifest carried `prune: false` / `selfHeal: false`, verified at
		// every step from the renderer to a throwaway-cluster round-trip.
		//
		// ArgoCD v3.1.8 declares `Prune bool json:"prune,omitempty"` and the same for SelfHeal,
		// and SyncPolicyAutomated is byte-identical at v3.3.9, the version the 9.5.11 chart bundles,
		// while giving `Enabled` a *bool precisely so absent/true/false stay distinguishable there.
		// So false collapses to absent the moment ArgoCD serialises the object, and upstream's own
		// meaning for absent IS false.
		//
		// The old intent survives intact below: what must never be accepted is prune/selfHeal
		// TRUE, and true is non-zero, so omitempty cannot hide it.
		if err := interpretByoSyncPolicy("addon-byo-e2e", &byoAutoSyncPolicy{}); err != nil {
			t.Errorf("an empty automated block is auto-sync with prune/selfHeal off, which is the intended policy: %v", err)
		}
	})

	t.Run("a HALF-set block still catches a true", func(t *testing.T) {
		// The state omitempty actually produces for a bad policy: selfHeal survives because it is
		// true, prune vanishes because it is false. Rejecting this is the whole remaining job.
		yes := true
		if err := interpretByoSyncPolicy("addon-byo-e2e", &byoAutoSyncPolicy{SelfHeal: &yes}); err == nil {
			t.Error("selfHeal=true with prune omitted must still be rejected")
		}
		if err := interpretByoSyncPolicy("addon-byo-e2e", &byoAutoSyncPolicy{Prune: &yes}); err == nil {
			t.Error("prune=true with selfHeal omitted must still be rejected")
		}
	})

	t.Run("a MISSING automated block is still the #2910 regression", func(t *testing.T) {
		// The distinction that survives all of the above, and the one the cell exists for: no
		// `automated` at all means nothing ever syncs the chart. That is not the same as an empty
		// one, and loosening the empty case must not loosen this.
		if err := interpretByoSyncPolicy("addon-byo-e2e", nil); err == nil {
			t.Error("a BYO Application with no automated policy deploys nothing and must be rejected")
		}
	})
}

// Covers the exec wrapper around interpretByoSyncPolicy. Hermetic: whether kubectl is absent or the
// kubeconfig does not exist, both are errors, and the contract asserted is only that a failure to
// READ never passes as a satisfied policy — which would let the #2910 regression through green.
func TestAssertByoAutoSyncPolicyUnreachableIsAnError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	err := assertByoAutoSyncPolicy(ctx, filepath.Join(t.TempDir(), "no-such-kubeconfig"), "addon-byo-e2e")
	if err == nil {
		t.Fatal("an unreachable cluster must not report the sync policy as satisfied")
	}
}

// The evidence attached to a FAILING sync-policy verdict. aws/day2 run 33074136555 reported
// "prune/selfHeal unset" and nothing else, and that sentence fits two causes with opposite fixes —
// the emitter regressed, or something dropped the fields between the manifest and the stored
// object. What this asserts is that the next such failure carries the object itself.
func TestByoSyncEvidence(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	// Hermetic on purpose: no kubectl, or no kubeconfig, both land in the UNREADABLE branch.
	badKube := filepath.Join(t.TempDir(), "no-such-kubeconfig")

	t.Run("a passing verdict gains nothing", func(t *testing.T) {
		if got := withByoSyncEvidence(ctx, badKube, "addon-byo-e2e", `{"prune":false,"selfHeal":false}`, nil); got != nil {
			t.Errorf("a satisfied policy must stay silent, got %v", got)
		}
	})

	t.Run("a failing verdict carries what was read", func(t *testing.T) {
		verdict := errors.New("BYO Application addon-byo-e2e has syncPolicy.automated with prune/selfHeal unset")
		got := withByoSyncEvidence(ctx, badKube, "addon-byo-e2e", "{}", verdict)
		if got == nil {
			t.Fatal("evidence must not swallow the verdict")
		}
		// The observed value is the whole point: `{}` and `{"prune":true}` produce the same
		// sentence today and send a reader to different code.
		if !strings.Contains(got.Error(), "observed spec.syncPolicy.automated: {}") {
			t.Errorf("the observed block must be quoted verbatim; got %q", got)
		}
		if !errors.Is(got, verdict) {
			t.Error("the verdict must survive wrapping — a caller matching on it still has to work")
		}
	})

	t.Run("an unreadable dump does not become a verdict", func(t *testing.T) {
		// The second kubectl failing says nothing about whether the policy was right. If it were
		// allowed to overwrite the answer, a real #2910 regression would read as "could not check"
		// — the fail-open shape, on the assertion that exists to catch it.
		verdict := errors.New("BYO Application addon-byo-e2e carries NO syncPolicy.automated")
		got := withByoSyncEvidence(ctx, badKube, "addon-byo-e2e", "<absent>", verdict)
		if got == nil || !strings.Contains(got.Error(), "carries NO syncPolicy.automated") {
			t.Fatalf("the original verdict must survive an unreadable dump; got %v", got)
		}
		if !strings.Contains(got.Error(), "UNREADABLE") {
			t.Errorf("a failed dump must be LABELLED as unread, never rendered as an empty policy; got %q", got)
		}
	})
}

// The exact failure the controller fix exists for. hetzner/addons run 33059349873, once the
// Deployment name was corrected, reached the pod and was refused by RBAC:
//
//	{"level":"fatal","msg":"services is forbidden: User \"system:serviceaccount:argocd:argocd-server\"
//	  cannot list resource \"services\" …"}
//	command terminated with exit code 20
//
// Exit 20 is not exit 1, so this must land in the "could not ask" branch — never in the one that
// reports a diff, and never in the one that reports no difference. Getting that wrong would make an
// RBAC refusal read as "ArgoCD sees nothing wrong", which is the opposite conclusion.
func TestArgoDiffForbiddenIsNotNoDifference(t *testing.T) {
	forbidden := `{"level":"fatal","msg":"services is forbidden: User \"system:serviceaccount:argocd:argocd-server\" cannot list resource \"services\" in API group \"\" in the namespace \"argocd\""}
command terminated with exit code 20`
	got := interpretArgoDiff("addon-tempo", forbidden, errors.New("command terminated with exit code 20"))

	if !strings.Contains(got, "addon-tempo") {
		t.Errorf("the report must name the Application; got %q", got)
	}
	// The underlying reason has to survive — "forbidden" is what tells a reader it is RBAC and not
	// a broken chart, and those go to different fixes.
	if !strings.Contains(got, "forbidden") {
		t.Errorf("the RBAC reason must reach the report; got %q", got)
	}
	if same := interpretArgoDiff("addon-tempo", "", nil); got == same {
		t.Errorf("a refusal rendered identically to a genuine no-difference finding:\n%q", got)
	}
}

// The discriminator for "no difference, yet OutOfSync" — the verdict hetzner/addons run 33067969126
// returned for harbor, kyverno, loki and tempo at once, while naming their OutOfSync resources.
// Two causes with different fixes, and reporting the ambiguity without the evidence to resolve it is
// what #2591's `dns-not-resolving` did before it cost a paid run to get past.
func TestArgoSyncStaleness(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

	t.Run("older than the reconcile cadence reads as STALE", func(t *testing.T) {
		got := argoSyncStaleness("addon-loki", now.Add(-5*time.Minute).Format(time.RFC3339), now)
		if !strings.Contains(got, "STALE") {
			t.Errorf("a 5m-old reconcile must read as stale; got %q", got)
		}
		// It must also say what to DO — the point is to stop the next reader guessing.
		if !strings.Contains(got, "refresh") {
			t.Errorf("must name the next step; got %q", got)
		}
	})

	t.Run("inside the cadence reads as a genuine disagreement", func(t *testing.T) {
		got := argoSyncStaleness("addon-loki", now.Add(-20*time.Second).Format(time.RFC3339), now)
		if !strings.Contains(got, "FRESH") || !strings.Contains(got, "genuinely disagree") {
			t.Errorf("a 20s-old reconcile must read as a real disagreement; got %q", got)
		}
		if strings.Contains(got, "STALE") {
			t.Errorf("must not also claim staleness; got %q", got)
		}
	})

	t.Run("a missing timestamp says it cannot tell, rather than picking", func(t *testing.T) {
		// The failure this guards: defaulting to either verdict would send someone confidently to
		// the wrong fix, which is worse than admitting the read failed.
		for _, in := range []string{"", "   ", "not-a-timestamp"} {
			got := argoSyncStaleness("addon-loki", in, now)
			if !strings.Contains(got, "cannot say") {
				t.Errorf("input %q must render as cannot-say; got %q", in, got)
			}
			if strings.Contains(got, "STALE") || strings.Contains(got, "FRESH") {
				t.Errorf("input %q must not pick a verdict; got %q", in, got)
			}
		}
	})

	t.Run("the boundary is the reconcile cadence itself", func(t *testing.T) {
		if got := argoSyncStaleness("a", now.Add(-argoReconcileInterval).Format(time.RFC3339), now); !strings.Contains(got, "STALE") {
			t.Errorf("exactly at the cadence must read as stale; got %q", got)
		}
	})
}

// TestInterpretHardRefresh pins the three-way verdict. The middle case is the one that matters:
// failing to ASK the question must never render like either answer, because both answers send
// somebody to a different fix and "could not tell" sends them to neither.
func TestInterpretHardRefresh(t *testing.T) {
	synced := interpretHardRefresh("Synced", nil, "")
	if !strings.Contains(synced, "STALE MANIFEST CACHE") {
		t.Errorf("a Synced re-read means the cache was stale; got %q", synced)
	}

	stuck := interpretHardRefresh("OutOfSync", nil, "")
	if !strings.Contains(stuck, "SURVIVES") || !strings.Contains(stuck, "normalisation difference") {
		t.Errorf("a surviving OutOfSync is a real finding; got %q", stuck)
	}

	// Could-not-ask must look like NEITHER of the two above.
	cant := interpretHardRefresh("", errors.New("exec: no pod"), "boom")
	if !strings.Contains(cant, "COULD NOT ASK") {
		t.Errorf("a failed probe must say so; got %q", cant)
	}
	for _, leak := range []string{"STALE MANIFEST CACHE", "SURVIVES"} {
		if strings.Contains(cant, leak) {
			t.Errorf("could-not-ask leaked the %q verdict: %q", leak, cant)
		}
	}

	// An empty status is not a Synced status.
	empty := interpretHardRefresh("", nil, "")
	if !strings.Contains(empty, "EMPTY") || strings.Contains(empty, "STALE MANIFEST CACHE") {
		t.Errorf("an empty status must not read as Synced; got %q", empty)
	}

	// Long output is truncated rather than flooding a proof bundle.
	long := interpretHardRefresh("", errors.New("x"), strings.Repeat("y", 900))
	if len(long) > 700 {
		t.Errorf("detail must be truncated, got %d chars", len(long))
	}
}

// TestArgoReportAttributesANonHealthyAppToItsResource — an aggregate `health=Progressing` names
// nothing, and that cost #2717 two refuted hypotheses.
//
// On hetzner/addons run 33162842830 addon-harbor sat Progressing for fifty minutes with all seven
// of its pods Running and ready, so the health was NOT pod readiness and the run could not say what
// it WAS. ArgoCD carries the answer per resource; this assertion was fetching it and throwing it
// away. Naming it is what separates "OutOfSync AND independently unfinished" from "Progressing
// BECAUSE of the resource that is OutOfSync" — two states with different fixes.
func TestArgoReportAttributesANonHealthyAppToItsResource(t *testing.T) {
	raw := []byte(`{"items":[{"metadata":{"name":"addon-harbor"},"status":{
	  "health":{"status":"Progressing"},"sync":{"status":"OutOfSync"},
	  "resources":[
	    {"group":"apps","kind":"StatefulSet","name":"addon-harbor-database","status":"OutOfSync",
	     "health":{"status":"Progressing","message":"waiting for statefulset rolling update to complete"}},
	    {"group":"apps","kind":"Deployment","name":"addon-harbor-core","status":"Synced",
	     "health":{"status":"Healthy"}},
	    {"kind":"Service","name":"addon-harbor","status":"Synced"}
	  ]}}]}`)
	observed, err := parseArgoApps(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	st := observed["addon-harbor"]
	if len(st.NotHealthyResources) != 1 {
		t.Fatalf("exactly one resource is not Healthy, got %v", st.NotHealthyResources)
	}
	// A Service has NO health at all — ArgoCD has no health check for the kind. An empty health is
	// not an unhealthy resource, and counting it would bury the one that matters.
	for _, r := range st.NotHealthyResources {
		if strings.Contains(r, "Service/") {
			t.Errorf("a resource with no reported health must not be called unhealthy: %v", st.NotHealthyResources)
		}
	}
	_, err = evaluateArgoApps(observed, []string{"addon-harbor"})
	if err == nil {
		t.Fatal("Progressing must fail")
	}
	for _, want := range []string{
		"not Healthy:",
		"apps/StatefulSet/addon-harbor-database",
		"waiting for statefulset rolling update to complete",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the report must carry %q so the Progressing is attributable:\n%s", want, err)
		}
	}
}

// TestArgoReportSaysWhenAHealthIsNotAttributable — the empty branch is a FINDING.
//
// "ArgoCD named no unhealthy resource" and "we did not look" print the same absence otherwise, and
// this repo's dominant defect class is a diagnostic whose silence reads as a pass.
func TestArgoReportSaysWhenAHealthIsNotAttributable(t *testing.T) {
	raw := []byte(`{"items":[{"metadata":{"name":"addon-z"},"status":{
	  "health":{"status":"Progressing"},"sync":{"status":"Synced"},
	  "resources":[{"group":"apps","kind":"Deployment","name":"d","status":"Synced","health":{"status":"Healthy"}}]}}]}`)
	observed, err := parseArgoApps(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	_, err = evaluateArgoApps(observed, []string{"addon-z"})
	if err == nil {
		t.Fatal("Progressing must fail")
	}
	if !strings.Contains(err.Error(), "no unhealthy RESOURCE") {
		t.Errorf("an unattributable health must say so rather than print nothing:\n%s", err)
	}
	// And a HEALTHY app must not grow the line at all.
	healthy := []byte(`{"items":[{"metadata":{"name":"addon-z"},"status":{
	  "health":{"status":"Healthy"},"sync":{"status":"OutOfSync"},"resources":[]}}]}`)
	obs2, _ := parseArgoApps(healthy)
	_, err2 := evaluateArgoApps(obs2, []string{"addon-z"})
	if err2 == nil {
		t.Fatal("OutOfSync must fail")
	}
	if strings.Contains(err2.Error(), "not Healthy:") {
		t.Errorf("a Healthy app must not carry a not-Healthy line:\n%s", err2)
	}
}

// TestArgoReportNamesWithheldAppsResources — the full observed listing is the ONLY place a WITHHELD
// Application's OutOfSync resources can appear, and on run 33162842830 that mattered.
//
// addon-vault is withheld (a fresh Vault starts sealed), so it never enters the per-expected-app
// loop and reported `Progressing/OutOfSync` with no resource named. Its chart's
// volumeClaimTemplates entry is the CONTROL CASE that separates the two co-varying candidate causes
// of #2717's surviving four — it omits apiVersion/kind like harbor and tempo, but carries no
// null-valued key like loki and minio. Whether its StatefulSet is the OutOfSync resource decides
// which candidate survives, and printing it costs nothing: the data is already parsed.
func TestArgoReportNamesWithheldAppsResources(t *testing.T) {
	raw := []byte(`{"items":[
	  {"metadata":{"name":"addon-tempo"},"status":{
	     "health":{"status":"Healthy"},"sync":{"status":"OutOfSync"},
	     "resources":[{"group":"apps","kind":"StatefulSet","name":"addon-tempo","status":"OutOfSync"}]}},
	  {"metadata":{"name":"addon-vault"},"status":{
	     "health":{"status":"Progressing"},"sync":{"status":"OutOfSync"},
	     "resources":[{"group":"apps","kind":"StatefulSet","name":"addon-vault","status":"OutOfSync",
	                   "health":{"status":"Progressing","message":"Vault is sealed"}}]}}
	]}`)
	observed, err := parseArgoApps(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// addon-vault is NOT expected — that is what "withheld" means here.
	_, err = evaluateArgoApps(observed, []string{"addon-tempo"})
	if err == nil {
		t.Fatal("addon-tempo must fail")
	}
	for _, want := range []string{"addon-vault", "apps/StatefulSet/addon-vault", "Vault is sealed"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("a withheld app's detail must reach the report (%q):\n%s", want, err)
		}
	}
}

// ── #3281 · the convergence summary must survive whichever assertion a run takes. ──────────────
//
// THE DEFECT. There were two ArgoCD convergence loops: AssertArgoAppsHealthy, which registered the
// deferred summary write, and A0.6's AssertArgoReposConverge, which did not. A0.6 is enabled on
// EVERY real run (the nightly sets ALETHIA_E2E_ARGO_REPOS_REQUIRE whenever the apps-repo var is
// set, which is always), so every run took the uninstrumented copy and every proof bundle recorded
// `argocd_assert_outcome: unmeasured` on an assertion that had just counted 22 Applications. The
// add-on cells' evidence lived only in an expiring job log.
//
// Nothing caught it, because the only test of the write path called ONE of the two entry points —
// the axis that mattered was WHICH ASSERTION, and the tests varied the expected set instead. So
// both entry points are tabulated below, and the sibling test asserts there is exactly one loop
// for a third entry point to be unable to avoid.

// argoConvergenceEntryPoints is EVERY exported ArgoCD convergence assertion, each normalised to one
// signature. A new one must be added here; TestOnlyOneArgoConvergenceLoop is what makes that
// unavoidable rather than merely polite.
var argoConvergenceEntryPoints = []struct {
	name string
	call func(ctx context.Context, kubeconfig string, expected []string, timeout time.Duration) error
}{
	{"AssertArgoAppsHealthy", func(ctx context.Context, kc string, exp []string, to time.Duration) error {
		return AssertArgoAppsHealthy(ctx, kc, exp, to)
	}},
	{"AssertArgoReposConverge", func(ctx context.Context, kc string, exp []string, to time.Duration) error {
		return AssertArgoReposConverge(ctx, kc, exp, nil, to)
	}},
}

func TestEveryArgoConvergenceEntryPointWritesTheSummary(t *testing.T) {
	for _, tc := range argoConvergenceEntryPoints {
		t.Run(tc.name, func(t *testing.T) {
			// The VACUOUS exit is the only one reachable without a cluster, and it is also the
			// exit the writer is hardest to get right — the defer has to be registered BEFORE the
			// emptiness check. A run that asserted nothing must still leave evidence that it
			// asserted nothing.
			path := filepath.Join(t.TempDir(), "argocd-summary.json")
			t.Setenv(ArgoSummaryEnv, path)

			err := tc.call(context.Background(), "/nonexistent/kubeconfig", nil, time.Minute)
			if err == nil || !strings.Contains(err.Error(), "VACUOUS") {
				t.Fatalf("%s: want an immediate vacuity error, got: %v", tc.name, err)
			}
			raw, rerr := os.ReadFile(path)
			if rerr != nil {
				t.Fatalf("%s ran and left NO convergence summary at %s (%v).\n"+
					"This is #3281 exactly: the assertion happens, the bundle cannot say what it counted, "+
					"and the cell is left resting on an expiring job log.", tc.name, path, rerr)
			}
			var s ArgoConvergenceSummary
			if uerr := json.Unmarshal(raw, &s); uerr != nil {
				t.Fatalf("%s wrote an unparseable summary: %v\n%s", tc.name, uerr, raw)
			}
			if s.Outcome != "vacuous" {
				t.Fatalf("%s: want outcome 'vacuous', got %q (verdict: %s)", tc.name, s.Outcome, s.Verdict)
			}
			if s.HealthySynced != nil || s.ObservedTotal != nil {
				t.Fatalf("%s: a vacuous assertion measured nothing, so both counts must be null; got %v/%v",
					tc.name, s.HealthySynced, s.ObservedTotal)
			}
		})
	}
}

// TestEveryArgoConvergenceEntryPointIsSilentWithoutTheEnv is the other direction: no env, no file,
// and no crash. Without it the test above would pass against a writer that wrote unconditionally to
// a fixed path, which is a different defect wearing the same green tick.
func TestEveryArgoConvergenceEntryPointIsSilentWithoutTheEnv(t *testing.T) {
	for _, tc := range argoConvergenceEntryPoints {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv(ArgoSummaryEnv, "")
			if err := tc.call(context.Background(), "/nonexistent/kubeconfig", nil, time.Minute); err == nil {
				t.Fatalf("%s: want a vacuity error even with no summary path", tc.name)
			}
			ents, rerr := os.ReadDir(dir)
			if rerr != nil {
				t.Fatalf("read temp dir: %v", rerr)
			}
			if len(ents) != 0 {
				t.Fatalf("%s wrote %d file(s) with %s unset", tc.name, len(ents), ArgoSummaryEnv)
			}
		})
	}
}

// TestOnlyOneArgoConvergenceLoop is the structural half, and the one that generalises. The table
// above proves the two entry points that exist today are instrumented; this proves a THIRD cannot
// appear without arriving through the same seam.
//
// The invariant: `evaluateArgoApps` — the per-poll decision every convergence wait must make — is
// called from exactly one non-test function, `assertArgoConvergence`, which is where the deferred
// summary write lives. Any new poll loop has to call it, and would fail here.
//
// Read with go/parser rather than grepped, for the reason #3246 retired the regex scenario guard: a
// text match cannot tell a call from a mention in a comment, and the guard would go quietly green
// on a rename.
func TestOnlyOneArgoConvergenceLoop(t *testing.T) {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi fs.FileInfo) bool {
		// Non-test sources ONLY, and build tags deliberately ignored: a loop hidden behind
		// `//go:build e2e_t2` is exactly as capable of losing the counts as one in plain sight,
		// and `go vet` would not have read it either.
		return strings.HasSuffix(fi.Name(), ".go") && !strings.HasSuffix(fi.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatalf("parse test/e2e: %v", err)
	}
	if len(pkgs) == 0 {
		t.Fatal("parsed no packages — this guard would report green having read nothing")
	}

	callers := map[string]string{}
	files := 0
	for _, pkg := range pkgs {
		for name, f := range pkg.Files {
			files++
			for _, decl := range f.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || fn.Body == nil {
					continue
				}
				ast.Inspect(fn.Body, func(n ast.Node) bool {
					call, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "evaluateArgoApps" {
						callers[fn.Name.Name] = filepath.Base(name)
					}
					return true
				})
			}
		}
	}
	// A guard whose "nothing found" branch is indistinguishable from "nothing wrong" is not a
	// guard. If the decision function is never called, this test has read the wrong tree.
	if len(callers) == 0 {
		t.Fatalf("found NO caller of evaluateArgoApps across %d parsed file(s) — the guard read the wrong tree, or the function was renamed and this check silently stopped checking", files)
	}
	want := map[string]string{"assertArgoConvergence": "argocd_assert.go"}
	if !reflect.DeepEqual(callers, want) {
		t.Fatalf("there must be exactly ONE ArgoCD convergence loop, and it must be the one that writes the convergence summary.\n"+
			"  want: %v\n  got:  %v\n"+
			"A second loop is #3281: A0.6 had its own copy, every real run took it, and every proof bundle recorded `unmeasured` on an assertion that had counted. Delegate to assertArgoConvergence instead.",
			want, callers)
	}
}

// A VACUOUS WRITE MUST NOT CLOBBER A MEASUREMENT.
//
// azure/addons run 33277183092 converged 20 of 20 — `assertions.txt` records it — and shipped a
// bundle whose argocd-summary.json read `outcome: vacuous, expected_total: 0`. The file carries the
// RUN's evidence and every convergence call writes it, so last-writer-wins is the wrong rule the
// moment one of those writers asserted nothing: a cell that passed becomes one
// check-proof-integrity refuses to promote.
func TestVacuousSummaryDoesNotOverwriteAMeasuredOne(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "argocd-summary.json")

	measured := ArgoConvergenceSummary{Outcome: "converged", ExpectedTotal: 20, Assertion: "AssertArgoReposConverge"}
	if err := writeArgoSummary(path, measured); err != nil {
		t.Fatal(err)
	}
	if !measuredSummaryExists(path) {
		t.Fatal("a converged summary must count as measured")
	}

	// The other direction, which is the one that must still be written: with nothing there, a
	// vacuous assertion's own evidence is all there is, and losing it is how #3281 happened.
	empty := filepath.Join(dir, "empty.json")
	if measuredSummaryExists(empty) {
		t.Error("an absent file must not count as measured")
	}
	if err := os.WriteFile(empty, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if measuredSummaryExists(empty) {
		t.Error("an unreadable file must not count as measured — the first real writer wins the slot")
	}
	vac := filepath.Join(dir, "vac.json")
	if err := writeArgoSummary(vac, ArgoConvergenceSummary{Outcome: "vacuous"}); err != nil {
		t.Fatal(err)
	}
	if measuredSummaryExists(vac) {
		t.Error("a vacuous summary is not a measurement, so it must not block a later real one")
	}
	// unreadable and unconverged ARE measurements: they say something about a set that was really
	// asserted over, and a vacuous write must not replace either.
	for _, o := range []string{"unconverged", "unreadable"} {
		p := filepath.Join(dir, o+".json")
		if err := writeArgoSummary(p, ArgoConvergenceSummary{Outcome: o, ExpectedTotal: 20}); err != nil {
			t.Fatal(err)
		}
		if !measuredSummaryExists(p) {
			t.Errorf("%q is a measurement over a real set and must be protected", o)
		}
	}
}

// The summary must name WHICH wait wrote it. Two convergence waits share one file, and a bundle
// carrying the wrong one gave no way to tell them apart.
func TestConvergenceSummaryNamesItsAssertion(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "argocd-summary.json")
	t.Setenv(ArgoSummaryEnv, path)

	// A vacuous call is the cheapest one to drive — it returns before touching a cluster.
	_ = AssertArgoAppsHealthy(context.Background(), "/nonexistent/kubeconfig", nil, time.Minute)

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no summary written: %v", err)
	}
	var s ArgoConvergenceSummary
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	if s.Assertion != "AssertArgoAppsHealthy" {
		t.Errorf("assertion = %q, want the wait's own name", s.Assertion)
	}
}

// THE BEHAVIOUR, not just the predicate. The previous test exercises `measuredSummaryExists` and
// would pass with the guard in `assertArgoConvergence` deleted — mutation-checked, and it did.
// This one drives the real call: a measured summary on disk, then a VACUOUS assertion over the same
// path, and the measurement must survive.
func TestAVacuousAssertionLeavesAMeasuredSummaryAlone(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "argocd-summary.json")
	hs, ot := 20, 20
	measured := ArgoConvergenceSummary{
		Outcome: "converged", ExpectedTotal: 20, HealthySynced: &hs, ObservedTotal: &ot,
		Assertion: "AssertArgoReposConverge", Verdict: "20 of 20 expected Applications Healthy+Synced",
	}
	if err := writeArgoSummary(path, measured); err != nil {
		t.Fatal(err)
	}
	t.Setenv(ArgoSummaryEnv, path)

	if err := AssertArgoAppsHealthy(context.Background(), "/nonexistent/kubeconfig", nil, time.Minute); err == nil {
		t.Fatal("a vacuous assertion must still FAIL — the refusal is the point")
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got ArgoConvergenceSummary
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Outcome != "converged" || got.ExpectedTotal != 20 {
		t.Fatalf("the measurement was overwritten by a call that asserted nothing: %+v", got)
	}
	if got.Assertion != "AssertArgoReposConverge" {
		t.Errorf("assertion = %q — the surviving summary must still name the wait that measured it", got.Assertion)
	}
}

// And with NOTHING there, the vacuous summary is written: "this run asserted nothing" is itself
// evidence, and losing it is the defect #3281 was filed for.
func TestAVacuousAssertionStillWritesWhenNothingIsThere(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "argocd-summary.json")
	t.Setenv(ArgoSummaryEnv, path)

	_ = AssertArgoAppsHealthy(context.Background(), "/nonexistent/kubeconfig", nil, time.Minute)

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the vacuity evidence was not written: %v", err)
	}
	var got ArgoConvergenceSummary
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Outcome != "vacuous" {
		t.Errorf("outcome = %q, want vacuous", got.Outcome)
	}
}

// syncedUnhealthyLosers picks the losers NO other dump section speaks for. Getting this narrowing
// wrong is invisible at runtime in both directions — too wide and it duplicates the diff path, too
// narrow and #3580's only loser falls out of the one section written for it.
func TestSyncedUnhealthyLosers(t *testing.T) {
	observed := map[string]argoAppState{
		// The #3580 shape, verbatim from the gcp floor leg of run 33487970328.
		"external-secrets-operator": {Health: "Progressing", Sync: "Synced"},
		// Synced and Degraded — same section: ArgoCD refreshes health on a compare either way.
		"addon-falco": {Health: "Degraded", Sync: "Synced"},
		// OutOfSync — the diff section owns this one, whatever its health.
		"addon-loki": {Health: "Degraded", Sync: "OutOfSync"},
		// Sync UNKNOWN. parseArgoApps normalises an empty status.sync.status to "Unknown", which is
		// what an Application whose compares have ALL aborted reports — the same #3580 failure one
		// reconcile EARLIER. `== "Synced"` excluded it, and dumpArgoAppDiffs declines it too, so it
		// produced BOTH silences at once. It belongs here.
		"addon-tempo": {Health: "Progressing", Sync: "Unknown"},
		// Healthy losers are not losers; if one arrives, it is not this section's business.
		"addon-reloader": {Health: "Healthy", Sync: "Synced"},
	}
	losers := []string{"addon-loki", "external-secrets-operator", "addon-falco", "addon-reloader", "addon-tempo"}

	got := syncedUnhealthyLosers(observed, losers)
	want := []string{"addon-falco", "addon-tempo", "external-secrets-operator"}
	if len(got) != len(want) {
		t.Fatalf("syncedUnhealthyLosers = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("syncedUnhealthyLosers = %v, want %v (sorted)", got, want)
		}
	}

	t.Run("a loser absent from the observed map is not invented", func(t *testing.T) {
		// It has no sync status at all, so claiming it is Synced-but-unhealthy would be a
		// diagnostic asserting something it never read.
		if got := syncedUnhealthyLosers(observed, []string{"never-observed"}); len(got) != 0 {
			t.Errorf("an unobserved loser must not be selected; got %v", got)
		}
	})
}

// argoHealthStaleness reports how old a health verdict is. It must NEVER issue an all-clear, and
// that is not a style choice — see the function's own comment: the first version's "the health is
// CURRENT" arm fired on the exact run it was written for, vouching for a health that was wrong.
func TestArgoHealthStaleness(t *testing.T) {
	now := time.Date(2026, 9, 1, 9, 14, 5, 0, time.UTC)

	// Every arm that read a timestamp must point at where the question is actually settled, because
	// the age alone never settles it.
	assertNamesTheControllerLog := func(t *testing.T, got string) {
		t.Helper()
		if !strings.Contains(got, "controller log") {
			t.Errorf("must name where the question is settled; got %q", got)
		}
		if !strings.Contains(got, "SUCCEEDS") {
			t.Errorf("must say that an aborted compare does not advance reconciledAt; got %q", got)
		}
	}

	t.Run("a full missed reconcile window states the stronger finding", func(t *testing.T) {
		got := argoHealthStaleness("external-secrets-operator", "Progressing",
			now.Add(-4*time.Minute).Format(time.RFC3339), now)
		if !strings.Contains(got, "may predate") {
			t.Errorf("a 4m-old health must be reported as possibly predating the cluster; got %q", got)
		}
		if !strings.Contains(got, "Progressing") {
			t.Errorf("must name the health it judged; got %q", got)
		}
		assertNamesTheControllerLog(t, got)
	})

	t.Run("an age inside the cadence is NOT reported as current", func(t *testing.T) {
		got := argoHealthStaleness("addon-falco", "Degraded",
			now.Add(-30*time.Second).Format(time.RFC3339), now)
		// The regression this pins: any wording that lets a reader conclude the health is fine.
		for _, banned := range []string{"CURRENT", "is current", "real convergence failure", "not a stale read"} {
			if strings.Contains(got, banned) {
				t.Errorf("a young age must not read as an all-clear (%q); got %q", banned, got)
			}
		}
		if !strings.Contains(got, "does NOT make it current") {
			t.Errorf("must say explicitly what the age fails to prove; got %q", got)
		}
		assertNamesTheControllerLog(t, got)
	})

	t.Run("a missing or unreadable timestamp says it cannot tell", func(t *testing.T) {
		for _, in := range []string{"", "   ", "not-a-timestamp"} {
			got := argoHealthStaleness("a", "Progressing", in, now)
			if !strings.Contains(got, "cannot say") {
				t.Errorf("input %q must render as cannot-say; got %q", in, got)
			}
			// It read no timestamp, so it must not report an age of any kind.
			if strings.Contains(got, "ago") {
				t.Errorf("input %q must not state an age it never measured; got %q", in, got)
			}
		}
	})

	t.Run("the boundary is the reconcile cadence itself", func(t *testing.T) {
		got := argoHealthStaleness("a", "Progressing",
			now.Add(-argoReconcileInterval).Format(time.RFC3339), now)
		if !strings.Contains(got, "may predate") {
			t.Errorf("exactly at the cadence must state the stronger finding; got %q", got)
		}
	})

	t.Run("an unread health renders as Unknown, never as the empty word", func(t *testing.T) {
		// "health= was last recomputed" is the sentence this prevents.
		got := argoHealthStaleness("a", "", now.Add(-time.Minute).Format(time.RFC3339), now)
		if !strings.Contains(got, "health=Unknown") {
			t.Errorf("an empty health must render as Unknown; got %q", got)
		}
	})
}

// The measured case #3580 turned on, pinned against the run's OWN timestamps rather than round
// numbers. It is the arm that looks innocuous — 1m58s is INSIDE ArgoCD's cadence by two seconds —
// and it is the one that must not reassure anybody, because the health it describes was already
// wrong: every external-secrets pod had been Running and ready since 09:11:36Z.
func TestArgoHealthStalenessOnTheRunThatFailed(t *testing.T) {
	lastCompare := time.Date(2026, 9, 1, 9, 12, 7, 0, time.UTC) // last SUCCESSFUL compare
	readAt := time.Date(2026, 9, 1, 9, 14, 5, 0, time.UTC)      // when the assertion gave up

	got := argoHealthStaleness("external-secrets-operator", "Progressing",
		lastCompare.Format(time.RFC3339), readAt)
	if !strings.Contains(got, "1m58s") {
		t.Errorf("must state the measured age so the reader can check it; got %q", got)
	}
	if !strings.Contains(got, "does NOT make it current") {
		t.Errorf("the run's own health was stale despite a young age — this must not read as an all-clear; got %q", got)
	}
	if !strings.Contains(got, "Running-and-ready") {
		t.Errorf("must name the evidence that actually settled it on this run; got %q", got)
	}
}

// A read that did not happen must not be reported as a field the Application does not have.
//
// `readArgoReconciledAt` returns "" for a non-zero kubectl exit, an apiserver refusal AND this
// section's share of the pooled dump budget expiring — and the last is the common one. Rendering
// any of them as "there is no status.reconciledAt" states something about the cluster that was
// never read: on a slow cluster six Applications in a row would be reported as never reconciled,
// which is a much bigger and entirely fictional finding than the one being investigated.
func TestReadArgoReconciledAtSeparatesAFailedReadFromAnEmptyField(t *testing.T) {
	t.Run("a cancelled context is reported as the dump's budget, not as the Application", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		ts, reason := readArgoReconciledAtOrFail(ctx, "/nonexistent/kubeconfig", "external-secrets-operator")
		if ts != "" {
			t.Errorf("a cancelled read must yield no timestamp, got %q", ts)
		}
		if reason == "" {
			t.Fatal("a failed read must carry a REASON — an empty one is what makes it look like an absent field")
		}
		if !strings.Contains(reason, "budget") {
			t.Errorf("a cancelled context must be attributed to the dump's budget, got %q", reason)
		}
	})

	t.Run("the collapsing wrapper still returns just the value", func(t *testing.T) {
		// readArgoReconciledAt keeps its old shape for the SYNC path, where "" renders as
		// "cannot say" — a hedge, not a claim — so that caller is unaffected.
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		if got := readArgoReconciledAt(ctx, "/nonexistent/kubeconfig", "a"); got != "" {
			t.Errorf("readArgoReconciledAt = %q, want the empty string it has always returned", got)
		}
	})
}

// …and the CALLER must actually use that separation. The helper returning a reason is worth
// nothing if dumpArgoHealthStaleness still renders it as an absent field, and a test of the helper
// alone cannot see that: mutating the caller's `if readErr != ""` to `if false` left the helper's
// own test green.
func TestDumpArgoHealthStalenessNeverBlamesTheApplicationForAFailedRead(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	observed := map[string]argoAppState{
		"external-secrets-operator": {Health: "Progressing", Sync: "Synced"},
	}
	got := dumpArgoHealthStaleness(ctx, "/nonexistent/kubeconfig", observed, []string{"external-secrets-operator"})

	if !strings.Contains(got, "could NOT BE READ") {
		t.Errorf("a read that did not happen must say so; got:\n%s", got)
	}
	// The claim this must never make: it did not read the field, so it cannot say the field is absent.
	if strings.Contains(got, "there is no status.reconciledAt") {
		t.Errorf("a failed read must not be reported as an absent field; got:\n%s", got)
	}
	// …and it must not state an age it never measured.
	if strings.Contains(got, " ago") {
		t.Errorf("no age may be printed for a read that failed; got:\n%s", got)
	}
	if !strings.Contains(got, "external-secrets-operator") {
		t.Errorf("the app must still be named; got:\n%s", got)
	}
}
