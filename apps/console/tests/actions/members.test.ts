// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the members actions: stub the actor/authorize guards, the PDP grant
// helpers, and a queue-backed thenable drizzle chain (each `await db…` resolves to the next seeded
// result set). Asserts the synthetic personal-owner fallback, team/last-active joining, the
// invitation mapping + personal-scope short-circuit, and every branch of setMemberSuspended.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	currentActor: vi.fn(),
}));
vi.mock("@/lib/authz/grants", () => ({
	ensureMemberGrant: vi.fn(),
	revokeMemberGrant: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import {
	getInvitations,
	getMembers,
	setMemberSuspended,
} from "@/app/server/actions/members";
import { ensureMemberGrant, revokeMemberGrant } from "@/lib/authz/grants";
import { authorize, currentActor } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";

/**
 * A drizzle-ish chain whose builders all return the chain and whose every awaited terminal
 * shifts the next seeded result set off `resultSets` (so multiple sequential queries in one
 * action each get their own rows). Records `.update().set()` writes via `setSpy`.
 */
function mockDb(resultSets: unknown[][]) {
	const queue = [...resultSets];
	const setSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		innerJoin: () => db,
		leftJoin: () => db,
		where: () => db,
		limit: () => db,
		groupBy: () => db,
		update: () => db,
		set: (...a: unknown[]) => {
			setSpy(...a);
			return db;
		},
		then: (resolve: (v: unknown) => void) =>
			resolve(queue.length ? (queue.shift() ?? []) : []),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { setSpy };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentActor).mockResolvedValue({
		orgId: "org-1",
		userId: "user-1",
	} as never);
	vi.mocked(authorize).mockResolvedValue({
		orgId: "org-1",
		userId: "user-1",
	} as never);
});

describe("getMembers", () => {
	it("synthesizes the sole personal owner when the org has no member rows", async () => {
		const created = new Date("2026-01-02T03:04:05.000Z");
		mockDb([
			[], // members ⋈ user → none (personal workspace)
			[
				{
					id: "user-1",
					name: "Ada",
					email: "ada@example.com",
					image: null,
					createdAt: created,
				},
			], // the user lookup
		]);

		const rows = await getMembers();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "user-1",
			userId: "user-1",
			name: "Ada",
			email: "ada@example.com",
			role: "owner",
			status: "active",
			teams: [],
			joinedAt: created.toISOString(),
		});
		expect(rows[0].lastActiveAt).not.toBeNull();
	});

	it("returns an empty list when there are no members and no user row", async () => {
		mockDb([[], []]);
		expect(await getMembers()).toEqual([]);
	});

	it("joins team names and last-active sessions onto real members", async () => {
		const joined = new Date("2026-02-01T00:00:00.000Z");
		const sessionTs = "2026-03-01 12:00:00";
		mockDb([
			[
				{
					id: "m-1",
					userId: "u-1",
					name: "Ada",
					email: "ada@example.com",
					image: null,
					role: "owner",
					status: "active",
					joinedAt: joined,
				},
				{
					id: "m-2",
					userId: "u-2",
					name: "Linus",
					email: "linus@example.com",
					image: null,
					role: "member",
					status: "active",
					joinedAt: joined,
				},
			], // members ⋈ user
			[
				{ userId: "u-1", name: "Platform" },
				{ userId: "u-1", name: "Security" },
			], // team membership (only u-1 is on teams)
			[{ userId: "u-1", last: sessionTs }], // last-active sessions (only u-1)
		]);

		const rows = await getMembers();
		expect(rows).toHaveLength(2);
		const ada = rows.find((r) => r.userId === "u-1");
		const linus = rows.find((r) => r.userId === "u-2");
		expect(ada?.teams).toEqual(["Platform", "Security"]);
		expect(ada?.joinedAt).toBe(joined.toISOString());
		expect(ada?.lastActiveAt).toBe(new Date(sessionTs).toISOString());
		// u-2 has neither teams nor a session → empty array + null.
		expect(linus?.teams).toEqual([]);
		expect(linus?.lastActiveAt).toBeNull();
		// …and his stored role is better-auth's own `member`, which the row must report as the
		// role it GRANTS: the table's role <select> offers owner/admin/operator/viewer, so a raw
		// `member` matches no option and renders blank.
		expect(linus?.role).toBe("viewer");
	});
});

describe("getInvitations", () => {
	it("short-circuits to an empty list in the personal scope without touching the db", async () => {
		vi.mocked(currentActor).mockResolvedValue({
			orgId: "user-1",
			userId: "user-1",
		} as never);
		expect(await getInvitations()).toEqual([]);
		expect(getServiceDb).not.toHaveBeenCalled();
	});

	it("maps pending invitations, defaulting role and inviter name", async () => {
		const created = new Date("2026-04-04T04:04:04.000Z");
		mockDb([
			[
				{
					id: "inv-1",
					email: "new@example.com",
					role: "admin",
					inviterName: "Ada",
					inviterEmail: "ada@example.com",
					createdAt: created,
				},
				{
					id: "inv-2",
					email: "other@example.com",
					role: null, // → defaults to "viewer"
					inviterName: null,
					inviterEmail: "boss@example.com", // → falls back to inviter email
					createdAt: created,
				},
			],
		]);

		const rows = await getInvitations();
		expect(rows).toEqual([
			{
				id: "inv-1",
				email: "new@example.com",
				role: "admin",
				inviterName: "Ada",
				createdAt: created.toISOString(),
			},
			{
				id: "inv-2",
				email: "other@example.com",
				role: "viewer",
				inviterName: "boss@example.com",
				createdAt: created.toISOString(),
			},
		]);
	});
});

describe("setMemberSuspended", () => {
	it("suspends a member: flips status and revokes their PDP grant", async () => {
		// Distinct values (not the "m-2" arg) prove the scope flows from the looked-up row.
		const { setSpy } = mockDb([
			[{ orgId: "org-1", userId: "user-BBB", role: "member" }], // member lookup
		]);

		expect(await setMemberSuspended("m-2", true)).toEqual({ ok: true });
		expect(setSpy).toHaveBeenCalledWith({ status: "suspended" });
		expect(revokeMemberGrant).toHaveBeenCalledWith("org-1", "user-BBB");
		expect(ensureMemberGrant).not.toHaveBeenCalled();
		expect(authorize).toHaveBeenCalledWith("manage_members", {
			type: "member",
		});
	});

	it("reactivates a member: restores status and re-grants by role", async () => {
		const { setSpy } = mockDb([
			[{ orgId: "org-1", userId: "user-BBB", role: "admin" }],
		]);

		expect(await setMemberSuspended("m-2", false)).toEqual({ ok: true });
		expect(setSpy).toHaveBeenCalledWith({ status: "active" });
		expect(ensureMemberGrant).toHaveBeenCalledWith("org-1", "user-BBB", "admin");
		expect(revokeMemberGrant).not.toHaveBeenCalled();
	});

	it("throws when the member doesn't exist", async () => {
		mockDb([[]]);
		await expect(setMemberSuspended("missing", true)).rejects.toThrow(
			/Member not found/,
		);
		expect(revokeMemberGrant).not.toHaveBeenCalled();
	});

	it("refuses to touch a member from a different org", async () => {
		mockDb([[{ orgId: "other-org", userId: "u-2", role: "member" }]]);
		await expect(setMemberSuspended("m-2", true)).rejects.toThrow(
			/Member not found/,
		);
	});

	it("refuses to suspend the org owner", async () => {
		mockDb([[{ orgId: "org-1", userId: "u-1", role: "owner" }]]);
		await expect(setMemberSuspended("m-1", true)).rejects.toThrow(
			/owner can't be suspended/,
		);
		expect(revokeMemberGrant).not.toHaveBeenCalled();
	});

	it("propagates the authorization failure (no db access)", async () => {
		vi.mocked(authorize).mockRejectedValue(new Error("Forbidden"));
		await expect(setMemberSuspended("m-2", true)).rejects.toThrow(
			/Forbidden/,
		);
		expect(getServiceDb).not.toHaveBeenCalled();
	});
});
