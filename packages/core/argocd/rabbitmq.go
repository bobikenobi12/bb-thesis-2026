// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"slices"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// Credentials for an in-cluster RabbitMQ (a Hetzner `queue` node) — #3304.
//
// Hetzner sells no queue service, so a canvas `queue` node becomes a `cloudpirates/rabbitmq`
// release. Left to itself that chart MINTS both `auth.password` and `auth.erlangCookie` at RENDER
// time, so every render produces a different Secret. Under ArgoCD, where a marketplace-class
// Application runs `automated: {prune: true, selfHeal: true}`, that is not cosmetic: the
// Application is permanently OutOfSync and rewrites both values on every reconcile, forever.
//
// Neither value survives that treatment:
//
//   - the erlang cookie is the cluster's SHARED SECRET. Every node must present the same one;
//     rotating it partitions the cluster and the nodes refuse to re-form.
//   - the password is the credential the customer's `queue` binding already handed to their
//     application.
//
// So this file is the runner half: the credentials are minted ONCE, here, into a Secret the chart
// only READS (`auth.existingSecret` in hetznerQueueValues). No credential reaches a rendered
// manifest, and none lands in `config_snapshot` — the cluster is the store of record, exactly as it
// is for Harbor's admin password (harbor.go).
//
// The same rule as registry_secrets.go applies to what is written: the Secret carries the
// marketplace labels so PruneAddOnSecrets can remove it when the `queue` node is deleted, but
// deliberately NO ArgoCD tracking metadata. A Secret carrying `app.kubernetes.io/instance` becomes
// a resource the Application OWNS, and an owned resource that is not in the rendered manifest is
// exactly what `prune: true` deletes.

const (
	// hetznerQueueNamespace mirrors the console's NS.queue (hetzner-services.ts). Duplicated rather
	// than imported because Go cannot read the TS mapper, and asserted against the generated fixture
	// by test so it cannot drift silently.
	hetznerQueueNamespace = "queues"
	// rabbitmqPasswordKey / rabbitmqErlangCookieKey are the data keys the chart reads. They pair
	// with `auth.existingPasswordKey` / `auth.existingErlangCookieKey` in the rendered values — the
	// two must agree or the pod starts with an empty credential.
	rabbitmqPasswordKey     = "password"
	rabbitmqErlangCookieKey = "erlang-cookie"
	// rabbitmqPasswordBytes is the entropy of the generated password before encoding.
	rabbitmqPasswordBytes = 24
	// rabbitmqCookieLength matches `randAlphaNum 32`, what the chart minted before this took over.
	rabbitmqCookieLength = 32
)

// rabbitmqCredentialKeys are every key the chart reads from the Secret. Stated once so the
// completeness check and the manifest cannot disagree about what a COMPLETE credential is.
var rabbitmqCredentialKeys = []string{rabbitmqPasswordKey, rabbitmqErlangCookieKey}

// errQueueLiveStateUnknown marks the one failure the DEPLOY may not shrug off: we could not
// determine whether this queue already has live credentials.
//
// Every other seeding failure is non-fatal by design — a queue that cannot be credentialled yet
// reports a missing Secret on its Application and the next deploy retries, which must not fail an
// otherwise-healthy cluster. This one is different in kind. It does not mean "not ready"; it means
// "we are about to act on an unknown", and the action on the other side of it is minting a
// credential over a broker that may already be running with a different one.
var errQueueLiveStateUnknown = errors.New("queue live credential state unknown")

// QueueLiveStateUnknown reports whether a seeding error means the live credential state could not
// be determined, so the caller must stop rather than proceed on the assumption there is nothing to
// adopt.
func QueueLiveStateUnknown(err error) bool { return errors.Is(err, errQueueLiveStateUnknown) }

// HetznerQueue is one in-cluster RabbitMQ the runner must credential.
type HetznerQueue struct {
	// Name is the canvas `queue` node's name.
	Name string
	// Namespace is where the RabbitMQ release lives (the console's NS.queue).
	Namespace string
	// AddOnID is the synthesized add-on id the console gave this release (`queue-<name>`). It is
	// what PruneAddOnSecrets matches against the enabled set, so the Secret is swept exactly when
	// the node it belongs to is removed.
	AddOnID string
}

// CredentialSecretName is the Secret holding this queue's password and erlang cookie. It MUST equal
// the `auth.existingSecret` hetznerQueueValues() renders; a mismatch is silent in the manifest and
// surfaces only as a pod that will not start.
func (q HetznerQueue) CredentialSecretName() string { return "rabbitmq-" + q.Name + "-credentials" }

// valid reports whether every interpolated name is a safe RFC-1123 label. Fail-closed: these reach a
// kubectl command line and a rendered manifest, and they arrive via the DB-persisted config
// snapshot.
func (q HetznerQueue) valid() bool {
	return k8sNameRe.MatchString(q.Name) &&
		k8sNameRe.MatchString(q.Namespace) &&
		k8sNameRe.MatchString(q.AddOnID)
}

// HetznerQueues derives the in-cluster queues a deploy must credential.
//
// Hetzner only. Every other cloud provisions a real queue (SQS, Pub/Sub, Service Bus, MNS) whose
// credentials are the cloud's own; there is no chart there and nothing to seed, so returning a
// non-empty list would write Secrets nothing reads.
//
// A name this cannot safely interpolate is REPORTED, not silently dropped. Skipping in silence
// produces a queue whose Application applies cleanly and whose StatefulSet then sits at
// CreateContainerConfigError forever, with the only clue arriving much later from
// ReadDataEndpoints — which talks about endpoint read-back, not about a credential nobody seeded.
func HetznerQueues(vc *types.ProjectConfig, stderr io.Writer) []HetznerQueue {
	if vc == nil || vc.Provider != types.CloudProviderHetzner {
		return nil
	}
	out := make([]HetznerQueue, 0, len(vc.Queues))
	for _, q := range vc.Queues {
		queue := HetznerQueue{
			Name:      q.Name,
			Namespace: hetznerQueueNamespace,
			// MUST equal the id hetznerDataServicesToAddOns() gives this release, because that is
			// the id PruneAddOnSecrets sees in the enabled set. A test pins the shape against the
			// generated fixture.
			AddOnID: "queue-" + q.Name,
		}
		if !queue.valid() {
			fmt.Fprintf(stderr, "Warning: queue %q is not a name this runner can seed credentials for "+
				"(it must be an RFC-1123 label); its RabbitMQ will not start until the name is changed\n", q.Name)
			continue
		}
		out = append(out, queue)
	}
	return out
}

// EnsureQueueCredentialSecret gives a queue the credentials its chart reads, filling only what is
// absent and never rewriting a value that is already there.
//
// COMPLETE-WHAT-IS-MISSING, NOT APPLY-EVERY-DEPLOY, and the difference is the whole point.
// EnsureAddOnSecrets re-applies on every deploy because the values it writes come from the database
// and a rotation there SHOULD reach the cluster. These values exist nowhere but here: re-generating
// the cookie hands a running RabbitMQ a new cluster secret, which partitions it.
//
// It is also not EXISTS-SO-STOP. A Secret holding one of the two keys — hand-created from the
// chart's own README, or half-written — would otherwise be frozen in that state on this deploy and
// every deploy after it, while the StatefulSet sat at CreateContainerConfigError and the log said
// "leaving it in place".
func EnsureQueueCredentialSecret(q HetznerQueue, stdout, stderr io.Writer) error {
	if !q.valid() {
		return fmt.Errorf("refusing to seed credentials for invalid queue %q/%q", q.Namespace, q.Name)
	}
	name := q.CredentialSecretName()
	// --ignore-not-found makes absence an empty successful response while preserving real kubectl
	// failures, for the reason EnsureHarborSecret states: treating every read error as "absent"
	// overwrites live credentials during an apiserver blip, an expired token or an RBAC hiccup —
	// and the apply that follows would succeed, so nothing would surface until the next pod restart
	// wrote a different .erlang.cookie. That is the partition this file exists to prevent.
	raw, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get secret %s -n %s -o json --ignore-not-found", name, q.Namespace),
		".", nil,
	)
	if err != nil {
		return fmt.Errorf("read queue credential secret %s/%s: %w", q.Namespace, name, err)
	}
	// Values stay BASE64-ENCODED end to end: what is already in the cluster is copied across
	// untouched, so a key that exists cannot be altered by a decode/encode round trip.
	data := map[string]string{}
	labels := map[string]string{}
	if strings.TrimSpace(raw) != "" {
		var existing struct {
			Data     map[string]string `json:"data"`
			Metadata struct {
				Labels map[string]string `json:"labels"`
			} `json:"metadata"`
		}
		if err := json.Unmarshal([]byte(raw), &existing); err != nil {
			return fmt.Errorf("decode queue credential secret %s/%s: %w", q.Namespace, name, err)
		}
		for key, value := range existing.Data {
			data[key] = value
		}
		labels = existing.Metadata.Labels
	}

	changed, adopted, err := completeQueueCredentials(q, data, stderr)
	if err != nil {
		return fmt.Errorf("complete queue credential secret %s/%s: %w", q.Namespace, name, err)
	}
	if !changed {
		if labels["alethia.io/managed-by"] != "addon-marketplace" || labels[addonSecretLabelKey] != q.AddOnID {
			cmd := fmt.Sprintf(
				"kubectl label secret -n %s %s alethia.io/managed-by=addon-marketplace %s=%s --overwrite",
				q.Namespace, name, addonSecretLabelKey, q.AddOnID,
			)
			if err := utils.ExecuteCommand(cmd, ".", nil, stdout, stderr); err != nil {
				return fmt.Errorf("label complete queue credential secret %s/%s: %w", q.Namespace, name, err)
			}
		}
		fmt.Fprintf(stdout, "Queue credential secret %s/%s is complete; leaving it in place\n", q.Namespace, name)
		return nil
	}
	// WHICH keys were carried over is named, because "adopted" and "generated" have different
	// consequences for a running cluster and an operator reading this later cannot tell them apart
	// from a Secret alone — AND the two adoptions are not equally trustworthy, so the line says so.
	//
	// This is the only deploy that will ever say anything about it: once the Secret is complete,
	// every later deploy takes the "leaving it in place" return above and nothing re-derives the
	// password. An operator whose AMQP login is rejected after the migration goes looking in this
	// log, so the caveat has to be IN it rather than in a comment they will never read.
	if len(adopted) > 0 {
		fmt.Fprintf(stdout, "Seeding queue credential secret %s/%s, carrying the chart's live %s across.\n",
			q.Namespace, name, strings.Join(adopted, " and "))
		if slices.Contains(adopted, rabbitmqPasswordKey) {
			fmt.Fprintf(stdout, "  NOTE: the erlang cookie is authoritative, the password is NOT. RabbitMQ honours "+
				"RABBITMQ_DEFAULT_PASS only while its database is empty, so an adopted password is whatever the "+
				"chart's Secret last held and may not be the one the running broker accepts (#3590).\n")
		}
	} else {
		fmt.Fprintf(stdout, "Seeding missing queue credentials in %s/%s...\n", q.Namespace, name)
	}
	// The credentials ride a 0600 temporary manifest into `kubectl apply -f <file>`, never argv.
	return ApplyManifest(queueCredentialSecretManifest(q, data), stdout, stderr)
}

// completeQueueCredentials fills only the absent keys of data (base64-encoded, in place) and reports
// whether anything changed and which keys were taken from the chart's own Secret.
//
// PER KEY, NOT ALL-OR-NOTHING. The password and the erlang cookie are unrelated secrets, and the
// only thing that matters for each is whether the cluster is already running with a value — so a
// Secret holding a password but no cookie still takes the LIVE cookie from the chart's Secret
// rather than a fresh one that would partition the cluster.
//
// WHAT ADOPTION ACTUALLY GUARANTEES IS THE COOKIE. The init container rewrites `.erlang.cookie` from
// the environment on every pod start, so carrying the live value across is exactly right there. The
// password is a weaker claim and is deliberately not advertised as more: with `definitions.enabled`
// false, `RABBITMQ_DEFAULT_PASS` is honoured only while the Mnesia database is empty — the queue's
// very first boot — so on a cluster where ArgoCD has been rewriting the Secret every reconcile, the
// value read here is whatever the last selfHeal wrote and not necessarily what the broker accepts.
// Adopting it is still the better of the two available moves (it cannot be more wrong than a fresh
// random one), but reconciling a live broker's password needs `rabbitmqctl change_password` and is
// tracked separately.
func completeQueueCredentials(q HetznerQueue, data map[string]string, stderr io.Writer) (changed bool, adopted []string, err error) {
	missing := make([]string, 0, len(rabbitmqCredentialKeys))
	for _, key := range rabbitmqCredentialKeys {
		if _, ok := decodeSecretValue(data[key]); !ok {
			missing = append(missing, key)
		}
	}
	if len(missing) == 0 {
		return false, nil, nil
	}
	// Read ONCE, and only when something is actually missing — a complete Secret must not cost a
	// Secret listing on every deploy.
	live, err := adoptChartMintedQueueCredentials(q, stderr)
	if err != nil {
		// Fail CLOSED. Minting is the destructive branch here, so an unknown must not reach it.
		return false, nil, err
	}
	b64 := base64.StdEncoding.EncodeToString
	for _, key := range missing {
		if value, ok := live[key]; ok {
			data[key] = b64([]byte(value))
			adopted = append(adopted, key)
			continue
		}
		var value string
		switch key {
		case rabbitmqPasswordKey:
			value, err = rabbitmqPassword()
		case rabbitmqErlangCookieKey:
			value, err = rabbitmqErlangCookie()
		}
		if err != nil {
			return false, nil, fmt.Errorf("generate RabbitMQ %s: %w", key, err)
		}
		data[key] = b64([]byte(value))
	}
	return true, adopted, nil
}

// adoptChartMintedQueueCredentials returns whichever credentials a PREVIOUS release of this queue's
// chart minted for itself and are still readable, keyed as the chart's Secret keys them. Empty when
// there is nothing to adopt, which is the ordinary case for a queue that has never deployed.
//
// Found by the chart's own release label rather than by a derived name, for the reason
// data_endpoints.go states: every chart names its Secrets with its own `fullname` template, so a
// derived name is a guess, and a guess that misses here rotates a live cluster's cookie.
//
// The lookup is RELIABLE rather than lucky, and the ordering in deploy.go is why: this runs before
// ApplyAddOnsInWaves, so on the one deploy where adoption matters the old render — and its Secret —
// is still what the cluster is running. (ArgoCD honours the chart's `resource-policy: keep`, but
// nothing here depends on that.)
//
// Best-effort by contract: an unreachable or unreadable listing means "generate", which is the
// correct answer for a queue that has never deployed and the only available one otherwise. The
// values are read into memory and rendered into a 0600 manifest; they are never logged (kubectlJSON
// captures stdout rather than echoing it, which keeps a Secret listing out of the job log).
func adoptChartMintedQueueCredentials(q HetznerQueue, stderr io.Writer) (map[string]string, error) {
	release := AddOnAppName(q.AddOnID)
	if !k8sNameRe.MatchString(release) {
		// Not a failure: a name the runner cannot address has no chart-minted Secret to adopt, and
		// #3304 already decided such a queue keeps the chart's own minting.
		return nil, nil
	}
	var list struct {
		Items []struct {
			Type string            `json:"type"`
			Data map[string]string `json:"data"`
		} `json:"items"`
	}
	cmd := fmt.Sprintf("kubectl get secret -n %s -l app.kubernetes.io/instance=%s -o json", q.Namespace, release)
	if err := kubectlJSON(cmd, &list, stderr); err != nil {
		// A FAILED READ IS NOT AN ABSENT SECRET. Returning nil here made an apiserver blip, an
		// expired token and an RBAC hiccup indistinguishable from "this queue was never charted" —
		// and the caller answers "nothing to adopt" by MINTING A FRESH ERLANG COOKIE. On the one
		// migration deploy that matters that partitions a live broker, under the reassuring log
		// line "Seeding missing queue credentials…", and the window never reopens: the Secret is
		// complete afterwards, so every later deploy takes the "leaving it in place" path and
		// nothing re-derives it.
		//
		// This is the rule EnsureQueueCredentialSecret already states twenty lines above, for its
		// own read of the runner's Secret. The adoption read was the one place in the file that
		// broke it.
		return nil, fmt.Errorf("%w: list chart-minted secrets for %s/%s: %v", errQueueLiveStateUnknown, q.Namespace, release, err)
	}
	out := map[string]string{}
	for _, item := range list.Items {
		// Helm's own release secrets are not credentials.
		if item.Type == "helm.sh/release.v1" {
			continue
		}
		for _, key := range rabbitmqCredentialKeys {
			if _, taken := out[key]; taken {
				continue
			}
			if value, ok := decodeSecretValue(item.Data[key]); ok {
				out[key] = value
			}
		}
	}
	return out, nil
}

// decodeSecretValue decodes one base64 Secret value, reporting whether it held anything.
func decodeSecretValue(encoded string) (string, bool) {
	if encoded == "" {
		return "", false
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw) == 0 {
		return "", false
	}
	return string(raw), true
}

// rabbitmqRandReader is the entropy source, swappable so the failure path is testable. A credential
// generated from a failed reader must never be emitted: falling back to something weaker is how a
// "random" secret becomes guessable, and nothing downstream would notice.
var rabbitmqRandReader io.Reader = rand.Reader

// rabbitmqPassword returns the broker password.
//
// URL-SAFE, because this value reaches applications through an AMQP URI, where a `+` or a `/` has
// to be percent-encoded by every client that builds one.
func rabbitmqPassword() (string, error) {
	buf := make([]byte, rabbitmqPasswordBytes)
	if _, err := io.ReadFull(rabbitmqRandReader, buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// rabbitmqCookieAlphabet is alphanumerics only — the charset `randAlphaNum` uses, which is what the
// chart minted before this file took the job over.
const rabbitmqCookieAlphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

// rabbitmqErlangCookie returns the cluster's shared secret.
//
// ALPHANUMERIC, NOT URL-SAFE BASE64, and deliberately not the same generator as the password. The
// cookie rides no URI, so URL-safety buys nothing — while RabbitMQ documents the cookie as
// alphanumeric characters, and it passes through more hands than the password does: it becomes an
// Erlang atom, the init container writes it to `.erlang.cookie` through a shell `echo`, and
// `rabbitmqctl` / `rabbitmq-diagnostics` (the chart's own probes) read it back. Spending a
// documented constraint to save a line is not a trade worth making, and this keeps the value
// identical in shape to what every existing deployment already runs.
func rabbitmqErlangCookie() (string, error) {
	limit := big.NewInt(int64(len(rabbitmqCookieAlphabet)))
	out := make([]byte, rabbitmqCookieLength)
	for i := range out {
		n, err := rand.Int(rabbitmqRandReader, limit)
		if err != nil {
			return "", err
		}
		out[i] = rabbitmqCookieAlphabet[n.Int64()]
	}
	return string(out), nil
}

// queueCredentialSecretManifest renders the namespace + the credential Secret from ALREADY-ENCODED
// values, so a key copied out of the cluster goes back in byte-identical.
//
// The namespace is included (like addonSecretManifest and harborAdminSecretManifest) because this
// Secret must exist BEFORE the queue's Application first syncs and creates the namespace itself
// via CreateNamespace=true.
func queueCredentialSecretManifest(q HetznerQueue, encoded map[string]string) string {
	var b strings.Builder
	fmt.Fprintf(&b, `apiVersion: v1
kind: Namespace
metadata:
  name: %[1]s
---
apiVersion: v1
kind: Secret
metadata:
  name: %[2]s
  namespace: %[1]s
  labels:
    alethia.io/managed-by: addon-marketplace
    %[3]s: %[4]s
type: Opaque
data:
`, q.Namespace, q.CredentialSecretName(), addonSecretLabelKey, q.AddOnID)
	// Iterated over the DECLARED key list, not over the map: a deterministic render, and a key the
	// chart does not read cannot ride along from whatever was in the cluster.
	for _, key := range rabbitmqCredentialKeys {
		fmt.Fprintf(&b, "  %s: %s\n", key, encoded[key])
	}
	return b.String()
}
