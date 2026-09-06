// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func TestRunPromotionList(t *testing.T) {
	c := &fakeClient{promotions: []api.Promotion{
		{ID: "p1", Source: "staging", Target: "production", Status: "PENDING_APPROVAL", CreatedAt: "2026-01-01T00:00:00.000Z"},
		{ID: "p2", Source: "dev", Target: "staging", Status: "DEPLOYED", CreatedAt: "2026-01-02T00:00:00.000Z"},
	}}
	var buf bytes.Buffer
	if err := runPromotionList(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runPromotionList: %v", err)
	}
	out := buf.String()
	// The Status cell echoed the raw enum until #3660 — shouting, glyphless, and the only status
	// column in the CLI that did. It reads through the one vocabulary now, so the words arrive
	// lower-cased behind a glyph.
	for _, want := range []string{"p1", "staging", "production", "pending_approval", "deployed"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
	// PENDING_APPROVAL is in the vocabulary since #4117 and draws the PENDING half-dot. It drew
	// the idle ○ — "present, reachable, and not doing anything" — for the whole of #3660, which on
	// the table an operator reads to find what is holding a promotion up is a wrong signal rather
	// than a missing one. The want is the rune, not types.StatusGlyphPending: a test that asked
	// the vocabulary what it says would have passed for the hollow dot too.
	if !strings.Contains(out, "◐ pending_approval") {
		t.Errorf("expected the pending half-dot on PENDING_APPROVAL, not the idle fallback:\n%s", out)
	}
	if strings.Contains(out, "○ pending_approval") {
		t.Errorf("PENDING_APPROVAL still draws the idle fallback — an approved promotion and a stopped one read alike:\n%s", out)
	}
	// DEPLOYED is not a promotion_status at all, so it is still the honest fallback. Asserted so
	// the fallback is proven to still WORK rather than proven to be unreachable.
	if !strings.Contains(out, "○ deployed") {
		t.Errorf("expected the idle fallback on a word no enum has:\n%s", out)
	}
	if strings.Contains(out, "PENDING_APPROVAL") {
		t.Errorf("the raw enum is still being printed somewhere in the table:\n%s", out)
	}
}

func TestRunPromotionListEmpty(t *testing.T) {
	c := &fakeClient{promotions: nil}
	var buf bytes.Buffer
	if err := runPromotionList(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runPromotionList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No promotions yet") {
		t.Errorf("expected empty notice, got: %q", buf.String())
	}
}

func TestRunPromotionListError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runPromotionList(c, &bytes.Buffer{}, "table", "proj", ""); err == nil {
		t.Error("expected error to propagate")
	}
}

func TestRunPromotionGet(t *testing.T) {
	c := &fakeClient{promotion: &api.PromotionDetail{
		ID: "p1", Source: "staging", Target: "production", Status: "PENDING_APPROVAL",
		Initiator: strptr("Ivo"), Approved: 1, Required: 2, CreatedAt: "2026-01-01T00:00:00.000Z",
		Approvals: []api.PromotionApproval{
			{ID: "a1", Status: "approved", Name: strptr("Ivo"), RequiredRole: strptr("admin"), DecidedAt: strptr("2026-01-01T01:00:00.000Z")},
			{ID: "a2", Status: "pending"},
		},
	}}
	var buf bytes.Buffer
	if err := runPromotionGet(c, &buf, "table", "proj", "p1"); err != nil {
		t.Fatalf("runPromotionGet: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"staging", "production", "1/2", "Ivo", "approved", "pending"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
	// The approvals table is the one an operator scans to find the slot holding the promotion up,
	// and until #4117 every row of it was a hollow ○: `approved` had no word in the vocabulary and
	// fell to the idle fallback, landing on the same glyph as the slot that has decided nothing.
	// Two rows that mean opposite things must not draw alike.
	if !strings.Contains(out, "● approved") {
		t.Errorf("an approved slot does not draw the active dot — it reads as idle:\n%s", out)
	}
	if !strings.Contains(out, "◐ pending") {
		t.Errorf("an undecided slot does not draw the pending half-dot:\n%s", out)
	}
	if strings.Contains(out, "○ approved") {
		t.Errorf("an approved slot still draws the idle fallback, whose meaning is 'not doing anything':\n%s", out)
	}
}

func TestRunPromotionGetJSON(t *testing.T) {
	c := &fakeClient{promotion: &api.PromotionDetail{ID: "p1", Status: "DEPLOYED", Approvals: []api.PromotionApproval{}}}
	var buf bytes.Buffer
	if err := runPromotionGet(c, &buf, "json", "proj", "p1"); err != nil {
		t.Fatalf("runPromotionGet json: %v", err)
	}
	if !strings.Contains(buf.String(), `"status": "DEPLOYED"`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunPromotionGetError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runPromotionGet(c, &bytes.Buffer{}, "table", "proj", "p1"); err == nil {
		t.Error("expected error to propagate")
	}
}
