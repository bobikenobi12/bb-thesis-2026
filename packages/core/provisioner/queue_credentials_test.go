// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Every cloud but Hetzner provisions a REAL queue service (SQS, Pub/Sub, Service Bus, MNS) whose
// credentials are the cloud's own. Seeding a Secret there would write something nothing reads.
func TestCredentialInClusterQueuesIsAHetznerOnlyNoOp(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba"} {
		vc := &types.ProjectConfig{
			Provider: types.CloudProvider(provider),
			Queues:   []types.ProjectQueueConfig{{Name: "jobs"}},
		}
		var out, errOut strings.Builder
		credentialInClusterQueues(vc, &out, &errOut)
		if out.Len() != 0 || errOut.Len() != 0 {
			t.Errorf("%s attempted in-cluster queue credentials: out=%q err=%q", provider, out.String(), errOut.String())
		}
	}
}

// A queue that cannot be credentialled must not fail an otherwise-healthy cluster: its Application
// reports the missing Secret, and the next deploy re-runs this — a no-op once the credentials
// exist. The function has no error return by design, so the report is the whole contract.
func TestCredentialInClusterQueuesIsNonFatal(t *testing.T) {
	vc := &types.ProjectConfig{
		Provider: "hetzner",
		Queues:   []types.ProjectQueueConfig{{Name: "jobs"}},
	}
	// No kubectl on PATH → every call fails, including the apply. The function must report and
	// return, never panic or propagate.
	t.Setenv("PATH", t.TempDir())
	var errOut strings.Builder
	credentialInClusterQueues(vc, io.Discard, &errOut)
	if !strings.Contains(errOut.String(), "jobs") {
		t.Errorf("a failure was not reported: %q", errOut.String())
	}
}

// A Hetzner project with no `queue` node touches nothing at all — the loop is empty, not merely
// quiet about a queue it invented.
func TestCredentialInClusterQueuesIsSilentWithNoQueues(t *testing.T) {
	vc := &types.ProjectConfig{Provider: "hetzner"}
	t.Setenv("PATH", t.TempDir())
	var out, errOut strings.Builder
	credentialInClusterQueues(vc, &out, &errOut)
	if out.Len() != 0 || errOut.Len() != 0 {
		t.Errorf("a project with no queue produced output: out=%q err=%q", out.String(), errOut.String())
	}
}

// fakeKubectl puts a scripted `kubectl` on PATH for the duration of a test.
//
// The provisioner package cannot reach argocd's in-process stub (it swaps an unexported package
// var), and the two branches below are only reachable through a kubectl that SUCCEEDS for one call
// and FAILS for another — which PATH-emptying, the trick the older tests here use, cannot express.
// The script branches on argv, so each test says exactly which read fails.
func fakeKubectl(t *testing.T, script string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "kubectl")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatalf("write fake kubectl: %v", err)
	}
	// PREPEND, never replace. `utils.ExecuteCommandWithOutput` shells out through `bash`, so a PATH
	// holding only this script makes every call fail with "bash: executable file not found" — an
	// ORDINARY error, raised before the branch under test is ever reached. Both of these tests
	// failed that way first, and the failure looked exactly like the fix not working.
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	// Prove the fake is the one being found, and not a real kubectl further along PATH. Without
	// this the test still "passes" when the script is unreachable — every call fails, which is the
	// OTHER branch, and the assertion below would be satisfied for entirely the wrong reason.
	if resolved, err := exec.LookPath("kubectl"); err != nil || resolved != path {
		t.Fatalf("the fake kubectl is not on PATH (resolved=%q err=%v)", resolved, err)
	}
}

func oneHetznerQueue() *types.ProjectConfig {
	return &types.ProjectConfig{
		Provider: "hetzner",
		Queues:   []types.ProjectQueueConfig{{Name: "jobs"}},
	}
}

// A COMPLETE Secret already in the cluster: EnsureQueueCredentialSecret takes its "leaving it in
// place" return, the loop continues, and the deploy proceeds. This is the branch a deploy takes on
// every run after the first, so it being uncovered meant the ordinary path was untested.
func TestCredentialInClusterQueuesContinuesWhenAQueueIsAlreadyComplete(t *testing.T) {
	// `password` / `erlang-cookie`, base64, which is what the chart mints and what the runner reads.
	fakeKubectl(t, `echo '{"data":{"password":"cHc=","erlang-cookie":"Y2s="}}'`)

	var out, errOut strings.Builder
	if err := credentialInClusterQueues(oneHetznerQueue(), &out, &errOut); err != nil {
		t.Fatalf("a complete queue must not fail the deploy: %v", err)
	}
	if errOut.Len() != 0 {
		t.Errorf("a complete queue warned about something: %q", errOut.String())
	}
	if !strings.Contains(out.String(), "leaving it in place") {
		t.Errorf("the complete-Secret path was not the one taken: %q", out.String())
	}
}

// THE FAIL-CLOSED BRANCH, and the reason this PR exists.
//
// The runner's own read succeeds and reports the Secret absent; the ADOPTION list then fails. That
// combination used to be indistinguishable from "this queue was never charted", and the caller
// answers that by minting a fresh erlang cookie over a live broker. The deploy must now stop,
// because it runs AHEAD of ApplyAddOnsInWaves — stopping is what keeps an Application whose
// `auth.existingSecret` names a Secret we could not write from reaching the cluster at all.
func TestCredentialInClusterQueuesStopsTheDeployWhenTheLiveStateIsUnknown(t *testing.T) {
	fakeKubectl(t, `
case "$*" in
  *"app.kubernetes.io/instance="*) echo "the server was unable to return a response" >&2; exit 1 ;;
  *) exit 0 ;;
esac`)

	err := credentialInClusterQueues(oneHetznerQueue(), io.Discard, io.Discard)
	if err == nil {
		t.Fatal("an unknown live credential state must stop the deploy, not warn and continue")
	}
	if !argocd.QueueLiveStateUnknown(err) {
		t.Errorf("the deploy must stop on the UNKNOWN specifically, not on any error; got %v", err)
	}
	if !strings.Contains(err.Error(), "jobs") {
		t.Errorf("the error must name the queue that could not be resolved: %v", err)
	}
}

// The other half of the same decision, and the one that keeps the fix from becoming its own bug: an
// ORDINARY seeding failure stays non-fatal. If both stopped the deploy, one queue still converging
// would fail an otherwise-healthy cluster — the outcome the non-fatal convention exists to avoid.
func TestCredentialInClusterQueuesStillWarnsOnAnOrdinaryFailure(t *testing.T) {
	fakeKubectl(t, `echo "connection refused" >&2; exit 1`)

	var errOut strings.Builder
	err := credentialInClusterQueues(oneHetznerQueue(), io.Discard, &errOut)
	if err != nil {
		t.Fatalf("an ordinary failure must not stop the deploy: %v", err)
	}
	if !strings.Contains(errOut.String(), "jobs") {
		t.Errorf("the failure was not reported: %q", errOut.String())
	}
}
