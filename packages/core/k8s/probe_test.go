// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package k8s

import (
	"context"
	"errors"
	"io"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestCountReadyNodes(t *testing.T) {
	cases := []struct {
		name               string
		raw                string
		wantReady, wantTot int
		wantErr            bool
	}{
		{
			name:      "two ready",
			raw:       `{"items":[{"status":{"conditions":[{"type":"MemoryPressure","status":"False"},{"type":"Ready","status":"True"}]}},{"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}`,
			wantReady: 2, wantTot: 2,
		},
		{
			name:      "one ready one notready",
			raw:       `{"items":[{"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"status":{"conditions":[{"type":"Ready","status":"False"}]}}]}`,
			wantReady: 1, wantTot: 2,
		},
		{
			name:      "zero nodes (karpenter-only)",
			raw:       `{"items":[]}`,
			wantReady: 0, wantTot: 0,
		},
		{
			name:      "node with no Ready condition",
			raw:       `{"items":[{"status":{"conditions":[{"type":"DiskPressure","status":"False"}]}}]}`,
			wantReady: 0, wantTot: 1,
		},
		{
			name:    "garbage",
			raw:     `not json`,
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ready, total, err := CountReadyNodes([]byte(tc.raw))
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tc.wantErr)
			}
			if tc.wantErr {
				return
			}
			if ready != tc.wantReady || total != tc.wantTot {
				t.Errorf("got ready=%d total=%d, want ready=%d total=%d", ready, total, tc.wantReady, tc.wantTot)
			}
		})
	}
}

func TestPodToAPIServerJob(t *testing.T) {
	y := podToAPIServerJob("alethia-apiserver-probe", "10.0.96.1", "busybox:1.36")
	for _, want := range []string{
		"name: alethia-apiserver-probe",
		"image: busybox:1.36",
		"nc -w 3 10.0.96.1 443",                 // TCP-connect to the ClusterIP datapath
		"node-role.kubernetes.io/control-plane", // prefer a non-control-plane node
		"operator: DoesNotExist",
		"runAsNonRoot: true", // restricted-PSA compliant
		"readOnlyRootFilesystem: true",
		"restartPolicy: Never",
		// The POD carries the selector label the diagnostic uses. Without it the probe can only be
		// found through a Job-controller label, which is exactly the version-dependent lookup #1641
		// is removing. Asserted on the manifest because that is where the coupling lives.
		"app.kubernetes.io/name: alethia-apiserver-probe",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("probe Job manifest missing %q\n---\n%s", want, y)
		}
	}
	// The template uses explicit %[n] argument indices. A mis-numbered verb still compiles and still
	// renders a valid-looking manifest — it just puts the image where the name goes. Catch that by
	// proving no argument leaked into the wrong slot.
	if strings.Contains(y, "%!") {
		t.Errorf("probe Job manifest has a formatting error (bad argument index)\n---\n%s", y)
	}
	if got := strings.Count(y, "alethia-apiserver-probe"); got != 2 {
		t.Errorf("job name should render exactly 2x (Job metadata.name + the pod's app.kubernetes.io/name); got %d\n---\n%s", got, y)
	}
}

func TestProbePodSelectorDoesNotUseJobControllerLabels(t *testing.T) {
	sel := probePodSelector("alethia-apiserver-probe")
	if sel != "app.kubernetes.io/name=alethia-apiserver-probe" {
		t.Errorf("unexpected selector %q", sel)
	}
	// The regression this locks: `job-name=` is the legacy unprefixed Job label, superseded by
	// `batch.kubernetes.io/job-name` in 1.27. Selecting on either makes the diagnostic depend on
	// Kubernetes' Job-labelling policy — and when it matches nothing, the probe reports
	// "no pod observed" and blames scheduling for a pod that may have run perfectly.
	for _, bad := range []string{"job-name=", "batch.kubernetes.io/"} {
		if strings.Contains(sel, bad) {
			t.Errorf("selector %q keys on a Job-controller label (%q) — it must key on the label the pod template sets", sel, bad)
		}
	}
}

func TestProbeEvidence(t *testing.T) {
	out := probeEvidence("Name: alethia-apiserver-probe\nPods Statuses: 0 Running", "")
	for _, want := range []string{
		"kubectl describe job",
		"Pods Statuses: 0 Running",
		"kubectl get events -n default",
		// An empty section must SAY it is empty. Dropping it reads as "the command was never run",
		// when "no events at all" is itself the finding.
		"(nothing returned)",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("probe evidence missing %q\n---\n%s", want, out)
		}
	}
}

func TestWaitPodToAPIServerSkip(t *testing.T) {
	t.Setenv("ALETHIA_CLUSTER_SKIP_INCLUSTER_PROBE", "1")
	if err := WaitPodToAPIServer(context.Background(), time.Second, io.Discard); err != nil {
		t.Fatalf("skip env should short-circuit to nil, got %v", err)
	}
}

func TestClassifyReachability(t *testing.T) {
	cases := []struct {
		name string
		err  error
		out  string
		want reachClass
	}{
		{"nil err = api not ready", nil, "", reachNotReady},

		// 401 and 403 must NOT collapse into one verdict — see the reachAuthN comment. The first case
		// is verbatim what the malformed EKS presigned token produced every night in #1259.
		{"401 unauthorized = authN", errString("error: You must be logged in to the server (Unauthorized)"), "", reachAuthN},
		{"401 credentials prompt = authN", errString("the server has asked for the client to provide credentials"), "", reachAuthN},
		{"401 invalid bearer token = authN", errString("Unauthorized: invalid bearer token"), "", reachAuthN},
		{"403 forbidden = authZ", errString("Error from server (Forbidden): clusterroles.rbac.authorization.k8s.io is forbidden"), "", reachAuthZ},
		{"403 user cannot = authZ", errString(`error from server (forbidden): nodes is forbidden: User "x" cannot list resource "nodes"`), "", reachAuthZ},
		// Both markers present ⇒ authorization: the request got far enough to be policy-evaluated.
		{"forbidden wins over credentials wording", errString("Error from server (Forbidden): credentials rejected"), "", reachAuthZ},
		{"dial timeout = network", errString("Unable to connect to the server: dial tcp 1.2.3.4:443: i/o timeout"), "", reachNetwork},
		{"no route = network", errString("dial tcp: lookup x: no such host"), "", reachNetwork},
		{"tls handshake = network", errString("net/http: TLS handshake timeout"), "", reachNetwork},
		{"503 = not ready", errString("an error on the server (\"[+]ping ok\\n[-]etcd failed\") has prevented the request from succeeding"), "503 readyz", reachNotReady},
		{"other = unknown", errString("some unexpected kubectl failure"), "", reachUnknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := classifyReachability(c.err, c.out); got != c.want {
				t.Fatalf("classifyReachability(%q,%q) = %q, want %q", c.err, c.out, got, c.want)
			}
		})
	}
}

type errString string

func (e errString) Error() string { return string(e) }

func TestNotReadyReasons(t *testing.T) {
	raw := []byte(`{"items":[
		{"status":{"conditions":[{"type":"Ready","status":"False","reason":"KubeletNotReady","message":"container runtime network not ready: NetworkReady=false"}]}},
		{"status":{"conditions":[{"type":"Ready","status":"False","reason":"KubeletNotReady","message":"container runtime network not ready: NetworkReady=false"}]}},
		{"status":{"conditions":[{"type":"Ready","status":"True","reason":"KubeletReady"}]}}
	]}`)
	got := NotReadyReasons(raw)
	// Distinct — the two identical NotReady nodes collapse to one; the Ready node is excluded.
	if len(got) != 1 || !strings.Contains(got[0], "KubeletNotReady") || !strings.Contains(got[0], "NetworkReady=false") {
		t.Fatalf("NotReadyReasons = %#v", got)
	}
	if r := NotReadyReasons([]byte(`{"items":[{"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}`)); len(r) != 0 {
		t.Fatalf("all-ready should be empty, got %#v", r)
	}
	if r := NotReadyReasons([]byte("not json")); r != nil {
		t.Fatalf("bad json should be nil, got %#v", r)
	}
}

func TestPodProbeVerdict(t *testing.T) {
	// Ran but couldn't connect → the (correct) network verdict.
	if v := podProbeVerdict("Running", ""); !strings.Contains(v, "pod network is broken") {
		t.Fatalf("Running should give the network verdict: %q", v)
	}
	if v := podProbeVerdict("Succeeded", ""); !strings.Contains(v, "pod network is broken") {
		t.Fatalf("Succeeded should give the network verdict: %q", v)
	}
	// Never started → NOT a network verdict; names the blocker.
	v := podProbeVerdict("Pending", "ImagePullBackOff")
	if strings.Contains(v, "pod network is broken") || !strings.Contains(v, "never started") || !strings.Contains(v, "ImagePullBackOff") {
		t.Fatalf("Pending/ImagePullBackOff misclassified: %q", v)
	}
	// Unscheduled (no waiting reason yet) still avoids the network verdict.
	if v := podProbeVerdict("Pending", ""); strings.Contains(v, "pod network is broken") || !strings.Contains(v, "never started") {
		t.Fatalf("Pending misclassified: %q", v)
	}
	// No pod observed at all.
	if v := podProbeVerdict("", ""); !strings.Contains(v, "no pod observed") {
		t.Fatalf("empty should say no pod observed: %q", v)
	}
}

// TestAuthVerdictsRouteToDifferentPlaces is the regression that matters for #1259. Classification
// alone is not the point — the WORDING is what a human acts on at 3am. A 401 that mentions RBAC
// sends the reader to the access entry and the OpenTofu template, both of which were correct for
// nine consecutive nights while the real bug sat in the token minter.
func TestAuthVerdictsRouteToDifferentPlaces(t *testing.T) {
	authN := strings.ToLower(string(reachAuthN))
	authZ := strings.ToLower(string(reachAuthZ))

	for _, term := range []string{"access entry", "rbac"} {
		if strings.Contains(authN, term) {
			t.Errorf("the 401 verdict mentions %q — that is the 403 story; it misroutes a token bug", term)
		}
		if !strings.Contains(authZ, term) {
			t.Errorf("the 403 verdict should mention %q so a permissions problem is actionable", term)
		}
	}
	if !strings.Contains(authN, "token") {
		t.Error("the 401 verdict should point at the token — that is what was rejected")
	}
	if authN == authZ {
		t.Fatal("401 and 403 must not share a message")
	}
}

// TestIsAuthRejection pins that BOTH auth verdicts fast-fail: neither a rejected token nor a missing
// permission resolves by waiting, so both must stop the poll early rather than burn the full budget.
func TestIsAuthRejection(t *testing.T) {
	for _, c := range []reachClass{reachAuthN, reachAuthZ} {
		if !isAuthRejection(c) {
			t.Errorf("isAuthRejection(%q) = false, want true — it would burn the full timeout", c)
		}
	}
	for _, c := range []reachClass{reachNetwork, reachNotReady, reachUnknown} {
		if isAuthRejection(c) {
			t.Errorf("isAuthRejection(%q) = true — a transient class must keep retrying", c)
		}
	}
}

// TestWaitClusterReadyRendersDurationsTheWayTheProductDoes pins the shared duration spelling on the
// two probe messages that carry a span, and on the banner that announces the same budget.
//
// The sentence at stake reads `… after <elapsed> (timeout <budget>) …`. Both halves are
// time.Duration, both are read against each other, and before this they went through
// Duration.String() — `1m30s`, which is Go's wire spelling and not the `1m 30s` the console, the
// CLI and packages/core/format all agree on. Migrating one half and not the other would put two
// spellings of the same unit in one sentence, so the budget is what this test pins: it is the only
// one of the two a caller controls, and it is exactly the half that a partial migration leaves
// behind.
//
// KNOWN LIMIT, stated rather than papered over: this cannot pin the ELAPSED half. format.Duration
// and Duration.String() agree below a minute (`47s` == `47s`) and diverge only from 60s up, and
// there is no clock seam in WaitClusterReady to push elapsed past that without a 60-second test.
// So a mutation that restores Duration.String() on elapsed ALONE stays green here. What is
// asserted instead is the elapsed token's GRAMMAR — no `h`/`m` run without a space, which is the
// shape Duration.String() produces the moment a real wait is long enough to matter.
func TestWaitClusterReadyRendersDurationsTheWayTheProductDoes(t *testing.T) {
	resetK8sSeams(t)
	executeCommandWithOutput = func(string, string, []string) (string, error) {
		return "", errors.New("dial tcp 10.0.0.1:443: connect: connection refused")
	}

	// A budget whose two spellings differ, so the assertion has something to fail on: 90s is
	// `1m 30s` through format.Duration and `1m30s` through Duration.String().
	const budget = 90 * time.Second

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the cancelled branch returns on the first poll — no wall-clock wait for the budget.

	var banner strings.Builder
	err := WaitClusterReady(ctx, budget, false, &banner)
	if err == nil {
		t.Fatal("WaitClusterReady returned nil for a cancelled wait")
	}

	if got := banner.String(); !strings.Contains(got, "(timeout 1m 30s)") {
		t.Errorf("the opening banner announces the budget as %q; want the shared `1m 30s` spelling.\n"+
			"A banner and a failure message that spell one configured value two ways make the reader "+
			"guess which is the setting", got)
	}
	if strings.Contains(banner.String(), "1m30s") {
		t.Errorf("Duration.String() is back in the banner: %q", banner.String())
	}

	msg := err.Error()
	if !strings.Contains(msg, "(timeout 1m 30s)") {
		t.Errorf("cancelled-wait message = %q, want the budget rendered `1m 30s`", msg)
	}
	if strings.Contains(msg, "1m30s") {
		t.Errorf("Duration.String() is back in the cancelled-wait message: %q", msg)
	}

	// The elapsed half, by grammar. `after 0s` / `after 3m 20s` pass; `after 3m20s` does not.
	elapsed := regexp.MustCompile(`cancelled after (\S+(?: \S+)?) \(timeout `).FindStringSubmatch(msg)
	if elapsed == nil {
		t.Fatalf("could not find the elapsed span in %q — the message shape changed", msg)
	}
	if !regexp.MustCompile(`^(\d+s|\d+m \d+s|\d+h \d+m)$`).MatchString(elapsed[1]) {
		t.Errorf("elapsed rendered as %q; want packages/core/format's grammar (`47s`, `3m 20s`, `2h 5m`), "+
			"not Go's wire spelling", elapsed[1])
	}
}

// TestWaitClusterReadyTimeoutBudgetSurvivesTheBudgetPath is the sibling of the cancelled path: the
// exhausted-budget message at the end of WaitClusterReady quotes the budget too, and #1259's rule
// (report ELAPSED, never the budget as if it were elapsed) means the two numbers must BOTH be
// there and must NOT be interchangeable. This asserts they are both present and both in the shared
// spelling — it does not weaken #1259's separation, it renders it.
func TestWaitClusterReadyTimeoutBudgetSurvivesTheBudgetPath(t *testing.T) {
	resetK8sSeams(t)
	executeCommandWithOutput = func(string, string, []string) (string, error) {
		return "", errors.New("dial tcp 10.0.0.1:443: i/o timeout")
	}

	// A negative budget puts the deadline in the past, so the loop exits on its first
	// `time.Now().After(deadline)` check instead of sleeping. format.Duration clamps a
	// non-positive span to `0s`; Duration.String() would render `-1m30s`, a budget nobody set.
	err := WaitClusterReady(context.Background(), -90*time.Second, false, io.Discard)
	if err == nil {
		t.Fatal("WaitClusterReady returned nil for an exhausted budget")
	}
	msg := err.Error()
	if !strings.Contains(msg, "(timeout 0s)") {
		t.Errorf("exhausted-budget message = %q, want the budget clamped to `0s`", msg)
	}
	if strings.Contains(msg, "-1m30s") {
		t.Errorf("a negative budget leaked Go's wire spelling into the message: %q", msg)
	}
	// #1259's separation is still intact: elapsed and budget are two distinct fields.
	if !strings.Contains(msg, "after ") || !strings.Contains(msg, "(timeout ") {
		t.Errorf("elapsed and budget are no longer reported separately: %q", msg)
	}
}
