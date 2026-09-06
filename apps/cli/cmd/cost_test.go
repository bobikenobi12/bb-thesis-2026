// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

func f64(v float64) *float64 { return &v }

func TestRunCostShowPriced(t *testing.T) {
	ts := "2026-01-01T00:00:00.000Z"
	c := &fakeClient{cost: &api.EnvironmentCost{
		Priced: true, TotalMonthly: f64(123.45), Currency: "USD", CapturedAt: &ts, Environment: strptr("staging"),
		Resources: []api.CostResourceLine{
			{Address: "aws_db_instance.main", ResourceType: "aws_db_instance", MonthlyCost: 100.00},
			{Address: "aws_s3_bucket.logs", ResourceType: "aws_s3_bucket", MonthlyCost: 23.45},
		},
	}}
	var buf bytes.Buffer
	if err := runCostShow(c, &buf, "table", "proj", "staging"); err != nil {
		t.Fatalf("runCostShow: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"$123.45/mo", "staging", "aws_db_instance.main", "$100.00/mo", "$23.45/mo"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
	// The ISO code is NOT printed beside a symbol it already implies. `$123.45/mo USD` was the old
	// shape, and it is the readable half of the defect that made `€` amounts read as dollars.
	if strings.Contains(out, "USD") {
		t.Errorf("headline still carries the ISO code beside the symbol:\n%s", out)
	}
}

// --- money: the currency is the ENVIRONMENT's, not the format string's ---

// TestCostSummaryRendersTheEnvironmentsOwnCurrency is the defect the issue names by line number.
// `fmt.Sprintf("Cost%s: $%.2f/mo %s%s", …)` welded a `$` to the amount and appended the wire's ISO
// code, so a euro organization was told two currencies about one number and the leading one was
// always wrong.
func TestCostSummaryRendersTheEnvironmentsOwnCurrency(t *testing.T) {
	got := costSummary(&api.EnvironmentCost{Priced: true, TotalMonthly: f64(12), Currency: "EUR"})
	if !strings.Contains(got, "€12.00/mo") {
		t.Errorf("EUR headline = %q, want it to carry €12.00/mo", got)
	}
	if strings.Contains(got, "$") {
		t.Errorf("EUR headline still prints a dollar sign: %q", got)
	}
	if strings.Contains(got, "EUR") {
		t.Errorf("EUR headline names the currency twice (symbol and ISO code): %q", got)
	}
}

// TestCostSummaryNamesACurrencyItHasNoSymbolFor pins the other half of the same rule: a currency
// with no narrow symbol renders its ISO code and NEVER a guessed glyph. A guessed symbol on a
// billed amount is the worst answer available.
func TestCostSummaryNamesACurrencyItHasNoSymbolFor(t *testing.T) {
	got := costSummary(&api.EnvironmentCost{Priced: true, TotalMonthly: f64(12.5), Currency: "HUF"})
	if !strings.Contains(got, "12.50 HUF/mo") {
		t.Errorf("HUF headline = %q, want it to carry 12.50 HUF/mo", got)
	}
	if strings.Contains(got, "$") || strings.Contains(got, "€") {
		t.Errorf("HUF headline invented a symbol: %q", got)
	}
}

// TestCostMoneyRoundsTheWayTheConsoleDoes drives BOTH sides of the rounding claim rather than
// asserting the fixed output alone.
//
// The premise — that Go's %f rounds half to EVEN and so disagrees with the billing page — is
// measured here, not remembered: if a future Go changed it, the first assertion fails and says so,
// instead of this test quietly becoming a tautology about a defect that no longer exists.
//
// 0.125 is the case at TWO decimals. It is exactly representable in binary, so nothing here rests
// on float noise: %.2f gives 0.12 and JavaScript's toFixed(2) gives 0.13.
func TestCostMoneyRoundsTheWayTheConsoleDoes(t *testing.T) {
	if got := fmt.Sprintf("$%.2f", 0.125); got != "$0.12" {
		t.Fatalf(`premise broken: fmt.Sprintf("$%%.2f", 0.125) = %q, want "$0.12" — this test exists `+
			"because Go rounds half to EVEN there and the console does not", got)
	}
	rows := costRows([]api.CostResourceLine{{Address: "a", ResourceType: "t", MonthlyCost: 0.125}}, "USD", ui.FormatTable)
	if got := rows[0][2]; got != "$0.13/mo" {
		t.Errorf("cost cell for 0.125 = %q, want $0.13/mo — the console shows $0.13", got)
	}
}

// TestCostRowsRenderInTheEnvironmentsCurrency covers the per-resource half. costRows took no
// currency at all before, which is why every row was in dollars whatever the environment was
// priced in.
func TestCostRowsRenderInTheEnvironmentsCurrency(t *testing.T) {
	rows := costRows([]api.CostResourceLine{
		{Address: "aws_db_instance.main", ResourceType: "aws_db_instance", MonthlyCost: 100},
	}, "EUR", ui.FormatTable)
	if got := rows[0][2]; got != "€100.00/mo" {
		t.Errorf("EUR row cell = %q, want €100.00/mo", got)
	}
}

// TestCostRowsAndHeadlineUseOneRule is the agreement the issue is really about: a headline and the
// column beneath it that round differently make the column not add up to the headline.
func TestCostRowsAndHeadlineUseOneRule(t *testing.T) {
	line := api.CostResourceLine{Address: "a", ResourceType: "t", MonthlyCost: 0.125}
	cost := &api.EnvironmentCost{Priced: true, TotalMonthly: f64(0.125), Currency: "USD", Resources: []api.CostResourceLine{line}}
	cell := costRows(cost.Resources, cost.Currency, ui.FormatTable)[0][2]
	if !strings.Contains(costSummary(cost), cell) {
		t.Errorf("headline %q does not render the same amount as the row cell %q", costSummary(cost), cell)
	}
}

func TestRunCostShowEmptyResourcesStillPrintsTheHeadline(t *testing.T) {
	c := &fakeClient{cost: &api.EnvironmentCost{Priced: true, TotalMonthly: f64(7.5), Currency: "GBP"}}
	var buf bytes.Buffer
	if err := runCostShow(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runCostShow: %v", err)
	}
	if !strings.Contains(buf.String(), "£7.50/mo") {
		t.Errorf("expected the GBP headline with no resource table, got: %q", buf.String())
	}
}

// --- the capture stamp ---

func TestCostSummaryRendersTheCaptureStampLikeTheConsole(t *testing.T) {
	ts := "2026-03-09T15:04:05.000Z"
	got := costSummary(&api.EnvironmentCost{Priced: true, TotalMonthly: f64(1), Currency: "USD", CapturedAt: &ts})
	if !strings.Contains(got, "(captured 9 Mar 2026, 15:04)") {
		t.Errorf("headline = %q, want the console's date shape", got)
	}
	if strings.Contains(got, ts) {
		t.Errorf("headline still echoes the raw wire timestamp: %q", got)
	}
}

// TestCostCapturedAtKeepsAnUnparseableStampVerbatim: a timestamp the CLI cannot read is a WIRE
// problem, and showing it lets someone report what actually arrived. A dash would hide it.
func TestCostCapturedAtKeepsAnUnparseableStampVerbatim(t *testing.T) {
	if got := costCapturedAt("last tuesday"); got != "last tuesday" {
		t.Errorf("costCapturedAt(unparseable) = %q, want it returned verbatim", got)
	}
}

// TestCostCapturedAtIsTheSameInstantEverywhere: the stamp is rendered in UTC and not in the
// process's zone, so two engineers reading the same cost record read the same time.
func TestCostCapturedAtIsTheSameInstantEverywhere(t *testing.T) {
	if got := costCapturedAt("2026-03-09T23:30:00+09:00"); got != "9 Mar 2026, 14:30" {
		t.Errorf("costCapturedAt(+09:00 stamp) = %q, want it normalised to UTC (9 Mar 2026, 14:30)", got)
	}
}

// --- resolving the project: flag first, picker second, --no-input names the flag ---

func newCostTestCmd() *cobra.Command {
	c := &cobra.Command{Use: "show"}
	c.Flags().StringP("project", "p", "", "")
	return c
}

func TestResolveCostProjectPrefersTheFlag(t *testing.T) {
	c := newCostTestCmd()
	if err := c.ParseFlags([]string{"--project", "web"}); err != nil {
		t.Fatalf("parse flags: %v", err)
	}
	picked := false
	got, err := resolveCostProject(c, true, func() (string, error) { picked = true; return "other", nil })
	if err != nil || got != "web" {
		t.Fatalf("resolveCostProject = %q, %v; want web", got, err)
	}
	if picked {
		t.Error("the picker ran even though --project answered the question — the flag is the whole contract")
	}
}

func TestResolveCostProjectFallsBackToThePicker(t *testing.T) {
	got, err := resolveCostProject(newCostTestCmd(), true, func() (string, error) { return "picked-id", nil })
	if err != nil || got != "picked-id" {
		t.Fatalf("resolveCostProject = %q, %v; want picked-id", got, err)
	}
}

// TestResolveCostProjectUnderNoInputNamesTheFlag: errNoInput says "interactive input required",
// which is true and useless in a script. The refusal must name the flag that would have answered it.
func TestResolveCostProjectUnderNoInputNamesTheFlag(t *testing.T) {
	_, err := resolveCostProject(newCostTestCmd(), true, func() (string, error) { return "", errNoInput })
	if err == nil {
		t.Fatal("expected a refusal under --no-input")
	}
	if !strings.Contains(err.Error(), "--project") {
		t.Errorf("refusal = %q, want it to name --project", err)
	}
}

// TestResolveCostProjectSurfacesARealPickerFailure: a network failure fetching the project list is
// not a missing flag, and rewriting it as one would send the reader to fix the wrong thing.
func TestResolveCostProjectSurfacesARealPickerFailure(t *testing.T) {
	boom := errors.New("failed to fetch projects: connection refused")
	_, err := resolveCostProject(newCostTestCmd(), true, func() (string, error) { return "", boom })
	if !errors.Is(err, boom) {
		t.Errorf("resolveCostProject swallowed the picker's error: %v", err)
	}
}

// TestResolveCostProjectRefusesAnEmptySelection: a picker that returns "" with no error would
// otherwise send an empty project to the API and get back a 404 naming nothing the user typed.
func TestResolveCostProjectRefusesAnEmptySelection(t *testing.T) {
	_, err := resolveCostProject(newCostTestCmd(), true, func() (string, error) { return "", nil })
	if err == nil || !strings.Contains(err.Error(), "--project") {
		t.Errorf("empty selection = %v, want a refusal naming --project", err)
	}
}

// TestResolveCostProjectDoesNotPickForAMachineReadableRun is the reason the picker takes a gate at
// all: `alethia cost show -o json` has nobody to answer a question, so opening a picker is a
// command that waits forever rather than one that prints. (It also used to garble the file, because
// both widgets drew on os.Stdout; they draw on ui.InteractiveOutput now, so that half is fixed at
// the source.) The caller passes interactiveTable's verdict, which is false for json/csv, for
// --no-input, and for a redirected stdout.
func TestResolveCostProjectDoesNotPickForAMachineReadableRun(t *testing.T) {
	picked := false
	_, err := resolveCostProject(newCostTestCmd(), false, func() (string, error) { picked = true; return "picked-id", nil })
	if picked {
		t.Error("the picker ran for a non-interactive render — its spinner and form would land in the output stream")
	}
	if err == nil || !strings.Contains(err.Error(), "--project") {
		t.Errorf("refusal = %v, want one naming --project", err)
	}
}

// --- the picker, through the REAL command tree ---
//
// The tests above drive resolveCostProject with a `mayPick` the test chose. That leaves the
// half that actually regressed untested: costShowCmd is what COMPUTES that verdict, and the
// defect was a `cost show` that prompted whatever the format was. Only the cobra tree pins
// the composition — and the fake control plane below records the paths it is asked for, so
// the assertion is "which project did the command go on to price", not "did it exit 0".

// costPickerEnv stands up isolated credentials, an active org and a control plane that
// RECORDS every path it serves, and returns a runner for the real cobra tree plus a reader
// for those paths.
//
// The recording is the point: `GET /api/cli/projects/<id>/cost` carries the project id in
// its path, so a test can assert that the picker's answer is what got priced, and that a
// refused run never asked about a project called "".
func costPickerEnv(t *testing.T) (func(args ...string) error, func() []string) {
	t.Helper()
	credsPath := isolatedHome(t)
	if err := saveCredentials(credsPath, types.ExchangeResponse{
		AccessToken: makeToken(t, time.Now().Add(time.Hour)), RefreshToken: "r",
	}); err != nil {
		t.Fatalf("save credentials: %v", err)
	}
	if err := types.SaveCliConfig(types.CliConfig{
		ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme",
	}); err != nil {
		t.Fatalf("save cli config: %v", err)
	}

	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.URL.Path)
		mu.Unlock()

		enc := json.NewEncoder(w)
		if r.URL.Path == "/api/cli/configurations" {
			// Two projects, so "the first one" is a choice the picker made rather than
			// the only value it could have produced.
			_ = enc.Encode(map[string]any{"configurations": []map[string]any{
				{"id": "p-first", "project_name": "web", "environment_stage": "production"},
				{"id": "p-second", "project_name": "api", "environment_stage": "staging"},
			}})
			return
		}
		_ = enc.Encode(map[string]any{
			"priced": true, "total_monthly": 10.0, "currency": "USD",
			"resources": []map[string]any{
				{"address": "aws_s3_bucket.logs", "resource_type": "aws_s3_bucket", "monthly_cost": 10.0},
			},
		})
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	run := func(args ...string) error {
		execRootArgs(args)
		return rootCmd.Execute()
	}
	paths := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string{}, seen...)
	}
	return run, paths
}

// costStubPicker replaces the huh form with one that counts its openings and returns without
// touching the answer.
//
// Returning nil is not "the user selected nothing": huh writes the highlighted option into
// the bound value while the Select is being BUILT (Options() then Value() both call
// updateValue), so the stub reproduces a user pressing enter on the pre-selected first
// project. The counter is what lets a test assert the picker did NOT open.
func costStubPicker(t *testing.T, err error) *int {
	t.Helper()
	opened := 0
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { opened++; return err }
	t.Cleanup(func() { runHuhForm = prev })
	return &opened
}

// costSaw reports whether the fake control plane was asked for a path.
func costSaw(paths []string, want string) bool {
	for _, p := range paths {
		if p == want {
			return true
		}
	}
	return false
}

// costArgs is one `cost show` invocation with the sticky flags cleared. --project and --env
// live on a package-global command and keep whatever the previous test set, so an omitted
// --project has to be written as `--project=` or this test silently prices "web".
func costArgs(outFmt string) []string {
	return []string{"cost", "show", "--project=", "--env=", "--output", outFmt, "--no-input=false"}
}

// TestCostShowPricesTheProjectThePickerReturned pins the arm the unit tests cannot reach:
// with --project omitted on a terminal, costShowCmd must open the shared project picker and
// then price what it chose. Before the picker existed this invocation refused outright.
func TestCostShowPricesTheProjectThePickerReturned(t *testing.T) {
	miscTTY(t)
	t.Cleanup(covListResetFlags)
	opened := costStubPicker(t, nil)
	run, paths := costPickerEnv(t)

	if miscTrapExit(t, run)(costArgs("table")...) {
		t.Fatal("cost show exited fatally with --project omitted on a terminal; the picker should have answered it")
	}
	if *opened != 1 {
		t.Errorf("the project picker opened %d times, want exactly 1", *opened)
	}
	// One of the two projects the picker OFFERED, and emphatically not the empty id: a
	// `cost show` that priced "" would come back as a 404 about a project nobody named.
	// Which of the two huh pre-highlights is huh's business, not this command's.
	if !costSaw(paths(), "/api/cli/projects/p-first/cost") && !costSaw(paths(), "/api/cli/projects/p-second/cost") {
		t.Errorf("cost was fetched for %v, want one of the projects the picker offered", paths())
	}
}

// TestCostShowDoesNotPriceAnythingWhenThePickerIsAborted pins the other end of the same
// path: a picker the user escapes out of must stop the command, not fall through to a cost
// query for whatever the project variable happens to hold.
func TestCostShowDoesNotPriceAnythingWhenThePickerIsAborted(t *testing.T) {
	miscTTY(t)
	t.Cleanup(covListResetFlags)
	opened := costStubPicker(t, errors.New("user aborted"))
	run, paths := costPickerEnv(t)

	if !miscTrapExit(t, run)(costArgs("table")...) {
		t.Error("an aborted picker must be fatal — the command has no project to price")
	}
	if *opened != 1 {
		t.Errorf("the project picker opened %d times, want exactly 1", *opened)
	}
	for _, p := range paths() {
		if strings.HasSuffix(p, "/cost") {
			t.Errorf("an aborted picker still priced something: %s", p)
		}
	}
}

// TestCostShowNeverPromptsForAMachineReadableRun is the regression the picker gate exists
// for: a machine-readable run has nobody to answer a picker, so `alethia cost show -o json`
// would wait rather than print. The refusal names --project instead, which is what the
// invocation did before the picker existed.
func TestCostShowNeverPromptsForAMachineReadableRun(t *testing.T) {
	miscTTY(t)
	t.Cleanup(covListResetFlags)
	opened := costStubPicker(t, nil)
	run, paths := costPickerEnv(t)
	exits := miscTrapExit(t, run)

	for _, outFmt := range []string{"json", "csv"} {
		if !exits(costArgs(outFmt)...) {
			t.Errorf("-o %s with no --project: want the refusal that names --project", outFmt)
		}
	}
	if *opened != 0 {
		t.Errorf("the picker opened %d times for a machine-readable render; its frames would land in the document", *opened)
	}
	if costSaw(paths(), "/api/cli/configurations") {
		t.Error("the picker's project list was fetched — the spinner that fetch runs writes to stdout")
	}
}

// TestCostShowNeverPromptsForARedirectedTable pins the case --no-input cannot describe:
// stdin is still a terminal, so prompting is enabled, but stdout is a file
// (`alethia cost show > cost.txt`). resolveInputMode reads STDIN only, which is why the gate
// is interactiveTable's verdict and not noInputMode.
func TestCostShowNeverPromptsForARedirectedTable(t *testing.T) {
	prevIn, prevOut := stdinIsTTY, stdoutIsTTY
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return false }
	t.Cleanup(func() { stdinIsTTY, stdoutIsTTY = prevIn, prevOut })
	t.Cleanup(covListResetFlags)

	opened := costStubPicker(t, nil)
	run, paths := costPickerEnv(t)

	if !miscTrapExit(t, run)(costArgs("table")...) {
		t.Error("a redirected table with no --project: want the refusal that names --project")
	}
	if *opened != 0 {
		t.Errorf("the picker opened %d times for a redirected table; its frames would land in the file", *opened)
	}
	if costSaw(paths(), "/api/cli/configurations") {
		t.Error("the picker's project list was fetched for a redirected table")
	}
}

// TestCostCSVKeepsTheMonthlyCellMachineReadable pins the OTHER half of the shared-Rows problem:
// ui.Render writes spec.Rows verbatim into the CSV, so the humanised cell would have shipped a
// `/mo` suffix, `,` thousands separators and a per-environment currency glyph into a column a
// script parses as a float.
func TestCostCSVKeepsTheMonthlyCellMachineReadable(t *testing.T) {
	lines := []api.CostResourceLine{{Address: "a", ResourceType: "t", MonthlyCost: 1234.56}}
	if got := costRows(lines, "EUR", ui.FormatCSV)[0][2]; got != "1234.56" {
		t.Errorf("csv Monthly cell = %q, want the bare number 1234.56", got)
	}
	// The premise: the table cell for the same amount is NOT parseable as a float, which is why the
	// two renders had to part company.
	table := costRows(lines, "EUR", ui.FormatTable)[0][2]
	if _, err := strconv.ParseFloat(table, 64); err == nil {
		t.Fatalf("premise broken: the table cell %q parses as a float, so this split guards nothing", table)
	}
}

// TestRunCostShowCSVEmitsBareNumbers drives the whole csv render rather than the row builder, so
// the assertion is about what a script actually receives on stdout.
func TestRunCostShowCSVEmitsBareNumbers(t *testing.T) {
	c := &fakeClient{cost: &api.EnvironmentCost{
		Priced: true, TotalMonthly: f64(1234.56), Currency: "EUR",
		Resources: []api.CostResourceLine{{Address: "aws_db_instance.main", ResourceType: "aws_db_instance", MonthlyCost: 1234.56}},
	}}
	var buf bytes.Buffer
	if err := runCostShow(c, &buf, ui.FormatCSV, "proj", ""); err != nil {
		t.Fatalf("runCostShow: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "1234.56") {
		t.Errorf("csv output does not carry the bare amount:\n%s", out)
	}
	for _, unwanted := range []string{"/mo", "1,234", "€"} {
		if strings.Contains(out, unwanted) {
			t.Errorf("csv output carries %q, which a float parser chokes on:\n%s", unwanted, out)
		}
	}
}

func TestRunCostShowUnpriced(t *testing.T) {
	c := &fakeClient{cost: &api.EnvironmentCost{Priced: false, Currency: "USD"}}
	var buf bytes.Buffer
	if err := runCostShow(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runCostShow: %v", err)
	}
	if !strings.Contains(buf.String(), "not priced") {
		t.Errorf("expected not-priced summary, got: %q", buf.String())
	}
}

func TestRunCostShowJSON(t *testing.T) {
	c := &fakeClient{cost: &api.EnvironmentCost{Priced: true, TotalMonthly: f64(10), Currency: "USD", Resources: []api.CostResourceLine{{Address: "a", ResourceType: "t", MonthlyCost: 10}}}}
	var buf bytes.Buffer
	if err := runCostShow(c, &buf, "json", "proj", ""); err != nil {
		t.Fatalf("runCostShow json: %v", err)
	}
	if !strings.Contains(buf.String(), `"priced": true`) || !strings.Contains(buf.String(), `"resource_type": "t"`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunCostShowError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runCostShow(c, &bytes.Buffer{}, "table", "proj", ""); err == nil {
		t.Error("expected error to propagate")
	}
}
