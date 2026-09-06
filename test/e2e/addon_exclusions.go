// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// Which catalog add-ons the `addons` dimension does not require to converge, and WHY.
//
// #2717 measured the full surface honestly for the first time — 11 of 22 Applications not
// Healthy+Synced — and several of those cannot converge AT CATALOG DEFAULTS by design: they need a
// value only a customer can supply. Asserting them anyway makes the dimension unpassable for a
// reason that is not a defect, and a bar that cannot be passed stops being read.
//
// So the claim is narrowed to something provable and still worth proving:
//
//	every add-on that CAN install unattended does.
//
// Deliberately NOT the repair of seeding the fixture with values a customer would supply — a bucket
// for velero, a Cloudflare token for external-dns. That would make all eighteen green while
// stopping the fixture from representing what a customer actually gets, and a default-install
// regression is the one most likely to reach a customer.
//
// It IS the repair of making the product converge at its own defaults, and two entries have left
// this list that way rather than by being excused: velero rendered an invalid
// BackupStorageLocation, and vault had no init/unseal path at all. Both were fixed in the CATALOG
// and the RUNNER, which is the outcome this file wants — the list shrinking because the product got
// better, not because the bar moved.
//
// Two properties keep this from becoming a way to hide failures:
//
//  1. An exclusion carries a WHY and an ISSUE, enforced by a test. maxconfig.go settles the same
//     question the same way: an exclusion nobody can read is indistinguishable from an oversight.
//  2. An excluded add-on is still INSTALLED and still OBSERVED. If one turns out Healthy+Synced,
//     the run goes RED for a STALE EXCLUSION — the same ratchet the CLI-demo bar applies to a
//     closed gap (t2_cli_demo_run_test.go), for the same reason: an exclusion left standing after
//     the thing starts working understates the product.
//
// AN EXCLUSION IS PER CLOUD, and that is not a generalisation for its own sake — it is what the
// tree turned out to require. #3048 made the add-on fixture per cloud and resolved external-dns's
// NATIVE provider through the real emitter, and hetzner's resolved shape (the webhook sidecar)
// CONVERGES where aws/gcp/azure/alibaba's do not. A global list would have had to either red the
// hetzner run for an exclusion that is no longer true, or withhold on four clouds a fact measured
// on one. Neither is a thing this file may say. Both properties above still hold per cloud: the
// WHY is still enforced, and the ratchet still fires on the clouds an entry actually claims.
//
// This is NOT the place for a chart that merely fails. "Broken" and "needs a customer" are
// different facts, and only the second one belongs here.

// AddOnExclusionKind names the REASON an add-on is withheld. It is a typed kind rather than a bare
// comment so a second reason cannot be added by writing prose that nothing reads.
type AddOnExclusionKind string

const (
	// NeedsUserConfig — the chart needs a value only a CUSTOMER can supply: a bucket, an unseal
	// key, an API token. Not a cloud ceiling (every cloud would host it fine) and not a product
	// defect (the catalog offers the knob) — simply not exercisable by a fixture that seeds
	// catalog defaults.
	NeedsUserConfig AddOnExclusionKind = "needs-user-config"
)

// AddOnExclusion is one withheld add-on's record.
type AddOnExclusion struct {
	Kind AddOnExclusionKind
	// Why must say what a CUSTOMER would have to supply, in enough detail that a reader can decide
	// whether the exclusion is still true without re-deriving it.
	Why string
	// Issue is the tracking issue, so an exclusion cannot become permanent by being forgotten. It
	// must be OPEN: a CLOSED issue defeats the whole point of the field, and that is not
	// hypothetical — external-dns cited #2734 for two days after #2777 closed it by fixing the very
	// gap the Why described.
	Issue string
	// Clouds narrows the exclusion to the clouds it is actually TRUE on. Empty means every cloud.
	//
	// This exists because the fixture went per-cloud in #3048 and the truth went with it. Before
	// that, one cloud-agnostic fixture pointed external-dns at Cloudflare everywhere, so one global
	// answer was the right shape. Now each cloud gets its own native provider, and hetzner's
	// resolves to a shape that CONVERGES while the others do not — a fact a global list cannot
	// express without lying about one cloud or the other.
	//
	// A POSITIVE list, not an exemption list, so a cloud nobody has measured is ASSERTED rather
	// than silently inheriting an exclusion derived from a different cloud's behaviour. That is the
	// fail-loud direction: an unmeasured cloud that cannot converge reds with the chart named,
	// which is a question someone can answer, whereas a silently-inherited exclusion is the
	// monotonic growth this whole file exists to prevent.
	Clouds []string
	// HealthFailsOpen, when non-empty, states WHY this add-on reaching Healthy+Synced is not
	// evidence that it works — and therefore why the staleness ratchet below cannot use Healthy to
	// conclude this exclusion should come off the list.
	//
	// This exists because the ratchet's whole premise is `Healthy+Synced ⇒ it converged ⇒ take it
	// off`, and that premise is a claim about the CHART, not a law. external-dns 1.15.0 falsifies
	// it: the controller fatals on a provider CONSTRUCTION error but not on a per-record
	// AccessDenied, so on EKS — where the SDK default chain always finds the node role through
	// IMDS — it comes up Healthy and writes nothing. #3428 removed the aws exclusion on exactly
	// that Healthy and #3432 put it back; this field is what stops the ratchet from doing it again
	// on the next run.
	//
	// It is deliberately NOT a suppression. An abstention is REPORTED every time it is taken, with
	// this reason and the tracking Issue, because a ratchet that silently stops ratcheting is the
	// failure this file exists to prevent — "nothing found" must not render the same as "nothing
	// wrong". Setting it is a statement that a STRONGER predicate is owed, and the Issue is where
	// that predicate is tracked.
	//
	// KEYED BY CLOUD, and that is not incidental: fail-open is a property of the CLOUD's credential
	// mechanism, not of the chart. The same external-dns entry is fail-open on aws (the SDK default
	// chain always finds the node role through IMDS, so the provider constructs) and fail-CLOSED on
	// gcp and azure (403 / missing config file, both inside the constructor, both measured
	// Degraded). A single un-keyed flag would have switched the ratchet off on three clouds where
	// Healthy is still real evidence — which is the silently-neutered guard this field's own
	// comment warns about, so it is spelled out here rather than left to be rediscovered.
	HealthFailsOpenOn map[string]string
}

// healthFailsOpenOn returns the recorded reason this add-on's Healthy is not evidence on `cloud`, or
// "" when the ratchet applies there normally.
func (e AddOnExclusion) healthFailsOpenOn(cloud string) string {
	return e.HealthFailsOpenOn[cloud]
}

// addOnExclusions is keyed on the CATALOG ID (not the Application name), because that is the
// identifier the catalog fixture and the console share. A test pins every key against the catalog,
// so an exclusion for an add-on that was renamed or removed fails the build instead of silently
// excluding nothing.
var addOnExclusions = map[string]AddOnExclusion{
	// vault is NOT here any more either, and this one is ASSERTED WHILE UNMEASURED — deliberately,
	// because that is the direction this file already commits to. The Clouds doc below says a cloud
	// nobody has measured is asserted rather than silently withheld, "which is the fail-loud
	// direction: an unmeasured cloud that cannot converge reds with the chart named, which is a
	// question someone can answer". The same reasoning applies to a chart whose blocker has been
	// removed but not yet re-run.
	//
	// The recorded Why said the catalog offered no init/unseal knob and that initialising was "a
	// customer operation with a customer's key material". The first half is now false: the catalog
	// offers `initialize` (default on) and the runner applies a one-shot in-cluster Job that runs
	// `vault operator init`, unseals, mounts KV v2 and revokes the root token
	// (packages/core/argocd/addon_bootstrap.go). The second half was never a ceiling — the PLATFORM
	// Vault has done exactly this since #2432; it was a scope decision, and the maintainer reversed
	// it. Two OTHER defects were found in the same pass and fixed: the chart's default agent
	// injector rewrites its own webhook CA bundle, which `selfHeal` heals back forever, and that is
	// now off by default.
	//
	// IF THE NEXT `addons` RUN REDS ON addon-vault, READ THE PAIR — the two causes are different
	// work:
	//   health=Progressing  → the bootstrap did not run or did not succeed. That is THIS change,
	//                         and the Job's logs in the vault namespace say why.
	//   Healthy+OutOfSync   → the argo-cd StatefulSet diff class documented at length in
	//                         packages/core/argocd/addons.go. Vault's volumeClaimTemplate carries no
	//                         TypeMeta and no null-valued key, so it is the case that DISCRIMINATES
	//                         between the two co-varying fields that comment could not separate.
	//                         That is #2717's ServerSideDiff lane, not this one.
	// velero is NOT here any more, and the reason it left is worth more than the entry was.
	//
	// The recorded Why said backups need a bucket a customer supplies, and that nothing could
	// reconcile without one — measured health=Missing on run 33124236998. The first half is still
	// true and is a deliberate product decision (a bucket inside the cluster's OpenTofu state is a
	// bucket `tofu destroy` deletes, so Alethia does not create one). The second half was a DEFECT
	// wearing a ceiling's clothes: the catalog emitted no `configuration` block when `bucket` was
	// empty, which left the CHART's default in place — a BackupStorageLocation with a null
	// `provider` and an empty `bucket`. The CRD marks both required, so the API server rejected the
	// document and the whole Application failed to sync. Missing was not "unconfigured"; it was
	// "invalid". The catalog now emits an EMPTY location list, and an unconfigured velero installs,
	// runs, and reports Healthy+Synced — which is the same bar every other add-on here is held to.
	//
	// The cloud-shaped half is closed too, and was never cloud-shaped: aws|gcp|azure are velero's
	// PLUGIN names, not cloud names, and the aws plugin speaks S3 to any store that does. `s3Url` +
	// `s3ForcePathStyle` are now catalog knobs, so hetzner (Object Storage) and alibaba (OSS) have a
	// valid selection.
	//
	// WHAT THIS CELL NOW CLAIMS FOR VELERO, stated so a green run is not read as more: the chart
	// installs, the object-store plugin loads, and the controller converges AT CATALOG DEFAULTS —
	// which means with no backup location. It does not claim a backup completes. No add-on in this
	// dimension claims its own end-to-end function; asserting one would need a bucket and a
	// credential the fixture must not carry.
	// NOT hetzner — MEASURED. Run 33124236998 (hetzner · `addons`, 2026-08-28, the first sweep
	// after #3048) reported `addon-external-dns: health=Healthy sync=Synced`. It escaped the
	// stale-exclusion ratchet only because that run t.Fatal'd at the convergence assertion in
	// t2_provision_test.go — five Applications short, on falco/harbor/kyverno/loki/tempo — and so
	// never reached AssertNoStaleAddOnExclusions below it. See Clouds below.
	// aws was removed from this list on 2026-08-30 by #3428 and is RETRACTED back onto it by #3432.
	// The measurement was never in doubt and is not withdrawn: runs 33262881462, 33277594471 and
	// 33282358378 — distinct SHAs, run_attempt 1 on each — all report
	// `addon-external-dns: health=Healthy sync=Synced` at catalog defaults. What was wrong is what
	// that Healthy was taken to MEAN, and the entry below contradicted itself for one release: it
	// said the controller log.Fatalf's on a provider error and CrashLoops, and ALSO that aws
	// converges because the SDK finds the node role. Both cannot be true of a role that has no DNS
	// permission.
	//
	// Healthy on aws is FAIL-OPEN, and that is the whole finding. external-dns 1.15.0 fatals on a
	// provider CONSTRUCTION error; a per-record Route53 AccessDenied is not one. On EKS the AWS SDK
	// default chain always yields SOME credential through IMDS, so the provider constructs, the pod
	// stays Ready, and ArgoCD reports Healthy while every record write is refused. gcp (403, #2811)
	// and azure (config-file, #2868) fail INSIDE the constructor, so they CrashLoop and read
	// Degraded. The clouds differ in WHERE the failure lands, not in whether the identity is one
	// the cloud can resolve — it is not, on any of them.
	//
	// The IAM chain, read on origin/dev rather than inferred:
	//   · the node role's default policies are {AmazonSSMManagedInstanceCore} and nothing else
	//     (modules/eks/variables.tf:141-147); the ONLY Route53 grant in the module is the IRSA role
	//     (modules/eks/irsa.tf:127-139), trusted for `external-dns:external-dns-sa` and
	//     `cert-manager:cert-manager`.
	//   · AT THE TIME OF THE MEASUREMENT, `workloadIdentity` was empty and `toValues` emitted no
	//     serviceAccount block at all, so the add-on ran under the chart-default SA — a name that
	//     trust policy does not list. #3469 changed the first half and not the second: the fixture
	//     now annotates its own ServiceAccount, `addon-external-dns-sa`, with a stand-in ARN that
	//     names no role. The trust policy lists neither that SA nor that role, so the add-on still
	//     cannot reach a Route53 grant even in principle, and the aws reading below stands.
	//     (`addon-external-dns-sa`, NOT `external-dns-sa`: the platform rail owns that name in this
	//     namespace, and one ServiceAccount under two ArgoCD Applications would have the add-on
	//     rewriting the identity of the controller that serves the environment's DNS.)
	//
	// AND THE TRAP THAT PRODUCED THE WRONG READING: there are TWO external-dns deployments in an
	// addons run, and both are asserted from the same list. The PLATFORM RAIL Application is named
	// `external-dns` and DOES set `serviceAccount.name: external-dns-sa` with the IRSA annotation
	// (infra/templates/argocd/external-dns.yaml:55-59), so on aws it is genuinely wired. The
	// marketplace add-on is `addon-external-dns`, and it is not. Both went Healthy; #3428 read the
	// rail's success onto the add-on. `infra/templates/argocd/external-dns.yaml` had already
	// recorded the true meaning, from aws/gitops run 33095437088: "it is running fine, it simply
	// has no zone to write into."
	//
	// This entry shrinks only when the product turns out to WORK. Inert is not working, so the
	// honest move is back onto the list. Making the add-on actually assume the role the template
	// already creates — and asserting something stronger than Healthy, which is too weak a
	// predicate for this add-on on ANY workload-identity cloud — was tracked in #3470, which CLOSED
	// as completed on 2026-08-31 (#3523 gave the add-on its own ServiceAccount and identity, #3554
	// made a missing one fail closed). The product half, which is what a customer hits, is #3469 and
	// is also closed: a workload-identity provider with no identity is refused at configure time
	// rather than installed inert.
	//
	// SO WHAT KEEPS THE ENTRY. Not "no knob" any more — that reason is dead. The fixture carries a
	// STAND-IN identity that exists in no account (see the Why below), and supplying a real one is a
	// customer action. What remains is a paid run per cloud, which is #3524.
	//
	// ⚠️ THE NOTE #3470 WAS CLOSED ON, kept because the constraint it records still binds anyone
	// touching this. It cannot be done by pointing the add-on at the platform role as it stands. That
	// role's trust is bound to `external-dns:external-dns-sa` (aws irsa.tf:139, and the GKE member /
	// Azure federated subject are bound to the same name), which is the RAIL's ServiceAccount; the
	// add-on now runs as `addon-external-dns-sa` precisely so it cannot take that object over. The
	// binding has to gain the add-on's name — on all three clouds in one pass — or the add-on needs
	// a role of its own.
	"external-dns": {
		Kind: NeedsUserConfig,
		Why: "the fixture cannot supply a credential that EXISTS, on any of these clouds. " +
			"#3048 repointed it at each cloud's NATIVE provider (aws→aws, gcp→google, azure→azure) " +
			"so the old reason — `provider=cloudflare` everywhere — is dead, and #2777 added the " +
			"`workloadIdentity` knob the old reason said the schema lacked. " +
			"#3469 then made that knob REQUIRED on a provider that authenticates by annotation, " +
			"because an empty one installs an add-on that is Healthy-and-inert on aws — so the " +
			"fixture no longer leaves it empty (it could not: the config would be refused). It " +
			"carries a STAND-IN identity instead — `EXTERNAL_DNS_FIXTURE_IDENTITY` in " +
			"apps/console/lib/addons/catalog-export.ts — an ARN / GSA email / client id in the " +
			"right syntax that exists in NO account. That buys the annotation SHAPE and nothing " +
			"else: the controller still cannot write a record, because supplying a REAL identity " +
			"(or a provider API token, which `secretValues` has no ref for either) is a CUSTOMER " +
			"action. alibaba is a fourth case with the same cause in a different shape: " +
			"EXTERNAL_DNS_NATIVE_PROVIDER has no entry for it, so its fixture still carries " +
			"provider=cloudflare with no token. gcp/azure/alibaba remain UNVERIFIED since #3048, " +
			"and aws is verified INERT rather than unverified — see the retraction above, which " +
			"is why Healthy must not be asserted for it. Making the add-on assume a real identity, " +
			"and asserting something stronger than Healthy, was #3470 — closed completed on " +
			"2026-08-31 by #3523/#3554. What is left is a paid run per cloud, which is #3524.",
		// #3524, NOT #2717. #2717 is the run that MEASURED the 11-of-22 surface and it closed on
		// 2026-08-29; this field's contract is that it names something OPEN, because an exclusion
		// whose tracker is closed has nothing left to make it come off the list. #3524 is the ledger
		// entry for taking this exclusion out, and it stays open until a paid `addons` run is green
		// on the cloud whose row is being removed.
		//
		// The prose above the field said exactly this for six days while the value disagreed with it,
		// which is why scripts/check-exclusion-issues.mjs now asks GitHub rather than only asking the
		// regex: addon_exclusions_pure_test.go checks the SHAPE `^#\d+$`, and shape is not state.
		Issue:  "#3524",
		Clouds: []string{"aws", "gcp", "azure", "alibaba"},
		// aws ONLY. gcp and azure fail inside the provider constructor and read Degraded, so their
		// Healthy would be real evidence and the ratchet must keep firing there.
		HealthFailsOpenOn: map[string]string{
			"aws": "external-dns 1.15.0 fatals on a provider CONSTRUCTION error, not on a " +
				"per-record write refusal. On EKS the AWS SDK default chain always yields a " +
				"credential through IMDS, so the provider constructs and the pod stays Ready while " +
				"every Route53 write is denied — Healthy here means \"running, writing nothing\", " +
				"which infra/templates/argocd/external-dns.yaml already recorded from aws/gitops " +
				"run 33095437088. The stronger predicate this owes — that the ServiceAccount " +
				"carries the IRSA annotation — was #3470, closed completed on 2026-08-31; the " +
				"remaining step is the paid aws `addons` run tracked by #3524.",
		},
	},
}

// excludedAddOnAppNames maps ArgoCD Application name → exclusion FOR ONE CLOUD, derived through
// argocd.AddOnAppName so this file can never disagree with the renderer about what an add-on's
// Application is called.
//
// An entry whose Clouds list does not name this cloud is simply absent from the result, which is
// what makes it asserted: every consumer below decides by presence in this map.
func excludedAddOnAppNames(cloud string) map[string]AddOnExclusion {
	out := make(map[string]AddOnExclusion, len(addOnExclusions))
	for id, e := range addOnExclusions {
		if !e.appliesTo(cloud) {
			continue
		}
		out[argocd.AddOnAppName(id)] = e
	}
	return out
}

// allAddOnExclusionsByAppName is addOnExclusions keyed by ArgoCD Application name and UNFILTERED by
// cloud — the input staleExclusions narrows itself, so that the cloud is named exactly once at the
// call site and cannot disagree with the map it arrived beside. Every other consumer wants
// excludedAddOnAppNames, which decides by PRESENCE and must stay per-cloud.
func allAddOnExclusionsByAppName() map[string]AddOnExclusion {
	out := make(map[string]AddOnExclusion, len(addOnExclusions))
	for id, e := range addOnExclusions {
		out[argocd.AddOnAppName(id)] = e
	}
	return out
}

// appliesTo reports whether this exclusion holds on `cloud`. An empty Clouds list means every
// cloud — the common case, and the one vault and velero use.
func (e AddOnExclusion) appliesTo(cloud string) bool {
	if len(e.Clouds) == 0 {
		return true
	}
	for _, c := range e.Clouds {
		if c == cloud {
			return true
		}
	}
	return false
}

// PartitionExcludedAddOns splits a derived expected-Application set into the ones whose health is
// ASSERTED and the ones WITHHELD by an exclusion.
//
// Call it AFTER RequireAllAddOnsExpected, never before: that guard's whole job is to prove the
// derived set still covers the catalog, and handing it a pre-filtered set would make it agree with
// a set that had already dropped the very add-ons it exists to count.
// The split is PER CLOUD (#3048 made the fixture per cloud and the truth followed it): an add-on
// withheld on aws may be asserted on hetzner, and passing the wrong cloud here would assert an
// add-on that cannot converge or withhold one that already does.
func PartitionExcludedAddOns(cloud string, expected []string) (asserted, withheld []string) {
	ex := excludedAddOnAppNames(cloud)
	for _, name := range expected {
		if _, isExcluded := ex[name]; isExcluded {
			withheld = append(withheld, name)
			continue
		}
		asserted = append(asserted, name)
	}
	sort.Strings(withheld)
	return asserted, withheld
}

// DescribeWithheldAddOns renders the withheld set for the run log, so a reader of a GREEN run can
// see exactly what it did not assert. A verdict whose exclusions are invisible reads as a wider
// claim than it is.
func DescribeWithheldAddOns(cloud string, withheld []string) string {
	if len(withheld) == 0 {
		return "no add-ons withheld: every catalog add-on's health is asserted"
	}
	ex := excludedAddOnAppNames(cloud)
	var b strings.Builder
	fmt.Fprintf(&b, "%d add-on(s) WITHHELD from the health assertion (installed and observed, but not required to converge):", len(withheld))
	for _, name := range withheld {
		e := ex[name]
		fmt.Fprintf(&b, "\n  - %s [%s] %s — %s", name, e.Kind, e.Issue, e.Why)
	}
	return b.String()
}

// AssertNoStaleAddOnExclusions fails when a WITHHELD add-on is actually Healthy+Synced.
//
// A single read, not a poll: staleness does not resolve by waiting, and spending the ArgoCD budget
// re-asking would cost a real run up to twenty minutes to learn something the first answer already
// gave. Run it after the health assertion has passed, when the cluster has settled.
//
// Red on purpose. An add-on that has started converging must come OFF this list — otherwise the
// list grows monotonically and the dimension quietly asserts less every release.
func AssertNoStaleAddOnExclusions(ctx context.Context, kubeconfigPath, cloud string, withheld []string) error {
	if len(withheld) == 0 {
		return nil
	}
	raw, err := kubectlGetArgoApps(ctx, kubeconfigPath)
	if err != nil {
		// Fail-closed: an unreadable cluster is not evidence that every exclusion is still needed.
		return fmt.Errorf("stale-exclusion check could not list ArgoCD Applications, so no exclusion could be re-validated: %w", err)
	}
	observed, err := parseArgoApps(raw)
	if err != nil {
		return fmt.Errorf("stale-exclusion check could not parse ArgoCD Applications: %w", err)
	}
	stale, abstained := staleExclusions(observed, allAddOnExclusionsByAppName(), cloud, withheld)
	// Reported BEFORE the verdict and regardless of it: an abstention means this run did not
	// re-validate that exclusion at all, which the reader must be told whether or not anything
	// else was stale.
	if len(abstained) > 0 {
		sort.Strings(abstained)
		// The `argocd assert: ` prefix is LOAD-BEARING, not decoration. demos/proofs/capture-proof.sh
		// builds the committed bundle's assertions.txt from a fixed alternation, and an abstention
		// that matches none of its branches survives only in the 30-day CI log: the DURABLE artifact
		// then reads exactly like a run where nothing abstained. That is this check's own thesis
		// — "nothing found" must not render as "nothing wrong" — failing on the one file that
		// outlives the run. capture-proof.sh's self-test #5 pins the same defect for the #3418
		// vacuous-overwrite refusal, which was dropped this exact way.
		fmt.Fprintf(os.Stderr,
			"argocd assert: stale-exclusion check ABSTAINED on %d add-on(s) that are Healthy+Synced — their health is fail-open, so it is not evidence they work:\n  - %s\n",
			len(abstained), strings.Join(abstained, "\n  - "))
	}
	if len(stale) == 0 {
		return nil
	}
	sort.Strings(stale)
	return fmt.Errorf(
		"%d add-on(s) are recorded as unable to converge at catalog defaults, but reached Healthy+Synced in this run:\n  - %s\n"+
			"Remove them from addOnExclusions and close the issue: an exclusion left standing after the thing works understates the product, "+
			"and every run after this one would assert less than it could",
		len(stale), strings.Join(stale, "\n  - "))
}

// staleExclusions is the DECISION, split out so it can be tested without a cluster.
//
// Only Healthy AND Synced counts as "this works now". A chart that is Healthy but OutOfSync is
// exactly the spurious-diff class the Application template's ignoreDifferences handles, and a
// Progressing one may simply not have finished — neither is evidence the exclusion is wrong, and
// treating either as stale would red a run for the opposite of the reason this check exists.
// The Healthy+Synced hits are split rather than filtered, in ONE traversal, so the two lists cannot
// disagree about what was observed: every hit lands in exactly one of them, and an entry declaring
// HealthFailsOpen is abstained on rather than dropped.
// The exclusion map is a PARAMETER rather than re-derived from the cloud, so both verdicts can be
// driven from a synthetic map: with only one real entry left in addOnExclusions, and that one
// declaring HealthFailsOpen, there is otherwise no way to exercise the stale arm and the abstain arm
// against each other — and a check whose firing arm is untestable is a check that reports green.
//
// It takes the UNFILTERED map and narrows it here, rather than an already-narrowed one beside the
// cloud that narrowed it. Those were two parameters that had to agree and nothing made them: `cloud`
// was used for exactly one thing, the healthFailsOpenOn lookup, so a caller pairing a gcp-filtered
// map with "aws" got a wrong verdict SILENTLY — no test could see it, because both arguments were
// well-formed. The concrete failure that shape invites is the one this field exists to prevent:
// copy the aws call site into a gcp/azure loop, forget to change the third argument, and gcp
// ABSTAINS on a Healthy external-dns instead of reporting it stale — the ratchet switched off on a
// cloud where Healthy is real evidence. Now the cloud is named once and decides both questions.
func staleExclusions(observed map[string]argoAppState, all map[string]AddOnExclusion, cloud string, withheld []string) (stale, abstained []string) {
	for _, name := range withheld {
		e, isExcluded := all[name]
		// Not excluded on THIS cloud is not a verdict. A name that reaches here without an entry
		// that applies is a caller bug (withheld is derived from the same cloud), and inventing a
		// stale verdict from a zero-value entry would red a run citing an empty issue and reason.
		if !isExcluded || !e.appliesTo(cloud) {
			continue
		}
		st, ok := observed[name]
		if !ok {
			// Absent is not working. A withheld add-on that never rendered an Application says
			// nothing about whether its exclusion is still needed.
			continue
		}
		if st.Health != "Healthy" || st.Sync != "Synced" {
			continue
		}
		if reason := e.healthFailsOpenOn(cloud); reason != "" {
			abstained = append(abstained, fmt.Sprintf("%s (%s, health is fail-open here: %s)", name, e.Issue, reason))
			continue
		}
		stale = append(stale, fmt.Sprintf("%s (%s, recorded as: %s)", name, e.Issue, e.Why))
	}
	return stale, abstained
}
