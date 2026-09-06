// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
	formatBytes,
	formatDate,
	formatDuration,
	formatMinutes,
	formatQuota,
	formatMoney,
	formatMonthlyDelta,
	formatMonthlyRate,
	formatRelative,
	stripeChargeDivisor,
} from "../src/index";

describe("formatMinutes", () => {
	// The reported bug, verbatim: the org overview rendered `0.943 / 200 min` because
	// queryJobMinutesByOrg returns unrounded fractional minutes and the readout called
	// .toLocaleString(), which defaults to three fraction digits.
	it("renders the reported 0.943 as `<1 min`, not `0.943`", () => {
		expect(formatMinutes(0.943)).toBe("<1 min");
	});

	it("distinguishes NOTHING RAN from A LITTLE RAN", () => {
		// These must differ. Rounding 0.4 to `0 min` was the other half of the bug: it made a
		// job that ran look like a job that never did.
		expect(formatMinutes(0)).toBe("0 min");
		expect(formatMinutes(0.4)).toBe("<1 min");
		expect(formatMinutes(0)).not.toBe(formatMinutes(0.4));
	});

	it("rounds to whole minutes below an hour", () => {
		expect(formatMinutes(1)).toBe("1 min");
		expect(formatMinutes(3.2)).toBe("3 min");
		expect(formatMinutes(3.6)).toBe("4 min");
		expect(formatMinutes(59)).toBe("59 min");
	});

	// The boundary the "round once, before the hour test" rule exists for. 59.6 rounds to 60,
	// and 60 minutes IS an hour — so `1h` is right and `59 min` would be a lie. Rounding inside
	// each branch instead would let the same value print `1h 0m` here and `60 min` elsewhere.
	it("rounds once, so a value cannot land on both sides of the hour", () => {
		expect(formatMinutes(59.4)).toBe("59 min");
		expect(formatMinutes(59.6)).toBe("1h");
		expect(formatMinutes(60)).toBe("1h");
	});

	it("drops a zero remainder rather than printing `1h 0m`", () => {
		expect(formatMinutes(60)).toBe("1h");
		expect(formatMinutes(120)).toBe("2h");
		expect(formatMinutes(135)).toBe("2h 15m");
		expect(formatMinutes(1500)).toBe("25h");
	});

	it("clamps nonsense instead of rendering it", () => {
		expect(formatMinutes(-5)).toBe("0 min");
		expect(formatMinutes(Number.NaN)).toBe("0 min");
		expect(formatMinutes(Number.POSITIVE_INFINITY)).toBe("0 min");
	});
});

describe("formatQuota", () => {
	// This exists because formatMinutes alone did not make the call sites agree — and they
	// immediately did not. Two independent migrations produced `<1 min / 200 min` and
	// `12 min / 3h 20m` from the same helper, which is the original bug one layer up.
	it("humanises the USED side and leaves the allowance recognisable", () => {
		expect(formatQuota(0.943, 200)).toBe("<1 min / 200 min");
		expect(formatQuota(12, 200)).toBe("12 min / 200 min");
		expect(formatQuota(135, 200)).toBe("2h 15m / 200 min");
	});

	// 200 is the number the plan and the pricing page quote. `3h 20m` is arithmetically the
	// same and unrecognisable to someone checking whether they are near their limit.
	it("never converts the allowance to hours", () => {
		expect(formatQuota(1, 200)).not.toContain("3h");
		expect(formatQuota(1, 20_000)).toBe("1 min / 20,000 min");
	});

	it("survives the states a fresh org and a broken row actually produce", () => {
		expect(formatQuota(0, 200)).toBe("0 min / 200 min");
		expect(formatQuota(0, 0)).toBe("0 min / 0 min");
		expect(formatQuota(Number.NaN, 200)).toBe("0 min / 200 min");
		expect(formatQuota(5, Number.NaN)).toBe("5 min / 0 min");
	});

	it("renders over-quota rather than clamping — the overage is the point", () => {
		expect(formatQuota(250, 200)).toBe("4h 10m / 200 min");
	});
});

describe("formatDuration", () => {
	// RENAMED from "matches the implementation it replaces", which is now false and was the whole
	// point: it no longer matches. The console's shape is the one that lost.
	it("reads seconds, then minutes, then rolls into hours", () => {
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(72_000)).toBe("1m 12s");
		expect(formatDuration(59_999)).toBe("59s");
		// The ruling, asserted in THIS package. Without these the hour behaviour is covered only by
		// the console app's test tree, so packages/format could be changed without its own suite
		// noticing — which is the wrong way round for the package that owns the rule.
		expect(formatDuration(3_599_999)).toBe("59m 59s");
		expect(formatDuration(3_600_000)).toBe("1h 0m");
		expect(formatDuration(7_200_000)).toBe("2h 0m");
		expect(formatDuration(7_505_000)).toBe("2h 5m");
		expect(formatDuration(60_000)).toBe("1m 0s");
	});

	it("clamps nonsense", () => {
		expect(formatDuration(0)).toBe("0s");
		expect(formatDuration(-1)).toBe("0s");
		expect(formatDuration(Number.NaN)).toBe("0s");
	});
});

describe("formatDate", () => {
	const iso = "2026-08-27T14:05:00.000Z";

	it("renders each style", () => {
		expect(formatDate(iso)).toBe("27 Aug 2026");
		expect(formatDate(iso, "month")).toBe("August 2026");
		expect(formatDate(iso, "datetime")).toMatch(/^27 Aug 2026, \d{2}:\d{2}$/);
		expect(formatDate(iso, "time")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
	});

	// The log gutter's shape: seconds, no date, and 24-hour. Pinned to a zone because the whole
	// point of the assertion is the DIGITS, and without one they follow whoever runs the suite.
	it("renders `time` as a 24-hour log timestamp", () => {
		expect(formatDate(iso, "time", "UTC")).toBe("14:05:00");
		// `hourCycle: "h23"` rather than `hour12: false`, which renders midnight as 24:00:00 in
		// some locales. This is the case that distinguishes them.
		expect(formatDate("2026-08-27T00:04:09.000Z", "time", "UTC")).toBe("00:04:09");
	});

	it("accepts every input shape the call sites use", () => {
		expect(formatDate(new Date(iso))).toBe("27 Aug 2026");
		expect(formatDate(Date.parse(iso))).toBe("27 Aug 2026");
	});

	// A table cell showing "Invalid Date" is worse than an obvious blank.
	it("returns an em dash rather than Invalid Date", () => {
		for (const bad of [null, undefined, "", "not-a-date"]) {
			expect(formatDate(bad)).toBe("—");
		}
	});
});

describe("formatRelative", () => {
	const now = new Date("2026-08-27T12:00:00.000Z");

	it("reads in both directions from an injected baseline", () => {
		expect(formatRelative("2026-08-27T11:57:00.000Z", now)).toBe("3 minutes ago");
		expect(formatRelative("2026-08-27T12:03:00.000Z", now)).toBe("in 3 minutes");
	});

	it("returns an em dash for unparseable input", () => {
		expect(formatRelative(null, now)).toBe("—");
		expect(formatRelative("nope", now)).toBe("—");
	});

	// Guards the signature rather than the wording: without an explicit baseline this would be
	// untestable except by faking the global clock, which is what the old call sites did.
	it("falls back to the real clock when no baseline is given", () => {
		expect(formatRelative(new Date())).toMatch(/ago|in /);
	});
});

describe("formatBytes", () => {
	it("steps by 1024 and keeps one decimal only above bytes", () => {
		expect(formatBytes(812)).toBe("812 B");
		expect(formatBytes(1024)).toBe("1 KB");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(1_500_000)).toBe("1.4 MB");
	});

	it("stops at the largest unit it knows", () => {
		expect(formatBytes(1024 ** 5)).toBe("1 PB");
		expect(formatBytes(1024 ** 6)).toBe("1024 PB");
	});

	it("clamps nonsense", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(-1)).toBe("0 B");
		expect(formatBytes(Number.NaN)).toBe("0 B");
	});
});

describe("formatMoney", () => {
	// The signature says cents because every bug here starts with 12.5 passed for 1250.
	it("treats its input as MINOR units", () => {
		expect(formatMoney(1250)).toBe("$12.50");
		expect(formatMoney(0)).toBe("$0.00");
		expect(formatMoney(99)).toBe("$0.99");
	});

	it("honours a currency", () => {
		expect(formatMoney(1250, "EUR")).toBe("€12.50");
	});

	it("does not render NaN into a billing table", () => {
		expect(formatMoney(Number.NaN)).toBe("$0.00");
	});

	// ── #3581 ────────────────────────────────────────────────────────────────────────────────
	// The `/ 100` used to be unconditional. Everything below is also pinned in the conformance
	// table EXCEPT the HUF case, which cannot be — see it for why.

	it("does NOT divide a zero-decimal currency: the minor unit IS the unit", () => {
		// The issue's own example. This rendered `¥1,240` for a ¥124,000 invoice.
		expect(formatMoney(124000, "JPY")).toBe("¥124,000");
		// And not only JPY. Stripe publishes fifteen more.
		expect(formatMoney(124000, "KRW")).toBe("₩124,000");
	});

	it("still divides what Stripe documents as two-decimal FOR CHARGES, whatever CLDR prints", () => {
		// "to charge 5 ISK, provide an `amount` value of `500`" — while CLDR prints ISK with no
		// fraction digits at all. Both are true, of different questions. Reading the divisor off
		// CLDR renders `kr 500` here, which is the same defect as JPY's pointing the other way.
		expect(formatMoney(500, "ISK")).toBe("kr\u00a05");
		// UGX is the one that also catches a table transcribed from Stripe's zero-decimal LIST: it
		// is IN that list and ALSO in the Special cases table saying to send two-decimal amounts.
		expect(formatMoney(500, "UGX")).toBe("UGX\u00a05");
	});

	it("does not read the divisor off the symbol — CLP and TWD share one and not the other", () => {
		expect(formatMoney(124000, "CLP")).toBe("$124,000");
		expect(formatMoney(124000, "TWD")).toBe("$1,240.00");
	});

	// HUF IS PINNED HERE AND NOWHERE ELSE, and the assertion is deliberately loose about the
	// decimals. CLDR's display digits for HUF moved from 2 to 0 between ICU 75.1 (Node 20) and
	// ICU 78.3 (Node 24), so `Ft 1,240.00` and `Ft 1,240` are the same correct answer on two
	// runners. What must not move is the NUMBER: `Ft 124,000` is the inverted defect, and it is
	// what a CLDR-derived divisor produces. Asserting the whole string instead would make this a
	// report on whichever Node `actions/setup-node` resolved that morning.
	it("divides HUF, whose CLDR display digits are not stable across ICU versions", () => {
		expect(formatMoney(124000, "HUF")).toMatch(/^Ft\u00a01,240(\.00)?$/);
		expect(stripeChargeDivisor("HUF")).toBe(100);
	});
});

describe("stripeChargeDivisor", () => {
	// The whole set, not a sample: the conformance table pins six of these fifteen, so without this
	// a currency could be dropped from the table in `minor-units.ts` with every layer green.
	it("carries Stripe's published zero-decimal set", () => {
		const zeroDecimal = ["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "VND", "VUV", "XAF", "XOF", "XPF"];
		expect(zeroDecimal.map(stripeChargeDivisor)).toEqual(zeroDecimal.map(() => 1));
	});

	// THE ROW THIS FILE EXISTS FOR. UGX is published in Stripe's zero-decimal list, so the obvious
	// implementation — transcribe the list — answers 1 and renders every UGX invoice 100x
	// overstated. The Special cases table on the same page says otherwise, and it is about charges.
	it("EXCLUDES UGX, which Stripe publishes in that list and contradicts in Special cases", () => {
		expect(stripeChargeDivisor("UGX")).toBe(100);
	});

	// And the mirror trap: HUF and TWD appear in Special cases too, for PAYOUTS, so a reader
	// excluding everything the page calls zero-decimal drops them for a reason that does not apply.
	it("keeps the ordinary divisor for the payout-only special cases", () => {
		expect(stripeChargeDivisor("HUF")).toBe(100);
		expect(stripeChargeDivisor("TWD")).toBe(100);
		expect(stripeChargeDivisor("ISK")).toBe(100);
	});

	// `invoices.currency` mirrors Stripe verbatim and Stripe quotes currencies lowercase; the
	// console call sites upper-case first. Both spellings reach this function in practice.
	it("is case-insensitive", () => {
		expect(stripeChargeDivisor("jpy")).toBe(1);
		expect(stripeChargeDivisor("Jpy")).toBe(1);
	});

	// Two decimals is the right refusal for something unrecognised: it renders 100x too SMALL,
	// which is visibly absurd, where a guessed 1 renders 100x too LARGE and reads as a real bill.
	it("answers 100 for an unknown code rather than guessing 1", () => {
		expect(stripeChargeDivisor("ZZZ")).toBe(100);
		expect(stripeChargeDivisor("")).toBe(100);
		// Three-decimal currencies are NOT in the table — Stripe publishes no list to cite — so
		// they take this default. Stated as a test so the gap is recorded rather than assumed.
		expect(stripeChargeDivisor("BHD")).toBe(100);
	});
});

describe("formatMonthlyRate", () => {
	// The unit split is the whole reason this is a second function. Same money, both spellings.
	it("takes MAJOR units, where formatMoney takes minor", () => {
		expect(formatMonthlyRate(12.5)).toBe("$12.50/mo");
		expect(formatMoney(1250)).toBe("$12.50");
	});

	// THE REGRESSION TEST. The first cut dropped cents above $100, which broke the one property a
	// cost breakdown must have: the lines add up to the total printed under them. These are the
	// real numbers from plan-tab's cost result.
	it("keeps a breakdown's lines summing to its own total, at every magnitude", () => {
		const lines = [60.25, 45.1];
		expect(lines.map((n) => formatMonthlyRate(n, "exact"))).toEqual(["$60.25/mo", "$45.10/mo"]);
		expect(formatMonthlyRate(105.35, "exact")).toBe("$105.35/mo");
	});

	// Two canvas node cards side by side rendered the same field at two precisions. There is no
	// magnitude at which the precision may change, in EITHER register.
	it("never changes precision with magnitude", () => {
		expect(formatMonthlyRate(99.99)).toBe("$99.99/mo");
		expect(formatMonthlyRate(100)).toBe("$100.00/mo");
		expect(formatMonthlyRate(1240.37)).toBe("$1,240.37/mo");
		expect(formatMonthlyRate(99.99, "exact")).toBe("$99.99/mo");
		expect(formatMonthlyRate(100, "exact")).toBe("$100.00/mo");
		expect(formatMonthlyRate(1240.37, "exact")).toBe("$1,240.37/mo");
	});

	// The Cost tab lists one row per Terraform address, and sub-$1 cloud line items (hosted zones,
	// buckets, small volumes) are the common case. Five `<$1/mo` rows over a `$2.00/mo` total is a
	// breakdown that cannot be reconciled at all.
	it("does not collapse a sub-unit LINE ITEM, which the reader is adding up", () => {
		expect(formatMonthlyRate(0.5, "exact")).toBe("$0.50/mo");
		expect(formatMonthlyRate(0.03, "exact")).toBe("$0.03/mo");
		expect(formatMonthlyRate(0.4, "exact")).toBe("$0.40/mo");
	});

	// The boundary where the two registers would disagree if the value were rounded inside each
	// branch instead of once, before them.
	it("rounds to cents ONCE, before the sub-unit test", () => {
		expect(formatMonthlyRate(0.999)).toBe("$1.00/mo");
		expect(formatMonthlyRate(0.999, "exact")).toBe("$1.00/mo");
	});

	// `$0.02/mo` for a WHOLE PROJECT reads as a broken number, not a cheap one; `<$1/mo` is the
	// same admission formatMinutes makes with `<1 min`. That argument is about a lone headline.
	it("admits a sub-unit ESTIMATE rather than printing a figure it cannot stand behind", () => {
		expect(formatMonthlyRate(0.023)).toBe("<$1/mo");
		// Rounds to zero cents but is NOT zero — "nothing is running" would be a lie.
		expect(formatMonthlyRate(0.001)).toBe("<$1/mo");
	});

	// Nothing provisioned is a real, distinct state, and `$0.00/mo` reads like a bill for nothing
	// — in a headline. In a column of line items a genuine zero has to align with its neighbours.
	it("distinguishes NOTHING from A LITTLE, and only in the headline register", () => {
		expect(formatMonthlyRate(0)).toBe("$0/mo");
		expect(formatMonthlyRate(Number.NaN)).toBe("$0/mo");
		expect(formatMonthlyRate(Number.POSITIVE_INFINITY)).toBe("$0/mo");
		expect(formatMonthlyRate(0, "exact")).toBe("$0.00/mo");
		expect(formatMonthlyRate(Number.NaN, "exact")).toBe("$0.00/mo");
	});

	// Split out from the zero case above so that nobody reads a clamped negative as "nothing
	// provisioned". `<= 0` is ONE test, so a saving renders exactly as zero does in BOTH registers,
	// including the one that promises to round nothing away.
	//
	// This used to be a pinned GAP. It is now a pinned REFUSAL, and only the second half of that
	// sentence changed: the rows are the same, and `formatMonthlyDelta` is what makes them mean
	// something. `formatMonthlyRate` renders an ABSOLUTE cost; declining a delta is not a defect in
	// it, and `"exact"` is still not a credit register. The last assertion is the one that states
	// the split rather than the clamp — same input, two functions, two answers — so a change that
	// made `formatMonthlyRate` signed would fail HERE rather than only in the conformance table.
	it("REFUSES A SIGNED AMOUNT: a negative clamps in both registers, and formatMonthlyDelta is where it goes", () => {
		expect(formatMonthlyRate(-1)).toBe("$0/mo");
		expect(formatMonthlyRate(-1, "exact")).toBe("$0.00/mo");
		expect(formatMonthlyRate(-1240.37, "exact")).toBe("$0.00/mo");
		expect(formatMonthlyRate(-12.5, "exact", "EUR")).toBe("€0.00/mo");
		expect(formatMonthlyRate(Number.NEGATIVE_INFINITY, "exact")).toBe("$0.00/mo");

		expect(formatMonthlyDelta(-1, "exact")).toBe("-$1.00/mo");
		expect(formatMonthlyDelta(-1, "exact")).not.toBe(formatMonthlyRate(-1, "exact"));
	});

	// The runner fleet prices in euros. One symbol decision, shared with formatMoney.
	it("honours a currency in every branch of both registers", () => {
		expect(formatMonthlyRate(12.5, "estimate", "EUR")).toBe("€12.50/mo");
		expect(formatMonthlyRate(0, "estimate", "EUR")).toBe("€0/mo");
		expect(formatMonthlyRate(0.4, "estimate", "EUR")).toBe("<€1/mo");
		expect(formatMonthlyRate(1240, "estimate", "EUR")).toBe("€1,240.00/mo");
		expect(formatMonthlyRate(0.4, "exact", "EUR")).toBe("€0.40/mo");
		expect(formatMonthlyRate(0, "exact", "EUR")).toBe("€0.00/mo");
	});
});

describe("formatMonthlyDelta", () => {
	// The whole reason this function exists, in one assertion pair. The ruling on #3768 rejected
	// making formatMonthlyRate signed — that would have let every absolute call site render a
	// negative it has no meaning for — and rejected `$5.00/mo saved`, which is a sentence rather
	// than a number: it does not sum, does not right-align, and needs a translation story.
	it("KEEPS THE SIGN in both directions, where formatMonthlyRate loses it", () => {
		expect(formatMonthlyDelta(-5, "exact")).toBe("-$5.00/mo");
		expect(formatMonthlyDelta(12.5, "exact")).toBe("+$12.50/mo");
		expect(formatMonthlyRate(-5, "exact")).toBe("$0.00/mo");
	});

	// `$-5.00` is not a form anyone writes. Intl's narrowSymbol puts the minus first and
	// packages/core/format's `render` mirrors it, so the leading sign is the house rule rather
	// than a choice made here. Asserted on the CHARACTER, because "contains a minus" passes for
	// `$-5.00` too.
	it("puts the sign BEFORE the currency symbol, not between it and the digits", () => {
		expect(formatMonthlyDelta(-5, "exact")).toMatch(/^-\$/);
		expect(formatMonthlyDelta(5, "exact")).toMatch(/^\+\$/);
		expect(formatMonthlyDelta(-12.5, "exact", "EUR")).toBe("-€12.50/mo");
		expect(formatMonthlyDelta(-12.5, "exact")).not.toContain("$-");
	});

	// `+$0/mo` reads as an increase that did not happen. And the exact register drops the minor
	// units here, where formatMonthlyRate keeps them: `$0.00/mo` pads so a column of LEVELS aligns
	// under its total, and "no change" is not a level.
	it("gives ZERO no sign, in either register, and no minor units either", () => {
		expect(formatMonthlyDelta(0)).toBe("$0/mo");
		expect(formatMonthlyDelta(0, "exact")).toBe("$0/mo");
		expect(formatMonthlyRate(0, "exact")).toBe("$0.00/mo");
	});

	// The same rule, reached by the other route, and the one a plausible implementation gets
	// wrong: decide the sign on the RAW amount and these render `+$0/mo` and `+$0.00/mo`.
	it("gives a change that ROUNDS to zero no sign either, which is the same rule", () => {
		expect(formatMonthlyDelta(0.4)).toBe("$0/mo");
		expect(formatMonthlyDelta(-0.4)).toBe("$0/mo");
		expect(formatMonthlyDelta(0.001, "exact")).toBe("$0/mo");
		expect(formatMonthlyDelta(-0.001, "exact")).toBe("$0/mo");
		// ...and it is genuinely the rounded magnitude doing it, not a hardcoded sub-unit branch:
		// half a unit rounds UP and the sign comes back.
		expect(formatMonthlyDelta(0.5)).toBe("+$1/mo");
	});

	// There is NO `<$1/mo` here, deliberately. formatMonthlyRate's admission protects a claim about
	// a LEVEL, where "free" is a category the reader would wrongly conclude; "no change worth
	// showing" is a true reading of a delta that rounds to nothing. And `-<$1/mo` would put the
	// sign and the `<` in competition for the leading position.
	it("does NOT borrow formatMonthlyRate's `<$1/mo` admission", () => {
		expect(formatMonthlyDelta(0.023)).not.toContain("<");
		expect(formatMonthlyDelta(-0.023)).not.toContain("<");
		expect(formatMonthlyRate(0.023)).toBe("<$1/mo");
	});

	// Unlike formatMonthlyRate, the two registers here differ in PRECISION. Same input, one pair.
	it("reads its two registers as whole units versus minor units", () => {
		expect(formatMonthlyDelta(0.4, "estimate")).toBe("$0/mo");
		expect(formatMonthlyDelta(0.4, "exact")).toBe("+$0.40/mo");
		expect(formatMonthlyDelta(12.5, "estimate")).toBe("+$13/mo");
		expect(formatMonthlyDelta(12.5, "exact")).toBe("+$12.50/mo");
	});

	// The defect this package was built to end: Go's %.0f rounds half to EVEN and renders 12, JS
	// rounds half away from zero and renders 13. Pinned in BOTH directions, because half-to-even
	// and half-toward-zero disagree with this on different inputs.
	it("rounds the MAGNITUDE half away from zero, in both directions", () => {
		expect(formatMonthlyDelta(12.5)).toBe("+$13/mo");
		expect(formatMonthlyDelta(-12.5)).toBe("-$13/mo");
		expect(formatMonthlyDelta(13.5)).toBe("+$14/mo");
		expect(formatMonthlyDelta(12.49)).toBe("+$12/mo");
	});

	// A non-finite delta is "no change", not "NaN more per month". Same clamp every formatter here
	// makes, and it must not acquire a sign on the way.
	it("does not render NaN or Infinity into a cost summary", () => {
		expect(formatMonthlyDelta(Number.NaN)).toBe("$0/mo");
		expect(formatMonthlyDelta(Number.NaN, "exact")).toBe("$0/mo");
		expect(formatMonthlyDelta(Number.POSITIVE_INFINITY)).toBe("$0/mo");
		expect(formatMonthlyDelta(Number.NEGATIVE_INFINITY, "exact")).toBe("$0/mo");
	});

	// One symbol decision, shared with formatMoney and formatMonthlyRate, and it has to survive
	// every branch — including a currency whose minor unit does not exist, where the two registers
	// therefore give the same answer.
	it("honours a currency in every branch of both registers", () => {
		expect(formatMonthlyDelta(12.5, "estimate", "EUR")).toBe("+€13/mo");
		expect(formatMonthlyDelta(-12.5, "exact", "EUR")).toBe("-€12.50/mo");
		expect(formatMonthlyDelta(0, "estimate", "EUR")).toBe("€0/mo");
		expect(formatMonthlyDelta(0.4, "estimate", "EUR")).toBe("€0/mo");
		expect(formatMonthlyDelta(1240.37, "exact", "EUR")).toBe("+€1,240.37/mo");
		expect(formatMonthlyDelta(12.5, "estimate", "JPY")).toBe("+¥13/mo");
		expect(formatMonthlyDelta(12.5, "exact", "JPY")).toBe("+¥13/mo");
	});
});
