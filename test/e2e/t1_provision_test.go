// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

//go:build e2e_t1

// T1 — the hermetic provisioning keystone driven by the REAL runner BINARY.
//
// Build-tagged `e2e_t1` so it is OFF for bare `go test` and every-PR CI, and ON only
// in the merge-queue job (`ci.yml` → provision-e2e) where docker + kind + tofu +
// kubectl + helm and a Postgres service are all present:
//
//	cd test/e2e
//	go test -tags=e2e_t1 ./... -run TestT1RealRunnerKindProvisioning -v
//
// It extends the in-process T0 (packages/core/provisioner/deploy_e2e_test.go): here a
// separate runner PROCESS claims a QUEUED job from a real control plane over HTTP,
// runs the FULL RunDeployV2 spine against a genuine kind cluster, and reports back —
// so the claim / auth / status-callback / log-shipping paths are exercised too.
//
// # How each way this test could go VACUOUS is defeated
//
//   - kind never boots → the DEPLOY fails; the job reaches FAILED (not SUCCESS) and
//     the assertions fail. In the merge-queue job (ALETHIA_E2E_T1_REQUIRE=1) a missing
//     tool is a hard FAIL, never a skip — so the signal can't hollow out to a no-op.
//   - the runner never claims → WaitTerminal is a BOUNDED poll; it returns an error
//     (never blocks forever), failing the test loudly.
//   - "tofu apply exited 0" masquerading as a working cluster → we assert
//     cluster_name (spine not skipped) AND cluster_ready==true (WaitClusterReady +
//     WaitPodToAPIServer proved a reachable API + pod datapath), written to the DB by
//     the runner's real status callback.
//   - a nil/empty receipt → we require a signed receipt in the persisted metadata,
//     sealed to a 64-hex plan sha256, whose ed25519 signature VERIFIES under our pub.
//   - the run only proves in-process work → we assert a status callback reached
//     `jobs` (SUCCESS + metadata) AND log lines reached `job_logs`.
//   - ArgoCD merely INSTALLED but broken (an app stuck Progressing/Degraded/OutOfSync
//     used to pass this tier) → every expected Application must reach Healthy+Synced
//     via the independent kubeconfig, bounded by ALETHIA_E2E_ARGO_TIMEOUT. The
//     expected set is DERIVED from the persisted infra_services + addon_status
//     metadata, and an EMPTY derived set FAILS (never a vacuous assertion) — the
//     harness seeds a tiny add-on so it never is (see argocd_assert.go).
//   - a leaked cluster / cloud state → guaranteed teardown (RunDestroy + docker rm
//     fallback) registered BEFORE the deploy, and the runner process is killed.
package e2e

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// requireOrSkip enforces a prerequisite. In the merge-queue job (ALETHIA_E2E_T1_REQUIRE
// truthy) a missing prerequisite is a hard FAIL — a broken environment must never
// masquerade as a green skip. Elsewhere (a dev laptop) it skips cleanly.
func requireOrSkip(t *testing.T, cond bool, msg string) {
	t.Helper()
	if cond {
		return
	}
	if isTruthy(os.Getenv("ALETHIA_E2E_T1_REQUIRE")) {
		t.Fatalf("T1 prerequisite missing (ALETHIA_E2E_T1_REQUIRE set): %s", msg)
	}
	t.Skipf("T1 prerequisite missing: %s", msg)
}

func isTruthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func haveBin(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// repoRoot resolves the repository root relative to THIS file (test/e2e/<file>).
func repoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	root, err := filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	return root
}

func TestT1RealRunnerKindProvisioning(t *testing.T) {
	// Prerequisites: every tool the real spine shells out to, plus a Postgres URL.
	for _, bin := range []string{"docker", "tofu", "kubectl", "helm", "kind", "go"} {
		requireOrSkip(t, haveBin(bin), bin+" not on PATH")
	}
	requireOrSkip(t, dockerReachable(t), "docker daemon not reachable")
	dbURL := os.Getenv("ALETHIA_DATABASE_URL")
	requireOrSkip(t, dbURL != "", "ALETHIA_DATABASE_URL is unset (the migrated control-plane DB)")

	root := repoRoot(t)
	// 24m30s: up to waitTimeout (8m) for the deploy plus ArgoAssertTimeout for the ArgoCD
	// convergence assertion, with 4m of headroom for the runner build + kind boot.
	//
	// The argo term is 12m30s, not 8m. T1 is LEAN (ALETHIA_E2E_ALL_ADDONS unset), and #3580 stopped
	// the lean tier deriving its budget from zero add-on charts while converging three. The ctx has
	// to move with it: leaving it at 20m would have kept a 4m reserve on paper while really giving
	// the argo wait 1m30s less than its own budget, and a cold `go build` of the runner plus a kind
	// boot spends most of that reserve. The wait would then be cancelled short and the failure would
	// report as an ArgoCD convergence timeout rather than as a ctx nobody resized — a misattribution
	// that costs an investigation, not just a re-run.
	//
	// ci.yml's `-timeout 30m` on this test is the rung above and was raised in the same change.
	ctx, cancel := context.WithTimeout(context.Background(), 24*time.Minute+30*time.Second)
	defer cancel()

	// ── Build the REAL runner binary (this is what makes T1 more than T0). ──
	runnerBin := filepath.Join(t.TempDir(), "alethia-runner")
	buildRunner(t, root, runnerBin)

	// ── Stage the templates so the runner resolves the LOCAL kind module. The runner
	// computes its template dir as `<project-templates>/<provider>`; we drive the
	// local module as Provider="hetzner", so we place a copy of the local template at
	// `project-templates/hetzner` and run the runner with this dir as its CWD. No
	// production runner code is changed. ──
	stage := t.TempDir()
	localTemplateSrc := filepath.Join(root, "infra", "templates", "project", "local")
	stagedTemplate := filepath.Join(stage, "project-templates", "hetzner")
	copyDir(t, localTemplateSrc, stagedTemplate)

	// ── Receipt signing key: give the runner the private half, keep the public half
	// to VERIFY the sealed receipt it produces. ──
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519 key: %v", err)
	}

	// ── Real control plane over real Postgres. ──
	cp, err := NewControlPlane(ctx, dbURL)
	if err != nil {
		t.Fatalf("control plane: %v", err)
	}
	// One owner owns both the runner and the job: claim_next_job's self-runner branch scopes to
	// `j.org_id = v_runner_org_id` (#392), so a runner in a different org never claims the job.
	owner := newUUID()
	runnerID, runnerToken, err := cp.SeedRunner(ctx, owner, owner)
	if err != nil {
		t.Fatalf("seed runner: %v", err)
	}
	cp.Start()
	// LIFO cleanups: Close registered FIRST so it runs LAST — after teardown, which
	// reads state over HTTP from this same server.
	t.Cleanup(cp.Close)

	project := "alethia"
	env := "e2t1" + shortHex(t)
	clusterName := project + "-" + env

	jobID, err := cp.SeedDeployJob(ctx, project, env, owner)
	if err != nil {
		t.Fatalf("seed job: %v", err)
	}
	t.Logf("seeded QUEUED DEPLOY job %s targeting local kind template (cluster %s)", jobID, clusterName)

	// GUARANTEED teardown — registered BEFORE launching the runner so a mid-deploy
	// failure still tears the cluster down. Runs before cp.Close (LIFO).
	t.Cleanup(func() {
		dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer dcancel()
		if derr := TeardownCluster(dctx, cp.URL(), jobID, project, env, stagedTemplate, clusterName, testLogWriter{t}); derr != nil {
			t.Logf("teardown RunDestroy failed (docker rm fallback attempted): %v", derr)
		} else {
			t.Log("teardown: cluster destroyed")
		}
	})

	// ── Launch the REAL runner process pointed at the control plane. ──
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
		"ALETHIA_CLUSTER_READY_TIMEOUT="+clusterReadyTimeout(),
		"ALETHIA_ARGOCD_TEMPLATES_DIR="+filepath.Join(root, "infra", "templates", "argocd"),
	)
	var runnerSink io.Writer = &runnerOut
	if p := os.Getenv("ALETHIA_E2E_T1_RUNNER_LOG"); p != "" {
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
	t.Cleanup(func() {
		killRunner()
		_ = cmd.Wait()
		if t.Failed() {
			t.Logf("──── runner process output ────\n%s", runnerOut.String())
		}
	})

	// ── Wait (bounded) for the job to go terminal, then assert on the REAL DB rows. ──
	status, err := cp.WaitTerminal(ctx, jobID, waitTimeout())
	if err != nil {
		t.Fatalf("waiting for job to finish: %v\n──── runner output ────\n%s", err, runnerOut.String())
	}
	if status != "SUCCESS" {
		t.Fatalf("job terminal status = %q, want SUCCESS\n──── runner output ────\n%s", status, runnerOut.String())
	}

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

	// (1) ClusterName present + correct ⇒ ExtractClusterName found talos_cluster_name
	//     and the post-apply spine was NOT skipped (the whole block is gated on it).
	if meta.ClusterName == "" {
		t.Fatal("cluster_name is empty in metadata — the post-apply spine was SKIPPED")
	}
	if meta.ClusterName != clusterName {
		t.Fatalf("cluster_name = %q, want %q", meta.ClusterName, clusterName)
	}
	// (2) cluster_ready ⇒ WaitClusterReady + WaitPodToAPIServer proved a reachable
	//     cluster (API answered, a node reached Ready, a pod reached the apiserver) —
	//     not merely that `tofu apply` exited 0.
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

	// (4) The claim/callback/log-shipping paths reached the DB: log lines exist and
	//     carry the runner's activity (proof the real HTTP log path ran, not in-proc).
	logCount, logContent, err := cp.JobLogs(ctx, jobID)
	if err != nil {
		t.Fatalf("read job logs: %v", err)
	}
	if logCount == 0 {
		t.Fatal("no job_logs rows — the runner's log-shipping path did not reach the DB")
	}
	if !strings.Contains(logContent, "Job claimed") {
		t.Fatalf("shipped logs missing the claim banner — got %d lines:\n%s", logCount, truncate(logContent, 2000))
	}
	t.Logf("%d log lines shipped to job_logs", logCount)

	// (5) INDEPENDENT reachability: fetch a host-usable kubeconfig via `kind` (not the
	//     runner's side-effect, not the scrubbed DB metadata) and prove a node is Ready.
	kc := assertKubeconfigNodesReady(t, ctx, clusterName)

	// (6) GitOps actually CONVERGED (BYOC A0.2): every ArgoCD Application the deploy is
	//     on record as having shipped — derived from the persisted infra_services +
	//     addon_status metadata, never hardcoded, never empty — must reach Healthy AND
	//     Synced over the same independent kubeconfig. A degraded/missing app fails
	//     the tier instead of sliding by as "installed".
	// T1 drives the LOCAL kind module as Provider="hetzner" (see the template staging
	// above), so it takes the INSTALLING branch of the metrics-server gate — kind, like
	// Talos, ships no metrics-server. Unchanged behaviour from before #1722.
	expectedApps, err := DeriveExpectedArgoApps("hetzner", metaRaw)
	if err != nil {
		t.Fatalf("derive expected ArgoCD apps: %v\nraw metadata: %s", err, metaRaw)
	}
	t.Logf("asserting ArgoCD Applications reach Healthy+Synced: %v", expectedApps)
	if err := AssertArgoAppsHealthy(ctx, kc, expectedApps, ArgoAssertTimeout()); err != nil {
		t.Fatalf("ArgoCD application health assertion failed: %v", err)
	}
	t.Logf("all %d expected ArgoCD Applications are Healthy+Synced", len(expectedApps))
}

// assertKubeconfigNodesReady fetches the kind cluster's kubeconfig independently,
// asserts `kubectl get nodes` reports at least one Ready node, and returns the path
// of the written kubeconfig for follow-on assertions (the ArgoCD health check).
func assertKubeconfigNodesReady(t *testing.T, ctx context.Context, clusterName string) string {
	t.Helper()
	kubeconfig, err := KindKubeconfig(ctx, clusterName)
	if err != nil {
		t.Fatalf("fetch independent kubeconfig: %v", err)
	}
	kc := filepath.Join(t.TempDir(), "kubeconfig")
	if err := os.WriteFile(kc, kubeconfig, 0o600); err != nil {
		t.Fatal(err)
	}
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "get", "nodes", "--no-headers")
	cmd.Env = append(os.Environ(), "KUBECONFIG="+kc)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("kubectl get nodes via independent kubeconfig failed: %v\n%s", err, out)
	}
	if !HasReadyNode(string(out)) {
		t.Fatalf("no Ready node via the independent kubeconfig:\n%s", out)
	}
	t.Logf("independent kubectl get nodes:\n%s", out)
	return kc
}

// buildRunner compiles the real runner binary from apps/runner/cmd/runner.
func buildRunner(t *testing.T, root, outBin string) {
	t.Helper()
	cctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(cctx, "go", "build", "-o", outBin, "./cmd/runner")
	cmd.Dir = filepath.Join(root, "apps", "runner")
	// Build in WORKSPACE mode (the repo go.work), exactly like the `go` CI job resolves
	// apps/runner + packages/core. Our own test process runs with GOWORK=off (the e2e
	// module is not in the workspace), so point the child explicitly at the go.work.
	cmd.Env = append(os.Environ(), "GOWORK="+filepath.Join(root, "go.work"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build runner binary: %v\n%s", err, out)
	}
}

// copyDir copies the regular files of a flat template dir (the local module is flat).
func copyDir(t *testing.T, src, dst string) {
	t.Helper()
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Fatalf("read template dir: %v", err)
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, e.Name()), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func dockerReachable(t *testing.T) bool {
	t.Helper()
	cctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return exec.CommandContext(cctx, "docker", "info").Run() == nil
}

// clusterReadyTimeout is the runner's WaitClusterReady gate timeout — kind is slower
// than the in-process T0, so 3m by default (overridable for slow CI).
func clusterReadyTimeout() string {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_CLUSTER_READY_TIMEOUT")); v != "" {
		return v
	}
	return "3m"
}

// waitTimeout bounds how long the test waits for the job to finish (build the kind
// image pull + apply + spine + argo). Generous but finite.
func waitTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_E2E_T1_WAIT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return 8 * time.Minute
}

func shortHex(t *testing.T) string {
	t.Helper()
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(b)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…(truncated)"
}

// testLogWriter pipes provisioner teardown output into the test log.
type testLogWriter struct{ t *testing.T }

func (w testLogWriter) Write(p []byte) (int, error) {
	w.t.Logf("%s", bytes.TrimRight(p, "\n"))
	return len(p), nil
}
