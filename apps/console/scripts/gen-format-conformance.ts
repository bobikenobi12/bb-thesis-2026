// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generates `packages/format/conformance/format-cases.json` by running the REAL `@repo/format`
 * implementation over the hand-curated inputs in `packages/format/conformance/cases.ts`.
 *
 * It lives HERE rather than beside the package it generates for, because that is where every
 * other cross-language generator in this repo lives — gen-go-enums, gen-cli-fixtures, gen-matrix,
 * gen-catalog, gen-secrets-runtime-read. apps/console already carries `tsx` and `@types/node`;
 * adding them to a leaf package to host one script re-resolved the lockfile and bumped
 * @better-auth/utils 0.4.2 -> 0.5.0, which broke the console's type-check in a completely
 * unrelated file. A generator belongs with the other generators.
 *
 * The file it writes is the contract that `packages/core/format` (Go) is held to. Go cannot
 * write it, so Go has no way to make itself right: a Go-only change reds the Go table test, a
 * TS-only change reds the CI diff-gate here, and neither side can drift alone.
 *
 * Usage:
 *   pnpm -C apps/console run gen:format-conformance:check   # check — non-zero if the committed file is stale
 *   pnpm -C apps/console run gen:format-conformance        # regenerate
 *
 * ⚠️  REGENERATING REWRITES AN EXPECTATION, NOT A FORMATTING DETAIL.
 * `--write` is exactly what somebody runs when the Go test is red, and doing so makes the Go
 * test pass against a table describing a TS change nobody reviewed.
 *
 * What actually stops that being invisible, stated precisely rather than optimistically:
 *   - case ids are SEMANTIC, so a diff names the boundary that moved rather than an index;
 *   - this script prints a changed-case summary, and the CI error tells the reader to read it;
 *   - `/packages/format/conformance/` is in CODEOWNERS, which auto-requests a review.
 *
 * Note what the last one is NOT: required-review enforcement comes from the branch-protection
 * rulesets on `main`/`staging`, so on a `dev` PR the CODEOWNERS entry requests a reviewer but
 * does not block Mergify's auto-merge. It raises the chance the change is seen; it does not
 * guarantee it. The semantic ids and the summary are the parts that work unattended.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as fmt from "@repo/format";
import { BYTES, DATE, DURATION, EXCLUDED, MINUTES, MONEY, MONTHLY_DELTA, MONTHLY_RATE, QUOTA } from "@repo/format/conformance";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/console/scripts -> repo root is three levels up.
const OUT = resolve(HERE, "../../../packages/format/conformance/format-cases.json");
const REL = "packages/format/conformance/format-cases.json";

/**
 * The table's schema version. Bump only for a shape change, never for a value change.
 *
 * 2 — #4123 added the top-level `zeroDecimalCharge` key. That IS a shape change: `conformance_test.go`
 *     refuses a table below this version rather than reading the absent key as an empty set, which
 *     would have made an old table look like agreement.
 */
const VERSION = 2;

/** `null` in a case file means "not a finite number" — the branch every formatter clamps. */
const num = (v: number | null): number => (v === null ? Number.NaN : v);

/**
 * Build the table. Each entry keeps its inputs beside its output so the Go test needs no
 * knowledge of this file's ordering, and a reviewer can read a row without cross-referencing.
 */
function build() {
	return {
		minutes: MINUTES.map((c) => ({ id: c.id, in: c.in, want: fmt.formatMinutes(num(c.in)) })),
		quota: QUOTA.map((c) => ({
			id: c.id,
			used: c.used,
			included: c.included,
			want: fmt.formatQuota(c.used, c.included),
		})),
		duration: DURATION.map((c) => ({ id: c.id, in: c.in, want: fmt.formatDuration(num(c.in)) })),
		date: DATE.map((c) => ({
			id: c.id,
			value: c.value,
			style: c.style,
			timeZone: c.timeZone,
			want: fmt.formatDate(c.value, c.style, c.timeZone),
		})),
		bytes: BYTES.map((c) => ({ id: c.id, in: c.in, want: fmt.formatBytes(num(c.in)) })),
		money: MONEY.map((c) => ({
			id: c.id,
			cents: c.cents,
			currency: c.currency,
			want: fmt.formatMoney(c.cents, c.currency),
		})),
		monthlyRate: MONTHLY_RATE.map((c) => ({
			id: c.id,
			amount: c.amount,
			style: c.style,
			currency: c.currency,
			want: fmt.formatMonthlyRate(c.amount, c.style, c.currency),
		})),
		monthlyDelta: MONTHLY_DELTA.map((c) => ({
			id: c.id,
			amount: c.amount,
			style: c.style,
			currency: c.currency,
			want: fmt.formatMonthlyDelta(num(c.amount), c.style, c.currency),
		})),
	};
}

/**
 * The zero-decimal CHARGE set, published across the language boundary (#4123).
 *
 * This is not a formatter and gets no `cases` section: the rows in `cases.money` pin how six
 * currencies RENDER, and a row can only ever pin a code it names. What the two implementations
 * can actually disagree about is set MEMBERSHIP — a sixteenth code added to TypeScript's map and
 * not to Go's changes no row's expectation — so membership is what is emitted, and both
 * conformance suites assert their own copy against it.
 *
 * Read from `@repo/format` rather than re-typed here, which is the whole point; a second
 * transcription in the generator would drift from the first exactly as the two languages did.
 *
 * The three refusals below are cheap and all three are reachable failures. An EMPTY list would be
 * published as `[]`, and the TypeScript assertion compares the artifact against the live export,
 * so `[] === []` passes on that side — only Go would be red, and it would name every one of its
 * fifteen codes with no hint that the producer was the problem. An UNSORTED list still compares
 * equal on both sides (both compare sorted), but its diff stops naming the code that moved, and a
 * generated file whose diff is noise is a file reviewers skim.
 *
 * ── THE CASE REFUSAL, AND WHY IT IS HERE RATHER THAN AT THE CONSUMER (#4174) ─────────────────
 *
 * `stripeChargeDivisor` uppercases the QUERY — `ZERO_DECIMAL_CHARGE.has(currency.toUpperCase())`
 * — and never the entries. So a lowercase entry is INERT in TypeScript: it sits in the array, it
 * is published into the artifact, and `stripeChargeDivisor("ugx")` still answers 100. Go's mirror
 * used to normalise the artifact on READ, which turned that inert entry into a code Go believed
 * TypeScript had declared, and the guard then told the reader to add it to `stripeZeroDecimalCharge`
 * — the 100x-overstated invoice #4101 exists to prevent, arrived at by FOLLOWING the guard.
 *
 * Every other layer passes a lowercase entry: it sorts after `XPF` so the refusal above is happy,
 * `not.toContain("UGX")` is `===`-based, and the equality assertion compares the artifact against
 * the very export it was built from. This is the only layer that sees it, which is why "the array
 * is upper case" stops being prose in `minor-units.ts` and becomes a refusal at the point the
 * artifact is WRITTEN. Normalising at the consumer is what let the two sides disagree about what
 * the artifact means; nothing downstream normalises any more.
 */
export function zeroDecimalProblems(codes: readonly string[]): string[] {
	if (codes.length === 0) {
		return [
			"FAIL: @repo/format exports an EMPTY STRIPE_ZERO_DECIMAL_CHARGE. Publishing that would " +
				"hand Go an empty set to agree with, and 'nothing to compare' must not exit like 'nothing wrong'.",
		];
	}
	const notUpper = codes.filter((code) => code !== code.toUpperCase());
	if (notUpper.length > 0) {
		// Returned alone rather than alongside the sort check: a lowercase code also sorts wrongly
		// against its upper-case neighbours, and printing both would bury the one that matters under
		// a `got/want` line whose fix (reorder the array) does not address it.
		return [
			`FAIL: STRIPE_ZERO_DECIMAL_CHARGE contains ${notUpper.length} code(s) that are not upper ` +
				`case: ${notUpper.join(" ")}\n` +
				`  A lowercase entry is INERT in TypeScript — stripeChargeDivisor uppercases the QUERY\n` +
				`  (currency.toUpperCase()) and never the entries, so the set this file consults does NOT\n` +
				`  contain it, and stripeChargeDivisor still answers 100 for it.\n` +
				`  Publishing it would hand packages/core/format a code TypeScript never declared, and\n` +
				`  that side refuses the artifact rather than normalising it (#4174).\n` +
				`  Write it as: ${notUpper.map((c) => c.toUpperCase()).join(" ")}\n` +
				`  ISO 4217 is upper case; this is where that is enforced rather than assumed.`,
		];
	}
	const sorted = [...codes].sort();
	if (codes.join(",") !== sorted.join(",")) {
		return [
			`FAIL: STRIPE_ZERO_DECIMAL_CHARGE is not sorted, so its diff would not name the code that ` +
				`moved.\n  got   ${codes.join(" ")}\n  want  ${sorted.join(" ")}`,
		];
	}
	return [];
}

/** The published set, or an exit — the thin caller that keeps {@link zeroDecimalProblems} pure. */
function zeroDecimalCharge(): string[] {
	const codes = [...fmt.STRIPE_ZERO_DECIMAL_CHARGE];
	const problems = zeroDecimalProblems(codes);
	if (problems.length > 0) {
		problems.forEach((p) => console.error(p));
		process.exit(1);
	}
	return codes;
}

/**
 * Every `format*` export must be either covered by the table or named in EXCLUDED with a
 * reason. Without this, adding a formatter and forgetting the table is silent — and the Go
 * side's vacuity check cannot see it, because Go would simply never know the function exists.
 */
function assertCoverage(cases: Record<string, unknown[]>): void {
	const exported = Object.entries(fmt)
		.filter(([name, v]) => typeof v === "function" && name.startsWith("format"))
		.map(([name]) => name);

	// `formatMinutes` -> `minutes`
	const keyFor = (name: string) => name.slice("format".length, "format".length + 1).toLowerCase() + name.slice("format".length + 1);

	const uncovered = exported.filter((name) => !(keyFor(name) in cases) && !(name in EXCLUDED));
	if (uncovered.length > 0) {
		console.error(
			`FAIL: ${uncovered.length} exported formatter(s) are neither in the table nor in EXCLUDED:\n` +
				uncovered.map((n) => `  - ${n}`).join("\n") +
				`\n\nAdd cases in conformance/cases.ts, or add an EXCLUDED entry saying why the two ` +
				`surfaces are allowed to differ. "n/a" is indistinguishable from an oversight.`,
		);
		process.exit(1);
	}

	// Vacuity: a section that exists but is empty is worse than one that is absent, because it
	// reads as covered. "Ran 0 cases" and "passed" must not share an exit code.
	const empty = Object.entries(cases).filter(([, v]) => v.length === 0);
	if (empty.length > 0) {
		console.error(`FAIL: ${empty.map(([k]) => k).join(", ")} — section(s) present but with zero cases`);
		process.exit(1);
	}

	const stale = Object.keys(EXCLUDED).filter((name) => !exported.includes(name));
	if (stale.length > 0) {
		console.error(
			`FAIL: EXCLUDED names ${stale.join(", ")}, which @repo/format no longer exports. ` +
				`Remove the entry — a stale exclusion is a reason nobody can check.`,
		);
		process.exit(1);
	}
}

/**
 * Index a previously-generated file as `section/id -> want`, narrowing from `unknown` without a
 * cast (CLAUDE.md §6). A malformed or absent previous file yields an empty index, which makes
 * every case read as "new" rather than "changed" — the honest answer when there is nothing to
 * compare against.
 */
function previousRows(before: unknown): Map<string, { want: string; row: string }> {
	const index = new Map<string, { want: string; row: string }>();
	if (before === null || typeof before !== "object") return index;
	const doc: Record<string, unknown> = { ...before };
	if (doc.cases === null || typeof doc.cases !== "object") return index;
	for (const [section, rows] of Object.entries({ ...doc.cases })) {
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			if (row === null || typeof row !== "object") continue;
			const entry: Record<string, unknown> = { ...row };
			if (typeof entry.id === "string" && typeof entry.want === "string") {
				// The whole row, not just `want`. A case whose INPUT moved without moving its
				// output matters as much here, because it changes what packages/core/format is
				// driven with — and indexing only `want` reported "0 changed" for it while the
				// message told the reader to read the list.
				index.set(`${section}/${entry.id}`, { want: entry.want, row: JSON.stringify(entry) });
			}
		}
	}
	return index;
}

/**
 * What moved between the committed table and this run.
 *
 * Added and removed ids are reported alongside changed ones, and that is not cosmetic: the
 * detector matches on `section/id`, so RENAMING a case while also changing its value would
 * otherwise report "0 changed" and hide the value move completely. Renaming a case is exactly
 * what somebody does when its meaning changes, which is when the summary matters most.
 */
export function changedIds(before: unknown, after: Record<string, { id: string; want: string }[]>): string[] {
	const prev = previousRows(before);
	const seen = new Set<string>();
	const changed: string[] = [];
	for (const [section, rows] of Object.entries(after)) {
		for (const r of rows) {
			const key = `${section}/${r.id}`;
			seen.add(key);
			const was = prev.get(key);
			if (was === undefined) {
				changed.push(`+ ${r.id}: ${r.want}  (new)`);
			} else if (was.want !== r.want) {
				changed.push(`~ ${r.id}: ${was.want} -> ${r.want}`);
			} else if (was.row !== JSON.stringify(r)) {
				// Same answer, different question. Still a change to what Go is held to.
				changed.push(`i ${r.id}: inputs changed, expectation unmoved (${r.want})`);
			}
		}
	}
	for (const [key, was] of prev) {
		if (!seen.has(key)) changed.push(`- ${key.split("/").slice(1).join("/")}: ${was.want}  (removed)`);
	}
	return changed;
}

/**
 * The members of a value when it is an array of strings, else `null` — narrowing without a cast so
 * `zeroDecimalCharge` can be reported as `+KWD` rather than as two JSON blobs to eyeball.
 */
export function stringMembers(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return null;
		out.push(item);
	}
	return out;
}

/** Index a value's own enumerable keys, or `{}` for anything that is not a plain object. */
function keysOf(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? { ...value } : {};
}

/** One line describing how a single top-level key moved. */
export function describeKeyChange(key: string, was: unknown, now: unknown): string {
	const before = stringMembers(was);
	const after = stringMembers(now);
	if (before !== null && after !== null) {
		// COUNTED, not `includes`. Membership alone cannot see a DUPLICATE: `["JPY"]` becoming
		// `["JPY","JPY"]` adds and removes nothing by `includes`, so it fell through to "same
		// members, ORDER moved" — false in both halves, and the only place a duplicate is visible
		// at all. Sortedness passes (a duplicate is still sorted), the case refusal passes, the TS
		// equality assertion compares the same literal to itself, and Go's map de-duplicates on
		// decode. This line is the last layer that can say it.
		const tally = (xs: readonly string[]) =>
			xs.reduce<Record<string, number>>((m, c) => ({ ...m, [c]: (m[c] ?? 0) + 1 }), {});
		const wasN = tally(before);
		const nowN = tally(after);
		const added: string[] = [];
		const removed: string[] = [];
		for (const c of [...new Set([...before, ...after])].sort()) {
			const had = wasN[c] ?? 0;
			const has = nowN[c] ?? 0;
			if (had === has) continue;
			// A member that was ALREADY there and changed count was duplicated (or de-duplicated),
			// not added — `+JPY` for `["JPY"] -> ["JPY","JPY"]` would read as an addition and send
			// the reader looking for a code that was there all along. Say which it is.
			if (had > 0 && has > 0) added.push(`~${c} ×${had}→×${has}`);
			else if (has > had) added.push(`+${c}`);
			else removed.push(`-${c}`);
		}
		// Same members in a different order is a real change to a file whose whole point is a
		// reviewable diff, and reporting it as "0 changed" is the defect this function exists for.
		// Reachable only when the multisets match, which now genuinely means a reorder.
		if (added.length === 0 && removed.length === 0) return `~ ${key}: same members, ORDER moved`;
		return `~ ${key}: ${[...added, ...removed].join(" ")}`;
	}
	const scalar = (v: unknown) => v === null || typeof v !== "object";
	if (scalar(was) && scalar(now)) return `~ ${key}: ${JSON.stringify(was)} -> ${JSON.stringify(now)}`;

	const wasObj = keysOf(was);
	const nowObj = keysOf(now);
	const moved = [...new Set([...Object.keys(wasObj), ...Object.keys(nowObj)])]
		.sort()
		.filter((k) => JSON.stringify(wasObj[k]) !== JSON.stringify(nowObj[k]));
	// AN OBJECT REORDERS TOO, and this branch had no case for it. The caller only reaches here
	// because the key's JSON changed, so `moved` being empty means every entry compares equal and
	// the difference is in the KEY ORDER — which rewrites the artifact and is exactly the kind of
	// diff this summary exists to name. It used to print "0 entries moved — " with nothing after
	// the dash: a line that names nothing and contradicts the "1 artifact key(s) changed" above it.
	if (moved.length === 0) {
		const wasKeys = Object.keys(wasObj);
		const nowKeys = Object.keys(nowObj);
		return wasKeys.join(",") === nowKeys.join(",")
			? `~ ${key}: changed, but no entry differs — whitespace or formatting only`
			: `~ ${key}: same entries, KEY ORDER moved (${wasKeys.join(", ")} -> ${nowKeys.join(", ")})`;
	}
	return `~ ${key}: ${moved.length} entr${moved.length === 1 ? "y" : "ies"} moved — ${moved.join(", ")}`;
}

/**
 * What moved OUTSIDE `cases` (#4174).
 *
 * `changedIds` walks `cases` and nothing else, so before this a regenerate whose only diff was
 * `zeroDecimalCharge` printed `136 cases across 8 functions; 0 changed` with no CASES CHANGED
 * block, and in check mode `FAIL: … is stale` was followed by an EMPTY list while ci.yml's
 * `::error::` told the reader to go and read that list. A rewritten expectation reported as
 * "nothing moved" is exactly what this file's own header warns about.
 *
 * Derived from the keys of the document rather than from a hand-written list of them, so the next
 * top-level key is covered the day it is added and not the day somebody remembers this function.
 */
export function changedKeys(before: unknown, next: object): string[] {
	const prev = keysOf(before);
	const now = keysOf(next);
	const out: string[] = [];
	for (const key of [...new Set([...Object.keys(prev), ...Object.keys(now)])].sort()) {
		if (key === "cases") continue; // reported per-row by changedIds
		const wasJSON = key in prev ? JSON.stringify(prev[key]) : undefined;
		const nowJSON = key in now ? JSON.stringify(now[key]) : undefined;
		if (wasJSON === nowJSON) continue;
		if (wasJSON === undefined) out.push(`+ ${key}: ${nowJSON}  (new key)`);
		else if (nowJSON === undefined) out.push(`- ${key}: ${wasJSON}  (removed)`);
		else out.push(describeKeyChange(key, prev[key], now[key]));
	}
	return out;
}

function main(): void {
	const write = process.argv.includes("--write");
	const cases = build();
	assertCoverage(cases);

	const total = Object.values(cases).reduce((n, rows) => n + rows.length, 0);
	const doc = {
		_doc:
			`GENERATED by apps/console/scripts/gen-format-conformance.ts from packages/format/src/index.ts. ` +
			`DO NOT EDIT. Regenerate: pnpm -C apps/console run gen:format-conformance. Consumed by ` +
			`packages/format/tests/conformance.test.ts and packages/core/format/conformance_test.go. ` +
			`Regenerating rewrites an EXPECTATION — read the diff, do not skim it.`,
		version: VERSION,
		excluded: EXCLUDED,
		// Top-level, beside `cases` rather than inside it: it is not a case and has no `id`/`want`,
		// so a section would break every loop that walks `cases`.
		zeroDecimalCharge: zeroDecimalCharge(),
		cases,
	};
	// Two-space JSON with a trailing newline: one line per field, so a diff is reviewable.
	const next = `${JSON.stringify(doc, null, 2)}\n`;

	let current: string | null = null;
	try {
		current = readFileSync(OUT, "utf8");
	} catch {
		current = null;
	}

	const sections = Object.keys(cases).length;
	if (current === next) {
		console.log(`conformance: ${total} cases across ${sections} functions — up to date`);
		return;
	}

	let parsedCurrent: unknown = null;
	if (current !== null) {
		try {
			parsedCurrent = JSON.parse(current);
		} catch {
			parsedCurrent = null;
		}
	}
	const changed = changedIds(parsedCurrent, cases);
	const keyChanges = changedKeys(parsedCurrent, doc);

	/**
	 * Print everything that moved, on the stream the caller is already reading.
	 *
	 * The final branch is the point: `current !== next` is how we got here, so if NEITHER list has
	 * anything then something moved that neither detector can name, and saying nothing would be a
	 * third way for this file to report a rewritten expectation as silence.
	 */
	const report = (line: (s: string) => void) => {
		if (changed.length > 0) {
			// "case(s) differ", not "expectation(s) would change": a row marked `i` moved its INPUT
			// while its output stayed put, and calling that a changed expectation would be false.
			line(`\n${changed.length} case(s) differ  (~ expectation moved · i inputs only · + new · - removed):`);
			changed.forEach((c) => line(`  ${c}`));
		}
		if (keyChanges.length > 0) {
			// Outside `cases`, and therefore outside every per-row loop. `zeroDecimalCharge` is the
			// live one: it is a whole SET both suites are held to, and no row measures it.
			line(`\n${keyChanges.length} artifact key(s) differ outside \`cases\`  (both suites are held to these):`);
			keyChanges.forEach((c) => line(`  ${c}`));
		}
		if (changed.length === 0 && keyChanges.length === 0) {
			line(
				`\nThe file text differs but no case and no top-level key did, so key ORDER or formatting\n` +
					`moved. Nothing here can name it — diff ${REL} directly rather than reading this as "no change".`,
			);
		}
	};

	if (!write) {
		console.error(
			`FAIL: ${REL} is stale — the implementation and the committed table disagree.\n` +
				`Regenerate with:  pnpm -C apps/console run gen:format-conformance\n` +
				`\nThis run: Node ${process.versions.node}, ICU ${process.versions.icu}. Several\n` +
				`expectations are Intl output, so a CLDR bump inside the ICU shipped with Node can\n` +
				`move them for a reason that has nothing to do with @repo/format. If the changed\n` +
				`list below is currency symbols or date wording and no formatter was touched, that\n` +
				`is what happened — say so in the commit rather than letting it read as a\n` +
				`deliberate change to a contract Go is held to.`,
		);
		report((s) => console.error(s));
		process.exit(1);
	}

	writeFileSync(OUT, next, "utf8");
	// Both counts, because they are different things and a reader who sees only the first will read
	// "0 changed" as "nothing moved" — which it was, for a set change, until #4174.
	console.log(
		`conformance: ${total} cases across ${sections} functions; ${changed.length} case(s) changed, ` +
			`${keyChanges.length} artifact key(s) changed`,
	);
	report((s) => console.log(s));
	console.log(`\nwrote ${REL}`);
}

// Run only when INVOKED, never when imported. `tests/unit/gen-format-conformance.test.ts` imports
// the seams above, and without this guard that import would regenerate the artifact as a side
// effect of running the suite — a test that rewrites the expectation it exists to protect.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
