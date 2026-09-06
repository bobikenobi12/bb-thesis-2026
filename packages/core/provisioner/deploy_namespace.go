// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	coreaws "github.com/alethialabs-io/alethialabs/packages/core/cloud/aws"
	"github.com/alethialabs-io/alethialabs/packages/core/k8s"
	"github.com/alethialabs-io/alethialabs/packages/core/names"
	"github.com/alethialabs-io/alethialabs/packages/core/telemetry"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// placementPath classifies how RunDeployV2 must handle a config's placement. Kept as a pure decision
// (selectPlacementPath) so the branch is unit-testable without a cluster or a cloud.
type placementPath int

const (
	// placementDedicated provisions a full cluster via tofu — the legacy env=cluster path and the only
	// mode shipped to the customer base. Empty PlacementMode maps here (legacy).
	placementDedicated placementPath = iota
	// placementNamespaceAWS deploys onto an EXISTING shared Fabric cluster via keyless re-mint (no
	// tofu) — the activated `namespace` path. Named for the aws-first activation, it now routes EVERY
	// cloud whose output-free re-mint is wired (see namespaceRemintProviders). The const name is kept
	// because the RunDeployV2 dispatch in deploy.go (outside this file / this issue's scope) switches
	// on it; renaming is a follow-up cleanup, not a behaviour change.
	placementNamespaceAWS
	// placementVcluster provisions a virtual cluster (vcluster) on an EXISTING shared Fabric cluster and
	// delivers the app onto it via ArgoCD destination.name — the activated `vcluster` path (#1231), no
	// tofu. Like placementNamespaceAWS it is gated per-cloud (vclusterRemintProviders); routed by
	// selectPlacementPath and handled by runVClusterDeploy (deploy_vcluster.go).
	placementVcluster
	// placementUnactivated is a placement the runner cannot deploy yet (namespace/vcluster on a cloud
	// whose keyless re-mint isn't wired) — fail closed rather than run the full-cluster tofu.
	placementUnactivated
)

// selectPlacementPath decides the deploy path from placement mode + provider, WITHOUT side effects so
// it is unit-testable. `dedicated`/"" → full cluster; `namespace` on aws → the activated shared-cluster
// path; everything else (namespace on non-aws, vcluster, any unknown) → fail closed.
func selectPlacementPath(pm types.PlacementMode, provider string) placementPath {
	switch pm {
	case "", types.PlacementModeDedicated:
		return placementDedicated
	case types.PlacementModeNamespace:
		// namespace is activated per-cloud as each cloud's output-free re-mint seam lands. The
		// allowlist (namespaceRemintProviders) is the SINGLE control — a cloud outside it fails closed
		// with a documented, cloud-named reason rather than running the full-cluster tofu.
		if namespaceRemintWired(provider) {
			return placementNamespaceAWS
		}
		return placementUnactivated
	case types.PlacementModeVcluster:
		// vcluster is activated per-cloud as each cloud's output-free host re-mint lands
		// (vclusterRemintProviders, aws-first). A cloud outside it fails closed rather than running the
		// full-cluster tofu.
		if vclusterRemintWired(provider) {
			return placementVcluster
		}
		return placementUnactivated
	default:
		// any unrecognized/future mode → fail closed.
		return placementUnactivated
	}
}

// unactivatedPlacementError explains, per placement + cloud, WHY a placement isn't deployable yet — an
// explicit, documented fail-closed exclusion (cloud parity is a hard rule: a per-cloud gap is never a
// silent omission). With azure wired, namespace and vcluster are both activated on EVERY supported
// cloud, so these messages now only reach an unrecognized provider or a future placement mode.
func unactivatedPlacementError(pm types.PlacementMode, provider string) error {
	if pm == types.PlacementModeNamespace {
		return fmt.Errorf("placement_mode %q is not yet activated for deploy on provider %q — namespace placement mints keyless access to an existing shared cluster + a per-namespace identity, wired for aws (EKS + IRSA), gcp (GKE + Workload Identity), azure (AKS + federated identity), alibaba (ACK + RRSA) and hetzner (Talos-API kubeconfig from the persisted talosconfig; k8s-native isolation, no cloud IAM) today — every supported cloud, so only an unrecognized provider reaches here. 'dedicated' provisions on every cloud", pm, provider)
	}
	if pm == types.PlacementModeVcluster {
		return fmt.Errorf("placement_mode %q is not yet activated for deploy on provider %q — vcluster placement provisions a virtual cluster on an existing shared Fabric cluster, wired for aws (EKS DescribeCluster), gcp (GKE clusters.get), azure (AKS ManagedClusters), alibaba (ACK DescribeClusterUserKubeconfig, keyless RRSA) and hetzner (Talos-API kubeconfig from the persisted talosconfig) host re-mint today. 'dedicated' provisions on every cloud", pm, provider)
	}
	// The fallthrough is for an UNRECOGNIZED or future mode, so it must not enumerate the wired ones —
	// it used to say "'namespace' (aws) and 'vcluster' (aws)", which was true when it was written and is
	// contradicted by the two branches above: both modes are wired for all five clouds. A stale list in
	// an error message is worse than no list, because the reader trusts the code more than the docs.
	return fmt.Errorf("placement_mode %q is not a recognized placement mode — expected 'dedicated', 'namespace' or 'vcluster'", pm)
}

// namespaceRemintProviders is the allowlist of clouds whose OUTPUT-FREE keyless re-mint (resolve an
// EXISTING cluster by name from the cloud API, no tofu outputs) AND per-namespace identity are wired for
// `namespace` placement. It is the SINGLE control that activates a cloud: selectPlacementPath routes to
// the namespace path only for a cloud in this set, and runNamespaceDeploy fail-closes anything else.
//
// Every supported cloud is now wired — the parity follow-ups all landed, so this set has no remaining
// documented exclusion and only an unrecognized provider fails closed:
//   - #1127 gcp     — GKE clusters.get + Workload Identity
//   - #1128 azure   — AKS ManagedClusters.Get (+ listClusterUserCredentials CA) + federated identity
//   - #1129 alibaba — ACK DescribeClusterUserKubeconfig + RRSA
//
// hetzner-talos is activated via a DIFFERENT mechanism (Talos has no cloud API to re-mint kube access):
// the admin talosconfig is persisted at Fabric creation and the runner-injected TalosKubeconfigMinter mints
// a fresh short-lived kubeconfig from it per placement (mintClusterOutputs). It has NO cloud IAM, so a
// hetzner namespace tenant gets k8s-native isolation only — no per-namespace cloud identity (an explicit,
// documented exclusion in provisionAndBindNamespaceIdentity; cloud parity is a hard rule, so the gap is
// never silent).
// namespaceTenantInput builds the tenant renderer's input from the config snapshot. Extracted as a
// PURE function so the wiring — and in particular that AppsPath actually reaches the renderer — is
// unit-testable without a cluster, a cloud or a kubeconfig. It was the absence of exactly this seam
// that let AppsPath sit unwired: the field existed, rendered and defaulted, and nothing ever set it.
func namespaceTenantInput(vc *types.ProjectConfig, ns string) argocd.NamespaceTenantInput {
	return argocd.NamespaceTenantInput{
		Project:     vc.ProjectName,
		Namespace:   ns,
		AppsRepoURL: vc.Repositories.AppsDestinationRepo,
		// Per-tier Kustomize overlay subpath ("overlays/dev"). EMPTY ⇒ the renderer defaults to "."
		// (the repo root), so every environment that predates this field syncs exactly as before.
		AppsPath: vc.Repositories.AppsPath,
		Labels:   cloud.ClassificationLabels(vc),
	}
}

var namespaceRemintProviders = map[string]bool{
	"aws":     true,
	"gcp":     true,
	"azure":   true,
	"alibaba": true,
	"hetzner": true,
}

// namespaceRemintWired reports whether provider's output-free namespace re-mint + identity are activated.
func namespaceRemintWired(provider string) bool { return namespaceRemintProviders[provider] }

// namespaceClusterNameOutputKey maps a provider to the output key its ConfigureKubeconfig reads the
// cluster name from (mirrors cloud.ExtractClusterName's per-cloud keys). A namespace deploy runs no
// tofu, so mintNamespaceKubeAccess synthesizes a one-key outputs map with just the cluster name and
// relies on ConfigureKubeconfig to resolve endpoint+CA OUTPUT-FREE from the cloud API (each per-cloud
// lane makes its ConfigureKubeconfig do so). Static lookup data — an entry is inert until the cloud is
// activated in namespaceRemintProviders.
var namespaceClusterNameOutputKey = map[string]string{
	"aws":     "eks_cluster_name",
	"gcp":     "gke_cluster_name",
	"azure":   "aks_cluster_name",
	"alibaba": "ack_cluster_name",
	// hetzner mints the kubeconfig from the persisted talosconfig (mintClusterOutputs), not a cloud API;
	// the name key still identifies the cluster on the synthesized outputs map.
	"hetzner": "talos_cluster_name",
}

// namespaceRemintNotWired is the fail-closed error for a cloud whose namespace re-mint seam isn't wired —
// an explicit, cloud-named exclusion (parity is documented, never a silent omission).
func namespaceRemintNotWired(provider string) error {
	return fmt.Errorf("namespace placement: output-free keyless re-mint + per-namespace identity is not wired for provider %q — activated for aws (EKS DescribeCluster + IRSA), gcp (GKE clusters.get + Workload Identity), azure (AKS ManagedClusters.Get + federated identity), alibaba (ACK DescribeClusterUserKubeconfig + RRSA) and hetzner (Talos-API kubeconfig from the persisted talosconfig; k8s-native isolation, no cloud IAM) today — every supported cloud, so this reports an unrecognized provider", provider)
}

// namespaceClusterConnKeys maps a provider whose ConfigureKubeconfig reads the control-plane endpoint +
// CA from OUTPUTS (rather than resolving them from the cluster name via an in-core SDK) to those output
// keys. For such a cloud a keyless (no-tofu) placement's runner-injected KubeConnResolver supplies
// endpoint+CA — from the cloud API, by name — and the mint path stores them under these keys, so
// ConfigureKubeconfig consumes them UNCHANGED. aws is deliberately absent: its ConfigureKubeconfig
// resolves endpoint/CA/ARN via EKS DescribeCluster from the cluster name alone (the AWS SDK already
// lives in packages/core). alibaba is a follow-up — its ConfigureKubeconfig reads a full `kubeconfig`
// output (a different shape, and RRSA not a bearer token).
var namespaceClusterConnKeys = map[string]struct{ endpoint, ca string }{
	"gcp":   {endpoint: "gke_cluster_endpoint", ca: "gke_cluster_ca_certificate"},
	"azure": {endpoint: "aks_cluster_endpoint", ca: "aks_cluster_ca_certificate"},
	// alibaba follows — its ConfigureKubeconfig reads a full `kubeconfig` output (a different shape),
	// and its ARM analogue signs requests rather than using a bearer token.
}

// mintClusterOutputs builds the synthetic outputs map a keyless (no-tofu) placement feeds
// ConfigureKubeconfig. It always carries the cluster-name key; for a cloud whose ConfigureKubeconfig
// reads endpoint+CA from outputs (namespaceClusterConnKeys), it uses the runner-injected resolver to
// fetch them OUTPUT-FREE from the cloud API and stores them under the per-cloud keys. aws needs no
// resolver (its ConfigureKubeconfig resolves endpoint/CA from the name via the in-core EKS SDK).
// Fail-closed: a cloud that needs a conn but was given no resolver, or a resolver that returns empty
// values, is surfaced as an error rather than silently producing an unusable kubeconfig.
func mintClusterOutputs(ctx context.Context, resolver KubeConnResolver, talosMinter TalosKubeconfigMinter, providerSlug string, config *types.ProjectConfig, clusterName, nameKey string) (map[string]interface{}, error) {
	outputs := map[string]interface{}{nameKey: clusterName}

	// hetzner-talos: no cloud API to re-mint. Mint a fresh short-lived kubeconfig from the PERSISTED
	// talosconfig via the runner-injected minter and hand it to ConfigureKubeconfig under the `kubeconfig`
	// output key (its existing path — hetznerProvider.ConfigureKubeconfig reads `kubeconfig`). Fail-closed:
	// a missing minter (runner wiring bug) or an empty kubeconfig is an error, never an unusable config.
	if providerSlug == "hetzner" {
		if talosMinter == nil {
			return nil, fmt.Errorf("placement mint: hetzner-talos needs an injected Talos kubeconfig minter (persisted talosconfig) but none was provided — this is a runner wiring bug")
		}
		kubeconfig, err := talosMinter(ctx, config, clusterName)
		if err != nil {
			return nil, fmt.Errorf("mint talos kubeconfig for %q (keyless, from persisted talosconfig): %w", clusterName, err)
		}
		if strings.TrimSpace(kubeconfig) == "" {
			return nil, fmt.Errorf("mint talos kubeconfig for %q: minter returned an empty kubeconfig", clusterName)
		}
		outputs["kubeconfig"] = kubeconfig
		return outputs, nil
	}

	keys, needsConn := namespaceClusterConnKeys[providerSlug]
	if !needsConn {
		return outputs, nil
	}
	if resolver == nil {
		return nil, fmt.Errorf("placement mint: provider %q resolves its kube endpoint/CA from the cloud API but no KubeConnResolver was injected — this is a runner wiring bug", providerSlug)
	}
	endpoint, caData, err := resolver(ctx, providerSlug, config, clusterName)
	if err != nil {
		return nil, fmt.Errorf("resolve %s cluster %q connection (keyless, output-free): %w", providerSlug, clusterName, err)
	}
	if strings.TrimSpace(endpoint) == "" || strings.TrimSpace(caData) == "" {
		return nil, fmt.Errorf("resolve %s cluster %q connection: resolver returned an empty endpoint or CA", providerSlug, clusterName)
	}
	outputs[keys.endpoint] = endpoint
	outputs[keys.ca] = caData
	return outputs, nil
}

// mintNamespaceKubeAccess mints keyless kube access to an EXISTING shared-Fabric cluster BY NAME, with no
// tofu outputs — the per-cloud seam #1127/#1128/#1129 activate. It synthesizes the provider's cluster-name
// output key (plus, for a cloud that needs it, the endpoint+CA from the injected resolver) and delegates
// to CloudProvider.ConfigureKubeconfig, which writes the in-process `kube-token` exec-plugin kubeconfig.
// Fail-closed for any cloud not in namespaceRemintProviders (defence-in-depth behind selectPlacementPath).
func mintNamespaceKubeAccess(ctx context.Context, provider cloud.CloudProvider, resolver KubeConnResolver, talosMinter TalosKubeconfigMinter, config *types.ProjectConfig, providerSlug, clusterName string, stdout io.Writer) error {
	if !namespaceRemintWired(providerSlug) {
		return namespaceRemintNotWired(providerSlug)
	}
	nameKey, ok := namespaceClusterNameOutputKey[providerSlug]
	if !ok {
		return namespaceRemintNotWired(providerSlug)
	}
	mintOutputs, err := mintClusterOutputs(ctx, resolver, talosMinter, providerSlug, config, clusterName, nameKey)
	if err != nil {
		return err
	}
	return provider.ConfigureKubeconfig(ctx, config, mintOutputs, stdout)
}

// provisionAndBindNamespaceIdentity provisions the namespace tenant's OWN least-priv cloud identity and
// binds the namespace's default ServiceAccount to it, so a pod in this namespace assumes ONLY its
// namespace identity — never the cluster-wide controller/node role (#957). Per-cloud: aws mints a
// zero-perm per-namespace IRSA role (OIDC trust scoped to system:serviceaccount:<ns>:*) and annotates
// the default SA; gcp/azure/alibaba (GCP Workload Identity, Azure federated identity, Alibaba RRSA) are
// the #1127/#1128/#1129 seams. Fail-closed default — a cloud only reaches the default if it's activated
// in namespaceRemintProviders but its identity case is unimplemented (parity is never a silent no-op).
func provisionAndBindNamespaceIdentity(ctx context.Context, identity NamespaceIdentityProvisioner, providerSlug, region string, config *types.ProjectConfig, clusterName, ns string, stdout, stderr io.Writer) error {
	switch providerSlug {
	case "aws":
		roleARN, idErr := coreaws.ProvisionNamespaceIdentity(ctx, region, clusterName, ns)
		if idErr != nil {
			return fmt.Errorf("failed to provision per-namespace identity for %q: %w", ns, idErr)
		}
		if !coreaws.IsValidRoleARN(roleARN) {
			return fmt.Errorf("provisioned per-namespace role ARN %q is malformed", roleARN)
		}
		if err := bindNamespaceIdentity(ns, roleARN, stdout, stderr); err != nil {
			return fmt.Errorf("failed to bind namespace %q default ServiceAccount to its identity: %w", ns, err)
		}
		return nil
	case "gcp":
		// GCP Workload Identity: the runner-injected provisioner get-or-creates a zero-perm per-namespace
		// GSA + the roles/iam.workloadIdentityUser binding for this namespace's KSA principal (a live IAM
		// write, done keyless by the runner), returning the GSA email. Bind the KSA to it.
		if identity == nil {
			return fmt.Errorf("namespace placement: provider %q needs an injected NamespaceIdentity provisioner but none was provided — this is a runner wiring bug", providerSlug)
		}
		gsaEmail, idErr := identity(ctx, providerSlug, config, clusterName, ns)
		if idErr != nil {
			return fmt.Errorf("failed to provision per-namespace identity for %q: %w", ns, idErr)
		}
		if !cloud.IsValidGSAEmail(gsaEmail) {
			return fmt.Errorf("provisioned per-namespace GSA email %q is malformed", gsaEmail)
		}
		if err := bindGKENamespaceIdentity(ns, gsaEmail, stdout, stderr); err != nil {
			return fmt.Errorf("failed to bind namespace %q default ServiceAccount to its identity: %w", ns, err)
		}
		return nil
	case "hetzner":
		// hetzner-talos has NO cloud IAM — there is no cloud identity provider to mint a zero-perm
		// per-namespace role against (unlike EKS IRSA / GKE WI / AKS federated / ACK RRSA). So a hetzner
		// namespace tenant's isolation is k8s-native ONLY (the namespace + the guardrail bundle's default-SA
		// RBAC with token automount off + default-deny NetworkPolicy where the CNI enforces it — Cilium does
		// on the Talos template). This is an EXPLICIT, documented per-cloud exclusion (cloud parity is a hard
		// rule: the gap is named, never a silent no-op), reviewed as such. No cloud-identity binding to apply.
		fmt.Fprintf(stdout, "Namespace %q on hetzner-talos: k8s-native isolation only (no cloud IAM to bind a per-namespace identity).\n", ns)
		return nil
	case "alibaba":
		// Alibaba RRSA (the ACK analog of AWS IRSA): provision a zero-perm per-namespace RAM role — OIDC
		// trust scoped to system:serviceaccount:<ns>:* on the cluster's RRSA provider — IN-CORE via the
		// keyless ACS3-signing client (the signer is stdlib; no cloud SDK in packages/core, like aws's
		// in-core IAM path). Returns the ROLE NAME (RRSA binds by name). Then enable the namespace's RRSA
		// webhook injection + annotate the default SA with the role name.
		roleName, idErr := cloud.ProvisionACKNamespaceIdentity(ctx, region, clusterName, ns)
		if idErr != nil {
			return fmt.Errorf("failed to provision per-namespace identity for %q: %w", ns, idErr)
		}
		if !cloud.IsValidACKRoleName(roleName) {
			return fmt.Errorf("provisioned per-namespace RAM role name %q is malformed", roleName)
		}
		if err := bindACKNamespaceIdentity(ns, roleName, stdout, stderr); err != nil {
			return fmt.Errorf("failed to bind namespace %q default ServiceAccount to its identity: %w", ns, err)
		}
		return nil
	case "azure":
		// Azure Workload Identity: the runner-injected provisioner get-or-creates a zero-perm per-namespace
		// user-assigned managed identity + a federated credential trusting this namespace's default KSA on
		// the AKS OIDC issuer (a live ARM write, done keyless by the runner), returning the UAMI clientId.
		if identity == nil {
			return fmt.Errorf("namespace placement: provider %q needs an injected NamespaceIdentity provisioner but none was provided — this is a runner wiring bug", providerSlug)
		}
		clientID, idErr := identity(ctx, providerSlug, config, clusterName, ns)
		if idErr != nil {
			return fmt.Errorf("failed to provision per-namespace identity for %q: %w", ns, idErr)
		}
		if !cloud.IsValidUAMIClientID(clientID) {
			return fmt.Errorf("provisioned per-namespace UAMI clientId %q is malformed", clientID)
		}
		if err := bindAKSNamespaceIdentity(ns, clientID, stdout, stderr); err != nil {
			return fmt.Errorf("failed to bind namespace %q default ServiceAccount to its identity: %w", ns, err)
		}
		return nil
	default:
		return namespaceRemintNotWired(providerSlug)
	}
}

// runNamespaceDeploy deploys a `namespace`-placement env onto an EXISTING shared Fabric cluster
// (#955/#956), aws-first. It runs NO tofu: it mints keyless kube access to the named cluster, applies
// the fail-closed per-namespace isolation (hardened AppProject + Namespace w/ PSA + the guardrail
// bundle), and delivers the tenant app as ONE ArgoCD Application into the namespace — WITHOUT
// reinstalling the shared Fabric's ArgoCD. v1 provisions no per-env cloud resources and grants the
// tenant NO Kubernetes-API credential (default-SA token automount off, no IRSA — per-namespace
// identity is the #957 follow-up).
//
// It is a fully separate path from RunDeployV2's full-cluster body so the `dedicated` path stays
// byte-identical. Because no infrastructure (cloud) is mutated, the tofu plan / verify gate / cost
// guard / evidence receipt do not apply and are deliberately absent — a namespace deploy mutates only
// in-cluster Kubernetes objects on a Fabric that already passed the gate at ITS creation.
//
// SECURITY — INCOMPLETE tenant isolation on the current Fabric (do NOT offer namespace placement in
// the UI until closed; the placement selector is parked precisely for this bar):
//   - The default-deny NetworkPolicy in the guardrail bundle is only enforced if the Fabric's CNI
//     enforces NetworkPolicy. The AWS EKS Fabric template does NOT enable VPC-CNI NetworkPolicy today,
//     so the network half is currently a NO-OP on AWS — tenants are not network-isolated from each
//     other, and (with node metadata hop-limit 2) a pod can reach IMDS and assume the NODE IAM role
//     (cluster-wide node creds: ECR, ENI/EC2). Closing this needs, on the Fabric: VPC-CNI
//     NetworkPolicy enforcement (parity: Calico/Cilium equivalents on the other clouds) AND node IMDS
//     hop-limit 1 (or an explicit metadata-egress deny), AND per-namespace IRSA/WI (#957). Until then
//     the honest isolation level is "soft, and not a cloud-credential boundary."
//   - Secret stores: CLOSED (#1306). The Fabric's ExternalSecrets ClusterSecretStores (native + the
//     cross-account -xacct foreign-account stores) are scoped via spec.conditions
//     (namespaceSelector NotIn alethia.io/placement=namespace, see argocd/install.go), so a placed
//     tenant namespace cannot reference another environment's — or the Fabric owner's — secret store.
func runNamespaceDeploy(ctx context.Context, params DeployParams) (_ *PlanResult, retErr error) {
	vc := params.ProjectConfig

	stdout := params.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := params.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	// Reduced provisioning-stage spans (kube_configure → argocd). Same pattern as RunDeployV2: setStage
	// ends the previous span and opens the next; the deferred close ends the last and stamps the error.
	var curSpan trace.Span
	setStage := func(name string) {
		if curSpan != nil {
			curSpan.End()
		}
		_, curSpan = telemetry.StartStage(ctx, name)
	}
	defer func() {
		if curSpan != nil {
			if retErr != nil {
				curSpan.RecordError(retErr)
				curSpan.SetStatus(codes.Error, retErr.Error())
			}
			curSpan.End()
		}
	}()

	// Belt-and-suspenders: selectPlacementPath already routed only a re-mint-wired cloud here, but never
	// run the namespace path for a cloud whose keyless re-mint isn't wired (namespaceRemintProviders).
	if !namespaceRemintWired(params.Provider) {
		return nil, unactivatedPlacementError(vc.PlacementMode, params.Provider)
	}

	// The serving cluster + destination namespace must be resolved onto the snapshot by the console
	// (buildConfigSnapshot → resolveServingCluster / resolveTargetEnvironment). Fail closed if absent —
	// never guess a cluster/namespace.
	clusterName := strings.TrimSpace(vc.Cluster.ClusterName)
	if clusterName == "" {
		return nil, fmt.Errorf("namespace placement: no serving cluster on the config snapshot — the Fabric's cluster must be provisioned (a 'dedicated' env owning the Fabric) before a namespace env can be placed onto it")
	}
	ns := strings.TrimSpace(vc.Namespace)
	if ns == "" {
		return nil, fmt.Errorf("namespace placement: no destination namespace on the config snapshot")
	}

	// Defense-in-depth: `ns` and `clusterName` flow into SHELL commands (utils.ExecuteCommand runs
	// `bash -c`, e.g. `kubectl apply -n <ns> ...`) and into rendered YAML manifests. The console builds
	// the snapshot and derives `ns` as a DNS-1123 slug, but the RUNNER is the trust boundary for a
	// (project-data-influenced) snapshot — reject anything that isn't a strict DNS-1123 label / valid
	// cluster name, so a malformed or hostile value can never inject a shell command (it would run with
	// the runner's ambient cloud creds) or break the manifest.
	if !isDNS1123Label(ns) {
		return nil, fmt.Errorf("namespace placement: destination namespace %q is not a valid DNS-1123 label", ns)
	}
	if !isValidClusterName(clusterName) {
		return nil, fmt.Errorf("namespace placement: serving cluster name %q contains invalid characters", clusterName)
	}
	// Same trust-boundary argument for the apps-repo subpath: it is project data that ends up in the
	// tenant Application's source.path. Reject a traversal or a YAML-hostile value HERE — before
	// minting kube access or touching the shared Fabric — rather than eleven steps later at render
	// time. Empty is valid and means the repo root.
	if err := argocd.ValidateAppsPath(vc.Repositories.AppsPath); err != nil {
		return nil, fmt.Errorf("namespace placement: %w", err)
	}

	provider, err := cloud.NewCloudProvider(params.Provider)
	if err != nil {
		return nil, err
	}

	fmt.Fprintf(stdout, "Namespace placement: deploying into namespace %q on existing shared cluster %q (provider: %s) — no cluster provisioning.\n", ns, clusterName, provider.Name())

	var result PlanResult
	result.ClusterName = clusterName

	// Plan job: a namespace placement provisions no infrastructure (no tofu), so there is nothing to
	// plan/verify/price. Report the resolved target and return — no verify report / receipt / cost
	// breakdown (nil, not a fabricated pass).
	if params.DryRun {
		fmt.Fprintf(stdout, "Dry-run (plan): namespace placement provisions no infrastructure — at deploy, the app + isolation guardrails are applied into namespace %q on cluster %q.\n", ns, clusterName)
		return &result, nil
	}

	if err := utils.CheckDependencies("kubectl"); err != nil {
		return nil, fmt.Errorf("preflight check failed: %w", err)
	}

	// Keyless kube access to the EXISTING named cluster, OUTPUT-FREE (no tofu). Per-cloud seam
	// (mintNamespaceKubeAccess): aws ConfigureKubeconfig resolves endpoint/CA/ARN via EKS DescribeCluster
	// on the ambient keyless session; gcp/azure/alibaba resolve the same from their cloud API once their
	// lane (#1127/#1128/#1129) wires it. The provider is fed only its cluster-name output key.
	setStage("kube_configure")
	if err := mintNamespaceKubeAccess(ctx, provider, params.KubeConn, params.TalosKubeconfig, vc, params.Provider, clusterName, stdout); err != nil {
		return nil, fmt.Errorf("kubeconfig mint failed for existing cluster %q — the namespace env is placed on a Fabric whose cluster is unreachable: %w", clusterName, err)
	}
	// Reachability probe: minting only proves DescribeCluster succeeded, not that the exec-plugin token
	// is ACCEPTED by the API server. A cheap API-reachability check (requireNode=false — the shared
	// Fabric's nodes are already Ready) fails a wrong Fabric/region or an authz denial HONESTLY here
	// rather than as a confusing ArgoCD apply error later. No CNI bootstrap / pod-datapath gate: those
	// are Fabric-provisioning concerns; the cluster is already healthy.
	if err := k8s.WaitClusterReady(ctx, clusterReadyTimeout(), false, stdout); err != nil {
		return nil, fmt.Errorf("existing cluster %q unreachable after minting kube access: %w", clusterName, err)
	}
	result.ClusterReady = true

	// GitOps delivery onto the SHARED Fabric's ArgoCD. DO NOT install ArgoCD — it belongs to the Fabric
	// (a namespace tenant must never re-install / upgrade the shared control plane).
	setStage("argocd")
	gitopsRequested := vc.Repositories.AppsDestinationRepo != ""
	gitopsFailed := func(step string, err error) *argocd.GitopsStatus {
		return gitopsFailure(gitopsRequested, vc.Repositories.AppsDestinationRepo, step, err, params.GitAccessToken)
	}

	// Register the tenant apps-repo credential on the shared ArgoCD so it can clone the repo (public
	// repos need none). Mirrors the dedicated switch.
	if gitopsRequested {
		switch {
		case params.GitAccessToken != "":
			if err := argocd.ConfigureRepoCredentials(vc.Repositories.AppsDestinationRepo, params.GitAccessToken, stdout, stderr); err != nil {
				result.GitopsStatus = gitopsFailed(argocd.GitopsStepRepoCredentials, err)
				return &result, fmt.Errorf("failed to connect ArgoCD to apps repo %s: %w", vc.Repositories.AppsDestinationRepo, err)
			}
		case argocd.IsRepoAnonymouslyCloneable(ctx, vc.Repositories.AppsDestinationRepo):
			fmt.Fprintf(stdout, "Apps repo %s is publicly cloneable — ArgoCD will clone it anonymously; no git token required.\n", vc.Repositories.AppsDestinationRepo)
		default:
			err := fmt.Errorf("GitOps requested (apps repo %s) but no git access token is available and the repo is not anonymously cloneable — connect the git provider for the job owner, or make the repo public", vc.Repositories.AppsDestinationRepo)
			result.GitopsStatus = gitopsFailed(argocd.GitopsStepGitToken, err)
			return &result, err
		}
	}

	// Render the hardened isolation (Namespace + AppProject) + the app Application.
	manifests, renderErr := argocd.RenderNamespaceTenant(namespaceTenantInput(vc, ns))
	if renderErr != nil {
		result.GitopsStatus = gitopsFailed(argocd.GitopsStepRender, renderErr)
		return &result, fmt.Errorf("failed to render namespace tenant isolation: %w", renderErr)
	}

	// Fail-closed ORDER: (1) Namespace + hardened AppProject, (2) the guardrail bundle INTO the ns, (3)
	// the app Application. The app carries CreateNamespace=false and is pinned to the hardened
	// AppProject, so it can never sync into an un-guarded namespace even if it raced ahead.
	if err := kubectlApplyManifest(manifests.Isolation, "namespace isolation (Namespace + hardened AppProject)", stdout, stderr); err != nil {
		result.GitopsStatus = gitopsFailed(argocd.GitopsStepApply, err)
		return &result, fmt.Errorf("failed to apply namespace isolation: %w", err)
	}
	if err := applyNamespaceGuardrailBundle(ns, stdout, stderr); err != nil {
		result.GitopsStatus = gitopsFailed(argocd.GitopsStepApply, err)
		return &result, fmt.Errorf("failed to apply namespace guardrail bundle into %q: %w", ns, err)
	}

	// #957: provision the tenant's OWN least-priv cloud identity and bind the namespace's default
	// ServiceAccount to it, so a pod in this namespace assumes ONLY its namespace identity, never the
	// cluster-wide controller/node role. Per-cloud seam (provisionAndBindNamespaceIdentity): aws mints a
	// zero-perm per-namespace IRSA role (OIDC trust scoped to system:serviceaccount:<ns>:*); GCP Workload
	// Identity / Azure federated / Alibaba RRSA are the #1127/#1128/#1129 follow-ups (cloud parity is a
	// hard rule). Runs AFTER the guardrail bundle (which creates the default SA) and BEFORE the app, so
	// pods pick up the binding on sync.
	if err := provisionAndBindNamespaceIdentity(ctx, params.NamespaceIdentity, params.Provider, vc.Region, vc, clusterName, ns, stdout, stderr); err != nil {
		return &result, err
	}

	if manifests.App != "" {
		if err := kubectlApplyManifest(manifests.App, "namespace app Application", stdout, stderr); err != nil {
			result.GitopsStatus = gitopsFailed(argocd.GitopsStepApply, err)
			return &result, fmt.Errorf("failed to apply namespace app Application: %w", err)
		}
	} else {
		fmt.Fprintln(stdout, "No apps repo configured — namespace guarded, no app Application deployed.")
	}

	result.GitopsStatus = readGitopsSnapshot(gitopsRequested, vc.Repositories.AppsDestinationRepo, stdout, stderr)
	fmt.Fprintf(stdout, "Namespace deployment completed: app + isolation guardrails applied into namespace %q on cluster %q.\n", ns, clusterName)
	return &result, nil
}

// kubectlApplyManifest writes a rendered manifest to an owner-only temp file and applies it. Hard
// error on failure — the namespace path is fail-closed at every step.
func kubectlApplyManifest(manifest, label string, stdout, stderr io.Writer) error {
	dir, err := os.MkdirTemp("", "alethia-ns-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "manifest.yaml")
	// The rendered manifests carry no secrets, but owner-only keeps the workdir uniform.
	if err := os.WriteFile(path, []byte(manifest), 0o600); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Applying %s...\n", label)
	return executeCommand("kubectl apply -f "+path, ".", nil, stdout, stderr)
}

// kubectlDeleteManifest deletes the resources in a rendered manifest. `--ignore-not-found` makes it
// idempotent: a teardown that already ran, or one whose earlier half failed, converges instead of
// erroring. It is deliberately the mirror of kubectlApplyManifest and takes the SAME rendered manifest
// — deleting by rendered document rather than by hand-written name is what stops the teardown's idea of
// a resource's name from drifting away from the apply's (namespaceTenantName is derived, not stored).
func kubectlDeleteManifest(manifest, label string, stdout, stderr io.Writer) error {
	dir, err := os.MkdirTemp("", "alethia-ns-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "manifest.yaml")
	if err := os.WriteFile(path, []byte(manifest), 0o600); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Deleting %s...\n", label)
	return executeCommand("kubectl delete --ignore-not-found -f "+path, ".", nil, stdout, stderr)
}

// applyNamespaceGuardrailBundle applies the namespace-agnostic guardrail bundle
// (infra/templates/argocd/preview-guardrails/) INTO the tenant namespace with `kubectl -n <ns>`,
// which injects the namespace into each namespaced doc: default-deny NetworkPolicy + DNS/intra-ns
// allow, ResourceQuota, LimitRange, and least-priv default-SA RBAC (token automount off). Re-applied
// every deploy (idempotent); the tenant holds no write access to mutate it between deploys. The
// bundle's `alethia.io/preview` labels are cosmetic here (v1 reuses the exact, tested bundle) — a
// namespace-vs-preview label split is a follow-up.
func applyNamespaceGuardrailBundle(ns string, stdout, stderr io.Writer) error {
	argoDir := resolveArgoTemplatesDir()
	if argoDir == "" {
		return fmt.Errorf("ArgoCD templates not found — the runner image is missing its baked templates")
	}
	bundleDir := filepath.Join(argoDir, "preview-guardrails")
	if info, statErr := os.Stat(bundleDir); statErr != nil || !info.IsDir() {
		return fmt.Errorf("namespace guardrail bundle not found at %s: %w", bundleDir, statErr)
	}
	fmt.Fprintf(stdout, "Applying namespace guardrail bundle into %q...\n", ns)
	return executeCommand(fmt.Sprintf("kubectl apply -n %s -f %s", ns, bundleDir), ".", nil, stdout, stderr)
}

// bindNamespaceIdentity annotates the namespace's default ServiceAccount with the per-namespace IRSA role
// ARN (`eks.amazonaws.com/role-arn`), so a pod that uses it assumes ONLY the tenant's least-priv identity.
// The guardrail bundle already created the `default` SA (token automount off); `--overwrite` keeps the
// annotate idempotent across re-deploys. `ns` is a validated DNS-1123 label and `roleARN` passed
// IsValidRoleARN, so neither can inject the `bash -c` shell this runs through.
func bindNamespaceIdentity(ns, roleARN string, stdout, stderr io.Writer) error {
	fmt.Fprintf(stdout, "Binding namespace %q default ServiceAccount to its per-namespace identity...\n", ns)
	return executeCommand(
		fmt.Sprintf("kubectl annotate serviceaccount default -n %s eks.amazonaws.com/role-arn=%s --overwrite", ns, roleARN),
		".", nil, stdout, stderr,
	)
}

// bindGKENamespaceIdentity annotates the namespace's default ServiceAccount with the per-namespace GSA
// email (`iam.gke.io/gcp-service-account`), so a pod using it assumes ONLY the tenant's zero-perm GSA via
// GKE Workload Identity. `ns` is a validated DNS-1123 label and `gsaEmail` passed IsValidGSAEmail, so
// neither can inject the `bash -c` shell this runs through. `--overwrite` keeps it idempotent.
func bindGKENamespaceIdentity(ns, gsaEmail string, stdout, stderr io.Writer) error {
	fmt.Fprintf(stdout, "Binding namespace %q default ServiceAccount to its per-namespace GCP identity...\n", ns)
	return executeCommand(
		fmt.Sprintf("kubectl annotate serviceaccount default -n %s iam.gke.io/gcp-service-account=%s --overwrite", ns, gsaEmail),
		".", nil, stdout, stderr,
	)
}

// bindAKSNamespaceIdentity labels + annotates the namespace's default ServiceAccount for Azure Workload
// Identity: the `azure.workload.identity/use=true` label opts the SA into WI, and
// `azure.workload.identity/client-id=<clientId>` names the per-namespace UAMI it federates as. `ns` is a
// validated DNS-1123 label and `clientID` passed IsValidUAMIClientID (a GUID), so neither can inject the
// `bash -c` shell this runs through. `--overwrite` keeps both idempotent across re-deploys.
func bindAKSNamespaceIdentity(ns, clientID string, stdout, stderr io.Writer) error {
	fmt.Fprintf(stdout, "Binding namespace %q default ServiceAccount to its per-namespace Azure identity...\n", ns)
	if err := executeCommand(
		fmt.Sprintf("kubectl label serviceaccount default -n %s azure.workload.identity/use=true --overwrite", ns),
		".", nil, stdout, stderr,
	); err != nil {
		return err
	}
	return executeCommand(
		fmt.Sprintf("kubectl annotate serviceaccount default -n %s azure.workload.identity/client-id=%s --overwrite", ns, clientID),
		".", nil, stdout, stderr,
	)
}

// bindACKNamespaceIdentity wires the namespace's default ServiceAccount to its per-namespace RRSA role.
// ACK's ack-pod-identity-webhook injects an RRSA OIDC token into pods when (a) the namespace carries the
// `pod-identity.alibabacloud.com/injection=on` label and (b) the SA is annotated with
// `pod-identity.alibabacloud.com/role-name=<roleName>`. `ns` is a validated DNS-1123 label and `roleName`
// passed IsValidACKRoleName, so neither can inject the `bash -c` shell this runs through. `--overwrite`
// keeps both idempotent across re-deploys.
func bindACKNamespaceIdentity(ns, roleName string, stdout, stderr io.Writer) error {
	fmt.Fprintf(stdout, "Binding namespace %q default ServiceAccount to its per-namespace RRSA identity...\n", ns)
	if err := executeCommand(
		fmt.Sprintf("kubectl label namespace %s pod-identity.alibabacloud.com/injection=on --overwrite", ns),
		".", nil, stdout, stderr,
	); err != nil {
		return err
	}
	return executeCommand(
		fmt.Sprintf("kubectl annotate serviceaccount default -n %s pod-identity.alibabacloud.com/role-name=%s --overwrite", ns, roleName),
		".", nil, stdout, stderr,
	)
}

// isDNS1123Label reports whether s is a valid (≤63-char) DNS-1123 label — the k8s namespace grammar,
// which by construction contains no shell metacharacters or YAML-breaking runes. Used to fail-closed
// a namespace that isn't shell-safe / YAML-safe.
//
// The grammar itself is names.IsNamespace, generated from the console's names.ts (#3665), so this
// package cannot come to disagree with the form that produced the namespace.
func isDNS1123Label(s string) bool {
	return names.IsNamespace(s)
}

// clusterNameRe matches the EKS cluster-name grammar (alnum start, then alnum/hyphen/underscore) —
// shell-safe. Used to fail-closed a serving-cluster name from the snapshot before it reaches a shell.
var clusterNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`)

// isValidClusterName reports whether s is a shell-safe cluster name.
func isValidClusterName(s string) bool { return clusterNameRe.MatchString(s) }

// dnsDomainLabelRe matches ONE label of a DNS domain: alphanumeric-bounded, hyphens allowed inside.
// Deliberately the LDH grammar and nothing more — no underscores, no wildcards, no trailing dot.
// The point is not to be a complete RFC-1035 parser; it is that every rune it admits is inert in a
// shell string and in a YAML scalar, which is what the callers need. Case is allowed because DNS is
// case-insensitive and the console does not normalise.
var dnsDomainLabelRe = regexp.MustCompile(`^[A-Za-z0-9]([-A-Za-z0-9]*[A-Za-z0-9])?$`)

// isValidDNSDomain reports whether s is a plain DNS domain — safe to interpolate into a `bash -c`
// string or a YAML values file. Used to fail-closed on `dns.domain_name`, which is free-text
// project data (#2013): it is the ArgoCD ingress hostname, so it reaches both.
//
// Rejects the empty string, anything over 253 chars, a leading or doubled dot (which would yield an
// empty label), and any label that is not LDH or runs past 63 chars. A single label with no dot is
// accepted: `localhost`-style internal names are legitimate and the grammar is what matters here,
// not the public suffix.
//
// ONE trailing dot is accepted and ignored — the root label of a fully-qualified name. This is not
// leniency for its own sake: the absolute form is a shape this codebase already takes as input, and
// gcp/modules/cloud-dns/main.tf normalises it explicitly (`endswith(var.domain, ".") ? …`). Refusing
// it here would turn a domain that deploys today into a failed deploy. A trailing dot is inert in
// both a single-quoted shell word and a YAML scalar, so accepting it costs nothing.
func isValidDNSDomain(s string) bool {
	if s == "" || len(s) > 253 {
		return false
	}
	// Strip at most one root dot. `example.com..` still fails, via the empty label it leaves.
	s = strings.TrimSuffix(s, ".")
	if s == "" {
		return false
	}
	for _, label := range strings.Split(s, ".") {
		if len(label) > 63 || !dnsDomainLabelRe.MatchString(label) {
			return false
		}
	}
	return true
}
