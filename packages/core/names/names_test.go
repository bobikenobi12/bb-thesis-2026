// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package names

import (
	"strings"
	"testing"
)

// What the conformance table cannot cover, because it is about Go's own signatures rather than
// about agreeing with TypeScript.

// TestSlugifyNeverReturnsEmpty pins the whole point of the two-argument signature.
func TestSlugifyNeverReturnsEmpty(t *testing.T) {
	for _, in := range []string{"", "@#$%", "''", "---", "🚀", "中文"} {
		if got := Slugify(in, "fallback", 0); got != "fallback" {
			t.Errorf("Slugify(%q, \"fallback\") = %q, want the fallback", in, got)
		}
	}
	if got := Slugify("Acme Cloud", "fallback", 0); got != "acme-cloud" {
		t.Errorf("a name that slugs fine must not take the fallback; got %q", got)
	}
}

// TestSlugifySlugifiesTheFallbackToo: the return value must satisfy the namespace grammar whether
// it came from the name or from the fallback, or the fallback is a second way to produce an
// illegal name.
func TestSlugifySlugifiesTheFallbackToo(t *testing.T) {
	got := Slugify("", "Env For Café", 0)
	if got != "env-for-cafe" {
		t.Errorf("Slugify(\"\", \"Env For Café\") = %q, want %q", got, "env-for-cafe")
	}
	if !IsNamespace(got) {
		t.Errorf("%q is not a legal namespace", got)
	}
}

// TestSlugifyPanicsOnAnUnusableFallback pins the loud failure. The alternative — returning "" —
// is the bug the whole package exists to close, so it must not be reachable quietly.
func TestSlugifyPanicsOnAnUnusableFallback(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("Slugify returned instead of panicking on a fallback that slugs to nothing")
		}
		msg, ok := r.(string)
		if !ok || !strings.Contains(msg, "slugs to nothing") {
			t.Errorf("panic value %#v does not say what went wrong", r)
		}
	}()
	_ = Slugify("@#$", "!!!", 0)
}

// TestSlugifyOrEmptyDefaultsTheCap: callers pass 0 to mean "the standard cap", and getting an
// UNCAPPED slug instead is precisely the defect chartSlug shipped.
func TestSlugifyOrEmptyDefaultsTheCap(t *testing.T) {
	long := strings.Repeat("a", SlugMaxLength+20)
	if got := SlugifyOrEmpty(long, 0); len(got) != SlugMaxLength {
		t.Errorf("SlugifyOrEmpty(<%d chars>, 0) produced %d characters; want %d",
			len(long), len(got), SlugMaxLength)
	}
	if got := SlugifyOrEmpty(long, -1); len(got) != SlugMaxLength {
		t.Errorf("a negative cap must also mean the standard cap; got %d characters", len(got))
	}
}

// TestBounded caps an assembled name and never leaves a trailing hyphen behind.
func TestBounded(t *testing.T) {
	if got := Bounded("short-name"); got != "short-name" {
		t.Errorf("Bounded left a name inside the limit alone? got %q", got)
	}
	// 62 characters then "-x": the cut lands on the hyphen, which must not survive.
	name := strings.Repeat("a", SlugMaxLength-1) + "-x"
	got := Bounded(name)
	if len(got) > SlugMaxLength {
		t.Errorf("Bounded(%d chars) = %d chars, over the %d limit", len(name), len(got), SlugMaxLength)
	}
	if strings.HasSuffix(got, "-") {
		t.Errorf("Bounded left a trailing hyphen: %q", got)
	}
	if !IsNamespace(got) {
		t.Errorf("Bounded produced %q, which is not a legal DNS-1123 label", got)
	}
}

// TestSlugifyIsIdempotentOnEveryLegalNamespace is the property that makes it safe to route the
// runner's existing namers through this package: for a name that ALREADY satisfies the grammar,
// slugifying must be the identity.
//
// Without it, adopting names.SlugifyOrEmpty inside argocd's namers would risk renaming live
// ArgoCD Applications, and "it looked the same in the cases I tried" is not that guarantee.
func TestSlugifyIsIdempotentOnEveryLegalNamespace(t *testing.T) {
	legal := []string{
		"a", "1", "z9", "a-b", "boutique-dev", "1dev", "12345",
		"a-b-c-d-e-f", strings.Repeat("a", SlugMaxLength),
		strings.Repeat("ab-", 20) + "c",
	}
	for _, in := range legal {
		if !IsNamespace(in) {
			t.Fatalf("the corpus is wrong: %q is not a legal namespace, so this test proves nothing about it", in)
		}
		if got := SlugifyOrEmpty(in, SlugMaxLength); got != in {
			t.Errorf("SlugifyOrEmpty(%q) = %q; a name that is already legal must be left alone", in, got)
		}
	}
}

// TestUTF16LengthMatchesJavaScript pins the measure the generated limits are written against.
// Go's len() would count bytes and RuneCountInString would count runes; JavaScript counts UTF-16
// code units, and every ENVIRONMENT_NAME_INPUT_MAX_LENGTH-style bound came from a TypeScript file.
func TestUTF16LengthMatchesJavaScript(t *testing.T) {
	for _, c := range []struct {
		in   string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"café", 4}, // one accented rune, two bytes
		{"🚀", 2},    // one astral rune, a surrogate PAIR in UTF-16
		{"a🚀b", 4},
		{"中文", 2},
	} {
		if got := utf16Len(c.in); got != c.want {
			t.Errorf("utf16Len(%q) = %d, JavaScript's .length is %d", c.in, got, c.want)
		}
	}
}
