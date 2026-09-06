// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"

	"github.com/alethialabs-io/alethialabs/packages/core/names"
	"gopkg.in/yaml.v3"
)

// RenderByoAppProject renders a HARDENED per-project ArgoCD AppProject for bring-your-own charts.
// Unlike the wide-open "infra"/"apps" projects (clusterResourceWhitelist [*,*], destinations
// namespace "*"), a BYO project is default-deny:
//   - sourceRepos is locked to exactly the customer's chart repos (no other repo can sync here);
//   - destinations are pinned to the in-cluster server + the specific namespaces the charts target;
//   - clusterResourceWhitelist is EMPTY — no cluster-scoped resource (CRD, ClusterRole/Binding,
//     Namespace, ValidatingWebhook, …) may be created by an untrusted chart;
//   - namespaceResourceBlacklist denies in-namespace privilege-escalation vectors (RBAC Role/
//     RoleBinding, ServiceAccount) so a chart can't grant itself extra permissions.
//
// This is the AppProject half of the trust boundary; namespace PSA + an admission controller
// (Kyverno/Gatekeeper) are the pod-level half added before untrusted charts are allowed.
// The AppProject wire shape, MARSHALLED rather than templated (#2540).
//
// WHAT THE TEMPLATE DID. It interpolated `{{ . }}` into quoted YAML scalars for BOTH sourceRepos and
// destinations, and text/template does no escaping whatsoever. #2576 closed exactly this hole in
// RenderByoNamespaces but not here — and the caller is fail-soft, so a namespace its validator
// REFUSED still reached this function, which rendered it raw. A namespace of the form
//
//	x"\n---\n<an entire ClusterRoleBinding>\nswallow: |2 #
//
// closes the quoted scalar, opens a second document, and ends with a block scalar carrying an
// explicit indent indicator — whose `#` swallows the template's own closing quote and whose body
// absorbs every remaining line of the AppProject. The result is two VALID documents, the second a
// ClusterRoleBinding to cluster-admin, applied by the runner with the cluster's admin kubeconfig.
// That is precisely the cluster-scoped power the empty clusterResourceWhitelist below exists to
// deny an untrusted chart. Not flag-gated: prepareByoCharts runs on every deploy carrying any
// git-source add-on (provisioner/deploy.go, byo_charts.go).
//
// TYPED STRUCTS, not map[string]any: field ORDER is preserved (yaml.v3 sorts map keys, which would
// reshuffle the manifest on every render for no reason), and the shape is checked by the compiler
// rather than by whoever next reads the template.
type byoAppProject struct {
	APIVersion string         `yaml:"apiVersion"`
	Kind       string         `yaml:"kind"`
	Metadata   byoProjectMeta `yaml:"metadata"`
	Spec       byoProjectSpec `yaml:"spec"`
}

type byoProjectMeta struct {
	Name       string            `yaml:"name"`
	Namespace  string            `yaml:"namespace"`
	Labels     map[string]string `yaml:"labels"`
	Finalizers []string          `yaml:"finalizers"`
}

type byoProjectSpec struct {
	Description  string           `yaml:"description"`
	SourceRepos  []string         `yaml:"sourceRepos"`
	Destinations []byoDestination `yaml:"destinations"`
	// MUST be a non-nil empty slice: yaml.v3 marshals a NIL slice as `null`, and an AppProject whose
	// clusterResourceWhitelist is `null` is not the same statement as one whose whitelist is `[]`.
	// This is the single field the whole hardening rests on, so its emptiness is asserted by a test
	// rather than left to whoever next edits this struct.
	ClusterResourceWhitelist   []byoGroupKind       `yaml:"clusterResourceWhitelist"`
	NamespaceResourceBlacklist []byoGroupKind       `yaml:"namespaceResourceBlacklist"`
	OrphanedResources          byoOrphanedResources `yaml:"orphanedResources"`
}

type byoDestination struct {
	Namespace string `yaml:"namespace"`
	Server    string `yaml:"server"`
}

type byoGroupKind struct {
	Group string `yaml:"group"`
	Kind  string `yaml:"kind"`
}

type byoOrphanedResources struct {
	Warn bool `yaml:"warn"`
}

// encodeByoDocs marshals one or more documents into a single YAML stream at the indent this
// package uses everywhere.
//
// Shared by BOTH byo renderers rather than written out twice. Beyond the duplication, the encoder's
// two error arms are not reachable from either caller — a bytes.Buffer write does not fail and the
// values are plain structs and maps — so having a copy per renderer meant four defensive branches no
// test can enter. One copy is one pair, and it is the pair that would actually catch a future value
// yaml.v3 refuses to marshal.
func encodeByoDocs(what string, docs ...any) (string, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	for _, d := range docs {
		if err := enc.Encode(d); err != nil {
			return "", fmt.Errorf("render byo %s: %w", what, err)
		}
	}
	if err := enc.Close(); err != nil {
		return "", fmt.Errorf("render byo %s: %w", what, err)
	}
	return buf.String(), nil
}

// byoRepoUnsafe rejects the injection vector WITHOUT pretending to be a URL parser.
//
// Deliberately not a URL allowlist. BYO chart repos legitimately arrive as `https://`, `ssh://`,
// `git@host:path` and bare paths, and a wrong allowlist REFUSES a repo that would have worked —
// worse than the gap it closes, which is the trade-off dns-zone-support.ts settles the same way. A control
// character is part of none of those forms, and it is the only thing that lets a value leave its
// scalar. Marshalling already makes injection structurally impossible; this refuses the absurd
// value outright so it fails here rather than later and more confusingly.
var byoRepoUnsafe = regexp.MustCompile(`[\x00-\x1f\x7f]`)

// byoProjectPrefix is what an AppProject name for BYO charts starts with. It is part of the
// LENGTH BUDGET, which is why the slug below is capped against it rather than after the join.
const byoProjectPrefix = "byo-"

// ByoProjectName derives a stable ArgoCD AppProject name for a project's BYO charts:
// "byo-<segment>". `slug` is typically the project's free-text name; the fallback keeps the name
// non-empty and the cap keeps it inside 63 characters.
//
// The derivation is names.LegacyObjectSegment, which is FROZEN and is deliberately not
// names.Slugify — this name is the identity of an AppProject that is already applied. See that
// function for the four shapes where the two differ and for why closing the gap is a migration
// rather than a rename. The local copy of the regex is gone; the rule now has one definition.
func ByoProjectName(slug string) string {
	s := names.LegacyObjectSegment(slug)
	if s == "" {
		s = "project"
	}
	return names.Bounded(byoProjectPrefix + s)
}

// RenderByoAppProject renders the hardened AppProject YAML locking BYO charts to their own repos
// + namespaces. Empty inputs are tolerated (an empty sourceRepos/destinations project simply
// admits nothing) so a mis-built snapshot fails closed rather than wide-open. commonLabels are the
// classification/sweep labels stamped onto the AppProject (BYOC B1.4); pass nil to add none.
func RenderByoAppProject(name string, sourceRepos, namespaces []string, commonLabels map[string]string) (string, error) {
	repos := dedupeNonEmpty(sourceRepos)
	ns := dedupeNonEmpty(namespaces)

	for _, r := range repos {
		if byoRepoUnsafe.MatchString(r) {
			return "", fmt.Errorf("render byo AppProject: source repo %q contains a control character", r)
		}
	}
	dests := make([]byoDestination, 0, len(ns))
	for _, n := range ns {
		// The SAME validator RenderByoNamespaces uses, so the two cannot disagree about what is
		// acceptable — which was the stated argument for refusing rather than normalising, and which
		// only holds once BOTH renderers actually apply it.
		if err := validateByoNamespace(n); err != nil {
			return "", fmt.Errorf("render byo AppProject: %w", err)
		}
		dests = append(dests, byoDestination{Namespace: n, Server: "https://kubernetes.default.svc"})
	}

	proj := byoAppProject{
		APIVersion: "argoproj.io/v1alpha1",
		Kind:       "AppProject",
		Metadata: byoProjectMeta{
			Name:       name,
			Namespace:  "argocd",
			Labels:     map[string]string{"alethia.io/managed-by": "byo-charts"},
			Finalizers: []string{"resources-finalizer.argocd.argoproj.io"},
		},
		Spec: byoProjectSpec{
			Description:              "Bring-your-own Helm charts (hardened, default-deny)",
			SourceRepos:              repos,
			Destinations:             dests,
			ClusterResourceWhitelist: []byoGroupKind{}, // non-nil — see the field comment
			NamespaceResourceBlacklist: []byoGroupKind{
				{Group: "rbac.authorization.k8s.io", Kind: "Role"},
				{Group: "rbac.authorization.k8s.io", Kind: "RoleBinding"},
				{Group: "", Kind: "ServiceAccount"},
			},
			OrphanedResources: byoOrphanedResources{Warn: true},
		},
	}

	rendered, err := encodeByoDocs("AppProject", proj)
	if err != nil {
		return "", err
	}
	labeled, err := InjectCommonLabels(rendered, commonLabels)
	if err != nil {
		return "", fmt.Errorf("label byo AppProject: %w", err)
	}
	return labeled, nil
}

// byoNamespaceTmpl renders the target namespaces for BYO charts.
//
// WHY THE RUNNER MUST CREATE THESE, and why `CreateNamespace=true` cannot.
//
// A BYO Application is rendered with the `CreateNamespace=true` sync option, which asks ArgoCD to
// create the destination namespace as part of the sync. Against a HARDENED BYO AppProject that can
// never work: `clusterResourceWhitelist` is empty, and a Namespace is a cluster-scoped resource —
// the byoAppProject comment above names Namespace in that list explicitly. So ArgoCD is asked
// to create a namespace it is simultaneously forbidden from creating, and every BYO chart whose
// namespace does not already exist fails its sync with
//
//	one or more objects failed to apply, reason: namespaces "<ns>" not found
//
// leaving the Application health=Missing sync=OutOfSync forever. That is not a race and no wait
// fixes it. It is what the BYO-IaC dimension did on its first ever real execution (gcp, #2490's
// sibling): `apps` and `external-secrets-operator` converged, `addon-byo-e2e` did not.
//
// The resolution is NOT to relax the AppProject — the whole point is that an untrusted chart may
// not create cluster-scoped objects. It is for the RUNNER, which is a trusted actor holding the
// cluster's admin kubeconfig, to create the namespace itself before the chart syncs into it. The
// trust boundary is unchanged: the chart still cannot create one.
//
// Pod-level hardening (Pod Security Admission labels + an admission controller) is deliberately NOT
// applied here. byoAppProject's comment scopes that as the separate pod-level half of the
// boundary, and inventing a PSA level here would silently change what customer charts are permitted
// to run — a security posture worth deciding explicitly rather than acquiring as a side effect of a
// bug fix.
// dns1123Label is Kubernetes' own rule for a Namespace name: lowercase alphanumerics and '-',
// starting and ending alphanumeric, at most 63 characters. Matched in FULL — an unanchored pattern
// would accept a valid prefix followed by anything at all, which is the whole attack.
//
// One definition, generated from apps/console/lib/validations/names.ts (#3665). These names stay
// as package-local aliases so the many call sites in this package and preview_validate.go read
// unchanged.
var dns1123Label = names.NamespacePattern

const dns1123LabelMaxLen = names.NamespaceMaxLength

// validateByoNamespace REFUSES a namespace Kubernetes itself would refuse, rather than normalising
// it.
//
// Normalising would be the more forgiving choice and it is the wrong one here, for a reason specific
// to this call site: the SAME string is also written into the hardened AppProject's `destinations`
// list. Silently rewriting it in one place and not the other would produce a project whose
// destination never matches the namespace the chart syncs into, and the failure would surface as an
// ArgoCD permission error naming neither cause.
func validateByoNamespace(ns string) error {
	if len(ns) > dns1123LabelMaxLen {
		return fmt.Errorf("namespace %q is %d characters; Kubernetes allows at most %d", ns, len(ns), dns1123LabelMaxLen)
	}
	if !dns1123Label.MatchString(ns) {
		return fmt.Errorf("namespace %q is not a valid DNS-1123 label (lowercase alphanumerics and '-', starting and ending alphanumeric)", ns)
	}
	return nil
}

// RenderByoNamespaces renders the destination namespaces for a project's BYO charts, so the runner
// can create them before the charts sync. Returns "" when there are none, which callers treat as
// "nothing to apply" rather than an error.
//
// # Why this is marshalled rather than templated (#2540)
//
// It used to interpolate the namespace RAW into hand-rolled YAML. Every other label-emitting path in
// this package round-trips through gopkg.in/yaml.v3 and is therefore quoted correctly; this one did
// not, and it is the one applied with the cluster's ADMIN kubeconfig as a standalone multi-document
// manifest. A namespace containing a newline and a `---` therefore yielded arbitrary top-level
// objects — a ClusterRoleBinding, say — created by the runner, which is precisely the cluster-scoped
// power the hardened AppProject exists to deny an untrusted chart. The fix that created the
// namespace to honour that boundary had opened a way around it.
//
// The value reaches here unvalidated: the console field is `z.string().trim().optional()` with no
// DNS-1123 check, and it lands in a plain `text()` column, so interior newlines survive to the
// runner.
//
// BOTH halves are kept. Marshalling makes injection structurally impossible — yaml.v3 quotes what
// needs quoting, so a hostile value becomes one absurd namespace NAME rather than a second document.
// Validation then refuses that absurd name outright, because a namespace Kubernetes would reject is
// a deploy that fails later and more confusingly. Either alone would close the hole; the pair also
// fails in the right direction.
func RenderByoNamespaces(namespaces []string, commonLabels map[string]string) (string, error) {
	ns := dedupeNonEmpty(namespaces)
	if len(ns) == 0 {
		return "", nil
	}

	labels := map[string]string{"alethia.io/managed-by": "byo-charts"}
	for k, v := range commonLabels {
		labels[k] = v
	}

	// Validate EVERY namespace before encoding any: a refusal must render nothing at all, not a
	// partial stream that happens to stop at the bad one.
	docs := make([]any, 0, len(ns))
	for _, n := range ns {
		if err := validateByoNamespace(n); err != nil {
			return "", fmt.Errorf("render byo namespaces: %w", err)
		}
		docs = append(docs, map[string]any{
			"apiVersion": "v1",
			"kind":       "Namespace",
			"metadata": map[string]any{
				"name":   n,
				"labels": labels,
			},
		})
	}
	return encodeByoDocs("namespaces", docs...)
}

// ByoRepoSecretName is the deterministic ArgoCD repository-Secret name for a BYO chart repo:
// "repo-byo-<12 hex of sha256(url)>". Per-repo (not the shared "repo-apps" name) so multiple
// BYO repos — and the apps-destination repo — never collide or read each other's credentials.
func ByoRepoSecretName(repoURL string) string {
	sum := sha256.Sum256([]byte(repoURL))
	return "repo-byo-" + hex.EncodeToString(sum[:])[:12]
}

// dedupeNonEmpty returns the input with blanks dropped and order-preserving de-duplication.
func dedupeNonEmpty(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}
