// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

// The field spec for the BYO-IaC noun group — chart, iac, repo, drift and staged.
//
// A CLI command that takes a value renders that value FOUR times: as a flag or a positional, as a
// question in an interactive form, as the key that reaches the server, and as a row in the docs.
// Nothing made those four agree, and in this group they had already drifted:
//
//   - `chart attach` and `iac attach` could ask for NOTHING. Every field was flag-or-nothing, so
//     the two commands where a customer's own repository enters the product were the two you had
//     to already know the shape of before you could run them.
//   - `chart detach` and `chart scan` took an id you could only obtain by reading it out of
//     `chart list` and typing it back in — the copied placeholder the CLI programme exists to
//     remove.
//   - Six leaves refused an omitted `--project` outright, while `cost show` beside them (#3736)
//     had already learned to ask.
//
// This is the one place those fields are described. The forms READ their titles and descriptions
// from here rather than repeating them, so the form and the spec cannot disagree by construction;
// hyg_cli_byoform_test.go checks the other two renderings — that the flag or positional named here
// exists on the command, and that the docs page named here carries the same rows in the same order.
//
// Deliberately local, the same as the auth group's `authFields`: the general field-spec kit is
// #3661's. Two groups having written the same shape twice is the evidence that kit needs, not a
// reason to invent it here.
type byoField struct {
	// Command is the cobra command path the field belongs to, e.g. "alethia chart attach". It is
	// what the guard resolves against the real tree. A GROUP path (e.g. "alethia chart") is valid
	// and is how the two selectors every leaf in a group shares are described once rather than
	// once per leaf.
	Command string
	// Key identifies the field inside its command. Never shown; it is how a form asks for its own
	// spec.
	Key string
	// Title is the form's question AND the docs table's "Field" cell.
	Title string
	// Description is the form's helper line AND the docs table's "What it is" cell. One sentence,
	// no trailing period — the form renders it beneath the title.
	Description string
	// Flag is the long flag that supplies this value without a form. Empty when the value is a
	// positional argument, in which case Arg carries the placeholder. Exactly one of the two is
	// set; the guard fails on both or neither.
	Flag string
	// Arg is the positional placeholder as it appears in the command's Use string. It is written
	// in SQUARE brackets throughout this group: a positional a form can ask for is by definition
	// optional, and the guard asserts the command actually accepts being run without it.
	Arg string
	// Page is the docs file, relative to the repository root, whose fieldspec table carries this
	// row.
	Page string
}

// Field keys. Constants rather than literals so a typo is a compile error and a rename reaches the
// form and the spec together.
const (
	byoKeyProject    = "project"
	byoKeyEnv        = "env"
	byoKeyChartID    = "id"
	byoKeyRepo       = "repo"
	byoKeyChartPath  = "chart-path"
	byoKeyRef        = "ref"
	byoKeyNamespace  = "namespace"
	byoKeyValuesFile = "values-file"
	byoKeySet        = "set"
	byoKeyPath       = "path"
	byoKeyVar        = "var"
	byoKeyProvider   = "provider"
)

// Docs pages, relative to the repository root.
const (
	docsChartsPage = "apps/docs/content/docs/cli/commands/charts.mdx"
	docsIacPage    = "apps/docs/content/docs/cli/commands/iac.mdx"
	docsReposPage  = "apps/docs/content/docs/cli/commands/repositories.mdx"
	docsDriftPage  = "apps/docs/content/docs/cli/commands/drift.mdx"
	docsStagedPage = "apps/docs/content/docs/cli/commands/staged.mdx"
)

// byoFields is the spec. One entry per value a command in this group takes from a person.
//
// The four GROUP entries are the reason this type allows a group path. `--project` and `--env` are
// persistent flags registered once on `chart`, `iac`, `drift` and `staged`; describing them per
// leaf would put the same two rows on a page four times and let three of the copies rot. The
// classification guard treats a leaf as covered by its group's rows, which is what the code does.
var byoFields = []byoField{
	// ── the two selectors every project-scoped leaf shares ──
	{
		Command:     "alethia chart",
		Key:         byoKeyProject,
		Title:       "Project",
		Description: "The project, by name or id; omit it on a terminal and you are asked",
		Flag:        "project",
		Page:        docsChartsPage,
	},
	{
		Command:     "alethia chart",
		Key:         byoKeyEnv,
		Title:       "Environment",
		Description: "The environment, by name, stage or id; empty means the project's default",
		Flag:        "env",
		Page:        docsChartsPage,
	},
	{
		Command:     "alethia iac",
		Key:         byoKeyProject,
		Title:       "Project",
		Description: "The project, by name or id; omit it on a terminal and you are asked",
		Flag:        "project",
		Page:        docsIacPage,
	},
	{
		Command:     "alethia iac",
		Key:         byoKeyEnv,
		Title:       "Environment",
		Description: "The environment, by name, stage or id; empty means the project's default",
		Flag:        "env",
		Page:        docsIacPage,
	},
	{
		Command:     "alethia drift",
		Key:         byoKeyProject,
		Title:       "Project",
		Description: "The project, by name or id; omit it on a terminal and you are asked",
		Flag:        "project",
		Page:        docsDriftPage,
	},
	{
		Command:     "alethia drift",
		Key:         byoKeyEnv,
		Title:       "Environment",
		Description: "The environment, by name, stage or id; empty means every environment in the project",
		Flag:        "env",
		Page:        docsDriftPage,
	},
	{
		Command:     "alethia staged",
		Key:         byoKeyProject,
		Title:       "Project",
		Description: "The project, by name or id; omit it on a terminal and you are asked",
		Flag:        "project",
		Page:        docsStagedPage,
	},
	{
		Command:     "alethia staged",
		Key:         byoKeyEnv,
		Title:       "Environment",
		Description: "The environment, by name, stage or id; empty means the project's default",
		Flag:        "env",
		Page:        docsStagedPage,
	},

	// ── chart attach ──
	{
		Command:     "alethia chart attach",
		Key:         byoKeyChartID,
		Title:       "Chart id",
		Description: "Your name for this chart; the server slugifies it and the result is the id every later command uses",
		Arg:         "[id]",
		Page:        docsChartsPage,
	},
	{
		Command:     "alethia chart attach",
		Key:         byoKeyRepo,
		Title:       "Repository",
		Description: "Where the chart lives — a git URL, or an oci:// reference to a chart registry",
		Flag:        "repo",
		Page:        docsChartsPage,
	},
	{
		Command:     "alethia chart attach",
		Key:         byoKeyChartPath,
		Title:       "Chart path",
		Description: "Where the chart sits inside a git repository; an OCI chart is named by its URL and needs none",
		Flag:        "chart-path",
		Page:        docsChartsPage,
	},
	{
		Command:     "alethia chart attach",
		Key:         byoKeyRef,
		Title:       "Git ref",
		Description: "The branch, tag or commit to deploy; empty tracks the repository's default branch",
		Flag:        "ref",
		Page:        docsChartsPage,
	},
	{
		Command:     "alethia chart attach",
		Key:         byoKeyNamespace,
		Title:       "Namespace",
		Description: "The destination namespace; empty lets the environment place it",
		Flag:        "namespace",
		Page:        docsChartsPage,
	},
	{
		Command:     "alethia chart attach",
		Key:         byoKeyValuesFile,
		Title:       "Values file",
		Description: "A path on this machine to a raw Helm values YAML override, sent as the file's content",
		Flag:        "values-file",
		Page:        docsChartsPage,
	},
	{
		Command:     "alethia chart attach",
		Key:         byoKeySet,
		Title:       "Chart value",
		Description: "One key=value chart value, repeatable, JSON-typed when the value parses as JSON",
		Flag:        "set",
		Page:        docsChartsPage,
	},

	// ── chart detach / scan ──
	{
		Command:     "alethia chart detach",
		Key:         byoKeyChartID,
		Title:       "Chart",
		Description: "Which attached chart to detach; its workloads leave the cluster on the next sync",
		Arg:         "[id]",
		Page:        docsChartsPage,
	},
	{
		Command:     "alethia chart scan",
		Key:         byoKeyChartID,
		Title:       "Chart",
		Description: "Which attached chart to scan; an unscanned chart is refused at deploy",
		Arg:         "[id]",
		Page:        docsChartsPage,
	},

	// ── iac attach ──
	{
		Command:     "alethia iac attach",
		Key:         byoKeyRepo,
		Title:       "Repository",
		Description: "The git repository holding your Terraform/OpenTofu",
		Flag:        "repo",
		Page:        docsIacPage,
	},
	{
		Command:     "alethia iac attach",
		Key:         byoKeyPath,
		Title:       "Module path",
		Description: "Where the module sits inside the repository; empty is the repository root",
		Flag:        "path",
		Page:        docsIacPage,
	},
	{
		Command:     "alethia iac attach",
		Key:         byoKeyRef,
		Title:       "Git ref",
		Description: "The branch, tag or commit to apply; empty tracks the repository's default branch",
		Flag:        "ref",
		Page:        docsIacPage,
	},
	{
		Command:     "alethia iac attach",
		Key:         byoKeyVar,
		Title:       "Variable",
		Description: "One scalar tfvar key=value, repeatable, and never a place for a secret",
		Flag:        "var",
		Page:        docsIacPage,
	},

	// ── repo list ──
	{
		Command:     "alethia repo list",
		Key:         byoKeyProvider,
		Title:       "Provider",
		Description: "Which connected git provider to browse",
		Flag:        "provider",
		Page:        docsReposPage,
	},
}

// mustByoField returns the spec for one field.
//
// It panics on a miss, and that is the right failure: both arguments are constants in this package,
// so a miss is a programming error, and the alternative — a zero byoField — is a form that opens
// with an empty title and asks the user for something unnamed. The behavioural tests drive every
// prompt, so an unresolvable key cannot ship.
func mustByoField(command, key string) byoField {
	for _, f := range byoFields {
		if f.Command == command && f.Key == key {
			return f
		}
	}
	panic(fmt.Sprintf("no byoField %q on %q — see byoFields in byo_fields.go", key, command))
}

// byoFlagUsage is a flag's help text, taken from the field spec.
//
// This is the FOURTH rendering, wired rather than copied. A flag's usage string and a form's helper
// line describe the same value to the same person; typed twice they drift, and the drift is
// invisible because neither is compiled. hyg_cli_byoform_test.go asserts every flag in this group
// carries exactly its field's Description, so a reworded spec reaches `--help` in the same commit.
func byoFlagUsage(command, key string) string {
	return mustByoField(command, key).Description
}

// byoGroupRoots are the top-level commands this noun group owns. Used to derive the group's leaves
// from the live command tree, so a new subcommand joins the guards without anyone remembering to
// add it.
var byoGroupRoots = []string{"chart", "iac", "repo", "drift", "staged"}

// byoGroupCommands returns every RUNNABLE command under byoGroupRoots.
//
// Derived from the tree rather than listed, for the reason hyg_cli_confirm_test.go records at
// length: a hand-written list of what a guard watches stops covering silently.
func byoGroupCommands(root *cobra.Command) []*cobra.Command {
	inGroup := map[string]bool{}
	for _, r := range byoGroupRoots {
		inGroup[r] = true
	}
	var out []*cobra.Command
	for _, top := range root.Commands() {
		if !inGroup[top.Name()] {
			continue
		}
		var walk func(c *cobra.Command)
		walk = func(c *cobra.Command) {
			if c.Run != nil || c.RunE != nil {
				out = append(out, c)
			}
			for _, child := range c.Commands() {
				walk(child)
			}
		}
		walk(top)
	}
	return out
}

// byoGroupOf returns the group path a command path belongs to — "alethia chart attach" →
// "alethia chart" — so a leaf can be credited with the selectors its group registers.
func byoGroupOf(commandPath string) string {
	fields := strings.Fields(commandPath)
	if len(fields) < 2 {
		return commandPath
	}
	return fields[0] + " " + fields[1]
}
