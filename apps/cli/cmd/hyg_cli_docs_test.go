// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// A command group's docs page is part of the group, not a description of it.
//
// The CLI programme (#3612) puts each noun group's page inside the group's own scope for a
// measured reason: a group whose commands change and whose page does not is how a page comes to
// document a flag that no longer exists, or to omit a command entirely. `cluster get` shipped with
// no mention on its page and no line in the command tree, and nothing objected — because nothing
// was asking.
//
// This asks. For every group in the registry below it holds three things true at once:
//
//   - every leaf command has a section on its page, and appears in the command tree in index.mdx;
//   - every `alethia …` line the page shows RESOLVES against the real cobra tree — the command
//     exists, its flags exist, and the arguments are ones the command accepts;
//   - the registry itself is live: an entry naming a group that is gone is a failure, not a
//     silently-skipped row.
//
// ── THE REGISTRY ──────────────────────────────────────────────────────────────────────────────
//
// It is opt-in because the fourteen noun groups land one at a time; a guard turned on for all of
// them at once would be red for months and would be switched off rather than fixed. A group is
// added by the pass that finishes it, and the map only grows. #3664 is where it stops being a
// registry and becomes "every group".
//
// A page may carry MORE THAN ONE group — `organizations.mdx` documents org, members and teams, and
// `access.mdx` documents roles, grants and sso — so the "this example is outside the group" check
// below reads every group registered for the page rather than the one it is currently walking.
// Without that, a `alethia members list` example on the org group's page fails as foreign to `org`,
// and the only way to register the group would be to split the docs.
var docsGroups = map[string]string{
	// group command → docs page basename under apps/docs/content/docs/cli/commands
	"cluster": "clusters",
	"addon":   "addons",
	"agent":   "agents",
	"runner":  "runners",
	"org":     "organizations",
	"members": "organizations",
	"teams":   "organizations",
	"roles":   "access",
	"grants":  "access",
	"sso":     "access",
	"verify":  "verify",
	// The break-glass group (#3702). Its page is `ops`; registering it here is what puts its
	// leaves under the same docs guards every other group answers to.
	"ops": "ops",
	// The BYO-IaC group (#3707). All five at once because they are one noun group and one pass:
	// `chart` and `iac` are the two halves of bring-your-own, `repo` is where their repository
	// picker gets its list, and `drift` and `staged` are the two read-only leaves that share the
	// same project/env selectors.
	"chart":  "charts",
	"iac":    "iac",
	"repo":   "repositories",
	"drift":  "drift",
	"staged": "staged",

	// The governance noun group (#3703). Three of these pages carry more than one group, which is
	// why the registry is keyed on the GROUP and not on the page: `channels`, `alerts` and
	// `activity` all document onto notifications.mdx, and `fleet` onto billing.mdx beside the
	// billing group's own commands.
	"protection":     "protection",
	"promotion":      "promotions",
	"probes":         "probes",
	"classification": "classification",
	"channels":       "notifications",
	"alerts":         "notifications",
	"activity":       "notifications",
	"fleet":          "billing",
}

// docsRepoRoot is the repo root as seen from apps/cli/cmd.
func docsRepoRoot() string { return filepath.Join("..", "..", "..") }

// docsPagePath resolves a page basename to its file.
func docsPagePath(page string) string {
	return filepath.Join(docsRepoRoot(), "apps", "docs", "content", "docs", "cli", "commands", page+".mdx")
}

// docsRead reads a file that the guard's verdict depends on. An unreadable one is a FAILURE and
// never a skip: "I could not look" and "I looked and it was fine" must not be the same result.
func docsRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v — this guard's verdict depends on the file, so an absent one is a "+
			"failure rather than a pass", path, err)
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		t.Fatalf("%s is empty", path)
	}
	return string(b)
}

// docsLeaves returns a group's runnable commands, deepest-first paths as argument slices.
//
// Cobra's generated `help` and `completion` are not part of anyone's docs page, and neither is a
// hidden command; everything else a user can run must be documented.
//
// THE GROUP ITSELF COUNTS when it is runnable, and it comes back as the EMPTY path. `alethia
// activity` is a top-level command with a Run and no subcommands at all, so a subcommands-only
// walk returns nothing for it — and the group would then fail the "has no runnable subcommands"
// arm below, which reads as "this walk cannot see them" rather than as what it is. Registering it
// with a walk that could not express it would have been a group inside the registry and outside
// every assertion. `alethia config` (the auth group) has the same shape, which is the reason
// authGroupCommands is runnable-not-leaf too.
func docsLeaves(group *cobra.Command) [][]string {
	var leaves [][]string
	if group.Runnable() {
		leaves = append(leaves, []string{})
	}
	var walk func(c *cobra.Command, path []string)
	walk = func(c *cobra.Command, path []string) {
		for _, sub := range c.Commands() {
			if sub.Hidden || sub.Name() == "help" || sub.Name() == "completion" {
				continue
			}
			next := append(append([]string{}, path...), sub.Name())
			if sub.Runnable() {
				leaves = append(leaves, next)
			}
			walk(sub, next)
		}
	}
	walk(group, nil)
	return leaves
}

// docsShellFences are the info strings that mark a fenced block as commands a reader runs.
var docsShellFences = map[string]bool{"bash": true, "sh": true, "shell": true, "console": true}

// docsLeafPath renders a leaf as the invocation a reader types.
//
// It exists because the empty path above would otherwise render as "alethia activity " with a
// trailing space — which no heading carries, no example matches, and cobra's CommandPath never
// produces. Three separate assertions build this string; one that built it differently would
// disagree with the other two about a command that is perfectly well documented.
func docsLeafPath(group string, leaf []string) string {
	parts := append([]string{"alethia", group}, leaf...)
	return strings.Join(parts, " ")
}

// docsFencedExamples returns every `alethia …` invocation inside a SHELL-fenced code block.
//
// Only fenced blocks, because inline code is prose — "run `alethia org switch`" names a command
// without claiming to be a complete invocation. Anything after a pipe belongs to the next process,
// and a trailing comment is not part of the command.
//
// And only fences tagged as a shell, because an UNTAGGED fence on these pages is rendered OUTPUT,
// which can perfectly well start with the word alethia: `verify receipt` prints a card headed
// `alethia · verify receipt`, and taking that for an invocation made this guard report
// `unknown command "·"` against a page with nothing wrong with it. A guard that fails on correct
// documentation gets the documentation changed to suit the guard.
//
// The cost is that a command fence someone forgets to tag is skipped. That is not silent:
// TestHygCliDocs_EveryLeafIsShownAtLeastOnce requires a runnable example for every leaf, so an
// untagged command fence takes its leaf's only example away with it and fails there.
//
// A trailing backslash JOINS the next line. That is not cosmetic: a wrapped example was previously
// cut at the backslash and the backslash itself was read as a POSITIONAL ARGUMENT, so
// `alethia chart attach api -p shop \` arrived here as two arguments to a command that accepts one,
// and every flag on the continuation line — the half of the example most likely to have rotted —
// was never checked at all. Both failure modes are silent for a page nobody has registered yet, and
// both fire the moment one is.
//
// The two rules are orthogonal and both are load-bearing: the shell tag decides WHICH lines are
// invocations, the backslash decides WHERE one ends.
func docsFencedExamples(page string) []string {
	var out []string
	fenced, shell := false, false
	pending := ""
	for _, line := range strings.Split(page, "\n") {
		if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, "```") {
			// A continuation that never terminated does not escape its block: the next fence starts
			// a new example, and carrying the fragment forward would splice two unrelated commands.
			pending = ""
			if fenced {
				fenced, shell = false, false
				continue
			}
			fenced = true
			shell = docsShellFences[strings.ToLower(strings.TrimSpace(strings.TrimPrefix(trimmed, "```")))]
			continue
		}
		if !fenced || !shell {
			continue
		}
		cmd := strings.TrimSpace(line)
		if pending == "" && !strings.HasPrefix(cmd, "alethia ") {
			continue
		}
		if strings.HasSuffix(cmd, `\`) {
			pending = strings.TrimSpace(pending + " " + strings.TrimSpace(strings.TrimSuffix(cmd, `\`)))
			continue
		}
		if pending != "" {
			cmd = strings.TrimSpace(pending + " " + cmd)
			pending = ""
		}
		if i := strings.Index(cmd, "|"); i >= 0 {
			cmd = cmd[:i]
		}
		if i := strings.Index(cmd, " #"); i >= 0 {
			cmd = cmd[:i]
		}
		out = append(out, strings.TrimSpace(cmd))
	}
	return out
}

// docsTokens splits a documented invocation into the tokens a shell would hand the process.
//
// strings.Fields is not that splitter, and the difference is not cosmetic: `alethia channels
// delete "Ops Slack"` is ONE argument, and Fields makes it two, so ValidateArgs rejects a
// perfectly good example for having an arity the command "does not accept". Every example naming a
// record by its human name — which is the whole point of not making readers copy ids — hits this.
//
// Quotes are stripped, matching what execve receives; an unterminated quote runs to end of line
// rather than being dropped, because a malformed example should reach the resolver and be reported
// as unresolvable, not silently become a shorter one that passes.
func docsTokens(example string) []string {
	var tokens []string
	var cur strings.Builder
	var quote rune
	started := false
	flush := func() {
		if started {
			tokens = append(tokens, cur.String())
			cur.Reset()
			started = false
		}
	}
	for _, r := range example {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '"' || r == '\'':
			quote = r
			started = true
		case r == ' ' || r == '\t':
			flush()
		default:
			cur.WriteRune(r)
			started = true
		}
	}
	flush()
	return tokens
}

// docsPageGroups inverts the registry: which registered groups document onto each page.
//
// The registry is keyed on the group because a PAGE can carry several — notifications.mdx carries
// `channels`, `alerts` and `activity`. The first cut of the misplaced-example check below asked
// whether every example on the page belonged to the ONE group being iterated, which is only ever
// true for a page with one group; with three it reported all three groups' examples as misplaced,
// nine times over. The claim worth keeping is "this example belongs on THIS PAGE", and that is a
// question about the page.
func docsPageGroups() map[string]map[string]bool {
	out := map[string]map[string]bool{}
	for group, page := range docsGroups {
		if out[page] == nil {
			out[page] = map[string]bool{}
		}
		out[page][group] = true
	}
	return out
}

// docsGroupIsRegistered reports whether a top-level command is in the registry at all.
//
// An example for an UNREGISTERED group is not misplaced — it is simply not yet covered. billing.mdx
// documents `alethia billing` and `alethia usage` beside the fleet group; those two are a different
// noun group whose lane has not registered them, and failing this page for showing them would make
// the registry's growth an obstacle rather than a ratchet.
func docsGroupIsRegistered(group string) bool {
	_, ok := docsGroups[group]
	return ok
}

// docsPlaceholderToken reports whether one token of an example is a placeholder a reader must
// substitute rather than a literal they can paste.
//
// THREE shapes, and the third is the one this exists for. `<job-id>` and `[selector]` announce
// themselves; `…` and `...` are how a truncated id is written, and `8f3c2a1e-...` is exactly the
// token a reader would copy, paste, and get a 404 from.
//
// A token is judged whole. `--repo=<url>` is a placeholder because its value is one; `oci://x/y` is
// not, because nothing in it is a substitution.
func docsPlaceholderToken(token string) bool {
	if strings.ContainsAny(token, "<>") {
		return true
	}
	if strings.Contains(token, "…") || strings.Contains(token, "...") {
		return true
	}
	return strings.HasPrefix(token, "[") && strings.HasSuffix(token, "]") && len(token) > 2
}

// docsPlaceholderRatchetGroups is the EXPLICIT opt-in list for the placeholder ratchet below.
//
// It is written out by hand, and deliberately NOT derived from docsGroups, because the two answer
// different questions. docsGroups says "this group has a docs page"; this list says "a pass has
// read every example on that page and confirmed it is runnable as written".
//
// Iterating docsGroups conflated them, and that is a ratchet nobody can keep green. Groups are
// registered by whichever lane finishes them, landing on dev independently and AFTER this ratchet
// was measured — so a sibling lane's merge could turn this test red on a page the author of the
// failing branch has never touched and is not theirs to change. A guard whose verdict depends on
// what merged elsewhere this week is a guard that gets deleted rather than fixed.
//
// TO ADD A GROUP: read every fenced `alethia …` example on its page, remove or replace each
// placeholder — prefer a form of the command that resolves the value itself over a literal — and
// then add the group's name here, in the same pass. Adding the name without doing the reading is
// the only way this list can lie.
//
// Registering a group in docsGroups does NOT enrol it here; that is the point. The other tests in
// this file still hold every registered group to its page.
var docsPlaceholderRatchetGroups = []string{
	"chart",
	"cluster",
	"drift",
	"iac",
	"members",
	"org",
	"repo",
	"staged",
	"teams",
}

// TestHygCliDocs_NoDocumentedExampleCarriesAPlaceholder is the `cli_ux` ratchet's docs half: an
// enrolled group's examples must be runnable AS WRITTEN.
//
// The programme's target number is "copied placeholders in the golden-path docs", and this is what
// makes it a number rather than an intention. An example carrying `<job-id>` is not an example — it
// is an instruction to go and find a value in some earlier command's output, which is the ergonomic
// failure the whole CLI programme exists to remove. Every such token in this group had a fix
// available in the tree already (`jobs logs --latest`, an id the picker resolves), so what the
// placeholder recorded was that nobody had gone back to the page.
//
// It inspects the groups ENROLLED in docsPlaceholderRatchetGroups, and that list only grows, so
// this is a ratchet: a page is held to it from the pass that enrols its group onward, and can never
// quietly regress.
func TestHygCliDocs_NoDocumentedExampleCarriesAPlaceholder(t *testing.T) {
	if len(docsPlaceholderRatchetGroups) == 0 {
		t.Fatal("the enrolment list is empty — every assertion in this test would be vacuous")
	}
	// One page can carry several enrolled groups (organizations.mdx carries org, members and
	// teams); read it once so a violation is reported once rather than per group.
	seen := map[string]bool{}
	var pages []string
	for _, group := range docsPlaceholderRatchetGroups {
		page, ok := docsGroups[group]
		if !ok {
			t.Errorf("%q is enrolled in docsPlaceholderRatchetGroups but is not in docsGroups.\n"+
				"      An enrolled group that no longer has a page is a stale entry, not a row to\n"+
				"      skip: remove it here in the same change that removes it from the registry.", group)
			continue
		}
		if seen[page] {
			continue
		}
		seen[page] = true
		pages = append(pages, page)
	}
	sort.Strings(pages)
	checked := 0
	for _, page := range pages {
		body := docsRead(t, docsPagePath(page))
		examples := docsFencedExamples(body)
		if len(examples) == 0 {
			continue // reported by TestHygCliDocs_EveryDocumentedExampleResolves
		}
		for _, example := range examples {
			checked++
			for _, token := range strings.Fields(example) {
				if docsPlaceholderToken(token) {
					t.Errorf("%s.mdx shows %q, which carries the placeholder %q.\n"+
						"      A reader cannot run that line; they have to find the value somewhere else\n"+
						"      first, which is the handoff this programme removes. Use a literal, or a\n"+
						"      form of the command that resolves the value itself.", page, example, token)
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("no example was inspected — every assertion above was vacuous")
	}
}

// TestHygCliDocs_ExamplesComeOnlyFromShellFences pins the collection rule on a fixture, in both
// directions: an invocation inside a ```bash fence is collected, and a line inside an untagged
// OUTPUT fence that happens to begin with "alethia" is not.
//
// A fixture and not a real page, because both arms must be reachable regardless of which pages are
// in the registry today — and the output line below is the exact one that made this rule necessary.
func TestHygCliDocs_ExamplesComeOnlyFromShellFences(t *testing.T) {
	const page = "# V\n\n```bash\nalethia verify receipt --latest\n```\n\n```\nalethia · verify receipt\n  Trust  org\n```\n\nRun `alethia verify show` to see the report.\n"

	got := docsFencedExamples(page)
	if len(got) != 1 || got[0] != "alethia verify receipt --latest" {
		t.Fatalf("collected %q, want exactly the one shell-fenced invocation", got)
	}
	for _, ex := range got {
		if strings.Contains(ex, "·") {
			t.Errorf("a rendered card title was collected as an invocation: %q", ex)
		}
	}
	// The other direction: drop the shell tag and the example goes with it, which is what
	// TestHygCliDocs_EveryLeafIsShownAtLeastOnce is there to catch. Asserting it here proves the
	// tag is what decides, rather than something else about the fixture.
	if got := docsFencedExamples(strings.Replace(page, "```bash", "```", 1)); len(got) != 0 {
		t.Errorf("an untagged fence yielded %q — the shell tag is not what the rule turns on", got)
	}
}

// docsLookupFlag resolves one flag token against a command, long or short, `--flag`, `-f` or
// `--flag=value`. It returns nil when the flag does not exist on that command.
func docsLookupFlag(cmd *cobra.Command, token string) *pflag.Flag {
	name := strings.TrimLeft(token, "-")
	if i := strings.Index(name, "="); i >= 0 {
		name = name[:i]
	}
	if strings.HasPrefix(token, "--") {
		if f := cmd.Flags().Lookup(name); f != nil {
			return f
		}
		return cmd.InheritedFlags().Lookup(name)
	}
	if f := cmd.Flags().ShorthandLookup(name); f != nil {
		return f
	}
	return cmd.InheritedFlags().ShorthandLookup(name)
}

// docsSplitArgs separates the positional arguments from the flags and their values.
//
// It does NOT call cmd.ParseFlags: that writes into rootCmd's flag values, which are package
// globals shared with every other test in this file's package — a guard that mutates the thing it
// inspects would decide a later test's interactive arm. A boolean flag consumes no following
// token; any other flag consumes one unless it was written as `--flag=value`.
func docsSplitArgs(t *testing.T, cmd *cobra.Command, rest []string, example string) []string {
	t.Helper()
	var args []string
	for i := 0; i < len(rest); i++ {
		token := rest[i]
		if !strings.HasPrefix(token, "-") || token == "-" {
			args = append(args, token)
			continue
		}
		f := docsLookupFlag(cmd, token)
		if f == nil {
			t.Errorf("%q passes %s, which is not a flag of `%s`", example, token, cmd.CommandPath())
			continue
		}
		if f.Value.Type() != "bool" && !strings.Contains(token, "=") {
			i++ // the flag's value
		}
	}
	return args
}

// docsCommandTree returns the fenced command tree in index.mdx — the first fenced block that
// carries a top-level `├── `/`└── ` entry — and "" when the page has none.
//
// The bound is the whole point. Over the raw page the LAST top-level group's block runs to EOF:
// index.mdx ends `└── ops` and then carries ~70 further lines of callouts and other command
// examples, so a `\bname\b` search over that block could not fail. The registry only grows, and it
// grows until it contains whichever group is last.
func docsCommandTree(index string) string {
	var block []string
	fenced := false
	hasEntry := false
	for _, line := range strings.Split(index, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			if fenced && hasEntry {
				return strings.Join(block, "\n")
			}
			fenced = !fenced
			block, hasEntry = nil, false
			continue
		}
		if !fenced {
			continue
		}
		block = append(block, line)
		if strings.HasPrefix(line, "├── ") || strings.HasPrefix(line, "└── ") {
			hasEntry = true
		}
	}
	return ""
}

// docsIndexBlock returns the lines of the command tree in index.mdx that belong to one group: the
// line naming it, and the indented lines under it up to the next top-level entry.
//
// It searches the FENCED tree, never the raw page — see docsCommandTree for why an unbounded walk
// makes the assertion built on this block unfailable for the last group in the tree.
func docsIndexBlock(index, group string) string {
	tree := docsCommandTree(index)
	if tree == "" {
		return ""
	}
	head := regexp.MustCompile(`(?m)^[├└]── ` + regexp.QuoteMeta(group) + `\b`)
	loc := head.FindStringIndex(tree)
	if loc == nil {
		return ""
	}
	block := tree[loc[0]:]
	lines := strings.Split(block, "\n")
	for i := 1; i < len(lines); i++ {
		if strings.HasPrefix(lines[i], "├── ") || strings.HasPrefix(lines[i], "└── ") {
			return strings.Join(lines[:i], "\n")
		}
	}
	return block
}

// TestHygCliDocs_IndexBlockStopsAtTheClosingFence pins the bound the leaf-in-the-tree assertion
// rests on: the block for the LAST top-level entry must end at the closing fence.
//
// It runs on a fixture rather than on index.mdx because the defect it guards is only reachable for
// whichever group is last, and which group that is changes with the page. The prose below the fence
// names both leaves on purpose: unbounded, the block would swallow it and the `\bname\b` search in
// the test below would pass for a leaf that had been deleted from the tree.
func TestHygCliDocs_IndexBlockStopsAtTheClosingFence(t *testing.T) {
	const page = "# Commands\n\n```\nalethia\n├── cluster\n│   ├── list\n│   └── get [selector]\n└── ops\n    └── session --reason <r>\n```\n\nThe `ops` group opens a session; see get and list above.\n"

	block := docsIndexBlock(page, "ops")
	if block == "" {
		t.Fatal("the last top-level entry must still resolve to a block")
	}
	if strings.Contains(block, "The `ops` group") {
		t.Errorf("the last entry's block ran past the closing fence into the prose:\n%s", block)
	}
	if !strings.Contains(block, "session --reason") {
		t.Errorf("the block dropped the group's own leaves:\n%s", block)
	}

	if block := docsIndexBlock(page, "cluster"); strings.Contains(block, "ops") {
		t.Errorf("a group's block must stop at the next top-level entry:\n%s", block)
	}
	if got := docsIndexBlock(page, "runner"); got != "" {
		t.Errorf("a group absent from the tree has no block, got %q", got)
	}
	if got := docsIndexBlock("no fenced tree here", "cluster"); got != "" {
		t.Errorf("a page with no command tree has no block, got %q", got)
	}
}

// TestHygCliDocs_EveryLeafIsDocumented pins that a registered group's page and the command tree
// both mention every command the group can run.
func TestHygCliDocs_EveryLeafIsDocumented(t *testing.T) {
	if len(docsGroups) == 0 {
		t.Fatal("the registry is empty — every assertion in this file would be vacuous")
	}
	index := docsRead(t, docsPagePath("index"))

	checkedLeaves := 0
	for group, page := range docsGroups {
		groupCmd, _, err := rootCmd.Find([]string{group})
		if err != nil || groupCmd == rootCmd {
			t.Errorf("registry names group %q, which does not resolve — the registry only grows, "+
				"so a renamed or deleted group is a failure and never a skipped row", group)
			continue
		}
		body := docsRead(t, docsPagePath(page))
		block := docsIndexBlock(index, group)
		if block == "" {
			t.Errorf("group %q has no entry in the command tree in index.mdx", group)
		}

		leaves := docsLeaves(groupCmd)
		if len(leaves) == 0 {
			t.Errorf("group %q has no runnable subcommands — either it is not a group, or this "+
				"walk cannot see them, and either way the checks below say nothing", group)
			continue
		}
		for _, leaf := range leaves {
			checkedLeaves++
			path := docsLeafPath(group, leaf)
			heading := "## `" + path + "`"
			if !strings.Contains(body, heading) {
				t.Errorf("%s.mdx has no section for `%s` (want a heading %q)", page, path, heading)
			}
			// The GROUP's own leaf carries no name of its own to look for; the block existing at
			// all, asserted above, is exactly the claim "this group is in the tree".
			if len(leaf) == 0 {
				continue
			}
			if block != "" && !regexp.MustCompile(`\b`+regexp.QuoteMeta(leaf[len(leaf)-1])+`\b`).MatchString(block) {
				t.Errorf("`%s` is missing from the command tree in index.mdx:\n%s", path, block)
			}
		}
	}
	if checkedLeaves == 0 {
		t.Fatal("no leaf command was checked — the registry resolved nothing")
	}
}

// TestHygCliDocs_EveryDocumentedExampleResolves executes every documented invocation against the
// real cobra tree, short of running it: the command exists and is a leaf, its flags exist, and its
// arguments are ones it accepts.
//
// A `--help` that exits 0 proves a command RESOLVES, not that the line a reader will copy works.
// The three ways a documented example rots — a renamed command that silently resolves to its
// parent's help, a flag that moved, an argument arity that changed — are each a separate arm here.
func TestHygCliDocs_EveryDocumentedExampleResolves(t *testing.T) {
	if len(docsGroups) == 0 {
		t.Fatal("the registry is empty — every assertion in this file would be vacuous")
	}
	checkedExamples := 0
	// Over the PAGES, not the groups. Three groups document onto notifications.mdx, and iterating
	// the registry would read and re-check that page three times — which is not merely wasteful:
	// checkedExamples, the vacuity floor at the bottom, would count the same example three times
	// and report a healthier census than the guard actually has.
	for page, onThisPage := range docsPageGroups() {
		body := docsRead(t, docsPagePath(page))
		examples := docsFencedExamples(body)
		if len(examples) == 0 {
			t.Errorf("%s.mdx shows no `alethia …` invocation — a command page with no example is "+
				"a page this guard cannot check", page)
			continue
		}
		for _, example := range examples {
			checkedExamples++
			tokens := docsTokens(example)[1:] // drop "alethia"
			cmd, rest, err := rootCmd.Find(tokens)
			if err != nil {
				t.Errorf("%q does not resolve: %v", example, err)
				continue
			}
			if !cmd.Runnable() {
				// This is the silent one. `alethia cluster gett` resolves to `cluster`, which
				// prints help and exits 0, so a `--help` smoke test would call it fine.
				t.Errorf("%q resolves to `%s`, which is a command GROUP, not a leaf — it would "+
					"print help and exit 0", example, cmd.CommandPath())
				continue
			}
			top := strings.Fields(cmd.CommandPath())[1]
			if docsGroupIsRegistered(top) && !onThisPage[top] {
				t.Errorf("%q is on %s.mdx but resolves to `%s`, whose group %q documents onto %s.mdx",
					example, page, cmd.CommandPath(), top, docsGroups[top])
			}
			args := docsSplitArgs(t, cmd, rest, example)
			if err := cmd.ValidateArgs(args); err != nil {
				t.Errorf("%q passes %d argument(s) %v that `%s` does not accept: %v",
					example, len(args), args, cmd.CommandPath(), err)
			}
		}
	}
	if checkedExamples == 0 {
		t.Fatal("no example was executed — every assertion above was vacuous")
	}
}

// TestHygCliDocs_EveryLeafIsShownAtLeastOnce pins the other direction: a command with a heading and
// no runnable example is a section a reader cannot copy from.
func TestHygCliDocs_EveryLeafIsShownAtLeastOnce(t *testing.T) {
	checked := 0
	for group, page := range docsGroups {
		groupCmd, _, err := rootCmd.Find([]string{group})
		if err != nil || groupCmd == rootCmd {
			continue // reported by TestHygCliDocs_EveryLeafIsDocumented
		}
		examples := docsFencedExamples(docsRead(t, docsPagePath(page)))
		for _, leaf := range docsLeaves(groupCmd) {
			checked++
			path := docsLeafPath(group, leaf)
			shown := false
			for _, example := range examples {
				cmd, _, err := rootCmd.Find(docsTokens(example)[1:])
				if err == nil && cmd.CommandPath() == path {
					shown = true
					break
				}
			}
			if !shown {
				t.Errorf("`%s` has no runnable example on %s.mdx", path, page)
			}
		}
	}
	if checked == 0 {
		t.Fatal("no leaf was checked — every assertion above was vacuous")
	}
}

// TestHygCliDocs_FencedExamplesJoinContinuations pins the line-continuation rule on a FIXTURE.
//
// A fixture and not a real page, deliberately: whether any registered page currently wraps an
// example is an editorial accident, so a test that only read the live pages would pass today and
// stop testing anything the moment somebody unwrapped a line. The behaviour has to be pinned where
// it cannot be silently un-exercised.
//
// Two failures are pinned, and they are different. Un-joined, the trailing backslash arrives as a
// POSITIONAL ARGUMENT — which is what made `alethia chart attach api -p shop \` look like a
// two-argument invocation of a command that takes one — and everything on the continuation lines is
// never examined at all, which is where a renamed flag would hide.
func TestHygCliDocs_FencedExamplesJoinContinuations(t *testing.T) {
	const page = "```bash\n" +
		"alethia chart attach api -p shop \\\n" +
		"  --repo https://github.com/acme/charts \\\n" +
		"  --chart-path charts/api\n" +
		"```\n"

	got := docsFencedExamples(page)
	if len(got) != 1 {
		t.Fatalf("a wrapped example is ONE invocation, got %d: %v", len(got), got)
	}
	want := "alethia chart attach api -p shop --repo https://github.com/acme/charts --chart-path charts/api"
	if got[0] != want {
		t.Errorf("continuation lines were not joined:\n got %q\nwant %q", got[0], want)
	}
	if strings.Contains(got[0], `\`) {
		t.Errorf("the backslash must not survive into the argument list: %q", got[0])
	}
}

// The other half: a continuation that never terminates must not splice itself onto the next block.
func TestHygCliDocs_AnUnterminatedContinuationStaysInItsBlock(t *testing.T) {
	const page = "```bash\nalethia cluster list \\\n```\n\n```bash\nalethia cluster get api\n```\n"
	got := docsFencedExamples(page)
	for _, ex := range got {
		if strings.Contains(ex, "list") && strings.Contains(ex, "get") {
			t.Fatalf("two fenced blocks were spliced into one example: %q", ex)
		}
	}
	found := false
	for _, ex := range got {
		if ex == "alethia cluster get api" {
			found = true
		}
	}
	if !found {
		t.Errorf("the second block's example was lost: %v", got)
	}
}

// TestHygCliDocs_PlaceholderTokenNamesTheThreeShapes pins the classifier the ratchet rests on,
// including the shape that does NOT announce itself.
func TestHygCliDocs_PlaceholderTokenNamesTheThreeShapes(t *testing.T) {
	for token, want := range map[string]bool{
		"<job-id>":                 true,
		"--job=<id>":               true,
		"[selector]":               true,
		"8f3c2a1e-...":             true,
		"8f3c2a1e-…":               true,
		"api":                      false,
		"--repo":                   false,
		"oci://registry.io/acme/a": false,
		"replicas=2":               false,
		"[]":                       false,
		"./api-values.yaml":        false,
	} {
		if got := docsPlaceholderToken(token); got != want {
			t.Errorf("docsPlaceholderToken(%q) = %v, want %v", token, got, want)
		}
	}
}
