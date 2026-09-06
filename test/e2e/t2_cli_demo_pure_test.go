// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// PURE tests for the CLI-only demo surface — no cloud, no binary, no network. ci.yml runs these
// on every PR, so the table can never drift into a shape that reads as proof without being one.
//
// The second half is a MUTATION GATE, in the spirit of packages/core/verify/mutate_test.go: for
// each rule in DemoStep.Validate it takes a VALID step, injects exactly ONE violation, and asserts
// the verdict flips to an error. Without it these tests would only prove that two things the same
// author wrote agree with each other — which is what a golden test proves, and why the repo does
// not accept one as a gate.

package e2e

import (
	"strings"
	"testing"
)

func TestCLIDemoTableIsWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, s := range CLIDemoSteps {
		if err := s.Validate(); err != nil {
			t.Errorf("step %q is malformed: %v", s.ID, err)
		}
		if seen[s.ID] {
			t.Errorf("duplicate step ID %q — IDs are the ledger's primary key", s.ID)
		}
		seen[s.ID] = true
	}
	if len(CLIDemoSteps) == 0 {
		t.Fatal("the demo table is empty — an empty table passes every other assertion in this file")
	}
}

func TestCLIDemoScoresEveryCloud(t *testing.T) {
	for _, cloud := range DemoClouds {
		p, err := ScoreCLIDemo(cloud)
		if err != nil {
			t.Fatalf("cloud %q does not score: %v", cloud, err)
		}
		if len(p.Driven) == 0 {
			t.Errorf("cloud %q scored zero driven steps", cloud)
		}
		if p.Verdict() == "" || p.Summary() == "" {
			t.Errorf("cloud %q rendered an empty verdict/summary", cloud)
		}
	}
}

// Every tracked verdict must name an issue that LOOKS like one. A Why that says "tracked
// elsewhere" is how a gap stops being tracked.
//
// SHAPE ONLY — and that is a boundary, not an omission. Whether the issue is still OPEN is a
// question about GitHub, and this file is `_pure_test.go`: ci.yml runs it on every PR with no
// credentials, so a network call here would make the whole file conditional on the API. The state
// question lives in scripts/check-exclusion-issues.mjs, which holds the two halves of the
// maintainer's ruling on #3591 apart: a CLIGap tracker must be OPEN because our own debt has to be
// able to close, while a CloudManual tracker need only be FILED because a cloud ceiling does not
// lift when its issue does. See DemoStep.Issue for the full statement.
func TestCLIDemoGapsAndCeilingsAreFiled(t *testing.T) {
	gaps, ceilings := 0, 0
	for _, s := range CLIDemoSteps {
		switch s.Reach {
		case CLIGap:
			gaps++
		case CloudManual:
			ceilings++
		default:
			continue
		}
		if !strings.HasPrefix(s.Issue, "#") || len(s.Issue) < 3 {
			t.Errorf("step %q: %q is not an issue reference — every gap and every ceiling is filed", s.ID, s.Issue)
		}
		if len(s.Why) < 40 {
			t.Errorf("step %q: Why is %d chars — too short to survive being read by somebody who was not here", s.ID, len(s.Why))
		}
	}
	// THE VACUITY FLOOR, the same one TestEveryShippedCeilingCarriesAProbe carries. Every
	// assertion above is inside a loop over a filtered set, so an empty set passes them all — and
	// a table with no gaps and no ceilings would report this test GREEN having examined nothing.
	//
	// ZERO GAPS ALONE IS NOT THE VACUOUS CASE: it is the intended state, put there by #2331, and
	// TestCLIDemoBarFailsOnlyOnCloudCeilings asserts it deliberately. It is the sum that must be
	// non-zero, and the counts are logged so a pass says what it actually looked at rather than
	// leaving "0 examined" and "0 wrong" rendering alike.
	t.Logf("examined %d %s and %d %s row(s)", gaps, CLIGap, ceilings, CloudManual)
	if gaps+ceilings == 0 {
		t.Fatal("the table carries no gaps and no ceilings at all, so this test asserted nothing — if the " +
			"bar is genuinely met, delete this test and say so in the PR rather than letting it pass empty")
	}
}

// A per-cloud step must name clouds that exist, or it silently applies to nothing.
func TestCLIDemoCloudsAreReal(t *testing.T) {
	known := map[string]bool{}
	for _, c := range DemoClouds {
		known[c] = true
	}
	for _, s := range CLIDemoSteps {
		for _, c := range s.Clouds {
			if !known[c] {
				t.Errorf("step %q names cloud %q, which is not in DemoClouds — the step would apply to nothing and read as covered", s.ID, c)
			}
		}
	}
}

// The bar is still FAILING, and this test says so out loud — but as of #2331 it fails for a
// materially different reason, and that distinction is the whole point of the table.
//
// It used to assert the receipt-verify GAP was still scored. `alethia verify receipt` shipped,
// so that assertion is now inverted: our own debt is zero, and what is left standing is cloud
// ceilings (DNS delegation is a registrar action on every cloud, #1773) that no amount of work
// on this product removes.
//
// Both halves are load-bearing:
//   - zero CLIGaps — a NEW gap must be a deliberate, visible edit, never a quiet regression.
//   - not Passed() on the UNEVALUATED proof — ScoreCLIDemo is pure and never runs a ceiling's
//     SatisfiedBy probe, so every ceiling is still counted outstanding here. That is the
//     fail-closed direction: a caller who forgets EvaluateCeilings gets the strict answer.
//
// A ceiling whose manual work has DEMONSTRABLY been done no longer fails the bar — see
// t2_cli_ceiling.go — but establishing that needs the network, so it lives in the run half.
func TestCLIDemoBarFailsOnlyOnCloudCeilings(t *testing.T) {
	p, err := ScoreCLIDemo("aws")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Gaps) != 0 {
		t.Errorf("aws carries %d CLI gap(s) again: %v — the CLI debt was cleared by #2331, so a gap here is "+
			"either a regression or a newly-found one that needs an issue and a row in docs/testing/cli-demo-bar.md",
			len(p.Gaps), gapIDs(p.Gaps))
	}
	if len(p.Manual) == 0 {
		t.Fatal("aws now scores ZERO cloud ceilings. If that is real, the bar is met — delete this test and " +
			"say so in the PR; it exists to stop the bar being declared met by accident")
	}
	if p.Passed() {
		t.Fatal("aws now PASSES the CLI-only demo bar. If that is real, delete this test and say so in the PR")
	}
}

// gapIDs names the offending steps, so a regression says WHICH step reopened rather than a count.
func gapIDs(steps []DemoStep) []string {
	ids := make([]string, len(steps))
	for i, s := range steps {
		ids[i] = s.ID
	}
	return ids
}

// Hetzner carries a ceiling no other cloud does; if that stops being true the table changed and
// somebody should have to say why.
func TestCLIDemoHetznerCarriesItsOwnCeiling(t *testing.T) {
	hetzner, err := ScoreCLIDemo("hetzner")
	if err != nil {
		t.Fatal(err)
	}
	aws, err := ScoreCLIDemo("aws")
	if err != nil {
		t.Fatal(err)
	}
	if len(hetzner.Manual) <= len(aws.Manual) {
		t.Errorf("hetzner has %d manual step(s) and aws %d — hetzner's Object Storage keys have no minting API, so it must carry strictly more",
			len(hetzner.Manual), len(aws.Manual))
	}
}

// ── The mutation gate. One violation per case; each must flip Validate to an error. ──

func TestCLIDemoValidateDiscriminates(t *testing.T) {
	valid := DemoStep{ID: "x", Title: "x", Argv: []string{"whoami"}, Reach: CLIDriven}
	if err := valid.Validate(); err != nil {
		t.Fatalf("the control case must pass, or every mutation below proves nothing: %v", err)
	}

	cases := []struct {
		name string
		step DemoStep
	}{
		{"no verdict at all", DemoStep{ID: "x", Title: "x", Argv: []string{"whoami"}}},
		{"unknown verdict", DemoStep{ID: "x", Title: "x", Reach: CLIReach("probably-fine")}},
		{"no ID", DemoStep{Title: "x", Argv: []string{"whoami"}, Reach: CLIDriven}},
		{"no Title", DemoStep{ID: "x", Argv: []string{"whoami"}, Reach: CLIDriven}},

		{"driven with no Argv", DemoStep{ID: "x", Title: "x", Reach: CLIDriven}},
		{"driven carrying WantArgv", DemoStep{ID: "x", Title: "x", Argv: []string{"a"}, WantArgv: []string{"b"}, Reach: CLIDriven}},
		{"driven naming an Issue", DemoStep{ID: "x", Title: "x", Argv: []string{"a"}, Issue: "#1", Reach: CLIDriven}},

		{"gap with no WantArgv", DemoStep{ID: "x", Title: "x", Reach: CLIGap, Issue: "#1", Why: strings.Repeat("w", 50)}},
		{"gap carrying Argv", DemoStep{ID: "x", Title: "x", Argv: []string{"a"}, WantArgv: []string{"b"}, Reach: CLIGap, Issue: "#1", Why: strings.Repeat("w", 50)}},
		{"gap with no Issue", DemoStep{ID: "x", Title: "x", WantArgv: []string{"b"}, Reach: CLIGap, Why: strings.Repeat("w", 50)}},
		{"gap with no Why", DemoStep{ID: "x", Title: "x", WantArgv: []string{"b"}, Reach: CLIGap, Issue: "#1"}},

		// Each of these carries a VALID probe so the case isolates ONE violation. Without it every
		// row below would fail on the missing-SatisfiedBy rule instead of the rule it names, and a
		// mutation gate that passes for the wrong reason proves nothing about the rule it claims.
		{"manual carrying Argv", DemoStep{ID: "x", Title: "x", Argv: []string{"a"}, Reach: CloudManual, Issue: "#1", Why: strings.Repeat("w", 50), SatisfiedBy: validProbe()}},
		{"manual with no Issue", DemoStep{ID: "x", Title: "x", Reach: CloudManual, Why: strings.Repeat("w", 50), SatisfiedBy: validProbe()}},
		{"manual with no Why", DemoStep{ID: "x", Title: "x", Reach: CloudManual, Issue: "#1", SatisfiedBy: validProbe()}},

		// ── The SatisfiedBy rules (#CLI ceiling probe). ──
		{"manual with NO probe", DemoStep{ID: "x", Title: "x", Reach: CloudManual, Issue: "#1", Why: strings.Repeat("w", 50)}},
		{"manual probe with no Kind", DemoStep{ID: "x", Title: "x", Reach: CloudManual, Issue: "#1", Why: strings.Repeat("w", 50), SatisfiedBy: &CeilingProbe{Env: []string{"A"}, Expect: "x"}}},
		{"manual probe with unknown Kind", DemoStep{ID: "x", Title: "x", Reach: CloudManual, Issue: "#1", Why: strings.Repeat("w", 50), SatisfiedBy: &CeilingProbe{Kind: CeilingProbeKind("vibes"), Env: []string{"A"}, Expect: "x"}}},
		{"manual probe with no Expect", DemoStep{ID: "x", Title: "x", Reach: CloudManual, Issue: "#1", Why: strings.Repeat("w", 50), SatisfiedBy: &CeilingProbe{Kind: ProbeEnvTruthy, Env: []string{"A"}}}},
		{"env probe naming no variables", DemoStep{ID: "x", Title: "x", Reach: CloudManual, Issue: "#1", Why: strings.Repeat("w", 50), SatisfiedBy: &CeilingProbe{Kind: ProbeEnvTruthy, Expect: "x"}}},
		{"env probe naming an empty variable", DemoStep{ID: "x", Title: "x", Reach: CloudManual, Issue: "#1", Why: strings.Repeat("w", 50), SatisfiedBy: &CeilingProbe{Kind: ProbeEnvTruthy, Env: []string{"  "}, Expect: "x"}}},
		{"zone probe naming two variables", DemoStep{ID: "x", Title: "x", Reach: CloudManual, Issue: "#1", Why: strings.Repeat("w", 50), SatisfiedBy: &CeilingProbe{Kind: ProbeZoneDelegated, Env: []string{"A", "B"}, Expect: "x"}}},
		{"driven carrying a probe", DemoStep{ID: "x", Title: "x", Argv: []string{"a"}, Reach: CLIDriven, SatisfiedBy: validProbe()}},
		{"console-only carrying a probe", DemoStep{ID: "x", Title: "x", Reach: ConsoleOnly, Why: strings.Repeat("w", 50), SatisfiedBy: validProbe()}},
		{"table row pre-setting ProbeReading", DemoStep{ID: "x", Title: "x", Argv: []string{"a"}, Reach: CLIDriven, ProbeReading: "looks fine to me"}},

		{"console-only carrying Argv", DemoStep{ID: "x", Title: "x", Argv: []string{"a"}, Reach: ConsoleOnly, Why: strings.Repeat("w", 50)}},
		{"console-only with no Why", DemoStep{ID: "x", Title: "x", Reach: ConsoleOnly}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.step.Validate(); err == nil {
				t.Errorf("Validate accepted a step that %s — the rule does not discriminate, so it is decoration", tc.name)
			}
		})
	}
}

// ScoreCLIDemo must refuse a malformed table rather than quietly skipping the bad row — the
// failure mode maxconfig.go's "unmapped" state used to have.
func TestCLIDemoScoreRefusesAMalformedTable(t *testing.T) {
	original := CLIDemoSteps
	t.Cleanup(func() { CLIDemoSteps = original })

	CLIDemoSteps = []DemoStep{
		{ID: "ok", Title: "ok", Argv: []string{"whoami"}, Reach: CLIDriven},
		{ID: "bad", Title: "no verdict"},
	}
	if _, err := ScoreCLIDemo("aws"); err == nil {
		t.Fatal("ScoreCLIDemo accepted a table containing a verdictless step")
	}

	CLIDemoSteps = []DemoStep{
		{ID: "dup", Title: "a", Argv: []string{"whoami"}, Reach: CLIDriven},
		{ID: "dup", Title: "b", Argv: []string{"whoami"}, Reach: CLIDriven},
	}
	if _, err := ScoreCLIDemo("aws"); err == nil {
		t.Fatal("ScoreCLIDemo accepted duplicate step IDs")
	}

	CLIDemoSteps = []DemoStep{
		{ID: "only-hetzner", Title: "a", Argv: []string{"whoami"}, Reach: CLIDriven, Clouds: []string{"hetzner"}},
	}
	if _, err := ScoreCLIDemo("aws"); err == nil {
		t.Fatal("ScoreCLIDemo returned a proof for a cloud with zero applicable steps — that must be an error, not an empty pass")
	}
}

// validProbe is a minimal well-formed probe, used as the control in the mutation cases above so
// each one isolates the rule it names rather than tripping the missing-SatisfiedBy rule.
func validProbe() *CeilingProbe {
	return &CeilingProbe{Kind: ProbeEnvTruthy, Env: []string{"CEILING_PROBE_TEST_CONTROL"}, Expect: "a maintainer sets it"}
}
