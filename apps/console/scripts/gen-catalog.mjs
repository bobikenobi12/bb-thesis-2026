// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generates the typed TS mirror of the cloud catalog from the single source of truth
 * (`packages/core/catalog/catalog.json`). The same JSON is embedded by the Go resolver,
 * so the UI and the provisioner never drift. Run via `pnpm -C apps/console run gen:catalog`;
 * CI re-runs it and fails on drift.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const srcPath = resolve(repoRoot, "packages/core/catalog/catalog.json");
const outPath = resolve(here, "../lib/cloud-providers/generated/catalog.ts");

const raw = readFileSync(srcPath, "utf8");
// Parse to validate it's well-formed before we emit; re-stringify for stable formatting.
const data = JSON.parse(raw);

// Emit a JS value as a TS literal, indented one level so it aligns under `export const ...`.
const emit = (v) => JSON.stringify(v, null, "\t").replace(/\n/g, "\n\t");

// The legacy snake_case `CATALOG` mirror carries ONLY the original core sections — the `live`
// block (Catalog #2, #1126) is emitted separately as its own typed consts below, so keep it out
// of the `Catalog`-typed object.
const { live: _live, ...catalogCore } = data;
const json = emit(catalogCore);

// The `live` block (Catalog #2, #1126): the full 7-provider / native-region / cross-provider /
// WAF-CERT-NOSQL-NETWORK-MESSAGING data, extracted VERBATIM from the hand-maintained constants so
// the generated baseline is a byte-exact SUPERSET the #969 barrel-shim can re-export unchanged.
const live = data.live;
if (!live) throw new Error("catalog.json is missing the `live` block (#1126)");

// Fail-fast shape guard: the `live` block must carry every Catalog #2 section, and every
// provisioning-keyed map must cover the same slug set (so the emitted `Record<CloudProviderSlug, …>`
// consts are total). A malformed catalog.json reds here with a clear message instead of emitting a
// broken catalog.ts (type errors then surface far downstream). check-types is the deeper guard.
const REQUIRED_LIVE_KEYS = [
	"providers", "regionLabels", "defaultRegion", "regionMap", "instanceTypes",
	"k8sVersions", "autoscaler", "defaultInstanceType", "defaultK8sVersion", "instanceTypeMap",
	"dbEngines", "dbCapacity", "engineMap", "cacheNodeTypes", "cacheEngines", "defaultCacheNode",
	"cacheNodeMap", "wafOptions", "certOptions", "nosql", "network", "messaging",
];
for (const k of REQUIRED_LIVE_KEYS) {
	if (!(k in live)) throw new Error(`catalog.json live block is missing '${k}' (#1126)`);
}
const provisioningSlugs = Object.keys(live.instanceTypes).sort();
for (const k of ["regionLabels", "defaultRegion", "regionMap", "k8sVersions", "autoscaler",
	"defaultInstanceType", "defaultK8sVersion", "instanceTypeMap", "dbEngines", "dbCapacity",
	"engineMap", "cacheNodeTypes", "cacheEngines", "defaultCacheNode", "cacheNodeMap", "wafOptions",
	"certOptions", "nosql", "network", "messaging"]) {
	const got = Object.keys(live[k]).sort();
	if (got.join(",") !== provisioningSlugs.join(",")) {
		throw new Error(
			`catalog.json live.${k} slug set [${got}] != provisioning set [${provisioningSlugs}] (#1126)`,
		);
	}
}

// The offline engine-version baseline (#1373). These strings are what the picker falls back to when
// an account's capabilities haven't synced, AND what flows into the provider's tofu `engine_version`
// variable — so a malformed list is a bad apply, not a cosmetic UI bug. The same invariants are
// checked in Go (`TestDBEngineVersions`): the two consumers read this JSON by different paths, and
// each must fail on its own rather than relying on the other having run.
const assertVersions = (where, engine, versions, defaultVersion) => {
	if (!Array.isArray(versions) || versions.length === 0) {
		throw new Error(`catalog.json ${where} '${engine}' has no versions[] (#1373)`);
	}
	if (!versions.includes(defaultVersion)) {
		throw new Error(
			`catalog.json ${where} '${engine}' default version '${defaultVersion}' is not in versions ${JSON.stringify(versions)} (#1373)`,
		);
	}
	if (new Set(versions).size !== versions.length) {
		throw new Error(`catalog.json ${where} '${engine}' repeats a version (#1373)`);
	}
};
for (const [provider, dp] of Object.entries(catalogCore.database)) {
	const liveEngines = live.dbEngines[provider];
	if (!liveEngines || liveEngines.length !== dp.engines.length) {
		throw new Error(
			`catalog.json live.dbEngines.${provider} does not mirror database.${provider}.engines (#1373)`,
		);
	}
	dp.engines.forEach((e, i) => {
		assertVersions(`database.${provider}`, e.value, e.versions, e.default_version);
		assertVersions(
			`live.dbEngines.${provider}`,
			liveEngines[i].value,
			liveEngines[i].versions,
			liveEngines[i].defaultVersion,
		);
		// The two surfaces are separate JSON (snake `database`, camel `live.dbEngines`) describing the
		// SAME engine — the canvas picker reads one, the Go resolver the other. They already disagree
		// on Alibaba's engine `value`; the version axis must not be allowed to fork the same way.
		if (JSON.stringify(e.versions) !== JSON.stringify(liveEngines[i].versions)) {
			throw new Error(
				`catalog.json versions drift for ${provider}/${e.value}: database ${JSON.stringify(e.versions)} vs live ${JSON.stringify(liveEngines[i].versions)} (#1373)`,
			);
		}
	});
}

// Cache engines get the same dual-surface mirror check as DB engines. They are a NEW axis (#1420):
// "which cache engines does this cloud offer" used to live hardcoded in the canvas floor and again in
// the cross-cloud converter, so the two could disagree and nothing noticed. Now it is catalog data,
// which means it can fork between the snake and camel surfaces the same way — so it is checked.
for (const [provider, cp] of Object.entries(catalogCore.cache)) {
	const liveEngines = live.cacheEngines[provider];
	const snake = (cp.engines ?? []).map((e) => e.value);
	const camel = (liveEngines ?? []).map((e) => e.value);
	if (snake.length === 0) {
		throw new Error(`catalog.json cache.${provider}.engines is empty — every cloud offers at least one (#1420)`);
	}
	if (JSON.stringify(snake) !== JSON.stringify(camel)) {
		throw new Error(
			`catalog.json cache engines drift for ${provider}: cache ${JSON.stringify(snake)} vs live ${JSON.stringify(camel)} (#1420)`,
		);
	}
}

// Cache TIERS, the axis one field over from the engines above — and the one that actually forked
// (#1577). `cache.<p>.tiers` is what the Go resolver picks a sku from (NearestCacheTier), while
// `live.cacheNodeTypes` / `defaultCacheNode` / `cacheNodeMap` are what the canvas stamps, offers and
// converts with. When azure moved to Managed Redis, only the first was updated: the canvas kept
// defaulting every cache to the retired `C1`, which the tofu template's sku validation rejects — so
// an azure cache left at its defaults did not plan at all. Nothing noticed, because nothing checked.
//
// Deliberately a SUBSET check, not the engines' exact-mirror: `live.cacheNodeTypes` is a curated
// ladder carrying a `cost` hint (aws lists 5 of its tiers, alibaba 3 of 4), and that is fine. What
// may never happen is a DIFFERENT value space — a name the resolver and the template have never
// heard of.
const cacheTierValues = Object.fromEntries(
	Object.entries(catalogCore.cache).map(([p, cp]) => [p, new Set((cp.tiers ?? []).map((t) => t.value))]),
);
for (const [provider, tiers] of Object.entries(cacheTierValues)) {
	if (tiers.size === 0) {
		throw new Error(`catalog.json cache.${provider}.tiers is empty — every cloud offers at least one (#1577)`);
	}
	const offered = (live.cacheNodeTypes[provider] ?? []).map((n) => n.value);
	const stray = offered.filter((v) => !tiers.has(v));
	if (stray.length > 0) {
		throw new Error(
			`catalog.json live.cacheNodeTypes.${provider} offers ${JSON.stringify(stray)}, which cache.${provider}.tiers does not — the picker names a sku the resolver and the template never see (#1577)`,
		);
	}
	const fallback = live.defaultCacheNode[provider];
	if (!tiers.has(fallback)) {
		throw new Error(
			`catalog.json live.defaultCacheNode.${provider} = ${JSON.stringify(fallback)} is not a cache.${provider}.tiers value — every cache node the canvas creates would carry an unbuildable sku (#1577)`,
		);
	}
}

// The cross-cloud conversion map is the third surface holding these same sku names, and it fell out
// of date with the other two for exactly as long. Both sides are checked: a key must be a sku of the
// SOURCE cloud, a value a sku of the TARGET cloud.
for (const [source, targets] of Object.entries(live.cacheNodeMap)) {
	for (const [target, mapping] of Object.entries(targets)) {
		const badKeys = Object.keys(mapping).filter((k) => !cacheTierValues[source]?.has(k));
		const badValues = Object.values(mapping).filter((v) => !cacheTierValues[target]?.has(v));
		if (badKeys.length > 0 || badValues.length > 0) {
			throw new Error(
				`catalog.json live.cacheNodeMap.${source}.${target} is stale: unknown ${source} skus ${JSON.stringify(badKeys)}, unknown ${target} skus ${JSON.stringify(badValues)} (#1577)`,
			);
		}
	}
}

// The PROVISIONING slug set - the clouds with per-cloud sizing/pricing catalogs - derived from the
// live data's own coverage (the `instanceTypes` keys) so it can't drift from it. Still gated through
// `Extract<CloudProvider, ...>` so an off-enum slug surfaces instead of being invented.
const provisioningSlugUnion = Object.keys(live.instanceTypes)
	.map((s) => JSON.stringify(s))
	.join(" | ");

// Derive the `ProviderSlug` union from the catalog's OWN provider coverage rather than
// hardcoding it, so the type can never drift from the data (the whole point of this SSOT).
// `Extract<CloudProvider, …>` still gates each slug against the generated `cloud_provider`
// enum — a catalog provider that isn't a valid enum member resolves to `never` and drops out,
// surfacing the mismatch instead of inventing an off-enum slug.
const providerSlugUnion = data.providers
	.map((p) => JSON.stringify(p.slug))
	.join(" | ");

const out = `// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GENERATED by apps/console/scripts/gen-catalog.mjs — DO NOT EDIT.
// Source of truth: packages/core/catalog/catalog.json (also embedded by the Go resolver).
// Run \`pnpm -C apps/console run gen:catalog\` to regenerate.

import type { CloudProvider } from "@/lib/db/schema/enums";
import type { ClusterProviderConfig, DnsProviderConfig } from "@/types/jsonb.types";

// The clouds with a per-cloud pricing/sizing catalog — a curated subset of the generated
// \`cloud_provider\` enum, derived from the catalog's own \`providers[]\` so it can't drift.
export type ProviderSlug = Extract<CloudProvider, ${providerSlugUnion}>;
export type InstanceFamily = "general" | "compute" | "memory" | "gpu";
export type EngineFamily = "postgres" | "mysql";

export interface ProviderMeta {
	slug: string;
	name: string;
	cluster_service: string;
	network_name: string;
	dns_service: string;
	database_service: string;
	cache_service: string;
	nosql_service: string;
	queue_service: string;
	topic_service: string;
	storage_service: string;
	registry_service: string;
	secrets_service: string;
}

export interface Region {
	id: string;
	label: string;
	group: string;
	codes: Record<string, string>;
}

export interface Instance {
	value: string;
	label: string;
	vcpu: number;
	memory_gb: number;
	family: string;
	cost: string;
}

export interface ComputeProvider {
	default_instance: string;
	default_k8s_version: string;
	k8s_versions: string[];
	autoscaler_key: string;
	instances: Instance[];
}

export interface DBEngine {
	family: string;
	value: string;
	label: string;
	default_version: string;
	/** Offline version baseline, newest-first; always contains \`default_version\`. Guidance, not a
	 * gate — an account offering something newer must still be able to pick it (#918). */
	versions: string[];
}

export interface Capacity {
	unit: string;
	min: number;
	max: number;
	step: number;
	default_min: number;
	default_max: number;
}

export interface DatabaseProvider {
	capacity: Capacity;
	engines: DBEngine[];
}

export interface CacheTier {
	value: string;
	label: string;
	memory_gb: number;
	cost: string;
}

export interface CacheEngine {
	value: string;
	label: string;
}

export interface CacheProvider {
	default_tier: string;
	engines: CacheEngine[];
	tiers: CacheTier[];
}

export interface Catalog {
	version: number;
	providers: ProviderMeta[];
	regions: Region[];
	compute: Record<string, ComputeProvider>;
	database: Record<string, DatabaseProvider>;
	cache: Record<string, CacheProvider>;
}

export const CATALOG: Catalog = ${json};

/** Provider display + service-name metadata. */
export function providerMeta(slug: string): ProviderMeta | undefined {
	return CATALOG.providers.find((p) => p.slug === slug);
}

/** Resolve a canonical region id to a provider-specific region code. */
export function resolveRegion(
	canonicalId: string,
	provider: string,
): string | undefined {
	return CATALOG.regions.find((r) => r.id === canonicalId)?.codes[provider];
}

/** Compute (cluster node) inventory for a provider. */
export function listInstances(provider: string): Instance[] {
	return CATALOG.compute[provider]?.instances ?? [];
}

/**
 * Pick the provider machine type closest to the requested capability, preferring the
 * requested family when it has members (mirrors the Go resolver).
 */
export function nearestInstance(
	provider: string,
	vcpu: number,
	memoryGb: number,
	family?: string,
): Instance | undefined {
	const instances = listInstances(provider);
	if (instances.length === 0) return undefined;
	const sameFamily = family
		? instances.filter((i) => i.family === family)
		: [];
	const candidates = sameFamily.length > 0 ? sameFamily : instances;
	const dist = (i: Instance) =>
		Math.hypot(i.vcpu - vcpu, i.memory_gb - memoryGb);
	return candidates.reduce((best, i) => (dist(i) < dist(best) ? i : best));
}

/** Database engines for a provider. */
export function dbEngines(provider: string): DBEngine[] {
	return CATALOG.database[provider]?.engines ?? [];
}

/** Resolve an abstract engine family (postgres/mysql) to the provider engine. */
export function dbEngine(
	provider: string,
	family: string,
): DBEngine | undefined {
	return dbEngines(provider).find((e) => e.family === family);
}

/** Cache SKU inventory for a provider. */
export function cacheTiers(provider: string): CacheTier[] {
	return CATALOG.cache[provider]?.tiers ?? [];
}

/** Cache ENGINES a provider can back — the cache-side twin of \`dbEngines\`. */
export function cacheEngines(provider: string): CacheEngine[] {
	return CATALOG.cache[provider]?.engines ?? [];
}

/** Pick the provider cache SKU whose memory is closest to the requested size. */
export function nearestCacheTier(
	provider: string,
	memoryGb: number,
): CacheTier | undefined {
	const tiers = cacheTiers(provider);
	if (tiers.length === 0) return undefined;
	return tiers.reduce((best, t) =>
		Math.abs(t.memory_gb - memoryGb) < Math.abs(best.memory_gb - memoryGb)
			? t
			: best,
	);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Catalog #2 (the "live" surface) — the full, hand-maintained provisioning-option catalog, now
// generated from the SAME source of truth (#1126). These exports are a byte-exact SUPERSET of the
// former hand-written constants (apps/console/lib/cloud-providers/{registry,regions,compute,
// database,cache,dns,nosql,network,messaging}.ts): all connectable providers (incl.
// digitalocean/civo), native per-provider region labels + cross-provider conversion maps,
// camelCase field names, and the WAF/CERT/NOSQL/NETWORK/MESSAGING maps the snake_case CATALOG above
// does not carry. The #969 barrel-shim re-exports these verbatim (zero importer behaviour change);
// #970 then deletes the hand-written source.

// Every cloud a user can CONNECT (identity layer) — the full generated cloud_provider enum.
export type ConnectableCloudSlug = CloudProvider;
// The clouds with full provisioning-option catalogs — a curated subset, derived from the live
// data's own coverage so it can't drift from it.
export type CloudProviderSlug = Extract<CloudProvider, ${provisioningSlugUnion}>;

/** High-level metadata and service-name mappings for a cloud provider (camelCase). */
export interface CloudProviderMeta {
	slug: ConnectableCloudSlug;
	name: string;
	shortName: string;
	icon: string;
	clusterService: string;
	networkName: string;
	dnsService: string;
	certService: string;
	dbService: string;
	cacheService: string;
	nosqlService: string;
	queueService: string;
	topicService: string;
	registryService: string;
	secretsService: string;
	storageService: string;
}

/** Provider metadata keyed by slug (all connectable clouds). */
export const PROVIDERS: Record<ConnectableCloudSlug, CloudProviderMeta> = ${emit(live.providers)};

export interface RegionMeta {
	label: string;
	group: string;
}

/** Human-readable region labels + geographic groupings per provider (native region codes). */
export const REGION_LABELS: Record<CloudProviderSlug, Record<string, RegionMeta>> = ${emit(live.regionLabels)};

/** Default region per provider (used when no cached regions are available). */
export const DEFAULT_REGION: Record<CloudProviderSlug, string> = ${emit(live.defaultRegion)};

/** Cross-provider region mapping for project conversion. */
export const REGION_MAP: Record<CloudProviderSlug, Record<CloudProviderSlug, Record<string, string>>> = ${emit(live.regionMap)};

export interface InstanceTypeOption {
	value: string;
	label: string;
	vcpu: number;
	memoryGb: number;
	cost: string;
}

/** Instance/machine type options per provider. */
export const INSTANCE_TYPES: Record<CloudProviderSlug, InstanceTypeOption[]> = ${emit(live.instanceTypes)};

/** Supported Kubernetes versions per provider (latest first). */
export const K8S_VERSIONS: Record<CloudProviderSlug, string[]> = ${emit(live.k8sVersions)};

export interface AutoscalerMeta {
	providerConfigKey: keyof ClusterProviderConfig;
	label: string;
	description: string;
}

/** Provider-specific cluster autoscaler configuration. */
export const AUTOSCALER: Record<CloudProviderSlug, AutoscalerMeta> = ${emit(live.autoscaler)};

/** Default instance type per provider (used for new project forms). */
export const DEFAULT_INSTANCE_TYPE: Record<CloudProviderSlug, string> = ${emit(live.defaultInstanceType)};

/** Default K8s version per provider (new-project form seed). */
export const DEFAULT_K8S_VERSION: Record<CloudProviderSlug, string> = ${emit(live.defaultK8sVersion)};

/** Cross-provider instance type mapping for project conversion. */
export const INSTANCE_TYPE_MAP: Record<CloudProviderSlug, Record<CloudProviderSlug, Record<string, string>>> = ${emit(live.instanceTypeMap)};

export interface DbEngineOption {
	value: string;
	label: string;
	defaultVersion: string;
	/** Offline version baseline, newest-first; always contains \`defaultVersion\`. */
	versions: string[];
}

/** Database engine options per provider. */
export const DB_ENGINES: Record<CloudProviderSlug, DbEngineOption[]> = ${emit(live.dbEngines)};

export interface CapacityModel {
	unit: string;
	min: number;
	max: number;
	step: number;
	defaultMin: number;
	defaultMax: number;
}

/** Capacity model (scaling units) per provider. */
export const DB_CAPACITY: Record<CloudProviderSlug, CapacityModel> = ${emit(live.dbCapacity)};

/** Cross-provider database engine mapping for project conversion. */
export const ENGINE_MAP: Record<CloudProviderSlug, Record<CloudProviderSlug, Record<string, string>>> = ${emit(live.engineMap)};

export interface CacheNodeOption {
	value: string;
	label: string;
	memoryGb: number;
	cost: string;
}

/** Cache node type options per provider. */
export const CACHE_NODE_TYPES: Record<CloudProviderSlug, CacheNodeOption[]> = ${emit(live.cacheNodeTypes)};

export interface CacheEngineOption {
	value: string;
	label: string;
}

/**
 * Cache ENGINES per provider — what each cloud can actually back.
 *
 * The database side has had this since the beginning (\`DB_ENGINES\`). The cache side didn't, so the
 * same knowledge lived hardcoded in the canvas floor and again in the cross-cloud converter, and the
 * two could disagree with nothing to catch it. Deriving both from here is what makes "Azure has no
 * Valkey" a fact the product enforces rather than a comment someone has to remember.
 */
export const CACHE_ENGINES: Record<CloudProviderSlug, CacheEngineOption[]> = ${emit(live.cacheEngines)};

/** Default cache node type per provider. */
export const DEFAULT_CACHE_NODE: Record<CloudProviderSlug, string> = ${emit(live.defaultCacheNode)};

/** Cross-provider cache node mapping for project conversion. */
export const CACHE_NODE_MAP: Record<CloudProviderSlug, Record<CloudProviderSlug, Record<string, string>>> = ${emit(live.cacheNodeMap)};

export interface WafOption {
	providerConfigKey: keyof DnsProviderConfig;
	label: string;
	description: string;
	cost: string;
}

/** WAF options per provider (shown as toggles in the DNS section). */
export const WAF_OPTIONS: Record<CloudProviderSlug, WafOption[]> = ${emit(live.wafOptions)};

export interface CertOption {
	providerConfigKey: keyof DnsProviderConfig;
	label: string;
	description: string;
}

/** Managed certificate options per provider. */
export const CERT_OPTIONS: Record<CloudProviderSlug, CertOption> = ${emit(live.certOptions)};

export interface NosqlConfig {
	serviceName: string;
	supportsRangeKey: boolean;
	supportsGlobalTables: boolean;
	billingModes: { value: string; label: string }[];
	keyTypes: { value: string; label: string }[];
	portabilityNote: string | null;
}

/** NoSQL service configuration per provider. */
export const NOSQL: Record<CloudProviderSlug, NosqlConfig> = ${emit(live.nosql)};

export interface NetworkConfig {
	networkLabel: string;
	createLabel: string;
	existingLabel: string;
	cidrLabel: string;
	natLabel: string;
	natSingleLabel: string;
	natMultiLabel: string;
}

/** Network/VPC terminology and labels per provider. */
export const NETWORK: Record<CloudProviderSlug, NetworkConfig> = ${emit(live.network)};

export interface MessagingConfig {
	queueLabel: string;
	topicLabel: string;
	supportsFifo: boolean;
	fifoLabel: string;
	visibilityTimeoutLabel: string;
}

/** Messaging service configuration per provider. */
export const MESSAGING: Record<CloudProviderSlug, MessagingConfig> = ${emit(live.messaging)};
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out);
console.log(`✓ wrote ${outPath}`);
