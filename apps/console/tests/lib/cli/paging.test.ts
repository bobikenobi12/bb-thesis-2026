// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit half of the CLI paging vocabulary. Everything here is pure: the cursor codec, the
// request parser and the page builder. The properties that need a database — a gap-free walk,
// a tenancy-scoped total, a cross-org cursor, the index the page query plans onto — are in
// tests/integration/cli-paging.test.ts and are NOT restated here as mocks.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { jobs } from "@/lib/db/schema";
import {
	afterCursor,
	buildPage,
	cursorKey,
	type CursorPosition,
	type CursorScope,
	DEFAULT_PAGE_SIZE,
	decodeCursor,
	encodeCursor,
	MAX_PAGE_SIZE,
	pageFetchLimit,
	pageInfoSchema,
	pageOrder,
	parsePageOpts,
} from "@/lib/cli/paging";

const SCOPE: CursorScope = { orgId: "org-a", list: "jobs" };
const OTHER_ORG: CursorScope = { orgId: "org-b", list: "jobs" };
const OTHER_LIST: CursorScope = { orgId: "org-a", list: "clusters" };

/** A key exactly as `cursorKey()` renders it — six fractional digits, and the last three not 0. */
const KEY = "2026-01-02T03:04:05.678901Z";
const POSITION: CursorPosition = {
	createdAt: KEY,
	id: "0f8c3ad0-1b0c-4f8e-9a1a-2b3c4d5e6f70",
};

/** Narrows a decoded envelope to a mutable record without a cast. */
function asMutableRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		throw new Error("expected an object");
	}
	return { ...value };
}

/** Re-encodes an arbitrary envelope so the decoder's rejection paths can be driven directly. */
function rawCursor(envelope: unknown): string {
	return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

describe("cursor codec", () => {
	it("round-trips a position within its own scope", () => {
		const decoded = decodeCursor(SCOPE, encodeCursor(SCOPE, POSITION));
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.position.id).toBe(POSITION.id);
		// Byte for byte, microseconds included. A round trip through `new Date()` would land on
		// ...678Z and silently drop rows on the next page.
		expect(decoded.position.createdAt).toBe(KEY);
	});

	it("is opaque — the position is not readable from the cursor text", () => {
		// Not a secrecy claim (there is nothing secret in a row's timestamp). It is the
		// claim that a client cannot pattern-match a cursor into its parts and start
		// constructing them, which is what would freeze the ordering into the wire contract.
		const cursor = encodeCursor(SCOPE, POSITION);
		expect(cursor).not.toContain(POSITION.id);
		expect(cursor).not.toContain("2026-01-02");
	});

	it("refuses another organization's cursor", () => {
		const decoded = decodeCursor(OTHER_ORG, encodeCursor(SCOPE, POSITION));
		expect(decoded).toEqual({ ok: false, reason: "foreign-scope" });
	});

	it("refuses a cursor minted for another collection in the same org", () => {
		const decoded = decodeCursor(OTHER_LIST, encodeCursor(SCOPE, POSITION));
		expect(decoded).toEqual({ ok: false, reason: "foreign-scope" });
	});

	// Each pair concatenates to one string under the separator named beside it, so a
	// fingerprint that joined org and list with that character would hand one scope's cursor
	// to the other. A uuid contains `-`; a list name could plausibly contain any of the rest.
	// The separator is NUL, which none of the two parts can contain.
	it.each([
		["no separator", { orgId: "a", list: "bc" }, { orgId: "ab", list: "c" }],
		["-", { orgId: "a-b", list: "c" }, { orgId: "a", list: "b-c" }],
		[":", { orgId: "a:b", list: "c" }, { orgId: "a", list: "b:c" }],
		["/", { orgId: "a/b", list: "c" }, { orgId: "a", list: "b/c" }],
		[" ", { orgId: "a b", list: "c" }, { orgId: "a", list: "b c" }],
		["|", { orgId: "a|b", list: "c" }, { orgId: "a", list: "b|c" }],
	])(
		"does not confuse two scopes that a %s separator would join identically",
		(_sep, left: CursorScope, right: CursorScope) => {
			expect(decodeCursor(right, encodeCursor(left, POSITION))).toEqual({
				ok: false,
				reason: "foreign-scope",
			});
			expect(decodeCursor(left, encodeCursor(right, POSITION))).toEqual({
				ok: false,
				reason: "foreign-scope",
			});
		},
	);

	it.each([
		["not base64 at all", "!!!! not a cursor !!!!"],
		["base64 of non-JSON", Buffer.from("hello", "utf8").toString("base64url")],
		["an empty string", ""],
	])("rejects %s as malformed", (_label, raw) => {
		expect(decodeCursor(SCOPE, raw)).toEqual({
			ok: false,
			reason: "malformed",
		});
	});

	it("rejects an envelope from a future cursor version", () => {
		const raw = rawCursor({ v: 2, s: "whatever", t: KEY, i: POSITION.id });
		expect(decodeCursor(SCOPE, raw)).toEqual({
			ok: false,
			reason: "malformed",
		});
	});

	it("rejects an id that is not a uuid", () => {
		// The id is interpolated into a `::uuid` comparison. A non-uuid reaching that point
		// is a 500 from Postgres on a caller-supplied value, not a 400.
		const raw = rawCursor({
			v: 1,
			s: "whatever",
			t: KEY,
			i: "'; drop table jobs; --",
		});
		expect(decodeCursor(SCOPE, raw)).toEqual({
			ok: false,
			reason: "malformed",
		});
	});

	// The key is handed straight back to Postgres as a `::timestamptz`, so a well-shaped
	// impossibility that reaches the query is a 500 on caller-supplied input, not a 400. Two of
	// these are the reason the validator round-trips the date instead of trusting `Date.parse`:
	// measured on Node 24, `Date.parse` accepts BOTH "2026-02-30" (rolling to March 2) and an
	// hour of 24 (rolling to the next day).
	it.each([
		["three fractional digits, not six", "2026-01-02T03:04:05.678Z"],
		["no fractional digits", "2026-01-02T03:04:05Z"],
		["nine fractional digits", "2026-01-02T03:04:05.678901234Z"],
		["an offset instead of Z", "2026-01-02T03:04:05.678901+02:00"],
		["a space instead of T", "2026-01-02 03:04:05.678901Z"],
		["month 13", "2026-13-02T03:04:05.678901Z"],
		["February 30th", "2026-02-30T03:04:05.678901Z"],
		["hour 24", "2026-01-02T24:04:05.678901Z"],
		["second 60", "2026-01-02T03:04:60.678901Z"],
		["not a date at all", "garbage"],
	])("rejects a cursor whose key has %s", (_label, key) => {
		// With the CORRECT fingerprint, so the rejection is the key's and not the scope check
		// firing first.
		const real = encodeCursor(SCOPE, POSITION);
		const envelope = asMutableRecord(
			JSON.parse(Buffer.from(real, "base64url").toString("utf8")),
		);
		envelope.t = key;
		expect(decodeCursor(SCOPE, rawCursor(envelope))).toEqual({
			ok: false,
			reason: "malformed",
		});
	});

	it("refuses to MINT a cursor from a lossy key or a non-uuid id", () => {
		// Both are server bugs, and both land at the mint site — page 1, in the author's own
		// test — rather than as a 400 the caller's next request cannot get past. The first is
		// what a route that selected `created_at` instead of `cursorKey(created_at)` produces.
		expect(() =>
			encodeCursor(SCOPE, { createdAt: "2026-01-02T03:04:05.678Z", id: POSITION.id }),
		).toThrow(/cursorKey/);
		expect(() =>
			encodeCursor(SCOPE, { createdAt: KEY, id: "gh-app-123" }),
		).toThrow(/uuids/);
	});

});

describe("parsePageOpts", () => {
	it("defaults to the module's page size and the first page", () => {
		const parsed = parsePageOpts(new URLSearchParams(), SCOPE);
		expect(parsed).toEqual({
			ok: true,
			opts: { limit: DEFAULT_PAGE_SIZE, after: null },
		});
	});

	it("honours an explicit limit", () => {
		const parsed = parsePageOpts(new URLSearchParams({ limit: "7" }), SCOPE);
		expect(parsed.ok && parsed.opts.limit).toBe(7);
	});

	it("clamps a limit above the ceiling instead of refusing it", () => {
		const parsed = parsePageOpts(
			new URLSearchParams({ limit: String(MAX_PAGE_SIZE + 1) }),
			SCOPE,
		);
		// Clamped, and `page.limit` is what tells the caller so — refusing would break a
		// client that asked for "everything" and had no way to learn the ceiling.
		expect(parsed.ok && parsed.opts.limit).toBe(MAX_PAGE_SIZE);
	});

	it.each(["0", "abc", "-1", "1.5", "1e3", " 5"])(
		"refuses limit=%s",
		(limit) => {
			const parsed = parsePageOpts(new URLSearchParams({ limit }), SCOPE);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.error).toMatch(/positive integer/);
		},
	);

	it("treats an empty cursor as the first page, not as a malformed one", () => {
		// `?cursor=` is what a client that builds its query string from an empty variable
		// sends. Refusing it would fail the FIRST call of every walk.
		const parsed = parsePageOpts(new URLSearchParams({ cursor: "" }), SCOPE);
		expect(parsed).toEqual({
			ok: true,
			opts: { limit: DEFAULT_PAGE_SIZE, after: null },
		});
	});

	it("carries a valid cursor through as a position", () => {
		const parsed = parsePageOpts(
			new URLSearchParams({ cursor: encodeCursor(SCOPE, POSITION) }),
			SCOPE,
		);
		expect(parsed.ok && parsed.opts.after?.id).toBe(POSITION.id);
	});

	it("distinguishes a foreign cursor from a malformed one in the message", () => {
		const foreign = parsePageOpts(
			new URLSearchParams({ cursor: encodeCursor(OTHER_ORG, POSITION) }),
			SCOPE,
		);
		expect(foreign.ok).toBe(false);
		if (!foreign.ok) {
			expect(foreign.error).toMatch(/different list or organization/);
		}

		const broken = parsePageOpts(
			new URLSearchParams({ cursor: "not-a-cursor!!" }),
			SCOPE,
		);
		expect(broken.ok).toBe(false);
		if (!broken.ok) expect(broken.error).toBe("cursor is malformed");
	});

	it("does not silently drop a bad cursor and restart the walk", () => {
		// The failure this rules out: a decoder that answers "no cursor" for an unusable one
		// serves page 1 again, and a caller walking to exhaustion loops forever over the
		// first N rows while every page looks perfectly valid.
		const parsed = parsePageOpts(
			new URLSearchParams({ cursor: "garbage" }),
			SCOPE,
		);
		expect(parsed.ok).toBe(false);
	});
});

describe("buildPage", () => {
	const rows = Array.from({ length: 4 }, (_, i) => ({
		id: `0f8c3ad0-1b0c-4f8e-9a1a-2b3c4d5e6f7${i}`,
		cursor_key: `2026-01-1${9 - i}T00:00:00.000137Z`,
	}));
	const positionOf = (row: (typeof rows)[number]): CursorPosition => ({
		createdAt: row.cursor_key,
		id: row.id,
	});
	const opts = { limit: 3, after: null };
	const counted = { total: 4, mode: "exact" as const };

	it("trims the probe row and mints a cursor at the last KEPT row", () => {
		const { items, page } = buildPage({
			rows,
			opts,
			scope: SCOPE,
			count: counted,
			positionOf,
		});
		expect(items).toHaveLength(3);
		expect(items.map((r) => r.id)).toEqual(rows.slice(0, 3).map((r) => r.id));
		// At rows[2], not rows[3]: a cursor taken from the discarded probe row would skip
		// rows[2] entirely on the next page, and the walk would be short by one per page.
		expect(page.next_cursor).toBe(encodeCursor(SCOPE, positionOf(rows[2])));
	});

	it("reports exhaustion when the probe row is absent", () => {
		const { items, page } = buildPage({
			rows: rows.slice(0, 3),
			opts,
			scope: SCOPE,
			count: counted,
			positionOf,
		});
		expect(items).toHaveLength(3);
		expect(page.next_cursor).toBeNull();
	});

	it("reports exhaustion on an empty page without minting a cursor", () => {
		const { items, page } = buildPage({
			rows: [],
			opts,
			scope: SCOPE,
			count: { total: 0, mode: "exact" },
			positionOf,
		});
		expect(items).toEqual([]);
		expect(page).toEqual({
			mode: "exact",
			limit: 3,
			total: 0,
			next_cursor: null,
		});
	});

	it("throws when handed more rows than pageFetchLimit allows", () => {
		// A query that used a different limit from the one in `opts` would mint a cursor
		// past rows the caller never returned — a hole in the walk that nothing else here
		// can see.
		expect(() =>
			buildPage({
				rows: [...rows, ...rows],
				opts,
				scope: SCOPE,
				count: counted,
				positionOf,
			}),
		).toThrow(/pageFetchLimit/);
	});

	it("throws on a page size below one", () => {
		// parsePageOpts refuses limit=0, but PageOpts is a plain interface. A hand-built one
		// would otherwise produce an empty page with a null cursor — a walk that terminates
		// immediately and reports the collection as empty.
		expect(() =>
			buildPage({
				rows,
				opts: { limit: 0, after: null },
				scope: SCOPE,
				count: counted,
				positionOf,
			}),
		).toThrow(/at least 1/);
	});

	it("emits a page object the wire contract accepts", () => {
		const { page } = buildPage({
			rows,
			opts,
			scope: SCOPE,
			count: counted,
			positionOf,
		});
		expect(pageInfoSchema.parse(page)).toEqual(page);
	});

	it("carries the count mode through untouched", () => {
		const { page } = buildPage({
			rows,
			opts,
			scope: SCOPE,
			count: { total: 1000, mode: "capped" },
			positionOf,
		});
		expect(page.mode).toBe("capped");
		expect(page.total).toBe(1000);
	});
});

describe("pageFetchLimit", () => {
	it("is one more than the page size", () => {
		expect(pageFetchLimit({ limit: 1, after: null })).toBe(2);
		expect(pageFetchLimit({ limit: MAX_PAGE_SIZE, after: null })).toBe(
			MAX_PAGE_SIZE + 1,
		);
	});
});

describe("the SQL the page query is built from", () => {
	// drizzle's QueryBuilder renders the dialect without a connection, so these assert the
	// EMITTED SQL rather than a mocked call. What the SQL then does across page boundaries and
	// which index answers it are proved in tests/integration/cli-paging.test.ts — this is the
	// fast guard on the two clauses whose exact text is load-bearing.
	const render = (position: Parameters<typeof afterCursor>[0]) =>
		new QueryBuilder()
			.select({ id: jobs.id })
			.from(jobs)
			.where(
				and(
					eq(jobs.org_id, "11111111-1111-4111-8111-111111111111"),
					afterCursor(position, jobs.created_at, jobs.id),
				),
			)
			.orderBy(...pageOrder(jobs.created_at, jobs.id))
			.limit(6)
			.toSQL().sql;

	it("orders with NULLS LAST, which is what the index carries", () => {
		// NOT decoration. Postgres defaults ORDER BY ... DESC to NULLS FIRST while
		// `CREATE INDEX ... DESC` — the form idx_jobs_org_cursor is in — is DESC NULLS LAST,
		// and the planner does not treat them as interchangeable. Drop the NULLS LAST and the
		// query plans a scan plus a Sort on exactly the same schema.
		const sql = render(null);
		expect(sql).toContain('"jobs"."created_at" desc nulls last');
		expect(sql).toContain('"jobs"."id" desc nulls last');
	});

	it("compares the cursor as a ROW, with both sides cast", () => {
		const sql = render(POSITION);
		// A row comparison, not `created_at < x OR (created_at = x AND id < y)` — the row form
		// is what a composite index serves as one range scan.
		expect(sql).toContain('("jobs"."created_at", "jobs"."id") < (');
		// The casts are what make the bound parameters resolvable against a timestamptz and a
		// uuid column; without them the bind fails, not the comparison.
		expect(sql).toContain("::timestamptz");
		expect(sql).toContain("::uuid");
	});

	it("projects the ordering key with all six fractional digits, at UTC", () => {
		const rendered = new QueryBuilder()
			.select({ k: cursorKey(jobs.created_at) })
			.from(jobs)
			.toSQL().sql;
		// `US` is microseconds. Three digits (`MS`) is the precision a JS Date has and the
		// precision that silently drops rows; `at time zone 'UTC'` is what makes the rendering
		// independent of the session TimeZone, so a cursor minted on one connection is still
		// comparable on the next.
		expect(rendered).toContain("at time zone 'UTC'");
		expect(rendered).toContain('YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
	});

	it("emits no keyset predicate on the first page", () => {
		// `afterCursor(null, …)` returns undefined so it drops out of the `and(...)` rather
		// than becoming a tautology the planner has to carry.
		expect(render(null)).not.toContain("<");
	});
});

describe("the Go mirror's fixture", () => {
	const fixturePath = join(
		dirname(fileURLToPath(import.meta.url)),
		"../../../../../packages/core/api/testdata/page_info.json",
	);

	it("carries exactly the fields the schema defines", () => {
		const parsed: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
		const fixture = asMutableRecord(parsed);
		// Not a value check — the generator samples every integer as 0, which is why the
		// Go side asserts structure. This is the key set, which is the thing that drifts:
		// a field added here and not regenerated leaves packages/core/api/paging.go
		// silently zero-filling it.
		expect(Object.keys(fixture).sort()).toEqual(
			Object.keys(pageInfoSchema.shape).sort(),
		);
		expect(Object.keys(fixture)).toContain("next_cursor");
	});
});
