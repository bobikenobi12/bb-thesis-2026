// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ArgoCD wait budget, pinned against the surface it is derived from (#2062) and against the
// caps that actually contain it (#2717).
//
// The flat 8m this replaced was chosen for the LEAN add-on tier and then inherited unchanged by
// the full 18-chart one. That is what killed the first real hetzner run of the 18-add-on set: the
// cluster was up, 7 nodes Ready, the receipt verified — and the assertion gave up with velero
// still `Missing`. Its replacement was a GUESS in the same shape — 6m + 45s/chart clamped at 20m,
// i.e. 19m30s for 18 charts — and run 33107415369 measured that guess short by 15m30s.
//
// A budget is only meaningful relative to two things: the work it bounds, and the cap it has to fit
// inside. So these tests pin both ends — it must grow with the surface and land on the MEASURED
// convergence, and its ceiling must fit the step/job `timeout-minutes` read out of the real
// workflow. The old second half pinned it against a provider's waitTimeout, which never bounded
// this wait at all (see argoBudgetCeiling in argocd_assert.go).
//
// UNTAGGED: pure arithmetic over the provider table, the generated catalog fixture, the dimension
// resolver and the workflow file — no cloud, no cluster, no credentials.
package e2e

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The budget must never be shorter than the constant it replaced — no existing scenario gets
// tighter as a side effect of deriving it.
func TestArgoBudgetNeverBelowTheOldFlatDefault(t *testing.T) {
	for _, addOns := range []int{0, 1, 3, 5, 18, 40} {
		if got := argoBudgetFor(addOns); got < argoBudgetFloor {
			t.Errorf("argoBudgetFor(%d) = %s, below the %s floor", addOns, got, argoBudgetFloor)
		}
	}
}

// A zero-add-on surface must still land on the historical 8m: the floor and the base are equal by
// construction, and a change to either that broke that equality would move every scenario.
//
// This pins argoBudgetFor(0), which is the ARITHMETIC and no longer the lean tier — the lean tier
// passes len(alwaysRenderedArgoApps), see TestLeanTierBudgetBuysTheChartItPulls. It was named
// "LeanTierIsUnchanged" while it tested an input the lean tier had stopped supplying, which is how
// #3580's gap stayed invisible: the test still passed, and it was answering a different question.
func TestArgoBudgetWithNoAddOnsIsTheHistoricalEightMinutes(t *testing.T) {
	if got := argoBudgetFor(0); got != 8*time.Minute {
		t.Errorf("argoBudgetFor(0) = %s, want the historical 8m", got)
	}
}

// The full surface must buy materially more than the lean one, or the derivation is decoration.
// 8m was not enough for 18 charts — that is the measured fact this whole change rests on.
func TestArgoBudgetFullSurfaceExceedsWhatKilledTheHetznerRun(t *testing.T) {
	full := argoBudgetFor(expectedCatalogSize)
	if full <= 8*time.Minute {
		t.Fatalf("full-surface budget = %s, still <= the 8m that failed with velero Missing", full)
	}
	if lean := argoBudgetFor(0); full <= lean {
		t.Errorf("full-surface budget %s does not exceed the lean budget %s", full, lean)
	}
}

// argoMeasuredFullSurfaceBudget is the ONE number in this file that came from a cloud rather than
// from arithmetic: hetzner/addons run 33107415369, dispatched with ALETHIA_E2E_ARGO_TIMEOUT=35m.
// kube-prometheus-stack, loki and vault were all `Progressing` at the derived 19m30s and all three
// were Healthy by 35m.
const argoMeasuredFullSurfaceBudget = 35 * time.Minute

// The full surface must derive the budget that was MEASURED to converge, not merely "more than the
// lean tier". This is the test that would have been red for the whole life of the 19m30s guess:
// every `addons` and `full` run was failing on the clock, before it could reach a real defect, and
// nothing offline said so.
//
// It is deliberately an EQUALITY. Tuning base or per-add-on without re-deciding what the surface is
// known to need is how the previous guess survived four paid runs.
func TestArgoBudgetFullSurfaceIsTheMeasuredConvergence(t *testing.T) {
	if got := argoBudgetFor(expectedCatalogSize); got != argoMeasuredFullSurfaceBudget {
		t.Errorf("argoBudgetFor(%d) = %s, want the measured %s (hetzner/addons run 33107415369)\n"+
			"  base %s + %d x %s = %s\n"+
			"If the catalog size changed, re-derive; if the rate changed, say which run measured it.",
			expectedCatalogSize, got, argoMeasuredFullSurfaceBudget,
			argoBudgetBase, expectedCatalogSize, argoBudgetPerAddOn,
			argoBudgetBase+time.Duration(expectedCatalogSize)*argoBudgetPerAddOn)
	}
	// …and the ceiling must not be the thing producing that answer. A clamped value would make the
	// equality above true while the derivation itself was still wrong.
	if unclamped := argoBudgetBase + time.Duration(expectedCatalogSize)*argoBudgetPerAddOn; unclamped > argoBudgetCeiling {
		t.Errorf("the real catalog derives %s, which the %s ceiling CLAMPS — the surface has outgrown the clamp",
			unclamped, argoBudgetCeiling)
	}
}

// ── The ceiling, pinned against what actually contains it. ─────────────────────────────────────
//
// THIS REPLACES TestArgoBudgetStaysUnderEveryProviderWaitTimeout, and the reason is worth stating
// because the old test PASSED while being wrong. It asserted `argoBudgetCeiling < waitTimeout` for
// every provider, on the stated ground that "the Argo wait can outlive the job wait that cancels
// it". No waitTimeout cancels the Argo wait: it bounds cp.WaitTerminal, an earlier and separate
// poll, and the two are separate SUMMED terms of the single ctx ResolveT2Budget builds. The test's
// own comment quoted hetzner at 25m, which the provider row stopped saying at #3027. So it pinned
// the wrong number against the wrong bound, and its green was worth nothing.
//
// What genuinely bounds this wait, in order: the ctx (already proven by TestT2BudgetLadderHolds),
// then the step and job `timeout-minutes` in e2e-nightly.yml. Those two are the rungs GitHub
// evaluates BEFORE the step body runs, so nothing in Go can derive them — which is why cmd/t2budget
// verifies them at the top of the step, and why raising the Argo budget without raising them just
// moves where the run dies, later and after the spend. This test moves that check to PR time.

// t2WorkflowCaps is one `timeout-minutes` pair as e2e-nightly.yml expresses it: the fabric-demo
// branch and the ordinary one.
type t2WorkflowCaps struct{ fabric, plain int }

// e2eNightlyCaps reads the step and job caps out of the real workflow, and additionally holds the
// workflow to its own "if you change one, change both" instruction: T2_STEP_CAP_MINUTES /
// T2_JOB_CAP_MINUTES are passed to cmd/t2budget, and each must be the SAME expression as the
// `timeout-minutes:` it claims to mirror. Nothing checked that before; a pair that drifted would
// make t2budget verify a cap the run does not actually have.
func e2eNightlyCaps(t *testing.T) (step, job t2WorkflowCaps) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(e2ePackageDir(t), "..", "..", ".github", "workflows", "e2e-nightly.yml"))
	if err != nil {
		t.Fatalf("read e2e-nightly.yml: %v", err)
	}
	wf := string(raw)

	read := func(name string) t2WorkflowCaps {
		re := regexp.MustCompile(regexp.QuoteMeta(name) + `: \$\{\{ vars\.E2E_FABRIC_DEMO != '' && (\d+) \|\| (\d+) \}\}`)
		m := re.FindStringSubmatch(wf)
		if m == nil {
			t.Fatalf("no %s expression of the expected shape in e2e-nightly.yml — this guard would be vacuous", name)
		}
		fabric, _ := strconv.Atoi(m[1])
		plain, _ := strconv.Atoi(m[2])
		if fabric <= 0 || plain <= 0 {
			t.Fatalf("%s parsed as fabric=%d plain=%d", name, fabric, plain)
		}
		// The `timeout-minutes:` this value claims to mirror must be verbatim the same expression.
		mirror := fmt.Sprintf("timeout-minutes: ${{ vars.E2E_FABRIC_DEMO != '' && %d || %d }}", fabric, plain)
		if !strings.Contains(wf, mirror) {
			t.Errorf("%s says fabric=%d plain=%d but no `%s` appears in e2e-nightly.yml —\n"+
				"the cap cmd/t2budget verifies is not the cap GitHub enforces", name, fabric, plain, mirror)
		}
		return t2WorkflowCaps{fabric: fabric, plain: plain}
	}
	return read("T2_STEP_CAP_MINUTES"), read("T2_JOB_CAP_MINUTES")
}

// e2eDimensions asks scripts/e2e/resolve-dimension.sh — the SSOT the workflow itself calls — which
// dimensions exist and what each one turns on. Shelling out rather than restating the table is the
// point: a dimension added there is covered here for free, and a hand-kept copy is how the workflow
// and the harness disagreed about the soak in the first place (#2356).
func e2eDimensions(t *testing.T) (dims []string, fidelity map[string]map[string]string) {
	t.Helper()
	resolver := filepath.Join(e2ePackageDir(t), "..", "..", "scripts", "e2e", "resolve-dimension.sh")
	run := func(args ...string) string {
		out, err := exec.Command("bash", append([]string{resolver}, args...)...).Output()
		if err != nil {
			t.Fatalf("resolve-dimension.sh %v: %v", args, err)
		}
		return string(out)
	}
	dims = strings.Fields(run("--dimensions"))
	if len(dims) == 0 {
		t.Fatal("resolve-dimension.sh --dimensions returned nothing — this guard would be vacuous")
	}
	fidelity = make(map[string]map[string]string, len(dims))
	for _, d := range dims {
		kv := map[string]string{}
		for _, line := range strings.Split(run("--fidelity", d), "\n") {
			if line = strings.TrimSpace(line); line == "" {
				continue
			}
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				t.Fatalf("resolve-dimension.sh --fidelity %s emitted %q, not NAME=value", d, line)
			}
			kv[k] = v
		}
		fidelity[d] = kv
	}
	return dims, fidelity
}

// argoCapProbeEnv is every switch this guard sets or clears, so an ambient value from the developer's
// shell cannot decide what the test covers.
func argoCapProbeEnv() []string {
	vars := append(T2BudgetScenarioEnv(),
		"ALETHIA_E2E_ALL_ADDONS", "ALETHIA_E2E_MAX_CONFIG", "ALETHIA_E2E_ARGO_REPOS_REQUIRE",
		"ALETHIA_E2E_BYO_IAC", "ALETHIA_E2E_ARGO_TIMEOUT", "ALETHIA_E2E_DAY2_ACCESS_TIMEOUT",
		"ALETHIA_E2E_T2_WAIT", "ALETHIA_E2E_T2_TEARDOWN", envAcmCert)
	sort.Strings(vars)
	return vars
}

// TestArgoBudgetCeilingFitsTheWorkflowCaps is the real pin on argoBudgetCeiling: for every cloud and
// every DIMENSION the programme actually drives, the ladder must fit the step and job caps in
// e2e-nightly.yml — evaluated at the CEILING, so the caps hold the whole clamp range and a catalog
// that grows to it needs no workflow edit.
//
// Deliberately per real dimension, not over the scenario powerset. The powerset is not a shape
// anything runs: it resolves to a >5h ladder for aws by stacking keyless-db, both placements and the
// fabric demo into one apply, and sizing the caps for it would make them meaningless. The same
// choice the workflow's own cap comment records ("MEASURED, per real dimension rather than a
// cartesian product"), made once here instead of by hand each time.
//
// The two postures the dimension table cannot express are set to their WIDEST: day-2 access on
// (vars.E2E_DAY2_ACCESS) and the ACM certificate on (vars.E2E_ACM_CERT, which only adds its term
// when max-config is off — so it lands on `day2` and `addons`, never on `full`).
func TestArgoBudgetCeilingFitsTheWorkflowCaps(t *testing.T) {
	stepCap, jobCap := e2eNightlyCaps(t)
	dims, fidelity := e2eDimensions(t)
	clouds := t2LadderClouds()
	if len(clouds) == 0 {
		t.Fatal("no provider rows — this guard would be vacuous")
	}

	var checked int
	var worstStep, worstJob T2Budget
	for _, fabricOn := range []bool{false, true} {
		caps := struct{ step, job int }{stepCap.plain, jobCap.plain}
		branch := "ordinary"
		if fabricOn {
			caps = struct{ step, job int }{stepCap.fabric, jobCap.fabric}
			branch = "fabric-demo"
		}
		for _, dim := range dims {
			for _, cloud := range clouds {
				name := fmt.Sprintf("%s/%s/%s", branch, cloud, dim)
				t.Run(name, func(t *testing.T) {
					for _, v := range argoCapProbeEnv() {
						t.Setenv(v, "")
					}
					for k, v := range fidelity[dim] {
						t.Setenv(k, v)
					}
					t.Setenv("ALETHIA_E2E_DAY2_ACCESS", "1")
					t.Setenv(envAcmCert, "1")
					if fabricOn {
						t.Setenv(envFabricDemo, "1")
					}
					// The dimensions that seed the full add-on surface are the only ones that can
					// reach the ceiling, so only those are evaluated at it. Forcing 40m onto a lean
					// dimension would size the caps for a budget it can never derive.
					if fidelity[dim]["ALETHIA_E2E_ALL_ADDONS"] == "1" {
						t.Setenv("ALETHIA_E2E_ARGO_TIMEOUT", argoBudgetCeiling.String())
					}

					b, err := ResolveT2Budget(cloud, "ladder")
					if err != nil {
						t.Fatalf("ResolveT2Budget: %v", err)
					}
					checked++
					if b.Step > worstStep.Step {
						worstStep = b
					}
					if b.Job > worstJob.Job {
						worstJob = b
					}
					if got := int(b.Step.Minutes()); got > caps.step {
						t.Errorf("step needs %dm but the %s cap is %dm — the run would be KILLED mid-scenario\n  %s\n"+
							"Raise T2_STEP_CAP_MINUTES *and* the step's timeout-minutes in .github/workflows/e2e-nightly.yml.",
							got, branch, caps.step, b.Describe())
					}
					if got := int(b.Job.Minutes()); got > caps.job {
						t.Errorf("job needs %dm but the %s cap is %dm\n  %s\n"+
							"Raise T2_JOB_CAP_MINUTES *and* the job's timeout-minutes in .github/workflows/e2e-nightly.yml.",
							got, branch, caps.job, b.Describe())
					}
				})
			}
		}
	}
	if checked == 0 {
		t.Fatal("checked zero cloud x dimension combinations")
	}
	t.Logf("checked %d cloud x dimension x branch ladders against step %d/%d and job %d/%d (plain/fabric)",
		checked, stepCap.plain, stepCap.fabric, jobCap.plain, jobCap.fabric)
	t.Logf("widest step: %s", worstStep.Describe())
	t.Logf("widest job:  %s", worstJob.Describe())
}

// The caps must not be sized by luck. A cap far larger than any real ladder is a cap nobody will
// notice has stopped meaning anything, so the ordinary branch is held to a bounded slack over the
// widest dimension it must contain. This is the half of the pin that would catch a ceiling LOWERED
// without lowering the caps — the direction TestArgoBudgetCeilingFitsTheWorkflowCaps cannot see.
func TestWorkflowCapsAreNotWildlyOversized(t *testing.T) {
	const maxSlackMinutes = 30
	stepCap, jobCap := e2eNightlyCaps(t)
	dims, fidelity := e2eDimensions(t)

	var widest T2Budget
	for _, dim := range dims {
		for _, cloud := range t2LadderClouds() {
			for _, v := range argoCapProbeEnv() {
				t.Setenv(v, "")
			}
			for k, v := range fidelity[dim] {
				t.Setenv(k, v)
			}
			t.Setenv("ALETHIA_E2E_DAY2_ACCESS", "1")
			t.Setenv(envAcmCert, "1")
			if fidelity[dim]["ALETHIA_E2E_ALL_ADDONS"] == "1" {
				t.Setenv("ALETHIA_E2E_ARGO_TIMEOUT", argoBudgetCeiling.String())
			}
			b, err := ResolveT2Budget(cloud, "ladder")
			if err != nil {
				t.Fatalf("%s/%s: %v", cloud, dim, err)
			}
			if b.Step > widest.Step {
				widest = b
			}
		}
	}
	if slack := stepCap.plain - int(widest.Step.Minutes()); slack > maxSlackMinutes {
		t.Errorf("the ordinary step cap is %dm against a widest real ladder of %s — %dm of slack.\n  %s\n"+
			"A cap this loose no longer bounds anything; lower it to the ladder it exists for.",
			stepCap.plain, widest.Step, slack, widest.Describe())
	}
	if slack := jobCap.plain - int(widest.Job.Minutes()); slack > maxSlackMinutes {
		t.Errorf("the ordinary job cap is %dm against a widest real ladder of %s — %dm of slack",
			jobCap.plain, widest.Job, slack)
	}
}

// The ceiling has to actually bind, or a catalog that grows unnoticed walks the budget past the
// parent bound the test above pins.
func TestArgoBudgetCeilingBinds(t *testing.T) {
	if got := argoBudgetFor(1000); got != argoBudgetCeiling {
		t.Errorf("argoBudgetFor(1000) = %s, want the %s ceiling", got, argoBudgetCeiling)
	}
}

// The env override remains the explicit escape hatch and must win over the derivation.
func TestArgoAssertTimeoutEnvOverrideWins(t *testing.T) {
	t.Setenv("ALETHIA_E2E_ARGO_TIMEOUT", "3m")
	if got := ArgoAssertTimeout(); got != 3*time.Minute {
		t.Errorf("ArgoAssertTimeout() = %s, want the 3m override", got)
	}
}

// An unparseable override must fall back to the derivation, not to zero — a zero budget would fail
// every assertion instantly and read as a broken cluster.
func TestArgoAssertTimeoutIgnoresAnUnparseableOverride(t *testing.T) {
	t.Setenv("ALETHIA_E2E_ARGO_TIMEOUT", "not-a-duration")
	if got := ArgoAssertTimeout(); got < argoBudgetFloor {
		t.Errorf("ArgoAssertTimeout() = %s on a bad override, want at least the %s floor", got, argoBudgetFloor)
	}
}

// The full-surface path must read the real catalog and agree with the fixture's own size guard.
// A fixture that shrank would otherwise quietly shorten the budget for a run that still installs
// everything — the vacuity class AllCatalogAddOns already fails closed on.
func TestArgoAddOnCountMatchesTheCatalogWhenFullSurfaceIsOn(t *testing.T) {
	t.Setenv("ALETHIA_E2E_ALL_ADDONS", "1")
	got := argoAddOnCount()
	if got < expectedCatalogSize {
		t.Errorf("argoAddOnCount() = %d with the full surface on, want at least %d", got, expectedCatalogSize)
	}
}

// …and the lean tier must pay for the charts it ACTUALLY pulls — no more, and no longer zero.
//
// THIS TEST USED TO ASSERT ZERO, and it was wrong in the way a test and a bug agree with each
// other: "the lean tier must not pay for charts it never seeds" is true, and the lean tier does
// seed one. alwaysRenderedArgoApps is rendered on every cloud and every dimension with no gate, so
// a floor run converges a real upstream Helm chart while argoBudgetBase — by its own docstring —
// covers only what happens "before any add-on chart is pulled". The gcp floor leg of nightly run
// 33487970328 lost its verdict in the resulting gap (#3580).
//
// It is pinned to len(alwaysRenderedArgoApps) rather than to 1 so that a template which becomes
// unconditional is paid for by the edit that makes it so, instead of silently re-opening the gap.
func TestArgoAddOnCountCoversWhatTheLeanTierAlwaysPulls(t *testing.T) {
	for _, v := range argoCapProbeEnv() {
		t.Setenv(v, "")
	}
	want := len(alwaysRenderedArgoApps) + len(leanSeedAddOnIDs) + 1
	if want == 0 {
		t.Fatal("alwaysRenderedArgoApps is empty — this test would assert the zero it exists to disprove")
	}
	if got := argoAddOnCount(); got != want {
		t.Errorf("argoAddOnCount() = %d on the lean tier, want %d "+
			"(len(alwaysRenderedArgoApps) + len(leanSeedAddOnIDs) + metrics-server)", got, want)
	}
}

// The lean tier's budget must be strictly LONGER than the base, or the fix above is arithmetic that
// changes nothing. Asserts the DERIVED value a lean run actually gets, not argoBudgetFor(0) — the
// distinction is the whole defect: the old test pinned an input nothing passed any more.
//
// HERMETIC. It clears every switch in argoCapProbeEnv(), not just ALETHIA_E2E_ALL_ADDONS.
// ArgoAssertTimeout() reads ALETHIA_E2E_ARGO_TIMEOUT FIRST and returns it verbatim, so with that
// exported in the shell — the workflow documents it as a debugging knob — this asserted the
// override rather than the derivation, and `=35m` would have made every check below pass while
// argoAddOnCount() returned 0. TestT2HetznerPathUnchanged already gets this right via clearT2Env.
func TestLeanTierBudgetBuysTheChartsItPulls(t *testing.T) {
	for _, v := range argoCapProbeEnv() {
		t.Setenv(v, "")
	}
	charts := len(alwaysRenderedArgoApps) + len(leanSeedAddOnIDs) + 1
	got := ArgoAssertTimeout()
	want := argoBudgetBase + time.Duration(charts)*argoBudgetPerAddOn
	if got != want {
		t.Errorf("lean budget = %s, want %s (base + %d chart(s) the lean tier converges)", got, want, charts)
	}
	if got <= argoBudgetBase {
		t.Errorf("lean budget = %s, still <= argoBudgetBase %s — the charts a lean run pulls are being given nothing",
			got, argoBudgetBase)
	}

	// THE MEASURED BOUND, and it is the WORST case rather than the best. On the failing gcp floor
	// leg of run 33487970328 the 8m window opened at 09:06:05Z. ArgoCD refreshes health only on a
	// compare that SUCCEEDS, its cadence is a 120-180s band, and the last good compare was
	// 09:12:07Z — so the next one starts no later than 09:15:07Z, and the 34s manifest render
	// measured on that node puts the refresh at ~09:15:41Z. The budget must reach that.
	//
	// 9m30s (one chart's allowance) would NOT: it expires 09:15:35Z, six seconds early. That is
	// exactly the arithmetic slip this bound exists to pin — the earlier version of this test cited
	// 1m58s, which is how OLD the health was, not the gap to the next reconcile.
	const worstCaseRefresh = 9*time.Minute + 36*time.Second // 09:06:05Z → 09:15:41Z
	if got <= worstCaseRefresh {
		t.Errorf("lean budget = %s, does not reach the WORST-case health refresh of run 33487970328 (%s after the window opens)",
			got, worstCaseRefresh)
	}
}

// t2BaseHeadroom IS NOT SLACK, and the dump must not be sized as though it were.
//
// Its own definition is "runner build + snapshot seeding + the slack the old comment called
// headroom", and `t2BuildRunner` alone carries a five-minute ceiling that is spent after the test
// context is created. So "seven minutes of headroom, four for the dump, two left over" is
// arithmetic on an allowance that was never free — and on a cold module cache the dump would reach
// its point with nothing left at all.
//
// That is why argoDumpBudget is a CEILING and never a reservation: `planArgoDump` takes whatever is
// actually remaining and caps it. This test pins the reasoning rather than a subtraction, so nobody
// re-derives the wrong one.
func TestDumpCeilingIsNotSizedAgainstHeadroom(t *testing.T) {
	t.Parallel()

	// The ceiling never exceeds what is left, whatever it is — the only property the dump needs.
	for _, remaining := range []time.Duration{
		0, time.Second, 10 * time.Second, time.Minute, argoDumpBudget, 30 * time.Minute,
	} {
		p := planArgoDump(remaining, true)
		if p.Budget > remaining {
			t.Errorf("with %s left the plan asks for %s", remaining, p.Budget)
		}
		if p.Budget > argoDumpBudget {
			t.Errorf("with %s left the plan exceeds the ceiling: %s", remaining, p.Budget)
		}
	}
	// And it is not derived from headroom: if someone re-introduces that subtraction, this is the
	// comment they should hit first.
	if argoDumpBudget >= t2BaseHeadroom {
		t.Errorf("argoDumpBudget %s is at or above t2BaseHeadroom %s. That is not fatal — the plan "+
			"caps against real remaining time, not against headroom — but it means the ceiling can "+
			"never be reached on a normal leg, which makes it a number that does nothing.",
			argoDumpBudget, t2BaseHeadroom)
	}
}
