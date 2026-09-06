// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres) for the BYO-IaC "CONTINUOUS, not one-shot" claim (#845).
//
// #845 asks for "customer tofu to Fabric, CONTINUOUS not one-shot". There is no CONTINUOUS mode in
// the codebase — no apply_mode, no such enum, no git-following trigger. What genuinely exists, and
// what this file pins, is the pair the product can honestly claim:
//
//   (a) UNATTENDED DRIFT RE-PROVING over the pinned commit — sweepDriftSchedule copies the last
//       successful DEPLOY's snapshot verbatim, so a BYO env's `iac_source` (repo, ref, path, AND
//       commit_sha) rides along into every scheduled DETECT_DRIFT, forever, on a tiered cadence.
//   (b) OPT-IN AUTO-HEAL RE-APPLY of that same pinned commit — maybeAutoHeal re-enqueues a DEPLOY
//       from the last successful DEPLOY snapshot when drift is reported.
//
// What is NOT claimed, and has no code: noticing a NEW upstream commit. `commit_sha` only advances
// via a user-triggered IAC_SCAN, so (a) and (b) re-prove and re-apply the SAME commit forever.
// A test asserting otherwise would be asserting a feature that does not exist.
//
// Why integration and not units: sweepDriftSchedule had NO test of any kind, and NONE of
// maybeAutoHeal's guards were covered. Both are SQL-shaped — a partial unique index, a status
// filter, a stage join, a snapshot copy — which mocked units hide by construction. The one guard
// that matters most is the PRODUCTION EXCLUSION: a regression there auto-applies to production.

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import { finalizeDeployment } from "@/lib/jobs/finalize-deployment";
import { maybeAutoHeal } from "@/app/server/actions/reconcile";
import { getServiceDb } from "@/lib/db";
import {
	jobs,
	projectEnvironments,
	projectFabrics,
	projectIacSources,
	projects,
} from "@/lib/db/schema";
import type { ProvisionJobType } from "@/lib/db/schema/enums";
import { sweepDriftSchedule } from "@/lib/drift/dispatch";
import { DRIFT_CADENCE_MS } from "@/lib/drift/schedule";
import { verifySnapshot } from "@/lib/runners/snapshot-sig";
import { defaultIfFirst, describeIfDb } from "./db";

const USER = randomUUID();
const ORG = randomUUID();
const db = getServiceDb();

const PINNED_SHA = "1111111111111111111111111111111111111111";

/** A BYO-IaC config snapshot: what buildConfigSnapshot emits for an env with an enabled source. */
function byoSnapshot(commitSha = PINNED_SHA) {
	return {
		id: "e2e-byo",
		project_name: "byo-continuous",
		iac_source: {
			repo_url: "https://github.com/acme/infra",
			ref: "main",
			path: "envs/dev",
			commit_sha: commitSha,
			var_values: { size: "small" },
		},
	};
}

describeIfDb("BYO-IaC continuous re-proving + reconcile — real Postgres", () => {
	let projectId: string;
	let fabricId: string;
	const now = new Date("2026-08-02T12:00:00Z");
	const ago = (ms: number) => new Date(now.getTime() - ms);

	async function seedEnv(
		name: string,
		stage: "development" | "staging" | "production",
		overrides: Partial<typeof projectEnvironments.$inferInsert> = {},
	): Promise<string> {
		const [e] = await db
			.insert(projectEnvironments)
			.values({
				project_id: projectId,
				user_id: USER,
				org_id: ORG,
				name,
				stage,
				status: "ACTIVE",
				fabric_id: fabricId,
				is_default: defaultIfFirst(projectId),
				...overrides,
			})
			.returning({ id: projectEnvironments.id });
		return e.id;
	}

	async function seedJob(
		envId: string,
		jobType: "DEPLOY" | "DETECT_DRIFT" | "DESTROY",
		status: "QUEUED" | "PROCESSING" | "SUCCESS" | "FAILED",
		createdAt: Date,
		snapshot: unknown = byoSnapshot(),
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
				config_snapshot: snapshot as never,
				created_at: createdAt,
			})
			.returning({ id: jobs.id });
		return j.id;
	}

	async function jobsOfType(envId: string, jobType: ProvisionJobType) {
		return db
			.select({
				id: jobs.id,
				config_snapshot: jobs.config_snapshot,
				config_snapshot_sig: jobs.config_snapshot_sig,
				created_at: jobs.created_at,
			})
			.from(jobs)
			.where(and(eq(jobs.environment_id, envId), eq(jobs.job_type, jobType)))
			.orderBy(desc(jobs.created_at));
	}

	/** The iac_source object off an enqueued job's snapshot. */
	function iacOf(snapshot: unknown): Record<string, unknown> | undefined {
		return (snapshot as { iac_source?: Record<string, unknown> })?.iac_source;
	}

	beforeAll(async () => {
		const [p] = await db
			.insert(projects)
			.values({
				user_id: USER,
				org_id: ORG,
				project_name: "byo-continuous",
				region: "us-east-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectId = p.id;

		const [f] = await db
			.insert(projectFabrics)
			.values({ project_id: projectId, user_id: USER, org_id: ORG, name: "shared" })
			.returning({ id: projectFabrics.id });
		fabricId = f.id;
	});

	afterAll(async () => {
		await db.delete(jobs).where(eq(jobs.user_id, USER));
		await db.delete(projectIacSources).where(eq(projectIacSources.project_id, projectId));
		await db.delete(projectEnvironments).where(eq(projectEnvironments.project_id, projectId));
		await db.delete(projectFabrics).where(eq(projectFabrics.project_id, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	});

	// Each test seeds its own env; clear the job table between them so a sweep only ever sees the
	// rows the test under it created (sweepDriftSchedule is global by design).
	beforeEach(async () => {
		await db.delete(jobs).where(eq(jobs.user_id, USER));
	});

	// ── (a) Continuous drift re-proving over the PINNED commit ────────────────────────────────

	it("carries the BYO iac_source — including the SAME pinned commit — into the scheduled drift job", async () => {
		const env = await seedEnv("byo-dev-carry", "development");
		await seedJob(env, "DEPLOY", "SUCCESS", ago(DRIFT_CADENCE_MS.dev * 2));

		const { enqueued } = await sweepDriftSchedule(now);
		expect(enqueued).toBeGreaterThanOrEqual(1);

		const drifts = await jobsOfType(env, "DETECT_DRIFT");
		expect(drifts).toHaveLength(1);

		// The whole BYO claim: the customer's module descriptor survives the copy intact. If any of
		// this were dropped, the drift run would re-plan the built-in template instead of their module.
		const iac = iacOf(drifts[0].config_snapshot);
		expect(iac).toEqual(byoSnapshot().iac_source);
		// Called out separately because it is the "continuous over the PINNED commit, not a moving
		// ref" property — the one thing that distinguishes this from git-following, which we do not have.
		expect(iac?.commit_sha).toBe(PINNED_SHA);
	});

	it("signs the copied snapshot, so the runner's claim endpoint will accept the drift job", async () => {
		// Snapshot signing is OFF unless ALETHIA_SNAPSHOT_HMAC_KEY is set (a deliberate back-compat
		// rollout: no key ⇒ sig null and verify is a no-op). Turn it ON for this test rather than
		// asserting whatever the CI environment happens to be configured with — otherwise this
		// passes vacuously wherever signing is disabled, which is precisely where the bug would be.
		vi.stubEnv("ALETHIA_SNAPSHOT_HMAC_KEY", "test-hmac-key-for-drift-signing");

		const env = await seedEnv("byo-dev-sig", "development");
		await seedJob(env, "DEPLOY", "SUCCESS", ago(DRIFT_CADENCE_MS.dev * 2));

		await sweepDriftSchedule(now);
		const [drift] = await jobsOfType(env, "DETECT_DRIFT");

		// A drift job whose stored signature does not match its snapshot is rejected at claim time —
		// a silently dead loop that still reads as "scheduling works".
		expect(drift.config_snapshot_sig).toBeTruthy();
		expect(verifySnapshot(drift.config_snapshot, drift.config_snapshot_sig)).toBe(true);

		// And the signature must actually be OVER this snapshot: a signature that verifies against
		// anything is not a signature.
		expect(verifySnapshot({ tampered: true }, drift.config_snapshot_sig)).toBe(false);
	});

	it("honours the per-tier cadence through the real dispatch, not just the pure selector", async () => {
		const env = await seedEnv("byo-prod-cadence", "production");
		// 5h since the last check: inside production's 6h cadence.
		await seedJob(env, "DEPLOY", "SUCCESS", ago(DRIFT_CADENCE_MS.prod * 2));
		await seedJob(env, "DETECT_DRIFT", "SUCCESS", ago(5 * 3_600_000));

		await sweepDriftSchedule(now);
		expect(await jobsOfType(env, "DETECT_DRIFT")).toHaveLength(1); // unchanged

		// 7h since the last check: past the cadence. This proves dispatch really joins
		// project_environments.stage — the pure selector cannot show that.
		await db.delete(jobs).where(and(eq(jobs.environment_id, env), eq(jobs.job_type, "DETECT_DRIFT")));
		await seedJob(env, "DETECT_DRIFT", "SUCCESS", ago(7 * 3_600_000));

		await sweepDriftSchedule(now);
		expect(await jobsOfType(env, "DETECT_DRIFT")).toHaveLength(2);
	});

	it("never double-enqueues while a drift job is in flight, even under concurrent sweeps", async () => {
		const env = await seedEnv("byo-dev-stampede", "development");
		await seedJob(env, "DEPLOY", "SUCCESS", ago(DRIFT_CADENCE_MS.dev * 2));
		await seedJob(env, "DETECT_DRIFT", "PROCESSING", ago(DRIFT_CADENCE_MS.dev * 2));

		// Two replicas sweeping at once. The in-flight filter plus the uq_jobs_active_drift_per_env
		// partial unique index must both hold; `enqueued` must count only rows that actually landed.
		const [a, b] = await Promise.all([sweepDriftSchedule(now), sweepDriftSchedule(now)]);

		const drifts = await jobsOfType(env, "DETECT_DRIFT");
		expect(drifts).toHaveLength(1); // still just the in-flight one
		expect(a.enqueued + b.enqueued).toBe(0);
	});

	it("re-proves AGAIN on the next cadence — two cycles is the minimum honest meaning of 'continuous'", async () => {
		const env = await seedEnv("byo-dev-repeat", "development");
		await seedJob(env, "DEPLOY", "SUCCESS", ago(DRIFT_CADENCE_MS.dev * 3));

		await sweepDriftSchedule(now);
		const first = await jobsOfType(env, "DETECT_DRIFT");
		expect(first).toHaveLength(1);

		// Complete the first check and advance past the cadence.
		//
		// `created_at` MUST be pinned to the simulated clock, not left at the database's now().
		// sweepDriftSchedule stamps the row it inserts with the DB's wall clock, while the cadence
		// comparison below advances `now` — so leaving it implicit puts two different clocks in one
		// assertion and the test passes only while real time happens to sit far enough behind
		// `now`. With a 7-day dev cadence that made it green before 13:00 UTC on 2026-08-02 and red
		// for every run after, on every branch at once (#1783). One clock, always.
		await db
			.update(jobs)
			.set({ status: "SUCCESS", created_at: now })
			.where(eq(jobs.id, first[0].id));
		const later = new Date(now.getTime() + DRIFT_CADENCE_MS.dev + 3_600_000);

		await sweepDriftSchedule(later);
		const second = await jobsOfType(env, "DETECT_DRIFT");
		expect(second).toHaveLength(2);
		// The second cycle still carries the customer's module at the same pinned commit — this is
		// what "not one-shot" actually means for BYO-IaC.
		expect(iacOf(second[0].config_snapshot)?.commit_sha).toBe(PINNED_SHA);
	});

	// ── (b) Auto-heal re-apply — every guard, none of which had coverage ──────────────────────

	it("does NOT auto-heal when auto_heal is off (the default posture)", async () => {
		const env = await seedEnv("byo-heal-off", "development", { auto_heal: false });
		await seedJob(env, "DEPLOY", "SUCCESS", ago(60_000));

		await maybeAutoHeal(projectId, env);
		expect(await jobsOfType(env, "DEPLOY")).toHaveLength(1); // only the seed
	});

	it("NEVER auto-heals production, even with auto_heal on", async () => {
		// The single worst failure mode in this file: a regression here auto-applies to production
		// without approval. Production drift is surfaced for a human, never re-applied.
		const env = await seedEnv("byo-heal-prod", "production", { auto_heal: true });
		await seedJob(env, "DEPLOY", "SUCCESS", ago(60_000));

		await maybeAutoHeal(projectId, env);
		expect(await jobsOfType(env, "DEPLOY")).toHaveLength(1);
	});

	it("re-applies the SAME pinned commit when auto_heal is on for a non-prod env", async () => {
		const env = await seedEnv("byo-heal-on", "development", { auto_heal: true });
		await seedJob(env, "DEPLOY", "SUCCESS", ago(60_000));

		await maybeAutoHeal(projectId, env);

		const deploys = await jobsOfType(env, "DEPLOY");
		expect(deploys).toHaveLength(2);
		// The healer re-applies the customer's module at the commit already deployed — never a newer
		// scan, and never a pending config edit. That is the honest boundary of "continuous reconcile".
		expect(iacOf(deploys[0].config_snapshot)).toEqual(byoSnapshot().iac_source);
		expect(iacOf(deploys[0].config_snapshot)?.commit_sha).toBe(PINNED_SHA);
	});

	it("stops after the circuit breaker trips", async () => {
		const env = await seedEnv("byo-heal-breaker", "development", {
			auto_heal: true,
			auto_heal_failures: 3,
		});
		await seedJob(env, "DEPLOY", "SUCCESS", ago(60_000));

		await maybeAutoHeal(projectId, env);
		expect(await jobsOfType(env, "DEPLOY")).toHaveLength(1);
	});

	it("respects the exponential backoff window", async () => {
		// 1 prior failure → 10m backoff. Attempted 2m ago: too soon.
		const env = await seedEnv("byo-heal-backoff", "development", {
			auto_heal: true,
			auto_heal_failures: 1,
			last_auto_heal_at: new Date(Date.now() - 2 * 60_000),
		});
		await seedJob(env, "DEPLOY", "SUCCESS", ago(60_000));

		await maybeAutoHeal(projectId, env);
		expect(await jobsOfType(env, "DEPLOY")).toHaveLength(1);

		// Past the window: it heals.
		await db
			.update(projectEnvironments)
			.set({ last_auto_heal_at: new Date(Date.now() - 30 * 60_000) })
			.where(eq(projectEnvironments.id, env));

		await maybeAutoHeal(projectId, env);
		expect(await jobsOfType(env, "DEPLOY")).toHaveLength(2);
	});

	it("does NOT auto-heal an env that is in flight or deliberately destroyed", async () => {
		for (const status of ["QUEUED", "PROVISIONING", "DESTROYING", "DESTROYED"] as const) {
			const env = await seedEnv(`byo-heal-${status.toLowerCase()}`, "development", {
				auto_heal: true,
				status,
			});
			await seedJob(env, "DEPLOY", "SUCCESS", ago(60_000));

			await maybeAutoHeal(projectId, env);
			expect(await jobsOfType(env, "DEPLOY")).toHaveLength(1);
		}
	});

	it("does NOT auto-heal an env with no prior successful DEPLOY", async () => {
		const env = await seedEnv("byo-heal-nodeploy", "development", { auto_heal: true });
		await seedJob(env, "DEPLOY", "FAILED", ago(60_000));

		await maybeAutoHeal(projectId, env);
		expect(await jobsOfType(env, "DEPLOY")).toHaveLength(1);
	});

	// ── The shared-Fabric write key ───────────────────────────────────────────────────────────

	it("records deployed_commit_sha when the DEPLOY comes from a DIFFERENT env on the same Fabric", async () => {
		// #839 moved BYO-IaC's attach point to the Fabric and moved every READ onto fabric_id, but
		// finalizeDeployment still keyed its write on environment_id. On a shared Fabric — the whole
		// point of the placement model, and exactly what #845 exercises — that write matched ZERO
		// rows: deployed_commit_sha stayed NULL, so DESTROY was refused on live BYO infrastructure
		// while detach (which reads a null as "nothing deployed") would delete the only handle to it.
		const attachEnv = await seedEnv("byo-fabric-attach", "development");
		const deployEnv = await seedEnv("byo-fabric-deploy", "staging");

		await db.insert(projectIacSources).values({
			project_id: projectId,
			environment_id: attachEnv,
			fabric_id: fabricId,
			name: "default",
			repo_url: "https://github.com/acme/infra",
			ref: "main",
			path: "envs/dev",
			commit_sha: PINNED_SHA,
			scan_status: "done",
			enabled: true,
		});

		const jobId = await seedJob(deployEnv, "DEPLOY", "SUCCESS", ago(60_000));
		await finalizeDeployment(jobId);

		const [row] = await db
			.select({
				deployed_commit_sha: projectIacSources.deployed_commit_sha,
				status: projectIacSources.status,
			})
			.from(projectIacSources)
			.where(eq(projectIacSources.fabric_id, fabricId))
			.limit(1);

		expect(row.deployed_commit_sha).toBe(PINNED_SHA);
		expect(row.status).toBe("ACTIVE");
	});
});
