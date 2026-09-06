// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the project CRUD/provision actions. We stub ONLY the seams:
// the PDP guard (authorize), the owner resolver (requireOwner), the usage gate, the scaler
// notifier, the authz hierarchy mirror, and a table-aware thenable drizzle chain wired through
// withActorScope. The pure helpers stay REAL — routing (slugify/pickFreeSlug + reserved slugs)
// and the cloud-provider converter (convertProjectConfig) — so the slug-collision logic and the
// provider-mapping warnings are genuinely exercised, not re-implemented here. Each test asserts
// the persisted .values()/.set() payloads, derived return shapes, and the branch outcomes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	currentActor: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
	withActorScope: vi.fn(),
	withScope: vi.fn(),
	getServiceDb: vi.fn(),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/billing/usage-guard", () => ({ assertUsageAllowed: vi.fn() }));
vi.mock("@/lib/authz/tuple-sync", () => ({ mirrorHierarchyEdge: vi.fn() }));
// SPIED, not replaced. UNSUPPORTED_KINDS_BY_PROVIDER is EMPTY since #3228 — Hetzner was the last
// cloud refusing a kind, and nosql was its last entry — so `blocked.size > 0` is now false for
// every real provider and the fail-closed kind gate never executes in production. A gate with no
// live case is a gate nothing proves, and deleting its test would have retired the wiring silently.
// So the module stays REAL (importOriginal) and only the lookup is overridable, per test, which
// exercises the gate exactly as a future exclusion would.
vi.mock("@/lib/cloud-providers/unsupported-kinds", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/cloud-providers/unsupported-kinds")>();
	return { ...actual, unsupportedKindsFor: vi.fn(actual.unsupportedKindsFor) };
});

import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ProjectNameTakenError } from "@/lib/queries/projects";
import {
	addEnvironment,
	createProject,
	deleteEnvironment,
	deleteProject,
	destroyProject,
	duplicateProjectForProvider,
	getProject,
	getProjectAsFormData,
	getProjectEnvironments,
	getProjects,
	getProjectsList,
	planProject,
	provisionProject,
	updateProjectName,
} from "@/app/server/actions/projects";
import { requireOwner } from "@/lib/auth/owner";
import { authorize, currentActor } from "@/lib/authz/guard";
import { mirrorHierarchyEdge } from "@/lib/authz/tuple-sync";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { unsupportedKindsFor } from "@/lib/cloud-providers/unsupported-kinds";
import { getServiceDb, withActorScope, withScope } from "@/lib/db";
import {
	auditLog,
	cloudIdentities,
	jobs,
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectDns,
	projectEnvironments,
	projectFabrics,
	projectIacSources,
	projectNetwork,
	projectNosqlTables,
	projectQueues,
	projectRepositories,
	projectSecrets,
	projectServices,
	projectStorageBuckets,
	projectTopics,
	projects,
	resourceHierarchy,
	runners,
	serviceBindingInjections,
	serviceBindings,
} from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import type { ServiceBinding } from "@/types/jsonb.types";

/**
 * Convert the ServiceBinding[] these tests author into the service_bindings + injection child rows the
 * reader reconstructs from — bindings moved off the parent JSONB into those tables (#1426). Mirrors the
 * writer (`insertServiceBindings`); `ordinal` = array index on both levels. The mock tx ignores WHERE
 * clauses, so seeding these under [serviceBindings]/[serviceBindingInjections] drives the reconstruction.
 */
function bindingChildRows(serviceId: string, bindings: ServiceBinding[]) {
	const sbRows: Record<string, unknown>[] = [];
	const injRows: Record<string, unknown>[] = [];
	bindings.forEach((b, i) => {
		const id = `${serviceId}-b${i}`;
		sbRows.push({
			id,
			service_id: serviceId,
			chart_workload_id: null,
			target_kind: b.target.kind,
			target_name: b.target.name,
			target_address: b.target.address ?? null,
			output_endpoint: b.target.output_keys?.endpoint ?? null,
			output_port: b.target.output_keys?.port ?? null,
			output_credential_secret: b.target.output_keys?.credential_secret ?? null,
			ordinal: i,
		});
		b.inject.forEach((inj, j) =>
			injRows.push({ binding_id: id, env: inj.env, from_facet: inj.from, ordinal: j }),
		);
	});
	return { sbRows, injRows };
}

/**
 * Stubs getServiceDb so the defense-in-depth assigned-runner lookup
 * (assertRunnerInOrg → select org_id from runners) resolves to `runnerOrgId`.
 * Passing the caller's org (default "org-1") makes the runner in-org; a different
 * value simulates a cross-org assignment.
 */
function mockRunnerLookup(runnerOrgId: string | null = "org-1") {
	vi.mocked(getServiceDb).mockReturnValue({
		select: () => ({
			from: (t: unknown) => ({
				where: () => ({
					limit: () =>
						Promise.resolve(
							t === runners && runnerOrgId !== null
								? [{ org_id: runnerOrgId }]
								: [],
						),
				}),
			}),
		}),
	} as never);
}

type Rows = unknown[];
type RowsResolver = Rows | (() => Rows);

/**
 * Builds a table-aware, thenable drizzle-ish tx and wires it through withActorScope.
 * Every builder returns the chain; awaiting a SELECT resolves to `cfg.select.get(table)`
 * and a returning INSERT to `cfg.insert.get(table)` (a function value is called fresh each
 * time, which lets a single table answer differently across sequential queries). Records the
 * `.values()` / `.set()` payloads keyed by their table plus insert/update/delete spies.
 */
function setupDb(cfg: {
	select?: Map<unknown, RowsResolver>;
	insert?: Map<unknown, RowsResolver>;
	/** Per-table result for `tx.update(...)`. A resolver that THROWS models a constraint violation
	 *  on the write — the only way to reach a catch branch that maps a driver error. */
	update?: Map<unknown, RowsResolver>;
	default?: Rows;
	/** Result of the env-status CAS RPC (set_env_status via tx.execute). true = env moved. */
	envCasUpdated?: boolean;
}) {
	const valuesSpy = vi.fn<(table: unknown, payload: unknown) => void>();
	const setSpy = vi.fn<(table: unknown, payload: unknown) => void>();
	const insertSpy = vi.fn<(table: unknown) => void>();
	const updateSpy = vi.fn<(table: unknown) => void>();
	const deleteSpy = vi.fn<(table: unknown) => void>();
	const executeSpy = vi.fn<(query: unknown) => void>();
	const envCasUpdated = cfg.envCasUpdated ?? true;
	const def = cfg.default ?? [];

	const resolve = (
		map: Map<unknown, RowsResolver> | undefined,
		table: unknown,
	): Rows => {
		const v = map?.get(table);
		if (typeof v === "function") return v();
		return v ?? def;
	};

	function makeChain(
		op: "select" | "insert" | "update" | "delete",
		table?: unknown,
	) {
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
			set: (payload: unknown) => {
				setSpy(from, payload);
				return c;
			},
			then: (res: (v: Rows) => void) =>
				res(
					op === "insert"
						? resolve(cfg.insert, from)
						: op === "select"
							? resolve(cfg.select, from)
							: op === "update"
								? resolve(cfg.update, from)
								: def,
				),
		});
		return c;
	}

	const tx = {
		select: () => makeChain("select"),
		insert: (t: unknown) => {
			insertSpy(t);
			return makeChain("insert", t);
		},
		update: (t: unknown) => {
			updateSpy(t);
			return makeChain("update", t);
		},
		delete: (t: unknown) => {
			deleteSpy(t);
			return makeChain("delete", t);
		},
		// The enqueue paths route env→QUEUED through the set_env_status CAS (tx.execute).
		execute: (query: unknown) => {
			executeSpy(query);
			return Promise.resolve([{ updated: envCasUpdated }]);
		},
	};

	vi.mocked(withActorScope).mockImplementation(((
		_owner: string,
		cb: (tx: unknown) => unknown,
	) => cb(tx)) as never);
	// createProject scopes to the ACTIVE ORG via withScope({ownerId, orgId}); wire it the same way.
	vi.mocked(withScope).mockImplementation(((
		_scope: unknown,
		cb: (tx: unknown) => unknown,
	) => cb(tx)) as never);
	return { tx, valuesSpy, setSpy, insertSpy, updateSpy, deleteSpy, executeSpy };
}

/** Pulls the single `.values()` payload recorded against a given schema table. */
function valuesFor(
	spy: ReturnType<typeof vi.fn>,
	table: unknown,
): Record<string, unknown> {
	const call = spy.mock.calls.find((c) => c[0] === table);
	if (!call) throw new Error("no values() recorded for table");
	return call[1] as Record<string, unknown>;
}

function valueRowsFor(
	spy: ReturnType<typeof vi.fn>,
	table: unknown,
): Record<string, unknown>[] {
	const call = spy.mock.calls.find((c) => c[0] === table);
	if (!call) throw new Error("no values() recorded for table");
	const rows = call[1];
	if (!Array.isArray(rows))
		throw new Error("values() payload was not an array");
	return rows as Record<string, unknown>[];
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({
		userId: "user-1",
		orgId: "org-1",
	} as never);
	vi.mocked(currentActor).mockResolvedValue({
		userId: "user-1",
		orgId: "org-1",
	} as never);
	vi.mocked(requireOwner).mockResolvedValue("user-1" as never);
	vi.mocked(assertUsageAllowed).mockResolvedValue(undefined as never);
	// Default: any client-supplied assigned runner belongs to the caller's org.
	mockRunnerLookup("org-1");
});

// ============================================================
// createProject
// ============================================================

describe("createProject", () => {
	const baseInput = {
		project: {
			project_name: "My App",
			environment_stage: "production",
			region: "us-east-1",
			cloud_identity_id: "ci-1",
			iac_version: "1.9.5",
		},
		network: {
			provision_network: true,
			cidr_block: "10.0.0.0/16",
			single_nat_gateway: true,
		},
		cluster: {
			cluster_version: "1.31",
			instance_types: ["m5.large"],
			node_min_size: 2,
			node_max_size: 5,
			node_desired_size: 2,
			cluster_admins: [],
			provider_config: {},
		},
		dns: { enabled: false },
		repositories: { apps_destination_repo: "git@x" },
		databases: [{ name: "db1", engine: "postgres" }],
		secrets: [{ name: "s1" }],
	};

	it("derives a collision-free slug, seeds the default env + hierarchy edge, persists components, and audits", async () => {
		const { valuesSpy, insertSpy } = setupDb({
			// An existing project already owns the SLUG "my-app" — but is named something else, so
			// the create is a slug collision (de-duplicated to `my-app-2`) and NOT a name
			// collision (which #3145 now refuses outright). The row carries `project_name`
			// because insertProjectWithDefaultFabric selects it: a fixture missing a column the
			// query asks for is not a smaller version of the wire shape, it is a different one,
			// and the production code reading it crashed rather than being "leniently" typed.
			select: new Map([[projects, [{ slug: "my-app", project_name: "Some Other Project" }]]]),
			insert: new Map<unknown, RowsResolver>([
				[
					projects,
					[{ id: "p1", org_id: "org-1", slug: "my-app-2", user_id: "user-1" }],
				],
				[projectFabrics, [{ id: "fabric-1" }]],
				[projectEnvironments, [{ id: "env-1" }, { id: "env-preview" }]],
			]),
		});

		const r = await createProject(baseInput as never);

		expect(authorize).toHaveBeenCalledWith("create", { type: "project" });

		// pickFreeSlug bumped the collision to "my-app-2"; environment_stage is destructured OUT
		// of the projects row (it seeds the env, it is not a project column).
		const projVals = valuesFor(valuesSpy, projects);
		expect(projVals).toMatchObject({
			slug: "my-app-2",
			user_id: "user-1",
			// Stamped to the ACTIVE ORG (actor.orgId), not the creating user — the whole point of the
			// fix. Here orgId ("org-1") ≠ userId ("user-1"), the EE case where the old code mis-scoped
			// the project (org_id = user_id) and hid it from its own creator.
			org_id: "org-1",
			region: "us-east-1",
			cloud_identity_id: "ci-1",
			iac_version: "1.9.5",
		});
		expect(projVals).not.toHaveProperty("environment_stage");

		expect(valuesFor(valuesSpy, projectFabrics)).toEqual({
			project_id: "p1",
			user_id: "user-1",
			org_id: "org-1",
			name: "production",
			cloud_identity_id: "ci-1",
			region: "us-east-1",
			status: "DRAFT",
		});

		// default + preview environments are seeded with explicit placement.
		expect(valueRowsFor(valuesSpy, projectEnvironments)).toEqual([
			{
				project_id: "p1",
				user_id: "user-1",
				org_id: "org-1",
				name: "production",
				stage: "production",
				status: "DRAFT",
				is_default: true,
				region: "us-east-1",
				fabric_id: "fabric-1",
				placement_mode: "dedicated",
			},
			{
				project_id: "p1",
				user_id: "user-1",
				org_id: "org-1",
				name: "preview",
				stage: "development",
				status: "DRAFT",
				is_default: false,
				region: "us-east-1",
				fabric_id: "fabric-1",
				placement_mode: "namespace",
				namespace: "preview",
			},
		]);

		// authz hierarchy edge project → org (both the DB row and the FGA mirror). Parent is the ORG
		// (actor.orgId), so the org's grants flow down to the project — pointing it at the creating
		// user would strand the project under a phantom org.
		expect(valuesFor(valuesSpy, resourceHierarchy)).toEqual({
			child_type: "project",
			child_id: "p1",
			parent_type: "org",
			parent_id: "org-1",
		});
		expect(mirrorHierarchyEdge).toHaveBeenCalledWith(
			"project",
			"p1",
			"org",
			"org-1",
		);

		// singleton + collection components are scoped to the new project id
		expect(valuesFor(valuesSpy, projectNetwork)).toMatchObject({
			project_id: "p1",
			provision_network: true,
		});
		expect(valuesFor(valuesSpy, projectDatabases)).toEqual([
			{
				project_id: "p1",
				environment_id: "env-1",
				name: "db1",
				engine: "postgres",
			},
		]);
		expect(valuesFor(valuesSpy, projectSecrets)).toEqual([
			{ project_id: "p1", environment_id: "env-1", name: "s1" },
		]);

		expect(valuesFor(valuesSpy, auditLog)).toMatchObject({
			project_id: "p1",
			user_id: "user-1",
			action: "CREATED",
			changes: { project_name: "My App", environment: "production" },
		});

		expect(insertSpy).toHaveBeenCalledWith(projects);
		expect(r).toEqual({
			project: {
				id: "p1",
				org_id: "org-1",
				slug: "my-app-2",
				user_id: "user-1",
			},
		});
	});

	it("skips reserved project-child slugs (settings → settings-2)", async () => {
		const { valuesSpy } = setupDb({
			select: new Map([[projects, []]]), // no existing projects, the reservation alone collides
			insert: new Map<unknown, RowsResolver>([
				[projects, [{ id: "p2", org_id: "org-1" }]],
				[projectFabrics, [{ id: "fabric-1" }]],
				[projectEnvironments, [{ id: "env-1" }, { id: "env-preview" }]],
			]),
		});

		await createProject({
			...baseInput,
			project: { ...baseInput.project, project_name: "Settings" },
			databases: [],
			secrets: [],
		} as never);

		expect(valuesFor(valuesSpy, projects).slug).toBe("settings-2");
	});

	it("throws when the project insert returns nothing", async () => {
		setupDb({
			select: new Map([[projects, []]]),
			insert: new Map([[projects, []]]),
		});
		await expect(createProject(baseInput as never)).rejects.toThrow(
			/Failed to create project/,
		);
	});

	it("throws when the Fabric insert returns nothing", async () => {
		setupDb({
			select: new Map([[projects, []]]),
			insert: new Map<unknown, RowsResolver>([
				[projects, [{ id: "p1", org_id: "org-1" }]],
				[projectFabrics, []],
			]),
		});
		await expect(createProject(baseInput as never)).rejects.toThrow(
			/Failed to create default Fabric/,
		);
	});

	it("throws when either required environment insert row is missing", async () => {
		setupDb({
			select: new Map([[projects, []]]),
			insert: new Map<unknown, RowsResolver>([
				[projects, [{ id: "p1", org_id: "org-1" }]],
				[projectFabrics, [{ id: "fabric-1" }]],
				[projectEnvironments, [{ id: "env-1" }]],
			]),
		});
		await expect(createProject(baseInput as never)).rejects.toThrow(
			/Failed to create project environments/,
		);
	});

	it("propagates the guard rejection without touching the db", async () => {
		vi.mocked(authorize).mockRejectedValueOnce(new Error("forbidden"));
		setupDb({});
		await expect(createProject(baseInput as never)).rejects.toThrow(
			/forbidden/,
		);
		expect(withActorScope).not.toHaveBeenCalled();
	});
});

// ============================================================
// getProjectsList
// ============================================================

describe("getProjectsList", () => {
	it("surfaces each project's default-env name/status, defaulting when the env join is null", async () => {
		setupDb({
			select: new Map([
				[
					projects,
					[
						{
							project: { id: "p1", project_name: "A" },
							env_name: "prod",
							env_status: "DEPLOYED",
						},
						{
							project: { id: "p2", project_name: "B" },
							env_name: null,
							env_status: null,
						},
					],
				],
			]),
		});

		const r = await getProjectsList();
		expect(authorize).toHaveBeenCalledWith("view", { type: "project" });
		expect(r.projects).toEqual([
			{
				id: "p1",
				project_name: "A",
				environment_stage: "prod",
				status: "DEPLOYED",
			},
			{
				id: "p2",
				project_name: "B",
				environment_stage: "development",
				status: "DRAFT",
			},
		]);
	});
});

// ============================================================
// getProject
// ============================================================

describe("getProject", () => {
	const fullSelect = () =>
		new Map<unknown, RowsResolver>([
			[
				projects,
				[
					{
						id: "p1",
						org_id: "org-1",
						cloud_identity_id: "ci-1",
						region: "us-east-1",
						iac_version: "1.9.5",
						project_name: "My App",
						slug: "my-app",
					},
				],
			],
			[
				projectNetwork,
				[{ provision_network: true, cidr_block: "10.0.0.0/16" }],
			],
			[
				projectCluster,
				[{ cluster_version: "1.31", instance_types: ["m5.large"] }],
			],
			[projectDns, [{ enabled: false }]],
			[projectRepositories, [{ apps_destination_repo: "git@x" }]],
			[projectDatabases, [{ name: "db1", engine: "postgres" }]],
			[
				projectSecrets,
				[{ name: "s1", generate: true, length: 32, special_chars: true }],
			],
			[
				projectEnvironments,
				[
					{
						id: "env-1",
						name: "production",
						stage: "production",
						status: "DEPLOYED",
						is_default: true,
					},
				],
			],
			[cloudIdentities, [{ provider: "gcp" }]],
		]);

	it("assembles the project + components and resolves the cloud provider from the identity", async () => {
		setupDb({ select: fullSelect() });
		const r = await getProject("p1");

		expect(authorize).toHaveBeenCalledWith("view", {
			type: "project",
			id: "p1",
		});
		expect(r.project.environment_stage).toBe("production");
		expect(r.project.status).toBe("DEPLOYED");
		expect(r.project.default_environment_id).toBe("env-1");
		expect(r.cloudProvider).toBe("gcp");
		expect(r.components.databases).toEqual([
			{ name: "db1", engine: "postgres" },
		]);
		expect(r.components.network).toMatchObject({ provision_network: true });
		expect(r.environments).toHaveLength(1);
	});

	it("calls notFound() when the project row is missing", async () => {
		setupDb({ select: new Map([[projects, []]]) });
		// A stale/deleted id on this render loader → Next notFound() (digest NEXT_HTTP_ERROR_FALLBACK),
		// not a captured Error.
		await expect(getProject("missing")).rejects.toThrow(
			/NEXT_HTTP_ERROR_FALLBACK/,
		);
	});

	it("defaults the cloud provider to aws when no identity is linked (no identity query)", async () => {
		const m = fullSelect();
		m.set(projects, [
			{
				id: "p1",
				org_id: "org-1",
				cloud_identity_id: null,
				region: "x",
				iac_version: "1",
			},
		]);
		m.set(cloudIdentities, () => {
			throw new Error("cloud identity must NOT be queried when none is linked");
		});
		setupDb({ select: m });
		const r = await getProject("p1");
		expect(r.cloudProvider).toBe("aws");
	});
});

// ============================================================
// getProjectAsFormData — W2 resolved_image strip (contract-lock #591)
// ============================================================

describe("getProjectAsFormData — resolved_image strip", () => {
	// getProjectAsFormData delegates to getProject for the component rows, then re-reads the
	// identity to resolve the provider — so the select map needs the project, its environment,
	// the identity, and the seeded service. Everything else defaults to [].
	const selectWithService = (serviceRow: Record<string, unknown>) =>
		new Map<unknown, RowsResolver>([
			[
				projects,
				[
					{
						id: "p1",
						org_id: "org-1",
						cloud_identity_id: "ci-1",
						region: "us-east-1",
						iac_version: "1.9.5",
						project_name: "My App",
						slug: "my-app",
					},
				],
			],
			[
				projectEnvironments,
				[
					{
						id: "env-1",
						name: "production",
						status: "DEPLOYED",
						is_default: true,
					},
				],
			],
			[cloudIdentities, [{ id: "ci-1", provider: "aws" }]],
			[projectServices, [serviceRow]],
		]);

	it("strips the build-output resolved_image from the design/form view, keeping the design fields", async () => {
		setupDb({
			select: selectWithService({
				name: "api",
				type: "deployment",
				source: {
					kind: "repo",
					repo_url: "https://github.com/acme/api",
					path: "apps/api",
				},
				build: { dockerfile: "apps/api/Dockerfile", context: "apps/api" },
				env: [],
				ports: [],
				replicas: 2,
				resources: null,
				probe: null,
				// The build write-back — provisioned state, must never surface as design input.
				resolved_image:
					"111122223333.dkr.ecr.us-east-1.amazonaws.com/acme-api@sha256:deadbeef",
			}),
		});

		const { formData } = await getProjectAsFormData("p1");

		expect(formData.services).toHaveLength(1);
		const svc = formData.services[0];
		// The digest is provisioned output, not user-editable design — it must not round-trip
		// into the form (otherwise the canvas would show a build artifact as configuration).
		expect(svc).not.toHaveProperty("resolved_image");
		// …but every real design field survives.
		expect(svc.name).toBe("api");
		expect(svc.type).toBe("deployment");
		expect(svc.source).toEqual({
			kind: "repo",
			repo_url: "https://github.com/acme/api",
			path: "apps/api",
		});
		expect(svc.build).toEqual({
			dockerfile: "apps/api/Dockerfile",
			context: "apps/api",
		});
		expect(svc.replicas).toBe(2);
	});

	it("round-trips a service's W3 bindings into the design/form view (bindings ARE design input)", async () => {
		// Unlike resolved_image (a build OUTPUT, stripped), bindings are the user's declared
		// service→infra edges — they must survive into the form so the canvas can re-render them.
		const bindings: ServiceBinding[] = [
			{
				target: { kind: "database", name: "orders-db" },
				inject: [
					{ env: "DATABASE_HOST", from: "endpoint" },
					{ env: "DATABASE_PASSWORD", from: "password" },
				],
			},
		];
		const { sbRows, injRows } = bindingChildRows("svc-api", bindings);
		const select = selectWithService({
			id: "svc-api",
			name: "api",
			type: "deployment",
			source: {
				kind: "repo",
				repo_url: "https://github.com/acme/api",
				path: ".",
			},
			env: [],
			ports: [],
			replicas: 2,
			resources: null,
			probe: null,
			resolved_image: null,
		});
		select.set(serviceBindings, sbRows);
		select.set(serviceBindingInjections, injRows);
		setupDb({ select });

		const { formData } = await getProjectAsFormData("p1");
		// Reconstructed from the child tables (JSONB dropped, #1426) — must round-trip byte-identically.
		expect(formData.services[0].bindings).toEqual(bindings);
	});
});

// ============================================================
// getProjectAsFormData — the secret store round-trips (#1412)
// ============================================================

describe("getProjectAsFormData — secrets provider round-trip", () => {
	// REGRESSION: this mapping used to emit only {name, generate, length, special_chars}, dropping
	// `provider` and `provider_config`. updateProjectDesign reconciles components delete-then-insert,
	// so the very next canvas deploy re-inserted every secret WITHOUT its store — the environment
	// silently fell back to the cluster's native secret manager and every binding to a Vault-backed
	// secret went unsatisfiable, with nothing reported. Same shape as the chart-repo wipe (#1301).
	it("carries provider + provider_config into the design/form view so a deploy can't wipe them", async () => {
		setupDb({
			select: new Map<unknown, RowsResolver>([
				[
					projects,
					[
						{
							id: "p1",
							org_id: "org-1",
							cloud_identity_id: "ci-1",
							region: "us-east-1",
							iac_version: "1.9.5",
							project_name: "My App",
							slug: "my-app",
						},
					],
				],
				[
					projectEnvironments,
					[{ id: "env-1", name: "production", status: "DEPLOYED", is_default: true }],
				],
				[cloudIdentities, [{ id: "ci-1", provider: "aws" }]],
				[
					projectSecrets,
					[
						{
							name: "stripe-key",
							generate: false,
							length: 32,
							special_chars: true,
							provider: "vault",
							provider_config: { mount_path: "secret", kv_version: "2" },
						},
					],
				],
			]),
		});

		const { formData } = await getProjectAsFormData("p1");

		expect(formData.secrets).toHaveLength(1);
		expect(formData.secrets[0]).toEqual(
			expect.objectContaining({
				name: "stripe-key",
				provider: "vault",
				provider_config: { mount_path: "secret", kv_version: "2" },
			}),
		);
	});

	// A native secret has no provider at all; it must round-trip as absent rather than as a string,
	// since "" and "native" are both the cluster's own store and only NULL is the column's sentinel.
	it("leaves a native secret's provider undefined", async () => {
		setupDb({
			select: new Map<unknown, RowsResolver>([
				[
					projects,
					[
						{
							id: "p1",
							org_id: "org-1",
							cloud_identity_id: "ci-1",
							region: "us-east-1",
							iac_version: "1.9.5",
							project_name: "My App",
							slug: "my-app",
						},
					],
				],
				[
					projectEnvironments,
					[{ id: "env-1", name: "production", status: "DEPLOYED", is_default: true }],
				],
				[cloudIdentities, [{ id: "ci-1", provider: "aws" }]],
				[
					projectSecrets,
					[{ name: "api-key", generate: true, length: 32, special_chars: true, provider: null }],
				],
			]),
		});

		const { formData } = await getProjectAsFormData("p1");
		expect(formData.secrets[0].provider).toBeUndefined();
	});
});


// ============================================================
// planProject / provisionProject (exercise buildConfigSnapshot)
// ============================================================

/** A select map sufficient for buildConfigSnapshot to succeed against a verified aws identity. */
function snapshotSelect(overrides?: Map<unknown, RowsResolver>) {
	const m = new Map<unknown, RowsResolver>([
		[
			projects,
			[
				{
					id: "p1",
					org_id: "org-1",
					cloud_identity_id: "ci-1",
					region: "us-east-1",
				},
			],
		],
		[
			projectEnvironments,
			[
				{
					id: "env-1",
					name: "production",
					stage: "production",
					status: "DRAFT",
					is_default: true,
					region: null,
					// A backfilled `dedicated` env owns its Fabric 1:1 (#836). BYO-IaC (#839) resolves
					// its source by this Fabric, so the default fixture carries it.
					fabric_id: "fab-1",
					placement_mode: "dedicated",
				},
			],
		],
		[projectFabrics, [{ id: "fab-1", project_id: "p1", name: "production" }]],
		[cloudIdentities, [{ id: "ci-1", provider: "aws" }]],
	]);
	if (overrides) for (const [k, v] of overrides) m.set(k, v);
	return m;
}

// #837: placement-aware dispatch — buildConfigSnapshot carries the Fabric + placement destination
// so the #838 provisioner can route (per-Fabric tofu state + ArgoCD Application destination).
describe("placement-aware dispatch (#837)", () => {
	it("a dedicated env carries its Fabric identity + a null namespace, keeping the state path byte-identical", async () => {
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[
						projectEnvironments,
						[
							{
								id: "env-1",
								name: "production",
								stage: "production",
								status: "DRAFT",
								is_default: true,
								region: null,
								fabric_id: "fab-1",
								placement_mode: "dedicated",
								namespace: null,
							},
						],
					],
					[
						projectFabrics,
						[{ id: "fab-1", project_id: "p1", name: "production" }],
					],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});

		await planProject("p1");

		const snapshot = valuesFor(valuesSpy, jobs).config_snapshot as Record<
			string,
			unknown
		>;
		expect(snapshot).toMatchObject({
			fabric_id: "fab-1",
			// A backfilled dedicated env: fabric name == env name, so `fabric_name` (the per-Fabric
			// state key #838 re-keys onto) and `environment_stage` agree → state path is unchanged.
			fabric_name: "production",
			environment_stage: "production",
			placement_mode: "dedicated",
			namespace: null,
		});
	});

	it("a namespace-placed env routes onto its shared Fabric and derives the destination namespace from the env name", async () => {
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[
						projectEnvironments,
						[
							{
								id: "env-9",
								name: "PR 123 Preview",
								stage: "development",
								status: "DRAFT",
								is_default: true,
								region: null,
								fabric_id: "fab-shared",
								placement_mode: "namespace",
								namespace: null,
							},
						],
					],
					[
						projectFabrics,
						[{ id: "fab-shared", project_id: "p1", name: "shared-dev" }],
					],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});

		await planProject("p1");

		const snapshot = valuesFor(valuesSpy, jobs).config_snapshot as Record<
			string,
			unknown
		>;
		expect(snapshot).toMatchObject({
			fabric_id: "fab-shared",
			// On a SHARED Fabric the tofu state keys on the Fabric, not the env → fabric_name != env name.
			fabric_name: "shared-dev",
			placement_mode: "namespace",
			// The ArgoCD destination namespace, derived as an RFC-1123 slug of the env name.
			namespace: "pr-123-preview",
		});
	});

	it("an explicit env namespace overrides the derived one", async () => {
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[
						projectEnvironments,
						[
							{
								id: "env-9",
								name: "staging",
								stage: "staging",
								status: "DRAFT",
								is_default: true,
								region: null,
								fabric_id: "fab-shared",
								placement_mode: "vcluster",
								namespace: "team-a",
							},
						],
					],
					[
						projectFabrics,
						[{ id: "fab-shared", project_id: "p1", name: "shared-dev" }],
					],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});

		await planProject("p1");

		const snapshot = valuesFor(valuesSpy, jobs).config_snapshot as Record<
			string,
			unknown
		>;
		expect(snapshot).toMatchObject({
			placement_mode: "vcluster",
			namespace: "team-a",
		});
	});

	it("falls back to the env identity when the Fabric link is not backfilled yet (back-compat)", async () => {
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[
						projectEnvironments,
						[
							{
								id: "env-1",
								name: "production",
								stage: "production",
								status: "DRAFT",
								is_default: true,
								region: null,
								fabric_id: null,
								placement_mode: "dedicated",
								namespace: null,
							},
						],
					],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});

		await planProject("p1");

		const snapshot = valuesFor(valuesSpy, jobs).config_snapshot as Record<
			string,
			unknown
		>;
		expect(snapshot).toMatchObject({
			fabric_id: null,
			fabric_name: "production",
			namespace: null,
		});
	});
});

// #1810: the DNS singleton is hand-enumerated, and both canvas switches were missing from that
// list — so they were dropped before any provider was asked, on all five clouds. The switches are
// emitted ONLY when on, like network.subnet_ids, so an absent key means off and the byte-locked
// t2_config_snapshot fixtures stay green.
describe("buildConfigSnapshot — DNS switches (#1810)", () => {
	/** Run planProject against a single DNS row and return the frozen `dns` snapshot object. */
	async function dnsSnapshot(row: Record<string, unknown>) {
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([[projectDns, [row]]]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		await planProject("p1");
		const snapshot = valuesFor(valuesSpy, jobs).config_snapshot as Record<
			string,
			unknown
		>;
		return snapshot.dns as Record<string, unknown>;
	}

	it("carries managed_certificate and waf_enabled when the user turns them on", async () => {
		const dns = await dnsSnapshot({
			enabled: true,
			domain_name: "example.com",
			managed_certificate: true,
			waf_enabled: true,
		});
		expect(dns).toMatchObject({
			enabled: true,
			domain_name: "example.com",
			managed_certificate: true,
			waf_enabled: true,
		});
	});

	it("omits both keys entirely when they are off, so the snapshot bytes do not move", async () => {
		const dns = await dnsSnapshot({
			enabled: true,
			domain_name: "example.com",
			managed_certificate: false,
			waf_enabled: false,
		});
		expect(dns).not.toHaveProperty("managed_certificate");
		expect(dns).not.toHaveProperty("waf_enabled");
	});

	it("omits both keys when the columns are null (a row written before the switches existed)", async () => {
		const dns = await dnsSnapshot({
			enabled: true,
			domain_name: "example.com",
			managed_certificate: null,
			waf_enabled: null,
		});
		expect(dns).not.toHaveProperty("managed_certificate");
		expect(dns).not.toHaveProperty("waf_enabled");
	});

	it("carries each switch independently", async () => {
		const dns = await dnsSnapshot({
			enabled: true,
			domain_name: "example.com",
			managed_certificate: true,
			waf_enabled: false,
		});
		expect(dns).toMatchObject({ managed_certificate: true });
		expect(dns).not.toHaveProperty("waf_enabled");
	});
});

// #2568: the cluster cloud's own DNS may refuse the TLD outright — hetzner answers a `.io` zone
// create with "unsupported tld" (422). #2570 added the gate; these are the two conditions it has
// to get right, neither of which had a test.
describe("buildConfigSnapshot - the hetzner TLD gate (#2568)", () => {
	/** snapshotSelect with a hetzner cloud identity and one DNS row. */
	function hetznerWithDns(row: Record<string, unknown>) {
		return snapshotSelect(
			new Map<unknown, RowsResolver>([
				[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
				[projectDns, [row]],
			]),
		);
	}

	it("refuses a .io zone hetzner would answer with a 422, and names the remedy", async () => {
		setupDb({
			select: hetznerWithDns({ enabled: true, domain_name: "app.example.io" }),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		await expect(planProject("p1")).rejects.toThrow(/will not host a \.io zone/);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	// MIRRORS THE EMITTER. `hcloud_zone.this` counts on `cloud_dns_enabled && dns_provider ==
	// "native"`, and the runner emits `cloud_dns_enabled = DNS.Enabled && DNS.ZoneID == ""`
	// (hetzner_provider.go:209). A project that BRINGS a zone id therefore creates no zone at all,
	// so the 422 is unreachable and refusing it would block a config that applies cleanly.
	it("allows the same domain when an existing zone id means no zone is ever created", async () => {
		const { valuesSpy } = setupDb({
			select: hetznerWithDns({
				enabled: true,
				domain_name: "app.example.io",
				zone_id: "zone-abc",
			}),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		await planProject("p1");
		expect(valuesFor(valuesSpy, jobs)).toMatchObject({ job_type: "PLAN" });
	});

	// A connected provider hosts the zone instead, so the cloud's own restriction never applies.
	it("allows it when a connected DNS provider hosts the zone", async () => {
		const { valuesSpy } = setupDb({
			select: hetznerWithDns({
				enabled: true,
				domain_name: "app.example.io",
				provider: "cloudflare",
			}),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		await planProject("p1");
		expect(valuesFor(valuesSpy, jobs)).toMatchObject({ job_type: "PLAN" });
	});

	// ONLY ON THE PATHS THAT CREATE. The `.io`-on-hetzner project that produced #2568 already
	// exists, half-applied — it is the reason the gate was written. Throwing on the shared
	// `buildConfigSnapshot` would leave its owner holding cloud resources they cannot tear down
	// from the console. Refusing to create MORE of a broken config is the point; refusing to
	// remove one is not.
	it("does NOT block the teardown of a project already broken this way", async () => {
		const { valuesSpy } = setupDb({
			select: hetznerWithDns({ enabled: true, domain_name: "app.example.io" }),
			insert: new Map([[jobs, [{ id: "job-9" }]]]),
		});
		await destroyProject("p1");
		expect(valuesFor(valuesSpy, jobs)).toMatchObject({ job_type: "DESTROY" });
	});
});

describe("planProject", () => {
	it("freezes a config snapshot, queues a PLAN job, flips the env to QUEUED, and notifies the scaler", async () => {
		const { valuesSpy, executeSpy } = setupDb({
			select: snapshotSelect(),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});

		const r = await planProject("p1", "runner-9");

		expect(authorize).toHaveBeenCalledWith("plan", {
			type: "project",
			id: "p1",
		});
		expect(assertUsageAllowed).toHaveBeenCalledWith("org-1");

		const jobVals = valuesFor(valuesSpy, jobs);
		expect(jobVals).toMatchObject({
			user_id: "user-1",
			project_id: "p1",
			environment_id: "env-1",
			cloud_identity_id: "ci-1",
			job_type: "PLAN",
			status: "QUEUED",
			assigned_runner_id: "runner-9",
		});
		// the snapshot carries the resolved provider + the env name as the frozen wire key
		expect(jobVals.config_snapshot).toMatchObject({
			provider: "aws",
			environment_stage: "production",
			region: "us-east-1",
		});
		// A fresh W3C traceparent is minted at enqueue (the correlation-trace root).
		expect(jobVals.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

		// The env→QUEUED write now routes through the set_env_status CAS (tx.execute).
		expect(executeSpy).toHaveBeenCalled();
		expect(notifyScaler).toHaveBeenCalledTimes(1);
		expect(r).toEqual({ jobId: "job-1" });
	});

	it("rejects (defense-in-depth) a client-supplied runner owned by another org", async () => {
		const { valuesSpy, insertSpy } = setupDb({
			select: snapshotSelect(),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		mockRunnerLookup("org-OTHER"); // runner-9 belongs to a different org than actor (org-1)

		await expect(planProject("p1", "runner-9")).rejects.toThrow(/Forbidden/);
		// Fail closed BEFORE the job is inserted — no orphaned/unclaimable row.
		expect(insertSpy).not.toHaveBeenCalledWith(jobs);
		expect(() => valuesFor(valuesSpy, jobs)).toThrow();
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("rejects (defense-in-depth) a non-existent client-supplied runner id", async () => {
		setupDb({
			select: snapshotSelect(),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		mockRunnerLookup(null); // no such runner → same rejection, no disclosure

		await expect(planProject("p1", "runner-nope")).rejects.toThrow(/Forbidden/);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("emits storage_buckets and container_registries in the snapshot with resolved placement", async () => {
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[
						projectStorageBuckets,
						[
							{
								name: "assets",
								versioning: true,
								encryption_enabled: true,
								public_access: false,
								cloud_identity_id: null,
								region: null,
							},
						],
					],
					[
						projectContainerRegistries,
						[
							{
								name: "apps",
								provider: null,
								cloud_identity_id: null,
								region: null,
							},
						],
					],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});

		await planProject("p1");

		const snapshot = valuesFor(valuesSpy, jobs).config_snapshot as Record<
			string,
			unknown
		>;
		// Buckets ride the snapshot (they were previously never selected — the known gap).
		expect(snapshot.storage_buckets).toEqual([
			expect.objectContaining({
				name: "assets",
				versioning: true,
				cloud_provider: "aws",
				cloud_identity_id: "ci-1",
				region: "us-east-1",
			}),
		]);
		// Registries keep being emitted alongside.
		expect(snapshot.container_registries).toEqual([
			expect.objectContaining({
				name: "apps",
				cloud_provider: "aws",
				cloud_identity_id: "ci-1",
				region: "us-east-1",
			}),
		]);
	});

	it("keeps a service's resolved_image in the deploy snapshot (the runner substitutes it) — W2 #591", async () => {
		// The complement of the getProjectAsFormData strip: resolved_image is stripped from the
		// DESIGN view but MUST survive into the runner-facing snapshot, otherwise the manifest
		// renderer has no digest to substitute and falls back to `:latest` — the W2 regression.
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[
						projectServices,
						[
							{
								name: "api",
								type: "deployment",
								source: {
									kind: "repo",
									repo_url: "https://github.com/acme/api",
									path: ".",
								},
								build: { dockerfile: "Dockerfile", context: "." },
								env: [],
								ports: [],
								replicas: 2,
								resources: null,
								probe: null,
								cloud_identity_id: null,
								region: null,
								resolved_image:
									"111122223333.dkr.ecr.us-east-1.amazonaws.com/acme-api@sha256:deadbeef",
							},
						],
					],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});

		await planProject("p1");

		const snapshot = valuesFor(valuesSpy, jobs).config_snapshot as Record<
			string,
			unknown
		>;
		expect(snapshot.services).toEqual([
			expect.objectContaining({
				name: "api",
				cloud_provider: "aws",
				resolved_image:
					"111122223333.dkr.ecr.us-east-1.amazonaws.com/acme-api@sha256:deadbeef",
			}),
		]);
	});

	it("carries a service's W3 bindings into the deploy snapshot when the target exists — #615", async () => {
		const bindings: ServiceBinding[] = [
			{
				target: { kind: "database", name: "orders-db" },
				inject: [{ env: "DATABASE_HOST", from: "endpoint" }],
			},
		];
		const { sbRows, injRows } = bindingChildRows("svc-api", bindings);
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[projectDatabases, [{ name: "orders-db", engine: "postgres" }]],
					[
						projectServices,
						[
							{
								id: "svc-api",
								name: "api",
								type: "deployment",
								source: {
									kind: "repo",
									repo_url: "https://github.com/acme/api",
									path: ".",
								},
								env: [],
								ports: [],
								replicas: 2,
								cloud_identity_id: null,
								region: null,
							},
						],
					],
					[serviceBindings, sbRows],
					[serviceBindingInjections, injRows],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});

		await planProject("p1");

		const snapshot = valuesFor(valuesSpy, jobs).config_snapshot as Record<
			string,
			unknown
		>;
		expect(snapshot.services).toEqual([
			expect.objectContaining({ name: "api", bindings }),
		]);
	});

	it("fails closed when a service binds to a resource that does not exist in the env — #615", async () => {
		// The fail-closed target gate: a dangling {kind,name} would reach the runner and fail to
		// resolve at deploy (no endpoint/secret to inject). Catch it at snapshot build, loudly.
		const bindings: ServiceBinding[] = [
			{
				target: { kind: "database", name: "ghost-db" },
				inject: [{ env: "DATABASE_HOST", from: "endpoint" }],
			},
		];
		const { sbRows, injRows } = bindingChildRows("svc-api", bindings);
		setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					// No projectDatabases seeded → the binding target "ghost-db" does not exist.
					[
						projectServices,
						[
							{
								id: "svc-api",
								name: "api",
								type: "deployment",
								source: {
									kind: "repo",
									repo_url: "https://github.com/acme/api",
									path: ".",
								},
								env: [],
								ports: [],
								replicas: 2,
								cloud_identity_id: null,
								region: null,
							},
						],
					],
					// The gate now reads bindings from the child table (JSONB dropped, #1426).
					[serviceBindings, sbRows],
					[serviceBindingInjections, injRows],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});

		await expect(planProject("p1")).rejects.toThrow(
			/binds to database "ghost-db", which does not exist/,
		);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("rejects (no job, no scaler) when the project has no linked cloud identity", async () => {
		setupDb({
			select: snapshotSelect(
				new Map([
					[
						projects,
						[
							{
								id: "p1",
								org_id: "org-1",
								cloud_identity_id: null,
								region: "x",
							},
						],
					],
				]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(/No cloud account linked/);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("rejects when the linked identity row is missing (unverified)", async () => {
		setupDb({ select: snapshotSelect(new Map([[cloudIdentities, []]])) });
		await expect(planProject("p1")).rejects.toThrow(/not verified/);
	});

	it("enforces the cross-cloud placement gate on a CORE resource", async () => {
		setupDb({
			select: snapshotSelect(
				new Map([
					[projectDatabases, [{ name: "db1", cloud_identity_id: "ci-OTHER" }]],
				]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(
			/Cross-cloud database "db1"/,
		);
	});

	it("fails closed on a non-postgres database on hetzner (no silent chart drop)", async () => {
		setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
					[
						projectDatabases,
						[
							{
								name: "orders",
								engine_family: "mysql",
								cloud_identity_id: null,
							},
						],
					],
				]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(
			/MySQL databases can't be provisioned on Hetzner/,
		);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	// ── Fail-closed keyless gate (#1510) ────────────────────────────────────
	// The canvas disables the IAM-auth toggle on these cells, but the canvas is not a boundary: the
	// CLI writes `iam_auth` on any cloud, an AI-composed graph can carry it, and legacy rows predate
	// the gate. Before this the database was simply handed a PASSWORD — no error, nothing in the UI,
	// and the operator's explicit "no password" silently reversed.
	it.each([
		["hetzner", "postgres", /CloudNativePG/],
		["alibaba", "postgres", /control plane/],
		["alibaba", "mysql", /control plane/],
	])(
		"fails closed on iam_auth for %s × %s (never a silent password)",
		async (provider, engine_family, reason) => {
			setupDb({
				select: snapshotSelect(
					new Map<unknown, RowsResolver>([
						[cloudIdentities, [{ id: "ci-1", provider }]],
						[
							projectDatabases,
							[
								{
									name: "orders",
									engine_family,
									iam_auth: true,
									cloud_identity_id: null,
								},
							],
						],
					]),
				),
			});
			await expect(planProject("p1")).rejects.toThrow(reason);
			await expect(planProject("p1")).rejects.toThrow(
				/Turn IAM authentication off/,
			);
			expect(notifyScaler).not.toHaveBeenCalled();
		},
	);

	it("lets iam_auth through on a cell the renderer can build", async () => {
		setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[
						projectDatabases,
						[
							{
								name: "orders",
								engine_family: "mysql",
								iam_auth: true,
								cloud_identity_id: null,
							},
						],
					],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		// aws × mysql is live, so the gate must be silent — a gate that also blocks the cells it is
		// meant to permit is just the old bug wearing an error message.
		await expect(planProject("p1")).resolves.toEqual({ jobId: "job-1" });
	});

	it("queues a hetzner job when databases are postgres (or legacy NULL family)", async () => {
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
					[
						projectDatabases,
						[
							{
								name: "pg",
								engine_family: "postgres",
								cloud_identity_id: null,
							},
							{ name: "legacy", engine_family: null, cloud_identity_id: null },
						],
					],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		const r = await planProject("p1");
		expect(r).toEqual({ jobId: "job-1" });
		// Both databases ride the snapshot as in-cluster CNPG addons (operator + 2 clusters).
		const snapshot = valuesFor(valuesSpy, jobs).config_snapshot as {
			addons: { id: string }[];
		};
		const addonIds = snapshot.addons.map((a) => a.id);
		expect(addonIds).toEqual(
			expect.arrayContaining(["cnpg-operator", "db-pg", "db-legacy"]),
		);
	});

	it("rejects when network provisioning is off but no existing network is selected", async () => {
		setupDb({
			select: snapshotSelect(
				new Map([
					[projectNetwork, [{ provision_network: false, network_id: null }]],
				]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(/no VPC selected/);
	});

	// ── Fail-closed unsupported-KIND gate (buildConfigSnapshot) ─────────────
	// A Hetzner topic is no longer refused: the kind maps to an in-cluster NATS release, so it
	// passes the unsupported-kind gate exactly as `queue` and `database` do.
	//
	// This asserts what it can and says so. The gate used to throw BEFORE the snapshot read any of
	// the other component tables, so this fixture never had to mock them; now that topic gets
	// through, the snapshot runs on and fails on a row the fixture does not provide. Rejecting for
	// SOME other reason is therefore expected here — what matters, and what would regress if the
	// kind were re-refused, is that it is no longer THIS reason. The fail-closed gate itself still
	// has direct coverage from the sibling below, which injects an exclusion — no cloud refuses any
	// kind today, so an injected one is the only way left to exercise the gate at all.
	it("no longer fails closed on a Hetzner topic — the kind is carried in-cluster by NATS", async () => {
		setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
					[projectTopics, [{ name: "events", cloud_identity_id: null }]],
				]),
			),
		});
		await expect(planProject("p1")).rejects.not.toThrow(
			/Component "events" \(topic\) can't be provisioned on Hetzner/,
		);
	});

	it("fails closed on a kind the target cloud cannot back", async () => {
		// The gate has NO live case any more: every cloud backs all 19 kinds (#3228). It is still
		// load-bearing — a cloud-switch or an AI-composed graph can put a hidden kind on the canvas
		// and the snapshot mapper would drop it silently, reporting SUCCESS without the component —
		// so the exclusion is injected rather than the test deleted.
		//
		// `Once`, so nothing leaks into the next test: the gate reads the lookup exactly once.
		vi.mocked(unsupportedKindsFor).mockReturnValueOnce(["nosql"]);
		setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
					[projectNosqlTables, [{ name: "sessions", cloud_identity_id: null }]],
				]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(
			/Component "sessions" \(nosql\) can't be provisioned on Hetzner/,
		);
	});

	it("plans a Hetzner nosql table now that ScyllaDB carries it", async () => {
		// The other direction, and the one the test above used to stand in for. Without it, the
		// injected exclusion could pass while the REAL lookup still refused nosql on Hetzner and
		// nobody would know — the suite would be proving its own mock.
		expect(unsupportedKindsFor("hetzner")).not.toContain("nosql");
	});

	// #2431 turned this around: a Hetzner registry is DELIVERED as an in-cluster Harbor (a minted
	// pull robot plus a Talos containerd mirror), so the unsupported-kind gate must no longer fire
	// for it. The gate still fires for topic/nosql/secret — asserted above and below.
	//
	// This asserts the GATE, not a whole successful plan: the fixture is deliberately minimal
	// (identity + one registry) because it used to fail fast at the gate, and completing it into a
	// full project would be testing the planner rather than the thing that changed.
	it("no longer refuses a Hetzner container registry — it is delivered in-cluster", async () => {
		setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
					[
						projectContainerRegistries,
						[{ name: "apps", cloud_identity_id: null }],
					],
				]),
			),
		});
		await expect(planProject("p1")).rejects.not.toThrow(
			/Component "apps" \(registry\) can't be provisioned on Hetzner/,
		);
	});

	it("queues a Hetzner job when only supported kinds are present (cluster/network/db-pg/cache/queue/dns)", async () => {
		setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
					[
						projectNetwork,
						[{ provision_network: true, cloud_identity_id: null }],
					],
					[projectCluster, [{ cloud_identity_id: null }]],
					[projectDns, [{ enabled: true, domain_name: "example.com" }]],
					[
						projectDatabases,
						[
							{
								name: "pg",
								engine_family: "postgres",
								cloud_identity_id: null,
							},
						],
					],
					[projectCaches, [{ name: "cache", cloud_identity_id: null }]],
					[projectQueues, [{ name: "queue", cloud_identity_id: null }]],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		const r = await planProject("p1");
		expect(r).toEqual({ jobId: "job-1" });
	});

	// Hetzner has NO cloud secret store, so `secret` was gated shut here — the component would
	// otherwise be SILENTLY DROPPED while the deploy reported SUCCESS. #2432 delivers the kind
	// in-cluster instead, so the assertion INVERTS: the deploy must now be planned, and the snapshot
	// must actually carry the Vault that will hold the secret. A test that only checked the throw
	// was gone would pass just as well if the mapping had been forgotten entirely.
	it("plans a secret component on hetzner and carries the Vault that holds it", async () => {
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
					[
						projectNetwork,
						[{ provision_network: true, cloud_identity_id: null }],
					],
					[projectCluster, [{ cloud_identity_id: null }]],
					[projectSecrets, [{ name: "api-key", cloud_identity_id: null }]],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		const r = await planProject("p1");
		expect(r).toEqual({ jobId: "job-1" });

		const snapshot = valuesFor(valuesSpy, jobs).config_snapshot as Record<
			string,
			unknown
		>;
		const addons = Array.isArray(snapshot.addons) ? snapshot.addons : [];
		const charts = addons.map((a) =>
			typeof a === "object" && a !== null && "chart" in a ? a.chart : undefined,
		);
		expect(charts).toContain("vault");
	});

	it("passes a managed cloud (aws) with topic/nosql/registry — supported there", async () => {
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					// aws is the default identity in snapshotSelect
					[projectTopics, [{ name: "events", cloud_identity_id: null }]],
					[projectNosqlTables, [{ name: "sessions", cloud_identity_id: null }]],
					[
						projectContainerRegistries,
						[{ name: "apps", cloud_identity_id: null }],
					],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		const r = await planProject("p1");
		expect(r).toEqual({ jobId: "job-1" });
		const snapshot = valuesFor(valuesSpy, jobs).config_snapshot as Record<
			string,
			unknown
		>;
		expect(snapshot.provider).toBe("aws");
	});

	it("targets an explicit environment, rejecting when it does not belong to the project", async () => {
		setupDb({ select: snapshotSelect(new Map([[projectEnvironments, []]])) });
		await expect(planProject("p1", null, "env-x")).rejects.toThrow(
			/Environment not found/,
		);
	});

	it("rejects when the project has no default environment", async () => {
		setupDb({ select: snapshotSelect(new Map([[projectEnvironments, []]])) });
		await expect(planProject("p1")).rejects.toThrow(/no default environment/);
	});
});

// ============================================================
// BYO IaC (E3) — snapshot branch + queue gating
// ============================================================

describe("planProject — BYO IaC source", () => {
	const OLD_FLAG = process.env.ALETHIA_BYO_IAC_ENABLED;
	const scannedIacRow = {
		id: "iac-1",
		project_id: "p1",
		environment_id: "env-1",
		repo_url: "https://github.com/acme/infra.git",
		ref: "main",
		path: "stacks/prod",
		commit_sha: "deadbeef",
		var_values: { env: "prod" },
		enabled: true,
		scan_status: "done",
	};

	beforeEach(() => {
		process.env.ALETHIA_BYO_IAC_ENABLED = "true";
	});
	afterEach(() => {
		if (OLD_FLAG === undefined) delete process.env.ALETHIA_BYO_IAC_ENABLED;
		else process.env.ALETHIA_BYO_IAC_ENABLED = OLD_FLAG;
	});

	it("snapshots iac_source with the pinned sha and SKIPS the template-model gates", async () => {
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[projectIacSources, [scannedIacRow]],
					// Both template gates would throw for a template env — they must be skipped:
					// a cross-cloud CORE resource + provisioning off with no network selected.
					[projectDatabases, [{ name: "db1", cloud_identity_id: "ci-OTHER" }]],
					[projectNetwork, [{ provision_network: false, network_id: null }]],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});

		const r = await planProject("p1");
		expect(r).toEqual({ jobId: "job-1" });
		const jobVals = valuesFor(valuesSpy, jobs);
		expect(jobVals.config_snapshot).toMatchObject({
			iac_source: {
				repo_url: "https://github.com/acme/infra.git",
				ref: "main",
				path: "stacks/prod",
				commit_sha: "deadbeef",
				var_values: { env: "prod" },
			},
		});
	});

	it("rejects queueing while the source is unscanned (no pinned commit)", async () => {
		setupDb({
			select: snapshotSelect(
				new Map([
					[
						projectIacSources,
						[{ ...scannedIacRow, commit_sha: null, scan_status: "unscanned" }],
					],
				]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(/hasn't passed a scan/);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("rejects a scanned-but-unpinned source (defense in depth)", async () => {
		setupDb({
			select: snapshotSelect(
				new Map([
					[projectIacSources, [{ ...scannedIacRow, commit_sha: null }]],
				]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(/hasn't passed a scan/);
	});

	it("rejects when the flag is off but a row exists (defense in depth)", async () => {
		delete process.env.ALETHIA_BYO_IAC_ENABLED;
		setupDb({
			select: snapshotSelect(new Map([[projectIacSources, [scannedIacRow]]])),
		});
		await expect(planProject("p1")).rejects.toThrow(/disabled/);
		expect(notifyScaler).not.toHaveBeenCalled();
	});
});

describe("provisionProject", () => {
	it("queues a DEPLOY job chained to a plan, audits PROVISIONED, and notifies the scaler", async () => {
		const { valuesSpy, executeSpy } = setupDb({
			select: snapshotSelect(),
			insert: new Map([[jobs, [{ id: "job-7" }]]]),
		});

		const r = await provisionProject("p1", "plan-3", "runner-2");

		expect(authorize).toHaveBeenCalledWith("deploy", {
			type: "project",
			id: "p1",
		});
		const jobVals = valuesFor(valuesSpy, jobs);
		expect(jobVals).toMatchObject({
			job_type: "DEPLOY",
			plan_job_id: "plan-3",
			assigned_runner_id: "runner-2",
			environment_id: "env-1",
			status: "QUEUED",
		});
		expect(valuesFor(valuesSpy, auditLog)).toMatchObject({
			project_id: "p1",
			user_id: "user-1",
			action: "PROVISIONED",
			changes: { job_id: "job-7", environment_id: "env-1" },
		});
		// The env→QUEUED write now routes through the set_env_status CAS (tx.execute).
		expect(executeSpy).toHaveBeenCalled();
		expect(notifyScaler).toHaveBeenCalledTimes(1);
		expect(r).toEqual({ jobId: "job-7" });
	});
});

describe("destroyProject — BYO IaC source", () => {
	const OLD_FLAG = process.env.ALETHIA_BYO_IAC_ENABLED;
	// A source that DEPLOYED successfully (deployed_commit_sha set), then had a later re-scan FAIL
	// (commit_sha cleared, scan_status back off "done"). It must still be destroyable.
	const deployedIacRow = {
		id: "iac-1",
		project_id: "p1",
		environment_id: "env-1",
		repo_url: "https://github.com/acme/infra.git",
		ref: "main",
		path: "stacks/prod",
		commit_sha: null,
		deployed_commit_sha: "cafed00d",
		var_values: { env: "prod" },
		enabled: true,
		scan_status: "failed",
	};

	beforeEach(() => {
		process.env.ALETHIA_BYO_IAC_ENABLED = "true";
	});
	afterEach(() => {
		if (OLD_FLAG === undefined) delete process.env.ALETHIA_BYO_IAC_ENABLED;
		else process.env.ALETHIA_BYO_IAC_ENABLED = OLD_FLAG;
	});

	it("allows DESTROY after a deploy even when a later re-scan failed — snapshot pins deployed_commit_sha", async () => {
		const { valuesSpy, executeSpy } = setupDb({
			select: snapshotSelect(new Map([[projectIacSources, [deployedIacRow]]])),
			insert: new Map([[jobs, [{ id: "job-9" }]]]),
		});

		const r = await destroyProject("p1");
		expect(r).toEqual({ jobId: "job-9" });
		const jobVals = valuesFor(valuesSpy, jobs);
		expect(jobVals).toMatchObject({ job_type: "DESTROY", status: "QUEUED" });
		// Destroy tears down the module that CREATED the state, not the failed fresh scan.
		expect(jobVals.config_snapshot).toMatchObject({
			iac_source: { commit_sha: "cafed00d" },
		});
		// The env→QUEUED write now routes through the set_env_status CAS (tx.execute).
		expect(executeSpy).toHaveBeenCalled();
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	it("rejects DESTROY when the source was never deployed (no deployed_commit_sha)", async () => {
		setupDb({
			select: snapshotSelect(
				new Map([
					[
						projectIacSources,
						[
							{
								...deployedIacRow,
								deployed_commit_sha: null,
								scan_status: "unscanned",
							},
						],
					],
				]),
			),
		});
		await expect(destroyProject("p1")).rejects.toThrow(/no deployed IaC state/);
		expect(notifyScaler).not.toHaveBeenCalled();
	});
});

// ============================================================
// deleteProject
// ============================================================

describe("deleteProject", () => {
	it("authorizes destroy, deletes the project row (CASCADE), and returns success", async () => {
		const { deleteSpy } = setupDb({});
		const r = await deleteProject("p1");
		expect(authorize).toHaveBeenCalledWith("destroy", {
			type: "project",
			id: "p1",
		});
		expect(deleteSpy).toHaveBeenCalledWith(projects);
		expect(r).toEqual({ success: true });
	});
});

// ============================================================
// updateProjectName — the RENAME half of #3145's uniqueness guarantee
// ============================================================
//
// The rename path had no test at all, while create had several. That asymmetry is the defect:
// #3145's promise is "project names are unique per org", and a rename is the other way to break it
// — the one that takes a name a teammate is already using rather than minting a new collision.

describe("updateProjectName", () => {
	it("REFUSES a name another project in the org already holds", async () => {
		setupDb({
			select: new Map<unknown, RowsResolver>([
				// 1. the project being renamed, 2. the case-insensitive clash probe finds a rival
				[projects, (() => { let n = 0; return () => (n++ === 0 ? [{ org_id: "org-1" }] : [{ id: "other" }]); })()],
			]),
		});
		await expect(updateProjectName("p1", "Taken")).rejects.toThrow(ProjectNameTakenError);
	});

	it("...and allows a name only this project holds — re-saving must not collide with itself", async () => {
		const { setSpy } = setupDb({
			select: new Map<unknown, RowsResolver>([
				// The clash probe excludes `ne(projects.id, projectId)`, so it comes back empty.
				[projects, (() => { let n = 0; return () => (n++ === 0 ? [{ org_id: "org-1" }] : []); })()],
			]),
			default: [{ project_name: "Renamed" }],
		});
		await updateProjectName("p1", "Renamed");
		expect(setSpy).toHaveBeenCalledWith(projects, expect.objectContaining({ project_name: "Renamed" }));
	});

	// THE PRE-CHECK IS OPTIMISTIC; THE INDEX IS THE AUTHORITY. Two concurrent renames both read an
	// empty clash probe at READ COMMITTED and both proceed — the loser gets a 23505, and mapping it
	// here is what makes the race and the ordinary case give the user the same message instead of a
	// raw Postgres error.
	it("maps a 23505 the pre-check could not see onto the same friendly error", async () => {
		const violation = Object.assign(new Error("Failed query: update projects"), {
			cause: { code: "23505", constraint_name: "projects_org_id_project_name_key" },
		});
		setupDb({
			select: new Map<unknown, RowsResolver>([
				[projects, (() => { let n = 0; return () => (n++ === 0 ? [{ org_id: "org-1" }] : []); })()],
			]),
			update: new Map<unknown, RowsResolver>([[projects, () => { throw violation; }]]),
		});
		await expect(updateProjectName("p1", "Racy")).rejects.toThrow(ProjectNameTakenError);
	});

	// The null-org branch mirrors the INDEX rather than being tidier than it: a btree unique treats
	// NULLs as DISTINCT, so a row with no org is not constrained by that index and pre-checking it
	// would refuse a rename Postgres would accept.
	it("skips the friendly pre-check when the row carries no org, because the index does too", async () => {
		const { setSpy } = setupDb({
			select: new Map<unknown, RowsResolver>([[projects, () => [{ org_id: null }]]]),
			default: [{ project_name: "Orphan" }],
		});
		await updateProjectName("p1", "Orphan");
		expect(setSpy).toHaveBeenCalledWith(projects, expect.objectContaining({ project_name: "Orphan" }));
	});
});

// ============================================================
// getProjectAsFormData
// ============================================================

describe("getProjectAsFormData", () => {
	const formSelect = () =>
		new Map<unknown, RowsResolver>([
			[
				projects,
				[
					{
						id: "p1",
						org_id: "org-1",
						cloud_identity_id: "ci-1",
						region: "us-east-1",
						iac_version: "1.9.5",
						project_name: "My App",
					},
				],
			],
			[
				projectNetwork,
				[
					{
						provision_network: true,
						cidr_block: "10.0.0.0/16",
						single_nat_gateway: true,
					},
				],
			],
			[
				projectCluster,
				[
					{
						cluster_version: "1.31",
						instance_types: ["m5.large"],
						provider_config: {},
					},
				],
			],
			[projectDns, [{ enabled: false }]],
			[
				projectRepositories,
				[{ apps_destination_repo: "git@x", apps_path: "overlays/dev" }],
			],
			[
				projectDatabases,
				[
					{
						name: "db1",
						engine: "postgres",
						min_capacity: 0.5,
						max_capacity: 4,
					},
				],
			],
			[
				projectSecrets,
				[{ name: "s1", generate: true, length: 32, special_chars: true }],
			],
			[
				projectEnvironments,
				[
					{
						id: "env-1",
						name: "production",
						stage: "production",
						status: "DRAFT",
						is_default: true,
					},
				],
			],
			[cloudIdentities, [{ provider: "gcp" }]],
		]);

	it("maps the stored project into ProjectFormData with the resolved provider", async () => {
		setupDb({ select: formSelect() });
		const { formData, provider } = await getProjectAsFormData("p1");

		expect(provider).toBe("gcp");
		expect(formData.project).toMatchObject({
			project_name: "My App",
			environment_stage: "production",
			region: "us-east-1",
			cloud_identity_id: "ci-1",
			iac_version: "1.9.5",
		});
		expect(formData.databases).toEqual([
			{
				name: "db1",
				engine: "postgres",
				min_capacity: 0.5,
				max_capacity: 4,
				engine_version: undefined,
				port: undefined,
				backup_retention_days: undefined,
				iam_auth: undefined,
			},
		]);
		expect(formData.secrets[0]).toMatchObject({
			name: "s1",
			special_chars: true,
			length: 32,
		});
		expect(formData.cluster).toMatchObject({
			instance_types: ["m5.large"],
			cluster_version: "1.31",
		});
	});

	// #1767 — the DB → form direction, which the config-snapshot tests cannot see. This is the
	// path a clone, a duplicate-environment and EVERY canvas edit-page load run through: the
	// mapper builds `repositories` field by field, so a column it forgets is silently dropped and
	// then written back as empty by the next save. `toEqual` (not `toMatchObject`) so a future
	// column added to the table and forgotten here fails rather than passing unnoticed.
	it("round-trips repositories.apps_path out of the DB — the clone/edit hydration path", async () => {
		setupDb({ select: formSelect() });
		const { formData } = await getProjectAsFormData("p1");

		expect(formData.repositories).toEqual({
			apps_destination_repo: "git@x",
			apps_path: "overlays/dev",
		});
	});

	it("leaves apps_path undefined when the stored row has none", async () => {
		const m = formSelect();
		m.set(projectRepositories, [{ apps_destination_repo: "git@x", apps_path: null }]);
		setupDb({ select: m });
		const { formData } = await getProjectAsFormData("p1");

		expect(formData.repositories.apps_path).toBeUndefined();
	});

	it("throws when the linked identity cannot be resolved", async () => {
		const m = formSelect();
		m.set(cloudIdentities, []); // both getProject's lookup and the form lookup return nothing
		setupDb({ select: m });
		await expect(getProjectAsFormData("p1")).rejects.toThrow(
			/Cloud identity not found/,
		);
	});
});

// ============================================================
// getProjectAsFormData — the DNS connector round-trips (#1412)
// ============================================================

describe("getProjectAsFormData — dns provider round-trip", () => {
	const dnsSelect = (dnsRow: Record<string, unknown>) =>
		new Map<unknown, RowsResolver>([
			[
				projects,
				[
					{
						id: "p1",
						org_id: "org-1",
						cloud_identity_id: "ci-1",
						region: "us-east-1",
						iac_version: "1.9.5",
						project_name: "My App",
						slug: "my-app",
					},
				],
			],
			[
				projectEnvironments,
				[{ id: "env-1", name: "production", status: "DEPLOYED", is_default: true }],
			],
			[cloudIdentities, [{ id: "ci-1", provider: "aws" }]],
			[projectDns, [dnsRow]],
		]);

	// REGRESSION: this mapping carried provider_config but dropped `provider`. Because
	// updateProjectDesign reconciles delete-then-insert, a canvas save re-inserted the Cloudflare
	// knobs with NO slug — and that fails OPEN: DNSProvider() (argocd/infra_facts.go) sees an empty
	// connector and silently reverts to the cloud's native DNS. The deploy looks healthy while
	// ignoring the provider the user chose.
	it("carries the DNS connector so a canvas save can't revert to cloud-native DNS", async () => {
		setupDb({
			select: dnsSelect({
				enabled: true,
				provider: "cloudflare",
				domain_name: "acme.io",
				zone_id: "zone-123",
				provider_config: { proxied: true },
			}),
		});

		const { formData } = await getProjectAsFormData("p1");

		expect(formData.dns).toEqual(
			expect.objectContaining({
				enabled: true,
				provider: "cloudflare",
				domain_name: "acme.io",
				zone_id: "zone-123",
				provider_config: { proxied: true },
			}),
		);
	});

	// Cloud-native DNS has no connector; it must round-trip as absent, not as a string, since only
	// NULL / "native" mean "the cluster cloud's own DNS".
	it("leaves cloud-native DNS without a provider", async () => {
		setupDb({ select: dnsSelect({ enabled: true, domain_name: "acme.io", provider: null }) });
		const { formData } = await getProjectAsFormData("p1");
		expect(formData.dns.provider).toBeUndefined();
	});
});


// ============================================================
// duplicateProjectForProvider (real convertProjectConfig)
// ============================================================

describe("duplicateProjectForProvider", () => {
	it("converts an aws project to gcp, overrides region/identity, creates the clone, and returns warnings", async () => {
		// cloud_identities is queried 3x: getProject's provider lookup (aws), the form lookup (aws),
		// then the duplicate's TARGET lookup (gcp). projects is queried as the getProject row, then
		// as createProject's slug-collision list — sequence both with function resolvers.
		let ciCall = 0;
		const ciSeq: Rows[] = [
			[{ provider: "aws" }],
			[{ provider: "aws" }],
			[{ provider: "gcp" }],
		];
		let projCall = 0;
		const projSeq: Rows[] = [
			[
				{
					id: "p1",
					org_id: "org-1",
					cloud_identity_id: "ci-src",
					region: "us-east-1",
					iac_version: "1.9.5",
					project_name: "My App",
				},
			],
			// The org's project names, read to derive a free name for the clone. THE SOURCE PROJECT
			// IS IN THIS LIST, because it is in the org being duplicated within — the shape
			// production always has, and the one an earlier fixture here did not.
			[{ project_name: "My App" }],
			// createProject's existing-project list: slug + project_name, the two columns
			// insertProjectWithDefaultFabric selects (#3145). It carries the SOURCE project's own
			// name for the same reason. An earlier version of this fixture said "Some Other
			// Project" — a shape that cannot occur — and that is why it went green while the
			// cross-cloud duplicate threw `ProjectNameTakenError` on every single attempt.
			[{ slug: "my-app", project_name: "My App" }],
		];

		const { valuesSpy } = setupDb({
			select: new Map<unknown, RowsResolver>([
				[projects, () => projSeq[projCall++] ?? []],
				[cloudIdentities, () => ciSeq[ciCall++] ?? [{ provider: "gcp" }]],
				[
					projectNetwork,
					[
						{
							provision_network: true,
							cidr_block: "10.0.0.0/16",
							single_nat_gateway: true,
						},
					],
				],
				[
					projectCluster,
					[
						{
							cluster_version: "1.31",
							instance_types: ["m5.large"],
							provider_config: {},
						},
					],
				],
				[projectDns, [{ enabled: false }]],
				[projectRepositories, [{ apps_destination_repo: "git@x" }]],
				[
					projectDatabases,
					[
						{
							name: "db1",
							engine: "postgres",
							min_capacity: 0.5,
							max_capacity: 4,
						},
					],
				],
				[projectSecrets, []],
				[projectCaches, []],
				[
					projectEnvironments,
					[
						{
							id: "env-1",
							name: "production",
							status: "DRAFT",
							is_default: true,
						},
					],
				],
			]),
			insert: new Map<unknown, RowsResolver>([
				[projects, [{ id: "new-proj", slug: "new-proj", org_id: "org-1" }]],
				[projectFabrics, [{ id: "fabric-1" }]],
				[projectEnvironments, [{ id: "env-1" }, { id: "env-preview" }]],
			]),
		});

		const r = await duplicateProjectForProvider(
			"p1",
			"ci-target",
			"europe-west1",
		);

		expect(authorize).toHaveBeenCalledWith("create", { type: "project" });
		expect(r.newProjectId).toBe("new-proj");
		expect(r.newProjectSlug).toBe("new-proj");
		// the real converter always emits at least the cluster k8s-version info note cross-provider
		expect(r.warnings.length).toBeGreaterThan(0);
		expect(r.warnings.some((w) => w.component === "Cluster")).toBe(true);

		// the clone was persisted with the TARGET region + identity (post-conversion overrides)
		const projVals = valuesFor(valuesSpy, projects);
		expect(projVals).toMatchObject({
			region: "europe-west1",
			cloud_identity_id: "ci-target",
			user_id: "user-1",
		});
		// AND WITH A NAME THE ORG DOES NOT ALREADY HOLD. `convertProjectConfig` never touches
		// `project_name` and the dialog has no name field, so without a derived name this is the
		// source project's own name in the source project's own org — which #3145's uniqueness
		// check refuses, making the duplicate fail 100% of the time.
		expect(projVals).toMatchObject({ project_name: "My App (gcp)" });
	});

	it("throws when the target cloud identity is missing", async () => {
		let ciCall = 0;
		const ciSeq: Rows[] = [[{ provider: "aws" }], [{ provider: "aws" }], []]; // target lookup empty
		setupDb({
			select: new Map<unknown, RowsResolver>([
				[
					projects,
					[
						{
							id: "p1",
							org_id: "org-1",
							cloud_identity_id: "ci-src",
							region: "us-east-1",
							iac_version: "1",
						},
					],
				],
				[cloudIdentities, () => ciSeq[ciCall++] ?? []],
				[
					projectEnvironments,
					[{ id: "env-1", name: "production", is_default: true }],
				],
			]),
		});
		await expect(
			duplicateProjectForProvider("p1", "ci-missing", "europe-west1"),
		).rejects.toThrow(/Target cloud identity not found/);
	});
});

// ============================================================
// Environments
// ============================================================

describe("getProjectEnvironments", () => {
	it("returns the project's environments", async () => {
		setupDb({
			select: new Map([
				[
					projectEnvironments,
					[
						{ id: "env-1", name: "production", is_default: true },
						{ id: "env-2", name: "staging", is_default: false },
					],
				],
			]),
		});
		const r = await getProjectEnvironments("p1");
		expect(authorize).toHaveBeenCalledWith("view", {
			type: "project",
			id: "p1",
		});
		expect(r.environments).toHaveLength(2);
		expect(r.environments[1]).toMatchObject({ id: "env-2", name: "staging" });
	});
});

describe("addEnvironment", () => {
	it("slugifies the name, inherits the org, and derives is_default rather than hard-coding it", async () => {
		const { valuesSpy } = setupDb({
			select: new Map([[projects, [{ org_id: "org-1" }]]]),
			insert: new Map([
				[projectEnvironments, [{ id: "env-2", name: "my-staging" }]],
			]),
		});

		const r = await addEnvironment("p1", {
			name: "My Staging!",
			stage: "staging",
			region: null,
		});

		expect(authorize).toHaveBeenCalledWith("edit", {
			type: "project",
			id: "p1",
		});
		const { is_default: isDefault, ...literals } = valuesFor(
			valuesSpy,
			projectEnvironments,
		);
		expect(literals).toEqual({
			project_id: "p1",
			user_id: "user-1",
			org_id: "org-1",
			name: "my-staging",
			stage: "staging",
			status: "DRAFT",
			region: null,
		});

		// `is_default` IS NO LONGER A LITERAL `false`, and asserting the rendered predicate is the
		// point rather than pedantry (#4127). `project_environments_one_default_check` refuses a
		// commit in which a project has environments and none is the default, and a project can
		// legitimately hold zero environments — so a hard-coded `false` made THIS action, the only
		// one that could repair such a project, the one insert the database rejects. Asserting
		// merely "some SQL object" would pass for any expression at all, including the wrong one.
		if (!(isDefault instanceof SQL)) {
			throw new Error("addEnvironment no longer derives is_default in SQL");
		}
		const rendered = new PgDialect().sqlToQuery(isDefault);
		expect(rendered.sql).toContain("NOT EXISTS");
		expect(rendered.sql).toContain("is_default");
		// Scoped to THIS project — a predicate that forgot the parameter would be true whenever any
		// project anywhere still lacked a default.
		expect(rendered.params).toEqual(["p1"]);

		expect(r).toEqual({ environment: { id: "env-2", name: "my-staging" } });
	});

	it("rejects a name that slugifies to empty (before any db work)", async () => {
		setupDb({});
		await expect(
			addEnvironment("p1", { name: "!!!", stage: "staging" }),
		).rejects.toThrow(/at least one letter or number/);
		expect(withActorScope).not.toHaveBeenCalled();
	});

	it("rejects a name a console route would shadow, and normalizes one it accepts", async () => {
		// The SHARED env-name rule (lib/validations/names.ts), which `project env add` on the CLI
		// route now applies too — the two used to disagree about `Prod`, and only this path knew
		// that `settings` is unreachable forever.
		setupDb({});
		await expect(
			addEnvironment("p1", { name: "Settings", stage: "staging" }),
		).rejects.toThrow(/reserved by the console/);
		expect(withActorScope).not.toHaveBeenCalled();
	});

	it("calls notFound() when the project is missing", async () => {
		setupDb({ select: new Map([[projects, []]]) });
		// A stale/deleted id → Next notFound() (digest NEXT_HTTP_ERROR_FALLBACK), not a captured Error.
		await expect(
			addEnvironment("p1", { name: "stg", stage: "staging" }),
		).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK/);
	});
});

describe("deleteEnvironment", () => {
	it("deletes a non-default environment", async () => {
		const { deleteSpy } = setupDb({
			select: new Map([
				[projectEnvironments, [{ id: "env-2", is_default: false }]],
			]),
		});
		const r = await deleteEnvironment("p1", "env-2");
		expect(deleteSpy).toHaveBeenCalledWith(projectEnvironments);
		expect(r).toEqual({ success: true });
	});

	it("refuses to delete the default environment", async () => {
		const { deleteSpy } = setupDb({
			select: new Map([
				[projectEnvironments, [{ id: "env-1", is_default: true }]],
			]),
		});
		await expect(deleteEnvironment("p1", "env-1")).rejects.toThrow(
			/Cannot delete the project's default/,
		);
		expect(deleteSpy).not.toHaveBeenCalled();
	});

	it("throws when the environment is not found for the project", async () => {
		setupDb({ select: new Map([[projectEnvironments, []]]) });
		await expect(deleteEnvironment("p1", "env-x")).rejects.toThrow(
			/Environment not found/,
		);
	});
});

// ============================================================
// getProjects (flat)
// ============================================================

describe("getProjects", () => {
	it("maps joined rows into the derived shape with null fallbacks", async () => {
		setupDb({
			select: new Map([
				[
					projects,
					[
						{
							project: { id: "p1", project_name: "A" },
							cloud_provider: "aws",
							env_id: "e1",
							env_name: "prod",
							env_status: "DEPLOYED",
						},
						{
							project: { id: "p2", project_name: "B" },
							cloud_provider: null,
							env_id: null,
							env_name: null,
							env_status: null,
						},
					],
				],
			]),
		});

		const r = await getProjects();
		expect(authorize).toHaveBeenCalledWith("view", { type: "project" });
		expect(r[0]).toEqual({
			id: "p1",
			project_name: "A",
			cloud_provider: "aws",
			environment_stage: "prod",
			status: "DEPLOYED",
			default_environment_id: "e1",
		});
		expect(r[1]).toEqual({
			id: "p2",
			project_name: "B",
			cloud_provider: null,
			environment_stage: "development",
			status: "DRAFT",
			default_environment_id: null,
		});
	});
});
