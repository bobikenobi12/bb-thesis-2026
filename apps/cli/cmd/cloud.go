// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var cloudCmd = &cobra.Command{
	Use:   "cloud",
	Short: "Inspect discovered cloud resources",
	Long: `Alethia inventories the networking (VPCs/VNets, subnets) and regions it discovers in a
connected cloud account. Show that inventory for a cloud identity.`,
}

var cloudInventoryCmd = &cobra.Command{
	Use:   "inventory [provider|cloud-identity-id]",
	Short: "Show the discovered networking + regions for a connected cloud account",
	Long: `Show the networking (VPCs/VNets, subnets) and regions Alethia discovered in a
connected cloud account.

Name the account by its PROVIDER — ` + "`alethia cloud inventory aws`" + ` — or omit the
argument entirely for a picker. The opaque cloud-identity id is still accepted, so an id a
script already holds keeps working, but nothing makes you copy one out of another command's
output any more.`,
	Args: cobra.MaximumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)

		ref := ""
		if len(args) == 1 {
			ref = args[0]
		}
		identityID, err := resolveCloudIdentityRef(client, ref)
		if err != nil {
			fail(err)
		}

		if err := runCloudInventory(client, os.Stdout, outputFormat(cmd), identityID); err != nil {
			failf("Failed to get cloud inventory: %v", err)
		}
	},
}

var networkColumns = []string{"Network", "Name", "Region", "CIDR", "Default"}
var subnetColumns = []string{"Subnet", "Name", "Region", "AZ", "CIDR", "Public"}

// networkRows projects discovered networks into plain table cells.
func networkRows(networks []api.CloudNetwork, outFmt string) [][]string {
	rows := make([][]string, len(networks))
	for i, n := range networks {
		rows[i] = []string{n.NativeID, ui.Cell(outFmt, ui.Wire(n.Name), ui.StrOrDash(n.Name)), ui.Cell(outFmt, ui.Wire(n.Region), ui.StrOrDash(n.Region)), ui.Cell(outFmt, ui.Wire(n.CidrBlock), ui.StrOrDash(n.CidrBlock)), ui.Cell(outFmt, ui.WireBool(n.IsDefault), ui.GateGlyph(n.IsDefault))}
	}
	return rows
}

// subnetRows projects discovered subnets into plain table cells.
func subnetRows(subnets []api.CloudSubnet, outFmt string) [][]string {
	rows := make([][]string, len(subnets))
	for i, s := range subnets {
		rows[i] = []string{s.NativeID, ui.Cell(outFmt, ui.Wire(s.Name), ui.StrOrDash(s.Name)), ui.Cell(outFmt, ui.Wire(s.Region), ui.StrOrDash(s.Region)), ui.Cell(outFmt, ui.Wire(s.AvailabilityZone), ui.StrOrDash(s.AvailabilityZone)), ui.Cell(outFmt, ui.Wire(s.CidrBlock), ui.StrOrDash(s.CidrBlock)), ui.Cell(outFmt, ui.WireBool(s.IsPublic), ui.GateGlyph(s.IsPublic))}
	}
	return rows
}

// runCloudInventory fetches and renders a cloud identity's discovered inventory. json emits the
// whole object; table renders the networks + subnets tables and a regions line; csv emits the
// networks rows (the primary set).
func runCloudInventory(c apiClient, out io.Writer, format, cloudIdentityID string) error {
	inv, err := c.GetCloudInventory(cloudIdentityID)
	if err != nil {
		return err
	}
	if format == ui.FormatJSON {
		return ui.Render(out, format, ui.TableSpec{}, inv)
	}
	if len(inv.Networks) == 0 && len(inv.Subnets) == 0 && len(inv.Regions) == 0 {
		fmt.Fprintln(out, ui.MutedStyle.Render("No cloud inventory discovered yet."))
		return nil
	}
	if format == ui.FormatCSV {
		return ui.Render(out, format, ui.TableSpec{Columns: networkColumns, Rows: networkRows(inv.Networks, format)}, inv.Networks)
	}
	// Table: networks, then subnets, then a regions line.
	fmt.Fprintln(out, ui.MutedStyle.Render("Networks"))
	_ = ui.Render(out, format, ui.TableSpec{Columns: networkColumns, Rows: networkRows(inv.Networks, format)}, inv.Networks)
	fmt.Fprintln(out)
	fmt.Fprintln(out, ui.MutedStyle.Render("Subnets"))
	_ = ui.Render(out, format, ui.TableSpec{Columns: subnetColumns, Rows: subnetRows(inv.Subnets, format)}, inv.Subnets)
	if len(inv.Regions) > 0 {
		fmt.Fprintln(out)
		fmt.Fprintln(out, "Regions: "+strings.Join(inv.Regions, ", "))
	}
	return nil
}

func init() {
	cloudCmd.AddCommand(cloudInventoryCmd)
	rootCmd.AddCommand(cloudCmd)
}
