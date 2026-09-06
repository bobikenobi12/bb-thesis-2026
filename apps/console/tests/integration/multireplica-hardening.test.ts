// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the three cross-replica double-fire guards for the fleet/background
// loops, which a single-connection loop CANNOT reproduce. All three are safe-by-idempotency (there is
// no leader election): a Postgres primitive (advisory lock / partial-unique index / claim CAS) makes
// concurrent replicas converge to a single actor.
//
//   1. Fleet-scaler create/scale-down span behind a per-provider `pg_try_advisory_xact_lock`
//      (lib/fleet/queue.ts `tryFleetScaleLock`) — only ONE replica mutates a provider's pool per tick.
//   2. Drift double-enqueue behind the `uq_jobs_active_drift_per_env` partial-unique index +
//      `ON CONFLICT DO NOTHING` (lib/drift/dispatch.ts) — at most ONE in-flight DETECT_DRIFT per env.
//   3. Connection-sweeper redundant probing behind a claim CAS on `last_tested_at`
//      (lib/cloud-providers/sweep.ts `claimDueConnection`) — one replica probes per TTL window.
//
// `uq_jobs_active_drift_per_env` (the ON CONFLICT arbiter) is created by migration 0087, which the
// integration harness applies before this suite runs — so these tests exercise the real migrated index.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, expect, it } from "vitest";
import { claimDueConnection } from "@/lib/cloud-providers/sweep";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { tryFleetScaleLock } from "@/lib/fleet/queue";
import { describeIfDb } from "./db";

const URL = process.env.ALETHIA_DATABASE_URL ?? "";

/** The exact advisory-lock key the scaler uses for a provider (mirrors tryFleetScaleLock). */
const scaleLockKeySql = (provider: string) =>
	sql`hashtextextended(${`fleet-scaler:${provider}`}, 0)`;

describeIfDb("multi-replica hardening — cross-replica double-fire guards", () => {
	// Ensure the not-yet-generated partial-unique index exists (see file header). Idempotent.
	const seededProjects: string[] = [];
	const seededCloudIds: string[] = [];

	afterEach(async () => {
		// jobs cascade-clean via their env's project (ON DELETE CASCADE from projects→envs; jobs.env FK
		// is SET NULL, so delete jobs explicitly first by project).
		if (seededProjects.length) {
			await getServiceDb()
				.delete(jobs)
				.where(inArray(jobs.project_id, seededProjects));
			await getServiceDb()
				.delete(projects)
				.where(inArray(projects.id, seededProjects));
		}
		if (seededCloudIds.length) {
			await getServiceDb()
				.delete(cloudIdentities)
				.where(inArray(cloudIdentities.id, seededCloudIds));
		}
		seededProjects.length = 0;
		seededCloudIds.length = 0;
	});

	// ── 1. Fleet-scaler advisory-lock leader gate ───────────────────────────────
	it("advisory lock: two concurrent sessions taking the SAME key — exactly one wins", async () => {
		const a = postgres(URL, { max: 1, idle_timeout: 2, onnotice: () => {} });
		const b = postgres(URL, { max: 1, idle_timeout: 2, onnotice: () => {} });
		try {
			// Session A opens a tx and takes the xact-scoped lock → true.
			await a`begin`;
			const [ra] = await a`
				select pg_try_advisory_xact_lock(hashtextextended('fleet-scaler:hetzner', 0)) as locked`;
			expect(ra.locked).toBe(true);

			// Session B (a "second replica") tries the same key while A holds it → false, no wait.
			await b`begin`;
			const [rb] = await b`
				select pg_try_advisory_xact_lock(hashtextextended('fleet-scaler:hetzner', 0)) as locked`;
			expect(rb.locked).toBe(false);

			// A commits → releases the xact lock; B can now acquire it.
			await a`commit`;
			const [rb2] = await b`
				select pg_try_advisory_xact_lock(hashtextextended('fleet-scaler:hetzner', 0)) as locked`;
			expect(rb2.locked).toBe(true);
			await b`commit`;
		} finally {
			await a.end({ timeout: 5 });
			await b.end({ timeout: 5 });
		}
	});

	it("advisory lock: a DIFFERENT provider key does NOT collide (per-provider isolation)", async () => {
		const a = postgres(URL, { max: 1, idle_timeout: 2, onnotice: () => {} });
		const b = postgres(URL, { max: 1, idle_timeout: 2, onnotice: () => {} });
		try {
			await a`begin`;
			const [ra] = await a`
				select pg_try_advisory_xact_lock(hashtextextended('fleet-scaler:hetzner', 0)) as locked`;
			expect(ra.locked).toBe(true);
			// aws pool is a different key → the aws scaler is NOT blocked by the hetzner holder.
			await b`begin`;
			const [rb] = await b`
				select pg_try_advisory_xact_lock(hashtextextended('fleet-scaler:aws', 0)) as locked`;
			expect(rb.locked).toBe(true);
			await a`commit`;
			await b`commit`;
		} finally {
			await a.end({ timeout: 5 });
			await b.end({ timeout: 5 });
		}
	});

	it("tryFleetScaleLock: single-instance path — lock free ⇒ apply runs ⇒ returns true", async () => {
		let ran = 0;
		const acquired = await tryFleetScaleLock("hetzner", async () => {
			ran += 1;
		});
		expect(acquired).toBe(true);
		expect(ran).toBe(1);
	});

	it("tryFleetScaleLock: another replica holds the lock ⇒ apply SKIPPED ⇒ returns false", async () => {
		const holder = postgres(URL, { max: 1, idle_timeout: 5, onnotice: () => {} });
		try {
			// Simulate replica-1 holding the hetzner scale lock across its tick.
			await holder`begin`;
			const [h] = await holder`
				select pg_try_advisory_xact_lock(hashtextextended('fleet-scaler:hetzner', 0)) as locked`;
			expect(h.locked).toBe(true);

			// replica-2's scaler must non-blockingly bail: apply never runs, no over-provision.
			let ran = 0;
			const acquired = await tryFleetScaleLock("hetzner", async () => {
				ran += 1;
			});
			expect(acquired).toBe(false);
			expect(ran).toBe(0);

			// A different provider is unaffected (proves the skip is per-provider, not global).
			let ranAws = 0;
			const acquiredAws = await tryFleetScaleLock("aws", async () => {
				ranAws += 1;
			});
			expect(acquiredAws).toBe(true);
			expect(ranAws).toBe(1);

			await holder`commit`;
		} finally {
			await holder.end({ timeout: 5 });
		}
	});

	// ── 2. Drift double-enqueue guard ────────────────────────────────────────────

	/** Seed a project + one environment; returns its ids. */
	async function seedEnv(): Promise<{ projectId: string; envId: string; userId: string }> {
		const userId = randomUUID();
		const [p] = await getServiceDb()
			.insert(projects)
			.values({
				user_id: userId,
				project_name: `mr-${userId.slice(0, 8)}`,
				region: "nbg1",
				iac_version: "1.0.0",
			})
			.returning({ id: projects.id });
		seededProjects.push(p.id);
		const [e] = await getServiceDb()
			.insert(projectEnvironments)
			.values({ project_id: p.id, user_id: userId, name: "prod", is_default: true })
			.returning({ id: projectEnvironments.id });
		return { projectId: p.id, envId: e.id, userId };
	}

	/** Enqueue a DETECT_DRIFT job for `envId` via the exact dispatch ON CONFLICT path; returns whether
	 *  a row actually landed (a dropped conflict → false). */
	async function enqueueDrift(
		projectId: string,
		envId: string,
		userId: string,
	): Promise<boolean> {
		const rows = await getServiceDb()
			.insert(jobs)
			.values({
				user_id: userId,
				project_id: projectId,
				environment_id: envId,
				job_type: "DETECT_DRIFT",
				config_snapshot: {},
				status: "QUEUED",
			})
			.onConflictDoNothing({
				target: jobs.environment_id,
				where: sql`job_type = 'DETECT_DRIFT' AND status IN ('QUEUED', 'CLAIMED', 'PROCESSING')`,
			})
			.returning({ id: jobs.id });
		return rows.length > 0;
	}

	async function activeDriftCount(envId: string): Promise<number> {
		const rows = await getServiceDb().execute<{ n: number }>(sql`
			select count(*)::int as n from public.jobs
			where environment_id = ${envId}::uuid and job_type = 'DETECT_DRIFT'
			  and status in ('QUEUED', 'CLAIMED', 'PROCESSING')`);
		return Number(rows[0].n);
	}

	it("drift: a second insert for an already in-flight env is dropped (no duplicate)", async () => {
		const { projectId, envId, userId } = await seedEnv();

		expect(await enqueueDrift(projectId, envId, userId)).toBe(true); // first lands
		expect(await enqueueDrift(projectId, envId, userId)).toBe(false); // conflict → dropped
		expect(await activeDriftCount(envId)).toBe(1);
	});

	it("drift: two CONCURRENT replica inserts for the same env → exactly one lands", async () => {
		const { projectId, envId, userId } = await seedEnv();
		const [r1, r2] = await Promise.all([
			enqueueDrift(projectId, envId, userId),
			enqueueDrift(projectId, envId, userId),
		]);
		expect([r1, r2].filter(Boolean)).toHaveLength(1);
		expect(await activeDriftCount(envId)).toBe(1);
	});

	it("drift: once the in-flight job COMPLETES, a fresh drift is allowed again", async () => {
		const { projectId, envId, userId } = await seedEnv();
		expect(await enqueueDrift(projectId, envId, userId)).toBe(true);
		expect(await enqueueDrift(projectId, envId, userId)).toBe(false);

		// Complete the in-flight job → it leaves QUEUED/CLAIMED/PROCESSING → drops out of the index.
		await getServiceDb()
			.update(jobs)
			.set({ status: "SUCCESS" })
			.where(
				sql`${jobs.environment_id} = ${envId}::uuid and ${jobs.job_type} = 'DETECT_DRIFT'`,
			);

		expect(await enqueueDrift(projectId, envId, userId)).toBe(true); // re-drift allowed
		expect(await activeDriftCount(envId)).toBe(1); // one active again (the new one)
	});

	// ── 3. Connection-sweeper claim CAS ──────────────────────────────────────────

	/** Seed a due (never-tested) cloud identity; returns its id. */
	async function seedDueConnection(): Promise<string> {
		const userId = randomUUID();
		const [row] = await getServiceDb()
			.insert(cloudIdentities)
			.values({
				user_id: userId,
				org_id: userId,
				provider: "aws",
				name: `mr-sweep-${userId.slice(0, 8)}`,
				status: "connected",
				last_tested_at: null, // never tested ⇒ due
			})
			.returning({ id: cloudIdentities.id });
		seededCloudIds.push(row.id);
		return row.id;
	}

	it("sweep: two concurrent claims on the same due connection → exactly one wins", async () => {
		const id = await seedDueConnection();
		const [w1, w2] = await Promise.all([
			claimDueConnection(id),
			claimDueConnection(id),
		]);
		expect([w1, w2].filter(Boolean)).toHaveLength(1);

		// last_tested_at is now fresh → a subsequent claim within the TTL window is refused.
		expect(await claimDueConnection(id)).toBe(false);
	});

	it("sweep: a connection stale past the HEALTH TTL becomes claimable again", async () => {
		const id = await seedDueConnection();
		expect(await claimDueConnection(id)).toBe(true); // first claim flips last_tested_at
		expect(await claimDueConnection(id)).toBe(false); // fresh → refused

		// Age it past the 10-minute health TTL → due again → exactly one of two concurrent claims wins.
		await getServiceDb()
			.update(cloudIdentities)
			.set({ last_tested_at: sql`now() - interval '11 minutes'` })
			.where(eq(cloudIdentities.id, id));
		const [w1, w2] = await Promise.all([
			claimDueConnection(id),
			claimDueConnection(id),
		]);
		expect([w1, w2].filter(Boolean)).toHaveLength(1);
	});
});
