// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Project environments (M1). A project is an *app* that owns N environments, each an
// independently-provisionable deployment target. The environment's `name` feeds the
// OpenTofu/S3 state key (projectName-<name>-region/tofu.tfstate) — backfilled
// from the project's old `environment_stage` so the state path is byte-identical — and
// `status` carries the per-environment provisioning lifecycle (moved off projects.status).
// Exactly one row per project is the `is_default` representative used by single-value
// surfaces (the CLI wire, the project "Env"/status columns, the project-detail header).
// That is ENFORCED, not merely intended (#4127), and it takes two halves: the partial unique
// index below gives at-most-one, and `project_environments_one_default_check` in
// programmables.sql — a DEFERRABLE INITIALLY DEFERRED constraint trigger, because the create
// and cascade-delete paths are only consistent at COMMIT — gives at-least-one. So a project
// that HAS environments always has a default, and `find(is_default)` needs no fallback.
// A project with NO environments is a separate question this pair deliberately leaves open;
// the readers treat it as its own reported outcome, never as a guess.

import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	numeric,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import {
	environmentLifecycle,
	environmentStage,
	placementMode,
	projectStatus,
} from "./enums";
import { projectFabrics } from "./project-fabrics";
import { projects } from "./projects";

export const projectEnvironments = pgTable(
	"project_environments",
	{
		id: uuid().primaryKey().defaultRandom(),
		project_id: uuid()
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		// Coarse tenancy scope (RLS blast wall); community org_id = user_id via trigger.
		user_id: uuid().notNull(),
		org_id: uuid(),
		// Slug feeding the tofu state path + the URL (C2). Backfilled = the old stage value.
		name: text().notNull(),
		// Drives provider template defaults (dev/staging/prod knobs); distinct from `name`.
		stage: environmentStage().default("development").notNull(),
		// Per-environment provisioning lifecycle (was projects.status).
		status: projectStatus().default("DRAFT").notNull(),
		// Exactly one default per project — the representative env for single-value surfaces.
		is_default: boolean().default(false).notNull(),
		// NULL inherits projects.region.
		region: text(),
		// --- Placement: where this delivery Environment RUNS (decoupled env-model, #836) ---------
		// The Fabric (infra unit) this env is placed onto. Nullable during the transition — the
		// programmables.sql backfill creates a 1:1 Fabric per existing env and sets this; the app
		// always sets it going forward. ON DELETE SET NULL (a Fabric outlives its placements).
		fabric_id: uuid().references(() => projectFabrics.id, {
			onDelete: "set null",
		}),
		// How the env is placed on its Fabric. Default `dedicated` = the legacy env=cluster
		// behaviour (env owns its Fabric 1:1), so existing rows keep byte-identical semantics.
		placement_mode: placementMode().default("dedicated").notNull(),
		// The k8s namespace this env's workloads deploy into (the ArgoCD Application destination
		// namespace) — for `namespace`/`vcluster` placements on a shared Fabric. NULL → derived
		// from the env name at provision time. Ignored for `dedicated` (owns the whole Fabric).
		namespace: text(),
		// --- Lifecycle: persistent env vs ephemeral "sandbox" (inert seam, no reaper yet) --------
		// `persistent` = a normal long-lived environment; `ephemeral` = a disposable, TTL'd one.
		// The reaper (a drift-style reconciler) + UI build on these later; nothing reads them yet.
		lifecycle: environmentLifecycle().default("persistent").notNull(),
		// When an ephemeral environment should be auto-torn-down. NULL for persistent (and until set).
		expires_at: timestamp({ withTimezone: true }),
		// Optional projected-cost ceiling for an ephemeral environment (halt/alert when exceeded).
		cost_cap: numeric({ precision: 12, scale: 2 }),
		// --- Day-2 governance (Phase 2) ---------------------------------------------------------
		// Opt-in: on detected cloud drift, auto-queue a DEPLOY of the last-deployed design to restore
		// state. Production is always approval-gated regardless of this flag (see maybeAutoHeal).
		auto_heal: boolean().default(false).notNull(),
		last_auto_heal_at: timestamp({ withTimezone: true }),
		// Consecutive auto-heal deploy failures; drives backoff + the circuit breaker.
		auto_heal_failures: integer().default(0).notNull(),
		// --- Ephemeral reaper bookkeeping (bounded retry + backoff + give-up) --------------------
		// Consecutive DESTROY re-enqueue attempts by the ephemeral reaper for this expired env; drives
		// the exponential backoff and the give-up cap. Reset to 0 on a fresh successful DEPLOY.
		reap_attempts: integer().default(0).notNull(),
		// When the reaper last enqueued a DESTROY for this expired env — the backoff clock. NULL = the
		// reaper has never reaped it (→ no backoff, immediate first teardown).
		last_reap_at: timestamp({ withTimezone: true }),
		// Set once the reaper hits MAX_REAP_ATTEMPTS and stops re-enqueuing: the env drops out of the
		// reapable set permanently (needs manual intervention) until a fresh successful DEPLOY clears it.
		reap_gave_up_at: timestamp({ withTimezone: true }),
		// Fingerprint of the config_snapshot last SUCCESSFULLY deployed (set by finalizeDeployment).
		// Powers the predecessor-healthy gate, the soak timer, and config-vs-desired divergence.
		deployed_config_hash: text(),
		last_deployed_at: timestamp({ withTimezone: true }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("project_environments_project_id_name_key").on(t.project_id, t.name),
		// At most one default environment per project (partial unique).
		uniqueIndex("project_environments_one_default")
			.on(t.project_id)
			.where(sql`${t.is_default} = true`),
		index("idx_project_environments_project").on(t.project_id),
	],
);

export type ProjectEnvironment = typeof projectEnvironments.$inferSelect;
export type NewProjectEnvironment = typeof projectEnvironments.$inferInsert;
