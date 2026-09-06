// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package ui

import (
	"strings"
	"testing"
	"time"
)

// ONE spelling of "nothing to show". Before this package there were three — SymbolDash in most
// commands, a hardcoded em dash in token.go, and the literal "N/A" in config_printer.go — so the
// same absence rendered differently depending on which command you ran.
//
// There is nothing to assert EQUAL any more, and that is the point: the earlier version of this
// test compared a second exported name against SymbolDash, which passed right up until someone
// edited one of them. Deleting the second name deleted the comparison. What is left is the only
// thing still worth pinning — the constant's VALUE, since callers that write the rune inline rather
// than reusing it are how three spellings happened in the first place.
func TestDashIsTheEmDash(t *testing.T) {
	if SymbolDash != "—" {
		t.Errorf("SymbolDash = %q (%U), want an em dash U+2014", SymbolDash, []rune(SymbolDash)[0])
	}
}

// TestYesNoIsNotTheAbsenceSentinel is the negative half, and the reason YesNo changed at all: an
// alert rule that is switched off and one whose `enabled` field never arrived rendered the same
// cell. The dash means "we could not fill this"; a disabled rule is a fact.
func TestYesNoIsNotTheAbsenceSentinel(t *testing.T) {
	if YesNo(false) == SymbolDash {
		t.Errorf("YesNo(false) = %q, the empty-value sentinel — 'no' and 'we do not know' must not be one cell", YesNo(false))
	}
	if YesNo(true) == SymbolDefault {
		t.Errorf("YesNo(true) = %q, which is the 'this is the default one' badge — two statements, one glyph", YesNo(true))
	}
}

// TestDefaultCellIsTheOneMarkForTheOneRow pins the OTHER half of that separation, which the first
// cut of #3660 got wrong: `project env list` drew its Default column through YesNo while
// `runner list` and `org list` drew the same fact as `◆`, so one product marked the default
// environment `●` and the default runner `◆`.
//
// The wants are the runes and the empty string, written out rather than read back from
// SymbolDefault — a test that asked the implementation what it does would pass for the split.
func TestDefaultCellIsTheOneMarkForTheOneRow(t *testing.T) {
	if got := DefaultCell(true); got != "◆" {
		t.Errorf("DefaultCell(true) = %q, want the brand's default mark ◆", got)
	}
	if got := DefaultCell(false); got != "" {
		t.Errorf("DefaultCell(false) = %q, want an empty cell — the column asks WHICH ONE, so every other row is blank", got)
	}
	// It is NOT the boolean renderer, and the two must not converge back onto one glyph.
	if DefaultCell(true) == YesNo(true) {
		t.Error("DefaultCell(true) and YesNo(true) are the same glyph — 'this is the default one' and 'this row is switched on' are two statements")
	}
	if DefaultCell(false) == SymbolDash {
		t.Error("DefaultCell(false) is the empty-value sentinel; a non-default row is a fact, not a cell nobody could fill")
	}
}

func TestOrDashFamily(t *testing.T) {
	s := "value"
	empty := ""
	n := 7
	f := 12.5

	cases := map[string]struct{ got, want string }{
		"OrDash passes a value through":    {OrDash("x"), "x"},
		"OrDash on empty":                  {OrDash(""), SymbolDash},
		"StrOrDash passes a value through": {StrOrDash(&s), "value"},
		"StrOrDash on nil":                 {StrOrDash(nil), SymbolDash},
		"StrOrDash on a pointer to empty":  {StrOrDash(&empty), SymbolDash},
		"IntOrDash renders the number":     {IntOrDash(&n), "7"},
		"IntOrDash on nil":                 {IntOrDash(nil), SymbolDash},
		"IntOrDash renders a legitimate 0": {IntOrDash(new(int)), "0"},
		"FloatOrDash renders the amount":   {FloatOrDash(&f), "$12.50"},
		"FloatOrDash on nil":               {FloatOrDash(nil), SymbolDash},
		// YesNo no longer returns the dash: `Enabled  —` said "we could not read this", which is a
		// different statement from "this is switched off". It borrows the two tiers that already
		// mean present-and-active and present-and-inert. The wants are the runes, not
		// PlainGlyph("active") — a test that asked the implementation what it does would pass for
		// the `◆ / —` pair this replaced.
		"YesNo true":                         {YesNo(true), "●"},
		"YesNo false":                        {YesNo(false), "◌"},
		"GateGlyph on":                       {GateGlyph(true), SymbolSuccess},
		"GateGlyph off":                      {GateGlyph(false), SymbolDash},
		"TruncID leaves a short id alone":    {TruncID("abc"), "abc"},
		"TruncID leaves exactly eight alone": {TruncID("12345678"), "12345678"},
		"TruncID cuts a long id":             {TruncID("1234567890"), "12345678…"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if c.got != c.want {
				t.Errorf("got %q, want %q", c.got, c.want)
			}
		})
	}

	// A zero is a VALUE, not an absence. `IntOrDash(new(int))` above pins that; this pins the
	// float side, where the money format makes it easy to lose.
	zero := 0.0
	if got := FloatOrDash(&zero); got == SymbolDash {
		t.Error("FloatOrDash rendered a real 0 as the dash — zero is an amount, not a missing amount")
	}
}

// The distinction between these two is the reason both exist, and it is easy to erase by
// "simplifying" one into the other: a dash means WE DO NOT KNOW, "never" means we know and it has
// not happened. A token that has never been used is a different statement from a token whose last
// use we failed to read.
func TestStampOrDashAndStampOrNeverSayDifferentThings(t *testing.T) {
	if got := StampOrDash(nil); got != SymbolDash {
		t.Errorf("StampOrDash(nil) = %q, want the dash", got)
	}
	if got := StampOrNever(nil); got != "never" {
		t.Errorf("StampOrNever(nil) = %q, want %q", got, "never")
	}
	if StampOrDash(nil) == StampOrNever(nil) {
		t.Error("the two render identically for an absent value — the distinction they exist for is gone")
	}

	// `9 Mar 2026, 15:04` since #3659 converged StampOrDash onto Stamp. The PROPERTY under test
	// is unchanged and is the point of this test: with a value present the two must AGREE, and
	// they may only differ about absence.
	stamp := "2026-03-09T15:04:05Z"
	const present = "9 Mar 2026, 15:04"
	if got := StampOrDash(&stamp); got != present {
		t.Errorf("StampOrDash = %q, want %q — minute precision in UTC", got, present)
	}
	if got := StampOrNever(&stamp); got != present {
		t.Errorf("StampOrNever = %q — with a value present it must agree with StampOrDash", got)
	}

	// Whitespace-only is absent, not a value.
	blank := "   "
	if got := StampOrDash(&blank); got != SymbolDash {
		t.Errorf("StampOrDash on whitespace = %q, want the dash", got)
	}

	// An unparseable stamp falls through to the raw string on BOTH.
	junk := "not-a-timestamp"
	if got := StampOrDash(&junk); got != junk {
		t.Errorf("StampOrDash on junk = %q, want the raw value so it can be reported", got)
	}
}

// RelativeTime returns the RAW value when it cannot parse, rather than the dash. That is
// deliberate: a timestamp the CLI cannot read is a wire problem, and showing it lets someone report
// what actually arrived. A dash would hide it.
func TestRelativeTimeShowsWhatItCannotParse(t *testing.T) {
	if got := RelativeTime(""); got != SymbolDash {
		t.Errorf("RelativeTime on empty = %q, want the dash", got)
	}
	junk := "2026-13-45T99:99:99Z"
	if got := RelativeTime(junk); got != junk {
		t.Errorf("RelativeTime on an unparseable stamp = %q, want the raw value — hiding it behind a "+
			"dash turns a wire problem into a blank cell", got)
	}
	// Inside the week it is still the humanised age. A LITERAL stamp cannot be used here: the
	// window is measured against now, so a fixed instant drifts out of it and the test would start
	// asserting the other branch a week after it was written.
	recent := time.Now().Add(-3 * time.Hour).UTC().Format(time.RFC3339)
	if got := RelativeTime(recent); !strings.Contains(got, "ago") {
		t.Errorf("RelativeTime on a stamp inside the week = %q, want a humanised relative string", got)
	}

	// Beyond the week it is the absolute date, because #3659 converged this function onto
	// SmartTime's rule. Pinned as a LITERAL rather than by calling SmartTime, which would only
	// prove the delegation compiles: if both drift together the assertion still passes.
	if got := RelativeTime("2020-03-09T15:04:05Z"); got != "9 Mar 2020" {
		t.Errorf("RelativeTime past the week cutoff = %q, want the absolute date %q", got, "9 Mar 2020")
	}
}

// SmartTime's week cutoff is the whole reason it is not RelativeTime. Asserted here, in the package
// that owns it — the caller's test in cmd/ exercises it but credits cmd's coverage, not this
// package's, so the function would otherwise be measured as untested where it actually lives.
func TestSmartTimeSwitchesAtTheWeek(t *testing.T) {
	if got := SmartTime(time.Time{}); got != SymbolDash {
		t.Errorf("SmartTime(zero) = %q, want the dash", got)
	}

	// Inside the week: relative, so a reader does not convert a date back into "this morning".
	recent := time.Now().Add(-3 * time.Hour)
	if got := SmartTime(recent); !strings.Contains(got, "ago") {
		t.Errorf("SmartTime(3h ago) = %q, want a relative rendering", got)
	}

	// Beyond it: absolute, because nobody converts "5 weeks ago" back to a date in their head.
	old := time.Now().Add(-30 * 24 * time.Hour)
	if got := SmartTime(old); strings.Contains(got, "ago") {
		t.Errorf("SmartTime(30 days ago) = %q, want an absolute date past the week cutoff", got)
	}

	// The absolute rendering is `format.Date(DateOnly)` since #3659 — `9 Mar 2020`, not the
	// `2006-01-02` layout literal this file used to assert. Pinned against a FIXED instant and a
	// LITERAL string: deriving the expectation from `format.Date` would pass just as happily if
	// both sides moved together, which is the whole failure mode a mirror is supposed to catch.
	// A 2020 instant is unambiguously past the cutoff however long this test lives.
	if got := SmartTime(time.Date(2020, 3, 9, 15, 4, 5, 0, time.UTC)); got != "9 Mar 2020" {
		t.Errorf("SmartTime past the cutoff = %q, want %q", got, "9 Mar 2020")
	}

	// The boundary itself, from both sides, because a cutoff asserted only in the middle of each
	// range is a cutoff nobody has actually located.
	justInside := time.Now().Add(-(7*24*time.Hour - time.Hour))
	if got := SmartTime(justInside); !strings.Contains(got, "ago") {
		t.Errorf("an hour inside the week = %q, want relative", got)
	}
	justOutside := time.Now().Add(-(7*24*time.Hour + time.Hour))
	if got := SmartTime(justOutside); strings.Contains(got, "ago") {
		t.Errorf("an hour outside the week = %q, want absolute", got)
	}
}

// TestStamp pins the console's absolute-date rule and the two answers that are NOT a date.
//
// The verbatim arm is the one worth naming: a timestamp the CLI cannot parse is a wire problem, and
// dashing it would hide the evidence. The dash arm is the opposite statement — there was nothing to
// show — and the two must not collapse into each other.
func TestStamp(t *testing.T) {
	for name, tc := range map[string]struct{ in, want string }{
		"an RFC3339 instant":      {"2026-03-09T15:04:05Z", "9 Mar 2026, 15:04"},
		"converted to UTC":        {"2026-03-09T17:04:05+02:00", "9 Mar 2026, 15:04"},
		"the 1st is unpadded":     {"2026-03-01T00:00:00Z", "1 Mar 2026, 00:00"},
		"empty is the dash":       {"", SymbolDash},
		"blank is the dash":       {"   ", SymbolDash},
		"unparseable is verbatim": {"yesterday", "yesterday"},
	} {
		t.Run(name, func(t *testing.T) {
			if got := Stamp(tc.in); got != tc.want {
				t.Errorf("Stamp(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// Stamp and StampOrDash are ONE rule since #3659, and differ only in what they say about an ABSENT
// timestamp. This used to assert the opposite — that the two disagreed — and its failure message
// asked whoever converged them to decide deliberately. #3659 is that decision, so the test is
// inverted rather than deleted: the property is still worth pinning, it is just the other one.
//
// The `want` here is a LITERAL, not `Stamp(raw)`. Asserting only that the two agree would pass if
// both regressed to the same wrong layout, which is exactly the shape of the bug this file exists
// to catch.
func TestStampOrDashIsStampPlusTheDash(t *testing.T) {
	raw := "2026-03-09T15:04:05Z"
	const want = "9 Mar 2026, 15:04"

	if got := Stamp(raw); got != want {
		t.Errorf("Stamp(%q) = %q, want %q", raw, got, want)
	}
	if got := StampOrDash(&raw); got != want {
		t.Errorf("StampOrDash(%q) = %q, want %q — the two absolute-stamp rules converged in #3659", raw, got, want)
	}

	// The one place they still differ, and the reason both names survive.
	if got := StampOrDash(nil); got != SymbolDash {
		t.Errorf("StampOrDash(nil) = %q, want the dash", got)
	}
	if got := Stamp(""); got != SymbolDash {
		t.Errorf("Stamp(empty) = %q, want the dash", got)
	}
}

// TestStatusCell pins the cell four command files used to build by hand: the unstyled glyph, one
// space, and the status lower-cased.
//
// Every arm of PlainStatusDot is driven through it, because the point of the hoist is that ONE
// definition decides all of them — a StatusCell that agreed with PlainStatusDot on ACTIVE and not
// on DESTROYED would still have let two tables disagree.
func TestStatusCell(t *testing.T) {
	cases := map[string]string{
		"ACTIVE":       SymbolOnline + " active",
		"ONLINE":       SymbolOnline + " online",
		"PROVISIONING": SymbolPending + " provisioning",
		"DRAINING":     SymbolOffline + " draining",
		"QUEUED":       SymbolPending + " queued",
		"CREATING":     SymbolPending + " creating",
		"UPDATING":     SymbolPending + " updating",
		"FAILED":       SymbolError + " failed",
		"DESTROYED":    "◌ destroyed",
		"OFFLINE":      SymbolOffline + " offline",
		"":             SymbolOffline + " ",
		// The wire shouts for six pgEnums and whispers for the rest; the cell folds either way.
		// `clusters_list.go` derived the glyph and the label from differently-cased inputs in one
		// expression before this, so the two halves of one cell could disagree.
		"active":     SymbolOnline + " active",
		"destroying": SymbolPending + " destroying",
	}
	for status, want := range cases {
		if got := StatusCell(status); got != want {
			t.Errorf("StatusCell(%q) = %q, want %q", status, got, want)
		}
	}

	// The glyph must be the SAME decision PlainGlyph makes, not a copy of its table. A second
	// switch here would be the duplication this function was hoisted to end, one package over.
	for _, status := range []string{"ACTIVE", "DRAINING", "FAILED", "DESTROYED", "WHATEVER", "active"} {
		if !strings.HasPrefix(StatusCell(status), PlainGlyph(status)+" ") {
			t.Errorf("StatusCell(%q) does not lead with PlainGlyph(%q)", status, status)
		}
	}
}

// Cell is the human/machine switch #3659 owes for the three cells it would otherwise have taken
// away from scripts. Both arms are asserted, because a switch that always returns one side is the
// bug in either direction.
func TestCellPicksTheMachineFormOnlyForCSV(t *testing.T) {
	const machine, human = "2026-03-09T15:04:05Z", "9 Mar 2026, 15:04"
	for name, outFmt := range map[string]string{
		"csv": FormatCSV,
	} {
		t.Run(name, func(t *testing.T) {
			if got := Cell(outFmt, machine, human); got != machine {
				t.Errorf("Cell(%q) = %q, want the machine form %q", outFmt, got, machine)
			}
		})
	}
	// Everything that is not CSV is a person: the table, JSON's fallthrough, and the empty default
	// `Render` treats as a table. Enumerated rather than asserted on one value, because "not csv"
	// is the branch a future format lands in by default and it must land on the readable side.
	for name, outFmt := range map[string]string{
		"table":       FormatTable,
		"json":        FormatJSON,
		"unset":       "",
		"unknown":     "yaml",
		"nearly csv":  "CSV",
		"csv w/space": " csv",
	} {
		t.Run(name, func(t *testing.T) {
			if got := Cell(outFmt, machine, human); got != human {
				t.Errorf("Cell(%q) = %q, want the human form %q", outFmt, got, human)
			}
		})
	}
}

// Wire is StrOrDash's machine counterpart: empty where a reader gets the dash.
func TestWireIsEmptyWhereStrOrDashIsTheDash(t *testing.T) {
	if got := Wire(nil); got != "" {
		t.Errorf("Wire(nil) = %q, want empty", got)
	}
	if got := StrOrDash(nil); got != SymbolDash {
		t.Errorf("StrOrDash(nil) = %q, want the dash — the pair only means something if they differ", got)
	}
	v := "2026-03-09T15:04:05Z"
	if got := Wire(&v); got != v {
		t.Errorf("Wire(%q) = %q, want it unchanged", v, got)
	}
	// An empty string is a value the wire sent, not an absence, and Wire does not editorialise.
	blank := ""
	if got := Wire(&blank); got != "" {
		t.Errorf("Wire(pointer to empty) = %q, want empty", got)
	}
}

// The three machine counterparts #4033 adds, each asserted AGAINST its human twin.
//
// Asserting the machine arm alone would pass for a pair that had converged on one rendering, which
// is the whole failure the human/machine split exists to prevent — so every case below also pins
// what the reader gets, and the point of each test is that the two DIFFER.

// WireBool is the machine counterpart of all three glyph renderings of a boolean.
func TestWireBoolIsABooleanWhereTheGlyphsAreThree(t *testing.T) {
	if got := WireBool(true); got != "true" {
		t.Errorf("WireBool(true) = %q, want %q", got, "true")
	}
	if got := WireBool(false); got != "false" {
		t.Errorf("WireBool(false) = %q, want %q", got, "false")
	}
	// GateGlyph, YesNo and DefaultCell are three READER vocabularies for one machine fact. Each
	// must differ from the machine form, or the pair buys nothing.
	for name, human := range map[string]string{
		"GateGlyph(true)":    GateGlyph(true),
		"GateGlyph(false)":   GateGlyph(false),
		"YesNo(true)":        YesNo(true),
		"YesNo(false)":       YesNo(false),
		"DefaultCell(true)":  DefaultCell(true),
		"DefaultCell(false)": DefaultCell(false),
	} {
		if human == "true" || human == "false" {
			t.Errorf("%s = %q — the human arm has collapsed onto the machine form, so Cell picks "+
				"between two identical values and the split is decorative", name, human)
		}
	}
}

// WireInt is IntOrDash's machine counterpart: empty where a reader gets the dash.
func TestWireIntIsEmptyWhereIntOrDashIsTheDash(t *testing.T) {
	if got := WireInt(nil); got != "" {
		t.Errorf("WireInt(nil) = %q, want empty", got)
	}
	if got := IntOrDash(nil); got != SymbolDash {
		t.Errorf("IntOrDash(nil) = %q, want the dash", got)
	}
	v := 30
	if got := WireInt(&v); got != "30" {
		t.Errorf("WireInt(30) = %q, want %q", got, "30")
	}
	// Zero is a value, not an absence — a soak of 0 minutes is a decision someone recorded.
	zero := 0
	if got := WireInt(&zero); got != "0" {
		t.Errorf("WireInt(0) = %q, want %q — zero is a value the wire sent", got, "0")
	}
}

// WireFloat is FloatOrDash's machine counterpart: a bare fixed-point number, no currency glyph.
func TestWireFloatDropsTheCurrencyFloatOrDashAssumes(t *testing.T) {
	if got := WireFloat(nil); got != "" {
		t.Errorf("WireFloat(nil) = %q, want empty", got)
	}
	if got := FloatOrDash(nil); got != SymbolDash {
		t.Errorf("FloatOrDash(nil) = %q, want the dash", got)
	}
	v := 100.0
	if got := WireFloat(&v); got != "100.00" {
		t.Errorf("WireFloat(100) = %q, want %q", got, "100.00")
	}
	// The human arm assumes USD because the wire carries no currency (see FloatOrDash). The machine
	// arm must not: a symbol a script has to strip is worse than a number.
	if human := FloatOrDash(&v); !strings.ContainsAny(human, "$€£¥") {
		t.Errorf("FloatOrDash(100) = %q, want a rendered amount — if it has stopped carrying a "+
			"symbol then WireFloat is no longer buying anything", human)
	}
	if machine := WireFloat(&v); strings.ContainsAny(machine, "$€£¥") {
		t.Errorf("WireFloat(100) = %q, want no currency symbol", machine)
	}
	// A thousands separator is what stops a cell parsing as a float, so the large case is the one
	// worth pinning: `$1,234.56` is valid RFC-4180 and shifts every `cut -d,` reader.
	big := 1234.5
	if got := WireFloat(&big); got != "1234.50" {
		t.Errorf("WireFloat(1234.5) = %q, want %q — no separator, no exponent", got, "1234.50")
	}
}
