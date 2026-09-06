// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The post-apply "ensure" rail (the ClusterIssuer, the ClusterSecretStore, the seeded credential
// Secrets) and the label/render helpers under it all shell out through the recording kubectl stub
// (kubectl_stub_test.go), so these tests exercise the real code paths with no cluster and no
// network. They deliberately stay on the FAST branches of the retry loops — a success or a
// non-retryable failure returns immediately, while an operator-not-ready marker would sleep 15s.

// TestEnsureCertManagerIssuer covers the three outcomes of the ClusterIssuer ensure: no-op when
// cert-manager does not ship, a server-side apply when it does, and a fail-fast on an error that
// is NOT an operator-not-ready race.
func TestEnsureCertManagerIssuer(t *testing.T) {
	tests := []struct {
		name      string
		facts     func() *InfraFacts
		exit      int
		wantErr   string
		wantApply bool
	}{
		{
			name:  "skipped when the certificate switch is off",
			facts: func() *InfraFacts { f := certManagerFacts("aws"); f.ManagedCertificate = false; return f },
		},
		{
			name:  "skipped when the cloud has no DNS01 solver",
			facts: func() *InfraFacts { return certManagerFacts("hetzner") },
		},
		{
			name:      "applied server-side when the gate is open",
			facts:     func() *InfraFacts { return certManagerFacts("aws") },
			wantApply: true,
		},
		{
			name:      "a non-race apply failure is returned immediately",
			facts:     func() *InfraFacts { return certManagerFacts("gcp") },
			exit:      1,
			wantErr:   "apply cert-manager ClusterIssuer",
			wantApply: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			stub := newKubectlStub(t, tc.exit)
			var stdout, stderr bytes.Buffer
			start := time.Now()
			err := EnsureCertManagerIssuer(tc.facts(), &stdout, &stderr)
			if elapsed := time.Since(start); elapsed > 10*time.Second {
				t.Fatalf("EnsureCertManagerIssuer retried a non-race outcome (took %s)", elapsed)
			}
			switch {
			case tc.wantErr == "" && err != nil:
				t.Fatalf("EnsureCertManagerIssuer() error = %v, want nil", err)
			case tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)):
				t.Fatalf("EnsureCertManagerIssuer() error = %v, want one containing %q", err, tc.wantErr)
			}
			if got := stub.calledWith("apply --server-side"); got != tc.wantApply {
				t.Errorf("server-side apply issued = %v, want %v (calls: %v)", got, tc.wantApply, stub.calls())
			}
		})
	}
}

// TestEnsureExternalSecretsStore covers the same three outcomes for the per-cloud
// ClusterSecretStore: hetzner renders none (no kubectl at all), a rendering cloud applies it
// server-side, and a non-race failure is returned rather than retried.
func TestEnsureExternalSecretsStore(t *testing.T) {
	tests := []struct {
		name      string
		facts     *InfraFacts
		exit      int
		wantErr   string
		wantApply bool
	}{
		{
			name:  "hetzner renders no store at all",
			facts: &InfraFacts{Provider: "hetzner"},
		},
		{
			name:  "aws without the IRSA output renders no store",
			facts: &InfraFacts{Provider: "aws", Region: "us-east-1"},
		},
		{
			name: "aws with the IRSA output applies the store",
			facts: &InfraFacts{
				Provider:               "aws",
				Region:                 "us-east-1",
				IRSAExternalSecretsArn: "arn:aws:iam::acct-123:role/demo-external-secrets",
			},
			wantApply: true,
		},
		{
			name: "a non-race apply failure is returned immediately",
			facts: &InfraFacts{
				Provider:             "gcp",
				GCPProjectID:         "demo-proj",
				GCPExternalSecretsSA: "eso@demo-proj.iam.gserviceaccount.com",
			},
			exit:      1,
			wantErr:   "apply ClusterSecretStore",
			wantApply: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			stub := newKubectlStub(t, tc.exit)
			var stdout, stderr bytes.Buffer
			start := time.Now()
			err := EnsureExternalSecretsStore(tc.facts, &stdout, &stderr)
			if elapsed := time.Since(start); elapsed > 10*time.Second {
				t.Fatalf("EnsureExternalSecretsStore retried a non-race outcome (took %s)", elapsed)
			}
			switch {
			case tc.wantErr == "" && err != nil:
				t.Fatalf("EnsureExternalSecretsStore() error = %v, want nil", err)
			case tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)):
				t.Fatalf("EnsureExternalSecretsStore() error = %v, want one containing %q", err, tc.wantErr)
			}
			if got := stub.calledWith("apply --server-side"); got != tc.wantApply {
				t.Errorf("server-side apply issued = %v, want %v (calls: %v)", got, tc.wantApply, stub.calls())
			}
		})
	}
}

// TestEnsureExternalDNSCredential covers the empty-token refusal, the seeding apply, the
// no-seed-needed path, and locks that the token value never reaches the job log.
func TestEnsureExternalDNSCredential(t *testing.T) {
	cloudflare := &InfraFacts{Provider: "aws", DNSConnector: "cloudflare", DNSCredentialPresent: true}

	t.Run("refuses an empty token", func(t *testing.T) {
		stub := newKubectlStub(t, 0)
		var stdout, stderr bytes.Buffer
		err := EnsureExternalDNSCredential(cloudflare, "", "", &stdout, &stderr)
		if err == nil || !strings.Contains(err.Error(), "refusing to write an empty") {
			t.Fatalf("EnsureExternalDNSCredential() error = %v, want an empty-token refusal", err)
		}
		if len(stub.calls()) != 0 {
			t.Errorf("an empty token still shelled out: %v", stub.calls())
		}
	})

	t.Run("seeds the secret without logging the token", func(t *testing.T) {
		stub := newKubectlStub(t, 0)
		var stdout, stderr bytes.Buffer
		const token = "cf-token-must-not-be-logged"
		if err := EnsureExternalDNSCredential(cloudflare, token, "", &stdout, &stderr); err != nil {
			t.Fatalf("EnsureExternalDNSCredential() error = %v, want nil", err)
		}
		if !stub.calledWith("apply -f") {
			t.Errorf("no kubectl apply was issued: %v", stub.calls())
		}
		if log := stdout.String() + stderr.String() + strings.Join(stub.calls(), " "); strings.Contains(log, token) {
			t.Error("the external-dns token reached the job log or the command line")
		}
	})

	// azure needs a Secret too, and it is the one that was missing entirely (#2868).
	t.Run("seeds the azure config", func(t *testing.T) {
		stub := newKubectlStub(t, 0)
		var stdout, stderr bytes.Buffer
		if err := EnsureExternalDNSCredential(azureFacts(), "", "", &stdout, &stderr); err != nil {
			t.Fatalf("EnsureExternalDNSCredential() error = %v, want nil", err)
		}
		if !stub.calledWith("apply -f") {
			t.Errorf("no kubectl apply was issued for azure: %v", stub.calls())
		}
		if !strings.Contains(stdout.String(), "external-dns-azure") {
			t.Errorf("the azure seed was not announced: %q", stdout.String())
		}
	})

	// aws authenticates through IRSA with nothing on disk. Seeding anything here would write a
	// Secret nothing reads — and, before the switch moved out of the provisioner, this path was
	// the one nothing could observe at all.
	t.Run("seeds nothing when the provider needs no secret", func(t *testing.T) {
		stub := newKubectlStub(t, 0)
		var stdout, stderr bytes.Buffer
		if err := EnsureExternalDNSCredential(&InfraFacts{Provider: "aws"}, "", "", &stdout, &stderr); err != nil {
			t.Fatalf("EnsureExternalDNSCredential() error = %v, want nil", err)
		}
		if len(stub.calls()) != 0 {
			t.Errorf("aws seeded a secret it does not read: %v", stub.calls())
		}
	})
}

// TestConfigureRepoCredentials covers the shared "repo-apps" registration: the Secret is applied
// and the git token never appears in the log or in the command line.
func TestConfigureRepoCredentials(t *testing.T) {
	stub := newKubectlStub(t, 0)
	var stdout, stderr bytes.Buffer
	const token = "ghp-token-must-not-be-logged"
	if err := ConfigureRepoCredentials("https://github.com/acme/app.git", token, &stdout, &stderr); err != nil {
		t.Fatalf("ConfigureRepoCredentials() error = %v, want nil", err)
	}
	if !stub.calledWith("apply -f") {
		t.Fatalf("no kubectl apply was issued: %v", stub.calls())
	}
	log := stdout.String() + stderr.String() + strings.Join(stub.calls(), " ")
	if strings.Contains(log, token) {
		t.Error("the git token reached the job log or the command line")
	}
	if !strings.Contains(stdout.String(), "repo-apps") {
		t.Errorf("the shared secret name was not reported: %q", stdout.String())
	}
}

// TestConfigureRepoCredentialsNamedReportsAFailedApply locks that a kubectl failure surfaces as an
// error rather than a silent "credentials configured".
func TestConfigureRepoCredentialsNamedReportsAFailedApply(t *testing.T) {
	newKubectlStub(t, 1)
	var stdout, stderr bytes.Buffer
	err := ConfigureRepoCredentialsNamed("https://github.com/acme/app.git", "tok", "repo-byo-abc", &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "failed to apply repo credentials") {
		t.Fatalf("ConfigureRepoCredentialsNamed() error = %v, want an apply failure", err)
	}
}

// TestApplyManifestReportsAFailedApply covers the error arm of the shared single-manifest apply.
func TestApplyManifestReportsAFailedApply(t *testing.T) {
	newKubectlStub(t, 1)
	var stdout, stderr bytes.Buffer
	err := ApplyManifest("kind: ConfigMap\n", &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "kubectl apply failed") {
		t.Fatalf("ApplyManifest() error = %v, want an apply failure", err)
	}
}

// vclusterKubeconfigSecret builds the `kubectl get secret -o json` answer the vcluster registration
// reads: a base64'd kubeconfig under the `config` key.
func vclusterKubeconfigSecret(kubeconfig string) string {
	return `{"data":{"config":"` + base64.StdEncoding.EncodeToString([]byte(kubeconfig)) + `"}}`
}

// TestEnsureVClusterClusterSecret covers the fail-closed identifier guards and the happy path
// (read the exported kubeconfig, write the ArgoCD cluster Secret) without logging the bearer token.
func TestEnsureVClusterClusterSecret(t *testing.T) {
	const kubeconfig = `apiVersion: v1
clusters:
  - cluster:
      server: https://vcluster-demo.svc:8443
      certificate-authority-data: Q0FEQVRB
    name: vc
users:
  - user:
      token: vcluster-bearer-token-must-not-be-logged
    name: vc
`

	t.Run("refuses an invalid cluster name", func(t *testing.T) {
		stub := newKubectlStub(t, 0)
		var stdout, stderr bytes.Buffer
		err := EnsureVClusterClusterSecret("Bad Name", "vc-demo-kubeconfig", "argocd", &stdout, &stderr)
		if err == nil || !strings.Contains(err.Error(), "invalid cluster name") {
			t.Fatalf("EnsureVClusterClusterSecret() error = %v, want an invalid-name refusal", err)
		}
		if len(stub.calls()) != 0 {
			t.Errorf("an invalid name still shelled out: %v", stub.calls())
		}
	})

	t.Run("refuses an invalid kubeconfig secret ref", func(t *testing.T) {
		newKubectlStub(t, 0)
		var stdout, stderr bytes.Buffer
		err := EnsureVClusterClusterSecret("vc-demo", "bad ref", "argocd", &stdout, &stderr)
		if err == nil || !strings.Contains(err.Error(), "invalid Secret ref") {
			t.Fatalf("EnsureVClusterClusterSecret() error = %v, want an invalid-ref refusal", err)
		}
	})

	t.Run("registers the vcluster without logging the token", func(t *testing.T) {
		stub := newKubectlStub(t, 0, stubRule{
			Match:  "get secret vc-demo-kubeconfig",
			Stdout: vclusterKubeconfigSecret(kubeconfig),
		})
		var stdout, stderr bytes.Buffer
		if err := EnsureVClusterClusterSecret("vc-demo", "vc-demo-kubeconfig", "argocd", &stdout, &stderr); err != nil {
			t.Fatalf("EnsureVClusterClusterSecret() error = %v, want nil", err)
		}
		if !stub.calledWith("apply -f") {
			t.Fatalf("the cluster Secret was never applied: %v", stub.calls())
		}
		log := stdout.String() + stderr.String() + strings.Join(stub.calls(), " ")
		if strings.Contains(log, "vcluster-bearer-token-must-not-be-logged") {
			t.Error("the vcluster bearer token reached the job log or the command line")
		}
		if !strings.Contains(stdout.String(), "https://vcluster-demo.svc:8443") {
			t.Errorf("the registered server was not reported: %q", stdout.String())
		}
	})
}

// TestDeregisterVClusterClusterSecret covers the fail-closed name guard and the delete.
func TestDeregisterVClusterClusterSecret(t *testing.T) {
	t.Run("refuses an invalid name", func(t *testing.T) {
		stub := newKubectlStub(t, 0)
		var stdout, stderr bytes.Buffer
		err := DeregisterVClusterClusterSecret("vc demo; rm -rf /", &stdout, &stderr)
		if err == nil || !strings.Contains(err.Error(), "invalid cluster name") {
			t.Fatalf("DeregisterVClusterClusterSecret() error = %v, want an invalid-name refusal", err)
		}
		if len(stub.calls()) != 0 {
			t.Errorf("an invalid name still shelled out: %v", stub.calls())
		}
	})

	t.Run("deletes the registration idempotently", func(t *testing.T) {
		stub := newKubectlStub(t, 0)
		var stdout, stderr bytes.Buffer
		if err := DeregisterVClusterClusterSecret("vc-demo", &stdout, &stderr); err != nil {
			t.Fatalf("DeregisterVClusterClusterSecret() error = %v, want nil", err)
		}
		if !stub.calledWith("delete secret vc-demo -n argocd --ignore-not-found=true") {
			t.Errorf("unexpected delete: %v", stub.calls())
		}
	})
}

// pruneCase is one shared table row for the label-listing prune helpers: they all list by label,
// skip an oddly-named object, and tolerate a read/parse failure.
type pruneCase struct {
	name       string
	listStdout string
	listExit   int
	wantDelete bool
	wantWarn   string
}

// TestPrunersToleratePartialReads drives every runner-seeded prune over the same three failure
// shapes — an unreadable list, an unparseable list, and an object whose name is not a DNS label —
// so none of them can start deleting on garbage input.
func TestPrunersToleratePartialReads(t *testing.T) {
	oddName := `{"items":[{"metadata":{"name":"Bad Name","namespace":"argocd"}}]}`
	oddNamespace := `{"items":[{"metadata":{"name":"ok-name","namespace":"Bad NS"}}]}`

	pruners := map[string]struct {
		listMatch string
		run       func(desired []string, stdout, stderr *bytes.Buffer)
	}{
		"helm repo credentials": {
			listMatch: "get secrets -n argocd",
			run:       func(d []string, o, e *bytes.Buffer) { PruneHelmRepoCredentials(d, o, e) },
		},
		"registry pull secrets": {
			listMatch: "get secrets -A",
			run:       func(d []string, o, e *bytes.Buffer) { PruneRegistryPullSecrets(d, o, e) },
		},
		"vcluster cluster secrets": {
			listMatch: "get secrets -n argocd",
			run:       func(d []string, o, e *bytes.Buffer) { PruneVClusterClusterSecrets(d, o, e) },
		},
		"byo binding external secrets": {
			listMatch: "get externalsecrets -A",
			run:       func(d []string, o, e *bytes.Buffer) { PruneChartBindingSecrets(d, o, e) },
		},
	}

	cases := []pruneCase{
		{name: "unreadable list", listStdout: "", listExit: 1, wantWarn: "Warning:"},
		{name: "unparseable list", listStdout: "not json", wantWarn: "Warning:"},
		{name: "oddly-named object", listStdout: oddName, wantWarn: "oddly-named"},
		{name: "oddly-namespaced object", listStdout: oddNamespace, wantWarn: "oddly-named"},
	}

	for pruneName, p := range pruners {
		for _, tc := range cases {
			t.Run(pruneName+"/"+tc.name, func(t *testing.T) {
				stub := newKubectlStub(t, 0, stubRule{Match: p.listMatch, Stdout: tc.listStdout, Exit: tc.listExit})
				var stdout, stderr bytes.Buffer
				p.run(nil, &stdout, &stderr)
				if !strings.Contains(stderr.String(), tc.wantWarn) {
					t.Errorf("stderr = %q, want a warning containing %q", stderr.String(), tc.wantWarn)
				}
				if stub.calledWith("delete") != tc.wantDelete {
					t.Errorf("a delete was issued on %s: %v", tc.name, stub.calls())
				}
			})
		}
	}
}

// TestPruneHelmRepoRefreshers covers the three-kind sweep: a desired refresher is kept, an
// undesired one is deleted for every kind, and a per-kind read failure does not abort the rest.
func TestPruneHelmRepoRefreshers(t *testing.T) {
	list := `{"items":[
	  {"metadata":{"name":"keep-refresher","namespace":"argocd"}},
	  {"metadata":{"name":"drop-refresher","namespace":"argocd"}}
	]}`

	t.Run("deletes only the undesired unit, for every kind", func(t *testing.T) {
		stub := newKubectlStub(t, 0, stubRule{Match: "-l alethia.io/helm-repo-refresher", Stdout: list})
		var stdout, stderr bytes.Buffer
		PruneHelmRepoRefreshers([]string{"keep-refresher"}, &stdout, &stderr)
		for _, kind := range []string{"deployment", "role", "rolebinding"} {
			if !stub.calledWith("delete " + kind + " -n argocd drop-refresher") {
				t.Errorf("no %s delete for the undesired refresher: %v", kind, stub.calls())
			}
		}
		if stub.calledWith("keep-refresher --ignore-not-found") {
			t.Errorf("the desired refresher was deleted: %v", stub.calls())
		}
	})

	t.Run("an unreadable kind does not abort the sweep", func(t *testing.T) {
		newKubectlStub(t, 1)
		var stdout, stderr bytes.Buffer
		PruneHelmRepoRefreshers(nil, &stdout, &stderr)
		if got := strings.Count(stderr.String(), "could not list"); got != 3 {
			t.Errorf("warned %d times, want one per kind (3): %q", got, stderr.String())
		}
	})

	t.Run("an unparseable kind does not abort the sweep", func(t *testing.T) {
		newKubectlStub(t, 0, stubRule{Match: "-l alethia.io/helm-repo-refresher", Stdout: "not json"})
		var stdout, stderr bytes.Buffer
		PruneHelmRepoRefreshers(nil, &stdout, &stderr)
		if got := strings.Count(stderr.String(), "could not parse"); got != 3 {
			t.Errorf("warned %d times, want one per kind (3): %q", got, stderr.String())
		}
	})
}

// TestPruneManagedAddOnsBestEffort covers the three tolerated failures of the Application prune: an
// unreadable list, an unparseable list, and a delete that fails.
func TestPruneManagedAddOnsBestEffort(t *testing.T) {
	tests := []struct {
		name       string
		rules      []stubRule
		defaultExt int
		wantWarn   string
	}{
		{name: "unreadable list", defaultExt: 1, wantWarn: "could not list add-ons to prune"},
		{
			name:     "unparseable list",
			rules:    []stubRule{{Match: "get applications", Stdout: "not json"}},
			wantWarn: "could not parse add-on list to prune",
		},
		{
			name: "a failing delete is reported, not fatal",
			rules: []stubRule{
				{Match: "get applications", Stdout: `{"items":[{"metadata":{"name":"addon-gone"}}]}`},
				{Match: "delete applications", Exit: 1},
			},
			wantWarn: "failed to prune addon-gone",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			newKubectlStub(t, tc.defaultExt, tc.rules...)
			var stdout, stderr bytes.Buffer
			if err := PruneManagedAddOns(nil, &stdout, &stderr); err != nil {
				t.Fatalf("PruneManagedAddOns() error = %v, want nil (best-effort)", err)
			}
			if !strings.Contains(stderr.String(), tc.wantWarn) {
				t.Errorf("stderr = %q, want a warning containing %q", stderr.String(), tc.wantWarn)
			}
		})
	}
}

// TestInjectCommonLabelsEdgeDocuments covers the document shapes the injector must survive: a
// non-mapping document, a non-ArgoCD kind, a `labels:` key with no value, a trailing empty
// document, and unparseable YAML.
func TestInjectCommonLabelsEdgeDocuments(t *testing.T) {
	labels := map[string]string{"alethia.io/env": "dev"}
	tests := []struct {
		name     string
		manifest string
		wantErr  string
		want     []string
		notWant  []string
	}{
		{
			name:     "a sequence document is re-emitted untouched",
			manifest: "- a\n- b\n",
			want:     []string{"- a", "- b"},
			notWant:  []string{"alethia.io/env"},
		},
		{
			name:     "a non-ArgoCD kind is left alone",
			manifest: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n",
			want:     []string{"kind: ConfigMap", "name: x"},
			notWant:  []string{"alethia.io/env"},
		},
		{
			name:     "an empty labels key is coerced to a mapping",
			manifest: "kind: Application\nmetadata:\n  name: x\n  labels:\n",
			want:     []string{"name: x", "alethia.io/env: dev"},
		},
		{
			name:     "a resource with no metadata gets one",
			manifest: "kind: AppProject\nspec: {}\n",
			want:     []string{"alethia.io/env: dev"},
		},
		{
			name:     "an existing key is never overwritten",
			manifest: "kind: Application\nmetadata:\n  labels:\n    alethia.io/env: prod\n",
			want:     []string{"alethia.io/env: prod"},
			notWant:  []string{"alethia.io/env: dev"},
		},
		{
			name:     "a trailing document separator does not emit a null",
			manifest: "kind: Application\nmetadata:\n  name: x\n---\n",
			want:     []string{"name: x"},
			notWant:  []string{"null"},
		},
		{
			name:     "unparseable YAML is an error",
			manifest: "kind: Application\n  bad: [indent\n",
			wantErr:  "decode manifest",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := InjectCommonLabels(tc.manifest, labels)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("InjectCommonLabels() error = %v, want one containing %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("InjectCommonLabels() error = %v, want nil", err)
			}
			for _, w := range tc.want {
				if !strings.Contains(got, w) {
					t.Errorf("output missing %q:\n%s", w, got)
				}
			}
			for _, w := range tc.notWant {
				if strings.Contains(got, w) {
					t.Errorf("output unexpectedly contains %q:\n%s", w, got)
				}
			}
		})
	}
}

// TestInjectCommonLabelsNoLabelsIsAFastPath locks the "pass it unconditionally" contract: an empty
// label map returns the manifest byte-identically, without a YAML round-trip.
func TestInjectCommonLabelsNoLabelsIsAFastPath(t *testing.T) {
	const in = "kind: Application\nmetadata:\n  name:    x\n"
	got, err := InjectCommonLabels(in, nil)
	if err != nil {
		t.Fatalf("InjectCommonLabels() error = %v, want nil", err)
	}
	if got != in {
		t.Errorf("InjectCommonLabels() = %q, want the input byte-identically", got)
	}
}

// TestRenderApplicationsErrorPaths covers the render loop's three failures (missing dir, bad
// template, failed execution) and its two skips (a subdirectory, a non-.yaml file, an empty render).
func TestRenderApplicationsErrorPaths(t *testing.T) {
	facts := &InfraFacts{Provider: "aws", Region: "us-east-1"}

	t.Run("a missing templates dir is an error", func(t *testing.T) {
		_, err := RenderApplications(filepath.Join(t.TempDir(), "nope"), facts)
		if err == nil || !strings.Contains(err.Error(), "failed to read templates dir") {
			t.Fatalf("RenderApplications() error = %v, want a read failure", err)
		}
	})

	t.Run("an unparseable template is an error", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "bad.yaml"), []byte("{{ if }"), 0o600); err != nil {
			t.Fatalf("seed template: %v", err)
		}
		_, err := RenderApplications(dir, facts)
		if err == nil || !strings.Contains(err.Error(), "failed to parse template") {
			t.Fatalf("RenderApplications() error = %v, want a parse failure", err)
		}
	})

	t.Run("a template referencing an unknown field is an error", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "boom.yaml"), []byte("{{ .NoSuchField }}"), 0o600); err != nil {
			t.Fatalf("seed template: %v", err)
		}
		_, err := RenderApplications(dir, facts)
		if err == nil || !strings.Contains(err.Error(), "failed to render") {
			t.Fatalf("RenderApplications() error = %v, want a render failure", err)
		}
	})

	t.Run("directories, non-yaml files and empty renders are skipped", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
			t.Fatalf("seed subdir: %v", err)
		}
		seed := map[string]string{
			"README.md":  "not a template",
			"empty.yaml": "{{- if .DNSEnabled }}rendered{{- end }}",
			"real.yaml":  "kind: Application\nmetadata:\n  name: real\n",
		}
		for name, body := range seed {
			if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
				t.Fatalf("seed %s: %v", name, err)
			}
		}
		out, err := RenderApplications(dir, facts)
		if err != nil {
			t.Fatalf("RenderApplications() error = %v, want nil", err)
		}
		entries, err := os.ReadDir(out)
		if err != nil {
			t.Fatalf("read rendered dir: %v", err)
		}
		if len(entries) != 1 || entries[0].Name() != "real.yaml" {
			names := make([]string, 0, len(entries))
			for _, e := range entries {
				names = append(names, e.Name())
			}
			t.Errorf("rendered %v, want only real.yaml", names)
		}
	})
}

// TestWaitAddOnsHealthyHonoursCancellation covers the two non-converging exits of the convergence
// wait: a cancelled context returns the last read immediately, and an empty name list is a no-op.
func TestWaitAddOnsHealthyHonoursCancellation(t *testing.T) {
	t.Run("no names is a no-op", func(t *testing.T) {
		stub := newKubectlStub(t, 0)
		var stdout, stderr bytes.Buffer
		if got := WaitAddOnsHealthy(context.Background(), nil, time.Minute, &stdout, &stderr); len(got) != 0 {
			t.Errorf("WaitAddOnsHealthy() = %v, want an empty map", got)
		}
		if len(stub.calls()) != 0 {
			t.Errorf("an empty name list still shelled out: %v", stub.calls())
		}
	})

	t.Run("a cancelled context returns the last read", func(t *testing.T) {
		newKubectlStub(t, 0, stubRule{
			Match:  "get applications",
			Stdout: `{"items":[{"metadata":{"name":"addon-x"},"status":{"health":{"status":"Progressing"},"sync":{"status":"OutOfSync"}}}]}`,
		})
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		var stdout, stderr bytes.Buffer
		start := time.Now()
		got := WaitAddOnsHealthy(ctx, []string{"addon-x"}, time.Minute, &stdout, &stderr)
		if elapsed := time.Since(start); elapsed > 5*time.Second {
			t.Fatalf("a cancelled context did not short-circuit the wait (took %s)", elapsed)
		}
		if got["addon-x"].Health != "Progressing" || got["addon-x"].Sync != "OutOfSync" {
			t.Errorf("WaitAddOnsHealthy() = %+v, want the last read", got)
		}
	})
}

// TestPendingRendersConvergedAsNone covers the timeout message's converged branch.
func TestPendingRendersConvergedAsNone(t *testing.T) {
	if got := pending(map[string]AddOnHealth{"addon-x": {Health: "Healthy", Sync: "Synced"}}); got != "none" {
		t.Errorf("pending() = %q, want %q", got, "none")
	}
}

// TestReadSecurityPostureAggregates covers the Trivy read: an absent CRD is an honest unscanned
// posture, an unparseable answer is too, and reports are summed across the cluster.
func TestReadSecurityPostureAggregates(t *testing.T) {
	t.Run("an absent CRD reports unscanned", func(t *testing.T) {
		newKubectlStub(t, 1)
		var stdout, stderr bytes.Buffer
		got := ReadSecurityPosture(&stdout, &stderr)
		if got.Scanned {
			t.Errorf("ReadSecurityPosture() = %+v, want Scanned=false", got)
		}
	})

	t.Run("an unparseable answer reports unscanned", func(t *testing.T) {
		newKubectlStub(t, 0, stubRule{Match: "vulnerabilityreports", Stdout: "not json"})
		var stdout, stderr bytes.Buffer
		got := ReadSecurityPosture(&stdout, &stderr)
		if got.Scanned {
			t.Errorf("ReadSecurityPosture() = %+v, want Scanned=false", got)
		}
		if !strings.Contains(stderr.String(), "could not parse Trivy reports") {
			t.Errorf("stderr = %q, want a parse warning", stderr.String())
		}
	})

	t.Run("reports are summed across namespaces", func(t *testing.T) {
		newKubectlStub(t, 0, stubRule{Match: "vulnerabilityreports", Stdout: `{"items":[
		  {"report":{"summary":{"criticalCount":1,"highCount":2,"mediumCount":3,"lowCount":4}}},
		  {"report":{"summary":{"criticalCount":5,"highCount":6,"mediumCount":7,"lowCount":8}}}
		]}`})
		var stdout, stderr bytes.Buffer
		got := ReadSecurityPosture(&stdout, &stderr)
		want := SecurityPosture{Critical: 6, High: 8, Medium: 10, Low: 12, ReportCount: 2, Scanned: true}
		if got != want {
			t.Errorf("ReadSecurityPosture() = %+v, want %+v", got, want)
		}
	})
}

// TestReadSecretRefPrefersTheApplicationCredential covers the credential-REFERENCE read: helm
// release secrets are ignored, an "-app" secret wins, and no secrets means no reference.
func TestReadSecretRefPrefersTheApplicationCredential(t *testing.T) {
	tests := []struct {
		name   string
		stdout string
		want   string
	}{
		{name: "no secrets", stdout: `{"items":[]}`},
		{
			name:   "helm release secrets are not credentials",
			stdout: `{"items":[{"metadata":{"name":"sh.helm.release.v1.db.v1","namespace":"data"},"type":"helm.sh/release.v1"}]}`,
		},
		{
			name: "the -app secret wins over an alphabetically earlier one",
			stdout: `{"items":[
			  {"metadata":{"name":"db-primary-ca","namespace":"data"},"type":"Opaque"},
			  {"metadata":{"name":"db-primary-app","namespace":"data"},"type":"kubernetes.io/basic-auth"}
			]}`,
			want: "data/db-primary-app",
		},
		{
			name:   "otherwise the first secret by name",
			stdout: `{"items":[{"metadata":{"name":"cache-main","namespace":"data"},"type":"Opaque"}]}`,
			want:   "data/cache-main",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// SCOPED TO THE SELECTOR UNDER TEST. readSecretRef now issues two lookups, and a rule
			// matching the bare "get secret -n data" answers BOTH — so the runner-seeded lookup
			// would fire first, return, and this table would prove the `-app` preference and the
			// helm-release skip on the wrong branch while reporting success.
			newKubectlStub(t, 0,
				stubRule{Match: "alethia.io/addon-secret=", Stdout: `{"items":[]}`},
				stubRule{Match: "app.kubernetes.io/instance=", Stdout: tc.stdout},
			)
			var stderr bytes.Buffer
			if got := readSecretRef("addon-db-primary", "data", "db-primary", &stderr); got != tc.want {
				t.Errorf("readSecretRef() = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestNamespaceTenantNameIsBounded covers the RFC1123 name builder's sanitize, fallback and
// 63-character ceiling — the ArgoCD resource-name limit a long project/env pair would blow.
func TestNamespaceTenantNameIsBounded(t *testing.T) {
	tests := []struct {
		name      string
		prefix    string
		project   string
		namespace string
		want      string
	}{
		{name: "sanitizes and lowercases", prefix: "tenant", project: "Acme Corp", namespace: "Dev_1", want: "tenant-acme-corp-dev-1"},
		{name: "drops empty parts", prefix: "tenant", project: "", namespace: "dev", want: "tenant-dev"},
		{name: "falls back when everything sanitizes away", prefix: "", project: "***", namespace: "!!!", want: "tenant"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := namespaceTenantName(tc.prefix, tc.project, tc.namespace); got != tc.want {
				t.Errorf("namespaceTenantName() = %q, want %q", got, tc.want)
			}
		})
	}

	t.Run("is bounded at 63 characters with no trailing dash", func(t *testing.T) {
		got := namespaceTenantName("tenant", strings.Repeat("a", 40), strings.Repeat("b", 40))
		if len(got) > 63 {
			t.Errorf("namespaceTenantName() = %q (%d chars), want <= 63", got, len(got))
		}
		if strings.HasSuffix(got, "-") {
			t.Errorf("namespaceTenantName() = %q, want no trailing dash", got)
		}
	})
}

// TestReadExportedKubeconfigFailsClosed covers every way the vcluster-exported kubeconfig Secret
// can be half-written: unreadable, unparseable, missing the `config` key, and not base64.
func TestReadExportedKubeconfigFailsClosed(t *testing.T) {
	tests := []struct {
		name       string
		listStdout string
		listExit   int
		wantErr    string
	}{
		{name: "unreadable secret", listExit: 1, wantErr: "read exported kubeconfig Secret"},
		{name: "unparseable secret", listStdout: "not json", wantErr: "parse exported kubeconfig Secret"},
		{name: "no config key yet", listStdout: `{"data":{}}`, wantErr: "has no config key yet"},
		{name: "empty config key", listStdout: `{"data":{"config":""}}`, wantErr: "has no config key yet"},
		{name: "config is not base64", listStdout: `{"data":{"config":"!!!not-base64!!!"}}`, wantErr: "decode exported kubeconfig Secret"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			newKubectlStub(t, 0, stubRule{Match: "get secret vc-demo-kubeconfig", Stdout: tc.listStdout, Exit: tc.listExit})
			_, err := readExportedKubeconfig("vc-demo-kubeconfig", "argocd")
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("readExportedKubeconfig() error = %v, want one containing %q", err, tc.wantErr)
			}
		})
	}
}

// TestApplyAddOnsAppliesANonEmptyDir covers the alias's apply arm (the empty-dir and missing-dir
// arms are covered in apply_paths_test.go).
func TestApplyAddOnsAppliesANonEmptyDir(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "addon-x.yaml"), []byte("kind: Application\n"), 0o600); err != nil {
		t.Fatalf("seed rendered dir: %v", err)
	}
	stub := newKubectlStub(t, 0)
	var stdout, stderr bytes.Buffer
	if err := ApplyAddOns(dir, &stdout, &stderr); err != nil {
		t.Fatalf("ApplyAddOns() error = %v, want nil", err)
	}
	if !stub.calledWith("apply -f " + dir) {
		t.Errorf("the rendered dir was not applied: %v", stub.calls())
	}
	if !strings.Contains(stdout.String(), "Applying marketplace add-ons") {
		t.Errorf("stdout = %q, want the add-on banner", stdout.String())
	}
}

// TestPruneAddOnSecretsBestEffort covers the tolerated failures of the add-on Secret sweep: an
// unreadable list, an unparseable list, an oddly-named Secret, and a delete that fails.
func TestPruneAddOnSecretsBestEffort(t *testing.T) {
	tests := []struct {
		name       string
		rules      []stubRule
		defaultExt int
		wantWarn   string
	}{
		{name: "unreadable list", defaultExt: 1, wantWarn: "could not list add-on secrets to prune"},
		{
			name:     "unparseable list",
			rules:    []stubRule{{Match: "get secrets -A", Stdout: "not json"}},
			wantWarn: "could not parse add-on secret list to prune",
		},
		{
			name: "an oddly-named secret is skipped",
			rules: []stubRule{{
				Match:  "get secrets -A",
				Stdout: `{"items":[{"metadata":{"name":"Bad Name","namespace":"apps","labels":{"alethia.io/addon-secret":"gone"}}}]}`,
			}},
			wantWarn: "oddly-named secret",
		},
		{
			name: "a failing delete is reported, not fatal",
			rules: []stubRule{
				{
					Match:  "get secrets -A",
					Stdout: `{"items":[{"metadata":{"name":"gone-creds","namespace":"apps","labels":{"alethia.io/addon-secret":"gone"}}}]}`,
				},
				{Match: "delete secret -n apps gone-creds", Exit: 1},
			},
			wantWarn: "failed to prune add-on secret apps/gone-creds",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			newKubectlStub(t, tc.defaultExt, tc.rules...)
			var stdout, stderr bytes.Buffer
			PruneAddOnSecrets(nil, &stdout, &stderr)
			if !strings.Contains(stderr.String(), tc.wantWarn) {
				t.Errorf("stderr = %q, want a warning containing %q", stderr.String(), tc.wantWarn)
			}
		})
	}
}

// TestInfraServiceSkipReasons covers the per-cloud skip explanations keyed on the FIRST failing
// term — the whole point of the reason ladders is that each blocker gets its own sentence.
func TestInfraServiceSkipReasons(t *testing.T) {
	azure := func(mutate func(*InfraFacts)) *InfraFacts {
		f := certManagerFacts("azure")
		f.AzureAppGatewayName = "agw-demo"
		mutate(f)
		return f
	}
	gcp := func(mutate func(*InfraFacts)) *InfraFacts {
		f := certManagerFacts("gcp")
		f.ClusterName = "demo-gke"
		mutate(f)
		return f
	}

	azureCases := []struct {
		name  string
		facts *InfraFacts
		want  string
	}{
		{name: "dns off", facts: azure(func(f *InfraFacts) { f.DNSEnabled = false }), want: "DNS is disabled"},
		{name: "no domain", facts: azure(func(f *InfraFacts) { f.DomainName = "" }), want: "no domain is configured"},
		{name: "no gateway", facts: azure(func(f *InfraFacts) { f.AzureAppGatewayName = "" }), want: "no Application Gateway is provisioned"},
		{name: "no certificate", facts: azure(func(f *InfraFacts) { f.ManagedCertificate = false }), want: "nothing will issue its TLS certificate"},
		{name: "everything present", facts: azure(func(*InfraFacts) {}), want: ""},
	}
	for _, tc := range azureCases {
		t.Run("azure/"+tc.name, func(t *testing.T) {
			got := azureArgocdURLSkipReason(tc.facts)
			if tc.want == "" {
				if got != "" {
					t.Errorf("azureArgocdURLSkipReason() = %q, want an empty reason", got)
				}
				return
			}
			if !strings.Contains(got, tc.want) {
				t.Errorf("azureArgocdURLSkipReason() = %q, want one containing %q", got, tc.want)
			}
		})
	}

	gcpCases := []struct {
		name  string
		facts *InfraFacts
		want  string
	}{
		{name: "dns off", facts: gcp(func(f *InfraFacts) { f.DNSEnabled = false }), want: "DNS is disabled"},
		{name: "no domain", facts: gcp(func(f *InfraFacts) { f.DomainName = "" }), want: "no domain is configured"},
		{name: "no cluster", facts: gcp(func(f *InfraFacts) { f.ClusterName = "" }), want: "no GKE cluster was provisioned"},
		{name: "no certificate", facts: gcp(func(f *InfraFacts) { f.ManagedCertificate = false }), want: "nothing will issue its TLS certificate"},
		{name: "everything present", facts: gcp(func(*InfraFacts) {}), want: ""},
	}
	for _, tc := range gcpCases {
		t.Run("gcp/"+tc.name, func(t *testing.T) {
			got := gcpArgocdURLSkipReason(tc.facts)
			if tc.want == "" {
				if got != "" {
					t.Errorf("gcpArgocdURLSkipReason() = %q, want an empty reason", got)
				}
				return
			}
			if !strings.Contains(got, tc.want) {
				t.Errorf("gcpArgocdURLSkipReason() = %q, want one containing %q", got, tc.want)
			}
		})
	}

	t.Run("an unknown cloud gets the generic unattachable reason", func(t *testing.T) {
		got := wafUnattachableReason("someday-cloud", "acl-1")
		if !strings.Contains(got, "nothing on this cloud can attach it yet") {
			t.Errorf("wafUnattachableReason() = %q, want the generic reason", got)
		}
	})

	t.Run("an unknown cloud gets the generic cross-account backend name", func(t *testing.T) {
		if got := xacctBackend("someday-cloud"); !strings.Contains(got, "a cross-account cloud secret manager") {
			t.Errorf("xacctBackend() = %q, want the generic backend name", got)
		}
	})

	t.Run("a selected but uncredentialed cloudflare connector says so", func(t *testing.T) {
		f := &InfraFacts{DNSEnabled: true, DomainName: "demo.example.com", Provider: "aws", DNSConnector: "cloudflare"}
		if got := externalDNSSkipReason(f); !strings.Contains(got, "reconnect the Cloudflare DNS connector") {
			t.Errorf("externalDNSSkipReason() = %q, want the cloudflare-credential reason", got)
		}
	})

	t.Run("an unknown cloud has no cloud secret store", func(t *testing.T) {
		d := externalSecretsStoreDecision(&InfraFacts{Provider: "someday-cloud"})
		if d.Status != infraStatusSkipped || !strings.Contains(d.Reason, "no cloud secret store for this provider") {
			t.Errorf("externalSecretsStoreDecision() = %+v, want the generic skip", d)
		}
	})
}
