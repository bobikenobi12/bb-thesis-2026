// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package format renders human-facing values — money, durations, minutes, dates, byte counts — for
// the CLI and the runner, so the terminal and the console cannot disagree about the same number.
//
// It is the Go half of `@repo/format`. Neither side is a port of the other: what must agree is the
// OUTPUT, and that agreement is stated as a committed conformance table
// (`packages/format/conformance/format-cases.json`) which TypeScript generates and both sides are
// tested against. Go cannot write that file, so Go has no way to make itself right — which is the
// property that makes the mirror mean anything. See conformance_test.go.
//
// The divergence this closes was live and about money: `fmt.Sprintf("%.0f", 12.5)` renders `12`,
// because Go's %f rounds half to EVEN, while JavaScript rounds half away from zero and the billing
// page shows `$12.50`. Five CLI call sites did exactly that.
//
// ── The rounding rule, and which language defers ────────────────────────────────────────────────
//
// "This package matches JavaScript" was written here and is NOT true, which #3899 measured rather
// than assumed. Both languages round half away from zero; they disagree about WHAT they round.
// This side scales the BINARY double and rounds the product (`math.Round(x*p)/p`). Intl rounds the
// shortest round-tripping DECIMAL — the literal a human typed. The two part company wherever the
// scaled product lands on the far side of a half from that decimal: `8.165 * 100` is
// `816.4999999999999`, so this side renders `$8.16` where Intl reads "8.165" and renders `$8.17`.
//
// THE RULE IS: this side's answer is the shared one, and TYPESCRIPT DEFERS. Not because scaling a
// double is more correct — it is less correct, and `$8.17` is what a reader would call right — but
// because the CLI and the console must print ONE string for one number, and matching Intl from here
// would mean a decimal formatter in Go, while matching this from there costs one function. The
// deferral is implemented in `@repo/format`'s own `roundHalfAwayFromZero`, which mirrors the one
// below including its multiply-first shape, and is applied in `money`, the mirror of `render`.
//
// ROUNDING THEREFORE HAPPENS AT ONE SEAM PER LANGUAGE — `render` here, `money` there — at the
// places that call is about to print. That placement is load-bearing and is what #3899 fixed:
// TypeScript used to round in its three CALLERS instead, and two of them were wrong (one omitted it,
// one hardcoded a scale of 100 and so rounded a zero-decimal currency twice). A rule a caller has to
// remember is a rule the fourth caller will not.
//
// Everything here is pure: same input, same output, no clock, no locale guessing, no I/O. The
// locale is fixed at en-GB — day-first dates, `,` grouping, `.` decimal — so output cannot vary by
// where the code runs.
package format

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	// The conformance table pins IANA zones (`Asia/Tokyo`), and time.LoadLocation reads the host's
	// zoneinfo — which minimal containers do not ship, and a container is where the runner runs.
	// Embedding the database costs ~450 KB of binary and buys a formatter that does not silently
	// return the wrong DAY in production while passing on a laptop.
	_ "time/tzdata"
)

// Dash is the empty-value sentinel: an em dash, the same glyph `@repo/format` returns for a date it
// cannot parse.
//
// It lives here rather than in the CLI's ui package because `packages/core` cannot import
// `apps/cli`, and because the CLI had THREE spellings of "nothing to show" — `ui.SymbolDash`, a
// hardcoded literal, and the string "N/A" — across four helper families. One rule, one glyph.
const Dash = "—"

// ── money ──────────────────────────────────────────────────────────────────────────────────────

// RateStyle selects how a per-month figure is written. Shared by MonthlyRate and MonthlyDelta,
// which do NOT read it identically — stated here rather than left to be discovered at a call site.
type RateStyle string

const (
	// Estimate is a projection. For MonthlyRate that means it may ADMIT it does not know, with an
	// honest `<$1/mo` rather than a rounded-to-zero number that reads as free; the minor units are
	// still shown above one unit. For MonthlyDelta it means WHOLE currency units — `+$13/mo` — and
	// there is no `<$1/mo`, because a change that rounds to nothing is honestly reported as no
	// change, while a COST that rounds to nothing would be misreported as free.
	Estimate RateStyle = "estimate"
	// Exact is a billed or itemised figure: always minor units, because a column of costs that
	// sometimes shows cents and sometimes does not is unreadable as a column. Both functions read
	// it the same way, and both treat an unknown style as this one.
	Exact RateStyle = "exact"
)

// currencySymbol is the narrow-symbol PREFIX for the currencies this package is held to, verbatim
// from what Intl produces in @repo/format's fixed en-GB locale — INCLUDING the separator, which for
// some currencies is a NO-BREAK SPACE (U+00A0) and not nothing. `Intl.NumberFormat("en-GB", {style:
// "currency", currency: "ISK", currencyDisplay: "narrowSymbol"})` emits the parts
// `[currency "kr"][literal U+00A0][integer …]`, so "kr" alone would render `kr1,240` against
// TypeScript's `kr 1,240` and diverge on the space rather than on the number. Storing the joined
// prefix keeps render's `sign + symbol + digits` shape and puts the whole claim in one string.
//
// A currency that is NOT here renders its ISO code SUFFIXED instead — `12.50 HUF` — and never
// guesses. That is the whole rule: a guessed symbol on a billed amount is the worst failure
// available, and an error return is worse still, because at a table cell the only answers to an
// error are a dash or ignoring it, and a dash loses the number entirely.
//
// THE SET IS EXACTLY WHAT THE CONFORMANCE TABLE PINS, deliberately, and it is smaller than the set
// Money now divides correctly. An entry here is a claim about CLDR that only a table row can check;
// an unpinned entry is a claim nothing can check, and CLDR moves — HUF's DISPLAY digits went 2 -> 0
// between ICU 75.1 and ICU 78.3, which is why HUF is pinned by neither this map nor the table. Add
// a currency here and add its row in the same change, or leave it to the ISO-code fallback, which
// is honest about not knowing.
var currencySymbol = map[string]string{
	"USD": "$",
	"EUR": "€",
	"GBP": "£",
	"JPY": "¥",
	"KRW": "₩",
	// CLP and TWD both narrow-render as `$`, and they sit on OPPOSITE sides of the divisor split —
	// CLP is zero-decimal for charges, TWD is two-decimal. One symbol, two divisors, which is why
	// both are pinned: a fix keyed on the rendered symbol passes one and fails the other.
	"CLP": "$",
	"TWD": "$",
	"ISK": "kr\u00a0",
	"UGX": "UGX\u00a0",
}

// currencyDecimals is the number of minor-unit digits to DISPLAY.
//
// Display only. This is NOT the divisor Money uses — see chargeDivisorFor, and the two genuinely
// disagree: UGX is divided by 100 and printed with no fraction digits at all.
//
// Unlisted means two, via decimalsFor. The same "pin it or leave it out" rule as currencySymbol
// applies, for the same reason.
var currencyDecimals = map[string]int{
	"JPY": 0,
	"KRW": 0,
	"CLP": 0,
	"ISK": 0,
	"UGX": 0,
}

// stripeZeroDecimalCharge is the set of currencies whose Stripe `amount` is ALREADY in major units,
// so a charge amount must not be divided. The Go half of packages/format/src/minor-units.ts; that
// file carries the reasoning and the citations, and this comment states only what a Go reader needs
// in order not to "correct" the list.
//
// Transcribed from the zero-decimal list at https://docs.stripe.com/currencies (fetched 2026-09-03)
// — BIF, CLP, DJF, GNF, JPY, KMF, KRW, MGA, PYG, RWF, UGX, VND, VUV, XAF, XOF, XPF — MINUS UGX.
// Sixteen published, fifteen here. UGX appears in Stripe's own zero-decimal list AND in the same
// page's Special cases table, verbatim: "UGX transitioned to a zero-decimal currency, but backwards
// compatibility requires you to represent it as a two-decimal value, where the decimal amount is
// always `00`. For example, to charge 5 UGX, provide an `amount` value of `500`." The special case
// wins because it is the more specific statement and it is about CHARGES, which is the only context
// Money is ever handed. Restoring UGX to this set renders every UGX invoice 100x overstated, and
// the conformance row `money/UGX-IS-IN-STRIPES-ZERO-DECIMAL-LIST-AND-IS-STILL-DIVIDED` is what says
// so out loud.
//
// HUF and TWD are absent for the opposite reason and it is not an oversight: their Special cases
// entries are about PAYOUTS ("even though you can charge two-decimal amounts"), so their charge
// divisor is the ordinary 100 and they need no entry.
var stripeZeroDecimalCharge = map[string]bool{
	"BIF": true,
	"CLP": true,
	"DJF": true,
	"GNF": true,
	"JPY": true,
	"KMF": true,
	"KRW": true,
	"MGA": true,
	"PYG": true,
	"RWF": true,
	"VND": true,
	"VUV": true,
	"XAF": true,
	"XOF": true,
	"XPF": true,
}

// chargeDivisorFor reports how many minor units one unit of `currency` is worth in a Stripe charge
// amount: 1 for the zero-decimal set, 100 for everything else.
//
// An unknown code answers 100, matching decimalsFor's direction of error. That refusal is chosen
// rather than inherited: 100x too SMALL is visibly absurd, while a made-up 1 renders 100x too LARGE
// and reads as a plausible bill.
func chargeDivisorFor(currency string) float64 {
	if stripeZeroDecimalCharge[strings.ToUpper(currency)] {
		return 1
	}
	return 100
}

// decimalsFor reports how many fraction digits a currency displays. Unknown currencies get two,
// which is right for the overwhelming majority and wrong in the same direction as the rest of the
// world's software.
func decimalsFor(currency string) int {
	if d, ok := currencyDecimals[strings.ToUpper(currency)]; ok {
		return d
	}
	return 2
}

// render writes an amount in a currency at a fixed number of decimals, with `,` grouping.
//
// The sign leads the symbol (`-$5.00`), matching Intl's `narrowSymbol` output — `$-5.00` is not a
// form anyone writes.
func render(amount float64, currency string, decimals int) string {
	symbol, known := currencySymbol[strings.ToUpper(currency)]
	sign := ""
	if amount < 0 {
		sign = "-"
		amount = -amount
	}
	digits := group(strconv.FormatFloat(roundHalfAwayFromZero(amount, decimals), 'f', decimals, 64))
	if known {
		return sign + symbol + digits
	}
	// No symbol: the ISO code, suffixed. The number survives; nothing is invented.
	return sign + digits + " " + strings.ToUpper(currency)
}

// roundHalfAwayFromZero rounds to `decimals` places, half away from zero, by scaling the double.
//
// This function is the reason the package exists. `strconv.FormatFloat(12.5, 'f', 0, 64)` gives
// "12" — Go rounds half to EVEN — while JavaScript gives "13". math.Round is half-away-from-zero,
// so scaling through it reproduces the JS answer for every value that survives the scaling.
//
// NOT every value does, and the doc comment here used to say "the way JavaScript does" without that
// qualifier. `x*p` is a binary multiply and can cross a half: `8.165 * 100` is `816.4999999999999`,
// so this rounds DOWN where Intl, rounding the decimal `8.165`, rounds up. Measured in #3899.
// The multiply is not a defect to remove — it is the shared answer both languages are held to, and
// `@repo/format` mirrors this shape deliberately. See the rounding-rule section in the package doc
// before "fixing" it, because making this match Intl moves Money, MonthlyRate and MonthlyDelta.
func roundHalfAwayFromZero(x float64, decimals int) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return 0
	}
	p := math.Pow(10, float64(decimals))
	return math.Round(x*p) / p
}

// group inserts `,` every three digits of the integer part. The fraction is left alone.
func group(s string) string {
	intPart, frac, hasFrac := strings.Cut(s, ".")
	var b strings.Builder
	for i, r := range intPart {
		if i > 0 && (len(intPart)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	if hasFrac {
		return b.String() + "." + frac
	}
	return b.String()
}

// Money renders an amount given in MINOR units (cents) — `1250, "USD"` is `$12.50`.
//
// TWO QUESTIONS, TWO AUTHORITIES. The DIVISOR comes from chargeDivisorFor, whose authority is
// Stripe, because Stripe produced the number. The DISPLAY decimals come from decimalsFor, whose
// authority is CLDR. They are not one table and they legitimately disagree — UGX is divided by 100
// and printed with no fraction digits — which is why they are two functions and why neither is
// derived from the other.
//
// #3581 was the first half of that: the `/ 100` used to be unconditional, so every zero-decimal
// currency rendered at 1/100 of its value and a ¥124,000 invoice showed as `¥1,240`. Reading the
// exponent off CLDR is the OTHER half and is worse — it fixes JPY and renders HUF, ISK, UGX and TWD
// 100x overstated, which reads as a plausible bill where 100x understated reads as absurd. See
// chargeDivisorFor above and packages/format/src/minor-units.ts for the citations.
//
// STILL NOT COVERED: three-decimal currencies. Stripe no longer publishes a three-decimal list to
// cite, so none is asserted and BHD/JOD/KWD/OMR/TND fall to the two-decimal default.
//
// There is no Go caller today. It is mirrored anyway so the contract is STATED for the day one is
// written, rather than rediscovered — the same argument the TypeScript side makes for Bytes.
//
// The first one is proposed in #3659, which would point `apps/cli`'s `ui.FloatOrDash` here for
// `protection list`'s `Cost Δ` — it wants an exact amount with no `/mo`, which is this function and
// not MonthlyRate — multiplying by 100 to meet the minor-unit signature and passing "USD"
// explicitly, because a `cost_delta_threshold` carries no currency on the wire. Stated in the
// conditional because that lane has not landed: `ui.FloatOrDash` still renders `$%.2f` at this
// commit, and a doc that describes a caller before it exists is the stale-forward note this file
// spends its length warning about.
//
// When it does land it passes "USD" explicitly, which chargeDivisorFor answers 100 for, so nothing
// about #3581 changes its arithmetic — but it inherits the split above rather than a hardcoded 100,
// which is the property that matters the day a second currency appears on that wire.
func Money(cents float64, currency string) string {
	return render(cents/chargeDivisorFor(currency), currency, decimalsFor(currency))
}

// MonthlyRate renders a recurring cost given in MAJOR units, with a `/mo` suffix.
//
// This is the function every real Go call site wants: nothing in `apps/cli` or `packages/core` holds
// money in cents, so Money's signature has no consumer while this one has nine.
//
// Estimate rounds to minor units ONCE and then asks whether the result is under one unit, so
// `0.999` reads `$1.00/mo` rather than `<$1/mo` — it rounds up to a whole unit and saying "less
// than" of a value that is not less than would be a lie. `0` is `$0/mo`, without decimals, because
// zero is not an approximation of anything.
//
// amount must be an ABSOLUTE cost, not a delta. `<= 0` is one test, so a NEGATIVE is clamped in
// both registers and its sign is lost: -5 renders `$0/mo` / `$0.00/mo`, identical to nothing
// running, even in Exact, which otherwise rounds nothing away.
//
// That is a REFUSAL, and until #3768 it was a gap. This function means an absolute cost; clamping
// is how it declines input it was never for, and MonthlyDelta is the register a signed amount goes
// to. Pinned on both sides by the conformance cases
// `monthlyRate/{estimate,exact}/negative-REFUSED-see-monthlyDelta`, matching the TypeScript
// `formatMonthlyRate`. Do not reach for Exact and assume the sign survives — it does not, and that
// is the property the split buys.
func MonthlyRate(amount float64, style RateStyle, currency string) string {
	decimals := decimalsFor(currency)
	if math.IsNaN(amount) || math.IsInf(amount, 0) || amount <= 0 {
		// `!= Estimate` rather than `== Exact`, so a style nobody defined lands on Exact in BOTH
		// branches. The asymmetric spelling had an unknown style rendering minor units above zero
		// and dropping them at zero — the same caller getting two registers from one call site.
		if style != Estimate {
			return render(0, currency, decimals) + "/mo"
		}
		return render(0, currency, 0) + "/mo"
	}
	rounded := roundHalfAwayFromZero(amount, decimals)
	if style == Estimate && rounded < 1 {
		// Sub-unit and non-zero. Rounding it to `$0.00/mo` would read as free.
		return "<" + render(1, currency, 0) + "/mo"
	}
	return render(rounded, currency, decimals) + "/mo"
}

// MonthlyDelta renders a CHANGE in a recurring monthly cost, signed: `-$5.00/mo`, `+$12.50/mo`,
// `$0/mo`. Major units, like MonthlyRate.
//
// The credit register MonthlyRate refuses to be. Split rather than bolted on, so a caller has to
// say which kind of number it holds: making MonthlyRate signed would have let every existing
// absolute call site render a negative it has no meaning for. The waiting consumer is
// `packages/core/infracost`'s `Summary.DiffMonthly`, which goes in BOTH directions — a plan can get
// more expensive — which is also why this is not called MonthlySaving.
//
// THE SIGN LEADS THE SYMBOL, which is already `render`'s rule: `$-5.00` is not a form anyone
// writes. The sign is assembled around the MAGNITUDE here rather than left to `render`'s own
// negative branch, because `render` has no `+` and the two languages must agree about both.
//
// ZERO CARRIES NO SIGN — `+$0/mo` reads as an increase that did not happen — and it drops the minor
// units in BOTH registers, where MonthlyRate's Exact would say `$0.00/mo`. That padding exists so a
// column of LEVELS aligns under its total; "no change" is not a level.
//
// A CHANGE THAT RENDERS AS ZERO carries no sign either. That is the same rule, not a second one:
// the sign is decided by the ROUNDED MAGNITUDE, so 0.4 in Estimate (whole units) and 0.001 in Exact
// (cents) both render `$0/mo`. Deciding it on the raw amount instead yields `+$0/mo` and
// `+$0.00/mo` — exactly what the rule above forbids.
//
// There is deliberately NO `<$1/mo` here. MonthlyRate's admission protects a claim about a LEVEL,
// where a rounded-to-zero figure reads as FREE; "no change worth showing" is a true reading of a
// delta. And `-<$1/mo` puts the sign and the `<` in competition for the leading position.
//
// A currency with no symbol falls back to the ISO code exactly as everywhere else in this file —
// which is a Go-side RULING rather than a mirror, so it is tested in format_test.go and not in the
// conformance table. See that file's header.
func MonthlyDelta(amount float64, style RateStyle, currency string) string {
	// One spelling of "no change", reached by two routes: a literal zero and a magnitude that
	// rounds to one. Both must be UNSIGNED and both drop the minor units, so it is built once
	// rather than in two branches that could drift.
	noChange := render(0, currency, 0) + "/mo"
	if math.IsNaN(amount) || math.IsInf(amount, 0) || amount == 0 {
		return noChange
	}

	// ONE test for the register, used by every branch below. MonthlyRate's first cut asked the
	// question twice with opposite polarity and gave one caller two registers; asking once means an
	// undefined style lands on Exact everywhere, which is the safe side — showing minor units where
	// whole units were wanted is cosmetic, the reverse misstates money.
	decimals := decimalsFor(currency)
	if style == Estimate {
		decimals = 0
	}

	magnitude := render(math.Abs(amount), currency, decimals)
	// Compared as RENDERED, not as a number. "Does this round to zero" is a question about the
	// currency's own decimals, and `render` already answers it; re-deriving the threshold here
	// would be a second copy of `decimalsFor` that can disagree with the first.
	if magnitude == render(0, currency, decimals) {
		return noChange
	}

	sign := "+"
	if amount < 0 {
		sign = "-"
	}
	return sign + magnitude + "/mo"
}

// ── time ───────────────────────────────────────────────────────────────────────────────────────

// Minutes renders a count of minutes for a person: `0 min`, `<1 min`, `47 min`, `2h 15m`, `1h`.
//
// Rounding happens ONCE, before the hour test, which is why `59.5` is `1h` and not `60 min`. The
// `<1 min` case exists because `0.943 minutes` is a number the code happens to hold, not an answer
// to "how much have I used".
func Minutes(m float64) string {
	if math.IsNaN(m) || math.IsInf(m, 0) || m <= 0 {
		return "0 min"
	}
	if m < 1 {
		return "<1 min"
	}
	total := int(math.Round(m))
	if total < 60 {
		return strconv.Itoa(total) + " min"
	}
	hours, mins := total/60, total%60
	if mins == 0 {
		return strconv.Itoa(hours) + "h"
	}
	return fmt.Sprintf("%dh %dm", hours, mins)
}

// Quota renders usage against an allowance: `<1 min / 200 min`.
//
// The used side is humanised through Minutes; the allowance never is, because an allowance is a
// plan term and `2h` is not how a plan states one. Usage above the allowance is NOT clamped — the
// overage is the thing the reader needs to see.
func Quota(used, included float64) string {
	allowance := 0.0
	if !math.IsNaN(included) && !math.IsInf(included, 0) && included > 0 {
		allowance = math.Round(included)
	}
	return Minutes(used) + " / " + group(strconv.FormatFloat(allowance, 'f', 0, 64)) + " min"
}

// Duration renders an elapsed span: `47s`, `3m 20s`, `2h 5m`.
//
// It ROLLS INTO HOURS at sixty minutes and drops the seconds when it does. The console rendered a
// two-hour provision as `120m 0s` and made the reader divide; a provision over an hour is ordinary
// rather than an edge case, so the shape that read worst was the one covering the common path. At
// an hour the seconds stop being information: nobody asking "how long did this take" is served by
// `2h 5m 03s` over `2h 5m 41s`.
func Duration(d time.Duration) string {
	if d <= 0 {
		return "0s"
	}
	seconds := int(d / time.Second)
	if seconds < 60 {
		return strconv.Itoa(seconds) + "s"
	}
	minutes := seconds / 60
	if minutes < 60 {
		return fmt.Sprintf("%dm %ds", minutes, seconds%60)
	}
	return fmt.Sprintf("%dh %dm", minutes/60, minutes%60)
}

// DateStyle selects how much of a timestamp to show.
type DateStyle string

const (
	// DateOnly — `9 Mar 2026`.
	DateOnly DateStyle = "date"
	// DateTime — `9 Mar 2026, 15:04`.
	DateTime DateStyle = "datetime"
	// Month — `March 2026`.
	Month DateStyle = "month"
	// TimeOnly — `15:04:05`, a log gutter where the date repeats on every line but the second matters.
	TimeOnly DateStyle = "time"
)

// dateLayouts are Go's spelling of the en-GB shapes Intl produces. Day-first and unpadded, so the
// 1st of a month is `1 Mar 2026` and not `01 Mar 2026`.
var dateLayouts = map[DateStyle]string{
	DateOnly: "2 Jan 2006",
	DateTime: "2 Jan 2006, 15:04",
	Month:    "January 2006",
	TimeOnly: "15:04:05",
}

// Date renders an absolute timestamp in the given zone.
//
// A zero time returns Dash rather than `1 Jan 0001` — these render straight into a table cell, and a
// user-visible garbage date is worse than an obvious blank. An unknown DateStyle also returns Dash:
// a caller that invents a style gets a blank, never a silently wrong shape.
//
// The zone is a PARAMETER and not the process default on purpose. The same reasoning as the
// TypeScript side's hydration trap: a timestamp rendered against an ambient zone is a value that
// changes depending on which machine printed it.
func Date(t time.Time, style DateStyle, loc *time.Location) string {
	layout, ok := dateLayouts[style]
	if !ok || t.IsZero() {
		return Dash
	}
	if loc == nil {
		loc = time.UTC
	}
	return t.In(loc).Format(layout)
}

// ── size ───────────────────────────────────────────────────────────────────────────────────────

// byteUnits steps by 1024. PB is terminal: beyond it the number keeps growing rather than stepping,
// so 1024 PB renders as `1024 PB` and not as an exabyte nobody has.
var byteUnits = []string{"B", "KB", "MB", "GB", "TB", "PB"}

// Bytes renders a byte count: `812 B`, `1.5 KB`, `1.4 MB`.
//
// Whole bytes carry no decimal, because a fraction of a byte is not a thing. Above that, one
// decimal, with a trailing `.0` dropped so an exact kilobyte reads `1 KB`.
//
// There is no Go caller today — nothing in `apps/cli`, `apps/runner` or `packages/core` renders a
// byte count. It is mirrored so the contract is stated for the first one written, rather than
// rediscovered as a fourth spelling.
func Bytes(n float64) string {
	if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
		return "0 B"
	}
	i := 0
	for n >= 1024 && i < len(byteUnits)-1 {
		n /= 1024
		i++
	}
	if i == 0 {
		return strconv.FormatFloat(math.Floor(n), 'f', 0, 64) + " B"
	}
	v := roundHalfAwayFromZero(n, 1)
	if v == math.Trunc(v) {
		return strconv.FormatFloat(v, 'f', 0, 64) + " " + byteUnits[i]
	}
	return strconv.FormatFloat(v, 'f', 1, 64) + " " + byteUnits[i]
}
