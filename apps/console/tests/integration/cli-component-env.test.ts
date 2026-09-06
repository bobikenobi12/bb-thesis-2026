// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: `alethia project component add` for a SINGLETON (#662). A mock can't catch this — the
// bug WAS the SQL: the component tables are UNIQUE on the composite (project_id, environment_id), so
// an insert that leaves environment_id NULL and upserts ON CONFLICT (project_id) errors against real
// Postgres. Seed a project + two environments via the service connection (bypasses RLS) and assert the
// default env is chosen, the row carries it, and a re-add upserts rather than erroring or duplicating.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	deleteProjectComponent,
	insertProjectComponent,
	listProjectComponents,
} from "@/lib/cli/project-components";
import { resolveDefaultEnvironmentId } from "@/lib/cli/resolve-project";
import { getServiceDb } from "@/lib/db";
import {
	projectCluster,
	projectEnvironments,
	projectFabrics,
	projects,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();
const PROJ = randomUUID();
const FABRIC = randomUUID();
const ENV_DEFAULT = randomUUID();
const ENV_OTHER = randomUUID();

describeIfDb("CLI project component add — environment scoping (#662)", () => {
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
		await db.insert(projectFabrics).values({
			id: FABRIC,
			project_id: PROJ,
			user_id: USER,
			org_id: ORG,
			name: "shared",
		});
		// Two envs; the non-default is the OLDER one, so a naive "earliest" pick would get it wrong —
		// the resolver must prefer is_default.
		//
		// ONE TRANSACTION, and `created_at` written by hand. Between the two inserts this project has
		// an environment and no default, which `project_environments_one_default_check`
		// (lib/db/programmables.sql) refuses — but it is a DEFERRED constraint trigger, so it judges
		// the state at COMMIT and the intermediate one is legal. Inside a transaction `defaultNow()`
		// is the transaction timestamp for both rows, which would erase the age gap this fixture
		// exists to create; the explicit timestamps keep it.
		await db.transaction(async (tx) => {
			await tx.insert(projectEnvironments).values({
				id: ENV_OTHER,
				project_id: PROJ,
				user_id: USER,
				name: "staging",
				is_default: false,
				fabric_id: FABRIC,
				placement_mode: "namespace",
				created_at: new Date("2025-01-01T00:00:00.000Z"),
			});
			await tx.insert(projectEnvironments).values({
				id: ENV_DEFAULT,
				project_id: PROJ,
				user_id: USER,
				name: "production",
				is_default: true,
				fabric_id: FABRIC,
				placement_mode: "dedicated",
				created_at: new Date("2025-06-01T00:00:00.000Z"),
			});
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(projectCluster).where(eq(projectCluster.project_id, PROJ));
		await db.delete(projectEnvironments).where(eq(projectEnvironments.project_id, PROJ));
		await db.delete(projects).where(eq(projects.id, PROJ));
	});

	it("resolves the project's is_default environment", async () => {
		expect(await resolveDefaultEnvironmentId(PROJ)).toBe(ENV_DEFAULT);
	});

	it("adds a singleton cluster carrying the default environment", async () => {
		const wire = await insertProjectComponent("cluster", PROJ, ENV_DEFAULT, "", {
			node_desired_size: 2,
			instance_types: ["Standard_D2s_v3"],
		});
		expect(wire).toBeTruthy();

		const rows = await getServiceDb()
			.select()
			.from(projectCluster)
			.where(eq(projectCluster.project_id, PROJ));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.environment_id).toBe(ENV_DEFAULT);
		expect(rows[0]?.fabric_id).toBe(FABRIC);
		expect(rows[0]?.node_desired_size).toBe(2);
	});

	it("re-adds via the composite upsert — updates in place, never errors or duplicates", async () => {
		await insertProjectComponent("cluster", PROJ, ENV_DEFAULT, "", {
			node_desired_size: 4,
			instance_types: ["Standard_D2s_v3"],
		});

		const rows = await getServiceDb()
			.select()
			.from(projectCluster)
			.where(eq(projectCluster.project_id, PROJ));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.node_desired_size).toBe(4);
		expect(rows[0]?.environment_id).toBe(ENV_DEFAULT);
	});

	// The two-tier shape the CLI could not build before `--env`: the SAME singleton kind in two
	// environments, with DIFFERENT config. They share one Fabric, so only the dedicated owner's row
	// may claim fabric_id; stamping the namespace row too violates project_cluster_fabric_id_key.
	it("holds the same singleton kind in two environments, independently", async () => {
		await insertProjectComponent("cluster", PROJ, ENV_OTHER, "", {
			node_desired_size: 9,
			instance_types: ["Standard_D2s_v3"],
		});

		const rows = await getServiceDb()
			.select()
			.from(projectCluster)
			.where(eq(projectCluster.project_id, PROJ));
		expect(rows).toHaveLength(2);
		const byEnv = new Map(rows.map((r) => [r.environment_id, r.node_desired_size]));
		expect(byEnv.get(ENV_DEFAULT)).toBe(4);
		expect(byEnv.get(ENV_OTHER)).toBe(9);
		expect(rows.find((row) => row.environment_id === ENV_DEFAULT)?.fabric_id).toBe(FABRIC);
		expect(rows.find((row) => row.environment_id === ENV_OTHER)?.fabric_id).toBeNull();
	});

	// THE REGRESSION, and a mock could not catch it because the bug was the SQL predicate.
	// deleteProjectComponent scoped a singleton delete to `project_id` ALONE, so removing the cluster
	// from one environment silently removed it from EVERY environment. Harmless while only the default
	// env could be written; data loss the moment per-environment authoring exists — which is the same
	// change that introduces it. Assert the precondition (two rows) so this can never pass vacuously.
	it("deletes from ONE environment only, leaving the sibling intact", async () => {
		const db = getServiceDb();
		const before = await db
			.select()
			.from(projectCluster)
			.where(eq(projectCluster.project_id, PROJ));
		expect(before).toHaveLength(2); // precondition — without it the assertion below proves nothing

		expect(
			await deleteProjectComponent("cluster", PROJ, "", ENV_OTHER),
		).toBe(true);

		const after = await db
			.select()
			.from(projectCluster)
			.where(eq(projectCluster.project_id, PROJ));
		expect(after).toHaveLength(1);
		expect(after[0]?.environment_id).toBe(ENV_DEFAULT);
		expect(after[0]?.node_desired_size).toBe(4);
	});

	// And a delete aimed at an environment that holds no such component must report "not found"
	// rather than falling back to some other environment's row.
	it("reports not-found rather than deleting another environment's row", async () => {
		expect(
			await deleteProjectComponent("cluster", PROJ, "", ENV_OTHER),
		).toBe(false);

		const rows = await getServiceDb()
			.select()
			.from(projectCluster)
			.where(eq(projectCluster.project_id, PROJ));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.environment_id).toBe(ENV_DEFAULT);
	});

	// listProjectComponents used to ignore its environment and flatten every environment's rows
	// together — the same kind twice with nothing in the wire to tell them apart.
	it("lists scoped to one environment, and unscoped lists all", async () => {
		await insertProjectComponent("cluster", PROJ, ENV_OTHER, "", {
			node_desired_size: 9,
			instance_types: ["Standard_D2s_v3"],
		});

		expect(await listProjectComponents(PROJ, "cluster")).toHaveLength(2);
		const scoped = await listProjectComponents(PROJ, "cluster", ENV_DEFAULT);
		expect(scoped).toHaveLength(1);
		expect(scoped[0]?.config.environment_id).toBe(ENV_DEFAULT);
	});
});
