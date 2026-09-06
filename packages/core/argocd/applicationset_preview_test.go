// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func basePreviewInput() PreviewAppSetInput {
	return PreviewAppSetInput{
		Project:         "demo",
		GitProvider:     "github",
		RepoOwner:       "acme",
		RepoName:        "shop",
		TokenSecretRef:  "preview-scm-token",
		AppsRepoURL:     "https://github.com/acme/shop",
		AppsPath:        "deploy",
		PlacementMode:   types.PlacementModeNamespace,
		NamespacePrefix: "preview",
		Labels:          map[string]string{"alethia.io/project": "demo"},
	}
}

func TestRenderPreviewApplicationSet_Namespace(t *testing.T) {
	out, err := RenderPreviewApplicationSet(basePreviewInput())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{
		"kind: ApplicationSet",
		"name: preview-demo",
		"goTemplate: true",
		"- pullRequest:",
		"github:",
		"owner: 'acme'",
		"repo: 'shop'",
		"secretName: 'preview-scm-token'",
		"requeueAfterSeconds: 60",
		"name: 'preview-demo-{{ .number }}'", // ArgoCD placeholder, NOT Alethia-resolved
		`repoURL: "https://github.com/acme/shop"`,
		"targetRevision: '{{ .head_sha }}'", // deploys the PR's head_sha
		"path: 'deploy'",
		"server: 'https://kubernetes.default.svc'",
		"namespace: 'preview-{{ .number }}'",
		"project: preview-apps-demo", // #887: hardened project, NOT the wide-open "apps"
		"CreateNamespace=false",      // #887: the guardrails ApplicationSet owns the namespace
		"prune: true",
		`"alethia.io/project": "demo"`, // label propagated
	} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered ApplicationSet missing %q\n---\n%s", want, out)
		}
	}
	// Alethia's own [[ ]] template must be fully resolved; ArgoCD's {{ }} must survive.
	if strings.Contains(out, "[[") || strings.Contains(out, "]]") {
		t.Errorf("unresolved Alethia delimiters remain:\n%s", out)
	}
	if strings.Contains(out, "<no value>") {
		t.Errorf("template produced <no value>:\n%s", out)
	}
	// vcluster-only fields must not leak into a namespace placement.
	if strings.Contains(out, "name: '-{{ .number }}'") || strings.Contains(out, "\n        name:") {
		t.Errorf("namespace placement leaked a vcluster destination.name:\n%s", out)
	}
}

func TestRenderPreviewApplicationSet_Vcluster(t *testing.T) {
	in := basePreviewInput()
	in.PlacementMode = types.PlacementModeVcluster
	in.VClusterName = "preview-host"
	out, err := RenderPreviewApplicationSet(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{
		"name: 'preview-host-{{ .number }}'", // vcluster destination is by cluster name, per-PR
		"namespace: 'preview'",               // quoted, like the namespace arm — an unquoted `-` was not even valid YAML
	} {
		if !strings.Contains(out, want) {
			t.Errorf("vcluster ApplicationSet missing %q\n---\n%s", want, out)
		}
	}
	if strings.Contains(out, "server: 'https://kubernetes.default.svc'") {
		t.Errorf("vcluster placement should not emit a server destination:\n%s", out)
	}
}

func TestRenderPreviewApplicationSet_AnonymousWhenNoToken(t *testing.T) {
	in := basePreviewInput()
	in.TokenSecretRef = ""
	out, err := RenderPreviewApplicationSet(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(out, "tokenRef") {
		t.Errorf("expected no tokenRef when TokenSecretRef is empty:\n%s", out)
	}
}

func TestRenderPreviewApplicationSet_DefaultsNamespacePrefix(t *testing.T) {
	in := basePreviewInput()
	in.NamespacePrefix = ""
	out, err := RenderPreviewApplicationSet(in)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out, "namespace: 'preview-{{ .number }}'") {
		t.Errorf("empty NamespacePrefix should default to preview:\n%s", out)
	}
}

func TestRenderPreviewApplicationSet_FailsClosed(t *testing.T) {
	cases := map[string]func(*PreviewAppSetInput){
		"missing project":      func(in *PreviewAppSetInput) { in.Project = "" },
		"missing repo":         func(in *PreviewAppSetInput) { in.RepoName = "" },
		"missing apps repo":    func(in *PreviewAppSetInput) { in.AppsRepoURL = "" },
		"dedicated placement":  func(in *PreviewAppSetInput) { in.PlacementMode = types.PlacementModeDedicated },
		"empty placement":      func(in *PreviewAppSetInput) { in.PlacementMode = "" },
		"vcluster w/o cluster": func(in *PreviewAppSetInput) { in.PlacementMode = types.PlacementModeVcluster },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			in := basePreviewInput()
			mutate(&in)
			if _, err := RenderPreviewApplicationSet(in); err == nil {
				t.Errorf("expected error for %q, got nil", name)
			}
		})
	}
}
