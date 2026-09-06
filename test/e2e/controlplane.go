// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package e2e hosts the T1 hermetic provisioning keystone — the merge-queue-gated
// end-to-end proof that the FULL provisioning spine works against a REAL kind
// cluster driven by the REAL runner BINARY claiming from a REAL control plane.
//
// This file is the test-INFRASTRUCTURE half (a real control plane over real
// Postgres, plus receipt/teardown/kubeconfig helpers). It is deliberately UNTAGGED
// so `go mod tidy` sees every dependency (pgx + packages/core), keeping go.sum
// complete for the build-tagged test in t1_provision_test.go. Nothing here imports
// `testing`; the tagged test drives it and owns all assertions.
//
// # Why a Go control plane (and not the Next.js console)
//
// The runner speaks HTTP to `${ALETHIA_WEB_ORIGIN}/api/...`. The console's runner
// API is TypeScript/Next.js and can't run in a Go test, so this is a thin HTTP
// adapter that executes the SAME authoritative SQL the console does — the real
// `claim_next_job`, `update_job_status`, and `insert_job_log` functions against the
// real migrated Postgres (`programmables.sql`). The claim/auth/status-callback/
// log-shipping paths are therefore genuinely exercised (that's T1's whole point
// over the in-process T0): a status callback lands in `jobs`, logs land in
// `job_logs`, and the atomic claim runs the real RPC. The OpenTofu http state
// backend is served in-memory (state persistence is not what T1 proves) so the run
// stays hermetic — no SeaweedFS, no object store.
package e2e

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ControlPlane is a minimal, Postgres-backed stand-in for the console's runner API.
// It serves exactly the endpoints the local-kind DEPLOY path hits and executes the
// real SQL SSOT for the claim + status + log writes.
type ControlPlane struct {
	pool   *pgxpool.Pool
	server *httptest.Server

	// The single seeded runner's credentials (X-Runner-ID / X-Runner-Token).
	runnerID    string
	runnerToken string

	// Add-on secret values this control plane OWNS, addon id → key → plaintext (#2835). Minted on
	// first fetch and held for the process lifetime: a value that changed between two fetches would
	// reintroduce exactly the per-reconcile rotation #2822 is about.
	addonSecretsMu sync.Mutex
	addonSecrets   map[string]map[string]string

	// In-memory OpenTofu http state backend, keyed by a STORAGE KEY (state + lock).
	// The key is the requesting job's id by default, but a job may be ALIASED onto
	// another job's slot (AliasStateToJob) so a follow-on job — a DETECT_DRIFT after a
	// DEPLOY — reads the SAME state the deploy wrote, mirroring the console's
	// per-environment (not per-job) state key. stateReadNonEmpty counts, per requesting
	// job id, GETs that returned a NON-EMPTY state (drift non-vacuity proof).
	mu                sync.Mutex
	states            map[string]*stateEntry
	stateAlias        map[string]string
	stateReadNonEmpty map[string]int
	// stateClearedBy records HOW a storage key's state last became empty — "delete" (tofu issued
	// an HTTP DELETE) or "empty-write" (it POSTed a zero-length body). A non-empty write clears
	// the record, so this always describes the CURRENT emptiness rather than a historical one.
	//
	// It exists because `StateSnapshot` returns raw bytes, so "cleared by destroy" and "never
	// written" are the same observation — and those mean opposite things about whether live
	// infrastructure was orphaned. See the byo-iac state-cleared assertion.
	stateClearedBy map[string]string
}

type stateEntry struct {
	state  []byte
	locked bool
}

// NewControlPlane connects to Postgres (the migrated CI/dev database) and returns a
// control plane ready to Seed + Start. Connect as the superuser role (RLS-exempt);
// the SECURITY DEFINER functions enforce their own runner/ownership checks.
func NewControlPlane(ctx context.Context, dbURL string) (*ControlPlane, error) {
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return &ControlPlane{
		pool:              pool,
		states:            map[string]*stateEntry{},
		stateAlias:        map[string]string{},
		stateReadNonEmpty: map[string]int{},
		stateClearedBy:    map[string]string{},
	}, nil
}

// Start brings up the HTTP server on a random loopback port. Its URL is what the
// runner (and the tofu child it spawns) point at via ALETHIA_WEB_ORIGIN.
func (cp *ControlPlane) Start() {
	cp.server = httptest.NewServer(cp.mux())
}

// URL is the control-plane origin (no /api suffix), for ALETHIA_WEB_ORIGIN.
func (cp *ControlPlane) URL() string { return cp.server.URL }

// Close tears down the HTTP server and the DB pool. Call AFTER any teardown that
// reads state over HTTP (RunDestroy), since it needs the server alive.
func (cp *ControlPlane) Close() {
	if cp.server != nil {
		cp.server.Close()
	}
	if cp.pool != nil {
		cp.pool.Close()
	}
}

// ─────────────────────────── seeding (fleet-queue) ───────────────────────────

// SeedRunner inserts a self-operated runner (operator=self ⇒ the simple, uncapped
// claim path AND a Passthrough sandbox ⇒ the deploy runs in-process, no container).
// Returns its id + bearer token; stores them for the handlers' auth.
//
// The owner (ownerUserID / ownerOrgID) MUST match the org of the DEPLOY job it will claim:
// claim_next_job's self-runner branch scopes to `j.org_id = v_runner_org_id` (audit P0, #392),
// so a runner seeded in a different org than the job silently never claims it and the job sits
// QUEUED until timeout. The caller passes the job's owner (the A0.5 graph's user/org, or a shared
// owner it also gives the job) so the realistic "one owner owns the project + runner + job" shape
// is seeded, not three disconnected orgs.
func (cp *ControlPlane) SeedRunner(ctx context.Context, ownerUserID, ownerOrgID string) (id, token string, err error) {
	id = newUUID()
	token, err = newToken()
	if err != nil {
		return "", "", err
	}
	tokenHash := sha256Hex(token)
	// operator=self requires user_id NOT NULL (runners_operator_owner_ck) and
	// provisioning set (runners_provisioning_ck). supported_providers NULL ⇒ claims
	// any provider. status ONLINE + a fresh heartbeat so it is a live claimer.
	_, err = cp.pool.Exec(ctx, `
		INSERT INTO public.runners
		  (id, user_id, org_id, name, operator, provisioning, supported_providers,
		   token_hash, status, last_heartbeat)
		VALUES ($1, $2, $3, 't1-e2e-runner', 'self', 'registered', NULL,
		        $4, 'ONLINE', now())`,
		id, ownerUserID, ownerOrgID, tokenHash)
	if err != nil {
		return "", "", fmt.Errorf("seed runner: %w", err)
	}
	cp.runnerID, cp.runnerToken = id, token
	return id, token, nil
}

// seedAddOns returns the tiny managed marketplace add-on every provisioning tier
// seeds into its DEPLOY config snapshot (ProjectConfig.AddOns, json "addons" — the
// exact camelCase shape the console's resolveAddOnInstall emits). It is the TEETH
// of the ArgoCD health assertion: on the lean kind/hetzner paths every infra-service
// decision that ships an Application is honestly "skipped", so without it the
// derived expected set would be empty and DeriveExpectedArgoApps would (rightly)
// refuse the vacuous assertion. reloader is the lightest catalog chart (one small
// deployment, no CRD storms, no cloud dependencies), pinned to the same version as
// apps/console/lib/addons/catalog.ts, and PROVEN to converge Healthy+Synced on a
// 1-node kind cluster end-to-end. (sealed-secrets was the intended second seed, but
// the assertion's first real run caught its catalog chartRepo returning 404 —
// bitnami-labs.github.io/sealed-secrets is dead upstream, so that add-on can never
// sync anywhere; catalog fix tracked separately. Seed only charts whose repos are
// proven alive, or the tier reds on upstream rot rather than on our spine.)
// (sealed-secrets' dead chartRepo is FIXED — bitnami-labs.github.io → bitnami.github.io, PR #500 —
// so the "seed only charts whose repos are proven alive" caveat above no longer excludes it; the
// full surface below now carries it, and catalog-export.test.ts guards the whole set against that
// class of rot.)
//
// FULL SURFACE: with ALETHIA_E2E_ALL_ADDONS=1 every tier seeds ALL 18 catalog add-ons instead of the
// lean single seed — the maintainer's FULLY-TESTED bar ("every single add-on we have available").
// The set is loaded from the generated fixture (SSOT = catalog.ts; see addon_surface.go), and a
// stale/short fixture is a hard FAIL, never a silent fallback to a smaller set — a full-surface run
// that quietly installed one add-on and reported green is exactly the vacuous proof the bar exists
// to prevent.
//
// BOTH tiers now read that ONE generated artifact. The lean seed used to be a hand-written literal
// beside it, and the two drifted the moment they could: #643 (2026-07-16) gave reloader real knob
// defaults, regenerated catalog.ts + addon_catalog.<cloud>.json + t2_config_snapshot.hetzner.json, and left
// this literal emitting `Values: map[string]interface{}{}` — contradicting the promise three lines
// up that this is "the exact camelCase shape the console's resolveAddOnInstall emits". Deriving both
// tiers from the same SSOT makes that unrepresentable instead of merely detectable (#1965).
// leanSeedAddOnIDs are the catalog add-ons every tier seeds, full surface or not. ONE list, read by
// seedAddOns below AND by argoAddOnCount (argocd_assert.go), because the wait budget has to be
// sized against the charts the run actually converges: a second hand-written copy is how the budget
// and the surface come to disagree, which is #3580 in miniature.
var leanSeedAddOnIDs = []string{"reloader"}

func seedAddOns() []types.AddOnInstall {
	reloader, err := CatalogAddOn(leanSeedAddOnIDs[0])
	if err != nil {
		// Fail loudly, exactly as the full surface does. A zero-valued lean seed would strip the
		// ArgoCD health assertion of its teeth and let the tier report green having installed nothing.
		panic(fmt.Sprintf("lean add-on seed unavailable: %v", err))
	}
	addons, err := SeedAddOnsForSurface([]types.AddOnInstall{reloader})
	if err != nil {
		// Fail loudly: the caller asked for the full surface and we cannot honour it.
		panic(fmt.Sprintf("full add-on surface requested but unavailable: %v", err))
	}
	return addons
}

// SeedDeployJob enqueues a QUEUED DEPLOY job whose config_snapshot targets the local
// kind template (driven as Provider="hetzner") with the seed add-ons enabled (they
// give the ArgoCD health assertion teeth — see seedAddOns). provider column is left
// NULL so the claim's provider filter passes for any runner; the runner reads the
// provider from the snapshot. Returns the job id.
// ownerID is the user/org the job belongs to. It MUST equal the SeedRunner owner, or the
// self-runner claim (j.org_id = v_runner_org_id, #392) never matches and the job sits QUEUED.
func (cp *ControlPlane) SeedDeployJob(ctx context.Context, project, env, ownerID string) (jobID string, err error) {
	jobID = newUUID()
	userID := ownerID
	snapshot, err := json.Marshal(map[string]any{
		"id":                "e2e-" + env,
		"project_name":      project,
		"environment_stage": env,
		"region":            "local",
		"provider":          "hetzner", // reuse the Talos post-apply path (talos_* outputs)
		"addons":            seedAddOns(),
	})
	if err != nil {
		return "", err
	}
	_, err = cp.pool.Exec(ctx, `
		INSERT INTO public.jobs
		  (id, user_id, org_id, job_type, config_snapshot, status, provider)
		VALUES ($1, $2, $2, 'DEPLOY', $3::jsonb, 'QUEUED', NULL)`,
		jobID, userID, string(snapshot))
	if err != nil {
		return "", fmt.Errorf("seed job: %w", err)
	}
	return jobID, nil
}

// ─────────────────────────── DB assertions surface ───────────────────────────

// JobState returns the job's current status and execution_metadata (raw JSON, may be
// nil). Reads the REAL row the runner's status callbacks wrote.
func (cp *ControlPlane) JobState(ctx context.Context, jobID string) (status string, meta []byte, err error) {
	var metaRaw []byte
	err = cp.pool.QueryRow(ctx,
		`SELECT status::text, execution_metadata FROM public.jobs WHERE id = $1`, jobID).
		Scan(&status, &metaRaw)
	return status, metaRaw, err
}

// JobFailureDetail returns a job's error_message and execution_metadata — the two columns a
// terminal-failure report needs. Kept separate from JobState (which three call sites share)
// because only the failure path wants error_message; widening JobState would churn all of them.
func (cp *ControlPlane) JobFailureDetail(ctx context.Context, jobID string) (errMsg string, meta []byte, err error) {
	var msg *string
	var metaRaw []byte
	err = cp.pool.QueryRow(ctx,
		`SELECT error_message, execution_metadata FROM public.jobs WHERE id = $1`, jobID).
		Scan(&msg, &metaRaw)
	if msg != nil {
		errMsg = *msg
	}
	return errMsg, metaRaw, err
}

// WaitTerminal polls the job row until it reaches a terminal status (SUCCESS/FAILED/
// CANCELLED) or the deadline elapses — a BOUNDED wait so a runner that never claims,
// or a spine that hangs, fails loudly instead of blocking forever.
func (cp *ControlPlane) WaitTerminal(ctx context.Context, jobID string, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	for {
		status, _, err := cp.JobState(ctx, jobID)
		if err != nil {
			return "", err
		}
		switch status {
		case "SUCCESS", "FAILED", "CANCELLED":
			return status, nil
		}
		if time.Now().After(deadline) {
			return status, fmt.Errorf("job %s did not reach a terminal status within %s (last status %q)", jobID, timeout, status)
		}
		select {
		case <-ctx.Done():
			return status, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// JobLogs returns the count of shipped log lines and their concatenated content —
// proof the runner's log-shipping path (SendLog → insert_job_log) reached the DB.
func (cp *ControlPlane) JobLogs(ctx context.Context, jobID string) (count int, content string, err error) {
	rows, err := cp.pool.Query(ctx,
		`SELECT log_chunk FROM public.job_logs WHERE job_id = $1 ORDER BY id`, jobID)
	if err != nil {
		return 0, "", err
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var chunk string
		if err := rows.Scan(&chunk); err != nil {
			return 0, "", err
		}
		b.WriteString(chunk)
		count++
	}
	return count, b.String(), rows.Err()
}

// ─────────────────────────── HTTP handlers ───────────────────────────

func (cp *ControlPlane) mux() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("POST /api/jobs/claim", cp.handleClaim)
	m.HandleFunc("PUT /api/jobs/{id}/status", cp.handleStatus)
	m.HandleFunc("POST /api/jobs/{id}/logs", cp.handleLogs)
	m.HandleFunc("POST /api/jobs/{id}/state-token", cp.handleStateToken)
	m.HandleFunc("POST /api/jobs/{id}/git-token", cp.handleGitToken)
	m.HandleFunc("POST /api/jobs/{id}/addon-secrets", cp.handleAddonSecrets)
	m.HandleFunc("POST /api/runners/heartbeat", cp.handleHeartbeat)
	m.HandleFunc("GET /api/runners/wake", cp.handleWake)
	// OpenTofu http state backend (in-memory). Lock is a distinct sub-path.
	m.HandleFunc("/api/jobs/{id}/state/lock", cp.handleStateLock)
	m.HandleFunc("/api/jobs/{id}/state", cp.handleState)
	return m
}

// authHash validates the runner headers and returns the token hash to pass to the
// SQL functions (they re-check id+hash). Empty string + false ⇒ unauthorized.
func (cp *ControlPlane) authHash(r *http.Request) (runnerID, tokenHash string, ok bool) {
	id := r.Header.Get("X-Runner-ID")
	tok := r.Header.Get("X-Runner-Token")
	if id == "" || tok == "" {
		return "", "", false
	}
	return id, sha256Hex(tok), true
}

func (cp *ControlPlane) handleClaim(w http.ResponseWriter, r *http.Request) {
	runnerID, tokenHash, ok := cp.authHash(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// The real atomic claim RPC (FOR UPDATE SKIP LOCKED + eligibility).
	var jobID string
	err := cp.pool.QueryRow(r.Context(),
		`SELECT id FROM public.claim_next_job($1::uuid, $2, NULL::uuid)`, runnerID, tokenHash).
		Scan(&jobID)
	if errors.Is(err, pgx.ErrNoRows) {
		// Genuinely no claimable job ⇒ empty response (the runner polls again).
		writeJSON(w, http.StatusOK, map[string]any{"job": nil})
		return
	}
	if err != nil {
		// A real claim_next_job failure — surface it as a 500 rather than masquerading as
		// "no job", which would only ever manifest as an opaque WaitTerminal timeout and hide
		// exactly the claim regression this E2E exists to catch.
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jobJSON, err := cp.claimedJobJSON(r.Context(), jobID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"job":                   jobJSON,
		"cloud_identity":        nil,
		"connector_credentials": []any{},
	})
}

// claimedJobJSON builds the claim response's `job` object with RFC3339 timestamps
// (the runner cannot decode Postgres timestamp text — the console re-reads via
// Drizzle for the same reason). Only the fields the DEPLOY path reads are populated.
func (cp *ControlPlane) claimedJobJSON(ctx context.Context, jobID string) (map[string]any, error) {
	var (
		id, userID, jobType, status string
		cloudIdentityID, planJobID  *string
		configurationHash           *string
		configSnapshot              []byte
		verifyOverride              []byte
		createdAt, updatedAt        time.Time
	)
	// Select only long-stable columns the DEPLOY path reads — never the newest
	// additions (e.g. `traceparent`), so the harness tolerates a control-plane DB a
	// migration or two behind HEAD (CI migrates to HEAD; a dev box may lag). The
	// runner treats a missing traceparent as "no trace" — not needed for T1's proof.
	err := cp.pool.QueryRow(ctx, `
		SELECT id::text, user_id::text, job_type::text, status::text,
		       cloud_identity_id::text, plan_job_id::text, configuration_hash,
		       config_snapshot, verify_override, created_at, updated_at
		FROM public.jobs WHERE id = $1`, jobID).
		Scan(&id, &userID, &jobType, &status, &cloudIdentityID, &planJobID,
			&configurationHash, &configSnapshot, &verifyOverride,
			&createdAt, &updatedAt)
	if err != nil {
		return nil, fmt.Errorf("read claimed job: %w", err)
	}
	job := map[string]any{
		"id":                 id,
		"user_id":            userID,
		"job_type":           jobType,
		"status":             status,
		"cloud_identity_id":  cloudIdentityID,
		"plan_job_id":        planJobID,
		"configuration_hash": configurationHash,
		"config_snapshot":    json.RawMessage(configSnapshot),
		"traceparent":        "",
		"created_at":         createdAt.UTC().Format(time.RFC3339Nano),
		"updated_at":         updatedAt.UTC().Format(time.RFC3339Nano),
	}
	if len(verifyOverride) > 0 {
		job["verify_override"] = json.RawMessage(verifyOverride)
	}
	return job, nil
}

// handleStatus mirrors the SQL SSOT half of the real console status route: it runs the
// authoritative update_job_status RPC and returns {success}. FIDELITY BOUNDARY (deliberate): the
// real apps/console/app/api/jobs/[id]/status/route.ts layers a large TS orchestration on top of the
// same RPC — finalizeDeployment (env→ACTIVE), the env-status CAS, promotions, alerts, and usage
// billing. NONE of that is exercised here. So a green T1 proves the runner→SQL contract + the
// provisioning spine, NOT that the console marks the env ACTIVE or bills the job; those side-effects
// are covered by the console integration tests, not this harness.
func (cp *ControlPlane) handleStatus(w http.ResponseWriter, r *http.Request) {
	runnerID, tokenHash, ok := cp.authHash(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	jobID := r.PathValue("id")
	var body struct {
		Status            string          `json:"status"`
		ErrorMessage      string          `json:"error_message"`
		ExecutionMetadata json.RawMessage `json:"execution_metadata"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var errMsg *string
	if body.ErrorMessage != "" {
		errMsg = &body.ErrorMessage
	}
	var meta *string
	if len(body.ExecutionMetadata) > 0 && string(body.ExecutionMetadata) != "null" {
		s := string(body.ExecutionMetadata)
		meta = &s
	}
	// The real terminal-guarded status write (update_job_status).
	if _, err := cp.pool.Exec(r.Context(),
		`SELECT public.update_job_status($1::uuid, $2, $3::uuid, $4, $5, $6::jsonb)`,
		runnerID, tokenHash, jobID, body.Status, errMsg, meta); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (cp *ControlPlane) handleLogs(w http.ResponseWriter, r *http.Request) {
	runnerID, tokenHash, ok := cp.authHash(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	jobID := r.PathValue("id")
	var body struct {
		LogChunk    string `json:"log_chunk"`
		StreamType  string `json:"stream_type"`
		Traceparent string `json:"traceparent"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if body.LogChunk == "" {
		http.Error(w, "log_chunk is required", http.StatusBadRequest)
		return
	}
	stream := body.StreamType
	if stream == "" {
		stream = "STDOUT"
	}
	var tp *string
	if body.Traceparent != "" {
		tp = &body.Traceparent
	}
	// The real ownership-checked log write (insert_job_log).
	if _, err := cp.pool.Exec(r.Context(),
		`SELECT public.insert_job_log($1::uuid, $2, $3::uuid, $4, $5, $6)`,
		runnerID, tokenHash, jobID, body.LogChunk, stream, tp); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"success": true})
}

// handleStateToken mints an opaque per-job state token. The in-memory state backend
// accepts any token, so its value is irrelevant — but the runner requires a non-empty
// one, and returning it exercises the FetchStateToken path.
func (cp *ControlPlane) handleStateToken(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := cp.authHash(r); !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	tok, _ := newToken()
	writeJSON(w, http.StatusOK, map[string]any{"token": tok})
}

func (cp *ControlPlane) handleGitToken(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := cp.authHash(r); !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Production-faithful git-token path (BYOC A0.6): the runner fetches the apps/BYO-chart
	// credential HERE (POST /jobs/{id}/git-token) exactly as it does against the console —
	// the token is NEVER carried in the config_snapshot (which is persisted to Postgres), so it
	// cannot land in a proof/DB dump. It is served straight from the T2 process env
	// (ALETHIA_E2E_GIT_TOKEN, wired from the CI secret) and crosses to the sandbox child via the
	// child's allowlisted env, not the workdir payload. Unset ⇒ an explicit null token (200), the
	// no-git-source default the lean local/kind path relies on.
	if tok := strings.TrimSpace(os.Getenv(envArgoGitToken)); tok != "" {
		writeJSON(w, http.StatusOK, map[string]any{"token": tok})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": nil})
}

// handleAddonSecrets serves the runner's add-on secret fetch (W4.5 #640), the same
// production-faithful shape as handleGitToken above: values are NEVER carried in the
// config_snapshot (which is persisted to Postgres), and the runner that owns the job pulls them at
// execution time to seed each add-on's in-cluster Secret before ArgoCD syncs.
//
// WHY THIS EXISTS (#2835). Until now this route simply did not exist on the stand-in. The runner
// asked, got a 404, and `argocd.EnsureAddOnSecrets` received an empty map — so NO add-on could ever
// receive a secret in an e2e run. minio then fell back to the chart's own credential generation,
// which happens at RENDER time and therefore differs on every reconcile (#2822): permanently
// OutOfSync, with the root credentials rotating under a running workload.
//
// The values are MINTED HERE and held for the process lifetime, rather than read from the snapshot
// or the DB. Two reasons: a value in the snapshot is the leak this whole path exists to avoid, and
// minting keeps the stand-in honest about what it is — a control plane that OWNS these values,
// exactly as the console does. Stability across the run is what matters (a value that changed
// between two fetches would reintroduce the very rotation being fixed); encryption-at-rest is a
// console concern with its own unit tests and no keyring exists here.
func (cp *ControlPlane) handleAddonSecrets(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := cp.authHash(r); !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	jobID := r.PathValue("id")

	// Which add-ons this job enabled, and which keys each declares — read from the snapshot the
	// job was seeded with, so the answer follows the fixture rather than a second hardcoded list.
	addons, err := cp.addonSecretKeys(r.Context(), jobID)
	if err != nil {
		http.Error(w, "could not read job add-ons", http.StatusInternalServerError)
		return
	}

	cp.addonSecretsMu.Lock()
	defer cp.addonSecretsMu.Unlock()
	if cp.addonSecrets == nil {
		cp.addonSecrets = map[string]map[string]string{}
	}
	out, err := mintAddonSecrets(cp.addonSecrets, addons, newToken)
	if err != nil {
		http.Error(w, "could not mint add-on secret", http.StatusInternalServerError)
		return
	}
	// Note the ABSENCE of a log line naming a value. Only ids and key names may be logged.
	writeJSON(w, http.StatusOK, map[string]any{"secrets": out})
}

// mintAddonSecrets returns the requested values, minting any key not already held and REMEMBERING
// it in `held` (mutated in place, addon id → key → plaintext).
//
// Split from the handler so the property that actually matters is testable without a database: a
// value must be STABLE across fetches. One that changed between two calls would reintroduce exactly
// the per-reconcile credential rotation this whole path exists to remove (#2822) — the runner would
// seed a different Secret on every deploy, and the chart would restart against credentials that
// moved underneath it.
//
// `mint` is injected so a test can force the failure branch; a mint error aborts rather than
// serving a partial set, because a half-populated Secret fails in a way that looks like a chart bug.
func mintAddonSecrets(
	held map[string]map[string]string,
	addons map[string][]string,
	mint func() (string, error),
) (map[string]map[string]string, error) {
	out := map[string]map[string]string{}
	for addonID, keys := range addons {
		vals := map[string]string{}
		for _, k := range keys {
			if _, ok := held[addonID]; !ok {
				held[addonID] = map[string]string{}
			}
			if _, already := held[addonID][k]; !already {
				v, err := mint()
				if err != nil {
					return nil, err
				}
				held[addonID][k] = v
			}
			vals[k] = held[addonID][k]
		}
		if len(vals) > 0 {
			out[addonID] = vals
		}
	}
	return out, nil
}

// addonSecretKeys reads addon id → secretRef.keys from the job's config_snapshot. An add-on with no
// secretRef contributes nothing, which is how every add-on that needs no credential stays untouched.
func (cp *ControlPlane) addonSecretKeys(ctx context.Context, jobID string) (map[string][]string, error) {
	var raw []byte
	if err := cp.pool.QueryRow(ctx,
		`SELECT config_snapshot FROM public.jobs WHERE id = $1`, jobID).Scan(&raw); err != nil {
		return nil, err
	}
	return parseAddonSecretKeys(raw)
}

// parseAddonSecretKeys reads addon id → secretRef.keys out of a config snapshot. Split from the
// query so it can be tested without a database.
//
// An add-on with no secretRef, an empty key list, or a blank id contributes NOTHING. That is what
// keeps every add-on which needs no credential untouched, and it is the branch worth pinning: a
// permissive reader here would mint and serve secrets for add-ons that never asked for one.
func parseAddonSecretKeys(raw []byte) (map[string][]string, error) {
	var snap struct {
		AddOns []struct {
			ID        string `json:"id"`
			SecretRef *struct {
				Keys []string `json:"keys"`
			} `json:"secretRef"`
		} `json:"addons"`
	}
	if err := json.Unmarshal(raw, &snap); err != nil {
		return nil, err
	}
	out := map[string][]string{}
	for _, a := range snap.AddOns {
		if a.ID == "" || a.SecretRef == nil {
			continue
		}
		var keys []string
		for _, k := range a.SecretRef.Keys {
			if strings.TrimSpace(k) != "" {
				keys = append(keys, k)
			}
		}
		if len(keys) > 0 {
			out[a.ID] = keys
		}
	}
	return out, nil
}

func (cp *ControlPlane) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := cp.authHash(r); !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"cancelled_job_ids": []string{}})
}

// handleWake serves the push-dispatch SSE stream: one wake to trigger an immediate
// claim drain, then keep-alive comments until the request is cancelled.
func (cp *ControlPlane) handleWake(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := cp.authHash(r); !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "data: {\"type\":\"wake\"}\n\n")
	fl.Flush()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			_, _ = io.WriteString(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

// handleState + handleStateLock implement OpenTofu's http state backend in memory
// (GET/POST/DELETE state; POST/DELETE lock), mirroring what the console's state proxy
// exposes — enough for a single-writer deploy + the test's own RunDestroy teardown.
// resolveStateKeyLocked maps a request's path job id to its storage slot (an alias
// when one was set via AliasStateToJob, else the id itself). Caller holds cp.mu.
func (cp *ControlPlane) resolveStateKeyLocked(jobID string) string {
	if k, ok := cp.stateAlias[jobID]; ok {
		return k
	}
	return jobID
}

// AliasStateToJob makes all state I/O for aliasJobID resolve to targetJobID's storage
// slot. A follow-on job (a DETECT_DRIFT after its DEPLOY) then reads the SAME tofu state
// the deploy wrote — the harness analogue of the console keying state per project
// environment rather than per job. Without an alias, each job keys its own slot (the
// single-job T1/T2 default, unchanged).
func (cp *ControlPlane) AliasStateToJob(aliasJobID, targetJobID string) {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	cp.stateAlias[aliasJobID] = targetJobID
}

// StateSnapshot returns a copy of the tofu state stored for jobID's slot (following any
// alias), or nil if none. Lets a test assert the deploy wrote real, non-empty state (and
// count resources) — the non-vacuity floor a drift/refresh run reconciles against.
func (cp *ControlPlane) StateSnapshot(jobID string) []byte {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	e := cp.states[cp.resolveStateKeyLocked(jobID)]
	if e == nil || e.state == nil {
		return nil
	}
	out := make([]byte, len(e.state))
	copy(out, e.state)
	return out
}

// StateClearedBy reports HOW jobID's state slot last became empty: "delete" when tofu issued an
// HTTP DELETE against the backend, "empty-write" when it POSTed a zero-length body, and "" when the
// slot has never been emptied (which includes "was never written at all").
//
// The distinction is the whole point. `StateSnapshot` returns raw bytes, so a slot cleared by a real
// destroy and a slot nothing ever wrote are the SAME observation — and they mean opposite things:
// one is proof that live infrastructure was reclaimed, the other is proof of nothing.
func (cp *ControlPlane) StateClearedBy(jobID string) string {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return cp.stateClearedBy[cp.resolveStateKeyLocked(jobID)]
}

// StateReadsNonEmpty is how many times jobID's tofu run GET a NON-EMPTY state object from
// the backend — proof a drift/refresh run actually read real recorded state rather than
// sailing over an empty slot (which would yield a vacuous in-sync posture).
func (cp *ControlPlane) StateReadsNonEmpty(jobID string) int {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	return cp.stateReadNonEmpty[jobID]
}

func (cp *ControlPlane) handleState(w http.ResponseWriter, r *http.Request) {
	jobID := r.PathValue("id")
	cp.mu.Lock()
	defer cp.mu.Unlock()
	key := cp.resolveStateKeyLocked(jobID)
	e := cp.states[key]
	switch r.Method {
	case http.MethodGet:
		if e == nil || e.state == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		cp.stateReadNonEmpty[jobID]++
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(e.state)
	case http.MethodPost:
		b, _ := io.ReadAll(r.Body)
		if e == nil {
			e = &stateEntry{}
			cp.states[key] = e
		}
		e.state = b
		if len(b) == 0 {
			cp.stateClearedBy[key] = "empty-write"
		} else {
			delete(cp.stateClearedBy, key)
		}
		w.WriteHeader(http.StatusOK)
	case http.MethodDelete:
		if e != nil {
			e.state = nil
		}
		cp.stateClearedBy[key] = "delete"
		w.WriteHeader(http.StatusOK)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (cp *ControlPlane) handleStateLock(w http.ResponseWriter, r *http.Request) {
	jobID := r.PathValue("id")
	cp.mu.Lock()
	defer cp.mu.Unlock()
	key := cp.resolveStateKeyLocked(jobID)
	e := cp.states[key]
	if e == nil {
		e = &stateEntry{}
		cp.states[key] = e
	}
	switch r.Method {
	case http.MethodPost: // LOCK
		if e.locked {
			w.WriteHeader(http.StatusConflict)
			return
		}
		e.locked = true
		w.WriteHeader(http.StatusOK)
	case http.MethodDelete: // UNLOCK
		e.locked = false
		w.WriteHeader(http.StatusOK)
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// ─────────────────────────── receipt / teardown / kube helpers ───────────────────────────

// VerifySignedReceipt unmarshals a persisted verify_receipt JSON object and checks it is a REAL
// ed25519 signature over the REAL plan hash, AND that what it seals is evidence rather than an
// empty envelope: the algorithm is ed25519, the detached signature verifies under pub, and
// AssertReceiptEvidence holds over the embedded report. Returns the sealed plan hash.
//
// The evidence half runs HERE, at the single choke point both legs already call, rather than beside
// each call site — a receipt assertion that a leg can forget to make is one a leg will eventually
// forget to make. It also closes a gap between this function and its own documentation: it promised
// "a 64-char HEX sha256" while checking only the length, so a 64-character non-hex string — bound to
// no plan at all — satisfied it.
func VerifySignedReceipt(raw json.RawMessage, pub ed25519.PublicKey) (planSHA string, err error) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", errors.New("verify_receipt is absent — the signing/receipt path did not run")
	}
	var sr verify.SignedReceipt
	if err := json.Unmarshal(raw, &sr); err != nil {
		return "", fmt.Errorf("decode signed receipt: %w", err)
	}
	if sr.Algorithm != "ed25519" {
		return "", fmt.Errorf("receipt algorithm = %q, want ed25519", sr.Algorithm)
	}
	if err := sr.Verify(pub); err != nil {
		return "", fmt.Errorf("receipt signature does not verify: %w", err)
	}
	// Cryptography proves WHO said it and that it was not altered. It says nothing about whether
	// anything was actually evaluated — and a perfectly signed receipt over zero controls is exactly
	// what a compliance reader would accept as proof.
	if err := AssertReceiptEvidence(sr); err != nil {
		return "", fmt.Errorf("the receipt verifies cryptographically but is not evidence: %w", err)
	}
	if err := assertRekorAnchorIfPresent(sr); err != nil {
		return "", fmt.Errorf("rekor anchor: %w", err)
	}
	return sr.Receipt.PlanSHA256, nil
}

// TeardownCluster destroys the provisioned kind cluster via the REAL provisioner
// RunDestroy (reading state back from the control plane), with a docker-level
// fallback so no kind container leaks even if `tofu destroy` fails. GUARANTEED
// teardown: the caller registers this before the deploy so it runs on any failure.
func TeardownCluster(ctx context.Context, cpURL, jobID, project, env, templatesDir, clusterName string, out io.Writer) error {
	vc := &types.ProjectConfig{
		ID:               "e2e-" + env,
		ProjectName:      project,
		EnvironmentStage: types.EnvironmentStage(env),
		Region:           "local",
	}
	backend := &cloud.HTTPBackendConfig{ConsoleURL: cpURL, JobID: jobID, Token: "e2e-teardown"}
	err := provisioner.RunDestroy(ctx, provisioner.DestroyParams{
		ProjectConfig: vc,
		Provider:      "hetzner",
		TemplatesDir:  templatesDir,
		StateBackend:  backend,
		Stdout:        out,
		Stderr:        out,
	})
	if err != nil {
		// Fallback: remove the kind control-plane container directly.
		_ = exec.Command("docker", "rm", "-f", clusterName+"-control-plane").Run()
		return err
	}
	return nil
}

// KindKubeconfig fetches a HOST-usable kubeconfig for the kind cluster via the `kind`
// CLI (`kind get kubeconfig`). kind discovers clusters by Docker labels, so it sees
// the cluster the tehcyx/kind provider created. An INDEPENDENT path to the cluster —
// not the runner's KUBECONFIG side-effect, and not the scrubbed DB metadata.
func KindKubeconfig(ctx context.Context, clusterName string) ([]byte, error) {
	if _, err := exec.LookPath("kind"); err != nil {
		return nil, fmt.Errorf("kind not on PATH — cannot fetch an independent kubeconfig: %w", err)
	}
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "kind", "get", "kubeconfig", "--name", clusterName).Output()
	if err != nil {
		return nil, fmt.Errorf("kind get kubeconfig --name %s: %w", clusterName, err)
	}
	return out, nil
}

// HasReadyNode reports whether any line of `kubectl get nodes --no-headers` output has
// STATUS exactly "Ready" (2nd column) — not "NotReady", which also contains "Ready".
func HasReadyNode(nodes string) bool {
	for _, line := range strings.Split(strings.TrimSpace(nodes), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[1] == "Ready" {
			return true
		}
	}
	return false
}

// ─────────────────────────── small utils ───────────────────────────

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// newUUID returns a random RFC 4122 v4 UUID string (no external dep).
func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
