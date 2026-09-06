// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package validate

import (
	"strings"
	"testing"
)

// TestSpecsIsNotEmpty is the vacuity floor for every other test in this file: a green run over an
// empty Specs map proves nothing at all.
func TestSpecsIsNotEmpty(t *testing.T) {
	if len(Specs) == 0 {
		t.Fatal("Specs is empty — regenerate with `pnpm -C apps/console run gen:go-validation`")
	}
	for id, spec := range Specs {
		if len(spec.Steps) == 0 {
			t.Errorf("spec %q has no steps; it would report the field as validated while checking nothing", id)
		}
		if spec.ID != id {
			t.Errorf("spec keyed %q carries ID %q", id, spec.ID)
		}
	}
}

// TestEverySpecRuleResolves is the BUILD-time counterpart to Check's runtime tolerance.
//
// Check deliberately skips a step it cannot evaluate, because failing closed in a client-side
// pre-check would refuse input the server accepts. That tolerance is only safe if something else
// notices — this is that something.
func TestEverySpecRuleResolves(t *testing.T) {
	for id, spec := range Specs {
		if missing := UnresolvedRules(spec); len(missing) > 0 {
			t.Errorf("spec %q references things this build cannot evaluate:\n  %s", id, strings.Join(missing, "\n  "))
		}
	}
}

// TestCheckSkipsAnUnknownRuleAndUnresolvedRulesReportsIt drives BOTH halves of the tolerance above.
// Asserting only that Check stays quiet would be satisfied by a Check that always stays quiet.
func TestCheckSkipsAnUnknownRuleAndUnresolvedRulesReportsIt(t *testing.T) {
	spec := Spec{
		ID:    "synthetic",
		Steps: []Step{{Kind: StepRule, Severity: SeverityReject, Rule: "a_rule_this_build_does_not_have"}},
	}
	if findings := Check(spec, "anything"); len(findings) != 0 {
		t.Errorf("an unknown rule produced %d finding(s); a client-side pre-check must never refuse what it cannot judge", len(findings))
	}
	missing := UnresolvedRules(spec)
	if len(missing) != 1 || !strings.Contains(missing[0], "a_rule_this_build_does_not_have") {
		t.Errorf("UnresolvedRules should name the missing rule, got %v", missing)
	}

	// The same shape with a rule that DOES resolve must produce a finding, or the assertion above
	// is satisfied by a Check that never reports anything.
	real := Spec{
		ID:    "synthetic",
		Steps: []Step{{Kind: StepRule, Severity: SeverityReject, Rule: "not_reserved_tfvar_key"}},
	}
	if findings := Check(real, "alethia_project_id"); len(findings) != 1 {
		t.Errorf("a resolvable rule produced %d finding(s), want 1", len(findings))
	}
}

// TestCheckSkipsAPatternRE2CannotCompile — same tolerance, different step kind, and the same
// requirement that UnresolvedRules says so.
func TestCheckSkipsAPatternRE2CannotCompile(t *testing.T) {
	spec := Spec{
		ID:    "synthetic",
		Steps: []Step{{Kind: StepPattern, Severity: SeverityReject, Pattern: "(?=lookahead)"}},
	}
	if findings := Check(spec, "anything"); len(findings) != 0 {
		t.Errorf("an uncompilable pattern produced %d finding(s), want 0", len(findings))
	}
	if missing := UnresolvedRules(spec); len(missing) != 1 {
		t.Errorf("UnresolvedRules should name the uncompilable pattern, got %v", missing)
	}
}

// TestTheTransformRunsBeforeTheStepsThatFollowIt.
//
// The apps_path spec is transform -> max_length(512) -> grammar. A 512-character path surrounded by
// spaces is 516 characters as typed, so a Go side that applied the bound to the RAW value would
// refuse a path the server trims and accepts. That is the exact shape the invariant forbids, so it
// gets its own test rather than riding along inside a table.
func TestTheTransformRunsBeforeTheStepsThatFollowIt(t *testing.T) {
	spec, ok := Get("apps_path")
	if !ok {
		t.Fatal("no apps_path spec")
	}
	atBound := strings.Repeat("a", 512)
	if findings := Check(spec, "  "+atBound+"  "); len(findings) != 0 {
		t.Errorf("a padded path exactly at the bound was refused: %+v", findings)
	}
	// And the bound is still the one enforced — otherwise the test above passes because nothing is
	// checked at all.
	if findings := Check(spec, "  "+atBound+"a  "); len(findings) == 0 {
		t.Error("a padded path one OVER the bound was accepted")
	}
}

// TestReservedTfvarKeyIsRejected pins WHICH server the CLI is held to.
//
// provisioner.coerceByoVarValues drops a reserved key with a warning rather than failing, and an
// earlier version of this spec said SeverityWarn on that basis. But the CLI never reaches the
// provisioner: it posts to /api/cli/projects/{id}/byo-iac, which refuses a reserved key with a 400.
// Warning would walk the user into a request that dies, so the server the CLI actually talks to is
// the one the severity mirrors.
func TestReservedTfvarKeyIsRejected(t *testing.T) {
	spec, ok := Get("iac_var_key")
	if !ok {
		t.Fatal("no iac_var_key spec")
	}
	findings := Check(spec, "alethia_project_id")
	if len(findings) != 1 {
		t.Fatalf("want exactly one finding for a reserved key, got %+v", findings)
	}
	if !Rejected(findings) {
		t.Errorf("a reserved tfvar key produced %q; the endpoint the CLI posts to refuses it outright", findings[0].Severity)
	}
	// And the spec is not simply rejecting everything.
	if findings := Check(spec, "region"); len(findings) != 0 {
		t.Errorf("an ordinary tfvar name was refused: %+v", findings)
	}
}

// TestTheKeyTransformRunsBeforeTheGrammar.
//
// `iacVarKeySchema` is `.trim().min(1).regex(...)`, so the console judges — and stores — the
// TRIMMED key. The first version of this PR declared that trim `not-shared`, which emitted no step
// and left this side running the pattern against the RAW value: ` region` was accepted by the
// console and refused by the CLI. That is the CLI refusing what the server accepts, the one
// direction the invariant forbids, so it gets its own test rather than riding along in a table.
func TestTheKeyTransformRunsBeforeTheGrammar(t *testing.T) {
	spec, ok := Get("iac_var_key")
	if !ok {
		t.Fatal("no iac_var_key spec")
	}
	if findings := Check(spec, " region"); len(findings) != 0 {
		t.Errorf("a padded tfvar name was refused: %+v — the console accepts it and stores \"region\"", findings)
	}
	// The grammar is still enforced, so the assertion above is not passing because nothing is.
	if !Rejected(Check(spec, "a b")) {
		t.Error("an INTERIOR space was accepted; the trim is swallowing the grammar rather than feeding it")
	}
}

// TestRejectedDistinguishesWarnFromReject.
//
// No SHIPPED spec carries SeverityWarn today — `iac_var_key` did until the endpoint it maps to
// started refusing the key. The severity is still part of the emitted contract for the next rule
// whose server-side disposition is a drop, so the discrimination is exercised here on a synthetic
// spec rather than left to be discovered wrong the first time it matters.
func TestRejectedDistinguishesWarnFromReject(t *testing.T) {
	warn := Spec{ID: "synthetic", Steps: []Step{{Kind: StepRule, Severity: SeverityWarn, Rule: "not_reserved_tfvar_key"}}}
	findings := Check(warn, "alethia_project_id")
	if len(findings) != 1 {
		t.Fatalf("want one finding, got %+v", findings)
	}
	if Rejected(findings) {
		t.Error("Rejected() said yes for a warn-only finding")
	}

	reject := Spec{ID: "synthetic", Steps: []Step{{Kind: StepRule, Severity: SeverityReject, Rule: "not_reserved_tfvar_key"}}}
	if !Rejected(Check(reject, "alethia_project_id")) {
		t.Error("Rejected() said no for a reject finding")
	}
}

// TestCheckOnTheRealSpecs pins one accept and one refuse per shipped spec, named by what the case
// is about rather than by an index.
func TestCheckOnTheRealSpecs(t *testing.T) {
	cases := []struct {
		name     string
		spec     string
		value    string
		rejected bool
	}{
		{"an overlay path is fine", "apps_path", "overlays/dev", false},
		{"an empty apps path means the repo root", "apps_path", "", false},
		{"a traversal is refused", "apps_path", "../../etc", true},
		{"an ordinary tfvar name is fine", "iac_var_key", "region", false},
		{"an empty tfvar name is refused", "iac_var_key", "", true},
		{"aws accepts its floor", "network_cidr_block.aws", "10.0.0.0/18", false},
		{"aws refuses the /24 the AI tool used to hand out", "network_cidr_block.aws", "10.0.0.0/24", true},
		{"hetzner accepts a /22 that aws would refuse", "network_cidr_block.hetzner", "10.0.0.0/22", false},
		{"aws refuses that same /22", "network_cidr_block.aws", "10.0.0.0/22", true},
		{"gcp has no floor, so a /29 is fine", "network_cidr_block.gcp", "10.0.0.0/29", false},
		{"an unset network is the template default everywhere", "network_cidr_block.aws", "", false},
		{"a value that is not a CIDR is refused", "network_cidr_block.aws", "not-a-cidr", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			spec, ok := Get(c.spec)
			if !ok {
				t.Fatalf("no spec %q", c.spec)
			}
			findings := Check(spec, c.value)
			if got := Rejected(findings); got != c.rejected {
				t.Errorf("Check(%q, %q) rejected=%v, want %v (findings: %+v)", c.spec, c.value, got, c.rejected, findings)
			}
		})
	}
}

// TestLengthStepsCountRunes — the console counts UTF-16 code units and Go's `len` counts bytes;
// this package counts runes, which is the only one of the three that matches "characters" as a user
// would count them. The difference is unreachable for apps_path (its grammar is ASCII-only) but the
// step kind is generic, so the unit it uses is worth pinning.
func TestLengthStepsCountRunes(t *testing.T) {
	four := 4
	spec := Spec{ID: "synthetic", Steps: []Step{{Kind: StepMaxLength, Severity: SeverityReject, Length: &four}}}
	if findings := Check(spec, "ünïcö"); len(findings) == 0 {
		t.Error("five runes passed a max of four")
	}
	if findings := Check(spec, "ünïc"); len(findings) != 0 {
		t.Errorf("four runes (eight bytes) failed a max of four — the step is counting bytes: %+v", findings)
	}
}

// TestAcceptsAnAbsentValueOnlyWhereTheSchemaSaysSo — Optional/Nullable are the only two things in a
// projected spec that speak about an ABSENT value, so this is what makes them load-bearing rather
// than emitted.
func TestAcceptsAnAbsentValueOnlyWhereTheSchemaSaysSo(t *testing.T) {
	appsPath, ok := Get("apps_path")
	if !ok {
		t.Fatal("no apps_path spec")
	}
	if !appsPath.Optional || !appsPath.Nullable {
		t.Fatalf("apps_path is `.nullish()` in the console; the spec says Optional=%v Nullable=%v", appsPath.Optional, appsPath.Nullable)
	}
	if findings := Accepts(appsPath, nil); len(findings) != 0 {
		t.Errorf("an unset apps_path was refused: %+v — unset means the repository root", findings)
	}

	varKey, ok := Get("iac_var_key")
	if !ok {
		t.Fatal("no iac_var_key spec")
	}
	if varKey.Optional || varKey.Nullable {
		t.Fatalf("iac_var_key is a plain required string; the spec says Optional=%v Nullable=%v", varKey.Optional, varKey.Nullable)
	}
	findings := Accepts(varKey, nil)
	if len(findings) != 1 || !Rejected(findings) {
		t.Errorf("an absent tfvar name produced %+v, want one rejecting finding", findings)
	}

	// A present value still goes through Check, so the nil branch above is not the whole function.
	present := "alethia_project_id"
	if got := Accepts(varKey, &present); len(got) != 1 || !Rejected(got) {
		t.Errorf("Accepts did not fall through to Check for a present value: %+v", got)
	}
}
