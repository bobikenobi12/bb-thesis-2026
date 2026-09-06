// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package update implements the CLI's "a newer version is available" notice. It
// mirrors the runner-release model: the control plane publishes releases to the
// cli_releases table (exposed at /api/releases/cli) and the CLI polls it at most
// once a day, caching the result next to the other CLI config. The check is
// bounded by a short timeout and is easy to silence (ALETHIA_NO_UPDATE_CHECK,
// CI, or a non-interactive stdout).
package update

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
)

const checkInterval = 24 * time.Hour

// cache is the persisted result of the last update check.
type cache struct {
	LastCheck       time.Time `json:"last_check"`
	Latest          string    `json:"latest_version"`
	URL             string    `json:"github_release_url"`
	MinSupported    string    `json:"min_supported_version"`
	LastNotified    time.Time `json:"last_notified,omitempty"`
	NotifiedVersion string    `json:"notified_version,omitempty"`
}

// Release is the subset of GET /api/releases/cli consumed by the updater.
type Release struct {
	Version             string  `json:"version"`
	GithubReleaseURL    *string `json:"github_release_url"`
	MinSupportedVersion *string `json:"min_supported_version"`
}

// cachePath returns the per-user path used for update-check state.
func cachePath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "alethia", "update-check.json"), nil
}

// loadCache reads the update state and degrades to an empty cache on failure.
func loadCache() cache {
	var c cache
	path, err := cachePath()
	if err != nil {
		return c
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return c
	}
	_ = json.Unmarshal(data, &c)
	return c
}

// saveCache persists update state without making a failed check fatal.
func saveCache(c cache) {
	path, err := cachePath()
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	data, err := json.Marshal(c)
	if err != nil {
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".update-check-*.json")
	if err != nil {
		return
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return
	}
	if err := tmp.Close(); err != nil {
		return
	}
	if err := os.Rename(tmpPath, path); err != nil && runtime.GOOS == "windows" {
		// Windows cannot atomically replace an existing destination. The cache is
		// optional, so a remove-and-retry fallback is safe and keeps checks working.
		_ = os.Remove(path)
		_ = os.Rename(tmpPath, path)
	}
}

// isInteractive reports whether stdout is a terminal (so we never inject the
// notice into piped/redirected output).
func isInteractive() bool {
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// FetchLatest retrieves the control plane's canonical CLI release.
func FetchLatest(origin string) (*Release, error) {
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := client.Get(strings.TrimRight(origin, "/") + "/api/releases/cli")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	var r Release
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, err
	}
	return &r, nil
}

// CheckAndNotify prints a one-line upgrade hint when a newer release exists. It
// is safe to call unconditionally — every disabling condition is handled here.
func CheckAndNotify(current, origin string) {
	if current == "" || current == "dev" {
		return
	}
	if os.Getenv("ALETHIA_NO_UPDATE_CHECK") != "" || os.Getenv("CI") != "" {
		return
	}
	if !isInteractive() {
		return
	}
	if origin == "" {
		return
	}

	c := loadCache()
	if time.Since(c.LastCheck) > checkInterval {
		// Back off on the timestamp regardless of outcome so a flaky/offline
		// control plane never turns into a check on every invocation.
		c.LastCheck = time.Now()
		if r, err := FetchLatest(origin); err == nil {
			c.Latest = r.Version
			c.URL = deref(r.GithubReleaseURL)
			c.MinSupported = deref(r.MinSupportedVersion)
		}
		saveCache(c)
	}

	if shouldNotify(current, c) {
		notify(current, c)
		c.LastNotified = time.Now()
		c.NotifiedVersion = c.Latest
		saveCache(c)
	}
}

// CachedLatest returns the last-known latest version (for `alethia version`).
func CachedLatest() (string, bool) {
	c := loadCache()
	if c.Latest == "" {
		return "", false
	}
	return c.Latest, true
}

// IsNewer reports whether latest is a valid version newer than current.
func IsNewer(latest, current string) bool {
	return compareSemver(latest, current) > 0
}

// shouldNotify applies the once-per-day reminder policy for each release.
func shouldNotify(current string, c cache) bool {
	if !IsNewer(c.Latest, current) {
		return false
	}
	return c.NotifiedVersion != c.Latest || time.Since(c.LastNotified) > checkInterval
}

// notify writes an update reminder to stderr.
func notify(current string, c cache) {
	notifyTo(os.Stderr, current, c)
}

// notifyTo writes the upgrade notice to w when c.Latest is newer than current.
// Split out from notify so the formatting/threshold logic is unit-testable.
func notifyTo(w io.Writer, current string, c cache) {
	if c.Latest == "" || compareSemver(c.Latest, current) <= 0 {
		return
	}

	hint := ui.MutedStyle.Render("Run `alethia update`")
	if c.URL != "" {
		hint += ui.MutedStyle.Render(" · " + c.URL)
	}

	fmt.Fprintln(w)
	if c.MinSupported != "" && compareSemver(c.MinSupported, current) > 0 {
		fmt.Fprintln(w, ui.StrongStyle.Render(
			fmt.Sprintf("%s This alethia version is below the minimum supported (%s).", ui.SymbolPoint, c.MinSupported)))
	} else {
		fmt.Fprintln(w, ui.StrongStyle.Render(
			fmt.Sprintf("%s A new version of alethia is available: %s → %s", ui.SymbolArrow, current, c.Latest)))
	}
	fmt.Fprintln(w, "  "+hint)
}

// deref converts an optional wire string into its empty-safe value.
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// compareSemver compares dotted versions, ignoring any pre-release suffix
// (e.g. "1.2.0-next"). Returns -1, 0, or 1.
func compareSemver(a, b string) int {
	pa, pb := parseSemver(a), parseSemver(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// parseSemver parses the stable numeric portion of a release version.
func parseSemver(v string) [3]int {
	v = strings.TrimPrefix(v, "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	var out [3]int
	for i, part := range strings.SplitN(v, ".", 3) {
		if i > 2 {
			break
		}
		n, _ := strconv.Atoi(strings.TrimSpace(part))
		out[i] = n
	}
	return out
}
