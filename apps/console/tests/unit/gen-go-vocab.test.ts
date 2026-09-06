// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the status-vocabulary → Go generator.
 *
 * The thing worth testing is the REFUSAL, not the map. `gen-go-vocab.ts` claims that a status word
 * nobody can account for cannot reach a green build, and a guard whose "nothing found" branch is
 * indistinguishable from "nothing wrong" is worth nothing — so every case below drives the FAILING
 * branch with a hand-written vocabulary and asserts on WHICH word is named, not on a count.
 *
 * Two disciplines, both learned the hard way in this repo:
 *
 *   - the expected values are written out, never derived by calling the thing under test. A test
 *     that asked `TIER_GLYPHS` what `disabled` looks like would pass for the em dash this unit
 *     exists to stop it being.
 *   - every refusal is also driven in its PASSING direction against the real inputs, because a
 *     matcher that has stopped matching anything reports the same green as a clean tree.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { STATUS_TIER, STATUS_TIERS, type StatusTier } from "@repo/ui/status-badge";
import { describe, expect, it } from "vitest";

import {
	absenceSentinel,
	auditGlyphs,
	auditVocabulary,
	gaps,
	generate,
	pascal,
	pgEnums,
	sourcesFor,
	type PgEnum,
} from "../../scripts/gen-go-vocab";
import { TIER_GLYPHS, WIRE_ORIGINS, type TierProjection } from "../../scripts/lib/status-vocab";
import * as schema from "@/lib/db/schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const FORMAT_GO = readFileSync(resolve(ROOT, "packages/core/format/format.go"), "utf8");
const SCHEMA_DIR = resolve(ROOT, "apps/console/lib/db/schema");

/** A small, hand-written enum set. Nothing here is read from the schema. */
const FAKE_ENUMS: PgEnum[] = [
	{ name: "job_status", values: ["QUEUED", "SUCCESS", "FAILED"] },
	{ name: "runner_status", values: ["ONLINE", "OFFLINE", "DRAINING"] },
	{ name: "billing_status", values: ["active", "canceled", "past_due"] },
];

/** The tier list, hand-written, so a change to STATUS_TIERS does not silently change the fixtures. */
const FAKE_TIERS: StatusTier[] = ["active", "pending", "idle", "failed", "disabled", "live"];

/** A glyph table with no collisions, for the cases that are not about collisions. */
const FAKE_GLYPHS: Record<StatusTier, TierProjection> = {
	active: { glyph: "A", why: "a" },
	pending: { glyph: "P", why: "p" },
	idle: { glyph: "I", why: "i" },
	failed: { glyph: "F", why: "f" },
	disabled: { glyph: "D", why: "d" },
	live: { glyph: "L", why: "l" },
};

describe("deriving the enums from the schema, by shape", () => {
	it("finds a pgEnum by its shape rather than by a list of names", () => {
		const mod = {
			someEnum: { enumName: "some_enum", enumValues: ["a", "b"] },
			notAnEnum: { enumName: "x" },
			alsoNot: { enumValues: ["a"] },
			aString: "hello",
			aNull: null,
			numbersAreNotValues: { enumName: "nope", enumValues: [1, 2] },
		};
		expect(pgEnums(mod)).toEqual([{ name: "some_enum", values: ["a", "b"] }]);
	});

	it("sorts by the enum's own name, not by the export name", () => {
		const mod = {
			zebra: { enumName: "aardvark", enumValues: ["a"] },
			aardvark: { enumName: "zebra", enumValues: ["z"] },
		};
		expect(pgEnums(mod).map((e) => e.name)).toEqual(["aardvark", "zebra"]);
	});

	it("finds the real schema's enums — including ones gen-go-enums.ts does not name", () => {
		// gen-go-enums.ts lists eighteen enums by hand. The census must not be that list: the
		// question here is whether ANY enum spells a word, and promotion_status is exactly the kind
		// of enum a hand-typed list leaves out (case 7 of #3660 was that it had no Go renderer).
		const names = pgEnums({ ...schema }).map((e) => e.name);
		expect(names).toContain("promotion_status");
		expect(names).toContain("runner_status");
		expect(names).toContain("project_status");
		expect(names.length).toBeGreaterThan(18);
	});
});

describe("provenance", () => {
	it("matches a word against an enum value regardless of case", () => {
		// The sixth measured disagreement: the vocabulary is lower-cased and six pgEnums shout.
		expect(sourcesFor("success", FAKE_ENUMS)).toEqual(["job_status.SUCCESS"]);
		expect(sourcesFor("active", FAKE_ENUMS)).toEqual(["billing_status.active"]);
	});

	it("names every enum that spells the word, not just the first", () => {
		const shared: PgEnum[] = [
			{ name: "a_status", values: ["FAILED"] },
			{ name: "b_status", values: ["failed"] },
		];
		expect(sourcesFor("failed", shared)).toEqual(["a_status.FAILED", "b_status.failed"]);
	});

	it("refuses a word that no enum spells and that WIRE_ORIGINS does not account for", () => {
		const { problems } = auditVocabulary(
			{ success: "active", mystery: "idle" },
			FAKE_TIERS,
			FAKE_ENUMS,
			{},
			{},
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("mystery");
		expect(problems[0]).toContain("WIRE_ORIGINS");
	});

	it("accepts a wire word once something says what emits it, and carries the sentence through", () => {
		const { words, problems } = auditVocabulary(
			{ mystery: "idle" },
			FAKE_TIERS,
			FAKE_ENUMS,
			{ mystery: "the widget's local phase union" },
			{},
		);
		expect(problems).toEqual([]);
		expect(words).toEqual([
			{
				word: "mystery",
				tier: "idle",
				provenance: "wire",
				sources: ["the widget's local phase union"],
				note: "",
			},
		]);
	});

	it("refuses an empty origin — a blank entry is not an answer", () => {
		const { problems } = auditVocabulary({ mystery: "idle" }, FAKE_TIERS, FAKE_ENUMS, { mystery: "   " }, {});
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("mystery");
	});

	it("refuses a typed origin for a word that has a real enum behind it", () => {
		// The mirror of the first refusal. The derived provenance is better than the typed one, and
		// a typed one sitting on top of it hides which enums actually spell the word.
		const { problems } = auditVocabulary(
			{ success: "active" },
			FAKE_TIERS,
			FAKE_ENUMS,
			{ success: "somebody typed this" },
			{},
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("job_status.SUCCESS");
	});

	it("refuses an origin or a ruling left behind by a word that is gone", () => {
		const { problems } = auditVocabulary(
			{ success: "active" },
			FAKE_TIERS,
			FAKE_ENUMS,
			{ deleted_word: "used to be a thing" },
			{ also_deleted: "used to be contested" },
		);
		expect(problems).toHaveLength(2);
		expect(problems.join("\n")).toContain("deleted_word");
		expect(problems.join("\n")).toContain("also_deleted");
	});

	it("refuses an unreachable upper-case key", () => {
		// statusTier() lower-cases before the lookup, so an upper-case key sits in the map looking
		// like a decision and is never once consulted.
		const { problems } = auditVocabulary({ SUCCESS: "active" }, FAKE_TIERS, FAKE_ENUMS, {}, {});
		expect(problems.join("\n")).toContain("capital");
	});

	it("refuses a tier the vocabulary does not have", () => {
		const { problems } = auditVocabulary(
			{ success: "sparkly" as StatusTier },
			FAKE_TIERS,
			FAKE_ENUMS,
			{},
			{},
		);
		expect(problems.join("\n")).toContain("sparkly");
	});

	it("attaches a ruling to the word it is about, without changing the tier", () => {
		// A ruling is a NOTE, never an override — a per-key override table in the generator would
		// be the second source of truth this whole unit removes.
		const { words } = auditVocabulary(
			{ draining: "idle" },
			FAKE_TIERS,
			FAKE_ENUMS,
			{},
			{ draining: "contested; the console wins" },
		);
		expect(words[0].tier).toBe("idle");
		expect(words[0].note).toBe("contested; the console wins");
	});
});

describe("the glyph projection", () => {
	it("refuses a glyph that is the absence sentinel", () => {
		const table = { ...FAKE_GLYPHS, disabled: { glyph: "—", why: "gone" } };
		const problems = auditGlyphs(table, FAKE_TIERS, "—");
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("disabled");
		expect(problems[0]).toContain("format.Dash");
	});

	it("refuses an empty glyph and an empty reason", () => {
		const table = { ...FAKE_GLYPHS, idle: { glyph: "", why: "" } };
		const problems = auditGlyphs(table, FAKE_TIERS, "—");
		expect(problems).toHaveLength(2);
		expect(problems.every((p) => p.includes("idle"))).toBe(true);
	});

	it("refuses an UNDECLARED collision, naming the tier that has to decide", () => {
		const table = { ...FAKE_GLYPHS, live: { glyph: "A", why: "same as active" } };
		const problems = auditGlyphs(table, FAKE_TIERS, "—");
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("live");
	});

	it("accepts a collision the table declares, and only in the direction it declares", () => {
		const declared = { ...FAKE_GLYPHS, live: { glyph: "A", why: "a cell cannot blink", sharesWith: "active" as StatusTier } };
		expect(auditGlyphs(declared, FAKE_TIERS, "—")).toEqual([]);

		// Pointing at a tier that is NOT in the group does not count as declaring this collision.
		const misdirected = { ...FAKE_GLYPHS, live: { glyph: "A", why: "x", sharesWith: "failed" as StatusTier } };
		expect(auditGlyphs(misdirected, FAKE_TIERS, "—")).toHaveLength(1);
	});

	it("refuses a projection for a tier the console no longer has", () => {
		const problems = auditGlyphs(FAKE_GLYPHS, ["active", "pending", "idle", "failed", "disabled"], "—");
		expect(problems.join("\n")).toContain("live");
	});

	it("refuses a tier with no projection at all", () => {
		const { live: _dropped, ...missing } = FAKE_GLYPHS;
		const problems = auditGlyphs(missing as Record<StatusTier, TierProjection>, FAKE_TIERS, "—");
		expect(problems.join("\n")).toContain("live");
	});
});

describe("the absence sentinel is READ, never assumed", () => {
	it("finds the real one in packages/core/format", () => {
		expect(absenceSentinel(FORMAT_GO)).toBe("—");
	});

	it("throws rather than matching nothing when the constant is renamed", () => {
		// The failure mode this closes: a refusal whose subject has moved reports the same green as
		// a table with no dash in it.
		expect(() => absenceSentinel('const EmptyValue = "—"')).toThrow(/could not find/);
	});

	it("throws when the table's belief and the Go constant have parted company", () => {
		expect(() => absenceSentinel('const Dash = "-"')).toThrow(/ABSENCE_SENTINEL/);
	});
});

describe("the gap census", () => {
	it("reports only the values of enums that carry at least one vocabulary word", () => {
		// runner_status contributes nothing (every value is a word); job_status contributes QUEUED's
		// absence; billing_status is status-bearing through `active` alone. An enum with no word at
		// all is not a status enum and is not censused.
		const vocab = ["success", "failed", "online", "offline", "draining", "active"];
		expect(gaps(vocab, FAKE_ENUMS)).toEqual([
			{ enumName: "job_status", value: "QUEUED" },
			{ enumName: "billing_status", value: "canceled" },
			{ enumName: "billing_status", value: "past_due" },
		]);
	});

	it("censuses nothing when no enum carries a word", () => {
		expect(gaps(["nonsense"], FAKE_ENUMS)).toEqual([]);
	});

	it("folds case, so a shouting enum value counts as covered", () => {
		expect(gaps(["queued", "success", "failed"], [FAKE_ENUMS[0]])).toEqual([]);
	});
});

describe("pascal", () => {
	it("names a Go identifier from a status word", () => {
		expect(pascal("active")).toBe("Active");
		expect(pascal("pending_approval")).toBe("PendingApproval");
		expect(pascal("past_due")).toBe("PastDue");
	});
});

describe("the whole pipeline, against the real vocabulary", () => {
	it("emits, and every one of the real words is accounted for", () => {
		const { go, words, problems } = generate(FORMAT_GO);
		expect(problems).toEqual([]);
		expect(go).not.toBeNull();
		expect(words).toHaveLength(Object.keys(STATUS_TIER).length);
		expect(words.every((w) => w.sources.length > 0)).toBe(true);
	});

	it("emits every tier the console declares, and the seven contested words carry their note", () => {
		const { go, words } = generate(FORMAT_GO);
		for (const tier of STATUS_TIERS) {
			// The const block is gofmt-padded, so the gap between the name and the type is not fixed.
			expect(go).toMatch(new RegExp(`StatusTier${pascal(tier)}\\s+StatusTier = ${JSON.stringify(tier)}`));
		}
		const noted = words.filter((w) => w.note !== "").map((w) => w.word).sort();
		expect(noted).toEqual([
			"approved",
			"blocked",
			"claimed",
			"destroyed",
			"destroying",
			"draining",
			"pending",
			"pending_approval",
			"pending_plan",
			"processing",
			"rejected",
			"success",
		]);
	});

	it("carries the DESTROYED ruling into the file, which is the sentence that keeps it fixed", () => {
		// Case 2: the em dash was the absence sentinel AND the destroyed glyph. The reason has to
		// travel with the value or the next reader "fixes" it back.
		const { go } = generate(FORMAT_GO);
		expect(go).toContain("StatusGlyphDisabled = \"◌\"");
		expect(go).not.toContain("StatusGlyphDisabled = \"—\"");
		// Nor the middot it was briefly: that is ui.SymbolBullet, the separator inside a picker
		// label whose FIRST segment is the status glyph, so a destroyed project read as
		// `· my-project · prod · a1b2c3d4`. One ambiguity had been traded for another.
		expect(go).not.toContain("StatusGlyphDisabled = \"·\"");
	});

	it("gives the promotion vocabulary a tier, so nothing decision-bearing is left on the fallback", () => {
		// The six values that used to fall to `idle` — "present, reachable, and not doing anything"
		// — on both surfaces. Written out rather than read from STATUS_TIER: a test that asked the
		// map what it says would pass for the hollow dot this closes.
		const { words, holes } = generate(FORMAT_GO);
		const tierOf = new Map(words.map((w) => [w.word, w.tier]));
		expect(tierOf.get("approved")).toBe("active");
		expect(tierOf.get("rejected")).toBe("failed");
		expect(tierOf.get("blocked")).toBe("failed");
		expect(tierOf.get("pending_approval")).toBe("pending");
		expect(tierOf.get("pending_plan")).toBe("pending");

		// And the census is the other direction of the same claim: neither enum has a value left
		// with no word. Asserted on the ENUM rather than on the count, because a count moves for
		// reasons that have nothing to do with promotions.
		const stillOpen = holes.filter((h) => h.enumName === "promotion_status" || h.enumName === "approval_status");
		expect(stillOpen).toEqual([]);
	});

	it("counts the four enums that live outside lib/db/schema/enums.ts", () => {
		// The regression this file exists to hold shut. `stripe_webhook_event_status` is the one
		// with teeth — it spells `error`, which WIRE_ORIGINS declared unreachable — but all four
		// were invisible for the same reason, and `done` is now a counted gap rather than a silent
		// idle badge.
		const { enums, holes } = generate(FORMAT_GO);
		const names = enums.map((e) => e.name);
		for (const name of [
			"stripe_webhook_event_status",
			"capability_service_kind",
			"capability_quota_kind",
			"email_suppression_reason",
		]) {
			expect(names, `${name} is declared outside enums.ts and must still be censused`).toContain(name);
		}
		expect(holes).toContainEqual({ enumName: "stripe_webhook_event_status", value: "done" });
	});

	it("refuses the WHOLE file when one word loses its provenance", () => {
		// Not "emits it with a hole" — nothing is written. A partially-correct vocabulary in Go is
		// the outcome #3660 was written to prevent.
		const broken = { ...STATUS_TIER, freshly_invented: "idle" as StatusTier };
		const { go, problems } = generate(FORMAT_GO, broken);
		expect(go).toBeNull();
		expect(problems.join("\n")).toContain("freshly_invented");
	});

	it("refuses when the enum module yields nothing, and says so as ONE problem", () => {
		// A broken import would otherwise report every word as provenance-less — 28 problems that
		// nobody reads as "the import broke".
		const { go, problems } = generate(FORMAT_GO, STATUS_TIER, STATUS_TIERS, {});
		expect(go).toBeNull();
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("broken import");
	});

	it("every word WIRE_ORIGINS accounts for is genuinely in no pgEnum", () => {
		// The list is small enough to state, and stating it is the point: these six are the words
		// the schema does not constrain. If one of them acquires a column, this test goes red and
		// the entry must go.
		//
		// It went red exactly once, and only after the import below was widened: `error` sat here
		// claiming NOTHING EMITS THIS while `stripe_webhook_event_status.error` spelled it, and
		// this loop could not see the enum because `schema` was one MODULE of the schema. The
		// subject of a both-directions check is only as wide as what it is pointed at.
		const enums = pgEnums({ ...schema });
		expect(Object.keys(WIRE_ORIGINS).sort()).toEqual([
			"disabled",
			"errored",
			"idle",
			"ready",
			"running",
			"skipped",
		]);
		for (const word of Object.keys(WIRE_ORIGINS)) {
			expect(sourcesFor(word, enums), `${word} now has an enum behind it`).toEqual([]);
		}
	});

	it("the real glyph table draws no tier as the dash", () => {
		for (const [tier, projection] of Object.entries(TIER_GLYPHS)) {
			expect(projection.glyph, `${tier} draws the absence sentinel`).not.toBe("—");
			expect(projection.glyph.length, `${tier} has no glyph`).toBeGreaterThan(0);
		}
	});
});

/**
 * The census ROOT, which the SHAPE walk cannot derive for itself.
 *
 * `pgEnums()` finds every enum in whatever module namespace it is handed, by shape, and its
 * docstring says a hand-typed list is what it exists to avoid. That was true of everything AFTER
 * the root and false of the root itself: the generator imported `@/lib/db/schema/enums`, which is
 * one module of the schema, and four pgEnums lived in siblings that module does not re-export.
 * The set looked derived and its first step was a name somebody chose.
 *
 * So the check has to come from outside the module graph entirely: sweep the FILES for `pgEnum(`
 * and compare the names. Both directions matter — an enum on disk that the barrel cannot reach is
 * the defect that was here, and an enum reachable but not swept means this test has gone blind.
 */
function resolveRepoPackages(): Map<string, string> {
	const dir = resolve(ROOT, "packages");
	const byName = new Map<string, string>();
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const manifest = resolve(dir, entry.name, "package.json");
		let raw: string;
		try {
			raw = readFileSync(manifest, "utf8");
		} catch {
			continue;
		}
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || !("name" in parsed)) continue;
		const { name } = parsed;
		if (typeof name !== "string") continue;
		byName.set(name, resolve(dir, entry.name));
	}
	return byName;
}

/** `./enums` → `<dir>/enums.ts`, or its directory's index. */
function resolveRelativeSpecifier(spec: string, fromFile: string): string | null {
	const base = resolve(dirname(fromFile), spec);
	for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** `@repo/support/enums` → `packages/support/src/enums.ts`, through the package's own exports map. */
function resolveWorkspaceSpecifier(spec: string, packages: Map<string, string>): string | null {
	// The longest package name that prefixes the specifier, so `@repo/a/b` cannot be mistaken for a
	// package called `@repo/a/b` when both `@repo/a` and `@repo/a/b` exist.
	let best: string | null = null;
	for (const name of packages.keys()) {
		if ((spec === name || spec.startsWith(`${name}/`)) && (best === null || name.length > best.length)) best = name;
	}
	if (best === null) return null;
	const dir = packages.get(best);
	if (dir === undefined) return null;
	const subpath = spec === best ? "." : `./${spec.slice(best.length + 1)}`;
	const parsed: unknown = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
	if (typeof parsed !== "object" || parsed === null || !("exports" in parsed)) return null;
	const { exports: exportsField } = parsed;
	if (typeof exportsField !== "object" || exportsField === null) return null;
	const target: unknown = Object.entries(exportsField).find(([key]) => key === subpath)?.[1];
	return typeof target === "string" ? resolve(dir, target) : null;
}

/** Every `pgEnum("name", …)` reachable on disk from the schema directory, name only. */
function sweepEnumNames(): Set<string> {
	const packages = resolveRepoPackages();
	const found = new Set<string>();
	const seen = new Set<string>();
	const queue = readdirSync(SCHEMA_DIR)
		.filter((f) => f.endsWith(".ts"))
		.map((f) => resolve(SCHEMA_DIR, f));

	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined || seen.has(file)) continue;
		seen.add(file);
		let src: string;
		try {
			src = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const m of src.matchAll(/\bpgEnum\(\s*"([^"]+)"/g)) found.add(m[1]);
		// A re-export is part of the schema's surface, so its enums are the schema's too, and the
		// sweep follows every FORM of one rather than the form that was in front of it when this was
		// written. `export * from "@repo/support/enums"` brings six; `export { platformCollectionMethod }
		// from "./enums"` brings one, from a RELATIVE path and a NAMED clause — and a sweep that
		// matched only `export *` from a workspace package missed exactly that one, which is what the
		// both-directions assertion below caught. Followed transitively.
		for (const m of src.matchAll(/\bexport\s+(?:\*(?:\s+as\s+\w+)?|type\s*\{[^}]*\}|\{[^}]*\})\s+from\s+"([^"]+)"/g)) {
			const spec = m[1];
			const target = spec.startsWith(".")
				? resolveRelativeSpecifier(spec, file)
				: resolveWorkspaceSpecifier(spec, packages);
			if (target !== null) queue.push(target);
		}
	}
	return found;
}

describe("the census root is derived, not chosen", () => {
	it("sweeps enough of the tree to be able to disagree", () => {
		// A matcher that has stopped matching reports the same green as a schema with no enums, and
		// the comparison below would then pass by measuring nothing on one side.
		const swept = sweepEnumNames();
		expect(swept.size).toBeGreaterThan(60);
		expect(swept).toContain("promotion_status");
		// The one that was invisible, and the package re-export that is easy to lose.
		expect(swept).toContain("stripe_webhook_event_status");
		expect(swept).toContain("support_case_status");
		// Reached only through a NAMED relative re-export two packages deep. If the sweep is ever
		// narrowed back to `export *`, this is the line that says so.
		expect(swept).toContain("platform_collection_method");
	});

	it("every pgEnum on disk is reachable from the schema barrel, and vice versa", () => {
		const swept = [...sweepEnumNames()].sort();
		const imported = pgEnums({ ...schema })
			.map((e) => e.name)
			.sort();

		// The explanation is folded into the ASSERTED VALUE rather than passed as expect()'s second
		// argument, which `vitest/valid-expect` forbids: a bare `expected [ 'x' ] to equal []` names
		// the enum and says nothing about what to do with it, and the next reader of a red CI log is
		// the person this whole guard is for.
		const unreachable = swept.filter((n) => !imported.includes(n));
		expect(
			unreachable.length === 0
				? ""
				: `${unreachable.join(", ")} — declared in apps/console/lib/db/schema but NOT reachable ` +
					"from `@/lib/db/schema`. The generator's provenance census cannot see these, so a " +
					"status word they spell is reported as having no origin at all, and a WIRE_ORIGINS " +
					"entry claiming nothing emits it passes. Re-export the module from index.ts.",
		).toBe("");

		const unswept = imported.filter((n) => !swept.includes(n));
		expect(
			unswept.length === 0
				? ""
				: `${unswept.join(", ")} — reachable from \`@/lib/db/schema\` but NOT found by the ` +
					"filesystem sweep. This test has gone partly blind, which is worse than the defect " +
					"it guards, because a blind guard reports the same green as a clean tree. Widen " +
					"sweepEnumNames().",
		).toBe("");
	});
});
