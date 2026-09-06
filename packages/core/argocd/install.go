// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"strings"
	"text/template"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/categories"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// applyCRDRaceMaxWait bounds how long ApplyApplications retries while ArgoCD establishes the CRDs
// that its wave-1 operator Applications (e.g. external-secrets) install asynchronously.
var applyCRDRaceMaxWait = 5 * time.Minute

func ApplyApplications(renderedDir string, stdout, stderr io.Writer) error {
	// Before the apply, not beside it: a StorageClass whose `provisioner` differs from the live one
	// cannot be updated (the field is immutable), so the apply below would fail outright rather than
	// converge. Making the applies POSSIBLE is part of applying them, which is why this lives here
	// and not in the caller — deploy.go should not have to know that one manifest kind has an
	// immutable field. See storage_class_reconcile.go.
	if scErr := ReconcileImmutableStorageClasses(renderedDir, stdout, stderr); scErr != nil {
		return scErr
	}
	cmd := fmt.Sprintf("kubectl apply -f %s", renderedDir)
	fmt.Fprintln(stdout, "Applying ArgoCD infrastructure applications...")
	// ArgoCD Applications install their CRDs + admission webhooks ASYNCHRONOUSLY via ArgoCD sync
	// (e.g. external-secrets-operator). The infra dir now contains ONLY Applications — the per-cloud
	// ClusterSecretStore CR that used to share the operator's file was pulled out because mixing a
	// CR-instance into this client-side apply deadlocked it on a fresh cluster (see
	// EnsureExternalSecretsStore / #1208). The retry below is kept as a harmless backstop for the
	// "an operator isn't fully up yet" markers, should a future template mix a CR-instance in again.
	deadline := time.Now().Add(applyCRDRaceMaxWait)
	for attempt := 1; ; attempt++ {
		var captured bytes.Buffer
		err := utils.ExecuteCommand(cmd, ".", nil, stdout, io.MultiWriter(stderr, &captured))
		if err == nil {
			fmt.Fprintln(stdout, "ArgoCD infrastructure applications applied.")
			return nil
		}
		// Retry ONLY the "operator not fully up yet" races; any other failure is fatal.
		if !isOperatorNotReady(captured.String()) || time.Now().After(deadline) {
			return fmt.Errorf("kubectl apply failed: %w", err)
		}
		fmt.Fprintf(stdout, "  An operator (CRD/webhook) isn't ready yet (attempt %d) — "+
			"waiting 15s for ArgoCD to finish installing it...\n", attempt)
		time.Sleep(15 * time.Second)
	}
}

// isOperatorNotReady reports whether a kubectl failure is a transient "the operator that backs this
// custom resource isn't fully installed yet" race — its CRD isn't registered, or its admission
// webhook has no ready endpoints. These are the only conditions ApplyApplications retries; a real
// validation/authz/config error is NOT retried.
func isOperatorNotReady(kubectlOutput string) bool {
	for _, marker := range []string{
		"no matches for kind",        // the CRD isn't registered yet
		"resource mapping not found", // ditto (RESTMapper hasn't seen the CRD)
		"failed calling webhook",     // the admission webhook backend isn't reachable yet
		"no endpoints available",     // the webhook Service has no ready pods yet
	} {
		if strings.Contains(kubectlOutput, marker) {
			return true
		}
	}
	return false
}

// externalDNSSecretManifest builds the namespace + token Secret manifest external-dns's
// connector-backed providers read (cloudflare CF_API_TOKEN / hetzner HETZNER_TOKEN).
// The namespace is included because the Secret must exist before the Application's first
// sync creates it via CreateNamespace=true.
func externalDNSSecretManifest(secretName, key, token string) string {
	b64 := base64.StdEncoding.EncodeToString
	return fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: external-dns
---
apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: external-dns
data:
  %s: %s
`, secretName, key, b64([]byte(token)))
}

// azureDNSConfigJSON builds the `azure.json` external-dns reads on Azure.
//
// WHY A FILE AND NOT FLAGS. external-dns v0.15.0 (chart 1.15.0) resolves its Azure settings in
// provider/azure/config.go's getConfig(), which opens with an UNCONDITIONAL
// `os.ReadFile(configFile)` and returns an error when it is absent — the flag overrides for
// subscription and resource group are applied AFTER that read, so they cannot rescue it. On an
// AKS cluster using workload identity there is no /etc/kubernetes/azure.json (that path is the
// legacy in-tree cloud-provider's, which AKS does not lay down for us), so the controller dies
// with `failed to read Azure config file` and CrashLoopBackOffs while the ArgoCD Application
// still reports Synced — which is exactly how #2868 presented as a file-not-found rather than
// an auth error.
//
// `useWorkloadIdentityExtension` is the load-bearing key and it is FILE-ONLY: there is no
// corresponding flag anywhere in v0.15.0. Without it getCredentials() falls through workload
// identity to MSI and authenticates as the node's kubelet identity, which holds no DNS rights.
//
// aadClientId is deliberately OMITTED. The azure.workload.identity/use pod label makes the
// webhook inject AZURE_CLIENT_ID from the service account's client-id annotation, and azidentity
// reads it from the environment when the config leaves it empty. Writing it here as well would
// give the same fact two sources that can disagree. aadClientSecret is likewise absent: with it
// empty, getCredentials() skips the service-principal branch — which is what makes this keyless.
func azureDNSConfigJSON(subscriptionID, resourceGroup, tenantID string) string {
	// Marshalled by hand, in a fixed key order, because this string is hashed into the
	// Secret and a map's iteration order would make the manifest differ between deploys for
	// no change in input — the render-nondeterminism class that keeps an add-on permanently
	// OutOfSync (#2822, #2823).
	return fmt.Sprintf(`{
  "cloud": "AzurePublicCloud",
  "tenantId": %q,
  "subscriptionId": %q,
  "resourceGroup": %q,
  "useWorkloadIdentityExtension": true
}
`, tenantID, subscriptionID, resourceGroup)
}

// ExternalDNSSeed is the Secret one cloud's external-dns needs to exist BEFORE the Application's
// first sync. The zero value means "this provider needs no pre-seeded Secret", which is the
// correct answer for aws and google — they authenticate through IRSA / Workload Identity with
// nothing on disk.
type ExternalDNSSeed struct {
	SecretName string
	Key        string
	Value      string
}

// Needed reports whether this provider needs a Secret seeded at all.
func (s ExternalDNSSeed) Needed() bool { return s.SecretName != "" }

// ExternalDNSSeedFor decides WHAT to seed for the deploy's DNS provider. It is PURE — no cluster,
// no environment — so the whole decision is unit-tested, which is the point of splitting it from
// the apply below: this used to be a `switch` inline in the provisioner's deploy path, where
// nothing could reach it without a live cluster and every branch was measured as dead.
//
// It reads f.DNSProvider(), the SAME gate the render template and InfraServiceDecisions use, so a
// provider the app is not rendered for can never have a Secret written for it.
func ExternalDNSSeedFor(f *InfraFacts, cloudflareToken, hetznerToken string) (ExternalDNSSeed, error) {
	switch f.DNSProvider() {
	case "cloudflare":
		if cloudflareToken == "" {
			return ExternalDNSSeed{}, fmt.Errorf("refusing to write an empty external-dns-cloudflare token secret")
		}
		return ExternalDNSSeed{SecretName: "external-dns-cloudflare", Key: "apiToken", Value: cloudflareToken}, nil
	case "webhook":
		if hetznerToken == "" {
			return ExternalDNSSeed{}, fmt.Errorf("refusing to write an empty external-dns-hetzner token secret")
		}
		return ExternalDNSSeed{SecretName: "external-dns-hetzner", Key: "token", Value: hetznerToken}, nil
	case "azure":
		// NOT a credential: external-dns on Azure is keyless via workload identity. This is the
		// azure.json its provider reads unconditionally, and the only place
		// useWorkloadIdentityExtension can be set at all (#2868).
		//
		// Every value is required, and DNSProvider() already returns "" unless all four Azure
		// facts are present — so reaching here with an empty one means the render gate and this
		// seeder have drifted apart, which is worth failing loudly rather than writing a config
		// that reproduces #2868 with different empty fields.
		if f.AzureSubscriptionID == "" || f.AzureResourceGroup == "" || f.AzureTenantID == "" {
			return ExternalDNSSeed{}, fmt.Errorf("refusing to write an incomplete external-dns azure.json "+
				"(subscription=%q resourceGroup=%q tenant=%q) — DNSProvider() should have skipped the app",
				f.AzureSubscriptionID, f.AzureResourceGroup, f.AzureTenantID)
		}
		return ExternalDNSSeed{
			SecretName: "external-dns-azure",
			Key:        "azure.json",
			Value:      azureDNSConfigJSON(f.AzureSubscriptionID, f.AzureResourceGroup, f.AzureTenantID),
		}, nil
	}
	// aws (IRSA), google (Workload Identity), and every cloud whose app is not rendered at all.
	return ExternalDNSSeed{}, nil
}

// EnsureExternalDNSCredential seeds whatever ExternalDNSSeedFor decides this deploy needs, before
// the external-dns Application's first sync (mirrors ensureArgoRedisSecret's pre-seed). Idempotent:
// re-applying refreshes a rotated token on every deploy.
func EnsureExternalDNSCredential(f *InfraFacts, cloudflareToken, hetznerToken string, stdout, stderr io.Writer) error {
	seed, err := ExternalDNSSeedFor(f, cloudflareToken, hetznerToken)
	if err != nil {
		return err
	}
	if !seed.Needed() {
		return nil
	}
	fmt.Fprintf(stdout, "Seeding external-dns secret %s...\n", seed.SecretName)
	return ApplyManifest(externalDNSSecretManifest(seed.SecretName, seed.Key, seed.Value), stdout, stderr)
}

// secretsSaaSCredentialManifest builds the namespace + credential Secret manifest a pluggable SaaS
// ClusterSecretStore's auth.secretRef reads (Vault tokenSecretRef / Doppler dopplerToken / Infisical
// universalAuthCredentials). The namespace (the operator's own) is included so the Secret exists even
// before the operator's Application first creates it — the store references it by (name, key,
// namespace). data carries one entry per key because auth arity is per-provider: one token for
// vault/generic/doppler, two (clientId + clientSecret) for infisical's Universal Auth. Keys are
// emitted in the caller's order so the rendered manifest is stable across deploys.
func secretsSaaSCredentialManifest(namespace, secretName string, data []SecretsStoreCredential) string {
	b64 := base64.StdEncoding.EncodeToString
	var b strings.Builder
	fmt.Fprintf(&b, `apiVersion: v1
kind: Namespace
metadata:
  name: %s
---
apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: %s
data:
`, namespace, secretName, namespace)
	for _, d := range data {
		fmt.Fprintf(&b, "  %s: %s\n", d.Key, b64([]byte(d.Value)))
	}
	return b.String()
}

// SecretsStoreCredential is one key/value the SaaS store's credential Secret carries. Value is a
// plaintext secret held only in memory on its way into the in-cluster Secret — it must never reach a
// rendered manifest committed to git or execution_metadata (the #640/#427 no-plaintext-secrets rule).
type SecretsStoreCredential struct {
	Key   string
	Value string
}

// EnsureSecretsStoreCredential seeds the credential Secret a pluggable SaaS ClusterSecretStore
// (Vault / OpenBao / Doppler / generic Vault-compatible / Infisical) reads via auth.secretRef.
// Idempotent — re-applying refreshes rotated credentials every deploy. Refuses an empty value for ANY
// key: the store's render gate (a credential-present Validate in DominantSecretsSaaSStore) skips the
// store when a credential is absent, so a caller reaching here always has every value. Checking each
// key rather than just the first is what keeps a two-key store (infisical) from being seeded
// half-written, which would render an authenticating store that can never authenticate.
func EnsureSecretsStoreCredential(namespace, secretName string, data []SecretsStoreCredential, stdout, stderr io.Writer) error {
	if len(data) == 0 {
		return fmt.Errorf("refusing to write %s secret store credential with no keys", secretName)
	}
	for _, d := range data {
		if d.Value == "" {
			return fmt.Errorf("refusing to write an empty %s secret store credential (key %s)", secretName, d.Key)
		}
	}
	fmt.Fprintf(stdout, "Seeding external-secrets store credential %s...\n", secretName)
	return ApplyManifest(secretsSaaSCredentialManifest(namespace, secretName, data), stdout, stderr)
}

// externalSecretsStoreMaxWait bounds how long EnsureExternalSecretsStore retries while ArgoCD
// installs the external-secrets operator (asynchronously) and its validating webhook becomes ready.
// Generous on purpose: on a fresh managed cluster the FULL chain — ArgoCD reconcile → Helm install →
// CRD registered → webhook pod scheduled + Ready — routinely runs past 10m (the old 5m mixed-file
// retry #784, and a first 10m attempt, both timed out on real EKS — #1208). The caller treats a
// timeout as NON-fatal, so this is an upper bound on the wait, not a hard requirement.
var externalSecretsStoreMaxWait = 15 * time.Minute

// externalSecretsStoreTemplate renders the per-cloud ClusterSecretStore. It carries the SAME
// per-cloud, workload-identity-gated render guards the operator's Application template used to embed —
// now separated so the store is applied on its OWN, AFTER the operator is up (see #1208). Exactly
// one branch renders (the `eq .Provider` guards are mutually exclusive); hetzner renders none.
//
// spec.conditions (#1306) scopes every store (native + cross-account -xacct) away from placed tenant
// namespaces: an ESO ClusterSecretStore with no conditions is referenceable from ANY namespace, so on
// a shared Fabric a `placement=namespace` tenant could read the Fabric owner's (foreign-account, for
// -xacct) secrets. `namespaceSelector NotIn alethia.io/placement=namespace` denies placed tenant
// namespaces (namespace_tenant.go always stamps that label, and the tenant AppProject's empty
// clusterResourceWhitelist makes it un-forgeable) while a NotIn requirement matches label-ABSENT
// namespaces — so the live dedicated path (whose customer namespaces carry no such label) is
// unchanged. This is the documented prerequisite gate for activating namespace placement.
//
// SCOPE ASSUMPTION: this denies bare `placement=namespace` tenants. vcluster tenants are isolated by
// their own API server — the vcluster's host namespace (vcluster-<env>) is Alethia-managed, carries no
// placement label (so this selector allows it), and is NOT a customer-reachable path to an
// ExternalSecret against these stores (vcluster syncs no ExternalSecret CRD to the host by default). If
// vcluster ever syncs ExternalSecret CRDs host-ward, extend this selector to also exclude vcluster host
// namespaces (deploy_vcluster.go).
const externalSecretsStoreTemplate = `
{{- if and (eq .Provider "aws") .IRSAExternalSecretsArn }}
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: secretstore-aws
spec:
  conditions:
    - namespaceSelector:
        matchExpressions:
          - key: alethia.io/placement
            operator: NotIn
            values: ["namespace"]
  provider:
    aws:
      service: SecretsManager
      region: {{ .Region }}
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-operator-sa
            namespace: external-secrets-operator
{{- end }}
{{- if and (eq .Provider "gcp") .GCPExternalSecretsSA }}
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: secretstore-gcp
spec:
  conditions:
    - namespaceSelector:
        matchExpressions:
          - key: alethia.io/placement
            operator: NotIn
            values: ["namespace"]
  provider:
    gcpsm:
      projectID: {{ .GCPProjectID }}
{{- end }}
{{- if and (eq .Provider "azure") .AzureExternalSecretsClient .AzureKeyVaultURI }}
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: secretstore-azure
spec:
  conditions:
    - namespaceSelector:
        matchExpressions:
          - key: alethia.io/placement
            operator: NotIn
            values: ["namespace"]
  provider:
    azurekv:
      authType: WorkloadIdentity
      vaultUrl: {{ .AzureKeyVaultURI }}
{{- end }}
{{- if and (eq .Provider "alibaba") .AlibabaExternalSecretsRoleArn }}
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: secretstore-alibaba
spec:
  conditions:
    - namespaceSelector:
        matchExpressions:
          - key: alethia.io/placement
            operator: NotIn
            values: ["namespace"]
  provider:
    alibaba:
      regionID: {{ .Region }}
      auth:
        rrsa:
          oidcProviderArn: {{ .AlibabaOIDCProviderArn }}
          oidcTokenFilePath: /var/run/secrets/tokens/oidc-token
          roleArn: {{ .AlibabaExternalSecretsRoleArn }}
          sessionName: external-secrets
{{- end }}
{{- /* ── Cross-account keyless secret managers (*-xacct) ──────────────────────────────────────────
       An ADDITIONAL foreign-account ClusterSecretStore, layered on the native store above (rendered as
       a SEPARATE YAML document, hence the leading '---'). Each is fail-closed: it renders only when the
       cluster's own external-secrets identity fact AND the cross-account target (from the connector
       provider_config) are BOTH present. The cross-account read is ESO-native — no in-cluster refresher.
       Named secretstore-<cloud>-xacct so workloads reference a foreign source explicitly. */}}
{{- if and (eq .Provider "aws") .IRSAExternalSecretsArn .SecretsXacctRef }}
---
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: secretstore-aws-xacct
spec:
  conditions:
    - namespaceSelector:
        matchExpressions:
          - key: alethia.io/placement
            operator: NotIn
            values: ["namespace"]
  provider:
    aws:
      service: SecretsManager
      region: {{ .SecretsXacctRegion }}
      role: {{ .SecretsXacctRef }}
{{- if .SecretsXacctExternalID }}
      externalID: {{ .SecretsXacctExternalID }}
{{- end }}
      auth:
        jwt:
          serviceAccountRef:
            name: external-secrets-operator-sa
            namespace: external-secrets-operator
{{- end }}
{{- if and (eq .Provider "gcp") .GCPExternalSecretsSA .SecretsXacctProjectID }}
---
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: secretstore-gcp-xacct
spec:
  conditions:
    - namespaceSelector:
        matchExpressions:
          - key: alethia.io/placement
            operator: NotIn
            values: ["namespace"]
  provider:
    gcpsm:
      projectID: {{ .SecretsXacctProjectID }}
{{- end }}
{{- if and (eq .Provider "azure") .AzureExternalSecretsClient .SecretsXacctRef }}
---
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: secretstore-azure-xacct
spec:
  conditions:
    - namespaceSelector:
        matchExpressions:
          - key: alethia.io/placement
            operator: NotIn
            values: ["namespace"]
  provider:
    azurekv:
      authType: WorkloadIdentity
      vaultUrl: {{ .SecretsXacctRef }}
{{- end }}
{{- /* Alibaba: ESO RRSA does a single AssumeRoleWithOIDC (no role chaining), so cross-account uses the
       TARGET account's OIDC provider ARN (trusting this cluster's ACK issuer) + target role. The Alibaba
       lane (#1265) confirms the exact ESO alibaba cross-account CRD shape via a primary-source research
       pass + a real apply. */}}
{{- if and (eq .Provider "alibaba") .AlibabaExternalSecretsRoleArn .SecretsXacctRef .SecretsXacctOIDCProviderRef }}
---
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: secretstore-alibaba-xacct
spec:
  conditions:
    - namespaceSelector:
        matchExpressions:
          - key: alethia.io/placement
            operator: NotIn
            values: ["namespace"]
  provider:
    alibaba:
      regionID: {{ .SecretsXacctRegion }}
      auth:
        rrsa:
          oidcProviderArn: {{ .SecretsXacctOIDCProviderRef }}
          oidcTokenFilePath: /var/run/secrets/tokens/oidc-token
          roleArn: {{ .SecretsXacctRef }}
          sessionName: external-secrets-xacct
{{- end }}
{{- /* ── Pluggable SaaS secret store (Vault / OpenBao / Doppler / generic / Infisical) ─────────────────
       The credential-based external store the project selected via the secrets connector, read
       IN-CLUSTER by ESO with STATIC credentials seeded into an in-cluster Secret (auth.secretRef → the
       CredSecret the runner seeds; the credentials never ride these facts). Rendered as a SEPARATE
       document (leading '---') and CLOUD-AGNOSTIC — it renders on ANY provider, incl. Hetzner (no
       native store). Kind is the ESO provider kind: "vault" (vault/generic), "doppler" or "infisical".
       Keys are looked up by ROLE (CredKey "token" / "clientId" / "clientSecret") rather than by
       position, so a provider's auth arity is its own business.
       1Password remains a documented runtime-read exclusion — ESO's onepassword provider is
       Connect-server-only, which a bare Service-Account token cannot satisfy — so no branch renders
       for it (its write/provision path is unaffected).
       NOTE: unlike the per-cloud stores above, these SaaS branches render NO spec.conditions. */}}
{{- if .SecretsSaaS }}
{{- if eq .SecretsSaaS.Kind "vault" }}
---
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: {{ .SecretsSaaS.StoreName }}
spec:
  provider:
    vault:
      server: {{ printf "%q" .SecretsSaaS.Server }}
      path: {{ printf "%q" .SecretsSaaS.Path }}
      version: {{ .SecretsSaaS.Version }}
      auth:
        tokenSecretRef:
          name: {{ .SecretsSaaS.CredSecret }}
          key: {{ .SecretsSaaS.CredKey "token" }}
          namespace: {{ .SecretsSaaS.Namespace }}
{{- end }}
{{- if eq .SecretsSaaS.Kind "doppler" }}
---
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: {{ .SecretsSaaS.StoreName }}
spec:
  provider:
    doppler:
{{- if .SecretsSaaS.Project }}
      project: {{ printf "%q" .SecretsSaaS.Project }}
{{- end }}
{{- if .SecretsSaaS.Config }}
      config: {{ printf "%q" .SecretsSaaS.Config }}
{{- end }}
      auth:
        secretRef:
          dopplerToken:
            name: {{ .SecretsSaaS.CredSecret }}
            key: {{ .SecretsSaaS.CredKey "token" }}
            namespace: {{ .SecretsSaaS.Namespace }}
{{- end }}
{{- if eq .SecretsSaaS.Kind "infisical" }}
---
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: {{ .SecretsSaaS.StoreName }}
spec:
  provider:
    infisical:
      auth:
        universalAuthCredentials:
          clientId:
            name: {{ .SecretsSaaS.CredSecret }}
            key: {{ .SecretsSaaS.CredKey "clientId" }}
            namespace: {{ .SecretsSaaS.Namespace }}
          clientSecret:
            name: {{ .SecretsSaaS.CredSecret }}
            key: {{ .SecretsSaaS.CredKey "clientSecret" }}
            namespace: {{ .SecretsSaaS.Namespace }}
      secretsScope:
        projectSlug: {{ printf "%q" .SecretsSaaS.ProjectSlug }}
        environmentSlug: {{ printf "%q" .SecretsSaaS.EnvironmentSlug }}
        secretsPath: {{ printf "%q" .SecretsSaaS.SecretsPath }}
      hostAPI: {{ printf "%q" .SecretsSaaS.HostAPI }}
{{- end }}
{{- end }}
`

var externalSecretsStoreTmpl = template.Must(template.New("external-secrets-store").Parse(externalSecretsStoreTemplate))

// externalSecretsStoreManifest renders the per-cloud ClusterSecretStore for the given facts, or ""
// when the provider/identity fact means there is no cloud secret store (e.g. hetzner).
func externalSecretsStoreManifest(facts *InfraFacts) (string, error) {
	var buf bytes.Buffer
	if err := externalSecretsStoreTmpl.Execute(&buf, facts); err != nil {
		return "", fmt.Errorf("render ClusterSecretStore: %w", err)
	}
	return strings.TrimSpace(buf.String()), nil
}

// EnsureExternalSecretsStore applies the per-cloud ClusterSecretStore AFTER ApplyApplications has
// applied the external-secrets operator's ArgoCD Application. The store is a custom resource whose
// kind + validating webhook the operator provides, so on a fresh cluster it races the operator in
// two stages ("no matches for kind", then "no endpoints available" for the webhook). Applying it
// here — on its own, server-side, after waiting for its CRD to become Established (#2652) and then
// retrying ONLY the transient operator-not-ready markers until the operator (installed
// asynchronously by ArgoCD) is up — fixes the #1208 bootstrap deadlock: mixing
// the store into the operator's client-side apply file could poison that file so the operator never
// installed and the retry could never converge. No-op when no store renders. Returns a timeout error
// after externalSecretsStoreMaxWait, which the caller treats as NON-fatal (the store is idempotent
// and reconciles on the next deploy — see deploy.go), so a slow operator webhook on a fresh cluster
// never fails an otherwise-healthy deploy.
func EnsureExternalSecretsStore(facts *InfraFacts, stdout, stderr io.Writer) error {
	manifest, err := externalSecretsStoreManifest(facts)
	if err != nil {
		return err
	}
	if manifest == "" {
		return nil
	}
	fmt.Fprintln(stdout, "Ensuring external-secrets ClusterSecretStore (waiting for the operator's CRD + webhook)...")
	return applyStoreAwaitingOperator(manifest, stdout, stderr)
}

// clusterSecretStoreCRD is the CRD whose schema EVERY ClusterSecretStore this package applies is
// validated against — the per-cloud stores above and the in-cluster Vault store in vault.go alike.
// The external-secrets operator installs it ASYNCHRONOUSLY (ArgoCD sync → Helm install → CRD
// registered), which is the race #2652 recorded as `no matches for kind "ClusterSecretStore"`.
//
// It is `clustersecretstores`, not `secretstores`: the namespaced SecretStore is a different CRD and
// waiting on it would report Established while the cluster-scoped kind these manifests use is still
// unknown to the API server — a wait that passes for the wrong reason.
const clusterSecretStoreCRD = "clustersecretstores.external-secrets.io"

// clusterSecretStoreCRDPollInterval is how long awaitClusterSecretStoreCRD sleeps between polls of a
// CRD that has not appeared yet. A var only so the tests can prove the retry ACTUALLY retries without
// sleeping fifteen seconds to do it — a loop whose repeat is never executed in a test is a loop no
// test covers.
var clusterSecretStoreCRDPollInterval = 15 * time.Second

// isCRDPendingEstablishment reports whether a `kubectl wait --for=condition=established` failure is
// the transient "the operator has not finished installing this CRD yet" race, which is worth waiting
// out, as opposed to a condition no amount of waiting fixes.
//
// The two retryable shapes are the two stages of the same race: the CRD object does not exist at all
// (kubectl wait on a named resource fails IMMEDIATELY with `Error from server (NotFound)` — it does
// not block waiting for the object to appear, which is exactly why an unconditional single wait would
// be useless on a fresh cluster), and the CRD exists but has not been Established inside
// crdEstablishTimeout.
//
// Everything else is deliberately NOT matched and therefore NOT retried here: `(Forbidden)` from an
// RBAC refusal, `Unable to connect to the server`, a `kubectl` that is not on PATH. Those say the
// question could not be ASKED, and burning the whole store budget re-asking it would only delay the
// apply that reports the real failure. `(NotFound)` carries kubectl's server-error parenthesis on
// purpose: a bare "not found" would also match `kubectl: command not found` and turn a missing binary
// into a fifteen-minute wait.
func isCRDPendingEstablishment(kubectlOutput string) bool {
	for _, marker := range []string{
		"(NotFound)",                          // the operator has not created the CRD yet
		"no matching resources found",         // ditto, as older kubectl phrases it
		"timed out waiting for the condition", // it exists, but is not Established yet
	} {
		if strings.Contains(kubectlOutput, marker) {
			return true
		}
	}
	return false
}

// awaitClusterSecretStoreCRD waits for clusterSecretStoreCRD to report Established and reports
// whether it CONFIRMED that. It never returns an error and never fails a deploy on its own.
//
// Three outcomes, and they are three, not two:
//
//   - Established — returns true. The apply that follows is then deterministic rather than racing
//     the operator, which is the whole point of #2652: the retry converged, but only by absorbing an
//     ordering bug it could not report.
//   - Not Established yet (CRD absent, or present and unestablished) — retried on the SHARED
//     deadline below until it is, or until that deadline expires, then returns false.
//   - The question could not be asked at all (cluster unreachable, RBAC refusal, no kubectl) —
//     returns false IMMEDIATELY, having written the reason to stderr.
//
// False is not "the CRD is ready" and is not "the deploy failed". It means UNCONFIRMED, and the
// caller's answer to unconfirmed is to go on and apply, exactly as it did before this wait existed:
// the retry loop is still there and still absorbs a CRD that is mid-registration. So a slow establish
// stays recoverable — it cannot become a hard failure here, because nothing here returns one — while
// a cluster that cannot answer is stated in the log instead of being silently read as readiness.
//
// The deadline is the CALLER's, shared with the apply loop rather than added to it: patience is
// bounded by externalSecretsStoreMaxWait in total, so this wait cannot double the deploy's worst case.
func awaitClusterSecretStoreCRD(deadline time.Time, stdout, stderr io.Writer) bool {
	fmt.Fprintf(stdout, "Waiting for the %s CRD to become Established...\n", clusterSecretStoreCRD)
	for attempt := 1; ; attempt++ {
		// Both streams are captured: kubectl writes `Error from server (NotFound)` to stderr, but
		// classifying on one stream is how a diagnostic ends up reading a failure it never saw.
		var captured bytes.Buffer
		err := waitForCRDEstablished(clusterSecretStoreCRD,
			io.MultiWriter(stdout, &captured), io.MultiWriter(stderr, &captured))
		if err == nil {
			fmt.Fprintf(stdout, "  ✓ %s is Established.\n", clusterSecretStoreCRD)
			return true
		}
		if !isCRDPendingEstablishment(captured.String()) || !time.Now().Before(deadline) {
			fmt.Fprintf(stderr, "Warning: could not confirm the %s CRD is Established (%v) — "+
				"NOT treating that as ready. Applying the store anyway; its retry still absorbs a CRD "+
				"that is mid-registration, and the apply's own outcome decides this step.\n",
				clusterSecretStoreCRD, err)
			return false
		}
		fmt.Fprintf(stdout, "  %s isn't Established yet (attempt %d) — waiting %s for ArgoCD to "+
			"finish installing the external-secrets operator...\n",
			clusterSecretStoreCRD, attempt, clusterSecretStoreCRDPollInterval)
		time.Sleep(clusterSecretStoreCRDPollInterval)
	}
}

// applyStoreAwaitingOperator waits for the ClusterSecretStore CRD to be Established, then applies a
// ClusterSecretStore manifest, retrying ONLY the transient "the external-secrets operator is not up
// yet" markers until it is. Shared by the per-cloud stores above and by the in-cluster Vault store
// (vault.go), which faces exactly the same race and must not grow a second, subtly-different copy of
// this loop — so the CRD wait added for #2652 covers BOTH callers by construction, rather than by two
// call sites that can drift apart.
//
// The wait makes the common path deterministic; the retry is KEPT as the backstop for what the wait
// cannot confirm (a CRD that establishes late, and the second stage of the race — the validating
// webhook having no ready endpoints, which no CRD condition reports).
//
// The success line names the attempt count and whether the CRD was confirmed first, because #2652's
// point 3 is that a green run currently carries no evidence of any of this: a retry that converges
// prints the same one line as an apply that never raced, so "we have never seen it fail" was not
// evidence it worked. `attempt 1, CRD confirmed` and `attempt 9, unconfirmed` are now different
// sentences in the job log.
func applyStoreAwaitingOperator(manifest string, stdout, stderr io.Writer) error {
	deadline := time.Now().Add(externalSecretsStoreMaxWait)
	crdEstablished := awaitClusterSecretStoreCRD(deadline, stdout, stderr)
	for attempt := 1; ; attempt++ {
		var captured bytes.Buffer
		applyErr := applyManifestServerSide(manifest, stdout, io.MultiWriter(stderr, &captured))
		if applyErr == nil {
			if crdEstablished {
				fmt.Fprintf(stdout, "ClusterSecretStore applied on attempt %d, after %s was confirmed Established.\n",
					attempt, clusterSecretStoreCRD)
			} else {
				fmt.Fprintf(stdout, "ClusterSecretStore applied on attempt %d, WITHOUT %s having been confirmed "+
					"Established first — the apply retry absorbed the race.\n", attempt, clusterSecretStoreCRD)
			}
			return nil
		}
		if !isOperatorNotReady(captured.String()) || time.Now().After(deadline) {
			if time.Now().After(deadline) {
				// The operator didn't become ready within the window — dump its pods so a recurrence
				// is diagnosable (slow install vs a stuck/unschedulable/crash-looping webhook pod).
				_ = utils.ExecuteCommand("kubectl get pods -n external-secrets-operator -o wide", ".", nil, stderr, stderr)
			}
			return fmt.Errorf("apply ClusterSecretStore: %w", applyErr)
		}
		fmt.Fprintf(stdout, "  external-secrets operator (CRD/webhook) isn't ready yet (attempt %d) — "+
			"waiting 15s for ArgoCD to finish installing it...\n", attempt)
		time.Sleep(15 * time.Second)
	}
}

// CleanupSkippedInfraServices removes infra-service objects that earlier deploys applied but
// the current facts no longer render. Infra services are plain `kubectl apply` (no label/prune
// scheme yet), so an app that stops rendering would otherwise be ORPHANED on the cluster —
// notably the pre-parity external-dns that shipped with `provider: aws` on alibaba/hetzner
// (crash-looping) and the unguarded AWS ClusterSecretStore applied on every cloud. Deletes are
// best-effort + idempotent (--ignore-not-found); deleting the Application cascades removal of
// the controller through its resources-finalizer.
func CleanupSkippedInfraServices(facts *InfraFacts, stdout, stderr io.Writer) {
	if !facts.DNSEnabled || facts.DomainName == "" || facts.DNSProvider() == "" {
		cmd := "kubectl delete application external-dns -n argocd --ignore-not-found --timeout=60s"
		fmt.Fprintln(stdout, "external-dns is not rendered for this configuration — removing any stale install...")
		if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: could not remove stale external-dns application: %v\n", err)
		}
	}
	// The cert-manager ClusterIssuer, when cert-manager no longer renders for this deploy (the
	// switch was turned off, the domain changed, an identity output disappeared). An issuer left
	// behind is not inert: an Ingress still referencing it keeps requesting certificates that can
	// never be solved, so it must go — and it is cheap and idempotent to recreate.
	//
	// The cert-manager APPLICATION is deliberately NOT reaped alongside it, unlike external-dns
	// above. Deleting it cascades through the resources-finalizer to the cert-manager CRDs, and
	// deleting those deletes every Certificate in the cluster — including ones owned by workloads
	// that have nothing to do with this switch. Re-issuing them all then meets Let's Encrypt's
	// duplicate-certificate rate limit (5 per week), which no retry recovers from. An idle
	// controller is the strictly smaller harm, and certManagerDecision still records the skip.
	// The ISSUER predicate, not the controller one: cert-manager may now be installed with no
	// issuer at all (to inject an operator's webhook CA), and on that deploy the ClusterIssuer
	// SHOULD be reaped — there is none to keep. Reading the controller gate here would leave a
	// stale issuer standing on exactly the deploys that never create one.
	if !facts.CertManagerIssuerEnabled() {
		cmd := fmt.Sprintf("kubectl delete clusterissuer %s --ignore-not-found --timeout=60s", CertManagerIssuerName)
		if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: could not remove stale cert-manager ClusterIssuer %s: %v\n", CertManagerIssuerName, err)
		}
	}
	esoStores := clusterSecretStoreRenderSet(facts)
	for name, renders := range esoStores {
		if renders {
			continue
		}
		cmd := fmt.Sprintf("kubectl delete clustersecretstore %s --ignore-not-found --timeout=60s", name)
		if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: could not remove stale ClusterSecretStore %s: %v\n", name, err)
		}
	}
}

// ApplyManifest kubectl-applies a single in-memory manifest (e.g. a hardened BYO AppProject) via
// a temp file, so callers with a rendered string don't need to stage a directory.
func ApplyManifest(manifest string, stdout, stderr io.Writer) error {
	tmpFile, err := os.CreateTemp("", "argocd-manifest-*.yaml")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	defer os.Remove(tmpFile.Name())
	if _, err := tmpFile.WriteString(manifest); err != nil {
		tmpFile.Close()
		return fmt.Errorf("failed to write manifest: %w", err)
	}
	tmpFile.Close()
	cmd := fmt.Sprintf("kubectl apply -f %s", tmpFile.Name())
	if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("kubectl apply failed: %w", err)
	}
	return nil
}

// ConfigureRepoCredentials registers the customer's apps-destination repo with ArgoCD under the
// shared "repo-apps" Secret. BYO chart repos use ConfigureRepoCredentialsNamed with a per-repo
// Secret name so they never collide with — or read — the apps repo's credential.
func ConfigureRepoCredentials(repoURL, token string, stdout, stderr io.Writer) error {
	return ConfigureRepoCredentialsNamed(repoURL, token, "repo-apps", stdout, stderr)
}

// ConfigureRepoCredentialsNamed applies an ArgoCD repository Secret (name `secretName`) granting
// token access to `repoURL`. Parametrizing the name lets each repo (apps destination + every BYO
// chart repo) own an isolated credential — a shared name would let one tenant's Application read
// another repo's token.
func ConfigureRepoCredentialsNamed(repoURL, token, secretName string, stdout, stderr io.Writer) error {
	fmt.Fprintf(stdout, "Configuring ArgoCD repository credentials for %s (secret %s)\n", repoURL, secretName)

	b64 := base64.StdEncoding.EncodeToString
	manifest := fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
data:
  type: %s
  url: %s
  username: %s
  password: %s
`, secretName, b64([]byte("git")), b64([]byte(repoURL)), b64([]byte("x-access-token")), b64([]byte(token)))

	tmpFile, err := os.CreateTemp("", "argocd-repo-*.yaml")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.WriteString(manifest); err != nil {
		tmpFile.Close()
		return fmt.Errorf("failed to write secret manifest: %w", err)
	}
	tmpFile.Close()

	cmd := fmt.Sprintf("kubectl apply -f %s", tmpFile.Name())
	if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("failed to apply repo credentials: %w", err)
	}

	fmt.Fprintln(stdout, "ArgoCD repository credentials configured.")
	return nil
}

// clusterSecretStoreRenderSet reports, for every ClusterSecretStore name this platform can render,
// whether THIS deploy renders it. Everything false is reaped.
//
// Extracted from CleanupSkippedInfraServices so the set is testable without a cluster: the map is
// the whole correctness of the reaper, and it has drifted twice already — an Infisical store was
// never reaped (#2038) because the list was hand-written, and adding a store to a family without
// adding it here leaves it orphaned in a permanently-broken state.
func clusterSecretStoreRenderSet(facts *InfraFacts) map[string]bool {
	// Per-cloud ClusterSecretStores: each gate must mirror external-secrets-operator.yaml's
	// render conditions — a store whose identity fact disappeared (or that belongs to another
	// cloud) stops rendering and would otherwise be orphaned in a permanently-broken state.
	esoStores := map[string]bool{
		PerCloudSecretStoreName("aws"):     facts.Provider == "aws" && facts.IRSAExternalSecretsArn != "",
		PerCloudSecretStoreName("gcp"):     facts.Provider == "gcp" && facts.GCPExternalSecretsSA != "",
		PerCloudSecretStoreName("azure"):   facts.Provider == "azure" && facts.AzureExternalSecretsClient != "" && facts.AzureKeyVaultURI != "",
		PerCloudSecretStoreName("alibaba"): facts.Provider == "alibaba" && facts.AlibabaExternalSecretsRoleArn != "",
		// The in-cluster Vault store (#2432). It belongs to THIS family, not the pluggable-SaaS one:
		// it is Hetzner's secret store, implemented in-cluster because the cloud sells none. Naming
		// it secretstore-vault would have put it in AllSaaSStoreNames()' reap set and had it deleted
		// on every deploy without a vault CONNECTOR selected — see HetznerSecretStoreName.
		PerCloudSecretStoreName("hetzner"): facts.Provider == "hetzner" && facts.HetznerInClusterVault,
	}
	// Pluggable SaaS stores (cloud-agnostic): exactly one can render per deploy, so enumerate every
	// name the template knows and mark all but the current one for reaping — switching the connector
	// (vault → doppler) or de-selecting it then reaps the stale store instead of orphaning it in a
	// permanently-broken state.
	//
	// DERIVED, not re-listed. The hand-written version here named vault, doppler and generic and was
	// missing secretstore-infisical, so an Infisical store was never reaped (#2038) — the same drift
	// the *-xacct half below was already fixed for. It is easy to miss because the template never
	// spells these names literally: it renders `{{ .SecretsSaaS.StoreName }}`, so grepping the
	// template for a name finds nothing to compare this list against.
	currentSaaS := ""
	if facts.SecretsSaaS != nil {
		currentSaaS = facts.SecretsSaaS.StoreName
	}
	for _, name := range categories.AllSaaSStoreNames() {
		esoStores[name] = name == currentSaaS
	}
	// Cross-account (*-xacct) stores: exactly one can render per deploy (the store is dominant), so
	// enumerate every name the template knows and mark all but the current one for reaping. Reading
	// the render gate itself — rather than re-listing the per-cloud conditions here, as this map did
	// until they drifted — means a new *-xacct lane cannot be added to the template and silently
	// forgotten by the cleanup.
	currentXacct, _ := facts.XacctSecretStore()
	for _, name := range categories.AllXacctStoreNames() {
		esoStores[name] = name == currentXacct
	}
	return esoStores
}
