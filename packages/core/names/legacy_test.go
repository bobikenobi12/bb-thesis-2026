// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package names

import "testing"

// LegacyObjectSegment is frozen because its output is the IDENTITY of ArgoCD objects that are
// already applied. So it is pinned to values, not to a description.
//
// The `want` column is not reasoned about — it was produced by RUNNING the pre-#3665 derivation
// (packages/core/argocd/namespace_tenant.go@22dc2c17) over this corpus. Pinning a historical
// behaviour is the one case where a test may not "call the same function the code calls": there is
// no other way to state what the old code did once the old code is gone.
//
// The corpus is free-text DISPLAY NAMES, which is what the two callers actually receive
// (types.Configuration.ProjectName comes from projects.project_name). A corpus of strings that are
// already DNS-1123 labels would agree with Slugify and prove nothing.
var legacySegmentCases = []struct {
	in   string
	want string
	why  string
}{
	{"boutique", "boutique", "the ordinary case: an already-slug-shaped name is untouched"},
	{"Acme - Prod", "acme---prod", "a SPACED hyphen: the space either side becomes a dash and the hyphen survives, so three"},
	{"Bob's Project", "bob-s-project", "an apostrophe becomes a dash here; Slugify DELETES it (bobs-project)"},
	{"Foo--Bar", "foo--bar", "a doubled hyphen is not collapsed; Slugify collapses it (foo-bar)"},
	{"café", "caf", "the accented rune is DROPPED, not folded; Slugify folds it (cafe)"},
	{"  Padded  ", "padded", "surrounding whitespace is trimmed"},
	{"UPPER", "upper", "lower-cased"},
	{"a b c", "a-b-c", "each space becomes one dash"},
	{"Ünïcøde Näme", "n-c-de-n-me", "every non-ASCII rune is dropped and its run becomes a dash"},
	{"中文", "", "a script with nothing to keep slugs to empty; the callers supply their own fallback"},
	{"", "", "empty in, empty out"},
	{"---", "", "dashes alone trim away entirely"},
}

// TestLegacyObjectSegmentIsUnchanged fails if the derivation moves at all.
func TestLegacyObjectSegmentIsUnchanged(t *testing.T) {
	if len(legacySegmentCases) == 0 {
		t.Fatal("empty corpus — this test would pass without asserting anything")
	}
	for _, c := range legacySegmentCases {
		t.Run(c.in, func(t *testing.T) {
			if got := LegacyObjectSegment(c.in); got != c.want {
				t.Errorf("LegacyObjectSegment(%q) = %q, want %q\n  %s\n\n"+
					"This value NAMES AN ARGOCD OBJECT THAT IS ALREADY APPLIED. Changing it renames the "+
					"live AppProject and Application on the next deploy and orphans the existing pair. "+
					"If the change is intended, it needs a migration, not a new expectation here.",
					c.in, got, c.want, c.why)
			}
		})
	}
}

// TestLegacyObjectSegmentDiffersFromSlugify keeps the reason for TWO functions checkable.
//
// Without it, somebody could "simplify" LegacyObjectSegment into a call to SlugifyOrEmpty, and
// every case above would still have to be edited by hand — but nothing would say WHY the two
// exist. This asserts the divergence is real and names the shapes that carry it.
func TestLegacyObjectSegmentDiffersFromSlugify(t *testing.T) {
	diverging := []string{"Acme - Prod", "Bob's Project", "Foo--Bar", "café"}
	for _, in := range diverging {
		t.Run(in, func(t *testing.T) {
			legacy := LegacyObjectSegment(in)
			slug := SlugifyOrEmpty(in, SlugMaxLength)
			if legacy == slug {
				t.Errorf("LegacyObjectSegment(%q) and SlugifyOrEmpty both give %q — the two no longer "+
					"differ on a shape the frozen function exists for. Either the corpus is stale or "+
					"one of the two implementations moved.", in, legacy)
			}
		})
	}
	// And the agreement half: on a name that is already a legal label they MUST agree, which is why
	// most projects are unaffected by the gap this test pins.
	for _, in := range []string{"boutique", "boutique-dev", "1dev", "a-b-c"} {
		if LegacyObjectSegment(in) != SlugifyOrEmpty(in, SlugMaxLength) {
			t.Errorf("the two disagree on %q, which is already a legal label — the gap is wider than "+
				"the frozen function documents", in)
		}
	}
}
