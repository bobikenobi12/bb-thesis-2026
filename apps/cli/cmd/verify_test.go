// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

// --- fixtures -------------------------------------------------------------------------------

// sampleReport is a report with one of every status, so rendering and the summary line are
// exercised over the interesting cases rather than an all-pass happy path.
func sampleReport() *verify.Report {
	return &verify.Report{
		Verdict:        verify.StatusNotEvaluable,
		CatalogVersion: "elench-controls-0.5.2",
		Provider:       "aws",
		Controls: []verify.ControlResult{
			{ID: "KEYLESS-001", Title: "No static cloud credentials", Severity: verify.SeverityHigh, Status: verify.StatusPass, Provider: "aws"},
			{ID: "LEASTPRIV-001", Title: "No wildcard admin policy", Severity: verify.SeverityHigh, Status: verify.StatusWarn, Provider: "aws",
				Findings: []verify.Finding{{Address: "aws_iam_policy.admin", Message: "policy grants *:*"}}},
			{ID: "OIDC-001", Title: "OIDC trust is scoped", Severity: verify.SeverityMedium, Status: verify.StatusNotEvaluable, Provider: "aws",
				Coverage: "no OIDC provider in the plan"},
		},
		Summary: verify.Summary{Pass: 1, Warn: 1, NotEvaluable: 1},
	}
}

// failingReport carries a blocking verdict, for the exit-status path.
func failingReport() *verify.Report {
	return &verify.Report{
		Verdict:        verify.StatusFail,
		CatalogVersion: "elench-controls-0.5.2",
		Provider:       "aws",
		Controls: []verify.ControlResult{
			{ID: "KEYLESS-001", Title: "No static cloud credentials", Severity: verify.SeverityHigh, Status: verify.StatusFail, Provider: "aws",
				Findings: []verify.Finding{{Address: "aws_iam_access_key.ci", Message: "static access key created"}}},
		},
		Summary: verify.Summary{Fail: 1},
	}
}

// signedFixture builds and signs a receipt, returning it with the key that signed it.
func signedFixture(t *testing.T, report *verify.Report) (*verify.SignedReceipt, ed25519.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	r := verify.BuildReceipt(verify.BuildReceiptParams{
		Report:      report,
		PlanBytes:   []byte("a binary tofu plan"),
		TofuVersion: "1.9.0",
		Runner:      "runner-abc",
		EvaluatedAt: "2026-08-11T04:00:00Z",
	})
	sr, err := verify.Sign(r, priv, verify.KeyID(pub))
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return sr, pub
}

// jobWithReceipt puts a receipt on a job the way the wire delivers it: JSON, decoded into the
// untyped map that api.ProvisionJob.ExecutionMetadata actually is.
//
// This is deliberately not a struct hand-off. The signature is checked over
// json.Marshal(Receipt), so the map round trip IS the thing under test — if the console, the
// zod contract or Go's own encoding altered one byte in transit, every test here would fail
// with a bogus "tampered" verdict, which is exactly the regression worth catching.
func jobWithReceipt(t *testing.T, sr *verify.SignedReceipt) *api.ProvisionJob {
	t.Helper()
	blob, err := json.Marshal(sr)
	if err != nil {
		t.Fatalf("marshal receipt: %v", err)
	}
	var asAny interface{}
	if err := json.Unmarshal(blob, &asAny); err != nil {
		t.Fatalf("unmarshal receipt: %v", err)
	}
	meta := map[string]interface{}{"verify_receipt": asAny}
	return &api.ProvisionJob{ID: "job-1", ExecutionMetadata: &meta}
}

// platformKeySet is the trusted-key set as the control plane serves it.
func platformKeySet(pub ed25519.PublicKey) []api.SigningKey {
	return []api.SigningKey{{
		KeyID:     verify.KeyID(pub),
		PublicKey: base64.StdEncoding.EncodeToString(pub),
		Algorithm: "ed25519",
		Source:    "platform",
		Active:    true,
	}}
}

func orgKeySet(pub ed25519.PublicKey) []api.SigningKey {
	return []api.SigningKey{{
		KeyID:     verify.KeyID(pub),
		PublicKey: base64.StdEncoding.EncodeToString(pub),
		Algorithm: "ed25519",
		Source:    "org",
		Provider:  "aws",
		Status:    "active",
		Active:    true,
	}}
}

// --- the round trip -------------------------------------------------------------------------

// The premise the whole command rests on: a receipt that crossed the wire as untyped JSON still
// verifies. If this breaks, `alethia verify receipt` reports TAMPERED on legitimate evidence.
func TestReceiptSurvivesTheWireRoundTrip(t *testing.T) {
	sr, pub := signedFixture(t, sampleReport())
	job := jobWithReceipt(t, sr)

	got, err := receiptFromJob(job)
	if err != nil {
		t.Fatalf("receiptFromJob: %v", err)
	}
	if err := got.VerifySelf(); err != nil {
		t.Errorf("VerifySelf after the wire round trip: %v", err)
	}
	if err := got.Verify(pub); err != nil {
		t.Errorf("Verify after the wire round trip: %v", err)
	}
}

func TestReceiptFromJobRejectsWhatItCannotRead(t *testing.T) {
	meta := map[string]interface{}{}
	nilReceipt := map[string]interface{}{"verify_receipt": nil}
	badReceipt := map[string]interface{}{"verify_receipt": "not an object"}

	cases := []struct {
		name string
		job  *api.ProvisionJob
		want error
	}{
		{"nil job", nil, errNoReceipt},
		{"no metadata", &api.ProvisionJob{ID: "j"}, errNoReceipt},
		{"metadata without a receipt", &api.ProvisionJob{ID: "j", ExecutionMetadata: &meta}, errNoReceipt},
		{"explicit null receipt", &api.ProvisionJob{ID: "j", ExecutionMetadata: &nilReceipt}, errNoReceipt},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := receiptFromJob(tc.job); !errors.Is(err, tc.want) {
				t.Errorf("want %v, got %v", tc.want, err)
			}
		})
	}

	t.Run("receipt of the wrong shape", func(t *testing.T) {
		_, err := receiptFromJob(&api.ProvisionJob{ID: "j", ExecutionMetadata: &badReceipt})
		if err == nil || !strings.Contains(err.Error(), "decode receipt") {
			t.Errorf("want a decode error, got %v", err)
		}
	})
}

// --- key handling ---------------------------------------------------------------------------

func TestDecodePublicKey(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	good := base64.StdEncoding.EncodeToString(pub)

	if _, err := decodePublicKey(good); err != nil {
		t.Errorf("valid key rejected: %v", err)
	}
	if _, err := decodePublicKey("  " + good + "\n"); err != nil {
		t.Errorf("surrounding whitespace should be tolerated: %v", err)
	}
	if _, err := decodePublicKey("!!not base64!!"); err == nil {
		t.Error("expected a base64 error")
	}
	if _, err := decodePublicKey(base64.StdEncoding.EncodeToString([]byte("short"))); err == nil {
		t.Error("expected a length error")
	}
}

func TestPinnedKey(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	b64 := base64.StdEncoding.EncodeToString(pub)

	t.Run("neither flag", func(t *testing.T) {
		got, err := pinnedKey("", "")
		if err != nil || got != nil {
			t.Errorf("want (nil, nil), got (%v, %v)", got, err)
		}
	})
	t.Run("both flags", func(t *testing.T) {
		if _, err := pinnedKey(b64, "/tmp/x"); err == nil {
			t.Error("expected a refusal when both are set")
		}
	})
	t.Run("literal key", func(t *testing.T) {
		got, err := pinnedKey(b64, "")
		if err != nil || !got.Equal(pub) {
			t.Errorf("want the key back, got (%v, %v)", got, err)
		}
	})
	t.Run("bad literal key", func(t *testing.T) {
		if _, err := pinnedKey("nope", ""); err == nil || !strings.Contains(err.Error(), "--key") {
			t.Errorf("want a --key error, got %v", err)
		}
	})
	t.Run("key file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "key.pub")
		if err := os.WriteFile(path, []byte(b64+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		got, err := pinnedKey("", path)
		if err != nil || !got.Equal(pub) {
			t.Errorf("want the key back, got (%v, %v)", got, err)
		}
	})
	t.Run("missing key file", func(t *testing.T) {
		if _, err := pinnedKey("", filepath.Join(t.TempDir(), "absent")); err == nil ||
			!strings.Contains(err.Error(), "--key-file") {
			t.Errorf("want a --key-file error, got %v", err)
		}
	})
	t.Run("key file with junk", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "junk.pub")
		if err := os.WriteFile(path, []byte("not a key"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := pinnedKey("", path); err == nil {
			t.Error("expected a decode error")
		}
	})
}

func TestNewTrustedKeysSkipsUnusableRows(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keys := []api.SigningKey{
		{KeyID: "", PublicKey: base64.StdEncoding.EncodeToString(pub)}, // no id
		{KeyID: "bad", PublicKey: "!!not base64!!"},                    // undecodable
		{KeyID: "short", PublicKey: base64.StdEncoding.EncodeToString([]byte("nope"))},
		{KeyID: verify.KeyID(pub), PublicKey: base64.StdEncoding.EncodeToString(pub), Source: "org"},
	}
	tk := newTrustedKeys(keys)
	if len(tk.byKeyID) != 1 {
		t.Errorf("want only the usable key indexed, got %d", len(tk.byKeyID))
	}
	if _, ok := tk.PublicKeyForKeyID(verify.KeyID(pub)); !ok {
		t.Error("the usable key should resolve")
	}
	if _, ok := tk.PublicKeyForKeyID("absent"); ok {
		t.Error("an unknown key_id must not resolve")
	}
	if got := tk.sourceFor(verify.KeyID(pub)); got != trustOrg {
		t.Errorf("want %q, got %q", trustOrg, got)
	}
	// An unresolved id vouches for nothing — it must NOT read as the platform key.
	if got := tk.sourceFor("absent"); got != trustNone {
		t.Errorf("an unresolved id must earn no trust, got %q", got)
	}
}

// A trust label must never overstate. A custody model this CLI predates is reported verbatim,
// never relabelled as one of the two sources it happens to know.
func TestSourceForDoesNotRelabelAnUnknownCustodyModel(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tk := newTrustedKeys([]api.SigningKey{{
		KeyID:     verify.KeyID(pub),
		PublicKey: base64.StdEncoding.EncodeToString(pub),
		Source:    "hsm-consortium",
	}})
	got := tk.sourceFor(verify.KeyID(pub))
	if got == trustPlatform || got == trustOrg {
		t.Errorf("an unknown source was relabelled as %q — the label would claim custody nothing checked", got)
	}
	if string(got) != "hsm-consortium" {
		t.Errorf("want the source reported verbatim, got %q", got)
	}
}

// The contradiction arm: a key set that resolves a key_id for verification but then reports no
// source for it is inconsistent, and an inconsistent trust answer must fail closed rather than
// pick a plausible-sounding label.
func TestVerifyReceiptFailsClosedOnAnInconsistentKeySet(t *testing.T) {
	sr, pub := signedFixture(t, sampleReport())
	// Source "" resolves for verification but earns no named trust level.
	keys := []api.SigningKey{{
		KeyID:     verify.KeyID(pub),
		PublicKey: base64.StdEncoding.EncodeToString(pub),
		Source:    "",
	}}
	v, err := verifyReceipt(sr, func() ([]api.SigningKey, error) { return keys, nil }, verifyOpts{})
	if err == nil {
		t.Fatalf("an inconsistent key set must not yield a clean pass, got %+v", v)
	}
	if !strings.Contains(err.Error(), "could not establish who signed") {
		t.Errorf("want a who-signed failure, got %v", err)
	}
}

// ...and the reason string must follow the label rather than asserting the platform key.
func TestVerifyReceiptReasonMatchesAnUnknownSource(t *testing.T) {
	sr, pub := signedFixture(t, sampleReport())
	keys := []api.SigningKey{{
		KeyID:     verify.KeyID(pub),
		PublicKey: base64.StdEncoding.EncodeToString(pub),
		Source:    "hsm-consortium",
	}}
	v, err := verifyReceipt(sr, func() ([]api.SigningKey, error) { return keys, nil }, verifyOpts{})
	if err != nil {
		t.Fatalf("a vouched-for key must verify: %v", err)
	}
	if strings.Contains(v.Reason, "platform key") {
		t.Errorf("the reason claims the platform key for an unknown source: %q", v.Reason)
	}
	if !strings.Contains(v.Reason, "hsm-consortium") {
		t.Errorf("want the source named in the reason, got %q", v.Reason)
	}
}

// A row whose public key stops decoding between indexing and lookup must fail closed rather
// than return a zero-length key that ed25519.Verify would reject confusingly.
func TestPublicKeyForKeyIDFailsClosedOnACorruptedRow(t *testing.T) {
	tk := &trustedKeys{byKeyID: map[string]api.SigningKey{
		"k": {KeyID: "k", PublicKey: "!!not base64!!"},
	}}
	if _, ok := tk.PublicKeyForKeyID("k"); ok {
		t.Error("a corrupted row must not resolve")
	}
}

// --- verify receipt -------------------------------------------------------------------------

func TestRunVerifyReceiptTrustedByThePlatformKey(t *testing.T) {
	sr, pub := signedFixture(t, sampleReport())
	c := &fakeClient{job: jobWithReceipt(t, sr), signingKeys: platformKeySet(pub)}

	var buf bytes.Buffer
	if err := runVerifyReceipt(c, &buf, "table", "job-1", verifyOpts{}); err != nil {
		t.Fatalf("want a clean verification, got %v", err)
	}
	out := buf.String()
	for _, want := range []string{"Alethia platform key", "platform", verify.KeyID(pub), "ed25519", "Sealed to plan"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestRunVerifyReceiptTrustedByTheOrgKey(t *testing.T) {
	sr, pub := signedFixture(t, sampleReport())
	c := &fakeClient{job: jobWithReceipt(t, sr), signingKeys: orgKeySet(pub)}

	var buf bytes.Buffer
	if err := runVerifyReceipt(c, &buf, "table", "job-1", verifyOpts{}); err != nil {
		t.Fatalf("want a clean verification, got %v", err)
	}
	if out := buf.String(); !strings.Contains(out, "organization's own recorded key") {
		t.Errorf("an org-signed receipt must say so:\n%s", out)
	}
}

func TestRunVerifyReceiptJSONCarriesTheVerdictAndTheReceipt(t *testing.T) {
	sr, pub := signedFixture(t, sampleReport())
	c := &fakeClient{job: jobWithReceipt(t, sr), signingKeys: platformKeySet(pub)}

	var buf bytes.Buffer
	if err := runVerifyReceipt(c, &buf, "json", "job-1", verifyOpts{}); err != nil {
		t.Fatalf("runVerifyReceipt: %v", err)
	}
	var got receiptVerification
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("json output does not decode: %v\n%s", err, buf.String())
	}
	if !got.OK || !got.Signature.Verified {
		t.Errorf("want ok+verified, got %+v", got.Signature)
	}
	if got.Signature.Trust != string(trustPlatform) {
		t.Errorf("want trust %q, got %q", trustPlatform, got.Signature.Trust)
	}
	if got.Receipt == nil || got.Receipt.Receipt.PlanSHA256 == "" {
		t.Error("the json output must carry the receipt itself, sealed hash and all")
	}
	// The emitted receipt must still verify — the point of -o json is that it can be re-checked.
	if err := got.Receipt.Verify(pub); err != nil {
		t.Errorf("the receipt as emitted no longer verifies: %v", err)
	}
}

func TestRunVerifyReceiptCSV(t *testing.T) {
	sr, pub := signedFixture(t, sampleReport())
	c := &fakeClient{job: jobWithReceipt(t, sr), signingKeys: platformKeySet(pub)}

	var buf bytes.Buffer
	if err := runVerifyReceipt(c, &buf, "csv", "job-1", verifyOpts{}); err != nil {
		t.Fatalf("runVerifyReceipt: %v", err)
	}
	if out := buf.String(); !strings.Contains(out, "Field,Value") {
		t.Errorf("csv should emit field/value rows:\n%s", out)
	}
}

// An unsigned receipt is a legitimate state, but it is not evidence — so it fails by default
// and only --allow-unsigned forgives it.
func TestRunVerifyReceiptUnsigned(t *testing.T) {
	sr, _ := signedFixture(t, sampleReport())
	unsigned := &verify.SignedReceipt{Receipt: sr.Receipt, Algorithm: "none"}
	job := jobWithReceipt(t, unsigned)

	var buf bytes.Buffer
	err := runVerifyReceipt(&fakeClient{job: job}, &buf, "table", "job-1", verifyOpts{})
	if err == nil || !strings.Contains(err.Error(), "unsigned") {
		t.Errorf("want an unsigned failure, got %v", err)
	}
	if !strings.Contains(buf.String(), "unsigned") {
		t.Errorf("the report must still print on failure:\n%s", buf.String())
	}

	buf.Reset()
	if err := runVerifyReceipt(&fakeClient{job: job}, &buf, "table", "job-1",
		verifyOpts{allowUnsigned: true}); err != nil {
		t.Errorf("--allow-unsigned should exit clean, got %v", err)
	}
}

// Tampering is fatal no matter which flags are set: the document does not match its own
// signature, and no policy flag can make that acceptable.
func TestRunVerifyReceiptTamperedIsFatalRegardlessOfFlags(t *testing.T) {
	sr, pub := signedFixture(t, sampleReport())
	sr.Receipt.Verdict = verify.StatusPass // rewrite the verdict after signing
	job := jobWithReceipt(t, sr)

	for _, opts := range []verifyOpts{
		{},
		{allowUnsigned: true, allowUntrusted: true},
	} {
		var buf bytes.Buffer
		c := &fakeClient{job: job, signingKeys: platformKeySet(pub)}
		err := runVerifyReceipt(c, &buf, "table", "job-1", opts)
		if err == nil || !strings.Contains(err.Error(), "altered after it was signed") {
			t.Errorf("opts %+v: want a tamper failure, got %v", opts, err)
		}
	}
}

// The forged-receipt shape: internally consistent, self-verifies, but signed by a key the org
// does not vouch for. This is precisely what VerifySelf alone would wave through.
func TestRunVerifyReceiptRejectsAKeyNobodyVouchesFor(t *testing.T) {
	sr, _ := signedFixture(t, sampleReport())
	otherPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	job := jobWithReceipt(t, sr)
	c := &fakeClient{job: job, signingKeys: platformKeySet(otherPub)}

	var buf bytes.Buffer
	err = runVerifyReceipt(c, &buf, "table", "job-1", verifyOpts{})
	if err == nil || !strings.Contains(err.Error(), "does not vouch for") {
		t.Errorf("want an untrusted-key failure, got %v", err)
	}

	buf.Reset()
	c2 := &fakeClient{job: job, signingKeys: platformKeySet(otherPub)}
	if err := runVerifyReceipt(c2, &buf, "table", "job-1", verifyOpts{allowUntrusted: true}); err != nil {
		t.Errorf("--allow-untrusted should exit clean, got %v", err)
	}
	if out := buf.String(); !strings.Contains(out, "self") {
		t.Errorf("a forgiven receipt must still be labelled self-verified only:\n%s", out)
	}
}

// An older control plane has no signing-keys endpoint. The command must degrade honestly, not
// hard-fail every user and not silently claim trust.
func TestRunVerifyReceiptDegradesWhenTheKeySetIsUnavailable(t *testing.T) {
	sr, _ := signedFixture(t, sampleReport())
	job := jobWithReceipt(t, sr)
	notFound := &api.APIError{StatusCode: 404, Message: "Not Found"}

	var buf bytes.Buffer
	err := runVerifyReceipt(&fakeClient{job: job, signingKeysErr: notFound}, &buf, "table", "job-1", verifyOpts{})
	if err == nil || !strings.Contains(err.Error(), "could not establish who signed") {
		t.Errorf("want a trust-unavailable failure, got %v", err)
	}

	buf.Reset()
	if err := runVerifyReceipt(&fakeClient{job: job, signingKeysErr: notFound}, &buf, "table", "job-1",
		verifyOpts{allowUntrusted: true}); err != nil {
		t.Errorf("--allow-untrusted should exit clean, got %v", err)
	}
	if out := buf.String(); !strings.Contains(out, "trusted-key set was unavailable") {
		t.Errorf("the degradation must be visible in the output:\n%s", out)
	}
}

// A pinned key answers the trust question without asking the control plane anything.
func TestRunVerifyReceiptPinnedKey(t *testing.T) {
	sr, pub := signedFixture(t, sampleReport())
	job := jobWithReceipt(t, sr)

	// The client would fail if consulted — proving the pinned path does not consult it.
	c := &fakeClient{job: job, signingKeysErr: errors.New("must not be called")}

	var buf bytes.Buffer
	if err := runVerifyReceipt(c, &buf, "table", "job-1", verifyOpts{pinned: pub}); err != nil {
		t.Fatalf("want a clean verification against the pinned key, got %v", err)
	}
	if out := buf.String(); !strings.Contains(out, "key you supplied") {
		t.Errorf("want the pinned-key reason:\n%s", out)
	}
}

func TestRunVerifyReceiptPinnedKeyMismatch(t *testing.T) {
	sr, _ := signedFixture(t, sampleReport())
	otherPub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	c := &fakeClient{job: jobWithReceipt(t, sr)}

	var buf bytes.Buffer
	err = runVerifyReceipt(c, &buf, "table", "job-1", verifyOpts{pinned: otherPub})
	if err == nil || !strings.Contains(err.Error(), "key you supplied") {
		t.Errorf("want a pinned-key mismatch, got %v", err)
	}
}

func TestRunVerifyReceiptPropagatesFetchFailures(t *testing.T) {
	t.Run("job fetch", func(t *testing.T) {
		var buf bytes.Buffer
		c := &fakeClient{err: errors.New("boom")}
		if err := runVerifyReceipt(c, &buf, "table", "job-1", verifyOpts{}); err == nil {
			t.Error("expected the job fetch error to propagate")
		}
	})
	t.Run("job without a receipt", func(t *testing.T) {
		var buf bytes.Buffer
		c := &fakeClient{job: &api.ProvisionJob{ID: "job-1"}}
		if err := runVerifyReceipt(c, &buf, "table", "job-1", verifyOpts{}); !errors.Is(err, errNoReceipt) {
			t.Errorf("want errNoReceipt, got %v", err)
		}
	})
}

// --- verify show ----------------------------------------------------------------------------

func TestRunVerifyShowRendersEveryControlIncludingNotEvaluable(t *testing.T) {
	sr, _ := signedFixture(t, sampleReport())
	c := &fakeClient{job: jobWithReceipt(t, sr)}

	var buf bytes.Buffer
	if err := runVerifyShow(c, &buf, "table", "job-1"); err != nil {
		t.Fatalf("a non-blocking verdict must exit clean, got %v", err)
	}
	out := buf.String()
	// not_evaluable is shown, not hidden — a control the engine could not inspect is not a pass.
	for _, want := range []string{"KEYLESS-001", "LEASTPRIV-001", "OIDC-001", "not_evaluable",
		"aws_iam_policy.admin", "policy grants *:*", "no OIDC provider in the plan"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
}

func TestRunVerifyShowExitsNonZeroOnABlockingVerdict(t *testing.T) {
	sr, _ := signedFixture(t, failingReport())
	c := &fakeClient{job: jobWithReceipt(t, sr)}

	var buf bytes.Buffer
	err := runVerifyShow(c, &buf, "table", "job-1")
	if err == nil || !strings.Contains(err.Error(), "1 control(s) failed") {
		t.Errorf("want a blocking-verdict error, got %v", err)
	}
	if out := buf.String(); !strings.Contains(out, "aws_iam_access_key.ci") {
		t.Errorf("the findings must print even though the command fails:\n%s", out)
	}
}

func TestRunVerifyShowRendersARecordedWaiver(t *testing.T) {
	report := failingReport()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_ = pub
	r := verify.BuildReceipt(verify.BuildReceiptParams{
		Report:    report,
		PlanBytes: []byte("plan"),
		Override: &verify.Override{
			Controls: []string{"KEYLESS-001"},
			Reason:   "legacy CI key, migration tracked in #1234",
			By:       "borislav@tovr.eu",
			Expiry:   time.Now().Add(24 * time.Hour),
		},
	})
	sr, err := verify.Sign(r, priv, "k")
	if err != nil {
		t.Fatal(err)
	}
	c := &fakeClient{job: jobWithReceipt(t, sr)}

	var buf bytes.Buffer
	_ = runVerifyShow(c, &buf, "table", "job-1") // blocking verdict; the waiver does not clear it
	out := buf.String()
	for _, want := range []string{"Waiver", "KEYLESS-001", "borislav@tovr.eu", "legacy CI key", "expires"} {
		if !strings.Contains(out, want) {
			t.Errorf("waiver output missing %q:\n%s", want, out)
		}
	}
}

func TestRunVerifyShowJSONAndCSV(t *testing.T) {
	sr, _ := signedFixture(t, sampleReport())

	var buf bytes.Buffer
	if err := runVerifyShow(&fakeClient{job: jobWithReceipt(t, sr)}, &buf, "json", "job-1"); err != nil {
		t.Fatalf("json: %v", err)
	}
	var report verify.Report
	if err := json.Unmarshal(buf.Bytes(), &report); err != nil {
		t.Fatalf("json output does not decode: %v\n%s", err, buf.String())
	}
	if len(report.Controls) != 3 {
		t.Errorf("want 3 controls in json, got %d", len(report.Controls))
	}

	buf.Reset()
	if err := runVerifyShow(&fakeClient{job: jobWithReceipt(t, sr)}, &buf, "csv", "job-1"); err != nil {
		t.Fatalf("csv: %v", err)
	}
	if out := buf.String(); !strings.Contains(out, "Control,Status,Severity,Title") {
		t.Errorf("csv should emit the control columns:\n%s", out)
	}
}

func TestRunVerifyShowFailures(t *testing.T) {
	t.Run("job fetch", func(t *testing.T) {
		var buf bytes.Buffer
		if err := runVerifyShow(&fakeClient{err: errors.New("boom")}, &buf, "table", "j"); err == nil {
			t.Error("expected the fetch error to propagate")
		}
	})
	t.Run("no receipt", func(t *testing.T) {
		var buf bytes.Buffer
		if err := runVerifyShow(&fakeClient{job: &api.ProvisionJob{ID: "j"}}, &buf, "table", "j"); !errors.Is(err, errNoReceipt) {
			t.Errorf("want errNoReceipt, got %v", err)
		}
	})
	t.Run("receipt without a report", func(t *testing.T) {
		sr := &verify.SignedReceipt{Receipt: verify.Receipt{Version: verify.ReceiptVersion}, Algorithm: "none"}
		var buf bytes.Buffer
		err := runVerifyShow(&fakeClient{job: jobWithReceipt(t, sr)}, &buf, "table", "j")
		if err == nil || !strings.Contains(err.Error(), "no verification report") {
			t.Errorf("want a missing-report error, got %v", err)
		}
	})
}

// errWriter fails every write, so the render-error arms are reachable.
type errWriter struct{}

func (errWriter) Write([]byte) (int, error) { return 0, errors.New("write failed") }

func TestVerifyCommandsSurfaceRenderFailures(t *testing.T) {
	sr, pub := signedFixture(t, sampleReport())
	job := jobWithReceipt(t, sr)

	t.Run("receipt json", func(t *testing.T) {
		c := &fakeClient{job: job, signingKeys: platformKeySet(pub)}
		if err := runVerifyReceipt(c, errWriter{}, "json", "job-1", verifyOpts{}); err == nil {
			t.Error("expected the write failure to propagate")
		}
	})
	// Note: the TABLE arm is deliberately absent. ui.RenderCard writes a table through
	// fmt.Fprintln, whose error is discarded, so a failing writer is invisible to it — the same
	// is true of every other card-rendering command. Asserting otherwise would be asserting a
	// behaviour the shared renderer does not have.
	t.Run("receipt csv", func(t *testing.T) {
		c := &fakeClient{job: job, signingKeys: platformKeySet(pub)}
		if err := runVerifyReceipt(c, errWriter{}, "csv", "job-1", verifyOpts{}); err == nil {
			t.Error("expected the write failure to propagate")
		}
	})
	t.Run("show json", func(t *testing.T) {
		if err := runVerifyShow(&fakeClient{job: job}, errWriter{}, "json", "job-1"); err == nil {
			t.Error("expected the write failure to propagate")
		}
	})
	t.Run("show csv", func(t *testing.T) {
		if err := runVerifyShow(&fakeClient{job: job}, errWriter{}, "csv", "job-1"); err == nil {
			t.Error("expected the write failure to propagate")
		}
	})
}

// A receipt can carry a waiver and a transparency-log anchor. Both are load-bearing for an
// auditor — a waived control and an externally-witnessed signature are exactly what gets asked
// about — so both must reach the card.
func TestReceiptRowsRenderWaiverAndAnchor(t *testing.T) {
	sr, _ := signedFixture(t, sampleReport())
	sr.Receipt.Exception = &verify.RecordedException{
		Controls: []string{"KEYLESS-001"},
		Reason:   "legacy CI key, migration tracked in #1234",
		By:       "borislav@tovr.eu",
		Expiry:   "2026-09-01T00:00:00Z",
	}
	sr.Rekor = &verify.RekorAnchor{LogURL: "https://rekor.sigstore.dev"}

	rows := receiptRows(sr, signatureVerdict{Verified: true, Reason: "ok", Trust: string(trustPlatform)}, ui.FormatTable)
	flat := ""
	for _, r := range rows {
		flat += strings.Join(r, " ") + "\n"
	}
	for _, want := range []string{"Waiver", "borislav@tovr.eu", "legacy CI key", "Transparency log", "rekor.sigstore.dev"} {
		if !strings.Contains(flat, want) {
			t.Errorf("card missing %q:\n%s", want, flat)
		}
	}
}

// A passing control that nonetheless carries coverage notes must not be printed in the findings
// block — the block exists to explain what went wrong, and a pass is not that.
func TestWriteFindingsSkipsPassingControls(t *testing.T) {
	report := &verify.Report{
		Verdict: verify.StatusPass, Provider: "aws", CatalogVersion: "c",
		Controls: []verify.ControlResult{
			{ID: "PASSED-001", Title: "fine", Status: verify.StatusPass, Coverage: "checked 3 resources"},
			{ID: "WARNED-001", Title: "not fine", Status: verify.StatusWarn, Coverage: "checked 1 resource"},
		},
		Summary: verify.Summary{Pass: 1, Warn: 1},
	}
	var buf bytes.Buffer
	writeFindings(&buf, report, nil)
	out := buf.String()
	if strings.Contains(out, "PASSED-001") {
		t.Errorf("a passing control must not appear in the findings block:\n%s", out)
	}
	if !strings.Contains(out, "WARNED-001") {
		t.Errorf("a warning control must appear:\n%s", out)
	}
}

// The summary headline must distinguish the three shapes a verdict comes in, since that line is
// what a reader actually looks at.
func TestVerifyReportSummaryDistinguishesVerdicts(t *testing.T) {
	pass := &verify.Report{Verdict: verify.StatusPass, Provider: "aws", CatalogVersion: "c",
		Summary: verify.Summary{Pass: 3}}
	warn := &verify.Report{Verdict: verify.StatusWarn, Provider: "aws", CatalogVersion: "c",
		Summary: verify.Summary{Pass: 1, Warn: 2}}
	fail := &verify.Report{Verdict: verify.StatusFail, Provider: "aws", CatalogVersion: "c",
		Summary: verify.Summary{Fail: 1}}

	for _, tc := range []struct {
		name string
		r    *verify.Report
		want string
	}{
		{"pass", pass, "pass"},
		{"warn", warn, "warn"},
		{"fail", fail, "fail"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := verifyReportSummary(tc.r); !strings.Contains(got, tc.want) {
				t.Errorf("want %q in %q", tc.want, got)
			}
		})
	}
}
