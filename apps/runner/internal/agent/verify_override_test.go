// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import "testing"

func TestBuildVerifyOverride_Full(t *testing.T) {
	ov, _ := buildVerifyOverride(map[string]any{
		"controls": []any{"KEYLESS-001", "LEASTPRIV-001"},
		"reason":   "migration window",
		"by":       "secops@acme",
		"expiry":   "2026-07-01T00:00:00Z",
	})
	if ov == nil {
		t.Fatal("expected an override")
	}
	if len(ov.Controls) != 2 || ov.By != "secops@acme" || ov.Reason != "migration window" {
		t.Errorf("override not parsed faithfully: %+v", ov)
	}
	if ov.Expiry.IsZero() {
		t.Error("expiry should have parsed")
	}
}

func TestBuildVerifyOverride_NilAndEmpty(t *testing.T) {
	if got, _ := buildVerifyOverride(nil); got != nil {
		t.Error("nil payload → nil override")
	}
	if got, _ := buildVerifyOverride(map[string]any{}); got != nil {
		t.Error("empty payload → nil override")
	}
	if got, _ := buildVerifyOverride(map[string]any{"reason": "x"}); got != nil {
		t.Error("payload with no controls → nil override (gate stays fail-closed)")
	}
}

// REVERSED, deliberately. This test used to assert the opposite — "expected an override even with
// a bad expiry" and "an unparseable expiry should be left zero (treated as no expiry)" — so the
// behaviour was not an oversight but a recorded intention. It was wrong, and the file next door
// says why: verify/override.go refuses a zero Expiry for the ControlPlanUnavailable backstop
// because "a payload merely omitting expiry" would "disable the backstop FOREVER". That defends
// the MISSING-expiry route into the zero value. An UNPARSEABLE expiry reached the same zero value
// by another route, and leaving it zero meant a malformed timestamp waived a failing control on
// every subsequent apply.
//
// "Ignored" is the wrong disposition for a field whose absence means "never expires".
func TestBuildVerifyOverride_UnreadableExpiryRefusesTheWaiver(t *testing.T) {
	ov, _ := buildVerifyOverride(map[string]any{
		"controls": []any{"KEYLESS-001"},
		"expiry":   "not-a-date",
	})
	if ov != nil {
		t.Fatalf("an unreadable expiry must not produce a waiver; got Expiry=%v (IsZero=%v), which reads as 'never expires'",
			ov.Expiry, ov.Expiry.IsZero())
	}
}
