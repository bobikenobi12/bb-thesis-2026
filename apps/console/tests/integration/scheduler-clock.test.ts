// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres) for the scheduler clock contract (#1783).
//
// The cadence sweeps read `jobs.created_at` back and ask "is this older than the tier cadence?".
// That column is stamped by the DATABASE (`defaultNow()`) and must stay that way — the org 24h
// quota and the retention GC range-scan it against the database's `now()`, and the claim queue
// orders by it. So the comparison has to be made against the database's clock too. Measuring a
// DB-written timestamp against this replica's `new Date()` is two clocks, and they are free to
// drift apart.
//
// These tests are non-vacuous by construction: they SKEW THE APPLICATION CLOCK away from the
// database's (fake timers fake `Date` in this process only — Postgres keeps real time), then assert
// the sweep still decides correctly. A sweep that reverted to `new Date()` would read the skewed
// clock and decide the opposite way, so each test fails on the regression it exists to catch.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { getServiceDb } from "@/lib/db";
import { dbNow } from "@/lib/db/now";
import { jobs, projectEnvironments, projects } from "@/lib/db/schema";
import { sweepDriftSchedule } from "@/lib/drift/dispatch";
import { DRIFT_CADENCE_MS } from "@/lib/drift/schedule";
import { sweepProbeSchedule } from "@/lib/probes/dispatch";
import { PROBE_CADENCE_MS } from "@/lib/probes/schedule";
import { defaultIfFirst, describeIfDb } from "./db";

const USER = randomUUID();
const ORG = randomUUID();
const db = getServiceDb();

async function seedEnv(
	projectId: string,
	name: string,
	stage: "development" | "production",
): Promise<string> {
	const [e] = await db
		.insert(projectEnvironments)
		.values({
			project_id: projectId,
			user_id: USER,
			org_id: ORG,
			name,
			status: "ACTIVE",
			stage,
			is_default: defaultIfFirst(projectId),
		})
		.returning({ id: projectEnvironments.id });
	return e.id;
}

type SweptJobType = "DEPLOY" | "DETECT_DRIFT" | "PROBE_CLUSTER";

async function seedJob(
	projectId: string,
	envId: string,
	jobType: SweptJobType,
	createdAt: Date,
): Promise<void> {
	await db.insert(jobs).values({
		user_id: USER,
		org_id: ORG,
		project_id: projectId,
		environment_id: envId,
		job_type: jobType,
		status: "SUCCESS",
		config_snapshot: { seed: true },
		created_at: createdAt,
	});
}

async function countJobs(envId: string, jobType: SweptJobType): Promise<number> {
	const rows = await db
		.select({ id: jobs.id })
		.from(jobs)
		.where(and(eq(jobs.environment_id, envId), eq(jobs.job_type, jobType)));
	return rows.length;
}

/** Move THIS PROCESS's `Date` by `ms`, leaving real timers (and Postgres) alone. */
function skewAppClock(from: Date, ms: number): void {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(from.getTime() + ms));
}

describeIfDb("scheduler clock contract — the sweeps measure against the database", () => {
	let projectId: string;

	beforeAll(async () => {
		const [p] = await db
			.insert(projects)
			.values({
				user_id: USER,
				org_id: ORG,
				project_name: "scheduler-clock",
				region: "us-east-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectId = p.id;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	afterAll(async () => {
		await db.delete(jobs).where(eq(jobs.user_id, USER));
		await db.delete(projectEnvironments).where(eq(projectEnvironments.project_id, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	});

	it("dbNow returns the database's clock, not this process's", async () => {
		const real = await dbNow(db);
		expect(real).toBeInstanceOf(Date);

		// Shift the app clock a decade back. The database is unaffected, so a second read must still
		// land near the first — which is what makes it a different clock from `new Date()`.
		skewAppClock(real, -10 * 365 * 24 * 3_600_000);
		const afterSkew = await dbNow(db);
		expect(Math.abs(afterSkew.getTime() - real.getTime())).toBeLessThan(60_000);
		expect(afterSkew.getTime() - Date.now()).toBeGreaterThan(365 * 24 * 3_600_000);
	});

	it("enqueues a drift check that is due by the DB clock even when the app clock says it is not", async () => {
		const at = await dbNow(db);
		const env = await seedEnv(projectId, `drift-skew-${randomUUID().slice(0, 8)}`, "development");
		await seedJob(projectId, env, "DEPLOY", new Date(at.getTime() - 3_600_000));
		// Last check is one minute past the dev cadence → DUE by the database's clock.
		await seedJob(
			projectId,
			env,
			"DETECT_DRIFT",
			new Date(at.getTime() - (DRIFT_CADENCE_MS.dev + 60_000)),
		);
		expect(await countJobs(env, "DETECT_DRIFT")).toBe(1);

		// Rewind the app clock two cadences. Read through THAT clock the last check is in the
		// future, so a sweep using `new Date()` would enqueue nothing.
		skewAppClock(at, -2 * DRIFT_CADENCE_MS.dev);

		await sweepDriftSchedule();

		expect(await countJobs(env, "DETECT_DRIFT")).toBe(2);
	});

	it("skips a drift check that is NOT due by the DB clock even when the app clock says it is", async () => {
		const at = await dbNow(db);
		const env = await seedEnv(projectId, `drift-fresh-${randomUUID().slice(0, 8)}`, "development");
		await seedJob(projectId, env, "DEPLOY", new Date(at.getTime() - 3_600_000));
		// Checked a minute ago → NOT due by the database's clock.
		await seedJob(projectId, env, "DETECT_DRIFT", new Date(at.getTime() - 60_000));

		// Fast-forward the app clock two cadences: through that clock it looks long overdue.
		skewAppClock(at, 2 * DRIFT_CADENCE_MS.dev);

		await sweepDriftSchedule();

		expect(await countJobs(env, "DETECT_DRIFT")).toBe(1);
	});

	it("holds the same contract for the probe sweeper", async () => {
		const at = await dbNow(db);
		const env = await seedEnv(projectId, `probe-skew-${randomUUID().slice(0, 8)}`, "production");
		await seedJob(projectId, env, "DEPLOY", new Date(at.getTime() - 3_600_000));
		await seedJob(
			projectId,
			env,
			"PROBE_CLUSTER",
			new Date(at.getTime() - (PROBE_CADENCE_MS.prod + 60_000)),
		);
		expect(await countJobs(env, "PROBE_CLUSTER")).toBe(1);

		skewAppClock(at, -2 * PROBE_CADENCE_MS.prod);

		await sweepProbeSchedule();

		expect(await countJobs(env, "PROBE_CLUSTER")).toBe(2);
	});
});
