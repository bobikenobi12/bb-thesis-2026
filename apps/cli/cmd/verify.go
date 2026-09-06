// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"github.com/spf13/cobra"
)

var verifyCmd = &cobra.Command{
	Use:   "verify",
	Short: "Inspect and verify a job's signed evidence receipt",
	Long: `Every PLAN and DEPLOY job carries an elench evidence receipt: the per-control
verification report, sealed to the hash of the exact OpenTofu plan that was applied, and signed
with ed25519.

` + "`alethia verify receipt`" + ` pulls that receipt and checks its signature against a key the
control plane vouches for, exiting non-zero when it cannot — so a pipeline can gate on it.
` + "`alethia verify show`" + ` prints the per-control report behind the verdict, including the
controls that could not be evaluated and any recorded waiver.

Both take the job id as an optional argument. Without one, ` + "`--latest`" + ` takes the most
recent PLAN or DEPLOY job and a terminal gets a picker, so nothing has to be copied out of another
command's output.`,
}

// Which job? — reused wholesale from the jobs group, not re-derived.
//
// `verify receipt` and `verify show` used to take the id from a REQUIRED `--job` flag, which made
// each of them the second half of a copy: the reader ran `project plan`, read an opaque uuid out
// of its output, and pasted it back. That copied token is the handoff this programme exists to
// remove, and #3740 already removed it for `jobs get`/`logs`/`cancel`. `resolveJob` is the answer
// it built — positional ∨ `--latest` ∨ a picker, from one field spec — so this group calls it
// rather than growing a second one that would come to disagree about what `--latest` means.

// receiptBearingJobScope is the set of jobs `verify` can say anything about.
//
// Only a PLAN and a DEPLOY attach `verify_receipt` to their execution_metadata — the runner's
// executePlan and buildDeployMetadata are the two writers, and the type switch in
// apps/runner/internal/agent/runner.go has no other case that does. Every other type — a
// scheduled DETECT_DRIFT, a CHART_SCAN, a PROBE_CLUSTER — carries no receipt at all, so an
// unscoped `--latest` in a busy org resolves to a job this command can only refuse, and the
// picker offers fifty rows of which a handful are answerable.
//
// The bound is worth stating, because it is weaker than `cancel`'s. `cancel`'s scope is what the
// server would CERTAINLY refuse; this one rests on a claim about what the runner writes, and a
// third receipt-bearing job type would be skipped by `--latest` until this line was updated. That
// degrades convenience and never locks anyone out: an id on the command line bypasses the scope
// entirely, and an explicit `--type` overrides it (jobScope.applies). Through the generated
// constants so a type renamed or dropped from the drizzle enum fails the CLI build.
var receiptBearingJobScope = jobScope{
	Field: jobSelectorFieldByFlag("type"),
	Values: []string{
		string(types.JobTypePlan),
		string(types.JobTypeDeploy),
	},
	Noun: "job carrying an evidence receipt",
}

// verifyJobArgs is the argument rule both leaves take: an optional job id.
var verifyJobArgs = cobra.MaximumNArgs(1)

// resolveVerifyJob answers "which job" for both verify leaves.
//
// `--job`/`-j` is kept as a fourth spelling of the positional. It was the ONLY way to name a job
// before this pass, so it is in every pipeline and every doc example that predates it; silently
// breaking those to tidy the interface is the trade this repo's decision rule refuses. It is an
// alias, not a second source: it lands in the same slot the positional does, and naming a job
// twice is refused rather than resolved to one of the two.
func resolveVerifyJob(client jobLister, cmd *cobra.Command, args []string, sel jobSelector) (jobRef, error) {
	if j, _ := cmd.Flags().GetString("job"); j != "" {
		if len(args) > 0 && args[0] != "" && args[0] != j {
			return jobRef{}, fmt.Errorf("the job id is given twice and the two disagree (%q as an argument, %q as --job) — pass it once", args[0], j)
		}
		args = []string{j}
	}
	return resolveJobIn(client, args, sel, receiptBearingJobScope)
}

// errNoReceipt is returned when a job carries no evidence receipt at all. Its own error so the
// caller can say WHY rather than reporting a verification failure for something never signed.
var errNoReceipt = fmt.Errorf("this job carries no evidence receipt")

// unfinishedJobStatuses are the states a job passes through before it has an outcome.
//
// The receipt is written when the run COMPLETES — executePlan posts the verify_receipt metadata
// after the sandbox stage returns — so a job in one of these states has no receipt YET, which is a
// different fact from a DETECT_DRIFT that will never have one, and needs a different answer.
//
// Through the generated constants so a status renamed or dropped from the drizzle enum fails the
// CLI build. A status ADDED to the enum falls through as finished, which is the safe direction:
// the worst that does is give the generic refusal to a job that is still running, where the
// opposite would tell a reader to wait for a job that has already stopped.
var unfinishedJobStatuses = []types.JobStatus{
	types.JobStatusQueued,
	types.JobStatusClaimed,
	types.JobStatusProcessing,
}

// jobUnfinished reports whether a job has not yet reached an outcome.
func jobUnfinished(job *api.ProvisionJob) bool {
	if job == nil {
		return false
	}
	for _, s := range unfinishedJobStatuses {
		if strings.EqualFold(job.Status, string(s)) {
			return true
		}
	}
	return false
}

// noReceiptErr is the refusal for a receiptless job, and it says WHICH kind of receiptless.
//
// receiptBearingJobScope narrows `--latest` by job TYPE, and cannot narrow by completion: the
// newest PLAN is very often one that has only just been queued, because `alethia project plan`
// returns as soon as the job is enqueued unless `-w` was passed. So the headline flow of this
// pass —
//
//	alethia project plan
//	alethia verify receipt --latest
//
// resolves that queued PLAN, and a bare "this job carries no evidence receipt" reads as "plans do
// not produce receipts": the dead end the scope exists to prevent, one axis over. Naming
// `--status SUCCESS` turns it into an instruction, because that flag composes with the scope —
// `--latest --status SUCCESS` is the newest FINISHED PLAN or DEPLOY.
//
// It WRAPS errNoReceipt rather than replacing it, so `errors.Is(err, errNoReceipt)` still answers
// "this job had no receipt" for every caller, and the added sentence is only the remedy.
func noReceiptErr(job *api.ProvisionJob) error {
	if !jobUnfinished(job) {
		return errNoReceipt
	}
	return fmt.Errorf("%w: it is %s, and the receipt is written when the run completes — "+
		"wait for it, or add --status SUCCESS to take the newest job that has already finished",
		errNoReceipt, job.Status)
}

// receiptFromJob extracts the typed SignedReceipt from a job's execution_metadata.
//
// execution_metadata arrives as an untyped map (api.ProvisionJob.ExecutionMetadata), so the
// receipt sub-tree is re-marshalled and decoded into the real struct rather than hand-walked:
// the signature is checked over canonicalBytes(Receipt) == json.Marshal of that struct, so the
// typed round trip is what reproduces the signed bytes. Hand-walking the map would not.
func receiptFromJob(job *api.ProvisionJob) (*verify.SignedReceipt, error) {
	if job == nil || job.ExecutionMetadata == nil {
		return nil, noReceiptErr(job)
	}
	raw, ok := (*job.ExecutionMetadata)["verify_receipt"]
	if !ok || raw == nil {
		return nil, noReceiptErr(job)
	}
	blob, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("re-encode receipt: %w", err)
	}
	var sr verify.SignedReceipt
	if err := json.Unmarshal(blob, &sr); err != nil {
		return nil, fmt.Errorf("decode receipt: %w", err)
	}
	return &sr, nil
}

// trustLevel names WHO vouches for the key a receipt was signed with. It is the difference
// between "this blob is internally consistent" and "Alethia signed this", and the command's exit
// status turns on it.
type trustLevel string

const (
	// trustPinned — the signature verified under a key the OPERATOR supplied out of band
	// (--key/--key-file). The strongest answer available: it depends on nothing the control
	// plane said.
	trustPinned trustLevel = "pinned"
	// trustOrg — the key_id resolved to an active key in the org's own recorded history.
	trustOrg trustLevel = "org"
	// trustPlatform — the key_id resolved to the Alethia platform key. Attests "Alethia
	// asserted this", not "the customer asserted this".
	trustPlatform trustLevel = "platform"
	// trustSelf — only the receipt's OWN embedded key verified. Proves the blob was not
	// mangled; proves nothing about who made it.
	trustSelf trustLevel = "self"
	// trustNone — no signature to reason about (an unsigned receipt).
	trustNone trustLevel = "none"
)

// trustedKeys resolves a key_id to the public key the control plane recorded for it. This is the
// first production implementation of verify.TrustedKeys — the interface has existed since #884
// with only tests behind it.
type trustedKeys struct {
	byKeyID map[string]api.SigningKey
}

// newTrustedKeys indexes a fetched key set by key_id. A malformed public key is skipped rather
// than failing the whole set: one bad row must not make every other key unusable.
func newTrustedKeys(keys []api.SigningKey) *trustedKeys {
	byKeyID := make(map[string]api.SigningKey, len(keys))
	for _, k := range keys {
		if k.KeyID == "" {
			continue
		}
		if _, err := decodePublicKey(k.PublicKey); err != nil {
			continue
		}
		byKeyID[k.KeyID] = k
	}
	return &trustedKeys{byKeyID: byKeyID}
}

// PublicKeyForKeyID implements verify.TrustedKeys.
func (t *trustedKeys) PublicKeyForKeyID(keyID string) (ed25519.PublicKey, bool) {
	k, ok := t.byKeyID[keyID]
	if !ok {
		return nil, false
	}
	pub, err := decodePublicKey(k.PublicKey)
	if err != nil {
		return nil, false
	}
	return pub, true
}

// sourceFor reports the trust level a resolved key_id earns.
//
// Every arm is explicit on purpose. Defaulting the unknown cases to trustPlatform would print
// "verified against the Alethia platform key" for a key that is nothing of the sort — a specific
// claim about custody that this CLI would not actually have checked. A trust label that overstates
// is worse than one that admits it does not know.
func (t *trustedKeys) sourceFor(keyID string) trustLevel {
	k, ok := t.byKeyID[keyID]
	if !ok {
		// Unreachable through verifyReceipt, which only calls this after VerifyTrusted has
		// already resolved the id. Reached any other way, nothing vouched for this key.
		return trustNone
	}
	switch k.Source {
	case "org":
		return trustOrg
	case "platform":
		return trustPlatform
	case "":
		// The set resolved the key but does not say who vouches for it. That is not a custody
		// model to report verbatim — it is the absence of an answer, and the caller fails closed.
		return trustNone
	default:
		// A custody model this CLI predates. The control plane still vouched for the key, so the
		// signature is trusted — but report the source verbatim rather than relabel it as one of
		// the two we happen to know.
		return trustLevel(k.Source)
	}
}

// decodePublicKey parses a base64(std) ed25519 public key. The same encoding the console stores
// and the receipt embeds, so one parser serves --key, the wire, and the receipt itself.
func decodePublicKey(b64 string) (ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return nil, fmt.Errorf("not valid base64: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("expected a %d-byte ed25519 public key, got %d bytes", ed25519.PublicKeySize, len(raw))
	}
	return ed25519.PublicKey(raw), nil
}

// pinnedKey resolves --key / --key-file into a public key, or nil when neither was given.
// Two flags rather than one value that might be a path: a flag whose meaning depends on whether
// the filesystem happens to contain a matching name is not something a pipeline can rely on.
func pinnedKey(keyB64, keyFile string) (ed25519.PublicKey, error) {
	if keyB64 != "" && keyFile != "" {
		return nil, fmt.Errorf("pass --key or --key-file, not both")
	}
	if keyB64 != "" {
		pub, err := decodePublicKey(keyB64)
		if err != nil {
			return nil, fmt.Errorf("--key: %w", err)
		}
		return pub, nil
	}
	if keyFile != "" {
		data, err := os.ReadFile(keyFile)
		if err != nil {
			return nil, fmt.Errorf("--key-file: %w", err)
		}
		pub, err := decodePublicKey(string(data))
		if err != nil {
			return nil, fmt.Errorf("--key-file: %w", err)
		}
		return pub, nil
	}
	return nil, nil
}

func init() {
	// Persistent, so `-j` keeps working on both leaves exactly as it did. The selector flags are
	// registered per-leaf (addJobSelectorFlags writes into a command's own flag set), which is
	// also what the jobs group does — one selector value per command, so two verify commands in
	// one process cannot read each other's narrowing.
	verifyCmd.PersistentFlags().StringP("job", "j", "", "Job id whose evidence receipt to read (same as passing it as an argument)")
	addJobSelectorFlags(verifyReceiptCmd, &verifyReceiptSelector)
	addJobSelectorFlags(verifyShowCmd, &verifyShowSelector)
	verifyCmd.AddCommand(verifyReceiptCmd)
	verifyCmd.AddCommand(verifyShowCmd)
	rootCmd.AddCommand(verifyCmd)
}
