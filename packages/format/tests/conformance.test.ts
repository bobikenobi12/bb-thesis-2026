// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The TS half of the cross-surface formatter contract.
 *
 * `conformance/format-cases.json` is the table `packages/core/format` (Go) is held to. This
 * suite asserts the TS implementation still produces it, which is what makes that file a
 * MIRROR OF TS rather than a third opinion that drifted from both sides.
 *
 * The three layers, and how they fail:
 *   1. this suite            — TS changed and the table did not
 *   2. the CI diff-gate      — the table is stale (`pnpm -C apps/console run gen:format-conformance:check`)
 *   3. conformance_test.go   — Go disagrees with the table
 *
 * Go cannot write the file, so it has no way to make itself right. Neither side drifts alone.
 */

import { describe, expect, it } from "vitest";

// Imported rather than read off disk. `node:fs` would drag `@types/node` into this leaf package,
// and adding a devDependency here re-resolved the lockfile and bumped @better-auth/utils, which
// broke the console's type-check in an unrelated file. A JSON import needs nothing.
import caseFile from "../conformance/format-cases.json";
import { EXCLUDED } from "../conformance/cases.ts";
import * as fmt from "../src/index.ts";

const FILE = "packages/format/conformance/format-cases.json";

/**
 * A case id must NAME the boundary it pins, because the id is what a diff shows when an
 * expectation moves. `minutes/HALF-ROUNDS-UP-ACROSS-THE-HOUR-BOUNDARY` tells a reviewer what
 * changed; `minutes/3` tells them nothing and would let a regenerate-to-go-green slip past.
 *
 * The lookahead is the whole point: the name after the slash must contain at least one LETTER,
 * so a bare index cannot masquerade as a name.
 */
const SEMANTIC_ID = /^[a-zA-Z]+\/(?=[a-zA-Z0-9/.-]*[a-zA-Z])[a-zA-Z0-9/.-]+$/;

/**
 * A case row. Inputs vary per section, so the shared shape is the id and the expectation; the
 * per-section driver reads the inputs it needs.
 */
interface Row {
	id: string;
	want: string;
	[key: string]: unknown;
}

/** `null` in the table means "not a finite number" — the branch every formatter clamps. */
function n(v: unknown): number {
	if (v === null) return Number.NaN;
	if (typeof v !== "number") throw new TypeError(`expected a number or null, got ${typeof v}`);
	return v;
}

function s(v: unknown): string {
	if (typeof v !== "string") throw new TypeError(`expected a string, got ${typeof v}`);
	return v;
}

/** `formatDate`'s first parameter accepts a string or null; anything else is a bad table. */
function nullableString(v: unknown): string | null {
	if (v === null) return null;
	return s(v);
}

function dateStyle(v: unknown): fmt.DateStyle {
	const style = s(v);
	if (style === "date" || style === "datetime" || style === "month" || style === "time") return style;
	throw new TypeError(`unknown DateStyle ${JSON.stringify(style)}`);
}

function rateStyle(v: unknown): fmt.MonthlyRateStyle {
	const style = s(v);
	if (style === "estimate" || style === "exact") return style;
	throw new TypeError(`unknown MonthlyRateStyle ${JSON.stringify(style)}`);
}

/**
 * What this suite knows how to drive. Cross-checked against the table AND against the
 * package's exports below, so a formatter added to one and not the others is a failure rather
 * than a silent skip — the failure mode a table-driven suite is otherwise most prone to.
 */
const DRIVERS: Record<string, { fn: string; run: (r: Row) => string }> = {
	minutes: { fn: "formatMinutes", run: (r) => fmt.formatMinutes(n(r.in)) },
	quota: { fn: "formatQuota", run: (r) => fmt.formatQuota(n(r.used), n(r.included)) },
	duration: { fn: "formatDuration", run: (r) => fmt.formatDuration(n(r.in)) },
	date: { fn: "formatDate", run: (r) => fmt.formatDate(nullableString(r.value), dateStyle(r.style), s(r.timeZone)) },
	bytes: { fn: "formatBytes", run: (r) => fmt.formatBytes(n(r.in)) },
	money: { fn: "formatMoney", run: (r) => fmt.formatMoney(n(r.cents), s(r.currency)) },
	monthlyRate: {
		fn: "formatMonthlyRate",
		run: (r) => fmt.formatMonthlyRate(n(r.amount), rateStyle(r.style), s(r.currency)),
	},
	monthlyDelta: {
		fn: "formatMonthlyDelta",
		run: (r) => fmt.formatMonthlyDelta(n(r.amount), rateStyle(r.style), s(r.currency)),
	},
};

/** Narrow the imported file without an `any` escaping or a cast. */
function loadTable(): { version: number; zeroDecimalCharge: string[]; cases: Record<string, Row[]> } {
	const parsed: unknown = caseFile;
	if (parsed === null || typeof parsed !== "object") throw new TypeError(`${FILE} is not an object`);
	const doc: Record<string, unknown> = { ...parsed };

	const version = doc.version;
	if (typeof version !== "number") throw new TypeError(`${FILE} has no numeric \`version\``);

	// A THROW, not a default. `?? []` here would make an absent key read as an empty set, and the
	// assertion below compares the artifact against the live export — so a table generated before
	// the key existed would fail on TypeScript's fifteen codes rather than saying the key is gone.
	const rawSet = doc.zeroDecimalCharge;
	if (!Array.isArray(rawSet)) throw new TypeError(`${FILE} has no \`zeroDecimalCharge\` array (schema v2, #4123)`);
	const zeroDecimalCharge = rawSet.map((code, i) => {
		if (typeof code !== "string") throw new TypeError(`zeroDecimalCharge[${i}] is ${typeof code}, want a string`);
		return code;
	});

	const rawCases = doc.cases;
	if (rawCases === null || typeof rawCases !== "object") throw new TypeError(`${FILE} has no \`cases\` object`);

	const cases: Record<string, Row[]> = {};
	for (const [section, value] of Object.entries({ ...rawCases })) {
		if (!Array.isArray(value)) throw new TypeError(`section ${section} is not an array`);
		cases[section] = value.map((entry, i) => {
			if (entry === null || typeof entry !== "object") throw new TypeError(`${section}[${i}] is not an object`);
			const row: Record<string, unknown> = { ...entry };
			return { ...row, id: s(row.id), want: s(row.want) };
		});
	}
	return { version, zeroDecimalCharge, cases };
}

const table = loadTable();

/**
 * The rows that are the REASON this table exists, by id.
 *
 * A total-count floor is not enough on its own: at 82 cases a floor of 60 lets twenty-two rows be
 * deleted with every layer still green — including the half-cent and hour-boundary rows, which are
 * the two that actually catch Go. So the cases carrying a known cross-language divergence are
 * named, and deleting one is a failure rather than a smaller number.
 */
const REQUIRED_IDS = [
	// JS rounds half away from zero; Go's %.0f rounds half to EVEN.
	"monthlyRate/estimate/HALF-CENT-ROUNDS-AWAY-FROM-ZERO",
	"monthlyRate/exact/HALF-CENT-ROUNDS-AWAY-FROM-ZERO",
	// Rounding happens once, BEFORE the hour test.
	"minutes/HALF-ROUNDS-UP-ACROSS-THE-HOUR-BOUNDARY",
	// The bug @repo/format was written to end, still live in the CLI.
	"minutes/the-0.943-bug",
	// The used side humanises; the allowance never does. And it keeps its separator.
	"quota/used-exceeds-allowance-is-not-clamped",
	"quota/ALLOWANCE-KEEPS-THOUSANDS-SEPARATOR",
	// Duration ROLLS into hours and drops the seconds. The disagreement with cmd/jobs_list.go is
	// settled the CLI's way, so what needs pinning is the boundary in both directions: one second
	// under the hour still reads in minutes, one hour exactly does not.
	"duration/TWO-HOURS-ROLLS-INTO-HOURS",
	"duration/JUST-UNDER-AN-HOUR-DOES-NOT-ROLL",
	"duration/EXACTLY-AN-HOUR",
	// The two rows the section floor was leaving unprotected: it stayed at 8 while the section grew
	// to 13, so five rows could be deleted with every layer green — and naming WHICH may not vanish
	// is stronger than saying how many.
	"duration/hours-and-minutes-drop-the-seconds",
	"duration/many-hours",
	// The charge-divisor rows the floor was leaving unprotected, named rather than counted — the
	// same remedy the `duration` pair above got, and for the same reason. A zero-decimal currency
	// has two independently wrong renderings and one row cannot pin both: `JPY-zero` fixes the
	// value at the divisor's identity (0 divided wrongly is still 0, so it is the row that catches
	// a divisor applied to the WRONG side), and the two half-unit rows fix the rounding at the
	// boundary where a divisor of 1 and a divisor of 100 disagree by a whole unit rather than a
	// hundredth. ISK carries its own because it is the split's hardest case: CLDR zero-decimal,
	// Stripe two-decimal, so it is the row that fails if the divisor is taken from CLDR.
	"money/JPY-zero-carries-no-minor-units",
	"money/JPY-half-unit-rounds-away-from-zero",
	"money/ISK-half-unit-rounds-away-from-zero",
	// hourCycle h23, not hour12:false.
	"date/MIDNIGHT-IS-00-NOT-24",
	// The credit register — ONE ROW PER WAY OF GETTING IT WRONG, listed below rather than counted.
	// Each of these mistakes renders the REST of the block correctly, which is why none of them can
	// be dropped: dropping the sign, signing the zero, rounding half to even, deciding the sign on
	// the raw amount rather than on the rendered magnitude, rounding the decimal a human typed
	// rather than the binary product Go scales, and pre-rounding at a fixed two places rather than
	// at the ones being printed.
	//
	// NO NUMBER IN THIS SENTENCE, deliberately. It used to open "Four rows, because four separate
	// mistakes", and had been wrong since the fifth id was added below it — a hand-typed count in
	// prose beside a list is a second source of truth for the list's length, and it decays silently
	// the first time the list grows. The same sentence, with the same error, is in
	// `packages/core/format/conformance_test.go`.
	"monthlyDelta/estimate/A-SAVING-KEEPS-ITS-SIGN",
	"monthlyDelta/estimate/AN-INCREASE-IS-SIGNED-TOO",
	"monthlyDelta/exact/ZERO-CARRIES-NO-SIGN-AND-NO-MINOR-UNITS",
	"monthlyDelta/exact/JPY-HALF-ROUNDS-AWAY-FROM-ZERO",
	"monthlyDelta/estimate/A-SUB-UNIT-INCREASE-ROUNDS-TO-NO-CHANGE",
	// #3895. Three decimals, so the binary product lands on the far side of a half from the decimal
	// literal — the region every other row in this section stays out of, and where the two
	// implementations diverged for four weeks with all three layers green.
	"monthlyDelta/exact/BINARY-SCALE-8.165-ROUNDS-DOWN",
	"monthlyDelta/exact/BINARY-SCALE-8.165-ROUNDS-DOWN-A-SAVING-TOO",
	"monthlyDelta/exact/BINARY-SCALE-1.005-ROUNDS-DOWN",
	"monthlyDelta/exact/BINARY-SCALE-1.005-ROUNDS-DOWN-A-SAVING-TOO",
	// ...and the rows that fail if the pre-round is at a fixed two places instead of the printed
	// ones, which double-rounds every zero-decimal register.
	"monthlyDelta/estimate/DOUBLE-ROUNDING-12.496-IS-NOT-A-HALF",
	"monthlyDelta/exact/DOUBLE-ROUNDING-12.496-IS-NOT-A-HALF-AT-JPY",
	// `monthlyRate` clamps a negative, and that is now a REFUSAL rather than a gap — the register
	// a signed amount belongs in exists. Deleting these two would delete the only statement that
	// the clamp is deliberate.
	"monthlyRate/estimate/negative-REFUSED-see-monthlyDelta",
	"monthlyRate/exact/negative-REFUSED-see-monthlyDelta",
	// #3899, and the same argument one register over. `money` had NO pre-round and
	// `formatMonthlyRate` had one hardcoded to two places, so the four `money` rows below diverged
	// outright and the three JPY rows double-rounded. Every other row in both sections lives inside
	// two decimals and a two-decimal currency, where the two implementations cannot disagree — so
	// both sections looked like they pinned the rounding rule and pinned a weaker one.
		"money/THREE-DECIMAL-CENTS-ROUND-AWAY-FROM-ZERO",
	"money/three-decimal-cents-at-one-unit",
	"money/negative-three-decimal-cents",
	// `EUR` as well as `USD`, because the divergence is in the shared rounding step and a reader
	// should not be able to conclude it was ever about the symbol table.
		"money/three-decimal-cents-EUR",
	// The SIGN axis, and the reason it is here rather than in the section it passes in: JS
	// `Math.round` is half-UP and Go's `math.Round` is half-AWAY-FROM-ZERO, so they disagree on
	// every negative half. This row PASSED before #3899 and must keep passing — it is what fails
	// the plausible one-line fix that rounds the signed value instead of the magnitude.
		"money/NEGATIVE-HALF-CENT-ROUNDS-AWAY-FROM-ZERO-NOT-TOWARD-POSITIVE",
	// The TIE axis. `2.675 * 100` is EXACTLY `267.5`, so this row agrees only because both
	// languages take a tie away from zero; it reds a fix that reaches for Go-native half-to-even.
	// A different mechanism from the four above, which is why it is named rather than counted.
		"money/three-decimal-cents-that-agreed-all-along",
	// ── #3581, THE DIVISOR AXIS ─────────────────────────────────────────────────────────────────
	// `formatMoney` divided by 100 unconditionally, so every zero-decimal currency rendered at 1/100
	// of its value. These rows exist because BOTH ways of being wrong render the rest of this
	// section correctly, and because the second way is the one a reader reaches for first.
	//
	// Dividing everything by 100 reds the JPY, KRW and CLP rows. Taking the exponent from CLDR
	// instead — the plausible fix — reds ISK, UGX and TWD, whose CHARGE divisor is 100 while CLDR
	// prints 0, 0 and 2 fraction digits. UGX is the sharpest of the set: it is IN Stripe's published
	// zero-decimal list AND in that page's Special cases table saying to send two-decimal amounts,
	// so a table transcribed from the list alone renders it 100x overstated and passes everything
	// else here. CLP and TWD share the narrow symbol `$` and not a divisor, which is what stops the
	// divisor being read as a property of the symbol.
	//
	// HUF is the fourth currency the divisor table names and is deliberately NOT pinned: its CLDR
	// display digits moved 2 -> 0 between ICU 75.1 and ICU 78.3, so a row for it would change under
	// a Node upgrade nobody made. Its divisor is pinned in the TypeScript unit tests instead.
	"money/JPY-HAS-NO-MINOR-UNIT-SO-IT-IS-NOT-DIVIDED",
	"money/KRW-IS-ZERO-DECIMAL-TOO-NOT-JUST-JPY",
	"money/ISK-IS-CLDR-ZERO-DECIMAL-AND-STRIPE-TWO-DECIMAL",
	"money/UGX-IS-IN-STRIPES-ZERO-DECIMAL-LIST-AND-IS-STILL-DIVIDED",
	"money/CLP-AND-TWD-SHARE-A-SYMBOL-AND-NOT-A-DIVISOR",
	"money/TWD-shares-CLPs-symbol-and-is-divided",
	// The sign at a tie the two-decimal rows cannot reach: with the divisor at 1 the rounding step
	// runs at 0 places, so `-1234.5` IS the half. JS `Math.round` is half-UP and Go `math.Round` is
	// half-away-from-zero, so a fix that rounds the signed value renders `-¥1,234` here.
	"money/JPY-NEGATIVE-HALF-UNIT-ROUNDS-AWAY-FROM-ZERO-NOT-TOWARD-POSITIVE",
	// The `<1` test is asked AFTER the single rounding, at the currency's OWN places. The last of
	// these is the worst failure in the set: at a fixed two places, `0.6` JPY renders `<¥1/mo` —
	// the register ADMITTING it does not know, about a value that rounds cleanly to one whole unit.
		"monthlyRate/estimate/JPY-ROUNDS-ONCE-AT-ZERO-PLACES",
	"monthlyRate/exact/JPY-ROUNDS-ONCE-AT-ZERO-PLACES",
	"monthlyRate/estimate/JPY-SUB-UNIT-THAT-ROUNDS-UP-IS-NOT-LESS-THAN-ONE",
	// And the USD three-decimal rows, which did NOT diverge — `formatMonthlyRate` already
	// pre-rounded. They are required anyway: delete them and the pre-round can go back to being
	// absent with every layer green, which is the state #3899 measured.
		"monthlyRate/exact/THREE-DECIMAL-ROUNDS-AWAY-FROM-ZERO",
	"monthlyRate/estimate/three-decimal-rounds-away-from-zero",
	"monthlyRate/exact/three-decimal-at-one-unit",
];

/**
 * Per-section floors, so one section cannot be gutted while the total still clears.
 *
 * A FLOOR MUST BE RAISED WHEN ROWS ARE ADDED. `duration` went to 13 rows while this said 8, so five
 * could be deleted and every layer stayed green — which is the same inert-threshold defect the
 * required-id list exists to cover, one level down. The floors are the weak half of that pair by
 * construction: they answer "are there enough?" and never "are the right ones still here."
 */
const SECTION_FLOOR: Record<string, number> = {
	minutes: 12,
	quota: 6,
	duration: 13,
	date: 10,
	bytes: 8,
	// Raised 6 -> 13 and 15 -> 24 with the money/monthlyRate rounding rows (#3899), then 13 -> 23
	// with the charge-divisor rows, for the reason the paragraph above gives: the sections grew and
	// the floors did not, so the twelve rows that pin the rounding rule could have been deleted and
	// regenerated away with every layer green. The divisor rows re-earned the same complaint the
	// moment they landed — the section went to 23 and this still said 13.
	money: 23,
	monthlyRate: 24,
	// Set to the row count, not below it. The paragraph above is a complaint about floors that
	// lagged the sections they guard; a new section starting three rows slack would re-earn it.
	// Raised 22 -> 32 with the binary-scale block (#3895).
	monthlyDelta: 32,
};

describe("format conformance table", () => {
	// ── Vacuity. A suite that ran nothing must not look like a suite that found nothing wrong.
	it("is not empty", () => {
		expect(Object.keys(table.cases).length).toBeGreaterThan(0);
		const total = Object.values(table.cases).reduce((acc, rows) => acc + rows.length, 0);
		expect(total).toBeGreaterThanOrEqual(60);
	});

	// ── #4123. The set, not the rows.
	//
	// `cases.money` pins how six currencies render, and a row can only ever pin a code it NAMES.
	// The two implementations' remaining axis of disagreement is set MEMBERSHIP: a sixteenth code
	// added to `minor-units.ts` and not to `packages/core/format/format.go` moves no expectation
	// in this table, and each language's unit test enumerates its own hand-typed copy, so it only
	// catches a REMOVAL from the map beside it. Adding fifteen rows would have pinned fifteen codes
	// and left the identical hole for the sixteenth.
	//
	// So the artifact carries the list, and this is the assertion that makes it TypeScript's list
	// rather than a third opinion. `conformance_test.go` holds Go's map to the same array.
	describe("the zero-decimal charge set", () => {
		it("is what @repo/format actually consults", () => {
			expect(table.zeroDecimalCharge).toEqual([...fmt.STRIPE_ZERO_DECIMAL_CHARGE]);
		});

		// Vacuity, stated separately: the assertion above compares the artifact against the live
		// export, so if BOTH went empty it would pass. Go would be the only red, naming fifteen
		// codes and not the cause.
		it("is not empty", () => {
			expect(table.zeroDecimalCharge.length).toBeGreaterThan(0);
		});

		// Sorted, so a diff on the generated file NAMES the code that moved. Both sides compare
		// sorted, so this is about review rather than correctness — which is why it is its own
		// assertion and not folded into the equality above.
		it("is sorted", () => {
			expect(table.zeroDecimalCharge).toEqual([...table.zeroDecimalCharge].sort());
		});

		// ── #4174. Upper case, and this is the assertion that is NOT redundant with the others.
		//
		// `stripeChargeDivisor` uppercases the QUERY and never the entries, so a lowercase entry is
		// INERT here: it is in the array, it is published, and `stripeChargeDivisor("ugx")` still
		// answers 100. It is not a code TypeScript treats as zero-decimal, and nothing above can see
		// that. The sort check passes because "ugx" (U+0075) sorts after "XPF" (U+0058); the four
		// `not.toContain` assertions are `===`-based and never match a lowercase spelling; and the
		// equality assertion compares the artifact against the very export it was generated from,
		// so it agrees with itself in whatever case that export was written in.
		//
		// It lands HERE as well as in the generator because this is the package that owns the
		// literal. The generator's refusal only fires when somebody regenerates; this fires on
		// `pnpm -F @repo/format test`, in the language whose file is wrong.
		it("is upper case, because a lowercase entry is inert in the set this package consults", () => {
			const notUpper = table.zeroDecimalCharge.filter((code) => code !== code.toUpperCase());
			expect(notUpper, "a lowercase code is published but never consulted — see minor-units.ts").toEqual([]);
			// The inertness itself, not only its spelling: every published code must actually reach
			// the divisor it was published to declare. This is the assertion a reader can check
			// against the defect, because it fails for a lowercase entry without naming case at all.
			for (const code of table.zeroDecimalCharge) {
				expect(fmt.stripeChargeDivisor(code), `${code} is published as zero-decimal but divides by 100`).toBe(1);
			}
		});

		// The key is a shape change and the generator bumped VERSION for it. Go refuses a table
		// below 2 rather than reading the absent key as an empty set; assert the producer's half of
		// that here, so a VERSION reverted to 1 is red where it is written rather than only in Go.
		it("arrived with the schema version that announces it", () => {
			expect(table.version).toBeGreaterThanOrEqual(2);
		});

		// The set is a claim about Stripe's CHARGE context, and #4101 recorded that it is NOT
		// Stripe's published list: UGX is in that list and in the same page's Special cases table
		// saying to send two-decimal amounts for a charge. Sixteen published, fifteen here. An
		// equality assertion alone would happily ratify a set "fixed" back to the raw sixteen, so
		// the exclusion is named. HUF and TWD are absent for the opposite reason — their special
		// cases are about PAYOUTS — and are named too, so a later reader cannot read their absence
		// as an oversight and add them.
		it("excludes UGX, and does not exclude the payout-only special cases by mistake", () => {
			expect(table.zeroDecimalCharge).not.toContain("UGX");
			expect(table.zeroDecimalCharge).not.toContain("HUF");
			expect(table.zeroDecimalCharge).not.toContain("TWD");
			expect(table.zeroDecimalCharge).not.toContain("ISK");
			// ...and it is the real set, not an empty one trivially satisfying the four above.
			expect(table.zeroDecimalCharge).toContain("JPY");
			expect(table.zeroDecimalCharge).toContain("CLP");
		});
	});

	it("meets a floor in every section, not just in total", () => {
		for (const [section, floor] of Object.entries(SECTION_FLOOR)) {
			expect(table.cases[section]?.length ?? 0, `section ${section} fell below its floor`).toBeGreaterThanOrEqual(
				floor,
			);
		}
		// And the floors themselves cover every section, so adding a section without a floor is
		// not a silent exemption.
		expect(Object.keys(SECTION_FLOOR).sort()).toEqual(Object.keys(table.cases).sort());
	});

	it("still carries every case that exists because Go disagrees", () => {
		const ids = new Set(Object.values(table.cases).flatMap((rows) => rows.map((r) => r.id)));
		expect(REQUIRED_IDS.filter((id) => !ids.has(id))).toEqual([]);
	});

	it("has a driver for every section, and a section for every driver", () => {
		expect(Object.keys(table.cases).sort()).toEqual(Object.keys(DRIVERS).sort());
	});

	it("covers every formatter @repo/format exports, or excludes it with a reason", () => {
		const exported = Object.entries(fmt)
			.filter(([name, v]) => typeof v === "function" && name.startsWith("format"))
			.map(([name]) => name)
			.sort();
		const driven = Object.values(DRIVERS).map((d) => d.fn);
		const accountedFor = new Set([...driven, ...Object.keys(EXCLUDED)]);
		expect(exported.filter((name) => !accountedFor.has(name))).toEqual([]);

		// And the reasons are sentences somebody can disagree with, not "n/a".
		for (const [name, reason] of Object.entries(EXCLUDED)) {
			expect(reason.length, `${name}'s exclusion reason is too short to be a reason`).toBeGreaterThan(40);
		}
	});

	it("has no section with zero cases", () => {
		for (const [section, rows] of Object.entries(table.cases)) {
			expect(rows.length, `section ${section} is present but empty`).toBeGreaterThan(0);
		}
	});

	it("has unique, semantic ids", () => {
		const ids = Object.values(table.cases).flatMap((rows) => rows.map((r) => r.id));
		expect(new Set(ids).size, "duplicate case ids").toBe(ids.length);
		for (const id of ids) expect(id, `${id} is not a section/name id`).toMatch(SEMANTIC_ID);
	});

	// The rule above is only worth as much as its regex, and the first version of that regex
	// ACCEPTED `minutes/3` — the exact example the comment beside it offered as the thing to
	// reject. So the regex is tested in both directions, here, rather than trusted.
	it("its own id rule rejects an index-shaped id", () => {
		for (const good of ["minutes/the-0.943-bug", "monthlyRate/estimate/JPY-HAS-NO-MINOR-UNIT", "date/plain"]) {
			expect(good, `${good} should be a valid id`).toMatch(SEMANTIC_ID);
		}
		for (const bad of ["minutes/3", "minutes/0", "minutes/1.2", "minutes/", "minutes", "3/minutes"]) {
			expect(bad, `${bad} should NOT be a valid id`).not.toMatch(SEMANTIC_ID);
		}
	});

	// ── The contract itself.
	for (const [section, driver] of Object.entries(DRIVERS)) {
		describe(section, () => {
			const rows = table.cases[section] ?? [];
			for (const row of rows) {
				it(row.id, () => {
					expect(driver.run(row)).toBe(row.want);
				});
			}
		});
	}
});
