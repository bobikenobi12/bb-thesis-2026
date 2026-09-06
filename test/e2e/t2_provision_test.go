// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t2

// T2 — the REAL-CLOUD provisioning proof driven by the REAL runner BINARY.
//
// Build-tagged `e2e_t2` so it is OFF for bare `go test`, every-PR CI, and the
// merge-queue T1 job. It runs ONLY in the nightly `e2e-nightly.yml` workflow, which
// a maintainer opts into by wiring the required cloud secret (e.g. HCLOUD_TOKEN).
//
//	cd test/e2e
//	GOWORK=off go test -tags=e2e_t2 ./... -run TestT2RealCloudProvisioning -v
//
// # Relationship to T1
//
// T1 (t1_provision_test.go) drives the SAME real-runner-claims-from-a-real-control-
// plane pattern against a hermetic local `kind` cluster (no cloud, no cost). T2
// reuses that whole pattern — the Postgres-backed control plane, the atomic claim,
// the status-callback + log-shipping paths, the signed-receipt verification, the
// bounded WaitTerminal — from controlplane.go verbatim, but points the runner at the
// REAL cloud template (infra/templates/project/<provider>) with a real API token, so
// it stands up a genuine ephemeral cluster. It asserts the SAME RunDeployV2 outcomes
// as T1: SUCCESS + cluster_ready + a signed evidence receipt + shipped logs.
//
// # Cost + safety (this test provisions REAL, billable infrastructure)
//
//   - Teardown is GUARANTEED and registered BEFORE the deploy: a t.Cleanup runs the
//     REAL provisioner.RunDestroy (reading state back from the control plane) even on
//     a mid-apply failure. The control plane's state backend is in-memory, so it dies
//     with this process — there is no persisted state to purge.
//   - The in-process RunDestroy is the GRACEFUL teardown. It cannot run if the test
//     PROCESS is hard-killed (a `go test -timeout` panic or a CI step SIGKILL skips
//     t.Cleanup). The nightly workflow therefore ALSO runs a belt-and-suspenders
//     `scripts/e2e/hcloud-cleanup.sh` in an `always()` step that deletes cloud
//     resources by the UNIQUE per-run `cluster` label — independent of this process.
//   - The cluster name is DETERMINISTIC and unique per run: the workflow passes
//     ALETHIA_E2E_PROJECT + ALETHIA_E2E_ENV, so `<project>-<env>` matches EXACTLY the
//     `cluster` label the template stamps on every hcloud resource. The workflow's
//     cleanup filters on that same label — never an account-wide delete (the hcloud
//     account is shared with prod/test clusters; see the scope-destructive-cloud-ops
//     memory).
//
// # How each way this test could go VACUOUS is defeated (mirrors T1)
//
//   - a missing prerequisite (tofu/kubectl/helm) or a missing HCLOUD_TOKEN →
//     ALETHIA_E2E_T2_REQUIRE=1 (set by the nightly) turns it into a HARD FAIL, never
//     a green skip. Off CI it skips cleanly.
//   - the runner never claims → WaitTerminal is a BOUNDED poll; it errors, never
//     blocks forever.
//   - "tofu apply exited 0" masquerading as a working cluster → we assert
//     cluster_name (post-apply spine not skipped) AND cluster_ready==true (the
//     runner's reachability gate proved a live API + Ready node + pod datapath).
//   - a nil/empty receipt → we require a signed receipt sealed to the real plan
//     sha256 whose ed25519 signature verifies under our pub.
//   - in-process-only work → we assert a status callback reached `jobs` and log lines
//     reached `job_logs` over the real HTTP paths.
//   - ArgoCD merely INSTALLED but broken (an app stuck Progressing/Degraded/OutOfSync
//     used to pass this tier) → every expected Application must reach Healthy+Synced
//     via the runner-written kubeconfig, bounded by ALETHIA_E2E_ARGO_TIMEOUT. The
//     expected set is DERIVED from the persisted infra_services + addon_status
//     metadata, and an EMPTY derived set FAILS (never a vacuous assertion) — the
//     seed add-ons guarantee it never is (see argocd_assert.go + seedAddOns).
package e2e

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestT2RealCloudProvisioning stands up a real ephemeral cluster on a real cloud via
// the real runner binary claiming a real DEPLOY job, asserts the RunDeployV2 spine
// succeeded, and guarantees teardown. Maintainer-gated: it only does real work when
// the cloud token + tools are present (a HARD FAIL under ALETHIA_E2E_T2_REQUIRE).
func TestT2RealCloudProvisioning(t *testing.T) {
	// Provider table (BYOC A0.1): hetzner is the only row the nightly runs today, but
	// aws/gcp/azure/alibaba are wired here so their per-cloud waves only add a workflow
	// matrix entry + secret. An unknown provider is a HARD FAIL (replaces the old
	// hetzner-only fatal).
	provider := t2Env("ALETHIA_E2E_PROVIDER", "hetzner")
	p, ok := t2LookupProvider(provider)
	if !ok {
		t.Fatalf("T2: unknown provider %q — supported: %s", provider, t2SupportedProviders())
	}

	// Prerequisites: the real spine shells out to these, plus a migrated control-plane
	// Postgres and the provider's cloud credentials. (No `kind` — this is a real cloud,
	// not local.)
	for _, bin := range []string{"tofu", "kubectl", "helm", "go"} {
		t2RequireOrSkip(t, t2HaveBin(bin), bin+" not on PATH")
	}
	dbURL := os.Getenv("ALETHIA_DATABASE_URL")
	t2RequireOrSkip(t, dbURL != "", "ALETHIA_DATABASE_URL is unset (the migrated control-plane DB)")
	// Per-provider credential detection: the cloud token(s) flow to the runner via the
	// ambient environment (os.Environ below), so we only assert they are PRESENT here —
	// a HARD FAIL under ALETHIA_E2E_T2_REQUIRE, a clean skip off CI.
	credsOK, credsMsg := p.credsPresent()
	t2RequireOrSkip(t, credsOK, credsMsg)

	// Cost guard (BYOC F4): the managed clouds have expensive default node shapes (AWS
	// m5a.4xlarge×2 ≈ $0.30/run), so a real run MUST pin a cheapest-shape override via
	// ALETHIA_E2E_CLUSTER_JSON. Missing it is a HARD FAIL under REQUIRE (the nightly always
	// injects one — this catches a workflow typo), a warning locally. Hetzner is exempt
	// (proven cents/run default).
	if fatal, msg := t2RequireCostShape(provider); msg != "" {
		if fatal {
			t.Fatalf("T2 cost guard: %s", msg)
		}
		t.Logf("T2 cost guard (warning): %s", msg)
	}

	// ── ArgoCD-WITH-REPOS + BYO Helm proof (BYOC A0.6) — the customer-repo half. Opt-in:
	// a fully-absent config is a clean skip (base T2 A0.1–A0.5 still proves), but a REQUIRED
	// run (the nightly sets ALETHIA_E2E_ARGO_REPOS_REQUIRE whenever the apps-repo var is set)
	// or a PARTIAL config is a HARD FAIL — a half-wired secret can never silently disable it.
	// Resolved here (before seeding) so a misconfig fails fast, and so the same config drives
	// both the seeded snapshot and the assertion. Intentionally AFTER the provider-creds gate
	// above: "required" means "if the base T2 proof runs, the repos proof must too" — with no
	// cloud creds there is no cluster to prove anything on, so the whole test skips first. ──
	repos := t2ArgoReposFromEnv()
	reposEnabled, reposErr := repos.decide()
	if reposErr != nil {
		t.Fatalf("A0.6: %v", reposErr)
	}
	if reposEnabled {
		t.Logf("A0.6: ArgoCD-with-repos ENABLED — apps repo %q + BYO chart repo %q will be wired and asserted", repos.appsRepo, repos.byoChartRepo)
	} else {
		t.Log("A0.6: ArgoCD-with-repos SKIPPED — no apps/BYO repo configured (set ALETHIA_E2E_ARGO_APPS_REPO + ALETHIA_E2E_ARGO_BYO_CHART_REPO + ALETHIA_E2E_GIT_TOKEN). Base T2 proof still runs.")
	}

	// #1268: resolve the cross-account secrets scenario HERE, before any provisioning spend — a
	// misconfigured opt-in must fail in seconds, not after a cluster exists. A BLOCKED cloud
	// resolves to "off" carrying the recorded reason (secretsXacctLane), never a silent skip.
	xacct := secretsXacctFromEnv(provider)
	xacctOn, xacctBlocked, xacctErr := xacct.decide()
	if xacctErr != nil {
		t.Fatalf("#1268 cross-account secrets: %v", xacctErr)
	}
	switch {
	case xacctOn:
		t.Logf("#1268: cross-account keyless secrets ENABLED — %s reading %q from the target account via %s",
			xacct.connectorSlug(), xacct.remoteKey, xacct.storeName())
	case xacctBlocked != "":
		t.Logf("#1268: cross-account keyless secrets BLOCKED on %s — %s", provider, xacctBlocked)
	default:
		t.Logf("#1268: cross-account keyless secrets SKIPPED — set %s (+ its target vars) to enable.", envSecretsXacct)
	}

	// #1773: the ACM certificate scenario, resolved on the same terms. Two of its three outcomes are
	// HARD FAILURES rather than skips, deliberately: a half-wired opt-in, and a collision with the
	// full bar (this scenario BRINGS a zone id, which makes cloud_dns_enabled false, so no
	// aws_route53_zone is created and the max-config `dns` kind would report Missing). Either one
	// skipping quietly would read as "the certificate was proven" on a night it was not.
	acmCert := acmCertFromEnv(provider)
	acmCertOn, acmCertBlocked, acmCertErr := acmCert.decide()
	if acmCertErr != nil {
		t.Fatalf("#1773 ACM certificate: %v", acmCertErr)
	}
	switch {
	case acmCertOn:
		t.Logf("#1773: ACM certificate ENABLED — issuing for *.%s, validating in the pre-delegated zone %s",
			acmCert.domainName, acmCert.zoneID)
	case acmCertBlocked != "":
		// "NOT RUN" rather than "BLOCKED": this arm now carries two different facts — a cloud whose
		// lane cannot prove it, and a max-config dimension that withholds it. "BLOCKED on aws" would
		// read as "aws cannot do this", which is backwards; aws is the only lane that can.
		t.Logf("#1773: ACM certificate NOT RUN on %s — %s", provider, acmCertBlocked)
	default:
		t.Logf("#1773: ACM certificate SKIPPED — set %s (+ %s, %s) to enable.", envAcmCert, envAcmCertZoneID, envAcmCertZoneName)
	}

	// The `cli-demo` dimension's credential and binary are resolved EARLY — before a cluster is
	// bought — and nil when the dimension is off. The gate lives in ResolveCLIDemoRun rather than
	// here; see the note there for why the distinction matters to cli_demo_wiring_pure_test.go.
	cliDemo := ResolveCLIDemoRun(t)

	// #1511: keyless DB auth, resolved on the same terms and for the same reason — a misconfigured
	// opt-in must fail in seconds, and an EXCLUDED cell (alibaba/hetzner) resolves to "off" carrying
	// the product's own exclusion prose rather than a silent skip.
	keyless := keylessDBFromEnv(provider)
	keylessOn, keylessBlocked, keylessErr := keyless.decide()
	if keylessErr != nil {
		t.Fatalf("#1511 keyless DB auth: %v", keylessErr)
	}
	switch {
	case keylessOn:
		t.Logf("#1511: keyless DB auth ENABLED — %s × %s, holding a session open for %s to prove the token mints per connection",
			provider, keyless.engine, keyless.dwell)
	case keylessBlocked != "":
		t.Logf("#1511: keyless DB auth BLOCKED on %s × %s — %s", provider, keyless.engine, keylessBlocked)
	default:
		t.Logf("#1511: keyless DB auth SKIPPED — set %s (+ its engine vars) to enable.", envKeylessDB)
	}

	// #1047: the cross-account keyless REGISTRY pull, resolved on the same terms. The mint half was
	// proven off-cluster in July 2026; what has never run is the in-cluster half — the B4 pull role
	// federating the refresher, the refresher minting with no local credential, and a real pod
	// pulling through the Secret it patches. alibaba/hetzner resolve to a documented exclusion.
	registry := xacctRegistryFromEnv(provider)
	registryOn, registryBlocked, registryErr := registry.decide()
	if registryErr != nil {
		t.Fatalf("#1047 cross-account registry: %v", registryErr)
	}
	switch {
	case registryOn:
		t.Logf("#1047: cross-account keyless registry ENABLED — %s pulling %q from %s into service %q",
			registry.connectorSlug(), registry.image, registry.host, registry.serviceName)
	case registryBlocked != "":
		t.Logf("#1047: cross-account keyless registry EXCLUDED on %s — %s", provider, registryBlocked)
	default:
		t.Logf("#1047: cross-account keyless registry SKIPPED — set %s (+ its target vars) to enable.", envXacctRegistry)
	}

	root := t2RepoRoot(t)
	waitTimeout := resolveT2WaitTimeout(p)

	// ── The cluster identity is DETERMINISTIC + unique per run. The workflow passes
	// these (derived from the GitHub run id/attempt) and feeds the SAME
	// `<project>-<env>` to the belt-and-suspenders cleanup, so the label filter is an
	// exact match. A random fallback keeps a local invocation safe (never a bare or
	// shared name that a broad delete could catch). Resolved BEFORE the ctx budget below,
	// which needs `env` to parse the placement tiers. ──
	project := t2Env("ALETHIA_E2E_PROJECT", "alethia-nl")
	env := t2Env("ALETHIA_E2E_ENV", "local"+t2ShortHex(t))
	// Generalized ALETHIA_E2E_REGION (legacy ALETHIA_E2E_HCLOUD_REGION still honored for
	// hetzner), falling back to the provider row's cheap default.
	region := resolveT2Region(p)
	clusterName := project + "-" + env
	t.Logf("T2 target: provider=%s region=%s cluster=%s", provider, region, clusterName)
	// The whole ctx budget — every scenario's term — now lives in ResolveT2Budget (t2_budget.go),
	// because the workflow needs the same arithmetic to set its step and go-timeout and the two used
	// to be maintained independently. They disagreed: the workflow's prose asserted a 40m ctx (which
	// is HETZNER's) against a 75m step cap, while a managed cloud with the default-on soak really
	// wants 90m — so on all four managed clouds the step killed the process before the ctx could
	// cancel, losing both the named scenario failure and the in-process teardown.
	//
	// The tier count is still needed here for the #845 node-shape guard below: the demo's capacity
	// floor scales with it (each tier is a boutique copy, and one is placed twice).
	fabricDemoTierCount := 0
	if fabricDemoEnabled() {
		tiers, tErr := fabricDemoTiers(env, provider)
		if tErr != nil {
			t.Fatalf("fabric-demo (#845): %v", tErr)
		}
		fabricDemoTierCount = len(tiers)
	}
	// The ctx comes from ResolveT2Budget (t2_budget.go) — the SAME function cmd/t2budget prints for
	// the workflow's step and go-timeout, so the ladder ctx < go < step < job cannot drift from what
	// this test actually asks for. A malformed soak or tier list fails LOUD here, before any spend.
	budget, budgetErr := ResolveT2Budget(provider, env)
	if budgetErr != nil {
		t.Fatalf("resolve T2 budget: %v", budgetErr)
	}
	t.Logf("T2 budget — %s", budget.Describe())
	ctx, cancel := context.WithTimeout(context.Background(), budget.Ctx)
	defer cancel()

	// ── Build the REAL runner binary (this is what makes it a spine proof, not a unit
	// test) — identical to T1. ──
	runnerBin := filepath.Join(t.TempDir(), "alethia-runner")
	t2BuildRunner(t, root, runnerBin)

	// ── Stage the REAL cloud template so the runner resolves
	// `project-templates/<provider>` from its CWD. Unlike T1 (which stages the LOCAL
	// kind module as "hetzner"), we stage the genuine cloud template verbatim. ──
	stage := t.TempDir()
	realTemplateSrc := filepath.Join(root, "infra", "templates", "project", provider)
	stagedTemplate := filepath.Join(stage, "project-templates", provider)
	t2CopyTree(t, realTemplateSrc, stagedTemplate)

	// ── Receipt signing key: runner gets the private half; we keep pub to VERIFY. ──
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519 key: %v", err)
	}

	// ── Real control plane over real Postgres (reused verbatim from controlplane.go). ──
	cp, err := NewControlPlane(ctx, dbURL)
	if err != nil {
		t.Fatalf("control plane: %v", err)
	}
	cp.Start()
	// LIFO: Close registered FIRST so it runs LAST — after teardown, which reads state
	// over HTTP from this same server.
	t.Cleanup(cp.Close)

	// BYOC A0.5 — seed the console object graph (project + QUEUED env + reloader add-on row) and
	// load the snapshot-fidelity fixture BEFORE seeding the DEPLOY job, so the job links to the env
	// the replayed finalizeDeployment will drive to ACTIVE. Warn-only unless ALETHIA_E2E_A05_ENFORCE;
	// a seed/fixture failure disables A0.5 and falls back to the unlinked lean seed (provisioning is
	// never affected).
	a05 := setupA05(t, ctx, cp, root, project, env, provider, region)

	// The self runner MUST be seeded in the SAME org as the DEPLOY job it will claim —
	// claim_next_job's self-runner branch scopes to `j.org_id = v_runner_org_id` (audit P0, #392),
	// so a runner in a different org silently never claims and the job sits QUEUED until timeout
	// (the failure mode that made AWS T2's first run look like a template bug). On the A0.5 path the
	// job takes the graph's user/org; on the lean fallback both take `owner`. Seed the runner into
	// that same owner — the realistic "one owner owns project + runner + job" shape.
	// org == user in both paths (A0.5 sets g.orgID = g.userID; community tenancy for the lean seed),
	// so a single owner id fills both columns for the runner and the job.
	owner := newUUID()
	if g := a05.jobGraph(); g != nil {
		owner = g.userID
	}
	if cliDemo != nil {
		// #392: claim_next_job's self-runner branch scopes to `j.org_id = v_runner_org_id`. The CLI
		// creates its job in the org its SERVICE TOKEN is pinned to, so the runner must be
		// registered in that same org — otherwise the job the CLI creates is never claimed, sits
		// QUEUED, and the run dies on a deploy timeout that reads as a provisioning defect.
		owner = cliDemo.OrgID
	}
	runnerID, runnerToken, err := cp.SeedRunner(ctx, owner, owner)
	if err != nil {
		t.Fatalf("seed runner: %v", err)
	}

	// Build the runner-facing DEPLOY snapshot. `base` is the pre-repos/pre-cluster-json snapshot the
	// fidelity check runs against (lean synthetic by default; the REAL console fixture shape under
	// ALETHIA_E2E_A05_REAL_SNAPSHOT); `full` layers the A0.6 repos + the per-cloud cluster-json
	// override the runner actually consumes.
	base, full, err := t2DeploySnapshot(t, project, env, provider, region, repos, reposEnabled, xacct, xacctOn, keyless, keylessOn, registry, registryOn, acmCert, acmCertOn, a05)
	if err != nil {
		t.Fatalf("build deploy snapshot: %v", err)
	}
	// FT-5 node-shape guard: the full heavy surface (max-config + all-add-ons) must not be launched on
	// a node too small to schedule it — a HARD FAIL under REQUIRE (before any provisioning spend),
	// a warning locally. A no-op unless both heavy dimensions are on.
	if fatal, msg := t2RequireMaxConfigNodeShape(provider, full); msg != "" {
		if fatal {
			t.Fatalf("FT-5 node-shape guard: %s", msg)
		}
		t.Logf("FT-5 node-shape guard (warning): %s", msg)
	}
	// #845 node-shape guard: the fabric demo places the boutique overlays once per tier PLUS once more
	// inside the vcluster, and on the nightly's cheapest floor shape those pods sit Pending until the
	// job cap kills the run — ~11 hours of billed cluster time across four clouds to learn a node size.
	// Same posture as FT-5 above: hard under REQUIRE, before any spend.
	if fatal, msg := t2RequireFabricDemoNodeShape(provider, full, fabricDemoTierCount); msg != "" {
		if fatal {
			t.Fatalf("#845 fabric-demo node-shape guard: %s", msg)
		}
		t.Logf("#845 fabric-demo node-shape guard (warning): %s", msg)
	}
	// PRE-SPEND capacity preflight: the two guards above ask whether the shape is big enough
	// for what this run asserts; this one asks whether the cloud will sell us that shape HERE.
	// On 2026-08-25 two hetzner runs died five minutes into a paid apply because cx33 has
	// capacity in no datacenter Hetzner operates — a fact one free GET answers. Hard under
	// REQUIRE on a definite refusal; NEVER fatal on UNKNOWN, which is a probe that did not get
	// an answer rather than an answer of "no".
	if fatal, msg := t2RequireCapacityPreflight(ctx, provider, region, full); msg != "" {
		if fatal {
			t.Fatalf("pre-spend capacity preflight: %s", msg)
		}
		t.Logf("pre-spend %s", msg)
	}
	// #3078: the preflight above covers the NODE shape and nothing else. azure/maxconfig passed it
	// — "Standard_E2s_v3 is available in westeurope" — then built a real AKS cluster for ~1724s and
	// died in the apply on `azurerm_managed_redis` with InsufficientCapacity, orphan risk likely.
	// Managed Redis is a different service with its own regional capacity pool, so it needs its own
	// question asked before the spend. Silent on every cloud but azure, and on any azure run that
	// provisions no cache — see t2RequireAzureManagedRedisPreflight for the per-cloud reasons.
	if fatal, msg := t2RequireAzureManagedRedisPreflight(ctx, provider, region, full); msg != "" {
		if fatal {
			t.Fatalf("pre-spend %s", msg)
		}
		t.Logf("pre-spend %s", msg)
	}
	a05CheckFidelity(t, a05, base)

	var jobID string
	if cliDemo != nil {
		// THE WHOLE POINT OF THE DIMENSION: the DEPLOY job is created by the real binary through
		// the console's user-facing API, not written into `public.jobs` by the harness. The runner
		// half is untouched — the shim's claim calls the same `claim_next_job` over the same table,
		// so the same runner claims the same row (#3038).
		cliDemo.RunnerID = runnerID
		cliDemo.Provider, cliDemo.Region = provider, region
		cliDemo.Project, cliDemo.EnvName = project, env
		// The SAME shape the seeded path merges — read from ALETHIA_E2E_CLUSTER_JSON, not restated.
		cliDemo.ClusterSets = CLIDemoClusterSets(t)
		// ── Three refusals before anything is bought, cheapest first. ──
		//
		// 1. A cloud whose `connector` beat cannot COMPLETE against this dimension's console. Costs
		//    nothing, and it is the one that would otherwise be discovered twelve minutes in.
		// 2. A beat that names a command GROUP. `drift`, `cost` and `verify` are groups whose help
		//    exits 0, so such a beat performs nothing and PASSES.
		// 3. A beat that names a FLAG the command does not register — the same class as (2) one
		//    token to the right, and the one #4083 died on. Asked for every cloud, so the cheapest
		//    dispatch proves all of them.
		AssertCLIDemoConnectorIsDrivable(t, cliDemo)
		AssertCLIDemoBeatsAreLeafCommands(ctx, t, cliDemo)
		AssertCLIDemoBeatFlagsAreRegistered(ctx, t, cliDemo)
		DriveCLIDemoPhase(ctx, t, cliDemo, CLIDemoAuthoring)
		DriveCLIDemoPhase(ctx, t, cliDemo, CLIDemoEnqueue)
		jobID = cliDemo.ApplyJobID
		if jobID == "" {
			t.Fatal("cli-demo: `project apply` reported no job id — there is nothing to wait on")
		}
		t.Logf("cli-demo: DEPLOY job %s was created BY THE CLI (project %s)", jobID, cliDemo.ProjectID)
		// The CLAIM is asserted separately, just after the runner process starts — see the call
		// below. It cannot be asserted here: nothing is running yet to claim anything.
	} else {
		var jerr error
		jobID, jerr = seedT2DeployJob(ctx, cp, full, a05.jobGraph(), owner)
		if jerr != nil {
			t.Fatalf("seed job: %v", jerr)
		}
		t.Logf("seeded QUEUED DEPLOY job %s targeting %s template (cluster %s)", jobID, provider, clusterName)
	}

	// GUARANTEED graceful teardown — registered BEFORE launching the runner so a
	// mid-deploy failure still tears the cluster down. The workflow's always() cleanup
	// is the hard guarantee for a killed process; this is the in-process best effort.
	t.Cleanup(func() {
		// ── BEFORE THE DESTROY, and it has to be here (#3481). ────────────────────────────────
		// The hetzner CCM's ingress Load Balancer carries no hcloud label and cannot be made to;
		// its only binding to this run is its private-network attachment. `tofu destroy` deletes
		// that network FIRST, so the teardown sweep — which runs from the workflow, after this
		// test — finds the binding already gone and falls back to asking whether the PROJECT holds
		// any load balancer at all. Any concurrent run's LB then reds this leg, and a FAILED
		// teardown (network still up) verifies cleanly while a SUCCESSFUL one does not.
		//
		// A workflow step cannot get ahead of this: the destroy runs IN-PROCESS below, inside this
		// closure. So the capture is here, writing to the file the sweeper reads back — the same
		// $RUNNER_TEMP hand-off the harness already uses for ALETHIA_E2E_ARGOCD_SUMMARY.
		captureHetznerLoadBalancers(t, provider, clusterName)

		// Per-provider, and the SAME function ResolveT2Budget reserves the window with — a
		// flat 15m here was hetzner's number charged to every cloud (#2729).
		window := resolveT2TeardownTimeout(p)
		dctx, dcancel := context.WithTimeout(context.Background(), window)
		defer dcancel()
		if derr := teardownT2Cluster(dctx, cp.URL(), jobID, project, env, provider, region, stagedTemplate, t2LogWriter{t}); derr != nil {
			// The sweeper NAME follows the provider, and a window that EXPIRED is reported as a
			// window rather than as a destroy error — the two are opposite findings that arrive
			// wearing the same `signal: interrupt`. Both live in t2TeardownFailureLine, which is
			// untagged and unit-tested, because this branch only executes on a paid cloud run.
			// `dctx.Err()` is read AFTER the call returns, so it is the deadline's own verdict.
			t.Logf("%s", t2TeardownFailureLine(provider, window, dctx.Err(), derr))
		} else {
			t.Log("teardown: cluster destroyed via RunDestroy")
		}
	})

	// ── Launch the REAL runner process pointed at the control plane, with the cloud
	// credentials in its environment. cloud_identity is nil (like T1), so the runner does
	// no credential activation and each provider reads its own token(s) straight from the
	// ambient env (HCLOUD_TOKEN / AWS_* / GOOGLE_APPLICATION_CREDENTIALS / ARM_* /
	// ALICLOUD_*) — the self-managed / ambient-token path. os.Environ() carries them all,
	// so no per-provider token line is needed here. ──
	var runnerOut bytes.Buffer
	runnerCtx, killRunner := context.WithCancel(ctx)
	defer killRunner()
	cmd := exec.CommandContext(runnerCtx, runnerBin)
	cmd.Dir = stage
	cmd.Env = append(os.Environ(),
		"ALETHIA_WEB_ORIGIN="+cp.URL(),
		"ALETHIA_RUNNER_ID="+runnerID,
		"ALETHIA_RUNNER_TOKEN="+runnerToken,
		"ALETHIA_RUNNER_OPERATOR=self",
		"ALETHIA_RECEIPT_SIGNING_KEY="+base64.StdEncoding.EncodeToString(priv),
		"ALETHIA_CLUSTER_READY_TIMEOUT="+resolveT2ClusterReadyTimeout(p),
		"ALETHIA_ARGOCD_TEMPLATES_DIR="+filepath.Join(root, "infra", "templates", "argocd"),
	)
	if keylessOn {
		// #1511: keyless DB auth is still a DARK FLAG, so the runner must be told. Set HERE rather
		// than in the workflow deliberately: it is not an ALETHIA_E2E_* variable, so
		// TestScenarioEnablesReachTheNightly cannot protect it — a workflow-side setting could
		// silently stop being passed and every leg would quietly prove the password path instead.
		// Wiring it to the scenario's own switch makes that impossible, and #1513 deletes both
		// together.
		cmd.Env = append(cmd.Env, "ALETHIA_KEYLESS_DB_AUTH_ENABLED=true")
	}
	if registryOn {
		// #1047: the cross-account registry refresher is DARK by default
		// (provisioner.writeRegistryRefresher returns before rendering anything unless this is
		// "true"), so with the flag off the generated manifests are byte-identical and the scenario
		// would poll for a Deployment that was never written. Set HERE, wired to the scenario's own
		// switch, for the same reason as the keyless flag above: it is not an ALETHIA_E2E_* variable,
		// so TestScenarioEnablesReachTheNightly cannot protect it, and a workflow-side setting could
		// silently stop being passed while every leg still reported green.
		cmd.Env = append(cmd.Env, "ALETHIA_XACCT_REGISTRY_ENABLED=true")
	}
	var runnerSink io.Writer = &runnerOut
	if p := os.Getenv("ALETHIA_E2E_T2_RUNNER_LOG"); p != "" {
		if f, ferr := os.Create(p); ferr == nil {
			t.Cleanup(func() { _ = f.Close() })
			runnerSink = io.MultiWriter(&runnerOut, f)
		}
	}
	cmd.Stdout = runnerSink
	cmd.Stderr = runnerSink
	if err := cmd.Start(); err != nil {
		t.Fatalf("start runner process: %v", err)
	}

	// The CLI's job must be CLAIMED, and that is asserted at its own layer rather than folded into
	// the deploy wait. An unclaimed job sits QUEUED until the wait's full deadline and is then
	// reported as a deploy TIMEOUT — naming the cluster when the fault is a tenancy mismatch
	// (#392) that was decidable in ninety seconds. Cheap half first.
	if cliDemo != nil {
		AssertCLIDemoJobClaimed(ctx, t, cp, cliDemo)
	}
	t.Cleanup(func() {
		killRunner()
		_ = cmd.Wait()
		if t.Failed() {
			t.Logf("──── runner process output ────\n%s", runnerOut.String())
		}
	})

	// ── Wait (bounded) for the job to go terminal, then assert on the REAL DB rows. ──
	// The DB block goes FIRST, before the runner output: the runner buffer is what the CI log
	// renderer truncates, and on the #1734 nightlies it cut off long before the actual error, so
	// triage meant downloading the t2-runner-log artifact. error_message + gitops_status say which
	// step died in the first few lines of the failure.
	status, err := cp.WaitTerminal(ctx, jobID, waitTimeout)
	if err != nil {
		t.Fatalf("waiting for job to finish: %v\n%s──── runner output ────\n%s",
			err, jobFailureDump(ctx, cp, jobID), runnerOut.String())
	}
	if status != "SUCCESS" {
		t.Fatalf("job terminal status = %q, want SUCCESS\n%s──── runner output ────\n%s",
			status, jobFailureDump(ctx, cp, jobID), runnerOut.String())
	}

	// TEARDOWN HYGIENE, AND IT MUST COME BEFORE EVERY ASSERTION BELOW.
	//
	// #3419 gave the destroy the working credential this process holds. It exports it inside
	// assertT2KubeconfigNodesReady — which is called at step (5), TEN fatal exits after the line
	// above. Each of those ten is a metadata, receipt or log-shipping assertion; not one of them
	// says anything about whether the cluster is reachable. Step (2) below in fact asserts
	// `cluster_ready`, so on reaching it the cluster is provably live and its ArgoCD
	// `Service: LoadBalancer` objects already exist.
	//
	// So a failure at, say, "shipped logs missing the claim banner" — a claim about rows in
	// Postgres — left the guaranteed teardown with no KUBECONFIG. RunDestroy then asked
	// ConfigureKubeconfig for one, got an exec plugin resolving to `e2e.test kube-token`, wrote it
	// OVER ~/.alethia/kubeconfig, skipped the load-balancer release, and `tofu destroy` died on the
	// subnets the surviving NLB still owned (#3395). The runs that need the credential most are
	// exactly the ones that never reached the line that sets it.
	//
	// BEST-EFFORT, AND ASSERTING NOTHING, deliberately. This is not the reachability proof — step
	// (5) still is, and still fails the test if no node is Ready. Exporting a kubeconfig that turns
	// out to be junk cannot make the teardown worse, and that is a property of #3416 rather than an
	// assumption: clusterReachable now requires the state to name an endpoint, requires
	// `kubectl get --raw /version` to answer, AND requires the kubeconfig's server to match that
	// endpoint. A file that fails any of the three is refused with a stated reason and the destroy
	// behaves exactly as it does today. Before #3416 an ambient KUBECONFIG was trusted on sight and
	// this would have been the wrong shape.
	exportT2KubeconfigForTeardown(t)

	_, metaRaw, err := cp.JobState(ctx, jobID)
	if err != nil {
		t.Fatalf("read job metadata: %v", err)
	}
	if len(metaRaw) == 0 {
		t.Fatal("job execution_metadata is empty — no status callback carried the post-apply result")
	}
	var meta struct {
		ClusterName   string          `json:"cluster_name"`
		ClusterReady  bool            `json:"cluster_ready"`
		VerifyReceipt json.RawMessage `json:"verify_receipt"`
		VerifyResult  json.RawMessage `json:"verify_result"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		t.Fatalf("decode execution_metadata: %v\nraw: %s", err, metaRaw)
	}

	// (1) ClusterName present + correct ⇒ the post-apply spine ran (it is gated on the
	//     per-provider cluster-name output) AND matches the unique cluster THIS run asked
	//     for. Each cloud names its cluster differently (Talos/ACK: `<project>-<env>`;
	//     EKS/GKE/AKS: `<kind>-<regionShort>-<env>-<project>`), so the check is
	//     provider-aware — see t2ValidateClusterName.
	if err := t2ValidateClusterName(provider, project, env, meta.ClusterName); err != nil {
		t.Fatalf("cluster_name assertion: %v", err)
	}
	// (2) cluster_ready ⇒ the reachability gate proved a live cluster, not just apply=0.
	if !meta.ClusterReady {
		t.Fatal("cluster_ready is not true — the reachability gate did not pass")
	}
	// (3) A signed evidence receipt, sealed to the real plan hash + verifying under pub.
	if len(meta.VerifyResult) == 0 {
		t.Fatal("verify_result is absent — the verification gate did not run on the plan JSON")
	}
	planSHA, err := VerifySignedReceipt(meta.VerifyReceipt, pub)
	if err != nil {
		t.Fatalf("signed receipt assertion: %v", err)
	}
	t.Logf("verified signed receipt sealed to plan sha256 %s", planSHA)

	// (4) The claim/callback/log-shipping paths reached the DB.
	logCount, logContent, err := cp.JobLogs(ctx, jobID)
	if err != nil {
		t.Fatalf("read job logs: %v", err)
	}
	if logCount == 0 {
		t.Fatal("no job_logs rows — the runner's log-shipping path did not reach the DB")
	}
	if !strings.Contains(logContent, "Job claimed") {
		t.Fatalf("shipped logs missing the claim banner — got %d lines:\n%s", logCount, t2Truncate(logContent, 2000))
	}
	t.Logf("%d log lines shipped to job_logs", logCount)

	// (5) INDEPENDENT reachability: the runner wrote a host-usable kubeconfig to
	//     $HOME/.alethia/kubeconfig (ConfigureKubeconfig). Read it and prove a node is
	//     Ready via a fresh kubectl — the workflow's capture-proof.sh reuses this same
	//     kubeconfig for the committed proof.
	kc := assertT2KubeconfigNodesReady(t, ctx)

	// (6) GitOps actually CONVERGED (BYOC A0.2): every ArgoCD Application the deploy
	//     is on record as having shipped — derived from the persisted infra_services +
	//     addon_status metadata, never hardcoded, never empty — must reach Healthy AND
	//     Synced on the real cluster. A degraded/missing app fails the nightly instead
	//     of sliding by as "installed".
	expectedApps, err := DeriveExpectedArgoApps(provider, metaRaw)
	if err != nil {
		t.Fatalf("derive expected ArgoCD apps: %v\nraw metadata: %s", err, metaRaw)
	}
	// The set is DERIVED from persisted metadata, which can silently shrink — see
	// RequireAllAddOnsExpected. Checked before it is used, so a full-surface run cannot assert
	// the floor and report the 18-chart sweep.
	if err := RequireAllAddOnsExpected(expectedApps); err != nil {
		t.Fatalf("full add-on surface: %v", err)
	}
	// Split the derived set AFTER the completeness guard above, never before: that guard's whole
	// job is to prove the set still covers the catalog, and handing it a pre-filtered set would
	// make it agree with a set that had already dropped the add-ons it exists to count.
	//
	// A withheld add-on is still installed and still observed — it is only not REQUIRED to
	// converge, because it cannot at catalog defaults (see addon_exclusions.go). The withheld set
	// is logged on every run, green ones included, so a passing verdict never hides its own scope.
	//
	// Split PER CLOUD, which is why `provider` is passed: since #3048 resolved each cloud's native
	// external-dns provider through the emitter, an add-on can be unable to converge on one cloud
	// and converge fine on another — external-dns was measured Healthy+Synced on hetzner and is
	// withheld only on aws/gcp/azure/alibaba.
	assertedApps, withheldApps := PartitionExcludedAddOns(provider, expectedApps)
	t.Logf("%s", DescribeWithheldAddOns(provider, withheldApps))
	t.Logf("asserting ArgoCD Applications reach Healthy+Synced: %v", assertedApps)

	if reposEnabled {
		// (7) ArgoCD-WITH-REPOS + BYO Helm CONVERGED (BYOC A0.6) — the #1 ask. The repo-apps
		//     "apps" app-of-apps and the repo-byo "addon-<id>" chart must be GENUINELY in the
		//     derived set (fail-closed, never hardcoded — a broken wiring yields an empty
		//     derivation and fails here), their credential Secrets must be present (proving the
		//     credential was seeded, without ever reading the token), and every expected app —
		//     including the hardened manual-sync BYO chart, synced over its CR — must reach
		//     Healthy+Synced.
		byoApp := repos.byoAppName()
		if e := t2AssertContains(expectedApps, "apps"); e != nil {
			t.Fatalf("A0.6 repo-apps: %v", e)
		}
		if e := t2AssertContains(expectedApps, byoApp); e != nil {
			t.Fatalf("A0.6 repo-byo: %v", e)
		}
		if e := assertRepoCredentialSecret(ctx, kc, "repo-apps"); e != nil {
			t.Fatalf("A0.6 repo-apps credential: %v", e)
		}
		if e := assertRepoCredentialSecret(ctx, kc, repos.byoSecretName()); e != nil {
			t.Fatalf("A0.6 repo-byo credential: %v", e)
		}
		// The BYO Application must carry an auto-sync policy BEFORE we wait on it (#2910). Asserted
		// first, and separately from convergence, because the two failures are worth telling apart:
		// a missing policy is a product regression that would otherwise surface only as a 19-minute
		// convergence timeout with no cause named.
		if e := assertByoAutoSyncPolicy(ctx, kc, byoApp); e != nil {
			t.Fatalf("A0.6 BYO chart sync policy: %v", e)
		}
		// NO manual-sync list. It used to be `[]string{byoApp}`, and that was the harness syncing a
		// BYO chart on the customer's behalf — the only sync of one anywhere in the codebase. It
		// MASKED #2910 for the whole life of the feature: production never synced these, so the
		// chart never deployed, and the e2e proved a path a customer does not have. The chart must
		// now converge unaided, which is what a customer actually gets.
		t.Logf("A0.6: repo-apps (apps) + repo-byo (%s) derived + credentialed; converging (BYO auto-syncs, unaided)...", byoApp)
		if e := AssertArgoReposConverge(ctx, kc, assertedApps, nil, ArgoAssertTimeout()); e != nil {
			t.Fatalf("A0.6 ArgoCD-with-repos convergence failed: %v", e)
		}
		// Not vacuous: both repo-sourced apps must MANAGE ≥1 resource — an empty repo/chart
		// renders nothing yet reports Healthy+Synced, which would prove a credentialed clone but
		// NOT that GitOps actually deployed a workload.
		if e := assertArgoAppManagesResources(ctx, kc, "apps"); e != nil {
			t.Fatalf("A0.6 repo-apps workload: %v", e)
		}
		if e := assertArgoAppManagesResources(ctx, kc, byoApp); e != nil {
			t.Fatalf("A0.6 repo-byo workload: %v", e)
		}
		t.Logf("A0.6: ArgoCD-with-repos proven — repo-apps + repo-byo Applications Healthy+Synced and managing real resources on real infra")
	} else if err := AssertArgoAppsHealthy(ctx, kc, assertedApps, ArgoAssertTimeout()); err != nil {
		t.Fatalf("ArgoCD application health assertion failed: %v", err)
	}
	if AllAddOnsEnabled() {
		assertMarketplaceExternalDnsIdentity(t, ctx, kc, provider, meta.ClusterName)
	}
	// The exclusions RATCHET. A withheld add-on that reached Healthy+Synced means the reason it was
	// withheld no longer holds, and leaving it on the list would make every later run assert less
	// than it could. One read, not a poll: staleness does not resolve by waiting.
	if err := AssertNoStaleAddOnExclusions(ctx, kc, provider, withheldApps); err != nil {
		t.Fatalf("stale add-on exclusion: %v", err)
	}
	t.Logf("all %d asserted ArgoCD Applications are Healthy+Synced (%d withheld)", len(assertedApps), len(withheldApps))

	// (7.6) MAX-CONFIG SURFACE (FT-5). When ALETHIA_E2E_MAX_CONFIG=1 the deploy seeded every kind this
	//       cloud offers; prove each one GENUINELY landed — the real-apply half of the max-config
	//       table. Per-kind and fail-closed, under the cell's own verdict: a tofu-carried kind must
	//       have its resource type in the deploy's state, an in-cluster kind must have its ArgoCD
	//       Application in the set just driven to Healthy+Synced (expectedApps), and a documented
	//       ceiling is recorded as an exclusion. There is no "unmapped" escape any more: a cloud with
	//       no column, or a cell with no verdict, is an ERROR — that hole is why hetzner and alibaba
	//       used to log a full-surface success line having asserted zero of their 11 kinds. A no-op
	//       unless max-config is enabled.
	if MaxConfigEnabled() {
		stateBytes := cp.StateSnapshot(jobID)
		proof, aerr := AssertMaxConfigKindsInState(stateBytes, provider, expectedApps)
		if aerr != nil {
			t.Fatalf("FT-5 max-config state assertion: %v", aerr)
		}
		if len(proof.Missing) > 0 {
			t.Fatalf("FT-5 max-config: %d kind(s) did NOT land on %s: %v", len(proof.Missing), provider, proof.Missing)
		}
		if len(proof.Excluded) > 0 {
			// Not a gap — a DOCUMENTED ceiling (MaxConfigCell.Why). Logged so the run reads as the
			// surface it actually proved, never as "all 11".
			t.Logf("FT-5 max-config: %d kind(s) are documented ceilings on %s (no service, no chart): %v",
				len(proof.Excluded), provider, proof.Excluded)
		}
		if len(proof.Deferred) > 0 {
			// DEBT, reported separately from the ceilings on purpose: a chart this repo ships backs
			// each of these and is simply not wired to the kind (MaxConfigCell.Chart names it). Folding
			// them into the ceiling line is how a backlog item stops being counted.
			t.Logf("FT-5 max-config: %d kind(s) are DEFERRED debt on %s (a shipped chart backs them; the mapping is missing): %v",
				len(proof.Deferred), provider, proof.Deferred)
		}
		// (7.6b) The SECOND assertion, for cells whose PRIMARY evidence does not itself prove
		//        delivery. `secrets` on hetzner forced it: a SEALED Vault's Helm release is Healthy
		//        AND Synced, so `addon-secrets-vault` going green is fully compatible with the Vault
		//        serving nothing.
		//
		//        It is no longer hetzner-only. `secrets` on the four MANAGED clouds is a tofu cell,
		//        and counting an `aws_secretsmanager_secret` in state proves the secret exists, not
		//        that anything can read it — a workload reads it only through the ESO
		//        ClusterSecretStore, whose apply failed on aws/full run 32883119943 behind a retry
		//        that swallowed the error (#2652). Every cloud now names the store whose readiness
		//        discriminates, so this is a no-op on no cloud that provisions `secrets`.
		if perr := AssertMaxConfigClusterProbes(ctx, kc, provider, MaxConfigProbeTimeout()); perr != nil {
			t.Fatalf("FT-5 max-config cluster probe: %v", perr)
		}
		t.Logf("FT-5 max-config on %s: %d kind(s) proven in tofu state %v, %d proven as converged ArgoCD Applications %v",
			provider, len(proof.ProvenInTofu), proof.ProvenInTofu, len(proof.ProvenInCluster), proof.ProvenInCluster)
	}

	// (7.5) CONSOLE → ACTIVE (BYOC A0.5). The runner reported SUCCESS via the SQL SSOT, but the Go
	//       control plane stops there — it never runs the console's terminal orchestration. Replay
	//       the REAL finalizeDeployment (the actual exported console action, via the tsx shim,
	//       against this same Postgres) and assert the env is ACTIVE with the persisted add-on health
	//       row it wrote from the runner's real execution_metadata. Warn-only unless
	//       ALETHIA_E2E_A05_ENFORCE; a no-op when A0.5 setup was disabled.
	runA05ConsoleActive(t, ctx, cp, a05, root, jobID)

	// (7.7) DAY-2 ACCESS surface (FULLY-TESTED P2-E). Opt-in via ALETHIA_E2E_DAY2_ACCESS — unset ⇒
	//       a clean skip. Proves the SURFACED day-2 access path works: cluster_endpoint is surfaced in
	//       the deploy metadata (what the console reads), the runner-written CLI-free kubeconfig
	//       AUTHENTICATES and is AUTHORIZED for a real action (`kubectl auth can-i '*' '*'`) — distinct
	//       from the soak's UNAUTHENTICATED /readyz liveness — over a real node read, and (AWS) the
	//       ArgoCD URL resolves. Reuses the same kc + metaRaw; runs BEFORE the guaranteed teardown.
	runT2Day2Access(t, ctx, kc, day2AccessParams{provider: provider, metaRaw: metaRaw})

	// (7.8) DAY-2 OFFER postures (#1495, driving the #1440 classifier). Opt-in via
	//       ALETHIA_E2E_DAY2_OFFER — unset ⇒ a clean skip. Where (7.7) proves the CLUSTER is
	//       reachable, this proves the OFFERS on it survive day-2: it plans a tunable change, a
	//       resize and a teardown against live state and asserts tofu's own plan converges in
	//       place (update/resize) and goes cleanly to zero (destroy). Runs BEFORE the guaranteed
	//       teardown so the plans see real state; nothing here applies anything.
	runT2Day2Offer(t, ctx, day2OfferParams{
		provider:     provider,
		cpURL:        cp.URL(),
		jobID:        jobID,
		templatesDir: stagedTemplate,
		snapshot:     full,
	})

	// (8) SOAK / day-2 window (BYOC A0.3). Opt-in via ALETHIA_E2E_SOAK — unset ⇒ a clean
	//     skip (everything above is the unchanged base T2 proof). Runs AFTER the readiness +
	//     ArgoCD asserts and BEFORE this function returns, so the GUARANTEED t.Cleanup
	//     teardown (registered earlier) still tears the cluster down afterwards. It drives
	//     the day-2 loops against the live cluster: a bounded liveness poll, a real
	//     DETECT_DRIFT job → honest in-sync posture over the deploy's real state, a 1Gi PVC
	//     → Bound → a cloud-side sweep-tag hard-fail on the backing volume, and an add-on
	//     health re-read.
	runT2Soak(t, ctx, cp, kc, soakParams{
		project:      project,
		env:          env,
		provider:     provider,
		region:       region,
		clusterName:  clusterName,
		deployJobID:  jobID,
		expectedApps: expectedApps,
		owner:        owner,
	})

	// (9) NAMESPACE-PLACEMENT scenario (#959). Opt-in via ALETHIA_E2E_NAMESPACE_TENANT — layers a
	//     SECOND DEPLOY onto the SAME cluster with placement_mode=namespace (cluster.cluster_name =
	//     this Fabric) and asserts the app landed in <ns> on that cluster: no new cluster, ArgoCD not
	//     reinstalled, hardened per-namespace isolation applied. EVERY cloud (#1389 wired them all;
	//     the product's own allowlist is the single control and fails an unwired cloud closed).
	//     Runs BEFORE the guaranteed teardown (registered earlier), reusing the still-running runner.
	runT2NamespaceTenant(t, ctx, cp, kc, namespaceTenantParams{
		project:     project,
		env:         env,
		provider:    provider,
		region:      region,
		fabricClust: meta.ClusterName,
		owner:       owner,
		appsRepo:    repos.appsRepo,
	})

	// (10) VCLUSTER-PLACEMENT scenario (#1308). Opt-in via ALETHIA_E2E_VCLUSTER — layers a SECOND DEPLOY
	//      onto the SAME cluster with placement_mode=vcluster (cluster.cluster_name = this Fabric) and
	//      asserts the virtual cluster was provisioned + registered with the host ArgoCD + the app
	//      delivered onto it by destination.name: no new cloud cluster, ArgoCD not reinstalled; then a
	//      DESTROY job deregisters it cleanly (no orphaned registration). EVERY cloud, same reasoning
	//      as #959. The e2e-vc-* env is disjoint from #959's e2e-ns-*, so the two never collide.
	//      Runs BEFORE the guaranteed teardown (registered earlier), reusing the still-running runner.
	runT2VClusterTenant(t, ctx, cp, kc, vclusterTenantParams{
		project:     project,
		env:         env,
		provider:    provider,
		region:      region,
		fabricClust: meta.ClusterName,
		owner:       owner,
		appsRepo:    repos.appsRepo,
	})

	// (10b) FABRIC ENTERPRISE-DEMO acceptance gate (#845). Opt-in via ALETHIA_E2E_FABRIC_DEMO —
	//       places dev+staging as namespace envs on THIS Fabric plus one vcluster tier, each
	//       syncing its OWN Kustomize overlay from the public enterprise-demo repo, and proves every
	//       placement genuinely CAUSED the artifacts it is credited with — the base deploy already
	//       populated this Fabric, so absent-before/present-after is the only honest evidence. It
	//       then re-proves the Fabric's drift posture and records a machine-readable verdict,
	//       carrying the Fabric's ALREADY-VERIFIED plan digest (a placement runs no tofu, so it has
	//       no receipt of its own). Runs BEFORE the guaranteed teardown, reusing the runner.
	runT2FabricDemo(t, ctx, cp, kc, fabricDemoParams{
		project:      project,
		env:          env,
		provider:     provider,
		region:       region,
		fabricClust:  meta.ClusterName,
		owner:        owner,
		baseAppsRepo: repos.appsRepo,
		deployJobID:  jobID,
		planSHA:      planSHA,
	})

	// (10c) BRING-YOUR-OWN IaC continuous proof (#1765, the cloud-tier half of #845's BYO bullet).
	//       Opt-in via ALETHIA_E2E_BYO_IAC. This is the ONE leg that runs code Alethia did not
	//       write, and it proves the whole custody chain around it rather than "an apply worked":
	//       a module in the same public repo at the same pinned commit but declaring a
	//       NON-allowlisted provider must be REFUSED (the gate has teeth), then the real customer
	//       module clones at that pinned sha, passes the fail-closed gate, yields a signed receipt
	//       over the CUSTOMER's own plan, applies, and lands its state on ALETHIA's proxy. It then
	//       induces a real change OUT OF BAND with the cloud's own CLI, requires the posture to
	//       FLIP to drifted on the probe resource, re-applies the same commit to HEAL, requires
	//       in-sync again, and destroys — leaving the state cleared. It uses neither the cluster
	//       nor the kubeconfig (a customer module emits no cluster_name, which is exactly what
	//       keeps the ArgoCD tail off); it needs only this control plane and this running runner.
	runT2ByoIac(t, ctx, cp, byoIacParams{
		project:    project,
		env:        env,
		provider:   provider,
		region:     region,
		owner:      owner,
		cpURL:      cp.URL(),
		receiptPub: pub,
	})

	// (11) CROSS-ACCOUNT KEYLESS SECRETS (#1268). Opt-in via ALETHIA_E2E_SECRETS_XACCT — the base
	//      DEPLOY already carried the *-xacct connector row and a secret-kind binding, so the runner
	//      rendered secretstore-<cloud>-xacct AND the ExternalSecret that reads through it. This
	//      layer proves the read actually crossed the account boundary (value compared by sha256),
	//      and that a placed tenant is still refused (#1306). aws-only today; other clouds record
	//      BLOCKED with a reason. Runs BEFORE the guaranteed teardown.
	if xacctOn {
		runT2SecretsXacct(t, ctx, kc, secretsXacctParams{cfg: xacct, metaRaw: metaRaw})
	}

	// (11b) ACM CERTIFICATE (#1773). Opt-in via ALETHIA_E2E_ACM_CERT. Asserts, in order: that NO
	//       hosted zone was created (the control that makes the rest mean anything — a certificate
	//       validated against a zone we made ourselves proves nothing about delegation), that
	//       aws_acm_certificate_validation completed, that the ARN reached execution_metadata, and
	//       that it gated the ArgoCD ingress. Runs BEFORE the guaranteed teardown.
	if acmCertOn {
		runT2AcmCert(t, ctx, cp, acmCertParams{cfg: acmCert, metaRaw: metaRaw, jobID: jobID})
	}

	// (12) KEYLESS DATABASE AUTH (#1511). Opt-in via ALETHIA_E2E_KEYLESS_DB — the base DEPLOY already
	//      carried an iam_auth database and a service bound to it, so the runner rendered the auth
	//      proxy sidecar, the workload-identity ServiceAccount and the bootstrap Job. This layer is
	//      the first time keyless is proven against a REAL database on any cloud: a password-free
	//      query, a session that outlives the cloud token, and an unscoped identity that is refused.
	//      Runs BEFORE the guaranteed teardown — and last, because its rotation dwell is the longest
	//      single wait in the suite.
	if keylessOn {
		runT2KeylessDB(t, ctx, kc, keylessDBParams{
			cfg:     keyless,
			dbName:  keyless.snapshotDBName(full),
			metaRaw: metaRaw,
		})
	}

	// (13) CROSS-ACCOUNT KEYLESS REGISTRY PULL (#1047). Opt-in via ALETHIA_E2E_XACCT_REGISTRY — the
	//      base DEPLOY already carried the *-xacct registry row (which activates the B4 tofu pull
	//      role) and a service whose image lives in that foreign registry, so the runner rendered the
	//      standalone registry-token refresher and attached its <slug>-pull Secret to the generated
	//      pods. This layer closes the last unproven link in epic #1046: the mint was proven with
	//      ambient laptop credentials, never in-cluster, and never consumed by a pod. Runs BEFORE the
	//      guaranteed teardown.
	if registryOn {
		runT2XacctRegistry(t, ctx, kc, xacctRegistryParams{cfg: registry, metaRaw: metaRaw})
	}

	// (14) THE CLI-DEMO READ-BACKS AND THE CLOSE (#3038). Everything above proved the cluster the
	//      CLI asked for is real; these beats prove the OPERATOR can see it and take it down through
	//      the binary — job logs, the cluster, the signed receipt, drift, cost, add-ons, destroy.
	//
	//      Last, and BEFORE the guaranteed teardown, for the same reason every layer above is: the
	//      registered t.Cleanup still tears the cluster down afterwards, so a beat that fails here
	//      cannot leave a standing bill. The destroy beat is the demo's own close; the spine's
	//      teardown is idempotent, so a cluster the CLI already destroyed costs a no-op.
	if cliDemo != nil {
		DriveCLIDemoPhase(ctx, t, cliDemo, CLIDemoConverged)
		DriveCLIDemoPhase(ctx, t, cliDemo, CLIDemoTeardown)
		t.Logf("cli-demo: all %d beats performed through the real binary — the CLI was the actor for the whole demo", len(CLIDemoBeats))
	}
}

// t2RunnerKubeconfigPath is where the runner's ConfigureKubeconfig writes the host-usable
// kubeconfig. One definition, because the teardown export and the reachability proof must not be
// able to disagree about which file they mean — the destroy overwriting THIS path is the whole
// defect #3419 was about.
func t2RunnerKubeconfigPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = os.TempDir()
	}
	return filepath.Join(home, ".alethia", "kubeconfig")
}

// exportT2KubeconfigForTeardown points the ambient KUBECONFIG at the runner-written kubeconfig as
// soon as the deploy reports SUCCESS, so the guaranteed teardown holds a credential no matter which
// later assertion fails. Returns the path it exported, or "" when there was nothing to export.
//
// It asserts NOTHING and never fails the test. The reachability proof is
// assertT2KubeconfigNodesReady's job and stays fatal; this is only about not entering teardown
// empty-handed. See the call site for why a junk kubeconfig cannot make the destroy worse.
func exportT2KubeconfigForTeardown(t *testing.T) string {
	t.Helper()
	kc := t2RunnerKubeconfigPath()
	if _, err := os.Stat(kc); err != nil {
		// Not a failure: the reachability assertion below is what decides whether the runner was
		// supposed to have written one. Logged rather than swallowed, because "the teardown ran
		// without a credential" must be readable in the run log afterwards.
		t.Logf("teardown credential: nothing to export — %s is not readable yet (%v)", kc, err)
		return ""
	}
	_ = os.Setenv("KUBECONFIG", kc)
	t.Logf("teardown credential: exported KUBECONFIG=%s before the post-deploy assertions", kc)
	return kc
}

// assertT2KubeconfigNodesReady reads the runner-written kubeconfig, asserts at least
// one Ready node via a fresh kubectl, and returns the kubeconfig path for follow-on
// assertions (the ArgoCD health check). (For a real cloud the kubeconfig is a Talos
// output the runner persisted, not a `kind` side-effect — so we read it from
// $HOME/.alethia/kubeconfig rather than shelling `kind get kubeconfig`.)
func assertT2KubeconfigNodesReady(t *testing.T, ctx context.Context) string {
	t.Helper()
	kc := t2RunnerKubeconfigPath()
	if _, err := os.Stat(kc); err != nil {
		t.Fatalf("runner kubeconfig not found at %s: %v", kc, err)
	}
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "get", "nodes", "--no-headers")
	cmd.Env = append(os.Environ(), "KUBECONFIG="+kc)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("kubectl get nodes via runner kubeconfig failed: %v\n%s", err, out)
	}
	if !HasReadyNode(string(out)) {
		t.Fatalf("no Ready node via the runner kubeconfig:\n%s", out)
	}
	t.Logf("kubectl get nodes:\n%s", out)

	// EXPORT IT. Everything in this file passes `--kubeconfig kc` explicitly, so the ambient
	// KUBECONFIG was never set — and `RunDestroy`, which the teardown calls IN THIS PROCESS, has no
	// parameter for one. Its load-balancer release therefore found no credential, asked
	// `provider.ConfigureKubeconfig` for one, and got a kubeconfig whose exec plugin is
	// `os.Args[0] kube-token` — which in a test process is `e2e.test` and exits 1. aws/addons run
	// 33277594471:
	//
	//	Skipping load-balancer release: a kubeconfig was written but the cluster does not answer with it.
	//
	// Worse, that write lands on THIS PATH — ConfigureKubeconfig writes ~/.alethia/kubeconfig — so
	// the destroy overwrote the very file this function just proved works.
	//
	// Setting the ambient variable is the honest fix and not a harness special case: this process
	// holds a working credential for the cluster it is about to tear down, and every operator would
	// have KUBECONFIG pointing at it. #3413 then finds the cluster reachable and does not
	// reconfigure anything. Explicit `--kubeconfig` flags elsewhere still win, so nothing else
	// changes.
	//
	// ⚠️ `os.Setenv`, NOT `t.Setenv`, and the reason is LIFO. `t.Setenv` registers its restore as a
	// cleanup AT THE POINT OF THE CALL, and cleanups run last-registered-first. The teardown that
	// needs this variable is registered at line 398 — BEFORE the deploy, deliberately, so it is
	// guaranteed to run — which is EARLIER than here. So `t.Setenv`'s restore would fire first and
	// unset KUBECONFIG moments before the destroy reads it: the fix would compile, pass every test,
	// and do nothing on the one path it exists for.
	//
	// There is no restore to lose. This process tests exactly one cluster and is about to destroy
	// it.
	//
	// Re-set rather than moved: exportT2KubeconfigForTeardown already did this the moment the
	// deploy reported SUCCESS, so on every path that reaches here this is a no-op writing the same
	// value. It stays because the early call is best-effort — if the runner had not yet written the
	// file then, this is where the export actually takes, and a reader arriving at the reachability
	// proof should not have to look elsewhere to learn that the ambient variable ends up set.
	_ = os.Setenv("KUBECONFIG", kc)
	return kc
}

// seedT2DeployJob enqueues a QUEUED DEPLOY job whose config_snapshot targets the REAL
// cloud template at a REAL region, with the seed add-ons enabled (they give the
// ArgoCD health assertion teeth — see seedAddOns in controlplane.go). The `provider`
// column is left NULL so the atomic claim's provider filter passes for the seeded
// runner; the runner reads the provider from the snapshot. Node sizing defaults to the
// template's cheapest cluster (1 control plane + 1 worker); ALETHIA_E2E_CLUSTER_JSON
// (merged into the `cluster` block via t2MergeClusterJSON) lets each cloud's workflow
// pin its own cheapest shape. When reposEnabled (BYOC A0.6), it also wires the
// apps-destination repo + appends the BYO chart add-on (repos.applyToSnapshot). Reuses the
// control plane's own pool (same package).
// t2BaseSnapshot builds the config_snapshot fields shared by the DEPLOY job and the soak's
// follow-on DETECT_DRIFT job (BYOC A0.3). Both MUST carry the SAME `id`/project/env/provider/
// region so their ProviderTfvars resolve identically — the drift's refresh-only plan
// reconciles the deploy's exact recorded state. The seed add-ons are included for fidelity
// (they are post-apply Helm, inert to a refresh-only plan).
func t2BaseSnapshot(project, env, provider, region string) map[string]any {
	return map[string]any{
		"id":                "e2e-" + env,
		"project_name":      project,
		"environment_stage": env,
		"region":            region,
		"provider":          provider,
		"addons":            seedAddOns(),
	}
}

// seedT2DeployJob enqueues a QUEUED DEPLOY job carrying the prebuilt runner-facing config_snapshot.
// When `g` is non-nil (BYOC A0.5), the job is LINKED to the seeded console graph (project_id /
// environment_id / org_id / user_id) so the replayed finalizeDeployment can drive that env to ACTIVE
// and write its health rows; when nil (A0.5 disabled), it falls back to the unlinked legacy seed
// (a random self-owned org, provisioning-only — the historical behavior). The `provider` column is
// left NULL so the atomic claim's provider filter passes for the seeded runner; the runner reads the
// provider from the snapshot.
// leanOwnerID is the user/org the job belongs to on the lean (g == nil) path; on the A0.5 path the
// job takes the graph's user/org. Either way it MUST equal the SeedRunner owner, or the self-runner
// claim (j.org_id = v_runner_org_id, #392) never matches and the job sits QUEUED until timeout.
func seedT2DeployJob(ctx context.Context, cp *ControlPlane, snap map[string]any, g *a05Graph, leanOwnerID string) (string, error) {
	jobID := newUUID()
	snapshot, err := json.Marshal(snap)
	if err != nil {
		return "", err
	}
	if g != nil {
		_, err = cp.pool.Exec(ctx, `
			INSERT INTO public.jobs
			  (id, user_id, org_id, project_id, environment_id, job_type, config_snapshot, status, provider)
			VALUES ($1, $2, $3, $4, $5, 'DEPLOY', $6::jsonb, 'QUEUED', NULL)`,
			jobID, g.userID, g.orgID, g.projectID, g.envID, string(snapshot))
	} else {
		_, err = cp.pool.Exec(ctx, `
			INSERT INTO public.jobs
			  (id, user_id, org_id, job_type, config_snapshot, status, provider)
			VALUES ($1, $2, $2, 'DEPLOY', $3::jsonb, 'QUEUED', NULL)`,
			jobID, leanOwnerID, string(snapshot))
	}
	if err != nil {
		return "", fmt.Errorf("seed job: %w", err)
	}
	return jobID, nil
}

// teardownT2Cluster destroys the provisioned cloud cluster via the REAL provisioner
// RunDestroy, reading state back from the control plane. It reconstructs the SAME
// ProjectConfig (project/env/region) the deploy used so ProviderTfvars resolves the
// same variables. GUARANTEED: the caller registers it before the deploy. There is no
// docker-rm fallback (that is a kind-only concept); the workflow's hcloud-cleanup.sh
// is the belt-and-suspenders for real cloud resources.
func teardownT2Cluster(ctx context.Context, cpURL, jobID, project, env, provider, region, templatesDir string, out io.Writer) error {
	vc := &types.ProjectConfig{
		ID:               "e2e-" + env,
		ProjectName:      project,
		EnvironmentStage: types.EnvironmentStage(env),
		Region:           region,
		// Reconstruct the SAME account/project/subscription the deploy resolved from ambient
		// env (the runner's resolveAmbientAccountID) so the destroy's ProviderTfvars resolve
		// identically — else GCP's project_id (and AWS account-scoped ARNs) are empty and the
		// teardown fails. Empty for account-less providers, matching the deploy.
		CloudAccountID: t2AmbientAccountID(provider),
	}
	backend := &cloud.HTTPBackendConfig{ConsoleURL: cpURL, JobID: jobID, Token: "e2e-teardown"}
	return provisioner.RunDestroy(ctx, provisioner.DestroyParams{
		ProjectConfig: vc,
		Provider:      provider,
		TemplatesDir:  templatesDir,
		StateBackend:  backend,
		Stdout:        out,
		Stderr:        out,
	})
}

// ─────────────────────────── T2-local helpers ───────────────────────────
// These mirror the T1 helpers but are redefined here (the t1 file is under a
// DIFFERENT build tag, so its symbols are not compiled with this file). They are
// prefixed `t2` to stay collision-free even under `-tags "e2e_t1 e2e_t2"`.

// t2RequireOrSkip enforces a prerequisite: a HARD FAIL under ALETHIA_E2E_T2_REQUIRE
// (the nightly sets it), a clean skip otherwise — so a broken environment never
// masquerades as a green skip in CI, and a dev laptop is not forced to have a token.
func t2RequireOrSkip(t *testing.T, cond bool, msg string) {
	t.Helper()
	if cond {
		return
	}
	if t2RequireIsHard() {
		t.Fatalf("T2 prerequisite missing (ALETHIA_E2E_T2_REQUIRE set): %s", msg)
	}
	t.Skipf("T2 prerequisite missing: %s", msg)
}

func t2HaveBin(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// t2RepoRoot resolves the repository root relative to THIS file (test/e2e/<file>).
func t2RepoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	rootDir, err := filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	return rootDir
}

// t2BuildRunner compiles the real runner binary from apps/runner/cmd/runner in
// workspace mode (the repo go.work), exactly like the `go` CI job resolves it.
func t2BuildRunner(t *testing.T, root, outBin string) {
	t.Helper()
	cctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(cctx, "go", "build", "-o", outBin, "./cmd/runner")
	cmd.Dir = filepath.Join(root, "apps", "runner")
	cmd.Env = append(os.Environ(), "GOWORK="+filepath.Join(root, "go.work"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build runner binary: %v\n%s", err, out)
	}
}

// t2CopyTree recursively copies a template directory (the cloud templates are flat
// today, but copy recursively so a future sub-module template still stages cleanly).
func t2CopyTree(t *testing.T, src, dst string) {
	t.Helper()
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Fatalf("read template dir: %v", err)
	}
	for _, e := range entries {
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())
		if e.IsDir() {
			t2CopyTree(t, s, d)
			continue
		}
		b, err := os.ReadFile(s)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(d, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func t2ShortHex(t *testing.T) string {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

func t2Truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…(truncated)"
}

// t2LogWriter pipes provisioner teardown output into the test log.
type t2LogWriter struct{ t *testing.T }

func (w t2LogWriter) Write(p []byte) (int, error) {
	w.t.Logf("%s", bytes.TrimRight(p, "\n"))
	return len(p), nil
}
