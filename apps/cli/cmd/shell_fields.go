// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/spf13/cobra"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
)

// The field spec for the shell — the root command itself and the verbs hanging directly off it.
//
// A CLI value is rendered four times: as a flag or a positional, as a question in an interactive
// form, as a key somewhere on disk, and as a row in the docs. The auth group's spec
// (auth_fields.go) is the same idea for a noun group; this is the same idea for the four values
// that are not any group's, because every command in the tree inherits them.
//
// They had already drifted, in the way a global always does — nobody owns it, so nothing checks it:
//
//   - `--token` is the whole non-interactive credential story and appears in NEITHER global-flags
//     table. Both tables open with the sentence "Every command accepts TWO persistent flags", which
//     has been wrong since the flag shipped.
//   - the two tables word `--output` differently ("Output format." against "Output format.
//     `json`/`csv` print static, machine-readable output."), so a reader who finds one has no way
//     to know the other says more.
//
// The flags are REGISTERED from this spec, so the string cobra prints in `--help` and the string
// the guard looks for in the docs are the same string rather than two copies of it.
// shellField is spec.Field. The struct declared here was one of five near-identical copies across the
// noun groups, each carrying a comment naming #3661 as where they converge. This is that
// convergence; an ALIAS rather than a new type so every literal in this file and every call site
// elsewhere reads unchanged. What the columns mean is documented once, on spec.Field.
type shellField = spec.Field

// Field keys. Constants rather than literals so a typo is a compile error.
const (
	shellKeyOutput  = "output"
	shellKeyNoInput = "no-input"
	shellKeyToken   = "token"
	shellKeyOrg     = "org"
	shellKeyTarget  = "target"
)

// Docs pages, relative to the repository root.
const (
	docsCliIndexPage    = "apps/docs/content/docs/cli/index.mdx"
	docsCliConfigPage   = "apps/docs/content/docs/cli/configuration.mdx"
	docsCliIdentityPage = "apps/docs/content/docs/cli/identity.mdx"
)

// shellGlobalFlagPages are the pages carrying a global-flags table.
var shellGlobalFlagPages = []string{docsCliIndexPage, docsCliConfigPage}

// shellFields is the spec. One entry per value the shell takes from a person.
var shellFields = []shellField{
	{
		Command:   "alethia",
		Key:       shellKeyOutput,
		Flag:      "output",
		Shorthand: "o",
		Default:   "table",
		Usage:     "Output format: table, json, or csv",
		Docs:      "Output format. `json`/`csv` print static, machine-readable output, and never open an interactive table.",
		Pages:     shellGlobalFlagPages,
	},
	{
		Command: "alethia",
		Key:     shellKeyNoInput,
		Flag:    "no-input",
		Default: "off",
		Usage:   "Disable interactive prompts (fail instead of prompting)",
		Docs:    "Disable interactive prompts; fail instead of prompting. Auto-enabled when stdin is not a terminal. A form is refused separately when the stream it would draw on is redirected, so `alethia … 2> log` still renders the rich table.",
		Pages:   shellGlobalFlagPages,
	},
	{
		Command: "alethia",
		Key:     shellKeyToken,
		Flag:    "token",
		Default: "unset",
		// The backquoted word is cobra's own convention for naming a flag's argument in --help.
		Usage: "Service-account `token` for non-interactive use (or set $" + ServiceTokenEnv + "). Skips the interactive login entirely.",
		Docs:  "Service-account token for non-interactive use. Prefer the `ALETHIA_TOKEN` environment variable in CI: a flag value lands in the process table and in shell history.",
		Pages: shellGlobalFlagPages,
	},
	{
		Command: "alethia",
		Key:     shellKeyOrg,
		Flag:    "org",
		Default: "the active org",
		// The backquoted word is cobra's own convention for naming a flag's argument in --help.
		Usage: "Organization `id` to act in for this invocation (defaults to the active org)",
		Docs:  "Organization to act in for this invocation, instead of the active one. Sent as the `X-Alethia-Org` header on every request, and used as the org in the request path of `members` and `teams`. It selects a scope rather than granting one: the control plane refuses it with `403` when you are not a member of that organization. Under a service token it must name the token's OWN organization — a different one is refused with `403`, never quietly ignored, so a pipeline cannot believe it is acting on one org while every write lands in another.",
		Pages: shellGlobalFlagPages,
	},
	{
		Command: "alethia open",
		Key:     shellKeyTarget,
		Arg:     "[console|docs]",
		Default: "console",
		Docs:    "Which surface to open. Defaults to the console; the `docs` alias defaults to the documentation.",
		Pages:   []string{docsCliIdentityPage},
	},
}

// shellLeafTakesNoInput records, for each shell leaf, whether it takes a value from a person — and
// when it does not, why that is a decision rather than an omission.
//
// The programme's rule is that every leaf taking input gets an interactive path. `open` is the only
// shell leaf that takes anything, and it deliberately does NOT prompt: the value has a DEFAULT, and
// a bare `alethia open` opening the console is the right command. Adding a picker in front of it
// would make the commonest invocation slower to answer, which is the opposite of the rule's point.
//
// Recorded here rather than left implicit so the guard can tell "no field, decided" from "no field,
// forgotten" — the distinction an empty absence cannot carry.
var shellLeafTakesNoInput = map[string]string{
	"alethia version": "prints the build and checks for a newer release; there is nothing to ask",
	"alethia update":  "updates through the channel the CLI was installed from, which it detects rather than asks about",
}

// shellRoots are the top-level commands this group owns. Derived leaves come from the live tree, so
// a new shell command joins the guards without anyone remembering to add it.
var shellRoots = []string{"open", "version", "update"}

// shellCommands returns every runnable command under shellRoots, from the live tree.
func shellCommands(root *cobra.Command) []*cobra.Command {
	inGroup := map[string]bool{}
	for _, r := range shellRoots {
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

// mustShellField returns the spec for one field.
//
// It panics on a miss, and that is the right failure: both arguments are constants in this package,
// so a miss is a programming error, and the alternative — a zero shellField — registers a flag with
// an empty name.
func mustShellField(command, key string) shellField {
	return shellGroup().Must(command, key)
}

// shellGroup wraps the shell group's table in the shared kit, so the lookup, the flag
// registration and the docs rendering are the ones every other group uses rather than five copies
// of each.
func shellGroup() spec.Group {
	return spec.Group{Name: "shell", Source: "shell_fields.go", Fields: shellFields}
}

// registerShellGlobalFlags registers the root's persistent flags FROM the spec.
//
// This is what makes the spec a source rather than a description. The usage string cobra prints and
// the string the docs guard looks for are the same value, so `--help` and the docs table cannot
// come to disagree by someone editing one of them.
func registerShellGlobalFlags(cmd *cobra.Command) {
	out := mustShellField("alethia", shellKeyOutput)
	cmd.PersistentFlags().StringP(out.Flag, out.Shorthand, out.Default, out.Usage)

	noInput := mustShellField("alethia", shellKeyNoInput)
	cmd.PersistentFlags().Bool(noInput.Flag, false, noInput.Usage)

	// The NON-INTERACTIVE credential. Pairs with --no-input: that one stops the CLI asking
	// questions, this one gives it an answer to the only question a pipeline cannot answer.
	token := mustShellField("alethia", shellKeyToken)
	cmd.PersistentFlags().StringVar(&serviceTokenFlag, token.Flag, "", token.Usage)

	// The TENANCY selector, beside the credential because they answer the same shape of question:
	// which identity, and whose data. Registered on the root and NOWHERE else — see org_scope.go
	// for why a second registration on `members`/`teams` would be worse than none (#3817).
	org := mustShellField("alethia", shellKeyOrg)
	cmd.PersistentFlags().StringVar(&orgFlag, org.Flag, "", org.Usage)
}
