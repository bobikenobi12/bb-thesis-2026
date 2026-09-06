// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generates `packages/core/types/vocab_gen.go` — the CLI's status vocabulary, from the console's
 * (`packages/ui/src/status-badge.tsx`).
 *
 * Direction of authority: the console owns how a status is presented, so TypeScript generates and
 * Go consumes. Go cannot write this file, so a Go-only change has no way to make itself right.
 *
 * WHAT THIS REPLACES. `apps/cli/pkg/utils/ui/styles.go` carried `PlainStatusDot`: nine uppercase
 * words, a `default` arm, and no case folding, against a console map of 28 lower-cased keys. They
 * disagreed on seven measured cases — `DRAINING` classified oppositely, `DESTROYED` drawn as the
 * em dash that also means "we could not fill this cell", `SUCCESS` rendered three different ways
 * inside one product, and four words the Go switch simply did not have. `apps/console/scripts/lib/
 * status-vocab.ts` carries the resolution of each, and this file carries them into Go.
 *
 * WHAT IT REFUSES, and why the refusal is the deliverable rather than the map:
 *
 *   - a vocabulary key with NO PROVENANCE — neither a drizzle enum value nor an entry in
 *     WIRE_ORIGINS. `STATUS_TIER` has no single owner: its keys span the pgEnums, the runner's
 *     wire statuses and a few words that belong to no schema at all, and its own docstring
 *     records that the support-case vocabulary is missing entirely. Generating it verbatim would
 *     promote a known-partially-wrong classification into Go with nothing marking which parts are
 *     known. So every key has to say where it comes from, and "nothing emits this" is a real
 *     answer — provided it is TRUE, which is a claim about the whole schema and not about one
 *     module of it. See pgEnums() below.
 *   - a decision about a key that is GONE — WIRE_ORIGINS or RULINGS naming a word the vocabulary
 *     no longer has. A table that describes things that do not exist reads as more complete than
 *     it is.
 *   - a WIRE_ORIGINS entry for a key that DOES have an enum, which is the mirror of the first:
 *     the derived provenance is better than the typed one and the typed one would hide it.
 *   - a tier glyph that is the ABSENCE SENTINEL, or an undeclared collision between two tiers'
 *     glyphs. The em dash is `packages/core/format.Dash` — read out of that file here rather than
 *     trusted from a constant, so a rename is loud instead of quietly stopping to match.
 *
 * WHAT IT DOES NOT DO. It does not fix the vocabulary. A handful of keys correspond to no pgEnum
 * at all and a large number of pgEnum values correspond to no key and therefore fall to `idle` on
 * both surfaces. Both facts survive this generator; what changes is that they are now COUNTED —
 * `StatusVocabularyGaps` in the emitted file lists every one, derived, so the gap cannot shrink or
 * grow without a diff. Fixing it is a domain-modelling task with its own lane.
 *
 * Usage:
 *   pnpm -C apps/console run gen:go-vocab          # regenerate
 *   pnpm -C apps/console run gen:go-vocab:check    # same run, without the write
 *
 * `--check` renders the file into memory and throws it away, so it runs every refusal the write
 * path runs — the emitter holds some of them, and a check that returned before rendering would
 * report "no gaps" for a vocabulary the generator would not emit from. The only thing it does not
 * do is compare against the committed file; that is CI's job, which runs the regenerate +
 * `git diff --exit-code` pair.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { STATUS_TIER, STATUS_TIERS, type StatusTier } from "@repo/ui/status-badge";

import * as schema from "@/lib/db/schema";
import {
	ABSENCE_SENTINEL,
	RULINGS,
	TIER_GLYPHS,
	WIRE_ORIGINS,
	type TierProjection,
} from "./lib/status-vocab";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const OUT = resolve(ROOT, "packages/core/types/vocab_gen.go");
const FORMAT_GO = resolve(ROOT, "packages/core/format/format.go");

const OUT_REL = "packages/core/types/vocab_gen.go";
const VOCAB_REL = "packages/ui/src/status-badge.tsx";
const SCHEMA_REL = "apps/console/lib/db/schema";
const TABLE_REL = "apps/console/scripts/lib/status-vocab.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Deriving the enums
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One drizzle pgEnum, reduced to the two things this generator needs. */
export interface PgEnum {
	name: string;
	values: readonly string[];
}

/**
 * Every pgEnum reachable from the schema barrel, by SHAPE rather than by a list.
 *
 * `gen-go-enums.ts` names its eighteen by hand because the Go constants it emits are a curated
 * subset. This generator must not: the question here is "does any enum in the schema contain this
 * word", and a hand-typed list answers it for the enums somebody remembered. A status enum added
 * tomorrow is found by this and would be invisible to a list.
 *
 * WHAT THE SHAPE WALK DOES NOT GIVE YOU FOR FREE: a walk is only as wide as the module you point
 * it at, and the ROOT is hand-picked even when everything after it is derived. This read
 * `@/lib/db/schema/enums` until #4117, which is not the schema — it is one module of it, and four
 * pgEnums live in siblings it does not re-export (`stripe_webhook_event_status`,
 * `capability_service_kind`, `capability_quota_kind`, `email_suppression_reason`). The cost was
 * not cosmetic: `error` is `stripe_webhook_event_status.error`, so the vocabulary shipped a
 * WIRE_ORIGINS sentence saying nothing emitted it, and the third refusal below — "a WIRE_ORIGINS
 * entry for a key that DOES have an enum" — passed because it could not see the enum. A guard
 * reporting green for the reason it exists to catch.
 *
 * It now reads `@/lib/db/schema`, the barrel every table module is re-exported through, and
 * `gen-go-vocab.test.ts` sweeps `pgEnum(` off the filesystem — including the packages the schema
 * re-exports, resolved through their own `exports` maps — and compares the SET of names. The
 * derivation of the root is the half a SHAPE walk cannot do for itself.
 *
 * Sorted by name so the emitted provenance is stable — an ES module namespace object's key order
 * is specified, but it is alphabetical by export name, which is not the same thing as the enum's
 * own name and would move if an export were renamed.
 */
export function pgEnums(mod: Readonly<Record<string, unknown>>): PgEnum[] {
	const found: PgEnum[] = [];
	for (const value of Object.values(mod)) {
		// Narrowed rather than asserted: this walks a module namespace whose members are `unknown`,
		// and a cast here would let a future non-enum export with the right two property names in.
		if (value === null || (typeof value !== "object" && typeof value !== "function")) continue;
		if (!("enumName" in value) || !("enumValues" in value)) continue;
		const { enumName, enumValues } = value;
		if (typeof enumName !== "string" || !Array.isArray(enumValues)) continue;
		const values: string[] = [];
		let allStrings = true;
		for (const v of enumValues) {
			if (typeof v === "string") values.push(v);
			else allStrings = false;
		}
		if (!allStrings) continue;
		found.push({ name: enumName, values });
	}
	found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return found;
}

/**
 * The enum values that back a vocabulary word, as `enum_name.VALUE`, in enum-name order.
 *
 * The comparison is case-INSENSITIVE because that is the defect this whole unit closes: the
 * vocabulary is lower-cased and six pgEnums shout on the wire, so `project_status.ACTIVE` and the
 * key `active` are the same fact written two ways.
 */
export function sourcesFor(word: string, enums: readonly PgEnum[]): string[] {
	const out: string[] = [];
	for (const e of enums) {
		for (const v of e.values) {
			if (v.toLowerCase() === word) out.push(`${e.name}.${v}`);
		}
	}
	return out;
}

/** One enum value the vocabulary does not name. */
export interface Gap {
	enumName: string;
	value: string;
}

/**
 * Every value of a STATUS-BEARING enum that the vocabulary has no word for.
 *
 * "Status-bearing" is DERIVED, not declared: an enum qualifies when at least one of its values is
 * a vocabulary word. That rule needs no maintenance and cannot quietly stop covering an enum —
 * and it is deliberately a little over-inclusive. `audit_action` is in the census only because
 * `DESTROYED` is both a project status and an audit verb, and seeing it there is the point: the
 * census reports what the rule finds, not what the author expected it to find.
 *
 * These are not refusals. Every one of them renders as the `idle` fallback on BOTH surfaces
 * today; counting them is how the gap stops being invisible, and closing it is a vocabulary
 * decision this generator does not get to make.
 */
export function gaps(vocab: readonly string[], enums: readonly PgEnum[]): Gap[] {
	const known = new Set(vocab);
	const out: Gap[] = [];
	for (const e of enums) {
		if (!e.values.some((v) => known.has(v.toLowerCase()))) continue;
		for (const v of e.values) {
			if (!known.has(v.toLowerCase())) out.push({ enumName: e.name, value: v });
		}
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The audits
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A vocabulary word, resolved against everything that has an opinion about it. */
export interface ResolvedWord {
	word: string;
	tier: StatusTier;
	/** `enum` when a pgEnum value spells it, `wire` when only WIRE_ORIGINS accounts for it. */
	provenance: "enum" | "wire";
	/** `enum_name.VALUE` pairs, or the single declared origin. */
	sources: string[];
	/** The RULINGS note, or "". */
	note: string;
}

/**
 * Reads the real absence sentinel out of `packages/core/format/format.go`.
 *
 * Not `ABSENCE_SENTINEL` itself, and not a `?? fallback`: a check whose subject has been renamed
 * must FAIL, not silently start matching nothing. That is the difference between "no glyph is the
 * dash" and "I could not find out what the dash is", and they must not share an exit code.
 */
export function absenceSentinel(formatGo: string): string {
	const m = /^const Dash = "(.+)"$/m.exec(formatGo);
	if (m === null) {
		throw new Error(
			`could not find 'const Dash = "…"' in packages/core/format/format.go. The absence sentinel is what ${TABLE_REL} refuses to use as a tier glyph, and this generator will not guess it — if the constant was renamed, point absenceSentinel() at the new one.`,
		);
	}
	if (m[1] !== ABSENCE_SENTINEL) {
		throw new Error(
			`packages/core/format.Dash is ${JSON.stringify(m[1])} but ${TABLE_REL} believes it is ${JSON.stringify(ABSENCE_SENTINEL)}. Update ABSENCE_SENTINEL — the glyph refusal below is only as good as the rune it compares against.`,
		);
	}
	return m[1];
}

/**
 * Audits the glyph table: nothing may be the absence sentinel, nothing may be empty, and two
 * tiers may share a glyph only when the table says which one it is sharing with.
 *
 * The collision rule is the one worth stating. `live` and `active` deliberately draw the same
 * dot, because a cell cannot blink — that is an honest loss and the table says so. An
 * UNDECLARED collision is two tiers a reader cannot tell apart with nothing recording that
 * anybody noticed, which is how a projection stops being a projection.
 */
export function auditGlyphs(
	table: Readonly<Record<StatusTier, TierProjection>>,
	tiers: readonly StatusTier[],
	sentinel: string,
): string[] {
	const problems: string[] = [];
	const byGlyph = new Map<string, StatusTier[]>();

	for (const tier of tiers) {
		const p = table[tier];
		if (p === undefined) {
			problems.push(
				`the tier ${tier} has no entry in TIER_GLYPHS (${TABLE_REL}). Decide what a terminal draws for it — an unglyphed tier renders as nothing, which is not a different state, it is an invisible one.`,
			);
			continue;
		}
		if (p.glyph === "") {
			problems.push(`${tier} has an empty glyph in TIER_GLYPHS — say what the terminal draws.`);
		}
		if (p.why.trim() === "") {
			problems.push(`${tier} has an empty reason in TIER_GLYPHS — the reason is carried into ${OUT_REL} and is the only thing standing between the glyph and somebody "fixing" it.`);
		}
		if (p.glyph === sentinel) {
			problems.push(
				`${tier} is drawn as ${JSON.stringify(sentinel)}, which is the empty-value sentinel (packages/core/format.Dash, reached through ui.OrDash / ui.StrOrDash / ui.StampOrDash). A status drawn as the dash is indistinguishable from a cell nobody could fill.`,
			);
		}
		byGlyph.set(p.glyph, [...(byGlyph.get(p.glyph) ?? []), tier]);
	}

	// A collision group has one PRIMARY — the tier that owns the glyph — and every other member
	// must name a member of the group in `sharesWith`. Requiring the primary to declare too would
	// mean `active` pointing at `live`, which reads backwards: `live` is the one that collapses.
	for (const [glyph, sharers] of byGlyph) {
		if (sharers.length < 2) continue;
		const declaredBy = new Map<StatusTier, StatusTier>();
		for (const tier of sharers) {
			const target = table[tier]?.sharesWith;
			if (target !== undefined && target !== tier && sharers.includes(target)) {
				declaredBy.set(tier, target);
			}
		}
		const targets = new Set(declaredBy.values());
		// ONE problem for the group, not one per member: a collision is a single decision somebody
		// has to make, and N copies of it in a CI log read as N separate defects.
		const undeclared = sharers.filter((t) => !declaredBy.has(t) && !targets.has(t));
		if (undeclared.length > 0) {
			problems.push(
				`${undeclared.join(", ")} draw${undeclared.length === 1 ? "s" : ""} ${JSON.stringify(glyph)}, which ${sharers.join(", ")} all draw, and TIER_GLYPHS does not declare the collision. Set sharesWith on the tier that COLLAPSES onto the other and say in its reason what the terminal cannot carry — or give it its own glyph.`,
			);
		}
	}

	// Tiers the vocabulary no longer has. Record<StatusTier, …> catches this at type-check, but
	// the generator runs under tsx, which strips types and would emit a projection for a tier that
	// is gone.
	for (const tier of Object.keys(table)) {
		if (!tiers.some((t) => t === tier)) {
			problems.push(
				`TIER_GLYPHS carries a projection for the tier ${tier}, which is no longer in STATUS_TIERS (${VOCAB_REL}). Delete the entry.`,
			);
		}
	}
	return problems;
}

/**
 * Audits the vocabulary against its provenance, and returns one resolved word per key.
 *
 * The three failures are reported separately because they need different fixes: a key nobody can
 * account for, an origin typed for a key that has a real enum behind it, and a decision left
 * behind by a key that is gone.
 */
export function auditVocabulary(
	vocab: Readonly<Record<string, StatusTier>>,
	tiers: readonly StatusTier[],
	enums: readonly PgEnum[],
	origins: Readonly<Record<string, string>> = WIRE_ORIGINS,
	rulings: Readonly<Record<string, string>> = RULINGS,
): { words: ResolvedWord[]; problems: string[] } {
	const problems: string[] = [];
	const words: ResolvedWord[] = [];
	const usedOrigins = new Set<string>();

	for (const [word, tier] of Object.entries(vocab)) {
		if (word !== word.toLowerCase()) {
			// statusTier() lower-cases before the lookup, so an upper-case key is unreachable — it
			// would sit in the map looking like a decision and never once be consulted.
			problems.push(
				`${word} is a STATUS_TIER key with a capital in it. statusTier() lower-cases its argument before the lookup, so this key can never be hit; the Go mirror folds the same way and would not hit it either.`,
			);
		}
		if (!tiers.includes(tier)) {
			problems.push(`${word} maps to the tier ${tier}, which is not in STATUS_TIERS (${VOCAB_REL}).`);
		}

		const sources = sourcesFor(word, enums);
		const origin = origins[word];
		if (sources.length > 0) {
			if (origin !== undefined) {
				usedOrigins.add(word);
				problems.push(
					`${word} has a WIRE_ORIGINS entry and is also ${sources.join(", ")}. The derived provenance is the better answer and the typed one hides it — delete the entry from ${TABLE_REL}.`,
				);
			}
			words.push({ word, tier, provenance: "enum", sources, note: rulings[word] ?? "" });
			continue;
		}
		// Marked used BEFORE the blank check: a blank entry is one problem ("say what emits it"),
		// and letting it fall through to the orphan sweep below would add a second one saying the
		// word is not in the vocabulary, which is both wrong and the louder of the two.
		if (origin !== undefined) usedOrigins.add(word);
		if (origin === undefined || origin.trim() === "") {
			problems.push(
				`${word} is a status in ${VOCAB_REL} and is in none of the ${enums.length} pgEnums reachable from ${SCHEMA_REL}, so nothing says where it comes from. Add an entry to WIRE_ORIGINS in ${TABLE_REL} naming what emits it — "nothing emits this" is an answer, and a useful one.`,
			);
			continue;
		}
		words.push({ word, tier, provenance: "wire", sources: [origin], note: rulings[word] ?? "" });
	}

	for (const word of Object.keys(origins)) {
		if (usedOrigins.has(word)) continue;
		problems.push(
			`${TABLE_REL} carries a WIRE_ORIGINS entry for ${word}, which is not a status in ${VOCAB_REL}. Delete it — a provenance table that describes words nobody uses reads as more complete than it is.`,
		);
	}
	for (const word of Object.keys(rulings)) {
		if (word in vocab) continue;
		problems.push(
			`${TABLE_REL} carries a RULINGS note about ${word}, which is not a status in ${VOCAB_REL}. Delete it.`,
		);
	}
	return { words, problems };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Emitting
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** `active` → `Active`; `pending_approval` → `PendingApproval`. */
export function pascal(s: string): string {
	return s
		.split(/[_\-\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
		.join("");
}

/** A Go string literal. JSON's escaping and Go's agree on everything these values contain. */
function q(s: string): string {
	return JSON.stringify(s);
}

/** Wraps prose into `//` comment lines at a fixed width, so the output is gofmt-stable. */
export function goComment(text: string, indent = ""): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (const w of words) {
		if (line === "") line = w;
		else if (`${line} ${w}`.length > 96) {
			lines.push(line);
			line = w;
		} else line += ` ${w}`;
	}
	if (line !== "") lines.push(line);
	return lines.map((l) => `${indent}// ${l}`);
}

/** Pads each row's columns to the widest, the way gofmt aligns a const block. */
function alignRows(rows: string[][], indent = "\t"): string {
	if (rows.length === 0) return "";
	const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
	return rows
		.map((r) => indent + r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join(" ").trimEnd())
		.join("\n");
}

/** Renders the whole Go file. */
export function renderGo(
	words: readonly ResolvedWord[],
	tiers: readonly StatusTier[],
	table: Readonly<Record<StatusTier, TierProjection>>,
	holes: readonly Gap[],
	enumCount: number,
): string {
	const tierConsts = alignRows(
		tiers.map((t) => [`StatusTier${pascal(t)}`, "StatusTier =", q(t)]),
	);
	const allTiers = tiers.map((t) => `\tStatusTier${pascal(t)},`).join("\n");

	const glyphConsts = tiers
		.map((t) => {
			const p = table[t];
			const shared =
				p.sharesWith === undefined
					? ""
					: ` It is deliberately the same glyph as StatusGlyph${pascal(p.sharesWith)}.`;
			return [
				...goComment(`StatusGlyph${pascal(t)} — ${p.why}.${shared}`, "\t"),
				`\tStatusGlyph${pascal(t)} = ${q(p.glyph)}`,
			].join("\n");
		})
		.join("\n\n");

	const glyphMap = alignRows(
		tiers.map((t) => [`StatusTier${pascal(t)}:`, `StatusGlyph${pascal(t)},`]),
	);

	const vocabRows = words
		.map((w) => {
			const sources = w.sources.map(q).join(", ");
			const head = `\t{Status: ${q(w.word)}, Tier: StatusTier${pascal(w.tier)}, Provenance: ${w.provenance === "enum" ? "StatusFromEnum" : "StatusFromWire"},`;
			// `Note:` is padded to `Sources:` because gofmt aligns the keys of a multi-line
			// composite literal, and an unpadded key makes every regenerate a formatting diff.
			const body = `\t\tSources: []string{${sources}},`;
			const note = `\t\tNote:    ${q(w.note)}},`;
			return [head, body, note].join("\n");
		})
		.join("\n");

	const tierMap = alignRows(words.map((w) => [`${q(w.word)}:`, `StatusTier${pascal(w.tier)},`]));

	const gapRows = holes.map((g) => `\t{Enum: ${q(g.enumName)}, Value: ${q(g.value)}},`).join("\n");

	const enumBacked = words.filter((w) => w.provenance === "enum").length;
	const wireBacked = words.length - enumBacked;
	const gapEnums = new Set(holes.map((g) => g.enumName)).size;

	return `// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Code generated by apps/console/scripts/gen-go-vocab.ts; DO NOT EDIT.
// Regenerate with: pnpm -C apps/console run gen:go-vocab
//
// Source of truth: ${VOCAB_REL} (the words and their tiers), ${SCHEMA_REL}
// (their provenance) and ${TABLE_REL} (the terminal projection).
//
// This is the ONE status vocabulary. Before it, apps/cli/pkg/utils/ui/styles.go decided a status
// glyph from nine uppercase words and a default arm, with no case folding, against a console map
// of ${words.length} lower-cased keys — so the two surfaces disagreed on seven measured cases and
// six pgEnums that shout on the wire missed every arm of the switch. The CLI now reads this file
// and decides nothing.
//
// PROVENANCE IS EMITTED, and that is the point of the file rather than a decoration. ${enumBacked} of the
// ${words.length} words are a drizzle enum value; ${wireBacked} are in NO pgEnum and carry the declared origin
// instead. The generator refuses to emit a word that can say neither, because a vocabulary with
// no single owner drifts by OMISSION — a word nobody can account for looks exactly like one
// everybody agreed on.
//
// WHAT IS STILL WRONG, counted rather than hidden: StatusVocabularyGaps below holds ${holes.length} values
// across ${gapEnums} status-bearing enums that this vocabulary has no word for. Every one of them resolves
// to ${"StatusTierIdle"} — "present but not doing anything" — on BOTH surfaces, which for an approved
// promotion or a blocked one is wrong in the same way on both. Fixing that is a vocabulary
// decision, not a rendering one, and it does not belong to the generator.

package types

import "strings"

// StatusTier is the grayscale visual tier a status resolves to. State reads through glyph shape
// and ink weight, never hue.
type StatusTier string

const (
${tierConsts}
)

// AllStatusTiers is every tier, in the order ${VOCAB_REL} declares them.
var AllStatusTiers = []StatusTier{
${allTiers}
}

// StatusTierFallback is what an unrecognised status resolves to.
//
// It mirrors statusTier()'s fallback exactly, INCLUDING its silence. The console warns once per
// unknown status in development; a CLI has no equivalent moment, so the honest place to look for
// what this is swallowing is StatusVocabularyGaps at the bottom of this file.
const StatusTierFallback = StatusTierIdle

// The terminal projection of each tier. The em dash appears nowhere here on purpose: it is the
// empty-value sentinel (format.Dash), and a status drawn as the dash is indistinguishable from a
// cell nobody could fill.
const (
${glyphConsts}
)

// StatusGlyphs indexes the glyphs by tier. It is built FROM the constants above, so the table and
// the values cannot disagree.
var StatusGlyphs = map[StatusTier]string{
${glyphMap}
}

// StatusProvenance says what accounts for a word being in the vocabulary at all.
type StatusProvenance string

const (
	// StatusFromEnum — a drizzle pgEnum spells this word; Sources names every enum and value.
	StatusFromEnum StatusProvenance = "enum"
	// StatusFromWire — no pgEnum has it. Sources holds the single declared origin, which may itself
	// be the statement that nothing emits the word at all.
	StatusFromWire StatusProvenance = "wire"
)

// StatusWord is one entry of the vocabulary, with everything known about where it came from.
type StatusWord struct {
	Status     string
	Tier       StatusTier
	Provenance StatusProvenance
	Sources    []string
	// Note records a decision where the two surfaces used to disagree, so the terminal's change
	// of behaviour is reviewable rather than archaeological. Empty for a word nobody argued about.
	Note string
}

// StatusVocabulary is every word, in the order ${VOCAB_REL} declares them — which is grouped by
// tier, so a reordering there is a diff somebody has to look at here.
var StatusVocabulary = []StatusWord{
${vocabRows}
}

// StatusTiers indexes the vocabulary by its lower-case word.
var StatusTiers = map[string]StatusTier{
${tierMap}
}

// StatusTierOf resolves a status of any casing to its tier, falling back to StatusTierFallback.
//
// This mirrors statusTier() in ${VOCAB_REL}, whose lookup is
// STATUS_TIER[status.toLowerCase()]. strings.ToLower and JavaScript's toLowerCase disagree on a
// handful of non-ASCII runes; every word in this vocabulary and every pgEnum value that reaches
// it is ASCII, so the two folds cannot part company on anything the product emits.
func StatusTierOf(status string) StatusTier {
	if tier, ok := StatusTiers[strings.ToLower(status)]; ok {
		return tier
	}
	return StatusTierFallback
}

// StatusGlyphOf is the glyph a terminal draws for a status of any casing.
func StatusGlyphOf(status string) string {
	return StatusGlyphs[StatusTierOf(status)]
}

// StatusGap is one value of a status-bearing enum that the vocabulary has no word for, and which
// therefore renders as StatusTierFallback on both surfaces.
type StatusGap struct {
	Enum  string
	Value string
}

// StatusVocabularyGaps is every such value, derived rather than declared: of the ${enumCount} pgEnums in the
// schema, an enum counts as status-bearing when at least one of ITS OWN values is a vocabulary
// word. The rule needs no maintenance and cannot quietly stop covering an enum, and it is
// deliberately a little over-inclusive — audit_action is here only because DESTROYED is both a
// project status and an audit verb — because a census that reports what the rule finds is worth
// more than one filtered down to what its author expected.
//
// This list is EXPECTED to be non-empty. It shrinks when somebody adds a word to
// ${VOCAB_REL}, and it is diff-gated, so it cannot grow without a review.
var StatusVocabularyGaps = []StatusGap{
${gapRows}
}
`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The pipeline
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The WHOLE pipeline: audit, then render. `go` is the file's contents when the vocabulary
 * projects cleanly and `null` when it does not, with `problems` holding every reason.
 *
 * Rendering IS the check, so `--check` and the write path cannot answer differently — the split
 * that let `gen-go-brand.ts` print "no gaps" for a stylesheet it would not emit from.
 */
export function generate(
	formatGo: string,
	vocab: Readonly<Record<string, StatusTier>> = STATUS_TIER,
	tiers: readonly StatusTier[] = STATUS_TIERS,
	// Spread rather than asserted: a module namespace object has no index signature, so it is not
	// assignable to Record<string, unknown> without a cast, and this file has no casts.
	mod: Readonly<Record<string, unknown>> = { ...schema },
	table: Readonly<Record<StatusTier, TierProjection>> = TIER_GLYPHS,
): { go: string | null; words: ResolvedWord[]; holes: Gap[]; enums: PgEnum[]; problems: string[] } {
	const enums = pgEnums(mod);
	const problems: string[] = [];

	if (enums.length === 0) {
		// An empty enum set would make every word provenance-less, which the audit would report as
		// 28 separate problems and nobody would read as "the import broke".
		problems.push(
			`no pgEnums were found in ${SCHEMA_REL}. That is a broken import, not a schema with no enums — every word's provenance is derived from them.`,
		);
		return { go: null, words: [], holes: [], enums, problems };
	}

	let sentinel: string;
	try {
		sentinel = absenceSentinel(formatGo);
	} catch (err) {
		problems.push(err instanceof Error ? err.message : String(err));
		return { go: null, words: [], holes: [], enums, problems };
	}

	problems.push(...auditGlyphs(table, tiers, sentinel));
	const { words, problems: vocabProblems } = auditVocabulary(vocab, tiers, enums);
	problems.push(...vocabProblems);

	const holes = gaps(Object.keys(vocab), enums);
	if (problems.length > 0) return { go: null, words, holes, enums, problems };

	try {
		return { go: renderGo(words, tiers, table, holes, enums.length), words, holes, enums, problems };
	} catch (err) {
		// Reported in the same shape as every other refusal: a bare stack trace reads in a CI log
		// as a crash in the tooling rather than as a decision somebody has to make.
		return { go: null, words, holes, enums, problems: [err instanceof Error ? err.message : String(err)] };
	}
}

function main(): void {
	const checkOnly = process.argv.includes("--check");
	const { go, words, holes, enums, problems } = generate(readFileSync(FORMAT_GO, "utf8"));

	if (go === null) {
		console.error(
			`::error::${OUT_REL} cannot be generated from ${VOCAB_REL} — ${problems.length} problem(s). Either a status has no provenance, or a decision in ${TABLE_REL} describes something that is gone. Fix them, then run 'pnpm -C apps/console run gen:go-vocab'.`,
		);
		for (const p of problems) console.error(`  · ${p}`);
		process.exit(1);
	}

	const enumBacked = words.filter((w) => w.provenance === "enum").length;
	const summary = `${words.length} statuses — ${enumBacked} from a pgEnum, ${words.length - enumBacked} declared wire-only; ${enums.length} enums censused, ${holes.length} enum values with no word (they render as ${"idle"} on both surfaces)`;

	if (checkOnly) {
		console.log(`status vocabulary: ${summary}; renders, every word accounted for`);
		return;
	}

	writeFileSync(OUT, go, "utf8");
	console.log(`wrote ${OUT_REL} — ${summary}`);
	// The gap census is printed, not just emitted, because it is the number this generator exists
	// to keep honest and nobody opens a generated file to look for it.
	for (const g of holes) console.log(`  gap  ${g.enumName}.${g.value}`);
}

// Only when run as a script: the pure functions above are imported by the unit tests.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
