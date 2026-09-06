// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func hetznerQueueProject(names ...string) *types.ProjectConfig {
	pc := &types.ProjectConfig{Provider: types.CloudProviderHetzner}
	for _, n := range names {
		pc.Queues = append(pc.Queues, types.ProjectQueueConfig{Name: n})
	}
	return pc
}

// oneQueue is the derived spec for a single well-named queue, which most tests below want.
func oneQueue(t *testing.T, name string) HetznerQueue {
	t.Helper()
	qs := HetznerQueues(hetznerQueueProject(name), io.Discard)
	if len(qs) != 1 {
		t.Fatalf("derived %d queues for %q, want 1", len(qs), name)
	}
	return qs[0]
}

// b64 encodes a Secret value the way the API server returns it.
func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

// secretJSON is one `kubectl get secret -o json` object with the given data.
func secretJSON(data map[string]string) string {
	raw, err := json.Marshal(map[string]any{"data": data})
	if err != nil {
		panic(err)
	}
	return string(raw)
}

// labelledSecretJSON is one existing Secret with both data and metadata labels.
func labelledSecretJSON(data, labels map[string]string) string {
	raw, err := json.Marshal(map[string]any{
		"data":     data,
		"metadata": map[string]any{"labels": labels},
	})
	if err != nil {
		panic(err)
	}
	return string(raw)
}

// secretValue pulls one key back out of a rendered Secret manifest, decoded. Reading the APPLIED
// BYTES is the point: "an apply happened" and "the right credential was written" are different
// claims, and only the second one is this fix.
func secretValue(t *testing.T, manifest, key string) string {
	t.Helper()
	m := regexp.MustCompile(`(?m)^  ` + regexp.QuoteMeta(key) + `: (.+)$`).FindStringSubmatch(manifest)
	if m == nil {
		t.Fatalf("the applied Secret has no %q key:\n%s", key, manifest)
	}
	raw, err := base64.StdEncoding.DecodeString(m[1])
	if err != nil {
		t.Fatalf("%q is not base64 (%v):\n%s", key, err, manifest)
	}
	if len(raw) == 0 {
		t.Fatalf("%q is empty — a RabbitMQ with no authentication", key)
	}
	return string(raw)
}

// ── the cross-language contract ────────────────────────────────────────────────────────────────

// THE invariant. The chart reads its password and erlang cookie from whatever `auth.existingSecret`
// names, and the runner writes them into whatever this returns. The two are written in different
// languages and nothing at runtime compares them: a mismatch renders, applies, and surfaces only as
// a StatefulSet that never starts.
//
// So it is read back out of the GENERATED fixture — the product of the real console mapper — rather
// than compared against a string retyped here, which would only prove Go agrees with Go.
func TestQueueCredentialSecretNameAgreesWithTheGeneratedFixture(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate this file")
	}
	path := filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "test", "e2e", "fixtures", "hetzner_data_services.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		// FATAL, NOT SKIP. This is the only thing tying CredentialSecretName() to the TS
		// `auth.existingSecret`, and a skip is a green run that checked nothing — the same defect
		// as the `found == 0` guard below, one level up. A moved fixture would let the two names
		// diverge in silence, and the first signal would be a StatefulSet stuck at
		// CreateContainerConfigError on a customer's cluster.
		t.Fatalf("generated fixture not readable at %s (%v) — this test is the only check that the Go "+
			"secret name and the TS auth.existingSecret agree", path, err)
	}
	var fx struct {
		AddOns []struct {
			ID        string         `json:"id"`
			Namespace string         `json:"namespace"`
			Values    map[string]any `json:"values"`
		} `json:"addons"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	var found int
	for _, spec := range fx.AddOns {
		name, isQueue := strings.CutPrefix(spec.ID, "queue-")
		if !isQueue {
			continue
		}
		found++
		q := oneQueue(t, name)
		if q.AddOnID != spec.ID {
			t.Errorf("AddOnID = %q, want %q — PruneAddOnSecrets matches this against the enabled set",
				q.AddOnID, spec.ID)
		}
		if q.Namespace != spec.Namespace {
			t.Errorf("Namespace = %q, but the console renders the release into %q", q.Namespace, spec.Namespace)
		}
		auth, _ := spec.Values["auth"].(map[string]any)
		if auth == nil {
			t.Fatalf("%s renders no auth block — the chart is minting its own credentials again (#3304)", spec.ID)
		}
		if got := auth["existingSecret"]; got != q.CredentialSecretName() {
			t.Errorf("auth.existingSecret = %v, but the runner seeds %q", got, q.CredentialSecretName())
		}
		if got := auth["existingPasswordKey"]; got != rabbitmqPasswordKey {
			t.Errorf("auth.existingPasswordKey = %v, but the runner writes the key %q", got, rabbitmqPasswordKey)
		}
		if got := auth["existingErlangCookieKey"]; got != rabbitmqErlangCookieKey {
			t.Errorf("auth.existingErlangCookieKey = %v, but the runner writes the key %q", got, rabbitmqErlangCookieKey)
		}
	}
	// A fixture that stopped carrying a queue would make every assertion above vacuous, and the
	// test would keep reporting success while checking nothing.
	if found == 0 {
		t.Fatal("the generated fixture carries no queue spec — this test proved nothing")
	}
}

// ── derivation ─────────────────────────────────────────────────────────────────────────────────

// Hetzner only: every other cloud provisions a real queue service, so a derived queue there would
// write a Secret nothing reads.
func TestHetznerQueuesAreDerivedOnHetznerOnly(t *testing.T) {
	for _, p := range []types.CloudProvider{"aws", "gcp", "azure", "alibaba"} {
		pc := hetznerQueueProject("jobs")
		pc.Provider = p
		if got := HetznerQueues(pc, io.Discard); len(got) != 0 {
			t.Errorf("provider %s derived %d queue(s), want 0", p, len(got))
		}
	}
	if got := HetznerQueues(nil, io.Discard); got != nil {
		t.Errorf("HetznerQueues(nil) = %v, want nil", got)
	}
}

// A name this cannot safely interpolate is dropped — and SAID. Dropping it in silence produces a
// queue whose Application applies cleanly and whose StatefulSet then sits at
// CreateContainerConfigError forever, with nothing in the deploy log pointing at the credential
// nobody seeded.
func TestHetznerQueuesReportEveryNameTheyRefuse(t *testing.T) {
	for _, name := range []string{"", "Jobs", "jobs; rm -rf /", "jobs$(id)", "-jobs", "jobs/../x", "orders.v2"} {
		var errOut strings.Builder
		if got := HetznerQueues(hetznerQueueProject(name), &errOut); len(got) != 0 {
			t.Errorf("name %q derived %d queue(s), want 0", name, len(got))
		}
		if !strings.Contains(errOut.String(), "will not start") {
			t.Errorf("name %q was dropped without a word: %q", name, errOut.String())
		}
	}
}

// ── seeding, completing, and never rewriting ───────────────────────────────────────────────────

// A COMPLETE Secret is left exactly as it is. Re-applying would hand a running RabbitMQ a new
// erlang cookie, which partitions the cluster.
func TestEnsureQueueCredentialSecretLeavesALabelledCompleteSecretAlone(t *testing.T) {
	// Supply the correct labels without changing the shared data fixture's deliberately minimal
	// shape: this test pins the common path's zero-write behaviour.
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret rabbitmq-jobs-credentials", Stdout: labelledSecretJSON(
		map[string]string{
			rabbitmqPasswordKey:     b64("live-password"),
			rabbitmqErlangCookieKey: b64("live-cookie"),
		},
		map[string]string{"alethia.io/managed-by": "addon-marketplace", addonSecretLabelKey: "queue-jobs"},
	)})
	var out strings.Builder
	if err := EnsureQueueCredentialSecret(oneQueue(t, "jobs"), &out, io.Discard); err != nil {
		t.Fatalf("EnsureQueueCredentialSecret: %v", err)
	}
	if applied := stub.appliedManifests(); applied != "" {
		t.Fatalf("rewrote a complete queue credential:\n%s", applied)
	}
	if stub.calledWith("label secret") {
		t.Fatalf("rewrote already-correct labels; calls = %v", stub.calls())
	}
	if !strings.Contains(out.String(), "is complete") {
		t.Errorf("did not report the complete secret: %q", out.String())
	}
}

// A hand-created complete Secret must enter the same lifecycle as runner-created add-on Secrets:
// metadata repair makes it visible to the real sweep, without ever applying its credential data.
func TestEnsureQueueCredentialSecretLabelsACompleteSecretForPruning(t *testing.T) {
	secret := secretJSON(map[string]string{
		rabbitmqPasswordKey:     b64("live-password"),
		rabbitmqErlangCookieKey: b64("live-cookie"),
	})
	listed := `{"items":[{"metadata":{"name":"rabbitmq-jobs-credentials","namespace":"queues","labels":{"alethia.io/managed-by":"addon-marketplace","alethia.io/addon-secret":"queue-jobs"}}}]}`
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get secret rabbitmq-jobs-credentials", Stdout: secret},
		stubRule{Match: "get secrets -A", Stdout: listed},
	)
	if err := EnsureQueueCredentialSecret(oneQueue(t, "jobs"), io.Discard, io.Discard); err != nil {
		t.Fatalf("EnsureQueueCredentialSecret: %v", err)
	}
	PruneAddOnSecrets(nil, io.Discard, io.Discard)

	if !stub.calledWith("label secret -n queues rabbitmq-jobs-credentials alethia.io/managed-by=addon-marketplace alethia.io/addon-secret=queue-jobs --overwrite") {
		t.Fatalf("complete Secret never received sweep labels; calls = %v", stub.calls())
	}
	if !stub.calledWith("delete secret -n queues rabbitmq-jobs-credentials --ignore-not-found=true") {
		t.Fatalf("labelled Secret was invisible to prune; calls = %v", stub.calls())
	}
	if applied := stub.appliedManifests(); applied != "" {
		t.Fatalf("metadata repair rewrote credential data:\n%s", applied)
	}
}

// A label failure is surfaced and must never fall through to a credential apply.
func TestEnsureQueueCredentialSecretStopsWhenMetadataRepairFails(t *testing.T) {
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get secret rabbitmq-jobs-credentials", Stdout: secretJSON(map[string]string{
			rabbitmqPasswordKey:     b64("live-password"),
			rabbitmqErlangCookieKey: b64("live-cookie"),
		})},
		stubRule{Match: "label secret", Exit: 1},
	)
	err := EnsureQueueCredentialSecret(oneQueue(t, "jobs"), io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "label complete queue credential secret") {
		t.Fatalf("label failure = %v, want a surfaced metadata-repair error", err)
	}
	if applied := stub.appliedManifests(); applied != "" {
		t.Fatalf("label failure rewrote credential data:\n%s", applied)
	}
}

// EXISTENCE IS NOT COMPLETENESS. A Secret holding one of the two keys — hand-created from the
// chart's own README, or half-written — was previously frozen in that state on this deploy and every
// deploy after it, while the StatefulSet sat at CreateContainerConfigError and the log said
// "leaving it in place". The present key must survive byte-identical; only the absent one is filled.
func TestEnsureQueueCredentialSecretFillsOnlyTheMissingKey(t *testing.T) {
	for _, tc := range []struct {
		name    string
		present string
		absent  string
	}{
		{"a password with no cookie", rabbitmqPasswordKey, rabbitmqErlangCookieKey},
		{"a cookie with no password", rabbitmqErlangCookieKey, rabbitmqPasswordKey},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := newKubectlStub(t, 0,
				stubRule{Match: "get secret rabbitmq-jobs-credentials", Stdout: secretJSON(map[string]string{
					tc.present: b64("kept-" + tc.present),
					tc.absent:  "",
				})},
				// Nothing to adopt: the absent half must be generated, not left empty.
				stubRule{Match: "app.kubernetes.io/instance=", Stdout: `{"items":[]}`},
			)
			if err := EnsureQueueCredentialSecret(oneQueue(t, "jobs"), io.Discard, io.Discard); err != nil {
				t.Fatalf("EnsureQueueCredentialSecret: %v", err)
			}
			applied := stub.appliedManifests()
			if applied == "" {
				t.Fatalf("an incomplete Secret was left alone; calls = %v", stub.calls())
			}
			if got := secretValue(t, applied, tc.present); got != "kept-"+tc.present {
				t.Errorf("%s = %q, want the existing value kept byte-identical", tc.present, got)
			}
			// secretValue fails the test on an absent, non-base64 or empty value.
			secretValue(t, applied, tc.absent)
		})
	}
}

// A FAILED READ IS NOT AN ABSENT SECRET. `kubectl get` exits non-zero for `Unable to connect to the
// server`, a 429 from a restarting apiserver, an expired token or an RBAC blip — and treating those
// as "absent" would generate two credentials and apply them straight over a live Secret. The pod
// does not restart, so nothing surfaces until the next restart writes a different .erlang.cookie.
func TestEnsureQueueCredentialSecretRefusesToReadAFailureAsAbsence(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret rabbitmq-jobs-credentials", Exit: 1})
	err := EnsureQueueCredentialSecret(oneQueue(t, "jobs"), io.Discard, io.Discard)
	if err == nil {
		t.Fatal("a failed read was treated as an absent Secret")
	}
	if !strings.Contains(err.Error(), "read queue credential secret") {
		t.Errorf("error = %v, want it to name the read", err)
	}
	if applied := stub.appliedManifests(); applied != "" {
		t.Fatalf("applied over a Secret it could not read:\n%s", applied)
	}
}

// The `--ignore-not-found` shape is what makes absence an EMPTY SUCCESS, and it is what the test
// above depends on to tell the two apart. Asserted on the command, because a future edit that drops
// the flag turns every read failure back into "absent" while every test here still passes.
func TestEnsureQueueCredentialSecretReadsWithIgnoreNotFound(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "app.kubernetes.io/instance=", Stdout: `{"items":[]}`})
	if err := EnsureQueueCredentialSecret(oneQueue(t, "jobs"), io.Discard, io.Discard); err != nil {
		t.Fatalf("EnsureQueueCredentialSecret: %v", err)
	}
	if !stub.calledWith("get secret rabbitmq-jobs-credentials -n queues -o json --ignore-not-found") {
		t.Fatalf("the existence read is not --ignore-not-found; calls = %v", stub.calls())
	}
}

func TestEnsureQueueCredentialSecretSeedsWhenAbsent(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "app.kubernetes.io/instance=", Stdout: `{"items":[]}`})
	if err := EnsureQueueCredentialSecret(oneQueue(t, "jobs"), io.Discard, io.Discard); err != nil {
		t.Fatalf("EnsureQueueCredentialSecret: %v", err)
	}
	for _, c := range stub.calls() {
		// A credential must never reach a command line — it rides a 0600 manifest file.
		if strings.Contains(c, "password=") || strings.Contains(c, "erlang-cookie=") {
			t.Errorf("a credential reached argv: %q", c)
		}
	}
	applied := stub.appliedManifests()
	if applied == "" {
		t.Fatalf("never applied the credential secret; calls = %v", stub.calls())
	}
	secretValue(t, applied, rabbitmqPasswordKey)
	cookie := secretValue(t, applied, rabbitmqErlangCookieKey)
	// RabbitMQ documents the cookie as alphanumeric: it becomes an Erlang atom, the init container
	// writes it through a shell `echo`, and rabbitmqctl reads it back. The chart it replaces used
	// `randAlphaNum 32`, so this keeps the value identical in shape to what is already deployed.
	if !regexp.MustCompile(`^[A-Za-z0-9]{32}$`).MatchString(cookie) {
		t.Errorf("erlang cookie %q is not 32 alphanumeric characters", cookie)
	}
}

func TestEnsureQueueCredentialSecretRefusesAnUnsafeQueue(t *testing.T) {
	newKubectlStub(t, 0)
	bad := HetznerQueue{Name: "jobs; rm -rf /", Namespace: hetznerQueueNamespace, AddOnID: "queue-jobs"}
	if err := EnsureQueueCredentialSecret(bad, io.Discard, io.Discard); err == nil {
		t.Fatal("seeded credentials for an unsafe queue name")
	}
}

// An entropy failure must surface as an error and apply NOTHING. Falling back to something weaker
// is how a "random" credential becomes guessable with nothing downstream noticing. Both generators
// are exercised, because they no longer share an implementation.
func TestEnsureQueueCredentialSecretSurfacesAnEntropyFailure(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "app.kubernetes.io/instance=", Stdout: `{"items":[]}`})
	prev := rabbitmqRandReader
	t.Cleanup(func() { rabbitmqRandReader = prev })
	rabbitmqRandReader = failingReader{}

	if err := EnsureQueueCredentialSecret(oneQueue(t, "jobs"), io.Discard, io.Discard); err == nil {
		t.Fatal("no error when the entropy source failed")
	}
	if applied := stub.appliedManifests(); applied != "" {
		t.Fatalf("applied a secret despite a failed entropy read:\n%s", applied)
	}
	if _, err := rabbitmqPassword(); err == nil {
		t.Error("rabbitmqPassword returned a value from a failed reader")
	}
	if _, err := rabbitmqErlangCookie(); err == nil {
		t.Error("rabbitmqErlangCookie returned a value from a failed reader")
	}
}

// The manifest carries BOTH keys, the sweep labels, and — deliberately — no ArgoCD tracking
// metadata. A Secret carrying `app.kubernetes.io/instance` becomes a resource the Application owns,
// and an owned resource absent from the rendered manifest is exactly what `prune: true` deletes.
func TestQueueCredentialSecretManifestShape(t *testing.T) {
	q := oneQueue(t, "jobs")
	manifest := queueCredentialSecretManifest(q, map[string]string{
		rabbitmqPasswordKey:     b64("pw-value"),
		rabbitmqErlangCookieKey: b64("cookie-value"),
		// A key the chart does not read must not ride along out of the cluster.
		"leftover": b64("stale"),
	})
	for _, want := range []string{
		"name: rabbitmq-jobs-credentials",
		"namespace: queues",
		"kind: Namespace",
		"alethia.io/managed-by: addon-marketplace",
		addonSecretLabelKey + ": queue-jobs",
	} {
		if !strings.Contains(manifest, want) {
			t.Errorf("manifest is missing %q:\n%s", want, manifest)
		}
	}
	if strings.Contains(manifest, "leftover") {
		t.Errorf("a key the chart does not read was carried into the Secret:\n%s", manifest)
	}
	if strings.Contains(manifest, "app.kubernetes.io/instance") {
		t.Errorf("the manifest carries ArgoCD tracking metadata — the Application will prune it:\n%s", manifest)
	}
	// The plaintext must appear nowhere but inside the base64 payload.
	if strings.Contains(manifest, "pw-value") || strings.Contains(manifest, "cookie-value") {
		t.Errorf("a credential is in the manifest in plaintext:\n%s", manifest)
	}
	if got := secretValue(t, manifest, rabbitmqPasswordKey); got != "pw-value" {
		t.Errorf("password = %q, want pw-value", got)
	}
}

// Two queues in one project get two DIFFERENT credentials. A shared cookie would silently merge two
// clusters that the canvas says are separate.
func TestQueueCredentialsAreNotSharedBetweenQueues(t *testing.T) {
	qs := HetznerQueues(hetznerQueueProject("jobs", "events"), io.Discard)
	if len(qs) != 2 {
		t.Fatalf("derived %d queues, want 2", len(qs))
	}
	if qs[0].CredentialSecretName() == qs[1].CredentialSecretName() {
		t.Fatalf("both queues share the Secret %q", qs[0].CredentialSecretName())
	}
	first, err := rabbitmqErlangCookie()
	if err != nil {
		t.Fatal(err)
	}
	second, err := rabbitmqErlangCookie()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("two generated cookies are identical")
	}
}

// ── the migration ──────────────────────────────────────────────────────────────────────────────

// chartMintedSecretJSON is what the chart's own Secret looks like in the cluster. The chart marks it
// `helm.sh/resource-policy: keep`, so it survives the chart no longer rendering it — which is what
// makes adoption possible at all.
func chartMintedSecretJSON(data map[string]string) string {
	items := []any{map[string]any{
		"metadata": map[string]any{"name": "sh.helm.release.v1.addon-queue-jobs.v1"},
		"type":     "helm.sh/release.v1",
		// Deliberately carries both keys: a helm release Secret must be SKIPPED, not read.
		"data": map[string]string{rabbitmqPasswordKey: b64("helm-noise"), rabbitmqErlangCookieKey: b64("helm-noise")},
	}}
	if data != nil {
		items = append(items, map[string]any{
			"metadata": map[string]any{"name": "addon-queue-jobs-rabbitmq"},
			"type":     "Opaque",
			"data":     data,
		})
	}
	raw, err := json.Marshal(map[string]any{"items": items})
	if err != nil {
		panic(err)
	}
	return string(raw)
}

// The one-time rotation this fix could have caused is the very breakage it exists to prevent: a new
// erlang cookie partitions a RUNNING cluster. So the live values are carried across instead.
func TestEnsureQueueCredentialSecretAdoptsTheChartMintedCredentials(t *testing.T) {
	stub := newKubectlStub(t, 0,
		stubRule{Match: "app.kubernetes.io/instance=addon-queue-jobs", Stdout: chartMintedSecretJSON(map[string]string{
			rabbitmqPasswordKey:     b64("live-password"),
			rabbitmqErlangCookieKey: b64("live-cookie"),
		})},
	)
	var out strings.Builder
	if err := EnsureQueueCredentialSecret(oneQueue(t, "jobs"), &out, io.Discard); err != nil {
		t.Fatalf("EnsureQueueCredentialSecret: %v", err)
	}
	applied := stub.appliedManifests()
	if applied == "" {
		t.Fatalf("applied no manifest at all; calls = %v", stub.calls())
	}
	if got := secretValue(t, applied, rabbitmqErlangCookieKey); got != "live-cookie" {
		t.Errorf("erlang cookie = %q, want the live one — the cluster would partition", got)
	}
	if got := secretValue(t, applied, rabbitmqPasswordKey); got != "live-password" {
		t.Errorf("password = %q, want the live one", got)
	}
	if !strings.Contains(out.String(), "carrying the chart's live") {
		t.Errorf("did not report the adoption: %q", out.String())
	}
}

// ADOPTION IS PER KEY. The password and the cookie are unrelated secrets, so a chart Secret holding
// only the cookie still saves the cluster from a partition; the password is simply generated. An
// all-or-nothing rule would have thrown the live cookie away for a reason that has nothing to do
// with it.
func TestAdoptionIsPerKey(t *testing.T) {
	stub := newKubectlStub(t, 0,
		stubRule{Match: "app.kubernetes.io/instance=addon-queue-jobs", Stdout: chartMintedSecretJSON(map[string]string{
			rabbitmqErlangCookieKey: b64("live-cookie"),
		})},
	)
	var out strings.Builder
	if err := EnsureQueueCredentialSecret(oneQueue(t, "jobs"), &out, io.Discard); err != nil {
		t.Fatalf("EnsureQueueCredentialSecret: %v", err)
	}
	applied := stub.appliedManifests()
	if got := secretValue(t, applied, rabbitmqErlangCookieKey); got != "live-cookie" {
		t.Errorf("erlang cookie = %q, want the live one", got)
	}
	if got := secretValue(t, applied, rabbitmqPasswordKey); got == "" || got == "helm-noise" {
		t.Errorf("password = %q, want a freshly generated one", got)
	}
	if !strings.Contains(out.String(), rabbitmqErlangCookieKey) {
		t.Errorf("did not name which key was carried across: %q", out.String())
	}
}

// Nothing to adopt is the ordinary case for a queue that has never deployed, and it must not be
// reported as an adoption.
func TestAdoptionFindsNothingToCarry(t *testing.T) {
	for _, tc := range []struct {
		name string
		json string
	}{
		{"no secret at all", `{"items":[]}`},
		{"only a helm release secret", chartMintedSecretJSON(nil)},
		{"empty values", chartMintedSecretJSON(map[string]string{rabbitmqPasswordKey: "", rabbitmqErlangCookieKey: ""})},
		{"unreadable base64", chartMintedSecretJSON(map[string]string{rabbitmqErlangCookieKey: "not-base64!!"})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			newKubectlStub(t, 0, stubRule{Match: "app.kubernetes.io/instance=", Stdout: tc.json})
			live, err := adoptChartMintedQueueCredentials(oneQueue(t, "jobs"), io.Discard)
			if err != nil {
				t.Fatalf("a readable response must not error: %v", err)
			}
			if len(live) != 0 {
				t.Fatalf("adopted %v from a Secret with nothing to carry", live)
			}
		})
	}
}

// A complete Secret must not cost a Secret LISTING on every deploy either — the adoption read is
// for the migration, and running it forever would be a per-deploy cost for a one-time question.
func TestAdoptionIsNotConsultedForACompleteSecret(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret rabbitmq-jobs-credentials", Stdout: secretJSON(map[string]string{
		rabbitmqPasswordKey:     b64("live-password"),
		rabbitmqErlangCookieKey: b64("live-cookie"),
	})})
	if err := EnsureQueueCredentialSecret(oneQueue(t, "jobs"), io.Discard, io.Discard); err != nil {
		t.Fatalf("EnsureQueueCredentialSecret: %v", err)
	}
	if stub.calledWith("app.kubernetes.io/instance=") {
		t.Errorf("listed the chart's Secrets for a complete credential; calls = %v", stub.calls())
	}
}

// TestAFailedAdoptionReadRefusesToMint pins the regression that made this whole file necessary in
// the other direction: `adoptChartMintedQueueCredentials` used to answer a kubectl failure with
// `nil`, which is the same value it returns for "this queue was never charted". The caller answers
// "nothing to adopt" by MINTING A FRESH ERLANG COOKIE, so an apiserver blip on the one migration
// deploy that matters partitioned a live broker — under the log line "Seeding missing queue
// credentials…", and with no second chance, because the Secret is complete afterwards.
//
// Asserted on the SIDE EFFECT, not just the error: the point is not that a failure is reported, it
// is that no credential was written. A version that returns the error and mints anyway passes an
// error-only assertion.
func TestAFailedAdoptionReadRefusesToMint(t *testing.T) {
	// Exit 1 on the adoption LIST specifically — the apiserver blip. Everything else answers
	// normally, so the failure under test is the one being asserted and not a broken stub.
	newKubectlStub(t, 0,
		stubRule{Match: "app.kubernetes.io/instance=addon-queue-jobs", Exit: 1, Stdout: "the server was unable to return a response"},
	)

	data := map[string]string{}
	changed, adopted, err := completeQueueCredentials(oneQueue(t, "jobs"), data, io.Discard)

	if err == nil {
		t.Fatal("a failed read of the chart's Secret must be an error, not an empty adoption")
	}
	if !QueueLiveStateUnknown(err) {
		t.Errorf("the error must be recognisable to the deploy as an unknown live state; got %v", err)
	}
	if changed {
		t.Error("nothing may be reported as changed when the live state is unknown")
	}
	if len(adopted) != 0 {
		t.Errorf("nothing may be adopted from a failed read; got %v", adopted)
	}
	// The assertion that actually matters.
	for _, key := range rabbitmqCredentialKeys {
		if _, minted := data[key]; minted {
			t.Errorf("a fresh %q was minted over a broker whose live state we could not read", key)
		}
	}
}

// TestQueueLiveStateUnknownSeparatesTheTwoFailureKinds keeps the deploy's fatal/non-fatal split
// honest. Every ordinary seeding failure stays non-fatal by design — a queue that cannot be
// credentialled yet reports it on its own Application and the next deploy retries. If the predicate
// answered true for those too, one converging queue would fail an otherwise-healthy cluster.
func TestQueueLiveStateUnknownSeparatesTheTwoFailureKinds(t *testing.T) {
	if !QueueLiveStateUnknown(fmt.Errorf("wrapped: %w", errQueueLiveStateUnknown)) {
		t.Error("the sentinel must survive wrapping — the deploy sees it through two layers")
	}
	for _, err := range []error{
		errors.New("read queue credential secret ns/name: connection refused"),
		fmt.Errorf("generate RabbitMQ password: %w", errors.New("no entropy")),
		nil,
	} {
		if QueueLiveStateUnknown(err) {
			t.Errorf("an ordinary failure must stay non-fatal; %v was treated as an unknown live state", err)
		}
	}
}

// TestTheCredentialKeysMatchTheChartsOwnMintedSecret closes a hole the rest of this file cannot
// see, because every other fixture here is BUILT from `rabbitmqCredentialKeys` and therefore agrees
// with the constants by construction — including
// TestEnsureQueueCredentialSecretAdoptsTheChartMintedCredentials, whose `chartMintedSecretJSON`
// takes the same two constants as input. If the chart's minted keys ever diverge from ours,
// adoption silently finds nothing and mints a FRESH ERLANG COOKIE over a live broker, and not one
// existing test would notice.
//
// These are the keys the pinned chart actually writes, rendered rather than remembered:
//
//	helm repo add cloudpirates https://cloudpirates-io.github.io/helm-charts
//	helm template q cloudpirates/rabbitmq --version 0.21.9 | awk '/^kind: Secret/,/^---/'
//
// which yields `data: {password, erlang-cookie}` on a Secret labelled
// `app.kubernetes.io/instance: q` — the label the adoption LIST selects on.
//
// The values are golden and not fetched: CI has no network for a helm repo, and a test that
// silently skips when the fetch fails is a test that reports green over nothing. Re-run the two
// commands above when the pin in `apps/console/lib/cloud-providers/hetzner-services.ts` moves; if
// this fails after a bump, adoption is broken and the fix is here, not in the assertion.
func TestTheCredentialKeysMatchTheChartsOwnMintedSecret(t *testing.T) {
	const chartPin = "cloudpirates/rabbitmq 0.21.9"
	chartMintedKeys := []string{"password", "erlang-cookie"}

	if len(rabbitmqCredentialKeys) != len(chartMintedKeys) {
		t.Fatalf("%s mints %d keys, the runner reads %d: %v vs %v",
			chartPin, len(chartMintedKeys), len(rabbitmqCredentialKeys), chartMintedKeys, rabbitmqCredentialKeys)
	}
	for _, want := range chartMintedKeys {
		if !slices.Contains(rabbitmqCredentialKeys, want) {
			t.Errorf("%s mints the key %q, which the runner never reads — adoption would miss it and mint a fresh credential over a live broker", chartPin, want)
		}
	}
	for _, got := range rabbitmqCredentialKeys {
		if !slices.Contains(chartMintedKeys, got) {
			t.Errorf("the runner reads %q, which %s does not mint — adoption would treat a complete Secret as incomplete", got, chartPin)
		}
	}
}
