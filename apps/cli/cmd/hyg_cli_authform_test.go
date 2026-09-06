// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
)

// The auth group's forms, and the three other renderings of the same fields.
//
// Every identifier here carries the authForm prefix so it cannot collide with
// another group's helpers in this package.
//
// ── Why the forms are driven rather than stubbed ────────────────────────────────
//
// The established seam in this package stubs runHuhForm to return nil, which
// stops the prompt blocking but cannot ANSWER it: the value is written through a
// pointer the huh group owns and never exposes, so the answered branch of every
// form is unreachable and a test can only ever assert what happens when the user
// abandons the prompt. That is how a form can be wired to the wrong variable and
// stay green.
//
// authFormAnswer drives the REAL widgets the production code built — the real
// Input, the real Select, the real Validate — with real key messages, and reads
// what lands in the bound variables. It re-implements nothing: it types.
//
// Two mechanics were measured rather than assumed, and both are load-bearing:
//
//   - A bare *huh.Group never focuses its first field, so an Input silently
//     swallows every keystroke and reports "". The keys must go through a
//     huh.Form, which is what production runs.
//   - Focus moves between fields through a tea.Cmd, so the commands returned by
//     Update have to be executed and their messages fed back. Executing them
//     naively takes 43 SECONDS for one form — the cursor-blink timer is also a
//     command, and it sleeps. Bounding each command by a short deadline drops the
//     same form to 60ms: the field transition is immediate, the timers are not.

// authFormScript is the keystrokes for one runHuhForm call, plus the form state
// that call ended in.
type authFormScript struct {
	keys  []tea.KeyMsg
	state huh.FormState
	ran   bool
}

// authFormType turns a string into one key message per rune.
func authFormType(s string) []tea.KeyMsg {
	out := make([]tea.KeyMsg, 0, len(s))
	for _, r := range s {
		out = append(out, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	return out
}

// authFormClear returns enough backspaces to empty a pre-filled input.
//
// The forms SEED their inputs with the current value, so typing appends rather
// than replaces. Two of the tests below were wrong before this existed: typing
// "nonsense" into an input holding "https://alethialabs.io" produced
// "https://alethialabs.iononsense", which is a perfectly valid URL — the
// assertion said the validator was missing when the validator had simply been
// handed something legal.
func authFormClear() []tea.KeyMsg {
	out := make([]tea.KeyMsg, 0, 200)
	for i := 0; i < 200; i++ {
		out = append(out, tea.KeyMsg{Type: tea.KeyBackspace})
	}
	return out
}

// authFormKey appends bare key presses (enter, down, …) to a script.
func authFormKey(keys []tea.KeyMsg, types ...tea.KeyType) []tea.KeyMsg {
	for _, t := range types {
		keys = append(keys, tea.KeyMsg{Type: t})
	}
	return keys
}

// authFormExec runs one bubbletea command under a deadline, returning nil when it
// does not answer in time.
//
// The deadline is the whole trick: huh's field-transition command answers
// immediately, and its cursor-blink command sleeps for half a second. Without
// this, pumping one two-field form costs 43 seconds.
func authFormExec(cmd tea.Cmd) tea.Msg {
	ch := make(chan tea.Msg, 1)
	go func() { ch <- cmd() }()
	select {
	case m := <-ch:
		return m
	case <-time.After(25 * time.Millisecond):
		return nil
	}
}

// authFormPump feeds a command's message back into the model, recursively, so a
// focus change actually reaches the next field. Depth-bounded: a form that
// scheduled itself forever would otherwise hang the suite rather than fail it.
func authFormPump(m tea.Model, cmd tea.Cmd, depth int) tea.Model {
	if cmd == nil || depth > 20 {
		return m
	}
	switch msg := authFormExec(cmd).(type) {
	case nil:
		return m
	case tea.BatchMsg:
		for _, c := range msg {
			m = authFormPump(m, c, depth+1)
		}
		return m
	default:
		next, c := m.Update(msg)
		return authFormPump(next, c, depth+1)
	}
}

// authFormAnswer replaces runHuhForm with one that types the given scripts — one
// script per call, in order — into the real form, and returns the scripts so a
// test can assert which ran and how each ended.
//
// A call with no script left is an error rather than a silent no-op: a form
// opening that the test did not expect is exactly the kind of extra question this
// group exists to remove.
func authFormAnswer(t *testing.T, scripts ...*authFormScript) []*authFormScript {
	t.Helper()
	prev := runHuhForm
	i := 0
	runHuhForm = func(groups ...*huh.Group) error {
		if i >= len(scripts) {
			t.Errorf("the command opened form #%d; only %d were scripted", i+1, len(scripts))
			return nil
		}
		s := scripts[i]
		i++
		s.ran = true
		form := huh.NewForm(groups...)
		var m tea.Model = form
		m = authFormPump(m, form.Init(), 0)
		for _, k := range s.keys {
			next, c := m.Update(k)
			m = authFormPump(next, c, 0)
		}
		s.state = form.State
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })
	return scripts
}

// authFormNoForm asserts that no form is opened at all, for the arms where a flag
// has already answered the question.
func authFormNoForm(t *testing.T) {
	t.Helper()
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error {
		t.Error("a form was opened although the value was supplied without one")
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })
}

// authFormRepoRoot returns the repository root from apps/cli/cmd.
func authFormRepoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	// Vacuity: a wrong root would make every docs assertion below read a file that
	// is not there, and "cannot read the docs" must not be indistinguishable from
	// "the docs agree".
	if _, err := os.Stat(filepath.Join(root, "CLAUDE.md")); err != nil {
		t.Fatalf("resolved repo root %s does not look like the repository: %v", root, err)
	}
	return root
}

// authFormTable reads the markdown table that follows a marker comment in a docs
// page, returning its data rows with the surrounding pipes and spaces stripped.
//
// It returns ok=false when the marker is absent or carries no table, which the
// callers report as a failure — a guard that reads no rows must fail, not pass.
func authFormTable(t *testing.T, page, marker string) ([][]string, bool) {
	t.Helper()
	body, err := os.ReadFile(page)
	if err != nil {
		t.Errorf("read %s: %v", page, err)
		return nil, false
	}
	lines := strings.Split(string(body), "\n")
	at := -1
	for i, l := range lines {
		if strings.TrimSpace(l) == marker {
			at = i
			break
		}
	}
	if at < 0 {
		return nil, false
	}
	var rows [][]string
	seenHeader := false
	for i := at + 1; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			if len(rows) > 0 || seenHeader {
				break
			}
			continue
		}
		if !strings.HasPrefix(line, "|") {
			break
		}
		cells := strings.Split(strings.Trim(line, "|"), "|")
		for j := range cells {
			cells[j] = strings.TrimSpace(cells[j])
		}
		// The header row and the --- separator are structure, not data.
		if !seenHeader {
			seenHeader = true
			continue
		}
		if strings.Trim(cells[0], "-: ") == "" {
			continue
		}
		rows = append(rows, cells)
	}
	return rows, len(rows) > 0
}

// ── rendering 1 · the flags ─────────────────────────────────────────────────────

// TestHygCliAuthForm_EveryFieldNamesARealFlagOrPositional is the "flags stay a
// COMPLETE contract" half: anything a form can ask, the command line can set.
//
// It resolves each spec entry against the LIVE cobra tree rather than against a
// list, so renaming --expires-in-days without touching the spec fails here.
func TestHygCliAuthForm_EveryFieldNamesARealFlagOrPositional(t *testing.T) {
	if len(authFields) == 0 {
		t.Fatal("authFields is empty — every assertion below would pass having checked nothing")
	}
	for _, f := range authFields {
		t.Run(f.Command+"/"+f.Key, func(t *testing.T) {
			if (f.Flag == "") == (f.Arg == "") {
				t.Fatalf("exactly one of Flag and Arg must be set; got Flag=%q Arg=%q", f.Flag, f.Arg)
			}
			if strings.TrimSpace(f.Title) == "" || strings.TrimSpace(f.Description) == "" {
				t.Fatalf("a field with no title or no description renders as an unlabelled question")
			}
			cmd, _, err := rootCmd.Find(strings.Fields(strings.TrimPrefix(f.Command, "alethia ")))
			if err != nil || cmd.CommandPath() != f.Command {
				t.Fatalf("no command %q in the tree (found %q, err %v)", f.Command, cmd.CommandPath(), err)
			}
			if f.Flag != "" {
				if cmd.Flags().Lookup(f.Flag) == nil {
					t.Errorf("%s asks for %q in its form and has NO --%s flag.\n"+
						"      A form field a flag cannot set means --no-input can never answer it, so the\n"+
						"      command is unusable from a script for the one value it exists to take.",
						f.Command, f.Title, f.Flag)
				}
				return
			}
			if !strings.Contains(cmd.Use, f.Arg) {
				t.Errorf("%s asks for %q in its form and its Use %q does not carry the positional %q",
					f.Command, f.Title, cmd.Use, f.Arg)
			}
		})
	}
}

// authFormLeafTakesInput records, for every leaf in the group, whether it takes a
// value from the person running it. The SET is derived from the command tree; only
// the answer is written down, so a new `alethia config …` subcommand fails this
// test until somebody decides which side it is on.
var authFormLeafTakesInput = map[string]bool{
	"alethia login":                false,
	"alethia logout":               false,
	"alethia init":                 true,
	"alethia token list":           false,
	"alethia token create":         true,
	"alethia token revoke":         true,
	"alethia config":               false,
	"alethia config get":           true,
	"alethia config set":           true,
	"alethia config clear-context": false,
	"alethia config export":        true,
}

// TestHygCliAuthForm_EveryGroupLeafIsClassified closes the gap between "the group
// has a field spec" and "the field spec covers the group".
//
// The derived set and the table must match EXACTLY, in both directions. A count
// floor would not do: every leaf here can be named, and a floor passes with the
// interesting half deleted.
func TestHygCliAuthForm_EveryGroupLeafIsClassified(t *testing.T) {
	commands := authGroupCommands(rootCmd)
	if len(commands) == 0 {
		t.Fatal("the walk found no commands under login/logout/token/init/config — every assertion below is vacuous")
	}

	// Each root must actually contribute, so a renamed or unregistered top-level
	// command is a failure rather than a quietly smaller set.
	contributed := map[string]bool{}
	seen := map[string]bool{}
	fieldsFor := map[string]int{}
	for _, f := range authFields {
		fieldsFor[f.Command]++
	}

	for _, c := range commands {
		path := c.CommandPath()
		seen[path] = true
		contributed[strings.Fields(path)[1]] = true
		takesInput, classified := authFormLeafTakesInput[path]
		if !classified {
			t.Errorf("%s is a leaf of this group and nothing says whether it takes input.\n"+
				"      Classify it in authFormLeafTakesInput: a leaf that takes a value needs an\n"+
				"      interactive path and a row in authFields; one that takes none needs neither.", path)
			continue
		}
		if !takesInput && fieldsFor[path] > 0 {
			t.Errorf("%s is recorded as taking no input and has %d authFields entries", path, fieldsFor[path])
		}
	}

	for _, r := range authGroupRoots {
		if !contributed[r] {
			t.Errorf("`alethia %s` contributed no leaf — it is gone, renamed, or no longer registered", r)
		}
	}
	for path := range authFormLeafTakesInput {
		if !seen[path] {
			t.Errorf("authFormLeafTakesInput names %q, which the walk did not reach — it is gone or renamed", path)
		}
	}
}

// The three leaves that take input WITHOUT an authFields row, and why. `config
// get` and `config export` are named here rather than left as an unexplained
// absence; the list is checked against the classification above, so it cannot
// name a leaf that does not take input.
var authFormNoFieldSpec = map[string]string{
	"alethia config get": "its only input is a key with a default (all of them), so there is no question to ask; " +
		"the keys it accepts are configFields, which has its own docs table and mirror test",
	"alethia config export": "its input is a project, picked by selectProject — the shared project picker every " +
		"project-scoped command uses, specified by whichever lane owns it, not by this group",
}

func TestHygCliAuthForm_InputTakingLeavesHaveFieldsOrAStatedReason(t *testing.T) {
	fieldsFor := map[string]int{}
	for _, f := range authFields {
		fieldsFor[f.Command]++
	}
	needed := map[string]bool{}
	for path, takesInput := range authFormLeafTakesInput {
		if !takesInput {
			continue
		}
		needed[path] = true
		if fieldsFor[path] > 0 {
			continue
		}
		reason, exempt := authFormNoFieldSpec[path]
		if !exempt {
			t.Errorf("%s takes input and has no authFields row and no recorded reason", path)
			continue
		}
		if strings.TrimSpace(reason) == "" {
			t.Errorf("%s is exempted with no reason", path)
		}
	}
	// A stale exemption is its own failure: it makes the list read as a set of
	// decisions while one of them describes a command that now HAS a spec.
	for path := range authFormNoFieldSpec {
		if !needed[path] {
			t.Errorf("authFormNoFieldSpec names %q, which does not take input — delete it", path)
		}
		if fieldsFor[path] > 0 {
			t.Errorf("authFormNoFieldSpec names %q, which now has %d authFields rows — delete the exemption",
				path, fieldsFor[path])
		}
	}
}

// ── rendering 2 · the docs ──────────────────────────────────────────────────────

// TestHygCliAuthForm_DocsFieldTablesMirrorTheSpec is the docs half of "one field
// spec, four renderings".
//
// Every command with fields must carry a table on the page its spec names, and
// that table must be the same rows in the same order. A docs page is the only one
// of the four renderings a compiler cannot see, which is why it is the one that
// goes stale.
func TestHygCliAuthForm_DocsFieldTablesMirrorTheSpec(t *testing.T) {
	root := authFormRepoRoot(t)
	byCommand := map[string][]authField{}
	var order []string
	for _, f := range authFields {
		if _, ok := byCommand[f.Command]; !ok {
			order = append(order, f.Command)
		}
		byCommand[f.Command] = append(byCommand[f.Command], f)
	}
	if len(order) == 0 {
		t.Fatal("no commands carry fields — this guard would check nothing")
	}

	for _, command := range order {
		fields := byCommand[command]
		t.Run(command, func(t *testing.T) {
			page := fields[0].Page
			for _, f := range fields {
				if f.Page != page {
					t.Fatalf("%s splits its fields across %s and %s; one command documents its form in one place",
						command, page, f.Page)
				}
			}
			marker := "{/* fieldspec: " + command + " */}"
			rows, ok := authFormTable(t, filepath.Join(root, page), marker)
			if !ok {
				t.Fatalf("%s carries no table after %s.\n"+
					"      The form asks %d question(s) that nothing in the docs describes.",
					page, marker, len(fields))
			}
			if len(rows) != len(fields) {
				t.Fatalf("%s documents %d field(s) after %s; the form asks %d.\n      docs: %v",
					page, len(rows), marker, len(fields), rows)
			}
			for i, f := range fields {
				want := []string{f.Title, f.Description, "`" + f.Flag + "`"}
				if f.Flag != "" {
					want[2] = "`--" + f.Flag + "`"
				} else {
					want[2] = "`" + f.Arg + "`"
				}
				got := rows[i]
				if len(got) < 3 {
					t.Errorf("%s row %d has %d cells, want at least 3: %v", page, i+1, len(got), got)
					continue
				}
				for j, w := range want {
					if got[j] != w {
						t.Errorf("%s row %d cell %d:\n       docs: %q\n       spec: %q",
							page, i+1, j+1, got[j], w)
					}
				}
			}
		})
	}
}

// TestHygCliAuthForm_ConfigKeyDocsTableMirrorsTheSpec does the same for the config
// KEYS, the fourth rendering of that spec: `config get` reads them, `config set`
// writes them, the picker offers them, and this table describes them.
//
// The "How to set it" column is derived, not typed: a key that stops being
// settable, or whose owning command is renamed, moves this table with it.
func TestHygCliAuthForm_ConfigKeyDocsTableMirrorsTheSpec(t *testing.T) {
	root := authFormRepoRoot(t)
	page := filepath.Join(root, docsConfigurationPage)
	rows, ok := authFormTable(t, page, "{/* configkeys */}")
	if !ok {
		t.Fatalf("%s carries no table after {/* configkeys */} — the config keys are undocumented", docsConfigurationPage)
	}
	if len(configFields) == 0 {
		t.Fatal("configFields is empty")
	}
	if len(rows) != len(configFields) {
		t.Fatalf("%s documents %d config key(s); the CLI has %d.\n      docs: %v",
			docsConfigurationPage, len(rows), len(configFields), rows)
	}
	for i, f := range configFields {
		setCell := "`config set`"
		if !f.settable() {
			setCell = "`" + f.SetVia + "`"
		}
		want := []string{"`" + f.Key + "`", f.Summary, setCell}
		got := rows[i]
		if len(got) < 3 {
			t.Errorf("row %d has %d cells, want 3: %v", i+1, len(got), got)
			continue
		}
		for j, w := range want {
			if got[j] != w {
				t.Errorf("%s row %d cell %d:\n       docs: %q\n       spec: %q",
					docsConfigurationPage, i+1, j+1, got[j], w)
			}
		}
	}
}

// A read-only key must say what DOES write it. "unknown config key" would be a
// lie for a key `config get` has just printed, and silence would be worse.
func TestHygCliAuthForm_ReadOnlyConfigKeysNameTheirWriter(t *testing.T) {
	readOnly := 0
	for _, f := range configFields {
		if f.settable() {
			if f.SetVia != "" {
				t.Errorf("%s is settable and also names SetVia %q — one of the two is wrong", f.Key, f.SetVia)
			}
			continue
		}
		readOnly++
		if strings.TrimSpace(f.SetVia) == "" {
			t.Errorf("%s is read-only and names no command that writes it", f.Key)
		}
		cmd, _, err := rootCmd.Find(strings.Fields(strings.TrimPrefix(f.SetVia, "alethia ")))
		if err != nil || cmd.CommandPath() != f.SetVia {
			t.Errorf("%s points at %q, which is not a command in the tree", f.Key, f.SetVia)
		}
	}
	if readOnly == 0 {
		t.Skip("no read-only keys to check")
	}
}

// ── rendering 3 · the forms, driven ─────────────────────────────────────────────

// authFormInteractive puts the process in the state a terminal user is in.
func authFormInteractive(t *testing.T) {
	t.Helper()
	prevIn, prevMode := stdinIsTTY, noInputMode
	stdinIsTTY = func() bool { return true }
	noInputMode = false
	t.Cleanup(func() { stdinIsTTY, noInputMode = prevIn, prevMode })
}

// authFormScripted disables prompting the way --no-input does.
func authFormScripted(t *testing.T) {
	t.Helper()
	prev := noInputMode
	noInputMode = true
	t.Cleanup(func() { noInputMode = prev })
}

func TestHygCliAuthForm_TokenCreateAsksForBothFields(t *testing.T) {
	authFormInteractive(t)
	keys := authFormType("github-actions")
	keys = authFormKey(keys, tea.KeyEnter, tea.KeyDown, tea.KeyDown, tea.KeyEnter)
	script := &authFormScript{keys: keys}
	authFormAnswer(t, script)

	name, days, err := promptTokenCreate("", 0)
	if err != nil {
		t.Fatalf("promptTokenCreate: %v", err)
	}
	if !script.ran {
		t.Fatal("no form was opened, so `token create` on a terminal still refuses an omitted --name")
	}
	if name != "github-actions" {
		t.Errorf("name = %q, want the typed value — the Input is bound to the wrong variable", name)
	}
	// Never(0) → 30 → 90. Two presses down the list is 90, and asserting the VALUE
	// rather than "not zero" is what catches a Select bound to the label.
	if days != 90 {
		t.Errorf("expires-in-days = %d, want 90 after two presses down the list", days)
	}
	if script.state != huh.StateCompleted {
		t.Errorf("the form ended in state %v, want completed", script.state)
	}
}

// The validator, driven: submitting an empty name must NOT complete the form.
// Without this, `Validate` could be deleted and every other test would pass —
// the name would simply arrive empty and runTokenCreate would refuse it, which
// looks identical from the outside and is a far worse experience.
func TestHygCliAuthForm_TokenCreateFormRefusesAnEmptyName(t *testing.T) {
	authFormInteractive(t)
	script := &authFormScript{keys: authFormKey(nil, tea.KeyEnter, tea.KeyEnter)}
	authFormAnswer(t, script)

	name, _, err := promptTokenCreate("", 0)
	if err != nil {
		t.Fatalf("promptTokenCreate: %v", err)
	}
	if script.state == huh.StateCompleted {
		t.Error("the form completed with an empty name — the Validate is missing or does not refuse blanks")
	}
	if strings.TrimSpace(name) != "" {
		t.Errorf("name = %q, want empty", name)
	}
}

// A --expires-in-days the presets do not carry must still be selectable, or the
// form silently discards a value the caller explicitly passed.
func TestHygCliAuthForm_TokenCreateKeepsAnUnlistedExpiry(t *testing.T) {
	authFormInteractive(t)
	keys := authFormKey(authFormType("ci"), tea.KeyEnter, tea.KeyEnter)
	script := &authFormScript{keys: keys}
	authFormAnswer(t, script)

	_, days, err := promptTokenCreate("", 45)
	if err != nil {
		t.Fatalf("promptTokenCreate: %v", err)
	}
	if days != 45 {
		t.Errorf("expires-in-days = %d, want the 45 the caller passed — the form dropped it", days)
	}
}

func TestHygCliAuthForm_TokenCreateSkipsTheFormWhenNamed(t *testing.T) {
	authFormInteractive(t)
	authFormNoForm(t)
	name, days, err := promptTokenCreate("ci", 30)
	if err != nil || name != "ci" || days != 30 {
		t.Errorf("promptTokenCreate(ci, 30) = %q, %d, %v — a supplied name must not be re-asked", name, days, err)
	}
}

func TestHygCliAuthForm_TokenCreateScriptedPassesThrough(t *testing.T) {
	authFormScripted(t)
	authFormNoForm(t)
	name, days, err := promptTokenCreate("", 0)
	if err != nil {
		t.Fatalf("promptTokenCreate: %v", err)
	}
	// It passes the empty name STRAIGHT THROUGH rather than inventing one:
	// runTokenCreate owns the "--name is required" rule and must not grow a second
	// copy of it here.
	if name != "" || days != 0 {
		t.Errorf("scripted promptTokenCreate = %q, %d; want the arguments unchanged", name, days)
	}
	if err := runTokenCreate(&fakeClient{}, os.Stdout, os.Stderr, "json", name, days); err == nil {
		t.Error("an unnamed token was minted in a scripted run")
	}
}

func TestHygCliAuthForm_TokenRevokeOffersOnlyLiveTokens(t *testing.T) {
	authFormInteractive(t)
	past := time.Now().Add(-time.Hour).Format(time.RFC3339)
	c := &fakeClient{serviceTokens: []api.ServiceToken{
		{ID: "live-1", Name: "ci", TokenPrefix: "alethia_sat_aaaa1111", CreatedAt: past},
		{ID: "dead-1", Name: "leaked", TokenPrefix: "alethia_sat_bbbb2222", CreatedAt: past, RevokedAt: &past},
		{ID: "live-2", Name: "nightly", TokenPrefix: "alethia_sat_cccc3333", CreatedAt: past},
	}}

	script := &authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyEnter)}
	authFormAnswer(t, script)

	id, err := selectServiceToken(c)
	if err != nil {
		t.Fatalf("selectServiceToken: %v", err)
	}
	// One press down from the first option. If the revoked token were still in the
	// list it would be second and this would be "dead-1" — which is the whole point
	// of asserting the ID rather than merely that something was returned.
	if id != "live-2" {
		t.Errorf("picked %q; one press down the live list is live-2 (a revoked token is not offered)", id)
	}
}

func TestHygCliAuthForm_TokenRevokeWithNothingLiveSaysSo(t *testing.T) {
	authFormInteractive(t)
	past := time.Now().Add(-time.Hour).Format(time.RFC3339)
	c := &fakeClient{serviceTokens: []api.ServiceToken{
		{ID: "dead-1", Name: "old", CreatedAt: past, RevokedAt: &past},
	}}
	authFormNoForm(t)
	if _, err := selectServiceToken(c); err == nil {
		t.Fatal("an empty picker was opened instead of an error")
	} else if !strings.Contains(err.Error(), "token list") {
		t.Errorf("the error does not say where to look: %v", err)
	}
}

func TestHygCliAuthForm_TokenRevokeScriptedRefusesToGuess(t *testing.T) {
	authFormScripted(t)
	authFormNoForm(t)
	// A LIVE token, deliberately: with an empty list the command would refuse for
	// the other reason — nothing to revoke — and the test would pass with the
	// --no-input gate deleted. Measured: it did.
	c := &fakeClient{serviceTokens: []api.ServiceToken{{ID: "t1", Name: "ci"}}}
	id, err := selectServiceToken(c)
	if err == nil {
		t.Fatalf("a scripted `token revoke` with no id picked %q for the caller", id)
	}
	if !errors.Is(err, errNoInput) {
		t.Errorf("the refusal is %v, want the standard --no-input refusal", err)
	}
}

func TestHygCliAuthForm_ConfigSetAsksForKeyThenValue(t *testing.T) {
	isolatedConfigHome(t)
	authFormInteractive(t)
	keys := append(authFormClear(), authFormType("https://cp.example.com")...)
	keyScript := &authFormScript{keys: authFormKey(nil, tea.KeyEnter)}
	valueScript := &authFormScript{keys: authFormKey(keys, tea.KeyEnter)}
	authFormAnswer(t, keyScript, valueScript)

	key, value, err := promptConfigSet("", "")
	if err != nil {
		t.Fatalf("promptConfigSet: %v", err)
	}
	if !keyScript.ran || !valueScript.ran {
		t.Fatalf("both forms must open when neither argument was given (key=%v value=%v)", keyScript.ran, valueScript.ran)
	}
	if key != "web-origin" {
		t.Errorf("key = %q, want the first settable key", key)
	}
	if value != "https://cp.example.com" {
		t.Errorf("value = %q, want the typed URL", value)
	}
}

// The value input is SEEDED with the current value, so the form is an edit rather
// than a re-type. Submitting it untouched must therefore hand back what is already
// stored — a form that opened empty would silently look like "clear this setting".
func TestHygCliAuthForm_ConfigSetValueFormIsPrefilled(t *testing.T) {
	isolatedConfigHome(t)
	authFormInteractive(t)
	if err := runConfigSet(io.Discard, "web-origin", "https://already.example.com"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	script := &authFormScript{keys: authFormKey(nil, tea.KeyEnter)}
	authFormAnswer(t, script)

	_, value, err := promptConfigSet("web-origin", "")
	if err != nil {
		t.Fatalf("promptConfigSet: %v", err)
	}
	if value != "https://already.example.com" {
		t.Errorf("an untouched form yielded %q, want the stored value", value)
	}
}

// The seed is the STORED value, not the resolved one. $ALETHIA_WEB_ORIGIN outranks
// the config file and `config set` writes the FILE, so seeding from
// types.ResolveWebOrigin() puts the environment's origin in the box — and a bare
// Enter from a user who opened the form only to look at the setting persists it
// over the self-hosted origin they never touched. The "outranks the config file"
// note cannot save them: after that write the two values agree, so the one line
// that would have warned them is the line the overwrite suppresses.
func TestHygCliAuthForm_ConfigSetValueFormSeedsTheStoredOriginNotTheEnvironment(t *testing.T) {
	isolatedConfigHome(t)
	authFormInteractive(t)
	if err := runConfigSet(io.Discard, "web-origin", "https://selfhosted.example"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	t.Setenv("ALETHIA_WEB_ORIGIN", "https://staging.example")
	script := &authFormScript{keys: authFormKey(nil, tea.KeyEnter)}
	authFormAnswer(t, script)

	_, value, err := promptConfigSet("web-origin", "")
	if err != nil {
		t.Fatalf("promptConfigSet: %v", err)
	}
	if value != "https://selfhosted.example" {
		t.Errorf("an untouched form yielded %q, want the STORED origin — writing that would have destroyed it", value)
	}
}

// The value form validates with the SAME function `config set` gates on, so a
// value the form accepted can never be refused a moment later.
func TestHygCliAuthForm_ConfigSetValueFormRefusesAnInvalidURL(t *testing.T) {
	isolatedConfigHome(t)
	authFormInteractive(t)
	script := &authFormScript{keys: authFormKey(append(authFormClear(), authFormType("not-a-url")...), tea.KeyEnter)}
	authFormAnswer(t, script)

	if _, _, err := promptConfigSet("web-origin", ""); err != nil {
		t.Fatalf("promptConfigSet: %v", err)
	}
	if script.state == huh.StateCompleted {
		t.Error("the form completed with a value normalizeWebOrigin refuses — the Validate is not wired")
	}
}

func TestHygCliAuthForm_ConfigSetRefusesAReadOnlyKey(t *testing.T) {
	isolatedConfigHome(t)
	authFormInteractive(t)
	authFormNoForm(t)
	_, _, err := promptConfigSet("active-org", "")
	if err == nil {
		t.Fatal("a read-only key opened a value form")
	}
	if !strings.Contains(err.Error(), "org switch") {
		t.Errorf("the refusal does not name the command that DOES write it: %v", err)
	}
	if err := runConfigSet(io.Discard, "active-org", "Acme"); err == nil ||
		!strings.Contains(err.Error(), "org switch") {
		t.Errorf("runConfigSet accepted a read-only key, or did not name its writer: %v", err)
	}
}

func TestHygCliAuthForm_ConfigSetScriptedNeedsBothArguments(t *testing.T) {
	authFormScripted(t)
	authFormNoForm(t)
	for _, tc := range []struct{ key, value string }{{"", ""}, {"web-origin", ""}, {"", "https://x.io"}} {
		_, _, err := promptConfigSet(tc.key, tc.value)
		if err == nil {
			t.Errorf("scripted promptConfigSet(%q, %q) guessed instead of failing", tc.key, tc.value)
			continue
		}
		// The refusal must name the shape that works, or a script author is left
		// guessing which of the two arguments was missing.
		if !strings.Contains(err.Error(), "config set") {
			t.Errorf("the refusal does not show the working invocation: %v", err)
		}
	}
}

func TestHygCliAuthForm_InitWebOriginFlagWinsOverTheForm(t *testing.T) {
	isolatedConfigHome(t)
	authFormInteractive(t)
	authFormNoForm(t)
	got, err := promptWebOrigin("https://cp.example.com/")
	if err != nil {
		t.Fatalf("promptWebOrigin: %v", err)
	}
	// Normalized on the way through, so `init --web-origin` and `config set
	// web-origin` cannot store the same URL two different ways.
	if got != "https://cp.example.com" {
		t.Errorf("origin = %q, want the flag value with the trailing slash trimmed", got)
	}
	if _, err := promptWebOrigin("not-a-url"); err == nil {
		t.Error("an invalid --web-origin was accepted; it would fail later, after the browser opened")
	}
}

func TestHygCliAuthForm_InitFormRefusesAnInvalidURL(t *testing.T) {
	isolatedConfigHome(t)
	authFormInteractive(t)
	script := &authFormScript{keys: authFormKey(append(authFormClear(), authFormType("nonsense")...), tea.KeyEnter)}
	authFormAnswer(t, script)
	if _, err := promptWebOrigin(""); err != nil {
		t.Fatalf("promptWebOrigin: %v", err)
	}
	if script.state == huh.StateCompleted {
		t.Error("the control-plane URL form completed with a value normalizeWebOrigin refuses")
	}
}

// ── the wiring, end to end through cobra ────────────────────────────────────────

// The forms are only worth anything if the answers reach the control plane. Each
// of these drives the REAL command tree with no flags at all, which is the
// invocation that was impossible before this change.
func TestHygCliAuthForm_InteractiveInvocationsReachTheServer(t *testing.T) {
	t.Run("token create", func(t *testing.T) {
		s, run := hygCliConfirmEnv(t)
		hygCliConfirmInteractive(t)
		prev := promptTokenCreate
		promptTokenCreate = func(string, int) (string, int, error) { return "from-the-form", 90, nil }
		t.Cleanup(func() { promptTokenCreate = prev })

		if code := run("token", "create", "--output", "json"); code != 0 {
			t.Fatalf("exit code = %d, want 0", code)
		}
		if !s.saw("POST", "/api/cli/tokens") {
			t.Errorf("`token create` with no flags did not mint anything: %v", s.requests)
		}
	})

	t.Run("token revoke", func(t *testing.T) {
		s, run := hygCliConfirmEnv(t)
		hygCliConfirmInteractive(t)
		prev := selectServiceToken
		selectServiceToken = func(apiClient) (string, error) { return "picked-1", nil }
		t.Cleanup(func() { selectServiceToken = prev })

		if code := run("token", "revoke"); code != 0 {
			t.Fatalf("exit code = %d, want 0", code)
		}
		if !s.saw("DELETE", "/api/cli/tokens/picked-1") {
			t.Errorf("the picked id did not reach the revoke call: %v", s.requests)
		}
	})

	t.Run("config set", func(t *testing.T) {
		_, run := hygCliConfirmEnv(t)
		hygCliConfirmInteractive(t)
		prev := promptConfigSet
		promptConfigSet = func(string, string) (string, string, error) {
			return "web-origin", "https://picked.example.com", nil
		}
		t.Cleanup(func() { promptConfigSet = prev })

		if code := run("config", "set"); code != 0 {
			t.Fatalf("exit code = %d, want 0", code)
		}
		if got := types.LoadCliConfig().WebOrigin; got != "https://picked.example.com" {
			t.Errorf("persisted web-origin = %q, want the answered value", got)
		}
	})
}

// `alethia config get` accepted -o and silently ignored it on every invocation.
func TestHygCliAuthForm_ConfigGetHonoursTheOutputFormat(t *testing.T) {
	isolatedConfigHome(t)
	if err := runConfigSet(io.Discard, "web-origin", "https://cp.example.com"); err != nil {
		t.Fatalf("set: %v", err)
	}
	var buf strings.Builder
	if err := runConfigGet(&buf, ui.FormatJSON, "web-origin"); err != nil {
		t.Fatalf("get json: %v", err)
	}
	if !strings.Contains(buf.String(), `"web-origin"`) || !strings.Contains(buf.String(), "cp.example.com") {
		t.Errorf("json get did not emit a key/value object:\n%s", buf.String())
	}
	// The table format stays the BARE value: `$(alethia config get web-origin)` is
	// the reason the command exists, and a labelled line would break every script.
	buf.Reset()
	if err := runConfigGet(&buf, ui.FormatTable, "web-origin"); err != nil {
		t.Fatalf("get table: %v", err)
	}
	if strings.TrimSpace(buf.String()) != "https://cp.example.com" {
		t.Errorf("table get = %q, want the bare value", buf.String())
	}
}

// Honouring -o put the em dash in reach of a program. ui.OrDash is a placeholder
// for a person reading a column; json and csv are read by scripts, where a probe
// for "no org selected" is an emptiness test — and an em dash is not empty, so it
// passes the test AND flows into whatever the script feeds next.
func TestHygCliAuthForm_ConfigGetKeepsThePlaceholderOutOfTheMachineFormats(t *testing.T) {
	isolatedConfigHome(t)
	var buf strings.Builder
	if err := runConfigGet(&buf, ui.FormatJSON, "active-org"); err != nil {
		t.Fatalf("get json: %v", err)
	}
	if !strings.Contains(buf.String(), `"active-org": ""`) {
		t.Errorf("an unset key did not arrive as the empty string:\n%s", buf.String())
	}
	// `get all` walks the same Read, and csv renders the rows rather than the record.
	for _, format := range []string{ui.FormatJSON, ui.FormatCSV} {
		buf.Reset()
		if err := runConfigGet(&buf, format, ""); err != nil {
			t.Fatalf("get all %s: %v", format, err)
		}
		if strings.Contains(buf.String(), ui.SymbolDash) {
			t.Errorf("`get all -o %s` carries the placeholder glyph:\n%s", format, buf.String())
		}
	}
	// The human table still shows it — an empty line there says nothing.
	buf.Reset()
	if err := runConfigGet(&buf, ui.FormatTable, "active-org"); err != nil {
		t.Fatalf("get table: %v", err)
	}
	if strings.TrimSpace(buf.String()) != ui.SymbolDash {
		t.Errorf("the table lost the placeholder for an unset key: %q", buf.String())
	}
}

// A guard on the guard: mustAuthField must fail loudly rather than hand a form an
// empty title.
func TestHygCliAuthForm_MustAuthFieldPanicsOnAMiss(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("mustAuthField returned a zero field for an unknown key — a form would open unlabelled")
		}
	}()
	_ = mustAuthField("alethia token create", "no-such-field")
}
