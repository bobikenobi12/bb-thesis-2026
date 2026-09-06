// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-seat billing: keep a Pro org's Stripe subscription quantity in step with its
// billable membership. Invites land AFTER checkout (the create-org sheet), so the seat
// count grows over time — `syncOrgSeats` is called from the org plugin's member
// lifecycle hooks (afterAddMember / afterRemoveMember / afterUpdateMemberRole) to
// reconcile the quantity (prorated). Billable = every active member whose role does not
// resolve to `viewer` (viewers are free, matching the plan catalog). Hosted-only; no-op
// without Stripe.

import { and, count, eq, notInArray } from "drizzle-orm";
import { storedRolesFor } from "@/lib/authz/org-access-control";
import { isStripeConfigured } from "@/lib/billing/config";
import { getOrgBilling } from "@/lib/billing/queries";
import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";
import { member } from "@/lib/db/schema";

// The free roles, by what they GRANT rather than by how they are spelled. `viewer` is not the
// only string that means viewer: better-auth writes its own built-in `member` (the column
// default, and what an invite sent with the plugin's default carries), which `toPdpRole` resolves
// to the read-only bundle. Comparing the raw string would bill that person a paid seat for access
// they do not have — the two halves of the product disagreeing about one word.
const FREE_ROLES = storedRolesFor("viewer");

/** Count of an org's billable seats: active members whose role isn't a free (viewer) one. */
export async function countBillableSeats(orgId: string): Promise<number> {
	const [row] = await getServiceDb()
		.select({ n: count() })
		.from(member)
		.where(
			and(
				eq(member.organizationId, orgId),
				eq(member.status, "active"),
				notInArray(member.role, FREE_ROLES),
			),
		);
	return row?.n ?? 0;
}

/**
 * Reconciles the org's live subscription quantity with its billable seat count
 * (prorated). No-op unless Stripe is configured and the org has a live (active /
 * trialing) subscription. Touches only the flat plan item — never the metered
 * runner-minutes item — and skips the Stripe write when the quantity already matches.
 */
export async function syncOrgSeats(orgId: string): Promise<void> {
	if (!isStripeConfigured()) return;
	const billing = await getOrgBilling(orgId);
	if (!billing?.stripeSubscriptionId) return;
	if (billing.status !== "active" && billing.status !== "trialing") return;

	const seats = Math.max(1, await countBillableSeats(orgId));
	const stripe = getStripe();
	const sub = await stripe.subscriptions.retrieve(billing.stripeSubscriptionId);
	// The seat item is the licensed (non-metered) line; runner-minutes is metered.
	const flat = sub.items.data.find(
		(i) => i.price.recurring?.usage_type !== "metered",
	);
	if (!flat || flat.quantity === seats) return;

	await stripe.subscriptions.update(sub.id, {
		items: [{ id: flat.id, quantity: seats }],
		proration_behavior: "create_prorations",
	});
}
