// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the set_env_status CAS RPC (programmables.sql) against real Postgres via the
// setEnvStatus wrapper (lib/db/env-status.ts). Proves the compare-and-swap semantics that kill the
// last-writer-wins clobber: an illegal transition is rejected (row untouched), a legal one applies,
// and two concurrent terminal callbacks (DEPLOY-success vs DESTROY-success) serialize so exactly one
// wins with no lost update. Also confirms the programmables SQL is actually loaded in the dev DB.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { setEnvStatus } from "@/lib/db/env-status";
import { projectEnvironments, projects } from "@/lib/db/schema";
import type { ProjectStatus } from "@/lib/db/schema/enums";
import { describeIfDb } from "./db";

const USER = randomUUID();

describeIfDb("set_env_status CAS", () => {
	let projectId: string;
	let envId: string;

	beforeAll(async () => {
		const db = getServiceDb();
		const [p] = await db
			.insert(projects)
			.values({
				user_id: USER,
				project_name: "cas-test",
				region: "us-east-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectId = p.id;
		const [e] = await db
			.insert(projectEnvironments)
			.values({ project_id: projectId, user_id: USER, name: "prod", status: "DRAFT", is_default: true })
			.returning({ id: projectEnvironments.id });
		envId = e.id;
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(projectEnvironments).where(eq(projectEnvironments.project_id, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	});

	/** Force the env into a known status (bypassing the CAS) before a scenario. */
	async function setRaw(status: ProjectStatus) {
		await getServiceDb()
			.update(projectEnvironments)
			.set({ status })
			.where(eq(projectEnvironments.id, envId));
	}

	async function currentStatus(): Promise<ProjectStatus> {
		const [row] = await getServiceDb()
			.select({ status: projectEnvironments.status })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.id, envId));
		return row.status;
	}

	it("rejects an illegal transition (DESTROYED → ACTIVE) and leaves the status untouched", async () => {
		await setRaw("DESTROYED");
		// The canonical clobber: a late DEPLOY-SUCCESS (deploySuccess from PROVISIONING|QUEUED).
		const ok = await setEnvStatus(
			getServiceDb(),
			envId,
			["PROVISIONING", "QUEUED"],
			"ACTIVE",
			null,
		);
		expect(ok).toBe(false);
		expect(await currentStatus()).toBe("DESTROYED");
	});

	it("accepts a legal transition (PROVISIONING → ACTIVE)", async () => {
		await setRaw("PROVISIONING");
		const ok = await setEnvStatus(
			getServiceDb(),
			envId,
			["PROVISIONING", "QUEUED"],
			"ACTIVE",
			null,
		);
		expect(ok).toBe(true);
		expect(await currentStatus()).toBe("ACTIVE");
	});

	it("serializes a concurrent DEPLOY-success + DESTROY-success — exactly one wins, no clobber", async () => {
		// From QUEUED BOTH transitions are individually eligible (deploySuccess accepts QUEUED,
		// destroySuccess accepts QUEUED). Fired concurrently, the row lock forces them to serialize:
		// the first commits, the second re-evaluates its WHERE against the new status and is rejected.
		await setRaw("QUEUED");
		const [deployWon, destroyWon] = await Promise.all([
			setEnvStatus(getServiceDb(), envId, ["PROVISIONING", "QUEUED"], "ACTIVE", null),
			setEnvStatus(getServiceDb(), envId, ["DESTROYING", "QUEUED"], "DESTROYED", null),
		]);

		// Exactly one CAS moved the row (no lost update / last-writer-wins).
		expect([deployWon, destroyWon].filter(Boolean)).toHaveLength(1);
		const final = await currentStatus();
		expect(final).not.toBe("QUEUED");
		// The persisted status matches whichever CAS reported success.
		expect(final).toBe(deployWon ? "ACTIVE" : "DESTROYED");
	});
});
