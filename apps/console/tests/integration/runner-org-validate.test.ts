// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the defense-in-depth enqueue guard `assertRunnerInOrg` against real
// Postgres. Seeds two orgs, each with a self-operated runner, and proves the guard
// mirrors claim_next_job's admission EXACTLY: it ACCEPTS an in-org self runner AND a
// managed (org_id NULL) platform-fleet runner (both claimable), and REJECTS a
// different-tenant self runner and a non-existent runner id (same rejection — no
// cross-tenant disclosure).
//
// The runner's owning org is read from `runners.org_id` — the SAME column
// claim_next_job compares against `v_runner_org_id` — so this exercises the exact
// notion of "the runner's org" the execution guard uses. `org_id` is backfilled to
// `user_id` by the set_org_id trigger on insert, which this test also asserts.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRunnerInOrg } from "@/lib/authz/runner-org";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { describeIfDb, seedManagedRunner } from "./db";

// Community model: org_id === user_id (backfilled by the set_org_id trigger).
const ORG_A = randomUUID();
const ORG_B = randomUUID();

/**
 * A user who belongs to TWO orgs — their personal one (their own id) and a Teams org. This
 * is the shape the no-backfill ruling turns on: `runnerPersonal` is stamped with the personal
 * org by the trigger (as every pre-#3874 CLI deploy was), while the user now acts in TEAM_ORG.
 */
const USER_MULTI = randomUUID();
const TEAM_ORG = randomUUID();

let runnerA: string;
let runnerB: string;
let managedRunner: string;
let runnerPersonal: string;
let runnerTeam: string;

/** Inserts a self-operated runner owned by `userId`; org_id backfills to user_id. */
async function seedSelfRunner(userId: string, name: string): Promise<string> {
	const [row] = await getServiceDb()
		.insert(runners)
		.values({
			user_id: userId,
			name,
			operator: "self", // self ⇒ user_id NOT NULL + provisioning NOT NULL (CHECKs)
			provisioning: "registered",
			token_hash: `hash-${name}`,
			status: "OFFLINE",
		})
		.returning({ id: runners.id, org_id: runners.org_id });
	// The set_org_id trigger must backfill org_id = user_id — the org notion the
	// claim guard (v_runner_org_id) and this validator both key on.
	expect(row.org_id).toBe(userId);
	return row.id;
}

/**
 * Inserts a self-operated runner stamped with an EXPLICIT org — the shape #3874 writes from
 * now on (the CLI deploy route sets org_id itself, since getServiceDb() sets no GUC for the
 * trigger to read). The explicit value must survive: the trigger only fills a NULL.
 */
async function seedTeamRunner(
	userId: string,
	orgId: string,
	name: string,
): Promise<string> {
	const [row] = await getServiceDb()
		.insert(runners)
		.values({
			user_id: userId,
			org_id: orgId,
			name,
			operator: "self",
			provisioning: "deployed",
			token_hash: `hash-${name}`,
			status: "OFFLINE",
		})
		.returning({ id: runners.id, org_id: runners.org_id });
	// The trigger fires `IF NEW.org_id IS NULL` only, so an explicit stamp is authoritative.
	// If this ever fails, the deploy route's explicit org_id is being overwritten and every
	// forward-stamped runner is silently back in a personal org.
	expect(row.org_id).toBe(orgId);
	return row.id;
}

describeIfDb("assertRunnerInOrg (defense-in-depth enqueue guard)", () => {
	beforeAll(async () => {
		runnerA = await seedSelfRunner(ORG_A, `it-runner-a-${ORG_A.slice(0, 8)}`);
		runnerB = await seedSelfRunner(ORG_B, `it-runner-b-${ORG_B.slice(0, 8)}`);
		managedRunner = await seedManagedRunner(`it-managed-${ORG_A.slice(0, 8)}`);
		// LET THE TRIGGER STAMP IT. Writing `org_id: USER_MULTI` by hand would only prove a test
		// can type a uuid twice; seeding it the way production seeded it proves the row this
		// allowance exists for is the row the database actually produces.
		runnerPersonal = await seedSelfRunner(
			USER_MULTI,
			`it-runner-personal-${USER_MULTI.slice(0, 8)}`,
		);
		runnerTeam = await seedTeamRunner(
			USER_MULTI,
			TEAM_ORG,
			`it-runner-team-${TEAM_ORG.slice(0, 8)}`,
		);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(runners).where(eq(runners.id, runnerA));
		await db.delete(runners).where(eq(runners.id, runnerB));
		await db.delete(runners).where(eq(runners.id, managedRunner));
		await db.delete(runners).where(eq(runners.id, runnerPersonal));
		await db.delete(runners).where(eq(runners.id, runnerTeam));
	});

	it("ACCEPTS a runner that belongs to the caller's org", async () => {
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerA, ORG_A),
		).resolves.toBeUndefined();
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerB, ORG_B),
		).resolves.toBeUndefined();
	});

	it("REJECTS a runner owned by another org (cross-tenant assignment)", async () => {
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerB, ORG_A),
		).rejects.toBeInstanceOf(ForbiddenError);
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerA, ORG_B),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("REJECTS a non-existent runner id with the SAME error (no disclosure)", async () => {
		await expect(
			assertRunnerInOrg(getServiceDb(), randomUUID(), ORG_A),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("ACCEPTS a managed (org_id NULL) runner for any tenant — mirrors claim_next_job's `v_operator='managed'` admission", async () => {
		// A managed platform-fleet runner belongs to no tenant and assumes-role into the
		// job's own org at run time, so pinning to it is legitimate for any caller — the
		// enqueue guard must not be stricter than the claim guard that would accept it.
		await expect(
			assertRunnerInOrg(getServiceDb(), managedRunner, ORG_A),
		).resolves.toBeUndefined();
		await expect(
			assertRunnerInOrg(getServiceDb(), managedRunner, ORG_B),
		).resolves.toBeUndefined();
	});

	// ── The transitional personal-org admission (#3874) ──────────────────────────────────
	//
	// #3874 stamps org_id FORWARD ONLY: the maintainer's ruling refuses a backfill, so every
	// runner the CLI deployed before it keeps `org_id = user_id` — the deployer's personal
	// org. `runnerPersonal` below is exactly that row: seeded with no explicit org_id so the
	// set_org_id trigger stamps user_id, the same way production did. A member of a Teams org
	// calling with `orgId = TEAM_ORG` must still be able to destroy it, or the no-backfill
	// ruling makes every historical runner permanently undestroyable.
	//
	// The allowance is an ADMISSION, not a relaxation, and the third-org case below is the
	// assertion that says so: `personalOrgId` is the caller's own id, proven by the CLI token,
	// so it can only ever admit rows the caller already owns. Without that test "transitional
	// allowance" and "accept anything" are indistinguishable from the outside.
	it("ACCEPTS the caller's PERSONAL org when personalOrgId is passed — the pre-#3874 runner stays destroyable", async () => {
		// USER_MULTI's personal org is their own id; TEAM_ORG is the org they act in today.
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerPersonal, TEAM_ORG, USER_MULTI),
		).resolves.toBeUndefined();
	});

	it("REFUSES that same runner when personalOrgId is NOT passed (call sites opt in)", async () => {
		// The deploy route deliberately does not opt in — it stamps its job `actor.orgId`, so
		// admitting a personal-org runner there would queue a job nothing can ever claim.
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerPersonal, TEAM_ORG),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("ACCEPTS the ACTIVE org's runner under the same call shape", async () => {
		// The allowance must not have replaced the ordinary arm: a runner stamped with the team
		// org — what #3874 writes from now on — is still admitted.
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerTeam, TEAM_ORG, USER_MULTI),
		).resolves.toBeUndefined();
	});

	it("STILL REFUSES a THIRD org's runner with the allowance in play — it is an admission, not `accept anything`", async () => {
		// runnerB belongs to ORG_B: neither the caller's active org nor their personal org.
		// If this ever passes, the transitional allowance has become a hole in tenancy.
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerB, TEAM_ORG, USER_MULTI),
		).rejects.toBeInstanceOf(ForbiddenError);
		// And the personal org is not a skeleton key in the other direction either: the caller
		// cannot reach ORG_B's runner by naming their own personal org as the active one.
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerB, USER_MULTI, USER_MULTI),
		).rejects.toBeInstanceOf(ForbiddenError);
	});
});
