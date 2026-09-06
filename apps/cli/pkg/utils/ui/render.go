// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/dustin/go-humanize"
)

// Render helpers shared by every command.
//
// These were defined in whichever `cmd/*.go` file happened to need one first — `orDash` in
// config.go and used by eight other files, `yesNo` in channels.go used by five, `formatCreatedAt`
// in connector_list.go used by three. That is why the CLI's command files could not be worked on in
// parallel: any lane touching a render had to edit a command file another lane owned. The functions
// were never the problem; their ADDRESSES were.
//
// One consequence was visible to users. The empty-value sentinel had THREE spellings — SymbolDash,
// a hardcoded "—" in token.go, and the string "N/A" in config_printer.go — so the same "nothing to
// show" rendered three ways depending on which command you ran.
//
// NOT HERE, deliberately:
//
//   - `openBrowser` (login.go) is a package var so tests can swap it. It is an ACTION, not a
//     renderer, and moving it would move a test seam for no benefit.
//   - `formatDuration` (jobs_list.go) takes a started/completed pair and appends "…" for a running
//     job. Its rule is being replaced wholesale by `packages/core/format.Duration`, so hoisting it
//     here first would move it twice.

// The empty-value sentinel is SymbolDash, in styles.go beside its siblings. This file deliberately
// does NOT introduce a second name for it.
//
// The first cut of this package exported `const Dash = SymbolDash`, reasoning that a caller should
// compare against a constant rather than write the rune again. But ~25 sites went on using
// SymbolDash directly, so the split re-created the very failure it was meant to end: change one and
// the other half of the tree keeps the old character. Three spellings became four. One name.

// OrDash renders a string, or the dash when it is empty.
func OrDash(s string) string {
	if s == "" {
		return SymbolDash
	}
	return s
}

// StrOrDash renders a nullable string, or the dash when it is unset or empty.
func StrOrDash(s *string) string {
	if s == nil || *s == "" {
		return SymbolDash
	}
	return *s
}

// IntOrDash renders a nullable int, or the dash when unset.
func IntOrDash(v *int) string {
	if v == nil {
		return SymbolDash
	}
	return fmt.Sprintf("%d", *v)
}

// FloatOrDash renders a nullable USD cost threshold, or the dash when unset.
//
// It carried `fmt.Sprintf("$%.2f", …)` until #3659 — money written with a hardcoded glyph and Go's
// `%f`, which rounds half to EVEN, so `12.125` printed `$12.12` where the console prints `$12.13`.
//
// NO `/mo`, deliberately, and this is the call #3659 left to this lane. Its one caller is
// `protection list`'s `Cost Δ` column (`protection.go`), holding a `cost_delta_threshold` — a
// number an operator TYPED, as `--cost-delta-threshold 50`. `format.MonthlyRate` is the obvious
// reach and it appends `/mo`, which would make the cell claim a periodicity the flag does not:
// the threshold is a size, not a rate. Rendering back what they typed is the reading that cannot
// mislead.
//
// So `format.Money`, whose unit is MINOR units — hence the `* 100`, which looks redundant against
// the `/ 100` inside and is not: it is what buys the shared rounding rule, and it is exact for the
// two-decimal currencies this renders. `format` exports no exact major-unit register without a
// suffix; adding one would need a `@repo/format` mirror and conformance rows for a single caller.
//
// USD is ASSUMED, as the `$` before it was. `ProtectionRule.CostDeltaThreshold` carries no currency
// on the wire, so this is the honest place for the assumption to be visible rather than baked into
// a format string. A non-USD org is shown the wrong symbol; the fix is a currency on the wire.
func FloatOrDash(v *float64) string {
	if v == nil {
		return SymbolDash
	}
	return format.Money(*v*100, "USD")
}

// Cell picks the MACHINE projection of a value under `-o csv`, and the human rendering otherwise.
//
// `Render`'s CSV branch writes `spec.Rows` verbatim (`output.go`), so whatever a row builder made
// for a person to read is also what a script receives. That is a live defect across eight tables
// and it has its own unit, #4033.
//
// What this function is for is narrower and is #3659's own debt: three cells were ALREADY
// machine-readable and this lane would otherwise have taken that away. `promotion list` emitted the
// wire's RFC3339; `token list` emitted `2026-08-26 09:41`, which sorts lexically; `project list`'s
// Updated emitted `2006-01-02`, which sorts and parses. Humanising them turns all three into
// `26 Aug 2026, 09:41` — and the COMMA is the part that bites, because it forces RFC-4180 quoting
// and every naive `cut -d,` consumer shifts a column. Improving a table for a reader must not
// silently break the scripts already reading it.
//
// So the rule this encodes is a floor, not the whole fix: DO NOT REGRESS A CELL THAT PARSED. The
// remaining humanised cells — the dash glyph, the gate ticks, the status glyph, the truncated id —
// were never machine-readable and are #4033's to decide, together and once.
//
// Both arguments are evaluated; every renderer here is pure, so that costs a string and buys a call
// site that reads as the pair it is.
func Cell(outFmt, machine, human string) string {
	if outFmt == FormatCSV {
		return machine
	}
	return human
}

// Wire returns a nullable wire value unchanged, or empty when it is absent.
//
// The machine counterpart of StrOrDash, for the CSV half of Cell: a script wants an EMPTY field
// where a reader wants an em dash, and `—` is not a value any parser has a use for.
func Wire(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// WireBool renders a boolean as `true`/`false`, the machine counterpart of the three glyph
// renderings of a boolean above — GateGlyph's tick, YesNo's dot, and DefaultCell's `◆`.
//
// The three exist because a reader is asking three different questions (is this gate on · is this
// row active · which one is the default), and the glyphs answer them at a glance. A script asks one
// question and wants one answer, so all three collapse here rather than growing three machine
// spellings. `true`/`false` and not `1`/`0`: it is what `-o json` marshals for the same field, and
// the two machine formats of one product must not disagree about what a boolean looks like.
//
// DefaultCell's false arm is the empty string rather than a glyph, so it is the one case where the
// human cell is ALREADY parseable. It still routes through here: `Default,` and `Default,false` are
// both readable, but a column that is empty on nine rows and `◆` on the tenth is a column a script
// has to know about, and `false` is the answer to the question actually being asked.
func WireBool(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// WireInt renders a nullable int as its digits, or empty when unset. The machine counterpart of
// IntOrDash.
func WireInt(v *int) string {
	if v == nil {
		return ""
	}
	return strconv.Itoa(*v)
}

// WireFloat renders a nullable float as a bare fixed-point number, or empty when unset. The machine
// counterpart of FloatOrDash.
//
// Two decimals and `strconv.FormatFloat(…, 'f', …)`, matching costMonthlyCell in `cost.go` — the
// precedent this generalises. NOT `format.Money`: the human arm's `$` is an ASSUMPTION about a
// currency the wire does not carry (see FloatOrDash), and a symbol a script has to strip is worse
// than a number. `'f'` and never `'g'`, so a large threshold cannot arrive in exponent notation.
func WireFloat(v *float64) string {
	if v == nil {
		return ""
	}
	return strconv.FormatFloat(*v, 'f', 2, 64)
}

// StampOrDash renders an RFC3339 timestamp the way the console writes an absolute date —
// `9 Mar 2026, 15:04` — in UTC, or the dash when unset.
//
// IT IS NOW Stamp'S RULE, which is the convergence #3659 owns. It rendered `2006-01-02 15:04` — a
// fifth date spelling, differing from Stamp only in the layout literal, so `token list` and
// `staged list` wrote the same instant two ways in two columns a reader compares. Stamp said
// outright that converging the two "changes what those callers show and belongs to the lane that
// owns them". This is that lane, and the change is deliberate and user-visible: `token list`,
// `token get` and `addon list` move to `9 Mar 2026, 15:04`.
//
// What survives is the part that was never about layout — the DASH. StampOrDash, Stamp and
// StampOrNever are three answers to "what does an absent timestamp mean": the dash for *we do not
// know*, the word "never" for *we know, and it has not happened*, and Stamp's verbatim echo for
// *the wire sent something we cannot read*. Delegating to Stamp keeps the one rule and the three
// answers, instead of a fourth layout.
func StampOrDash(v *string) string {
	if v == nil || strings.TrimSpace(*v) == "" {
		return SymbolDash
	}
	return Stamp(*v)
}

// Stamp renders an RFC3339 timestamp string the way the console writes an absolute date —
// `9 Mar 2026, 15:04` — in UTC.
//
// This is `packages/core/format.Date(DateTime, UTC)` with the wire's string form in front of it,
// and it exists because THREE command files needed exactly that and two of them had written their
// own: `costCapturedAt` (cost.go) and the raw echo in `staged.go`, which printed
// `2026-03-09T15:04:05Z` into a column a person reads. StampOrDash ABOVE was a different rule
// (`2006-01-02 15:04`) until #3659 converged it onto this one; it now delegates here and keeps only
// its own answer for an absent stamp. There is one absolute-date layout in the CLI.
//
// A stamp that does not parse is returned VERBATIM rather than dashed — the rule RelativeTime
// already follows: a timestamp the CLI cannot read is a wire problem, and showing it lets someone
// report what actually arrived. An EMPTY stamp is the dash, because there is nothing to report.
//
// UTC and not the host zone, for the reason format.Date states about its own parameter: a timestamp
// rendered against an ambient zone is a value that changes depending on which machine printed it.
func Stamp(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return SymbolDash
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return raw
	}
	return format.Date(t, format.DateTime, time.UTC)
}

// StampOrNever renders an RFC3339 timestamp, or the word "never" when unset.
//
// The distinction from StampOrDash is deliberate and worth keeping: a dash means "we do not know",
// "never" means "we know, and it has not happened". A token that has never been used is a different
// statement from a token whose last use we failed to read.
func StampOrNever(v *string) string {
	if v == nil || strings.TrimSpace(*v) == "" {
		return "never"
	}
	return StampOrDash(v)
}

// StatusCell renders a status as the table cell every list shows it in: the unstyled glyph, a
// space, and the status in lower case.
//
// Four files spelled this `fmt.Sprintf("%s %s", ui.PlainStatusDot(s), strings.ToLower(s))` —
// clusters_list.go, clusters_get.go, project_list.go and runner_list.go — and it is the last of the
// duplicated renders #3694 left behind. It was deliberately NOT hoisted by the runner lane, which
// was right to leave it: two lanes adding the same symbol to this file is a `redeclared in this
// block` failure that appears only at MERGE, with each branch green on its own, which is exactly
// what #3737 hit with cloudIdentityLister. It lands once, in the lane that owns this file.
//
// Lower case, because these statuses arrive SHOUTING from the wire — ACTIVE, PROVISIONING — and a
// table of capitals reads as a table of alarms. The glyph already carries the severity.
//
// It does NOT take the status message. clusters_list appends one and clusters_get puts it on its
// own row; folding that in would make the two disagree about a cell this function exists to make
// them agree about.
//
// The glyph now comes from the generated vocabulary through PlainGlyph, so this cell folds case:
// `ui.StatusCell("active")` and `ui.StatusCell("ACTIVE")` are the same cell. They were not, and
// `clusters_list.go:85` derived the glyph and the label from differently-cased inputs in one
// expression, which is the shape a defect takes when two switches disagree about one word.
func StatusCell(status string) string {
	return PlainGlyph(status) + " " + strings.ToLower(status)
}

// YesNo renders a boolean as the vocabulary's filled dot or its spent point.
//
// IT NO LONGER RETURNS THE DASH, and that is the user-visible half of this change. `◆ / —` was
// its own two-glyph vocabulary, decided here, and the "no" arm was the EMPTY-VALUE SENTINEL: an
// alert rule that is switched off and one whose `enabled` field never arrived rendered the same
// cell. `Enabled  —` is a sentence about our ignorance; a disabled rule is a fact.
//
// So a boolean is read as the two-word vocabulary it is — present and active, or present and
// inert — and it borrows the tiers that already mean exactly that. It goes through PlainGlyph
// rather than naming the glyph constants, so a change to what `active` or `disabled` looks like
// reaches this cell too.
//
// IT IS NOT THE "WHICH ONE IS THE DEFAULT?" COLUMN, and the first cut of this change made it one.
// `project env list` drew its Default column through YesNo while `runner list` and `org list` drew
// the same fact as `◆`, so one product marked the default environment `●` and the default runner
// `◆` — the two-glyph split this unit exists to end, introduced by the unit itself. That column is
// DefaultCell below; YesNo keeps the genuine per-row booleans (Enabled, Verified, Builtin).
func YesNo(b bool) string {
	if b {
		return PlainGlyph("active")
	}
	return PlainGlyph("disabled")
}

// DefaultCell marks the ONE row a "which one is the default?" column is about, and blanks every
// other. `◆` is SymbolDefault, the same mark DefaultBadge puts on a picker option.
//
// It is YesNo's opposite number and separate from it on purpose, because the two columns ask
// different questions. `Enabled` is a fact about each row and every row deserves an answer; the
// `Default` column asks WHICH ONE, and a per-row `● / ·` puts a glyph on every line and leaves the
// eye to find the odd one out. One fact, one glyph, four call sites: `runner list`, `org list`,
// `project env list` and — through DefaultBadge — the pickers.
func DefaultCell(isDefault bool) string {
	if isDefault {
		return SymbolDefault
	}
	return ""
}

// GateGlyph renders an enabled/disabled gate as a tick or the dash.
func GateGlyph(on bool) string {
	if on {
		return SymbolSuccess
	}
	return SymbolDash
}

// RelativeTime renders an RFC3339 timestamp as "3 minutes ago", the dash when empty, and the raw
// string when it does not parse.
//
// Returning the RAW value on a parse failure rather than the dash is intentional: a timestamp the
// CLI cannot read is a wire problem, and showing it lets someone report what actually arrived. A
// dash would hide it.
//
// Named for what it does rather than `formatCreatedAt`, which named ONE of its callers — the
// others pass a last-seen and a decided-at.
//
// IT NOW DELEGATES TO SmartTime, which is #3659's convergence of the CLI's three relative-time
// renderings onto one rule: relative inside a week, an absolute date beyond it. The three differed
// in their INPUT TYPE (an RFC3339 string here, a `time.Time` there, a bare `humanize.Time` call in
// two job listings) and only one carried a cutoff, so they could not be compared until #3696 put
// them in one file. The cutoff wins because "5 weeks ago" is a number nobody converts back into a
// date, and this function had no cutoff at all.
//
// User-visible: a `connector list` identity created two months ago now reads `9 Mar 2026` rather
// than `2 months ago`. Anything inside a week is unchanged, which is the overwhelming majority of
// what these columns hold.
//
// The name stays. It is still the relative renderer — "relative inside the window where relative
// helps" is the rule, and a caller asking for a person-readable age is asking for exactly that.
func RelativeTime(raw string) string {
	if raw == "" {
		return SymbolDash
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return raw
	}
	return SmartTime(t)
}

// TruncID shortens an opaque id for a table cell, with an ellipsis when it was cut.
//
// Eight characters, because that is what every existing caller used and a job id collision inside
// one org's visible list is not a realistic risk at that width.
func TruncID(id string) string {
	if len(id) > 8 {
		return id[:8] + "…"
	}
	return id
}

// SmartTime renders a timestamp relatively inside a week and absolutely beyond it: "3 hours ago",
// then "2026-03-09". The dash for a zero time.
//
// The week cutoff is the point where "ago" stops helping — nobody converts "5 weeks ago" back to a
// date in their head, and nobody wants a calendar date for something that happened this morning.
//
// This is the rule the other renderings converge ON. It was one of three — RelativeTime (always
// relative, from an RFC3339 string) and two bare `humanize.Time` calls in the job listings were the
// others — and #3659 is the lane that owns converging them. They took different input types and
// only this one had a cutoff, which is why #3696 could only put them in one file and not merge
// them. RelativeTime is now this function with a parse in front of it, and `jobs_list.go` calls it
// directly.
//
// ONE CALLER IS STILL UNCONVERGED: `jobs_select.go`'s interactive picker calls `humanize.Time` bare,
// so it prints "3 months ago" where `jobs list` now prints a date. That file is outside #3659's
// `scope:` and belongs to the jobs noun group; it is a one-line change in their lane. Stated rather
// than glossed, because a doc comment claiming "the one rule" while a second rule is live is how
// the next reader concludes there is nothing left to do.
//
// A PAST INSTANT UNDER A FUTURE-TENSE LABEL reads worse here than the relative form did, and
// `billing.go`'s `Trial ends` is the case: an expired trial past the cutoff now renders
// `Trial ends  12 Aug 2026`, where `3 weeks ago` said "it ended" without arithmetic. That call site
// is out of scope too, and the honest fix is billing choosing a label that matches the tense of
// what it holds, not this function growing a branch for one caller's wording.
//
// The absolute half is `format.Date(DateOnly)`, not a layout literal: `2006-01-02` was a sixth
// spelling of a date in a tree that had just finished agreeing on one. It renders `9 Mar 2026`.
//
// A FUTURE time stays relative however far out it is, because `time.Since` is negative for it and
// no negative exceeds the cutoff. That is not an accident of the comparison, it is the right
// reading: `billing`'s `Trial ends` wants "in 3 months", and an absolute date for a deadline the
// reader is being asked to act on is the less useful of the two. The cutoff is about the PAST,
// where "5 weeks ago" is a number nobody converts back into a date.
func SmartTime(t time.Time) string {
	if t.IsZero() {
		return SymbolDash
	}
	if time.Since(t).Hours() < 24*7 {
		return humanize.Time(t)
	}
	return format.Date(t, format.DateOnly, time.UTC)
}
