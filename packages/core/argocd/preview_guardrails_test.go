// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func basePreviewGuardrailsInput() PreviewGuardrailsInput {
	return PreviewGuardrailsInput{
		Project:           "demo",
		GitProvider:       "github",
		RepoOwner:         "acme",
		RepoName:          "shop",
		TokenSecretRef:    "preview-scm-token",
		GuardrailsRepoURL: "https://github.com/alethialabs-io/alethialabs",
		GuardrailsPath:    "infra/templates/argocd/preview-guardrails",
		AppSourceRepos:    []string{"https://github.com/acme/shop"},
		PlacementMode:     types.PlacementModeNamespace,
		NamespacePrefix:   "preview",
		Labels:            map[string]string{"alethia.io/project": "demo"},
	}
}

// docByKindName finds the decoded doc with the given kind + metadata.name, or fails.
func docByKindName(t *testing.T, docs []map[string]interface{}, kind, name string) map[string]interface{} {
	t.Helper()
	for _, d := range docs {
		if d["kind"] != kind {
			continue
		}
		meta, _ := d["metadata"].(map[string]interface{})
		if meta != nil && meta["name"] == name {
			return d
		}
	}
	t.Fatalf("no %s named %q in docs", kind, name)
	return nil
}

func TestRenderPreviewGuardrails_GuardrailsAppSet(t *testing.T) {
	out, err := RenderPreviewGuardrails(basePreviewGuardrailsInput())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{
		"kind: ApplicationSet",
		"name: preview-guardrails-demo",
		"- pullRequest:",
		"github:",
		"owner: 'acme'",
		"repo: 'shop'",
		"secretName: 'preview-scm-token'",
		"name: 'preview-guardrails-demo-{{ .number }}'", // ArgoCD placeholder, NOT Alethia-resolved
		"project: preview-guardrails-demo",
		`repoURL: "https://github.com/alethialabs-io/alethialabs"`,
		"targetRevision: HEAD", // guardrails track Alethia's trusted ref, not the PR head_sha
		"path: 'infra/templates/argocd/preview-guardrails'",
		"namespace: 'preview-{{ .number }}'",
		"managedNamespaceMetadata:",                    // labels the created namespace
		"pod-security.kubernetes.io/enforce: baseline", // PSA blocks hostNetwork/privileged escape
		"CreateNamespace=true",                         // the guardrails ApplicationSet OWNS the namespace
		`"alethia.io/project": "demo"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered guardrails missing %q\n---\n%s", want, out)
		}
	}
	// Alethia's own [[ ]] template must be fully resolved; ArgoCD's {{ }} must survive.
	if strings.Contains(out, "[[") || strings.Contains(out, "]]") {
		t.Errorf("unresolved Alethia delimiters remain:\n%s", out)
	}
	if strings.Contains(out, "<no value>") {
		t.Errorf("template produced <no value>:\n%s", out)
	}
}

func TestRenderPreviewGuardrails_AppProjectsTrustSeparation(t *testing.T) {
	out, err := RenderPreviewGuardrails(basePreviewGuardrailsInput())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	docs := decodeDocs(t, out)

	// The UNTRUSTED app project: no cluster-scoped resources, pinned namespaces, guardrail kinds
	// blacklisted so a PR can't weaken its own isolation.
	apps := docByKindName(t, docs, "AppProject", "preview-apps-demo")
	spec, _ := apps["spec"].(map[string]interface{})
	if spec == nil {
		t.Fatalf("preview-apps-demo has no spec")
	}
	if cw, ok := spec["clusterResourceWhitelist"].([]interface{}); !ok || len(cw) != 0 {
		t.Errorf("preview-apps clusterResourceWhitelist must be empty (deny all cluster-scoped), got %v", spec["clusterResourceWhitelist"])
	}
	blacklisted := map[string]bool{}
	if bl, ok := spec["namespaceResourceBlacklist"].([]interface{}); ok {
		for _, e := range bl {
			m, _ := e.(map[string]interface{})
			blacklisted[asString(m["kind"])] = true
		}
	}
	for _, kind := range []string{"NetworkPolicy", "ResourceQuota", "LimitRange", "Role", "RoleBinding"} {
		if !blacklisted[kind] {
			t.Errorf("preview-apps namespaceResourceBlacklist must deny %s so a PR can't weaken guardrails", kind)
		}
	}
	if !strings.Contains(out, "namespace: \"preview-*\"") {
		t.Errorf("preview-apps destination must be pinned to preview-* namespaces:\n%s", out)
	}

	// The TRUSTED guardrails project: may create the Namespace + the guardrail kinds.
	gr := docByKindName(t, docs, "AppProject", "preview-guardrails-demo")
	grSpec, _ := gr["spec"].(map[string]interface{})
	cw, _ := grSpec["clusterResourceWhitelist"].([]interface{})
	foundNS := false
	for _, e := range cw {
		m, _ := e.(map[string]interface{})
		if asString(m["kind"]) == "Namespace" {
			foundNS = true
		}
	}
	if !foundNS {
		t.Errorf("preview-guardrails project must whitelist Namespace so it can create the preview ns")
	}
	if _, ok := grSpec["namespaceResourceBlacklist"]; ok {
		t.Errorf("preview-guardrails project must NOT blacklist the guardrail kinds")
	}
}

// asString coerces an untyped YAML scalar to string (helper for map assertions).
func asString(v interface{}) string {
	s, _ := v.(string)
	return s
}

func TestRenderPreviewGuardrails_Vcluster(t *testing.T) {
	in := basePreviewGuardrailsInput()
	in.PlacementMode = types.PlacementModeVcluster
	in.VClusterName = "preview-host"
	out, err := RenderPreviewGuardrails(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{
		"name: 'preview-host-{{ .number }}'", // vcluster destination is by cluster name, per-PR
		"name: \"preview-host-*\"",           // AppProject destination glob for the vcluster hosts
	} {
		if !strings.Contains(out, want) {
			t.Errorf("vcluster guardrails missing %q\n---\n%s", want, out)
		}
	}
	if strings.Contains(out, "server: 'https://kubernetes.default.svc'") {
		t.Errorf("vcluster placement should not emit a server destination:\n%s", out)
	}
}

func TestRenderPreviewGuardrails_EmptyAppSourceReposDenies(t *testing.T) {
	in := basePreviewGuardrailsInput()
	in.AppSourceRepos = nil
	out, err := RenderPreviewGuardrails(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Fail closed: no configured app repos → "!*" (ArgoCD reads this as deny everything).
	if !strings.Contains(out, `- "!*"`) {
		t.Errorf("empty AppSourceRepos should fail closed to !*:\n%s", out)
	}
}

func TestRenderPreviewGuardrails_FailsClosed(t *testing.T) {
	cases := map[string]func(*PreviewGuardrailsInput){
		"missing project":       func(in *PreviewGuardrailsInput) { in.Project = "" },
		"missing repo":          func(in *PreviewGuardrailsInput) { in.RepoName = "" },
		"missing guardrail url": func(in *PreviewGuardrailsInput) { in.GuardrailsRepoURL = "" },
		"missing guardrail path": func(in *PreviewGuardrailsInput) {
			in.GuardrailsPath = ""
		},
		"dedicated placement": func(in *PreviewGuardrailsInput) { in.PlacementMode = types.PlacementModeDedicated },
		"empty placement":     func(in *PreviewGuardrailsInput) { in.PlacementMode = "" },
		"vcluster no name":    func(in *PreviewGuardrailsInput) { in.PlacementMode = types.PlacementModeVcluster },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			in := basePreviewGuardrailsInput()
			mutate(&in)
			if _, err := RenderPreviewGuardrails(in); err == nil {
				t.Errorf("expected error for %q, got nil", name)
			}
		})
	}
}

// The static guardrail bundle (infra/templates/argocd/preview-guardrails) is what the guardrails
// Application syncs into each preview namespace. It must be namespace-agnostic (no metadata.namespace,
// so ArgoCD injects the destination namespace) and enforce the required isolation.
func TestPreviewGuardrailBundle_StaticManifests(t *testing.T) {
	dir := filepath.Join(templatesDir(t), "preview-guardrails")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("preview-guardrails bundle dir not found: %v", err)
	}
	var all string
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".yaml" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		all += "\n---\n" + string(b)
	}
	docs := decodeDocs(t, all)

	// Every doc must omit metadata.namespace (ArgoCD injects the destination namespace).
	byKind := map[string]int{}
	for _, d := range docs {
		byKind[asString(d["kind"])]++
		meta, _ := d["metadata"].(map[string]interface{})
		if meta != nil {
			if _, ok := meta["namespace"]; ok {
				t.Errorf("%s %v must NOT pin metadata.namespace (namespace-agnostic bundle)", d["kind"], meta["name"])
			}
		}
	}
	for _, kind := range []string{"NetworkPolicy", "ResourceQuota", "LimitRange", "Role", "RoleBinding", "ServiceAccount"} {
		if byKind[kind] == 0 {
			t.Errorf("guardrail bundle missing a %s", kind)
		}
	}

	// default-deny NetworkPolicy: podSelector {} selecting all pods, both policy types, and NO
	// ingress/egress allow rules (an empty rule set is deny-all).
	dd := docByKindName(t, docs, "NetworkPolicy", "preview-default-deny")
	ddSpec, _ := dd["spec"].(map[string]interface{})
	ps, _ := ddSpec["podSelector"].(map[string]interface{})
	if len(ps) != 0 {
		t.Errorf("default-deny podSelector must be {} (all pods), got %v", ps)
	}
	pt, _ := ddSpec["policyTypes"].([]interface{})
	if len(pt) != 2 {
		t.Errorf("default-deny must set both Ingress+Egress policyTypes, got %v", pt)
	}
	if _, ok := ddSpec["ingress"]; ok {
		t.Errorf("default-deny must have NO ingress rules (deny all inbound)")
	}
	if _, ok := ddSpec["egress"]; ok {
		t.Errorf("default-deny must have NO egress rules (deny all outbound)")
	}

	// The default ServiceAccount must disable token automount (least privilege by default).
	sa := docByKindName(t, docs, "ServiceAccount", "default")
	if am, ok := sa["automountServiceAccountToken"].(bool); !ok || am {
		t.Errorf("default ServiceAccount must set automountServiceAccountToken: false, got %v", sa["automountServiceAccountToken"])
	}

	// The least-priv Role must be read-only (no write verbs) and must not touch secrets.
	role := docByKindName(t, docs, "Role", "preview-workload")
	rules, _ := role["rules"].([]interface{})
	writeVerbs := map[string]bool{"create": true, "update": true, "patch": true, "delete": true, "deletecollection": true, "*": true}
	for _, r := range rules {
		m, _ := r.(map[string]interface{})
		verbs, _ := m["verbs"].([]interface{})
		for _, v := range verbs {
			if writeVerbs[asString(v)] {
				t.Errorf("preview-workload Role must be read-only, found write verb %q", asString(v))
			}
		}
		res, _ := m["resources"].([]interface{})
		for _, rs := range res {
			if asString(rs) == "secrets" {
				t.Errorf("preview-workload Role must NOT grant access to secrets")
			}
		}
	}
}
