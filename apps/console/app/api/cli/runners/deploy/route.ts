// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import { signedJob } from "@/lib/db/signed-job";
import { assertRunnerInOrg } from "@/lib/authz/runner-org";
import { ForbiddenError } from "@/lib/authz/types";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, jobs, runnerReleases, runners } from "@/lib/db/schema";
import {
	isRunnerDeployProvider,
	runnerDeployUnsupportedMessage,
} from "@/lib/runners/deploy-providers";
import { notifyScaler } from "@/lib/scaler";
import { createHash, randomBytes } from "crypto";
import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { deployRunnerWire } from "@/lib/validations/cli-contract";

/**
 * Deploys a runner by creating a runner record + queuing a DEPLOY_RUNNER job.
 *
 * TENANCY (#3874). Both inserts run on `getServiceDb()` — a role that bypasses RLS and
 * sets no `app.current_org` GUC — so the `set_org_id` / `set_org_id_from_project` triggers
 * fell through to their last branch and stamped `org_id = NEW.user_id`: a member of a Teams
 * org got a runner and a job in their PERSONAL org. They matched each other, which is why
 * the pair worked; they were both wrong in the same direction. Both are now stamped
 * EXPLICITLY rather than by a trigger fallback — the runners row with `actor.orgId`, the org
 * already used for identity checks, quota, reporting, and lifecycle serialization.
 * Pre-#3874 caller-owned runners retain a narrow claim-time compatibility path for
 * lifecycle jobs; the job itself never leaves the active tenant.
 */
export async function POST(req: Request) {
	const auth = await authorizeCli(req, "deploy", { type: "runner" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		const body = await req.json();
		const { name, cloud_identity_id, region, assigned_runner_id } = body;

		if (!name || !cloud_identity_id || !region) {
			return NextResponse.json(
				{ error: "name, cloud_identity_id, and region are required" },
				{ status: 400 },
			);
		}

		const db = getServiceDb();

		// Defense-in-depth: the existing runner that will run this deploy must belong
		// to the caller's org (matches the identity org-check below and the org
		// claim_next_job compares against). Fail closed (404) — same shape as a
		// missing runner — so we never disclose a runner in another org.
		if (assigned_runner_id) {
			try {
				await assertRunnerInOrg(db, assigned_runner_id, actor.orgId, actor.userId);
			} catch (e: unknown) {
				if (e instanceof ForbiddenError) {
					return NextResponse.json(
						{ error: "Runner not found" },
						{ status: 404 },
					);
				}
				throw e;
			}
		}

		const [identity] = await db
			.select({
				id: cloudIdentities.id,
				provider: cloudIdentities.provider,
				org_id: cloudIdentities.org_id,
			})
			.from(cloudIdentities)
			.where(eq(cloudIdentities.id, cloud_identity_id))
			.limit(1);

		if (!identity) {
			return NextResponse.json(
				{ error: "Cloud identity not found" },
				{ status: 404 },
			);
		}

		if (identity.org_id !== actor.orgId) {
			return NextResponse.json(
				{ error: "Unauthorized: cloud identity belongs to another org" },
				{ status: 403 },
			);
		}

		// This route re-implements the enqueue rather than calling deployRunner(), so it needs
		// the template gate of its own — a fix only in the server action leaves the CLI able to
		// queue a job that dies in the runner with "no templates for provider <cloud>".
		if (!isRunnerDeployProvider(identity.provider)) {
			return NextResponse.json(
				{ error: runnerDeployUnsupportedMessage(identity.provider) },
				{ status: 400 },
			);
		}

		// EVERY reason to refuse now runs before the FIRST insert, so a rejected deploy leaves
		// nothing behind. The quota assert used to sit between the runners insert and the jobs
		// insert, which orphaned a `provisioning=deployed` runner row — holding a live
		// token_hash — with no job to build it. deployRunner() (app/server/actions/runners.ts)
		// has always ordered it this way; this route is the copy that had drifted.
		//
		await assertJobQuotaAllowed(actor.orgId);

		const [latestRelease] = await db
			.select({ version: runnerReleases.version })
			.from(runnerReleases)
			.orderBy(desc(runnerReleases.released_at))
			.limit(1);

		const imageTag = latestRelease?.version ?? "latest";

		const runnerToken = randomBytes(32).toString("hex");
		const tokenHash = createHash("sha256").update(runnerToken).digest("hex");

		const [runner] = await db
			.insert(runners)
			.values({
				user_id: actor.userId,
				// Explicit (#3874) — without it the set_org_id trigger stamps user_id here,
				// because this insert carries no app.current_org GUC.
				org_id: actor.orgId,
				name,
				operator: "self",
				provisioning: "deployed",
				token_hash: tokenHash,
				cloud_identity_id,
			})
			.returning({ id: runners.id, name: runners.name });

		const configSnapshot = {
			runner_id: runner.id,
			runner_token: runnerToken,
			runner_name: name,
			image_tag: imageTag,
			region,
			cloud_provider: identity.provider,
			alethia_url:
				process.env.NEXT_PUBLIC_APP_URL || "https://alethialabs.io",
		};

		const [job] = await db
			.insert(jobs)
			.values(signedJob({
				user_id: actor.userId,
				// Explicitly retain the active tenant; claim-time compatibility handles legacy runners.
				org_id: actor.orgId,
				cloud_identity_id,
				job_type: "DEPLOY_RUNNER",
				initiated_by: "user",
				config_snapshot: configSnapshot,
				status: "QUEUED",
				assigned_runner_id: assigned_runner_id || null,
			}))
			.returning({
				id: jobs.id,
				status: jobs.status,
				created_at: jobs.created_at,
			});

		notifyScaler();
		return cliJson(deployRunnerWire, { runner, job }, { status: 201 });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
