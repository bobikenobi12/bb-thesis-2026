// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
	"github.com/spf13/cobra"
)

// The field spec for the auth group — login, logout, token, init, config.
//
// A CLI command that takes a value renders that value FOUR times: as a flag or a
// positional, as a question in an interactive form, as a key somewhere on disk,
// and as a row in the docs. Nothing made those four agree. They were four
// hand-written lists, and they had already drifted: `alethia init` asked for a
// control-plane URL that no flag could supply, so `init --no-input` could not do
// the one thing init exists for; `token create` refused an empty --name with no
// way to be asked for one; `token revoke` took an opaque id a reader could only
// get by copying it out of `token list` by eye.
//
// This is the one place those fields are described. The forms READ their titles
// and descriptions from here rather than repeating them, so the form and the
// spec cannot disagree by construction; hyg_cli_authform_test.go checks the
// other two renderings — that the flag or positional named here exists on the
// command, and that the docs page named here carries the same rows.
//
// It is deliberately small and deliberately local. The general field-spec kit is
// #3661's; this is the auth group's five fields, described once.
// authField is spec.Field. The struct that used to be declared here was field-for-field identical
// to the ones in byo_fields.go, governance_fields.go, ops_fields.go and org_fields.go — five copies
// of one idea, each carrying a comment naming #3661 as where they converge. This is that
// convergence; an ALIAS rather than a new type so every literal below and every call site elsewhere
// reads unchanged.
//
// What the columns mean is documented once, on spec.Field.
type authField = spec.Field

// Field keys. Constants rather than literals so a typo is a compile error and a
// rename reaches the form and the spec together.
const (
	fieldKeyName      = "name"
	fieldKeyExpires   = "expires"
	fieldKeyWebOrigin = "web-origin"
	fieldKeyConfigKey = "key"
	fieldKeyValue     = "value"
	fieldKeyTokenID   = "id"
)

// Docs pages, relative to the repository root.
const (
	docsAuthenticationPage = "apps/docs/content/docs/cli/authentication.mdx"
	docsConfigurationPage  = "apps/docs/content/docs/cli/configuration.mdx"
	docsInitPage           = "apps/docs/content/docs/cli/commands/init.mdx"
)

// authFields is the spec. One entry per value a command in this group takes from
// a person.
//
// `alethia login`, `alethia logout`, `alethia token list`, `alethia config` and
// `alethia config clear-context` have no entry because they take no value — a
// deliberate absence, recorded in authFormLeafTakesInput so it cannot be an oversight.
var authFields = []authField{
	{
		Command:     "alethia init",
		Key:         fieldKeyWebOrigin,
		Title:       "Control-plane URL",
		Description: "Use the hosted default, or your self-hosted or dev URL",
		Flag:        "web-origin",
		Page:        docsInitPage,
	},
	{
		Command:     "alethia token create",
		Key:         fieldKeyName,
		Title:       "Name",
		Description: "What this token is for, so a list of tokens is a list of purposes",
		Flag:        "name",
		Page:        docsAuthenticationPage,
	},
	{
		Command:     "alethia token create",
		Key:         fieldKeyExpires,
		Title:       "Expires",
		Description: "A token that never expires is a credential nobody remembers to rotate",
		Flag:        "expires-in-days",
		Page:        docsAuthenticationPage,
	},
	{
		Command:     "alethia token revoke",
		Key:         fieldKeyTokenID,
		Title:       "Token",
		Description: "The token to revoke; it stops working on its very next request",
		Arg:         "[id]",
		Page:        docsAuthenticationPage,
	},
	{
		Command:     "alethia config set",
		Key:         fieldKeyConfigKey,
		Title:       "Config key",
		Description: "Which value to change",
		Arg:         "[key]",
		Page:        docsConfigurationPage,
	},
	{
		Command:     "alethia config set",
		Key:         fieldKeyValue,
		Title:       "Value",
		Description: "The new value; the form describes it with the chosen key's own summary",
		Arg:         "[value]",
		Page:        docsConfigurationPage,
	},
}

// mustAuthField returns the spec for one field.
//
// It panics on a miss, and that is the right failure: both arguments are
// constants in this package, so a miss is a programming error, and the
// alternative — a zero authField — is a form that opens with an empty title and
// an empty description and asks the user for something unnamed. The behavioural
// tests drive every prompt, so an unresolvable key cannot ship.
func mustAuthField(command, key string) authField {
	return authGroup().Must(command, key)
}

// authGroup wraps this group's table in the shared kit, so the lookup, the flag registration and
// the docs rendering are the ones every other group uses rather than five copies of each.
func authGroup() spec.Group {
	return spec.Group{Name: "auth", Source: "auth_fields.go", Fields: authFields}
}

// authGroupRoots are the top-level commands this noun group owns. Used to derive
// the group's leaves from the live command tree, so a new subcommand joins the
// guards without anyone remembering to add it.
var authGroupRoots = []string{"login", "logout", "token", "init", "config"}

// authGroupCommands returns every RUNNABLE command under authGroupRoots. Derived
// from the tree rather than listed, for the reason hyg_cli_confirm_test.go
// records at length: a hand-written list of what a guard watches stops covering
// silently.
//
// "Runnable", not "leaf". `alethia config` has subcommands AND a Run of its own —
// it shows the resolved configuration — so a leaf-only walk misses it, and the
// one command in this group a first-time user is most likely to type would sit
// outside every guard below. The confirm guard's walkLeaves can be leaf-only
// because a runnable parent is never destructive; that reasoning does not carry.
func authGroupCommands(root *cobra.Command) []*cobra.Command {
	inGroup := map[string]bool{}
	for _, r := range authGroupRoots {
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
