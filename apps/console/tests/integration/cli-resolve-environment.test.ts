// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: resolveCliEnvironment (used by the drift/cost CLI read routes). It matches an
// environment within a project by id, name, OR stage, preferring the is_default row when a stage
// matches more than one. A mock can't catch the pgEnum stage comparison — it's real SQL against
// the environmentStage enum column, guarded by isEnvironmentStage so an arbitrary --env string
// never reaches the enum comparison as an invalid literal.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveCliEnvironment } from "@/lib/cli/resolve-project";
import { getServiceDb } from "@/lib/db";
import { projectEnvironments, projects } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();
const PROJ = randomUUID();
const ENV_PROD = randomUUID();
const ENV_STAGING = randomUUID();

describeIfDb("resolveCliEnvironment — id/name/stage matching", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(projects).values({
			id: PROJ,
			org_id: ORG,
			user_id: USER,
			project_name: `p-${PROJ}`,
			region: "westeurope",
			iac_version: "1.0",
		});
		// One transaction: the first insert alone leaves this project with an environment and no
		// default, which `project_environments_one_default_check` (lib/db/programmables.sql) refuses.
		// The trigger is DEFERRED, so it judges the state at COMMIT — the pair is what has to be
		// valid, not each statement.
		await db.transaction(async (tx) => {
			await tx.insert(projectEnvironments).values({
				id: ENV_STAGING,
				project_id: PROJ,
				user_id: USER,
				name: "staging",
				stage: "staging",
				is_default: false,
			});
			await tx.insert(projectEnvironments).values({
				id: ENV_PROD,
				project_id: PROJ,
				user_id: USER,
				name: "production",
				stage: "production",
				is_default: true,
			});
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(projectEnvironments).where(eq(projectEnvironments.project_id, PROJ));
		await db.delete(projects).where(eq(projects.id, PROJ));
	});

	it("resolves by environment name", async () => {
		const env = await resolveCliEnvironment(PROJ, "staging");
		expect(env?.id).toBe(ENV_STAGING);
	});

	it("resolves by stage", async () => {
		const env = await resolveCliEnvironment(PROJ, "production");
		expect(env?.id).toBe(ENV_PROD);
	});

	it("resolves by environment id", async () => {
		const env = await resolveCliEnvironment(PROJ, ENV_STAGING);
		expect(env?.id).toBe(ENV_STAGING);
	});

	it("returns null for an unknown environment (and never errors on a non-stage string)", async () => {
		expect(await resolveCliEnvironment(PROJ, "does-not-exist")).toBeNull();
	});
});
