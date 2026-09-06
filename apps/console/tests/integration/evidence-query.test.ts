// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the org-wide evidence roll-up (lib/queries/evidence.ts → queryOrgEvidence)
// against real Postgres. Exercises the widened projection — provider (via the cloud_identity
// join), effective region (env → project fallback), the full verify report + signed receipt
// pulled from execution_metadata, per-resource drift details, security report_count — plus the
// summary counters and the active-waiver assembly. Seeds one org's worth of rows via the
// service connection (bypasses RLS) with unique ids and cleans up by those ids.

import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	environmentDrift,
	environmentSecurity,
	jobs,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { queryOrgEvidence } from "@/lib/queries/evidence";
import type {
	SignedReceipt,
	VerifyOverrideInput,
	VerifyReport,
} from "@/types/jsonb.types";
import { describeIfDb } from "./db";

const ORG_ID = randomUUID();
const USER_ID = randomUUID();
const IDENTITY_ID = randomUUID();
const PROJECT_ID = randomUUID();
const ENV1_ID = randomUUID(); // verified + drifted + scanned (production, own region)
const ENV2_ID = randomUUID(); // untouched (inherits the project region)
const PLAN_JOB_ID = randomUUID(); // carries verify_result + verify_receipt
const WAIVER_JOB_ID = randomUUID(); // carries verify_override

const PROJECT_REGION = "us-east-1";
const ENV1_REGION = "eu-west-1";
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const REPORT: VerifyReport = {
	verdict: "fail",
	catalog_version: "elench-controls-0.1.0",
	provider: "aws",
	controls: [
		{
			id: "KEYLESS-001",
			title: "No static IAM access keys",
			severity: "high",
			status: "fail",
			provider: "aws",
			frameworks: ["SOC2 CC6.1", "CIS 1.4"],
			findings: [
				{ address: "aws_iam_access_key.ci", message: "a static key is created" },
			],
			coverage: "cannot inspect credentials injected via computed policy bodies",
		},
		{
			id: "OIDC-001",
			title: "Federated trust bound to a subject",
			severity: "high",
			status: "pass",
			provider: "aws",
		},
	],
	summary: { pass: 1, fail: 1, warn: 0, not_evaluable: 0 },
};

const RECEIPT: SignedReceipt = {
	algorithm: "ed25519",
	key_id: "test-key-1",
	signature: "deadbeef",
	receipt: {
		version: "1",
		plan_sha256: "a".repeat(64),
		catalog_version: "elench-controls-0.1.0",
		provider: "aws",
		verdict: "fail",
		report: REPORT,
		exception: {
			controls: ["KEYLESS-001"],
			reason: "temporary rollout",
			by: "eng@alethia.test",
		},
		runner: "runner-int-1",
		evaluated_at: "2026-07-08T00:00:00Z",
	},
};

const OVERRIDE: VerifyOverrideInput = {
	controls: ["KEYLESS-001"],
	reason: "approved for the migration window",
	by: "admin@alethia.test",
	expiry: FUTURE,
};

describeIfDb("queryOrgEvidence (org evidence roll-up)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(cloudIdentities).values({
			id: IDENTITY_ID,
			user_id: USER_ID,
			org_id: ORG_ID,
			provider: "aws",
			name: `it-evidence-${IDENTITY_ID.slice(0, 6)}`,
		});
		await db.insert(projects).values({
			id: PROJECT_ID,
			user_id: USER_ID,
			org_id: ORG_ID,
			cloud_identity_id: IDENTITY_ID,
			project_name: `it-evidence-${PROJECT_ID.slice(0, 6)}`,
			region: PROJECT_REGION,
			iac_version: "1.11.4",
		});
		await db.insert(projectEnvironments).values([
			{
				id: ENV1_ID,
				project_id: PROJECT_ID,
				user_id: USER_ID,
				name: "prod",
				stage: "production",
				region: ENV1_REGION,
				is_default: true,
			},
			{
				id: ENV2_ID,
				project_id: PROJECT_ID,
				user_id: USER_ID,
				name: "dev",
				stage: "development",
				is_default: false,
				// region null → inherits the project's region
			},
		]);
		await db.insert(jobs).values([
			{
				id: PLAN_JOB_ID,
				user_id: USER_ID,
				org_id: ORG_ID,
				project_id: PROJECT_ID,
				environment_id: ENV1_ID,
				job_type: "PLAN",
				config_snapshot: {},
				execution_metadata: { verify_result: REPORT, verify_receipt: RECEIPT },
			},
			{
				id: WAIVER_JOB_ID,
				user_id: USER_ID,
				org_id: ORG_ID,
				project_id: PROJECT_ID,
				environment_id: ENV1_ID,
				job_type: "DEPLOY",
				config_snapshot: {},
				verify_override: OVERRIDE,
			},
		]);
		await db.insert(environmentDrift).values({
			project_id: PROJECT_ID,
			environment_id: ENV1_ID,
			in_sync: false,
			drifted: 2,
			details: [
				{ address: "aws_db_instance.main", type: "aws_db_instance", kind: "modified" },
				{ address: "aws_s3_bucket.logs", type: "aws_s3_bucket", kind: "deleted" },
			],
		});
		await db.insert(environmentSecurity).values({
			project_id: PROJECT_ID,
			environment_id: ENV1_ID,
			critical: 1,
			high: 2,
			medium: 3,
			low: 4,
			report_count: 5,
			scanned: true,
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		// jobs FK the project with onDelete:set-null, so remove them explicitly; deleting the
		// project cascades environments + drift + security.
		await db.delete(jobs).where(inArray(jobs.id, [PLAN_JOB_ID, WAIVER_JOB_ID]));
		await db.delete(projects).where(inArray(projects.id, [PROJECT_ID]));
		await db
			.delete(cloudIdentities)
			.where(inArray(cloudIdentities.id, [IDENTITY_ID]));
	});

	it("assembles both environment rows with provider + effective region", async () => {
		const { rows } = await queryOrgEvidence(ORG_ID);
		expect(rows).toHaveLength(2);
		const env1 = rows.find((r) => r.environmentId === ENV1_ID);
		const env2 = rows.find((r) => r.environmentId === ENV2_ID);
		expect(env1?.provider).toBe("aws");
		expect(env1?.region).toBe(ENV1_REGION);
		// env2 has no own region → inherits the project's.
		expect(env2?.region).toBe(PROJECT_REGION);
	});

	it("carries the full verify report + signed receipt on the verified env", async () => {
		const { rows } = await queryOrgEvidence(ORG_ID);
		const env1 = rows.find((r) => r.environmentId === ENV1_ID);
		expect(env1?.verify?.verdict).toBe("fail");
		expect(env1?.verify?.hasReceipt).toBe(true);
		expect(env1?.verify?.report.controls).toHaveLength(2);
		expect(env1?.verify?.report.controls[0]?.coverage).toContain("cannot inspect");
		expect(env1?.verify?.receipt?.algorithm).toBe("ed25519");
		expect(env1?.verify?.receipt?.receipt.plan_sha256).toHaveLength(64);
		expect(env1?.verify?.receipt?.receipt.exception?.controls).toContain(
			"KEYLESS-001",
		);
	});

	it("carries drift details and security report_count", async () => {
		const { rows } = await queryOrgEvidence(ORG_ID);
		const env1 = rows.find((r) => r.environmentId === ENV1_ID);
		expect(env1?.drift?.inSync).toBe(false);
		expect(env1?.drift?.drifted).toBe(2);
		expect(env1?.drift?.details).toHaveLength(2);
		expect(env1?.drift?.details.map((d) => d.kind)).toEqual([
			"modified",
			"deleted",
		]);
		expect(env1?.security?.scanned).toBe(true);
		expect(env1?.security?.reportCount).toBe(5);
		expect(env1?.security?.critical).toBe(1);
	});

	it("leaves the untouched env's postures null (honest unknowns)", async () => {
		const { rows } = await queryOrgEvidence(ORG_ID);
		const env2 = rows.find((r) => r.environmentId === ENV2_ID);
		expect(env2?.verify).toBeNull();
		expect(env2?.drift).toBeNull();
		expect(env2?.security).toBeNull();
	});

	it("computes the summary counters over the org", async () => {
		const { summary } = await queryOrgEvidence(ORG_ID);
		expect(summary.environments).toBe(2);
		expect(summary.failing).toBe(1);
		expect(summary.unverified).toBe(1);
		expect(summary.drifted).toBe(1);
		expect(summary.driftUnknown).toBe(1);
		expect(summary.criticalHighVulns).toBe(3); // 1 critical + 2 high
		expect(summary.securityUnknown).toBe(1);
		expect(summary.activeWaivers).toBe(1);
	});

	it("lists the recorded waiver as active", async () => {
		const { waivers } = await queryOrgEvidence(ORG_ID);
		const w = waivers.find((x) => x.jobId === WAIVER_JOB_ID);
		expect(w).toBeDefined();
		expect(w?.controls).toContain("KEYLESS-001");
		expect(w?.reason).toContain("migration window");
		expect(w?.by).toBe("admin@alethia.test");
		expect(w?.active).toBe(true);
		expect(w?.environmentName).toBe("prod");
	});
});
