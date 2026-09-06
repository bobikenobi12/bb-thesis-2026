// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/pflag"
)

// The decisions the governance forms make BEFORE they open a widget: which destination question a
// channel type has, whether a draft still needs one, whether a severity is one the server would
// accept, and which dimension applies to which resource kind.
//
// All of it is reachable headlessly, which is the point of it being separate from the huh calls.

// ── channels create ───────────────────────────────────────────────────────────────────────────

// TestDestinationFor pins the type→question mapping against the GENERATED channel type set, not
// against a list typed here.
//
// The default arm is the one worth stating: six of the nine types are chat integrations that post
// to a URL, so a tenth added to the schema gets the URL question rather than falling into a
// nothing-branch — and the loop below proves every generated type resolves to a real destination
// rather than to whatever the zero value happens to be.
func TestDestinationFor(t *testing.T) {
	named := map[string]channelDestination{
		string(types.AlertChannelTypeEmail):      channelDestEmail,
		string(types.AlertChannelTypePagerduty):  channelDestRoutingKey,
		string(types.AlertChannelTypeWebhook):    channelDestURL,
		string(types.AlertChannelTypeSlack):      channelDestURL,
		string(types.AlertChannelTypeDiscord):    channelDestURL,
		string(types.AlertChannelTypeTeams):      channelDestURL,
		string(types.AlertChannelTypeMattermost): channelDestURL,
		string(types.AlertChannelTypeGooglechat): channelDestURL,
		string(types.AlertChannelTypeRocketchat): channelDestURL,
	}
	all := channelTypeNames()
	if len(all) == 0 {
		t.Fatal("no channel types — every assertion below is vacuous")
	}
	for _, ct := range all {
		want, ok := named[ct]
		if !ok {
			t.Errorf("channel type %q is in the schema and this test does not say which destination "+
				"it asks for — a new type must be decided, not defaulted silently", ct)
			continue
		}
		if got := destinationFor(ct); got != want {
			t.Errorf("destinationFor(%q) = %v, want %v", ct, got, want)
		}
	}
	// Case and whitespace: --type is typed by a person.
	if destinationFor("  EMAIL  ") != channelDestEmail {
		t.Error("destinationFor does not normalise the type it was handed")
	}
	// An unknown type takes the URL branch rather than erroring here, because the SERVER decides
	// what types exist; the CLI only decides which question to ask.
	if destinationFor("carrier-pigeon") != channelDestURL {
		t.Error("an unrecognised type must still resolve to a question")
	}
}

// TestChannelDraftCompleteness pins which drafts can be sent without asking anything.
//
// Each case names the destination the type needs, so a draft carrying the WRONG destination for
// its type is incomplete — the mismatch the old flag-only surface allowed through to the server.
func TestChannelDraftCompleteness(t *testing.T) {
	cases := []struct {
		name  string
		draft channelDraft
		want  bool
	}{
		{"nothing", channelDraft{}, false},
		{"no name", channelDraft{Type: "slack", URL: "https://x"}, false},
		{"no type", channelDraft{Name: "n", URL: "https://x"}, false},
		{"slack with url", channelDraft{Name: "n", Type: "slack", URL: "https://x"}, true},
		{"slack with only a routing key", channelDraft{Name: "n", Type: "slack", RoutingKey: "rk"}, false},
		{"email with recipients", channelDraft{Name: "n", Type: "email", Recipients: []string{"a@x"}}, true},
		{"email with only a url", channelDraft{Name: "n", Type: "email", URL: "https://x"}, false},
		{"email with an empty recipient list", channelDraft{Name: "n", Type: "email", Recipients: []string{}}, false},
		{"pagerduty with a routing key", channelDraft{Name: "n", Type: "pagerduty", RoutingKey: "rk"}, true},
		{"pagerduty with only a url", channelDraft{Name: "n", Type: "pagerduty", URL: "https://x"}, false},
		{"a whitespace name is no name", channelDraft{Name: "  ", Type: "slack", URL: "https://x"}, false},
		{"the signing secret is not a destination", channelDraft{Name: "n", Type: "slack", SigningSecret: "s"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.draft.complete(); got != tc.want {
				t.Errorf("complete() = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestChannelDraftMissingDestinationErrNamesTheRightFlag pins that the refusal names the ONE flag
// this type needs, not all three.
func TestChannelDraftMissingDestinationErrNamesTheRightFlag(t *testing.T) {
	cases := []struct {
		channelType string
		want        string
		notWanted   []string
	}{
		{"email", "--recipient", []string{"--url", "--routing-key"}},
		{"pagerduty", "--routing-key", []string{"--url", "--recipient"}},
		{"slack", "--url", []string{"--recipient", "--routing-key"}},
	}
	for _, tc := range cases {
		t.Run(tc.channelType, func(t *testing.T) {
			err := channelDraft{Type: tc.channelType}.missingDestinationErr()
			if err == nil {
				t.Fatal("a draft with no destination produced no error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("%v does not name %s", err, tc.want)
			}
			for _, other := range tc.notWanted {
				if strings.Contains(err.Error(), other) {
					t.Errorf("%v names %s, which this type does not take", err, other)
				}
			}
			if !strings.Contains(err.Error(), tc.channelType) {
				t.Errorf("%v does not name the type it is talking about", err)
			}
		})
	}
}

// TestErrChannelTypeRequiredNamesEveryType pins that the scripted refusal is as complete as the
// flag help, for the same reason: the reader of it is the person who does not know the set.
func TestErrChannelTypeRequiredNamesEveryType(t *testing.T) {
	names := channelTypeNames()
	if len(names) == 0 {
		t.Fatal("no channel types — this assertion is vacuous")
	}
	for _, name := range names {
		if !strings.Contains(errChannelTypeRequired.Error(), name) {
			t.Errorf("errChannelTypeRequired does not name %q: %v", name, errChannelTypeRequired)
		}
	}
}

// ── alerts create ─────────────────────────────────────────────────────────────────────────────

// TestCanonicalAlertSeverity pins the closed set, both directions.
//
// The accepted cases come from the generated slice rather than from literals, so a severity added
// to the schema is accepted here without anyone editing this test; the rejected cases are the
// shapes a person actually types.
// IT ASSERTS THE RETURNED VALUE, not just the absence of an error, and that is the whole point of
// #3825. The predecessor of this test called `validAlertSeverity`, which returned only an `error`,
// so it proved an uppercase severity was ACCEPTED and was structurally unable to see that the
// caller's spelling was then posted verbatim to a case-sensitive `z.enum` — a 400 naming no field,
// which is the outcome the validator existed to prevent. A matcher that folds case has to hand the
// canonical value back, or every caller is one line away from reintroducing the defect.
func TestCanonicalAlertSeverity(t *testing.T) {
	names := alertSeverityNames()
	if len(names) == 0 {
		t.Fatal("no severities — the accept half of this test is vacuous")
	}
	for _, name := range names {
		got, err := canonicalOneOf("severity", name, names)
		if err != nil {
			t.Errorf("canonicalOneOf(%q) = %v, want nil", name, err)
		}
		if got != name {
			t.Errorf("canonicalOneOf(%q) = %q, want it unchanged", name, got)
		}
		// THE REGRESSION. `--severity CRITICAL` must come back as `critical`, the wire spelling.
		//
		// Guarded per name, the way TestGovAnswered_AlertSeverityReachesTheDraftCanonical guards
		// its own: if `alert_severity` ever gains a value with no cased letters, `upper` is `name`,
		// the call below becomes textually identical to the one above, and BOTH assertions pass
		// while proving nothing about folding — which is exactly the structural blindness this
		// test was rewritten to remove.
		upper := strings.ToUpper(name)
		if upper == name {
			t.Fatalf("severity %q is already upper case — the fold half of this test is a no-op", name)
		}
		got, err = canonicalOneOf("severity", upper, names)
		if err != nil {
			t.Errorf("canonicalOneOf(%q) = %v — --severity is typed by a person", upper, err)
		}
		if got != name {
			t.Errorf("canonicalOneOf(%q) = %q, want the canonical %q — posting the caller's "+
				"spelling to the alert_severity enum is a 400 that names no field", upper, got, name)
		}
	}
	for _, bad := range []string{"", "warn", "CRITICAL!", "high", "info ", "0"} {
		_, err := canonicalOneOf("severity", bad, names)
		if err == nil {
			t.Errorf("canonicalOneOf(%q) accepted a value the alert_severity enum would refuse", bad)
			continue
		}
		for _, name := range names {
			if !strings.Contains(err.Error(), name) {
				t.Errorf("the refusal for %q does not name the legal value %q: %v", bad, name, err)
			}
		}
	}
}

// TestAlertDraftCompletenessAndMissingErr pins which drafts can be sent, and that the refusal
// names the FIRST thing missing rather than a generic one.
func TestAlertDraftCompletenessAndMissingErr(t *testing.T) {
	cases := []struct {
		name     string
		draft    alertDraft
		complete bool
		wantErr  error
	}{
		{"nothing", alertDraft{}, false, errAlertNameRequired},
		{"name only", alertDraft{Name: "r"}, false, errAlertEventRequired},
		{"name and events", alertDraft{Name: "r", Events: []string{"e"}}, false, errAlertChannelRequired},
		{"all three", alertDraft{Name: "r", Events: []string{"e"}, ChannelIDs: []string{"c"}}, true, nil},
		{"whitespace name", alertDraft{Name: " ", Events: []string{"e"}, ChannelIDs: []string{"c"}}, false, errAlertNameRequired},
		// Severity is deliberately NOT part of completeness: the flag carries a default, so an
		// unanswered severity is a decision the product already made rather than a missing value.
		{"no severity", alertDraft{Name: "r", Events: []string{"e"}, ChannelIDs: []string{"c"}}, true, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.draft.complete(); got != tc.complete {
				t.Errorf("complete() = %v, want %v", got, tc.complete)
			}
			if tc.wantErr == nil {
				return
			}
			if got := tc.draft.missingErr(); got != tc.wantErr {
				t.Errorf("missingErr() = %v, want %v", got, tc.wantErr)
			}
		})
	}
	if !strings.Contains(errAlertChannelRequired.Error(), "alethia channels list") {
		t.Errorf("the channel refusal does not name where to find one: %v", errAlertChannelRequired)
	}
	if !strings.Contains(errAlertChannelRequired.Error(), "name or id") {
		t.Errorf("the channel refusal does not say a NAME will do: %v", errAlertChannelRequired)
	}
}

// ── classification ────────────────────────────────────────────────────────────────────────────

// govTestDims is a taxonomy with one kind-scoped dimension and one that applies to everything.
func govTestDims() []api.ClassificationDimension {
	return []api.ClassificationDimension{
		{Key: "tier", Label: "Tier", AppliesTo: []string{"project_environment"},
			Values: []api.ClassificationValue{{Value: "gold", Label: "Gold"}, {Value: "silver", Label: "Silver"}}},
		{Key: "owner", Label: "Owner", Multi: true, AppliesTo: nil,
			Values: []api.ClassificationValue{{Value: "platform", Label: "Platform"}}},
	}
}

// TestDimensionsFor pins the offer filter: kind-scoped dimensions plus the unscoped ones.
//
// The unscoped arm is the one that would silently break the picker. `owner` has an EMPTY
// applies_to, which the taxonomy means as "every kind"; a filter that read it as "no kinds" would
// hide the org's most widely-applicable dimension from every picker and nothing would say so.
func TestDimensionsFor(t *testing.T) {
	dims := govTestDims()

	got := dimensionsFor(dims, "project_environment")
	if len(got) != 2 {
		t.Fatalf("got %d dimensions for project_environment, want tier and owner: %+v", len(got), got)
	}

	got = dimensionsFor(dims, "cluster")
	if len(got) != 1 || got[0].Key != "owner" {
		t.Errorf("a cluster should see only the unscoped dimension, got %+v", got)
	}

	if got := dimensionsFor(dims, "PROJECT_ENVIRONMENT"); len(got) != 2 {
		t.Errorf("the kind comparison is case-sensitive; got %+v", got)
	}
	if got := dimensionsFor(nil, "cluster"); len(got) != 0 {
		t.Errorf("an empty taxonomy offers nothing, got %+v", got)
	}
}

// TestFindDimension pins the resolution and, on a miss, that the refusal lists the real keys.
func TestFindDimension(t *testing.T) {
	dims := govTestDims()
	got, err := findDimension(dims, "tier")
	if err != nil || got.Key != "tier" {
		t.Fatalf("findDimension(tier) = %+v, %v", got, err)
	}
	if got, err := findDimension(dims, "TIER"); err != nil || got.Key != "tier" {
		t.Errorf("a dimension key typed in the wrong case did not resolve: %+v, %v", got, err)
	}
	_, err = findDimension(dims, "teir")
	if err == nil {
		t.Fatal("a misspelled dimension key resolved")
	}
	for _, want := range []string{"tier", "owner"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not name the real key %q: %v", want, err)
		}
	}
}

// TestDimensionSlugsAndAssignedSlugs pins the two slug lists the refusals and the pickers read.
func TestDimensionSlugsAndAssignedSlugs(t *testing.T) {
	slugs := dimensionSlugs(govTestDims()[0])
	if len(slugs) != 2 || slugs[0] != "gold" || slugs[1] != "silver" {
		t.Errorf("dimensionSlugs = %v, want the values in taxonomy order", slugs)
	}
	if got := dimensionSlugs(api.ClassificationDimension{}); len(got) != 0 {
		t.Errorf("a dimension with no values has no slugs, got %v", got)
	}

	assigned := assignedSlugs([]api.ClassificationAssignment{
		{DimensionKey: "tier", Value: "gold"}, {DimensionKey: "owner", Value: "platform"},
	})
	if len(assigned) != 2 || assigned[0] != "gold" || assigned[1] != "platform" {
		t.Errorf("assignedSlugs = %v, want the values in wire order", assigned)
	}
}

// ── fleet ─────────────────────────────────────────────────────────────────────────────────────

// TestFleetUpdateFlagNamesComesFromTheSpec pins that the "nothing to update" refusal names every
// update flag, derived rather than typed.
//
// It compares against the flags on the REAL command minus the ones that are not pool config, so a
// seventh update flag added to fleet set and to the spec reaches this message without anyone
// editing it — and one added to the command but NOT the spec fails here.
func TestFleetUpdateFlagNamesComesFromTheSpec(t *testing.T) {
	names := fleetUpdateFlagNames()
	if len(names) == 0 {
		t.Fatal("no update flags — the refusal would name nothing")
	}
	listed := map[string]bool{}
	for _, n := range names {
		if !strings.HasPrefix(n, "--") {
			t.Errorf("%q is not rendered as a flag", n)
		}
		listed[strings.TrimPrefix(n, "--")] = true
	}

	cmd, _, err := rootCmd.Find([]string{"fleet", "set"})
	if err != nil {
		t.Fatalf("no fleet set command: %v", err)
	}
	// Two flags are not pool config: `--yes` is the destructive opt-in, and `--help` is cobra's.
	// Everything else DECLARED ON THIS COMMAND must be in the message, or a user is told about a
	// subset of the flags that exist.
	//
	// Both exclusions below are load-bearing, and both were found by this test failing ONLY in the
	// full package run. cobra merges the root's persistent flags into a command's Flags(), and
	// installs `--help`, the first time the tree is Executed — so whether `--token`, `--output`,
	// `--no-input` and `--help` appear here depends on whether some EARLIER test in the package
	// ran a command. The assertion was order-dependent and passed when run alone, which is the
	// shape of a guard that reports green for a reason unrelated to its subject.
	compared := 0
	cmd.Flags().VisitAll(func(f *pflag.Flag) {
		if f.Name == "yes" || f.Name == "help" || cmd.InheritedFlags().Lookup(f.Name) != nil {
			return
		}
		compared++
		if !listed[f.Name] {
			t.Errorf("`fleet set` has --%s and the \"nothing to update\" refusal does not name it", f.Name)
		}
	})
	if compared == 0 {
		t.Fatal("no flag on `fleet set` was compared — this assertion is vacuous")
	}
	if compared != len(listed) {
		t.Errorf("the refusal names %d flag(s) and `fleet set` declares %d pool-config flag(s) — "+
			"the message describes a set the command does not have", len(listed), compared)
	}
}

// ── the shared render surface ─────────────────────────────────────────────────────────────────

// TestProbeRowsRenderThroughTheSharedSurface pins the cells that used to build the empty-value
// sentinel inline, and the timestamp that used to be the wire's raw string.
//
// The Probed assertion is on the RENDERED VALUE, not on "not empty": the change here is one a user
// sees, and an assertion that only checked for non-emptiness would have passed both before and
// after it.
func TestProbeRowsRenderThroughTheSharedSurface(t *testing.T) {
	up, down := true, false
	msg := "dial tcp: timeout"
	empty := ""
	ts := "2026-01-01T00:00:00.000Z"
	rows := probeRows([]api.ProbeState{
		{Environment: "production", Reachable: &up, ProbedAt: &ts},
		{Environment: "staging", Reachable: &down, Message: &msg, ProbedAt: &ts},
		{Environment: "dev"},
		{Environment: "qa", Reachable: &up, Message: &empty},
	}, ui.FormatTable)
	if len(rows) != 4 {
		t.Fatalf("got %d rows, want 4", len(rows))
	}
	if rows[0][2] != ui.SymbolDash {
		t.Errorf("an absent message renders %q, want the shared sentinel %q", rows[0][2], ui.SymbolDash)
	}
	if rows[3][2] != ui.SymbolDash {
		t.Errorf("an EMPTY message renders %q, want the shared sentinel — a message the server "+
			"sent as \"\" is as absent as one it did not send", rows[3][2])
	}
	if rows[1][2] != msg {
		t.Errorf("a real message was not carried through: %q", rows[1][2])
	}
	// `2 Jan 2006, 15:04` — format.DateTime, the ONE absolute-date rendering the CLI has
	// (packages/core/format/format.go:348). Asserted as the shared surface DEFINES it, not as
	// this table happens to print it: an expectation copied from observed output agrees with
	// whatever the code does and stops being a claim about anything.
	if want := "1 Jan 2026, 00:00"; rows[0][3] != want {
		t.Errorf("Probed renders %q, want %q — the raw RFC 3339 string is the wire's, not the "+
			"table's", rows[0][3], want)
	}
	if rows[2][3] != ui.SymbolDash {
		t.Errorf("a never-probed environment renders %q for Probed, want the sentinel", rows[2][3])
	}
	if !strings.Contains(rows[2][1], "never probed") {
		t.Errorf("a never-probed environment must SAY so, got %q", rows[2][1])
	}
}

// TestActivityRowsRenderTheReasonThroughTheSharedSurface pins the one cell activity built inline.
//
// The Reason column is the point of a deny row, so an entry that carries none must render the same
// sentinel every other empty cell in the CLI renders, not a blank that reads as a truncated table.
func TestActivityRowsRenderTheReasonThroughTheSharedSurface(t *testing.T) {
	rows := activityRows([]api.ActivityEntry{
		{Ts: "2026-01-01T00:00:00Z", ActorEmail: "ada@x.com", Action: "project.apply",
			ResourceType: "project", ResourceID: "p1", Decision: true},
		{Ts: "2026-01-01T00:00:00Z", ActorID: "u2", Action: "project.destroy",
			ResourceType: "project", Decision: false, Reason: "denied by policy"},
	}, ui.FormatTable)
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[0][5] != ui.SymbolDash {
		t.Errorf("an empty reason renders %q, want the shared sentinel %q", rows[0][5], ui.SymbolDash)
	}
	if rows[1][5] != "denied by policy" {
		t.Errorf("a real reason was not carried through: %q", rows[1][5])
	}
	if rows[0][4] != "allow" || rows[1][4] != "deny" {
		t.Errorf("decision rendered as %q/%q, want allow/deny", rows[0][4], rows[1][4])
	}
	// The actor falls back to the id when there is no email — an activity row with a blank actor
	// is the one row nobody can act on.
	if rows[1][1] != "u2" {
		t.Errorf("actor fell back to %q, want the actor id", rows[1][1])
	}
}

// TestDimensionRowsRenderValuesThroughTheSharedSurface pins the dimensions table's value cell.
func TestDimensionRowsRenderValuesThroughTheSharedSurface(t *testing.T) {
	rows := dimensionRows([]api.ClassificationDimension{
		{Key: "tier", Label: "Tier", AppliesTo: []string{"project_environment"},
			Values: []api.ClassificationValue{{Value: "gold"}, {Value: "silver"}}},
		{Key: "owner", Label: "Owner", Multi: true},
	}, ui.FormatTable)
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[0][4] != "gold, silver" {
		t.Errorf("value slugs render as %q — `assign` takes a slug, so they must be discoverable "+
			"here rather than counted", rows[0][4])
	}
	if rows[1][4] != ui.SymbolDash {
		t.Errorf("a dimension with no values renders %q, want the shared sentinel", rows[1][4])
	}
	if rows[0][2] != "single" || rows[1][2] != "multi" {
		t.Errorf("mode rendered as %q/%q, want single/multi", rows[0][2], rows[1][2])
	}
	if rows[1][3] != "all resources" {
		t.Errorf("an unscoped dimension renders %q for Applies to, want \"all resources\"", rows[1][3])
	}
}

// TestResolveFleetProviderNormalisesTheArgument pins that a provider typed in any case reaches the
// server the way the wire spells it.
func TestResolveFleetProviderNormalisesTheArgument(t *testing.T) {
	for _, in := range []string{"AWS", "  aws  ", "aws"} {
		got, err := resolveFleetProvider([]string{in})
		if err != nil {
			t.Fatalf("resolveFleetProvider(%q) = %v", in, err)
		}
		if got != "aws" {
			t.Errorf("resolveFleetProvider(%q) = %q, want %q", in, got, "aws")
		}
	}
	// Nothing is refused on the closed set: which clouds a deployment's fleet controller serves is
	// the server's answer. A cloud outside the enum must still be forwarded.
	if got, err := resolveFleetProvider([]string{"oracle"}); err != nil || got != "oracle" {
		t.Errorf("an unrecognised provider must be forwarded to the server, got %q, %v", got, err)
	}
}

// TestResolveFleetProviderRefusalNamesEveryCloud pins the scripted arm: with nowhere to ask, the
// refusal offers the whole generated set.
func TestResolveFleetProviderRefusalNamesEveryCloud(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	_, err := resolveFleetProvider(nil)
	if err == nil {
		t.Fatal("a missing provider under --no-input resolved to one")
	}
	names := cloudProviderNames()
	if len(names) == 0 {
		t.Fatal("no providers — this assertion is vacuous")
	}
	for _, name := range names {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("the refusal does not offer %q: %v", name, err)
		}
	}
}
