// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Members list's server half. This surface is a UNION of two tables rendered as one list —
// `member` rows and PENDING `invitation` rows — and most of what can go wrong lives in the
// seams between them:
//
//   * a "pending"-only selection must not pay for the member query, and a team filter must
//     exclude every invitation by construction (an invitation is in no team);
//   * an invitation with a NULL role becomes `viewer` on accept, so the viewer facet has to
//     count it and the viewer filter has to select it;
//   * a personal workspace has no `member` rows at all, and must show its sole owner rather
//     than an empty table — a synthesized row the query is applied to in memory.
//
// The builder's await order — members, invitations, facet members, facet invitations, facet
// teams, then optionally the synthesized owner and the two follow-up reads — is NOT fixed. A
// branch that skips a read puts a literal `[]` into the `Promise.all` array instead of a
// query, so it consumes no result set and every later read shifts up one. Each test therefore
// states the order it is seeding, and says which branch changed it.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockChainDb } from "./_list-query-db";

vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	return {
		...actual,
		ilike: vi.fn(actual.ilike),
		inArray: vi.fn(actual.inArray),
		isNull: vi.fn(actual.isNull),
		exists: vi.fn(actual.exists),
	};
});

const { getServiceDb } = vi.hoisted(() => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb }));

import { exists, ilike, inArray, isNull } from "drizzle-orm";
import { MEMBER_ROW_STATUSES, queryMembersPage } from "@/lib/queries/members";

const JOINED = new Date("2026-01-05T09:00:00.000Z");
const INVITED = new Date("2026-08-20T09:00:00.000Z");

function memberRow(over: Record<string, unknown> = {}) {
	return {
		id: "m1",
		userId: "u1",
		name: "Ada Lovelace",
		username: "ada",
		email: "ada@x.io",
		image: null,
		role: "admin",
		status: "active",
		joinedAt: JOINED,
		...over,
	};
}

function inviteRow(over: Record<string, unknown> = {}) {
	return {
		id: "i1",
		email: "grace@x.io",
		role: "member",
		inviterName: "Ada Lovelace",
		inviterEmail: "ada@x.io",
		createdAt: INVITED,
		...over,
	};
}

/**
 * Seeds result sets in AWAIT order — and the caller states that order, because it is not
 * fixed. `wantsMembers` / `wantsInvitations` false put a LITERAL `[]` in the `Promise.all`
 * array rather than a query, so that read takes no slot and everything behind it shifts up.
 * A helper that pretended the order was constant would silently hand the facet pass the
 * member seed, and the test would still pass. Anything past the end resolves to `[]`.
 */
function seed(...sets: unknown[][]) {
	const { db, chains } = mockChainDb(sets);
	getServiceDb.mockReturnValue(db);
	return chains;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("queryMembersPage", () => {
	it("returns members and pending invitations as one answer", async () => {
		// members, invitations, facet(members), facet(invitations), facet(teams),
		// then the two follow-up reads for the matched users.
		seed(
			[memberRow()],
			[inviteRow()],
			[
				{ role: "admin", status: "active" },
				{ role: "viewer", status: "suspended" },
			],
			[{ role: "member" }],
			[{ name: "Platform" }, { name: "Platform" }, { name: "Ops" }],
			[{ userId: "u1", name: "Platform" }],
			[{ userId: "u1", last: "2026-08-25T08:00:00.000Z" }],
		);

		const page = await queryMembersPage("org-1", "viewer-1");

		expect(page.members).toEqual([
			{
				...memberRow(),
				joinedAt: "2026-01-05T09:00:00.000Z",
				teams: ["Platform"],
				lastActiveAt: "2026-08-25T08:00:00.000Z",
			},
		]);
		expect(page.invitations).toEqual([
			{
				id: "i1",
				email: "grace@x.io",
				// STORED as better-auth's own `member` (what an invite sent with the plugin's
				// default carries), READ as the role it grants: viewer. The table renders one role
				// column for both kinds and its <select> only offers our four.
				role: "viewer",
				inviterName: "Ada Lovelace",
				createdAt: "2026-08-20T09:00:00.000Z",
			},
		]);
		expect(page.resultCount).toBe(2);
		// 2 members + 1 invitation in the UNFILTERED universe.
		expect(page.total).toBe(3);
		expect(page.facets.statuses).toEqual([
			{ value: "active", label: null, count: 1 },
			{ value: "pending", label: null, count: 1 },
			{ value: "suspended", label: null, count: 1 },
		]);
		expect(page.facets.teams).toEqual([
			{ value: "Ops", label: "Ops", count: 1 },
			{ value: "Platform", label: "Platform", count: 2 },
		]);
	});

	it("counts a NULL invitation role as viewer, because that is what accepting it grants", async () => {
		seed([], [], [{ role: "owner", status: "active" }], [{ role: null }, { role: "admin" }]);
		const page = await queryMembersPage("org-1", "viewer-1");
		expect(page.facets.roles).toEqual([
			{ value: "admin", label: null, count: 1 },
			{ value: "owner", label: null, count: 1 },
			{ value: "viewer", label: null, count: 1 },
		]);
	});

	it("reads better-auth's `member` as the viewer it grants — one bucket, not two", async () => {
		// members, invitations, facet(members), facet(invitations), facet(teams), teams, sessions.
		seed(
			[memberRow({ role: "member" })],
			[],
			[
				{ role: "viewer", status: "active" },
				{ role: "member", status: "active" },
			],
			[],
			[],
			[],
			[],
		);
		const page = await queryMembersPage("org-1", "viewer-1");
		// The row's <select> offers owner/admin/operator/viewer; `member` matches no option and
		// renders blank, and a second facet bucket claims the org has a role it cannot filter to.
		expect(page.members[0]?.role).toBe("viewer");
		expect(page.facets.roles).toEqual([
			{ value: "viewer", label: null, count: 2 },
		]);
	});

	it("selects the `member` spelling too when the viewer facet is picked", async () => {
		// The rows are DISPLAYED as viewer, so a viewer selection that matched only the literal
		// string would offer a count of 2 and then return 1 row.
		seed();
		await queryMembersPage("org-1", "viewer-1", { roles: ["viewer"] });
		const roleFilters = vi
			.mocked(inArray)
			.mock.calls.filter(
				([, values]) => Array.isArray(values) && values.includes("viewer"),
			);
		// Both role passes: the member rows and the pending invitations.
		expect(roleFilters).toHaveLength(2);
		for (const [, values] of roleFilters) expect(values).toContain("member");
	});

	it("selects the NULL invitation role when the viewer facet is picked", async () => {
		seed();
		await queryMembersPage("org-1", "viewer-1", { roles: ["viewer"] });
		// `isNull(invitation.role)` is the branch that makes the viewer count selectable.
		expect(isNull).toHaveBeenCalledTimes(1);
	});

	it("does not reach for a NULL role when viewer was not asked for", async () => {
		seed();
		await queryMembersPage("org-1", "viewer-1", { roles: ["admin"] });
		expect(isNull).not.toHaveBeenCalled();
	});

	it("skips the member read for a pending-only selection", async () => {
		// wantsMembers is false, so the member read is a literal [] and takes NO slot: the
		// first seeded set goes to the invitations pass, the second to the member FACET pass.
		// That second one has to be non-empty: an org with no member rows anywhere IS the
		// personal-workspace case, and would issue a fifth read to synthesize its owner.
		const chains = seed([], [{ role: "admin", status: "active" }], [{ role: "member" }]);
		const page = await queryMembersPage("org-1", "viewer-1", { statuses: ["pending"] });
		expect(page.members).toEqual([]);
		// Chains created: invitations + three facet passes. No member rows pass at all —
		// a status the page cannot contain should not cost a round trip.
		expect(chains).toHaveLength(4);
	});

	it("excludes invitations whenever a team filter is present", async () => {
		// An invitation is in no team, so the honest answer is none — and the round trip for
		// them is skipped rather than issued and discarded.
		// wantsInvitations is false here, so the order is members, facet(members), … .
		const chains = seed([], [{ role: "admin", status: "active" }]);
		const page = await queryMembersPage("org-1", "viewer-1", { teams: ["Platform"] });
		expect(page.invitations).toEqual([]);
		// The team filter is an EXISTS subquery, which creates a chain that is never awaited.
		expect(exists).toHaveBeenCalledTimes(1);
		expect(chains.some((c) => !c.awaited)).toBe(true);
	});

	it("hands each facet pass the org predicate and nothing else", async () => {
		const chains = seed(
			[memberRow()],
			[inviteRow()],
			[{ role: "admin", status: "active" }],
			[{ role: "member" }],
			[],
		);

		await queryMembersPage("org-1", "viewer-1", {
			search: "ada",
			roles: ["admin"],
		});

		// Creation order: rows(members), rows(invites), facet(members), facet(invites),
		// facet(teams). The three facet passes carry a single WHERE and no ORDER BY.
		for (const facet of [chains[2], chains[3], chains[4]]) {
			expect(facet.argsOf("where")).toHaveLength(1);
			expect(facet.called("orderBy")).toBe(false);
			expect(facet.called("limit")).toBe(false);
		}
		// The search is composed for the member row pass (name, username, email) and the
		// invitation row pass (invite email, inviter name) — five, none of them a facet pass.
		expect(vi.mocked(ilike).mock.calls).toHaveLength(5);
	});

	it("shows the sole owner of a personal workspace instead of an empty table", async () => {
		// orgId === viewerUserId, so the invitations read is a literal []: members,
		// facet(members), facet(invitations), facet(teams), then the synthesized owner.
		seed([], [], [], [], [
			{
				id: "u-me",
				name: "Ada Lovelace",
				username: "ada",
				email: "ada@x.io",
				image: null,
				createdAt: JOINED,
			},
		]);

		const page = await queryMembersPage("u-me", "u-me");

		expect(page.members).toHaveLength(1);
		expect(page.members[0]).toMatchObject({
			id: "u-me",
			userId: "u-me",
			role: "owner",
			status: "active",
			teams: [],
			joinedAt: "2026-01-05T09:00:00.000Z",
		});
		// The synthesized row IS the universe, so the facets describe it rather than nothing.
		expect(page.total).toBe(1);
		expect(page.facets.roles).toEqual([{ value: "owner", label: null, count: 1 }]);
	});

	it("applies the query to the synthesized owner in memory", async () => {
		const owner = [
			{
				id: "u-me",
				name: "Ada Lovelace",
				username: "ada",
				email: "ada@x.io",
				image: null,
				createdAt: JOINED,
			},
		];
		/** members, facet(members), facet(invitations), facet(teams), owner. */
		const personal = () => seed([], [], [], [], owner);

		personal();
		expect((await queryMembersPage("u-me", "u-me", { search: "ada" })).members).toHaveLength(1);

		personal();
		expect((await queryMembersPage("u-me", "u-me", { search: "grace" })).members).toEqual([]);

		personal();
		expect((await queryMembersPage("u-me", "u-me", { roles: ["viewer"] })).members).toEqual([]);

		personal();
		// The personal owner is in no team, so ANY team selection excludes them. That branch
		// also drops the invitations read, which is why the owner seed moves down one slot.
		seed([], [], [], owner);
		expect((await queryMembersPage("u-me", "u-me", { teams: ["Ops"] })).members).toEqual([]);

		personal();
		expect(
			(await queryMembersPage("u-me", "u-me", { statuses: ["suspended"] })).members,
		).toEqual([]);
	});

	it("returns nothing rather than throwing when the personal owner's user row is gone", async () => {
		seed([], [], [], [], []);
		const page = await queryMembersPage("u-me", "u-me", {});
		expect(page.members).toEqual([]);
		expect(page.resultCount).toBe(0);
	});

	it("treats any status that is not the explicit suspended flag as active", async () => {
		seed([], [], [
			{ role: "admin", status: "active" },
			{ role: "admin", status: "invited-long-ago" },
			{ role: "admin", status: "suspended" },
		]);
		const page = await queryMembersPage("org-1", "viewer-1");
		expect(page.facets.statuses).toEqual([
			{ value: "active", label: null, count: 2 },
			{ value: "pending", label: null, count: 0 },
			{ value: "suspended", label: null, count: 1 },
		]);
	});

	it("falls back to the inviter's email, then an em dash, for an unnamed inviter", async () => {
		seed([], [
			inviteRow({ id: "a", inviterName: null }),
			inviteRow({ id: "b", inviterName: null, inviterEmail: null }),
			inviteRow({ id: "c", role: null }),
		]);
		const page = await queryMembersPage("org-1", "viewer-1");
		expect(page.invitations.map((i) => i.inviterName)).toEqual([
			"ada@x.io",
			"—",
			"Ada Lovelace",
		]);
		expect(page.invitations[2].role).toBe("viewer");
	});

	it("leaves lastActiveAt null for a member with no session row", async () => {
		seed([memberRow()], [], [{ role: "admin", status: "active" }], [], [], [], []);
		const page = await queryMembersPage("org-1", "viewer-1");
		expect(page.members[0].lastActiveAt).toBeNull();
		expect(page.members[0].teams).toEqual([]);
	});

	it("exposes the three row statuses the facet renders", () => {
		expect(MEMBER_ROW_STATUSES).toEqual(["active", "pending", "suspended"]);
	});
});
