// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the CLI paging vocabulary (lib/cli/paging.ts) against real Postgres.
//
// A FIXTURE CANNOT PROVE ANY OF THIS. The claims are all about what the database does across page
// boundaries — that a keyset walk is gap-free and duplicate-free under a concurrent head insert,
// that ties are broken by id rather than shuffled, that the total counts one org, that another
// org's cursor cannot reach these rows, and that the index the migration adds is the one the page
// query uses. Every one of those is a property of a query plan and a transaction.
//
// AND THE TIMESTAMPS HERE ARE COMPUTED BY POSTGRES, NEVER BY JAVASCRIPT. `timestamptz` is
// microsecond precision and a JS `Date` is millisecond precision, so a fixture seeded with
// `new Date(...)` has `µs = 0` on every row and a cursor that silently truncates to milliseconds
// is a no-op against it — the suite would pass while rows were dropped in production. That is not
// hypothetical: it is the defect this file was rewritten to catch (#3719). So every seeded row's
// `created_at` is derived in SQL from `now()`, the rows are spaced by MICROSECONDS rather than
// milliseconds so several share a millisecond, and the census below fails if that stops being
// true.
//
// The routes read through getServiceDb(), whose role BYPASSES row-level security, so the org
// boundary is the WHERE clause and nothing else — which is why org B is seeded with rows that
// WOULD come back if that predicate were dropped, and why several assertions are written as
// "exactly org A's id set" rather than "at least N rows".

import { randomUUID } from "node:crypto";
import { desc, eq, inArray, type SQLWrapper, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import {
	type CursorPosition,
	type CursorScope,
	DEFAULT_COUNT_CAP,
	DEFAULT_PAGE_SIZE,
	MAX_PAGE_SIZE,
	type PageInfo,
	type PageOpts,
	cursorKey,
	encodeCursor,
	pageOrder,
	paginate,
	parsePageOpts,
} from "@/lib/cli/paging";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { describeIfDb } from "./db";

/** Small enough that a walk is several pages, large enough that a tie can straddle a boundary. */
const PAGE_SIZE = 5;
/** The size the issue names: three full pages and a remainder of one. */
const ORG_A_ROWS = 3 * PAGE_SIZE + 1;
/** The decoy. Not zero and not ORG_A_ROWS, so a leak changes a total rather than hiding in one. */
const ORG_B_ROWS = 7;
/**
 * Microseconds between consecutive rows.
 *
 * DELIBERATELY UNDER A MILLISECOND, and not a divisor of one. Seven rows therefore share each
 * millisecond, which is what a batch enqueue produces and what a millisecond-precision cursor
 * cannot page through: it truncates DOWN to the millisecond floor, so every row between the floor
 * and the row the cursor was minted from is excluded from the next page and from every page after
 * it. Space the fixture by milliseconds instead and the same bug is invisible.
 */
const ROW_SPACING_US = 137;
/** Rows 4, 5 and 6 share one timestamp exactly, so a page boundary lands inside a tie group. */
const TIE_INDEXES = [4, 5, 6];
/** Offsets org B by a fraction of the spacing so its rows interleave org A's rather than trail. */
const ORG_B_PHASE_US = 61;
/** Rows for the planner test's own org. Enough that the plan is not a rounding decision. */
const PLAN_ORG_ROWS = 300;
/**
 * The large fixture: rows in the scale guard's own org, and the decoys sharing the table with it.
 *
 * NOT the 200k the first draft of this guard seeded. Every one of those rows fires two per-row
 * plpgsql triggers — jobs_set_scheduling runs an org_effective_plan SELECT, jobs_runner_wake a
 * pg_notify — and then comes back out across seven indexes. That is a FIXED multi-minute cost, and
 * it timed out in CI against `testTimeout: 30_000` rather than flaking, so a re-run could not have
 * cleared it. 30k fits the 60s `hookTimeout` the seed now runs under, and it is still far past the
 * point where a seq scan of `jobs` is free — which is all this guard needs, because it asserts the
 * SHAPE the unconstrained planner picks and not which of the two org indexes it picks.
 */
const PLAN_SCALE_ORG_ROWS = 5_000;
const PLAN_SCALE_DECOY_ROWS = 25_000;

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ORG_IDS = [ORG_A, ORG_B];

const SCOPE_A: CursorScope = { orgId: ORG_A, list: "jobs" };
const SCOPE_B: CursorScope = { orgId: ORG_B, list: "jobs" };

/** One page's rows: the id, and the ordering key exactly as Postgres renders it. */
interface Row {
	id: string;
	cursor_key: string;
}

const insertedIdsSchema = z.array(z.object({ id: z.uuid() }));

/** The per-org row census the scale fixture is checked against. Parsed, never cast. */
const censusSchema = z.array(z.object({ org_id: z.uuid(), n: z.number() }));

/**
 * Inserts one job per entry at `now()` minus that entry's microsecond offset, and returns the ids.
 *
 * `now()` is the transaction timestamp and is therefore CONSTANT across the rows of one statement,
 * so the offsets alone decide the ordering — the fixture is deterministic even though its anchor
 * is not. `date_trunc` pins the anchor to a millisecond boundary so that a row's sub-millisecond
 * component is a property of its offset rather than of when the suite happened to run; the census
 * asserts what that produces.
 */
async function seedRows(
	rows: readonly { orgId: string; offsetUs: number }[],
): Promise<string[]> {
	// ONE STATEMENT, so ONE now(). Seeding two orgs with two statements gives them anchors
	// milliseconds apart, which silently un-interleaves them: every row of the second org sorts
	// above every row of the first, and the cross-org assertions below stop testing anything.
	const orgs = sql.join(
		rows.map((r) => sql`${r.orgId}::uuid`),
		sql`, `,
	);
	const offs = sql.join(
		rows.map((r) => sql`${r.offsetUs}::bigint`),
		sql`, `,
	);
	const inserted = await getServiceDb().execute(sql`
		insert into jobs (user_id, org_id, job_type, status, config_snapshot, created_at)
		select org, org, 'PLAN', 'QUEUED', '{}'::jsonb,
		       date_trunc('milliseconds', now()) - (off * interval '1 microsecond')
		from unnest(array[${orgs}], array[${offs}]) as u(org, off)
		returning id
	`);
	return insertedIdsSchema.parse(inserted).map((r) => r.id);
}

/** Single-org convenience over {@link seedRows}. */
async function seedAt(
	orgId: string,
	offsetsUs: readonly number[],
): Promise<string[]> {
	return seedRows(offsetsUs.map((offsetUs) => ({ orgId, offsetUs })));
}

/** Seeds a large planner population without expanding one SQL parameter per row. */
async function seedPlannerRows(orgId: string, count: number): Promise<void> {
	await getServiceDb().execute(sql`
		insert into jobs (user_id, org_id, job_type, status, config_snapshot, created_at)
		select ${orgId}::uuid, ${orgId}::uuid, 'PLAN', 'QUEUED', '{}'::jsonb,
		       date_trunc('milliseconds', now()) - (i * ${ROW_SPACING_US} * interval '1 microsecond')
		from generate_series(0, ${count - 1}) as s(i)
	`);
}

/** The offsets for one org: `ROW_SPACING_US` apart, with `tieIndexes` collapsed onto one. */
function offsets(
	count: number,
	phaseUs: number,
	tieIndexes: readonly number[] = [],
): number[] {
	const tieAt = tieIndexes.length > 0 ? tieIndexes[0] : -1;
	return Array.from({ length: count }, (_, i) => {
		const at = tieIndexes.includes(i) ? tieAt : i;
		return at * ROW_SPACING_US + phaseUs;
	});
}

/**
 * One page of org `orgId`'s jobs through the shipped `paginate`. This is the composition #3672's
 * routes will use — the projection and the joins are the caller's, everything else (the keyset
 * predicate, the ordering, the `limit + 1`, the capped count, the next cursor) comes from
 * lib/cli/paging.ts. Note `cursorKey(...)`, not `jobs.created_at`: reading the column hands back a
 * JS Date whose microseconds are already gone.
 */
async function fetchPage(
	orgId: string,
	opts: PageOpts,
	countCap?: number,
): Promise<{ items: Row[]; page: PageInfo }> {
	const db = getServiceDb();
	return paginate<Row>({
		db,
		table: jobs,
		createdAt: jobs.created_at,
		id: jobs.id,
		scope: [eq(jobs.org_id, orgId)],
		cursor: { orgId, list: "jobs" },
		opts,
		countCap,
		rows: (q) =>
			db
				.select({ id: jobs.id, cursor_key: cursorKey(jobs.created_at) })
				.from(jobs)
				.where(q.where)
				.orderBy(...q.orderBy)
				.limit(q.limit),
		positionOf: (row) => ({ createdAt: row.cursor_key, id: row.id }),
	});
}

/** A walked collection, plus the per-page metadata the assertions need. */
interface Walk {
	items: Row[];
	pages: PageInfo[];
}

/**
 * Walks `orgId`'s jobs to exhaustion through the real request surface: each next cursor is
 * re-encoded into a query string and re-parsed by `parsePageOpts`, so the round trip through the
 * opaque wire form is part of what is being proved.
 *
 * `betweenPages` runs after each page and is where a concurrent insert goes.
 *
 * The loop is bounded and the bound is an ASSERTION, not a safety net: a walk that needs more than
 * `hardStop` pages for this fixture is a non-terminating cursor, and this test's job is to say so
 * rather than hang until vitest's timeout reports something unrelated.
 */
async function walk(
	orgId: string,
	pageSize: number,
	betweenPages?: (pageIndex: number) => Promise<void>,
): Promise<Walk> {
	const scope: CursorScope = { orgId, list: "jobs" };
	const hardStop = 20;
	const items: Row[] = [];
	const pages: PageInfo[] = [];
	let cursor: string | null = null;

	for (let i = 0; i < hardStop; i++) {
		const params = new URLSearchParams({ limit: String(pageSize) });
		if (cursor !== null) params.set("cursor", cursor);
		const parsed = parsePageOpts(params, scope);
		if (!parsed.ok) throw new Error(`page ${i + 1}: ${parsed.error}`);

		const page = await fetchPage(orgId, parsed.opts);
		items.push(...page.items);
		pages.push(page.page);
		if (page.page.next_cursor === null) return { items, pages };
		cursor = page.page.next_cursor;
		await betweenPages?.(i);
	}
	throw new Error(`walk did not exhaust in ${hardStop} pages`);
}

/**
 * True when `a` sorts strictly before `b` under {@link pageOrder}.
 *
 * The keys are fixed-width UTC text, so lexicographic order IS chronological order — no parsing,
 * and in particular no `new Date()`, which would throw the microseconds away and make this
 * comparison agree with the very bug it is here to catch.
 */
function strictlyBefore(a: Row, b: Row): boolean {
	if (a.cursor_key !== b.cursor_key) return a.cursor_key > b.cursor_key;
	return a.id > b.id;
}

/** The EXPLAIN (FORMAT JSON) envelope. Parsed, not cast — the plan tree itself stays opaque. */
const explainSchema = z.array(z.object({ "QUERY PLAN": z.array(z.unknown()) }));

/**
 * Returns `query`'s plan as JSON text, by default with sequential scans disabled.
 *
 * Disabling seqscan asks the question that matters on any table small enough to live in a test —
 * CAN this index answer the query, ordering and all — rather than whether Postgres bothers.
 * `enable_sort` is deliberately left ON: turning it off would make "no Sort node" true by
 * construction. The one setting is SET LOCAL inside a transaction because postgres-js pools
 * connections and a bare SET would land on whichever one it liked, leaving the EXPLAIN to run on a
 * connection that never saw it.
 *
 * `seqscan: "on"` leaves the planner alone, and is NOT interchangeable with the default. A plan
 * recorded with seqscan OFF cannot report drift toward a seq scan at all — that candidate was
 * removed from the choice set before the planner ran — so it answers "can this index serve the
 * query", never "is this what Postgres picks". Any assertion about a planner CHOICE has to pass
 * "on".
 */
async function explain(
	query: SQLWrapper,
	seqscan: "off" | "on" = "off",
): Promise<string> {
	const rows = await getServiceDb().transaction(async (tx) => {
		if (seqscan === "off") {
			await tx.execute(sql`set local enable_seqscan = off`);
		}
		return tx.execute(sql`explain (format json) ${query}`);
	});
	return JSON.stringify(explainSchema.parse(rows));
}

/** Reads every cursor key for an org, newest first. */
async function keysOf(orgId: string): Promise<string[]> {
	const rows = await getServiceDb()
		.select({ cursor_key: cursorKey(jobs.created_at) })
		.from(jobs)
		.where(eq(jobs.org_id, orgId))
		.orderBy(...pageOrder(jobs.created_at, jobs.id));
	return rows.map((r) => r.cursor_key);
}

describeIfDb("CLI paging vocabulary", () => {
	let orgAIds: string[] = [];
	let orgBIds: string[] = [];

	beforeAll(async () => {
		// Both orgs in one statement — see seedRows. Org B's phase puts each of its rows between
		// two of org A's, so an unscoped query would not append them at the end; it would shuffle
		// them through every page.
		const plan = [
			...offsets(ORG_A_ROWS, 0, TIE_INDEXES).map((offsetUs) => ({
				orgId: ORG_A,
				offsetUs,
			})),
			...offsets(ORG_B_ROWS, ORG_B_PHASE_US).map((offsetUs) => ({
				orgId: ORG_B,
				offsetUs,
			})),
		];
		const ids = await seedRows(plan);
		const byOrg = await getServiceDb()
			.select({ id: jobs.id, org_id: jobs.org_id })
			.from(jobs)
			.where(inArray(jobs.id, ids));
		orgAIds = byOrg.filter((r) => r.org_id === ORG_A).map((r) => r.id);
		orgBIds = byOrg.filter((r) => r.org_id === ORG_B).map((r) => r.id);
	});

	afterAll(async () => {
		await getServiceDb().delete(jobs).where(inArray(jobs.org_id, ORG_IDS));
	});

	// THE CENSUS, and it is not decoration. Every assertion in this file is about a set of seeded
	// rows: if the seed silently did nothing, "no duplicates" and "no cross-org rows" are both
	// trivially true. And the two precision clauses are what stop this suite from degrading back
	// into the fixture that could not see the bug it exists to catch — a millisecond-spaced,
	// millisecond-aligned seed passes every other test in this file while rows are being dropped.
	it("seeded a fixture that can actually see a precision bug", async () => {
		expect(orgAIds).toHaveLength(ORG_A_ROWS);
		expect(orgBIds).toHaveLength(ORG_B_ROWS);
		expect(new Set([...orgAIds, ...orgBIds]).size).toBe(
			ORG_A_ROWS + ORG_B_ROWS,
		);

		const keys = await keysOf(ORG_A);
		expect(keys).toHaveLength(ORG_A_ROWS);

		// (1) Rows carry microseconds a JS Date cannot hold. Without this, truncating a cursor to
		//     milliseconds is lossless and the walk below proves nothing about precision.
		const withSubMs = keys.filter((k) => k.slice(23, 26) !== "000");
		expect(withSubMs.length).toBeGreaterThan(0);

		// (2) Rows COLLIDE at millisecond resolution — several share a millisecond. That is the
		//     condition under which a millisecond cursor loses rows rather than merely naming an
		//     earlier instant, and it is what ROW_SPACING_US is chosen to produce.
		const distinctMs = new Set(keys.map((k) => k.slice(0, 23)));
		expect(distinctMs.size).toBeLessThan(keys.length);

		// (3) The tie group exists, so the id tiebreak is exercised rather than assumed.
		const distinctExact = new Set(keys);
		expect(keys.length - distinctExact.size).toBe(TIE_INDEXES.length - 1);
	});

	it("walks to exhaustion with no gap, no duplicate and a strict total order", async () => {
		const { items, pages } = await walk(ORG_A, PAGE_SIZE);

		// Gap-free and duplicate-free, stated as one thing: the walked ids are EXACTLY the seeded
		// ids. A missing row and a repeated row both break this, and so does a row from org B.
		// With this fixture a millisecond-truncated cursor drops rows here.
		expect(items).toHaveLength(ORG_A_ROWS);
		expect(new Set(items.map((r) => r.id))).toEqual(new Set(orgAIds));

		// Every adjacent pair, including the ones that straddle a page boundary and the ones
		// inside the tie group, is strictly ordered. Equality anywhere means the tiebreak is
		// missing and the boundary between those two rows is undefined.
		for (let i = 1; i < items.length; i++) {
			expect(strictlyBefore(items[i - 1], items[i])).toBe(true);
		}

		// 16 rows at 5 per page is four pages, and only the last carries a null cursor.
		expect(pages).toHaveLength(4);
		expect(pages.map((p) => p.next_cursor === null)).toEqual([
			false,
			false,
			false,
			true,
		]);
		expect(pages.every((p) => p.limit === PAGE_SIZE)).toBe(true);
		// The total is the COLLECTION, not the remainder, so it does not tick down as the walk
		// proceeds. Counting the keyset-filtered rows instead would give 16, 11, 6, 1.
		expect(pages.map((p) => p.total)).toEqual([
			ORG_A_ROWS,
			ORG_A_ROWS,
			ORG_A_ROWS,
			ORG_A_ROWS,
		]);
	});

	// The precision case, pinned to three rows and one boundary so a failure names itself rather
	// than arriving as "the walk was short by three". The middle row lies strictly between the
	// last row of page 1 and that row's own millisecond floor: a cursor that truncates excludes
	// it from page 2 AND from every later page, with no error and a next_cursor that looks fine.
	it("does not skip a row between the cursor and its millisecond floor", async () => {
		const org = randomUUID();
		try {
			// 2500µs, 2900µs and 4000µs before a millisecond-aligned anchor. Page 1 (size 1)
			// returns the 2500 row; its millisecond floor is 3000µs before the anchor, and the
			// 2900 row sits strictly between the two.
			const ids = await seedAt(org, [2500, 2900, 4000]);
			expect(ids).toHaveLength(3);

			const { items, pages } = await walk(org, 1);
			expect(items).toHaveLength(3);
			expect(new Set(items.map((r) => r.id))).toEqual(new Set(ids));
			expect(pages).toHaveLength(3);

			// The row a truncating cursor loses is specifically the middle one, and it is lost
			// because it shares a millisecond with the row above it. Asserted so a regression
			// reports the case rather than an arity.
			const middle = items[1];
			expect(middle.cursor_key.slice(23, 26)).not.toBe("000");
			expect(middle.cursor_key.slice(0, 23)).toBe(
				items[0].cursor_key.slice(0, 23),
			);
		} finally {
			await getServiceDb().delete(jobs).where(eq(jobs.org_id, org));
		}
	});

	// The production shape: one batch enqueue, one statement, one now(). Every row shares an
	// identical microsecond timestamp, so the walk depends entirely on the id tiebreak — and on
	// the key surviving the round trip, because a truncated cursor lands BELOW all of them and
	// ends the walk one page in.
	it("pages a batch enqueue whose rows all share one now()", async () => {
		const org = randomUUID();
		try {
			const ids = await seedAt(org, new Array(9).fill(0));
			expect(ids).toHaveLength(9);
			const keys = await keysOf(org);
			expect(new Set(keys).size).toBe(1);

			const { items, pages } = await walk(org, 4);
			expect(new Set(items.map((r) => r.id))).toEqual(new Set(ids));
			expect(pages).toHaveLength(3);
			for (let i = 1; i < items.length; i++) {
				expect(strictlyBefore(items[i - 1], items[i])).toBe(true);
			}
		} finally {
			await getServiceDb().delete(jobs).where(eq(jobs.org_id, org));
		}
	});

	it("does not repeat a row when one is inserted at the head mid-walk", async () => {
		const inserted: string[] = [];
		const { items } = await walk(ORG_A, PAGE_SIZE, async (pageIndex) => {
			if (pageIndex !== 0) return;
			// A NEGATIVE offset — a minute into the future, so it is newer than everything seeded
			// and sits at the head of the ordering, above the cursor the walk is now holding.
			// Under offset paging this shifts every later page down by one and page 2 repeats
			// page 1's last row.
			inserted.push(...(await seedAt(ORG_A, [-60_000_000])));
		});

		try {
			// Without this the next three assertions are vacuous: `not.toContain(undefined)`
			// passes for free, and "exactly the original set" is trivially true if the concurrent
			// insert never happened.
			expect(inserted).toHaveLength(1);
			const ids = items.map((r) => r.id);
			expect(new Set(ids).size).toBe(ids.length);
			// The insert landed above the cursor, so the walk neither returns it nor loses a row
			// to make room for it: exactly the original set, still.
			expect(new Set(ids)).toEqual(new Set(orgAIds));
			expect(ids).not.toContain(inserted[0]);
		} finally {
			if (inserted.length > 0) {
				await getServiceDb().delete(jobs).where(inArray(jobs.id, inserted));
			}
		}
	});

	it("counts the caller's org only", async () => {
		const first = await fetchPage(ORG_A, { limit: PAGE_SIZE, after: null });
		expect(first.page.total).toBe(ORG_A_ROWS);
		expect(first.page.mode).toBe("exact");
		// 16, not 23 — ORG_A_ROWS + ORG_B_ROWS is what a count that lost its scope predicate
		// returns, and org B exists in this fixture precisely so that number is different.

		const b = await fetchPage(ORG_B, { limit: PAGE_SIZE, after: null });
		expect(b.page.total).toBe(ORG_B_ROWS);
	});

	it("reports a capped total as a floor, exactly at the ceiling", async () => {
		// Cap below the true count: a floor, and it says so.
		const under = await fetchPage(ORG_A, { limit: PAGE_SIZE, after: null }, 3);
		expect(under.page).toMatchObject({ mode: "capped", total: 3 });

		// The boundary in both directions — one row short of the count is capped, the count
		// itself is exact. A `>=` where the implementation has `>` moves exactly this pair.
		const atMinusOne = await fetchPage(
			ORG_A,
			{ limit: PAGE_SIZE, after: null },
			ORG_A_ROWS - 1,
		);
		expect(atMinusOne.page).toMatchObject({
			mode: "capped",
			total: ORG_A_ROWS - 1,
		});

		const atExactly = await fetchPage(
			ORG_A,
			{ limit: PAGE_SIZE, after: null },
			ORG_A_ROWS,
		);
		expect(atExactly.page).toMatchObject({ mode: "exact", total: ORG_A_ROWS });

		// And the shipped default is far above this fixture, so an unconfigured route is exact.
		expect(DEFAULT_COUNT_CAP).toBeGreaterThan(ORG_A_ROWS);
	});

	it("refuses another org's cursor rather than answering it", async () => {
		const first = await fetchPage(ORG_A, { limit: PAGE_SIZE, after: null });
		const cursorFromA = first.page.next_cursor;
		expect(cursorFromA).not.toBeNull();
		if (cursorFromA === null) return;

		const params = new URLSearchParams({ cursor: cursorFromA });

		// Org B presenting org A's cursor: a 400, not a page.
		const asB = parsePageOpts(params, SCOPE_B);
		expect(asB.ok).toBe(false);
		if (!asB.ok) expect(asB.error).toMatch(/different list or organization/);

		// The same cursor against a different collection in the SAME org: also refused. A jobs
		// position answered by the clusters endpoint is a silently wrong page.
		const asOtherList = parsePageOpts(params, {
			orgId: ORG_A,
			list: "clusters",
		});
		expect(asOtherList.ok).toBe(false);

		// And it still works for the scope that minted it — otherwise the three assertions above
		// pass for a decoder that refuses everything.
		const asA = parsePageOpts(params, SCOPE_A);
		expect(asA.ok).toBe(true);
	});

	it("cannot reach another org's rows even with its cursor position", async () => {
		// The binding above is belt; this is braces. Take org A's position directly — as if the
		// cursor envelope had been forged or the fingerprint dropped in a later refactor — and
		// run a real page under org B's scope.
		const aFirst = await fetchPage(ORG_A, { limit: PAGE_SIZE, after: null });
		expect(aFirst.items.length).toBeGreaterThan(0);
		const stolen: CursorPosition = {
			createdAt: aFirst.items[0].cursor_key,
			id: aFirst.items[0].id,
		};

		const leaked = await fetchPage(ORG_B, {
			limit: MAX_PAGE_SIZE,
			after: stolen,
		});
		const bIds = new Set(orgBIds);
		for (const row of leaked.items) expect(bIds.has(row.id)).toBe(true);
		// Non-vacuous: the stolen position is mid-way through a timeline org B's rows also
		// occupy, so this page is not empty by construction.
		expect(leaked.items.length).toBeGreaterThan(0);
		expect(leaked.page.total).toBe(ORG_B_ROWS);
	});

	it("re-encodes a position to the same cursor, so a walk is deterministic", async () => {
		const first = await fetchPage(ORG_A, { limit: PAGE_SIZE, after: null });
		const last = first.items[first.items.length - 1];
		expect(first.page.next_cursor).toBe(
			encodeCursor(SCOPE_A, { createdAt: last.cursor_key, id: last.id }),
		);
	});

	it("the page query is served by idx_jobs_org_cursor with no sort", async () => {
		const db = getServiceDb();
		// A dedicated org with enough rows that the planner has something to weigh, and its OWN
		// org id so the fixture the other tests assert on is untouched. 16 rows would do on this
		// database and not on a busier one; 300 is not near any boundary.
		const orgPlan = randomUUID();
		try {
			await seedAt(
				orgPlan,
				Array.from({ length: PLAN_ORG_ROWS }, (_, i) => i * ROW_SPACING_US),
			);
			// WITHOUT THIS THE TEST IS A COIN FLIP, and it fails in the direction that looks like
			// a missing index. With no pg_statistic row the planner estimates one matching row, a
			// sort of one row is free, and it takes the narrower idx_jobs_org — on exactly the
			// same schema that plans an Index Only Scan once stats exist. Measured on Postgres 17.
			await db.execute(sql`analyze jobs`);

			// The EXPLAINed statement is the one the module builds, taken from `paginate`'s own
			// PageQuery — not a hand-typed copy that could drift from it.
			const first = await fetchPage(orgPlan, { limit: PAGE_SIZE, after: null });
			const cursor: CursorPosition = {
				createdAt: first.items[0].cursor_key,
				id: first.items[0].id,
			};
			let planned = "";
			let control = "";
			await paginate<Row>({
				db,
				table: jobs,
				createdAt: jobs.created_at,
				id: jobs.id,
				scope: [eq(jobs.org_id, orgPlan)],
				cursor: { orgId: orgPlan, list: "jobs" },
				opts: { limit: PAGE_SIZE, after: cursor },
				rows: async (q) => {
					const select = () =>
						db
							.select({ id: jobs.id, cursor_key: cursorKey(jobs.created_at) })
							.from(jobs)
							.where(q.where)
							.limit(q.limit);
					planned = await explain(select().orderBy(...q.orderBy));
					// THE CONTROL. Identical query, ordered with drizzle's plain `desc()` — which
					// is DESC NULLS FIRST, the default the index does not carry. If this does NOT
					// plan a Sort then "no Sort node" above is not evidence of anything, because
					// the assertion can no longer tell the two apart.
					control = await explain(
						select().orderBy(desc(jobs.created_at), desc(jobs.id)),
					);
					return [];
				},
				positionOf: (row) => ({ createdAt: row.cursor_key, id: row.id }),
			});

			expect(planned).toContain("idx_jobs_org_cursor");
			// The load-bearing half: an index that is scanned and then sorted has bought nothing.
			expect(planned).not.toContain('"Node Type":"Sort"');
			expect(control).toContain('"Node Type":"Sort"');
		} finally {
			await db.delete(jobs).where(eq(jobs.org_id, orgPlan));
		}
	});

	it("serves the module's default page size against the real table", async () => {
		// DEFAULT_PAGE_SIZE is above this fixture, so the whole org is one page and the walk
		// terminates immediately — the single-page path, which the multi-page tests skip.
		const { items, pages } = await walk(ORG_A, DEFAULT_PAGE_SIZE);
		expect(pages).toHaveLength(1);
		expect(pages[0].next_cursor).toBeNull();
		expect(pages[0].limit).toBe(DEFAULT_PAGE_SIZE);
		expect(items).toHaveLength(ORG_A_ROWS);
	});

	it("orders identically whether or not a cursor is present", async () => {
		// pageOrder is the only ordering; a route that used it for page one and something else
		// for page two would still pass every "no duplicates" assertion above as long as the two
		// orderings happened not to overlap on this fixture. This pins the ordering itself
		// against a single unpaged read.
		const db = getServiceDb();
		const straight = await db
			.select({ id: jobs.id })
			.from(jobs)
			.where(eq(jobs.org_id, ORG_A))
			.orderBy(...pageOrder(jobs.created_at, jobs.id));
		const { items } = await walk(ORG_A, PAGE_SIZE);
		expect(items.map((r) => r.id)).toEqual(straight.map((r) => r.id));
	});

	it("refuses to page a collection whose key is not a uuid", async () => {
		// The codec validates cursor ids as uuids and afterCursor casts them ::uuid. Wiring the
		// vocabulary to a non-uuid key column would otherwise serve page 1 correctly and mint a
		// cursor its own parser refuses — a 400 on page 2 with no compile-time signal. It fails
		// here instead, before a row is served, naming the column's type.
		await expect(
			paginate<Row>({
				db: getServiceDb(),
				table: jobs,
				createdAt: jobs.created_at,
				id: jobs.error_message, // text()
				scope: [eq(jobs.org_id, ORG_A)],
				cursor: SCOPE_A,
				opts: { limit: PAGE_SIZE, after: null },
				rows: async () => [],
				positionOf: (row) => ({ createdAt: row.cursor_key, id: row.id }),
			}),
		).rejects.toThrow(/requires a uuid key column, got text/);
	});
});

// The scale guard, and it is a SEPARATE SUITE on purpose.
//
// Two reasons, both load-bearing. Its fixture is tens of thousands of rows plus an `analyze` on the
// shared `jobs` table, and the suite above contains a plan guard that asserts an exact plan shape
// on a 300-row org — those rows underneath it change what the planner does. And a suite-scoped
// `beforeAll` runs under `hookTimeout: 60_000` rather than `testTimeout: 30_000`, which is the
// difference between this seed fitting and this seed being the red check it was in #3906.
describeIfDb("jobs cursor plan at scale", () => {
	const ORG_SCALE = randomUUID();
	const ORG_SCALE_DECOY = randomUUID();

	beforeAll(async () => {
		await seedPlannerRows(ORG_SCALE, PLAN_SCALE_ORG_ROWS);
		await seedPlannerRows(ORG_SCALE_DECOY, PLAN_SCALE_DECOY_ROWS);
		// Without stats the planner estimates ONE matching row and every plan below is a rounding
		// decision — the same coin flip the small-fixture guard documents.
		await getServiceDb().execute(sql`analyze jobs`);
	});

	afterAll(async () => {
		// ONE statement for both orgs. Two sequential deletes leak the decoys if anything throws
		// between them, and an aborted run is exactly that case. In CI the container is disposable;
		// on the shared sandbox database it would be a permanent 25k-row leak into a table every
		// other integration file reads.
		await getServiceDb()
			.delete(jobs)
			.where(inArray(jobs.org_id, [ORG_SCALE, ORG_SCALE_DECOY]));
	});

	// THE CENSUS (#3879). The guard below reads "the planner does not seq scan this table", and
	// that is only a statement about the index if the table is big enough for a seq scan to be a
	// real candidate. A silently short seed makes a seq scan the planner's honest answer, so
	// without this the guard's failure would name the index when the defect was the fixture.
	it("seeded a fixture large enough for a seq scan to be a real candidate", async () => {
		const counted = await getServiceDb().execute(sql`
			select org_id, count(*)::int as n
			from jobs
			where org_id in (${ORG_SCALE}::uuid, ${ORG_SCALE_DECOY}::uuid)
			group by org_id
		`);
		const census = censusSchema.parse(counted);
		const rowsIn = (orgId: string): number | undefined =>
			census.find((r) => r.org_id === orgId)?.n;
		expect(rowsIn(ORG_SCALE)).toBe(PLAN_SCALE_ORG_ROWS);
		expect(rowsIn(ORG_SCALE_DECOY)).toBe(PLAN_SCALE_DECOY_ROWS);
	});

	// WHAT THIS CLAIMS, AND WHAT IT DELIBERATELY DOES NOT. The guard in the suite above asks
	// whether idx_jobs_org_cursor CAN answer the page query with no sort, and asks it with seqscan
	// disabled — the right question on a 300-row fixture, and one that cannot see this one: with
	// the seq scan removed from the planner's choice set, drift TOWARD a seq scan is invisible by
	// construction.
	//
	// So this EXPLAIN leaves the planner alone and asserts the SHAPE only: at this cardinality the
	// page is still reached through an org index. It does not pin idx_jobs_org_cursor over
	// idx_jobs_org, and it does not pin the presence or absence of a Sort node. Both of those are
	// correct answers to this query — the composite index orders the rows for free, the narrower
	// one plus a top-N sort is cheaper to walk — and the choice between them moves with the
	// statistics and the row width. A guard pinning either would go red on a plan that is not a
	// defect. Losing the index is the defect, and a Seq Scan here is what reports it.
	it("reaches the page through an org index, not a seq scan, at scale", async () => {
		const db = getServiceDb();
		const first = await fetchPage(ORG_SCALE, { limit: PAGE_SIZE, after: null });
		const cursor: CursorPosition = {
			createdAt: first.items[0].cursor_key,
			id: first.items[0].id,
		};
		let planned = "";
		await paginate<Row>({
			db,
			table: jobs,
			createdAt: jobs.created_at,
			id: jobs.id,
			scope: [eq(jobs.org_id, ORG_SCALE)],
			cursor: { orgId: ORG_SCALE, list: "jobs" },
			opts: { limit: PAGE_SIZE, after: cursor },
			rows: async (q) => {
				// The EXPLAINed statement is the one the module builds, taken from `paginate`'s own
				// PageQuery rather than hand-typed — the same discipline as the guard above.
				planned = await explain(
					db
						.select({ id: jobs.id, cursor_key: cursorKey(jobs.created_at) })
						.from(jobs)
						.where(q.where)
						.orderBy(...q.orderBy)
						.limit(q.limit),
					"on",
				);
				return [];
			},
			positionOf: (row) => ({ createdAt: row.cursor_key, id: row.id }),
		});

		// THE CONTROL. Same table, same cardinality, filtered on a column no index covers, so a
		// seq scan is the only plan available. If this does NOT report one, the assertion below is
		// matching a string this plan JSON never carries and is true of every plan it could see.
		const control = await explain(
			db
				.select({ id: jobs.id })
				.from(jobs)
				.where(sql`${jobs.error_message} is not null`),
			"on",
		);
		expect(control).toContain('"Node Type":"Seq Scan"');

		expect(planned).not.toContain('"Node Type":"Seq Scan"');
		expect(planned).toMatch(/"Index Name":"idx_jobs_org(_cursor)?"/);
	});
});
