// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server-side enqueue guard for managed-runner usage. Kept separate from the pure
// lib/billing/usage.ts (which stays I/O-free + unit-tested). Called by the job-enqueue
// server actions before inserting a job. Self-host / self-operated runners are never
// metered, so an org that only uses its own runners has used=0 and never trips this.

import { resolvePlanEntitlements } from "@/lib/billing/plan";
import { getOrgBilling } from "@/lib/billing/queries";
import { effectiveBillingPeriodStart } from "@/lib/billing/period";
import { getServiceDb } from "@/lib/db";
import { queryJobMinutesByOrg } from "@/lib/queries/runner-usage";

/** Thrown when an org is blocked from enqueueing by its usage policy. Mapped to a
 *  user-facing message at the action boundary. */
export class UsageLimitError extends Error {
	constructor(
		message: string,
		/** Whether upgrading the plan would lift the block (community free cap). */
		readonly upgradable: boolean,
	) {
		super(message);
		this.name = "UsageLimitError";
	}
}

/**
 * Blocks a new job when the org is at a HARD limit:
 *  - community (free, no card): hard-stops at its included allowance → upgrade.
 *  - paid with `usageHardCap` on: pauses at included instead of billing overage.
 * Paid orgs without a hard cap are never blocked here — overage simply bills.
 */
export async function assertUsageAllowed(orgId: string): Promise<void> {
	const billing = await getOrgBilling(orgId).catch(() => null);
	const plan = billing?.plan ?? "community";
	const status = billing?.status ?? "none";
	const included =
		resolvePlanEntitlements(plan, status).quotas.includedRunnerMinutes;

	const isCommunity = plan === "community";
	const hardCap = billing?.usageHardCap ?? false;
	// Only these two policies hard-block; everyone else bills overage.
	if (!isCommunity && !hardCap) return;

	const now = new Date();
	const from = effectiveBillingPeriodStart(
		billing?.currentPeriodStart,
		billing?.currentPeriodEnd,
		now,
	);
	const rows = await queryJobMinutesByOrg(getServiceDb(), {
		from,
		to: now,
		orgId,
	});
	const used = rows[0]?.job_minutes ?? 0;
	if (used < included) return;

	throw isCommunity
		? new UsageLimitError(
				`You've used your ${included} included provisioning minutes this month. Upgrade to keep provisioning.`,
				true,
			)
		: new UsageLimitError(
				`Usage cap reached (${included} minutes). Raise the cap in Billing or disable it to allow overage.`,
				false,
			);
}
