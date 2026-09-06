// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the two guards that close the destroy-vs-apply race, against real Postgres.
//
// The incident they encode actually happened, on a real Hetzner cluster. An apply was cancelled; the
// cancel never reached the runner, so tofu kept building and kept the state lock. The console had
// already flipped the job to CANCELLED, so nothing released that lock and nothing recorded what the
// runner was doing. A DESTROY queued to clean up was claimed anyway — per-org concurrency caps say
// nothing about two jobs on ONE state file — and died on "state already locked". The server the apply
// had created by then was never written to any state file: it billed on, invisible, until it was
// found by hand.
//
// Three things had to be true for that to happen, and each has a test here:
//   1. a job could be claimed while another job held its state lock   → state_object_busy (claim guard)
//   2. a killed tofu's lock was never released (stranded to its 3h TTL) → release_tofu_state_locks_for_job
//   3. a runner's report was DISCARDED when it contradicted a cancel   → update_job_status keeps the evidence
//
// These are plpgsql behaviours — a mocked db cannot test any of them, so this is an integration suite.

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	jobs,
	projectEnvironments,
	projects,
	runners,
	tofuStateLocks,
} from "@/lib/db/schema";
import {
	acquireStateLock,
	releaseStateLocksForJob,
	validateStateLock,
} from "@/lib/runners/state-lock";
import { describeIfDb } from "./db";

const USER = randomUUID();
const RUNNER_TOKEN = randomUUID();
const TOKEN_HASH = createHash("sha256").update(RUNNER_TOKEN).digest("hex");

let runnerId: string;
let projectId: string;
let envId: string;
let otherEnvId: string;

const db = () => getServiceDb();

/** Inserts a job on (projectId, env) and returns its id. */
async function seedJob(
	status: "QUEUED" | "PROCESSING",
	env: string | null,
	type: "DEPLOY" | "DESTROY" = "DEPLOY",
): Promise<string> {
	const [row] = await db()
		.insert(jobs)
		.values({
			user_id: USER,
			org_id: USER,
			job_type: type,
			status,
			project_id: projectId,
			environment_id: env,
			config_snapshot: {},
			requires_self_runner: false,
			...(status === "PROCESSING" ? { runner_id: runnerId } : {}),
		})
		.returning({ id: jobs.id });
	return row.id;
}

/** Runs the real claim RPC as our seeded self runner. Returns the claimed job id, or null. */
async function claim(): Promise<string | null> {
	const rows = await db().execute<{ id: string }>(
		sql`select id from claim_next_job(${runnerId}::uuid, ${TOKEN_HASH}, NULL)`,
	);
	return rows[0]?.id ?? null;
}

/** The runner's terminal status callback, through the real RPC. Returns `applied`. */
async function postStatus(
	jobId: string,
	status: string,
	metadata: Record<string, unknown> | null = null,
): Promise<boolean> {
	const [row] = await db().execute<{ applied: boolean }>(
		sql`select update_job_status(${runnerId}::uuid, ${TOKEN_HASH}, ${jobId}::uuid, ${status}, NULL,
		    ${metadata ? JSON.stringify(metadata) : null}::jsonb) as applied`,
	);
	return !!row?.applied;
}

async function readJob(jobId: string) {
	const [row] = await db()
		.select({
			status: jobs.status,
			execution_metadata: jobs.execution_metadata,
		})
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);
	return row;
}

describeIfDb("per-state-object job serialization", () => {
	beforeAll(async () => {
		// A SELF runner: its claim branch is uncapped, so nothing but the new guard bounds concurrency
		// on one state object — the sharpest place to test it.
		const [r] = await db()
			.insert(runners)
			.values({
				user_id: USER,
				org_id: USER,
				name: `it-serialize-${randomUUID().slice(0, 8)}`,
				operator: "self",
				provisioning: "registered",
				status: "ONLINE",
				token_hash: TOKEN_HASH,
			})
			.returning({ id: runners.id });
		runnerId = r.id;

		const [p] = await db()
			.insert(projects)
			.values({
				user_id: USER,
				project_name: "serialize-test",
				region: "eu-central-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectId = p.id;

		const [e] = await db()
			.insert(projectEnvironments)
			.values({ project_id: projectId, user_id: USER, name: "prod", status: "DRAFT", is_default: true })
			.returning({ id: projectEnvironments.id });
		envId = e.id;

		const [e2] = await db()
			.insert(projectEnvironments)
			.values({ project_id: projectId, user_id: USER, name: "staging", status: "DRAFT", is_default: false })
			.returning({ id: projectEnvironments.id });
		otherEnvId = e2.id;
	});

	beforeEach(async () => {
		// Each test owns the queue and the lock table for this project.
		await db().delete(tofuStateLocks).where(sql`job_id in (select id from jobs where project_id = ${projectId}::uuid)`);
		await db().delete(jobs).where(eq(jobs.project_id, projectId));
	});

	afterAll(async () => {
		await db().delete(tofuStateLocks).where(sql`job_id in (select id from jobs where project_id = ${projectId}::uuid)`);
		await db().delete(jobs).where(eq(jobs.project_id, projectId));
		await db().delete(projectEnvironments).where(eq(projectEnvironments.project_id, projectId));
		await db().delete(projects).where(eq(projects.id, projectId));
		await db().delete(runners).where(eq(runners.id, runnerId));
	});

	// ── THE INCIDENT ────────────────────────────────────────────────────────────────────────────────
	it("does NOT claim a DESTROY while an apply holds that environment's state lock", async () => {
		const apply = await seedJob("PROCESSING", envId);
		const lockId = randomUUID();
		expect(
			(await acquireStateLock(`projects/${projectId}/${envId}/tofu.tfstate`, lockId, apply, { ID: lockId })).acquired,
		).toBe(true);

		// The destroy queued to clean up while the apply is still building.
		const destroy = await seedJob("QUEUED", envId, "DESTROY");

		// Before the fix this was claimed, ran tofu, and died on "state already locked" — after the
		// apply had already created (and then lost) real servers.
		expect(await claim()).toBeNull();

		// It is not lost, only held back: it stays QUEUED and is re-offered on the next poll.
		expect((await readJob(destroy))?.status).toBe("QUEUED");
	});

	// ── AND IT MUST NOT DEADLOCK ────────────────────────────────────────────────────────────────────
	// The guard is only safe because a killed tofu's lock is now released the moment its job goes
	// terminal. Without that, a stranded lock would block the very DESTROY sent to clean it up — a
	// strictly worse failure than the one being fixed, and silent for three hours.
	it("claims the DESTROY once the dead apply's lock is released on its terminal report", async () => {
		const apply = await seedJob("PROCESSING", envId);
		const lockId = randomUUID();
		const stateKey = `projects/${projectId}/${envId}/tofu.tfstate`;
		await acquireStateLock(stateKey, lockId, apply, { ID: lockId });
		const destroy = await seedJob("QUEUED", envId, "DESTROY");
		expect(await claim()).toBeNull(); // blocked, as above

		// The apply's runner reports terminal: tofu has exited, so no writer is left on this state.
		expect(await releaseStateLocksForJob(apply)).toBe(1);

		expect(await claim()).toBe(destroy);
	});

	it("fences the dead apply's lock id rather than deleting the row (a zombie writer cannot write)", async () => {
		const apply = await seedJob("PROCESSING", envId);
		const lockId = randomUUID();
		const stateKey = `projects/${projectId}/${envId}/tofu.tfstate`;
		await acquireStateLock(stateKey, lockId, apply, { ID: lockId });
		const [before] = await db()
			.select({ generation: tofuStateLocks.generation })
			.from(tofuStateLocks)
			.where(eq(tofuStateLocks.state_key, stateKey));

		await releaseStateLocksForJob(apply);

		// The old holder's id no longer validates — a tofu that somehow survived cannot complete a write.
		expect(await validateStateLock(stateKey, lockId)).toBe(false);
		const [after] = await db()
			.select({ generation: tofuStateLocks.generation })
			.from(tofuStateLocks)
			.where(eq(tofuStateLocks.state_key, stateKey));
		expect(after.generation).toBe(before.generation + 1);
	});

	// ── AND IT MUST NOT OVER-BLOCK ──────────────────────────────────────────────────────────────────
	it("still claims a job on a DIFFERENT environment of the same project", async () => {
		const apply = await seedJob("PROCESSING", envId);
		const lockId = randomUUID();
		await acquireStateLock(`projects/${projectId}/${envId}/tofu.tfstate`, lockId, apply, { ID: lockId });

		const other = await seedJob("QUEUED", otherEnvId); // a different state object entirely
		expect(await claim()).toBe(other);
	});

	it("ignores an EXPIRED lock (the TTL stays a safety valve, not a permanent block)", async () => {
		const apply = await seedJob("PROCESSING", envId);
		const lockId = randomUUID();
		const stateKey = `projects/${projectId}/${envId}/tofu.tfstate`;
		await acquireStateLock(stateKey, lockId, apply, { ID: lockId });
		await db()
			.update(tofuStateLocks)
			.set({ expires_at: sql`now() - interval '1 minute'` })
			.where(eq(tofuStateLocks.state_key, stateKey));

		const next = await seedJob("QUEUED", envId, "DESTROY");
		expect(await claim()).toBe(next);
	});

	it("does not serialize a job that holds the lock itself (a re-claim is not self-blocking)", async () => {
		// A job's own lock must never bar it: the guard excludes the candidate's own id.
		const job = await seedJob("QUEUED", envId);
		const lockId = randomUUID();
		await acquireStateLock(`projects/${projectId}/${envId}/tofu.tfstate`, lockId, job, { ID: lockId });
		expect(await claim()).toBe(job);
	});
});

// ── THE EVIDENCE MUST SURVIVE ───────────────────────────────────────────────────────────────────────
describeIfDb("update_job_status keeps a contradicting runner report", () => {
	beforeAll(async () => {
		const [r] = await db()
			.insert(runners)
			.values({
				user_id: USER,
				org_id: USER,
				name: `it-evidence-${randomUUID().slice(0, 8)}`,
				operator: "self",
				provisioning: "registered",
				status: "ONLINE",
				token_hash: TOKEN_HASH,
			})
			.returning({ id: runners.id });
		runnerId = r.id;
		const [p] = await db()
			.insert(projects)
			.values({
				user_id: USER,
				project_name: "evidence-test",
				region: "eu-central-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectId = p.id;
		const [e] = await db()
			.insert(projectEnvironments)
			.values({ project_id: projectId, user_id: USER, name: "prod", status: "DRAFT", is_default: true })
			.returning({ id: projectEnvironments.id });
		envId = e.id;
	});

	afterAll(async () => {
		await db().delete(jobs).where(eq(jobs.project_id, projectId));
		await db().delete(projectEnvironments).where(eq(projectEnvironments.project_id, projectId));
		await db().delete(projects).where(eq(projects.id, projectId));
		await db().delete(runners).where(eq(runners.id, runnerId));
	});

	// The cancel never reached the runner, so it ran the apply out and reported FAILED into a job the
	// console had already flipped to CANCELLED. The terminal guard rightly refuses the status CHANGE —
	// but it used to reject the whole UPDATE row, execution_metadata included, so the runner's account
	// of what it had built was thrown away. That is why the stranded server was invisible: the job's
	// execution_metadata was NULL, and orphan_risk had nowhere to land.
	it("preserves the metadata of a report that contradicts a cancel, and flags orphan_risk", async () => {
		const job = await seedJob("PROCESSING", envId);
		await db().update(jobs).set({ status: "CANCELLED" }).where(eq(jobs.id, job));

		const applied = await postStatus(job, "FAILED", {
			resources_created: ["hcloud_server.control_plane"],
		});

		// The status change is still refused — CANCELLED sticks, and side-effects stay skipped.
		expect(applied).toBe(false);
		const row = await readJob(job);
		expect(row?.status).toBe("CANCELLED");

		// But the evidence lives. This is the whole point.
		const meta = row?.execution_metadata as Record<string, unknown>;
		expect(meta).toBeTruthy();
		expect(meta.resources_created).toEqual(["hcloud_server.control_plane"]);
		expect(meta.orphan_risk).toBe(true);
		expect(meta.orphan_reason).toBe("ran_to_completion_after_cancel");
		expect((meta.late_report as Record<string, unknown>)?.status).toBe("FAILED");
	});

	it("does not flag orphan_risk when the runner merely re-posts the same terminal status", async () => {
		// The runner's own CANCELLED teardown post is a SAME-status re-post: it applies normally and is
		// not an orphan signal. Only a runner reporting it FINISHED a job the console cancelled is.
		const job = await seedJob("PROCESSING", envId);
		await db().update(jobs).set({ status: "CANCELLED" }).where(eq(jobs.id, job));

		expect(await postStatus(job, "CANCELLED", { teardown: "clean" })).toBe(true);
		const meta = (await readJob(job))?.execution_metadata as Record<string, unknown>;
		expect(meta.teardown).toBe("clean");
		expect(meta.orphan_risk).toBeUndefined();
	});
});
