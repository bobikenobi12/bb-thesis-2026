// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The three tables #3659 would otherwise have broken for scripts.
//
// `ui.Render`'s CSV branch writes `spec.Rows` verbatim, so whatever a row builder makes for a
// person is also what `-o csv` emits. Humanising a cell is therefore a WIRE CHANGE for anything
// already parsing it, and these three were already parseable: `promotion list` emitted the wire's
// RFC3339, `token list` emitted `2026-08-26 09:41` (which sorts lexically), and `project list`'s
// Updated emitted `2006-01-02` (which sorts AND parses).
//
// This pins the floor #3659 owes — DO NOT REGRESS A CELL THAT PARSED — not the whole CSV defect,
// which is #4033's: the dash glyph, the gate ticks, the status glyph and the truncated id were
// never machine-readable and are decided there, together.
//
// The assertion is deliberately about PARSING, not about equality with some expected string. A test
// that compared the cell to `ui.Wire(...)` would pass just as happily if both sides moved to the
// same wrong thing, which is the failure mode the human/machine split exists to prevent.

const csvProbeStamp = "2026-03-09T15:04:05Z"

// mustParseCell fails unless the cell is an RFC3339 instant — the machine form.
func mustParseCell(t *testing.T, table, column, got string) {
	t.Helper()
	if got == "" {
		t.Fatalf("%s -o csv: %s is empty, want an RFC3339 instant", table, column)
	}
	if _, err := time.Parse(time.RFC3339, got); err != nil {
		t.Errorf("%s -o csv: %s = %q, which does not parse as RFC3339 (%v).\n"+
			"      The CSV branch writes rows verbatim, so humanising this cell changes what every\n"+
			"      script reading it receives. Render the human form only when outFmt is not CSV.",
			table, column, got, err)
	}
	// A comma is worse than an unparseable value: encoding/csv quotes the field correctly, so the
	// file stays RFC-4180 valid, but every `cut -d,` and `awk -F,` consumer shifts a column from
	// there on. `9 Mar 2026, 15:04` is exactly that shape.
	if strings.Contains(got, ",") {
		t.Errorf("%s -o csv: %s = %q contains a comma — it forces quoting and shifts naive readers",
			table, column, got)
	}
}

func TestHygCliCsv_PromotionKeepsTheWireStamp(t *testing.T) {
	decided := csvProbeStamp
	rows := promotionListRows([]api.Promotion{{
		ID: "p-1", Source: "staging", Target: "production", Status: "PENDING", CreatedAt: csvProbeStamp,
	}}, ui.FormatCSV)
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d", len(rows))
	}
	mustParseCell(t, "promotion list", "Created", rows[0][4])

	appr := approvalRows([]api.PromotionApproval{{Status: "APPROVED", DecidedAt: &decided}}, ui.FormatCSV)
	if len(appr) != 1 {
		t.Fatalf("want 1 approval row, got %d", len(appr))
	}
	mustParseCell(t, "promotion get", "Decided", appr[0][3])

	// An ABSENT decision is empty for a machine, never the em dash a reader gets.
	none := approvalRows([]api.PromotionApproval{{Status: "PENDING"}}, ui.FormatCSV)
	if got := none[0][3]; got != "" {
		t.Errorf("promotion get -o csv: an undecided slot = %q, want an empty field", got)
	}
}

func TestHygCliCsv_TokenKeepsTheWireStamps(t *testing.T) {
	expires := csvProbeStamp
	rows := tokenRows([]api.ServiceToken{{
		ID: "id-1", Name: "ci", TokenPrefix: "alethia_sat_abc12345",
		CreatedAt: csvProbeStamp, ExpiresAt: &expires,
	}}, ui.FormatCSV)
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d", len(rows))
	}
	mustParseCell(t, "token list", "Created", rows[0][3])
	mustParseCell(t, "token list", "Expires", rows[0][4])

	// "never" is a WORD, and a reader wants it. A machine wants the absence.
	if got := rows[0][5]; got != "" {
		t.Errorf("token list -o csv: an unused token's Last used = %q, want an empty field", got)
	}
}

func TestHygCliCsv_ProjectListKeepsASortableUpdated(t *testing.T) {
	updated, err := time.Parse(time.RFC3339, csvProbeStamp)
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	rows := projectRows([]types.ConfigurationSummary{{ProjectName: "web", UpdatedAt: updated}}, ui.FormatCSV)
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d", len(rows))
	}
	mustParseCell(t, "project list", "Updated", rows[0][6])
}

func TestHygCliCsv_JobsListKeepsASortableCreated(t *testing.T) {
	created, err := time.Parse(time.RFC3339, csvProbeStamp)
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	rows := jobRowsPlain([]api.ProvisionJob{{JobType: "PLAN", Status: "QUEUED", CreatedAt: created}}, ui.FormatCSV)
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d", len(rows))
	}
	mustParseCell(t, "jobs list", "Created", rows[0][4])
}

// The same builders must still humanise for a person — otherwise "does not regress CSV" could be
// satisfied by never humanising at all, which would silently undo the change these tests sit beside.
func TestHygCliCsv_TheTableFormStillReadsForAPerson(t *testing.T) {
	const want = "9 Mar 2026, 15:04"
	rows := promotionListRows([]api.Promotion{{ID: "p-1", CreatedAt: csvProbeStamp}}, ui.FormatTable)
	if got := rows[0][4]; got != want {
		t.Errorf("promotion list -o table: Created = %q, want %q", got, want)
	}
	tok := tokenRows([]api.ServiceToken{{ID: "id-1", CreatedAt: csvProbeStamp}}, ui.FormatTable)
	if got := tok[0][3]; got != want {
		t.Errorf("token list -o table: Created = %q, want %q", got, want)
	}
}

// ── #4033: the cells that were NEVER machine-readable ───────────────────────────────────────────
//
// Everything above pins #3659's floor — cells that already parsed and must not stop. What follows
// is the defect itself: the dash glyph, the gate ticks, the status glyph, the truncated id and the
// currency symbol were always what `-o csv` emitted, so there is no regression to guard against and
// the assertion is instead what the machine form now IS.
//
// Each table asserts BOTH arms. Asserting only the CSV one would be satisfied by a builder that
// stopped humanising altogether, which reads to a person as a regression and to this file as a pass.

// mustBeEmpty fails unless an absent optional renders as an empty field for a machine.
func mustBeEmpty(t *testing.T, table, column, got string) {
	t.Helper()
	if got != "" {
		t.Errorf("%s -o csv: an absent %s = %q, want an empty field.\n"+
			"      A reader gets %q because a blank cell reads as a broken table; a script already\n"+
			"      has a spelling for absence and it is the empty field.", table, column, got, ui.SymbolDash)
	}
}

func TestHygCliCsv_ProtectionEmitsBooleansAndBareNumbers(t *testing.T) {
	minCount, soak, threshold := 2, 30, 100.0
	full := protectionRows([]api.ProtectionRule{{
		Environment: "production", RequirePredecessor: true, RequireVerifyPass: false,
		RequireApproval: true, MinCount: &minCount, SoakMinutes: &soak, CostDeltaThreshold: &threshold,
	}}, ui.FormatCSV)[0]

	for i, want := range map[int]string{1: "true", 2: "false", 3: "true"} {
		if full[i] != want {
			t.Errorf("protection list -o csv: gate %q = %q, want %q — a gate is a boolean, and `%s`/`%s` are two glyphs",
				protectionColumns[i], full[i], want, ui.SymbolSuccess, ui.SymbolDash)
		}
	}
	if full[4] != "2" || full[5] != "30" {
		t.Errorf("protection list -o csv: limits = %q/%q, want 2/30", full[4], full[5])
	}
	// A bare fixed-point number: no `$`, no thousands separator, no `/mo`. The threshold is a size
	// the operator typed as `--cost-delta-threshold 100`, and that is what comes back.
	if full[6] != "100.00" {
		t.Errorf("protection list -o csv: Cost Δ = %q, want %q — a currency symbol is a reader's affordance", full[6], "100.00")
	}

	empty := protectionRows([]api.ProtectionRule{{Environment: "dev"}}, ui.FormatCSV)[0]
	mustBeEmpty(t, "protection list", "Approvers", empty[4])
	mustBeEmpty(t, "protection list", "Soak (min)", empty[5])
	mustBeEmpty(t, "protection list", "Cost Δ", empty[6])

	// The reader still gets the glyphs and the rendered money.
	human := protectionRows([]api.ProtectionRule{{
		Environment: "production", RequirePredecessor: true, CostDeltaThreshold: &threshold,
	}}, ui.FormatTable)[0]
	if human[1] != ui.SymbolSuccess || human[2] != ui.SymbolDash {
		t.Errorf("protection list -o table: gates = %q/%q, want %q/%q", human[1], human[2], ui.SymbolSuccess, ui.SymbolDash)
	}
	if !strings.Contains(human[6], "$") {
		t.Errorf("protection list -o table: Cost Δ = %q, want the rendered amount", human[6])
	}
}

func TestHygCliCsv_RunnerListKeepsTheOperatorAndTheHeartbeat(t *testing.T) {
	row := runnerRows([]api.Runner{{
		Name: "r1", Operator: "self", Provisioning: "hetzner", Status: "ONLINE",
		Version: "1.4.0", IsDefault: true, LastHeartbeat: csvProbeStamp,
	}}, ui.FormatCSV)[0]

	// `self·hetzner` is two api.Runner fields joined by U+00B7. The column is Operator.
	if row[1] != "self" {
		t.Errorf("runner list -o csv: Operator = %q, want %q — the human cell welds Provisioning on with a middle dot", row[1], "self")
	}
	if row[2] != "ONLINE" {
		t.Errorf("runner list -o csv: Status = %q, want the bare wire status %q", row[2], "ONLINE")
	}
	if row[4] != "true" {
		t.Errorf("runner list -o csv: Default = %q, want %q — the human cell is %q on one row and empty on every other", row[4], "true", ui.SymbolDefault)
	}
	mustParseCell(t, "runner list", "Last Heartbeat", row[5])

	empty := runnerRows([]api.Runner{{Name: "r2", Status: "OFFLINE"}}, ui.FormatCSV)[0]
	mustBeEmpty(t, "runner list", "Version", empty[3])
	if empty[4] != "false" {
		t.Errorf("runner list -o csv: a non-default runner = %q, want %q", empty[4], "false")
	}

	human := runnerRows([]api.Runner{{
		Name: "r1", Operator: "self", Provisioning: "hetzner", Status: "ONLINE", IsDefault: true,
	}}, ui.FormatTable)[0]
	if human[1] != "self·hetzner" {
		t.Errorf("runner list -o table: Operator = %q, want the joined label", human[1])
	}
	if human[4] != ui.SymbolDefault {
		t.Errorf("runner list -o table: Default = %q, want %q", human[4], ui.SymbolDefault)
	}
}

func TestHygCliCsv_ConnectorListDoesNotShoutTheProvider(t *testing.T) {
	row := cloudIdentityRows([]api.CloudIdentity{{
		Provider: "aws", Label: "prod", CreatedAt: csvProbeStamp,
	}}, ui.FormatCSV)[0]
	// This was the ONLY surface in the product spelling a provider `AWS`.
	if row[0] != "aws" {
		t.Errorf("connector list -o csv: Provider = %q, want the wire value %q — it is what `alethia connector aws` takes and what -o json marshals", row[0], "aws")
	}
	mustParseCell(t, "connector list", "Connected", row[2])

	human := cloudIdentityRows([]api.CloudIdentity{{Provider: "aws", CreatedAt: csvProbeStamp}}, ui.FormatTable)[0]
	if human[0] != "AWS" {
		t.Errorf("connector list -o table: Provider = %q, want the upper-cased label %q", human[0], "AWS")
	}
}

func TestHygCliCsv_ActivityKeepsTheWHOLEResourceID(t *testing.T) {
	const fullID = "4f3c1a92-7b8e-4d15-9c3a-0e2f6b1d8a47"
	row := activityRows([]api.ActivityEntry{{
		Ts: csvProbeStamp, ActorEmail: "ada@x.com", Action: "project.apply",
		ResourceType: "project", ResourceID: fullID, Decision: true,
	}}, ui.FormatCSV)[0]

	if len(row) != len(activityCSVColumns) {
		t.Fatalf("activity -o csv: %d cells against %d columns — the header and the row must agree", len(row), len(activityCSVColumns))
	}
	mustParseCell(t, "activity", "Time", row[0])
	if row[3] != "project" {
		t.Errorf("activity -o csv: Resource = %q, want the bare type", row[3])
	}
	// The defect this issue calls unrecoverable: eight characters and an ellipsis.
	if row[4] != fullID {
		t.Errorf("activity -o csv: Resource ID = %q, want the WHOLE id %q.\n"+
			"      TruncID cuts to 8 characters and appends U+2026; no parser recovers the rest.", row[4], fullID)
	}
	mustBeEmpty(t, "activity", "Reason", row[6])

	// The human table keeps six columns and the truncated, welded cell.
	human := activityRows([]api.ActivityEntry{{
		Ts: csvProbeStamp, ActorID: "u1", Action: "project.apply",
		ResourceType: "project", ResourceID: fullID, Decision: false, Reason: "denied by policy",
	}}, ui.FormatTable)[0]
	if len(human) != len(activityColumns) {
		t.Fatalf("activity -o table: %d cells against %d columns", len(human), len(activityColumns))
	}
	if !strings.HasPrefix(human[3], "project ") || !strings.Contains(human[3], "…") {
		t.Errorf("activity -o table: Resource = %q, want the type and the shortened id", human[3])
	}
	if got := activityColumnsFor(ui.FormatCSV); len(got) != len(activityColumns)+1 {
		t.Errorf("activityColumnsFor(csv) has %d columns, want one more than the human %d", len(got), len(activityColumns))
	}
}

func TestHygCliCsv_ProjectListEmitsTheWireProviderAndStatus(t *testing.T) {
	rows := projectRows([]types.ConfigurationSummary{{
		ProjectName: "web", CloudProvider: "aws", Region: "eu-central-1", Status: "ACTIVE",
	}}, ui.FormatCSV)[0]
	if rows[2] != "ACTIVE" {
		t.Errorf("project list -o csv: Status = %q, want the bare wire status — the human cell welds a glyph on and folds case", rows[2])
	}
	if rows[3] != "aws" {
		t.Errorf("project list -o csv: Provider = %q, want the wire value %q", rows[3], "aws")
	}

	// An unapplied project: the reader is told DRAFT, the script is told what arrived.
	draft := projectRows([]types.ConfigurationSummary{{ProjectName: "new"}}, ui.FormatCSV)[0]
	mustBeEmpty(t, "project list", "Status", draft[2])
	mustBeEmpty(t, "project list", "Provider", draft[3])
	mustBeEmpty(t, "project list", "Region", draft[4])

	human := projectRows([]types.ConfigurationSummary{{ProjectName: "new"}}, ui.FormatTable)[0]
	if !strings.Contains(human[2], "draft") {
		t.Errorf("project list -o table: Status = %q, want the DRAFT inference a reader needs", human[2])
	}
	if human[3] != ui.SymbolDash || human[4] != ui.SymbolDash {
		t.Errorf("project list -o table: Provider/Region = %q/%q, want the dash", human[3], human[4])
	}
}
