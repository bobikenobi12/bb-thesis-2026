// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// Admission-webhook ordering — the second half of the wave gate.
//
// ApplyAddOnsInWaves already closes the operator→CR race: apply wave N, wait for the CRDs wave N
// declares, then apply wave N+1. That covers a resource whose SCHEMA does not exist yet. It does
// not cover a resource whose ADMISSION CONTROLLER is not serving yet, and those are two different
// races with the same shape.
//
// Measured, hetzner/addons on 2026-08-24 (#2490's run): `addon-harbor` went SyncError with
//
//	Internal error occurred: failed calling webhook "validate.nginx.ingress.kubernetes.io":
//	x509: certificate signed by unknown authority
//
// while `addon-ingress-nginx` was still Progressing. ingress-nginx is sync-wave 1 and harbor is
// sync-wave 2, so the ordering was already declared correctly and the runner honoured it — but
// ingress-nginx establishes no CRD, so wave 1's gate had nothing to wait for and returned
// instantly. Harbor's Ingress then hit a ValidatingWebhookConfiguration whose caBundle and serving
// pod were not ready. Twelve of twenty Applications missed the convergence budget behind it.
//
// A sync-wave annotation cannot fix this: waves order resources WITHIN one Application, and these
// are two top-level Applications (see the file comment in waves.go).
//
// WHY THIS IS DISCOVERED, NOT DECLARED. The obvious alternative was a `webhooks: []` field on the
// catalog entry, mirroring `crds`. It was rejected: it is a second list to keep in step with what
// each chart actually installs, across a TypeScript catalog, a generated Go fixture and an export
// test — and a chart that starts installing a webhook would race exactly as before until somebody
// remembered to add it. The cluster already knows which webhooks exist. Asking it cannot drift.
//
// FAIL-SOFT, matching every other wave gate: a webhook that never becomes servable is a WARNING
// and the next wave still applies. A bad add-on must not fail an otherwise-healthy cluster, and an
// add-on that then fails admission surfaces as unhealthy in the console — the honest outcome.

const (
	// admissionWebhookWaitBudget bounds this gate across the WHOLE wave loop, not one wave.
	//
	// Per-wave was the obvious shape and it is wrong: with four waves a cluster whose webhook is
	// genuinely broken would pay the bound three times over, and this wait happens inside the
	// deploy job, whose own ceiling is 25 minutes on hetzner. A gate meant to save a run must not
	// be able to spend nine minutes of it. One budget, shared, consumed as it goes — and since the
	// expected case returns in seconds, a healthy cluster never notices either shape.
	admissionWebhookWaitBudget = 3 * time.Minute
	// admissionWebhookPollIntervalDefault is how often readiness is re-read.
	admissionWebhookPollIntervalDefault = 5 * time.Second
)

// admissionWebhookPollInterval is a variable, not a constant, so a test can drive the poll loop
// without sleeping through real seconds. Production never assigns it.
var admissionWebhookPollInterval = admissionWebhookPollIntervalDefault

// webhookWaitBudget hands out the remaining share of admissionWebhookWaitBudget. Created once per
// ApplyAddOnsInWaves call so the bound is per-DEPLOY, never per-wave.
type webhookWaitBudget struct{ remaining time.Duration }

// newWebhookWaitBudget starts a fresh whole-loop budget.
func newWebhookWaitBudget() *webhookWaitBudget {
	return &webhookWaitBudget{remaining: admissionWebhookWaitBudget}
}

// spend records elapsed time and reports what is left, never below zero.
func (b *webhookWaitBudget) spend(d time.Duration) time.Duration {
	b.remaining -= d
	if b.remaining < 0 {
		b.remaining = 0
	}
	return b.remaining
}

// webhookConfigList is the subset of a `kubectl get {validating,mutating}webhookconfigurations`
// list this gate reads.
type webhookConfigList struct {
	Items []struct {
		Metadata struct {
			Name string `json:"name"`
		} `json:"metadata"`
		Webhooks []struct {
			Name string `json:"name"`
			// FailurePolicy decides whether this webhook can block admission at all. ABSENT means
			// `Fail` in admissionregistration.k8s.io/v1, so an empty string must never be read as
			// "ignore" — the zero value and the permissive value are opposites here.
			FailurePolicy string `json:"failurePolicy"`
			ClientConfig  struct {
				CABundle string `json:"caBundle"`
				// Service is set when the webhook is served by an in-cluster Service. A
				// webhook with a URL instead is served from OUTSIDE the cluster; nothing
				// we install can make it ready and waiting on it would hang the wave.
				Service *struct {
					Namespace string `json:"namespace"`
					Name      string `json:"name"`
				} `json:"service"`
			} `json:"clientConfig"`
		} `json:"webhooks"`
	} `json:"items"`
}

// webhookBacking identifies one in-cluster Service that backs an admission webhook.
type webhookBacking struct {
	Namespace string
	Name      string
}

// unservableWebhooks is the PURE decision: given what the cluster reported, which webhooks are not
// yet servable, and which Services back the ones that are otherwise fine?
//
// A webhook is NOT servable when it is served by an in-cluster Service and its caBundle is empty.
// That is the state ingress-nginx passes through: the ValidatingWebhookConfiguration is created by
// the chart with no caBundle, and a patch Job fills it in once the serving certificate exists. An
// apiserver call in that window is exactly the x509 failure harbor hit.
//
// URL-backed webhooks are ignored on purpose. They are served from outside the cluster, so nothing
// this deploy does can change their readiness — blocking a wave on one would hang every install in
// a cluster that has an external policy webhook, which is a common enterprise shape.
//
// Returns the unservable webhook names AND the backings to check for endpoints, because a non-empty
// caBundle is necessary and not sufficient: the certificate can be published before the pod that
// presents it is accepting connections.
func unservableWebhooks(list webhookConfigList) (unservable []string, backings []webhookBacking) {
	seen := map[webhookBacking]bool{}
	for _, item := range list.Items {
		for _, w := range item.Webhooks {
			if w.ClientConfig.Service == nil {
				continue
			}
			// An `Ignore` webhook cannot block admission — the API server proceeds when it cannot
			// reach it — so it can never cause the SyncError this gate exists to prevent, and waiting
			// on one is pure cost. That cost is not local: admissionWebhookWaitBudget is 3 minutes for
			// the WHOLE deploy, spent down across waves, so time burned on an Ignore webhook that
			// never becomes servable is time denied to a Fail webhook in a later wave — which then
			// reports "the budget was already spent by an earlier wave" and reads as if the earlier
			// wave legitimately needed it.
			//
			// Reachable on the shape the comment above already anticipates: a cluster carrying an
			// external policy webhook, which is frequently `Ignore` precisely so it cannot wedge
			// admission.
			//
			// Compared case-insensitively against the one permissive value, NOT by testing for
			// "Fail": an absent policy IS Fail, and so is any value we do not recognise, so both fall
			// through to being waited on. Failing toward waiting is the safe direction.
			if strings.EqualFold(strings.TrimSpace(w.FailurePolicy), "Ignore") {
				continue
			}
			if strings.TrimSpace(w.ClientConfig.CABundle) == "" {
				unservable = append(unservable, fmt.Sprintf("%s/%s (caBundle is empty)", item.Metadata.Name, w.Name))
				continue
			}
			b := webhookBacking{Namespace: w.ClientConfig.Service.Namespace, Name: w.ClientConfig.Service.Name}
			if !seen[b] {
				seen[b] = true
				backings = append(backings, b)
			}
		}
	}
	sort.Strings(unservable)
	sort.Slice(backings, func(i, j int) bool {
		if backings[i].Namespace != backings[j].Namespace {
			return backings[i].Namespace < backings[j].Namespace
		}
		return backings[i].Name < backings[j].Name
	})
	return unservable, backings
}

// endpointsList is the subset of a `kubectl get endpoints` response this gate reads.
type endpointsList struct {
	Subsets []struct {
		Addresses []struct {
			IP string `json:"ip"`
		} `json:"addresses"`
	} `json:"subsets"`
}

// endpointsReady reports whether an Endpoints object has at least one READY address.
//
// `subsets[].addresses` holds ready addresses; `notReadyAddresses` (deliberately not decoded) holds
// the rest. An Endpoints object with only not-ready addresses therefore reads as not ready, which
// is the state a webhook's Service is in while its pod is still starting.
func endpointsReady(raw []byte) (bool, error) {
	var ep endpointsList
	if err := json.Unmarshal(raw, &ep); err != nil {
		return false, fmt.Errorf("decode endpoints: %w", err)
	}
	for _, s := range ep.Subsets {
		if len(s.Addresses) > 0 {
			return true, nil
		}
	}
	return false, nil
}

// WaitAdmissionWebhooksServable blocks until every in-cluster admission webhook has a caBundle and a
// Service with ready endpoints, or the bound elapses.
//
// It reads the whole cluster rather than only the wave's own webhooks, and that is the intent: a
// resource created by wave N+1 is admitted by EVERY matching webhook, not only the ones this wave
// installed. Waiting for the cluster's admission plane to be serving is the condition that actually
// makes the next wave safe.
//
// Fail-soft: returns a descriptive error which callers report as a warning. It never blocks a deploy.
func WaitAdmissionWebhooksServable(budget *webhookWaitBudget, stdout, stderr io.Writer) error {
	if budget.remaining <= 0 {
		// Exhausted by an earlier wave. Say so rather than returning nil: a gate that reports
		// success when it did not run is the failure mode this repository pays for most often.
		return fmt.Errorf("admission webhook wait skipped: the %s whole-deploy budget was already spent by an earlier wave", admissionWebhookWaitBudget)
	}
	started := time.Now()
	deadline := started.Add(budget.remaining)
	defer func() { budget.spend(time.Since(started)) }()
	var last []string
	for {
		list, err := readWebhookConfigs()
		if err != nil {
			return fmt.Errorf("could not read admission webhook configurations: %w", err)
		}
		unservable, backings := unservableWebhooks(list)
		if len(unservable) == 0 {
			pending, perr := unreadyBackings(backings)
			if perr != nil {
				return fmt.Errorf("could not read webhook backing endpoints: %w", perr)
			}
			if len(pending) == 0 {
				// Say what was checked, not just that nothing was wrong. "0 unservable"
				// over an empty list and "0 unservable" over eleven webhooks are different
				// facts, and a gate that renders them identically cannot be audited.
				// Names what was NOT checked, because the green line is otherwise a stronger claim
				// than the gate makes: URL-backed webhooks have no endpoints to read and are skipped
				// deliberately, and an `Ignore` webhook cannot block admission so it is not waited
				// on. A `Fail` webhook served from a URL that is down WILL still reject wave N+1's
				// resources, and this gate will have said "servable".
				fmt.Fprintf(stdout, "  admission webhooks servable (%d in-cluster backing service(s) with ready endpoints; URL-backed and failurePolicy=Ignore webhooks are not checked)\n", len(backings))
				return nil
			}
			unservable = pending
		}
		last = unservable
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(admissionWebhookPollInterval)
	}
	return fmt.Errorf("admission webhook(s) still not servable after %s: %s — a resource created next may be refused by its admission controller (this is the addon-harbor / ingress-nginx x509 failure)",
		format.Duration(time.Since(started)), strings.Join(last, ", "))
}

// webhookKubectl is the seam this gate reads the cluster through. A package variable rather than a
// direct call so the POLL LOOP itself is testable: the interesting behaviour is that an unservable
// webhook becomes servable and the wait then returns, and that cannot be exercised against a
// function that shells out to a real cluster. Stubbed only by tests in this package.
var webhookKubectl = func(cmd string) (string, error) {
	return utils.ExecuteCommandWithOutput(cmd, ".", nil)
}

// readWebhookConfigs lists both webhook kinds in one call.
func readWebhookConfigs() (webhookConfigList, error) {
	var out webhookConfigList
	raw, err := webhookKubectl("kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations -o json")
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return out, fmt.Errorf("decode webhook configurations: %w", err)
	}
	return out, nil
}

// unreadyBackings returns a description of every backing Service without ready endpoints.
//
// A Service whose Endpoints object does not exist yet is NOT ready — that is the window between the
// Service being created and its pod being admitted, and treating a 404 as "fine" would wave the
// gate through in exactly the state it exists to catch.
func unreadyBackings(backings []webhookBacking) ([]string, error) {
	var pending []string
	for _, b := range backings {
		raw, err := webhookKubectl(
			fmt.Sprintf("kubectl get endpoints -n %s %s -o json", b.Namespace, b.Name))
		if err != nil {
			pending = append(pending, fmt.Sprintf("%s/%s (no Endpoints object yet)", b.Namespace, b.Name))
			continue
		}
		ready, derr := endpointsReady([]byte(raw))
		if derr != nil {
			return nil, derr
		}
		if !ready {
			pending = append(pending, fmt.Sprintf("%s/%s (no ready endpoints)", b.Namespace, b.Name))
		}
	}
	return pending, nil
}
