// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The CALLER the `cli-demo` dimension was missing.
//
// #3303 landed the vehicle — the dimension resolves, exports its knob, takes a budget term, and its
// beat table is cross-checked against CLIDemoSteps. #3334 then made the dimension REFUSE itself,
// because a vehicle with no driver would have provisioned a floor, asserted the floor, and been
// recorded as a CLI-driven proof: an assertion that is TRUE and about the wrong thing.
//
// This is the driver. It executes the beats against the real binary, in the four windows
// CLIDemoPhase names, from the places in the provisioning spine where those windows actually exist.
//
// ── WHY PHASES RATHER THAN ONE LOOP ──
//
// The demo's order and the harness's order are not the same order. A prospect types plan, apply,
// then watches. The spine registers a runner row, enqueues a job, THEN starts the runner process,
// then waits for it. Run the whole table in one pass at the top and `project apply --wait` blocks
// forever on a claimer that has not started; run it at the bottom and there is no cluster to read
// back. Neither failure looks like what it is — both read as "the CLI cannot do this".
//
// So the driver runs one window at a time and the spine calls it four times.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// cliDemoCredsEnv names the file the workflow's seed step writes: the service token and the ORG it
// is pinned to, together.
//
// Together is the point. `claim_next_job`'s self-runner branch scopes to
// `j.org_id = v_runner_org_id` (audit P0, #392), so the runner the harness registers must carry the
// SAME org as the token the CLI authenticates with. If they differ, the job the CLI creates is
// never claimed, sits QUEUED, and the run dies on a deploy timeout — which reads as a provisioning
// defect and is a tenancy mismatch. Reading both from one file is what makes them impossible to
// set independently.
const cliDemoCredsEnv = "ALETHIA_E2E_CLI_DEMO_CREDS"

// cliDemoAPIEnv names the variable the CLI resolves its control plane from.
//
// It is `ALETHIA_WEB_ORIGIN`, and getting this wrong is not a typo — it is a live-fire hazard.
// `types.ResolveWebOrigin()` is env > persisted config > **the hosted default,
// https://alethialabs.io**, and `api.NewClient` appends `/api` to whatever comes back. So a driver
// that exported some other name would not fail: every beat would silently authenticate against
// PRODUCTION with a token minted in a throwaway database, and the run would report the CLI as
// broken while pointing at a console nobody meant to touch.
//
// The runner uses the same variable name for a different endpoint (the shim, cp.URL()). They are
// separate processes with separate environments, and the two must not be conflated: the runner
// talks to the shim, the CLI talks to the console.
const cliDemoAPIEnv = "ALETHIA_WEB_ORIGIN"

// CLIDemoCreds is what the seed step produced.
type CLIDemoCreds struct {
	OrgID   string `json:"orgId"`
	OwnerID string `json:"ownerId"`
	Token   string `json:"token"`
}

// LoadCLIDemoCreds reads the seeded credential, failing closed on every way it can be absent.
//
// Fail-closed and EARLY: this is called before a cluster is bought, because "the token file is
// missing" costs a dispatch and "the token file is missing, discovered after provisioning" costs a
// cluster.
func LoadCLIDemoCreds() (CLIDemoCreds, error) {
	path := strings.TrimSpace(os.Getenv(cliDemoCredsEnv))
	if path == "" {
		return CLIDemoCreds{}, fmt.Errorf("%s is unset — the cli-demo dimension needs the seeded service token; the workflow's seed step writes it", cliDemoCredsEnv)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return CLIDemoCreds{}, fmt.Errorf("reading %s at %s: %w", cliDemoCredsEnv, path, err)
	}
	var c CLIDemoCreds
	if err := json.Unmarshal(raw, &c); err != nil {
		return CLIDemoCreds{}, fmt.Errorf("parsing %s: %w", path, err)
	}
	// Each checked separately: "which half is missing" is the difference between a seed step that
	// did not run and one that ran against the wrong database.
	if c.Token == "" {
		return CLIDemoCreds{}, fmt.Errorf("%s carries no token — the seed step wrote a file but minted nothing", path)
	}
	if c.OrgID == "" {
		return CLIDemoCreds{}, fmt.Errorf("%s carries no orgId — without it the runner cannot be registered in the token's tenancy and the job it creates is never claimed", path)
	}
	return c, nil
}

// ResolveCLIDemoRun returns the run state for the `cli-demo` dimension, or nil when the dimension
// is off. It fails the test — EARLY, before a cluster is bought — on every way the dimension can be
// mis-dispatched.
//
// IT LIVES HERE, NOT IN THE SPINE, and that is deliberate. cli_demo_wiring_pure_test.go asserts a
// SHAPE in t2_provision_test.go: an `if` whose condition asks CLIDemoProvisionEnabled and whose
// body terminates the test is a REFUSAL, and a refusal must not coexist with a driver. Precondition
// checks wear that same shape while meaning the opposite, so leaving them in the spine would make
// the guard unable to tell "this dimension is disabled until someone writes a driver" from "this
// dimension validates its inputs". Keeping the gate here keeps that distinction sharp — and the
// resolution belongs next to the thing that consumes it anyway.
func ResolveCLIDemoRun(t *testing.T) *CLIDemoRun {
	t.Helper()
	if !CLIDemoProvisionEnabled() {
		return nil
	}
	creds, err := LoadCLIDemoCreds()
	if err != nil {
		t.Fatalf("cli-demo: %v", err)
	}
	apiBase := strings.TrimSpace(os.Getenv(cliDemoConsoleURLEnv))
	if apiBase == "" {
		t.Fatalf("cli-demo: %s is unset — the beats must drive the REAL console's user-facing API. "+
			"The runner shim serves no user-facing endpoint, and pointing at it would prove the CLI "+
			"against a mock, which is the one thing this bar must not do.", cliDemoConsoleURLEnv)
	}
	// REFUSE A PRODUCTION ORIGIN, and refuse it here rather than documenting it.
	//
	// `types.ResolveWebOrigin()` is env > persisted config > the HOSTED DEFAULT
	// (https://alethialabs.io), and `api.NewClient` appends `/api`. So a harness that exports the
	// wrong variable name — or none — does not fail: every beat authenticates against PRODUCTION
	// with a token minted in a throwaway database, and the run reports the CLI as broken while
	// pointing at a console nobody meant to touch. Nothing downstream can catch that, because from
	// the CLI's side it is a perfectly ordinary request.
	//
	// This is not specific to the demo bar. It is a hazard for ANY test that drives the CLI, which
	// is why the refusal lives on the resolution path every such test would use.
	if strings.Contains(apiBase, strings.TrimPrefix(types.DefaultWebOrigin, "https://")) {
		t.Fatalf("cli-demo: %s resolves to the HOSTED control plane (%s). The beats would authenticate "+
			"against production with a token minted in this job's throwaway database. Point it at the "+
			"console this job booted.", cliDemoConsoleURLEnv, apiBase)
	}
	run := &CLIDemoRun{Bin: CLIDemoBinary(), Token: creds.Token, OrgID: creds.OrgID, APIBase: apiBase}
	if _, err := os.Stat(run.Bin); err != nil {
		t.Fatalf("cli-demo: the binary under test is not at %q: %v — build it before dispatching this dimension", run.Bin, err)
	}
	return run
}

// cliDemoConsoleURLEnv names the real console the beats drive.
const cliDemoConsoleURLEnv = "ALETHIA_E2E_CONSOLE_URL"

// uuidRe matches the ids the CLI prints. Deliberately anchored on the shape rather than on
// surrounding prose: `ui.JobQueued` renders through lipgloss, so the line carries ANSI styling that
// a literal-prefix match would have to strip and would silently stop matching when the style
// changes.
var uuidRe = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)

// captureProjectID reads the project id out of `project create --output json`.
//
// The JSON `id` field is preferred over "the first uuid in the output" because a rendered card
// carries an org id and a cloud-identity id too, and picking positionally would work today and
// address the wrong project the moment a field is added ahead of it.
func captureProjectID(r *CLIDemoRun, out string) error {
	if id := firstJSONID(out); id != "" {
		r.ProjectID = id
		return nil
	}
	if m := uuidRe.FindString(out); m != "" {
		r.ProjectID = m
		return nil
	}
	return fmt.Errorf("no project id in `project create` output — every later beat addresses the project by id, so this is fatal rather than cosmetic:\n%s", out)
}

// captureApplyJobID reads the DEPLOY job id `project apply` enqueued. It is what the spine waits on
// and what `jobs logs` and `verify` address.
func captureApplyJobID(r *CLIDemoRun, out string) error {
	if m := uuidRe.FindString(out); m != "" {
		r.ApplyJobID = m
		return nil
	}
	return fmt.Errorf("no job id in `project apply` output — the spine has nothing to wait on:\n%s", out)
}

// captureIdentityID picks this cloud's identity out of `connector list --output json`.
//
// Matched on PROVIDER rather than taken positionally: a demo org may hold connectors for several
// clouds, and "the first one" would attach the wrong account to the project — which provisions
// successfully, into somebody else's cloud.
func captureIdentityID(r *CLIDemoRun, out string) error {
	start := strings.Index(out, "[")
	end := strings.LastIndex(out, "]")
	if start == -1 || end <= start {
		return fmt.Errorf("`connector list --output json` produced no JSON array:\n%s", out)
	}
	var ids []struct {
		ID       string `json:"id"`
		Provider string `json:"provider"`
	}
	if err := json.Unmarshal([]byte(out[start:end+1]), &ids); err != nil {
		return fmt.Errorf("parsing the connector list: %w\n%s", err, out)
	}
	for _, id := range ids {
		if strings.EqualFold(id.Provider, r.Provider) && id.ID != "" {
			r.IdentityID = id.ID
			return nil
		}
	}
	return fmt.Errorf("no %s identity among %d connector(s) — `connector %s` reported success but "+
		"attached nothing, and the project would be created with no credential to provision with:\n%s",
		r.Provider, len(ids), r.Provider, out)
}

// captureDefaultEnv reads the DEFAULT environment's name out of `project env list --output json`.
//
// It is captured rather than assumed because the CLI creates the environments, not the harness:
// `project create --stage development` makes `development` (default) and `preview`, and the
// harness's own `env` variable names something else entirely. Addressing the wrong one fails with
// `Environment "x" not found` — a 404 that reads as a CLI defect and is a harness assumption.
func captureDefaultEnv(r *CLIDemoRun, out string) error {
	start := strings.Index(out, "[")
	end := strings.LastIndex(out, "]")
	if start == -1 || end <= start {
		return fmt.Errorf("`project env list --output json` produced no JSON array:\n%s", out)
	}
	var envs []struct {
		Name      string `json:"name"`
		IsDefault bool   `json:"is_default"`
	}
	if err := json.Unmarshal([]byte(out[start:end+1]), &envs); err != nil {
		return fmt.Errorf("parsing the environment list: %w\n%s", err, out)
	}
	for _, e := range envs {
		if e.IsDefault && e.Name != "" {
			r.EnvName = e.Name
			return nil
		}
	}
	// Falling back to "the first one" would work today and silently address the wrong environment
	// the day a project is created with two. A project with no default is a product question, not
	// something for this harness to paper over.
	return fmt.Errorf("no DEFAULT environment among %d — every later beat addresses one by name:\n%s", len(envs), out)
}

// firstJSONID pulls a top-level `"id"` out of the first JSON object in the output, if there is one.
// Returns "" rather than erroring: the caller has a fallback, and a card rendered as a table is not
// a failure.
func firstJSONID(out string) string {
	start := strings.Index(out, "{")
	end := strings.LastIndex(out, "}")
	if start == -1 || end <= start {
		return ""
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(out[start:end+1]), &obj); err != nil {
		return ""
	}
	if id, ok := obj["id"].(string); ok {
		return id
	}
	return ""
}

// AssertCLIDemoBeatsAreLeafCommands refuses a beat whose argv names a command GROUP rather than a
// command.
//
// THIS EXISTS BECAUSE IT ALREADY HAPPENED. `drift`, `cost` and `verify` are groups — their leaves
// are `drift show`, `cost show`, `verify receipt`. Invoked without the subcommand, cobra prints the
// group's help and **exits 0**. So three beats would have run, performed nothing, exited clean, and
// the dimension would have reported a CLI-driven proof of a demo it never gave. That is the exact
// vacuity this tier exists to prevent, arriving through the one door nothing was watching: a
// SUCCESSFUL command.
//
// Run once, up front, before a cluster is bought — it costs one `--help` per beat.
func AssertCLIDemoBeatsAreLeafCommands(ctx context.Context, t *testing.T, run *CLIDemoRun) {
	t.Helper()
	for _, b := range CLIDemoBeats {
		// The command PATH is the leading non-flag tokens. Values that follow a flag are skipped
		// with it, so `--project <id>` never contributes `<id>` to the path.
		var path []string
		argv := b.Args(run)
		for i := 0; i < len(argv); i++ {
			if strings.HasPrefix(argv[i], "-") {
				break
			}
			path = append(path, argv[i])
		}
		if len(path) == 0 {
			t.Errorf("beat %q builds an argv that starts with a flag — it names no command", b.StepID)
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		out, _ := exec.CommandContext(cctx, run.Bin, append(append([]string{}, path...), "--help")...).CombinedOutput()
		cancel()
		if strings.Contains(string(out), "Available Commands:") {
			t.Errorf("beat %q invokes `alethia %s`, which is a command GROUP, not a command. "+
				"Cobra prints its help and EXITS 0, so this beat would perform nothing and pass. "+
				"Name the subcommand.", b.StepID, strings.Join(path, " "))
		}
	}
}

// cliDemoCobraErrorRe lifts cobra's own refusal out of a failed invocation.
//
// Cobra prints `Error: <what it objected to>` on its own line before the usage block, and the
// binary's Execute() then exits 1 (apps/cli/cmd/root.go). The verdict is RELAYED rather than
// classified: this guard's job is to notice that the real parser said no, not to have an opinion
// about which kind of no it was.
var cliDemoCobraErrorRe = regexp.MustCompile(`(?m)^Error: (.+)$`)

// AssertCLIDemoBeatFlagsAreRegistered refuses a beat whose argv names a flag its command does not
// register — on ANY cloud the harness can dispatch, not just the one this run bought.
//
// ── THIS EXISTS BECAUSE IT ALREADY HAPPENED (#4083) ──
//
// AssertCLIDemoBeatsAreLeafCommands, right above, reads only the LEADING NON-FLAG TOKENS of a
// beat's argv. So `connector aws --token-stdin` passed it — `connector aws` really is a leaf — while
// the flag rode behind unexamined, registered on exactly one sibling command. The old guard asked
// whether the command EXISTS; this one asks whether the INVOCATION PARSES, which is a different
// question and the one three of five cells died on.
//
// ── HOW THE ANSWER IS OBTAINED, AND WHY NOT FROM A LIST ──
//
// It asks the binary. `alethia <the beat's whole argv> --help` runs cobra's real ParseFlags, which
// executes BEFORE the help short-circuit, so an unregistered flag exits non-zero while a registered
// one prints help and performs nothing. The expected flag set is therefore the command tree's ACTUAL
// registrations, obtained from the tree — never a list typed here, which is the shape that stops
// covering silently the moment a command grows a flag.
//
// ── EVERY CLOUD, FROM WHICHEVER ONE IS DISPATCHED ──
//
// The argv is rebuilt for every provider in t2ProviderTable, because a beat is written once and
// dispatched five ways, and the cloud that reveals the defect is rarely the cloud in front of you.
// A hetzner run — the cheapest — now proves that aws, gcp and azure's invocations parse too. That is
// the whole reason this is worth a second `--help` per beat.
//
// It COLLECTS and then fails once: fixing a table this size one CI round-trip at a time is how it
// stays wrong for a week. It is FATAL at the end rather than merely red, because everything after it
// buys a cluster.
func AssertCLIDemoBeatFlagsAreRegistered(ctx context.Context, t *testing.T, run *CLIDemoRun) {
	t.Helper()

	if strings.TrimSpace(run.Bin) == "" {
		t.Fatal("cli-demo: no binary under test — the flag check cannot ask the command tree anything, " +
			"and reporting that as \"no problems found\" is the failure it exists to prevent")
	}
	providers := t2ProviderNames()
	if len(providers) == 0 {
		t.Fatal("cli-demo: t2ProviderTable is empty — the flag check would examine no invocation at all")
	}

	// Deduplicated on the argv, because most beats do not vary by cloud and 17 beats × 5 clouds of
	// identical `--help` runs is four fifths waste. EVERY provider that produced an argv is recorded
	// against it, not just the first — see the `providers` field.
	type probe struct {
		stepID string
		// EVERY provider that produced this argv, not just the first.
		//
		// t2ProviderNames() is sorted, so "the first that produced it" was always `alibaba` for the
		// beats that do not vary by cloud — which is most of them. A finding on a hetzner dispatch
		// then read `beat "whoami" on alibaba`, naming a cloud the run is not on and that this very
		// table records as not driven. The set is what the message needs, because the honest answer
		// for an invariant beat is "on every cloud", not any one of them.
		providers []string
		argv      []string
	}
	// One bucket, one fatal at the end: everything after this call buys a cluster, so a finding
	// recorded with t.Errorf would red the run AND still spend.
	var refused []string
	var probes []probe
	at := map[string]int{} // argv key -> index into probes
	for _, provider := range providers {
		// ONLY Provider varies. ClusterSets, Region and the ids stay at the DISPATCHED run's values,
		// so this proves "the argv each cloud's builders produce from this run parses", not "the argv
		// each cloud would produce on its own dispatch". On a hetzner run `component-add`'s argv is
		// identical across all five providers (ClusterSets is empty there), so the aws/azure `--set`
		// pairs are not probed by this check at all — the per-cloud dispatch is what exercises those.
		candidate := *run
		candidate.Provider = provider
		for _, b := range CLIDemoBeats {
			if b.Args == nil {
				// ValidateCLIDemoBeats owns that finding; two reports of one cause read as two causes.
				continue
			}
			argv := b.Args(&candidate)
			if len(argv) == 0 {
				refused = append(refused, fmt.Sprintf(
					"beat %q on %s builds an EMPTY argv — it would perform nothing and exit 0", b.StepID, provider))
				continue
			}
			key := strings.Join(argv, "\x00")
			if i, ok := at[key]; ok {
				probes[i].providers = append(probes[i].providers, provider)
				continue
			}
			at[key] = len(probes)
			probes = append(probes, probe{stepID: b.StepID, providers: []string{provider}, argv: argv})
		}
	}
	if len(probes) == 0 {
		t.Fatalf("cli-demo: the flag check built NO invocation from %d beat(s) × %d cloud(s). "+
			"That is this check reporting green having measured nothing.", len(CLIDemoBeats), len(providers))
	}

	// An invariant beat is reported as invariant rather than attributed to whichever cloud sorted
	// first; see the `providers` field above.
	where := func(p probe) string {
		if len(p.providers) == len(providers) {
			return fmt.Sprintf("on every cloud (%d)", len(providers))
		}
		return "on " + strings.Join(p.providers, ", ")
	}

	for _, p := range probes {
		cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		out, err := exec.CommandContext(cctx, run.Bin,
			append(append([]string{}, p.argv...), "--help")...).CombinedOutput()
		cancel()
		if err == nil {
			continue
		}
		// A TIMEOUT IS THE CHECK FAILING, NOT THE BEAT. CommandContext KILLS the process on
		// expiry, so Cmd.Wait sees a non-zero ProcessState and returns *exec.ExitError — the ctx
		// error is substituted only when Wait would otherwise return nil. So `errors.As` below
		// succeeds for a hung `--help`, and it would be filed as "exited non-zero and named no
		// Error: line": this guard's own failure branch reported as a finding about the beat.
		// It asks for DEADLINE EXCEEDED specifically, not for `Err() != nil`: `cancel()` has already
		// run by this line, so a bare Err() is non-nil for EVERY failure and would file every genuine
		// refusal as a timeout — the same conflation, inverted. context.Err latches the first cause,
		// so DeadlineExceeded means the deadline really did pass and Canceled means cancel() won.
		if cerr := cctx.Err(); errors.Is(cerr, context.DeadlineExceeded) {
			t.Fatalf("cli-demo: `%s %s --help` did not finish within 60s (%v).\nThe flag check reached "+
				"no verdict for this invocation — treat this as the check failing, not as the beat being "+
				"wrong.\n%s", run.Bin, strings.Join(p.argv, " "), cerr, out)
		}
		// A binary that could not be RUN is not a beat that is wrong, and conflating the two would
		// bury a missing binary under seventeen flag findings. Stop, and say which it was.
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			t.Fatalf("cli-demo: could not RUN `%s %s --help`: %v\nThe flag check reached no verdict — "+
				"treat this as the check failing, not as the beats passing.\n%s",
				run.Bin, strings.Join(p.argv, " "), err, out)
		}
		detail := strings.Join(p.argv, " ")
		if m := cliDemoCobraErrorRe.FindStringSubmatch(string(out)); m != nil {
			refused = append(refused, fmt.Sprintf(
				"beat %q %s: `alethia %s` — the CLI refuses to parse it: %s",
				p.stepID, where(p), detail, strings.TrimSpace(m[1])))
			continue
		}
		refused = append(refused, fmt.Sprintf(
			"beat %q %s: `alethia %s --help` exited non-zero (%v) and named no Error: line. "+
				"Reported rather than swallowed — an invocation the binary will not even take help for "+
				"is not one to buy a cluster behind.\n%s",
			p.stepID, where(p), detail, err, out))
	}

	if len(refused) > 0 {
		sort.Strings(refused)
		t.Fatalf("cli-demo: %d beat invocation(s) will not reach the command they name.\n  - %s\n\n"+
			"A flag belongs to the ONE command that registers it: `--token-stdin` is hetzner's "+
			"(apps/cli/cmd/connector_hetzner.go), and aws/gcp/azure/alibaba each take their own. The "+
			"non-interactive flag set per cloud lives in cliDemoConnectorFlags and is the same one "+
			"apps/cli/cmd/cov_connectors_test.go's connCompleteCases asserts.", len(refused), strings.Join(refused, "\n  - "))
	}
	t.Logf("cli-demo: %d distinct beat invocation(s) parse against the real command tree, across %d cloud(s)",
		len(probes), len(providers))
}

// AssertCLIDemoConnectorIsDrivable refuses, BEFORE any spend, a cloud whose `connector` beat cannot
// complete against the console this dimension boots.
//
// ── WHY A REFUSAL AND NOT A SKIP ──
//
// The beat can now be INVOKED on every cloud; on aws, gcp, azure and alibaba it will still be
// REJECTED, and not by the CLI. `/api/cli/providers/{p}/connect` probes the connection inline with
// an assertion the console signs itself, and this console's issuer is http://localhost:3000/api/oidc
// with no signing key — see cliDemoConnectorIssuerTrust for the per-cloud detail and the evidence.
//
// A skip would report the dimension green having driven nothing, which is the exact vacuity the
// whole tier exists to prevent — and the file's own history shows how that goes: a comment claiming
// the other clouds were "skipped with a recorded reason" stood unchallenged because nobody could
// see that no such path existed. So this is a hard red that names the blocker in one line, taken
// before any CLOUD RESOURCE is bought.
//
// WHAT IT DOES NOT SAVE, stated because the earlier wording claimed it: this is not before the
// console build. e2e-nightly.yml builds ee and the console, seeds the token, starts the console and
// builds the CLI, all before `go test` reaches this call — the control plane, the A0.5 graph and the
// runner row already exist by then. What the refusal buys is the cloud spend, which is the
// expensive half; the twelve minutes are already gone.
//
// It lifts from the OUTSIDE: set ALETHIA_E2E_CLI_DEMO_ISSUER_TRUSTED once the e2e console has an
// issuer the clouds trust, and the run proceeds with no code change. Refuse what is KNOWN broken,
// and always ship the escape hatch.
func AssertCLIDemoConnectorIsDrivable(t *testing.T, run *CLIDemoRun) {
	t.Helper()

	if t2Truthy(os.Getenv(cliDemoConnectorIssuerTrustEnv)) {
		// THE LIFT IS A STATEMENT ABOUT THE ISSUER, NOT ABOUT THE CREDENTIALS. It used to return
		// here on the strength of that one variable, which made it the one path where an unset repo
		// variable reached the CLI as an empty flag value — and an empty value does not fail, it
		// falls through to the cloud's LOCAL setup flow and creates real identity (see
		// cliDemoConnectorEmptyFlags). The maintainer opting in to the issuer cannot also mean the
		// role ARN is present, so that is asked separately, and still before any spend.
		if empty := cliDemoConnectorEmptyFlags(run); len(empty) > 0 {
			t.Fatalf("cli-demo: %s is set, but `connector %s` would be invoked with %d empty flag "+
				"value(s): %s.\n\nAn empty value is NOT a parse error — the command falls through to "+
				"its local setup flow and creates real cloud identity (aws: a CloudFormation stack with "+
				"an IAM OIDC provider and AlethiaProvisionerRole, which aws-cleanup.sh does not sweep). "+
				"Set the variable(s) behind those flags, or clear %s.",
				cliDemoConnectorIssuerTrustEnv, run.Provider, len(empty), strings.Join(empty, ", "),
				cliDemoConnectorIssuerTrustEnv)
		}
		t.Logf("cli-demo: %s is set — driving `connector %s` on the maintainer's word that this "+
			"console's OIDC issuer is trusted by that cloud", cliDemoConnectorIssuerTrustEnv, run.Provider)
		return
	}

	why, ok := cliDemoConnectorIssuerTrust[run.Provider]
	if !ok {
		t.Fatalf("cli-demo: nothing in cliDemoConnectorIssuerTrust answers for provider %q. "+
			"An unanswered cloud is not a drivable one — say whether `connector %s` can complete "+
			"against this dimension's console, in a sentence, before dispatching it.", run.Provider, run.Provider)
	}
	if why == "" {
		return
	}
	t.Fatalf("cli-demo: the `connector` beat cannot COMPLETE on %s against this dimension's console.\n\n  %s\n\n"+
		"This is not the CLI: the invocation parses, and `connector %s` submits the right fields. The "+
		"connection test that runs inside POST /api/cli/providers/%s/connect authenticates with an "+
		"assertion the CONSOLE signs, and this console is started with "+
		"NEXT_PUBLIC_APP_URL=http://localhost:3000 and no ALETHIA_OIDC_SIGNING_KEY, so no cloud can "+
		"verify it.\n\n"+
		"Unblocking it is a maintainer decision about the e2e console's identity, not a harness "+
		"change. Once that console has an issuer the cloud trusts, set %s=1 and re-dispatch — this "+
		"refusal reads that variable and nothing else.\n\n"+
		"Refused before any cloud resource is bought, rather than at the beat. (Not before the console "+
		"build — that has already happened by the time `go test` runs; see this function's doc.)",
		run.Provider, why, run.Provider, run.Provider, cliDemoConnectorIssuerTrustEnv)
}

// DriveCLIDemoPhase executes every beat in one phase, in table order, against the real binary.
//
// It is FATAL on the first failure rather than collecting: the beats thread ids through one another,
// so a failed `project create` makes every later beat address the empty string and report a second,
// louder, entirely derivative failure. The first one is the true one.
func DriveCLIDemoPhase(ctx context.Context, t *testing.T, run *CLIDemoRun, phase CLIDemoPhase) {
	t.Helper()

	ran := 0
	for _, b := range CLIDemoBeats {
		if b.Phase != phase {
			continue
		}
		argv := b.Args(run)
		bound := cliDemoBeatTimeout
		if b.Timeout > 0 {
			bound = b.Timeout
		}
		cctx, cancel := context.WithTimeout(ctx, bound)
		cmd := exec.CommandContext(cctx, run.Bin, argv...)
		cmd.Env = cliDemoEnv(run)
		if b.Stdin != nil {
			if in := b.Stdin(run); in != "" {
				cmd.Stdin = strings.NewReader(in)
			}
		}
		outB, err := cmd.CombinedOutput()
		cancel()
		out := string(outB)
		if err != nil {
			t.Fatalf("cli-demo beat %q FAILED (`alethia %s`): %v\n%s",
				b.StepID, strings.Join(argv, " "), err, out)
		}
		t.Logf("cli-demo [%s] %s: `alethia %s` ok", phase, b.StepID, strings.Join(argv, " "))
		if b.ReadBack != nil {
			rb := b.ReadBack(run)
			rctx, rcancel := context.WithTimeout(ctx, cliDemoBeatTimeout)
			rbCmd := exec.CommandContext(rctx, run.Bin, rb...)
			// THE SAME ENV as the beat. Inheriting os.Environ() instead would leave the read-back
			// with no ALETHIA_TOKEN and no origin — and ResolveWebOrigin's hosted default means it
			// would not fail, it would query PRODUCTION and find no identity there.
			rbCmd.Env = cliDemoEnv(run)
			rbOut, rbErr := rbCmd.CombinedOutput()
			rcancel()
			if rbErr != nil {
				t.Fatalf("cli-demo beat %q: the read-back `alethia %s` failed: %v\n%s",
					b.StepID, strings.Join(rb, " "), rbErr, rbOut)
			}
			out = string(rbOut)
		}
		if b.After != nil {
			if e := b.After(run, out); e != nil {
				t.Fatalf("cli-demo beat %q produced no usable output: %v", b.StepID, e)
			}
		}
		ran++
	}

	// A phase that ran nothing is the failure this tier exists to prevent — it is how the dimension
	// would go green having performed no command at all. Every phase in the table has beats; a
	// phase with none means the table was edited and the driver was not.
	if ran == 0 {
		t.Fatalf("cli-demo phase %q executed NO beats — the dimension would prove nothing. "+
			"Either the table lost its %s beats or the driver was called with a phase nothing declares.", phase, phase)
	}
}

// AssertCLIDemoJobClaimed proves the job the CLI created was CLAIMED, separately from whether the
// deploy finished.
//
// WHY IT IS ITS OWN ASSERTION. `claim_next_job`'s self-runner branch scopes to
// `j.org_id = v_runner_org_id` (#392). If the runner is registered in a different org from the one
// the service token is pinned to, the job the CLI created is never claimed — it sits QUEUED, the
// spine's wait runs to its full deadline, and the run is reported as a DEPLOY TIMEOUT. That names
// the wrong layer entirely: the cluster is fine, the runner is fine, and the actual fault is a
// tenancy mismatch that was decidable in seconds.
//
// So this waits a SHORT window for the job to leave QUEUED and, on failure, says the thing that is
// actually wrong. It is the cheap half of the deploy wait, taken first.
func AssertCLIDemoJobClaimed(ctx context.Context, t *testing.T, cp *ControlPlane, run *CLIDemoRun) {
	t.Helper()
	if err := awaitCLIDemoClaim(ctx, run, func(c context.Context) (string, error) {
		status, _, err := cp.JobState(c, run.ApplyJobID)
		return status, err
	}); err != nil {
		t.Fatal(err)
	}
	t.Logf("cli-demo: the CLI's DEPLOY job %s was claimed — runner and token agree on org %s",
		run.ApplyJobID, run.OrgID)
}

// awaitCLIDemoClaim is the decision, separated from the ControlPlane so the FAILURE MESSAGE is
// testable without a cluster.
//
// That separation is the point: the message is the whole value of this assertion. If it does not
// name the tenancy rule, the operator reads a stuck job and starts looking at the cluster — which
// is precisely the wrong-layer reporting this exists to prevent. A message nobody can test is a
// message that rots.
func awaitCLIDemoClaim(ctx context.Context, run *CLIDemoRun, status func(context.Context) (string, error)) error {
	deadline := time.Now().Add(cliDemoClaimWindow)
	last := "(never read)"
	for time.Now().Before(deadline) {
		s, err := status(ctx)
		if err == nil {
			last = s
			if s != "QUEUED" {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("cli-demo: cancelled while waiting for the CLI's job to be claimed: %w", ctx.Err())
		case <-time.After(cliDemoClaimPoll):
		}
	}
	return fmt.Errorf("cli-demo: the DEPLOY job %s the CLI created is still %q after %s — it was never CLAIMED.\n"+
		"This is almost certainly a TENANCY mismatch, not a provisioning failure: claim_next_job's "+
		"self-runner branch scopes to `j.org_id = v_runner_org_id` (#392), and the runner is registered "+
		"in org %s. If the service token is pinned to a different org, no runner will ever claim this job, "+
		"and the deploy wait would have run to its full deadline reporting a timeout that names the cluster.",
		run.ApplyJobID, last, cliDemoClaimWindow, run.OrgID)
}

// cliDemoClaimPoll is how often the claim is re-read. A variable so the pure test can drive the
// loop in milliseconds rather than making the suite wait out a real poll interval.
var cliDemoClaimPoll = 5 * time.Second

// cliDemoClaimWindow bounds the claim check. Short on purpose: a claim is a database transaction a
// live runner performs within its poll interval, so a minute and a half that passes without one is
// not slow, it is wrong.
//
// A var, like cliDemoClaimPoll, so the pure test can drive the whole loop in milliseconds instead
// of making every PR wait out a real window to prove one error message.
var cliDemoClaimWindow = 90 * time.Second

// CLIDemoClusterSets translates the workflow's cheap node shape into `--set` pairs for the
// component-add beat.
//
// WHY IT IS TRANSLATED AND NOT RESTATED. On the seeded path the workflow's shape reaches the
// snapshot through ALETHIA_E2E_CLUSTER_JSON, merged key by key by t2MergeClusterJSON. The CLI path
// has no snapshot to merge into — the CLI AUTHORS the project — so without this the project takes
// the TEMPLATE DEFAULTS, which on aws is m5a.4xlarge x2 and which the harness's own cost guard
// hard-fails before spending. Writing the shape out again here would put a second copy of it one
// edit away from disagreeing with the workflow; reading the same variable cannot.
//
// Hetzner passes no shape at all (its template default is already cents/run), so this returns
// nothing there and the beat is unchanged — which is correct, not a gap.
//
// KNOWN LIMIT, stated rather than hidden: nested objects are skipped. `provider_config` is the only
// one today, and `--set` takes scalars and JSON arrays. A skipped key is reported so it cannot pass
// as "there was nothing to set".
func CLIDemoClusterSets(t *testing.T) []string {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv("ALETHIA_E2E_CLUSTER_JSON"))
	if raw == "" {
		return nil
	}
	var shape map[string]any
	if err := json.Unmarshal([]byte(raw), &shape); err != nil {
		t.Fatalf("cli-demo: ALETHIA_E2E_CLUSTER_JSON is not JSON (%v) — the project would be authored "+
			"with template defaults, which the cost guard refuses on aws:\n%s", err, raw)
	}
	keys := make([]string, 0, len(shape))
	for k := range shape {
		keys = append(keys, k)
	}
	sort.Strings(keys) // deterministic argv, so a failing beat is reproducible from its log
	var sets []string
	for _, k := range keys {
		switch v := shape[k].(type) {
		case map[string]any:
			t.Logf("cli-demo: skipping nested cluster key %q — `--set` takes scalars and JSON arrays", k)
		case []any, string, float64, bool:
			enc, err := json.Marshal(v)
			if err != nil {
				t.Fatalf("cli-demo: encoding cluster key %q: %v", k, err)
			}
			val := string(enc)
			if sv, ok := v.(string); ok {
				val = sv // a bare string, not a quoted one — `--set engine=postgres`
			}
			sets = append(sets, "--set", k+"="+val)
		default:
			t.Logf("cli-demo: skipping cluster key %q of unhandled type %T", k, v)
		}
	}
	return sets
}

// cliDemoEnv is the environment EVERY cli-demo invocation runs with — the beat and its read-back
// alike. One builder, because the two differing is exactly how a read-back ends up querying the
// hosted control plane instead of the console under test.
func cliDemoEnv(run *CLIDemoRun) []string {
	return append(os.Environ(),
		"ALETHIA_TOKEN="+run.Token,
		cliDemoAPIEnv+"="+run.APIBase,
		// A demo runs on a fresh machine; an update check that reaches the network turns a beat's
		// timeout into a story about the CLI being slow.
		"ALETHIA_NO_UPDATE_CHECK=1",
	)
}

// cliDemoBeatTimeout bounds ONE command. Generous, because a first request to a console that has
// just booted pays for a cold Next.js route, and a beat that times out on that would be reported as
// a CLI that cannot reach a command it reaches perfectly well.
const cliDemoBeatTimeout = 4 * time.Minute
