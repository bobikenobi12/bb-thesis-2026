// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// Reconciling a Hetzner `queue` node's BROKER to its credential Secret — #3590.
//
// #3304 made the Secret the store of record for a queue's password and stopped the chart rewriting
// it. That is not enough on a cluster that deployed BEFORE it, and the reason is a RabbitMQ
// property rather than anything this repo did:
//
//	`definitions.enabled` is false for these releases, so the ONLY thing that ever sets the user's
//	password is `RABBITMQ_DEFAULT_PASS` — and RabbitMQ honours that only while the Mnesia database
//	is EMPTY, i.e. on the queue's very first boot.
//
// Before #3304, ArgoCD rewrote that Secret on every reconcile. So on any queue that has been up for
// more than one reconcile, the broker still accepts the password from its FIRST boot while the
// Secret holds whatever the last selfHeal wrote — and `ReadDataEndpoints` publishes that Secret to
// the console as the queue's credential. An application that resolves the binding and authenticates
// with the published password fails. The value the broker does accept was overwritten long ago and
// cannot be recovered.
//
// So the reconciliation has to run the other way: make the BROKER match the Secret.
//
// ── Why not the declarative route ───────────────────────────────────────────────────────────────
//
// The chart exposes `definitions.existingSecret` and its values file shows exactly the shape that
// looks like the answer — `users: [{name, password_hash, hashing_algorithm}]` — with an autoReload
// sidecar on top. It is a dead end, and it was checked before any of this was written:
// https://www.rabbitmq.com/docs/definitions states "The definitions in the file will not overwrite
// anything already in the broker." Import is ADDITIVE. A user that already exists keeps the
// password it already has, which is the entire problem here.
//
// ── Why `rabbitmqctl`, and why no credential rides the command ──────────────────────────────────
//
// `rabbitmqctl` authenticates to the node with the ERLANG COOKIE, not with the user's password
// (https://www.rabbitmq.com/docs/man/rabbitmqctl.8), so it works precisely when the password is
// unknown — which is the situation by definition.
//
// The pod already holds both values in its environment, wired by the chart from the very Secret
// this reconciles to. So the command names environment VARIABLES and the container supplies the
// values: nothing reaches the runner's argv, the job log, or the config snapshot. (The password
// does appear in the container's own process list for the life of the call — `change_password`
// takes it as an argument and has no stdin form — which is a smaller exposure than the alternatives
// and is stated rather than glossed.)
//
// CONVERGENCE, NOT ROTATION. It sets the broker to the value the Secret already holds, so it is
// idempotent, it is a no-op on a queue whose password is already right, and it also repairs a
// password somebody changed by hand.

// queueBrokerContainer is the chart's container name. Named explicitly rather than left to
// kubectl's "first container" default: the release also runs an `init-erlang-cookie` init container
// today and an autoReload sidecar is one values flag away, and exec'ing into the wrong one fails in
// a way that reads like a broken broker.
//
// It is LESS PINNED than the environment variable names below — `auth.existingSecret` and its two
// key names are asserted against the generated fixture, and nothing anywhere asserts this. That is
// why a listing that finds pods but no container of this name is reported as its own outcome rather
// than folded into "no broker yet": see readyQueueBrokerPod.
const queueBrokerContainer = "rabbitmq"

// The sentinels the in-container script writes to stderr so the four ways it can refuse stay
// DISTINGUISHABLE after they have crossed a process boundary. An exit code would not survive
// `utils.ExecuteCommand`, and the operator responses are completely different — one needs a pod
// restart, one needs a chart investigation, one needs a user created, and one is transient.
const (
	sentinelUnsetVars = "ALETHIA_QUEUE_ENV_UNSET"
	sentinelStalePod  = "ALETHIA_QUEUE_POD_ENV_STALE"
	sentinelNoUser    = "ALETHIA_QUEUE_NO_SUCH_USER"
	sentinelNoDigest  = "ALETHIA_QUEUE_NO_DIGEST_TOOL"
)

// queueExecTimeout bounds the two kubectl calls. `WaitAddOnsHealthy` returns immediately on
// `ctx.Done()`, so a cancelled deploy falls straight through to this step — and a broker replaying
// its Mnesia log or wedged on a partitioned Erlang node is EXACTLY the population this repair
// targets. Without a bound, a best-effort repair becomes the reason a job never finishes.
const queueExecTimeout = 90 * time.Second

// queuePasswordScript is the shell that runs INSIDE the broker container. It is built rather than
// stored as a constant because it carries the expected credential DIGEST, and it is executed by a
// test under a real `sh` rather than asserted on as text — the properties below are properties of
// how a shell behaves, and a substring check passes on a script that has stopped having them.
//
// SINGLE-QUOTED at the call site on purpose. utils.ExecuteCommand runs the whole thing through
// `bash -c`, which strips the outer quotes and hands this string to the container's `sh` WITHOUT
// expanding `$…` — so the variables resolve inside the pod, from the environment the chart
// populated out of the Secret. Double quotes there would expand them in the RUNNER, where they are
// empty. (It therefore contains no single quote of its own, and cannot.)
//
// ── THE DIGEST CHECK IS THE POINT, not a nicety ─────────────────────────────────────────────────
//
// `RABBITMQ_DEFAULT_PASS` reaches the container through `env.valueFrom.secretKeyRef`, which
// Kubernetes resolves ONCE, AT POD START. It is not a live view of the Secret. Converging the
// broker to it therefore converges the broker to whatever the Secret held when the pod last booted
// — which is not the same claim, and on the case that matters they disagree:
//
//	`completeQueueCredentials` completes what is MISSING, so a Secret that lost (or never had) the
//	`password` key gets a freshly generated one written on a deploy where the broker is already
//	running. That apply changes no pod-template field, so the StatefulSet does NOT roll. The pod
//	keeps the old value; an unguarded exec would set the broker to the OLD password and report
//	success, while the console publishes a reference to the Secret holding the NEW one. Every later
//	deploy repeats it verbatim, because the Secret is now complete and nothing re-derives it. The
//	divergence is permanent until somebody restarts the pod — the #3590 symptom, re-created by its
//	own fix.
//
// So the script compares a SHA-256 of the pod's cached value against the digest of what the Secret
// holds now, and refuses when they differ. The DIGEST travels on the argv, never the credential: it
// is a hash of 24 bytes of `crypto/rand`, so it is not a thing an argv reader can invert, and the
// alternative — passing the password itself — is what putting a credential in the runner's process
// list and job log looks like.
//
// ── AND THE USER MUST EXIST ─────────────────────────────────────────────────────────────────────
//
// `change_password` fails when the user does not exist, and pre-#3304 queues are exactly the
// population whose FIRST BOOT — the only boot whose `RABBITMQ_DEFAULT_USER` the broker ever
// honoured — predates the console pinning `auth.username` to `admin`. Folded in with a transient
// exec failure, that reads as "not ready yet" forever while the queue stays unauthenticatable.
func queuePasswordScript(wantDigest string) string {
	return strings.Join([]string{
		// 1. The variables must be there at all. See the block above on why an upstream rename is
		//    a live possibility rather than a hypothetical.
		`if [ -z "$RABBITMQ_DEFAULT_USER" ] || [ -z "$RABBITMQ_DEFAULT_PASS" ]; then`,
		`echo ` + sentinelUnsetVars + `: RABBITMQ_DEFAULT_USER/RABBITMQ_DEFAULT_PASS are not both set in this container >&2; exit 78; fi;`,
		// 2. Hash the pod's cached value. A container with no digest tool is its OWN outcome: it
		//    must not fall through to a comparison that cannot be made.
		// THREE DIGEST TOOLS, tried in order, because "the container has sha256sum" is the same
		// shape of unpinned assumption as the variable names above — coreutils on a Debian-based
		// image, `shasum` on a BusyBox or macOS-like userland, `openssl` on an image that carries
		// neither. Pinning one and calling the others impossible is how this refuses to run on an
		// image nobody expected. If all three are missing it is still its OWN outcome: it must not
		// fall through to a comparison that could not be made.
		`have=$(printf %s "$RABBITMQ_DEFAULT_PASS" | sha256sum 2>/dev/null | cut -d" " -f1);`,
		`if [ -z "$have" ]; then have=$(printf %s "$RABBITMQ_DEFAULT_PASS" | shasum -a 256 2>/dev/null | cut -d" " -f1); fi;`,
		`if [ -z "$have" ]; then have=$(printf %s "$RABBITMQ_DEFAULT_PASS" | openssl dgst -sha256 -r 2>/dev/null | cut -d" " -f1); fi;`,
		`if [ -z "$have" ]; then echo ` + sentinelNoDigest + `: no sha256sum, shasum or openssl in this container, cannot verify the pod is reading the current Secret >&2; exit 77; fi;`,
		`if [ "$have" != "` + wantDigest + `" ]; then`,
		`echo ` + sentinelStalePod + `: this pod started before the Secret was last written, so its cached credential is not the one the console publishes >&2; exit 75; fi;`,
		// 3. The user has to exist before change_password can mean anything.
		`if ! rabbitmqctl -q list_users 2>/dev/null | cut -f1 | grep -qx "$RABBITMQ_DEFAULT_USER"; then`,
		`echo ` + sentinelNoUser + `: the broker has no user by that name >&2; exit 76; fi;`,
		`rabbitmqctl change_password "$RABBITMQ_DEFAULT_USER" "$RABBITMQ_DEFAULT_PASS"`,
	}, " ")
}

// ConvergeQueuePassword makes the running broker accept the password in the queue's credential
// Secret.
//
// Returns nil when there is no Ready broker to talk to — the ordinary state on the deploy that
// CREATES a queue, since the broker takes the Secret's password on its first boot anyway. It is
// REPORTED rather than passed over in silence, because "no broker yet" and "converged" must not
// look alike in a job log.
func ConvergeQueuePassword(ctx context.Context, q HetznerQueue, stdout, stderr io.Writer) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("reconcile the broker password for queue %s: %w", q.Name, err)
	}
	if !q.valid() {
		return fmt.Errorf("refusing to reconcile the broker password for invalid queue %q/%q", q.Namespace, q.Name)
	}
	release := AddOnAppName(q.AddOnID)
	if !k8sNameRe.MatchString(release) {
		return fmt.Errorf("refusing to reconcile the broker password for queue %q: %q is not a valid release name", q.Name, release)
	}

	// THE SECRET IS THE AUTHORITY, so it is read here rather than inferred from the pod. Its digest
	// is what the script compares against; the value itself never leaves this process.
	want, err := queueSecretPassword(q)
	if err != nil {
		return err
	}
	if want == "" {
		fmt.Fprintf(stderr, "Queue %s has no `%s` in %s/%s yet — nothing to reconcile the broker to. "+
			"EnsureQueueCredentialSecret seeds it; the next deploy re-runs this.\n",
			q.Name, rabbitmqPasswordKey, q.Namespace, q.CredentialSecretName())
		return nil
	}
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(want)))

	pod, matched, err := readyQueueBrokerPod(q, release, stderr)
	if err != nil {
		return err
	}
	if pod == "" {
		// THE THREE ABSENCES ARE NOT ONE. A listing that matched pods but recognised none of them is
		// a SHAPE change — an upstream container rename, or a release label that stopped carrying
		// the instance — and reporting it as "harmless on the deploy that creates the queue" turns
		// this repair into a permanent no-op that congratulates itself on every deploy.
		if matched > 0 {
			fmt.Fprintf(stderr, "Queue %s: %d pod(s) match app.kubernetes.io/instance=%s but none has a Ready "+
				"container named %q — the broker password was NOT reconciled. This is a SHAPE mismatch, not a "+
				"queue that has yet to start: if the chart renamed its container this repair is inert on every "+
				"deploy until %q is updated.\n",
				q.Name, matched, release, queueBrokerContainer, queueBrokerContainer)
			return nil
		}
		fmt.Fprintf(stderr, "No broker pod for queue %s (namespace %s) — its password was NOT reconciled "+
			"against %s. Harmless on the deploy that creates the queue, since the broker takes the Secret's "+
			"password on its first boot; the next deploy re-runs this.\n",
			q.Name, q.Namespace, q.CredentialSecretName())
		return nil
	}

	fmt.Fprintf(stdout, "Reconciling queue %s's broker password to %s/%s...\n",
		q.Name, q.Namespace, q.CredentialSecretName())
	// See queuePasswordScript for why the quoting is what it is, and what each refusal means.
	cmd := fmt.Sprintf(
		`kubectl exec %s -n %s -c %s --request-timeout=%s -- sh -c '%s'`,
		pod, q.Namespace, queueBrokerContainer, queueExecTimeout, queuePasswordScript(digest),
	)
	var captured bytes.Buffer
	if err := utils.ExecuteCommand(cmd, ".", nil, stdout, io.MultiWriter(stderr, &captured)); err != nil {
		return fmt.Errorf("reconcile the broker password for queue %s: %s: %w", q.Name, explainQueueExec(captured.String()), err)
	}
	return nil
}

// explainQueueExec turns the script's sentinel into the sentence an operator can act on. Each of
// these needs a DIFFERENT response, which is the whole reason they are not one error.
func explainQueueExec(stderr string) string {
	switch {
	case strings.Contains(stderr, sentinelStalePod):
		return "the broker pod is running on a cached copy of an older Secret (env.valueFrom is resolved once, at pod start) — " +
			"restart the pod so it re-reads the Secret, then re-run the deploy"
	case strings.Contains(stderr, sentinelNoUser):
		return "the broker has no user by the name the chart pins — its user set was written on its FIRST boot, which for a " +
			"pre-#3304 queue predates that pin; the user has to be created before a password can be changed"
	case strings.Contains(stderr, sentinelUnsetVars):
		return "the chart no longer exports RABBITMQ_DEFAULT_USER/RABBITMQ_DEFAULT_PASS to this container — refused rather " +
			"than blanking the credential with two empty strings"
	case strings.Contains(stderr, sentinelNoDigest):
		return "the container has no sha256sum, so the pod's credential could not be checked against the Secret"
	default:
		return "rabbitmqctl refused"
	}
}

// queueSecretPassword reads the queue's credential Secret and returns the password it holds, or ""
// when the Secret or the key is absent.
//
// `--ignore-not-found` makes ABSENCE an empty successful response while preserving real kubectl
// failures — the same distinction EnsureQueueCredentialSecret draws, for the same reason: a read
// error reported as "absent" is how this stops reconciling and says only that there was nothing to
// do.
func queueSecretPassword(q HetznerQueue) (string, error) {
	name := q.CredentialSecretName()
	raw, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get secret %s -n %s --request-timeout=%s -o json --ignore-not-found", name, q.Namespace, queueExecTimeout),
		".", nil,
	)
	if err != nil {
		return "", fmt.Errorf("read queue credential secret %s/%s: %w", q.Namespace, name, err)
	}
	if strings.TrimSpace(raw) == "" {
		return "", nil
	}
	var existing struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal([]byte(raw), &existing); err != nil {
		return "", fmt.Errorf("decode queue credential secret %s/%s: %w", q.Namespace, name, err)
	}
	value, ok := decodeSecretValue(existing.Data[rabbitmqPasswordKey])
	if !ok {
		return "", nil
	}
	return value, nil
}

// readyQueueBrokerPod returns the name of a pod whose broker container is Ready, plus HOW MANY pods
// the selector matched at all.
//
// The count is the difference between "this queue has not started" and "this queue is not the shape
// this code knows", and the caller needs it: without it both render as the reassuring message and a
// chart-side rename becomes a silent permanent no-op.
//
// An unreadable listing is an ERROR rather than "no pod": the two mean different things, and
// reporting a failed read as an absence is how a deploy silently stops reconciling.
func readyQueueBrokerPod(q HetznerQueue, release string, stderr io.Writer) (string, int, error) {
	var pods struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Status struct {
				Phase             string `json:"phase"`
				ContainerStatuses []struct {
					Name  string `json:"name"`
					Ready bool   `json:"ready"`
				} `json:"containerStatuses"`
			} `json:"status"`
		} `json:"items"`
	}
	raw, err := utils.ExecuteCommandWithOutput(
		fmt.Sprintf("kubectl get pod -n %s -l app.kubernetes.io/instance=%s --request-timeout=%s -o json",
			q.Namespace, release, queueExecTimeout),
		".", nil,
	)
	if err != nil {
		return "", 0, fmt.Errorf("list broker pods for queue %s: %w", q.Name, err)
	}
	if err := json.Unmarshal([]byte(raw), &pods); err != nil {
		return "", 0, fmt.Errorf("decode broker pods for queue %s: %w", q.Name, err)
	}
	matched := len(pods.Items)
	for _, item := range pods.Items {
		if item.Status.Phase != "Running" {
			continue
		}
		// READY, not merely Running. A broker still replaying its Mnesia log answers the CLI port
		// with a connection refused, and the failure reads like a wrong erlang cookie.
		for _, cs := range item.Status.ContainerStatuses {
			if cs.Name != queueBrokerContainer || !cs.Ready {
				continue
			}
			// The name comes back from the API server, which already constrains it — but it
			// interpolates into a command string this package runs through `bash -c`, and a
			// shell-command builder does not get to assume somebody upstream checked.
			if !k8sNameRe.MatchString(item.Metadata.Name) {
				fmt.Fprintf(stderr, "Warning: skipping broker pod %q for queue %s — not a name this can safely exec into\n",
					item.Metadata.Name, q.Name)
				continue
			}
			return item.Metadata.Name, matched, nil
		}
	}
	return "", matched, nil
}
