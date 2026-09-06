// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Offer-parity guard: nothing the canvas OFFERS may be unbuildable on a cloud without a recorded
// exclusion. This is the cloud-parity rule from CLAUDE.md made mechanical.
//
// It exists because the class kept shipping. Four instances found by hand in one sitting, in three
// different shapes — and each one presents to a user identically: pick it, get silence or something
// else. So the guard checks the three shapes rather than one:
//
//   A · NO CARRIER        an offered variant axis the provider never even READS. The cache engine
//                         (redis/valkey) is a first-class choice on the canvas, `ProjectCacheConfig`
//                         carries an `Engine` field for it, and not one of the five providers looks
//                         at it — the choice is dropped between the canvas and the plan.
//   B · MISSING BRANCH    where a template BRANCHES on a variant, every offered variant needs a
//                         branch. Azure's azure-db gates every resource on `is_postgres`, so the
//                         MySQL the canvas offers provisions nothing (#1382).
//   C · UNWIRED TEMPLATE  the switch reaches tfvars and then no resource argument reads it. GCP
//                         declares `uniform_access` on `cloud_storage_buckets`, the provider fills
//                         it in on every apply, and the bucket resource hardcodes
//                         `uniform_bucket_level_access = true`. Carried the whole way, dropped one
//                         line before it would have meant something.
//
// What this deliberately does NOT flag: a template variable the provider doesn't set by default.
// `mergeProviderConfig` (packages/core/cloud/aws_provider.go) copies any `provider_config` JSONB key
// onto a same-named tofu variable, so every DECLARED variable is already reachable. An early version
// of this guard reported 14 "dead toggles" that were all working as designed — the escape hatch is
// the feature, and a guard that fights it would be turned off within a week.
//
// The defect is narrower than "the console can't set it": it is a choice the product presents as
// first-class and then discards.
//
// Passthrough is NOT a gap: a template that hands `engine` straight to the provider (AWS RDS,
// Alibaba RDS) supports every value its API does, so check B only fires where the template itself
// enumerates. That distinction is the whole reason this can run in CI without crying wolf.
//
// Both sides are DERIVED, never hand-listed — the offers from the frontend's own sources, the
// implementations from the templates and the tfvars builders. A hand-list would drift the same way
// the thing it is guarding drifted.
//
// Exclusions live in infra/offer-exclusions.yaml, one reasoned line each (Hetzner runs data services
// in-cluster; Azure has no Valkey product). An exclusion is a decision on the record, not a mute —
// the generated matrix prints them as documented exclusions.
//
// Run from apps/console (`pnpm -C apps/console run check:offer-parity`). `--matrix` writes the living board to
// docs/testing/offer-parity.md instead of just reporting.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	assertParsed as assertGoTraceParsed,
	readGoPackage,
	selfCheck as goTraceSelfCheck,
	traceField,
} from "./lib/go-tfvars-trace.mjs";
import { readKeylessCells } from "./lib/keyless-cells.mjs";
import {
	assertParsed as assertTfWiringParsed,
	readTfWiring,
	selfCheck as tfWiringSelfCheck,
} from "./lib/tf-wiring.mjs";

// Before anything is measured, prove the two readers still read. Both pin themselves against a
// fixture in BOTH directions — a reader that sees nothing, and a reader that sees everything, are
// equally silent here, and only one of them is loud on its own.
goTraceSelfCheck();
tfWiringSelfCheck();

const ROOT = "../..";
const TEMPLATES = `${ROOT}/infra/templates/project`;
const PROVIDERS = `${ROOT}/packages/core/cloud`;
const EXCLUSIONS = `${ROOT}/infra/offer-exclusions.yaml`;
const MATRIX_OUT = `${ROOT}/docs/testing/offer-parity.md`;
const NODE_REGISTRY = "components/design-project/canvas/graph/node-registry.ts";
const OFFER_SURFACE = "lib/cloud-providers/generated/offer-surface.json";
const CATALOG = `${ROOT}/packages/core/catalog/catalog.json`;

const writeMatrix = process.argv.includes("--matrix");

/** Compare two user-facing reasons for MEANING, not layout: the yaml wraps its `reason:` across
 * lines, the Go constant does not. Differences in whitespace are the file format talking. */
const normalizeReason = (s) => (s ?? "").replace(/\s+/g, " ").trim();

// ── helpers ─────────────────────────────────────────────────────────────────────────

/** Strip `#` and `//` line comments so a COMMENTED-OUT resource never counts as an implementation.
 * That distinction is load-bearing: azure-db's MySQL "implementation" is a commented placeholder. */
function stripComments(src) {
	return src
		.split("\n")
		.map((l) => l.replace(/(^|\s)(#|\/\/).*$/, ""))
		.join("\n");
}

/** Every .tf file under a directory, recursively, comments stripped, WITH its path.
 *
 * The day-2 scan needs the path the day-1 checks do not: `modules/redis/` and `modules/valkey/`
 * declare the same shape, and only where a declaration LIVES says which variant it backs. */
function readTfFiles(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === ".terraform") continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) out.push(...readTfFiles(full));
		else if (e.name.endsWith(".tf")) out.push({ path: full, text: stripComments(readFileSync(full, "utf8")) });
	}
	return out;
}

/** The clouds that ship a provisioning template. Hetzner has none by design (in-cluster charts). */
const CLOUDS = readdirSync(TEMPLATES, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.sort();

const tfFiles = Object.fromEntries(CLOUDS.map((c) => [c, readTfFiles(`${TEMPLATES}/${c}`)]));
const tf = Object.fromEntries(CLOUDS.map((c) => [c, tfFiles[c].map((f) => `\n${f.text}`).join("")]));
const goSrc = Object.fromEntries(
	CLOUDS.map((c) => {
		const p = `${PROVIDERS}/${c}_provider.go`;
		return [c, existsSync(p) ? stripComments(readFileSync(p, "utf8")) : ""];
	}),
);

/** tfvars keys a cloud's provider actually emits.
 *
 * Two forms, and missing either one turns this guard into a false-alarm generator: the bracket
 * assignment (`tfvars["create_cloud_sql"] = …`) and the map literal the builder returns
 * (`"create_rds": len(config.Databases) > 0`). Collecting quoted keys broadly is the conservative
 * direction — it can only make the guard quieter, never noisier. */
const emitted = Object.fromEntries(
	CLOUDS.map((c) => [
		c,
		new Set([
			...[...goSrc[c].matchAll(/tfvars\["([a-z0-9_]+)"\]/g)].map((m) => m[1]),
			...[...goSrc[c].matchAll(/"([a-z0-9_]+)":/g)].map((m) => m[1]),
		]),
	]),
);

// ── the offer side: derived from the frontend, never hand-listed ─────────────────────

/** Variant axes the canvas offers, read out of NODE_REGISTRY (`database` → postgres|mysql, …). */
function offeredVariants() {
	const src = readFileSync(NODE_REGISTRY, "utf8");
	const body = src.slice(src.indexOf("export const NODE_REGISTRY"));
	const kinds = [...body.matchAll(/\n\t(\w+): \{/g)];
	const axes = {};
	for (let i = 0; i < kinds.length; i++) {
		const seg = body.slice(kinds[i].index, kinds[i + 1]?.index ?? body.length);
		const v = seg.match(/variants:\s*\{/);
		if (!v) continue;
		const values = [...seg.slice(v.index).matchAll(/value:\s*"([^"]+)"/g)].map((m) => m[1]);
		if (values.length) axes[kinds[i][1]] = values;
	}
	return axes;
}

const AXES = offeredVariants();

/** The per-cloud floor the canvas itself applies, read from the SAME source the canvas reads.
 *
 * This first parsed a `HETZNER_VARIANT_VALUES` constant out of node-registry.ts. #1420 deleted that
 * constant — the floor now derives from the catalog for every cloud — and the guard silently kept
 * passing while measuring the wrong thing: it went on believing Valkey was offered on Azure and
 * Alibaba after the canvas had stopped offering it.
 *
 * Reading `catalog.json` removes the class of failure rather than the instance. It is the SSOT both
 * the canvas floor and the cross-cloud converter derive from, it is plain JSON rather than TypeScript
 * to pattern-match, and a guard that reads a DIFFERENT source than the thing it guards is exactly how
 * the drift it exists to catch gets in.
 */
function cloudFloor() {
	const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
	const floors = {};
	for (const [cloud, provider] of Object.entries(catalog.database ?? {})) {
		floors[cloud] ??= {};
		floors[cloud].database = new Set((provider.engines ?? []).map((e) => e.family));
	}
	for (const [cloud, provider] of Object.entries(catalog.cache ?? {})) {
		floors[cloud] ??= {};
		floors[cloud].cache = new Set((provider.engines ?? []).map((e) => e.value));
	}
	return floors;
}

const FLOOR = cloudFloor();

/** Is this variant offered at all on this cloud?
 *
 * An EMPTY floor means the catalog has no slice for this cloud/kind — treated as "offered", matching
 * `variantOptionsFor`, which shows everything rather than an empty picker (#918). A missing slice is
 * not evidence that nothing is offered. */
function offeredOn(cloud, kind, variant) {
	const allowed = FLOOR[cloud]?.[kind];
	if (!allowed || allowed.size === 0) return true;
	return allowed.has(variant);
}

// ── the offer side, part 2: OPTION-level offers (`database:<engine>:iam_auth`) ───────
//
// A variant axis is not the only thing the canvas offers. `iam_auth` was a plain SWITCH in
// config-schema.ts with no gate, so the canvas presented keyless database auth on EVERY cloud for
// BOTH engines — and until #1500 several of those cells could not honor it. The guard could not see
// any of that: its whole vocabulary was `variants:` blocks, so shipping MySQL keyless broken was
// structurally un-catchable (#1508).
//
// Options are DERIVED, like everything else here: every `type: "switch"` field in CONFIG_SCHEMA.
// A field carrying a gate this guard CANNOT read makes no measurable cross-cloud promise and is
// skipped. A field whose gate is in KNOWN_GATES is KEPT, with the gate attached — because otherwise
// "add a gate" is a way to delete an offer from this guard's vocabulary, which is exactly the hole
// #1508 closed. Gating `iam_auth` in #1510 would have reopened it: the whole option grid, and the
// exclusions keyed on it, would simply have vanished, green.
//
// TWO LIMITS, stated because a guard that looks more complete than it is, is worse than no guard:
//
//  1. Only kinds that ALSO have a variant axis are covered HERE, because this key is
//     `<kind>:<variant>:<option>`. Variant-less kinds are measured by the CARRIER pass further down,
//     which keys `<kind>:<option>` and is where `bucket:versioning` and friends live.
//  2. Only `type: "switch"` is read. An enum-shaped option (a `select` whose values are not a
//     `variants:` axis) makes the same cross-cloud promise and is equally invisible.

/** The keyless gate: which cloud × engine cells the canvas offers `iam_auth` on, read from the same
 * table the canvas reads (`var keylessCells`, packages/core/manifests/keyless.go).
 *
 * A gate is only usable here if the guard can EVALUATE it. This one can be: it is a table, not a
 * closure. `(cloud, variant) → {state, reason}`, or undefined for a cloud with no cells at all. */
function keylessGate() {
	const { cells } = readKeylessCells(`${ROOT}/packages/core/manifests/keyless.go`);
	return (cloud, variant) =>
		cells.find((c) => c.cloud === cloud && c.engine === variant);
}

/** Options whose canvas gate this guard knows how to read, keyed `<kind>:<option>`. */
const KNOWN_GATES = { "database:iam_auth": keylessGate() };

/** The OFFER SURFACE — every switch the canvas shows, and the clouds it shows it on.
 *
 * This used to be a regex over `config-schema.ts`, and the regex could not read a `visibleWhen`
 * closure — so every gated field was SKIPPED, and "add a gate" was a way to delete an offer from
 * this guard's vocabulary without failing anything. #1802 replaced the guess with an artifact:
 * `gen:offer-surface` imports the schema, CALLS the predicates against witness configs, and checks
 * the answer in. CI regenerates and diffs it, exactly like `gen:keyless-cells`.
 *
 * Reading it here rather than re-deriving is the same rule the catalog floor follows: a guard that
 * reads a DIFFERENT source than the thing it guards is how the drift it exists to catch gets in. */
function readOfferSurface() {
	const surface = JSON.parse(readFileSync(OFFER_SURFACE, "utf8"));
	if (!Array.isArray(surface.offers) || surface.offers.length === 0) {
		throw new Error(
			`${OFFER_SURFACE} lists no offers — regenerate it with \`pnpm -C apps/console run gen:offer-surface\`. ` +
				`An empty surface measures nothing and reports success.`,
		);
	}
	return surface;
}

const SURFACE = readOfferSurface();

/** Switch fields per kind: `{key, gate}` — gate null when there is no gate this guard can read. */
function offeredOptions() {
	const out = {};
	for (const offer of SURFACE.offers) {
		(out[offer.kind] ??= []).push({ key: offer.key, gate: KNOWN_GATES[`${offer.kind}:${offer.key}`] ?? null });
	}
	return out;
}

const OPTIONS = offeredOptions();

/** snake_case option key → the Go struct field a provider would read (`iam_auth` → `IamAuth`). */
const goFieldFor = (key) =>
	key
		.split("_")
		.map((s) => s.charAt(0).toUpperCase() + s.slice(1))
		.join("");

// ── L4 · the carrier hop, traced rather than grepped ─────────────────────────────────
//
// "Does `.PublicAccess` appear in <cloud>_provider.go" is the question this used to ask, and it is
// wrong in both directions. Azure's secrets are built by `buildGCPSecrets`, which lives in
// gcp_provider.go — a per-file grep says Azure drops the offer, and Azure does not. GCP's
// `buildFirestoreDatabases` reads `PointInTimeRecovery` into a list nobody assigns to a tfvar — a
// grep says GCP carries the offer, and GCP does not (gcp_provider.go:88 says so in a comment).
//
// So the carrier question is asked of the CALL GRAPH from each cloud's own `ProviderTfvars`, and it
// answers with the tfvars keys the switch actually becomes — which is what makes the L5 hop below
// possible at all.

const GO_PKG = readGoPackage(PROVIDERS);
assertGoTraceParsed(GO_PKG);

const traceCache = new Map();

/** Trace one option on one cloud through the Go package, memoized. */
function traceOption(cloud, key) {
	const id = `${cloud}:${key}`;
	if (!traceCache.has(id)) traceCache.set(id, traceField(GO_PKG, cloud, goFieldFor(key)));
	return traceCache.get(id);
}

/** Which clouds' providers demonstrably READ this option (i.e. carry it into tfvars)? */
function optionCarriers(key) {
	return new Set(CLOUDS.filter((c) => traceOption(c, key).carried));
}

// ── L5 · the template hop ────────────────────────────────────────────────────────────
// Carriage is not honoring. A tfvar the template declares and no resource reads is a switch that
// travels the whole way and is dropped one line before it would have meant something.

// The ROOT template directory travels with the files, and it is load-bearing rather than decorative:
// a root tfvar is a promise only the root module can make, so "is it declared" has to be asked of
// `<cloud>/`, not of `<cloud>/**`. Asked cloud-wide, any submodule that happens to declare the same
// name vouches for the root — `sku` is declared by modules/acr and modules/service-bus, so a provider
// emitting a ROOT `sku` read as declared while OpenTofu silently threw the value away.
const TF_WIRING = Object.fromEntries(
	CLOUDS.map((c) => {
		const w = readTfWiring(tfFiles[c], `${TEMPLATES}/${c}`);
		assertTfWiringParsed(c, w);
		return [c, w];
	}),
);

// Options measured PER ENGINE rather than per cloud.
//
// This is not the offer vocabulary and never was — that is derived from the offer surface. It is the
// short list of options whose honoring splits along the engine axis, so a cloud-level verdict would
// be wrong in both directions: `iam_auth` is read once per cloud, and GCP still shipped Postgres
// keyless working and MySQL keyless dead (#1505). Those get `<kind>:<variant>:<option>` cells.
//
// Everything else is measured once per cloud by the CARRIER pass further down, under
// `<kind>:<option>`. Nothing is unmeasured: an option is either here or there.
const ADJUDICATED = new Set(["database:iam_auth"]);

/** Does the template gate this option per ENGINE, and if so which engines does it cover?
 *
 * Carriage is cloud-level (`db.IamAuth` is read once), but honoring can be per-engine — which is
 * exactly how gcp shipped Postgres keyless working and MySQL keyless silently dead until #1505.
 * Evidence-based and conservative, like `enumeratedValues`: only lines mentioning the option token
 * count, and only when at least one of them is engine-specific. A template that references the option
 * uniformly is treated as covering every engine (passthrough is not a gap). */
function optionEngineCoverage(cloud, key, variants) {
	const lines = tf[cloud].split("\n").filter((l) => l.includes(key));
	if (!lines.length) return null;
	const seen = new Set();
	let engineSpecific = false;
	for (const l of lines) {
		for (const v of variants) {
			const rx = new RegExp(`==\\s*"${v}"|_${v}\\b|\\b${v}_`, "i");
			if (rx.test(l)) {
				seen.add(v);
				engineSpecific = true;
			}
		}
	}
	// Also credit an engine named in an option-scoped local/variable elsewhere in the template
	// (`database_flags_mysql`, `enable_mysql_entra`) — the gcp/azure shapes.
	return engineSpecific ? seen : null;
}

// ── exclusions ──────────────────────────────────────────────────────────────────────

/** Minimal reader for the flat `- offer: … cloud: … reason: …` list (no YAML dep in this package). */
function readExclusions() {
	if (!existsSync(EXCLUSIONS)) return [];
	const out = [];
	let cur = null;
	let section = "exclusions";
	for (const raw of readFileSync(EXCLUSIONS, "utf8").split("\n")) {
		// Only FULL-LINE comments are stripped. An inline strip would eat the `#` of `issue: "#1420"`
		// and silently drop every tracking link — the matrix would print a bare 🚫 with nowhere to go.
		if (/^\s*#/.test(raw)) continue;
		const line = raw.trimEnd();
		if (!line.trim()) continue;
		const head = line.match(/^(exclusions|baseline|wired|carried_in_cluster):\s*$/);
		if (head) {
			if (cur) { out.push(cur); cur = null; }
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

const allEntries = readExclusions();
const exclusions = allEntries.filter((e) => e.section === "exclusions");
const baseline = allEntries.filter((e) => e.section === "baseline");
// Cells whose branch-guard wiring has been READ BY A PERSON and found to wire the feature it names.
// Not debt and not an exclusion — a third thing, and it needs its own section because the other two
// both say something false about it: a `baseline:` entry calls working code a known gap, and an
// `exclusions:` entry says the cloud will never honor the offer when it already does. See
// UNDECLARED_GATED below for why the state has to be declared at all.
const wired = allEntries.filter((e) => e.section === "wired");

// Cells the cloud DOES honor, through a component the platform installs INTO THE CLUSTER rather than
// through OpenTofu. A fourth section, and it exists because the carrier rule structurally cannot see
// these: L5 requires the tfvar to be DECLARED in the template and READ by a resource argument, and a
// component installed by Go writes no tfvar at all. So no cell served that way can ever satisfy it,
// however correct the implementation is.
//
// The other three sections all say something false about such a cell:
//   · `exclusions:` — prints under a heading meaning "this cloud cannot do this". For gcp/azure
//     `dns:managed_certificate` that is the OPPOSITE of the truth: cert-manager issues there.
//   · `baseline:`   — calls working, shipped code a known gap, and demands an issue nobody can close.
//   · `wired:`      — is about a ⚠️ BRANCH GUARD in provider code. There is no branch here to read.
//
// ⚠️ AND IT MUST NOT BECOME A MUTE BUTTON. #1864 is the cautionary case: `exclusions:` was the one
// claim nothing re-read, so any measured gap could be discharged by RECLASSIFYING it instead of
// fixing it — green either way. A bare "cert-manager does this one" would reopen that hole through a
// third door. So an entry here is a CHECKABLE claim, not prose: it names the PREDICATE that decides
// per cloud, and `verifyInClusterCarriage` re-reads it from the Go source on every run. The entry
// survives only while the predicate still covers the cloud.
const carriedInCluster = allEntries.filter((e) => e.section === "carried_in_cluster");

/**
 * Re-read a `carried_in_cluster:` entry's claim against the Go source that owns it.
 *
 * The entry names `predicate` — a Go `map[string]…` literal whose KEYS are the clouds the installing
 * component actually ships for — and `source`, the file it lives in. Reading the map is what turns a
 * declaration into a ratchet: drop a cloud from `certManagerDNS01Solvers` and every entry claiming
 * that cloud goes stale on the next run, exactly as a `baseline:` entry does when its gap is fixed.
 *
 * Reading the MAP and not, say, a hand-kept list in this file is the same rule the floor reader
 * learned the hard way: a guard must read the same source as the thing it guards. `HETZNER_VARIANT_VALUES`
 * was deleted out from under the old floor reader and the guard kept passing while measuring nothing.
 *
 * Returns `{ ok }` when the predicate covers the cloud, or `{ ok: false, why }` naming what broke —
 * a missing file, a missing symbol, or a cloud the map no longer lists. All three are failures: an
 * unreadable predicate is NOT a pass, or "I could not check" would silently mean "fine".
 */
function verifyInClusterCarriage(entry) {
	const { predicate, source, cloud } = entry;
	if (!predicate || !source) {
		return { ok: false, why: "the entry names no \`predicate:\`/\`source:\`, so nothing re-reads it — see the note above this function" };
	}
	const path = `${ROOT}/${source}`;
	if (!existsSync(path)) {
		return { ok: false, why: `\`source: ${source}\` does not exist` };
	}
	const text = readFileSync(path, "utf8");
	// `var <name> = map[string]<T>{ … }` — take the literal body up to the closing brace at column 0,
	// which is where gofmt puts it for a top-level var.
	const m = text.match(new RegExp(`\\b${predicate}\\s*=\\s*map\\[string\\][^{]*\\{([\\s\\S]*?)\\n\\}`));
	if (!m) {
		return { ok: false, why: `\`${predicate}\` is not a top-level \`map[string]…\` literal in ${source}` };
	}
	// Keys with a NON-EMPTY value. An entry mapped to "" is the map's own way of saying "not here".
	const keys = new Set(
		[...m[1].matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)].filter((k) => k[2] !== "").map((k) => k[1]),
	);
	if (!keys.has(cloud)) {
		return {
			ok: false,
			why: `\`${predicate}\` in ${source} no longer lists \`${cloud}\` (it has: ${[...keys].join(", ") || "nothing"}), so nothing installs the component that was said to honor this offer`,
		};
	}
	return { ok: true };
}

/** The recorded in-cluster carriage for this (offer, cloud), if one is declared. */
const inClusterAck = (offer, cloud) =>
	carriedInCluster.find((e) => e.offer === offer && (e.cloud === cloud || e.cloud === "*"));

// States that are a GAP: offered, unbuildable, silent — the thing the cloud-parity rule forbids. A
// cell in one of these fails the build unless the yaml records it.
//
// `gated-carrier` is still NOT here, and that part of the original judgement stands: the switch DOES
// reach the plan and the plan DOES differ, and whether the key the branch writes is the same feature
// the switch names is a question about SEMANTICS that a guard reading text cannot answer. Failing on
// the STATE would manufacture debt records for cells that are correctly wired — gcp's
// `memorystore_tier` really is Memorystore's zone-redundant tier; aws's `length`/`special`/`manual`
// really are what generating a secret means.
//
// What did not stand is leaving it undeclared. #1829/#1830 are one defect from two sides:
//
//   · a FAILING 🚫 cell could be turned green by adding `if x.Foo { tfvars["<any wired key>"] = … }`
//     — the cell moves 🚫 → ⚠️, stops being a finding, and nothing asserts the branch does what the
//     switch says (#1829);
//   · a BOARDED ⚠️ entry could be deleted while the cell still reproduced ⚠️, and the guard exited 0
//     (#1830) — whereas deleting a 🚫 entry correctly reds, because the cell falls back into
//     GAP_STATES and fails as unrecorded.
//
// Both are the same hole: ⚠️ was the one unhonored state no declaration had to exist for, so it was
// the one state the yaml ratchet could not hold. The fix is not to move it into GAP_STATES — that
// re-opens the formality objection above — but to require it be DECLARED, in whichever of the two
// senses is true: `baseline:` when the wiring is wrong or unreviewed (real debt, carries an issue),
// `wired:` when a person has read it and it does wire the feature. An UNDECLARED ⚠️ fails, which is
// what makes the two sides agree: whichever direction a cell arrives in ⚠️ from, someone has to say
// which of the two it is. See UNDECLARED_GATED.
const GAP_STATES = new Set(["no-carrier", "missing-branch", "unwired-template"]);

// The finding shape for a ⚠️ cell nobody has decided about. Deliberately NOT a member of GAP_STATES
// or of any `state` a cell can be measured in: the cell's state is `gated-carrier` either way, and
// what fails is the ABSENCE OF A DECLARATION, not the measurement. Keeping the two apart is what lets
// `boardState`, the matrix glyph and the drift ratchet keep reading one state while the build fails
// on the other.
const UNDECLARED_GATED = "undeclared-gated-carrier";

// States in which the cloud does NOT demonstrably honor the offer: every GAP state, plus
// `gated-carrier`. The gap between these two sets is the whole answer to "what does ⚠️ mean to the
// baseline", and it has to be answered in one place because four code paths ask it:
//
//   · GAP_STATES       — FAIL the build when unrecorded. The guard can show the switch is dropped,
//                        so silence about one is a defect it is entitled to accuse someone of.
//   · UNHONORED_STATES — KEEP a baseline entry alive. ⚠️ is not an accusation, but it is not
//                        honoring either: what the code shows is that some key appears, never that
//                        the key IS this feature.
//
// Reading ⚠️ as honored is the defect this pair replaces. `gated-carrier` was kept out of GAP_STATES
// and out of nothing else, so the ratchet — which asks "does this baselined gap still reproduce?" —
// saw a ⚠️ cell produce no gap and reported the entry FIXED. Two failures came out of that, and the
// second is the serious one:
//
//   (a) a ⚠️ cell could not be BOARDED. Adding a legitimate entry for one made the guard demand it
//       back as stale, so the only cell the guard says "confirm this by hand" about was the one cell
//       the board could not hold a note against.
//   (b) a baselined 🚫 that DRIFTED to ⚠️ printed "Fixed — thank you. Now delete these". The gap was
//       not fixed; it was rewired on WEAKER evidence. Deleting the entry would have removed the board
//       record of a gap that is still shipping — the silent deletion this whole guard exists to make
//       impossible, arriving through the fix for it.
//
// So: a ⚠️ cell is unhonored. It is boardable, it keeps its entry, and a cell that MOVES between
// these states has changed shape rather than been fixed — reported as its own thing further down.
const UNHONORED_STATES = new Set([...GAP_STATES, "gated-carrier"]);

// States in which the guard actually REACHED A VERDICT on a cell: it read the cloud's code and
// decided whether the offer is honored there. `not-offered` and `excluded` are deliberately absent —
// in those the guard DECLINED TO LOOK, and "looked and found nothing wrong" is a different fact from
// "did not look".
//
// The ratchet needs this set as much as it needs UNHONORED_STATES, and for the same reason the two
// above had to be split. "No unhonored state was recorded for this baseline entry" has TWO causes:
//
//   · the cell was measured and came out HONORED               → the entry is stale, ask for it back;
//   · the cell was NOT MEASURED — `offeredOn` lost the cloud,
//     the catalog floor stopped offering the variant, the key
//     was renamed, the kind lost its tofu evidence            → the guard has NOTHING to say about
//                                                               whether the gap is still there.
//
// Collapsing those reported the second as "Fixed — thank you. Now delete these", which deletes the
// board record of a gap nobody touched — the silent deletion this whole guard exists to prevent,
// arriving through the one door the guard itself holds open. Dropping a cloud from `offeredOn`
// reached it in one line, and the congratulation was the only thing printed.
// `carried-in-cluster` IS measured, and deliberately so. `not-offered` and `excluded` are absent from
// this set because in those the guard DECLINED TO LOOK — but here it looked, and at the only source
// that could answer: it re-read the installing predicate and confirmed the cloud is covered. Leaving
// it out would recreate #1864 precisely — a state that is green because nothing measures it, which is
// how a gap becomes permanently undischargeable while every run passes.
//
// It is NOT in UNHONORED_STATES: the offer IS delivered. So a `baseline:` entry for the same cell
// correctly goes stale, which is the ratchet doing its job when a gap is closed by shipping the
// in-cluster component rather than by wiring a tfvar.
const MEASURED_STATES = new Set(["ok", "carried-in-cluster", ...UNHONORED_STATES]);

/** The recorded EXCLUSION for this (offer, cloud), if the cloud has been decided never to honor it. */
const excluded = (offer, cloud) =>
	exclusions.find((e) => e.offer === offer && (e.cloud === cloud || e.cloud === "*"));
/** The recorded `wired:` acknowledgement for this (offer, cloud) — a reviewed branch-guard wiring. */
const wiredAck = (offer, cloud) => wired.find((e) => e.offer === offer && (e.cloud === cloud || e.cloud === "*"));
/** The recorded BASELINE entry for this (offer, cloud) — real, boarded debt that does not fail the build. */
const baselined = (offer, cloud) =>
	baseline.find((e) => e.offer === offer && (e.cloud === cloud || e.cloud === "*"));

/** Every cell this run reached a verdict on, honored or not. The ratchet reads this to tell "no gap
 * found here" apart from "nothing was looked at here". */
const measuredCells = [];
/** Every cell this run found UNHONORED, with the state it was found in. */
const unhonoredCells = [];
/** Excluded cells the code CONTRADICTS — the switch is honored despite an entry saying it never can.
 * Deliberately not in `measuredCells`: an exclusion is still "the guard declined to look" for ratchet
 * purposes, and feeding it there would make excluded cells satisfy baseline entries (#1864). */
const excludedMeasured = [];
/** Every `carried_in_cluster:` entry this run re-read, with the verdict on its predicate. */
const inClusterMeasured = [];

/**
 * File a cell's verdict for the ratchet, and hand back its baseline entry if it has one.
 *
 * One helper for all three passes rather than the condition written out three times, because the
 * ratchet is exactly as good as its most forgetful caller: a pass that records nothing is a pass
 * whose every baseline entry reads as fixed, and that failure is silent and congratulatory.
 *
 * Both ledgers are written HERE, from one `state`, so no pass can file a cell as measured without
 * also filing what it measured — or file a gap the ratchet never learns was even looked for.
 *
 * @param {string} offer  the offer key this cell is boarded under (`<kind>:<variant>`, `<kind>:<option>`, …)
 * @param {string} cloud  the cloud the verdict is about
 * @param {string} state  the verdict — `ok`, a GAP state, `gated-carrier`, `excluded`, `not-offered`
 * @returns {object|null} the baseline entry covering this cell, or null (honored, or unboarded)
 */
function recordVerdict(offer, cloud, state) {
	if (MEASURED_STATES.has(state)) measuredCells.push({ offer, cloud, state });
	if (!UNHONORED_STATES.has(state)) return null;
	unhonoredCells.push({ offer, cloud, state });
	return baselined(offer, cloud);
}

// ── check B · missing branch ────────────────────────────────────────────────────────
// Where a template ENUMERATES the values of a variant it branches on, that enumeration is the
// supported set. A passthrough template (AWS RDS, Alibaba RDS — `engine = var.engine`) enumerates
// nothing and supports whatever its API does, so it is correctly never flagged.

/** The variant values a cloud's template enumerates for THIS axis, or null when it passes through.
 *
 * An enumeration counts as being "about" an axis only if its values intersect that axis's vocabulary.
 * Without that test the database's `is_postgres` branch leaks onto the cache axis and the guard
 * cheerfully reports that "the azure template enumerates postgres/mysql for cache" — which is how the
 * first draft of this read. Intersecting is also why no kind→module mapping is needed: the values
 * identify the axis, so the scan can stay whole-template and stupid. */
function enumeratedValues(cloud, axisValues) {
	const src = tf[cloud];
	const axis = new Set(axisValues.map((v) => v.toLowerCase()));
	/** Keep only the members of `set` that belong to THIS axis's vocabulary, lowercased. What makes the
	 * whole-template scan safe: without it the database's `is_postgres` branch leaks onto the cache axis. */
	const onAxis = (set) => new Set([...set].map((h) => h.toLowerCase()).filter((v) => axis.has(v)));

	// BRANCHED — the values the template actually builds something for: an equality branch or a
	// lookup map. This is the only evidence that counts as an implementation.
	const branched = new Set();
	for (const m of src.matchAll(/var\.(?:\w*engine\w*)\s*==\s*"([A-Za-z0-9_]+)"/g)) branched.add(m[1]);
	for (const m of src.matchAll(/engine_map\s*=\s*\{([^}]+)\}/g)) {
		for (const v of m[1].matchAll(/(\w+)\s*=/g)) branched.add(v[1]);
	}

	// CLAIMED — the values a `validation { contains([…]) }` block accepts. Deliberately NOT treated as
	// implementation: azure-db validates `contains(["postgres", "mysql"], var.engine)` and then gates
	// every single resource on `is_postgres`. The variable's own validation advertises support the
	// module does not have, which is precisely how #1382 read as fine to anyone skimming the template.
	const claimed = new Set();
	for (const m of src.matchAll(/contains\(\[([^\]]+)\],\s*var\.\w*engine\w*\)/g)) {
		for (const v of m[1].matchAll(/"([A-Za-z0-9_]+)"/g)) claimed.add(v[1]);
	}

	const b = onAxis(branched);
	return b.size > 0 ? { supported: b, claimed: onAxis(claimed) } : null;
}

// ── check C · no carrier ────────────────────────────────────────────────────────────
// The axis has to reach tofu at all. If no emitted tfvar is derived from the engine family, the
// user's choice is dropped between the canvas and the plan.

/** Does the provider READ the engine the user chose for this kind, anywhere?
 *
 * Not "does it emit a tfvar whose name contains 'engine'" — AWS carries the DB engine inside the
 * `rds_config` object, so a name-shaped test calls a working path broken. Not a windowed scan around
 * `config.Databases` either: the providers touch that collection twice (once in the map literal for
 * `create_*`, once in the detail block), so a naive split lands on the gap between them and reports
 * every cloud as broken. Reading the field is the honest minimum — a provider that never looks at the
 * choice cannot be carrying it.
 *
 * The receiver names are the discriminator: every provider does `db := config.Databases[0]` /
 * `cache := config.Caches[0]`, so `db.Engine…` and `cache.Engine…` are unambiguous per axis. */
const CARRIER_READS = {
	database: /resolveDBEngine|db\.EngineFamily|db\.Engine\b/,
	cache: /resolveCacheEngine|cache\.EngineFamily|cache\.Engine\b/,
};

/** Does this cloud's provider read the engine the user chose for this kind at all?
 *
 * A kind with no `CARRIER_READS` probe has no engine axis to drop, so it passes by construction —
 * an unprobed kind must never read as broken. */
function hasCarrier(cloud, kind) {
	const probe = CARRIER_READS[kind];
	if (!probe) return true;
	return probe.test(goSrc[cloud]);
}

// ── day-2 posture · gate coverage (#1494) ───────────────────────────────────────────
// Everything above is a DAY-1 question: could this offer ever be built. #1440 added the day-2 half
// — after the first apply, does changing a tunable CONVERGE in place or force-replace the data? —
// as `AnalyzeDay2` in test/e2e/t2_day2_offer.go, which reads a real `tofu plan -json`.
//
// This generator cannot answer that question, and pretending otherwise would be the worst outcome.
// Whether an argument forces replacement lives in the PROVIDER SCHEMA, not in template text; only a
// real plan resolves it. So what is derived here is the honest half — GATE COVERAGE:
//
//   which resource backs this offer, and would `AnalyzeDay2` actually catch a hazard on it?
//
// A hazard is only caught if the backing type is in `day2StatefulTypes`. A data-bearing type MISSING
// from that map is worse than an unguarded offer: the gate returns Safe, so the offer looks proven.
// That is a real defect this found — Azure's template moved to `azurerm_managed_redis` (the retired
// `azurerm_redis_cache` cannot be created any more) while the map still listed only the old types.
//
// Where the backing type is inside an EXTERNAL registry module (all of AWS: cloudposse/rds-cluster,
// cloudposse/elasticache-redis, terraform-aws-modules/elasticache//serverless-cache) the type is not
// in this repo's text at all. That is reported as `?` — not-evaluable — the same honesty
// packages/core/verify applies to a control the plan cannot show. It is a known limit, not debt: the
// real-apply harness (#1495) is what resolves it.

const DAY2_GATE_SRC = `${ROOT}/test/e2e/t2_day2_offer.go`;

/** The resource types `AnalyzeDay2` treats as data-bearing, read from the Go map itself.
 *
 * Deliberately PARSED rather than restated here. A second copy of the list in JS would drift from
 * the gate exactly the way the gate drifted from the templates — which is the bug this surfaces. */
function gatedTypes() {
	if (!existsSync(DAY2_GATE_SRC)) return null;
	const src = readFileSync(DAY2_GATE_SRC, "utf8");
	const map = src.match(/var day2StatefulTypes = map\[string\]bool\{([\s\S]*?)\n\}/);
	if (!map) return null;
	return new Set([...map[1].matchAll(/"([a-z0-9_]+)":\s*true/g)].map((m) => m[1]));
}

const GATED = gatedTypes();

// The gate the day-2 rows are measured against has to EXIST, and it has to be established BEFORE
// anything is measured against it — same class as the two reader self-checks at the top of this file.
// If t2_day2_offer.go moves or its map is renamed, every day-2 cell reads `blind`: a wall of false
// failures, and with `--matrix` a checked-in board rewritten to say every cloud is unguarded. Say
// what actually happened instead of publishing the consequence of it.
if (!GATED) {
	console.error(
		`\n✗ offer parity — could not read \`day2StatefulTypes\` from ${DAY2_GATE_SRC}.\n` +
			`  The day-2 rows measure gate coverage against that map; without it they mean nothing.\n` +
			`  If the gate moved, update DAY2_GATE_SRC in this script.\n`,
	);
	process.exit(1);
}

/** Tokens that make a resource type (or module source) data-bearing FOR AN AXIS.
 *
 * A detector, not a source of truth — its only job is to notice a candidate the gate may not know
 * about, so a miss is what costs. Whole-token matching keeps the neighbours out: `cosmosdb` and
 * `dynamodb` are single tokens, so neither trips `db`, and `google_firestore_database` never reads
 * as a relational offer. Anything this over-collects surfaces as a cell to resolve, never as silence. */
const DAY2_AXIS_TOKENS = {
	database: /(?:^|_)(?:db|rds|sql|postgres|postgresql|mysql)(?:_|$)/,
	cache: /(?:^|_)(?:cache|redis|valkey|memorystore|kvstore|elasticache)(?:_|$)/,
};

/** Companion resources that sit ON a data service without holding its data — users, grants, logical
 * databases, firewall rules, admin bindings, subnet/parameter groups. Replacing one of these loses
 * nothing, so they are not the offer's backing resource. A type the GATE already claims is never
 * filtered by this: `day2StatefulTypes` outranks the heuristic. */
const DAY2_SIDECAR =
	/_(?:user|user_group|user_group_association|database|account|account_privilege|privilege|firewall_rule|rule|administrator|backup_policy|subnet_group|parameter_group|group|policy|association|role|secret|version|alias|configuration|endpoint|link)$/;

/** Is this resource type the data-bearing backing of THIS axis?
 *
 * The axis test always applies — being in the gate says a type holds data, never WHICH axis it is on.
 * An early version let gate membership skip it, and `alicloud_kvstore_instance` (Redis) duly turned up
 * as a candidate backing for `database:postgres`. Gate membership overrides only the sidecar
 * heuristic, which it outranks by construction: the gate is the authority on what holds data. */
const isDay2Backing = (type, kind) =>
	DAY2_AXIS_TOKENS[kind].test(type) && (GATED?.has(type) || !DAY2_SIDECAR.test(type));

/** Which variant a declaration names, by its own text and the path it lives at.
 *
 * `google_memorystore_instance` is GCP's Valkey resource but says "memorystore", and AWS's serverless
 * cache says neither — so a name test alone cannot finish the job. It does not have to: an
 * unattributed candidate is resolved by elimination below, which is also what correctly reads a
 * single passthrough resource (one `alicloud_db_instance` for both engines) as serving every variant. */
const VARIANT_ALIASES = {
	postgres: ["postgres", "postgresql", "pgsql"],
	mysql: ["mysql", "mariadb"],
	redis: ["redis"],
	valkey: ["valkey", "memorystore"],
};

/** The single variant this text names, or null when it names none or more than one.
 *
 * Ambiguity returns null on purpose: a declaration matching two variants is not evidence for either,
 * and `day2Backings` resolves what is left by elimination rather than by guessing here. */
function namedVariant(text, variants) {
	const hay = text.toLowerCase();
	const hits = variants.filter((v) => (VARIANT_ALIASES[v] ?? [v]).some((a) => hay.includes(a)));
	return hits.length === 1 ? hits[0] : null;
}

/** Every data-bearing declaration on a cloud's axis: in-repo resources, and the external modules
 * that hide one. Each carries the variant it names (or null → resolved by elimination). */
function day2Candidates(cloud, kind, variants) {
	const found = [];
	for (const file of tfFiles[cloud]) {
		for (const m of file.text.matchAll(/resource\s+"([a-z0-9_]+)"\s+"([A-Za-z0-9_-]+)"/g)) {
			if (!isDay2Backing(m[1], kind)) continue;
			found.push({ form: "resource", ref: m[1], variant: namedVariant(`${m[1]} ${file.path}`, variants) });
		}
		// An EXTERNAL module source (registry / git — not a `./` path) is an opaque box: the types it
		// creates are not in this repo, so the gate's coverage of them cannot be read from here.
		for (const m of file.text.matchAll(/module\s+"([A-Za-z0-9_-]+)"\s*\{([\s\S]*?)\n\}/g)) {
			const src = m[2].match(/\n\s*source\s*=\s*"([^"]+)"/);
			if (!src || /^\.{1,2}\//.test(src[1])) continue;
			if (!DAY2_AXIS_TOKENS[kind].test(src[1].replace(/[^a-z0-9]+/gi, "_"))) continue;
			found.push({
				form: "module",
				ref: src[1],
				variant: namedVariant(`${m[1]} ${src[1]} ${file.path}`, variants),
			});
		}
	}
	// Dedupe — the same module/resource can be declared in more than one stack file.
	const seen = new Map();
	for (const f of found) {
		const key = `${f.form}:${f.ref}:${f.variant ?? ""}`;
		if (!seen.has(key)) seen.set(key, f);
	}
	return [...seen.values()];
}

/** Resolve backing declarations onto the variants a cloud actually offers.
 *
 * Two passes: the ones that name a variant claim it, then what is left is matched by elimination —
 * a lone unattributed candidate against a lone unclaimed variant is that variant's; a lone
 * unattributed candidate against SEVERAL unclaimed variants is a passthrough serving all of them,
 * which is the same "passthrough is not a gap" reading check B already takes. */
function day2Backings(cloud, kind, variants) {
	const offeredHere = variants.filter((v) => offeredOn(cloud, kind, v));
	const cands = day2Candidates(cloud, kind, variants);
	const backing = {};
	for (const c of cands) if (c.variant && offeredHere.includes(c.variant)) backing[c.variant] ??= c;

	// Exactly ONE unattributed declaration serves every variant still unclaimed — that is a passthrough
	// (one `alicloud_db_instance` for both engines), the same reading check B takes. SEVERAL
	// unattributed declarations are not resolvable from here: pairing them off by order would be a
	// coin flip printed as a fact, so they are left unassigned and the cell says so.
	const looseCands = cands.filter((c) => !c.variant);
	const unclaimed = offeredHere.filter((v) => !backing[v]);
	if (looseCands.length === 1) for (const v of unclaimed) backing[v] = looseCands[0];
	else if (looseCands.length > 1) for (const v of unclaimed) backing[v] = { form: "ambiguous", ref: null, cands: looseCands };
	return backing;
}

// Only offered cells get a day-2 row — an excluded or unoffered offer has no day 2 to have — so
// these three are the whole vocabulary.
const DAY2_STATE = { guarded: "🟡", blind: "🚫", "not-evaluable": "?" };

// ── run ─────────────────────────────────────────────────────────────────────────────

const findings = [];
const knownDebt = [];
const cells = []; // for the matrix
const day2Cells = [];

for (const [kind, variants] of Object.entries(AXES)) {
	for (const cloud of CLOUDS) {
		const carrier = hasCarrier(cloud, kind);
		const enumerated = enumeratedValues(cloud, variants);
		const backings = day2Backings(cloud, kind, variants);
		for (const variant of variants) {
			const offer = `${kind}:${variant}`;
			const exc = excluded(offer, cloud);
			let state = "ok";
			let detail = "";
			// A cloud that offers exactly ONE engine on this axis has no choice to drop, so the
			// carrier check does not apply to it: the defect this guard names is "a CHOICE the product
			// presents and then discards". Azure and Alibaba offer only Redis, so their provider not
			// reading `cache.Engine` is not a silent gap — there is nothing for the user to pick.
			// Without this they would sit on the baseline forever for no reachable reason, and a list
			// with permanent residents stops being read.
			const offeredHere = variants.filter((v) => offeredOn(cloud, kind, v));
			const singleChoice = offeredHere.length <= 1;

			if (!offeredOn(cloud, kind, variant)) {
				// Not offered on this cloud at all — the canvas floor already hides it. Not a gap, and
				// not an exclusion either: there is nothing to exclude from.
				cells.push({ kind, variant, cloud, state: "not-offered", detail: "" });
				continue;
			}
			if (exc) {
				state = "excluded";
				detail = exc.reason ?? "";
				// NOT re-read here, unlike the option and carrier passes (#1864), and the asymmetry is the
				// point. On those two axes "excluded" denies one checkable thing: the switch is not carried.
				// On THIS axis it denies something a text reader cannot pin down — Hetzner's `database:postgres`
				// and `cache:valkey` entries say the engine is not carried BY OPENTOFU, while CloudNativePG
				// and the Valkey chart provision it perfectly well. Measured, both come out "the cloud builds
				// this", so the obvious re-read reports the file's two most settled entries as false ceilings.
				// A check that reds correct entries does not get shipped to catch a hypothetical one; that is
				// the same trade already made for `gated-carrier` above.
			} else if (!carrier && !singleChoice) {
				state = "no-carrier";
				detail = `the ${kind} engine never reaches tfvars on ${cloud} — the choice is dropped between the canvas and the plan.`;
			} else if (enumerated && !enumerated.supported.has(variant.toLowerCase())) {
				state = "missing-branch";
				const advertised = enumerated.claimed.has(variant.toLowerCase())
					? ` The variable's own validation accepts "${variant}", which is why this reads as supported to anyone skimming the template.`
					: "";
				detail =
					`the ${cloud} template branches to ${[...enumerated.supported].join("/")} for ${kind} — ` +
					`${variant} has no branch, so selecting it provisions nothing.${advertised}`;
			}
			const known = recordVerdict(offer, cloud, state);
			cells.push({ kind, variant, cloud, state, detail, known });
			if (known) knownDebt.push({ shape: state, cloud, offer, detail, known });
			else if (GAP_STATES.has(state)) findings.push({ shape: state, cloud, offer, detail, known: null });

			// ── day-2 · gate coverage for this same cell ───────────────────────────────────
			// Only cells the product actually offers get a day-2 row: an excluded or unoffered
			// offer has no day-2 to have.
			if (state === "excluded") continue;
			const back = backings[variant];
			let d2 = "not-evaluable";
			let ref = "—";
			let note = "no data-bearing declaration found in the template — only a real plan can show one.";
			if (back?.form === "resource") {
				ref = back.ref;
				d2 = GATED?.has(back.ref) ? "guarded" : "blind";
				note = d2 === "guarded"
					? "replace/delete of this resource is a data-loss hazard the day-2 gate catches."
					: `\`${back.ref}\` is data-bearing but is NOT in \`day2StatefulTypes\` — the day-2 gate would call replacing it Safe.`;
			} else if (back?.form === "module") {
				ref = back.ref;
				note = "the backing type is inside an external module — not visible in template text; the real-apply harness resolves it.";
			} else if (back?.form === "ambiguous") {
				note =
					`${back.cands.length} data-bearing declarations on this axis (${back.cands.map((c) => `\`${c.ref}\``).join(", ")}) ` +
					`and none names a variant — which one backs this offer is not decidable from template text.`;
			}
			// A variant switch that crosses backing resources is a delete + create, not an in-place
			// change — the shape `AnalyzeDay2` catches via its delete half (aws redis↔valkey is a
			// module swap; gcp swaps google_redis_instance for google_memorystore_instance).
			const others = Object.entries(backings).filter(([v, b]) => v !== variant && b?.ref !== back?.ref);
			if (back && others.length) {
				note += ` Switching to ${others.map(([v]) => `\`${v}\``).join("/")} crosses backing resources — a delete + create, not an in-place change.`;
			}
			day2Cells.push({ kind, variant, cloud, offer, state: d2, ref, note });
			if (d2 === "blind") {
				findings.push({ shape: "day2-blind", cloud, offer, detail: note, known: null });
			}
		}
	}
}

// ── option-level pass (`<kind>:<variant>:<option>`) ──────────────────────────────────
//
// One cell per (kind × variant × option × cloud). Carriage is measured cloud-level; engine coverage
// is measured per variant, because the two fail independently — alibaba drops `iam_auth` entirely,
// while gcp carried it and still had no MySQL branch until #1505.

const optionCells = [];

for (const [kind, keys] of Object.entries(OPTIONS)) {
	const variants = AXES[kind];
	if (!variants) continue; // no variant axis → no `<kind>:<variant>:<option>` cell to name
	for (const { key, gate } of keys) {
		const offerBase = `${kind}:${key}`;
		// Everything not adjudicated per engine is measured per cloud by the carrier pass below.
		if (!ADJUDICATED.has(offerBase)) continue;
		const carriers = optionCarriers(key);
		for (const cloud of CLOUDS) {
			const coverage = carriers.has(cloud) ? optionEngineCoverage(cloud, key, variants) : null;
			for (const variant of variants) {
				if (!offeredOn(cloud, kind, variant)) {
					optionCells.push({ kind, variant, key, cloud, state: "not-offered", detail: "" });
					continue;
				}
				const offer = `${kind}:${variant}:${key}`;
				const exc = excluded(offer, cloud);

				// A cell the CANVAS withholds. Two things must hold, and neither is automatic:
				// the withholding must be recorded in the yaml (a gate is a decision, and an
				// unrecorded decision is indistinguishable from a bug), and the recorded reason
				// must be the one the user actually sees — otherwise the matrix documents a
				// product that no longer exists.
				const withheld = gate?.(cloud, variant);
				if (withheld && withheld.state !== "live") {
					if (!exc) {
						optionCells.push({ kind, variant, key, cloud, state: "excluded", detail: withheld.reason });
						findings.push({
							shape: "undocumented-gate",
							cloud,
							offer,
							detail:
								`the canvas withholds \`${key}\` here (keylessCells says "${withheld.state}"), but ` +
								`nothing in ${EXCLUSIONS} records why. A gate is a decision — record it or ungate it.`,
						});
						continue;
					}
					if (normalizeReason(exc.reason) !== normalizeReason(withheld.reason)) {
						optionCells.push({ kind, variant, key, cloud, state: "excluded", detail: withheld.reason });
						findings.push({
							shape: "reason-drift",
							cloud,
							offer,
							detail:
								`the canvas shows one reason and the matrix another, so one of them is wrong ` +
								`wherever a user reads it.\n      canvas: ${withheld.reason}\n      yaml:   ${exc.reason}`,
						});
						continue;
					}
					optionCells.push({ kind, variant, key, cloud, state: "excluded", detail: exc.reason ?? "" });
					continue;
				}

				let state = "ok";
				let detail = "";
				if (exc) {
					state = "excluded";
					detail = exc.reason ?? "";
					// Same re-read the carrier pass does (#1864). This path already cross-checks an
					// exclusion's PROSE against the canvas's own withholding reason above; what it never
					// checked is the thing the prose asserts. `carriers` is L4 only, so a hit here means
					// the provider does read the field — weaker evidence than the carrier pass's derived
					// test, and deliberately so: `missing-branch` is a real way to carry a switch and still
					// not honor it per engine, which is a gap and not a false ceiling.
					if (carriers.has(cloud) && !(coverage && !coverage.has(variant))) {
						excludedMeasured.push({ offer, cloud, honoredNow: true, entry: exc });
					}
				} else if (!carriers.has(cloud)) {
					state = "no-carrier";
					detail =
						`the canvas offers \`${key}\` on every cloud, but the ${cloud} provider never reads ` +
						`\`${goFieldFor(key)}\` — the switch is dropped between the canvas and the plan, so a user ` +
						`turns it on and nothing happens.`;
				} else if (coverage && !coverage.has(variant)) {
					state = "missing-branch";
					detail =
						`the ${cloud} template gates \`${key}\` per engine (${[...coverage].join("/")}) and ${variant} ` +
						`has no branch — carried into tfvars, then honored for the other engine only.`;
				}
				const known = recordVerdict(offer, cloud, state);
				optionCells.push({ kind, variant, key, cloud, state, detail, known });
				if (known) knownDebt.push({ shape: state, cloud, offer, detail, known });
				else if (GAP_STATES.has(state)) findings.push({ shape: state, cloud, offer, detail, known: null });
			}
		}
	}
}

// ── carrier pass · `<kind>:<option>` · L4 → L5 ───────────────────────────────────────
//
// The pass above can only name a cell `<kind>:<variant>:<option>`, so a kind with no variant axis —
// bucket, network, dns, registry, nosql, queue, secret — could not be measured AT ALL. That is not a
// small corner: `bucket:versioning` is offered on five clouds and Azure drops it on the floor, and
// this file has carried a comment naming that exact example as something it could not see.
//
// Widening the key to `<kind>:<option>` makes those kinds measurable. What makes them WORTH
// measuring is the second hop:
//
//   L4  the cloud's provider carries the switch into a tfvars key       (traced, see above)
//   L5  the template DECLARES that key and a resource/module argument READS it
//
// L5 is new. Nothing in this repo walked variables.tf → resource argument before: the Go-side tests
// stop at "is it emitted", the tofu-side test stops at "is it declared", and a variable that is
// declared and read by nothing sits exactly in the gap between them. It is a real defect shape —
// GCP declares `uniform_access` on `cloud_storage_buckets`, the provider fills it in every apply,
// and the bucket resource hardcodes `uniform_bucket_level_access = true`. The switch is carried the
// whole way and then ignored.
//
// THREE RULES this pass inherits rather than reinvents:
//
//  · UNMEASURABLE IS NOT DECLARED. `list(any)` declares no fields, so "the template does not declare
//    this key" is not a statement that variable can make. Those cells are judged on the READ half
//    alone and the missing half is REPORTED, never guessed. Alibaba is the whole reason: it declares
//    zero object types, so every nested key on that cloud is in this state.
//  · PASSTHROUGH IS NOT A GAP. `mergeProviderConfig` copies any `provider_config` key onto a
//    same-named tofu variable, so a DECLARED-BUT-UNEMITTED variable is the escape hatch working as
//    designed. This pass never enumerates template variables looking for unemitted ones; it starts
//    from the switch and asks where it goes.
//  · EVIDENCE BEFORE ACCUSATION. An option is only held to the parity rule when its KIND is
//    demonstrably provisioned through tofu — some option of that kind is provider-carried, or the
//    template declares and reads a name spelled exactly like it, on a cloud that offers it.
//    `service:probe_enabled` fails that test (a health check is a Helm chart's business, not
//    OpenTofu's) and is correctly never accused. `registry:vulnerability_scanning` passes it, on the
//    strength of its sibling `immutable_tags`, and is correctly accused on all four clouds.

/** The clouds a surface offer is shown on, restricted to the clouds that ship a template. */
const offeredCloudsFor = (offer) => CLOUDS.filter((c) => (offer.offeredOn ?? []).includes(c));

/** Evidence that an option is a tofu-carried capability: a provider carries it, or a template both
 * declares and reads a name spelled exactly like it. Either one is enough; neither means this guard
 * has nothing to measure and should say nothing. */
function optionEvidence(offer) {
	const clouds = offeredCloudsFor(offer);
	return {
		carried: clouds.filter((c) => traceOption(c, offer.key).carried),
		named: clouds.filter((c) => TF_WIRING[c].isDeclared(offer.key) && TF_WIRING[c].isRead(offer.key)),
	};
}

/** Kinds held to the parity rule — see EVIDENCE BEFORE ACCUSATION above. */
const MEASURED_KINDS = new Set(
	SURFACE.offers
		.filter((o) => {
			const e = optionEvidence(o);
			return e.carried.length > 0 || e.named.length > 0;
		})
		.map((o) => o.kind),
);

/**
 * Does this tfvars key survive into the plan on this cloud?
 *
 * A ROOT key is a tofu variable: it must be declared BY THE ROOT TEMPLATE and read as `var.<key>`.
 * Root-scoped, not tree-scoped, because that is the only scope the question has an answer in —
 * OpenTofu drops a tfvars value whose variable the root module does not declare, so a submodule
 * declaring the same name changes nothing about whether the value arrives. The module hop stays on
 * the READ half, where a value genuinely does travel.
 *
 * A NESTED key is one attribute of one entry of a list-of-objects, so "declared" means the object
 * type names it — anywhere on the chain, including inside the module the root is threaded into —
 * and "read" means some argument reaches for it (`each.value.<key>`, `try(each.value.<key>, …)`).
 */
function evaluateWiring(cloud, site) {
	const w = TF_WIRING[cloud];
	const nested = site.root !== null && site.root !== site.key;
	if (!nested) {
		const declared = w.hasRootVariable(site.key);
		const read = w.isReadOnChain(site.key, site.key, true);
		return { ok: declared && read, declared, read, shapeKnown: true, rootMissing: false };
	}
	const shape = w.shapeIsDeclared(site.root);
	const declared = w.isDeclared(site.key);
	const read = w.isReadOnChain(site.root, site.key);
	// shape === null: the provider emits a root tfvar this template never declared.
	// shape === false: `any`/`list(any)` — the declaration half is unmeasurable, so only READ counts.
	return {
		ok: shape !== null && read && (declared || shape === false),
		declared,
		read,
		shapeKnown: shape === true,
		rootMissing: shape === null,
	};
}

const carrierCells = [];
const unmeasurableShapes = [];
const gatedCarriage = [];

for (const offer of SURFACE.offers) {
	const offerBase = `${offer.kind}:${offer.key}`;
	// Already adjudicated at the finer `<kind>:<variant>:<option>` granularity — measuring it twice
	// would put the same cell on the board under two names.
	if (ADJUDICATED.has(offerBase)) continue;
	if (!MEASURED_KINDS.has(offer.kind)) continue;

	for (const cloud of offeredCloudsFor(offer)) {
		// An in-cluster carriage claim is settled BEFORE the OpenTofu trace, because the trace can only
		// ever say "no carrier" here — the component writes no tfvar — and that answer would be true and
		// useless. What IS checkable is the claim itself, so check that instead.
		const ic = inClusterAck(offerBase, cloud);
		if (ic) {
			const v = verifyInClusterCarriage(ic);
			// A redundant claim is also a wrong one: if OpenTofu carries and derives the switch today, the
			// entry says the offer arrives by a route it no longer needs, and the matrix would credit the
			// wrong mechanism. Mirrors the `exclusions:` false-ceiling check for the same reason.
			const t = traceOption(cloud, offer.key);
			const alsoCarried = t.carried && t.sites.some((s) => evaluateWiring(cloud, s).ok && s.strength === "derived");
			inClusterMeasured.push({ offer: offerBase, cloud, entry: ic, verdict: v, alsoCarried });
			carrierCells.push({
				kind: offer.kind, key: offer.key, cloud,
				state: "carried-in-cluster",
				detail: ic.reason ?? "", by: ic.by ?? "",
			});
			continue;
		}

		const exc = excluded(offerBase, cloud);
		if (exc) {
			// An exclusion is a CLAIM — "this cloud will never honor this offer" — and until now it was
			// the one claim in this file nothing re-read. The cell was recorded and skipped before it was
			// ever traced, so an entry stayed green whether its ceiling was real or had quietly become
			// false, and moving a cell from `baseline:` to `exclusions:` converted a measured gap into a
			// permanently unmeasured one (#1864).
			//
			// The half a text reader CAN settle is settled here: is the switch carried and derived in our
			// own code right now? If it is, the ceiling is false no matter what the prose says. Whether a
			// stated ceiling is TRUE of the cloud's product stays out of reach — that is a claim about
			// someone else's roadmap, and this guard only reads ours.
			const t = traceOption(cloud, offer.key);
			const honoredNow = t.carried && t.sites.some((s) => evaluateWiring(cloud, s).ok && s.strength === "derived");
			excludedMeasured.push({ offer: offerBase, cloud, honoredNow, entry: exc });
			carrierCells.push({ kind: offer.kind, key: offer.key, cloud, state: "excluded", detail: exc.reason ?? "" });
			continue;
		}

		const trace = traceOption(cloud, offer.key);
		let state = "ok";
		let detail = "";
		if (!trace.carried) {
			state = "no-carrier";
			detail =
				`the canvas offers \`${offer.key}\` on ${cloud}, but nothing reachable from ` +
				`\`(*${cloud}Provider).ProviderTfvars\` reads \`${goFieldFor(offer.key)}\` — the switch never ` +
				`becomes a tfvar, so a user sets it and the plan is identical either way.`;
		} else {
			const verdicts = trace.sites.map((s) => ({ site: s, ...evaluateWiring(cloud, s) }));
			const wired = verdicts.filter((v) => v.ok);
			// STRENGTH decides `ok`, not just wiredness. A key whose value moves with the switch
			// (`derived`) proves the switch decides something. A key that is merely WRITTEN inside an
			// `if <field>` branch (`gated`) proves only that the switch decides whether some key
			// appears — not that the key is about the switch. Azure files Cosmos DB Synapse Link
			// analytical storage under the point-in-time-recovery toggle that way, and grading the two
			// the same is what printed that cell as implemented.
			const honored = wired.find((v) => v.site.strength === "derived");
			const gatedOnly = !honored && wired.length > 0;
			if ((honored ?? wired[0]) && !(honored ?? wired[0]).shapeKnown) {
				const v = honored ?? wired[0];
				unmeasurableShapes.push({
					offer: offerBase,
					cloud,
					detail:
						`\`${v.site.root}\` is typed \`any\` — the template declares no fields, so whether ` +
						`\`${v.site.key}\` is an accepted key cannot be read from it. Judged on the resource ` +
						`argument that reads it, which is the only half that IS measurable here.`,
				});
			}
			if (gatedOnly) {
				state = "gated-carrier";
				detail =
					`the ${cloud} provider only ever writes ${wired.map((x) => `\`${x.site.key}\``).join("/")} ` +
					`INSIDE an \`if <${goFieldFor(offer.key)}>\` branch, never as the value of the switch itself. ` +
					`That establishes the switch decides whether the key appears; it does not establish that the ` +
					`key IS this feature, and a text reader cannot tell those apart. Confirm by inspection, or ` +
					`assign the switch's value so the wiring proves itself.`;
				gatedCarriage.push({ offer: offerBase, cloud, detail, sites: wired.map((x) => x.site) });
			} else if (!honored) {
				const v = verdicts[0];
				state = "unwired-template";
				const carriedAs = verdicts.map((x) => `\`${x.site.key}\``).join("/");
				detail = v.rootMissing
					? `the ${cloud} provider emits ${carriedAs} inside \`${v.site.root}\`, which the ${cloud} ` +
						`template does not declare at all — tofu never sees the value.`
					: v.read
						? `${carriedAs} is read by the ${cloud} template but declared nowhere in the shape it ` +
							`arrives in — the value is silently defaulted away.`
						: `the ${cloud} provider carries \`${offer.key}\` into tfvars as ${carriedAs}` +
							`${v.site.root && v.site.root !== v.site.key ? ` (on \`${v.site.root}\`)` : ""}, and no ` +
							`resource or module argument in the template reads it. Declared${v.declared ? "" : " nowhere"}, ` +
							`consumed by nothing: the switch is dropped one hop before the plan.`;
			}
		}

		// `gated-carrier` reaches this the same way a 🚫 does. It is unhonored, so it carries its
		// baseline entry (a ⚠️ cell is boardable) and it keeps that entry alive (a ⚠️ cell is not a
		// fix). Both halves live in `recordVerdict`; neither is re-decided here.
		const known = recordVerdict(offerBase, cloud, state);
		const ack = state === "gated-carrier" ? wiredAck(offerBase, cloud) : null;
		carrierCells.push({ kind: offer.kind, key: offer.key, cloud, state, detail, known, ack });
		if (known) knownDebt.push({ shape: state, cloud, offer: offerBase, detail, known });
		else if (GAP_STATES.has(state)) findings.push({ shape: state, cloud, offer: offerBase, detail, known: null });
		// An UNDECLARED ⚠️ is the #1829/#1830 hole: neither boarded as debt nor acknowledged as
		// reviewed wiring, and previously the only unhonored state that could reach here and exit 0.
		else if (state === "gated-carrier" && !ack)
			findings.push({ shape: UNDECLARED_GATED, cloud, offer: offerBase, detail, known: null });
	}
}

// The same anti-silence rule the option pass takes, applied to the carrier pass: a measured offer
// that produced ZERO cells has stopped being measured, and a measurement that quietly shrinks its
// own vocabulary reports success on less than it did yesterday.
for (const offer of SURFACE.offers) {
	const offerBase = `${offer.kind}:${offer.key}`;
	if (ADJUDICATED.has(offerBase) || !MEASURED_KINDS.has(offer.kind)) continue;
	if (carrierCells.some((c) => c.kind === offer.kind && c.key === offer.key)) continue;
	findings.push({
		shape: "unmeasured-offer",
		cloud: "—",
		offer: offerBase,
		detail:
			`its kind is provisioned through tofu, but this offer produced ZERO cells — the carrier pass ` +
			`is no longer measuring it and would go green whatever the clouds do. Usually this means ` +
			`\`offeredOn\` in ${OFFER_SURFACE} went empty (regenerate it) or every cloud that offers it lost ` +
			`its template directory.`,
	});
}

// An adjudicated offer that produces NO cells has stopped being measured, and the failure mode of
// that is silence: the grid disappears from the matrix, its exclusions become dead entries, and the
// guard reports success on a vocabulary that shrank. That is precisely how gating a switch used to
// delete an offer, so the tripwire is the line that makes the trap loud rather than invisible.
for (const offerBase of ADJUDICATED) {
	const [kind, key] = offerBase.split(":");
	if (optionCells.some((c) => c.kind === kind && c.key === key)) continue;
	findings.push({
		shape: "unmeasured-offer",
		cloud: "—",
		offer: offerBase,
		detail:
			`adjudicated, but it produced ZERO cells this run — the guard is no longer measuring it and ` +
			`would go green whatever the clouds do. Usually this means the option gained a canvas gate ` +
			`that KNOWN_GATES cannot read (so it was skipped), the field was renamed, or its kind lost ` +
			`its variant axis. Teach the guard the gate; do not drop the offer.`,
	});
}

// One glyph per state, shared by the matrix and by the ratchet's rendering of it below — because a
// state that reads 🚫 in the grid and something else in the table beside it is the contradiction this
// file already shipped once.
const GLYPH = {
	ok: "🟡",
	excluded: "—",
	"missing-branch": "🚫",
	"no-carrier": "🚫",
	"unwired-template": "🚫",
	// Its OWN glyph, not 🟡 and not 🚫. Neither of those is true: the wiring exists, and whether it
	// wires the right thing is exactly what could not be established.
	"gated-carrier": "⚠️",
	// Honored, but not by OpenTofu — a component the platform installs into the cluster delivers it.
	// Distinct from 🟡 because the two hops this grid measures were NOT what established it (they
	// cannot be: an in-cluster component writes no tfvar), and emphatically distinct from the `—` of
	// an exclusion, which is read as "this cloud cannot". A reader choosing a cloud needs to know the
	// offer arrives, and by which mechanism, because the failure modes differ.
	"carried-in-cluster": "☸️",
	"not-offered": "·",
};

// ── the ratchet ─────────────────────────────────────────────────────────────────────
//
// ADJUDICATED HERE, ABOVE THE MATRIX, AND REPORTED FURTHER DOWN. The two halves are split on purpose
// and each position is load-bearing:
//
//  · the VERDICTS have to exist before the matrix is written, because the matrix RENDERS them. The
//    board's baseline table used to be rendered from the yaml while the grid beside it was rendered
//    from the measurement, so a run with a drifted entry wrote a checked-in document saying two
//    different things about one cell (`⚠️ #1811` in the grid, `🚫 no-carrier #1811` in the table) and
//    then exited 1 — leaving the contradiction committed and the reader to pick.
//  · the FAILURE REPORTS stay at the bottom, after every measurement is printed, with exactly one
//    exit. That order is its own fix, recorded below.
//
// A baseline entry records that a gap EXISTS and is boarded. Exactly four things can have happened to
// one since it was written, and the whole value of the mechanism is telling them apart:
//
//   · the cell is HONORED now          → the entry is stale and must be deleted, or the baseline
//                                        rots into a permanent amnesty and stops meaning anything;
//   · the cell is still unhonored, in
//     a DIFFERENT state than recorded  → the gap changed shape. It was not fixed. Saying "fixed,
//                                        delete this" here is how a still-broken cell loses its
//                                        board record, so it is reported as a change with both
//                                        states named, and the entry is updated rather than deleted;
//   · the cell was NOT MEASURED        → this run has nothing to say about it. Not a fix, not a
//                                        drift, and NOT a deletion request — the entry points at a
//                                        cell the guard can no longer see, which is a real thing to
//                                        report and the opposite of a congratulation;
//   · nothing changed                  → tracked, not failing.
//
// `state:` on each entry is what makes the second case visible at all. Without it a 🚫 that drifts to
// ⚠️ is indistinguishable from a 🚫 that never moved, and the only two available answers are both
// wrong: demand the entry back, or say nothing. `measuredCells` is what makes the third visible, and
// it was missing for the same reason: emptiness was read as evidence when it was the absence of it.

/** The cells this run reached a verdict on for a baseline entry — empty ⇒ nothing was measured. */
const measuredFor = (b) => measuredCells.filter((c) => c.offer === b.offer && (b.cloud === "*" || c.cloud === b.cloud));

/** The distinct states a baseline entry's cell reproduced in this run. Empty ⇒ no gap was FOUND —
 * which is only a fix if the cell was measured at all, hence `measuredFor` above. */
const reproducedStates = (b) => [
	...new Set(
		unhonoredCells.filter((c) => c.offer === b.offer && (b.cloud === "*" || c.cloud === b.cloud)).map((c) => c.state),
	),
];

/**
 * What the guard can still see that would account for an entry producing no measured cell.
 *
 * Facts it can check, never a guess dressed as one — an empty string when nothing it can see accounts
 * for the entry, which is worth printing as "unexplained" rather than papering over with a plausible
 * story. This is the difference between "the offer went away, delete the entry" and "the measurement
 * broke, fix the measurement", and only the reader can make that call.
 *
 * @param {object} b  a `baseline:` entry from infra/offer-exclusions.yaml
 * @returns {string}  a short factual clause, or "" when the guard cannot account for it
 */
function unmeasuredBecause(b) {
	const clouds = b.cloud === "*" ? CLOUDS : [b.cloud];
	if (b.cloud !== "*" && !CLOUDS.includes(b.cloud)) {
		return `there is no \`${b.cloud}\` template directory under ${TEMPLATES} — the guard measures no cell on a cloud it cannot read`;
	}
	if (excluded(b.offer, b.cloud)) {
		return `this cell now carries an EXCLUSION as well, and an excluded cell is never measured — one cell cannot be both permanently excluded and boarded as debt`;
	}
	const parts = b.offer.split(":");
	const kind = parts[0];
	if (parts.length === 3) {
		const [, variant, key] = parts;
		if (!ADJUDICATED.has(`${kind}:${key}`)) {
			return `\`${kind}:${key}\` is no longer adjudicated per engine, so no \`<kind>:<variant>:<option>\` cell is produced for it at all`;
		}
		if (!clouds.some((c) => offeredOn(c, kind, variant))) {
			return `the catalog floor no longer offers \`${kind}\` variant \`${variant}\` on ${clouds.join("/")}`;
		}
		return "";
	}
	const tail = parts[1];
	if ((AXES[kind] ?? []).includes(tail)) {
		if (!clouds.some((c) => offeredOn(c, kind, tail))) {
			return `the catalog floor no longer offers \`${kind}\` variant \`${tail}\` on ${clouds.join("/")}`;
		}
		return "";
	}
	const surfaceOffer = SURFACE.offers.find((o) => o.kind === kind && o.key === tail);
	if (!surfaceOffer) {
		return `${OFFER_SURFACE} lists no \`${tail}\` switch under \`${kind}\` — the offer was renamed, removed, or that file is stale`;
	}
	if (!MEASURED_KINDS.has(kind)) {
		return `\`${kind}\` is no longer held to the carrier rule — no switch of that kind has tofu evidence this run, so every cell of the kind is unmeasured`;
	}
	if (!clouds.some((c) => (surfaceOffer.offeredOn ?? []).includes(c))) {
		return `\`offeredOn\` in ${OFFER_SURFACE} no longer lists ${clouds.join("/")} for \`${b.offer}\` — the canvas is not recorded as offering it there`;
	}
	return "";
}

/** Entries whose cell was MEASURED and came out honored — the ratchet's one "delete this" case. */
const stale = [];
/** Entries still reproducing, in a state other than the one recorded. */
const drifted = [];
/** Entries carrying no `state:` at all — the ratchet cannot tell "fixed" from "changed" for these. */
const unstated = [];
/** Entries pointing at a cell this run never measured — no verdict, in either direction. */
const unmeasured = [];
for (const b of baseline) {
	const states = reproducedStates(b);
	if (measuredFor(b).length === 0) unmeasured.push({ entry: b, why: unmeasuredBecause(b) });
	else if (states.length === 0) stale.push(b);
	else if (!b.state) unstated.push({ entry: b, states });
	else if (!states.includes(b.state)) drifted.push({ entry: b, states });
}

/** `wired:` entries whose cell no longer reproduces ⚠️ — the acknowledgement outlived what it answered. */
const staleWired = [];
// The same ratchet the baseline gets, for the same reason: an amnesty nobody re-checks stops meaning
// anything, and this one is easier to rot than the baseline because it is not attached to an issue
// somebody is chasing. Two ways an entry goes stale, and they are different facts:
//   · the cell is measured and is no longer ⚠️  → the wiring was strengthened (or removed); the
//     acknowledgement now answers a question nobody is asking;
//   · the cell was not measured at all         → the guard cannot see the cell any more, so the
//     acknowledgement is unfalsifiable, which is the state a declaration must never be allowed to sit in.
for (const w of wired) {
	const measured = measuredCells.filter((c) => c.offer === w.offer && (w.cloud === "*" || c.cloud === w.cloud));
	if (measured.length === 0) staleWired.push({ entry: w, why: unmeasuredBecause(w) || "no cell was measured for it this run" });
	else if (!measured.some((c) => c.state === "gated-carrier"))
		staleWired.push({ entry: w, why: `the cell is \`${[...new Set(measured.map((c) => c.state))].join("/")}\` now, not \`gated-carrier\`` });
}

/**
 * How a baseline entry's cell actually came out THIS RUN, for the board's State column.
 *
 * Rendered from the measurement, never from the entry's own `state:`. The two can disagree, and when
 * they do the recorded value is the stale one — printing it as the answer beside a grid printing the
 * measured one is how one generated file came to say `🚫 no-carrier` and `⚠️` about the same cell in
 * the same commit. The recorded value survives here only as provenance, clearly marked as such.
 *
 * @param {object} b  a `baseline:` entry from infra/offer-exclusions.yaml
 * @returns {string}  a markdown table cell
 */
function boardState(b) {
	const boarded = b.state ? ` (boarded as \`${b.state}\`)` : "";
	if (measuredFor(b).length === 0) return `— not measured this run${boarded}`;
	const states = reproducedStates(b);
	if (states.length === 0) return `✅ honored — entry is stale${boarded}`;
	const shown = states.map((s) => `${GLYPH[s] ?? ""} \`${s}\``.trim()).join(" / ");
	return b.state && states.includes(b.state) ? shown : `${shown}${boarded}`;
}

// ── matrix ──────────────────────────────────────────────────────────────────────────

if (writeMatrix) {
	const axes = Object.entries(AXES);
	let md = `<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- GENERATED by apps/console/scripts/check-offer-parity.mjs --matrix — do not edit by hand. -->

# Offer parity — what the canvas offers vs what each cloud can build

Every row is something a user can **choose**. Every cell is whether that cloud can honor it. The rule
this enforces is already in \`CLAUDE.md\`: a per-cloud change covers all clouds in the same pass, and a
cloud that cannot is an **explicit documented exclusion, never a silent gap**.

Deliberately finer-grained than the proof grid derived in [\`PROGRAMME.md\`](../../PROGRAMME.md), whose
single "all kinds" granularity is what let Azure MySQL hide: the kind was present, the *variant* was not.

Legend: 🟡 implemented, not yet proven on a real apply · ✅ real-apply proof in the e2e ledger ·
🚫 offered but unbuildable (tracking issue in the cell) · ⚠️ carried only as a branch guard — the
wiring exists but the code does not show that it wires *this* feature (see the carrier grid) ·
— documented exclusion · · not offered on this cloud (the canvas floor already hides it)

**A cell never goes ✅ from this generator.** It only knows what the code says; only the main-gated
nightly can promote a cell, and it does so in the e2e parity board.

`;
	for (const [kind, variants] of axes) {
		md += `\n## ${kind} engines\n\n| Offer | ${CLOUDS.join(" | ")} |\n|---|${CLOUDS.map(() => ":---:").join("|")}|\n`;
		for (const variant of variants) {
			const row = CLOUDS.map((c) => {
				const cell = cells.find((x) => x.kind === kind && x.variant === variant && x.cloud === c);
				// A 🚫 carries its tracking issue: a matrix that says "broken" without saying "and here
				// is where that is being handled" just becomes a wall of red people stop reading.
				return cell.known?.issue ? `${GLYPH[cell.state]} ${cell.known.issue}` : GLYPH[cell.state];
			});
			md += `| \`${variant}\` | ${row.join(" | ")} |\n`;
		}
	}

	// ── option-level offers · a grid per option ────────────────────────────────────────
	// A grid rather than a row list: an option is offered per (engine × cloud) exactly like a variant,
	// and the thing worth seeing at a glance is which CELLS honor it — that is the shape that hid
	// MySQL keyless.
	if (optionCells.length) {
		md += `\n## Option-level offers — a switch inside an offer\n
Not every offer is an engine choice. \`iam_auth\` is a switch in the inspector, so it makes its own
per-cloud × per-engine promise, one the variant grids above cannot see — which is why shipping MySQL
keyless broken was un-catchable until #1508.

Some of these switches are now GATED in the canvas (\`iam_auth\` is, since #1510: the inspector reads
the same \`keylessCells\` table the renderer does and disables the toggle, with the reason, on a cell
that cannot honor it). A gate does not remove the offer from this board — it would then be possible
to silence the guard by adding one. A gated cell shows —, and the reason below is checked against the
one the user actually sees, so the two cannot drift.

A cell is 🚫 when the cloud's provider never reads the option (the switch is dropped between the
canvas and the plan), or when the template gates it per engine and this engine has no branch.\n`;
		for (const key of [...new Set(optionCells.map((c) => c.key))]) {
			const kind = optionCells.find((c) => c.key === key).kind;
			md += `\n### \`${kind}\` · \`${key}\`\n\n| Offer | ${CLOUDS.join(" | ")} |\n|---|${CLOUDS.map(() => ":---:").join("|")}|\n`;
			for (const variant of AXES[kind]) {
				const row = CLOUDS.map((c) => {
					const cell = optionCells.find((x) => x.key === key && x.variant === variant && x.cloud === c);
					if (!cell) return GLYPH["not-offered"];
					return cell.known?.issue ? `${GLYPH[cell.state]} ${cell.known.issue}` : GLYPH[cell.state];
				});
				md += `| \`${variant}\` | ${row.join(" | ")} |\n`;
			}
		}
	}

	// ── carrier grid · one row per option, one column per cloud ────────────────────────
	// The variant grids above cannot hold these: `bucket:versioning` has no engine axis to be a row
	// of. One grid for the lot is also the right shape for what it measures — the question is
	// per-cloud and nothing else, so a row per option reads at a glance.
	if (carrierCells.length) {
		md += `\n## Carrier coverage — does the switch reach the plan?\n
Every row is a switch in the inspector on a kind with no engine choice, so it makes a promise
per-cloud and nothing else. Two hops are checked, and a cell is 🚫 if either one is missing:

1. **L4 · carrier** — something reachable from \`(*<cloud>Provider).ProviderTfvars\` reads the field
   and turns it into a tfvars key. Traced through the call graph, not grepped per file: Azure's
   secrets are built by \`buildGCPSecrets\` in gcp_provider.go (a grep would score that a gap), and
   GCP's \`buildFirestoreDatabases\` is dead code (a grep would score that carriage).
2. **L5 · template** — that key is declared in the template *and* a resource or module argument
   reads it. A variable declared and read by nothing is a gap: GCP's \`uniform_access\` is filled in
   on every apply and the bucket resource hardcodes the value it would have set.

L4 also grades HOW the switch becomes a key, because the two ways are not equally good evidence. A
key whose value is the switch (\`"fifo_queue": *q.Ordered\`) can only be about the switch. A key that
is merely *written inside* an \`if <switch>\` branch with a value of its own
(\`if t.PointInTimeRecovery { entry["analytical_storage_enabled"] = true }\`) shows the switch decides
whether the key appears — not that the key is that feature. Those two lines look identical to a text
reader and are not the same thing: Cosmos DB analytical storage is Synapse Link column storage,
while point-in-time recovery is continuous backup. So a cell carried only that way is ⚠️, never 🟡,
and is listed below with the key it writes so it can be confirmed — or rewritten to assign the
switch's own value, which makes the wiring prove itself.

This proves the WIRING is present. It does not prove the resource BEHAVES — that needs a real apply,
which is the [e2e ledger](../../demos/proofs/provisioning-e2e-log.md)'s job, not this generator's.

| Offer | ${CLOUDS.join(" | ")} |\n|---|${CLOUDS.map(() => ":---:").join("|")}|\n`;
		for (const offer of SURFACE.offers) {
			const rows = carrierCells.filter((c) => c.kind === offer.kind && c.key === offer.key);
			if (!rows.length) continue;
			const row = CLOUDS.map((c) => {
				const cell = rows.find((x) => x.cloud === c);
				if (!cell) return GLYPH["not-offered"];
				return cell.known?.issue ? `${GLYPH[cell.state]} ${cell.known.issue}` : GLYPH[cell.state];
			});
			md += `| \`${offer.kind}:${offer.key}\` | ${row.join(" | ")} |\n`;
		}

		// The ⚠️ cells, named, with the key each one actually writes. A glyph on its own would just
		// relocate the problem: "something about this cell is weaker" is not reviewable, and the whole
		// complaint against the 🟡 it replaces was that it hid WHICH key the switch turned into.
		if (gatedCarriage.length) {
			md += `\n### ⚠️ Carried only as a branch guard\n
Each of these reaches the plan, and the plan does change with the switch. What the code does not show
is that the key it writes *is* the feature the switch names — that is a question about the cloud's
product, not about the wiring, so it is confirmed by a person once and by a real apply after that.

| Offer | Cloud | Key the branch writes | Where |
|---|---|---|---|
`;
			for (const g of gatedCarriage) {
				const keys = g.sites.map((s) => `\`${s.key}\``).join(", ");
				const where = [...new Set(g.sites.map((s) => `\`${s.fn}\``))].join(", ");
				md += `| \`${g.offer}\` | ${g.cloud} | ${keys} | ${where} |\n`;
			}
		}
	}

	// ── day-2 · one row per (offer × cloud) ────────────────────────────────────────────
	// A row rather than a second grid, on purpose. The day-2 signal is not one glyph: it is WHICH
	// resource backs the offer, WHICH external module hides it, and whether switching variant crosses
	// resources. A 4×6 day-2 grid would render as near-uniform 🟡 with one `?` column — a whole matrix
	// to say one thing — and would have nowhere to put the part that is actually worth reading. This
	// is the same shape the documented-exclusions table below already uses for the same reason.
	if (day2Cells.length) {
		md += `\n## Day-2 posture — would a hazard be caught?

Day 1 asks *could this ever be built*. Day 2 asks *what happens when you change it afterwards*: does a
new engine version or size CONVERGE in place, or force-replace the data? That question is answered from
a real \`tofu plan -json\` by \`AnalyzeDay2\` ([\`test/e2e/t2_day2_offer.go\`](../../test/e2e/t2_day2_offer.go))
— it cannot be answered from template text, because whether an argument forces replacement lives in the
provider schema.

What IS derivable here, and all this table claims, is **gate coverage**: the resource backing each offer,
and whether \`day2StatefulTypes\` knows it — because a data-bearing type the gate does not know is worse
than an unguarded one. The gate returns *Safe*, so the offer looks proven when nothing checked it.

One row per offer this cloud actually offers (an excluded offer has no day 2 to have). Legend:
🟡 backing resource is in the repo **and** guarded — a hazard would be caught, awaiting a real-apply
proof · 🚫 data-bearing but **not** in \`day2StatefulTypes\` — the gate would pass it vacuously ·
? not evaluable from template text (the type is inside an external module; only a real plan shows it)

As with day 1, **no cell goes ✅ from here.** The proof is a real apply recorded in
[\`demos/proofs/provisioning-e2e-log.md\`](../../demos/proofs/provisioning-e2e-log.md) and promoted into the
generated half of [\`PROGRAMME.md\`](../../PROGRAMME.md).

| Offer | Cloud | Backing resource | Day-2 | Note |
|---|---|---|:---:|---|
`;
		for (const c of day2Cells) {
			const ref = c.ref === "—" ? "—" : `\`${c.ref}\``;
			md += `| \`${c.offer}\` | ${c.cloud} | ${ref} | ${DAY2_STATE[c.state]} | ${c.note} |\n`;
		}
	}

	// Rendered ABOVE the exclusions, and that ordering is the point: these cells are honored, and a
	// reader who meets `—` first will have already concluded the cloud cannot do it.
	if (carriedInCluster.length) {
		md += `\n## Carried in-cluster — honored, but not by OpenTofu\n
A ☸️ cell means the cloud **does** honor the offer, through a component the platform installs into
the cluster rather than through a resource in the template. The carrier grid above cannot see these:
it checks that a tfvar is declared and read by a resource argument, and an in-cluster component
writes no tfvar at all. That is a limit of the measurement, not of the cloud.

These are not exclusions — nothing here is unavailable — and not debt. Each names the predicate that
decides which clouds the component ships for, and the guard re-reads it on every run: if the
predicate stops listing the cloud, the entry fails until it is corrected.

| Offer | Cloud | Delivered by | Predicate re-read | What you get |
|---|---|---|---|---|
`;
		for (const e of carriedInCluster) {
			md += `| \`${e.offer}\` | ${e.cloud} | ${e.by ?? ""} | \`${e.predicate ?? ""}\` | ${e.reason ?? ""} |\n`;
		}
	}

	if (exclusions.length) {
		md += `\n## Documented exclusions\n\n| Offer | Cloud | Reason |\n|---|---|---|\n`;
		for (const e of exclusions) md += `| \`${e.offer}\` | ${e.cloud} | ${e.reason ?? ""} |\n`;
	}

	// The `wired:` acknowledgements, rendered for the same reason the baseline's reasons are: an
	// undocumented decision is indistinguishable from an oversight. Without this table a reader sees a
	// bare ⚠️ in the grid and cannot tell whether it is the reviewed kind or the not-yet-looked-at
	// kind — which is exactly the ambiguity #1829/#1830 were about, reintroduced in the artifact the
	// board is read from.
	if (wired.length) {
		md += `\n## Reviewed branch-guard wirings\n
A ⚠️ cell means the switch decides whether a key appears, but the code cannot show that the key *is*
the feature the switch names. These are the ones a person has read and confirmed. They are not
exclusions — the cloud does honor the offer — and not debt. Every other ⚠️ cell is on the baseline
above with an issue; a ⚠️ cell in neither list fails the build.

| Offer | Cloud | What was checked |
|---|---|---|
`;
		for (const w of wired) md += `| \`${w.offer}\` | ${w.cloud} | ${w.reason ?? ""} |\n`;
	}

	// The baseline's reasons, rendered — because they were written to be read.
	//
	// Every 🚫 above carries its tracking issue and nothing else, so the only thing the board said
	// about a known gap was its number. The reason each entry carries — what a user who picks that
	// switch actually gets — was stored, never printed: `baselined()` results are kept as `known` and
	// only `known.issue` is ever read. The file's own header promised the opposite ("printed verbatim
	// in the matrix"), so ninety lines of prose written for a reader had no reader. That is the same
	// defect shape as everything else on this board: a document that overstates its code.
	if (baseline.length) {
		md += `\n## Known gaps on the baseline\n
Not exclusions. Each is an offer a cloud genuinely cannot honor today, already boarded, with the
issue that tracks it. They do not fail the build; a NEW gap does. The list **ratchets**: when a cell
is measured and comes out honored the guard fails until its entry is deleted, so it can only shrink.

The **state** column is what this run MEASURED, not what the entry records — the two can disagree,
and when they do the run is the current fact. Three readings are worth knowing:

- a state on its own — the gap reproduced exactly as boarded;
- a state with *(boarded as …)* — the gap **changed shape**. It was not fixed. 🚫 → ⚠️ is a change in
  the wrong direction: the switch still is not shown to do what it says, and now the code does not
  even show that the key it writes is this feature. The guard reports it and keeps the entry;
- *not measured this run* — the guard produced no cell here, so it has **nothing to say** about
  whether the gap is still there. Not a fix. Usually the cloud stopped being offered the switch, or
  the generated offer surface is stale.

Only a cell that was measured and came out honored is asked for its entry back.

| Offer | Cloud | State (measured) | Issue | What a user gets today |
|---|---|---|---|---|
`;
		for (const b of baseline) {
			md += `| \`${b.offer}\` | ${b.cloud} | ${boardState(b)} | ${b.issue ?? "—"} | ${normalizeReason(b.reason)} |\n`;
		}
	}

	md += `\n---\n\nRegenerate with \`pnpm -C apps/console run check:offer-parity -- --matrix\`. CI runs the guard on every PR.\n`;
	writeFileSync(MATRIX_OUT, md);
	console.log(`✓ wrote ${MATRIX_OUT}`);
}

// ── report ──────────────────────────────────────────────────────────────────────────
//
// EVERYTHING MEASURED IS PRINTED BEFORE ANYTHING IS ADJUDICATED, and there is exactly one exit at
// the bottom. The ratchet used to `process.exit(1)` the instant a baseline entry stopped reproducing
// — which meant the run that had just decided a cell was ⚠️ never got to say so. The congratulation
// was printed and the evidence contradicting it was suppressed by the same statement. A guard that
// withholds its own measurements at the moment it fails is asking to be believed instead of checked,
// and this one failed in the direction of "delete the record of a live gap".

const day2Summary = day2Cells.reduce((acc, c) => ({ ...acc, [c.state]: (acc[c.state] ?? 0) + 1 }), {});

// Every boarded cell, WITH THE STATE it reproduced in. The state is not decoration: it is the thing
// the entry's `state:` is checked against below, so printing it is what lets a reader confirm a drift
// report — or spot one the entry has not caught up with — without running anything else.
if (knownDebt.length) {
	console.log(`  ${knownDebt.length} known cell(s) on the baseline (tracked, not failing):`);
	for (const f of knownDebt) {
		console.log(`    · ${f.cloud} ${f.offer}  [${f.shape}]${f.known?.issue ? `  → ${f.known.issue}` : ""}`);
	}
}

// Kinds the carrier pass declined to accuse, and why. Reported rather than silent: "this kind is not
// provisioned through tofu" is a claim, and a claim nobody can see is a claim nobody can correct.
const unmeasuredKinds = [...new Set(SURFACE.offers.map((o) => o.kind))].filter((k) => !MEASURED_KINDS.has(k));
if (unmeasuredKinds.length) {
	console.log(
		`  ${unmeasuredKinds.length} kind(s) not held to the carrier rule (no tofu evidence for any of ` +
			`their switches): ${unmeasuredKinds.join(", ")}. A switch on one of these is honored somewhere ` +
			`other than OpenTofu, or by nothing at all — this guard cannot tell which.`,
	);
}

// Cells whose DECLARATION half could not be read because the variable carrying them is typed `any`.
// Said out loud rather than folded into the pass rate: the guard measured half a hop there, and a
// number that does not say so is a number that will be believed to mean more than it does.
if (unmeasurableShapes.length) {
	console.log(`  ${unmeasurableShapes.length} cell(s) measured on the READ half only (a carrier variable is \`any\`):`);
	for (const u of unmeasurableShapes) console.log(`    · ${u.cloud} ${u.offer} — ${u.detail}`);
}

// Cells whose only carriage is a branch guard. Printed every run, by name and with the key each one
// writes, because the whole point of grading them separately is that a person can settle in seconds
// what no text reader can settle at all — and a signal nobody is shown is a signal nobody acts on.
if (gatedCarriage.length) {
	console.log(`  ${gatedCarriage.length} cell(s) carried ONLY as a branch guard (⚠️ in the matrix, not 🟡):`);
	for (const g of gatedCarriage) {
		console.log(`    · ${g.cloud} ${g.offer} — writes ${g.sites.map((s) => `\`${s.key}\``).join(", ")} in ${g.sites[0].fn}`);
	}
}

// ── adjudication · every failure is reported, then ONE exit ─────────────────────────

let failed = false;

// The one legitimate "delete this" case: the cell was MEASURED this run and came out honored.
if (stale.length) {
	failed = true;
	console.error(`\n✗ offer parity — ${stale.length} baseline entr(y|ies) measured HONORED:\n`);
	for (const b of stale) console.error(`  ${b.cloud} · ${b.offer}${b.issue ? `  (${b.issue})` : ""}`);
	console.error(`
Fixed — thank you. Now delete these from the \`baseline:\` section of infra/offer-exclusions.yaml so the
list keeps meaning what it says. The baseline ratchets down; it never grows on its own.

Every cell listed here WAS measured this run: the guard read the cloud's code for it and found no
unhonored state. That is the only claim this report makes, and it is the only report that asks for a
deletion. Two other things can happen to an entry and NEITHER appears here — a gap that is still a gap
in a different state ("changed shape"), and an entry whose cell this run did not measure at all ("did
not measure"). Both are printed separately, and neither asks you to delete anything.
`);
}

// The entry points at a cell this run produced no verdict for. Reported as its own thing because it
// is neither a fix nor a drift, and calling it either would be a claim the run cannot support.
if (unmeasured.length) {
	failed = true;
	console.error(`\n✗ offer parity — ${unmeasured.length} baseline entr(y|ies) point at a cell this run did NOT measure:\n`);
	for (const u of unmeasured) {
		console.error(`  ${u.entry.cloud} · ${u.entry.offer}${u.entry.issue ? `  (${u.entry.issue})` : ""}`);
		console.error(`      ${u.why || "the guard cannot account for this from anything it reads — treat it as a broken measurement until shown otherwise"}`);
	}
	console.error(`
NOT a fix, and the guard is NOT asking for these entries back. The cell did not become honored — it
stopped being LOOKED AT, so this run has nothing to say about whether the gap is still there. The gap
may be shipping untouched right now; nothing here measured it either way.

Treating this as "fixed" is how the record of a live gap gets deleted by a green build, and it is
reachable in one line: drop a cloud from \`offeredOn\` and the cell simply stops existing.

Settle it from the cloud's side, then do ONE of:
  · the product genuinely stopped offering it there → the gap is gone WITH the offer. Delete the
    entry, and say so in the issue it references — that issue is now moot, not done.
  · the generated offer surface is stale → regenerate it (\`pnpm -C apps/console run gen:offer-surface\`) and
    re-run. The offer never went anywhere; ${OFFER_SURFACE} did.
  · the offer, its kind or its cloud was renamed, or a template directory moved → RE-KEY the entry to
    the name the guard measures now. The debt is unchanged; only its address moved.
  · the kind lost its last piece of tofu evidence → the carrier pass stopped holding it to the rule,
    so every cell of that kind is unmeasured rather than honored. Restore the evidence or record the
    kind's exclusion; do not let the whole kind fall off the board silently.
`);
}

// Still a gap, in a state other than the one on record. Emphatically not a fix.
if (drifted.length) {
	failed = true;
	console.error(`\n✗ offer parity — ${drifted.length} baseline entr(y|ies) changed shape:\n`);
	for (const d of drifted) {
		console.error(`  ${d.entry.cloud} · ${d.entry.offer}${d.entry.issue ? `  (${d.entry.issue})` : ""}`);
		console.error(`      boarded as \`${d.entry.state}\`, now reproduces as \`${d.states.join("/")}\``);
	}
	console.error(`
NOT fixed. The gap is still there in a different shape, so the entry STAYS — update its \`state:\`, and
its \`reason:\` if what a user gets has changed with it.

\`unwired-template\` → \`gated-carrier\` is the one to read slowly: that cell did not improve, the
evidence got WEAKER. All the code now shows is that the switch decides whether some key appears, not
that the key is this feature. Deleting the entry there would remove the board record of a gap that is
still shipping — the silent deletion this list exists to prevent.
`);
}

// An entry the ratchet cannot adjudicate. Loud, because the alternative is a quiet half-check.
if (unstated.length) {
	failed = true;
	console.error(`\n✗ offer parity — ${unstated.length} baseline entr(y|ies) record no \`state:\`:\n`);
	for (const u of unstated) {
		console.error(`  ${u.entry.cloud} · ${u.entry.offer} — reproduces as \`${u.states.join("/")}\``);
	}
	console.error(`
Add \`state:\` with the value shown, next to \`issue:\`. It is what lets the ratchet tell "this was
fixed" from "this changed shape": without it a gap that drifts from 🚫 to ⚠️ reads exactly like one
that never moved, and the guard would have to guess which — it guessed "fixed" once already.
`);
}

if (staleWired.length) {
	failed = true;
	console.error(`\n✗ offer parity — ${staleWired.length} \`wired:\` acknowledgement(s) no longer answer anything:\n`);
	for (const s of staleWired) {
		console.error(`  ${s.entry.cloud} · ${s.entry.offer} — ${s.why}`);
	}
	console.error(`
A \`wired:\` entry says "a person read this branch guard and it does wire the feature". When the cell
stops being ⚠️ that sentence is about nothing, and an acknowledgement nobody re-checks is how an
amnesty becomes permanent — the same rot the baseline's stale check exists to prevent. Delete the
entry. If the cell was NOT MEASURED, do not delete it yet: the guard has lost sight of the cell, which
is a measurement bug, and deleting the entry hides it.
`);
}

// A `carried_in_cluster:` entry whose predicate no longer covers the cloud. This is the whole reason
// the section carries a `predicate:` at all: without it the entry would be prose, and prose is what
// let #1864 discharge a measured gap by reclassifying it.
const brokenInCluster = inClusterMeasured.filter((c) => !c.verdict.ok);
if (brokenInCluster.length) {
	failed = true;
	console.error(`\n✗ offer parity — ${brokenInCluster.length} \`carried_in_cluster:\` entr(y|ies) whose predicate no longer holds:\n`);
	for (const c of brokenInCluster) {
		console.error(`  ${c.cloud} · ${c.offer}${c.entry.by ? `  (${c.entry.by})` : ""}`);
		console.error(`      ${c.verdict.why}`);
	}
	console.error(`
A \`carried_in_cluster:\` entry says the offer IS honored on this cloud, by a component the platform
installs into the cluster rather than by OpenTofu. That is not a thing the carrier rule can see — L5
wants a tfvar read by a resource argument, and an in-cluster component writes none — so the entry
names the PREDICATE that decides per cloud and this guard re-reads it every run.

The predicate has stopped covering this cloud. Either the component genuinely no longer ships there,
in which case the offer is now unhonored and this belongs on the \`baseline:\` with an issue or in
\`exclusions:\`, or the entry names the wrong symbol. Do not delete the entry to make this pass — a
cell that quietly stops being honored is exactly what the ratchet exists to catch.
`);
}

// A `carried_in_cluster:` entry that OpenTofu has since made redundant. Same shape as the false
// ceiling below: the entry is not wrong about the offer being honored, it is wrong about BY WHAT, and
// the matrix would credit the wrong mechanism to a reader choosing a cloud.
const redundantInCluster = inClusterMeasured.filter((c) => c.verdict.ok && c.alsoCarried);
if (redundantInCluster.length) {
	failed = true;
	console.error(`\n✗ offer parity — ${redundantInCluster.length} \`carried_in_cluster:\` entr(y|ies) OpenTofu now carries anyway:\n`);
	for (const c of redundantInCluster) {
		console.error(`  ${c.cloud} · ${c.offer} — the template carries and derives this switch today.`);
	}
	console.error(`
The offer is honored twice over, and the entry names the wrong mechanism. Delete it: the cell then
measures like any other, and the ordinary reporting will confirm the OpenTofu route. Leaving it would
tell the matrix's readers that a cloud depends on an in-cluster component it does not need — and hide
a real regression later, because the entry would keep the cell green if the template carriage broke.
`);
}

// An exclusion that has come TRUE in our own code. The mirror of the baseline's stale check, and the
// last of the three sections to get one: `baseline:` ratchets down, `wired:` gets re-read, and until
// #1864 `exclusions:` was the only list that could sit unchallenged forever.
const falseCeilings = excludedMeasured.filter((c) => c.honoredNow);
if (falseCeilings.length) {
	failed = true;
	console.error(`\n✗ offer parity — ${falseCeilings.length} \`exclusions:\` entr(y|ies) the code now contradicts:\n`);
	for (const c of falseCeilings) {
		console.error(`  ${c.cloud} · ${c.offer}${c.entry.issue ? `  (${c.entry.issue})` : ""}`);
		console.error(`      recorded as: ${c.entry.reason ?? "(no reason given)"}`);
	}
	console.error(`
An \`exclusions:\` entry says the cloud will NEVER honor this offer. Each cell above is carried and
derived in our own provider code right now, so that sentence is false — and it is printed verbatim in
the public matrix, telling readers a thing we build is a thing we cannot.

Delete the entry. The cell then measures like any other: honored cells pass, and if it turns out to be
weakly wired the ordinary 🚫/⚠️ reporting will say so and it can be boarded instead.

This is the only half of an exclusion a guard reading our own text can settle. Whether a stated ceiling
is TRUE of the cloud's product is a claim about someone else's roadmap, and nothing here checks it —
which is exactly why an exclusion must never be used to retire a gap that is simply unfinished.
`);
}

if (findings.length) {
	failed = true;
	console.error(`\n✗ offer parity — ${findings.length} NEW offer(s) the product presents but a cloud cannot build:\n`);
	for (const f of findings) {
		console.error(`  [${f.shape}] ${f.cloud} · ${f.offer}`);
		console.error(`      ${f.detail}`);
	}
	console.error(`
Each of these is the state the cloud-parity rule forbids: offered, unbuildable, and silent.
Do one of three things — never a fourth:
  · fix it, so the offer builds;
  · record an EXCLUSION in infra/offer-exclusions.yaml, if the cloud genuinely cannot ever honor it;
  · add it to the BASELINE there with its tracking issue and \`state:\`, if it is real work that is
    already boarded.
`);
	if (findings.some((f) => f.shape === UNDECLARED_GATED)) {
		console.error(`An [${UNDECLARED_GATED}] finding is a different question from the rest, and "fix it" is usually
the wrong answer. The switch DOES reach the plan and the plan DOES differ — what no code can show is
whether the key the branch writes is the feature the switch names. Only a person can say. So say it:
  · \`wired:\` in infra/offer-exclusions.yaml — you read the branch and it does wire this feature.
    Not debt, not an exclusion; it stops failing and the matrix keeps showing ⚠️ with your reason.
  · \`baseline:\` with an issue and \`state: gated-carrier\` — the branch writes something else, or
    nobody has checked. That is real debt and belongs on the board.
Reaching ⚠️ by adding \`if x.Foo { tfvars["<already-wired key>"] = … }\` to silence a 🚫 lands here on
purpose: that edit changes the state without establishing anything, and this is the line that says so.
`);
	}
	if (findings.some((f) => f.shape === "day2-blind")) {
		console.error(`A [day2-blind] finding has exactly ONE fix, and it is a one-line one: add the resource type to
\`day2StatefulTypes\` in test/e2e/t2_day2_offer.go. It is not baseline material — an unguarded
data-bearing type does not report a gap, it reports SAFE, so nothing would ever come back to collect it.
`);
	}
}

if (failed) process.exit(1);

console.log(
	`✓ offer parity — ${cells.length} (offer × cloud) cells + ${optionCells.length} option cell(s) + ` +
		`${carrierCells.length} carrier cell(s), ${exclusions.length} documented exclusion(s), ` +
		`${baseline.length} on the baseline, ${wired.length} reviewed branch-guard wiring(s), ` +
		`${carriedInCluster.length} carried in-cluster, no NEW silent gaps.`,
);
console.log(
	`✓ day-2 gate coverage — ${day2Cells.length} offered cell(s): ` +
		`${day2Summary.guarded ?? 0} guarded, ${day2Summary["not-evaluable"] ?? 0} not evaluable from ` +
		`template text (external modules), 0 unguarded data-bearing types.`,
);
process.exit(0);
