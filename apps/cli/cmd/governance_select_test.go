// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// The "which record?" resolver, driven directly.
//
// Every arm below is reachable without a terminal, which is why they are here rather than folded
// into the cobra-level coverage tests: the picker is the ONE arm that needs a TTY, and everything
// this file asserts is a decision the CLI makes before it would open one.

// govSelectFixture is the record set every case resolves against.
//
// The shapes are deliberate and each one is load-bearing somewhere below: two channels whose ids
// share a prefix, two channels with the same NAME in different cases, and one record whose name is
// a prefix of another's.
func govSelectFixture() []govRef {
	return []govRef{
		{ID: "3f1c8a2b", Name: "Ops Slack", Label: "Ops Slack · slack · verified · 3f1c8a2b"},
		{ID: "3f1c9d4e", Name: "Ops Email", Label: "Ops Email · email · unverified · 3f1c9d4e"},
		{ID: "aa0011bb", Name: "On-call", Label: "On-call · pagerduty · verified · aa0011bb"},
	}
}

var govSelectSpecForTest = govSelectSpec{
	Noun:    "channel",
	Title:   "Select Channel",
	Desc:    "…",
	ListCmd: "alethia channels list",
}

// TestResolveGovRef_ResolvesByIdNameAndPrefix drives the three ways a caller can name a record.
//
// The assertions are on the RESOLVED ID, never on "no error": a matcher that returned the wrong
// record would satisfy an error-only assertion for every case in the table.
func TestResolveGovRef_ResolvesByIdNameAndPrefix(t *testing.T) {
	cases := []struct {
		name  string
		query string
		want  string
	}{
		{"exact id", "3f1c8a2b", "3f1c8a2b"},
		{"exact name", "Ops Slack", "3f1c8a2b"},
		{"name, different case", "ops slack", "3f1c8a2b"},
		{"id, different case", "3F1C8A2B", "3f1c8a2b"},
		{"unambiguous id prefix", "3f1c8", "3f1c8a2b"},
		{"unambiguous name prefix", "On-c", "aa0011bb"},
		// "Ops Slack" is an exact NAME and also a prefix of nothing else; the point of this case
		// is the tier ORDER — an exact match must be taken before the prefix tier is consulted at
		// all, or "Ops Slack" would collide with "Ops Email" at the prefix tier and be reported
		// as ambiguous.
		{"exact name wins over the prefix tier", "Ops Slack", "3f1c8a2b"},
		{"surrounding whitespace is not part of the query", "  On-call  ", "aa0011bb"},
	}
	refs := govSelectFixture()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveGovRef(govSelectSpecForTest, refs, []string{tc.query})
			if err != nil {
				t.Fatalf("resolveGovRef(%q) = error %v", tc.query, err)
			}
			if got.ID != tc.want {
				t.Errorf("resolveGovRef(%q) resolved to %q, want %q", tc.query, got.ID, tc.want)
			}
		})
	}
}

// TestResolveGovRef_AmbiguityIsRefusedAndNamesTheCandidates pins the arm that matters most for a
// destructive command: two records match, so NOTHING is chosen.
//
// It asserts the candidates are NAMED. A bare "ambiguous" would leave the operator running the
// list command to find out which two — and the whole reason the prefix tier exists is to save
// them that round trip.
func TestResolveGovRef_AmbiguityIsRefusedAndNamesTheCandidates(t *testing.T) {
	refs := govSelectFixture()
	_, err := resolveGovRef(govSelectSpecForTest, refs, []string{"3f1c"})
	if err == nil {
		t.Fatal("a prefix matching two records resolved to one of them")
	}
	for _, want := range []string{"Ops Slack", "Ops Email"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not name candidate %q: %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "On-call") {
		t.Errorf("the refusal names a record the query does not match: %v", err)
	}
}

// TestResolveGovRef_ARealNameThatPrefixesAnotherStillResolves is the case the tier order exists
// for, stated on its own because it is the one that would silently regress into an ambiguity.
func TestResolveGovRef_ARealNameThatPrefixesAnotherStillResolves(t *testing.T) {
	refs := []govRef{
		{ID: "i1", Name: "prod", Label: "prod"},
		{ID: "i2", Name: "production", Label: "production"},
	}
	got, err := resolveGovRef(govSelectSpecForTest, refs, []string{"prod"})
	if err != nil {
		t.Fatalf("an exact name that prefixes another name must still resolve: %v", err)
	}
	if got.ID != "i1" {
		t.Errorf("resolved to %q, want the exactly-named record i1", got.ID)
	}
}

// TestResolveGovRef_NoMatchNamesTheListCommand pins that a miss points somewhere.
func TestResolveGovRef_NoMatchNamesTheListCommand(t *testing.T) {
	_, err := resolveGovRef(govSelectSpecForTest, govSelectFixture(), []string{"nope"})
	if err == nil {
		t.Fatal("a query matching nothing resolved to something")
	}
	if !strings.Contains(err.Error(), "alethia channels list") {
		t.Errorf("the refusal does not name the list command: %v", err)
	}
	if !strings.Contains(err.Error(), `"nope"`) {
		t.Errorf("the refusal does not quote what was asked for: %v", err)
	}
}

// TestResolveGovRef_AnEmptySetIsAnsweredBeforeThePicker pins that a zero census never opens a
// form.
//
// An empty huh.Select renders as a box with nothing in it that the user has to escape out of, and
// the answer — "there are none" — is known before the question is asked. The assertion runs with
// prompting ENABLED so that reaching requireInteractiveForm would be a different error, and the
// message is checked so that "no channel exists" cannot be satisfied by the generic no-input
// refusal.
func TestResolveGovRef_AnEmptySetIsAnsweredBeforeThePicker(t *testing.T) {
	hygCliConfirmSetNoInput(t, false)
	_, err := resolveGovRef(govSelectSpecForTest, nil, nil)
	if err == nil {
		t.Fatal("an empty record set resolved to a record")
	}
	if !strings.Contains(err.Error(), "no channel exists") {
		t.Errorf("an empty set must be reported as an empty set, got: %v", err)
	}
	if !strings.Contains(err.Error(), "alethia channels list") {
		t.Errorf("the refusal does not name the list command: %v", err)
	}
}

// TestResolveGovRef_NoSelectorUnderNoInputIsRefused pins the scripted arm: nothing to resolve
// from, and nowhere to ask.
//
// The refusal must name the NOUN and the list command. Before this resolver the same situation
// produced huh's raw "could not open a new TTY: open /dev/tty: device not configured" — a message
// about a device file, for a user whose actual mistake was omitting an argument.
func TestResolveGovRef_NoSelectorUnderNoInputIsRefused(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	_, err := resolveGovRef(govSelectSpecForTest, govSelectFixture(), nil)
	if err == nil {
		t.Fatal("a missing selector under --no-input resolved to a record")
	}
	for _, want := range []string{"no channel given", "alethia channels list"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not carry %q: %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "/dev/tty") {
		t.Errorf("the refusal leaked huh's TTY error: %v", err)
	}
}

// TestResolveGovRef_AnEmptyArgumentIsNoArgument pins that `--` shell expansion producing an empty
// string is treated as "not given" rather than as a query that matches nothing.
//
// A caller who wrote `alethia channels delete "$CHANNEL"` with CHANNEL unset would otherwise be
// told no channel matches "", which is true and useless.
func TestResolveGovRef_AnEmptyArgumentIsNoArgument(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	_, err := resolveGovRef(govSelectSpecForTest, govSelectFixture(), []string{"   "})
	if err == nil {
		t.Fatal("an empty argument resolved to a record")
	}
	if !strings.Contains(err.Error(), "no channel given") {
		t.Errorf("a blank argument must be read as no argument, got: %v", err)
	}
}

// ── the record converters ─────────────────────────────────────────────────────────────────────

// TestGovRefsFromChannels pins what the picker shows and what the matcher can match on.
func TestGovRefsFromChannels(t *testing.T) {
	refs := govRefsFromChannels([]api.Channel{
		{ID: "3f1c8a2bdeadbeef", Name: "Ops Slack", Type: "slack", IsVerified: true},
		{ID: "aa0011bb", Name: "On-call", Type: "pagerduty"},
	})
	if len(refs) != 2 {
		t.Fatalf("got %d refs, want 2", len(refs))
	}
	if refs[0].ID != "3f1c8a2bdeadbeef" || refs[0].Name != "Ops Slack" {
		t.Errorf("the id and name a caller can match on were not carried: %+v", refs[0])
	}
	for _, want := range []string{"Ops Slack", "slack", "verified", "3f1c8a2b…"} {
		if !strings.Contains(refs[0].Label, want) {
			t.Errorf("label %q is missing %q", refs[0].Label, want)
		}
	}
	// "unverified", not the absence of "verified" — a channel that has never been verified must
	// SAY so, because verifying it is the next thing the operator does.
	if !strings.Contains(refs[1].Label, "unverified") {
		t.Errorf("an unverified channel does not say so: %q", refs[1].Label)
	}
}

// TestGovRefsFromAlertRules pins the rule label's counts, which are what distinguish two rules
// with similar names.
func TestGovRefsFromAlertRules(t *testing.T) {
	refs := govRefsFromAlertRules([]api.AlertRule{{
		ID: "a1b2c3d4", Name: "Job failures", Severity: "critical",
		EventPatterns: []string{"system.job.failed", "system.job.timeout"},
		ChannelIDs:    []string{"ch1"},
	}})
	if len(refs) != 1 {
		t.Fatalf("got %d refs, want 1", len(refs))
	}
	for _, want := range []string{"Job failures", "critical", "2 event(s)", "1 channel(s)"} {
		if !strings.Contains(refs[0].Label, want) {
			t.Errorf("label %q is missing %q", refs[0].Label, want)
		}
	}
}

// TestGovRefsFromPromotions pins the deliberate absence: a promotion has NO name, so the name tier
// must never fire for one.
//
// Without this, filling Name with something plausible like "staging → production" would look like
// an improvement and would make `promotion get "staging → production"` resolve to whichever of a
// project's promotions between those two environments happened to be listed first — or, once there
// were two, to nothing at all.
func TestGovRefsFromPromotions(t *testing.T) {
	refs := govRefsFromPromotions([]api.Promotion{
		{ID: "pr1", Source: "staging", Target: "production", Status: "PENDING", CreatedAt: "2026-01-01T00:00:00Z"},
		{ID: "pr2", Source: "staging", Target: "production", Status: "SUCCEEDED", CreatedAt: "2026-01-01T00:00:00Z"},
	})
	for i, r := range refs {
		if r.Name != "" {
			t.Errorf("ref %d carries a name %q; a promotion has none and the name tier must not fire", i, r.Name)
		}
	}
	if !strings.Contains(refs[0].Label, "staging") || !strings.Contains(refs[0].Label, "production") {
		t.Errorf("label %q does not name both endpoints", refs[0].Label)
	}
	if !strings.Contains(refs[0].Label, "PENDING") {
		t.Errorf("label %q does not carry the status", refs[0].Label)
	}
	// The two differ only by id and status, which is exactly the pair a name tier would have
	// conflated. Resolution between them must still work, by id.
	got, err := resolveGovRef(promotionSelect, refs, []string{"pr2"})
	if err != nil || got.ID != "pr2" {
		t.Errorf("resolving between two same-endpoint promotions by id: got %q, err %v", got.ID, err)
	}
}

// TestGovBullet pins that an absent part does not render a bullet with nothing beside it.
func TestGovBullet(t *testing.T) {
	if got := govBullet("a", "", "b"); got == "" || strings.Contains(got, "  ") {
		t.Errorf("govBullet dropped the wrong thing: %q", got)
	}
	if got := govBullet("a", "b"); govBullet("a", "", "b") != got {
		t.Errorf("an empty part changed the rendering: %q vs %q", govBullet("a", "", "b"), got)
	}
	if got := govBullet("", "  ", "\t"); got != "" {
		t.Errorf("all-empty parts should render nothing, got %q", got)
	}
}

// ── splitList ─────────────────────────────────────────────────────────────────────────────────

// TestSplitList pins the separators a person actually reaches for in a form answer, and the empty
// entries a trailing separator would otherwise produce.
func TestSplitList(t *testing.T) {
	cases := map[string][]string{
		"a@x.com,b@x.com":   {"a@x.com", "b@x.com"},
		"a@x.com, b@x.com":  {"a@x.com", "b@x.com"},
		"a@x.com b@x.com":   {"a@x.com", "b@x.com"},
		"a@x.com;b@x.com":   {"a@x.com", "b@x.com"},
		"a@x.com,":          {"a@x.com"},
		",,a@x.com,,":       {"a@x.com"},
		"  a@x.com  ":       {"a@x.com"},
		"":                  nil,
		"   ":               nil,
		"a@x.com\nb@x.com":  {"a@x.com", "b@x.com"},
		"system.job.failed": {"system.job.failed"},
	}
	for input, want := range cases {
		got := splitList(input)
		if len(got) != len(want) {
			t.Errorf("splitList(%q) = %v, want %v", input, got, want)
			continue
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("splitList(%q)[%d] = %q, want %q", input, i, got[i], want[i])
			}
		}
	}
}
