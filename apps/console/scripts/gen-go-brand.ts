// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generates `packages/core/types/brand_gen.go` — the terminal projection of the brand tokens,
 * from the stylesheet that owns them (`packages/brand/src/tokens.css`).
 *
 * This is not "share what is shareable" and it is not "copy everything". EVERY custom property
 * declared in that stylesheet carries exactly one of `exact`, `lossy` or `none` in
 * `scripts/lib/brand-projection.ts`, and this generator REFUSES TO EMIT if one does not. That
 * refusal is the point of the whole file: without it, a token added to the console is a token
 * the CLI silently does not have, and the two surfaces drift by omission — which is how they
 * got here. `apps/cli/pkg/utils/ui/styles.go` carried five hand-typed AdaptiveColors — ten hex
 * values across the two themes — under a comment calling them "a terminal projection of the
 * OKLCH neutral ink ramp". Exactly one of the ten (#FAFAFA, the ramp's gray-50) was a value in
 * that ramp; #808080, #B3B3B3, #A3A3A3, #3D3D3D, #757575, #595959 and #161616 are not steps of
 * anything, and nothing could tell.
 *
 * Direction of authority: the console owns the design system, so TS generates and Go consumes.
 * Go cannot write this file, so a Go-only change has no way to make itself right.
 *
 * Usage:
 *   pnpm -C apps/console run gen:go-brand          # regenerate
 *   pnpm -C apps/console run gen:go-brand:check    # same run, without the write — non-zero if the
 *                                         # stylesheet cannot be projected
 *
 * `--check` renders the file into memory and throws it away. It runs every refusal the write
 * path runs, because half of them live in the emitter rather than in the audit; the only thing
 * it does NOT do is compare against the committed file. That comparison is CI's job — it runs
 * the regenerate + `git diff --exit-code` pair, so a stale committed file fails the build and
 * names this command. `--check` is the strictly weaker, human-facing question ("can this
 * stylesheet be projected at all?"), which is why CI does not run it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { COLLAPSING_PORTS, collapses, PROJECTIONS, tailwindBinding, type Projection } from "./lib/brand-projection";
import { carriesAlpha, colorPair, type ColorPair, type ThemeMap } from "./lib/brand-resolve";
import { parseDeclarations, tokenCensus, type TokenDeclaration } from "./lib/css-tokens";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS = resolve(HERE, "../../../packages/brand/src/tokens.css");
const OUT = resolve(HERE, "../../../packages/core/types/brand_gen.go");
const TOKENS_REL = "packages/brand/src/tokens.css";
const OUT_REL = "packages/core/types/brand_gen.go";
const TABLE_REL = "apps/console/scripts/lib/brand-projection.ts";

/** A token plus the projection decision that covers it. */
export interface ResolvedToken {
	name: string;
	projection: Projection;
	/** The Go identifier this token's value is emitted under, or "" when it projects to nothing. */
	ident: string;
}

/** `--text-display-lg` → `TextDisplayLg`. Digits stay attached (`--gray-1050` → `Gray1050`). */
export function pascal(token: string): string {
	return token
		.replace(/^--/, "")
		.split("-")
		.filter(Boolean)
		.map((s) => s.charAt(0).toUpperCase() + s.slice(1))
		.join("");
}

/** The Go identifier a projected token's value lands on, by port. */
export function identFor(token: string, projection: Projection): string {
	if (projection.kind === "none") return "";
	const port = projection.port;
	if (collapses(port)) {
		// These collapse SEVERAL tokens onto one constant, so the constant is named by the
		// table (`to`), not derived from the token — deriving it would give six names for
		// two borders and hide the collapse this file exists to make visible.
		return projection.kind === "lossy" ? (projection.to ?? "") : "";
	}
	// Every other port gives the token its own constant, named from the token. `to` is NOT
	// consulted here, and `auditProjections` refuses an entry that sets one — a discarded `to`
	// would make BrandProjections.Target publish a symbol the table does not name.
	switch (port) {
		case "color":
			return `Color${pascal(token)}`;
		case "layer":
			return `Layer${pascal(token).replace(/^Z/, "")}`;
		case "duration":
			return pascal(token);
		case "tracking":
			// `Em` is part of the identifier, not a suffix the emitter adds: BrandProjections
			// names the Go symbol a reader is meant to jump to, and `TrackingEyebrow` would name
			// one that does not exist.
			return `Tracking${pascal(token).replace(/^Tracking/, "")}Em`;
	}
}

/**
 * Audits the census against the table. Returns one human-readable problem per line; an empty
 * array means every declared token carries a decision.
 *
 * The three failures it reports are the three ways the table can stop describing the
 * stylesheet, and they are reported separately because they need different fixes:
 *
 *   - a token with NO entry — somebody added a token and nobody decided what the CLI does;
 *   - an entry for a token that no longer exists — the stylesheet moved on and the table kept
 *     a decision about nothing, which is how a table starts reading as more complete than it is;
 *   - an entry that claims `lossy` or `none` without saying why, or `exact` without a note.
 */
export function auditProjections(
	census: readonly string[],
	decls: readonly TokenDeclaration[],
	table: Readonly<Record<string, Projection>> = PROJECTIONS,
): string[] {
	const problems: string[] = [];
	const present = new Set(census);
	const covered = new Set<string>();

	for (const token of census) {
		const explicit = table[token];
		// The same `table` the audit was handed, never the module's own: a check that consults a
		// different table than its caller is answering a different question.
		const derived = explicit === undefined ? tailwindBinding(token, decls, present, table) : null;
		const p = explicit ?? derived;
		if (p === null || p === undefined) {
			problems.push(
				`${token} is declared in ${TOKENS_REL} and has no projection. Add an entry to ${TABLE_REL}: exact (the terminal carries it), lossy (name what it collapses to and why) or none (one line saying why a terminal has no analogue).`,
			);
			continue;
		}
		if (explicit !== undefined) covered.add(token);
		if (p.kind === "exact" && p.note.trim() === "") {
			problems.push(`${token} is marked exact with an empty note — say what it becomes.`);
		}
		if (p.kind === "lossy") {
			if (p.why.trim() === "") {
				problems.push(`${token} is marked lossy with an empty reason — a lossy entry must name what it collapses to and why.`);
			}
			if (collapses(p.port) && (p.to ?? "").trim() === "") {
				problems.push(`${token} is marked lossy but names no collapse target — say which Go constant it becomes.`);
			}
			// The mirror of the rule above, and the reason both are stated in terms of the PORT
			// rather than in terms of `color`: a `to` on a port that does not collapse is
			// discarded by identFor, so the table and the generated Target would name two
			// different Go symbols and nothing would say so.
			if (!collapses(p.port) && (p.to ?? "").trim() !== "") {
				problems.push(
					`${token} names the collapse target ${p.to} on the ${p.port} port, which does not collapse — it gives every token its own constant, and this one is emitted as ${identFor(token, p)}. Drop 'to', or move the token to a collapsing port (${COLLAPSING_PORTS.join(", ")}).`,
				);
			}
		}
		if (p.kind === "none" && p.why.trim() === "") {
			problems.push(`${token} is marked none with an empty reason — 'none' is an answer only when it says why.`);
		}
	}

	for (const token of Object.keys(table)) {
		if (covered.has(token)) continue;
		problems.push(
			`${TABLE_REL} carries a projection for ${token}, which is no longer declared in ${TOKENS_REL}. Delete the entry — a table that describes tokens that do not exist reads as more complete than it is.`,
		);
	}
	return problems;
}

/**
 * Checks the claims the table makes about colour values against the values themselves.
 *
 * A colour marked `exact` must resolve to an opaque value in BOTH themes, and one marked
 * `lossy` must actually carry alpha somewhere — otherwise it is a `lossy` label on a lossless
 * projection, which trains a reader to ignore the label. This catches the direction that
 * matters most: a token whose dark value GAINS an alpha channel later would keep an `exact`
 * entry and start lying, and nothing else in the pipeline would notice.
 */
export function auditColorClaims(
	tokens: readonly ResolvedToken[],
	light: ThemeMap,
	dark: ThemeMap,
): string[] {
	const problems: string[] = [];
	for (const { name, projection } of tokens) {
		if (projection.kind === "none" || projection.port !== "color") continue;
		const alpha = carriesAlpha(name, light, dark);
		if (projection.kind === "exact" && alpha) {
			problems.push(
				`${name} is marked exact but its value carries alpha, which a terminal cell cannot hold. Mark it lossy and say what it is flattened against.`,
			);
		}
		if (projection.kind === "lossy" && !alpha) {
			problems.push(
				`${name} is marked lossy but resolves opaque in both themes — nothing is lost. Mark it exact.`,
			);
		}
	}
	return problems;
}

/** Builds the two theme maps: `@theme`/`:root` for light, the same overlaid with `.dark`. */
export function themeMaps(decls: readonly TokenDeclaration[]): { light: ThemeMap; dark: ThemeMap } {
	const light = new Map<string, string>();
	const dark = new Map<string, string>();
	for (const d of decls) {
		// `@media` re-declarations are breakpoint variants of a base value that is declared
		// unconditionally elsewhere; the terminal has no breakpoints, so the base wins.
		if (d.inMedia) continue;
		if (d.scope === "theme" || d.scope === "root") {
			light.set(d.name, d.value);
			dark.set(d.name, d.value);
		} else if (d.scope === "dark") {
			dark.set(d.name, d.value);
		}
	}
	return { light, dark };
}

/** Wraps `text` into Go `//` comment lines at `width` columns, prefixed with `indent`. */
export function goComment(text: string, indent = "", width = 96): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let line = "";
	for (const w of words) {
		const next = line === "" ? w : `${line} ${w}`;
		if (`${indent}// ${next}`.length > width && line !== "") {
			lines.push(`${indent}// ${line}`);
			line = w;
		} else {
			line = next;
		}
	}
	if (line !== "") lines.push(`${indent}// ${line}`);
	return lines;
}

/** Go string literal — the notes carry backticks and quotes, so escape rather than raw-quote. */
function q(s: string): string {
	return JSON.stringify(s);
}

/**
 * Pads a block of rows into gofmt's columns.
 *
 * The generated file has to be gofmt-clean as WRITTEN, because the CI gate is
 * `regenerate && git diff --exit-code` and the job that runs it has Node, not Go — a file that
 * only becomes canonical after somebody runs gofmt would go stale on every regeneration. All
 * cells here are ASCII, which is what makes byte-length padding equal to gofmt's rune-width
 * columns; the prose columns are always last, where no padding is applied.
 */
export function alignRows(rows: readonly (readonly string[])[], indent = "\t"): string {
	if (rows.length === 0) return "";
	const cols = Math.max(...rows.map((r) => r.length));
	const widths: number[] = [];
	for (let c = 0; c < cols - 1; c++) {
		widths[c] = Math.max(...rows.map((r) => (r[c] ?? "").length));
	}
	return rows
		.map((r) =>
			(indent + r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c] ?? 0))).join(" ")).trimEnd(),
		)
		.join("\n");
}

/** Parses `120ms` → 120. Throws rather than defaulting: a silent 0 is a stopped spinner. */
export function millis(value: string): number {
	const m = /^([0-9]+)ms$/.exec(value.trim());
	if (m === null) throw new Error(`--dur-* value ${value} is not a whole number of milliseconds`);
	return Number(m[1]);
}

/** Parses `0.16em` → 0.16. */
export function ems(value: string): number {
	const m = /^(-?[0-9.]+)em$/.exec(value.trim());
	if (m === null) throw new Error(`tracking value ${value} is not in em`);
	return Number(m[1]);
}

/** Parses an integer z-index. */
export function layer(value: string): number {
	const m = /^([0-9]+)$/.exec(value.trim());
	if (m === null) throw new Error(`--z-* value ${value} is not an integer`);
	return Number(m[1]);
}

/** The base (non-`@media`) declared value of a token, for the ports that read the raw text. */
function baseValue(name: string, decls: readonly TokenDeclaration[]): string {
	const d = decls.filter((x) => x.name === name && !x.inMedia);
	if (d.length === 0) throw new Error(`${name} has no unconditional declaration`);
	return d[d.length - 1].value;
}

const BORDER_DOC = `Two border sets, and the collapse onto them is the single most visible thing this file
decides. The console has six radii; a terminal cell has no sub-pixel, so a 2px and a 3px corner
are the same square angle and there is nothing between "no corner" and "a corner". A reader who
finds --radius-sm and --radius-md rendering identically is looking at a decision, not a bug.`;

const EMPHASIS_DOC = `The display type scale, collapsed onto a weight-and-case ladder. Every cell in a terminal
is the same size, so a 56/40/30 size ladder cannot survive as sizes — what survives is the
RANKING, and the terminal's ranking device is weight plus case plus ink.`;

/**
 * The focus glyphs are decided HERE rather than read from a token, because there is no token to
 * read: the console draws its focus affordance with geometry (a masked border on a
 * pseudo-element), and geometry has no terminal spelling. The glyph IS the projection.
 */
const FOCUS_GLYPHS: Readonly<Record<string, string>> = { FocusMarker: "▸", FocusInvalidMarker: "✗" };

const FOCUS_DOC = `The focus ring, which is not a ring. A terminal cannot outline a run of cells without
stealing the row above and below it, so focus is a leading marker plus bold weight. The
affordance survives; the geometry does not. Invalid is carried by the glyph, per the brand's
"status by shape, never hue" rule — so nothing further is lost to the grayscale palette.`;

/** Renders the whole generated Go file. */
export function renderGo(
	tokens: readonly ResolvedToken[],
	decls: readonly TokenDeclaration[],
	pairs: ReadonlyMap<string, ColorPair>,
): string {
	const kindOf = (p: Projection): string =>
		p.kind === "exact" ? "BrandExact" : p.kind === "lossy" ? "BrandLossy" : "BrandNone";
	const noteOf = (p: Projection): string => (p.kind === "exact" ? p.note : p.why);

	const rows = tokens
		.map(({ name, projection, ident }) => {
			const target = projection.kind === "none" ? "" : ident;
			return `\t{Token: ${q(name)}, Kind: ${kindOf(projection)}, Target: ${q(target)}, Note: ${q(noteOf(projection))}},`;
		})
		.join("\n");

	const byPort = (port: string): ResolvedToken[] =>
		tokens.filter((t) => t.projection.kind !== "none" && t.projection.port === port);

	// ── colours ───────────────────────────────────────────────────────────────────────────
	const colorTokens = byPort("color");
	const colorVars = colorTokens
		.map(({ name, projection, ident }) => {
			const p = pairs.get(name);
			if (p === undefined) throw new Error(`no resolved colour for ${name}`);
			const head = projection.kind === "exact" ? `${name} · exact — ${projection.note}` : `${name} · lossy — ${projection.why}`;
			return [...goComment(`${ident} is ${head}`, "\t"), `\t${ident} = BrandColor{Light: ${q(p.light)}, Dark: ${q(p.dark)}}`].join("\n");
		})
		.join("\n\n");
	const colorMap = alignRows(colorTokens.map(({ name, ident }) => [`${q(name)}:`, `${ident},`]));

	// ── layers ────────────────────────────────────────────────────────────────────────────
	const layerTokens = byPort("layer");
	// `noteOf`, never `kind === "exact" ? note : ""`: the header promises that a lossy entry
	// carries its reason INTO this file, and a lossy reason dropped here leaves the const with a
	// dangling em dash — the one place a reader would look for why it is lossy.
	const layerConsts = alignRows(
		layerTokens.map(({ name, projection, ident }) => [
			ident,
			"BrandLayer =",
			String(layer(baseValue(name, decls))),
			`// ${name} — ${noteOf(projection)}`,
		]),
	);
	const layerMap = alignRows(layerTokens.map(({ name, ident }) => [`${q(name)}:`, `${ident},`]));

	// ── durations ─────────────────────────────────────────────────────────────────────────
	const durTokens = byPort("duration");
	const durConsts = alignRows(
		durTokens.map(({ name, projection, ident }) => [
			ident,
			"=",
			`${millis(baseValue(name, decls))} * time.Millisecond`,
			`// ${name} — ${noteOf(projection)}`,
		]),
	);
	const durMap = alignRows(durTokens.map(({ name, ident }) => [`${q(name)}:`, `${ident},`]));

	// ── tracking ──────────────────────────────────────────────────────────────────────────
	const trackTokens = byPort("tracking");
	const trackConsts = trackTokens
		.map(({ name, projection, ident }) => {
			const em = ems(baseValue(name, decls));
			return [...goComment(`${ident} is ${name} — ${noteOf(projection)}.`, "\t"), `\t${ident} = ${em}`].join("\n");
		})
		.join("\n\n");

	// ── borders, emphasis, focus: the collapses ───────────────────────────────────────────
	//
	// Each constant's doc comment carries the reason of EVERY token that collapses onto it,
	// which is the sentence the issue asks this file to hold: a reader who lands on
	// BorderSquare sees --radius-sm and --radius-md named there, deliberately, together.
	const collapse = (port: string, decl: (ident: string) => string): { consts: string; map: string } => {
		const group = byPort(port);
		const targets = [...new Set(group.map((t) => t.ident))];
		const consts = targets
			.map((target) => {
				const members = group.filter((t) => t.ident === target);
				const why = members
					.map((m) => `${m.name} — ${m.projection.kind === "lossy" ? m.projection.why : ""}`)
					.join("  ·  ");
				return [...goComment(`${target} is the terminal projection of: ${why}`, "\t"), `\t${decl(target)}`].join("\n");
			})
			.join("\n\n");
		const map = alignRows(group.map(({ name, ident }) => [`${q(name)}:`, `${ident},`]));
		return { consts, map };
	};
	const borders = collapse("border", (t) => `${t} BrandBorder = ${q(t.replace(/^Border/, "").toLowerCase())}`);
	const emphasis = collapse("emphasis", (t) => `${t} BrandEmphasis = ${q(t.replace(/^Emphasis/, "").toLowerCase())}`);
	const focus = collapse("focus", (t) => {
		// No `?? ""` fallback: an unglyphed focus constant compiles, renders as nothing, and
		// makes focus invisible rather than differently drawn. Refuse instead.
		const glyph = FOCUS_GLYPHS[t];
		if (glyph === undefined) {
			throw new Error(
				`the focus projection names ${t}, which has no glyph in FOCUS_GLYPHS. Decide what the terminal draws for it — an empty constant would make focus invisible, not different.`,
			);
		}
		return `${t} = ${q(glyph)}`;
	});

	const counts = {
		exact: tokens.filter((t) => t.projection.kind === "exact").length,
		lossy: tokens.filter((t) => t.projection.kind === "lossy").length,
		none: tokens.filter((t) => t.projection.kind === "none").length,
	};

	return `// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Code generated by apps/console/scripts/gen-go-brand.ts; DO NOT EDIT.
// Regenerate with: pnpm -C apps/console run gen:go-brand
//
// Source of truth: ${TOKENS_REL} (the values) and ${TABLE_REL} (the decisions).
//
// Every custom property declared in the stylesheet appears in BrandProjections below with
// exactly one of exact / lossy / none. ${counts.exact} exact, ${counts.lossy} lossy, ${counts.none} none — ${tokens.length} tokens, no gaps.
// The generator refuses to emit if a declared token has no decision, so a token added to the
// console fails CI until somebody says what the CLI does with it. A "none" entry is a real
// answer, not an omission: a spinner has no easing curve and a CLI cannot set a font.
//
// The lossy entries carry their reason INTO this file on purpose. --radius-sm and --radius-md
// render as the same border here; a reader who does not find the sentence saying so will file
// it as a bug and "fix" it.

package types

import "time"

// BrandProjectionKind is how faithfully a brand token survives the trip to a terminal.
type BrandProjectionKind string

const (
	// BrandExact — the terminal carries the token's value or its ordering without loss.
	BrandExact BrandProjectionKind = "exact"
	// BrandLossy — the terminal carries the INTENT; Note says what it collapses to and why.
	BrandLossy BrandProjectionKind = "lossy"
	// BrandNone — no terminal analogue; Note is the one-line reason.
	BrandNone BrandProjectionKind = "none"
)

// BrandProjection is one token's decision. Target names the Go identifier holding the value,
// and is empty exactly when Kind is BrandNone.
type BrandProjection struct {
	Token  string
	Kind   BrandProjectionKind
	Target string
	Note   string
}

// BrandProjections is every token declared in ${TOKENS_REL}, in stylesheet order.
var BrandProjections = []BrandProjection{
${rows}
}

// BrandColor is a token's terminal ink: one sRGB hex per theme, which lipgloss binds to an
// AdaptiveColor. Values whose CSS carries alpha are already flattened against that theme's
// --background (a cell has no alpha channel), and those tokens are marked lossy above.
type BrandColor struct {
	Light string
	Dark  string
}

var (
${colorVars}
)

// BrandColors indexes the inks by token name. It is built FROM the vars above, so the table
// and the values cannot disagree — and a token deleted from the stylesheet takes its var with
// it, which is a compile error at every Go use site rather than a zero value at a map lookup.
var BrandColors = map[string]BrandColor{
${colorMap}
}

// BrandLayer is a stacking rung. This is the group that is worth MORE in the terminal than in
// the browser: bubbletea has no stacking context, so a view composites its children by hand and
// "the dropdown covers the panel covers the page" is otherwise re-decided at every call site,
// by argument order. Compare rungs; never hardcode a number.
type BrandLayer int

const (
${layerConsts}
)

// BrandLayers indexes the rungs by token name.
var BrandLayers = map[string]BrandLayer{
${layerMap}
}

// The motion vocabulary, as frame intervals. A duration is a duration: nothing is lost.
const (
${durConsts}
)

// BrandDurations indexes the intervals by token name.
var BrandDurations = map[string]time.Duration{
${durMap}
}

const (
${trackConsts}
)

// EyebrowSeparator is what ${ems(baseValue("--tracking-eyebrow", decls))}em of tracking becomes on a cell grid: one cell between
// letters. The terminal's unit of tracking is a whole cell, and the eyebrow device asks for
// letters pushed apart — so the device arrives intact even though the number cannot.
const EyebrowSeparator = " "

${goComment(BORDER_DOC).join("\n")}
type BrandBorder string

const (
${borders.consts}
)

// BrandRadii is the six-to-two collapse, by token name.
var BrandRadii = map[string]BrandBorder{
${borders.map}
}

${goComment(EMPHASIS_DOC).join("\n")}
type BrandEmphasis string

const (
${emphasis.consts}
)

// BrandEmphasisLadder is the size-to-weight collapse, by token name.
var BrandEmphasisLadder = map[string]BrandEmphasis{
${emphasis.map}
}

${goComment(FOCUS_DOC).join("\n")}
const (
${focus.consts}
)

// BrandFocusMarkers is the ring-to-marker collapse, by token name.
var BrandFocusMarkers = map[string]string{
${focus.map}
}
`;
}

/**
 * Reads the stylesheet, audits it against the table, and returns everything the emitter needs.
 *
 * `table` is a parameter rather than a module reference so a test can drive this against the
 * REAL stylesheet with one entry mutated — which is how the refusals below are proven to fire,
 * without the test re-implementing any of them.
 */
export function build(
	css: string,
	table: Readonly<Record<string, Projection>> = PROJECTIONS,
): {
	tokens: ResolvedToken[];
	decls: TokenDeclaration[];
	pairs: Map<string, ColorPair>;
	problems: string[];
} {
	const decls = parseDeclarations(css);
	const census = tokenCensus(css);
	const present = new Set(census);
	const problems = auditProjections(census, decls, table);

	const tokens: ResolvedToken[] = [];
	for (const name of census) {
		const p = table[name] ?? tailwindBinding(name, decls, present, table);
		if (p === null || p === undefined) continue; // already reported by the audit
		const ident = identFor(name, p);
		if (p.kind !== "none" && ident === "") {
			// BrandProjections publishes Target as the Go symbol a reader jumps to. An empty one
			// on a projected row would send them looking for a constant that was never emitted.
			problems.push(`${name} is marked ${p.kind} on the ${p.port} port but resolves to no Go identifier.`);
		}
		tokens.push({ name, projection: p, ident });
	}

	// The colour checks run only once the census is whole. A stylesheet with an undecided token
	// is not yet in a state where "is this colour lossy?" is the useful question, and reporting
	// both at once buries the one that has to be fixed first.
	const pairs = new Map<string, ColorPair>();
	if (problems.length === 0) {
		const { light, dark } = themeMaps(decls);
		try {
			problems.push(...auditColorClaims(tokens, light, dark));
			for (const t of tokens) {
				if (t.projection.kind === "none" || t.projection.port !== "color") continue;
				pairs.set(t.name, colorPair(t.name, light, dark));
			}
		} catch (err) {
			// A token routed to the colour port whose value is not a colour — a length marked
			// `ink()`, say. Report it the way every other refusal is reported instead of exiting
			// on a stack trace that the CI log renders as a crash rather than as a decision.
			problems.push(err instanceof Error ? err.message : String(err));
		}
	}
	return { tokens, decls, pairs, problems };
}

/**
 * The WHOLE pipeline: audit the table against the stylesheet, then render. `go` is the file's
 * contents when the stylesheet projects cleanly, and `null` when it does not — `problems` then
 * holds every reason, whether the audit found it or the emitter refused it.
 *
 * This exists so that `--check` and the write path cannot answer differently. They used to: the
 * check returned after `build()`, so half the refusals — the focus glyph, `millis()`, `layer()`,
 * `ems()`, `baseValue()`'s "no unconditional declaration" — live in `renderGo` and were invisible
 * to it, and it printed "no gaps" for a stylesheet the generator would not emit from. Rendering
 * is the check; only the `writeFileSync` is conditional.
 */
export function generate(
	css: string,
	table: Readonly<Record<string, Projection>> = PROJECTIONS,
): { go: string | null; tokens: ResolvedToken[]; pairs: Map<string, ColorPair>; problems: string[] } {
	const { tokens, decls, pairs, problems } = build(css, table);
	if (problems.length > 0) return { go: null, tokens, pairs, problems };
	try {
		return { go: renderGo(tokens, decls, pairs), tokens, pairs, problems };
	} catch (err) {
		// The emitter refuses a few things the audit cannot see from the table alone — a focus
		// constant with no glyph, a duration that is not whole milliseconds. Report them in the
		// same shape as every other refusal: a bare stack trace renders in the CI log as a crash
		// in the tooling rather than as a decision somebody has to make.
		return { go: null, tokens, pairs, problems: [err instanceof Error ? err.message : String(err)] };
	}
}

function main(): void {
	const checkOnly = process.argv.includes("--check");
	const css = readFileSync(TOKENS, "utf8");
	const { go, tokens, pairs, problems } = generate(css);

	if (go === null) {
		// One message for both paths, because they now run the same checks: `--check` renders too,
		// and a refusal it reports is a refusal the write path would report.
		console.error(`::error::${OUT_REL} cannot be generated from ${TOKENS_REL} — ${problems.length} problem(s). Either a token has no honest projection in ${TABLE_REL}, or it carries a value the emitter cannot project. Fix them, then run 'pnpm -C apps/console run gen:go-brand'.`);
		for (const p of problems) console.error(`  · ${p}`);
		process.exit(1);
	}

	const counts = {
		exact: tokens.filter((t) => t.projection.kind === "exact").length,
		lossy: tokens.filter((t) => t.projection.kind === "lossy").length,
		none: tokens.filter((t) => t.projection.kind === "none").length,
	};
	if (checkOnly) {
		console.log(`brand projection: ${tokens.length} tokens — ${counts.exact} exact, ${counts.lossy} lossy, ${counts.none} none; renders, no gaps`);
		return;
	}

	writeFileSync(OUT, go, "utf8");
	console.log(
		`wrote ${OUT_REL} — ${tokens.length} tokens (${counts.exact} exact, ${counts.lossy} lossy, ${counts.none} none), ${pairs.size} inks`,
	);
}

// Only when run as a script: the pure functions above are imported by the unit tests.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
