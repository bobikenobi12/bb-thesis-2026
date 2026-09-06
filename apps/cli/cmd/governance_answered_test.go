// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
)

// The governance forms, ANSWERED.
//
// The established seam in this package stubs runHuhForm to return nil, which stops the prompt
// blocking but cannot ANSWER it: the value is written through a pointer the huh group owns and
// never exposes, so the answered branch of every form is unreachable and a test can only assert
// what happens when the user abandons the prompt. That is how a form can be wired to the wrong
// variable and stay green — a channel-create form that wrote the type into the URL field would
// pass every abort-path assertion in this package.
//
// authFormAnswer (hyg_cli_authform_test.go) drives the REAL widgets the production code built,
// with real key messages, and reads what lands in the bound variables. It is REUSED rather than
// re-implemented: a second pump with its own idea of how huh transitions focus would be a second
// opinion about what "the user pressed enter" means, and the two could disagree while both looked
// green.
//
// Every identifier here carries the govAnswered prefix.

// govAnsweredTTY makes both stdin and stdout look like terminals and enables prompting, so
// requireInteractiveForm lets the form open at all.
func govAnsweredTTY(t *testing.T) {
	t.Helper()
	prevIn, prevOut, prevNoInput := stdinIsTTY, stdoutIsTTY, noInputMode
	stdinIsTTY = func() bool { return true }
	stdoutIsTTY = func() bool { return true }
	noInputMode = false
	t.Cleanup(func() {
		stdinIsTTY, stdoutIsTTY, noInputMode = prevIn, prevOut, prevNoInput
	})
}

// govAnsweredChannels is the org's channels for the tests below.
func govAnsweredChannels() []api.Channel {
	return []api.Channel{
		{ID: "ch1", Name: "Ops Slack", Type: "slack", IsVerified: true, Enabled: true},
		{ID: "ch2", Name: "On-call", Type: "pagerduty", Enabled: true},
	}
}

// govAnsweredResetChannelFlags restores the channel-create flag globals, which the resolver reads.
func govAnsweredResetChannelFlags(t *testing.T) {
	t.Helper()
	pt, pr, pu, ps, pk := channelType, channelRecipients, channelURL, channelSigningSecret, channelRoutingKey
	t.Cleanup(func() {
		channelType, channelRecipients, channelURL, channelSigningSecret, channelRoutingKey = pt, pr, pu, ps, pk
	})
	channelType, channelRecipients, channelURL, channelSigningSecret, channelRoutingKey = "", nil, "", "", ""
}

// ── channels create ───────────────────────────────────────────────────────────────────────────

// TestGovAnswered_ChannelCreateFormFillsTheDraft drives the whole create form and asserts on the
// DRAFT, which is what reaches the wire.
//
// The type is chosen by moving DOWN the select, so the assertion distinguishes "the select is
// bound to Type" from "Type happened to hold the first option" — huh binds a Select to its first
// option when the group is built, so an unmoved select proves nothing about the binding.
func TestGovAnswered_ChannelCreateFormFillsTheDraft(t *testing.T) {
	govAnsweredTTY(t)
	govAnsweredResetChannelFlags(t)

	// Form 1: the name, then the type select moved down once (webhook → email).
	// Form 2: the destination question the chosen type has.
	name := authFormType("On-call mail")
	name = authFormKey(name, tea.KeyEnter, tea.KeyDown, tea.KeyEnter)
	recipients := authFormType("sre@example.com, lead@example.com")
	recipients = authFormKey(recipients, tea.KeyEnter)
	scripts := authFormAnswer(t,
		&authFormScript{keys: name},
		&authFormScript{keys: recipients},
	)

	draft, err := resolveChannelDraft(nil)
	if err != nil {
		t.Fatalf("resolveChannelDraft: %v", err)
	}
	for i, s := range scripts {
		if !s.ran {
			t.Errorf("form #%d never opened", i+1)
		}
	}
	if draft.Name != "On-call mail" {
		t.Errorf("Name = %q, want the typed name", draft.Name)
	}
	if draft.Type != "email" {
		t.Errorf("Type = %q, want the SECOND option (email) — a select left on its first option "+
			"would also read as bound", draft.Type)
	}
	if len(draft.Recipients) != 2 || draft.Recipients[0] != "sre@example.com" {
		t.Errorf("Recipients = %v, want both addresses split out of one answer", draft.Recipients)
	}
	// The destination question asked was the EMAIL one. A form that had asked for a URL would
	// leave URL set and Recipients empty, and the create would be refused by the server.
	if draft.URL != "" || draft.RoutingKey != "" {
		t.Errorf("an email channel picked up a non-email destination: %+v", draft)
	}
	if _, ok := draft.config()["recipients"]; !ok {
		t.Errorf("the payload carries no recipients: %v", draft.config())
	}
}

// TestGovAnswered_ChannelCreateAsksOnlyForWhatIsMissing pins that flags already given are not
// asked about again.
//
// One script, not two: with the type and the URL on the command line only the NAME is missing, so
// exactly one form may open. authFormAnswer errors when a command opens more forms than were
// scripted, which is what turns "asked an extra question" into a failure.
func TestGovAnswered_ChannelCreateAsksOnlyForWhatIsMissing(t *testing.T) {
	govAnsweredTTY(t)
	govAnsweredResetChannelFlags(t)
	channelType = "slack"
	channelURL = "https://hooks.slack.com/services/XXX"

	keys := authFormKey(authFormType("Ops Slack"), tea.KeyEnter)
	scripts := authFormAnswer(t, &authFormScript{keys: keys})

	draft, err := resolveChannelDraft(nil)
	if err != nil {
		t.Fatalf("resolveChannelDraft: %v", err)
	}
	if !scripts[0].ran {
		t.Error("the name question never opened")
	}
	if draft.Name != "Ops Slack" || draft.Type != "slack" {
		t.Errorf("draft = %+v, want the typed name and the flagged type", draft)
	}
	if draft.URL != "https://hooks.slack.com/services/XXX" {
		t.Errorf("the flagged URL was lost: %+v", draft)
	}
}

// TestGovAnswered_ChannelCreateNameFromThePositionalOpensNoNameQuestion pins the positional half
// of the same contract.
func TestGovAnswered_ChannelCreateNameFromThePositionalOpensNoNameQuestion(t *testing.T) {
	govAnsweredTTY(t)
	govAnsweredResetChannelFlags(t)
	channelType = "pagerduty"

	keys := authFormKey(authFormType("R0UT1NGKEY"), tea.KeyEnter)
	authFormAnswer(t, &authFormScript{keys: keys})

	draft, err := resolveChannelDraft([]string{"PD"})
	if err != nil {
		t.Fatalf("resolveChannelDraft: %v", err)
	}
	if draft.Name != "PD" {
		t.Errorf("Name = %q, want the positional", draft.Name)
	}
	if draft.RoutingKey != "R0UT1NGKEY" {
		t.Errorf("a pagerduty channel was not asked for a routing key: %+v", draft)
	}
}

// TestGovAnswered_ChannelCreateWebhookAsksForAURL pins the third destination arm.
func TestGovAnswered_ChannelCreateWebhookAsksForAURL(t *testing.T) {
	govAnsweredTTY(t)
	govAnsweredResetChannelFlags(t)
	channelType = "discord"

	keys := authFormKey(authFormType("https://discord.example/hook"), tea.KeyEnter)
	authFormAnswer(t, &authFormScript{keys: keys})

	draft, err := resolveChannelDraft([]string{"Chat"})
	if err != nil {
		t.Fatalf("resolveChannelDraft: %v", err)
	}
	if draft.URL != "https://discord.example/hook" {
		t.Errorf("a discord channel was not asked for a URL: %+v", draft)
	}
}

// TestGovAnswered_ChannelCreateScriptedNamesTheMissingValue pins the three --no-input refusals,
// each naming the one thing that is missing.
func TestGovAnswered_ChannelCreateScriptedNamesTheMissingValue(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	govAnsweredResetChannelFlags(t)

	if _, err := resolveChannelDraft(nil); err != errChannelNameRequired {
		t.Errorf("no name scripted: got %v, want errChannelNameRequired", err)
	}
	if _, err := resolveChannelDraft([]string{"n"}); err != errChannelTypeRequired {
		t.Errorf("no type scripted: got %v, want errChannelTypeRequired", err)
	}
	channelType = "email"
	_, err := resolveChannelDraft([]string{"n"})
	if err == nil || !strings.Contains(err.Error(), "--recipient") {
		t.Errorf("no destination scripted: got %v, want the email destination refusal", err)
	}
}

// TestGovAnswered_ChannelCreateFullyFlaggedAsksNothing pins that a complete command line opens no
// form at all — the scripted path must not depend on a terminal.
func TestGovAnswered_ChannelCreateFullyFlaggedAsksNothing(t *testing.T) {
	govAnsweredTTY(t)
	govAnsweredResetChannelFlags(t)
	channelType = "slack"
	channelURL = "https://x/y"
	channelSigningSecret = "s3cr3t"

	// No scripts: authFormAnswer reports any form that opens.
	authFormAnswer(t)

	draft, err := resolveChannelDraft([]string{"Ops"})
	if err != nil {
		t.Fatalf("resolveChannelDraft: %v", err)
	}
	if draft.config()["signing_secret"] != "s3cr3t" {
		t.Errorf("the signing secret did not reach the payload: %v", draft.config())
	}
}

// ── alerts create ─────────────────────────────────────────────────────────────────────────────

// govAnsweredResetAlertFlags restores the alert-create flag globals.
func govAnsweredResetAlertFlags(t *testing.T) {
	t.Helper()
	pe, pc, ps := alertEventPatterns, alertChannelRefs, alertSeverity
	t.Cleanup(func() { alertEventPatterns, alertChannelRefs, alertSeverity = pe, pc, ps })
	alertEventPatterns, alertChannelRefs, alertSeverity = nil, nil, "warning"
}

// TestGovAnswered_AlertCreateFormFillsTheDraft drives all four questions, including the
// multi-select over the org's channels.
//
// The multi-select is toggled with a SPACE on the second option, so the assertion distinguishes
// "bound to the selection" from "took the first channel": a MultiSelect starts with nothing
// selected, and a form wired to the wrong variable would come back empty rather than with ch2.
func TestGovAnswered_AlertCreateFormFillsTheDraft(t *testing.T) {
	govAnsweredTTY(t)
	govAnsweredResetAlertFlags(t)
	c := &fakeClient{channels: govAnsweredChannels()}

	keys := authFormType("Job failures")
	keys = authFormKey(keys, tea.KeyEnter)
	keys = append(keys, authFormType("system.job.failed, authz.*.denied")...)
	keys = authFormKey(keys, tea.KeyEnter)
	// The multi-select: move to the second channel, toggle it, move on.
	keys = authFormKey(keys, tea.KeyDown)
	keys = append(keys, tea.KeyMsg{Type: tea.KeySpace, Runes: []rune{' '}})
	keys = authFormKey(keys, tea.KeyEnter)
	// The severity select: move down twice (info → warning → critical).
	keys = authFormKey(keys, tea.KeyDown, tea.KeyDown, tea.KeyEnter)
	authFormAnswer(t, &authFormScript{keys: keys})

	draft, err := resolveAlertDraft(c, alertsCreateCmd, nil)
	if err != nil {
		t.Fatalf("resolveAlertDraft: %v", err)
	}
	if draft.Name != "Job failures" {
		t.Errorf("Name = %q", draft.Name)
	}
	if len(draft.Events) != 2 || draft.Events[1] != "authz.*.denied" {
		t.Errorf("Events = %v, want both patterns split out of one answer", draft.Events)
	}
	if len(draft.ChannelIDs) != 1 || draft.ChannelIDs[0] != "ch2" {
		t.Errorf("ChannelIDs = %v, want the SECOND channel — the one that was toggled", draft.ChannelIDs)
	}
	if draft.Severity != "critical" {
		t.Errorf("Severity = %q, want critical (two moves down the generated set)", draft.Severity)
	}
	if _, err := canonicalOneOf("severity", draft.Severity, alertSeverityNames()); err != nil {
		t.Errorf("the form produced a severity the server would refuse: %v", err)
	}
}

// TestGovAnswered_AlertCreateResolvesChannelNamesFromTheFlag pins the headline of this lane: a
// rule can name its channel the way a person does.
func TestGovAnswered_AlertCreateResolvesChannelNamesFromTheFlag(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	govAnsweredResetAlertFlags(t)
	alertEventPatterns = []string{"system.job.failed"}
	alertChannelRefs = []string{"Ops Slack", "ch2"}
	c := &fakeClient{channels: govAnsweredChannels()}

	draft, err := resolveAlertDraft(c, alertsCreateCmd, []string{"Job failures"})
	if err != nil {
		t.Fatalf("resolveAlertDraft: %v", err)
	}
	if len(draft.ChannelIDs) != 2 || draft.ChannelIDs[0] != "ch1" || draft.ChannelIDs[1] != "ch2" {
		t.Errorf("ChannelIDs = %v, want [ch1 ch2] — a NAME and an id resolved the same way",
			draft.ChannelIDs)
	}
	// Untouched --severity keeps the flag default rather than becoming empty, which the
	// alert_severity enum would refuse.
	if draft.Severity != "warning" {
		t.Errorf("Severity = %q, want the flag default", draft.Severity)
	}
}

// TestGovAnswered_AlertSeverityReachesTheDraftCanonical is the CALL-SITE half of #3825, and the
// half a helper test cannot cover.
//
// `TestCanonicalAlertSeverity` proves the matcher RETURNS the wire spelling. It cannot prove the
// caller USES the return, and that was the entire defect: `resolveAlertDraft` matched with
// `EqualFold` and then assigned `strings.TrimSpace(alertSeverity)` — the value the operator typed.
// `--severity Critical` passed the client gate and posted "Critical" to a case-SENSITIVE
// `z.enum(alertSeverity.enumValues)`, and the server answered a bare "Invalid request body" naming
// no field. So the assertion is on the DRAFT, not on the helper.
//
// The severity flag is set through cobra rather than by assigning `alertSeverity`, because the
// branch under test is gated on `cmd.Flags().Changed("severity")` — writing the variable alone
// leaves Changed false and the test would exercise the default path while appearing to pass.
// `govAnsweredResetAlertFlags` restores the VARIABLES and not that bit, so the Changed bit is
// restored here: cobra keeps it across Execute calls, and a leaked one turns the next file's
// default path into a flag-given one.
func TestGovAnswered_AlertSeverityReachesTheDraftCanonical(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	govAnsweredResetAlertFlags(t)
	alertEventPatterns = []string{"system.job.failed"}
	alertChannelRefs = []string{"ch2"}
	c := &fakeClient{channels: govAnsweredChannels()}

	sev := alertsCreateCmd.Flags().Lookup("severity")
	if sev == nil {
		t.Fatal("no --severity flag on alerts create — this test would be vacuous")
	}
	wasChanged := sev.Changed
	t.Cleanup(func() {
		_ = alertsCreateCmd.Flags().Set("severity", "warning")
		sev.Changed = wasChanged
	})

	names := alertSeverityNames()
	if len(names) == 0 {
		t.Fatal("no severities — vacuous")
	}
	want := names[len(names)-1]
	typed := strings.ToUpper(want)
	if typed == want {
		t.Fatalf("severity %q is already upper case — this test cannot tell folding from a no-op", want)
	}
	if err := alertsCreateCmd.Flags().Set("severity", typed); err != nil {
		t.Fatalf("set --severity %q: %v", typed, err)
	}

	draft, err := resolveAlertDraft(c, alertsCreateCmd, []string{"Job failures"})
	if err != nil {
		t.Fatalf("resolveAlertDraft: %v", err)
	}
	if draft.Severity != want {
		t.Errorf("--severity %q reached the draft as %q, want the canonical %q — the caller's "+
			"spelling is refused by the alert_severity enum with a 400 that names no field",
			typed, draft.Severity, want)
	}
}

// TestGovAnswered_AlertCreateRejectsAnUnknownChannelBeforeAsking pins that a typo'd --channel is
// reported straight away, naming the candidates rather than a 4xx.
func TestGovAnswered_AlertCreateRejectsAnUnknownChannelBeforeAsking(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	govAnsweredResetAlertFlags(t)
	alertEventPatterns = []string{"e"}
	alertChannelRefs = []string{"Ops Slak"}
	c := &fakeClient{channels: govAnsweredChannels()}

	_, err := resolveAlertDraft(c, alertsCreateCmd, []string{"r"})
	if err == nil {
		t.Fatal("a misspelled channel name was accepted")
	}
	if !strings.Contains(err.Error(), "alethia channels list") {
		t.Errorf("the refusal does not point anywhere: %v", err)
	}
}

// TestGovAnswered_AlertCreateWithNoChannelsRefusesInsteadOfOpeningAnEmptyBox pins the zero-census
// arm of the multi-select.
func TestGovAnswered_AlertCreateWithNoChannelsRefusesInsteadOfOpeningAnEmptyBox(t *testing.T) {
	govAnsweredTTY(t)
	govAnsweredResetAlertFlags(t)
	alertEventPatterns = []string{"e"}
	// No scripts: a form opening here would be a form with no options to choose from.
	authFormAnswer(t)

	_, err := resolveAlertDraft(&fakeClient{}, alertsCreateCmd, []string{"r"})
	if err == nil {
		t.Fatal("a rule was drafted with no channel to route it to")
	}
	if !strings.Contains(err.Error(), "alethia channels create") {
		t.Errorf("the refusal does not say how to get a channel: %v", err)
	}
}

// TestGovAnswered_AlertCreateInvalidSeverityIsRefusedBeforeTheFetch pins that a bad --severity
// does not cost a round trip.
func TestGovAnswered_AlertCreateInvalidSeverityIsRefusedBeforeTheFetch(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	govAnsweredResetAlertFlags(t)
	alertSeverity = "urgent"
	if err := alertsCreateCmd.Flags().Set("severity", "urgent"); err != nil {
		t.Fatalf("set --severity: %v", err)
	}
	t.Cleanup(func() {
		f := alertsCreateCmd.Flags().Lookup("severity")
		_ = f.Value.Set(f.DefValue)
		f.Changed = false
	})

	c := &fakeClient{channels: govAnsweredChannels()}
	_, err := resolveAlertDraft(c, alertsCreateCmd, []string{"r"})
	if err == nil {
		t.Fatal("a --severity outside the alert_severity enum was accepted")
	}
	// ASSERTED ON THE PROPERTY, NOT THE PHRASING. This pinned the substring
	// "not an alert severity", which was the wording of the local `validAlertSeverity` #3825
	// deleted in favour of the shared `canonicalOneOf` — so a behaviour-preserving change to the
	// helper reds it, while the thing worth keeping is what the refusal has to TELL the operator:
	// which flag was wrong, what they typed, and what they could have typed instead. That last
	// part is the whole reason validating client-side beats surfacing the server's 400.
	msg := err.Error()
	if !strings.Contains(msg, "--severity") || !strings.Contains(msg, "urgent") {
		t.Errorf("the refusal names neither the flag nor the value: %v", err)
	}
	for _, name := range alertSeverityNames() {
		if !strings.Contains(msg, name) {
			t.Errorf("the refusal does not name the legal value %q: %v", name, err)
		}
	}
}

// ── the picker ────────────────────────────────────────────────────────────────────────────────

// TestGovAnswered_PickerChoosesTheHighlightedRecord drives resolveGovRef's picker arm.
//
// Moving DOWN before enter is what makes this an assertion about the binding: huh writes back the
// value of whichever option is highlighted, and a picker bound to nothing would leave the zero
// index — which is also the first record.
func TestGovAnswered_PickerChoosesTheHighlightedRecord(t *testing.T) {
	govAnsweredTTY(t)
	refs := govRefsFromChannels(govAnsweredChannels())
	authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyEnter)})

	got, err := resolveGovRef(channelSelect, refs, nil)
	if err != nil {
		t.Fatalf("resolveGovRef: %v", err)
	}
	if got.ID != "ch2" {
		t.Errorf("the picker resolved to %q, want the SECOND record ch2", got.ID)
	}
}

// TestGovAnswered_ResolveChannelListsThenPicks drives the command-level resolver end to end.
func TestGovAnswered_ResolveChannelListsThenPicks(t *testing.T) {
	govAnsweredTTY(t)
	c := &fakeClient{channels: govAnsweredChannels()}
	authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})

	got, err := resolveChannel(c, nil)
	if err != nil {
		t.Fatalf("resolveChannel: %v", err)
	}
	if got.ID != "ch1" {
		t.Errorf("resolved to %q, want ch1", got.ID)
	}
	// And by name, with no form at all.
	authFormAnswer(t)
	if got, err := resolveChannel(c, []string{"On-call"}); err != nil || got.ID != "ch2" {
		t.Errorf("resolveChannel(On-call) = %q, %v", got.ID, err)
	}
}

// TestGovAnswered_ResolveAlertRuleListsThenPicks does the same for alert rules.
func TestGovAnswered_ResolveAlertRuleListsThenPicks(t *testing.T) {
	govAnsweredTTY(t)
	c := &fakeClient{alertRules: []api.AlertRule{
		{ID: "ar1", Name: "Job failures", Severity: "critical"},
		{ID: "ar2", Name: "Denials", Severity: "info"},
	}}
	authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyEnter)})

	got, err := resolveAlertRule(c, nil)
	if err != nil {
		t.Fatalf("resolveAlertRule: %v", err)
	}
	if got.ID != "ar2" {
		t.Errorf("resolved to %q, want ar2", got.ID)
	}
}

// TestGovAnswered_ResolvePromotionHonoursTheEnvNarrowing pins that the picker's candidates are the
// ones `promotion list --env` would have shown.
func TestGovAnswered_ResolvePromotionHonoursTheEnvNarrowing(t *testing.T) {
	govAnsweredTTY(t)
	c := &fakeClient{promotions: []api.Promotion{
		{ID: "pr1", Source: "staging", Target: "production", Status: "PENDING", CreatedAt: "2026-01-01T00:00:00Z"},
	}}
	authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})

	got, err := resolvePromotion(c, "web", "production", nil)
	if err != nil {
		t.Fatalf("resolvePromotion: %v", err)
	}
	if got.ID != "pr1" {
		t.Errorf("resolved to %q", got.ID)
	}
	if c.promoEnv != "production" {
		t.Errorf("the --env narrowing was not passed to the list call, got %q", c.promoEnv)
	}
	if c.promoProject != "web" {
		t.Errorf("the project was not passed to the list call, got %q", c.promoProject)
	}
}

// ── classification ────────────────────────────────────────────────────────────────────────────

// govAnsweredDims is a taxonomy with a kind-scoped and an unscoped dimension.
func govAnsweredDims() []api.ClassificationDimension {
	return []api.ClassificationDimension{
		{Key: "environment", Label: "Environment", AppliesTo: []string{"project_environment"},
			Values: []api.ClassificationValue{{Value: "dev", Label: "Dev"}, {Value: "prod", Label: "Prod"}}},
		{Key: "team", Label: "Team", Multi: true,
			Values: []api.ClassificationValue{{Value: "platform", Label: "Platform"}}},
	}
}

// TestGovAnswered_ClassificationAssignAsksForBothSlugs drives the two pickers in sequence.
func TestGovAnswered_ClassificationAssignAsksForBothSlugs(t *testing.T) {
	govAnsweredTTY(t)
	c := &fakeClient{classDims: govAnsweredDims()}
	authFormAnswer(t,
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},              // dimension: environment
		&authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyEnter)}, // value: prod
	)

	key, value, err := resolveClassification(c, "project_environment", nil)
	if err != nil {
		t.Fatalf("resolveClassification: %v", err)
	}
	if key != "environment" {
		t.Errorf("dimension = %q, want environment", key)
	}
	if value != "prod" {
		t.Errorf("value = %q, want the SECOND value prod", value)
	}
}

// TestGovAnswered_ClassificationAssignValidatesGivenSlugs pins the fully-specified path: both
// slugs are checked against the taxonomy, and a miss names the alternatives.
func TestGovAnswered_ClassificationAssignValidatesGivenSlugs(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	c := &fakeClient{classDims: govAnsweredDims()}

	key, value, err := resolveClassification(c, "project_environment", []string{"environment", "prod"})
	if err != nil || key != "environment" || value != "prod" {
		t.Fatalf("a valid pair was refused: %q, %q, %v", key, value, err)
	}
	if _, _, err := resolveClassification(c, "project_environment", []string{"envrionment", "prod"}); err == nil {
		t.Error("a misspelled dimension key was accepted")
	}
	_, _, err = resolveClassification(c, "project_environment", []string{"environment", "produciton"})
	if err == nil {
		t.Fatal("a misspelled value slug was accepted")
	}
	for _, want := range []string{"dev", "prod"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not name the real value %q: %v", want, err)
		}
	}
}

// TestGovAnswered_ClassificationAssignWithAnEmptyTaxonomy pins the zero-census arm.
func TestGovAnswered_ClassificationAssignWithAnEmptyTaxonomy(t *testing.T) {
	govAnsweredTTY(t)
	authFormAnswer(t)
	_, _, err := resolveClassification(&fakeClient{}, "project_environment", nil)
	if err == nil {
		t.Fatal("an empty taxonomy produced an assignment")
	}
	if !strings.Contains(err.Error(), "no classification dimensions") {
		t.Errorf("got %v, want the empty-taxonomy refusal", err)
	}
}

// TestGovAnswered_ClassificationUnassignPicksFromWhatTheResourceCarries pins the deliberate
// difference from assign's source.
func TestGovAnswered_ClassificationUnassignPicksFromWhatTheResourceCarries(t *testing.T) {
	govAnsweredTTY(t)
	c := &fakeClient{classAssigns: []api.ClassificationAssignment{
		{DimensionKey: "environment", DimensionLabel: "Environment", Value: "prod", ValueLabel: "Prod"},
		{DimensionKey: "team", DimensionLabel: "Team", Value: "platform", ValueLabel: "Platform"},
	}}
	authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyEnter)})

	got, err := resolveAssignedValue(c, "project_environment", "e1", nil)
	if err != nil {
		t.Fatalf("resolveAssignedValue: %v", err)
	}
	if got != "platform" {
		t.Errorf("resolved to %q, want the SECOND value the resource carries", got)
	}

	// A resource carrying nothing is refused rather than offered an empty box.
	authFormAnswer(t)
	if _, err := resolveAssignedValue(&fakeClient{}, "project_environment", "e1", nil); err == nil {
		t.Error("an unclassified resource offered a value to clear")
	}

	// A slug on the command line is taken as-is: `unassign` may name a value the list call would
	// not have returned, and the server's no-op is the honest answer to that.
	if got, err := resolveAssignedValue(&fakeClient{}, "k", "i", []string{"gold"}); err != nil || got != "gold" {
		t.Errorf("a given slug was not taken as-is: %q, %v", got, err)
	}
}

// TestGovAnswered_ClassificationUnassignScriptedNamesWhatIsThere pins the --no-input refusal.
func TestGovAnswered_ClassificationUnassignScriptedNamesWhatIsThere(t *testing.T) {
	hygCliConfirmSetNoInput(t, true)
	c := &fakeClient{classAssigns: []api.ClassificationAssignment{
		{DimensionKey: "environment", Value: "prod"},
	}}
	_, err := resolveAssignedValue(c, "project_environment", "e1", nil)
	if err == nil {
		t.Fatal("a missing slug under --no-input resolved")
	}
	if !strings.Contains(err.Error(), "prod") {
		t.Errorf("the refusal does not name what the resource carries: %v", err)
	}
}

// ── fleet ─────────────────────────────────────────────────────────────────────────────────────

// TestGovAnswered_FleetProviderPicker drives the provider select.
func TestGovAnswered_FleetProviderPicker(t *testing.T) {
	govAnsweredTTY(t)
	authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyEnter)})

	got, err := resolveFleetProvider(nil)
	if err != nil {
		t.Fatalf("resolveFleetProvider: %v", err)
	}
	want := cloudProviderNames()[1]
	if got != want {
		t.Errorf("resolved to %q, want the SECOND generated provider %q", got, want)
	}
}

// TestGovAnswered_AbandonedFormsAreReportedNotIgnored pins that a dismissed form does not produce
// a half-filled draft that is sent anyway.
//
// huh returns an error when its form is aborted, and every resolver above propagates it. The
// stubbed runHuhForm below returns that error directly, which is the shape a real ctrl-c produces.
func TestGovAnswered_AbandonedFormsAreReportedNotIgnored(t *testing.T) {
	govAnsweredTTY(t)
	govAnsweredResetChannelFlags(t)
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return huh.ErrUserAborted }
	t.Cleanup(func() { runHuhForm = prev })

	if _, err := resolveChannelDraft(nil); err == nil {
		t.Error("an abandoned channel form produced a draft")
	}
	if _, err := resolveGovRef(channelSelect, govRefsFromChannels(govAnsweredChannels()), nil); err == nil {
		t.Error("an abandoned picker produced a record")
	}
	if _, err := resolveFleetProvider(nil); err == nil {
		t.Error("an abandoned provider picker produced a provider")
	}
	if _, _, err := resolveClassification(&fakeClient{classDims: govAnsweredDims()}, "project_environment", nil); err == nil {
		t.Error("an abandoned dimension picker produced an assignment")
	}
}

// TestGovAnswered_AbandonedDestinationAndAlertFormsAreReported covers the abort arm of the forms
// the test above could not reach.
//
// resolveChannelDraft abandons at its FIRST form when nothing is flagged, so the three destination
// questions — each a separate huh call — are only reachable once the type is already settled. The
// alert form is likewise only reached once the channel list has been fetched.
func TestGovAnswered_AbandonedDestinationAndAlertFormsAreReported(t *testing.T) {
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return huh.ErrUserAborted }
	t.Cleanup(func() { runHuhForm = prev })

	for _, channelType := range []string{"email", "pagerduty", "slack"} {
		t.Run("destination/"+channelType, func(t *testing.T) {
			govAnsweredTTY(t)
			if _, err := askChannelDestination(channelDraft{Name: "n", Type: channelType}); err == nil {
				t.Errorf("an abandoned %s destination question produced a draft", channelType)
			}
		})
	}

	t.Run("alerts create", func(t *testing.T) {
		govAnsweredTTY(t)
		govAnsweredResetAlertFlags(t)
		c := &fakeClient{channels: govAnsweredChannels()}
		if _, err := resolveAlertDraft(c, alertsCreateCmd, nil); err == nil {
			t.Error("an abandoned alert form produced a draft")
		}
	})

	t.Run("classification unassign", func(t *testing.T) {
		govAnsweredTTY(t)
		c := &fakeClient{classAssigns: []api.ClassificationAssignment{{DimensionKey: "d", Value: "v"}}}
		if _, err := resolveAssignedValue(c, "k", "i", nil); err == nil {
			t.Error("an abandoned unassign picker produced a value")
		}
	})
}

// TestGovAnswered_AlertFormKeepsAFlaggedSeverity pins the branch where the severity question is
// NOT shown because the caller passed --severity, and the answered draft still carries it.
//
// It is the branch that would silently send an empty severity — which the alert_severity enum
// refuses — if the fallback below the form were removed.
func TestGovAnswered_AlertFormKeepsAFlaggedSeverity(t *testing.T) {
	govAnsweredTTY(t)
	govAnsweredResetAlertFlags(t)
	alertSeverity = "critical"
	if err := alertsCreateCmd.Flags().Set("severity", "critical"); err != nil {
		t.Fatalf("set --severity: %v", err)
	}
	t.Cleanup(func() {
		f := alertsCreateCmd.Flags().Lookup("severity")
		_ = f.Value.Set(f.DefValue)
		f.Changed = false
	})
	alertEventPatterns = []string{"system.job.failed"}
	alertChannelRefs = []string{"ch1"}
	c := &fakeClient{channels: govAnsweredChannels()}

	// Only the NAME is missing, so exactly one question may open.
	keys := authFormKey(authFormType("Job failures"), tea.KeyEnter)
	authFormAnswer(t, &authFormScript{keys: keys})

	draft, err := resolveAlertDraft(c, alertsCreateCmd, nil)
	if err != nil {
		t.Fatalf("resolveAlertDraft: %v", err)
	}
	if draft.Severity != "critical" {
		t.Errorf("Severity = %q, want the flagged value — an unasked question must not blank it",
			draft.Severity)
	}
	if draft.Name != "Job failures" {
		t.Errorf("Name = %q", draft.Name)
	}
}

// TestGovAnswered_AnEmptyAnswerIsStillAMissingValue pins that a form the user walked through
// without typing anything does not produce a rule the server would refuse.
func TestGovAnswered_AnEmptyAnswerIsStillAMissingValue(t *testing.T) {
	govAnsweredTTY(t)
	govAnsweredResetAlertFlags(t)
	c := &fakeClient{channels: govAnsweredChannels()}

	// Enter through every question, typing nothing and toggling no channel.
	keys := authFormKey(nil, tea.KeyEnter, tea.KeyEnter, tea.KeyEnter, tea.KeyEnter)
	authFormAnswer(t, &authFormScript{keys: keys})

	_, err := resolveAlertDraft(c, alertsCreateCmd, nil)
	if err == nil {
		t.Fatal("a form answered with nothing produced a draft")
	}
	if err != errAlertNameRequired {
		t.Errorf("got %v, want the name refusal — the first thing that is still missing", err)
	}
}

// TestMustGovFieldPanicsOnAnUnknownKey pins the spec lookup's failure mode.
//
// The panic is the right answer — both arguments are constants in this package, so a miss is a
// programming error, and the alternative is a form that opens with an empty title and asks the
// user for something unnamed. What must not happen is that it silently returns that zero value.
func TestMustGovFieldPanicsOnAnUnknownKey(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("mustGovField returned a zero field for an unknown key instead of panicking — " +
				"that is a form with no question in it")
		}
		if msg, ok := r.(string); !ok || !strings.Contains(msg, "governance_fields.go") {
			t.Errorf("the panic does not say where the spec lives: %v", r)
		}
	}()
	mustGovField("alethia channels create", "no-such-key")
}
