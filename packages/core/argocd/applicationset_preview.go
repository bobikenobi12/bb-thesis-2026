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

// PreviewAppSetInput carries the inputs for the ephemeral PR-preview ApplicationSet (#842, W-f).
// The rendered ApplicationSet uses ArgoCD's Pull Request generator: it lists the repo's OPEN pull
// requests and materializes one Application per PR (deploying that PR's head_sha), then destroys the
// Application when the PR closes — so create-on-open / deploy-head_sha / destroy-on-close is native
// to ArgoCD, no webhook receiver required. PlacementMode selects the per-team tenancy of each
// preview (namespace | vcluster); dedicated is not a valid preview placement.
type PreviewAppSetInput struct {
	// Project slug — names the ApplicationSet (preview-<project>) and the generated Applications.
	Project string
	// SCM host for the PR generator block: github | gitlab | bitbucket.
	GitProvider string
	// The repo whose open pull requests generate previews.
	RepoOwner string
	RepoName  string
	// ArgoCD Secret (in the argocd namespace) the PR generator authenticates the SCM API with.
	// Empty → the generator polls anonymously (public repos only).
	TokenSecretRef string
	// Git URL ArgoCD deploys each preview's manifests from, and the path within it. The manifests
	// are read at the PR's head_sha (targetRevision below), so previews always track the PR's code.
	AppsRepoURL string
	AppsPath    string
	// Per-team tenancy of each preview env.
	PlacementMode types.PlacementMode
	// namespace placement: the Fabric cluster's ArgoCD destination API server. Empty → in-cluster
	// (https://kubernetes.default.svc), i.e. the Fabric ArgoCD runs on.
	DestServer string
	// vcluster placement: the registered ArgoCD cluster name of the per-PR vcluster host. The
	// vcluster itself is provisioned by a later unit; this only names the destination.
	VClusterName string
	// Namespace prefix for each preview (e.g. "preview" → preview-pr-<number>). Defaults to "preview".
	NamespacePrefix string
	// Common labels stamped on the ApplicationSet and propagated onto each generated Application
	// (InjectCommonLabels does not descend into an ApplicationSet, so this template loops explicitly).
	Labels map[string]string
}

// previewAppSetTmpl renders the PR-preview ApplicationSet. It uses [[ ]] delimiters so ArgoCD's own
// {{ }} generator placeholders ({{ .number }}, {{ .head_sha }}, {{ .branch }}) pass through to
// ArgoCD verbatim instead of being resolved here.
const previewAppSetTmpl = `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: preview-[[ .Project ]]
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
      name: 'preview-[[ .Project ]]-{{ .number }}'
      labels:
        alethia.io/preview: "true"
        alethia.io/preview-pr: '{{ .number }}'
[[- range .SortedLabels ]]
        "[[ .Key ]]": "[[ .Value ]]"
[[- end ]]
    spec:
      # Untrusted PR code runs here → the hardened preview-apps AppProject (#887,
      # preview_guardrails.go): no cluster-scoped resources, pinned to preview-<prefix>-* namespaces,
      # and the guardrail kinds (NetworkPolicy/ResourceQuota/LimitRange/RBAC) blacklisted so a PR
      # can't weaken its own isolation. NOT the wide-open "apps" project.
      project: preview-apps-[[ .Project ]]
      source:
        repoURL: "[[ .AppsRepoURL ]]"
        targetRevision: '{{ .head_sha }}'
        path: '[[ .AppsPath ]]'
      destination:
[[- if eq .PlacementModeStr "vcluster" ]]
        name: '[[ .VClusterName ]]-{{ .number }}'
        namespace: '[[ .NamespacePrefix ]]'
[[- else ]]
        server: '[[ .DestServerOrDefault ]]'
        namespace: '[[ .NamespacePrefix ]]-{{ .number }}'
[[- end ]]
      syncPolicy:
        # CreateNamespace=false: the companion preview-guardrails ApplicationSet (#887) OWNS the
        # namespace — it creates it (labelled alethia.io/preview) and lands the default-deny
        # NetworkPolicy + quota + RBAC first. The app then syncs into that already-guarded namespace
        # (automated sync retries until it exists), so untrusted pods never run un-isolated.
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=false
`

// SECURITY (#887, LANDED): a preview deploys UNTRUSTED PR code into a namespace, so the guardrails
// are now emitted by RenderPreviewGuardrails (preview_guardrails.go): the hardened preview-apps
// AppProject this template targets (no cluster-scoped resources, pinned to preview-* namespaces,
// guardrail kinds blacklisted) + a companion guardrails ApplicationSet that OWNS each preview
// namespace and lands a default-deny NetworkPolicy + ResourceQuota/LimitRange + least-priv RBAC.
// Because this template sets CreateNamespace=false and references preview-apps-<project>, the app
// previews FAIL CLOSED if the guardrails half isn't applied first — ArgoCD rejects a generated
// Application whose AppProject doesn't exist, so untrusted PR code can never deploy un-isolated.
// Still an unused seam pending runner wiring/activation (which must render+apply BOTH halves).
//
// RenderPreviewApplicationSet renders the ephemeral PR-preview ApplicationSet YAML (#842, W-f).
// It returns an error when a required field is missing, or when PlacementMode is anything other than
// namespace|vcluster (dedicated/"" is not a valid preview placement — fail closed rather than emit a
// manifest that can't run). The caller (runner) applies the result to the Fabric's ArgoCD like the
// other Applications; ArgoCD then reconciles one preview per open PR.
func RenderPreviewApplicationSet(in PreviewAppSetInput) (string, error) {
	if err := in.validate(); err != nil {
		return "", err
	}
	data := in.templateData()
	tmpl, err := template.New("preview-appset").Delims("[[", "]]").Parse(previewAppSetTmpl)
	if err != nil {
		return "", fmt.Errorf("parse preview ApplicationSet template: %w", err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("render preview ApplicationSet: %w", err)
	}
	return buf.String(), nil
}

// validate fails closed on missing inputs or an unsupported placement, so a broken config never
// reaches ArgoCD as a half-formed manifest.
func (in PreviewAppSetInput) validate() error {
	const what = "preview ApplicationSet"

	// SHAPE, not just presence. Every field below is interpolated into raw YAML by a text/template
	// — several of them UNQUOTED, and GitProvider in KEY position — so "non-empty" was never the
	// property that mattered. See preview_validate.go for what each rule is and why.
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
	if strings.TrimSpace(in.AppsRepoURL) == "" {
		return fmt.Errorf("%s: apps repo URL is required", what)
	}
	if err := validatePreviewURL(what, "apps repo URL", in.AppsRepoURL, gitRemoteSchemes); err != nil {
		return err
	}
	// The missing sixth call site. ValidateAppsPath guards this same value at
	// namespace_tenant.go, vcluster_app.go and three places in the provisioner; this renderer was
	// the only one that skipped it, while writing the value into `source.path`.
	if err := ValidateAppsPath(in.AppsPath); err != nil {
		return fmt.Errorf("%s: %w", what, err)
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

// previewTemplateData is the flattened view the template consumes (methods can't take args in a
// template, so precompute the derived values here).
type previewTemplateData struct {
	PreviewAppSetInput
	SortedLabels        []labelKV
	PlacementModeStr    string
	DestServerOrDefault string
}

type labelKV struct {
	Key   string
	Value string
}

// templateData precomputes derived template values (sorted labels for determinism, the
// placement-mode string, and the in-cluster default destination).
func (in PreviewAppSetInput) templateData() previewTemplateData {
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
	in.AppsPath = strings.TrimSpace(in.AppsPath)
	in.NamespacePrefix = strings.TrimSpace(in.NamespacePrefix)
	in.VClusterName = strings.TrimSpace(in.VClusterName)
	in.DestServer = strings.TrimSpace(in.DestServer)

	in.AppsRepoURL = strings.TrimSpace(in.AppsRepoURL)

	prefix := in.NamespacePrefix
	if strings.TrimSpace(prefix) == "" {
		prefix = "preview"
	}
	in.NamespacePrefix = prefix

	dest := in.DestServer
	if strings.TrimSpace(dest) == "" {
		dest = "https://kubernetes.default.svc"
	}

	// Empty means the repository root, spelled "." — the same default namespace_tenant.go and
	// vcluster_app.go apply. This renderer omitted it and emitted `path: ''`.
	if strings.TrimSpace(in.AppsPath) == "" {
		in.AppsPath = "."
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

	return previewTemplateData{
		PreviewAppSetInput:  in,
		SortedLabels:        labels,
		PlacementModeStr:    string(in.PlacementMode),
		DestServerOrDefault: dest,
	}
}
