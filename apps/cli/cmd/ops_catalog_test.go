// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// opsActions (ops_fields.go) is a MIRROR of the server's break-glass catalog, and this file is what
// makes that word mean something.
//
// The catalog lives in apps/console/lib/breakglass/catalog.ts and there is no generated Go copy of
// it — `pnpm -F console gen:go-enums` mirrors the drizzle enums, and `breakglass_action` is not
// among them (see the handover in the PR). So the Go table is typed by hand, which is exactly the
// shape of every list this repository has watched go stale. Rather than trust it, this guard reads
// the TypeScript and fails on any disagreement in either direction: an action the server has and
// the CLI does not, one the CLI has and the server does not, and any difference in blast radius,
// read-only-ness or the two-person requirement.
//
// The stake is not tidiness. `ReadOnly` is what decides whether a verb confirms and whether it
// sends the typed-confirm, and `RequiresApproval` is what `ops approve` offers. A mutating action
// mirrored as read-only ships a break-glass verb with no confirmation at all.

// opsCatalogEntry is one parsed BREAKGLASS_CATALOG entry.
type opsCatalogEntry struct {
	Blast            string
	ReadOnly         bool
	RequiresApproval bool
}

// opsCatalogHeader matches the start of one entry: a key at one tab of indentation opening a block.
var opsCatalogHeader = regexp.MustCompile(`(?m)^\t([a-z_]+): \{$`)

// opsCatalogParse extracts the catalog from the TypeScript source.
//
// It is a FUNCTION rather than inline assertions so that the guard below and its own fixture test
// call the same code: a parser verified only against the file it parses cannot tell "the catalog
// agrees" from "I read nothing out of it".
func opsCatalogParse(source string) map[string]opsCatalogEntry {
	start := strings.Index(source, "BREAKGLASS_CATALOG")
	if start < 0 {
		return nil
	}
	body := source[start:]
	// The object literal ends at the first line that is exactly `};` — the entries are indented,
	// so no nested block can produce one.
	if end := strings.Index(body, "\n};"); end >= 0 {
		body = body[:end]
	}

	heads := opsCatalogHeader.FindAllStringSubmatchIndex(body, -1)
	out := map[string]opsCatalogEntry{}
	for i, h := range heads {
		name := body[h[2]:h[3]]
		segEnd := len(body)
		if i+1 < len(heads) {
			segEnd = heads[i+1][0]
		}
		seg := body[h[1]:segEnd]
		out[name] = opsCatalogEntry{
			Blast:            opsCatalogString(seg, "blastRadius"),
			ReadOnly:         opsCatalogBool(seg, "readOnly"),
			RequiresApproval: opsCatalogBool(seg, "requiresApproval"),
		}
	}
	return out
}

// opsCatalogString reads a `key: "value"` property out of one entry's segment.
func opsCatalogString(segment, key string) string {
	m := regexp.MustCompile(key + `:\s*"([a-z]+)"`).FindStringSubmatch(segment)
	if m == nil {
		return ""
	}
	return m[1]
}

// opsCatalogBool reads a `key: true|false` property out of one entry's segment.
func opsCatalogBool(segment, key string) bool {
	m := regexp.MustCompile(key + `:\s*(true|false)`).FindStringSubmatch(segment)
	return m != nil && m[1] == "true"
}

// TestOpsCatalog_ParserReadsEveryProperty drives the parser against a fixture whose three entries
// differ in every field.
//
// Without this the guard below could pass while the parser returned zero-valued entries for
// everything: `readOnly: false` and "I could not find readOnly" are the same value in Go, and a
// mirror check comparing two piles of zeroes agrees perfectly. The fixture also carries a nested
// object and a comment, because the real file has both.
func TestOpsCatalog_ParserReadsEveryProperty(t *testing.T) {
	const fixture = "export const BREAKGLASS_CATALOG: Record<X, Y> = {\n" +
		"\tread_thing: {\n\t\tblastRadius: \"none\",\n\t\treadOnly: true,\n\t\trequiresApproval: false,\n\t\trequiresResourceId: true,\n\t\tdescription: \"reads\",\n\t},\n" +
		"\twrite_thing: {\n\t\tblastRadius: \"medium\",\n\t\treadOnly: false,\n\t\trequiresApproval: false,\n\t\t// a comment, as the real file has\n\t\tdescription: \"writes\",\n\t},\n" +
		"\tdanger_thing: {\n\t\tblastRadius: \"high\",\n\t\treadOnly: false,\n\t\trequiresApproval: true,\n\t\tinert: true,\n\t\tdescription: \"destroys\",\n\t},\n" +
		"};\n\nexport function catalogSpec() {}\n"

	got := opsCatalogParse(fixture)
	want := map[string]opsCatalogEntry{
		"read_thing":   {Blast: "none", ReadOnly: true, RequiresApproval: false},
		"write_thing":  {Blast: "medium", ReadOnly: false, RequiresApproval: false},
		"danger_thing": {Blast: "high", ReadOnly: false, RequiresApproval: true},
	}
	if len(got) != len(want) {
		t.Fatalf("parsed %d entries, want %d: %v", len(got), len(want), got)
	}
	for name, w := range want {
		g, ok := got[name]
		if !ok {
			t.Errorf("entry %q was not parsed", name)
			continue
		}
		if g != w {
			t.Errorf("entry %q parsed as %+v, want %+v", name, g, w)
		}
	}
	if got := opsCatalogParse("nothing here"); got != nil {
		t.Errorf("a source with no catalog parses to nil, got %v", got)
	}
}

// TestOpsCatalog_GoTableMirrorsTheServer is the mirror check itself.
func TestOpsCatalog_GoTableMirrorsTheServer(t *testing.T) {
	root := authFormRepoRoot(t)
	path := filepath.Join(root, "apps", "console", "lib", "breakglass", "catalog.ts")
	body, err := os.ReadFile(path)
	if err != nil {
		// A verdict this guard cannot reach is a FAILURE, never a skip: "I could not look" and
		// "I looked and they agree" must not be the same result.
		t.Fatalf("read %s: %v — the Go mirror's verdict depends on this file", path, err)
	}

	server := opsCatalogParse(string(body))
	if len(server) == 0 {
		t.Fatalf("parsed no entries out of %s — the file's shape changed and every assertion "+
			"below would pass having compared nothing", path)
	}

	seen := map[string]bool{}
	for _, a := range opsActions {
		spec, ok := server[a.Action]
		if !ok {
			t.Errorf("opsActions maps %s to action %q, which the server catalog does not have",
				a.Command, a.Action)
			continue
		}
		seen[a.Action] = true
		if spec.Blast != a.Blast {
			t.Errorf("%s: blast radius is %q in the catalog, %q here", a.Action, spec.Blast, a.Blast)
		}
		if spec.ReadOnly != a.ReadOnly {
			t.Errorf("%s: readOnly is %v in the catalog, %v here.\n"+
				"      ReadOnly decides whether the verb confirms and whether it sends the typed-confirm,\n"+
				"      so a mutating action mirrored read-only ships with no confirmation at all.",
				a.Action, spec.ReadOnly, a.ReadOnly)
		}
		if spec.RequiresApproval != a.RequiresApproval {
			t.Errorf("%s: requiresApproval is %v in the catalog, %v here",
				a.Action, spec.RequiresApproval, a.RequiresApproval)
		}
	}

	for action := range server {
		if !seen[action] {
			t.Errorf("the server catalog has %q and the CLI has no verb for it.\n"+
				"      A break-glass action the operator UI can perform and the terminal cannot is\n"+
				"      the gap this group exists to close — add a verb, or record why not.", action)
		}
	}
}

// TestOpsCatalog_ApprovalActionsAreDerived pins the set `ops approve` offers.
//
// Named cases, not a count: a floor of three passes with the wrong three.
func TestOpsCatalog_ApprovalActionsAreDerived(t *testing.T) {
	got := opsApprovalActions()
	want := []string{"force_release_state_lock", "state_surgery", "orphan_clean"}
	if len(got) != len(want) {
		t.Fatalf("opsApprovalActions() = %v, want %v", got, want)
	}
	for i, w := range want {
		if got[i] != w {
			t.Errorf("opsApprovalActions()[%d] = %q, want %q", i, got[i], w)
		}
	}
	// The other direction: nothing read-only or low-blast may creep in.
	for _, a := range opsActions {
		if a.RequiresApproval && a.Blast != "high" {
			t.Errorf("%s requires an approval at blast %q; the catalog's rule is that HIGH implies two-person",
				a.Action, a.Blast)
		}
	}
}

// TestOpsCatalog_EveryVerbResolvesToALeaf closes the loop between the table and the live tree: a
// command path in opsActions that no longer exists would make mustOpsAction panic at runtime, in
// front of an operator, during an incident.
func TestOpsCatalog_EveryVerbResolvesToALeaf(t *testing.T) {
	for _, a := range opsActions {
		cmd, _, err := rootCmd.Find(opsCommandPath(a.Command))
		if err != nil || cmd.CommandPath() != a.Command {
			t.Errorf("opsActions names %q, which does not resolve (found %q, err %v)",
				a.Command, cmd.CommandPath(), err)
			continue
		}
		if !cmd.Runnable() {
			t.Errorf("%s is not runnable", a.Command)
		}
	}
}
