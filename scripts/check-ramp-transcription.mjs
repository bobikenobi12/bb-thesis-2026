// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Ramp transcription guard — `ramp-srgb.ts` must still be a TRANSCRIPTION of `tokens.css`,
// not a fourth opinion about what the brand grays are.
//
// Why this exists: `packages/brand/src/ramp-srgb.ts` is a hand-maintained sRGB copy of the
// OKLCH ramp in `packages/brand/src/tokens.css`, kept for the three surfaces that provably
// cannot read a custom property — email, Stripe Elements across an iframe, and `next/og`.
// Its own header records what happened before it existed: the console's Stripe theme used
// `#0a0a0a` and `#171717`, the brand icons used `#1A1A1A`, "none of which are ramp values at
// all." It fixed three transcriptions by becoming a fourth — and nothing checks it.
//
// That matters more now than it did, though not in the way this note first predicted. The CLI's
// lipgloss ink ramp is generated (apps/console/scripts/gen-go-brand.ts -> packages/core/types/
// brand_gen.go), and it is generated from `tokens.css` DIRECTLY rather than from this file —
// generating from the copy would have made the terminal a mirror of a mirror, one hop from
// truth, which is the shape CLAUDE.md's "one deriver, every consumer" rule exists to prevent.
//
// So the two derivations are siblings, not a chain, and that is worth more than the chain would
// have been: `gen-go-brand`'s unit test asserts its nineteen computed bytes against the
// nineteen written here, so a slip in either arithmetic shows up as a disagreement between two
// separately written implementations of the transfer function rather than as a plausible hex.
//
// The check is arithmetic, not a comparison against a checked-in table, because a table would
// be a FIFTH copy. Every line of `ramp-srgb.ts` carries its source as a comment
// (`gray500: "#939393", // oklch(0.664 0 0)`) precisely so this is computable:
//
//   chroma 0  =>  Oklab a = b = 0  =>  LMS = L³  =>  linear sRGB = L³  (the matrix rows sum to 1)
//   sRGB transfer:  c <= 0.0031308 ? 12.92c : 1.055·c^(1/2.4) − 0.055
//   byte = round(255 · s)
//
// FOUR RULES:
//   1. every hex in ramp-srgb.ts is what its OWN `// oklch(...)` comment computes to
//      (catches a hex hand-edited without the comment, and vice versa)
//   2. every `// oklch(...)` comment matches tokens.css's L for the same ramp step
//      (catches tokens.css being restyled while the transcription sits still)
//   3. the two files describe the SAME SET of steps — no key in one and not the other
//   4. every ramp colour is genuinely neutral (chroma 0). The L³ shortcut above is only
//      valid for a gray; a chromatic ramp entry must REFUSE rather than be computed wrongly.
//
// Usage:  node scripts/check-ramp-transcription.mjs [--self-test]
// Wired into CI's `Authz / open-core guards` job.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TOKENS = "packages/brand/src/tokens.css";
const TRANSCRIPTION = "packages/brand/src/ramp-srgb.ts";

// A census floor, in the idiom `check-shared-surface.mjs` already uses. Without it, a regex
// that stops matching — a reformat, a rename, a file moved — reports "0 entries, 0 problems"
// and passes. "Nothing found" and "nothing wrong" must not share an exit code.
const MIN_STEPS = 19;

/** The section comment that opens the ramp block in tokens.css, and the shape that closes it. */
const RAMP_BLOCK_START = /^\s*\/\*\s*-+\s*Alethia neutral ink ramp/;
const SECTION_COMMENT = /^\s*\/\*\s*-+\s/;

/**
 * The sRGB transfer function (IEC 61966-2-1), linear light in, display-encoded out.
 *
 * @param {number} c linear channel value in [0, 1]
 * @returns {number} display-encoded value in [0, 1]
 */
function encodeSRGB(c) {
	return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * The byte an `oklch(L 0 0)` grey renders to in sRGB.
 *
 * Only valid at chroma 0 — see rule 4. With a = b = 0 the Oklab→LMS step is the identity, so
 * LMS = L³ and the linear sRGB channels are all L³, because each row of the LMS→sRGB matrix
 * sums to 1 for a neutral.
 *
 * @param {number} L OKLCH lightness in [0, 1]
 * @returns {number} the 0–255 channel byte, equal on all three channels
 */
function greyByte(L) {
	const linear = L * L * L;
	const encoded = encodeSRGB(Math.min(1, Math.max(0, linear)));
	return Math.round(255 * Math.min(1, Math.max(0, encoded)));
}

/**
 * Render an `oklch(L 0 0)` grey as the `#rrggbb` string the transcription should hold.
 *
 * @param {number} L OKLCH lightness in [0, 1]
 * @returns {string} lowercase six-digit hex, `#` included
 */
function greyHex(L) {
	const b = greyByte(L).toString(16).padStart(2, "0");
	return `#${b}${b}${b}`;
}

/** Normalise a ramp step name so `--gray-500` and `gray500` compare equal. */
function normaliseKey(raw) {
	return raw.replace(/^--/, "").replace(/-/g, "").toLowerCase();
}

/**
 * Parse the OKLCH ramp declarations out of tokens.css.
 *
 * Narrow by SHAPE, not by name: a literal alpha-free `oklch(L C H)` value. A `var(...)`
 * indirection or an alpha-bearing `oklch(1 0 0 / 0.10)` is the semantic layer, which is not what
 * this guard is about.
 *
 * @param {string} src the file contents
 * @returns {Map<string, {L: number, chroma: number, hue: number, line: number}>}
 */
function parseTokens(src) {
	const out = new Map();
	const lines = src.split("\n");

	// Scope the scan to the RAMP BLOCK, not the whole file.
	//
	// An open matcher over all of tokens.css classifies any alpha-free `oklch(L C H)` as a ramp
	// step, and the semantic layer is entitled to hold one. `--overlay: oklch(0 0 0 / 0.45)` is
	// excluded by its alpha, but a solid sibling — `--overlay-solid: oklch(0 0 0)` — would be
	// counted, and rule 3 would then demand it appear in the transcription. The only ways out of
	// that would be a bogus RAMP entry or editing this guard, which is a guard training people to
	// disable it.
	//
	// The block is delimited by the section comment tokens.css already carries. That keeps the
	// breadth that matters — a MIS-NAMED step inside the ramp is still caught, which is the case
	// rule 3 exists for — without claiming every opaque neutral in the file is a ramp value.
	const startIdx = lines.findIndex((l) => RAMP_BLOCK_START.test(l));
	if (startIdx < 0) {
		// The marker is how this guard knows what it is looking at. Refuse rather than falling
		// back to a whole-file scan (false positives) or an empty one (a silent pass).
		return { entries: out, markerMissing: true };
	}
	for (let i = startIdx + 1; i < lines.length; i++) {
		const text = lines[i];
		// The next section comment, or the end of the rule, closes the block.
		if (SECTION_COMMENT.test(text) || /^\s*}/.test(text)) break;
		const m = /^\s*(--[a-z0-9-]+)\s*:\s*oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)/.exec(text);
		if (!m) continue;
		out.set(normaliseKey(m[1]), {
			L: Number(m[2]),
			chroma: Number(m[3]),
			hue: Number(m[4]),
			line: i + 1,
		});
	}
	return { entries: out, markerMissing: false };
}

/**
 * Parse the transcription's entries — the hex it claims, and the OKLCH it claims to be
 * transcribing. Both halves are required: an entry with no `// oklch(...)` comment is a
 * FAILURE, not a skip, because the comment is the only thing that makes the hex checkable
 * and dropping it is exactly how this guard would be silently defeated.
 *
 * @param {string} src the file contents
 * @returns {{entries: Map<string, {hex: string, L: number, chroma: number, hue: number, line: number}>, uncommented: {key: string, line: number}[]}}
 */
function parseTranscription(src) {
	const entries = new Map();
	const uncommented = [];
	src.split("\n").forEach((text, i) => {
		// ANY identifier, not just `gray*`/`black`. Matching only the names we expect would make
		// rule 3's "a value from nowhere" branch dead code for the exact case it exists to catch:
		// a `slate500: "#1a1a1a"` added to RAMP would be invisible to the matcher, the census
		// would still read 17, and the guard would print OK over the fourth transcription this
		// file was written to end. A matcher that only sees what it already approves of is not a
		// census.
		const decl = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"(#[0-9a-fA-F]{6})"\s*,/.exec(text);
		if (!decl) return;
		const line = i + 1;
		const note = /\/\/\s*oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)/.exec(text);
		if (!note) {
			uncommented.push({ key: decl[1], line });
			return;
		}
		entries.set(normaliseKey(decl[1]), {
			hex: decl[2].toLowerCase(),
			L: Number(note[1]),
			chroma: Number(note[2]),
			hue: Number(note[3]),
			line,
		});
	});
	return { entries, uncommented };
}

/**
 * Apply the four rules to an already-parsed pair.
 *
 * Separated from I/O so `--self-test` can drive it with fixtures and prove the guard FAILS
 * when it should. A guard whose failure branch has never run is a guard nobody has tested.
 *
 * @returns {string[]} one problem per entry; empty means clean
 */
function compare(tokens, parsed) {
	const problems = [];

	for (const { key, line } of parsed.uncommented) {
		problems.push(
			`${TRANSCRIPTION}:${line}: \`${key}\` has no \`// oklch(...)\` comment — the comment is what ` +
				`makes the hex checkable; without it this guard cannot verify the value`,
		);
	}

	// Rule 4 stops the run, because every later rule's arithmetic assumes a neutral and would
	// otherwise report a confident wrong byte. It is collected SEPARATELY from `problems` on
	// purpose: an uncommented entry (above) blocks only its own line, so short-circuiting the
	// whole comparison on it would hide every other drift in the file behind one missing
	// comment — a guard reporting less the more wrong the file gets.
	const notNeutral = [];
	for (const [key, v] of parsed.entries) {
		if (v.chroma !== 0) {
			notNeutral.push(
				`${TRANSCRIPTION}:${v.line}: \`${key}\` is oklch(${v.L} ${v.chroma} ${v.hue}) — chroma is not 0, ` +
					`so the L³ neutral shortcut this guard uses is invalid. A chromatic ramp entry needs a real ` +
					`Oklab→sRGB conversion; refusing rather than computing a wrong byte.`,
			);
		}
	}
	for (const [key, v] of tokens) {
		if (v.chroma !== 0) {
			notNeutral.push(
				`${TOKENS}:${v.line}: \`${key}\` is oklch(${v.L} ${v.chroma} ${v.hue}) — chroma is not 0, so ` +
					`the L³ neutral shortcut this guard uses is invalid. The ramp is neutral by definition; a ` +
					`chromatic value belongs in the semantic layer, not in the ramp block.`,
			);
		}
	}
	// Do NOT return here. An earlier cut did, and it repeated — for the whole file — the exact
	// mistake the comment above describes for a single entry: one chromatic step would abort
	// rules 1, 2 and 3 for every OTHER step, so the guard reported less the more wrong the file
	// got. Only the non-neutral ENTRIES have invalid arithmetic, so only those are skipped below;
	// every other step is still checked, and rule 3's set comparison does not depend on
	// arithmetic at all.
	problems.push(...notNeutral);
	const skipArithmetic = new Set([
		...[...parsed.entries].filter(([, v]) => v.chroma !== 0).map(([key]) => key),
		...[...tokens].filter(([, v]) => v.chroma !== 0).map(([key]) => key),
	]);

	// Rule 1 — the hex is what its own comment computes to.
	for (const [key, v] of parsed.entries) {
		if (skipArithmetic.has(key)) continue; // reported above; greyHex is not valid for it
		const want = greyHex(v.L);
		if (v.hex !== want) {
			problems.push(
				`${TRANSCRIPTION}:${v.line}: \`${key}\` is ${v.hex} but oklch(${v.L} 0 0) computes to ${want} — ` +
					`the hex and its own comment disagree`,
			);
		}
	}

	// Rule 2 — the comment matches tokens.css.
	for (const [key, v] of parsed.entries) {
		if (skipArithmetic.has(key)) continue;
		const src = tokens.get(key);
		if (!src) continue; // rule 3 reports this
		if (src.L !== v.L) {
			problems.push(
				`${TRANSCRIPTION}:${v.line}: \`${key}\` transcribes oklch(${v.L} 0 0) but ${TOKENS}:${src.line} ` +
					`now says oklch(${src.L} 0 0) — tokens.css moved and the transcription did not. ` +
					`The value should be ${greyHex(src.L)}.`,
			);
		}
	}

	// Rule 3 — same set of steps, both directions.
	//
	// An entry that lost its `// oklch(...)` comment is NOT missing: it is present and
	// unverifiable, and it was already reported as exactly that above. Reporting it a second time
	// as "missing from the transcription" would be a false statement about the file, and it is the
	// kind a reader trusts because it came from a guard.
	const uncommentedKeys = new Set(parsed.uncommented.map((u) => normaliseKey(u.key)));
	for (const key of tokens.keys()) {
		if (!parsed.entries.has(key) && !uncommentedKeys.has(key)) {
			problems.push(`${TRANSCRIPTION}: \`${key}\` exists in ${TOKENS} but is missing from the transcription`);
		}
	}
	for (const key of parsed.entries.keys()) {
		if (!tokens.has(key)) {
			problems.push(
				`${TRANSCRIPTION}: \`${key}\` is not a ramp step in ${TOKENS} — it is a value from nowhere, ` +
					`which is precisely what this file was created to end`,
			);
		}
	}

	return problems;
}

/**
 * Prove the guard can fail. Every rule gets a case that MUST be caught and a clean control
 * that must not be — a guard tested in one direction only is one that reports green.
 */
function selfTest() {
	const RAMP_MARKER = "  /* ---- Alethia neutral ink ramp (OKLCH, zero chroma) ---- */\n";
	const cleanTokens = RAMP_MARKER + "  --gray-500:  oklch(0.664 0 0);\n  --black:     oklch(0.09 0 0);\n";
	const cleanSrc = '\tgray500: "#939393", // oklch(0.664 0 0)\n\tblack: "#020202", // oklch(0.09 0 0)\n';

	const cases = [
		["clean pair passes", cleanTokens, cleanSrc, 0],
		[
			"rule 1 — hex edited, comment left alone",
			cleanTokens,
			'\tgray500: "#949494", // oklch(0.664 0 0)\n\tblack: "#020202", // oklch(0.09 0 0)\n',
			1,
		],
		[
			"rule 2 — tokens.css restyled, transcription stale",
			RAMP_MARKER + "  --gray-500:  oklch(0.700 0 0);\n  --black:     oklch(0.09 0 0);\n",
			cleanSrc,
			1,
		],
		[
			"rule 3 — step missing from the transcription",
			cleanTokens,
			'\tblack: "#020202", // oklch(0.09 0 0)\n',
			1,
		],
		[
			"rule 3 — step in the transcription that tokens.css does not have",
			RAMP_MARKER + "  --black:     oklch(0.09 0 0);\n",
			cleanSrc,
			1,
		],
		[
			// The case the matcher used to be blind to. A colour under a NAME the ramp does not
			// have is the original sin this file records — #0a0a0a, #171717, #1A1A1A, "none of
			// which are ramp values at all". If the matcher only recognises `gray*`, this passes.
			"rule 3 — a colour under a name the ramp does not have is SEEN, not skipped",
			cleanTokens,
			'\tgray500: "#939393", // oklch(0.664 0 0)\n\tblack: "#020202", // oklch(0.09 0 0)\n' +
				'\tslate500: "#1a1a1a", // oklch(0.205 0 0)\n',
			2, // its hex disagrees with its own comment (#171717), AND it is not a ramp step
		],
		[
			"rule 4 — a chromatic entry refuses instead of computing",
			cleanTokens,
			'\tgray500: "#939393", // oklch(0.664 0.11 240)\n\tblack: "#020202", // oklch(0.09 0 0)\n',
			1,
		],
		[
			// Exactly ONE problem: the entry is present but unverifiable. It is NOT also "missing
			// from the transcription" — saying so would be a false statement about the file, and
			// the first cut of this guard made it.
			"the comment cannot simply be dropped to dodge rule 1",
			cleanTokens,
			'\tgray500: "#ff0000",\n\tblack: "#020202", // oklch(0.09 0 0)\n',
			1,
		],
		[
			// The tokens.css side of the same blindness. With a `gray-*|black` allowlist in
			// parseTokens this ramp step is invisible and the guard prints OK.
			"a new ramp step in tokens.css under an unexpected NAME is seen",
			cleanTokens + "  --slate-500: oklch(0.664 0 0);\n",
			cleanSrc,
			1,
		],
		[
			// ...while the semantic layer is still excluded, by SHAPE rather than by name.
			"an alpha-bearing oklch token is not mistaken for a ramp step",
			cleanTokens + "  --overlay: oklch(0 0 0 / 0.45);\n",
			cleanSrc,
			0,
		],
		[
			// The anti-regression for the early return. One chromatic entry must not stop the
			// OTHER steps being checked — a guard that reports less the more wrong the file gets
			// is the defect this file keeps having to relearn.
			"a chromatic entry does not hide a drift elsewhere in the same file",
			cleanTokens + "  --brand-500: oklch(0.6 0.11 240);\n",
			'\tgray500: "#949494", // oklch(0.664 0 0)\n' + // a real rule-1 drift
				'\tblack: "#020202", // oklch(0.09 0 0)\n' +
				'\tbrand500: "#0000ff", // oklch(0.6 0.11 240)\n', // the chromatic one
			3, // both chromatic reports (transcription + tokens.css) AND the gray500 drift
		],
	];

	let failed = 0;
	for (const [name, tokensSrc, transcriptionSrc, wantCount] of cases) {
		const got = compare(parseTokens(tokensSrc).entries, parseTranscription(transcriptionSrc));
		const ok = got.length === wantCount;
		if (!ok) {
			failed++;
			console.error(`  ✗ ${name}: expected ${wantCount} problem(s), got ${got.length}`);
			got.forEach((p) => console.error(`      ${p}`));
		} else {
			console.log(`  ✓ ${name}`);
		}
	}

	// The block marker is how this guard knows what it is looking at. Without it parseTokens must
	// report markerMissing rather than returning an empty map, which would otherwise read as
	// "tokens.css has no ramp steps" and sail through as a vacuous pass.
	{
		const noMarker = parseTokens("  --gray-500:  oklch(0.664 0 0);\n");
		if (!noMarker.markerMissing) {
			failed++;
			console.error("  ✗ a tokens.css with no ramp-block marker must be REFUSED, not scanned as empty");
		} else {
			console.log("  ✓ a missing ramp-block marker is refused rather than scanned as empty");
		}
		const scoped = parseTokens(
			"  /* ---- Alethia neutral ink ramp ---- */\n  --gray-500:  oklch(0.664 0 0);\n" +
				"  /* ---- Alethia semantic surfaces ---- */\n  --overlay-solid: oklch(0 0 0);\n",
		);
		if (scoped.entries.has("overlaysolid")) {
			failed++;
			console.error("  ✗ an opaque neutral OUTSIDE the ramp block was counted as a ramp step");
		} else if (!scoped.entries.has("gray500")) {
			failed++;
			console.error("  ✗ the ramp block itself was not scanned");
		} else {
			console.log("  ✓ an opaque neutral outside the ramp block is not a ramp step");
		}
	}

	// The arithmetic itself, against the values the ramp has carried since it was written.
	// If the transfer function is ever "simplified", this is what notices.
	const known = [
		[1, "#ffffff"],
		[0.985, "#fafafa"],
		[0.664, "#939393"],
		[0.556, "#737373"],
		[0.205, "#171717"],
		[0.09, "#020202"],
	];
	for (const [L, want] of known) {
		if (greyHex(L) !== want) {
			failed++;
			console.error(`  ✗ arithmetic: oklch(${L} 0 0) should be ${want}, got ${greyHex(L)}`);
		}
	}
	if (failed === 0) console.log(`  ✓ arithmetic reproduces ${known.length} known ramp values`);

	if (failed > 0) {
		console.error(`\nFAIL: ${failed} self-test case(s) failed — the guard itself is broken`);
		process.exit(1);
	}
	console.log("\nOK: self-test passed");
}

function main() {
	if (process.argv.includes("--self-test")) {
		selfTest();
		return;
	}

	let tokensSrc;
	let transcriptionSrc;
	try {
		tokensSrc = readFileSync(join(ROOT, TOKENS), "utf8");
		transcriptionSrc = readFileSync(join(ROOT, TRANSCRIPTION), "utf8");
	} catch (err) {
		// An unreadable input RAISES. Treating it as "nothing to check" is how a guard goes
		// green over a file somebody moved.
		console.error(`FAIL: cannot read a ramp source — ${err.message}`);
		process.exit(1);
	}

	const { entries: tokens, markerMissing } = parseTokens(tokensSrc);
	if (markerMissing) {
		console.error(
			`FAIL: could not find the ramp block in ${TOKENS}. This guard scopes its scan to the ` +
				`section opened by "/* ---- Alethia neutral ink ramp ... ----" so the semantic layer's own ` +
				`opaque neutrals are not mistaken for ramp steps. That marker is gone or renamed, so the ` +
				`ramp has NOT been checked — restore the comment, or update RAMP_BLOCK_START here.`,
		);
		process.exit(1);
	}
	const parsed = parseTranscription(transcriptionSrc);
	const seen = parsed.entries.size + parsed.uncommented.length;

	// Vacuity, per file and with distinct messages, so the fix is obvious from the failure.
	if (tokens.size === 0) {
		console.error(
			`FAIL: parsed 0 ramp declarations from ${TOKENS}. The file exists, so either the ramp moved ` +
				`or its formatting changed and this guard's matcher no longer sees it. It has NOT been checked.`,
		);
		process.exit(1);
	}
	if (seen === 0) {
		console.error(
			`FAIL: parsed 0 entries from ${TRANSCRIPTION}. The file exists, so its shape changed and this ` +
				`guard's matcher no longer sees it. It has NOT been checked.`,
		);
		process.exit(1);
	}
	if (tokens.size < MIN_STEPS || seen < MIN_STEPS) {
		console.error(
			`FAIL: expected at least ${MIN_STEPS} ramp steps, saw ${tokens.size} in ${TOKENS} and ${seen} in ` +
				`${TRANSCRIPTION}. Steps were removed, or the matcher is seeing only part of the ramp. ` +
				`If the ramp genuinely shrank, lower MIN_STEPS in the same commit and say why.`,
		);
		process.exit(1);
	}

	const problems = compare(tokens, parsed);

	console.log(`ramp transcription: ${tokens.size} steps in tokens.css · ${seen} in the transcription`);
	if (problems.length > 0) {
		console.error(`\nFAIL: ${problems.length} problem(s) — ${TRANSCRIPTION} is no longer a transcription\n`);
		problems.forEach((p) => console.error(`  ${p}`));
		console.error(
			`\n${TOKENS} is the source of truth. Fix the transcription to match it — do not edit the ` +
				`\`// oklch(...)\` comments to match the hex, which would make the two agree about a value ` +
				`the brand does not have.`,
		);
		process.exit(1);
	}
	console.log("OK: every hex reproduces from its own oklch() comment, and every comment matches tokens.css");
}

main();
