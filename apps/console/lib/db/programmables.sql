-- Programmables: least-privilege app role + grants, updated_at
-- triggers, the SECURITY DEFINER queue RPCs (token-hash authed; on the renamed
-- jobs/runners tables), and the per-owner RLS backstop. Idempotent — applied via
-- the migrate runner's .unsafe() after the schema migration. Runs as superuser.

-- ── App role (RLS-enforced). Password set by the migrate runner from env. ──
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alethia_app') THEN
    CREATE ROLE alethia_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO alethia_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO alethia_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO alethia_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO alethia_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO alethia_app;

-- ── updated_at trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'projects', 'project_environments', 'project_fabrics', 'project_preview_config', 'project_network', 'project_cluster', 'project_dns',
    'project_repositories', 'project_databases', 'project_caches', 'project_queues', 'project_topics',
    'project_nosql_tables', 'project_container_registries', 'project_helm_registries', 'project_secrets',
    'project_storage_buckets', 'project_chart_workloads', 'jobs',
    'environment_protection_rules', 'environment_promotions',
    'support_cases'
  ]) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_updated_at ON public.%1$I', tbl);
    EXECUTE format(
      'CREATE TRIGGER %1$s_updated_at BEFORE UPDATE ON public.%1$I
         FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()', tbl);
  END LOOP;
END $$;

-- Projects are top-level; an earlier per-job consistency trigger + its function are
-- dropped by migration. Jobs scope by org_id.
DROP TRIGGER IF EXISTS jobs_sync_zone ON public.jobs;
DROP FUNCTION IF EXISTS public.jobs_sync_zone();

-- ── Push dispatch: wake runners the instant a job becomes claimable, instead of
-- waiting on their poll. Fires on insert and on requeue (status→QUEUED, e.g.
-- recover_stale_jobs). Payload carries identifiers only; connected runners react by
-- calling claim_next_job (FOR UPDATE SKIP LOCKED dedupes the race). ──
CREATE OR REPLACE FUNCTION public.notify_runner_wake()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('runner_wake', json_build_object(
    'job_id', NEW.id,
    'cloud_identity_id', NEW.cloud_identity_id,
    'assigned_runner_id', NEW.assigned_runner_id
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_runner_wake ON public.jobs;
CREATE TRIGGER jobs_runner_wake
  AFTER INSERT OR UPDATE OF status ON public.jobs
  FOR EACH ROW WHEN (NEW.status = 'QUEUED')
  EXECUTE FUNCTION public.notify_runner_wake();

-- ── Queue RPCs (SECURITY DEFINER, token-hash authed). On the renamed
-- jobs/runners tables; runner_id is clean uuid (no ::text casts). ──
-- ── Scheduler quotas (ADR 20). Plan → {priority band, concurrency cap}, read from
-- organization_billing with community as the fallback (no row, or status not live).
-- Authoritative in SQL so claim_next_job enforces them atomically. ──
CREATE OR REPLACE FUNCTION public.org_effective_plan(p_org_id uuid)
RETURNS public.billing_plan LANGUAGE plpgsql STABLE AS $$
DECLARE v public.billing_plan;
BEGIN
  SELECT CASE WHEN ob.status IN ('active', 'trialing') THEN ob.plan
              ELSE 'community'::public.billing_plan END
    INTO v FROM public.organization_billing ob WHERE ob.organization_id = p_org_id;
  RETURN COALESCE(v, 'community'::public.billing_plan);
END;
$$;

CREATE OR REPLACE FUNCTION public.plan_priority(p public.billing_plan)
RETURNS smallint LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE p WHEN 'enterprise' THEN 30
                 WHEN 'team' THEN 10 ELSE 0 END)::smallint;
$$;

-- NULL = unlimited.
CREATE OR REPLACE FUNCTION public.plan_max_concurrency(p public.billing_plan)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'enterprise' THEN NULL
                WHEN 'team' THEN 8 ELSE 2 END;
$$;

-- Interactive job types jump ahead of batch ones, within the plan band (gap = 10).
CREATE OR REPLACE FUNCTION public.jobtype_priority_bump(jt public.provision_job_type)
RETURNS smallint LANGUAGE sql IMMUTABLE AS $$
  SELECT (CASE jt
    WHEN 'PLAN' THEN 3
    WHEN 'DEPLOY_RUNNER' THEN 2
    WHEN 'UPDATE_RUNNER' THEN 2
    WHEN 'DESTROY_RUNNER' THEN 2
    ELSE 0 END)::smallint;
$$;

-- An org's in-flight jobs on the SHARED managed pool (the cap + fairness metric).
CREATE OR REPLACE FUNCTION public.org_managed_inflight(p_org_id uuid)
RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT count(*)::int FROM public.jobs k
  JOIN public.runners r ON r.id = k.runner_id
  WHERE k.org_id = p_org_id
    AND k.status IN ('CLAIMED', 'PROCESSING')
    AND r.operator = 'managed';
$$;

-- Derive provider (denormalized) + priority at insert. Named to fire AFTER
-- jobs_set_org_id (alpha order), so NEW.org_id is populated.
CREATE OR REPLACE FUNCTION public.jobs_set_scheduling()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.provider IS NULL AND NEW.cloud_identity_id IS NOT NULL THEN
    SELECT ci.provider INTO NEW.provider
    FROM public.cloud_identities ci WHERE ci.id = NEW.cloud_identity_id;
  END IF;
  NEW.priority := public.plan_priority(public.org_effective_plan(NEW.org_id))
                  + public.jobtype_priority_bump(NEW.job_type);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_set_scheduling ON public.jobs;
CREATE TRIGGER jobs_set_scheduling BEFORE INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_set_scheduling();

-- Backfill provider on existing rows (idempotent; old jobs are mostly terminal).
UPDATE public.jobs j SET provider = ci.provider
FROM public.cloud_identities ci
WHERE j.cloud_identity_id = ci.id AND j.provider IS NULL;

-- TRUE iff another job currently holds the tofu state lock for this (project, environment) — i.e. a
-- live writer is mid-plan/apply/destroy on the very state file the candidate job would open.
--
-- Concurrency in this system was capped PER ORG, never per state object. Nothing stopped two jobs on
-- the SAME (project, environment) running at once, and the second one to reach tofu simply died on
-- "state already locked" — noisy but survivable — until the pair was an apply and a destroy. Observed
-- for real: a DESTROY was claimed while its own env's apply was still building, the destroy failed on
-- the lock, and the server the apply had already created was left billing outside any state file.
-- Concurrency limits are a fairness knob; THIS is the correctness one. Serialize on the object.
--
-- The holder's identity comes from the lock's job_id — joined back to its project/environment — so the
-- state-key format lives in exactly one place (lib/storage/tofu-state.ts) and cannot drift from a
-- string re-derived here.
--
-- A held lock now reliably means a LIVE writer: release_tofu_state_locks_for_job frees it the moment
-- the runner reports terminal (tofu has exited), so a killed apply no longer strands its lock for the
-- full 3h TTL. Without that release this guard would be a deadlock — a stranded lock would block the
-- very DESTROY sent to clean it up. The TTL and the break-glass force-release remain the backstops.
--
-- Scoped to project/environment jobs. Runner-lifecycle jobs (DEPLOY_RUNNER/DESTROY_RUNNER) key their
-- state on the target runner and carry NULL project/environment; they are not serialized here, and a
-- NULL is never treated as "matching" another NULL.
DROP FUNCTION IF EXISTS public.state_object_busy(UUID, UUID, UUID);
CREATE OR REPLACE FUNCTION public.state_object_busy(
    p_project_id UUID, p_environment_id UUID, p_job_id UUID
) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT p_project_id IS NOT NULL AND p_environment_id IS NOT NULL AND EXISTS (
        SELECT 1
          FROM public.tofu_state_locks l
          JOIN public.jobs hj ON hj.id = l.job_id
         WHERE l.expires_at > now()
           AND l.job_id <> p_job_id
           AND hj.project_id = p_project_id
           AND hj.environment_id = p_environment_id
    );
$$;

CREATE OR REPLACE FUNCTION public.claim_next_job(
    p_runner_id UUID, p_runner_token_hash TEXT, p_cloud_identity_id UUID DEFAULT NULL
) RETURNS SETOF public.jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_job_id UUID;
    v_org UUID;
    v_operator public.runner_operator;
    v_providers public.cloud_provider[];
    v_status public.runner_status;
    v_runner_org_id UUID;
    v_runner_user_id UUID;
BEGIN
    SELECT operator, supported_providers, status, org_id, user_id
      INTO v_operator, v_providers, v_status, v_runner_org_id, v_runner_user_id
      FROM public.runners
      WHERE id = p_runner_id AND token_hash = p_runner_token_hash;
    IF v_operator IS NULL THEN
        RAISE EXCEPTION 'Unauthorized runner';
    END IF;
    -- A DRAINING runner (being retired by the fleet controller for a version roll or
    -- scale-down) claims nothing — it finishes its current job, goes idle, gets reaped.
    -- Return before the ONLINE refresh so the drain isn't undone.
    IF v_status = 'DRAINING' THEN
        RETURN;
    END IF;
    UPDATE public.runners SET last_heartbeat = now(), status = 'ONLINE'::public.runner_status WHERE id = p_runner_id;
    PERFORM public.open_runner_session(p_runner_id);

    -- Phase A: jobs explicitly assigned to this runner — highest precedence, priority-ordered.
    -- Even an EXPLICIT assignment must respect org boundaries for a self runner: assigned_runner_id
    -- is set from a caller-supplied value at enqueue (projects.ts / the DESTROY_RUNNER route) and is
    -- NOT validated to be same-org, so a user authorized on org X's project could queue an org-X job
    -- (carrying org X's decrypted cloud_identity) bound to a self runner they own in another org.
    -- The (managed OR same-org) guard is the fail-closed backstop: managed runners legitimately serve
    -- every org (org_id NULL, shared pool); a self runner may only take an assigned job in its OWN org.
    UPDATE public.jobs
    SET status = 'CLAIMED', runner_id = p_runner_id, claimed_at = now(), progress_at = now(), updated_at = now()
    WHERE id = (
        SELECT j.id FROM public.jobs j
        WHERE j.status = 'QUEUED' AND j.assigned_runner_id = p_runner_id
          AND (
            v_operator = 'managed'
            OR j.org_id = v_runner_org_id
            -- Pre-#3874 CLI runners were stamped into their owner's personal org.
            -- Admit only that exact legacy shape, only for lifecycle work created by
            -- the owner. The job remains in its active tenant for quota, visibility,
            -- evidence and serialization; arbitrary cross-tenant work stays closed.
            OR (
              v_operator = 'self'
              AND v_runner_org_id = v_runner_user_id
              AND j.user_id = v_runner_user_id
              AND j.job_type IN ('DEPLOY_RUNNER', 'UPDATE_RUNNER', 'DESTROY_RUNNER')
            )
          )
          -- Never open a state file another job is actively writing (see state_object_busy).
          AND NOT public.state_object_busy(j.project_id, j.environment_id, j.id)
        ORDER BY j.priority DESC, j.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    ) RETURNING id INTO v_job_id;

    -- Phase B: unassigned jobs.
    IF v_job_id IS NULL THEN
        IF v_operator = 'managed' THEN
            -- Shared pool: priority, then fair across orgs (fewest in-flight), then
            -- oldest; skip orgs already at their plan concurrency cap.
            --
            -- TOCTOU FIX: the cap gate below (org_managed_inflight < plan_max_concurrency)
            -- counts CLAIMED/PROCESSING rows, but FOR UPDATE SKIP LOCKED locks only the
            -- candidate JOB row, not the org's in-flight set. Under READ COMMITTED a concurrent
            -- claimer's not-yet-committed CLAIMED row is invisible to that count, and the
            -- broadcast wake (jobs_runner_wake -> /api/runners/wake fan-out to the whole pool)
            -- makes N managed runners fire claim within milliseconds -- so without serialization
            -- every claimer snapshots inflight < cap and admits, blowing past the per-org cap.
            --
            -- Admission is serialized PER ORG with a transaction-scoped advisory lock, and the
            -- cap re-verified while holding it. The winning org isn't known until the fairness
            -- SELECT runs, so: (1) pick + row-lock the candidate (FOR UPDATE SKIP LOCKED),
            -- (2) take the org-keyed advisory lock, (3) re-check the cap, (4) claim. A concurrent
            -- same-org claimer blocks at (2) until we COMMIT, at which point our CLAIMED row is
            -- visible to its recount -- so the re-check is authoritative (a plain post-UPDATE
            -- recheck WITHOUT this lock would NOT close the race: the uncommitted row stays
            -- invisible under READ COMMITTED). The key is per-org (hashtext of org_id), so
            -- different orgs never contend the same lock -- no cross-org serialization. Lock
            -- ordering is always candidate-row-lock then org-advisory-lock (single key per claim),
            -- so no deadlock; the xact-scoped lock releases when this one-statement claim commits.
            SELECT j.id, j.org_id INTO v_job_id, v_org
              FROM public.jobs j
              WHERE j.status = 'QUEUED' AND j.assigned_runner_id IS NULL
                -- Self-managed token clouds: only the customer's self-hosted runner
                -- has the credential. A managed runner must never claim these.
                AND j.requires_self_runner = false
                AND (p_cloud_identity_id IS NULL OR j.cloud_identity_id = p_cloud_identity_id)
                AND (v_providers IS NULL OR j.provider IS NULL OR j.provider = ANY(v_providers))
                -- Never open a state file another job is actively writing (see state_object_busy).
                -- The per-org cap below is a FAIRNESS knob and does not imply this: two jobs on one
                -- (project, environment) are well within any cap, and that is exactly the pair that
                -- corrupts — an apply and the destroy racing it.
                AND NOT public.state_object_busy(j.project_id, j.environment_id, j.id)
                AND (
                  public.plan_max_concurrency(public.org_effective_plan(j.org_id)) IS NULL
                  OR public.org_managed_inflight(j.org_id)
                     < public.plan_max_concurrency(public.org_effective_plan(j.org_id))
                )
              ORDER BY j.priority DESC, public.org_managed_inflight(j.org_id) ASC, j.created_at ASC
              LIMIT 1 FOR UPDATE SKIP LOCKED;

            IF v_job_id IS NOT NULL THEN
                -- Serialize same-org admission, then re-verify the cap under the lock.
                PERFORM pg_advisory_xact_lock(hashtext('alethia:claim:managed:' || v_org::text)::bigint);
                IF (
                     public.plan_max_concurrency(public.org_effective_plan(v_org)) IS NULL
                     OR public.org_managed_inflight(v_org)
                        < public.plan_max_concurrency(public.org_effective_plan(v_org))
                   ) THEN
                    UPDATE public.jobs
                    SET status = 'CLAIMED', runner_id = p_runner_id, claimed_at = now(),
                        progress_at = now(), updated_at = now()
                    WHERE id = v_job_id;
                ELSE
                    -- Org filled to its cap between the SELECT and acquiring the lock: do not
                    -- claim. The candidate stays QUEUED (its row lock releases at commit); the
                    -- broadcast wake / next poll re-offers it once an in-flight job finishes.
                    v_job_id := NULL;
                END IF;
            END IF;
        ELSE
            -- Self/dedicated runner: STRICTLY its own org's jobs; priority then oldest, uncapped.
            -- The org_id predicate is the cross-tenant guard: without it a self runner
            -- registered with cloud_identity_id omitted and supported_providers unset makes the
            -- cloud_identity/provider filters vacuously true and would claim ANY org's QUEUED job,
            -- leaking that job's decrypted cloud credential to the wrong tenant's runner. A self
            -- runner always has user_id NOT NULL, so runners.org_id backfills (set_org_id trigger)
            -- and is reliably non-null; if it were ever NULL, j.org_id = NULL matches nothing
            -- (fail-closed). Managed runners (org_id NULL, shared pool) must NOT take this branch.
            UPDATE public.jobs
            SET status = 'CLAIMED', runner_id = p_runner_id, claimed_at = now(), progress_at = now(), updated_at = now()
            WHERE id = (
                SELECT j.id FROM public.jobs j
                WHERE j.status = 'QUEUED' AND j.assigned_runner_id IS NULL
                  AND (
                    j.org_id = v_runner_org_id
                    OR (
                      v_runner_org_id = v_runner_user_id
                      AND j.user_id = v_runner_user_id
                      AND j.job_type IN ('DEPLOY_RUNNER', 'UPDATE_RUNNER', 'DESTROY_RUNNER')
                    )
                  )
                  AND (p_cloud_identity_id IS NULL OR j.cloud_identity_id = p_cloud_identity_id)
                  AND (v_providers IS NULL OR j.provider IS NULL OR j.provider = ANY(v_providers))
                  -- Never open a state file another job is actively writing (see state_object_busy).
                  -- Self runners are UNCAPPED, so nothing else here bounds concurrency on one state.
                  AND NOT public.state_object_busy(j.project_id, j.environment_id, j.id)
                ORDER BY j.priority DESC, j.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
            ) RETURNING id INTO v_job_id;
        END IF;
    END IF;

    IF v_job_id IS NULL THEN RETURN; END IF;
    RETURN QUERY SELECT * FROM public.jobs WHERE id = v_job_id;
END;
$$;

-- Recovers stale in-flight jobs, now with a poison-job cap + a progress-stall path. Two staleness
-- signals, evaluated in ONE atomic UPDATE (so the attempts increment can't race a concurrent claim —
-- claim_next_job only touches QUEUED rows FOR UPDATE SKIP LOCKED, and a plain UPDATE row-locks the
-- CLAIMED/PROCESSING rows it matches; a racing second recovery re-checks the WHERE and no-ops):
--
--   (A) DEAD RUNNER (liveness): claimed > 15 min ago AND the runner isn't heartbeating (no
--       last_heartbeat within 5 min, or no runner). The original behaviour.
--   (B) STALLED-BUT-ALIVE (progress): the runner IS heartbeating (alive within 5 min) but has made
--       no real progress for a long time (progress_at older than the 30-min stall threshold — set at
--       claim, refreshed on every stage transition + log flush). A hung-mid-apply runner that the
--       liveness check can never catch. The threshold is deliberately generous and DISTINCT from the
--       5-min liveness window: a live tofu apply prints "Still creating… [Ns elapsed]" every ~10s, so
--       progress_at refreshes constantly — only genuine multi-minute silence trips (B).
--
-- Each recovery INCREMENTS attempts. Below the cap the job is requeued (QUEUED, runner cleared).
-- At the cap (attempts >= max_attempts) it is failed TERMINAL (FAILED + a clear error_message)
-- instead of requeued forever. The function RETURNS the jobs it failed terminally so the caller
-- (lib/jobs/recovery.ts) can drive each one's environment status through the env-status CAS
-- (deployFailed / destroyFailed / planFailed) — a terminal job must not leave its env stuck.
-- Return type changed INTEGER -> TABLE(...): Postgres can't change a function's return type via
-- CREATE OR REPLACE on an existing DB (error 42P13), so drop the old signature first — same pattern as
-- update_job_status / sweep_offline_runners above. IF EXISTS keeps it idempotent on a fresh DB.
DROP FUNCTION IF EXISTS public.recover_stale_jobs();
CREATE OR REPLACE FUNCTION public.recover_stale_jobs()
RETURNS TABLE(job_id UUID, job_type public.provision_job_type, environment_id UUID, org_id UUID, project_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    RETURN QUERY
    WITH updated AS (
        UPDATE public.jobs j
        SET attempts = j.attempts + 1,
            -- At/over the cap → terminal FAILED; otherwise requeue.
            status = CASE WHEN j.attempts + 1 >= j.max_attempts
                          THEN 'FAILED'::public.provision_job_status
                          ELSE 'QUEUED'::public.provision_job_status END,
            -- Requeue clears the claim; a terminal fail keeps runner_id/claimed_at for forensics.
            runner_id  = CASE WHEN j.attempts + 1 >= j.max_attempts THEN j.runner_id  ELSE NULL END,
            claimed_at = CASE WHEN j.attempts + 1 >= j.max_attempts THEN j.claimed_at ELSE NULL END,
            started_at = CASE WHEN j.attempts + 1 >= j.max_attempts THEN j.started_at ELSE NULL END,
            completed_at = CASE WHEN j.attempts + 1 >= j.max_attempts THEN now() ELSE j.completed_at END,
            error_message = CASE WHEN j.attempts + 1 >= j.max_attempts
                THEN 'Job exceeded max attempts (' || j.max_attempts
                     || '): its runner repeatedly died or stalled mid-run. Failed terminally by the '
                     || 'poison-job cap to protect the queue.'
                ELSE j.error_message END,
            updated_at = now()
        WHERE j.status IN ('CLAIMED', 'PROCESSING')
          AND (
            -- (A) dead-runner liveness
            ( j.claimed_at < now() - INTERVAL '15 minutes'
              AND (j.runner_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM public.runners r
                WHERE r.id = j.runner_id AND r.last_heartbeat > now() - INTERVAL '5 minutes')) )
            OR
            -- (B) stalled-but-alive: runner heartbeating, but no forward progress for the stall window
            ( j.runner_id IS NOT NULL
              AND j.progress_at IS NOT NULL
              AND j.progress_at < now() - INTERVAL '30 minutes'
              AND EXISTS (
                SELECT 1 FROM public.runners r
                WHERE r.id = j.runner_id AND r.last_heartbeat > now() - INTERVAL '5 minutes') )
          )
        RETURNING j.id, j.job_type, j.environment_id, j.org_id, j.project_id,
                  (j.status = 'FAILED') AS terminal
    )
    -- Only the terminally-failed jobs need an env-status transition; requeued ones keep their env.
    SELECT u.id, u.job_type, u.environment_id, u.org_id, u.project_id
    FROM updated u
    WHERE u.terminal;
END;
$$;

-- Connection verification is server-side + instant now (no CONNECTION_TEST job), so the old
-- stuck-connection-test sweeper is retired. Drop it from any DB that still has it.
DROP FUNCTION IF EXISTS public.fail_unclaimed_connection_tests(INTERVAL, INTERVAL);

-- Garbage-collect never-saved pending identities. initIdentity() seeds one row per
-- connect-sheet open; abandoned flows leave 'pending' rows forever. Deletes only
-- pending rows that aged out and have NO job at all (a never-saved identity has none);
-- never touches testing/failed/connected. jobs.cloud_identity_id is ON DELETE SET NULL.
DROP FUNCTION IF EXISTS public.gc_pending_identities(INTERVAL);
CREATE OR REPLACE FUNCTION public.gc_pending_identities(p_age INTERVAL DEFAULT INTERVAL '24 hours')
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
    DELETE FROM public.cloud_identities ci
    WHERE ci.status = 'pending'
      AND ci.is_verified = false
      AND ci.updated_at < now() - p_age
      AND NOT EXISTS (
        SELECT 1 FROM public.jobs j WHERE j.cloud_identity_id = ci.id
      );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Drop the pre-traceparent 5-arg signature so adding the optional p_traceparent
-- param (a new 6-arg overload) doesn't leave an ambiguous stale function behind.
DROP FUNCTION IF EXISTS public.insert_job_log(UUID, TEXT, UUID, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.insert_job_log(
    p_runner_id UUID, p_runner_token_hash TEXT, p_job_id UUID, p_log_chunk TEXT,
    p_stream_type TEXT DEFAULT 'STDOUT', p_traceparent TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_log_id BIGINT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.runners WHERE id = p_runner_id AND token_hash = p_runner_token_hash) THEN
        RAISE EXCEPTION 'Unauthorized runner';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job_id AND runner_id = p_runner_id) THEN
        RAISE EXCEPTION 'Job not owned by this runner';
    END IF;
    -- Carry the trace on the log line. Fall back to the job's own traceparent when the
    -- runner didn't supply one, so a log always correlates to its trace.
    INSERT INTO public.job_logs (job_id, log_chunk, stream_type, traceparent)
    VALUES (p_job_id, p_log_chunk, p_stream_type::public.log_stream_type,
            COALESCE(p_traceparent, (SELECT traceparent FROM public.jobs WHERE id = p_job_id)))
    RETURNING id INTO v_log_id;
    -- Notify SSE listeners (one LISTEN conn per app instance fans out). IDs only
    -- (8 KB payload cap); the stream route fetches rows since its last seen id.
    PERFORM pg_notify('job_logs', json_build_object('jobId', p_job_id, 'logId', v_log_id)::text);
    -- Progress heartbeat: a log flush is real forward progress. Stamp progress_at so the
    -- stalled-but-alive detector resets — but THROTTLE the write to ≤ once/minute per job so a
    -- chatty apply (log chunks every ~1s) doesn't bloat the jobs row. Minute granularity is ample
    -- against the 30-min stall threshold.
    UPDATE public.jobs
    SET progress_at = now()
    WHERE id = p_job_id
      AND (progress_at IS NULL OR progress_at < now() - INTERVAL '55 seconds');
END;
$$;

-- Return type changed VOID -> BOOLEAN (terminal-state guard). Postgres can't change a function's
-- return type via CREATE OR REPLACE (error 42P13), so drop the old signature first on an existing
-- DB — same as insert_job_log above. IF EXISTS keeps it idempotent on a fresh DB.
DROP FUNCTION IF EXISTS public.update_job_status(UUID, TEXT, UUID, TEXT, TEXT, JSONB);
CREATE OR REPLACE FUNCTION public.update_job_status(
    p_runner_id UUID, p_runner_token_hash TEXT, p_job_id UUID, p_status TEXT,
    p_error_message TEXT DEFAULT NULL, p_execution_metadata JSONB DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status public.provision_job_status;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.runners WHERE id = p_runner_id AND token_hash = p_runner_token_hash) THEN
        RAISE EXCEPTION 'Unauthorized runner';
    END IF;
    -- Terminal-state guard: never CHANGE an already-terminal status to a DIFFERENT one. This makes a
    -- CANCELLED job STICK — if the console cancelled it (cancelJob) but the pg_notify cancel didn't
    -- reach the runner (wake SSE down) and it ran to completion, the runner's late SUCCESS/FAILED must
    -- NOT revert CANCELLED. A SAME-status re-post IS allowed, so the runner's second CANCELLED post
    -- (which cancelJob's flip precedes) still merges its orphan_risk metadata. Returns whether a row
    -- moved: FALSE = the update was a no-op on an already-terminal job, so the caller must skip the
    -- terminal side-effects (billing / success alert / env→ACTIVE) for that stale callback.
    UPDATE public.jobs
    SET status = p_status::public.provision_job_status,
        error_message = COALESCE(p_error_message, error_message),
        execution_metadata = CASE WHEN p_execution_metadata IS NOT NULL
            THEN COALESCE(execution_metadata, '{}'::jsonb) || p_execution_metadata ELSE execution_metadata END,
        started_at = CASE WHEN p_status = 'PROCESSING' AND started_at IS NULL THEN now() ELSE started_at END,
        -- Progress heartbeat: a status post to PROCESSING is a stage transition = real forward
        -- progress. Stamp progress_at so the stalled-but-alive detector (recover_stale_jobs) resets.
        progress_at = CASE WHEN p_status = 'PROCESSING' THEN now() ELSE progress_at END,
        completed_at = CASE WHEN p_status IN ('SUCCESS', 'FAILED', 'CANCELLED') THEN now() ELSE completed_at END,
        updated_at = now()
    WHERE id = p_job_id AND runner_id = p_runner_id
      AND (status NOT IN ('SUCCESS', 'FAILED', 'CANCELLED')
           OR status = p_status::public.provision_job_status);
    IF FOUND THEN RETURN true; END IF;
    -- Not applied. Distinguish a benign already-terminal job (owned by this runner, the guard blocked
    -- a status CHANGE) from a genuine ownership/existence error. The former returns false (the caller
    -- skips side-effects; the runner learns the job is terminal on its next heartbeat); only the
    -- latter raises.
    SELECT status INTO v_status FROM public.jobs WHERE id = p_job_id AND runner_id = p_runner_id;
    IF v_status IS NOT NULL THEN
        -- The status CHANGE is rightly refused (CANCELLED must stick) — but the runner's REPORT must not
        -- die with it. The guard rejects the whole UPDATE row, execution_metadata INCLUDED: a runner that
        -- never received the cancel and ran the apply out posts SUCCESS/FAILED (a DIFFERENT status), and
        -- its entire account of what it built was silently discarded. Observed for real: a cancelled apply
        -- left execution_metadata NULL, so orphan_risk could never land — and a control-plane server it
        -- had already created billed on, unseen, outside tofu state. Record it out-of-band instead.
        --
        -- CANCELLED + the runner reporting a terminal outcome anyway IS the orphan signature, and the one
        -- the control plane can always see: the runner's own orphan_risk flag only fires when it RECEIVED
        -- the cancel, which in the real incident it never did. Flag it here, where the contradiction is
        -- knowable — cloud resources may exist that no state file and no cluster row records.
        --
        -- Side-effects stay skipped (the caller keys those off the FALSE return) and the DB status stays
        -- authoritative. Only the evidence survives.
        UPDATE public.jobs
        SET execution_metadata = COALESCE(execution_metadata, '{}'::jsonb)
                || COALESCE(p_execution_metadata, '{}'::jsonb)
                || jsonb_build_object('late_report', jsonb_build_object(
                       'status', p_status,
                       'error_message', p_error_message,
                       'reported_at', now()
                   ))
                || CASE
                     WHEN v_status = 'CANCELLED' AND p_status IN ('SUCCESS', 'FAILED')
                     THEN jsonb_build_object('orphan_risk', true, 'orphan_reason', 'ran_to_completion_after_cancel')
                     ELSE '{}'::jsonb
                   END,
            updated_at = now()
        WHERE id = p_job_id AND runner_id = p_runner_id;
        RETURN false;
    END IF;
    RAISE EXCEPTION 'Job not found or not owned by this runner';
END;
$$;

CREATE OR REPLACE FUNCTION public.runner_heartbeat(
    p_runner_id UUID, p_runner_token_hash TEXT, p_version TEXT DEFAULT NULL,
    p_providers public.cloud_provider[] DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_release_id UUID;
BEGIN
    IF p_version IS NOT NULL THEN
        SELECT id INTO v_release_id FROM public.runner_releases WHERE version = p_version;
    END IF;
    -- supported_providers is image-driven: keep it in sync with what the runner
    -- reports (NULL = unset = claims any provider).
    UPDATE public.runners
    SET last_heartbeat = now(), status = 'ONLINE'::public.runner_status,
        version = COALESCE(p_version, version), release_id = COALESCE(v_release_id, release_id),
        supported_providers = COALESCE(p_providers, supported_providers)
    WHERE id = p_runner_id AND token_hash = p_runner_token_hash;
    IF NOT FOUND THEN RAISE EXCEPTION 'Unauthorized runner'; END IF;
    PERFORM public.open_runner_session(p_runner_id);
END;
$$;

-- set_default_runner: owner passed as a parameter (no implicit session-user lookup).
CREATE OR REPLACE FUNCTION public.set_default_runner(p_user_id UUID, p_runner_id UUID DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE public.runners SET is_default = false WHERE user_id = p_user_id AND is_default = true;
    IF p_runner_id IS NOT NULL THEN
        UPDATE public.runners SET is_default = true WHERE id = p_runner_id AND user_id = p_user_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Runner not found or not owned by user'; END IF;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_default_runner(UUID, UUID) TO alethia_app;

-- ── Runner model backfill (legacy `mode` → operator/provisioning) + the
-- data-dependent CHECK constraints. Runs here, after the schema migration adds the
-- columns (operator defaulted to 'self' for all existing rows) and before the
-- constraints are added, so the invariants hold by the time they are enforced.
-- Idempotent: the operator/provisioning UPDATEs are guarded and the constraints
-- are added only if absent. The `mode` column is retained nullable for this
-- window; a later migration drops it. ──
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'runners' AND column_name = 'mode'
  ) THEN
    -- operator: cloud-hosted → managed; self-hosted → self.
    UPDATE public.runners
      SET operator = 'managed'::public.runner_operator
      WHERE mode = 'cloud-hosted' AND operator <> 'managed';
    UPDATE public.runners
      SET operator = 'self'::public.runner_operator
      WHERE mode = 'self-hosted' AND operator <> 'self';
    -- provisioning: legacy self runners with a completed cloud deploy (cloud
    -- identity + deploy_config in metadata) → deployed; otherwise registered.
    -- Managed runners keep NULL.
    UPDATE public.runners
      SET provisioning = CASE
        WHEN cloud_identity_id IS NOT NULL
             AND (metadata -> 'deploy_config') IS NOT NULL
             AND (metadata -> 'deploy_config') <> 'null'::jsonb
          THEN 'deployed'::public.runner_provisioning
        ELSE 'registered'::public.runner_provisioning
      END
      WHERE mode = 'self-hosted' AND provisioning IS NULL;
  END IF;
END $$;

DO $$ BEGIN
  -- managed ⇔ platform-owned (no user).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runners_operator_owner_ck') THEN
    ALTER TABLE public.runners ADD CONSTRAINT runners_operator_owner_ck
      CHECK ((operator = 'managed') = (user_id IS NULL));
  END IF;
  -- provisioning is set iff self-operated.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'runners_provisioning_ck') THEN
    ALTER TABLE public.runners ADD CONSTRAINT runners_provisioning_ck
      CHECK ((operator = 'self') = (provisioning IS NOT NULL));
  END IF;
END $$;

-- ── Runner usage metering. Managed runners are billed by provisioned hours, so
-- each ONLINE→OFFLINE interval is recorded as a session row. open_runner_session
-- is called from the ONLINE write paths (claim_next_job, runner_heartbeat);
-- sweep_offline_runners is the close hook (and the only OFFLINE transition). ──
CREATE OR REPLACE FUNCTION public.open_runner_session(p_runner_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Meter managed runners only; open at most one session per runner. The
  -- NOT EXISTS guard (backed by idx_usage_one_open_per_runner) makes re-entrant
  -- claims/heartbeats idempotent.
  INSERT INTO public.runner_usage_sessions (runner_id, operator, org_id, started_at)
  SELECT r.id, r.operator, r.org_id, now()
  FROM public.runners r
  WHERE r.id = p_runner_id AND r.operator = 'managed'
    AND NOT EXISTS (
      SELECT 1 FROM public.runner_usage_sessions s
      WHERE s.runner_id = r.id AND s.ended_at IS NULL);
END;
$$;

-- ── Connection-based presence (instant liveness). The runner holds a persistent SSE
-- wake connection; the route calls runner_present on connect + each ping (refreshing
-- the last_heartbeat lease), and runner_lost the instant the connection drops
-- (req.signal abort). This replaces slow heartbeat-stale polling as the liveness path.
-- A DRAINING runner stays DRAINING (it's being retired) — presence only refreshes the lease. ──
CREATE OR REPLACE FUNCTION public.runner_present(p_runner_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.runners
  SET last_heartbeat = now(),
      status = CASE WHEN status = 'DRAINING' THEN status ELSE 'ONLINE'::public.runner_status END
  WHERE id = p_runner_id;
  PERFORM public.open_runner_session(p_runner_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.runner_lost(p_runner_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Mark gone + close the usage session at the last proof-of-life, and wake the
  -- controller so it replaces the lost capacity without waiting for the next tick.
  WITH closed AS (
    UPDATE public.runners SET status = 'OFFLINE'::public.runner_status
    WHERE id = p_runner_id AND status <> 'OFFLINE'
    RETURNING id, last_heartbeat
  )
  UPDATE public.runner_usage_sessions s
  SET ended_at = COALESCE(c.last_heartbeat, s.started_at),
      duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(c.last_heartbeat, s.started_at) - s.started_at)))::bigint
  FROM closed c WHERE s.runner_id = c.id AND s.ended_at IS NULL;
  PERFORM pg_notify('runner_lost', p_runner_id::text);
END;
$$;

-- Flips stale ONLINE **or DRAINING** runners to OFFLINE (mirrors recover_stale_jobs's
-- 5-min window) and closes their open session at last_heartbeat (last proof-of-life),
-- so the staleness grace window is not billed. RETURNS the flipped runners so the caller
-- can emit `system.runner.offline` alerts (lib/jobs/recovery.ts) — the state change is the
-- durable signal; emit is best-effort.
--
-- Why DRAINING is swept too: the fleet controller sets a managed runner DRAINING to retire
-- it (version roll / scale-down). A live drainer keeps its SSE wake connection, so
-- runner_present refreshes last_heartbeat every ~10s AND preserves DRAINING — a fresh
-- heartbeat therefore means "still alive, don't reap" and the `last_heartbeat < now() - 45s`
-- guard skips it. But if the VM dies HARD (power loss / hard partition) there is no clean
-- SSE abort, so runner_lost never fires; the runner is stranded DRAINING with a stale
-- heartbeat and — because the old predicate only matched ONLINE — its open
-- runner_usage_sessions row was never closed, billing the managed runner FOREVER. Including
-- DRAINING in the stale predicate closes that session at last_heartbeat exactly like the
-- ONLINE path (audit #21). The 45s stale window is identical: a draining runner heartbeats
-- while alive, so 45s of silence = dead regardless of ONLINE vs DRAINING.
-- DROP first: the return type changed (INTEGER → TABLE), which CREATE OR REPLACE can't do.
DROP FUNCTION IF EXISTS public.sweep_offline_runners();
CREATE OR REPLACE FUNCTION public.sweep_offline_runners()
RETURNS TABLE(runner_id uuid, org_id uuid, runner_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
-- The OUT param `org_id` shares a name with the runners column; prefer the column.
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH stale AS (
    UPDATE public.runners
    SET status = 'OFFLINE'::public.runner_status
    WHERE status IN ('ONLINE', 'DRAINING')
      -- Tightened lease: the SSE wake connection refreshes last_heartbeat every ~10s
      -- via runner_present (which preserves DRAINING), so a 45s gap means the connection
      -- is genuinely gone (hard partition) whether the runner was ONLINE or DRAINING.
      -- Clean drops are caught instantly by runner_lost.
      AND (last_heartbeat IS NULL OR last_heartbeat < now() - INTERVAL '45 seconds')
    RETURNING id, org_id, name, last_heartbeat
  ),
  closed AS (
    UPDATE public.runner_usage_sessions s
    SET ended_at = COALESCE(st.last_heartbeat, s.started_at),
        duration_seconds = GREATEST(
          0,
          EXTRACT(EPOCH FROM (COALESCE(st.last_heartbeat, s.started_at) - s.started_at))
        )::bigint
    FROM stale st
    WHERE s.runner_id = st.id AND s.ended_at IS NULL
    RETURNING s.id
  )
  SELECT st.id, st.org_id, st.name FROM stale st;
END;
$$;

-- ── Environment-scoping backfill ───────────────────────────────────────────────────
-- Component config became environment-scoped (environment_id added to every project_* table).
-- Attach any pre-existing rows (created when config was project-level) to their project's
-- DEFAULT environment. Idempotent: only rows whose environment_id is still NULL are touched, so
-- this is safe to re-run on every migrate.
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'project_network', 'project_cluster', 'project_dns', 'project_observability',
    'project_repositories', 'project_databases', 'project_caches', 'project_queues',
    'project_topics', 'project_nosql_tables', 'project_container_registries',
    'project_secrets', 'project_storage_buckets', 'project_git_credentials'
  ]) LOOP
    EXECUTE format(
      'UPDATE public.%I c SET environment_id = e.id
         FROM public.project_environments e
        WHERE e.project_id = c.project_id AND e.is_default
          AND c.environment_id IS NULL', tbl);
  END LOOP;
END $$;

-- ── Fabric backfill (decoupled env-model, #836) ──────────────────────────────────────
-- Environment is now a delivery target PLACED onto a Fabric (the infra unit). Existing rows
-- predate the split: env = its own cluster. Map each to the `dedicated` placement (the column
-- default) by creating a 1:1 Fabric per environment and linking the env + its cluster to it —
-- byte-behaviour preserved. Idempotent: only envs whose fabric_id is still NULL are touched.
DO $$
BEGIN
  -- One Fabric per existing environment (name/region/status/tenancy carried from the env).
  WITH new_fabrics AS (
    INSERT INTO public.project_fabrics (project_id, user_id, org_id, name, region, status)
    SELECT e.project_id, e.user_id, e.org_id, e.name, e.region, e.status
      FROM public.project_environments e
     WHERE e.fabric_id IS NULL
    RETURNING id, project_id, name
  )
  UPDATE public.project_environments e
     SET fabric_id = f.id
    FROM new_fabrics f
   WHERE e.project_id = f.project_id AND e.name = f.name AND e.fabric_id IS NULL;

  -- Link each existing cluster to the Fabric created for its environment.
  UPDATE public.project_cluster c
     SET fabric_id = e.fabric_id
    FROM public.project_environments e
   WHERE c.environment_id = e.id
     AND c.fabric_id IS NULL
     AND e.fabric_id IS NOT NULL;
END $$;

-- ── BYO-IaC attach point → Fabric backfill (decoupled env-model, #839) ────────────────
-- BYO-IaC (customer OpenTofu) now attaches at the Fabric, not the Environment: the single-stack
-- ceiling is UNIQUE(project_id, fabric_id). Existing rows are env-keyed; map each onto the Fabric
-- of its attaching environment (every env has one from the #836 backfill above, so this must run
-- AFTER it). Idempotent: only sources whose fabric_id is still NULL are touched.
UPDATE public.project_iac_sources s
   SET fabric_id = e.fabric_id
  FROM public.project_environments e
 WHERE s.environment_id = e.id
   AND s.fabric_id IS NULL
   AND e.fabric_id IS NOT NULL;

-- ── project_full: RETIRED. This denormalized, default-env-only read model (a hand-maintained
-- view + parallel TS type that had to be kept in sync by hand) served only the CLI `project get`.
-- It was replaced by the TS read layer — lib/queries/cli-config.ts `getCliConfig` → the shared
-- `readEnvComponents` — which is env-aware, type-safe, and has no view/type to drift. Dropped here
-- (programmables runs every migrate) so existing databases clean up; fresh databases never create it.
DROP VIEW IF EXISTS public.project_full;

-- ── org_id coarse-tenancy backfill + trigger. Community: org_id = user_id (the
-- user's personal org); the ee/ Teams build assigns real organization ids. The
-- trigger keeps org_id populated without any insert call-site changes.
--
-- Resolution order (most authoritative first): an explicit stamp on the row wins;
-- otherwise the active tenancy from the withScope() session GUC (app.current_org);
-- otherwise the creator's personal org (user_id). The GUC fallback means a row
-- written under withActorScope()/withScope({orgId}) self-stamps the *real* active
-- org even when the call-site forgot to pass org_id — the fix for the mis-stamped
-- org data that made org-scoped reads (usage, clusters) return empty for Teams orgs.
-- current_setting(...,true) returns NULL when the GUC is unset (service-role paths,
-- which BYPASSRLS and never call withScope) → falls through to user_id = today's
-- behavior, so community and service inserts are byte-identical. ──
CREATE OR REPLACE FUNCTION public.set_org_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS NULL THEN
    NEW.org_id = coalesce(
      nullif(current_setting('app.current_org', true), '')::uuid,
      NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- jobs carry a project_id, and a job ALWAYS belongs to the org that owns its project.
-- Deriving org_id from projects.org_id makes it a *structural* invariant of the FK —
-- drift-proof and independent of session state or a forgotten stamp (projects.org_id
-- is the authoritative, correctly-stamped source; jobs.org_id is a denormalized cache
-- that had drifted). The parent lookup is itself RLS-guarded on the app connection: a
-- cross-org project_id the caller can't see returns no row, so it can never leak another
-- org's id — it falls through to the session/personal fallback instead. project_id NULL
-- (runner/scan jobs) also falls through to session → personal.
CREATE OR REPLACE FUNCTION public.set_org_id_from_project()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS NULL AND NEW.project_id IS NOT NULL THEN
    SELECT org_id INTO NEW.org_id FROM public.projects WHERE id = NEW.project_id;
  END IF;
  IF NEW.org_id IS NULL THEN
    NEW.org_id = coalesce(
      nullif(current_setting('app.current_org', true), '')::uuid,
      NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Non-project-bearing tables use the generic session/personal resolver.
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['projects','cloud_identities', 'connector_credentials', 'runners', 'support_cases', 'thread_widgets', 'agent_artifacts', 'agent_context', 'agent_message_feedback', 'org_signing_key']) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %1$s_set_org_id ON public.%1$I', tbl);
    EXECUTE format(
      'CREATE TRIGGER %1$s_set_org_id BEFORE INSERT ON public.%1$I
         FOR EACH ROW EXECUTE FUNCTION public.set_org_id()', tbl);
    EXECUTE format(
      'UPDATE public.%I SET org_id = user_id WHERE org_id IS NULL AND user_id IS NOT NULL', tbl);
  END LOOP;
END $$;

-- jobs: parent-derived org_id (the drift-proof path above).
DROP TRIGGER IF EXISTS jobs_set_org_id ON public.jobs;
CREATE TRIGGER jobs_set_org_id BEFORE INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_org_id_from_project();

-- Backfill historical jobs whose org_id drifted from their project's org (the root of
-- the org-usage 0s). Idempotent + self-healing: after the trigger fix, re-runs match
-- nothing. projects.org_id is authoritative; only project-bearing jobs are correctable
-- here (project-less jobs keep their existing org_id).
UPDATE public.jobs j
   SET org_id = p.org_id
  FROM public.projects p
 WHERE j.project_id = p.id
   AND j.org_id IS DISTINCT FROM p.org_id;

-- ── Tenant RLS backstop. Coarse org-isolation (org_id = app.current_org) OR'd with
-- the per-owner check (user_id = app.current_owner); both set per-transaction by
-- withScope(). Community: org_id = user_id and current_org = current_owner, so the
-- two are identical — isolation is unchanged. Fine-grained decisions live in the PDP
-- (lib/authz). NULL when unset → deny. Service/superuser bypasses RLS. ──

-- Owned tables (direct user_id + org_id)
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['projects','jobs', 'agent_threads', 'ai_usage_ledger', 'ai_credit_grant', 'thread_widgets', 'agent_artifacts', 'agent_context', 'agent_message_feedback', 'org_signing_key']) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL
         USING (user_id = current_setting(''app.current_owner'', true)::uuid
                OR org_id = current_setting(''app.current_org'', true)::uuid)
         WITH CHECK (user_id = current_setting(''app.current_owner'', true)::uuid
                OR org_id = current_setting(''app.current_org'', true)::uuid)', tbl);
  END LOOP;
END $$;

-- Support cases (tiered): org-owned, but visibility depends on the caller's role. The
-- app sets a third GUC `app.support_all` = 'true' when the caller holds the PDP
-- `support_case:manage_support` capability (owner/admin) — they see EVERY case in the
-- org; everyone else sees only cases they opened (user_id = current_owner). Always
-- org-scoped first (org_id = current_org). `support_all` unset → own-only (fail closed).
-- Community/personal orgs: org_id == user_id == current_owner, so this collapses to
-- exactly today's behavior. WITH CHECK mirrors USING so an admin can update (resolve/
-- reply-bump) a member's case, while the app pins user_id to the requester on insert.
DO $$
BEGIN
  ALTER TABLE public.support_cases ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS owner_all ON public.support_cases;
  CREATE POLICY owner_all ON public.support_cases FOR ALL
    USING (org_id = current_setting('app.current_org', true)::uuid
           AND (coalesce(current_setting('app.support_all', true), '') = 'true'
                OR user_id = current_setting('app.current_owner', true)::uuid))
    WITH CHECK (org_id = current_setting('app.current_org', true)::uuid
           AND (coalesce(current_setting('app.support_all', true), '') = 'true'
                OR user_id = current_setting('app.current_owner', true)::uuid));
END $$;

-- Credential tables (scope-aware): a `personal` row is visible only to its author
-- (user_id = current_owner); an `org` row is visible to the whole org
-- (org_id = current_org). This is the coarse blast wall — the fine-grained role
-- (view vs manage) is enforced by the PDP at the app layer (dataroom/spec/mvp/08 + 07).
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['cloud_identities', 'connector_credentials']) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS scoped_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY scoped_all ON public.%I FOR ALL
         USING ((scope = ''personal'' AND user_id = current_setting(''app.current_owner'', true)::uuid)
                OR (scope = ''org'' AND org_id = current_setting(''app.current_org'', true)::uuid))
         WITH CHECK ((scope = ''personal'' AND user_id = current_setting(''app.current_owner'', true)::uuid)
                OR (scope = ''org'' AND org_id = current_setting(''app.current_org'', true)::uuid))', tbl);
  END LOOP;
END $$;

-- Cloud inventory + per-tenant CAPABILITIES tables (#928): ownership flows through the parent
-- cloud_identity's scope. Writes come from the console's server-side sync/event-ingester via the service
-- role (RLS-bypassing); this gates tenant reads to identities they own/share. The cloud_capability_*
-- tables share the inventory shape (cloud_identity_id FK) so they inherit the identical owner_all policy.
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'cloud_regions', 'cloud_networks', 'cloud_subnets', 'cloud_nics', 'cloud_dns_zones',
    'cloud_kubernetes_clusters', 'cloud_databases', 'cloud_caches', 'cloud_queues', 'cloud_topics',
    'cloud_nosql_tables', 'cloud_container_registries', 'cloud_secrets', 'cloud_storage_buckets',
    'cloud_resources',
    'cloud_capability_regions', 'cloud_capability_instance_types', 'cloud_capability_services',
    'cloud_capability_quotas', 'cloud_capability_sync_state'
  ]) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL
         USING (cloud_identity_id IN (
           SELECT id FROM public.cloud_identities ci
            WHERE (ci.scope = ''personal'' AND ci.user_id = current_setting(''app.current_owner'', true)::uuid)
               OR (ci.scope = ''org'' AND ci.org_id = current_setting(''app.current_org'', true)::uuid)))
         WITH CHECK (cloud_identity_id IN (
           SELECT id FROM public.cloud_identities ci
            WHERE (ci.scope = ''personal'' AND ci.user_id = current_setting(''app.current_owner'', true)::uuid)
               OR (ci.scope = ''org'' AND ci.org_id = current_setting(''app.current_org'', true)::uuid)))', tbl);
  END LOOP;
END $$;

-- runners: reads are owner/org-scoped. Managed (platform-fleet) rows have no owner/org, so they
-- are NOT visible through the tenant RLS path — they leak fleet topology/COGS to every tenant
-- otherwise. The fleet controller, scaler, runner claim/heartbeat/wake, and the self-managed
-- operator's fleet view all read managed rows via the service role (getServiceDb), which bypasses
-- RLS. Writes remain owner/org-scoped self runners.
ALTER TABLE public.runners ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runners_select ON public.runners;
CREATE POLICY runners_select ON public.runners FOR SELECT
  USING (user_id = current_setting('app.current_owner', true)::uuid
         OR org_id = current_setting('app.current_org', true)::uuid);
DROP POLICY IF EXISTS runners_insert ON public.runners;
CREATE POLICY runners_insert ON public.runners FOR INSERT
  WITH CHECK (operator = 'self'::public.runner_operator
         AND (user_id = current_setting('app.current_owner', true)::uuid
              OR org_id = current_setting('app.current_org', true)::uuid));
DROP POLICY IF EXISTS runners_update ON public.runners;
CREATE POLICY runners_update ON public.runners FOR UPDATE
  USING (user_id = current_setting('app.current_owner', true)::uuid
         OR org_id = current_setting('app.current_org', true)::uuid);
DROP POLICY IF EXISTS runners_delete ON public.runners;
CREATE POLICY runners_delete ON public.runners FOR DELETE
  USING (user_id = current_setting('app.current_owner', true)::uuid
         OR org_id = current_setting('app.current_org', true)::uuid);

-- Project child tables (ownership via the parent project)
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'project_environments', 'project_fabrics', 'project_preview_config', 'project_network', 'project_cluster', 'project_dns', 'project_observability', 'project_repositories', 'project_databases',
    'project_caches', 'project_queues', 'project_topics', 'project_nosql_tables',
    'project_container_registries', 'project_helm_registries', 'project_secrets', 'project_git_credentials', 'project_storage_buckets',
    'project_changes', 'project_chart_workloads',
    'environment_protection_rules', 'environment_promotions', 'promotion_approvals'
  ]) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL
         USING (project_id IN (SELECT id FROM public.projects
                WHERE user_id = current_setting(''app.current_owner'', true)::uuid
                   OR org_id = current_setting(''app.current_org'', true)::uuid))
         WITH CHECK (project_id IN (SELECT id FROM public.projects
                WHERE user_id = current_setting(''app.current_owner'', true)::uuid
                   OR org_id = current_setting(''app.current_org'', true)::uuid))', tbl);
  END LOOP;
END $$;

-- ── project_environments: EXACTLY one default, enforced at COMMIT (#4127) ────────────────────────
--
-- `project_environments_one_default` (the partial unique index in the drizzle schema) says "no two
-- rows with is_default = true". It says nothing about ZERO — so a project whose environments carry
-- no default was legal, and three readers carried a silent fallback for it
-- (`envs.find(is_default) ?? envs[0]` in lib/queries/cli-config.ts, the `desc(is_default)` sort in
-- lib/cli/resolve-project.ts, and the same `?? environments[0]` in server/actions/projects.ts).
-- Each is an arbitrary pick presented as an answer. The index gives at-most-one; this gives
-- at-least-one, and together they are the "exactly one" the schema header has claimed all along.
--
-- ── WHY A CONSTRAINT TRIGGER, AND WHY DEFERRED ──
--
-- Every legitimate write reaches the correct state only at COMMIT, never statement by statement:
--
--   * `insertProjectWithDefaultFabric` inserts the `projects` row FIRST and its environments in a
--     later statement of the same transaction. Between them the project has zero environments —
--     legitimately.
--   * `projects → project_environments` is ON DELETE CASCADE. An immediate AFTER DELETE check would
--     fire while a project is being deleted, see its environments gone, and block every project
--     deletion. Deferred, the parent row is gone too by the time the check runs, and the
--     `NOT EXISTS (SELECT 1 FROM projects …)` probe below skips.
--   * A future "make this env the default" flow must clear the old flag before setting the new one;
--     the partial unique index forbids doing it in the other order.
--
-- A CHECK constraint cannot express a cross-row predicate, and a plain (non-constraint) trigger
-- cannot be deferred. `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` is the only shape that
-- judges the END STATE. drizzle-kit does not model constraint triggers, which is why this lives
-- here rather than in a generated migration — scripts/migrate.mjs re-applies this file after the
-- DDL on every migrate, so it is re-asserted on every deploy.
--
-- ── THE PROBE RUNS UNDER THE INVOKING ROLE UNLESS WE SAY OTHERWISE ──
--
-- Every console write arrives on the least-privileged `alethia_app` connection, and both `projects`
-- and `project_environments` are RLS-protected. A SECURITY INVOKER check would ask its two
-- questions through those policies: "does the parent exist" and "how many defaults does it have".
-- If a policy hid either answer the check would silently SKIP — the invariant becomes decorative,
-- and a fail-open invariant is worse than none, because the readers above will have been rewritten
-- to trust it. So the function is SECURITY DEFINER (owned by the migration role, which owns these
-- tables and is not subject to their policies) and it measures the real rows.
--
-- Today an invoker-rights version would happen to agree — `project_environments`'s `owner_all`
-- policy is derived from `projects` visibility, so a caller who may write a child can always see
-- the parent. That equivalence is a property of one policy pair, not of the design, and this
-- function must not depend on it.
--
-- `SET row_security = off` is the belt: for the owner it is a NO-OP (no policy applies to them),
-- but should this file ever be applied by a role that IS subject to RLS — or should these tables
-- gain FORCE ROW LEVEL SECURITY — Postgres raises rather than quietly filtering. That asymmetry is
-- the point: it converts the exact fail-open described above into a loud error.
--
-- Definer rights read across tenants, so the OTHER direction was checked too: the RAISE below puts a
-- project id and two counts into a message the caller sees. It can only ever be the caller's OWN
-- project. To make this fire for project P a caller must INSERT, UPDATE or DELETE a
-- project_environments row carrying P — and `owner_all`'s WITH CHECK/USING resolve P through
-- `projects` visibility first, so a write naming someone else's project is rejected before the
-- trigger is ever queued. That includes the move case (`SET project_id = <other tenant>`), where
-- WITH CHECK tests the NEW row. So the definer rights widen what the CHECK can see, never what the
-- caller can learn.
--
-- ── SCOPE: this does NOT require a project to have any environments ──
--
-- The predicate is "a project's environments, IF IT HAS ANY, contain exactly one default". A
-- project with no environments at all never fires this trigger (it only fires on
-- project_environments DML) and is deliberately left alone: "every project has at least one
-- environment" is a strictly larger invariant — 33 call sites create a bare project today, and the
-- readers this issue is about already treat "no environments" as its own distinct, reported outcome
-- (`CliEnvTarget.no-environments`), never as a guess. Enforcing it belongs to its own unit, with a
-- trigger on `projects` and the fixtures to match.

-- Trigger first, then the function: DROP FUNCTION refuses while a trigger depends on it, and this
-- file's convention (see the 42P13 note in .claude/skills/db-pipeline/SKILL.md) is an explicit drop
-- rather than CREATE OR REPLACE, so a changed signature does not fail the whole migrate.
--
-- AND BOTH DROPS PRECEDE THE REPAIR BELOW, which is not cosmetic ordering. The trigger is
-- DEFERRABLE INITIALLY DEFERRED and `migrate.mjs:114` applies this whole file through one
-- `sql.unsafe()` — a single implicit transaction. On a RE-APPLY over a database that already holds
-- the trigger AND a violating project, a repair written after this point queues deferred
-- after-trigger events, the DROP then removes the trigger those queued events name, and Postgres
-- raises at COMMIT — failing the programmables phase and the deploy. That is exactly the recovery
-- case the repair exists to serve, so the repair must run with no trigger present at all.
DROP TRIGGER IF EXISTS project_environments_one_default_check ON public.project_environments;
DROP FUNCTION IF EXISTS public.project_environments_require_one_default();

-- The repair, re-asserted. This is the SAME expression migration 0150 ran (Step 3), kept here for
-- the same reason 0150 duplicated the org_id backfill from this file: a constraint trigger does NOT
-- validate existing rows, so creating it over a database holding a violation enforces nothing until
-- something next touches that project — and then it raises on an unrelated write. Idempotent: after
-- 0150 (and after the trigger below exists) it matches nothing. It runs AFTER both DROPs and BEFORE
-- the CREATE, so no trigger exists while it runs — see the note above the drops for why "before the
-- CREATE" alone was not enough.
WITH needing AS (
  SELECT project_id
    FROM public.project_environments
   GROUP BY project_id
  HAVING bool_or(is_default) IS NOT TRUE
), pick AS (
  SELECT DISTINCT ON (e.project_id) e.id
    FROM public.project_environments e
    JOIN needing n ON n.project_id = e.project_id
   ORDER BY e.project_id, e.created_at, e.id
)
UPDATE public.project_environments
   SET is_default = true,
       updated_at = now()
 WHERE id IN (SELECT id FROM pick);

CREATE FUNCTION public.project_environments_require_one_default()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  pids     uuid[];
  pid      uuid;
  total    integer;
  defaults integer;
BEGIN
  -- An UPDATE that MOVES an environment between projects can break the invariant at both ends, so
  -- both are checked. NEW is unassigned on DELETE and OLD on INSERT — referencing the wrong one
  -- raises inside plpgsql, hence the explicit TG_OP branch rather than a COALESCE.
  IF TG_OP = 'INSERT' THEN
    pids := ARRAY[NEW.project_id];
  ELSIF TG_OP = 'DELETE' THEN
    pids := ARRAY[OLD.project_id];
  ELSIF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    pids := ARRAY[OLD.project_id, NEW.project_id];
  ELSE
    pids := ARRAY[NEW.project_id];
  END IF;

  FOREACH pid IN ARRAY pids LOOP
    CONTINUE WHEN pid IS NULL;

    -- The parent is gone: a cascade delete, or the whole project rolled away in this transaction.
    -- There is nothing left to hold a default, so the invariant is vacuous. THIS is the branch that
    -- keeps project deletion working, and the reason the check has to be deferred to see it.
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.projects WHERE id = pid);

    SELECT count(*), count(*) FILTER (WHERE is_default)
      INTO total, defaults
      FROM public.project_environments
     WHERE project_id = pid;

    -- total = 0 → the project has no environments; see the SCOPE note above.
    -- defaults > 1 is already impossible (project_environments_one_default), but it is reported
    -- rather than assumed away, so dropping that index degrades this check instead of blinding it.
    IF total > 0 AND defaults <> 1 THEN
      RAISE EXCEPTION
        'project % has % environment(s) but % default: exactly one must have is_default = true',
        pid, total, defaults
        USING ERRCODE = 'integrity_constraint_violation',
              HINT = 'Set is_default = true on exactly one project_environments row for this project.';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

-- NO `REVOKE ... FROM PUBLIC` on this function, deliberately — the usual SECURITY DEFINER hygiene
-- would be a risk here with nothing to buy. `RETURNS TRIGGER` already forbids an ordinary call
-- ("trigger functions can only be called as triggers", 0A000), so PUBLIC's default EXECUTE grant is
-- not a definer-rights entry point; and every other trigger function in this file relies on that
-- same default, because the EXECUTE check happens at CREATE TRIGGER against the CREATOR, not on the
-- role whose write fires it. Revoking here would be the only place in the file betting on that.
--
-- What the app role cannot do is turn the check off: `ALTER TABLE … DISABLE TRIGGER` needs table
-- ownership and `session_replication_role` needs superuser, and alethia_app is neither. It can call
-- SET CONSTRAINTS, which only moves the check EARLIER (to the statement) — never away.

-- `UPDATE OF is_default, project_id` and not a bare UPDATE: (total, defaults) can only move when one
-- of those two columns is written, and environment `status` is updated on every job transition. The
-- narrow event list keeps the hot path free of a per-row count at commit.
CREATE CONSTRAINT TRIGGER project_environments_one_default_check
  AFTER INSERT OR DELETE OR UPDATE OF is_default, project_id ON public.project_environments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.project_environments_require_one_default();

-- topic_subscriptions: normalized child of project_topics (no direct project_id), so tenancy flows
-- through the parent topic → project — the same join-through shape as the support-case child tables.
-- FOR ALL because the app delete+reinserts these on every save (RLS is the tenancy wall).
ALTER TABLE public.topic_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.topic_subscriptions;
CREATE POLICY owner_all ON public.topic_subscriptions FOR ALL
  USING (topic_id IN (SELECT t.id FROM public.project_topics t
         JOIN public.projects p ON p.id = t.project_id
         WHERE p.user_id = current_setting('app.current_owner', true)::uuid
            OR p.org_id = current_setting('app.current_org', true)::uuid))
  WITH CHECK (topic_id IN (SELECT t.id FROM public.project_topics t
         JOIN public.projects p ON p.id = t.project_id
         WHERE p.user_id = current_setting('app.current_owner', true)::uuid
            OR p.org_id = current_setting('app.current_org', true)::uuid));

-- cluster_admins: normalized child of project_cluster (no direct project_id) — tenancy flows through
-- the parent cluster → project, same join-through shape as topic_subscriptions.
ALTER TABLE public.cluster_admins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.cluster_admins;
CREATE POLICY owner_all ON public.cluster_admins FOR ALL
  USING (cluster_id IN (SELECT c.id FROM public.project_cluster c
         JOIN public.projects p ON p.id = c.project_id
         WHERE p.user_id = current_setting('app.current_owner', true)::uuid
            OR p.org_id = current_setting('app.current_org', true)::uuid))
  WITH CHECK (cluster_id IN (SELECT c.id FROM public.project_cluster c
         JOIN public.projects p ON p.id = c.project_id
         WHERE p.user_id = current_setting('app.current_owner', true)::uuid
            OR p.org_id = current_setting('app.current_org', true)::uuid));

-- service_bindings: a binding belongs to a service XOR a chart workload, so its tenancy is a 2-path
-- join-through — visible when EITHER owner resolves to the org's project. service_binding_injections
-- inherit tenancy through their parent binding (the same predicate, one hop further).
ALTER TABLE public.service_bindings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.service_bindings;
CREATE POLICY owner_all ON public.service_bindings FOR ALL
  USING (service_id IN (SELECT s.id FROM public.project_services s
             JOIN public.projects p ON p.id = s.project_id
             WHERE p.user_id = current_setting('app.current_owner', true)::uuid
                OR p.org_id = current_setting('app.current_org', true)::uuid)
      OR chart_workload_id IN (SELECT w.id FROM public.project_chart_workloads w
             JOIN public.projects p ON p.id = w.project_id
             WHERE p.user_id = current_setting('app.current_owner', true)::uuid
                OR p.org_id = current_setting('app.current_org', true)::uuid))
  WITH CHECK (service_id IN (SELECT s.id FROM public.project_services s
             JOIN public.projects p ON p.id = s.project_id
             WHERE p.user_id = current_setting('app.current_owner', true)::uuid
                OR p.org_id = current_setting('app.current_org', true)::uuid)
      OR chart_workload_id IN (SELECT w.id FROM public.project_chart_workloads w
             JOIN public.projects p ON p.id = w.project_id
             WHERE p.user_id = current_setting('app.current_owner', true)::uuid
                OR p.org_id = current_setting('app.current_org', true)::uuid));

ALTER TABLE public.service_binding_injections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.service_binding_injections;
CREATE POLICY owner_all ON public.service_binding_injections FOR ALL
  USING (binding_id IN (SELECT b.id FROM public.service_bindings b
         WHERE b.service_id IN (SELECT s.id FROM public.project_services s
               JOIN public.projects p ON p.id = s.project_id
               WHERE p.user_id = current_setting('app.current_owner', true)::uuid
                  OR p.org_id = current_setting('app.current_org', true)::uuid)
            OR b.chart_workload_id IN (SELECT w.id FROM public.project_chart_workloads w
               JOIN public.projects p ON p.id = w.project_id
               WHERE p.user_id = current_setting('app.current_owner', true)::uuid
                  OR p.org_id = current_setting('app.current_org', true)::uuid)))
  WITH CHECK (binding_id IN (SELECT b.id FROM public.service_bindings b
         WHERE b.service_id IN (SELECT s.id FROM public.project_services s
               JOIN public.projects p ON p.id = s.project_id
               WHERE p.user_id = current_setting('app.current_owner', true)::uuid
                  OR p.org_id = current_setting('app.current_org', true)::uuid)
            OR b.chart_workload_id IN (SELECT w.id FROM public.project_chart_workloads w
               JOIN public.projects p ON p.id = w.project_id
               WHERE p.user_id = current_setting('app.current_owner', true)::uuid
                  OR p.org_id = current_setting('app.current_org', true)::uuid)));

-- job_logs: user reads own (via parent). audit_log: user reads + inserts own (append-only);
-- runners also write via the RLS-bypassing service role.
ALTER TABLE public.job_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS logs_select ON public.job_logs;
CREATE POLICY logs_select ON public.job_logs FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.jobs j
    WHERE j.id = job_logs.job_id
      AND (j.user_id = current_setting('app.current_owner', true)::uuid
           OR j.org_id = current_setting('app.current_org', true)::uuid)));

-- Support case child tables: tenancy + visibility flow through the parent support_cases
-- (like job_logs) — the subquery uses the SAME tiered predicate (org-scoped, then
-- support_all-or-own), so a reply/attachment/read is visible exactly when its case is.
-- FOR ALL because customers INSERT replies/reads. `is_internal` staff notes ARE visible
-- under this policy, so the customer query builder always filters them out
-- (lib/queries/support.ts) — RLS is the tenancy wall, the query is the visibility filter.
-- Staff writes go through the RLS-bypassing service role, so this policy never needs to
-- permit staff.
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['support_messages','support_case_attachments','support_case_reads']) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL
         USING (case_id IN (SELECT id FROM public.support_cases
                WHERE org_id = current_setting(''app.current_org'', true)::uuid
                  AND (coalesce(current_setting(''app.support_all'', true), '''') = ''true''
                       OR user_id = current_setting(''app.current_owner'', true)::uuid)))
         WITH CHECK (case_id IN (SELECT id FROM public.support_cases
                WHERE org_id = current_setting(''app.current_org'', true)::uuid
                  AND (coalesce(current_setting(''app.support_all'', true), '''') = ''true''
                       OR user_id = current_setting(''app.current_owner'', true)::uuid)))', tbl);
  END LOOP;
END $$;

-- SSE fan-out: notify listeners on every new thread message (one LISTEN conn per app
-- instance fans out). Payload carries ids only (8 KB cap); the stream route fetches the
-- row since its last seen id. Mirrors insert_job_log's job_logs notify.
CREATE OR REPLACE FUNCTION public.notify_support_message()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('support_messages', json_build_object(
    'caseId', NEW.case_id,
    'messageId', NEW.id
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS support_messages_notify ON public.support_messages;
CREATE TRIGGER support_messages_notify
  AFTER INSERT ON public.support_messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_support_message();

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_select ON public.audit_log;
CREATE POLICY audit_select ON public.audit_log FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects
    WHERE user_id = current_setting('app.current_owner', true)::uuid
       OR org_id = current_setting('app.current_org', true)::uuid));
-- Append-only INSERT for the app role (e.g. createProject's CREATED entry), scoped to owned
-- projects so the write stays inside the same withOwnerScope transaction. No UPDATE/DELETE policy
-- → audit rows are immutable from the app role.
DROP POLICY IF EXISTS audit_insert ON public.audit_log;
CREATE POLICY audit_insert ON public.audit_log FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects
    WHERE user_id = current_setting('app.current_owner', true)::uuid
       OR org_id = current_setting('app.current_org', true)::uuid));

-- profiles: owner = id (CLI/service writes bypass via service role).
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS profile_self ON public.profiles;
CREATE POLICY profile_self ON public.profiles FOR ALL
  USING (id = current_setting('app.current_owner', true)::uuid)
  WITH CHECK (id = current_setting('app.current_owner', true)::uuid);

-- cli_logins: service-role only — RLS enabled with no app policy denies the app role.
ALTER TABLE public.cli_logins ENABLE ROW LEVEL SECURITY;

-- runner_usage_sessions: platform billing data — service-role only (RLS enabled
-- with no app policy denies the app role; access via getServiceDb + the SECURITY
-- DEFINER session functions).
ALTER TABLE public.runner_usage_sessions ENABLE ROW LEVEL SECURITY;

-- ── Contract formation and consumer rights (#2372) ────────────────────────────────
-- legal_acceptance and commerce_order are EVIDENCE of what a person agreed to. They are
-- written only by the server actions through getServiceDb, and read only by those same
-- actions and by a future export/erasure path — never by a request-scoped app-role query.
--
-- So: RLS enabled with NO app policy, which denies the app role outright. That is a
-- stronger position than an owner-scoped policy would be, and it is the correct one here
-- for a reason specific to these tables: an owner-scoped policy would let a compromised
-- app-role session UPDATE its own acceptance rows, and a record the subject can rewrite is
-- not evidence of anything. Same reasoning as runner_usage_sessions above.
--
-- Erasure (#2373) will reach them through a service-role path that records WHAT it erased,
-- because the acceptance underpinning a live contract is retained on a legal-obligation
-- basis rather than deleted on request.
ALTER TABLE public.legal_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_order ENABLE ROW LEVEL SECURITY;

-- ── Privacy operations (#2373) ────────────────────────────────────────────────────
-- privacy_case / privacy_case_event / privacy_erasure_tombstone hold the record of who
-- exercised a right and what was done about it. Service-role only: RLS enabled with NO
-- app policy denies the app role outright.
--
-- That is stricter than owner-scoping, and deliberately so for a reason specific to these
-- tables. A privacy case may concern a person who is in NO organization, or one who has
-- left; an owner-scoped policy would either leak those rows to whichever tenant last held
-- them, or hide a person's own case from the only path that can answer it. Neither is
-- acceptable, so the app role reads none of it and every access goes through the reviewed
-- server actions.
ALTER TABLE public.privacy_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_case_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.privacy_erasure_tombstone ENABLE ROW LEVEL SECURITY;

-- privacy_case_event is APPEND-ONLY, absolutely.
--
-- Unlike authz_activity_log there is no legitimate deleter: the ledger is the evidence that
-- a legal process was followed, and it has no retention window to prune against — a case's
-- history outlives the data the case was about, precisely so the erasure can be proven
-- afterwards. So UPDATE, DELETE and TRUNCATE are all rejected, with no GC escape hatch.
-- Rows go when the case does, by the ON DELETE CASCADE from privacy_case, which is a
-- deliberate act on the parent rather than an edit to the history.
CREATE OR REPLACE FUNCTION public.privacy_case_event_worm()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'privacy_case_event is append-only: % is not permitted. The ledger is the evidence that a data-subject request was handled lawfully; an editable history evidences nothing.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS privacy_case_event_no_mutate ON public.privacy_case_event;
CREATE TRIGGER privacy_case_event_no_mutate
  BEFORE UPDATE OR DELETE ON public.privacy_case_event
  FOR EACH ROW EXECUTE FUNCTION public.privacy_case_event_worm();

DROP TRIGGER IF EXISTS privacy_case_event_no_truncate ON public.privacy_case_event;
CREATE TRIGGER privacy_case_event_no_truncate
  BEFORE TRUNCATE ON public.privacy_case_event
  FOR EACH STATEMENT EXECUTE FUNCTION public.privacy_case_event_worm();

-- The tombstone is the thing left behind. It must survive the erasure it records, so it is
-- append-only too — and it carries no personal data (the identifier is a SHA-256), which is
-- what makes keeping it forever the safe choice rather than the risky one.
CREATE OR REPLACE FUNCTION public.privacy_tombstone_worm()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- One field is legitimately mutable: replayed_at, stamped when a restore re-applies the
  -- erasure. Everything else about a tombstone is history.
  IF TG_OP = 'UPDATE'
     AND NEW.subject_email_sha256 IS NOT DISTINCT FROM OLD.subject_email_sha256
     AND NEW.erased_user_id       IS NOT DISTINCT FROM OLD.erased_user_id
     AND NEW.case_reference       IS NOT DISTINCT FROM OLD.case_reference
     AND NEW.erased_at            IS NOT DISTINCT FROM OLD.erased_at
     AND NEW.scope::text          IS NOT DISTINCT FROM OLD.scope::text THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'privacy_erasure_tombstone is append-only except for replayed_at: % is not permitted. A tombstone that can be removed lets a backup restore silently reinstate erased data.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS privacy_tombstone_no_mutate ON public.privacy_erasure_tombstone;
CREATE TRIGGER privacy_tombstone_no_mutate
  BEFORE UPDATE OR DELETE ON public.privacy_erasure_tombstone
  FOR EACH ROW EXECUTE FUNCTION public.privacy_tombstone_worm();

DROP TRIGGER IF EXISTS privacy_tombstone_no_truncate ON public.privacy_erasure_tombstone;
CREATE TRIGGER privacy_tombstone_no_truncate
  BEFORE TRUNCATE ON public.privacy_erasure_tombstone
  FOR EACH STATEMENT EXECUTE FUNCTION public.privacy_tombstone_worm();

-- Public catalogs: readable by anyone; writes only via service role.
ALTER TABLE public.connectors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connectors_read ON public.connectors;
CREATE POLICY connectors_read ON public.connectors FOR SELECT USING (true);
ALTER TABLE public.runner_releases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runner_releases_read ON public.runner_releases;
CREATE POLICY runner_releases_read ON public.runner_releases FOR SELECT USING (true);

-- One-time backfill for the post-signup /onboarding gate: mark every user that
-- predates the onboarding flow as already onboarded, so only brand-new signups
-- (created after the cutoff, onboarding_completed_at = NULL) are routed through
-- /onboarding. Cutoff-guarded so this is safe to re-run on every migrate and never
-- touches accounts created after the feature shipped.
UPDATE public."user"
   SET onboarding_completed_at = created_at
 WHERE onboarding_completed_at IS NULL
   AND created_at < TIMESTAMPTZ '2026-06-25 00:00:00+00';

-- Self-heal cloud_identities.status from the legacy is_verified flag (status shipped
-- in 0035). Idempotent: only verified rows still marked anything other than connected.
UPDATE public.cloud_identities
   SET status = 'connected'
 WHERE is_verified = true AND status <> 'connected';

-- ── Structured resource classification (Workstream B) ──────────────────────────────
-- classification_dimension is an "owned" table (has an author, created_by); its coarse
-- tenancy org_id is backfilled from created_by the same way set_org_id backfills owned
-- tables from user_id (community: org_id = author = personal org). The server actions
-- always set org_id explicitly (real orgs), so this trigger is the community fall-back.
CREATE OR REPLACE FUNCTION public.classification_set_org_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS NULL THEN NEW.org_id = NEW.created_by; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS classification_dimension_set_org_id ON public.classification_dimension;
CREATE TRIGGER classification_dimension_set_org_id BEFORE INSERT ON public.classification_dimension
  FOR EACH ROW EXECUTE FUNCTION public.classification_set_org_id();
UPDATE public.classification_dimension SET org_id = created_by WHERE org_id IS NULL;

-- Dimensions: coarse org-isolation owner_all (org_id = current_org). No per-user column —
-- classification is org-wide taxonomy, so the blast wall is purely org-scoped; the PDP
-- (org:view / org:edit in the server actions) is the fine-grained gate.
ALTER TABLE public.classification_dimension ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_all ON public.classification_dimension;
CREATE POLICY owner_all ON public.classification_dimension FOR ALL
  USING (org_id = current_setting('app.current_org', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org', true)::uuid);

-- Values + assignments: child tables whose tenancy flows through the parent dimension
-- (mirrors the project child-table pattern that scopes via public.projects). org_id is
-- also stored denormalized (indexed) but the RLS wall is the parent membership.
DO $$
DECLARE tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['classification_value','classification_assignment']) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON public.%I', tbl);
    EXECUTE format(
      'CREATE POLICY owner_all ON public.%I FOR ALL
         USING (dimension_id IN (SELECT id FROM public.classification_dimension
                WHERE org_id = current_setting(''app.current_org'', true)::uuid))
         WITH CHECK (dimension_id IN (SELECT id FROM public.classification_dimension
                WHERE org_id = current_setting(''app.current_org'', true)::uuid))', tbl);
  END LOOP;
END $$;

-- ============================================================================
-- E0 tofu-state HTTP-backend locking
-- ----------------------------------------------------------------------------
-- Advisory locks for the console tofu-state proxy (see lib/db/schema/tofu-state.ts).
-- acquire steals only an EXPIRED lock; a steal rotates lock_id + bumps generation, so a
-- slow writer's stale ?ID= is rejected by validate_tofu_state_lock (fencing) → no lost update.
-- SECURITY DEFINER: the service role calls these from runner-authed routes; no direct client access.

DROP FUNCTION IF EXISTS public.acquire_tofu_state_lock(TEXT, TEXT, UUID, JSONB, INT);
CREATE OR REPLACE FUNCTION public.acquire_tofu_state_lock(
    p_state_key TEXT, p_lock_id TEXT, p_job_id UUID, p_info JSONB, p_ttl_seconds INT
) RETURNS TABLE(acquired BOOLEAN, holder JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO public.tofu_state_locks (state_key, lock_id, generation, job_id, info, locked_at, expires_at)
    VALUES (p_state_key, p_lock_id, 1, p_job_id, p_info, now(), now() + make_interval(secs => p_ttl_seconds))
    ON CONFLICT (state_key) DO UPDATE
        SET lock_id = EXCLUDED.lock_id,
            generation = public.tofu_state_locks.generation + 1,
            job_id = EXCLUDED.job_id,
            info = EXCLUDED.info,
            locked_at = now(),
            expires_at = EXCLUDED.expires_at
        WHERE public.tofu_state_locks.expires_at < now();
    IF FOUND THEN
        acquired := TRUE; holder := NULL; RETURN NEXT; RETURN;
    END IF;
    -- Upsert affected no row → a live lock is held by someone else; report the current holder.
    SELECT FALSE, l.info INTO acquired, holder FROM public.tofu_state_locks l WHERE l.state_key = p_state_key;
    IF NOT FOUND THEN acquired := FALSE; holder := NULL; END IF;
    RETURN NEXT;
END;
$$;

DROP FUNCTION IF EXISTS public.release_tofu_state_lock(TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.release_tofu_state_lock(p_state_key TEXT, p_lock_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    DELETE FROM public.tofu_state_locks WHERE state_key = p_state_key AND lock_id = p_lock_id;
    RETURN FOUND;
END;
$$;

DROP FUNCTION IF EXISTS public.validate_tofu_state_lock(TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.validate_tofu_state_lock(p_state_key TEXT, p_lock_id TEXT)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.tofu_state_locks
        WHERE state_key = p_state_key AND lock_id = p_lock_id AND expires_at > now()
    );
$$;

-- Staff/system-only force-unlock for a stranded state lock (e.g. after a cancelled apply's
-- runner was SIGKILLed before it could UNLOCK). It must NEVER be a naive DELETE: a zombie
-- writer from the killed apply could still be mid-flight, and its state-write POST presents
-- the OLD lock_id as the fencing token. So we ROTATE lock_id (invalidating that fence — the
-- zombie's ?ID= now fails validate_tofu_state_lock) and BUMP the monotonic generation (the
-- same steal invariant acquire_tofu_state_lock uses), then expire the row so a fresh apply
-- can immediately steal it. Returns whether a lock existed for the key. Not a customer action
-- (no alethia_app GRANT) — invoked by the service role from a staff/system path.
DROP FUNCTION IF EXISTS public.force_release_tofu_state_lock(TEXT);
CREATE OR REPLACE FUNCTION public.force_release_tofu_state_lock(p_state_key TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE public.tofu_state_locks
       SET generation = generation + 1,
           lock_id = 'force-released-' || gen_random_uuid()::text,
           info = COALESCE(info, '{}'::jsonb) || jsonb_build_object('force_released_at', now()),
           expires_at = now() - INTERVAL '1 second'
     WHERE state_key = p_state_key;
    RETURN FOUND;
END;
$$;

-- force_release is a break-glass / operator action, NOT part of the normal tofu-state lock
-- lifecycle (acquire/validate/release). Postgres grants EXECUTE to PUBLIC by default, so without
-- this REVOKE the least-privilege runtime role (alethia_app, used by the RLS + tofu-state-proxy
-- paths) could force-release a live lock and fence a running apply. The superuser service role
-- (getServiceDb → forceReleaseStateLock) owns the function and is unaffected by the revoke.
REVOKE EXECUTE ON FUNCTION public.force_release_tofu_state_lock(TEXT) FROM PUBLIC;

-- Releases any state lock still held by a job that has just gone TERMINAL. Called on the runner's
-- terminal status callback, at which point the tofu process in that runner has already exited — so
-- there is no live writer, only a lock nobody will ever unlock.
--
-- Why this must exist: the ONLY normal release is tofu's own UNLOCK call. A tofu that is killed (a
-- cancel, an OOM, a runner crash) never sends it, so the lock strands for the full 3h TTL and every
-- later job on that state — including the DESTROY sent to clean up the mess — fails with "state
-- already locked". Observed for real, and the manual fix (deleting the lock row) is far worse: it
-- fences a still-live writer mid-write and strands the resources it had already created.
--
-- So: rotate + bump the fencing generation exactly like force_release (NEVER a naive delete) — a
-- zombie writer's stale ?ID= then fails the fence instead of corrupting state — and scope strictly to
-- locks this job holds. A lock held by a DIFFERENT job is left alone.
DROP FUNCTION IF EXISTS public.release_tofu_state_locks_for_job(UUID);
CREATE OR REPLACE FUNCTION public.release_tofu_state_locks_for_job(p_job_id UUID)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE released INTEGER;
BEGIN
    UPDATE public.tofu_state_locks
       SET generation = generation + 1,
           lock_id = 'job-terminal-released-' || gen_random_uuid()::text,
           info = COALESCE(info, '{}'::jsonb)
                  || jsonb_build_object('released_at', now(), 'released_by', 'job-terminal'),
           expires_at = now() - INTERVAL '1 second'
     WHERE job_id = p_job_id;
    GET DIAGNOSTICS released = ROW_COUNT;
    RETURN released;
END;
$$;

-- Same reasoning as force_release: a lifecycle short-circuit the least-privilege runtime role must
-- not be able to invoke (it could otherwise fence a live apply). Service role only.
REVOKE EXECUTE ON FUNCTION public.release_tofu_state_locks_for_job(UUID) FROM PUBLIC;

-- Per-VM fleet bootstrap token redemption (E0 0b). Atomic + instance-bound + reusable-within-TTL:
-- the first redeem binds instance_id; the SAME instance may re-redeem (restart / lost-response
-- retry), a DIFFERENT instance or an expired token is rejected (ok=false). Returns the currently
-- linked runner_id (NULL on first use). SECURITY DEFINER: called from the runner-facing bootstrap
-- route; the token is a shared secret only for the one VM it was minted for.
DROP FUNCTION IF EXISTS public.redeem_bootstrap_token(TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.redeem_bootstrap_token(p_token_hash TEXT, p_instance_id TEXT)
RETURNS TABLE(ok BOOLEAN, runner_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE public.runner_bootstrap_tokens t
       SET instance_id = p_instance_id
     WHERE t.token_hash = p_token_hash
       AND t.expires_at > now()
       AND (t.instance_id IS NULL OR t.instance_id IS NOT DISTINCT FROM p_instance_id)
    RETURNING t.runner_id INTO runner_id;
    ok := FOUND;
    RETURN NEXT;
END;
$$;

-- ----------------------------------------------------------------------------
-- Guarded env-status transition (compare-and-swap). EVERY write to
-- project_environments.status routes through here (lib/db/env-status.ts) so a
-- late / racing runner callback can't clobber a newer terminal state
-- (last-writer-wins). A single PK-indexed UPDATE gated on the current status ∈
-- p_expected_from; returns whether a row moved. FALSE = the env wasn't in a legal
-- from-state → the transition was correctly rejected (the TS caller logs + alerts,
-- and for runner callbacks never throws: a lost race must not fail a status PUT).
-- It never raises on a no-op. NOT security-definer — it runs with the caller's RLS
-- (service role bypasses; an owner-scoped tx is policy-checked), matching how the
-- sibling env writes are scoped. p_job_id is carry-through context for the caller's
-- structured log / audit, deliberately not written here.
DROP FUNCTION IF EXISTS public.set_env_status(UUID, TEXT[], TEXT, UUID);
CREATE OR REPLACE FUNCTION public.set_env_status(
    p_env_id UUID, p_expected_from TEXT[], p_to TEXT, p_job_id UUID DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
    UPDATE public.project_environments
       SET status = p_to::public.project_status, updated_at = now()
     WHERE id = p_env_id
       AND status = ANY (p_expected_from::public.project_status[]);
    RETURN FOUND;
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_env_status(UUID, TEXT[], TEXT, UUID) TO alethia_app;

-- ── Retention GC (B2c reconcile loop) ───────────────────────────────────────────────
-- Bounded, best-effort garbage collection wired into the supervised reconcile loop
-- (lib/reconcile/gc.ts). Each call deletes at most p_limit rows so it can NEVER take a
-- table-wide lock or run long — the loop calls it every tick, so a backlog drains over
-- several passes and then no-ops. FOR UPDATE SKIP LOCKED makes concurrent app instances
-- safe: two loops racing the same window claim disjoint rows instead of blocking.

-- Delete job_logs older than the retention window (default 30d). Oldest first by
-- created_at; the created_at btree (idx_job_logs_created_at) serves the range filter +
-- ordered LIMIT as an index scan, so an empty steady-state window costs one index probe
-- instead of a full pkey/seq scan every 15m (mirrors gc_fleet_actions). Same physical set
-- as oldest-by-id — id-order == insert-order == created_at-order — so semantics are
-- unchanged. job_logs has a FK to jobs ON DELETE CASCADE, but we only delete the log rows
-- themselves here.
DROP FUNCTION IF EXISTS public.gc_job_logs(INTERVAL, INTEGER);
CREATE OR REPLACE FUNCTION public.gc_job_logs(
    p_age INTERVAL DEFAULT INTERVAL '30 days', p_limit INTEGER DEFAULT 5000
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
    WITH doomed AS (
        SELECT jl.id
        FROM public.job_logs jl
        WHERE jl.created_at < now() - p_age
        ORDER BY jl.created_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.job_logs jl
    USING doomed d
    WHERE jl.id = d.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.gc_job_logs(INTERVAL, INTEGER) TO alethia_app;

-- Delete fleet_actions ledger rows older than the retention window (default 90d). The
-- #345 durable fleet-actions ledger has no GC of its own; unbounded it grows forever.
-- Oldest first by created_at; the created_at-leading index (idx_fleet_actions_created_at)
-- serves the range filter + ordered LIMIT as an index scan (the (provider, created_at)
-- index CANNOT — its leading provider column is unconstrained here), keeping the GC cheap.
DROP FUNCTION IF EXISTS public.gc_fleet_actions(INTERVAL, INTEGER);
CREATE OR REPLACE FUNCTION public.gc_fleet_actions(
    p_age INTERVAL DEFAULT INTERVAL '90 days', p_limit INTEGER DEFAULT 5000
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
    WITH doomed AS (
        SELECT fa.id
        FROM public.fleet_actions fa
        WHERE fa.created_at < now() - p_age
        ORDER BY fa.created_at
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.fleet_actions fa
    USING doomed d
    WHERE fa.id = d.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.gc_fleet_actions(INTERVAL, INTEGER) TO alethia_app;

-- Delete authz_activity_log rows older than the retention window (default 365d). The PDP writes
-- this append-only governance/audit log on EVERY enforce(), so unbounded it grows forever; a
-- 365-day window keeps a full year of decisions/denials (SOC2-friendly audit retention) and
-- trims the rest. Oldest first by ts; the ts-leading index (idx_authz_activity_ts) serves the
-- range filter + ordered LIMIT as an index scan (the (org_id, id) read index CANNOT — its leading
-- org_id column is unconstrained here), so an empty steady-state window costs one index probe
-- instead of a seq scan every pass (mirrors gc_fleet_actions). FOR UPDATE SKIP LOCKED makes
-- concurrent app instances safe: two loops racing the same window claim disjoint rows.
DROP FUNCTION IF EXISTS public.gc_authz_activity_log(INTERVAL, INTEGER);
CREATE OR REPLACE FUNCTION public.gc_authz_activity_log(
    p_age INTERVAL DEFAULT INTERVAL '365 days', p_limit INTEGER DEFAULT 5000
) RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INTEGER;
BEGIN
    -- Flag this transaction as the retention GC so the append-only WORM trigger
    -- (authz_activity_log_worm, below) permits the pruning DELETE. SET LOCAL is
    -- transaction-scoped, so it's automatically cleared when the GC txn ends and
    -- can't leak the exemption to any later statement. No other caller sets this.
    PERFORM set_config('app.authz_gc', 'on', true);
    WITH doomed AS (
        SELECT al.id
        FROM public.authz_activity_log al
        WHERE al.ts < now() - p_age
        ORDER BY al.ts
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.authz_activity_log al
    USING doomed d
    WHERE al.id = d.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION public.gc_authz_activity_log(INTERVAL, INTEGER) TO alethia_app;

-- ── authz_activity_log: tenant-scoped RLS + GC-aware append-only WORM ─────────────────────────────
-- The PDP governance/audit log is written on every enforce() and read by the Activity viewer /
-- CLI. All three real paths — recordActivity (lib/authz/activity.ts), getActivityLog
-- (app/server/actions/activity.ts), and gc_authz_activity_log (via the reconcile loop) — run under
-- the BYPASSRLS service role (getServiceDb), so this table previously had NO tenant RLS and the app
-- role held the blanket GRANT (SELECT/INSERT/UPDATE/DELETE) at the top of this file. Two gaps closed:
--
-- 1. DEFENSE-IN-DEPTH TENANT RLS. Enable RLS with an org-scoped SELECT policy (mirroring audit_log's
--    key) and NO insert/update/delete policy. The service role bypasses RLS so the real read/write
--    paths are unaffected; but should the least-privilege alethia_app role ever touch this table, a
--    SELECT is org-filtered and every write/mutation is denied.
ALTER TABLE public.authz_activity_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS authz_activity_select ON public.authz_activity_log;
CREATE POLICY authz_activity_select ON public.authz_activity_log FOR SELECT
  USING (org_id = current_setting('app.current_org', true)::uuid);

-- 2. APPEND-ONLY WORM — but GC-aware. audit_log stays immutable via RLS alone (no UPDATE/DELETE
--    policy), which binds only the app role, NOT the BYPASSRLS service role that writes this log. So
--    (like breakglass_audit) a trigger makes the table immutable regardless of the caller's role. The
--    difference from breakglass: this log HAS a legitimate deleter — the retention GC. An absolute
--    WORM would block the GC's own prune. So the trigger is GC-aware: UPDATE and TRUNCATE are never
--    permitted; DELETE is permitted ONLY while app.authz_gc='on', which ONLY gc_authz_activity_log
--    sets (above), for its own transaction. This closes the casual/app/service tamper path while
--    keeping retention working. (A superuser could still DISABLE the trigger or set app.authz_gc by
--    hand — an out-of-band, itself-auditable act, not reachable from application code.) The INSERT
--    append path is untouched, so recordActivity keeps writing.
CREATE OR REPLACE FUNCTION public.authz_activity_log_worm()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only the retention GC may prune, and only while it has flagged its own txn.
    IF current_setting('app.authz_gc', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION
        'authz_activity_log is append-only: DELETE is only permitted by the retention GC (gc_authz_activity_log)'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD; -- permitted GC delete proceeds (BEFORE-row trigger: RETURN OLD = allow)
  END IF;
  -- UPDATE (row) and TRUNCATE (statement): no legitimate case exists — always reject.
  RAISE EXCEPTION 'authz_activity_log is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS authz_activity_log_no_mutate ON public.authz_activity_log;
CREATE TRIGGER authz_activity_log_no_mutate
  BEFORE UPDATE OR DELETE ON public.authz_activity_log
  FOR EACH ROW EXECUTE FUNCTION public.authz_activity_log_worm();

DROP TRIGGER IF EXISTS authz_activity_log_no_truncate ON public.authz_activity_log;
CREATE TRIGGER authz_activity_log_no_truncate
  BEFORE TRUNCATE ON public.authz_activity_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.authz_activity_log_worm();

-- Belt-and-braces: revoke the mutation grants outright (the top-of-file blanket GRANT hands the app
-- role UPDATE/DELETE; strip them here) so the privilege isn't even present. The trigger is the hard
-- stop; this removes the grant too. INSERT/SELECT stay revoke-free (SELECT is RLS-scoped above; the
-- app role never inserts here — the service role does).
REVOKE UPDATE, DELETE, TRUNCATE ON public.authz_activity_log FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alethia_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON public.authz_activity_log FROM alethia_app';
  END IF;
END $$;

-- ── Break-glass (privileged incident recovery) — the most security-sensitive surface ─────────────
-- All three tables are SERVICE-ROLE ONLY: RLS is enabled with NO app policy (the cli_logins /
-- runner_usage_sessions idiom), so the least-privilege alethia_app role — the one behind every
-- customer request and the tofu-state proxy — can neither read nor write them. Break-glass code
-- reaches them exclusively through getServiceDb() behind the ALETHIA_BREAKGLASS_ENABLED +
-- BREAKGLASS_OPERATORS gate. Defense in depth: even if a bug handed alethia_app one of these tables,
-- RLS denies it.
ALTER TABLE public.breakglass_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.breakglass_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.breakglass_approval ENABLE ROW LEVEL SECURITY;

-- breakglass_audit is APPEND-ONLY and must stay immutable even against the service role (a
-- compromised/rogue operator path or a careless migration). The customer audit_log relies on RLS
-- alone (SELECT/INSERT policies, no UPDATE/DELETE) — that only binds the app role, NOT the
-- BYPASSRLS service role that break-glass uses. So we add a trigger-based WORM guard: any UPDATE,
-- DELETE, or TRUNCATE raises, regardless of the caller's role. (A superuser could still deliberately
-- DISABLE the trigger or flip session_replication_role — that is an out-of-band, itself-auditable act,
-- not something reachable from application code; this closes the in-app tamper path.) The append
-- INSERT path is unaffected, so the write-before-act invariant still works.
CREATE OR REPLACE FUNCTION public.breakglass_audit_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'breakglass_audit is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS breakglass_audit_no_mutate ON public.breakglass_audit;
CREATE TRIGGER breakglass_audit_no_mutate
  BEFORE UPDATE OR DELETE ON public.breakglass_audit
  FOR EACH ROW EXECUTE FUNCTION public.breakglass_audit_immutable();

DROP TRIGGER IF EXISTS breakglass_audit_no_truncate ON public.breakglass_audit;
CREATE TRIGGER breakglass_audit_no_truncate
  BEFORE TRUNCATE ON public.breakglass_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.breakglass_audit_immutable();

-- Belt-and-braces: revoke UPDATE/DELETE/TRUNCATE from PUBLIC and the app role outright, so the
-- privilege isn't even granted (the trigger is the hard stop; this removes the grant too).
REVOKE UPDATE, DELETE, TRUNCATE ON public.breakglass_audit FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alethia_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON public.breakglass_audit FROM alethia_app';
    -- The app role has no business touching any break-glass table at all.
    EXECUTE 'REVOKE ALL ON public.breakglass_session, public.breakglass_audit, public.breakglass_approval FROM alethia_app';
  END IF;
END $$;

-- ── Platform-operator plane (Enterprise contracts + their audit) ─────────────────────────────────
-- SERVICE-ROLE ONLY, exactly like break-glass: RLS is enabled with NO app policy, so the
-- least-privilege alethia_app role (the one behind every customer request) can neither read nor
-- write these. They are written solely by the staff app (apps/admin) over the service connection;
-- the console never touches them (it only owns the migration).
ALTER TABLE public.enterprise_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_audit      ENABLE ROW LEVEL SECURITY;

-- platform_audit is APPEND-ONLY (WORM). Unlike authz_activity_log this log has NO retention GC —
-- there is no legitimate deleter — so the trigger is ABSOLUTE (the breakglass_audit pattern):
-- UPDATE, DELETE and TRUNCATE are always rejected. Triggers are NOT bypassed by BYPASSRLS, so the
-- row is immutable even against the service role that writes it. INSERT is untouched, so the
-- attempt/result append path keeps working.
CREATE OR REPLACE FUNCTION public.platform_audit_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS platform_audit_no_mutate ON public.platform_audit;
CREATE TRIGGER platform_audit_no_mutate
  BEFORE UPDATE OR DELETE ON public.platform_audit
  FOR EACH ROW EXECUTE FUNCTION public.platform_audit_immutable();

DROP TRIGGER IF EXISTS platform_audit_no_truncate ON public.platform_audit;
CREATE TRIGGER platform_audit_no_truncate
  BEFORE TRUNCATE ON public.platform_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.platform_audit_immutable();

-- Belt-and-braces: strip the mutation grants outright, and keep the app role out of both tables.
REVOKE UPDATE, DELETE, TRUNCATE ON public.platform_audit FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'alethia_app') THEN
    EXECUTE 'REVOKE ALL ON public.enterprise_contract, public.platform_audit FROM alethia_app';
  END IF;
END $$;
