// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// FREE, every-PR proof that the add-on exclusion list stays honest — no cloud, no build tag.
//
// The list narrows what the `addons` dimension asserts, so it is exactly the kind of thing that
// decays into a place to put inconvenient failures. These tests are the cost of having one.
package e2e

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

var exclusionIssueRe = regexp.MustCompile(`^#\d+$`)

// TestAddOnExclusionsAreRealCatalogAddOns is the anti-inertness check.
//
// An exclusion keyed on an add-on the catalog does not have excludes NOTHING: the id never matches
// a rendered Application, so the entry sits there reading like a documented decision while the
// dimension goes on asserting the chart. A rename is all it takes. That failure is invisible in
// every other test, so it is pinned here.
func TestAddOnExclusionsAreRealCatalogAddOns(t *testing.T) {
	catalog, err := AllCatalogAddOns()
	if err != nil {
		t.Fatalf("catalog fixture unreadable, so no exclusion can be validated: %v", err)
	}
	known := make(map[string]struct{}, len(catalog))
	for _, a := range catalog {
		known[a.ID] = struct{}{}
	}
	for id := range addOnExclusions {
		if _, ok := known[id]; !ok {
			t.Errorf("addOnExclusions has an entry for %q, which is not in the add-on catalog — "+
				"it excludes nothing and the dimension still asserts every chart. Renamed, or a typo?", id)
		}
	}
}

// TestAddOnExclusionsAreLegible enforces the property that makes an exclusion reviewable:
// a reason a human can act on, and an issue so it cannot become permanent by being forgotten.
func TestAddOnExclusionsAreLegible(t *testing.T) {
	for id, e := range addOnExclusions {
		t.Run(id, func(t *testing.T) {
			if e.Kind != NeedsUserConfig {
				t.Errorf("kind %q is not a known AddOnExclusionKind — add the constant with its "+
					"own doc comment rather than inventing a string here", e.Kind)
			}
			// A one-word "why" is the shape a placeholder takes.
			if len(strings.TrimSpace(e.Why)) < 60 {
				t.Errorf("Why is %d chars; it must say what a CUSTOMER would have to supply, in "+
					"enough detail to re-decide the exclusion without re-deriving it", len(e.Why))
			}
			if !exclusionIssueRe.MatchString(e.Issue) {
				t.Errorf("Issue = %q, want a tracking issue like #2717 — an exclusion with no issue "+
					"becomes permanent by default", e.Issue)
			}
			for cloud, reason := range e.HealthFailsOpenOn {
				// A reason naming a cloud this exclusion does not apply to is DEAD CONFIG that
				// reads as protection: nothing is withheld there, so nothing can ever abstain, and
				// a reader checking "is the ratchet still covering gcp?" gets the wrong answer from
				// the entry itself.
				if !e.appliesTo(cloud) {
					t.Errorf("HealthFailsOpenOn names %q, but this exclusion does not apply to that "+
						"cloud — nothing is withheld there, so the entry can never abstain and the "+
						"reason is unreachable", cloud)
				}
				// Switching the ratchet off is the one thing in this file that REDUCES what a run
				// checks, so its justification is held to a higher bar than Why's, not a lower one.
				if len(strings.TrimSpace(reason)) < 80 {
					t.Errorf("HealthFailsOpenOn[%q] is %d chars; it must say what the add-on does "+
						"while reporting Healthy, and why that is not evidence it works", cloud, len(reason))
				}
			}
		})
	}
}

// TestPartitionExcludedAddOnsLosesNothing pins the property that matters most: partitioning is a
// SPLIT, not a filter. An add-on that fell out of both halves would be silently unasserted, which
// is the failure this whole mechanism is supposed to make impossible.
func TestPartitionExcludedAddOnsLosesNothing(t *testing.T) {
	expected := []string{
		"apps",
		argocd.AddOnAppName("vault"),
		argocd.AddOnAppName("kyverno"),
		argocd.AddOnAppName("velero"),
		argocd.AddOnAppName("loki"),
		argocd.AddOnAppName("external-dns"),
	}
	// DERIVED, not hardcoded. This test was written against "aws", where every remaining exclusion
	// applied — and then external-dns was measured Healthy+Synced on aws three times and aws came
	// off its Clouds list, which broke a test about the partition MECHANISM for a reason that had
	// nothing to do with the mechanism. Asking the entry which cloud it claims keeps this pinned to
	// the machinery instead of to one cloud's current facts.
	cloud := aCloudClaimedBy(t, "external-dns")
	asserted, withheld := PartitionExcludedAddOns(cloud, expected)
	if got, want := len(asserted)+len(withheld), len(expected); got != want {
		t.Fatalf("partition returned %d names for %d inputs — the split dropped or duplicated one", got, want)
	}
	seen := map[string]int{}
	for _, n := range append(append([]string{}, asserted...), withheld...) {
		seen[n]++
	}
	for _, n := range expected {
		if seen[n] != 1 {
			t.Errorf("%q appears %d times across the two halves, want exactly 1", n, seen[n])
		}
	}
	for _, n := range []string{argocd.AddOnAppName("external-dns")} {
		if !contains(withheld, n) {
			t.Errorf("%q is in addOnExclusions but was not withheld", n)
		}
	}
	// A non-excluded add-on and the repo app-of-apps must still be asserted, or the exclusion
	// mechanism would be quietly withholding the whole surface. vault and velero are deliberately
	// in this half: both exclusions came off in the same pass — velero's when the catalog stopped
	// rendering an invalid BackupStorageLocation at defaults, vault's when the runner gained the
	// init/unseal bootstrap — and these are the lines that would notice either creeping back.
	for _, n := range []string{
		"apps",
		argocd.AddOnAppName("kyverno"),
		argocd.AddOnAppName("loki"),
		argocd.AddOnAppName("velero"),
		argocd.AddOnAppName("vault"),
	} {
		if !contains(asserted, n) {
			t.Errorf("%q carries no exclusion but was not asserted", n)
		}
	}
}

// TestStaleExclusionsOnlyFireOnHealthyAndSynced varies the OBSERVED STATE, which is the axis that
// decides the verdict — a test that only varied which add-on was withheld would pass against a
// check that fired on any state at all.
//
// The exclusion map is SYNTHETIC. It used to be the real one with external-dns as its subject, but
// external-dns now declares HealthFailsOpen (#3432), so driving the real map would exercise only the
// abstain arm and the stale arm would silently stop being tested.
func TestStaleExclusionsOnlyFireOnHealthyAndSynced(t *testing.T) {
	app := argocd.AddOnAppName("external-dns")
	withheld := []string{app}
	ex := map[string]AddOnExclusion{app: {Kind: NeedsUserConfig, Why: "a customer must supply a token", Issue: "#1"}}
	cases := []struct {
		name      string
		state     argoAppState
		wantStale bool
	}{
		{"healthy and synced is the thing working", argoAppState{Health: "Healthy", Sync: "Synced"}, true},
		{"healthy but OutOfSync is the spurious-diff class", argoAppState{Health: "Healthy", Sync: "OutOfSync"}, false},
		{"progressing has not finished", argoAppState{Health: "Progressing", Sync: "Synced"}, false},
		{"degraded is the exclusion being right", argoAppState{Health: "Degraded", Sync: "Synced"}, false},
		{"missing says nothing either way", argoAppState{Health: "Missing", Sync: "OutOfSync"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, abstained := staleExclusions(map[string]argoAppState{app: tc.state}, ex, "aws", withheld)
			if gotStale := len(got) > 0; gotStale != tc.wantStale {
				t.Errorf("health=%s sync=%s: stale=%v, want %v (%v)",
					tc.state.Health, tc.state.Sync, gotStale, tc.wantStale, got)
			}
			if len(abstained) != 0 {
				t.Errorf("an exclusion with no HealthFailsOpen was abstained on: %v", abstained)
			}
		})
	}
	// An app absent from the cluster entirely is not evidence of anything.
	if got, _ := staleExclusions(map[string]argoAppState{}, ex, "aws", withheld); len(got) != 0 {
		t.Errorf("an absent Application was reported stale: %v", got)
	}
	// And the message must name the add-on, or a red run cannot be acted on.
	got, _ := staleExclusions(map[string]argoAppState{app: {Health: "Healthy", Sync: "Synced"}}, ex, "aws", withheld)
	if len(got) != 1 || !strings.Contains(got[0], app) {
		t.Errorf("stale entry %v does not name %q", got, app)
	}
}

// TestHealthFailsOpenAbstainsInsteadOfCallingItStale drives BOTH arms against each other in one
// observation, because the risk the field introduces is that it swallows the ratchet: an
// implementation that abstained on everything would pass a test that only checked the fail-open
// entry, and one that ignored the field would pass a test that only checked the normal entry.
func TestHealthFailsOpenAbstainsInsteadOfCallingItStale(t *testing.T) {
	failOpen := argocd.AddOnAppName("external-dns")
	normal := argocd.AddOnAppName("velero")
	ex := map[string]AddOnExclusion{
		failOpen: {Kind: NeedsUserConfig, Why: "no identity", Issue: "#2717", HealthFailsOpenOn: map[string]string{"aws": "Healthy means running, writing nothing"}},
		normal:   {Kind: NeedsUserConfig, Why: "a customer must supply a bucket", Issue: "#2"},
	}
	healthy := argoAppState{Health: "Healthy", Sync: "Synced"}
	observed := map[string]argoAppState{failOpen: healthy, normal: healthy}

	stale, abstained := staleExclusions(observed, ex, "aws", []string{failOpen, normal})

	if len(stale) != 1 || !strings.Contains(stale[0], normal) {
		t.Errorf("stale = %v, want exactly the entry WITHOUT HealthFailsOpen (%s)", stale, normal)
	}
	for _, s := range stale {
		if strings.Contains(s, failOpen) {
			t.Errorf("%q was called stale despite declaring HealthFailsOpen — the ratchet would red the run #3432 exists to stop", failOpen)
		}
	}
	if len(abstained) != 1 || !strings.Contains(abstained[0], failOpen) {
		t.Fatalf("abstained = %v, want exactly the entry WITH HealthFailsOpen (%s)", abstained, failOpen)
	}
	// The abstention has to carry its reason and its issue, or it reads as "nothing found" — which
	// is the one rendering a silently-neutered ratchet must never share with "nothing wrong".
	for _, want := range []string{"#2717", "writing nothing"} {
		if !strings.Contains(abstained[0], want) {
			t.Errorf("abstention %q does not carry %q", abstained[0], want)
		}
	}
	// A fail-open entry that is NOT Healthy+Synced is not an abstention either — there was nothing
	// to abstain from.
	if _, ab := staleExclusions(map[string]argoAppState{failOpen: {Health: "Degraded", Sync: "Synced"}}, ex, "aws", []string{failOpen}); len(ab) != 0 {
		t.Errorf("abstained over a Degraded add-on: %v — abstention must mark a hit that was NOT acted on", ab)
	}
}

// TestDescribeWithheldAddOnsIsNotVacuous — a green run must be able to show what it did not assert.
// The empty case has to read differently from the populated one, or "nothing withheld" and
// "withheld, undisclosed" look identical in the log.
func TestDescribeWithheldAddOnsIsNotVacuous(t *testing.T) {
	cloud := aCloudClaimedBy(t, "external-dns")
	empty := DescribeWithheldAddOns(cloud, nil)
	if !strings.Contains(empty, "no add-ons withheld") {
		t.Errorf("empty description = %q, want it to state plainly that nothing was withheld", empty)
	}
	app := argocd.AddOnAppName("external-dns")
	got := DescribeWithheldAddOns(cloud, []string{app})
	// The issue is READ FROM THE ENTRY, not restated. It was hardcoded "#2717" here, so this
	// assertion and the entry agreed with each other about a number that had been closed since
	// 2026-08-29 — the same drift, in a second place, and pinning the literal is what made the
	// second place possible.
	//
	// BUT DE-HARDCODING IT ALONE MADE THE ASSERTION VACUOUS, which is worse than the drift. `Why`
	// now ends "…which is #3524", and DescribeWithheldAddOns prints Kind, Issue AND Why — so a bare
	// `Contains(got, "#3524")` is satisfied by the Why text, and deleting `e.Issue` from the format
	// string entirely would leave this test green. With the old literal the number could only have
	// arrived via `e.Issue`, so the check was real; the fix traded one drift for a dead assertion.
	//
	// So it asserts the RENDERED PREFIX — `[kind] issue — ` — which only `e.Issue` can supply, in
	// that position, next to that kind. That is what the test claims to prove.
	ex := addOnExclusions["external-dns"]
	if ex.Issue == "" {
		t.Fatal("the external-dns exclusion records no Issue — this test would assert nothing")
	}
	wantRendered := fmt.Sprintf("[%s] %s — ", NeedsUserConfig, ex.Issue)
	if !strings.Contains(got, wantRendered) {
		t.Errorf("description does not render the entry's own Issue beside its Kind (%q):\n%s", wantRendered, got)
	}
	for _, want := range []string{app, string(NeedsUserConfig), "CUSTOMER action"} {
		if !strings.Contains(got, want) {
			t.Errorf("description does not mention %q:\n%s", want, got)
		}
	}
	if got == empty {
		t.Error("a populated description is identical to the empty one")
	}
}

// TestNoWithheldAddOnsSkipsTheClusterRead pins the short-circuit. With nothing withheld the check
// must return before it ever reaches kubectl — otherwise every floor run (which withholds nothing)
// would pay for a cluster read to learn there was nothing to re-validate. Passing a deliberately
// unusable kubeconfig path proves it never got that far.
func TestNoWithheldAddOnsSkipsTheClusterRead(t *testing.T) {
	if err := AssertNoStaleAddOnExclusions(t.Context(), "/nonexistent/kubeconfig", "aws", nil); err != nil {
		t.Errorf("empty withheld set must be a no-op, got: %v", err)
	}
}

// TestExclusionCloudsAreRealFixtureClouds is the anti-typo check for the per-cloud dimension.
//
// `Clouds: []string{"hetzer"}` is a positive list, so a typo does not fail loudly — it silently
// narrows the exclusion to a cloud that never runs, and every real cloud starts asserting an
// add-on nobody decided to assert. Pinning each name against the generated fixture that must exist
// for that cloud to run at all is the cheapest thing that cannot be fooled by a plausible spelling.
func TestExclusionCloudsAreRealFixtureClouds(t *testing.T) {
	for id, e := range addOnExclusions {
		for _, cloud := range e.Clouds {
			path := filepath.Join("fixtures", "addon_catalog."+cloud+".json")
			if _, err := os.Stat(path); err != nil {
				t.Errorf("addOnExclusions[%q].Clouds names %q, which has no add-on fixture (%s): "+
					"a cloud that cannot be run cannot be excluded, and the other clouds now "+
					"assert this add-on. Typo?", id, cloud, path)
			}
		}
		// The SAME anti-typo question for the fail-open keys, and it has to be asked here rather
		// than left to the appliesTo check in TestAddOnExclusionsAreLegible. That check is VACUOUS
		// for an unscoped entry: appliesTo returns true for ANY string when Clouds is empty — the
		// documented "empty means every cloud" — so it can only ever fire on an entry that already
		// carries an explicit Clouds list. It happens to cover external-dns today and covers
		// nothing on the next unscoped one.
		//
		// Concrete: an entry with Clouds nil declaring HealthFailsOpenOn{"awz": …} passes appliesTo
		// and reads as protected. At runtime staleExclusions looks up "aws", gets "", and reds a
		// real aws run for a stale exclusion — the exact opposite of what the field was written
		// for, discovered only by burning a cloud run. Stat-ing the fixture closes both the
		// unreachable-key case and the plausible-spelling case; appliesTo alone closes neither.
		for cloud := range e.HealthFailsOpenOn {
			path := filepath.Join("fixtures", "addon_catalog."+cloud+".json")
			if _, err := os.Stat(path); err != nil {
				t.Errorf("addOnExclusions[%q].HealthFailsOpenOn names %q, which has no add-on "+
					"fixture (%s): the key can never be looked up, so the ratchet still fires on "+
					"the cloud the author meant to make it abstain on. Typo?", id, cloud, path)
			}
		}
	}
}

// TestExternalDnsExclusionIsPerCloud pins the MEASURED fact that made the Clouds dimension
// necessary, on the axis that decides it — the CLOUD, not the add-on.
//
// Run 33124236998 (hetzner · `addons`, the first sweep after #3048 repointed the fixture at each
// cloud's native provider) reported `addon-external-dns: health=Healthy sync=Synced`. It reached
// the cluster and converged. Withholding it there would red that run for a STALE EXCLUSION, which
// is the ratchet firing on a true statement — so hetzner must ASSERT it.
//
// AWS WAS REMOVED on 2026-08-30 by #3428 and RETRACTED back on the same day by #3432. The pressure
// that produced the wrong fix is worth keeping, because it will recur: run 33282358378 FAILED for
// the stale exclusion ALONE, after its convergence and its teardown both passed. The ratchet reds on
// Healthy, so there were exactly two exits — take the exclusion off, or teach the ratchet that
// Healthy is fail-open for this add-on. #3428 took the first and asserted a green that means
// "running, writing nothing": the add-on had no serviceAccount block at all with `workloadIdentity`
// empty, the node role carries only AmazonSSMManagedInstanceCore, and the sole Route53 grant is an
// IRSA role trusted for a service-account name the add-on does not use. (#3469 has since made the
// identity REQUIRED, so the fixture annotates `addon-external-dns-sa` with a stand-in ARN naming no
// role — the reading is unchanged: no Route53 grant, still inert.) The PLATFORM RAIL
// Application — `external-dns`, asserted in the same run — IS wired that way, and that is what was
// actually observed working.
//
// So aws now WITHHOLDS it and the ratchet ABSTAINS there rather than firing. gcp and azure fail
// inside the provider constructor and read Degraded; alibaba still carries provider=cloudflare.
// hetzner is the one cloud that genuinely asserts it.
//
// A test that only varied the add-on would pass against a global list and prove nothing.
func TestExternalDnsExclusionIsPerCloud(t *testing.T) {
	app := argocd.AddOnAppName("external-dns")
	expected := []string{app, argocd.AddOnAppName("kyverno")}

	// hetzner came off the exclusion by MEASUREMENT, named with the run that took it off, because
	// "it works now" without a run id is the shape this whole file refuses.
	t.Run("hetzner asserts it — measured Healthy+Synced on run 33124236998", func(t *testing.T) {
		asserted, withheld := PartitionExcludedAddOns("hetzner", expected)
		if contains(withheld, app) {
			t.Errorf("%s is withheld on hetzner, where it was measured Healthy+Synced (run 33124236998) — "+
				"the stale-exclusion ratchet will red the next addons run", app)
		}
		if !contains(asserted, app) {
			t.Errorf("%s is neither asserted nor withheld on hetzner", app)
		}
		// And the ratchet must NOT fire there: a cloud that asserts an add-on never withholds it,
		// so a Healthy+Synced reading is a pass, not a stale exclusion.
		observed := map[string]argoAppState{app: {Health: "Healthy", Sync: "Synced"}}
		stale, _ := staleExclusions(observed, allAddOnExclusionsByAppName(), "hetzner", withheld)
		if len(stale) != 0 {
			t.Errorf("hetzner reported a stale exclusion for an add-on it asserts: %v", stale)
		}
	})

	for _, cloud := range []string{"aws", "gcp", "azure", "alibaba"} {
		t.Run(cloud+" still withholds it", func(t *testing.T) {
			_, withheld := PartitionExcludedAddOns(cloud, expected)
			if !contains(withheld, app) {
				t.Errorf("%s is asserted on %s, where nothing fills the identity the controller "+
					"needs — asserting it there bets a real run on a convergence that is either "+
					"unmeasured (gcp/azure/alibaba) or measured INERT (aws)", app, cloud)
			}
		})
	}

	// aws is the fail-open cloud and gets its own case, because it is the one where a Healthy
	// reading is REAL and must still not take the exclusion off. Pinning it here is what stops
	// #3428 from being re-derived by the next reader who sees the ratchet red.
	t.Run("aws abstains rather than reporting it stale", func(t *testing.T) {
		_, withheld := PartitionExcludedAddOns("aws", expected)
		observed := map[string]argoAppState{app: {Health: "Healthy", Sync: "Synced"}}
		stale, abstained := staleExclusions(observed, allAddOnExclusionsByAppName(), "aws", withheld)
		if len(stale) != 0 {
			t.Errorf("aws reported %s stale on the Healthy+Synced that #3432 established means "+
				"'running, writing nothing': %v", app, stale)
		}
		if len(abstained) != 1 || !strings.Contains(abstained[0], app) {
			t.Fatalf("aws did not ABSTAIN on %s (%v) — a silent pass and a reasoned abstention "+
				"must not render the same", app, abstained)
		}
	})

	// The ratchet must still fire on the clouds whose Healthy would be REAL evidence, or the
	// exclusion could never come off for them.
	for _, cloud := range []string{"gcp", "azure", "alibaba"} {
		t.Run(cloud+" still reports it stale if it converges", func(t *testing.T) {
			_, withheld := PartitionExcludedAddOns(cloud, expected)
			observed := map[string]argoAppState{app: {Health: "Healthy", Sync: "Synced"}}
			stale, _ := staleExclusions(observed, allAddOnExclusionsByAppName(), cloud, withheld)
			if len(stale) != 1 {
				t.Errorf("%s: a withheld add-on that reached Healthy+Synced was not reported "+
					"stale (got %v) — the exclusion could then never come off", cloud, stale)
			}
		})
	}
}

// TestStaleExclusionsNarrowsByTheCloudItWasGiven pins the property that replaced a pair of
// parameters which had to agree and nothing made them (#3472 review).
//
// staleExclusions used to take an ALREADY cloud-filtered map beside the cloud, and used the cloud
// for exactly one thing: the healthFailsOpenOn lookup. A caller pairing a gcp-filtered map with
// "aws" got a wrong verdict silently — both arguments were well-formed, so no test could see it,
// and the concrete failure it invited is the one HealthFailsOpenOn exists to prevent: copy the aws
// call site into a gcp loop, forget the third argument, and gcp ABSTAINS on a Healthy external-dns
// instead of reporting it stale.
//
// It now takes the UNFILTERED map and narrows it itself, so the cloud decides BOTH questions. This
// test is what makes that narrowing more than a defensive line: an entry scoped away from the cloud
// under test must produce neither verdict, even when the add-on is Healthy+Synced and the caller
// wrongly listed it as withheld.
func TestStaleExclusionsNarrowsByTheCloudItWasGiven(t *testing.T) {
	const app = "addon-elsewhere"
	all := map[string]AddOnExclusion{
		app: {
			Kind:   NeedsUserConfig,
			Why:    "scoped to gcp only, so on any other cloud this entry withholds nothing at all",
			Issue:  "#2717",
			Clouds: []string{"gcp"},
			HealthFailsOpenOn: map[string]string{
				"gcp": "would abstain on gcp, and must not leak that abstention onto a cloud this entry does not apply to",
			},
		},
	}
	observed := map[string]argoAppState{app: {Health: "Healthy", Sync: "Synced"}}

	stale, abstained := staleExclusions(observed, all, "aws", []string{app})
	if len(stale) != 0 {
		t.Errorf("an exclusion scoped to gcp produced a STALE verdict on aws (%v) — it withholds "+
			"nothing there, so it has nothing to be stale about, and the message would cite an "+
			"entry the reader cannot find for that cloud", stale)
	}
	if len(abstained) != 0 {
		t.Errorf("an exclusion scoped to gcp ABSTAINED on aws (%v) — that is the ratchet switching "+
			"itself off on a cloud the entry never applied to, which is exactly the un-keyed "+
			"fail-open this field was keyed by cloud to prevent", abstained)
	}

	// The positive control, without which the two assertions above pass for a function that always
	// returns nothing: the SAME entry and the SAME reading must abstain on the cloud it does name.
	if _, ab := staleExclusions(observed, all, "gcp", []string{app}); len(ab) != 1 {
		t.Fatalf("the same entry did not abstain on gcp, the cloud it is scoped to (%v) — the "+
			"narrowing above is then indistinguishable from a function that decides nothing", ab)
	}
}

// TestUnscopedExclusionsApplyToEveryCloud — an EMPTY Clouds list must keep meaning "everywhere".
// If it ever came to mean "nowhere", every unscoped exclusion would silently stop being withheld
// and every cloud would start asserting a chart nobody decided to assert.
//
// It tests `appliesTo` directly rather than through the map, because as of vault's and velero's
// removal there is no unscoped ENTRY left to test through. A test that quietly became vacuous when
// its only subject was deleted is the "found nothing / nothing is wrong" shape this repo keeps
// paying for — so the property is pinned on the predicate, which cannot be emptied out from under
// it, and the map's own scoping stays covered by TestExternalDnsExclusionIsPerCloud.
func TestUnscopedExclusionsApplyToEveryCloud(t *testing.T) {
	unscoped := AddOnExclusion{Kind: NeedsUserConfig, Why: "a synthetic entry", Issue: "#2717"}
	scoped := AddOnExclusion{Kind: NeedsUserConfig, Why: "a synthetic entry", Issue: "#2717", Clouds: []string{"aws"}}
	for _, cloud := range []string{"aws", "gcp", "azure", "alibaba", "hetzner"} {
		if !unscoped.appliesTo(cloud) {
			t.Errorf("an exclusion naming no clouds does not apply to %s, but an empty list means "+
				"every cloud", cloud)
		}
	}
	// And the other direction, or the test would pass against an appliesTo that returned true
	// unconditionally — which would make every exclusion global and the Clouds field decorative.
	if !scoped.appliesTo("aws") {
		t.Error("an exclusion naming aws does not apply to aws")
	}
	for _, cloud := range []string{"gcp", "hetzner"} {
		if scoped.appliesTo(cloud) {
			t.Errorf("an exclusion naming only aws also applies to %s", cloud)
		}
	}
}

// aCloudClaimedBy returns a cloud the named exclusion actually applies to, so a test about the
// exclusion MACHINERY does not fail when one cloud legitimately leaves an entry's list.
//
// It fails loudly on an entry that claims no cloud: an exclusion nothing applies to is not a
// fixture, it is a dead entry, and silently skipping would let this test pass while checking
// nothing.
func aCloudClaimedBy(t *testing.T, addOn string) string {
	t.Helper()
	e, ok := addOnExclusions[addOn]
	if !ok {
		t.Fatalf("no exclusion for %q — this test needs one to exercise the partition", addOn)
	}
	if len(e.Clouds) == 0 {
		t.Fatalf("the %q exclusion claims no cloud, so nothing it says can be exercised", addOn)
	}
	return e.Clouds[0]
}
