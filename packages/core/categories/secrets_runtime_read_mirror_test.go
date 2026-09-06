// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Go half of the secrets runtime-read mirror lock (#1621).
//
// apps/console/scripts/gen-secrets-runtime-read.mjs generates the console's answer to "can a cluster
// resolve secrets from this store?" by reading THIS package's source as text, looking for a
// `saasSecretStore` / `keylessSecretStore` hook on each `register("secrets", …)` call. CI diff-checks
// the generated file, so the console cannot drift from what the generator read.
//
// What that alone does not prove is that the generator read the source CORRECTLY. A text parse and
// the linker can disagree: register a hook through a helper, build the behavior struct in a variable,
// rename the field — and the parse quietly reports "no hook" while the runtime happily renders a
// store. That is the fail-open direction, and it is the one that puts a store in the canvas the
// cluster cannot resolve.
//
// So this test closes the loop from the other side: it reads the GENERATED artifact and asserts it
// against the live predicates. Same shape as test/e2e/w1_services_contract_pure_test.go, where TS
// emits a fixture and an untagged pure Go test proves the Go side still agrees with it.
//
// Untagged and pure — no cloud, no docker. It skips only outside a monorepo checkout.

package categories

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// mirrorPath is the generated artifact, relative to the repo root.
const mirrorPath = "apps/console/lib/connectors/generated/secrets-runtime-read.ts"

// mirrorRepoRoot walks up to the monorepo root, identified by go.work. "" when this is not a
// monorepo checkout (a consumer vendoring packages/core alone), in which case the test skips rather
// than false-alarming on a file that was never meant to be there.
func mirrorRepoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// mirrorEntry matches one generated row: `"aws-sm-xacct": true, // keylessSecretStore`.
var mirrorEntry = regexp.MustCompile(`"([^"]+)":\s*(true|false)\s*,`)

// readMirror parses the generated table into slug → runtime-readable.
func readMirror(t *testing.T, root string) map[string]bool {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(root, mirrorPath))
	if err != nil {
		t.Fatalf("read %s (regenerate: pnpm -C apps/console run gen:secrets-runtime-read): %v", mirrorPath, err)
	}
	out := map[string]bool{}
	for _, m := range mirrorEntry.FindAllStringSubmatch(string(raw), -1) {
		out[m[1]] = m[2] == "true"
	}
	if len(out) == 0 {
		t.Fatalf("%s parsed to zero entries — the generated shape changed; update mirrorEntry", mirrorPath)
	}
	return out
}

// runtimeReadable is the fact the console mirrors: EITHER hook means the cluster can read the store.
// They are not interchangeable (a SaaS store replaces the native one, a keyless cross-account store
// is additive), but for "will this resolve at all?" either is a yes.
func runtimeReadable(slug string) bool {
	return IsSaaSSecretStore(slug) || IsKeylessSecretStore(slug)
}

// TestSecretsRuntimeReadMirrorMatchesGo is the lock: every registered secrets slug appears in the
// generated table with the value the live predicates produce.
func TestSecretsRuntimeReadMirrorMatchesGo(t *testing.T) {
	root := mirrorRepoRoot(t)
	if root == "" {
		t.Skip("go.work not found; not in a monorepo checkout — skipping the generated-mirror lock")
	}
	mirror := readMirror(t, root)

	registered := map[string]bool{}
	for key := range behaviors {
		slug, ok := strings.CutPrefix(key, "secrets/")
		if !ok {
			continue
		}
		registered[slug] = true

		want := runtimeReadable(slug)
		got, present := mirror[slug]
		if !present {
			t.Errorf("secrets/%s is registered in Go but missing from %s — the console reads an absent "+
				"slug as selectable, so a missing row is the fail-open direction. Run "+
				"`pnpm -C apps/console run gen:secrets-runtime-read`.", slug, mirrorPath)
			continue
		}
		if got != want {
			t.Errorf("secrets/%s: generated mirror says runtime-read=%v, Go says %v "+
				"(saas=%v keyless=%v). Either the hooks moved and the mirror is stale — run "+
				"`pnpm -C apps/console run gen:secrets-runtime-read` — or the generator's text parse no longer "+
				"sees how this provider registers its store.",
				slug, got, want, IsSaaSSecretStore(slug), IsKeylessSecretStore(slug))
		}
	}

	// The other direction: a row for a slug nothing registers. Harmless to the canvas today, but it
	// means the generated file is no longer a reading of this package, which is the only reason to
	// trust it.
	for slug := range mirror {
		if !registered[slug] {
			t.Errorf("%s carries %q, which no register(\"secrets\", …) call defines — the mirror has "+
				"drifted from the source it claims to generate from.", mirrorPath, slug)
		}
	}
}

// TestSecretsRuntimeReadMirrorIsTotalOverCatalog proves the generated table covers every secrets slug
// the console can OFFER, not merely every slug Go happens to register. Absence is what #1510 turned
// into a silent exclusion; here it would be a silent permission.
func TestSecretsRuntimeReadMirrorIsTotalOverCatalog(t *testing.T) {
	root := mirrorRepoRoot(t)
	if root == "" {
		t.Skip("go.work not found; not in a monorepo checkout — skipping the generated-mirror lock")
	}
	mirror := readMirror(t, root)

	// metaIndex is catalog.json as this package embeds it — the same file the generator reads for
	// its own totality check, so the two guards cannot disagree about what "offerable" means.
	for key, p := range metaIndex {
		if p.Category != "secrets" {
			continue
		}
		if _, ok := mirror[p.Slug]; !ok {
			t.Errorf("catalog.json offers %s but %s has no row for it — run "+
				"`pnpm -C apps/console run gen:secrets-runtime-read` (it fails closed on this).", key, mirrorPath)
		}
	}
}
