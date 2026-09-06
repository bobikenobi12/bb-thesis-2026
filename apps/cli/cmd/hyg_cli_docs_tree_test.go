// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"regexp"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// The command tree in index.mdx is a CONTRACT, not a picture.
//
// `alethia jobs get <job_id>` and `alethia jobs get [job_id]` say different things to a reader: the
// first says the id is required, which is what makes the reader go and find one. #3740 made those
// three ids optional and gave the commands a picker, and the tree went on showing angle brackets
// for five weeks. Nothing objected, because the docs guard only reads the pages of REGISTERED
// groups and `jobs` was not one — and even for a registered group it read the page's examples and
// the presence of a leaf in the tree, never what the tree SAID about that leaf's arguments.
//
// This reads it. For every leaf in the registry, the brackets in the tree must agree with the
// brackets in the command's own Use string, which is the string cobra prints in --help. Two
// renderings of one fact, checked against each other rather than typed twice.

// docsLeafPages registers TOP-LEVEL LEAF commands — the ones that are not a group and so cannot be
// reached by docsGroups, whose every assertion starts by walking a group's subcommands.
//
// `alethia open`, `alethia version` and `alethia update` are the shell's whole user-facing surface
// and were outside every docs guard for exactly that structural reason: the registry's shape
// assumed a noun group, and these three are verbs hanging off the root.
var docsLeafPages = map[string]string{
	// command → docs page, relative to the repository root
	"open":    "apps/docs/content/docs/cli/identity.mdx",
	"version": "apps/docs/content/docs/cli/identity.mdx",
	"update":  "apps/docs/content/docs/cli/installation.mdx",
}

// docsTreeArgSpec is the argument shape of one command line, as brackets alone.
//
// Only the shape: `<job_id>` and `<id>` are the same statement to this guard, because the guard's
// question is "does the tree agree with --help about what is REQUIRED", not "do two files spell a
// placeholder the same way". A name check would fail on `<project_name>` versus `<name>` and would
// be switched off rather than fixed.
type docsTreeArgSpec struct {
	required int
	optional int
}

// docsArgToken classifies one whitespace-separated token of a usage line.
var (
	docsRequiredArg = regexp.MustCompile(`^<[^>]+>$`)
	docsOptionalArg = regexp.MustCompile(`^\[[^\]]+\]$`)
	docsFlagToken   = regexp.MustCompile(`^\[?-`)
)

// docsParseArgSpec reads the positional arguments out of a usage line's tail.
//
// A token starting with `-` is a flag and CONSUMES the value token after it, which is the whole
// subtlety: `login [--web-origin <url>]` has no positional arguments at all, and a walk that
// counted `<url>` would read it as one required argument and report every line with a valued flag.
// `[-f/--follow]` and `[--key-file <f>]` are the two bracketed spellings the tree uses.
func docsParseArgSpec(tail string) docsTreeArgSpec {
	var spec docsTreeArgSpec
	tokens := strings.Fields(tail)
	for i := 0; i < len(tokens); i++ {
		// An alternation group — `(--role <name|id> | --permission <key>)` on `grants add` — wraps
		// its first and last token in parentheses and separates them with a bare pipe. Unwrapping
		// them turns the group back into the flags it is made of; without this the `<name|id>`
		// after `(--role` was counted as a required POSITIONAL, because the token before it did
		// not start with a dash.
		tok := strings.Trim(tokens[i], "()")
		if tok == "|" || tok == "" {
			continue
		}
		if docsFlagToken.MatchString(tok) {
			// A bracketed flag group carries its own value inside the brackets when it has one,
			// so only a BARE flag consumes the next token.
			if !strings.HasPrefix(tok, "[") && i+1 < len(tokens) &&
				(docsRequiredArg.MatchString(strings.Trim(tokens[i+1], "()")) ||
					docsOptionalArg.MatchString(strings.Trim(tokens[i+1], "()"))) {
				i++
			}
			continue
		}
		switch {
		case docsRequiredArg.MatchString(tok):
			spec.required++
		case docsOptionalArg.MatchString(tok):
			spec.optional++
		}
	}
	return spec
}

// docsTreeDepth is the nesting depth of a tree line, in the four-column steps the tree draws with.
//
// The tree indents with `│   ` and `    `, both four columns wide, so a leaf's depth is the width of
// everything before its `├── ` or `└── ` marker divided by four.
func docsTreeDepth(line string) int {
	i := strings.Index(line, "├── ")
	if i < 0 {
		i = strings.Index(line, "└── ")
	}
	if i < 0 {
		return -1
	}
	return len([]rune(line[:i])) / 4
}

// docsTreeName is the command name a tree line declares, or "" when the line declares none.
func docsTreeName(line string) string {
	d := docsTreeDepth(line)
	if d < 0 {
		return ""
	}
	rest := line
	if i := strings.Index(rest, "├── "); i >= 0 {
		rest = rest[i+len("├── "):]
	} else if i := strings.Index(rest, "└── "); i >= 0 {
		rest = rest[i+len("└── "):]
	}
	fields := strings.Fields(rest)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

// docsTreeLinePath returns the argument tail of the tree line for one full command path, walking
// the tree by DEPTH rather than searching for the last element by name.
//
// The depth walk is not fastidiousness. `project` has both `env add` and `component add`, and a
// search for the last element found whichever came first — so the guard compared `component add`
// against the line for `env add` and reported a mismatch that named the wrong command. A comparison
// guard that lines up the wrong pair is worse than no guard: it sends a reader to fix something
// that is correct.
//
// An empty result means the tree does not show this command. That is a real defect and a DIFFERENT
// one — "the tree omits a leaf" belongs to TestHygCliDocs_EveryLeafIsDocumented, which is registry
// scoped — so it is reported by the caller as "not comparable" rather than silently compared as
// two empty strings, which would always agree.
func docsTreeLinePath(index string, path []string) string {
	tree := docsCommandTree(index)
	if tree == "" || len(path) == 0 {
		return ""
	}
	lines := strings.Split(tree, "\n")
	depth := 0
	start := 0
	for _, want := range path {
		found := -1
		for i := start; i < len(lines); i++ {
			d := docsTreeDepth(lines[i])
			if d < 0 {
				continue
			}
			if d < depth {
				break // left the parent's block without finding it
			}
			if d == depth && docsTreeName(lines[i]) == want {
				found = i
				break
			}
		}
		if found < 0 {
			return ""
		}
		start, depth = found+1, depth+1
	}
	line := lines[start-1]
	if i := strings.Index(line, "├── "); i >= 0 {
		line = line[i+len("├── "):]
	} else if i := strings.Index(line, "└── "); i >= 0 {
		line = line[i+len("└── "):]
	}
	fields := strings.Fields(line)
	if len(fields) <= 1 {
		return ""
	}
	line = strings.Join(fields[1:], " ")
	// A trailing `# …` comment is prose, not part of the invocation.
	if i := strings.Index(line, "#"); i >= 0 {
		line = line[:i]
	}
	return strings.TrimSpace(line)
}

// docsUseTail returns the argument portion of a command's Use string.
func docsUseTail(cmd *cobra.Command) string {
	fields := strings.Fields(cmd.Use)
	if len(fields) <= 1 {
		return ""
	}
	return strings.Join(fields[1:], " ")
}

// docsTreeComparableLeaves are commands the tree MUST show and MUST agree with.
//
// Named cases, not a count. The walk below covers every leaf the tree shows — 92 of them — and the
// way that silently becomes worthless is the walk finding nothing and comparing zero pairs. A
// threshold ("at least 50 leaves") would drift down with the tree; these six are one per shape the
// walk has to get right: a top-level leaf, a nested leaf, two leaves under one group sharing a
// final name, a leaf with a required positional, one with an optional positional, and one with
// none. If the walk stops seeing any of them it has broken, whatever the total says.
var docsTreeComparableLeaves = [][]string{
	{"cluster", "get"},              // optional positional, the shape #3740 introduced
	{"jobs", "get"},                 // the leaf whose brackets were stale for five weeks
	{"project", "env", "add"},       // nested two deep
	{"project", "component", "add"}, // shares its final name with the line above
	{"config", "set"},               // two positionals
	{"classification", "show"},      // a REQUIRED positional — the bracket that must stay angled.
	// Was `alerts delete` until this lane converted the governance groups to flags: the shape this
	// canary watches for left that leaf, so the sample moved to one that still carries it.
	// `classification show <kind> <id>` carries two.
	{"runner", "list"}, // none at all
}

// TestHygCliDocs_TheTreeAgreesWithTheUsageString compares the two renderings of every leaf's
// argument arity: the brackets in the command tree, and the brackets in the command's own Use
// string — which is what cobra prints in `--help`.
//
// DERIVED from the live tree, with no registry. The first cut of this guard was opt-in like the
// page registry beside it, and that was wrong for a reason a mutation test found: an opt-in list
// can silently EMPTY. Deleting the one entry left the guard green, and the contract it was supposed
// to hold `jobs` to simply stopped existing. The page contract needs an opt-in because a page has
// to be written; a tree line already exists for every leaf the tree shows, so there is nothing to
// opt in to and the set derives itself.
//
// A leaf the tree does NOT show is skipped here and reported separately. That is a real defect —
// `addon enable`, `chart attach`, `runner register` and the whole `provider` and
// `token` groups are missing from the tree — but it is a different one, owned by
// TestHygCliDocs_EveryLeafIsDocumented, and comparing an absent line would compare "" against ""
// and always agree.
func TestHygCliDocs_TheTreeAgreesWithTheUsageString(t *testing.T) {
	index := docsRead(t, docsPagePath("index"))
	compared := map[string]bool{}
	var absent []string

	var walk func(cmd *cobra.Command, path []string)
	walk = func(cmd *cobra.Command, path []string) {
		for _, sub := range cmd.Commands() {
			if sub.Hidden || sub.Name() == "help" || sub.Name() == "completion" {
				continue
			}
			next := append(append([]string{}, path...), sub.Name())
			if sub.Runnable() {
				line := docsTreeLinePath(index, next)
				key := strings.Join(next, " ")
				if docsTreeLinePath(index, next) == "" && !docsTreeShows(index, next) {
					absent = append(absent, key)
				} else {
					compared[key] = true
					want := docsParseArgSpec(docsUseTail(sub))
					if got := docsParseArgSpec(line); got != want {
						t.Errorf("the command tree in index.mdx shows `%s %s` with %d required and "+
							"%d optional argument(s), but `%s` takes %d required and %d optional.\n"+
							"      Angle brackets tell a reader to go and find a value first. `%s`",
							sub.Name(), line, got.required, got.optional,
							sub.CommandPath(), want.required, want.optional, sub.Use)
					}
				}
			}
			walk(sub, next)
		}
	}
	walk(rootCmd, nil)

	for _, leaf := range docsTreeComparableLeaves {
		if !compared[strings.Join(leaf, " ")] {
			t.Errorf("`alethia %s` was not compared — the tree walk cannot see it, so this "+
				"guard's silence says nothing about the other leaves either",
				strings.Join(leaf, " "))
		}
	}
	if len(compared) == 0 {
		t.Fatal("no leaf was compared — the walk read nothing")
	}
	t.Logf("%d leaves compared; %d not shown in the tree at all (a separate defect, see "+
		"TestHygCliDocs_EveryLeafIsDocumented): %s",
		len(compared), len(absent), strings.Join(absent, ", "))
}

// TestHygCliDocs_TheBackstopCoversItsShapes checks docsTreeComparableLeaves against the properties
// its comment claims, rather than against its length.
//
// A hand-written canary list decays the way every hand-written list does: an entry is deleted and
// nothing objects, because the remaining entries still pass. Found by mutation — removing the one
// leaf that shares its final name with another left this file green, and with it the only case that
// can catch a depth-blind walk. So the list is held to its SHAPES, which are derived from the live
// command tree: if a shape stops being represented, the list has lost its point whatever its size.
func TestHygCliDocs_TheBackstopCoversItsShapes(t *testing.T) {
	var nested, sharedFinalName, required, optional, none bool
	finals := map[string]int{}
	for _, leaf := range docsTreeComparableLeaves {
		if len(leaf) > 2 {
			nested = true
		}
		// Keyed on the GROUP and the final name together. Keying on the final name alone counted
		// `cluster get` and `jobs get` as a shared pair — and they are not the shape this canary
		// exists for, because they live under different parents and no walk could confuse them.
		// The collision that matters is two leaves sharing a final name under ONE parent, which is
		// `project env add` and `project component add`, and only that pair can catch a walk that
		// matches a name at any depth.
		finals[leaf[0]+" "+leaf[len(leaf)-1]]++
		cmd, _, err := rootCmd.Find(leaf)
		if err != nil {
			t.Errorf("the backstop names `alethia %s`, which does not resolve", strings.Join(leaf, " "))
			continue
		}
		switch spec := docsParseArgSpec(docsUseTail(cmd)); {
		case spec.required > 0:
			required = true
		case spec.optional > 0:
			optional = true
		default:
			none = true
		}
	}
	for _, n := range finals {
		if n > 1 {
			sharedFinalName = true
		}
	}
	for _, c := range []struct {
		ok   bool
		what string
	}{
		{nested, "a leaf nested more than one level deep"},
		{sharedFinalName, "two leaves that share a final name — the only shape that catches a depth-blind walk"},
		{required, "a leaf with a required positional"},
		{optional, "a leaf with an optional positional"},
		{none, "a leaf with no positional at all"},
	} {
		if !c.ok {
			t.Errorf("docsTreeComparableLeaves no longer covers %s. It is a canary, not a sample: "+
				"a shape it stops representing is a way the walk can break in silence", c.what)
		}
	}
}

// docsTreeShows reports whether the tree carries a line for this command path at all, whether or
// not that line has any arguments after the name.
//
// Separate from docsTreeLinePath because that function returns "" for BOTH "no such line" and "a
// line with no arguments" — and `runner list` is the second. Without this, every argument-less leaf
// would be filed as missing from the tree.
func docsTreeShows(index string, path []string) bool {
	tree := docsCommandTree(index)
	if tree == "" || len(path) == 0 {
		return false
	}
	lines := strings.Split(tree, "\n")
	depth, start := 0, 0
	for _, want := range path {
		found := -1
		for i := start; i < len(lines); i++ {
			d := docsTreeDepth(lines[i])
			if d < 0 {
				continue
			}
			if d < depth {
				break
			}
			if d == depth && docsTreeName(lines[i]) == want {
				found = i
				break
			}
		}
		if found < 0 {
			return false
		}
		start, depth = found+1, depth+1
	}
	return true
}

// TestHygCliDocs_ArgSpecParserReadsTheTreesSpellings is the parser's own test.
//
// A parser that returned {0,0} for everything would make the guard above pass on every line, so it
// is driven here against the real spellings the tree uses — including the two that would break a
// naive count: a required flag with a value, and a bracketed flag group with a value inside it.
func TestHygCliDocs_ArgSpecParserReadsTheTreesSpellings(t *testing.T) {
	cases := map[string]docsTreeArgSpec{
		"":                                  {0, 0},
		"<job_id>":                          {1, 0},
		"[job_id]":                          {0, 1},
		"[console|docs]":                    {0, 1},
		"<key> <value>":                     {2, 0},
		"[--status <S>] [-n/--limit <N>]":   {0, 0},
		"<job_id> [-f/--follow]":            {1, 0},
		"[-f/--force] [--web-origin <url>]": {0, 0},
		"<name> --region <r>":               {1, 0},
		"-j <job_id> [--key-file <f>]":      {0, 0},
		"[project] [--format <f>]":          {0, 1},
		// The alternation group on `grants add`: two flags, no positionals. Every token in it is
		// wrapped or separated by punctuation the other spellings never use.
		"[--principal <email|team|id>] (--role <name|id> | --permission <key>) [--effect allow]": {0, 0},
		"(--a <x> | --b <y>)": {0, 0},
	}
	for line, want := range cases {
		if got := docsParseArgSpec(line); got != want {
			t.Errorf("docsParseArgSpec(%q) = %+v, want %+v", line, got, want)
		}
	}
}

// TestHygCliDocs_TreeWalkFindsTheRightLine proves the depth walk lines up the pairs it compares.
//
// Without it the guard above compares "" against "" for a leaf whose line it failed to locate and
// reports clean — the "nothing found is not nothing wrong" shape, which for a COMPARISON guard is
// invisible because both sides collapse to the same empty value. Worse, the walk it replaced lined
// up the WRONG pair: it searched a group's block for the leaf's final name, so `project component
// add` was compared against the line for `project env add`.
func TestHygCliDocs_TreeWalkFindsTheRightLine(t *testing.T) {
	index := docsRead(t, docsPagePath("index"))

	// The two leaves that share a final name must resolve to DIFFERENT lines.
	envAdd := docsTreeLinePath(index, []string{"project", "env", "add"})
	compAdd := docsTreeLinePath(index, []string{"project", "component", "add"})
	if envAdd == "" || compAdd == "" {
		t.Fatalf("the walk lost a nested leaf: env add = %q, component add = %q", envAdd, compAdd)
	}
	if envAdd == compAdd {
		t.Errorf("`project env add` and `project component add` resolved to the same line %q — "+
			"the walk is matching on the final name rather than the path", envAdd)
	}
	if !strings.Contains(compAdd, "--kind") {
		t.Errorf("`project component add` resolved to %q, which is not its line", compAdd)
	}

	// The sharp case, and the one a walk that matched a name at ANY depth would fail. `project` has
	// no direct `add` child — `add` exists only two levels down, under `env` and under `component`
	// — so a depth-blind search starting after the `project` line finds `env add` and hands back a
	// line for a command that does not exist. Both of the assertions above still pass with the
	// depth check removed; this one does not.
	if got := docsTreeLinePath(index, []string{"project", "add"}); got != "" {
		t.Errorf("`alethia project add` is not a command, but the walk resolved it to %q — it is "+
			"matching a name at any depth and will line up the wrong pair", got)
	}
	if docsTreeShows(index, []string{"project", "add"}) {
		t.Error("`alethia project add` does not exist, but docsTreeShows claims the tree has it")
	}

	// A leaf with no arguments has an empty tail but IS shown; the two must not be confused.
	if got := docsTreeLinePath(index, []string{"runner", "list"}); got != "" {
		t.Errorf("`runner list` takes no arguments, so its tail is empty, got %q", got)
	}
	if !docsTreeShows(index, []string{"runner", "list"}) {
		t.Error("`runner list` is in the tree, but docsTreeShows says it is not — every " +
			"argument-less leaf would be filed as missing")
	}

	// A leaf that is genuinely absent must come back absent rather than matching something else.
	if docsTreeShows(index, []string{"cluster", "definitely-not-a-leaf"}) {
		t.Error("an absent leaf was reported as shown")
	}
	// `token` is REGISTERED but carries no docs page, so it is absent from the tree. This was
	// `promotion get` until this lane added the promotion group and its page — an absent-leaf
	// canary has to name something still absent, and what it names is exactly what a lane like
	// this one makes exist.
	if docsTreeShows(index, []string{"token", "create"}) {
		t.Error("`token` is not in the command tree at all; reporting it as shown would " +
			"compare its line against nothing")
	}
}

// TestHygCliDocs_TreeDepthReadsTheDrawing pins the indentation arithmetic the walk rests on.
func TestHygCliDocs_TreeDepthReadsTheDrawing(t *testing.T) {
	cases := []struct {
		line  string
		depth int
		name  string
	}{
		{"├── project", 0, "project"},
		{"└── ops", 0, "ops"},
		{"│   ├── list", 1, "list"},
		{"│   └── add <name>", 1, "add"},
		{"│   │   ├── list", 2, "list"},
		{"│       └── remove --kind <k>", 2, "remove"},
		{"alethia", -1, ""},
		{"", -1, ""},
	}
	for _, tc := range cases {
		if got := docsTreeDepth(tc.line); got != tc.depth {
			t.Errorf("docsTreeDepth(%q) = %d, want %d", tc.line, got, tc.depth)
		}
		if got := docsTreeName(tc.line); got != tc.name {
			t.Errorf("docsTreeName(%q) = %q, want %q", tc.line, got, tc.name)
		}
	}
}

// TestHygCliDocs_EveryShellLeafIsDocumented is docsGroups' contract for the commands its SHAPE
// cannot reach.
//
// Every assertion in hyg_cli_docs_test.go begins by walking a group's subcommands, so a top-level
// leaf — `alethia open`, `alethia version`, `alethia update` — resolves to a command with no
// children and is reported as "not a group" rather than checked. All three were outside every docs
// guard for that structural reason alone, which is the kind of gap a registry keyed on the wrong
// noun leaves behind.
//
// The page is named per command because they are not all on one: `update` belongs with installing
// the CLI, the other two with using it.
func TestHygCliDocs_EveryShellLeafIsDocumented(t *testing.T) {
	if len(docsLeafPages) == 0 {
		t.Fatal("no top-level leaf is registered — every assertion here would be vacuous")
	}
	index := docsRead(t, docsPagePath("index"))
	tree := docsCommandTree(index)
	if tree == "" {
		t.Fatal("index.mdx has no fenced command tree, so the tree half of this check reads nothing")
	}

	for name, page := range docsLeafPages {
		cmd, _, err := rootCmd.Find([]string{name})
		if err != nil || cmd == rootCmd {
			t.Errorf("the registry names %q, which does not resolve — the registry only grows, so "+
				"a renamed or deleted command is a failure and never a skipped row", name)
			continue
		}
		if !cmd.Runnable() {
			t.Errorf("%q is not runnable — it belongs in docsGroups, not here", name)
			continue
		}
		body := shellDocsRead(t, page)

		// Either heading level. identity.mdx nests these under "## Utility Commands", so they are
		// h3 there and h2 would be wrong; installation.mdx has `update` at the top level.
		if !strings.Contains(body, "## `alethia "+name+"`") {
			t.Errorf("%s has no section for `alethia %s` (want a `## ` or `### ` heading naming it)",
				page, name)
		}
		if !regexp.MustCompile(`(?m)^[├└]── ` + regexp.QuoteMeta(name) + `\b`).MatchString(tree) {
			t.Errorf("`alethia %s` is missing from the command tree in index.mdx", name)
		}
		if !strings.Contains(body, "alethia "+name) {
			t.Errorf("%s never shows `alethia %s` as an invocation a reader could copy", page, name)
		}

		// The tree line's argument arity must agree with the command's own Use string, exactly as
		// it must for a group's leaves.
		line := docsTreeLineTopLevel(tree, name)
		want := docsParseArgSpec(docsUseTail(cmd))
		if got := docsParseArgSpec(line); got != want {
			t.Errorf("the command tree shows `%s %s` with %d required and %d optional argument(s), "+
				"but `%s` takes %d required and %d optional",
				name, line, got.required, got.optional, cmd.CommandPath(), want.required, want.optional)
		}
	}
}

// docsTreeLineTopLevel returns the argument tail of a top-level entry in the command tree.
func docsTreeLineTopLevel(tree, name string) string {
	entry := regexp.MustCompile(`(?m)^[├└]── ` + regexp.QuoteMeta(name) + `\b(.*)$`)
	m := entry.FindStringSubmatch(tree)
	if m == nil {
		return ""
	}
	line := m[1]
	if i := strings.Index(line, "#"); i >= 0 {
		line = line[:i]
	}
	return strings.TrimSpace(line)
}
