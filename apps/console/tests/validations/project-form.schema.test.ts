// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from "vitest";
import {
	PROJECT_NAME_MAX_LENGTH,
	environmentMatrixSchema,
	helmRegistryProviderConfigSchema,
	pickFreeProjectName,
	projectFormSchema,
} from "@/lib/validations/project-form.schema";
import { getProvidersForCategory } from "@/lib/connectors/registry.generated";
import {
	HETZNER_ADDON_ID_PREFIXES,
	hetznerNodeNameProblem,
} from "@/lib/cloud-providers/hetzner-services";

const validProject = {
	project: {
		project_name: "my-project",
		environment_stage: "development" as const,
		region: "eu-west-1",
		cloud_identity_id: "660e8400-e29b-41d4-a716-446655440000",
		iac_version: "1.11.4",
	},
	network: { provision_network: true, cidr_block: "10.0.0.0/16", single_nat_gateway: true },
	cluster: { cluster_version: "1.32", provider_config: { enable_karpenter: true }, instance_types: ["t3.medium"], node_min_size: 2, node_max_size: 5, node_desired_size: 2 },
	dns: { enabled: false },
	repositories: {},
	databases: [],
	caches: [],
	queues: [],
	topics: [],
	nosql_tables: [],
	secrets: [],
};

describe("projectFormSchema", () => {
	// project_name is now a free-text display name (Vercel-style); the URL slug is derived
	// from it via slugify in createProject. Only empty / all-symbol / over-length are rejected.
	describe("project.project_name", () => {
		it("rejects empty project_name", () => {
			const data = { ...validProject, project: { ...validProject.project, project_name: "" } };
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("accepts free-text names (uppercase, spaces, apostrophes)", () => {
			for (const project_name of ["My Project", "Acme Cloud", "Bob's API"]) {
				const data = { ...validProject, project: { ...validProject.project, project_name } };
				expect(projectFormSchema.safeParse(data).success).toBe(true);
			}
		});

		it("accepts a slug-shaped name", () => {
			const data = { ...validProject, project: { ...validProject.project, project_name: "my-project-123" } };
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects a name that slugifies to nothing", () => {
			const data = { ...validProject, project: { ...validProject.project, project_name: "@#$%" } };
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		// The bound moved from 50 to PROJECT_NAME_MAX_LENGTH (100) in #3145. Create and rename
		// disagreed — this schema refused anything over 50 while updateProjectName refused only
		// over 100 — so a name between 51 and 100 characters was reachable by renaming and
		// un-creatable by the form. Unified on the permissive bound, because narrowing would have
		// refused existing names on their next edit.
		//
		// Asserted against the CONSTANT and at both sides of the boundary, not at a literal 101:
		// a test written against a hard-coded number silently stops testing the rule the day the
		// rule moves, which is exactly how these two drifted apart in the first place.
		it(`accepts project_name of exactly ${PROJECT_NAME_MAX_LENGTH} chars`, () => {
			const data = { ...validProject, project: { ...validProject.project, project_name: "a".repeat(PROJECT_NAME_MAX_LENGTH) } };
			expect(projectFormSchema.safeParse(data).success).toBe(true);
		});

		it(`rejects project_name > ${PROJECT_NAME_MAX_LENGTH} chars`, () => {
			const data = { ...validProject, project: { ...validProject.project, project_name: "a".repeat(PROJECT_NAME_MAX_LENGTH + 1) } };
			expect(projectFormSchema.safeParse(data).success).toBe(false);
		});
	});

	describe("project required fields", () => {
		it("rejects empty region", () => {
			const data = { ...validProject, project: { ...validProject.project, region: "" } };
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});

		it("rejects empty cloud_identity_id", () => {
			const data = { ...validProject, project: { ...validProject.project, cloud_identity_id: "" } };
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("valid full form", () => {
		it("accepts valid project with all required fields", () => {
			const result = projectFormSchema.safeParse(validProject);
			expect(result.success).toBe(true);
		});

		it("accepts valid project with optional arrays empty", () => {
			const data = { ...validProject, databases: [], caches: [], queues: [], topics: [], nosql_tables: [], secrets: [] };
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("defaults arrays to [] when omitted", () => {
			const data = { project: validProject.project, network: validProject.network, cluster: validProject.cluster, dns: validProject.dns, repositories: validProject.repositories };
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.databases).toEqual([]);
				expect(result.data.caches).toEqual([]);
				expect(result.data.queues).toEqual([]);
				expect(result.data.topics).toEqual([]);
				expect(result.data.nosql_tables).toEqual([]);
				expect(result.data.secrets).toEqual([]);
			}
		});
	});

	describe("databases array", () => {
		it("accepts databases with valid entries", () => {
			const data = {
				...validProject,
				databases: [{ name: "primary", engine: "aurora-postgresql", min_capacity: 0.5, max_capacity: 4 }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects database with empty name", () => {
			const data = {
				...validProject,
				databases: [{ name: "", engine: "aurora-postgresql" }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	// In-cluster sizing (compute-only clouds, e.g. Hetzner): the columns are nullable —
	// NULL/omitted means the mapper defaults apply — and clamped to the inspector's bounds.
	describe("in-cluster sizing fields (storage_gb / replicas)", () => {
		it("accepts explicit sizing on databases, caches, and queues", () => {
			const data = {
				...validProject,
				databases: [{ name: "primary", engine_family: "postgres", storage_gb: 50, replicas: 3 }],
				caches: [{ name: "primary", engine: "valkey", storage_gb: 32 }],
				queues: [{ name: "jobs", storage_gb: 16 }],
			};
			expect(projectFormSchema.safeParse(data).success).toBe(true);
		});

		it("accepts null / omitted sizing (mapper defaults stay authoritative)", () => {
			const data = {
				...validProject,
				databases: [{ name: "primary", storage_gb: null, replicas: null }],
				caches: [{ name: "primary" }],
				queues: [{ name: "jobs", storage_gb: null }],
			};
			expect(projectFormSchema.safeParse(data).success).toBe(true);
		});

		it("rejects negative, zero, fractional, and out-of-bounds sizing", () => {
			const bad = [
				{ databases: [{ name: "d", storage_gb: -5 }] },
				{ databases: [{ name: "d", replicas: 0 }] },
				{ databases: [{ name: "d", replicas: 6 }] },
				{ databases: [{ name: "d", storage_gb: 2048 }] },
				{ databases: [{ name: "d", storage_gb: 10.5 }] },
				{ caches: [{ name: "c", storage_gb: 0 }] },
				{ caches: [{ name: "c", storage_gb: 1024 }] },
				{ queues: [{ name: "q", storage_gb: -1 }] },
				{ queues: [{ name: "q", storage_gb: 512 }] },
			];
			const failures = bad
				.filter(
					(overrides) =>
						projectFormSchema.safeParse({ ...validProject, ...overrides }).success,
				)
				.map((overrides) => JSON.stringify(overrides));
			expect(failures).toEqual([]);
		});
	});

	describe("nosql_tables array", () => {
		it("accepts empty array", () => {
			const result = projectFormSchema.safeParse({ ...validProject, nosql_tables: [] });
			expect(result.success).toBe(true);
		});

		it("accepts valid nosql table", () => {
			const data = {
				...validProject,
				nosql_tables: [{ name: "users", partition_key: "id", partition_key_type: "S", table_type: "standard", capacity_mode: "on_demand" }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects nosql table without partition_key", () => {
			const data = {
				...validProject,
				nosql_tables: [{ name: "users" }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("secrets array", () => {
		it("accepts valid secret", () => {
			const data = {
				...validProject,
				secrets: [{ name: "postgres-password", generate: true, length: 32, special_chars: true }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("rejects secret with empty name", () => {
			const data = {
				...validProject,
				secrets: [{ name: "" }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(false);
		});
	});

	describe("storage_buckets array (S3-safe naming)", () => {
		it("accepts a valid bucket", () => {
			const data = {
				...validProject,
				storage_buckets: [
					{
						name: "my-assets-1",
						versioning: true,
						encryption_enabled: true,
						public_access: false,
						cors_origins: ["https://app.example.com"],
					},
				],
			};
			expect(projectFormSchema.safeParse(data).success).toBe(true);
		});

		it("accepts a minimal 3-char name and a 63-char name", () => {
			for (const name of ["abc", `a${"b".repeat(61)}c`]) {
				const data = { ...validProject, storage_buckets: [{ name }] };
				expect(projectFormSchema.safeParse(data).success).toBe(true);
			}
		});

		it("rejects uppercase, too-short, too-long, and hyphen-edged names", () => {
			const bad = [
				"MyBucket", // uppercase
				"ab", // 2 chars
				"a".repeat(64), // 64 chars
				"-assets", // leading hyphen
				"assets-", // trailing hyphen
				"my_bucket", // underscore
				"", // empty
			];
			const passed = bad.filter(
				(name) =>
					projectFormSchema.safeParse({ ...validProject, storage_buckets: [{ name }] })
						.success,
			);
			expect(passed).toEqual([]);
		});

		it("defaults to [] when omitted", () => {
			const result = projectFormSchema.safeParse(validProject);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.storage_buckets).toEqual([]);
				expect(result.data.container_registries).toEqual([]);
			}
		});
	});

	describe("container_registries array", () => {
		it("accepts a valid registry with provider knobs", () => {
			const data = {
				...validProject,
				container_registries: [
					{
						name: "apps",
						provider_config: { immutable_tags: true, vulnerability_scanning: true },
					},
				],
			};
			expect(projectFormSchema.safeParse(data).success).toBe(true);
		});

		it("rejects a registry with an empty name", () => {
			const data = { ...validProject, container_registries: [{ name: "" }] };
			expect(projectFormSchema.safeParse(data).success).toBe(false);
		});

		it("strips the repository_url output column", () => {
			const data = {
				...validProject,
				container_registries: [
					{ name: "apps", repository_url: "123.dkr.ecr.amazonaws.com/apps" },
				],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.container_registries[0]).not.toHaveProperty("repository_url");
			}
		});
	});

	describe("queues and topics", () => {
		it("accepts valid queue", () => {
			const data = {
				...validProject,
				queues: [{ name: "email-processing", ordered: false, visibility_timeout: 30 }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});

		it("accepts valid topic", () => {
			const data = {
				...validProject,
				topics: [{ name: "user-events", subscriptions: [] }],
			};
			const result = projectFormSchema.safeParse(data);
			expect(result.success).toBe(true);
		});
	});

	describe("services array — W3 bindings", () => {
		const serviceWith = (bindings: unknown) => ({
			...validProject,
			services: [
				{
					name: "api",
					type: "deployment",
					source: { kind: "repo", repo_url: "https://github.com/acme/api", path: "." },
					env: [],
					ports: [],
					bindings,
				},
			],
		});

		it("accepts a service with a valid binding (target + injected facets)", () => {
			const data = serviceWith([
				{
					target: { kind: "database", name: "orders-db" },
					inject: [
						{ env: "DATABASE_HOST", from: "endpoint" },
						{ env: "DATABASE_PASSWORD", from: "password" },
					],
				},
			]);
			expect(projectFormSchema.safeParse(data).success).toBe(true);
		});

		it("accepts a secret-kind binding with the value facet (#1207)", () => {
			const data = serviceWith([
				{
					target: { kind: "secret", name: "stripe-key" },
					inject: [{ env: "STRIPE_KEY", from: "value" }],
				},
			]);
			expect(projectFormSchema.safeParse(data).success).toBe(true);
		});

		it("rejects an unknown injection facet", () => {
			const data = serviceWith([
				{ target: { kind: "database", name: "db" }, inject: [{ env: "X", from: "bogus" }] },
			]);
			expect(projectFormSchema.safeParse(data).success).toBe(false);
		});

		it("rejects an unknown binding target kind", () => {
			const data = serviceWith([
				{ target: { kind: "bucket", name: "assets" }, inject: [{ env: "X", from: "endpoint" }] },
			]);
			expect(projectFormSchema.safeParse(data).success).toBe(false);
		});

		it("rejects an empty target name", () => {
			const data = serviceWith([
				{ target: { kind: "cache", name: "" }, inject: [{ env: "REDIS_URL", from: "endpoint" }] },
			]);
			expect(projectFormSchema.safeParse(data).success).toBe(false);
		});
	});
});

// The chart-repo provider_config validator is parsed AGAIN server-side in writeComponents (the write
// action is a public entry point, and provider_config is spread whole into the persisted
// config_snapshot). These lock the two guarantees that fix relies on.
describe("helmRegistryProviderConfigSchema", () => {
	it("strips any key it never declared — a secret knob a crafted request tacks on can't be persisted", () => {
		const parsed = helmRegistryProviderConfigSchema.parse({
			registry_host: "registry.acme.io",
			// not part of the schema — a hostile/extra knob that must never reach the snapshot
			sneaky_token: "s3cr3t",
		});
		expect(parsed).toEqual({ registry_host: "registry.acme.io" });
		expect("sneaky_token" in parsed).toBe(false);
	});

	it("keeps the declared non-secret knobs", () => {
		expect(
			helmRegistryProviderConfigSchema.parse({ repo_url: "https://charts.acme.io" }),
		).toEqual({ repo_url: "https://charts.acme.io" });
	});

	it("fails closed on a malformed host that would break the seeded repo-cred match", () => {
		// a scheme+path where a bare host is required — waved through today, it yields a credential
		// URL no ArgoCD Application repoURL prefix-matches, surfacing only at deploy.
		expect(
			helmRegistryProviderConfigSchema.safeParse({ registry_host: "https://acme.io/charts" })
				.success,
		).toBe(false);
	});
});

// ── provider_config: shaped, stripped, and pinned to the catalog (#1412) ──────────────────────
//
// These bags are spread WHOLE into the Postgres-persisted config_snapshot, so they are shaped and
// STRIPPED rather than waved through as opaque JSONB. Stripping brings its own hazard — a knob the
// schema doesn't know is dropped SILENTLY — so each category is pinned against catalog.json from
// the other direction too.
//
// That parity check is not hypothetical: RegistryProviderConfig was missing `registry_url`, which
// four active registry connectors REQUIRE and which pullAuth uses as the dockerconfig `auths` key.
// A pull secret built without it authenticates against nothing.
describe("provider_config is pinned to the connector catalog", () => {
	const declaredKnobs = (category: "registry" | "dns" | "secrets") => {
		const keys = new Set<string>();
		for (const provider of getProvidersForCategory(category)) {
			for (const field of provider.providerConfigFields) {
				if (!field.secret) keys.add(field.key);
			}
		}
		return keys;
	};

	it("keeps every knob the registry connectors declare", () => {
		const declared = declaredKnobs("registry");
		expect(declared.size).toBeGreaterThan(0);

		const parsed = projectFormSchema.safeParse({
			...validProject,
			container_registries: [
				{
					name: "apps",
					provider_config: Object.fromEntries([...declared].map((k) => [k, `v-${k}`])),
				},
			],
		});
		if (!parsed.success) throw parsed.error;

		const kept = new Set(Object.keys(parsed.data.container_registries[0].provider_config ?? {}));
		expect([...declared].filter((k) => !kept.has(k))).toEqual([]);
	});

	it("keeps every knob the dns connectors declare", () => {
		const declared = declaredKnobs("dns");
		expect(declared.size).toBeGreaterThan(0);

		const parsed = projectFormSchema.safeParse({
			...validProject,
			dns: {
				enabled: true,
				provider: "cloudflare",
				domain_name: "acme.io",
				zone_id: "zone-1",
				// Cloudflare's `proxied` is a boolean; the rest of the bag is booleans too.
				provider_config: Object.fromEntries([...declared].map((k) => [k, k === "zone_id" ? "z" : true])),
			},
		});
		if (!parsed.success) throw parsed.error;

		const kept = new Set(Object.keys(parsed.data.dns.provider_config ?? {}));
		expect([...declared].filter((k) => !kept.has(k))).toEqual([]);
	});

	// The secrets category had no parity guard, and the hazard is identical: `infisical` addresses one
	// project by TWO identifiers — workspace_id for the tofu write path, project_slug for ESO's
	// in-cluster secretsScope — so a schema that knew only the first would strip the second SILENTLY,
	// and the store would render pointing at nothing. Caught exactly that while adding project_slug.
	it("keeps every knob the secrets connectors declare", () => {
		const declared = declaredKnobs("secrets");
		expect(declared.size).toBeGreaterThan(0);

		const parsed = projectFormSchema.safeParse({
			...validProject,
			secrets: [
				{
					name: "api-key",
					provider: "infisical",
					provider_config: Object.fromEntries([...declared].map((k) => [k, `v-${k}`])),
				},
			],
		});
		if (!parsed.success) throw parsed.error;

		const kept = new Set(Object.keys(parsed.data.secrets[0].provider_config ?? {}));
		expect([...declared].filter((k) => !kept.has(k))).toEqual([]);
	});

	it("strips a key no registry connector declares, so it can't reach the config snapshot", () => {
		const parsed = projectFormSchema.safeParse({
			...validProject,
			container_registries: [
				{
					name: "apps",
					// A token pasted into the wrong field would otherwise be stored verbatim.
					// `immutable_tags` rides along for a second reason: it became a typed column in
					// #1811, so a stale payload still carrying it here must be DROPPED rather than
					// round-tripped into the config snapshot as a second answer to the same question.
					provider_config: {
						namespace: "acme",
						immutable_tags: true,
						password: "s3cr3t-should-not-persist",
					},
				},
			],
		});
		if (!parsed.success) throw parsed.error;
		expect(parsed.data.container_registries[0].provider_config).toEqual({ namespace: "acme" });
	});
});

// ── the registry connector selection is fail-closed (#1412) ──────────────────────────────────
describe("registry connector selection", () => {
	const parseRegistry = (row: Record<string, unknown>) =>
		projectFormSchema.safeParse({ ...validProject, container_registries: [row] });

	it("accepts the cloud's own registry with no connector", () => {
		expect(parseRegistry({ name: "apps" }).success).toBe(true);
		expect(parseRegistry({ name: "apps", provider: "native" }).success).toBe(true);
	});

	it("accepts a connector whose required knobs are filled", () => {
		expect(
			parseRegistry({
				name: "apps",
				provider: "harbor",
				provider_config: { registry_url: "harbor.acme.io" },
			}).success,
		).toBe(true);
	});

	// registry_url is the registry's ADDRESS: registry_generic.go fails Validate without it and
	// pullAuth has no dockerconfig `auths` key, so the pull secret authenticates against nothing.
	it("rejects an any-host connector with no registry_url", () => {
		expect(parseRegistry({ name: "apps", provider: "harbor", provider_config: {} }).success).toBe(
			false,
		);
	});

	it("accepts a connector that declares no required knobs", () => {
		expect(parseRegistry({ name: "apps", provider: "ghcr" }).success).toBe(true);
	});

	it("rejects a slug the catalog doesn't have", () => {
		expect(parseRegistry({ name: "apps", provider: "not-a-registry" }).success).toBe(false);
	});

	// The *-xacct registries are coming_soon AND dark-flagged: selecting one provisions the pull
	// identity in tofu while no refresher renders and no pull secret ever exists.
	it("rejects a registry that isn't available yet", () => {
		expect(
			parseRegistry({
				name: "apps",
				provider: "ecr-xacct",
				provider_config: {
					target_account_id: "222222222222",
					region: "us-east-1",
					registry_host: "222222222222.dkr.ecr.us-east-1.amazonaws.com",
					target_role_arn: "arn:aws:iam::222222222222:role/pull",
				},
			}).success,
		).toBe(false);
	});
});

// ── the DNS connector selection is fail-closed (#1412) ────────────────────────────────────────
describe("dns connector selection", () => {
	const parseDns = (dns: Record<string, unknown>) =>
		projectFormSchema.safeParse({ ...validProject, dns });

	it("accepts cloud-native DNS with no connector", () => {
		expect(parseDns({ enabled: true, domain_name: "acme.io" }).success).toBe(true);
		expect(parseDns({ enabled: true, domain_name: "acme.io", provider: "native" }).success).toBe(
			true,
		);
	});

	it("accepts Cloudflare with a zone on the column", () => {
		// The column is the single source: dns_cloudflare.go prefers provider_config.zone_id but
		// falls back to project_dns.zone_id, so either satisfies the runtime.
		expect(
			parseDns({
				enabled: true,
				provider: "cloudflare",
				domain_name: "acme.io",
				zone_id: "zone-123",
			}).success,
		).toBe(true);
	});

	// Fail-closed: without a zone, Cloudflare's own Validate rejects the job at compose time — far
	// from the design surface that could have said so.
	it("rejects Cloudflare with no zone anywhere", () => {
		expect(
			parseDns({ enabled: true, provider: "cloudflare", domain_name: "acme.io" }).success,
		).toBe(false);
	});

	// DNSProvider() hard-codes "cloudflare" and returns "" for any other non-native slug, which
	// DISABLES external-dns rather than falling back to the cloud. An unknown slug must not persist.
	it("rejects a slug the catalog doesn't have", () => {
		expect(
			parseDns({
				enabled: true,
				provider: "route53",
				domain_name: "acme.io",
				zone_id: "z",
			}).success,
		).toBe(false);
	});
});

// #3588. A node name becomes Kubernetes object names — `queue-<name>` Applications, a
// `registry-<name>` Service, the Secret the runner seeds a queue's credentials into — and the
// runner validates every one of them against the DNS-1123 LABEL charset before it interpolates
// them into a `kubectl` command.
//
// A name outside that charset used to be accepted here and then failed with nothing said: it
// renders VALID Kubernetes objects, they apply cleanly, and the StatefulSet then sits at
// CreateContainerConfigError forever because no credential was ever seeded. The person typing the
// name is the only human in that sequence, and was the one person not told.
describe("a node name is NOT constrained by the form schema (#3588)", () => {
	// The regression this replaces: the DNS-1123 rule lived here, fired on every provider, and every
	// write path re-parses the whole document — so an existing AWS project holding `Orders.v2`
	// became unsavable. And the rename the message demanded re-keys the DynamoDB module's
	// `for_each`, so following the advice REPLACED the table. The rule is Hetzner's; it now lives
	// where the provider is known. These assertions pin the schema staying out of it.
	const KINDS = ["databases", "caches", "queues", "topics", "nosql_tables", "container_registries"] as const;

	const nameIssues = (kind: string, name: string) => {
		const parsed = projectFormSchema.safeParse({ ...validProject, [kind]: [{ name }] });
		return (parsed.error?.issues ?? []).filter(
			(issue) => issue.path[0] === kind && issue.path[issue.path.length - 1] === "name",
		);
	};

	for (const kind of KINDS) {
		it(`accepts a name that is legal on AWS but not a DNS label — ${kind}`, () => {
			expect(nameIssues(kind, "Orders.v2")).toHaveLength(0);
		});
	}

	it("still requires a name", () => {
		expect(nameIssues("queues", "")).not.toHaveLength(0);
	});

	it("does not impose a length bound of its own", () => {
		// 45 characters: `db-` + this is 48, well under Kubernetes' 63, and it deploys today even on
		// Hetzner. The rule that rejected it capped at 40, a number no emitter produces.
		expect(nameIssues("databases", "d".repeat(45))).toHaveLength(0);
	});
});

describe("the environment matrix uses the ONE env-name rule (#3665)", () => {
	const env = (name: string) => [
		{ name, stage: "development" as const, placement_mode: "namespace" as const },
	];
	/** The name the matrix would STORE for `name`, or null when it refuses it. */
	const stored = (name: string): string | null => {
		const parsed = environmentMatrixSchema.safeParse(env(name));
		return parsed.success ? parsed.data[0].name : null;
	};

	it("normalizes rather than 400ing, so it agrees with `project env add`", () => {
		// This path used to reject `Prod` against a regex on the raw name while `project env add
		// Prod` accepted it and stored `prod` — one product answering the same question two ways.
		expect(stored("Prod")).toBe("prod");
		// Likewise a trailing hyphen: as a NAME it slugs cleanly, and the namespace field (which is
		// a Kubernetes object name) is where `dev-` is genuinely refused.
		expect(stored("prod-")).toBe("prod");
	});

	it("still accepts an ordinary environment name unchanged", () => {
		// Asserted on the issues rather than on `success`, so a failure prints what was wrong.
		const result = environmentMatrixSchema.safeParse(env("prod"));
		expect(result.error?.issues ?? []).toEqual([]);
		expect(stored("prod")).toBe("prod");
	});

	it("refuses a name that slugs to nothing, and one a console route shadows", () => {
		expect(stored("!!!")).toBeNull();
		expect(stored("settings")).toBeNull();
	});

	it("accepts a namespace Kubernetes accepts and refuses one it does not", () => {
		const withNs = (namespace: string) => [
			{
				name: "dev",
				stage: "development" as const,
				placement_mode: "namespace" as const,
				namespace,
			},
		];
		// `1dev` is a legal Kubernetes namespace the old pattern refused.
		expect(environmentMatrixSchema.safeParse(withNs("1dev")).success).toBe(true);
		expect(environmentMatrixSchema.safeParse(withNs("dev-")).success).toBe(false);
	});
});

describe("hetznerNodeNameProblem — the rule, where the provider is known (#3588)", () => {
	it("rejects a dotted name, naming the object it would become", () => {
		const problem = hetznerNodeNameProblem("queues", "orders.v2");
		expect(problem).toContain("queue-orders.v2");
		expect(problem).toContain("DNS-1123");
	});

	it("rejects an upper-case name", () => {
		expect(hetznerNodeNameProblem("databases", "Orders")).not.toBeNull();
	});

	it("rejects a trailing hyphen, which is not a valid label", () => {
		expect(hetznerNodeNameProblem("caches", "orders-")).not.toBeNull();
	});

	it("accepts an ordinary label", () => {
		expect(hetznerNodeNameProblem("queues", "orders-v2")).toBeNull();
	});

	// The bound is DERIVED from the prefix, not a constant. `registry-` is 9 characters, `db-` is 3,
	// so the two kinds must disagree about the longest legal name by exactly 6 — a single hard-coded
	// cap (the 40 this replaces) cannot produce that, which is what makes this assertion load-bearing
	// rather than decorative.
	it("derives its length bound from the prefix the emitter actually uses", () => {
		const dbMax = 63 - "db-".length;
		const registryMax = 63 - "registry-".length;
		expect(registryMax).toBe(dbMax - 6);

		expect(hetznerNodeNameProblem("databases", "d".repeat(dbMax))).toBeNull();
		expect(hetznerNodeNameProblem("databases", "d".repeat(dbMax + 1))).not.toBeNull();
		expect(hetznerNodeNameProblem("registries", "r".repeat(registryMax))).toBeNull();
		expect(hetznerNodeNameProblem("registries", "r".repeat(registryMax + 1))).not.toBeNull();
	});

	// A 45-character database name deploys today: `db-` + 45 = 48, under 63. The rule that shipped
	// first refused it, which introduces a failure rather than surfacing one.
	it("accepts the 45-character name the old hard-coded cap of 40 refused", () => {
		expect(hetznerNodeNameProblem("databases", "d".repeat(45))).toBeNull();
	});

	// Mirrors the emitter: every kind hetznerDataServicesToAddOns gives an id to is covered, and
	// nothing else is. A seventh charted kind is covered the day it is added to the map.
	it("covers exactly the kinds the mapper charts", () => {
		expect(Object.keys(HETZNER_ADDON_ID_PREFIXES).sort()).toEqual(
			["caches", "databases", "queues", "registries", "tables", "topics"].sort(),
		);
	});
});

// `pickFreeProjectName` — the derived name a cross-cloud clone gets (#3145).
//
// It exists because `duplicateProjectForProvider` rebuilds a project through `createProject` and
// `convertProjectConfig` never touches `project_name`, so without it the clone carries the SOURCE
// project's name in the source project's own org — which the uniqueness check matches against the
// source row itself. The dialog has no name field, so that failed 100% of the time.
describe("pickFreeProjectName", () => {
	it("leaves a free name alone", () => {
		expect(pickFreeProjectName("My App (gcp)", ["My App"])).toBe("My App (gcp)");
	});

	it("suffixes when the name is taken", () => {
		expect(pickFreeProjectName("My App (gcp)", ["My App", "My App (gcp)"])).toBe("My App (gcp) 2");
	});

	it("...and keeps counting past a taken suffix rather than colliding again", () => {
		expect(
			pickFreeProjectName("My App (gcp)", ["My App (gcp)", "My App (gcp) 2", "My App (gcp) 3"]),
		).toBe("My App (gcp) 4");
	});

	// THE PREDICATE MUST MATCH THE INDEX. `projects_org_id_project_name_key` is UNIQUE on
	// (org_id, lower(project_name)), so a case-sensitive check here would hand back a name the
	// database then refuses — skipping the friendly error and surfacing a raw 23505.
	it("compares case-insensitively, because that is what the index enforces", () => {
		expect(pickFreeProjectName("My App (gcp)", ["MY APP (GCP)"])).toBe("My App (gcp) 2");
		expect(pickFreeProjectName("api", ["API", "Api 2"])).toBe("api 3");
	});

	it("an empty org has nothing to avoid", () => {
		expect(pickFreeProjectName("My App (aws)", [])).toBe("My App (aws)");
	});
});
