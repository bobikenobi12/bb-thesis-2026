// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `insertProjectComponent` must stamp a fabric-carrying row with its environment's Fabric.
//
// This is the unit test for the defect that made the isolation ladder impossible. `project_cluster`
// was written env-keyed with `fabric_id` left null on every runtime path — the only thing that ever
// filled it was a migration-time backfill, which by construction cannot reach a project created
// afterwards. A null there does not present as a null: `resolveServingCluster` falls back to the
// env-keyed row, so the Fabric's own `dedicated` environment provisions perfectly, while every
// `namespace`/`vcluster` environment — which owns no cluster row and can ONLY resolve by Fabric —
// fails closed with "no serving cluster on the config snapshot" against a cluster that is ACTIVE
// and serving.
//
// Only `getServiceDb` is mocked; the function under test runs for real, including the branch that
// decides whether to look the Fabric up at all. The ON CONFLICT arm is asserted separately because
// `component add` UPSERTS — amending an existing row is the common case, and it is what lets the
// fix reach projects created before it without a data migration.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ENV_ID = "11111111-1111-4111-8111-111111111111";
const FABRIC_ID = "22222222-2222-4222-8222-222222222222";
const PROJ_ID = "33333333-3333-4333-8333-333333333333";

/** The env row the Fabric lookup returns; null models an env not yet linked to a Fabric. */
let envRow:
	| { fabric_id: string | null; placement_mode: "dedicated" | "namespace" }
	| undefined;
/** What the insert was actually asked to write, and what it would write ON CONFLICT. */
let captured: {
	values?: Record<string, unknown>;
	conflictSet?: Record<string, unknown>;
};

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		// db.select({...}).from(t).where(x).limit(1) → [envRow]
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => (envRow ? [envRow] : []),
				}),
			}),
		}),
		// db.insert(t).values(v).onConflictDoUpdate({set}).returning() → [row]
		insert: () => ({
			values: (v: Record<string, unknown>) => {
				captured.values = v;
				const returning = async () => [{ id: "row-1", ...v }];
				return {
					onConflictDoUpdate: (arg: { set: Record<string, unknown> }) => {
						captured.conflictSet = arg.set;
						return { returning };
					},
					returning,
				};
			},
		}),
	}),
}));

const { insertProjectComponent } = await import("@/lib/cli/project-components");

describe("insertProjectComponent — Fabric linkage", () => {
	beforeEach(() => {
		captured = {};
		envRow = { fabric_id: FABRIC_ID, placement_mode: "dedicated" };
	});

	it("stamps the environment's fabric_id onto a cluster row", async () => {
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {
			cluster_version: "1.35",
		});
		expect(captured.values?.fabric_id).toBe(FABRIC_ID);
		// The env scoping the row must survive alongside it — the Fabric is additional, not a swap.
		expect(captured.values?.environment_id).toBe(ENV_ID);
		expect(captured.values?.project_id).toBe(PROJ_ID);
	});

	it("carries the linkage into the ON CONFLICT arm, so an upsert REPAIRS an existing row", async () => {
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {
			cluster_version: "1.35",
		});
		// `component add` is the only way to amend a component, and the row being amended is very
		// often one written before this fix — with a null fabric_id.
		expect(captured.conflictSet?.fabric_id).toBe(FABRIC_ID);
		expect(captured.conflictSet?.cluster_version).toBe("1.35");
	});

	it("leaves fabric_id unset when the environment is not linked to a Fabric yet", async () => {
		envRow = { fabric_id: null, placement_mode: "dedicated" };
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {
			cluster_version: "1.35",
		});
		// Fail open rather than invent one: a transitional env the backfill has not reached still
		// resolves through resolveServingCluster's env-key fallback.
		expect(captured.values?.fabric_id).toBeNull();
		expect(captured.conflictSet?.fabric_id).toBeNull();
	});

	it("does not claim the shared Fabric for a namespace environment", async () => {
		envRow = { fabric_id: FABRIC_ID, placement_mode: "namespace" };
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {
			cluster_version: "1.35",
		});
		expect(captured.values?.fabric_id).toBeUndefined();
		expect(captured.conflictSet?.fabric_id).toBeNull();
	});

	it("uses the dedicated environment's authoritative Fabric over caller input", async () => {
		const explicit = "44444444-4444-4444-8444-444444444444";
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {
			fabric_id: explicit,
		});
		expect(captured.values?.fabric_id).toBe(FABRIC_ID);
	});

	it("drops an explicit fabric_id for a namespace environment", async () => {
		envRow = { fabric_id: FABRIC_ID, placement_mode: "namespace" };
		await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {
			fabric_id: FABRIC_ID,
		});
		expect(captured.values?.fabric_id).toBeUndefined();
		expect(captured.conflictSet?.fabric_id).toBeNull();
	});

	it("does not add fabric_id to a table that has no such column", async () => {
		// `repositories` is env-scoped, not Fabric-scoped. Keying the behaviour on the COLUMN rather
		// than on the kind is what keeps this honest as kinds are added.
		await insertProjectComponent("repositories", PROJ_ID, ENV_ID, "", {
			apps_path: "examples/online-boutique/overlays/prod",
		});
		expect(captured.values).not.toHaveProperty("fabric_id");
		expect(captured.conflictSet).not.toHaveProperty("fabric_id");
	});
});
