// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The two-sided lock for the waiver-expiry fixture.
//
// packages/core/compat generates testdata/engine_parity.json, and the console vitest proves the TS
// engine reaches the same answers. But the fixture is generated in a package that CANNOT import
// this one, so it models the wire rule (RFC3339, unreadable means no waiver) rather than calling
// the real builder. That gap is exactly where the original defect lived: the fixture's first cut
// modelled json.Unmarshal, which refuses a malformed timestamp, while production used
// buildCompatOverride, which swallowed the parse error and left Expiry zero — read by Covers as
// "never expires". The fixture pinned an answer the apply gate never produced.
//
// So this test closes the loop from the runner's side: every waiver case in the fixture is driven
// through the REAL buildCompatOverride and the REAL Unwaived, and must reach the recorded answer.
// Same shape as packages/core/categories/secrets_runtime_read_mirror_test.go, which proves a
// generated artifact against the live predicates rather than trusting the generator.

package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/compat"
)

const parityFixtureRel = "packages/core/compat/testdata/engine_parity.json"

type wireWaiverCase struct {
	ID       string   `json:"id"`
	Controls []string `json:"controls"`
	Expiry   string   `json:"expiry"`
	Decodes  bool     `json:"decodes"`
	Now      string   `json:"now"`
	Failing  []string `json:"failing_controls"`
	Want     []string `json:"want"`
}

type wireParityFile struct {
	Waiver []wireWaiverCase `json:"waiver"`
}

// monorepoRoot walks up to the directory holding go.work. Returns "" outside a monorepo checkout,
// so packages/core stays vendorable standalone — the same escape secrets_runtime_read_mirror_test
// uses.
func monorepoRoot(t *testing.T) string {
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

func TestBuildCompatOverrideMatchesTheParityFixture(t *testing.T) {
	root := monorepoRoot(t)
	if root == "" {
		t.Skip("not a monorepo checkout — no fixture to drive")
	}
	raw, err := os.ReadFile(filepath.Join(root, parityFixtureRel))
	if err != nil {
		t.Fatalf("read %s: %v\nRegenerate: cd packages/core && UPDATE_FIXTURES=1 go test ./compat/ -run TestEngineParityFixture", parityFixtureRel, err)
	}
	var fixture wireParityFile
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode %s: %v", parityFixtureRel, err)
	}

	// Vacuity: a fixture that parsed to zero cases would make every assertion below unreachable
	// and the test would pass having proved nothing.
	if len(fixture.Waiver) == 0 {
		t.Fatalf("%s carries no waiver cases — this test would pass vacuously", parityFixtureRel)
	}
	undecodable := 0
	for _, c := range fixture.Waiver {
		if !c.Decodes {
			undecodable++
		}
	}
	if undecodable == 0 {
		t.Fatalf("%s carries no unreadable-expiry cases — the fail-open this test exists to lock is not covered", parityFixtureRel)
	}

	for _, c := range fixture.Waiver {
		t.Run(c.ID, func(t *testing.T) {
			now, err := time.Parse(time.RFC3339, c.Now)
			if err != nil {
				t.Fatalf("case %q has an unparseable `now`: %v", c.ID, err)
			}

			// Build the override exactly as the runner does from a DEPLOY job payload.
			payload := map[string]any{"controls": toAnySlice(c.Controls)}
			if c.Expiry != "" {
				payload["expiry"] = c.Expiry
			}
			ov, _ := buildCompatOverride(payload)

			// The fixture's `decodes` must describe what the real builder did.
			if c.Decodes && ov == nil && len(c.Controls) > 0 {
				t.Fatalf("fixture says the expiry %q is accepted, but buildCompatOverride refused the override", c.Expiry)
			}
			if !c.Decodes && ov != nil {
				t.Fatalf("fixture says the expiry %q is unreadable, but buildCompatOverride built an override with Expiry=%v (IsZero=%v) — that is the fail-open",
					c.Expiry, ov.Expiry, ov.Expiry.IsZero())
			}

			// And the gate must reach the recorded answer.
			controls := make([]compat.ControlResult, 0, len(c.Failing))
			for _, id := range c.Failing {
				controls = append(controls, compat.ControlResult{ID: id, Status: compat.StatusFail})
			}
			rep := &compat.Report{Controls: controls}
			got := rep.UnwaivedAt(ov, now)
			if len(got) != len(c.Want) {
				t.Fatalf("unwaived mismatch: got %v, fixture says %v", got, c.Want)
			}
			for i := range got {
				if got[i] != c.Want[i] {
					t.Fatalf("unwaived mismatch at %d: got %v, fixture says %v", i, got, c.Want)
				}
			}
		})
	}
}

func toAnySlice(in []string) []any {
	out := make([]any, 0, len(in))
	for _, s := range in {
		out = append(out, s)
	}
	return out
}
