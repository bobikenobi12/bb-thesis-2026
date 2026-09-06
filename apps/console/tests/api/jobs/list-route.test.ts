// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// GET /api/jobs — what the handler BUILDS, asserted without a database.
//
// The sibling suite (tests/integration/cli-jobs-list-route.test.ts) drives this route against real
// Postgres and is where the paging PROPERTIES are proven; a mock cannot prove that a keyset walk
// is gap-free. What a mock can prove, and what that suite cannot show directly, is the SHAPE of
// the two queries the handler composes — specifically that the count is taken over the SCOPE and
// not over the remainder after the cursor. Those two queries differ by one predicate, and a
// fixture with the wrong number of rows in it would let both readings pass.
//
// SO THE ASSERTIONS READ THE RENDERED SQL, not a drizzle object graph. `PgDialect.sqlToQuery` is
// the same rendering postgres receives, so "the tenancy predicate is in the WHERE clause" is
// answered by the artifact rather than by re-implementing `and()` in the test.
//
// This file also owns the refusals. Every one of them returns before the first query, so they are
// real here rather than DB-gated — which matters, because the integration tier SKIPS when Postgres
// is unreachable and these are the branches a caller hits by typo.

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));
vi.mock("@/app/server/actions/projects", () => ({
	planProject: vi.fn(),
	provisionProject: vi.fn(),
	destroyProject: vi.fn(),
}));

import { GET } from "@/app/api/jobs/route";
import { authorizeCli } from "@/lib/authz/guard";
import { cursorKey, encodeCursor } from "@/lib/cli/paging";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { makeJob } from "../../fixtures/jobs";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
/** What `cursorKey()` projects: six fractional digits, which a JS Date cannot carry. */
const CURSOR_KEY = "2026-06-30T00:00:00.123456Z";

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
 * what is being asserted, because they are what tell a disjunction from a conjunction.
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
	rowsOffset: number | undefined;
	countWhere: SQL | undefined;
	orderBy: SQL[];
}

let captured: Captured;
/** Rows the fake rows-query resolves. Set per test. */
let rowsResult: unknown[];
/** What the capped-count scan reports. */
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
			leftJoin: self,
			innerJoin: self,
			as: self,
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
			offset: (n: number) => {
				captured.rowsOffset = n;
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
		// `project_id` is a uuid column on the wire, and makeJob's default ("proj-1") is not one —
		// cliJson would refuse the envelope and answer 500, which is a contract violation rather
		// than the thing under test.
		job: makeJob({ id: JOB_ID, org_id: ORG, user_id: USER, project_id: null }),
		cursor_key: CURSOR_KEY,
		project_name: "web",
		runner_name: null,
		...overrides,
	};
}

/** The envelope this route returns, narrowed enough to assert on without a cast. */
const bodySchema = z.object({
	jobs: z.array(z.object({ id: z.string() })),
	total: z.number(),
	limit: z.number(),
	offset: z.number(),
	page: z.object({
		mode: z.string(),
		limit: z.number(),
		total: z.number(),
		next_cursor: z.string().nullable(),
	}),
});
const errorSchema = z.object({ error: z.string() });

async function drive(query: string) {
	const res = await GET(new Request(`http://console.test/api/jobs${query}`));
	const body: unknown = await res.json();
	return { status: res.status, body };
}

/** Drives the route and parses a 200 envelope, failing loudly on any other status. */
async function driveOk(query: string) {
	const { status, body } = await drive(query);
	expect(status).toBe(200);
	return bodySchema.parse(body);
}

describe("GET /api/jobs — org scope, ?mine and the paging vocabulary (#3672)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		captured = {
			rowsProjection: undefined,
			rowsWhere: undefined,
			rowsLimit: undefined,
			rowsOffset: undefined,
			countWhere: undefined,
			orderBy: [],
		};
		rowsResult = [];
		countResult = 0;
		vi.mocked(authorizeCli).mockResolvedValue({
			actor: { userId: USER, orgId: ORG },
		});
		vi.mocked(getServiceDb).mockReturnValue(fakeDb() as never);
	});

	it("authorizes as a CLI job VIEW rather than resolving a bare user id", async () => {
		await drive("");
		expect(vi.mocked(authorizeCli).mock.calls[0][1]).toBe("view");
		expect(vi.mocked(authorizeCli).mock.calls[0][2]).toEqual({ type: "job" });
	});

	it("scopes the rows on org_id ALONE — the caller's org and their personal org", async () => {
		await drive("");
		const where = render(captured.rowsWhere);
		// The WHOLE parameter list, not a containment check. The bug this route had was
		// `eq(jobs.user_id, userId)` — one user's jobs where the org's were wanted.
		expect(where.params).toEqual([ORG, USER]);
		// BOTH IDS APPEAR, AND BOTH ARE COMPARED TO `org_id`. The second is the caller's user id
		// used as an ORG id, which is what a personal org's id is: #3942 stamps `org_id` forward
		// with no backfill, so pre-#3942 runner jobs still carry `org_id = user_id`.
		expect(where.sql).toContain('"org_id"');
		// `user_id` MUST NOT APPEAR in the default predicate, and this is the assertion that
		// matters. The first cut was `(org_id = $1 or user_id = $2)`, quoting the `owner_all` RLS
		// policy — and unbounded by org on the second arm. `actor.userId` is the MINTING HUMAN for
		// a service token, so that arm returned their jobs from every org they belong to through a
		// credential pinned to one. Any predicate that mentions `user_id` here has that shape back.
		expect(where.sql).not.toContain('"user_id"');
		expect(normalized(where.sql)).toContain('"jobs"."org_id" in ($1, $2)');
	});

	it("renders the default WHERE as the policy and NOTHING else", async () => {
		// The whole rendered clause, by hand, `toBe` rather than `toContain`: an extra ANDed arm is
		// as much a defect as a missing one, and a containment check cannot see one. Written out
		// rather than rebuilt from `sql`/`inArray`, because an expectation composed the same way
		// the route composes it agrees with the route by construction.
		//
		// ONE COLUMN. That is the property — the tenancy boundary is `org_id` and nothing else, so
		// there is no second arm for a caller's identity to widen it through.
		await drive("");
		expect(normalized(render(captured.rowsWhere).sql)).toBe('"jobs"."org_id" in ($1, $2)');
	});

	it("NARROWS to the caller INSIDE the org scope under ?mine=true, rather than replacing it", async () => {
		await drive("?mine=true");
		const where = render(captured.rowsWhere);
		// `?mine=true` means "my jobs in this org", not "my jobs anywhere". Replacing the org scope
		// with `user_id = $1` — which this route did first — is the same cross-tenant leak as the
		// old default arm, reached through the flag instead: scoped to org A with a token whose
		// minter also belongs to org B, it answered with B's rows too.
		//
		// NOTHING IS DROPPED BY THE NARROWING. The job `?mine` most obviously means is the
		// project-less one the trigger stamped `org_id = user_id`, and the caller's user id is the
		// second element of the org list — so the personal-org row is inside the scope, not
		// excluded by it. That is why this can be an AND at all.
		expect(where.params).toEqual([USER, ORG, USER]);
		expect(where.sql).toContain('"user_id"');
		expect(where.sql).toContain('"org_id"');
		expect(normalized(where.sql)).toBe(
			'("jobs"."user_id" = $1 and "jobs"."org_id" in ($2, $3))',
		);
		expect(render(captured.countWhere).params).toEqual([USER, ORG, USER]);
	});

	it("adds the status predicate to the rows AND to the count", async () => {
		await drive("?status=QUEUED");
		expect(render(captured.rowsWhere).params).toEqual([ORG, USER, "QUEUED"]);
		// A facet or count taken from different predicates than the rows is the console filter
		// standard's named defect; here it would report the org's whole job history beside a
		// single-status page.
		expect(render(captured.countWhere).params).toEqual([ORG, USER, "QUEUED"]);
	});

	it("counts over the SCOPE, not over the remainder after the cursor", async () => {
		const cursor = encodeCursor(
			{ orgId: ORG, list: "jobs" },
			{ createdAt: CURSOR_KEY, id: JOB_ID },
		);
		await drive(`?cursor=${encodeURIComponent(cursor)}`);
		const rows = render(captured.rowsWhere);
		const counted = render(captured.countWhere);
		// The keyset predicate is on the rows query only. A total that shrank as the caller paged
		// would read as rows disappearing from under them.
		expect(rows.sql).toContain("::timestamptz");
		expect(rows.params).toEqual([ORG, USER, CURSOR_KEY, JOB_ID]);
		expect(counted.params).toEqual([ORG, USER]);
	});

	it("hands the count the SAME tuple as the rows, so total cannot disagree with them", async () => {
		// `total` and the rows are two readings of one scope. They are built from a single tuple
		// precisely so they cannot drift, and this asserts the artifact rather than the intent —
		// in both modes, because `?mine` is where a second, separately-built predicate would be
		// easiest to introduce.
		for (const q of ["", "?mine=true", "?status=QUEUED", "?mine=true&status=QUEUED"]) {
			captured.rowsWhere = undefined;
			captured.countWhere = undefined;
			await drive(q);
			const rows = render(captured.rowsWhere);
			const counted = render(captured.countWhere);
			expect(normalized(counted.sql)).toBe(normalized(rows.sql));
			expect(counted.params).toEqual(rows.params);
		}
	});

	it("asks for one row more than the page, so the extra row alone decides `has more`", async () => {
		await drive("?limit=7");
		expect(captured.rowsLimit).toBe(8);
	});

	it("orders by created_at DESC NULLS LAST then id DESC NULLS LAST", async () => {
		await drive("");
		// NULLS LAST is not decoration: postgres defaults DESC to NULLS FIRST, and the cursor
		// index (`idx_jobs_org_cursor`) is DESC NULLS LAST. Dropping it plans a sort.
		const rendered = captured.orderBy.map((o) => render(o).sql);
		expect(rendered).toEqual([
			expect.stringContaining("desc nulls last"),
			expect.stringContaining("desc nulls last"),
		]);
		expect(rendered[0]).toContain('"created_at"');
		expect(rendered[1]).toContain('"id"');
	});

	it("passes the legacy offset through to the same query", async () => {
		await drive("?offset=40");
		expect(captured.rowsOffset).toBe(40);
	});

	it("echoes page.total and page.limit into the pre-cursor fields rather than counting twice", async () => {
		rowsResult = [listRow()];
		countResult = 3;
		const parsed = await driveOk("?limit=5&offset=10");
		expect(parsed.page.total).toBe(3);
		expect(parsed.total).toBe(parsed.page.total);
		expect(parsed.limit).toBe(parsed.page.limit);
		expect(parsed.offset).toBe(10);
		expect(parsed.page.mode).toBe("exact");
		expect(parsed.page.next_cursor).toBeNull();
	});

	it("projects the ordering key at MICROSECOND precision, using the vocabulary's own expression", async () => {
		// THIS TEST EXISTS BECAUSE A MUTANT SURVIVED. Swapping `cursorKey(jobs.created_at)` for a
		// millisecond `to_char` left every assertion in this file green: the fake never executes
		// SQL, so the projection is never evaluated and `cursor_key` is whatever the fixture says
		// — two distinct code paths returning the same value. The expression itself has to be
		// read, not its result.
		await drive("");
		const projection = captured.rowsProjection;
		if (projection === undefined) throw new Error("the rows query was never built");
		const key = render(projection.cursor_key as SQL);
		// Independent of `cursorKey`: `US` is postgres' six-digit microsecond field. `MS` is three,
		// and three silently drops every row written in the same millisecond as the page boundary.
		expect(key.sql).toContain('US"Z"');
		expect(key.sql).not.toContain("MS");
		// And it must be the vocabulary's expression rather than a look-alike of the route's own,
		// so a second definition cannot drift from the one paging.ts proves against Postgres.
		expect(key.sql).toBe(render(cursorKey(jobs.created_at)).sql);
	});

	it("mints the next cursor from the projected key, not from the row's Date", async () => {
		// Six rows for a page of five: the extra row is what says there is more.
		rowsResult = Array.from({ length: 6 }, (_, i) =>
			listRow({
				job: makeJob({
					id: `4444444${i}-4444-4444-8444-444444444444`,
					org_id: ORG,
					user_id: USER,
					project_id: null,
				}),
			}),
		);
		countResult = 6;
		const parsed = await driveOk("?limit=5");
		expect(parsed.jobs.length).toBe(5);
		const cursor = parsed.page.next_cursor;
		expect(cursor).not.toBeNull();
		// Decoding it back must yield the MICROSECOND key. `jobs.created_at` read as a column is a
		// millisecond-precision Date, and a cursor minted from that skips every row in the gap.
		const decoded = z
			.object({ t: z.string() })
			.parse(JSON.parse(Buffer.from(cursor ?? "", "base64url").toString("utf8")));
		expect(decoded.t).toBe(CURSOR_KEY);
	});

	describe("refusals — each returns before the first query", () => {
		it.each([
			["?limit=abc", "limit must be a positive integer"],
			["?limit=0", "limit must be a positive integer"],
			["?offset=abc", "offset must be a non-negative integer"],
			["?offset=-1", "offset must be a non-negative integer"],
			// All digits, so the shape test passes — and 1e20 is not a safe integer, which is what
			// stops it reaching postgres as a float and raising there instead of here.
			["?offset=99999999999999999999", "offset must be a non-negative integer"],
			["?mine=yes", "mine must be true or false"],
			["?cursor=zzz", "cursor is malformed"],
		])("400s on %s", async (query, message) => {
			const { status, body } = await drive(query);
			expect(status).toBe(400);
			expect(errorSchema.parse(body).error).toBe(message);
			// The refusal has to be a refusal, not a query that happened to return nothing.
			expect(captured.rowsWhere).toBeUndefined();
		});

		it("400s on a cursor minted for another organization", async () => {
			const foreign = encodeCursor(
				{ orgId: OTHER_ORG, list: "jobs" },
				{ createdAt: CURSOR_KEY, id: JOB_ID },
			);
			const { status, body } = await drive(`?cursor=${encodeURIComponent(foreign)}`);
			expect(status).toBe(400);
			expect(errorSchema.parse(body).error).toContain(
				"different list or organization",
			);
			expect(captured.rowsWhere).toBeUndefined();
		});

		it("400s on a cursor minted for another LIST in the same org", async () => {
			const wrongList = encodeCursor(
				{ orgId: ORG, list: "clusters" },
				{ createdAt: CURSOR_KEY, id: JOB_ID },
			);
			const { status } = await drive(`?cursor=${encodeURIComponent(wrongList)}`);
			expect(status).toBe(400);
		});

		it("400s on a cursor combined with a non-zero offset", async () => {
			const cursor = encodeCursor(
				{ orgId: ORG, list: "jobs" },
				{ createdAt: CURSOR_KEY, id: JOB_ID },
			);
			const { status, body } = await drive(
				`?offset=5&cursor=${encodeURIComponent(cursor)}`,
			);
			expect(status).toBe(400);
			expect(errorSchema.parse(body).error).toContain("cannot be combined");
		});

		it("accepts offset=0 with a cursor — a client that always writes the parameter", async () => {
			const cursor = encodeCursor(
				{ orgId: ORG, list: "jobs" },
				{ createdAt: CURSOR_KEY, id: JOB_ID },
			);
			const { status } = await drive(`?offset=0&cursor=${encodeURIComponent(cursor)}`);
			expect(status).toBe(200);
			expect(captured.rowsOffset).toBe(0);
		});

		it("returns the guard's refusal untouched", async () => {
			vi.mocked(authorizeCli).mockResolvedValue({
				error: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
			});
			const { status } = await drive("");
			expect(status).toBe(403);
			expect(captured.rowsWhere).toBeUndefined();
		});
	});
});
