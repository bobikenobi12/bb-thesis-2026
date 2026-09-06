// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
)

// The refusal arms of the auth group's forms.
//
// A form's happy path is the half everyone writes. These are the other half: the
// prompt the user aborted, the control plane that would not answer the picker,
// the key that does not exist, the write that failed. Each one ends with the
// command doing NOTHING, and "did nothing" is indistinguishable from "worked" from
// the outside unless something drives it.
//
// Every identifier here carries the authArm prefix.

// authArmFormError makes every form abort with err, standing in for a user who
// pressed ctrl-c or a terminal that could not open.
func authArmFormError(t *testing.T, err error) {
	t.Helper()
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error { return err }
	t.Cleanup(func() { runHuhForm = prev })
}

// authArmFormErrorOnce makes only the FIRST form abort, and every later one
// succeed.
//
// The distinction is the whole test. With every form aborting, a command that
// IGNORED the first abort and carried on would still end in an error — from the
// second form — and the test would pass while the abort was being swallowed.
// Measured: `_ = err` in place of the key picker's `return` left the suite green
// until this existed.
func authArmFormErrorOnce(t *testing.T, err error) {
	t.Helper()
	prev := runHuhForm
	first := true
	runHuhForm = func(...*huh.Group) error {
		if first {
			first = false
			return err
		}
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })
}

// authArmBrokenWriter fails every write, standing in for a closed pipe.
type authArmBrokenWriter struct{}

func (authArmBrokenWriter) Write([]byte) (int, error) { return 0, errors.New("pipe closed") }

// ── config ──────────────────────────────────────────────────────────────────────

// The underscore spellings are how the keys appear in config.json, and people
// type what they have read. Untested, "we accept the alias" is just a claim.
func TestAuthArm_ConfigKeyAliasesResolve(t *testing.T) {
	isolatedConfigHome(t)
	for _, alias := range []string{"web_origin", "WEB-ORIGIN", "  web-origin  ", "active_org"} {
		if f := lookupConfigField(alias); f == nil {
			t.Errorf("lookupConfigField(%q) = nil, want a field", alias)
		}
	}
	if f := lookupConfigField("nope"); f != nil {
		t.Errorf("lookupConfigField(\"nope\") = %+v, want nil", f)
	}
	// Through the command surface, not only the lookup: `config set web_origin` has
	// to write, and `config get web_origin` has to read the same key.
	if err := runConfigSet(io.Discard, "web_origin", "https://alias.example.com"); err != nil {
		t.Fatalf("set via alias: %v", err)
	}
	var buf strings.Builder
	if err := runConfigGet(&buf, ui.FormatTable, "web_origin"); err != nil {
		t.Fatalf("get via alias: %v", err)
	}
	if strings.TrimSpace(buf.String()) != "https://alias.example.com" {
		t.Errorf("get via alias = %q", buf.String())
	}
}

// `config get` with no key must be machine-readable under -o json too, not only
// as the two colon-separated lines the table format prints.
func TestAuthArm_ConfigGetAllHonoursMachineFormats(t *testing.T) {
	isolatedConfigHome(t)
	var buf strings.Builder
	if err := runConfigGet(&buf, ui.FormatJSON, ""); err != nil {
		t.Fatalf("get all json: %v", err)
	}
	for _, f := range configFields {
		if !strings.Contains(buf.String(), `"`+f.Key+`"`) {
			t.Errorf("json `get all` omits %q:\n%s", f.Key, buf.String())
		}
	}
	buf.Reset()
	if err := runConfigGet(&buf, ui.FormatCSV, ""); err != nil {
		t.Fatalf("get all csv: %v", err)
	}
	if !strings.Contains(buf.String(), "Key,Value") {
		t.Errorf("csv `get all` has no header:\n%s", buf.String())
	}
}

// The error messages list the keys DERIVED from the spec, so a new key joins them
// without anyone remembering. Before this they were four hand-typed lists that
// already disagreed with each other and with the docs.
func TestAuthArm_UnknownKeyErrorsListTheRealKeys(t *testing.T) {
	isolatedConfigHome(t)
	setErr := runConfigSet(io.Discard, "bogus", "x")
	getErr := runConfigGet(io.Discard, ui.FormatTable, "bogus")
	if setErr == nil || getErr == nil {
		t.Fatalf("an unknown key was accepted (set=%v get=%v)", setErr, getErr)
	}
	for _, f := range configFields {
		for _, err := range []error{setErr, getErr} {
			if !strings.Contains(err.Error(), f.Key) {
				t.Errorf("the refusal omits the real key %q: %v", f.Key, err)
			}
		}
	}
}

// An aborted key picker must not fall through into the value form with an empty
// key — that would ask for "the new value" of nothing.
func TestAuthArm_ConfigSetKeyFormAbortIsPropagated(t *testing.T) {
	isolatedConfigHome(t)
	authFormInteractive(t)
	// Only the KEY form aborts; the value form would succeed. A command that
	// swallowed the first abort would carry on with the picker's pre-seeded
	// default and return a perfectly plausible key the user never chose.
	authArmFormErrorOnce(t, errors.New("aborted"))
	key, value, err := promptConfigSet("", "")
	if err == nil {
		t.Fatalf("an aborted key picker returned %q/%q instead of an error", key, value)
	}
	if key != "" || value != "" {
		t.Errorf("an aborted picker still produced %q/%q", key, value)
	}
}

// The same for the value form, driven separately: the key form is skipped when a
// key was supplied, so this is the only invocation that reaches it.
func TestAuthArm_ConfigSetValueFormAbortIsPropagated(t *testing.T) {
	isolatedConfigHome(t)
	authFormInteractive(t)
	authArmFormError(t, errors.New("aborted"))
	if _, _, err := promptConfigSet("web-origin", ""); err == nil {
		t.Fatal("an aborted value form was reported as success")
	}
}

// A key that does not exist must be refused BEFORE the value form opens. Asking
// for the value of an unknown key and refusing afterwards wastes the answer.
func TestAuthArm_ConfigSetUnknownKeyIsRefusedBeforeTheValueForm(t *testing.T) {
	isolatedConfigHome(t)
	authFormInteractive(t)
	authFormNoForm(t)
	_, _, err := promptConfigSet("bogus", "")
	if err == nil {
		t.Fatal("an unknown key reached the value form")
	}
	if !strings.Contains(err.Error(), "web-origin") {
		t.Errorf("the refusal does not list the real keys: %v", err)
	}
}

// The empty-picker arm. It is unreachable while any key is settable — which is
// exactly why it is worth driving: an arm nobody can reach is an arm nobody has
// read, and a spec of read-only keys would otherwise open a form with nothing in
// it and return the empty string as if the user had chosen it.
func TestAuthArm_ConfigSetWithNoSettableKeysRefuses(t *testing.T) {
	isolatedConfigHome(t)
	authFormInteractive(t)
	authFormNoForm(t)
	prev := configFields
	configFields = []configField{{
		Key: "active-org", Summary: "read-only", SetVia: "alethia org switch",
		Read: func(types.CliConfig, string) string { return "" },
	}}
	t.Cleanup(func() { configFields = prev })

	if _, _, err := promptConfigSet("", ""); err == nil {
		t.Fatal("an empty picker was opened instead of an error")
	}
	if got := configKeyList(true); got != "" {
		t.Errorf("configKeyList(settable) = %q, want empty", got)
	}
}

// ── token ───────────────────────────────────────────────────────────────────────

func TestAuthArm_TokenCreateFormAbortIsPropagated(t *testing.T) {
	authFormInteractive(t)
	authArmFormError(t, errors.New("aborted"))
	name, days, err := promptTokenCreate("", 30)
	if err == nil {
		t.Fatalf("an aborted form returned %q/%d instead of an error", name, days)
	}
	// Nothing half-answered leaks out: a caller that ignored the error must not
	// find a plausible-looking name in its hands.
	if name != "" || days != 0 {
		t.Errorf("an aborted form still produced %q/%d", name, days)
	}
}

func TestAuthArm_TokenRevokePickerReportsAListingFailure(t *testing.T) {
	authFormInteractive(t)
	authFormNoForm(t)
	_, err := selectServiceToken(&fakeClient{err: errors.New("boom")})
	if err == nil {
		t.Fatal("a failed listing opened an empty picker")
	}
}

func TestAuthArm_TokenRevokePickerAbortIsPropagated(t *testing.T) {
	authFormInteractive(t)
	authArmFormError(t, errors.New("aborted"))
	c := &fakeClient{serviceTokens: []api.ServiceToken{{ID: "t1", Name: "ci"}}}
	id, err := selectServiceToken(c)
	if err == nil {
		t.Fatalf("an aborted picker returned %q instead of an error", id)
	}
	if id != "" {
		t.Errorf("an aborted picker still produced %q — a revoke would have run on it", id)
	}
}

// The token's METADATA is written to stderr through the shared card. A failed
// write there must be reported, not swallowed: the alternative is a command that
// prints the credential on stdout and reports success having shown the operator
// none of the context — which id it is, when it expires — they need to record it.
//
// It must be reported AFTER the credential has been written, though. The token is
// minted by the time the card renders, the server keeps only its hash, and this is
// the only moment it is ever shown — so a stderr that cannot be written to
// (`… > token.txt 2>&-`) must cost the operator the decoration, never the value.
func TestAuthArm_TokenCreateReportsAFailedCardWrite(t *testing.T) {
	c := &fakeClient{createdToken: &api.CreatedServiceToken{
		ID: "t1", Name: "ci", TokenPrefix: "alethia_sat_abc12345", Token: "secret", Warning: "once",
	}}
	var out strings.Builder
	err := runTokenCreate(c, &out, authArmBrokenWriter{}, ui.FormatTable, "ci", 0)
	if err == nil {
		t.Fatal("a failed write of the token card was reported as success")
	}
	if !strings.Contains(out.String(), "secret") {
		t.Errorf("the minted token never reached stdout (%q) — it is unrecoverable now", out.String())
	}
}

// `alethia token revoke "$TOKEN_ID"` with the variable unset must not send a
// request naming nothing. A blank argument counts as absent, so the command
// reaches the picker (or, scripted, the --no-input refusal) instead of a 404 that
// reads as "that token does not exist".
func TestAuthArm_TokenRevokeTreatsABlankArgumentAsAbsent(t *testing.T) {
	s, run := hygCliConfirmEnv(t)
	hygCliConfirmInteractive(t)
	prev := selectServiceToken
	asked := false
	selectServiceToken = func(apiClient) (string, error) { asked = true; return "picked-1", nil }
	t.Cleanup(func() { selectServiceToken = prev })

	if code := run("token", "revoke", "   "); code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if !asked {
		t.Error("a blank id was passed straight through instead of reaching the picker")
	}
	if s.saw("DELETE", "/api/cli/tokens/") {
		t.Errorf("a revoke naming no token was sent: %v", s.requests)
	}
	if !s.saw("DELETE", "/api/cli/tokens/picked-1") {
		t.Errorf("the picked id did not reach the revoke call: %v", s.requests)
	}
}

// ── the fatal arms, through the real command tree ───────────────────────────────

// Each `Run:` ends its prompt in fail(err) → exitFunc. Those are ordinary
// statements that can be wrong — an arm that returns instead of exiting would let
// the command continue with an empty answer — so they are executed rather than
// left as the only unread lines in the group.
func TestAuthArm_PromptFailuresExitNonZero(t *testing.T) {
	t.Run("token create", func(t *testing.T) {
		_, run := hygCliConfirmEnv(t)
		hygCliConfirmInteractive(t)
		prev := promptTokenCreate
		promptTokenCreate = func(string, int) (string, int, error) { return "", 0, errors.New("aborted") }
		t.Cleanup(func() { promptTokenCreate = prev })
		if code := run("token", "create"); code != 1 {
			t.Errorf("exit code = %d, want 1", code)
		}
	})

	t.Run("token revoke", func(t *testing.T) {
		s, run := hygCliConfirmEnv(t)
		hygCliConfirmInteractive(t)
		prev := selectServiceToken
		selectServiceToken = func(apiClient) (string, error) { return "", errors.New("aborted") }
		t.Cleanup(func() { selectServiceToken = prev })
		if code := run("token", "revoke"); code != 1 {
			t.Errorf("exit code = %d, want 1", code)
		}
		if muts := s.mutations(); len(muts) > 0 {
			t.Errorf("an aborted picker still revoked something: %v", muts)
		}
	})

	t.Run("config set", func(t *testing.T) {
		_, run := hygCliConfirmEnv(t)
		hygCliConfirmInteractive(t)
		prev := promptConfigSet
		promptConfigSet = func(string, string) (string, string, error) { return "", "", errors.New("aborted") }
		t.Cleanup(func() { promptConfigSet = prev })
		if code := run("config", "set"); code != 1 {
			t.Errorf("exit code = %d, want 1", code)
		}
	})
}

// `config set web-origin` can succeed and still leave every command talking to a
// different origin, because $ALETHIA_WEB_ORIGIN outranks the file. Saying so is
// the difference between a setting that did not take and a setting that did not
// take AND said it did.
func TestAuthArm_ConfigSetWarnsWhenTheEnvironmentOutranksIt(t *testing.T) {
	isolatedConfigHome(t)
	t.Setenv("ALETHIA_WEB_ORIGIN", "https://from-the-env.example.com")
	var buf strings.Builder
	if err := runConfigSet(&buf, "web-origin", "https://from-the-file.example.com"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if !strings.Contains(buf.String(), "ALETHIA_WEB_ORIGIN") {
		t.Errorf("the write is reported as effective while the environment overrides it:\n%s", buf.String())
	}
	// And it must NOT cry wolf when the environment agrees, or the note becomes
	// noise on every scripted run and stops being read.
	buf.Reset()
	t.Setenv("ALETHIA_WEB_ORIGIN", "https://agreed.example.com")
	if err := runConfigSet(&buf, "web-origin", "https://agreed.example.com"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if strings.Contains(buf.String(), "ALETHIA_WEB_ORIGIN") {
		t.Errorf("the note fired although the environment agrees:\n%s", buf.String())
	}
}
