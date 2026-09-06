// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

import (
	"strings"
	"testing"
)

// The status vocabulary is generated (apps/console/scripts/gen-go-vocab.ts), so what is worth
// testing here is NOT that the table has the values the generator put in it — that would agree
// with any bug the two shared. What is worth testing is the set of properties a CONSUMER relies
// on and that no single entry can show: that the two indexes agree, that the fold works, that no
// tier draws the empty-value sentinel, and that the gap census does not overlap the vocabulary it
// is supposed to be the complement of.
//
// The em-dash check is written with the literal rune rather than by importing packages/core/format
// so that this package keeps no dependency it does not otherwise have, and so that the assertion
// says which character it means.

// TestStatusVocabularyIsWellFormed pins the shape every consumer assumes.
func TestStatusVocabularyIsWellFormed(t *testing.T) {
	if len(StatusVocabulary) == 0 {
		t.Fatal("StatusVocabulary is empty — every test below would pass by measuring nothing")
	}

	tiers := make(map[StatusTier]bool, len(AllStatusTiers))
	for _, tier := range AllStatusTiers {
		tiers[tier] = true
	}

	seen := make(map[string]bool, len(StatusVocabulary))
	for _, w := range StatusVocabulary {
		if w.Status != strings.ToLower(w.Status) {
			t.Errorf("%q is not lower-case; StatusTierOf folds before the lookup, so this entry can never be reached", w.Status)
		}
		if seen[w.Status] {
			t.Errorf("%q appears twice in StatusVocabulary", w.Status)
		}
		seen[w.Status] = true

		if !tiers[w.Tier] {
			t.Errorf("%q resolves to the tier %q, which is not in AllStatusTiers", w.Status, w.Tier)
		}
		// Provenance is the point of the file: an entry that says nothing about where the word
		// comes from is exactly what the generator refuses to emit, so it must not be reachable.
		if w.Provenance != StatusFromEnum && w.Provenance != StatusFromWire {
			t.Errorf("%q carries the provenance %q, which is neither enum nor wire", w.Status, w.Provenance)
		}
		if len(w.Sources) == 0 {
			t.Errorf("%q has no sources — it claims a provenance and then does not say what it is", w.Status)
		}
		for _, src := range w.Sources {
			if strings.TrimSpace(src) == "" {
				t.Errorf("%q has an empty source string", w.Status)
			}
		}
		if w.Provenance == StatusFromEnum {
			// An enum-backed word's sources are `enum_name.VALUE` pairs, and the VALUE must fold to
			// the word — that equality is the whole reason case folding was the sixth defect.
			for _, src := range w.Sources {
				dot := strings.LastIndex(src, ".")
				if dot < 0 {
					t.Errorf("%q names the source %q, which is not an enum_name.VALUE pair", w.Status, src)
					continue
				}
				if strings.ToLower(src[dot+1:]) != w.Status {
					t.Errorf("%q names the source %q, whose value does not fold to it", w.Status, src)
				}
			}
		}

		if tier, ok := StatusTiers[w.Status]; !ok || tier != w.Tier {
			t.Errorf("StatusTiers[%q] = %q, ok=%v; the slice and the index disagree", w.Status, tier, ok)
		}
	}

	if len(StatusTiers) != len(StatusVocabulary) {
		t.Errorf("StatusTiers has %d entries for %d vocabulary words", len(StatusTiers), len(StatusVocabulary))
	}
}

// TestStatusGlyphsCoverEveryTier pins that every tier is drawable, and that none of them draws the
// empty-value sentinel — the defect DESTROYED carried, where a fact and a missing value shared a
// cell.
func TestStatusGlyphsCoverEveryTier(t *testing.T) {
	if len(AllStatusTiers) == 0 {
		t.Fatal("AllStatusTiers is empty")
	}
	for _, tier := range AllStatusTiers {
		glyph, ok := StatusGlyphs[tier]
		if !ok || glyph == "" {
			t.Errorf("the tier %q has no glyph — it would render as nothing, which is invisible rather than different", tier)
		}
		if glyph == "—" {
			t.Errorf("the tier %q draws the em dash, which is the empty-value sentinel (format.Dash)", tier)
		}
	}
	if len(StatusGlyphs) != len(AllStatusTiers) {
		t.Errorf("StatusGlyphs has %d entries for %d tiers", len(StatusGlyphs), len(AllStatusTiers))
	}
}

// TestStatusTierOfFoldsCase drives the lookup over both spellings of a word plus the fallback.
//
// Six pgEnums shout on the wire (project_status.ACTIVE) and the rest whisper
// (connector_status.active). The renderer this replaced compared uppercase literals with no fold,
// so half the product's own statuses missed every arm of its switch.
func TestStatusTierOfFoldsCase(t *testing.T) {
	for _, w := range StatusVocabulary {
		if got := StatusTierOf(w.Status); got != w.Tier {
			t.Errorf("StatusTierOf(%q) = %q, want %q", w.Status, got, w.Tier)
		}
		shouted := strings.ToUpper(w.Status)
		if got := StatusTierOf(shouted); got != w.Tier {
			t.Errorf("StatusTierOf(%q) = %q, want %q — the fold is what makes one word one word", shouted, got, w.Tier)
		}
		if got := StatusGlyphOf(w.Status); got != StatusGlyphs[w.Tier] {
			t.Errorf("StatusGlyphOf(%q) = %q, want the %q tier's glyph %q", w.Status, got, w.Tier, StatusGlyphs[w.Tier])
		}
	}

	// The fallback, and its silence. A word nobody has is idle on both surfaces; the honest place
	// to find out what that is swallowing is StatusVocabularyGaps.
	for _, unknown := range []string{"", "pending_customer", "not_evaluable", "🙂"} {
		if got := StatusTierOf(unknown); got != StatusTierFallback {
			t.Errorf("StatusTierOf(%q) = %q, want the fallback %q", unknown, got, StatusTierFallback)
		}
		if got := StatusGlyphOf(unknown); got != StatusGlyphs[StatusTierFallback] {
			t.Errorf("StatusGlyphOf(%q) = %q, want the fallback glyph", unknown, got)
		}
	}
}

// TestStatusVocabularyGapsAreActuallyGaps pins the census against the vocabulary it is the
// complement of.
//
// A gap that IS a vocabulary word would be a census reporting a hole that is filled — the kind of
// number that reads as work outstanding and is not. The list is expected to be non-empty; a gap
// count of zero here would mean the derivation stopped finding anything, not that the vocabulary
// became complete.
func TestStatusVocabularyGapsAreActuallyGaps(t *testing.T) {
	if len(StatusVocabularyGaps) == 0 {
		t.Fatal("StatusVocabularyGaps is empty. That is not 'the vocabulary is complete' — several " +
			"status enums provably have values with no word (stripe_webhook_event_status.done among " +
			"them), so an empty census means the generator's derivation found nothing and said so " +
			"quietly. promotion_status.APPROVED used to be the example named here and stopped being " +
			"one in #4117, which is what closing a gap looks like: the census shrinks and this " +
			"sentence has to name a different value.")
	}
	for _, g := range StatusVocabularyGaps {
		if g.Enum == "" || g.Value == "" {
			t.Errorf("a gap entry is half-empty: %+v", g)
		}
		if _, ok := StatusTiers[strings.ToLower(g.Value)]; ok {
			t.Errorf("%s.%s is reported as a gap but %q IS in the vocabulary", g.Enum, g.Value, strings.ToLower(g.Value))
		}
		// The whole reason the census exists: each of these renders as the fallback.
		if StatusTierOf(g.Value) != StatusTierFallback {
			t.Errorf("%s.%s does not resolve to the fallback, so it is not a gap", g.Enum, g.Value)
		}
	}
}
