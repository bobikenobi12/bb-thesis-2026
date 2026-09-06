// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Config-carriage guard: a value the product COLLECTS must reach the plan, or be recorded as a
// decision. This is the sibling of check-offer-parity, and the difference between them is the unit.
//
// check-offer-parity measures an OFFER — a choice the canvas presents (an engine, a switch) — and
// asks whether every cloud can build it. Its surface is `type: "switch"` fields, seventeen of them.
// That leaves every SCALAR, LIST, STRING and NUMBER knob the product collects completely unguarded,
// and two defects of exactly that class were found by accident while doing something else:
//
//   · #1981  `project_caches.allowed_cidr_blocks`. The inspector collects it, the CLI sets it, and
//            the AWS template is fully wired — `redis_allowed_cidr_blocks` is declared, threaded and
//            consumed by the ElastiCache security group. What breaks the chain is ONE LINE OF GO:
//            `ProjectCacheConfig` has no `AllowedCidrBlocks` field, so `json.Unmarshal` drops the key
//            and the provider hardcodes an empty list. A customer types a CIDR allow-list, it saves
//            cleanly, and the cache is provisioned wide open. Silent, and security-relevant.
//   · #1982  `project_nosql_tables.global_replicas`. Same shape: collected, stored, unmodelled,
//            never emitted into `ddb_global_table_configuration`.
//
// Neither is visible to a guard whose vocabulary is switches, and neither would have been visible to
// a grep either — the AWS template mentions `redis_allowed_cidr_blocks` in three files. So this asks
// the chain, hop by hop, and reports the FIRST hop that breaks:
//
//   HOP 1 · TYPE      does `packages/core/types/project_config.go` model a `json:` key equal to this
//                     column? If not, the value is dropped by `json.Unmarshal` on EVERY cloud, and
//                     the failure is reported ONCE — it is a fact about the contract, not about a
//                     cloud, and five identical lines would read as five defects.
//   HOP 2 · CARRIER   does anything reachable from `(*<cloud>Provider).ProviderTfvars` read the Go
//                     field and emit a tfvars key? (`lib/go-tfvars-trace.mjs`, the same call-graph
//                     trace check-offer-parity uses — a per-file grep is wrong in both directions.)
//   HOP 3 · TEMPLATE  is the resulting ROOT key declared by the cloud's root template AND read by a
//                     resource or module argument? (`lib/tf-wiring.mjs`.)
//
// BOTH SIDES ARE DERIVED. The field surface is recomputed every run from the drizzle schema, the
// canvas inspector, the CLI registry and the Go structs; a hand-list would drift exactly the way the
// thing it guards drifted. The tripwires below fail LOUDLY if that derivation collapses, because a
// guard that reads nothing reports everything clean.
//
// ── TWO THINGS THIS DELIBERATELY DOES NOT FLAG, both learned by getting them wrong ──────────────
//
//  1. PASSTHROUGH IS NOT A GAP — read precisely. `mergeProviderConfig` copies keys out of a
//     component's `provider_config` JSONB onto same-named tofu variables. Its scope is DERIVED below
//     (`PASSTHROUGH`) rather than asserted, and today it covers databases, cluster and DNS — not
//     every kind, and not every cloud for those (Hetzner merges cluster only). What it does is make
//     an ALREADY-DECLARED variable reachable by hand. It does NOT carry a typed column: this guard's
//     unit is a COLUMN's value, and no amount of passthrough moves `caches.allowed_cidr_blocks` into
//     tfvars when no Go field holds it. So passthrough is reported as context on a finding — "a user
//     could still reach this by hand" — and NEVER suppresses one. Using it to excuse a hop-3 failure
//     would be reading check-offer-parity's rule off by one hop: there the unit is a tofu VARIABLE,
//     here it is the value the product collected.
//  2. A `validation { contains([…]) }` BLOCK IS NOT EVIDENCE. It states what input a variable
//     accepts; it builds nothing. That is precisely what made Azure MySQL read as supported to
//     anyone skimming the template. `tf-wiring.mjs` excludes `variable`, `output` and `check` blocks
//     from its consumer set for this reason, and `selfCheck()` below pins it on a fixture rather
//     than trusting the prose — an unpinned assumption about someone else's reader is how this class
//     of guard goes quietly wrong.
//
// ── AND WHAT IT DECLINES TO ACCUSE, stated up front ─────────────────────────────────────────────
//
// EVIDENCE BEFORE ACCUSATION, twice over, because the alternative is a wall of false debt and a
// guard nobody leaves switched on:
//
//   · a field NO cloud carries into tofu is not a per-cloud gap. `services.replicas` is rendered
//     into a Kubernetes Deployment, `repositories.apps_path` into an ArgoCD Application — neither is
//     OpenTofu's business, and the cross-cloud rule has nothing to say about them. They are listed
//     every run under "not carried by OpenTofu anywhere" rather than silently dropped.
//   · a (kind, cloud) the cloud does not provision through tofu at all is not measured for that
//     kind's fields. Hetzner runs Postgres in-cluster via CloudNativePG; accusing it of dropping
//     `backup_retention_days` would board thirty entries restating one architectural fact that
//     infra/offer-exclusions.yaml already records at the engine level.
//
// A field whose canvas gate this guard cannot READ is held to hop 1 (which is cloud-independent) and
// released from the per-cloud rule, WITH ITS NAME PRINTED every run. Skipping it silently is how
// "add a gate" becomes a way to delete a field from the vocabulary — the hole #1802 closed for
// switches by generating the offer surface. The same fix applies here and is the intended next step;
// until then the skip is loud.
//
// Decisions live in infra/config-carriage-exclusions.yaml — deliberately NOT offer-exclusions.yaml.
// See that file's header for why.
//
// Run from apps/console (`pnpm -C apps/console run check:config-carriage`). `--matrix` additionally writes the
// living board to docs/testing/config-carriage.md; it is the same measurement, so a matrix write can
// never suppress a finding.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	assertParsed as assertGoStructsParsed,
	elementType,
	jsonTagsOf,
	readGoStructs,
	selfCheck as goStructsSelfCheck,
} from "./lib/go-structs.mjs";
import {
	assertParsed as assertGoTraceParsed,
	keysDerivedFrom,
	reachableFrom,
	readGoPackage,
	rootKeyForBuilder,
	selfCheck as goTraceSelfCheck,
	traceField,
} from "./lib/go-tfvars-trace.mjs";
import {
	assertParsed as assertTfWiringParsed,
	readTfWiring,
	selfCheck as tfWiringSelfCheck,
} from "./lib/tf-wiring.mjs";

// Before anything is measured, prove the readers still read. Each pins itself against a fixture in
// BOTH directions — a reader that sees nothing and a reader that sees everything are equally silent
// here, and only one of them is loud on its own.
goTraceSelfCheck();
tfWiringSelfCheck();
goStructsSelfCheck();

const ROOT = "../..";
const TEMPLATES = `${ROOT}/infra/templates/project`;
const PROVIDERS = `${ROOT}/packages/core/cloud`;
const TYPES = `${ROOT}/packages/core/types/project_config.go`;
const EXCLUSIONS = `${ROOT}/infra/config-carriage-exclusions.yaml`;
const MATRIX_OUT = `${ROOT}/docs/testing/config-carriage.md`;
const DB_SCHEMA = "lib/db/schema/project-components.ts";
const INSPECTOR = "components/design-project/canvas/inspector/config-schema.ts";
const NODE_REGISTRY = "components/design-project/canvas/graph/node-registry.ts";
const CLI_REGISTRY = "lib/cli/project-components.ts";

const writeMatrix = process.argv.includes("--matrix");

// The column surface this guard is expected to see. #1974's survey counted 318 columns across the
// component tables by hand; this reader walks the whole schema module, so it sees more. The floor is
// a TRIPWIRE, not a target: a regex that stops matching after a formatting change would otherwise
// shrink the surface to nothing and report a clean build on an empty set.
const COLUMNS_FLOOR = 313;
// Likewise for the measured half. Chosen well under today's count so ordinary schema churn does not
// trip it, and well over zero so a broken join between the four sources does.
const FIELDS_FLOOR = 60;

/** Compare two user-facing reasons for MEANING, not layout — the yaml wraps, the report does not. */
const normalizeReason = (s) => (s ?? "").replace(/\s+/g, " ").trim();

// ── helpers ─────────────────────────────────────────────────────────────────────────

/** Strip `#` and `//` line comments, so a COMMENTED-OUT declaration never counts as one.
 * That distinction is the entire #1981 signature on the Go side and it matters here too. */
function stripLineComments(src, both) {
	const rx = both ? /(^|\s)(#|\/\/).*$/ : /(^|\s)\/\/.*$/;
	return src
		.split("\n")
		.map((l) => l.replace(rx, ""))
		.join("\n");
}

/** The `{ … }` block starting at or after `from`, brace-matched, WITHOUT its outer braces.
 * Brace-matched rather than regex-delimited because every body read here nests. */
function bracedAt(src, from) {
	const open = src.indexOf("{", from);
	if (open === -1) return "";
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
	}
	return "";
}

/** Every .tf file under a directory, recursively, comments stripped, WITH its path — the shape
 * `readTfWiring` wants, and the path is load-bearing there (a root tfvar is a promise only the root
 * module can make). */
function readTfFiles(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === ".terraform") continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) out.push(...readTfFiles(full));
		else if (e.name.endsWith(".tf")) out.push({ path: full, text: stripLineComments(readFileSync(full, "utf8"), true) });
	}
	return out;
}

// ── the field surface, part 1: the columns ──────────────────────────────────────────

const dbSrc = stripLineComments(readFileSync(DB_SCHEMA, "utf8"), false);

/** Every `pgTable("<name>", { … })` in the component schema module, with its column names.
 *
 * The whole module, not a curated list of tables: a table nobody claims (project_changes) simply
 * produces no user-settable column and drops out by the same rule that drops `status`. Curating here
 * would be the hand-list this guard exists to avoid, one level up. */
function readTables(src) {
	const out = [];
	for (const m of src.matchAll(/pgTable\(\s*"([a-z0-9_]+)"\s*,/g)) {
		const body = bracedAt(src, m.index + m[0].length);
		out.push({ table: m[1], cols: [...body.matchAll(/(?:^|\n)\t\t([a-z0-9_]+):/g)].map((c) => c[1]) });
	}
	return out;
}

const TABLES = readTables(dbSrc);
const COLUMNS_EXAMINED = TABLES.reduce((a, t) => a + t.cols.length, 0);
if (COLUMNS_EXAMINED < COLUMNS_FLOOR) {
	throw new Error(
		`config-carriage read ${COLUMNS_EXAMINED} columns from ${DB_SCHEMA}, below the ${COLUMNS_FLOOR} floor. ` +
			"The schema reader has stopped matching (formatting change, moved tables) — it is not that the " +
			"product lost its configuration. A guard measuring an empty surface reports success on nothing.",
	);
}

// ── the field surface, part 2: which columns a USER sets ────────────────────────────

const cliSrc = stripLineComments(readFileSync(CLI_REGISTRY, "utf8"), false);

/** Columns the CLI wire never carries as config — read from the CLI's own `WIRE_EXCLUDE`.
 *
 * Read rather than restated: this set is the CLI's own answer to "which columns are server-managed",
 * and a second copy here would be a second definition of the same rule, drifting on its own schedule.
 * It is also what keeps `name` out of the surface, which is not cosmetic — the carrier trace matches
 * on a Go FIELD NAME, and `.Name` is read by a dozen builders across every kind, so measuring it
 * would credit every kind on every cloud with carriage it does not have. */
const wireExclude = new Set(
	[...(cliSrc.slice(cliSrc.indexOf("const WIRE_EXCLUDE")).match(/\[([\s\S]*?)\]/)?.[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]),
);
if (wireExclude.size === 0) {
	throw new Error(
		`config-carriage could not read WIRE_EXCLUDE from ${CLI_REGISTRY}. Without it every server-managed ` +
			"column enters the surface, `name` most of all — and the carrier trace matches on a Go FIELD NAME, so " +
			"`.Name` would credit every kind on every cloud with carriage it does not have.",
	);
}
/** The dedicated (non-config) wire fields, from `interface ComponentWire`. A column in BOTH sets is
 * server-managed AND settable, which is a contradiction inside one file — reported, not assumed. */
const wireFields = new Set(
	[...bracedAt(cliSrc, cliSrc.indexOf("interface ComponentWire")).matchAll(/(?:^|\n)\t([a-z0-9_]+)[?]?:/g)].map((m) => m[1]),
);

/** The per-kind `--set` allow-lists, keyed by the CLI's kind name (which is the schema key). */
function readCliPicks(src) {
	const body = src.slice(src.indexOf("const KINDS: Record<string, KindDef>"));
	const kinds = [...body.matchAll(/\n\t(\w+): \{/g)];
	const out = {};
	for (let i = 0; i < kinds.length; i++) {
		const seg = body.slice(kinds[i].index, kinds[i + 1]?.index ?? body.length);
		const at = seg.indexOf(".pick(");
		if (at === -1) continue;
		out[kinds[i][1]] = new Set([...bracedAt(seg, at).matchAll(/([a-z0-9_]+):\s*true/g)].map((m) => m[1]));
	}
	return out;
}

const CLI_PICKS = readCliPicks(cliSrc);

/** Canvas node kind → the ProjectFormData key its config lands under (`nosql` → `nosql_tables`).
 *
 * The join between the canvas's vocabulary and everything else's. It is declared once, in the node
 * registry's `schemaKey`, and reading it there is what keeps this guard reading the same source the
 * product reads — the rule the offer guard learned when a deleted `HETZNER_VARIANT_VALUES` left it
 * passing while measuring the wrong thing. */
function readSchemaKeys() {
	const src = stripLineComments(readFileSync(NODE_REGISTRY, "utf8"), false);
	const body = src.slice(src.indexOf("export const NODE_REGISTRY"));
	const kinds = [...body.matchAll(/\n\t(\w+): \{/g)];
	const out = {};
	for (let i = 0; i < kinds.length; i++) {
		const seg = body.slice(kinds[i].index, kinds[i + 1]?.index ?? body.length);
		const k = seg.match(/schemaKey:\s*"([a-z_]+)"/);
		if (k) out[kinds[i][1]] = k[1];
	}
	return out;
}

const SCHEMA_KEY = readSchemaKeys();

/**
 * Every field the canvas inspector collects, per component kind, with its `visibleWhen` source text.
 *
 * The gate is captured as TEXT and evaluated (statically, and only in the shapes below) rather than
 * ignored, because ignoring it accuses a cloud of dropping a field the canvas never showed there —
 * and treating any gate as a skip lets "add a gate" delete a field from the vocabulary, which is the
 * hole #1802 closed for switches. Fields are sliced key-to-key: `key` is the first property of every
 * field object in CONFIG_SCHEMA, so a slice is that field's own properties.
 */
function readInspectorFields() {
	const src = stripLineComments(readFileSync(INSPECTOR, "utf8"), false);
	const body = src.slice(src.indexOf("export const CONFIG_SCHEMA"));
	const kinds = [...body.matchAll(/\n\t(\w+): \{/g)];
	const out = {};
	for (let i = 0; i < kinds.length; i++) {
		const schemaKey = SCHEMA_KEY[kinds[i][1]];
		if (!schemaKey) continue;
		const seg = body.slice(kinds[i].index, kinds[i + 1]?.index ?? body.length);
		const keys = [...seg.matchAll(/\bkey:\s*"([a-z0-9_]+)"/g)];
		const map = (out[schemaKey] ??= new Map());
		for (let j = 0; j < keys.length; j++) {
			const own = seg.slice(keys[j].index, keys[j + 1]?.index ?? seg.length);
			const g = own.match(/visibleWhen:\s*(\([^)]*\))\s*=>\s*([\s\S]*?)(?=\n\t+\w+:|\n\t+\},)/);
			// A gate that does not take the CONTEXT's `provider` is not a cloud gate at all — the
			// service ones (`c.source.kind === "repo"`, `!isPluggable(c.provider)`) gate on sibling
			// config, and reading them as cloud gates would silently narrow the surface.
			const cloudGate = g && /\{[^}]*\bprovider\b/.test(g[1]) ? g[2].trim().replace(/,$/, "") : null;
			if (!map.has(keys[j][1]) || cloudGate) map.set(keys[j][1], cloudGate);
		}
	}
	return out;
}

const INSPECTOR_FIELDS = readInspectorFields();

/**
 * The clouds a gate leaves the field offered on, or null when the gate cannot be read.
 *
 * Two shapes are readable and they are the two the schema uses — `provider !== "x"` and
 * `provider === "x"`. Anything else (`NOSQL[provider].supportsRangeKey !== false`) is a table lookup
 * this text reader must not pretend to evaluate: guessing "offered everywhere" manufactures gaps on
 * clouds whose table model has no range key, and guessing "offered nowhere" deletes the field. So it
 * returns null and the caller reports the field by name instead of judging it.
 */
function gateClouds(gate, clouds) {
	if (!gate) return clouds;
	const ne = gate.match(/^provider\s*!==\s*"(\w+)"$/);
	if (ne) return clouds.filter((c) => c !== ne[1]);
	const eq = gate.match(/^provider\s*===\s*"(\w+)"$/);
	if (eq) return clouds.filter((c) => c === eq[1]);
	return null;
}

// ── the field surface, part 3: the Go contract ──────────────────────────────────────

const STRUCTS = readGoStructs(readFileSync(TYPES, "utf8"));
assertGoStructsParsed(STRUCTS, "ProjectConfig");

/** Component kind → the Go struct that models it, joined on `ProjectConfig`'s own json tags.
 *
 * `Databases []ProjectDatabaseConfig \`json:"databases"\`` — the tag IS the schema key, which is the
 * table name minus its prefix, which is the CLI kind. One join key across four files, declared in
 * each of them, and none of them restated here. The singular fallback covers `iac_sources` (table)
 * vs `iac_source` (tag), the one place the four spellings disagree. */
/** Component kind → the Go struct modelling it; the singular fallback covers `iac_sources`. */
const STRUCT_FOR = {};
for (const f of STRUCTS.get("ProjectConfig") ?? []) {
	if (f.tag && f.tag !== "-") STRUCT_FOR[f.tag] = elementType(f.type);
}
const structForKind = (kind) => STRUCT_FOR[kind] ?? STRUCT_FOR[kind.replace(/s$/, "")] ?? null;

/** The json keys carried by `Placement`, the struct embedded in nearly every component config.
 *
 * Excluded from the surface by construction. Placement is not a resource KNOB: it names which cloud
 * account and region the resource is placed on, and the provisioner resolves it into provider
 * configuration long before any per-resource tfvar exists. Measuring it would ask every kind on every
 * cloud whether `cloud_identity_id` becomes a tfvars key, and the answer is always no and always
 * uninteresting. Derived from the struct rather than listed, so adding a placement field cannot
 * quietly add fifteen false gaps. */
const PLACEMENT_KEYS = new Set(jsonTagsOf(STRUCTS, "Placement").keys());

// ── the clouds ──────────────────────────────────────────────────────────────────────

/** Every cloud that ships a provisioning template. `local` is one of them and has no Go provider —
 * see PROVIDER_CLOUDS. */
const TEMPLATE_CLOUDS = readdirSync(TEMPLATES, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.sort();

const GO_PKG = readGoPackage(PROVIDERS);
assertGoTraceParsed(GO_PKG);

/** The clouds a carrier question can be ASKED of: those with a `(*<x>Provider).ProviderTfvars`.
 *
 * `infra/templates/project/local` is a kind cluster for development with five .tf files and no Go
 * provider at all. `traceField` reports `entryMissing` there, which reads identically to "carries
 * nothing" — so a guard that does not split them manufactures a whole column of false gaps. */
const PROVIDER_CLOUDS = TEMPLATE_CLOUDS.filter((c) => !traceField(GO_PKG, c, "AlethiaProbeField").entryMissing);

const tfFiles = Object.fromEntries(PROVIDER_CLOUDS.map((c) => [c, readTfFiles(`${TEMPLATES}/${c}`)]));
const TF_WIRING = Object.fromEntries(
	PROVIDER_CLOUDS.map((c) => {
		const w = readTfWiring(tfFiles[c], `${TEMPLATES}/${c}`);
		assertTfWiringParsed(c, w);
		return [c, w];
	}),
);

/**
 * The kinds each cloud's provider hands to `mergeProviderConfig`, derived from the call sites.
 *
 * NOT taken on trust, because the claim "passthrough covers databases, cluster and DNS" is exactly
 * the kind of remembered fact that goes stale: Hetzner merges only the cluster's, and a guard that
 * printed the remembered scope would tell a reader something false about a cloud. The argument is
 * either `config.<Field>.ProviderConfig` (resolved through ProjectConfig's own json tag) or a local
 * (`db.ProviderConfig`), resolved by finding the nearest preceding binding of that name to a
 * `config.<Field>` — which is `db := config.Databases[0]` on three clouds and a `range` on others,
 * so the match is on the BINDING, not on the loop keyword. Anything else is left UNRESOLVED and
 * printed — this only ever adds context to a finding, never removes one, so an unread call site
 * cannot hide a gap.
 */
function readPassthrough() {
	const byCloud = {};
	const unresolved = [];
	const fieldTag = new Map();
	for (const f of STRUCTS.get("ProjectConfig") ?? []) if (f.name && f.tag) fieldTag.set(f.name, f.tag);
	for (const cloud of PROVIDER_CLOUDS) {
		const kinds = (byCloud[cloud] = new Set());
		for (const key of reachableFrom(GO_PKG, `${cloud}Provider.ProviderTfvars`)) {
			const { body } = GO_PKG.funcs.get(key);
			for (const m of body.matchAll(/mergeProviderConfig\(\s*\w+\s*,\s*([\w.]+)\.ProviderConfig/g)) {
				const direct = m[1].match(/^config\.(\w+)$/);
				if (direct && fieldTag.has(direct[1])) {
					kinds.add(fieldTag.get(direct[1]));
					continue;
				}
				// The nearest binding of that name BEFORE the call — nearest, because one body can hold
				// several, and the first one would attribute the databases passthrough to whichever
				// collection happens to be looped first.
				const bind = [...body.slice(0, m.index).matchAll(new RegExp(`\\b${m[1]}\\s*:=\\s*[^\\n]*config\\.(\\w+)`, "g"))].pop();
				if (bind && fieldTag.has(bind[1])) {
					kinds.add(fieldTag.get(bind[1]));
					continue;
				}
				unresolved.push({ cloud, expr: m[1] });
			}
		}
	}
	return { byCloud, unresolved };
}

const PASSTHROUGH = readPassthrough();

// ── the field surface, assembled ────────────────────────────────────────────────────

/**
 * Every user-settable field: a column the canvas inspector collects or the CLI can `--set`.
 *
 * The inspector's key is not always a column — `node_size_vcpu` and `node_size_memory` are two
 * controls over one jsonb column, `probe_enabled` and `probe_port` over one `probe`. So a key
 * resolves to the column it names exactly, or to the longest column it prefixes with `_`. Exact
 * first, or `engine_version` would credit `engine`.
 */
function buildFieldSurface() {
	const out = [];
	const contradictions = [];
	for (const t of TABLES) {
		const kind = t.table.startsWith("project_") ? t.table.slice("project_".length) : t.table;
		const inspector = INSPECTOR_FIELDS[kind] ?? new Map();
		const cli = CLI_PICKS[kind] ?? new Set();
		const resolved = new Map();
		for (const [key, gate] of inspector) {
			let col = t.cols.includes(key) ? key : null;
			if (!col) for (const c of t.cols) if (key.startsWith(`${c}_`) && (!col || c.length > col.length)) col = c;
			if (col && (!resolved.has(col) || gate)) resolved.set(col, gate);
		}
		const struct = structForKind(kind);
		const tags = struct ? jsonTagsOf(STRUCTS, struct) : new Map();
		for (const col of t.cols) {
			const inCli = cli.has(col);
			// A column the CLI both declares server-managed and lets a caller set is a contradiction
			// inside one file: the value is accepted, stored, and overwritten by the deploy's own
			// write-back. `repository_url` is the live one — see the report block.
			if (inCli && wireExclude.has(col) && !wireFields.has(col)) contradictions.push({ kind, col });
			if (wireExclude.has(col) || col === "environment_id") continue;
			if (PLACEMENT_KEYS.has(col)) continue;
			const inInspector = resolved.has(col);
			if (!inInspector && !inCli) continue;
			const gate = resolved.get(col) ?? null;
			out.push({
				kind,
				col,
				id: `${kind}.${col}`,
				struct,
				goField: tags.get(col)?.field ?? null,
				inInspector,
				inCli,
				gate,
				offeredOn: gateClouds(gate, PROVIDER_CLOUDS),
			});
		}
	}
	return { fields: out, contradictions };
}

const { fields: FIELDS, contradictions: WIRE_CONTRADICTIONS } = buildFieldSurface();
if (FIELDS.length < FIELDS_FLOOR) {
	throw new Error(
		`config-carriage derived ${FIELDS.length} user-settable fields, below the ${FIELDS_FLOOR} floor. ` +
			"One of the four sources stopped joining (schema / node-registry `schemaKey` / CONFIG_SCHEMA / " +
			"the CLI pick-lists). A guard measuring an empty surface reports success on nothing.",
	);
}

// ── HOP 2 · the carrier, traced rather than grepped ─────────────────────────────────

/**
 * Which component structs own each Go field NAME — the ambiguity this hop has to resolve.
 *
 * `traceField` asks a package-wide text question: does any reachable body contain `.EngineVersion`?
 * That is the right question for a boolean switch whose name appears once in the tree, which is what
 * `check-offer-parity` traces. It is the WRONG question here, because a config-carriage surface is
 * every scalar on every kind, and a Go field name is only unique within its struct:
 *
 *     ProjectDatabaseConfig.EngineVersion   ProjectCacheConfig.EngineVersion
 *
 * Both read `.EngineVersion`, so an unscoped trace grades ONE cell on the OTHER's carriage, and it is
 * wrong in both directions at once. Measured on azure: `databases.engine_version` was reported
 * `unwired-template` because it inherited the cache's `azure_cache_redis_version` (declared, read by
 * nothing) — while the database version it actually becomes, `azure_db_engine_version`, is consumed
 * at azure-db.tf:13. The same substitution on aws ran the other way: the cache's
 * `redis_engine_version` IS wired, so the database cell would have read `ok` on evidence belonging to
 * a different resource. A guard that files a defect against a working path and passes an unmeasured
 * one is worse than no guard, so the receiver is resolved rather than assumed.
 */
const FIELD_OWNERS = new Map();
for (const [struct, fields] of STRUCTS) {
	if (!/^Project\w+Config$/.test(struct)) continue;
	for (const f of fields) {
		if (!f.name) continue;
		if (!FIELD_OWNERS.has(f.name)) FIELD_OWNERS.set(f.name, new Set());
		FIELD_OWNERS.get(f.name).add(struct);
	}
}
/** Field names more than one component struct declares — the only ones scoping has to adjudicate. */
const AMBIGUOUS_FIELDS = new Set([...FIELD_OWNERS].filter(([, s]) => s.size > 1).map(([n]) => n));

/** `ProjectConfig`'s own field name → the component struct it holds: `Databases` → `ProjectDatabaseConfig`. */
const STRUCT_BY_CONFIG_FIELD = new Map();
for (const f of STRUCTS.get("ProjectConfig") ?? []) if (f.name) STRUCT_BY_CONFIG_FIELD.set(f.name, elementType(f.type));

/**
 * Parameter name → component struct, per function — the second way a body names one of these.
 *
 * `resolveDBEngine(provider string, db types.ProjectDatabaseConfig)` binds `db` by SIGNATURE, and the
 * package index deliberately keeps only bodies (`lib/go-tfvars-trace.mjs` indexes what it traces), so
 * the signature is read here from the file the function came from. Only `Project…Config` parameters
 * are recorded; nothing else can be a receiver for a field on this surface.
 */
const PARAM_STRUCTS = new Map();
for (const entry of readdirSync(PROVIDERS, { withFileTypes: true })) {
	if (!entry.isFile() || !entry.name.endsWith(".go") || entry.name.endsWith("_test.go")) continue;
	const src = stripLineComments(readFileSync(join(PROVIDERS, entry.name), "utf8"), false);
	for (const m of src.matchAll(/\nfunc\s+(?:\(\s*\w+\s+\*?(\w+)\s*\)\s*)?(\w+)\s*\(([^)]*)\)/g)) {
		const key = m[1] ? `${m[1]}.${m[2]}` : m[2];
		const params = new Map();
		for (const p of m[3].split(",")) {
			const g = p.trim().match(/^(\w+)\s+\[?\]?\*?(?:types\.)?(Project\w+Config)$/);
			if (g) params.set(g[1], g[2]);
		}
		if (params.size) PARAM_STRUCTS.set(key, params);
	}
}

/**
 * The component struct an identifier denotes inside one function body, or null when unresolvable.
 *
 * Three bindings, which are the three the providers write:
 *   · `config.Caches[0]`                  — the collection itself, resolved through `ProjectConfig`
 *   · `cache := config.Caches[0]`, `for _, b := range config.Buckets` — the NEAREST preceding bind,
 *     because one body holds several and the first would attribute every kind to whichever is looped
 *     first
 *   · a signature parameter (`PARAM_STRUCTS`)
 */
function receiverStruct(fnKey, body, upto, expr) {
	const params = PARAM_STRUCTS.get(fnKey);
	/** One resolution step: a `config.<Field>` collection, or a name the signature types. */
	const resolve = (e) => {
		const direct = e.match(/^config\.(\w+)/);
		if (direct) return STRUCT_BY_CONFIG_FIELD.get(direct[1]) ?? null;
		const n = e.match(/^(\w+)/)?.[1];
		return (n && params?.get(n)) ?? null;
	};
	const own = resolve(expr);
	if (own) return own;
	const name = expr.match(/^(\w+)/)?.[1];
	if (!name) return null;
	// The NEAREST preceding bind, `:=` or `range`, one hop back. One hop is enough for every shape
	// the providers write — `db := config.Databases[0]`, and `for _, s := range secrets` inside a
	// builder whose SIGNATURE types `secrets` — and stopping there keeps an unresolvable chain
	// unresolvable rather than guessing along it.
	const bind = [...body.slice(0, upto).matchAll(new RegExp(`\\b${name}\\s*:?=\\s*(?:range\\s+)?([\\w.]+)`, "g"))].pop();
	return bind ? resolve(bind[1]) : null;
}

/** Reads of an ambiguous field whose receiver could not be bound to a kind. Collected, never
 * defaulted: crediting one invents carriage, dropping one invents a gap, so the run says so. */
const UNSCOPED_READS = [];

/**
 * The body as it reads for ONE struct: every `<x>.<field>` belonging to a DIFFERENT component struct
 * renamed out of the way, so the taint analysis below cannot pick it up.
 *
 * A rewrite rather than a filter on the resulting sites, because the taint is transitive: the key is
 * routinely written by a later line than the read (`if cache.EngineVersion != "" { tfvars[…] = … }`),
 * and by then the only thing connecting them is the local the branch tainted. Removing the read is
 * the only way to remove everything downstream of it.
 */
function scopedBody(fnKey, fn, struct, goField) {
	if (!AMBIGUOUS_FIELDS.has(goField)) return fn.body;
	return fn.body.replace(new RegExp(`([A-Za-z_][\\w.]*(?:\\[[^\\]]*\\])?)\\.${goField}\\b`, "g"), (whole, expr, at) => {
		const owner = receiverStruct(fnKey, fn.body, at, expr);
		if (owner === struct) return whole;
		if (owner === null) {
			UNSCOPED_READS.push({ fn: fn.name, file: fn.file, expr, goField });
			return whole; // loud, not silent — reported, never quietly decided either way
		}
		return `${expr}.${goField}_NOT_${struct}`;
	});
}

const traceCache = new Map();

/** Trace one component's Go field on one cloud through the provider call graph, memoized.
 *
 * Mirrors `traceField` exactly — same reachability, same taint, same root recovery — with the one
 * difference this surface needs: each body is read AS THIS STRUCT first. An unambiguous field takes
 * the identity rewrite, so nothing about the shared reading changes for it. */
function trace(cloud, struct, goField) {
	const id = `${cloud}:${struct}:${goField}`;
	if (traceCache.has(id)) return traceCache.get(id);
	const entry = `${cloud}Provider.ProviderTfvars`;
	let result;
	if (!GO_PKG.funcs.has(entry)) {
		result = { carried: false, sites: [], entryMissing: true };
	} else if (!AMBIGUOUS_FIELDS.has(goField)) {
		result = traceField(GO_PKG, cloud, goField);
	} else {
		const reachable = reachableFrom(GO_PKG, entry);
		const rx = new RegExp(`\\.${goField}\\b`);
		const sites = [];
		for (const key of reachable) {
			const fn = GO_PKG.funcs.get(key);
			if (!rx.test(fn.body)) continue;
			const body = scopedBody(key, fn, struct, goField);
			if (!rx.test(body)) continue;
			const isEntry = key === entry;
			const root = isEntry ? null : rootKeyForBuilder(GO_PKG, reachable, fn.name);
			for (const [k, strength] of keysDerivedFrom(body, goField)) {
				sites.push({ fn: fn.name, file: fn.file, key: k, root: isEntry ? k : root, strength });
			}
		}
		result = { carried: sites.length > 0, sites, entryMissing: false };
	}
	traceCache.set(id, result);
	return result;
}

const readsCache = new Map();

/**
 * Does ANY function reachable from this cloud's `ProviderTfvars` so much as mention the field?
 *
 * The difference between "dropped" and "the guard cannot follow it" — and it is a real difference,
 * not a hedge. `resolveCacheNodeType` reads `.MemoryGB` and `.NodeType` and RETURNS a SKU; the tfvars
 * key is written by its caller, in a body that never names either field. The taint analysis is
 * within-body by design, so it correctly attributes no key — and reporting that as `no-carrier` would
 * file debt against four working cloud-indifferent sizing paths.
 *
 * This is deliberately the WEAKEST evidence in the file. It proves the value is read, never that it
 * decides anything, so it is its own state (`carried-indirect`), it is NOT counted as measured for
 * the ratchet, and every such cell is printed. "The guard declined to decide" must never be filed as
 * "the guard found nothing wrong".
 */
function readsFieldSomewhere(cloud, struct, goField) {
	const id = `${cloud}:${struct}:${goField}`;
	if (!readsCache.has(id)) {
		const entry = `${cloud}Provider.ProviderTfvars`;
		const rx = new RegExp(`\\.${goField}\\b`);
		let found = false;
		for (const key of reachableFrom(GO_PKG, entry)) {
			const fn = GO_PKG.funcs.get(key);
			// Scoped for the same reason the trace is: `resolveDBEngine` reads the DATABASE's
			// `EngineVersion`, and reading that as evidence about the CACHE's would answer "the guard
			// cannot follow it" for a cell where nothing reads the value at all.
			if (rx.test(fn.body) && rx.test(scopedBody(key, fn, struct, goField))) {
				found = true;
				break;
			}
		}
		readsCache.set(id, found);
	}
	return readsCache.get(id);
}

// ── HOP 3 · the template ────────────────────────────────────────────────────────────

/**
 * The ROOT tfvar behind a key the provider wrote into a LOCAL MAP inside `ProviderTfvars` itself.
 *
 * `traceField` reports `root === key` for any key written in the entry function, because from inside
 * that body the two are indistinguishable — and for these they are not the same thing at all. AWS
 * builds `rdsConfig` and `scalingConfig` as locals and assigns them to `tfvars["rds_config"]` /
 * `tfvars["rds_scaling_config"]`, so `db_port` is an ATTRIBUTE of a root tfvar, not a root tfvar. Ask
 * `hasRootVariable("db_port")` and the answer is no, and the guard files a false accusation against a
 * value the template reads on the next line — which is how a guard gets switched off.
 *
 * Recovered from the entry body: each `tfvars["<root>"] = <local>` names a root, and the keys of that
 * local (its literal, plus any `<local>["k"] = …` writes) are its attributes.
 */
function entryLocalRoots(cloud) {
	// `interface{}` and `struct{}` are blanked to a SAME-LENGTH filler before any brace matching:
	// `map[string]interface{}{` otherwise ends the literal at the `{` of `interface{`, and every key
	// declared in the map literal (rather than written by index afterwards) is lost. That is not a
	// hypothetical — it is why `db_port` read as a root tfvar and AWS was accused of dropping a port
	// the module reads on the next line.
	const body = (GO_PKG.funcs.get(`${cloud}Provider.ProviderTfvars`)?.body ?? "")
		.replace(/interface\{\}/g, "interface..")
		.replace(/struct\{\}/g, "struct..");
	const out = new Map();
	for (const m of body.matchAll(/tfvars\["([a-z0-9_]+)"\]\s*=\s*(\w+)\s*$/gm)) {
		const [, root, local] = m;
		const keys = new Set();
		const decl = body.match(new RegExp(`\\b${local}\\s*:?=\\s*map\\[string\\][^{]*\\{`));
		if (decl) for (const k of bracedAt(body, decl.index).matchAll(/"([a-z0-9_]+)"\s*:/g)) keys.add(k[1]);
		for (const k of body.matchAll(new RegExp(`\\b${local}\\["([a-z0-9_]+)"\\]\\s*=`, "g"))) keys.add(k[1]);
		for (const k of keys) if (!out.has(k)) out.set(k, root);
	}
	return out;
}

const ENTRY_LOCAL_ROOTS = Object.fromEntries(PROVIDER_CLOUDS.map((c) => [c, entryLocalRoots(c)]));

/** Every .tf line of a cloud, joined — for the one question `tf-wiring` cannot be asked. */
const tfText = Object.fromEntries(PROVIDER_CLOUDS.map((c) => [c, tfFiles[c].map((f) => f.text).join("\n")]));

/**
 * Does an `output` block report this root tfvar back out of the template?
 *
 * `tf-wiring` deliberately excludes `output` from its consumer set, and for the OFFER guard that is
 * right: an offer echoed to an output was never built. Carriage asks a different question — did the
 * value the user typed have an effect — and on this platform an output IS an effect, because the
 * binding layer reads template outputs.
 *
 * Hetzner's DNS is the worked example. When you supply a zone you already own, the template
 * deliberately creates NOTHING (`hcloud_zone.this` is counted off) and reports your id straight
 * through: `dns_zone_id = length(hcloud_zone.this) > 0 ? … : var.dns_hosted_zone`
 * (hetzner/outputs.tf:33), which the template's own README calls out as the design — one name for the
 * rest of the platform whichever branch ran. No resource argument reads it and none should; treating
 * that as a drop would demand a resource whose whole point is not to exist.
 *
 * Kept narrow on purpose: this only rescues a site the value-site rule below would otherwise call
 * broken. It is not a general consumer, and it cannot make an unread variable look built.
 */
function reportedAsOutputIn(text, root) {
	if (!root) return false;
	const re = new RegExp(`\\boutput\\s+"[^"]*"\\s*\\{[^}]*\\bvar\\.${root}\\b`, "s");
	return re.test(text ?? "");
}

/** The live caller: the same question, asked of one cloud's joined `.tf` text. */
function reportedAsOutput(cloud, root) {
	return reportedAsOutputIn(tfText[cloud] ?? "", root);
}

/**
 * Is this root tfvar handed WHOLE to a resource or module argument under a DIFFERENT name?
 *
 * The one shape a per-attribute read test gets wrong. `serverlessv2_scaling_configuration =
 * var.rds_scaling_config` delivers every attribute of the object, so `min_capacity` arrives even
 * though the template never names it — and `isReadOnChain` correctly finds no read, because there is
 * none to find.
 *
 * A DIFFERENT name is load-bearing and is not a formality: `bucket_configuration =
 * var.bucket_configuration` is a module THREADING hop, not a consumption, and crediting it would mark
 * every attribute of every threaded object as honored — laundering exactly the defect GCP shipped when
 * `uniform_access` was declared, filled in on every apply, and the bucket resource hardcoded `true`.
 * The rename is what distinguishes "handed to something that uses it" from "passed along". A module
 * argument that renames would slip through; that direction is quieter, never noisier.
 */
function passedWholeToArgument(cloud, root) {
	return new RegExp(`^\\s*(?!for_each|count|depends_on)(\\w+)\\s*=\\s*var\\.${root}\\s*$`, "m").test(
		tfText[cloud].replace(new RegExp(`^\\s*${root}\\s*=\\s*var\\.${root}\\s*$`, "gm"), ""),
	);
}

/**
 * Does this tfvars key survive into the plan on this cloud?
 *
 * Verbatim the idiom `check-offer-parity.evaluateWiring` uses, and mirrored rather than rewritten so
 * the two guards cannot disagree about one template. A ROOT key must be declared BY THE ROOT module
 * (OpenTofu silently drops a tfvars value whose variable the root never declared, so a submodule
 * declaring the same name vouches for nothing) and read as `var.<key>`. A NESTED key is one attribute
 * of one entry of a list-of-objects: "declared" means the object type names it anywhere on the chain,
 * "read" means some argument reaches for it.
 *
 * `variable`, `output` and `check` blocks are not consumers — `tf-wiring.mjs` excludes them, which is
 * what keeps a `validation { contains([…]) }` block from reading as an implementation.
 */
function evaluateWiring(cloud, site) {
	const w = TF_WIRING[cloud];
	// A key the entry function wrote into a local map is an ATTRIBUTE, not a root — recovered here so
	// the nested branch below asks the question that has an answer. Only consulted when the key is not
	// a root variable in its own right, so a genuine root is never re-attributed.
	const recovered = site.root === site.key && !w.hasRootVariable(site.key) ? ENTRY_LOCAL_ROOTS[cloud].get(site.key) : undefined;
	const root = recovered ?? site.root;
	const nested = root !== null && root !== site.key;
	if (!nested) {
		const declared = w.hasRootVariable(site.key);
		const read = w.isReadOnChain(site.key, site.key, true);
		return { ok: declared && read, declared, read, shapeKnown: true, rootMissing: false, root };
	}
	const shape = w.shapeIsDeclared(root);
	const declared = w.isDeclared(site.key);
	const read = w.isReadOnChain(root, site.key) || passedWholeToArgument(cloud, root);
	return {
		ok: shape !== null && read && (declared || shape === false),
		declared,
		read,
		shapeKnown: shape === true,
		rootMissing: shape === null,
		root,
	};
}

// ── the guard's own self-check ──────────────────────────────────────────────────────

/**
 * Pin the two readings this guard adds on top of the shared libraries, in both directions.
 *
 * The gate evaluator, because a mis-read gate silently narrows or widens the accused set; and the
 * NON-RULE that a `validation` block is not an implementation, because that one is an assumption
 * about SOMEONE ELSE'S reader. Asserting it against a fixture here means a change to tf-wiring's
 * consumer set fails this guard loudly instead of quietly making Azure MySQL read as supported.
 */
function selfCheck() {
	const fail = (why) => {
		throw new Error(`check-config-carriage self-check failed: ${why}. Do not trust this run.`);
	};
	const clouds = ["alibaba", "aws", "azure", "gcp", "hetzner"];
	if (gateClouds(null, clouds).length !== 5) fail("an ungated field must be offered on every cloud");
	if (gateClouds('provider !== "hetzner"', clouds).join() !== "alibaba,aws,azure,gcp") fail("misread a `!==` gate");
	if (gateClouds('provider === "hetzner"', clouds).join() !== "hetzner") fail("misread an `===` gate");
	// The unreadable shape must come back NULL rather than being guessed either way. Guessing
	// "everywhere" manufactures gaps on clouds whose table model has no range key; guessing "nowhere"
	// deletes the field from the surface.
	if (gateClouds("!provider || NOSQL[provider].supportsRangeKey !== false", clouds) !== null) {
		fail("evaluated a gate it cannot read instead of declining");
	}

	// A variable referenced ONLY by its own `validation` block, and by an `output`, is not read by
	// anything that builds — the Azure MySQL shape.
	const fixture = [
		{
			path: "/fixture/variables.tf",
			text: 'variable "engine" {\n  type = string\n  validation {\n    condition = contains(["postgres", "mysql"], var.engine)\n    error_message = "no"\n  }\n}\nvariable "used" {\n  type = string\n}\noutput "e" {\n  value = var.engine\n}\n',
		},
		{ path: "/fixture/main.tf", text: 'resource "x" "y" {\n  name = var.used\n}\n' },
	];
	const w = readTfWiring(fixture, "/fixture");
	if (!w.hasRootVariable("engine")) fail("did not see a declared root variable");
	if (w.isReadOnChain("engine", "engine", true)) fail("a `validation` + `output` reference read as an implementation");
	if (!w.isReadOnChain("used", "used", true)) fail("a real resource argument did not read as a read");

	// ── receiver scoping, in BOTH directions ────────────────────────────────────────
	//
	// The shape is the live one, reduced: two structs declaring `EngineVersion`, bound by the two
	// bindings the providers actually write (a local from `config.<Kind>`, and a typed parameter),
	// each writing a DIFFERENT key. Both directions are asserted because each failure is silent on
	// its own — a scoper that keeps everything restores the cross-kind verdict this exists to stop,
	// and one that keeps nothing turns every ambiguous field into a wall of `no-carrier`.
	if (!AMBIGUOUS_FIELDS.has("EngineVersion")) {
		fail("`EngineVersion` is declared by both the database and the cache config and did not read as ambiguous");
	}
	if (AMBIGUOUS_FIELDS.has("MultiAz")) fail("a field only one struct declares read as ambiguous");
	const fn = {
		name: "ProviderTfvars",
		file: "/fixture/x_provider.go",
		body: [
			"db := config.Databases[0]",
			'tfvars["db_version"] = db.EngineVersion',
			"cache := config.Caches[0]",
			'tfvars["cache_version"] = cache.EngineVersion',
		].join("\n"),
	};
	const asCache = keysDerivedFrom(scopedBody("k", fn, "ProjectCacheConfig", "EngineVersion"), "EngineVersion");
	if (asCache.has("db_version")) fail("scoped as the cache and still credited the DATABASE's key — the live #1981-class misread");
	if (!asCache.has("cache_version")) fail("scoped as the cache and dropped the cache's own key");
	const asDb = keysDerivedFrom(scopedBody("k", fn, "ProjectDatabaseConfig", "EngineVersion"), "EngineVersion");
	if (asDb.has("cache_version")) fail("scoped as the database and still credited the CACHE's key");
	if (!asDb.has("db_version")) fail("scoped as the database and dropped the database's own key");
	// A read this reader cannot bind must be KEPT and reported, never silently dropped: dropping it
	// invents a gap, and inventing gaps is how a guard gets switched off.
	const before = UNSCOPED_READS.length;
	const loose = { name: "helper", file: "/fixture/x_provider.go", body: 'tfvars["k"] = whatever.EngineVersion' };
	if (!keysDerivedFrom(scopedBody("nosuchfunc", loose, "ProjectCacheConfig", "EngineVersion"), "EngineVersion").has("k")) {
		fail("dropped a read whose receiver it could not resolve instead of keeping it and reporting it");
	}
	if (UNSCOPED_READS.length !== before + 1) fail("an unresolvable receiver was decided silently — nothing was recorded to print");
	UNSCOPED_READS.length = before;

	// ── the output-passthrough rescue, in BOTH directions ───────────────────────────
	//
	// This is the one exemption the value-site rule grants, and an exemption nobody pins is how a
	// narrow rescue quietly becomes a general escape. It shipped without this pin; that was the gap.
	//
	// Direction 1 — a root an `output` reports back out is NOT a drop. Hetzner returns the zone you
	// already own that way and deliberately creates no resource, so demanding a resource argument
	// would demand one whose whole point is not to exist.
	// Direction 2 — everything else. A root mentioned in a `locals`, in a `resource`, in a comment,
	// or nowhere at all must NOT be rescued, or the rule stops measuring anything.
	const outFixture =
		'output "zone" {\n  value = var.reported_zone\n}\n' +
		'locals {\n  x = var.only_in_locals\n}\n' +
		'resource "r" "s" {\n  a = var.only_in_resource\n}\n' +
		"# var.only_in_a_comment\n";
	if (!reportedAsOutputIn(outFixture, "reported_zone")) fail("an `output` that reports a root did not read as reported");
	if (reportedAsOutputIn(outFixture, "only_in_locals")) fail("a `locals` reference read as an output — the rescue is not narrow");
	if (reportedAsOutputIn(outFixture, "only_in_resource")) fail("a `resource` argument read as an output — the rescue is not narrow");
	if (reportedAsOutputIn(outFixture, "only_in_a_comment")) fail("a comment read as an output");
	if (reportedAsOutputIn(outFixture, "absent")) fail("a root mentioned nowhere read as reported");
	// A PREFIX must not match: `var.reported_zone_id` is a different variable, and crediting it would
	// rescue a genuinely dropped value whose name happens to extend a reported one.
	if (reportedAsOutputIn('output "z" {\n  value = var.reported_zone_id\n}\n', "reported_zone")) {
		fail("a longer variable name matched as a prefix — a dropped value would be rescued by its neighbour");
	}
	if (reportedAsOutputIn(outFixture, "")) fail("an empty root read as reported");
}

selfCheck();

// ── decisions ───────────────────────────────────────────────────────────────────────

/** Minimal reader for the flat `- field: … cloud: … reason: …` list (no YAML dep in this package —
 * the worktrees this runs in are de-hydrated, and `node scripts/…mjs` must work on builtins). */
function readDecisions() {
	if (!existsSync(EXCLUSIONS)) return [];
	const out = [];
	let cur = null;
	let section = "exclusions";
	for (const raw of readFileSync(EXCLUSIONS, "utf8").split("\n")) {
		// Only FULL-LINE comments are stripped. An inline strip would eat the `#` of `issue: "#1981"`
		// and silently drop every tracking link — the matrix would print a bare 🚫 with nowhere to go.
		if (/^\s*#/.test(raw)) continue;
		const line = raw.trimEnd();
		if (!line.trim()) continue;
		const head = line.match(/^(exclusions|baseline|wired|carried_in_cluster):\s*$/);
		if (head) {
			if (cur) {
				out.push(cur);
				cur = null;
			}
			section = head[1];
			continue;
		}
		const start = line.match(/^\s*-\s+(\w+):\s*(.+)$/);
		if (start) {
			if (cur) out.push(cur);
			cur = { section, [start[1]]: start[2].trim().replace(/^["']|["']$/g, "") };
			continue;
		}
		const kv = line.match(/^\s+(\w+):\s*(.+)$/);
		if (kv && cur) cur[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
	}
	if (cur) out.push(cur);
	return out;
}

const allEntries = readDecisions();
const exclusions = allEntries.filter((e) => e.section === "exclusions");
const baseline = allEntries.filter((e) => e.section === "baseline");
const wired = allEntries.filter((e) => e.section === "wired");
const carriedInCluster = allEntries.filter((e) => e.section === "carried_in_cluster");

/** Does this entry cover this cell? `cloud: "*"` covers every cloud, including the `*` a hop-1
 * (contract-level) cell is recorded against — which is why a hop-1 decision MUST be written `*`: a
 * single-cloud entry cannot discharge a break that happens on all of them. */
const matches = (e, field, cloud) => e.field === field && (e.cloud === cloud || e.cloud === "*");
/** The recorded EXCLUSION for this cell — the cloud has been decided never to honor the value. */
const excludedBy = (field, cloud) => exclusions.find((e) => matches(e, field, cloud));
/** The recorded BASELINE entry — boarded debt that does not fail the build. */
const baselinedBy = (field, cloud) => baseline.find((e) => matches(e, field, cloud));
/** The recorded `wired:` acknowledgement — a branch-guard wiring a person has read. */
const wiredBy = (field, cloud) => wired.find((e) => matches(e, field, cloud));
/** The recorded in-cluster carriage claim, if one is declared for this cell. */
const inClusterBy = (field, cloud) => carriedInCluster.find((e) => matches(e, field, cloud));

/**
 * Re-read a `carried_in_cluster:` entry's claim against the source that owns it.
 *
 * The claim is "this value IS honored, by a component the platform installs into the cluster" — which
 * hop 3 structurally cannot see, because an in-cluster component writes no tfvar. What makes that a
 * ratchet rather than a mute button is that the entry names where the value is read, and this re-reads
 * it every run: delete the read in `hetzner-services.ts` and the entry goes stale, exactly as a
 * baseline entry does when its gap is fixed. #1864 is the cautionary case — `exclusions:` was the one
 * claim nothing re-read, so any measured gap could be discharged by RECLASSIFYING it, green either way.
 *
 * Two evidence forms, at least one required:
 *   · `reads:`     a token that must appear in `source:` — the read itself. Required when the entry
 *                  covers `cloud: "*"`, where a per-cloud map has nothing to say.
 *   · `predicate:` a Go `map[string]…` whose KEYS are the clouds the component ships for; the entry
 *                  survives only while the map still lists this cloud.
 *
 * All failure modes are failures, including "I could not check": a missing file, a missing symbol and
 * an unnamed source all return `{ok:false}`, because otherwise unreadable would silently mean fine.
 */
function verifyInClusterCarriage(entry, cloud) {
	const { source, reads, predicate } = entry;
	if (!source) return { ok: false, why: "the entry names no `source:`, so nothing re-reads it" };
	if (!reads && !predicate) {
		return { ok: false, why: "the entry names neither `reads:` nor `predicate:` — there is nothing here to re-read" };
	}
	if (cloud === "*" && !reads) {
		return { ok: false, why: "a `cloud: \"*\"` entry needs `reads:` — a per-cloud predicate cannot answer for every cloud" };
	}
	const path = `${ROOT}/${source}`;
	if (!existsSync(path)) return { ok: false, why: `\`source: ${source}\` does not exist` };
	const text = readFileSync(path, "utf8");
	if (reads) {
		// Comments stripped: a read that survives only in a comment is not a read, which is the same
		// rule the Go struct reader applies to a commented-out field (#1981's shape).
		if (!stripLineComments(text, true).includes(reads)) {
			return { ok: false, why: `\`${reads}\` no longer appears in ${source} — nothing reads the value there` };
		}
	}
	if (predicate) {
		const m = text.match(new RegExp(`\\b${predicate}\\s*=\\s*map\\[string\\][^{]*\\{([\\s\\S]*?)\\n\\}`));
		if (!m) return { ok: false, why: `\`${predicate}\` is not a top-level \`map[string]…\` literal in ${source}` };
		const keys = new Set([...m[1].matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)].filter((k) => k[2] !== "").map((k) => k[1]));
		if (cloud !== "*" && !keys.has(cloud)) {
			return {
				ok: false,
				why: `\`${predicate}\` in ${source} no longer lists \`${cloud}\` (it has: ${[...keys].join(", ") || "nothing"}), so nothing installs the component that was said to carry this value`,
			};
		}
	}
	return { ok: true };
}

// States in which the value demonstrably does NOT reach the plan. A cell in one of these fails the
// build unless the yaml records a decision about it.
//
// `dropped-by-type` leads the list because it is the exact defect this guard was built for, and it is
// the only one that is a fact about the CONTRACT rather than about a cloud: no field, no key, no
// cloud. It is recorded once, against `cloud: "*"`.
const GAP_STATES = new Set(["dropped-by-type", "no-carrier", "unwired-template"]);

// The finding shape for a ⚠️ cell nobody has decided about — deliberately not a STATE. The cell's
// state is `gated-carrier` either way; what fails is the absence of a declaration. Keeping the two
// apart is what lets the glyph and the ratchet keep reading one state while the build fails on the
// other (#1829/#1830).
const UNDECLARED_GATED = "undeclared-gated-carrier";

// Unhonored = every gap, plus `gated-carrier`. A ⚠️ cell is not an accusation — a text reader cannot
// tell whether the key a branch writes IS this value — but it is not honoring either, so it keeps a
// baseline entry alive rather than reading as a fix.
const UNHONORED_STATES = new Set([...GAP_STATES, "gated-carrier"]);

// States in which the guard reached a VERDICT. `not-offered`, `not-provisioned`, `excluded` and
// `carried-indirect` are all deliberately absent: in the first three the guard declined to look, and
// in the fourth it looked and could not decide. "Looked and found nothing wrong" is a different fact
// from "did not look", and collapsing them is how a baseline entry for a live gap gets deleted by a
// green build (#1830).
const MEASURED_STATES = new Set(["ok", "carried-in-cluster", ...UNHONORED_STATES]);

const measuredCells = [];
const unhonoredCells = [];
const excludedMeasured = [];
const inClusterMeasured = [];

/**
 * File a cell's verdict for the ratchet, and hand back its baseline entry if it has one.
 *
 * One helper for both passes rather than the condition written out twice, because the ratchet is
 * exactly as good as its most forgetful caller: a pass that records nothing is a pass whose every
 * baseline entry reads as fixed, and that failure is silent and congratulatory.
 */
function recordVerdict(field, cloud, state) {
	if (MEASURED_STATES.has(state)) measuredCells.push({ field, cloud, state });
	if (!UNHONORED_STATES.has(state)) return null;
	unhonoredCells.push({ field, cloud, state });
	return baselinedBy(field, cloud);
}

// ── the run ─────────────────────────────────────────────────────────────────────────

const findings = [];
const knownDebt = [];
const cells = [];
const typeCells = [];
const indirectCells = [];
const unmeasurableShapes = [];
const ungatedByReader = [];

// HOP 1, first and once. It is a fact about the config-snapshot contract, so it has no cloud axis:
// `json.Unmarshal` drops an unmodelled key on every cloud identically, and printing that five times
// would read as five defects with five fixes instead of one line of Go.
for (const f of FIELDS) {
	if (f.goField) continue;
	const detail = f.struct
		? `the product collects \`${f.col}\` (${[f.inInspector && "canvas", f.inCli && "CLI"].filter(Boolean).join(" + ")}) and ` +
			`\`${f.struct}\` models no \`json:"${f.col}"\` field, so \`json.Unmarshal\` drops it on the way to the ` +
			`runner. It saves cleanly, the plan is identical, and nothing anywhere reports it.`
		: `the product collects \`${f.col}\`, and no struct in ${TYPES} models the \`${f.kind}\` kind at all — ` +
			`the whole component is absent from the config-snapshot contract.`;
	const ic = inClusterBy(f.id, "*");
	if (ic) {
		const v = verifyInClusterCarriage(ic, "*");
		inClusterMeasured.push({ field: f.id, cloud: "*", entry: ic, verdict: v, alsoCarried: false });
		typeCells.push({ field: f, state: "carried-in-cluster", detail: ic.reason ?? "", by: ic.by ?? "" });
		recordVerdict(f.id, "*", "carried-in-cluster");
		continue;
	}
	const exc = excludedBy(f.id, "*");
	if (exc) {
		excludedMeasured.push({ field: f.id, cloud: "*", honoredNow: false, entry: exc });
		typeCells.push({ field: f, state: "excluded", detail: exc.reason ?? "" });
		continue;
	}
	const known = recordVerdict(f.id, "*", "dropped-by-type");
	typeCells.push({ field: f, state: "dropped-by-type", detail, known });
	if (known) knownDebt.push({ shape: "dropped-by-type", cloud: "*", field: f.id, detail, known });
	else findings.push({ shape: "dropped-by-type", cloud: "*", field: f.id, detail, known: null });
}

// HOP 2 and HOP 3, per cloud, for every field the contract does model.
//
// Ordered so the first broken hop is the one reported: a field with no Go carrier is not also
// accused of an unwired template, because the template question has no answer until something emits
// a key for it to answer about.
const modelled = FIELDS.filter((f) => f.goField);

/** Verdict for one (field, cloud) — the raw measurement, before any decision is applied. */
function measure(f, cloud) {
	const t = trace(cloud, f.struct, f.goField);
	if (!t.carried) {
		if (readsFieldSomewhere(cloud, f.struct, f.goField)) {
			return {
				state: "carried-indirect",
				detail:
					`the ${cloud} provider READS \`${f.goField}\`, but in a function that writes no tfvars key ` +
					`(a resolver returning a SKU, typically) — so this guard cannot follow the value to the key it ` +
					`becomes. Not a gap and not a pass: nothing here establishes that the value decides anything.`,
			};
		}
		return {
			state: "no-carrier",
			detail:
				`the product collects \`${f.col}\` and nothing reachable from \`(*${cloud}Provider).ProviderTfvars\` ` +
				`reads \`${f.goField}\` — the value never becomes a tfvar, so a user sets it and the plan is ` +
				`identical either way.`,
		};
	}
	const verdicts = t.sites.map((s) => ({ site: s, ...evaluateWiring(cloud, s) }));
	const ok = verdicts.filter((v) => v.ok);
	// EVERY value-carrying site must be wired, not just one of them.
	//
	// A provider commonly derives two keys from one field: the VALUE, and a `create_x`/`enable_x`
	// predicate meaning only "was it set". Both come back as `derived` sites. Scoring the cell on the
	// first one that happens to pass lets the predicate vouch for the value — delete the sole consumer
	// of `dns_hosted_zone` on aws and `cloud_dns_enabled` still reads wired, so the zone id a user
	// typed is carried into tfvars and dropped one line before the plan while the board says 🟡.
	//
	// That is #1981's shape wearing a disguise, and it is a hole in exactly the defect this guard
	// exists to find — the azure `dns.zone_id` gap (#1992) is the same break, and would have been
	// invisible here on any cloud whose provider also emits a predicate. So a broken value site is
	// decisive even when a sibling site passes.
	//
	// SCOPED TO THE ROOT, deliberately. A field's sites are often ATTRIBUTES of one root object —
	// `allowed_origins` lives inside `cors_configuration`, and the template consumes the object whole,
	// so the attribute rides in with it. Only a broken site whose ROOT no passing site shares is a
	// real drop; without that scoping this rule reports every object attribute as unwired, which is
	// how a guard earns its way into someone's ignore list.
	const okRoots = new Set(ok.map((v) => v.root ?? v.site.root ?? v.site.key));
	const derivedBroken = verdicts.filter(
		(v) =>
			!v.ok &&
			v.site.strength === "derived" &&
			!okRoots.has(v.root ?? v.site.root ?? v.site.key) &&
			!reportedAsOutput(cloud, v.root ?? v.site.root ?? v.site.key),
	);
	const honored = derivedBroken.length === 0 ? ok.find((v) => v.site.strength === "derived") : undefined;
	const chosen = honored ?? ok[0];
	// Reported by the CELL loop, not here: `measure` runs for every cloud, including ones the cell is
	// later found not to be offered on, and a note about a cell nobody is judging is noise in a report
	// whose whole job is that every line means something.
	const shapeNote =
		chosen && !chosen.shapeKnown
			? `\`${chosen.root}\` is typed \`any\` — the template declares no fields, so whether ` +
				`\`${chosen.site.key}\` is an accepted key cannot be read from it. Judged on the resource argument ` +
				`that reads it, which is the only half that IS measurable here.`
			: null;
	if (honored) return { state: "ok", detail: "", shapeNote, sites: ok.map((v) => v.site) };
	// A value site that breaks is reported even when a sibling site passes — and the message says so,
	// because "some of it is wired" is the thing that makes this class hard to see by hand.
	if (derivedBroken.length) {
		const broke = derivedBroken.map((x) => `\`${x.site.key}\``).join("/");
		const alsoOk = ok.filter((v) => !derivedBroken.includes(v));
		return {
			state: "unwired-template",
			detail:
				`the ${cloud} provider carries \`${f.col}\` into tfvars as ${broke}, and no resource or module ` +
				`argument in the template reads it — the value is dropped one hop before the plan` +
				(alsoOk.length
					? `. ${alsoOk.map((v) => `\`${v.site.key}\``).join("/")} IS wired, which is what hides this: ` +
						`a key derived from the same field is honored, so the cell looks carried while the value ` +
						`itself is discarded.`
					: "."),
			shapeNote,
			sites: verdicts.map((x) => x.site),
		};
	}
	if (ok.length) {
		return {
			state: "gated-carrier",
			detail:
				`the ${cloud} provider only ever writes ${ok.map((v) => `\`${v.site.key}\``).join("/")} INSIDE an ` +
				`\`if <${f.goField}>\` branch, never as the value itself. That establishes the value decides whether ` +
				`the key appears; it does not establish that the key IS this setting, and a text reader cannot tell ` +
				`those apart. Confirm by inspection, or assign the value so the wiring proves itself.`,
			shapeNote,
			sites: ok.map((v) => v.site),
		};
	}
	const v = verdicts[0];
	const carriedAs = verdicts.map((x) => `\`${x.site.key}\``).join("/");
	return {
		state: "unwired-template",
		detail: v.rootMissing
			? `the ${cloud} provider emits ${carriedAs} inside \`${v.root}\`, which the ${cloud} template does ` +
				`not declare at all — tofu never sees the value.`
			: v.read
				? `${carriedAs} is read by the ${cloud} template but declared nowhere in the shape it arrives in — ` +
					`the value is silently defaulted away.`
				: `the ${cloud} provider carries \`${f.col}\` into tfvars as ${carriedAs}` +
					`${v.root && v.root !== v.site.key ? ` (on \`${v.root}\`)` : ""}, and no resource or ` +
					`module argument in the template reads it. Declared${v.declared ? "" : " nowhere"}, consumed by ` +
					`nothing: the value is dropped one hop before the plan.`,
		shapeNote,
		sites: verdicts.map((x) => x.site),
	};
}

const raw = new Map();
for (const f of modelled) {
	for (const cloud of PROVIDER_CLOUDS) raw.set(`${f.id}|${cloud}`, measure(f, cloud));
}

/** Fields with tofu carriage on at least one cloud — the only ones the cross-cloud rule can speak
 * about. A field NO cloud carries is carried by something else (a Kubernetes manifest, an ArgoCD
 * Application) or by nothing, and the second case is hop 1's to report, not this pass's. */
const CARRIED_SOMEWHERE = new Set(
	modelled.filter((f) => PROVIDER_CLOUDS.some((c) => ["ok", "unwired-template", "gated-carrier"].includes(raw.get(`${f.id}|${c}`).state))).map((f) => f.id),
);

/** (kind, cloud) pairs the cloud demonstrably provisions through tofu: some field of that kind
 * arrives honored there. The strongest available evidence, deliberately — a weaker test would credit
 * Hetzner with provisioning managed databases on the strength of a field name collision, and thirty
 * cells of architectural fact would be re-boarded here that offer-exclusions.yaml already records. */
const PROVISIONED = new Set();
for (const f of modelled) for (const c of PROVIDER_CLOUDS) if (raw.get(`${f.id}|${c}`).state === "ok") PROVISIONED.add(`${f.kind}|${c}`);

for (const f of modelled) {
	if (f.offeredOn === null) {
		ungatedByReader.push(f);
		continue;
	}
	for (const cloud of PROVIDER_CLOUDS) {
		const m = raw.get(`${f.id}|${cloud}`);
		// The three "declined to look" states, in the order that makes the report readable: a cell the
		// canvas never shows here, a kind this cloud does not provision at all, a field OpenTofu
		// carries nowhere. None is a verdict, and none is recorded as one.
		if (!f.offeredOn.includes(cloud)) {
			cells.push({ field: f, cloud, state: "not-offered", detail: "" });
			continue;
		}
		if (!CARRIED_SOMEWHERE.has(f.id) || !PROVISIONED.has(`${f.kind}|${cloud}`)) {
			cells.push({ field: f, cloud, state: "not-provisioned", detail: "" });
			continue;
		}
		if (m.shapeNote) unmeasurableShapes.push({ field: f.id, cloud, detail: m.shapeNote });
		if (m.state === "carried-indirect") {
			indirectCells.push({ field: f, cloud, detail: m.detail });
			cells.push({ field: f, cloud, state: "carried-indirect", detail: m.detail });
			continue;
		}

		// An in-cluster carriage claim is settled BEFORE the verdict is applied, because the trace can
		// only ever say "no carrier" about a component that writes no tfvar — an answer that is true
		// and useless. What IS checkable is the claim itself, so check that instead.
		const ic = inClusterBy(f.id, cloud);
		if (ic) {
			const v = verifyInClusterCarriage(ic, cloud);
			inClusterMeasured.push({ field: f.id, cloud, entry: ic, verdict: v, alsoCarried: m.state === "ok" });
			cells.push({ field: f, cloud, state: "carried-in-cluster", detail: ic.reason ?? "", by: ic.by ?? "" });
			recordVerdict(f.id, cloud, "carried-in-cluster");
			continue;
		}

		const exc = excludedBy(f.id, cloud);
		if (exc) {
			// An exclusion is a CLAIM, and until #1864 it was the one claim nothing re-read — so a
			// measured gap could be discharged by RECLASSIFYING it rather than fixing it, green either
			// way. The half a text reader CAN settle is settled here: is the value carried and derived
			// in our own code right now? If it is, the ceiling is false whatever the prose says.
			excludedMeasured.push({ field: f.id, cloud, honoredNow: m.state === "ok", entry: exc });
			cells.push({ field: f, cloud, state: "excluded", detail: exc.reason ?? "" });
			continue;
		}

		const known = recordVerdict(f.id, cloud, m.state);
		const ack = m.state === "gated-carrier" ? wiredBy(f.id, cloud) : null;
		cells.push({ field: f, cloud, state: m.state, detail: m.detail, known, ack });
		if (known) knownDebt.push({ shape: m.state, cloud, field: f.id, detail: m.detail, known });
		else if (GAP_STATES.has(m.state)) findings.push({ shape: m.state, cloud, field: f.id, detail: m.detail, known: null });
		else if (m.state === "gated-carrier" && !ack) {
			findings.push({ shape: UNDECLARED_GATED, cloud, field: f.id, detail: m.detail, known: null });
		}
	}
}

// A field that is measurable and produced ZERO cells has stopped being measured, and a measurement
// that quietly shrinks its own vocabulary reports success on less than it did yesterday. This is the
// same anti-silence rule check-offer-parity applies to an offer that loses its `offeredOn`.
for (const f of modelled) {
	if (f.offeredOn === null) continue;
	if (cells.some((c) => c.field.id === f.id)) continue;
	findings.push({
		shape: "unmeasured-field",
		cloud: "—",
		field: f.id,
		detail:
			"the contract models it and it produced ZERO cells this run — the carrier pass is no longer measuring " +
			"it and would go green whatever the clouds do. Usually the column was renamed on one side of the join " +
			"(schema / `schemaKey` / CONFIG_SCHEMA / the CLI pick-list) or its gate stopped being readable.",
		known: null,
	});
}

// ── the ratchet ─────────────────────────────────────────────────────────────────────

const GLYPH = {
	ok: "🟡",
	excluded: "—",
	"dropped-by-type": "🚫",
	"no-carrier": "🚫",
	"unwired-template": "🚫",
	// Its OWN glyph. Neither 🟡 nor 🚫 is true: the wiring exists, and whether it wires THIS value is
	// exactly what could not be established.
	"gated-carrier": "⚠️",
	"carried-in-cluster": "☸️",
	// Read, un-followable. Distinct from both a pass and a gap on purpose — see readsFieldSomewhere.
	"carried-indirect": "⚙️",
	"not-offered": "·",
	"not-provisioned": "·",
};

/** Every cell this run reached a verdict on that a baseline entry covers — "no gap found here" and
 * "nothing was looked at here" are different facts, and this is the half that tells them apart. */
const measuredFor = (b) => measuredCells.filter((c) => c.field === b.field && (b.cloud === "*" || c.cloud === b.cloud));
/** The unhonored states a baseline entry's cells actually reproduced this run. */
const reproducedStates = (b) => [
	...new Set(unhonoredCells.filter((c) => c.field === b.field && (b.cloud === "*" || c.cloud === b.cloud)).map((c) => c.state)),
];

/** Why a boarded cell produced no verdict this run — a FACT about the run, or "" when there is none.
 * Never a guess: a guessed cause reads as a diagnosis and sends someone to fix the wrong thing. */
function unmeasuredBecause(b) {
	const [kind] = b.field.split(".");
	if (!FIELDS.some((f) => f.id === b.field)) {
		return "no field by that name is in the derived surface at all — the column was renamed or dropped, or one of the four sources stopped naming it";
	}
	const f = FIELDS.find((x) => x.id === b.field);
	if (f.offeredOn === null) return "its canvas gate is no longer one this guard can read, so it is not held to the per-cloud rule";
	if (excludedBy(b.field, b.cloud)) return "the same cell is also listed under `exclusions:` — one cell cannot be both a permanent ceiling and boarded debt";
	if (!f.goField) return "the contract no longer models the column, so the cell is measured at hop 1 (`dropped-by-type`) instead";
	if (!CARRIED_SOMEWHERE.has(b.field)) return "no cloud carries the field into tofu any more, so it is not held to the cross-cloud rule";
	if (b.cloud !== "*" && !PROVISIONED.has(`${kind}|${b.cloud}`)) return `${b.cloud} no longer provisions any \`${kind}\` field through tofu`;
	return "";
}

const staleBaseline = [];
const unmeasuredBaseline = [];
const driftedBaseline = [];
const unstatedBaseline = [];
for (const b of baseline) {
	const states = reproducedStates(b);
	if (measuredFor(b).length === 0) unmeasuredBaseline.push({ entry: b, why: unmeasuredBecause(b) });
	else if (states.length === 0) staleBaseline.push(b);
	else if (!b.state) unstatedBaseline.push({ entry: b, states });
	else if (!states.includes(b.state)) driftedBaseline.push({ entry: b, states });
}

const staleWired = wired.filter((e) => {
	const reproduced = unhonoredCells.some((c) => c.field === e.field && (e.cloud === "*" || c.cloud === e.cloud) && c.state === "gated-carrier");
	return !reproduced;
});

const brokenInCluster = inClusterMeasured.filter((m) => !m.verdict.ok);
// A redundant claim is a wrong one: if OpenTofu carries and derives the value today, the entry credits
// the wrong mechanism in the matrix and would keep the cell green if the template carriage broke.
const redundantInCluster = inClusterMeasured.filter((m) => m.verdict.ok && m.alsoCarried);
const falseCeilings = excludedMeasured.filter((m) => m.honoredNow);
const doubleBooked = baseline.filter((b) => exclusions.some((e) => e.field === b.field && (e.cloud === b.cloud || e.cloud === "*" || b.cloud === "*")));
const baselineNoIssue = baseline.filter((b) => !b.issue);

// ── the matrix ──────────────────────────────────────────────────────────────────────

if (writeMatrix) {
	const KINDS = [...new Set(cells.map((c) => c.field.kind))].sort();
	const md = [];
	md.push("<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->");
	md.push("<!-- SPDX-License-Identifier: AGPL-3.0-only -->");
	md.push("<!-- GENERATED by apps/console/scripts/check-config-carriage.mjs --matrix — do not edit by hand. -->");
	md.push("");
	md.push("# Config carriage — does the value you typed reach the plan?");
	md.push("");
	md.push(
		"Every user-settable field the product collects, and what happens to its VALUE on each cloud. " +
			"The sibling board, [offer-parity.md](offer-parity.md), answers a different question: whether a " +
			"CHOICE the canvas offers is buildable. A choice can be buildable while the number beside it is " +
			"discarded, which is the class this board measures.",
	);
	md.push("");
	md.push("| Glyph | Meaning |");
	md.push("|---|---|");
	md.push("| 🟡 | the value reaches a resource argument — implemented, not yet proven on a real apply |");
	md.push("| 🚫 | collected and dropped: no field on the contract, no carrier, or a tfvar nothing reads |");
	md.push("| ⚠️ | carried only as a branch guard — the value decides whether a key appears, not what it says |");
	md.push("| ☸️ | honored, but by a component installed into the cluster rather than by OpenTofu |");
	md.push("| ⚙️ | read by the provider in a function that writes no key — the guard declines to decide |");
	md.push("| — | a documented decision: this cloud will not honor it |");
	md.push("| · | not offered here, or this cloud provisions none of this kind through OpenTofu |");
	md.push("");
	md.push(
		"A cell never goes ✅ from this generator. Proof of a real apply lives in the e2e ledger, and a " +
			"board that promoted its own measurement to proof would be marking its own homework.",
	);
	md.push("");

	md.push("## Hop 1 · the contract");
	md.push("");
	md.push(
		"Does `packages/core/types/project_config.go` model a `json:` key for the column? A field it does " +
			"not model is dropped by `json.Unmarshal` on every cloud at once — the value saves cleanly, the " +
			"plan is identical, and nothing reports it. This is #1981 and #1982's shape, so it is asked first " +
			"and answered once.",
	);
	md.push("");
	if (typeCells.length === 0) {
		md.push("Every user-settable column is modelled by the contract.");
	} else {
		md.push("| Field | State | Note |");
		md.push("|---|:---:|---|");
		for (const t of typeCells.sort((a, b) => a.field.id.localeCompare(b.field.id))) {
			const issue = t.known?.issue ?? "";
			md.push(`| \`${t.field.id}\` | ${GLYPH[t.state]}${issue ? ` ${issue}` : ""} | ${t.detail.replace(/\|/g, "\\|")} |`);
		}
	}
	md.push("");

	md.push("## Hop 2 + 3 · carriage, per cloud");
	md.push("");
	md.push(
		"For a modelled field: does the cloud's provider turn it into a tfvars key (hop 2), and does the " +
			"template declare that key at the root and read it from a resource or module argument (hop 3)? " +
			"A `·` is the guard declining to look, and the reason is on the row's own kind.",
	);
	for (const kind of KINDS) {
		const rows = [...new Set(cells.filter((c) => c.field.kind === kind).map((c) => c.field.id))].sort();
		if (!rows.length) continue;
		md.push("");
		md.push(`### \`${kind}\``);
		md.push("");
		md.push(`| Field | ${PROVIDER_CLOUDS.join(" | ")} |`);
		md.push(`|---|${PROVIDER_CLOUDS.map(() => ":---:").join("|")}|`);
		for (const id of rows) {
			const row = PROVIDER_CLOUDS.map((cloud) => {
				const c = cells.find((x) => x.field.id === id && x.cloud === cloud);
				if (!c) return "·";
				return `${GLYPH[c.state]}${c.known?.issue ? ` ${c.known.issue}` : ""}`;
			});
			md.push(`| \`${id.split(".")[1]}\` | ${row.join(" | ")} |`);
		}
	}
	md.push("");

	if (ungatedByReader.length) {
		md.push("## Fields held to hop 1 only");
		md.push("");
		md.push(
			"Their canvas gate is a predicate this guard cannot evaluate, so which clouds OFFER them is not " +
				"established and no per-cloud verdict is honest. They are still measured against the contract. " +
				"The fix is to generate the field surface the way `gen:offer-surface` generates the switch " +
				"surface — by CALLING the predicate — not to widen the guesswork here.",
		);
		md.push("");
		for (const f of ungatedByReader.sort((a, b) => a.id.localeCompare(b.id))) md.push(`- \`${f.id}\` — \`${f.gate.replace(/\s+/g, " ")}\``);
		md.push("");
	}

	const notCarried = modelled.filter((f) => !CARRIED_SOMEWHERE.has(f.id));
	if (notCarried.length) {
		md.push("## Not carried by OpenTofu anywhere");
		md.push("");
		md.push(
			"No cloud turns these into a tfvars key, so the cross-cloud rule has nothing to say about them: " +
				"they are carried by another mechanism (a Kubernetes manifest, an ArgoCD Application, a " +
				"connector) or by nothing at all. Listed rather than dropped, because a field that quietly " +
				"leaves the measured set is how a guard reports success on less than it did yesterday.",
		);
		md.push("");
		md.push(notCarried.map((f) => `\`${f.id}\``).sort().join(" · "));
		md.push("");
	}

	if (carriedInCluster.length) {
		md.push("## Carried in-cluster");
		md.push("");
		md.push(
			"Honored, by a component the platform installs into the cluster rather than by OpenTofu. Rendered " +
				"above the exclusions on purpose: a reader who meets `—` first will have already concluded the " +
				"cloud cannot do it.",
		);
		md.push("");
		md.push("| Field | Cloud | By | What you get |");
		md.push("|---|---|---|---|");
		for (const e of carriedInCluster) md.push(`| \`${e.field}\` | ${e.cloud} | ${e.by ?? ""} | ${e.reason ?? ""} |`);
		md.push("");
	}

	if (exclusions.length) {
		md.push("## Documented exclusions");
		md.push("");
		md.push("Decisions, not silence: this cloud will not honor the setting, and here is what a user gets instead.");
		md.push("");
		md.push("| Field | Cloud | Why |");
		md.push("|---|---|---|");
		for (const e of exclusions) md.push(`| \`${e.field}\` | ${e.cloud} | ${e.reason ?? ""}${e.issue ? ` (${e.issue})` : ""} |`);
		md.push("");
	}

	if (wired.length) {
		md.push("## Reviewed branch-guard wirings");
		md.push("");
		md.push("⚠️ cells a person has read and confirmed. Ratcheted: when the cell stops reading ⚠️, the entry stops answering anything.");
		md.push("");
		md.push("| Field | Cloud | What was checked |");
		md.push("|---|---|---|");
		for (const e of wired) md.push(`| \`${e.field}\` | ${e.cloud} | ${e.reason ?? ""} |`);
		md.push("");
	}

	if (baseline.length) {
		md.push("## Known gaps on the baseline");
		md.push("");
		md.push("Real debt, boarded. Each row shows the state THIS RUN measured, with the state it was boarded in beside it.");
		md.push("");
		md.push("| Field | Cloud | Now | Boarded as | Issue | What a user gets |");
		md.push("|---|---|:---:|---|---|---|");
		for (const b of baseline) {
			const now = reproducedStates(b).join(", ") || "not measured";
			md.push(`| \`${b.field}\` | ${b.cloud} | ${GLYPH[reproducedStates(b)[0]] ?? "?"} | ${now} (boarded as ${b.state ?? "—"}) | ${b.issue ?? ""} | ${b.reason ?? ""} |`);
		}
		md.push("");
	}

	md.push("---");
	md.push("");
	md.push(
		`Measured this run: ${COLUMNS_EXAMINED} schema columns examined, ${FIELDS.length} of them user-settable, ` +
			`${cells.filter((c) => MEASURED_STATES.has(c.state)).length} cloud verdicts. ` +
			"Regenerate with `pnpm -C apps/console run gen:config-carriage`. CI runs the guard on every PR.",
	);
	md.push("");
	writeFileSync(MATRIX_OUT, md.join("\n"));
	console.log(`✓ wrote ${MATRIX_OUT}`);
}

// ── the report ──────────────────────────────────────────────────────────────────────
//
// EVERYTHING MEASURED IS PRINTED BEFORE ANYTHING IS ADJUDICATED, and there is exactly one exit at the
// bottom. A guard that exits the instant it finds a stale entry never gets to say what it measured,
// and the reader is left to re-run it to find out.

console.log(
	`config carriage — ${COLUMNS_EXAMINED} columns examined, ${FIELDS.length} user-settable, ` +
		`${modelled.length} modelled by the contract, across ${PROVIDER_CLOUDS.length} clouds (${PROVIDER_CLOUDS.join(", ")}).`,
);

if (PASSTHROUGH.unresolved.length) {
	console.log(
		`\n· ${PASSTHROUGH.unresolved.length} \`mergeProviderConfig\` call site(s) this guard could not attribute to a kind: ` +
			`${PASSTHROUGH.unresolved.map((u) => `${u.cloud}:${u.expr}`).join(", ")}. Passthrough only ever ADDS context to a ` +
			"finding, so an unread call site cannot hide a gap — but the printed scope below is incomplete until it is read.",
	);
}
console.log(
	`\n· \`provider_config\` passthrough reaches: ${PROVIDER_CLOUDS.map((c) => `${c} → ${[...PASSTHROUGH.byCloud[c]].sort().join("/") || "nothing"}`).join(", ")}. ` +
		"It copies JSONB keys onto same-named tofu variables, which makes an already-declared variable " +
		"reachable BY HAND. It carries no typed column, so it never discharges a finding here.",
);

if (ungatedByReader.length) {
	console.log(`\n· ${ungatedByReader.length} field(s) held to hop 1 only — their canvas gate is not one this guard can read:`);
	for (const f of ungatedByReader) console.log(`      ${f.id}  ←  ${f.gate.replace(/\s+/g, " ")}`);
	console.log("      Generate the field surface by CALLING the predicate (as gen:offer-surface does) rather than widening the guesswork here.");
}

const notCarriedAnywhere = modelled.filter((f) => !CARRIED_SOMEWHERE.has(f.id));
if (notCarriedAnywhere.length) {
	console.log(
		`\n· ${notCarriedAnywhere.length} modelled field(s) no cloud carries into tofu — carried by another mechanism, or by ` +
			`nothing: ${notCarriedAnywhere.map((f) => f.id).join(", ")}`,
	);
}

if (indirectCells.length) {
	console.log(`\n· ${indirectCells.length} cell(s) READ but un-followable (⚙️) — the provider reads the field in a function that writes no key:`);
	for (const c of indirectCells) console.log(`      ${c.cloud} · ${c.field.id}`);
}

if (UNSCOPED_READS.length) {
	const seen = new Set();
	const rows = UNSCOPED_READS.filter((r) => !seen.has(`${r.fn}|${r.expr}|${r.goField}`) && seen.add(`${r.fn}|${r.expr}|${r.goField}`));
	console.log(
		`\n· ${rows.length} read(s) of a field name SEVERAL component structs declare, whose receiver this reader ` +
			"could not bind to a kind — counted as the kind being measured, which can only over-credit:",
	);
	for (const r of rows) console.log(`      ${r.fn}() · ${r.expr}.${r.goField}  (owners: ${[...FIELD_OWNERS.get(r.goField)].join(", ")})`);
	console.log("      Bind the value from `config.<Kind>` or take it as a typed parameter, and the trace resolves itself.");
}

if (unmeasurableShapes.length) {
	console.log(`\n· ${unmeasurableShapes.length} cell(s) whose carrying shape is typed \`any\` — judged on the READ half alone:`);
	for (const u of unmeasurableShapes) console.log(`      ${u.cloud} · ${u.field}\n        ${u.detail}`);
}

if (knownDebt.length) {
	console.log(`\n· ${knownDebt.length} known gap(s) on the baseline (boarded, not failing):`);
	for (const k of knownDebt) console.log(`      ${k.cloud} · ${k.field}  (${k.known.issue ?? "no issue"})\n        ${k.detail}`);
}

let failed = false;

if (WIRE_CONTRADICTIONS.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${WIRE_CONTRADICTIONS.length} column(s) the CLI declares server-managed AND lets a caller set:`);
	for (const c of WIRE_CONTRADICTIONS) console.error(`  ${c.kind} · ${c.col}`);
	console.error(
		"\n  `WIRE_EXCLUDE` in lib/cli/project-components.ts names these as server-managed, and the same file's\n" +
			"  pick-list accepts them from `--set`. Both cannot be true: the value is validated, written, and then\n" +
			"  overwritten by the deploy's own write-back, so the user's input is accepted and discarded. Take the\n" +
			"  column out of the pick-list — do NOT take it out of WIRE_EXCLUDE, which is what makes the wire shape\n" +
			"  stable for every kind.",
	);
}

const typeFindings = findings.filter((f) => f.shape === "dropped-by-type");
if (typeFindings.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${typeFindings.length} field(s) the config-snapshot contract does not model:`);
	for (const f of typeFindings) console.error(`  ${f.field}\n      ${f.detail}`);
	console.error(
		"\n  This is #1981/#1982's shape and it is one line of Go each: add the field to the struct in\n" +
			"  packages/core/types/project_config.go with the column's exact `json:` tag, then read it in the\n" +
			"  provider(s) that can honor it. If the value is honored by something OTHER than OpenTofu — a chart\n" +
			"  the platform installs, for instance — record it under `carried_in_cluster:` in\n" +
			"  infra/config-carriage-exclusions.yaml, naming the file and the `reads:` token so the claim is\n" +
			"  re-read every run. If the product should not be collecting it at all, delete the control: a field\n" +
			"  nobody can honor is worse than no field, because it reads as a setting.",
	);
}

const carrierFindings = findings.filter((f) => f.shape === "no-carrier" || f.shape === "unwired-template");
if (carrierFindings.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${carrierFindings.length} cell(s) where a collected value never reaches the plan:`);
	for (const f of carrierFindings) console.error(`  ${f.cloud} · ${f.field}  [${f.shape}]\n      ${f.detail}`);
	console.error(
		"\n  Three honest answers, and exactly one of them is wrong for any given cell:\n" +
			"    · BUILD IT — carry the field in the provider and read the tfvar from a resource argument. The\n" +
			"      cell then measures honored and any entry for it must be deleted in the same PR.\n" +
			"    · EXCLUDE IT — the cloud will never honor it (the product does not exist, or its provider cannot\n" +
			"      express it). Add an `exclusions:` entry whose `reason:` says what a USER gets; it prints\n" +
			"      verbatim into the public matrix.\n" +
			"    · BOARD IT — it should be honored and is not yet. Add a `baseline:` entry with `issue:` and the\n" +
			"      `state:` this run printed. It stops failing the build and starts ratcheting.\n" +
			"  What is wrong is making the cell green by emitting a key nothing reads, or by wiring the value to a\n" +
			"  DIFFERENT feature's argument. Azure's Cosmos account did the second — point-in-time recovery bought\n" +
			"  Synapse Link analytical storage and no recoverability — and that is the shape ⚠️ exists to catch.",
	);
}

const gatedFindings = findings.filter((f) => f.shape === UNDECLARED_GATED);
if (gatedFindings.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${gatedFindings.length} branch-guard carrier(s) nobody has decided about:`);
	for (const f of gatedFindings) console.error(`  ${f.cloud} · ${f.field}\n      ${f.detail}`);
	console.error(
		"\n  ⚠️ is not an accusation and it is not a pass, so it has to be DECLARED — otherwise a failing cell can\n" +
			"  be turned green by writing any key inside an `if <field>` branch, and nothing asserts the branch does\n" +
			"  what the field says. Read the branch: if it wires this setting, add a `wired:` entry saying what you\n" +
			"  checked; if it does not, add a `baseline:` entry with `state: gated-carrier`.",
	);
}

const unmeasuredFindings = findings.filter((f) => f.shape === "unmeasured-field");
if (unmeasuredFindings.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${unmeasuredFindings.length} field(s) that stopped being measured:`);
	for (const f of unmeasuredFindings) console.error(`  ${f.field}\n      ${f.detail}`);
}

if (baselineNoIssue.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${baselineNoIssue.length} baseline entr(ies) with no \`issue:\`:`);
	for (const b of baselineNoIssue) console.error(`  ${b.cloud} · ${b.field}`);
	console.error("\n  An entry with no issue is an amnesty nothing will ever come back to collect. Board it or exclude it.");
}

if (doubleBooked.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${doubleBooked.length} cell(s) both excluded and boarded as debt:`);
	for (const b of doubleBooked) console.error(`  ${b.cloud} · ${b.field}`);
	console.error("\n  One cell cannot be both a permanent ceiling and work we intend to do. Pick the one that is true.");
}

if (falseCeilings.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${falseCeilings.length} exclusion(s) the code contradicts:`);
	for (const m of falseCeilings) console.error(`  ${m.cloud} · ${m.field}\n      "${normalizeReason(m.entry.reason)}" — but the value is carried and read on ${m.cloud} today.`);
	console.error("\n  The ceiling is false. Delete the entry; the cell measures honored and needs no record.");
}

if (brokenInCluster.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${brokenInCluster.length} \`carried_in_cluster:\` claim(s) that no longer check out:`);
	for (const m of brokenInCluster) console.error(`  ${m.cloud} · ${m.field}\n      ${m.verdict.why}`);
	console.error(
		"\n  The entry claims the value is honored by an in-cluster component and names where to verify that.\n" +
			"  It no longer verifies, which means either the carriage moved (update `source:`/`reads:`) or it was\n" +
			"  removed (the cell is a real gap again — board it or exclude it). \"I could not check\" is not \"fine\".",
	);
}

if (redundantInCluster.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${redundantInCluster.length} \`carried_in_cluster:\` entr(ies) OpenTofu now carries anyway:`);
	for (const m of redundantInCluster) console.error(`  ${m.cloud} · ${m.field}`);
	console.error("\n  The matrix would credit the wrong mechanism, and the cell would stay green if the template carriage broke. Delete the entry.");
}

if (staleBaseline.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${staleBaseline.length} baseline entr(ies) whose gap is FIXED:`);
	for (const b of staleBaseline) console.error(`  ${b.cloud} · ${b.field}  (${b.issue ?? "no issue"})`);
	console.error("\n  Fixed — thank you. Now delete these from infra/config-carriage-exclusions.yaml; the list can only shrink.");
}

if (driftedBaseline.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${driftedBaseline.length} baseline entr(ies) whose cell CHANGED SHAPE:`);
	for (const d of driftedBaseline) console.error(`  ${d.entry.cloud} · ${d.entry.field}  boarded as \`${d.entry.state}\`, now \`${d.states.join(", ")}\``);
	console.error(
		"\n  NOT fixed. The gap is still there in a different shape, so the entry STAYS — update its `state:`.\n" +
			"  `unwired-template → gated-carrier` in particular is the evidence getting WEAKER, not the gap closing.",
	);
}

if (unstatedBaseline.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${unstatedBaseline.length} baseline entr(ies) with no \`state:\`:`);
	for (const u of unstatedBaseline) console.error(`  ${u.entry.cloud} · ${u.entry.field}  (measured: ${u.states.join(", ")})`);
	console.error("\n  Without it the ratchet cannot tell a fix from a change of shape. Copy the state this run printed.");
}

if (unmeasuredBaseline.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${unmeasuredBaseline.length} baseline entr(ies) the guard did NOT measure:`);
	for (const u of unmeasuredBaseline) console.error(`  ${u.entry.cloud} · ${u.entry.field}${u.why ? `\n      ${u.why}` : ""}`);
	console.error(
		"\n  This is NOT a fix, and the guard is NOT asking for these entries back. It has nothing to say about\n" +
			"  whether the gap is still there, and treating that as \"fixed\" is how the record of a live gap gets\n" +
			"  deleted by a green build. Restore whatever stopped the cell being produced, or say why it should\n" +
			"  stay unmeasured.",
	);
}

if (staleWired.length) {
	failed = true;
	console.error(`\n✗ config carriage — ${staleWired.length} \`wired:\` entr(ies) whose cell no longer reads ⚠️:`);
	for (const e of staleWired) console.error(`  ${e.cloud} · ${e.field}`);
	console.error("\n  The review record answers a question the guard no longer asks. Delete it, or check why the cell moved.");
}

if (failed) process.exit(1);

console.log(`\n✓ config carriage — ${measuredCells.length} verdicts, ${measuredCells.filter((c) => c.state === "ok").length} honored, 0 unrecorded gaps.`);
console.log(`✓ ${exclusions.length} documented exclusion(s), ${baseline.length} boarded gap(s), ${wired.length} reviewed wiring(s), ${carriedInCluster.length} in-cluster carriage claim(s) re-read.`);
process.exit(0);
