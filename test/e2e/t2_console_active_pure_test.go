// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Untagged unit proof for the PURE A0.5 helpers (BYOC A0.5): the flag gating, the
// snapshot-fidelity comparator (the finding-#4 guard), and the real-snapshot builder — exercised
// WITHOUT a cloud, a DB, a token, or the e2e_t2 tag, so `go test ./...` keeps them honest. The
// fidelity comparator is the load-bearing anti-divergence check, so it gets the refuters: an
// identical snapshot is clean, a drifted add-on value is caught, a synthetic key is caught, and the
// per-run dynamic inputs are correctly ignored.
package e2e

import (
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestA05Truthy(t *testing.T) {
	for _, on := range []string{"1", "true", "TRUE", "Yes", " on "} {
		if !a05Truthy(on) {
			t.Errorf("a05Truthy(%q) = false, want true", on)
		}
	}
	for _, off := range []string{"", "0", "false", "no", "off", "nope"} {
		if a05Truthy(off) {
			t.Errorf("a05Truthy(%q) = true, want false", off)
		}
	}
}

// repoRootForTest resolves the repository root from this file's own location, so the tests below
// read the COMMITTED fixture rather than a copy of it. Mirrors addonCatalogFixture's approach
// (addon_surface.go) — test/e2e/<file> ⇒ ../.. is the root.
func repoRootForTest(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Join(filepath.Dir(thisFile), "..", "..")
}

// canonicalFixture returns the REAL committed console fixture.
//
// It used to be a hand-written literal restating "the committed console fixture's fidelity-relevant
// keys" — a third copy of data that already exists on disk twice. It drifted: it carried
// `"values":{}` for reloader while the committed fixture carried the resolved knob defaults #643
// introduced on 2026-07-16. So the one unit test whose job is to catch synthetic drift was asserting
// against a snapshot of the PRE-drift world, and stayed green for three weeks while the nightly
// reported the divergence every night. Load the file (#1965).
func canonicalFixture(t *testing.T, cloud string) map[string]any {
	t.Helper()
	m, err := loadA05Fixture(repoRootForTest(t), cloud)
	if err != nil {
		t.Fatalf("load the committed %s fixture: %v\n"+
			"regenerate with: UPDATE_FIXTURES=1 pnpm -C apps/console run test t2-config-snapshot", cloud, err)
	}
	return m
}

// TestA05FixtureExistsForEveryProvider binds the fixture set to the PROVIDER TABLE, so a cloud
// cannot join the harness with no baseline to be measured against. Before #3122 there was one
// fixture — hetzner's — and every other cloud was compared to it; the failure that produced was not
// "no fixture", it was a `provider` divergence on 4 of 5 runs that read like drift and was not.
func TestA05FixtureExistsForEveryProvider(t *testing.T) {
	names := t2ProviderNames()
	if len(names) == 0 {
		t.Fatal("the provider table is empty — this test would pass vacuously")
	}
	for _, cloud := range names {
		if fx := canonicalFixture(t, cloud); len(fx) == 0 {
			t.Errorf("%s: fixture parsed to zero keys", cloud)
		}
	}
}

// TestA05SeedIsFaithfulToTheConsoleFixture is THE binder: the REAL lean seed the harness emits,
// compared against the REAL committed fixture the console froze.
//
// Nothing bound those two before — not this suite, not the e2e_t2 path, not CI. The pure tests
// exercised the comparator with hand-built inputs on BOTH sides (the old "lean subset" case set
// `"addons": fixture["addons"]`, i.e. it compared the fixture to itself), and the only assertion
// touching seedAddOns (TestSeedAddOnsPinnedToCatalog) string-greps catalog.ts for four scalar fields
// and cannot see `values` at all. So when #643 regenerated the fixture and left the Go literal
// behind, every gate stayed green and the drift surfaced only as a warn-only line in a nightly
// against a real cloud — the slowest, most expensive place to learn it.
//
// This is that check, relocated from a warn-only nightly log to a hard unit test on every PR. Run
// against the pre-#1965 seed it fails on `addons`, naming the empty `values`.
//
// A TABLE OVER EVERY CLOUD since #3122. It used to hardcode hetzner with a "the fixture's own cloud"
// caveat, because there was only one fixture — which is exactly what made the nightly's `provider`
// warning unactionable on the other four. Run the four managed rows against the pre-#3122 tree and
// they fail, naming `provider`: that is the regression this locks.
func TestA05SeedIsFaithfulToTheConsoleFixture(t *testing.T) {
	for _, cloud := range t2ProviderNames() {
		t.Run(cloud, func(t *testing.T) {
			// seedAddOns resolves the add-on catalog for THIS cloud (addonCatalogFixture reads
			// ALETHIA_E2E_PROVIDER), so the seed and the fixture have to be told the same cloud —
			// or this test reintroduces the mismatch it exists to catch, one layer down.
			t.Setenv(envE2EProvider, cloud)
			fixture := canonicalFixture(t, cloud)

			// The shape t2BaseSnapshot builds, with the run inputs set to values that MUST be
			// ignored: if a dynamic key ever stops being excluded, this test says so rather than a
			// nightly three weeks later.
			seeded := map[string]any{
				"id":                "e2e-fixture",
				"project_name":      "alethia-run", // dynamic — ignored
				"environment_stage": "run",         // dynamic — ignored
				"region":            "hel1",        // dynamic — ignored
				"provider":          cloud,         // compared, and now against ITS OWN cloud's fixture
				"addons":            seedAddOns(),  // static — the REAL seed, not a copy of the fixture
			}
			norm, err := a05NormalizeSnapshot(seeded)
			if err != nil {
				t.Fatalf("normalize: %v", err)
			}
			if diffs := a05SnapshotFidelity(norm, fixture); len(diffs) != 0 {
				t.Fatalf("the harness's seeded snapshot has drifted from the %s console fixture.\n"+
					"divergences: %v\n"+
					"the seed derives from test/e2e/fixtures/addon_catalog.%s.json and the fixture from "+
					"test/e2e/fixtures/t2_config_snapshot.%s.json — both are GENERATED, so regenerate "+
					"whichever is stale:\n"+
					"  pnpm -C apps/console run export:addon-catalog\n"+
					"  UPDATE_FIXTURES=1 pnpm -C apps/console run test t2-config-snapshot", cloud, diffs, cloud, cloud)
			}
		})
	}
}

// TestA05SeedCarriesResolvedAddOnValues pins the specific regression directly, so a future change
// that reintroduces an empty `values` fails with a message naming the cause rather than a generic
// deep-equal diff. #643 gave reloader real knob defaults; a seed that emits `{}` is claiming the
// console produces an add-on install spec it does not produce.
func TestA05SeedCarriesResolvedAddOnValues(t *testing.T) {
	seeded := seedAddOns()
	if len(seeded) == 0 {
		t.Fatal("seedAddOns returned nothing — the lean tier would install no add-on and still report green")
	}
	var reloader *types.AddOnInstall
	for i := range seeded {
		if seeded[i].ID == "reloader" {
			reloader = &seeded[i]
			break
		}
	}
	if reloader == nil {
		t.Fatal("the lean seed no longer carries reloader")
	}
	if len(reloader.Values) == 0 {
		t.Fatalf("reloader seeded with EMPTY values — the console resolves its catalog knob defaults "+
			"(catalog.ts toValues) and emits {reloader:{watchGlobally,deployment:{replicas}}}. "+
			"A hand-written literal drifted this way once (#643 → #1965); derive from "+
			"CatalogAddOn/addon_catalog.<cloud>.json instead. got: %+v", reloader.Values)
	}
}

func TestA05SnapshotFidelity_CatchesDriftedAddon(t *testing.T) {
	fixture := canonicalFixture(t, "hetzner")
	// A stale add-on version (the catalog moved, the harness seed didn't) MUST be caught — the exact
	// class of synthetic drift finding #4 warned about.
	seeded := map[string]any{
		"provider": "hetzner",
		"addons": []any{map[string]any{
			"id": "reloader", "mode": "managed", "chart": "reloader",
			"version": "9.9.9", "namespace": "reloader", "values": map[string]any{},
			"syncWave": 1.0, "chartRepo": "https://stakater.github.io/stakater-charts",
		}},
	}
	diffs := a05SnapshotFidelity(seeded, fixture)
	if len(diffs) == 0 {
		t.Fatal("expected a divergence for a drifted add-on version, got none")
	}
}

func TestA05SnapshotFidelity_CatchesSyntheticKey(t *testing.T) {
	fixture := canonicalFixture(t, "hetzner")
	// A key the console would NEVER freeze (not in the fixture) is flagged.
	seeded := map[string]any{
		"provider":         "hetzner",
		"synthetic_secret": "leaked", // not a console key
	}
	diffs := a05SnapshotFidelity(seeded, fixture)
	if len(diffs) != 1 {
		t.Fatalf("expected exactly one divergence for a synthetic key, got %d: %v", len(diffs), diffs)
	}
}

func TestA05SnapshotFidelity_IgnoresDynamicInputs(t *testing.T) {
	fixture := canonicalFixture(t, "hetzner")
	// Differing identity/naming/region are RUN INPUTS, never fidelity failures.
	seeded := map[string]any{
		"id":                "different",
		"project_name":      "totally-different",
		"region":            "us-east",
		"environment_stage": "prod",
		"provider":          "hetzner",
	}
	if diffs := a05SnapshotFidelity(seeded, fixture); len(diffs) != 0 {
		t.Fatalf("dynamic inputs must be ignored, got: %v", diffs)
	}
}

func TestA05RealSnapshotFromFixture_OverridesDynamicKeepsShape(t *testing.T) {
	fixture := canonicalFixture(t, "hetzner")
	snap, err := a05RealSnapshotFromFixture(fixture, "proj", "envx", "hetzner", "fsn1", "env-uuid")
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	// Dynamic fields overridden to this run.
	if snap["id"] != "e2e-envx" || snap["project_name"] != "proj" ||
		snap["environment_stage"] != "envx" || snap["region"] != "fsn1" ||
		snap["provider"] != "hetzner" || snap["environment_id"] != "env-uuid" {
		t.Fatalf("dynamic overrides not applied: %v", snap)
	}
	// The frozen (cheap) cluster + add-on shape is preserved verbatim from the console fixture.
	if !reflect.DeepEqual(snap["cluster"], fixture["cluster"]) {
		t.Fatalf("cluster shape mutated: %v vs %v", snap["cluster"], fixture["cluster"])
	}
	if !reflect.DeepEqual(snap["addons"], fixture["addons"]) {
		t.Fatalf("addons shape mutated: %v vs %v", snap["addons"], fixture["addons"])
	}
	// It is a DEEP COPY — mutating the result must not touch the fixture.
	snap["provider"] = "aws"
	if fixture["provider"] != "hetzner" {
		t.Fatal("a05RealSnapshotFromFixture aliased the fixture instead of deep-copying")
	}
	// And it is key-for-key faithful to the fixture it derives from.
	if diffs := a05SnapshotFidelity(mustNorm(t, snap), fixture); len(diffs) != 0 {
		// provider now aws (we mutated above) → expect exactly the provider divergence, nothing else.
		if len(diffs) != 1 {
			t.Fatalf("unexpected divergences: %v", diffs)
		}
	}
}

func mustNorm(t *testing.T, m map[string]any) map[string]any {
	t.Helper()
	n, err := a05NormalizeSnapshot(m)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	return n
}

// ─────────────────────── the per-cloud baseline + the addons axis (#3122/#2499) ───────────────────

// TestA05FixturePathIsPerCloud pins the ONE line the whole issue turns on. A path that ignores its
// cloud argument is the pre-#3122 behaviour exactly, and every other test here would still pass
// with it: they would simply compare hetzner against hetzner, five times.
func TestA05FixturePathIsPerCloud(t *testing.T) {
	root := repoRootForTest(t)
	seen := map[string]string{}
	for _, cloud := range t2ProviderNames() {
		p := a05FixturePath(root, cloud)
		if !strings.Contains(p, "t2_config_snapshot."+cloud+".json") {
			t.Errorf("%s: path does not name its own cloud: %s", cloud, p)
		}
		if other, dup := seen[p]; dup {
			t.Errorf("%s and %s resolve to the SAME fixture (%s) — that is the defect, not the fix", cloud, other, p)
		}
		seen[p] = cloud
	}
}

// TestA05AddOnsFidelity_ComparesElementWiseByID is the second by-construction divergence, and the
// one the issue does not mention: a full-surface run seeds 18 add-ons against a fixture frozen from
// a canonical project carrying one. Whole-list equality made that a divergence on every ALL_ADDONS
// run, hetzner's included — so fixing only the cloud baseline would have left ENFORCE unusable.
func TestA05AddOnsFidelity_ComparesElementWiseByID(t *testing.T) {
	fixtureAddOns := canonicalFixture(t, "hetzner")["addons"]

	// A run seeding MORE add-ons than the canonical project: the shared one matches, the extra is
	// simply not described by this fixture.
	seededList, _ := fixtureAddOns.([]any)
	withExtra := append(append([]any{}, seededList...), map[string]any{
		"id": "kube-prometheus-stack", "mode": "managed", "chart": "kube-prometheus-stack",
		"version": "1.2.3", "namespace": "monitoring", "values": map[string]any{}, "syncWave": 2.0,
		"chartRepo": "https://prometheus-community.github.io/helm-charts",
	})
	if diffs := a05AddOnsFidelity(withExtra, fixtureAddOns); len(diffs) != 0 {
		t.Fatalf("an add-on the fixture does not carry must NOT be a divergence, got: %v", diffs)
	}
	cmp, notCmp := a05AddOnsScope(withExtra, fixtureAddOns)
	if len(cmp) != 1 || cmp[0] != "reloader" {
		t.Errorf("compared should be exactly [reloader], got %v", cmp)
	}
	if len(notCmp) != 1 || notCmp[0] != "kube-prometheus-stack" {
		t.Errorf("not-compared should NAME the add-on it could not compare, got %v", notCmp)
	}

	// And the drift signal still bites on the add-on both sides DO carry.
	drifted := []any{map[string]any{
		"id": "reloader", "mode": "managed", "chart": "reloader",
		"version": "9.9.9", "namespace": "reloader", "values": map[string]any{},
		"syncWave": 1.0, "chartRepo": "https://stakater.github.io/stakater-charts",
	}}
	diffs := a05AddOnsFidelity(drifted, fixtureAddOns)
	if len(diffs) != 1 || !strings.Contains(diffs[0], "reloader") {
		t.Fatalf("a drifted shared add-on must diverge and be NAMED, got: %v", diffs)
	}
}

// TestA05AddOnsFidelity_RefusesAShapeItCannotIndex — "I could not compare this" must not render as
// "these are equal". An add-on list without ids, or a non-list, is reported rather than skipped.
func TestA05AddOnsFidelity_RefusesAShapeItCannotIndex(t *testing.T) {
	fixtureAddOns := canonicalFixture(t, "hetzner")["addons"]
	for name, seeded := range map[string]any{
		"not a list":               map[string]any{"id": "reloader"},
		"element not a map":        []any{"reloader"},
		"element with no id":       []any{map[string]any{"chart": "reloader"}},
		"element with an empty id": []any{map[string]any{"id": "", "chart": "reloader"}},
	} {
		if diffs := a05AddOnsFidelity(seeded, fixtureAddOns); len(diffs) == 0 {
			t.Errorf("%s: expected a reported divergence, got none", name)
		}
	}
	// Two identical unindexable values are still equal — refusing to index is not refusing to agree.
	if diffs := a05AddOnsFidelity("same", "same"); len(diffs) != 0 {
		t.Errorf("identical unindexable values should agree, got: %v", diffs)
	}
}

// TestA05FullSurfaceSeedIsFaithful drives the REAL full add-on surface, per cloud, the way an
// ALETHIA_E2E_ALL_ADDONS=1 nightly does — the tier where the `addons` divergence actually fired
// (demos/proofs/hetzner/20260824T203543Z/run.log:10).
func TestA05FullSurfaceSeedIsFaithful(t *testing.T) {
	for _, cloud := range t2ProviderNames() {
		t.Run(cloud, func(t *testing.T) {
			t.Setenv(envE2EProvider, cloud)
			t.Setenv("ALETHIA_E2E_ALL_ADDONS", "1")
			full := seedAddOns()
			if len(full) < 2 {
				t.Fatalf("expected the FULL surface, got %d add-on(s) — this test would prove nothing", len(full))
			}
			fixture := canonicalFixture(t, cloud)
			norm, err := a05NormalizeSnapshot(map[string]any{"provider": cloud, "addons": full})
			if err != nil {
				t.Fatalf("normalize: %v", err)
			}
			if diffs := a05SnapshotFidelity(norm, fixture); len(diffs) != 0 {
				t.Fatalf("a full-surface seed diverged from the %s fixture: %v", cloud, diffs)
			}
			cmp, notCmp := a05AddOnsScope(norm["addons"], fixture["addons"])
			if len(cmp) == 0 {
				t.Fatalf("nothing was compared — a green here would mean nothing (not-compared: %v)", notCmp)
			}
		})
	}
}
