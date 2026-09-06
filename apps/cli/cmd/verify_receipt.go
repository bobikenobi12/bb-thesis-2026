// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"crypto/ed25519"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"github.com/spf13/cobra"
)

// verifyReceiptSelector holds this command's answers to the "which job" spec. One per command,
// so `verify receipt --type PLAN` cannot narrow `verify show`.
var verifyReceiptSelector jobSelector

var verifyReceiptCmd = &cobra.Command{
	Use:   "receipt [job_id]",
	Short: "Fetch a job's evidence receipt and check its signature",
	Long: `Pulls the signed evidence receipt from a PLAN or DEPLOY job and verifies it.

The signature is checked against a key the control plane vouches for — the organization's own
recorded signing key, or the Alethia platform key — and NOT merely against the public key the
receipt carries about itself. A receipt always verifies under its own embedded key, whoever made
it, so self-verification alone proves the document was not altered in transit and nothing more.

Exit status is part of the contract: anything short of a signature verified against a vouched-for
key exits non-zero, so this can gate a pipeline. Use --allow-unsigned or --allow-untrusted to
downgrade a specific failure to a warning.

The id is optional. Without it, ` + "`--latest`" + ` takes the most recent PLAN or DEPLOY job —
the two that carry a receipt — and a terminal gets a picker.`,
	Args: verifyJobArgs,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}
		// The policy flags are resolved BEFORE the job is: a malformed --key is an error about
		// the command line that does not depend on what the server holds, and making the operator
		// answer a picker first only to be told their key does not parse is the wrong order.
		opts, err := verifyOptsFrom(cmd)
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)
		ref, err := resolveVerifyJob(client, cmd, args, verifyReceiptSelector)
		if err != nil {
			fail(err)
		}
		announceResolvedJob(ref, "Verifying")
		if err := runVerifyReceipt(client, os.Stdout, outputFormat(cmd), ref.ID, opts); err != nil {
			fail(err)
		}
	},
}

// verifyOpts carries the verification-policy flags, resolved once so the run function stays
// testable without a cobra.Command.
type verifyOpts struct {
	pinned         ed25519.PublicKey
	allowUnsigned  bool
	allowUntrusted bool
}

// verifyOptsFrom reads the policy flags off the command.
func verifyOptsFrom(cmd *cobra.Command) (verifyOpts, error) {
	keyB64, _ := cmd.Flags().GetString("key")
	keyFile, _ := cmd.Flags().GetString("key-file")
	pub, err := pinnedKey(keyB64, keyFile)
	if err != nil {
		return verifyOpts{}, err
	}
	allowUnsigned, _ := cmd.Flags().GetBool("allow-unsigned")
	allowUntrusted, _ := cmd.Flags().GetBool("allow-untrusted")
	return verifyOpts{pinned: pub, allowUnsigned: allowUnsigned, allowUntrusted: allowUntrusted}, nil
}

// receiptVerification is the verdict this command exists to produce.
type receiptVerification struct {
	JobID     string                `json:"job_id"`
	OK        bool                  `json:"ok"`
	Signature signatureVerdict      `json:"signature"`
	Receipt   *verify.SignedReceipt `json:"receipt"`
}

// signatureVerdict is the answer to "is this signed, by whom, and did it check out".
type signatureVerdict struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"key_id"`
	Verified  bool   `json:"verified"`
	Trust     string `json:"trust"`
	Reason    string `json:"reason"`
}

// verifyReceipt is the whole decision, pure over its inputs: it takes the receipt and a way to
// fetch the trusted-key set, and returns the verdict plus the error that must set a non-zero exit
// (nil when the policy flags forgive the shortfall). Separating it from rendering is what lets the
// output be printed BEFORE the command exits non-zero — a gate that prints nothing on failure is
// useless for diagnosing why.
func verifyReceipt(sr *verify.SignedReceipt, fetchKeys func() ([]api.SigningKey, error), opts verifyOpts) (signatureVerdict, error) {
	// An unsigned receipt is a real, documented state: the runner attaches one when no signing
	// key is configured. It is not a verification FAILURE, but it is not evidence either.
	if sr.Algorithm != "ed25519" {
		v := signatureVerdict{
			Algorithm: sr.Algorithm,
			KeyID:     sr.KeyID,
			Verified:  false,
			Trust:     string(trustNone),
			Reason:    "receipt is unsigned — the runner had no ALETHIA_RECEIPT_SIGNING_KEY configured when it ran",
		}
		if opts.allowUnsigned {
			return v, nil
		}
		return v, fmt.Errorf("receipt is unsigned (algorithm %q) — there is no signature to verify. "+
			"Configure ALETHIA_RECEIPT_SIGNING_KEY on the runner, or pass --allow-unsigned to accept this", sr.Algorithm)
	}

	// Self-consistency first. A failure here means the document does not match its own signature:
	// it was altered after signing, and no flag forgives that.
	if err := sr.VerifySelf(); err != nil {
		return signatureVerdict{
				Algorithm: sr.Algorithm,
				KeyID:     sr.KeyID,
				Verified:  false,
				Trust:     string(trustNone),
				Reason:    err.Error(),
			}, fmt.Errorf("receipt FAILED verification: %w\n"+
				"The receipt does not match its own signature — it was altered after it was signed", err)
	}

	// An operator-supplied key beats anything the control plane says about itself.
	if opts.pinned != nil {
		if err := sr.Verify(opts.pinned); err != nil {
			return signatureVerdict{
					Algorithm: sr.Algorithm,
					KeyID:     sr.KeyID,
					Verified:  false,
					Trust:     string(trustNone),
					Reason:    err.Error(),
				}, fmt.Errorf("receipt FAILED verification against the key you supplied: %w\n"+
					"The receipt is internally consistent, so it was signed — but by key %s, not by yours", err, sr.KeyID)
		}
		return signatureVerdict{
			Algorithm: sr.Algorithm,
			KeyID:     sr.KeyID,
			Verified:  true,
			Trust:     string(trustPinned),
			Reason:    "signature verified against the key you supplied",
		}, nil
	}

	keys, err := fetchKeys()
	if err != nil {
		// The control plane could not tell us which keys it vouches for — an older console
		// without this endpoint, or an outage. Degrade to the self-verified result and SAY so;
		// do not silently present it as trusted.
		v := signatureVerdict{
			Algorithm: sr.Algorithm,
			KeyID:     sr.KeyID,
			Verified:  true,
			Trust:     string(trustSelf),
			Reason:    fmt.Sprintf("signature is self-consistent, but the trusted-key set was unavailable: %v", err),
		}
		if opts.allowUntrusted {
			return v, nil
		}
		return v, fmt.Errorf("could not establish who signed this receipt: %w\n"+
			"The signature is internally consistent, but that only proves the document was not altered — "+
			"not that Alethia signed it. Pass --key/--key-file to pin a key you trust, or --allow-untrusted "+
			"to accept a self-consistent receipt", err)
	}

	tk := newTrustedKeys(keys)
	if err := sr.VerifyTrusted(tk); err != nil {
		v := signatureVerdict{
			Algorithm: sr.Algorithm,
			KeyID:     sr.KeyID,
			Verified:  true,
			Trust:     string(trustSelf),
			Reason:    fmt.Sprintf("signature is self-consistent, but %v", err),
		}
		if opts.allowUntrusted {
			return v, nil
		}
		return v, fmt.Errorf("receipt is signed by a key this organization does not vouch for: %w\n"+
			"The signature is internally consistent, so the document is intact — but key %s is not in the "+
			"trusted set, which is what a forged receipt also looks like", err, sr.KeyID)
	}

	trust := tk.sourceFor(sr.KeyID)
	var reason string
	switch trust {
	case trustOrg:
		reason = "signature verified against your organization's own recorded key"
	case trustPlatform:
		reason = "signature verified against the Alethia platform key"
	case trustNone, trustSelf, trustPinned:
		// A contradiction: VerifyTrusted just resolved this key_id against the fetched set, so
		// sourceFor cannot honestly report that nothing vouches for it — and pinned/self are
		// decided earlier and never reach here. Rather than invent a reason for a state that
		// should not exist, fail closed.
		return signatureVerdict{
				Algorithm: sr.Algorithm,
				KeyID:     sr.KeyID,
				Verified:  true,
				Trust:     string(trustSelf),
				Reason:    "signature is self-consistent, but the trusted-key set answered inconsistently about who owns this key",
			}, fmt.Errorf("could not establish who signed this receipt: key %s verified against the trusted set "+
				"but that set does not say who vouches for it", sr.KeyID)
	default:
		// The control plane vouched for the key under a custody model this CLI does not know.
		// Report what it said rather than implying a familiar one.
		reason = fmt.Sprintf("signature verified against a key your control plane vouches for (source %q)", trust)
	}
	return signatureVerdict{
		Algorithm: sr.Algorithm,
		KeyID:     sr.KeyID,
		Verified:  true,
		Trust:     string(trust),
		Reason:    reason,
	}, nil
}

// runVerifyReceipt fetches a job's receipt, verifies it, renders the result, and returns the
// error that sets a non-zero exit. json emits the whole verdict object plus the receipt;
// table/csv render the summary card.
// The output-format parameter is `outFmt` and not `format`, which would shadow the
// packages/core/format import this file renders its timestamps through.
func runVerifyReceipt(c apiClient, out io.Writer, outFmt, jobID string, opts verifyOpts) error {
	job, err := c.GetJob(jobID)
	if err != nil {
		return err
	}
	sr, err := receiptFromJob(job)
	if err != nil {
		return err
	}

	verdict, verifyErr := verifyReceipt(sr, c.GetSigningKeys, opts)
	result := receiptVerification{
		JobID:     jobID,
		OK:        verifyErr == nil,
		Signature: verdict,
		Receipt:   sr,
	}

	if outFmt == ui.FormatJSON {
		if err := ui.Render(out, outFmt, ui.TableSpec{}, result); err != nil {
			return err
		}
		return verifyErr
	}
	if err := ui.RenderCard(out, outFmt, "alethia · verify receipt", receiptRows(sr, verdict, outFmt), result); err != nil {
		return err
	}
	return verifyErr
}

// signatureGlyph is the one-character summary of a signature verdict.
//
// THREE states and not two. The glyph used to be `v.Verified ? ✓ : ✗`, and `Verified` is true for
// a self-consistent receipt whose key nobody vouches for — the forged-receipt shape, and a
// non-zero exit. So the card printed a tick beside "signature is self-consistent, but key … is not
// in the trusted set", which is the one row in this whole command a reader skims for a yes/no.
//
// The half-filled glyph is the shared surface's "in progress / not settled" mark, and that is
// exactly this state: the document is intact, the question of WHO signed it is unanswered. Nothing
// here changes what the receipt asserts or what the command exits — Trust and Reason still carry
// the full answer, and `--allow-untrusted` still exits zero. The glyph stops disagreeing with them.
func signatureGlyph(v signatureVerdict) string {
	switch {
	case !v.Verified:
		return ui.SymbolError
	case trustLevel(v.Trust) == trustSelf:
		return ui.SymbolPending
	default:
		return ui.SymbolSuccess
	}
}

// receiptStamp renders one of a receipt's absolute timestamps.
//
// The receipt carries RFC3339 and this card used to print it verbatim, so `verify receipt` said
// `2026-03-09T15:04:05Z` for the instant `jobs get` renders as `9 Mar 2026, 15:04`. One product,
// two spellings of one moment. `packages/core/format.Date` is the shared rule, in UTC so two
// people reading the same receipt read the same time.
//
// A value that does not parse is returned AS GIVEN rather than dashed or dropped. This is
// evidence: a timestamp the CLI cannot read is something the reader must be able to see and
// report, and replacing it with a sentinel would destroy the only copy they had.
func receiptStamp(raw string) string {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(raw))
	if err != nil {
		return raw
	}
	return format.Date(t, format.DateTime, time.UTC)
}

// receiptEvaluatedCell renders the Evaluated cell: the shared date rule for a person, and the
// receipt's own wire value for CSV.
//
// ui.RenderCard hands these rows to ui.Render VERBATIM in its CSV branch, so humanising the cell
// unconditionally would change what `alethia verify receipt -o csv` emits — from
// `2026-03-09T15:04:05Z` to `9 Mar 2026, 15:04`, which no longer sorts, no longer parses, and has
// dropped the seconds and the zone the signed document actually carries. CSV is the machine
// reading of a piece of evidence and gets the value unaltered; the card is the human one.
// `-o json` emits the receipt struct and never came through here either way.
//
// The same split cost.go's costMonthlyCell makes, for the same reason: #3736 shipped a humanised
// cell into a shared row builder and had to be corrected for exactly this.
func receiptEvaluatedCell(raw, outFmt string) string {
	if outFmt == ui.FormatCSV {
		return raw
	}
	return receiptStamp(raw)
}

// receiptRows projects a receipt and its signature verdict into field/value cells. Status reads
// by glyph, never by colour — the CLI palette is grayscale.
//
// outFmt is taken because these rows are BOTH renderings: RenderCard prints them as a card for a
// person and emits them as-is for `-o csv`. Every cell that reads differently for a machine has to
// decide here, where the format is known, rather than in a formatter that cannot see it.
func receiptRows(sr *verify.SignedReceipt, v signatureVerdict, outFmt string) [][]string {
	rows := [][]string{
		{"Signature", fmt.Sprintf("%s %s", signatureGlyph(v), v.Reason)},
		{"Trust", v.Trust},
		{"Algorithm", sr.Algorithm},
	}
	if sr.KeyID != "" {
		rows = append(rows, []string{"Key ID", sr.KeyID})
	}
	rows = append(rows,
		[]string{"Verdict", string(sr.Receipt.Verdict)},
		[]string{"Sealed to plan", sr.Receipt.PlanSHA256},
	)
	if sr.Receipt.Provider != "" {
		rows = append(rows, []string{"Provider", sr.Receipt.Provider})
	}
	if sr.Receipt.CatalogVersion != "" {
		rows = append(rows, []string{"Control catalog", sr.Receipt.CatalogVersion})
	}
	if sr.Receipt.TofuVersion != "" {
		rows = append(rows, []string{"OpenTofu", sr.Receipt.TofuVersion})
	}
	if sr.Receipt.Runner != "" {
		rows = append(rows, []string{"Runner", sr.Receipt.Runner})
	}
	if sr.Receipt.EvaluatedAt != "" {
		rows = append(rows, []string{"Evaluated", receiptEvaluatedCell(sr.Receipt.EvaluatedAt, outFmt)})
	}
	if r := sr.Receipt.Report; r != nil {
		rows = append(rows, []string{"Controls", fmt.Sprintf("%d pass, %d fail, %d warn, %d n/a",
			r.Summary.Pass, r.Summary.Fail, r.Summary.Warn, r.Summary.NotEvaluable)})
	}
	if e := sr.Receipt.Exception; e != nil {
		rows = append(rows, []string{"Waiver", fmt.Sprintf("%d control(s) waived by %s — %s",
			len(e.Controls), e.By, e.Reason)})
	}
	if sr.Rekor != nil && sr.Rekor.LogURL != "" {
		rows = append(rows, []string{"Transparency log", sr.Rekor.LogURL})
	}
	return rows
}

func init() {
	verifyReceiptCmd.Flags().String("key", "", "Verify against this base64(std) ed25519 public key instead of the control plane's trusted set")
	verifyReceiptCmd.Flags().String("key-file", "", "Verify against the base64(std) ed25519 public key in this file")
	verifyReceiptCmd.Flags().Bool("allow-unsigned", false, "Exit zero when the receipt carries no signature")
	verifyReceiptCmd.Flags().Bool("allow-untrusted", false, "Exit zero when the signature is self-consistent but its key is not vouched for")
}
