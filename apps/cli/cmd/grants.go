// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var grantsCmd = &cobra.Command{
	Use:     "grants",
	Aliases: []string{"grant", "access"},
	Short:   "Manage access grants",
	Long: `A grant binds a principal (a user or a team) to a role OR a single permission
on a resource, as an allow or an explicit deny (deny wins). Omit a resource for an
org-wide grant. List, add, and remove the active organization's grants. Managing
access requires an Enterprise license.`,
}

var grantsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List access grants",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var grants []api.Grant
			runSpinner("Fetching grants...", func() { grants, err = client.ListGrants() })
			if err != nil {
				failf("Failed to list grants: %v", err)
			}
			if len(grants) == 0 {
				ui.Muted("No access grants found.")
				return
			}
			_ = ui.ShowTable(grantListColumns, grantRows(grants, ui.FormatTable), "grants")
			return
		}
		if err := runGrantsList(client, os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list grants: %v", err)
		}
	},
}

var grantListColumns = []string{"Principal", "Effect", "Role", "Permission", "Resource", "ID"}

// grantScope renders a grant's resource scope: "type (id)" when scoped, else "type".
func grantScope(g api.Grant) string {
	if g.ResourceID != "" {
		return fmt.Sprintf("%s (%s)", g.ResourceType, g.ResourceID)
	}
	return g.ResourceType
}

// grantRows projects grants into plain table rows. The principal is rendered as
// "type id"; role and permission fall back to a dash (a grant carries exactly one).
func grantRows(grants []api.Grant, outFmt string) [][]string {
	rows := make([][]string, len(grants))
	for i, g := range grants {
		rows[i] = []string{
			fmt.Sprintf("%s %s", g.PrincipalType, g.PrincipalID),
			g.Effect,
			ui.Cell(outFmt, g.Role, ui.OrDash(g.Role)),
			ui.Cell(outFmt, g.PermissionKey, ui.OrDash(g.PermissionKey)),
			grantScope(g),
			g.ID,
		}
	}
	return rows
}

// runGrantsList fetches and renders the access grants (non-interactive path).
func runGrantsList(c apiClient, out io.Writer, format string) error {
	grants, err := c.ListGrants()
	if err != nil {
		return err
	}
	if len(grants) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No access grants found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: grantListColumns,
		Rows:    grantRows(grants, format),
	}, grants)
}

var (
	grantPrincipalType string
	grantPrincipalID   string
	grantEffect        string
	grantRoleID        string
	grantPermission    string
	grantResourceType  string
	grantResourceID    string
)

var grantsAddCmd = &cobra.Command{
	Use:   "add",
	Short: "Assign an access grant",
	Long: `Assign an access grant. Bind a principal to EXACTLY one of a role (--role) or
a single permission (--permission), with an allow or deny effect. Omit --resource for
an org-wide grant. Requires an Enterprise license.

--principal takes an email (or a team name) as readily as an id, and --role takes a role
name; both are looked up against the active org. With no --principal on a terminal, the
whole grant is asked for.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		// Resolved but NOT required. A grant whose principal and role are already ids needs no
		// member list, so an org that cannot be resolved must not fail a command that never asks
		// for one; the error is carried and reported only by a lookup that actually needs it.
		orgID, orgErr := currentOrgID()

		answers := grantsAddAnswers{
			PrincipalType: grantPrincipalType,
			Principal:     grantPrincipalID,
			Effect:        grantEffect,
			RoleID:        grantRoleID,
			Permission:    grantPermission,
			ResourceType:  grantResourceType,
			ResourceID:    grantResourceID,
		}
		if answers.Principal == "" {
			if orgErr != nil {
				fail(orgErr)
			}
			answers, err = promptGrantsAdd(client, orgID, answers)
			if err != nil {
				fail(err)
			}
		}

		// The closed sets are checked AFTER the form, not instead of it: the form can only write
		// back a value it was given, so this arm exists for the flags — and checking both through
		// one gate is what keeps the two paths from diverging.
		principalType, err := canonicalOneOf("principal-type", answers.PrincipalType, grantPrincipalTypes)
		if err != nil {
			fail(err)
		}
		effect, err := canonicalOneOf("effect", answers.Effect, grantEffects)
		if err != nil {
			fail(err)
		}
		if (answers.RoleID == "") == (answers.Permission == "") {
			failf("Provide exactly one of --role or --permission")
		}

		principals := func() ([]orgChoice, error) {
			if orgErr != nil {
				return nil, orgErr
			}
			return grantPrincipalChoices(client, orgID, answers.PrincipalType)()
		}
		principal, err := resolveByNameOrID(grantPrincipalPickSpec, answers.Principal, principals)
		if err != nil {
			fail(err)
		}
		boundRole, err := resolveByNameOrID(grantRolePickSpec, answers.RoleID, bindableRoleChoices(client))
		if err != nil {
			fail(err)
		}

		params := api.AddGrantParams{
			PrincipalType: principalType,
			PrincipalID:   principal.ID,
			Effect:        effect,
			RoleID:        boundRole.ID,
			PermissionKey: answers.Permission,
			ResourceType:  answers.ResourceType,
			ResourceID:    answers.ResourceID,
		}
		if err := runGrantsAdd(client, os.Stdout, params); err != nil {
			failf("Failed to add grant: %v", err)
		}
	},
}

// runGrantsAdd assigns a grant and confirms it.
func runGrantsAdd(c apiClient, out io.Writer, params api.AddGrantParams) error {
	grant, err := c.AddGrant(params)
	if err != nil {
		return err
	}
	bound := grant.PermissionKey
	if bound == "" {
		bound = grant.Role
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Granted %s %s on %s (%s)", grant.Effect, bound, grantScope(*grant), grant.ID)))
	return nil
}

// grantsRemoveYes is the --yes opt-in: skip the confirmation prompt (and make the
// command usable with --no-input).
var grantsRemoveYes bool

var grantsRemoveCmd = &cobra.Command{
	Use:   "remove [grant_id]",
	Short: "Revoke an access grant",
	Long: `Revoke an access grant. Pass the grant id, or pick one from the org's grants. A grant has
no name — it IS the binding — so the picker is the only way to name one without its id.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		id := ""
		if len(args) > 0 {
			id = args[0]
		}
		ref, err := resolveOrgChoice(grantPickSpec, id, "", grantChoices(client))
		if err != nil {
			fail(err)
		}
		announceResolvedChoice(ref.Summary, "Revoking")
		if !confirmDestructive(grantsRemoveYes, "Revoke this grant?", "The principal loses this access. This cannot be undone.") {
			return
		}
		if err := runGrantsRemove(client, os.Stdout, ref.ID); err != nil {
			failf("Failed to remove grant: %v", err)
		}
	},
}

// runGrantsRemove revokes a grant and confirms it.
func runGrantsRemove(c apiClient, out io.Writer, id string) error {
	if err := c.RemoveGrant(id); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Grant revoked"))
	return nil
}

func init() {
	addYesFlag(grantsRemoveCmd, &grantsRemoveYes)
	grantsAddCmd.Flags().StringVar(&grantPrincipalType, "principal-type", "user", "Principal kind (user or team)")
	grantsAddCmd.Flags().StringVar(&grantPrincipalID, "principal", "", "Principal — an email, a team name, or the id itself")
	grantsAddCmd.Flags().StringVar(&grantEffect, "effect", "allow", "Effect (allow or deny)")
	grantsAddCmd.Flags().StringVar(&grantRoleID, "role", "", "Role to bind, by name or id (XOR --permission)")
	grantsAddCmd.Flags().StringVar(&grantPermission, "permission", "", "Single permission key to bind (XOR --role)")
	grantsAddCmd.Flags().StringVar(&grantResourceType, "resource-type", "org", "Resource type to scope to (project, runner, cloud_identity, org)")
	grantsAddCmd.Flags().StringVar(&grantResourceID, "resource", "", "Resource id to scope to (omit for org-wide)")
	// --principal is deliberately NOT MarkFlagRequired any more: cobra enforces that before Run,
	// which made the interactive form unreachable — the command died before it could ask.

	grantsCmd.AddCommand(grantsListCmd)
	grantsCmd.AddCommand(grantsAddCmd)
	grantsCmd.AddCommand(grantsRemoveCmd)
	rootCmd.AddCommand(grantsCmd)
}
