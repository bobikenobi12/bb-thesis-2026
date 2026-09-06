// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the race-safe promotion-approval claim (lib/promotions/approve.ts) against REAL
// Postgres, under TRUE concurrency. Reproduces audit finding #18 — the lost-update that dropped a
// SOC2 approval: two approvers read the same slot set, both pick the first pending slot, and the
// second UPDATE overwrites the first, collapsing two human approvals onto one. A single-connection
// loop CANNOT reproduce it; each claim runs its own transaction so the calls genuinely race.
//
// The gate later counts `approved` slots (buildGateContext: filter(status==='approved').length vs
// minApprovals), so a 2-of-2 approval must persist as 2 distinct approved slots — asserted here.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	environmentPromotions,
	projectEnvironments,
	projects,
	promotionApprovals,
} from "@/lib/db/schema";
import { claimApprovalSlot } from "@/lib/promotions/approve";
import { describeIfDb } from "./db";

/** Seeds a project + source/target envs + a PENDING_APPROVAL promotion with `slots` pending slots. */
async function seedPromotion(
	owner: string,
	slots: number,
): Promise<{ projectId: string; promotionId: string }> {
	const db = getServiceDb();
	const [p] = await db
		.insert(projects)
		.values({
			user_id: owner,
			project_name: `promo-race-${owner.slice(0, 8)}`,
			region: "us-east-1",
			iac_version: "1.9.5",
		})
		.returning({ id: projects.id });
	const [src] = await db
		.insert(projectEnvironments)
		.values({ project_id: p.id, user_id: owner, name: "staging", status: "ACTIVE", is_default: true })
		.returning({ id: projectEnvironments.id });
	const [tgt] = await db
		.insert(projectEnvironments)
		.values({ project_id: p.id, user_id: owner, name: "prod", status: "ACTIVE", is_default: false })
		.returning({ id: projectEnvironments.id });
	const [promo] = await db
		.insert(environmentPromotions)
		.values({
			project_id: p.id,
			user_id: owner,
			org_id: owner,
			source_environment_id: src.id,
			target_environment_id: tgt.id,
			status: "PENDING_APPROVAL",
		})
		.returning({ id: environmentPromotions.id });
	await db.insert(promotionApprovals).values(
		Array.from({ length: slots }, () => ({
			promotion_id: promo.id,
			project_id: p.id,
			org_id: owner,
		})),
	);
	return { projectId: p.id, promotionId: promo.id };
}

/** All approval rows for a promotion, freshly read (service role). */
async function approvalsOf(promotionId: string) {
	return getServiceDb()
		.select()
		.from(promotionApprovals)
		.where(eq(promotionApprovals.promotion_id, promotionId));
}

describeIfDb("promotion approval — concurrent claim (lost-update fix)", () => {
	const seededProjects: string[] = [];

	afterEach(async () => {
		const db = getServiceDb();
		for (const id of seededProjects) {
			// promotion_approvals / environment_promotions / project_environments cascade off the project.
			await db.delete(projects).where(eq(projects.id, id));
		}
		seededProjects.length = 0;
	});

	it("records BOTH approvals when two distinct approvers race (no lost update, gate sees 2)", async () => {
		const owner = randomUUID();
		const { projectId, promotionId } = await seedPromotion(owner, 2);
		seededProjects.push(projectId);

		const actorA = randomUUID();
		const actorB = randomUUID();

		// Fire both approvals concurrently — each in its own transaction, from the shared pool.
		const [claimA, claimB] = await Promise.all([
			claimApprovalSlot(getServiceDb(), promotionId, actorA, "A approves"),
			claimApprovalSlot(getServiceDb(), promotionId, actorB, "B approves"),
		]);

		// Both actors claimed a slot, and they are DISTINCT slots (the second didn't overwrite the first).
		expect(claimA.outcome).toBe("claimed");
		expect(claimB.outcome).toBe("claimed");
		if (claimA.outcome !== "claimed" || claimB.outcome !== "claimed")
			throw new Error("expected both claims to succeed");
		expect(claimA.slotId).not.toBe(claimB.slotId);

		const rows = await approvalsOf(promotionId);
		const approved = rows.filter((r) => r.status === "approved");
		// Exactly 2 distinct slots approved by 2 distinct actors — neither approval was lost.
		expect(approved).toHaveLength(2);
		expect(new Set(approved.map((r) => r.id)).size).toBe(2);
		expect(new Set(approved.map((r) => r.decided_by)).size).toBe(2);
		expect(new Set(approved.map((r) => r.decided_by))).toEqual(new Set([actorA, actorB]));

		// What the DEPLOY gate would see (buildGateContext): approved count == required (2).
		const gateApprovedCount = rows.filter((r) => r.status === "approved").length;
		expect(gateApprovedCount).toBe(2);
	});

	it("counts only ONE approval when the SAME actor approves twice concurrently (no double-count)", async () => {
		const owner = randomUUID();
		const { projectId, promotionId } = await seedPromotion(owner, 2);
		seededProjects.push(projectId);

		const actor = randomUUID();

		const [c1, c2] = await Promise.all([
			claimApprovalSlot(getServiceDb(), promotionId, actor, "first"),
			claimApprovalSlot(getServiceDb(), promotionId, actor, "second"),
		]);

		// Exactly one call claimed a slot; the other was rejected as an already-approved duplicate.
		const outcomes = [c1.outcome, c2.outcome].sort();
		expect(outcomes).toEqual(["already_approved", "claimed"]);

		const rows = await approvalsOf(promotionId);
		const approved = rows.filter((r) => r.status === "approved");
		// One slot approved by the actor; the second slot stays pending (no double-count).
		expect(approved).toHaveLength(1);
		expect(approved[0].decided_by).toBe(actor);
		expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);
	});

	it("returns no_slots once every slot is taken (single-slot promotion, second approver blocked)", async () => {
		const owner = randomUUID();
		const { projectId, promotionId } = await seedPromotion(owner, 1);
		seededProjects.push(projectId);

		const actorA = randomUUID();
		const actorB = randomUUID();

		const [claimA, claimB] = await Promise.all([
			claimApprovalSlot(getServiceDb(), promotionId, actorA, undefined),
			claimApprovalSlot(getServiceDb(), promotionId, actorB, undefined),
		]);

		// One slot, two racers: exactly one claims it; the other finds no pending slot remaining.
		const outcomes = [claimA.outcome, claimB.outcome].sort();
		expect(outcomes).toEqual(["claimed", "no_slots"]);

		const rows = await approvalsOf(promotionId);
		expect(rows.filter((r) => r.status === "approved")).toHaveLength(1);
	});

	it("re-park guard: a stale pending_approval re-park cannot clobber a promotion already DEPLOYING", async () => {
		// Now that concurrent quorum is reachable (the lost-update fix), a slow approver still
		// evaluating `pending_approval` must not flip a promotion a faster co-approver already moved
		// to APPROVED/DEPLOYING back to PENDING_APPROVAL. applyGateDecision's re-park is predecessor-
		// guarded to PENDING_PLAN/PENDING_APPROVAL; this locks that predicate.
		const owner = randomUUID();
		const { projectId, promotionId } = await seedPromotion(owner, 2);
		seededProjects.push(projectId);
		const db = getServiceDb();

		// A faster co-approver advanced the promotion past approval.
		await db
			.update(environmentPromotions)
			.set({ status: "DEPLOYING" })
			.where(eq(environmentPromotions.id, promotionId));

		// The exact predecessor-guarded re-park applyGateDecision issues in the pending_approval branch.
		const guarded = await db
			.update(environmentPromotions)
			.set({ status: "PENDING_APPROVAL" })
			.where(
				and(
					eq(environmentPromotions.id, promotionId),
					inArray(environmentPromotions.status, ["PENDING_PLAN", "PENDING_APPROVAL"]),
				),
			)
			.returning({ id: environmentPromotions.id });

		// No-op: the DEPLOY stands.
		expect(guarded).toHaveLength(0);
		const [after] = await db
			.select({ status: environmentPromotions.status })
			.from(environmentPromotions)
			.where(eq(environmentPromotions.id, promotionId));
		expect(after.status).toBe("DEPLOYING");

		// Positive control: from a genuine pre-approval state the same guarded re-park DOES apply.
		await db
			.update(environmentPromotions)
			.set({ status: "PENDING_PLAN" })
			.where(eq(environmentPromotions.id, promotionId));
		const applied = await db
			.update(environmentPromotions)
			.set({ status: "PENDING_APPROVAL" })
			.where(
				and(
					eq(environmentPromotions.id, promotionId),
					inArray(environmentPromotions.status, ["PENDING_PLAN", "PENDING_APPROVAL"]),
				),
			)
			.returning({ id: environmentPromotions.id });
		expect(applied).toHaveLength(1);
	});
});
