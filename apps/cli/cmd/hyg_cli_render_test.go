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

// The helpers this lane hoisted were never wrong — their ADDRESSES were. `orDash` lived in
// config.go and eight other files used it; `yesNo` lived in channels.go and five did. That is why
// the command files could not be worked on in parallel: any lane touching a render had to edit a
// command file another lane owned.
//
// Hoisting them fixes it once. This stops it happening again, because the pressure that put them
// there is still present — the next person needing a dash in a new command will write one locally
// unless something objects.
// Matched by SHAPE, not by name. The first cut listed eleven literal names and `derefOrDash` — a
// byte-for-byte copy of `ui.StrOrDash` living in project_env.go — was invisible to it, so the guard
// reported green with a duplicate render helper still in cmd. A hand-written list of what a guard
// watches stops covering silently; that is the defect this whole lane is about, and it was in the
// guard itself.
//
// The shape: a func in `cmd/` whose body RETURNS the empty-value sentinel is a render helper,
// whatever it is called. Rendering the sentinel inline in a table cell is not caught and should not
// be — the thing being prevented is a second DEFINITION, not a second use.
// renderExemptions are funcs in cmd/ that return the sentinel and are NOT shared renderers, each
// with the reason. An exemption is a decision, not a mute button: the staleness check below fails if
// one names a func that no longer matches, so the list cannot rot into a permanent allowance.
//
// Over-reporting is the right direction for this guard. Asking "does it return the sentinel" is a
// cheap SOUND question; asking "is it really a shared renderer" needs judgement no regex has. Four
// funcs it flagged were genuine misses my hand-written list of ten had not seen — including one I
// had deliberately excluded and then forgotten to record.
var renderExemptions = map[string]string{
	"reachableLabel": "takes a probe's *bool and pairs the glyph with probe-specific wording (never probed / up / down)",
	// The reason here USED to be "replaced wholesale by packages/core/format.Duration in #3659, so
	// hoisting it would move it twice". That has happened — the body is `format.Duration(...)`
	// today — so the reason described a future that had already arrived, while the exemption itself
	// stayed correctly live. The staleness check below cannot catch that: it asks whether the func
	// still MATCHES, not whether the sentence next to it is still true.
	"formatDuration": "takes a started/completed PAIR: the elapsed rule is packages/core/format.Duration, but the dash for a job that never started and the ellipsis that says the number is still climbing are this command's own semantics, not a shared render",
}

var renderFuncInCmd = regexp.MustCompile(`(?s)\nfunc (\w+)\([^)]*\)[^{]*\{(.*?)\n\}`)

func TestHygCliRender_NoRenderHelperIsDefinedInACommandFile(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	scanned := 0
	flagged := map[string]bool{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		scanned++
		body, err := os.ReadFile(filepath.Join(".", name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, m := range renderFuncInCmd.FindAllStringSubmatch(string(body), -1) {
			fn, bodyText := m[1], m[2]
			// RETURNS the sentinel, not merely mentions it. Loosening this to "contains" flags every
			// row builder that puts a dash in a cell — about fifteen of them — which is a use, not a
			// second definition. The thing being prevented is a duplicate HELPER.
			if !strings.Contains(bodyText, "return ui.SymbolDash") {
				continue
			}
			flagged[fn] = true
			if reason, exempt := renderExemptions[fn]; exempt {
				if strings.TrimSpace(reason) == "" {
					t.Errorf("%s is exempted with no reason", fn)
				}
				continue
			}
			t.Errorf("%s defines %q, which RETURNS the empty-value sentinel — that makes it a render\n"+
				"      helper, whatever it is called.\n"+
				"      These live in apps/cli/pkg/utils/ui/render.go, exported, so every command shares one\n"+
				"      definition. A local copy is how the sentinel ended up with three spellings, and\n"+
				"      `derefOrDash` was exactly this — ui.StrOrDash under another name.",
				name, fn)
		}
	}
	// Vacuity: a walk that reads no files would pass having checked nothing, and this guard's whole
	// value is that it keeps checking as the CLI grows.
	// A stale exemption is its own failure: it makes the list read as a set of considered decisions
	// while one of them describes a func that is gone or no longer returns the sentinel.
	for fn := range renderExemptions {
		if !flagged[fn] {
			t.Errorf("exemption %q matches no func that returns the sentinel — delete it; the list only shrinks", fn)
		}
	}

	if scanned < 60 {
		t.Fatalf("scanned only %d command files — apps/cli/cmd has over ninety, so this guard is not "+
			"seeing the directory and every assertion above is vacuous", scanned)
	}
}
