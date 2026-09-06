// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"time"
)

// The T2 timeout LADDER, in one place, derived rather than restated.
//
// e2e-nightly.yml used to hard-code four numbers (ctx-implied 40m, `go test -timeout` 80m, step 75m,
// job 90m) beside a comment asserting "All three exceed the ctx so the ctx cancels first". Both the
// comment and the ordering were wrong:
//
//  1. The stated 40m base is HETZNER's — 25m waitTimeout + 8m ArgoCD + 7m headroom, the numbers as
//     they stood then (hetzner's waitTimeout is 40m now and the lean argo budget is 12m30s since
//     #3580, so that base is 59m30s; the arithmetic below
//     is derived and needed no edit for it). Every managed
//     cloud has a 50m waitTimeout (t2ProviderTable), and the soak is on by default from the workflow
//     (`vars.E2E_SOAK || '10m'` ⇒ 10m + 15m headroom). So a managed floor leg's real ctx is
//     50 + 8 + 25 + 7 = 90m, against a 75m STEP CAP. The ctx could not cancel first on any of the
//     four managed clouds; the step killed the process instead, which loses the named scenario
//     failure AND skips the in-process t.Cleanup teardown, leaking the cluster to the workflow
//     sweeper. It had not bitten only because gcp/azure/alibaba were dying fast at KMS (#2262).
//  2. `go test -timeout 80m` EXCEEDED the 75m step cap, so go's own timeout could never fire and
//     its goroutine dump — the thing that names which scenario hung — was unreachable by construction.
//
// The correct ordering is ctx < go-timeout < step < job, each margin serving a purpose:
//
//	ctx      cancels first  → the scenario reports its own bounded failure, and t.Cleanup tears down
//	teardown reserved       → the t.Cleanup destroy's OWN window, inside the process deadline
//	go       +5m            → if the ctx is somehow not honored, go panics with a stack naming the test
//	step     +5m            → if go is wedged, the step kills it and the run still reaches teardown
//	job      +15m           → proof capture and the scrub run after the step is done
//
// The teardown rung is why GoTimeout is NOT simply Ctx+margin. This comment used to say the job's
// +15m covered "teardown, proof capture and the scrub", which conflated two different teardowns: the
// WORKFLOW sweeper does run after the step, but the in-process t.Cleanup destroy runs INSIDE the go
// test process, so only GoTimeout can bound it. Nothing reserved for it, and aws/byo run 32909287152
// passed every assertion and was recorded FAIL with an internet gateway still detaching (#2729).
// Teardown is deliberately excluded from Ctx: the test BODY must not get a longer wait because the
// destroy is slow.
//
// ResolveT2Budget is the ONE definition. The tagged cloud test derives its ctx from it, the workflow
// derives its step and go-timeout from it (cmd/t2budget), and TestT2BudgetLadderHolds proves the
// ordering for every cloud × scenario combination on every PR. Numbers cannot drift from prose here,
// because there is no prose carrying a number.
const (
	t2GoTimeoutMargin = 5 * time.Minute
	t2StepMargin      = 5 * time.Minute
	t2JobMargin       = 15 * time.Minute

	// Runner build + snapshot seeding + the slack the old comment called "headroom".
	t2BaseHeadroom = 7 * time.Minute

	// Post-ArgoCD polling windows. Each is the scenario's own, and each exists because a ctx that
	// expired mid-poll is indistinguishable from the thing under test having never worked.
	t2XacctPollBudget    = 10 * time.Minute
	t2KeylessPostDwell   = 20 * time.Minute
	t2RegistryPollBudget = 25 * time.Minute
	t2SoakHeadroom       = 15 * time.Minute // drift wait (10m) + PVC bind (5m)
	// cliDemoProvisionBudget bounds the BEATS, not the cluster: the apply's wait is already
	// reserved as deploy-wait. It covers the ordered command sequence plus the console the job
	// booted answering them — generous, because a beat that times out on a slow first request would
	// report the CLI cannot reach something it can.
	cliDemoProvisionBudget = 20 * time.Minute

	// The day-2 access layer had NO ladder term at all, so its probes spent against `headroom`
	// unnoticed. At the old flat 3m that was survivable by luck; with a URL ceiling sized for an
	// ALB it would not be. Same defect as #2729's teardown window — a real, bounded wait the ladder
	// does not reserve for — fixed the same way rather than by keeping the ceiling too small to
	// notice. The two probes are reserved SEPARATELY because only one of them waits on a load
	// balancer, and only one of them runs on every dimension.
)

// T2BudgetTerm is one enabled scenario's contribution, kept named so a failure can say which
// scenario's window blew the ladder rather than printing one opaque total.
type T2BudgetTerm struct {
	Scenario string
	D        time.Duration
}

// T2Budget is the resolved ladder for one leg.
type T2Budget struct {
	Provider  string
	Terms     []T2BudgetTerm
	Ctx       time.Duration
	GoTimeout time.Duration
	Step      time.Duration
	Job       time.Duration
}

// Describe renders the ladder for a log line or a step summary.
func (b T2Budget) Describe() string {
	parts := make([]string, 0, len(b.Terms))
	for _, t := range b.Terms {
		parts = append(parts, fmt.Sprintf("%s %s", t.Scenario, t.D))
	}
	return fmt.Sprintf("%s: ctx %s (= %s) < go %s < step %s < job %s",
		b.Provider, b.Ctx, strings.Join(parts, " + "), b.GoTimeout, b.Step, b.Job)
}

// ResolveT2Budget computes the ladder from the environment the leg will actually run with. env is the
// environment slug, needed only because the fabric-demo term scales with its parsed overlay tiers.
//
// Enablement is read from each scenario's own predicate rather than from its richer decide() result:
// a scenario that is configured but turns out BLOCKED (a documented per-cloud exclusion) simply does
// not spend its budget, and over-allocating a ceiling is harmless. Under-allocating is the bug.
func ResolveT2Budget(provider, env string) (T2Budget, error) {
	p, ok := t2LookupProvider(provider)
	if !ok {
		return T2Budget{}, fmt.Errorf("no T2 provider row for %q — add it to t2ProviderTable", provider)
	}

	b := T2Budget{Provider: provider}
	add := func(name string, d time.Duration) {
		if d > 0 {
			b.Terms = append(b.Terms, T2BudgetTerm{Scenario: name, D: d})
		}
	}

	add("deploy-wait", resolveT2WaitTimeout(p))
	add("argocd-converge", ArgoAssertTimeout())
	// The max-config cluster probes (#2652). `argocd-converge` above pays for AssertArgoAppsHealthy
	// and nothing else; the probes are a SECOND, independent wait that used to spend against a ctx
	// reserving nothing for them. Until #2652 that only touched hetzner, where the store is Ready in
	// seconds — from there it fires on all four managed clouds, i.e. exactly the clouds where the
	// store is the thing hypothesised to be missing and the poll therefore runs long.
	//
	// Sized from the grid itself, so adding a probed cell moves the ladder without anyone
	// remembering to.
	if MaxConfigEnabled() {
		add("max-config-probe", MaxConfigProbeBudget(provider))
	}

	soakDur, soakOn, err := parseSoakDuration(os.Getenv("ALETHIA_E2E_SOAK"))
	if err != nil {
		return T2Budget{}, err
	}
	if soakOn {
		add("soak", soakDur+t2SoakHeadroom)
	}
	if Day2AccessEnabled() {
		add("day2-access", Day2AccessTimeout())
		// The URL probe reservation MIRRORS ITS EMITTER rather than assuming the probe always runs.
		// A managed ArgoCD URL needs an ingress with a certificate, and the workflow sets
		// ALETHIA_E2E_ACM_CERT only when MAX_CONFIG is off (#2630) — so on a `full` bar there is no
		// URL, HasArgoURL is false, and the probe is skipped entirely. Reserving for it anyway would
		// inflate the heaviest bar's ctx by ten minutes it cannot spend, and that inflation lands on
		// the one dimension whose ladder is already closest to the cap.
		if acmCertEnabled() && !MaxConfigEnabled() {
			add("day2-url", Day2URLTimeout())
		}
	}
	// The CLI-demo provision (#3038): the beats re-drive the floor spine through the real binary,
	// so the cluster time is already covered by deploy-wait above. What is NOT covered is the beats
	// themselves — a sequence of real commands against a console this job booted — so they get their
	// OWN term rather than being absorbed into someone else's headroom.
	//
	// Folding it into `headroom` was the tempting shortcut and is the wrong one: headroom is what
	// absorbs variance in terms that ARE reserved, and a scenario hidden inside it is a scenario
	// nobody can see in the ladder the workflow prints. Every other opt-in scenario here is a named
	// term for that reason.
	if CLIDemoProvisionEnabled() {
		add("cli-demo", cliDemoProvisionBudget)
	}
	if secretsXacctEnabled() {
		add("secrets-xacct", t2XacctPollBudget)
	}
	if keylessDBEnabled() {
		add("keyless-db", keylessDBFromEnv(provider).dwell+t2KeylessPostDwell)
	}
	if xacctRegistryEnabled() {
		add("xacct-registry", t2RegistryPollBudget)
	}
	if namespaceTenantEnabled() {
		add("namespace-placement", namespaceTenantBudget)
	}
	if vclusterTenantEnabled() {
		add("vcluster-placement", vclusterTenantBudget)
	}
	if fabricDemoEnabled() {
		tiers, tErr := fabricDemoTiers(env, provider)
		if tErr != nil {
			return T2Budget{}, fmt.Errorf("fabric-demo (#845): %w", tErr)
		}
		d := fabricDemoTimeout()
		add("fabric-demo", time.Duration(len(tiers))*2*d+d+vclusterTenantBudget)
	}
	// ⚠️ HEADROOM ALSO PAYS FOR THE FAILING-PATH DUMP, and that is a deliberate exception to the
	// rule this function otherwise keeps.
	//
	// Every other real cost here is a NAMED term, because a cost hidden inside headroom is a cost
	// nobody can see in the ladder the workflow prints. `argoDeadlineDump` is the exception: it runs
	// only when a leg has already failed, so reserving for it would inflate every ladder including
	// the widest — and the widest is already within four minutes of T2_JOB_CAP_MINUTES. Buying
	// visibility by raising the cap on every cloud, for time only a failing run can spend, is the
	// worse trade.
	//
	// And it is NOT carved out of headroom either, because headroom is not slack: this constant is
	// "runner build + snapshot seeding + the slack the old comment called headroom", and
	// t2BuildRunner alone carries a five-minute ceiling spent after ctx is created. Sizing the dump
	// against seven minutes would be arithmetic on an allowance that was never free.
	//
	// Instead the dump takes whatever is ACTUALLY left, capped by `argoDumpBudget` (argocd_assert.go)
	// and decided by `planArgoDump`, whose notice says which of the two bound it. If it ever needs
	// more than the leg can spare, that is the moment to make it a term and raise the cap.
	add("headroom", t2BaseHeadroom)

	for _, t := range b.Terms {
		b.Ctx += t.D
	}
	// Whole minutes, rounded UP: the workflow's timeout-minutes is an integer, and truncating would
	// invert the very ordering this function exists to guarantee.
	b.GoTimeout = ceilMinutes(b.Ctx + resolveT2TeardownTimeout(p) + t2GoTimeoutMargin)
	b.Step = ceilMinutes(b.GoTimeout + t2StepMargin)
	b.Job = ceilMinutes(b.Step + t2JobMargin)
	return b, nil
}

// ceilMinutes rounds a duration up to a whole number of minutes.
func ceilMinutes(d time.Duration) time.Duration {
	return time.Duration(math.Ceil(d.Minutes())) * time.Minute
}

// T2BudgetScenarioEnv lists every env var ResolveT2Budget reads to decide a term, so the ladder test
// can enumerate combinations without hard-coding a list that would silently fall behind a new
// scenario. Sorted for a deterministic test order.
func T2BudgetScenarioEnv() []string {
	vars := []string{
		"ALETHIA_E2E_SOAK",
		"ALETHIA_E2E_DAY2_ACCESS",
		envSecretsXacct,
		envKeylessDB,
		envXacctRegistry,
		"ALETHIA_E2E_NAMESPACE_TENANT",
		"ALETHIA_E2E_VCLUSTER",
		envFabricDemo,
	}
	sort.Strings(vars)
	return vars
}
