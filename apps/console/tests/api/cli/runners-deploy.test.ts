// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/runners/deploy re-implements the enqueue that `deployRunner()` does — it does NOT
// call the server action — so the "we only hold runner templates for AWS" gate has to be proven
// here separately. Without it, `alethia runner deploy` on a GCP identity queues a job that dies in
// the runner with "no templates for provider gcp", long after the runner row exists.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
vi.mock("@/lib/authz/runner-org", () => ({ assertRunnerInOrg: vi.fn() }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { POST } from "@/app/api/cli/runners/deploy/route";
import { authorizeCli } from "@/lib/authz/guard";
import { assertRunnerInOrg } from "@/lib/authz/runner-org";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { getServiceDb } from "@/lib/db";
import { notifyScaler } from "@/lib/scaler";

/**
 * A drizzle-ish chain whose builders return the chain and whose every `await` resolves to the
 * next seeded result-set (FIFO), so the route's sequential queries each get their own rows.
 */
function makeDb() {
	const queue: unknown[][] = [];
	const valuesSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		orderBy: () => db,
		limit: () => db,
		insert: () => db,
		values: (...a: unknown[]) => {
			valuesSpy(...a);
			return db;
		},
		returning: () => db,
		then: (resolve: (v: unknown) => void) =>
			resolve(queue.length ? queue.shift() : []),
	});
	return { db, queue, valuesSpy };
}

let mock: ReturnType<typeof makeDb>;

/** Builds the POST request the CLI sends for `alethia runner deploy`. */
function req(body: Record<string, unknown>): Request {
	return new Request("https://console.local/api/cli/runners/deploy", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const DEPLOY = { name: "Cloud", cloud_identity_id: "ci-1", region: "us-east-1" };

beforeEach(() => {
	vi.clearAllMocks();
	mock = makeDb();
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { userId: "user-1", orgId: "org-1" },
	} as never);
	vi.mocked(getServiceDb).mockReturnValue(mock.db as never);
});

describe("POST /api/cli/runners/deploy", () => {
	it("queues the deploy for an AWS identity", async () => {
		mock.queue.push(
			[{ id: "ci-1", provider: "aws", org_id: "org-1" }], // identity lookup
			[{ version: "1.4.0" }], // latest release
			[{ id: "r-dep", name: "Cloud" }], // runner insert
			[{ id: "job-1", status: "QUEUED", created_at: new Date() }], // job insert
		);
		const res = await POST(req(DEPLOY));
		expect(res.status).toBe(201);

		const jobValues = mock.valuesSpy.mock.calls[1][0];
		expect(jobValues.config_snapshot).toMatchObject({
			cloud_provider: "aws",
			region: "us-east-1",
		});
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	// ── #3874: both inserts carry the ACTOR's org, explicitly ──────────────────────────────
	//
	// Both run on getServiceDb() — a role that bypasses RLS and sets no `app.current_org` —
	// so the set_org_id triggers fell through to `NEW.user_id` and put a Teams member's runner
	// AND its job in their personal org. They matched each other, which is why the pair worked:
	// both were wrong in the same direction. `claim_next_job` compares `j.org_id =
	// v_runner_org_id` as a hard equality, so the two stamps must agree — and the point of
	// stamping them in one request is that they agree BY CONSTRUCTION rather than by both
	// falling through the same branch.
	it("stamps the runners row and the jobs row with the SAME actor org", async () => {
		mock.queue.push(
			[{ id: "ci-1", provider: "aws", org_id: "org-1" }], // identity lookup
			[{ version: "1.4.0" }], // latest release
			[{ id: "r-dep", name: "Cloud" }], // runner insert
			[{ id: "job-1", status: "QUEUED", created_at: new Date() }], // job insert
		);
		expect((await POST(req(DEPLOY))).status).toBe(201);

		const runnerValues = mock.valuesSpy.mock.calls[0][0];
		const jobValues = mock.valuesSpy.mock.calls[1][0];
		expect(runnerValues.org_id).toBe("org-1");
		expect(jobValues.org_id).toBe("org-1");
		// The pair, asserted as a pair — the equality claim_next_job evaluates.
		expect(jobValues.org_id).toBe(runnerValues.org_id);
		// And NOT the personal org the trigger would otherwise have chosen.
		expect(jobValues.org_id).not.toBe("user-1");
		expect(runnerValues.org_id).not.toBe("user-1");
	});

	// The caller-owned legacy admission pairs with claim_next_job's lifecycle-only compatibility.
	it("admits the caller's pre-#3874 assigned runner", async () => {
		mock.queue.push(
			[{ id: "ci-1", provider: "aws", org_id: "org-1" }],
			[{ version: "1.4.0" }],
			[{ id: "r-dep", name: "Cloud" }],
			[{ id: "job-1", status: "QUEUED", created_at: new Date() }],
		);
		expect(
			(await POST(req({ ...DEPLOY, assigned_runner_id: "runner-x" }))).status,
		).toBe(201);

		expect(assertRunnerInOrg).toHaveBeenCalledWith(
			expect.anything(),
			"runner-x",
			"org-1",
			"user-1",
		);
	});

	it("400s a cloud with no runner template, before inserting anything", async () => {
		mock.queue.push([{ id: "ci-1", provider: "gcp", org_id: "org-1" }]);
		const res = await POST(req({ ...DEPLOY, region: "europe-west1" }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/deployed runners are AWS only/i);
		// No orphan runners row, no job, no scaler wake.
		expect(mock.valuesSpy).not.toHaveBeenCalled();
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("404s a missing identity rather than deploying to a default cloud", async () => {
		mock.queue.push([]);
		const res = await POST(req(DEPLOY));
		expect(res.status).toBe(404);
		expect(mock.valuesSpy).not.toHaveBeenCalled();
	});

	// The quota assert used to run BETWEEN the runners insert and the jobs insert, so an
	// over-quota `alethia runner deploy` left a `provisioning=deployed` runners row holding a
	// live token_hash with no job to build it — an orphan the user can see and cannot use.
	// deployRunner() has always asserted before its inserts; this proves the route now matches.
	it("rejects an over-quota deploy without inserting a runner row", async () => {
		mock.queue.push(
			[{ id: "ci-1", provider: "aws", org_id: "org-1" }], // identity lookup
			[{ version: "1.4.0" }], // latest release (must not be reached)
			[{ id: "r-dep", name: "Cloud" }], // runner insert (must not be reached)
		);
		vi.mocked(assertJobQuotaAllowed).mockRejectedValueOnce(
			new Error("Monthly job quota exceeded"),
		);

		const res = await POST(req(DEPLOY));
		expect(res.status).toBe(500);
		expect((await res.json()).error).toMatch(/quota/i);
		expect(mock.valuesSpy).not.toHaveBeenCalled();
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	// Ordering, stated directly: the quota gate is consulted before the first write, not after.
	it("asserts the quota before any insert on the happy path", async () => {
		const order: string[] = [];
		vi.mocked(assertJobQuotaAllowed).mockImplementationOnce(async () => {
			order.push("quota");
		});
		mock.valuesSpy.mockImplementation(() => {
			order.push("insert");
		});
		mock.queue.push(
			[{ id: "ci-1", provider: "aws", org_id: "org-1" }],
			[{ version: "1.4.0" }],
			[{ id: "r-dep", name: "Cloud" }],
			[{ id: "job-1", status: "QUEUED", created_at: new Date() }],
		);

		expect((await POST(req(DEPLOY))).status).toBe(201);
		expect(order).toEqual(["quota", "insert", "insert"]);
	});
});
