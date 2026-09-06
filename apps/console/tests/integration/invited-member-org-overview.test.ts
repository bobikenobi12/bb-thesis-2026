// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: an INVITED MEMBER can load the org overview (#3730).
//
// The defect this locks: accepting an invitation writes a `member` row whose role is
// better-auth's built-in `member` (the invite dialog and the ee SSO plugin's
// `organizationProvisioning.defaultRole` both send exactly that string, and the `member.role`
// column defaults to it). `ensureMemberGrant` mapped the role through `toOrgRole`, which knew only
// owner/admin/operator/viewer — so `member` resolved to null and the function returned having
// written NOTHING. The PDP authorizes from `grants`, not from `member.role`, so the accepted member
// held ZERO permissions: `/{org}`'s first `authorize("view", { type: "project" })` threw
// ForbiddenError out of the server component and the `[org]` error boundary rendered
// "Couldn't load this page".
//
// It is measured HERE, at the seam, and not only as a unit test of the role map, because the map
// being right is not the claim — the claim is that the overview's own data path resolves for the
// actor an accepted invitation produces. So the fixture calls the SAME function the ee
// `afterAcceptInvitation` hook calls (`core.ensureMemberGrant(org.id, user.id, member.role)`) with
// the SAME role string better-auth stores, then drives `queryProjects` / `getProjects` /
// `getConnectedCloudProviders` — the three awaits in `app/(private)/[org]/page.tsx` — through the
// real actor seam and the real community PDP.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getConnectedCloudProviders } from "@/app/server/actions/connectors";
import { getProjects, queryProjects } from "@/app/server/actions/projects";
import { runWithActor } from "@/lib/authz/actor-context";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { getPdp } from "@/lib/authz";
import {
	BUILTIN_ROLE_IDS,
	BUILT_IN_ROLES,
	PERMISSIONS,
} from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import type { Actor, Entitlements } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { grants, member, organization, user } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const OWNER = randomUUID();
/** The invitee: a real `member` row with better-auth's built-in `member` role. */
const INVITED = randomUUID();

/** Enterprise entitlements — the org tier a real invite requires; not what is under test. */
const ENTITLEMENTS: Entitlements = {
	organizations: true,
	teams: true,
	sso: true,
	customRoles: true,
	activityExport: true,
	alerting: true,
	advancedAlerting: true,
	byoRunners: true,
	managedPools: true,
	quotas: {
		maxConcurrentJobs: null,
		priorityLevel: 30,
		includedRunnerMinutes: 0,
		activityRetentionDays: 365,
	},
};

/** The actor `[org]/layout.tsx` resolves for this user on `/{org}` (org scope, not personal). */
function actorFor(userId: string): Actor {
	return { userId, orgId: ORG, entitlements: ENTITLEMENTS };
}

/** The org-wide grants held by `userId`, as `role_id`s (empty ⇒ the PDP denies everything). */
async function orgRoleGrants(userId: string): Promise<(string | null)[]> {
	const rows = await getServiceDb()
		.select({ role_id: grants.role_id })
		.from(grants)
		.where(and(eq(grants.org_id, ORG), eq(grants.principal_id, userId)));
	return rows.map((r) => r.role_id);
}

describeIfDb("an invited member can load /{org} (#3730)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values([
			{ id: OWNER, email: `it-3730-owner-${OWNER}@example.test` },
			{ id: INVITED, email: `it-3730-invited-${INVITED}@example.test` },
		]);
		await db.insert(organization).values({ id: ORG, name: `org-3730-${ORG.slice(0, 8)}` });
		// The org's creator, exactly as `afterCreateOrganization` wires them.
		await ensureMemberGrant(ORG, OWNER, "owner");

		// The accepted invitation. `role: "member"` is not a choice this test makes up: it is what
		// better-auth's org plugin stores for an invite sent with its built-in role, what the
		// `member.role` column defaults to, and what ee's SSO `organizationProvisioning.defaultRole`
		// provisions. The e2e T7 spec invites with precisely this string.
		await db.insert(member).values({ organizationId: ORG, userId: INVITED, role: "member" });
		await ensureMemberGrant(ORG, INVITED, "member");
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(member).where(eq(member.organizationId, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, [OWNER, INVITED]));
	});

	it("writes a read-only PDP grant for better-auth's built-in `member` role", async () => {
		// The grant, not the mapping function: `member.role` reaching the PDP as a viewer bundle is
		// the whole mechanism by which the overview loads.
		expect(await orgRoleGrants(INVITED)).toEqual([BUILTIN_ROLE_IDS.viewer]);
	});

	it("the PDP allows the member the overview's permission", async () => {
		const decision = await getPdp().can(actorFor(INVITED), "view", { type: "project" });
		expect(decision).toEqual({ allowed: true });
	});

	it("grants EXACTLY the viewer bundle — every permission in the registry, decided", async () => {
		// The subject list is DERIVED (`PERMISSIONS` × `BUILT_IN_ROLES.viewer`), never typed here: a
		// hand-written "these should be allowed" list stops covering the moment someone adds an
		// action, and stops covering silently.
		//
		// This is also the answer to "is it only /{org}, or every org-scoped route?" — an ungranted
		// member was denied EVERY permission in the matrix, so every route under `[org]` that awaits
		// an `authorize()`-gated action threw into the same shared `[org]/error.tsx`. What is left
		// after the fix is a real permission boundary (a viewer holds no `activity:view_activity`,
		// no `billing:manage_billing`), which is exactly what T7 exists to score.
		const expected = new Set(
			BUILT_IN_ROLES.viewer === "*" ? PERMISSIONS.map((p) => p.key) : BUILT_IN_ROLES.viewer,
		);
		expect(expected.size).toBeGreaterThan(5); // the derivation itself resolved to something
		const actor = actorFor(INVITED);
		const wrong: string[] = [];
		for (const p of PERMISSIONS) {
			const { allowed } = await getPdp().can(actor, p.action, { type: p.resource });
			if (allowed !== expected.has(p.key)) {
				wrong.push(`${p.key}: expected ${expected.has(p.key)}, got ${allowed}`);
			}
		}
		expect(wrong, "the member's permissions are not the viewer bundle").toEqual([]);
		// Named explicitly as well, because the loop above would also pass if `viewer` itself were
		// ever widened: `member` must not reach a write verb.
		expect(expected.has("project:deploy")).toBe(false);
		expect(expected.has("member:manage_members")).toBe(false);
	});

	it("resolves every await in the org overview's server component", async () => {
		// The three parallel awaits in app/(private)/[org]/page.tsx. Before the fix the first two
		// threw ForbiddenError, which is what the `[org]` error boundary was catching.
		const [{ projects, facets }, all, providers] = await runWithActor(
			actorFor(INVITED),
			async () =>
				Promise.all([
					queryProjects({ q: "", clouds: [], repos: [], sort: "activity" }),
					getProjects(),
					getConnectedCloudProviders(),
				]),
		);
		expect(Array.isArray(projects)).toBe(true);
		expect(facets).toBeDefined();
		expect(Array.isArray(all)).toBe(true);
		expect(Array.isArray(providers)).toBe(true);
	});
});
