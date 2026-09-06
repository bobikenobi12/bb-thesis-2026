// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Data-driven configuration schema for the node inspector. Each node kind declares its Settings as
// collapsible SECTIONS of typed FIELDS, plus a one-line `summary` for the sheet header. The generic
// renderer (`config-fields.tsx`) turns this into UI, so a new resource kind needs only a schema
// entry here (+ its registry row) — no new inspector components. Dynamic, provider-specific option
// lists / bounds are expressed as functions of the field context.

import { z } from "zod";
import { serviceBindingSchema } from "@/lib/validations/project-form.schema";
import {
	CACHE_NODE_TYPES,
	DB_CAPACITY,
	dbEngineFamily,
	getProvider,
	INSTANCE_TYPES,
	K8S_VERSIONS,
	keylessUnavailableReason,
	NODE_DISK,
	NOSQL,
	wafUnavailableReason,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import { coerceEnum } from "@/lib/coerce";
import { toStrArray } from "@/lib/coerce";
import {
	cacheTierOptions,
	cacheVersionOptions,
	dbEngineOptions,
	dbInstanceClassOptions,
	dbVersionOptions,
	existingNetworkOptions,
	instanceTypeOptions,
	k8sVersionOptions,
	nosqlKeyTypeOptions,
} from "./capability-options";
import { helmRegistryUrl } from "@/lib/connectors/helm-registry-hosts";
import type {
	ConnectorField,
	PluggableCategory,
} from "@/lib/connectors/registry.generated";
import { isPluggable } from "@/lib/canvas/environment-connector";
import { carriesOrderedDelivery, variantOptionsFor } from "../graph/node-registry";
import type { NodeConfigMap, NodeKind } from "../graph/types";

/**
 * The field engine is generic over the node kind's config type `C`. Each per-kind
 * schema entry (CONFIG_SCHEMA below) is typed to its `NodeConfigMap` fragment, so the
 * `summary`/`get`/`set`/`visibleWhen` closures read fully-typed config — no casts. The
 * generic renderer (config-fields.tsx) and the inspector consume the widened default
 * (`Record<string, unknown>`) via `getKindConfig`, since the node kind is only known at
 * runtime there — that single erasure is the boundary inherent to a key-driven engine.
 */
type AnyConfig = Record<string, unknown>;

/**
 * Account-scoped option data, ALREADY RESOLVED to plain arrays and pushed in by the mount point.
 *
 * Never a promise, never a hook, never a fetch: `resolve()` runs on every render — and a second time
 * from `sectionSummary`, to label a collapsed section — so this has to be a cheap immutable
 * snapshot. Making the resolver async instead would infect ConfigFields → every mount point, and
 * would refetch once per mounted select, which is the mistake `repository-context.tsx` exists to
 * avoid.
 *
 * Populated by `use-node-capabilities`; until that lands it is `NO_CAPABILITIES` and every picker
 * resolves to the static catalog exactly as before.
 */
export interface CapabilityBag {
	/** The identity this bag describes. null ⇒ nothing resolved (create flow / no core identity). */
	identityId: string | null;
	/** The provider this bag describes. Compared against `ctx.provider`: a node's effective provider
	 * can diverge from the bag's, and showing another cloud's SKUs is worse than showing none. */
	provider: CloudProviderSlug | null;
	/** The region the region-SCOPED axes were read at (instance types, cache tiers). */
	region: string | null;
	/** Why the bag looks the way it does. Drives a field footnote — NEVER a gate. */
	state: "idle" | "loading" | "syncing" | "ready" | "error";
	/** Per-axis provenance. Some readers collapse their own fail-open, so the client cannot infer
	 * this from the payload — the server reports it. */
	axisSource: Readonly<Record<CapabilityAxis, "account" | "catalog">>;

	regions: string[];
	instanceTypes: CapabilityOption[];
	k8sVersions: CapabilityOption[];
	dbEngines: DbEngineCapabilityOption[];
	/** Concrete managed-DB SKUs, by engine. Unlike every other axis there is NO static catalog behind
	 * it, so an unsynced account leaves this empty and the resolver offers only the resolver default. */
	dbInstanceClasses: DbInstanceClassCapabilityOption[];
	cacheTiers: CapabilityOption[];
	/** Offered cache engine versions. Empty on the clouds that document an exclusion (GCP/Azure/Hetzner). */
	cacheVersions: CapabilityOption[];
	nosqlKeyTypes: CapabilityOption[];
	/** Already-HAS placement inventory (#980) — not a capability axis, no federation involved. */
	networks: PlacementOption[];
	subnets: PlacementSubnetOption[];
}

/**
 * One account-reported option, normalized across axes. `launchable === undefined` is the sentinel
 * for "static fallback row — no per-account signal at all", which must read differently from
 * "synced, and we could not evaluate the quota".
 */
export interface CapabilityOption {
	value: string;
	label: string;
	launchable?: "launchable" | "not_launchable" | "not_evaluable";
	launchableReason?: string | null;
}

/**
 * A managed-database engine option carrying EVERY version the account can launch it at (#1351).
 *
 * The version is its own axis rather than part of the engine's label: the engine is chosen by the
 * `engine_family` radio-card and the version by a separate select, so a single composite
 * "PostgreSQL 16" option cannot serve both. `versions` is newest-first and never empty — the static
 * fallback contributes the catalog's default version as a one-element list.
 */
export interface DbEngineCapabilityOption extends CapabilityOption {
	versions: string[];
}

/**
 * A concrete managed-DB SKU, carrying the engine it was reported for.
 *
 * `engine` is NULL when the cloud offers SKUs per PROJECT rather than per engine (Cloud SQL tiers), and
 * such a row matches whichever engine the node has selected — attaching a per-engine claim the API never
 * made would be a fabricated verdict.
 */
export interface DbInstanceClassCapabilityOption extends CapabilityOption {
	engine: string | null;
}

export interface PlacementOption {
	/** The NATIVE id (`vpc-…`) — project_network.network_id stores this, not the row uuid. */
	nativeId: string;
	name: string | null;
	region: string | null;
	cidrBlock: string | null;
	isDefault: boolean;
}

export interface PlacementSubnetOption extends PlacementOption {
	availabilityZone: string | null;
	isPublic: boolean;
	/** The owning network's row id, for filtering subnets by the selected network. */
	networkRowId: string | null;
}

export type CapabilityAxis =
	| "region"
	| "instance_type"
	| "k8s_version"
	| "database"
	| "db_instance_class"
	| "cache_tier"
	| "cache_version"
	| "nosql"
	| "placement";

const ALL_CATALOG: Readonly<Record<CapabilityAxis, "account" | "catalog">> = Object.freeze({
	region: "catalog",
	instance_type: "catalog",
	k8s_version: "catalog",
	database: "catalog",
	db_instance_class: "catalog",
	cache_tier: "catalog",
	cache_version: "catalog",
	nosql: "catalog",
	placement: "catalog",
});

/**
 * The frozen "no signal" bag. `FieldCtx.caps` is REQUIRED on the type but DEFAULTED to this at
 * construction, so no resolver ever writes `ctx.caps?.x ?? STATIC` — the fail-open rule lives in
 * exactly one place (`capability-options.ts`) instead of being re-implemented per field.
 */
export const NO_CAPABILITIES: CapabilityBag = Object.freeze({
	identityId: null,
	provider: null,
	region: null,
	state: "idle",
	axisSource: ALL_CATALOG,
	regions: [],
	instanceTypes: [],
	k8sVersions: [],
	dbEngines: [],
	dbInstanceClasses: [],
	cacheTiers: [],
	cacheVersions: [],
	nosqlKeyTypes: [],
	networks: [],
	subnets: [],
});

/** Context handed to every resolvable field attribute. */
export interface FieldCtx<C = AnyConfig> {
	provider: CloudProviderSlug | null;
	config: C;
	/** Always present — `NO_CAPABILITIES` when nothing is loaded. */
	caps: CapabilityBag;
}

/** A value that's either static or derived from the field context (provider/config/capabilities). */
export type Resolvable<T, C = AnyConfig> = T | ((ctx: FieldCtx<C>) => T);

/**
 * Advisory on an option. GUIDANCE, never a gate (#918) — the renderer must never map this to
 * `disabled`.
 *
 * There is deliberately NO positive level: "available" is the ABSENCE of ink. That makes
 * "`not_evaluable` must never render as available" a structural property rather than a review rule
 * — no code path exists that can paint an affirmative marker, so a quota we merely could not check
 * can never be mistaken for one we verified.
 */
export interface OptionAdvisory {
	level: "unavailable" | "unverified";
	note: string;
}

export interface FieldOption {
	value: string;
	label: string;
	description?: string;
	advisory?: OptionAdvisory;
}

export type FieldType =
	| "text"
	| "number"
	| "select"
	// A text input that SUGGESTS `options` rather than restricting to them. For the escape-hatch
	// fields whose value the cloud may never list back (a DB SKU, a cache engine version): the
	// account's offerings are the suggestions, but an unlisted value stays typeable, which a
	// `select` structurally cannot allow.
	| "combobox"
	| "radio-card"
	| "switch"
	| "region"
	| "repository"
	// A `string[]` column — CIDR allow-lists, CORS origins, cluster admins, global replicas.
	| "list"
	// A typed row editor over a JSONB array of objects. First use: `topic.subscriptions`, a column
	// that has existed since the baseline migration with no way at all to edit it in the product.
	| "subresource"
	// A service's edges to its backing infrastructure (`service.bindings`). Unlike `subresource`,
	// each row nests a variable-length `inject[]`, so it has its own editor (bindings-field.tsx).
	| "bindings"
	// Which CONNECTED pluggable connector this component uses, plus that provider's non-secret knobs
	// (`providerConfigFields`) — the per-project half of a connector, whose secret half lives once on
	// the org's `connector_credentials` row. Writes `provider` (a connectors.slug) and
	// `provider_config` together, since the knobs are meaningless without the slug that defines them.
	// `helm_registry` is the first consumer; `registry`, `secrets` and `dns` have the same shape.
	| "connector";

/** A row editor over a JSONB array of objects. */
export interface SubresourceSpec {
	/** The fields shown for each row. Rows are plain records — the engine's erasure seam. */
	fields: FieldDef<Record<string, unknown>>[];
	/** A fresh row. */
	create: () => Record<string, unknown>;
	/** The row's heading. */
	title: (item: Record<string, unknown>, index: number) => string;
	/** Singular noun, for "Add a subscription". */
	singular: string;
}

export interface FieldDef<C = AnyConfig> {
	key: string;
	type: FieldType;
	label: string;
	description?: string;
	/** Monospace text input (names, CIDR, ids). */
	mono?: boolean;
	placeholder?: Resolvable<string, C>;
	unit?: Resolvable<string, C>;
	options?: Resolvable<FieldOption[], C>;
	min?: Resolvable<number, C>;
	max?: Resolvable<number, C>;
	step?: Resolvable<number, C>;
	/** Parse numeric input as float (default: int unless a fractional step is set). */
	float?: boolean;
	/** Number field backed by a NULLABLE column: clearing the input patches `null`
	 * ("use the default") instead of 0 — required for `min(1)`-bounded optional sizing
	 * fields, where 0 would block the save with no way back to the default. */
	optional?: boolean;
	/** Field needs an effective cloud provider; renders a notice when none is set. */
	requiresProvider?: boolean;
	/** Span the full section width (radio-card/region/repository/switch already do). */
	full?: boolean;
	/** Hide the field unless the predicate holds (e.g. only when a toggle is on, or only
	 * for a given provider via the context). One-arg closures keep working unchanged. */
	visibleWhen?: (config: C, ctx: FieldCtx<C>) => boolean;
	/**
	 * Why this field cannot be honored on the CURRENT cell (cloud × config), or null when it can.
	 *
	 * Orthogonal to `visibleWhen`, and both may be present. `visibleWhen` says the field is not part
	 * of this shape at all — Hetzner has no ACU capacity, so a capacity knob there is meaningless.
	 * This says the field IS part of the shape and this particular cell cannot honor it, so the
	 * control renders DISABLED with the reason in place of its description. An option that silently
	 * isn't there reads as a bug, while one that says why is an answer (connector-select.tsx).
	 *
	 * NOT `OptionAdvisory`. That is ink-only and must never map to `disabled` (#918); this is the
	 * separate, deliberately-named channel for a real gate, so the two can never be confused.
	 *
	 * A hidden field is never asked — `visibleWhen` filters first, and this never filters.
	 */
	unavailableWhen?: (config: C, ctx: FieldCtx<C>) => string | null;
	/** Normalize raw text input (e.g. lowercasing a name). */
	transform?: (raw: string) => string;
	/** Nested read escape hatch (e.g. `instance_types[0]`). */
	get?: (config: C) => unknown;
	/** Nested write escape hatch — returns the patch to merge into config. */
	set?: (value: unknown, config: C) => Partial<C>;
	/** `list` only: the shape of one row. */
	item?: { placeholder?: string; mono?: boolean };
	/** `subresource` only: the row editor's definition. */
	sub?: SubresourceSpec;
	/** Which capability axis backs this field's options. Declared rather than inferred from the
	 * resolver's identity, and used ONLY to render the per-field provenance footnote ("12 of 340
	 * available to this account" / "showing the full catalog"). Never affects what is selectable. */
	capabilityAxis?: CapabilityAxis;
	/** `connector` only: which pluggable category's connected connectors to offer. */
	category?: PluggableCategory;
	/** `connector` only: knobs this schema owns as their own field, so the connector must not
	 * render a second input for them (dns's `zone_id` is a column with its own field). */
	hiddenKnobs?: (field: ConnectorField) => boolean;
}

/**
 * A section's tier. Every column the database can store is definable, but TIERED, so the
 * cloud-indifferent design story survives contact with the long tail of per-cloud knobs:
 *
 *   essentials — the portable fields. What you'd set on any cloud.
 *   sizing     — capacity and scale.
 *   security   — access, encryption, admins.
 *   advanced   — PROVIDER-SPECIFIC knobs. Collapsed, and badged with the cloud it belongs to, so
 *                it's obvious you're leaving portable ground.
 */
export type SectionTier = "essentials" | "sizing" | "security" | "advanced";

export interface SectionDef<C = AnyConfig> {
	id: string;
	title: string;
	defaultOpen?: boolean;
	fields: FieldDef<C>[];
	/** Defaults to `essentials`. `advanced` collapses by default and shows a provider badge. */
	tier?: SectionTier;
	/** Only render for these clouds. A section for knobs that simply don't exist elsewhere. */
	providerScope?: CloudProviderSlug[];
}

export interface KindConfig<C = AnyConfig> {
	sections: SectionDef<C>[];
	/** One-line live summary for the sheet header (e.g. "PostgreSQL · 0.5–4 ACU"). */
	summary: (config: C, provider: CloudProviderSlug | null) => string;
}

/** Per-kind schema map: each entry typed to its NodeConfigMap fragment. */
type ConfigSchemaMap = { [K in NodeKind]?: KindConfig<NodeConfigMap[K]> };

// ── shared field helpers ────────────────────────────────────────────────────

/** A lowercase, monospace resource-name field. Generic so it slots into any kind's
 * typed field list (the config type is inferred from the surrounding schema entry). */
const nameField = <C = AnyConfig>(
	transform?: (v: string) => string,
): FieldDef<C> => ({
	key: "name",
	type: "text",
	label: "Name",
	mono: true,
	transform: transform ?? ((v) => v.toLowerCase()),
});

const CAPACITY_MODE_DESC: Record<string, string> = {
	on_demand: "Pay per request; scales automatically to traffic.",
	provisioned: "Fixed throughput; cheaper at steady, predictable load.",
};

/** Human label for the current DB engine family. Normalization (including the legacy concrete
 * `engine` column and the implicit postgres default) lives in `dbEngineFamily` — one place, since
 * the keyless gate and the store normalizer key on the same answer. */
function engineLabel(config: {
	engine_family?: string | null;
	engine?: string | null;
}): string {
	return dbEngineFamily(config) === "mysql" ? "MySQL" : "PostgreSQL";
}

// ── per-kind config ─────────────────────────────────────────────────────────

export const CONFIG_SCHEMA: ConfigSchemaMap = {
	project: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					{
						key: "project_name",
						type: "text",
						label: "Project name",
						placeholder: "My Project",
					},
					{
						key: "environment_stage",
						type: "radio-card",
						label: "Environment",
						options: [
							{
								value: "development",
								label: "Development",
								description: "Ephemeral, low-cost defaults.",
							},
							{
								value: "staging",
								label: "Staging",
								description: "A pre-production mirror.",
							},
							{
								value: "production",
								label: "Production",
								description: "Live traffic; durable sizing.",
							},
						],
					},
				],
			},
			{
				id: "placement",
				title: "Placement",
				defaultOpen: true,
				fields: [
					{
						key: "region",
						type: "region",
						label: "Region",
						requiresProvider: true,
					},
				],
			},
		],
		summary: (c) => c.project_name || "Project",
	},

	// A first-class application workload (W1). Unlike the infra kinds it is cloud-indifferent — it
	// runs on the cluster, not a cloud account — so no field here is provider-gated. The `source`
	// discriminated union drives the repo-vs-image split: the Build section is repo-only and simply
	// renders nothing when the source is a prebuilt image (a section whose every field is hidden is
	// dropped). Backing-infra Bindings (W3) land in a follow-up — the flat row editor can't yet edit
	// their nested `inject[]`.
	service: {
		sections: [
			{
				id: "identity",
				title: "Identity",
				defaultOpen: true,
				fields: [
					nameField(),
					{
						key: "type",
						type: "radio-card",
						label: "Type",
						options: [
							{
								value: "deployment",
								label: "Deployment",
								description: "Long-running, load-balanced.",
							},
							{ value: "job", label: "Job", description: "Runs once to completion." },
							{ value: "cronjob", label: "CronJob", description: "Runs on a schedule." },
							{
								value: "statefulset",
								label: "StatefulSet",
								description: "Stable identity and storage.",
							},
						],
					},
				],
			},
			{
				id: "source",
				title: "Source",
				defaultOpen: true,
				fields: [
					{
						key: "source_kind",
						type: "radio-card",
						label: "Source",
						get: (c) => c.source.kind,
						// Switching branch resets to that branch's shape — the union carries only the
						// active branch's fields, so there is nothing of the other branch to preserve.
						set: (v) =>
							v === "image"
								? { source: { kind: "image", image: "" } }
								: { source: { kind: "repo", repo_url: "", path: "" } },
						options: [
							{
								value: "repo",
								label: "Repository",
								description: "Build from a Git repo. Keyless build & push.",
							},
							{
								value: "image",
								label: "Prebuilt image",
								description: "Deploy an existing image as-is.",
							},
						],
					},
					{
						key: "repo_url",
						type: "text",
						label: "Repository URL",
						mono: true,
						full: true,
						placeholder: "https://github.com/org/repo",
						visibleWhen: (c) => c.source.kind === "repo",
						get: (c) => (c.source.kind === "repo" ? c.source.repo_url : ""),
						set: (v, c) => ({
							source: {
								kind: "repo",
								repo_url: String(v),
								path: c.source.kind === "repo" ? c.source.path : "",
							},
						}),
					},
					{
						key: "source_path",
						type: "text",
						label: "Path",
						mono: true,
						placeholder: ".",
						description: "Subdirectory to build from.",
						visibleWhen: (c) => c.source.kind === "repo",
						get: (c) => (c.source.kind === "repo" ? c.source.path : ""),
						set: (v, c) => ({
							source: {
								kind: "repo",
								repo_url: c.source.kind === "repo" ? c.source.repo_url : "",
								path: String(v),
							},
						}),
					},
					{
						key: "image",
						type: "text",
						label: "Image",
						mono: true,
						full: true,
						placeholder: "ghcr.io/org/api:1.4.0",
						description: "A pushed image reference to deploy as-is.",
						visibleWhen: (c) => c.source.kind === "image",
						get: (c) => (c.source.kind === "image" ? c.source.image : ""),
						set: (v) => ({ source: { kind: "image", image: String(v) } }),
					},
				],
			},
			{
				id: "build",
				title: "Build",
				// Every field is repo-only, so the whole section drops away for a prebuilt image.
				fields: [
					{
						key: "build_dockerfile",
						type: "text",
						label: "Dockerfile",
						mono: true,
						placeholder: "Dockerfile",
						visibleWhen: (c) => c.source.kind === "repo",
						get: (c) => c.build?.dockerfile ?? "",
						set: (v, c) => ({
							build: { dockerfile: String(v) || undefined, context: c.build?.context },
						}),
					},
					{
						key: "build_context",
						type: "text",
						label: "Context",
						mono: true,
						placeholder: ".",
						visibleWhen: (c) => c.source.kind === "repo",
						get: (c) => c.build?.context ?? "",
						set: (v, c) => ({
							build: { dockerfile: c.build?.dockerfile, context: String(v) || undefined },
						}),
					},
				],
			},
			{
				id: "networking",
				title: "Networking",
				defaultOpen: true,
				fields: [
					{
						key: "ports",
						type: "subresource",
						label: "Ports",
						description: "Container ports this workload exposes.",
						sub: {
							singular: "port",
							create: () => ({ container_port: null, protocol: "TCP", name: "" }),
							title: (item) =>
								typeof item.name === "string" && item.name
									? item.name
									: item.container_port != null
										? String(item.container_port)
										: "",
							fields: [
								{
									key: "container_port",
									type: "number",
									label: "Container port",
									min: 1,
									max: 65535,
								},
								{
									key: "protocol",
									type: "select",
									label: "Protocol",
									options: [
										{ value: "TCP", label: "TCP" },
										{ value: "UDP", label: "UDP" },
									],
								},
								{
									key: "name",
									type: "text",
									label: "Name",
									mono: true,
									placeholder: "optional",
									full: true,
								},
							],
						},
					},
				],
			},
			{
				id: "environment",
				title: "Environment",
				defaultOpen: true,
				fields: [
					{
						key: "env",
						type: "subresource",
						label: "Variables",
						description: "Plain environment variables. Vault-backed secrets come in a later release.",
						sub: {
							singular: "variable",
							create: () => ({ name: "", value: "" }),
							title: (item) =>
								typeof item.name === "string" && item.name ? item.name : "",
							fields: [
								{ key: "name", type: "text", label: "Name", mono: true, full: true },
								{ key: "value", type: "text", label: "Value", full: true },
							],
						},
					},
				],
			},
			{
				id: "bindings",
				title: "Bindings",
				defaultOpen: true,
				fields: [
					{
						key: "bindings",
						type: "bindings",
						label: "Backing infrastructure",
						description:
							"Connect this service to a resource on the canvas. Alethia injects its endpoint and credentials at deploy — keyless.",
						get: (c) => c.bindings,
						set: (v) => ({ bindings: z.array(serviceBindingSchema).catch([]).parse(v) }),
					},
				],
			},
			{
				id: "runtime",
				title: "Runtime",
				defaultOpen: true,
				fields: [
					{ key: "replicas", type: "number", label: "Replicas", min: 1, max: 5, full: true },
					{
						key: "requests_cpu",
						type: "text",
						label: "CPU request",
						mono: true,
						placeholder: "100m",
						get: (c) => c.resources?.requests?.cpu ?? "",
						set: (v, c) => ({
							resources: {
								requests: {
									cpu: String(v),
									memory: c.resources?.requests?.memory ?? "",
								},
								limits: c.resources?.limits ?? { cpu: "", memory: "" },
							},
						}),
					},
					{
						key: "requests_memory",
						type: "text",
						label: "Memory request",
						mono: true,
						placeholder: "128Mi",
						get: (c) => c.resources?.requests?.memory ?? "",
						set: (v, c) => ({
							resources: {
								requests: {
									cpu: c.resources?.requests?.cpu ?? "",
									memory: String(v),
								},
								limits: c.resources?.limits ?? { cpu: "", memory: "" },
							},
						}),
					},
					{
						key: "limits_cpu",
						type: "text",
						label: "CPU limit",
						mono: true,
						placeholder: "500m",
						get: (c) => c.resources?.limits?.cpu ?? "",
						set: (v, c) => ({
							resources: {
								requests: c.resources?.requests ?? { cpu: "", memory: "" },
								limits: {
									cpu: String(v),
									memory: c.resources?.limits?.memory ?? "",
								},
							},
						}),
					},
					{
						key: "limits_memory",
						type: "text",
						label: "Memory limit",
						mono: true,
						placeholder: "512Mi",
						get: (c) => c.resources?.limits?.memory ?? "",
						set: (v, c) => ({
							resources: {
								requests: c.resources?.requests ?? { cpu: "", memory: "" },
								limits: {
									cpu: c.resources?.limits?.cpu ?? "",
									memory: String(v),
								},
							},
						}),
					},
				],
			},
			{
				id: "health",
				title: "Health",
				fields: [
					{
						key: "probe_enabled",
						type: "switch",
						label: "Health check",
						description: "Gate rollout on a readiness probe.",
						get: (c) => c.probe != null,
						set: (v, c) => ({
							probe: v ? (c.probe ?? { type: "http", port: 8080 }) : null,
						}),
					},
					{
						key: "probe_type",
						type: "radio-card",
						label: "Probe type",
						visibleWhen: (c) => c.probe != null,
						get: (c) => c.probe?.type ?? "http",
						set: (v, c) => ({
							probe: {
								type: coerceEnum(String(v), ["http", "tcp"] as const, "http"),
								path: c.probe?.path,
								port: c.probe?.port ?? 8080,
							},
						}),
						options: [
							{ value: "http", label: "HTTP", description: "Check an HTTP endpoint." },
							{ value: "tcp", label: "TCP", description: "Open a TCP connection." },
						],
					},
					{
						key: "probe_path",
						type: "text",
						label: "Path",
						mono: true,
						full: true,
						placeholder: "/healthz",
						visibleWhen: (c) => c.probe?.type === "http",
						get: (c) => c.probe?.path ?? "",
						set: (v, c) => ({
							probe: {
								type: c.probe?.type ?? "http",
								path: String(v),
								port: c.probe?.port ?? 8080,
							},
						}),
					},
					{
						key: "probe_port",
						type: "number",
						label: "Port",
						min: 1,
						max: 65535,
						placeholder: "8080",
						visibleWhen: (c) => c.probe != null,
						get: (c) => c.probe?.port ?? null,
						set: (v, c) => ({
							probe: {
								type: c.probe?.type ?? "http",
								path: c.probe?.path,
								port: v == null ? 8080 : Number(v),
							},
						}),
					},
				],
			},
		],
		summary: (c) => {
			const src = c.source.kind === "image" ? c.source.image : c.source.repo_url;
			const base = src ? src.replace(/\.git$/, "").split("/").filter(Boolean).pop() : "";
			return `${c.type} · ${c.replicas} replica${c.replicas === 1 ? "" : "s"}${
				base ? ` · ${base}` : ""
			}`;
		},
	},

	network: {
		sections: [
			{
				id: "provisioning",
				title: "Provisioning",
				defaultOpen: true,
				fields: [
					{
						key: "provision_network",
						type: "switch",
						label: "Provision a new network",
						description: "Create a fresh VPC/VNet, or attach to an existing one.",
					},
					{
						key: "cidr_block",
						type: "text",
						label: "CIDR block",
						mono: true,
						placeholder: "10.0.0.0/16",
						visibleWhen: (c) => c.provision_network !== false,
					},
					{
						key: "network_id",
						type: "select",
						label: "Existing network",
						mono: true,
						placeholder: "Select a network",
						// The already-synced inventory, not a free-text box. `networkSchema`'s refine has
						// said "Select a VPC when using an existing network" since before a picker existed.
						// The option VALUE is the provider-native id (`vpc-…`) because that is what this
						// column stores and what the tofu templates read — never the cloud_networks row
						// uuid. `withSelected` keeps an id typed before this change from vanishing.
						capabilityAxis: "placement",
						options: existingNetworkOptions,
						visibleWhen: (c) => c.provision_network === false,
					},
					{
						key: "single_nat_gateway",
						type: "switch",
						label: "Single NAT gateway",
						description: "One shared NAT (cheaper) vs one per availability zone.",
						visibleWhen: (c) => c.provision_network !== false,
					},
					{
						key: "allowed_cidr_blocks",
						type: "list",
						label: "Allowed CIDR blocks",
						description: "Extra networks permitted to reach resources in this VPC.",
						item: { mono: true, placeholder: "10.1.0.0/16" },
					},
				],
			},
		],
		summary: (c) =>
			c.provision_network === false
				? c.network_id || "existing network"
				: c.cidr_block || "new network",
	},

	cluster: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					{
						key: "cluster_version",
						type: "select",
						label: "Kubernetes version",
						requiresProvider: true,
						capabilityAxis: "k8s_version",
						options: k8sVersionOptions,
					},
					{
						key: "instance_types",
						type: "select",
						label: "Instance type",
						requiresProvider: true,
						capabilityAxis: "instance_type",
						get: (c) => c.instance_types?.[0] ?? "",
						set: (v) => ({ instance_types: [String(v)] }),
						options: instanceTypeOptions,
					},
				],
			},
			{
				id: "sizing",
				title: "Node sizing",
				tier: "sizing",
				defaultOpen: true,
				fields: [
					// The cloud-INDIFFERENT way to size: the Go resolver maps a capability to the nearest
					// per-cloud instance type at provision time. The panel has never exposed it, so the
					// only way to size a cluster was to pick a concrete SKU and lose portability.
					{
						key: "node_size_vcpu",
						type: "number",
						label: "vCPU per node",
						min: 1,
						max: 96,
						optional: true,
						placeholder: "2",
						description: "Portable sizing — mapped to the nearest instance type on any cloud.",
						get: (c) => c.node_size?.vcpu ?? null,
						set: (v, c) => ({
							node_size:
								v == null
									? undefined
									: { vcpu: Number(v), memory_gb: c.node_size?.memory_gb ?? 8 },
						}),
					},
					{
						key: "node_size_memory",
						type: "number",
						label: "Memory per node",
						unit: "GB",
						min: 1,
						max: 768,
						optional: true,
						placeholder: "8",
						get: (c) => c.node_size?.memory_gb ?? null,
						set: (v, c) => ({
							node_size:
								v == null
									? undefined
									: { vcpu: c.node_size?.vcpu ?? 2, memory_gb: Number(v) },
						}),
					},
					{ key: "node_min_size", type: "number", label: "Min nodes", min: 1, max: 100 },
					{
						key: "node_desired_size",
						type: "number",
						label: "Desired nodes",
						min: 1,
						max: 100,
					},
					{ key: "node_max_size", type: "number", label: "Max nodes", min: 1, max: 100 },
					{
						key: "node_disk_size_gb",
						type: "number",
						label: "Node disk",
						unit: "GB",
						// Per-cloud floor from the generated NODE_DISK mirror (#1972): a single
						// cross-cloud `min: 20` undershot Azure's 30 GB OS-disk minimum, so 24 GB
						// saved cleanly there and failed at plan. The numbers are scraped from the
						// templates' own `>= N` validations — the same literals the Go floors are
						// pinned to — never hand-copied here (#1967's failure mode).
						min: ({ provider }) =>
							(provider && NODE_DISK[provider]?.floorGb) || 20,
						max: 2000,
						optional: true,
						placeholder: ({ provider }) => {
							const spec = provider ? NODE_DISK[provider] : null;
							return spec
								? `default ${spec.templateDefaultGb} · min ${spec.floorGb}`
								: "per-cloud default";
						},
						description: "Worker root volume. Empty uses the cloud's own default.",
						// Hetzner has no node-disk knob AT ALL — a server's disk comes with its
						// server type, `cluster.node_disk_size_gb / hetzner` is a documented
						// exclusion on the carriage board, and TestNodeDiskFloorsMatchTemplates
						// pins the template's deliberate lack of a disk variable. The field is not
						// part of the shape there, so `visibleWhen`, not `unavailableWhen` — and
						// unlike num_cache_nodes (#1993) no offer-board entry keys this cell, so
						// hiding it makes no recorded ceiling dangle.
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
					},
				],
			},
			{
				id: "security",
				title: "Security",
				tier: "security",
				fields: [
					{
						key: "cluster_admins",
						type: "list",
						label: "Cluster admins",
						description:
							"Principals granted cluster-admin RBAC at create time — the mechanism the runner uses to authorize itself against the cluster it just built.",
						item: { mono: true, placeholder: "arn:aws:iam::…:role/platform-oncall" },
						// The column is `ClusterAdmin[]` ({ username, groups }). The list edits the
						// usernames; the group binding stays cluster-admin, which is the only thing this
						// mechanism grants. Existing groups on a row are preserved on edit.
						get: (c) => (c.cluster_admins ?? []).map((a) => a.username),
						set: (v, c) => {
							const existing = c.cluster_admins ?? [];
							return {
								cluster_admins: toStrArray(v).map((username) => ({
									username,
									groups:
										existing.find((a) => a.username === username)?.groups ?? [
											"system:masters",
										],
								})),
							};
						},
					},
				],
			},
		],
		summary: (c) =>
			`k8s ${c.cluster_version ?? "—"} · ${c.node_min_size ?? 1}–${
				c.node_max_size ?? 1
			} nodes`,
	},

	database: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					nameField(),
					{
						key: "engine_family",
						type: "radio-card",
						label: "Engine",
						// Provider-filtered via the registry's shared variant gate (Hetzner runs
						// databases in-cluster via CloudNativePG → postgres only), then narrowed to what
						// this account reports. The gate stays the FLOOR: it encodes what the chart
						// mapper can actually deploy, which account capability must not override.
						capabilityAxis: "database",
						options: dbEngineOptions,
					},
					{
						key: "port",
						type: "number",
						label: "Port",
						min: 1,
						max: 65535,
					},
				],
			},
			{
				id: "capacity",
				title: "Capacity",
				defaultOpen: true,
				fields: [
					{
						key: "min_capacity",
						type: "number",
						label: "Min capacity",
						float: true,
						requiresProvider: true,
						// Serverless capacity units (ACU/vCPU) are meaningless for the in-cluster
						// CloudNativePG path — Hetzner sizes via the In-cluster sizing section.
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
						unit: ({ provider }) => (provider ? DB_CAPACITY[provider].unit : ""),
						min: ({ provider }) => (provider ? DB_CAPACITY[provider].min : 0),
						max: ({ provider }) => (provider ? DB_CAPACITY[provider].max : 0),
						step: ({ provider }) => (provider ? DB_CAPACITY[provider].step : 1),
					},
					{
						key: "max_capacity",
						type: "number",
						label: "Max capacity",
						float: true,
						requiresProvider: true,
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
						unit: ({ provider }) => (provider ? DB_CAPACITY[provider].unit : ""),
						min: ({ provider }) => (provider ? DB_CAPACITY[provider].min : 0),
						max: ({ provider }) => (provider ? DB_CAPACITY[provider].max : 0),
						step: ({ provider }) => (provider ? DB_CAPACITY[provider].step : 1),
					},
				],
			},
			{
				id: "in-cluster-sizing",
				title: "In-cluster sizing",
				defaultOpen: true,
				fields: [
					{
						key: "storage_gb",
						type: "number",
						label: "Storage",
						unit: "GiB",
						min: 1,
						max: 1024,
						optional: true,
						placeholder: "10",
						description: "Persistent volume per Postgres instance (CloudNativePG).",
						visibleWhen: (_c, { provider }) => provider === "hetzner",
					},
					{
						key: "replicas",
						type: "number",
						label: "Instances",
						min: 1,
						max: 5,
						optional: true,
						placeholder: "1",
						description: "Postgres instances in the cluster (1 primary + replicas).",
						visibleWhen: (_c, { provider }) => provider === "hetzner",
					},
				],
			},
			{
				id: "security",
				title: "Security",
				tier: "security",
				fields: [
					{
						key: "iam_auth",
						type: "switch",
						label: "IAM authentication",
						description: "Authenticate with short-lived cloud IAM tokens instead of a password.",
						// A cloud must be chosen before this question has an answer — and picking it
						// up front is also what stops "toggle it on first, land on Hetzner second".
						requiresProvider: true,
						// Gated to the cells the RENDERER can actually build, read from the generated
						// mirror of packages/core/manifests/keyless.go. Disabled-with-a-reason rather
						// than hidden: keyless is a thing people come looking for, and on Hetzner the
						// Security section would otherwise simply be missing it, with nothing to say
						// why. The reason string IS the Go table's, so this copy cannot fork from the
						// deploy-time refusal or the offer-parity matrix (#1510).
						unavailableWhen: (config, { provider }) =>
							keylessUnavailableReason(provider, dbEngineFamily(config)),
					},
					{
						key: "backup_retention_days",
						type: "number",
						label: "Backup retention",
						unit: "days",
						min: 0,
						max: 35,
						optional: true,
						placeholder: "7",
						description:
							"0 disables automated backups. Point-in-time restore covers this window.",
					},
				],
			},
			{
				id: "db-advanced",
				title: "Advanced",
				tier: "advanced",
				fields: [
					{
						key: "engine_version",
						type: "select",
						label: "Engine version",
						mono: true,
						// Capability-backed since #1351: the lanes enumerate every version the account
						// can launch this engine at, instead of the user having to know them. Still
						// fail-open — with nothing synced the catalog's default is the only option, and
						// `withSelected` keeps a previously pinned free-text version representable.
						requiresProvider: true,
						capabilityAxis: "database",
						options: dbVersionOptions,
						description: "Pin an exact engine version. Empty tracks the template's default.",
					},
					{
						key: "instance_class",
						type: "combobox",
						label: "Instance class",
						mono: true,
						placeholder: "resolver default",
						// Capability-backed: the lanes enumerate the SKUs this account can actually order
						// for the selected engine, which is knowledge no user reliably has — and a typo
						// here is not a validation error, it is a failed apply.
						//
						// A combobox rather than a select, for two reasons that both point the same way:
						// there is NO static catalog to fall open to (the catalog models capacity
						// portably; a SKU is precisely the non-portable escape hatch), and the lanes
						// cannot enumerate exhaustively — GCP custom machine types are constructible,
						// and the Alibaba anchor asks about one version in one zone. An unlisted SKU
						// must stay pinnable.
						requiresProvider: true,
						capabilityAxis: "db_instance_class",
						options: dbInstanceClassOptions,
						description:
							"A concrete provider SKU (db.r6g.large · db-custom-2-7680 · GP_Gen5_2). Overrides the portable capacity above — and gives up portability.",
						// Serverless capacity is the portable path; this is the escape hatch. Meaningless
						// for the in-cluster CloudNativePG path.
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
					},
				],
			},
		],
		summary: (c, provider) =>
			provider === "hetzner"
				? `${engineLabel(c)} · ${c.storage_gb ?? 10} GiB × ${c.replicas ?? 1}`
				: `${engineLabel(c)} · ${c.min_capacity ?? "?"}–${
						c.max_capacity ?? "?"
					}`,
	},

	cache: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					nameField(),
					{
						key: "engine",
						type: "radio-card",
						label: "Engine",
						// Provider-filtered via the registry's shared variant gate (Hetzner's
						// in-cluster cache chart is Valkey — offering Redis would deploy Valkey).
						options: ({ provider }) => variantOptionsFor("cache", provider),
					},
					{
						key: "node_type",
						type: "select",
						label: "Node type",
						requiresProvider: true,
						// No managed cache SKUs on Hetzner — the in-cluster Valkey chart sizes
						// via storage_gb below.
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
						capabilityAxis: "cache_tier",
						options: cacheTierOptions,
					},
				],
			},
			{
				id: "sizing",
				title: "Sizing",
				defaultOpen: true,
				fields: [
						// The cloud-INDIFFERENT size. The Go resolver maps it to the nearest cache SKU on any
					// cloud; `node_type` is the concrete override that gives up portability.
					{
						key: "memory_gb",
						type: "number",
						label: "Memory",
						unit: "GB",
						min: 0.5,
						max: 512,
						float: true,
						optional: true,
						placeholder: "resolver default",
						description: "Portable sizing — mapped to the nearest cache tier on any cloud.",
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
					},
				{
					key: "num_cache_nodes",
					type: "number",
					label: "Nodes",
					min: 1,
					max: 6,
					// Withdrawn (not hidden) on Azure: Managed Redis is sized by its SKU and
					// the service manages clustering itself, so there is no node, replica or
					// shard count for the number to become — the old wiring only flipped the
					// legacy tier and discarded the number (#1993). `unavailableWhen`, never
					// `visibleWhen`: hiding would drop azure from `offeredOn` and make the
					// recorded ceiling in infra/config-carriage-exclusions.yaml match nothing.
					unavailableWhen: (_c, { provider }) =>
						provider === "azure"
							? "Azure Managed Redis is sized by its SKU and manages clustering itself — a node count has nothing to apply to. Size the cache with Memory instead."
							: null,
				},
					{
						key: "storage_gb",
						type: "number",
						label: "Storage",
						unit: "GiB",
						min: 1,
						max: 512,
						optional: true,
						placeholder: ({ config }) => String(config.memory_gb ?? 8),
						description: "Persistent volume per Valkey node; defaults to the memory size.",
						visibleWhen: (_c, { provider }) => provider === "hetzner",
					},
					{
						key: "multi_az",
						type: "switch",
						label: "Multi-AZ",
						description: "Replicate across availability zones for failover.",
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
					},
				],
			},
			{
				id: "cache-network",
				title: "Network",
				tier: "security",
				fields: [
					{
						key: "allowed_cidr_blocks",
						type: "list",
						label: "Allowed CIDR blocks",
						description: "Extra networks permitted to reach the cache. The cluster always can.",
						item: { mono: true, placeholder: "10.1.0.0/16" },
						// Withdrawn (not hidden) on Azure, same shape and same reason as
						// `num_cache_nodes` above (#2148). The module moved to
						// `azurerm_managed_redis` because Azure now returns
						// `400 … Azure Cache for Redis is retiring` for the classic type — and
						// Managed Redis has NO firewall sub-resource: not in the pinned azurerm
						// 4.81.0, not in 5.0.1. `azurerm_redis_firewall_rule` binds by
						// `redis_cache_name` to the RETIRED `azurerm_redis_cache`, so aiming it at
						// a Managed Redis name targets a different ARM type and fails at apply.
						// The only network knob the resource exposes is `public_network_access`
						// (Enabled/Disabled), which is not CIDR filtering — wiring the control to
						// it would satisfy the parity probe while delivering none of the
						// behaviour, which is exactly what the carriage guard exists to catch.
						// `unavailableWhen`, never `visibleWhen`: hiding would drop azure from
						// `offeredOn` and make the recorded exclusion match nothing.
						unavailableWhen: (_c, { provider }) =>
							provider === "azure"
								? "Azure Managed Redis has no CIDR firewall — the service exposes only a public-access on/off switch. Reach it from inside the cluster's network, which is always permitted."
								: null,
					},
				],
			},
			{
				id: "cache-advanced",
				title: "Advanced",
				tier: "advanced",
				fields: [
					{
						key: "engine_version",
						type: "combobox",
						label: "Engine version",
						mono: true,
						placeholder: "cloud default",
						// Capability-backed where the cloud will say: AWS and Alibaba report the offered
						// cache engine versions; GCP/Azure/Hetzner document an exclusion (no account-scoped
						// API states which versions a subscription may launch, and on Hetzner the value is
						// a container image tag). A combobox, not a select, so the three excluded clouds —
						// and any unsynced account — keep a field that still works.
						requiresProvider: true,
						capabilityAxis: "cache_version",
						options: cacheVersionOptions,
						description: "Pin an exact engine version. Empty tracks the template's default.",
					},
				],
			},
		],
		summary: (c, provider) =>
			provider === "hetzner"
				? // The in-cluster chart is always Valkey, whatever engine the config carries.
					`Valkey · ${c.storage_gb ?? c.memory_gb ?? 8} GiB × ${c.num_cache_nodes ?? 1}`
				: `${c.engine === "valkey" ? "Valkey" : "Redis"} · ${
						c.node_type ?? "—"
					}`,
	},

	queue: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					nameField(),
					{
						key: "visibility_timeout",
						type: "number",
						label: "Visibility timeout (s)",
						min: 0,
						max: 43200,
						// SQS-ism — the in-cluster RabbitMQ path has no visibility timeout.
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
					},
					{
						key: "ordered",
						type: "switch",
						label: "Ordered (FIFO) delivery",
						// The pinned cross-cloud meaning (#1812). No cloud gives a TOTAL order over a
						// queue — AWS orders within a MessageGroupId, Azure within a SessionId, GCP
						// within an orderingKey — so the promise is per-key, and it costs an
						// application change on every one of them. Saying only "guarantee message
						// order" over-promised on all four, and the caveats are the whole difference
						// between a working queue and a broken one.
						//
						// `key`, `type`, `label` and `visibleWhen` are the generated offer surface
						// (scripts/gen-offer-surface.ts reads exactly those four); `description` is
						// not, so this text cannot move offer-surface.json.
						description:
							"Messages tagged with the same ordering key are delivered in the order the service received them. Messages with different keys stay concurrent — this is not a total order over the queue. Your publisher must set a key on every message, and on Azure your consumer must use a session receiver. Throughput drops, and on AWS each request costs more. On Alibaba Cloud the switch is not applied: its queue service publishes no ordering guarantee.",
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
					},
					{
						key: "message_retention",
						type: "number",
						label: "Message retention",
						unit: "days",
						min: 1,
						max: 14,
						optional: true,
						placeholder: "4",
						description: "How long an unconsumed message is kept before it's dropped.",
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
						// Stored in SECONDS (SQS's unit); the field speaks days.
						get: (c) =>
							c.message_retention != null
								? Math.round(c.message_retention / 86400)
								: null,
						set: (v) => ({
							message_retention: v == null ? null : Number(v) * 86400,
						}),
					},
					{
						key: "storage_gb",
						type: "number",
						label: "Storage",
						unit: "GiB",
						min: 1,
						max: 256,
						optional: true,
						placeholder: "8",
						description: "Persistent volume for the RabbitMQ node.",
						visibleWhen: (_c, { provider }) => provider === "hetzner",
					},
				],
			},
		],
		summary: (c, provider) =>
			provider === "hetzner"
				? `RabbitMQ · ${c.storage_gb ?? 8} GiB`
				: // `carriesOrderedDelivery` is shared with the canvas card's `Delivery` fact — the two
					// used to decide this separately, and the card was the one that printed "FIFO" over
					// a queue Alibaba builds standard.
					`${c.ordered && carriesOrderedDelivery(provider) ? "Ordered" : "Standard"} · ${c.visibility_timeout ?? 30}s`,
	},

	topic: {
		sections: [
			{
				id: "general",
				title: "General",
				tier: "essentials",
				defaultOpen: true,
				fields: [nameField()],
			},
			{
				id: "subscriptions",
				title: "Subscriptions",
				tier: "essentials",
				defaultOpen: true,
				fields: [
					{
						key: "subscriptions",
						type: "subresource",
						label: "Subscriptions",
						description:
							"Who receives messages published to this topic. Without one, a topic delivers nowhere.",
						sub: {
							singular: "subscription",
							create: () => ({ protocol: "https", endpoint: "" }),
							title: (item) =>
								typeof item.endpoint === "string" && item.endpoint
									? item.endpoint
									: "",
							fields: [
								{
									key: "protocol",
									type: "select",
									label: "Protocol",
									options: [
										{ value: "https", label: "HTTPS" },
										{ value: "sqs", label: "Queue" },
										{ value: "email", label: "Email" },
										{ value: "lambda", label: "Function" },
									],
								},
								{
									key: "endpoint",
									type: "text",
									label: "Endpoint",
									mono: true,
									placeholder: "https://example.com/events",
									full: true,
								},
							],
						},
					},
				],
			},
		],
		summary: (c) => {
			const subs = c.subscriptions?.length ?? 0;
			return subs === 0
				? c.name || "topic"
				: `${subs} subscription${subs > 1 ? "s" : ""}`;
		},
	},

	nosql: {
		sections: [
			{
				id: "schema",
				title: "Schema",
				defaultOpen: true,
				fields: [
					nameField(),
					{
						key: "partition_key",
						type: "text",
						label: "Partition key",
						mono: true,
						placeholder: "id",
					},
					{
						key: "partition_key_type",
						type: "select",
						label: "Key type",
						capabilityAxis: "nosql",
						options: nosqlKeyTypeOptions,
					},
					{
						key: "sort_key",
						type: "text",
						label: "Sort key",
						mono: true,
						placeholder: "optional",
						description: "A range key. Together with the partition key it forms a composite key.",
						// Not every cloud's table model has a range key.
						visibleWhen: (_c, { provider }) =>
							!provider || NOSQL[provider].supportsRangeKey !== false,
					},
					{
						key: "sort_key_type",
						type: "select",
						label: "Sort key type",
						capabilityAxis: "nosql",
						options: nosqlKeyTypeOptions,
						visibleWhen: (c, { provider }) =>
							!!c.sort_key &&
							(!provider || NOSQL[provider].supportsRangeKey !== false),
					},
				],
			},
			{
				id: "capacity",
				title: "Capacity",
				defaultOpen: true,
				fields: [
					{
						key: "capacity_mode",
						type: "radio-card",
						label: "Capacity mode",
						options: ({ provider }) =>
							(provider
								? NOSQL[provider].billingModes
								: [{ value: "on_demand", label: "On-demand" }]
							).map((m) => ({
								value: m.value,
								label: m.label,
								description: CAPACITY_MODE_DESC[m.value],
							})),
					},
					{
						key: "point_in_time_recovery",
						type: "switch",
						label: "Point-in-time recovery",
						description: "Continuous backups for restore to any second in the retention window.",
						// Hetzner's nosql kind is an in-cluster ScyllaDB, and Scylla has no
						// continuous-backup equivalent: Scylla Manager takes SCHEDULED snapshots,
						// which restore to a backup point, not to any second. Offering the switch
						// anyway would be the exact state the cloud-parity rule forbids — offered,
						// unbuildable, and silent — so it is WITHDRAWN here rather than recorded as
						// carried in-cluster, which would claim delivery of something Scylla does
						// not do. `unavailableWhen`, not `visibleWhen`: the field stays visible with
						// its reason, so the exclusion is legible to the user and measurable by the
						// offer-parity guard instead of vanishing from the surface.
						unavailableWhen: (_c, { provider }) =>
							provider === "hetzner"
								? "Hetzner has no managed NoSQL service, so this table runs as an in-cluster ScyllaDB. Scylla backs up on a schedule rather than continuously, so there is no point-in-time restore to offer. Every other cloud here supports it."
								: null,
					},
				],
			},
			{
				id: "nosql-replication",
				title: "Replication",
				tier: "advanced",
				fields: [
					{
						key: "global_replicas",
						type: "list",
						label: "Global replica regions",
						// The Azure sentences are load-bearing product copy (#2158, human decision
						// 2026-08-10): replication is bought per Cosmos ACCOUNT, so the account gets
						// the union of every table's list — and because serverless accounts are
						// single-region-only, the first replica switches the account onto provisioned
						// throughput (a billing change; on an already-deployed project, an account
						// replacement). Say it here, before the save, not in a failed deploy.
						description:
							"Replicate the table to these regions. Only on clouds whose table service supports global tables. On Azure, replicas apply to the whole Cosmos account — the union of every table's list — and the first replica switches the account from serverless to provisioned billing (on an already-deployed project this replaces the account).",
						item: { mono: true, placeholder: "us-east-1" },
					},
				],
			},
		],
		summary: (c) =>
			`${c.partition_key || "id"} · ${
				c.capacity_mode === "provisioned" ? "Provisioned" : "On-demand"
			}`,
	},

	secret: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					nameField((v) => v.toLowerCase().replace(/[^a-z0-9-]/g, "")),
					{
						key: "generate",
						type: "switch",
						label: "Auto-generate value",
						description: "Generate a random secret, or manage the value yourself later.",
					},
					{
						key: "length",
						type: "number",
						label: "Length",
						min: 8,
						max: 128,
						visibleWhen: (c) => c.generate !== false,
					},
					{
						key: "special_chars",
						type: "switch",
						label: "Include special characters",
						visibleWhen: (c) => c.generate !== false,
					},
				],
			},
		],
		summary: (c) =>
			c.generate === false ? "manual value" : `generated · ${c.length ?? 32} chars`,
	},

	bucket: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					// S3-safe: lowercase letters / digits / hyphens only (validated 3–63 on save).
					nameField((v) => v.toLowerCase().replace(/[^a-z0-9-]/g, "")),
					{
						key: "versioning",
						type: "switch",
						label: "Versioning",
						// The Azure clause is a PRODUCT DISCLOSURE, not a footnote. azurerm exposes blob
						// versioning only on the storage account, and an Azure project has exactly one — so
						// this per-bucket switch genuinely has project-wide effect there. A switch whose real
						// scope is wider than its label is the same class of untruth as a switch that does
						// nothing, and saying so is the condition on which the cell counts as honored.
						description:
							"Keep every version of an object; restore or roll back at any time. On Azure this is a storage-account setting, so turning it on for one bucket versions every bucket in the project.",
					},
					{
						key: "encryption_enabled",
						type: "switch",
						label: "Encryption at rest",
						description: "Server-side encryption with the cloud's managed keys.",
						// Hetzner Object Storage encrypts at rest automatically — there is no
						// per-bucket toggle in the minio provider, so hide it (always-on).
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
					},
				],
			},
			{
				id: "access",
				title: "Access",
				defaultOpen: true,
				fields: [
					{
						key: "public_access",
						type: "switch",
						label: "Public access",
						description: "Allow unauthenticated reads (static assets). Off keeps the bucket private.",
					},
					{
						key: "cors_origins",
						type: "text",
						label: "CORS origins",
						mono: true,
						placeholder: "https://app.example.com, https://example.com",
						description: "Comma-separated origins allowed to read from the browser.",
						// The aminueza/minio provider does not apply CORS to Hetzner's S3 backend
						// (s3_compat_mode skips it), so hide the field rather than imply it works.
						visibleWhen: (_c, { provider }) => provider !== "hetzner",
						get: (c) => (c.cors_origins ?? []).join(", "),
						set: (v) => ({
							cors_origins: String(v)
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean),
						}),
					},
				],
			},
		],
		summary: (c) =>
			[
				c.versioning ? "versioned" : null,
				c.encryption_enabled !== false ? "encrypted" : null,
				c.public_access ? "public" : "private",
			]
				.filter(Boolean)
				.join(" · "),
	},

	registry: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					nameField((v) => v.toLowerCase().replace(/[^a-z0-9-]/g, "")),
					{
						key: "immutable_tags",
						type: "switch",
						label: "Immutable tags",
						// ECR / Artifact Registry / ACR features. A pluggable connector REPLACES the
						// cloud's registry, so these describe a registry this project no longer uses —
						// hide them rather than imply we can set them on someone else's.
						visibleWhen: (c) => !isPluggable(c.provider),
						description: "Prevent pushed image tags from being overwritten.",
						// Typed columns since #1811, not provider_config keys — and DEFAULT TRUE, which
						// matches what the templates already build. `?? false` here would show every
						// existing registry as "off" and, once carried, downgrade live repositories.
						get: (c) => c.immutable_tags ?? true,
						set: (v) => ({ immutable_tags: Boolean(v) }),
					},
					{
						key: "vulnerability_scanning",
						type: "switch",
						label: "Vulnerability scanning",
						// ECR / Artifact Registry / ACR features. A pluggable connector REPLACES the
						// cloud's registry, so these describe a registry this project no longer uses —
						// hide them rather than imply we can set them on someone else's.
						visibleWhen: (c) => !isPluggable(c.provider),
						description: "Scan pushed images for known CVEs.",
						// Typed column since #1811. Default true — see immutable_tags above.
						get: (c) => c.vulnerability_scanning ?? true,
						set: (v) => ({ vulnerability_scanning: Boolean(v) }),
					},
				],
			},
		],
		// The provider's registry service name (ECR / Artifact Registry / ACR / …).
		summary: (c, provider) =>
			provider ? getProvider(provider).registryService : c.name || "registry",
	},

	// A private Helm chart repository. Only two things are per-project — WHICH connector authenticates
	// the pull, and (for the providers that serve any host) WHERE. Everything else about the repo is
	// the org-level credential, so this schema is deliberately one field plus a name.
	helm_registry: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					nameField((v) => v.toLowerCase().replace(/[^a-z0-9-]/g, "")),
					{
						key: "provider",
						type: "connector",
						category: "helm_registry",
						label: "Chart repository",
						description:
							"The connected chart-repo connector ArgoCD authenticates with. Its credential is seeded as a repository credential at deploy — it never enters the project's config snapshot.",
						full: true,
					},
				],
			},
		],
		// The URL the runner will actually seed, so the header answers "which repo is this?" rather
		// than restating the row's name.
		summary: (c) => helmRegistryUrl(c) || c.name || "chart repo",
	},

	dns: {
		sections: [
			{
				id: "general",
				title: "General",
				defaultOpen: true,
				fields: [
					{ key: "enabled", type: "switch", label: "Enabled" },
					{
						key: "provider",
						type: "connector",
						category: "dns",
						label: "DNS provider",
						description:
							"Which DNS backend external-dns manages records through. The cluster cloud's own (Route 53 / Cloud DNS / Azure DNS) unless you connect one.",
						full: true,
						// The zone lives on `project_dns.zone_id` — its own field below — and Cloudflare's
						// connector declares a `zone_id` knob too. Two inputs for one concept, writing to
						// two places, is worse than either; the column wins. Safe because
						// categories/dns_cloudflare.go prefers provider_config.zone_id but FALLS BACK to
						// the column, and the dns schema guard accepts either.
						hiddenKnobs: (f) => f.key === "zone_id",
					},
					{
						key: "domain_name",
						type: "text",
						label: "Domain name",
						mono: true,
						placeholder: "example.com",
					},
					{
						key: "managed_certificate",
						type: "switch",
						label: "Managed TLS certificate",
					},
						{
						key: "waf_enabled",
						type: "switch",
						label: "Web application firewall (WAF)",
						// Gated rather than hidden, the same call as `iam_auth`: a switch that
						// silently is not there reads as a bug, while one that says why is an
						// answer. Withheld only on Alibaba (#1841) — see lib/cloud-providers/waf.ts
						// for why, and for why the store normalizer and the deploy gate exist too.
						requiresProvider: true,
						unavailableWhen: (_config, { provider }) =>
							wafUnavailableReason(provider),
					},
					{
						key: "zone_id",
						type: "text",
						label: "Existing zone ID",
						mono: true,
						placeholder: "create a new zone",
						description:
							"Attach to a hosted zone you already own instead of creating one (Z0123… · projects/…/managedZones/… ).",
					},
				],
			},
		],
		summary: (c) =>
			c.domain_name || (c.enabled === false ? "disabled" : "enabled"),
	},

	repositories: {
		sections: [
			{
				id: "general",
				title: "GitOps",
				defaultOpen: true,
				fields: [
					{
						key: "apps_destination_repo",
						type: "repository",
						label: "ArgoCD apps repository",
						description: "The Git repo ArgoCD syncs application manifests from.",
					},
					{
						key: "apps_path",
						type: "text",
						label: "Overlay path",
						mono: true,
						placeholder: "repository root",
						// The second half is not padding, and it is placement-SPECIFIC on purpose.
						// Every placement READS apps_path since #3449 — the sentence that used to
						// sit here said `dedicated` ignored it, which described the defect that PR
						// fixed rather than the field. But what a path REPLACES is dedicated-only:
						// the apps-overlays ApplicationSet is rendered by RenderApplications, which
						// runs below the placement dispatch in provisioner/deploy.go, so namespace
						// and vcluster placements have no overlay discovery to turn off — they
						// render one Application at `path: '{{ .AppsPath }}'`, defaulting to `.`.
						//
						// So "Alethia then discovers overlays/* for you" is true on a dedicated
						// cluster and false on the other two, which is the inverse of the original
						// error rather than a fix for it — the same defect class (#1767) as a knob
						// whose label does not describe what it does, one level subtler.
						description:
							"Subdirectory this environment syncs, e.g. overlays/dev. Empty syncs the repository root. Read on every placement. On a dedicated cluster, empty also turns on overlay discovery — each overlays/* directory becomes its own Application — and naming a path replaces it; namespace and vcluster placements have no discovery either way.",
					},
				],
			},
		],
		summary: (c) => c.apps_destination_repo || "no repository",
	},
};

/**
 * Look up a kind's config schema, widened to the generic renderer's
 * `Record<string, unknown>` seam. The inspector + config-fields hold a node whose kind
 * is only known at runtime, so they can't narrow to a specific `NodeConfigMap` fragment;
 * this single, documented widening is the erasure boundary of the key-driven engine.
 */
export function getKindConfig(kind: NodeKind): KindConfig | undefined {
	// @ts-expect-error KindConfig<C> is contravariant in C (its setter), so the K-specific entry can't widen to KindConfig<AnyConfig>
	return CONFIG_SCHEMA[kind];
}
