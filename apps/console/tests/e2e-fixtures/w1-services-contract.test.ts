// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W1 — the service/workload CONTRACT-LOCK (#572). Three every-PR proofs over the seam (#568)
// + server lane (#569):
//
//   1. zod: a maximal service (every contract field, both source variants) parses through
//      projectFormSchema, and the parsed form survives a JSON serialization round-trip — the
//      wire-stability the form/AI round-trip relies on.
//   2. snapshot: the REAL buildConfigSnapshot (driven via provisionProject, the same DEPLOY
//      enqueue the console runs) emits `services` — each project_services row spread onto the
//      wire with its resolved placement — so a service designed on the canvas actually reaches
//      the runner.
//   3. shape-parity fixture: the emitted `services` wire is frozen into a shared fixture
//      (test/e2e/fixtures/w1_services.json) that the Go side strict-checks against
//      types.ProjectServiceConfig (test/e2e/w1_services_contract_pure_test.go). A TS-side key
//      rename regenerates the fixture and zero-fills the Go decode → the Go test reds. Neither
//      side can drift silently.
//
// Regenerate after an intentional contract change:  UPDATE_FIXTURES=1 pnpm -C apps/console run test
// w1-services-contract

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), withScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/billing/usage-guard", () => ({ assertUsageAllowed: vi.fn() }));
vi.mock("@/lib/authz/runner-org", () => ({ assertRunnerInOrg: vi.fn() }));

import { provisionProject } from "@/app/server/actions/projects";
import { requireOwner } from "@/lib/auth/owner";
import { authorize } from "@/lib/authz/guard";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { getServiceDb, withActorScope, withScope } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	projectCluster,
	projectEnvironments,
	projectServices,
	projects,
} from "@/lib/db/schema";
import { projectFormSchema } from "@/lib/validations/project-form.schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/console/tests/e2e-fixtures → repo root is four levels up.
const FIXTURE = join(__dirname, "../../../../test/e2e/fixtures/w1_services.json");

// ============================================================
// The canonical W1 services — deterministic project_services ROWS (exactly what a drizzle
// select returns: every column, fixed literals). `web` is MAXIMAL — every optional contract
// field populated — so the Go re-marshal check sees every omitempty key on the wire. `worker`
// is the other source variant with the nullable fields NULL.
// ============================================================

const webRow = {
	id: "svc-web",
	project_id: "p1",
	environment_id: "env-1",
	name: "web",
	cloud_identity_id: null,
	region: null,
	type: "deployment",
	source: { kind: "repo", repo_url: "https://github.com/acme/web", path: "apps/web" },
	build: { dockerfile: "Dockerfile", context: "apps/web" },
	env: [
		{ name: "LOG_LEVEL", value: "info" },
		{ name: "PORT", value: "8080" },
	],
	ports: [
		{ name: "http", container_port: 8080, protocol: "TCP" },
		{ name: "metrics", container_port: 9090, protocol: "UDP" },
	],
	replicas: 3,
	resources: {
		requests: { cpu: "100m", memory: "128Mi" },
		limits: { cpu: "500m", memory: "512Mi" },
	},
	probe: { type: "http", path: "/healthz", port: 8080 },
	status: "PENDING",
	status_message: null,
	estimated_monthly_cost: null,
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-01T00:00:00.000Z",
};

const workerRow = {
	...webRow,
	id: "svc-worker",
	name: "worker",
	type: "job",
	source: { kind: "image", image: "ghcr.io/acme/worker:1.2.3" },
	build: null,
	env: [],
	ports: [],
	replicas: 1,
	resources: null,
	probe: { type: "tcp", port: 9000 },
};

// The same services as FORM fragments (what the canvas/AI emits — auto/scope columns stripped,
// mirroring componentAutoFields + the env scoping the save path owns).
const rowToFragment = <T extends Record<string, unknown>>({
	id: _id,
	project_id: _p,
	environment_id: _e,
	status: _s,
	status_message: _sm,
	estimated_monthly_cost: _c,
	created_at: _ca,
	updated_at: _ua,
	...fragment
}: T) => fragment;

// A complete valid form baseline (mirrors service-schema.test.ts) — vary only `services`.
const validForm = {
	project: {
		project_name: "my-project",
		environment_stage: "development" as const,
		region: "eu-west-1",
		cloud_identity_id: "660e8400-e29b-41d4-a716-446655440000",
		iac_version: "1.11.4",
	},
	network: { provision_network: true, cidr_block: "10.0.0.0/16", single_nat_gateway: true },
	cluster: {
		cluster_version: "1.32",
		provider_config: { enable_karpenter: true },
		instance_types: ["t3.medium"],
		node_min_size: 2,
		node_max_size: 5,
		node_desired_size: 2,
	},
	dns: { enabled: false },
	repositories: {},
};

type Rows = unknown[];

/** A table-aware, thenable drizzle-ish tx wired through withActorScope — the same seam the
 * project-action tests stub. Awaiting a SELECT resolves to `select.get(table)` (else []); an
 * INSERT ... returning to `insert.get(table)`. Records `.values()` payloads keyed by table. */
function setupDb(select: Map<unknown, Rows>, insert: Map<unknown, Rows>) {
	const valuesSpy = vi.fn<(table: unknown, payload: unknown) => void>();
	function makeChain(op: "select" | "insert", table?: unknown) {
		let from = table;
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			from: (t: unknown) => {
				from = t;
				return c;
			},
			leftJoin: () => c,
			innerJoin: () => c,
			where: () => c,
			limit: () => c,
			orderBy: () => c,
			onConflictDoNothing: () => c,
			returning: () => c,
			values: (payload: unknown) => {
				valuesSpy(from, payload);
				return c;
			},
			then: (res: (v: Rows) => void) =>
				res(op === "insert" ? (insert.get(from) ?? []) : (select.get(from) ?? [])),
		});
		return c;
	}
	const tx = {
		select: () => makeChain("select"),
		insert: (t: unknown) => makeChain("insert", t),
		update: () => makeChain("select"),
		delete: () => makeChain("select"),
		execute: () => Promise.resolve([{ updated: true }]),
	};
	vi.mocked(withActorScope).mockImplementation(
		((_owner: string, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	vi.mocked(withScope).mockImplementation(
		((_scope: unknown, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	vi.mocked(getServiceDb).mockReturnValue({} as never);
	return valuesSpy;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	vi.mocked(requireOwner).mockResolvedValue("user-1" as never);
	vi.mocked(assertUsageAllowed).mockResolvedValue(undefined as never);
});
afterEach(() => vi.restoreAllMocks());

describe("W1 services contract-lock (#572)", () => {
	it("zod parses the maximal service fixture and it survives a serialization round-trip", () => {
		const services = [rowToFragment(webRow), rowToFragment(workerRow)];
		const first = projectFormSchema.safeParse({ ...validForm, services });
		expect(first.success).toBe(true);
		if (!first.success) return;
		expect(first.data.services.map((s) => s.name)).toEqual(["web", "worker"]);

		// Wire-stability: parse → JSON → parse is a fixed point (defaults applied once, nothing
		// lost or mutated by serialization — the property the form/AI round-trip relies on).
		const second = projectFormSchema.parse(JSON.parse(JSON.stringify(first.data)));
		expect(second).toEqual(first.data);
	});

	it("the REAL buildConfigSnapshot emits services with resolved placement, frozen as the shared Go fixture", async () => {
		// The same canonical cheap-Hetzner base the A0.5 fidelity fixture uses + the two rows.
		const select = new Map<unknown, Rows>([
			[
				projects,
				[
					{
						id: "p1",
						user_id: "user-1",
						org_id: "org-1",
						cloud_identity_id: "ci-1",
						project_name: "alethia-fixture",
						slug: "alethia-fixture",
						region: "nbg1",
						iac_version: "1.0.0",
					},
				],
			],
			[
				projectEnvironments,
				[
					{
						id: "env-1",
						name: "fixture",
						stage: "development",
						status: "DRAFT",
						is_default: true,
						region: null,
					},
				],
			],
			[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
			[
				projectCluster,
				[
					{
						cluster_version: "",
						instance_types: [],
						node_min_size: 1,
						node_max_size: 1,
						node_desired_size: 1,
						cluster_admins: [],
						provider_config: {},
					},
				],
			],
			[projectServices, [webRow, workerRow]],
		]);
		const insert = new Map<unknown, Rows>([[jobs, [{ id: "job-1" }]]]);
		const valuesSpy = setupDb(select, insert);

		await provisionProject("p1");

		const jobCall = valuesSpy.mock.calls.find((c) => c[0] === jobs);
		if (!jobCall) throw new Error("no DEPLOY job insert recorded");
		const snapshot = (jobCall[1] as { config_snapshot: { services?: unknown[] } })
			.config_snapshot;

		// The snapshot wire is an EXPLICIT PICK of each row (#1974) — the json tags of
		// types.ProjectServiceConfig and nothing else — plus its resolved placement (NULL placement
		// inherits the project's identity/region, what the runner actually keys its cloud auth on).
		// `bindings` is reconstructed from the service_bindings child table (JSONB dropped, #1426) —
		// [] here since the mock seeds no binding rows.
		//
		// Spelled out rather than `{ ...webRow, ... }`: a spread of the seed row would re-assert
		// whatever the seed happens to hold, so it passed vacuously while the wire still carried
		// eight bookkeeping columns. Naming the keys is what makes the drop visible in review.
		const placement = { cloud_provider: "hetzner", cloud_identity_id: "ci-1", region: "nbg1" };
		const wireOf = (row: typeof webRow | typeof workerRow) => ({
			name: row.name,
			type: row.type,
			source: row.source,
			build: row.build,
			env: row.env,
			bindings: [],
			ports: row.ports,
			replicas: row.replicas,
			resources: row.resources,
			probe: row.probe,
			// The mocked rows have no resolved_image column; a REAL row does, and it must survive
			// the pick (W2 #591). config_snapshot_components.aws.json covers the populated case.
			resolved_image: undefined,
			...placement,
		});
		expect(snapshot.services).toEqual([wireOf(webRow), wireOf(workerRow)]);
		// The bookkeeping columns the spread used to carry are GONE — assert it directly, so a
		// regression cannot hide inside a regenerated fixture.
		for (const svc of snapshot.services as Array<Record<string, unknown>>) {
			for (const k of [
				"id",
				"project_id",
				"environment_id",
				"status",
				"status_message",
				"estimated_monthly_cost",
				"created_at",
				"updated_at",
			]) {
				expect(svc, `services wire still carries the DB column ${k}`).not.toHaveProperty(k);
			}
		}

		// Freeze the wire into the shared fixture the Go contract test consumes.
		const serialized = `${JSON.stringify(snapshot.services, null, "\t")}\n`;
		if (process.env.UPDATE_FIXTURES) {
			mkdirSync(dirname(FIXTURE), { recursive: true });
			writeFileSync(FIXTURE, serialized);
		}
		expect(
			existsSync(FIXTURE),
			`fixture missing — regenerate with UPDATE_FIXTURES=1`,
		).toBe(true);
		// Deep-equal against the committed fixture: any drift between the snapshot's service wire
		// and the fixture the Go side trusts reds here (regenerate intentionally).
		expect(JSON.parse(serialized)).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
	});
});
