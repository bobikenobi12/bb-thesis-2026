// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One place that turns a number into a string a person reads.
 *
 * Before this package the console had eleven formatting helpers: four shared, seven local,
 * three functions named `formatDate` with different output in a single directory, two
 * byte-identical `formatBytes`, and `date-fns` imported raw at nineteen call sites. The same
 * quantity therefore rendered differently depending on which page you were on — runner minutes
 * read `0.943 / 200 min` on the org overview, `0 / 200` in settings, and `0.4166666666 / 200`
 * in an agent widget, from one float.
 *
 * Everything here is pure: same input, same output, no clock, no locale guessing, no I/O. That
 * is what makes it testable to the edges, and the edges are where the bugs were.
 */

import { formatDistance } from "date-fns";

import { stripeChargeDivisor } from "./minor-units";

// Re-exported, not merely used: the charge divisor is a FACT about Stripe that any surface
// holding a Stripe amount needs, and a second transcription of it elsewhere in the repo is the
// failure mode `minor-units.ts` documents. Its name does not begin with `format`, so the
// conformance generator does not demand a table section for it — it is data, not a formatter.
//
// The SET travels with the function (#4123). `apps/console/scripts/gen-format-conformance.ts`
// publishes it into the conformance table so Go's copy can be held to it; neither the generator
// nor anything else may re-type the codes. Same rule about the `format` prefix applies.
export { stripeChargeDivisor, STRIPE_ZERO_DECIMAL_CHARGE } from "./minor-units";

/** Locale for every Intl call here. Fixed, so output cannot vary by where the code runs. */
const LOCALE = "en-GB";

/**
 * Human-readable minutes.
 *
 * The rule, in full, because each branch fixes a real defect:
 *   0            -> `0 min`     (nothing has run — NOT `<1 min`, which reads as "a little")
 *   0 < m < 1    -> `<1 min`    (this is the `0.943 / 200 min` bug)
 *   m < 60       -> `3 min`     (whole minutes; a fractional minute is noise, not precision)
 *   m >= 60      -> `2h 15m`, and `1h` exactly when the remainder rounds to zero
 *
 * Rounding happens ONCE, before the hour test, so a value cannot round differently in two
 * branches: 59.4 -> `59 min`, 59.6 -> `1h`. Rounding inside each branch instead would let 59.6
 * print `1h 0m` in one place and `60 min` in another, which is the class of disagreement this
 * package exists to end.
 *
 * @param minutes elapsed or allotted minutes; may be fractional. Negative is clamped to 0.
 */
export function formatMinutes(minutes: number): string {
	if (!Number.isFinite(minutes) || minutes <= 0) return "0 min";
	if (minutes < 1) return "<1 min";

	const whole = Math.round(minutes);
	if (whole < 60) return `${whole} min`;

	const hours = Math.floor(whole / 60);
	const rest = whole % 60;
	return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * A consumed-against-allowance readout: `<1 min / 200 min`.
 *
 * This exists because `formatMinutes` alone is not enough to make the four call sites agree, and
 * they immediately did not. Two independent migrations reached two different answers from the same
 * helper — one rendered `<1 min / 200 min`, the other `12 min / 3h 20m` — which is the exact
 * disagreement the package was created to end, reappearing one layer up.
 *
 * The rule, and why:
 *   - The USED side is humanised. It is a measurement, and three decimal places of a minute is
 *     noise (`0.943 / 200 min` was the reported bug).
 *   - The ALLOWANCE side is NOT. `200` is the number the plan and the pricing page quote, so it is
 *     effectively a proper noun; `3h 20m` is arithmetically identical and unrecognisable to the
 *     person checking whether they are near their limit.
 *
 * So: one function, one answer. A caller that wants something else should say why in a comment
 * rather than assembling its own pair — that is how four renderings happened the first time.
 *
 * @param usedMinutes minutes consumed; may be fractional.
 * @param includedMinutes the plan's allowance, in whole minutes.
 */
export function formatQuota(usedMinutes: number, includedMinutes: number): string {
	const included = Number.isFinite(includedMinutes) && includedMinutes > 0 ? Math.round(includedMinutes) : 0;
	return `${formatMinutes(usedMinutes)} / ${included.toLocaleString(LOCALE)} min`;
}

/**
 * An elapsed millisecond span as `47s`, `3m 20s` or `2h 5m`.
 *
 * ROLLS INTO HOURS at 60 minutes, and drops the seconds when it does.
 *
 * This was the console-vs-CLI disagreement, settled on merit in favour of the CLI's answer
 * (`apps/cli/cmd/jobs_list.go`, which already rolled). The console rendered a two-hour provision as
 * `120m 0s` and made the reader divide — and a provision over an hour is ordinary, not an edge
 * case, so the shape that reads worst was the one covering the common path. The conformance table
 * pins the boundary in both directions.
 *
 * The provenance line this block used to carry — "ported verbatim from
 * `apps/console/lib/jobs/format.ts`, which was already the right shape" — is deleted rather than
 * amended. It contradicted the paragraph above it: the console's shape was the one that LOST.
 *
 * @param ms elapsed milliseconds. Negative is clamped to 0.
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	// At an hour the SECONDS stop being information and start being noise: nobody reading "how long
	// did this provision take" is served by the difference between 2h 5m 03s and 2h 5m 41s, and the
	// two extra digits push the useful ones further from the eye. Dropping them is why this rolls
	// rather than just adding a third field.
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** How much of a timestamp to show. */
export type DateStyle = "date" | "datetime" | "month" | "time";

const DATE_OPTS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
	date: { day: "numeric", month: "short", year: "numeric" },
	datetime: { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" },
	month: { month: "long", year: "numeric" },
	// `time` exists for one shape: a log gutter, where the date is the same on every line and
	// repeating it is noise, but the second matters. `hourCycle: "h23"` rather than
	// `hour12: false`, which is the option that renders midnight as 24:00 in some locales.
	time: { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
};

/**
 * An absolute timestamp. Replaces three same-named `formatDate` implementations that disagreed.
 *
 * Returns an em dash for anything unparseable rather than `Invalid Date`, because these render
 * straight into a table cell and a user-visible `Invalid Date` is worse than an obvious blank.
 *
 * TIME ZONE. With no `timeZone` this renders in the runtime's zone, which is what a user wants
 * (a job that ran at 15:00 their time should say 15:00). The trap is React: rendered in a server
 * component it uses the SERVER's zone, and re-rendered on the client it uses the BROWSER's — a
 * hydration mismatch that surfaces as a flicker or a console error, not as a wrong date. Use the
 * `datetime` style in client components, or pass an explicit `timeZone` when it must be stable.
 *
 * @param value an ISO string, epoch millis, or a Date.
 * @param style how much to show; defaults to the date alone.
 * @param timeZone an IANA zone to pin the output to; omit for the runtime's own.
 */
export function formatDate(
	value: string | number | Date | null | undefined,
	style: DateStyle = "date",
	timeZone?: string,
): string {
	const d = toDate(value);
	if (!d) return "—";
	return new Intl.DateTimeFormat(LOCALE, { ...DATE_OPTS[style], ...(timeZone ? { timeZone } : {}) }).format(d);
}

/**
 * A timestamp relative to now — `3 minutes ago`, `about 1 month ago`.
 *
 * Wraps `date-fns`, which nineteen console files import directly today. Reads the clock, so it
 * is the one function here that is not referentially transparent; tests inject the instant.
 *
 * @param value an ISO string, epoch millis, or a Date.
 * @param now the instant to measure against; defaults to the real clock.
 */
export function formatRelative(value: string | number | Date | null | undefined, now?: Date): string {
	const d = toDate(value);
	if (!d) return "—";
	// `formatDistance` takes an explicit baseline; `formatDistanceToNow` does not, which would
	// make this untestable without faking the global clock. `addSuffix` supplies "ago"/"in …".
	return formatDistance(d, now ?? new Date(), { addSuffix: true });
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * A byte count. Replaces the duplicate pair in `components/support/`.
 *
 * Uses 1024 steps with the short unit names the existing call sites already showed, and keeps
 * one decimal above kilobytes only — `1.4 MB`, but `812 B`, because a fractional byte is a lie.
 *
 * @param bytes a non-negative byte count. Negative is clamped to 0.
 */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded} ${BYTE_UNITS[unit]}`;
}

/**
 * A money amount held in minor units (cents), which is how Stripe and the billing tables store it.
 *
 * Takes minor units on purpose: every bug in this area starts with someone passing 12.5 where
 * 1250 was meant, and a signature that says `cents` makes that visible at the call site.
 *
 * TWO QUESTIONS, TWO AUTHORITIES, and this function asks both. The DIVISOR — how many minor units
 * the caller's number is in — comes from {@link stripeChargeDivisor}, whose authority is the
 * payment processor that produced the number. The DISPLAY decimals come from {@link minorUnits},
 * whose authority is CLDR. They are not the same table and they legitimately disagree: Stripe
 * documents UGX as two-decimal for charges while CLDR prints it with no fraction digits at all, so
 * `formatMoney(500, "UGX")` is `UGX 5` — divided by 100, printed with none.
 *
 * #3581 WAS THE FIRST HALF OF THAT, and reading the exponent off CLDR would have been the second.
 * The `/ 100` used to be unconditional, so every zero-decimal currency rendered at 1/100 of its
 * value — a ¥124,000 invoice as `¥1,240`. Taking the divisor from CLDR instead fixes JPY and breaks
 * HUF, ISK, UGX and TWD by the same factor in the other direction, which is worse: 100x too small
 * is visibly absurd, 100x too large reads as a plausible bill. `minor-units.ts` carries the table,
 * the citations and the UGX contradiction that makes transcribing Stripe's list insufficient.
 *
 * WHAT IS STILL NOT COVERED: three-decimal currencies. `formatMoney(1240, "BHD")` divides by 100
 * and prints CLDR's three digits, giving `BHD 12.400`. Stripe no longer publishes a three-decimal
 * list to cite, so no divisor is asserted for them — see the module doc in `minor-units.ts`. It is
 * unreachable for the same reason the zero-decimal defect was: `SupportedCurrency` in
 * `@repo/plan-catalog` is `"usd" | "eur"` and `resolveCurrency` can return nothing else, so no
 * third currency reaches a Stripe charge today. `invoices.currency` is free `text()` mirrored from
 * Stripe, so the day one is added, it reaches here.
 *
 * @param cents amount in minor units, as Stripe quotes a charge in this currency.
 * @param currency ISO 4217 code; defaults to USD.
 */
export function formatMoney(cents: number, currency = "USD"): string {
	const amount = Number.isFinite(cents) ? cents / stripeChargeDivisor(currency) : 0;
	// No explicit decimals: a billed amount keeps the currency's own (2 for USD, 0 for JPY).
	return money(amount, currency);
}

/**
 * Which question a monthly figure is answering. Shared by both per-month registers, and they do
 * NOT read it identically — stated here rather than discovered at a call site.
 *
 * For {@link formatMonthlyRate} the two differ only in whether the figure may ADMIT it does not
 * know (`<$1/mo`); they never differ in precision for the same number, which is what lets a line
 * and a total sit in one column.
 *
 * For {@link formatMonthlyDelta} they differ in PRECISION: `"estimate"` renders whole currency
 * units (`+$13/mo`), `"exact"` renders minor units (`+$12.50/mo`). A delta headline is read for
 * its DIRECTION and its order of magnitude, where a cent is noise; a delta in a column is read
 * against the rows above it, where a cent is the point.
 */
export type MonthlyRateStyle = "estimate" | "exact";

/**
 * A recurring monthly cost, held in MAJOR units — `$12.50/mo`, `$1,240.37/mo`.
 *
 * The sibling of {@link formatMoney}, and it is a sibling rather than an option on it because the
 * two answer different questions and take different units.
 *
 * UNITS. `formatMoney` takes cents because a billed amount comes from Stripe and the billing
 * tables, where money is stored in minor units. This takes major units because a monthly estimate
 * comes from `projects.estimated_monthly_cost` and the plan's cost result, which are `numeric`
 * columns holding dollars. Passing one to the other is off by 100 either way, so the two names
 * carry the unit — `formatMoney(1250)` and `formatMonthlyRate(12.5)` are the same money.
 *
 * CENTS ARE ALWAYS SHOWN. The first cut of this function dropped them above $100, on the argument
 * that they are fake precision on an estimate. That argument is true of a lone headline and false
 * everywhere else in this console, because this quantity almost never appears alone: review found
 * three breakdown-and-total pairs whose own lines stopped adding up (`$60.25` + `$45.10` under a
 * total of `$105`, from a real `totalMonthlyCost` of 105.35) and two canvas cards side by side
 * reading `$99.99/mo` and `$100/mo` for the same field. A threshold that changes precision inside
 * one column is the disagreement this package exists to end, so there is no threshold.
 *
 * THE TWO REGISTERS are about ADMISSION, not precision:
 *
 *   "estimate" — a lone headline whose parts are not on screen (a project card, a plan's
 *                "Est." summary). It may admit it does not know:
 *                  <= 0       -> `$0/mo`      nothing is running — NOT `$0.00/mo`, which reads
 *                                             like a bill
 *                  0 < x < 1  -> `<$1/mo`     the same admission `formatMinutes` makes for
 *                                             `<1 min`; `$0.02/mo` for a whole project reads as
 *                                             a broken number, not a cheap one
 *                  otherwise  -> `$12.50/mo`, `$1,240.37/mo`
 *
 *   "exact"    — a line in a breakdown, the total of one, or a card in a set that sums to a
 *                total on the same screen. It may NOT round a POSITIVE figure away, because the
 *                reader is adding the column up: a $0.50 hosted zone and a $0.03 bucket must not
 *                both read `<$1/mo`, and a genuine zero must read `$0.00/mo` so the column aligns.
 *                  <= 0       -> `$0.00/mo`   (a negative lands here too — read the gap below)
 *                  otherwise  -> `$0.03/mo`, `$126.40/mo`
 *
 * Rounding to cents happens ONCE, before the `<1` test, so a figure cannot be rounded differently
 * by two branches: 0.999 reads `$1.00/mo`, never `<$1/mo` beside a `$1.00/mo`. The `<= 0` test is
 * the exception and runs FIRST, on the raw value — 0.001 is a real cost that must not round into
 * "nothing is running".
 *
 * A NEGATIVE IS CLAMPED IN BOTH REGISTERS, AND THAT IS A REFUSAL — not a rounding rule, and no
 * longer a gap. `<= 0` is ONE test, so -5 renders exactly as 0 does: `$0/mo` in the estimate
 * register, `$0.00/mo` in the exact one. Until #3768 that was a hole, because a saving had
 * nowhere else to go; it now says something. This function means AN ABSOLUTE COST, and clamping
 * is how it declines input it was never for. A signed amount has its own register:
 * {@link formatMonthlyDelta}.
 *
 * The two conformance cases that pin it are named for what they are —
 * `monthlyRate/{estimate,exact}/negative-REFUSED-see-monthlyDelta` — and `packages/core/format`'s
 * `MonthlyRate` clamps identically because the table holds both sides to the same answer.
 *
 * So the question at a call site is which KIND of number this is, not which register rounds less.
 * A LEVEL comes here: infracost's `totalMonthlyCost`, a resource's `monthlyCost`, a
 * `cost_delta_threshold` that `z.number().min(0)` bounds, and the agent-supplied `stats.monthly`
 * on the approval card (`apps/console/lib/ai/operation.ts`), which is documented to the model as
 * an absolute total for exactly this reason. A CHANGE goes to {@link formatMonthlyDelta}:
 * infracost's `diffTotalMonthlyCost`, and `Summary.DiffMonthly` on the Go side. Do NOT reach for
 * `"exact"` and assume the sign survives — it does not, and that is deliberate.
 *
 * NO `~`. Three call sites prefixed one and thirteen did not, which is the disagreement, not the
 * fix — the same field cannot be approximate on one screen and exact on the next. A page that
 * wants to say "estimated" says it in words beside the number, where it is readable.
 *
 * @param amount a recurring monthly cost in major units (dollars, euros). Must be an absolute
 *               cost, not a delta: a negative is clamped to 0 in BOTH registers and its sign is
 *               lost. That is this register declining input it is not for — render a delta, a
 *               saving or a credit with {@link formatMonthlyDelta}.
 * @param style which register — see above. Defaults to the headline `"estimate"`.
 * @param currency ISO 4217 code; defaults to USD.
 */
export function formatMonthlyRate(amount: number, style: MonthlyRateStyle = "estimate", currency = "USD"): string {
	const suffix = "/mo";
	// `undefined` decimals keeps the currency's own (2 for USD, 0 for JPY) — the same choice
	// `formatMoney` makes, so a breakdown line and a billed amount cannot disagree about JPY.
	//
	// `<= 0`, not `=== 0`: a negative is CLAMPED here, in both registers, and its sign is gone.
	// That is a refusal, not an oversight — this function renders absolute costs, and a signed
	// amount has a register of its own in `formatMonthlyDelta` rather than a branch in this one.
	if (!Number.isFinite(amount) || amount <= 0) {
		return `${money(0, currency, style === "exact" ? undefined : 0)}${suffix}`;
	}
	// ROUNDED ONCE, AT THE CURRENCY'S OWN PLACES, BEFORE THE `<1` TEST — `minorUnits` here,
	// `decimalsFor` in Go. This line read `Math.round(amount * 100) / 100` until #3899, which is the
	// right scale for USD and the wrong one for every currency whose minor unit is not two places:
	// it rounded a JPY amount to cents JPY does not have, and then `money` rounded that result a
	// SECOND time to whole yen. `12.496` came out `¥13/mo` against Go's `¥12/mo`, and `0.6` came out
	// `<¥1/mo` against Go's `¥1/mo` — the second one is worse than a wrong digit, because it is the
	// register ADMITTING it does not know about a value that rounds cleanly to one whole unit.
	//
	// `money` rounds again at the same places, which is idempotent and is the point: the rule lives
	// in one function and this call site only has to name the places its own BRANCH asks about.
	//
	// KNOWN GAP, and #3899 WIDENED it rather than opening it. `minorUnits` asks Intl; Go's
	// `decimalsFor` reads a map that contains exactly one entry, JPY. Intl calls HUF, ISK, UGX, KRW,
	// CLP and VND zero-decimal too, so for those six the two languages already disagree about how
	// many digits to PRINT — that part predates this function. What is new is that the `<1` test now
	// inherits the disagreement: `formatMonthlyRate(0.6, "estimate", "HUF")` rounds to 1 here and
	// says `Ft 1/mo`, where Go rounds at 2 places, stays at 0.6, and says `<1 HUF/mo`. The old
	// hardcoded `100` matched Go only by accident — it agreed with `decimalsFor`'s *fallback* of 2.
	//
	// Not closed here, and not by adding the six to Go's map either. That map is display-only and
	// CLDR is the right authority for display, so the addition looks obviously correct — but HUF,
	// ISK and UGX are exactly the currencies Stripe documents as TWO-decimal for charges while CLDR
	// calls them zero, which is the collision #3581 exists to resolve. Making the display table
	// agree while the divisor question is open would freeze half an answer. No caller passes any of
	// the six today, and the conformance table deliberately covers two-decimal currencies only, so
	// neither language's answer is pinned as the contract.
	const rounded = roundHalfAwayFromZero(amount, minorUnits(currency));
	if (style === "estimate" && rounded < 1) return `<${money(1, currency, 0)}${suffix}`;
	return `${money(rounded, currency)}${suffix}`;
}

/**
 * A CHANGE in a recurring monthly cost, signed — `-$5.00/mo`, `+$12.50/mo`, `$0/mo`.
 *
 * The credit register {@link formatMonthlyRate} refuses to be. Split rather than bolted on, so a
 * caller has to say which kind of number it holds and cannot render a diff as an absolute by
 * accident: making `formatMonthlyRate` signed would have let every existing absolute call site
 * render a negative it has no meaning for. `$5.00/mo saved` was the other rejected shape — it is a
 * sentence rather than a number, so it does not sum, does not right-align in a column, and needs a
 * translation story.
 *
 * THE SIGN LEADS THE SYMBOL — `-$5.00/mo`, not `$-5.00/mo`, which is not a form anyone writes.
 * That is already this package's house rule (Intl's `narrowSymbol` puts it there, and
 * `packages/core/format`'s `render` mirrors it), so the sign here is assembled around the
 * MAGNITUDE rather than handed to Intl: `signDisplay` would place `+` by the locale's rules and
 * the two languages would have to agree about that as well.
 *
 * ZERO CARRIES NO SIGN. `+$0/mo` reads as an increase that did not happen. `$0/mo` is the answer
 * in BOTH registers — including `"exact"`, where {@link formatMonthlyRate} would say `$0.00/mo`:
 * that padding exists so a column of LEVELS aligns under its total, and "no change" is not a level.
 *
 * ...AND NEITHER DOES A CHANGE THAT RENDERS AS ZERO, which is the same rule and not a second one.
 * The sign is decided by the ROUNDED MAGNITUDE, so `+0.4` in the estimate register (whole units)
 * and `+0.001` in the exact one (cents) both render `$0/mo`. Deciding it on the raw amount instead
 * would produce `+$0.00/mo` — precisely the increase-that-did-not-happen the rule above forbids.
 *
 * THERE IS NO `<$1/mo` EQUIVALENT, and that is a decision rather than an omission.
 * {@link formatMonthlyRate}'s admission exists because `$0.02/mo` for a whole project reads as a
 * broken number rather than a cheap one — it protects a claim about a LEVEL, where "free" is a
 * category the reader would wrongly conclude. A change that rounds to nothing is different: "no
 * change worth showing" is a TRUE reading of it. And the shapes it would need — `-<$1/mo`,
 * `+<$1/mo` — put the sign and the `<` in competition for the leading position, which is the
 * ambiguity the house rule above exists to remove.
 *
 * THE REGISTERS DIFFER IN PRECISION HERE, unlike in {@link formatMonthlyRate}; see
 * {@link MonthlyRateStyle}. `"estimate"` rounds the magnitude to whole units — half AWAY FROM
 * ZERO, the same rule and therefore the same answer as the exact register for `12.5` at a
 * zero-decimal currency, so the two can never disagree about a half.
 *
 * THE MAGNITUDE IS PRE-ROUNDED, AND THAT IS NOT AN ACCURACY IMPROVEMENT — see the comment in the
 * body. It exists to reproduce a LOSS that `packages/core/format` takes, because the two must
 * print one string and Go is the reference.
 *
 * A currency with no symbol behaves exactly as it does in {@link formatMonthlyRate}, because both
 * go through the same one Intl call. On the Go side that is a four-entry table and an ISO-code
 * fallback, which is a RULING rather than a mirror — see `packages/core/format/format_test.go`.
 *
 * @param amount the CHANGE in a recurring monthly cost, in major units. Negative is a saving,
 *               positive an increase, and both keep their sign. A non-finite value is "no change".
 * @param style which register — see above. Defaults to the headline `"estimate"`.
 * @param currency ISO 4217 code; defaults to USD.
 */
export function formatMonthlyDelta(amount: number, style: MonthlyRateStyle = "estimate", currency = "USD"): string {
	const suffix = "/mo";
	// One spelling of "no change", reached by two routes: a literal zero and a magnitude that
	// rounds to one. Both must be UNSIGNED and both must drop the minor units, so they are one
	// string built once rather than two branches that could drift.
	const noChange = `${money(0, currency, 0)}${suffix}`;
	if (!Number.isFinite(amount) || amount === 0) return noChange;

	// `undefined` keeps the currency's own decimals (2 for USD, 0 for JPY) — the same choice
	// `formatMoney` and `formatMonthlyRate` make, so the three cannot disagree about JPY.
	const decimals = style === "estimate" ? 0 : undefined;

	// THE MAGNITUDE IS HANDED OVER UNROUNDED ON PURPOSE — `money` rounds it, once, at the places it
	// is about to print. Until #3899 this line carried its own copy of that arithmetic, because
	// `money` did not yet round and each caller had to remember to. Two of the three forgot or got
	// the scale wrong; this one was right, which is exactly why its reasoning moved into `money`
	// rather than being deleted. See {@link roundHalfAwayFromZero} for why the rounding is
	// deliberately lossier than Intl's, and why the register's OWN places are the right scale
	// rather than a fixed 100.
	//
	// What still belongs HERE is the `decimals` argument: this register's precision is a property
	// of the STYLE — whole units for an estimate, minor units for an exact figure — and passing it
	// is what makes `money` round at 0 places for `+$13/mo`. `formatMonthlyRate` never differs in
	// precision between its registers and so never passes one.
	const magnitude = money(Math.abs(amount), currency, decimals);
	// Compared as RENDERED, not as a number, because "does this round to zero" is a question about
	// the currency's own decimals — which Intl holds and this module deliberately does not
	// duplicate. A DISPLAY table here is how #3581's near-miss fix would have got its second half.
	// `minorUnits` above obeys the same rule: it ASKS Intl rather than tabulating. `minor-units.ts`
	// tabulates the OTHER question — the charge divisor — and is a separate file for that reason.
	if (magnitude === money(0, currency, decimals)) return noChange;

	return `${amount < 0 ? "-" : "+"}${magnitude}${suffix}`;
}

/**
 * The one Intl currency call every money function goes through, so `formatMoney`,
 * `formatMonthlyRate` and `formatMonthlyDelta` cannot disagree about the symbol.
 *
 * `currencyDisplay: "narrowSymbol"` is load-bearing: en-GB renders USD as "US$12.50" by default,
 * which is wrong for a product that bills in dollars. narrowSymbol gives "$12.50", "€12.50",
 * "£12.50". Verified against Intl before relying on it.
 *
 * ROUNDING HAPPENS HERE, once, at the places this call is about to print — see
 * {@link roundHalfAwayFromZero}. That is the whole of #3899's fix, and the placement is the fix
 * rather than the arithmetic: `packages/core/format`'s `render` is this function's mirror and has
 * always rounded at its own seam, so every Go money function inherits the rule and none can forget
 * it. TypeScript rounded in its CALLERS instead, and two of the three got it wrong — `formatMoney`
 * omitted it entirely, and `formatMonthlyRate` wrote the scale as a hardcoded 100, which is a
 * second rounding for any currency whose minor unit is not two places. Only `formatMonthlyDelta`
 * was right, and only because #3895's review found the same defect one function over.
 *
 * @param decimals fixed fraction digits; omit to keep the currency's own.
 */
function money(amount: number, currency: string, decimals?: number): string {
	const digits = decimals === undefined ? {} : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
	return new Intl.NumberFormat(LOCALE, {
		style: "currency",
		currency,
		currencyDisplay: "narrowSymbol",
		...digits,
	}).format(roundHalfAwayFromZero(amount, decimals ?? minorUnits(currency)));
}

/**
 * Round to `places` the way `packages/core/format`'s function of the same name does — because what
 * has to agree is the OUTPUT, and Go's answer is the shared one.
 *
 * This is deliberately LESS accurate than handing the value to Intl. Intl rounds the shortest
 * round-tripping DECIMAL, so it reads `8.165` as the human wrote it and rounds up. Go scales the
 * BINARY double first — `math.Round(x*p)/p` — and `8.165 * 100` is `816.4999999999999`, so Go
 * rounds down. Neither is wrong in isolation; what would be wrong is the console and the CLI
 * printing two different strings for one number. Go is the reference not on merit but because
 * matching it costs this function, while matching Intl would cost Go a decimal formatter.
 *
 * THE MAGNITUDE IS ROUNDED AND THE SIGN RESTORED, mirroring `render`, which strips the sign before
 * it rounds. This is not a stylistic echo: JavaScript's `Math.round` is half-UP (toward +∞) and
 * Go's `math.Round` is half-AWAY-FROM-ZERO, so the two disagree on every negative half —
 * `Math.round(-812.5)` is `-812` where `math.Round` gives `-813`. Rounding the signed value here
 * would fix the three-decimal divergence and open a negative-half one in its place, which is why
 * `money/NEGATIVE-HALF-CENT-ROUNDS-AWAY-FROM-ZERO-NOT-TOWARD-POSITIVE` is in the conformance table
 * as a case that passed BEFORE this change and must keep passing after it.
 *
 * Non-finite input is not guarded here because every caller already guards it — `formatMoney`,
 * `formatMonthlyRate` and `formatMonthlyDelta` each test `Number.isFinite` and return a defined
 * string first, so a branch here could not be reached by any input and could not be pinned by any
 * conformance row.
 */
function roundHalfAwayFromZero(x: number, places: number): number {
	const p = 10 ** places;
	const magnitude = Math.round(Math.abs(x) * p) / p;
	return x < 0 ? -magnitude : magnitude;
}

/** Memo for {@link minorUnits}; see the note inside it for why it is safe to keep. */
const minorUnitsByCurrency = new Map<string, number>();

/**
 * How many fraction digits {@link money} will print for a currency when it is not told — 2 for USD,
 * 0 for JPY.
 *
 * ASKED OF INTL, NOT TABULATED, and the question here is a DISPLAY question, which is the one CLDR
 * is the authority for. The divisor question — how many minor units a CHARGE is quoted in — has a
 * different authority and is NOT asked here; it lives in `minor-units.ts`, and the two answers
 * differ for real currencies (UGX: divide by 100, print 0 digits). Answering one with the other in
 * either direction is #3581 and #3581's near-miss fix respectively.
 *
 * It exists so the money functions can pre-round at the same places they are about to print, the
 * way `packages/core/format`'s `render` does. Reading it back off the formatter keeps the two
 * numbers the same number by construction.
 */
function minorUnits(currency: string): number {
	// MEMOISED because #3899 moved this onto the hot path. `money` is the one Intl call every money
	// function goes through, and it now asks this question on every invocation where the caller did
	// not fix the decimals — so `formatMonthlyRate` went from building one `Intl.NumberFormat` per
	// call to three, and `formatMonthlyDelta("exact")` to four. Measured on Node: 13.0 µs → 41.5 µs
	// per `formatMonthlyRate`, and the canvas renders one cost chip per node while the billing and
	// invoice tables render one per row, so it is hundreds of calls per paint.
	//
	// Safe to cache for the life of the module: the answer is a pure function of the currency code
	// and of `LOCALE`, which is a fixed constant in this file precisely so output cannot vary by
	// where the code runs. An unsupported code throws inside `Intl` before anything is stored, so a
	// bad currency is never cached as an answer.
	const cached = minorUnitsByCurrency.get(currency);
	if (cached !== undefined) return cached;
	const computed = uncachedMinorUnits(currency);
	minorUnitsByCurrency.set(currency, computed);
	return computed;
}

/** Asks Intl the question {@link minorUnits} caches: how many fraction digits `currency` prints. */
function uncachedMinorUnits(currency: string): number {
	// Counted off a rendered zero rather than read from `resolvedOptions()`, which types
	// `maximumFractionDigits` as optional and would need a fallback branch no input can reach —
	// and an unreachable fallback holding the number `2` is the tabulated minor unit this function
	// exists to avoid, smuggled back in as a default. A currency with no minor unit simply has no
	// `fraction` part.
	const parts = new Intl.NumberFormat(LOCALE, {
		style: "currency",
		currency,
		currencyDisplay: "narrowSymbol",
	}).formatToParts(0);
	const fraction = parts.find((part) => part.type === "fraction");
	return fraction === undefined ? 0 : fraction.value.length;
}

/** Coerce the accepted input shapes to a valid Date, or null when it cannot be read. */
function toDate(value: string | number | Date | null | undefined): Date | null {
	if (value === null || value === undefined || value === "") return null;
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}
