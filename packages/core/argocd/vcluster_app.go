// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"fmt"
	"sort"
	"strings"
	"text/template"
)

// Persistent vcluster-placement delivery (#1231, the exec half of the #960 vcluster epic). A
// `vcluster`-placement env runs the customer's app on its OWN virtual control plane (a vcluster
// provisioned on the shared Fabric — see provisioner/vcluster.go) that Alethia has registered with the
// host ArgoCD as a `cluster` Secret named for the env (argocd/vcluster_cluster_secret.go, #1230). So —
// unlike the namespace-placement renderer (namespace_tenant.go), which shares ONE cluster's API and must
// HARD-isolate the tenant to a single namespace — a vcluster tenant OWNS its whole (virtual) cluster:
//
//   - the ArgoCD Application/AppProject target `destination.name = <VClusterName>` (the registered cluster
//     Secret), NOT the in-cluster `server` — that is the whole point of the cluster-Secret lane;
//   - the AppProject is permissive on the DESTINATION (clusterResourceWhitelist/namespaceResourceWhitelist
//     `*`, any namespace) because it's the tenant's own control plane — the isolation boundary is the
//     vcluster itself (its own API server / etcd), not a namespaceResourceBlacklist;
//   - but sourceRepos stays pinned to the tenant's apps repo (supply-chain hygiene: ArgoCD deploys only
//     from the connected repo, fail-closed "!*" when none), exactly like the namespace path;
//   - the app carries CreateNamespace=true — the vcluster starts empty, so ArgoCD creates the target
//     namespace inside it on first sync (the namespace path is CreateNamespace=false because there the
//     host Namespace + guardrails are applied out-of-band first).
//
// There is deliberately NO host Namespace / PSA / guardrail-bundle object here (that hardening is the
// namespace path's single-shared-cluster concern); the AppProject + Application are ArgoCD CRs applied to
// the HOST argocd namespace (the runner's minted host KUBECONFIG), and ArgoCD syncs the workload ONTO the
// vcluster via the registered destination. Secret material never appears in these manifests.

// VClusterAppInput carries the inputs for delivering a persistent vcluster-placement env's app.
type VClusterAppInput struct {
	// Project slug — combined with the vcluster name to derive the AppProject + Application names.
	Project string
	// VClusterName is the registered ArgoCD cluster name (the cluster Secret's `name`, = the env's
	// resolved namespace) the Application's destination.name resolves against. Required.
	VClusterName string
	// Namespace is the namespace INSIDE the vcluster the app deploys into (created on first sync via
	// CreateNamespace=true). Defaults to the env's namespace value; falls back to "default".
	Namespace string
	// AppsRepoURL is the git repo ArgoCD deploys the tenant's manifests from — the sole entry in the
	// AppProject's sourceRepos allowlist and the Application's source. Empty → AppProject admits no repo
	// ("!*") and no Application is emitted (App == "").
	AppsRepoURL string
	// AppsPath is the path within AppsRepoURL to sync (defaults to ".").
	AppsPath string
	// Labels are the classification / sweep-handle labels stamped on every emitted object (never secrets).
	Labels map[string]string
}

// VClusterAppManifests is the rendered delivery split so the caller applies the AppProject BEFORE the
// Application (ArgoCD rejects an Application whose AppProject is missing — fail-closed ordering).
type VClusterAppManifests struct {
	// Project is the AppProject (in the host argocd namespace) the app is pinned to. Apply FIRST.
	Project string
	// App is the tenant's ArgoCD Application (destination.name = VClusterName, CreateNamespace=true).
	// Empty when AppsRepoURL is empty. Apply LAST.
	App string
}

const vclusterProjectTmpl = `apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: {{ .ProjectName }}
  namespace: argocd
{{- if .SortedLabels }}
  labels:
{{- range .SortedLabels }}
    {{ .Key }}: "{{ .Value }}"
{{- end }}
{{- end }}
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  description: vcluster-placement tenant (own virtual control plane — {{ .VClusterName }})
  sourceRepos:
{{- range .AppSourceReposOrDeny }}
    - "{{ . }}"
{{- end }}
  destinations:
    - name: {{ .VClusterName }}
      namespace: "*"
  # The vcluster IS the isolation boundary (its own API server/etcd); the tenant owns it, so the
  # AppProject is permissive on the destination. sourceRepos above still fail-closes what ArgoCD may
  # deploy FROM.
  clusterResourceWhitelist:
    - group: "*"
      kind: "*"
  namespaceResourceWhitelist:
    - group: "*"
      kind: "*"
  orphanedResources:
    warn: true
`

const vclusterAppTmpl = `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: {{ .AppName }}
  namespace: argocd
{{- if .SortedLabels }}
  labels:
{{- range .SortedLabels }}
    {{ .Key }}: "{{ .Value }}"
{{- end }}
{{- end }}
spec:
  project: {{ .ProjectName }}
  source:
    repoURL: "{{ .AppsRepoURL }}"
    targetRevision: HEAD
    path: '{{ .AppsPath }}'
  destination:
    name: {{ .VClusterName }}
    namespace: {{ .Namespace }}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      # The vcluster starts empty — ArgoCD creates the target namespace inside it on first sync.
      - CreateNamespace=true
`

// RenderVClusterApp renders the persistent vcluster-placement delivery (#1231): the AppProject (pinned to
// the tenant's apps repo, targeting the registered vcluster) and the tenant app Application (destination
// name = the vcluster), split so the caller applies the AppProject first. Fails closed on a missing
// required field. AppsRepoURL is optional — empty yields the AppProject only (no App) with a "!*"
// sourceRepos deny.
func RenderVClusterApp(in VClusterAppInput) (VClusterAppManifests, error) {
	if err := in.validate(); err != nil {
		return VClusterAppManifests{}, err
	}
	data := in.templateData()

	projTmpl, err := template.New("vcluster-project").Parse(vclusterProjectTmpl)
	if err != nil {
		return VClusterAppManifests{}, fmt.Errorf("parse vcluster AppProject template: %w", err)
	}
	var projBuf bytes.Buffer
	if err := projTmpl.Execute(&projBuf, data); err != nil {
		return VClusterAppManifests{}, fmt.Errorf("render vcluster AppProject: %w", err)
	}
	out := VClusterAppManifests{Project: strings.TrimSpace(projBuf.String()) + "\n"}

	// No apps repo → AppProject only (nothing to deploy). Mirrors the namespace path.
	if data.AppsRepoURL == "" {
		return out, nil
	}

	appTmpl, err := template.New("vcluster-app").Parse(vclusterAppTmpl)
	if err != nil {
		return VClusterAppManifests{}, fmt.Errorf("parse vcluster app template: %w", err)
	}
	var appBuf bytes.Buffer
	if err := appTmpl.Execute(&appBuf, data); err != nil {
		return VClusterAppManifests{}, fmt.Errorf("render vcluster app: %w", err)
	}
	out.App = strings.TrimSpace(appBuf.String()) + "\n"
	return out, nil
}

// validate fails closed on missing inputs so a broken config never reaches ArgoCD as a half-formed
// manifest. AppsRepoURL is intentionally NOT required (AppProject-only is valid).
func (in VClusterAppInput) validate() error {
	switch {
	case strings.TrimSpace(in.Project) == "":
		return fmt.Errorf("vcluster app: project is required")
	case strings.TrimSpace(in.VClusterName) == "":
		return fmt.Errorf("vcluster app: vcluster name is required")
	}
	// Same fail-closed guard as the namespace tenant: the apps path is user-controlled and lands in
	// the Application's source.path. Empty is valid and means the repo root.
	if err := ValidateAppsPath(in.AppsPath); err != nil {
		return fmt.Errorf("vcluster app: %w", err)
	}
	return nil
}

// vclusterAppData is the flattened view the templates consume.
type vclusterAppData struct {
	VClusterAppInput
	ProjectName          string
	AppName              string
	SortedLabels         []labelKV
	AppSourceReposOrDeny []string
}

// templateData precomputes the derived template values (RFC1123-safe resource names, sorted labels, the
// default apps path + in-vcluster namespace, and a fail-closed sourceRepos allowlist).
func (in VClusterAppInput) templateData() vclusterAppData {
	if strings.TrimSpace(in.AppsPath) == "" {
		in.AppsPath = "."
	}
	if strings.TrimSpace(in.Namespace) == "" {
		in.Namespace = "default"
	}
	in.AppsRepoURL = strings.TrimSpace(in.AppsRepoURL)

	keys := make([]string, 0, len(in.Labels))
	for k := range in.Labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	labels := make([]labelKV, 0, len(keys))
	for _, k := range keys {
		labels = append(labels, labelKV{Key: k, Value: in.Labels[k]})
	}

	// Fail closed: an empty apps repo yields "!*", which ArgoCD reads as "deny everything".
	repos := dedupeNonEmpty([]string{in.AppsRepoURL})
	if len(repos) == 0 {
		repos = []string{"!*"}
	}

	// Distinct prefixes ("vc-…") keep a vcluster env's AppProject/App from colliding with a namespace
	// env's on the same host ArgoCD. namespaceTenantName is the shared RFC1123-safe name builder.
	return vclusterAppData{
		VClusterAppInput:     in,
		ProjectName:          namespaceTenantName("vc", in.Project, in.VClusterName),
		AppName:              namespaceTenantName("vc-app", in.Project, in.VClusterName),
		SortedLabels:         labels,
		AppSourceReposOrDeny: repos,
	}
}
