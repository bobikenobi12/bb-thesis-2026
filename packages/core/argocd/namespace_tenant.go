// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"fmt"
	"sort"
	"strings"
	"text/template"

	"github.com/alethialabs-io/alethialabs/packages/core/names"
)

// Persistent namespace-placement tenant isolation (#956), the delivery half of activating a
// `namespace` placement env (deploy_namespace.go, #955). A namespace env runs the customer's app in a
// SINGLE fixed namespace on a SHARED Fabric cluster, so — unlike the ephemeral PR-preview renderers
// this generalizes (applicationset_preview.go / preview_guardrails.go, which use ArgoCD's PR
// generator for one env PER open PR) — there is no PR generator and no `-*` namespace glob: one
// namespace, one hardened AppProject, one app Application.
//
// The isolation is the SAME trust boundary the preview renderers pioneered, specialized to one ns:
//   - a hardened AppProject the tenant app is pinned to: sourceRepos = the tenant's apps repo only
//     (fail-closed "!*" when empty), clusterResourceWhitelist EMPTY (no cluster-scoped resource — no
//     ClusterRole/CRD/Namespace escape), destinations pinned to the single in-cluster namespace, and
//     namespaceResourceBlacklist denying the guardrail kinds (NetworkPolicy/ResourceQuota/LimitRange/
//     Role/RoleBinding) PLUS argoproj.io Application/AppProject so the tenant can neither weaken its
//     own isolation nor mint a new ArgoCD Application to escape into the wide-open `infra` project;
//   - the Namespace object itself carries Pod Security Admission `baseline` enforce (blocks host
//     escapes) with `restricted` warn/audit. The labels are stamped on the object directly because
//     the runner applies this via `kubectl apply` (no ArgoCD managedNamespaceMetadata to inject them).
//
// The guardrail BUNDLE (default-deny NetworkPolicy + DNS/intra-ns allow, ResourceQuota, LimitRange,
// least-priv default-SA RBAC with token automount off) is the same namespace-agnostic bundle in
// infra/templates/argocd/preview-guardrails/ — the runner applies it into this namespace with
// `kubectl apply -n <ns>` BETWEEN the Isolation manifests and the App (see deploy_namespace.go), so
// the app can never sync into an un-guarded namespace. ArgoCD self-heal of the bundle (a managed
// guardrails Application / Kyverno generate-policy) is a documented hardening follow-up; v1 re-applies
// it every deploy, and the tenant holds no cluster/ArgoCD write access to mutate it between deploys.

// NamespaceTenantInput carries the inputs for a persistent namespace-placement tenant (#956).
type NamespaceTenantInput struct {
	// Project slug — combined with the namespace to derive the AppProject + Application names.
	Project string
	// Namespace is the single fixed namespace this env is placed into on the shared Fabric cluster.
	// Already an RFC-1123 slug (the console derives it from the env name).
	Namespace string
	// AppsRepoURL is the git repo ArgoCD deploys the tenant's manifests from — the sole entry in the
	// hardened AppProject's sourceRepos allowlist and the app Application's source. Empty → the
	// AppProject admits no repo ("!*") and no app Application is emitted (App == "").
	AppsRepoURL string
	// AppsPath is the path within AppsRepoURL to sync (defaults to "." — mirrors the dedicated
	// user-apps.yaml template).
	AppsPath string
	// Labels are the classification / sweep-handle labels stamped on every emitted object (never
	// secrets — these render into the manifests).
	Labels map[string]string
}

// NamespaceTenantManifests is the rendered isolation split so the caller can guarantee ordering: the
// Isolation manifests (Namespace + hardened AppProject) MUST be applied — and the guardrail bundle
// applied into the namespace — BEFORE App, so the tenant app can never sync into an un-guarded ns.
type NamespaceTenantManifests struct {
	// Isolation is the Namespace (PSA-labelled) + the hardened AppProject. Apply FIRST.
	Isolation string
	// App is the tenant's ArgoCD Application (pinned to the hardened AppProject, in-cluster + the
	// namespace, CreateNamespace=false). Empty when AppsRepoURL is empty. Apply LAST.
	App string
}

const namespaceIsolationTmpl = `apiVersion: v1
kind: Namespace
metadata:
  name: {{ .Namespace }}
  labels:
    app.kubernetes.io/managed-by: alethia
    alethia.io/placement: "namespace"
    # Pod Security Admission (pod-level isolation): baseline enforce forbids hostNetwork/hostPID/
    # hostIPC/hostPath/privileged/host-ports — without it a hostNetwork pod bypasses the default-deny
    # NetworkPolicy and privileged pods escape to the node. restricted warn/audit surfaces the
    # stricter gaps without breaking apps that don't yet comply. See preview_guardrails.go (#887).
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: latest
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: latest
{{- range .SortedLabels }}
    {{ .Key }}: "{{ .Value }}"
{{- end }}
---
apiVersion: argoproj.io/v1alpha1
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
  description: Namespace-placement tenant (untrusted app code — hardened, single namespace)
  sourceRepos:
{{- range .AppSourceReposOrDeny }}
    - "{{ . }}"
{{- end }}
  destinations:
    - server: https://kubernetes.default.svc
      namespace: {{ .Namespace }}
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
    - group: argoproj.io
      kind: Application
    - group: argoproj.io
      kind: AppProject
  orphanedResources:
    warn: true
`

const namespaceAppTmpl = `apiVersion: argoproj.io/v1alpha1
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
    server: https://kubernetes.default.svc
    namespace: {{ .Namespace }}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      # The Isolation manifests + the guardrail bundle already created + guarded the namespace, so the
      # app must NOT create (an un-labelled, un-guarded) one. Fail closed if the guardrails half didn't
      # land: ArgoCD rejects an Application whose AppProject is missing, so the app can't run un-isolated.
      - CreateNamespace=false
`

// RenderNamespaceTenant renders the persistent namespace-placement isolation (#956): the Namespace
// (PSA-labelled) + hardened AppProject, and the tenant app Application, split so the caller applies
// them in the fail-closed order (isolation + bundle, THEN app). Fails closed on a missing required
// field. AppsRepoURL is optional — empty yields isolation-only (no App) with a "!*" sourceRepos deny.
func RenderNamespaceTenant(in NamespaceTenantInput) (NamespaceTenantManifests, error) {
	if err := in.validate(); err != nil {
		return NamespaceTenantManifests{}, err
	}
	data := in.templateData()

	isoTmpl, err := template.New("namespace-isolation").Parse(namespaceIsolationTmpl)
	if err != nil {
		return NamespaceTenantManifests{}, fmt.Errorf("parse namespace isolation template: %w", err)
	}
	var isoBuf bytes.Buffer
	if err := isoTmpl.Execute(&isoBuf, data); err != nil {
		return NamespaceTenantManifests{}, fmt.Errorf("render namespace isolation: %w", err)
	}

	out := NamespaceTenantManifests{Isolation: strings.TrimSpace(isoBuf.String()) + "\n"}

	// No apps repo → isolation-only (the namespace is guarded, but there's nothing to deploy). Mirrors
	// the dedicated path, which skips the app Application when AppsDestinationRepo is empty.
	if data.AppsRepoURL == "" {
		return out, nil
	}

	appTmpl, err := template.New("namespace-app").Parse(namespaceAppTmpl)
	if err != nil {
		return NamespaceTenantManifests{}, fmt.Errorf("parse namespace app template: %w", err)
	}
	var appBuf bytes.Buffer
	if err := appTmpl.Execute(&appBuf, data); err != nil {
		return NamespaceTenantManifests{}, fmt.Errorf("render namespace app: %w", err)
	}
	out.App = strings.TrimSpace(appBuf.String()) + "\n"
	return out, nil
}

// validate fails closed on missing inputs so a broken config never reaches ArgoCD as a half-formed
// manifest. AppsRepoURL is intentionally NOT required (isolation-only is valid).
func (in NamespaceTenantInput) validate() error {
	switch {
	case strings.TrimSpace(in.Project) == "":
		return fmt.Errorf("namespace tenant: project is required")
	case strings.TrimSpace(in.Namespace) == "":
		return fmt.Errorf("namespace tenant: namespace is required")
	}
	// The apps path is user-controlled project data that lands in the Application's source.path —
	// fail closed on a traversal or a YAML-hostile rune rather than rendering a half-formed
	// manifest. Empty is valid and means the repo root.
	if err := ValidateAppsPath(in.AppsPath); err != nil {
		return fmt.Errorf("namespace tenant: %w", err)
	}
	return nil
}

// namespaceTenantData is the flattened view the templates consume.
type namespaceTenantData struct {
	NamespaceTenantInput
	ProjectName          string
	AppName              string
	SortedLabels         []labelKV
	AppSourceReposOrDeny []string
}

// templateData precomputes the derived template values (RFC1123-safe resource names, sorted labels
// for determinism, the default apps path, and a fail-closed sourceRepos allowlist).
func (in NamespaceTenantInput) templateData() namespaceTenantData {
	if strings.TrimSpace(in.AppsPath) == "" {
		in.AppsPath = "."
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

	// Fail closed: an empty apps repo yields "!*", which ArgoCD reads as "deny everything" — a
	// mis-built config admits no repo rather than defaulting wide open.
	repos := dedupeNonEmpty([]string{in.AppsRepoURL})
	if len(repos) == 0 {
		repos = []string{"!*"}
	}

	return namespaceTenantData{
		NamespaceTenantInput: in,
		ProjectName:          namespaceTenantName("tenant", in.Project, in.Namespace),
		AppName:              namespaceTenantName("app", in.Project, in.Namespace),
		SortedLabels:         labels,
		AppSourceReposOrDeny: repos,
	}
}

// namespaceTenantName derives a stable, RFC1123-safe ArgoCD resource name of the form
// "<prefix>-<project>-<namespace>", bounded to ≤63 chars (the k8s/ArgoCD name limit). The namespace
// (unique per Fabric cluster) is the discriminator, so two projects' same-named envs never collide.
//
// Each part goes through names.LegacyObjectSegment, which is FROZEN: this name is the identity of
// an ArgoCD AppProject and Application that are already applied, and `project` is the project's
// free-text DISPLAY NAME rather than a slug. Moving it onto names.Slugify would rename the live
// pair for every project whose name carries an apostrophe or a doubled/spaced hyphen — see that
// function. What this file no longer has is its own COPY of the rule.
func namespaceTenantName(prefix, project, namespace string) string {
	parts := make([]string, 0, 3)
	for _, p := range []string{prefix, project, namespace} {
		if s := names.LegacyObjectSegment(p); s != "" {
			parts = append(parts, s)
		}
	}
	name := strings.Join(parts, "-")
	if name == "" {
		name = "tenant"
	}
	return names.Bounded(name)
}
