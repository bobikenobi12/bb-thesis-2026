// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The conformance INPUTS — hand-authored, and the only hand-authored half.
 *
 * `format-cases.json` pairs each of these with the output the real `@repo/format`
 * implementation produces. That split is deliberate and load-bearing:
 *
 *   - a human curates the INPUTS, because choosing them is the design work;
 *   - the generator produces the OUTPUTS, because a hand-written expectation is a third
 *     source of truth that goes stale silently.
 *
 * So regenerating can only ever move an expectation, never invent a case — and because every
 * id is semantic rather than an array index, the diff says WHICH BOUNDARY MOVED.
 *
 * ── Why these inputs and not others ──────────────────────────────────────────────────────
 *
 * The wrong axis to vary is the function: `{fn, input, want}` across eight functions looks
 * thorough and proves nothing. The axis that matters is the BRANCH BOUNDARY inside each
 * function, because that is exactly where two languages diverge.
 *
 * The single highest-value row in this file is `monthlyRate/estimate/HALF-CENT-...`. JS rounds
 * half away from zero, so `12.5` renders `$12.50`. Go's `fmt.Sprintf("%.0f", 12.5)` rounds
 * half to EVEN and renders `12` — which is what `cmd/clusters_list.go:94` does today, against
 * a billing page showing `$12.50`. A table built by varying inputs casually contains no `.5`
 * case and never finds it.
 *
 * ── Determinism ──────────────────────────────────────────────────────────────────────────
 *
 * Every date case pins an explicit IANA `timeZone`. Without one, `Intl.DateTimeFormat` uses
 * the runtime's zone and the generated file would differ per machine — which would turn the
 * CI diff-gate into a permanent false failure and get it deleted.
 */

/** A case for a function taking a single number. */
export interface NumberCase {
	id: string;
	in: number | null;
}

/** A case for `formatQuota(usedMinutes, includedMinutes)`. */
export interface QuotaCase {
	id: string;
	used: number;
	included: number;
}

/** A case for `formatDate(value, style, timeZone)`. */
export interface DateCase {
	id: string;
	value: string | null;
	style: "date" | "datetime" | "month" | "time";
	timeZone: string;
}

/** A case for `formatMoney(cents, currency)`. */
export interface MoneyCase {
	id: string;
	cents: number;
	currency: string;
}

/** A case for `formatMonthlyRate(amount, style, currency)`. */
export interface MonthlyRateCase {
	id: string;
	amount: number;
	style: "estimate" | "exact";
	currency: string;
}

/**
 * A case for `formatMonthlyDelta(amount, style, currency)`. Structurally identical to
 * {@link MonthlyRateCase} and kept separate anyway: the two functions answer different questions,
 * and a shared type would let a case be moved between the sections by editing one word, in a file
 * whose whole purpose is that a moved expectation is visible.
 */
export interface MonthlyDeltaCase {
	id: string;
	/** `null` is "not a finite number", the same sentinel {@link NumberCase} uses. */
	amount: number | null;
	style: "estimate" | "exact";
	currency: string;
}

/**
 * `formatMinutes` — rounds ONCE, before the hour test, so a value cannot round differently in
 * two branches. The pair either side of 59.5 is what pins that.
 */
export const MINUTES: NumberCase[] = [
	{ id: "minutes/zero-is-not-an-approximation", in: 0 },
	{ id: "minutes/negative-clamps-to-zero", in: -5 },
	{ id: "minutes/nonfinite-clamps-to-zero", in: null },
	{ id: "minutes/barely-above-zero-still-admits-it", in: 0.001 },
	{ id: "minutes/the-0.943-bug", in: 0.943 },
	{ id: "minutes/just-under-one", in: 0.999 },
	{ id: "minutes/exactly-one", in: 1 },
	{ id: "minutes/whole-minutes-below-the-hour", in: 30 },
	{ id: "minutes/rounds-DOWN-below-the-hour", in: 59.4 },
	{ id: "minutes/HALF-ROUNDS-UP-ACROSS-THE-HOUR-BOUNDARY", in: 59.5 },
	{ id: "minutes/rounds-UP-across-the-hour", in: 59.6 },
	{ id: "minutes/exactly-one-hour-drops-the-minutes", in: 60 },
	{ id: "minutes/whole-hours-drop-the-minutes", in: 120 },
	{ id: "minutes/hour-and-remainder", in: 135 },
	{ id: "minutes/ninety", in: 90 },
];

/**
 * `formatQuota` — the USED side is humanised, the ALLOWANCE side is NOT, because `200` is the
 * number the pricing page quotes and `3h 20m` is unrecognisable to someone checking their
 * limit. The 1200 case pins thousands grouping, which a Go port gets wrong by default.
 */
export const QUOTA: QuotaCase[] = [
	{ id: "quota/the-reported-bug-0.943-of-200", used: 0.943, included: 200 },
	{ id: "quota/nothing-used", used: 0, included: 200 },
	{ id: "quota/ALLOWANCE-KEEPS-THOUSANDS-SEPARATOR", used: 0.943, included: 1200 },
	{ id: "quota/allowance-is-rounded-to-whole-minutes", used: 5, included: 199.6 },
	{ id: "quota/zero-allowance", used: 5, included: 0 },
	{ id: "quota/negative-allowance-clamps", used: 5, included: -10 },
	{ id: "quota/used-exceeds-allowance-is-not-clamped", used: 250, included: 200 },
];

/**
 * `formatDuration` — milliseconds. It ROLLS INTO HOURS at 60 minutes, and drops the seconds when
 * it does: 7_200_000ms is `2h 0m`, not `120m 0s`. That is the contract, and it is the answer
 * `cmd/jobs_list.go` already gave — the console was the half that disagreed, and the disagreement
 * was settled in the CLI's favour because a provision over an hour is the common path, not an
 * edge case.
 *
 * The rows pin the roll from BOTH sides, which is what a port has to satisfy: one that forgets to
 * roll fails `EXACTLY-AN-HOUR`, one that rolls a millisecond early fails
 * `JUST-UNDER-AN-HOUR-DOES-NOT-ROLL`, and one that keeps the seconds past the roll fails
 * `hours-and-minutes-drop-the-seconds`.
 */
export const DURATION: NumberCase[] = [
	{ id: "duration/zero", in: 0 },
	{ id: "duration/negative-clamps", in: -1000 },
	{ id: "duration/nonfinite-clamps", in: null },
	{ id: "duration/sub-second-floors-to-zero", in: 999 },
	{ id: "duration/one-second", in: 1000 },
	{ id: "duration/JUST-UNDER-A-MINUTE", in: 59999 },
	{ id: "duration/EXACTLY-A-MINUTE", in: 60000 },
	{ id: "duration/minute-and-seconds", in: 72000 },
	// RENAMED, not edited. The old id was `TWO-HOURS-DOES-NOT-ROLL-INTO-HOURS` and it asserted the
	// old behaviour IN ITS NAME, so leaving the name while changing the output would have left the
	// table saying the opposite of what it holds. A ruling that changes an answer renames the case.
	{ id: "duration/TWO-HOURS-ROLLS-INTO-HOURS", in: 7200000 },
	{ id: "duration/JUST-UNDER-AN-HOUR-DOES-NOT-ROLL", in: 3599999 },
	{ id: "duration/EXACTLY-AN-HOUR", in: 3600000 },
	{ id: "duration/hours-and-minutes-drop-the-seconds", in: 7505000 },
	{ id: "duration/many-hours", in: 356400000 },
];

/**
 * `formatDate` — every case pins a zone; see the determinism note above. The midnight case is
 * why `DATE_OPTS.time` uses `hourCycle: "h23"` rather than `hour12: false`, which renders
 * midnight as 24:00 in some locales.
 */
export const DATE: DateCase[] = [
	{ id: "date/null-is-an-em-dash", value: null, style: "date", timeZone: "UTC" },
	{ id: "date/unparseable-is-an-em-dash", value: "not-a-date", style: "date", timeZone: "UTC" },
	{ id: "date/plain", value: "2026-03-09T15:04:05.000Z", style: "date", timeZone: "UTC" },
	{ id: "date/datetime", value: "2026-03-09T15:04:05.000Z", style: "datetime", timeZone: "UTC" },
	{ id: "date/month", value: "2026-03-09T15:04:05.000Z", style: "month", timeZone: "UTC" },
	{ id: "date/time", value: "2026-03-09T15:04:05.000Z", style: "time", timeZone: "UTC" },
	{ id: "date/MIDNIGHT-IS-00-NOT-24", value: "2026-03-09T00:00:00.000Z", style: "time", timeZone: "UTC" },
	{ id: "date/noon", value: "2026-03-09T12:00:00.000Z", style: "time", timeZone: "UTC" },
	{ id: "date/zone-shifts-the-day", value: "2026-03-09T23:30:00.000Z", style: "datetime", timeZone: "Asia/Tokyo" },
	{ id: "date/month-boundary", value: "2026-01-31T23:59:59.000Z", style: "date", timeZone: "UTC" },
	{ id: "date/leap-day", value: "2028-02-29T12:00:00.000Z", style: "date", timeZone: "UTC" },
	{ id: "date/single-digit-day-is-not-padded", value: "2026-03-01T12:00:00.000Z", style: "date", timeZone: "UTC" },
];

/**
 * `formatBytes` — 1024 steps, one decimal above kilobytes only.
 *
 * There is no Go counterpart and deliberately so: as of this commit `apps/cli`, `apps/runner`
 * and `packages/core` render zero byte counts. These cases exist so the contract is STATED
 * for the day one is written, rather than rediscovered.
 */
export const BYTES: NumberCase[] = [
	{ id: "bytes/zero", in: 0 },
	{ id: "bytes/negative-clamps", in: -1 },
	{ id: "bytes/nonfinite-clamps", in: null },
	{ id: "bytes/BYTES-HAVE-NO-DECIMAL", in: 812 },
	{ id: "bytes/just-under-a-kilobyte", in: 1023 },
	{ id: "bytes/EXACTLY-A-KILOBYTE-STEPS-UP", in: 1024 },
	{ id: "bytes/kilobytes-keep-one-decimal", in: 1536 },
	{ id: "bytes/a-megabyte", in: 1048576 },
	{ id: "bytes/rounds-to-one-decimal", in: 1468006 },
	// 1024**6 rather than a decimal literal: it is 2^60, so it is exactly representable as a
	// double, and the equivalent literal both loses precision and is easy to fat-finger.
	{ id: "bytes/petabytes-are-the-last-unit", in: 1024 ** 6 },
];

/**
 * `formatMoney` — MINOR units (cents), which is how Stripe and the billing tables store it.
 *
 * ── THE DIVISOR AXIS (#3581) ──────────────────────────────────────────────────────────────
 *
 * This section carried two-decimal currencies ONLY until #3581, because the `/ 100` was
 * unconditional and pinning a zero-decimal currency would have frozen a money bug as the contract
 * Go must reproduce. The divisor now comes from `src/minor-units.ts` — Stripe's CHARGE-context
 * table — and the rows below are chosen so that BOTH ways of getting it wrong are red:
 *
 *   - dividing everything by 100 (the original defect) reds every JPY/KRW/CLP row;
 *   - taking the exponent from CLDR instead (the plausible fix, which inverts it) reds ISK, UGX
 *     and TWD, whose CHARGE divisor is 100 while CLDR prints 0, 0 and 2 fraction digits.
 *
 * `UGX-IS-IN-STRIPES-ZERO-DECIMAL-LIST-AND-IS-STILL-DIVIDED` is the single highest-value row here.
 * UGX appears in Stripe's own published zero-decimal list AND in that page's Special cases table
 * saying to send two-decimal amounts for a charge. A table transcribed from the list — the obvious
 * implementation — renders it 100x overstated and passes every other row in this section.
 *
 * CLP and TWD are the second pair: both narrow-render as `$`, and their divisors differ. A fix
 * keyed on anything the SYMBOL can see passes one and fails the other.
 *
 * ── WHAT IS DELIBERATELY ABSENT, AND WHY IT IS NOT AN OVERSIGHT ───────────────────────────
 *
 * HUF. It is the fourth currency `minor-units.ts` names, and it CANNOT be pinned here: its CLDR
 * DISPLAY digits moved from 2 to 0 between ICU 75.1 (Node 20) and ICU 78.3 (Node 24), measured on
 * this machine. `actions/setup-node` with `node-version: 22` resolves to whatever 22.x is current
 * on the day, so a HUF row would be a contract that changes under a runner upgrade nobody made —
 * and the generator's own stale-table message already warns that a CLDR bump moves expectations.
 * Its DIVISOR is pinned instead, in `tests/format.test.ts`, by an assertion that reads the number
 * and tolerates the decimals. Every currency below was verified identical on both ICU versions.
 *
 * Three-decimal currencies (BHD, JOD, KWD, OMR, TND). Stripe publishes no three-decimal list to
 * cite any more, so `minor-units.ts` asserts no divisor for them and they take the two-decimal
 * default. Pinning that here would freeze a guess.
 */
export const MONEY: MoneyCase[] = [
	{ id: "money/zero", cents: 0, currency: "USD" },
	{ id: "money/negative", cents: -500, currency: "USD" },
	{ id: "money/whole-dollars-still-show-cents", cents: 1200, currency: "USD" },
	{ id: "money/cents", cents: 1250, currency: "USD" },
	{ id: "money/THOUSANDS-SEPARATOR", cents: 124037, currency: "USD" },
	{ id: "money/EUR-NARROW-SYMBOL-NOT-EUR-PREFIX", cents: 1250, currency: "EUR" },
	{ id: "money/GBP-narrow-symbol", cents: 1250, currency: "GBP" },
	// A THIRD DECIMAL IS THE AXIS THE TWO LANGUAGES DIVERGE ON, and every row above sits on the
	// agreeing side of it. `cents / 100` hands `816.5` to the renderer as `8.165`; Go scales the
	// BINARY double back up and `8.165 * 100` is `816.4999999999999`, so Go rounded DOWN while Intl,
	// reading the shortest round-tripping decimal `8.165`, rounded UP. Two currencies, because the
	// divergence is in the shared rounding step and not in the symbol table.
	{ id: "money/THREE-DECIMAL-CENTS-ROUND-AWAY-FROM-ZERO", cents: 816.5, currency: "USD" },
	{ id: "money/three-decimal-cents-at-one-unit", cents: 100.5, currency: "USD" },
	{ id: "money/three-decimal-cents-EUR", cents: 816.5, currency: "EUR" },
	// The SIGN is a second axis, and it is the one a naive fix breaks: JS `Math.round` is half-UP
	// (toward +∞) while Go's `math.Round` is half-AWAY-from-zero, so they disagree on every negative
	// half. `render` extracts the sign BEFORE rounding the magnitude; anything mirroring it must too.
	// `-812.5` is the row that catches a fix that rounds the signed value instead.
	{ id: "money/NEGATIVE-HALF-CENT-ROUNDS-AWAY-FROM-ZERO-NOT-TOWARD-POSITIVE", cents: -812.5, currency: "USD" },
	{ id: "money/negative-three-decimal-cents", cents: -816.5, currency: "USD" },
	// NEGATIVE ZERO IS ABSENT AND CANNOT BE ADDED — recorded here so the next reader does not
	// "fix" the gap with a row that proves nothing. `JSON.stringify(-0)` is `"0"`, so a `cents: -0`
	// case reaches Go as `+0` and passes whatever either language does with the sign. This table is
	// structurally unable to see it.
	//
	// AND THE TWO LANGUAGES DO DISAGREE ABOUT IT. Go's `render` tests `amount < 0`, which is false
	// for `-0`, so it adds no sign — and then `strconv.FormatFloat(-0, 'f', 2, 64)` emits one
	// anyway, giving `$-0.00`, a form nobody writes and the opposite of this package's
	// sign-leads-the-symbol rule. TypeScript answered `-$0.00` before #3899 and answers `$0.00`
	// after it, because `roundHalfAwayFromZero` rounds the magnitude and `-0 < 0` is false.
	//
	// A CALLER REACHES IT: `apps/console/components/agent/widgets/registry.tsx`'s `usd()` is
	// `formatMoney(Math.round(v * 100))`, and `Math.round(-0.001 * 100)` IS `-0`, so any
	// `overage_cost_usd` in `[-0.005, 0)` lands here. "No caller produces -0" was written in this
	// comment and was wrong. Pinning it needs a Go-side unit test and a decision about which answer
	// is right; `$-0.00` is the one that is clearly not.
	//
	// A CONTROL, and it is why "add a three-decimal row" is not the whole instruction. `2.675`
	// agrees, and NOT for the reason first written here: `2.675 * 100` is EXACTLY `267.5` as a
	// double — the product lands precisely ON the half, where both languages round away from zero
	// and cannot disagree. The divergent case needs a product that lands just BELOW the half, like
	// `8.165 * 100` = `816.4999999999999`. Picking controls by "it has three decimals" selects this
	// class as often as that one, which is how the original blind spot survived.
	{ id: "money/three-decimal-cents-that-agreed-all-along", cents: 267.5, currency: "USD" },
	// ── zero-decimal: the amount IS the charge, so it is NOT divided ────────────────────────────
	// The issue's own example. `¥1,240` was what this rendered for a ¥124,000 invoice.
	{ id: "money/JPY-HAS-NO-MINOR-UNIT-SO-IT-IS-NOT-DIVIDED", cents: 124000, currency: "JPY" },
	// A second one, because "the zero-decimal set" must not be readable as "JPY". Stripe publishes
	// fifteen more, and a symbol that is not a `$`-family glyph.
	{ id: "money/KRW-IS-ZERO-DECIMAL-TOO-NOT-JUST-JPY", cents: 124000, currency: "KRW" },
	{ id: "money/JPY-zero-carries-no-minor-units", cents: 0, currency: "JPY" },
	// A HALF AT THE UNIT BOUNDARY, which no two-decimal row in this section can reach: with the
	// divisor at 1 the rounding step runs at 0 places, so `1234.5` is the tie. Before #3581 this
	// input was 12.345 by the time it reached the renderer and rounded to a whole 12.
	{ id: "money/JPY-half-unit-rounds-away-from-zero", cents: 1234.5, currency: "JPY" },
	// ...and its sign, the axis a fix that rounds the signed value gets wrong: JS `Math.round` is
	// half-UP and Go's `math.Round` is half-AWAY-FROM-ZERO, so they part company on every negative
	// half. The two-decimal row of this shape is `NEGATIVE-HALF-CENT-...`; this is it at 0 places.
	{ id: "money/JPY-NEGATIVE-HALF-UNIT-ROUNDS-AWAY-FROM-ZERO-NOT-TOWARD-POSITIVE", cents: -1234.5, currency: "JPY" },
	// ── divided by 100, printed with no decimals: the pair that reds a CLDR-derived divisor ─────
	// Stripe: "to charge 5 ISK, provide an `amount` value of `500`". CLDR prints ISK with no
	// fraction digits. Both are true and they are answers to different questions; `kr 5` is what
	// asking each of them the right one produces. A CLDR-derived divisor renders `kr 500`.
	{ id: "money/ISK-IS-CLDR-ZERO-DECIMAL-AND-STRIPE-TWO-DECIMAL", cents: 500, currency: "ISK" },
	// THE ROW THAT CATCHES A TABLE TRANSCRIBED FROM STRIPE'S LIST. UGX is IN the published
	// zero-decimal list and ALSO in the Special cases table, which says to send two-decimal amounts
	// for a charge. Take the list at face value and this renders `UGX 500` — 100x overstated — while
	// every other row here still passes.
	{ id: "money/UGX-IS-IN-STRIPES-ZERO-DECIMAL-LIST-AND-IS-STILL-DIVIDED", cents: 500, currency: "UGX" },
	// A half at the unit boundary again, reached the other way round: divided by 100 and printed at
	// 0 places, so `850` lands on the tie that a two-decimal currency never puts there.
	{ id: "money/ISK-half-unit-rounds-away-from-zero", cents: 850, currency: "ISK" },
	// ── one symbol, two divisors ────────────────────────────────────────────────────────────────
	// CLP and TWD both narrow-render as `$` in en-GB, and CLP is zero-decimal for charges while TWD
	// is not. Together they state that the divisor is not a property of the symbol — which is what a
	// reader concludes from a section where every zero-decimal row also has a distinctive glyph.
	{ id: "money/CLP-AND-TWD-SHARE-A-SYMBOL-AND-NOT-A-DIVISOR", cents: 124000, currency: "CLP" },
	{ id: "money/TWD-shares-CLPs-symbol-and-is-divided", cents: 124000, currency: "TWD" },
];

/**
 * `formatMonthlyRate` — MAJOR units. The two registers differ only in whether the figure may
 * admit it does not know; they never differ in PRECISION for the same number, which is what
 * lets a breakdown line and its total sit in one column.
 *
 * Rounding to cents happens ONCE, before the `<1` test, so 0.999 reads `$1.00/mo` and never
 * `<$1/mo` beside a `$1.00/mo`. The `<= 0` test runs FIRST on the raw value, because 0.001 is
 * a real cost that must not round into "nothing is running".
 *
 * The two `negative-REFUSED-see-monthlyDelta` cases freeze a REFUSAL, and they used to freeze a
 * GAP. `<= 0` is one test, so a negative loses its sign in BOTH registers and a saving renders as
 * `$0/mo` / `$0.00/mo` — including in the register that promises to round nothing away. Until
 * #3768 that was a hole with nowhere for a signed amount to go; the rows are unchanged and their
 * MEANING is not, because `formatMonthlyDelta` now exists. `formatMonthlyRate` means an absolute
 * cost, clamping is how it declines a delta, and these two rows are what stop either language
 * quietly deciding otherwise. The ids say so: a reader who finds `negative-clamps` here and reads
 * it as an unfixed bug would be reading the table correctly and the tree wrongly.
 */
export const MONTHLY_RATE: MonthlyRateCase[] = [
	{ id: "monthlyRate/estimate/zero-is-not-a-bill", amount: 0, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/exact/zero-is-a-column-entry", amount: 0, style: "exact", currency: "USD" },
	{ id: "monthlyRate/estimate/negative-REFUSED-see-monthlyDelta", amount: -3, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/exact/negative-REFUSED-see-monthlyDelta", amount: -3, style: "exact", currency: "USD" },
	{ id: "monthlyRate/estimate/sub-dollar-ADMITS-IT", amount: 0.02, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/exact/sub-dollar-DOES-NOT", amount: 0.02, style: "exact", currency: "USD" },
	{ id: "monthlyRate/estimate/a-tenth-of-a-cent-is-still-running", amount: 0.001, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/exact/a-tenth-of-a-cent-rounds-to-zero-cents", amount: 0.001, style: "exact", currency: "USD" },
	{ id: "monthlyRate/estimate/0.999-ROUNDS-TO-A-DOLLAR-NOT-TO-LESS-THAN-ONE", amount: 0.999, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/estimate/HALF-CENT-ROUNDS-AWAY-FROM-ZERO", amount: 12.5, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/exact/HALF-CENT-ROUNDS-AWAY-FROM-ZERO", amount: 12.5, style: "exact", currency: "USD" },
	{ id: "monthlyRate/estimate/half-cent-at-an-odd-dollar", amount: 13.5, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/estimate/thousands-separator", amount: 1240.37, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/exact/a-breakdown-line", amount: 60.25, style: "exact", currency: "USD" },
	{ id: "monthlyRate/exact/its-sibling-line", amount: 45.1, style: "exact", currency: "USD" },
	{ id: "monthlyRate/exact/and-their-total", amount: 105.35, style: "exact", currency: "USD" },
	{ id: "monthlyRate/estimate/JPY-HAS-NO-MINOR-UNIT", amount: 1240, style: "estimate", currency: "JPY" },
	{ id: "monthlyRate/estimate/EUR-NARROW-SYMBOL", amount: 12.5, style: "estimate", currency: "EUR" },
	// The three-decimal axis again. This register takes MAJOR units, so there is no `/100` in front
	// of it and the value reaches the rounding step exactly as written — which makes these rows a
	// cleaner statement of the same divergence than `money`'s.
	{ id: "monthlyRate/exact/THREE-DECIMAL-ROUNDS-AWAY-FROM-ZERO", amount: 8.165, style: "exact", currency: "USD" },
	{ id: "monthlyRate/estimate/three-decimal-rounds-away-from-zero", amount: 8.165, style: "estimate", currency: "USD" },
	{ id: "monthlyRate/exact/three-decimal-at-one-unit", amount: 1.005, style: "exact", currency: "USD" },
	// A ZERO-DECIMAL CURRENCY IS A SECOND AXIS, and `JPY-HAS-NO-MINOR-UNIT` above misses it by
	// being a whole number. The question these ask is AT HOW MANY PLACES the single rounding
	// happens: Go rounds at `decimalsFor(currency)` — 0 for JPY — while the TypeScript pre-round is
	// written against a hardcoded 100. `12.496` is the value that separates rounding once at zero
	// places from rounding to cents and letting the formatter round a second time.
	{ id: "monthlyRate/estimate/JPY-ROUNDS-ONCE-AT-ZERO-PLACES", amount: 12.496, style: "estimate", currency: "JPY" },
	{ id: "monthlyRate/exact/JPY-ROUNDS-ONCE-AT-ZERO-PLACES", amount: 12.496, style: "exact", currency: "JPY" },
	// And the `<1` boundary is asked AFTER that single rounding, so in a zero-decimal currency a
	// sub-unit amount that rounds UP to one unit is not "less than one unit" and must not say so.
	{ id: "monthlyRate/estimate/JPY-SUB-UNIT-THAT-ROUNDS-UP-IS-NOT-LESS-THAN-ONE", amount: 0.6, style: "estimate", currency: "JPY" },
];

/**
 * `formatMonthlyDelta` — MAJOR units, SIGNED. The register `formatMonthlyRate` refuses to be, so
 * the rows below are chosen to pin the three things that are new here rather than to re-cover
 * ground the `monthlyRate` section already holds.
 *
 * 1. THE SIGN, IN BOTH DIRECTIONS AND IN BOTH REGISTERS, leading the currency symbol. A port that
 *    drops it, or that hands the job to a locale-aware `signDisplay` and gets `$+13`, fails four
 *    rows rather than one.
 * 2. ZERO IS UNSIGNED, and so is a change that ROUNDS to zero — one rule, reached by two routes,
 *    so both routes are pinned. `sub-unit-*-ROUNDS-TO-NO-CHANGE` is the row that fails if the sign
 *    is decided on the raw amount instead of the rendered magnitude: that spelling produces
 *    `+$0/mo` and `+$0.00/mo`, the increase-that-did-not-happen the ruling forbids.
 * 3. THE REGISTERS DIFFER IN PRECISION here, which they do NOT in `monthlyRate`. `0.4` is the pair
 *    that states it: `$0/mo` as an estimate, `+$0.40/mo` as an exact line. An implementation that
 *    copied `monthlyRate`'s register rule wholesale renders `+$0.40/mo` for both and fails one.
 * 4. WHICH VALUE THE ROUNDING SEES — the binary double, or the decimal a human typed. That is the
 *    `BINARY-SCALE-*` block, and it needs a THREE-decimal input; read the next paragraph before
 *    adding a row here.
 *
 * The half-away-from-zero rounding that this whole package exists for is pinned in both
 * directions (`12.5`, `-12.5`) at the estimate register, and once more at the EXACT register
 * through JPY — which has no minor unit, so `12.5` meets the same half there.
 *
 * ── A THIRD DECIMAL IS REQUIRED, and this is where the table was blind ────────────────────
 *
 * Every row above carries at most TWO decimals, which is exactly the region where the two
 * implementations cannot disagree: a two-decimal literal scales by 100 to a whole number with no
 * representation error, so rounding the BINARY product and rounding the DECIMAL string give the
 * same answer by construction. `monthlyDelta/exact/JPY-HALF-ROUNDS-AWAY-FROM-ZERO` looks like the
 * row that locks the exact register's rounding and does not: JPY has no minor unit, so it only
 * ever exercises the whole-unit path. The table LOOKED like it pinned the rounding rule and pinned
 * a different one — and `formatMonthlyDelta` shipped rendering `+$8.17/mo` against Go's
 * `+$8.16/mo` for four weeks with every layer green (#3895).
 *
 * A third decimal is what separates them. `8.165 * 100` is `816.4999999999999` as a double, so a
 * multiply-first rounder (Go's `roundHalfAwayFromZero`, and now this side's pre-round) goes DOWN
 * while a decimal rounder reading "8.165" goes UP. `1.005` is the same. `2.675` and `0.125` are
 * three-decimal too and agree, which is why a third decimal is necessary but not sufficient —
 * the value must also scale to the far side of a half.
 *
 * This paragraph replaces one that argued the opposite, and the argument is worth stating so it is
 * not reinstated: a half-cent case was called "deliberately absent" because `12.505` is not
 * exactly representable and the row "would pin a floating-point artefact rather than the rounding
 * rule". That is backwards. The floating-point artefact IS the rounding rule as far as two
 * languages sharing one string are concerned, and declining to pin it is what let them diverge.
 * The rows are still generated from the real implementation, so no expectation is hand-guessed.
 *
 * A NEW ROW HERE SHOULD CARRY THREE DECIMALS unless it is pinning something other than rounding.
 * Two decimals rebuild the blind spot.
 *
 * No currency without a symbol appears here, for the same reason none appears under `monthlyRate`
 * or `money`: TypeScript delegates to Intl, which knows a narrow symbol or an ISO code for every
 * currency and PREFIXES it, while `packages/core/format` carries a deliberate four-entry table and
 * SUFFIXES the code — `CHF\u00a012.50` against `12.50 CHF`. That divergence is a recorded ruling
 * rather than a mirror (see the header of `packages/core/format/format_test.go`), so it belongs in
 * Go's own tests, and a row here would freeze a disagreement instead of a contract.
 */
export const MONTHLY_DELTA: MonthlyDeltaCase[] = [
	{ id: "monthlyDelta/estimate/ZERO-CARRIES-NO-SIGN", amount: 0, style: "estimate", currency: "USD" },
	{ id: "monthlyDelta/exact/ZERO-CARRIES-NO-SIGN-AND-NO-MINOR-UNITS", amount: 0, style: "exact", currency: "USD" },
	{ id: "monthlyDelta/estimate/nonfinite-is-no-change", amount: null, style: "estimate", currency: "USD" },
	{ id: "monthlyDelta/exact/nonfinite-is-no-change", amount: null, style: "exact", currency: "USD" },
	{ id: "monthlyDelta/estimate/A-SAVING-KEEPS-ITS-SIGN", amount: -5, style: "estimate", currency: "USD" },
	{ id: "monthlyDelta/exact/A-SAVING-KEEPS-ITS-SIGN", amount: -5, style: "exact", currency: "USD" },
	{ id: "monthlyDelta/estimate/AN-INCREASE-IS-SIGNED-TOO", amount: 12.5, style: "estimate", currency: "USD" },
	{ id: "monthlyDelta/exact/AN-INCREASE-KEEPS-ITS-CENTS", amount: 12.5, style: "exact", currency: "USD" },
	{ id: "monthlyDelta/estimate/HALF-UNIT-ROUNDS-AWAY-FROM-ZERO-DOWNWARD-TOO", amount: -12.5, style: "estimate", currency: "USD" },
	{ id: "monthlyDelta/estimate/below-the-half-rounds-down", amount: 12.49, style: "estimate", currency: "USD" },
	{ id: "monthlyDelta/estimate/half-a-unit-rounds-UP-to-a-signed-one", amount: 0.5, style: "estimate", currency: "USD" },
	{ id: "monthlyDelta/estimate/A-SUB-UNIT-INCREASE-ROUNDS-TO-NO-CHANGE", amount: 0.4, style: "estimate", currency: "USD" },
	{ id: "monthlyDelta/estimate/A-SUB-UNIT-SAVING-ROUNDS-TO-NO-CHANGE", amount: -0.4, style: "estimate", currency: "USD" },
	{ id: "monthlyDelta/exact/the-same-sub-unit-change-KEEPS-ITS-CENTS", amount: 0.4, style: "exact", currency: "USD" },
	{ id: "monthlyDelta/exact/the-same-sub-unit-saving-KEEPS-ITS-CENTS", amount: -0.4, style: "exact", currency: "USD" },
	{ id: "monthlyDelta/exact/A-SUB-CENT-CHANGE-ROUNDS-TO-NO-CHANGE", amount: 0.001, style: "exact", currency: "USD" },
	{ id: "monthlyDelta/estimate/thousands-separator", amount: 1240.37, style: "estimate", currency: "USD" },
	{ id: "monthlyDelta/exact/thousands-separator-on-a-saving", amount: -1240.37, style: "exact", currency: "USD" },
	{ id: "monthlyDelta/estimate/JPY-HAS-NO-MINOR-UNIT", amount: -1240, style: "estimate", currency: "JPY" },
	{ id: "monthlyDelta/exact/JPY-HALF-ROUNDS-AWAY-FROM-ZERO", amount: 12.5, style: "exact", currency: "JPY" },
	{ id: "monthlyDelta/estimate/EUR-NARROW-SYMBOL", amount: 12.5, style: "estimate", currency: "EUR" },
	{ id: "monthlyDelta/exact/EUR-SIGN-LEADS-THE-SYMBOL", amount: -12.5, style: "exact", currency: "EUR" },

	// ── The binary-scale block (#3895). Three decimals, so the two languages can differ at all.
	//
	// 8.165 and 1.005 both scale to a double just BELOW the half (816.4999999999999,
	// 100.49999999999999), so a multiply-first rounder rounds down and a decimal rounder rounds up.
	// Both signs, because the sign is applied to the magnitude and a rounder that special-cases
	// negatives would pass the positive rows alone. Both registers, because the exact register is
	// where they diverged and the estimate register is what proves the fix did not break the one
	// that already agreed — its scale is 1, so these must still land on plain whole units.
	{ id: "monthlyDelta/exact/BINARY-SCALE-8.165-ROUNDS-DOWN", amount: 8.165, style: "exact", currency: "USD" },
	{ id: "monthlyDelta/exact/BINARY-SCALE-8.165-ROUNDS-DOWN-A-SAVING-TOO", amount: -8.165, style: "exact", currency: "USD" },
	{ id: "monthlyDelta/exact/BINARY-SCALE-1.005-ROUNDS-DOWN", amount: 1.005, style: "exact", currency: "USD" },
	{ id: "monthlyDelta/exact/BINARY-SCALE-1.005-ROUNDS-DOWN-A-SAVING-TOO", amount: -1.005, style: "exact", currency: "USD" },
	{ id: "monthlyDelta/estimate/BINARY-SCALE-8.165-AT-WHOLE-UNITS", amount: 8.165, style: "estimate", currency: "USD" },
	{ id: "monthlyDelta/estimate/BINARY-SCALE-8.165-AT-WHOLE-UNITS-A-SAVING-TOO", amount: -8.165, style: "estimate", currency: "USD" },
	{ id: "monthlyDelta/estimate/BINARY-SCALE-1.005-AT-WHOLE-UNITS", amount: 1.005, style: "estimate", currency: "USD" },
	{ id: "monthlyDelta/estimate/BINARY-SCALE-1.005-AT-WHOLE-UNITS-A-SAVING-TOO", amount: -1.005, style: "estimate", currency: "USD" },

	// The other half of the same rule: the pre-round must happen at the places the row is PRINTED
	// at, not at a fixed two. 12.496 rounds to 12.50 at cents and then to 13 at whole units, but Go
	// rounds once and says 12. These two rows fail against a pre-round hardcoded to `* 100` — the
	// obvious spelling, and the one that trades this divergence for a new one at every
	// zero-decimal register: `estimate` in any currency, and `exact` in JPY.
	{ id: "monthlyDelta/estimate/DOUBLE-ROUNDING-12.496-IS-NOT-A-HALF", amount: 12.496, style: "estimate", currency: "USD" },
	{ id: "monthlyDelta/exact/DOUBLE-ROUNDING-12.496-IS-NOT-A-HALF-AT-JPY", amount: 12.496, style: "exact", currency: "JPY" },
];

/**
 * Functions deliberately NOT in the table, with the reason. An absence with a stated reason is
 * reviewable; a silent gap is not, and the generator asserts this list plus the table covers
 * every export of the package.
 */
export const EXCLUDED: Record<string, string> = {
	formatRelative:
		"Mirroring this in Go means reimplementing date-fns's formatDistance ladder ('less than a " +
		"minute ago', 'about 1 hour ago', 'almost 2 years ago') and pinning to a date-fns MAJOR. " +
		"A user seeing $12/mo in the CLI and $12.50/mo on the billing page concludes the product is " +
		"lying about money; a user seeing '1 hour ago' and 'about 1 hour ago' will not hold both at " +
		"once. The CLI keeps go-humanize. Revisit if relative time ever appears in a receipt or an " +
		"invoice, where the two surfaces are read side by side.",
};
