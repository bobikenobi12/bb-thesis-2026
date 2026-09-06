// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Projects the console's shared zod schemas into `packages/core/validate` (#3670).
 *
 * Writes two files:
 *   - packages/core/validate/spec_gen.go            — the DECLARATIVE half, as Go data
 *   - packages/core/validate/testdata/validation-cases.json — the table for the half that is not
 *
 * Usage:
 *   pnpm -C apps/console run gen:go-validation          # regenerate
 *   pnpm -C apps/console run gen:go-validation:check    # non-zero if a committed file is stale
 *   pnpm -C apps/console run gen:go-validation:self-test  # exercise the generator's REFUSALS
 *
 * # Why this is not just `z.toJSONSchema`
 *
 * `z.toJSONSchema` drops what it cannot represent, silently and by design. Measured, not assumed:
 *
 *   z.toJSONSchema(z.string().min(1).refine(f))
 *   -> { "type": "string", "minLength": 1 }
 *
 * The `.refine` is gone and nothing says so. A generator built on that output would ship the CLI a
 * schema that LOOKS like the console's and enforces a fraction of it — which is worse than shipping
 * nothing, because the CLI would then be trusted.
 *
 * So this walks the schema's own node graph instead and classifies EVERY node:
 *
 *   projectable   -> a Step in spec_gen.go, cross-checked against z.toJSONSchema's output
 *   table         -> both sides implement it; validation-cases.json holds them to the same answers
 *   not-shared    -> declared, with a reason, and emitted as a record that carries no behaviour
 *   anything else -> the build FAILS, naming the node
 *
 * There is no fourth outcome and no default. Adding a `.refine()` to a registered schema and
 * forgetting about it is a red build, not a silently narrower CLI.
 *
 * # The invariant this serves
 *
 *   The CLI may only ever reject what the server would certainly reject.
 *
 * Drift may make the CLI too permissive — the server catches that on apply — but never make it
 * refuse valid input. That is why a rule whose server-side disposition is "drop" or "warn" is
 * declared with `severity: "warn"`, and why nothing here emits behaviour: a Step names a rule, and
 * packages/core/validate/rules.go is the only place a name becomes code.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
	APPS_PATH_MESSAGE,
	appsPathSchema,
	goTrimSpace,
	isValidAppsPath,
} from "@/lib/validations/apps-path";
import {
	iacVarKeySchema,
	isNotReservedTfvarKey,
	RESERVED_TFVAR_MESSAGE,
} from "@/lib/validations/byo-iac";
import { NETWORK_CIDR_MAX_PREFIX } from "@/lib/cloud-providers/cidr";
import {
	isCarvableFor,
	NETWORK_CIDR_CLOUDS,
	NETWORK_CIDR_SCHEMAS,
	networkCidrFloorMessage,
} from "@/lib/validations/network";
import { asRecord } from "@/lib/records";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/console/scripts -> repo root is three levels up.
const ROOT = resolve(HERE, "../../..");
const GO_OUT = resolve(ROOT, "packages/core/validate/spec_gen.go");
const GO_REL = "packages/core/validate/spec_gen.go";
const CASES_OUT = resolve(ROOT, "packages/core/validate/testdata/validation-cases.json");
const CASES_REL = "packages/core/validate/testdata/validation-cases.json";

/** The table's schema version. Bump only for a shape change, never for a value change. */
const CASES_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Discovery — walking a zod schema's own node graph
// ---------------------------------------------------------------------------------------------

/**
 * Why the generator refused. Assertions in the self-test match on the CODE, never the prose.
 *
 * The runtime array is the source and the type is derived from it, so `runSelfTest` can check that
 * every code is reached by a case. A hand-written second list would decay silently.
 */
export const REFUSAL_CODES = [
	"UNDECLARED",
	"STALE_DECLARATION",
	"FN_IDENTITY",
	"FN_UNIDENTIFIABLE",
	"UNSUPPORTED_NODE",
	"NON_STRING_BASE",
	"PROJECTION_LOST",
	"PATTERN_NOT_RE2",
	"NO_CASES",
	"NO_TS_IMPL",
	"DUPLICATE_DECLARATION",
	"NO_STEPS",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** A refusal to generate. Carries the code the self-test asserts on and prose for the human. */
export class Refusal extends Error {
	readonly code: RefusalCode;
	constructor(code: RefusalCode, message: string) {
		super(`[${code}] ${message}`);
		this.code = code;
		this.name = "Refusal";
	}
}

type DiscoveredNode =
	| { path: string; kind: "base"; type: string }
	| { path: string; kind: "optional" }
	| { path: string; kind: "nullable" }
	/** A zod check. `owner` is the schema node it hangs off, so its JSON Schema can be re-derived. */
	| { path: string; kind: "check"; check: string; def: Record<string, unknown>; owner: z.ZodType }
	| { path: string; kind: "transform" }
	| { path: string; kind: "unsupported"; detail: string };

/**
 * zod 4 hangs every node's shape off `_zod.def`.
 *
 * Deliberately NOT `asRecord`, which rebuilds a value from `Object.entries` and so sees only OWN
 * ENUMERABLE properties. `_zod` is neither on a zod schema, so `asRecord(schema)._zod` is
 * `undefined` and every node would read as an unknown type — a generator that refused everything,
 * which is a failure mode that at least announces itself, but a failure mode all the same.
 */
interface ZodInternals {
	_zod: { def: Record<string, unknown> };
}

/** Cast-free narrow: `in` narrowing gives the property as `unknown`, which is then checked. */
function hasZodInternals(v: unknown): v is ZodInternals {
	if (typeof v !== "object" || v === null || !("_zod" in v)) return false;
	const inner: unknown = v._zod;
	if (typeof inner !== "object" || inner === null || !("def" in inner)) return false;
	const def: unknown = inner.def;
	return typeof def === "object" && def !== null;
}

/** Reads a node's zod def, or an empty record when the value is not a zod node at all. */
function defOf(node: unknown): Record<string, unknown> {
	return hasZodInternals(node) ? node._zod.def : {};
}

/** Cast-free narrow onto a zod schema — a node with internals and a named type. */
function isZodType(v: unknown): v is z.ZodType {
	return hasZodInternals(v) && typeof v._zod.def.type === "string";
}

/**
 * Walks a schema depth-first in EVALUATION order and returns every node.
 *
 * Order is the contract: a wrapper evaluates its inner value first and its OWN checks last, a pipe
 * evaluates `in` then `out` then its own checks, and a transform rewrites the value every later
 * step sees. A Go side that ran the length bound against the UNTRIMMED value would refuse input the
 * server trims and accepts.
 *
 * ⚠️  EVERY node's own checks are collected on ONE exit path, deliberately.
 *
 * This function used to `return` from inside each switch arm and call `pushChecks` in only three of
 * the five. The two that forgot were `optional` and `nullable` — which is where `.nullish()` puts
 * the outermost wrapper of `appsPathSchema`, so a `.refine()` appended AFTER `.nullish()` (the
 * natural place to write one: it is the last link in the chain) was never discovered at all. Not
 * projected, not tabled, not refused: the generator printed "up to date" and exited 0.
 *
 * That is the exact failure this whole file exists to prevent, reintroduced by an omission in the
 * file itself. So the structure no longer allows the omission: the arms below decide what a node's
 * CHILDREN are, and nothing else, and the checks are pushed once at the bottom for every node
 * including the ones with no children.
 */
export function discover(schema: unknown, prefix = "$"): DiscoveredNode[] {
	const out: DiscoveredNode[] = [];
	if (!isZodType(schema)) {
		return [{ path: prefix, kind: "unsupported", detail: `not a zod schema (${typeof schema})` }];
	}
	const def = defOf(schema);
	const type = typeof def.type === "string" ? def.type : "<unknown>";

	switch (type) {
		case "optional":
			out.push({ path: prefix, kind: "optional" });
			out.push(...discover(def.innerType, `${prefix}/inner`));
			break;
		case "nullable":
			out.push({ path: prefix, kind: "nullable" });
			out.push(...discover(def.innerType, `${prefix}/inner`));
			break;
		case "pipe":
			out.push(...discover(def.in, `${prefix}/in`));
			out.push(...discover(def.out, `${prefix}/out`));
			break;
		case "transform":
			out.push({ path: prefix, kind: "transform" });
			break;
		case "string":
		case "number":
			// A number base is DISCOVERED but not projectable: packages/core/validate evaluates
			// string values only. Reporting it as a base node rather than as an unknown type is what
			// lets `project` say "teach the evaluator this type" instead of "no idea what this is".
			out.push({ path: prefix, kind: "base", type });
			break;
		default:
			// Every other zod type — object, array, union, record, enum, and the wrappers that change
			// a value rather than widening it (default, catch, readonly). None is unsupported
			// forever; each is unsupported UNTIL somebody adds both a projection here and an
			// evaluator in packages/core/validate. Reporting it rather than walking past it is the
			// point: `optional` and `nullable` are projected because they only ever WIDEN, and
			// nothing else here can claim that.
			out.push({ path: prefix, kind: "unsupported", detail: type });
			break;
	}

	// The node's OWN checks, last, for every node kind. A node type that carries no `checks` array
	// (a transform, for one) contributes nothing here, which is the difference between "has none"
	// and "was never asked".
	const checks = def.checks;
	if (Array.isArray(checks)) {
		checks.forEach((check, i) => {
			const cdef = defOf(check);
			const name = typeof cdef.check === "string" ? cdef.check : "<unknown>";
			out.push({ path: `${prefix}#${i}:${name}`, kind: "check", check: name, def: cdef, owner: schema });
		});
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Declarations — the two escape routes for a node JSON Schema cannot carry
// ---------------------------------------------------------------------------------------------

/** One row of a rule's conformance table. `want` is computed by RUNNING the TS implementation. */
interface CaseInput {
	/** Semantic, so a diff names the boundary that moved rather than an index. */
	id: string;
	in: string;
}

type Disposition =
	| {
			/** Both sides implement the rule; the generated table holds them to the same answers. */
			via: "table";
			/** The name in packages/core/validate's registry. */
			goRule: string;
			/** The single integer argument a parameterised rule takes. */
			goArg?: number;
			/**
			 * `warn` when the server's disposition is NOT rejection (it drops, ignores or normalises
			 * the value). The CLI must not turn a server-side drop into a client-side refusal.
			 */
			severity: "reject" | "warn";
			/** The console's own message, so both surfaces say the same words. */
			message: string;
			why: string;
			cases: CaseInput[];
	  }
	| {
			/** Applied by one surface only, on purpose. Emitted as a record, never as behaviour. */
			via: "not-shared";
			rule: string;
			why: string;
	  };

interface Declaration {
	/** The discovered node's path. A check's path includes its kind, so a kind change breaks it. */
	path: string;
	/**
	 * For a `custom` check (`.refine`), the exact function zod stored — matched by IDENTITY, so
	 * swapping the predicate for a different one is a red build rather than a silent change.
	 *
	 * `null` is the explicit acknowledgement that the node is a `.superRefine`, whose closure zod
	 * does not keep anywhere reachable. Declaring one is allowed; doing so accidentally is not.
	 */
	fn?: unknown;
	disposition: Disposition;
}

interface SpecRegistration {
	id: string;
	why: string;
	schema: z.ZodType;
	declarations: Declaration[];
}

// ---------------------------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------------------------

interface GoStep {
	kind: "min_length" | "max_length" | "pattern" | "rule" | "transform";
	severity: "reject" | "warn";
	message: string;
	length?: number;
	pattern?: string;
	rule?: string;
	ruleArg?: number;
}

interface GoSpec {
	id: string;
	why: string;
	optional: boolean;
	nullable: boolean;
	steps: GoStep[];
	unshared: { rule: string; why: string }[];
}

/** The rule tables the projection collects: rule name -> the TS implementation and its cases. */
interface TableRule {
	kind: "predicate" | "transform";
	cases: { id: string; in: string; arg?: number; want: string | boolean }[];
}

/**
 * Constructs JS-regex source that RE2 will accept, or refuses.
 *
 * The refusal list is the constructs RE2 genuinely lacks — lookaround, backreferences and JS-style
 * named groups. `\/` is rewritten to `/`: the escape exists only because a JS regex literal is
 * slash-delimited, and it is not a valid RE2 escape.
 *
 * A pattern that slips through anyway is still caught: packages/core/validate's
 * TestEverySpecRuleResolves compiles every emitted pattern with the real RE2 and fails on it. This
 * function exists to fail EARLIER and with a better message, not to be the only line of defence.
 */
export function toRE2(source: string): string {
	const unsupported: [RegExp, string][] = [
		[/\(\?=/, "lookahead (?=...)"],
		[/\(\?!/, "negative lookahead (?!...)"],
		[/\(\?<[=!]/, "lookbehind (?<=...) / (?<!...)"],
		[/\(\?<[A-Za-z_]/, "JS named group (?<name>...) — RE2 spells it (?P<name>...)"],
		[/\\[1-9]/, "backreference"],
	];
	for (const [probe, what] of unsupported) {
		if (probe.test(source)) {
			throw new Refusal(
				"PATTERN_NOT_RE2",
				`the pattern /${source}/ uses ${what}, which RE2 (Go's regexp) does not have. ` +
					`Rewrite the rule so the declarative half is RE2-expressible, or move it to the ` +
					`conformance table where both sides implement it.`,
			);
		}
	}
	return source.replace(/\\\//g, "/");
}

/** The JSON Schema keyword a projectable check must survive into, and how to read its value. */
const PROJECTION_WITNESS = {
	min_length: "minLength",
	max_length: "maxLength",
	pattern: "pattern",
} as const;

/**
 * Asserts a projectable check actually appears in `z.toJSONSchema`'s output for its owning node.
 *
 * This is the guard against the failure mode that motivated the whole lane, applied to the half
 * that IS projectable: the projection above is read off zod's internal check list, and the JSON
 * Schema is what a consumer would receive. If those two ever disagree — a zod release changes how a
 * check renders, or renders it not at all — the emitted Go step would be enforcing something the
 * published schema does not say.
 */
function witnessProjection(owner: z.ZodType, kind: keyof typeof PROJECTION_WITNESS, expected: string | number): void {
	let rendered: Record<string, unknown>;
	try {
		rendered = asRecord(z.toJSONSchema(owner));
	} catch (err) {
		throw new Refusal(
			"PROJECTION_LOST",
			`z.toJSONSchema threw for the node carrying ${kind}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	const keyword = PROJECTION_WITNESS[kind];
	const got = rendered[keyword];
	if (got === undefined) {
		throw new Refusal(
			"PROJECTION_LOST",
			`the check ${kind} is in the schema but z.toJSONSchema did not emit "${keyword}" ` +
				`(it emitted ${JSON.stringify(rendered)}). The Go step would then enforce something the ` +
				`published JSON Schema does not say.`,
		);
	}
	if (String(got) !== String(expected)) {
		throw new Refusal(
			"PROJECTION_LOST",
			`the check ${kind} reads ${JSON.stringify(expected)} from zod but z.toJSONSchema emitted ` +
				`"${keyword}": ${JSON.stringify(got)}. Those must agree.`,
		);
	}
}

/**
 * Turns one registration into a Go spec plus its share of the conformance table, or refuses.
 *
 * Both directions of the declaration match are errors: a node with no declaration (UNDECLARED) and
 * a declaration with no node (STALE_DECLARATION). Only checking one direction would let a
 * declaration outlive the rule it describes, which reads as coverage and is not.
 */
export function project(reg: SpecRegistration, tables: Map<string, TableRule>): GoSpec {
	const nodes = discover(reg.schema);
	const declaredByPath = new Map<string, Declaration>();
	for (const decl of reg.declarations) {
		// A Map built by `.map()` would let the second entry win and mark BOTH paths used, so a
		// duplicate would silently discard one declaration while the staleness check reported
		// nothing. Two declarations for one node is always a mistake; which one was meant is not
		// something this can guess.
		if (declaredByPath.has(decl.path)) {
			throw new Refusal(
				"DUPLICATE_DECLARATION",
				`${reg.id}: two declarations for ${decl.path}. Only one can apply, and silently keeping ` +
					`the last would leave the other looking like it was doing something.`,
			);
		}
		declaredByPath.set(decl.path, decl);
	}
	const usedPaths = new Set<string>();

	const spec: GoSpec = { id: reg.id, why: reg.why, optional: false, nullable: false, steps: [], unshared: [] };

	const declarationFor = (node: DiscoveredNode, what: string): Declaration => {
		const decl = declaredByPath.get(node.path);
		if (decl === undefined) {
			throw new Refusal(
				"UNDECLARED",
				`${reg.id}: ${what} at ${node.path} is not projectable and is not declared.\n` +
					`  z.toJSONSchema drops it SILENTLY, so leaving it here would ship the CLI validation ` +
					`that looks shared while this rule is missing.\n` +
					`  Declare it in gen-go-validation.ts with either:\n` +
					`    via: "table"       — implement it in packages/core/validate/rules.go and give it named cases\n` +
					`    via: "not-shared"  — say why one surface applies it and the other must not`,
			);
		}
		usedPaths.add(node.path);
		return decl;
	};

	for (const node of nodes) {
		switch (node.kind) {
			case "optional":
				spec.optional = true;
				break;
			case "nullable":
				spec.nullable = true;
				break;
			case "base":
				if (node.type !== "string") {
					throw new Refusal(
						"NON_STRING_BASE",
						`${reg.id}: base type "${node.type}" at ${node.path}. packages/core/validate evaluates ` +
							`string values only; teach it the new type before registering a schema that needs it.`,
					);
				}
				break;
			case "unsupported":
				throw new Refusal(
					"UNSUPPORTED_NODE",
					`${reg.id}: zod node type "${node.detail}" at ${node.path} has no projection. ` +
						`Add one here AND an evaluator in packages/core/validate, or keep the schema out of the registry.`,
				);
			case "transform":
				applyDeclaration(spec, tables, reg, declarationFor(node, "a .transform()"), node.path, "transform");
				break;
			case "check":
				projectCheck(spec, tables, reg, node, declarationFor);
				break;
		}
	}

	const stale = reg.declarations.filter((d) => !usedPaths.has(d.path));
	if (stale.length > 0) {
		throw new Refusal(
			"STALE_DECLARATION",
			`${reg.id}: ${stale.length} declaration(s) match no node in the schema:\n` +
				stale.map((d) => `  - ${d.path}`).join("\n") +
				`\n  A declaration that outlived its rule reads as coverage and is not. Delete it, or fix the path ` +
				`(a check's path carries its kind, so changing .refine() to .superRefine() moves it).`,
		);
	}

	if (spec.steps.length === 0) {
		throw new Refusal(
			"NO_STEPS",
			`${reg.id}: projected to zero steps. A spec that checks nothing is worse than no spec — the CLI ` +
				`would report the field as validated. Either it has a rule to share or it does not belong here.`,
		);
	}
	return spec;
}

/** Projects one zod check: declarative ones become Steps, everything else needs a declaration. */
function projectCheck(
	spec: GoSpec,
	tables: Map<string, TableRule>,
	reg: SpecRegistration,
	node: Extract<DiscoveredNode, { kind: "check" }>,
	declarationFor: (n: DiscoveredNode, what: string) => Declaration,
): void {
	const format = typeof node.def.format === "string" ? node.def.format : undefined;

	if (node.check === "min_length" && typeof node.def.minimum === "number") {
		witnessProjection(node.owner, "min_length", node.def.minimum);
		spec.steps.push({
			kind: "min_length",
			severity: "reject",
			message: messageOf(node.def) ?? `must be at least ${node.def.minimum} characters`,
			length: node.def.minimum,
		});
		return;
	}
	if (node.check === "max_length" && typeof node.def.maximum === "number") {
		witnessProjection(node.owner, "max_length", node.def.maximum);
		spec.steps.push({
			kind: "max_length",
			severity: "reject",
			message: messageOf(node.def) ?? `must be at most ${node.def.maximum} characters`,
			length: node.def.maximum,
		});
		return;
	}
	if (node.check === "string_format" && format === "regex" && node.def.pattern instanceof RegExp) {
		const source = toRE2(node.def.pattern.source);
		witnessProjection(node.owner, "pattern", node.def.pattern.source);
		spec.steps.push({
			kind: "pattern",
			severity: "reject",
			message: messageOf(node.def) ?? "does not match the required pattern",
			pattern: source,
		});
		return;
	}

	// Everything else — .refine, .superRefine, .trim (an `overwrite`), .email/.uuid and friends
	// (a `string_format` this projector has no RE2 equivalent for).
	const what = node.check === "custom" ? "a .refine()/.superRefine()" : `a ${node.check} check`;
	const decl = declarationFor(node, what);

	// An `overwrite` check REWRITES the value (zod's `.trim()` is one), so it must become a
	// StepTransform and be looked up in the transform registry — every later step judges what it
	// produced. Emitting it as a StepRule made packages/core/validate hunt for a predicate that did
	// not exist, which `TestEverySpecRuleResolves` caught; had the same name existed in both
	// registries it would instead have silently evaluated the wrong thing and never rewritten the
	// value, which is the failure this comment is really guarding.
	const stepKind = node.check === "overwrite" ? "transform" : "rule";

	if (node.check === "custom") {
		const stored = node.def.fn;
		if (typeof stored === "function") {
			if (!("fn" in decl)) {
				throw new Refusal(
					"FN_IDENTITY",
					`${reg.id}: the declaration at ${node.path} does not name the function it describes. ` +
						`A .refine() keeps its predicate, so name it — an unnamed declaration would keep matching ` +
						`after the predicate is swapped for a different one.`,
				);
			}
			if (decl.fn !== stored) {
				throw new Refusal(
					"FN_IDENTITY",
					`${reg.id}: the declaration at ${node.path} names a different function than the schema holds. ` +
						`Identity is the match, so this is a predicate that changed under a declaration that did not.`,
				);
			}
		} else if (decl.fn !== null) {
			throw new Refusal(
				"FN_UNIDENTIFIABLE",
				`${reg.id}: ${node.path} is a .superRefine(), whose closure zod does not keep anywhere ` +
					`reachable — it cannot be identity-matched. Declare it with \`fn: null\` to say so ` +
					`deliberately, or rewrite it as a named .refine() so the match can be real.`,
			);
		}
	}

	applyDeclaration(spec, tables, reg, decl, node.path, stepKind);
}

/** Turns a matched declaration into either a Step (table) or an unshared record. */
function applyDeclaration(
	spec: GoSpec,
	tables: Map<string, TableRule>,
	reg: SpecRegistration,
	decl: Declaration,
	path: string,
	stepKind: "rule" | "transform",
): void {
	if (decl.disposition.via === "not-shared") {
		spec.unshared.push({ rule: decl.disposition.rule, why: decl.disposition.why });
		return;
	}
	const d = decl.disposition;
	if (d.cases.length === 0) {
		throw new Refusal(
			"NO_CASES",
			`${reg.id}: the table rule "${d.goRule}" at ${path} has zero cases. A table with no rows ` +
				`passes for the same reason an empty one does, and reads as proof that the two sides agree.`,
		);
	}
	recordCases(tables, d, stepKind);
	spec.steps.push({
		kind: stepKind,
		severity: d.severity,
		message: d.message,
		rule: d.goRule,
		ruleArg: d.goArg,
	});
}

/**
 * Runs the real TS implementation over the declared cases and files the answers under the rule.
 *
 * The expectations are COMPUTED, never typed: a hand-written `want` is a second implementation of
 * the thing under test, and the one place it will be wrong is the boundary the case exists for.
 */
function recordCases(tables: Map<string, TableRule>, d: Extract<Disposition, { via: "table" }>, stepKind: "rule" | "transform"): void {
	const kind = stepKind === "transform" ? "transform" : "predicate";
	const existing = tables.get(d.goRule);
	const table: TableRule = existing ?? { kind, cases: [] };
	if (existing !== undefined && existing.kind !== kind) {
		throw new Refusal(
			"UNSUPPORTED_NODE",
			`the rule "${d.goRule}" is declared as both a ${existing.kind} and a ${kind}.`,
		);
	}
	const impl = TS_IMPLEMENTATIONS[d.goRule];
	if (impl === undefined) {
		throw new Refusal(
			"NO_TS_IMPL",
			`the table rule "${d.goRule}" has no entry in TS_IMPLEMENTATIONS, so its expectations cannot be ` +
				`computed from the console's own code. Add one — a table whose answers came from anywhere ` +
				`else agrees with itself and with nothing that ships.`,
		);
	}
	const seen = new Set(table.cases.map((c) => `${c.id}/${c.arg ?? ""}`));
	for (const c of d.cases) {
		const key = `${c.id}/${d.goArg ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		table.cases.push({
			id: c.id,
			in: c.in,
			...(d.goArg === undefined ? {} : { arg: d.goArg }),
			want: impl(c.in, d.goArg),
		});
	}
	tables.set(d.goRule, table);
}

/** Reads a zod check's custom message, if it carries one. */
function messageOf(def: Record<string, unknown>): string | undefined {
	const err = def.error;
	if (typeof err === "string") return err;
	if (typeof err === "function") {
		const produced: unknown = err({});
		return typeof produced === "string" ? produced : undefined;
	}
	return undefined;
}

/**
 * The TS side of every table rule, by the same name Go registers it under.
 *
 * Named here rather than reached for through the declaration so the generator cannot accidentally
 * record a rule's expectations by running something other than the console's own implementation —
 * the one thing that would make the table agree with itself and with nothing else.
 */
const TS_IMPLEMENTATIONS: Record<string, (v: string, arg?: number) => string | boolean> = {
	go_trim_space: (v) => goTrimSpace(v),
	// zod's `.trim()` is String.prototype.trim(), so this is the console's implementation verbatim
	// rather than a description of it.
	js_trim: (v) => v.trim(),
	apps_path: (v) => isValidAppsPath(v),
	not_reserved_tfvar_key: (v) => isNotReservedTfvarKey(v),
	// Keyed by the FLOOR rather than by a cloud name, because the Go step carries the floor and not
	// the cloud. AWS and Azure share 18, so `find` returns whichever comes first — which is correct
	// and not a shortcut: the two predicates are `isCarvableCidr(v, 18)` either way, so the answer
	// recorded is the console's answer for that floor. A floor no cloud has is a registry that has
	// drifted from the table, and throwing is the right response to it.
	network_cidr_max_prefix: (v, arg) => {
		const cloud = NETWORK_CIDR_CLOUDS.find((c) => NETWORK_CIDR_MAX_PREFIX[c] === arg);
		if (cloud === undefined) throw new Error(`no cloud has a network floor of ${String(arg)}`);
		return isCarvableFor[cloud](v);
	},
};

// ---------------------------------------------------------------------------------------------
// The registry — every schema whose rules the CLI is allowed to hold an opinion about
// ---------------------------------------------------------------------------------------------

/** Exactly the length bound, so the case that moves when the bound moves is a named one. */
const APPS_PATH_AT_BOUND = "a".repeat(512);

/**
 * The per-cloud CIDR cases. Deliberately NOT the same list five times: each cloud pins its own
 * floor and the boundary either side of it, and the shape cases (which are floor-independent) are
 * carried once, on AWS.
 */
const NETWORK_CIDR_CASES: Record<(typeof NETWORK_CIDR_CLOUDS)[number], CaseInput[]> = {
	aws: [
		{ id: "aws-exactly-at-its-floor", in: "10.0.0.0/18" },
		{ id: "aws-one-past-its-floor", in: "10.0.0.0/19" },
		{ id: "aws-the-slash-24-cidr-for-hosts-used-to-hand-out", in: "10.0.0.0/24" },
		{ id: "aws-wider-than-its-floor", in: "10.0.0.0/8" },
		{ id: "unset-means-the-template-default", in: "" },
		{ id: "host-bits-set-are-accepted", in: "10.0.0.1/16" },
		{ id: "no-prefix-at-all", in: "10.0.0.0" },
		{ id: "not-a-cidr", in: "overlays/dev" },
		{ id: "an-octet-out-of-range", in: "999.0.0.0/16" },
		{ id: "a-prefix-over-32", in: "10.0.0.0/33" },
		// Go's net.ParseCIDR has refused zero-padded OCTETS since 1.17 and still accepts a
		// zero-padded PREFIX. All three spellings are pinned because the console used to accept the
		// first two (too permissive — the apply gate refused them with nothing shown to the user)
		// and the first fix for that refused the third (too strict — the forbidden direction).
		{ id: "a-leading-zero-octet", in: "010.0.0.0/8" },
		{ id: "a-zero-padded-octet", in: "10.00.0.0/16" },
		{ id: "a-zero-padded-prefix-which-go-still-accepts", in: "10.0.0.0/016" },
	],
	azure: [
		{ id: "azure-exactly-at-its-floor", in: "10.0.0.0/18" },
		{ id: "azure-one-past-its-floor", in: "10.0.0.0/19" },
	],
	gcp: [
		{ id: "gcp-has-no-floor-so-a-slash-29-is-fine", in: "10.0.0.0/29" },
		{ id: "gcp-still-refuses-a-value-that-is-not-a-cidr", in: "10.0.0.0" },
	],
	hetzner: [
		{ id: "hetzner-exactly-at-its-floor", in: "10.0.0.0/22" },
		{ id: "hetzner-one-past-its-floor", in: "10.0.0.0/23" },
		{ id: "hetzner-accepts-what-aws-would-also-accept", in: "10.0.0.0/20" },
	],
	alibaba: [
		{ id: "alibaba-exactly-at-its-floor", in: "10.0.0.0/28" },
		{ id: "alibaba-one-past-its-floor", in: "10.0.0.0/29" },
	],
};

const REGISTRY: SpecRegistration[] = [
	{
		id: "apps_path",
		why:
			"project_repositories.apps_path — the apps-repo subpath a PLACED environment syncs. It lands " +
			"verbatim in an ArgoCD Application's source.path, so argocd.ValidateAppsPath is the authority " +
			"and this spec exists to say the same thing earlier.",
		schema: appsPathSchema,
		declarations: [
			{
				path: "$/inner/inner/in/out",
				disposition: {
					via: "table",
					goRule: "go_trim_space",
					severity: "reject",
					message: "leading and trailing whitespace is ignored",
					why:
						"A transform, not a rule — z.toJSONSchema cannot carry it at all. It must still cross " +
						"over, because the value the length bound and the grammar judge is the TRIMMED one; a Go " +
						"side that checked the raw value would refuse input the server trims and accepts. The " +
						"console reproduces Go's unicode.IsSpace set by hand rather than calling " +
						"String.prototype.trim(), and the two disagree at exactly two code points — both are cases.",
					cases: [
						{ id: "plain-path-is-untouched", in: "overlays/dev" },
						{ id: "ascii-space-both-ends", in: "  overlays/dev  " },
						{ id: "tab-and-newline", in: "\toverlays/dev\n" },
						// U+0085 NEL is in Go's unicode.IsSpace set and NOT in the set
						// String.prototype.trim() uses, so goTrimSpace must strip it. A console that used
						// .trim() would store a value the runner then re-derives differently.
						{ id: "nel-u0085-is-a-go-space-and-not-a-js-one", in: "\u0085overlays/dev" },
						// U+FEFF is the mirror image: JS trims it, Go does not. It rides along on a value
						// pasted out of a rendered docs page or a spreadsheet cell.
						{ id: "bom-ufeff-is-a-js-space-and-not-a-go-one", in: "\uFEFFoverlays/dev" },
						{ id: "no-break-space-u00a0", in: "\u00A0overlays/dev" },
						{ id: "ideographic-space-u3000", in: "overlays/dev\u3000" },
						{ id: "whitespace-only-becomes-empty", in: "   " },
						{ id: "empty-stays-empty", in: "" },
						{ id: "interior-space-is-kept", in: "over lays/dev" },
					],
				},
			},
			{
				path: "$/inner/inner#0:custom",
				fn: isValidAppsPath,
				disposition: {
					via: "table",
					goRule: "apps_path",
					severity: "reject",
					message: APPS_PATH_MESSAGE,
					why:
						"The segment grammar and the path.Clean round-trip. Neither is expressible as one RE2 " +
						"pattern without restating the grammar a third time, and the Go authority " +
						"(argocd.ValidateAppsPath) already exists — so the rule crosses over as a table rather " +
						"than as data.",
					cases: [
						{ id: "empty-means-the-repo-root", in: "" },
						{ id: "dot-means-the-repo-root", in: "." },
						{ id: "a-simple-overlay", in: "overlays/dev" },
						{ id: "dashes-underscores-and-dots", in: "over-lays/de_v/v1.2" },
						{ id: "parent-traversal", in: "../../etc" },
						{ id: "interior-traversal", in: "overlays/../../etc" },
						{ id: "absolute-path", in: "/overlays/dev" },
						{ id: "trailing-slash", in: "overlays/dev/" },
						{ id: "double-slash", in: "overlays//dev" },
						{ id: "single-quote-would-break-the-yaml-scalar", in: "overlays/'dev" },
						{ id: "dollar-substitution", in: "overlays/$dev" },
						{ id: "embedded-newline", in: "overlays\ndev" },
						{ id: "exactly-at-the-length-bound", in: APPS_PATH_AT_BOUND },
						{ id: "one-over-the-length-bound", in: `${APPS_PATH_AT_BOUND}a` },
						{ id: "leading-space-is-trimmed-before-judging", in: "  overlays/dev  " },
					],
				},
			},
		],
	},
	{
		id: "iac_var_key",
		why:
			"A BYO IaC variable name. The reserved alethia_ namespace was enforced only in Go, so the " +
			"console stored alethia_project_id and the user then watched it vanish at apply.",
		schema: iacVarKeySchema,
		declarations: [
			{
				path: "$#0:overwrite",
				disposition: {
					via: "table",
					goRule: "js_trim",
					// A transform never produces a finding; the severity is carried for the shape only.
					severity: "reject",
					message: "leading and trailing whitespace is ignored",
					why:
						"This was declared `not-shared` first, and that was wrong in the one direction the " +
						"invariant forbids. The reasoning was that the trimmed key is what gets STORED, so the " +
						"runner never sees the raw value — true of the runner, and beside the point for the CLI, " +
						"which judges what the USER typed before anything is stored. With no trim on the Go side, " +
						"`Check(iac_var_key, \" region\")` failed the pattern below while the console accepted the " +
						"same input and stored \"region\": the CLI refusing what the server accepts. It is " +
						"String.prototype.trim(), NOT Go's unicode.IsSpace set, and both crossings are cases.",
					cases: [
						{ id: "a-plain-key-is-untouched", in: "region" },
						{ id: "ascii-space-both-ends", in: "  region  " },
						{ id: "tab-and-newline", in: "\tregion\n" },
						// The two code points where this transform and go_trim_space disagree, one each
						// way. Pinning both is what stops somebody "simplifying" js_trim into TrimSpace.
						{ id: "bom-ufeff-IS-a-js-space-unlike-go", in: "\uFEFFregion" },
						{ id: "nel-u0085-is-NOT-a-js-space-unlike-go", in: "\u0085region" },
						{ id: "no-break-space-u00a0", in: "\u00A0region" },
						{ id: "ideographic-space-u3000", in: "region\u3000" },
						{ id: "line-separator-u2028", in: "\u2028region" },
						{ id: "whitespace-only-becomes-empty", in: "   " },
						{ id: "empty-stays-empty", in: "" },
						{ id: "interior-space-is-kept", in: "a b" },
					],
				},
			},
			{
				path: "$#3:custom",
				fn: isNotReservedTfvarKey,
				disposition: {
					via: "table",
					goRule: "not_reserved_tfvar_key",
					// REJECT, and which server this mirrors is the whole question. The first version of this
					// PR said `warn`, reasoning from provisioner.coerceByoVarValues, which drops the key with
					// a warning rather than failing. But the CLI never reaches the provisioner: it posts to
					// /api/cli/projects/{id}/byo-iac, and this PR makes that endpoint refuse a reserved key
					// with a 400. Warning would walk the user into a request that dies — the CLI being
					// permissive about something the server it actually talks to certainly rejects.
					severity: "reject",
					message: RESERVED_TFVAR_MESSAGE,
					why:
						"A prefix test. Expressible as a pattern in principle, but the authority is a Go " +
						"strings.HasPrefix against an unexported constant, and the case-sensitivity is the whole " +
						"point — so it crosses as a table with the capitalised key pinned as a case.",
					cases: [
						{ id: "an-ordinary-key", in: "region" },
						{ id: "the-reserved-key-that-used-to-be-stored", in: "alethia_project_id" },
						{ id: "the-bare-prefix", in: "alethia_" },
						{ id: "capitalised-is-not-reserved", in: "Alethia_project_id" },
						{ id: "the-prefix-without-its-underscore", in: "alethiaproject" },
						{ id: "an-underscore-prefixed-user-var", in: "_alethia_x" },
						{ id: "empty", in: "" },
					],
				},
			},
		],
	},
	...NETWORK_CIDR_CLOUDS.map(
		(cloud): SpecRegistration => ({
			id: `network_cidr_block.${cloud}`,
			why:
				`network.cidr_block on ${cloud}. cloud.validateNetworkCIDR refuses a network the template ` +
				`cannot carve its subnets out of, and nothing in the console checked this field at all — so ` +
				`the only feedback was a failed apply. Applies to a project that PROVISIONS ITS OWN network; ` +
				`the apply gate returns early for a brownfield one.`,
			schema: NETWORK_CIDR_SCHEMAS[cloud],
			declarations: [
				{
					path: "$#1:custom",
					fn: isCarvableFor[cloud],
					disposition: {
						via: "table",
						goRule: "network_cidr_max_prefix",
						goArg: NETWORK_CIDR_MAX_PREFIX[cloud],
						severity: "reject",
						message: networkCidrFloorMessage(cloud),
						why:
							"Parsing an IPv4 network and comparing its mask is not something a JSON Schema pattern " +
							"can do without restating IPv4 in a regex. Both sides parse; the table holds them to " +
							"the same answers, including which malformed values are refused for being malformed.",
						cases: NETWORK_CIDR_CASES[cloud],
					},
				},
			],
		}),
	),
];

// ---------------------------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------------------------

/** The Go constant name for each step kind, so the emitted file reads as Go rather than as JSON. */
const GO_STEP_KIND: Record<GoStep["kind"], string> = {
	min_length: "StepMinLength",
	max_length: "StepMaxLength",
	pattern: "StepPattern",
	rule: "StepRule",
	transform: "StepTransform",
};

const GO_SEVERITY: Record<GoStep["severity"], string> = {
	reject: "SeverityReject",
	warn: "SeverityWarn",
};

/**
 * A Go interpreted string literal. JSON's escaping is a subset of Go's for everything reachable
 * here — quotes, backslashes and the C0 controls all escape identically, and both languages read
 * source as UTF-8 — so JSON.stringify is the right tool and not a shortcut.
 */
function goString(s: string): string {
	return JSON.stringify(s);
}

function emitGo(specs: GoSpec[]): string {
	const lines: string[] = [
		"// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>",
		"// SPDX-License-Identifier: AGPL-3.0-only",
		"",
		"// Code generated by apps/console/scripts/gen-go-validation.ts. DO NOT EDIT.",
		"//",
		"// Regenerate with: pnpm -C apps/console run gen:go-validation",
		"//",
		"// Every Step below is DATA. A Step names a rule; rules.go is the only place a name becomes",
		"// behaviour, so nothing here — nor anything a server later publishes in this shape — can add",
		"// code to the CLI. `Unshared` records the rules that deliberately did NOT cross over, with the",
		"// reason, so a reader can tell a decision from an omission.",
		"",
		"package validate",
		"",
		"// intPtr keeps a legitimate 0 bound distinguishable from an unset one.",
		"func intPtr(v int) *int { return &v }",
		"",
		"// Specs is every field whose validation the console and the CLI share.",
		"var Specs = map[string]Spec{",
	];

	for (const spec of specs) {
		lines.push(`\t${goString(spec.id)}: {`);
		// gofmt aligns the values of a RUN of consecutive single-line fields on the longest key in
		// that run, and stops at the first multi-line one (`Steps:`). Emitting that alignment here
		// rather than shelling out to gofmt keeps the output identical wherever the generator runs —
		// CI's node job has no Go toolchain, and a formatter that is only sometimes applied would
		// make the diff-gate fail for the environment rather than for the content.
		const scalars: [string, string][] = [
			["ID", goString(spec.id)],
			["Why", goString(spec.why)],
			...(spec.optional ? [["Optional", "true"] satisfies [string, string]] : []),
			...(spec.nullable ? [["Nullable", "true"] satisfies [string, string]] : []),
		];
		const width = Math.max(...scalars.map(([k]) => k.length + 1));
		for (const [key, value] of scalars) {
			lines.push(`\t\t${`${key}:`.padEnd(width)} ${value},`);
		}
		lines.push("\t\tSteps: []Step{");
		for (const step of spec.steps) {
			const fields = [
				`Kind: ${GO_STEP_KIND[step.kind]}`,
				`Severity: ${GO_SEVERITY[step.severity]}`,
				`Message: ${goString(step.message)}`,
			];
			if (step.length !== undefined) fields.push(`Length: intPtr(${step.length})`);
			if (step.pattern !== undefined) fields.push(`Pattern: ${goString(step.pattern)}`);
			if (step.rule !== undefined) fields.push(`Rule: ${goString(step.rule)}`);
			if (step.ruleArg !== undefined) fields.push(`RuleArg: intPtr(${step.ruleArg})`);
			lines.push(`\t\t\t{${fields.join(", ")}},`);
		}
		lines.push("\t\t},");
		if (spec.unshared.length > 0) {
			lines.push("\t\tUnshared: []UnsharedRule{");
			for (const u of spec.unshared) {
				lines.push(`\t\t\t{Rule: ${goString(u.rule)}, Why: ${goString(u.why)}},`);
			}
			lines.push("\t\t},");
		}
		lines.push("\t},");
	}

	lines.push("}", "");
	return lines.join("\n");
}

function emitCases(tables: Map<string, TableRule>): string {
	const rules: Record<string, TableRule> = {};
	for (const name of [...tables.keys()].sort()) {
		const table = tables.get(name);
		if (table !== undefined) rules[name] = table;
	}
	const doc = {
		_doc:
			"GENERATED by apps/console/scripts/gen-go-validation.ts by RUNNING the console's own " +
			"implementations over the declared cases. DO NOT EDIT. Regenerate: pnpm -C apps/console run " +
			"gen:go-validation. Consumed by packages/core/validate/conformance_test.go. Regenerating " +
			"rewrites an EXPECTATION the Go side is held to — read the changed-case list the generator " +
			"prints, do not skim it.",
		version: CASES_VERSION,
		rules,
	};
	return `${JSON.stringify(doc, null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------------
// Self-test — the generator's REFUSALS, exercised
// ---------------------------------------------------------------------------------------------

/**
 * A guard whose failure branch is never taken is indistinguishable from one that always passes, and
 * this generator is almost entirely failure branches. So every refusal has a case here, driving the
 * REAL `discover`/`project` over a synthetic schema and asserting the CODE — never the prose, which
 * would make the assertion a copy of the message.
 *
 * `assertEveryCodeIsExercised` closes the loop: adding a RefusalCode without adding a case fails
 * this run. The set is derived from REFUSAL_CODES, not counted by hand.
 */
interface SelfTestCase {
	id: string;
	want: RefusalCode | "ok";
	build: () => SpecRegistration;
	/** For an `ok` case: what the projection must have produced. Returns a complaint, or null. */
	assert?: (spec: GoSpec) => string | null;
}

/** Two distinct, stable predicates — identity is what the fn match is about. */
const selfTestPredicate = (v: string): boolean => v.length > 0;
const selfTestOtherPredicate = (v: string): boolean => v.length > 1;

/**
 * A predicate for the OUTERMOST position, where `.nullish()` has already widened the value. It
 * exists because a refine attached above the wrappers sees `string | null | undefined`, which is
 * exactly why that position is easy to reach by accident and was the one the walk did not look at.
 */
const selfTestOuterPredicate = (v: string | null | undefined): boolean => v !== "";

/** A table disposition with one real case, reusing a rule both sides already implement. */
function tableDisposition(overrides: Partial<Extract<Disposition, { via: "table" }>> = {}): Disposition {
	return {
		via: "table",
		goRule: "apps_path",
		severity: "reject",
		message: "self-test",
		why: "self-test",
		cases: [{ id: "self-test-case", in: "overlays/dev" }],
		...overrides,
	};
}

function selfTestCases(): SelfTestCase[] {
	return [
		{
			id: "a-schema-whose-rules-are-all-projectable-passes",
			want: "ok",
			build: () => ({ id: "t", why: "t", schema: z.string().min(1, "required"), declarations: [] }),
			assert: (spec) =>
				spec.steps.length === 1 && spec.steps[0].kind === "min_length" && spec.steps[0].length === 1
					? null
					: `expected one min_length(1) step, got ${JSON.stringify(spec.steps)}`,
		},
		{
			id: "an-undeclared-refine-is-refused",
			want: "UNDECLARED",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().min(1, "required").refine(selfTestPredicate, "nope"),
				declarations: [],
			}),
		},
		{
			// THE REGRESSION CASE. `discover` used to return from inside each switch arm and collect
			// the node's own checks in only three of the five, and `optional`/`nullable` were two of
			// the misses. `.nullish()` is the last link on the real appsPathSchema, so a rule
			// appended after it — the natural place to write one — was silently accepted: not
			// projected, not tabled, not refused, "up to date", exit 0.
			//
			// Every other UNDECLARED case below carries its checks BENEATH a wrapper or on a bare
			// string, so none of them could see this position. That is what made a derived
			// "all twelve codes are reached" true and still blind.
			id: "an-undeclared-refine-on-the-OUTERMOST-node-is-refused",
			want: "UNDECLARED",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().min(1, "required").nullish().refine(selfTestOuterPredicate, "nope"),
				declarations: [],
			}),
		},
		{
			// The other half: once seen, an outermost rule must actually PROJECT. A fix that made
			// the walk notice the node and then refuse everything would satisfy the case above.
			id: "a-declared-refine-on-the-OUTERMOST-node-projects",
			want: "ok",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().min(1, "required").nullish().refine(selfTestOuterPredicate, "nope"),
				declarations: [
					{ path: "$#0:custom", fn: selfTestOuterPredicate, disposition: tableDisposition() },
				],
			}),
			assert: (spec) => {
				if (!spec.optional || !spec.nullable) {
					return `expected the .nullish() wrappers to be projected, got optional=${spec.optional} nullable=${spec.nullable}`;
				}
				// The rule step must come AFTER the inner min_length: the outer check is the last
				// thing zod evaluates, and a Go side that ran it first would judge an untrimmed or
				// unbounded value.
				const kinds = spec.steps.map((step) => step.kind);
				if (kinds.join(",") !== "min_length,rule") {
					return `expected [min_length, rule] in evaluation order, got [${kinds.join(", ")}]`;
				}
				return null;
			},
		},
		{
			id: "an-undeclared-super-refine-is-refused",
			want: "UNDECLARED",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().min(1, "required").superRefine(() => undefined),
				declarations: [],
			}),
		},
		{
			id: "an-undeclared-transform-is-refused",
			want: "UNDECLARED",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().min(1, "required").transform((v) => v),
				declarations: [],
			}),
		},
		{
			id: "an-undeclared-trim-is-refused-because-it-rewrites-the-value",
			want: "UNDECLARED",
			build: () => ({ id: "t", why: "t", schema: z.string().trim().min(1, "required"), declarations: [] }),
		},
		{
			// .email() renders as a JSON Schema `format` AND a pattern using lookahead. zod can carry
			// it; this projector's RE2 target cannot, so it must be declared rather than assumed.
			id: "a-string-format-this-projector-cannot-express-is-refused",
			want: "UNDECLARED",
			build: () => ({ id: "t", why: "t", schema: z.string().min(1, "required").email(), declarations: [] }),
		},
		{
			id: "a-declaration-matching-no-node-is-refused",
			want: "STALE_DECLARATION",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().min(1, "required"),
				declarations: [{ path: "$#9:custom", fn: selfTestPredicate, disposition: tableDisposition() }],
			}),
		},
		{
			id: "a-refine-declared-with-a-different-function-is-refused",
			want: "FN_IDENTITY",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().min(1, "required").refine(selfTestPredicate, "nope"),
				declarations: [{ path: "$#1:custom", fn: selfTestOtherPredicate, disposition: tableDisposition() }],
			}),
		},
		{
			id: "a-refine-declared-without-naming-its-function-is-refused",
			want: "FN_IDENTITY",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().min(1, "required").refine(selfTestPredicate, "nope"),
				declarations: [{ path: "$#1:custom", disposition: tableDisposition() }],
			}),
		},
		{
			id: "a-super-refine-must-be-acknowledged-as-unidentifiable",
			want: "FN_UNIDENTIFIABLE",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().min(1, "required").superRefine(() => undefined),
				declarations: [{ path: "$#1:custom", disposition: tableDisposition() }],
			}),
		},
		{
			id: "a-super-refine-acknowledged-with-fn-null-passes",
			want: "ok",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().min(1, "required").superRefine(() => undefined),
				declarations: [{ path: "$#1:custom", fn: null, disposition: tableDisposition() }],
			}),
			assert: (spec) =>
				spec.steps.some((s) => s.kind === "rule" && s.rule === "apps_path")
					? null
					: `expected a rule step, got ${JSON.stringify(spec.steps)}`,
		},
		{
			id: "a-non-string-base-type-is-refused",
			want: "NON_STRING_BASE",
			build: () => ({ id: "t", why: "t", schema: z.number().min(1), declarations: [] }),
		},
		{
			id: "a-zod-node-with-no-projection-is-refused",
			want: "UNSUPPORTED_NODE",
			build: () => ({ id: "t", why: "t", schema: z.object({ a: z.string() }), declarations: [] }),
		},
		{
			id: "a-pattern-using-lookahead-is-refused-because-re2-has-none",
			want: "PATTERN_NOT_RE2",
			build: () => ({ id: "t", why: "t", schema: z.string().regex(/^(?=a)b$/, "nope"), declarations: [] }),
		},
		{
			// Two competing bounds: zod keeps both checks, JSON Schema can carry only the tighter one.
			// The emitted Go step would then enforce a bound the published schema does not state.
			id: "a-projectable-check-that-json-schema-loses-is-refused",
			want: "PROJECTION_LOST",
			build: () => ({ id: "t", why: "t", schema: z.string().min(1, "a").min(3, "b"), declarations: [] }),
		},
		{
			id: "a-table-rule-with-no-cases-is-refused",
			want: "NO_CASES",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().min(1, "required").refine(selfTestPredicate, "nope"),
				declarations: [
					{ path: "$#1:custom", fn: selfTestPredicate, disposition: tableDisposition({ cases: [] }) },
				],
			}),
		},
		{
			id: "a-table-rule-the-console-does-not-implement-is-refused",
			want: "NO_TS_IMPL",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().min(1, "required").refine(selfTestPredicate, "nope"),
				declarations: [
					{
						path: "$#1:custom",
						fn: selfTestPredicate,
						disposition: tableDisposition({ goRule: "a_rule_no_one_implements" }),
					},
				],
			}),
		},
		{
			id: "two-declarations-for-one-node-are-refused",
			want: "DUPLICATE_DECLARATION",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().min(1, "required").refine(selfTestPredicate, "nope"),
				declarations: [
					{ path: "$#1:custom", fn: selfTestPredicate, disposition: tableDisposition() },
					{ path: "$#1:custom", fn: selfTestPredicate, disposition: tableDisposition() },
				],
			}),
		},
		{
			id: "a-spec-that-projects-to-nothing-is-refused",
			want: "NO_STEPS",
			build: () => ({ id: "t", why: "t", schema: z.string(), declarations: [] }),
		},
		{
			// No SHIPPED spec carries `warn` any more — `iac_var_key` did until the endpoint the CLI
			// posts to started refusing the key outright. The severity is still part of the emitted
			// contract for the next rule whose server-side disposition is a drop, so the emitter
			// branch is exercised here rather than left to be discovered wrong the first time it is
			// used. packages/core/validate's TestRejectedDistinguishesWarnFromReject is the other half.
			id: "a-warn-disposition-emits-a-warn-step",
			want: "ok",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().min(1, "required").refine(selfTestPredicate, "nope"),
				declarations: [
					{
						path: "$#1:custom",
						fn: selfTestPredicate,
						disposition: tableDisposition({ severity: "warn" }),
					},
				],
			}),
			assert: (spec) => {
				const rule = spec.steps.find((step) => step.kind === "rule");
				if (rule === undefined) return `expected a rule step, got ${JSON.stringify(spec.steps)}`;
				if (rule.severity !== "warn") return `expected severity warn, got ${rule.severity}`;
				// The projected checks stay `reject`, so this is not passing because everything warns.
				const min = spec.steps.find((step) => step.kind === "min_length");
				if (min?.severity !== "reject") return `a projected bound should stay reject, got ${String(min?.severity)}`;
				return null;
			},
		},
		{
			id: "the-not-shared-route-emits-a-record-and-no-behaviour",
			want: "ok",
			build: () => ({
				id: "t",
				why: "t",
				schema: z.string().trim().min(1, "required"),
				declarations: [
					{ path: "$#0:overwrite", disposition: { via: "not-shared", rule: "js_trim", why: "self-test" } },
				],
			}),
			assert: (spec) => {
				if (spec.unshared.length !== 1) return `expected one unshared record, got ${spec.unshared.length}`;
				if (spec.steps.length !== 1 || spec.steps[0].kind !== "min_length") {
					return `a not-shared rule must emit no step; got ${JSON.stringify(spec.steps)}`;
				}
				return null;
			},
		},
	];
}

/** Runs the self-test. Returns the number of failures; 0 is a pass. */
export function runSelfTest(): number {
	const cases = selfTestCases();
	const failures: string[] = [];

	if (cases.length === 0) {
		console.error("FAIL: the self-test has no cases. Zero cases and zero failures are not the same result.");
		return 1;
	}

	for (const c of cases) {
		let got: string;
		let complaint: string | null = null;
		try {
			const spec = project(c.build(), new Map());
			got = "ok";
			complaint = c.assert === undefined ? null : c.assert(spec);
		} catch (err) {
			got = err instanceof Refusal ? err.code : `an unexpected ${err instanceof Error ? err.name : typeof err}: ${String(err)}`;
		}
		if (got !== c.want) {
			failures.push(`  ${c.id}: expected ${c.want}, got ${got}`);
		} else if (complaint !== null) {
			failures.push(`  ${c.id}: refused nothing, as expected, but ${complaint}`);
		}
	}

	// The set of codes is DERIVED, so a new refusal cannot be added without a case that reaches it.
	const covered = new Set(cases.map((c) => c.want));
	const uncovered = REFUSAL_CODES.filter((code) => !covered.has(code));
	if (uncovered.length > 0) {
		failures.push(
			`  no case reaches: ${uncovered.join(", ")} — a refusal nothing exercises is indistinguishable ` +
				`from one that never fires`,
		);
	}
	if (!cases.some((c) => c.want === "ok")) {
		failures.push("  no case expects success — a harness where everything fails proves nothing");
	}

	if (failures.length > 0) {
		console.error(`FAIL: ${failures.length} of ${cases.length} self-test expectation(s) not met:`);
		failures.forEach((f) => console.error(f));
		return failures.length;
	}
	console.log(
		`self-test: ${cases.length} cases, ${REFUSAL_CODES.length} refusal codes each reached by at least one`,
	);
	return 0;
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

/** Reads a committed file, or null when it is absent. */
function readOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** What moved in the case table, by `rule/case-id`, so a diff names a boundary and not an index. */
function changedCases(before: string | null, after: Map<string, TableRule>): string[] {
	const prev = new Map<string, string>();
	if (before !== null) {
		try {
			const parsed: unknown = JSON.parse(before);
			const rules = asRecord(asRecord(parsed).rules);
			for (const [rule, table] of Object.entries(rules)) {
				const rows = asRecord(table).cases;
				if (!Array.isArray(rows)) continue;
				for (const row of rows) {
					const r = asRecord(row);
					if (typeof r.id !== "string") continue;
					prev.set(`${rule}/${r.id}/${String(r.arg ?? "")}`, JSON.stringify(r));
				}
			}
		} catch {
			// A malformed committed file leaves the index empty, so everything reads as new — the
			// honest answer when there is nothing to compare against.
		}
	}

	const changed: string[] = [];
	const seen = new Set<string>();
	for (const [rule, table] of after) {
		for (const row of table.cases) {
			const key = `${rule}/${row.id}/${String(row.arg ?? "")}`;
			seen.add(key);
			const was = prev.get(key);
			if (was === undefined) changed.push(`+ ${key} -> ${JSON.stringify(row.want)}  (new)`);
			else if (was !== JSON.stringify(row)) changed.push(`~ ${key}: ${was} -> ${JSON.stringify(row)}`);
		}
	}
	for (const key of prev.keys()) if (!seen.has(key)) changed.push(`- ${key}  (removed)`);
	return changed;
}

function main(): void {
	if (process.argv.includes("--self-test")) {
		process.exit(runSelfTest() === 0 ? 0 : 1);
	}

	const write = process.argv.includes("--write");

	if (REGISTRY.length === 0) {
		console.error("FAIL: the registry is empty. Generating two empty artifacts would read as 'nothing shared'.");
		process.exit(1);
	}

	const tables = new Map<string, TableRule>();
	const specs: GoSpec[] = [];
	for (const reg of REGISTRY) {
		try {
			specs.push(project(reg, tables));
		} catch (err) {
			if (err instanceof Refusal) {
				console.error(`FAIL: ${err.message}`);
				process.exit(1);
			}
			throw err;
		}
	}
	specs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

	const nextGo = emitGo(specs);
	const nextCases = emitCases(tables);
	const currentGo = readOrNull(GO_OUT);
	const currentCases = readOrNull(CASES_OUT);

	const totalSteps = specs.reduce((n, s) => n + s.steps.length, 0);
	const totalCases = [...tables.values()].reduce((n, t) => n + t.cases.length, 0);
	const summary =
		`${specs.length} specs, ${totalSteps} projected steps, ` +
		`${tables.size} table rules over ${totalCases} cases`;

	if (currentGo === nextGo && currentCases === nextCases) {
		console.log(`validation codegen: ${summary} — up to date`);
		return;
	}

	const changed = changedCases(currentCases, tables);

	if (!write) {
		console.error(
			`FAIL: the generated validation artifacts are stale — the console's schemas and the committed\n` +
				`files disagree.\n` +
				`  ${GO_REL}\n  ${CASES_REL}\n` +
				`Regenerate with:  pnpm -C apps/console run gen:go-validation\n\n` +
				`REGENERATING REWRITES AN EXPECTATION packages/core/validate is held to, not a formatting\n` +
				`detail. Read the changed-case list below rather than skimming it.`,
		);
		if (changed.length > 0) {
			console.error(`\n${changed.length} case(s) differ  (~ moved · + new · - removed):`);
			changed.forEach((c) => console.error(`  ${c}`));
		}
		process.exit(1);
	}

	writeFileSync(GO_OUT, nextGo, "utf8");
	writeFileSync(CASES_OUT, nextCases, "utf8");
	console.log(`validation codegen: ${summary}; ${changed.length} case(s) changed`);
	if (changed.length > 0) {
		console.log("\nCASES CHANGED  (~ moved · + new · - removed):");
		changed.forEach((c) => console.log(`  ${c}`));
	}
	console.log(`\nwrote ${GO_REL}\nwrote ${CASES_REL}`);
}

main();
