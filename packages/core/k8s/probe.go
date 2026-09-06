// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

var executeCommandWithOutput = utils.ExecuteCommandWithOutput

// probeImage is the tiny image the in-cluster reachability probe runs (needs a shell + nc;
// busybox has both). Overridable for air-gapped/mirror registries.
func probeImage() string {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_CLUSTER_PROBE_IMAGE")); v != "" {
		return v
	}
	return "busybox:1.36"
}

// WaitClusterReady blocks until a freshly-provisioned cluster's API server answers and
// (optionally) at least one node reaches Ready, or the timeout elapses. It shells kubectl
// against the KUBECONFIG the provider's ConfigureKubeconfig just set (every provider does
// os.Setenv("KUBECONFIG", …)), reusing the same exec path as the ArgoCD install.
//
// The caller treats a returned error as FATAL: a cluster that never becomes reachable is
// not a working cluster, and reporting SUCCESS on `tofu apply` alone hides broken clusters
// from the user. `requireNode` waits for >=1 Ready node (node-group clusters); pass false
// when nodes are provisioned on-demand (e.g. Karpenter-only) so API-reachability is the bar.
func WaitClusterReady(ctx context.Context, timeout time.Duration, requireNode bool, stdout io.Writer) error {
	started := time.Now()
	deadline := started.Add(timeout)
	// The budget is announced here and quoted again in all THREE failure messages below — the
	// cancelled-context one, the unreachable-API one, and the no-Ready-node one. All four renders go
	// through format.Duration so one run cannot print the same configured value two ways: the
	// default 15m budget is `15m0s` from Duration.String() and `15m 0s` from format.Duration, and
	// a banner and a failure message disagreeing about it makes the reader guess which is the
	// setting they configured.
	//
	// COUNT THE RENDERS, not the messages. The first draft of this migrated three of the four and
	// left the no-Ready-node one raw — which is the DEFAULT path (clusterReadyRequireNode is true
	// unless explicitly disabled), so it turned a tree where all four agreed at `15m0s` into one
	// where the banner and the commonest failure disagreed. Exactly the defect this comment gives
	// as the reason the banner had to move.
	//
	// KNOWN LOSS, accepted: format.Duration drops seconds above an hour, so a budget of
	// `1h30m45s` echoes as `1h 30m`. Rounding a MEASUREMENT is free; rounding a value the operator
	// TYPED is not obviously free, and this is the latter. It is accepted because seconds survive
	// intact below an hour (a `90s` budget is `1m 30s`, exactly) and an hour-plus budget with
	// second precision is not a thing anyone sets. If it ever matters, the fix is to echo the raw
	// ALETHIA_CLUSTER_READY_TIMEOUT string the operator set rather than re-rendering the parsed
	// Duration — re-rendering can never be lossless, whichever formatter it uses.
	fmt.Fprintf(stdout, "Waiting for the cluster to become reachable (timeout %s)...\n", format.Duration(timeout))

	// 1. API server reachable — poll readyz, but keep WHY it fails (auth vs network vs not-ready)
	// so a timeout is diagnosable at a glance, and fast-fail on a persistent auth rejection (an
	// access-entry/RBAC problem never resolves by waiting — no reason to burn the full timeout).
	var lastErr error
	var lastOut string
	authRejections := 0
	apiErr := func() error {
		for {
			out, e := executeCommandWithOutput("kubectl get --raw=/readyz", ".", nil)
			if e == nil {
				return nil
			}
			lastErr, lastOut = e, out
			if isAuthRejection(classifyReachability(e, out)) {
				authRejections++
				if authRejections >= authRejectFastFail {
					return fmt.Errorf("auth rejected on %d consecutive probes", authRejections)
				}
			} else {
				authRejections = 0
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("timed out")
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(10 * time.Second):
			}
		}
	}()
	if apiErr != nil {
		// A caller who cancelled (job cancelled, parent deadline) is NOT a cluster fault, and must not
		// be dressed as one: classifyReachability has no bucket for a context error, so routing a
		// cancellation through the last probe's verdict reports "NETWORK UNREACHABLE" and sends the
		// operator to a firewall nobody's cluster ever refused — the #1259 misdiagnosis class again.
		// ctx.Err() is what gets wrapped, so callers can test errors.Is(err, context.Canceled) /
		// context.DeadlineExceeded; the last probe error stays as colour but drives nothing.
		if errors.Is(apiErr, context.Canceled) || errors.Is(apiErr, context.DeadlineExceeded) {
			return fmt.Errorf("waiting for the cluster API server was cancelled after %s (timeout %s) — the caller's context ended, so this is NOT a cluster fault%s: %w",
				format.Duration(time.Since(started)), format.Duration(timeout), lastProbeDetail(lastErr), apiErr)
		}
		if lastErr == nil {
			lastErr = apiErr
		}
		// Report ELAPSED, not the configured timeout. The fast-fail path gives up after ~60s, so
		// quoting the 15m budget made a rejected token read as a hang and sent readers looking for a
		// slow endpoint (#1259).
		//
		// ELAPSED and BUDGET are rendered by the SAME function, deliberately. They are two spans of
		// the same kind sitting in one sentence, and the reader's whole job here is to compare them:
		// `after 1m 2s (timeout 15m0s)` invites reading two different units. format.Duration drops
		// seconds only once a span passes an hour, and it drops them from BOTH numbers at the same
		// threshold, so the comparison never becomes apples-to-oranges.
		return fmt.Errorf("cluster API server did not become reachable after %s (timeout %s) — %s: %w",
			format.Duration(time.Since(started)), format.Duration(timeout), classifyReachability(lastErr, lastOut), lastErr)
	}
	fmt.Fprintln(stdout, "Cluster API server is reachable.")

	if !requireNode {
		return nil
	}

	// 2. At least one node Ready.
	var lastReady, lastTotal int
	var lastNodesRaw []byte
	if err := pollUntil(ctx, deadline, 15*time.Second, func() bool {
		raw, err := executeCommandWithOutput("kubectl get nodes -o json", ".", nil)
		if err != nil {
			return false
		}
		lastNodesRaw = []byte(raw)
		ready, total, perr := CountReadyNodes(lastNodesRaw)
		if perr != nil {
			return false
		}
		lastReady, lastTotal = ready, total
		return ready > 0
	}); err != nil {
		// Surface WHY the nodes are NotReady (KubeletNotReady, "container runtime network not
		// ready" = CNI missing, taints) so a node-datapath failure is diagnosable without kubectl.
		detail := ""
		if reasons := NotReadyReasons(lastNodesRaw); len(reasons) > 0 {
			detail = " — NotReady: " + strings.Join(reasons, "; ")
		}
		return fmt.Errorf("no cluster node reached Ready within %s (%d/%d ready)%s: %w",
			format.Duration(timeout), lastReady, lastTotal, detail, err)
	}
	fmt.Fprintf(stdout, "%d/%d nodes Ready.\n", lastReady, lastTotal)
	return nil
}

// lastProbeDetail renders the last probe error as diagnostic context on a cancelled wait. It is
// deliberately a parenthetical: on a cancellation the probe's verdict is stale evidence, useful to
// read but never the diagnosis. Empty when no probe has failed yet. Pure/unit-tested.
func lastProbeDetail(lastErr error) string {
	if lastErr == nil {
		return ""
	}
	return " (last probe error: " + lastErr.Error() + ")"
}

// reachClass names WHICH layer a reachability probe is failing at, so a timeout tells the operator
// where to look instead of just "not reachable".
type reachClass string

const (
	// AUTHENTICATION (401) and AUTHORIZATION (403) are deliberately SEPARATE verdicts: they send the
	// reader to opposite halves of the stack. Conflating them cost nine nights on #1259 — a malformed
	// EKS presigned token (missing X-Amz-Expires, #1040) returns 401, but the single combined message
	// said "check the access entry / RBAC", so the investigation went to the EKS access entry and the
	// OpenTofu template, both of which were correct, instead of to the token minter. 401 = the cluster
	// never accepted who we are; 403 = it did, and said no.
	reachAuthN    reachClass = "AUTHENTICATION REJECTED — 401 (the cluster did not accept the runner's token at all: the minted kube-token is malformed, expired, or issued for another cluster — look at the token minter and the exec-plugin output, not at cluster permissions)"
	reachAuthZ    reachClass = "AUTHORIZATION REJECTED — 403 (the identity authenticated but is not permitted — check the access entry / RBAC ↔ the kube-token identity)"
	reachNetwork  reachClass = "NETWORK UNREACHABLE (the API endpoint is not reachable from the runner — check the public-access CIDR allowlist / security groups / VPC)"
	reachNotReady reachClass = "API NOT READY (the endpoint answered but readyz is not green yet)"
	reachUnknown  reachClass = "UNKNOWN (see the last probe error)"
)

// isAuthRejection reports whether a verdict is an auth rejection of either kind. Both fast-fail:
// neither a rejected token nor a missing permission resolves by waiting.
func isAuthRejection(c reachClass) bool { return c == reachAuthN || c == reachAuthZ }

// authRejectFastFail is the number of CONSECUTIVE auth rejections after which WaitClusterReady stops
// waiting: neither a rejected token nor an access-entry/RBAC misconfig resolves by waiting, so
// burning the full timeout is wasted. Big enough to ride out token/endpoint warm-up jitter (~60s at
// the 10s poll interval).
const authRejectFastFail = 6

// classifyReachability maps a kubectl reachability-probe error + its output to the failing layer.
// Pure + unit-tested. A nil error means the command ran but readyz wasn't 200 (API not ready yet).
func classifyReachability(err error, out string) reachClass {
	if err == nil {
		return reachNotReady
	}
	s := strings.ToLower(err.Error() + " " + out)
	switch {
	// 403 is checked FIRST: "forbidden" is unambiguous, whereas a 403 body can also mention
	// credentials. A message carrying both markers is an authorization failure — the request got far
	// enough to be evaluated against a policy.
	case containsAny(s, "forbidden", "error from server (forbidden)"):
		return reachAuthZ
	case containsAny(s,
		"unauthorized", "the server has asked for the client to provide credentials",
		"you must be logged in", "u_a_authentication", "invalid bearer token",
		"the token could not be validated"):
		return reachAuthN
	case containsAny(s,
		"no route to host", "i/o timeout", "connection refused", "dial tcp", "could not resolve host",
		"no such host", "network is unreachable", "connection timed out", "context deadline exceeded",
		"tls handshake timeout"):
		return reachNetwork
	case containsAny(s, "503", "500", "readyz", "apiserver is not ready", "not ready"):
		return reachNotReady
	default:
		return reachUnknown
	}
}

// podProbeVerdict turns the in-cluster probe pod's last phase + container waiting reason into the
// RIGHT failure message. A pod that never reached Running/Succeeded (Pending: unschedulable /
// ImagePullBackOff / no capacity / a taint) never executed the connect, so the pod-network verdict
// would be a misdiagnosis — say scheduling/image instead. Pure/unit-tested.
func podProbeVerdict(phase, waitingReason string) string {
	phase = strings.TrimSpace(phase)
	if phase == "Running" || phase == "Succeeded" {
		return "the cluster pod network is broken (the pod ran but could not reach the API server across the cluster network — cross-node pod->apiserver)"
	}
	detail := phase
	if wr := strings.TrimSpace(waitingReason); wr != "" {
		if detail != "" {
			detail += "/" + wr
		} else {
			detail = wr
		}
	}
	if detail == "" {
		detail = "no pod observed"
	}
	return "the probe pod never started (" + detail +
		") — this is NOT a pod-network verdict; check scheduling / image pull / node capacity / taints"
}

// probePodSelector is the label selector that finds the probe Job's pod.
//
// It keys on `app.kubernetes.io/name`, which podToAPIServerJob puts on the pod template itself —
// NOT on any label the Job controller adds. Kubernetes has been migrating those: `job-name` is the
// legacy unprefixed key, `batch.kubernetes.io/job-name` the 1.27+ replacement, and the batch API's
// own comment promises only that the unprefixed form is still *recognized*. Selecting on a
// controller-owned label makes this diagnostic silently version-dependent — and when it matches
// nothing, the probe reports "no pod observed" and blames scheduling for a pod that may have been
// running perfectly (#1641). Pure/unit-tested.
func probePodSelector(jobName string) string {
	return "app.kubernetes.io/name=" + jobName
}

// probeEvidence formats the post-mortem dumped when the probe times out.
//
// Empty sections are labelled rather than dropped: "kubectl returned nothing" is itself a finding
// (no Job, no events = the apply never landed), and a silently missing section reads as if the
// command was never run. Pure/unit-tested.
func probeEvidence(describeJob, events string) string {
	section := func(title, body string) string {
		body = strings.TrimSpace(body)
		if body == "" {
			body = "(nothing returned)"
		}
		return "\n── " + title + " ──\n" + body + "\n"
	}
	return "\nProbe timed out — collecting evidence before teardown destroys it:\n" +
		section("kubectl describe job", describeJob) +
		section("kubectl get events -n default", events)
}

// collectOut runs a best-effort diagnostic command, returning its output or the error text. A
// diagnostic that fails must still say something: returning "" here would render as
// "(nothing returned)" and read as an empty cluster rather than a broken kubectl.
func collectOut(cmd string) string {
	out, err := executeCommandWithOutput(cmd, ".", nil)
	if err != nil && strings.TrimSpace(out) == "" {
		return "command failed: " + err.Error()
	}
	return out
}

// containsAny reports whether s contains any of the substrings.
func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// WaitPodToAPIServer proves that an ORDINARY POD can reach the Kubernetes API server across
// the cluster network — the one thing `WaitClusterReady` cannot see. WaitClusterReady probes
// the API from the RUNNER (via the node's public IP) and only counts Ready nodes; a cluster
// can pass that yet have a broken pod datapath, so pod->apiserver-ClusterIP times out for every
// real workload (ArgoCD controllers, admission webhooks, in-cluster clients). This exact bug
// shipped on multi-node Hetzner/Talos and was invisible to the runner-side probe (E1 finding).
//
// It runs a throwaway Job whose pod TCP-connects to the kubernetes Service ClusterIP:443. The
// pod tolerates all taints but PREFERS a non-control-plane node, so on a multi-node cluster it
// lands on a worker and genuinely exercises the cross-node datapath; on a single-node cluster it
// runs on the control plane (still a valid pod->apiserver check). Fatal on failure — SUCCESS must
// mean pods can reach the API. Opt out with ALETHIA_CLUSTER_SKIP_INCLUSTER_PROBE=1.
func WaitPodToAPIServer(ctx context.Context, timeout time.Duration, stdout io.Writer) error {
	if v := strings.ToLower(strings.TrimSpace(os.Getenv("ALETHIA_CLUSTER_SKIP_INCLUSTER_PROBE"))); v == "1" || v == "true" {
		fmt.Fprintln(stdout, "In-cluster pod->apiserver probe skipped (ALETHIA_CLUSTER_SKIP_INCLUSTER_PROBE).")
		return nil
	}

	// The kubernetes Service ClusterIP (server-picked, first host of the service CIDR). We test
	// the raw IP rather than the DNS name so this isolates the pod->apiserver DATAPATH from CoreDNS.
	clusterIP, err := executeCommandWithOutput(
		"kubectl get svc kubernetes -n default -o jsonpath={.spec.clusterIP}", ".", nil)
	if err != nil || strings.TrimSpace(clusterIP) == "" {
		return fmt.Errorf("could not resolve the kubernetes Service ClusterIP for the in-cluster probe: %w", err)
	}
	clusterIP = strings.TrimSpace(clusterIP)

	const jobName = "alethia-apiserver-probe"
	// Best-effort clean any leftover from a previous run, then always clean up on exit.
	_, _ = executeCommandWithOutput("kubectl delete job "+jobName+" -n default --ignore-not-found", ".", nil)
	defer func() {
		_, _ = executeCommandWithOutput("kubectl delete job "+jobName+" -n default --ignore-not-found --wait=false", ".", nil)
	}()

	dir, err := os.MkdirTemp("", "alethia-probe-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	manifestPath := filepath.Join(dir, "probe-job.yaml")
	if err := os.WriteFile(manifestPath, []byte(podToAPIServerJob(jobName, clusterIP, probeImage())), 0o600); err != nil {
		return err
	}
	if _, err := executeCommandWithOutput("kubectl apply -f "+manifestPath, ".", nil); err != nil {
		return fmt.Errorf("failed to create the in-cluster pod->apiserver probe Job: %w", err)
	}
	fmt.Fprintf(stdout, "Verifying a pod can reach the API server (ClusterIP %s:443) across the cluster network...\n", clusterIP)

	deadline := time.Now().Add(timeout)
	var lastState, lastWaiting string
	err = pollUntil(ctx, deadline, 8*time.Second, func() bool {
		succeeded, _ := executeCommandWithOutput(
			"kubectl get job "+jobName+" -n default -o jsonpath={.status.succeeded}", ".", nil)
		if strings.TrimSpace(succeeded) == "1" {
			return true
		}
		lastState, _ = executeCommandWithOutput(
			"kubectl get pods -n default -l "+probePodSelector(jobName)+" -o jsonpath={.items[*].status.phase}", ".", nil)
		// Why a not-Running pod is stuck (ImagePullBackOff, unschedulable, …) — so a scheduling/
		// image failure isn't misreported as a pod-network verdict below.
		lastWaiting, _ = executeCommandWithOutput(
			"kubectl get pods -n default -l "+probePodSelector(jobName)+
				" -o jsonpath={.items[*].status.containerStatuses[*].state.waiting.reason}", ".", nil)
		return false
	})
	if err != nil {
		// A timeout that produces no pod used to produce no evidence either — the run was torn down
		// and the cause went with it. Dump the Job and the namespace events before returning, so the
		// NEXT failure names itself instead of needing a retained cluster to re-observe (#1641).
		fmt.Fprint(stdout, probeEvidence(
			collectOut("kubectl describe job "+jobName+" -n default"),
			collectOut("kubectl get events -n default --sort-by=.lastTimestamp"),
		))
		return fmt.Errorf("in-cluster API-server probe failed within %s (ClusterIP %s:443) — %s. "+
			"This is fatal: a cluster whose pods cannot run + reach the API server runs no real workload: %w",
			timeout, clusterIP, podProbeVerdict(lastState, lastWaiting), err)
	}
	fmt.Fprintln(stdout, "A pod reached the API server across the cluster network — pod datapath is healthy.")
	return nil
}

// podToAPIServerJob renders the throwaway reachability-probe Job. The pod retries an nc TCP
// connect to clusterIP:443 for ~2 min (self-contained against transient warm-up), is
// restricted-PSA compliant (runs as nobody, no caps, seccomp RuntimeDefault), tolerates all
// taints, and prefers a non-control-plane node so multi-node clusters test the cross-node path.
//
// The pod template carries `app.kubernetes.io/name: <job>` because the diagnostic below has to find
// the pod, and it must NOT depend on how Kubernetes labels Job pods. That labelling is a moving
// target: `job-name` is the legacy unprefixed key, superseded by `batch.kubernetes.io/job-name` in
// 1.27, and the API's own comment says only that Kubernetes still "recognizes" the unprefixed form —
// recognizing is not applying. A selector keyed on a label WE set cannot rot with that policy (#1641).
func podToAPIServerJob(name, clusterIP, image string) string {
	cmd := fmt.Sprintf("for i in $(seq 1 40); do nc -w 3 %s 443 </dev/null && echo REACHABLE && exit 0; sleep 3; done; echo UNREACHABLE; exit 1", clusterIP)
	return fmt.Sprintf(`apiVersion: batch/v1
kind: Job
metadata:
  name: %[1]s
  namespace: default
  labels:
    app.kubernetes.io/managed-by: alethia
spec:
  backoffLimit: 3
  ttlSecondsAfterFinished: 120
  template:
    metadata:
      labels:
        app.kubernetes.io/managed-by: alethia
        app.kubernetes.io/name: %[1]s
    spec:
      restartPolicy: Never
      tolerations:
        - operator: Exists
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: node-role.kubernetes.io/control-plane
                    operator: DoesNotExist
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: probe
          image: %[2]s
          command: ["sh", "-c", %[3]q]
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
`, name, image, cmd)
}

// pollUntil calls check every interval until it returns true, the deadline passes, or the
// context is cancelled. It returns nil on success and an error on timeout/cancel.
func pollUntil(ctx context.Context, deadline time.Time, interval time.Duration, check func() bool) error {
	for {
		if check() {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(interval):
		}
	}
}

// CountReadyNodes parses `kubectl get nodes -o json` output and returns the number of
// nodes whose Ready condition is "True" and the total node count. Pure (unit-testable).
func CountReadyNodes(raw []byte) (ready, total int, err error) {
	var list struct {
		Items []struct {
			Status struct {
				Conditions []struct {
					Type   string `json:"type"`
					Status string `json:"status"`
				} `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return 0, 0, fmt.Errorf("parse nodes json: %w", err)
	}
	total = len(list.Items)
	for _, item := range list.Items {
		for _, c := range item.Status.Conditions {
			if c.Type == "Ready" && c.Status == "True" {
				ready++
				break
			}
		}
	}
	return ready, total, nil
}

// NotReadyReasons extracts the distinct Ready-condition "reason: message" of every node whose Ready
// condition is not "True" — the common ones being KubeletNotReady and "container runtime network not
// ready" (a missing/failed CNI). Surfaced on the WaitClusterReady node timeout so a node-datapath
// failure is diagnosable at a glance. Pure/unit-testable; empty when all nodes are Ready or the JSON
// is empty/unparseable.
func NotReadyReasons(raw []byte) []string {
	var list struct {
		Items []struct {
			Status struct {
				Conditions []struct {
					Type    string `json:"type"`
					Status  string `json:"status"`
					Reason  string `json:"reason"`
					Message string `json:"message"`
				} `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, item := range list.Items {
		for _, c := range item.Status.Conditions {
			if c.Type != "Ready" || c.Status == "True" {
				continue
			}
			reason := strings.TrimSpace(c.Reason)
			if msg := strings.TrimSpace(c.Message); msg != "" {
				if reason != "" {
					reason += ": " + msg
				} else {
					reason = msg
				}
			}
			if reason == "" {
				reason = "Ready=" + c.Status
			}
			if !seen[reason] {
				seen[reason] = true
				out = append(out, reason)
			}
			break // one Ready condition per node
		}
	}
	return out
}
