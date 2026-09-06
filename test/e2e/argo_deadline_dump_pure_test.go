// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// There are two ArgoCD convergence waits — AssertArgoAppsHealthy and the A0.6 repo-apps wait — and
// each used to assemble its own timeout dump by hand. #2834 added the desired-vs-live diff to one
// and not the other, so hetzner/maxconfig run 32993552300 timed out with five OutOfSync
// StatefulSets and printed NO diff: A0.6 was enabled, so the run went through the other wait.
//
// The fix was one shared `argoDeadlineDump`. This test is what keeps it one: a third wait that
// assembles its own list would drift the same way, and the drift is invisible until a run needs the
// missing half — by which point it has cost a real apply.

package e2e

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// dumpHelpers are the diagnostics a timed-out wait must carry. Calling any of them outside
// argoDeadlineDump means a caller is building its own dump.
//
// ⚠️ EVERY diagnostic in the shared helper belongs here. This list held three of seven, so both
// tests below passed with four of them deleted from `argoDeadlineDump` — the exact #2834 drift the
// file exists to prevent, tolerated by the guard against it. A guard whose subject list is written
// once and never grown decays into a guard for whatever was true the day it was written.
//
// Add a diagnostic to argoDeadlineDump, add it here.
var dumpHelpers = []string{
	"dumpArgoSyncFailures",
	"dumpPendingHooks",
	"dumpAddOnBootstrapJobs",
	"dumpArgoControllerLog",
	"dumpDestinationWarnings",
	"describeArgoApps",
	"dumpOutOfSyncResources",
	"dumpArgoHealthStaleness",
	"dumpArgoAppDiffs",
}

func TestEveryDeadlineDumpGoesThroughTheSharedHelper(t *testing.T) {
	t.Parallel()

	files, err := filepath.Glob("*.go")
	if err != nil || len(files) == 0 {
		t.Fatalf("could not list package sources (%v) — this test cannot check anything", err)
	}

	// The helper's own body is the one legitimate caller, so it is excised before scanning.
	bodyOf := regexp.MustCompile(`(?s)func argoDeadlineDump\(.*?\n}\n`)

	var offenders []string
	sawHelperDefinition := false
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		raw, rerr := os.ReadFile(f)
		if rerr != nil {
			t.Fatalf("could not read %s: %v", f, rerr)
		}
		src := string(raw)
		if strings.Contains(src, "func argoDeadlineDump(") {
			sawHelperDefinition = true
			src = bodyOf.ReplaceAllString(src, "")
		}
		for _, line := range strings.Split(src, "\n") {
			trimmed := strings.TrimSpace(line)
			// Definitions and doc comments are not calls.
			if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "func ") {
				continue
			}
			for _, helper := range dumpHelpers {
				if strings.Contains(trimmed, helper+"(") {
					offenders = append(offenders, f+": "+trimmed)
				}
			}
		}
	}

	// Guards the guard: if the helper is renamed or the glob stops matching, the scan above would
	// find nothing and report success while checking nothing.
	if !sawHelperDefinition {
		t.Fatal("argoDeadlineDump is not defined in this package — the scan checked nothing")
	}

	if len(offenders) > 0 {
		t.Fatalf("these call a deadline-dump helper directly instead of argoDeadlineDump, which is "+
			"how one wait ends up with diagnostics the other lacks:\n  %s",
			strings.Join(offenders, "\n  "))
	}
}

func TestSharedDumpCarriesEveryDiagnostic(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("argocd_assert.go")
	if err != nil {
		t.Fatalf("could not read argocd_assert.go: %v", err)
	}
	body := regexp.MustCompile(`(?s)func argoDeadlineDump\(.*?\n}\n`).FindString(string(raw))
	if body == "" {
		t.Fatal("argoDeadlineDump not found — the test above would also be vacuous")
	}
	// Dropping one from the shared helper is the same defect as before, moved one level up: every
	// wait would lose it at once instead of one wait lacking it.
	for _, helper := range dumpHelpers {
		if !strings.Contains(body, helper+"(") {
			t.Errorf("argoDeadlineDump no longer calls %s — every ArgoCD timeout loses it", helper)
		}
	}
}

// The ceiling's job is to stop the dump outliving its context; the SKIPPED LIST's job is to stop it
// doing that quietly. A dump that ends early without saying so reads as a complete dump with
// nothing in its later sections.
func TestRenderDumpStoppedNamesWhatDidNotRunAndWhichClockRanOut(t *testing.T) {
	t.Parallel()

	if got := renderDumpStopped(nil, dumpPlan{}); got != "" {
		t.Errorf("nothing skipped must print nothing, got %q", got)
	}
	skipped := []dumpSection{{name: "describe"}, {name: "argocd app diff"}}

	own := renderDumpStopped(skipped, dumpPlan{Budget: argoDumpBudget})
	for _, want := range []string{"2 section(s) NOT run", "describe", "argocd app diff", "ceiling of"} {
		if !strings.Contains(own, want) {
			t.Errorf("the skipped notice does not carry %q:\n%s", want, own)
		}
	}

	// The OTHER reason, and a different fault: the leg ran out, this ceiling never bound anything,
	// and raising it would fix nothing.
	byCtx := renderDumpStopped(skipped, dumpPlan{Budget: 45 * time.Second, BoundByCtx: true})
	if !strings.Contains(byCtx, "T2 context ran out first") || !strings.Contains(byCtx, "look at the ladder") {
		t.Errorf("a context-bound stop is reported as a spent ceiling:\n%s", byCtx)
	}
	if !strings.Contains(byCtx, "45s") {
		t.Errorf("the notice does not say how little was left:\n%s", byCtx)
	}
}

// planArgoDump is the whole of the "which clock" decision, so both branches are pinned here rather
// than inferred from a run.
func TestPlanArgoDumpTakesWhatIsActuallyLeft(t *testing.T) {
	t.Parallel()

	// Plenty of time: the ceiling binds, and the notice must not blame the context.
	if p := planArgoDump(30*time.Minute, true); p.Budget != argoDumpBudget || p.BoundByCtx || !p.Startable {
		t.Errorf("with 30m left: %+v, want the ceiling and not context-bound", p)
	}
	// Less than the ceiling: take what is there and SAY the context bound it.
	if p := planArgoDump(45*time.Second, true); p.Budget != 45*time.Second || !p.BoundByCtx || !p.Startable {
		t.Errorf("with 45s left: %+v, want 45s and context-bound", p)
	}
	// Too little to be worth starting: one honest line beats eight timeout messages.
	if p := planArgoDump(time.Second, true); p.Startable || !p.BoundByCtx {
		t.Errorf("with 1s left: %+v, want not startable and context-bound", p)
	}
	if p := planArgoDump(-time.Minute, true); p.Startable {
		t.Errorf("an already-expired context must not start the dump: %+v", p)
	}
	// A context with no deadline at all (the pure tests, and any caller that forgets one) still
	// gets the ceiling rather than an unbounded dump.
	if p := planArgoDump(0, false); p.Budget != argoDumpBudget || p.BoundByCtx || !p.Startable {
		t.Errorf("with no deadline: %+v, want the ceiling", p)
	}
}

// THE LOOP, not just the renderer. A cancelled context must produce the notice naming EVERY section
// — which is what an `sections[i+1:]` off-by-one or an inverted guard would get wrong, and neither
// would be visible from the pure renderer alone. No cluster, no tags, no cost.
func TestArgoDeadlineDumpOnAnAlreadyCancelledContextNamesEverySection(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	out := argoDeadlineDump(ctx, "/nonexistent/kubeconfig", nil, nil, nil)

	if !strings.Contains(out, "NOT run") {
		t.Fatalf("a cancelled context produced no stopped-notice:\n%s", out)
	}
	for _, name := range []string{
		"sync failures", "pending hooks", "bootstrap jobs", "controller log",
		"cluster warnings", "describe", "out-of-sync objects", "argocd app diff",
	} {
		if !strings.Contains(out, name) {
			t.Errorf("the notice does not name %q — an off-by-one would drop exactly the section "+
				"that did not run:\n%s", name, out)
		}
	}
}

// Every diagnostic argoDeadlineDump calls must be INSIDE the section table, and every section must
// be NAMED.
//
// The second half is obvious; the first is the one that decays. A ninth diagnostic added to the
// helper but outside `sections` runs UNBUDGETED — outside the ceiling, outside the per-section
// share, and absent from the skipped notice — with every other test in this file still green. That
// is the same drift as #2834, one level in.
func TestEveryDiagnosticIsInsideTheSectionTable(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("argocd_assert.go")
	if err != nil {
		t.Fatalf("could not read argocd_assert.go: %v", err)
	}
	body := regexp.MustCompile(`(?s)func argoDeadlineDump\(.*?\n}\n`).FindString(string(raw))
	if body == "" {
		t.Fatal("argoDeadlineDump not found — this test would be vacuous")
	}
	table := regexp.MustCompile(`(?s)sections := \[\]dumpSection\{.*?\n\t\}\n`).FindString(body)
	if table == "" {
		t.Fatal("the section table was not found inside argoDeadlineDump — the shape changed and " +
			"this test stopped checking")
	}

	// Names: matched loosely on purpose — any string literal that opens an entry — so a rewrite to
	// keyed fields or a multi-line entry does not silently empty the set.
	names := regexp.MustCompile(`\{\s*"([^"]*)"\s*,`).FindAllStringSubmatch(table, -1)
	if len(names) == 0 {
		t.Fatal("no named sections matched — the table's shape changed and this test stopped checking")
	}
	for _, n := range names {
		if strings.TrimSpace(n[1]) == "" {
			t.Error("a dump section has an empty name; the skipped notice would report a blank")
		}
	}

	// And nothing diagnostic outside the table.
	outside := strings.Replace(body, table, "", 1)
	for _, m := range regexp.MustCompile(`\b((?:dump|describe)[A-Za-z0-9_]*)\(`).FindAllStringSubmatch(outside, -1) {
		switch m[1] {
		case "dumpPlan", "dumpSection": // types, not diagnostics
			continue
		}
		t.Errorf("argoDeadlineDump calls %s outside the section table — it would run unbudgeted and "+
			"never appear in the skipped notice", m[1])
	}
}

// THE OTHER DIRECTION, and the one that let the list rot: a diagnostic added to the shared helper
// and never added to dumpHelpers is unguarded, and nothing said so.
//
// Distinct from TestEveryDiagnosticIsInsideTheSectionTable above, and both are needed. That one
// asks whether every diagnostic is BUDGETED — inside the section table, under the ceiling and the
// per-section share. This one asks whether every diagnostic is GUARDED — named in dumpHelpers, so
// the two drift tests can see it. A diagnostic can be in the table and not in the list, or the
// reverse; keeping only one of these leaves the other hole open.
func TestDumpHelpersNamesEveryDiagnosticTheHelperCalls(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("argocd_assert.go")
	if err != nil {
		t.Fatalf("could not read argocd_assert.go: %v", err)
	}
	body := regexp.MustCompile(`(?s)func argoDeadlineDump\(.*?\n}\n`).FindString(string(raw))
	if body == "" {
		t.Fatal("argoDeadlineDump not found — this test would be vacuous")
	}
	// COMMENTS STRIPPED FIRST. The body is mostly comment, and a doc line naming a function that was
	// removed would otherwise demand an entry in dumpHelpers for something that no longer exists —
	// a guard failing on prose.
	code := regexp.MustCompile(`(?m)//.*$`).ReplaceAllString(body, "")
	called := regexp.MustCompile(`\b((?:dump|describe)[A-Za-z0-9_]*)\(`).FindAllStringSubmatch(code, -1)
	if len(called) == 0 {
		t.Fatal("no diagnostic calls found in argoDeadlineDump — the pattern no longer matches its body")
	}
	// ⚠️ THE CONVENTION IS PART OF THE GUARD. This finds calls named `dump…` or `describe…`; a
	// diagnostic added as `argoAppEventsSummary(` is invisible to it and would be as unguarded as
	// the four this test was written for. Name diagnostics `dump…`/`describe…`, or widen this.
	//
	// Checked rather than trusted: every name already in dumpHelpers must be found by the pattern,
	// so a rename that escapes the convention fails HERE instead of silently shrinking the set.
	found := map[string]bool{}
	for _, m := range called {
		found[m[1]] = true
	}
	for _, h := range dumpHelpers {
		if !regexp.MustCompile(`\b(?:dump|describe)[A-Za-z0-9_]*$`).MatchString(h) {
			t.Errorf("dumpHelpers names %q, which this test's pattern cannot match — it is outside "+
				"the naming convention the guard depends on", h)
		}
	}
	named := map[string]bool{}
	for _, h := range dumpHelpers {
		named[h] = true
	}
	for _, m := range called {
		switch m[1] {
		case "argoDeadlineDump", "dumpPlan", "dumpSection": // itself, and types rather than diagnostics
			continue
		}
		if !named[m[1]] {
			t.Errorf("argoDeadlineDump calls %s but dumpHelpers does not name it — that diagnostic "+
				"can be deleted, or duplicated into a second wait, with both guards still green", m[1])
		}
	}
	// ⚠️ THE CONVENTION IS PART OF THE GUARD. This finds calls named `dump…`/`describe…`; a
	// diagnostic added as `argoAppEventsSummary(` is invisible to it and would be as unguarded as
	// the four this test was written for. Checked rather than trusted: every name already in
	// dumpHelpers must be findable by the pattern, so a rename that escapes the convention fails
	// HERE instead of silently shrinking the set.
	convention := regexp.MustCompile(`^(?:dump|describe)[A-Za-z0-9_]*$`)
	for _, h := range dumpHelpers {
		if !convention.MatchString(h) {
			t.Errorf("dumpHelpers names %q, which this test's pattern cannot match — it is outside "+
				"the naming convention the guard depends on", h)
		}
	}
}
