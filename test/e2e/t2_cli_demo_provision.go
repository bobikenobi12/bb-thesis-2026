// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The CLI-only demo, ACTUALLY PERFORMED — MVP predicate 4's second clause.
//
// t2_cli_demo.go answers "does the command surface resolve": it runs `alethia <cmd> --help` for
// every step and ratchets both directions. That is a real claim and it is not this one. Nothing in
// this repo had ever PROVISIONED through the binary — the T2 spine writes the DEPLOY job straight
// into Postgres (controlplane.go's SeedDeployJob), so the CLI has never been the actor, and a
// prospect watching a demo is watching the actor.
//
// ── WHY A SECOND TABLE, AND WHY IT IS CROSS-CHECKED RATHER THAN MERGED ──
//
// CLIDemoSteps carries a command PREFIX (`{"project", "create"}`) because `--help` is all
// reachability needs. Performing the step needs a concrete invocation with real arguments, real
// ids threaded from the step before, and something to assert afterwards. Those are different
// shapes, so they are different tables.
//
// Two tables invite exactly one failure: they drift, and the bar silently stops performing a step
// while still reporting it. So every CLIDriven step must be accounted for in EXACTLY ONE of:
//
//	a BEAT           — the run performs it, with real arguments
//	cliDemoNotDriven — the run does not, and says why, in a sentence
//
// Neither a step with both nor a step with neither is allowed, and the check runs in the PURE half
// (t2_cli_demo_provision_pure_test.go) so it costs no cloud. That set difference is the same
// discipline MVP predicate 5 applies to the runbook beats, applied to its own harness — because
// "the bar does not quietly count a step it did not perform" is the only reason anyone should
// believe the bar.
//
// ── login IS THE RECORDED EXCEPTION, NOT A GAP ──
//
// The device flow needs a human by design; `ALETHIA_TOKEN` is the documented non-interactive
// substitute (apps/cli/cmd/auth_utils.go's ServiceTokenEnv, built for exactly this). That is
// written into cliDemoNotDriven rather than glossed, because a bar that quietly counted `login` as
// performed would be claiming the one thing it cannot do.

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// CLIDemoRun is the state the beats thread through one another: ids the CLI mints as it goes.
//
// A struct rather than package-level vars because two beats read what a third wrote, and a
// half-populated run must be a visible zero value rather than a stale id left over from a previous
// invocation.
type CLIDemoRun struct {
	// Bin is the `alethia` binary under test.
	Bin string
	// Provider is the cloud this leg drives (hetzner|aws|gcp|azure|alibaba).
	Provider string
	// Region is the region the project provisions into.
	Region string
	// Project is the project NAME the run creates.
	Project string
	// EnvName is the environment the beats plan/apply/destroy against.
	EnvName string

	// ── minted as the run proceeds ──

	// ProjectID is captured from `project create`; every later beat addresses the project by id
	// rather than by name, because two projects may share a name (#2663) and resolving by name
	// would make the demo depend on which one the server picked.
	ProjectID string
	// IdentityID is the cloud identity `connector <cloud>` attached.
	IdentityID string
	// ApplyJobID is the DEPLOY job `project apply` enqueued — what `jobs logs` follows.
	ApplyJobID string
	// Token is the seeded service token the CLI authenticates with (ALETHIA_TOKEN).
	Token string
	// OrgID is the org that token is pinned to, and the org the harness MUST register its runner
	// in — see #392 and LoadCLIDemoCreds.
	OrgID string
	// APIBase is the REAL console the CLI talks to — never the runner shim, which serves no
	// user-facing endpoint and whose whole point is that faking those would prove the CLI against
	// a mock.
	APIBase string
	// ClusterSets are the `--set` pairs that carry the workflow's cheap node shape into the
	// CLI-authored project. Built by CLIDemoClusterSets from ALETHIA_E2E_CLUSTER_JSON — the same
	// variable the seeded path merges — so the two cannot disagree. Empty on hetzner, which passes
	// no override.
	ClusterSets []string
	// RunnerID is the runner the harness registered. `project apply` REQUIRES it: without
	// --runner-id the CLI calls selectRunner(), which prompts — and a prompt in CI hangs until the
	// context kills it, reporting as "the CLI cannot reach apply" when the truth is that nobody
	// answered it.
	RunnerID string
}

// CLIDemoPhase says WHERE in the provisioning spine a beat can run. It exists because the demo's
// order and the harness's order are not the same order, and pretending otherwise deadlocks.
//
// The spine registers a runner row, enqueues a job, THEN starts the runner process, then waits.
// A beat that enqueues a job and blocks on it (`--wait`) before that process exists would wait
// forever on a claimer that has not started. A beat that reads the cluster before convergence
// would read nothing. So each beat declares the window it is valid in, and the driver runs one
// window at a time from the place in the spine that window means.
type CLIDemoPhase string

const (
	// CLIDemoAuthoring — needs the CONSOLE only: identity, the connector, and authoring the
	// project. No job, no runner, no cluster.
	CLIDemoAuthoring CLIDemoPhase = "authoring"
	// CLIDemoEnqueue — creates the PLAN and DEPLOY jobs. Runs where the spine used to seed its job
	// row, so the runner process starts immediately after and claims both. These beats must NOT
	// pass `--wait`: the CLI would block on a runner that does not exist yet.
	CLIDemoEnqueue CLIDemoPhase = "enqueue"
	// CLIDemoConverged — the read-backs, valid only once the cluster is up and asserted: logs, the
	// cluster, the signed receipt, drift, cost, add-ons.
	CLIDemoConverged CLIDemoPhase = "converged"
	// CLIDemoTeardown — the demo ends where it started. The spine's own teardown remains as the
	// guaranteed backstop; it is idempotent, so a cluster the CLI already destroyed costs a no-op.
	CLIDemoTeardown CLIDemoPhase = "teardown"
)

// CLIDemoBeat is one step of the demo, performed through the real binary.
type CLIDemoBeat struct {
	// Phase is the window this beat is valid in. Required: a beat with no phase would be silently
	// dropped by every driver call, which is the "defined but never executed" state this whole
	// tier exists to make impossible.
	Phase CLIDemoPhase
	// StepID names the CLIDemoSteps entry this performs. Validated: a beat naming a step that does
	// not exist is a typo that would otherwise make the cross-check pass by accident.
	StepID string
	// Args builds the concrete argv (without the binary). It takes the run so a beat can address
	// what an earlier one minted.
	Args func(r *CLIDemoRun) []string
	// Stdin, when non-empty, is written to the command's stdin. Used by the connector beats, whose
	// credentials must NOT travel in argv — /proc is world-readable and argv reaches the process
	// list, which is the same reason the runner's bootstrap Jobs pass names and never values.
	Stdin func(r *CLIDemoRun) string
	// ReadBack, when set, is a READ-ONLY command run after the beat succeeds, whose output is what
	// After receives instead of the beat's own.
	//
	// It exists because some commands DO something and then print a progress UI rather than the id
	// they created. `connector <cloud>` is the case: it renders a three-step stepper and keeps
	// `initResp.IdentityID` to itself. Parsing a stepper for an id would be reading a UI; asking
	// the product what now EXISTS is the same answer from a stable surface.
	ReadBack func(r *CLIDemoRun) []string
	// After runs on success with the command's combined output: it captures ids into the run and
	// asserts what the step must have produced. A beat with no After proves only that the command
	// exited 0, which for a read-only step is the whole claim.
	After func(r *CLIDemoRun, out string) error
	// Timeout overrides the default per-beat bound. Zero means the default. Only the teardown
	// needs it: `project destroy --wait` blocks on a real cloud destroy, which outlasts a bound
	// sized for a command that talks to a console.
	Timeout time.Duration
	// Why documents anything surprising about the invocation. Optional.
	Why string
}

// cliDemoNotDriven records, per step id, WHY the provisioning run does not perform it. Every entry
// is a sentence a reader can disagree with — "not applicable" would be indistinguishable from an
// oversight, which is the state this file exists to make impossible.
var cliDemoNotDriven = map[string]string{
	"login": "the device flow needs a human at a browser BY DESIGN, and ALETHIA_TOKEN is the " +
		"documented non-interactive substitute (apps/cli/cmd/auth_utils.go ServiceTokenEnv). The run " +
		"authenticates with a service token this job minted, so the step is performed by a different " +
		"mechanism than a prospect would use — recorded rather than counted.",

	// The BYO surfaces. Each needs a customer fixture repo, and each already has a dimension that
	// proves it end to end with those fixtures wired. Re-driving them here would buy the same proof
	// through a different actor while doubling the fixtures this dimension depends on.
	"chart-attach": "a customer Helm chart needs the A0.6 fixture repos, which the `gitops` dimension " +
		"wires and proves (E2E_ARGO_BYO_CHART_*). Driving it here would duplicate that dimension's " +
		"fixture surface without proving anything new about the CLI as the actor.",
	"chart-scan": "same fixture surface as chart-attach — proven by the `gitops` dimension.",
	"iac": "the BYO-IaC custody chain is the `byo-iac` dimension's whole assertion (a customer " +
		"OpenTofu root refused when unsafe, applied through the state proxy, drifted, healed, " +
		"destroyed, state cleared). It needs its own fixture module and its own budget.",
	"iac-attach": "same fixture surface as `iac` — proven by the `byo-iac` dimension.",
	"iac-scan":   "same fixture surface as `iac` — proven by the `byo-iac` dimension.",

	"promotion-approve": "an approval gate needs a promotion graph across two environments and a " +
		"protection rule to approve. That is B6's surface (t2_b6_promotion.go), which seeds it " +
		"directly; wiring it into a single-environment demo run would change what the demo IS.",

	"dns-delegation": "a CloudManual ceiling — delegating a real zone is a registrar action, so no " +
		"binary can perform it on any cloud. It is scored as a FAIL of the bar by maintainer ruling " +
		"and carries its own SatisfiedBy probe; performing it here is not possible by definition.",
}

// CLIDemoBeats is the ordered demo: an empty account to a running, verified, torn-down cluster.
//
// ORDER IS THE ARTIFACT. This is what a prospect watches, so the beats run in the sequence a human
// would type them, and a failure names the beat rather than a step number.
var CLIDemoBeats = []CLIDemoBeat{
	{
		StepID: "whoami",
		Phase:  CLIDemoAuthoring,
		Args:   func(_ *CLIDemoRun) []string { return []string{"whoami", "--no-input"} },
		Why:    "first command on a fresh machine — it proves the service token resolved to an org before anything is created.",
	},
	{
		StepID: "org-switch",
		Phase:  CLIDemoAuthoring,
		Args:   func(_ *CLIDemoRun) []string { return []string{"org", "list", "--no-input"} },
		Why: "`org list` rather than `org switch`: a service token is PINNED to one org by construction " +
			"(lib/cli/service-token.ts service_token_org_id), so switching is not a thing this credential " +
			"can do. Listing exercises the same org surface and does not pretend otherwise.",
	},
	{
		StepID:   "connector",
		Phase:    CLIDemoAuthoring,
		Args:     cliDemoConnectorArgs,
		Stdin:    cliDemoConnectorStdin,
		ReadBack: func(_ *CLIDemoRun) []string { return []string{"connector", "list", "--output", "json", "--no-input"} },
		After:    captureIdentityID,
		Why: "PER CLOUD, because `connector <cloud>` is five different commands wearing one noun — see " +
			"cliDemoConnectorFlags. A SECRET still travels over stdin and never argv (hetzner's token); " +
			"an ARN, a project id or a GUID is an identifier rather than a credential, so those go in " +
			"flags, which is the form the CLI itself documents for --no-input.",
	},
	{
		StepID: "project-create",
		Phase:  CLIDemoAuthoring,
		Args: func(r *CLIDemoRun) []string {
			// --cloud-identity-id is what makes the project PROVISIONABLE. Without it the project
			// is created with `cloud_identity_id: null` and the deploy has no credential to
			// provision with — a failure that surfaces during apply, long after the beat that
			// should have caught it. The id comes from the connector beat's read-back.
			return []string{
				"project", "create", r.Project, "--region", r.Region, "--stage", "development",
				"--cloud-identity-id", r.IdentityID, "--output", "json", "--no-input",
			}
		},
		After: captureProjectID,
	},
	{
		StepID: "project-env",
		Phase:  CLIDemoAuthoring,
		Args: func(r *CLIDemoRun) []string {
			return []string{"project", "env", "list", "--project", r.ProjectID, "--output", "json", "--no-input"}
		},
		After: captureDefaultEnv,
		Why: "captures the DEFAULT environment rather than assuming one. `project create --stage " +
			"development` makes `development` and `preview`, and the harness's own env name is a " +
			"different thing entirely — addressing the wrong one fails with `Environment \"x\" not " +
			"found`, which reads as a CLI defect and is a harness assumption.",
	},
	{
		StepID: "component-kinds",
		Phase:  CLIDemoAuthoring,
		Args:   func(_ *CLIDemoRun) []string { return []string{"project", "component", "kinds", "--no-input"} },
	},
	{
		StepID: "component-add",
		Phase:  CLIDemoAuthoring,
		Args: func(r *CLIDemoRun) []string {
			// `--set` is REQUIRED: a cluster with no fields is refused server-side with
			// "No values to set". And `--name` is omitted deliberately — cluster is a singleton
			// and the CLI ignores the flag for singletons, so passing it would be cargo.
			//
			// The node shape comes from the workflow's own ALETHIA_E2E_CLUSTER_JSON rather than
			// being written here: the seeded path merges that variable into its snapshot, and the
			// CLI path must land on the same shape or aws takes the template default
			// (m5a.4xlarge x2) and the cost guard refuses the run. The min/max below are the floor
			// the shape overrides where it says so.
			argv := []string{
				"project", "component", "add", "--project", r.ProjectID, "--kind", "cluster",
				"--env", r.EnvName, "--set", "node_min_size=1", "--set", "node_max_size=2",
			}
			argv = append(argv, r.ClusterSets...)
			return append(argv, "--no-input")
		},
	},
	{
		StepID: "staged",
		Phase:  CLIDemoAuthoring,
		Args: func(r *CLIDemoRun) []string {
			// BY NAME. `project get` takes `[project_name]`, and handing it an id returns 404 —
			// which reads as "the project vanished" rather than "wrong argument".
			return []string{"project", "get", r.Project, "--output", "json", "--no-input"}
		},
	},
	{
		StepID: "plan",
		Phase:  CLIDemoEnqueue,
		Args: func(r *CLIDemoRun) []string {
			// NO --wait. The runner process starts AFTER this phase, so blocking here would wait
			// on a claimer that does not exist. The spine waits instead, on the DEPLOY job.
			return []string{"project", "plan", "--project-id", r.ProjectID, "--env", r.EnvName, "--runner-id", r.RunnerID, "--no-input"}
		},
	},
	{
		StepID: "apply",
		Phase:  CLIDemoEnqueue,
		Args: func(r *CLIDemoRun) []string {
			return []string{"project", "apply", "--project-id", r.ProjectID, "--env", r.EnvName, "--runner-id", r.RunnerID, "--no-input"}
		},
		After: captureApplyJobID,
		Why: "the beat the whole dimension exists for — the DEPLOY job is enqueued BY THE CLI, not by a " +
			"seeded row. --runner-id is REQUIRED: without it the CLI calls selectRunner(), which prompts, " +
			"and a prompt in CI hangs until the context kills it and reports as an unreachable command.",
	},
	{
		StepID: "jobs-logs",
		Phase:  CLIDemoConverged,
		Args:   func(r *CLIDemoRun) []string { return []string{"jobs", "logs", r.ApplyJobID, "--no-input"} },
	},
	{
		StepID: "cluster-get",
		Phase:  CLIDemoConverged,
		Args:   func(r *CLIDemoRun) []string { return []string{"clusters", "get", r.ProjectID, "--no-input"} },
	},
	{
		StepID: "receipt-verify",
		Phase:  CLIDemoConverged,
		Args: func(r *CLIDemoRun) []string {
			return []string{"verify", "receipt", "--job", r.ApplyJobID, "--no-input"}
		},
		Why: "the signed ed25519 receipt sealed to the plan hash — the claim the demo's close rests on.",
	},
	{
		StepID: "drift",
		Phase:  CLIDemoConverged,
		Args: func(r *CLIDemoRun) []string {
			return []string{"drift", "show", "--project", r.ProjectID, "--env", r.EnvName, "--no-input"}
		},
	},
	{
		StepID: "cost",
		Phase:  CLIDemoConverged,
		Args: func(r *CLIDemoRun) []string {
			return []string{"cost", "show", "--project", r.ProjectID, "--env", r.EnvName, "--no-input"}
		},
	},
	{
		StepID: "addons",
		Phase:  CLIDemoConverged,
		Args: func(r *CLIDemoRun) []string {
			return []string{"addon", "list", "--project", r.ProjectID, "--env", r.EnvName, "--no-input"}
		},
	},
	{
		StepID: "destroy",
		Phase:  CLIDemoTeardown,
		Args: func(r *CLIDemoRun) []string {
			return []string{"project", "destroy", "--project-id", r.ProjectID, "--env", r.EnvName, "--yes", "--wait", "--no-input"}
		},
		Timeout: 30 * time.Minute,
		Why:     "the demo ends where it started — and an un-torn-down demo is a standing bill, which the orphan reaper would otherwise find.",
	},
}

// cliDemoConnectorFlags is the NON-INTERACTIVE invocation of `connector <cloud>`, per cloud.
//
// ── WHY THIS TABLE EXISTS (#4083) ──
//
// `connector` is one noun wearing five commands, and they share almost no flags. The beat used to
// build ONE argv for every cloud — `connector <provider> --token-stdin --no-input` — and
// `--token-stdin` is registered on exactly one command, apps/cli/cmd/connector_hetzner.go's. On
// aws, gcp and azure cobra rejected the unknown flag and the run died at the beat, so three of the
// dimension's five cells could not be driven at all. A comment right here asserted the other clouds
// were "skipped with a recorded reason at run time"; DriveCLIDemoPhase has no skip path. That
// sentence is why nobody looked, and it is deleted rather than corrected.
//
// ── NOTHING HERE IS INVENTED VOCABULARY ──
//
// The CLI programme already ratified what a non-interactive connector creation IS for each cloud,
// and asserts it behaviourally: apps/cli/cmd/cov_connectors_test.go's connCompleteCases drives
// exactly these flag sets with prompting ENABLED and requires that no form opens and the command
// reaches the control plane. Each command's own Long text calls its flag "the flag form of that
// same paste, so the command works under --no-input". So this table adopts a surface that exists;
// it does not ask for a new one.
//
// ── WHERE THE VALUES COME FROM ──
//
// The ambient credential handles the workflow already exports for the leg (see the job-level env in
// .github/workflows/e2e-nightly.yml and t2_providers.go's credsPresent rows), so the identity the
// CLI creates names the SAME account the runner provisions into. gcp's project and azure's
// subscription go through t2AmbientAccountID, which is the harness's existing mirror of the
// runner's resolveAmbientAccountID — one resolution order, not two.
//
// A MISSING ENTRY IS NOT AN EMPTY ONE. ValidateCLIDemoBeats requires a row for every provider in
// t2ProviderTable, so a sixth cloud joining the harness reds here instead of quietly rebuilding the
// hetzner argv under a different name.
var cliDemoConnectorFlags = map[string]func() []string{
	// The only cloud whose connector takes a plain SECRET, which is why it is the only one whose
	// credential goes over stdin — argv reaches /proc and the process list.
	"hetzner": func() []string { return []string{"--token-stdin"} },

	// The e2e nightly role itself. It is a repo VARIABLE, not a secret, precisely because a role
	// ARN is an identifier — the same reason it is safe in argv here.
	"aws": func() []string { return []string{"--role-arn", t2Env("E2E_AWS_ROLE_ARN", "")} },

	// --wif-config takes a PATH (or "-" for stdin), and google-github-actions/auth has already
	// written exactly that file and exported its path. Handing over the path rather than the bytes
	// keeps the harness out of the business of parsing a credential config it does not own.
	//
	// --project is required by the command under --no-input even though /connect derives the
	// project from the WIF config: without it `connector gcp` refuses with "no project given".
	"gcp": func() []string {
		return []string{
			"--project", t2AmbientAccountID("gcp"),
			"--wif-config", t2Env("GOOGLE_APPLICATION_CREDENTIALS", ""),
		}
	},

	// All three are required TOGETHER (apps/cli/cmd/connector_azure.go's azureFlagIDs), and all
	// three are GUIDs the workflow writes into the job env itself — azure/login exports none of
	// them.
	"azure": func() []string {
		return []string{
			"--subscription", t2Env("ARM_SUBSCRIPTION_ID", ""),
			"--tenant-id", t2Env("ARM_TENANT_ID", ""),
			"--client-id", t2Env("ARM_CLIENT_ID", ""),
		}
	},

	// The RAM role, shaped like aws's. Present so the table covers the provider list; the
	// dimension is not being driven on alibaba.
	"alibaba": func() []string { return []string{"--role-arn", t2Env("E2E_ALIBABA_ROLE_ARN", "")} },
}

// cliDemoConnectorArgs builds `connector <cloud>` for the run's provider.
//
// The command PATH varies with the cloud and so do the flags — this is the one beat where that is
// true, and it is true because the product models each cloud's connection as its own command.
func cliDemoConnectorArgs(r *CLIDemoRun) []string {
	argv := []string{"connector", r.Provider}
	if flags, ok := cliDemoConnectorFlags[r.Provider]; ok {
		argv = append(argv, flags()...)
	}
	return append(argv, "--no-input")
}

// cliDemoConnectorEmptyFlags names the flags whose VALUE came out empty in the argv this run would
// submit, or nil when every one is populated.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A LIST OF VARIABLES. Every builder above reaches for
// `t2Env(NAME, "")`, whose default is the empty string — so an unset repo variable does not fail,
// it produces `connector aws --role-arn ""`. That is not a parse error: `connector aws` branches on
// `TrimSpace(roleARN) != ""` and an empty value falls THROUGH to awsLocalFlow, which finds the
// runner's preinstalled `aws` CLI and deploys a real CloudFormation stack — an IAM OIDC provider
// and AlethiaProvisionerRole that aws-cleanup.sh does not sweep. gcp and azure have the same shape
// (an empty --wif-config reaches gcpCloudShellFlow; empty ids reach the local `az` setup). A run
// that meant to do nothing creates cloud identity, and every guard upstream reads green because the
// flags ARE registered and the invocation DOES parse.
//
// It reads the built argv instead of a per-cloud list of variable names on purpose: such a list is
// a second source of truth for the builders above and stops covering the first time one of them
// gains a flag. The argv is what the process would actually receive, so it cannot drift from it.
func cliDemoConnectorEmptyFlags(r *CLIDemoRun) []string {
	argv := cliDemoConnectorArgs(r)
	var empty []string
	for i, a := range argv {
		if a != "" || i == 0 {
			continue
		}
		flag := argv[i-1]
		if !strings.HasPrefix(flag, "--") {
			flag = fmt.Sprintf("argv[%d]", i)
		}
		empty = append(empty, flag)
	}
	return empty
}

// cliDemoConnectorStdin returns the credential material `connector <cloud>` reads from stdin.
//
// Hetzner only, and that is now a statement about the PRODUCT rather than about this harness: it is
// the one cloud whose connector takes a plain API token. Every other cloud's connector takes
// identifiers in flags and mints its own assertion server-side — see cliDemoConnectorIssuerTrust.
func cliDemoConnectorStdin(r *CLIDemoRun) string {
	if r.Provider == "hetzner" {
		return strings.TrimSpace(t2Env("HCLOUD_TOKEN", ""))
	}
	return ""
}

// cliDemoConnectorIssuerTrustEnv is the maintainer's opt-in: set it once the console this dimension
// boots has an OIDC issuer the clouds below actually trust, and the refusal lifts with no code
// change.
const cliDemoConnectorIssuerTrustEnv = "ALETHIA_E2E_CLI_DEMO_ISSUER_TRUSTED"

// cliDemoConnectorIssuerTrust records, per cloud, why `connector <cloud>` cannot COMPLETE against
// the console this dimension boots — or "" when it can.
//
// AN EMPTY STRING MEANS "ANSWERED: DRIVABLE". A MISSING KEY MEANS NOBODY ANSWERED, and
// ValidateCLIDemoBeats fails on that, because the two are otherwise the same map lookup.
//
// ── THIS IS THE PART THE FLAG FIX DOES NOT REACH ──
//
// Fixing the argv makes the invocation PARSE. It does not make it SUCCEED, and the reason is not in
// the CLI at all. `POST /api/cli/providers/{p}/connect` runs a live probe inline before it marks the
// identity verified (apps/console/lib/cloud-providers/connections.ts verifyConnectionInline →
// lib/cloud-providers/health/index.ts probeHealth), and for aws, gcp, azure and alibaba that probe
// authenticates with an assertion THE CONSOLE SIGNS ITSELF: mintWorkloadToken, issuer
// NEXT_PUBLIC_APP_URL + "/api/oidc" (apps/console/lib/oidc/issuer.ts). A failed probe is
// disconnected, /connect returns verified:false, and every connector calls fail() — exit 1.
//
// The workflow starts this console with NEXT_PUBLIC_APP_URL=http://localhost:3000 and no
// ALETHIA_OIDC_SIGNING_KEY at all, so the mint refuses before a packet leaves the box; and were the
// key set, `http://localhost:3000/api/oidc` is neither reachable nor trusted by AWS STS, Google STS
// or Entra. Nor could it be trusted by accident: infra/aws-oidc/e2e-nightly.tf trusts
// token.actions.githubusercontent.com and nothing else, and its permissions boundary carries an
// explicit DenyRoleHop.
//
// Hetzner is unaffected because its connector has no issuer in the path — the token is encrypted
// and the probe is a bearer GET against api.hetzner.cloud.
//
// So these three cells are blocked on a MAINTAINER decision about the e2e console's identity, not
// on this harness. Recorded here, refused loudly before spend (AssertCLIDemoConnectorIsDrivable),
// and liftable in one repo variable — never silently skipped, which would report a cell the run
// never drove.
var cliDemoConnectorIssuerTrust = map[string]string{
	"hetzner": "",
	"aws": "`connector aws` submits a role ARN and the console then runs AssumeRoleWithWebIdentity " +
		"with a token it signed itself. The e2e role trusts token.actions.githubusercontent.com only " +
		"(infra/aws-oidc/e2e-nightly.tf), so the console's assertion is refused and the beat exits 1.",
	"gcp": "`connector gcp` submits a WIF credential config and the console then exchanges its own " +
		"minted subject token at Google STS. The e2e pool's provider trusts GitHub's issuer, not this " +
		"console's, so the exchange is refused and the beat exits 1. SECOND, INDEPENDENT BLOCKER: the " +
		"config this beat uploads is the one google-github-actions/auth wrote, and with no token_format " +
		"that is an external_account whose credential_source.file is a RUNNER-LOCAL path holding a " +
		"short-lived GitHub OIDC token. The console stores it verbatim and can never resolve that path, " +
		"so lifting the issuer decision alone does not make this cell drivable — it needs a credential " +
		"whose source the console can read.",
	"azure": "`connector azure` submits tenant/client/subscription and the console then presents a " +
		"client assertion it signed itself. The managed identity's federated credential names GitHub's " +
		"issuer, so Entra answers AADSTS70021 and the beat exits 1.",
	"alibaba": "same keyless shape as aws, and the dimension is not being driven on alibaba — the " +
		"maintainer's cli-demo scope is hetzner, aws, gcp and azure.",
}

// ValidateCLIDemoBeats holds the two tables to each other. Returns every problem at once, because
// fixing them one CI round-trip at a time is how a table this size stays wrong for a week.
//
// THREE ways it fails, and each is a real mistake rather than a style rule:
//
//	a beat naming no step        — a typo; the beat would run but be credited to nothing
//	a step both driven and not   — two answers to one question; the reader cannot tell which is true
//	a step with neither          — the silent omission this whole file exists to prevent
func ValidateCLIDemoBeats() error {
	steps := map[string]DemoStep{}
	for _, s := range CLIDemoSteps {
		steps[s.ID] = s
	}

	var problems []string
	driven := map[string]int{}
	for _, b := range CLIDemoBeats {
		if _, ok := steps[b.StepID]; !ok {
			problems = append(problems, fmt.Sprintf("beat %q names no step in CLIDemoSteps", b.StepID))
			continue
		}
		if b.Args == nil {
			problems = append(problems, fmt.Sprintf("beat %q has no Args — it would perform nothing", b.StepID))
		}
		// A beat with no phase is silently dropped by every DriveCLIDemoPhase call — defined,
		// counted by the cross-check, and never executed. That is the exact shape this tier exists
		// to make impossible, so it is a hard error rather than a default.
		switch b.Phase {
		case CLIDemoAuthoring, CLIDemoEnqueue, CLIDemoConverged, CLIDemoTeardown:
		default:
			problems = append(problems, fmt.Sprintf(
				"beat %q has phase %q, which no driver call runs — it would be defined and never executed", b.StepID, b.Phase))
		}
		driven[b.StepID]++
	}
	for id, n := range driven {
		if n > 1 {
			problems = append(problems, fmt.Sprintf("step %q has %d beats — the run would perform it twice and the report would name it once", id, n))
		}
	}
	for id := range cliDemoNotDriven {
		if _, ok := steps[id]; !ok {
			problems = append(problems, fmt.Sprintf("cliDemoNotDriven names %q, which is no step in CLIDemoSteps", id))
		}
		if driven[id] > 0 {
			problems = append(problems, fmt.Sprintf("step %q is BOTH driven by a beat and recorded as not-driven — one of the two is a lie", id))
		}
	}
	for _, s := range CLIDemoSteps {
		if s.Reach != CLIDriven {
			// A gap or a ceiling is not something the run could perform even in principle; the
			// reachability half already scores it, and scoring it twice would double-count.
			continue
		}
		if driven[s.ID] == 0 && cliDemoNotDriven[s.ID] == "" {
			problems = append(problems, fmt.Sprintf(
				"step %q is CLIDriven but the provisioning run neither performs it nor says why — "+
					"add a beat, or a sentence to cliDemoNotDriven", s.ID))
		}
	}

	problems = append(problems, cliDemoProviderAxisProblems()...)

	if len(problems) == 0 {
		return nil
	}
	sort.Strings(problems)
	return fmt.Errorf("CLI demo beats do not account for the step table:\n  - %s", strings.Join(problems, "\n  - "))
}

// cliDemoProviderAxisProblems varies the one axis every other check holds fixed: the CLOUD.
//
// WHY IT IS A SEPARATE PASS. Everything above builds each beat's argv exactly once, against a zero
// run — and a zero run has no provider. So a beat whose Args switches on the cloud was validated
// for none of them. That is precisely how #4083 shipped: a `connector` beat hardcoding hetzner's
// `--token-stdin` for all five clouds passed every check in this file, because the flag it emitted
// was never a thing this file looked at. A table pins only what it contains, so the fix is to make
// it contain the axis the implementations differ on.
//
// The provider list is DERIVED from t2ProviderTable (t2ProviderNames), never typed here: a sixth
// cloud joining the harness must answer these questions rather than inherit a fifth cloud's answers.
//
// What it CANNOT ask is whether a flag is registered — that question needs the binary, and it is
// asked before spend by AssertCLIDemoBeatFlagsAreRegistered.
func cliDemoProviderAxisProblems() []string {
	var problems []string

	providers := t2ProviderNames()
	if len(providers) == 0 {
		// The empty-set branch has to differ from the nothing-wrong branch, or this whole pass
		// reports green having asked nothing.
		return []string{"t2ProviderTable is EMPTY — the provider axis was not checked at all, and a " +
			"beat that is wrong for every cloud would pass"}
	}

	for _, b := range CLIDemoBeats {
		if b.Args == nil {
			// Already reported by the caller; reporting it again would send two findings at one cause.
			continue
		}
		for _, provider := range providers {
			if argv := b.Args(&CLIDemoRun{Provider: provider}); len(argv) == 0 {
				problems = append(problems, fmt.Sprintf(
					"beat %q builds an EMPTY argv on %s — a switch with no case for that cloud performs "+
						"nothing and exits 0", b.StepID, provider))
			}
		}
	}

	for _, provider := range providers {
		if _, ok := cliDemoConnectorFlags[provider]; !ok {
			problems = append(problems, fmt.Sprintf(
				"cliDemoConnectorFlags has no row for %q — `connector %s` would be invoked with no "+
					"cloud-specific flag at all, which under --no-input dies naming a flag nobody wrote",
				provider, provider))
		}
		why, ok := cliDemoConnectorIssuerTrust[provider]
		if !ok {
			problems = append(problems, fmt.Sprintf(
				"cliDemoConnectorIssuerTrust has no key for %q — nobody has said whether the connector "+
					"beat can COMPLETE on that cloud against this dimension's console. An absent answer "+
					"and \"yes\" must not be the same map lookup", provider))
			continue
		}
		if why != "" && len(strings.Fields(why)) < 8 {
			problems = append(problems, fmt.Sprintf(
				"cliDemoConnectorIssuerTrust[%q] is %q — too short to be a reason anyone could argue with",
				provider, why))
		}
	}

	return problems
}
