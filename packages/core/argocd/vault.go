// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// The in-cluster Vault that delivers the `secret` kind on Hetzner (#2432).
//
// Hetzner sells no cloud secret store, so a canvas `secret` node cannot become a Secrets Manager /
// Secret Manager / Key Vault / KMS entry. It becomes a KV v2 entry in a Vault this platform
// installs, read through an ESO ClusterSecretStore exactly as the other four clouds are.
//
// This file is the runner half: it applies a one-shot Job that initialises, unseals and seeds Vault
// from INSIDE the cluster (`alethia vault-bootstrap`), because Vault answers only on the cluster
// network — and because that keeps the unseal key and the ESO token out of the runner process
// entirely. Same rail as the Harbor bootstrap in harbor.go (#2431), and applied with ApplyManifest
// rather than committed to the apps repo, for the reason #2435 records.
//
// ── The custody statement, kept next to the code that creates the situation ────────────────────
//
// The seal is Shamir and the unseal key lives in a Kubernetes Secret in this cluster, because no
// KMS exists to seal against. So the key sits in the same etcd that would otherwise hold the value:
// against a cluster-admin, an etcd backup, a volume snapshot, or Hetzner with disk access this buys
// NOTHING over a plain Secret. What it does buy — an audit log of every read, leases, revocation,
// rotation, and one uniform ESO read path with the other four clouds — is real, and is the reason
// the maintainer chose to build it. Anything this repo says publicly must say that, not more.

const (
	// hetznerVaultNamespace is where the Vault release and its state Secret live.
	//
	// NOT `vault`: that is the MARKETPLACE add-on's namespace, and the marketplace add-on is a Vault
	// the CUSTOMER runs. This one is the platform's, and Alethia holds its unseal key — a project may
	// reasonably want both, so they get separate namespaces as well as separate release ids.
	hetznerVaultNamespace = "secrets"
	// hetznerVaultReleaseHost is the in-cluster address the chart's Service answers on.
	//
	// ⚠️ DERIVED, NOT CHOSEN. The vault chart names its Service after the Helm release, ArgoCD's
	// release name is the Application name, and that is `addon-` + the console's install-spec id
	// (HETZNER_VAULT_ADDON_ID in apps/console/lib/cloud-providers/hetzner-services.ts). So this
	// string is one fact spelled in two languages, and a drift does not error — it resolves nowhere,
	// and the only symptom is a ClusterSecretStore that is never Valid. TestHetznerVaultHostAgrees
	// WithTheGeneratedFixture reads it back out of the fixture the real console mapper produced.
	//
	// It works while Vault is SEALED — which the bootstrap Job depends on absolutely — only because
	// the chart's Service sets `publishNotReadyAddresses: true`. A sealed Vault fails its readiness
	// probe (`vault status` exits 2), so an ordinary Service would have no endpoints and the Job
	// could never reach the Vault it exists to unseal.
	hetznerVaultReleaseHost = "addon-secrets-vault.secrets.svc.cluster.local:8200"
	// hetznerVaultStateSecret holds the unseal key and the ESO token.
	hetznerVaultStateSecret = "alethia-vault-state"
	// hetznerVaultBootstrapSA is the ServiceAccount the bootstrap Job runs as.
	hetznerVaultBootstrapSA = "alethia-vault-bootstrap"
	// hetznerVaultBootstrapJob is the one-shot Job.
	hetznerVaultBootstrapJob = "alethia-vault-bootstrap"

	// HetznerSecretStoreName is the ClusterSecretStore for the in-cluster Vault.
	//
	// ⚠️ IT IS DELIBERATELY NOT `secretstore-vault`. That name belongs to the PLUGGABLE SaaS family —
	// a Vault the CUSTOMER supplies — and CleanupSkippedInfraServices reaps every name in
	// categories.AllSaaSStoreNames() except the currently-selected connector's. An in-cluster store
	// under that name would be `kubectl delete`d on every deploy where no vault CONNECTOR is chosen,
	// and ESO would simply stop resolving with nothing in the job log to explain it.
	//
	// `secretstore-hetzner` joins the PER-CLOUD family instead (secretstore-aws / -gcp / -azure /
	// -alibaba), which is what it actually is: this cloud's secret store, implemented in-cluster
	// because the cloud sells none. That family is reaped by the esoStores map, which gates on the
	// per-cloud identity fact — so it is added there too, gated on the Vault actually being wired.
	HetznerSecretStoreName = "secretstore-hetzner"
	// HetznerSecretStoreCredSecret is the Secret the store's auth.secretRef resolves.
	HetznerSecretStoreCredSecret = "secretstore-hetzner-token"
	// hetznerSecretStoreCredKey is the data key inside it.
	hetznerSecretStoreCredKey = "token"
	// hetznerVaultKVMount mirrors the mount the bootstrap enables. The two must agree or the store
	// authenticates and then resolves nothing.
	hetznerVaultKVMount = "secret"
)

// PerCloudSecretStoreName is the ClusterSecretStore through which a workload reads THIS cloud's
// secret store — `secretstore-aws` / `-gcp` / `-azure` / `-alibaba`, and `secretstore-hetzner` for
// the in-cluster Vault that stands in where the cloud sells none.
//
// It exists so the name has ONE source. The reaper's render set, the max-config proof grid and the
// template all name these stores, and the template is already pinned to them by install_test.go —
// but a fourth hand-written copy is how #2038 lost secretstore-infisical from the reap set. An
// empty return means the provider has no per-cloud store, which is not the same as "the store is
// named after the provider" and must not be treated as one.
func PerCloudSecretStoreName(provider string) string {
	switch provider {
	case "aws", "gcp", "azure", "alibaba":
		return "secretstore-" + provider
	case "hetzner":
		return HetznerSecretStoreName
	default:
		return ""
	}
}

// vaultCarriedSecretOffers maps a cloud to the in-cluster component that honours the `secret` kind's
// switches there. Hetzner only, and that is the whole point: every other cloud creates a real secret
// in its cloud store, so `generate` / `length` / `special_chars` ride tfvars (aws_provider.go
// buildSecrets) and the carrier rule can see them. Hetzner sells no such store, so the switches are
// honoured by the bootstrap Job against Vault's API, which writes no tfvar at all.
//
// The offer-parity guard RE-READS this map to validate the carried_in_cluster entries in
// infra/offer-exclusions.yaml, so dropping a cloud here makes those entries go stale rather than
// leaving a silent claim behind. It must stay a top-level map[string]… literal for that to work —
// and it is load-bearing, not decorative: HetznerVaultFor consults it, so a cloud removed from here
// stops deriving a Vault rather than quietly keeping one with a stale exclusion beside it.
var vaultCarriedSecretOffers = map[string]string{
	"hetzner": "vault",
}

// HetznerVaultSecret is one canvas `secret` node, in the form the bootstrap needs to seed it.
//
// It carries the SAME three fields the four managed clouds carry into their own secret stores
// (aws_provider.go buildSecrets: length + special when generated, manual otherwise). Carrying only
// the name — which this type did in its first draft — is precisely the failure the offer-parity
// guard exists to catch: the canvas offers `generate`, `length` and `special_chars` on every cloud,
// so a Hetzner deploy that ignored them would present three switches that change nothing.
type HetznerVaultSecret struct {
	// Name is the KV v2 path under the mount.
	Name string
	// Generate asks the platform to mint the value. False is MANUAL: no value is written at all, so
	// the operator supplies one — the same semantics as `manual: true` on the managed clouds, where
	// the secret resource exists with no version.
	Generate bool
	// Length is the generated value's length. Zero means the bootstrap's default.
	Length int
	// SpecialChars widens the generated alphabet beyond alphanumerics.
	SpecialChars bool
}

// HetznerVault describes the in-cluster Vault one Hetzner deploy needs.
type HetznerVault struct {
	// Secrets are the canvas `secret` nodes to seed.
	Secrets []HetznerVaultSecret
}

// HetznerVaultFor derives the in-cluster Vault a deploy must bootstrap, or nil when there is none.
//
// Hetzner only, and only when the project actually declares a NATIVELY-provisioned secret:
//
//   - installing a Vault nobody asked for would cost two volumes and an audit surface for nothing;
//   - a secret routed to a pluggable connector (doppler, infisical, a customer's own Vault) is READ
//     from that store through its own ClusterSecretStore and must not ALSO be minted here. Seeding
//     it would create a second, divergent value under the same name — the kind of split-brain that
//     surfaces as an application authenticating with the wrong credential. This mirrors
//     buildSecrets' `secretProvisionedNatively` skip on every managed cloud.
func HetznerVaultFor(vc *types.ProjectConfig) *HetznerVault {
	if vc == nil {
		return nil
	}
	if _, carried := vaultCarriedSecretOffers[string(vc.Provider)]; !carried {
		return nil
	}
	secrets := make([]HetznerVaultSecret, 0, len(vc.Secrets))
	for _, s := range vc.Secrets {
		if s.Provider != "" && s.Provider != "native" {
			continue
		}
		if s.Name == "" || !k8sNameRe.MatchString(s.Name) {
			continue
		}
		secrets = append(secrets, HetznerVaultSecret{
			Name: s.Name, Generate: s.Generate, Length: s.Length, SpecialChars: s.SpecialChars,
		})
	}
	if len(secrets) == 0 {
		return nil
	}
	return &HetznerVault{Secrets: secrets}
}

// hetznerVaultSecretsArg encodes the secret specs into the Job's single `--secrets` argument.
//
// The grammar is strict and total, because the runner parses it fail-closed: `<name>:manual`, or
// `<name>:<length>:<0|1>` for a generated one. Only NAMES and SIZES travel this way — never a value.
// argv is world-readable through /proc, so a generated secret is minted inside the pod and written
// straight to Vault; nothing that could be a credential appears here.
func hetznerVaultSecretsArg(secrets []HetznerVaultSecret) string {
	parts := make([]string, 0, len(secrets))
	for _, s := range secrets {
		if !s.Generate {
			parts = append(parts, s.Name+":manual")
			continue
		}
		special := "0"
		if s.SpecialChars {
			special = "1"
		}
		parts = append(parts, fmt.Sprintf("%s:%d:%s", s.Name, s.Length, special))
	}
	return strings.Join(parts, ",")
}

// EnsureHetznerVault applies the bootstrap Job for an in-cluster Vault.
//
// Applied with ApplyManifest, never committed to the apps repo: the apps Application runs
// `automated: {prune: true, selfHeal: true}` with no `ignoreDifferences`, so a Secret declared there
// is healed back to its declared value — the defect #2435 records on the registry path.
func EnsureHetznerVault(ctx context.Context, v *HetznerVault, runnerImage string, stdout, stderr io.Writer) error {
	if v == nil {
		return nil
	}
	job, err := HetznerVaultBootstrapJobManifest(*v, runnerImage)
	if err != nil {
		return err
	}
	// Delete first: re-applying a completed Job fails on immutable fields, so without this a
	// re-deploy silently never re-runs the unseal step — and a restarted Vault would stay sealed.
	_ = utils.ExecuteCommand(
		fmt.Sprintf("kubectl delete job %s -n %s --ignore-not-found", hetznerVaultBootstrapJob, hetznerVaultNamespace),
		".", nil, io.Discard, io.Discard,
	)
	fmt.Fprintf(stdout, "Applying in-cluster Vault bootstrap for %d secret(s)...\n", len(v.Secrets))
	return ApplyManifest(job, stdout, stderr)
}

// HetznerVaultBootstrapJobManifest renders the Job, its ServiceAccount, and the RBAC it needs.
//
// The Role is namespace-scoped and named: `get` + `patch` + `create` on the state Secret in the
// vault namespace, and the same on the ESO credential Secret in the operator's namespace. `create`
// cannot be scoped by resourceNames, which is why each Role is confined to ONE namespace and the two
// namespaces are separate Roles rather than one wide binding.
//
// Honest scope note: on a dedicated cluster the apps-repo writer already holds broad authority
// through ArgoCD, so this is defence-in-depth, not a containment boundary against a hostile tenant.
func HetznerVaultBootstrapJobManifest(v HetznerVault, runnerImage string) (string, error) {
	if runnerImage == "" {
		return "", fmt.Errorf("refusing to render a Vault bootstrap Job with no runner image")
	}
	for _, sec := range v.Secrets {
		if !k8sNameRe.MatchString(sec.Name) {
			return "", fmt.Errorf("refusing to render a Vault bootstrap Job for unsafe secret name %q", sec.Name)
		}
		if sec.Length < 0 {
			return "", fmt.Errorf("refusing to render a Vault bootstrap Job with a negative length for %q", sec.Name)
		}
	}
	if len(v.Secrets) == 0 {
		return "", fmt.Errorf("refusing to render a Vault bootstrap Job with no secrets to seed")
	}
	return fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: %[1]s
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: %[2]s
  namespace: %[1]s
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: %[2]s
  namespace: %[1]s
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    # "list" is what the state READ needs, not a convenience. vault_state.go reads the state
    # Secret with a field selector (kubectl get secret --field-selector metadata.name=NAME), and a
    # field selector is a LIST against the collection, never a GET of one object. Without this verb
    # every read is Forbidden -- and since an unreadable state is now fatal by design,
    # vaultBootstrap returns before waitForVault on EVERY cluster, through all four backoffLimit
    # attempts.
    #
    # The read is a list on purpose: a list has no NotFound path, so an absent Secret is a 200
    # carrying an empty items array -- the API server stating it looked and found nothing -- while
    # every fault exits non-zero. The --ignore-not-found flag on a GET cannot do that: it suppresses
    # ANY 404, so a proxy or a mis-pathed endpoint answering 404 exits 0 with empty output and reads
    # as "no unseal key", which turns the data-loss guard off.
    #
    # The added privilege is ENUMERATION only. These rules carry no resourceNames, so "get" already
    # permits reading any Secret in this namespace by name; "list" adds discovering names.
    verbs: ["get", "list", "create", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: %[2]s
  namespace: %[1]s
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: %[2]s
subjects:
  - kind: ServiceAccount
    name: %[2]s
    namespace: %[1]s
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: %[2]s
  namespace: %[3]s
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    # "list" is what the state READ needs, not a convenience. vault_state.go reads the state
    # Secret with a field selector (kubectl get secret --field-selector metadata.name=NAME), and a
    # field selector is a LIST against the collection, never a GET of one object. Without this verb
    # every read is Forbidden -- and since an unreadable state is now fatal by design,
    # vaultBootstrap returns before waitForVault on EVERY cluster, through all four backoffLimit
    # attempts.
    #
    # The read is a list on purpose: a list has no NotFound path, so an absent Secret is a 200
    # carrying an empty items array -- the API server stating it looked and found nothing -- while
    # every fault exits non-zero. The --ignore-not-found flag on a GET cannot do that: it suppresses
    # ANY 404, so a proxy or a mis-pathed endpoint answering 404 exits 0 with empty output and reads
    # as "no unseal key", which turns the data-loss guard off.
    #
    # The added privilege is ENUMERATION only. These rules carry no resourceNames, so "get" already
    # permits reading any Secret in this namespace by name; "list" adds discovering names.
    verbs: ["get", "list", "create", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: %[2]s
  namespace: %[3]s
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: %[2]s
subjects:
  - kind: ServiceAccount
    name: %[2]s
    namespace: %[1]s
---
apiVersion: batch/v1
kind: Job
metadata:
  name: %[4]s
  namespace: %[1]s
spec:
  backoffLimit: 4
  ttlSecondsAfterFinished: 600
  template:
    spec:
      serviceAccountName: %[2]s
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: vault-bootstrap
          image: %[5]s
          args:
            - vault-bootstrap
            - --api-base=http://%[6]s
            - --state-secret=%[7]s
            - --state-namespace=%[1]s
            - --secrets=%[8]s
            - --eso-secret=%[9]s
            - --eso-namespace=%[3]s
            - --eso-key=%[10]s
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: tmp
          emptyDir: {}
`,
		hetznerVaultNamespace,             // 1
		hetznerVaultBootstrapSA,           // 2
		secretsSaaSNamespaceForStore,      // 3
		hetznerVaultBootstrapJob,          // 4
		runnerImage,                       // 5
		hetznerVaultReleaseHost,           // 6
		hetznerVaultStateSecret,           // 7
		hetznerVaultSecretsArg(v.Secrets), // 8
		HetznerSecretStoreCredSecret,      // 9
		hetznerSecretStoreCredKey,         // 10
	), nil
}

// secretsSaaSNamespaceForStore is the operator's own namespace, where a cluster-scoped store's
// auth.secretRef resolves. Mirrors categories.secretsSaaSNamespace, which is unexported.
const secretsSaaSNamespaceForStore = "external-secrets-operator"

// EnsureHetznerSecretStore applies the ClusterSecretStore over the in-cluster Vault, on the same
// retry rail EnsureExternalSecretsStore uses for the four cloud stores — the CRD and its validating
// webhook are installed asynchronously by ArgoCD, so a fresh cluster races them. That rail is where
// #2652's CRD-Established wait lives, so this store gets it for free and cannot drift out of step
// with the cloud ones; it is the SAME CRD (clustersecretstores.external-secrets.io), because it is
// the same kind. In practice the wait returns at once here — this runs after the add-on stage, by
// which time the operator is long installed — which is the point: a wait that is normally a no-op
// still fails loudly on the deploy where it is not.
//
// It is applied here rather than from externalSecretsStoreManifest for one reason of ORDER: that
// path runs before the add-on stage, when the Vault chart has not been installed and the store would
// point at a Service that does not exist. It is applied WITHOUT waiting for the bootstrap Job to
// finish, deliberately — ESO re-reconciles a store that fails validation, so the store simply goes
// Ready once the token lands, and blocking the deploy on a Job that retries for fifteen minutes
// would trade a self-healing wait for a failed deploy.
//
// No-op unless this deploy actually has an in-cluster Vault.
func EnsureHetznerSecretStore(facts *InfraFacts, stdout, stderr io.Writer) error {
	if facts == nil || !facts.HetznerInClusterVault {
		return nil
	}
	fmt.Fprintln(stdout, "Ensuring the in-cluster Vault ClusterSecretStore...")
	return applyStoreAwaitingOperator(HetznerSecretStoreManifest(), stdout, stderr)
}

// HetznerSecretStoreManifest renders the ClusterSecretStore over the in-cluster Vault.
//
// Same `conditions` scoping as every other store (#1306): a cluster-scoped store with no conditions
// is referenceable from ANY namespace, so on a shared Fabric a placed tenant could read the owner's
// secrets. `namespaceSelector NotIn alethia.io/placement=namespace` denies placed tenant namespaces
// while still matching label-absent ones, so the dedicated path is unchanged.
func HetznerSecretStoreManifest() string {
	return fmt.Sprintf(`apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: %s
spec:
  conditions:
    - namespaceSelector:
        matchExpressions:
          - key: alethia.io/placement
            operator: NotIn
            values: ["namespace"]
  provider:
    vault:
      server: %q
      path: %q
      version: v2
      auth:
        tokenSecretRef:
          name: %s
          key: %s
          namespace: %s
`, HetznerSecretStoreName,
		"http://"+hetznerVaultReleaseHost,
		hetznerVaultKVMount,
		HetznerSecretStoreCredSecret,
		hetznerSecretStoreCredKey,
		secretsSaaSNamespaceForStore)
}
