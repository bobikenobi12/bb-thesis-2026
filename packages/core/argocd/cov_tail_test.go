// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

// tailBrokenTempDir points TMPDIR at a path that cannot hold a directory, so every
// os.MkdirTemp / os.CreateTemp failure arm is reachable without touching the real temp dir.
func tailBrokenTempDir(t *testing.T) {
	t.Helper()
	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", filepath.Join(blocker, "tmp"))
}

// tailLabels is a non-empty common-label set, which is what makes InjectCommonLabels actually
// parse a manifest (an empty map short-circuits).
var tailLabels = map[string]string{"alethia.io/project": "p1"}

// ── labels.go ────────────────────────────────────────────────────────────────────

// TestTail_InjectCommonLabelsSkipsEmptyDocuments covers the empty-document arm: a stream carrying
// a content-less document must be re-emitted without a bare "null", which would corrupt it.
func TestTail_InjectCommonLabelsSkipsEmptyDocuments(t *testing.T) {
	// A leading "---" with only a comment under it decodes to a document with no content.
	app := "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: a\n"
	for _, in := range []string{
		app + "---\n",
		"---\n" + app,
		"---\n---\n" + app,
		"# leading comment only\n---\n" + app,
		app + "---\n# trailing comment only\n",
	} {
		got, err := InjectCommonLabels(in, tailLabels)
		if err != nil {
			t.Fatalf("InjectCommonLabels(%q): %v", in, err)
		}
		if strings.Contains(got, "null") {
			t.Fatalf("an empty document was re-encoded as null (input %q):\n%s", in, got)
		}
		if !strings.Contains(got, "alethia.io/project: p1") {
			t.Fatalf("the Application document was not labelled (input %q):\n%s", in, got)
		}
	}
}

// TestTail_InjectCommonLabelsLeavesKindlessDocuments covers scalarValue's absent-key arm: a
// document with no `kind` at all is not an Application, so it must pass through untouched.
func TestTail_InjectCommonLabelsLeavesKindlessDocuments(t *testing.T) {
	got, err := InjectCommonLabels("just: a-mapping\n", tailLabels)
	if err != nil {
		t.Fatalf("InjectCommonLabels: %v", err)
	}
	if strings.Contains(got, "alethia.io/project") {
		t.Fatalf("a kind-less document was labelled:\n%s", got)
	}
}

// TestTail_AddLabelsIgnoresNonMappingDocuments covers addLabels' fail-safe arm: handed a document
// that is not a mapping it must return without touching it, never panic.
func TestTail_AddLabelsIgnoresNonMappingDocuments(t *testing.T) {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte("- a\n- b\n"), &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	addLabels(&doc, tailLabels) // a sequence document — must be a no-op
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.SequenceNode {
		t.Fatal("addLabels mutated a non-mapping document")
	}
}

// TestTail_InjectCommonLabelsRejectsUnparseableManifest covers the decode-error arm.
func TestTail_InjectCommonLabelsRejectsUnparseableManifest(t *testing.T) {
	if _, err := InjectCommonLabels("kind: [unterminated\n", tailLabels); err == nil {
		t.Fatal("InjectCommonLabels accepted a manifest yaml cannot decode")
	}
}

// ── render.go ────────────────────────────────────────────────────────────────────

// TestTail_RenderApplicationsFailureArms covers the three reachable refusals: an unusable temp
// dir, a `.yaml` entry that cannot be read (a dangling symlink), and a template whose OUTPUT is
// not valid YAML so the label injection fails.
func TestTail_RenderApplicationsFailureArms(t *testing.T) {
	facts := &InfraFacts{Provider: "aws", Labels: tailLabels}

	t.Run("unusable temp dir", func(t *testing.T) {
		tailBrokenTempDir(t)
		if _, err := RenderApplications(t.TempDir(), facts); err == nil ||
			!strings.Contains(err.Error(), "failed to create temp dir") {
			t.Fatalf("RenderApplications error = %v, want the temp-dir failure", err)
		}
	})

	t.Run("unreadable template", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.Symlink(filepath.Join(dir, "nowhere"), filepath.Join(dir, "broken.yaml")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		if _, err := RenderApplications(dir, facts); err == nil ||
			!strings.Contains(err.Error(), "failed to read") {
			t.Fatalf("RenderApplications error = %v, want the read failure", err)
		}
	})

	t.Run("rendered output is not yaml", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "bad.yaml"), []byte("kind: [unterminated\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := RenderApplications(dir, facts); err == nil ||
			!strings.Contains(err.Error(), "failed to label") {
			t.Fatalf("RenderApplications error = %v, want the label failure", err)
		}
	})
}

// TestTail_RenderApplicationsRejectsMissingTemplatesDir covers the ReadDir arm.
func TestTail_RenderApplicationsRejectsMissingTemplatesDir(t *testing.T) {
	_, err := RenderApplications(filepath.Join(t.TempDir(), "absent"), &InfraFacts{})
	if err == nil || !strings.Contains(err.Error(), "failed to read templates dir") {
		t.Fatalf("RenderApplications error = %v, want the templates-dir failure", err)
	}
}

// ── addons.go ────────────────────────────────────────────────────────────────────

// TestTail_RenderManagedAddOnsFailureArms covers RenderManagedAddOns' reachable refusals: an
// unusable temp dir, and an id that escapes the output directory.
//
// TWO ARMS BECAME UNREACHABLE WITH #2589, and are recorded here rather than quietly dropped.
//
// `failed to label add-on` used to be reached by giving a STRING FIELD a value that broke the
// rendered YAML — the subtest below did it with `Namespace = "a: b: c"`. That was the injection
// hole being exercised as though it were a feature. The Application is now MARSHALLED, so no field
// value can produce a document the label injector cannot re-parse, and that subtest is inverted:
// the same input must round-trip. This is a case where losing coverage of a branch is the POINT —
// the branch is still there as a backstop, and nothing in the data can reach it any more.
//
// `failed to render add-on` is unreachable for the reason this file already recorded: yaml.v3's
// Encoder.Encode PANICS on a value it cannot marshal rather than returning an error, so
// `marshalValues`' documented error return can never fire. Unreachable rather than untested — and
// deliberately NOT exercised with an unmarshallable value, which would panic the suite rather than
// fail it.
func TestTail_RenderManagedAddOnsFailureArms(t *testing.T) {
	base := types.AddOnInstall{ID: "demo", Mode: "managed", Chart: "c", ChartRepo: "https://charts.example.com", Namespace: "ns"}

	t.Run("unusable temp dir", func(t *testing.T) {
		tailBrokenTempDir(t)
		if _, err := RenderManagedAddOns([]types.AddOnInstall{base}, nil); err == nil ||
			!strings.Contains(err.Error(), "failed to create temp dir") {
			t.Fatalf("RenderManagedAddOns error = %v, want the temp-dir failure", err)
		}
	})

	// THIS SUBTEST USED TO ASSERT THE BUG (#2589). It set `Namespace = "a: b: c"` with the note
	// "a namespace carrying a bare colon renders `namespace: a: b`, which yaml refuses" — which is
	// the YAML-injection hole, described as though it were the behaviour under test. Since the
	// Application is MARSHALLED rather than templated, no value can break the document, so it is
	// inverted here: the same input must now render VALID yaml and survive the round trip.
	t.Run("a namespace that used to break the document now round-trips", func(t *testing.T) {
		a := base
		a.Namespace = "a: b: c"
		dir, err := RenderManagedAddOns([]types.AddOnInstall{a}, tailLabels)
		if err != nil {
			t.Fatalf("a value can no longer produce an unparseable manifest: %v", err)
		}
		raw, err := os.ReadFile(filepath.Join(dir, AddOnAppName(a.ID)+".yaml"))
		if err != nil {
			t.Fatalf("read rendered manifest: %v", err)
		}
		var back struct {
			Spec struct {
				Destination struct {
					Namespace string `yaml:"namespace"`
				} `yaml:"destination"`
			} `yaml:"spec"`
		}
		if err := yaml.Unmarshal(raw, &back); err != nil {
			t.Fatalf("rendered manifest does not parse: %v\n%s", err, raw)
		}
		if back.Spec.Destination.Namespace != a.Namespace {
			t.Errorf("namespace round-tripped to %q, want %q", back.Spec.Destination.Namespace, a.Namespace)
		}
	})

	t.Run("id that escapes the output dir", func(t *testing.T) {
		a := base
		a.ID = "nested/demo" // → outDir/addon-nested/demo.yaml, whose parent does not exist
		if _, err := RenderManagedAddOns([]types.AddOnInstall{a}, nil); err == nil ||
			!strings.Contains(err.Error(), "failed to write add-on") {
			t.Fatalf("RenderManagedAddOns error = %v, want the write failure", err)
		}
	})
}

// ── byo.go / applicationset_preview.go / preview_guardrails.go ───────────────────

// TestTail_RenderByoAppProjectQuotesAMetacharacterName replaces a test that asserted the opposite,
// and the swap is the point of #2540.
//
// It used to pass the project name `a: b: c` and require an ERROR — because `metadata.name` was
// interpolated UNQUOTED by a text/template, so a name carrying YAML metacharacters produced a
// manifest that would not parse, and the failure surfaced two steps later as "label byo AppProject".
// That arm only existed because the renderer could emit broken YAML at all, and it only fired when
// commonLabels was non-empty: with nil labels InjectCommonLabels returns the manifest untouched, so
// the same name shipped a CORRUPT AppProject silently.
//
// Marshalling removes the failure instead of reporting it. The name is quoted by the encoder, the
// document parses, and there is nothing left to catch downstream.
func TestTail_RenderByoAppProjectQuotesAMetacharacterName(t *testing.T) {
	out, err := RenderByoAppProject("a: b: c", []string{"https://git.example.com/x"}, []string{"ns"}, tailLabels)
	if err != nil {
		t.Fatalf("a quoted name must render, got error %v", err)
	}
	var doc struct {
		Metadata struct {
			Name string `yaml:"name"`
		} `yaml:"metadata"`
	}
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("the rendered AppProject must parse, got %v:\n%s", err, out)
	}
	if doc.Metadata.Name != "a: b: c" {
		t.Errorf("metadata.name = %q, want it carried verbatim inside a quoted scalar:\n%s", doc.Metadata.Name, out)
	}
}

// TestTail_PreviewValidatorsRequireAGitProvider covers the git-provider arm of BOTH preview
// validators — the ApplicationSet and the guardrails must refuse the same missing field, or one
// half of the pair renders for a config the other rejects.
func TestTail_PreviewValidatorsRequireAGitProvider(t *testing.T) {
	appset := PreviewAppSetInput{
		Project: "p", RepoOwner: "o", RepoName: "r", AppsRepoURL: "https://git.example.com/a.git",
		PlacementMode: types.PlacementModeNamespace,
	}
	if _, err := RenderPreviewApplicationSet(appset); err == nil ||
		!strings.Contains(err.Error(), "git provider is required") {
		t.Fatalf("RenderPreviewApplicationSet error = %v, want the git-provider refusal", err)
	}

	guard := PreviewGuardrailsInput{
		Project: "p", RepoOwner: "o", RepoName: "r",
		GuardrailsRepoURL: "https://git.example.com/g.git", GuardrailsPath: "guardrails",
		PlacementMode: types.PlacementModeNamespace,
	}
	if _, err := RenderPreviewGuardrails(guard); err == nil ||
		!strings.Contains(err.Error(), "git provider is required") {
		t.Fatalf("RenderPreviewGuardrails error = %v, want the git-provider refusal", err)
	}
}

// TestTail_PreviewGuardrailsDefaultsTheNamespacePrefix covers templateData's default arm: a blank
// prefix must become "preview" rather than render namespaces starting with "-".
func TestTail_PreviewGuardrailsDefaultsTheNamespacePrefix(t *testing.T) {
	in := PreviewGuardrailsInput{
		Project: "p", GitProvider: "github", RepoOwner: "o", RepoName: "r",
		GuardrailsRepoURL: "https://git.example.com/g.git", GuardrailsPath: "guardrails",
		PlacementMode: types.PlacementModeNamespace,
	}
	got := in.templateData()
	if got.NamespacePrefix != "preview" {
		t.Fatalf("NamespacePrefix = %q, want the \"preview\" default", got.NamespacePrefix)
	}
}

// ── install.go ───────────────────────────────────────────────────────────────────

// TestTail_CleanupSkippedInfraServicesWarnsOnEveryDeleteFailure covers the three warning arms:
// the stale external-dns Application, the stale cert-manager ClusterIssuer, and the stale
// per-cloud ClusterSecretStores. A delete that fails is best-effort — it must warn, never abort.
func TestTail_CleanupSkippedInfraServicesWarnsOnEveryDeleteFailure(t *testing.T) {
	stub := newKubectlStub(t, 1) // every kubectl invocation fails
	var stdout, stderr bytes.Buffer

	CleanupSkippedInfraServices(&InfraFacts{Provider: "hetzner"}, &stdout, &stderr)

	for _, want := range []string{
		"could not remove stale external-dns application",
		"could not remove stale cert-manager ClusterIssuer",
		"could not remove stale ClusterSecretStore",
	} {
		if !strings.Contains(stderr.String(), want) {
			t.Fatalf("stderr missing %q:\n%s", want, stderr.String())
		}
	}
	if !stub.calledWith("delete application external-dns") {
		t.Fatalf("external-dns delete was never issued: %v", stub.calls())
	}
}

// TestTail_ApplyManifestReportsTempFileFailure covers ApplyManifest's CreateTemp arm.
func TestTail_ApplyManifestReportsTempFileFailure(t *testing.T) {
	tailBrokenTempDir(t)
	var stdout, stderr bytes.Buffer
	if err := ApplyManifest("kind: Foo\n", &stdout, &stderr); err == nil ||
		!strings.Contains(err.Error(), "failed to create temp file") {
		t.Fatalf("ApplyManifest error = %v, want the temp-file failure", err)
	}
}

// TestTail_ConfigureRepoCredentialsReportsTempFileFailure covers the same arm on the repo-Secret
// path — the credential must never be written anywhere but the temp file it fails to create.
func TestTail_ConfigureRepoCredentialsReportsTempFileFailure(t *testing.T) {
	tailBrokenTempDir(t)
	var stdout, stderr bytes.Buffer
	err := ConfigureRepoCredentials("https://git.example.com/a.git", "tok", &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "failed to create temp file") {
		t.Fatalf("ConfigureRepoCredentials error = %v, want the temp-file failure", err)
	}
	if strings.Contains(stderr.String(), "tok") {
		t.Fatal("the token leaked into stderr on the failure path")
	}
}

// TestTail_EnsureExternalSecretsStoreDumpsPodsOnTimeout covers the deadline arm: when the operator
// never becomes ready inside the window, the controller's pods are dumped (so a recurrence is
// diagnosable from logs alone) and the apply error is returned. The wait is set to zero so the
// timeout is reached on the first attempt — no sleeping.
func TestTail_EnsureExternalSecretsStoreDumpsPodsOnTimeout(t *testing.T) {
	orig := externalSecretsStoreMaxWait
	externalSecretsStoreMaxWait = 0
	t.Cleanup(func() { externalSecretsStoreMaxWait = orig })

	// The apply fails with the transient "the CRD isn't registered yet" marker, which is what
	// makes the retry loop (and therefore the deadline check) run at all.
	stub := newKubectlStub(t, 1, stubRule{
		Match:  "apply --server-side",
		Stdout: `error: unable to recognize "manifest.yaml": no matches for kind "ClusterSecretStore"`,
		Exit:   1,
	})
	facts := &InfraFacts{Provider: "aws", IRSAExternalSecretsArn: "arn:aws:iam::123:role/eso", Region: "us-east-1"}
	var stdout, stderr bytes.Buffer

	err := EnsureExternalSecretsStore(facts, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "apply ClusterSecretStore") {
		t.Fatalf("EnsureExternalSecretsStore error = %v, want the apply failure", err)
	}
	if !stub.calledWith("get pods -n external-secrets-operator") {
		t.Fatalf("the operator's pods were not dumped on timeout: %v", stub.calls())
	}
}

// TestTail_EnsureCertManagerIssuerDumpsPodsOnTimeout is the cert-manager half of the same
// contract: a slow webhook must produce a diagnosable log and a NON-fatal error, not a silent
// hang. Again the wait is zeroed rather than slept through.
func TestTail_EnsureCertManagerIssuerDumpsPodsOnTimeout(t *testing.T) {
	orig := certManagerIssuerMaxWait
	certManagerIssuerMaxWait = 0
	t.Cleanup(func() { certManagerIssuerMaxWait = orig })

	stub := newKubectlStub(t, 1, stubRule{
		Match:  "apply --server-side",
		Stdout: `Error from server (InternalError): failed calling webhook "webhook.cert-manager.io": no endpoints available`,
		Exit:   1,
	})
	facts := &InfraFacts{
		Provider: "aws", DNSEnabled: true, DomainName: "example.com",
		ManagedCertificate: true, IRSAExternalDNSArn: "arn:aws:iam::123:role/dns",
		Region: "us-east-1",
	}
	if !facts.CertManagerEnabled() {
		t.Fatal("fixture does not enable cert-manager — the issuer would be a no-op")
	}
	var stdout, stderr bytes.Buffer

	err := EnsureCertManagerIssuer(facts, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "apply cert-manager ClusterIssuer") {
		t.Fatalf("EnsureCertManagerIssuer error = %v, want the apply failure", err)
	}
	if !stub.calledWith("get pods -n cert-manager") {
		t.Fatalf("cert-manager's pods were not dumped on timeout: %v", stub.calls())
	}
}

// ── manifest_addons.go ───────────────────────────────────────────────────────────

// TestTail_ApplyManifestServerSideReportsTempDirFailure covers the MkdirTemp arm.
func TestTail_ApplyManifestServerSideReportsTempDirFailure(t *testing.T) {
	tailBrokenTempDir(t)
	var stdout, stderr bytes.Buffer
	if err := applyManifestServerSide("kind: Foo\n", &stdout, &stderr); err == nil {
		t.Fatal("applyManifestServerSide accepted an unusable temp dir")
	}
}

// TestTail_FetchManifestReportsBodyReadFailure covers fetchManifest's io.ReadAll arm: a response
// that declares more bytes than it delivers must surface as a read failure, never a truncated
// manifest applied as if it were whole.
func TestTail_FetchManifestReportsBodyReadFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", "4096")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("apiVersion: v1\n"))
		// Flush so the client HAS a response to read, then cut the connection mid-body — that is
		// what makes the failure land on the body read rather than on the request itself.
		w.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	}))
	t.Cleanup(srv.Close)

	if _, err := fetchManifest(context.Background(), srv.URL); err == nil {
		t.Fatal("fetchManifest accepted a truncated response body")
	}
}

// TestTail_WaitForCRDEstablishedSurfacesFailure covers waitForCRDEstablished's error wrap and
// ApplyManifestAddOns' CRD arm: a CRD that never establishes marks the add-on failed (fail-soft,
// reported to stderr) rather than letting a dependent CR race a schema that does not exist.
func TestTail_WaitForCRDEstablishedSurfacesFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("apiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo\n"))
	}))
	t.Cleanup(srv.Close)

	// The apply succeeds; only the CRD wait fails.
	newKubectlStub(t, 0, stubRule{Match: "wait --for=condition=established", Stdout: "timed out", Exit: 1})

	addons := []types.AddOnInstall{{
		ID: "op", Mode: "managed", Source: "manifest", ChartRepo: srv.URL, Version: "v1",
		CRDs: []string{"widgets.example.com"},
	}}
	var stdout, stderr bytes.Buffer
	err := ApplyManifestAddOns(context.Background(), addons, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "failed to install") {
		t.Fatalf("ApplyManifestAddOns error = %v, want the all-failed report", err)
	}
	if !strings.Contains(stderr.String(), "never became Established") {
		t.Fatalf("stderr missing the CRD failure:\n%s", stderr.String())
	}
}

// ── waves.go ─────────────────────────────────────────────────────────────────────

// TestTail_ApplyAddOnsInWavesWarnsOnCRDWaitFailure covers the per-wave CRD wait: a CRD that never
// establishes is a warning, not a wave failure — the deploy continues and reports honestly.
func TestTail_ApplyAddOnsInWavesWarnsOnCRDWaitFailure(t *testing.T) {
	newKubectlStub(t, 0, stubRule{Match: "wait --for=condition=established", Stdout: "timed out", Exit: 1})

	addons := []types.AddOnInstall{{
		ID: "cnpg", Mode: "managed", Chart: "cloudnative-pg", ChartRepo: "https://charts.example.com",
		Namespace: "cnpg", CRDs: []string{"clusters.postgresql.cnpg.io"},
	}}
	var stdout, stderr bytes.Buffer
	_ = ApplyAddOnsInWaves(addons, t.TempDir(), &stdout, &stderr)
	if !strings.Contains(stderr.String(), "never became Established") {
		t.Fatalf("stderr missing the CRD warning:\n%s", stderr.String())
	}
}

// ── the kubectl prune paths ──────────────────────────────────────────────────────

// tailListJSON is a kubectl `-o json` list body carrying one item at ns/name.
func tailListJSON(namespace, name string) string {
	return fmt.Sprintf(`{"items":[{"metadata":{"name":%q,"namespace":%q}}]}`, name, namespace)
}

// TestTail_PruneWarnsWhenADeleteFails covers the delete-failure warning arm of every prune path
// that shares this shape: the registry pull secret, the Helm repo credential, the BYO binding
// ExternalSecret, and the vcluster cluster Secret. A best-effort prune must warn, not abort.
func TestTail_PruneWarnsWhenADeleteFails(t *testing.T) {
	list := tailListJSON("argocd", "stale-one")
	// Every `get … -o json` answers with the list; every `delete` fails.
	newKubectlStub(t, 1, stubRule{Match: "-o json", Stdout: list, Exit: 0})

	var stdout, stderr bytes.Buffer
	PruneRegistryPullSecrets(nil, &stdout, &stderr)
	PruneHelmRepoCredentials(nil, &stdout, &stderr)
	PruneChartBindingSecrets(nil, &stdout, &stderr)
	PruneVClusterClusterSecrets(nil, &stdout, &stderr)

	for _, want := range []string{
		"failed to prune registry pull secret",
		"failed to prune Helm repo credential",
		"failed to prune BYO binding ExternalSecret",
		"failed to prune vcluster cluster Secret",
	} {
		if !strings.Contains(stderr.String(), want) {
			t.Fatalf("stderr missing %q:\n%s", want, stderr.String())
		}
	}
}

// TestTail_PruneHelmRepoRefreshersFailureArms covers the refresher prune's two remaining arms: an
// oddly-named object is SKIPPED (its name interpolates into a kubectl command, so anything that is
// not a DNS label fails closed), and a delete failure only warns.
func TestTail_PruneHelmRepoRefreshersFailureArms(t *testing.T) {
	t.Run("oddly named objects are skipped", func(t *testing.T) {
		newKubectlStub(t, 0, stubRule{
			Match:  "-o json",
			Stdout: tailListJSON("argocd", "bad name; rm -rf /"),
			Exit:   0,
		})
		var stdout, stderr bytes.Buffer
		PruneHelmRepoRefreshers(nil, &stdout, &stderr)
		if !strings.Contains(stderr.String(), "skipping prune of oddly-named Helm repo refresher") {
			t.Fatalf("stderr missing the odd-name refusal:\n%s", stderr.String())
		}
	})

	t.Run("delete failures warn", func(t *testing.T) {
		newKubectlStub(t, 1, stubRule{Match: "-o json", Stdout: tailListJSON("argocd", "stale-refresher"), Exit: 0})
		var stdout, stderr bytes.Buffer
		PruneHelmRepoRefreshers(nil, &stdout, &stderr)
		if !strings.Contains(stderr.String(), "failed to prune Helm repo refresher") {
			t.Fatalf("stderr missing the delete warning:\n%s", stderr.String())
		}
	})
}

// TestTail_ReadSecretRefReturnsEmptyOnKubectlFailure covers readSecretRef's error arm: a failed
// kubectl read yields "" (no reference) rather than a half-parsed one.
func TestTail_ReadSecretRefReturnsEmptyOnKubectlFailure(t *testing.T) {
	newKubectlStub(t, 1)
	var stderr bytes.Buffer
	if got := readSecretRef("rel", "ns", "db-rel", &stderr); got != "" {
		t.Fatalf("readSecretRef = %q, want \"\" when kubectl fails", got)
	}
}

// ── repo_access.go ───────────────────────────────────────────────────────────────

// TestTail_IsRepoAnonymouslyCloneableFailureArms covers the request-build and transport arms: an
// unbuildable URL and an unreachable host both mean "not anonymously cloneable" — fail closed onto
// the token path rather than claiming a keyless clone works.
func TestTail_IsRepoAnonymouslyCloneableFailureArms(t *testing.T) {
	if IsRepoAnonymouslyCloneable(context.Background(), "https://exa\x7fmple.com/a.git") {
		t.Fatal("a URL http.NewRequest refuses was reported anonymously cloneable")
	}

	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // nothing is listening now → the probe's transport fails
	if IsRepoAnonymouslyCloneable(context.Background(), strings.Replace(url, "http://", "https://", 1)) {
		t.Fatal("an unreachable host was reported anonymously cloneable")
	}
}

// ── decisions.go ─────────────────────────────────────────────────────────────────

// TestTail_ExternalSecretsStoreDecisionOnAzure covers the Azure installed arm: BOTH the
// managed-identity client id and the Key Vault URI must be present for the store to render, and
// the decision has to say so — the same conjunction the template gates on.
func TestTail_ExternalSecretsStoreDecisionOnAzure(t *testing.T) {
	f := &InfraFacts{
		Provider:                   "azure",
		AzureExternalSecretsClient: "00000000-0000-0000-0000-000000000000",
		AzureKeyVaultURI:           "https://kv.vault.azure.net/",
	}
	d := externalSecretsStoreDecision(f)
	if d.Status != infraStatusInstalled {
		t.Fatalf("azure external-secrets store: want installed, got %s (%s)", d.Status, d.Reason)
	}
	if !strings.Contains(d.Reason, "Key Vault") {
		t.Fatalf("reason should name Azure Key Vault, got %q", d.Reason)
	}
}

// TestTail_WAFAttachedOnGCP covers the GCP attachment site: a Cloud Armor policy counts as
// ATTACHED only when the GKE Ingress that provisions the backend service exists, and the reason
// must name the BackendConfig an operator would go and look at.
func TestTail_WAFAttachedOnGCP(t *testing.T) {
	f := &InfraFacts{
		Provider: "gcp", DNSEnabled: true, DomainName: "example.com",
		ClusterName: "gke-prod", ManagedCertificate: true,
		GCPExternalDNSSA: "dns@p.iam.gserviceaccount.com", GCPProjectID: "p", GCPDNSZoneName: "zone",
		GCPArmorPolicy: "armor-prod",
	}
	if argocdURLDecision(f).Status != infraStatusInstalled {
		t.Fatalf("fixture does not render a GKE Ingress — the attach site would be absent: %s", argocdURLDecision(f).Reason)
	}
	d := wafDecision(f)
	if d.Status != infraStatusInstalled {
		t.Fatalf("gcp waf (policy + ingress): want installed, got %s (%s)", d.Status, d.Reason)
	}
	if !strings.Contains(d.Reason, "armor-prod") || !strings.Contains(d.Reason, "BackendConfig") {
		t.Fatalf("reason should carry the policy name and the BackendConfig that binds it, got %q", d.Reason)
	}
}
