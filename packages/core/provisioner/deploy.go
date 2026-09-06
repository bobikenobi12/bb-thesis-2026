// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/accessanalyzer"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/categories"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	alethiaAws "github.com/alethialabs-io/alethialabs/packages/core/cloud/aws"
	"github.com/alethialabs-io/alethialabs/packages/core/compat"
	"github.com/alethialabs-io/alethialabs/packages/core/infracost"
	"github.com/alethialabs-io/alethialabs/packages/core/k8s"
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/selfimage"
	"github.com/alethialabs-io/alethialabs/packages/core/telemetry"
	"github.com/alethialabs-io/alethialabs/packages/core/tofu"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"github.com/aws/aws-sdk-go-v2/config"
	tfjson "github.com/hashicorp/terraform-json"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

var (
	executeCommand           = utils.ExecuteCommand
	executeCommandWithOutput = utils.ExecuteCommandWithOutput
	// namespacePostMortem dumps a namespace's pods + events when a helm --wait expires. A seam so
	// the failure-path test can assert the dump without shelling kubectl (mirrors k8s/probe.go).
	namespacePostMortem = k8s.NamespacePostMortem
	// preflightArgoVersion is the live-ArgoCD version check installArgoCD runs before it touches
	// the cluster. A seam because it is the ONLY cluster-touching call in that function that does
	// not go through executeCommand: it shells `kubectl` directly, inheriting the process
	// KUBECONFIG, so every provisioner unit test that drives installArgoCD was really running
	// kubectl against whatever cluster the developer's environment pointed at (#3495).
	preflightArgoVersion = argocd.PreflightLiveArgoVersion
)

// argocdInstallError decides whether an installArgoCD failure is dressed as an install failure.
//
// A version-preflight REFUSAL is returned exactly as it was written. installArgoCD keeps it
// unwrapped deliberately — its own comment says why — and this frame used to undo that, so an
// operator who was refused read "ArgoCD install failed: refusing to install ArgoCD: …" and went
// looking for a broken chart. errors.As, not a string match: the sentence is free to change
// without silently reclassifying the error.
func argocdInstallError(err error) error {
	var refusal *argocd.PreflightRefusal
	if errors.As(err, &refusal) {
		return err
	}
	return fmt.Errorf("ArgoCD install failed: %w", err)
}

type DeployParams struct {
	ProjectConfig  *types.ProjectConfig
	Provider       string
	PlanFile       string
	DryRun         bool
	UpdateInfra    bool
	InfracostToken string
	GitAccessToken string
	// GitRepoTokens maps a BYO chart repo URL → its git token, for charts whose repo lives on a
	// different provider than the apps-destination repo (GitAccessToken). Empty/missing entries
	// fall back to GitAccessToken. Only the BYO-chart credential path consults this.
	GitRepoTokens map[string]string
	// AddOnSecretValues maps add-on id → secret field key → plaintext, fetched by the RUNNER
	// at execution time over the authenticated job channel (W4.5 #640 — the git-token
	// pattern; never present in the config snapshot or the stage payload). Consumed once, by
	// EnsureAddOnSecrets, to seed each add-on's in-cluster Secret before its Application
	// syncs. Nil when no enabled add-on has a stored secret knob.
	AddOnSecretValues map[string]map[string]string
	TemplatesDir      string
	// CategoriesDir is the root of the composable per-category modules
	// (infra/templates/categories). When set, pluggable providers selected on the
	// Project resources are composed into the plan; native resources are guarded off via tfvars.
	CategoriesDir string
	// StateBackend points project tofu state at the console's per-job http proxy
	// (no storage master key in the workdir). Required for RunDeployV2.
	StateBackend *cloud.HTTPBackendConfig
	// PhaseFile, when set, is an absolute path RunDeployV2 writes the current provisioning
	// phase to ("apply" is written immediately before `tofu apply`). The runner reads it
	// after a mid-flight cancel to decide whether the killed work had reached the apply
	// (state-mutating) phase — i.e. whether orphaned cloud resources may exist. It lives
	// under the per-job workdir so it is visible across the container-sandbox boundary
	// (the child writes it into the RW-mounted workdir; the parent reads it after exit).
	PhaseFile    string
	Stdout       io.Writer
	Stderr       io.Writer
	ApiClient    *api.Client
	DeploymentID string
	// VerifyOverride, when set, waives specific failing verification controls so
	// a fail-closed apply can proceed deliberately. Nil means no waiver (the
	// default — any hard control failure blocks apply).
	VerifyOverride *verify.Override
	// CompatOverride, when set, waives specific failing version-compatibility
	// controls (COMPAT-COMPONENT-*/COMPAT-ADDON-*/COMPAT-K8S-CLOUD-*) so a
	// fail-closed apply can proceed deliberately. Nil means no waiver (the default
	// — any hard compat failure blocks apply, under the COMPAT-001 gate).
	CompatOverride *compat.Override
	// CostCeilingMonthlyUSD, when > 0, fail-closes a real apply whose Infracost
	// estimated monthly cost exceeds it (or that could not be priced at all). 0 (the
	// default) disables the guard, so existing callers are unaffected. Opt-in cost
	// safety for the real-cloud e2e nightly; see costCeilingBlock.
	CostCeilingMonthlyUSD float64
	// KubeConn resolves an EXISTING shared-Fabric cluster's control-plane endpoint + CA
	// OUTPUT-FREE (by name, from the cloud API) for a `namespace`/`vcluster` placement that
	// runs no tofu. It is INJECTED by the runner — which holds the per-cloud keyless token
	// minters and the stdlib resolvers (cloud.Resolve{GKE,AKS,ACK}ClusterConn) — so
	// packages/core stays free of the gcp/azure/alibaba auth SDKs. Nil for aws (whose
	// ConfigureKubeconfig resolves endpoint/CA via the in-core EKS SDK from the name alone)
	// and for every dedicated deploy. See mintClusterOutputs.
	KubeConn KubeConnResolver
	// NamespaceIdentity provisions a per-namespace tenant cloud identity LIVE at deploy time
	// (#957) for a `namespace` placement, returning a shell-safe identity handle the deploy path
	// binds to the namespace default ServiceAccount. INJECTED by the runner for clouds whose
	// identity provisioning is an IAM-WRITE the runner performs keyless (gcp Workload Identity /
	// azure federated / alibaba RRSA), keeping those auth SDKs out of packages/core. Nil for aws
	// (its identity is provisioned in-core via the AWS IAM SDK — coreaws.ProvisionNamespaceIdentity)
	// and for every dedicated deploy. See provisionAndBindNamespaceIdentity.
	NamespaceIdentity NamespaceIdentityProvisioner
	// TalosKubeconfig mints a fresh short-lived kubeconfig for an EXISTING hetzner-talos Fabric cluster
	// from its PERSISTED talosconfig (there is no cloud API to re-mint — the talos admin credential is
	// captured at Fabric creation and delivered, encrypted, on the placement job's claim). INJECTED by the
	// runner (which holds the decrypted talosconfig + the Talos machine-API client), so packages/core takes
	// on no Talos gRPC dependency. Nil for every non-hetzner cloud and every dedicated deploy. The minted
	// kubeconfig is handed to hetznerProvider.ConfigureKubeconfig under the `kubeconfig` output key (its
	// existing path). See mintClusterOutputs.
	TalosKubeconfig TalosKubeconfigMinter
}

// NamespaceIdentityProvisioner provisions a per-namespace tenant cloud identity (a zero-perm identity
// the namespace's default ServiceAccount may assume, never the cluster node/controller role) and returns
// a shell-safe handle (gcp GSA email / azure UAMI client-id / alibaba RAM role arn). It is a live
// IAM-WRITE, so the runner injects it (it holds the keyless token + does the stdlib REST call), keeping
// the gcp/azure/alibaba auth SDKs out of packages/core. Returns a non-nil error (never a partial handle)
// on failure. The deploy path then binds the handle to the KSA with the per-cloud annotation.
type NamespaceIdentityProvisioner func(ctx context.Context, providerSlug string, config *types.ProjectConfig, clusterName, namespace string) (handle string, err error)

// NamespaceIdentityDeprovisioner deletes the per-namespace tenant cloud identity a
// NamespaceIdentityProvisioner created. It is the teardown counterpart and is injected by the runner for
// the same reason: deleting a GSA / UAMI is a live keyless IAM-write whose auth SDK stays out of
// packages/core. It takes no handle because every per-cloud identity name is DERIVED deterministically
// from (clusterName, namespace) — teardown reconstructs it rather than depending on a handle the destroy
// job's config snapshot does not carry.
//
// Idempotent by contract: an identity that is already gone is success, not an error, so a re-run of a
// partially-failed teardown converges instead of wedging.
type NamespaceIdentityDeprovisioner func(ctx context.Context, providerSlug string, config *types.ProjectConfig, clusterName, namespace string) error

// KubeConnResolver resolves an EXISTING shared-Fabric cluster's control-plane connection (endpoint +
// base64 CA) OUTPUT-FREE — by name, from the cloud API, using a keyless token the RUNNER mints. The
// runner injects it into DeployParams so a placement (namespace/vcluster) can complete a no-tofu
// kubeconfig mint on a cloud whose ConfigureKubeconfig reads endpoint/CA from outputs, without
// packages/core taking on that cloud's auth SDK. Returns a non-nil error (never partial values) when
// the cluster can't be resolved.
type KubeConnResolver func(ctx context.Context, providerSlug string, config *types.ProjectConfig, clusterName string) (endpoint, caData string, err error)

// TalosKubeconfigMinter mints a fresh, short-lived Kubernetes kubeconfig for an EXISTING hetzner-talos
// Fabric cluster from its persisted admin talosconfig, via the Talos machine API (talosctl kubeconfig
// equivalent). Talos exposes no cloud API to re-mint kube access, so — unlike the managed clouds'
// output-free-by-name resolve — the talos admin credential is persisted at Fabric creation and this mints
// from it. The runner injects it (it holds the decrypted talosconfig from the job claim and the Talos gRPC
// client), so packages/core stays free of the Talos dependency. Returns a non-nil error (never a partial
// kubeconfig) on failure.
type TalosKubeconfigMinter func(ctx context.Context, config *types.ProjectConfig, clusterName string) (kubeconfig string, err error)

// PlanResult holds structured output from a deployment (dry-run or full apply).
type PlanResult struct {
	PlanJSON        map[string]interface{}
	CostBreakdown   *infracost.CostBreakdown
	PlanFileBytes   []byte
	Outputs         map[string]interface{}
	ClusterName     string
	ClusterEndpoint string
	// ClusterReady reports that after a real apply the cluster's API server answered and
	// its nodes reached Ready within the probe timeout. A deploy that can't reach the
	// cluster is FAILED (not SUCCESS) — "tofu apply exited 0" is not a working cluster.
	ClusterReady bool
	ArgocdURL    string
	// The ArgoCD admin password is deliberately NOT a field here. It lives in the cluster's
	// `argocd-initial-admin-secret` Secret and is retrieved on-demand; keeping it out of
	// PlanResult stops it from crossing the sandbox boundary (result.json) or landing in the
	// console's execution_metadata (Postgres) as plaintext. See installArgoCD + buildDeployMetadata.
	// VerifyReport is the deterministic verification gate's result for this plan
	// (nil if the plan JSON could not be produced). On a real apply a blocking
	// verdict stops the apply before any infrastructure changes.
	VerifyReport *verify.Report
	// VerifyReceipt is the per-apply evidence receipt sealing the report to the
	// plan hash + tool versions. Signed when a signing key is configured
	// (Algorithm "ed25519"); otherwise attached unsigned (Algorithm "none").
	VerifyReceipt *verify.SignedReceipt
	// CompatReport is the version-compatibility gate's result for this config
	// (the cluster K8s minor × enabled add-ons/components against the matrix).
	// Always attached (the engine is pure — an unrecorded version yields honest
	// not_evaluable, never a silent pass). On a real apply a `fail` verdict stops
	// the apply before any infrastructure changes (the COMPAT-001 gate).
	CompatReport *compat.Report
	// AddOnStatus is the post-apply ArgoCD health/sync per managed marketplace add-on
	// (keyed by ArgoCD Application name). Empty when no add-ons were installed or the
	// health read failed; the runner forwards it so the console can show real status.
	AddOnStatus map[string]argocd.AddOnHealth
	// DataEndpoints is the connection endpoint + credential REFERENCE for each in-cluster data
	// service (Hetzner's database/cache/queue deploy as ArgoCD Applications, not managed cloud
	// resources), keyed by add-on id (`db-primary`, `cache-main`, …). READ BACK from the cluster —
	// chart Service names are never derived. Carries secret_ref ("<ns>/<name>"), never a credential
	// value (the #427 precedent: no plaintext secrets in execution_metadata).
	DataEndpoints map[string]argocd.DataEndpoint
	// SecurityPosture is the cluster's aggregated Trivy-Operator vulnerability posture
	// (nil when the read wasn't attempted). `Scanned=false` when Trivy isn't installed.
	SecurityPosture *argocd.SecurityPosture
	// InfraServices is the machine-readable per-service install/skip decision set for the
	// post-apply infra services (external-dns, external-secrets store, ingress, storage
	// class, ArgoCD URL). Each carries an honest reason — a skip records WHY plus the
	// alternative (like verify's not_evaluable). Non-sensitive; the runner forwards it.
	InfraServices []argocd.InfraServiceDecision
	// KeylessBindings is the per-binding keyless DB-auth decision set (#1511): for every database
	// the operator marked `iam_auth`, whether the auth proxy was WIRED or the binding failed CLOSED,
	// and why. Empty when the project has no keyless binding — and, by construction, on any deploy
	// where our manifest render never reaches a cluster (no apps repo, or a bring-your-own one).
	// Non-sensitive — names, a state and product copy; the runner forwards it verbatim.
	KeylessBindings []manifests.KeylessBindingDecision
	// GitopsStatus is the GitOps wiring outcome + apps-Application health snapshot
	// (issue #574): mode (gitops/direct), apps repo, synced revision, per-service
	// health from the `apps` Application's resources — and, when the deploy died
	// INSIDE the wiring, the failed step + sanitized error. Populated after every
	// real apply; also set on the FAILURE path (RunDeployV2 then returns a partial
	// result alongside the error) so the console can show WHY GitOps isn't wired
	// instead of a bare failed job. Nil on dry-runs and cluster-less deploys.
	GitopsStatus *argocd.GitopsStatus
}

// gitTokenValues collects every non-empty git token in play — the apps-repo GitAccessToken and each
// per-repo BYO token — for passing to the token-redactor so none can survive in a job-log/result
// error string (#948).
func gitTokenValues(appsToken string, repoTokens map[string]string) []string {
	out := make([]string, 0, len(repoTokens)+1)
	if appsToken != "" {
		out = append(out, appsToken)
	}
	for _, t := range repoTokens {
		if t != "" {
			out = append(out, t)
		}
	}
	return out
}

// gitopsFailure builds the GitopsStatus for a GitOps-wiring hard-fail: which step died
// plus a token-SANITIZED error message (the metadata scrub is key-based, so a tokened
// git URL inside the value must be redacted here, before it crosses result.json).
func gitopsFailure(requested bool, appsRepo, step string, err error, tokens ...string) *argocd.GitopsStatus {
	mode := "direct"
	if requested {
		mode = "gitops"
	}
	return &argocd.GitopsStatus{
		Mode:       mode,
		AppsRepo:   appsRepo,
		ArgocdApp:  argocd.UserAppsApplicationName,
		FailedStep: step,
		Error:      argocd.SanitizeGitopsError(err, tokens...),
	}
}

// readGitopsSnapshot records the post-wiring GitOps state: direct mode is just the mode
// marker; gitops mode additionally reads the `apps` Application's aggregate health/sync,
// synced revision, and per-workload service health (one kubectl read, best-effort).
func readGitopsSnapshot(requested bool, appsRepo string, stdout, stderr io.Writer) *argocd.GitopsStatus {
	if !requested {
		return &argocd.GitopsStatus{Mode: "direct"}
	}
	agg, revision, services := argocd.ReadAppsStatus(argocd.UserAppsApplicationName, stdout, stderr)
	return &argocd.GitopsStatus{
		Mode:      "gitops",
		AppsRepo:  appsRepo,
		ArgocdApp: argocd.UserAppsApplicationName,
		Revision:  revision,
		AppHealth: &agg,
		Services:  services,
	}
}

// enabledAddonIDs lists the ids of every add-on in the desired set — the keep-set for
// pruning runner-seeded add-on secrets (W4.5).
func enabledAddonIDs(addons []types.AddOnInstall) []string {
	ids := make([]string, 0, len(addons))
	for i := range addons {
		ids = append(ids, addons[i].ID)
	}
	return ids
}

// compatAddOnRefs maps the resolved add-on install set to the compat engine's
// AddOnRef inputs (id + pinned chart/release version) for the apply-time gate.
func compatAddOnRefs(addons []types.AddOnInstall) []compat.AddOnRef {
	if len(addons) == 0 {
		return nil
	}
	refs := make([]compat.AddOnRef, 0, len(addons))
	for i := range addons {
		refs = append(refs, compat.AddOnRef{ID: addons[i].ID, Version: addons[i].Version})
	}
	return refs
}

// writePhase records the current provisioning phase to the job's phase file (best-effort;
// a no-op when path is empty). The runner reads it after a mid-flight cancel to decide
// whether apply had started (→ possible orphaned cloud resources). See DeployParams.PhaseFile.
func writePhase(path, phase string) {
	if path == "" {
		return
	}
	_ = os.WriteFile(path, []byte(phase), 0o600)
}

// applyBootstrapManifests applies a self-managed cluster's CNI + cloud-integration
// manifests — the `bootstrap_manifests` tofu output (Talos/Hetzner emits it; managed
// EKS/GKE/AKS don't, so this is a no-op there). Talos ships CNI=none, so nodes stay
// NotReady until these are applied. The template renders them offline and emits them as
// an output (rather than applying them in-tofu via a cluster-wired kubectl provider), so
// `tofu plan -out` stays resolvable and the machine config stays under Hetzner's 32 KiB
// user_data limit. Retries a few times for CRD-before-CR ordering / API warm-up.
func applyBootstrapManifests(ctx context.Context, outputs map[string]interface{}, stdout, stderr io.Writer) error {
	raw, _ := outputs["bootstrap_manifests"].(string)
	if strings.TrimSpace(raw) == "" {
		return nil // managed cluster — CNI comes from the cloud
	}
	dir, err := os.MkdirTemp("", "alethia-bootstrap-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "bootstrap.yaml")
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		return err
	}
	fmt.Fprintln(stdout, "Bootstrapping cluster CNI + cloud integration (self-managed)...")
	// Server-side apply handles CRDs + their CRs in one pass more gracefully than a plain apply.
	cmd := fmt.Sprintf("kubectl apply --server-side --force-conflicts -f %s", path)
	var lastErr error
	for attempt := 1; attempt <= 4; attempt++ {
		if lastErr = executeCommand(cmd, ".", nil, stdout, stderr); lastErr == nil {
			return nil
		}
		fmt.Fprintf(stderr, "CNI bootstrap attempt %d/4 failed (API/CRD not ready yet): %v\n", attempt, lastErr)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(15 * time.Second):
		}
	}
	return fmt.Errorf("kubectl apply of bootstrap manifests failed after retries: %w", lastErr)
}

// clusterReadyTimeout is how long the reachability gate waits for the cluster (default 15m;
// override ALETHIA_CLUSTER_READY_TIMEOUT with a Go duration, e.g. "20m", for slow node joins).
func clusterReadyTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_CLUSTER_READY_TIMEOUT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
	}
	return 15 * time.Minute
}

// addonConvergeTimeout bounds how long the deploy waits for the add-on Applications to reach
// Healthy+Synced before reading their status for the console. Generous by default: a data service
// (CNPG Cluster, Valkey, RabbitMQ) has to pull images, bind a PVC (hcloud CSI attach is ~30-60s)
// and elect a primary. Best-effort — a timeout records the honest last-known status, it does not
// fail the deploy. Tunable via ALETHIA_ADDON_CONVERGE_TIMEOUT (e.g. "5m"; "0" disables the wait).
func addonConvergeTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_ADDON_CONVERGE_TIMEOUT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d >= 0 {
			return d
		}
	}
	return 10 * time.Minute
}

// clusterReadyRequireNode controls whether the gate waits for >=1 Ready node. Default true
// (node-group clusters); set ALETHIA_CLUSTER_READY_REQUIRE_NODE=false for on-demand-node
// clusters (e.g. Karpenter-only), where API-reachability alone is the bar.
func clusterReadyRequireNode() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("ALETHIA_CLUSTER_READY_REQUIRE_NODE"))) {
	case "0", "false", "no", "off":
		return false
	}
	return true
}

// gateRequiresReport is the fail-closed backstop for the real-apply path: a real
// apply must never proceed without a conclusive verification verdict. It returns
// nil (apply may proceed) when this is a dry-run/plan job (nothing is applied), or
// a verification report was produced (the report's own fail-closed enforcement runs
// separately, below), or an authorized override waives the ControlPlanUnavailable
// sentinel. Otherwise — a real apply whose plan JSON could not be produced, so the
// gate could not evaluate anything — it returns an error refusing the apply rather
// than silently skipping enforcement. Kept pure so the decision is unit-testable
// without real tofu. showErr (if any) is threaded through for the operator message.
func gateRequiresReport(dryRun bool, report *verify.Report, ov *verify.Override, showErr error) error {
	if dryRun || report != nil {
		return nil
	}
	if ov.Covers(verify.ControlPlanUnavailable) {
		return nil
	}
	// report==nil is broader than "no plan JSON": the report is also nil when the plan JSON
	// existed but verify.Evaluate errored. Both are "the gate produced no verdict" → refuse
	// (fail-closed) — but report the actual cause honestly so the operator fixes the right thing.
	cause := "the verifier could not evaluate the plan"
	if showErr != nil {
		cause = fmt.Sprintf("the plan JSON could not be produced (tofu show error: %v)", showErr)
	}
	return fmt.Errorf(
		"verification gate produced no verdict (%s) — refusing apply; fix the underlying error or supply an authorized, time-boxed override waiving %s",
		cause, verify.ControlPlanUnavailable)
}

// RunDeployV2 executes a deployment using the provider-agnostic ProjectConfig and CloudProvider interface.
//
// Error contract: a GitOps-wiring failure returns a PARTIAL non-nil result alongside the
// error — carrying GitopsStatus (failed step + sanitized message) so the wiring failure
// reaches execution_metadata (the sandbox writes result.json even on error). Callers must
// therefore branch on err, not on result != nil.
func RunDeployV2(ctx context.Context, params DeployParams) (_ *PlanResult, retErr error) {
	vc := params.ProjectConfig
	if vc == nil {
		return nil, fmt.Errorf("ProjectConfig is required for RunDeployV2")
	}

	// Provisioning-stage spans (plan → verify_gate → apply → kube_configure → argocd →
	// addons). The stages run strictly sequentially, so a single "current stage" span
	// walks the sequence: setStage ends the previous span and opens the next, and the
	// deferred close ends the last one — stamping the function's error onto whichever
	// stage failed. All are children of ctx's span (the runner's per-job span, anchored
	// to the job's traceparent), so console + runner spans share ONE trace. No-op spans
	// when no OTLP endpoint is configured (telemetry reads the global no-op tracer).
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

	byoIac := vc.IacSource != nil

	// Enforce placement discipline before anything else: a CORE resource on a
	// foreign cloud is a hot cross-cloud edge we can't provision yet. Fires on
	// dry-run (plan) too, so the user never reaches apply. SKIPPED for BYO IaC —
	// placement is a template/catalog-model concept; a customer's own module owns
	// its resource graph.
	if !byoIac {
		if err := ValidatePlacement(vc); err != nil {
			return nil, err
		}
	}

	// Placement activation dispatch (#955/#956). `dedicated` (incl. empty = legacy env=cluster) falls
	// through to the full-cluster provisioning below, byte-identical. `namespace` on aws deploys onto an
	// EXISTING shared Fabric cluster via keyless re-mint (no tofu) — a fully separate path so the
	// dedicated body stays untouched. Everything else (namespace on a cloud whose re-mint isn't wired,
	// vcluster) stays FAIL-CLOSED rather than silently running the full-cluster tofu, which would ignore
	// the placement the user chose and collide with the Fabric's real cluster.
	switch selectPlacementPath(vc.PlacementMode, params.Provider) {
	case placementNamespaceAWS:
		return runNamespaceDeploy(ctx, params)
	case placementVcluster:
		return runVClusterDeploy(ctx, params)
	case placementUnactivated:
		return nil, unactivatedPlacementError(vc.PlacementMode, params.Provider)
	case placementDedicated:
		// Fall through to the existing full-cluster provisioning path (unchanged).
	}

	provider, err := cloud.NewCloudProvider(params.Provider)
	if err != nil {
		return nil, err
	}

	// Config validation — the seam ProviderTfvars never had (#1967). RunDeployV2 serves BOTH
	// plan and apply (params.DryRun), so this one site refuses a bad value at plan time AND at
	// apply time.
	//
	// It sits BELOW the placement dispatch on purpose, not beside ValidatePlacement. Every rule
	// in cloud/validate.go is derived from a project template's own literals and may only ever
	// refuse what that template would refuse. The dedicated path — the one this line is on — is
	// the only one that renders those templates:
	//
	//   · placementNamespaceAWS deploys onto an EXISTING shared Fabric cluster by keyless
	//     re-mint. No tofu runs, and it reads none of node_min/max/desired_size,
	//     node_disk_size_gb or network.cidr_block. The canvas builds a cluster node for every
	//     project regardless of placement, so those fields EXIST and can hold anything on a
	//     namespace env — validating them there would refuse a project that deploys fine today,
	//     against floors from a template that is never rendered.
	//   · placementVcluster is the same story, and placementUnactivated already fails closed
	//     with a message about the placement, which a sizing error would only obscure.
	//
	// BYO IaC is excluded for the reason ValidatePlacement is: a customer's own module owns its
	// resource graph and our template floors say nothing about it.
	//
	// DELIBERATELY ASYMMETRIC, in the other direction too: this is the ONLY path that calls
	// ValidateConfig. destroy.go, drift.go and state_import.go call ProviderTfvars as well, and
	// they must NOT gain this check — a stack that was already applied carrying a bad value has
	// to stay destroyable, or a config mistake becomes an un-teardownable stack with live cloud
	// resources and a running bill.
	//
	// Neither half of that asymmetry is an oversight. Do not "complete" it later.
	if !byoIac {
		if err := provider.ValidateConfig(vc); err != nil {
			return nil, err
		}
	}

	stdout := params.Stdout
	if stdout == nil {
		stdout = os.Stdout
	}
	stderr := params.Stderr
	if stderr == nil {
		stderr = os.Stderr
	}

	fmt.Fprintf(stdout, "Starting deployment for project: %s (provider: %s)\n", vc.ProjectName, provider.Name())

	if !params.DryRun {
		if err := utils.CheckDependencies(provider.RequiredCLIs()...); err != nil {
			return nil, fmt.Errorf("preflight check failed: %w", err)
		}
	}

	if params.DryRun {
		fmt.Fprintln(stdout, "Running in dry-run (plan) mode")
	}

	tmpRoot, err := os.MkdirTemp("", "alethia-deploy-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpRoot)

	var tfDir string
	// byoTfvars holds the customer's coerced var_values on the BYO path (nil otherwise).
	var byoTfvars map[string]interface{}
	switch {
	case byoIac:
		// BRING-YOUR-OWN IaC: clone the customer's module at its pinned commit, run
		// the fail-closed static gate inline, write the backend override, and publish
		// the frozen TF_VAR_alethia_* context. No bundled template, no provider
		// tfvars, no brownfield injection, no connector composition — the module is
		// self-contained.
		cloneDir := filepath.Join(tmpRoot, "clone")
		var restore func()
		tfDir, byoTfvars, restore, err = prepareByoIacWorkdir(ctx, vc, params.GitAccessToken, cloneDir, stdout, stderr)
		if err != nil {
			return nil, err
		}
		defer restore()
	case params.TemplatesDir != "":
		fmt.Fprintf(stdout, "Using bundled templates from %s\n", params.TemplatesDir)
		workDir := filepath.Join(tmpRoot, "work")
		if err := copyDir(params.TemplatesDir, workDir); err != nil {
			return nil, fmt.Errorf("failed to copy templates: %w", err)
		}
		tfDir = workDir
	default:
		return nil, fmt.Errorf("no IaC source: set ProjectConfig.IacSource (BYO) or DeployParams.TemplatesDir")
	}

	tf, err := tofu.NewTofuCLI(ctx, vc.IacVersion, tfDir, stdout, stderr)
	if err != nil {
		return nil, fmt.Errorf("tofu init failed: %w", err)
	}

	var tfvars map[string]interface{}
	if byoIac {
		// Only the customer's coerced var_values — the platform context rides on
		// TF_VAR_alethia_* env (set by prepareByoIacWorkdir).
		tfvars = byoTfvars
	} else {
		tfvars = provider.ProviderTfvars(vc)

		// Brownfield: attach to an EXISTING network instead of creating one. AWS resolves the VPC's subnets
		// here (EC2 API); GCP/Azure pass the network id and the tofu template data-sources the network + a
		// subnet in-region (keeps the per-cloud subnet nuance in HCL). See infra/templates/project/*.
		if !vc.Network.ProvisionNetwork && vc.Network.NetworkID != "" {
			switch provider.Name() {
			case "aws":
				tfvars["vpc_id"] = vc.Network.NetworkID
				fmt.Fprintf(stdout, "Using existing VPC %s — looking up subnets...\n", vc.Network.NetworkID)
				ec2Client, ec2Err := alethiaAws.NewEC2Client(ctx, alethiaAws.AWSOptions{Region: vc.Region})
				if ec2Err != nil {
					fmt.Fprintf(stderr, "Warning: failed to create EC2 client for subnet lookup: %v\n", ec2Err)
				} else {
					// Discover the VPC's subnets and their public/private nature. On failure we
					// keep nil metadata but still honor an explicit selection below (#1352).
					var metas []cloud.SubnetMeta
					if subnets, subErr := ec2Client.ListSubnets(ctx, vc.Network.NetworkID); subErr != nil {
						fmt.Fprintf(stderr, "Warning: failed to list subnets: %v\n", subErr)
					} else {
						metas = make([]cloud.SubnetMeta, 0, len(subnets))
						for _, s := range subnets {
							metas = append(metas, cloud.SubnetMeta{ID: s.ID, Public: s.MapPublicIpOnLaunch})
						}
					}
					// Honor the user's explicit subnet selection when present; otherwise fall back
					// to every discovered subnet (auto-discover, today's behaviour). Only set the
					// tfvars when there is something to say, so an empty result leaves the
					// template's fail-closed brownfield precondition to catch it at plan.
					if len(metas) > 0 || len(vc.Network.SubnetIDs) > 0 {
						privateIDs, publicIDs := cloud.SelectBrownfieldSubnets(metas, vc.Network.SubnetIDs)
						tfvars["vpc_private_subnet_ids"] = privateIDs
						tfvars["vpc_public_subnet_ids"] = publicIDs
						if len(vc.Network.SubnetIDs) > 0 {
							fmt.Fprintf(stdout, "Resolved %d private and %d public subnets from your %d-subnet selection\n", len(privateIDs), len(publicIDs), len(vc.Network.SubnetIDs))
						} else {
							fmt.Fprintf(stdout, "Found %d private and %d public subnets\n", len(privateIDs), len(publicIDs))
						}
					}
				}
			case "gcp":
				// Self-link (projects/…/global/networks/…). The template data-sources the network + a
				// subnetwork in var.region (with its pod/service secondary ranges).
				tfvars["network_id"] = vc.Network.NetworkID
				fmt.Fprintf(stdout, "Using existing VPC network %s — the template resolves a subnet in %s.\n", vc.Network.NetworkID, vc.Region)
			case "azure":
				// VNet resource id. The template data-sources the VNet + a subnet for AKS.
				tfvars["vnet_id"] = vc.Network.NetworkID
				fmt.Fprintf(stdout, "Using existing VNet %s — the template resolves an AKS subnet.\n", vc.Network.NetworkID)
			}
		}
	}

	if params.StateBackend == nil {
		return nil, fmt.Errorf("StateBackend config is required for state storage")
	}
	backendFile, err := params.StateBackend.WriteBackendHCL(tfDir)
	if err != nil {
		return nil, fmt.Errorf("failed to write backend config: %w", err)
	}
	// Publish the per-job state token to the child tofu via TF_HTTP_PASSWORD for
	// the whole run (init reads/locks, plan reads, apply reads+locks+writes) —
	// never into a workdir file. Restored on return.
	restoreStateAuth := params.StateBackend.SetAuthEnv()
	defer restoreStateAuth()
	fmt.Fprintln(stdout, "State backend: console HTTP proxy (per-job token)")

	// Compose pluggable per-category connector modules (Cloudflare DNS, Vault,
	// Docker Hub, observability). This merges their tfvars (including decrypted
	// secrets resolved at claim time), copies the modules into the work dir, and
	// sets the native-guard vars so the cluster cloud skips its native resource.
	// SKIPPED for BYO IaC — a customer's own module owns its full resource graph;
	// the platform composes nothing into it.
	if !byoIac {
		if composed, composeErr := categories.Compose(tfDir, params.CategoriesDir, vc, tfvars, stdout); composeErr != nil {
			return nil, fmt.Errorf("connector composition failed: %w", composeErr)
		} else if composed > 0 {
			fmt.Fprintf(stdout, "Composed %d pluggable connector module(s).\n", composed)
		}
	}

	varFile, err := tofu.OverrideTfvarsFromMap(tfDir, tfvars)
	if err != nil {
		return nil, fmt.Errorf("failed to write tfvars: %w", err)
	}

	planFile, err := filepath.Abs(filepath.Join(tfDir, "tofu.plan.out"))
	if err != nil {
		return nil, err
	}

	// The http backend authenticates via TF_HTTP_PASSWORD (set above) — no cloud
	// creds are involved in state I/O, so the old s3 suspend/restore dance is gone.
	if err := tf.InitWithBackendFile(ctx, backendFile, false); err != nil {
		return nil, fmt.Errorf("tofu init failed: %w", err)
	}

	setStage("plan")
	if params.PlanFile != "" {
		fmt.Fprintf(stdout, "Using pre-approved plan file (skipping re-plan)\n")
		planFile = params.PlanFile
	} else {
		if _, err := tf.Plan(ctx, varFile, planFile); err != nil {
			return nil, fmt.Errorf("tofu plan failed: %w", err)
		}
	}

	var result PlanResult

	planJSON, showErr := tf.ShowPlanJSON(ctx, planFile)
	planJSONFile := ""
	if showErr != nil {
		fmt.Fprintf(stdout, "Warning: tofu show -json failed: %v\n", showErr)
	}
	if planJSON != nil {
		planJSONFile = filepath.Join(tmpRoot, "tofu.plan.json")
		if jsonBytes, marshalErr := json.Marshal(planJSON); marshalErr == nil {
			// Plan JSON can carry sensitive resource attributes (passwords, keys) — owner-only.
			_ = utils.WriteSecretFile(planJSONFile, jsonBytes)
			var parsed map[string]interface{}
			if json.Unmarshal(jsonBytes, &parsed) == nil {
				result.PlanJSON = parsed
			}
		}
	}

	// Verification gate (elench Phase 0). Evaluate the plan against the authored
	// security controls. The report is always attached to the result so the
	// console can surface it on both plan and apply jobs; the fail-closed
	// ENFORCEMENT happens just before apply, below. If the plan JSON could not be
	// produced we log a coverage gap rather than block (the experiment is about
	// control correctness, not tooling failures).
	setStage("verify_gate")
	if planJSON != nil {
		// Opt-in AWS IAM Access Analyzer corroboration: provable, automated-reasoning
		// checks that the planned policies don't grant a sensitive-action denylist.
		// Off by default (no AWS calls) so existing behaviour is unchanged.
		vopts := verify.Options{}
		if provider.Name() == "aws" && os.Getenv("ALETHIA_VERIFY_ACCESS_ANALYZER") == "1" {
			if cfg, cfgErr := config.LoadDefaultConfig(ctx); cfgErr == nil {
				vopts.PolicyChecker = accessanalyzer.NewFromConfig(cfg)
				fmt.Fprintln(stdout, "Verification: IAM Access Analyzer corroboration enabled")
			} else {
				fmt.Fprintf(stderr, "Warning: Access Analyzer disabled (AWS config load failed: %v)\n", cfgErr)
			}
		}
		if vrep, vErr := verify.EvaluateWithOptions(ctx, planJSON, vopts); vErr != nil {
			fmt.Fprintf(stderr, "Warning: verification gate failed to run: %v\n", vErr)
		} else {
			result.VerifyReport = vrep
			fmt.Fprintf(stdout, "Verification gate: verdict=%s (pass=%d fail=%d warn=%d not_evaluable=%d, catalog %s)\n",
				vrep.Verdict, vrep.Summary.Pass, vrep.Summary.Fail, vrep.Summary.Warn, vrep.Summary.NotEvaluable, vrep.CatalogVersion)
			for _, c := range vrep.Controls {
				if c.Status == verify.StatusFail || c.Status == verify.StatusWarn {
					for _, f := range c.Findings {
						fmt.Fprintf(stdout, "  [%s/%s] %s: %s\n", c.ID, c.Status, f.Address, f.Message)
					}
				}
				if c.Coverage != "" {
					fmt.Fprintf(stdout, "  [%s] coverage: %s\n", c.ID, c.Coverage)
				}
			}
		}
	} else {
		fmt.Fprintln(stdout, "Verification gate: SKIPPED (no plan JSON) — coverage gap, not a pass")
	}

	// Version-compatibility gate (compat matrix, #1215). The second gate alongside
	// elench verify: evaluate the RESOLVED config (cluster K8s minor × enabled add-ons
	// against the compat matrix) rather than the plan JSON. The engine is pure and
	// deterministic — an unrecorded version yields honest not_evaluable, never a silent
	// pass — so the report is ALWAYS attached (for both plan and apply jobs; the console
	// renders it, #1219). The fail-closed ENFORCEMENT happens just before apply, below.
	compatSubject := compat.Subject{
		Providers:  []string{params.Provider},
		K8sVersion: vc.Cluster.ClusterVersion,
		AddOns:     compatAddOnRefs(vc.AddOns),
		// Components deliberately unset: the config-time subject omits them too, and
		// component/K8s couplings are covered by the matrix's own drift test. Add-on and
		// K8s-cloud couplings are the apply-gate's fail domain here.
	}
	crep := compat.Evaluate(compatSubject)
	result.CompatReport = crep
	fmt.Fprintf(stdout, "Compatibility gate: verdict=%s (pass=%d fail=%d warn=%d not_evaluable=%d, catalog %s)\n",
		crep.Verdict, crep.Summary.Pass, crep.Summary.Fail, crep.Summary.Warn, crep.Summary.NotEvaluable, crep.CatalogVersion)
	for _, c := range crep.Controls {
		if c.Status == compat.StatusFail || c.Status == compat.StatusWarn {
			for _, f := range c.Findings {
				fmt.Fprintf(stdout, "  [%s/%s] %s: %s\n", c.ID, c.Status, f.Address, f.Message)
			}
		}
		if c.Coverage != "" {
			fmt.Fprintf(stdout, "  [%s] coverage: %s\n", c.ID, c.Coverage)
		}
	}

	if params.InfracostToken != "" {
		infracostEnv := []string{"INFRACOST_API_KEY=" + params.InfracostToken}
		infracostCLI := infracost.NewInfracostCLI(infracost.ResolvedInfracostVersion(), params.InfracostToken)
		infracostInput := planFile
		if planJSONFile != "" {
			infracostInput = planJSONFile
		}
		costBreakdown, err := infracostCLI.RunInfracost(infracostInput, infracostEnv)
		if err != nil {
			fmt.Fprintf(stderr, "Warning: Infracost analysis failed: %v\n", err)
		} else if costBreakdown != nil {
			result.CostBreakdown = costBreakdown
		}
	}

	if params.DryRun {
		if planBytes, readErr := os.ReadFile(planFile); readErr == nil {
			result.PlanFileBytes = planBytes
		}
		// Plan jobs get an (advisory) evidence receipt too, so the console can show
		// the verdict + signed receipt before any apply is approved.
		attachReceipt(&result, planFile, planJSON, nil, stdout)
		fmt.Fprintln(stdout, "Dry-run complete. Plan and cost analysis finished.")
		return &result, nil
	}

	// Fail-closed cost guard (opt-in; e2e cost safety). When a monthly-USD ceiling is
	// configured, a real apply must not proceed if the Infracost estimate exceeds it — or if
	// no estimate could be produced at all (a ceiling was asked for but the plan couldn't be
	// priced). A zero ceiling (the default) is a no-op, so every existing caller is unchanged;
	// enabling it requires a working INFRACOST_API_KEY. Runs only on the real-apply path
	// (dry-run/plan jobs already returned above and never block on cost).
	if blocked, msg := costCeilingBlock(result.CostBreakdown, params.CostCeilingMonthlyUSD); blocked {
		telemetry.GateBlocked(ctx, provider.Name())
		return nil, fmt.Errorf("%s", msg)
	}

	// Fail-closed backstop: a real apply must never proceed without a conclusive
	// verification verdict. If the plan JSON could not be produced (ShowPlanJSON
	// errored, or tofu emitted no JSON) the gate could not evaluate the plan at
	// all, so we REFUSE the apply rather than silently skipping enforcement — a
	// missing report must never read as an implicit pass. An authorized operator
	// may still proceed by waiving the ControlPlanUnavailable sentinel in
	// VerifyOverride (per-apply, audited, expiry-bounded); disabling the gate
	// wholesale remains impossible. No-op when a report exists (the report's own
	// enforcement runs just below) and on dry-run (already returned above).
	if err := gateRequiresReport(params.DryRun, result.VerifyReport, params.VerifyOverride, showErr); err != nil {
		telemetry.GateBlocked(ctx, provider.Name())
		return nil, err
	}
	if result.VerifyReport == nil && params.VerifyOverride.Covers(verify.ControlPlanUnavailable) {
		fmt.Fprintf(stdout, "Verification override applied by %q: proceeding without a plan-JSON verdict (control %s, reason: %s)\n",
			params.VerifyOverride.By, verify.ControlPlanUnavailable, params.VerifyOverride.Reason)
	}

	// Fail-closed enforcement: a real apply must not proceed while any hard
	// verification control is failing and unwaived. An authorized override may
	// waive specific controls (recorded for the evidence receipt in Phase 1);
	// disabling the gate wholesale is deliberately not an option here.
	if result.VerifyReport != nil {
		if unresolved := result.VerifyReport.Unwaived(params.VerifyOverride); len(unresolved) > 0 {
			// Metric: a fail-closed gate block (low-cardinality provider label only).
			telemetry.GateBlocked(ctx, provider.Name())
			return nil, fmt.Errorf("verification gate BLOCKED apply: failing controls %v (catalog %s) — fix the plan or supply an authorized override to proceed",
				unresolved, result.VerifyReport.CatalogVersion)
		}
		if params.VerifyOverride != nil && len(params.VerifyOverride.Controls) > 0 {
			fmt.Fprintf(stdout, "Verification override applied by %q for controls %v (reason: %s)\n",
				params.VerifyOverride.By, params.VerifyOverride.Controls, params.VerifyOverride.Reason)
		}
	}

	// Fail-closed compatibility enforcement (COMPAT-001): a real apply must not proceed
	// while any hard compat control is failing and unwaived. Mirrors the verify gate above
	// 1:1 through the shared Unwaived/Override machinery — an authorized operator may waive
	// specific failing controls (COMPAT-COMPONENT-*/COMPAT-ADDON-*/…); disabling the gate
	// wholesale is deliberately not an option. A nil/not_evaluable report is NON-blocking by
	// contract (the honesty surface), so — unlike verify's missing-plan-JSON — there is no
	// gateRequiresReport backstop: the engine always produces a conclusive verdict.
	if result.CompatReport != nil {
		if unresolved := result.CompatReport.Unwaived(params.CompatOverride); len(unresolved) > 0 {
			telemetry.GateBlocked(ctx, provider.Name())
			return nil, fmt.Errorf("compatibility gate (%s) BLOCKED apply: failing controls %v (catalog %s) — fix the config (K8s minor / add-on versions) or supply an authorized override to proceed",
				compat.ControlGateID, unresolved, result.CompatReport.CatalogVersion)
		}
		if params.CompatOverride != nil && len(params.CompatOverride.Controls) > 0 {
			fmt.Fprintf(stdout, "Compatibility override applied by %q for controls %v (reason: %s)\n",
				params.CompatOverride.By, params.CompatOverride.Controls, params.CompatOverride.Reason)
		}
	}

	// Seal the evidence receipt for this apply (records any applied override as an
	// exception) before mutating any infrastructure.
	attachReceipt(&result, planFile, planJSON, params.VerifyOverride, stdout)

	// Mark the apply phase BEFORE mutating any infrastructure. A mid-flight cancel from
	// here on may leave cloud resources not yet recorded in state, so the runner reads
	// this marker to flag orphan risk on the cancelled job. Best-effort — a write failure
	// only loses precision (the runner defaults to "no orphan risk"), never blocks apply.
	writePhase(params.PhaseFile, "apply")

	setStage("apply")
	fmt.Fprintln(stdout, "Applying OpenTofu changes...")
	if err := tf.Apply(ctx, planFile); err != nil {
		// A FAILED apply can leave a real cloud resource OUTSIDE tofu state (issue #526): the cloud
		// accepts the create, then fails it asynchronously (capacity/quota/policy), so tofu's create
		// errors and NEVER records it. The environment is then PERMANENTLY WEDGED — every later apply
		// dies with `already exists ... needs to be imported`. Until now that was silent: orphan_risk
		// fired only on an INTERRUPTED apply, so we reported orphan_risk=false on precisely the
		// failure that bricked the customer.
		//
		// Classify on POSITIVE EVIDENCE only (ClassifyApplyError, orphan.go). An ordinary failure —
		// a validation error, a quota rejection BEFORE create — yields OrphanNone and is NOT flagged,
		// which preserves the "normal failures do not over-alert" property the original design was
		// right to protect. Diagnosing this here (rather than leaving the customer to hit an
		// inscrutable "already exists" on their next deploy) is the whole point.
		if f := ClassifyApplyError(err, ""); f.Orphaned() {
			fmt.Fprintf(stderr, "\nORPHAN RISK (%s): %s\n", f.Evidence, f.Reason)
			return nil, &ApplyOrphanError{Err: err, Finding: f}
		}
		return nil, fmt.Errorf("tofu apply failed: %w", err)
	}
	// Apply returned cleanly ⇒ tofu state is fully persisted, so nothing is orphaned OUTSIDE
	// state. Reset the phase marker: without this it stays "apply" through every post-apply
	// stage (kubeconfig, CNI bootstrap, the reachability gate, argocd, addons), and an
	// interruption there (2h deadline, drain) would FALSELY flag orphan_risk on a deploy whose
	// resources are all tracked. "apply" must mean strictly "apply in-flight / state maybe not
	// yet persisted" — the true orphan window.
	writePhase(params.PhaseFile, "applied")

	outputs, err := tf.Output(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get tofu outputs: %w", err)
	}

	result.Outputs = outputs
	result.ClusterName = cloud.ExtractClusterName(outputs)
	result.ClusterEndpoint = cloud.ExtractClusterEndpoint(outputs)

	if result.ClusterName != "" {
		setStage("kube_configure")
		// Kubeconfig is mandatory: without it the cluster is unreachable, ArgoCD can't
		// install, and "SUCCESS" would be a lie. Fail the deploy loudly.
		if err := provider.ConfigureKubeconfig(ctx, vc, outputs, stdout); err != nil {
			return nil, fmt.Errorf("kubeconfig configuration failed — the cluster was provisioned but is unreachable: %w", err)
		}
		if !params.DryRun {
			// Bootstrap CNI + cloud integration for SELF-MANAGED clusters (Talos ships
			// CNI=none, so nodes stay NotReady until this is applied). The template emits
			// these as the `bootstrap_manifests` output — rendered offline, applied here via
			// kubectl rather than in-tofu, which keeps `tofu plan -out` resolvable (no
			// cluster-wired provider) AND stays under Hetzner's 32 KiB cloud-init user_data
			// limit (Cilium alone busts it as a Talos inlineManifest). No-op for managed
			// clusters, which get CNI from the cloud and emit no such output.
			if err := applyBootstrapManifests(ctx, outputs, stdout, stderr); err != nil {
				return nil, fmt.Errorf("failed to bootstrap cluster CNI/cloud integration: %w", err)
			}
			// Reachability gate: prove the API server answers and nodes reach Ready before we
			// call this a working cluster (was: SUCCESS meant only that `tofu apply` exited 0).
			if err := k8s.WaitClusterReady(ctx, clusterReadyTimeout(), clusterReadyRequireNode(), stdout); err != nil {
				return nil, fmt.Errorf("cluster provisioned but not reachable: %w", err)
			}
			// Datapath gate: WaitClusterReady probes the API from the RUNNER (node public IP) and
			// counts Ready nodes — it cannot see whether an ordinary POD can reach the apiserver
			// across the cluster network. A broken pod datapath (e.g. cross-node pod->apiserver)
			// passes the checks above yet breaks every real workload. Only meaningful with a node
			// to schedule on (skip Karpenter-only / node-less clusters).
			if clusterReadyRequireNode() {
				if err := k8s.WaitPodToAPIServer(ctx, clusterReadyTimeout(), stdout); err != nil {
					return nil, fmt.Errorf("cluster provisioned but its pod network is broken: %w", err)
				}
			}
			result.ClusterReady = true
		}
	}

	if !params.DryRun && result.ClusterName != "" {
		// GitOps bootstrap. The cluster is provisioned; ArgoCD + the infra-services
		// (external-dns, karpenter, ALB controller, …) and the user's apps-repo
		// connection are the "GitOps, wired — not just installed" promise. These steps
		// FAIL the job rather than logging a buried warning: a half-wired cluster that
		// reports success is worse than an honest failure the operator can act on.
		gitopsRequested := vc.Repositories.AppsDestinationRepo != ""
		// On any wiring hard-fail below, record WHICH step died (+ a token-sanitized
		// message) on the partial result — the sandbox writes result.json even on error,
		// so the console can show an actionable GitOps failure, not just a failed job.
		gitopsFailed := func(step string, err error) *argocd.GitopsStatus {
			// Redact EVERY git token that could appear in the message — the apps-repo token and every
			// BYO per-repo token — not just GitAccessToken (#948).
			return gitopsFailure(gitopsRequested, vc.Repositories.AppsDestinationRepo, step, err,
				gitTokenValues(params.GitAccessToken, params.GitRepoTokens)...)
		}

		setStage("argocd")
		if err := installArgoCD(ctx, vc, result.Outputs, &result, stdout, stderr); err != nil {
			result.GitopsStatus = gitopsFailed(argocd.GitopsStepArgocdInstall, err)
			return &result, argocdInstallError(err)
		}

		if gitopsRequested {
			switch {
			case params.GitAccessToken != "":
				// Private or public: register the token so ArgoCD authenticates its clones.
				if err := argocd.ConfigureRepoCredentials(vc.Repositories.AppsDestinationRepo, params.GitAccessToken, stdout, stderr); err != nil {
					result.GitopsStatus = gitopsFailed(argocd.GitopsStepRepoCredentials, err)
					return &result, fmt.Errorf("failed to connect ArgoCD to apps repo %s: %w", vc.Repositories.AppsDestinationRepo, err)
				}
			case argocd.IsRepoAnonymouslyCloneable(ctx, vc.Repositories.AppsDestinationRepo):
				// A PUBLIC apps repo needs no credential — ArgoCD clones it anonymously, exactly as
				// the probe just did. This keeps the keyless promise honest for public GitOps repos
				// (the enterprise-demo) without weakening anything: a private repo cannot answer the
				// anonymous ref-advertisement 200, so it still falls through to the error below.
				fmt.Fprintf(stdout, "Apps repo %s is publicly cloneable — ArgoCD will clone it anonymously; no git token required.\n", vc.Repositories.AppsDestinationRepo)
			default:
				err := fmt.Errorf("GitOps requested (apps repo %s) but no git access token is available and the repo is not anonymously cloneable — connect the git provider for the job owner, or make the repo public", vc.Repositories.AppsDestinationRepo)
				result.GitopsStatus = gitopsFailed(argocd.GitopsStepGitToken, err)
				return &result, err
			}
		}

		argoTemplatesDir := resolveArgoTemplatesDir()
		if argoTemplatesDir == "" {
			// Templates are baked into the runner image; their absence is a build defect,
			// not a user error. Silently skipping infra-services left clusters half-wired.
			err := fmt.Errorf("ArgoCD application templates not found (looked in /home/runner/argocd-templates, argocd-templates, ../../infra/templates/argocd) — the runner image is missing its baked templates")
			result.GitopsStatus = gitopsFailed(argocd.GitopsStepTemplatesMissing, err)
			return &result, err
		}
		// apps_path now reaches the dedicated templates too, so it gets the same fail-closed guard
		// the namespace and vcluster placements apply (deploy_vcluster.go, namespace_tenant.go). It
		// is interpolated into a YAML scalar the runner hands to ArgoCD, so an absolute path, a
		// traversal or a quote-break must be refused here rather than rendered.
		if err := argocd.ValidateAppsPath(vc.Repositories.AppsPath); err != nil {
			result.GitopsStatus = gitopsFailed(argocd.GitopsStepTemplatesMissing, err)
			return &result, fmt.Errorf("apps_path is not a usable repo subpath: %w", err)
		}
		facts := argocd.BuildFromOutputs(result.Outputs, vc)
		// Record the honest per-service install/skip decisions from the SAME gates the
		// render below uses, so the console/CLI can show what shipped (and why a service
		// was skipped) instead of guessing from output presence.
		result.InfraServices = argocd.InfraServiceDecisions(facts)
		// external-dns may need a Secret to exist BEFORE the Application's first sync — a
		// connector token on cloudflare/hetzner, the keyless azure.json on azure, nothing at all
		// on aws and google. WHICH, and with what contents, is decided by argocd.ExternalDNSSeedFor:
		// a pure function reading the same DNSProvider() gate the render does. It lives there
		// rather than as a `switch` here because nothing in this function is reachable without a
		// live cluster, so every branch of that switch was measured as dead code (#2868).
		if err := argocd.EnsureExternalDNSCredential(facts,
			vc.ConnectorCredentialFor("dns", "cloudflare")["api_token"],
			os.Getenv("HCLOUD_TOKEN"), stdout, stderr); err != nil {
			return nil, fmt.Errorf("failed to seed the external-dns secret: %w", err)
		}
		renderedDir, renderErr := argocd.RenderApplications(argoTemplatesDir, facts)
		if renderErr != nil {
			result.GitopsStatus = gitopsFailed(argocd.GitopsStepRender, renderErr)
			return &result, fmt.Errorf("failed to render ArgoCD applications: %w", renderErr)
		}
		defer os.RemoveAll(renderedDir)
		if applyErr := argocd.ApplyApplications(renderedDir, stdout, stderr); applyErr != nil {
			result.GitopsStatus = gitopsFailed(argocd.GitopsStepApply, applyErr)
			return &result, fmt.Errorf("failed to apply ArgoCD infrastructure applications: %w", applyErr)
		}
		// The per-cloud external-secrets ClusterSecretStore is a CR of the operator applied just
		// above; apply it separately AFTER, once the operator's ArgoCD-synced CRD + validating
		// webhook are up, so it never races/poisons the operator's own apply on a fresh cluster
		// (#1208 — mixing it into the operator's client-side apply file could deadlock the whole
		// deploy). Non-fatal, like the Karpenter node class below: the store is NOT an ArgoCD app and
		// is NOT required for a healthy cluster (cluster_ready + the ArgoCD apps already converged),
		// so a slow ArgoCD-installed operator webhook must not fail an otherwise-healthy deploy — the
		// apply is idempotent and reconciles on the next deploy once the operator is ready.
		//
		// A pluggable SaaS secret store (Vault / OpenBao / Doppler / generic / Infisical) reads its
		// credentials from an in-cluster Secret the ClusterSecretStore's auth.secretRef names — seed
		// it BEFORE applying the store. The credentials come from the job's ConnectorCredentials
		// (never the snapshot) and land only in the in-cluster Secret. facts.SecretsSaaS is nil
		// (fail-closed) when the store's credential/config is absent, so this is skipped exactly
		// when no store will render.
		//
		// The store declares WHICH credential fields it needs (Creds) rather than this caller assuming
		// a single "token": infisical's Universal Auth needs client_id + client_secret, and hardcoding
		// one field here would seed a store that can never authenticate.
		if facts.SecretsSaaS != nil {
			creds := vc.ConnectorCredentialFor("secrets", facts.SecretsSaaS.Slug)
			data := make([]argocd.SecretsStoreCredential, 0, len(facts.SecretsSaaS.Creds))
			for _, c := range facts.SecretsSaaS.Creds {
				data = append(data, argocd.SecretsStoreCredential{Key: c.Key, Value: creds[c.CredentialField]})
			}
			if err := argocd.EnsureSecretsStoreCredential(facts.SecretsSaaS.Namespace, facts.SecretsSaaS.CredSecret, data, stdout, stderr); err != nil {
				return nil, fmt.Errorf("failed to seed the %s external-secrets store credential: %w", facts.SecretsSaaS.Slug, err)
			}
		}
		if esErr := argocd.EnsureExternalSecretsStore(facts, stdout, stderr); esErr != nil {
			fmt.Fprintf(stderr, "Warning: external-secrets ClusterSecretStore not applied yet "+
				"(will reconcile once the operator webhook is ready): %v\n", esErr)
		}
		// The cert-manager ACME DNS01 ClusterIssuer, on the same terms and for the same #1208
		// reason as the store above: it is a CR whose CRD + webhook the cert-manager Application
		// installs asynchronously, so it is applied on its own with a bounded retry. No-op unless
		// cert-manager actually renders for this deploy. NON-fatal: the issuer is idempotent and
		// reconciles on the next deploy, so a slow webhook must not fail a healthy cluster.
		if cmErr := argocd.EnsureCertManagerIssuer(facts, stdout, stderr); cmErr != nil {
			fmt.Fprintf(stderr, "Warning: cert-manager ClusterIssuer not applied yet "+
				"(will reconcile once the controller webhook is ready): %v\n", cmErr)
		}
		// Post-apply Karpenter node class (AWS + enable_karpenter only). Karpenter launches EC2
		// via its OWN AWS API calls, so the OpenTofu provider default_tags never reach them — the
		// EC2NodeClass spec.tags (from the karpenter_node_tags output) is the ONLY lever that
		// stamps the classification + sweep-handle tags onto launched instances/volumes (gap G2).
		// Non-fatal like the add-on path: a node-class hiccup must not fail an otherwise-healthy
		// cluster — the operator sees the warning and Karpenter still runs (it just can't scale
		// until the CR lands). The apply retries because the CRDs sync in asynchronously.
		setStage("karpenter")
		if kErr := applyKarpenterNodeClass(ctx, result.Outputs, facts, stdout, stderr); kErr != nil {
			fmt.Fprintf(stderr, "Warning: Karpenter EC2NodeClass/NodePool setup skipped: %v\n", kErr)
		}
		// Remove infra-service objects earlier deploys applied but this render skipped
		// (pre-parity clusters carry a broken external-dns / a foreign-cloud secret store).
		argocd.CleanupSkippedInfraServices(facts, stdout, stderr)

		// An in-cluster Harbor (a Hetzner `registry` node) needs credentials nothing else provides:
		// unlike ECR / Artifact Registry / ACR there is no node identity to authenticate with. Seed
		// Harbor credentials (once — see EnsureHarborSecret), pre-create the pull Secret so the
		// bootstrap Job needs no name-unscopable `create` right, then apply the Job that mints a
		// project-scoped PULL robot from INSIDE the cluster, which is the only place Harbor's API
		// answers.
		//
		// Non-fatal, like the add-on and Karpenter paths: a registry that has not finished converging
		// must not fail an otherwise-healthy cluster. The Job retries on its own, and the next deploy
		// re-runs this — which is a no-op when the credential already works.
		credentialInClusterRegistries(ctx, vc, stdout, stderr)

		// An in-cluster RabbitMQ (a Hetzner `queue` node) needs its password and erlang cookie to
		// exist BEFORE its Application syncs, because the chart now only READS them (#3304). This
		// runs ahead of both EnsureAddOnSecrets and ApplyAddOnsInWaves below, which is the ordering
		// that matters — a queue whose Secret arrives late is a StatefulSet stuck at
		// CreateContainerConfigError until the next reconcile.
		// STOPS the deploy on one error only — see the function. The ordering above is why: this runs
		// ahead of ApplyAddOnsInWaves, so refusing here is what keeps an Application whose
		// `auth.existingSecret` names a Secret we could not write from reaching the cluster at all.
		if err := credentialInClusterQueues(vc, stdout, stderr); err != nil {
			return nil, err
		}

		// A pluggable container-registry connector's dockerconfigjson imagePullSecret is seeded
		// HERE, post-apply, over the authenticated kubeconfig — NOT in tofu, whose kubernetes
		// provider is host+CA-only on AWS and cannot create it. Must land before the app pods that
		// reference it (manifests.Options.ImagePullSecrets) sync. Credentials come from the job's
		// ConnectorCredentials (never the snapshot); the payload is never logged.
		if pullSpec, pullErr := categories.DominantRegistryPullSecretSpec(vc); pullErr != nil {
			return nil, fmt.Errorf("failed to build the registry pull secret: %w", pullErr)
		} else if pullSpec != nil {
			if err := argocd.EnsureRegistryPullSecret(pullSpec.Name, pullSpec.Namespace, pullSpec.DockerConfigJSON, stdout, stderr); err != nil {
				return nil, fmt.Errorf("failed to seed the registry pull secret: %w", err)
			}
		}

		// Generate app manifests for detected services into an EMPTY apps repo (never
		// clobbers a bring-your-own repo). Non-fatal: a git edge case must not fail an
		// otherwise-healthy cluster — the operator can add manifests later.
		manifestWarnings, keylessBindings, genErr := generateAppManifests(ctx, vc, result.Outputs, params.GitAccessToken, facts, stdout, stderr)
		if genErr != nil {
			fmt.Fprintf(stderr, "Warning: app manifest generation skipped: %v\n", genErr)
		}
		// Attached to the RESULT, not to GitopsStatus: the keyless decisions are a security posture
		// fact about the deploy, and GitopsStatus is nil on every path that skipped the wiring. They
		// survive a genErr for the same reason the warnings do — a partial render's decisions are
		// exactly what explains a half-wired app.
		result.KeylessBindings = keylessBindings

		// A keyless binding that failed closed on a LIVE cell fails the deploy (#1790).
		//
		// Fail-closed at render time was always right — the alternative is silently handing the
		// workload a password the operator asked us not to use. What was wrong is what happened
		// next: the refusal became a warning on a job reporting success, so "keyless binding
		// omitted" and "deploy succeeded" were the same event, and the app came up with no database
		// environment at all. That is how the missing ALETHIA_RUNNER_IMAGE (#1787) stayed invisible
		// long enough to hold up two programs.
		//
		// The severity turns on the CELL, not on the refusal. An excluded or pending cell is a
		// product boundary doing its job — the canvas disables the toggle there and the server gate
		// at projects.ts already throws — so it stays a warning. A LIVE cell is one we claim to
		// support: a refusal there is always a defect on our side, and is exactly the case nobody
		// was being told about.
		//
		// Runs after the apply, so the infrastructure exists and stays. What the failure reports is
		// the truth — the app wiring did not complete. Deliberately not overridable: unlike
		// COMPAT-001 there is nothing here for an operator to weigh. A live cell that cannot wire is
		// our bug to fix, not their risk to accept.
		if failed := liveCellKeylessFailures(keylessBindings); len(failed) > 0 {
			return nil, fmt.Errorf(
				"keyless database binding failed closed on %d supported cell(s), leaving the workload with no database credentials: %s",
				len(failed), strings.Join(failed, "; "))
		}

		setStage("addons")
		// Seed the ArgoCD repository credentials for any connected private Helm/OCI chart repos
		// (helm_registry connectors) BEFORE the add-on / BYO Applications sync — ArgoCD matches these
		// to an Application by repoURL, so the credential must pre-exist its first sync. Runner-seeded
		// post-apply (never in git); credentials come from the job's ConnectorCredentials, never
		// logged. Non-fatal: a misconfigured repo surfaces as an OutOfSync Application and must not
		// fail an otherwise-healthy cluster (a bad entry is skipped fail-closed, never half-seeded).
		var desiredHelmRepoCreds []string
		helmRepoSpecs, helmRepoErr := categories.HelmRepoCredSpecs(vc)
		if helmRepoErr != nil {
			fmt.Fprintf(stderr, "Warning: some Helm repo credentials were skipped: %v\n", helmRepoErr)
		}
		for _, s := range helmRepoSpecs {
			if err := argocd.EnsureHelmRepoCredential(s.Name, s.URL, s.Username, s.Password, s.EnableOCI, stdout, stderr); err != nil {
				fmt.Fprintf(stderr, "Warning: could not seed Helm repo credential %s: %v\n", s.Name, err)
				continue
			}
			desiredHelmRepoCreds = append(desiredHelmRepoCreds, s.Name)
		}
		// KEYLESS OCI ECR chart repos (#1185): ECR issues a ~12h token, so there is no static
		// password to seed above. Instead, for each connected ECR helm_registry, render + apply a
		// standalone in-cluster refresher (the runner's `helm-repo-token` loop under the tofu
		// helm-repo-pull IRSA) that mints + patches the repo-helm-<hash> Secret's credentials on a
		// loop. Dark by default: only ALETHIA_XACCT_HELM_ECR_ENABLED=true renders anything.
		// Fail-closed: a missing pull-identity output means the refresher is NOT applied (the private
		// chart pull just can't authenticate — surfaced, not silent), never a half-wired refresher.
		// Non-fatal like the static path. Each target's placeholder Secret is added to
		// desiredHelmRepoCreds so the prune below keeps it; the refresher unit names feed
		// PruneHelmRepoRefreshers.
		var desiredHelmRepoRefreshers []string
		if os.Getenv("ALETHIA_XACCT_HELM_ECR_ENABLED") == "true" {
			irsa, _ := result.Outputs["helm_repo_pull_irsa_arn"].(string)
			res := renderKeylessHelmRefreshers(vc, irsa, selfimage.Ref())
			if res.SkippedTargets != nil {
				fmt.Fprintf(stderr, "Warning: some keyless Helm ECR targets were skipped: %v\n", res.SkippedTargets)
			}
			switch {
			case res.Skip != "":
				fmt.Fprintln(stderr, "Warning: "+res.Skip)
			case res.Manifest != "":
				if applyErr := argocd.ApplyManifest(res.Manifest, stdout, stderr); applyErr != nil {
					fmt.Fprintf(stderr, "Warning: could not apply keyless Helm ECR refreshers: %v\n", applyErr)
				} else {
					desiredHelmRepoCreds = append(desiredHelmRepoCreds, res.DesiredSecrets...)
					desiredHelmRepoRefreshers = append(desiredHelmRepoRefreshers, res.DesiredRefreshers...)
					fmt.Fprintf(stdout, "Applied %d keyless Helm ECR chart-repo refresher(s)\n", len(res.DesiredRefreshers))
				}
			}
		}
		// Marketplace add-ons — MANAGED mode: render the customer's enabled OSS charts as
		// ArgoCD Helm Applications and apply them; GITOPS mode: seed the manifests into the
		// customer's apps repo (they own + edit them). Then prune disabled managed add-ons and
		// read health back for the console. Non-fatal (like app-manifest generation): a bad
		// add-on must not fail an otherwise-healthy cluster; status surfaces on the add-ons page.
		// The BYO binding ExternalSecrets this deploy (re)applies — the desired set for the prune
		// below (declared out here so a fully-detached chart, vc.AddOns empty, still sweeps them).
		var appliedBindingSecrets []string
		if len(vc.AddOns) > 0 {
			// Operator wave FIRST (the manifest rail): Kubernetes operators ship as a plain
			// `kubectl apply` release manifest, which an ArgoCD Application cannot source. The
			// runner applies them server-side and waits for the CRDs they own to become
			// Established — so a CR Application synced below (a RabbitmqCluster, a CNPG Cluster)
			// can never race the operator that owns its schema. ArgoCD sync-waves do NOT order
			// across separate top-level Applications, so this ordering must happen here.
			if mErr := argocd.ApplyManifestAddOns(ctx, vc.AddOns, stdout, stderr); mErr != nil {
				fmt.Fprintf(stderr, "Warning: operator manifest add-ons failed: %v\n", mErr)
			}

			// Bring-your-own (git-source) charts: pin them to a hardened per-project AppProject
			// and register their per-repo credentials BEFORE rendering the Applications, so the
			// renderer places them in "byo-<slug>" (not the wide-open "infra" project).
			prepareByoCharts(vc, params.GitAccessToken, params.GitRepoTokens, facts.Labels, stdout, stderr)

			// Seed each add-on's secret-knob Secret (W4.5 #640) BEFORE any Application syncs —
			// managed or gitops mode. The values were fetched by the runner over the
			// authenticated job channel and exist nowhere else: not in the snapshot, not in the
			// rendered manifest, not in the customer's repo. The chart consumes them via the
			// SecretKeyRef wiring the console resolved into helm.values.
			argocd.EnsureAddOnSecrets(vc.AddOns, params.AddOnSecretValues, stdout, stderr)

			// W5 Lane 2b: resolve each BYO chart workload's W3 bindings into its chart Values now
			// (runtime, against the tofu outputs) + seed their keyless binding ExternalSecrets —
			// BEFORE the Applications render, so the write-back rides the same helm.values block.
			appliedBindingSecrets = applyByoChartBindings(vc, result.Outputs, params.Provider, stdout, stderr)

			// Resolve the platform-provisioned cloud identity into the add-on's values BEFORE the
			// Applications render — the same seam, and the same reason, as applyByoChartBindings
			// above: the value exists only in this run's tofu outputs, and the console that stored
			// the knob could not have known it. Mutating vc.AddOns rather than the rendered output
			// also means writeAddOnGitOps below writes the resolved value into the customer's repo,
			// which is correct and free.
			if err := argocd.ResolveAddOnCloudIdentity(vc.AddOns, facts, stdout, stderr); err != nil {
				return nil, fmt.Errorf("external-dns identity resolution failed: %w", err)
			}

			addonDir, addonErr := argocd.RenderManagedAddOns(vc.AddOns, facts.Labels)
			if addonErr != nil {
				fmt.Fprintf(stderr, "Warning: marketplace add-ons skipped: %v\n", addonErr)
			} else {
				defer os.RemoveAll(addonDir)
				// Apply the Applications in ascending sync-wave order, waiting after each wave for
				// the CRDs it establishes. ArgoCD's sync-wave annotation does NOT order separate
				// top-level Applications, so a Helm operator (CloudNativePG) and an Application
				// carrying a CR that needs its schema (a CNPG Cluster) would otherwise race — the
				// CR's first sync failing with `no matches for kind`.
				if applyErr := argocd.ApplyAddOnsInWaves(vc.AddOns, addonDir, stdout, stderr); applyErr != nil {
					fmt.Fprintf(stderr, "Warning: marketplace add-ons apply failed: %v\n", applyErr)
				}
			}
			// GitOps-mode add-ons → seed/prune into the customer's apps repo.
			if gitErr := writeAddOnGitOps(ctx, vc, params.GitAccessToken, facts.Labels, stdout, stderr); gitErr != nil {
				fmt.Fprintf(stderr, "Warning: GitOps add-on sync skipped: %v\n", gitErr)
			}
			// One-shot in-cluster bootstraps for the add-ons that ask for one — today, initialising
			// and unsealing a marketplace Vault (#2717).
			//
			// HERE, and the position is load-bearing in both directions. AFTER the Applications are
			// applied, because the Job talks to a Service that does not exist until then. BEFORE
			// WaitAddOnsHealthy below, because a sealed Vault never becomes Healthy — waiting first
			// would burn the whole add-on budget and then unseal it too late to be observed. The
			// apply does not block on the Job finishing; the wait that follows is what sees the
			// result.
			argocd.EnsureAddOnBootstraps(vc.AddOns, selfimage.Ref(), stdout, stderr)
		}
		// Prune managed add-ons the user disabled (removed from the desired set). Runs even
		// when vc.AddOns is empty, so disabling the last add-on still cleans it up.
		if pruneErr := argocd.PruneManagedAddOns(argocd.ManagedAddOnNames(vc.AddOns), stdout, stderr); pruneErr != nil {
			fmt.Fprintf(stderr, "Warning: add-on prune failed: %v\n", pruneErr)
		}
		// W5 Lane 2b: sweep any BYO binding ExternalSecret no longer desired (a removed binding or a
		// detached chart) — they are runner-applied outside ArgoCD, so this is their only GC.
		argocd.PruneChartBindingSecrets(appliedBindingSecrets, stdout, stderr)
		// And the runner-seeded secret of any disabled add-on (W4.5) — no Application owns
		// those Secrets (deliberately: no ArgoCD tracking metadata), so ArgoCD will never
		// prune them; this is their only GC.
		argocd.PruneAddOnSecrets(enabledAddonIDs(vc.AddOns), stdout, stderr)
		// And the runner-seeded registry pull secret of any deselected registry — likewise owned
		// by no Application. Desired = the current dominant registry's "<slug>-pull" (empty when
		// native/none), so switching or removing a registry cleans up the stale secret.
		var desiredPullSecrets []string
		if n := categories.DominantRegistryPullSecret(vc); n != "" {
			desiredPullSecrets = []string{n}
		}
		argocd.PruneRegistryPullSecrets(desiredPullSecrets, stdout, stderr)
		// And the runner-seeded ArgoCD repo credential of any deselected private Helm/OCI chart repo —
		// likewise owned by no Application. Desired = the repos seeded above (empty when none connected),
		// so switching or removing a helm_registry connector cleans up the stale credential.
		argocd.PruneHelmRepoCredentials(desiredHelmRepoCreds, stdout, stderr)
		// And the keyless OCI ECR refresher (#1185) unit — Deployment/Role/RoleBinding — of any
		// deselected ECR helm_registry (owned by no Application; its placeholder Secret is swept by the
		// prune above). Desired = the refreshers applied above (empty when none / flag off), so removing
		// an ECR chart-repo connector tears its refresher down. The shared KSA is left in place.
		argocd.PruneHelmRepoRefreshers(desiredHelmRepoRefreshers, stdout, stderr)
		// Read ArgoCD health/sync for every enabled add-on (managed + gitops) so the console
		// shows real status (best-effort — a read failure just leaves status Unknown).
		//
		// WAIT for convergence first. The read used to run the instant after `kubectl apply`, when
		// every Application is still Progressing/Missing — so a database that was about to come up
		// perfectly was persisted as "Creating"… and nothing ever refreshed it (the day-2 refresh
		// only updates project_addons rows, and the synthesized Hetzner data-service specs have
		// none). The wait is bounded and best-effort: an add-on that never converges is reported
		// honestly rather than failing an otherwise-healthy cluster.
		if len(vc.AddOns) > 0 {
			result.AddOnStatus = argocd.WaitAddOnsHealthy(
				ctx,
				argocd.AllAddOnNames(vc.AddOns),
				addonConvergeTimeout(),
				stdout,
				stderr,
			)
			// Make each in-cluster RabbitMQ's BROKER accept the password its Secret holds (#3590).
			//
			// HERE, and both bounds are load-bearing. AFTER WaitAddOnsHealthy, because there is
			// nothing to exec into until the broker is Ready — before the wait this would skip on
			// every deploy and defer the repair forever. BEFORE ReadDataEndpoints, because that read
			// is what PUBLISHES the Secret to the console as the queue's credential: converging
			// first is the difference between publishing a password that works and publishing the
			// one this issue is about.
			//
			// It is a no-op on a queue whose broker already accepts it, which is every queue created
			// after #3304 — this exists for the ones created before it.
			convergeInClusterQueuePasswords(ctx, vc, stdout, stderr)

			// In-cluster data services (Hetzner database/cache/queue) are ArgoCD Applications, so
			// they have no tofu output carrying a connection string — the console showed NO endpoint
			// at all ("endpoint discovery is chart-specific and deferred"). Now that they've
			// converged, read their Service endpoint + credential REFERENCE back FROM THE CLUSTER.
			// Never derived from a chart's fullname template: a wrong endpoint is worse than none.
			if eps := argocd.ReadDataEndpoints(vc.AddOns, stdout, stderr); len(eps) > 0 {
				fmt.Fprintf(stdout, "Read %d in-cluster data-service endpoint(s).\n", len(eps))
				result.DataEndpoints = eps
			}
		}
		// The in-cluster Vault that carries Hetzner's `secret` kind (#2432). It runs HERE, after the
		// add-on stage, for a hard ordering reason: the Vault is itself an add-on Application, so
		// before this point there is no Vault for the bootstrap to reach and no Service for the
		// ClusterSecretStore to name. A no-op on every other cloud, which has a real secret store.
		bootstrapInClusterVault(ctx, vc, facts, stdout, stderr)
		// Read the cluster's Trivy-Operator vulnerability posture (L9). Best-effort +
		// unconditional: `Scanned=false` when Trivy isn't installed, so the Evidence Security
		// tab shows an honest "not scanned" rather than a misleading all-clear. Refreshed on
		// every deploy (Trivy scans asynchronously after it's installed).
		sec := argocd.ReadSecurityPosture(stdout, stderr)
		result.SecurityPosture = &sec
		// GitOps wiring surfaced honestly (issue #574): the wiring succeeded to here, so
		// record mode + (in gitops mode) the apps Application's synced revision and
		// per-workload health. Best-effort read — an unreadable status reports Unknown,
		// never a fabricated pass. Always non-nil after a real apply so the console can
		// tell "direct mode" from "pre-#574 job with no data".
		result.GitopsStatus = readGitopsSnapshot(gitopsRequested, vc.Repositories.AppsDestinationRepo, stdout, stderr)
		// Attach the manifest-generation warnings (skipped services, unresolved bindings,
		// unsatisfiable credential facets) so the console's Deploy tab can surface WHY a service
		// may be misconfigured, instead of the operator digging through raw deploy logs (#717).
		if result.GitopsStatus != nil {
			result.GitopsStatus.ManifestWarnings = manifestWarnings
		}
	}

	fmt.Fprintln(stdout, "Deployment completed successfully.")
	return &result, nil
}

// runnerIdentity is a best-effort identifier for the executor, recorded in the
// evidence receipt.
func runnerIdentity() string {
	if id := os.Getenv("ALETHIA_RUNNER_INSTANCE_ID"); id != "" {
		return id
	}
	if h, err := os.Hostname(); err == nil {
		return h
	}
	return "unknown-runner"
}

// attachReceipt builds, signs (if a key is configured), and attaches the per-apply
// evidence receipt to the result. It is a no-op when there is no verification
// report (e.g. the plan JSON could not be produced). `override` is the waiver that
// was applied on the apply path (nil on dry-run / plan jobs), recorded in the
// receipt as an exception.
func attachReceipt(result *PlanResult, planFile string, planJSON *tfjson.Plan, override *verify.Override, stdout io.Writer) {
	if result.VerifyReport == nil {
		return
	}
	planBytes, _ := os.ReadFile(planFile)
	tofuVer := ""
	if planJSON != nil {
		tofuVer = planJSON.TerraformVersion
	}
	receipt := verify.BuildReceipt(verify.BuildReceiptParams{
		Report:      result.VerifyReport,
		PlanBytes:   planBytes,
		TofuVersion: tofuVer,
		Override:    override,
		Runner:      runnerIdentity(),
		EvaluatedAt: time.Now().UTC().Format(time.RFC3339),
	})

	priv, keyID, ok, err := verify.SigningKeyFromEnv()
	if err != nil {
		fmt.Fprintf(stdout, "Warning: receipt signing key invalid: %v — attaching unsigned receipt\n", err)
	}
	if ok {
		if signed, sErr := verify.Sign(receipt, priv, keyID); sErr != nil {
			fmt.Fprintf(stdout, "Warning: receipt signing failed: %v — attaching unsigned receipt\n", sErr)
			result.VerifyReceipt = &verify.SignedReceipt{Receipt: receipt, Algorithm: "none"}
		} else {
			result.VerifyReceipt = signed
			fmt.Fprintf(stdout, "Evidence receipt signed (key %s, plan sha256 %s)\n", keyID, shortHash(receipt.PlanSHA256))
		}
		return
	}
	result.VerifyReceipt = &verify.SignedReceipt{Receipt: receipt, Algorithm: "none"}
	fmt.Fprintf(stdout, "Evidence receipt built (unsigned — set %s to sign)\n", verify.SigningKeyEnv)
}

func shortHash(h string) string {
	if len(h) <= 12 {
		return h
	}
	return h[:12] + "…"
}

func resolveArgoTemplatesDir() string {
	candidates := []string{
		// Explicit override — a runner image with a non-default layout, or an
		// in-process E2E driving the real spine from an arbitrary CWD, can point
		// directly at the baked templates.
		os.Getenv("ALETHIA_ARGOCD_TEMPLATES_DIR"),
		"/home/runner/argocd-templates",
		"argocd-templates",
		"../../infra/templates/argocd",
	}
	for _, d := range candidates {
		if d == "" {
			continue
		}
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			return d
		}
	}
	return ""
}

func installArgoCD(ctx context.Context, vc *types.ProjectConfig, outputs map[string]interface{}, result *PlanResult, stdout, stderr io.Writer) error {
	fmt.Fprintln(stdout, "Installing ArgoCD...")

	// FIRST, before anything else touches the cluster: refuse honestly if it already runs an
	// ArgoCD Alethia has measured as broken (#3126 item 2). The ORDER is the whole point — this
	// has to precede `helm repo add` and, critically, `ensureArgoRedisSecret`, which CREATES the
	// argocd namespace and writes a Secret into it. A guard that runs after its own side effects
	// cannot tell a fresh cluster from one it just touched.
	//
	// Returned UNWRAPPED. Four of the check's six states proceed (see argocd/version_preflight.go);
	// the two that stop are deliberate refusals, not failures, and prefixing them with "failed to
	// install ArgoCD" is how a refusal gets misread as a broken chart.
	decision, err := preflightArgoVersion(ctx, stdout)
	if err != nil {
		return err
	}
	// SKIP means proceed with the deploy having applied NOTHING to ArgoCD — a live ArgoCD newer than
	// our pin that helm cannot name a release for, where `helm upgrade --install` would either adopt
	// objects it does not own or pass the pin to --version, which is the downgrade (#3521). Returning
	// nil here is deliberate: this is not a failure, and the decision's own message has already said
	// on stdout exactly which values went unapplied.
	if decision.SkipChartInstall {
		return nil
	}

	// Repo URL + chart version are config-driven (env override, current literals as defaults) and
	// shell-quoted since they interpolate into a bash -c command (#951, #944).
	addRepoCmd := fmt.Sprintf("helm repo add argo %s && helm repo update", utils.ShellQuote(argocd.ResolvedArgoHelmRepo()))
	if err := executeCommand(addRepoCmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("failed to add ArgoCD helm repo: %w", err)
	}

	// Pre-seed the argocd-redis secret before installing the chart. The chart's
	// `redis-secret-init` hook is disabled below because it is redundant once this secret exists
	// and has previously blocked the whole Helm install when its pod could not reach the API.
	// Redis keeps a strong random auth. Idempotent: we never overwrite an existing secret (that
	// would desync running redis from its clients).
	if err := ensureArgoRedisSecret(stdout, stderr); err != nil {
		return fmt.Errorf("failed to pre-seed the argocd-redis secret: %w", err)
	}

	// The chart version comes from the DECISION, not straight from the pin. They are the same for
	// every verdict but DOWNGRADE_AVOIDED, where the cluster already runs a newer in-window ArgoCD
	// and the override is the chart helm reports for it — so this deploy's values are applied while
	// the version does not move (#3521). Read off the decision rather than re-resolved here so the
	// version installed and the version the operator was just told about cannot drift apart.
	chartVersion := argocd.ResolvedArgoChartVersion()
	if decision.InstallChartVersion != "" {
		chartVersion = decision.InstallChartVersion
	}
	installCmd := fmt.Sprintf(
		"helm upgrade --install argo-cd argo/argo-cd --namespace argocd --create-namespace --version %s"+
			" --set redisSecretInit.enabled=false --wait --timeout %s",
		utils.ShellQuote(chartVersion),
		utils.ShellQuote(argocd.ResolvedArgoInstallTimeout()))

	// Scratch space for a per-cloud values FILE (GKE's, below). Created unconditionally so the
	// cleanup is one deferred call rather than one per branch; empty and free when unused.
	valuesDir, err := os.MkdirTemp("", "alethia-argocd-values-*")
	if err != nil {
		return fmt.Errorf("failed to create the ArgoCD values dir: %w", err)
	}
	defer os.RemoveAll(valuesDir)

	// Health probes the node can actually satisfy — applied UNCONDITIONALLY, before any per-cloud
	// branch below. The chart's own defaults (timeoutSeconds 1, failureThreshold 3) restart-loop
	// argocd-server and argocd-repo-server on a small burstable node, which is a property of the
	// NODE, not of DNS, of a certificate or of a cloud — so it cannot live inside the ingress
	// branch that only some projects take. See argocd.InstallProbeValues for the measurement.
	//
	// Written FIRST so a per-cloud `-f` appended later still wins on any key it also sets (helm
	// merges values files left to right). Today there is no overlap; the ordering is what keeps it
	// true if one ever appears.
	probesPath := filepath.Join(valuesDir, "argocd-probes.yaml")
	if wErr := os.WriteFile(probesPath, []byte(argocd.InstallProbeValues()), 0o600); wErr != nil {
		return fmt.Errorf("failed to write the ArgoCD probe values: %w", wErr)
	}
	installCmd += " -f " + utils.ShellQuote(probesPath)

	// An explicit resource REQUEST for argocd-repo-server — unconditional for the same reason and in
	// the same place. The chart ships `resources: {}`, which is a QoS class, not an absence of
	// opinion: with no request the container runs at the cgroup CPU-share floor and sits first in the
	// node's eviction ranking, so it loses every contention decision to the kube-system pods that do
	// carry requests. See argocd.InstallResourceValues for the evidence (#3855) and for why the
	// magnitude is deliberately the smallest that changes the class.
	//
	// A SECOND file rather than more keys in the first: both set `repoServer`, helm deep-merges
	// values files, and one file per whole idea keeps each one's doc comment true.
	resourcesPath := filepath.Join(valuesDir, "argocd-resources.yaml")
	if wErr := os.WriteFile(resourcesPath, []byte(argocd.InstallResourceValues()), 0o600); wErr != nil {
		return fmt.Errorf("failed to write the ArgoCD resource values: %w", wErr)
	}
	installCmd += " -f " + utils.ShellQuote(resourcesPath)

	if vc.DNS.Enabled && vc.DNS.DomainName != "" {
		// FAIL CLOSED on a domain that is not a domain. `vc.DNS.DomainName` is free-text project
		// data (console `config-schema.ts` `domain_name`, type `text`, no pattern) and nothing
		// upstream of here validates it — every provider just forwards it as a tfvar. It reaches a
		// `bash -c` string below AND the GKE/AGW values FILES, so it is both a command-injection and
		// a YAML-injection vector. Same treatment, and the same reason, as `ns` and `clusterName`
		// in deploy_namespace.go: refuse it at the boundary rather than escape it at each use.
		//
		// Quoting below is kept as well — this is defence in depth, not belt-and-braces. The
		// validator can only speak for the domain; `certArn` and `wafArn` arrive from tofu outputs,
		// a different trust path this check never sees.
		if !isValidDNSDomain(vc.DNS.DomainName) {
			return fmt.Errorf(
				"refusing to deploy: dns.domain_name %q is not a valid DNS domain — it reaches a shell command and a YAML values file, so it must be a plain hostname (letters, digits, hyphens and dots; each label 1-63 chars; 253 max)",
				vc.DNS.DomainName)
		}
		argoHost := fmt.Sprintf("argocd.%s", vc.DNS.DomainName)
		// Each cloud's ingress is gated on ITS OWN certificate output, and the two keys below are
		// mutually exclusive by construction — only the aws template exports `acm_certificate_arn`,
		// only the gcp template exports `cloud_dns_managed_certificate_name`. Keying on the output
		// rather than on vc.Provider is deliberate: this function runs BEFORE BuildFromOutputs, the
		// certificate is the gate either way, and a provider string that failed to reach here would
		// silently drop the AWS ingress that has worked for a year.
		certArn := argocd.ExtractOutput(outputs, "acm_certificate_arn")
		// GCP no longer has a certificate output to key on — #1858 deleted
		// `google_compute_managed_ssl_certificate` along with the annotation that named it — so the
		// GKE case keys on a GCP-ONLY output that still exists plus cert-manager's readiness, the
		// same shape as Azure below. `gke_cluster_name` is exported only by the gcp template, so the
		// three cases stay mutually exclusive without dispatching on vc.Provider.
		gkeCluster := argocd.ExtractOutput(outputs, "gke_cluster_name")
		// Azure exports no certificate at all (#1825 deleted the App Service order — a purchased
		// product that bound to nothing), so its gate is the gateway plus cert-manager's own
		// readiness. `CertManagerEnabled()` is READ, never restated: it is the same method the
		// render template gates on (`{{- if .CertManagerEnabled }}`) and the same one
		// certManagerDecision and EnsureCertManagerIssuer read. The ClusterSecretStore gates were
		// restated by hand in four places and drifted twice; this is that lesson applied.
		//
		// BuildFromOutputs is pure — outputs plus the config — so calling it here is safe even
		// though the pipeline's own call happens later.
		agwName := argocd.ExtractOutput(outputs, "application_gateway_name")
		certManagerWillIssue := argocd.BuildFromOutputs(outputs, vc).CertManagerEnabled()
		switch {
		case certArn != "":
			installCmd += fmt.Sprintf(
				" --set configs.params.server\\.insecure=true"+
					" --set server.ingress.enabled=true"+
					" --set server.ingress.ingressClassName=alb"+
					" --set 'server.ingress.annotations.alb\\.ingress\\.kubernetes\\.io/scheme=internet-facing'"+
					" --set 'server.ingress.annotations.alb\\.ingress\\.kubernetes\\.io/target-type=ip'"+
					" --set 'server.ingress.annotations.alb\\.ingress\\.kubernetes\\.io/listen-ports=[{\"HTTPS\":443}]'"+
					" --set %s"+
					// argo-helm 8.x refactored the server ingress: the `hosts[]` list was replaced by a
					// single `hostname` (+ `extraHosts` for additional records). We keep the default
					// `controller: generic` and drive the ALB purely via the annotations + ingressClassName
					// above, so only the host key changes across the 7.x→8.x bump (#1165).
					" --set %s",
				// The WHOLE `key=value` is quoted, not just the value: a `--set` pair has to reach helm
				// as ONE shell word, and quoting only the value would leave the pair splittable on a
				// space in the key's own text. The literal single quotes that used to wrap these two
				// format verbs are gone for the same reason — ShellQuote supplies them, and nesting the
				// two would have produced a doubly-quoted argument.
				//
				// The `\.` sequences survive unchanged: inside single quotes bash passes the backslash
				// through, which is exactly what helm's --set key-escaping wants. For any input that was
				// already a valid domain/ARN this renders byte-identical to what it replaced.
				utils.ShellQuote("server.ingress.annotations.alb\\.ingress\\.kubernetes\\.io/certificate-arn="+certArn),
				utils.ShellQuote("server.ingress.hostname="+argoHost))
			// Attach the project's regional web ACL to the ALB this ingress provisions. The
			// template has always BUILT one behind the canvas WAF switch and associated it with
			// nothing; the annotation is what makes the switch mean something. Read straight from
			// the outputs like certArn above — installArgoCD runs BEFORE BuildFromOutputs, so
			// there are no InfraFacts to read here yet.
			//
			// Emitted ONLY when non-empty: the ALB controller treats a present-but-empty
			// wafv2-acl-arn as a malformed association and fails the ingress reconcile, so an
			// empty annotation is strictly worse than none. IAM is already in place —
			// modules/eks/irsa.tf grants the controller wafv2:AssociateWebACL + Get*.
			if wafArn := argocd.ExtractOutput(outputs, "waf_webacl_arn"); wafArn != "" {
				installCmd += fmt.Sprintf(
					" --set %s",
					utils.ShellQuote("server.ingress.annotations.alb\\.ingress\\.kubernetes\\.io/wafv2-acl-arn="+wafArn))
				fmt.Fprintf(stdout, "Attaching WAF web ACL to the ArgoCD Ingress: %s\n", wafArn)
			}
			fmt.Fprintf(stdout, "Configuring ArgoCD Ingress at %s\n", argoHost)
			// The URL is only real when the ingress above is actually configured (AWS
			// ALB+ACM today). Setting it from DomainName alone reported a URL that
			// resolves nowhere on every other cloud.
			result.ArgocdURL = fmt.Sprintf("https://%s", argoHost)

		case gkeCluster != "" && certManagerWillIssue:
			// GKE. There is no controller to install — the Ingress controller lives in the
			// Google-managed control plane and modules/gke leaves HTTP(S) Load Balancing enabled —
			// so the whole platform ingress is these values plus, when the WAF switch is on, one
			// BackendConfig. Nothing new is baked into the runner image.
			//
			// Cloud Armor binds to a GCLB BACKEND SERVICE, which is why this is the `gce` class and
			// not ingress-nginx: nginx's L4 pass-through load balancer cannot carry a security
			// policy at all, so an nginx ingress here would have made the WAF switch permanently
			// unattachable.
			armorPolicy := argocd.ExtractOutput(outputs, "cloud_armor_policy_name")
			backendConfig := ""
			if armorPolicy != "" {
				// Applied BEFORE the helm install, deliberately: the Service the chart creates is
				// then annotated from birth, so the load balancer is never programmed without the
				// policy on it. Annotating afterwards would leave exactly the window this lane
				// exists to close.
				manifest, mErr := argocd.GKEBackendConfigManifest("argocd", armorPolicy)
				if mErr != nil {
					return fmt.Errorf("failed to render the Cloud Armor BackendConfig: %w", mErr)
				}
				path := filepath.Join(valuesDir, "backendconfig.yaml")
				if wErr := os.WriteFile(path, []byte(manifest), 0o600); wErr != nil {
					return fmt.Errorf("failed to write the Cloud Armor BackendConfig: %w", wErr)
				}
				// FATAL on failure, like every other step of the ingress. The project asked for a
				// WAF; shipping a public ArgoCD ingress with the policy silently unattached is the
				// precise dishonesty this lane removes, and it is worse than not deploying.
				if aErr := executeCommand("kubectl apply -f "+path, ".", nil, stdout, stderr); aErr != nil {
					return fmt.Errorf("failed to apply the Cloud Armor BackendConfig (policy %s): %w", armorPolicy, aErr)
				}
				backendConfig = argocd.GKEBackendConfigName
				fmt.Fprintf(stdout, "Attaching Cloud Armor policy to the ArgoCD Ingress backend service: %s\n", armorPolicy)
			}
			values, vErr := argocd.GKEArgoServerValues(argoHost, argocd.CertManagerIssuerName, backendConfig)
			if vErr != nil {
				return fmt.Errorf("failed to render the GKE ArgoCD ingress values: %w", vErr)
			}
			// A values FILE, not `--set` flags. The backend-config annotation's value is the JSON
			// document {"default":"argocd-server"}, and helm's --set parser reads a value that
			// starts with `{` and ends with `}` as a list literal — it cannot express this at all.
			valuesPath := filepath.Join(valuesDir, "argocd-gke-ingress.yaml")
			if wErr := os.WriteFile(valuesPath, []byte(values), 0o600); wErr != nil {
				return fmt.Errorf("failed to write the GKE ArgoCD ingress values: %w", wErr)
			}
			installCmd += " -f " + utils.ShellQuote(valuesPath)
			fmt.Fprintf(stdout, "Configuring ArgoCD Ingress at %s (GKE `gce` class, TLS issued in-cluster by cert-manager)\n", argoHost)
			result.ArgocdURL = fmt.Sprintf("https://%s", argoHost)

		case agwName != "" && certManagerWillIssue:
			// Azure. Unlike the two above, this is NOT gated on a certificate that already exists —
			// there isn't one yet. cert-manager issues asynchronously (EnsureCertManagerIssuer runs
			// after the Applications are applied, and the ACME DNS01 challenge completes seconds
			// after that), so the Ingress ASKS for a certificate and AGIC picks up the Secret when
			// it lands.
			//
			// Both terms are load-bearing and neither is redundant:
			//   · agwName      — AGIC reconciles onto ONE pre-provisioned gateway. No gateway, no
			//                    ingress, whatever else is true.
			//   · certManager  — without an issuer the `spec.tls` Secret is never created and the
			//                    listener serves the gateway's DEFAULT certificate indefinitely.
			//                    Publishing the ArgoCD admin console like that is worse than not
			//                    publishing it, so it is a hard term rather than a degraded mode.
			values, vErr := argocd.AGWArgoServerValues(argoHost, argocd.CertManagerIssuerName)
			if vErr != nil {
				return fmt.Errorf("failed to render the Application Gateway ArgoCD ingress values: %w", vErr)
			}
			valuesPath := filepath.Join(valuesDir, "argocd-agw-ingress.yaml")
			if wErr := os.WriteFile(valuesPath, []byte(values), 0o600); wErr != nil {
				return fmt.Errorf("failed to write the Application Gateway ArgoCD ingress values: %w", wErr)
			}
			installCmd += " -f " + utils.ShellQuote(valuesPath)
			// No WAF annotation, unlike AWS. On Azure the policy is bound by the TEMPLATE
			// (firewall_policy_id on the gateway), so it already covers every listener this Ingress
			// creates — see wafAttachments["azure"].
			fmt.Fprintf(stdout, "Configuring ArgoCD Ingress at %s (Application Gateway via AGIC, TLS issued in-cluster by cert-manager)\n", argoHost)
			result.ArgocdURL = fmt.Sprintf("https://%s", argoHost)
		}
	}

	if err := executeCommand(installCmd, ".", nil, stdout, stderr); err != nil {
		// helm's own "context deadline exceeded" names nothing: not which pod stalled, not why.
		// Three nights of the aws nightly died here and produced no actionable evidence (#1734),
		// and the guaranteed teardown destroys the cluster moments from now. Dump the namespace to
		// STDOUT — so it reaches the runner log artifact, the shipped console job log AND the e2e
		// failure output — before returning. Fail-closed is unchanged (#1718): the error still
		// propagates and still fails the job.
		fmt.Fprint(stdout, namespacePostMortem("argocd"))
		return fmt.Errorf("failed to install ArgoCD: %w", err)
	}

	// The admin password is NOT extracted here: it stays in the `argocd-initial-admin-secret`
	// Secret and is retrieved on-demand from the cluster
	// (`kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d`).
	// Reading it into the deploy result would carry plaintext across the sandbox boundary and into
	// the console's execution_metadata (Postgres) — a secret leak. The console shows the retrieval
	// command instead of a stored password.
	fmt.Fprintln(stdout, "ArgoCD installed.")

	if result.ArgocdURL != "" {
		fmt.Fprintf(stdout, "ArgoCD ready. URL: %s\n", result.ArgocdURL)
	} else {
		fmt.Fprintln(stdout, "ArgoCD ready (no ingress on this cloud yet — access via port-forward; retrieve the admin password on-demand from argocd-initial-admin-secret).")
	}
	return nil
}

// ensureArgoRedisSecret creates the `argocd-redis` Secret (key `auth`) with a strong random
// password before the argo-cd Helm install, but only if it does not already exist. Alethia owns
// this initialization because the chart's equivalent hook has raced or failed on otherwise-ready
// clusters, blocking the whole install. Idempotent by design — never overwrite an existing auth,
// or a running Redis desyncs from its clients. The secret carries Helm ownership metadata so the
// chart adopts it (without these, Helm errors "invalid ownership metadata").
func ensureArgoRedisSecret(stdout, stderr io.Writer) error {
	// Ensure the namespace exists (the helm install also uses --create-namespace, but we seed first).
	nsCmd := "kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -"
	if err := executeCommand(nsCmd, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("ensure argocd namespace: %w", err)
	}

	// Idempotency guard: never regenerate an existing password.
	if out, err := executeCommandWithOutput(
		"kubectl get secret argocd-redis -n argocd -o jsonpath={.data.auth}", ".", nil); err == nil && strings.TrimSpace(out) != "" {
		fmt.Fprintln(stdout, "argocd-redis secret already present; leaving its auth untouched.")
		return nil
	}

	buf := make([]byte, 32) // 256-bit password
	if _, err := rand.Read(buf); err != nil {
		return fmt.Errorf("generate redis password: %w", err)
	}
	auth := hex.EncodeToString(buf)

	manifest := fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: argocd-redis
  namespace: argocd
  labels:
    app.kubernetes.io/name: argocd-redis
    app.kubernetes.io/part-of: argocd
    app.kubernetes.io/managed-by: Helm
  annotations:
    meta.helm.sh/release-name: argo-cd
    meta.helm.sh/release-namespace: argocd
type: Opaque
stringData:
  auth: %s
`, auth)

	dir, err := os.MkdirTemp("", "alethia-argocd-redis-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "argocd-redis.yaml")
	if err := os.WriteFile(path, []byte(manifest), 0o600); err != nil {
		return err
	}
	if err := executeCommand("kubectl apply -f "+path, ".", nil, stdout, stderr); err != nil {
		return fmt.Errorf("apply argocd-redis secret: %w", err)
	}
	fmt.Fprintln(stdout, "Pre-seeded argocd-redis secret (avoids the chart's flaky redis-secret-init hook).")
	return nil
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		// Preserve symlinks rather than dereferencing them. The baked, pre-initialized
		// `.terraform/providers` tree holds symlinks into the shared plugin cache;
		// reading through them would copy hundreds of MB per job (and fail outright on
		// links that point at directories). filepath.Walk uses Lstat, so symlinks
		// arrive here with ModeSymlink set and are not descended into.
		if info.Mode()&os.ModeSymlink != 0 {
			linkDest, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			return os.Symlink(linkDest, target)
		}
		if info.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, info.Mode())
	})
}

// credentialInClusterRegistries gives every in-cluster Harbor its pull credentials: the admin
// password, a pre-seeded pull Secret, and the Job that mints a project-scoped robot from inside the
// cluster (#2431). A no-op on every cloud but Hetzner, which provisions a real registry instead.
//
// Non-fatal per registry, like the add-on and Karpenter paths: a registry still converging must not
// fail an otherwise-healthy cluster. The Job retries, and the next deploy re-runs this — which is a
// no-op once the credential works.
func credentialInClusterRegistries(ctx context.Context, vc *types.ProjectConfig, stdout, stderr io.Writer) {
	for _, reg := range argocd.HetznerRegistries(vc) {
		if err := argocd.EnsureHarborPullCredentials(ctx, reg, selfimage.Ref(), stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: in-cluster registry %s credentials skipped: %v\n", reg.Name, err)
		}
	}
}

// convergeInClusterQueuePasswords makes each in-cluster RabbitMQ's running broker accept the
// password its credential Secret holds (#3590).
//
// The reconciliation runs the OTHER WAY ROUND from credentialInClusterQueues above, and that is the
// whole point. On a queue deployed before #3304 the broker still accepts the password from its very
// first boot — `definitions.enabled` is false, so `RABBITMQ_DEFAULT_PASS` is the only thing that
// ever set it, and RabbitMQ honours that only while the Mnesia database is empty — while ArgoCD's
// selfHeal rewrote the Secret on every reconcile. The value the broker accepts was overwritten long
// ago and cannot be recovered, so the Secret cannot be made to match the broker. The broker is made
// to match the Secret.
//
// Non-fatal per queue, like the registry and add-on paths: a queue whose broker is not reachable yet
// must not fail an otherwise-healthy cluster. The next deploy re-runs this, and it is a no-op for
// every queue whose broker already accepts its Secret.
// It takes `ctx` for the reason its two siblings do — `credentialInClusterRegistries` and
// `bootstrapInClusterVault` both carry one. `WaitAddOnsHealthy` returns immediately on `ctx.Done()`,
// so a cancelled or timed-out deploy falls STRAIGHT THROUGH to this step; without a context to
// consult it would then shell out per queue against a broker that may never answer.
func convergeInClusterQueuePasswords(ctx context.Context, vc *types.ProjectConfig, stdout, stderr io.Writer) {
	for _, q := range argocd.HetznerQueues(vc, stderr) {
		if err := argocd.ConvergeQueuePassword(ctx, q, stdout, stderr); err != nil {
			fmt.Fprintf(stderr, "Warning: in-cluster queue %s broker password not reconciled: %v\n", q.Name, err)
		}
	}
}

// credentialInClusterQueues mints each in-cluster RabbitMQ's password and erlang cookie, once
// (#3304). A no-op on every cloud but Hetzner, which carries the `queue` kind as a chart instead of
// a managed queue service.
//
// Non-fatal per queue, like the registry and add-on paths: one queue that cannot be credentialled
// must not fail an otherwise-healthy cluster. Its Application reports the missing Secret, and the
// next deploy re-runs this — which is a no-op for every queue already holding credentials.
func credentialInClusterQueues(vc *types.ProjectConfig, stdout, stderr io.Writer) error {
	for _, q := range argocd.HetznerQueues(vc, stderr) {
		err := argocd.EnsureQueueCredentialSecret(q, stdout, stderr)
		if err == nil {
			continue
		}
		// ONE failure is not like the others. "Could not determine whether this queue already has
		// live credentials" is not "not ready yet" — it is an unknown standing directly in front of
		// the destructive branch, and proceeding applies an Application whose `auth.existingSecret`
		// names a Secret this deploy failed to write. A restart then reads a credential that does
		// not match the running broker, which is the partition this path exists to prevent.
		//
		// Everything else keeps the non-fatal convention deliberately: a queue that cannot be
		// credentialled yet reports the missing Secret on its own Application, and the next deploy
		// retries — a no-op for every queue already holding credentials.
		if argocd.QueueLiveStateUnknown(err) {
			return fmt.Errorf("in-cluster queue %s: %w", q.Name, err)
		}
		fmt.Fprintf(stderr, "Warning: in-cluster queue %s credentials skipped: %v\n", q.Name, err)
	}
	return nil
}

// bootstrapInClusterVault delivers Hetzner's `secret` kind: the Job that initialises, unseals and
// seeds the platform Vault from inside the cluster, and the ESO ClusterSecretStore that reads it.
// A no-op on every other cloud, and on a Hetzner project that declares no secret.
//
// Non-fatal, like the add-on, Karpenter and registry paths: the Job waits for Vault on its own for
// fifteen minutes and retries under its backoffLimit, and the store re-reconciles once the token
// lands — so a Vault still converging must not fail an otherwise-healthy cluster. The next deploy
// re-runs both, which is a no-op once Vault is initialised (the bootstrap reads its state Secret
// first and refuses to re-initialise).
//
// ORDER WITHIN IT MATTERS ONE WAY ONLY: the Job is applied before the store, so that on a fast
// cluster the store's first validation can already succeed. The reverse order is not a failure —
// just a slower first Ready — which is why neither step blocks on the other.
func bootstrapInClusterVault(ctx context.Context, vc *types.ProjectConfig, facts *argocd.InfraFacts, stdout, stderr io.Writer) {
	v := argocd.HetznerVaultFor(vc)
	if v == nil {
		return
	}
	if err := argocd.EnsureHetznerVault(ctx, v, selfimage.Ref(), stdout, stderr); err != nil {
		fmt.Fprintf(stderr, "Warning: in-cluster Vault bootstrap skipped: %v\n", err)
	}
	if err := argocd.EnsureHetznerSecretStore(facts, stdout, stderr); err != nil {
		fmt.Fprintf(stderr, "Warning: in-cluster Vault ClusterSecretStore not applied yet "+
			"(will reconcile once the operator webhook is ready): %v\n", err)
	}
}
