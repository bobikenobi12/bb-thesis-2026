// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The SECOND assertion for max-config cells whose PRIMARY evidence does not actually prove the kind
// was delivered — a converged ArgoCD Application for an in-cluster cell, or the counted resource in
// tofu state for a cloud one. Both carriages can carry a probe; see MaxConfigCell.ClusterProbe.
//
// For four of hetzner's five in-cluster kinds it does: `addon-db-appdb` Healthy+Synced means a CNPG
// Cluster is running, and a running Postgres is the kind. `secrets` is the exception, and it is the
// exception in the most dangerous direction — a SEALED Vault's Helm release is Healthy AND Synced,
// because the StatefulSet is running exactly as the chart declared. Every observable ArgoCD reports
// is green while the Vault answers nothing at all. Promoting the cell on that evidence would be the
// "never promote a cell by asserting it" failure the table exists to prevent.
//
// So a cell may name a MaxConfigClusterProbe: one live object whose `Ready` condition is True only
// when the capability is genuinely delivered. It is read through the same `Ready`-condition parser
// the cross-account secrets lane uses (parseReadyCondition in t2_secrets_xacct.go) — ESO states
// readiness the same way wherever it appears, and a second parser would be a second thing to keep
// correct.
//
// Fail-closed throughout: an unreadable object, an absent condition and a False condition are all
// failures. "No status yet" is retried, never treated as a pass.

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// maxConfigProbeInterval is how often a not-yet-Ready probe is retried.
const maxConfigProbeInterval = 10 * time.Second

// maxConfigProbeGetTimeout bounds one kubectl call, well under the overall deadline.
const maxConfigProbeGetTimeout = 30 * time.Second

// maxConfigProbeTimeout is the budget for ONE probe, and it is deliberately far smaller than
// ArgoAssertTimeout.
//
// This runs AFTER AssertArgoAppsHealthy and after the tofu state assertion, so the operator is
// already converged and the cloud resource already exists; what is left is ESO reconciling one
// store, which is seconds when it works. Ten minutes is generous for that and still bounded.
//
// It used to be handed ArgoAssertTimeout() — up to 40m on a full bar — against a ctx that reserved
// NOTHING for it. Two things went wrong with that. A store that is genuinely absent (the case this
// exists to catch) would poll until the ctx expired, and awaitClusterProbeReady would then return
// ctx.Err() — reporting `context deadline exceeded` and throwing away the last observed Ready
// condition, which is the entire diagnostic value of the probe. And a merely slow store would eat
// unreserved minutes that a LATER reserved scenario then died of, attributing the failure to the
// wrong thing entirely.
const maxConfigProbeTimeout = 10 * time.Minute

// MaxConfigProbeTimeout is the per-probe budget, exported so the ladder and the caller cannot
// disagree about it.
func MaxConfigProbeTimeout() time.Duration { return maxConfigProbeTimeout }

// MaxConfigProbeBudget is what ResolveT2Budget must reserve for this cloud: one probe budget per
// cell that actually declares a probe.
//
// Derived from the same selection the assertion walks, rather than from a constant somebody has to
// remember to bump — adding a probed cell to the grid must move the ladder by construction. That is
// the mirror-the-emitter rule the budget file already applies to the day-2 URL probe.
func MaxConfigProbeBudget(provider string) time.Duration {
	return time.Duration(len(MaxConfigProbedCells(provider))) * maxConfigProbeTimeout
}

// AssertMaxConfigClusterProbes runs every ClusterProbe this cloud's cells declare — of EITHER
// provisioning carriage — and reports the first one that never became Ready.
//
// Called AFTER AssertMaxConfigKindsInState, never instead of it: the probe is additive evidence, and
// a cell whose primary evidence never held has already failed. A no-op for a cloud whose cells
// declare no probes.
//
// It does NOT filter on carriage. It used to skip everything but CarriedInCluster, which meant the
// four managed clouds paid nothing for it — and that was the bug, not the saving: `secrets` on those
// clouds is a TOFU cell whose counted resource is real while the ClusterSecretStore that is the only
// way to read it may never have been created (#2652). A probe that cannot be declared where the
// hazard lives is a guard for the case that was already safe.
func AssertMaxConfigClusterProbes(ctx context.Context, kubeconfigPath, provider string, timeout time.Duration) error {
	for _, pc := range MaxConfigProbedCells(provider) {
		if err := awaitClusterProbeReady(ctx, kubeconfigPath, *pc.Cell.ClusterProbe, timeout); err != nil {
			return fmt.Errorf("max-config kind %q on %s: %w\n  %s, but that is not the proof: %s",
				pc.Kind, provider, err, cellPrimaryEvidence(pc.Cell), pc.Cell.ClusterProbe.Why)
		}
	}
	return nil
}

// ProbedCell pairs a kind with the cell that declares a probe for this cloud.
type ProbedCell struct {
	Kind string
	Cell MaxConfigCell
}

// MaxConfigProbedCells is the SELECTION half of AssertMaxConfigClusterProbes, split out so it can be
// asserted without a cluster.
//
// It is split out because the selection is where this went wrong: the loop used to require
// CarriedInCluster, which silently excluded every tofu cell — so declaring a probe on `secrets` for
// aws would have compiled, read correctly, and run nothing. A filter that drops the cells you care
// about is indistinguishable from a passing probe, and nothing here would have said so.
func MaxConfigProbedCells(provider string) []ProbedCell {
	var out []ProbedCell
	for _, k := range MaxConfigKinds {
		cell, ok := k.Cell(provider)
		if !ok || cell.ClusterProbe == nil {
			continue
		}
		out = append(out, ProbedCell{Kind: k.Kind, Cell: cell})
	}
	return out
}

// cellPrimaryEvidence names what the cell had ALREADY established before the probe ran, so the
// failure reads as "this much was true and it still was not enough" rather than as a bare timeout.
func cellPrimaryEvidence(cell MaxConfigCell) string {
	if cell.Carriage == CarriedByTofu {
		return fmt.Sprintf("the tofu resource %s is in state", cell.Resource)
	}
	return fmt.Sprintf("the ArgoCD Application %s converged", cell.ArgoApp)
}

// awaitClusterProbeReady polls one object until its `Ready` condition is True, or the deadline
// passes. The last observed condition is carried into the timeout error — a store that is Ready=False
// with reason `ValidationFailed` and a message naming a sealed Vault is the whole diagnosis, and a
// bare "timed out" would throw it away.
func awaitClusterProbeReady(ctx context.Context, kubeconfigPath string, p MaxConfigClusterProbe, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	var lastCond esCondition
	var sawCond bool

	for {
		raw, err := kubectlGetObject(ctx, kubeconfigPath, p)
		if err != nil {
			lastErr = err
		} else {
			cond, ok, perr := parseReadyCondition(raw)
			switch {
			case perr != nil:
				lastErr = perr
			case isReady(cond, ok):
				return nil
			default:
				lastCond, sawCond, lastErr = cond, ok, nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s%s did not report Ready=True within %s: %s",
				p.Resource+"/"+p.Name, namespaceSuffix(p.Namespace), timeout, probeDiagnosis(lastCond, sawCond, lastErr))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(maxConfigProbeInterval):
		}
	}
}

// probeDiagnosis renders whatever the last poll actually saw, in the order of usefulness to whoever
// reads the nightly's log: the controller's own reason first, then a read failure, then the honest
// "it never wrote a status at all".
func probeDiagnosis(cond esCondition, sawCond bool, err error) string {
	if sawCond {
		return fmt.Sprintf("last Ready condition was %q (reason %q): %s", cond.Status, cond.Reason, cond.Message)
	}
	if err != nil {
		return fmt.Sprintf("last read failed: %v", err)
	}
	return "the object never reported a Ready condition — its controller has not reconciled it"
}

// namespaceSuffix renders " in namespace x" for a namespaced object and nothing for a cluster-scoped one.
func namespaceSuffix(ns string) string {
	if ns == "" {
		return ""
	}
	return " in namespace " + ns
}

// kubectlGetObject reads one object as JSON through an explicit kubeconfig — this tier's own path to
// the cluster, never the runner's side-effect environment.
func kubectlGetObject(ctx context.Context, kubeconfigPath string, p MaxConfigClusterProbe) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, maxConfigProbeGetTimeout)
	defer cancel()
	args := []string{"--kubeconfig", kubeconfigPath, "get", p.Resource, p.Name, "-o", "json"}
	if p.Namespace != "" {
		args = append(args, "-n", p.Namespace)
	}
	out, err := exec.CommandContext(cctx, "kubectl", args...).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return nil, fmt.Errorf("%w: %s", err, strings.TrimSpace(string(ee.Stderr)))
		}
		return nil, err
	}
	return out, nil
}
