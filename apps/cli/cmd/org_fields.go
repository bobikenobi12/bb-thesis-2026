// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

// The field spec for the org noun group — org, members, teams, roles, grants, sso, whoami.
//
// A CLI command that takes a value renders that value four times: as a flag or a positional, as a
// question in an interactive form, as the thing an error message tells you to pass, and as a row in
// the docs. Nothing made those four agree, and in this group they had already come apart in a way a
// reader could feel:
//
//   - `members remove`, `teams delete`, `roles delete`, `grants remove` and `sso get` each took an
//     opaque id as a REQUIRED positional. The only way to get one was to run the group's `list`
//     first and copy a uuid across by eye — the copied handoff this programme exists to remove.
//   - `alethia roles delete owner` printed "Role deleted" and deleted nothing: the server's DELETE
//     filters on `is_builtin = false`, so naming a built-in is a silent no-op that answers ok.
//   - the docs page for roles/grants/sso said every command takes `--org` while only `members`
//     and `teams` registered it. Closed by #3817: the ROOT registers it now and every command
//     inherits it, so the pages were right and the tree was wrong.
//
// This is the one place those fields are described. The forms and the refusal messages READ their
// wording from here rather than repeating it, so the form and the spec cannot disagree by
// construction; hyg_cli_orgform_test.go checks the other renderings — that the flag or positional
// named here exists on the real cobra command, and that the docs page named here carries the same
// rows in the same order.
//
// It is deliberately local, the way auth_fields.go is. The general field-spec kit is #3661's; this
// is one noun group's fields, described once.
type orgField struct {
	// Command is the cobra command path the field belongs to, e.g. "alethia teams delete". It is
	// what the guard resolves against the real tree.
	Command string
	// Key identifies the field inside its command. Never shown; it is how the form asks for its
	// own spec.
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
	// Arg is the positional placeholder as it appears in the command's Use string.
	Arg string
	// Selector is the flag that names this value by something a person can READ — an email, a
	// name, a domain — for the fields whose positional is an opaque id. Empty when the field has
	// no such flag, which is every field that is not an id.
	//
	// It is part of the spec rather than a detail of the resolver because it is the answer to
	// "how do I run this without a terminal and without having copied an id": the refusal a
	// scripted caller gets NAMES this flag, and the docs table carries it in its own column.
	Selector string
	// Page is the docs file, relative to the repository root, whose fieldspec table carries this
	// row.
	Page string
}

// Field keys. Constants rather than literals so a typo is a compile error and a rename reaches the
// form and the spec together.
const (
	orgFieldKeyOrg           = "org"
	orgFieldKeyEmail         = "email"
	orgFieldKeyRole          = "role"
	orgFieldKeyMember        = "member"
	orgFieldKeyName          = "name"
	orgFieldKeyTeam          = "team"
	orgFieldKeyPermissions   = "permissions"
	orgFieldKeyPrincipalType = "principal-type"
	orgFieldKeyPrincipal     = "principal"
	orgFieldKeyEffect        = "effect"
	orgFieldKeyBoundRole     = "bound-role"
	orgFieldKeyPermission    = "permission"
	orgFieldKeyResourceType  = "resource-type"
	orgFieldKeyResource      = "resource"
	orgFieldKeyGrant         = "grant"
	orgFieldKeyProvider      = "provider"
)

// Docs pages, relative to the repository root.
const (
	docsOrganizationsPage = "apps/docs/content/docs/cli/commands/organizations.mdx"
	docsAccessPage        = "apps/docs/content/docs/cli/commands/access.mdx"
)

// orgFields is the spec. One entry per value a command in this group takes from a person.
//
// Order inside a command is the order of its docs table, of its form, and of `--help`.
var orgFields = []orgField{
	{
		Command:     "alethia org switch",
		Key:         orgFieldKeyOrg,
		Title:       "Organization",
		Description: "The organization to make active; its id, slug, or name",
		Arg:         "[org]",
		Page:        docsOrganizationsPage,
	},
	{
		Command:     "alethia members add",
		Key:         orgFieldKeyEmail,
		Title:       "Email",
		Description: "Who to invite; they get an invitation at this address",
		Arg:         "[email]",
		Page:        docsOrganizationsPage,
	},
	{
		Command:     "alethia members add",
		Key:         orgFieldKeyRole,
		Title:       "Role",
		Description: "What the invited member may do, from the org's roles",
		Flag:        "role",
		Page:        docsOrganizationsPage,
	},
	{
		Command:     "alethia members remove",
		Key:         orgFieldKeyMember,
		Title:       "Member",
		Description: "Who to remove; name them by email rather than copying a member id",
		Arg:         "[member_id]",
		Selector:    "email",
		Page:        docsOrganizationsPage,
	},
	{
		Command:     "alethia teams create",
		Key:         orgFieldKeyName,
		Title:       "Name",
		Description: "What the team is called, so a list of teams is a list of purposes",
		Arg:         "[name]",
		Page:        docsOrganizationsPage,
	},
	{
		Command:     "alethia teams delete",
		Key:         orgFieldKeyTeam,
		Title:       "Team",
		Description: "Which team to delete; name it rather than copying a team id",
		Arg:         "[team_id]",
		Selector:    "name",
		Page:        docsOrganizationsPage,
	},
	{
		Command:     "alethia roles create",
		Key:         orgFieldKeyName,
		Title:       "Name",
		Description: "What the custom role is called",
		Arg:         "[name]",
		Page:        docsAccessPage,
	},
	{
		Command:     "alethia roles create",
		Key:         orgFieldKeyPermissions,
		Title:       "Permissions",
		Description: "The resource:action keys the role carries, offered from the server's own catalog",
		Flag:        "permission",
		Page:        docsAccessPage,
	},
	{
		Command:     "alethia roles delete",
		Key:         orgFieldKeyRole,
		Title:       "Role",
		Description: "Which custom role to delete; built-in templates cannot be deleted",
		Arg:         "[role_id]",
		Selector:    "name",
		Page:        docsAccessPage,
	},
	{
		Command:     "alethia grants add",
		Key:         orgFieldKeyPrincipalType,
		Title:       "Principal kind",
		Description: "Whether the grant binds a user or a team",
		Flag:        "principal-type",
		Page:        docsAccessPage,
	},
	{
		Command:     "alethia grants add",
		Key:         orgFieldKeyPrincipal,
		Title:       "Principal",
		Description: "Who the grant is for — an email, a team name, or the id itself",
		Flag:        "principal",
		Page:        docsAccessPage,
	},
	{
		Command:     "alethia grants add",
		Key:         orgFieldKeyEffect,
		Title:       "Effect",
		Description: "Whether this grant allows or explicitly denies; a deny always wins",
		Flag:        "effect",
		Page:        docsAccessPage,
	},
	{
		Command:     "alethia grants add",
		Key:         orgFieldKeyBoundRole,
		Title:       "Role",
		Description: "The role to bind, by name or id (give this or a permission, never both)",
		Flag:        "role",
		Page:        docsAccessPage,
	},
	{
		Command:     "alethia grants add",
		Key:         orgFieldKeyPermission,
		Title:       "Permission",
		Description: "The single resource:action key to bind (give this or a role, never both)",
		Flag:        "permission",
		Page:        docsAccessPage,
	},
	{
		Command:     "alethia grants add",
		Key:         orgFieldKeyResourceType,
		Title:       "Resource kind",
		Description: "What kind of thing the grant is scoped to; org means org-wide",
		Flag:        "resource-type",
		Page:        docsAccessPage,
	},
	{
		Command:     "alethia grants add",
		Key:         orgFieldKeyResource,
		Title:       "Resource",
		Description: "The id of the one resource to scope to; leave empty for org-wide",
		Flag:        "resource",
		Page:        docsAccessPage,
	},
	{
		Command:     "alethia grants remove",
		Key:         orgFieldKeyGrant,
		Title:       "Grant",
		Description: "Which grant to revoke; pick it from the org's grants rather than copying an id",
		Arg:         "[grant_id]",
		Page:        docsAccessPage,
	},
	{
		Command:     "alethia sso get",
		Key:         orgFieldKeyProvider,
		Title:       "Provider",
		Description: "Which configured provider to show; name it by its email domain",
		Arg:         "[id]",
		Selector:    "domain",
		Page:        docsAccessPage,
	},
}

// mustOrgField returns the spec for one field.
//
// It panics on a miss, and that is the right failure: both arguments are constants in this package,
// so a miss is a programming error, and the alternative — a zero orgField — is a form that opens
// with an empty title and asks the user for something unnamed. The behavioural tests drive every
// prompt, so an unresolvable key cannot ship.
func mustOrgField(command, key string) orgField {
	for _, f := range orgFields {
		if f.Command == command && f.Key == key {
			return f
		}
	}
	panic(fmt.Sprintf("no orgField %q on %q — see orgFields in org_fields.go", key, command))
}

// orgGroupRoots are the top-level commands this noun group owns. Used to derive the group's
// commands from the live tree, so a new subcommand joins the guards without anyone remembering to
// add it.
var orgGroupRoots = []string{"org", "members", "teams", "roles", "grants", "sso", "whoami"}

// orgGroupCommands returns every RUNNABLE command under orgGroupRoots. Derived from the tree rather
// than listed, for the reason hyg_cli_confirm_test.go records at length: a hand-written list of
// what a guard watches stops covering silently.
//
// "Runnable", not "leaf", for the same reason authGroupCommands gives: a group command with a Run
// of its own would sit outside every guard below. `whoami` is a runnable ROOT here, which a
// children-only walk would miss entirely.
func orgGroupCommands(root *cobra.Command) []*cobra.Command {
	inGroup := map[string]bool{}
	for _, r := range orgGroupRoots {
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
