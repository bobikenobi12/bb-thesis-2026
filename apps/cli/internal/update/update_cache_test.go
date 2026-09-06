// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package update

import (
	"testing"
	"time"
)

func TestDeref(t *testing.T) {
	if deref(nil) != "" {
		t.Error("nil should deref to empty")
	}
	s := "x"
	if deref(&s) != "x" {
		t.Error("expected x")
	}
}

func TestCachePath(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	p, err := cachePath()
	if err != nil {
		t.Fatalf("cachePath: %v", err)
	}
	if p == "" {
		t.Error("expected a path")
	}
}

func TestSaveAndLoadCache(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)

	want := cache{LastCheck: time.Now().Truncate(time.Second), Latest: "1.2.3", URL: "https://example.com", MinSupported: "1.0.0"}
	saveCache(want)
	got := loadCache()
	if got.Latest != "1.2.3" || got.URL != "https://example.com" || got.MinSupported != "1.0.0" {
		t.Errorf("cache round-trip mismatch: %+v", got)
	}
}

func TestCachedLatest(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)

	if _, ok := CachedLatest(); ok {
		t.Error("expected no cached version on a fresh home")
	}
	saveCache(cache{Latest: "9.9.9"})
	v, ok := CachedLatest()
	if !ok || v != "9.9.9" {
		t.Errorf("expected 9.9.9, got %q (%v)", v, ok)
	}
}

func TestNotify(t *testing.T) {
	// Writes to os.Stderr; exercise the wrapper so a regression panics here.
	notify("1.0.0", cache{Latest: "2.0.0", URL: "https://example.com/r"})
	// No newer version → no output, no panic.
	notify("2.0.0", cache{Latest: "2.0.0"})
}

func TestCheckAndNotifyShortCircuits(t *testing.T) {
	// dev build → no-op.
	CheckAndNotify("dev", "")
	CheckAndNotify("", "")

	// Disabled via env → no-op even with a real version.
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	CheckAndNotify("1.0.0", "")
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "")

	// No origin set → no-op (stdout is non-interactive in tests anyway).
	t.Setenv("ALETHIA_WEB_ORIGIN", "")
	CheckAndNotify("1.0.0", "")
}
