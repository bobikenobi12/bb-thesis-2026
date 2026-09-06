// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The rules the conformance table CANNOT state, and which are therefore untested by it.
//
// The table is the contract between the two languages, so it can only carry behaviour both sides
// have. Three things here are outside that:
//
//   - The ISO-code fallback for a currency with no symbol. TypeScript delegates to Intl, which
//     knows every currency; Go carries a deliberate SHORT table (nine entries — USD, EUR, GBP,
//     JPY, KRW, CLP, TWD, ISK, UGX) and falls back for everything else. That is a RULING, not a
//     mirror, and a ruling with no test is a comment. Measured, so that nobody later adds the row
//     the table looks like it is missing: en-GB Intl renders CHF as `CHF\u00a012.50` — the ISO
//     code, PREFIXED, with a non-breaking space — where this file renders `12.50 CHF`; and for HUF
//     it finds a narrow symbol, `Ft 13`, which Go has no table for at all. A conformance row over
//     a currency OUTSIDE that table would freeze that disagreement rather than a contract, so both
//     MonthlyRate's fallback and MonthlyDelta's are asserted here instead.
//
//     THE BOUND IS THE TABLE, NOT A NUMBER. This said "four-entry" until the table was nine, which
//     read as an instruction to delete the ISK/UGX/CLP/TWD/KRW conformance rows that are perfectly
//     legitimate — every one of them is INSIDE currencySymbol. A hand-typed count beside a map is
//     a second source of truth for the map's size; the rule is "outside currencySymbol", and that
//     phrase stays right however the map grows.
//   - `Dash`, and the shapes that return it. The table's date section reaches the em dash through a
//     null date; nothing exercises the sentinel as a value other callers will use.
//   - Go-only input shapes: a zero time.Time, a negative time.Duration, an unknown DateStyle.
//
// Everything the table DOES state is asserted in conformance_test.go and must not be duplicated
// here — a second hand-written copy of a generated expectation is exactly the third source of truth
// the table exists to prevent.

package format

import (
	"strings"
	"testing"
	"time"
)

// The maintainer's ruling: render the ISO code, never error, never guess a symbol.
//
// The alternative considered and rejected was `(string, error)`. At a table cell the only answers to
// an error are a dash or ignoring it, and a dash loses the number — which is a worse outcome than an
// unfamiliar but correct `12.50 HUF`.
func TestMoneyFallsBackToTheISOCodeAndNeverGuessesASymbol(t *testing.T) {
	cases := map[string]struct {
		cents    float64
		currency string
		want     string
	}{
		"a currency with no symbol in the table": {1250, "HUF", "12.50 HUF"},
		"lowercase is still recognised":          {1250, "huf", "12.50 HUF"},
		"a known symbol still wins":              {1250, "USD", "$12.50"},
		"lowercase known symbol":                 {1250, "usd", "$12.50"},
		"the sign leads the code too":            {-1250, "HUF", "-12.50 HUF"},
		"grouping survives the fallback":         {124037000, "HUF", "1,240,370.00 HUF"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if got := Money(c.cents, c.currency); got != c.want {
				t.Errorf("Money(%v, %q) = %q, want %q", c.cents, c.currency, got, c.want)
			}
		})
	}

	// The property behind the ruling, stated as a property rather than a table: an unknown currency
	// must never borrow another currency's glyph.
	//
	// ISK, UGX and TWD USED TO BE IN THIS LIST and were moved out by #3581, which added them to
	// currencySymbol because the conformance table now pins them. Left here, TWD would have failed
	// outright — its narrow symbol is `$` — and ISK and UGX would have passed for the wrong reason.
	// A list of "the currencies we do not know" is a second source of truth for a map, and this is
	// what it costs.
	//
	// THE COMPARISON IS A PREFIX, NOT A BYTE, and the paragraph above is why: it used to be
	// `got[0:1]`, one byte against whole map values. `$` is the only single-byte entry in
	// currencySymbol, so as the map grew to nine the loop quietly narrowed to "did it borrow a
	// dollar sign" — a borrowed `¥`, `€`, `£`, `₩`, `kr ` or `UGX ` could not be
	// expressed as a failure at all. The comment named that defect and then kept it.
	for _, unknown := range []string{"HUF", "SEK", "ZZZ", ""} {
		got := Money(1250, unknown)
		for symbol := range currencySymbol {
			if strings.HasPrefix(got, currencySymbol[symbol]) {
				t.Errorf("Money(1250, %q) = %q — it borrowed the %s symbol; a guessed symbol on a billed amount is the failure this rule exists to prevent", unknown, got, symbol)
			}
		}
	}
}

// #3581. Money divided by 100 unconditionally, so every zero-decimal currency rendered at 1/100 of
// its value — a ¥124,000 invoice as `¥1,240`.
//
// The rows here are the ones the conformance table CANNOT carry, plus the property behind the
// table's rows. HUF is the important one: its CLDR display digits moved from 2 to 0 between ICU
// 75.1 and ICU 78.3, so `@repo/format` cannot state a stable rendering for it and no conformance
// row can exist — but Go renders HUF through the ISO fallback at a fixed two decimals, so the
// DIVISOR is still assertable exactly here, on the side that does not ask CLDR anything.
func TestMoneyDividesByStripesChargeMinorUnitsNotByCLDRs(t *testing.T) {
	cases := map[string]struct {
		cents    float64
		currency string
		want     string
	}{
		// The zero-decimal set: the amount IS the charge.
		"the issue's own example":               {124000, "JPY", "¥124,000"},
		"not only JPY":                          {124000, "KRW", "₩124,000"},
		"lowercase reaches the same table":      {124000, "jpy", "¥124,000"},
		"a zero-decimal currency with no glyph": {124000, "VND", "124,000.00 VND"},
		// Divided by 100 and printed with none: the two questions disagreeing, visibly.
		"Stripe says send 500 to charge 5 ISK": {500, "ISK", "kr\u00a05"},
		"and the same for UGX":                 {500, "UGX", "UGX\u00a05"},
		// The payout-only special cases keep the ordinary divisor.
		"HUF is two-decimal for a CHARGE":   {124000, "HUF", "1,240.00 HUF"},
		"TWD is two-decimal for a CHARGE":   {124000, "TWD", "$1,240.00"},
		"and TWD shares CLP's symbol":       {124000, "CLP", "$124,000"},
		"an unknown code is not guessed at": {124000, "ZZZ", "1,240.00 ZZZ"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if got := Money(c.cents, c.currency); got != c.want {
				t.Errorf("Money(%v, %q) = %q, want %q", c.cents, c.currency, got, c.want)
			}
		})
	}
}

// The divisor table itself, asserted against the two facts Stripe's page states that a transcription
// of its zero-decimal LIST alone would get wrong.
//
// UGX is published IN that list and ALSO in the Special cases table, which says to send two-decimal
// amounts for a charge. HUF and TWD are in Special cases for the opposite reason — their entries are
// about PAYOUTS — so a reader excluding everything the page calls "zero-decimal" drops them too.
func TestChargeDivisorFollowsTheSpecialCasesNotTheList(t *testing.T) {
	// Restating the whole set is the point: this is what stops a currency being dropped from
	// stripeZeroDecimalCharge with every conformance row still green, since the table pins six of
	// them and Stripe publishes fifteen.
	for _, c := range []string{"BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "VND", "VUV", "XAF", "XOF", "XPF"} {
		if got := chargeDivisorFor(c); got != 1 {
			t.Errorf("chargeDivisorFor(%q) = %v, want 1 — it is in Stripe's published zero-decimal list", c, got)
		}
	}
	for _, c := range []string{"UGX", "ISK", "HUF", "TWD", "USD", "EUR", "GBP", "BHD", "ZZZ", ""} {
		if got := chargeDivisorFor(c); got != 100 {
			t.Errorf("chargeDivisorFor(%q) = %v, want 100", c, got)
		}
	}
	// Case, because `invoices.currency` mirrors Stripe verbatim and Stripe quotes currencies in
	// lowercase, while every console call site upper-cases before it gets here. Both must work.
	if chargeDivisorFor("jpy") != chargeDivisorFor("JPY") {
		t.Error("chargeDivisorFor is case-sensitive; Stripe quotes currencies lowercase")
	}
}

// MonthlyRate's estimate register has to keep the ISO fallback too, including in the `<1` branch
// where the string is assembled differently.
func TestMonthlyRateKeepsTheFallbackInEveryBranch(t *testing.T) {
	cases := map[string]struct {
		amount   float64
		style    RateStyle
		currency string
		want     string
	}{
		"estimate, no symbol":               {12.5, Estimate, "HUF", "12.50 HUF/mo"},
		"exact, no symbol":                  {12.5, Exact, "HUF", "12.50 HUF/mo"},
		"the sub-unit branch, no symbol":    {0.02, Estimate, "HUF", "<1 HUF/mo"},
		"the zero branch, no symbol":        {0, Estimate, "HUF", "0 HUF/mo"},
		"the zero branch, exact, no symbol": {0, Exact, "HUF", "0.00 HUF/mo"},
		"a negative clamps, no symbol":      {-3, Estimate, "HUF", "0 HUF/mo"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if got := MonthlyRate(c.amount, c.style, c.currency); got != c.want {
				t.Errorf("MonthlyRate(%v, %q, %q) = %q, want %q", c.amount, c.style, c.currency, got, c.want)
			}
		})
	}

	// A style nobody defined must not silently render as an estimate. Exact is the safe default:
	// showing minor units where an estimate was wanted is cosmetic, while showing a rounded whole
	// number where an exact figure was wanted misstates money.
	if got := MonthlyRate(12.5, RateStyle("wat"), "USD"); got != "$12.50/mo" {
		t.Errorf("an unknown RateStyle rendered %q; it must not lose the minor units", got)
	}
	// ...and at ZERO too. This is where the first cut disagreed with itself: the zero branch tested
	// `== Exact` while the rest tested `== Estimate`, so an unknown style rendered `$12.50/mo` above
	// zero and `$0/mo` at zero — two registers from one call site, in a column of costs.
	if got := MonthlyRate(0, RateStyle("wat"), "USD"); got != "$0.00/mo" {
		t.Errorf("an unknown RateStyle at zero rendered %q, want %q — it must pick the same register as it does above zero", got, "$0.00/mo")
	}
}

// MonthlyDelta reaches the same fallback, through a different set of branches: it renders the
// magnitude and then leads it with a sign, so a fallback that only worked in `render`'s own
// negative branch would pass MonthlyRate's cases and fail here.
//
// The `<1` branch has no counterpart: MonthlyDelta deliberately has no `<1 HUF/mo`, because a
// change that rounds to nothing IS no change worth showing, while a COST that rounds to nothing
// would be misread as free. The `no change` rows below are what pin that.
func TestMonthlyDeltaKeepsTheFallbackInEveryBranch(t *testing.T) {
	cases := map[string]struct {
		amount   float64
		style    RateStyle
		currency string
		want     string
	}{
		"estimate, no symbol, an increase":  {12.5, Estimate, "HUF", "+13 HUF/mo"},
		"estimate, no symbol, a saving":     {-12.5, Estimate, "HUF", "-13 HUF/mo"},
		"exact, no symbol, an increase":     {12.5, Exact, "HUF", "+12.50 HUF/mo"},
		"exact, no symbol, a saving":        {-12.5, Exact, "HUF", "-12.50 HUF/mo"},
		"the zero branch, no symbol":        {0, Estimate, "HUF", "0 HUF/mo"},
		"the zero branch, exact, no symbol": {0, Exact, "HUF", "0 HUF/mo"},
		"rounds to no change, no symbol":    {0.4, Estimate, "HUF", "0 HUF/mo"},
		"lowercase is still recognised":     {-12.5, Exact, "huf", "-12.50 HUF/mo"},
		"grouping survives the fallback":    {-1240.37, Exact, "HUF", "-1,240.37 HUF/mo"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if got := MonthlyDelta(c.amount, c.style, c.currency); got != c.want {
				t.Errorf("MonthlyDelta(%v, %q, %q) = %q, want %q", c.amount, c.style, c.currency, got, c.want)
			}
		})
	}

	// An unknown style must pick Exact, the same ruling MonthlyRate follows and for the same
	// reason: whole units where minor units were wanted misstates money, and the reverse is
	// cosmetic. Asserted at zero as well, because that is where MonthlyRate's first cut asked the
	// question with the opposite polarity and handed one caller two registers.
	if got := MonthlyDelta(12.5, RateStyle("wat"), "USD"); got != "+$12.50/mo" {
		t.Errorf("an unknown RateStyle rendered %q; it must not lose the minor units", got)
	}
	if got := MonthlyDelta(0.4, RateStyle("wat"), "USD"); got != "+$0.40/mo" {
		t.Errorf("an unknown RateStyle at a sub-unit change rendered %q; it must not round to no change", got)
	}
	if got := MonthlyDelta(0, RateStyle("wat"), "USD"); got != "$0/mo" {
		t.Errorf("an unknown RateStyle at zero rendered %q, want %q", got, "$0/mo")
	}

	// The property behind the whole split, as a property rather than a table: MonthlyRate and
	// MonthlyDelta must never agree about a negative. If they do, one of them has been "fixed".
	for _, style := range []RateStyle{Estimate, Exact} {
		if MonthlyRate(-5, style, "USD") == MonthlyDelta(-5, style, "USD") {
			t.Errorf("MonthlyRate and MonthlyDelta agreed about -5 in the %q register (%q) — the clamp is a refusal, and the two registers exist so a caller cannot render a diff as an absolute by accident",
				style, MonthlyDelta(-5, style, "USD"))
		}
	}
}

// Go-only input shapes. The table cannot express a zero time.Time or a negative Duration, because
// TypeScript has neither.
func TestGoOnlyInputShapes(t *testing.T) {
	t.Run("a zero time is the sentinel, not year 1", func(t *testing.T) {
		if got := Date(time.Time{}, DateOnly, time.UTC); got != Dash {
			t.Errorf("Date(zero) = %q, want %q — `1 Jan 0001` in a table cell is worse than a blank", got, Dash)
		}
	})

	t.Run("an unknown style is the sentinel, never a wrong shape", func(t *testing.T) {
		real := time.Date(2026, 3, 9, 15, 4, 5, 0, time.UTC)
		if got := Date(real, DateStyle("fortnight"), time.UTC); got != Dash {
			t.Errorf("Date(_, unknown style) = %q, want %q — a caller that invents a style gets a blank, never a silently wrong shape", got, Dash)
		}
	})

	t.Run("a nil location is UTC, not the process default", func(t *testing.T) {
		real := time.Date(2026, 3, 9, 23, 30, 0, 0, time.UTC)
		if got := Date(real, DateOnly, nil); got != "9 Mar 2026" {
			t.Errorf("Date(_, _, nil) = %q, want %q — a nil zone must be deterministic, not ambient", got, "9 Mar 2026")
		}
	})

	t.Run("a negative duration is zero, not a negative string", func(t *testing.T) {
		if got := Duration(-5 * time.Second); got != "0s" {
			t.Errorf("Duration(-5s) = %q, want %q", got, "0s")
		}
	})

	t.Run("sub-second floors rather than rounding up", func(t *testing.T) {
		if got := Duration(999 * time.Millisecond); got != "0s" {
			t.Errorf("Duration(999ms) = %q, want %q — an elapsed span that has not reached a second has not reached a second", got, "0s")
		}
	})
}

// Dash is a published constant other packages will compare against, so its VALUE is part of the
// contract, not an implementation detail. A change here silently breaks every caller testing for it.
func TestDashIsTheEmDash(t *testing.T) {
	if Dash != "—" {
		t.Errorf("Dash = %q (%U), want an em dash U+2014 — the CLI had three spellings of this and the point was to end that", Dash, []rune(Dash)[0])
	}
}
