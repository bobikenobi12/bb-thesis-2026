// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// --- billing ---

func sampleBilling() *api.Billing {
	seats := 5
	return &api.Billing{
		Plan: "team", Status: "active", Seats: &seats,
		StripeSubscriptionID: "sub_123", TrialEndsAt: "",
		CurrentPeriodEnd: "2026-02-01T00:00:00.000Z",
	}
}

func TestRunBillingTable(t *testing.T) {
	var buf bytes.Buffer
	if err := runBilling(&fakeClient{billing: sampleBilling()}, &buf, "table"); err != nil {
		t.Fatalf("runBilling: %v", err)
	}
	for _, want := range []string{"team", "active", "5", "sub_123"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("billing table missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunBillingNilSeats(t *testing.T) {
	var buf bytes.Buffer
	b := sampleBilling()
	b.Seats = nil
	if err := runBilling(&fakeClient{billing: b}, &buf, "table"); err != nil {
		t.Fatalf("runBilling: %v", err)
	}
	// A nil seat count renders the dash glyph, not "0".
	if !strings.Contains(buf.String(), "team") {
		t.Errorf("expected plan present: %s", buf.String())
	}
}

func TestRunBillingJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runBilling(&fakeClient{billing: sampleBilling()}, &buf, "json"); err != nil {
		t.Fatalf("runBilling json: %v", err)
	}
	var got api.Billing
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v\n%s", err, buf.String())
	}
	if got.Plan != "team" || got.Seats == nil || *got.Seats != 5 {
		t.Errorf("unexpected billing json: %+v", got)
	}
}

func TestRunBillingError(t *testing.T) {
	var buf bytes.Buffer
	if err := runBilling(&fakeClient{err: errBoom}, &buf, "table"); err == nil {
		t.Error("expected error propagated")
	}
}

// --- usage ---

func sampleUsage() *api.Usage {
	return &api.Usage{
		SeatsUsed: 3, SeatsCap: 5, RunnerMinutes: 120,
		Projects: 7, AICreditsUsed: 450, AICreditsGranted: 3000,
	}
}

func TestRunUsageTable(t *testing.T) {
	var buf bytes.Buffer
	if err := runUsage(&fakeClient{usage: sampleUsage()}, &buf, "table"); err != nil {
		t.Fatalf("runUsage: %v", err)
	}
	for _, want := range []string{"3 / 5", "2h", "7", "450 / 3000"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("usage table missing %q:\n%s", want, buf.String())
		}
	}
}

// usageCell returns the value of one Field/Value row in the given render, so an assertion can be
// about the whole cell rather than a substring of the rendered card. `strings.Contains(out, "2h")`
// is satisfied by "2h 15m" and by "12h"; the row is the thing under test.
func usageCell(t *testing.T, u *api.Usage, outFmt, field string) string {
	t.Helper()
	for _, row := range usageRows(u, outFmt) {
		if row[0] == field {
			return row[1]
		}
	}
	t.Fatalf("usage has no %q row: %v", field, usageRows(u, outFmt))
	return ""
}

// TestUsageRendersRunnerMinutesForAPerson is the defect the issue names: `strconv.Itoa` printed a
// bare integer with no unit, where the console reads the same number through formatMinutes.
//
// The cases are named rather than counted, and each is a shape the old render got wrong in its own
// way: an hour boundary, a sub-minute figure that a bare integer prints as "0", and the ordinary
// case that has to keep its unit.
func TestUsageRendersRunnerMinutesForAPerson(t *testing.T) {
	cases := map[string]struct {
		minutes int
		want    string
	}{
		"a whole number of hours drops the minutes": {120, "2h"},
		"an hour and a bit keeps both":              {135, "2h 15m"},
		"under an hour stays in minutes":            {47, "47 min"},
		"nothing used is zero, with its unit":       {0, "0 min"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			u := sampleUsage()
			u.RunnerMinutes = tc.minutes
			if got := usageCell(t, u, ui.FormatTable, "Runner minutes"); got != tc.want {
				t.Errorf("Runner minutes for %d = %q, want %q", tc.minutes, got, tc.want)
			}
		})
	}
}

// TestUsageDoesNotInventARunnerMinuteAllowance pins a DECISION, not an omission.
//
// api.Usage pairs seats_used/seats_cap and ai_credits_used/ai_credits_granted, and carries no
// runner-minute allowance at all. The console's `/ 200 min` comes from the plan catalogue, which
// the CLI does not have. Rendering `2h / 0 min` would state an allowance of zero — a number the
// user would read as "no minutes included" — and `2h / 200 min` would state one nobody sent.
//
// When an `included_minutes` field is added to the wire, this test is what should fail: it is the
// record of why the quota is absent, so its failure is the prompt to render one.
func TestUsageDoesNotInventARunnerMinuteAllowance(t *testing.T) {
	got := usageCell(t, sampleUsage(), ui.FormatTable, "Runner minutes")
	if strings.Contains(got, "/") {
		t.Errorf("Runner minutes = %q — it renders a ratio, but api.Usage carries no runner-minute "+
			"cap for the denominator to come from. If the wire gained one, render format.Quota and "+
			"delete this test; if it did not, the denominator was invented.", got)
	}
	// The premise, asserted rather than remembered: the two counters that DO have a cap keep theirs.
	for _, field := range []string{"Seats", "AI credits"} {
		if cell := usageCell(t, sampleUsage(), ui.FormatTable, field); !strings.Contains(cell, "/") {
			t.Errorf("%s = %q, want a used/cap ratio — the wire does carry a cap for it", field, cell)
		}
	}
}

// TestUsageCSVKeepsRunnerMinutesAsAnInteger pins the machine half of the same row.
//
// ui.RenderCard hands these exact rows to the CSV branch, so humanising them unconditionally turned
// `alethia usage -o csv | awk -F, '/Runner minutes/ {print $2}'` from `120` into `2h` — silently,
// with no error to notice. `2h 15m` is worse still: one field that no longer parses at all.
func TestUsageCSVKeepsRunnerMinutesAsAnInteger(t *testing.T) {
	u := sampleUsage()
	u.RunnerMinutes = 135
	got := usageCell(t, u, ui.FormatCSV, "Runner minutes")
	if got != "135" {
		t.Errorf("csv Runner minutes = %q, want the raw integer 135", got)
	}
	// The premise: the table cell for the same number is NOT an integer, which is why the two
	// renders had to part company rather than share one string.
	if table := usageCell(t, u, ui.FormatTable, "Runner minutes"); table == got {
		t.Fatalf("premise broken: the table cell is also %q, so this split guards nothing", table)
	}
}

func TestRunUsageCSVIsParseable(t *testing.T) {
	var buf bytes.Buffer
	if err := runUsage(&fakeClient{usage: sampleUsage()}, &buf, ui.FormatCSV); err != nil {
		t.Fatalf("runUsage: %v", err)
	}
	if !strings.Contains(buf.String(), "Runner minutes,120") {
		t.Errorf("csv output does not carry the raw minute count:\n%s", buf.String())
	}
}

func TestRunUsageJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runUsage(&fakeClient{usage: sampleUsage()}, &buf, "json"); err != nil {
		t.Fatalf("runUsage json: %v", err)
	}
	var got api.Usage
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if got.SeatsUsed != 3 || got.AICreditsGranted != 3000 {
		t.Errorf("unexpected usage json: %+v", got)
	}
}

func TestRunUsageError(t *testing.T) {
	var buf bytes.Buffer
	if err := runUsage(&fakeClient{err: errBoom}, &buf, "table"); err == nil {
		t.Error("expected error propagated")
	}
}

// --- fleet list ---

func sampleFleetPools() []api.FleetPool {
	return []api.FleetPool{
		{
			Provider: "aws", WarmMin: 1, Max: 10, SlotsPerRunner: 2,
			Locations: []string{"fsn1", "nbg1"}, Surge: 1, Buffer: 1,
			Channel: "stable", Version: "", Enabled: true,
		},
		{
			Provider: "gcp", WarmMin: 0, Max: 5, SlotsPerRunner: 1,
			Locations: []string{"us"}, Version: "v1.2.3", Enabled: false,
		},
	}
}

func TestRunFleetList(t *testing.T) {
	var buf bytes.Buffer
	if err := runFleetList(&fakeClient{fleetPools: sampleFleetPools()}, &buf, "table"); err != nil {
		t.Fatalf("runFleetList: %v", err)
	}
	for _, want := range []string{"aws", "gcp", "stable (channel)", "v1.2.3", "fsn1,nbg1"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("fleet list missing %q:\n%s", want, buf.String())
		}
	}
}

func TestRunFleetListJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runFleetList(&fakeClient{fleetPools: sampleFleetPools()}, &buf, "json"); err != nil {
		t.Fatalf("runFleetList json: %v", err)
	}
	var got []api.FleetPool
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid json: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("expected 2 pools, got %d", len(got))
	}
}

func TestRunFleetListEmpty(t *testing.T) {
	var buf bytes.Buffer
	if err := runFleetList(&fakeClient{fleetPools: nil}, &buf, "table"); err != nil {
		t.Fatalf("runFleetList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No fleet pools") {
		t.Errorf("expected empty notice: %s", buf.String())
	}
}

func TestRunFleetListError(t *testing.T) {
	var buf bytes.Buffer
	if err := runFleetList(&fakeClient{err: errBoom}, &buf, "table"); err == nil {
		t.Error("expected error propagated")
	}
}

// --- fleet set ---

func TestRunFleetSet(t *testing.T) {
	var buf bytes.Buffer
	f := &fakeClient{updatedPool: &api.FleetPool{Provider: "aws", WarmMin: 3, Max: 10, Enabled: true}}
	warmMin := 3
	update := api.FleetPoolUpdate{WarmMin: &warmMin}
	if err := runFleetSet(f, &buf, "aws", update); err != nil {
		t.Fatalf("runFleetSet: %v", err)
	}
	if f.setPoolProv != "aws" || f.setPoolUpdate.WarmMin == nil || *f.setPoolUpdate.WarmMin != 3 {
		t.Errorf("update not recorded: %+v", f.setPoolUpdate)
	}
	if !strings.Contains(buf.String(), "Updated aws pool") {
		t.Errorf("expected success line: %s", buf.String())
	}
}

func TestRunFleetSetError(t *testing.T) {
	var buf bytes.Buffer
	if err := runFleetSet(&fakeClient{err: errBoom}, &buf, "aws", api.FleetPoolUpdate{}); err == nil {
		t.Error("expected error propagated")
	}
}

// buildFleetUpdate is exercised through a command carrying the real flags, so the
// flag→pointer mapping (and "only set what changed") is covered.
func newFleetSetTestCmd() *cobra.Command {
	c := &cobra.Command{Use: "set"}
	c.Flags().IntVar(&fleetWarmMin, "warm-min", 0, "")
	c.Flags().IntVar(&fleetMax, "max", 0, "")
	c.Flags().IntVar(&fleetSlots, "slots", 0, "")
	c.Flags().BoolVar(&fleetEnabled, "enabled", false, "")
	c.Flags().StringVar(&fleetChannel, "channel", "", "")
	c.Flags().StringVar(&fleetVersion, "version", "", "")
	return c
}

func TestBuildFleetUpdatePartial(t *testing.T) {
	c := newFleetSetTestCmd()
	if err := c.ParseFlags([]string{"--warm-min", "3", "--enabled=false", "--version", "v2"}); err != nil {
		t.Fatalf("parse flags: %v", err)
	}
	update, changed := buildFleetUpdate(c)
	if !changed {
		t.Fatal("expected changed=true")
	}
	if update.WarmMin == nil || *update.WarmMin != 3 {
		t.Errorf("warm-min not mapped: %+v", update.WarmMin)
	}
	if update.Enabled == nil || *update.Enabled {
		t.Errorf("enabled not mapped: %+v", update.Enabled)
	}
	if update.Version == nil || *update.Version != "v2" {
		t.Errorf("version not mapped: %+v", update.Version)
	}
	if update.Max != nil || update.SlotsPerRunner != nil || update.Channel != nil {
		t.Errorf("unset flags should stay nil: %+v", update)
	}
}

func TestBuildFleetUpdateNoChange(t *testing.T) {
	c := newFleetSetTestCmd()
	if err := c.ParseFlags(nil); err != nil {
		t.Fatalf("parse flags: %v", err)
	}
	if _, changed := buildFleetUpdate(c); changed {
		t.Error("expected changed=false when no flags set")
	}
}

func TestFleetVersionCell(t *testing.T) {
	if got := fleetVersionCell(api.FleetPool{Version: "v1"}, ui.FormatTable); got != "v1" {
		t.Errorf("pinned version: got %q", got)
	}
	if got := fleetVersionCell(api.FleetPool{Channel: "stable"}, ui.FormatTable); got != "stable (channel)" {
		t.Errorf("channel: got %q", got)
	}
	if got := fleetVersionCell(api.FleetPool{}, ui.FormatTable); got == "" {
		t.Error("expected dash for no version/channel")
	}
}
