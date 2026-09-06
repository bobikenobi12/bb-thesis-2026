// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How many minor units a CHARGE is quoted in — the divisor, and only the divisor.
 *
 * This is a separate module from `index.ts` for one reason: the money functions there already
 * ask a question that LOOKS like this one and is not it. `minorUnits()` in that file asks how
 * many fraction digits a currency PRINTS, and it asks CLDR, because display is what CLDR is the
 * authority for. This file asks how many minor units a Stripe `amount` is expressed in, and its
 * authority is the payment processor. Keeping them in one place is precisely how #3581 was
 * created and then nearly "fixed" a second time, in the opposite direction.
 *
 * ── THE TWO AUTHORITIES DISAGREE, and here is where ──────────────────────────────────────────
 *
 * Stripe enumerates a zero-decimal set — "for the following zero-decimal currencies, the charge
 * and the amount are the same, without requiring multiplication. For example, to charge 500 JPY,
 * provide an `amount` value of `500`" — and then a Special cases table that CONTRADICTS it for
 * two of its own members. Verbatim, from https://docs.stripe.com/currencies (fetched 2026-09-03):
 *
 *   ISK — "ISK transitioned to a zero-decimal currency, but backward compatibility requires you
 *          to represent it as a two-decimal value, where the decimal amount is always `00`. For
 *          example, to charge 5 ISK, provide an `amount` value of `500`."
 *   UGX — "UGX transitioned to a zero-decimal currency, but backwards compatibility requires you
 *          to represent it as a two-decimal value, where the decimal amount is always `00`. For
 *          example, to charge 5 UGX, provide an `amount` value of `500`."
 *   HUF — "Stripe treats HUF as a zero-decimal currency for payouts, even though you can charge
 *          two-decimal amounts."
 *   TWD — "Stripe treats TWD as a zero-decimal currency for payouts, even though you can charge
 *          two-decimal amounts."
 *
 * So the four currencies most likely to be reached for as evidence each answer DIFFERENTLY
 * depending on which question you asked:
 *
 *   | code | in Stripe's zero-decimal list | CHARGE divisor | CLDR display digits |
 *   |------|-------------------------------|----------------|---------------------|
 *   | JPY  | yes                           | 1              | 0                   |
 *   | UGX  | YES                           | 100            | 0                   |
 *   | ISK  | no                            | 100            | 0                   |
 *   | HUF  | no                            | 100            | 0 or 2, see below   |
 *   | TWD  | no                            | 100            | 2                   |
 *
 * UGX IS THE ROW THAT MATTERS. It appears in Stripe's own zero-decimal list AND in the Special
 * cases table saying to send two-decimal amounts for a charge. A table built by transcribing the
 * list — the obvious implementation, and the one this file exists to not be — renders every UGX
 * invoice 100x OVERSTATED. The Special cases wording wins here because it is the more specific
 * statement and it is about CHARGES, which is the only context `formatMoney` is ever handed.
 *
 * HUF and TWD are the mirror trap: their Special cases entries are about PAYOUTS, and a reader
 * skimming for "zero-decimal" finds the phrase in both and excludes them. Their charge divisor is
 * the ordinary 100, and they are absent below for that reason rather than by omission.
 *
 * ── WHAT THIS TABLE DOES NOT COVER ───────────────────────────────────────────────────────────
 *
 * Three-decimal currencies (BHD, JOD, KWD, OMR, TND). Stripe's `/currencies` page still names
 * "three-decimal currency support" in its own meta description but no longer enumerates a
 * three-decimal list anywhere in its body, so there is no primary source to cite for a divisor of
 * 1000 and none is asserted here — they fall to the two-decimal default. CLDR does print three
 * fraction digits for them, so `formatMoney(1240, "BHD")` renders `BHD 12.400` today. That is a
 * DIFFERENT defect from #3581, it is unreachable for the same reason (see `formatMoney`), and
 * inventing a divisor for it out of memory is exactly the move that produced the CLDR "fix".
 */

/**
 * The currencies whose Stripe `amount` is already in major units, so a charge amount must NOT be
 * divided. Sorted, ISO 4217, upper case.
 *
 * Transcribed from the `ZeroDecimalCurrencies` list published at https://docs.stripe.com/currencies
 * (fetched 2026-09-03) — BIF, CLP, DJF, GNF, JPY, KMF, KRW, MGA, PYG, RWF, UGX, VND, VUV, XAF,
 * XOF, XPF — MINUS UGX, which that same page's Special cases table documents as two-decimal for
 * charges. Sixteen published, fifteen here, and the missing one is the whole point; see the module
 * doc above before adding it back.
 *
 * ── WHY THIS IS EXPORTED, AND WHY IT IS AN ARRAY ─────────────────────────────────────────────
 *
 * `packages/core/format` (Go) carries the same fifteen codes in `stripeZeroDecimalCharge`, and
 * before #4123 NOTHING held the two lists together. The conformance table pins only the codes it
 * CONTAINS — JPY, KRW, ISK, UGX, CLP, TWD — so a sixteenth code added to one language changed
 * nothing any row measured, and each side's unit test enumerates its own hand-typed copy, so it
 * only ever caught a REMOVAL from the map beside it. Adding a row per currency would not have
 * closed that: it pins fifteen instead of six and leaves the identical hole for the sixteenth.
 * The axis the two implementations can differ on is set MEMBERSHIP, not per-currency rendering,
 * so membership itself is what crosses the boundary — published into
 * `conformance/format-cases.json` under `zeroDecimalCharge` and asserted from both sides.
 *
 * An array rather than the `Set`, because JSON has no set and a sorted list is a reviewable diff.
 *
 * THE ARRAY IS THE ONLY LITERAL. `ZERO_DECIMAL_CHARGE` below is built FROM it, so the list that
 * is published and the set `stripeChargeDivisor` consults cannot disagree — there is nothing to
 * keep in step. Exporting a second transcription for the generator to read would have reproduced,
 * one level up, the exact defect this export exists to close.
 */
export const STRIPE_ZERO_DECIMAL_CHARGE: readonly string[] = [
	"BIF",
	"CLP",
	"DJF",
	"GNF",
	"JPY",
	"KMF",
	"KRW",
	"MGA",
	"PYG",
	"RWF",
	"VND",
	"VUV",
	"XAF",
	"XOF",
	"XPF",
];

/** The lookup form of {@link STRIPE_ZERO_DECIMAL_CHARGE}. Derived, never transcribed. */
const ZERO_DECIMAL_CHARGE: ReadonlySet<string> = new Set(STRIPE_ZERO_DECIMAL_CHARGE);

/**
 * How many minor units one unit of `currency` is worth in a Stripe CHARGE amount: 1 for the
 * zero-decimal set, 100 for everything else.
 *
 * Returns a divisor rather than an exponent because a divisor is what the caller needs and an
 * exponent is one `10 **` away from being confused with `minorUnits()`'s display digits, which is
 * the confusion this module is named for.
 *
 * An unknown or malformed code answers 100. That is the right refusal: two decimals is correct for
 * the overwhelming majority of ISO 4217, and the failure it produces for a genuinely zero-decimal
 * code Stripe has not published is an amount rendered 100x too SMALL — visible as obviously wrong,
 * where the other direction (a made-up 1) renders 100x too LARGE and reads as a plausible bill.
 *
 * @param currency an ISO 4217 code, in any case.
 */
export function stripeChargeDivisor(currency: string): 1 | 100 {
	return ZERO_DECIMAL_CHARGE.has(currency.toUpperCase()) ? 1 : 100;
}
