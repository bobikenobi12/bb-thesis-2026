// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The PURE half of the CLI-demo provisioning bar: it holds the beat table to the step table
// WITHOUT a cloud, so the accounting cannot rot between paid runs.
//
// Deliberately untagged, like t2_cli_demo_pure_test.go, so ci.yml runs it on every PR. The
// expensive half proves the beats WORK; this one proves they are the right beats and that none has
// gone missing — and that is the half that would otherwise only be discovered on stage.

import (
	"strings"
	"testing"
)

// TestCLIDemoBeatsAccountForEveryDrivenStep is the whole contract: every CLIDriven step is either
// performed by a beat or has a written reason it is not. Never both, never neither.
func TestCLIDemoBeatsAccountForEveryDrivenStep(t *testing.T) {
	if err := ValidateCLIDemoBeats(); err != nil {
		t.Fatal(err)
	}
}

// TestCLIDemoBeatsAreNotVacuous — the check above passes trivially if both tables are empty, which
// is exactly how a guard reports green on nothing. Assert the work exists.
//
// The floor is deliberately loose (a count, not a list): pinning the exact set here would mean
// editing this test every time a beat is added, which is the hand-maintained-allowlist shape that
// let `vault-bootstrap` go unregistered for two releases. What must not happen is the table
// EMPTYING, and a floor catches that.
func TestCLIDemoBeatsAreNotVacuous(t *testing.T) {
	if len(CLIDemoBeats) < 10 {
		t.Errorf("only %d beat(s) — the demo is an empty account to a torn-down cluster; that is not it", len(CLIDemoBeats))
	}
	if len(cliDemoNotDriven) == 0 {
		t.Error("nothing is recorded as not-driven, yet `login` cannot be performed by a binary — the exception has gone missing")
	}
	for _, b := range CLIDemoBeats {
		if b.Args == nil {
			t.Errorf("beat %q has no Args", b.StepID)
			continue
		}
		// Build the argv against a zero run. It may reference empty ids — what must not happen is a
		// beat that produces NO command at all, which would exit 0 having run nothing.
		if got := b.Args(&CLIDemoRun{}); len(got) == 0 {
			t.Errorf("beat %q builds an empty argv — it would perform nothing and pass", b.StepID)
		}
	}
}

// TestCLIDemoNotDrivenReasonsAreReasons — an entry that says "n/a" is indistinguishable from an
// oversight, and the entire value of the not-driven list is that a reader can DISAGREE with it.
func TestCLIDemoNotDrivenReasonsAreReasons(t *testing.T) {
	for id, why := range cliDemoNotDriven {
		if len(strings.Fields(why)) < 8 {
			t.Errorf("step %q is excluded with %q — too short to be a reason anyone could argue with", id, why)
		}
	}
}

// TestCLIDemoBeatsEndTornDown — a demo that provisions and does not destroy is a standing bill, and
// the orphan reaper would find it before anyone read the report. The LAST beat must be the destroy.
//
// Asserted on the order rather than on mere presence: a destroy that is not last has beats running
// after the cluster is gone, which is a different (and confusing) failure.
func TestCLIDemoBeatsEndTornDown(t *testing.T) {
	if len(CLIDemoBeats) == 0 {
		t.Fatal("no beats")
	}
	if last := CLIDemoBeats[len(CLIDemoBeats)-1].StepID; last != "destroy" {
		t.Errorf("the last beat is %q, not \"destroy\" — a demo that does not tear down leaves a standing bill", last)
	}
}

// TestCLIDemoBeatsApplyBeforeTheStepsThatReadIt pins the ORDER the demo depends on: everything that
// addresses the apply's job id or the running cluster must come after the apply, and the apply
// after the project exists.
//
// This is not pedantry about sequence. `jobs logs <id>` with an id no beat has minted yet would run
// against the empty string, and the CLI would report "job not found" — a red that reads like a
// product defect and is actually a table-ordering mistake.
func TestCLIDemoBeatsApplyBeforeTheStepsThatReadIt(t *testing.T) {
	pos := map[string]int{}
	for i, b := range CLIDemoBeats {
		pos[b.StepID] = i
	}
	mustPrecede := [][2]string{
		{"project-create", "component-add"},
		{"project-create", "plan"},
		{"plan", "apply"},
		{"apply", "jobs-logs"},
		{"apply", "cluster-get"},
		{"apply", "receipt-verify"},
		{"apply", "destroy"},
	}
	for _, pair := range mustPrecede {
		before, after := pair[0], pair[1]
		bi, bok := pos[before]
		ai, aok := pos[after]
		if !bok || !aok {
			// Not an error here: whether a step is driven at all is TestCLIDemoBeatsAccountFor…'s
			// question, and reporting it twice would send two issues at one cause.
			continue
		}
		if bi >= ai {
			t.Errorf("beat %q (position %d) must come before %q (position %d) — the later beat reads what the earlier one mints",
				before, bi, after, ai)
		}
	}
}

// ── THE CLOUD AXIS (#4083) ────────────────────────────────────────────────────────────────────
//
// Every test above builds each beat's argv against a ZERO run, and a zero run has no provider. That
// is not a gap in one test; it is a whole axis nothing in the pure half varied, and it is the axis
// `connector` differs on. A `connector` beat that hardcoded hetzner's `--token-stdin` for all five
// clouds passed this entire file for as long as it existed.
//
// These tests vary it. What they cannot ask is whether a flag is REGISTERED — that needs the binary
// and is asked before spend by AssertCLIDemoBeatFlagsAreRegistered.

// cliDemoBeatByID returns the named beat. Fatal when it is missing: a test that silently examined no
// beat is the "nothing found" branch reporting as the "nothing wrong" one.
func cliDemoBeatByID(t *testing.T, id string) CLIDemoBeat {
	t.Helper()
	for _, b := range CLIDemoBeats {
		if b.StepID == id {
			return b
		}
	}
	t.Fatalf("no beat %q in CLIDemoBeats — this test examined nothing", id)
	return CLIDemoBeat{}
}

// cliDemoConnectorFlagNames returns the flag NAMES one cloud's connector row emits. Values are
// dropped: they come from the ambient environment and are empty in a pure test, which is fine —
// nothing here is about the values.
func cliDemoConnectorFlagNames(t *testing.T, provider string) []string {
	t.Helper()
	build, ok := cliDemoConnectorFlags[provider]
	if !ok {
		t.Fatalf("cliDemoConnectorFlags has no row for %q", provider)
	}
	var names []string
	for _, tok := range build() {
		if strings.HasPrefix(tok, "--") {
			names = append(names, tok)
		}
	}
	return names
}

// TestCLIDemoConnectorBeatIsPerCloud pins the shape of the fix rather than its contents: on every
// cloud the harness can dispatch, the connector beat must name THAT cloud's command and carry at
// least one flag that is not the global `--no-input`.
//
// The provider list is derived from t2ProviderTable, so a sixth cloud fails here — which is the
// point. `connector <newcloud> --no-input` would parse, reach the command, and die naming a flag
// nobody had written; this says so first, for free.
func TestCLIDemoConnectorBeatIsPerCloud(t *testing.T) {
	beat := cliDemoBeatByID(t, "connector")
	providers := t2ProviderNames()
	if len(providers) < 2 {
		t.Fatalf("t2ProviderTable holds %d provider(s) — there is no cloud axis to vary, and this test "+
			"would pass having compared nothing", len(providers))
	}
	for _, provider := range providers {
		argv := beat.Args(&CLIDemoRun{Provider: provider})
		if len(argv) < 2 || argv[0] != "connector" || argv[1] != provider {
			t.Errorf("the connector beat on %s builds `alethia %s` — it must name `connector %s`",
				provider, strings.Join(argv, " "), provider)
			continue
		}
		specific := 0
		for _, tok := range argv[2:] {
			if strings.HasPrefix(tok, "--") && tok != "--no-input" {
				specific++
			}
		}
		if specific == 0 {
			t.Errorf("the connector beat on %s carries no cloud-specific flag (`alethia %s`). Under "+
				"--no-input that command refuses, naming a flag this table never passed.",
				provider, strings.Join(argv, " "))
		}
	}
}

// TestCLIDemoConnectorRowsDoNotBorrowAnotherCloudsFlag is the #4083 regression, stated as the class
// rather than as the instance.
//
// The forbidden set is DERIVED from the other rows of cliDemoConnectorFlags, not typed here, so it
// grows with the table: any flag that belongs to a different cloud's connector — today
// `--token-stdin`, `--wif-config`, `--tenant-id` — reds the row that borrowed it. A hand-written
// `--token-stdin` check would have covered exactly the one mistake already made.
//
// A flag genuinely shared by two clouds (aws and alibaba both take `--role-arn`) is not a borrowing,
// so a name that appears in the row under test is never held against it.
func TestCLIDemoConnectorRowsDoNotBorrowAnotherCloudsFlag(t *testing.T) {
	providers := t2ProviderNames()
	if len(providers) < 2 {
		t.Fatalf("only %d provider(s) — nothing to cross-check", len(providers))
	}
	// The ARGV is what reaches cobra, so the argv is what is checked — not the row it was built
	// from. A beat that appended a flag of its own would be invisible to a row-vs-row comparison.
	beat := cliDemoBeatByID(t, "connector")
	for _, provider := range providers {
		own := map[string]bool{}
		for _, name := range cliDemoConnectorFlagNames(t, provider) {
			own[name] = true
		}
		foreign := map[string]string{}
		for _, other := range providers {
			if other == provider {
				continue
			}
			for _, name := range cliDemoConnectorFlagNames(t, other) {
				if !own[name] {
					foreign[name] = other
				}
			}
		}
		for _, tok := range beat.Args(&CLIDemoRun{Provider: provider}) {
			if owner, bad := foreign[tok]; bad {
				t.Errorf("the connector beat on %s passes %s, which `connector %s` registers and "+
					"`connector %s` does not — cobra rejects an unknown flag and the beat dies "+
					"before it performs anything", provider, tok, owner, provider)
			}
		}
	}
}

// TestCLIDemoIssuerTrustAnswersForEveryCloud holds the refusal table to the provider table.
//
// Three ways it fails, and the third is the one that matters: a table where EVERY cloud is blocked
// would refuse every dispatch and read as "there is nothing to run here" rather than as a broken
// table. A guard's all-clear and its all-stop must both be reachable, or neither carries a signal.
func TestCLIDemoIssuerTrustAnswersForEveryCloud(t *testing.T) {
	providers := t2ProviderNames()
	if len(providers) == 0 {
		t.Fatal("no providers — this test compared nothing")
	}
	drivable := 0
	for _, provider := range providers {
		why, ok := cliDemoConnectorIssuerTrust[provider]
		if !ok {
			t.Errorf("cliDemoConnectorIssuerTrust has no key for %q — an absent answer and \"this cloud "+
				"is fine\" must not be the same map lookup", provider)
			continue
		}
		if why == "" {
			drivable++
			continue
		}
		if len(strings.Fields(why)) < 8 {
			t.Errorf("cliDemoConnectorIssuerTrust[%q] is %q — too short to be a reason anyone could "+
				"argue with", provider, why)
		}
	}
	if drivable == 0 {
		t.Error("every cloud is recorded as blocked — the dimension could then never drive its connector " +
			"beat anywhere, and the refusal would be indistinguishable from the dimension being off")
	}
}
