// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres) for BYOC B2.3 — the console-side of the live cluster-alive signal:
//   • sweepProbeSchedule — enqueues a PROBE_CLUSTER job per DUE ACTIVE env (cloned from drift
//     dispatch), on the probe cadence; only ACTIVE envs with a successful DEPLOY; never double-
//     enqueues while a probe is in flight; respects the per-tier cadence.
//   • recordProbeResult — appends an environment_probes history row and reports true→false only.
//   • getLatestProbesByEnv — reads the latest row per env (newest-first).
// These prove the real SQL (partial-status filters, ordering, org-join) that mocked units hide.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, expect, it } from "vitest";
import {
	getLatestProbesByEnv,
	recordProbeResult,
} from "@/lib/probes/persistence";
import { getServiceDb } from "@/lib/db";
import {
	environmentProbes,
	jobs,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import type { ProjectStatus } from "@/lib/db/schema/enums";
import { PROBE_CADENCE_MS } from "@/lib/probes/schedule";
import { sweepProbeSchedule } from "@/lib/probes/dispatch";
import { defaultIfFirst, describeIfDb } from "./db";

const USER = randomUUID();
const ORG = randomUUID();
const db = getServiceDb();

async function seedEnv(
	projectId: string,
	name: string,
	status: ProjectStatus,
	stage: "development" | "staging" | "production",
): Promise<string> {
	const [e] = await db
		.insert(projectEnvironments)
		.values({
			project_id: projectId,
			user_id: USER,
			org_id: ORG,
			name,
			status,
			stage,
			is_default: defaultIfFirst(projectId),
		})
		.returning({ id: projectEnvironments.id });
	return e.id;
}

async function seedJob(
	projectId: string,
	envId: string,
	jobType: "DEPLOY" | "PROBE_CLUSTER",
	status: "QUEUED" | "PROCESSING" | "SUCCESS" | "FAILED",
	createdAt: Date,
): Promise<string> {
	const [j] = await db
		.insert(jobs)
		.values({
			user_id: USER,
			org_id: ORG,
			project_id: projectId,
			environment_id: envId,
			job_type: jobType,
			status,
			config_snapshot: { seed: true },
			created_at: createdAt,
		})
		.returning({ id: jobs.id });
	return j.id;
}

async function probeJobCount(envId: string): Promise<number> {
	const rows = await db
		.select({ id: jobs.id })
		.from(jobs)
		.where(and(eq(jobs.environment_id, envId), eq(jobs.job_type, "PROBE_CLUSTER")));
	return rows.length;
}

describeIfDb("BYOC B2.3 probe dispatch + ingest + query — real Postgres", () => {
	let projectId: string;
	const now = new Date("2026-07-14T12:00:00Z");
	const ago = (ms: number) => new Date(now.getTime() - ms);

	beforeAll(async () => {
		const [p] = await db
			.insert(projects)
			.values({
				user_id: USER,
				org_id: ORG,
				project_name: "b23-probe",
				region: "us-east-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectId = p.id;
	});

	afterAll(async () => {
		await db.delete(environmentProbes).where(eq(environmentProbes.project_id, projectId));
		await db.delete(jobs).where(eq(jobs.user_id, USER));
		await db.delete(projectEnvironments).where(eq(projectEnvironments.project_id, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	});

	it("enqueues a PROBE_CLUSTER for a never-probed ACTIVE env with a successful DEPLOY", async () => {
		const env = await seedEnv(projectId, "probe-new", "ACTIVE", "production");
		await seedJob(projectId, env, "DEPLOY", "SUCCESS", ago(60_000));

		const { enqueued } = await sweepProbeSchedule(now);
		expect(enqueued).toBeGreaterThanOrEqual(1);
		expect(await probeJobCount(env)).toBe(1);
	});

	it("does NOT probe a non-ACTIVE env, nor one without a successful DEPLOY", async () => {
		// DESTROYED env with a past DEPLOY — no live cluster to dial.
		const destroyed = await seedEnv(projectId, "probe-destroyed", "DESTROYED", "production");
		await seedJob(projectId, destroyed, "DEPLOY", "SUCCESS", ago(60_000));
		// ACTIVE env that never deployed successfully — nothing to locate state for.
		const neverDeployed = await seedEnv(projectId, "probe-nodeploy", "ACTIVE", "production");

		await sweepProbeSchedule(now);
		expect(await probeJobCount(destroyed)).toBe(0);
		expect(await probeJobCount(neverDeployed)).toBe(0);
	});

	it("does NOT double-enqueue while a probe is in flight, and respects per-tier cadence", async () => {
		// In-flight probe (QUEUED) → excluded even though it's an ACTIVE deployed env.
		const inflight = await seedEnv(projectId, "probe-inflight", "ACTIVE", "production");
		await seedJob(projectId, inflight, "DEPLOY", "SUCCESS", ago(60_000));
		await seedJob(projectId, inflight, "PROBE_CLUSTER", "QUEUED", ago(30_000));

		// Fresh prod probe (5m ago < 10m cadence) → not due.
		const fresh = await seedEnv(projectId, "probe-fresh", "ACTIVE", "production");
		await seedJob(projectId, fresh, "DEPLOY", "SUCCESS", ago(60_000));
		await seedJob(projectId, fresh, "PROBE_CLUSTER", "SUCCESS", ago(5 * 60_000));

		// Stale prod probe (past 10m cadence) → due.
		const stale = await seedEnv(projectId, "probe-stale", "ACTIVE", "production");
		await seedJob(projectId, stale, "DEPLOY", "SUCCESS", ago(60_000));
		await seedJob(
			projectId,
			stale,
			"PROBE_CLUSTER",
			"SUCCESS",
			ago(PROBE_CADENCE_MS.prod + 60_000),
		);

		await sweepProbeSchedule(now);

		expect(await probeJobCount(inflight)).toBe(1); // still just the in-flight one
		expect(await probeJobCount(fresh)).toBe(1); // unchanged — not due
		expect(await probeJobCount(stale)).toBe(2); // the stale one + a fresh enqueue
	});

	it("recordProbeResult appends history + flags true→false ONLY on the transition", async () => {
		const env = await seedEnv(projectId, "probe-record", "ACTIVE", "production");

		// First-ever probe reachable=false → NOT a transition (never proven alive).
		const r1 = await recordProbeResult({
			projectId,
			environmentId: env,
			reachable: false,
			message: "cold start",
			probedAt: ago(40_000).toISOString(),
		});
		expect(r1.becameUnreachable).toBe(false);

		// false→true (recovery) → no alert.
		const r2 = await recordProbeResult({
			projectId,
			environmentId: env,
			reachable: true,
			probedAt: ago(30_000).toISOString(),
		});
		expect(r2.becameUnreachable).toBe(false);

		// true→true (healthy) → no alert.
		const r3 = await recordProbeResult({
			projectId,
			environmentId: env,
			reachable: true,
			probedAt: ago(20_000).toISOString(),
		});
		expect(r3.becameUnreachable).toBe(false);

		// true→false (went dark) → ALERT.
		const r4 = await recordProbeResult({
			projectId,
			environmentId: env,
			reachable: false,
			message: "dial timeout",
			probedAt: ago(10_000).toISOString(),
		});
		expect(r4.becameUnreachable).toBe(true);

		// false→false (still down) → no re-alert.
		const r5 = await recordProbeResult({
			projectId,
			environmentId: env,
			reachable: false,
			probedAt: now.toISOString(),
		});
		expect(r5.becameUnreachable).toBe(false);

		// Append-only: five rows persisted.
		const rows = await db
			.select({ id: environmentProbes.id })
			.from(environmentProbes)
			.where(eq(environmentProbes.environment_id, env));
		expect(rows.length).toBe(5);
	});

	it("getLatestProbesByEnv returns the newest row per env, org-scoped", async () => {
		const env = await seedEnv(projectId, "probe-latest", "ACTIVE", "production");
		await recordProbeResult({
			projectId,
			environmentId: env,
			reachable: true,
			message: "old ok",
			probedAt: ago(60_000).toISOString(),
		});
		await recordProbeResult({
			projectId,
			environmentId: env,
			reachable: false,
			message: "latest down",
			probedAt: now.toISOString(),
		});

		const byEnv = await getLatestProbesByEnv(projectId, ORG);
		const latest = byEnv.get(env);
		expect(latest?.reachable).toBe(false);
		expect(latest?.message).toBe("latest down");

		// Wrong org → nothing (the project-join org filter is the tenancy wall).
		const wrongOrg = await getLatestProbesByEnv(projectId, randomUUID());
		expect(wrongOrg.get(env)).toBeUndefined();
	});
});
