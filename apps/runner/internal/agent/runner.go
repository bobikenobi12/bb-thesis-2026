// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/runner/internal/obs"
	"github.com/alethialabs-io/alethialabs/apps/runner/internal/version"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
	"github.com/alethialabs-io/alethialabs/packages/core/sandbox"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type Config struct {
	Operator    string   // "managed" or "self"
	Providers   []string // cloud providers this runner can run (per-cloud routing); empty = any
	AlethiaURL  string
	RunnerID    string
	RunnerToken string
}

type Runner struct {
	config Config
	api    JobAPI
	// sandbox is the isolation boundary a job's untrusted work runs through. The
	// default is a no-isolation Passthrough (today's behavior); an isolating backend
	// is swapped in behind a flag once proven (see the E0 plan). Never nil.
	sandbox sandbox.Sandbox
	// cancels tracks in-flight jobs so a cancel event pushed over the wake stream can
	// tear down the right job mid-flight (and mark it CANCELLED, not FAILED).
	cancels *cancelRegistry
}

func New(cfg Config) *Runner {
	client := NewRunnerAPIClient(cfg.AlethiaURL, cfg.RunnerID, cfg.RunnerToken)
	client.providers = cfg.Providers
	return &Runner{config: cfg, api: client, sandbox: selectSandbox(cfg), cancels: newCancelRegistry()}
}

func NewWithAPI(cfg Config, api JobAPI) *Runner {
	return &Runner{config: cfg, api: api, sandbox: selectSandbox(cfg), cancels: newCancelRegistry()}
}

// selectSandbox picks the isolation backend from ALETHIA_SANDBOX_BACKEND. Default is the
// no-isolation Passthrough (today's behavior). "container" selects the per-job container
// backend; if it can't initialize on an operator=managed runner it is **fail-closed** — a
// Passthrough with EnforceManaged=true that REFUSES every job — rather than silently
// running untrusted work unsandboxed.
//
// ALETHIA_SANDBOX_ENFORCE_MANAGED is the config-driven kill-switch for the DEFAULT
// (no-container) path: once the container backend is proven on the fleet (Step 3b), the
// maintainer sets it fleet-wide so any managed pool that LACKS the container backend
// refuses jobs rather than silently running unsandboxed — no code redeploy to flip. Left
// false today so existing trusted managed provisioning is unaffected.
func selectSandbox(cfg Config) sandbox.Sandbox {
	if os.Getenv("ALETHIA_SANDBOX_BACKEND") != "container" {
		return sandbox.Passthrough{
			Operator:       cfg.Operator,
			EnforceManaged: envTrue("ALETHIA_SANDBOX_ENFORCE_MANAGED"),
		}
	}
	c, err := sandbox.NewContainerFromEnv(cfg.Operator)
	if err == nil {
		return c
	}
	// Fail-closed for anything that is not an EXPLICIT self operator: an empty/unknown
	// operator string must NOT downgrade to a lenient Passthrough when the container backend
	// was requested but is unavailable — only "self" (customer's own cloud) is lenient.
	if cfg.Operator != "self" {
		fmt.Fprintf(os.Stderr, "sandbox: container backend required but unavailable on non-self runner (operator=%q): %v — refusing jobs (fail-closed)\n", cfg.Operator, err)
		return sandbox.Passthrough{Operator: cfg.Operator, EnforceManaged: true}
	}
	fmt.Fprintf(os.Stderr, "sandbox: container backend unavailable (%v); using Passthrough (operator=%s)\n", err, cfg.Operator)
	return sandbox.Passthrough{Operator: cfg.Operator}
}

// stateBackend mints a per-job tofu-state token and returns the console http
// state-backend config for project provisioning. The token authorizes state I/O
// for this job only and reaches tofu via TF_HTTP_PASSWORD (never a workdir file),
// so no storage master credential touches the untrusted project path.
func (w *Runner) stateBackend(jobID string) (*cloud.HTTPBackendConfig, error) {
	token, err := w.api.FetchStateToken(jobID)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch tofu state token: %w", err)
	}
	return &cloud.HTTPBackendConfig{
		ConsoleURL: w.config.AlethiaURL,
		JobID:      jobID,
		Token:      token,
	}, nil
}

// Timing constants of the runner's background loops. They are package vars rather than
// consts purely so a test can shorten them; production never reassigns them, and the
// values are the ones the loops have always used.
var (
	// heartbeatInterval is the period of the liveness heartbeat.
	heartbeatInterval = 30 * time.Second
	// shutdownGracePeriod is how long a draining runner may keep finishing its current
	// job after SIGINT/SIGTERM before the root context is force-cancelled.
	shutdownGracePeriod = 10 * time.Minute
	// safetyInterval is the period of claimLoop's fallback poll — the only thing that
	// still drives a claim drain while the wake stream is down.
	safetyInterval = 30 * time.Second
	// wakeBackoffBase / wakeMaxBackoff bound the wake-stream reconnect backoff.
	wakeBackoffBase = time.Second
	wakeMaxBackoff  = 30 * time.Second
)

func (w *Runner) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var draining atomic.Bool

	// Bind runner_id onto the process-wide operational logger for every job-less line.
	InitAgentLogger(w.config.RunnerID)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		Log().Info("received shutdown signal, finishing current job")
		draining.Store(true)
		time.AfterFunc(shutdownGracePeriod, func() {
			Log().Warn("grace period expired, forcing shutdown")
			cancel()
		})
	}()

	go w.heartbeatLoop(ctx)

	Log().Info("runner started",
		"operator", w.config.Operator,
		"version", version.Version,
		"alethia_url", w.config.AlethiaURL)

	return w.claimLoop(ctx, &draining)
}

func (w *Runner) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	if cancelled, err := w.api.Heartbeat(); err != nil {
		Log().Error("initial heartbeat failed", "err", err.Error())
		captureError(err, map[string]string{"op": "heartbeat", "runner_id": w.config.RunnerID})
	} else {
		w.applyHeartbeatCancels(cancelled)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if cancelled, err := w.api.Heartbeat(); err != nil {
				Log().Error("heartbeat failed", "err", err.Error())
				captureError(err, map[string]string{"op": "heartbeat", "runner_id": w.config.RunnerID})
			} else {
				w.applyHeartbeatCancels(cancelled)
			}
		}
	}
}

// applyHeartbeatCancels is the fallback cancel path: for each job the console reports as
// server-side-cancelled, tear it down IF it's still running here. This catches a cancel that was
// missed on the wake stream (its pg_notify dropped because the SSE was reconnecting). cancelIfRunning
// is a no-op for jobs this runner isn't running, so re-reporting the same id each tick is harmless.
func (w *Runner) applyHeartbeatCancels(jobIDs []string) {
	for _, jobID := range jobIDs {
		if w.cancels.cancelIfRunning(jobID) {
			Log().Warn("cancelling job via heartbeat fallback (wake-stream cancel was missed)",
				"job_id", jobID)
		}
	}
}

// claimLoop reacts to push wakes (and a slow safety poll) by draining claimable
// jobs. The wake stream gives sub-second pickup; the safety poll is the fallback if
// the stream drops. Each tick drains the queue until nothing is left for this runner.
func (w *Runner) claimLoop(ctx context.Context, draining *atomic.Bool) error {
	wakeCh := make(chan struct{}, 1)
	trigger := func() {
		select {
		case wakeCh <- struct{}{}:
		default: // a wake is already pending; coalesce
		}
	}

	go w.wakeLoop(ctx, func(ev WakeEvent) { w.dispatchWakeEvent(ev, trigger) })

	safety := time.NewTicker(safetyInterval)
	defer safety.Stop()

	trigger() // drain any backlog on startup

	for {
		if draining.Load() {
			Log().Info("draining: no more jobs will be claimed, exiting")
			return nil
		}

		select {
		case <-ctx.Done():
			return nil
		case <-safety.C:
		case <-wakeCh:
		}

		// Drain: claim and run jobs until the queue has nothing for us.
		for !draining.Load() {
			if ctx.Err() != nil {
				return nil
			}
			claim, err := w.api.ClaimJob()
			if err != nil {
				Log().Error("failed to claim job", "err", err.Error())
				captureError(err, map[string]string{"op": "claim", "runner_id": w.config.RunnerID})
				break
			}
			if claim.Job == nil {
				break
			}

			traceID := traceIDFromTraceparent(claim.Job.Traceparent)
			LogWith(w.config.RunnerID, traceID, claim.Job.ID).Info("claimed job",
				"job_type", claim.Job.JobType)
			// PLAN/DEPLOY/DESTROY provision real infra, so they keep a long timeout.
			jobTimeout := 2 * time.Hour
			jobCtx, jobCancel := context.WithTimeout(ctx, jobTimeout)
			// Register the cancel function so a cancel event over the wake stream can
			// tear THIS job down mid-flight; reap the registry entry once it's done.
			w.cancels.register(claim.Job.ID, jobCancel)
			if err := w.executeJob(jobCtx, claim); err != nil {
				LogWith(w.config.RunnerID, traceID, claim.Job.ID).Error("job failed",
					"err", err.Error())
			}
			jobCancel()
			w.cancels.reap(claim.Job.ID)
		}
	}
}

// dispatchWakeEvent routes a push-dispatch event: a wake triggers a claim drain; a cancel
// tears down the targeted in-flight job (a no-op if it isn't running on this runner — e.g. a
// QUEUED job the console cancelled DB-only, or one already finished).
func (w *Runner) dispatchWakeEvent(ev WakeEvent, trigger func()) {
	switch ev.Type {
	case "cancel":
		if ev.JobID != "" {
			if w.cancels.cancel(ev.JobID) {
				Log().Info("cancel signal received; tearing down job", "job_id", ev.JobID)
			}
		}
	default: // "wake"
		trigger()
	}
}

// wakeLoop maintains the push-dispatch SSE connection, reconnecting with backoff.
// Each event is dispatched via onEvent (wake → claim attempt; cancel → job teardown).
func (w *Runner) wakeLoop(ctx context.Context, onEvent func(WakeEvent)) {
	backoff := wakeBackoffBase
	maxBackoff := wakeMaxBackoff
	for {
		if ctx.Err() != nil {
			return
		}
		err := w.api.StreamWake(ctx, onEvent)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			Log().Warn("wake stream disconnected; reconnecting",
				"err", err.Error(), "backoff", backoff.String())
		}
		sleepCtx(ctx, backoff)
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

func (w *Runner) executeJob(ctx context.Context, claim *ClaimResponse) (retErr error) {
	job := claim.Job
	traceparent := job.Traceparent
	traceID := traceIDFromTraceparent(traceparent)
	// Operational logger for this job's lifetime — structured JSON to stderr carrying
	// the correlation ids so a runner line joins the console trace.
	jlog := LogWith(w.config.RunnerID, traceID, job.ID)

	// Anchor this job's work to the traceparent minted at enqueue, then open the runner's
	// per-job span. The console started the root at enqueue and stamped the traceparent on
	// the job; by re-anchoring to the SAME traceparent here, this span (and the provisioner
	// stage spans nested under it via ctx) share ONE trace-id with the console spans — the
	// console↔runner JOIN. No-op when no OTLP endpoint is configured. job_id lives as a span
	// ATTRIBUTE (fine — spans are high-cardinality), never as a metric label.
	provider := ""
	if claim.CloudIdentity != nil {
		provider = claim.CloudIdentity.Provider
	}
	ctx = obs.ContextFromTraceparent(ctx, traceparent)
	ctx, span := obs.Tracer().Start(ctx, "job.execute",
		trace.WithAttributes(
			attribute.String("alethia.job_id", job.ID),
			attribute.String("alethia.job_type", job.JobType),
			attribute.String("provider", provider),
		))
	defer func() {
		if retErr != nil {
			span.RecordError(retErr)
			span.SetStatus(codes.Error, retErr.Error())
		}
		span.End()
	}()

	// Customer-facing job streams (STDOUT/STDERR) — trace-stamped so each log line
	// correlates. SYSTEM ships the runner's OPERATIONAL failures to the console (they
	// would otherwise die on the runner's stderr).
	stdoutLogger := NewJobLoggerWithTrace(w.api, job.ID, "STDOUT", traceparent)
	stderrLogger := NewJobLoggerWithTrace(w.api, job.ID, "STDERR", traceparent)
	sysLogger := NewSystemLogger(w.api, job.ID, traceparent)
	defer stdoutLogger.Close()
	defer stderrLogger.Close()
	defer sysLogger.Close()

	// Emit immediately so the user sees activity within ~100ms of claim — before
	// credential setup and tofu init — instead of waiting on the first real step.
	fmt.Fprintln(stdoutLogger, "▸ Job claimed — preparing workspace…")

	if err := w.api.UpdateJobStatus(job.ID, "PROCESSING", "", nil); err != nil {
		jlog.Error("failed to update job status to PROCESSING", "err", err.Error())
		fmt.Fprintf(sysLogger, "Failed to update job status to PROCESSING: %v\n", err)
		captureError(err, map[string]string{
			"op": "update_status", "runner_id": w.config.RunnerID, "job_id": job.ID, "trace_id": traceID,
		})
	}

	if claim.CloudIdentity != nil {
		switch types.CloudProvider(claim.CloudIdentity.Provider) {
		case types.CloudProviderAws:
			// Managed runners have NO ambient AWS identity (the Hetzner fleet injects no keys), so they
			// federate in KEYLESSLY via DIRECT OIDC: AssumeRoleWithWebIdentity straight into the customer
			// role (which trusts the Alethia issuer), auto-refreshing — no platform AWS account, no
			// ExternalId. Self-hosted runners run in the customer's cloud with their own creds, so they keep
			// the direct AssumeRole path.
			if w.config.Operator == "managed" {
				fmt.Fprintf(stdoutLogger, "Activating keyless AWS federation into %s (account %s)...\n", claim.CloudIdentity.RoleArn, claim.CloudIdentity.AccountID)
				cleanup, err := ActivateAwsFederated(ctx, w.api, claim.CloudIdentity.RoleArn, job.ID)
				if err != nil {
					errMsg := fmt.Sprintf("Failed to activate AWS federation: %v", err)
					fmt.Fprintln(stderrLogger, errMsg)
					_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
					return err
				}
				defer cleanup()
			} else {
				fmt.Fprintf(stdoutLogger, "Assuming role %s into account %s...\n", claim.CloudIdentity.RoleArn, claim.CloudIdentity.AccountID)
				sessionName := fmt.Sprintf("runner-%s", shortID(job.ID, 8))
				if err := AssumeRole(ctx, claim.CloudIdentity.RoleArn, claim.CloudIdentity.ExternalID, sessionName); err != nil {
					errMsg := fmt.Sprintf("Failed to assume role: %v", err)
					fmt.Fprintln(stderrLogger, errMsg)
					_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
					return err
				}
				defer ClearAssumedCredentials()
			}
		case types.CloudProviderGcp:
			// Managed runners federate GCP KEYLESSLY via DIRECT OIDC — a minted JWT via a token file, no AWS
			// hop. (The legacy AWS-hub path is retired.) Self-hosted runners rely on their own ambient GCP
			// credentials (ADC / metadata).
			if w.config.Operator == "managed" {
				if !isOidcWifJSON(claim.CloudIdentity.WifConfig) {
					errMsg := "This GCP connection uses the retired AWS-hub setup. Reconnect it (Connectors → GCP) to migrate to direct-OIDC."
					fmt.Fprintln(stderrLogger, errMsg)
					_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
					return fmt.Errorf("%s", errMsg)
				}
				fmt.Fprintf(stdoutLogger, "Activating keyless GCP OIDC for project %s (SA: %s)...\n", claim.CloudIdentity.ProjectID, claim.CloudIdentity.ServiceAccountEmail)
				cleanup, err := ActivateGcpOIDC(ctx, w.api, claim.CloudIdentity.WifConfig, claim.CloudIdentity.ProjectID, job.ID)
				if err != nil {
					errMsg := fmt.Sprintf("Failed to activate GCP OIDC: %v", err)
					fmt.Fprintln(stderrLogger, errMsg)
					_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
					return err
				}
				defer cleanup()
			} else {
				fmt.Fprintf(stdoutLogger, "Activating WIF for project %s (SA: %s)...\n", claim.CloudIdentity.ProjectID, claim.CloudIdentity.ServiceAccountEmail)
				cleanup, err := ActivateGcpWIF(claim.CloudIdentity.WifConfig, claim.CloudIdentity.ProjectID)
				if err != nil {
					errMsg := fmt.Sprintf("Failed to activate GCP WIF: %v", err)
					fmt.Fprintln(stderrLogger, errMsg)
					_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
					return err
				}
				defer cleanup()
			}
		case types.CloudProviderAzure:
			fmt.Fprintf(stdoutLogger, "Activating Azure federated identity for tenant %s (subscription: %s)...\n", claim.CloudIdentity.TenantID, claim.CloudIdentity.SubscriptionID)
			cleanup, err := ActivateAzureFederated(ctx, w.api, claim.CloudIdentity.TenantID, claim.CloudIdentity.ClientID, claim.CloudIdentity.SubscriptionID, job.ID)
			if err != nil {
				errMsg := fmt.Sprintf("Failed to activate Azure federated identity: %v", err)
				fmt.Fprintln(stderrLogger, errMsg)
				_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
				return err
			}
			defer cleanup()
		case types.CloudProviderDigitalocean, types.CloudProviderHetzner, types.CloudProviderCivo:
			fmt.Fprintf(stdoutLogger, "Activating %s API token...\n", claim.CloudIdentity.Provider)
			cleanup, err := ActivateTokenCloud(claim.CloudIdentity.Provider, claim.CloudIdentity.APIToken, claim.CloudIdentity.SelfManaged)
			if err != nil {
				errMsg := fmt.Sprintf("Failed to activate %s token: %v", claim.CloudIdentity.Provider, err)
				fmt.Fprintln(stderrLogger, errMsg)
				_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
				return err
			}
			defer cleanup()
			// Hetzner Object Storage: export the (optional) S3 key pair for the minio provider.
			if types.CloudProvider(claim.CloudIdentity.Provider) == types.CloudProviderHetzner &&
				claim.CloudIdentity.S3AccessKey != "" && claim.CloudIdentity.S3SecretKey != "" {
				fmt.Fprintln(stdoutLogger, "Activating Hetzner Object Storage S3 credentials...")
				s3Cleanup := ActivateHetznerS3(claim.CloudIdentity.S3AccessKey, claim.CloudIdentity.S3SecretKey)
				defer s3Cleanup()
			}
		case types.CloudProviderAlibaba:
			// Keyless: the alicloud provider runs an anonymous AssumeRoleWithOIDC from a token file — no
			// AccessKey on the runner (the retired platform RAM key).
			fmt.Fprintf(stdoutLogger, "Activating keyless Alibaba OIDC for role %s...\n", claim.CloudIdentity.RoleArn)
			cleanup, err := ActivateAlibabaOIDC(ctx, w.api, claim.CloudIdentity.RoleArn, claim.CloudIdentity.OidcProviderArn, job.ID)
			if err != nil {
				errMsg := fmt.Sprintf("Failed to activate Alibaba OIDC: %v", err)
				fmt.Fprintln(stderrLogger, errMsg)
				_ = w.api.UpdateJobStatus(job.ID, "FAILED", errMsg, nil)
				return err
			}
			defer cleanup()
		}
	}

	var execErr error
	// Switch on the generated types.JobType so `exhaustive` (golangci-lint) forces a
	// case for every provision_job_type value — adding a job type here is mandatory,
	// and removing one from the enum SSOT makes the missing constant a compile error.
	switch types.JobType(job.JobType) {
	case types.JobTypePlan:
		execErr = w.executePlan(ctx, job, provider, claim.CloudIdentity, claim.ConnectorCredentials, stdoutLogger, stderrLogger)
	case types.JobTypeDeploy:
		execErr = w.executeDeploy(ctx, job, provider, claim.CloudIdentity, claim.ConnectorCredentials, stdoutLogger, stderrLogger)
	case types.JobTypeDestroy:
		execErr = w.executeDestroy(ctx, job, provider, claim.CloudIdentity, claim.ConnectorCredentials, stdoutLogger, stderrLogger)
	case types.JobTypeDeployRunner, types.JobTypeUpdateRunner:
		execErr = w.executeDeployRunner(ctx, job, provider, claim.CloudIdentity, stdoutLogger, stderrLogger)
	case types.JobTypeDestroyRunner:
		execErr = w.executeDestroyRunner(ctx, job, provider, claim.CloudIdentity, stdoutLogger, stderrLogger)
	case types.JobTypeAnalyzeRepo:
		execErr = w.executeAnalyzeRepo(ctx, job, stdoutLogger, stderrLogger)
	case types.JobTypeDetectDrift:
		execErr = w.executeDriftDetection(ctx, job, provider, claim.CloudIdentity, stdoutLogger, stderrLogger)
	case types.JobTypeAudit:
		execErr = w.executeAudit(ctx, job, stdoutLogger, stderrLogger)
	case types.JobTypeChartScan:
		execErr = w.executeChartScan(ctx, job, claim.ConnectorCredentials, stdoutLogger, stderrLogger)
	case types.JobTypeIacScan:
		execErr = w.executeIacScan(ctx, job, stdoutLogger, stderrLogger)
	case types.JobTypeStateSurgery:
		// Break-glass privileged state surgery — ships INERT (fail-closed); performs no state
		// mutation. See state_surgery.go.
		execErr = w.executeStateSurgery(ctx, job, stdoutLogger, stderrLogger)
	case types.JobTypeProbeCluster:
		// Live cluster-alive probe (BYOC B2) — see probe.go. This case used to fail closed with
		// "not yet implemented (B2.2)" while the console dispatched probes on a schedule AND from
		// the canvas Run menu, so every probe job failed and environment_probes was never written:
		// a cluster whose API server had died still read "Live" on the board.
		execErr = w.executeProbeCluster(ctx, job, provider, claim.CloudIdentity, stdoutLogger, stderrLogger)
	case types.JobTypeBuild:
		// W2 image build & push — schedules kaniko Jobs in the customer's own cluster and
		// reports the per-service digest map on execution_metadata.build_result. See build.go.
		execErr = w.executeBuild(ctx, job, provider, claim.CloudIdentity, stdoutLogger, stderrLogger)
	default:
		execErr = fmt.Errorf("unknown job type: %s", job.JobType)
	}

	if execErr != nil {
		// A user cancel surfaces as a context-cancelled error from the stage. Post
		// CANCELLED (not FAILED) so the terminal state reflects the intent, and flag
		// orphan risk when the teardown killed a mid-apply (cloud resources may exist
		// outside tofu state → an operator must reconcile; see markOrphanRisk).
		if w.cancels.wasCancelled(job.ID) {
			jlog.Info("job cancelled", "job_type", job.JobType)
			var meta map[string]any
			if w.cancels.orphanRisk(job.ID) {
				meta = map[string]any{
					"orphan_risk":        true,
					"orphan_risk_reason": "apply was interrupted by a cancel; cloud resources may exist outside tofu state and need reconciliation",
				}
				fmt.Fprintln(stderrLogger, "Cancelled during apply — cloud resources may have been left outside tofu state (orphan risk). An operator should reconcile.")
			}
			fmt.Fprintln(stdoutLogger, "▸ Job cancelled — teardown complete.")
			stderrLogger.Close()
			_ = w.api.UpdateJobStatus(job.ID, "CANCELLED", "Cancelled by user", meta)
			return execErr
		}
		jlog.Error("job execution failed", "job_type", job.JobType, "err", execErr.Error())
		// The real provisioning-failure capture (credential-activation + per-job-type errors all
		// funnel here). Guarded above by wasCancelled, so a user cancel is never reported as an error.
		captureError(execErr, map[string]string{
			"job_type":  job.JobType,
			"job_id":    job.ID,
			"trace_id":  traceID,
			"runner_id": w.config.RunnerID,
		})
		fmt.Fprintf(stderrLogger, "Error: %v\n", execErr)
		// A non-cancel mid-apply interruption that this process still gets to observe — the 2h
		// jobCtx deadline, or a shutdown-drain that cancels the root ctx after the grace period —
		// fails rather than cancels, but may have left cloud resources outside tofu state. When the
		// deploy path flagged that (see shouldMarkOrphanRisk), attach the SAME orphan_risk signal
		// the cancel path posts so the terminal metadata honestly records that an operator must
		// reconcile. reap() runs only after executeJob returns (claimLoop), and UpdateJobStatus
		// posts context-free, so the flag survives a drain here. NOTE: a HARD kill (SIGKILL / panic)
		// mid-apply never reaches this code, so it can't be flagged here — the server-side stale-job
		// reconciler is the backstop for that (it settles the env to FAILED; it can't see the
		// runner-local phase marker, so it's an orphan-blind backstop).
		var failMeta map[string]any
		if w.cancels.orphanRisk(job.ID) {
			failMeta = map[string]any{
				"orphan_risk":        true,
				"orphan_risk_reason": "apply was interrupted (timeout or runner shutdown) before tofu state was persisted; cloud resources may exist outside tofu state and need reconciliation",
			}
			fmt.Fprintln(stderrLogger, "Apply interrupted — cloud resources may have been left outside tofu state (orphan risk). An operator should reconcile.")
		} else if f, ok := applyOrphanFinding(execErr); ok {
			// A FAILED (not interrupted) apply that carried POSITIVE evidence of a resource left
			// outside tofu state — issue #526. Previously this reported orphan_risk=false on exactly
			// the failure that PERMANENTLY WEDGES the environment: every later apply dies with
			// `already exists ... needs to be imported`, and nothing told the customer why.
			//
			// The metadata names the resource, its cloud id and its tofu address, so the operator
			// gets an importable pair (STATE_SURGERY `tofu import <address> <id>`) rather than an
			// inscrutable failure. Ordinary failures carry no evidence and still land here unflagged.
			failMeta = map[string]any{
				"orphan_risk":        true,
				"orphan_risk_reason": f.Reason,
			}
			if f.Address != "" {
				failMeta["orphan_resource_address"] = f.Address
			}
			if f.CloudID != "" {
				failMeta["orphan_resource_cloud_id"] = f.CloudID
			}
			fmt.Fprintf(stderrLogger, "ORPHAN RISK (%s) — %s\n", f.Evidence, f.Reason)
		}
		stderrLogger.Close()
		_ = w.api.UpdateJobStatus(job.ID, "FAILED", execErr.Error(), failMeta)
		return execErr
	}

	_ = w.api.UpdateJobStatus(job.ID, "SUCCESS", "", nil)
	jlog.Info("job completed successfully")
	return nil
}

func resolveProjectTemplatesDir() string {
	candidates := []string{
		"/home/runner/project-templates",
		"project-templates",
		"../../infra/templates/project",
	}
	for _, d := range candidates {
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			return d
		}
	}
	return ""
}

// resolveCategoriesTemplatesDir locates the composable per-category modules
// (infra/templates/categories) — a sibling of the project templates dir.
func resolveCategoriesTemplatesDir() string {
	candidates := []string{
		"/home/runner/category-templates",
		"category-templates",
		"../../infra/templates/categories",
	}
	for _, d := range candidates {
		if info, err := os.Stat(d); err == nil && info.IsDir() {
			return d
		}
	}
	return ""
}

// toCoreConnectorCreds converts the runner's claim-response credentials into
// the core types used by the provisioner/composer.
func toCoreConnectorCreds(creds []ConnectorCredential) []types.ConnectorCredential {
	if len(creds) == 0 {
		return nil
	}
	out := make([]types.ConnectorCredential, 0, len(creds))
	for _, c := range creds {
		out = append(out, types.ConnectorCredential{
			Category:    c.Category,
			Slug:        c.Slug,
			Credentials: c.Credentials,
		})
	}
	return out
}

func (w *Runner) executeDeploy(ctx context.Context, job *Job, provider string, identity *CloudIdentity, connectorCreds []ConnectorCredential, stdout, stderr *JobLogger) error {
	vc, err := snapshotToProjectConfig(job.ConfigSnapshot)
	if err != nil {
		return fmt.Errorf("failed to parse config snapshot: %w", err)
	}
	if provider == "" {
		provider = string(vc.Provider)
	}
	if provider == "" {
		provider = "aws"
	}
	if identity != nil {
		vc.CloudAccountID = resolveAccountID(identity)
	}
	if vc.CloudAccountID == "" {
		vc.CloudAccountID = resolveAmbientAccountID(provider)
	}
	vc.ConnectorCredentials = toCoreConnectorCreds(connectorCreds)

	// E0 boundary: BYO IaC executes untrusted customer tofu — refuse on a managed runner
	// unless the egress-enforced container sandbox is active. Fail-closed, before any work.
	if err := w.byoManagedGate(vc, "DEPLOY"); err != nil {
		return err
	}

	if job.PlanJobID != nil && *job.PlanJobID != "" {
		fmt.Fprintf(stdout, "Validating against plan job %s...\n", *job.PlanJobID)
		planJob, err := w.api.GetJob(*job.PlanJobID)
		if err != nil {
			fmt.Fprintf(stderr, "Warning: could not fetch plan job for validation: %v\n", err)
		} else if planJob != nil {
			if planJob.Status != "SUCCESS" {
				return fmt.Errorf("plan job %s has status %s, expected SUCCESS", *job.PlanJobID, planJob.Status)
			}
			if job.ConfigurationHash != nil && planJob.ConfigurationHash != nil &&
				*job.ConfigurationHash != *planJob.ConfigurationHash {
				return fmt.Errorf("configuration changed since plan was generated (plan hash: %s, current: %s)",
					*planJob.ConfigurationHash, *job.ConfigurationHash)
			}
			fmt.Fprintln(stdout, "Plan validation passed.")
		}
	}

	gitToken := vc.GitAccessToken
	if gitToken == "" {
		if fetched, err := w.api.FetchGitToken(job.ID, ""); err != nil {
			fmt.Fprintf(stderr, "Warning: failed to fetch git token: %v\n", err)
		} else {
			gitToken = fetched
		}
	}

	// Per-repo tokens for bring-your-own (git-source) charts: each may live on a different
	// provider than the apps-destination repo, so resolve a token per distinct chart repo (the
	// console picks the provider from that repo, validated against the job). Resolved here in the
	// parent — the values cross the sandbox boundary as secrets and the child registers the
	// per-repo ArgoCD repository credentials before the BYO Applications sync.
	gitTokens := map[string]string{}
	for i := range vc.AddOns {
		if !vc.AddOns[i].IsGitSource() {
			continue
		}
		repo := vc.AddOns[i].ChartRepo
		if repo == "" {
			continue
		}
		if _, done := gitTokens[repo]; done {
			continue
		}
		if fetched, err := w.api.FetchGitToken(job.ID, repo); err != nil {
			fmt.Fprintf(stderr, "Warning: failed to fetch git token for %s: %v\n", repo, err)
		} else if fetched != "" {
			gitTokens[repo] = fetched
		}
	}

	// Add-on secret-knob values (W4.5 #640): the config snapshot carries only a SecretRef
	// per add-on (name/namespace/keys — never values); the plaintext is fetched HERE, over
	// the same authenticated job channel as the git token, and crosses the sandbox as a
	// stage secret so it never touches the persisted payload. Fetched only when some
	// add-on actually declares a ref (most deploys skip the round-trip).
	var addonSecrets map[string]map[string]string
	for i := range vc.AddOns {
		if vc.AddOns[i].SecretRef == nil {
			continue
		}
		if fetched, fetchErr := w.api.FetchAddonSecrets(job.ID); fetchErr != nil {
			// Fail-safe direction: the deploy proceeds; the affected chart surfaces the
			// missing Secret on ITS Application rather than the whole deploy dying here.
			fmt.Fprintf(stderr, "Warning: failed to fetch add-on secrets: %v\n", fetchErr)
		} else {
			addonSecrets = fetched
		}
		break
	}

	stateBackend, err := w.stateBackend(job.ID)
	if err != nil {
		return err
	}

	workDir, err := newJobWorkDir(job.ID)
	if err != nil {
		return fmt.Errorf("create workdir: %w", err)
	}
	defer os.RemoveAll(workDir)

	// Download the pre-approved plan into the workdir (mounted into the sandbox) so the
	// child can read it.
	planFile := ""
	if job.PlanJobID != nil && *job.PlanJobID != "" {
		planFileDest := filepath.Join(workDir, "plan-apply.out")
		if dlErr := w.api.DownloadPlanArtifact(*job.PlanJobID, planFileDest); dlErr != nil {
			fmt.Fprintf(stdout, "Warning: could not download plan artifact: %v (will re-plan)\n", dlErr)
		} else {
			fmt.Fprintln(stdout, "Using saved plan artifact from plan job.")
			planFile = planFileDest
		}
	}

	// The apply path normally skips Infracost (cost is estimated on the PLAN job). But when a
	// cost ceiling is configured (ALETHIA_COST_CEILING_MONTHLY_USD > 0), the ceiling gate needs an
	// estimate on THIS apply's own plan — so pass the Infracost token to make RunDeployV2 price the
	// plan at its verify seam. No ceiling ⇒ "" ⇒ apply behaviour is unchanged (no Infracost run).
	deployInfracostToken := ""
	if costCeilingFromEnv() > 0 {
		deployInfracostToken = os.Getenv("INFRACOST_API_KEY")
	}
	// A REFUSED override is not the same as an absent one, and the difference has to reach the
	// operator. Both builders fail closed on a malformed waiver, and until this line said so the
	// only symptom was the gate's own message — "…or supply an authorized override to proceed" —
	// telling someone who HAD supplied one to supply one. stdout is the job log, which is where
	// they are already looking when an apply blocks.
	verifyOverride, verifyRefusal := buildVerifyOverride(job.VerifyOverride)
	compatOverride, compatRefusal := buildCompatOverride(job.CompatOverride)
	for _, refusal := range []string{verifyRefusal, compatRefusal} {
		if refusal != "" {
			fmt.Fprintf(stdout, "Override REFUSED and the gate stays closed: %s\n", refusal)
		}
	}

	payload := buildDeployPayload(vc, provider, false, planFile,
		filepath.Join(resolveProjectTemplatesDir(), provider), resolveCategoriesTemplatesDir(),
		deployInfracostToken, verifyOverride, compatOverride,
		w.config.AlethiaURL, job.ID)
	stage, err := newStage(sandbox.StageDeploy, payload)
	if err != nil {
		return err
	}
	// hetzner-talos placement (#1389): fetch the Fabric's PERSISTED admin talosconfig (decrypted
	// server-side, delivered over the authenticated job channel like the addon secrets) so the stage can
	// mint a fresh short-lived kubeconfig from it via the Talos machine API. Only for a namespace/vcluster
	// placement on hetzner — a dedicated apply produces its own `kubeconfig` output and needs no mint.
	talosConfig := ""
	if provider == "hetzner" && isTalosPlacementMode(vc.PlacementMode) {
		if fetched, fetchErr := w.api.FetchFabricTalosconfig(job.ID); fetchErr != nil {
			// Fail-safe: proceed; the placement's mint path fails closed if the config is truly absent.
			fmt.Fprintf(stderr, "Warning: failed to fetch Fabric talosconfig: %v\n", fetchErr)
		} else {
			talosConfig = fetched
		}
	}

	sec := stageSecrets{GitToken: gitToken, GitTokens: gitTokens, StateToken: stateBackend.Token, AddonSecrets: addonSecrets, TalosConfig: talosConfig}

	// Run the untrusted provisioning work through the isolation seam. Passthrough runs
	// runDeployStage in-process; the container backend re-execs it in a per-job container.
	if err := w.sandbox.Run(ctx, sandbox.Spec{
		Kind: "deploy", JobID: job.ID, Provider: provider, WorkDir: workDir, Stage: stage,
		Stdout: stdout, Stderr: stderr,
		Warn: func(s string) { fmt.Fprintln(stdout, "[sandbox] "+s) },
	}, func(ctx context.Context) error {
		return runDeployStage(ctx, payload, sec, workDir, stdout, stderr)
	}); err != nil {
		// On a mid-flight interruption, decide whether the killed work had reached the apply
		// (state-mutating) phase. RunDeployV2 writes "apply" to workDir/phase just before
		// `tofu apply`; if we were torn down at or after that point, orphaned cloud resources
		// may exist. The interruption may be an explicit user cancel OR a non-cancel cause —
		// the 2h jobCtx deadline (line ~232) or the shutdown-drain cancelling the root ctx
		// (line ~123-126) — all of which surface here as ctx.Err()!=nil. A plain `tofu apply`
		// failure leaves ctx live, so it stays (correctly) unflagged. Read the marker BEFORE
		// the deferred RemoveAll(workDir) so it is still there.
		if shouldMarkOrphanRisk(readDeployPhase(workDir), w.cancels.wasCancelled(job.ID), ctx.Err()) {
			w.cancels.markOrphanRisk(job.ID)
		}
		// A GitOps-wiring hard-fail still writes a PARTIAL PlanResult into result.json
		// (carrying gitops_status: which step died + a sanitized message — issue #574).
		// Post it so the console can show WHY GitOps isn't wired, not just a failed job.
		// The PROCESSING post only jsonb-merges metadata; the caller's FAILED transition
		// is untouched. Read BEFORE the deferred RemoveAll(workDir).
		w.postDeployMetadata(job.ID, workDir, stderr)
		return err
	}

	w.postDeployMetadata(job.ID, workDir, stderr)
	// hetzner-talos (#1389): after a successful DEDICATED apply, persist the Fabric's admin talosconfig
	// (from the Talos-emitted output) so future namespace/vcluster placements onto this Fabric can mint
	// kube access. Only on a dedicated apply — placements run no tofu and emit no talosconfig. The
	// plaintext crosses the authenticated channel to the console, which encrypts it at rest; it is NOT
	// placed in execution_metadata (both the runner and console scrub any `talosconfig`-named key there).
	if provider == "hetzner" && !isTalosPlacementMode(vc.PlacementMode) {
		w.writeBackTalosconfig(job.ID, workDir, stderr)
	}
	return nil
}

// isTalosPlacementMode reports whether a placement mode runs NO tofu on an existing shared Fabric
// (namespace/vcluster) — the modes that must mint kube access from the persisted talosconfig, vs a
// dedicated apply (empty or "dedicated") that provisions the Fabric and emits its own kubeconfig.
func isTalosPlacementMode(pm types.PlacementMode) bool {
	return pm == types.PlacementModeNamespace || pm == types.PlacementModeVcluster
}

// writeBackTalosconfig reads the completed dedicated apply's talosconfig output and persists it to the
// console (encrypted at rest there). Best-effort: a missing output or a post failure just logs — the
// Fabric provisioned fine; only future placements onto it would then lack kube access (and fail closed).
func (w *Runner) writeBackTalosconfig(jobID, workDir string, stderr *JobLogger) {
	result, err := readPlanResult(workDir)
	if err != nil || result == nil {
		return
	}
	talos := talosOutputString(result.Outputs, "talosconfig")
	if talos == "" {
		return
	}
	if err := w.api.PutFabricTalosconfig(jobID, talos); err != nil {
		fmt.Fprintf(stderr, "Warning: failed to persist Fabric talosconfig for placement re-mint: %v\n", err)
	}
}

// talosOutputString reads a string tofu output, tolerating both the `{"value": ...}` wrapper and a bare
// string (mirrors packages/core/cloud.outputString, kept runner-local to avoid exporting it).
func talosOutputString(outputs map[string]interface{}, key string) string {
	val, ok := outputs[key]
	if !ok {
		return ""
	}
	if m, ok := val.(map[string]interface{}); ok {
		if s, ok := m["value"].(string); ok {
			return s
		}
		return ""
	}
	if s, ok := val.(string); ok {
		return s
	}
	return ""
}

// postDeployMetadata reads the sandbox's result.json (which exists on success AND on a
// mid-deploy failure — writeStageResult marshals any non-nil partial result), assembles
// the execution_metadata blob, scrubs it, and posts it to the console. Best-effort: a
// missing/unreadable result just logs a warning.
func (w *Runner) postDeployMetadata(jobID, workDir string, stderr *JobLogger) {
	result, err := readPlanResult(workDir)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not read stage result: %v\n", err)
	}
	if result == nil {
		return
	}
	metadata := buildDeployMetadata(result)
	// Defense-in-depth over the WHOLE assembled blob: even if buildDeployMetadata regresses
	// (a re-added top-level secret) or a new tofu output shape carries credential material,
	// scrubMetadataTree walks every nested key against the denylist and drops any match BEFORE
	// the metadata crosses into the console Postgres. A non-empty drop list means a regression
	// the backstop caught — surface it loudly in the job log.
	if dropped := scrubMetadataTree(metadata); len(dropped) > 0 {
		fmt.Fprintf(stderr, "Warning: dropped %d secret-bearing metadata key(s) before posting: %v\n", len(dropped), dropped)
	}
	if len(metadata) > 0 {
		_ = w.api.UpdateJobStatus(jobID, "PROCESSING", "", metadata)
	}
}

// buildDeployMetadata assembles the execution_metadata the runner persists to the console
// (Postgres) from a completed deploy's PlanResult. Extracted as a pure function so the
// secret-non-leakage regression test can assert directly on the persisted surface: the
// full cluster credentials (kubeconfigs / client keys) in `result.Outputs` are consumed
// in-process by the deploy pipeline, but only a SCRUBBED copy may cross into the console
// metadata (which lands in DB backups/replicas and is readable by cross-tenant support
// staff). See scrubSensitiveOutputs + docs/compliance/security-e2e-matrix.md (CC6.7).
//
// The ArgoCD admin password is intentionally NOT assembled here (and no longer exists on
// PlanResult): it is retrieved on-demand from the cluster's `argocd-initial-admin-secret`
// Secret, never stored as plaintext. The caller additionally runs scrubMetadataTree over the
// whole returned blob as a denylist backstop before posting.
func buildDeployMetadata(result *provisioner.PlanResult) map[string]any {
	metadata := map[string]any{}
	if result.ClusterName != "" {
		metadata["cluster_name"] = result.ClusterName
	}
	if result.ClusterEndpoint != "" {
		metadata["cluster_endpoint"] = result.ClusterEndpoint
	}
	if result.ClusterReady {
		// The reachability gate confirmed the API server answered + nodes are Ready —
		// "SUCCESS" means a working cluster, not just that `tofu apply` exited 0.
		metadata["cluster_ready"] = true
	}
	if result.ArgocdURL != "" {
		metadata["argocd_url"] = result.ArgocdURL
	}
	// NOTE: the ArgoCD admin password is deliberately never persisted — it is retrieved
	// on-demand from the cluster's argocd-initial-admin-secret. Re-adding a
	// metadata["argocd_admin_password"] = … line here is a secret leak; the whole-blob
	// scrubMetadataTree backstop + secret_nonleak_test guard against it.
	// Persist outputs to the console, but scrub credential-bearing outputs (full
	// kubeconfigs / client keys — e.g. Alibaba/Hetzner emit a cluster-admin `kubeconfig`)
	// so they never land in execution_metadata (console Postgres). The pipeline already
	// consumed the full outputs in-process above.
	if scrubbed := scrubSensitiveOutputs(result.Outputs); len(scrubbed) > 0 {
		metadata["outputs"] = scrubbed
	}
	if result.VerifyReport != nil {
		metadata["verify_result"] = result.VerifyReport
	}
	if result.VerifyReceipt != nil {
		metadata["verify_receipt"] = result.VerifyReceipt
	}
	if result.CompatReport != nil {
		metadata["compat_result"] = result.CompatReport
	}
	if len(result.AddOnStatus) > 0 {
		metadata["addon_status"] = result.AddOnStatus
	}
	if len(result.DataEndpoints) > 0 {
		// In-cluster data-service endpoints (Hetzner database/cache/queue). Carries the Service DNS
		// name + port + a credential REFERENCE ("<ns>/<secret>") — never a credential value, so the
		// A0.0 secret-scrub denylist has nothing to strip here (the #427 precedent).
		metadata["data_endpoints"] = result.DataEndpoints
	}
	if len(result.InfraServices) > 0 {
		// Honest per-cloud infra-service install/skip decisions (reasons + statuses).
		// Non-sensitive, safe to persist to the console alongside addon_status.
		metadata["infra_services"] = result.InfraServices
	}
	if len(result.KeylessBindings) > 0 {
		// Per-binding keyless DB-auth decisions (#1511): wired, or failed CLOSED with the cell's
		// reason. This is the ONLY positive trace keyless leaves — before it, a working keyless
		// binding recorded nothing at all, so "no warning" and "never attempted" were the same
		// observation. Names, a state and product copy; nothing for the metadata scrub to strip.
		metadata["keyless_bindings"] = result.KeylessBindings
	}
	if result.SecurityPosture != nil {
		metadata["security_report"] = result.SecurityPosture
	}
	if result.GitopsStatus != nil {
		// GitOps wiring outcome + apps-Application health snapshot (issue #574). On a
		// wiring hard-fail this is the only channel telling the console WHICH step died;
		// the error text is token-sanitized at the source (argocd.SanitizeGitopsError).
		metadata["gitops_status"] = result.GitopsStatus
	}
	return metadata
}

func (w *Runner) executePlan(ctx context.Context, job *Job, provider string, identity *CloudIdentity, connectorCreds []ConnectorCredential, stdout, stderr *JobLogger) error {
	vc, err := snapshotToProjectConfig(job.ConfigSnapshot)
	if err != nil {
		return fmt.Errorf("failed to parse config snapshot: %w", err)
	}
	if provider == "" {
		provider = string(vc.Provider)
	}
	if provider == "" {
		provider = "aws"
	}
	if identity != nil {
		vc.CloudAccountID = resolveAccountID(identity)
	}
	if vc.CloudAccountID == "" {
		vc.CloudAccountID = resolveAmbientAccountID(provider)
	}
	vc.ConnectorCredentials = toCoreConnectorCreds(connectorCreds)

	// E0 boundary: BYO IaC executes untrusted customer tofu — refuse on a managed runner
	// unless the egress-enforced container sandbox is active. Fail-closed, before any work.
	if err := w.byoManagedGate(vc, "PLAN"); err != nil {
		return err
	}

	infracostKey := os.Getenv("INFRACOST_API_KEY")

	planGitToken := vc.GitAccessToken
	if planGitToken == "" {
		if fetched, err := w.api.FetchGitToken(job.ID, ""); err != nil {
			fmt.Fprintf(stderr, "Warning: failed to fetch git token: %v\n", err)
		} else {
			planGitToken = fetched
		}
	}

	stateBackend, err := w.stateBackend(job.ID)
	if err != nil {
		return err
	}

	workDir, err := newJobWorkDir(job.ID)
	if err != nil {
		return fmt.Errorf("create workdir: %w", err)
	}
	defer os.RemoveAll(workDir)

	payload := buildDeployPayload(vc, provider, true, "",
		filepath.Join(resolveProjectTemplatesDir(), provider), resolveCategoriesTemplatesDir(),
		infracostKey, nil, nil, w.config.AlethiaURL, job.ID)
	stage, err := newStage(sandbox.StagePlan, payload)
	if err != nil {
		return err
	}
	sec := stageSecrets{GitToken: planGitToken, StateToken: stateBackend.Token}

	_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", map[string]any{
		"phase": "tofu_plan", "progress": "Running OpenTofu plan...",
	})

	// Run the untrusted plan through the isolation seam (Passthrough in-process / container re-exec).
	if err := w.sandbox.Run(ctx, sandbox.Spec{
		Kind: "plan", JobID: job.ID, Provider: provider, WorkDir: workDir, Stage: stage,
		Stdout: stdout, Stderr: stderr,
		Warn: func(s string) { fmt.Fprintln(stdout, "[sandbox] "+s) },
	}, func(ctx context.Context) error {
		return runDeployStage(ctx, payload, sec, workDir, stdout, stderr)
	}); err != nil {
		return err
	}

	result, err := readPlanResult(workDir)
	if err != nil {
		fmt.Fprintf(stderr, "Warning: could not read stage result: %v\n", err)
	}

	metadata := map[string]any{"plan_completed": true}
	if result != nil {
		if result.PlanJSON != nil {
			if rc, ok := result.PlanJSON["resource_changes"]; ok {
				metadata["plan_result"] = map[string]any{"resource_changes": rc}
			} else {
				fmt.Fprintln(stdout, "Warning: PlanJSON has no resource_changes key")
				metadata["plan_result"] = result.PlanJSON
			}
		} else {
			fmt.Fprintln(stdout, "Warning: PlanJSON is nil — tofu show may have failed")
		}
		if result.CostBreakdown != nil {
			metadata["cost_breakdown"] = result.CostBreakdown
			if result.CostBreakdown.Summary != nil {
				metadata["cost_summary"] = result.CostBreakdown.Summary
			}
		}
		if result.VerifyReport != nil {
			metadata["verify_result"] = result.VerifyReport
		}
		if result.VerifyReceipt != nil {
			metadata["verify_receipt"] = result.VerifyReceipt
		}
		if result.CompatReport != nil {
			metadata["compat_result"] = result.CompatReport
		}
	}

	if result != nil && len(result.PlanFileBytes) > 0 {
		tmpPlan := filepath.Join(os.TempDir(), fmt.Sprintf("plan-%s.out", job.ID))
		if err := utils.WriteSecretFile(tmpPlan, result.PlanFileBytes); err == nil {
			if uploadErr := w.api.UploadPlanArtifact(job.ID, tmpPlan); uploadErr != nil {
				fmt.Fprintf(stderr, "Warning: failed to upload plan artifact: %v\n", uploadErr)
			} else {
				fmt.Fprintln(stdout, "Plan artifact uploaded to storage.")
				metadata["plan_file_key"] = fmt.Sprintf("%s/tofu.plan.out", job.ID)
			}
			os.Remove(tmpPlan)
		}
	}

	_ = w.api.UpdateJobStatus(job.ID, "PROCESSING", "", metadata)

	return nil
}

func (w *Runner) executeDestroy(ctx context.Context, job *Job, provider string, identity *CloudIdentity, connectorCreds []ConnectorCredential, stdout, stderr *JobLogger) error {
	vc, err := snapshotToProjectConfig(job.ConfigSnapshot)
	if err != nil {
		return fmt.Errorf("failed to parse config snapshot: %w", err)
	}
	if provider == "" {
		provider = string(vc.Provider)
	}
	if provider == "" {
		provider = "aws"
	}
	if identity != nil {
		vc.CloudAccountID = resolveAccountID(identity)
	}
	if vc.CloudAccountID == "" {
		vc.CloudAccountID = resolveAmbientAccountID(provider)
	}
	vc.ConnectorCredentials = toCoreConnectorCreds(connectorCreds)

	// E0 boundary: BYO IaC executes untrusted customer tofu — refuse on a managed runner
	// unless the egress-enforced container sandbox is active. Fail-closed, before any work.
	if err := w.byoManagedGate(vc, "DESTROY"); err != nil {
		return err
	}

	stateBackend, err := w.stateBackend(job.ID)
	if err != nil {
		return err
	}

	workDir, err := newJobWorkDir(job.ID)
	if err != nil {
		return fmt.Errorf("create workdir: %w", err)
	}
	defer os.RemoveAll(workDir)

	payload := buildDestroyPayload(vc, provider,
		filepath.Join(resolveProjectTemplatesDir(), provider), resolveCategoriesTemplatesDir(),
		w.config.AlethiaURL, job.ID)
	stage, err := newStage(sandbox.StageDestroy, payload)
	if err != nil {
		return err
	}
	sec := stageSecrets{StateToken: stateBackend.Token}

	// Run the (untrusted-class, for BYO) teardown through the isolation seam, like
	// deploy/plan — Passthrough runs it in-process; the container backend re-execs it.
	if err := w.sandbox.Run(ctx, sandbox.Spec{
		Kind: "destroy", JobID: job.ID, Provider: provider, WorkDir: workDir, Stage: stage,
		Stdout: stdout, Stderr: stderr,
		Warn: func(s string) { fmt.Fprintln(stdout, "[sandbox] "+s) },
	}, func(ctx context.Context) error {
		return runDestroyStage(ctx, payload, sec, workDir, stdout, stderr)
	}); err != nil {
		return err
	}

	// Best-effort: purge the now-empty state object (tofu's http backend leaves it behind).
	if err := w.api.PurgeProjectState(job.ID, stateBackend.Token); err != nil {
		fmt.Fprintf(stderr, "Warning: failed to purge tofu state: %v\n", err)
	}
	return nil
}

func getSnapshotString(snapshot map[string]any, key string) string {
	if v, ok := snapshot[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// consoleOnlySnapshotKeys — keys the console writes onto a job's `config_snapshot` that
// types.ProjectConfig deliberately does NOT hold, keyed by the object path they appear at
// ("" is the snapshot root). Each row is a DECISION, not an accident: adding one requires a
// reason, because the alternative — the lenient decode this replaces — dropped console keys
// silently on every real deploy (#1962).
//
// The remedy for an unlisted key is almost always the OTHER one: give types.ProjectConfig the
// field. Only add a row here when the runner genuinely must not read the key.
var consoleOnlySnapshotKeys = map[string][]string{
	"": {
		// org_id — zero readers in either language. The runner's own Job struct (api.go) has no
		// OrgID field at all: tenancy travels on the `jobs.org_id` COLUMN, which the atomic claim
		// and the RLS policies use. Forensic only.
		"org_id",
		// slug — zero readers. It reached the snapshot through buildConfigSnapshot's `...project`
		// DB-row spread; the runner addresses a project by `id`, never by slug.
		"slug",
		// fabric_name — zero readers: `grep -rn "fabric_name\|FabricName" --include='*.go' .`
		// returns nothing. The per-Fabric tofu state is keyed on `fabric_id` (a UUID, regex
		// validated) and it is keyed in TYPESCRIPT — apps/console/lib/storage/tofu-state.ts,
		// `stateKeyForJob`, called by the state-token mint route. The runner never chooses the
		// state key. Go's only `fabric_id` use is TF_VAR_alethia_fabric_id on the BYO-IaC path.
		"fabric_name",
		// compat — the config-time compatibility report (#1218). Forensic only, by design: the
		// canvas re-runs the same pure engine client-side (apps/console/lib/compat/addon.ts) and
		// the apply gate re-evaluates independently in Go from the RESOLVED config
		// (packages/core/provisioner/deploy.go, `compat.Evaluate`). NOT to be confused with
		// `classification`, which IS a ProjectConfig field and IS consumed.
		"compat",
		// created_at / updated_at / estimated_monthly_cost — `projects` DB-row columns that the
		// old `...project` spread put on every production snapshot (they are absent from the
		// committed fixture only because its mocked row omits them). The console now emits an
		// explicit pick instead, so NEW snapshots do not carry them — but reconcile, drift, probe
		// and reap re-dispatch a STORED snapshot verbatim into a new job (lib/reconcile/reap.ts,
		// lib/drift/dispatch.ts, lib/probes/dispatch.ts), so a pre-pick snapshot keeps arriving
		// here indefinitely. Dropping these rows would fail those jobs.
		"created_at",
		"updated_at",
		"estimated_monthly_cost",
	},
	"cluster": {
		// cluster_endpoint — written by buildConfigSnapshot for the CONSOLE's day-2 surfaces. The
		// runner acquires kubeconfig from the provider by cluster NAME (ConfigureKubeconfig) and
		// reads an endpoint back out of `execution_metadata`, never off the snapshot.
		"cluster_endpoint",
	},
}

// legacyComponentBookkeepingKeys — the bookkeeping columns every `project_*` table carries.
// (Three tables have no `estimated_monthly_cost`; naming it for all ten is harmless, because
// trimming an absent key is a no-op, and it keeps this one list instead of ten near-copies.)
var legacyComponentBookkeepingKeys = []string{
	"id", "project_id", "environment_id",
	"status", "status_message", "estimated_monthly_cost",
	"created_at", "updated_at",
}

// legacyComponentRowKeys — per component list, the `project_*` DB-row columns that a PRE-#1974
// console spread into every element, keyed by the list's snapshot key.
//
// Until #1974 these ten lists were exempted from the check below wholesale (by a
// `dbRowSpreadSnapshotKeys` list), because `buildConfigSnapshot` spread whole DB rows (`...d`) into
// them, so every element was guaranteed to carry unknown keys. The console now emits an explicit
// pick — exactly the json tags of the matching struct in packages/core/types/project_config.go —
// so NEW snapshots carry none of these, and DisallowUnknownFields covers the component elements.
//
// The list survives for the same reason the root's `created_at`/`updated_at` row does: reconcile,
// drift, probe, reap and retry re-dispatch a STORED snapshot VERBATIM into a new job
// (apps/console/app/server/actions/reconcile.ts, canvas-jobs.ts, jobs.ts), so every project that
// has ever deployed has a pre-pick snapshot that keeps arriving here indefinitely. Dropping these
// would fail those jobs on the first drift run after this ships — an outage, not a migration.
//
// It is deliberately a CLOSED list of columns that existed at the time of the pick, not a blanket
// exemption: a NEW `project_*` column reaching the snapshot still fails here, which is the whole
// point of closing the spread.
var legacyComponentRowKeys = map[string][]string{
	// Write-back columns (filled by finalizeDeployment AFTER a deploy) and the Hetzner-only size
	// knobs, which reach the runner through `addons[]` rather than the component array.
	"databases": {"storage_gb", "replicas", "endpoint", "reader_endpoint", "provider_outputs"},
	"caches":    {"storage_gb", "endpoint", "reader_endpoint"},
	"queues":    {"storage_gb", "endpoint", "provider_outputs"},
	"topics":    {},
	// provider_config here has no producer AND no consumer (nosql does not route through
	// mergeProviderConfig).
	"nosql_tables": {"provider_config"},
	"secrets":      {},
	// repository_url has no writer anywhere: the runner resolves registry URLs from the tofu
	// output map at BUILD time.
	"container_registries": {"repository_url"},
	"helm_registries":      {},
	"storage_buckets":      {},
	"services":             {},
}

// assertNoUnknownSnapshotKeys fails when the console's config_snapshot carries a key that
// types.ProjectConfig has no field for and consoleOnlySnapshotKeys does not name. It strips the
// allowlisted paths from a COPY of the snapshot and then strict-decodes what is left, so the
// allowlist stays a written decision rather than an unstructured decoder error.
//
// Only "unknown field" is reported here; a type mismatch is left to the real decode below, which
// has always surfaced it, so this check adds exactly one new failure mode and no others.
func assertNoUnknownSnapshotKeys(snapshot map[string]any) error {
	checked := make(map[string]any, len(snapshot))
	for k, v := range snapshot {
		checked[k] = v
	}
	for path, keys := range consoleOnlySnapshotKeys {
		if path == "" {
			for _, k := range keys {
				delete(checked, k)
			}
			continue
		}
		nested, ok := checked[path].(map[string]any)
		if !ok {
			continue
		}
		trimmed := make(map[string]any, len(nested))
		for k, v := range nested {
			trimmed[k] = v
		}
		for _, k := range keys {
			delete(trimmed, k)
		}
		checked[path] = trimmed
	}
	// Component lists: trim the legacy DB-row columns off a COPY of each element, so a
	// re-dispatched pre-pick snapshot still decodes while a NEW unmodelled column still fails.
	for path, extra := range legacyComponentRowKeys {
		list, ok := checked[path].([]any)
		if !ok {
			continue
		}
		trimmedList := make([]any, len(list))
		for i, el := range list {
			row, ok := el.(map[string]any)
			if !ok {
				trimmedList[i] = el
				continue
			}
			trimmedRow := make(map[string]any, len(row))
			for k, v := range row {
				trimmedRow[k] = v
			}
			for _, k := range legacyComponentBookkeepingKeys {
				delete(trimmedRow, k)
			}
			for _, k := range extra {
				delete(trimmedRow, k)
			}
			trimmedList[i] = trimmedRow
		}
		checked[path] = trimmedList
	}

	data, err := json.Marshal(checked)
	if err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var probe types.ProjectConfig
	if err := dec.Decode(&probe); err != nil && strings.Contains(err.Error(), "unknown field") {
		return fmt.Errorf(
			"config_snapshot carries a key the runner contract does not model (%s). Either add the "+
				"field to types.ProjectConfig (packages/core/types/project_config.go), or — if the "+
				"runner genuinely must not read it — record it in consoleOnlySnapshotKeys "+
				"(apps/runner/internal/agent/runner.go) with the reason it stays console-only",
			err,
		)
	}
	return nil
}

// snapshotToProjectConfig decodes a job's frozen console `config_snapshot` into the runner's
// ProjectConfig contract, failing closed on any key the console writes that the contract has no
// field for and consoleOnlySnapshotKeys does not name (#1962).
func snapshotToProjectConfig(snapshot map[string]any) (*types.ProjectConfig, error) {
	if err := assertNoUnknownSnapshotKeys(snapshot); err != nil {
		return nil, err
	}

	data, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}

	var vc types.ProjectConfig
	if err := json.Unmarshal(data, &vc); err != nil {
		return nil, err
	}

	return &vc, nil
}

// resolveAccountID returns the provider-specific account identifier for an identity, or "" when
// the identity is nil (all current callers guard nil, but the guard keeps the helper safe for any
// future caller — #989).
func resolveAccountID(identity *CloudIdentity) string {
	if identity == nil {
		return ""
	}
	switch identity.Provider {
	case "gcp":
		return identity.ProjectID
	case "azure":
		return identity.SubscriptionID
	default:
		return identity.AccountID
	}
}

// resolveAmbientAccountID derives the provider account identifier from the ambient environment
// for a self-operator runner that has NO stored CloudIdentity (identity == nil) — a registered
// BYO runner authenticating from ambient cloud credentials, and the T2 real-cloud harness. It
// mirrors the ambient-CREDENTIAL path those same runners already use (AWS_*, GOOGLE_APPLICATION_
// CREDENTIALS, ARM_*): the account identifier is read from the well-known SDK/tooling env vars.
// Without it, ProviderTfvars emits an empty account/project/subscription, which breaks GCP (an
// empty project_id fails every module) and AWS account-scoped ARNs (IRSA, ECR, RDS-IAM, the
// DynamoDB assume-role). Returns "" when nothing is set, preserving prior behavior for callers
// that legitimately have no account (e.g. hetzner, which is account-less at the tofu layer).
func resolveAmbientAccountID(provider string) string {
	switch provider {
	case "gcp":
		for _, k := range []string{"GOOGLE_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT"} {
			if v := strings.TrimSpace(os.Getenv(k)); v != "" {
				return v
			}
		}
	case "azure":
		return strings.TrimSpace(os.Getenv("ARM_SUBSCRIPTION_ID"))
	case "aws":
		return strings.TrimSpace(os.Getenv("AWS_ACCOUNT_ID"))
	}
	return ""
}

// deployPhaseFile is the path RunDeployV2 writes the provisioning phase to (under the
// per-job workdir, so it survives the container-sandbox boundary). Kept in one place so
// the writer (stage.go → DeployParams.PhaseFile) and reader agree.
func deployPhaseFile(workDir string) string {
	return filepath.Join(workDir, "phase")
}

// shouldMarkOrphanRisk decides whether a mid-flight deploy interruption may have left orphaned
// cloud resources (state-mutating `tofu apply` had started but its state was never persisted).
// It is fail-safe: it flags orphan risk on ANY interruption at/after the apply phase, whether
// the interruption was an explicit user cancel (wasCancelled) or a non-cancel context
// cancellation (ctxErr != nil — the 2h jobCtx deadline or a shutdown-drain SIGTERM cancelling
// the root ctx). A pre-apply interruption (phase != "apply") never mutated cloud state, so it is
// not flagged.
//
// CORRECTION (issue #526). This comment used to end: "A plain apply failure leaves the context live
// (ctxErr == nil) and is NOT a cancel, so it stays unflagged — normal failures do not over-alert."
// The instinct was right but the conclusion was WRONG: a plain apply FAILURE can orphan a resource
// too. Clouds accept a create and then fail it asynchronously (capacity/quota/policy), so the
// resource exists while tofu never records it — and the environment is then PERMANENTLY WEDGED,
// every later apply dying with `already exists ... needs to be imported`. Reproduced on real Azure.
//
// The fix is NOT to flag every failure (that really would over-alert). It is to flag on POSITIVE
// EVIDENCE, which provisioner.ClassifyApplyError extracts from the provider's own error text and
// carries in a *provisioner.ApplyOrphanError. So a failed apply is now flagged iff it arrived with
// that evidence — see applyOrphanFinding below. An ordinary failure (validation, a quota rejection
// BEFORE create) still carries none, and is still not flagged.
func shouldMarkOrphanRisk(phase string, wasCancelled bool, ctxErr error) bool {
	if phase != "apply" {
		return false
	}
	return wasCancelled || ctxErr != nil
}

// applyOrphanFinding returns the orphan evidence a failed DEPLOY carried, if any.
//
// The deploy path wraps an apply failure in *provisioner.ApplyOrphanError ONLY when it has positive
// evidence that a cloud resource was left outside tofu state (issue #526). Lifting it here via
// errors.As — rather than re-parsing the error text at this layer — keeps the classification in one
// place and lets the terminal metadata name the exact resource, its cloud id and its tofu address,
// so the operator gets a diagnosis and an importable pair instead of an inscrutable failure.
func applyOrphanFinding(err error) (provisioner.OrphanFinding, bool) {
	var oe *provisioner.ApplyOrphanError
	if errors.As(err, &oe) {
		return oe.Finding, true
	}
	return provisioner.OrphanFinding{}, false
}

// readDeployPhase returns the provisioning phase RunDeployV2 recorded ("apply" once the
// state-mutating apply started), or "" if none was written (pre-apply, or a non-deploy stage).
func readDeployPhase(workDir string) string {
	b, err := os.ReadFile(deployPhaseFile(workDir))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// byoManagedGate is the E0 isolation boundary for bring-your-own IaC on a MANAGED-operator
// runner. BYO PLAN/DEPLOY/DESTROY/DETECT_DRIFT execute UNTRUSTED customer OpenTofu — an RCE
// surface: provider plugins run at init/validate/plan, and `local-exec`/`remote-exec`
// provisioners + `external` data sources run arbitrary commands. A managed runner federates
// into customer clouds AND sits in the platform account, so that untrusted code must NEVER
// run outside an egress-enforced container sandbox — otherwise it reaches 169.254.169.254
// and recovers the fleet's storage master key + bootstrap token (the metadata firehose).
//
// The gate has two separable halves:
//   - the "is this untrusted BYO?" decision (a non-nil IacSource) lives HERE, and
//   - the "managed requires an egress-enforced container" enforcement lives in
//     requireManagedContainerSandbox, so the SAME enforcement can be applied by callers
//     whose job is untrusted-BYO by definition and carries no ProjectConfig (IAC_SCAN).
//
// SELF operators run BYO IaC in the customer's OWN cloud with their own creds — their risk
// boundary — so they are always allowed. A nil IacSource (trusted Alethia templates) is
// unaffected. When the gate PASSES, the untrusted work still runs THROUGH the container
// sandbox (the deploy/plan/destroy/drift paths all call w.sandbox.Run) — the gate guarantees
// that backend is the active one, so managed BYO IaC can never execute outside the container.
func (w *Runner) byoManagedGate(vc *types.ProjectConfig, kind string) error {
	if vc == nil || vc.IacSource == nil {
		return nil // trusted (non-BYO) template path — unaffected
	}
	return w.requireManagedContainerSandbox(kind)
}

// requireManagedContainerSandbox is the enforcement half of the E0 boundary: it refuses to
// run untrusted BYO work unless the runner is an explicit SELF operator OR the egress-enforced
// container sandbox is active with managed-enforcement on. It presumes the caller has already
// established the work is untrusted BYO — byoManagedGate calls it only when IacSource != nil,
// and executeIacScan calls it UNCONDITIONALLY (an IAC_SCAN is untrusted BYO by definition).
//
// It is FAIL-CLOSED. Work is allowed ONLY when either:
//   - w.config.Operator == "self" — the customer's OWN cloud + creds are their risk boundary; OR
//   - all of: the active backend is the Container backend (ALETHIA_SANDBOX_BACKEND=container),
//     that backend confirms egress enforcement (EgressEnforced, from
//     ALETHIA_SANDBOX_EGRESS_ENFORCED=1 — default-deny net + IMDS block + squid allowlist), AND
//     ALETHIA_SANDBOX_ENFORCE_MANAGED=1 (the post-canary managed-enforcement flip, which the
//     maintainer sets fleet-wide AFTER the real-VM 3b canary; see memory e0-isolation-runtime).
//
// Crucially only an EXPLICIT "self" operator takes the allow path — an empty/miscased/unknown
// operator string ("", "Managed", typo) is treated as managed-strict and MUST pass through the
// container requirement, so a mis-set operator can never fail OPEN into unsandboxed execution.
func (w *Runner) requireManagedContainerSandbox(kind string) error {
	if w.config.Operator == "self" {
		return nil // self operator: customer's own cloud + creds = their risk boundary
	}
	c, ok := w.sandbox.(sandbox.Container)
	if ok && c.EgressEnforced && envTrue("ALETHIA_SANDBOX_ENFORCE_MANAGED") {
		return nil // egress-enforced container sandbox is active + managed-enforcement on
	}
	return fmt.Errorf(
		"refusing to run bring-your-own IaC %s on a managed runner without the egress-enforced container sandbox: "+
			"this executes untrusted customer OpenTofu (provider plugins + provisioners run arbitrary code) and is only "+
			"permitted inside the E0 isolation boundary — set ALETHIA_SANDBOX_BACKEND=container, "+
			"ALETHIA_SANDBOX_EGRESS_ENFORCED=1 and ALETHIA_SANDBOX_ENFORCE_MANAGED=1 on the managed fleet (post 3b canary)",
		kind)
}

// envTrue reports whether an env var is set to a truthy value (1/true/yes/on).
func envTrue(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
