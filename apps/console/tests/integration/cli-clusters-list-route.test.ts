// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: GET /api/cli/clusters — the converted route, against real Postgres.
//
// WHY THIS ROUTE NEEDED ITS OWN SUITE AND IS NOT A COPY OF THE JOBS ONE. `countScoped` counts ONE
// table. `jobs` carries `org_id`, so `/api/jobs` could hand a single fragment to both its rows
// query and its count (#3857). `project_cluster` HAS NO TENANT COLUMN — its scope lived on the
// JOINED `projects` table, and `SELECT 1 FROM project_cluster WHERE projects.org_id = $1` is a
// missing-FROM-clause ERROR, not a slow query. The conversion restates the scope as a semijoin on
// `project_cluster.project_id`; whether that restatement counts the SAME rows it returns is a
// claim only a real database can settle, which is what this file is for.
//
// The mocked sibling (tests/api/cli/clusters/list-route.test.ts) proves the two queries are built
// from ONE fragment by reading the rendered SQL. That is a statement about construction. Here the
// fragment is EXECUTED, against fixtures shaped to break the two ways a join-derived scope can
// silently mis-count:
//
//   1. AN ORG PROJECT WITH NO CLUSTER. A count that reached `projects` instead of
//      `project_cluster` — the obvious way to make a join-scoped count "work" — reports one row
//      too many, and nothing about the page it sits beside looks wrong.
//   2. A CLUSTERED PROJECT WITH A SECOND, NON-DEFAULT ENVIRONMENT. The rows query left-joins
//      `project_environments` for the environment name. If that join stopped matching on
//      `is_default`, the row FANS OUT: the page would carry a duplicate the count never counted,
//      and the keyset walk would mint a cursor from a row it had already served.
//
// Plus the property every converted list owes: a cursor is A NEW WAY TO ADDRESS ROWS, so it is a
// new way to address someone else's. The route reads through getServiceDb(), whose role BYPASSES
// row-level security, so the handler's semijoin is the entire tenancy boundary. Org B is seeded
// with rows that WOULD come back if it were dropped, and every walk assertion is written as
// "exactly org A's id set", never "at least N rows".
//
// TIMESTAMPS ARE COMPUTED BY POSTGRES, NEVER BY JAVASCRIPT. `timestamptz` is microsecond precision
// and a JS `Date` is millisecond precision; a fixture seeded with `new Date(...)` has µs = 0 on
// every row, and a cursor that truncates to milliseconds is then a no-op against it — the suite
// would pass while production dropped rows. Cluster rows here are spaced by MICROSECONDS, and the
// first test fails if that stops being true.
//
// The PDP is stubbed and the database is not. `authorizeCli` is the permission gate and is proven
// in the authz suite; what is unproven — and what this file drives — is what the handler does with
// the actor it is handed.

import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeIfDb } from "./db";

vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
}));

import { GET } from "@/app/api/cli/clusters/route";
import { authorizeCli } from "@/lib/authz/guard";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type PageInfo } from "@/lib/cli/paging";
import { getServiceDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";

/** Small enough that a walk is several pages, large enough that a tie can straddle a boundary. */
const PAGE_SIZE = 5;
/** Three full pages and a remainder of one. */
const ORG_A_CLUSTERS = 3 * PAGE_SIZE + 1;
/** The decoy. Not zero and not ORG_A_CLUSTERS, so a leak changes a total rather than hiding in one. */
const ORG_B_CLUSTERS = 7;
/**
 * Microseconds between consecutive rows. DELIBERATELY UNDER A MILLISECOND and not a divisor of
 * one, so several rows share each millisecond — the shape a batch provision produces and the one a
 * millisecond-precision cursor cannot page through.
 */
const ROW_SPACING_US = 137;
/** Offsets org B by a fraction of the spacing so its rows INTERLEAVE org A's rather than trail. */
const ORG_B_PHASE_US = 61;

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER_A = randomUUID();
const USER_B = randomUUID();
const ORG_IDS = [ORG_A, ORG_B];

/** Org A's cluster ids, read back from the database rather than sliced off a RETURNING. */
let orgAClusterIds: string[] = [];
let orgBClusterIds: string[] = [];
/** The clustered project that also owns a SECOND, non-default environment. */
let twoEnvProjectId = "";

const idRowsSchema = z.array(z.object({ id: z.uuid() }));

/** One seeded project: its id and how far its cluster sits behind the shared anchor. */
interface SeedProject {
	readonly id: string;
	readonly orgId: string;
	readonly userId: string;
	readonly offsetUs: number;
	/** False for the project that deliberately has NO cluster. */
	readonly withCluster: boolean;
}

/**
 * Inserts the projects and their default environments.
 *
 * `region` and `iac_version` are NOT NULL with no default and the wire requires `region`, so both
 * are set explicitly; an environment is seeded per project because the route reads the cluster's
 * environment name through the `is_default` left join.
 */
async function seedProjects(rows: readonly SeedProject[]): Promise<void> {
	const db = getServiceDb();
	await db.insert(projects).values(
		rows.map((r) => ({
			id: r.id,
			user_id: r.userId,
			org_id: r.orgId,
			project_name: `p-${r.id.slice(0, 8)}`,
			slug: `p-${r.id.slice(0, 8)}`,
			region: "eu-west-1",
			iac_version: "1.0.0",
		})),
	);
	await db.execute(sql`
		insert into project_environments (project_id, user_id, org_id, name, is_default)
		select pid, usr, org, 'production', true
		from unnest(
			array[${sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `)}],
			array[${sql.join(rows.map((r) => sql`${r.userId}::uuid`), sql`, `)}],
			array[${sql.join(rows.map((r) => sql`${r.orgId}::uuid`), sql`, `)}]
		) as u(pid, usr, org)
	`);
}

/**
 * Inserts one cluster per project at `now()` minus that project's microsecond offset.
 *
 * ONE STATEMENT, so ONE now(). Seeding two orgs with two statements gives them anchors
 * milliseconds apart, which silently un-interleaves them: every row of the second org would sort
 * above every row of the first and the cross-org assertions would stop testing anything.
 */
async function seedClusters(rows: readonly SeedProject[]): Promise<string[]> {
	const withCluster = rows.filter((r) => r.withCluster);
	const inserted = await getServiceDb().execute(sql`
		insert into project_cluster (project_id, cluster_name, status, created_at, updated_at)
		select pid, 'k8s-' || substr(pid::text, 1, 8), 'ACTIVE',
		       date_trunc('milliseconds', now()) - (off * interval '1 microsecond'),
		       -- updated_at is deliberately the INVERSE order of created_at, so a walk that
		       -- ordered by the mutable column would produce a visibly different sequence.
		       date_trunc('milliseconds', now()) + (off * interval '1 microsecond')
		from unnest(
			array[${sql.join(withCluster.map((r) => sql`${r.id}::uuid`), sql`, `)}],
			array[${sql.join(withCluster.map((r) => sql`${r.offsetUs}::bigint`), sql`, `)}]
		) as u(pid, off)
		returning id
	`);
	return idRowsSchema.parse(inserted).map((r) => r.id);
}

/** The wire shape this route returns, narrowed enough to assert on without casts. */
const bodySchema = z.object({
	clusters: z.array(
		z.object({
			id: z.string(),
			project_name: z.string(),
			environment: z.string(),
			region: z.string(),
		}),
	),
	page: z.object({
		mode: z.enum(["exact", "capped"]),
		limit: z.number(),
		total: z.number(),
		next_cursor: z.string().nullable(),
	}),
});
type Body = z.infer<typeof bodySchema>;

/** Points the stubbed guard at `actor` for the next call. */
function actingAs(userId: string, orgId: string): void {
	vi.mocked(authorizeCli).mockResolvedValue({ actor: { userId, orgId } });
}

/** Drives the route and parses a 200 body. Fails loudly on any other status. */
async function get(query: string): Promise<Body> {
	const res = await GET(
		new Request(`http://console.test/api/cli/clusters${query}`),
	);
	const raw: unknown = await res.json();
	if (res.status !== 200) {
		throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(raw)}`);
	}
	return bodySchema.parse(raw);
}

/** Drives the route and returns the status + `error` for a refusal. */
async function refusal(query: string): Promise<{ status: number; error: unknown }> {
	const res = await GET(
		new Request(`http://console.test/api/cli/clusters${query}`),
	);
	const body = z.object({ error: z.unknown() }).parse(await res.json());
	return { status: res.status, error: body.error };
}

/**
 * Walks the endpoint to exhaustion and returns every id in order, plus each page's PageInfo.
 *
 * Bounded, because an endlessly-advancing cursor is one of the defects the walk is here to catch
 * and an unbounded loop would hang the suite rather than name it.
 */
async function walk(limit = PAGE_SIZE) {
	const ids: string[] = [];
	const pages: PageInfo[] = [];
	let cursor = "";
	for (let i = 0; i < 50; i++) {
		const body = await get(
			`?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
		);
		ids.push(...body.clusters.map((c) => c.id));
		pages.push(body.page);
		if (body.page.next_cursor === null) return { ids, pages };
		cursor = body.page.next_cursor;
	}
	throw new Error("walk did not exhaust in 50 pages");
}

describeIfDb("GET /api/cli/clusters — a joined scope, counted and walked (#3672)", () => {
	beforeAll(async () => {
		// Org A: ORG_A_CLUSTERS clustered projects, PLUS one project with no cluster at all.
		const a: SeedProject[] = Array.from(
			{ length: ORG_A_CLUSTERS },
			(_, i) => ({
				id: randomUUID(),
				orgId: ORG_A,
				userId: USER_A,
				offsetUs: i * ROW_SPACING_US,
				withCluster: true,
			}),
		);
		const clusterless: SeedProject = {
			id: randomUUID(),
			orgId: ORG_A,
			userId: USER_A,
			offsetUs: 0,
			withCluster: false,
		};
		const b: SeedProject[] = Array.from({ length: ORG_B_CLUSTERS }, (_, i) => ({
			id: randomUUID(),
			orgId: ORG_B,
			userId: USER_B,
			offsetUs: i * ROW_SPACING_US + ORG_B_PHASE_US,
			withCluster: true,
		}));

		const all = [...a, clusterless, ...b];
		await seedProjects(all);
		await seedClusters(all);

		// A SECOND environment on one clustered project, NOT the default. The left join must not
		// see it; if it did, that project's cluster would appear twice on the wire while the count
		// still said once.
		twoEnvProjectId = a[0].id;
		await getServiceDb().execute(sql`
			insert into project_environments (project_id, user_id, org_id, name, is_default)
			values (${twoEnvProjectId}::uuid, ${USER_A}::uuid, ${ORG_A}::uuid, 'staging', false)
		`);

		// READ THE IDS BACK rather than slicing `returning`. Postgres does not promise that
		// `INSERT … SELECT … RETURNING` emits rows in the SELECT's order, and an expectation set
		// from an order the database is free to change is a test that fails for a reason nothing
		// in the diff explains.
		const read = async (orgId: string) =>
			idRowsSchema
				.parse(
					await getServiceDb().execute(sql`
						select c.id from project_cluster c
						join projects p on p.id = c.project_id
						where p.org_id = ${orgId}::uuid
					`),
				)
				.map((r) => r.id);
		orgAClusterIds = await read(ORG_A);
		orgBClusterIds = await read(ORG_B);
	});

	afterAll(async () => {
		// project_cluster and project_environments are both ON DELETE CASCADE from projects.
		await getServiceDb().delete(projects).where(inArray(projects.org_id, ORG_IDS));
	});

	it("seeded a fixture that can actually see the three bugs this suite is for", async () => {
		const rows = await getServiceDb().execute(sql`
			select
				(select count(distinct date_trunc('milliseconds', c.created_at))
				   from project_cluster c join projects p on p.id = c.project_id
				  where p.org_id = ${ORG_A}::uuid) as ms,
				(select count(*) from project_cluster c join projects p on p.id = c.project_id
				  where p.org_id = ${ORG_A}::uuid) as clusters,
				(select count(*) from projects where org_id = ${ORG_A}::uuid) as projects,
				(select count(*) from project_environments where project_id = ${twoEnvProjectId}::uuid) as envs
		`);
		const [row] = z
			.array(
				z.object({
					ms: z.coerce.number(),
					clusters: z.coerce.number(),
					projects: z.coerce.number(),
					envs: z.coerce.number(),
				}),
			)
			.parse(rows);
		// Strictly fewer distinct milliseconds than rows ⇒ at least one millisecond holds two rows
		// ⇒ a cursor that truncated to milliseconds would drop one. Without this the walk
		// assertions below would pass against a fixture that cannot express the bug.
		expect(row.clusters).toBe(ORG_A_CLUSTERS);
		expect(row.ms).toBeLessThan(row.clusters);
		// The count must be over CLUSTERS, and the fixture makes the two numbers differ.
		expect(row.projects).toBe(ORG_A_CLUSTERS + 1);
		// Two environments on one clustered project, so a left join that lost `is_default` fans out.
		expect(row.envs).toBe(2);
	});

	it("lists the org's clusters and none of the other org's", async () => {
		actingAs(USER_A, ORG_A);
		const body = await get(`?limit=${ORG_A_CLUSTERS + ORG_B_CLUSTERS}`);
		expect(body.clusters.map((c) => c.id).sort()).toEqual(
			[...orgAClusterIds].sort(),
		);
		expect(orgBClusterIds.length).toBe(ORG_B_CLUSTERS);
	});

	it("counts the CLUSTERS, not the org's projects — the clusterless project is the tell", async () => {
		// THE ASSERTION #3672 CALLED OUT. `countScoped` counts one table, and the obvious way to
		// make a join-scoped count issuable is to count the table the org column lives on. That
		// reports ORG_A_CLUSTERS + 1 here, and the page beside it still looks right.
		actingAs(USER_A, ORG_A);
		const body = await get(`?limit=${ORG_A_CLUSTERS}`);
		expect(body.page.mode).toBe("exact");
		expect(body.page.total).toBe(ORG_A_CLUSTERS);
		expect(body.clusters.length).toBe(ORG_A_CLUSTERS);
	});

	it("returns a clustered project with two environments ONCE, named by the default one", async () => {
		actingAs(USER_A, ORG_A);
		const body = await get(`?limit=${ORG_A_CLUSTERS}`);
		const rows = body.clusters.filter((c) =>
			c.project_name.startsWith(`p-${twoEnvProjectId.slice(0, 8)}`),
		);
		expect(rows).toHaveLength(1);
		// `production` is the default; `staging` exists on the same project and must not appear.
		expect(rows[0].environment).toBe("production");
	});

	it("serves the WHOLE collection to a caller that asked for no page — the old-binary path", async () => {
		// THE COMPATIBILITY CLAIM, DRIVEN END TO END. Every other case in this file names a
		// `?limit=`, so this is the only one that sends what a DEPLOYED CLI binary actually sends:
		// neither a limit nor a cursor.
		//
		// Why it earns a database. This endpoint returned the whole collection until #3672, so
		// every binary older than the conversion reads `clusters` once and stops. For
		// `alethia cluster list` that is a short list. For `alethia cluster get <name>` it is
		// worse: `resolveCluster` (apps/cli/cmd/clusters_get.go) treats "no match in this slice"
		// as a HARD ERROR — "no cluster matches your selector" — about a cluster that plainly
		// exists, indistinguishable from a typo. So a request that asked for no page is served at
		// MAX_PAGE_SIZE, and this is where that is a fact about a RESPONSE rather than a fact
		// about a fake.
		actingAs(USER_A, ORG_A);
		const body = await get("");

		// THE DISCRIMINATING ASSERTION, and the only one here that is. `page.limit` echoes what
		// was served, so it is red the moment the route falls back to DEFAULT_PAGE_SIZE — which
		// the row assertions below CANNOT see, because ORG_A_CLUSTERS (16) sits under BOTH
		// defaults. Seeding 50+ clustered projects to make the row set discriminating would cost
		// the suite far more than this line does and would prove the same thing.
		expect(body.page.limit).toBe(MAX_PAGE_SIZE);
		expect(MAX_PAGE_SIZE).toBeGreaterThan(DEFAULT_PAGE_SIZE);

		// And the claim itself: one request, no cursor, the entire collection, nothing to follow.
		// A caller that reads `clusters` and stops here has lost nothing.
		expect(body.clusters.map((c) => c.id).sort()).toEqual(
			[...orgAClusterIds].sort(),
		);
		expect(body.page.next_cursor).toBeNull();
		expect(body.page.mode).toBe("exact");
		expect(body.page.total).toBe(ORG_A_CLUSTERS);
		// Still the org's own collection: raising the page widened the WINDOW, not the scope.
		for (const c of body.clusters) expect(orgBClusterIds).not.toContain(c.id);
	});

	it("walks the cursors to exhaustion with no gap and no duplicate", async () => {
		actingAs(USER_A, ORG_A);
		const { ids, pages } = await walk();
		expect(new Set(ids).size).toBe(ids.length); // no duplicate
		expect([...ids].sort()).toEqual([...orgAClusterIds].sort()); // no gap, and org A only
		// Four pages: three full and a remainder of one. A walk that terminated early would still
		// satisfy "no duplicate", so the page shape is asserted too.
		expect(pages.length).toBe(4);
		expect(pages.slice(0, -1).every((p) => p.next_cursor !== null)).toBe(true);
		expect(pages[pages.length - 1].next_cursor).toBeNull();
		// `total` is the size of the COLLECTION, not of the remainder after the cursor. A total
		// that ticked down as the caller paged would read as rows disappearing from under them.
		expect(pages.every((p) => p.total === ORG_A_CLUSTERS)).toBe(true);
	});

	it("gives org B its own collection and its own total, reaching none of org A's rows", async () => {
		actingAs(USER_B, ORG_B);
		const { ids, pages } = await walk();
		expect([...ids].sort()).toEqual([...orgBClusterIds].sort());
		expect(pages.every((p) => p.total === ORG_B_CLUSTERS)).toBe(true);
		for (const id of ids) expect(orgAClusterIds).not.toContain(id);
	});

	it("refuses org B's cursor when it is presented as org A", async () => {
		// A cursor carries no authority, so there is nothing to forge — but a position minted under
		// another tenant must be REFUSED rather than answered, because answering it with this org's
		// page hides which of the two the caller thought was in effect.
		actingAs(USER_B, ORG_B);
		const bPage = await get(`?limit=${PAGE_SIZE}`);
		expect(bPage.page.next_cursor).not.toBeNull();
		const bCursor = bPage.page.next_cursor ?? "";

		actingAs(USER_A, ORG_A);
		const denied = await refusal(`?cursor=${encodeURIComponent(bCursor)}`);
		expect(denied.status).toBe(400);
		expect(String(denied.error)).toMatch(/different list or organization/);
	});

	it("orders by created_at, so the sequence is NOT the updated_at one", async () => {
		// The fixture seeds `updated_at` in the inverse order of `created_at`, so a route that kept
		// its old `updated_at DESC` ordering returns the exact reverse of this. The ordering matters
		// because a keyset cursor cannot walk a mutable key: `updated_at` is rewritten every time a
		// cluster's status changes, and a row touched mid-walk jumps above the cursor and is served
		// twice.
		actingAs(USER_A, ORG_A);
		const body = await get(`?limit=${ORG_A_CLUSTERS}`);
		const seen = body.clusters.map((c) => c.id);
		const byCreated = idRowsSchema
			.parse(
				await getServiceDb().execute(sql`
					select c.id from project_cluster c
					join projects p on p.id = c.project_id
					where p.org_id = ${ORG_A}::uuid
					order by c.created_at desc nulls last, c.id desc nulls last
				`),
			)
			.map((r) => r.id);
		expect(seen).toEqual(byCreated);
		expect(seen).not.toEqual([...byCreated].reverse());
	});
});
