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

// A flag named in PROSE is a claim, and nothing was checking it.
//
// hyg_cli_docs_test.go resolves every flag in a fenced `alethia …` EXAMPLE against the real command
// tree. That is the strong check, and it has a blind spot exactly the width of the defect it was
// written beside: all eleven pages that told a reader `--org` was a global override said so in a
// Callout, in prose, and not one of them showed it in an example. Eleven pages named a flag that did
// not exist on the commands they document, for months, with two guards walking those same files
// (#3817).
//
// cov_connectors_test.go's "Direction 2" already does this for three pages — connector, cloud and
// provider — against a HAND-WRITTEN list of the flags a page may name without registering
// (`connDocsGlobalFlags`). This is the same idea generalised to every page under `docs/cli`, with
// the exempt set derived from the live root command instead of typed out: a typed list of what a
// guard forgives is a list that silently stops matching the tree, and that one already carried
// `--org` while the root did not.
//
// ── THE SCOPING RULE ────────────────────────────────────────────────────────────────────────────
//
// "Which command's flags must this flag token resolve against?" is answered from the SPAN it is
// written in, and only then from the page. Every mention is inside an inline-code span, and the span
// says which of three things it is:
//
//  1. It names a command — `alethia jobs logs --latest --follow`, or `config export --format json`.
//     The flags resolve against THAT command (plus what it inherits and what its subcommands
//     register). This is what makes a cross-reference to another group's flag correct rather than
//     exempted: the page said which command it meant, so the guard reads it.
//  2. It is a bare flag — `--org <id>`, `-o, --output <table|json|csv>`. There is no command in the
//     span, so it resolves against THE PAGE's commands: the ones its own `alethia …` section
//     headings (`##` lines) name, live from the tree. That is the arm the `--org` claims failed.
//  3. It names some other program — `brew create --go --set-name alethia <url>`. Not our tree, not
//     our claim; skipped. Decided by whether the first word resolves as a command, so the list of
//     "other programs" is never written down and cannot go stale.
//
// The page's own commands come from its headings rather than from a registry, so a page documenting
// a new command is scoped to it by writing the heading it needs anyway — and those same headings are
// what TestHygCliDocs_EveryLeafIsDocumented already holds to the tree, so the two cannot drift.
//
// ── WHAT IT CANNOT CHECK, stated rather than left to be discovered ──────────────────────────────
//
//  1. A page with NO command heading has nothing to scope its bare flags to. `commands/index.mdx` is
//     the whole-tree reference and `commands/init.mdx` is a narrative walkthrough; both name flags
//     of commands they have no section for. Their bare flags fall back to EXISTENCE — registered
//     somewhere in the tree — and both are named in docsProseUnscopedPages, so a page cannot
//     quietly drop into that weaker tier by losing its headings.
//  2. The narrative pages directly under `docs/cli` (installation, authentication, configuration,
//     identity, tui, index) are tours of the whole CLI and are existence-checked for the same
//     reason. They are still checked — `--fomat` on any of them fails.
//  3. A bare flag that genuinely belongs to another command, with no invocation around it to say so
//     — `--plan-job-id` discussed in a paragraph on the jobs page. It cannot be told from a mistake
//     by reading the token, so each is recorded in docsProseForeignFlags with its reason. The
//     exemption relaxes the SCOPE and never the EXISTENCE: the flag must still resolve somewhere,
//     so a renamed flag fails through an exemption rather than hiding behind it.
//  4. A page saying a flag does NOT exist fails, because the token is on the page either way. That
//     is deliberate. "There is no `--org` override" is precisely the sentence that has to be
//     revisited when `--org` starts existing, and eleven pages carrying its opposite is how #3817
//     happened.
//
// It does NOT read fenced blocks. Those belong to the example guard, which resolves a whole
// invocation — command, arity and flags together — and re-checking them here would report one defect
// twice with the weaker of the two messages.

// docsProseDir is the CLI docs tree, as seen from apps/cli/cmd.
func docsProseDir() string {
	return filepath.Join(docsRepoRoot(), "apps", "docs", "content", "docs", "cli")
}

// docsProseUnscopedPages are the pages under commands/ with no `alethia …` command heading, and why
// each has none. Their bare flag mentions are checked for EXISTENCE only.
//
// Recorded rather than skipped, and checked in BOTH directions below: an entry naming a page that
// has since grown headings is as much a failure as a page that has lost them, because a stale
// exemption is how a page leaves the strong tier without anyone deciding that it should.
var docsProseUnscopedPages = map[string]string{
	"index.mdx": "the whole-tree command reference — it names every group's flags by design, and " +
		"carries a fenced command tree instead of per-command sections",
	"init.mdx": "a first-run walkthrough of `login` and `config set`, written as a narrative rather " +
		"than as sections for the commands it drives",
}

// docsProseForeignFlags records, per page, the BARE flag mentions that belong to a command the page
// does not document — and why each is a cross-reference rather than a mistake.
//
// Per page and not as one global set of "flags anybody may mention": `--plan-job-id` is a
// legitimate cross-reference on the jobs page and would be a defect on the cost page, and a set that
// cannot tell those apart forgives both.
//
// It is deliberately SMALL, and it is small because rule 1 above does the work. A page that writes
// the invocation — `alethia jobs logs --latest --follow` — needs no entry, and four pages that would
// otherwise be listed here are checked properly instead. An entry is the last resort, for a
// paragraph that discusses a flag without ever showing the command it is on.
var docsProseForeignFlags = map[string]map[string]string{
	"commands/jobs.mdx": {
		"--wait": "the `project plan`/`apply`/`destroy` flag. This page opens by saying there is no " +
			"`alethia jobs wait` command and that you pass `-w/--wait` to the command that QUEUES " +
			"the job instead — an answer to a jobs question that is deliberately about another " +
			"group's flag, and the sentence names the flag rather than an invocation",
		"--plan-job-id": "the `project apply` flag. The paragraph explains what the id that " +
			"`jobs get --latest` produces is FOR, which is a jobs-page question about a " +
			"project-page flag",
	},
}

// docsProseSpan matches one inline-code span. Single backticks, and never across a line break.
var docsProseSpan = regexp.MustCompile("`[^`\n]*`")

// docsProseFlagName matches a long flag inside such a span.
//
// Long only. A shorthand is one letter and `-o` is indistinguishable from a `-o` belonging to
// anything else in a sentence; the long form is the one a page makes a claim with, and `-o,
// --output …` carries both, so nothing is lost.
var docsProseFlagName = regexp.MustCompile(`--[a-z0-9][a-z0-9-]*`)

// docsProseHeading matches a command section heading: ## `alethia connector aws`
var docsProseHeading = regexp.MustCompile("(?m)^#{2,4} +`(alethia [a-z0-9][a-z0-9 -]*)`(.*)$")

// docsProseHeadingTail matches the further backticked words of a heading that names siblings:
// ## `alethia project plan` · `apply` · `destroy`
var docsProseHeadingTail = regexp.MustCompile("`([a-z0-9][a-z0-9-]*)`")

// docsProseStrip removes fenced code blocks, leaving the prose.
//
// By the fence markers rather than by counting them, so an unterminated fence swallows the rest of
// the page — which LOSES coverage rather than inventing it, and is a page the example guard's own
// fence walk would be equally confused by.
func docsProseStrip(page string) string {
	var out []string
	fenced := false
	for _, line := range strings.Split(page, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			fenced = !fenced
			continue
		}
		if !fenced {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}

// docsProseSpanKind classifies one inline-code span, per the three-way rule above.
//
// Returns the command the span names, or nil when it names none; ours is false when the span is
// some other program's invocation and this guard has no business reading it.
//
// The "is it ours" question is asked of the TREE — cobra's own Find, which strips flags for us —
// rather than of a list of foreign program names. A list would need `brew`, `git`, `jq`, `gcloud`,
// `kubectl`, `export`… and would be wrong the first time a page reached for a tool nobody listed.
func docsProseSpanKind(span string) (cmd *cobra.Command, ours bool) {
	fields := strings.Fields(strings.Trim(span, "`"))
	if len(fields) == 0 {
		return nil, false
	}
	// A bare flag list. No command named, so the page decides.
	if strings.HasPrefix(fields[0], "-") {
		return nil, true
	}
	tokens := fields
	if tokens[0] == "alethia" {
		tokens = tokens[1:]
	}
	if len(tokens) == 0 {
		// A bare `alethia`. It names the root, which has only the globals — treat it as a bare
		// mention so the page's own scope (which includes the globals) applies.
		return nil, true
	}
	found, _, err := rootCmd.Find(tokens)
	if err != nil || found == rootCmd {
		// `alethia … 2> log` and the like: ours, but it names no command, so the page decides.
		// Anything else — `brew create …`, `jq -r .id` — is not ours at all.
		return nil, fields[0] == "alethia"
	}
	return found, true
}

// docsProseCommands resolves the commands a page's headings name, against the live tree.
//
// A heading may name siblings after the first — a `##` line reading `alethia project plan` then
// `apply` then `destroy` is one heading and three commands — so every further backticked word is resolved under the first
// one's parent. A heading that does not resolve is dropped rather than reported: that is
// TestHygCliDocs_EveryLeafIsDocumented's finding, and saying it twice with a worse message helps
// nobody.
func docsProseCommands(page string) []*cobra.Command {
	var out []*cobra.Command
	for _, m := range docsProseHeading.FindAllStringSubmatch(page, -1) {
		tokens := strings.Fields(m[1])[1:] // drop "alethia"
		cmd, _, err := rootCmd.Find(tokens)
		if err != nil || cmd == rootCmd {
			continue
		}
		out = append(out, cmd)
		for _, sib := range docsProseHeadingTail.FindAllStringSubmatch(m[2], -1) {
			siblingPath := append(append([]string{}, tokens[:len(tokens)-1]...), sib[1])
			if c, _, err := rootCmd.Find(siblingPath); err == nil && c != rootCmd {
				out = append(out, c)
			}
		}
	}
	return out
}

// docsProseScope returns the long-flag names reachable from a set of commands: the root's
// persistent flags, plus every flag on each command, on its ancestors (through InheritedFlags) and
// on its descendants.
//
// Descendants, because a page heads a GROUP (a heading naming `alethia fleet`) and then its leaves'
// flags in the table underneath.
func docsProseScope(cmds []*cobra.Command) map[string]bool {
	allowed := map[string]bool{}
	collect := func(fs *pflag.FlagSet) {
		fs.VisitAll(func(f *pflag.Flag) { allowed["--"+f.Name] = true })
	}
	collect(rootCmd.PersistentFlags())
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		collect(c.Flags())
		collect(c.InheritedFlags())
		collect(c.PersistentFlags())
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	for _, c := range cmds {
		walk(c)
	}
	// cobra registers --help on a command the moment one has been executed in this package, so its
	// presence depends on test order. It is nobody's spec.
	allowed["--help"] = true
	return allowed
}

// docsProseTreeFlags is every long flag registered anywhere in the tree — the existence tier.
func docsProseTreeFlags() map[string]bool {
	return docsProseScope([]*cobra.Command{rootCmd})
}

// docsProsePages walks a directory for .mdx pages, returning slash-separated paths relative to it.
func docsProsePages(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".mdx") {
			return nil
		}
		rel, relErr := filepath.Rel(dir, path)
		if relErr != nil {
			return relErr
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v — this guard's verdict depends on the pages, so a directory it "+
			"cannot read is a failure rather than a pass", dir, err)
	}
	sort.Strings(out)
	return out
}

// docsProseCensus is what one page contributed, so the totals below can be asserted rather than
// assumed.
type docsProseCensus struct {
	spans, bare, invocations int
}

// TestHygCliDocsProse_EveryFlagNamedInProseExists is the guard.
//
// The census is asserted, fatally, at the end. A walk that finds no pages, no flag tokens, no
// page-scoped mention or no invocation-scoped mention has to FAIL: this guard's whole subject is
// text nothing else reads, so "I found nothing" and "there is nothing wrong" would otherwise be the
// same green — which is the defect class this repository keeps paying for.
func TestHygCliDocsProse_EveryFlagNamedInProseExists(t *testing.T) {
	dir := docsProseDir()
	pages := docsProsePages(t, dir)
	if len(pages) == 0 {
		t.Fatalf("no .mdx page under %s — every assertion below would be vacuous", dir)
	}

	tree := docsProseTreeFlags()
	if len(tree) < 2 {
		t.Fatalf("the live tree yielded %d long flags — this guard is resolving against nothing",
			len(tree))
	}

	var total docsProseCensus
	scannedPages, scopedMentions := 0, 0
	unscoped := map[string]bool{}

	for _, page := range pages {
		body := docsRead(t, filepath.Join(dir, filepath.FromSlash(page)))
		prose := docsProseStrip(body)
		scannedPages++

		cmds := docsProseCommands(body)
		pageScoped := strings.HasPrefix(page, "commands/") && len(cmds) > 0
		pageAllowed := tree
		if pageScoped {
			pageAllowed = docsProseScope(cmds)
		}
		var pageNames []string
		for _, c := range cmds {
			pageNames = append(pageNames, c.CommandPath())
		}

		for _, span := range docsProseSpan.FindAllString(prose, -1) {
			flags := docsProseFlagName.FindAllString(span, -1)
			if len(flags) == 0 {
				continue
			}
			cmd, ours := docsProseSpanKind(span)
			if !ours {
				continue
			}
			total.spans++

			allowed, subject := pageAllowed, "the command(s) this page documents ("+strings.Join(pageNames, ", ")+")"
			if cmd != nil {
				allowed = docsProseScope([]*cobra.Command{cmd})
				subject = "`" + cmd.CommandPath() + "`, which the span itself names"
				total.invocations++
			} else {
				total.bare++
				if pageScoped {
					scopedMentions++
				} else if strings.HasPrefix(page, "commands/") {
					unscoped[strings.TrimPrefix(page, "commands/")] = true
				}
			}

			for _, flag := range flags {
				if allowed[flag] {
					continue
				}
				if !tree[flag] {
					t.Errorf("%s writes %s in prose, and NO command in the tree registers %s.\n"+
						"      A reader is being told to type something that is refused as an "+
						"unknown flag — which is what eleven pages said about `--org` (#3817), in "+
						"prose, where no example guard could see it.", page, span, flag)
					continue
				}
				if cmd == nil && docsProseForeignFlags[page][flag] != "" {
					continue
				}
				t.Errorf("%s writes %s in prose. %s exists, but not on %s.\n"+
					"      Either it belongs there, or the sentence should name the command it is "+
					"on (a span like `alethia jobs logs --follow` is resolved against that command), "+
					"or it is a deliberate cross-reference and belongs in docsProseForeignFlags "+
					"with its reason.", page, span, flag, subject)
			}
		}
	}

	if scannedPages == 0 || total.spans == 0 || total.bare == 0 || total.invocations == 0 || scopedMentions == 0 {
		t.Fatalf("read %d pages; %d flag-bearing spans (%d bare, %d naming a command), %d of the "+
			"bare ones scoped to a page's own commands. A zero in any of those means this guard "+
			"read nothing and every assertion above was vacuous.",
			scannedPages, total.spans, total.bare, total.invocations, scopedMentions)
	}

	// The unscoped ledger, both directions. A commands/ page that loses its headings drops into the
	// existence tier, which is a real weakening and has to be a decision; an entry for a page that
	// has since grown headings is a stale exemption sitting where nobody will look at it.
	for page := range unscoped {
		if docsProseUnscopedPages[page] == "" {
			t.Errorf("commands/%s has no `alethia …` command heading, so the flags it names outside an "+
				"invocation are only checked for EXISTENCE. If that is right, record it in "+
				"docsProseUnscopedPages with the reason; a page must not stop being scoped "+
				"silently.", page)
		}
	}
	for page, reason := range docsProseUnscopedPages {
		if strings.TrimSpace(reason) == "" {
			t.Errorf("docsProseUnscopedPages[%q] has an empty reason — the record exists to carry "+
				"the reason", page)
		}
		if !unscoped[page] {
			t.Errorf("docsProseUnscopedPages names commands/%s, which is now scoped, names no bare "+
				"flag, or is gone. A stale exemption is how a page leaves the strong tier without "+
				"anyone deciding it should — remove the entry.", page)
		}
	}

	// And the cross-reference ledger the same way.
	live := map[string]bool{}
	for _, page := range pages {
		live[page] = true
	}
	for page, flags := range docsProseForeignFlags {
		if !live[page] {
			t.Errorf("docsProseForeignFlags names %q, which is not a page under %s", page, dir)
			continue
		}
		named := map[string]bool{}
		for _, span := range docsProseSpan.FindAllString(docsProseStrip(docsRead(t, filepath.Join(dir, filepath.FromSlash(page)))), -1) {
			if cmd, ours := docsProseSpanKind(span); ours && cmd == nil {
				for _, f := range docsProseFlagName.FindAllString(span, -1) {
					named[f] = true
				}
			}
		}
		for flag, reason := range flags {
			if strings.TrimSpace(reason) == "" {
				t.Errorf("docsProseForeignFlags[%q][%q] has an empty reason", page, flag)
			}
			if !named[flag] {
				t.Errorf("docsProseForeignFlags exempts %s on %s, which no longer names it outside "+
					"an invocation — remove the entry rather than leaving it to forgive the next "+
					"one", flag, page)
			}
			if !tree[flag] {
				t.Errorf("docsProseForeignFlags exempts %s on %s, and no command in the tree "+
					"registers it. The exemption relaxes the SCOPE, never the EXISTENCE: a "+
					"cross-reference to a flag that is gone is still a broken instruction.",
					flag, page)
			}
		}
	}
}

// TestHygCliDocsProse_ReadsProseAndNotFences pins the collection rule on a fixture, in both
// directions — a fixture, because which page happens to carry which shape is editorial and would
// stop exercising this the moment somebody rewrote one.
func TestHygCliDocsProse_ReadsProseAndNotFences(t *testing.T) {
	const page = "# X\n\nPass `--org <id>`, or `-o, --output <table|json|csv>`.\n\n" +
		"```bash\nalethia cluster list --fenced-flag\n```\n\n" +
		"An em dash -- like this -- is not a flag, and neither is <https://x.dev/a--b>.\n"

	var got []string
	for _, span := range docsProseSpan.FindAllString(docsProseStrip(page), -1) {
		got = append(got, docsProseFlagName.FindAllString(span, -1)...)
	}
	want := "--org,--output"
	if strings.Join(got, ",") != want {
		t.Errorf("collected %v, want %s", got, want)
	}
	for _, f := range got {
		if f == "--fenced-flag" {
			t.Error("a flag inside a fenced example was collected — fences are the example guard's")
		}
	}
}

// TestHygCliDocsProse_SpanKindNamesTheThreeCases pins the classifier the whole scoping rule rests
// on, and the third case is the one it exists for: `brew create --go` is not a claim about this CLI.
func TestHygCliDocsProse_SpanKindNamesTheThreeCases(t *testing.T) {
	for span, want := range map[string]string{
		"`--org <id>`":                        "", // bare: the page decides
		"`-o, --output <table|json|csv>`":     "", // bare
		"`alethia`":                           "", // names the root only
		"`alethia … 2> log`":                  "", // ours, names no command
		"`alethia members list --org o1`":     "alethia members list",
		"`members list --org o1`":             "alethia members list",
		"`alethia project plan --project-id`": "alethia project plan",
		"`brew create --go --set-name x`":     "!", // not ours
		"`jq -r .id`":                         "!", // not ours
		"`git config --global x`":             "!", // not ours
	} {
		cmd, ours := docsProseSpanKind(span)
		switch want {
		case "!":
			if ours {
				t.Errorf("%s was read as an alethia claim; it is another program's invocation", span)
			}
		case "":
			if !ours || cmd != nil {
				t.Errorf("%s must be a BARE mention (ours, no command), got ours=%v cmd=%v",
					span, ours, cmd)
			}
		default:
			if !ours || cmd == nil || cmd.CommandPath() != want {
				t.Errorf("%s must resolve to %s, got ours=%v cmd=%v", span, want, ours, cmd)
			}
		}
	}
}

// TestHygCliDocsProse_HeadingsScopeThePage pins the page-scoping rule, including the sibling form,
// and — the arm that matters — that the scope is NARROW. A scope of "every flag in the tree" would
// satisfy every positive assertion here and check nothing.
func TestHygCliDocsProse_HeadingsScopeThePage(t *testing.T) {
	const page = "## `alethia members list`\n\n## `alethia teams create` · `delete`\n\n## `alethia nope nope`\n"

	var got []string
	for _, c := range docsProseCommands(page) {
		got = append(got, c.CommandPath())
	}
	sort.Strings(got)
	want := "alethia members list,alethia teams create,alethia teams delete"
	if strings.Join(got, ",") != want {
		t.Fatalf("headings resolved to %v, want %s", got, want)
	}

	scope := docsProseScope(docsProseCommands(page))
	for _, f := range []string{"--org", "--output", "--no-input", "--name", "--yes"} {
		if !scope[f] {
			t.Errorf("%s must be in scope for the members/teams commands", f)
		}
	}
	if scope["--warm-min"] {
		t.Error("--warm-min belongs to `fleet set` and must not be in scope for members/teams")
	}
}
