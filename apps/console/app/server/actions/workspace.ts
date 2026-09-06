"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { and, eq } from "drizzle-orm";
import { getOwnerScope } from "@/lib/auth/owner";
import { getActiveScope } from "@/lib/auth/scope";
import { getEntitlements } from "@/lib/authz/entitlements";
import type { Entitlements } from "@/lib/authz/types";
import { deploymentMode } from "@/lib/billing/config";
import { isBillingActive } from "@/lib/billing/plan";
import { PERSONAL_ORG_SLUG } from "@/lib/routing";
import { getServiceDb } from "@/lib/db";
import type { BillingPlan, BillingStatus } from "@/lib/db/schema/enums";
import {
	member,
	organization,
	organizationBilling,
	session as sessionTable,
} from "@/lib/db/schema";

export interface WorkspaceOrg {
	id: string;
	name: string;
	/**
	 * URL slug for C2 routing (`/{slug}/…`). The synthetic personal scope uses the reserved `~`.
	 *
	 * NULLABLE, AND IT MUST NOT BE ALIASED. `organizations.slug` is `text().unique()` with no
	 * notNull, so a real org can have none — and this used to answer `r.slug ?? PERSONAL_ORG_SLUG`
	 * for that case, which made a real org indistinguishable on the wire from the user's PERSONAL
	 * workspace. The switcher then navigated anyone who picked it to `/~`: a different tenant,
	 * silently, with no error. An org with no slug has no URL, and saying so is the only honest
	 * answer — `null` here, and the switcher renders it non-selectable.
	 */
	slug: string | null;
	/** Served logo URL, or null → monogram. */
	logo: string | null;
	role: string;
	/** Effective billing plan — the org's plan while its subscription is live, else
	 * `community`. Drives the plan badge in the switcher. */
	plan: BillingPlan;
	/** Subscription status — drives the "Trial" highlight in the switcher. */
	status: BillingStatus;
}

export interface WorkspaceContext {
	/** The org the request is currently scoped to (drives the PDP + RLS). */
	activeOrgId: string;
	/** Orgs the user belongs to; community = a single synthetic "Personal" workspace. */
	organizations: WorkspaceOrg[];
	entitlements: Entitlements;
	/** Hosted SaaS vs self-managed/community deployment — gates platform-fleet surfaces client-side. */
	isHosted: boolean;
}

/**
 * The dashboard's workspace context for the current session: the active org, the
 * orgs the user can switch to, and the feature entitlements (the client uses these
 * to gate the org switcher + admin surfaces). Community has no org plugin, so the
 * `member` table is empty and we synthesize the user's "Personal" workspace.
 */
export async function getWorkspaceContext(): Promise<WorkspaceContext> {
	const { userId, activeOrgId } = await getOwnerScope();
	const actor = await getActiveScope(userId, activeOrgId);
	const entitlements = getEntitlements(actor);

	const rows = await getServiceDb()
		.select({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			logo: organization.logo,
			role: member.role,
			plan: organizationBilling.plan,
			status: organizationBilling.status,
		})
		.from(member)
		.innerJoin(organization, eq(member.organizationId, organization.id))
		.leftJoin(
			organizationBilling,
			eq(organization.id, organizationBilling.organizationId),
		)
		.where(eq(member.userId, userId));

	const organizations: WorkspaceOrg[] =
		rows.length > 0
			? rows.map((r) => ({
					id: r.id,
					name: r.name,
					// NOT `?? PERSONAL_ORG_SLUG` — see the field's doc. Aliasing a slugless org onto
					// the reserved personal slug is how picking it navigated to the wrong tenant.
					slug: r.slug,
					logo: r.logo,
					role: r.role,
					// Effective plan: the paid plan only while the subscription is live.
					plan:
						r.plan && r.status && isBillingActive(r.status) ? r.plan : "community",
					status: r.status ?? "none",
				}))
			: [
					{
						id: userId,
						name: "Personal",
						slug: PERSONAL_ORG_SLUG,
						logo: null,
						role: "owner",
						plan: "community",
						status: "none",
					},
				];

	return {
		activeOrgId: actor.orgId,
		organizations,
		entitlements,
		isHosted: deploymentMode() === "hosted",
	};
}

/**
 * Switches the session's active organization. The personal org (orgId === userId)
 * is always allowed; any real org requires membership. Persists
 * session.active_organization_id, which getActiveScope() reads on the next request.
 * Community is single-org so this is effectively a no-op there.
 */
export async function setActiveOrganization(
	orgId: string,
): Promise<{ ok: boolean }> {
	const { userId, sessionId } = await getOwnerScope();

	if (orgId !== userId) {
		const [m] = await getServiceDb()
			.select({ id: member.id })
			.from(member)
			.where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
			.limit(1);
		if (!m) throw new Error("Not a member of that organization");
	}

	await getServiceDb()
		.update(sessionTable)
		.set({ activeOrganizationId: orgId })
		.where(eq(sessionTable.id, sessionId));

	return { ok: true };
}
