"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq, inArray, sql } from "drizzle-orm";
import {
	getBillingSummary,
	getCollaborationAccess,
} from "@/app/server/actions/billing";
import { ensureMemberGrant, revokeMemberGrant } from "@/lib/authz/grants";
import { authorize, currentActor } from "@/lib/authz/guard";
import { toDisplayRole } from "@/lib/authz/org-access-control";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { getServiceDb } from "@/lib/db";
import {
	invitation,
	member,
	session,
	team,
	teamMember,
	user,
} from "@/lib/db/schema";
import { INVITE_ROLES, type InviteRoleOption } from "@/lib/members/roles";
import {
	type MembersPage,
	type MembersQuery,
	queryMembersPage,
} from "@/lib/queries/members";

export interface MemberRow {
	/** member-row id (or the user id when synthesizing the personal owner). */
	id: string;
	userId: string;
	name: string | null;
	username: string | null;
	email: string;
	image: string | null;
	role: string;
	joinedAt: string;
	/** Names of the teams this member belongs to in the active org. */
	teams: string[];
	/** 'active' | 'suspended'. */
	status: string;
	/** ISO timestamp of the member's most recent session, or null if never. */
	lastActiveAt: string | null;
}

/**
 * Members of the active organization (member ⋈ user), each with their team names. In
 * the community build the active org is the user's personal org, which has no `member`
 * rows — so we synthesize the single owner (you), making the page truthful not locked.
 */
export async function getMembers(): Promise<MemberRow[]> {
	const actor = await currentActor();
	const db = getServiceDb();

	const rows = await db
		.select({
			id: member.id,
			userId: user.id,
			name: user.name,
			username: user.username,
			email: user.email,
			image: user.image,
			role: member.role,
			status: member.status,
			joinedAt: member.createdAt,
		})
		.from(member)
		.innerJoin(user, eq(member.userId, user.id))
		.where(eq(member.organizationId, actor.orgId));

	if (rows.length === 0) {
		// Personal workspace: you are the sole owner.
		const [u] = await db
			.select({
				id: user.id,
				name: user.name,
				username: user.username,
				email: user.email,
				image: user.image,
				createdAt: user.createdAt,
			})
			.from(user)
			.where(eq(user.id, actor.userId))
			.limit(1);
		if (!u) return [];
		return [
			{
				id: u.id,
				userId: u.id,
				name: u.name,
				username: u.username,
				email: u.email,
				image: u.image,
				role: "owner",
				status: "active",
				joinedAt: u.createdAt.toISOString(),
				teams: [],
				lastActiveAt: new Date().toISOString(),
			},
		];
	}

	// Team names per member (only this org's teams).
	const userIds = rows.map((r) => r.userId);
	const teamRows = await db
		.select({ userId: teamMember.userId, name: team.name })
		.from(teamMember)
		.innerJoin(team, eq(teamMember.teamId, team.id))
		.where(
			and(
				eq(team.organizationId, actor.orgId),
				inArray(teamMember.userId, userIds),
			),
		);
	const teamsByUser = new Map<string, string[]>();
	for (const t of teamRows) {
		const arr = teamsByUser.get(t.userId) ?? [];
		arr.push(t.name);
		teamsByUser.set(t.userId, arr);
	}

	// Last-active = the most recent session per user.
	const lastRows = await db
		.select({
			userId: session.userId,
			last: sql<string>`max(${session.updatedAt})`,
		})
		.from(session)
		.where(inArray(session.userId, userIds))
		.groupBy(session.userId);
	const lastByUser = new Map<string, string>();
	for (const r of lastRows) {
		if (r.last) lastByUser.set(r.userId, new Date(r.last).toISOString());
	}

	return rows.map((r) => ({
		...r,
		// The role the row GRANTS, not the string better-auth happened to store. Its own built-in
		// `member` is our viewer (`toPdpRole`), and the table's role <select> only offers our
		// four — a raw `member` matches no option and the control renders blank.
		role: toDisplayRole(r.role),
		joinedAt: r.joinedAt.toISOString(),
		teams: teamsByUser.get(r.userId) ?? [],
		lastActiveAt: lastByUser.get(r.userId) ?? null,
	}));
}

/**
 * The Members PAGE read (#2899): member rows AND pending invitations filtered SERVER-SIDE
 * in SQL for `query`, plus status/role/team facet counts over the org's UNFILTERED universe
 * — the console filter standard's steps 5 + 6 (lib/query/README.md).
 *
 * The table is one list of two record kinds, so one call returns both: a `statuses: ["pending"]`
 * selection is an invitations-only answer, and a team filter excludes invitations entirely
 * (an invitation has no teams). The unfiltered `getMembers()` / `getInvitations()` above stay
 * as they are — they are the shared universe reads (`qk.members(org)`, the activity log's
 * author resolution, the manage-team dialog), mirroring `getJobs()` / `getJobsPage()`.
 *
 * Authorization is IDENTICAL to `getMembers()`: `currentActor()` resolves the caller's active
 * tenancy and every predicate is scoped to `actor.orgId` (never a client-supplied org). The
 * personal-workspace fallback (an org with no `member` rows shows you, the sole owner) is
 * preserved, and `actor.userId` is the only thing that can synthesize it.
 */
export async function getMembersPage(
	query: MembersQuery = {},
): Promise<MembersPage> {
	const actor = await currentActor();
	return queryMembersPage(actor.orgId, actor.userId, query);
}

/** A pending invitation to the active org. */
export interface InvitationRow {
	id: string;
	email: string;
	role: string;
	inviterName: string;
	createdAt: string;
}

/** Pending invitations for the active organization (invitation ⋈ inviter). */
export async function getInvitations(): Promise<InvitationRow[]> {
	const actor = await currentActor();
	if (actor.orgId === actor.userId) return []; // personal scope → no invitations
	const db = getServiceDb();

	const rows = await db
		.select({
			id: invitation.id,
			email: invitation.email,
			role: invitation.role,
			inviterName: user.name,
			inviterEmail: user.email,
			createdAt: invitation.createdAt,
		})
		.from(invitation)
		.leftJoin(user, eq(invitation.inviterId, user.id))
		.where(
			and(
				eq(invitation.organizationId, actor.orgId),
				eq(invitation.status, "pending"),
			),
		);

	return rows.map((r) => ({
		id: r.id,
		email: r.email,
		// Same normalisation as the member rows: a pending invite carrying better-auth's own
		// `member` is a viewer, and the list renders both kinds through one role column.
		role: toDisplayRole(r.role ?? "viewer"),
		inviterName: r.inviterName ?? r.inviterEmail ?? "—",
		createdAt: r.createdAt.toISOString(),
	}));
}

/**
 * Suspends or reactivates a member. Suspending keeps the member row + role but revokes
 * their PDP grant (no access); reactivating restores the grant. Owner-gated; refuses on
 * the org owner and on members from a different org.
 */
export async function setMemberSuspended(
	memberId: string,
	suspended: boolean,
): Promise<{ ok: true }> {
	const actor = await authorize("manage_members", { type: "member" });
	const db = getServiceDb();

	const [m] = await db
		.select({
			orgId: member.organizationId,
			userId: member.userId,
			role: member.role,
		})
		.from(member)
		.where(eq(member.id, memberId))
		.limit(1);
	if (!m || m.orgId !== actor.orgId) throw new Error("Member not found.");
	if (m.role === "owner") throw new Error("The owner can't be suspended.");

	await db
		.update(member)
		.set({ status: suspended ? "suspended" : "active" })
		.where(eq(member.id, memberId));

	if (suspended) {
		await revokeMemberGrant(m.orgId, m.userId);
	} else {
		await ensureMemberGrant(m.orgId, m.userId, m.role);
	}
	return { ok: true };
}

/** Everything the invite dialog needs in one round-trip: gate, plan/seat context, the
 * role choices, and the emails already in the org (for client-side dedupe). */
export interface InviteContext {
	/** The org may invite (card-backed/paid). When false the UI shows the upsell. */
	canInvite: boolean;
	/** Stripe is wired (hosted) — drives whether the seat-cost banner is meaningful. */
	hosted: boolean;
	plan: BillingPlan;
	/** Members currently occupying a seat (the seat banner's "in use"). */
	memberCount: number;
	/** Per-seat (or flat) monthly USD, for the seat-cost banner. null = unknown/custom. */
	unitAmountUsd: number | null;
	roles: InviteRoleOption[];
	/** Lowercased emails of existing members (already in the org). */
	existingEmails: string[];
	/** Lowercased emails with a pending invitation. */
	pendingEmails: string[];
}

/** Resolves the invite dialog's context: the collaboration gate, plan/seat figures, the
 * available roles, and the emails already taken (member or pending). Read-only; any member
 * (the actual invite goes through Better Auth, gated by the ee `beforeCreateInvitation`
 * hook / `canOrgInvite`). */
export async function getInviteContext(): Promise<InviteContext> {
	const actor = await currentActor();
	const db = getServiceDb();

	const [access, billing, rows] = await Promise.all([
		getCollaborationAccess(),
		getBillingSummary(),
		actor.orgId === actor.userId
			? Promise.resolve(
					Array<{ memberEmail: string | null; inviteEmail: string | null }>(),
				)
			: db
					.select({ memberEmail: user.email, inviteEmail: invitation.email })
					.from(member)
					.innerJoin(user, eq(member.userId, user.id))
					.where(eq(member.organizationId, actor.orgId))
					.then((members) =>
						db
							.select({ email: invitation.email })
							.from(invitation)
							.where(
								and(
									eq(invitation.organizationId, actor.orgId),
									eq(invitation.status, "pending"),
								),
							)
							.then((invites) => [
								...members.map((m) => ({
									memberEmail: m.memberEmail,
									inviteEmail: null,
								})),
								...invites.map((i) => ({
									memberEmail: null,
									inviteEmail: i.email,
								})),
							]),
					),
	]);

	const existingEmails: string[] = [];
	const pendingEmails: string[] = [];
	for (const r of rows) {
		if (r.memberEmail) existingEmails.push(r.memberEmail.toLowerCase());
		if (r.inviteEmail) pendingEmails.push(r.inviteEmail.toLowerCase());
	}

	return {
		canInvite: access.canInvite,
		hosted: billing.hosted,
		plan: billing.plan,
		memberCount: billing.memberCount,
		unitAmountUsd: billing.unitAmountUsd,
		roles: [...INVITE_ROLES],
		existingEmails,
		pendingEmails,
	};
}
