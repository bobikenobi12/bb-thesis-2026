// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package compat

import (
	"slices"
	"time"
)

// Override records an authorized, time-boxed waiver of one or more failing
// compatibility controls so the fail-closed apply gate can be passed deliberately
// rather than disabled wholesale. Mirrors verify.Override — the apply-time unit
// (#1215) threads it through the same Unwaived/Override machinery.
type Override struct {
	// Controls is the set of control IDs explicitly waived (e.g. "COMPAT-COMPONENT-ARGOCD").
	Controls []string `json:"controls"`
	// Reason is the human justification.
	Reason string `json:"reason"`
	// By identifies the principal who authorized the waiver.
	By string `json:"by"`
	// Expiry is when the waiver stops applying. A zero value means no expiry.
	Expiry time.Time `json:"expiry"`
}

// Covers reports whether this override currently waives a given control ID.
// Nil-safe on the receiver, and false for an expired waiver.
func (ov *Override) Covers(id string) bool {
	return ov.CoversAt(id, time.Now())
}

// CoversAt is Covers evaluated at an explicit instant.
//
// The clock is a parameter so this decision can be pinned in a fixture. That matters here more
// than it usually would: the TS mirror (apps/console/lib/compat/engine.ts) claims to produce
// "byte-for-byte the same verdict", and the waiver check is one of the two places it did not —
// `new Date("garbage").getTime()` is NaN, and `NaN < now` is false, so an unparseable expiry made
// a waiver valid FOREVER on the console side. A fail-open in the check that decides whether a
// fail-closed apply gate may be passed.
//
// Go never had that bug, and the reason is worth recording: Expiry is a time.Time, so a malformed
// value fails json.Unmarshal at the boundary and the Override never exists. The type did the work.
// The cross-language parity fixture therefore carries expiry as a RAW STRING, so the TS side is
// held to the answer Go reaches by refusing to decode it at all.
func (ov *Override) CoversAt(id string, now time.Time) bool {
	if ov == nil {
		return false
	}
	if !ov.Expiry.IsZero() && now.After(ov.Expiry) {
		return false
	}
	return slices.Contains(ov.Controls, id)
}

// Unwaived returns the IDs of controls that FAILED and are NOT covered by a valid
// override. A non-empty result means the apply must stay blocked.
func (r *Report) Unwaived(ov *Override) []string {
	return r.UnwaivedAt(ov, time.Now())
}

// UnwaivedAt is Unwaived evaluated at an explicit instant. See CoversAt for why the clock is a
// parameter.
func (r *Report) UnwaivedAt(ov *Override, now time.Time) []string {
	var out []string
	for _, c := range r.Controls {
		if c.Status != StatusFail {
			continue
		}
		if ov.CoversAt(c.ID, now) {
			continue
		}
		out = append(out, c.ID)
	}
	return out
}
