// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type {
	ExecutionMetadata,
	VerifyOverrideInput,
} from "@/types/jsonb.types";
import {
	cloudProvider,
	jobInitiator,
	logStreamType,
	provisionJobStatus,
	provisionJobType,
} from "./enums";
import { cloudIdentities } from "./identities";
import { runners } from "./runners";
import { projects } from "./projects";
import { projectEnvironments } from "./project-environments";

// Unified provisioning job queue. Claimed atomically by runners via the
// claim_next_job RPC (FOR UPDATE SKIP LOCKED). Tenancy scope is `org_id`.
export const jobs = pgTable(
	"jobs",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid().notNull(),
		// Coarse tenancy scope (RLS blast wall); community org_id = user_id via trigger.
		org_id: uuid(),
		project_id: uuid().references(() => projects.id, { onDelete: "set null" }),
		// M1: which environment of the project this job provisions. NULL for
		// runner-lifecycle / connection-test jobs (no project). On delete set null so
		// removing an environment doesn't cascade away its job history.
		environment_id: uuid().references(() => projectEnvironments.id, {
			onDelete: "set null",
		}),
		cloud_identity_id: uuid().references(() => cloudIdentities.id, {
			onDelete: "set null",
		}),
		job_type: provisionJobType().notNull(),
		// Who/what enqueued this job. `user` (a person's interactive action) is the ONLY value the
		// free-tier daily job quota counts; `system` (reconcile/drift/probe/reaper/auto-heal/build-chain)
		// and `operator` (break-glass) never count. Defaults to `system` so a missed stamp fails open
		// (under-counts) rather than letting a background insert drain a free org's quota. Stamped
		// explicitly at every user enqueue site; see lib/billing/job-quota.ts.
		initiated_by: jobInitiator().notNull().default("system"),
		// Intentionally polymorphic per job_type: a frozen buildConfigSnapshot for
		// project jobs, a runner-deploy config for runner-lifecycle jobs, or {} for
		// connection-test/fetch jobs — so an open JSON record is the correct type.
		config_snapshot: jsonb()
			.$type<Record<string, unknown>>()
			.default({})
			.notNull(),
		configuration_hash: text(),
		// HMAC-SHA256 of the canonical config_snapshot, stamped at enqueue and re-verified at claim
		// (lib/runners/snapshot-sig.ts). Authenticity — a tampered snapshot row can't be re-signed
		// without the app key. NULL on legacy rows / when signing is off (verify then no-ops).
		config_snapshot_sig: text(),
		status: provisionJobStatus().default("QUEUED").notNull(),
		// Scheduler claim order (higher first): plan band + job-type bump, derived at
		// insert by the jobs_set_scheduling trigger. See programmables.sql.
		priority: smallint().notNull().default(0),
		// Denormalized from cloud_identities.provider (via the same trigger) so the
		// scheduler + per-cloud routing can filter without a join.
		provider: cloudProvider(),
		// Self-managed token clouds: the credential lives only in the customer's
		// self-hosted runner env, never in Alethia. Managed runners must NOT claim
		// these (they'd lack the token) — claim_next_job filters them out.
		requires_self_runner: boolean().notNull().default(false),
		runner_id: uuid().references(() => runners.id, { onDelete: "set null" }),
		assigned_runner_id: uuid().references(() => runners.id, {
			onDelete: "set null",
		}),
		plan_job_id: uuid().references((): AnyPgColumn => jobs.id, {
			onDelete: "set null",
		}),
		claimed_at: timestamp({ withTimezone: true }),
		started_at: timestamp({ withTimezone: true }),
		completed_at: timestamp({ withTimezone: true }),
		// Poison-job cap. recover_stale_jobs increments `attempts` each time it requeues a
		// stale job (dead runner OR stalled-but-alive); once attempts >= max_attempts it fails
		// the job TERMINAL instead of requeuing forever — a job that repeatedly kills its runner
		// no longer churns the queue indefinitely.
		attempts: integer().notNull().default(0),
		max_attempts: integer().notNull().default(5),
		// Progress heartbeat — distinct from runner LIVENESS (runners.last_heartbeat). The runner
		// stamps this as it makes real forward progress (a stage transition / log flush, via
		// update_job_status + insert_job_log). A runner that heartbeats but hangs mid-apply leaves
		// progress_at stale; recover_stale_jobs treats a long progress stall as recoverable.
		progress_at: timestamp({ withTimezone: true }),
		// When this job's managed-runner minutes were reported to the billing meter
		// (Stripe). Set once on terminal status → idempotent (never double-billed).
		usage_reported_at: timestamp({ withTimezone: true }),
		error_message: text(),
		execution_metadata: jsonb().$type<ExecutionMetadata>(),
		// Authorized, time-boxed waiver of failing verification controls for this
		// DEPLOY job (elench). NULL = no waiver (any hard control failure blocks apply).
		verify_override: jsonb().$type<VerifyOverrideInput>(),
		// W3C traceparent (`00-<32hex trace-id>-<16hex span-id>-01`) minted at enqueue.
		// Flows enqueue → claim → runner so console + runner logs/spans share one trace.
		traceparent: text(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_jobs_user").on(t.user_id),
		index("idx_jobs_org").on(t.org_id),
		// Cursor paging (lib/cli/paging.ts). The keyset page query is
		//   WHERE org_id = $1 AND (created_at, id) < ($2, $3)
		//   ORDER BY created_at DESC NULLS LAST, id DESC NULLS LAST LIMIT n
		// and this is the index that CAN answer it as one range scan with NO sort node. Two things
		// have to line up for that. The tiebreak column must be IN the index, which is why
		// idx_jobs_org (a prefix of this one) plus a sort is not equivalent. And the NULLS LAST is
		// not decoration: drizzle emits `DESC` here as DESC NULLS LAST, while Postgres defaults an
		// ORDER BY DESC to NULLS FIRST — pair this index with a plain `DESC` order and the planner
		// adds the sort back. Asserted, not assumed: the integration suite's SMALL-fixture guard
		// EXPLAINs the real query with seqscan disabled, fails on a Sort node, and carries the
		// plain `DESC` form as a control that must still plan one.
		//
		// Which plan Postgres then CHOOSES is a different question, and a cardinality-dependent
		// one — the composite index orders the rows for free, the narrower idx_jobs_org plus a
		// top-N sort is cheaper to walk, and the winner moves with the statistics. A second
		// integration guard seeds a large fixture and EXPLAINs with the planner UNCONSTRAINED,
		// asserting only that the page is still reached through an org index rather than a seq
		// scan. It pins neither index over the other, because neither is a defect.
		index("idx_jobs_org_cursor").on(t.org_id, t.created_at.desc(), t.id.desc()),
		// Serves the free-tier daily job quota's trailing-24h COUNT (lib/billing/job-quota.ts):
		// WHERE org_id=? AND initiated_by='user' AND created_at >= now()-interval '24h'. Partial on
		// the only value the quota counts, so the index stays small and the count is a single probe.
		index("idx_jobs_user_initiated")
			.on(t.org_id, t.created_at)
			.where(sql`initiated_by = 'user'`),
		// Claim index — the hot path for claim_next_job: highest priority first, then
		// oldest. (Cross-org fairness is layered on in the RPC.)
		index("idx_jobs_queue")
			.on(t.status, t.priority.desc(), t.created_at)
			.where(sql`status = 'QUEUED'`),
		index("idx_jobs_assigned_runner")
			.on(t.assigned_runner_id)
			.where(sql`assigned_runner_id IS NOT NULL`),
		// Cross-replica dedup for the drift sweeper (lib/drift/dispatch.ts): at most ONE active
		// DETECT_DRIFT job per environment. Two replicas ticking `sweepDriftSchedule` concurrently
		// would otherwise each INSERT a drift job for the same due env. Paired with an
		// `ON CONFLICT DO NOTHING` on the insert. Partial so it only constrains in-flight drift jobs —
		// once a drift job leaves QUEUED/CLAIMED/PROCESSING (SUCCESS/FAILED/CANCELLED) it drops out of
		// the index, so the env's next scheduled re-drift is free to enqueue.
		uniqueIndex("uq_jobs_active_drift_per_env")
			.on(t.environment_id)
			.where(
				sql`job_type = 'DETECT_DRIFT' AND status IN ('QUEUED', 'CLAIMED', 'PROCESSING')`,
			),
	],
);

export const jobLogs = pgTable(
	"job_logs",
	{
		id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
		job_id: uuid()
			.notNull()
			.references(() => jobs.id, { onDelete: "cascade" }),
		log_chunk: text().notNull(),
		stream_type: logStreamType().default("STDOUT").notNull(),
		// W3C traceparent carried from the job (via insert_job_log) so a log line
		// correlates to its trace without a jobs join.
		traceparent: text(),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("idx_job_logs_job_id").on(t.job_id),
		// Retention GC (gc_job_logs) range-scans created_at < now()-p_age and takes the
		// oldest first. A created_at btree serves both the range filter and the ordered
		// LIMIT as a single index scan, so an empty window costs one index probe instead
		// of a full pkey/seq scan every 15m. Mirrors idx_fleet_actions_created_at (#345).
		index("idx_job_logs_created_at").on(t.created_at),
	],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type JobLog = typeof jobLogs.$inferSelect;
