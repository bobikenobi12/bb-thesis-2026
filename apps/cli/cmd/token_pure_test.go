// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func ptr(s string) *string { return &s }

// The status word is the whole content of the column, so the precedence between "revoked" and
// "expired" is a real decision rather than a formatting detail. Both mean inactive; only one means
// somebody acted.
func TestTokenStatusPrefersRevokedOverExpired(t *testing.T) {
	past := time.Now().Add(-24 * time.Hour).Format(time.RFC3339)
	future := time.Now().Add(24 * time.Hour).Format(time.RFC3339)

	cases := []struct {
		name string
		in   api.ServiceToken
		want string
	}{
		{"nothing set", api.ServiceToken{}, "active"},
		{"expiry in the future", api.ServiceToken{ExpiresAt: ptr(future)}, "active"},
		{"expiry in the past", api.ServiceToken{ExpiresAt: ptr(past)}, "expired"},
		{"revoked", api.ServiceToken{RevokedAt: ptr(past)}, "revoked"},
		// A token revoked in response to a leak must NEVER be reported as having merely aged out.
		// Which of the two happened is the fact an incident needs.
		{"revoked AND expired", api.ServiceToken{RevokedAt: ptr(past), ExpiresAt: ptr(past)}, "revoked"},
		// Empty strings are what a JSON null becomes on some paths; they must not read as "set".
		{"empty revoked string is not revoked", api.ServiceToken{RevokedAt: ptr("")}, "active"},
		{"empty expiry string is not expired", api.ServiceToken{ExpiresAt: ptr("")}, "active"},
		// An unparseable timestamp must not silently become "expired" — that would report a live
		// token as dead and send somebody to mint a replacement they do not need.
		{"unparseable expiry stays active", api.ServiceToken{ExpiresAt: ptr("soon-ish")}, "active"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tokenStatus(tc.in); got != tc.want {
				t.Errorf("tokenStatus = %q, want %q", got, tc.want)
			}
		})
	}
}

// "never" and "—" are not interchangeable. A token that has NEVER been used is the most actionable
// row in the list — the one somebody minted, put somewhere wrong, and forgot — and a dash reads as
// missing data rather than as a finding.
func TestStampRenderingDistinguishesNeverFromAbsent(t *testing.T) {
	if got := ui.StampOrNever(nil); got != "never" {
		t.Errorf("an unused token renders %q, want \"never\"", got)
	}
	if got := ui.StampOrNever(ptr("   ")); got != "never" {
		t.Errorf("whitespace renders %q, want \"never\"", got)
	}
	// A REAL timestamp must delegate to stampOrDash rather than being swallowed by the "never" arm —
	// otherwise a token that HAS been used would report that it never was, which is the exact
	// distinction this pair exists to make.
	used := "2026-08-26T09:41:00Z"
	if got := ui.StampOrNever(&used); got != "26 Aug 2026, 09:41" {
		t.Errorf("a used token renders %q, want the console's absolute date in UTC", got)
	}
	if got := ui.StampOrDash(nil); got != "—" {
		t.Errorf("an absent timestamp renders %q, want an em dash", got)
	}
	stamp := "2026-08-26T09:41:00Z"
	// #3659 converged StampOrDash onto Stamp's layout; what it still owns is the DASH below.
	if got := ui.StampOrDash(&stamp); got != "26 Aug 2026, 09:41" {
		t.Errorf("stampOrDash = %q, want the console's absolute date in UTC", got)
	}
	// An unparseable value is shown VERBATIM rather than swallowed: a reader can act on a weird
	// string, and cannot act on a dash that hid one.
	if got := ui.StampOrDash(ptr("tomorrow")); got != "tomorrow" {
		t.Errorf("an unparseable stamp renders %q, want it verbatim", got)
	}
}

// The API type must not carry a field that implies the plaintext is retrievable. It is not: the
// server stores only a SHA-256, and no route reads it back. A `Token` field on the LIST type would
// quietly promise otherwise, and somebody would eventually build against the promise.
func TestServiceTokenListTypeCarriesNoSecret(t *testing.T) {
	rows := tokenRows([]api.ServiceToken{{
		ID: "id-1", Name: "ci", TokenPrefix: "alethia_sat_abc12345",
		CreatedAt: "2026-08-26T09:41:00Z",
	}}, ui.FormatTable)
	if len(rows) != 1 {
		t.Fatalf("want 1 row, got %d", len(rows))
	}
	joined := strings.Join(rows[0], "|")
	// The PREFIX is fine to show — it is how a reader matches a row against a leaked string. What
	// must never appear is a full-length secret.
	if strings.Contains(joined, "alethia_sat_") && len(rows[0][2]) > len("alethia_sat_")+12 {
		t.Errorf("the prefix column looks like a full token: %q", rows[0][2])
	}
	if !strings.Contains(joined, "never") {
		t.Errorf("a never-used token must say so, got %q", joined)
	}
}

// The NON-INTERACTIVE credential's precedence, which is a documented promise: the --token flag wins
// over $ALETHIA_TOKEN, and the docs tell users to prefer the environment variable in CI because a
// flag value lands in the process table and in shell history. Untested, that is just a claim.
func TestServiceTokenPrecedence(t *testing.T) {
	original := serviceTokenFlag
	t.Cleanup(func() { serviceTokenFlag = original })

	cases := []struct {
		name string
		flag string
		env  string
		want string
	}{
		{"neither supplied", "", "", ""},
		{"environment only", "", "env-token", "env-token"},
		{"flag only", "flag-token", "", "flag-token"},
		// The more specific, more deliberate source is the one nearer the invocation.
		{"flag WINS over the environment", "flag-token", "env-token", "flag-token"},
		// A token pasted into a CI secret picks up a trailing newline more often than not, and a
		// credential that fails for an invisible reason is the worst kind to debug.
		{"surrounding whitespace is trimmed", "", "  env-token\n", "env-token"},
		{"a whitespace-only flag falls through to the environment", "   ", "env-token", "env-token"},
		{"whitespace-only everywhere is no token at all", "  ", "   ", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			serviceTokenFlag = tc.flag
			t.Setenv(ServiceTokenEnv, tc.env)
			if got := serviceToken(); got != tc.want {
				t.Errorf("serviceToken() = %q, want %q", got, tc.want)
			}
		})
	}
}

// The whole point of the feature: with a token supplied, NOTHING is read from or written to disk.
// A CI runner has no home directory worth persisting to, and a credential written to one is a
// credential left behind.
func TestServiceTokenShortCircuitsTheCredentialsFile(t *testing.T) {
	original := serviceTokenFlag
	t.Cleanup(func() { serviceTokenFlag = original })
	serviceTokenFlag = ""

	// Point HOME at an empty directory: with no token, resolving would have to fall through to the
	// credentials file (and, absent one, to the login prompt). With a token, it must not look.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv(ServiceTokenEnv, "alethia_sat_from-the-environment")

	got, err := getAuthTokenInternal(false)
	if err != nil {
		t.Fatalf("a supplied token still errored: %v", err)
	}
	if got != "alethia_sat_from-the-environment" {
		t.Errorf("got %q, want the supplied token", got)
	}
	// Nothing was written. A credentials file appearing here would mean the short-circuit ran and
	// then persisted anyway.
	if _, statErr := os.Stat(filepath.Join(home, ".config", "alethia", "credentials.json")); statErr == nil {
		t.Error("a credentials file was written despite the token short-circuit")
	}
}

// ── The command bodies, driven through the same client/writer/format seam runOrgList uses. ──

func TestRunTokenList(t *testing.T) {
	var buf bytes.Buffer
	c := &fakeClient{serviceTokens: []api.ServiceToken{
		{ID: "t1", Name: "github-actions", TokenPrefix: "alethia_sat_abc12345", CreatedAt: "2026-08-26T09:00:00Z"},
	}}
	if err := runTokenList(c, &buf, ui.FormatTable); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{"github-actions", "alethia_sat_abc12345", "never", "active"} {
		if !strings.Contains(buf.String(), want) {
			t.Errorf("the table drops %q:\n%s", want, buf.String())
		}
	}

	// An EMPTY list in table mode says what to do next; in a machine format it must stay machine
	// readable rather than emitting prose a parser would choke on.
	buf.Reset()
	empty := &fakeClient{}
	if err := runTokenList(empty, &buf, ui.FormatTable); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(buf.String(), "token create") {
		t.Errorf("the empty case does not say how to create one:\n%s", buf.String())
	}
	buf.Reset()
	if err := runTokenList(empty, &buf, "json"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(buf.String(), "token create") {
		t.Errorf("json mode emitted prose:\n%s", buf.String())
	}

	if err := runTokenList(&fakeClient{err: errors.New("boom")}, &buf, ui.FormatTable); err == nil {
		t.Error("a client error was swallowed")
	}
}

func TestRunTokenCreate(t *testing.T) {
	// A name is REQUIRED, and the failure must not reach the client — minting an unnamed credential
	// is how a token list becomes a list of prefixes nobody can identify.
	c := &fakeClient{}
	if err := runTokenCreate(c, io.Discard, io.Discard, ui.FormatTable, "   ", 0); err == nil {
		t.Fatal("an empty name was accepted")
	}
	if c.createdTokenName != "" {
		t.Error("the client was called despite the empty name")
	}

	// THE SPLIT THAT MAKES THE PIPE WORK: the token on stdout, everything else on stderr.
	var out, errOut bytes.Buffer
	c = &fakeClient{createdToken: &api.CreatedServiceToken{
		ID: "t1", Name: "ci", TokenPrefix: "alethia_sat_abc12345",
		Token: "alethia_sat_abc12345-the-rest", Warning: "Copy this token now",
	}}
	if err := runTokenCreate(c, &out, &errOut, ui.FormatTable, "ci", 90); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.TrimSpace(out.String()) != "alethia_sat_abc12345-the-rest" {
		t.Errorf("stdout must carry the token and NOTHING else, got %q", out.String())
	}
	if !strings.Contains(errOut.String(), "Copy this token now") {
		t.Errorf("the once-only warning did not reach stderr:\n%s", errOut.String())
	}
	if strings.Contains(errOut.String(), "alethia_sat_abc12345-the-rest") {
		t.Error("the full token leaked onto stderr — a pipe would then be the only safe use")
	}
	if c.createdTokenName != "ci" || c.createdTokenExpiry != 90 {
		t.Errorf("name/expiry not passed through: %q %d", c.createdTokenName, c.createdTokenExpiry)
	}

	// A machine format renders one row and no prose.
	out.Reset()
	if err := runTokenCreate(c, &out, io.Discard, "json", "ci", 0); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out.String(), "alethia_sat_abc12345-the-rest") {
		t.Errorf("json mode dropped the token:\n%s", out.String())
	}

	if err := runTokenCreate(&fakeClient{err: errors.New("boom")}, io.Discard, io.Discard, ui.FormatTable, "ci", 0); err == nil {
		t.Error("a client error was swallowed")
	}
}

func TestRunTokenRevoke(t *testing.T) {
	var buf bytes.Buffer
	c := &fakeClient{}
	if err := runTokenRevoke(c, &buf, "t1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.revokedTokenID != "t1" {
		t.Errorf("the id was not passed through: %q", c.revokedTokenID)
	}
	// The confirmation states WHEN it takes effect. "Revoked" alone leaves a reader wondering
	// whether a running pipeline keeps working.
	if !strings.Contains(buf.String(), "next request") {
		t.Errorf("the confirmation does not say when it takes effect:\n%s", buf.String())
	}

	if err := runTokenRevoke(&fakeClient{err: errors.New("boom")}, io.Discard, "t1"); err == nil {
		t.Error("a client error was swallowed")
	}
}
