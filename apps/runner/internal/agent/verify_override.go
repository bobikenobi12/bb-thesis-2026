// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"fmt"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

// buildVerifyOverride converts a DEPLOY job's `verify_override` JSON payload into a
// verify.Override the provisioner gate understands. Returns nil when there is no
// waiver or it carries no controls (so the gate stays fail-closed by default).
// Authorization is the console's job (it sets `by` to the actor and persists the
// row only for principals allowed to deploy) — the runner just honours what was
// recorded.
func buildVerifyOverride(raw map[string]any) (*verify.Override, string) {
	if len(raw) == 0 {
		return nil, ""
	}
	controls := toStringSlice(raw["controls"])
	if len(controls) == 0 {
		return nil, "the verify override lists no controls"
	}
	ov := &verify.Override{
		Controls: controls,
		Reason:   asString(raw["reason"]),
		By:       asString(raw["by"]),
	}
	// PRESENCE, then type, then parse. Reading through asString collapsed three different
	// payloads into one empty string: a missing expiry, an empty one, and a WRONG-TYPED one.
	// `{"expiry": 1756728000}` decodes to float64, asString returns "", the parse never ran, and
	// the Override was built with a zero Expiry — which both Covers implementations read as
	// "never expires". Closing only the unparseable-string route left the wrong-type route into
	// the same fail-open wide open.
	if rawExpiry, present := raw["expiry"]; present && rawExpiry != nil {
		// An explicit JSON `null` is ABSENT, not wrong-typed, and is handled by the `!= nil` above.
		// It is the conventional encoding of an optional field and this codebase already produces
		// it — evidence.ts writes `expiry: o.expiry ?? null` — so refusing it would turn a
		// legitimate no-expiry waiver into a hard block citing a field the operator never set.
		exp, isString := rawExpiry.(string)
		if !isString {
			// A number, a bool, an object, an array: values someone MEANT, in a type this field
			// cannot carry. Not something to guess at.
			return nil, fmt.Sprintf("the verify override's `expiry` is a %T, not an RFC3339 string", rawExpiry)
		}
		if exp != "" {
			t, err := time.Parse(time.RFC3339, exp)
			if err != nil {
				// An expiry we cannot READ is not a waiver. Refusing the whole override matches
				// what this function already does for an empty control list: fail closed, and let
				// the apply stay blocked.
				return nil, fmt.Sprintf("the verify override's `expiry` %q is not RFC3339 (want e.g. 2099-01-02T15:04:05Z)", exp)
			}
			ov.Expiry = t
		}
	}
	return ov, ""
}

// toStringSlice coerces a JSON array (or single string) of control ids to []string.
func toStringSlice(v any) []string {
	switch t := v.(type) {
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			if s, ok := e.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	case []string:
		return t
	case string:
		if t == "" {
			return nil
		}
		return []string{t}
	default:
		return nil
	}
}

// asString narrows an any to a string (empty when not a string).
func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
