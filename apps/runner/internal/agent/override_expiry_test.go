// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"testing"
	"time"
)

// A waiver whose expiry cannot be read must not waive anything.
//
// Both builders used to swallow the time.Parse error and leave Expiry at its zero value, and both
// Covers implementations read a zero Expiry as "never expires". So `"expiry": "garbage"` produced
// a waiver that applied FOREVER — on the two gates that exist to block an apply.
//
// verify/override.go's own comment shows the class was known: it refuses a zero Expiry for the
// ControlPlanUnavailable backstop because "a payload merely omitting expiry" would "disable the
// backstop FOREVER". That defends the MISSING-expiry route into the zero value. An UNPARSEABLE
// expiry reached the same zero value by a different route, and nothing defended that one.

// malformedExpiries are values RFC3339 does not accept. Each previously produced a
// never-expiring waiver.
var malformedExpiries = []string{
	"garbage",
	"2026-13-45",                 // month 13, day 45
	"1756728000",                 // a unix timestamp, not a timestamp string
	"2026-09-01",                 // a date with no time — RFC3339 requires the full form
	"2026-09-01 12:00:00Z",       // a space instead of the T separator
	"2026-09-01T12:00:00",        // no zone offset
	"Tue, 01 Sep 2026 12:00:00Z", // RFC1123, not RFC3339
	"",                           // empty means "no expiry" and is legal — asserted by TestOverrideBuildersAcceptAnEmptyStringExpiryAsNoExpiry
}

func TestBuildCompatOverrideRefusesAnUnreadableExpiry(t *testing.T) {
	for _, exp := range malformedExpiries {
		if exp == "" {
			continue // empty is legal; see TestOverrideBuildersAcceptAnEmptyStringExpiryAsNoExpiry
		}
		t.Run(exp, func(t *testing.T) {
			ov, _ := buildCompatOverride(map[string]any{
				"controls": []any{"COMPAT-K8S-CLOUD-AWS"},
				"expiry":   exp,
			})
			if ov != nil {
				t.Fatalf("an override with expiry %q was built; Expiry=%v, IsZero=%v — a zero Expiry waives forever",
					exp, ov.Expiry, ov.Expiry.IsZero())
			}
		})
	}
}

func TestBuildVerifyOverrideRefusesAnUnreadableExpiry(t *testing.T) {
	for _, exp := range malformedExpiries {
		if exp == "" {
			continue
		}
		t.Run(exp, func(t *testing.T) {
			ov, _ := buildVerifyOverride(map[string]any{
				"controls": []any{"IAM-WILDCARD"},
				"expiry":   exp,
			})
			if ov != nil {
				t.Fatalf("an override with expiry %q was built; Expiry=%v, IsZero=%v — a zero Expiry waives forever",
					exp, ov.Expiry, ov.Expiry.IsZero())
			}
		})
	}
}

// The other direction. Refusing everything would satisfy the tables above, so the shapes that must
// still work are asserted too — an absent expiry is the documented "no expiry" case and stays legal.
func TestOverrideBuildersStillAcceptValidExpiries(t *testing.T) {
	valid := map[string]string{
		"an RFC3339 instant in UTC": "2099-01-01T00:00:00Z",
		"with a numeric offset":     "2099-01-01T00:00:00+02:00",
		"with fractional seconds":   "2099-01-01T00:00:00.123456Z",
	}
	for name, exp := range valid {
		t.Run("compat/"+name, func(t *testing.T) {
			ov, _ := buildCompatOverride(map[string]any{"controls": []any{"C"}, "expiry": exp})
			if ov == nil {
				t.Fatalf("a valid expiry %q was refused", exp)
			}
			if ov.Expiry.IsZero() {
				t.Errorf("expiry %q parsed to the zero time, which reads as 'never expires'", exp)
			}
		})
		t.Run("verify/"+name, func(t *testing.T) {
			ov, _ := buildVerifyOverride(map[string]any{"controls": []any{"C"}, "expiry": exp})
			if ov == nil {
				t.Fatalf("a valid expiry %q was refused", exp)
			}
			if ov.Expiry.IsZero() {
				t.Errorf("expiry %q parsed to the zero time", exp)
			}
		})
	}

	t.Run("an absent expiry still means no expiry", func(t *testing.T) {
		ov, _ := buildCompatOverride(map[string]any{"controls": []any{"C"}})
		if ov == nil {
			t.Fatal("an override with no expiry was refused; omitting it is the documented no-expiry case")
		}
		if !ov.Expiry.IsZero() {
			t.Errorf("an absent expiry should leave the zero time, got %v", ov.Expiry)
		}
	})
}

// The whole point is what the GATE then does, not what the builder returns. This drives the two
// together, because a builder returning nil is only a fix if nil means "waives nothing".
func TestAnUnreadableExpiryLeavesTheControlBlocked(t *testing.T) {
	const ctl = "COMPAT-K8S-CLOUD-AWS"

	waives, _ := buildCompatOverride(map[string]any{
		"controls": []any{ctl},
		"expiry":   "2099-01-01T00:00:00Z",
	})
	if waives == nil || !waives.CoversAt(ctl, time.Now()) {
		t.Fatal("a valid, unexpired waiver should cover its control — the test's control case is broken")
	}

	malformed, _ := buildCompatOverride(map[string]any{
		"controls": []any{ctl},
		"expiry":   "garbage",
	})
	if malformed.CoversAt(ctl, time.Now()) {
		t.Error("a waiver with an unreadable expiry still covered its control — the apply would proceed")
	}
}

// The WRONG-TYPE route into the same fail-open.
//
// Closing the unparseable-STRING route was only half of it. Both builders read the field through
// asString, which returns "" for anything that is not a string — collapsing a missing expiry, an
// empty one and a wrong-typed one into one value. `compat_override` is decoded from JSON as
// map[string]any, so `{"expiry": 1756728000}` arrives as a float64, asString gave "", the parse
// never ran, and the Override was built with a ZERO Expiry — which both Covers implementations
// read as "never expires". The waiver applied forever, by a different door.
func TestOverrideBuildersRefuseANonStringExpiry(t *testing.T) {
	wrongTypes := map[string]any{
		"a unix timestamp as a number": float64(1756728000),
		"an integer":                   42,
		"a bool":                       true,
		"an object":                    map[string]any{"at": "2099-01-01T00:00:00Z"},
		"an array":                     []any{"2099-01-01T00:00:00Z"},
	}
	for name, val := range wrongTypes {
		t.Run("compat/"+name, func(t *testing.T) {
			ov, reason := buildCompatOverride(map[string]any{"controls": []any{"C"}, "expiry": val})
			if ov != nil {
				t.Fatalf("a %T expiry built an override with Expiry=%v (IsZero=%v) — that reads as 'never expires'",
					val, ov.Expiry, ov.Expiry.IsZero())
			}
			if reason == "" {
				t.Error("the refusal carried no reason; the operator sees only 'supply an override' for one they supplied")
			}
		})
		t.Run("verify/"+name, func(t *testing.T) {
			ov, reason := buildVerifyOverride(map[string]any{"controls": []any{"C"}, "expiry": val})
			if ov != nil {
				t.Fatalf("a %T expiry built an override with Expiry=%v (IsZero=%v)", val, ov.Expiry, ov.Expiry.IsZero())
			}
			if reason == "" {
				t.Error("the refusal carried no reason")
			}
		})
	}
}

// An explicit JSON `null` is ABSENT, not wrong-typed — the conventional encoding of an optional
// field, and one this codebase already produces (`evidence.ts` writes `expiry: o.expiry ?? null`).
// Refusing it would turn a legitimate no-expiry waiver into a hard block naming a field the
// operator never set. It sat in the wrong-type table for exactly one review round.
func TestOverrideBuildersTreatExplicitNullExpiryAsAbsent(t *testing.T) {
	for _, build := range []struct {
		name string
		fn   func(map[string]any) (bool, bool, string)
	}{
		{"compat", func(m map[string]any) (bool, bool, string) {
			ov, r := buildCompatOverride(m)
			return ov != nil, ov != nil && ov.Expiry.IsZero(), r
		}},
		{"verify", func(m map[string]any) (bool, bool, string) {
			ov, r := buildVerifyOverride(m)
			return ov != nil, ov != nil && ov.Expiry.IsZero(), r
		}},
	} {
		t.Run(build.name, func(t *testing.T) {
			built, zeroExpiry, reason := build.fn(map[string]any{"controls": []any{"C"}, "expiry": nil})
			if !built {
				t.Fatalf("an explicit null expiry was refused (%q); null means the field was not set", reason)
			}
			if !zeroExpiry {
				t.Error("a null expiry should leave the zero time, which is the documented no-expiry case")
			}
			if reason != "" {
				t.Errorf("a null expiry is not a refusal, got reason %q", reason)
			}
		})
	}
}

// The EMPTY-STRING route, which the tables above skip and their comments claimed was "asserted
// below". It was not: the only follow-up built a payload with no `expiry` KEY at all, which is a
// different branch of the presence → type → parse ladder. Key present, is a string, empty, so the
// parse is skipped and Expiry stays zero. Tightening `if exp != ""` into a rejection would block
// every override recorded with `expiry: ""` while the suite stayed green.
func TestOverrideBuildersAcceptAnEmptyStringExpiryAsNoExpiry(t *testing.T) {
	ov, reason := buildCompatOverride(map[string]any{"controls": []any{"C"}, "expiry": ""})
	if ov == nil {
		t.Fatalf("an empty-string expiry was refused (%q); empty means no expiry, same as absent", reason)
	}
	if !ov.Expiry.IsZero() {
		t.Errorf("an empty expiry should leave the zero time, got %v", ov.Expiry)
	}
	vv, vreason := buildVerifyOverride(map[string]any{"controls": []any{"C"}, "expiry": ""})
	if vv == nil {
		t.Fatalf("verify: an empty-string expiry was refused (%q)", vreason)
	}
	if !vv.Expiry.IsZero() {
		t.Errorf("verify: an empty expiry should leave the zero time, got %v", vv.Expiry)
	}
}

// A refusal must be distinguishable from an ABSENCE, or the log line above cannot be written.
// An absent override is the ordinary case and must stay silent; a malformed one must not.
func TestRefusalReasonDistinguishesMalformedFromAbsent(t *testing.T) {
	if _, reason := buildCompatOverride(nil); reason != "" {
		t.Errorf("no override at all is not a refusal, got reason %q — this would log on every ordinary apply", reason)
	}
	if _, reason := buildCompatOverride(map[string]any{}); reason != "" {
		t.Errorf("an empty payload is not a refusal, got %q", reason)
	}
	ov, reason := buildCompatOverride(map[string]any{"controls": []any{"C"}, "expiry": "2099-01-01T00:00:00Z"})
	if ov == nil || reason != "" {
		t.Errorf("a valid override must not be refused; ov=%v reason=%q", ov, reason)
	}
	if _, reason := buildCompatOverride(map[string]any{"controls": []any{"C"}, "expiry": "garbage"}); reason == "" {
		t.Error("a malformed expiry must carry a reason")
	}
}
