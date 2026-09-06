// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package names

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"testing"
)

// names_gen.go is generated, and CI re-runs the generator and diffs it. This file asks the
// question that gate cannot: does the CHECKED-IN Go file still say what the TypeScript source
// says?
//
// The two are not the same question. The diff-gate proves "regenerating produces no change" in an
// environment with node and a pnpm install; this test proves the same thing from a plain
// `go test ./...`, with no toolchain but Go, by reading the TypeScript source directly. A
// hand-edited names_gen.go — the exact edit its banner asks nobody to make — reds here first.

// tsSource returns the text of a repo file, located relative to THIS file rather than the working
// directory, so the test does not depend on where `go test` was invoked from.
func tsSource(t *testing.T, relFromRepoRoot string) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate this file")
	}
	// packages/core/names -> the repo root is three levels up.
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", filepath.FromSlash(relFromRepoRoot))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read %s (%v) — this test is the only check, inside `go test`, that the "+
			"generated constants still match the TypeScript they were generated from", path, err)
	}
	return string(raw)
}

// capture pulls the single capture group of re out of src, failing when the shape it looks for is
// no longer there. A pattern that stops matching must FAIL rather than yield "", which would then
// compare unequal for the wrong reason — or, worse, equal.
func capture(t *testing.T, src, what string, re *regexp.Regexp) string {
	t.Helper()
	m := re.FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("no %s in the TypeScript source (pattern %s). It was renamed or reshaped, and with "+
			"it this test's ability to compare anything at all.", what, re)
	}
	return m[1]
}

// TestGeneratedConstantsMatchTheTypeScriptSource compares every generated value against the
// TypeScript declaration it came from.
func TestGeneratedConstantsMatchTheTypeScriptSource(t *testing.T) {
	names := tsSource(t, "apps/console/lib/validations/names.ts")
	slugify := tsSource(t, "apps/console/lib/utils/slugify.ts")

	if got := capture(t, names, "DNS1123_LABEL_PATTERN_SOURCE", regexp.MustCompile(
		`(?m)^export const DNS1123_LABEL_PATTERN_SOURCE = "(.+)";$`)); got != NamespacePatternSource {
		t.Errorf("TypeScript's namespace grammar is %q, names_gen.go says %q", got, NamespacePatternSource)
	}

	// Each numeric limit, by the name it is declared under. Listed rather than derived, because the
	// point is to compare against the SOURCE TEXT: deriving them from the same generated constants
	// would compare a value with itself.
	for _, c := range []struct {
		decl string
		got  int
	}{
		{"SLUG_MAX_LENGTH", SlugMaxLength},
		{"DNS1123_LABEL_MAX_LENGTH", NamespaceMaxLength},
		{"ENVIRONMENT_NAME_MAX_LENGTH", EnvironmentNameMaxLength},
		{"ENVIRONMENT_NAME_INPUT_MAX_LENGTH", EnvironmentNameInputMaxLength},
	} {
		src := names
		if c.decl == "SLUG_MAX_LENGTH" {
			src = slugify
		}
		// DNS1123_LABEL_MAX_LENGTH is declared as `= SLUG_MAX_LENGTH`, not as a literal; accept
		// either spelling so the test pins the VALUE rather than the way it was written.
		text := capture(t, src, c.decl, regexp.MustCompile(
			fmt.Sprintf(`(?m)^export const %s = ([A-Za-z0-9_]+);$`, c.decl)))
		want, err := strconv.Atoi(text)
		if err != nil {
			if text != "SLUG_MAX_LENGTH" {
				t.Errorf("%s is declared as %q, which this test cannot resolve to a number", c.decl, text)
				continue
			}
			want = SlugMaxLength
		}
		if c.got != want {
			t.Errorf("TypeScript's %s is %d, names_gen.go says %d", c.decl, want, c.got)
		}
	}

	if got := capture(t, names, "ADDON_APP_NAME_PREFIX", regexp.MustCompile(
		`(?m)^export const ADDON_APP_NAME_PREFIX = "(.*)";$`)); got != AddOnAppNamePrefix {
		t.Errorf("TypeScript's add-on prefix is %q, names_gen.go says %q", got, AddOnAppNamePrefix)
	}

	// The add-on id budget is a DERIVED number on both sides; assert the derivation, not the literal.
	if want := NamespaceMaxLength - len(AddOnAppNamePrefix); AddOnIDMaxLength != want {
		t.Errorf("AddOnIDMaxLength is %d; %q leaves %d of a %d-character label",
			AddOnIDMaxLength, AddOnAppNamePrefix, want, NamespaceMaxLength)
	}
}

// TestReservedEnvironmentNamesMatchTheConsoleRoutes compares the generated reserved list against
// RESERVED_PROJECT_CHILD_SLUGS in the console's routing module — the list that decides which URL
// segments a console route already owns.
//
// The failure this pins is not hypothetical: a new project-scoped page adds a segment there, and
// until it reaches here the CLI happily creates an environment whose console URL is permanently
// shadowed by that page.
func TestReservedEnvironmentNamesMatchTheConsoleRoutes(t *testing.T) {
	routing := tsSource(t, "apps/console/lib/routing.ts")
	block := capture(t, routing, "RESERVED_PROJECT_CHILD_SLUGS", regexp.MustCompile(
		`(?s)export const RESERVED_PROJECT_CHILD_SLUGS = \[(.*?)\];`))
	entries := regexp.MustCompile(`"([^"]+)"`).FindAllStringSubmatch(block, -1)
	if len(entries) == 0 {
		t.Fatal("RESERVED_PROJECT_CHILD_SLUGS parsed to zero entries — the shape changed, and an " +
			"empty list would otherwise compare 'equal' to nothing being reserved")
	}
	want := make([]string, 0, len(entries))
	for _, e := range entries {
		want = append(want, e[1])
	}
	if len(want) != len(ReservedEnvironmentNames) {
		t.Fatalf("the console reserves %d project-child segments %v; names_gen.go carries %d %v",
			len(want), want, len(ReservedEnvironmentNames), ReservedEnvironmentNames)
	}
	for i := range want {
		if want[i] != ReservedEnvironmentNames[i] {
			t.Errorf("reserved[%d]: console says %q, names_gen.go says %q", i, want[i], ReservedEnvironmentNames[i])
		}
	}
}
