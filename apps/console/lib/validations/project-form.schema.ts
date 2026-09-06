// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { toRecord } from "@/lib/coerce";
import { HELM_REGISTRY_HOST_RULES } from "@/lib/connectors/helm-registry-hosts";
import { getConnectorProviderBySlug } from "@/lib/connectors/registry.generated";
import { canSlugify } from "@/lib/utils/slugify";
import { environmentNameSchema, namespaceSchema } from "@/lib/validations/names";
import { appsPathSchema } from "@/lib/validations/apps-path";
import {
	environmentLifecycle,
	environmentStage,
	placementMode,
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectDns,
	projectHelmRegistries,
	projectNetwork,
	projectNosqlTables,
	projectQueues,
	projectRepositories,
	projectSecrets,
	projectServices,
	projectSourceRepos,
	projectStorageBuckets,
	projectTopics,
	projects,
} from "@/lib/db/schema";
import type {
	ClusterAdmin,
	ClusterProviderConfig,
	DetectedService,
	DnsProviderConfig,
	HelmRegistryProviderConfig,
	NodeSize,
	NosqlProviderConfig,
	RegistryProviderConfig,
	SecretsProviderConfig,
	StorageProviderConfig,
	TopicSubscription,
} from "@/types/jsonb.types";


/** Longest a project display name may be. One value, because create and rename used to disagree
 * (50 vs 100) and a name in between was reachable by only one of them. */
export const PROJECT_NAME_MAX_LENGTH = 100;

// Insert schemas derived from the Drizzle tables (drizzle-zod) — the replacement
// for the retired supazod `public*InsertSchema` schemas. JSONB columns get their
// typed shapes back via z.custom refinements (drizzle-zod emits z.unknown()
// otherwise) so ProjectFormData keeps the same field types the form components rely on.
const projectsInsert = createInsertSchema(projects);
const networkInsert = createInsertSchema(projectNetwork);
/**
 * Node-pool sizing bounds — clamped to the inspector's own min/max, the same way the in-cluster
 * `storage_gb` overrides below are.
 *
 * EXPORTED because there are TWO write paths into project_cluster and they share no validator:
 * the canvas parses against the schemas in this file, while the CLI builds its own picked insert
 * schema (lib/cli/project-components.ts) and imports nothing from here. A bound written only on
 * the canvas leaves `alethia project component set cluster node_min_size=-4` wide open, so both
 * paths spread THIS object into their `createInsertSchema` refinement rather than restating the
 * numbers.
 *
 * NULL is the "inherit the cloud's default" channel (the columns are nullable), which is why the
 * floor is 1 and not 0: a 0 reaches no tfvar at all — every ProviderTfvars guards emission on
 * `> 0` — so it would be silently discarded rather than honoured.
 *
 * The CROSS-FIELD rule (max >= min, min <= desired <= max) is not here: it can only be expressed
 * as a `.superRefine`, and the CLI's field validator introspects `.shape` to reject unknown keys,
 * which a ZodEffects wrapper would break. It lives on `clusterSchema` below for the canvas, and
 * `CloudProvider.ValidateConfig` (packages/core/cloud/validate.go) is the backstop that catches
 * it on every path — including a CLI `--set` that only carries one of the three fields.
 */
export const clusterNodeSizingBounds = {
	node_min_size: z.number().int().min(1).max(100).nullable().optional(),
	node_max_size: z.number().int().min(1).max(100).nullable().optional(),
	node_desired_size: z.number().int().min(1).max(100).nullable().optional(),
};

// cluster_admins is no longer a project_cluster column (contract phase — it persists to the
// cluster_admins child table), so it's a form-only field extended onto the insert shape.
const clusterInsert = createInsertSchema(projectCluster, {
	provider_config: z.custom<ClusterProviderConfig>().optional(),
	node_size: z.custom<NodeSize>().optional(),
	...clusterNodeSizingBounds,
}).extend({
	cluster_admins: z.custom<ClusterAdmin[]>().optional(),
});
// Cloud-native DNS/WAF/cert knobs plus the Cloudflare connector's own. SHAPED AND STRIPPED rather
// than `z.custom` (a type assertion with no runtime effect) because this object is spread WHOLE into
// the Postgres-persisted config_snapshot — an unrecognised key would be stored verbatim. Same
// reasoning as the helm and secrets lanes.
const dnsProviderConfigSchema: z.ZodType<DnsProviderConfig> = z
	.object({
		// cloud-native
		acm_certificate: z.boolean().optional(),
		managed_certificate: z.boolean().optional(),
		cloudfront_waf: z.boolean().optional(),
		application_waf: z.boolean().optional(),
		cloud_armor: z.boolean().optional(),
		azure_waf: z.boolean().optional(),
		// cloudflare
		zone_id: z.string().optional(),
		proxied: z.boolean().optional(),
	})
	.strip();

const dnsInsert = createInsertSchema(projectDns, {
	provider_config: dnsProviderConfigSchema.optional(),
});
const repositoriesInsert = createInsertSchema(projectRepositories);
const sourceReposInsert = createInsertSchema(projectSourceRepos, {
	services: z.custom<DetectedService[]>().optional(),
});
// In-cluster sizing columns (compute-only clouds, e.g. Hetzner) — clamp to the
// inspector's bounds; NULL/omitted means the in-cluster mapper's defaults apply.
const databasesInsert = createInsertSchema(projectDatabases, {
	storage_gb: z.number().int().min(1).max(1024).nullable().optional(),
	replicas: z.number().int().min(1).max(5).nullable().optional(),
});
const cachesInsert = createInsertSchema(projectCaches, {
	storage_gb: z.number().int().min(1).max(512).nullable().optional(),
});
const queuesInsert = createInsertSchema(projectQueues, {
	storage_gb: z.number().int().min(1).max(256).nullable().optional(),
});
// `subscriptions` is no longer a project_topics column (contract phase — it persists to the
// topic_subscriptions child table), so it's a form-only field extended onto the insert shape.
const topicsInsert = createInsertSchema(projectTopics).extend({
	subscriptions: z.custom<TopicSubscription[]>().optional(),
});
const nosqlInsert = createInsertSchema(projectNosqlTables, {
	provider_config: z.custom<NosqlProviderConfig>().optional(),
});
// Every non-secret knob any `secrets` connector declares, and nothing else.
//
// SHAPED AND STRIPPED, not `z.custom` (which is a type assertion with no runtime effect), because
// this object is spread WHOLE into the Postgres-persisted `config_snapshot`. An unrecognised key —
// a token someone pasted into the wrong place, a knob from a connector that has since changed —
// would otherwise be stored verbatim and ride into the snapshot. That is the shape of the W4 add-on
// leak (plaintext secrets in `project_addons.values`) and of A0.0; a secret belongs in
// `connector_credentials`, encrypted and attached out-of-band at job claim.
//
// Annotated with the column's own JSONB interface so the two can't drift: add a knob to
// SecretsProviderConfig and this stops compiling until the validator learns about it. A test pins
// the key set against catalog.json from the other direction, so a NEW connector knob can't be
// silently stripped either — the failure that would cause (a Doppler project quietly dropped, the
// store then reading the wrong scope) is invisible until deploy.
const secretsProviderConfigSchema: z.ZodType<SecretsProviderConfig> = z
	.object({
		// vault / generic
		mount_path: z.string().optional(),
		kv_version: z.string().optional(),
		// doppler
		project: z.string().optional(),
		config: z.string().optional(),
		// infisical — workspace_id addresses the project for the tofu write path, project_slug for
		// ESO's in-cluster read. Omitting either here would strip it silently on save.
		host: z.string().optional(),
		workspace_id: z.string().optional(),
		project_slug: z.string().optional(),
		env_slug: z.string().optional(),
		folder_path: z.string().optional(),
		// onepassword
		vault: z.string().optional(),
		// cross-account keyless cloud secret managers (*-xacct) — references, never keys
		target_account_id: z.string().optional(),
		target_project_id: z.string().optional(),
		target_subscription_id: z.string().optional(),
		region: z.string().optional(),
		target_role_arn: z.string().optional(),
		vault_url: z.string().optional(),
		target_oidc_provider_arn: z.string().optional(),
		external_id: z.string().optional(),
	})
	.strip();

const secretsInsert = createInsertSchema(projectSecrets, {
	provider_config: secretsProviderConfigSchema.optional(),
});
const bucketsInsert = createInsertSchema(projectStorageBuckets, {
	provider_config: z.custom<StorageProviderConfig>().optional(),
});
// Every pluggable registry provider's knobs. SHAPED AND STRIPPED for the same
// reason as dns above (this rides whole into the persisted config_snapshot), and annotated with the
// column's own JSONB interface so the two can't drift.
//
// `registry_url` is the one that matters most: four active providers require it, and a pull secret
// built without it authenticates against nothing. It was missing from RegistryProviderConfig
// entirely — which is exactly what the catalog-parity test below now catches from the other side.
const registryProviderConfigSchema: z.ZodType<RegistryProviderConfig> = z
	.object({
		// The two cloud-native switches (immutable_tags, vulnerability_scanning) are typed columns
		// now (#1811), so they are deliberately absent here — `.strip()` below drops them from any
		// stale payload rather than round-tripping a value nothing reads.
		// pluggable
		namespace: z.string().optional(),
		registry_url: z.string().optional(),
		// cross-account keyless (*-xacct) — references, never keys
		target_account_id: z.string().optional(),
		target_project_id: z.string().optional(),
		target_subscription_id: z.string().optional(),
		region: z.string().optional(),
		registry_host: z.string().optional(),
		target_role_arn: z.string().optional(),
		target_service_account: z.string().optional(),
		target_identity_client_id: z.string().optional(),
	})
	.strip();

const registriesInsert = createInsertSchema(projectContainerRegistries, {
	provider_config: registryProviderConfigSchema.optional(),
});
// Both knobs flow into the ArgoCD repository-credential `url`, so they are shape-checked rather than
// waved through as opaque JSONB: a stray scheme or a trailing path in `registry_host` yields a
// credential URL that no Application repoURL prefix-matches, which surfaces at deploy as an
// unauthenticated chart pull rather than as a bad value here.
// Annotated with the column's own JSONB interface so the two can't drift: add a knob to
// HelmRegistryProviderConfig and this stops compiling until the validator learns about it.
const helmRegistryProviderConfigSchema: z.ZodType<HelmRegistryProviderConfig> = z
	.object({
		repo_url: z
			.string()
			.trim()
			.url("Enter a full repository URL (https://…)")
			.startsWith("https://", "The repository URL must use https://")
			.optional(),
		registry_host: z
			.string()
			.trim()
			.regex(
				/^[a-z0-9.-]+(:\d+)?$/i,
				"Enter a bare registry host (no scheme, no path) — e.g. registry.acme.io",
			)
			.optional(),
	})
	.strip();

const helmRegistriesInsert = createInsertSchema(projectHelmRegistries, {
	provider_config: helmRegistryProviderConfigSchema.optional(),
});

// W1 — service/workload sub-shapes (validated, not passthrough): a service is the customer's own
// code, so the form drives real config the runner turns into k8s manifests.
const serviceSourceSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("repo"),
		repo_url: z.string().min(1, "Repo URL is required"),
		path: z.string().default(""),
	}),
	z.object({ kind: z.literal("image"), image: z.string().min(1, "Image is required") }),
]);
const serviceBuildSchema = z.object({
	dockerfile: z.string().optional(),
	context: z.string().optional(),
});
// Exported for reuse by the BYO chart-workload validators (lib/validations/chart-workloads.ts),
// which describe the same env/port/resource/binding shapes read off a rendered chart.
export const serviceEnvSchema = z.object({
	name: z.string().min(1, "Env var name is required"),
	value: z.string(),
});
export const servicePortSchema = z.object({
	name: z.string().optional(),
	container_port: z.number().int().min(1).max(65535),
	protocol: z.enum(["TCP", "UDP"]).optional(),
});
const serviceQuantitySchema = z.object({ cpu: z.string(), memory: z.string() });
export const serviceResourcesSchema = z.object({
	requests: serviceQuantitySchema,
	limits: serviceQuantitySchema,
});
const serviceProbeSchema = z.object({
	type: z.enum(["http", "tcp"]),
	path: z.string().optional(),
	port: z.number().int().min(1).max(65535),
});
// W3 — a service's edge to a backing resource ({kind, name}) plus the env each connection facet
// injects. `from` distinguishes non-secret facets (endpoint/port → templated values) from
// credential facets (→ ExternalSecret secretKeyRef); the runner resolves them at deploy time.
export const serviceBindingSchema = z.object({
	target: z.object({
		kind: z.enum(["database", "cache", "queue", "secret"]),
		name: z.string().min(1, "Binding target is required"),
		// BYO-IaC target only: its Terraform address + the customer module's output names the
		// facets resolve against (#687). Absent for a first-class component; wire keys mirror the
		// Go `ServiceBindingTarget` json tags.
		address: z.string().optional(),
		output_keys: z
			.object({
				endpoint: z.string().optional(),
				port: z.string().optional(),
				credential_secret: z.string().optional(),
			})
			.optional(),
	}),
	inject: z.array(
		z.object({
			env: z.string().min(1, "Env var name is required"),
			from: z.enum([
				"endpoint",
				"port",
				"username",
				"password",
				"connection_string",
				// value — a `secret`-kind binding's opaque value (project secret via a SaaS store).
				"value",
			]),
		}),
	),
});
const servicesInsert = createInsertSchema(projectServices, {
	source: serviceSourceSchema,
	build: serviceBuildSchema.nullable().optional(),
	env: z.array(serviceEnvSchema),
	ports: z.array(servicePortSchema),
	resources: serviceResourcesSchema.nullable().optional(),
	probe: serviceProbeSchema.nullable().optional(),
});

/**
 * A component node's name.
 *
 * IT IS NOT VALIDATED AS A DNS LABEL HERE, AND THAT IS THE FIX FOR #3588, NOT AN OVERSIGHT.
 *
 * The rule is real, but it is a HETZNER rule. Only `hetznerDataServicesToAddOns` turns a node name
 * into a Kubernetes object name (`db-` / `cache-` / `queue-` / `topic-` / `nosql-` / `registry-`),
 * and it is reached only under `identity.provider === "hetzner"` (projects.ts). On AWS the same
 * field goes raw into tofu: a table's name IS `table_name_suffix`, which
 * `infra/templates/project/aws/modules/dynamodb/dynamodb.tf` uses as its `for_each` KEY. DynamoDB
 * accepts `[A-Za-z0-9_.-]`, so `Orders.v2` is legal there and deploys today.
 *
 * Enforcing the label rule in this schema did two things, both bad, and neither visible from here:
 *
 *  1. Every write path re-parses the whole document, so an existing AWS project holding such a name
 *     became UNSAVABLE — not blocked from deploying, unable to be edited at all.
 *  2. The rename the error demanded re-keys that `for_each`, so tofu REPLACES the table. The
 *     remedy the message named would have destroyed the data it was protecting.
 *
 * So the check moved to `buildConfigSnapshot`, next to the DNS and WAF gates, where the provider is
 * known and where it can be scoped to the paths that CREATE — the same two constraints those gates
 * already document: mirror the emitter exactly, and never wedge a project that already exists.
 */
function nodeNameSchema(kind: string) {
	return z.string().min(1, `${kind} name is required`);
}

const autoFields = { id: true, created_at: true, updated_at: true } as const;
const componentAutoFields = {
	...autoFields,
	project_id: true,
	status: true,
	status_message: true,
	estimated_monthly_cost: true,
} as const;

/**
 * The environment MATRIX the placement selector produces (#844): one entry per environment, each
 * naming its placement onto a Fabric. `insertProjectWithDefaultFabric` fans it out — a Fabric per
 * `dedicated` env plus ONE shared Fabric for the `namespace`/`vcluster` envs — and enforces the rest
 * of the invariant (exactly one default, the reserved name `shared`, at most 8).
 *
 * Exported, and used by `projectSchema.environments` below, because the CLI's create route needs the
 * SAME validator. Without it the CLI could send no matrix at all, so every environment it created
 * came out `dedicated` — a whole cluster each, four clouds × two tiers = eight clusters where the
 * product's own story is four. Two definitions of a placement matrix would be worse than one shared
 * one, since the fan-out enforcing the invariant only sees whatever shape reaches it.
 */
export const environmentMatrixSchema = z
	.array(
		z.object({
			// One environment-name rule, shared with `project env add` and the two server actions
			// (lib/validations/names.ts). It NORMALIZES rather than refuses: this path used to 400
			// on `Prod` against a raw-name regex while `project env add Prod` accepted it and stored
			// `prod`, which is one product answering the same question two ways. What it still
			// refuses is what normalising cannot fix — a name that slugs to nothing, and a name a
			// console route would permanently shadow.
			name: environmentNameSchema,
			stage: z.enum(environmentStage.enumValues),
			placement_mode: z.enum(placementMode.enumValues),
			lifecycle: z.enum(environmentLifecycle.enumValues).optional(),
			// The k8s destination namespace. Kubernetes' own grammar, exactly: the old pattern
			// refused `1dev`, which Kubernetes accepts.
			namespace: namespaceSchema.nullish(),
			is_default: z.boolean().optional(),
		}),
	)
	// At most the four-env matrix; exactly one default is enforced in the core fan-out.
	.max(8);

const projectSchema = projectsInsert
	.omit({
		...autoFields,
		user_id: true,
		estimated_monthly_cost: true,
	})
	.extend({
		// Free-text display name (Vercel-style): the URL slug is derived from it via
		// `slugify` in createProject. We only require it slugifies to something non-empty.
		//
		// The cap is PROJECT_NAME_MAX_LENGTH rather than a literal, because this schema and
		// `updateProjectName` disagreed: create refused anything over 50, rename refused only
		// over 100. So a name between 51 and 100 characters was reachable by renaming and
		// un-reachable by creating, and the create form could not reproduce a project the rename
		// path had already made. Unified on the PERMISSIVE bound: narrowing to 50 would refuse
		// existing names on their next edit, and nothing downstream needs the shorter one — the
		// slug is capped independently at 63 by `slugify`.
		project_name: z
			.string()
			.min(1, "Project name is required")
			.max(PROJECT_NAME_MAX_LENGTH)
			.refine((v) => canSlugify(v), "Enter at least one letter or number"),
		region: z.string().min(1, "Region is required"),
		cloud_identity_id: z.string().min(1, "Cloud account is required"),
		container_platform: z.string().optional(),
		// M1: environment_stage moved off the projects table; the form still captures the
		// project's INITIAL environment (createProject turns it into the default env row).
		environment_stage: z.enum(["development", "staging", "production"]),
		// The default (Production) env's placement onto its first Fabric. Optional — createProject
		// defaults it to `dedicated` (the new Fabric's owner). The placement selector (#844) sets it.
		placement_mode: z.enum(placementMode.enumValues).optional(),
		// The full environment matrix from the placement selector (#844). When present, createProject
		// fans it out (a Fabric per `dedicated` env + one shared Fabric for the shared placements);
		// absent, the legacy Prod(dedicated)+Preview(namespace) shape is kept. Exactly one is_default.
		environments: environmentMatrixSchema.optional(),
	});

const networkSchema = networkInsert
	.omit(componentAutoFields)
	.superRefine((data, ctx) => {
		if (data.provision_network === false && !data.network_id) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Select a VPC when using an existing network",
				path: ["network_id"],
			});
		}
	});

// Cross-field node-pool sizing. `clusterSchema` carried ZERO refinements until now, so a pool
// whose max sits below its min — or whose desired sits outside the range entirely — saved
// cleanly. Four of the five templates hard-fail on `max >= min` at plan; NOTHING at any layer
// checked `min <= desired <= max`, so a bad desired planned clean and was rejected by the
// cluster API mid-apply. Null means "inherit the cloud's default", so each comparison only runs
// when both of its operands are set.
const clusterSchema = clusterInsert
	.omit({
		...componentAutoFields,
		cluster_name: true,
		cluster_endpoint: true,
	})
	.superRefine((data, ctx) => {
		const { node_min_size: min, node_max_size: max, node_desired_size: desired } = data;

		if (min != null && max != null && max < min) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Max nodes must be at least min nodes",
				path: ["node_max_size"],
			});
		}
		if (desired != null && min != null && desired < min) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Desired nodes must be at least min nodes",
				path: ["node_desired_size"],
			});
		}
		if (desired != null && max != null && desired > max) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Desired nodes must be at most max nodes",
				path: ["node_desired_size"],
			});
		}
	});

// Fail-closed on the connector selection, mirroring the secrets and helm lanes.
//
// `provider` and `provider_config` are nullable columns, so the generated schema alone would persist
// knobs with no slug — which is precisely the state the dropped-`provider` mapping used to produce,
// and it fails OPEN: DNSProvider() reverts to the cloud's native backend and the deploy looks fine
// while ignoring the connector the user chose.
//
// DNS is also not an open connector list. DNSProvider() (argocd/infra_facts.go) hard-codes
// "cloudflare" and returns "" for any other non-native slug — which DISABLES external-dns rather
// than falling back. So a slug added to the catalog must not become silently selectable here.
const dnsSchema = dnsInsert.omit(componentAutoFields).superRefine((value, ctx) => {
	if (!value.provider || value.provider === "native") return;

	const provider = getConnectorProviderBySlug(value.provider);
	if (!provider || provider.category !== "dns") {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["provider"],
			message: "Select a connected DNS provider",
		});
		return;
	}
	if (provider.status === "coming_soon") {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["provider"],
			message: "This DNS provider isn't available yet",
		});
		return;
	}
	// Cloudflare needs a zone. The column is the single source (categories/dns_cloudflare.go prefers
	// provider_config.zone_id but falls back to it), so accept either rather than forcing a duplicate.
	if (!value.zone_id?.trim() && !toRecord(value.provider_config).zone_id) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["zone_id"],
			message: `${provider.name} needs the hosted zone ID`,
		});
	}
});

const repositoriesSchema = repositoriesInsert
	.omit({
		...autoFields,
		project_id: true,
	})
	// #1767 — `apps_path` is a bare nullable text() column, so drizzle-zod on its own accepts
	// "../../etc" and "overlays/'dev'": the value would save cleanly, reach the config snapshot,
	// and only die at deploy time when argocd.ValidateAppsPath (the authoritative, fail-closed
	// guard) refuses it. This mirrors that guard so the inspector says so inline instead.
	// `.extend` LAST, so the mirror wins over the column's inferred `z.string().nullable()`.
	.extend({ apps_path: appsPathSchema });

// One scanned source repo (or monorepo subtree) attached to the project. Multiple
// allowed (1:N) — the inference merge collects them; ArgoCD's destination stays the
// single `repositories.apps_destination_repo`.
const sourceRepoItemSchema = sourceReposInsert
	.omit({ ...autoFields, project_id: true })
	.extend({ repo_url: z.string().min(1, "Repo URL is required") });

const databaseItemSchema = databasesInsert.omit({
	...componentAutoFields,
	endpoint: true,
	reader_endpoint: true,
}).extend({ name: nodeNameSchema("Database") });

const cacheItemSchema = cachesInsert.omit({
	...componentAutoFields,
	endpoint: true,
	reader_endpoint: true,
}).extend({ name: nodeNameSchema("Cache") });

const queueItemSchema = queuesInsert
	.omit(componentAutoFields)
	.extend({ name: nodeNameSchema("Queue") });

const topicItemSchema = topicsInsert
	.omit(componentAutoFields)
	.extend({ name: nodeNameSchema("Topic") });

const nosqlItemSchema = nosqlInsert
	.omit(componentAutoFields)
	.extend({
		name: nodeNameSchema("Table"),
		partition_key: z.string().min(1, "Hash key is required"),
	});

// Where this secret is read from. `provider` NULL / "native" is the cluster cloud's own secret store
// (the default); anything else names a connected `secrets` connector.
//
// The refinement makes a pluggable selection FAIL-CLOSED. `provider` and `provider_config` are
// nullable columns, so the generated schema alone would persist a slug that doesn't exist, one that
// isn't available yet, or one missing the knobs it can't work without — and the failure would only
// surface at deploy, as a skipped ExternalSecret or a store that never reads. Mirrors the
// helm_registry guard below and the `Validate` implementations in packages/core/categories/secrets_*.go.
//
// Deliberately NOT rejected here: `onepassword`. It is `active` and the runtime accepts it, so
// failing it closed would break projects already configured through the CLI. It has no in-cluster read
// path on the pinned chart, which is a UI concern — the picker renders it disabled with that reason
// rather than letting a new one be chosen. (`infisical` left this set with the ESO 0.9.20 pin, which
// ships its provider; it is now a normal selectable store.)
const secretItemSchema = secretsInsert
	.omit({
		...autoFields,
		project_id: true,
		status: true,
		status_message: true,
	})
	.extend({ name: nodeNameSchema("Secret") })
	.superRefine((value, ctx) => {
		// Native is the default and needs no connector.
		if (!value.provider || value.provider === "native") return;

		const provider = getConnectorProviderBySlug(value.provider);
		if (!provider || provider.category !== "secrets") {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["provider"],
				message: "Select a connected secret store",
			});
			return;
		}
		if (provider.status === "coming_soon") {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["provider"],
				message: "This secret store isn't available yet",
			});
			return;
		}
		// A required knob is what the store is addressed BY (Vault's mount path, Doppler's project +
		// config, a cross-account target). Without it the store renders but reads nothing.
		const knobs = toRecord(value.provider_config);
		for (const field of provider.providerConfigFields) {
			if (!field.required || field.secret) continue;
			const raw = knobs[field.key];
			if (typeof raw !== "string" || raw.trim() === "") {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["provider_config"],
					message: `${provider.name} needs ${field.label}`,
				});
				return;
			}
		}
	});

// S3-safe bucket naming (the strictest cloud rules, so one name works everywhere):
// 3–63 chars, lowercase letters / digits / hyphens, no leading or trailing hyphen.
const S3_SAFE_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

const bucketItemSchema = bucketsInsert
	.omit(componentAutoFields)
	.extend({
		name: z
			.string()
			.min(1, "Bucket name is required")
			.refine(
				(v) => S3_SAFE_NAME.test(v),
				"3–63 lowercase letters, digits, or hyphens; must start and end with a letter or digit",
			),
	});

const registryItemSchema = registriesInsert
	.omit({
		...autoFields,
		project_id: true,
		status: true,
		status_message: true,
		// Output column (set after the first deploy), never designed by the user.
		repository_url: true,
	})
	.extend({ name: nodeNameSchema("Registry") })
	.superRefine((value, ctx) => {
		// Native is the default and needs no connector.
		if (!value.provider || value.provider === "native") return;

		const provider = getConnectorProviderBySlug(value.provider);
		if (!provider || provider.category !== "registry") {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["provider"],
				message: "Select a connected container registry",
			});
			return;
		}
		// The *-xacct registries are coming_soon AND dark-flagged behind
		// ALETHIA_XACCT_REGISTRY_ENABLED: selecting one still provisions the pull identity in tofu
		// while no refresher renders and no pull secret ever exists.
		if (provider.status === "coming_soon") {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["provider"],
				message: "This registry isn't available yet",
			});
			return;
		}
		// A required knob is the registry's ADDRESS (registry_url for the any-host providers). Without
		// it, categories/registry_generic.go fails Validate at compose time and pullAuth has no
		// dockerconfig `auths` key — the pull secret authenticates against nothing.
		for (const field of provider.providerConfigFields) {
			if (!field.required || field.secret) continue;
			const raw = toRecord(value.provider_config)[field.key];
			if (typeof raw !== "string" || raw.trim() === "") {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["provider_config"],
					message: `${provider.name} needs ${field.label}`,
				});
				return;
			}
		}
	});

// Private chart-repo selection (helm_registry connector). No output column — the seeded
// ArgoCD repo-cred is runner-side state, not a design field.
//
// The refinement is what makes the selection FAIL-CLOSED. `provider` and `provider_config` are
// nullable columns, so the generated schema alone would happily persist a row with no provider or
// no host — the runner would then skip it (`HelmRepoCredSpecs` joins the error and moves on) and
// the chart would fail to pull at deploy with no design-time signal. These mirror the `Validate`
// implementations in packages/core/categories/helm_registry_*.go.
const helmRegistryItemSchema = helmRegistriesInsert
	.omit({
		...autoFields,
		project_id: true,
		status: true,
		status_message: true,
	})
	.extend({ name: nodeNameSchema("Chart repo") })
	.superRefine((value, ctx) => {
		const rule = value.provider ? HELM_REGISTRY_HOST_RULES[value.provider] : undefined;
		if (!value.provider || !rule) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["provider"],
				message: "Select a connected chart repository provider",
			});
			return;
		}
		if (rule.comingSoon) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["provider"],
				message: "This chart repository provider isn't available yet",
			});
			return;
		}
		// A classic Helm repo is addressed by its full URL; an "any host" OCI provider needs the host.
		const key = !rule.oci ? "repo_url" : rule.wildcard ? "registry_host" : null;
		if (key && !value.provider_config?.[key]?.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["provider_config"],
				message:
					key === "repo_url"
						? "Repository URL is required"
						: "Registry host is required",
			});
		}
	});

// W1 — a first-class service/workload the customer designs on the canvas.
const serviceItemSchema = servicesInsert
	.omit({
		...componentAutoFields,
		// Output column (the W2 build's write-back digest), never designed by the user.
		resolved_image: true,
	})
	.extend({
		name: nodeNameSchema("Service"),
		type: z
			.enum(["deployment", "job", "cronjob", "statefulset"])
			.default("deployment"),
		// bindings live in the service_bindings child table (JSONB column dropped, #1426), so this is a
		// form-only field: the user designs the edges on the canvas and the save path normalizes them
		// into service_bindings. Optional, defaults to [] so pre-W3 services (and fixtures) still parse.
		bindings: z.array(serviceBindingSchema).default([]),
	});

export const projectFormSchema = z.object({
	project: projectSchema,
	network: networkSchema,
	cluster: clusterSchema,
	dns: dnsSchema,
	repositories: repositoriesSchema,
	source_repos: z.array(sourceRepoItemSchema).default([]),
	databases: z.array(databaseItemSchema).default([]),
	caches: z.array(cacheItemSchema).default([]),
	queues: z.array(queueItemSchema).default([]),
	topics: z.array(topicItemSchema).default([]),
	nosql_tables: z.array(nosqlItemSchema).default([]),
	secrets: z.array(secretItemSchema).default([]),
	storage_buckets: z.array(bucketItemSchema).default([]),
	container_registries: z.array(registryItemSchema).default([]),
	helm_registries: z.array(helmRegistryItemSchema).default([]),
	services: z.array(serviceItemSchema).default([]),
});

export type ProjectFormData = z.infer<typeof projectFormSchema>;
export type ProjectFormInput = z.input<typeof projectFormSchema>;

export {
	serviceItemSchema,
	databaseItemSchema,
	cacheItemSchema,
	queueItemSchema,
	topicItemSchema,
	nosqlItemSchema,
	secretItemSchema,
	bucketItemSchema,
	registryItemSchema,
	helmRegistryItemSchema,
	// The chart-repo provider_config validator — parsed again server-side at the write seam so a
	// crafted request can't persist an unknown/secret knob the inspector never offered.
	helmRegistryProviderConfigSchema,
	sourceRepoItemSchema,
	// Singleton sub-schemas — consumed by the canvas for per-node validation.
	projectSchema,
	networkSchema,
	clusterSchema,
	dnsSchema,
	repositoriesSchema,
};

/**
 * A project name the org does not already hold, for a clone the user did not get to name.
 *
 * `duplicateProjectForProvider` rebuilds a project through `createProject`, and
 * `convertProjectConfig` never touches `project_name` — the same-provider branch is a bare
 * `structuredClone`. Without a derived name the clone carries the SOURCE project's name in the
 * source project's own org, which #3145's uniqueness check matches against the source row itself:
 * the cross-cloud duplicate dialog has no name field, so it failed 100% of the time.
 *
 * Mirrors `pickFreeSlug`'s shape but compares CASE-INSENSITIVELY, because that is what
 * `projects_org_id_project_name_key` enforces — UNIQUE on `(org_id, lower(project_name))`. Checking
 * with a different predicate than the index enforces is how a friendly message gets skipped and a
 * raw 23505 reaches the user instead.
 *
 * A suggestion, not a guarantee: two concurrent duplicates can derive the same name, and the index
 * is what refuses the loser — mapped onto `ProjectNameTakenError` like any other collision.
 *
 * It lives here rather than beside its caller because that caller is a `"use server"` module, where
 * every export must be an async function — so a pure helper there can be neither exported nor
 * unit-tested.
 */
export function pickFreeProjectName(base: string, taken: string[]): string {
	const used = new Set(taken.map((n) => n.toLowerCase()));
	if (!used.has(base.toLowerCase())) return base;
	let n = 2;
	while (used.has(`${base} ${n}`.toLowerCase())) n++;
	return `${base} ${n}`;
}
