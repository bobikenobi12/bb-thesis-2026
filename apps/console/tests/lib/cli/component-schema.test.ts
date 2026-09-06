// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The PUBLISHED component-kind schema (#3671) — the document that turns the CLI's
// `componentKinds` / `singletonKinds` literals (apps/cli/cmd/project_component.go) from a second
// opinion into a cache.
//
// The kind census below is a GOLDEN LIST, written out on purpose rather than derived from
// COMPONENT_KINDS: a test that reads the registry to check the registry passes whatever the
// registry says, including "nothing". Adding or removing a kind is meant to fail here and be
// updated deliberately, because it changes a published contract that a client caches.

import { describe, expect, it } from "vitest";
import {
	assertComponentSchemaPublishable,
	componentSchemaDocument,
	componentSchemaWire,
	validateComponentFields,
} from "@/lib/cli/project-components";
import { asRecord } from "@/lib/records";

/** The kinds the server can author, in the order the registry declares them. */
const PUBLISHED_KINDS = [
	"network",
	"cluster",
	"dns",
	"observability",
	"repositories",
	"databases",
	"caches",
	"queues",
	"topics",
	"nosql_tables",
	"container_registries",
	"helm_registries",
	"secrets",
	"storage_buckets",
] as const;

/** The kinds that are 1:1 per (project, environment). */
const SINGLETON_KINDS = [
	"network",
	"cluster",
	"dns",
	"observability",
	"repositories",
] as const;

// Called lazily, never at module scope. If the builder throws — the inexpressible-field case
// below — a module-scope call fails COLLECTION, and a file that fails to collect reports no test
// name at all. Every assertion here goes through this, so the throw lands on a named test.
const doc = () => componentSchemaDocument();

/** The published kind entry, or a failure naming the kind rather than a cryptic undefined. */
function publishedKind(kind: string) {
	const found = doc().kinds.find((k) => k.kind === kind);
	if (!found) throw new Error(`kind "${kind}" is not published`);
	return found;
}

/** The JSON Schema node for one field of one kind. */
function fieldNode(kind: string, field: string): Record<string, unknown> {
	const props = asRecord(publishedKind(kind).schema.properties);
	if (!(field in props)) {
		throw new Error(`field "${field}" is not published for kind "${kind}"`);
	}
	return asRecord(props[field]);
}

/** The `type` values a field node admits. A nullable column renders as
 *  `anyOf: [{type: T}, {type: "null"}]`, so the branches are flattened — this READS the emitted
 *  document, it does not recompute it. */
function typesOf(kind: string, field: string): string[] {
	const node = fieldNode(kind, field);
	const branches = Array.isArray(node.anyOf) ? node.anyOf : [node];
	return branches.map((b) => String(asRecord(b).type));
}

/** The non-null branch of a nullable field node (where `minimum`/`items` live). */
function valueBranch(kind: string, field: string): Record<string, unknown> {
	const node = fieldNode(kind, field);
	const branches = Array.isArray(node.anyOf) ? node.anyOf : [node];
	const value = branches.map(asRecord).find((b) => b.type !== "null");
	if (!value) throw new Error(`"${kind}.${field}" publishes no non-null branch`);
	return value;
}

// THE pre-deploy guard for a field `z.toJSONSchema` cannot express. `unrepresentable` is left at
// throw so such a field can never publish as an empty, accepts-everything node — but the builder is
// reached only through a memo, so on its own that throw would first surface as a 500 on the first
// request in PRODUCTION.
//
// The reachable case, verified rather than supposed: a timestamp column is `z.date()` to drizzle-zod,
// and `created_at` / `updated_at` sit one line away in every pick-list in the registry. Adding
// `created_at: true` to cluster's `.pick({…})` is green under `tsc --noEmit`, `eslint` and
// `next build`, and dies here with "Date cannot be represented in JSON Schema".
//
// This test is what makes that change red in CI instead. It is named and separate rather than left
// implicit in the assertions below, because "some other test happens to call the builder" is a
// guard nobody can find when it fires.
describe("representability", () => {
	it("expresses every published kind as JSON Schema", () => {
		expect(() => componentSchemaDocument()).not.toThrow();
	});
});

describe("the published kind census", () => {
	it("publishes every authorable kind, in registry order", () => {
		expect(doc().kinds.map((k) => k.kind)).toEqual([...PUBLISHED_KINDS]);
	});

	// The drift this lane exists to remove, named rather than implied. `helm_registries` is in the
	// server registry and is NOT in the Go literal, so `alethia project component kinds` omits a
	// kind the server will happily author — a fork that has already diverged, not one that might.
	it("publishes helm_registries, which the CLI's hardcoded list omits", () => {
		expect(doc().kinds.map((k) => k.kind)).toContain("helm_registries");
	});

	it("publishes the cardinality the CLI hardcodes as singletonKinds", () => {
		const singletons = doc().kinds
			.filter((k) => k.singleton)
			.map((k) => k.kind);
		expect(singletons).toEqual([...SINGLETON_KINDS]);
	});

	it("publishes every remaining kind as multi", () => {
		const multi = doc().kinds.filter((k) => !k.singleton).map((k) => k.kind);
		expect(multi).toEqual(
			PUBLISHED_KINDS.filter(
				(k) => !SINGLETON_KINDS.includes(k as (typeof SINGLETON_KINDS)[number]),
			),
		);
	});
});

// The `--set` split-brain: coercion runs in Go against raw flag text (`coerceSetValue` JSON-decodes
// it with no idea what the field is), validation runs here. Each case below is a field where the
// published type is the thing that resolves it.
describe("--set field types travel with the field name", () => {
	// The case that is broken TODAY: `--set cluster_version=1.35` JSON-decodes to the number 1.35
	// and the server refuses it against a text() column, so the documented answer is to quote it.
	// A client holding this node coerces to a string because the FIELD is a string.
	it("types cluster_version as a string, never a number", () => {
		expect(typesOf("cluster", "cluster_version")).toEqual(["string", "null"]);
	});

	it("types databases.port as an integer", () => {
		expect(typesOf("databases", "port")).toEqual(["integer", "null"]);
	});

	it("types databases.iam_auth as a boolean", () => {
		expect(typesOf("databases", "iam_auth")).toEqual(["boolean", "null"]);
	});

	it("types cluster.instance_types as an array of strings", () => {
		expect(typesOf("cluster", "instance_types")).toEqual(["array", "null"]);
		expect(asRecord(valueBranch("cluster", "instance_types").items).type).toBe(
			"string",
		);
	});

	// clusterNodeSizingBounds lives in the console's form schema and is IMPORTED by the registry.
	// Publishing it is what lets a client refuse `node_min_size=-4` without a round trip — Go has
	// no idea this bound exists.
	it.each(["node_min_size", "node_max_size", "node_desired_size"])(
		"publishes the 1..100 sizing bound on cluster.%s",
		(field) => {
			const branch = valueBranch("cluster", field);
			expect(branch.minimum).toBe(1);
			expect(branch.maximum).toBe(100);
		},
	);

	// The published document is deliberately a SUPERSET of what the server accepts, never a subset:
	// apps_path's mirrored grammar (traversal, quotes, whitespace) is not expressible in JSON
	// Schema, so the node says only "string". A client validating against it can therefore refuse
	// only values the server would also refuse — it can never reject something the server accepts.
	it("publishes apps_path as a plain string — the grammar stays server-side", () => {
		expect(typesOf("repositories", "apps_path")).toEqual(["string", "null"]);
		expect(validateComponentFields("repositories", { apps_path: "../../etc" }).ok).toBe(
			false,
		);
	});
});

// The published `fields` list is what a client offers for `--set`; the enforcing validator is
// validateComponentFields. If they disagree, the client offers a field the server refuses (or
// hides one it accepts) — which is the fork in a new place. Driven off the GOLDEN list so a shrunk
// registry cannot make this pass by iterating nothing.
describe.each(PUBLISHED_KINDS)("%s", (kind) => {
	it("publishes exactly the field set the write path accepts", () => {
		const published = publishedKind(kind).fields;
		expect(published.length).toBeGreaterThan(0);

		const rejected = validateComponentFields(kind, { __not_a_field__: 1 });
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		const allowed = rejected.error.split("Allowed: ")[1]?.split(", ") ?? [];
		expect(allowed).toEqual(published);
	});
});

describe("assertComponentSchemaPublishable", () => {
	it("passes the real document", () => {
		expect(() => assertComponentSchemaPublishable(doc().kinds)).not.toThrow();
	});

	// A zero census must FAIL, not read as "no problems found": a client caching an empty document
	// refuses every --kind the server would have accepted.
	it("refuses a document with zero kinds", () => {
		expect(() => assertComponentSchemaPublishable([])).toThrow(/ZERO kinds/);
	});

	// The per-kind vacuity: `properties` came back empty, so the client is told nothing is settable
	// on a kind where everything is.
	it("refuses a kind that publishes no settable fields, naming it", () => {
		expect(() =>
			assertComponentSchemaPublishable([
				{
					kind: "cluster",
					singleton: true,
					fields: [],
					schema: { type: "object", properties: {} },
				},
			]),
		).toThrow(/cluster/);
	});
});

describe("the wire contract", () => {
	// cliJson parses the payload before sending, so this is what stands between a vacuous document
	// and a 200 carrying it: an empty `kinds` is a 500, not a small answer.
	it("refuses a zero-kind document at the wire", () => {
		expect(componentSchemaWire.safeParse({ version: "v", kinds: [] }).success).toBe(
			false,
		);
	});

	it("accepts the real document, serialized exactly as the route sends it", () => {
		const wire: unknown = JSON.parse(JSON.stringify(doc()));
		expect(componentSchemaWire.safeParse(wire).success).toBe(true);
	});

	// The version is the cache key, so it has to be stable across calls within a deployment —
	// that is what is asserted here. Its sensitivity to a registry change comes from being a
	// sha256 over `kinds` (see buildComponentSchemaDocument); it is not claimed below.
	it("serves a stable content hash as the version", () => {
		expect(doc().version).toMatch(/^[0-9a-f]{64}$/);
		expect(componentSchemaDocument().version).toBe(doc().version);
	});
});
