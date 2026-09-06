// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// queueSecretJSON is a `kubectl get secret -o json` holding one password, base64 as the API returns
// it. The password is what the digest in the script is computed from, so a test that wants the
// convergence to PROCEED has to hand back the same value the pod's env will claim to hold.
func queueSecretJSON(password string) string {
	return `{"data":{"password":"` + base64.StdEncoding.EncodeToString([]byte(password)) + `"}}`
}

// brokerPodsJSON is a `kubectl get pod -o json` listing for one queue's release.
func brokerPodsJSON(name, phase string, ready bool) string {
	return `{"items":[{"metadata":{"name":"` + name + `"},"status":{"phase":"` + phase +
		`","containerStatuses":[{"name":"rabbitmq","ready":` + map[bool]string{true: "true", false: "false"}[ready] + `}]}}]}`
}

// THE reason this exists: the reconciliation runs the other way round from everything else here.
// The Secret cannot be made to match the broker — the password the broker accepts was overwritten
// by ArgoCD reconciles long ago — so the broker is made to match the Secret.
func TestConvergeQueuePasswordExecsAgainstAReadyBroker(t *testing.T) {
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get secret", Stdout: queueSecretJSON("s3cret")},
		stubRule{Match: "get pod", Stdout: brokerPodsJSON("addon-queue-jobs-rabbitmq-0", "Running", true)},
	)
	var out strings.Builder
	if err := ConvergeQueuePassword(context.Background(), oneQueue(t, "jobs"), &out, io.Discard); err != nil {
		t.Fatalf("ConvergeQueuePassword: %v", err)
	}
	var exec string
	for _, c := range stub.calls() {
		if strings.HasPrefix(c, "exec ") {
			exec = c
		}
	}
	if exec == "" {
		t.Fatalf("never exec'd into the broker; calls = %v", stub.calls())
	}
	for _, want := range []string{
		"addon-queue-jobs-rabbitmq-0",
		"-n queues",
		// The container is named, not left to kubectl's first-container default: the release also
		// runs an init container, and an autoReload sidecar is one values flag away.
		"-c rabbitmq",
		"rabbitmqctl change_password",
	} {
		if !strings.Contains(exec, want) {
			t.Errorf("exec is missing %q: %q", want, exec)
		}
	}
	// THE SUBTLE ONE. The variables must reach the container UNEXPANDED — they are resolved there,
	// from the environment the chart populated out of the Secret. Expanding them in the runner (a
	// double-quoted command string) would send two EMPTY strings and blank the broker's password
	// while reporting success.
	for _, want := range []string{"$RABBITMQ_DEFAULT_USER", "$RABBITMQ_DEFAULT_PASS"} {
		if !strings.Contains(exec, want) {
			t.Errorf("%s was expanded before it reached the container: %q", want, exec)
		}
	}
	if !strings.Contains(out.String(), "Reconciling") {
		t.Errorf("did not report the reconciliation: %q", out.String())
	}
}

// No broker to talk to is the ORDINARY state on the deploy that creates a queue — the broker takes
// the Secret's password on its first boot, so there is nothing to reconcile. It must not be an
// error, and it must not be silent either: "no broker yet" and "converged" cannot look alike.
func TestConvergeQueuePasswordSkipsWhenNoBrokerIsReady(t *testing.T) {
	for _, tc := range []struct {
		name string
		json string
	}{
		{"no pods at all", `{"items":[]}`},
		{"running but not ready", brokerPodsJSON("addon-queue-jobs-rabbitmq-0", "Running", false)},
		{"ready but still pending", brokerPodsJSON("addon-queue-jobs-rabbitmq-0", "Pending", true)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Stdout: queueSecretJSON("s3cret")},
				stubRule{Match: "get pod", Stdout: tc.json})
			var errOut strings.Builder
			if err := ConvergeQueuePassword(context.Background(), oneQueue(t, "jobs"), io.Discard, &errOut); err != nil {
				t.Fatalf("ConvergeQueuePassword: %v", err)
			}
			for _, c := range stub.calls() {
				if strings.HasPrefix(c, "exec ") {
					t.Fatalf("exec'd into a broker that was not Ready: %q", c)
				}
			}
			if !strings.Contains(errOut.String(), "NOT reconciled") {
				t.Errorf("said nothing about skipping: %q", errOut.String())
			}
		})
	}
}

// A FAILED LISTING IS NOT AN ABSENT BROKER. `kubectl get` exits non-zero for an unreachable
// apiserver or an RBAC blip, and reporting that as "no pod" is how a deploy stops reconciling and
// says only that there was no broker — the same defect class the credential read carries a flag for.
func TestConvergeQueuePasswordRefusesToReadAFailedListingAsNoBroker(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Stdout: queueSecretJSON("s3cret")},
		stubRule{Match: "get pod", Exit: 1})
	var errOut strings.Builder
	err := ConvergeQueuePassword(context.Background(), oneQueue(t, "jobs"), io.Discard, &errOut)
	if err == nil {
		t.Fatal("a failed pod listing was reported as no broker")
	}
	if strings.Contains(errOut.String(), "NOT reconciled") {
		t.Errorf("reported a read failure as an ordinary skip: %q", errOut.String())
	}
	for _, c := range stub.calls() {
		if strings.HasPrefix(c, "exec ") {
			t.Fatalf("exec'd despite failing to list: %q", c)
		}
	}
}

func TestConvergeQueuePasswordSurfacesAnExecFailure(t *testing.T) {
	newKubectlStub(t, 0,
		stubRule{Match: "get secret", Stdout: queueSecretJSON("s3cret")},
		stubRule{Match: "get pod", Stdout: brokerPodsJSON("addon-queue-jobs-rabbitmq-0", "Running", true)},
		stubRule{Match: "exec", Exit: 1},
	)
	if err := ConvergeQueuePassword(context.Background(), oneQueue(t, "jobs"), io.Discard, io.Discard); err == nil {
		t.Fatal("a failed change_password was reported as success")
	}
}

func TestConvergeQueuePasswordRefusesAnUnsafeQueue(t *testing.T) {
	newKubectlStub(t, 0)
	bad := HetznerQueue{Name: "jobs; rm -rf /", Namespace: hetznerQueueNamespace, AddOnID: "queue-jobs"}
	if err := ConvergeQueuePassword(context.Background(), bad, io.Discard, io.Discard); err == nil {
		t.Fatal("reconciled the password for an unsafe queue name")
	}
}

// The pod name comes back from the API server, which already constrains it — but it interpolates
// into a command this package runs through `bash -c`, and a shell-command builder does not get to
// assume somebody upstream checked.
func TestConvergeQueuePasswordSkipsAnUnsafePodName(t *testing.T) {
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get secret", Stdout: queueSecretJSON("s3cret")},
		stubRule{Match: "get pod", Stdout: brokerPodsJSON("pod; rm -rf /", "Running", true)},
	)
	var errOut strings.Builder
	if err := ConvergeQueuePassword(context.Background(), oneQueue(t, "jobs"), io.Discard, &errOut); err != nil {
		t.Fatalf("ConvergeQueuePassword: %v", err)
	}
	for _, c := range stub.calls() {
		if strings.Contains(c, "rm -rf") {
			t.Fatalf("an unsafe pod name reached a command line: %q", c)
		}
	}
	if !strings.Contains(errOut.String(), "safely exec into") {
		t.Errorf("skipped the pod without saying why: %q", errOut.String())
	}
}

// ── the script, executed rather than asserted on ────────────────────────────────────────────────
//
// Everything above pins the COMMAND STRING. That is the right test for the kubectl arguments and
// the wrong one for the script: what matters about the script is how a shell behaves when it runs
// it, and a substring check passes on a script that has stopped behaving that way.
//
// It is also the only place the four refusals can be observed, and three of them exist because a
// review found the earlier version reported success in exactly the situations they cover.
func digestOf(password string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(password))) }

// runQueuePasswordScript runs the real script under a real `sh`, against a fake `rabbitmqctl` that
// knows the two subcommands the script uses: `list_users` answers from `users`, and
// `change_password` records its argv one line per argument — so an EMPTY argument is visible as a
// blank line rather than vanishing into whitespace.
func runQueuePasswordScript(t *testing.T, wantDigest string, users []string, env []string) (exit int, args, stderr string) {
	t.Helper()
	dir := t.TempDir()
	record := filepath.Join(dir, "argv")
	fake := filepath.Join(dir, "rabbitmqctl")
	script := "#!/bin/sh\n" +
		"for a in \"$@\"; do\n" +
		"  if [ \"$a\" = list_users ]; then printf '%s' \"" + strings.Join(users, "\\n") + "\"; [ -n \"" + strings.Join(users, "") + "\" ] && echo; exit 0; fi\n" +
		"done\n" +
		"for a in \"$@\"; do echo \"$a\" >> " + record + "; done\n"
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake rabbitmqctl: %v", err)
	}
	cmd := exec.Command("sh", "-c", queuePasswordScript(wantDigest))
	cmd.Env = append([]string{"PATH=" + dir + ":/usr/bin:/bin"}, env...)
	var errBuf strings.Builder
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if !errors.As(err, &ee) {
			t.Fatalf("run script: %v", err)
		}
		exit = ee.ExitCode()
	}
	raw, readErr := os.ReadFile(record)
	if readErr != nil && !os.IsNotExist(readErr) {
		t.Fatalf("read recorded argv: %v", readErr)
	}
	return exit, string(raw), errBuf.String()
}

func TestQueuePasswordScriptPassesBothValuesThrough(t *testing.T) {
	// A password with a space and a shell metacharacter, because the whole point of the quoting is
	// that neither of them splits or expands.
	const pw = "p w$USER;x"
	exit, args, errOut := runQueuePasswordScript(t, digestOf(pw), []string{"admin"},
		[]string{"RABBITMQ_DEFAULT_USER=admin", "RABBITMQ_DEFAULT_PASS=" + pw})
	if exit != 0 {
		t.Fatalf("script refused a well-formed container: exit %d, stderr %q", exit, errOut)
	}
	if args != "change_password\nadmin\n"+pw+"\n" {
		t.Errorf("rabbitmqctl received the wrong argv:\n%q", args)
	}
}

// THE ONE THE REVIEW FOUND. `env.valueFrom.secretKeyRef` resolves ONCE, at pod start, so a pod that
// booted before the Secret was last written holds a stale copy — and converging the broker to it
// re-creates #3590 permanently, while logging success. The digest is what makes the difference
// observable without putting the credential on any argv.
func TestQueuePasswordScriptRefusesAPodRunningOnAStaleSecret(t *testing.T) {
	exit, args, errOut := runQueuePasswordScript(t, digestOf("what the Secret holds NOW"), []string{"admin"},
		[]string{"RABBITMQ_DEFAULT_USER=admin", "RABBITMQ_DEFAULT_PASS=what the pod booted with"})
	if exit != 75 {
		t.Errorf("exit = %d, want 75", exit)
	}
	if args != "" {
		t.Errorf("converged the broker to a stale cached credential: %q", args)
	}
	if !strings.Contains(errOut, sentinelStalePod) {
		t.Errorf("the refusal is not distinguishable from the others: %q", errOut)
	}
}

// `change_password` fails when the user does not exist, and pre-#3304 queues are exactly the
// population whose first boot predates the console pinning `auth.username`. Folded in with a
// transient failure it reads as "not ready yet" forever.
func TestQueuePasswordScriptRefusesWhenTheBrokerHasNoSuchUser(t *testing.T) {
	const pw = "hunter2"
	exit, args, errOut := runQueuePasswordScript(t, digestOf(pw), []string{"rabbit", "guest"},
		[]string{"RABBITMQ_DEFAULT_USER=admin", "RABBITMQ_DEFAULT_PASS=" + pw})
	if exit != 76 {
		t.Errorf("exit = %d, want 76", exit)
	}
	if args != "" {
		t.Errorf("tried to change the password of a user that does not exist: %q", args)
	}
	if !strings.Contains(errOut, sentinelNoUser) {
		t.Errorf("the refusal is not distinguishable from the others: %q", errOut)
	}
	// ...and a user whose name merely CONTAINS the pinned one is not a match. `grep -qx`, not
	// `grep -q`: `administrator` is not `admin`.
	exit2, args2, _ := runQueuePasswordScript(t, digestOf(pw), []string{"administrator"},
		[]string{"RABBITMQ_DEFAULT_USER=admin", "RABBITMQ_DEFAULT_PASS=" + pw})
	if exit2 != 76 || args2 != "" {
		t.Errorf("a substring match was accepted as the user: exit %d, argv %q", exit2, args2)
	}
}

// Neither variable set — an upstream chart that renamed them, or a container this reconciliation was
// never shaped for. Two empty strings would BLANK a working credential.
func TestQueuePasswordScriptRefusesWhenTheVariablesAreMissing(t *testing.T) {
	for _, tc := range []struct {
		name string
		env  []string
	}{
		{"neither set", nil},
		{"user only", []string{"RABBITMQ_DEFAULT_USER=admin"}},
		{"password only", []string{"RABBITMQ_DEFAULT_PASS=hunter2"}},
		{"both set but empty", []string{"RABBITMQ_DEFAULT_USER=", "RABBITMQ_DEFAULT_PASS="}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			exit, args, errOut := runQueuePasswordScript(t, digestOf("x"), []string{"admin"}, tc.env)
			if exit != 78 {
				t.Errorf("exit = %d, want 78 (EX_CONFIG)", exit)
			}
			if args != "" {
				t.Errorf("rabbitmqctl was called with an incomplete environment: %q", args)
			}
			if !strings.Contains(errOut, sentinelUnsetVars) {
				t.Errorf("the refusal is not distinguishable from the others: %q", errOut)
			}
		})
	}
}

// Each sentinel maps to a DIFFERENT operator action, which is the whole reason they are separate.
func TestExplainQueueExecNamesTheActionForEachRefusal(t *testing.T) {
	for _, tc := range []struct{ sentinel, want string }{
		{sentinelStalePod, "restart the pod"},
		{sentinelNoUser, "no user by the name"},
		{sentinelUnsetVars, "no longer exports"},
		{sentinelNoDigest, "no sha256sum"},
	} {
		if got := explainQueueExec("some noise\n" + tc.sentinel + ": detail\n"); !strings.Contains(got, tc.want) {
			t.Errorf("%s explained as %q, want it to mention %q", tc.sentinel, got, tc.want)
		}
	}
	if got := explainQueueExec("connection refused"); !strings.Contains(got, "refused") {
		t.Errorf("an unrecognised failure lost its fallback: %q", got)
	}
}

// A LISTING THAT MATCHED PODS BUT RECOGNISED NONE IS A SHAPE CHANGE, not a queue that has yet to
// start — and the earlier version printed the reassuring "harmless on the deploy that creates the
// queue" for both. `queueBrokerContainer` is pinned by nothing (unlike `auth.existingSecret` and its
// key names, which the generated fixture asserts), so an upstream rename would turn this repair into
// a permanent no-op that reports itself as benign on every deploy.
func TestConvergeQueuePasswordDistinguishesAShapeChangeFromAnAbsentBroker(t *testing.T) {
	// Ready, Running, correctly labelled — and the container is called something else.
	const renamed = `{"items":[{"metadata":{"name":"addon-queue-jobs-rabbitmq-0"},"status":{"phase":"Running",` +
		`"containerStatuses":[{"name":"rabbitmq-server","ready":true}]}}]}`
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get secret", Stdout: queueSecretJSON("s3cret")},
		stubRule{Match: "get pod", Stdout: renamed},
	)
	var errOut strings.Builder
	if err := ConvergeQueuePassword(context.Background(), oneQueue(t, "jobs"), io.Discard, &errOut); err != nil {
		t.Fatalf("ConvergeQueuePassword: %v", err)
	}
	for _, c := range stub.calls() {
		if strings.HasPrefix(c, "exec ") {
			t.Fatalf("exec'd into a container it does not recognise: %q", c)
		}
	}
	got := errOut.String()
	if !strings.Contains(got, "SHAPE mismatch") || !strings.Contains(got, "1 pod(s) match") {
		t.Errorf("a renamed container was not reported as a shape change: %q", got)
	}
	// And it must NOT claim the benign reading, which is the whole defect.
	if strings.Contains(got, "Harmless") {
		t.Errorf("a shape change was reported as the harmless case: %q", got)
	}
}

// The absent-broker case keeps its reassuring message — the fix above must not turn every new queue
// into an alarming line, which would be trading one wrong report for another.
func TestConvergeQueuePasswordStillReadsAnEmptyListingAsANewQueue(t *testing.T) {
	newKubectlStub(t, 0,
		stubRule{Match: "get secret", Stdout: queueSecretJSON("s3cret")},
		stubRule{Match: "get pod", Stdout: `{"items":[]}`},
	)
	var errOut strings.Builder
	if err := ConvergeQueuePassword(context.Background(), oneQueue(t, "jobs"), io.Discard, &errOut); err != nil {
		t.Fatalf("ConvergeQueuePassword: %v", err)
	}
	if !strings.Contains(errOut.String(), "Harmless") || strings.Contains(errOut.String(), "SHAPE mismatch") {
		t.Errorf("an empty listing was not reported as a new queue: %q", errOut.String())
	}
}

// A CANCELLED DEPLOY MUST NOT SHELL OUT. `WaitAddOnsHealthy` returns immediately on `ctx.Done()`, so
// a timed-out deploy falls straight through to this step; without consulting the context it would
// then exec against a broker that may never answer, with no way to interrupt it.
func TestConvergeQueuePasswordStopsOnACancelledContext(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Stdout: queueSecretJSON("s3cret")})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := ConvergeQueuePassword(ctx, oneQueue(t, "jobs"), io.Discard, io.Discard); err == nil {
		t.Fatal("a cancelled deploy still reconciled")
	}
	if n := len(stub.calls()); n != 0 {
		t.Errorf("a cancelled deploy made %d kubectl call(s): %v", n, stub.calls())
	}
}

// The Secret is the AUTHORITY the broker is converged to, so a Secret with no password yet is not a
// thing to converge against — and it is not an error either. It is the deploy that creates a queue.
func TestConvergeQueuePasswordSkipsWhenTheSecretHasNoPasswordYet(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Stdout: ""})
	var errOut strings.Builder
	if err := ConvergeQueuePassword(context.Background(), oneQueue(t, "jobs"), io.Discard, &errOut); err != nil {
		t.Fatalf("ConvergeQueuePassword: %v", err)
	}
	for _, c := range stub.calls() {
		if strings.HasPrefix(c, "exec ") {
			t.Fatalf("exec'd with no Secret to converge to: %q", c)
		}
	}
	if !strings.Contains(errOut.String(), "nothing to reconcile the broker to") {
		t.Errorf("said nothing about skipping: %q", errOut.String())
	}
}

// A FAILED SECRET READ IS NOT AN ABSENT SECRET — the same distinction the pod listing draws, and the
// same reason: `--ignore-not-found` makes absence an empty SUCCESS, so a non-zero exit is a real
// failure and must not be read as "no password yet".
func TestConvergeQueuePasswordRefusesToReadAFailedSecretReadAsNoPassword(t *testing.T) {
	stub := newKubectlStub(t, 0, stubRule{Match: "get secret", Exit: 1})
	if err := ConvergeQueuePassword(context.Background(), oneQueue(t, "jobs"), io.Discard, io.Discard); err == nil {
		t.Fatal("a failed Secret read was reported as no password")
	}
	for _, c := range stub.calls() {
		if strings.HasPrefix(c, "exec ") {
			t.Fatalf("exec'd despite failing to read the Secret: %q", c)
		}
	}
}

// The digest, not the credential, is what crosses the process boundary. Stated as a test because it
// is a security property of the command string and the alternative (passing the password) is the
// obvious implementation.
func TestConvergeQueuePasswordNeverPutsTheCredentialOnTheCommandLine(t *testing.T) {
	const pw = "a-very-secret-password"
	stub := newKubectlStub(t, 0,
		stubRule{Match: "get secret", Stdout: queueSecretJSON(pw)},
		stubRule{Match: "get pod", Stdout: brokerPodsJSON("addon-queue-jobs-rabbitmq-0", "Running", true)},
	)
	if err := ConvergeQueuePassword(context.Background(), oneQueue(t, "jobs"), io.Discard, io.Discard); err != nil {
		t.Fatalf("ConvergeQueuePassword: %v", err)
	}
	for _, c := range stub.calls() {
		if strings.Contains(c, pw) {
			t.Fatalf("the credential reached a command line: %q", c)
		}
	}
	var exec string
	for _, c := range stub.calls() {
		if strings.HasPrefix(c, "exec ") {
			exec = c
		}
	}
	if !strings.Contains(exec, digestOf(pw)) {
		t.Errorf("the exec does not carry the Secret's digest: %q", exec)
	}
}
