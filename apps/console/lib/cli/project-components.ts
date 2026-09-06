// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The CLI project-component registry — the single source of the component KINDS the
// `alethia project component` group can author, and the per-kind validation of the
// generic `--set key=value` field setter. Each kind maps to one drizzle component table
// (project_network, project_databases, …); singletons are 1:1 per project, multi kinds are
// keyed on (project_id, name). The `fields` of an add request are validated against the
// table's drizzle-zod insert schema (picked down to the user-settable columns) so an
// unknown or mistyped field is a clear 400 — code and DB never drift.

import { createHash } from "node:crypto";
import { createInsertSchema } from "drizzle-zod";
import { and, eq, getTableColumns } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { getServiceDb } from "@/lib/db";
import { asRecord } from "@/lib/records";
import {
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectDns,
	projectHelmRegistries,
	projectNetwork,
	projectNosqlTables,
	projectObservability,
	projectQueues,
	projectRepositories,
	projectEnvironments,
	projectSecrets,
	projectStorageBuckets,
	projectTopics,
} from "@/lib/db/schema";
import { appsPathSchema } from "@/lib/validations/apps-path";
import { clusterNodeSizingBounds } from "@/lib/validations/project-form.schema";

/** A component as it appears on the CLI wire — uniform across every kind. `config` is the
 * kind-specific column set as an open object (mirrors componentWire). */
export interface ComponentWire {
	id: string;
	kind: string;
	name: string;
	status: string;
	cloud_identity_id: string | null;
	config: Record<string, unknown>;
}

/** One supported component kind. `fields` is the drizzle-zod insert schema narrowed to the
 * user-settable columns (everything else is server-managed). */
interface KindDef {
	table: PgTable;
	singleton: boolean;
	fields: z.ZodTypeAny;
}

// Columns never surfaced in `config` (server-managed envelope + secrets). Name + status +
// cloud_identity_id are surfaced as dedicated wire fields; everything else is config.
const WIRE_EXCLUDE = new Set<string>([
	"id",
	"project_id",
	"created_at",
	"updated_at",
	"status",
	"status_message",
	"estimated_monthly_cost",
	"name",
	"cloud_identity_id",
	"argocd_url",
	"cluster_endpoint",
	"endpoint",
	"reader_endpoint",
	"provider_outputs",
	"repository_url",
	"secret_ref",
]);

/** The component-kind registry. The pick-lists are the columns a CLI caller may `--set`;
 * server-managed columns (status, endpoints, provider_outputs, JSONB provider_config) are
 * intentionally excluded — nested JSONB config is not settable via the scalar `--set` flag. */
const KINDS: Record<string, KindDef> = {
	network: {
		table: projectNetwork,
		singleton: true,
		fields: createInsertSchema(projectNetwork)
			.pick({
				cloud_identity_id: true,
				region: true,
				provision_network: true,
				network_id: true,
				cidr_block: true,
				single_nat_gateway: true,
				allowed_cidr_blocks: true,
			})
			.partial(),
	},
	cluster: {
		table: projectCluster,
		singleton: true,
		// The sizing bounds are IMPORTED, not restated. This registry builds a fresh insert
		// schema and shares no validator with the canvas, so a bound added only there left
		// `alethia project component set cluster node_min_size=-4` wide open — one definition,
		// two write paths. The cross-field rule (min <= desired <= max) can't live here: it
		// needs a `.superRefine`, and validateComponentFields introspects `.shape` to reject
		// unknown keys, which a ZodEffects wrapper would empty out. CloudProvider.ValidateConfig
		// is the backstop that catches it on this path.
		fields: createInsertSchema(projectCluster, clusterNodeSizingBounds)
			.pick({
				cloud_identity_id: true,
				region: true,
				cluster_version: true,
				instance_types: true,
				node_min_size: true,
				node_max_size: true,
				node_desired_size: true,
				cluster_name: true,
			})
			.partial(),
	},
	dns: {
		table: projectDns,
		singleton: true,
		fields: createInsertSchema(projectDns)
			.pick({
				cloud_identity_id: true,
				region: true,
				enabled: true,
				provider: true,
				zone_id: true,
				domain_name: true,
				managed_certificate: true,
				waf_enabled: true,
			})
			.partial(),
	},
	observability: {
		table: projectObservability,
		singleton: true,
		fields: createInsertSchema(projectObservability)
			.pick({
				cloud_identity_id: true,
				region: true,
				enabled: true,
				provider: true,
			})
			.partial(),
	},
	repositories: {
		table: projectRepositories,
		singleton: true,
		fields: createInsertSchema(projectRepositories)
			.pick({ apps_destination_repo: true, apps_path: true })
			.partial()
			// #1767 — `.extend` LAST so the mirrored guard wins over the bare nullable text()
			// column drizzle-zod infers. Without it `--set apps_path=../../etc` is a clean 200
			// straight into the DB and thence into buildConfigSnapshot, and the user only finds
			// out when the deploy job dies on argocd.ValidateAppsPath.
			.extend({ apps_path: appsPathSchema }),
	},
	databases: {
		table: projectDatabases,
		singleton: false,
		fields: createInsertSchema(projectDatabases)
			.pick({
				cloud_identity_id: true,
				region: true,
				engine: true,
				engine_version: true,
				min_capacity: true,
				max_capacity: true,
				port: true,
				backup_retention_days: true,
				iam_auth: true,
			})
			.partial(),
	},
	caches: {
		table: projectCaches,
		singleton: false,
		fields: createInsertSchema(projectCaches)
			.pick({
				cloud_identity_id: true,
				region: true,
				engine: true,
				node_type: true,
				num_cache_nodes: true,
				multi_az: true,
				allowed_cidr_blocks: true,
			})
			.partial(),
	},
	queues: {
		table: projectQueues,
		singleton: false,
		fields: createInsertSchema(projectQueues)
			.pick({
				cloud_identity_id: true,
				region: true,
				ordered: true,
				visibility_timeout: true,
				message_retention: true,
			})
			.partial(),
	},
	topics: {
		table: projectTopics,
		singleton: false,
		fields: createInsertSchema(projectTopics)
			.pick({ cloud_identity_id: true, region: true })
			.partial(),
	},
	nosql_tables: {
		table: projectNosqlTables,
		singleton: false,
		fields: createInsertSchema(projectNosqlTables)
			.pick({
				cloud_identity_id: true,
				region: true,
				table_type: true,
				partition_key: true,
				partition_key_type: true,
				sort_key: true,
				sort_key_type: true,
				capacity_mode: true,
				point_in_time_recovery: true,
				global_replicas: true,
			})
			.partial(),
	},
	container_registries: {
		table: projectContainerRegistries,
		singleton: false,
		fields: createInsertSchema(projectContainerRegistries)
			.pick({
				cloud_identity_id: true,
				region: true,
				provider: true,
				// `repository_url` is NOT here, and the omission is the point: it is a write-back slot
				// the deploy fills with the registry it actually created (see the column's own comment
				// in lib/db/schema/project-components.ts), which is why WIRE_EXCLUDE strips it from the
				// config the runner reads. Accepting it from `--set` validated a value, stored it, and
				// then overwrote it — input taken and discarded, with nothing to tell the caller.
				// Typed columns since #1811, so `--set` reaches them the same way it reaches nosql's
				// point_in_time_recovery. While they were provider_config keys the CLI could not
				// touch them at all.
				immutable_tags: true,
				vulnerability_scanning: true,
			})
			.partial(),
	},
	// A chart repo's HOST lives in the JSONB provider_config, which `--set` deliberately can't reach,
	// so the CLI can list/read these and switch the connector but not finish configuring an "any
	// host" provider — that needs the console.
	helm_registries: {
		table: projectHelmRegistries,
		singleton: false,
		fields: createInsertSchema(projectHelmRegistries)
			.pick({
				cloud_identity_id: true,
				region: true,
				provider: true,
			})
			.partial(),
	},
	secrets: {
		table: projectSecrets,
		singleton: false,
		fields: createInsertSchema(projectSecrets)
			.pick({
				cloud_identity_id: true,
				region: true,
				provider: true,
				generate: true,
				length: true,
				special_chars: true,
			})
			.partial(),
	},
	storage_buckets: {
		table: projectStorageBuckets,
		singleton: false,
		fields: createInsertSchema(projectStorageBuckets)
			.pick({
				cloud_identity_id: true,
				region: true,
				versioning: true,
				encryption_enabled: true,
				public_access: true,
				cors_origins: true,
			})
			.partial(),
	},
};

/** The list of supported component kinds (stable order), for the `kinds` command + docs. */
export const COMPONENT_KINDS = Object.keys(KINDS);

/** Resolves a kind name to its definition, or null when the kind is unknown. */
export function getKindDef(kind: string): KindDef | null {
	return Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
}

/** True if the kind is a project singleton (1:1, name-less). */
export function isSingletonKind(kind: string): boolean {
	const def = getKindDef(kind);
	return def ? def.singleton : false;
}

// ─────────────────────────────────────────────────────────────────────────────
// The PUBLISHED schema (#3671)
//
// Everything above this line is the server's private opinion of what a component kind is. The
// CLI holds a SECOND opinion — `componentKinds` and `singletonKinds`, two literals in
// apps/cli/cmd/project_component.go — and the two have already drifted: `helm_registries` is in
// this registry and is not in that list, so `alethia project component kinds` does not name a
// kind the server will happily author.
//
// A wire projection of THIS registry is what turns that literal into a cache. It carries the
// three things the CLI reads a registry for:
//
//   • which kinds exist, in a stable order   (`componentKinds`)
//   • which of them are 1:1 per environment  (`singletonKinds`)
//   • what `--set key=value` may assign, and AT WHAT TYPE
//
// The third closes the `--set` split-brain. Today coercion lives in Go — `coerceSetValue` JSON-
// decodes the raw text with no idea what the field is — and validation lives here, so
// `--set cluster_version=1.35` becomes the NUMBER 1.35 and this registry refuses it against a
// `text()` column, with the documented workaround being to quote it. A client that has read
// `{"cluster_version": {"type": "string"}}` can coerce per field instead of per literal, and it
// can refuse a bad value before spending a round trip.
//
// The document is deliberately never STRICTER than the server. Some of this registry's rules are
// not expressible in JSON Schema at all — apps_path's mirrored grammar is a `.refine`, so it
// publishes as plain `string` — so what ships is a SUPERSET of what the server accepts. That is
// the safe direction, and it is the epic's invariant: a client validating against this document
// can only ever refuse a value the server would also refuse, never one it would have taken.

/** One published component kind. */
export interface PublishedComponentKind {
	kind: string;
	/** 1:1 per (project, environment) — the CLI's `singletonKinds`, no longer hand-typed. */
	singleton: boolean;
	/** Settable field names, in registry order. DERIVED from `schema.properties` — never
	 *  written out separately, so the list and the schema cannot disagree. */
	fields: string[];
	/** JSON Schema (draft-7) of the `fields` object of an add / `--set` request. */
	schema: Record<string, unknown>;
}

/** The published component-kind registry as it goes over the wire. */
export interface ComponentSchemaDocument {
	/** sha256 over the serialized `kinds` — the CLI's cache key and the route's ETag, so a cached
	 *  copy can be revalidated for free and changes when the published registry does. */
	version: string;
	kinds: PublishedComponentKind[];
}

/** The wire contract for {@link ComponentSchemaDocument}, so `cliJson` validates the bytes that
 *  actually ship. `kinds` is bounded below on purpose: an empty document is not a small answer,
 *  it is a client that will refuse every `--kind`, and it must be a 500 rather than a 200. */
export const componentSchemaWire = z.object({
	version: z.string().min(1),
	kinds: z
		.array(
			z.object({
				kind: z.string().min(1),
				singleton: z.boolean(),
				fields: z.array(z.string().min(1)),
				schema: z.record(z.string(), z.unknown()),
			}),
		)
		.min(1),
});

/**
 * Fails loudly on a VACUOUS published registry — zero kinds, or a kind that publishes zero
 * settable fields.
 *
 * Both are silent-wrong-answer shapes rather than errors: a client caching an empty `kinds`
 * array refuses every `--kind` the server would have accepted, and a kind whose `properties`
 * came back empty tells the client "nothing is settable here" when in fact everything is. Both
 * render as a working CLI that has quietly lost a capability, so the census is asserted rather
 * than assumed.
 *
 * Exported so the zero census can be driven directly — a guard whose failure branch has never
 * run is a comment.
 */
export function assertComponentSchemaPublishable(
	kinds: readonly PublishedComponentKind[],
): void {
	if (kinds.length === 0) {
		throw new Error(
			"component schema: the kind registry published ZERO kinds — a client caching this document would refuse every --kind",
		);
	}
	const empty = kinds.filter((k) => k.fields.length === 0).map((k) => k.kind);
	if (empty.length > 0) {
		throw new Error(
			`component schema: kind(s) published no settable fields: ${empty.join(", ")} — a client caching this document would refuse every --set for them`,
		);
	}
}

/** Projects the private registry into the published document. */
function buildComponentSchemaDocument(): ComponentSchemaDocument {
	const kinds = COMPONENT_KINDS.map((kind) => {
		const def = KINDS[kind];
		// `io: "input"` because this document describes what a caller may SEND, and draft-7 to
		// match the target the Go contract fixtures are already generated at
		// (apps/console/scripts/gen-cli-fixtures.ts).
		//
		// `unrepresentable` is left at its default (THROW) rather than "any", because `{}` is a
		// node that accepts everything and that is the one answer a client must never cache.
		//
		// The throw is NOT a build failure, and it would be wrong to describe it as one. This
		// builder is reachable only through the memoized componentSchemaDocument(), so on its own
		// the first symptom of an inexpressible field would be a 500 on the first REQUEST in
		// production. What catches it before a deploy is a named unit test — "expresses every
		// published kind as JSON Schema" in tests/lib/cli/component-schema.test.ts drives this
		// function directly.
		//
		// The reachable case is a TIMESTAMP column: drizzle-zod infers `z.date()` for one, and
		// `created_at` / `updated_at` sit one line away in every pick-list below. Adding
		// `created_at: true` to a pick is green under `tsc --noEmit`, `eslint` and `next build`,
		// and red in the unit suite with "Date cannot be represented in JSON Schema" — measured,
		// not assumed. (A jsonb column is NOT this case: `provider_config` publishes an explicit
		// any-JSON-value union rather than an empty node.) The test is the guard.
		const schema = asRecord(
			z.toJSONSchema(def.fields, { target: "draft-7", io: "input" }),
		);
		return {
			kind,
			singleton: def.singleton,
			fields: Object.keys(asRecord(schema.properties)),
			schema,
		};
	});
	assertComponentSchemaPublishable(kinds);
	const version = createHash("sha256")
		.update(JSON.stringify(kinds))
		.digest("hex");
	return { version, kinds };
}

let schemaDocument: ComponentSchemaDocument | null = null;

/**
 * The published component-kind schema. Memoized: it is a pure projection of module-level
 * constants, so it is identical for every caller and every tenant, and its `version` must be
 * stable across requests for the ETag to mean anything.
 */
export function componentSchemaDocument(): ComponentSchemaDocument {
	if (!schemaDocument) schemaDocument = buildComponentSchemaDocument();
	return schemaDocument;
}

/** Maps a component row to its uniform CLI wire shape. */
export function rowToComponentWire(kind: string, row: unknown): ComponentWire {
	const rec = asRecord(row);
	const name =
		typeof rec.name === "string" && rec.name.length > 0 ? rec.name : kind;
	const status = typeof rec.status === "string" ? rec.status : "";
	const cloud =
		typeof rec.cloud_identity_id === "string" ? rec.cloud_identity_id : null;
	const config: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(rec)) {
		if (!WIRE_EXCLUDE.has(k)) config[k] = v;
	}
	return {
		id: String(rec.id),
		kind,
		name,
		status,
		cloud_identity_id: cloud,
		config,
	};
}

/** Result of validating an add request's `fields`: the typed values, or an error message. */
type ValidateResult =
	| { ok: true; values: Record<string, unknown> }
	| { ok: false; error: string };

/** Validates the raw `--set` fields against the kind's insert schema: rejects unknown keys
 * and type-mismatched values, returning a clear message for the 400. */
export function validateComponentFields(
	kind: string,
	fields: Record<string, unknown>,
): ValidateResult {
	const def = getKindDef(kind);
	if (!def) return { ok: false, error: `Unknown component kind "${kind}"` };

	const schema = def.fields;
	const allowed =
		schema instanceof z.ZodObject ? new Set(Object.keys(schema.shape)) : new Set<string>();
	const unknown = Object.keys(fields).filter((k) => !allowed.has(k));
	if (unknown.length > 0) {
		return {
			ok: false,
			error: `Unknown field(s) for ${kind}: ${unknown.join(", ")}. Allowed: ${[...allowed].join(", ")}`,
		};
	}

	const parsed = schema.safeParse(fields);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		const path = first?.path.join(".") || "fields";
		return { ok: false, error: `Invalid value for ${path}: ${first?.message ?? "invalid"}` };
	}
	return { ok: true, values: asRecord(parsed.data) };
}

/** Lists a project's components — all kinds, or a single kind when `kindFilter` is set —
 * flattened into the uniform wire shape.
 *
 * `environmentId` scopes the result to one environment. Without it a two-environment project lists
 * every row from every environment, flattened, with the same `kind` and `name` appearing twice and
 * nothing in the table to tell them apart — the `environment_id` is only visible inside `config`.
 * Every caller that can name an environment should pass one. */
export async function listProjectComponents(
	projectId: string,
	kindFilter?: string,
	environmentId?: string,
): Promise<ComponentWire[]> {
	const db = getServiceDb();
	const kinds = kindFilter ? [kindFilter] : COMPONENT_KINDS;
	const out: ComponentWire[] = [];
	for (const kind of kinds) {
		const def = getKindDef(kind);
		if (!def) continue;
		const cols = getTableColumns(def.table);
		const rows = await db
			.select()
			.from(def.table)
			.where(componentScope(cols, projectId, environmentId));
		for (const row of rows) out.push(rowToComponentWire(kind, row));
	}
	return out;
}

/** `project_id` AND, when given, `environment_id`. One helper so a caller cannot scope a read one
 * way and a delete another — which is the asymmetry that made the delete below destructive. */
function componentScope(
	cols: Record<string, AnyColumn>,
	projectId: string,
	environmentId?: string,
) {
	const scope = eq(cols.project_id, projectId);
	if (!environmentId || !cols.environment_id) return scope;
	return and(scope, eq(cols.environment_id, environmentId));
}

/** Inserts a component of `kind` on a project, scoped to `environmentId`. Singletons upsert on the
 * composite `(project_id, environment_id)` — the table's actual unique; multi kinds require a name
 * and conflict (handled by the caller) on `(project_id, environment_id, name)`. Returns the
 * created/updated row's wire. */
export async function insertProjectComponent(
	kind: string,
	projectId: string,
	environmentId: string,
	name: string,
	values: Record<string, unknown>,
): Promise<ComponentWire> {
	const def = getKindDef(kind);
	if (!def) throw new Error(`Unknown component kind "${kind}"`);
	const db = getServiceDb();
	const cols = getTableColumns(def.table);

	// environment_id is required — a component in a NULL env is invisible to the env-scoped deploy,
	// and the singleton unique is composite, so the conflict target below must include it.
	const insertValues: Record<string, unknown> = {
		project_id: projectId,
		environment_id: environmentId,
		...values,
	};
	if (!def.singleton) insertValues.name = name;

	// A dedicated environment's cluster carries the Fabric linkage, and that linkage has to be
	// made HERE because nothing else makes it at runtime. `project_cluster`
	// was written env-keyed with a null `fabric_id`, and the only thing that ever filled it was
	// a migration-time backfill in programmables.sql — which by definition cannot reach a project
	// created after it ran, i.e. every real project.
	//
	// The consequence was not a null column, it was the whole isolation ladder. The Fabric's own
	// `dedicated` env still resolved, because resolveServingCluster falls back to the env-keyed
	// row; but a `namespace` or `vcluster` env has no cluster row of its own and resolves ONLY by
	// Fabric, so it found nothing and the deploy failed closed with "no serving cluster on the
	// config snapshot — the Fabric's cluster must be provisioned", against a cluster that was
	// provisioned, ACTIVE and serving. Every shared placement was unreachable.
	const fabricLinked = "fabric_id" in cols;
	if (fabricLinked) {
		const [env] = await db
			.select({
				fabric_id: projectEnvironments.fabric_id,
				placement_mode: projectEnvironments.placement_mode,
			})
			.from(projectEnvironments)
			.where(eq(projectEnvironments.id, environmentId))
			.limit(1);
		if (env?.placement_mode === "dedicated") {
			insertValues.fabric_id = env.fabric_id;
		} else {
			delete insertValues.fabric_id;
		}
	}

	if (def.singleton) {
		// The conflict branch must carry the linkage too. `add` upserts, so the row a caller is
		// amending is very often one written before this fix — repairing it on write is what makes
		// the fix reach existing projects without a data migration.
		const updateValues = fabricLinked
			? { ...values, fabric_id: insertValues.fabric_id ?? null }
			: values;
		const [row] = await db
			.insert(def.table)
			.values(insertValues)
			.onConflictDoUpdate({
				target: [cols.project_id, cols.environment_id],
				set: updateValues,
			})
			.returning();
		return rowToComponentWire(kind, row);
	}
	const [row] = await db.insert(def.table).values(insertValues).returning();
	return rowToComponentWire(kind, row);
}

/** Deletes a component within ONE environment. Singletons delete that environment's single row;
 * multi kinds delete the named row in it. Returns whether a row was removed (false → 404).
 *
 * `environmentId` is REQUIRED, and that is the fix rather than a convenience. This used to scope a
 * singleton delete to `project_id` alone, so `component remove --kind cluster` deleted the cluster
 * row of EVERY environment — for a multi-tier project, one command silently destroying the sibling
 * environment's design. Harmless while the insert path could only ever write the default
 * environment; a data-loss bug the moment per-environment authoring exists, which is the same
 * change that introduces it. Pass the environment the caller actually named. */
export async function deleteProjectComponent(
	kind: string,
	projectId: string,
	name: string,
	environmentId: string,
): Promise<boolean> {
	const def = getKindDef(kind);
	if (!def) return false;
	const db = getServiceDb();
	const cols = getTableColumns(def.table);

	const scope = componentScope(cols, projectId, environmentId);
	const where =
		def.singleton || !cols.name ? scope : and(scope, eq(cols.name, name));

	const deleted = await db.delete(def.table).where(where).returning();
	return deleted.length > 0;
}
