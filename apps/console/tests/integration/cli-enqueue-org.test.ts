// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the org stamp the two CLI enqueue paths write, against real Postgres (#3874).
//
// WHY THIS IS AN INTEGRATION TEST AND NOT A MOCK. The defect being fixed is a DATABASE
// TRIGGER falling through. `set_org_id` / `set_org_id_from_project` resolve org_id in three
// steps — the parent project's org, the `app.current_org` GUC, then `NEW.user_id` — and both
// of these routes insert on `getServiceDb()`, whose role bypasses RLS and sets no GUC, on rows
// with no project. So both landed on the third branch and stamped the caller's PERSONAL org.
// A mock db proves what the route passed; only a real insert proves what the row ENDS UP
// holding, which is the thing `claim_next_job` reads. Every fixture here therefore LETS THE
// TRIGGER STAMP THE ROW and then asserts the stamp — a hand-written org_id would only prove a
// test can type a uuid twice.
//
// THE ASSERTION THE WHOLE DESIGN EXISTS TO PROTECT is the first one below. `claim_next_job`
// requires `j.org_id = v_runner_org_id` for a self runner — a hard equality, in both the
// assigned phase (programmables.sql:225) and the unassigned one (:306). #3874 stamps FORWARD
// ONLY: the maintainer's ruling refuses a backfill, so runner rows written before it keep
// `org_id = user_id`. Stamping a new DESTROY_RUNNER job with `actor.orgId` — the obvious
// reading — would therefore hand a team-org job to a personal-org runner, the equality would
// fail, and the job would sit QUEUED FOREVER: strictly worse than the defect. So the job's org
// follows the RUNNER that will execute it, and this file drives that against the real
// equality rather than against a promise.
//
// The PDP and the CLI token are stubbed (they are proven in the authz suite); the database is
// not, and it is the subject.

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeIfDb } from "./db";

vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	authorizeCli: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
}));
// DESTROY_RUNNER / DEPLOY_RUNNER never reach the project actions, and importing them for real
// drags the whole server-action graph (next/cache, the PDP, the billing guards) into a suite
// whose subject is two INSERTs.
vi.mock("@/app/server/actions/projects", () => ({
	planProject: vi.fn(),
	provisionProject: vi.fn(),
	destroyProject: vi.fn(),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { POST as deployRunnerPost } from "@/app/api/cli/runners/deploy/route";
import { POST as jobsPost } from "@/app/api/jobs/route";
import { getActiveScope } from "@/lib/auth/scope";
import { authorizeCli, ensureCliOrgAccess } from "@/lib/authz/guard";
import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, jobs, runners } from "@/lib/db/schema";

/**
 * A user who belongs to two orgs: their personal one (their own id — the community model's
 * `org_id = user_id`) and a Teams org they are acting in. That pair is the entire subject:
 * the defect stamped the first where the second was meant, and the no-backfill ruling means
 * both now exist in the same table at the same time.
 */
const USER = randomUUID();
const TEAM_ORG = randomUUID();

/** A runner stamped by the TRIGGER — i.e. `org_id = user_id`, every pre-#3874 CLI deploy. */
let legacyRunner: string;
/** A runner stamped EXPLICITLY with the team org — what #3874 writes from now on. */
let modernRunner: string;
let identityId: string;

/**
 * Seeds a self-operated runner and returns its id, asserting the org it ENDED UP with.
 *
 * `orgId` omitted reproduces the pre-#3874 mechanism rather than its output: the row goes in
 * with `org_id` NULL and the `set_org_id` trigger's last branch stamps `user_id`. `expectOrg`
 * is the fixture's own premise, asserted here (inside a function, so the standalone-expect
 * rule is satisfied) because a "legacy" row that is not actually personal-org stamped would
 * make the regression test below test nothing.
 */
async function seedRunner(expectOrg: string, orgId?: string): Promise<string> {
	const name = `it-3874-${randomUUID().slice(0, 12)}`;
	const [row] = await getServiceDb()
		.insert(runners)
		.values({
			user_id: USER,
			...(orgId ? { org_id: orgId } : {}),
			name,
			operator: "self", // self ⇒ user_id NOT NULL + provisioning NOT NULL (CHECKs)
			provisioning: "deployed",
			token_hash: `hash-${name}`,
			status: "OFFLINE",
		})
		.returning({ id: runners.id, org_id: runners.org_id });
	expect(row.org_id).toBe(expectOrg);
	return row.id;
}

/** Reads back the org a row actually holds — the value claim_next_job compares. */
async function jobOrg(jobId: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ org_id: jobs.org_id })
		.from(jobs)
		.where(eq(jobs.id, jobId))
		.limit(1);
	return row.org_id;
}

/** Posts a DESTROY_RUNNER enqueue as USER acting in TEAM_ORG, and returns the created job id. */
async function destroyRunnerJob(assignedRunnerId: string | null): Promise<Response> {
	return jobsPost(
		new Request("https://console.local/api/jobs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				job_type: "DESTROY_RUNNER",
				cloud_identity_id: identityId,
				config_snapshot: { runner_name: "teardown" },
				...(assignedRunnerId ? { assigned_runner_id: assignedRunnerId } : {}),
			}),
		}),
	);
}

/** The slice of the 201 body this suite reads — narrowed by parse, never by a cast. */
const createdJobSchema = z.object({ job: z.object({ id: z.uuid() }) });

/** Pulls the created job's id out of a 201 body. */
async function createdJobId(res: Response): Promise<string> {
	expect(res.status).toBe(201);
	return createdJobSchema.parse(await res.json()).job.id;
}

describeIfDb("CLI enqueue org stamp (#3874)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		const [identity] = await db
			.insert(cloudIdentities)
			.values({
				user_id: USER,
				org_id: TEAM_ORG,
				provider: "aws",
				name: `it-3874-identity-${TEAM_ORG.slice(0, 8)}`,
			})
			.returning({ id: cloudIdentities.id });
		identityId = identity.id;

		// The trigger stamps user_id when org_id is left NULL — the pre-#3874 shape.
		legacyRunner = await seedRunner(USER);
		// And it does NOT overwrite an explicit stamp (`IF NEW.org_id IS NULL`), which is what
		// makes the deploy route's forward fix possible at all.
		modernRunner = await seedRunner(TEAM_ORG, TEAM_ORG);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(eq(jobs.user_id, USER));
		await db.delete(runners).where(eq(runners.user_id, USER));
		await db.delete(cloudIdentities).where(eq(cloudIdentities.id, identityId));
	});

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: USER },
			error: null,
		} as never);
		// The caller's ACTIVE org is the team org — the org the defect's "obvious fix" would
		// have stamped, and the one every assertion below is written to distinguish from.
		vi.mocked(getActiveScope).mockResolvedValue({
			userId: USER,
			orgId: TEAM_ORG,
		} as never);
		vi.mocked(ensureCliOrgAccess).mockResolvedValue(null);
		vi.mocked(authorizeCli).mockResolvedValue({
			actor: { userId: USER, orgId: TEAM_ORG },
		} as never);
	});

	// ── 1. THE REGRESSION THE NO-BACKFILL DESIGN EXISTS TO AVOID ────────────────────────────
	it("keeps a legacy runner's DESTROY_RUNNER in the active org and still claims it", async () => {
		const jobId = await createdJobId(await destroyRunnerJob(legacyRunner));

		const [runnerRow] = await getServiceDb()
			.select({ org_id: runners.org_id, token_hash: runners.token_hash })
			.from(runners)
			.where(eq(runners.id, legacyRunner))
			.limit(1);

		expect(runnerRow.org_id).toBe(USER);
		expect(await jobOrg(jobId)).toBe(TEAM_ORG);

		const claimed = await getServiceDb().execute(sql`
			select id from claim_next_job(
				${legacyRunner}::uuid,
				${runnerRow.token_hash},
				${null}::uuid
			)
		`);
		expect(Array.from(claimed).map((row) => row.id)).toContain(jobId);
	});

	// ── 2. The forward case: a runner already in the actor's org ────────────────────────────
	it("DESTROY_RUNNER for a runner in the ACTOR's org gets the actor's org", async () => {
		const jobId = await createdJobId(await destroyRunnerJob(modernRunner));

		expect(await jobOrg(jobId)).toBe(TEAM_ORG);
		expect(await jobOrg(jobId)).not.toBe(USER);

		const claimable = await getServiceDb().execute(sql`
			select j.id from jobs j
			  join runners r on r.id = j.assigned_runner_id
			 where j.id = ${jobId}::uuid and j.org_id = r.org_id
		`);
		expect(Array.from(claimable)).toHaveLength(1);
	});

	// ── 2b. No runner named: the actor's org, which is the half the defect got wrong ────────
	it("DESTROY_RUNNER with no assigned runner falls back to the ACTOR's org, not the personal org", async () => {
		const jobId = await createdJobId(await destroyRunnerJob(null));
		// This is the branch the trigger used to decide, and it decided `user_id`. The stamp is
		// now explicit, so the GUC-less service connection no longer chooses the tenancy.
		expect(await jobOrg(jobId)).toBe(TEAM_ORG);
	});

	it("lets a legacy owner claim only their unassigned lifecycle work", async () => {
		const owner = randomUUID();
		const activeOrg = randomUUID();
		const tokenHash = `hash-compat-${owner}`;
		const [runner] = await getServiceDb()
			.insert(runners)
			.values({
				user_id: owner,
				name: `it-compat-${owner.slice(0, 8)}`,
				operator: "self",
				provisioning: "registered",
				token_hash: tokenHash,
				status: "OFFLINE",
			})
			.returning({ id: runners.id, org_id: runners.org_id });
		expect(runner.org_id).toBe(owner);

		const inserted = await getServiceDb()
			.insert(jobs)
			.values([
				{
					user_id: randomUUID(),
					org_id: activeOrg,
					job_type: "DESTROY_RUNNER",
					status: "QUEUED",
					config_snapshot: {},
					priority: 200,
				},
				{
					user_id: owner,
					org_id: activeOrg,
					job_type: "PLAN",
					status: "QUEUED",
					config_snapshot: {},
					priority: 100,
				},
				{
					user_id: owner,
					org_id: activeOrg,
					job_type: "UPDATE_RUNNER",
					status: "QUEUED",
					config_snapshot: {},
				},
			])
			.returning({ id: jobs.id, job_type: jobs.job_type });
		const lifecycleJob = inserted.find((row) => row.job_type === "UPDATE_RUNNER");
		expect(lifecycleJob).toBeDefined();

		const claimed = await getServiceDb().execute(sql`
			select id from claim_next_job(${runner.id}::uuid, ${tokenHash}, ${null}::uuid)
		`);
		expect(Array.from(claimed).map((row) => row.id)).toStrictEqual([
			lifecycleJob?.id,
		]);

		await getServiceDb().delete(jobs).where(eq(jobs.org_id, activeOrg));
		await getServiceDb().delete(runners).where(eq(runners.id, runner.id));
	});

	// ── 3. DEPLOY_RUNNER stamps the pair identically, by construction ───────────────────────
	it("DEPLOY_RUNNER stamps the runners row and the jobs row with the SAME org", async () => {
		const res = await deployRunnerPost(
			new Request("https://console.local/api/cli/runners/deploy", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: `it-3874-deployed-${randomUUID().slice(0, 8)}`,
					cloud_identity_id: identityId,
					region: "us-east-1",
				}),
			}),
		);
		expect(res.status).toBe(201);

		// Read both rows back from the database rather than from the response: the response
		// carries neither org, and the whole defect was about what the row ended up holding.
		const [job] = await getServiceDb()
			.select({ id: jobs.id, org_id: jobs.org_id, snapshot: jobs.config_snapshot })
			.from(jobs)
			.where(and(eq(jobs.user_id, USER), eq(jobs.job_type, "DEPLOY_RUNNER")))
			.orderBy(desc(jobs.created_at))
			.limit(1);
		// The new runner's id is only in the snapshot (the response returns it, but reading it
		// from the row is what proves the two rows the ROUTE wrote refer to each other).
		const newRunnerId = z.uuid().parse(job.snapshot.runner_id);

		const [runnerRow] = await getServiceDb()
			.select({ org_id: runners.org_id })
			.from(runners)
			.where(eq(runners.id, newRunnerId))
			.limit(1);

		expect(runnerRow.org_id).toBe(TEAM_ORG);
		expect(job.org_id).toBe(TEAM_ORG);
		// The pair, stated as a pair: they match because one request wrote both, not because
		// both fell through the same trigger branch in the same wrong direction.
		expect(job.org_id).toBe(runnerRow.org_id);
		// Neither is the personal org the trigger would have chosen.
		expect(job.org_id).not.toBe(USER);
		expect(runnerRow.org_id).not.toBe(USER);
	});
});
