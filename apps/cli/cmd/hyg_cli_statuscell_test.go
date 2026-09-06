// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The status cell is the last of the renders #3694 hoisted, and this is what keeps it hoisted.
//
// `fmt.Sprintf("%s %s", ui.PlainGlyph(s), strings.ToLower(s))` was written out in four command
// files — clusters_list.go, clusters_get.go, project_list.go and runner_list.go — which is one more
// than any of the helpers that hoist named. It is ui.StatusCell now.
//
// The guard is a SHAPE match and not a name match, for the reason
// TestHygCliRender_NoRenderHelperIsDefinedInACommandFile records at length: the next person needing
// a status cell in a new command will write the Sprintf again, under whatever local name that file
// wants, and a list of names would not see it.

// statusCellShape matches a glyph-plus-lowercased-status pair written out by hand, in either order
// and with or without the Sprintf wrapper around it.
//
// The two halves may be up to ~80 characters apart so a wrapped call still matches; anchoring them
// adjacently would let `gofmt` splitting the line across two lines defeat the guard, which is the
// cheapest escape route and therefore the one to close.
var statusCellShape = regexp.MustCompile(`(?s)(ui\.PlainGlyph\(.{0,80}?strings\.ToLower\(|strings\.ToLower\(.{0,80}?ui\.PlainGlyph\()`)

// TestHygCliStatusCell_NoCommandFileBuildsItsOwn fails on a hand-built status cell in cmd/.
func TestHygCliStatusCell_NoCommandFileBuildsItsOwn(t *testing.T) {
	files := gateProductionFiles(t)
	for _, file := range files {
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		if loc := statusCellShape.FindIndex(body); loc != nil {
			line := 1 + strings.Count(string(body[:loc[0]]), "\n")
			t.Errorf("%s:%d pairs ui.PlainGlyph with strings.ToLower by hand.\n"+
				"      That is the status table cell, and it is ui.StatusCell — four files spelled\n"+
				"      it out before the hoist and they could not have been changed together.\n"+
				"      %s", file, line, strings.TrimSpace(string(body[loc[0]:loc[1]])))
		}
	}
}

// TestHygCliStatusCell_TheShapeMatcherWorks is the mutation test the guard above cannot be without.
//
// A shape guard that matches nothing passes on a clean tree and on a broken matcher identically, so
// the matcher is driven here against the exact four expressions it was written for — the ones
// deleted from the four command files — plus the wrapped spelling gofmt produces, and against
// expressions it must NOT claim.
//
// It calls statusCellShape, the same variable the guard uses, rather than restating the pattern.
//
// The four "as deleted" expressions are spelled with ui.PlainGlyph rather than the
// ui.PlainStatusDot they actually carried, because #3660 renamed the glyph function: a fixture
// naming a symbol that no longer exists would keep passing against a matcher that had stopped
// covering the live spelling, which is the failure this mutation test exists to make impossible.
func TestHygCliStatusCell_TheShapeMatcherWorks(t *testing.T) {
	mustMatch := map[string]string{
		"clusters_list.go, as deleted": `status := fmt.Sprintf("%s %s", ui.PlainGlyph(c.Status), strings.ToLower(c.Status))`,
		"clusters_get.go, as deleted":  `{"Status", fmt.Sprintf("%s %s", ui.PlainGlyph(c.Status), strings.ToLower(c.Status))},`,
		"project_list.go, as deleted":  `fmt.Sprintf("%s %s", ui.PlainGlyph(status), strings.ToLower(status)),`,
		"runner_list.go, as deleted":   `fmt.Sprintf("%s %s", ui.PlainGlyph(w.Status), strings.ToLower(w.Status)),`,
		"the other operand order":      `strings.ToLower(w.Status) + " " + ui.PlainGlyph(w.Status)`,
		"wrapped across lines":         "fmt.Sprintf(\"%s %s\",\n\t\tui.PlainGlyph(w.Status),\n\t\tstrings.ToLower(w.Status))",
		"concatenated, no Sprintf":     `ui.PlainGlyph(s) + " " + strings.ToLower(s)`,
	}
	for name, src := range mustMatch {
		if !statusCellShape.MatchString(src) {
			t.Errorf("the matcher does not see %s: %s", name, src)
		}
	}

	mustNotMatch := map[string]string{
		"the glyph alone, with a different label": `ui.PlainGlyph(clusters[i].Status) + " " + clusterLabel(clusters[i])`,
		"a lowercase with no glyph":               `strings.ToLower(provider)`,
		"the hoisted call itself":                 `ui.StatusCell(w.Status)`,
		"two unrelated statements far apart": `ui.PlainGlyph(a)` + strings.Repeat("\n\t// filler filler filler", 6) +
			`strings.ToLower(b)`,
	}
	for name, src := range mustNotMatch {
		if statusCellShape.MatchString(src) {
			t.Errorf("the matcher wrongly claims %s: %s", name, src)
		}
	}
}
