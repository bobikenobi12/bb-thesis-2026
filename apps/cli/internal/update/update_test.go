// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package update

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCompareSemver(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.2.3", "1.2.3", 0},
		{"1.2.4", "1.2.3", 1},
		{"1.2.3", "1.2.4", -1},
		{"1.3.0", "1.2.9", 1},
		{"2.0.0", "1.9.9", 1},
		{"1.2.0", "1.2.0-next", 0}, // pre-release suffix ignored
		{"v1.2.3", "1.2.3", 0},     // leading v stripped
		{"1.2", "1.2.0", 0},        // missing patch treated as 0
		{"1.10.0", "1.9.0", 1},     // numeric, not lexical
		{"0.1.0", "0.2.0", -1},
	}
	for _, c := range cases {
		if got := compareSemver(c.a, c.b); got != c.want {
			t.Errorf("compareSemver(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestParseSemver(t *testing.T) {
	if got := parseSemver("v3.14.159-next"); got != [3]int{3, 14, 159} {
		t.Errorf("parseSemver = %v", got)
	}
}

func TestFetchLatest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/releases/cli" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"version":"9.9.9","release_notes":"x","released_at":"2026-06-21T00:00:00.000Z","github_release_url":"https://example.com/r","min_supported_version":null}`))
	}))
	defer srv.Close()

	r, err := FetchLatest(srv.URL)
	if err != nil {
		t.Fatalf("fetchLatest: %v", err)
	}
	if r.Version != "9.9.9" || r.GithubReleaseURL == nil || *r.GithubReleaseURL != "https://example.com/r" {
		t.Fatalf("unexpected release: %+v", r)
	}
}

func TestNotifyTo(t *testing.T) {
	var buf bytes.Buffer

	// Newer available → notice with both versions and the upgrade hint.
	notifyTo(&buf, "1.0.0", cache{Latest: "1.2.0", URL: "https://example.com/r"})
	out := buf.String()
	if !strings.Contains(out, "1.0.0") || !strings.Contains(out, "1.2.0") {
		t.Errorf("expected both versions, got: %q", out)
	}
	if !strings.Contains(out, "alethia update") || !strings.Contains(out, "example.com/r") {
		t.Errorf("expected upgrade hint, got: %q", out)
	}

	// Up to date → silent.
	buf.Reset()
	notifyTo(&buf, "1.2.0", cache{Latest: "1.2.0"})
	if buf.Len() != 0 {
		t.Errorf("expected no output when current, got: %q", buf.String())
	}

	// Below the minimum supported → stronger wording.
	buf.Reset()
	notifyTo(&buf, "1.0.0", cache{Latest: "2.0.0", MinSupported: "1.5.0"})
	if !strings.Contains(buf.String(), "minimum supported") {
		t.Errorf("expected min-supported warning, got: %q", buf.String())
	}
}

func TestShouldNotifyAtMostDailyPerRelease(t *testing.T) {
	now := time.Now()
	if shouldNotify("1.0.0", cache{Latest: "1.1.0", LastNotified: now, NotifiedVersion: "1.1.0"}) {
		t.Fatal("same release should not repeat within a day")
	}
	if !shouldNotify("1.0.0", cache{Latest: "1.1.0", LastNotified: now.Add(-25 * time.Hour), NotifiedVersion: "1.1.0"}) {
		t.Fatal("same release should repeat after a day")
	}
	if !shouldNotify("1.0.0", cache{Latest: "1.2.0", LastNotified: now, NotifiedVersion: "1.1.0"}) {
		t.Fatal("a new release should notify immediately")
	}
}
