// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Archive,
	Blocks,
	Box,
	Boxes,
	Database,
	GitBranch,
	Globe,
	HardDrive,
	KeyRound,
	ListOrdered,
	Megaphone,
	Network,
	Package,
	Server,
	Table2,
	Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { OTHER_GROUP } from "@/lib/canvas/iac-inventory";
import { connectorLabel, isPluggable } from "@/lib/canvas/environment-connector";
import {
	AUTOSCALER,
	DB_CAPACITY,
	dbEngineFamily,
	DEFAULT_CACHE_NODE,
	DEFAULT_INSTANCE_TYPE,
	DEFAULT_K8S_VERSION,
	getProvider,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import {
	cacheEngines,
	dbEngines,
} from "@/lib/cloud-providers/generated/catalog";
import { unsupportedKindsFor } from "@/lib/cloud-providers/unsupported-kinds";
import { helmRegistryUrl } from "@/lib/connectors/helm-registry-hosts";
import { getConnectorProviderBySlug } from "@/lib/connectors/registry.generated";
import type { NodeConfigMap, NodeKind } from "./types";

/** Where a node's config lands in ProjectFormData. */
export type SchemaKey =
	| "project"
	| "network"
	| "cluster"
	| "dns"
	| "repositories"
	| "databases"
	| "caches"
	| "queues"
	| "topics"
	| "nosql_tables"
	| "secrets"
	| "storage_buckets"
	| "container_registries"
	| "helm_registries"
	| "services"
	// Chart / add-on / external nodes are OUT-OF-BAND (project_addons, project_iac_sources) and are
	// never written into ProjectFormData — this key exists only to satisfy the exhaustive registry;
	// the graph⇄form mappers never read it. See OUT_OF_BAND_KINDS in use-canvas-store.ts.
	| "charts";

/** Display order of the Add-palette groups (mirrors the provisionable service types). */
export const PALETTE_GROUP_ORDER = [
	// The application workload is the north-star centrepiece, so it leads the palette in its own
	// group — above the cloud infrastructure it binds to.
	"Workloads",
	"Data",
	"Storage",
	"Messaging",
	"Security",
	"Networking",
	"Compute",
	"DevOps",
] as const;

/** One of the Add-palette group headings. */
export type PaletteGroup = (typeof PALETTE_GROUP_ORDER)[number];

/** A roadmap ("Soon") row in the Add palette — a service with no Terraform module yet,
 * surfaced disabled in its group so the catalog reads complete. */
export interface RoadmapItem {
	id: string;
	label: string;
	subtitle: string;
	group: PaletteGroup;
	icon: LucideIcon;
	comingSoon: true;
}

/** Roadmap entries appended to their palette group after the addable kinds. */
export const ROADMAP_ITEMS: RoadmapItem[] = [
	{
		id: "volume",
		label: "Volume",
		subtitle: "Persistent block storage for containers",
		group: "Storage",
		icon: HardDrive,
		comingSoon: true,
	},
];

/** One fact on a node's card — a mono micro-label over a mono value. */
export interface NodeFact {
	label: string;
	/** Formatted value. Empty string means "not set yet" (the card renders a muted dash). */
	value: string;
}

/**
 * How a kind renders on the canvas. The design system is grayscale — status reads through dot
 * fill/shape, never hue — so a service is told apart by its GLYPH, its classification rule (the
 * card's top border), and above all by its FACTS: the two or three things that actually matter
 * for that service. A database reads "postgres 16 · 0.5–4 ACU · 7 d"; a bucket reads
 * "private · versioned · 2 origins".
 *
 * Facts are cloud-honest. On a compute-only cloud (Hetzner) a database node is a CloudNativePG
 * cluster running IN the customer's cluster, not a managed service — and the card says so.
 */
export interface NodeCardSpec<K extends NodeKind = NodeKind> {
	/** In priority order. The `compact` LOD tier renders only the first; `full` renders up to 3. */
	facts: (ctx: {
		config: NodeConfigMap[K];
		provider: CloudProviderSlug | null;
	}) => NodeFact[];
	/** Which connection nubs the card draws. Mirrors the derived edge topology (the store's
	 * `deriveEdges`): the network sources the cluster, the cluster sources every leaf. Leaves are
	 * targets only — the default. */
	handles?: { source?: boolean; target?: boolean };
}

export interface NodeKindDef<K extends NodeKind = NodeKind> {
	kind: K;
	schemaKey: SchemaKey;
	cardinality: "singleton" | "array";
	/** CORE must colocate on the project identity; PERIPHERY may diverge; ROOT is the project
	 * anchor; EXTERNAL is not owned by the design (BYO chart / BYO IaC) and is drawn dashed. */
	classification: "core" | "periphery" | "root" | "external";
	/** False for resources with no cloud account (repositories = git). */
	cloudScoped: boolean;
	eyebrow: string;
	label: string;
	icon: LucideIcon;
	/** Canvas card presentation — this IS the card. Every kind has one. */
	card: NodeCardSpec<K>;
	/**
	 * High-cardinality kinds COLLAPSE into one card on the board. A real project carries 30–40
	 * secrets; drawn as 30–40 cards they bury the architecture — the canvas stops being a picture of
	 * the system and becomes a wall of near-identical boxes. Such a kind renders as a single vault
	 * card instead, and its resources are managed as a list inside that card's panel.
	 *
	 * Only the VIEW collapses. The store still holds one node per resource, so graphToForm, the
	 * staged-change diff, drift attribution and per-component status are all untouched.
	 */
	collection?: {
		/** The card's title (plural — "Secrets"). */
		title: string;
		/** Singular noun, for the panel's actions ("Add a secret"). */
		singular: string;
	};
	/** Add-palette presentation (group + cloud-indifferent subtitle). Present on every
	 * ADDABLE kind; absent only for the fixed project root and out-of-band chart nodes. */
	palette?: { group: PaletteGroup; subtitle: string };
	/** Default config for a freshly-added node, given the effective provider. Typed to the
	 * kind's ProjectFormData fragment (the schema's optional/defaulted columns may be omitted). */
	defaultData: (provider: CloudProviderSlug) => NodeConfigMap[K];
	/** Optional pre-add step: pick a value for `key` (e.g. the DB engine) before the node is
	 * created + configured. Kinds without variants are added straight to the canvas. */
	variants?: {
		key: string;
		options: { value: string; label: string; description: string }[];
	};
}

/** Per-kind registry: each entry's `defaultData` is typed to that kind's config fragment. */
export type NodeRegistry = { [K in NodeKind]: NodeKindDef<K> };

// ── card-fact helpers ───────────────────────────────────────────────────────
// Compute-only clouds have no managed data plane: a database/cache/queue node compiles to an
// in-cluster Helm chart instead (see hetzner-services.ts). The cards say so rather than implying
// a managed service exists.
const isInCluster = (provider: CloudProviderSlug | null) => provider === "hetzner";

/**
 * Does this cloud carry the queue's "Ordered (FIFO) delivery" switch into the queue it builds?
 *
 * Alibaba is a documented `queue:ordered` exclusion (infra/offer-exclusions.yaml): MNS takes a
 * `fifo` type and publishes no guarantee behind it, so the switch is deliberately not carried and
 * the queue is built standard whichever way it is set. EXPORTED because two surfaces render this
 * — the canvas card's `Delivery` fact below and the inspector's summary line — and they drifted:
 * the summary was guarded and the card was not, so the card printed FIFO over a standard queue,
 * which is exactly the silence the exclusion exists to prevent. One predicate, both readers.
 */
export const carriesOrderedDelivery = (provider: CloudProviderSlug | null) =>
	provider !== "alibaba";

/** A connector slug as its catalog display name, falling back to the raw slug. */
const providerName = (slug: string | null | undefined): string =>
	(slug ? getConnectorProviderBySlug(slug)?.name : undefined) ?? slug ?? "";

/** Human engine family (+ version) for a database config. The family normalization itself lives in
 * `dbEngineFamily` — this used to re-implement it, and so did the inspector's `engineLabel`, which is
 * three copies of a rule the keyless gate now also depends on. */
function dbEngineLabel(config: {
	engine_family?: string | null;
	engine?: string | null;
	engine_version?: string | null;
}): string {
	const name = dbEngineFamily(config) === "mysql" ? "MySQL" : "PostgreSQL";
	return config.engine_version ? `${name} ${config.engine_version}` : name;
}

/**
 * Single source of truth for node kinds. The palette, command palette, React Flow
 * nodeTypes, and the graph⇄form mappers all derive from this table.
 */
export const NODE_REGISTRY: NodeRegistry = {
	project: {
		kind: "project",
		schemaKey: "project",
		cardinality: "singleton",
		classification: "root",
		cloudScoped: true,
		eyebrow: "Project",
		label: "Project",
		icon: Box,
		card: {
			handles: { source: true },
			facts: ({ config }) => [
				{ label: "Region", value: config.region ?? "" },
				{ label: "Stage", value: config.environment_stage ?? "" },
				{ label: "Tofu", value: config.iac_version ?? "" },
			],
		},
		defaultData: () => ({
			project_name: "",
			environment_stage: "development",
			region: "",
			iac_version: "1.11.4",
		}),
	},
	network: {
		kind: "network",
		schemaKey: "network",
		cardinality: "singleton",
		classification: "core",
		cloudScoped: true,
		eyebrow: "Network",
		label: "Network",
		icon: Network,
		card: {
			handles: { source: true },
			facts: ({ config }) =>
				config.provision_network === false
					? [
							{ label: "Mode", value: "existing" },
							{ label: "Network", value: config.network_id ?? "" },
						]
					: [
							{ label: "CIDR", value: config.cidr_block ?? "" },
							{
								label: "NAT",
								value: config.single_nat_gateway === false ? "per-AZ" : "single",
							},
						],
		},
		palette: { group: "Networking", subtitle: "VPC / VNet & subnets" },
		defaultData: () => ({
			provision_network: true,
			cidr_block: "10.0.0.0/16",
			single_nat_gateway: true,
		}),
	},
	cluster: {
		kind: "cluster",
		schemaKey: "cluster",
		cardinality: "singleton",
		classification: "core",
		cloudScoped: true,
		eyebrow: "Cluster",
		label: "Cluster",
		icon: Server,
		card: {
			handles: { source: true, target: true },
			facts: ({ config }) => {
				// node_size is the cloud-indifferent capability; instance_types is the legacy
				// concrete SKU the resolver falls back to. Show whichever the design actually set.
				const size = config.node_size;
				const shape = size
					? `${size.vcpu} vCPU / ${size.memory_gb} GB`
					: (config.instance_types?.[0] ?? "");
				return [
					{ label: "K8s", value: config.cluster_version ?? "" },
					{
						label: "Nodes",
						value: `${config.node_min_size ?? 1}–${config.node_max_size ?? 1}`,
					},
					{ label: "Shape", value: shape },
				];
			},
		},
		palette: { group: "Compute", subtitle: "Managed Kubernetes (EKS · GKE · AKS)" },
		defaultData: (provider) => ({
			cluster_version: DEFAULT_K8S_VERSION[provider],
			instance_types: [DEFAULT_INSTANCE_TYPE[provider]],
			node_min_size: 2,
			node_max_size: 5,
			node_desired_size: 2,
			provider_config: { [AUTOSCALER[provider].providerConfigKey]: true },
		}),
	},
	database: {
		kind: "database",
		schemaKey: "databases",
		cardinality: "array",
		classification: "core",
		cloudScoped: true,
		eyebrow: "Database",
		label: "Database",
		icon: Database,
		card: {
			facts: ({ config, provider }) =>
				isInCluster(provider)
					? [
							{ label: "Engine", value: dbEngineLabel(config) },
							{
								label: "Storage",
								value: `${config.storage_gb ?? 10} GiB × ${config.replicas ?? 1}`,
							},
							{ label: "Runs as", value: "CloudNativePG" },
						]
					: [
							{ label: "Engine", value: dbEngineLabel(config) },
							{
								label: "Capacity",
								value: `${config.min_capacity ?? "?"}–${config.max_capacity ?? "?"}`,
							},
							{
								label: "Backups",
								value:
									config.backup_retention_days != null
										? `${config.backup_retention_days} d`
										: "",
							},
						],
		},
		palette: { group: "Data", subtitle: "PostgreSQL · MySQL" },
		defaultData: (provider) => {
			const capacity = DB_CAPACITY[provider];
			return {
				name: "primary",
				// Cloud-indifferent: the Go resolver maps the family to the cloud's managed DB.
				engine_family: "postgres",
				min_capacity: capacity.defaultMin,
				max_capacity: capacity.defaultMax,
				port: 5432,
				iam_auth: false,
			};
		},
		variants: {
			key: "engine_family",
			options: [
				{
					value: "postgres",
					label: "PostgreSQL",
					description: "Broad extension support — the default relational choice.",
				},
				{
					value: "mysql",
					label: "MySQL",
					description: "Familiar, with wide tooling and driver compatibility.",
				},
			],
		},
	},
	cache: {
		kind: "cache",
		schemaKey: "caches",
		cardinality: "array",
		classification: "core",
		cloudScoped: true,
		eyebrow: "Cache",
		label: "Cache",
		icon: Zap,
		card: {
			facts: ({ config, provider }) =>
				isInCluster(provider)
					? [
							// The in-cluster chart is always Valkey, whatever engine the config carries.
							{ label: "Engine", value: "Valkey" },
							{
								label: "Storage",
								value: `${config.storage_gb ?? config.memory_gb ?? 8} GiB`,
							},
							{ label: "Nodes", value: String(config.num_cache_nodes ?? 1) },
						]
					: [
							{ label: "Engine", value: config.engine === "valkey" ? "Valkey" : "Redis" },
							{ label: "Node", value: config.node_type ?? "" },
							{
								label: "Nodes",
								value: `${config.num_cache_nodes ?? 1}${config.multi_az ? " · multi-AZ" : ""}`,
							},
						],
		},
		palette: { group: "Data", subtitle: "Redis · Valkey" },
		defaultData: (provider) => ({
			name: "primary",
			engine: "redis",
			node_type: DEFAULT_CACHE_NODE[provider],
			num_cache_nodes: 1,
			multi_az: false,
		}),
		variants: {
			key: "engine",
			options: [
				{
					value: "redis",
					label: "Redis",
					description: "In-memory data store for caching, sessions, and queues.",
				},
				{
					value: "valkey",
					label: "Valkey",
					description: "Open-source Redis fork, drop-in compatible.",
				},
			],
		},
	},
	queue: {
		kind: "queue",
		schemaKey: "queues",
		cardinality: "array",
		classification: "core",
		cloudScoped: true,
		eyebrow: "Queue",
		label: "Queue",
		icon: ListOrdered,
		card: {
			facts: ({ config, provider }) =>
				isInCluster(provider)
					? [
							{ label: "Runs as", value: "RabbitMQ" },
							{ label: "Storage", value: `${config.storage_gb ?? 8} GiB` },
						]
					: [
							{
								label: "Delivery",
								value:
									config.ordered && carriesOrderedDelivery(provider) ? "FIFO" : "standard",
							},
							{ label: "Visibility", value: `${config.visibility_timeout ?? 30} s` },
							{
								label: "Retain",
								value: config.message_retention
									? `${Math.round(config.message_retention / 86400)} d`
									: "",
							},
						],
		},
		palette: { group: "Messaging", subtitle: "SQS · Pub/Sub · Service Bus" },
		defaultData: () => ({
			name: "queue",
			ordered: false,
			visibility_timeout: 30,
			message_retention: 345600,
		}),
	},
	topic: {
		kind: "topic",
		schemaKey: "topics",
		cardinality: "array",
		classification: "core",
		cloudScoped: true,
		eyebrow: "Topic",
		label: "Topic",
		icon: Megaphone,
		card: {
			facts: ({ config }) => {
				const subs = config.subscriptions ?? [];
				return [
					{ label: "Subscriptions", value: String(subs.length) },
					{
						label: "Protocols",
						value:
							subs.length === 0
								? "none"
								: [...new Set(subs.map((s) => s.protocol).filter(Boolean))].join(" · "),
					},
				];
			},
		},
		palette: { group: "Messaging", subtitle: "Pub/Sub topics & subscriptions" },
		defaultData: () => ({
			name: "topic",
			subscriptions: [],
		}),
	},
	nosql: {
		kind: "nosql",
		schemaKey: "nosql_tables",
		cardinality: "array",
		classification: "core",
		cloudScoped: true,
		eyebrow: "NoSQL",
		label: "NoSQL table",
		icon: Table2,
		card: {
			facts: ({ config }) => [
				{ label: "Partition key", value: config.partition_key ?? "" },
				{
					label: "Mode",
					value: config.capacity_mode === "provisioned" ? "provisioned" : "on-demand",
				},
				{ label: "PITR", value: config.point_in_time_recovery === false ? "off" : "on" },
			],
		},
		palette: { group: "Data", subtitle: "DynamoDB · Firestore · Cosmos DB" },
		defaultData: () => ({
			name: "table",
			partition_key: "id",
			partition_key_type: "S",
			table_type: "standard",
			capacity_mode: "on_demand",
			point_in_time_recovery: true,
		}),
	},
	dns: {
		kind: "dns",
		schemaKey: "dns",
		cardinality: "singleton",
		classification: "periphery",
		cloudScoped: true,
		eyebrow: "DNS",
		label: "DNS",
		icon: Globe,
		card: {
			facts: ({ config }) => [
				{ label: "Domain", value: config.domain_name ?? "" },
				{ label: "Certificate", value: config.managed_certificate ? "managed" : "none" },
				{ label: "WAF", value: config.waf_enabled ? "enabled" : "off" },
			],
		},
		palette: { group: "Networking", subtitle: "DNS records, certificates & WAF" },
		defaultData: () => ({
			enabled: true,
			managed_certificate: false,
			waf_enabled: false,
			provider_config: {},
		}),
	},
	secret: {
		kind: "secret",
		schemaKey: "secrets",
		cardinality: "array",
		classification: "periphery",
		cloudScoped: true,
		eyebrow: "Secret",
		label: "Secret",
		icon: KeyRound,
		card: {
			facts: ({ config }) =>
				config.generate === false
					? [{ label: "Value", value: "managed manually" }]
					: [
							{ label: "Value", value: "generated" },
							{
								label: "Length",
								value: `${config.length ?? 32}${config.special_chars === false ? "" : " · symbols"}`,
							},
						],
		},
		// Secrets are the canonical high-cardinality kind — a real project has dozens. They collapse
		// into one vault card; the individual secrets live in its panel.
		collection: { title: "Secrets", singular: "secret" },
		palette: { group: "Security", subtitle: "Managed secrets & credentials" },
		defaultData: () => ({
			name: "secret",
			generate: true,
			length: 32,
			special_chars: true,
		}),
	},
	bucket: {
		kind: "bucket",
		schemaKey: "storage_buckets",
		cardinality: "array",
		classification: "periphery",
		cloudScoped: true,
		eyebrow: "Bucket",
		label: "Bucket",
		icon: Archive,
		card: {
			facts: ({ config }) => {
				const origins = config.cors_origins?.length ?? 0;
				return [
					{ label: "Access", value: config.public_access ? "public" : "private" },
					{ label: "Versioning", value: config.versioning ? "on" : "off" },
					{
						label: "CORS",
						value: origins > 0 ? `${origins} origin${origins > 1 ? "s" : ""}` : "none",
					},
				];
			},
		},
		palette: { group: "Storage", subtitle: "Object storage for files and assets" },
		defaultData: () => ({
			name: "assets",
			versioning: false,
			encryption_enabled: true,
			public_access: false,
		}),
	},
	registry: {
		kind: "registry",
		schemaKey: "container_registries",
		cardinality: "array",
		classification: "periphery",
		cloudScoped: true,
		eyebrow: "Registry",
		label: "Container registry",
		icon: Package,
		card: {
			// Two different registries, so two different fact sets. A pluggable connector REPLACES the
			// cloud's registry (categories/compose.go sets registry_provider, which switches the native
			// ECR/AR/ACR off), so a card that kept printing "Service: ECR" for a Docker Hub registry
			// would name a service this project does not use — and Tags/Scanning are ECR/GAR/ACR
			// features that the connector's registry does not honour either.
			facts: ({ config, provider }) =>
				isPluggable(config.provider)
					? [
							{ label: "Registry", value: connectorLabel(config.provider, "") },
							{
								label: "Host",
								value:
									config.provider_config?.registry_url ??
									config.provider_config?.namespace ??
									"",
							},
						]
					: [
							{ label: "Service", value: provider ? getProvider(provider).registryService : "" },
							// Typed columns since #1811, defaulting TRUE — which is what the templates
							// already build, so an unset value must read as the safer setting here too.
							{
								label: "Tags",
								value: config.immutable_tags === false ? "mutable" : "immutable",
							},
							{
								label: "Scanning",
								value: config.vulnerability_scanning === false ? "off" : "on push",
							},
						],
		},
		palette: { group: "DevOps", subtitle: "Private container images" },
		defaultData: () => ({
			name: "apps",
			immutable_tags: true,
			vulnerability_scanning: true,
			provider_config: {},
		}),
	},
	// A private chart repo (helm_registry connector) the environment pulls Helm charts from. Unlike
	// `registry` this provisions NOTHING — it names a connector whose credential the runner turns into
	// an ArgoCD repository-credential Secret before the add-on/BYO Applications sync.
	// `cloudScoped: false`: the columns exist but nothing places into a cloud, and the design
	// round-trip (`getProjectAsFormData`) keeps only name/provider/provider_config — offering a
	// placement picker here would silently drop the value. A COLLECTION: an environment usually pulls
	// from one or two repos, and they are plumbing rather than architecture, so they ride behind one
	// card instead of scattering across the board.
	helm_registry: {
		kind: "helm_registry",
		schemaKey: "helm_registries",
		cardinality: "array",
		classification: "periphery",
		cloudScoped: false,
		eyebrow: "Chart repo",
		label: "Chart repository",
		icon: Package,
		card: {
			facts: ({ config }) => [
				{ label: "Provider", value: providerName(config.provider) },
				{ label: "URL", value: helmRegistryUrl(config) },
			],
		},
		collection: { title: "Chart repos", singular: "chart repo" },
		palette: { group: "DevOps", subtitle: "Private Helm chart repositories" },
		defaultData: () => ({
			name: "charts",
			provider_config: {},
		}),
	},
	// W1 — a first-class application workload. Not cloud-scoped: a service runs on the cluster, not a
	// cloud account, so it leads the palette in its own Workloads group. The rich config sheet is the
	// class:ui lane (#571). Population from scan/BYO/AI is W5/W6.
	service: {
		kind: "service",
		schemaKey: "services",
		cardinality: "array",
		classification: "core",
		cloudScoped: false,
		eyebrow: "Service",
		label: "Service",
		icon: Boxes,
		palette: {
			group: "Workloads",
			subtitle: "App workload — from your repo or a prebuilt image",
		},
		card: {
			// A service is both a target (it runs ON the cluster) and a source (it BINDS to backing
			// resources — the W3 binding edges originate here).
			handles: { source: true, target: true },
			facts: ({ config }) => [
				{ label: "Type", value: config.type ?? "deployment" },
				{
					label: "Source",
					value:
						config.source.kind === "image" ? config.source.image : config.source.repo_url,
				},
				{ label: "Replicas", value: String(config.replicas) },
			],
		},
		defaultData: () => ({
			name: "service",
			type: "deployment",
			source: { kind: "repo", repo_url: "", path: "" },
			env: [],
			bindings: [],
			ports: [],
			replicas: 2,
		}),
	},
	repositories: {
		kind: "repositories",
		schemaKey: "repositories",
		cardinality: "singleton",
		classification: "periphery",
		cloudScoped: false,
		eyebrow: "GitOps",
		label: "Repository",
		icon: GitBranch,
		card: {
			facts: ({ config }) => [
				{
					label: "Repository",
					value: (config.apps_destination_repo ?? "")
						.replace(/^https?:\/\/(www\.)?(github|gitlab|bitbucket)\.com\//, "")
						.replace(/\.git$/, ""),
				},
				{ label: "Syncs", value: "ArgoCD" },
				// Shown only when SET. apps_path reaches EVERY placement — `user-apps.yaml:34`
				// renders it with no placement branch, and naming a path is what turns overlay
				// discovery OFF (`user-apps-overlays.yaml` gates on `not .AppsPath`).
				//
				// TWO TESTS, because one covers one half. The discovery claim is pinned by
				// TestRender_AppsPathOnDedicatedReplacesDiscovery (packages/core/argocd), which is
				// DEDICATED-ONLY — citing it alone invites the reader to conclude it covers all
				// three modes. The namespace and vcluster halves are pinned by
				// TestNamespaceTenantInputCarriesAppsPath and TestVClusterAppInputCarriesAppsPath
				// (packages/core/provisioner), which assert the path reaches those templates at
				// all; there is no discovery there to replace. It stays conditional because
				// a fact that always read "Path: repository root" would assert a default the
				// operator never chose — a statement about the card, not about what the runner reads.
				...(config.apps_path ? [{ label: "Overlay", value: config.apps_path }] : []),
			],
		},
		palette: { group: "DevOps", subtitle: "GitOps app deployment repo" },
		defaultData: () => ({
			apps_destination_repo: "",
			// "" is the unset form, not a distinct value — the snapshot emit treats empty
			// and null alike and leaves the key absent, so the runner syncs the repo root.
			apps_path: "",
		}),
	},
	// A marketplace add-on the cluster comes up with (Grafana, Loki, Vault, …). Browsed from the Add
	// palette's Add-ons group and configured in a sheet — but until now it was explicitly NOT a graph
	// node, so an installed Grafana was INVISIBLE on the architecture, even though it is an ArgoCD
	// Application whose health and sync are already in the database. Persisted out-of-band in
	// project_addons; defaultData is a placeholder (the real config always comes from the DB).
	addon: {
		kind: "addon",
		schemaKey: "charts",
		cardinality: "array",
		classification: "periphery",
		cloudScoped: false,
		eyebrow: "Add-on",
		label: "Add-on",
		icon: Blocks,
		card: {
			facts: ({ config }) => [
				{ label: "Chart", value: config.version },
				{ label: "Health", value: config.health ?? "—" },
				{ label: "Sync", value: config.sync ?? "—" },
			],
		},
		defaultData: () => ({
			id: "addon",
			name: "addon",
			version: "",
			namespace: "default",
		}),
	},
	// Bring-your-own Helm chart — added via the ⌘K "Sources" flow (not the palette), persisted
	// out-of-band in project_addons, loaded from getProjectByoCharts. defaultData is a placeholder
	// (real config always comes from the attach flow / DB).
	chart: {
		kind: "chart",
		schemaKey: "charts",
		cardinality: "array",
		// Not owned by the design — the customer's own chart, pulled from their repo. Drawn dashed.
		classification: "external",
		cloudScoped: false,
		eyebrow: "Helm chart",
		label: "Helm chart",
		icon: GitBranch,
		// Chart nodes render through their own component (chart-node.tsx) because they carry
		// out-of-band actions (detach / rescan); these facts keep the registry exhaustive and are
		// what a generic renderer would show.
		card: {
			facts: ({ config }) => [
				{
					label: "Repo",
					value: config.repoUrl
						.replace(/^https?:\/\/(www\.)?/, "")
						.replace(/\.git$/, ""),
				},
				{ label: "Ref", value: config.ref },
				{ label: "Namespace", value: config.namespace },
			],
		},
		defaultData: () => ({
			id: "chart",
			repoUrl: "",
			chartPath: "",
			ref: "HEAD",
			namespace: "default",
		}),
	},
	// A workload DESCRIBED from a BYO chart (W5 Path A — Option B): one node per Deployment/
	// StatefulSet/DaemonSet/CronJob/Job the chart renders. Out-of-band (project_chart_workloads),
	// loaded from getProjectChartWorkloads, never addable, never in the Deploy diff. Classified
	// `external` (dashed) like its parent chart — read-mostly and NOT owned by the design, which is
	// exactly what keeps it visually distinct from the solid `core` first-class `service` node (the
	// two-model invariant). Renders through its own component (chart-workload-node.tsx); these facts
	// keep the registry exhaustive. defaultData is a placeholder — real config always comes from the DB.
	chart_workload: {
		kind: "chart_workload",
		schemaKey: "charts",
		cardinality: "array",
		classification: "external",
		cloudScoped: false,
		eyebrow: "Chart workload",
		label: "Chart workload",
		icon: Package,
		card: {
			// Target: the parent chart sources this workload. Source: the workload sources its binding
			// edges to backing resources (the same rule the service node uses).
			handles: { source: true, target: true },
			facts: ({ config }) => [
				{ label: "Kind", value: config.kind },
				{
					label: "Image",
					value: config.rendered.image.replace(/^.*\//, "") || "—",
				},
				{
					label: "Replicas",
					value:
						config.rendered.replicas != null ? String(config.rendered.replicas) : "—",
				},
			],
		},
		defaultData: () => ({
			id: "",
			chartId: "",
			name: "workload",
			kind: "deployment",
			rendered: { image: "", ports: [], env_keys: [] },
			bindings: [],
			config: {},
			valuePaths: {},
		}),
	},
	// One card of a bring-your-own IaC module: every resource of one KIND, in one Terraform
	// module. Out-of-band and read-only — derived from the module's IAC_SCAN inventory (or, once
	// planned, its plan's resource_changes) by lib/canvas/iac-inventory.ts; never addable, never
	// in the Deploy diff. A BYO module is 50–200 resources, and 200 cards is the wall of boxes the
	// collection rule exists to prevent — so it groups, exactly as the Secrets vault does.
	external: {
		kind: "external",
		schemaKey: "charts",
		cardinality: "array",
		// The customer's own module. Alethia plans, prices, drifts and audits it — it does not own
		// its definition. Drawn dashed.
		classification: "external",
		cloudScoped: false,
		eyebrow: "External",
		label: "External resources",
		icon: Boxes,
		// Rendered by the ONE data-driven card (BaseNode), which resolves the glyph + eyebrow through
		// `mappedKind` so the group wears its kind's face. The card's title is the Terraform module,
		// so the facts answer: how much, of what, and how sure are we.
		//
		// `Source` is the honesty fact. A PLAN's addresses are exact and count/for_each-expanded; the
		// static scan's are merely DECLARED — a `count = 3` block is one line there, three in reality.
		// Saying which one you're looking at is the difference between a fact and a guess.
		card: {
			facts: ({ config }) => {
				const types = [...new Set(config.members.map((m) => m.type))];
				const n = config.members.length;
				return [
					{ label: "Resources", value: n === 1 ? "1" : String(n) },
					{
						label: "Types",
						value:
							types.length <= 2
								? types.join(" · ")
								: `${types.slice(0, 2).join(" · ")} +${types.length - 2}`,
					},
					{ label: "Source", value: config.source === "plan" ? "planned" : "declared" },
				];
			},
		},
		defaultData: () => ({
			key: `${OTHER_GROUP}|`,
			mappedKind: null,
			module: "",
			source: "scan" as const,
			members: [],
		}),
	},
};

/** Kinds offered in the palette (everything except the fixed project root). */
// W2: `cluster` + `network` are no longer board nodes — one environment IS one cluster (+ its VPC),
// configured as env SETTINGS (the toolbar "Cluster & network" sheet), not added/removed on the canvas.
// They remain env-scoped DB singletons and still round-trip through graphToForm as hidden store nodes.
export const ADDABLE_KINDS: NodeKind[] = [
	"service",
	"database",
	"cache",
	"queue",
	"topic",
	"nosql",
	"dns",
	"secret",
	"bucket",
	"registry",
	"helm_registry",
	"repositories",
];

/**
 * The kinds a given cloud's template can't provision live in the single server-safe source of
 * truth `lib/cloud-providers/unsupported-kinds.ts` (re-exported here for palette callers), so the
 * deploy-time fail-closed gate in `buildConfigSnapshot` derives from the exact same set the palette
 * hides — un-hide a kind there and BOTH the palette and the gate follow automatically. Compute-only
 * Hetzner runs data services as in-cluster Helm charts and provisions buckets natively via Object
 * Storage; only topic/nosql (no clean single-chart OSS equal) and registry (Harbor add-on covers it)
 * stay hidden there.
 */
export { UNSUPPORTED_KINDS_BY_PROVIDER } from "@/lib/cloud-providers/unsupported-kinds";

/** ADDABLE_KINDS minus the kinds the effective provider can't back (null → all). */
export function addableKindsFor(provider: CloudProviderSlug | null): NodeKind[] {
	const blocked = unsupportedKindsFor(provider);
	if (blocked.length === 0) return ADDABLE_KINDS;
	return ADDABLE_KINDS.filter((k) => !blocked.includes(k));
}

/**
 * The engine values each cloud can actually back, DERIVED from the catalog.
 *
 * This used to be a hardcoded Hetzner carve-out, which was fine while Hetzner was the only cloud
 * with an engine ceiling. It isn't: Azure Managed Redis and ApsaraDB KVStore have no Valkey, so the
 * canvas was offering an engine those clouds cannot build — the #1382 shape on a second axis.
 *
 * Both axes now come from the catalog, which is where "what does this cloud offer" already lived for
 * databases. `DB_ENGINES` is keyed by engine VALUE and carries the abstract `family` the canvas
 * variants use; `CACHE_ENGINES` is keyed by the engine name directly.
 */
const VARIANT_FLOOR: Record<
	string,
	(provider: CloudProviderSlug) => ReadonlySet<string>
> = {
	// `dbEngines`/`cacheEngines` read the CATALOG surface, which carries the abstract `family` the
	// canvas variants are keyed on. (`DB_ENGINES` is the flattened `live` mirror and drops it.)
	database: (p) => new Set(dbEngines(p).map((e) => e.family)),
	cache: (p) => new Set(cacheEngines(p).map((e) => e.value)),
};

/**
 * A kind's variant options filtered to what the effective provider can back. The single engine gate
 * shared by the Add palette's variant step and the inspector's engine radios, so a project can never
 * pick an engine its cloud won't deploy — Hetzner → MySQL (the chart mapper would skip it), or
 * Azure/Alibaba → Valkey (no such product).
 *
 * A kind with no floor entry keeps its full variant list.
 */
export function variantOptionsFor(
	kind: NodeKind,
	provider: CloudProviderSlug | null,
): { value: string; label: string; description: string }[] {
	const options = NODE_REGISTRY[kind].variants?.options ?? [];
	const floor = provider ? VARIANT_FLOOR[kind] : undefined;
	if (!floor || !provider) return options;
	const allowed = floor(provider);
	// An empty floor means the catalog has nothing for this cloud/kind — show everything rather than
	// an empty picker (#918); a missing catalog slice is not evidence that nothing is offered.
	if (allowed.size === 0) return options;
	return options.filter((o) => allowed.has(o.value));
}

/** Singleton kinds may exist at most once on the canvas. */
export const SINGLETON_KINDS: NodeKind[] = [
	"project",
	"network",
	"cluster",
	"dns",
	"repositories",
];
