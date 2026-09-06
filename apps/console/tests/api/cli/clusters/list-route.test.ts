// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// GET /api/cli/clusters — what the handler BUILDS, asserted without a database.
//
// THE CLAIM THIS FILE OWNS IS THE ONE #3672 SINGLED OUT AS NOT MECHANICAL. `countScoped` counts
// ONE table, and this collection's tenancy used to live on a JOINED one: the route scoped itself
// with `.innerJoin(projects, …).where(eq(projects.org_id, …))`, which `countScoped` cannot issue —
// `SELECT 1 FROM project_cluster WHERE projects.org_id = $1` is a missing-FROM-clause ERROR.
//
// The conversion restates that scope as a semijoin on ONE column of `project_cluster`, and the
// assertions below read the RENDERED SQL to prove it, because that is the only artifact that can
// tell the two apart. A test that inspected a drizzle object graph, or that rebuilt the
// expectation with the same `sql` template the route uses, would agree with the route by
// construction — including when the route is wrong. `PgDialect.sqlToQuery` is the same rendering
// postgres receives.
//
// The two properties, stated once here so the individual tests can be short:
//
//   1. THE COUNT AND THE ROWS ARE THE SAME PREDICATE. Not "equivalent" — the same fragment,
//      rendered identically, with the keyset predicate the only thing the rows query adds. A count
//      built through a join while the rows are built through a semijoin is two statements that can
//      disagree, which is the defect the console's filter standard exists to prevent.
//   2. THE TENANCY BOUNDARY IS ONE COLUMN. These routes read through `getServiceDb()`, whose role
//      bypasses RLS, so this predicate is the whole of it. A boundary spanning two tables has a
//      second place to widen: drop the join condition and the query still parses and still returns
//      rows — another org's. A single-column `IN (subquery)` has no such shape.
//
// The sibling suite (tests/integration/cli-clusters-list-route.test.ts) drives this route against
// real Postgres, where the semijoin is EXECUTED and the walk's gap-freeness is provable. A mock
// cannot prove a keyset walk; this file does not try.
//
// The refusals live here too. Every one returns before the first query, so they are real here
// rather than DB-gated — which matters, because the integration tier SKIPS when Postgres is
// unreachable and these are the branches a caller hits by typo.

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { GET } from "@/app/api/cli/clusters/route";
import { authorizeCli } from "@/lib/authz/guard";
import {
	DEFAULT_PAGE_SIZE,
	MAX_PAGE_SIZE,
	cursorKey,
	encodeCursor,
} from "@/lib/cli/paging";
import { getServiceDb } from "@/lib/db";
import { projectCluster } from "@/lib/db/schema";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const CLUSTER_ID = "44444444-4444-4444-8444-444444444444";
/** What `cursorKey()` projects: six fractional digits, which a JS Date cannot carry. */
const CURSOR_KEY = "2026-06-30T00:00:00.123456Z";

/**
 * The scope predicate, written out by hand exactly as postgres must receive it.
 *
 * BY HAND, and never rebuilt with `sql`/`eq`: an expectation composed the way the route composes
 * it is a restatement of the route, not a check on it. This string is what makes "one column"
 * assertable — every character of the shape is here, including which table each identifier
 * belongs to.
 */
const EXPECTED_SCOPE =
	'"project_cluster"."project_id" in (select "projects"."id" from "projects" where "projects"."org_id" = $1)';

const dialect = new PgDialect();

/** Renders a drizzle SQL fragment exactly as postgres receives it. */
function render(fragment: SQL | undefined): {
	sql: string;
	params: readonly unknown[];
} {
	// A missing fragment is a test that never reached the query, not an empty WHERE clause.
	if (fragment === undefined) throw new Error("expected a SQL fragment, got none");
	const q = dialect.sqlToQuery(fragment);
	return { sql: q.sql, params: q.params };
}

/**
 * Collapses whitespace so an assertion reads the SHAPE of a clause rather than drizzle's spacing.
 *
 * Only whitespace: the identifier quoting, the parentheses and the `$n` numbering are all part of
 * what is being asserted, because they are what tell a semijoin from a join.
 */
function normalized(rendered: string): string {
	return rendered.replace(/\s+/g, " ").trim();
}

/** What one drive of the route recorded. */
interface Captured {
	/** The rows query's projection, so the cursor-key EXPRESSION can be read, not just its value. */
	rowsProjection: Record<string, unknown> | undefined;
	rowsWhere: SQL | undefined;
	rowsLimit: number | undefined;
	countWhere: SQL | undefined;
	orderBy: SQL[];
	/** The join predicates, so a scope smuggled back into a join is visible. */
	joins: SQL[];
}

let captured: Captured;
let rowsResult: unknown[];
let countResult: number;

/**
 * A drizzle-shaped fake that records what each of the two queries was built with.
 *
 * The two are told apart by their PROJECTION — `countScoped` selects `{ hit }` for its capped
 * subquery and `{ n }` for the count over it, and neither key can collide with the rows query's.
 * Keying on call ORDER instead would silently mis-attribute the moment `paginate` stops issuing
 * them with `Promise.all`.
 */
function fakeDb() {
	const chain = (kind: "rows" | "capped" | "count") => {
		const c: Record<string, unknown> = {};
		const self = () => c;
		Object.assign(c, {
			from: self,
			as: self,
			innerJoin: (_t: unknown, on: SQL) => {
				captured.joins.push(on);
				return c;
			},
			leftJoin: (_t: unknown, on: SQL) => {
				captured.joins.push(on);
				return c;
			},
			where: (w: SQL | undefined) => {
				if (kind === "rows") captured.rowsWhere = w;
				if (kind === "capped") captured.countWhere = w;
				return c;
			},
			orderBy: (...o: SQL[]) => {
				captured.orderBy = o;
				return c;
			},
			limit: (n: number) => {
				if (kind === "rows") captured.rowsLimit = n;
				return c;
			},
			then: (
				resolve: (v: unknown) => unknown,
				reject?: (e: unknown) => unknown,
			) => {
				try {
					return Promise.resolve(
						resolve(kind === "count" ? [{ n: countResult }] : rowsResult),
					);
				} catch (e) {
					return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
				}
			},
		});
		return c;
	};
	return {
		select: (projection: Record<string, unknown>) => {
			const keys = Object.keys(projection ?? {});
			if (keys.length === 1 && keys[0] === "hit") return chain("capped");
			if (keys.length === 1 && keys[0] === "n") return chain("count");
			captured.rowsProjection = projection;
			return chain("rows");
		},
	};
}

/** One list row shaped the way the handler's projection produces it. */
function listRow(overrides: Record<string, unknown> = {}) {
	return {
		id: CLUSTER_ID,
		cluster_name: "api-backend-production",
		cluster_version: "1.30",
		instance_types: ["m6i.large"],
		node_min_size: 1,
		node_max_size: 5,
		node_desired_size: 3,
		status: "ACTIVE",
		status_message: null,
		argocd_url: null,
		estimated_monthly_cost: 210,
		created_at: "2026-06-30T00:00:00.123Z",
		updated_at: "2026-06-30T00:00:00.123Z",
		cursor_key: CURSOR_KEY,
		project_name: "api-backend",
		environment: "production",
		region: "eu-west-1",
		...overrides,
	};
}

/** The envelope this route returns, narrowed enough to assert on without a cast. */
const bodySchema = z.object({
	clusters: z.array(
		z.object({ id: z.string(), environment: z.string(), project_name: z.string() }),
	),
	page: z.object({
		mode: z.string(),
		limit: z.number(),
		total: z.number(),
		next_cursor: z.string().nullable(),
	}),
});
const errorSchema = z.object({ error: z.string() });

async function drive(query: string) {
	const res = await GET(
		new Request(`http://console.test/api/cli/clusters${query}`),
	);
	const body: unknown = await res.json();
	return { status: res.status, body };
}

/** Drives the route and parses a 200 envelope, failing loudly on any other status. */
async function driveOk(query: string) {
	const { status, body } = await drive(query);
	expect(status).toBe(200);
	return bodySchema.parse(body);
}

describe("GET /api/cli/clusters — a joined scope restated on one column (#3672)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		captured = {
			rowsProjection: undefined,
			rowsWhere: undefined,
			rowsLimit: undefined,
			countWhere: undefined,
			orderBy: [],
			joins: [],
		};
		rowsResult = [];
		countResult = 0;
		vi.mocked(authorizeCli).mockResolvedValue({
			actor: { userId: USER, orgId: ORG },
		});
		vi.mocked(getServiceDb).mockReturnValue(fakeDb() as never);
	});

	it("authorizes as a CLI project VIEW", async () => {
		await drive("");
		expect(vi.mocked(authorizeCli).mock.calls[0][1]).toBe("view");
		expect(vi.mocked(authorizeCli).mock.calls[0][2]).toEqual({ type: "project" });
	});

	it("renders the scope as a semijoin on project_cluster.project_id and NOTHING else", async () => {
		// The whole rendered clause, `toBe` rather than `toContain`: an extra ANDed arm is as much
		// a defect as a missing one, and a containment check cannot see one.
		//
		// ONE COLUMN OF THE PAGED TABLE. `project_cluster` has no tenant column at all — no
		// `org_id`, no `user_id` — so the boundary is this reference and the subquery behind it.
		// What must NOT appear is `projects.org_id` compared at the TOP level, which is the join
		// predicate this replaced and the shape `countScoped` cannot issue.
		await drive("");
		expect(normalized(render(captured.rowsWhere).sql)).toBe(EXPECTED_SCOPE);
		expect(render(captured.rowsWhere).params).toEqual([ORG]);
	});

	it("takes exactly ONE subject — the org — never the caller's identity", async () => {
		// `actor.userId` is the MINTING HUMAN for a service token, not the caller. A predicate that
		// mentions it is the cross-tenant leak /api/jobs shipped and reverted: scoped to org A with
		// a token whose minter also belongs to org B, it answered with B's rows too. There is no
		// arm here for it to enter through, and this is the assertion that keeps it that way.
		await drive("");
		const where = render(captured.rowsWhere);
		expect(where.sql).not.toContain('"user_id"');
		expect(where.params).not.toContain(USER);
	});

	it("hands the count the SAME rendered predicate as the rows", async () => {
		// The claim is not "the count is also scoped" — it is that the two are ONE fragment. A
		// count built through a join while the rows are built through a semijoin would satisfy a
		// weaker assertion and still be two statements that can drift apart.
		await drive("");
		expect(normalized(render(captured.countWhere).sql)).toBe(
			normalized(render(captured.rowsWhere).sql),
		);
		expect(render(captured.countWhere).params).toEqual(
			render(captured.rowsWhere).params,
		);
	});

	it("keeps the joins as PROJECTION joins — neither of them carries the scope", async () => {
		// The innerJoin on `projects` and the leftJoin on the default environment are still there,
		// because `project_name`, `region` and `environment` come from them. What they must no
		// longer do is decide who can see the row: a join predicate that also filtered by org is
		// the construction the count cannot mirror, and having BOTH would mean the tenancy is
		// stated twice and can be half-removed.
		await drive("");
		expect(captured.joins).toHaveLength(2);
		for (const on of captured.joins) {
			expect(render(on).params).not.toContain(ORG);
			expect(render(on).sql).not.toContain('"org_id"');
		}
	});

	it("counts over the SCOPE, not over the remainder after the cursor", async () => {
		const cursor = encodeCursor(
			{ orgId: ORG, list: "clusters" },
			{ createdAt: CURSOR_KEY, id: CLUSTER_ID },
		);
		await drive(`?cursor=${encodeURIComponent(cursor)}`);
		const rows = render(captured.rowsWhere);
		const counted = render(captured.countWhere);
		// The keyset predicate is on the rows query only. A total that shrank as the caller paged
		// would read as rows disappearing from under them.
		expect(rows.sql).toContain("::timestamptz");
		expect(rows.params).toEqual([ORG, CURSOR_KEY, CLUSTER_ID]);
		expect(counted.params).toEqual([ORG]);
		expect(normalized(counted.sql)).toBe(EXPECTED_SCOPE);
	});

	it("orders by created_at, NOT by the mutable updated_at it used to sort on", async () => {
		// A keyset cursor cannot walk a column that is rewritten while the caller pages. This list
		// was `updated_at DESC`, and `updated_at` is bumped every time a cluster's status changes —
		// which is what a caller pages a cluster list to watch. A row touched mid-walk jumps above
		// the cursor and is served twice; a row above it that is touched is never reached. That is
		// the duplicate-and-skip behaviour offsets have, reintroduced through the fix for it.
		await drive("");
		const order = captured.orderBy.map((o) => normalized(render(o).sql));
		expect(order).toEqual([
			'"project_cluster"."created_at" desc nulls last',
			'"project_cluster"."id" desc nulls last',
		]);
	});

	it("projects the cursor key as postgres renders it, not as a JS Date", async () => {
		// `timestamptz` is microsecond precision and a JS Date is millisecond precision, so a cursor
		// minted from the row object names an instant EARLIER than the row it came from and every
		// row in the gap is dropped from the rest of the walk — silently. Reading the EXPRESSION,
		// not a fixture's value, is the only way a mocked suite can see this: the fake never
		// executes SQL, so `cursor_key` is whatever the fixture supplies either way.
		await drive("");
		const projected = captured.rowsProjection?.cursor_key;
		expect(projected).toBeDefined();
		const rendered = normalized(render(projected as SQL).sql);
		expect(rendered).toBe(
			normalized(render(cursorKey(projectCluster.created_at)).sql),
		);
		// Six digits, not three. `US` is postgres' microsecond field; `MS` is the millisecond one
		// that loses the rows.
		expect(rendered).toContain(".US");
		expect(rendered).not.toContain(".MS");
	});

	it("asks for one row MORE than the page, which is what decides next_cursor", async () => {
		await drive("?limit=3");
		expect(captured.rowsLimit).toBe(4);
	});

	it("clamps to the vocabulary's ceiling, and serves the CEILING to a client that asked for no page", async () => {
		// NOT `DEFAULT_PAGE_SIZE`, and the difference is the whole of this route's back-compat
		// story. A request carrying neither `limit` nor `cursor` is a pre-#3672 binary that reads
		// `clusters` once and stops; `cluster get` then feeds that slice to `resolveCluster`, which
		// reports "no cluster matches your selector" for anything outside it. The ceiling moves that
		// cliff from 50 to 200. See the handler's note.
		await drive("");
		expect(captured.rowsLimit).toBe(MAX_PAGE_SIZE + 1);
		// An EXPLICIT limit is still the caller's, clamped at the ceiling — asking for a page is
		// what distinguishes a paging client from a pre-#3672 one.
		await drive(`?limit=${MAX_PAGE_SIZE * 2}`);
		expect(captured.rowsLimit).toBe(MAX_PAGE_SIZE + 1);
		await drive("?limit=10");
		expect(captured.rowsLimit).toBe(11);
		// And an EMPTY limit is absent, not "asked" — same reading parsePageOpts gives it.
		await drive("?limit=");
		expect(captured.rowsLimit).toBe(MAX_PAGE_SIZE + 1);
		// A cursor alone also counts as asking: a walker gets the default page size.
		const cursor = encodeCursor(
			{ orgId: ORG, list: "clusters" },
			{ createdAt: CURSOR_KEY, id: CLUSTER_ID },
		);
		await drive(`?cursor=${encodeURIComponent(cursor)}`);
		expect(captured.rowsLimit).toBe(DEFAULT_PAGE_SIZE + 1);
	});

	it("mints next_cursor only when the extra row came back", async () => {
		rowsResult = [listRow(), listRow({ id: CLUSTER_ID })];
		countResult = 2;
		const full = await driveOk("?limit=1");
		expect(full.clusters).toHaveLength(1);
		expect(full.page.next_cursor).not.toBeNull();

		rowsResult = [listRow()];
		const last = await driveOk("?limit=1");
		expect(last.page.next_cursor).toBeNull();
	});

	it("falls back to the default environment name when a project has none", async () => {
		rowsResult = [listRow({ environment: null })];
		countResult = 1;
		const body = await driveOk("");
		expect(body.clusters[0].environment).toBe("development");
	});

	it("reports the capped total as a floor rather than a precise-looking lie", async () => {
		rowsResult = [listRow()];
		countResult = 2000;
		const body = await driveOk("");
		expect(body.page.mode).toBe("capped");
		expect(body.page.total).toBe(1000);
	});

	it("refuses a cursor minted for another ORGANIZATION", async () => {
		// The 400 is the point. A cursor carries no authority — it is refused rather than answered
		// because silently ignoring it restarts the walk from the top and duplicates every row
		// already seen, and answering it with THIS org's page hides which of the two the caller
		// thought was in effect.
		const foreign = encodeCursor(
			{ orgId: OTHER_ORG, list: "clusters" },
			{ createdAt: CURSOR_KEY, id: CLUSTER_ID },
		);
		const { status, body } = await drive(`?cursor=${encodeURIComponent(foreign)}`);
		expect(status).toBe(400);
		expect(errorSchema.parse(body).error).toMatch(/different list or organization/);
		// It never reached the database.
		expect(captured.rowsWhere).toBeUndefined();
	});

	it("refuses a cursor minted for another LIST in the same org", async () => {
		// Only a test that mints a cursor INDEPENDENTLY can see this one: a round-trip walk mints
		// and decodes with the same collection name, so renaming it changes both together.
		const jobsCursor = encodeCursor(
			{ orgId: ORG, list: "jobs" },
			{ createdAt: CURSOR_KEY, id: CLUSTER_ID },
		);
		const { status } = await drive(`?cursor=${encodeURIComponent(jobsCursor)}`);
		expect(status).toBe(400);
	});

	it("refuses a malformed cursor and a non-numeric limit, each by name", async () => {
		const bad = await drive("?cursor=not-a-cursor");
		expect(bad.status).toBe(400);
		expect(errorSchema.parse(bad.body).error).toMatch(/malformed/);

		const limit = await drive("?limit=abc");
		expect(limit.status).toBe(400);
		expect(errorSchema.parse(limit.body).error).toMatch(/positive integer/);
	});

	it("treats an EMPTY cursor as the first page rather than as malformed", async () => {
		// `?cursor=` is what a client that builds its query string from an empty variable sends.
		// Refusing it would fail the very first call of every walk.
		const { status } = await drive("?cursor=");
		expect(status).toBe(200);
		expect(normalized(render(captured.rowsWhere).sql)).toBe(EXPECTED_SCOPE);
	});

	it("does NOT accept an offset — this endpoint never had one to keep", async () => {
		// `/api/jobs` still honours `?offset=` because a shipped CLI walks it that way and an
		// ignored offset would page the same rows forever. Nothing has ever sent one here, so
		// honouring it would be inventing a second mechanism. It is ignored, and the assertion is
		// that it changes NOTHING — not that it errors, which would break a caller who appends
		// every parameter it knows.
		await drive("?offset=20");
		expect(normalized(render(captured.rowsWhere).sql)).toBe(EXPECTED_SCOPE);
		// The ceiling, because `?offset=` is neither `limit` nor `cursor` — an offset-sending
		// caller has still not asked for a page. See the defaults test above.
		expect(captured.rowsLimit).toBe(MAX_PAGE_SIZE + 1);
	});

	it("returns the guard's refusal untouched", async () => {
		// The header claims this file owns every refusal, and this is the route's FIRST one — the
		// `if ("error" in auth) return auth.error` that precedes every query. The integration
		// sibling always stubs an authorized actor and SKIPS when Postgres is unreachable, so
		// without this the branch is covered nowhere. Mirrors tests/api/jobs/list-route.test.ts.
		vi.mocked(authorizeCli).mockResolvedValue({
			error: new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
			}),
		});
		const { status, body } = await drive("");
		expect(status).toBe(403);
		expect(errorSchema.parse(body).error).toBe("Forbidden");
		// And it returns BEFORE the first query, which is the property that makes the refusals
		// real here rather than DB-gated.
		expect(captured.rowsWhere).toBeUndefined();
	});
});
