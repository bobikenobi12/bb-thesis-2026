// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"net/http"
	"testing"
)

// The regression these pin is `canonicalOneOf` folding case and then the CALLER posting the
// caller's own spelling anyway (#3825). The client-side gate passes, the server answers a bare
// "Invalid request body" naming no field, and the operator is told nothing about which flag was
// wrong — the exact outcome the validator exists to prevent.
//
// Why the whole cobra tree and the request BODY, rather than a unit test of `canonicalOneOf`:
// `canonicalOneOf` returning the canonical value is necessary but not sufficient. The defect is
// one step later — the command discarding that return and passing the original variable to the
// API client. Nothing but the bytes on the wire can tell those two apart, and every other
// channels/grants case in this package passes an already-lowercase value, so folding is a no-op
// in all of them and reverting either call site leaves them green.
//
// Each test therefore asserts BOTH directions: the canonical spelling is present AND the caller's
// spelling is absent. The positive alone would still pass a body that carried both (a payload
// built from two sources), and the negative alone would pass a request that never happened.

// TestEnumCanonical_ChannelsCreateSendsTheCanonicalType drives `channels create --type SlAcK` and
// requires `"type":"slack"` on the wire. `alert_channel_type` is a case-sensitive `z.enum` on
// `POST /api/cli/channels`, so the caller's spelling is a 400.
func TestEnumCanonical_ChannelsCreateSendsTheCanonicalType(t *testing.T) {
	s, run := hygCliConfirmEnv(t)

	if code := run("channels", "create", "ops", "--type", "SlAcK", "--url", "https://hooks.example.com/1"); code != 0 {
		t.Fatalf("exit code = %d, want 0 — the enum holds this value under another case", code)
	}
	if !s.saw(http.MethodPost, "/api/cli/channels") {
		t.Fatalf("the create never reached the control plane; mutations = %v", s.mutations())
	}
	if !s.sentBody(`"type":"slack"`) {
		t.Error("the create did not send the enum's own spelling of --type")
	}
	if s.sentBody(`"type":"SlAcK"`) {
		t.Error("the create posted the caller's spelling of --type, which the server's z.enum refuses")
	}
}

// TestEnumCanonical_GrantsAddSendsTheCanonicalPrincipalTypeAndEffect is the same contract on the
// two closed sets `grants add` validates. Both flags are passed folded, and both are checked,
// because they are canonicalised through separate calls and reverting either one alone is a
// defect this suite must catch.
//
// The principal and the role are given as UUIDs on purpose: `resolveByNameOrID` short-circuits on
// a value that already looks like an id, so the command reaches the POST without needing a member
// or role listing from the fake control plane.
func TestEnumCanonical_GrantsAddSendsTheCanonicalPrincipalTypeAndEffect(t *testing.T) {
	s, run := hygCliConfirmEnv(t)

	code := run("grants", "add",
		"--principal", "11111111-1111-4111-8111-111111111111",
		"--role", "33333333-3333-4333-8333-333333333333",
		"--principal-type", "USER",
		"--effect", "DENY",
	)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0 — both enums hold these values under another case", code)
	}
	if !s.saw(http.MethodPost, "/api/cli/grants") {
		t.Fatalf("the grant never reached the control plane; mutations = %v", s.mutations())
	}
	if !s.sentBody(`"principal_type":"user"`) {
		t.Error("the grant did not send the enum's own spelling of --principal-type")
	}
	if s.sentBody(`"principal_type":"USER"`) {
		t.Error("the grant posted the caller's spelling of --principal-type, which the server's z.enum refuses")
	}
	if !s.sentBody(`"effect":"deny"`) {
		t.Error("the grant did not send the enum's own spelling of --effect")
	}
	if s.sentBody(`"effect":"DENY"`) {
		t.Error("the grant posted the caller's spelling of --effect, which the server's z.enum refuses")
	}
}

// TestEnumCanonical_AlertsCreateSendsTheCanonicalSeverity is the third instance of the same
// defect, and the one #3825 left. `alert_severity` is a case-sensitive `z.enum` on
// `POST /api/cli/alerts`.
//
// THE EXIT CODE IS DELIBERATELY IGNORED. The fake control plane answers this route with the
// default `{"ok": true}`, which carries no rule record, so the command takes its recordless-success
// arm and exits 1 (see TestGovCmd_AlertsCreateRecordlessSuccessIsReportedNotDereferenced). An
// `code != 0` guard copied from the two tests above would fail here for a reason that has nothing
// to do with the enum — and, worse, a `code == 0` one would pass for the wrong reason. What this
// suite is about is the bytes, so `s.saw` establishes the request happened and the body assertions
// do the rest.
//
// Without this, `alerts.go`'s `runAlertsCreate(..., draft.Severity)` can go back to the package
// global `alertSeverity` — which still holds the operator's spelling, because nothing normalises
// it in place — and every other test in this package stays green: the helper test covers
// `canonicalOneOf` only, the call-site test covers the DRAFT only, and
// `TestGovCmd_AlertsCreateNamesItsChannel` already types `--severity critical`, so folding is a
// no-op there.
func TestEnumCanonical_AlertsCreateSendsTheCanonicalSeverity(t *testing.T) {
	s, run := hygCliConfirmEnv(t)

	_ = run("alerts", "create", "Job failures",
		"--event", "system.job.failed", "--channel", "ops", "--severity", "CrItIcAl")

	if !s.saw(http.MethodPost, "/api/cli/alerts") {
		t.Fatalf("the create never reached the control plane; mutations = %v", s.mutations())
	}
	if !s.sentBody(`"severity":"critical"`) {
		t.Error("the create did not send the enum's own spelling of --severity")
	}
	if s.sentBody(`"severity":"CrItIcAl"`) {
		t.Error("the create posted the caller's spelling of --severity, which the server's z.enum refuses")
	}
}
