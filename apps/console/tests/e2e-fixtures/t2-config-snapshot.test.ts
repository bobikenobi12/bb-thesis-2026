// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// BYOC A0.5 — snapshot-fidelity guard. Freezes the REAL console `config_snapshot` that the
// REAL buildConfigSnapshot produces for a canonical, cheap environment ON EACH SUPPORTED CLOUD,
// into shared fixtures the Go T2 harness (test/e2e) reads to prove its seeded DEPLOY snapshot has
// NOT diverged from what a real customer deploy freezes.
//
// One fixture per cloud since #3122/#2499 — before that there was one, hetzner's, compared against
// all five, so `provider` diverged by construction on four of them and A0.5's assurance existed on
// hetzner alone.
//
// # Why a fixture (finding #4)
//
// T2 used to seed a hand-built 5-key synthetic snapshot that could silently drift from the
// console-produced shape. The runner is Go and buildConfigSnapshot is DB-driven TypeScript, so
// the Go harness cannot call it directly. This vitest is the "shared fixture generated from the
// TS path": it drives the ACTUAL buildConfigSnapshot (via provisionProject, the same DEPLOY
// enqueue the console runs) against the same mocked-boundary tx the project-action tests use,
// captures the frozen config_snapshot, and asserts it deep-equals the committed fixture. So the
// fixture can never drift from buildConfigSnapshot without this test (which CI's turbo fan-out
// runs) going red — and the Go harness asserts fidelity against that same guarded fixture.
//
// Regenerate after an intentional snapshot-shape change:  UPDATE_FIXTURES=1 pnpm -C apps/console run test
// t2-config-snapshot

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
import { EXPORT_CLOUDS } from "@/lib/addons/catalog-export";
import { requireOwner } from "@/lib/auth/owner";
import { authorize } from "@/lib/authz/guard";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { getServiceDb, withActorScope, withScope } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	projectAddons,
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectEnvironments,
	projectFabrics,
	projectHelmRegistries,
	projectNosqlTables,
	projectQueues,
	projectRepositories,
	projectSecrets,
	projectServices,
	projectStorageBuckets,
	projectTopics,
	projects,
	serviceBindingInjections,
	serviceBindings,
	topicSubscriptions,
} from "@/lib/db/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/console/tests/e2e-fixtures → repo root is four levels up.
const fixtureFor = (cloud: string) =>
	join(__dirname, `../../../../test/e2e/fixtures/t2_config_snapshot.${cloud}.json`);

// ONE FIXTURE PER CLOUD (#3122/#2499). There used to be one, hetzner's, and the Go comparator
// loaded it on every provider — so `provider` diverged BY CONSTRUCTION on aws, gcp, azure and
// alibaba, every run, regardless of correctness. A0.5's fidelity assurance therefore only existed
// on hetzner, and ALETHIA_E2E_A05_ENFORCE (the escalation its own warning advertises) would have
// hard-failed every managed-cloud run on a baseline mismatch.
//
// The cloud list is EXPORT_CLOUDS — the same list addon_catalog.<cloud>.json is generated from,
// which went per-cloud for the identical reason (#2717 class (c)). Two lists would drift.
//
// The region per cloud is each stack's own canonical e2e region. It is a DYNAMIC key (the Go
// comparator excludes it), so it changes nothing that is compared — it is here so the fixture reads
// like a real project rather than a hetzner project wearing another provider's name.
const REGION_FOR: Record<string, string> = {
	hetzner: "nbg1",
	aws: "us-east-1",
	gcp: "europe-west3",
	azure: "germanywestcentral",
	alibaba: "eu-central-1",
};
// The COMPONENT-shape fixture (#1974). Deliberately a second file, and deliberately AWS: the
// canonical fixture above is Hetzner, where hetznerDataServicesToAddOns() folds every database /
// cache / queue into `addons[]` — and `addons` is one of the two keys the Go A0.5 comparator
// actually compares, so seeding components there would red TestA05SeedIsFaithfulToTheConsoleFixture
// for a reason that has nothing to do with component shape.
const COMPONENTS_FIXTURE = join(
	__dirname,
	"../../../../test/e2e/fixtures/config_snapshot_components.aws.json",
);

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

/** The canonical, CHEAP Hetzner env the fixture freezes: one env (name feeds
 * environment_stage), a single-node cluster (node_desired_size 1 → the runner provisions
 * 1 worker + 1 control plane, the exact cheap shape the nightly proves), and the
 * `reloader` marketplace add-on (matches the Go harness's seedAddOns, so the resolved
 * add-on install spec is fidelity-checked). Returns a FRESH map per call so a test can
 * layer extra component rows on without leaking into the frozen shape. */
function canonicalSelect(cloud = "hetzner"): Map<unknown, Rows> {
	return new Map<unknown, Rows>([
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
						region: REGION_FOR[cloud] ?? "nbg1",
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
						// #837: the env is PLACED onto a Fabric. `dedicated` (the seam default + the
						// legacy env=cluster shape) → owns its Fabric 1:1, so `namespace` is null and
						// `fabric_name` == the env name → the tofu state path is byte-identical.
						fabric_id: "fab-1",
						placement_mode: "dedicated",
						namespace: null,
					},
				],
			],
			[projectFabrics, [{ id: "fab-1", project_id: "p1", name: "fixture" }]],
			[cloudIdentities, [{ id: "ci-1", provider: cloud }]],
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
			[
				projectAddons,
				[
					{
						addon_id: "reloader",
						source: "catalog",
						mode: "managed",
						version: null,
						values: {},
						values_yaml: null,
						enabled: true,
					},
				],
			],
	]);
}

/** Drives the REAL provisionProject → buildConfigSnapshot and returns the frozen snapshot. */
async function frozenSnapshot(select: Map<unknown, Rows>): Promise<unknown> {
	const insert = new Map<unknown, Rows>([[jobs, [{ id: "job-1" }]]]);
	const valuesSpy = setupDb(select, insert);

	await provisionProject("p1");

	const jobCall = valuesSpy.mock.calls.find((c) => c[0] === jobs);
	if (!jobCall) throw new Error("no DEPLOY job insert recorded");
	return (jobCall[1] as { config_snapshot: unknown }).config_snapshot;
}

describe("T2 config_snapshot fidelity fixture (BYOC A0.5)", () => {
	it.each(EXPORT_CLOUDS)(
		"the REAL buildConfigSnapshot freezes the committed %s shape",
		async (cloud) => {
			const fixture = fixtureFor(cloud);
			const snapshot = await frozenSnapshot(canonicalSelect(cloud));
			// Runtime secret placeholder — never part of the frozen fidelity shape.
			expect((snapshot as { git_access_token?: string }).git_access_token).toBe("");
			// The one key the whole per-cloud split exists for: it must be THIS cloud's, or the Go
			// comparator is back to measuring four clouds against a fifth.
			expect((snapshot as { provider?: string }).provider).toBe(cloud);

			const serialized = `${JSON.stringify(snapshot, null, "\t")}\n`;
			if (process.env.UPDATE_FIXTURES) {
				mkdirSync(dirname(fixture), { recursive: true });
				writeFileSync(fixture, serialized);
			}
			expect(
				existsSync(fixture),
				`${cloud} fixture missing — regenerate with UPDATE_FIXTURES=1`,
			).toBe(true);
			// Deep-equal against the committed fixture: any drift between buildConfigSnapshot and the
			// shared fixture the Go harness trusts reds here (regenerate intentionally).
			expect(JSON.parse(serialized)).toEqual(JSON.parse(readFileSync(fixture, "utf8")));
		},
	);
});

// #1974 — the CI-time counterpart to the runner's strict decode.
//
// buildConfigSnapshot used to spread whole `project_*` DB rows (`...d`) into the ten component
// lists, so every element carried its table's bookkeeping and write-back columns. The runner could
// not enforce its unknown-key check over those subtrees, because the fixture above carries EMPTY
// component lists — a strict runtime check with no CI-time counterpart is how you ship an outage.
//
// This is that counterpart. Every seeded row below carries EVERY column of its real table,
// including the ones the pick drops — a row trimmed to the expected output would prove nothing.
// The frozen fixture is then decoded by the Go side (TestSnapshotToProjectConfig_ComponentFixture,
// apps/runner/internal/agent/runner_test.go) through the SAME strict path a real deploy takes, so a
// column that enters the snapshot without a matching field on types.ProjectConfig reds a PR here
// instead of hard-failing a deploy at runtime.
//
// Regenerate after an intentional shape change:
//   UPDATE_FIXTURES=1 pnpm -C apps/console run test t2-config-snapshot
const NOW = "2026-01-01T00:00:00.000Z";
/** Bookkeeping every component table carries (minus estimated_monthly_cost, absent on three). */
const BOOKKEEPING = {
	project_id: "p1",
	environment_id: "env-1",
	status: "PENDING",
	status_message: null,
	created_at: NOW,
	updated_at: NOW,
} as const;

/** canonicalSelect(), re-pointed at AWS and layered with one row of every component kind. */
function componentSelect(): Map<unknown, Rows> {
	// `canonicalSelect("aws")` rather than the hetzner default plus an override: on hetzner
	// hetznerDataServicesToAddOns() folds every database / cache / queue into `addons[]`, and this
	// fixture's whole point is the ten component lists.
	const select = canonicalSelect("aws");
	select.set(projects, [
		{
			id: "p1",
			user_id: "user-1",
			org_id: "org-1",
			cloud_identity_id: "ci-1",
			project_name: "alethia-fixture",
			slug: "alethia-fixture",
			region: "us-east-1",
			iac_version: "1.0.0",
		},
	]);
	// cloud_identity_id / region are left NULL on every row on purpose: that is the inheritance
	// path resolvePlacement() takes, and the one a pick must not break.
	select.set(projectDatabases, [
		{
			id: "db-1",
			...BOOKKEEPING,
			name: "primary",
			cloud_identity_id: null,
			region: null,
			engine_family: "postgres",
			engine: "aurora-postgresql",
			engine_version: "16.4",
			instance_class: "db.serverless",
			min_capacity: 0.5,
			max_capacity: 4,
			storage_gb: 100,
			replicas: 2,
			port: 5432,
			backup_retention_days: 7,
			iam_auth: true,
			endpoint: "primary.cluster-abc.us-east-1.rds.amazonaws.com",
			reader_endpoint: "primary.cluster-ro-abc.us-east-1.rds.amazonaws.com",
			provider_config: { log_exports: ["postgresql"] },
			provider_outputs: { secret_ref: "arn:aws:secretsmanager:…" },
			estimated_monthly_cost: 120,
		},
	]);
	select.set(projectCaches, [
		{
			id: "cache-1",
			...BOOKKEEPING,
			name: "sessions",
			cloud_identity_id: null,
			region: null,
			engine: "redis",
			engine_version: "7.1",
			memory_gb: 8,
			storage_gb: 16,
			node_type: "cache.t4g.medium",
			num_cache_nodes: 2,
			multi_az: true,
			allowed_cidr_blocks: ["10.0.0.0/16"],
			endpoint: "sessions.abc.ng.0001.use1.cache.amazonaws.com",
			reader_endpoint: "sessions-ro.abc.ng.0001.use1.cache.amazonaws.com",
			estimated_monthly_cost: 45,
		},
	]);
	select.set(projectQueues, [
		{
			id: "queue-1",
			...BOOKKEEPING,
			name: "jobs",
			cloud_identity_id: null,
			region: null,
			ordered: true,
			storage_gb: 8,
			visibility_timeout: 30,
			message_retention: 345600,
			provider_config: { fifo_throughput_limit: "perQueue" },
			endpoint: "https://sqs.us-east-1.amazonaws.com/1234/jobs.fifo",
			provider_outputs: { secret_ref: "arn:aws:secretsmanager:…" },
			estimated_monthly_cost: 3,
		},
	]);
	select.set(projectTopics, [
		{
			id: "topic-1",
			...BOOKKEEPING,
			name: "events",
			cloud_identity_id: null,
			region: null,
			estimated_monthly_cost: 1,
		},
	]);
	select.set(topicSubscriptions, [
		{
			topic_id: "topic-1",
			protocol: "https",
			endpoint: "https://example.test/hook",
			ordinal: 0,
		},
	]);
	select.set(projectNosqlTables, [
		{
			id: "nosql-1",
			...BOOKKEEPING,
			name: "sessions",
			cloud_identity_id: null,
			region: null,
			table_type: "standard",
			partition_key: "pk",
			partition_key_type: "S",
			sort_key: "sk",
			sort_key_type: "S",
			capacity_mode: "on_demand",
			point_in_time_recovery: true,
			global_replicas: ["eu-west-1"],
			provider_config: { partition_key_path: "/pk" },
			estimated_monthly_cost: 9,
		},
	]);
	select.set(projectSecrets, [
		{
			id: "secret-1",
			...BOOKKEEPING,
			name: "api-key",
			cloud_identity_id: null,
			region: null,
			provider: "native",
			generate: true,
			length: 32,
			special_chars: true,
			provider_config: {},
		},
	]);
	select.set(projectContainerRegistries, [
		{
			id: "reg-1",
			...BOOKKEEPING,
			name: "apps",
			cloud_identity_id: null,
			region: null,
			provider: "native",
			repository_url: "1234.dkr.ecr.us-east-1.amazonaws.com/apps",
			immutable_tags: true,
			vulnerability_scanning: true,
			provider_config: {},
		},
	]);
	select.set(projectHelmRegistries, [
		{
			id: "helm-1",
			...BOOKKEEPING,
			name: "charts",
			cloud_identity_id: null,
			region: null,
			provider: "ghcr",
			provider_config: { repo_url: "oci://ghcr.io/acme/charts" },
		},
	]);
	select.set(projectStorageBuckets, [
		{
			id: "bucket-1",
			...BOOKKEEPING,
			name: "assets",
			cloud_identity_id: null,
			region: null,
			versioning: true,
			encryption_enabled: true,
			public_access: false,
			cors_origins: ["https://example.test"],
			provider_config: {},
			estimated_monthly_cost: 2,
		},
	]);
	select.set(projectServices, [
		{
			id: "svc-1",
			...BOOKKEEPING,
			name: "web",
			cloud_identity_id: null,
			region: null,
			type: "deployment",
			source: { kind: "repo", repo_url: "https://github.com/acme/web", path: "apps/web" },
			build: { dockerfile: "Dockerfile", context: "apps/web" },
			env: [{ name: "LOG_LEVEL", value: "info" }],
			ports: [{ name: "http", container_port: 8080, protocol: "TCP" }],
			replicas: 3,
			resources: {
				requests: { cpu: "100m", memory: "128Mi" },
				limits: { cpu: "500m", memory: "512Mi" },
			},
			probe: { type: "http", path: "/healthz", port: 8080 },
			// The one write-back column that MUST survive the pick (W2 #591).
			resolved_image: "1234.dkr.ecr.us-east-1.amazonaws.com/apps@sha256:deadbeef",
			estimated_monthly_cost: 30,
		},
	]);
	select.set(serviceBindings, [
		{
			id: "bind-1",
			service_id: "svc-1",
			chart_workload_id: null,
			target_kind: "database",
			target_name: "primary",
			target_address: null,
			output_endpoint: null,
			output_port: null,
			output_credential_secret: null,
			ordinal: 0,
		},
	]);
	select.set(serviceBindingInjections, [
		{ binding_id: "bind-1", env: "DATABASE_URL", from_facet: "endpoint", ordinal: 0 },
	]);
	return select;
}

describe("component lists are an explicit pick, not a DB-row spread (#1974)", () => {
	it("the REAL buildConfigSnapshot freezes the committed AWS component shape", async () => {
		const snapshot = (await frozenSnapshot(componentSelect())) as Record<string, unknown>;

		const serialized = `${JSON.stringify(snapshot, null, "\t")}\n`;
		if (process.env.UPDATE_FIXTURES) {
			mkdirSync(dirname(COMPONENTS_FIXTURE), { recursive: true });
			writeFileSync(COMPONENTS_FIXTURE, serialized);
		}
		expect(
			existsSync(COMPONENTS_FIXTURE),
			`fixture missing — regenerate with UPDATE_FIXTURES=1`,
		).toBe(true);
		expect(JSON.parse(serialized)).toEqual(
			JSON.parse(readFileSync(COMPONENTS_FIXTURE, "utf8")),
		);
	});

	// The fixture above is a deep-equal, so it pins the shape but does not SAY what the shape means.
	// These name the invariant directly, so a regeneration that quietly re-admits a bookkeeping
	// column cannot pass review as "just a fixture refresh".
	it("drops every bookkeeping and write-back column from all ten lists", async () => {
		const snapshot = (await frozenSnapshot(componentSelect())) as Record<
			string,
			Array<Record<string, unknown>>
		>;
		const banned = [
			"id",
			"project_id",
			"environment_id",
			"status",
			"status_message",
			"estimated_monthly_cost",
			"created_at",
			"updated_at",
			"endpoint",
			"reader_endpoint",
			"provider_outputs",
			"repository_url",
			"storage_gb",
			"replicas",
		];
		const lists = [
			"databases",
			"caches",
			"queues",
			"topics",
			"nosql_tables",
			"secrets",
			"container_registries",
			"helm_registries",
			"storage_buckets",
			"services",
		];
		for (const key of lists) {
			expect(snapshot[key], `${key} must be seeded, or this proves nothing`).toHaveLength(1);
			for (const banned_key of banned) {
				// `replicas` is a real contract field on services; it is only bookkeeping on databases.
				if (key === "services" && banned_key === "replicas") continue;
				expect(
					snapshot[key][0],
					`${key}[0] still carries the DB-row column ${banned_key}`,
				).not.toHaveProperty(banned_key);
			}
		}
	});

	it("keeps the fields the runner actually reads, including the write-back it needs", async () => {
		const snapshot = (await frozenSnapshot(componentSelect())) as Record<
			string,
			Array<Record<string, unknown>>
		>;
		// resolved_image is a write-back column, but stripping it sends every repo-sourced deploy
		// back to `:latest` — the W2 #591 regression. It is the exception to the rule above.
		expect(snapshot.services[0].resolved_image).toBe(
			"1234.dkr.ecr.us-east-1.amazonaws.com/apps@sha256:deadbeef",
		);
		// resolvePlacement still inherits the project default through a NULL row column.
		expect(snapshot.databases[0]).toMatchObject({
			cloud_provider: "aws",
			cloud_identity_id: "ci-1",
			region: "us-east-1",
		});
		// The nested lists survive, and are built by the normalized readers (not row spreads).
		expect(snapshot.topics[0].subscriptions).toEqual([
			{ protocol: "https", endpoint: "https://example.test/hook" },
		]);
		expect(snapshot.services[0].bindings).toEqual([
			{
				target: { kind: "database", name: "primary" },
				inject: [{ env: "DATABASE_URL", from: "endpoint" }],
			},
		]);
	});
});

// #1767 — the per-tier overlay path must SURVIVE the DB → snapshot trip. The defect this
// guards is the one that made the field vacuous in the first place: `apps_path` existed on
// the runner contract, rendered, and defaulted — and nothing ever SET it, so every placement
// silently synced the repository root. Presence-only assertions could not see that, so these
// assert the value round-trips AND that unset stays structurally absent (not null, not "") —
// absence is what makes `path: '.'` byte-identical to a pre-field deploy.
describe("repositories.apps_path reaches the config snapshot (#1767)", () => {
	async function repositoriesOf(row: Record<string, unknown> | null) {
		const select = canonicalSelect();
		if (row) select.set(projectRepositories, [row]);
		const snapshot = await frozenSnapshot(select);
		return (snapshot as { repositories: Record<string, unknown> }).repositories;
	}

	it("carries the overlay path when the row sets one", async () => {
		const repositories = await repositoriesOf({
			apps_destination_repo: "https://github.com/alethialabs-io/alethia-examples",
			apps_path: "overlays/dev",
		});
		// EXHAUSTIVE, not `.apps_path`: the emitted block is the whole runner-side
		// ProjectRepositoriesConfig, so `toEqual` also fails when a future column spills into
		// the snapshot — the shape the Go struct strict-decodes is pinned, not just this key.
		expect(repositories).toEqual({
			apps_destination_repo: "https://github.com/alethialabs-io/alethia-examples",
			apps_path: "overlays/dev",
		});
	});

	it("leaves the key ABSENT when the row is null — not null, not empty string", async () => {
		const repositories = await repositoriesOf({
			apps_destination_repo: "https://github.com/alethialabs-io/alethia-examples",
			apps_path: null,
		});
		expect("apps_path" in repositories).toBe(false);
	});

	it("leaves the key ABSENT for an empty string — '' is the unset form, not a value", async () => {
		const repositories = await repositoriesOf({
			apps_destination_repo: "https://github.com/alethialabs-io/alethia-examples",
			apps_path: "",
		});
		expect("apps_path" in repositories).toBe(false);
	});

	it("leaves the key ABSENT when there is no repositories row at all", async () => {
		expect("apps_path" in (await repositoriesOf(null))).toBe(false);
	});
});
