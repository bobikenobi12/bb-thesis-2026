// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: GET /api/jobs — the converted route, against real Postgres.
//
// WHAT A FIXTURE CANNOT PROVE, AND WHY THIS FILE EXISTS SEPARATELY FROM cli-paging.test.ts.
// That suite proves the paging VOCABULARY (lib/cli/paging.ts) is correct. This one proves the
// ROUTE composed it correctly and scoped it to the right tenant — a different claim, and the one
// #3672 is about. The two failures it is written to catch are:
//
//   1. A cursor is a NEW WAY TO ADDRESS ROWS, so it is a new way to address someone else's. The
//      route reads through getServiceDb(), whose role BYPASSES row-level security, so the
//      handler's `org_id in (<caller's org>, <caller's personal org>)` is the entire tenancy
//      boundary. Org B is therefore seeded with rows that WOULD come back if that predicate were
//      dropped, and the walk assertions are written as "exactly org A's id set", never "at least
//      N rows".
//   2. The scope changed from `user_id` alone to that org list, and a `?mine=true` flag was added
//      which NARROWS it to the caller rather than replacing it. A count taken from different
//      predicates than the rows is the console filter standard's named defect, so `total` is
//      asserted against `mine` as well as against the org.
//
//      IT WAS A DISJUNCTION FIRST — `org_id = <org> OR user_id = <caller>`, quoting the `owner_all`
//      RLS policy — and that is a cross-tenant leak when the actor is a service token, whose
//      `userId` is the human who MINTED it. `memberInForeignOrgId` below is the row that proves it
//      closed, and nothing else in this file could see it: every other fixture varies the OWNER
//      while holding the org.
//
// A SECOND SUITE FOLLOWS THIS ONE, at the bottom of the file: the org arm is what this suite
// proves, and the OWNER arm — the rows the trigger stamps with a caller's personal org, which an
// org-only filter hid — is what that one does.
//
// TIMESTAMPS ARE COMPUTED BY POSTGRES, NEVER BY JAVASCRIPT. `timestamptz` is microsecond
// precision and a JS `Date` is millisecond precision; a fixture seeded with `new Date(...)` has
// µs = 0 on every row, and a cursor that truncates to milliseconds is then a no-op against it —
// the suite would pass while production dropped rows. Rows here are spaced by MICROSECONDS, so
// several share a millisecond, and `assertsSubMillisecond` below fails if that stops being true.
//
// The PDP is stubbed and the database is not. `authorizeCli` is the permission gate and is proven
// in the authz suite; what is unproven — and what this file drives — is what the handler does with
// the actor it is handed.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeIfDb } from "./db";

vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
}));
// GET never reaches these, and importing them for real drags the whole server-action graph
// (next/cache, the PDP, the billing guards) into a suite whose subject is a SELECT.
vi.mock("@/app/server/actions/projects", () => ({
	planProject: vi.fn(),
	provisionProject: vi.fn(),
	destroyProject: vi.fn(),
}));

import { GET } from "@/app/api/jobs/route";
import { authorizeCli } from "@/lib/authz/guard";
import { DEFAULT_COUNT_CAP, type PageInfo } from "@/lib/cli/paging";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";

/** Small enough that a walk is several pages, large enough that a tie can straddle a boundary. */
const PAGE_SIZE = 5;
/** The size the programme names: three full pages and a remainder of one. */
const ORG_A_ROWS = 3 * PAGE_SIZE + 1;
/** The decoy. Not zero and not ORG_A_ROWS, so a leak changes a total rather than hiding in one. */
const ORG_B_ROWS = 7;
/**
 * Microseconds between consecutive rows. DELIBERATELY UNDER A MILLISECOND and not a divisor of
 * one, so several rows share each millisecond — the shape a batch enqueue produces and the one a
 * millisecond-precision cursor cannot page through.
 */
const ROW_SPACING_US = 137;
/** Offsets org B by a fraction of the spacing so its rows INTERLEAVE org A's rather than trail. */
const ORG_B_PHASE_US = 61;

const ORG_A = randomUUID();
const ORG_B = randomUUID();
/**
 * A third org, for the one test that INSERTS mid-walk.
 *
 * Its own tenant rather than a row added to org A, so that no test's expectations depend on
 * whether an earlier test in the file has run. Order-coupled fixtures pass in declaration order
 * and fail the first time anyone runs a single test with `-t`, which reads as a product defect.
 */
const ORG_C = randomUUID();
/** Two members of org A. `USER_ME` is the caller; the teammate is whom the old route hid. */
const USER_ME = randomUUID();
const USER_TEAMMATE = randomUUID();
const USER_B = randomUUID();
/**
 * Org C's own member — NOT `USER_ME`, and that is load-bearing rather than tidiness.
 *
 * The scope is `org_id in (<org>, <caller's personal org>)`, so a row a user owns in another org
 * is NOT in their list — but that is a property under test, not a property to lean on when
 * building fixtures. Seeding org C's rows under `USER_ME` would have made every later
 * `actingAs(USER_ME, ORG_A)` expectation depend on the predicate being right, and on whether the
 * mid-walk test had already run — the exact order-coupling ORG_C's own comment above exists
 * to avoid, and one the old `org_id`-only predicate happened to hide.
 */
const USER_C = randomUUID();
const ORG_IDS = [ORG_A, ORG_B, ORG_C];

/** Every row org A gets, in the order they were seeded (newest first is the reverse). */
let orgAIds: string[] = [];
let mineIds: string[] = [];

const insertedIdsSchema = z.array(z.object({ id: z.uuid() }));

/**
 * Inserts one job per entry at `now()` minus that entry's microsecond offset.
 *
 * ONE STATEMENT, so ONE now(). Seeding two orgs with two statements gives them anchors
 * milliseconds apart, which silently un-interleaves them: every row of the second org would sort
 * above every row of the first and the cross-org assertions would stop testing anything.
 */
async function seedRows(
	rows: readonly { orgId: string; userId: string; offsetUs: number }[],
): Promise<string[]> {
	const orgs = sql.join(
		rows.map((r) => sql`${r.orgId}::uuid`),
		sql`, `,
	);
	const users = sql.join(
		rows.map((r) => sql`${r.userId}::uuid`),
		sql`, `,
	);
	const offs = sql.join(
		rows.map((r) => sql`${r.offsetUs}::bigint`),
		sql`, `,
	);
	const inserted = await getServiceDb().execute(sql`
		insert into jobs (user_id, org_id, job_type, status, config_snapshot, created_at)
		select usr, org, 'PLAN', 'QUEUED', '{}'::jsonb,
		       date_trunc('milliseconds', now()) - (off * interval '1 microsecond')
		from unnest(array[${orgs}], array[${users}], array[${offs}]) as u(org, usr, off)
		returning id
	`);
	return insertedIdsSchema.parse(inserted).map((r) => r.id);
}

/** The wire shape this route returns, narrowed enough to assert on without casts. */
const bodySchema = z.object({
	jobs: z.array(z.object({ id: z.string(), user_id: z.string(), org_id: z.string().nullable() })),
	total: z.number(),
	limit: z.number(),
	offset: z.number(),
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
	const res = await GET(new Request(`http://console.test/api/jobs${query}`));
	const raw: unknown = await res.json();
	if (res.status !== 200) {
		throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(raw)}`);
	}
	return bodySchema.parse(raw);
}

/** Drives the route and returns the status + `error` for a refusal. */
async function refusal(query: string): Promise<{ status: number; error: unknown }> {
	const res = await GET(new Request(`http://console.test/api/jobs${query}`));
	const body = z.object({ error: z.unknown() }).parse(await res.json());
	return { status: res.status, error: body.error };
}

/**
 * Walks the endpoint to exhaustion and returns every id in order, plus the page count.
 *
 * Bounded, because an endlessly-advancing cursor is one of the defects the walk is here to catch
 * and an unbounded loop would hang the suite rather than name it.
 */
async function walk(query: string, limit = PAGE_SIZE) {
	const ids: string[] = [];
	const pages: PageInfo[] = [];
	let cursor = "";
	for (let i = 0; i < 50; i++) {
		const sep = query === "" ? "?" : `${query}&`;
		const body = await get(
			`${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
		);
		ids.push(...body.jobs.map((j) => j.id));
		pages.push(body.page);
		if (body.page.next_cursor === null) return { ids, pages };
		cursor = body.page.next_cursor;
	}
	throw new Error("walk did not exhaust in 50 pages");
}

describeIfDb("GET /api/jobs — org scope, ?mine, and cursor paging (#3672)", () => {
	beforeAll(async () => {
		// Org A's rows alternate between the caller and a teammate, so `mine=true` and the org
		// scope differ on EVERY page rather than only at the ends.
		const a = Array.from({ length: ORG_A_ROWS }, (_, i) => ({
			orgId: ORG_A,
			userId: i % 2 === 0 ? USER_ME : USER_TEAMMATE,
			offsetUs: i * ROW_SPACING_US,
		}));
		const b = Array.from({ length: ORG_B_ROWS }, (_, i) => ({
			orgId: ORG_B,
			userId: USER_B,
			offsetUs: i * ROW_SPACING_US + ORG_B_PHASE_US,
		}));
		await seedRows([...a, ...b]);
		// READ THE IDS BACK rather than slicing `returning`. Postgres does not promise that
		// `INSERT … SELECT … RETURNING` emits rows in the SELECT's order, and an expectation set
		// from an order the database is free to change is a test that fails for a reason nothing
		// in the diff explains.
		const rows = await getServiceDb()
			.select({ id: jobs.id, user_id: jobs.user_id })
			.from(jobs)
			.where(eq(jobs.org_id, ORG_A));
		orgAIds = rows.map((r) => r.id);
		mineIds = rows.filter((r) => r.user_id === USER_ME).map((r) => r.id);
	});

	afterAll(async () => {
		await getServiceDb().delete(jobs).where(inArray(jobs.org_id, ORG_IDS));
	});

	it("seeded a fixture that can actually see a millisecond-truncation bug", async () => {
		const rows = await getServiceDb().execute(sql`
			select count(distinct date_trunc('milliseconds', created_at)) as ms,
			       count(*) as n
			from jobs where org_id = ${ORG_A}::uuid
		`);
		const [row] = z
			.array(z.object({ ms: z.coerce.number(), n: z.coerce.number() }))
			.parse(rows);
		expect(row.n).toBe(ORG_A_ROWS);
		// Strictly fewer distinct milliseconds than rows ⇒ at least one millisecond holds two
		// rows ⇒ a cursor that truncated to milliseconds would drop one. Without this the walk
		// assertions below would pass against a fixture that cannot express the bug.
		expect(row.ms).toBeLessThan(row.n);
		// And the `mine` half is only interesting if the two sets differ on every page: the org's
		// rows alternate between two users, so `mineIds` is a strict, interleaved subset.
		expect(orgAIds.length).toBe(ORG_A_ROWS);
		expect(mineIds.length).toBeGreaterThan(0);
		expect(mineIds.length).toBeLessThan(orgAIds.length);
	});

	it("lists the ORG's jobs, not just the caller's — the teammate's rows are the fix", async () => {
		actingAs(USER_ME, ORG_A);
		const body = await get("?limit=100");
		expect(body.jobs.map((j) => j.id).sort()).toEqual([...orgAIds].sort());
		// The old route filtered on user_id, so this set was exactly `mineIds`. Naming the
		// teammate's rows explicitly keeps the assertion about the FIX rather than about a count.
		const teammateRows = body.jobs.filter((j) => j.user_id === USER_TEAMMATE);
		expect(teammateRows.length).toBe(ORG_A_ROWS - mineIds.length);
	});

	it("walks the cursors to exhaustion with no gap and no duplicate", async () => {
		actingAs(USER_ME, ORG_A);
		const { ids, pages } = await walk("");
		expect(new Set(ids).size).toBe(ids.length); // no duplicate
		expect([...ids].sort()).toEqual([...orgAIds].sort()); // no gap, and org A only
		// Four pages: three full and a remainder of one. A walk that terminated early would still
		// satisfy "no duplicate", so the page shape is asserted too.
		expect(pages.length).toBe(4);
		expect(pages.slice(0, -1).every((p) => p.next_cursor !== null)).toBe(true);
		expect(pages[pages.length - 1].next_cursor).toBeNull();
	});

	it("does not repeat a row when one is inserted at the head mid-walk", async () => {
		// Its own org, seeded here: this is the one test that mutates the collection it walks.
		const seeded = await seedRows(
			Array.from({ length: ORG_A_ROWS }, (_, i) => ({
				orgId: ORG_C,
				userId: USER_C,
				offsetUs: i * ROW_SPACING_US,
			})),
		);
		actingAs(USER_C, ORG_C);
		const first = await get(`?limit=${PAGE_SIZE}`);
		expect(first.page.next_cursor).not.toBeNull();

		// A job enqueued between two pages sorts ABOVE the cursor. Under offset paging this
		// shifts every remaining row down one and the last row of page 1 comes back on page 2.
		const [headId] = await seedRows([
			{ orgId: ORG_C, userId: USER_C, offsetUs: -5_000 },
		]);

		const seen = new Set(first.jobs.map((j) => j.id));
		let cursor = first.page.next_cursor;
		while (cursor !== null) {
			const next = await get(
				`?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`,
			);
			for (const j of next.jobs) {
				expect(seen.has(j.id)).toBe(false);
				seen.add(j.id);
			}
			cursor = next.page.next_cursor;
		}
		// The row inserted above the cursor is simply not in the remaining pages — that is the
		// keyset property, not an accident of ordering. And the walk still saw every row that
		// existed when it started, so nothing was skipped to achieve it.
		expect(seen.has(headId)).toBe(false);
		expect([...seen].sort()).toEqual([...seeded].sort());
	});

	it("counts the caller's org only, and exactly", async () => {
		actingAs(USER_ME, ORG_A);
		const body = await get(`?limit=${PAGE_SIZE}`);
		expect(body.page.total).toBe(ORG_A_ROWS);
		expect(body.page.mode).toBe("exact");
		// The pre-cursor fields are ECHOES of `page`, not a second count.
		expect(body.total).toBe(body.page.total);
		expect(body.limit).toBe(body.page.limit);
		expect(ORG_A_ROWS).toBeLessThan(DEFAULT_COUNT_CAP);
	});

	it("narrows the rows AND the total together under ?mine=true", async () => {
		actingAs(USER_ME, ORG_A);
		const body = await get("?mine=true&limit=100");
		const ids = body.jobs.map((j) => j.id);
		expect([...ids].sort()).toEqual([...mineIds].sort());
		// The count comes from the same predicates as the rows. A `total` still reporting the
		// org's rows here is the console filter standard's named defect.
		expect(body.page.total).toBe(mineIds.length);
		expect(body.page.total).toBeLessThan(ORG_A_ROWS);
	});

	it("pages ?mine=true independently — its cursors never surface a teammate's row", async () => {
		actingAs(USER_ME, ORG_A);
		const { ids } = await walk("?mine=true", 3);
		expect(new Set(ids).size).toBe(ids.length);
		const rows = await getServiceDb()
			.select({ id: jobs.id, user_id: jobs.user_id })
			.from(jobs)
			.where(inArray(jobs.id, ids));
		expect(rows.every((r) => r.user_id === USER_ME)).toBe(true);
	});

	it("refuses another org's cursor rather than answering it", async () => {
		// Mint a real cursor as org B, then present it as org A. This is the whole reason a
		// cursor carries a scope fingerprint: the position inside it is an offset within a
		// tenancy, never a tenancy.
		actingAs(USER_B, ORG_B);
		const asB = await get(`?limit=${2}`);
		expect(asB.page.next_cursor).not.toBeNull();
		const foreign = asB.page.next_cursor ?? "";

		actingAs(USER_ME, ORG_A);
		const refused = await refusal(`?cursor=${encodeURIComponent(foreign)}`);
		expect(refused.status).toBe(400);
		expect(String(refused.error)).toContain("different list or organization");
	});

	it("cannot reach another org's rows even with its cursor's position", async () => {
		// The stronger form of the assertion above: not "the cursor is refused" but "there is no
		// cursor that crosses". Org B's own walk returns org B's rows and nothing of org A's.
		actingAs(USER_B, ORG_B);
		const { ids } = await walk("", 3);
		const rows = await getServiceDb()
			.select({ org_id: jobs.org_id })
			.from(jobs)
			.where(inArray(jobs.id, ids));
		expect(rows.length).toBe(ORG_B_ROWS);
		expect(rows.every((r) => r.org_id === ORG_B)).toBe(true);
	});

	it("still honours the legacy ?offset=, and its pages agree with the cursor walk", async () => {
		// apps/cli/cmd/jobs_table.go:40 walks this endpoint by offset today. An offset the server
		// quietly ignored would page the same rows forever.
		actingAs(USER_ME, ORG_A);
		const { ids: walked } = await walk("");
		const byOffset: string[] = [];
		for (let off = 0; off < walked.length; off += PAGE_SIZE) {
			const body = await get(`?limit=${PAGE_SIZE}&offset=${off}`);
			byOffset.push(...body.jobs.map((j) => j.id));
		}
		expect(byOffset).toEqual(walked);
	});

	it("refuses a cursor and an offset together rather than silently picking one", async () => {
		actingAs(USER_ME, ORG_A);
		const first = await get(`?limit=${PAGE_SIZE}`);
		const cursor = first.page.next_cursor ?? "";
		const refused = await refusal(
			`?limit=${PAGE_SIZE}&offset=5&cursor=${encodeURIComponent(cursor)}`,
		);
		expect(refused.status).toBe(400);
		expect(String(refused.error)).toContain("cannot be combined");
	});

	it("accepts offset=0 alongside a cursor — absent and zero are the same request", async () => {
		// `?offset=0` is what a client that always writes the parameter sends on page 1. Refusing
		// it would break the very walk the previous test protects.
		actingAs(USER_ME, ORG_A);
		const first = await get(`?limit=${PAGE_SIZE}`);
		const cursor = first.page.next_cursor ?? "";
		const body = await get(
			`?limit=${PAGE_SIZE}&offset=0&cursor=${encodeURIComponent(cursor)}`,
		);
		expect(body.jobs.length).toBe(PAGE_SIZE);
		expect(body.jobs.some((j) => first.jobs.some((f) => f.id === j.id))).toBe(false);
	});

	it("filters by status with the same predicates the count uses", async () => {
		actingAs(USER_ME, ORG_A);
		const queued = await get("?status=QUEUED&limit=100");
		expect(queued.jobs.length).toBe(ORG_A_ROWS);
		expect(queued.page.total).toBe(ORG_A_ROWS);
		const running = await get("?status=PROCESSING&limit=100");
		expect(running.jobs.length).toBe(0);
		expect(running.page.total).toBe(0);
		expect(running.page.next_cursor).toBeNull();
	});

	it("refuses the query strings that used to reach Postgres as NaN", async () => {
		actingAs(USER_ME, ORG_A);
		// `parseInt("abc")` is NaN, and the pre-conversion route handed that straight to
		// `.limit()` / `.offset()`. Each of these is now a named 400.
		expect((await refusal("?limit=abc")).status).toBe(400);
		expect((await refusal("?limit=0")).status).toBe(400);
		expect((await refusal("?offset=abc")).status).toBe(400);
		expect((await refusal("?offset=-1")).status).toBe(400);
		expect((await refusal("?cursor=not-a-cursor")).status).toBe(400);
	});

	it("refuses an unrecognised ?mine= spelling instead of reading it as false", async () => {
		actingAs(USER_ME, ORG_A);
		const refused = await refusal("?mine=yes");
		expect(refused.status).toBe(400);
		// The failure this prevents: `?mine=yes` answered with the whole org's jobs is a wrong
		// answer that looks like a right one.
		const bare = await get("?mine&limit=100");
		expect(bare.jobs.every((j) => j.user_id === USER_ME)).toBe(true);
		const off = await get("?mine=false&limit=100");
		expect(off.jobs.some((j) => j.user_id === USER_TEAMMATE)).toBe(true);
	});

	it("returns the guard's own refusal untouched when the PDP denies", async () => {
		vi.mocked(authorizeCli).mockResolvedValue({
			error: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
		});
		const res = await GET(new Request("http://console.test/api/jobs"));
		expect(res.status).toBe(403);
	});
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// The PERSONAL-ORG half of the org list, against the rows PRODUCTION actually writes.
//
// The suite above proves the caller's own org. This one proves the SECOND entry in the list, and
// it exists because a `<team org>`-only WHERE clause was wrong about rows that already exist in
// every deployment:
// `set_org_id_from_project` (programmables.sql:827-841) resolves `org_id` as parent project →
// `app.current_org` GUC → `NEW.user_id`, and two shipped enqueue paths — the `DESTROY_RUNNER`
// branch of POST /api/jobs and POST /api/cli/runners/deploy — insert a PROJECT-LESS job on
// `getServiceDb()`, which sets no GUC. Those rows land under the caller's PERSONAL org, so for a
// member of a Teams org an `org_id = <team>` filter hides the member's own runner jobs while the
// console, reading through the `owner_all` RLS policy, lists them. That is the
// two-surfaces-two-answers defect #3672 closed, reappearing through the back door. Naming the
// personal org as a second ORG recovers exactly those rows without widening the boundary off
// `org_id` — which quoting `owner_all` here did, and leaked across tenants for.
//
// THE FIXTURE LETS THE TRIGGER DO THE STAMPING. `org_id` is omitted from the insert rather than
// written as `user_id` by hand, because "production writes rows shaped like this" is the claim —
// a fixture that stamps the column itself would assert only that the test can type a uuid twice.
// The first test below reads the stamp back and fails if the trigger ever stops behaving this way.
//
// Its tenants are disjoint from the suite above's in BOTH columns (org and user), so neither
// suite's rows are visible to the other's actor under the disjunction and neither depends on
// having run first.
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** The Teams org the member is acting in. */
const ORG_TEAMS = randomUUID();
/** A tenant the actor belongs to in no way at all — the tenancy assertion's decoy. */
const ORG_FOREIGN = randomUUID();
/** The caller: a member of ORG_TEAMS whose runner jobs are stamped with their personal org. */
const USER_MEMBER = randomUUID();
/** Another member of ORG_TEAMS. Their jobs are the org arm, and are what `?mine=true` drops. */
const USER_PEER = randomUUID();
/** Neither in ORG_TEAMS nor the caller. Nothing they own may ever appear. */
const USER_STRANGER = randomUUID();

const seededJobSchema = z.object({
	id: z.uuid(),
	org_id: z.uuid().nullable(),
	user_id: z.uuid(),
});

/**
 * Inserts one job and returns its id.
 *
 * `orgId === null` OMITS the column, which is what makes `set_org_id_from_project` run its
 * fallback chain instead of accepting a supplied value — the shape the two runner-job enqueue
 * paths produce. Everything else is the minimum the table requires.
 */
async function seedJob(userId: string, orgId: string | null): Promise<string> {
	const [row] = await getServiceDb()
		.insert(jobs)
		.values({
			user_id: userId,
			...(orgId === null ? {} : { org_id: orgId }),
			project_id: null,
			job_type: "PLAN",
			status: "QUEUED",
			config_snapshot: {},
		})
		.returning({ id: jobs.id });
	return row.id;
}

/** Reads a seeded row back, so an assertion can be made about what the DATABASE stored. */
async function readJob(id: string) {
	const [row] = await getServiceDb()
		.select({ id: jobs.id, org_id: jobs.org_id, user_id: jobs.user_id })
		.from(jobs)
		.where(eq(jobs.id, id));
	return seededJobSchema.parse(row);
}

describeIfDb("GET /api/jobs — the org list, incl. the personal-org stamp and the cross-org leak", () => {
	/** Project-less, trigger-stamped `org_id = USER_MEMBER`. The row an org-only filter hid. */
	let personalId = "";
	/** An ordinary org-stamped job of the caller's. */
	let teamMineId = "";
	/** An org-stamped job of a TEAMMATE's — the org arm, and what `?mine=true` must drop. */
	let teamPeerId = "";
	/** Another tenant's job. Must never appear. */
	let foreignId = "";
	/**
	 * A STRANGER's personal-org job: `org_id = user_id`, exactly like `personalId`.
	 *
	 * Without it, "org_id equals user_id" would be a predicate that passes this suite, and it is
	 * not the rule — the rule names the CALLER. This row is the difference between the two.
	 */
	let strangerPersonalId = "";
	/**
	 * THE CALLER'S OWN JOB, IN A THIRD ORG. The row that made the first cut of this route a
	 * cross-tenant leak, and that nothing else in this file could see.
	 *
	 * Every other fixture varies the OWNER while holding the org, so an unbounded owner arm
	 * (`org_id = <caller's org> OR user_id = <caller>`) passed all of them: the caller's rows were
	 * only ever in the caller's org or in their personal one, whose id IS their user id. This row
	 * is in NEITHER, and it is the one a service token leaks — `actor.userId` is the person who
	 * MINTED the token, so a credential pinned to one client's org returned that consultant's jobs
	 * from another client's.
	 */
	let memberInForeignOrgId = "";
	let allIds: string[] = [];

	beforeAll(async () => {
		personalId = await seedJob(USER_MEMBER, null);
		teamMineId = await seedJob(USER_MEMBER, ORG_TEAMS);
		teamPeerId = await seedJob(USER_PEER, ORG_TEAMS);
		foreignId = await seedJob(USER_STRANGER, ORG_FOREIGN);
		strangerPersonalId = await seedJob(USER_STRANGER, null);
		memberInForeignOrgId = await seedJob(USER_MEMBER, ORG_FOREIGN);
		allIds = [personalId, teamMineId, teamPeerId, foreignId, strangerPersonalId, memberInForeignOrgId];
	});

	afterAll(async () => {
		await getServiceDb().delete(jobs).where(inArray(jobs.id, allIds));
	});

	it("the trigger stamps a project-less job with the caller's PERSONAL org, not their team's", async () => {
		// The premise of everything below. If this ever stops being true the remaining tests would
		// still pass — the row would simply be reachable by the org arm instead — so the data
		// defect is asserted directly rather than inferred from a list.
		const personal = await readJob(personalId);
		expect(personal.org_id).toBe(USER_MEMBER);
		expect(personal.org_id).not.toBe(ORG_TEAMS);
		// And the control: supplying org_id explicitly is NOT overwritten by the fallback, so the
		// two fixtures above genuinely differ in the column under test.
		expect((await readJob(teamMineId)).org_id).toBe(ORG_TEAMS);
	});

	it("lists the personal-org job an `org_id = <team>` filter hid, alongside the org's own", async () => {
		actingAs(USER_MEMBER, ORG_TEAMS);
		const body = await get("?limit=100");
		const ids = body.jobs.map((j) => j.id).sort();
		// EXACTLY these three. `toContain` would pass for a route that returned every job in the
		// table, which is the failure mode a widened predicate risks.
		expect(ids).toEqual([personalId, teamMineId, teamPeerId].sort());
		// `total` comes off the same tuple as the rows, so it may not disagree with them.
		expect(body.page.total).toBe(3);
		expect(body.total).toBe(body.page.total);
	});

	it("keeps that job under ?mine=true — the personal org is INSIDE the org scope, so the AND is free", async () => {
		actingAs(USER_MEMBER, ORG_TEAMS);
		const body = await get("?mine=true&limit=100");
		const ids = body.jobs.map((j) => j.id).sort();
		// `?mine=true` ANDs onto the org scope rather than replacing it, and this row is the
		// reason that costs nothing: `personalId` is stamped `org_id = USER_MEMBER`, and the
		// caller's user id is the second element of the org list, so the personal-org job is
		// INSIDE the scope. The earlier worry — that ANDing the org back on would drop the one job
		// `?mine` most obviously means — was about `org_id = ORG_TEAMS` alone, which this is not.
		//
		// Replacing the scope with `user_id = <caller>` is what the leak looked like from the flag
		// side: it returned this caller's jobs from every org they belong to.
		expect(ids).toEqual([personalId, teamMineId].sort());
		expect(body.page.total).toBe(2);
		expect(body.total).toBe(body.page.total);
	});

	it("shows a teammate's org job by default and drops it under ?mine=true", async () => {
		actingAs(USER_MEMBER, ORG_TEAMS);
		const all = await get("?limit=100");
		expect(all.jobs.map((j) => j.id)).toContain(teamPeerId);
		const mine = await get("?mine=true&limit=100");
		expect(mine.jobs.map((j) => j.id)).not.toContain(teamPeerId);
		// The two modes differ by exactly that row, so `?mine` is doing something and the default
		// is not silently already narrowed.
		expect(all.page.total - mine.page.total).toBe(1);
	});

	it("never returns a job in neither the caller's org nor the caller's name — in either mode", async () => {
		// THE TENANCY ASSERTION. The service role bypasses RLS, so this WHERE clause is the only
		// thing standing between two tenants. The companion assertion below — the caller's own row
		// in a third org — is the one that catches a boundary widened off `org_id`; this one
		// catches a boundary that never narrowed to the caller at all.
		actingAs(USER_MEMBER, ORG_TEAMS);
		for (const q of ["?limit=100", "?mine=true&limit=100"]) {
			const ids = (await get(q)).jobs.map((j) => j.id);
			expect(ids).not.toContain(foreignId);
			// The stranger's PERSONAL-org row: `org_id = user_id` holds for it exactly as it does
			// for `personalId`, and it still must not appear. A route that had reached for "the
			// row's own owner" rather than "the caller" would return it.
			expect(ids).not.toContain(strangerPersonalId);
		}
	});

	it("is symmetric — the other tenant sees their org and their personal rows, and nothing else", async () => {
		// The inverse of the assertion above, so "absent" cannot be an artefact of the fixture
		// never being reachable at all.
		//
		// THREE rows, not two: `memberInForeignOrgId` is stamped ORG_FOREIGN, and this caller is
		// scoped to ORG_FOREIGN, so the ORG arm returns it — a teammate's job, exactly like
		// `teamPeerId` is for the other tenant. That is the point of the pair: the same row is
		// visible here and invisible to the person who OWNS it while they are scoped elsewhere,
		// which is what makes the boundary the org rather than the owner.
		actingAs(USER_STRANGER, ORG_FOREIGN);
		const body = await get("?limit=100");
		expect(body.jobs.map((j) => j.id).sort()).toEqual(
			[foreignId, strangerPersonalId, memberInForeignOrgId].sort(),
		);
		expect(body.page.total).toBe(3);
		// ...and `?mine=true` drops it again, because it is not this caller's.
		const mine = await get("?mine=true&limit=100");
		expect(mine.jobs.map((j) => j.id).sort()).toEqual([foreignId, strangerPersonalId].sort());
	});

	it("NEVER returns the caller's own job from a third org — in either mode", async () => {
		// THE LEAK THIS PREDICATE WAS NARROWED FOR. `org_id = <caller's org> OR user_id = <caller>`
		// answers this row on the second arm, which is unbounded by org. It is not a hypothetical
		// shape: `authorizeCli` builds a service token's actor as
		// `getActiveScope(mintingUserId, pinnedOrg)`, so `actor.userId` is a HUMAN who may belong
		// to many orgs, and the route reads through `getServiceDb()` with RLS bypassed.
		//
		// Asserted in BOTH modes because `?mine=true` is the arm that most obviously means "me",
		// and "me" is exactly the wrong boundary here — it is "me, in the org I am scoped to".
		actingAs(USER_MEMBER, ORG_TEAMS);
		for (const q of ["?limit=100", "?mine=true&limit=100"]) {
			const ids = (await get(q)).jobs.map((j) => j.id);
			expect(ids).not.toContain(memberInForeignOrgId);
		}
	});

	it("and that row IS reachable when the caller is scoped to that org — so its absence means scoping", async () => {
		// The control for the assertion above. Without it, "not returned" would also be satisfied
		// by a fixture that was never visible to anyone — and a tenancy test whose negative case
		// is unreachable proves nothing at all.
		actingAs(USER_MEMBER, ORG_FOREIGN);
		const ids = (await get("?limit=100")).jobs.map((j) => j.id);
		expect(ids).toContain(memberInForeignOrgId);
	});

	it("pages the disjunction, and every page stays inside it", async () => {
		// A cursor is a new way to address rows, so it is a new way to address someone else's —
		// and the keyset predicate is ANDed onto a scope that is now itself a disjunction. Without
		// the parentheses the route writes, `a OR b AND keyset` binds as `a OR (b AND keyset)` and
		// page two would hand back the whole org again.
		actingAs(USER_MEMBER, ORG_TEAMS);
		const { ids } = await walk("", 1);
		expect(new Set(ids).size).toBe(ids.length);
		expect([...ids].sort()).toEqual([personalId, teamMineId, teamPeerId].sort());
	});
});
