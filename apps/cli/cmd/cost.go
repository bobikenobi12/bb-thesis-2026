// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/spf13/cobra"
)

var costCmd = &cobra.Command{
	Use:   "cost",
	Short: "Inspect a project environment's infrastructure cost",
	Long: `Every PLAN runs Infracost over the terraform plan and records the priced breakdown
per environment. Show the latest cost for a project environment (defaults to the project's
default environment; pass --env for another).`,
}

var costShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Show the latest cost for a project environment",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		// The output format is resolved BEFORE the project, for two reasons. `-o bogus` is now
		// rejected without first opening a picker; and interactiveTable is what decides whether the
		// picker may run at all — huh and its spinner write to os.Stdout, so a picker opened for
		// `-o json > cost.json` would put its frames in the file ahead of the JSON document.
		outFmt := outputFormat(cmd)
		project, err := resolveCostProject(cmd, interactiveTable(cmd), func() (string, error) { return selectProject(token) })
		if err != nil {
			fail(err)
		}
		env, _ := cmd.Flags().GetString("env")
		if err := runCostShow(api.NewClient(token), os.Stdout, outFmt, project, env); err != nil {
			failf("Failed to get cost: %v", err)
		}
	},
}

// resolveCostProject decides which project `cost show` reads: the --project flag when it carries a
// value, otherwise the interactive picker every other project-scoped command already uses.
//
// The flag stays the COMPLETE contract — the picker can only answer a question the flag can also
// answer — so `--no-input` never needs a TTY. It takes `pick` as a parameter rather than calling
// selectProject directly so both arms are reachable without a terminal or a network.
//
// `mayPick` is the caller's interactiveTable verdict, and it is a correctness gate rather than a
// nicety. It USED to be a gate against stream corruption — both widgets drew on os.Stdout, so a
// picker opened for `-o json > cost.json` put spinner frames and a rendered select in the file
// ahead of the document and the file stopped parsing. That is now fixed at the source: both draw on
// ui.InteractiveOutput, which is stderr. The gate remains for the reason that outlives it — a
// machine-readable run has nobody to answer a question, so asking one is a hang, not a garbled
// file. When picking is not allowed, an omitted --project is refused the same way --no-input
// refuses it, which is what the invocation did before the picker existed.
//
// Under --no-input the picker returns errNoInput, whose message is "interactive input required".
// That is true and useless here: it does not say WHICH input. The refusal is rewritten to name the
// flag, because the person reading it is writing a script.
func resolveCostProject(cmd *cobra.Command, mayPick bool, pick func() (string, error)) (string, error) {
	if p, _ := cmd.Flags().GetString("project"); p != "" {
		return p, nil
	}
	if !mayPick {
		return "", errCostProjectRequired
	}
	project, err := pick()
	if err != nil {
		if errors.Is(err, errNoInput) {
			return "", errCostProjectRequired
		}
		return "", err
	}
	if project == "" {
		// A picker that returns no error and no selection would otherwise send an empty project id
		// to the API and get back a 404 about a project the user never named.
		return "", errCostProjectRequired
	}
	return project, nil
}

var errCostProjectRequired = errors.New("--project is required (pass the project name or id)")

var costColumns = []string{"Address", "Type", "Monthly"}

// costRows projects priced resource lines into plain cells for the given output format.
//
// The Monthly cell renders through format.MonthlyRate in the environment's OWN currency. It used to
// be fmt.Sprintf("$%.2f", …), which is wrong twice: the `$` is a constant, so a euro environment
// was priced in dollars; and %f rounds half to EVEN, so 0.125 printed $0.12 where the console's
// formatMonthlyRate prints $0.13.
//
// `Exact` and not `Estimate`, and on every row, because the reader adds the column up — the same
// call the console's Cost Breakdown table makes on the same numbers.
func costRows(resources []api.CostResourceLine, currency, outFmt string) [][]string {
	rows := make([][]string, len(resources))
	for i, r := range resources {
		rows[i] = []string{r.Address, r.ResourceType, costMonthlyCell(r.MonthlyCost, currency, outFmt)}
	}
	return rows
}

// costMonthlyCell renders one Monthly cell: the shared formatter's rate for a person, and a bare
// fixed-point number for CSV.
//
// ui.Render writes spec.Rows verbatim in its CSV branch, so the humanised cell is what
// `alethia cost show -o csv` would emit — and it carries three things a machine format should not:
// a `/mo` suffix, `,` thousands separators (a $1,234.56 resource stops parsing as a float), and a
// symbol that varies by environment in a column that never varied before. The number alone is what
// a script asked for; `-o json` is where the currency is stated, once, as its ISO code.
func costMonthlyCell(amount float64, currency, outFmt string) string {
	if outFmt == ui.FormatCSV {
		return strconv.FormatFloat(amount, 'f', 2, 64)
	}
	return format.MonthlyRate(amount, format.Exact, currency)
}

// costCapturedAt renders the capture stamp the way the console writes a date — `1 Jan 2026, 00:00`
// — rather than echoing the wire's RFC3339 back at the reader.
//
// The rule itself is `ui.Stamp` and no longer lives here. It was written out in this file first;
// `staged list` then needed the same rule, and a second copy of a formatting decision is how the
// two halves of one product come to disagree. The reasons — verbatim on a parse failure, UTC and
// not the host zone — are stated once, beside the implementation.
func costCapturedAt(raw string) string {
	return ui.Stamp(raw)
}

// costSummary renders the one-line cost headline (priced / total monthly).
func costSummary(c *api.EnvironmentCost) string {
	scope := ""
	if c.Environment != nil && *c.Environment != "" {
		scope = fmt.Sprintf(" [%s]", *c.Environment)
	}
	if !c.Priced || c.TotalMonthly == nil {
		return ui.MutedStyle.Render(fmt.Sprintf("Cost%s: not priced — no plan has costed this environment yet.", scope))
	}
	when := ""
	if c.CapturedAt != nil {
		when = fmt.Sprintf(" (captured %s)", costCapturedAt(*c.CapturedAt))
	}
	// One currency, once. The previous shape was `$%.2f/mo %s` with the ISO code in the trailing
	// %s, so a EUR environment read `$12.00/mo EUR` — two currencies in one string, neither of them
	// necessarily the right one. format.MonthlyRate renders the symbol when it knows one and the
	// ISO code when it does not, and never both.
	return fmt.Sprintf("Cost%s: %s%s", scope, format.MonthlyRate(*c.TotalMonthly, format.Exact, c.Currency), when)
}

// runCostShow fetches and renders an environment's cost. json emits the whole cost object;
// table prints a summary headline then the priced-resource table; csv emits the resource rows.
//
// The output-format parameter is `outFmt` and not `format`, which is what every sibling runner
// calls it: this file now imports `packages/core/format`, and a parameter named `format` shadows
// the package for the whole body — so the next money render written in here would fail to compile
// with a message about a string having no method, and the obvious repair is a local %f.
func runCostShow(c apiClient, out io.Writer, outFmt, project, env string) error {
	cost, err := c.GetEnvironmentCost(project, env)
	if err != nil {
		return err
	}
	if outFmt == ui.FormatJSON {
		return ui.Render(out, outFmt, ui.TableSpec{}, cost)
	}
	if outFmt == ui.FormatTable {
		fmt.Fprintln(out, costSummary(cost))
		if len(cost.Resources) == 0 {
			return nil
		}
	}
	return ui.Render(out, outFmt, ui.TableSpec{
		Columns: costColumns,
		Rows:    costRows(cost.Resources, cost.Currency, outFmt),
	}, cost.Resources)
}

func init() {
	costCmd.PersistentFlags().StringP("project", "p", "", "Project name or id (interactive picker on a TTY when omitted)")
	costCmd.PersistentFlags().StringP("env", "e", "", "Environment name, stage, or id (default: the project's default environment)")
	costCmd.AddCommand(costShowCmd)
	rootCmd.AddCommand(costCmd)
}
