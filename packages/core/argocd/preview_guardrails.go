// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"fmt"
	"sort"
	"strings"

	"text/template"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Preview-env namespace isolation guardrails (#887), the security prerequisite for activating the
// ephemeral PR-preview ApplicationSet (#842, applicationset_preview.go). A preview deploys UNTRUSTED
// PR code (the PR's head_sha) into a namespace with CreateNamespace + automated sync, so before that
// is wired to run each preview namespace must be isolated. This renderer emits that isolation as
// two cooperating halves of one trust boundary:
//
//  1. TWO AppProjects (the ArgoCD-level deploy-surface boundary):
//     - preview-guardrails: TRUSTED. sourceRepos = Alethia's guardrail bundle repo only; may create
//       the preview Namespace + the guardrail kinds (NetworkPolicy/ResourceQuota/LimitRange/RBAC).
//     - preview-apps: UNTRUSTED. sourceRepos = the PR repos; clusterResourceWhitelist EMPTY (no
//       cluster-scoped resource may be created — no ClusterRole/CRD/Namespace escape); destinations
//       pinned to the preview-<prefix>-* namespaces only; namespaceResourceBlacklist denies the
//       guardrail kinds so a PR cannot ship its own allow-all NetworkPolicy / raise its quota /
//       grant itself RBAC to defeat the isolation.
//     The #842 preview app ApplicationSet targets preview-apps (this file changes it off the
//     wide-open "apps" project) and sets CreateNamespace=false, so a PR can only deploy into a
//     namespace the guardrails half already created + guarded.
//
//  2. A companion preview-guardrails ApplicationSet (the runtime boundary): the SAME PR generator as
//     #842, so it materializes one guardrail set per open PR (create-on-open, prune-on-close) into
//     the SAME namespace the app targets. It OWNS the namespace (CreateNamespace=true +
//     managedNamespaceMetadata labels it alethia.io/preview=true) and syncs the namespace-agnostic
//     bundle in infra/templates/argocd/preview-guardrails/ (default-deny NetworkPolicy + DNS/intra-ns
//     allow, ResourceQuota, LimitRange, least-priv default-SA RBAC — ArgoCD injects the destination
//     namespace into each doc).
//
// Deferred defense-in-depth (documented seams, not this unit): ArgoCD sync impersonation via the
// AppProject's destinationServiceAccounts (blocked today by the bootstrap ordering — the impersonated
// SA must pre-exist in a namespace that is created per-PR); and/or a Kyverno generate-policy that
// enforces the bundle cluster-side independent of the ApplicationSet. Runner wiring to APPLY these +
// push the bundle to the Fabric's gitops source belongs to the activation unit, exactly as #842 left
// its own runner wiring out.

// PreviewGuardrailsInput carries the inputs for the preview-env guardrails (#887). The PR-generator
// identity fields (GitProvider/RepoOwner/RepoName/TokenSecretRef) MUST match the app preview
// ApplicationSet's (PreviewAppSetInput) so the guardrails track the exact same open PRs — the caller
// builds both from one config.
type PreviewGuardrailsInput struct {
	// Project slug — names the ApplicationSet (preview-guardrails-<project>) and the AppProjects.
	Project string
	// SCM host for the PR generator block: github | gitlab | bitbucket.
	GitProvider string
	// The repo whose open pull requests generate previews (must match the app ApplicationSet).
	RepoOwner string
	RepoName  string
	// ArgoCD Secret the PR generator authenticates the SCM API with. Empty → poll anonymously.
	TokenSecretRef string
	// GuardrailsRepoURL / GuardrailsPath: the TRUSTED git source holding the namespace-agnostic
	// guardrail bundle (infra/templates/argocd/preview-guardrails). Alethia-controlled.
	GuardrailsRepoURL string
	GuardrailsPath    string
	// AppSourceRepos: the repos the untrusted preview APP Applications may deploy from — the
	// sourceRepos allowlist pinned onto the hardened preview-apps AppProject. Empty → "!*" (admit
	// nothing) so a mis-built config fails closed rather than allowing any repo.
	AppSourceRepos []string
	// Per-team tenancy of each preview env (namespace | vcluster); dedicated is not valid.
	PlacementMode types.PlacementMode
	// namespace placement: the Fabric cluster's ArgoCD destination API server. Empty → in-cluster.
	DestServer string
	// vcluster placement: the registered ArgoCD cluster name of the per-PR vcluster host.
	VClusterName string
	// Namespace prefix for each preview (e.g. "preview" → preview-<pr>). Defaults to "preview".
	NamespacePrefix string
	// Common labels stamped on the ApplicationSet + AppProjects and propagated onto each generated
	// Application (as in #842, the template loops these explicitly).
	Labels map[string]string
}

// previewGuardrailsTmpl renders the two AppProjects + the companion guardrails ApplicationSet. It
// uses [[ ]] delimiters so ArgoCD's own {{ }} generator placeholders ({{ .number }}) pass through to
// ArgoCD verbatim, matching applicationset_preview.go.
const previewGuardrailsTmpl = `apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: preview-guardrails-[[ .Project ]]
  namespace: argocd
  labels:
    alethia.io/preview: "true"
[[- range .SortedLabels ]]
    "[[ .Key ]]": "[[ .Value ]]"
[[- end ]]
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  description: Preview-env guardrails (trusted — Alethia isolation bundle)
  sourceRepos:
    - "[[ .GuardrailsRepoURL ]]"
  destinations:
[[- if eq .PlacementModeStr "vcluster" ]]
    - name: "[[ .VClusterName ]]-*"
      namespace: "[[ .NamespacePrefix ]]"
[[- else ]]
    - server: '[[ .DestServerOrDefault ]]'
      namespace: "[[ .NamespacePrefix ]]-*"
[[- end ]]
  clusterResourceWhitelist:
    - group: ""
      kind: Namespace
  orphanedResources:
    warn: false
---
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: preview-apps-[[ .Project ]]
  namespace: argocd
  labels:
    alethia.io/preview: "true"
[[- range .SortedLabels ]]
    "[[ .Key ]]": "[[ .Value ]]"
[[- end ]]
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  description: Preview-env apps (untrusted PR code — hardened, default-deny)
  sourceRepos:
[[- range .AppSourceReposOrDeny ]]
    - "[[ . ]]"
[[- end ]]
  destinations:
[[- if eq .PlacementModeStr "vcluster" ]]
    - name: "[[ .VClusterName ]]-*"
      namespace: "[[ .NamespacePrefix ]]"
[[- else ]]
    - server: '[[ .DestServerOrDefault ]]'
      namespace: "[[ .NamespacePrefix ]]-*"
[[- end ]]
  clusterResourceWhitelist: []
  namespaceResourceBlacklist:
    - group: networking.k8s.io
      kind: NetworkPolicy
    - group: ""
      kind: ResourceQuota
    - group: ""
      kind: LimitRange
    - group: rbac.authorization.k8s.io
      kind: Role
    - group: rbac.authorization.k8s.io
      kind: RoleBinding
  orphanedResources:
    warn: true
---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: preview-guardrails-[[ .Project ]]
  namespace: argocd
  labels:
    alethia.io/preview: "true"
[[- range .SortedLabels ]]
    "[[ .Key ]]": "[[ .Value ]]"
[[- end ]]
spec:
  goTemplate: true
  goTemplateOptions: ["missingkey=error"]
  generators:
    - pullRequest:
        [[ .GitProvider ]]:
          owner: '[[ .RepoOwner ]]'
          repo: '[[ .RepoName ]]'
[[- if .TokenSecretRef ]]
          tokenRef:
            secretName: '[[ .TokenSecretRef ]]'
            key: token
[[- end ]]
        requeueAfterSeconds: 60
  template:
    metadata:
      name: 'preview-guardrails-[[ .Project ]]-{{ .number }}'
      labels:
        alethia.io/preview: "true"
        alethia.io/preview-pr: '{{ .number }}'
[[- range .SortedLabels ]]
        "[[ .Key ]]": "[[ .Value ]]"
[[- end ]]
    spec:
      project: preview-guardrails-[[ .Project ]]
      source:
        repoURL: "[[ .GuardrailsRepoURL ]]"
        targetRevision: HEAD
        path: '[[ .GuardrailsPath ]]'
      destination:
[[- if eq .PlacementModeStr "vcluster" ]]
        name: '[[ .VClusterName ]]-{{ .number }}'
        namespace: '[[ .NamespacePrefix ]]'
[[- else ]]
        server: '[[ .DestServerOrDefault ]]'
        namespace: '[[ .NamespacePrefix ]]-{{ .number }}'
[[- end ]]
      syncPolicy:
        managedNamespaceMetadata:
          labels:
            alethia.io/preview: "true"
            # Pod Security Admission (pod-level isolation): baseline enforce forbids hostNetwork/
            # hostPID/hostIPC/hostPath/privileged/host-ports — without it a hostNetwork pod bypasses
            # the default-deny NetworkPolicy and privileged pods escape to the node. See #887.
            pod-security.kubernetes.io/enforce: baseline
            pod-security.kubernetes.io/enforce-version: latest
            pod-security.kubernetes.io/warn: restricted
            pod-security.kubernetes.io/warn-version: latest
            pod-security.kubernetes.io/audit: restricted
            pod-security.kubernetes.io/audit-version: latest
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
`

// RenderPreviewGuardrails renders the preview-env guardrails (#887): the trusted + hardened
// AppProjects and the companion guardrails ApplicationSet (see the package-level design comment
// above). It fails closed on a missing required field, or when PlacementMode is anything other than
// namespace|vcluster (dedicated/"" is not a valid preview placement). The caller (runner, at
// activation) applies the result to the Fabric's ArgoCD alongside the app preview ApplicationSet.
func RenderPreviewGuardrails(in PreviewGuardrailsInput) (string, error) {
	if err := in.validate(); err != nil {
		return "", err
	}
	data := in.templateData()
	tmpl, err := template.New("preview-guardrails").Delims("[[", "]]").Parse(previewGuardrailsTmpl)
	if err != nil {
		return "", fmt.Errorf("parse preview guardrails template: %w", err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("render preview guardrails: %w", err)
	}
	return buf.String(), nil
}

// validate fails closed on missing inputs or an unsupported placement, so a broken config never
// reaches ArgoCD as a half-formed manifest.
func (in PreviewGuardrailsInput) validate() error {
	const what = "preview guardrails"

	// Same shape rules as the app half (preview_validate.go). This renderer emits the AppProjects
	// that CONSTRAIN the untrusted half, so a value that restructures its YAML would weaken the
	// isolation the app half depends on — `namespace: "[[ .NamespacePrefix ]]-*"` is the
	// destination pin, and a prefix that broke out of it would widen the glob.
	if err := validatePreviewProject(what, in.Project); err != nil {
		return err
	}
	if err := validatePreviewGitProvider(what, in.GitProvider); err != nil {
		return err
	}
	if err := validatePreviewRepoRef(what, "repo owner", in.RepoOwner); err != nil {
		return err
	}
	if err := validatePreviewRepoRef(what, "repo name", in.RepoName); err != nil {
		return err
	}
	if err := validatePreviewSecretRef(what, in.TokenSecretRef); err != nil {
		return err
	}
	if strings.TrimSpace(in.GuardrailsRepoURL) == "" {
		return fmt.Errorf("%s: guardrails repo URL is required", what)
	}
	if err := validatePreviewURL(what, "guardrails repo URL", in.GuardrailsRepoURL, gitRemoteSchemes); err != nil {
		return err
	}
	if strings.TrimSpace(in.GuardrailsPath) == "" {
		return fmt.Errorf("%s: guardrails path is required", what)
	}
	// Alethia-controlled today, but it renders into `source.path` exactly as the app half's
	// AppsPath does, and "it is trusted" is a property of the current caller rather than of this
	// function. There is no caller yet at all.
	if err := ValidateAppsPath(in.GuardrailsPath); err != nil {
		return fmt.Errorf("%s: guardrails path: %w", what, err)
	}
	if err := validatePreviewNamespacePrefix(what, in.NamespacePrefix); err != nil {
		return err
	}
	if err := validatePreviewURL(what, "destination server", in.DestServer, apiServerSchemes); err != nil {
		return err
	}
	if err := validatePreviewLabels(what, in.Labels); err != nil {
		return err
	}
	for _, repo := range in.AppSourceRepos {
		// An entry renders INSIDE DOUBLE QUOTES (`sourceRepos:\n  - "[[ . ]]"`). A line break adds
		// list entries; a quote terminates the scalar early and leaves trailing content, which is
		// a syntax error that takes the whole guardrails document — the AppProjects constraining
		// the untrusted half — down with it. "!*" and other globs are legal ArgoCD syntax and stay
		// allowed, so only the two characters that restructure the document are refused.
		if strings.ContainsAny(repo, yamlDQBreakers) {
			return fmt.Errorf("%s: app source repo %q contains a line break or a quote character", what, repo)
		}
	}

	switch in.PlacementMode {
	case types.PlacementModeNamespace, types.PlacementModeVcluster:
		// ok — the two valid preview tenancies.
	case types.PlacementModeDedicated:
		return fmt.Errorf("%s: dedicated placement is not valid for an ephemeral preview (want namespace|vcluster)", what)
	default:
		return fmt.Errorf("%s: placement mode %q is not a valid preview placement (want namespace|vcluster)", what, in.PlacementMode)
	}
	if in.PlacementMode == types.PlacementModeVcluster {
		if err := validatePreviewClusterName(what, in.VClusterName); err != nil {
			return err
		}
	}
	return nil
}

// previewGuardrailsData is the flattened view the template consumes (methods can't take args in a
// template, so precompute the derived values here).
type previewGuardrailsData struct {
	PreviewGuardrailsInput
	SortedLabels         []labelKV
	PlacementModeStr     string
	DestServerOrDefault  string
	AppSourceReposOrDeny []string
}

// templateData precomputes derived template values (sorted labels for determinism, the placement-mode
// string, the in-cluster default destination, the namespace-prefix default, and a fail-closed
// sourceRepos allowlist for the untrusted app project).
func (in PreviewGuardrailsInput) templateData() previewGuardrailsData {
	// Every shape guard judges the TRIMMED value, so the template must render the trimmed one too.
	// Without this, `Project = "\ndemo"` passes validatePreviewProject (it trims to a valid label)
	// and then renders `name: preview-` followed by `demo` at column 0 — the half-formed manifest
	// validate() exists to prevent. vcluster_app.go:204 writes the trimmed value back for the same
	// reason; this renderer did it only as an emptiness test.
	in.Project = strings.TrimSpace(in.Project)
	in.GitProvider = strings.TrimSpace(in.GitProvider)
	in.RepoOwner = strings.TrimSpace(in.RepoOwner)
	in.RepoName = strings.TrimSpace(in.RepoName)
	in.TokenSecretRef = strings.TrimSpace(in.TokenSecretRef)
	in.NamespacePrefix = strings.TrimSpace(in.NamespacePrefix)
	in.VClusterName = strings.TrimSpace(in.VClusterName)
	in.DestServer = strings.TrimSpace(in.DestServer)

	in.GuardrailsRepoURL = strings.TrimSpace(in.GuardrailsRepoURL)
	in.GuardrailsPath = strings.TrimSpace(in.GuardrailsPath)

	prefix := in.NamespacePrefix
	if strings.TrimSpace(prefix) == "" {
		prefix = "preview"
	}
	in.NamespacePrefix = prefix

	dest := in.DestServer
	if strings.TrimSpace(dest) == "" {
		dest = "https://kubernetes.default.svc"
	}

	keys := make([]string, 0, len(in.Labels))
	for k := range in.Labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	labels := make([]labelKV, 0, len(keys))
	for _, k := range keys {
		labels = append(labels, labelKV{Key: k, Value: in.Labels[k]})
	}

	// Fail closed: an empty AppSourceRepos yields "!*", which ArgoCD reads as "deny everything" —
	// a mis-built config admits no repo rather than defaulting wide open.
	repos := dedupeNonEmpty(in.AppSourceRepos)
	if len(repos) == 0 {
		repos = []string{"!*"}
	}

	return previewGuardrailsData{
		PreviewGuardrailsInput: in,
		SortedLabels:           labels,
		PlacementModeStr:       string(in.PlacementMode),
		DestServerOrDefault:    dest,
		AppSourceReposOrDeny:   repos,
	}
}
