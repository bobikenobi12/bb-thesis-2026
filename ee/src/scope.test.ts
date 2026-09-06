// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The enterprise scope resolver (./scope). The stub below is deliberately built so that the
// PRE-#3863 resolver would answer TEAM to the first case here: the membership probe misses and
// the primary-membership query has a row. That is what makes the assertion capable of failing —
// a stub with no rows at all would pass against the old code and the new one alike.

import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { resolveActiveScope, type ScopeQueryRunner } from "./scope";

const USER = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

/**
 * Every string literal inside a built `SQL`, joined — enough to tell the membership probe from
 * the earliest-membership query without asserting on drizzle's chunk shape. Walked rather than
 * JSON-stringified: a built query holds parameter objects with circular references.
 */
function queryText(query: SQL): string {
	const seen = new Set<object>();
	const parts: string[] = [];
	const walk = (node: unknown): void => {
		if (typeof node === "string") {
			parts.push(node);
			return;
		}
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		if (typeof node === "object" && node !== null && !seen.has(node)) {
			seen.add(node);
			const values: unknown[] = Object.values(node);
			for (const value of values) walk(value);
		}
	};
	walk(query);
	return parts.join(" ").replace(/\s+/g, " ");
}

/**
 * A runner answering the membership probe with `member` and the earliest-membership query with
 * `primary`, recording the text of every query it was handed.
 */
function runner(opts: { member: boolean; primary: string | null }): {
	db: ScopeQueryRunner;
	queries: string[];
} {
	const queries: string[] = [];
	const db: ScopeQueryRunner = {
		execute: async (query: SQL): Promise<unknown[]> => {
			const text = queryText(query);
			queries.push(text);
			if (text.includes("order by")) {
				return opts.primary === null ? [] : [{ organization_id: opts.primary }];
			}
			return opts.member ? [{ id: TEAM }] : [];
		},
	};
	return { db, queries };
}

describe("resolveActiveScope", () => {
	// The stub itself has to be able to tell the two queries apart, or every assertion below
	// that counts on it is measuring nothing. Pinned rather than assumed.
	it("(control) the two queries this resolver issues are distinguishable", async () => {
		const { db, queries } = runner({ member: false, primary: TEAM });

		await resolveActiveScope(db, USER, OTHER);

		expect(queries).toHaveLength(2);
		expect(queries[0]).toContain("organization_id as id");
		expect(queries[0]).not.toContain("order by");
		expect(queries[1]).toContain("order by");
	});

	// THE #3863 CASE. A personal org's id IS the user's id and it has no `member` row, so the
	// membership probe cannot find it. Before this branch existed the miss fell through to the
	// earliest-membership query, and the caller who named their personal org was handed TEAM.
	it("resolves a named PERSONAL org to the personal scope, and asks the database nothing", async () => {
		const { db, queries } = runner({ member: false, primary: TEAM });

		const actor = await resolveActiveScope(db, USER, USER);

		// The literal, not `actor.userId`: comparing the answer to a value derived from the
		// same call would hold whatever the resolver did.
		expect(actor.orgId).toBe(USER);
		expect(actor.orgId).not.toBe(TEAM);
		// The condition genuinely changed — the old path issued two queries to get this wrong.
		expect(queries).toEqual([]);
	});

	it("resolves a named team org the caller holds a member row in", async () => {
		const { db, queries } = runner({ member: true, primary: OTHER });

		const actor = await resolveActiveScope(db, USER, TEAM);

		expect(actor).toEqual({ userId: USER, orgId: TEAM });
		// Only the membership probe ran, so OTHER could not have been substituted by accident.
		expect(queries).toHaveLength(1);
		expect(queries[0]).not.toContain("order by");
	});

	// The fallback for a named org STAYS here, and is refused by the caller that reads the
	// header (apps/console/lib/authz/guard.ts → resolveNamedOrgScope). This resolver also
	// serves the console session, where the org is a stored preference that can go stale.
	it("falls back to the primary membership for a named org with no member row", async () => {
		const { db } = runner({ member: false, primary: TEAM });

		const actor = await resolveActiveScope(db, USER, OTHER);

		expect(actor.orgId).toBe(TEAM);
	});

	it("resolves the primary (earliest) membership when nothing is named", async () => {
		const { db, queries } = runner({ member: false, primary: TEAM });

		const actor = await resolveActiveScope(db, USER, undefined);

		expect(actor).toEqual({ userId: USER, orgId: TEAM });
		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("order by");
	});

	it("falls back to the personal org when the caller belongs to no org at all", async () => {
		const { db } = runner({ member: false, primary: null });

		const actor = await resolveActiveScope(db, USER, undefined);

		expect(actor).toEqual({ userId: USER, orgId: USER });
	});

	// AN ERROR IS NOT AN ABSENCE. "No member row" and "the lookup failed" must not render the
	// same way — reporting a database outage as a missing membership is one blip away from a
	// silent wrong scope, which is the defect this file exists to close.
	it("propagates a membership-probe failure instead of reporting it as a missing membership", async () => {
		const boom = new Error("connection terminated");
		const db: ScopeQueryRunner = { execute: vi.fn().mockRejectedValue(boom) };

		await expect(resolveActiveScope(db, USER, OTHER)).rejects.toBe(boom);
	});

	it("propagates a failure of the primary-membership query too", async () => {
		const boom = new Error("connection terminated");
		const db: ScopeQueryRunner = { execute: vi.fn().mockRejectedValue(boom) };

		await expect(resolveActiveScope(db, USER, undefined)).rejects.toBe(boom);
	});

	// A row that came back in a shape this module cannot read is not "no membership" either.
	it("throws on a row it cannot read rather than treating it as no membership", async () => {
		const db: ScopeQueryRunner = { execute: async (): Promise<unknown[]> => [{ nope: 1 }] };

		await expect(resolveActiveScope(db, USER, undefined)).rejects.toThrow(
			/no string "organization_id"/,
		);
	});
});
