// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type SQL, and, eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { authorizeCli } from "@/lib/authz/guard";
import {
	type CursorScope,
	MAX_PAGE_SIZE,
	cursorKey,
	paginate,
	parsePageOpts,
} from "@/lib/cli/paging";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { projectCluster, projectEnvironments, projects } from "@/lib/db/schema";
import { cliClustersPageResponse } from "@/lib/validations/cli-contract";

/** The collection name a `/api/cli/clusters` cursor is bound to. See {@link CursorScope}. */
const CLUSTERS_LIST = "clusters";

/**
 * Lists the org's project clusters, cursor-paged, joined with the parent project's name and
 * region and the project's default environment. Wire-locked: the flat `project_*` keys are the
 * frozen CLI contract.
 *
 * ── THE TENANCY PREDICATE, WHICH IS THE WHOLE POINT OF THIS CONVERSION ─────────────────────────
 *
 * `project_cluster` HAS NO TENANT COLUMN. `jobs` has `org_id`, so `/api/jobs` could state its
 * scope as `org_id IN (…)` and hand that same fragment to both the rows query and the count
 * (#3857). This table's schema (`lib/db/schema/project-components.ts`) carries `project_id`,
 * `environment_id`, `fabric_id` and `cloud_identity_id` and nothing else that names a tenant — a
 * cluster belongs to the org that owns its project, and to no column.
 *
 * The route used to express that as a JOIN predicate: `.innerJoin(projects, …).where(
 * eq(projects.org_id, actor.orgId))`. That reads correctly and it is why the count could not
 * simply follow: `countScoped` issues `SELECT 1 FROM <table> WHERE <scope>` over ONE table, so a
 * scope naming `projects.org_id` renders `SELECT 1 FROM project_cluster WHERE projects.org_id =
 * $1` — a missing-FROM-clause ERROR, not a slow query. A count and a rows query that reach the
 * same rows through two DIFFERENT constructions are two statements that can disagree, and the
 * console's filter standard exists because they eventually do.
 *
 * SO THE SCOPE IS RESTATED AS A SEMIJOIN ON ONE COLUMN of `project_cluster`:
 *
 *     project_cluster.project_id IN (SELECT projects.id FROM projects WHERE projects.org_id = $1)
 *
 * That is the same row set — `project_id` is `NOT NULL` and references `projects.id`, so the
 * innerJoin the rows query still needs for `project_name`/`region` is 1:1 and drops nothing the
 * semijoin counted — and it is expressible on a single column of the table being paged. The
 * count and the rows query now use the IDENTICAL fragment; `paginate` hands it to both, and the
 * rows query adds only the keyset predicate on top.
 *
 * WHY THAT DISTINCTION IS NOT PEDANTRY. These routes read through `getServiceDb()`, whose role
 * bypasses RLS, so this predicate is the entire tenancy boundary. A boundary that spans two
 * tables is a boundary with a second place to widen it: drop the join condition, or leave the
 * join and lose the `WHERE`, and the query still parses and still returns rows — another org's.
 * A single-column `IN` has no such shape. It also takes exactly one subject, `actor.orgId`; the
 * caller's identity never enters it, which is the failure `/api/jobs` shipped and reverted when
 * it copied the `owner_all` RLS policy into a service-role query (see that route's doc — RLS
 * binds `app.current_owner` to the session's human, while a service token's `actor.userId` is
 * whoever MINTED it).
 *
 * WHAT IS STILL NOT EXPRESSIBLE ON A TENANT COLUMN, AND IS A FINDING RATHER THAN A DETAIL: this
 * predicate re-derives the tenancy on every request. It is correct, but it is correct BECAUSE
 * `projects.org_id` is consulted, not because `project_cluster` records who owns the row. There
 * is no `org_id` on this table for an RLS policy to bind to, and no way to write one; every
 * reader of `project_cluster` has to know to reach through `projects`, and a reader that forgets
 * gets a query that works. The durable fix is a denormalized `project_cluster.org_id` stamped by
 * the same trigger family as `jobs_set_org_id`, which is a migration and belongs to its own unit
 * — see the PR that ships this.
 *
 * ── ORDERING: `created_at`, NOT `updated_at` ───────────────────────────────────────────────────
 *
 * This list was ordered `updated_at DESC`. A KEYSET CURSOR CANNOT WALK A MUTABLE ORDERING KEY.
 * The whole property a cursor buys over an offset is that a page asks for the rows strictly below
 * a FIXED position, so concurrent writes cannot shift the window; `updated_at` is rewritten every
 * time a cluster's status changes, which is precisely what a caller is paging through a cluster
 * list to watch. A row touched mid-walk jumps above the cursor and is served twice, and a row
 * that was above it and is touched again is never reached — the same duplicate-and-skip behaviour
 * offsets have, reintroduced through the mechanism that was supposed to remove it.
 *
 * So the walk uses the vocabulary's canonical `(created_at DESC NULLS LAST, id DESC NULLS LAST)`,
 * which is immutable. The visible cost is that `alethia cluster list` now prints oldest-created
 * last rather than least-recently-touched last; the SET is unchanged, because the Go client walks
 * every page (`api.GetClusters`). It also removes the need #3857 anticipated for a second cursor
 * index on `updated_at`.
 *
 * NO INDEX IS ADDED FOR THIS, DELIBERATELY, AND THE REASON IS THE CAP. `idx_jobs_org_cursor`
 * exists because a busy org's `jobs` is unbounded; `project_cluster` holds at most one row per
 * project environment, so a scope-then-sort over it is bounded by the org's environment count and
 * is far below `DEFAULT_COUNT_CAP`. If that stops being true the index is a migration, not a
 * change here.
 *
 * ── PAGING ────────────────────────────────────────────────────────────────────────────────────
 *
 * `page` is the shared vocabulary (`lib/cli/paging.ts`): `?limit=` defaults to 50 and clamps at
 * 200, `?cursor=` walks, `page.next_cursor` is `null` at exhaustion, and `page.total` is capped —
 * read `page.mode` before printing it as a count.
 *
 * THERE IS NO `?offset=` HERE. `/api/jobs` kept one because a shipped CLI walks it by offset and
 * an ignored parameter would page the same rows forever. Nothing has ever sent an offset to this
 * endpoint — it returned the whole collection — so honouring one would be inventing a second
 * mechanism rather than keeping a promise.
 *
 * THIS ENDPOINT USED TO RETURN EVERY ROW, so the conversion can silently truncate a client that
 * reads `clusters` and stops. `packages/core/api/api.go`'s `GetClusters` is changed in the same
 * change to walk the cursor to exhaustion through `api.AllPages`, which keeps `alethia cluster
 * list` and `alethia cluster get`'s picker listing the whole collection. An OLDER CLI binary
 * against a newer server still sees ONE page — it has no walk — which is why a request carrying
 * neither `limit` nor `cursor` is served at MAX_PAGE_SIZE rather than at the default; see the
 * handler. That does not make an old binary correct, it moves the cliff from 50 to 200.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	const { searchParams } = new URL(req.url);
	const cursorScope: CursorScope = { orgId: actor.orgId, list: CLUSTERS_LIST };
	const parsed = parsePageOpts(searchParams, cursorScope);
	if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

	// A CLIENT THAT ASKED FOR NO PAGE GETS THE CEILING, NOT THE DEFAULT PAGE.
	//
	// This endpoint returned the whole collection until #3672, so a caller that sends neither
	// `limit` nor `cursor` is one that has never heard of paging — a pre-#3672 binary. Serving it
	// DEFAULT_PAGE_SIZE truncates silently at 50, and for one of the two callers that is worse than
	// a short list: `cluster get <name>` feeds this straight into `resolveCluster`, which reads "no
	// match in this slice" as a hard error, so the 51st cluster reports "no cluster matches your
	// selector" — indistinguishable from a typo. The ordering change compounds it, because the
	// reachable window is now newest-CREATED rather than most-recently-touched, so the long-lived
	// clusters someone is most likely to name by hand are exactly the ones that fall off.
	//
	// MAX_PAGE_SIZE moves that cliff to 200, above realistic org sizes, while keeping the response
	// bounded — which is the whole point of the conversion. It is not a fix for the truncation (a
	// pre-#3672 binary still cannot walk); it is choosing the bound that makes the truncation
	// unreachable in practice instead of reachable at 50.
	//
	// An empty value is absent, matching parsePageOpts, so `?limit=` is not read as "asked".
	const asked = (key: string) => {
		const raw = searchParams.get(key);
		return raw !== null && raw !== "";
	};
	const opts =
		!asked("limit") && !asked("cursor")
			? { ...parsed.opts, limit: MAX_PAGE_SIZE }
			: parsed.opts;

	try {
		const db = getServiceDb();

		// The tenancy boundary, on ONE column of the table being paged. See the doc above for why
		// the join predicate it replaces could not be handed to the count.
		//
		// Written as a `sql` template rather than `inArray(projectCluster.project_id, db.select(…))`
		// so the fragment carries no `db` — it is a pure predicate the mocked suite can render and
		// read, and it is the SAME object the count and the rows query receive. The embedded `eq()`
		// keeps the org id bound through the column's own drizzle type mapper; a bare
		// `${actor.orgId}` would hand postgres-js a plain string for a `uuid` column.
		const orgScope: SQL = sql`${projectCluster.project_id} in (select ${projects.id} from ${projects} where ${eq(projects.org_id, actor.orgId)})`;
		const scope: [SQL, ...(SQL | undefined)[]] = [orgScope];

		const { items, page } = await paginate({
			db,
			table: projectCluster,
			createdAt: projectCluster.created_at,
			id: projectCluster.id,
			scope,
			cursor: cursorScope,
			opts,
			rows: (query) =>
				db
					.select({
						id: projectCluster.id,
						cluster_name: projectCluster.cluster_name,
						cluster_version: projectCluster.cluster_version,
						instance_types: projectCluster.instance_types,
						node_min_size: projectCluster.node_min_size,
						node_max_size: projectCluster.node_max_size,
						node_desired_size: projectCluster.node_desired_size,
						status: projectCluster.status,
						status_message: projectCluster.status_message,
						argocd_url: projectCluster.argocd_url,
						estimated_monthly_cost: projectCluster.estimated_monthly_cost,
						created_at: projectCluster.created_at,
						updated_at: projectCluster.updated_at,
						// The ordering key as Postgres renders it — six fractional digits. Reading
						// `projectCluster.created_at` here would hand back a millisecond-precision JS
						// Date and the cursor built from it would silently skip every row in the gap.
						cursor_key: cursorKey(projectCluster.created_at),
						project_name: projects.project_name,
						// M1: the cluster's environment = the project's default environment name.
						environment: projectEnvironments.name,
						region: projects.region,
					})
					.from(projectCluster)
					// PROJECTION JOINS, NOT SCOPE JOINS — the scope is the semijoin above.
					// `project_id` is NOT NULL and references `projects.id`, so this innerJoin is
					// 1:1 and cannot drop a row the count included. The leftJoin cannot duplicate
					// one either: `project_environments_one_default` is a partial UNIQUE index on
					// `project_id WHERE is_default`, so at most one row matches. Both facts are
					// what let `countScoped`'s single-table count equal the rows this returns.
					.innerJoin(projects, eq(projectCluster.project_id, projects.id))
					.leftJoin(
						projectEnvironments,
						and(
							eq(projectEnvironments.project_id, projects.id),
							eq(projectEnvironments.is_default, true),
						),
					)
					.where(query.where)
					.orderBy(...query.orderBy)
					.limit(query.limit),
			positionOf: (r) => ({ createdAt: r.cursor_key, id: r.id }),
		});

		const clusters = items.map(({ cursor_key: _cursor, ...r }) => ({
			...r,
			environment: r.environment ?? "development",
		}));

		return cliJson(cliClustersPageResponse, { clusters, page });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
