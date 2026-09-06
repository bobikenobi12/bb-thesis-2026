// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ArgoCD Application health/sync assertion — the shared "GitOps actually CONVERGED"
// half of the provisioning tiers (BYOC A0.2). RunDeployV2 installs ArgoCD and applies
// the rendered Applications on every cluster, but installed is not healthy: an app
// stuck Progressing / Degraded / OutOfSync passed T1 and T2 before this file existed.
// Both tiers now derive the set of Applications that MUST converge from the job's
// persisted execution_metadata and poll the cluster (via each tier's independent
// kubeconfig) until every one reports health "Healthy" AND sync "Synced" — the same
// fields packages/core/argocd/health.go (ReadAddOnHealth) reads, asserted instead of
// merely recorded.
//
// This file is deliberately UNTAGGED (like controlplane.go) so both build-tagged
// tiers compile it and `go mod tidy` sees its dependencies. Nothing here imports
// `testing`; the tagged tests drive it and own all failure handling.
//
// # How this assertion defends its own vacuity
//
//   - The expected set is DERIVED from the runner's persisted decisions — the
//     `infra_services` install/skip records plus the `addon_status` keys — never
//     hardcoded, so it cannot drift from what the deploy actually shipped.
//   - An EMPTY derived set is a hard error in BOTH DeriveExpectedArgoApps and
//     AssertArgoAppsHealthy: asserting over nothing proves nothing. The tiers seed a
//     tiny marketplace add-on (seedAddOns in controlplane.go) so the set is never
//     empty on the lean kind/hetzner paths, where every infra-service decision that
//     maps to an Application is honestly "skipped".
//   - The poll is BOUNDED (ALETHIA_E2E_ARGO_TIMEOUT, else DERIVED from the surface — see argoBudgetFor) and a timeout fails
//     with every expected app's health/sync/conditions plus a `kubectl describe` of
//     the losers, so a red merge-queue run or nightly is diagnosable from logs alone.
package e2e

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// argoPollInterval is how often AssertArgoAppsHealthy re-reads the Applications.
const argoPollInterval = 15 * time.Second

// argoAppState is one Application's observed status: the health/sync pair mirrors
// packages/core/argocd/health.go (AddOnHealth), plus the status conditions so a
// failure dump carries ArgoCD's own explanation (ComparisonError, SyncError, …).
type argoAppState struct {
	Health     string
	Sync       string
	Conditions []string
	// OutOfSyncResources names the individual resources ArgoCD reports as OutOfSync, as
	// `Kind/name`. Sorted and de-duplicated.
	//
	// WHY IT IS CARRIED. An Application that is Healthy AND OutOfSync is the most confusing
	// state this assertion can report: the workload is up, nothing in the cluster is wrong, and
	// the run still loses its verdict. On 2026-08-26 three add-ons sat there on BOTH hetzner and
	// aws — argo-rollouts, kyverno and tempo — and the report named the Applications without
	// naming what differed, so the only way to act on it was to reach for a live cluster.
	//
	// The answer was already in the payload: `.status.resources[]` carries a per-resource sync
	// status, and this assertion was fetching and discarding it. The Application template already
	// ignores two API-server-managed fields (`.status.terminatingReplicas`, the resourceFieldRef
	// divisor) for exactly this class; naming the resource is what tells you whether a third
	// belongs there.
	OutOfSyncResources []string
	// OutOfSyncRefs is the same set, structured, so the live objects can be fetched and dumped.
	// Naming the RESOURCE (#2738) answered "which object differs" and left "which FIELD differs"
	// to a guess — and a guessed ignoreDifferences entry can MASK REAL DRIFT rather than no-op.
	OutOfSyncRefs []outOfSyncRef
	// NotHealthyResources names the resources whose own health is not Healthy, with ArgoCD's
	// message for each.
	//
	// WHY IT IS CARRIED. An Application's health is an AGGREGATE, and reporting only the aggregate
	// left `health=Progressing` unattributable. On hetzner/addons run 33162842830 addon-harbor sat
	// Progressing for 50 minutes with all seven of its pods Running and ready — so the health was
	// not pod readiness, and the run could not say what it WAS. `kubectl describe application` does
	// carry it, but the describe is truncated by the dump's own size cap long before
	// `Status.Resources`, so the answer was fetched and thrown away twice over.
	//
	// This also separates two cases that had already cost #2717 two refuted hypotheses: an add-on
	// that is OutOfSync AND independently not finished, versus one whose health is Progressing
	// BECAUSE of the thing that is OutOfSync. Those have different fixes, and only the per-resource
	// health tells them apart.
	NotHealthyResources []string
}

// anyProvider is the infraServiceArgoApps inner key meaning "the same Application on
// every cloud" — the common case, where the service is cloud-agnostic.
const anyProvider = ""

// infraServiceArgoApps maps an `infra_services` decision (see
// packages/core/argocd/decisions.go InfraServiceDecisions) to the ArgoCD Application
// that ships it when the decision is "installed". Together with infraServiceNoApp it
// must cover EVERY service decisions.go can record: an installed decision matching
// neither is a hard derivation error (fail-closed — a renamed or newly added service
// must WIDEN the assertion, never silently shrink it), and a unit test pins both
// maps against the real InfraServiceDecisions service list.
//
// The mapping is PROVIDER-KEYED, because one service can ship a DIFFERENT Application
// per cloud: "ingress" is the ALB controller on AWS and will be something else entirely
// on GCP/Azure/Alibaba as those lanes land. Outer key = service, inner key = provider,
// with anyProvider ("") meaning "the same on every cloud" — the same shape of per-cloud
// membership fact as metricsServerProviders below.
//
// The fail-closed contract is UNCHANGED and, if anything, tighter: an "installed"
// decision whose cloud has no entry resolves to nothing, and — absent an
// infraServiceNoApp entry — is the same hard derivation error as an unknown service.
// A lane that flips its cloud's ingress decision to "installed" without naming the
// Application it renders therefore breaks the derivation loudly, instead of the run
// waiting out the whole ArgoCD timeout for an app nobody rendered (the #1722 shape).
var infraServiceArgoApps = map[string]map[string]string{
	// infra/templates/argocd/external-dns.yaml
	"external-dns": {anyProvider: "external-dns"},
	// the ClusterSecretStore renders inside the operator's template — an installed
	// store implies the external-secrets-operator Application must be healthy.
	"external-secrets-store": {anyProvider: "external-secrets-operator"},
	// the cross-account (*-xacct) ClusterSecretStore is applied by the RUNNER
	// (argocd.EnsureExternalSecretsStore), not by an Application of its own — but it is a
	// CR whose CRD and admission webhook ship with the operator, so exactly like the
	// native store above, an installed one implies external-secrets-operator is healthy.
	"external-secrets-store-xacct": {anyProvider: "external-secrets-operator"},
	// infra/templates/argocd/cert-manager.yaml — the platform (Rail B) cert-manager. Cloud-agnostic
	// HERE on purpose: the decision itself is already per-cloud (certManagerDecision is "installed"
	// only where CertManagerSolver() resolves, i.e. aws/gcp/azure on native DNS), and where it does
	// install it is the same Application everywhere. The ClusterIssuer the runner applies afterwards
	// is a CR, not an Application, so it adds nothing to this set.
	"cert-manager": {anyProvider: "cert-manager"},
	// ingressDecision is "installed" only where argocd.ingressControllers has an entry.
	// ONE LINE PER CLOUD: add the cloud's controller Application here in the same PR that
	// adds its ingressControllers entry, and the two stay in step. A cloud whose ingress is
	// installed but ships NO Application — GKE's controller runs in the Google-managed control
	// plane, so there is nothing to sync — belongs under its provider key in infraServiceNoApp
	// instead, never here with an empty string: "" would enter the expected set and make the
	// poll wait out the full timeout for an Application with no name.
	//
	// azure DOES ship one, so it is here rather than there: its Application name is the AGIC chart
	// name, pinned by `fullnameOverride: ingress-azure` in the template — the same string the
	// federated identity credential's KSA subject depends on.
	"ingress": {"aws": "aws-load-balancer-controller", "azure": "ingress-azure"},
	// appsRepoDecision is "installed" when the project wired an apps-destination repo: the
	// runner credentials ArgoCD to it (the shared "repo-apps" repository Secret) and renders
	// the credentialed "apps" app-of-apps that syncs the customer's repo (user-apps.yaml). This
	// is the repo-apps half of the ArgoCD-WITH-REPOS proof (BYOC A0.6) — deriving it here (never
	// hardcoding it) keeps the expected set honest with what the deploy actually shipped. The BYO
	// (repo-byo-*) half rides the addon_status keys: a bring-your-own git-source chart is a
	// managed add-on, so its "addon-<id>" Application is already in the derived set.
	"apps-repo": {anyProvider: "apps"},
}

// argoAppForInfraService resolves the Application an installed decision implies on this
// cloud: the cloud's own entry if there is one, else the cloud-agnostic anyProvider entry.
// ok=false means "this service ships no Application ON THIS CLOUD" — the caller must then
// find it in infraServiceNoApp or fail the derivation.
func argoAppForInfraService(provider, service string) (app string, ok bool) {
	byProvider, known := infraServiceArgoApps[service]
	if !known {
		return "", false
	}
	if app, ok := byProvider[provider]; ok {
		return app, true
	}
	app, ok = byProvider[anyProvider]
	return app, ok
}

// infraServiceNoApp whitelists the decisions that genuinely ship NO ArgoCD Application of their
// own: "storage-class" is a StorageClass object, "argocd-url" is an ingress on the ArgoCD install
// itself, and "waf" is an annotation or a small CR on that same ingress
// (alb.ingress.kubernetes.io/wafv2-acl-arn on AWS, a BackendConfig on GCP) — none has app health
// of its own.
//
// PROVIDER-KEYED, exactly like infraServiceArgoApps above and for the same reason one dimension
// over: whether a service ships an Application can differ per cloud. "ingress" is the case that
// forced it — the ALB controller is a real Application on AWS, while on GKE the Ingress controller
// runs in the Google-managed control plane and Alethia installs nothing. A service-level whitelist
// could not express that without whitelisting "ingress" on EVERY cloud, which would silently
// forgive the Azure and Alibaba lanes landing beside this one for shipping a controller whose
// Application the assertion never checks — the fail-closed contract this file is built on.
//
// anyProvider ("") means "ships no Application on any cloud" — the common case.
// Add an entry ONLY when the install truly has no Application to assert.
var infraServiceNoApp = map[string]map[string]struct{}{
	"storage-class": {anyProvider: {}},
	"argocd-url":    {anyProvider: {}},
	"waf":           {anyProvider: {}},
	// GKE Ingress: built into the managed control plane (see argocd.ingressControllers["gcp"]).
	// Deliberately NOT anyProvider — AWS resolves via infraServiceArgoApps first, but a cloud
	// that later installs a controller must still be forced to name it.
	"ingress": {"gcp": {}},
}

// infraServiceShipsNoApp reports whether an installed decision for `service` genuinely renders no
// ArgoCD Application ON THIS CLOUD — the cloud's own entry if there is one, else the cloud-agnostic
// anyProvider entry. False means the derivation must have found an Application for it, or fail.
func infraServiceShipsNoApp(provider, service string) bool {
	byProvider, known := infraServiceNoApp[service]
	if !known {
		return false
	}
	if _, ok := byProvider[provider]; ok {
		return true
	}
	_, ok := byProvider[anyProvider]
	return ok
}

// alwaysRenderedArgoApps are the Applications infra/templates/argocd renders
// UNCONDITIONALLY — no template render gate, no InfraServiceDecision records them,
// and CleanupSkippedInfraServices never deletes them — so EVERY successful deploy
// that ran the GitOps bootstrap (the tiers assert cluster_name, which gates that
// whole block) must have them converged, regardless of provider or configuration:
//   - external-secrets-operator: the operator Application in
//     external-secrets-operator.yaml is ungated (only the per-cloud
//     ClusterSecretStores inside the same template are conditional).
//
// A template gaining a render gate must move its app out of here and into the
// decision-derived mapping above — metrics-server did exactly that in #1722; see
// metricsServerProviders.
var alwaysRenderedArgoApps = []string{"external-secrets-operator"}

// metricsServerProviders are the clouds whose metrics-server.yaml actually renders:
// the ones whose managed control plane does NOT already ship a metrics-server.
// gcp (GKE addon-manager), azure (AKS-managed, with a VPA sidecar) and alibaba (ACK
// system component) each install their own into kube-system, so Alethia installing a
// second one is the #1722 ownership collision — there, no Application exists and
// waiting for one would hang the assertion until timeout on a cluster that is fine.
//
// This MUST mirror the `if` in infra/templates/argocd/metrics-server.yaml.
// TestMetricsServerGateMatchesTemplate pins the two together by parsing the template,
// so the pair cannot drift silently.
var metricsServerProviders = map[string]bool{"aws": true, "hetzner": true}

// DeriveExpectedArgoApps derives the ArgoCD Application names a successful deploy is
// REQUIRED to have converged: the always-rendered platform apps
// (alwaysRenderedArgoApps), plus metrics-server on the clouds that render it
// (metricsServerProviders), plus — from the job's persisted execution_metadata —
// every `infra_services` decision with status "installed" that ships an Application,
// plus every `addon_status` key (the runner records one per enabled add-on, named
// `addon-<id>` — see packages/core/argocd/addons.go AllAddOnNames). Returns the names
// sorted + de-duplicated.
//
// FAIL-CLOSED in both directions:
//   - an "installed" service that is in NEITHER infraServiceArgoApps NOR
//     infraServiceNoApp is an error — a renamed/new decision must widen the
//     assertion, never silently shrink it;
//   - an unknown `provider` is an error rather than a silent "no metrics-server";
//   - an empty derived set is an error, not an empty assertion (defense-in-depth;
//     structurally unreachable while alwaysRenderedArgoApps is non-empty). The tiers
//     additionally seed an add-on (seedAddOns) so the ADD-ON pipeline is always
//     exercised too, not just the platform apps.
func DeriveExpectedArgoApps(provider string, metaRaw []byte) ([]string, error) {
	if len(metaRaw) == 0 {
		return nil, errors.New("execution_metadata is empty — cannot derive the expected ArgoCD Application set")
	}
	// The provider decides one membership question (metrics-server), so an empty or
	// unknown one must NOT quietly answer it. Refuse instead: a typo'd provider would
	// otherwise silently drop metrics-server from the expected set on aws/hetzner and
	// turn a real regression into a pass.
	if _, known := t2LookupProvider(provider); !known {
		return nil, fmt.Errorf("unknown provider %q — cannot derive the expected ArgoCD Application set (known: %s)", provider, t2SupportedProviders())
	}
	var meta struct {
		InfraServices []struct {
			Service string `json:"service"`
			Status  string `json:"status"`
		} `json:"infra_services"`
		AddOnStatus map[string]json.RawMessage `json:"addon_status"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		return nil, fmt.Errorf("decode execution_metadata: %w", err)
	}

	set := map[string]struct{}{}
	for _, app := range alwaysRenderedArgoApps {
		set[app] = struct{}{}
	}
	if metricsServerProviders[provider] {
		set["metrics-server"] = struct{}{}
	}
	for _, d := range meta.InfraServices {
		if d.Status != "installed" {
			continue
		}
		if app, ok := argoAppForInfraService(provider, d.Service); ok {
			set[app] = struct{}{}
			continue
		}
		if infraServiceShipsNoApp(provider, d.Service) {
			continue
		}
		return nil, fmt.Errorf("unrecognized installed infra service %q on provider %q in execution_metadata — add it to infraServiceArgoApps (it ships an Application) or infraServiceNoApp (it genuinely ships none) in argocd_assert.go — BOTH maps are per-cloud, so the entry may be for this provider alone — and the assertion widens instead of silently shrinking", d.Service, provider)
	}
	for name := range meta.AddOnStatus {
		set[name] = struct{}{}
	}

	if len(set) == 0 {
		return nil, errors.New("derived ArgoCD Application set is EMPTY (no installed infra service ships an Application and no add-on was enabled) — the health assertion would be vacuous; seed at least one managed add-on in the job's config snapshot")
	}
	names := make([]string, 0, len(set))
	for n := range set {
		names = append(names, n)
	}
	sort.Strings(names)
	return names, nil
}

// RequireAllAddOnsExpected refuses a full-surface run whose ASSERTION set lost the add-ons.
//
// WHY, measured. hetzner/addons run 32883521925 reported
//
//	--- PASS: TestT2RealCloudProvisioning (1053.09s)
//
// having asserted FOUR Applications — `[addon-byo-e2e apps external-secrets-operator
// metrics-server]` — on the dimension whose own banner calls it "the 18-chart sweep to
// Healthy+Synced". No harbor, no kube-prometheus-stack, no loki, no vault. The 2026-08-24 run of
// the same dimension asserted twenty. `ALETHIA_E2E_ALL_ADDONS=1` was set and reached the harness.
//
// The add-on half of the expected set comes from `execution_metadata.addon_status`, and the same
// run logged why it was missing:
//
//	A0.5 WARN: reloader add-on health row absent/empty — finalizeDeployment.recordAddonHealth
//	did not persist real ArgoCD health
//
// So the assertion derives its own SCOPE from a source that can silently shrink. DeriveExpectedArgoApps
// guards `len(set) == 0` — "never empty" — and four is not zero, so a full-surface run reported
// green having proven the floor. That is precisely the vacuous proof `AllCatalogAddOns` already
// refuses on the SEEDING side ("a full-surface run that quietly installed 1 add-on and reported
// green would be the exact vacuous proof the FULLY-TESTED bar exists to prevent"); the same
// argument had never been applied to the ASSERTING side.
//
// The harness already knew the right number: `argoAddOnCount` sizes the convergence BUDGET from
// the catalog, so the budget expected eighteen while the assertion expected four. A decision that
// reports on an emitter must mirror every field the emitter set.
//
// A no-op unless ALETHIA_E2E_ALL_ADDONS is on — the lean tier genuinely seeds a small set.
func RequireAllAddOnsExpected(expected []string) error {
	if !AllAddOnsEnabled() {
		return nil
	}
	catalog, err := AllCatalogAddOns()
	if err != nil {
		// Fail-closed: unable to read the catalog is not "nothing to check".
		return fmt.Errorf("full add-on surface requested but the catalog fixture is unreadable, so the assertion set cannot be checked for completeness: %w", err)
	}
	have := make(map[string]struct{}, len(expected))
	for _, e := range expected {
		have[e] = struct{}{}
	}
	var missing []string
	for _, a := range catalog {
		if a.Mode != "managed" || a.IsManifestSource() {
			// Only ArgoCD-rendered add-ons produce an Application to assert on. A manifest
			// add-on is kubectl-applied and has none, so requiring one would red every run.
			continue
		}
		name := argocd.AddOnAppName(a.ID)
		if _, ok := have[name]; !ok {
			missing = append(missing, name)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	sort.Strings(missing)
	return fmt.Errorf(
		"ALETHIA_E2E_ALL_ADDONS=1 but %d of the catalog's Application-bearing add-ons are ABSENT from the expected set, so this run would assert the floor and report the 18-chart sweep: %s\n"+
			"  the set is derived from execution_metadata.addon_status; an empty/short one means finalizeDeployment.recordAddonHealth did not persist add-on health (look for the A0.5 WARN in this run)\n"+
			"  asserted instead: %v",
		len(missing), strings.Join(missing, ", "), expected)
}

// AssertArgoAppsHealthy polls `kubectl get applications.argoproj.io -n argocd -o json`
// via the given kubeconfig until EVERY expected Application reports health "Healthy"
// AND sync "Synced", or the timeout elapses. A bounded poll (argoPollInterval), so a
// never-converging app fails loudly instead of blocking forever. On timeout the error
// carries the full per-app state (health/sync/conditions for every expected app, plus
// every Application actually present) and a `kubectl describe` of each loser — enough
// to diagnose a red run from logs alone. An empty expected set is refused outright
// (see DeriveExpectedArgoApps).
//
// # Why it persists its own counts (#2688)
//
// The proof bundle's ArgoCD numbers used to come from `demos/proofs/capture-proof.sh`, which
// runs AFTER the tier's t.Cleanup has torn the cluster down — so it counted a cluster that no
// longer existed and wrote 0/0 for every run. A PASS bundle and a FAIL bundle were therefore
// NUMERICALLY IDENTICAL, and the only thing distinguishing them was the prose "(T2-asserted)",
// which is a claim rather than a measurement.
//
// The counts exist at the moment the assertion is made, and nowhere else afterwards. So they are
// written there, on EVERY exit path — converged, timed out, cancelled, or refused as vacuous.
// Writing only on success would reproduce the original defect in a new place: a missing file
// reads as "nothing went wrong" exactly as 0/0 did. That write lives in assertArgoConvergence,
// which is the single loop this and A0.6's assertion both delegate to; see #3281 for why being
// two loops made the counts vanish from every bundle the programme actually counts.
func AssertArgoAppsHealthy(ctx context.Context, kubeconfigPath string, expected []string, timeout time.Duration) error {
	return assertArgoConvergence(ctx, kubeconfigPath, expected, nil, timeout, argoConvergeSubject{
		vacuous:  "refusing a VACUOUS ArgoCD health assertion: the expected Application set is empty",
		deadline: "ArgoCD Applications",
		name:     "AssertArgoAppsHealthy",
	})
}

// argoConvergeSubject carries the only thing that differs between the two public assertions —
// their wording — so one loop can serve both without either losing the message an operator greps
// a red run for.
type argoConvergeSubject struct {
	// vacuous is the refusal returned for an empty expected set.
	vacuous string
	// deadline is the noun phrase the timeout error opens with.
	deadline string
	// name identifies WHICH assertion wrote a summary. Two convergence waits share this file and a
	// bundle that carries the wrong one gives no way to tell which — azure/addons run 33277183092
	// shipped a `vacuous` summary from a call nobody could identify from the artifact.
	name string
}

// assertArgoConvergence is THE ArgoCD convergence wait. Both public assertions delegate to it, and
// it is the ONLY place the convergence summary is registered.
//
// # Why this is one function and not two (#3281)
//
// It used to be two. AssertArgoAppsHealthy carried the deferred summary write; A0.6's
// AssertArgoReposConverge was a near-identical copy of the same poll that carried none. Every real
// run enables A0.6 — the nightly sets ALETHIA_E2E_ARGO_REPOS_REQUIRE whenever the apps-repo var is
// set, which is always — so every run took the copy WITHOUT the write, and shipped a bundle reading
// `argocd_assert_outcome: unmeasured` on an assertion that had just counted 22 Applications. The
// evidence for the add-on cells lived only in an expiring job log.
//
// Adding a second `defer` to the second copy would have been the same defect one layer along, and
// it would have written `unreadable`: that copy recorded `observed` only on the LOSING path, so on
// success there would have been no map to count. So there is one loop. A third convergence path
// cannot now be acquired without this instrumentation arriving with it.
//
// manualSync may be empty. A hardened bring-your-own chart renders with MANUAL sync and would sit
// OutOfSync forever, so any listed app not yet Healthy+Synced is re-issued a sync over its CR on
// each iteration, as an operator would; the last error per app is kept so a persistently REJECTED
// sync is reported rather than reading as merely slow.
func assertArgoConvergence(ctx context.Context, kubeconfigPath string, expected, manualSync []string, timeout time.Duration, subj argoConvergeSubject) (err error) {
	// Declared before the vacuity check so the deferred write covers that exit too — a run that
	// asserted over an empty set must leave evidence that it asserted nothing.
	var lastErr error
	var lastLosers []string
	var lastRefs []outOfSyncRef
	// Carried so the deadline dump can tell an OutOfSync loser (which HAS a diff to fetch) from a
	// Degraded-but-Synced one (which does not).
	var lastObserved map[string]argoAppState
	// Per manual-sync app, the error from its LAST sync attempt. A success voids an earlier
	// failure: carrying a stale error forward would report a problem that has since resolved.
	lastSyncErr := map[string]error{}
	if path := os.Getenv(ArgoSummaryEnv); path != "" {
		defer func() {
			s := newArgoConvergenceSummary(expected, lastObserved, lastLosers, timeout, err)
			s.Assertion = subj.name
			// ⚠️ A VACUOUS WRITE MUST NOT CLOBBER A MEASUREMENT. The file carries the RUN's
			// convergence evidence and every call writes it, so last-writer-wins is the wrong rule
			// the moment one of those writers asserted nothing: azure/addons run 33277183092
			// converged 20 of 20 and shipped `outcome: vacuous, expected_total: 0`, which
			// check-proof-integrity refuses — a cell that passed and cannot be promoted.
			//
			// Only the measured→vacuous DOWNGRADE is refused. When no measured summary exists the
			// vacuous one is still written, because "this run asserted nothing" is itself evidence
			// and losing it is how #3281 happened.
			if s.Outcome == "vacuous" && measuredSummaryExists(path) {
				fmt.Fprintf(os.Stderr, "argocd assert: %s asserted nothing over an empty set; "+
					"keeping the measured summary already at %s rather than overwriting it\n",
					orNone(subj.name), path)
				return
			}
			if werr := writeArgoSummary(path, s); werr != nil {
				// Never fatal: the assertion's verdict is the test's, not this file's. But it is
				// never silent either — a bundle that quietly lost its numbers is the defect.
				fmt.Fprintf(os.Stderr, "argocd assert: could not write the convergence summary to %s: %v\n", path, werr)
			}
		}()
	}
	if len(expected) == 0 {
		return errors.New(subj.vacuous)
	}
	deadline := time.Now().Add(timeout)
	for {
		raw, rerr := kubectlGetArgoApps(ctx, kubeconfigPath)
		if rerr != nil {
			// A read hiccup (apiserver blip, CRD not yet registered) is retried until the
			// deadline — unlike ReadAddOnHealth's best-effort Unknown, a persistent failure
			// here must FAIL, not soften.
			lastErr = fmt.Errorf("listing ArgoCD Applications failed: %w", rerr)
			lastLosers, lastRefs, lastObserved = nil, nil, nil
		} else if observed, perr := parseArgoApps(raw); perr != nil {
			lastErr = fmt.Errorf("parsing ArgoCD Applications failed: %w", perr)
			lastLosers, lastRefs, lastObserved = nil, nil, nil
		} else {
			// Nudge the manual-sync (hardened BYO) apps that have not converged yet. A no-op when
			// manualSync is empty, which is the plain assertion's shape.
			for _, name := range manualSync {
				st, ok := observed[name]
				if !ok || st.Health != "Healthy" || st.Sync != "Synced" {
					if serr := triggerArgoSync(ctx, kubeconfigPath, name); serr != nil {
						lastSyncErr[name] = serr
					} else {
						delete(lastSyncErr, name)
					}
				}
			}
			losers, everr := evaluateArgoApps(observed, expected)
			// Recorded on the WINNING path too, not just the losing one: on success the
			// deferred summary is the whole point, and `observed` is only in scope here.
			lastLosers, lastObserved = losers, observed
			if everr == nil {
				return nil
			}
			lastErr = everr
			lastRefs = refsForLosers(observed, losers)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s did not all reach Healthy+Synced within %s:\n%v%s%s",
				subj.deadline, timeout, lastErr,
				renderSyncErrors(lastSyncErr),
				argoDeadlineDump(ctx, kubeconfigPath, lastObserved, lastLosers, lastRefs))
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("context cancelled while waiting for ArgoCD Applications (%v); last state:\n%v", ctx.Err(), lastErr)
		case <-time.After(argoPollInterval):
		}
	}
}

// ArgoSummaryEnv names the file AssertArgoAppsHealthy writes its convergence counts to. It
// follows the six ALETHIA_E2E_*_SUMMARY paths capture-proof.sh already folds into a bundle
// (soak, day-2 access, day-2 offer, byo-iac, acm-cert, keyless-db) — same shape, same scrub,
// same "counts and booleans, never a secret" rule.
const ArgoSummaryEnv = "ALETHIA_E2E_ARGOCD_SUMMARY"

// ArgoConvergenceSummary is the machine-readable result of the ArgoCD convergence assertion,
// written to ArgoSummaryEnv so a proof bundle carries what was MEASURED rather than what was
// claimed. Counts and names only — an Application name is not a secret, and nothing else is
// recorded.
//
// HealthySynced and ObservedTotal are POINTERS on purpose. When the Application list could not
// be read at all there is no honest number to write, and `0` would be indistinguishable from
// "read fine, nothing converged" — which is precisely the ambiguity #2688 was filed about. A
// `null` says "not measured"; a `0` says "measured, and it was zero".
type ArgoConvergenceSummary struct {
	AssertedAt string `json:"asserted_at"`
	// Assertion names the wait that wrote this. Without it, a bundle carrying the wrong summary
	// gives a reader no way to tell WHICH of the two convergence waits produced it — which is the
	// question azure/addons run 33277183092 could not answer from its artifact.
	Assertion string `json:"assertion"`
	// Outcome is one of: converged · unconverged · unreadable · vacuous.
	Outcome string `json:"outcome"`
	// ExpectedTotal is the size of the derived expected set — the field #2671 needs in order to
	// tell a full-scope add-on sweep from a floor run wearing its name.
	ExpectedTotal  int      `json:"expected_total"`
	HealthySynced  *int     `json:"healthy_synced"`
	ObservedTotal  *int     `json:"observed_total"`
	Losers         []string `json:"losers"`
	TimeoutSeconds int      `json:"timeout_seconds"`
	Verdict        string   `json:"verdict"`
}

// newArgoConvergenceSummary renders the assertion's own state into the summary. It derives the
// converged count as `len(expected) - len(losers)` rather than re-walking the observed map,
// so the number can never disagree with the verdict the assertion actually returned — the
// count and the pass/fail decision are computed from one source, not two that can drift.
func newArgoConvergenceSummary(expected []string, observed map[string]argoAppState, losers []string, timeout time.Duration, err error) ArgoConvergenceSummary {
	s := ArgoConvergenceSummary{
		AssertedAt:     time.Now().UTC().Format(time.RFC3339),
		ExpectedTotal:  len(expected),
		Losers:         append([]string(nil), losers...),
		TimeoutSeconds: int(timeout.Seconds()),
	}
	sort.Strings(s.Losers)
	switch {
	case len(expected) == 0:
		s.Outcome = "vacuous"
		s.Verdict = "refused: the expected Application set was empty, so this run asserted nothing"
		return s
	case observed == nil:
		// No successful read in the whole poll window. Leave both counts null.
		s.Outcome = "unreadable"
		s.Verdict = fmt.Sprintf("no ArgoCD Application list could be read within %s; %d expected", timeout, len(expected))
		return s
	}
	hs := len(expected) - len(losers)
	ot := len(observed)
	s.HealthySynced, s.ObservedTotal = &hs, &ot
	if err == nil {
		s.Outcome = "converged"
		s.Verdict = fmt.Sprintf("%d of %d expected Applications Healthy+Synced", hs, len(expected))
		return s
	}
	s.Outcome = "unconverged"
	s.Verdict = fmt.Sprintf("%d of %d expected Applications Healthy+Synced within %s; %d did not converge: %s",
		hs, len(expected), timeout, len(s.Losers), strings.Join(s.Losers, ", "))
	return s
}

// measuredSummaryExists reports whether the summary file already holds a real measurement.
//
// "Measured" means an outcome other than `vacuous` — converged, unconverged and unreadable all say
// something about a set that was actually asserted over. An unreadable or absent file is NOT
// measured, so the first writer always wins the empty slot.
func measuredSummaryExists(path string) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var prev ArgoConvergenceSummary
	if err := json.Unmarshal(raw, &prev); err != nil {
		return false
	}
	return prev.Outcome != "" && prev.Outcome != "vacuous"
}

// writeArgoSummary persists the summary as indented JSON, mirroring writeAccessSummary.
func writeArgoSummary(path string, s ArgoConvergenceSummary) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

// Budget shape for ArgoAssertTimeout. The flat 8m these replace was set for the LEAN surface and
// then inherited, unchanged, by the full 18-chart one — which is what killed the first real hetzner
// run of the 18-add-on set (#2062) with velero still `Missing`. The surface is knowable at runtime,
// so derive from it rather than picking a bigger constant and hoping.
//
// THE RATE AND THE CEILING ARE MEASURED, not estimated (#2717). The first derivation was itself a
// guess — 6m + 45s/chart, clamped at 20m — and it produced 19m30s for the 18-chart surface. Run
// 33107415369 (hetzner/addons) was dispatched with ALETHIA_E2E_ARGO_TIMEOUT=35m purely to tell
// "slow" from "never converges", and it answered: kube-prometheus-stack, loki and vault were all
// `Progressing` at 19m30s and all THREE had cleared by 35m. So 19m30s was not a budget, it was a
// verdict — every `addons` and `full` run failed on the clock before it could reach a real defect.
// The constants below are set so the 18-chart surface derives 35m, the number that actually
// converged, rather than a number that was never observed to.
const (
	// argoBudgetBase covers ArgoCD itself: repo-server clone, the first reconcile loop, and the
	// app-of-apps landing before any add-on chart is pulled. Raised 6m → 8m so it EQUALS the floor:
	// the lean tier now derives its historical 8m from the base itself rather than from a clamp, so
	// the value a lean run gets no longer depends on which of the two happens to be larger.
	argoBudgetBase = 8 * time.Minute
	// argoBudgetPerAddOn is per chart in the surface. ArgoCD syncs applications in PARALLEL, so this
	// is not a serial install cost — it is the marginal pull + CRD-establish + rollout contention one
	// more chart adds on a small node pool. The old 6m+45s pair was a guess, and across 18 charts it
	// under-bought by 15m30s; 90s is the rate that lands the measured surface on its measured
	// convergence:
	//
	//	8m + 18 × 90s = 8m + 27m = 35m   ← run 33107415369
	argoBudgetPerAddOn = 90 * time.Second
	// argoBudgetFloor never lets a derived value come out SHORTER than the constant it replaced,
	// so no existing scenario gets tighter as a side effect of this change.
	argoBudgetFloor = 8 * time.Minute
	// argoBudgetCeiling is the clamp on catalog growth, and it is deliberately NO LONGER tied to any
	// provider's waitTimeout. That justification was wrong in two independent ways: it quoted 25m
	// when hetzner's row has said 40m since #3027's deadline change, and — the part that matters —
	// waitTimeout never bounded this wait at all. It bounds cp.WaitTerminal, a DIFFERENT and EARLIER
	// poll; both are separate summed terms of the one ctx ResolveT2Budget builds (t2_budget.go), so
	// no waitTimeout can ever cancel an Argo wait.
	//
	// What actually contains this wait is that ctx, and above it the step and job `timeout-minutes`
	// in .github/workflows/e2e-nightly.yml — the two rungs GitHub evaluates before the step body
	// runs, which is why cmd/t2budget verifies them at the top of the step. So the ceiling is set to
	// what those caps hold, and TestArgoBudgetCeilingFitsTheWorkflowCaps reads the caps out of the
	// workflow and proves it offline, on every PR, instead of on a paid run.
	//
	// 40m = the measured 35m plus a 5m margin, which at 90s/chart leaves the derivation unclamped
	// through 21 charts. At 22 it clamps, and a human raises this constant and the two caps in one
	// change — which is the whole job of a clamp: make catalog growth a decision somebody takes,
	// rather than a ladder that silently walks past a cap nobody re-derived.
	argoBudgetCeiling = 40 * time.Minute
)

// ArgoAssertTimeout is the bound for AssertArgoAppsHealthy: ALETHIA_E2E_ARGO_TIMEOUT when set,
// else a budget DERIVED from the add-on surface this run actually seeds. The poll returns the
// moment everything is green, so a larger budget only costs time on a genuinely broken cluster —
// but a budget smaller than the surface needs costs a real run its verdict, which is worse.
//
// Fail-soft on the fixture, deliberately: if the catalog cannot be read, fall back to the full
// surface's budget rather than the lean one. Guessing SMALL here would reintroduce the exact
// failure this derivation exists to remove.
func ArgoAssertTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_E2E_ARGO_TIMEOUT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return argoBudgetFor(argoAddOnCount())
}

// argoAddOnCount is how many add-on charts this run expects ArgoCD to converge.
func argoAddOnCount() int {
	if !AllAddOnsEnabled() {
		// NOT ZERO. The old answer was "the base + floor already cover it", and argoBudgetBase says
		// in its own docstring what it covers: "ArgoCD itself: repo-server clone, the first
		// reconcile loop, and the app-of-apps landing BEFORE ANY ADD-ON CHART IS PULLED". A lean run
		// pulls several, so the floor was buying the base's worth of time for the base's work PLUS
		// real upstream charts, and calling the difference nothing.
		//
		// THE THREE, each DERIVED from the list that decides it rather than counted by hand:
		//   · alwaysRenderedArgoApps — external-secrets-operator, ungated on every cloud and every
		//     dimension. A real chart with three CRDs and a cert-bootstrap.
		//   · leanSeedAddOnIDs — reloader, which seedAddOns() puts in EVERY tier's config snapshot,
		//     so DeriveExpectedArgoApps picks it up and AssertArgoAppsHealthy waits for it.
		//   · metrics-server, which renders on the metricsServerProviders clouds (aws, hetzner).
		//
		// The last is counted UNCONDITIONALLY even though gcp/azure/alibaba do not render it, because
		// this function has no provider and over-buying is the safe direction: the poll returns the
		// moment everything is green, so a budget larger than the surface needs costs time only on an
		// already-broken cluster, while one smaller costs a real run its verdict. That asymmetry is
		// ArgoAssertTimeout's own stated reasoning, applied here rather than restated.
		//
		// WHAT 3 BUYS, and why it is checked against BOTH quantities #3580 turned on. 8m + 3×90s =
		// 12m30s. On the failing gcp floor leg of run 33487970328 the window opened at 09:06:05Z, so
		// the deadline moves 09:14:05Z → 09:18:35Z. ArgoCD refreshes health only on a compare that
		// SUCCEEDS, and its cadence is a 120-180s band, so the worst-case next reconcile starts at
		// 09:15:07Z; add the 34s manifest render measured on that node and the refresh lands ~09:15:41Z
		// — inside the new deadline with ~3m to spare, where the old 8m missed it by 96s and even
		// 8m+90s would have missed the worst case by 6s. The per-chart rate has to cover a full
		// reconcile band plus a compare, not just the chart pulls, and at three charts it does.
		return len(alwaysRenderedArgoApps) + len(leanSeedAddOnIDs) + 1
	}
	addons, err := AllCatalogAddOns()
	if err != nil {
		return expectedCatalogSize
	}
	// DELIBERATELY the catalog alone, and NOT `+ len(alwaysRenderedArgoApps) + 1` as the lean branch
	// above. A full run converges those platform apps too, so this under-counts by the same three —
	// but 8m + 18×90s = 35m is a MEASURED convergence (run 33107415369, dispatched with
	// ALETHIA_E2E_ARGO_TIMEOUT=35m purely to tell "slow" from "never converges"), and
	// TestArgoBudgetFullSurfaceIsTheMeasuredConvergence pins it. Correcting the arithmetic here
	// would replace a number that was observed with one that was inferred, on the dimension where
	// the observation cost a paid run. The 40m ceiling absorbs the difference; if a future measured
	// run says 35m is short, THAT is what moves this.
	return len(addons)
}

// argoBudgetFor turns an add-on count into a wait budget, clamped at both ends.
func argoBudgetFor(addOns int) time.Duration {
	d := argoBudgetBase + time.Duration(addOns)*argoBudgetPerAddOn
	if d < argoBudgetFloor {
		d = argoBudgetFloor
	}
	if d > argoBudgetCeiling {
		d = argoBudgetCeiling
	}
	return d
}

// parseArgoApps parses `kubectl get applications.argoproj.io -o json` output into a
// name → state map, mirroring packages/core/argocd/health.go's trimmed shape (an empty
// health/sync string normalises to "Unknown") and additionally keeping the status
// conditions for the failure dump.
func parseArgoApps(raw []byte) (map[string]argoAppState, error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Status struct {
				Health struct {
					Status string `json:"status"`
				} `json:"health"`
				Sync struct {
					Status string `json:"status"`
				} `json:"sync"`
				Conditions []struct {
					Type    string `json:"type"`
					Message string `json:"message"`
				} `json:"conditions"`
				Resources []struct {
					Group     string `json:"group"`
					Kind      string `json:"kind"`
					Name      string `json:"name"`
					Namespace string `json:"namespace"`
					Status    string `json:"status"`
					Health    struct {
						Status  string `json:"status"`
						Message string `json:"message"`
					} `json:"health"`
				} `json:"resources"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, err
	}
	out := make(map[string]argoAppState, len(list.Items))
	for _, item := range list.Items {
		st := argoAppState{
			Health: orUnknown(item.Status.Health.Status),
			Sync:   orUnknown(item.Status.Sync.Status),
		}
		for _, c := range item.Status.Conditions {
			st.Conditions = append(st.Conditions, c.Type+": "+c.Message)
		}
		// Only the OutOfSync ones. A Synced resource in a Synced app is noise, and in an
		// OutOfSync app it is the part that is fine.
		seenRes := map[string]struct{}{}
		seenUnhealthy := map[string]struct{}{}
		for _, r := range item.Status.Resources {
			label := r.Kind + "/" + r.Name
			if r.Group != "" {
				label = r.Group + "/" + r.Kind + "/" + r.Name
			}
			// A resource with no health at all is NOT a healthy resource — ArgoCD leaves the field
			// empty for kinds it has no health check for (ConfigMap, Secret, Service…), and
			// treating that as unhealthy would bury the one that matters. Only a health it
			// EXPLICITLY reported as something other than Healthy is named.
			if h := r.Health.Status; h != "" && h != "Healthy" {
				if _, dup := seenUnhealthy[label]; !dup {
					seenUnhealthy[label] = struct{}{}
					entry := label + " " + h
					if msg := strings.TrimSpace(r.Health.Message); msg != "" {
						entry += ": " + msg
					}
					st.NotHealthyResources = append(st.NotHealthyResources, entry)
				}
			}
			if r.Status != "OutOfSync" {
				continue
			}
			if _, dup := seenRes[label]; dup {
				continue
			}
			seenRes[label] = struct{}{}
			st.OutOfSyncResources = append(st.OutOfSyncResources, label)
			st.OutOfSyncRefs = append(st.OutOfSyncRefs, outOfSyncRef{
				Group: r.Group, Kind: r.Kind, Name: r.Name, Namespace: r.Namespace,
			})
		}
		sort.Strings(st.OutOfSyncResources)
		sort.Strings(st.NotHealthyResources)
		out[item.Metadata.Name] = st
	}
	return out, nil
}

// evaluateArgoApps is the PURE decision over one observation: nil error iff every
// expected Application is present with health "Healthy" AND sync "Synced" (exact
// match — "Progressing", "Degraded", "OutOfSync", "Unknown" and a missing app all
// fail). Returns the failing names plus an error that reports each expected app's
// state and the full observed Application list, so the poll wrapper needs no cluster
// to be unit-tested.
func evaluateArgoApps(observed map[string]argoAppState, expected []string) (losers []string, err error) {
	if len(expected) == 0 {
		return nil, errors.New("refusing a VACUOUS ArgoCD health assertion: the expected Application set is empty")
	}
	var report strings.Builder
	for _, name := range expected {
		st, ok := observed[name]
		if !ok {
			losers = append(losers, name)
			fmt.Fprintf(&report, "  - %s: MISSING (no such Application in the argocd namespace)\n", name)
			continue
		}
		if st.Health == "Healthy" && st.Sync == "Synced" {
			continue
		}
		losers = append(losers, name)
		fmt.Fprintf(&report, "  - %s: health=%s sync=%s", name, st.Health, st.Sync)
		if len(st.Conditions) > 0 {
			fmt.Fprintf(&report, " [%s]", strings.Join(st.Conditions, "; "))
		}
		// Name WHAT differs, not just that something does. For a Healthy-but-OutOfSync app this
		// is the whole diagnosis: the workload is up, so the resource named here is a
		// spurious-diff candidate for the template's ignoreDifferences.
		if len(st.OutOfSyncResources) > 0 {
			fmt.Fprintf(&report, "\n      OutOfSync: %s", strings.Join(st.OutOfSyncResources, ", "))
		} else if st.Sync == "OutOfSync" {
			// EMPTY IS NOT "nothing differs". ArgoCD can report an app OutOfSync with an empty
			// or not-yet-populated resource list, and silence there would read as a clean diff.
			report.WriteString("\n      OutOfSync: (no per-resource detail reported by ArgoCD)")
		}
		// The aggregate health names no resource, so `health=Progressing` was unattributable — see
		// NotHealthyResources. This is what says whether an OutOfSync add-on is ALSO unfinished for
		// its own reasons, or is Progressing because of the very resource that is OutOfSync.
		if len(st.NotHealthyResources) > 0 {
			fmt.Fprintf(&report, "\n      not Healthy: %s", strings.Join(st.NotHealthyResources, "; "))
		} else if st.Health != "Healthy" {
			report.WriteString("\n      not Healthy: (ArgoCD reports no unhealthy RESOURCE — the aggregate health is not attributable to one)")
		}
		report.WriteString("\n")
	}
	if len(losers) == 0 {
		return nil, nil
	}
	// The full listing carries the resource detail too, and that is not cosmetic. It is the ONLY
	// place a WITHHELD Application's OutOfSync resources appear: withheld add-ons are excluded from
	// the loop above, so on run 33162842830 addon-vault reported `Progressing/OutOfSync` with no
	// resource named — and vault's StatefulSet is the control case that separates the two candidate
	// causes of #2717's surviving four (see the loki-vs-tempo note in packages/core/argocd/addons.go).
	// Printing it costs nothing: the data is already parsed.
	fmt.Fprintf(&report, "all Applications observed in the argocd namespace:\n")
	for _, name := range sortedAppNames(observed) {
		st := observed[name]
		fmt.Fprintf(&report, "  - %s: health=%s sync=%s\n", name, st.Health, st.Sync)
		if len(st.OutOfSyncResources) > 0 {
			fmt.Fprintf(&report, "      OutOfSync: %s\n", strings.Join(st.OutOfSyncResources, ", "))
		}
		if len(st.NotHealthyResources) > 0 {
			fmt.Fprintf(&report, "      not Healthy: %s\n", strings.Join(st.NotHealthyResources, "; "))
		}
	}
	return losers, fmt.Errorf("%d/%d expected ArgoCD Applications are not Healthy+Synced:\n%s",
		len(losers), len(expected), strings.TrimRight(report.String(), "\n"))
}

// sortedAppNames returns the observed Application names sorted, for stable reports.
func sortedAppNames(observed map[string]argoAppState) []string {
	names := make([]string, 0, len(observed))
	for n := range observed {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// orUnknown normalises an empty status string to "Unknown" (mirrors
// packages/core/argocd/health.go).
func orUnknown(s string) string {
	if s == "" {
		return "Unknown"
	}
	return s
}

// kubectlGetArgoApps lists the Applications in the argocd namespace as JSON via an
// explicit kubeconfig (each tier's INDEPENDENT path to the cluster — never the
// runner's side-effect env). Bounded by its own short timeout under ctx.
func kubectlGetArgoApps(ctx context.Context, kubeconfigPath string) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"get", "applications.argoproj.io", "-n", "argocd", "-o", "json")
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return nil, fmt.Errorf("%w: %s", err, strings.TrimSpace(string(ee.Stderr)))
		}
		return nil, err
	}
	return out, nil
}

// describeHeadBudget is how much of the TOP of a describe survives truncation: enough for the
// identity block (Name, Namespace, Labels, Annotations) and no more.
const describeHeadBudget = 600

// truncateDescribe keeps BOTH ENDS of `kubectl describe`, dropping the middle.
//
// This used to keep the first 2500 characters, on the stated reasoning that "the useful part is at
// the top". It is not. `kubectl describe application` prints Name, Labels, Annotations, Metadata,
// Spec, Status, Events — in that order — and the Spec of a Helm Application is the entire values
// block. So the budget was spent on values we already chose, and Status, Conditions and Events —
// the only part that says what went wrong — were exactly what got cut.
//
// azure/addons run 33255369578 shows the cut landing mid-word inside the spec (`Rev…(truncated)`),
// with not one line of status for the one Application that failed.
//
// The head is kept because the identity block is genuinely useful and cheap: it names the project,
// the sync-wave and the add-on labels in about four hundred characters. Everything after that up to
// the tail budget is dropped, and the marker says how much — a truncation that does not admit its
// size reads as a complete document.
func truncateDescribe(s string, head, total int) string {
	if len(s) <= total {
		return s
	}
	if head < 0 {
		head = 0
	}
	if head >= total {
		// A head budget that leaves no tail would reproduce the bug this function replaced. Refuse
		// it here rather than silently honour it: keep the tail, which is the half that was missing.
		head = 0
	}
	tail := total - head
	var b strings.Builder
	if head > 0 {
		b.WriteString(s[:head])
	}
	fmt.Fprintf(&b, "\n…(%d characters of the spec dropped; the tail below is the status and events)…\n", len(s)-total)
	b.WriteString(s[len(s)-tail:])
	return b.String()
}

// describeArgoApps returns `kubectl describe` output for each losing Application
// (best-effort, truncated per app, capped at 5 apps) formatted for appending to the
// timeout error — the "full dump" that makes a red nightly diagnosable from logs.
func describeArgoApps(ctx context.Context, kubeconfigPath string, observed map[string]argoAppState, losers []string) string {
	// SIZED TO THE WORST OBSERVED FAILURE, not to a comfortable number.
	//
	// hetzner/addons run 32959867406 had EIGHT losers against a cap of five, so minio and velero were
	// never described at all — and minio turned out to be the one whose cause (#2822) mattered most.
	// A dump that silently stops before the interesting failure has the same effect as no dump, at
	// the same price: the run still costs EUR 0.75 and forty minutes.
	//
	// 18 marketplace add-ons plus the platform rail is the realistic ceiling on how many can fail at
	// once, so cover all of them. The per-app budget shrinks to compensate — `describe` is mostly the
	// spec, which the Application already rendered above.
	const maxApps = 20
	const maxPerApp = 2500
	var b strings.Builder
	for i, name := range losers {
		if i == maxApps {
			fmt.Fprintf(&b, "\n… %d more failing Applications not described", len(losers)-maxApps)
			break
		}
		fmt.Fprintf(&b, "\n──── kubectl describe application %s ────\n", name)
		cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
			"describe", "applications.argoproj.io", "-n", "argocd", name)
		out, err := cmd.CombinedOutput()
		cancel()
		if err != nil {
			fmt.Fprintf(&b, "(describe failed: %v)\n%s", err, out)
			continue
		}
		b.WriteString(truncateDescribe(string(out), describeHeadBudget, maxPerApp))
		// `describe application` shows the DESIRED spec and the sync status. It says nothing about
		// the workload, so a Degraded app — which ArgoCD derives from the underlying Deployment —
		// reports a verdict with no cause attached. See dumpUnhealthyPods.
		b.WriteString(dumpUnhealthyPods(ctx, kubeconfigPath, name, observed[name].Health))
	}
	return b.String()
}

// dumpUnhealthyPods reports the pods behind an Application that are not Running, with their recent
// events and container logs.
//
// WHY. ArgoCD's `Degraded` comes from the workload, and `kubectl describe application` shows only
// the desired spec and the sync status — no restart count, no container status, no events. gcp
// `maxconfig` run 32951789725 spent 52 minutes and ~EUR 1.50 to end at
// `external-dns: health=Degraded sync=Synced`, with the rendered Application visibly CORRECT
// (`provider: google`, the right workload-identity annotation) and nothing in the dump able to say
// what the pod was actually doing. A verdict nobody can act on costs the next run too.
//
// This is the `Degraded` counterpart to dumpOutOfSyncResources, and the same shape
// applyStoreAwaitingOperator already uses on its deadline branch — for the same stated reason: a
// slow install and a crash-looping pod are indistinguishable from the outer error alone.
//
// The events are usually the whole answer. `CreateContainerConfigError`, `CrashLoopBackOff` and an
// image-pull failure all look identical at the Application level and need three different fixes.
//
// Best-effort and hard-capped: this runs on an ALREADY-FAILING path and must never be why a run
// hangs or an error is lost. A pod dump that fails says so — "could not read it" and "nothing was
// wrong" must not look the same.
func dumpUnhealthyPods(ctx context.Context, kubeconfigPath, app, health string) string {
	const (
		// Three was enough for a Deployment; a DaemonSet on a multi-node cluster can have every pod
		// unhappy for one reason, and seeing only three of them hides whether it is one node or all.
		maxPods = 6
		// A chart with several workloads (harbor has seven) must not bury the failing one, but a
		// full describe each is long — this is the already-failing path, not a report.
		maxWorkloadsDescribed = 4
		maxLogLines           = "40"
		// A CRASH-LOOPING container gets a much longer tail, because 40 lines is measured to be
		// too few for exactly the case that matters most. falco on Talos dies at
		// `Error: Initialization issues during scap_init`, and scap_init's specific sub-errors —
		// the half that says WHICH probe requirement the kernel refused — scrolled off the top of
		// the 40-line window (#2866). The run cost a cloud apply and still could not distinguish
		// "Talos forbids BPF from containers" from "the chart is missing a mount".
		//
		// It is not the default because the reason 40 exists is still right: a chart with seven
		// workloads must not bury the failing one. A crash-looping pod IS the failing one.
		maxCrashLogLines = "400"
	)
	// ArgoCD's tracking label, tried FIRST because it needs no extra API calls.
	//
	// It is not reliable on its own, and the comment that used to sit here said it was: "ArgoCD
	// labels every resource it manages with the Application's name". ArgoCD labels the WORKLOAD.
	// Pods come from the workload's own template, so they carry this label only when the chart
	// happens to put it there. falco's chart does; minio's uses `app`/`release`, so run
	// 32970696343 reported "NONE match" for a Deployment that was running the whole time.
	selector := "app.kubernetes.io/instance=" + app
	run := func(timeout time.Duration, args ...string) (string, error) {
		cctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		full := append([]string{"--kubeconfig", kubeconfigPath}, args...)
		out, err := exec.CommandContext(cctx, "kubectl", full...).CombinedOutput()
		return string(out), err
	}

	// `-o custom-columns` rather than JSON: this is read by a human in a log, and the whole point is
	// that the restart count and the waiting reason are visible at a glance.
	out, err := run(30*time.Second, "get", "pods", "-A", "-l", selector, "--no-headers",
		"-o", "custom-columns=NS:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase,"+
			"READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount,"+
			"REASON:.status.containerStatuses[*].state.waiting.reason")
	if err != nil {
		return fmt.Sprintf("\n──── pods for %s: could not list (%v) ────\n", app, err)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")

	// Nothing under the tracking label. Before concluding anything about the cluster, ask each
	// workload for the selector IT owns its pods by — definitionally correct for whatever the
	// chart chose, so it cannot go stale the way a hard-coded label does.
	workloads, wlErr := managedWorkloads(ctx, kubeconfigPath, app)
	if len(lines) == 1 && lines[0] == "" && wlErr == nil {
		for _, w := range workloads {
			derived, derr := podSelectorFor(ctx, kubeconfigPath, w)
			if derr != nil {
				continue
			}
			alt, aerr := run(30*time.Second, "get", "pods", "-n", w.Namespace, "-l", derived, "--no-headers",
				"-o", "custom-columns=NS:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase,"+
					"READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount,"+
					"REASON:.status.containerStatuses[*].state.waiting.reason")
			if aerr != nil {
				continue
			}
			altLines := strings.Split(strings.TrimSpace(alt), "\n")
			if len(altLines) == 1 && altLines[0] == "" {
				continue
			}
			// Say which selector worked. The next reader needs to know the tracking label was the
			// wrong question, not that the first attempt was noise.
			lines = altLines
			selector = derived + " (from " + w.String() + "; the ArgoCD tracking label matched nothing)"
			break
		}
	}

	if len(lines) == 1 && lines[0] == "" {
		// NO PODS. That is a DIFFERENT fact from "they are all fine" — but on its own it is ALSO
		// ambiguous, and the first run to hit it proved so.
		//
		// hetzner/addons 32959867406 reported `addon-falco: NONE match … — the workload was never
		// created`, and that read as a finding. It is not one: it conflates
		//
		//     the Application manages a workload that has produced no pods   (a real fault)
		//     the Application manages no workload at all                     (a different fault)
		//     the pods exist under a label this selector does not match      (NOT a fault — a bug HERE)
		//
		// The third would have this dump confidently blame a chart for something the harness got
		// wrong. So ask ArgoCD what it thinks it manages: the Application's own `.status.resources`
		// is the authority, and it distinguishes all three.
		// #2829: and even after all three are distinguished, "the workload exists and produced no
		// pods" still arrives with no cause. Nothing ever asked the WORKLOAD. Its status and events
		// are the only remaining place the answer can be, so dump them.
		var b strings.Builder
		fmt.Fprintf(&b, "\n──── pods for %s: NONE match %s, nor any workload's OWN selector ────%s\n",
			app, selector, describeManagedWorkloads(ctx, kubeconfigPath, app))
		for i, w := range workloads {
			if i >= maxWorkloadsDescribed {
				fmt.Fprintf(&b, "\n  … %d more workload(s) not described\n", len(workloads)-i)
				break
			}
			b.WriteString(describeWorkload(ctx, kubeconfigPath, w))
		}
		return b.String()
	}

	var b strings.Builder
	fmt.Fprintf(&b, "\n──── pods for %s (%s) ────\n%s\n", app, selector, strings.Join(lines, "\n"))

	shown := 0
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		ns, pod, phase := fields[0], fields[1], fields[2]
		// Only the pods that are actually unhappy. A Running pod's logs are not why the Application
		// is Degraded, and dumping them would bury the one that is.
		if phase == "Running" && !strings.Contains(line, "false") {
			continue
		}
		if shown >= maxPods {
			fmt.Fprintf(&b, "… more unhealthy pods not dumped\n")
			break
		}
		shown++
		if ev, err := run(30*time.Second, "describe", "pod", "-n", ns, pod); err == nil {
			// Only the Events block: a full describe is mostly the spec, which the Application
			// already showed.
			if i := strings.Index(ev, "Events:"); i >= 0 {
				fmt.Fprintf(&b, "\n  events for %s/%s:\n%s\n", ns, pod, ev[i:])
			}
		}
		// A restarting pod's CURRENT container may not have reached its failure yet — or may have
		// produced nothing at all — so its live log can be empty while the crashed instance's log
		// holds the entire diagnosis. `--previous` is the only way to read that one, and asking for
		// it on a pod that has never restarted is an error, which is why it is gated on the restart
		// count rather than attempted unconditionally.
		tail := maxLogLines
		if crashLooping(fields) {
			tail = maxCrashLogLines
			if prev, err := run(30*time.Second, "logs", "-n", ns, pod, "--all-containers",
				"--previous", "--tail", tail); err == nil && strings.TrimSpace(prev) != "" {
				fmt.Fprintf(&b, "\n  last %s log lines for %s/%s (PREVIOUS, crashed instance):\n%s\n",
					tail, ns, pod, prev)
			}
		}
		if logs, err := run(30*time.Second, "logs", "-n", ns, pod, "--all-containers", "--tail", tail); err == nil && strings.TrimSpace(logs) != "" {
			fmt.Fprintf(&b, "\n  last %s log lines for %s/%s:\n%s\n", tail, ns, pod, logs)
		}
	}
	if shown == 0 {
		// Every pod is Running and ready, yet ArgoCD does not call the Application Healthy. That is
		// a real and quite different finding — the health is coming from something other than pod
		// readiness — and saying so is more useful than printing nothing.
		//
		// It NAMES the health it was given rather than asserting "Degraded". The hardcoded word was
		// printed verbatim over a `Progressing` Application on the gcp floor leg of run 33487970328
		// (#3580), which reads as a contradiction of the status three lines above it and sent the
		// reader looking for a Degraded app that did not exist. `Progressing` and `Degraded` also
		// mean opposite things here — one is "not finished", the other "finished badly" — so the
		// substitution was not cosmetic.
		fmt.Fprintf(&b, "  every pod is Running and ready — the %s health is NOT pod readiness\n",
			argoHealthOrUnknown(health))
	}
	return b.String()
}

// crashLooping reports whether a pod line from the `custom-columns` listing above describes a
// container that has died at least once.
//
// It reads the RESTARTS and REASON columns, and either one alone is enough. Both are needed
// because they catch different moments of the same failure: `CrashLoopBackOff` is only set while
// the kubelet is WAITING between attempts, so a pod sampled mid-restart shows a restart count and
// no reason at all; and a container killed once but not yet backed off shows the reason before the
// count is meaningful.
//
// RESTARTS is `containerStatuses[*].restartCount`, so for a multi-container pod it arrives as
// `10,0` — any non-zero entry counts. A missing column renders as `<none>`, which parses as zero
// and is correctly not a crash loop.
//
// `fields` is the whitespace-split line; a line too short to carry these columns is not a crash
// loop rather than a panic, because this whole path runs while a run is ALREADY failing and must
// not turn a diagnostic into a second failure.
func crashLooping(fields []string) bool {
	if len(fields) > 5 && strings.Contains(fields[5], "CrashLoopBackOff") {
		return true
	}
	if len(fields) > 4 {
		for _, n := range strings.Split(fields[4], ",") {
			if v, err := strconv.Atoi(strings.TrimSpace(n)); err == nil && v > 0 {
				return true
			}
		}
	}
	return false
}

// outOfSyncRef identifies one OutOfSync resource well enough to fetch it from the cluster.
type outOfSyncRef struct {
	Group     string
	Kind      string
	Name      string
	Namespace string
}

// kubectlTarget renders the ref as a `kubectl get` argument. The group is included when present so
// a CustomResourceDefinition is not confused with some other Kind of the same name.
func (r outOfSyncRef) kubectlTarget() string {
	if r.Group == "" {
		return strings.ToLower(r.Kind) + "/" + r.Name
	}
	return strings.ToLower(r.Kind) + "." + r.Group + "/" + r.Name
}

// dumpOutOfSyncResources fetches each OutOfSync resource and names the FIELDS the chart did not
// author, by reading server-side-apply FIELD OWNERSHIP rather than dumping the object.
//
// WHY OWNERSHIP AND NOT THE OBJECT. The previous version printed the live object, on the reasoning
// that an API-server-defaulted field would be visible in it. It is — but only to a reader who
// already knows which field to look for, and the objects are large: hetzner/addons run 32949217522
// dumped five CustomResourceDefinitions, each truncated at 3000 bytes inside its `spec.versions`
// openAPIV3Schema, and named no field on any of them. It cost a real run and answered nothing.
//
// Every Application here syncs with ServerSideApply=true, and that is what makes ownership readable:
// the apiserver records, per field, WHICH MANAGER set it. A field ArgoCD applied is owned by the
// ArgoCD controller. A field ArgoCD did NOT apply — a defaulted value, or one a controller wrote
// back — is owned by somebody else, and those are exactly the candidates for an ignoreDifferences
// entry. So the question "which field did the chart not author?" has a direct answer in
// `.metadata.managedFields`, and it needs only kubectl: no ArgoCD API, no session token, no
// port-forward, none of which the harness has.
//
// It NARROWS the candidates; it does not prove the diff. A field ArgoCD does not own is not
// automatically the one ArgoCD is complaining about. That is why the output is labelled as
// candidates, and why an ignore is still a deliberate decision — an ignore guessed onto a kind can
// hide genuine drift, which is the one thing this class must not do.
//
// Best-effort and hard-capped: this runs on an ALREADY-FAILING path, so it must never be the reason
// a run hangs or an error is lost.
// argoDumpBudget is the CEILING on the whole failing-path dump — never a reservation.
//
// It is not a term in ResolveT2Budget and it is not carved out of t2BaseHeadroom, because
// t2BaseHeadroom is not slack: its own definition is "runner build + snapshot seeding + the slack
// the old comment called headroom", and t2BuildRunner alone carries a five-minute ceiling that is
// spent after ctx is created. Treating seven minutes as seven minutes of spare time is how a
// fixed budget comes to be justified by an allowance that was never free.
//
// So the dump takes whatever is ACTUALLY left, capped here. planArgoDump decides, the notice says
// which of the two bound it, and nothing downstream has to believe an arithmetic claim about
// headroom that the ladder does not make.
const argoDumpBudget = 4 * time.Minute

// argoDumpMinimum is the least remaining time the dump is worth starting with. Below it, every
// section would report its own timeout and the reader would get eight lines of context-deadline
// noise instead of one line saying the leg had already run out.
const argoDumpMinimum = 5 * time.Second

// argoDumpSectionFloor keeps a starved section from being handed a share too small to say anything.
// A section given 200ms produces a timeout message, which is worse than being named as not run.
const argoDumpSectionFloor = 3 * time.Second

// dumpPlan is how long the dump may take and WHAT BOUND IT — two different findings that the same
// expired context produces.
//
// "The dump budget was spent" means the dump is too slow for what it was asked, and the lever is
// argoDumpBudget. "The T2 context ran out" means the leg is out of time, this budget never applied,
// and the lever is the ladder. Printing the first when the second happened sends a maintainer to
// tune a number that had nothing to do with it.
type dumpPlan struct {
	Budget     time.Duration
	BoundByCtx bool
	Startable  bool
}

// planArgoDump is pure so both branches are pinned by a test rather than by a run that costs money.
func planArgoDump(remaining time.Duration, hasDeadline bool) dumpPlan {
	if !hasDeadline {
		// No deadline on the parent at all — the ceiling is the only bound there is.
		return dumpPlan{Budget: argoDumpBudget, Startable: true}
	}
	switch {
	case remaining <= argoDumpMinimum:
		return dumpPlan{Budget: 0, BoundByCtx: true, Startable: false}
	case remaining < argoDumpBudget:
		return dumpPlan{Budget: remaining, BoundByCtx: true, Startable: true}
	default:
		return dumpPlan{Budget: argoDumpBudget, Startable: true}
	}
}

// dumpSection is one diagnostic and the name it is reported under when it does not get to run.
type dumpSection struct {
	name string
	run  func(context.Context) string
}

// sectionNames lists a run of sections for the skipped notice.
func sectionNames(secs []dumpSection) []string {
	names := make([]string, 0, len(secs))
	for _, s := range secs {
		names = append(names, s.name)
	}
	return names
}

// renderDumpStopped names the sections that did not run, and says which clock ran out.
//
// NAMED, never silently dropped: this file's stated principle is that a dump which stops before the
// interesting failure has the same effect as no dump, at the same price. A reader who can see that
// "argocd app diff" was not reached knows to look for it; a reader shown nothing concludes there
// was nothing to show.
func renderDumpStopped(skipped []dumpSection, plan dumpPlan) string {
	if len(skipped) == 0 {
		return ""
	}
	names := strings.Join(sectionNames(skipped), ", ")
	if plan.BoundByCtx {
		return fmt.Sprintf("\n──── the T2 context ran out first (%s left, under the %s dump ceiling); "+
			"%d section(s) NOT run: %s. The LEG is out of time — look at the ladder, not at this "+
			"ceiling. ────\n", plan.Budget, argoDumpBudget, len(skipped), names)
	}
	return fmt.Sprintf("\n──── dump ceiling of %s spent; %d section(s) NOT run: %s ────\n",
		argoDumpBudget, len(skipped), names)
}

// argoDeadlineDump is EVERY diagnostic a timed-out ArgoCD wait should carry, in one place.
//
// It exists because there are two of these waits — AssertArgoAppsHealthy here, and the A0.6
// repo-apps wait in t2_argo_repos.go — each with its own hand-assembled dump. #2834 added the
// desired-vs-live diff to this file's caller and not the other one, so hetzner/maxconfig run
// 32993552300 timed out with five OutOfSync StatefulSets and printed no diff at all: the run went
// through the OTHER wait, which A0.6 enables.
//
// That is the whole argument for a single function. Two call sites assembling the same list by hand
// will drift, and the drift is invisible until a run needs the missing half — by which point it has
// already cost a real apply.
func argoDeadlineDump(
	ctx context.Context,
	kubeconfigPath string,
	observed map[string]argoAppState,
	losers []string,
	refs []outOfSyncRef,
) string {
	// ONE budget for the whole dump, and a SHARE of it for each section.
	//
	// EVERY section carries its own per-call timeout and its own per-app cap, and the caps
	// MULTIPLY: describeArgoApps alone is twenty losers × 30s, and dumpArgoAppDiff's per-app
	// timeout is 300s — longer than the whole ceiling. Every section was sized as though it were
	// the only one, which is how a chain of individually reasonable timeouts overruns.
	//
	// A pooled budget alone would not fix it: the cheap early sections would eat the pool on a
	// many-loser run and `argocd app diff` — the LAST section, the most expensive, and the one
	// #2834 added the shared dump for — would be starved by the very cap meant to protect the run.
	// So each section takes an equal share of what is left at the moment it starts, and a section
	// that finishes early returns its remainder to the ones after it.
	//
	// The count is deliberately NOT written here. It said "Nine" while the slice held eight, and
	// adding one made the sentence accidentally true — a hand-maintained number in a comment beside
	// the list it counts is wrong the first time anybody edits the list. The share arithmetic below
	// derives from `len(sections)`, so nothing depends on a reader keeping the prose in step.
	sections := []dumpSection{
		// FIRST, because it is the only one that speaks for a loser whose resources were never
		// created, and because it is one small `kubectl get` rather than a chart render. See
		// argo_sync_failure.go.
		{"sync failures", func(c context.Context) string { return dumpArgoSyncFailures(c, kubeconfigPath, losers) }},
		// IMMEDIATELY after it, because it answers the question that dump's own output raises: the
		// Application names the hook it is waiting for and stops there. See argo_pending_hook.go.
		{"pending hooks", func(c context.Context) string { return dumpPendingHooks(c, kubeconfigPath, losers) }},
		// An add-on that installs SEALED cannot converge on the chart alone, and nothing on this
		// path was looking at the Job that opens it. One `kubectl get jobs -A`; see
		// bootstrap_job_dump.go for the run that needed it.
		{"bootstrap jobs", func(c context.Context) string { return dumpAddOnBootstrapJobs(c, kubeconfigPath) }},
		// The two sources that speak for a sync still RUNNING — an Application waiting on a hook it
		// never applied has nothing further to say, and both of these do. See argo_stuck_sync.go.
		{"controller log", func(c context.Context) string { return dumpArgoControllerLog(c, kubeconfigPath, losers) }},
		{"cluster warnings", func(c context.Context) string { return dumpDestinationWarnings(c, kubeconfigPath, losers) }},
		{"describe", func(c context.Context) string { return describeArgoApps(c, kubeconfigPath, observed, losers) }},
		{"out-of-sync objects", func(c context.Context) string { return dumpOutOfSyncResources(c, kubeconfigPath, refs) }},
		// BEFORE the diff section, because it speaks for exactly the losers that section is about
		// to decline to speak for, and it is one jsonpath read per app rather than a chart render.
		{"health freshness", func(c context.Context) string { return dumpArgoHealthStaleness(c, kubeconfigPath, observed, losers) }},
		{"argocd app diff", func(c context.Context) string { return dumpArgoAppDiffs(c, kubeconfigPath, observed, losers) }},
	}

	// ALREADY DONE beats any arithmetic about deadlines: a context cancelled by hand carries NO
	// deadline at all, so asking Deadline() first would compute a four-minute ceiling against a
	// context that is finished, run every section, and report eight sections "CUT OFF" instead of
	// one line saying the leg had already ended.
	if ctx.Err() != nil {
		return renderDumpStopped(sections, dumpPlan{BoundByCtx: true})
	}
	deadline, hasDeadline := ctx.Deadline()
	plan := planArgoDump(time.Until(deadline), hasDeadline)
	if !plan.Startable {
		return renderDumpStopped(sections, plan)
	}
	dctx, cancel := context.WithTimeout(ctx, plan.Budget)
	defer cancel()
	dumpDeadline, _ := dctx.Deadline()

	var b strings.Builder
	for i := range sections {
		left := time.Until(dumpDeadline)
		if dctx.Err() != nil || left <= 0 {
			b.WriteString(renderDumpStopped(sections[i:], plan))
			return b.String()
		}
		share := left / time.Duration(len(sections)-i)
		if share < argoDumpSectionFloor {
			share = min(left, argoDumpSectionFloor)
		}
		sctx, scancel := context.WithTimeout(dctx, share)
		b.WriteString(sections[i].run(sctx))
		cut := sctx.Err() != nil
		scancel()
		if cut {
			// SAID, because a section that ran out mid-way otherwise renders as a section that
			// found nothing — which is the reading this whole file exists to prevent, and the guard
			// at the top of the loop cannot see it: exhaustion INSIDE the last section leaves the
			// loop normally and would print nothing at all.
			fmt.Fprintf(&b, "\n  (the %q section was CUT OFF after %s — what it printed is partial)\n",
				sections[i].name, share)
		}
	}
	return b.String()
}

// dumpArgoAppDiffs asks ArgoCD for the desired-vs-live diff of every OUT-OF-SYNC loser.
//
// Scoped to OutOfSync on purpose: a Degraded-but-Synced Application (external-dns crash-looping,
// falco scheduling nothing) has no diff to show, and running the render for it would spend the
// budget without adding a line.
func dumpArgoAppDiffs(ctx context.Context, kubeconfigPath string, observed map[string]argoAppState, losers []string) string {
	// One `--core` diff renders the chart, so this is the most expensive thing on the failing path.
	const maxDiffedApps = 8

	outOfSync := outOfSyncLosers(observed, losers)
	if len(outOfSync) == 0 {
		// Distinguishable from "we did not look": every loser is Degraded or Progressing while
		// Synced, so there is genuinely no diff to fetch.
		return "\n──── argocd app diff: no loser is OutOfSync, so there is no diff to show ────\n"
	}
	var b strings.Builder
	b.WriteString("\n──── ArgoCD's OWN desired-vs-live diff, per OutOfSync Application ────\n")
	for i, name := range outOfSync {
		if i >= maxDiffedApps {
			fmt.Fprintf(&b, "\n  … %d more OutOfSync Application(s) not diffed\n", len(outOfSync)-i)
			break
		}
		b.WriteString(dumpArgoAppDiff(ctx, kubeconfigPath, name, observed[name].OutOfSyncRefs))
	}
	// The one comparison no diagnostic above can make: argo-cd's own verdict on whether live
	// matches desired under Server-Side Diff. Not asked as a diff — #3140 proved the CLI cannot
	// answer that — but run as an OUTCOME on one or two of these same Applications, and reverted.
	// See argo_ssd_experiment.go.
	b.WriteString(argoSSDExperiment(ctx, kubeconfigPath, outOfSync))
	return b.String()
}

// outOfSyncLosers narrows the losing Applications to the ones an ArgoCD diff can say anything
// about. Pure, so the narrowing is testable: diffing the wrong set either wastes the budget or
// silently omits the app whose field is the whole question.
func outOfSyncLosers(observed map[string]argoAppState, losers []string) []string {
	var out []string
	for _, name := range losers {
		if st, ok := observed[name]; ok && st.Sync == "OutOfSync" {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// argoDiffExitCodeMeansDiff is the exit status `argocd app diff` uses to say "there IS a diff" —
// the same convention `diff(1)` uses. It is a VERDICT, not a failure, and treating it as one is how
// a dump ends up reporting nothing on precisely the runs it was written for.
const argoDiffExitCodeMeansDiff = 1

// dumpArgoAppDiff prints ArgoCD's own desired-vs-live diff for an Application.
//
// WHY. Every diagnostic before this one names the OBJECT that is OutOfSync and, since #2778, which
// of its fields ArgoCD does not own. Neither names the FIELD THAT ACTUALLY DIFFERS. After three
// runs, seven Applications across argo-rollouts, kyverno, loki, tempo and harbor still sat
// Healthy+OutOfSync with `every field is ArgoCD-owned — no foreign default to blame`, and the field
// was still unknown. #2778 is explicit that a guessed `ignoreDifferences` entry can MASK REAL DRIFT,
// so guessing is not an option — which makes the missing field a harness gap, not a patience
// problem.
//
// ArgoCD already computes this diff; nothing was asking it for the answer. `argocd app diff --core`
// runs the API-server logic in-process against the in-cluster API, so it needs no ArgoCD login and
// no port-forward — it is executed inside the argocd APPLICATION-CONTROLLER pod, whose
// ServiceAccount has the RBAC and from which the repo-server is reachable for manifest rendering.
//
// Best-effort on an ALREADY-FAILING path. It must never be why a run hangs or an error is lost, and
// — the point of the constant above — "the command reported a difference" must never be mistaken
// for "the command failed".
func dumpArgoAppDiff(ctx context.Context, kubeconfigPath, app string, refs []outOfSyncRef) string {
	// Generous: --core renders the manifests through the repo-server, which pulls the chart, and on
	// the empty-diff branch it ALSO fetches the whole Application's manifests and server-side
	// dry-runs them (argo_predicted_live.go) — a SECOND manifest render. kyverno renders ~50k
	// lines, so this is not a fast path — it is the only path that can name the field, and it runs
	// only on an already-failing run. The budget is shared: a probe that runs out of it says COULD
	// NOT ASK, which is the correct answer and not a silent pass.
	cctx, cancel := context.WithTimeout(ctx, 300*time.Second)
	defer cancel()

	target, err := argoDiffWorkload(cctx, kubeconfigPath)
	if err != nil {
		return fmt.Sprintf("\n  ──── argocd app diff %s ────\n%v\n", app, err)
	}

	cmd := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"-n", "argocd", "exec", target, "--",
		"argocd", "app", "diff", app, "--core")
	out, cerr := cmd.CombinedOutput()
	report := interpretArgoDiff(app, string(out), cerr)
	// Only on the ambiguous verdict, and only there: an empty diff against an OutOfSync status is
	// the one outcome that cannot be acted on without knowing whether the status is stale.
	if strings.Contains(report, "reports NO difference") {
		report += argoSyncStaleness(app, readArgoReconciledAt(ctx, kubeconfigPath, app), time.Now()) + "\n"
		report += argoHardRefreshVerdict(cctx, kubeconfigPath, target, app) + "\n"
		// #3093's hard refresh answered "the OutOfSync is real, not a stale cache" and could not go
		// further. These two do: the first says WHICH comparison the controller ran (an empty
		// `argocd app diff` on a ServerSideApply Application is a different algorithm, not a
		// contradiction), the second reproduces a server-side comparison and names the fields.
		report += readArgoDiffStrategy(cctx, kubeconfigPath, target, app) + "\n"
		report += argoPredictedLiveDiff(cctx, kubeconfigPath, target, app, refs) + "\n"
	}
	return report
}

// argoDiffWorkload resolves the pod to run `argocd app diff --core` in, BY LABEL.
//
// TWO bugs here, and the second was hidden behind the first.
//
// It was hardcoded `deploy/argocd-server`, which does not exist: ArgoCD is installed with
// `helm upgrade --install argo-cd argo/argo-cd` (deploy.go) and the chart prefixes every workload
// with the release name, so the real one is `argo-cd-argocd-server`. Every diff came back
// `Error from server (NotFound)`, which is why #2778's question — WHICH field differs — went
// unanswered across four paid runs.
//
// Fixing the name exposed the real wall (hetzner/addons run 33059349873):
//
//	services is forbidden: User "system:serviceaccount:argocd:argocd-server"
//	  cannot list resource "services" in API group "" in the namespace "argocd"   (exit 20)
//
// `--core` runs the API-server logic IN-PROCESS, so it needs the cluster permissions the API server
// would have had — and the argocd-server ServiceAccount does not have them. Verified against the
// pinned chart rather than guessed — and RE-verified on the 8.6.4 → 9.5.11 bump (#2717), where the
// rendered Role is unchanged: the server's Role grants secrets, configmaps,
// argoproj.io resources and events, and nothing else. The APPLICATION-CONTROLLER's ClusterRole is
// apiGroups ['*'], resources ['*'], verbs ['*'] — it has to be, because it reconciles arbitrary
// customer resources. Every ArgoCD component runs the same image, so the `argocd` binary is there.
//
// So the diff runs in the controller. Both workload kinds are asked for because the chart renders
// the controller as a StatefulSet in this configuration and other configurations use a Deployment;
// selecting on the label rather than a name or a kind survives both, and survives a release rename.
func argoDiffWorkload(ctx context.Context, kubeconfigPath string) (string, error) {
	cmd := exec.CommandContext(ctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"-n", "argocd", "get", "statefulset,deployment",
		"-l", "app.kubernetes.io/name=argocd-application-controller",
		"-o", "name")
	out, err := cmd.CombinedOutput()
	return pickArgoDiffWorkload(string(out), err)
}

// pickArgoDiffWorkload turns `kubectl get statefulset,deployment -o name`'s output and exit status
// into either a resource ref or a reason there is none.
//
// Split from the exec so the three outcomes are testable without a cluster, because two of them are
// easy to collapse into each other and they send someone to different places: "kubectl failed" and
// "kubectl succeeded and matched nothing" are different findings, and NEITHER may end up rendering
// as "there is no diff".
func pickArgoDiffWorkload(raw string, err error) (string, error) {
	if err != nil {
		return "", fmt.Errorf("could not resolve the argocd application-controller workload: %v: %s", err, strings.TrimSpace(raw))
	}
	// `-o name` prints `deployment.apps/<name>` per match. Take the first; more than one would mean
	// two ArgoCD installs in one namespace, which is not a case this diagnostic needs to resolve.
	// `statefulset,deployment` also means one kind matching and the other not is normal, not an error.
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		if t := strings.TrimSpace(line); t != "" {
			return t, nil
		}
	}
	// Empty output with exit 0. Its own finding, deliberately.
	return "", errors.New("no StatefulSet or Deployment in namespace argocd carries app.kubernetes.io/name=argocd-application-controller — cannot run `argocd app diff`")
}

// interpretArgoDiff turns `argocd app diff`'s output and exit status into a report section.
//
// Split out from the exec so the three outcomes can be tested without a cluster, because they are
// easy to collapse into each other and two of them are opposite findings:
//
//	exit 1 + output   → A DIFF WAS FOUND. The success case, and the whole point of the command.
//	exit 0 + no output → ArgoCD sees no difference even though the app reports OutOfSync. Real,
//	                     specific, and NOT the same as "we could not look".
//	anything else      → we could not ask. Must never render like "nothing differs".
func interpretArgoDiff(app, raw string, err error) string {
	text := strings.TrimSpace(raw)

	if err != nil {
		var exit *exec.ExitError
		// Exit 1 WITH output is the success case: a diff was found and printed.
		if !(errors.As(err, &exit) && exit.ExitCode() == argoDiffExitCodeMeansDiff && text != "") {
			// Say what went wrong rather than printing nothing — "could not ask" and "nothing
			// differs" are opposite findings and must not render the same.
			if text == "" {
				text = "(no output)"
			}
			return fmt.Sprintf("\n  ──── argocd app diff %s: could NOT be read (%v) ────\n  %s\n",
				app, err, truncateDiff(text))
		}
	}

	if text == "" {
		// Exit 0 and nothing printed: ArgoCD itself sees no difference, even though the Application
		// reports OutOfSync. Real and specific — but AMBIGUOUS between two causes with different
		// fixes, and saying so without separating them is where this stopped being useful.
		//
		// hetzner/addons run 33067969126 hit it on four Applications at once (harbor, kyverno, loki,
		// tempo) while naming their OutOfSync resources — kyverno's five CronJobs, loki's
		// StatefulSet. So the status is specific and the diff is empty, and the two candidates are:
		//
		//   stale status   the controller reconciles on its own cadence, so `status.sync` can lag
		//                  the cluster. Then the diff is right and the status is old.
		//   normalisation  the diff applies something the status does not, so they genuinely
		//                  disagree about the same moment.
		//
		// `status.reconciledAt` against the diff's own timestamp separates them, and the caller
		// appends it — see argoSyncStaleness. Naming the ambiguity without the evidence to resolve
		// it is what #2591's `dns-not-resolving` did, and that cost a paid run to get past.
		return fmt.Sprintf("\n  ──── argocd app diff %s: reports NO difference, yet the Application is OutOfSync ────\n", app)
	}
	return fmt.Sprintf("\n  ──── argocd app diff %s ────\n%s\n", app, truncateDiff(text))
}

// argoSyncStaleness turns an Application's reconcile timestamp into the sentence that separates a
// STALE sync status from a genuine diff/status disagreement.
//
// The pair only appears together on the "no difference, yet OutOfSync" path, where the two causes
// need different fixes: a stale status means the harness read too early and should refresh or wait;
// a fresh status that still disagrees with an empty diff means ArgoCD's own normalisation differs
// between the two, which is a real ArgoCD-level finding.
//
// Pure, so the three outcomes are testable without a cluster. `age` is the gap between the last
// reconcile and now.
func argoSyncStaleness(app string, reconciledAt string, now time.Time) string {
	t := strings.TrimSpace(reconciledAt)
	if t == "" {
		return fmt.Sprintf("      %s: no status.reconciledAt — cannot say whether the status is stale", app)
	}
	parsed, err := time.Parse(time.RFC3339, t)
	if err != nil {
		return fmt.Sprintf("      %s: unparseable status.reconciledAt %q — cannot say whether the status is stale", app, t)
	}
	age := now.Sub(parsed).Round(time.Second)
	// One WORST-CASE reconcile cycle, so anything close to or beyond it is plausibly just a status
	// the controller has not refreshed yet. See argoReconcileInterval for where the number comes
	// from — it is no longer a flat 3m on the shipped chart.
	if age >= argoReconcileInterval {
		return fmt.Sprintf(
			"      %s: last reconciled %s ago (>= ArgoCD's ~%s cadence) — the OutOfSync status is plausibly STALE and the empty diff is current; re-read after a refresh before treating this as a real disagreement",
			app, age, argoReconcileInterval)
	}
	return fmt.Sprintf(
		"      %s: last reconciled %s ago (< ArgoCD's ~%s cadence) — the status is FRESH, so an empty diff and an OutOfSync status genuinely disagree; that is an ArgoCD normalisation difference, not a timing artefact",
		app, age, argoReconcileInterval)
}

// argoHealthOrUnknown renders a health string for a sentence, so an Application whose health was
// never read does not silently become the empty word in "the  health is NOT pod readiness".
func argoHealthOrUnknown(health string) string {
	if h := strings.TrimSpace(health); h != "" {
		return h
	}
	return "Unknown"
}

// syncedUnhealthyLosers narrows the losing Applications to the ones NO other dump section speaks
// for: sync is Synced, so there is no diff to render and no sync failure to report, yet health is
// not Healthy.
//
// It is the shape the gcp floor leg of nightly run 33487970328 died in (#3580), and the run's own
// dump said so out loud — "argocd app diff: no loser is OutOfSync, so there is no diff to show" —
// having then printed nothing else about it. Pure, so the narrowing is testable: pick the wrong set
// and this section either duplicates the diff path or omits the only loser it exists for.
func syncedUnhealthyLosers(observed map[string]argoAppState, losers []string) []string {
	var out []string
	for _, name := range losers {
		// `!= "OutOfSync"`, NOT `== "Synced"`. parseArgoApps normalises an empty
		// status.sync.status to "Unknown", which is what an Application whose compares have ALL
		// aborted reports — the `failed to get repo objects` state this section exists for, one
		// reconcile EARLIER than the case it was written from. `== "Synced"` excluded it, and
		// dumpArgoAppDiffs declines it too (it requires OutOfSync), so that variant produced BOTH
		// "no loser is Synced-but-unhealthy" and "no loser is OutOfSync" — the exact double silence
		// this section was added to end.
		//
		// The complement of OutOfSync is also what the docstring above actually claims: the losers
		// no other section speaks for.
		if st, ok := observed[name]; ok && st.Sync != "OutOfSync" && st.Health != "Healthy" {
			out = append(out, name)
		}
	}
	sort.Strings(out)
	return out
}

// argoHealthStaleness reports HOW OLD a losing Application's health verdict is, and what that age
// does and does not license the reader to conclude.
//
// This is a DIFFERENT question from argoSyncStaleness, which judges a sync status on the
// "no difference, yet OutOfSync" path. Both read status.reconciledAt, and they must not be
// collapsed: there, a stale status means the diff is right and the status is old; here, a stale
// health means the WORKLOAD may already be up and the verdict was taken from before it was.
//
// IT NEVER ISSUES AN ALL-CLEAR, and that is the whole design. The first version of this function
// had two arms — older than ArgoCD's cadence read as suspect, younger read as "the health is
// CURRENT, so this is a real convergence failure". Driven against the run it was written for, the
// second arm fired: on run 33487970328 the last successful compare was 09:12:07Z and the assertion
// read health at 09:14:05Z, an age of 1m58s — inside a 120-180s cadence by two seconds — while the
// health it was vouching for was demonstrably wrong (every pod had been Running and ready since
// 09:11:36Z). No threshold answers this, because ArgoCD updates reconciledAt only on a compare that
// SUCCEEDS: a small age means the last GOOD compare was recent, never that no compare has failed
// since. Picking a bound that would have caught this one run would have been a number reverse-
// engineered from the answer, which is not a measurement.
//
// So the age is reported as the FACT it is, both arms name the controller log as the place the
// question is actually settled, and only the arm that can be sure — a full reconcile window missed
// — states the stronger finding.
//
// Pure, so all four outcomes are testable without a cluster.
func argoHealthStaleness(app, health, reconciledAt string, now time.Time) string {
	t := strings.TrimSpace(reconciledAt)
	if t == "" {
		return fmt.Sprintf("      %s: health=%s, but there is no status.reconciledAt — cannot say how old that health is",
			app, argoHealthOrUnknown(health))
	}
	parsed, err := time.Parse(time.RFC3339, t)
	if err != nil {
		return fmt.Sprintf("      %s: health=%s, and status.reconciledAt %q is unparseable — cannot say how old that health is",
			app, argoHealthOrUnknown(health), t)
	}
	age := now.Sub(parsed).Round(time.Second)
	const shared = " ArgoCD advances reconciledAt only on a compare that SUCCEEDS, so this age is the gap since the last GOOD compare and NOT evidence that none has failed since — check the controller log section above for compares that aborted, and treat a Running-and-ready workload as evidence the health is stale rather than the workload broken."
	if age >= argoReconcileInterval {
		return fmt.Sprintf(
			"      %s: health=%s was last recomputed %s ago, which is a FULL reconcile window (~%s) missed — this verdict may predate the cluster it describes.%s",
			app, argoHealthOrUnknown(health), age, argoReconcileInterval, shared)
	}
	return fmt.Sprintf(
		"      %s: health=%s was last recomputed %s ago (within ArgoCD's ~%s cadence). That does NOT make it current:%s",
		app, argoHealthOrUnknown(health), age, argoReconcileInterval, shared)
}

// dumpArgoHealthStaleness reports, for every Synced-but-unhealthy loser, whether its health is
// fresh enough to be believed.
//
// It is its own section rather than a branch inside dumpArgoAppDiffs because that function returns
// EARLY — "no loser is OutOfSync, so there is no diff to show" — before it reaches the staleness
// probe it already owns. The one diagnostic that could have explained #3580 was therefore
// unreachable in exactly the run that needed it: reachable only from the OutOfSync path, and this
// loser was Synced.
func dumpArgoHealthStaleness(ctx context.Context, kubeconfigPath string, observed map[string]argoAppState, losers []string) string {
	candidates := syncedUnhealthyLosers(observed, losers)
	if len(candidates) == 0 {
		// Distinguishable from "we did not look", the same way dumpArgoAppDiffs is: no loser is in
		// the state this section exists for.
		return "\n──── argocd health freshness: no loser is Synced-but-unhealthy, so no health can be stale ────\n"
	}
	// One jsonpath read per app — cheap next to a chart render, but this section's share of the
	// pooled dump budget is a fraction of four minutes, and a full-surface run can lose twenty
	// Applications at once. Capped, and the cap SAYS SO: a section that quietly stops before the
	// interesting app has the same effect as no section at all.
	const maxHealthChecked = 8

	var b strings.Builder
	b.WriteString("\n──── is the HEALTH current? (losers no other section speaks for — ArgoCD refreshes health only on a successful compare) ────\n")
	for i, name := range candidates {
		if i >= maxHealthChecked {
			fmt.Fprintf(&b, "  … %d more Synced-but-unhealthy Application(s) not checked\n", len(candidates)-i)
			break
		}
		// THE CLOCK IS READ PER APP, AFTER the kubectl call returns — not once before the loop.
		// Each readArgoReconciledAt is a 30s-bounded call, and this section runs on a cluster whose
		// apiserver is by hypothesis slow, so a single `now` taken up front is stale by the sum of
		// every read before it: with three 25s reads the third app's age is understated by 50s.
		// This is the one section whose entire subject is elapsed time, and the bias runs toward
		// UNDER-reporting staleness — the direction that loses the finding. argoSyncStaleness's
		// existing caller passes time.Now() per app for the same reason.
		ts, readErr := readArgoReconciledAtOrFail(ctx, kubeconfigPath, name)
		if readErr != "" {
			// SAID as a failure of the probe, never attributed to the Application. "" is what a
			// non-zero kubectl exit, an apiserver refusal AND this section's share of the pooled
			// dump budget expiring all look like, and rendering those as "there is no
			// status.reconciledAt" states something about the cluster that was never read — a
			// reader takes it to mean ArgoCD never reconciled these Applications. Same rule
			// dumpUnhealthyPods states four hundred lines up.
			fmt.Fprintf(&b, "      %s: health=%s, and status.reconciledAt could NOT BE READ (%s) — this says nothing about the Application\n",
				name, argoHealthOrUnknown(observed[name].Health), readErr)
			continue
		}
		b.WriteString(argoHealthStaleness(name, observed[name].Health, ts, time.Now()) + "\n")
	}
	return b.String()
}

// argoReconcileInterval is the WORST-CASE gap between two reconciles on the shipped argo-cd chart.
// Used only to judge whether a sync status is old enough to be suspect, never to wait on.
//
// The value is unchanged at 3m across the 8.6.4 → 9.5.11 bump, but its derivation is not, and the
// old comment ("ArgoCD's default reconciliation is every 3 minutes") is no longer true. 8.6.4's
// argocd-cm set `timeout.reconciliation: 180s` with no jitter. 9.5.11 sets
// `timeout.reconciliation: 120s` plus `timeout.reconciliation.jitter: 60s`, so the cadence is now a
// 120s–180s band. 3m is still the right bound BECAUSE it is the top of that band: this constant
// exists to avoid calling a status stale when it is merely young, so it must be the longest a fresh
// status can legitimately go unrefreshed, not the typical one.
const argoReconcileInterval = 3 * time.Minute

// readArgoReconciledAt reads an Application's last reconcile timestamp. Best-effort: this runs on an
// already-failing path and an empty string is handled by argoSyncStaleness as "cannot say".
func readArgoReconciledAt(ctx context.Context, kubeconfigPath, app string) string {
	ts, _ := readArgoReconciledAtOrFail(ctx, kubeconfigPath, app)
	return ts
}

// readArgoReconciledAtOrFail is the same read, keeping the two outcomes APART: it returns the
// timestamp and a non-empty failure reason when the read itself did not happen.
//
// readArgoReconciledAt collapses them to "", which is fine on the sync path — argoSyncStaleness
// renders "" as "cannot say", a hedge, not a claim. It is NOT fine on the health path, where the
// same "" was rendered as "there is no status.reconciledAt": an affirmative statement about the
// Application, made after a read that never returned. THREE things produce that "" — a non-zero
// kubectl exit, an apiserver refusal, and this section's share of the pooled dump budget expiring —
// and the last is the common one, so on a slow cluster six Applications in a row would be reported
// as never reconciled. A wrong finding is worse than a missing one.
//
// Same read, same reason as the comment below: the value is parsed as a timestamp, and a `Warning:`
// line glued to the front makes a perfectly good reconciledAt unparseable — which the callers
// report as "cannot say" rather than as the read problem it is.
func readArgoReconciledAtOrFail(ctx context.Context, kubeconfigPath, app string) (string, string) {
	out, err := kubectlRead(ctx, 30*time.Second, kubeconfigPath,
		"-n", "argocd", "get", "applications.argoproj.io", app,
		"-o", "jsonpath={.status.reconciledAt}")
	if err != nil {
		// The context's own error when it is the reason, because "the dump ran out of budget" and
		// "the apiserver refused this read" send a reader to entirely different places.
		if cerr := ctx.Err(); cerr != nil {
			return "", fmt.Sprintf("the dump's budget ran out: %v", cerr)
		}
		return "", trimArgoPreflightReasonLike(err.Error())
	}
	return strings.TrimSpace(string(out)), ""
}

// trimArgoPreflightReasonLike bounds a diagnostic to one line so a kubectl error cannot turn one
// row of this section into a page. (argocd's own trimArgoPreflightReason lives in packages/core and
// is not importable from the test package.)
func trimArgoPreflightReasonLike(s string) string {
	const max = 200
	one := strings.Join(strings.Fields(s), " ")
	if len(one) > max {
		return one[:max] + "…"
	}
	return one
}

// maxArgoDiffBytes caps one Application's diff. A CRD's openAPIV3Schema is enormous, and the useful
// part of a diff is the top.
const maxArgoDiffBytes = 4000

func truncateDiff(text string) string {
	if len(text) <= maxArgoDiffBytes {
		return text
	}
	return text[:maxArgoDiffBytes] + "\n… (diff truncated)"
}

func dumpOutOfSyncResources(ctx context.Context, kubeconfigPath string, refs []outOfSyncRef) string {
	const (
		// 17 OutOfSync refs against a cap of 8 on run 32959867406 — "… 9 more not shown" hid more
		// than it showed. Deduplication (#2778) reduced the count; it did not make 8 enough.
		maxResources = 24
		maxPathsPer  = 12
	)
	if len(refs) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n  fields the chart did NOT author, by server-side-apply ownership")
	b.WriteString("\n  (candidates for an ignoreDifferences entry — narrowing, not proof):")
	shown := 0
	for _, r := range refs {
		if shown >= maxResources {
			fmt.Fprintf(&b, "\n    … %d more not shown", len(refs)-shown)
			break
		}
		shown++
		args := foreignOwnerKubectlArgs(kubeconfigPath, r.kubectlTarget(), r.Namespace)
		// `args[2:]` drops the `--kubeconfig <path>` pair foreignOwnerKubectlArgs puts first, because
		// kubectlRead prepends its own. The PATH still has to be handed over: passing "" here made
		// kubectlRead prepend `--kubeconfig ""`, and kubectl does not reject an empty value — it
		// falls back to its default loading rules ($KUBECONFIG, then ~/.kube/config, then
		// localhost:8080). So this probe read whatever cluster the machine happened to be pointed
		// at, or none, and reported the answer as if it came from the cluster under test.
		out, err := kubectlRead(ctx, 20*time.Second, kubeconfigPath, args[2:]...)
		if err != nil {
			// Naming the failure matters as much as the dump: "could not read it" and "it had
			// nothing interesting" must not look the same.
			fmt.Fprintf(&b, "\n    - %s: could not fetch (%v)", r.kubectlTarget(), err)
			continue
		}
		byManager, total, perr := foreignFieldOwners(out)
		if perr != nil {
			fmt.Fprintf(&b, "\n    - %s: could not read managedFields (%v)", r.kubectlTarget(), perr)
			continue
		}
		if total == 0 {
			// THREE outcomes, not two. An object with NO managedFields at all is not an object
			// every field of which belongs to ArgoCD — it is an object this probe could not read,
			// and conflating the two is the whole defect: the reassuring sentence below was printed
			// on an empty list for the life of this check. Every real object on a modern apiserver
			// has at least one entry, so zero means the read was wrong, not the cluster.
			fmt.Fprintf(&b, "\n    - %s: NO managedFields on the object — this probe measured NOTHING. "+
				"(kubectl strips them without --show-managed-fields; if the flag is present and this still "+
				"prints, the apiserver is not tracking ownership for this resource.)", r.kubectlTarget())
			continue
		}
		if len(byManager) == 0 {
			// A DIFFERENT fact from "we could not tell", and it must read differently: every field
			// on this object belongs to ArgoCD, so an apiserver default is not the explanation here
			// and the cause is elsewhere. Trustworthy ONLY because `total > 0` above proved there
			// were entries to classify.
			fmt.Fprintf(&b, "\n    - %s: every field is ArgoCD-owned across %d manager entr(ies) — no foreign default to blame", r.kubectlTarget(), total)
			continue
		}
		fmt.Fprintf(&b, "\n    - %s:", r.kubectlTarget())
		for _, m := range sortedManagers(byManager) {
			paths := byManager[m]
			sort.Strings(paths)
			if len(paths) > maxPathsPer {
				paths = append(paths[:maxPathsPer:maxPathsPer], fmt.Sprintf("…%d more", len(byManager[m])-maxPathsPer))
			}
			fmt.Fprintf(&b, "\n        owned by %q: %s", m, strings.Join(paths, ", "))
		}
	}
	return b.String()
}

// foreignOwnerKubectlArgs builds the read this probe depends on. Extracted so the ONE flag that
// makes it a measurement can be asserted without a cluster.
//
// `--show-managed-fields` IS LOAD-BEARING, and its absence is why this probe answered vacuously for
// the whole of its life. Since kubectl 1.21, `get -o json|yaml` STRIPS `metadata.managedFields`
// unless the flag is given — so foreignFieldOwners parsed an empty list on every object, found zero
// foreign managers every time, and printed "every field is ArgoCD-owned — no foreign default to
// blame". That sentence was TRUE OF NOTHING: it appeared for seven Applications across four paid
// runs (see the #2778 note above) and never once described a measurement.
//
// Measured on a kind cluster, keda 2.15.1: without the flag `metadata.managedFields` is absent
// entirely; with it, `manager=keda` owns exactly `webhooks[*].clientConfig.caBundle` — which is the
// field azure/addons run 33243601159 sat OutOfSync on while this probe called it ArgoCD-owned.
func foreignOwnerKubectlArgs(kubeconfigPath, target, namespace string) []string {
	args := []string{"--kubeconfig", kubeconfigPath, "get", target, "-o", "json", "--show-managed-fields"}
	if namespace != "" {
		args = append(args, "-n", namespace)
	}
	return args
}

// argoFieldManagers are the manager names ArgoCD applies under. A field owned by one of these was
// authored by the chart, so it is NOT a candidate.
//
// Matched as a SUBSTRING, deliberately: ArgoCD's manager name has varied across versions
// (`argocd-controller`, `argocd-application-controller`, and a `argocd-controller-ssa` variant on
// the server-side-apply path), and this runs on a failing path where a missed match would print a
// misleading candidate rather than fail loudly.
var argoFieldManagers = []string{"argocd"}

// foreignFieldOwners returns manager → the field paths that manager owns, for every manager that is
// NOT ArgoCD, AND the total number of managedFields entries the object carried.
//
// The total is returned, not derived by the caller, because "no foreign owner" and "no owners at
// all" are different answers and only one of them is about the cluster. Returning a single empty
// map for both is what let this probe report `every field is ArgoCD-owned` on objects whose
// managedFields kubectl had silently stripped.
func foreignFieldOwners(objJSON []byte) (map[string][]string, int, error) {
	var obj struct {
		Metadata struct {
			ManagedFields []struct {
				Manager  string          `json:"manager"`
				FieldsV1 json.RawMessage `json:"fieldsV1"`
			} `json:"managedFields"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(objJSON, &obj); err != nil {
		return nil, 0, err
	}
	out := map[string][]string{}
	for _, mf := range obj.Metadata.ManagedFields {
		if isArgoManager(mf.Manager) {
			continue
		}
		var tree map[string]json.RawMessage
		if err := json.Unmarshal(mf.FieldsV1, &tree); err != nil {
			continue
		}
		paths := flattenFieldsV1(tree, "")
		if len(paths) > 0 {
			out[mf.Manager] = append(out[mf.Manager], paths...)
		}
	}
	return out, len(obj.Metadata.ManagedFields), nil
}

// isArgoManager reports whether a field manager is ArgoCD's.
func isArgoManager(name string) bool {
	lower := strings.ToLower(name)
	for _, m := range argoFieldManagers {
		if strings.Contains(lower, m) {
			return true
		}
	}
	return false
}

// flattenFieldsV1 turns the apiserver's fieldsV1 tree into dotted paths.
//
// The encoding: a key is `f:<field>` for a field, `k:{...}` / `i:<n>` / `v:<x>` for a list entry,
// and the bare `.` marks "this node itself is owned". Leaf `.` keys are dropped rather than rendered
// as a trailing dot, because `.spec.replicas.` is not a path anyone can act on.
func flattenFieldsV1(tree map[string]json.RawMessage, prefix string) []string {
	var paths []string
	for key, raw := range tree {
		// `.` means the node at `prefix` is itself owned; it adds no new path.
		if key == "." {
			continue
		}
		var seg string
		switch {
		case strings.HasPrefix(key, "f:"):
			seg = prefix + "." + strings.TrimPrefix(key, "f:")
		default:
			// A list-entry selector (k:/i:/v:). Keep it verbatim inside brackets: which ELEMENT
			// differs is often the whole answer on a containers[] or versions[] list.
			seg = prefix + "[" + key + "]"
		}
		var child map[string]json.RawMessage
		if err := json.Unmarshal(raw, &child); err != nil || len(child) == 0 {
			paths = append(paths, seg)
			continue
		}
		sub := flattenFieldsV1(child, seg)
		if len(sub) == 0 {
			paths = append(paths, seg)
			continue
		}
		paths = append(paths, sub...)
	}
	return paths
}

// sortedManagers returns the manager names in order, so the dump is stable run to run — an unstable
// dump makes two runs look different when nothing changed.
func sortedManagers(m map[string][]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// refsForLosers collects the OutOfSync resource refs belonging to the failing Applications, so the
// dump covers exactly the losers and not the whole cluster.
//
// DEDUPLICATED, and it matters more than it looks. Cluster-scoped objects — a CustomResourceDefinition
// most of all — can be reported OutOfSync under MORE THAN ONE Application, and the dump is capped at
// maxResources. hetzner/addons run 32949217522 had exactly 8 losers against a cap of 8, five of them
// argo-rollouts CRDs: a single duplicate would have pushed a genuine object behind
// "… 1 more not shown" and cost that run an answer, which is the same way the previous dump failed.
//
// Order is preserved (first occurrence wins) so the output still follows the loser order a reader
// sees above it, rather than an arbitrary map order.
func refsForLosers(observed map[string]argoAppState, losers []string) []outOfSyncRef {
	var refs []outOfSyncRef
	seen := map[outOfSyncRef]bool{}
	for _, name := range losers {
		for _, r := range observed[name].OutOfSyncRefs {
			if seen[r] {
				continue
			}
			seen[r] = true
			refs = append(refs, r)
		}
	}
	return refs
}

// describeManagedWorkloads reports the workload-bearing resources an Application says it manages,
// so "no pods" can be read correctly rather than assumed.
//
// It exists because "no pods matched my selector" is a statement about the SELECTOR as much as about
// the cluster, and a dump that cannot tell those apart will eventually blame a chart for a harness
// bug. ArgoCD's `.status.resources` is what it believes it created, so:
//
//	a DaemonSet/Deployment IS listed, and no pods    → the workload exists and produced none. Real.
//	nothing workload-bearing is listed               → the chart rendered none. Also real, different.
//	resources listed but the selector found nothing  → suspect the SELECTOR, not the chart.
//
// Best-effort on an already-failing path: an error is reported as an inability to check, never as an
// absence.
// managedWorkload is one pod-producing resource an Application says it created.
type managedWorkload struct {
	Kind      string
	Name      string
	Namespace string
	Health    string
}

func (w managedWorkload) String() string {
	return fmt.Sprintf("%s/%s in %s %s", w.Kind, w.Name, w.Namespace, w.Health)
}

// podProducingKinds are the kinds worth chasing for pods. A ConfigMap tells us nothing on a
// failing path.
var podProducingKinds = map[string]bool{
	"DaemonSet": true, "Deployment": true, "StatefulSet": true,
	"Job": true, "CronJob": true, "ReplicaSet": true,
}

// managedWorkloads reads the pod-producing resources an Application believes it created, from
// `.status.resources` — ArgoCD's own record of what it applied.
func managedWorkloads(ctx context.Context, kubeconfigPath, app string) ([]managedWorkload, error) {
	out, err := kubectlRead(ctx, 20*time.Second, kubeconfigPath,
		"get", "applications.argoproj.io", "-n", "argocd", app,
		"-o", "jsonpath={range .status.resources[*]}{.kind}|{.name}|{.namespace}|{.health.status}{\"\\n\"}{end}",
	)
	if err != nil {
		return nil, err
	}
	return parseManagedWorkloads(string(out)), nil
}

// parseManagedWorkloads turns the `kind|name|namespace|health` lines into workloads, keeping only
// the pod-producing kinds. Split out from the kubectl call so it can be tested without a cluster.
func parseManagedWorkloads(raw string) []managedWorkload {
	var ws []managedWorkload
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		parts := strings.Split(strings.TrimSpace(line), "|")
		// A namespace is required: it is how the pod query is scoped, and a workload without one
		// would silently widen the search to every namespace.
		if len(parts) < 3 || !podProducingKinds[parts[0]] || parts[1] == "" || parts[2] == "" {
			continue
		}
		w := managedWorkload{Kind: parts[0], Name: parts[1], Namespace: parts[2]}
		if len(parts) > 3 {
			w.Health = parts[3]
		}
		ws = append(ws, w)
	}
	sort.Slice(ws, func(a, b int) bool { return ws[a].String() < ws[b].String() })
	return ws
}

// podSelectorFor asks a workload for the label selector IT uses to own its pods.
//
// This is the authoritative answer, and the reason this function exists: the pod-template labels
// are the CHART's choice, not ArgoCD's, so no single hard-coded selector can be right for every
// chart. Reading `.spec.selector.matchLabels` cannot go stale, because it is definitionally the
// selector the workload itself matches on.
func podSelectorFor(ctx context.Context, kubeconfigPath string, w managedWorkload) (string, error) {
	out, err := kubectlRead(ctx, 20*time.Second, kubeconfigPath,
		"get", strings.ToLower(w.Kind), "-n", w.Namespace, w.Name,
		"-o", "jsonpath={.spec.selector.matchLabels}",
	)
	if err != nil {
		return "", err
	}
	sel, err := selectorFromMatchLabels(string(out))
	if err != nil {
		return "", fmt.Errorf("%s: %w", w, err)
	}
	return sel, nil
}

// selectorFromMatchLabels turns a `.spec.selector.matchLabels` JSON object into a kubectl `-l`
// selector. Split out from the kubectl call so it can be tested without a cluster.
//
// An EMPTY or absent matchLabels is an ERROR, never an empty selector: `kubectl get pods -l ""`
// matches EVERYTHING in the namespace, so returning "" here would turn "I could not determine the
// selector" into a dump of unrelated pods presented as this workload's.
func selectorFromMatchLabels(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errors.New("no .spec.selector.matchLabels")
	}
	var labels map[string]string
	if err := json.Unmarshal([]byte(trimmed), &labels); err != nil {
		return "", fmt.Errorf("unreadable matchLabels: %w", err)
	}
	if len(labels) == 0 {
		return "", errors.New("empty matchLabels")
	}
	// Deterministic order: this string appears in a log a human compares between runs.
	keys := make([]string, 0, len(labels))
	for k := range labels {
		if k == "" || labels[k] == "" {
			return "", fmt.Errorf("matchLabels has a blank key or value: %q=%q", k, labels[k])
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, k := range keys {
		pairs = append(pairs, k+"="+labels[k])
	}
	return strings.Join(pairs, ","), nil
}

// describeManagedWorkloads reports the workload-bearing resources an Application says it manages,
// so "no pods" can be read correctly rather than assumed.
//
// It exists because "no pods matched my selector" is a statement about the SELECTOR as much as about
// the cluster, and a dump that cannot tell those apart will eventually blame a chart for a harness
// bug. ArgoCD's `.status.resources` is what it believes it created, so:
//
//	a DaemonSet/Deployment IS listed, and no pods    → the workload exists and produced none. Real.
//	nothing workload-bearing is listed               → the chart rendered none. Also real, different.
//	resources listed but the selector found nothing  → suspect the SELECTOR, not the chart.
//
// Best-effort on an already-failing path: an error is reported as an inability to check, never as an
// absence.
func describeManagedWorkloads(ctx context.Context, kubeconfigPath, app string) string {
	ws, err := managedWorkloads(ctx, kubeconfigPath, app)
	if err != nil {
		return fmt.Sprintf("\n  (could not read what %s manages: %v — so whether the workload exists is UNKNOWN)", app, err)
	}
	if len(ws) == 0 {
		return "\n  ArgoCD lists NO workload-bearing resource for this Application — the chart rendered none," +
			"\n  so there is nothing to produce a pod. Not a scheduling problem."
	}
	names := make([]string, 0, len(ws))
	for _, w := range ws {
		names = append(names, w.String())
	}
	return fmt.Sprintf("\n  ArgoCD says it manages %d workload(s):\n    %s",
		len(ws), strings.Join(names, "\n    "))
}

// describeWorkload dumps a workload's own status and events — what actually explains a workload
// that exists and has produced no pods.
//
// hetzner `addons` run 32970696343 is the case: falco's DaemonSet was listed, its pod-template
// labels were CORRECT, and the dump still could not say why zero pods existed, because nothing
// ever asked the DaemonSet. `desiredNumberScheduled: 0` and a FailedPlacement event are both in
// here, and they mean different things.
func describeWorkload(ctx context.Context, kubeconfigPath string, w managedWorkload) string {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "kubectl", "--kubeconfig", kubeconfigPath,
		"describe", strings.ToLower(w.Kind), "-n", w.Namespace, w.Name).CombinedOutput()
	if err != nil {
		return fmt.Sprintf("\n  (could not describe %s: %v)\n", w, err)
	}
	text := string(out)
	// The status/events tail, not the spec — the Application above already rendered the spec.
	if i := strings.Index(text, "Pod Template:"); i > 0 {
		text = text[:i] + "…\n" + tailAfter(text, "Events:")
	}
	const maxWorkloadDescribe = 2500
	if len(text) > maxWorkloadDescribe {
		text = text[:maxWorkloadDescribe] + "\n… (truncated)"
	}
	return fmt.Sprintf("\n  ──── %s ────\n%s\n", w, text)
}

// tailAfter returns everything from `marker` onward, or "" when the marker is absent — so a
// missing Events block reads as absent rather than silently returning the whole document.
func tailAfter(text, marker string) string {
	if i := strings.Index(text, marker); i >= 0 {
		return text[i:]
	}
	return ""
}

// argoHardRefreshVerdict asks ArgoCD to recompute the Application from scratch and reports whether
// the OutOfSync status SURVIVES that.
//
// It answers the one thing `reports NO difference` + a fresh `reconciledAt` still cannot. A fresh
// reconcile is not a fresh RENDER: ArgoCD caches generated manifests per repo revision, so a
// reconcile can be seconds old and still be comparing against a cached desired state. `--hard-refresh`
// discards that cache and regenerates. So:
//
//	Synced after a hard refresh    the OutOfSync was a stale MANIFEST CACHE. The cluster already
//	                              matched; nothing about the chart or the cluster needs changing,
//	                              and the harness should refresh before asserting.
//	still OutOfSync               ArgoCD genuinely believes live differs from desired while its own
//	                              diff prints nothing — a normalisation difference, and a real
//	                              finding worth an issue rather than a retry.
//
// That distinction is worth a paid run on its own: as of 2026-08-28 every OutOfSync resource across
// two runs and eight charts (valkey, rabbitmq, a CNPG Cluster, three harbor StatefulSets, loki,
// tempo) is a StatefulSet or a PVC-owning CR, and it blocks maxconfig and addons on every cloud.
//
// Best-effort, like everything else on this path: it runs only on an already-failing verdict, it is
// bounded by the caller's context, and every failure to ASK renders as "could not tell" rather than
// as either answer.
func argoHardRefreshVerdict(ctx context.Context, kubeconfigPath, target, app string) string {
	// The hard refresh runs INSIDE the application-controller pod (it needs --core plus
	// repo-server reachability); the status is then read from OUTSIDE it.
	//
	// That split is not stylistic. The first attempt exec'd BOTH commands in the pod and the second
	// one died with `exec: "kubectl": executable file not found in $PATH` — the controller image
	// ships `argocd` and not `kubectl`. The probe reported COULD NOT ASK rather than inventing a
	// verdict, which is the fail-safe working, but it answered nothing. `readArgoReconciledAt`
	// already reads Application status with the HOST kubectl; this now does the same.
	inPod := func(args ...string) (string, error) {
		full := append([]string{"--kubeconfig", kubeconfigPath, "-n", "argocd", "exec", target, "--"}, args...)
		out, err := exec.CommandContext(ctx, "kubectl", full...).CombinedOutput()
		return strings.TrimSpace(string(out)), err
	}
	if out, err := inPod("argocd", "app", "get", app, "--core", "--hard-refresh", "-o", "json"); err != nil {
		return interpretHardRefresh("", err, out)
	}
	// kubectlRead, NOT CombinedOutput: this value becomes a VERDICT. interpretHardRefresh maps the
	// string to Synced/OutOfSync, and kubectl writes a `Warning:` or an exec-credential notice to
	// stderr on calls that SUCCEED — so a fused `Warning: …\nSynced` matches neither, and a
	// correct hard refresh reads as an unrecognised state.
	raw, err := kubectlRead(ctx, 20*time.Second, kubeconfigPath,
		"-n", "argocd", "get", "applications.argoproj.io", app,
		"-o", "jsonpath={.status.sync.status}")
	if err != nil {
		return interpretHardRefresh("", err, strings.TrimSpace(string(raw)))
	}
	return interpretHardRefresh(strings.TrimSpace(string(raw)), nil, "")
}

// interpretHardRefresh is the verdict half of argoHardRefreshVerdict, split out so the mapping is
// testable without a cluster — the same shape interpretArgoDiff and interpretByoSyncPolicy use.
//
// `askErr` non-nil means the question could not be PUT, which is not an answer in either direction
// and must never render like one.
func interpretHardRefresh(syncStatus string, askErr error, detail string) string {
	if askErr != nil {
		if len(detail) > 400 {
			detail = detail[:400] + "…"
		}
		return fmt.Sprintf("  hard refresh: COULD NOT ASK (%v) — this does NOT decide between a stale manifest cache and a real normalisation difference: %s",
			askErr, detail)
	}
	switch strings.TrimSpace(syncStatus) {
	case "Synced":
		return "  hard refresh: the Application is now SYNCED — the OutOfSync was a STALE MANIFEST CACHE, not a difference. ArgoCD had reconciled recently but was comparing against a cached render."
	case "":
		return "  hard refresh: the sync status came back EMPTY — cannot say whether it survived"
	default:
		return "  hard refresh: still " + strings.TrimSpace(syncStatus) +
			" — the status SURVIVES a full re-render, so ArgoCD believes live differs from desired while its own diff prints nothing. That is a normalisation difference and needs a fix, not a retry."
	}
}
