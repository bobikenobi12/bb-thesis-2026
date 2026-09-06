// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// Every cloud but Hetzner provisions a REAL queue service (SQS, Pub/Sub, Service Bus, MNS). There
// is no broker of ours to exec into and no Secret of ours to converge it to, so this must not so
// much as look — the same boundary credentialInClusterQueues holds, asserted separately because a
// second function is a second place to forget it.
func TestConvergeInClusterQueuePasswordsIsAHetznerOnlyNoOp(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba"} {
		vc := &types.ProjectConfig{
			Provider: types.CloudProvider(provider),
			Queues:   []types.ProjectQueueConfig{{Name: "jobs"}},
		}
		var out, errOut strings.Builder
		convergeInClusterQueuePasswords(context.Background(), vc, &out, &errOut)
		if out.Len() != 0 || errOut.Len() != 0 {
			t.Errorf("%s attempted to reconcile a broker password: out=%q err=%q", provider, out.String(), errOut.String())
		}
	}
}

// NON-FATAL, and the reason is narrower than the sibling's. A broker that is not reachable is the
// ORDINARY state — a queue whose pod is still starting, or a cluster where the exec is refused —
// and the password it already has keeps working meanwhile. Failing the deploy over it would turn a
// repair for pre-#3304 queues into a new way for a healthy cluster to go red.
func TestConvergeInClusterQueuePasswordsIsNonFatal(t *testing.T) {
	vc := &types.ProjectConfig{
		Provider: "hetzner",
		Queues:   []types.ProjectQueueConfig{{Name: "jobs"}},
	}
	// No kubectl on PATH → the pod listing fails, which ConvergeQueuePassword reports as an ERROR
	// rather than as "no broker" (a failed read and an absent broker mean different things). The
	// deploy must carry on regardless.
	t.Setenv("PATH", t.TempDir())
	var errOut strings.Builder
	convergeInClusterQueuePasswords(context.Background(), vc, io.Discard, &errOut)
	if !strings.Contains(errOut.String(), "jobs") {
		t.Errorf("a failure was not reported against the queue it belongs to: %q", errOut.String())
	}
	if !strings.Contains(errOut.String(), "not reconciled") {
		t.Errorf("the report does not say what did not happen: %q", errOut.String())
	}
}

// A Hetzner project with no `queue` node touches nothing — the loop is empty, not merely quiet
// about a queue it invented.
func TestConvergeInClusterQueuePasswordsIsSilentWithNoQueues(t *testing.T) {
	vc := &types.ProjectConfig{Provider: "hetzner"}
	t.Setenv("PATH", t.TempDir())
	var out, errOut strings.Builder
	convergeInClusterQueuePasswords(context.Background(), vc, &out, &errOut)
	if out.Len() != 0 || errOut.Len() != 0 {
		t.Errorf("a project with no queue produced output: out=%q err=%q", out.String(), errOut.String())
	}
}

// A CANCELLED DEPLOY MUST NOT SHELL OUT PER QUEUE. `WaitAddOnsHealthy` returns immediately on
// `ctx.Done()`, so a timed-out deploy falls straight through to this step — the reason both siblings
// (`credentialInClusterRegistries`, `bootstrapInClusterVault`) take a context too.
func TestConvergeInClusterQueuePasswordsHonoursACancelledContext(t *testing.T) {
	vc := &types.ProjectConfig{
		Provider: "hetzner",
		Queues:   []types.ProjectQueueConfig{{Name: "jobs"}},
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var errOut strings.Builder
	convergeInClusterQueuePasswords(ctx, vc, io.Discard, &errOut)
	// Still non-fatal and still REPORTED — a cancelled deploy that silently skips the repair is the
	// same "nothing happened and nothing said so" this whole file is written against.
	if !strings.Contains(errOut.String(), "jobs") {
		t.Errorf("a cancelled deploy skipped the queue without saying so: %q", errOut.String())
	}
}
