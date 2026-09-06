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
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var classificationCmd = &cobra.Command{
	Use:     "classification",
	Aliases: []string{"class"},
	Short:   "Classify resources with the org's taxonomy",
	Long: `Classification is a governed taxonomy — named dimensions (axes) and their allowed
values — applied to resources. List the dimensions, view a resource's tags, and assign or
clear values. A resource is addressed by its kind and id (e.g. project_environment <uuid>).

The dimension key and the value slug are OPTIONAL: omit them on a terminal and you are asked,
from the org's own taxonomy rather than from a key you copied out of "dimensions".`,
}

var classificationDimensionsCmd = &cobra.Command{
	Use:   "dimensions",
	Short: "List the org's classification dimensions and values",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var dims []api.ClassificationDimension
			runSpinner("Fetching dimensions...", func() {
				dims, err = client.ListClassificationDimensions()
			})
			if err != nil {
				failf("Failed to list dimensions: %v", err)
			}
			if len(dims) == 0 {
				ui.Muted("No classification dimensions defined.")
				return
			}
			_ = ui.ShowTable(dimensionColumns, dimensionRows(dims, ui.FormatTable), "dimensions")
			return
		}
		if err := runClassificationDimensions(client, os.Stdout, outputFormat(cmd)); err != nil {
			failf("Failed to list dimensions: %v", err)
		}
	},
}

var dimensionColumns = []string{"Key", "Label", "Mode", "Applies to", "Values"}

func dimensionRows(dims []api.ClassificationDimension, outFmt string) [][]string {
	rows := make([][]string, len(dims))
	for i, d := range dims {
		mode := "single"
		if d.Multi {
			mode = "multi"
		}
		applies := "all resources"
		if len(d.AppliesTo) > 0 {
			applies = strings.Join(d.AppliesTo, ", ")
		}
		// Show the value slugs, not just a count — `classification assign` takes a
		// value-slug, so the slugs must be discoverable from this list.
		values := strings.Join(dimensionSlugs(d), ", ")
		rows[i] = []string{d.Key, d.Label, mode, applies, ui.Cell(outFmt, values, ui.OrDash(values))}
	}
	return rows
}

func runClassificationDimensions(c apiClient, out io.Writer, format string) error {
	dims, err := c.ListClassificationDimensions()
	if err != nil {
		return err
	}
	if len(dims) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("No classification dimensions defined."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: dimensionColumns,
		Rows:    dimensionRows(dims, format),
	}, dims)
}

var classificationShowCmd = &cobra.Command{
	Use:   "show <kind> <id>",
	Short: "Show the classification values assigned to a resource",
	Args:  cobra.ExactArgs(2),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		if interactiveTable(cmd) {
			var rows []api.ClassificationAssignment
			runSpinner("Fetching classifications...", func() {
				rows, err = client.GetResourceClassifications(args[0], args[1])
			})
			if err != nil {
				failf("Failed to fetch classifications: %v", err)
			}
			if len(rows) == 0 {
				ui.Muted("Not classified.")
				return
			}
			_ = ui.ShowTable(assignmentColumns, assignmentRows(rows), "classifications")
			return
		}
		if err := runClassificationShow(client, os.Stdout, outputFormat(cmd), args[0], args[1]); err != nil {
			failf("Failed to fetch classifications: %v", err)
		}
	},
}

var assignmentColumns = []string{"Dimension", "Value"}

func assignmentRows(rows []api.ClassificationAssignment) [][]string {
	out := make([][]string, len(rows))
	for i, a := range rows {
		out[i] = []string{a.DimensionLabel, a.ValueLabel}
	}
	return out
}

func runClassificationShow(c apiClient, out io.Writer, format, kind, id string) error {
	rows, err := c.GetResourceClassifications(kind, id)
	if err != nil {
		return err
	}
	if len(rows) == 0 && format == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render("Not classified."))
		return nil
	}
	return ui.Render(out, format, ui.TableSpec{
		Columns: assignmentColumns,
		Rows:    assignmentRows(rows),
	}, rows)
}

var classificationAssignCmd = &cobra.Command{
	Use:   "assign <kind> <id> [dimension-key] [value-slug]",
	Short: "Assign a classification value to a resource",
	Long: `Pin one of the org's classification values to a resource. The dimension key and the
value slug are optional: omit them on a terminal and you are asked, from the taxonomy itself.

Scripted, pass all four — the values are the ones "alethia classification dimensions" prints.`,
	Args: cobra.RangeArgs(2, 4),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		kind, id := args[0], args[1]
		dimensionKey, valueSlug, err := resolveClassification(client, kind, args[2:])
		if err != nil {
			fail(err)
		}
		if err := runClassificationAssign(client, os.Stdout, kind, id, dimensionKey, valueSlug); err != nil {
			failf("Failed to assign classification: %v", err)
		}
	},
}

// dimensionSlugs returns a dimension's value slugs, in the order the taxonomy defines them.
func dimensionSlugs(d api.ClassificationDimension) []string {
	out := make([]string, len(d.Values))
	for i, v := range d.Values {
		out[i] = v.Value
	}
	return out
}

// dimensionsFor returns the dimensions that target a resource kind: those scoping to it
// explicitly, plus those with an empty applies_to, which target every kind.
//
// Used for the OFFER only. Nothing is refused on this basis: applies_to is the console's
// authoring hint, and the CLI cannot show that the server enforces it — so filtering the picker
// keeps the question short while an explicit `--` key outside the scope still reaches the server,
// which is the only side that knows.
func dimensionsFor(dims []api.ClassificationDimension, kind string) []api.ClassificationDimension {
	var out []api.ClassificationDimension
	for _, d := range dims {
		if len(d.AppliesTo) == 0 {
			out = append(out, d)
			continue
		}
		for _, k := range d.AppliesTo {
			if strings.EqualFold(k, kind) {
				out = append(out, d)
				break
			}
		}
	}
	return out
}

// resolveClassification answers "which dimension, and which of its values?" for `assign`.
//
// It fetches the taxonomy on EVERY path, including the fully-specified one, and that is the point.
// `assign` takes a four-token contract in which two tokens are slugs from a closed org-scoped set;
// a typo in either used to reach the server and come back as a 4xx naming neither the mistake nor
// the alternatives. The taxonomy is closed and org-scoped, and the assignment is made against the
// same org, so a key outside it is one the server would certainly refuse — which is the bound on
// what the CLI may reject, and it buys a refusal that lists the real keys.
func resolveClassification(c apiClient, kind string, rest []string) (dimensionKey, valueSlug string, err error) {
	dims, err := c.ListClassificationDimensions()
	if err != nil {
		return "", "", err
	}
	if len(dims) == 0 {
		return "", "", fmt.Errorf(
			"this organization has no classification dimensions — an admin defines them in the console before anything can be labelled")
	}

	if len(rest) > 0 && strings.TrimSpace(rest[0]) != "" {
		dimensionKey = strings.TrimSpace(rest[0])
	} else {
		dimensionKey, err = pickDimension(dimensionsFor(dims, kind), kind)
		if err != nil {
			return "", "", err
		}
	}

	chosen, err := findDimension(dims, dimensionKey)
	if err != nil {
		return "", "", err
	}

	if len(rest) > 1 && strings.TrimSpace(rest[1]) != "" {
		valueSlug = strings.TrimSpace(rest[1])
		if !containsFold(dimensionSlugs(chosen), valueSlug) {
			return "", "", fmt.Errorf("%q is not a value of the %q dimension (want one of: %s)",
				valueSlug, chosen.Key, strings.Join(dimensionSlugs(chosen), ", "))
		}
		return chosen.Key, valueSlug, nil
	}
	valueSlug, err = pickDimensionValue(chosen)
	return chosen.Key, valueSlug, err
}

// findDimension resolves a dimension key against the taxonomy, naming the real keys on a miss.
func findDimension(dims []api.ClassificationDimension, key string) (api.ClassificationDimension, error) {
	keys := make([]string, len(dims))
	for i, d := range dims {
		if strings.EqualFold(d.Key, key) {
			return d, nil
		}
		keys[i] = d.Key
	}
	return api.ClassificationDimension{}, fmt.Errorf(
		"no classification dimension %q in this organization (want one of: %s)",
		key, strings.Join(keys, ", "))
}

// pickDimension asks which axis to set.
func pickDimension(dims []api.ClassificationDimension, kind string) (string, error) {
	if len(dims) == 0 {
		return "", fmt.Errorf(
			"no classification dimension targets %s — run `alethia classification dimensions` to see what each one applies to", kind)
	}
	if err := requireInteractiveForm(); err != nil {
		return "", fmt.Errorf("no dimension key given: pass one as the argument (see `alethia classification dimensions`) (%w)", err)
	}
	f := mustGovField("alethia classification assign", fieldKeyClassDimension)
	options := make([]huh.Option[int], len(dims))
	for i, d := range dims {
		mode := "single"
		if d.Multi {
			mode = "multi"
		}
		options[i] = huh.NewOption(govBullet(d.Label, d.Key, mode), i)
	}
	chosen := 0
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[int]().Title(f.Title).Description(f.Description).Options(options...).Value(&chosen),
	)); err != nil {
		return "", err
	}
	return dims[chosen].Key, nil
}

// pickDimensionValue asks which of a dimension's allowed values to pin.
func pickDimensionValue(d api.ClassificationDimension) (string, error) {
	if len(d.Values) == 0 {
		return "", fmt.Errorf("the %q dimension has no allowed values to assign", d.Key)
	}
	if err := requireInteractiveForm(); err != nil {
		return "", fmt.Errorf("no value slug given: pass one of %s as the argument (%w)",
			strings.Join(dimensionSlugs(d), ", "), err)
	}
	f := mustGovField("alethia classification assign", fieldKeyClassValue)
	options := make([]huh.Option[int], len(d.Values))
	for i, v := range d.Values {
		options[i] = huh.NewOption(govBullet(v.Label, v.Value), i)
	}
	chosen := 0
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[int]().Title(f.Title).Description(f.Description).Options(options...).Value(&chosen),
	)); err != nil {
		return "", err
	}
	return d.Values[chosen].Value, nil
}

func runClassificationAssign(c apiClient, out io.Writer, kind, id, dimensionKey, valueSlug string) error {
	if _, err := c.AssignClassification(kind, id, dimensionKey, valueSlug); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Assigned %s=%s to %s %s", dimensionKey, valueSlug, kind, id)))
	return nil
}

var classificationUnassignYes bool

var classificationUnassignCmd = &cobra.Command{
	Use:   "unassign <kind> <id> [value-slug]",
	Short: "Clear a classification value from a resource",
	Long: `Clear one classification value from a resource. The value slug is optional: omit it on
a terminal and you are asked, from the values the resource ACTUALLY carries.

Clearing is destructive, so it asks before acting; scripted, pass the slug with --yes.`,
	Args: cobra.RangeArgs(2, 3),
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		kind, id := args[0], args[1]
		valueSlug, err := resolveAssignedValue(client, kind, id, args[2:])
		if err != nil {
			fail(err)
		}
		if !confirmDestructive(
			classificationUnassignYes,
			fmt.Sprintf("Clear %s from %s %s?", valueSlug, kind, id),
			"Policy that selects on this classification stops matching the resource.",
		) {
			return
		}
		if err := runClassificationUnassign(client, os.Stdout, kind, id, valueSlug); err != nil {
			failf("Failed to unassign classification: %v", err)
		}
	},
}

// resolveAssignedValue answers "which value?" for `unassign`.
//
// The candidates are what the RESOURCE carries, not the org's whole taxonomy — deliberately a
// different source from `assign`'s. The two questions look alike and are not: assign chooses from
// everything that could be true of the resource, unassign from what currently IS. Offering the
// taxonomy here would let someone clear a value the resource never had, which the server answers
// with a no-op the CLI would report as a success.
func resolveAssignedValue(c apiClient, kind, id string, rest []string) (string, error) {
	if len(rest) > 0 && strings.TrimSpace(rest[0]) != "" {
		return strings.TrimSpace(rest[0]), nil
	}
	assigned, err := c.GetResourceClassifications(kind, id)
	if err != nil {
		return "", err
	}
	if len(assigned) == 0 {
		return "", fmt.Errorf("%s %s carries no classification values to clear", kind, id)
	}
	if err := requireInteractiveForm(); err != nil {
		return "", fmt.Errorf("no value slug given: pass one of %s as the argument (%w)",
			strings.Join(assignedSlugs(assigned), ", "), err)
	}
	f := mustGovField("alethia classification unassign", fieldKeyClassValue)
	options := make([]huh.Option[int], len(assigned))
	for i, a := range assigned {
		options[i] = huh.NewOption(govBullet(a.DimensionLabel, a.ValueLabel, a.Value), i)
	}
	chosen := 0
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[int]().Title(f.Title).Description(f.Description).Options(options...).Value(&chosen),
	)); err != nil {
		return "", err
	}
	return assigned[chosen].Value, nil
}

// assignedSlugs returns the value slugs a resource carries, for the refusal message.
func assignedSlugs(assigned []api.ClassificationAssignment) []string {
	out := make([]string, len(assigned))
	for i, a := range assigned {
		out[i] = a.Value
	}
	return out
}

func runClassificationUnassign(c apiClient, out io.Writer, kind, id, valueSlug string) error {
	if err := c.UnassignClassification(kind, id, valueSlug); err != nil {
		return err
	}
	fmt.Fprintln(out, ui.FormatSuccess(fmt.Sprintf("Cleared %s from %s %s", valueSlug, kind, id)))
	return nil
}

func init() {
	classificationCmd.AddCommand(classificationDimensionsCmd)
	classificationCmd.AddCommand(classificationShowCmd)
	classificationCmd.AddCommand(classificationAssignCmd)
	addYesFlag(classificationUnassignCmd, &classificationUnassignYes)
	classificationCmd.AddCommand(classificationUnassignCmd)
	rootCmd.AddCommand(classificationCmd)
}
