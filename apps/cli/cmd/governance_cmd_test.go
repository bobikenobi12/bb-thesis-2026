// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
)

// The governance commands driven through the REAL cobra tree, end to end against a fake control
// plane.
//
// governance_select_test.go and governance_answered_test.go drive the resolvers and the forms as
// functions. This file drives the COMMANDS: the Run bodies that wire an auth token, a project, a
// resolver and a renderer together, and the fatal arms that fire when one of them refuses. Those
// bodies are where a resolver can be correctly written and wrongly called — `promotion get`
// resolving against the wrong project, say — and no function-level test can see it.
//
// Every identifier here carries the govCmd prefix.

// govCmdEnv is the misc harness: an isolated home, a token, an active org, and one fake control
// plane that answers every path from a single envelope.
func govCmdEnv(t *testing.T) func(args ...string) error {
	t.Helper()
	return miscEnv(t, miscFull)
}

// TestGovCmd_PromotionGetResolvesFromTheList drives `promotion get` with no id at all: the arm
// that replaced a copied UUID.
//
// It is a separate test from the read-command sweep because a project with no promotions is a
// MISS for a get and therefore fatal, where the sweep asserts every command survives an empty
// envelope — the same split cov_misc_test.go records for `cluster get`.
func TestGovCmd_PromotionGetResolvesFromTheList(t *testing.T) {
	run := govCmdEnv(t)
	miscTTY(t)
	authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})

	if err := run("promotion", "get", "-p", "web", "--output", "table", "--no-input=false"); err != nil {
		t.Fatalf("promotion get with no id: %v", err)
	}
}

// TestGovCmd_PromotionGetByIdAndPrefix pins that a caller who already holds an id still gets the
// short path, and that a prefix works.
func TestGovCmd_PromotionGetByIdAndPrefix(t *testing.T) {
	run := govCmdEnv(t)
	for _, id := range []string{"pr1", "pr"} {
		if err := run("promotion", "get", id, "-p", "web", "--output", "json", "--no-input"); err != nil {
			t.Errorf("promotion get %s: %v", id, err)
		}
	}
}

// TestGovCmd_PromotionGetUnknownIdIsFatal pins that a miss is fatal rather than a muted line and
// exit 0 — the failure `cluster get` had before #3738.
func TestGovCmd_PromotionGetUnknownIdIsFatal(t *testing.T) {
	run := miscTrapExit(t, govCmdEnv(t))
	if !run("promotion", "get", "nope", "-p", "web", "--output", "json", "--no-input") {
		t.Error("an unknown promotion id should exit fatally")
	}
	if !run("promotion", "get", "-p", "web", "--output", "json", "--no-input") {
		t.Error("no promotion id under --no-input should exit fatally")
	}
}

// TestGovCmd_ProjectScopedListsAskForTheProject pins the picker the three project-scoped read
// commands gained: --project omitted at a terminal is a question, not a refusal.
func TestGovCmd_ProjectScopedListsAskForTheProject(t *testing.T) {
	for _, args := range [][]string{
		{"protection", "list"},
		{"probes", "list"},
		{"promotion", "list"},
	} {
		t.Run(args[0], func(t *testing.T) {
			run := govCmdEnv(t)
			miscTTY(t)
			authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})
			full := append(append([]string{}, args...), "--project=", "--output", "table", "--no-input=false")
			if err := run(full...); err != nil {
				t.Errorf("%v: %v", args, err)
			}
		})
	}
}

// TestGovCmd_ChannelsVerifyAndDeleteByName drives the two channel commands by NAME, which is the
// handoff removal this lane exists for.
func TestGovCmd_ChannelsVerifyAndDeleteByName(t *testing.T) {
	run := govCmdEnv(t)
	hygCliConfirmClearYes(t, channelsDeleteCmd)

	if err := run("channels", "verify", "ops", "--output", "json", "--no-input"); err != nil {
		t.Fatalf("channels verify by name: %v", err)
	}
	if err := run("channels", "delete", "ops", "--yes", "--output", "json", "--no-input"); err != nil {
		t.Fatalf("channels delete by name: %v", err)
	}
}

// TestGovCmd_ChannelsVerifyAndDeleteFromThePicker drives the same two with nothing named.
func TestGovCmd_ChannelsVerifyAndDeleteFromThePicker(t *testing.T) {
	run := govCmdEnv(t)
	miscTTY(t)
	hygCliConfirmClearYes(t, channelsDeleteCmd)
	authFormAnswer(t,
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
	)

	if err := run("channels", "verify", "--output", "table", "--no-input=false"); err != nil {
		t.Fatalf("channels verify from the picker: %v", err)
	}
	if err := run("channels", "delete", "--yes", "--output", "table", "--no-input=false"); err != nil {
		t.Fatalf("channels delete from the picker: %v", err)
	}
}

// TestGovCmd_UnknownRecordIsFatal pins the fatal arm of every command that resolves a record.
func TestGovCmd_UnknownRecordIsFatal(t *testing.T) {
	run := miscTrapExit(t, govCmdEnv(t))
	hygCliConfirmClearYes(t, channelsDeleteCmd)
	hygCliConfirmClearYes(t, alertsDeleteCmd)
	cases := [][]string{
		{"channels", "verify", "nope"},
		{"channels", "delete", "nope", "--yes"},
		{"alerts", "delete", "nope", "--yes"},
	}
	for _, args := range cases {
		t.Run(args[0]+"_"+args[1], func(t *testing.T) {
			if !run(append(append([]string{}, args...), "--output", "json", "--no-input")...) {
				t.Errorf("%v: naming a record that does not exist should exit fatally", args)
			}
		})
	}
}

// TestGovCmd_AlertsCreateNamesItsChannel drives `alerts create --channel <name>` through the tree.
func TestGovCmd_AlertsCreateNamesItsChannel(t *testing.T) {
	run := govCmdEnv(t)
	if err := run("alerts", "create", "Job failures",
		"--event", "system.job.failed", "--channel", "ops", "--severity", "critical",
		"--output", "json", "--no-input"); err != nil {
		t.Fatalf("alerts create naming its channel: %v", err)
	}
}

// TestGovCmd_AlertsCreateRefusesAnInvalidSeverity pins the closed-set refusal at the command
// level, where a user meets it.
func TestGovCmd_AlertsCreateRefusesAnInvalidSeverity(t *testing.T) {
	run := miscTrapExit(t, govCmdEnv(t))
	if !run("alerts", "create", "r", "--event", "e", "--channel", "ops", "--severity", "urgent",
		"--output", "json", "--no-input") {
		t.Error("an invalid --severity should exit fatally")
	}
}

// TestGovCmd_AlertsDeleteFromThePicker drives the alert-rule picker.
func TestGovCmd_AlertsDeleteFromThePicker(t *testing.T) {
	run := govCmdEnv(t)
	miscTTY(t)
	hygCliConfirmClearYes(t, alertsDeleteCmd)
	authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})

	if err := run("alerts", "delete", "--yes", "--output", "table", "--no-input=false"); err != nil {
		t.Fatalf("alerts delete from the picker: %v", err)
	}
}

// TestGovCmd_ClassificationAssignAsksForTheSlugs drives `classification assign` with only the kind
// and the id — the four-token contract reduced to two.
func TestGovCmd_ClassificationAssignAsksForTheSlugs(t *testing.T) {
	run := govCmdEnv(t)
	miscTTY(t)
	authFormAnswer(t,
		&authFormScript{keys: authFormKey(nil, tea.KeyEnter)},
		&authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyEnter)},
	)

	if err := run("classification", "assign", "project_environment", "e1",
		"--output", "table", "--no-input=false"); err != nil {
		t.Fatalf("classification assign with no slugs: %v", err)
	}
}

// TestGovCmd_ClassificationAssignRefusesAnUnknownSlug pins the taxonomy check at the command
// level, for both slugs.
func TestGovCmd_ClassificationAssignRefusesAnUnknownSlug(t *testing.T) {
	run := miscTrapExit(t, govCmdEnv(t))
	if !run("classification", "assign", "project_environment", "e1", "envrionment", "prod",
		"--output", "json", "--no-input") {
		t.Error("an unknown dimension key should exit fatally")
	}
	if !run("classification", "assign", "project_environment", "e1", "environment", "produciton",
		"--output", "json", "--no-input") {
		t.Error("an unknown value slug should exit fatally")
	}
	if !run("classification", "assign", "project_environment", "e1",
		"--output", "json", "--no-input") {
		t.Error("no slugs under --no-input should exit fatally")
	}
}

// TestGovCmd_ClassificationUnassignAsksForTheValue drives the unassign picker, whose candidates
// are the resource's own labels.
func TestGovCmd_ClassificationUnassignAsksForTheValue(t *testing.T) {
	run := govCmdEnv(t)
	miscTTY(t)
	hygCliConfirmClearYes(t, classificationUnassignCmd)
	authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})

	if err := run("classification", "unassign", "project_environment", "e1", "--yes",
		"--output", "table", "--no-input=false"); err != nil {
		t.Fatalf("classification unassign with no slug: %v", err)
	}
}

// TestGovCmd_ClassificationUnassignScriptedWithoutASlugIsFatal pins the scripted arm.
func TestGovCmd_ClassificationUnassignScriptedWithoutASlugIsFatal(t *testing.T) {
	run := miscTrapExit(t, govCmdEnv(t))
	hygCliConfirmClearYes(t, classificationUnassignCmd)
	if !run("classification", "unassign", "project_environment", "e1", "--yes",
		"--output", "json", "--no-input") {
		t.Error("no value slug under --no-input should exit fatally")
	}
}

// TestGovCmd_FleetSetAsksForTheProvider drives `fleet set` with only a flag, choosing the cloud
// from the picker.
func TestGovCmd_FleetSetAsksForTheProvider(t *testing.T) {
	run := govCmdEnv(t)
	miscTTY(t)
	hygCliConfirmClearYes(t, fleetSetCmd)
	authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})

	if err := run("fleet", "set", "--warm-min", "2", "--output", "table", "--no-input=false"); err != nil {
		t.Fatalf("fleet set with no provider: %v", err)
	}
}

// TestGovCmd_FleetSetScriptedWithoutAProviderIsFatal pins the scripted arm, and that the "nothing
// to update" refusal still fires first when no flag was passed at all.
func TestGovCmd_FleetSetScriptedWithoutAProviderIsFatal(t *testing.T) {
	run := miscTrapExit(t, govCmdEnv(t))
	hygCliConfirmClearYes(t, fleetSetCmd)
	if !run("fleet", "set", "--warm-min", "2", "--output", "json", "--no-input") {
		t.Error("no provider under --no-input should exit fatally")
	}
	// cobra never clears a flag between Execute calls, and `buildFleetUpdate` asks Changed()
	// rather than reading a value — so without this reset the --warm-min from the run ABOVE is
	// still "changed" and the second case silently tests something else. It did: it updated the
	// aws pool and reported success where the assertion expects a refusal.
	hygCliConfirmResetFlags()
	if !run("fleet", "set", "aws", "--output", "json", "--no-input") {
		t.Error("no update flags should exit fatally")
	}
}

// TestGovCmd_ChannelsCreateFromTheFormReachesTheControlPlane drives `channels create` with nothing
// on the command line at all.
func TestGovCmd_ChannelsCreateFromTheFormReachesTheControlPlane(t *testing.T) {
	run := govCmdEnv(t)
	miscTTY(t)
	name := authFormKey(authFormType("Ops Slack"), tea.KeyEnter)
	name = authFormKey(name, tea.KeyDown, tea.KeyDown, tea.KeyEnter) // webhook → email → slack
	url := authFormKey(authFormType("https://hooks.slack.com/services/XXX"), tea.KeyEnter)
	authFormAnswer(t,
		&authFormScript{keys: name},
		&authFormScript{keys: url},
	)

	if err := run("channels", "create", "--output", "table", "--no-input=false"); err != nil {
		t.Fatalf("channels create from the form: %v", err)
	}
}

// TestGovCmd_ChannelsCreateScriptedWithoutATypeIsFatal pins the scripted refusal.
func TestGovCmd_ChannelsCreateScriptedWithoutATypeIsFatal(t *testing.T) {
	run := miscTrapExit(t, govCmdEnv(t))
	if !run("channels", "create", "Ops", "--output", "json", "--no-input") {
		t.Error("no --type under --no-input should exit fatally")
	}
}

// TestGovCmd_ServerErrorsAreFatal pins that a control plane that refuses the RESOLVER's list call
// is fatal, not a command that silently resolves nothing.
//
// The resolvers added a list call to commands that previously made one request; a failure there is
// a new fatal path, and a command that swallowed it would go on to act on an empty record.
func TestGovCmd_ServerErrorsAreFatal(t *testing.T) {
	run := miscTrapExit(t, miscEnv(t, miscFail))
	hygCliConfirmClearYes(t, channelsDeleteCmd)
	hygCliConfirmClearYes(t, alertsDeleteCmd)
	hygCliConfirmClearYes(t, classificationUnassignCmd)
	cases := [][]string{
		{"channels", "verify", "ops"},
		{"channels", "delete", "ops", "--yes"},
		{"alerts", "delete", "ar1", "--yes"},
		{"promotion", "get", "pr1", "-p", "web"},
		{"classification", "assign", "project_environment", "e1", "environment", "prod"},
		{"classification", "unassign", "project_environment", "e1", "--yes"},
	}
	for _, args := range cases {
		t.Run(args[0]+"_"+args[1], func(t *testing.T) {
			if !run(append(append([]string{}, args...), "--output", "json", "--no-input")...) {
				t.Errorf("%v: a refused control plane should exit fatally", args)
			}
		})
	}
}

// TestGovCmd_ARecordlessSuccessIsReportedNotDereferenced pins the arm that used to be a panic.
//
// The mutating commands read a POINTER out of a 200 — `{"channel": …}`, `{"alert_rule": …}`,
// `{"pool": …}` — so a success response that carries no such object yields (nil, nil), and the
// confirmation line dereferenced it. That produced a Go stack trace where the honest answer is
// "the control plane said yes and did not say what it did".
//
// The empty envelope is exactly that response: 200, well-formed JSON, no record. Each command must
// exit fatally with a message, and the test binary must survive — a panic here fails the whole
// package, which is how this was found.
func TestGovCmd_ARecordlessSuccessIsReportedNotDereferenced(t *testing.T) {
	run := miscTrapExit(t, miscEnv(t, miscEmpty))
	hygCliConfirmClearYes(t, fleetSetCmd)
	cases := [][]string{
		{"channels", "verify", "ch1"},
		{"channels", "create", "Ops", "--type", "slack", "--url", "https://x/y"},
		{"alerts", "create", "r", "--event", "e", "--channel", "ch1"},
		{"fleet", "set", "aws", "--warm-min", "2"},
	}
	for _, args := range cases {
		t.Run(args[0]+"_"+args[1], func(t *testing.T) {
			if !run(append(append([]string{}, args...), "--output", "json", "--no-input")...) {
				t.Errorf("%v: a 200 carrying no record should exit fatally", args)
			}
		})
	}
}

// govCmdCustom stands up a control plane whose body is chosen per test, and which can be made to
// fail one METHOD+PATH pair while every other request succeeds.
//
// The existing harnesses cannot express that. miscEnv fails everything or nothing, and the
// resolvers now make a LIST call before they act — so under miscFail the list fails first and the
// mutating call is never reached. Every "the mutation was refused" arm below is unreachable
// without a server that answers the read and refuses the write, which is also the only shape the
// real failure takes.
func govCmdCustom(t *testing.T, body map[string]any, failMethod, failPath string) func(args ...string) (int, error) {
	t.Helper()
	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	if err := types.SaveCliConfig(types.CliConfig{
		ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme",
	}); err != nil {
		t.Fatalf("SaveCliConfig: %v", err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failMethod != "" && r.Method == failMethod && strings.Contains(r.URL.Path, failPath) {
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "refused"})
			return
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	prevExit := exitFunc
	exitFunc = func(code int) { panic(hygCliConfirmExit{code: code}) }
	t.Cleanup(func() { exitFunc = prevExit; hygCliConfirmResetFlags() })

	return func(args ...string) (code int, err error) {
		defer func() {
			hygCliConfirmResetFlags()
			if r := recover(); r != nil {
				e, ok := r.(hygCliConfirmExit)
				if !ok {
					panic(r)
				}
				code = e.code
			}
		}()
		// hygCliConfirmResetFlags walks the WHOLE tree and clears every flag a previous test
		// left Changed; execRootArgs additionally returns the root persistent flags to their
		// defaults and is what TestHygCliHarness_NothingBypassesTheSharedRunner requires. Both,
		// not either: the harness guard is about the root flags, and the walk is about the rest.
		hygCliConfirmResetFlags()
		execRootArgs(args)
		err = rootCmd.Execute()
		return 0, err
	}
}

// govCmdBody is a control plane holding one channel and one alert rule, and NO single-record
// envelopes — so a mutation that succeeds returns a 200 carrying no record.
func govCmdBody() map[string]any {
	return map[string]any{
		"channels": []any{
			map[string]any{"id": "ch1", "name": "ops", "type": "slack", "is_verified": true, "enabled": true},
		},
		"alert_rules": []any{
			map[string]any{"id": "ar1", "name": "job failures", "severity": "critical", "enabled": true},
		},
		"dimensions": []any{
			map[string]any{"id": "d1", "key": "tier", "label": "Tier", "applies_to": []string{"cluster"},
				"values": []any{map[string]any{"id": "v1", "value": "gold", "label": "Gold"}}},
			map[string]any{"id": "d2", "key": "empty", "label": "Empty", "applies_to": []string{"project_environment"},
				"values": []any{}},
		},
	}
}

// TestGovCmd_AMutationRefusedAfterASuccessfulResolveIsFatal pins the arms that only exist because
// the resolvers added a read before the write.
func TestGovCmd_AMutationRefusedAfterASuccessfulResolveIsFatal(t *testing.T) {
	cases := []struct {
		name       string
		failMethod string
		failPath   string
		args       []string
	}{
		{"channels_verify", http.MethodPost, "/cli/channels/ch1/verify", []string{"channels", "verify", "ops"}},
		{"channels_delete", http.MethodDelete, "/cli/channels/ch1", []string{"channels", "delete", "ops", "--yes"}},
		{"alerts_delete", http.MethodDelete, "/cli/alerts/ar1", []string{"alerts", "delete", "job failures", "--yes"}},
		{"alerts_create", http.MethodPost, "/cli/alerts", []string{"alerts", "create", "r", "--event", "e", "--channel", "ops"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			run := govCmdCustom(t, govCmdBody(), tc.failMethod, tc.failPath)
			code, _ := run(append(append([]string{}, tc.args...), "--output", "json", "--no-input")...)
			if code != 1 {
				t.Errorf("%v: exit %d, want 1 — a refused mutation must not exit 0 after a "+
					"successful resolve", tc.args, code)
			}
		})
	}
}

// TestGovCmd_AlertsCreateRecordlessSuccessIsReportedNotDereferenced covers the arm the
// empty-envelope sweep could NOT reach, and this is worth stating because the sweep PASSED.
//
// Under the empty envelope `alerts create` is refused by the channel resolver — there are no
// channels — so it never calls the control plane and never reaches the nil check at all. The case
// was green for a reason unrelated to what it claimed to test. Here the org HAS a channel, so the
// create is actually made, and the 200 it gets back carries no `alert_rule`.
func TestGovCmd_AlertsCreateRecordlessSuccessIsReportedNotDereferenced(t *testing.T) {
	run := govCmdCustom(t, govCmdBody(), "", "")
	code, _ := run("alerts", "create", "r", "--event", "e", "--channel", "ops",
		"--output", "json", "--no-input")
	if code != 1 {
		t.Errorf("exit %d, want 1 — a 200 carrying no rule must be reported, not dereferenced", code)
	}
}

// TestGovCmd_ClassificationPickersRefuseAnEmptyOffer pins the two zero-census arms inside the
// classification pickers: no dimension targets this kind, and the chosen dimension has no values.
func TestGovCmd_ClassificationPickersRefuseAnEmptyOffer(t *testing.T) {
	t.Run("no dimension targets the kind", func(t *testing.T) {
		run := govCmdCustom(t, govCmdBody(), "", "")
		miscTTY(t)
		authFormAnswer(t)
		// The taxonomy's only dimensions target `cluster` and `project_environment`; nothing
		// targets a runner, so there is no question to ask.
		code, _ := run("classification", "assign", "runner", "r1", "--output", "table", "--no-input=false")
		if code != 1 {
			t.Errorf("exit %d, want 1 when no dimension targets the kind", code)
		}
	})
	t.Run("the dimension has no values", func(t *testing.T) {
		run := govCmdCustom(t, govCmdBody(), "", "")
		miscTTY(t)
		authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})
		// `empty` is the only dimension targeting project_environment, and it has no values.
		code, _ := run("classification", "assign", "project_environment", "e1",
			"--output", "table", "--no-input=false")
		if code != 1 {
			t.Errorf("exit %d, want 1 when the chosen dimension has no values to assign", code)
		}
	})
	t.Run("scripted, the value refusal names the values", func(t *testing.T) {
		run := govCmdCustom(t, govCmdBody(), "", "")
		code, _ := run("classification", "assign", "cluster", "c1", "tier",
			"--output", "json", "--no-input")
		if code != 1 {
			t.Errorf("exit %d, want 1 when no value slug is given and nothing may be asked", code)
		}
	})
}
