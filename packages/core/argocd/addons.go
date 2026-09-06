// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"

	"github.com/alethialabs-io/alethialabs/packages/core/names"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"gopkg.in/yaml.v3"
)

// applicationTmpl renders a marketplace add-on as an ArgoCD Helm Application, mirroring the
// hardcoded platform templates (e.g. external-secrets-operator.yaml). Automated + self-heal
// so the cluster converges to the declared chart; CreateNamespace so the target namespace is
// made on first sync. The sync-wave orders installs (lower first).
// applicationTmpl renders an add-on as an ArgoCD Application. Two shapes share the template:
//   - a marketplace chart (Source=="", the default) — a Helm-registry chart (repoURL+chart),
//     placed in the "infra" project, automated + self-heal so the cluster converges.
//   - a bring-your-own chart (Source=="git") — a chart directory inside the customer's git repo
//     (repoURL+path+ref), pinned to its hardened "byo-<slug>" project (Project), with MANUAL sync
//     (no automated block, no prune, no self-heal) so an untrusted chart never auto-applies.
//
// CreateNamespace makes the target namespace on first sync; the sync-wave orders installs.
// ServerSideApply is set on both shapes so large-CRD charts (e.g. kube-prometheus-stack's
// monitoring.coreos.com CRDs) don't blow ArgoCD's 262144-byte client-side annotation limit
// on first apply.
// The Application wire shape, MARSHALLED rather than templated (#2589).
//
// WHAT THE TEMPLATE DID. `applicationTmpl` interpolated NINE values into YAML with no escaping
// whatsoever — `.Name`, `.ID`, `.Mode`, `.Source`, `.Project`, `.ChartRepo`, `.Path`, `.Chart` and
// `.Namespace` — and text/template does not escape anything. `.Namespace` is the readiest lever: it
// arrives from the add-on install spec, reaches the template untouched (there is no DNS-1123
// validator on this path anywhere in packages/core), and a value of the form
//
//	x
//	---
//	<an entire ClusterRoleBinding>
//
// closes the scalar and opens a SECOND document, which the runner then applies with the cluster's
// admin kubeconfig. That is the same class #2540 closed for the BYO namespace and #2588 closed for
// the sibling AppProject; this renderer kept interpolating raw, which is exactly the "fixed one
// renderer of a value while its sibling kept interpolating" mistake this repo has already paid for.
//
// THE TRAP IN THE OBVIOUS FIX. `targetRevision: "{{ .Version }}"` and the sync-wave annotation were
// ALREADY quoted, so a patch that "adds the missing quotes" looks complete while nine fields stay
// open — and quoting is not sufficient anyway, since a value containing a quote plus a newline
// escapes a quoted scalar too. Marshalling closes the class instead of one instance of it.
//
// A SECOND BUG DIES WITH IT. `helm.values` was a hand-indented literal block
// (`indent(valuesYAML, "        ")`). Any values map whose own YAML carried a line that dedented
// past that prefix would have broken the document; yaml.v3 now emits the block scalar itself and
// picks its own indent indicator.
//
// TYPED STRUCTS, not map[string]any: field ORDER is preserved (yaml.v3 sorts map keys, which would
// reshuffle the manifest on every render for no reason), and the shape is checked by the compiler
// rather than by whoever next reads a 60-line template.
type addonApplication struct {
	APIVersion string       `yaml:"apiVersion"`
	Kind       string       `yaml:"kind"`
	Metadata   addonAppMeta `yaml:"metadata"`
	Spec       addonAppSpec `yaml:"spec"`
}

type addonAppMeta struct {
	Name      string `yaml:"name"`
	Namespace string `yaml:"namespace"`
	// The sync-wave value MUST marshal as a STRING: ArgoCD reads the annotation as text, and an
	// unquoted 2 is an int. Held as a string for that reason, not as an int formatted late.
	Annotations map[string]string `yaml:"annotations"`
	Labels      map[string]string `yaml:"labels"`
	Finalizers  []string          `yaml:"finalizers"`
}

type addonAppSpec struct {
	Project           string                  `yaml:"project"`
	Source            addonAppSource          `yaml:"source"`
	Destination       addonAppDestination     `yaml:"destination"`
	IgnoreDifferences []addonIgnoreDifference `yaml:"ignoreDifferences"`
	SyncPolicy        addonSyncPolicy         `yaml:"syncPolicy"`
	RevisionHistory   int                     `yaml:"revisionHistoryLimit"`
}

type addonAppSource struct {
	RepoURL string `yaml:"repoURL"`
	// Exactly ONE of Path (git source) or Chart (helm source) is set; the other is omitted. The
	// template expressed this with an if/else, which is why both carry omitempty here.
	Path           string       `yaml:"path,omitempty"`
	Chart          string       `yaml:"chart,omitempty"`
	TargetRevision string       `yaml:"targetRevision"`
	Helm           addonAppHelm `yaml:"helm"`
}

type addonAppHelm struct {
	Values string `yaml:"values"`
}

type addonAppDestination struct {
	Server    string `yaml:"server"`
	Namespace string `yaml:"namespace"`
}

type addonIgnoreDifference struct {
	Group string `yaml:"group"`
	Kind  string `yaml:"kind"`
	// Name scopes an entry to ONE object. Every entry above it is a fact about a Kubernetes API
	// (a removed field, an API-server-managed default) and rightly applies to every object of that
	// kind; the keda one below is a fact about ONE controller's behaviour, and applying it to every
	// ValidatingWebhookConfiguration would ignore a caBundle on webhooks whose caBundle nobody
	// writes — which is the shape #2778 warns about, a guessed entry masking real drift.
	Name              string   `yaml:"name,omitempty"`
	JSONPointers      []string `yaml:"jsonPointers,omitempty"`
	JQPathExpressions []string `yaml:"jqPathExpressions,omitempty"`
	// ManagedFieldsManagers ignores by OWNER rather than by path: whatever a named field manager
	// owns is excluded from the diff, and every other writer's value for the same field is still
	// compared. It is the primitive a "a foreign controller overwrites this" entry actually means,
	// and it is the third entry-scoping field added here in as many changes (`Name` arrived in
	// #3328) — all three are argo-cd-supported and none was here because nothing had needed them.
	//
	// IT DOES NOT SUBSUME A PATH IGNORE, and the boundary is exact rather than a matter of taste.
	// Read out of argo-cd v3.3.9 (the pinned version — see versions.go), `util/argo/diff/diff.go`
	// `preDiffNormalize` → `util/argo/managedfields.Normalize` → `normalize`:
	//
	//	intersect := mfs.Intersection(tr.comparison.Modified)
	//	tr.live   = tr.live.RemoveItems(intersect)
	//	tr.config = tr.config.RemoveItems(intersect)
	//
	// `Modified` alone. The comparison is `typedLive.Compare(typedConfig)`, and
	// structured-merge-diff v6 documents its three sets as disjoint: `Modified` is "fields present
	// in both objects but different", `Removed` is "any fields removed by rhs" — i.e. present in
	// live and ABSENT from the render. So a field the chart never writes is in `Removed`, is never
	// in the intersection, and NO owner list can ignore it. Only a jq path or a JSON pointer can.
	//
	// Both mechanisms do run for the same entry: `util/argo/diff.Normalize` calls
	// `preDiffNormalize` and then the jq/pointer `ignoreNormalizer`, and the latter iterates
	// `ignore[i].JQPathExpressions` without consulting `ManagedFieldsManagers`. Carrying both on
	// one entry is therefore additive, not a conflict — which is what the keda entry below needs.
	//
	// The sync honours it too, not just the diff view: `controller/sync.go` gates
	// `normalizeTargetResources` on `RespectIgnoreDifferences=true`, and that calls the same
	// `diff.Normalize`. Every add-on Application already sets both that option and
	// `ServerSideApply=true`, which is what populates the `metadata.managedFields` this reads.
	ManagedFieldsManagers []string `yaml:"managedFieldsManagers,omitempty"`
}

type addonSyncPolicy struct {
	// Automated is nil for git (BYO) sources — an untrusted chart is not self-healed or pruned
	// automatically. The template expressed the same split with an if/else.
	Automated *addonAutomated `yaml:"automated,omitempty"`
	// ManagedNamespaceMetadata labels the namespace ArgoCD creates under CreateNamespace=true.
	// Nil unless the add-on declares a Pod Security level (#2837).
	ManagedNamespaceMetadata *addonNamespaceMetadata `yaml:"managedNamespaceMetadata,omitempty"`
	SyncOptions              []string                `yaml:"syncOptions"`
}

// addonNamespaceMetadata carries the labels ArgoCD stamps on the namespace it creates for an
// Application. Used only to widen Pod Security admission for an add-on that genuinely needs host
// access, and ONLY on that add-on's own namespace.
type addonNamespaceMetadata struct {
	Labels map[string]string `yaml:"labels,omitempty"`
}

// podSecurityEnforceLabel is the upstream label the PodSecurity admission plugin reads.
const podSecurityEnforceLabel = "pod-security.kubernetes.io/enforce"

// validPodSecurityLevels are the three levels the upstream label accepts. An add-on asking for
// anything else is IGNORED rather than rendered: a typo must not silently become a namespace label
// the API server rejects, taking the whole Application's sync down with it.
var validPodSecurityLevels = map[string]bool{
	"privileged": true,
	"baseline":   true,
	"restricted": true,
}

// namespaceMetadataFor renders an add-on's declared Pod Security level into namespace labels, or
// nil when it declares none (leave the namespace unlabelled and the cluster default in force).
func namespaceMetadataFor(level string) *addonNamespaceMetadata {
	if !validPodSecurityLevels[level] {
		return nil
	}
	return &addonNamespaceMetadata{Labels: map[string]string{podSecurityEnforceLabel: level}}
}

type addonAutomated struct {
	Prune    bool `yaml:"prune"`
	SelfHeal bool `yaml:"selfHeal"`
}

// AddOnAppName is the ArgoCD Application name for an add-on. Deterministic (the catalog id),
// so re-deploys converge on the same Application rather than creating duplicates. Exported so
// the health read-back can address the same names.
func AddOnAppName(id string) string {
	// UNBOUNDED, deliberately. An Application is a CRD instance, so Kubernetes validates its name as
	// a DNS-1123 SUBDOMAIN (≤253) — not the ≤63 of a label — and `addon-<70 chars>` applies today.
	// A BYO chart attached before #3665 has exactly such an id, because chartSlug had no cap.
	//
	// Bounding here would therefore not prevent an impossible name; it would CHANGE the identity of
	// objects that already exist. This name is also the Helm release name and the string
	// ManagedAddOnNames feeds to PruneManagedAddOns, which deletes every managed Application NOT in
	// that list — so a truncated name would prune the live one and cascade its workloads. The cap
	// belongs where the id is WRITTEN (lib/validations/names.ts), applying to new ids only.
	return names.AddOnAppNamePrefix + id
}

// RenderManagedAddOns writes one ArgoCD Application manifest per managed add-on into a fresh
// temp dir and returns it, ready for ApplyApplications (kubectl apply). Gitops-mode add-ons
// are skipped here (Phase 2 writes those into the customer's apps repo). Returns an empty dir
// (and no error) when there are no managed add-ons, so the caller can apply unconditionally.
// commonLabels are the classification/sweep labels stamped onto each Application (BYOC B1.4);
// pass nil to add none. This path also renders BYO (git-source) chart Applications, so their
// Applications get the same attribution labels.
func RenderManagedAddOns(addons []types.AddOnInstall, commonLabels map[string]string) (string, error) {
	outDir, err := os.MkdirTemp("", "argocd-addons-*")
	if err != nil {
		return "", fmt.Errorf("failed to create temp dir: %w", err)
	}

	for _, a := range addons {
		if a.Mode != "managed" {
			continue
		}
		// Manifest-source add-ons (the operator rail) are kubectl-applied by the runner
		// (ApplyManifestAddOns) BEFORE this render — they get no ArgoCD Application at all, so
		// rendering one would produce an Application whose source is a bare YAML URL, which
		// ArgoCD cannot resolve.
		if a.IsManifestSource() {
			continue
		}
		manifest, err := RenderAddOnApplication(a)
		if err != nil {
			return "", fmt.Errorf("failed to render add-on %s: %w", a.ID, err)
		}
		labeled, err := InjectCommonLabels(manifest, commonLabels)
		if err != nil {
			return "", fmt.Errorf("failed to label add-on %s: %w", a.ID, err)
		}
		dst := filepath.Join(outDir, AddOnAppName(a.ID)+".yaml")
		if err := os.WriteFile(dst, []byte(labeled), 0644); err != nil {
			return "", fmt.Errorf("failed to write add-on %s: %w", a.ID, err)
		}
	}

	return outDir, nil
}

// RenderAddOnApplication produces the ArgoCD Application YAML for a single add-on: the Helm
// values map is marshalled to YAML and indented under `helm.values: |` (a literal block).
// Exported so gitops-mode writes reuse the exact same manifest body the managed apply uses.
func RenderAddOnApplication(a types.AddOnInstall) (string, error) {
	valuesYAML, err := marshalValues(a.Values)
	if err != nil {
		return "", err
	}
	mode := a.Mode
	if mode == "" {
		mode = "managed"
	}
	source := a.Source
	if source == "" {
		source = "helm"
	}
	project := a.Project
	if project == "" {
		project = "infra"
	}
	app := addonApplication{
		APIVersion: "argoproj.io/v1alpha1",
		Kind:       "Application",
		Metadata: addonAppMeta{
			Name:      AddOnAppName(a.ID),
			Namespace: "argocd",
			Annotations: map[string]string{
				"argocd.argoproj.io/sync-wave": strconv.Itoa(a.SyncWave),
				// Server-Side Diff. MEASURED, not chosen — see the SyncPolicy comment below for the
				// mechanism and for the run that settled it. `ServerSideApply=true` also selects the
				// diff STRATEGY, and the one it selects (structured-merge) cannot reproduce the
				// fields the API server materialises inside a StatefulSet's volumeClaimTemplates, so
				// those Applications sat Healthy-but-OutOfSync forever. This annotation overrides
				// only the comparison; the apply is untouched.
				"argocd.argoproj.io/compare-options": "ServerSideDiff=true",
			},
			Labels: map[string]string{
				"alethia.io/managed-by":   "addon-marketplace",
				"alethia.io/addon-id":     a.ID,
				"alethia.io/addon-mode":   mode,
				"alethia.io/addon-source": source,
			},
			Finalizers: []string{"resources-finalizer.argocd.argoproj.io"},
		},
		Spec: addonAppSpec{
			Project: project,
			Source: addonAppSource{
				RepoURL:        a.ChartRepo,
				TargetRevision: a.Version,
				Helm:           addonAppHelm{Values: valuesYAML},
			},
			Destination: addonAppDestination{
				Server:    "https://kubernetes.default.svc",
				Namespace: a.Namespace,
			},
			// Under ServerSideApply, ArgoCD's predicted-live carries the API-server-managed status, so
			// the Kubernetes 1.33+ apps/Deployment .status.terminatingReplicas field (KEP-3973) shows up
			// as a permanent SPURIOUS diff -> the Application is stuck OutOfSync, and selfHeal cannot fix
			// it (you cannot apply status). Client-side apps strip status and stay Synced; SSA apps (all
			// marketplace add-ons) do not. Kubernetes also defaults resourceFieldRef.divisor to "1";
			// ignore that API-server-only default so it cannot pin a Deployment-backed add-on OutOfSync.
			// RespectIgnoreDifferences makes the sync honor both ignores too.
			IgnoreDifferences: []addonIgnoreDifference{
				{
					Group:             "apps",
					Kind:              "Deployment",
					JSONPointers:      []string{"/status/terminatingReplicas"},
					JQPathExpressions: []string{".spec.template.spec.containers[]?.env[]?.valueFrom.resourceFieldRef.divisor"},
				},
				{
					// `spec.preserveUnknownFields` was REMOVED in apiextensions.k8s.io/v1: the API
					// server accepts `false` and does not persist it. A chart that still declares it
					// therefore renders a field the cluster will never report back, and the
					// Application is permanently OutOfSync on a value nobody can change.
					//
					// MEASURED, not guessed — this is the first field ArgoCD's own diff has ever
					// named here, because that diagnostic could not run until #2907 and #2947.
					// hetzner/addons run 33067969126:
					//
					//   ===== apiextensions.k8s.io/CustomResourceDefinition /analysisruns.argoproj.io =====
					//   78a79
					//   >   preserveUnknownFields: false
					//
					// five times, once per argo-rollouts CRD. Rendering the pinned chart confirms all
					// five declare it, so desired has the field and live does not — the count and the
					// direction both match.
					//
					// Scoped to the CRD kind rather than added to the Deployment entry above: this is
					// a different resource and a different mechanism (a removed API field, not an
					// API-server-managed default), and folding them together would hide which chart
					// each one exists for.
					Group:        "apiextensions.k8s.io",
					Kind:         "CustomResourceDefinition",
					JSONPointers: []string{"/spec/preserveUnknownFields"},
				},
				{
					// keda's admission webhook, and the ONLY entry here scoped to a single object.
					//
					// MEASURED on azure/addons run 33249209041, by the field-ownership probe #3301
					// repaired — before that repair the same probe reported "every field is
					// ArgoCD-owned — no foreign default to blame" on this very object, because
					// `kubectl get -o json` strips managedFields without --show-managed-fields:
					//
					//   owned by "admissionsenforcer": .webhooks[*].namespaceSelector
					//   owned by "keda":               .webhooks[*].clientConfig.caBundle
					//
					// TWO writers, and they explain the cloud split that made this look like a
					// flake. `keda` is the operator injecting its own serving CA, on every cloud.
					// `admissionsenforcer` is AKS's Admissions Enforcer, which exists on AKS ALONE —
					// which is why gcp and hetzner converged with the identical chart and values
					// (`{"operator":{"replicaCount":1}}`, byte-identical in all five fixtures) while
					// azure sat Healthy+OutOfSync from the ten-minute mark to the 35-minute deadline
					// across two paid runs.
					//
					// THE TWO FIELDS ARE NOT ALIKE, and an earlier version of this comment claimed
					// they were. It said the chart renders "no namespaceSelector for the enforcer to
					// conflict with". That is FALSE, and rendering the pinned chart settles it:
					//
					//   helm template addon-keda kedacore/keda --version 2.15.1 -n keda \
					//     --set operator.replicaCount=1
					//   → namespaceSelector: {}   on all three webhooks
					//
					// `caBundle` genuinely is absent from the render — keda writes it and ArgoCD has
					// no opinion. `namespaceSelector` is ours: the chart authors `{}`, ArgoCD applies
					// it and therefore OWNS it, and AKS's enforcer overwrites it. That conflict is
					// exactly the mechanism, and it is why ignoring the field is the right remedy on
					// AKS — but it is NOT the same claim as "we never wrote it".
					//
					// SO THE TWO FIELDS GET TWO MECHANISMS (#3346). Both were once jq paths, and a
					// path ignore silences a field no matter who wrote it: a future chart that
					// scopes the selector to a real namespace would have been silently unenforced
					// on all five clouds, with RespectIgnoreDifferences excluding it from the apply
					// as well. `namespaceSelector` is now ignored by OWNER, which keeps a
					// chart-authored value compared because ArgoCD, not the enforcer, would own it.
					//
					// `caBundle` KEEPS ITS PATH, and #3346 proposed dropping it — "it needs no jq
					// path at all". That is false, and argo-cd's source settles it rather than
					// taste: `managedfields.normalize` strips only
					// `mfs.Intersection(comparison.Modified)`, and `Modified` is fields present in
					// BOTH live and the render. The render carries no `caBundle` at all, so it sits
					// in `comparison.Removed` and no owner list can ever reach it. Swapping it too
					// would have silently dropped the ignore and left keda OutOfSync on every
					// cloud, not just AKS. The full derivation is on ManagedFieldsManagers above.
					//
					// ONLY `admissionsenforcer` IS TRUSTED, not `keda` as well. `keda` in the list
					// would be inert for the reason just given, and an owner-scoped ignore is
					// UNBOUNDED — it excludes every field that manager owns and differs, not the
					// one it was measured on. That is the honest cost of this expression: if a keda
					// chart declares a `failurePolicy` or `matchConditions` that AKS's enforcer
					// also rewrites, the diff goes quiet on it. Naming one manager instead of two
					// halves that blast radius for nothing given up, and the manager kept is the
					// one the conflict was actually measured against.
					//
					// AND THE MATCH IS EXACT. `managedfields.trustedManager` is `m == curManager`,
					// where this repo's own ownership probe matches ArgoCD's manager by SUBSTRING
					// precisely because manager names drift between versions. So the spelling has to
					// be the API server's own, and it is: `foreignFieldOwners` keys on the raw
					// `.metadata.managedFields[].manager` and the probe prints it with `%q`, so
					// `admissionsenforcer` above is transcribed from that run's output rather than
					// from Azure's prose. If AKS renames its enforcer this entry silently becomes a
					// no-op, with `normalized` left false and nothing logged. That failure is the
					// safe direction — keda returns to Healthy+OutOfSync on azure, loudly, exactly
					// as it did in #3328 — whereas the path form failed by going quiet about a
					// field we cared about. It is still the reason not to widen this to managers
					// nothing has measured.
					Group:                 "admissionregistration.k8s.io",
					Kind:                  "ValidatingWebhookConfiguration",
					Name:                  "keda-admission",
					JQPathExpressions:     []string{".webhooks[]?.clientConfig.caBundle"},
					ManagedFieldsManagers: []string{"admissionsenforcer"},
				},
			},
			SyncPolicy: addonSyncPolicy{
				// `ServerSideApply=true` ALSO PICKS THE DIFF STRATEGY, and on the pinned argo-cd it
				// picks a broken one. This is the cause of #2717's "OutOfSync while `argocd app
				// diff` prints nothing", read out of argo-cd v3.1.8 (chart 8.6.4) rather than
				// guessed:
				//
				//	controller/state.go, CompareAppState:
				//	  if app.Spec.SyncPolicy.SyncOptions.HasOption("ServerSideApply=true") {
				//	      diffConfigBuilder.WithStructuredMergeDiff(true)
				//	  }
				//
				// Structured-merge diff predicts the apply CLIENT-side, so it drops the fields the
				// API server materialises into an embedded ObjectMeta — a StatefulSet's
				// `spec.volumeClaimTemplates[]` comes back with apiVersion, kind,
				// `metadata.creationTimestamp: null`, `status.phase` and `spec.volumeMode` that the
				// chart never wrote, and the prediction is permanently unequal to live
				// (argoproj/argo-cd#11143, #11106, #16707, #18568). argo-cd's own docs mark the
				// strategy "Feature Discontinued … after different issues were identified by the
				// community".
				//
				// ── WHAT THE CHART PIN DID AND DID NOT FIX (hetzner/addons run 33162842830) ──
				//
				// The 8.6.4 → 9.5.11 bump (v3.1.8 → v3.3.9, #3128) cleared MOST of the class:
				// kyverno's CronJobs, loki's StatefulSet and falco all went Healthy+Synced. FOUR
				// StatefulSets did not — addon-harbor-{database,redis,trivy} and addon-tempo.
				//
				// The asymmetry names the shape, and it was found by RENDERING the pinned charts
				// rather than by reasoning. Every `volumeClaimTemplates` entry that stays OutOfSync
				// declares `metadata.annotations` with a NULL value and carries no `apiVersion` /
				// `kind` on the embedded PVC; both entries that now pass declare apiVersion + kind
				// and have no null-valued key at all:
				//
				//	loki 6.6.0    - apiVersion: v1              SYNCED
				//	                kind: PersistentVolumeClaim
				//	                metadata: {name: storage}
				//	minio 5.2.0   same shape                    SYNCED
				//	tempo 1.10.3  - metadata:                   OutOfSync
				//	                  name: storage
				//	                  annotations:      <- null
				//	                spec:
				//	                  storageClassName: <- null
				//	harbor 1.15.1 - metadata:                   OutOfSync  (x3: database, redis, trivy)
				//	                  name: …
				//	                  labels: {…}
				//	                  annotations:      <- null
				//
				// Two fields co-vary across those six, so this NARROWS to a pair rather than naming
				// one. Note harbor's registry/jobservice Deployments carry `strategy.rollingUpdate:
				// null` and are SYNCED — so an explicit null is not by itself enough; it is a null
				// (or a missing TypeMeta) inside the embedded PVC of a volumeClaimTemplate.
				//
				// ── ONE FIX THAT LOOKS RIGHT AND IS NOT ──
				//
				//   an ignoreDifferences on volumeClaimTemplates — refuted twice on #2717 already.
				//     It suppresses a diff on fields argo-cd itself authored, and it would hide a
				//     real change to a storage request forever.
				//
				// ── AND ONE THAT WAS REFUTED FOR A REASON THAT NO LONGER HOLDS ──
				//
				// This comment used to rule out compare-options `ServerSideDiff=true` on
				// argoproj/argo-cd#24423 (ServerSideDiff PLUS ignoreDifferences → empty diff,
				// resource still OutOfSync). THAT RULING WAS PIN-SPECIFIC AND IS NOW STALE: #24423's
				// fix is gitops-engine#747 (`skipFullNormalize`), absent from the gitops-engine
				// commit v3.1.8 pinned and PRESENT in v3.3.9's in-tree copy — `Normalize()` there
				// reads `if !o.skipFullNormalize`, and `Diff` sets it on the serverSideDiff path.
				// Re-read at the v3.3.9 tag, not inferred from dates.
				//
				// What the v3.3.9 tree says about the strategy actually in use:
				//
				//	controller/state.go still does `WithStructuredMergeDiff(true)` for
				//	  ServerSideApply=true — unchanged at v3.3.9, v3.5.2 AND master.
				//	gitops-engine/pkg/diff/diff.go `statefulSetWorkaround` — whose own doc comment
				//	  says "StatefulSet requires special handling since it embeds
				//	  PersistentVolumeClaim … K8S API server applies additional default field which
				//	  we cannot reproduce on client side" — is reachable ONLY from the client-side
				//	  three-way path. The structured-merge path gets no such compensation.
				//	The SMD functions are BYTE-IDENTICAL from v3.3.9 to master bar one cosmetic
				//	  `bytes.Equal`. So NO ARGO-CD VERSION ABOVE v3.3.9 FIXES THIS — another chart
				//	  bump is not the lever, and argo-helm has no v3.3.10+ chart anyway (9.5.12
				//	  jumps to v3.4.1).
				//	argo-cd#24791 — StatefulSet permanently OutOfSync on
				//	  `.spec.volumeClaimTemplates[].metadata.creationTimestamp` with SSA +
				//	  RespectIgnoreDifferences + an explicit ignore rule — was CLOSED by the
				//	  maintainers with "enable ServerSideDiff", not by a PR. #16707 confirms the same
				//	  volumeClaimTemplates symptom still reproducing on v3.3.2. argo-cd#29103
				//	  ("Default to SSD with SSA and remove SMD") is open: upstream is RETIRING this
				//	  strategy, not fixing it.
				//
				// ── THE MEASUREMENT WAS TAKEN, AND `ServerSideDiff=true` IS NOW SET ──
				//
				// It is set as a compare-option ANNOTATION in the Metadata literal above, not as a
				// syncOption here: it overrides the COMPARISON only. `ServerSideApply=true` below is
				// deliberately unchanged, so the apply is exactly what it was.
				//
				// The bar this had to clear was never "an argument that it should work". Our own
				// predicted-live probe measured that a `kubectl apply --server-side
				// --dry-run=server --field-manager=argocd-controller` predicts all four live
				// StatefulSets EXACTLY — but that is OUR reproduction, and argo-cd's server-side
				// path also applies normalizers and removeWebhookMutation. The ruling was that only
				// argo-cd's OWN comparison could authorise the flip.
				//
				// Asking the CLI for it does not work and cannot be made to: it refuses
				// `--server-side-diff` unless the Application ALREADY carries the annotation under
				// evaluation, and its RPC needs a cluster REST config the `--core` path inside the
				// controller pod does not have (#3140, hetzner/addons run 33172643012). So
				// test/e2e/argo_ssd_experiment.go asked for the OUTCOME instead — it sets the
				// annotation on one already-failing Application, watches what the controller then
				// reports, and removes it again.
				//
				// hetzner/addons run 33199532768 returned FLIP WOULD FIX IT on BOTH subjects:
				//
				//	addon-tempo   OutOfSync → Synced, no sync operation in the window
				//	addon-harbor  OutOfSync → Synced, no sync operation in the window
				//
				// with `.spec` content identical across the window in both cases (metadata.generation
				// moved 82→84 and 89→91, which is the status-write counter #3203 established is not
				// a spec-change signal). Nothing about the cluster or the charts changed; the only
				// difference was the diff strategy.
				//
				// Reproduced independently, off the metered path, on kind + the pinned argo-cd
				// chart 9.5.11 (v3.3.9) driven through RenderAddOnApplication: addon-tempo comes up
				// Healthy/OutOfSync on apps/StatefulSet/addon-tempo and goes to Synced with zero
				// residual OutOfSync resources the moment the annotation lands.
				//
				// AND — the property no version of this experiment tested, because it is the one
				// that matters to whoever is on call — the flip does NOT blind the diff. On that
				// same rig, with ServerSideDiff on and the Application Synced, changing the live
				// StatefulSet's container image out from under argo-cd put it straight back to
				// OutOfSync naming that StatefulSet. That is the whole reason an ignoreDifferences
				// on volumeClaimTemplates was refused twice: suppressing the symptom would have
				// bought the same green by making argo-cd stop looking, and drift would have gone
				// undetected forever.
				//
				// Removing ServerSideApply is NOT an option — see the package comment: it is what
				// keeps kube-prometheus-stack's CRDs under the 262144-byte annotation limit.
				SyncOptions:              []string{"CreateNamespace=true", "ServerSideApply=true", "RespectIgnoreDifferences=true"},
				ManagedNamespaceMetadata: namespaceMetadataFor(a.PodSecurity),
			},
			RevisionHistory: 3,
		},
	}
	if source == "git" {
		app.Spec.Source.Path = a.Path
		// A BYO chart DEPLOYS, with prune and self-heal both off (#2910).
		//
		// This branch used to leave `automated` nil, reasoning that "an untrusted chart must not be
		// self-healed or pruned without a deploy asking for it". That reasoning is right and it is
		// preserved exactly — both sub-options are false below. What it did NOT justify is leaving
		// the chart unsynced, and that is what nil meant: an Application with no `automated` policy
		// never syncs on its own, and NOTHING in this codebase ever synced one. A customer's chart
		// got a namespace, a repository credential and a hardened AppProject, and then deployed
		// nothing at all — silently, with no error and no signal.
		//
		// It survived because the only sync in the tree is the e2e's `triggerArgoSync`, so the
		// harness was proving a path a customer does not have.
		//
		// Presence of `automated` is what enables auto-sync; `prune` and `selfHeal` are independent
		// sub-options that default to false. So this deploys the chart while keeping both
		// protections the original comment asked for:
		//
		//   prune:false    a resource the customer REMOVES from their chart keeps running. That is
		//                  a deliberate trade — we do not delete a customer's workload because
		//                  their chart stopped mentioning it. It is also narrow: the Application
		//                  carries resources-finalizer.argocd.argoproj.io, so DISABLING the add-on
		//                  deletes the Application and cascades to its resources regardless. The
		//                  only lingering case is removal from within a chart that stays enabled,
		//                  which is documented on the BYO charts concept page.
		//   selfHeal:false ArgoCD does not fight an operator who edits a resource live, which is
		//                  exactly what someone debugging their own chart needs.
		//
		// The security boundary is unchanged and is not this field: it is the hardened AppProject
		// (empty clusterResourceWhitelist, Role/RoleBinding/ServiceAccount blacklisted, locked to
		// the declared repos and namespaces). Auto-sync does not widen what the chart may create.
		app.Spec.SyncPolicy.Automated = &addonAutomated{Prune: false, SelfHeal: false}
	} else {
		app.Spec.Source.Chart = a.Chart
		// A marketplace chart is ours: prune and self-heal so the cluster converges to what the
		// catalog declares.
		app.Spec.SyncPolicy.Automated = &addonAutomated{Prune: true, SelfHeal: true}
	}

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(app); err != nil {
		return "", fmt.Errorf("failed to marshal add-on Application %s: %w", a.ID, err)
	}
	if err := enc.Close(); err != nil {
		return "", fmt.Errorf("failed to marshal add-on Application %s: %w", a.ID, err)
	}
	return buf.String(), nil
}

// marshalValues renders the Helm values map to deterministic YAML (yaml.v3 sorts map keys),
// so the same values always produce the same manifest — stable diffs + no spurious ArgoCD
// OutOfSync. An empty/nil map yields "{}" so `helm.values` is always valid YAML.
func marshalValues(values map[string]interface{}) (string, error) {
	if len(values) == 0 {
		return "{}", nil
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(values); err != nil {
		return "", fmt.Errorf("failed to marshal helm values: %w", err)
	}
	_ = enc.Close()
	return buf.String(), nil
}

// ManagedAddOnNames returns the ArgoCD Application names for the managed add-ons, sorted.
// Manifest-source add-ons are EXCLUDED: they have no Application, so listing them here would make
// PruneManagedAddOns treat every other managed Application as undesired-but-present… and, worse,
// would have the prune expect an Application that can never exist.
func ManagedAddOnNames(addons []types.AddOnInstall) []string {
	var names []string
	for _, a := range addons {
		if a.Mode == "managed" && !a.IsManifestSource() {
			names = append(names, AddOnAppName(a.ID))
		}
	}
	sort.Strings(names)
	return names
}

// AllAddOnNames returns the ArgoCD Application names for every enabled add-on (managed +
// gitops), sorted — the health read-back reads them all (gitops child apps are named the
// same `addon-<id>`, created by the app-of-apps). Manifest-source add-ons are EXCLUDED: the runner
// kubectl-applies them, so ArgoCD has no Application for them and a health read would honestly
// report them Missing/Unknown forever.
func AllAddOnNames(addons []types.AddOnInstall) []string {
	names := make([]string, 0, len(addons))
	for _, a := range addons {
		if a.IsManifestSource() {
			continue
		}
		names = append(names, AddOnAppName(a.ID))
	}
	sort.Strings(names)
	return names
}

// PruneManagedAddOns deletes ArgoCD Applications this marketplace manages directly (label
// `alethia.io/addon-mode=managed`) that are NOT in `desiredNames` — i.e. add-ons the user
// disabled. The Application's finalizer cascades cleanup of its workloads. Best-effort: a
// read/delete hiccup is logged, not fatal (a failed prune must not fail an otherwise-healthy
// deploy). Gitops add-ons are pruned via their repo files, not here.
func PruneManagedAddOns(desiredNames []string, stdout, stderr io.Writer) error {
	desired := make(map[string]struct{}, len(desiredNames))
	for _, n := range desiredNames {
		desired[n] = struct{}{}
	}

	raw, err := utils.ExecuteCommandWithOutput(
		"kubectl get applications.argoproj.io -n argocd -l alethia.io/managed-by=addon-marketplace,alethia.io/addon-mode=managed -o json",
		".",
		nil,
	)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not list add-ons to prune: %v\n", err)
		return nil
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		fmt.Fprintf(stderr, "Warning: could not parse add-on list to prune: %v\n", err)
		return nil
	}

	for _, item := range list.Items {
		if _, keep := desired[item.Metadata.Name]; keep {
			continue
		}
		fmt.Fprintf(stdout, "Pruning disabled add-on: %s\n", item.Metadata.Name)
		cmd := fmt.Sprintf(
			"kubectl delete applications.argoproj.io -n argocd %s --ignore-not-found=true",
			item.Metadata.Name,
		)
		if delErr := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); delErr != nil {
			fmt.Fprintf(stderr, "Warning: failed to prune %s: %v\n", item.Metadata.Name, delErr)
		}
	}
	return nil
}

// ApplyAddOns applies the rendered managed add-on manifests (kubectl apply). A thin alias over
// ApplyApplications kept separate so the deploy log reads "add-ons" distinctly from the
// platform infra apply. A no-op (nil) when the dir is empty.
func ApplyAddOns(renderedDir string, stdout, stderr io.Writer) error {
	entries, err := os.ReadDir(renderedDir)
	if err != nil {
		return fmt.Errorf("failed to read add-on dir: %w", err)
	}
	if len(entries) == 0 {
		return nil
	}
	fmt.Fprintln(stdout, "Applying marketplace add-ons...")
	return ApplyApplications(renderedDir, stdout, stderr)
}
