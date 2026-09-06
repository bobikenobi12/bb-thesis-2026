// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var rolesCmd = &cobra.Command{
	Use:     "roles",
	Aliases: []string{"role"},
	Short:   "Manage RBAC roles",
	Long: `Roles are permission bundles. The four built-in templates (owner, admin,
operator, viewer) are read-only; custom roles are org-scoped and editable. List,
create, and delete the active organization's roles. Custom roles require an
Enterprise license.`,
}

var rolesListCmd = &cobra.Command{
	Use:   "list",
	Short: "List roles (built-in templates + custom roles)",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var roles []api.Role
			runSpinner("Fetching roles...", func() { roles, err = client.ListRoles() })
			if err != nil {
				failf("Failed to list roles: %v", err)
			}
			if len(roles) == 0 {
				ui.Muted("No roles found.")
				return
			}
			_ = ui.ShowTable(roleListColumns, roleRows(roles, ui.FormatTable), "roles")
			return
		}
		if err := runRolesList(client, os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list roles: %v", err)
		}
	},
}

var roleListColumns = []string{"Name", "Built-in", "Permissions", "ID"}

// roleRows projects roles into plain table rows; built-ins are flagged with the
// brand marker and permissions render as a count.
func roleRows(roles []api.Role, outFmt string) [][]string {
	rows := make([][]string, len(roles))
	for i, r := range roles {
		rows[i] = []string{r.Name, ui.Cell(outFmt, ui.WireBool(r.IsBuiltin), ui.YesNo(r.IsBuiltin)), strconv.Itoa(len(r.PermissionKeys)), r.ID}
	}
	return rows
}

// runRolesList fetches and renders the roles (non-interactive path).
func runRolesList(c apiClient, out io.Writer, format string) error {
	roles, err := c.ListRoles()
	if err != nil {
		return err
	}
	if len(roles) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No roles found."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: roleListColumns,
		Rows:    roleRows(roles, format),
	}, roles)
}

var rolePermissions []string

var rolesCreateCmd = &cobra.Command{
	Use:   "create [name]",
	Short: "Create a custom role",
	Long: `Create a custom role with a set of permissions. Repeat --permission for
multiple keys (each is a resource:action key, e.g. project:deploy); with no --permission
on a terminal, the keys are offered as a list from the control plane's own catalog.
Authoring custom roles requires an Enterprise license.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		name := ""
		if len(args) > 0 {
			name = args[0]
		}
		if name == "" {
			name, err = promptName("alethia roles create", orgFieldKeyName)
			if err != nil {
				fail(err)
			}
		}
		permissions := rolePermissions
		// A role with no permissions is one the server accepts (`permission_keys` defaults to []),
		// so a scripted caller who omits --permission is not refused. On a terminal it is asked,
		// because a role that grants nothing is almost never what someone meant to create.
		if len(permissions) == 0 && canPromptForm() {
			permissions, err = promptRolePermissions(client, nil)
			if err != nil {
				fail(err)
			}
		}
		if err := runRolesCreate(client, os.Stdout, name, permissions); err != nil {
			failf("Failed to create role: %v", err)
		}
	},
}

// runRolesCreate creates a custom role and confirms it.
func runRolesCreate(c apiClient, out io.Writer, name string, permissionKeys []string) error {
	role, err := c.CreateRole(name, permissionKeys)
	if err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Created role %s (%s) with %d permission(s)", role.Name, role.ID, len(role.PermissionKeys))))
	return nil
}

// rolesDeleteYes is the --yes opt-in: skip the confirmation prompt (and make the
// command usable with --no-input).
var rolesDeleteYes bool

// rolesDeleteName is the --name selector: name the custom role to delete instead of copying a role
// id out of `roles list`.
var rolesDeleteName string

var rolesDeleteCmd = &cobra.Command{
	Use:   "delete [role_id]",
	Short: "Delete a custom role",
	Long: `Delete a custom role. Pass the role id, or --name to name it; with neither, pick from the
org's custom roles. The four built-in templates cannot be deleted, so they are not offered and
naming one is refused — the control plane's DELETE filters them out and answers ok, so asking for
one used to report success having changed nothing.`,
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
		ref, err := resolveOrgChoice(deletableRolePickSpec, id, rolesDeleteName, deletableRoleChoices(client))
		if err != nil {
			fail(err)
		}
		announceResolvedChoice(ref.Summary, "Deleting")
		if !confirmDestructive(rolesDeleteYes, "Delete this role?", "Grants referencing it are removed too. Built-in roles cannot be deleted. This cannot be undone.") {
			return
		}
		if err := runRolesDelete(client, os.Stdout, ref.ID); err != nil {
			failf("Failed to delete role: %v", err)
		}
	},
}

// runRolesDelete deletes a custom role and confirms it.
func runRolesDelete(c apiClient, out io.Writer, id string) error {
	if err := c.DeleteRole(id); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess("Role deleted"))
	return nil
}

func init() {
	addYesFlag(rolesDeleteCmd, &rolesDeleteYes)
	rolesCreateCmd.Flags().StringArrayVar(&rolePermissions, "permission", nil, "Permission key to grant (repeatable, e.g. project:deploy)")
	rolesDeleteCmd.Flags().StringVar(&rolesDeleteName, "name", "",
		"Delete the custom role with this name, instead of naming a role id")
	rolesCmd.AddCommand(rolesListCmd)
	rolesCmd.AddCommand(rolesCreateCmd)
	rolesCmd.AddCommand(rolesDeleteCmd)
	rootCmd.AddCommand(rolesCmd)
}
