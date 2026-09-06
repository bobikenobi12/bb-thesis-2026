// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { sql } from "drizzle-orm";
import {
	index,
	numeric,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { cloudIdentities } from "./identities";

// Project — a declarative infrastructure config a user writes; the top-level **Project** under
// an org. M1: a project is an *app* that owns N
// environments (project_environments) — the environment identity (name/stage) and the
// per-environment provisioning `status` live in project_environments. region / iac_version carry
// NO default: multi-cloud means the provider dictates valid regions, and the IaC version is
// chosen explicitly.
export const projects = pgTable(
	"projects",
	{
		id: uuid().primaryKey().defaultRandom(),
		user_id: uuid().notNull(),
		// Coarse tenancy scope (RLS blast wall); community org_id = user_id via trigger.
		org_id: uuid(),
		cloud_identity_id: uuid().references(() => cloudIdentities.id, {
			onDelete: "set null",
		}),
		// Display name, and the CLI's addressing token — `alethia project get <name>`
		// resolves on this. UNIQUE per org, case-insensitively (see the index below).
		project_name: text().notNull(),
		// URL slug (C2), unique per org. Nullable for the additive add + backfill
		// (migration 0023); the app always sets it on create.
		slug: text(),
		region: text().notNull(),
		iac_version: text().notNull(),
		estimated_monthly_cost: numeric({ precision: 12, scale: 2, mode: "number" }),
		created_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
		updated_at: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		unique("projects_org_id_slug_key").on(t.org_id, t.slug),
		// #3145. `project_name` carried NO uniqueness, and duplicates were the DESIGNED
		// behaviour of two write paths: create de-duplicated the SLUG and inserted the name
		// verbatim, and rename deliberately let one project take another's name. So
		// `alethia project get <name>` resolved a non-unique filter and silently returned
		// the oldest match — reading the wrong project's region, cluster endpoint and apps
		// repo. For a provisioning tool that is worse than an error, so the ambiguity is
		// removed at the source rather than reported at the edge.
		//
		// CASE-INSENSITIVE deliberately. `slugify` NFKD-folds and lowercases, so "Api" and
		// "api" already collapse to the same slug and become `api` / `api-2` — two projects
		// whose names differ only in case are the confusing case, not a legitimate one.
		//
		// `org_id` is nullable in the column list and is nonetheless safe to key on: every
		// insert into `projects` fires the `projects_set_org_id` BEFORE INSERT trigger
		// (programmables.sql), which coalesces to the session org and then to `user_id`,
		// itself NOT NULL. programmables.sql also backfills any historical NULL on every
		// migrate run — which is why migration 0150 does that backfill FIRST: migrations run
		// BEFORE programmables (scripts/migrate.mjs), so without it that later UPDATE could
		// collide two NULL-org rows into this index and fail the whole migrate step.
		uniqueIndex("projects_org_id_project_name_key").on(
			t.org_id,
			sql`lower(${t.project_name})`,
		),
		index("idx_projects_user").on(t.user_id),
		index("idx_projects_org").on(t.org_id),
		index("idx_projects_cloud_identity").on(t.cloud_identity_id),
		// Cursor paging (lib/cli/paging.ts) — same shape as idx_jobs_org_cursor. The project
		// list (`GET /api/cli/configurations`) already orders by created_at DESC within an
		// org; this adds the id tiebreak the keyset predicate compares on, so the page query
		// is one range scan and not a scan plus a sort.
		index("idx_projects_org_cursor").on(
			t.org_id,
			t.created_at.desc(),
			t.id.desc(),
		),
	],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
