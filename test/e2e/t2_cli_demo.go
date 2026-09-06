// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The CLI-ONLY DEMO surface — one legible table that IS the answer to "can the whole product be
// driven from the terminal, and where can it not?"
//
// Every other T2 surface asks whether the PLATFORM works. This one asks whether the PRODUCT is
// reachable: a prospect watching a demo must get from an empty account to a running, verified,
// torn-down cluster using `alethia` alone. A step that needs a console click is a failure of that
// claim even when the platform underneath it is perfect — and, until this file existed, nothing in
// the repo asserted it. The console-only gaps were discoverable only by trying, one at a time, in
// front of an audience.
//
// Deliberately UNTAGGED (like t2_day2_offer.go / t2_day2_access.go) so the table's well-formedness
// is unit-tested WITHOUT a cloud (t2_cli_demo_pure_test.go, which ci.yml runs) and `go mod tidy`
// sees its deps. The real-cloud half is t2_cli_demo_run_test.go behind `e2e_t2`.
//
// WHY THE STEP IS A TYPED VERDICT AND NOT A BOOLEAN. "CLI-driven: yes/no" collapses three facts
// that call for three different actions, and collapsing them is how a gap stops being counted:
//
//   - the CLI cannot reach something the product genuinely does      → OUR debt, file an issue
//   - the CLOUD offers no API for it at all                          → a ceiling, file it anyway
//   - it is console-only ON PURPOSE (an approval a human must see)   → not a gap; must say why
//
// The maintainer's ruling for the investor benchmark is that the first two BOTH score FAIL — a
// prospect does not care whose fault the click is. But they are still recorded apart, because the
// remedies differ and a merged list is exactly how `MaxConfigStateProof` once let two chart-backed
// kinds hide inside a "the cloud cannot do this" sentence (see maxconfig.go's DeferredInProduct).
//
// Opt-in via ALETHIA_E2E_CLI_DEMO=1.
//
// ⚠️ THIS BAR REDS THE PROVISIONING CELL, NOT JUST THE CLI BOARD. The workflow runs the CLI-only
// demo step inside the SAME job as the real-cloud provisioning proof (e2e-nightly.yml, "CLI-only
// demo bar (reachability — no cloud, no spend)"), so a FAILING bar fails the job, and the nightly
// rollup records that leg as RED however well the cluster itself came up.
//
// gcp/maxconfig run 33107356336 is the worked example: A0.6 proven, all five Applications
// Healthy+Synced, ALL ELEVEN max-config kinds in tofu state, day-2 access proven on nine nodes —
// and the leg still went red, partly because ONE ceiling below said "nobody has done this" about
// work that had in fact been done and merely never attested.
//
// So an unsatisfied ceiling here is not a scoreboard footnote; it is a spend decision. Keep the
// SatisfiedBy probes honest in BOTH directions: a ceiling that is met and still reads unmet burns a
// paid run, and one that reads met while unmet turns a cloud gap into a green cell.

import (
	"fmt"
	"os"
	"sort"
	"strings"
)

// CLIReach is WHY one demo step is or is not reachable from `alethia` — the verdict for a step.
// A closed set of exactly four; the zero value is deliberately NOT one of them, so a step nobody
// filled in fails loudly instead of reading as "pending".
type CLIReach string

const (
	// CLIDriven — the step completes through `alethia`, with no console and no cloud portal. The
	// claim is checked, not asserted: the run half executes `alethia <Argv...> --help` and a
	// non-zero exit means the table is lying about a command that does not exist.
	CLIDriven CLIReach = "cli"
	// CLIGap — the product genuinely does this, and the CLI cannot reach it. OUR debt. Requires an
	// Issue (so it is tracked) and a WantArgv naming the command that SHOULD exist — which the run
	// half asserts still does NOT resolve. That inversion is the ratchet: the day somebody ships
	// the command, this test goes red and forces the table to record the win. A gap that silently
	// stays listed after it is fixed is worse than no list, because it understates the product.
	CLIGap CLIReach = "cli_gap"
	// CloudManual — no API exists on the cloud side; a human must open that cloud's console. Not
	// our defect, and still a FAIL for the demo bar: the prospect watching cannot tell the
	// difference, and neither can their procurement team. Requires an Issue and a Why.
	//
	// Read "no API exists" literally. If the cloud has an API and we simply have not called it,
	// that is CLIGap. Hetzner Object Storage keys are the real CloudManual case: Hetzner ships no
	// endpoint that mints them, so a human creates them in the console or the bucket kind cannot
	// be provisioned at all.
	CloudManual CLIReach = "cloud_manual"
	// ConsoleOnly — deliberately not in the CLI, and that is the design. A human-in-the-loop
	// approval whose whole value is that a person SAW it does not belong behind a scriptable verb.
	// Requires a Why, and the Why must survive being read aloud to a skeptic: this verdict is the
	// one an author reaches for to make a red table green, so it carries the burden of proof.
	ConsoleOnly CLIReach = "console_only"
)

// DemoStep is ONE step of the end-to-end demo and its reachability verdict. Build the table below
// in the order a demo actually runs — the sequence is part of the claim, and a reader should be
// able to follow it top to bottom as a script.
type DemoStep struct {
	// ID is the stable handle used in the ledger row and for issue dedup. Never renamed once
	// filed: the issue title derives from it.
	ID string
	// Title is the phrase a human would use for this step.
	Title string
	// Argv is the `alethia` command path proving the step, WITHOUT the binary name —
	// e.g. {"project", "apply"}. CLIDriven only, and required there.
	Argv []string
	// WantArgv is the command that SHOULD exist but does not. CLIGap only, and required there.
	// The run half asserts it still fails to resolve.
	WantArgv []string
	// Reach is the verdict. Empty = the step was never filled in ⇒ a hard error, not a skip.
	Reach CLIReach
	// Why documents a non-CLIDriven verdict. Required for CLIGap, CloudManual and ConsoleOnly:
	// an exclusion nobody can read is indistinguishable from an oversight.
	Why string
	// Issue is the tracking issue. Required for CLIGap and CloudManual — the maintainer's ruling
	// is that every one of these is filed, so a verdict without a number is an unkept promise.
	//
	// WHETHER IT MUST STILL BE OPEN DEPENDS ON THE VERDICT, and the maintainer's ruling on #3591
	// is that the two differ:
	//
	//	CLIGap      → the tracker must be OPEN.
	//	CloudManual → the tracker need only be FILED. A closed one is fine.
	//
	// A CLIGap is OUR debt — the product does this and the CLI cannot reach it — and debt must be
	// able to CLOSE. Letting its tracker close while the gap still stands is exactly how debt
	// becomes permanent by being forgotten, which is the failure the must-be-OPEN rule on
	// addon_exclusions.go's Issue field exists to prevent. Same failure, same rule.
	//
	// A CloudManual is a FACT ABOUT A CLOUD. The ceiling does not lift because somebody closed the
	// issue: #2332 (hetzner ships no API that mints Object Storage keys) and #2333 (a prepaid CR EE
	// instance is released in a console) are permanent, and both are closed today. Requiring OPEN
	// here would red the build over entries that are legitimately closed, and reopening them to
	// satisfy a guard would be the guard editing reality to match itself.
	//
	// Enforced by scripts/check-exclusion-issues.mjs, which needs the network and therefore cannot
	// live in this package's pure tests. Shape is checked here (TestCLIDemoGapsAndCeilingsAreFiled);
	// state is checked there.
	Issue string
	// Clouds narrows the step to specific clouds. Empty means every cloud. Used by the per-cloud
	// prerequisites that only one provider imposes.
	Clouds []string
	// SatisfiedBy is the evidence that a CloudManual step's manual work HAS been done. Required
	// for CloudManual and forbidden everywhere else. See t2_cli_ceiling.go for why a ceiling is
	// two claims rather than one.
	SatisfiedBy *CeilingProbe
	// ProbeReading is what the probe actually read, filled in by EvaluateCeilings for a ceiling
	// that came back UNSATISFIED. Never set on the table itself — it is a run-time observation,
	// and the summary prints it so an unsatisfied ceiling says why, not merely that.
	ProbeReading string
}

// AppliesTo reports whether this step is in scope for the given cloud.
func (s DemoStep) AppliesTo(cloud string) bool {
	if len(s.Clouds) == 0 {
		return true
	}
	for _, c := range s.Clouds {
		if c == cloud {
			return true
		}
	}
	return false
}

// Validate is the read-back that makes the verdict load-bearing. Every rule here exists because
// the opposite shape would let a step claim a verdict it has not earned.
func (s DemoStep) Validate() error {
	if s.ID == "" {
		return fmt.Errorf("step has no ID — the ledger row and the issue title both derive from it")
	}
	if s.Title == "" {
		return fmt.Errorf("step %q has no Title", s.ID)
	}
	if s.Reach != CloudManual && s.SatisfiedBy != nil {
		return fmt.Errorf("step %q: verdict %q must not carry SatisfiedBy — only a cloud ceiling has manual work to be satisfied, and a probe anywhere else would score a step on something other than its verdict", s.ID, s.Reach)
	}
	if s.ProbeReading != "" {
		return fmt.Errorf("step %q: ProbeReading is a run-time observation and must not be set on the table", s.ID)
	}
	switch s.Reach {
	case CLIDriven:
		if len(s.Argv) == 0 {
			return fmt.Errorf("step %q: verdict %q must name the Argv that proves it — an unproven claim of CLI coverage is the whole defect this table exists to prevent", s.ID, s.Reach)
		}
		if len(s.WantArgv) > 0 {
			return fmt.Errorf("step %q: verdict %q must not carry WantArgv — the command exists, so there is nothing to want", s.ID, s.Reach)
		}
		if s.Issue != "" {
			return fmt.Errorf("step %q: verdict %q must not name an Issue (%s) — a working step has nothing to track", s.ID, s.Reach, s.Issue)
		}
	case CLIGap:
		if len(s.WantArgv) == 0 {
			return fmt.Errorf("step %q: verdict %q must name the WantArgv it lacks — without it nothing can detect the day the gap closes, and a stale gap understates the product", s.ID, s.Reach)
		}
		if len(s.Argv) > 0 {
			return fmt.Errorf("step %q: verdict %q must not carry Argv — the claim IS that no command reaches it", s.ID, s.Reach)
		}
		if s.Issue == "" {
			return fmt.Errorf("step %q: verdict %q needs an Issue — an untracked gap is a silent gap", s.ID, s.Reach)
		}
		if s.Why == "" {
			return fmt.Errorf("step %q: verdict %q needs a Why", s.ID, s.Reach)
		}
	case CloudManual:
		if len(s.Argv) > 0 || len(s.WantArgv) > 0 {
			return fmt.Errorf("step %q: verdict %q must be empty of Argv/WantArgv — no command on either side can reach an API that does not exist", s.ID, s.Reach)
		}
		if s.Issue == "" {
			return fmt.Errorf("step %q: verdict %q needs an Issue — the ruling is that a cloud ceiling is filed too, precisely because it is nobody's sprint work by default", s.ID, s.Reach)
		}
		if s.Why == "" {
			return fmt.Errorf("step %q: verdict %q needs a Why naming the missing API", s.ID, s.Reach)
		}
		if err := s.SatisfiedBy.Validate(s.ID); err != nil {
			return err
		}
	case ConsoleOnly:
		if len(s.Argv) > 0 || len(s.WantArgv) > 0 {
			return fmt.Errorf("step %q: verdict %q must be empty of Argv/WantArgv", s.ID, s.Reach)
		}
		if s.Why == "" {
			return fmt.Errorf("step %q: verdict %q needs a Why — this is the verdict that turns a red table green, so it carries the burden of proof", s.ID, s.Reach)
		}
	case "":
		return fmt.Errorf("step %q states no verdict — every step must be one of %q, %q, %q or %q. "+
			"The zero value is invalid ON PURPOSE: an unfilled step used to read as 'pending' and was counted as neither pass nor fail",
			s.ID, CLIDriven, CLIGap, CloudManual, ConsoleOnly)
	default:
		return fmt.Errorf("step %q has unknown verdict %q", s.ID, s.Reach)
	}
	return nil
}

// DemoClouds are the clouds the demo bar is scored against.
var DemoClouds = []string{"aws", "gcp", "azure", "alibaba", "hetzner"}

// CLIDemoSteps is the demo, in the order it is performed. Read it top to bottom and you have the
// script; read the verdict column and you have the honest answer to "can this be done from the
// terminal?".
//
// The order matters beyond readability: a step that depends on an earlier one cannot be scored
// independently, so the run half executes them in sequence and stops at the first hard failure.
var CLIDemoSteps = []DemoStep{
	{
		ID:    "login",
		Title: "Authenticate a fresh machine",
		Argv:  []string{"login"},
		Reach: CLIDriven,
	},
	{
		ID:    "whoami",
		Title: "Confirm the identity and active org",
		Argv:  []string{"whoami"},
		Reach: CLIDriven,
	},
	{
		ID:    "org-switch",
		Title: "Select the org the demo runs in",
		Argv:  []string{"org", "switch"},
		Reach: CLIDriven,
	},
	{
		ID:    "connector",
		Title: "Attach a cloud account, keyless",
		Argv:  []string{"connector"},
		Reach: CLIDriven,
		Why:   "one subcommand per cloud (connector aws|gcp|azure|alibaba|hetzner); hetzner arrived last, in #2316",
	},
	{
		ID:    "project-create",
		Title: "Create the project",
		Argv:  []string{"project", "create"},
		Reach: CLIDriven,
	},
	{
		ID:    "project-env",
		Title: "Add an environment and place it",
		Argv:  []string{"project", "env", "add"},
		Reach: CLIDriven,
		Why:   "placement landed in #2313 — a two-tier project stops costing two clusters",
	},
	{
		ID:    "component-kinds",
		Title: "Discover what this cloud offers",
		Argv:  []string{"project", "component", "kinds"},
		Reach: CLIDriven,
	},
	{
		ID:    "component-add",
		Title: "Author the components",
		Argv:  []string{"project", "component", "add"},
		Reach: CLIDriven,
	},
	{
		ID:    "staged",
		Title: "Review what is about to change",
		Argv:  []string{"staged", "list"},
		Reach: CLIDriven,
	},
	{
		ID:    "plan",
		Title: "Plan — and watch the verify gate run between plan and apply",
		Argv:  []string{"project", "plan"},
		Reach: CLIDriven,
	},
	{
		ID:    "apply",
		Title: "Apply",
		Argv:  []string{"project", "apply"},
		Reach: CLIDriven,
	},
	{
		ID:    "jobs-logs",
		Title: "Follow the provision live",
		Argv:  []string{"jobs", "logs"},
		Reach: CLIDriven,
	},
	{
		ID:    "cluster-get",
		Title: "Read the finished cluster back",
		Argv:  []string{"cluster", "get"},
		Reach: CLIDriven,
	},
	{
		ID:    "receipt-verify",
		Title: "Show the signed evidence receipt and check its signature",
		Argv:  []string{"verify", "receipt"},
		Reach: CLIDriven,
		Why: "Closed by #2331. `alethia verify receipt --job <id>` pulls the receipt, checks its ed25519 " +
			"signature against a key the control plane VOUCHES for — the org's own recorded key or the " +
			"platform key, not merely the public key the receipt carries about itself — and exits non-zero " +
			"when it cannot, so a customer can gate their own pipeline on it. `alethia verify show` prints " +
			"the per-control report behind the verdict, not_evaluable controls and recorded waivers included",
	},
	{
		ID:    "drift",
		Title: "Show the drift posture",
		Argv:  []string{"drift", "show"},
		Reach: CLIDriven,
	},
	{
		ID:    "iac",
		Title: "Show the generated IaC",
		Argv:  []string{"iac", "show"},
		Reach: CLIDriven,
	},
	{
		ID:    "cost",
		Title: "Show what it costs",
		Argv:  []string{"cost", "show"},
		Reach: CLIDriven,
	},
	{
		ID:    "addons",
		Title: "List the marketplace add-ons that converged",
		Argv:  []string{"addon", "list"},
		Reach: CLIDriven,
	},

	// ── BRING-YOUR-OWN. Everything above is the golden path over Alethia's own templates and
	//    catalog. These four are the customer's OWN code — their Helm chart, their OpenTofu — and
	//    they were absent from this table entirely.
	//
	//    That absence UNDERSTATED the product, which is the failure mode this file's header warns
	//    about in the other direction. The write half shipped in #2321 and nothing here asserted it,
	//    so the whole BYO story was un-ratcheted: the day one of these verbs was renamed, no test
	//    would have noticed.
	//
	//    The credential question is answered and worth stating, because the obvious reading is
	//    wrong. `--git-credential-id` points at `project_git_credentials`, a table NOTHING in the
	//    repo writes — so it looks as though a private repo cannot be reached from the terminal.
	//    It can: the runner fetches a token at job time from the job owner's LINKED OAUTH ACCOUNT
	//    (`/api/jobs/{id}/git-token`), and that route's authorized-repo set already covers both the
	//    BYO chart repos and the BYO IaC repo. So these are genuinely CLIDriven, and the inert flag
	//    was a separate defect rather than a gap in CLI coverage — REMOVED in #2788, which also put
	//    the OAuth answer into the attach verbs' own help, where the user asking the question is. ──
	{
		ID:    "chart-attach",
		Title: "Attach a bring-your-own Helm chart to an environment",
		Argv:  []string{"chart", "attach"},
		Reach: CLIDriven,
	},
	{
		ID:    "chart-scan",
		Title: "Scan the bring-your-own chart before it may deploy",
		Argv:  []string{"chart", "scan"},
		Reach: CLIDriven,
	},
	{
		ID:    "iac-attach",
		Title: "Attach a bring-your-own OpenTofu module to an environment",
		Argv:  []string{"iac", "attach"},
		Reach: CLIDriven,
	},
	{
		ID:    "iac-scan",
		Title: "Scan the bring-your-own module — it is not deployable until it passes",
		Argv:  []string{"iac", "scan"},
		Reach: CLIDriven,
	},

	{
		ID:    "promotion-approve",
		Title: "Approve a promotion between environments",
		Reach: ConsoleOnly,
		Why: "`alethia promotion` is list/get only, and the approve verb is deliberately not there: a promotion gate " +
			"whose whole value is that a named human saw and accepted a change must not be scriptable, or it stops " +
			"being a control. `alethia ops approve` exists for break-glass and is audited as such. This is the one " +
			"verdict in the table that is a design decision rather than a gap — if that ever stops being true, it " +
			"becomes a CLIGap, not a quietly-edited Why",
	},
	{
		ID:    "destroy",
		Title: "Tear the whole thing down",
		Argv:  []string{"project", "destroy"},
		Reach: CLIDriven,
	},

	// ── Per-cloud prerequisites. These are not part of the happy path; they are the steps a
	//    prospect would hit BEFORE the flow above can succeed on that cloud, and each one is a
	//    console visit that no API can replace. ──
	{
		ID:     "hetzner-s3-keys",
		Title:  "Mint Hetzner Object Storage credentials",
		Reach:  CloudManual,
		Clouds: []string{"hetzner"},
		Issue:  "#2332",
		Why: "the bucket kind on hetzner is real Object Storage behind the aminueza/minio provider, which " +
			"authenticates from HETZNER_S3_ACCESS_KEY / HETZNER_S3_SECRET_KEY. Hetzner ships NO API that mints " +
			"them — a human creates them in the cloud console. This is the purest CloudManual case in the product: " +
			"there is no call we are failing to make",
		SatisfiedBy: &CeilingProbe{
			Kind: ProbeEnvTruthy,
			// The workflow renders these from `secrets.HETZNER_S3_* != ''`, so what arrives here is
			// the STRING "true" or "false" — never the credential. A probe in this file must not be
			// able to print one even by accident.
			Env:    []string{"ALETHIA_E2E_HETZNER_S3_KEYS_PRESENT"},
			Expect: "a maintainer mints an Object Storage key pair in the Hetzner console and sets the HETZNER_S3_ACCESS_KEY / HETZNER_S3_SECRET_KEY repo secrets (both were set on 2026-08-25)",
		},
	},
	{
		ID:    "dns-delegation",
		Title: "Delegate a public DNS zone so certificates can validate",
		Reach: CloudManual,
		Issue: "#1773",
		Why: "DNS-validated certificates need the validation record to be resolvable on the PUBLIC internet, and " +
			"creating a hosted zone is not the same as being delegated one. Delegation is a registrar action, " +
			"outside every cloud's API. Consequence: the full bar proves the dns kind but NOT the cert path, on " +
			"any cloud — infra/templates/project/aws/modules/acm is switched off for exactly this reason",
		SatisfiedBy: &CeilingProbe{
			Kind: ProbeZoneDelegated,
			// Ask the internet, not ourselves. A hosted zone that exists in an account but that
			// nothing delegates to answers with an EMPTY name-server set, which is exactly the
			// state #1773 described — so an empty answer must read as unsatisfied, not as success.
			Env:    []string{"ALETHIA_E2E_ACM_CERT_ZONE_NAME"},
			Expect: "a registrar/parent-zone NS record delegates the zone named by E2E_ACM_CERT_ZONE_NAME to the e2e account (done for e2e.alethialabs.io — ACM has issued against it, which DNS validation could not have done otherwise)",
		},
	},
	{
		ID:     "gcp-budget-publisher",
		Title:  "Grant the GCP billing-budgets agent its Pub/Sub publisher binding",
		Reach:  CloudManual,
		Clouds: []string{"gcp"},
		Issue:  "#1871",
		Why: "billing-budget-alert@system.gserviceaccount.com needs a publisher binding that must be granted " +
			"out of band in the Cloud Console before the binding can be imported. Until then the budget's " +
			"alerts are undeliverable — the stack's own cost guard is the one resource that does not come up",
		SatisfiedBy: &CeilingProbe{
			Kind: ProbeEnvTruthy,
			// SATISFIED. #1871 is closed, the import is applied, and the binding is live — verified
			// against the cloud rather than the plan:
			//
			//	$ gcloud pubsub topics get-iam-policy …/alethia-e2e-nightly-budget-alerts
			//	roles/pubsub.publisher -> serviceAccount:billing-budget-alert@system.gserviceaccount.com
			//
			// This comment said "#1871 is open and the binding does not exist", which had been false
			// since the import landed. The agent is `billing-budget-alert@`, not `billing-budgets@` —
			// the wrong name is what made it look uncreatable in the first place (#2955), so it is
			// corrected in the Why above too rather than left to mislead the next reader.
			Env:    []string{"ALETHIA_E2E_GCP_BUDGET_PUBLISHER_GRANTED"},
			Expect: "grant billing-budgets@system.gserviceaccount.com the Pub/Sub publisher binding in the Cloud Console budget UI, `tofu import` it behind budget_publisher_binding_enabled, then set the E2E_GCP_BUDGET_PUBLISHER_GRANTED repo variable (#1871)",
		},
	},
	{
		ID:     "alibaba-cr-sweep",
		Title:  "Release the prepaid Container Registry EE instance",
		Reach:  CloudManual,
		Clouds: []string{"alibaba"},
		Issue:  "#2333",
		Why: "the registry kind forces alicloud_cr_ee_instance, which infra/templates/project/alibaba/modules/cr " +
			"creates with payment_type = Subscription. A prepaid instance is not released by tofu destroy the way " +
			"a pay-as-you-go one is, so every full bar leaves a non-cancellable monthly instance behind AND the " +
			"teardown still reports clean. Releasing it is a console action",
		SatisfiedBy: &CeilingProbe{
			Kind: ProbeEnvTruthy,
			// Deliberately NOT satisfiable by #2333 being closed. This ceiling is RECURRING — every
			// full bar buys another prepaid instance — so unlike the other three there is no
			// one-time act that retires it. The variable asserts the sweep ran for THIS cycle.
			Env:    []string{"ALETHIA_E2E_ALIBABA_CR_SWEPT"},
			Expect: "release the prepaid Container Registry EE instance in the Alibaba console after each full bar and set E2E_ALIBABA_CR_SWEPT; this ceiling RECURS, so satisfying it once does not retire it (#2333)",
		},
	},
}

// CLIDemoProof is the outcome of scoring the table for one cloud. The three non-driven lists are
// kept APART on purpose — see the file header. A caller that wants the headline number adds them
// up itself, and in doing so states that it meant to.
type CLIDemoProof struct {
	Cloud string
	// Driven are the step IDs that completed through `alethia`.
	Driven []string
	// Gaps are steps the CLI cannot reach but the product performs — our debt.
	Gaps []DemoStep
	// Manual are steps no cloud API can reach AND that nobody has done — a ceiling that is still
	// outstanding, and a demo failure. A ceiling whose probe reports it satisfied moves to
	// Satisfied and does NOT fail the bar.
	Manual []DemoStep
	// Satisfied are ceilings whose manual work has been done, with the evidence saying so. They
	// are still PRINTED — a prospect deserves to know the manual step exists before they hit it —
	// but they no longer fail the bar, because the thing they describe is not outstanding.
	//
	// ScoreCLIDemo leaves this empty: it is filled only by EvaluateCeilings, which is impure.
	// So a caller that skips the evaluation gets the strict old behaviour, never a laxer one.
	Satisfied []SatisfiedCeiling
	// Console are the deliberate human-in-the-loop steps. NOT a failure.
	Console []DemoStep
}

// Passed reports whether this cloud clears the demo bar: every applicable step driven from the
// CLI, with only deliberate console steps set aside.
//
// Gaps and OUTSTANDING ceilings both fail, per the ruling — a prospect cannot tell whose fault the
// click is. What changed on 2026-08-26 is what "outstanding" means: a ceiling whose SatisfiedBy
// probe reports the manual work DONE has left Manual, so it no longer fails. The expression is
// unchanged; EvaluateCeilings is what moves a step out of Manual, and only positive evidence does
// that. See t2_cli_ceiling.go.
func (p CLIDemoProof) Passed() bool { return len(p.Gaps) == 0 && len(p.Manual) == 0 }

// Verdict renders the one-line ledger verdict.
func (p CLIDemoProof) Verdict() string {
	if p.Passed() {
		v := fmt.Sprintf("PASS — %d/%d steps driven from the CLI (%d deliberate console step(s))",
			len(p.Driven), len(p.Driven)+len(p.Console), len(p.Console))
		if len(p.Satisfied) > 0 {
			// Say it on the headline. A PASS that silently omits the ceilings would read as
			// "this cloud has none", and the next person to hit one would be surprised by it.
			v += fmt.Sprintf(", %d cloud ceiling(s) satisfied", len(p.Satisfied))
		}
		return v
	}
	return fmt.Sprintf("FAIL — %d step(s) the CLI cannot reach, %d the cloud offers no API for and nobody has done (%d driven)",
		len(p.Gaps), len(p.Manual), len(p.Driven))
}

// Summary renders the human-readable block for the proof bundle and the step summary. It names
// every non-driven step with its reason and issue, because a bare count is not actionable and a
// proof bundle nobody can act on is a screenshot.
func (p CLIDemoProof) Summary() string {
	var b strings.Builder
	fmt.Fprintf(&b, "CLI-only demo — %s\n%s\n\n", p.Cloud, p.Verdict())
	fmt.Fprintf(&b, "driven from the CLI (%d): %s\n", len(p.Driven), strings.Join(p.Driven, ", "))
	section := func(title string, steps []DemoStep) {
		if len(steps) == 0 {
			return
		}
		fmt.Fprintf(&b, "\n%s (%d):\n", title, len(steps))
		for _, s := range steps {
			fmt.Fprintf(&b, "  - %s [%s]", s.Title, s.ID)
			if s.Issue != "" {
				fmt.Fprintf(&b, " %s", s.Issue)
			}
			fmt.Fprintf(&b, "\n      %s\n", s.Why)
			// An outstanding ceiling prints what the probe READ and what would satisfy it, so the
			// bundle carries a remedy rather than only a complaint.
			if s.ProbeReading != "" {
				fmt.Fprintf(&b, "      probe: %s\n", s.ProbeReading)
			}
			if s.SatisfiedBy != nil {
				fmt.Fprintf(&b, "      to satisfy: %s\n", s.SatisfiedBy.Expect)
			}
		}
	}
	section("FAIL — the CLI cannot reach these (our debt)", p.Gaps)
	section("FAIL — no cloud API exists, and the manual step is OUTSTANDING", p.Manual)
	if len(p.Satisfied) > 0 {
		fmt.Fprintf(&b, "\ncloud ceilings SATISFIED — no API exists, and the manual step is done (%d):\n", len(p.Satisfied))
		for _, sc := range p.Satisfied {
			fmt.Fprintf(&b, "  - %s [%s] %s\n      %s\n", sc.Step.Title, sc.Step.ID, sc.Step.Issue, sc.Evidence)
		}
	}
	section("set aside — deliberately human-in-the-loop", p.Console)
	return b.String()
}

// ScoreCLIDemo partitions the table for one cloud. It does NOT execute anything — the run half
// does that and only then trusts these verdicts. Keeping the partition pure is what lets ci.yml
// check the table's shape on every PR for free.
func ScoreCLIDemo(cloud string) (CLIDemoProof, error) {
	p := CLIDemoProof{Cloud: cloud}
	seen := map[string]bool{}
	for _, s := range CLIDemoSteps {
		if err := s.Validate(); err != nil {
			return CLIDemoProof{}, err
		}
		if seen[s.ID] {
			return CLIDemoProof{}, fmt.Errorf("duplicate step ID %q — IDs are the ledger's primary key", s.ID)
		}
		seen[s.ID] = true
		if !s.AppliesTo(cloud) {
			continue
		}
		switch s.Reach {
		case CLIDriven:
			p.Driven = append(p.Driven, s.ID)
		case CLIGap:
			p.Gaps = append(p.Gaps, s)
		case CloudManual:
			p.Manual = append(p.Manual, s)
		case ConsoleOnly:
			p.Console = append(p.Console, s)
		}
	}
	if len(p.Driven) == 0 {
		return CLIDemoProof{}, fmt.Errorf("cloud %q scored ZERO CLI-driven steps — a table that proves nothing for a cloud is an error, not a skip", cloud)
	}
	return p, nil
}

// CLIDemoEnabled reports whether the CLI-only demo scenario is switched on for this run.
func CLIDemoEnabled() bool { return t2Truthy(os.Getenv("ALETHIA_E2E_CLI_DEMO")) }

// CLIDemoProvisionEnabled gates the PROVISIONING half — MVP predicate 4's second clause, the one
// the reachability bar above deliberately does not answer.
//
// A SEPARATE gate from CLIDemoEnabled, not the same one, because they buy different things. The
// reachability bar costs nothing: it runs `alethia <cmd> --help` and is safe to leave on for every
// leg. This one boots a console, seeds a service token and provisions a real cluster through the
// binary, so it is a DIMENSION (`cli-demo`) rather than a variable a maintainer sets and forgets —
// resolve-dimension.sh exports it, which is what stops it riding along on a leg that did not ask
// for it.
func CLIDemoProvisionEnabled() bool { return t2Truthy(os.Getenv("ALETHIA_E2E_CLI_DEMO_PROVISION")) }

// CLIDemoBinary is the `alethia` binary under test. It defaults to whatever is on PATH so a
// maintainer can point the harness at a release artifact and prove the bar against the binary
// that actually ships — not against a `go run` of the working tree, which can pass while the
// released CLI is a version behind (v0.4.0 predates both `project ... placement` and
// `connector hetzner`).
func CLIDemoBinary() string {
	if b := strings.TrimSpace(os.Getenv("ALETHIA_E2E_CLI_BIN")); b != "" {
		return b
	}
	return "alethia"
}

// CLIDemoStepIDs returns every step ID, sorted — for stable ledger and issue-dedup output.
func CLIDemoStepIDs() []string {
	ids := make([]string, 0, len(CLIDemoSteps))
	for _, s := range CLIDemoSteps {
		ids = append(ids, s.ID)
	}
	sort.Strings(ids)
	return ids
}
