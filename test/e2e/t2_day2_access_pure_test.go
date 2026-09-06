// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the PURE day-2 ACCESS helpers (FULLY-TESTED P2-E) — no cloud, no token, no
// e2e_t2 tag. These prove each check's decision is non-vacuous: the target derivation
// HARD-FAILS when no access path was surfaced (the refuter for a vacuous access proof), the
// auth classifier distinguishes authorized / reachable-but-401 / unreachable, and the verdict
// only reads green when every check that ran actually passed.
package e2e

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDeriveAccessTargets(t *testing.T) {
	// AWS-shaped: both endpoint and argocd_url surfaced.
	tgt, err := deriveAccessTargets([]byte(`{"cluster_endpoint":"https://abc.eks.amazonaws.com","argocd_url":"https://argocd.prod.example.com"}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tgt.Endpoint != "https://abc.eks.amazonaws.com" || !tgt.HasArgoURL || tgt.ArgoURL != "https://argocd.prod.example.com" {
		t.Fatalf("parsed targets = %+v", tgt)
	}

	// gcp/azure-shaped: endpoint surfaced, NO ingress ⇒ no argocd_url.
	tgt2, err := deriveAccessTargets([]byte(`{"cluster_endpoint":"https://1.2.3.4","argocd_url":""}`))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tgt2.Endpoint != "https://1.2.3.4" || tgt2.HasArgoURL || tgt2.ArgoURL != "" {
		t.Fatalf("no-ingress targets = %+v (want endpoint set, HasArgoURL=false)", tgt2)
	}

	// Fail-closed refuters — each MUST error (a deploy that surfaced no access path can't be
	// asserted vacuously).
	refuters := []struct {
		name string
		raw  string
	}{
		{"empty metadata", ``},
		{"empty object", `{}`},
		{"blank endpoint", `{"cluster_endpoint":"   ","argocd_url":"https://x"}`},
		{"missing endpoint key", `{"argocd_url":"https://x"}`},
		{"malformed json", `{cluster_endpoint`},
	}
	for _, r := range refuters {
		t.Run(r.name, func(t *testing.T) {
			if _, err := deriveAccessTargets([]byte(r.raw)); err == nil {
				t.Fatalf("expected a HARD FAIL for %q — the access assertion would be vacuous", r.name)
			}
		})
	}
}

func TestAccessVerdictPass(t *testing.T) {
	green := AccessSummary{
		Enabled: true, EndpointSurfaced: true, KubeReachable: true, KubeAuthorized: true,
		ReadyNodes: 2, ArgoURLChecked: true, ArgoURLReachable: true,
	}
	if !accessVerdictPass(green) {
		t.Fatal("fully-green summary should pass")
	}
	// Each individual failing condition must flip the verdict red.
	flips := map[string]func(*AccessSummary){
		"disabled":               func(s *AccessSummary) { s.Enabled = false },
		"endpoint not surfaced":  func(s *AccessSummary) { s.EndpointSurfaced = false },
		"kube not reachable":     func(s *AccessSummary) { s.KubeReachable = false },
		"kube not authorized":    func(s *AccessSummary) { s.KubeAuthorized = false },
		"zero ready nodes":       func(s *AccessSummary) { s.ReadyNodes = 0 },
		"argocd url unreachable": func(s *AccessSummary) { s.ArgoURLReachable = false },
	}
	for name, mut := range flips {
		t.Run(name, func(t *testing.T) {
			s := green
			mut(&s)
			if accessVerdictPass(s) {
				t.Fatalf("%q should make the verdict fail", name)
			}
		})
	}
	// When the ArgoCD-URL check did NOT run (gcp/azure — no ingress), it does not gate.
	noArgo := green
	noArgo.ArgoURLChecked = false
	noArgo.ArgoURLReachable = false
	if !accessVerdictPass(noArgo) {
		t.Fatal("with ArgoURLChecked=false the argocd-url fields must not gate the verdict")
	}
}

func TestParseAuthCanI(t *testing.T) {
	for _, ok := range []string{"yes", "YES", "  yes\n", "Yes"} {
		if !parseAuthCanI(ok) {
			t.Errorf("parseAuthCanI(%q) = false, want true", ok)
		}
	}
	for _, no := range []string{"no", "NO", "", "   ", "maybe", "yesish", "yes no"} {
		if parseAuthCanI(no) {
			t.Errorf("parseAuthCanI(%q) = true, want false", no)
		}
	}
}

func TestClassifyCanI(t *testing.T) {
	tests := []struct {
		name          string
		out           string
		wantReachable bool
		wantAuthd     bool
	}{
		{"authorized", "yes\n", true, true},
		{"reachable but denied", "no\n", true, false},
		{"reachable but 401", "error: You must be logged in to the server (Unauthorized)", true, false},
		{"reachable but forbidden", "Error from server (Forbidden): ...", true, false},
		{"unreachable dial", "Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout", false, false},
		{"unreachable dns", "Unable to connect to the server: dial tcp: lookup x: no such host", false, false},
		{"unreachable refused", "The connection to the server was refused - connection refused", false, false},
		{"empty output", "", false, false},
		{"unknown garbage", "wat", false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, a := classifyCanI(tt.out)
			if r != tt.wantReachable || a != tt.wantAuthd {
				t.Fatalf("classifyCanI(%q) = (reachable=%t, authorized=%t), want (%t, %t)", tt.out, r, a, tt.wantReachable, tt.wantAuthd)
			}
		})
	}
}

func TestCountReadyNodeLines(t *testing.T) {
	out := "ip-10-0-1-5   Ready    <none>   3m   v1.32\n" +
		"ip-10-0-1-6   Ready    <none>   3m   v1.32\n" +
		"ip-10-0-1-7   NotReady <none>   1m   v1.32\n"
	if n := countReadyNodeLines(out); n != 2 {
		t.Fatalf("countReadyNodeLines = %d, want 2", n)
	}
	if n := countReadyNodeLines(""); n != 0 {
		t.Fatalf("countReadyNodeLines(empty) = %d, want 0", n)
	}
	if n := countReadyNodeLines("node-a   NotReady   <none>   1m   v1.32"); n != 0 {
		t.Fatalf("countReadyNodeLines(all NotReady) = %d, want 0", n)
	}
}

func TestEvaluateArgoURLStatus(t *testing.T) {
	for _, code := range []int{200, 301, 302, 307, 308} {
		if err := evaluateArgoURLStatus(code); err != nil {
			t.Errorf("evaluateArgoURLStatus(%d) = %v, want nil (resolvable)", code, err)
		}
	}
	for _, code := range []int{400, 404, 500, 502, 503} {
		if err := evaluateArgoURLStatus(code); err == nil {
			t.Errorf("evaluateArgoURLStatus(%d) = nil, want error", code)
		}
	}
}

func TestAccessSummaryVerdict(t *testing.T) {
	if got := accessSummaryVerdict(AccessSummary{Enabled: false}); !strings.Contains(got, "skipped") {
		t.Fatalf("disabled verdict = %q, want a skip line", got)
	}
	// gcp/azure (no ingress): renders n/a for the argocd-url, still green on the rest.
	gcp := AccessSummary{
		Enabled: true, Provider: "gcp", EndpointSurfaced: true, KubeReachable: true,
		KubeAuthorized: true, ReadyNodes: 3, ArgoURLChecked: false,
	}
	v := accessSummaryVerdict(gcp)
	if !strings.Contains(v, "n/a") || !strings.Contains(v, "✅") {
		t.Fatalf("gcp verdict = %q, want an ✅ line with argocd-url n/a", v)
	}
	// A red summary renders ❌.
	red := gcp
	red.KubeAuthorized = false
	if !strings.Contains(accessSummaryVerdict(red), "❌") {
		t.Fatalf("unauthorized verdict should render ❌: %q", accessSummaryVerdict(red))
	}
}

func TestDay2AccessTimeout(t *testing.T) {
	t.Setenv("ALETHIA_E2E_DAY2_ACCESS_TIMEOUT", "")
	if d := Day2AccessTimeout(); d != day2AccessDefaultTimeout {
		t.Fatalf("default timeout = %v, want the default", d)
	}
	t.Setenv("ALETHIA_E2E_DAY2_ACCESS_TIMEOUT", "90s")
	if d := Day2AccessTimeout(); d != 90*time.Second {
		t.Fatalf("override timeout = %v, want 90s", d)
	}
	// A garbage / non-positive value falls back to the default (never a zero-timeout probe).
	t.Setenv("ALETHIA_E2E_DAY2_ACCESS_TIMEOUT", "soon")
	if d := Day2AccessTimeout(); d != day2AccessDefaultTimeout {
		t.Fatalf("garbage timeout = %v, want the default", d)
	}
}

// TestDiagnoseArgoURLError pins the classifier that makes ONE run answer #2591's question.
//
// The run that woke this path recorded `argocd-url reachable=false` and nothing more, which left
// two different bugs — "external-dns never wrote the record" and "the ALB is still coming up" —
// indistinguishable, with a second paid run proposed as the discriminator. Each label below names
// a different fix, so the labels have to be trustworthy.
func TestDiagnoseArgoURLError(t *testing.T) {
	tests := []struct {
		name    string
		err     error
		wantHas string
		// wantTiming records whether the label claims waiting longer could help. Getting this
		// backwards is the expensive mistake: it sends the next run at the wrong budget.
		wantTiming bool
	}{
		{"NXDOMAIN", errors.New(`Get "https://argocd.x.e2e.alethialabs.io": dial tcp: lookup argocd.x.e2e.alethialabs.io: no such host`), "dns-not-resolving", false},
		{"connection refused", errors.New("dial tcp 10.0.0.1:443: connect: connection refused"), "connect-refused", true},
		{"i/o timeout", errors.New("dial tcp 10.0.0.1:443: i/o timeout"), "timeout", true},
		{"client timeout", errors.New("context deadline exceeded (Client.Timeout exceeded while awaiting headers)"), "timeout", true},
		{"bad certificate", errors.New(`tls: failed to verify certificate: x509: certificate signed by unknown authority`), "tls", false},
		// Verbatim from Go: net/http/transport.go, `func (tlsHandshakeTimeoutError) Error()`.
		// It cannot be built by calling the emitter the way the status case below is — the type
		// is unexported and provoking a real one needs a TLS server that accepts a connection
		// and then hangs. So the string is quoted from the stdlib source rather than remembered,
		// and the point of the case is the TIMING column: this reached `default` and came back
		// UNCLASSIFIED, which carries no timing claim for a failure that is nothing but timing.
		{"TLS handshake timeout", errors.New(`Get "https://argocd.x.e2e.alethialabs.io": net/http: TLS handshake timeout`), "tls-handshake-timeout", true},
		// Built by CALLING the emitter, never by retyping its wording: the first draft of this
		// classifier matched a phrase evaluateArgoURLStatus does not produce, so the one case it
		// was written for would have come back UNCLASSIFIED.
		{"an unexpected status", evaluateArgoURLStatus(503), "http", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := diagnoseArgoURLError(tc.err)
			if !strings.Contains(got, tc.wantHas) {
				t.Fatalf("diagnosis %q does not name %q", got, tc.wantHas)
			}
			if strings.Contains(got, "UNCLASSIFIED") {
				t.Errorf("a known failure fell through to UNCLASSIFIED: %q", got)
			}
			isTiming := strings.Contains(got, "a timing problem")
			if isTiming != tc.wantTiming {
				t.Errorf("timing claim = %v, want %v — this decides the next run's budget\ngot: %s", isTiming, tc.wantTiming, got)
			}
		})
	}

	t.Run("a handshake timeout is not a certificate rejection, whichever words it arrives in", func(t *testing.T) {
		// The two labels give OPPOSITE advice — one says wait, the other says waiting will not
		// help — so a wrapped form carrying both vocabularies must not land in the certificate
		// arm. This is what the arm ORDER buys, and ordering is invisible in a table test: both
		// cases pass a table whether or not the new arm sits first.
		got := diagnoseArgoURLError(errors.New(`tls: handshake failure: net/http: TLS handshake timeout`))
		if !strings.Contains(got, "tls-handshake-timeout") {
			t.Fatalf("a message naming both was classified as %q; the certificate arm claims waiting will NOT help, which is backwards here", got)
		}
		if !strings.Contains(got, "a timing problem") {
			t.Errorf("a handshake timeout must claim timing, got %q", got)
		}
	})

	t.Run("the certificate label states an observation, not a single cause", func(t *testing.T) {
		// It used to end "the ACM certificate is not attached to the listener, or does not cover
		// this name" — a conclusion the probe cannot support, and one that names a mechanism that
		// is not even in use on the clouds where cert-manager issues the certificate. Its
		// siblings state what was observed; this asserts what is wrong.
		got := diagnoseArgoURLError(errors.New(`x509: certificate has expired or is not yet valid`))
		if strings.Contains(got, "ACM") {
			t.Errorf("the label names one cloud's mechanism as the cause: %q", got)
		}
		if !strings.Contains(got, "the certificate was rejected") {
			t.Errorf("the label must still state the observation, got %q", got)
		}
	})

	t.Run("nil is empty, not a diagnosis", func(t *testing.T) {
		if got := diagnoseArgoURLError(nil); got != "" {
			t.Errorf("a reachable probe must carry no diagnosis, got %q", got)
		}
	})

	t.Run("an unrecognised failure is UNCLASSIFIED and keeps the text", func(t *testing.T) {
		// Deliberately NOT folded into the nearest bucket. The whole value of a label is that
		// it can be trusted to mean what it says; a classifier that guesses destroys that for
		// every other label too.
		got := diagnoseArgoURLError(errors.New("something nobody has seen before"))
		if !strings.HasPrefix(got, "UNCLASSIFIED: ") {
			t.Errorf("want an UNCLASSIFIED prefix, got %q", got)
		}
		if !strings.Contains(got, "something nobody has seen before") {
			t.Errorf("the original error must survive verbatim, got %q", got)
		}
	})
}

// TestAccessSummaryRendersTheDiagnosis — a diagnosis that never reaches the summary line is a
// diagnosis nobody reads. It must appear on the FAILING path and stay off the passing one.
func TestAccessSummaryRendersTheDiagnosis(t *testing.T) {
	bad := AccessSummary{
		Enabled:        true, // without this accessSummaryVerdict short-circuits to "skipped"
		ArgoURLChecked: true, ArgoURL: "https://argocd.x/", ArgoURLReachable: false,
		ArgoURLDiagnosis: "dns-not-resolving: the hostname does not resolve",
	}
	if !strings.Contains(accessSummaryVerdict(bad), "dns-not-resolving") {
		t.Errorf("the failing verdict must carry the diagnosis: %s", accessSummaryVerdict(bad))
	}
	good := AccessSummary{Enabled: true, ArgoURLChecked: true, ArgoURL: "https://argocd.x/", ArgoURLReachable: true}
	if strings.Contains(accessSummaryVerdict(good), "—") {
		t.Errorf("a reachable URL must not render a diagnosis tail: %s", accessSummaryVerdict(good))
	}
}

// TestDnsNotResolvingDoesNotClaimWaitingIsFutile pins the CORRECTION.
//
// The label used to assert "waiting longer will NOT fix this". It cost a wrong diagnosis: aws/byo
// run 32909287152 was read as a structural failure on that basis, when in fact the zone was
// delegated (ACM had ISSUED a certificate against it, which requires public resolvability),
// external-dns was deployed and its IRSA role was bound — the record simply was not written yet at
// 3m. NXDOMAIN while a load balancer is still provisioning is the EXPECTED state.
//
// This label decides whether a maintainer spends another run, so it must not claim more than the
// error supports.
func TestDnsNotResolvingDoesNotClaimWaitingIsFutile(t *testing.T) {
	got := diagnoseArgoURLError(errors.New(`Get "https://argocd.x.e2e.alethialabs.io": dial tcp: lookup argocd.x.e2e.alethialabs.io: no such host`))
	if !strings.HasPrefix(got, "dns-not-resolving") {
		t.Fatalf("classification changed: %q", got)
	}
	for _, forbidden := range []string{"NOT a timing problem", "waiting longer will NOT fix", "will not fix it"} {
		if strings.Contains(got, forbidden) {
			t.Errorf("dns-not-resolving asserts %q, which the error does not establish — an NXDOMAIN "+
				"during load-balancer provisioning is exactly a wait-longer state:\n%s", forbidden, got)
		}
	}
	// And it must still be USEFUL — a label that says nothing is no better than the wrong one.
	if !strings.Contains(got, "AMBIGUOUS") {
		t.Errorf("dns-not-resolving no longer tells the reader the label is ambiguous:\n%s", got)
	}
}

// TestDay2AccessIsReservedInTheLadder — the probes run inside the test ctx and are bounded by
// Day2AccessTimeout, so a ceiling sized for an ALB spends real minutes. Before this, the layer had
// no ladder term at all and that time came silently out of `headroom` (the #2729 defect shape).
func TestDay2AccessIsReservedInTheLadder(t *testing.T) {
	for _, v := range T2BudgetScenarioEnv() {
		t.Setenv(v, "")
	}
	t.Setenv("ALETHIA_E2E_ARGO_TIMEOUT", "")
	off, err := ResolveT2Budget("aws", "ladder")
	if err != nil {
		t.Fatalf("baseline: %v", err)
	}
	t.Setenv("ALETHIA_E2E_DAY2_ACCESS", "1")
	on, err := ResolveT2Budget("aws", "ladder")
	if err != nil {
		t.Fatalf("day-2 access on: %v", err)
	}
	if got, want := on.Ctx-off.Ctx, Day2AccessTimeout(); got != want {
		t.Errorf("enabling the day-2 access layer widened the ctx by %s, want %s — its kube probe "+
			"would run to its own ceiling against headroom the ladder never reserved", got, want)
	}

	// The URL probe is reserved only where a URL can EXIST. Under max-config the workflow leaves
	// ALETHIA_E2E_ACM_CERT empty (#2630), so there is no ingress certificate, no argocd_url, and the
	// probe is skipped — reserving for it there would inflate the heaviest bar by ten minutes it
	// cannot spend. Varying the EMITTER's inputs is the axis that decides this, so that is what the
	// test varies.
	t.Setenv(envAcmCert, "1")
	t.Setenv("ALETHIA_E2E_MAX_CONFIG", "")
	withURL, err := ResolveT2Budget("aws", "ladder")
	if err != nil {
		t.Fatalf("acm on, max-config off: %v", err)
	}
	if got, want := withURL.Ctx-on.Ctx, Day2URLTimeout(); got != want {
		t.Errorf("a run that WILL probe the URL reserved %s for it, want %s", got, want)
	}
	if !t2BudgetHasTerm(withURL, "day2-url") {
		t.Error("a run that WILL probe the URL has no `day2-url` term in the ladder")
	}

	t.Setenv("ALETHIA_E2E_MAX_CONFIG", "1")
	maxCfg, err := ResolveT2Budget("aws", "ladder")
	if err != nil {
		t.Fatalf("acm on, max-config on: %v", err)
	}
	// The TERM, not the total. This used to assert `maxCfg.Ctx < withURL.Ctx`, which reads the
	// aggregate and therefore asks the question only as long as nothing else differs between the two
	// ladders. #2652 added a `max-config-probe` term that happens to be the same 10m as the URL probe,
	// so the totals came out equal and a passing arrangement looked like a failing one — with the
	// error message confidently naming the wrong cause. Naming the term answers the actual question
	// and cannot be masked by an unrelated one.
	if t2BudgetHasTerm(maxCfg, "day2-url") {
		t.Errorf("max-config reserved the URL probe even though it empties ALETHIA_E2E_ACM_CERT and "+
			"therefore renders no ArgoCD URL for the probe to check: %s", maxCfg.Describe())
	}
}

// t2BudgetHasTerm reports whether the ladder reserves a named scenario.
func t2BudgetHasTerm(b T2Budget, scenario string) bool {
	for _, term := range b.Terms {
		if term.Scenario == scenario {
			return true
		}
	}
	return false
}

// #2591's ambiguity, made decidable. The three outcomes point at three different places, and the
// failure mode this guards is them collapsing into each other — particularly "could not look"
// reading like either verdict, which would send someone to the wrong team with confidence.
func TestIngressAddressVerdict(t *testing.T) {
	t.Run("an address means external-dns is at fault", func(t *testing.T) {
		got := ingressAddressVerdict("k8s-argocd-abc123.us-east-1.elb.amazonaws.com", nil)
		if !strings.Contains(got, "external-dns") || !strings.Contains(got, "DOES have address") {
			t.Errorf("must point at external-dns and quote the address; got %q", got)
		}
		if strings.Contains(got, "upstream in the ingress") {
			t.Errorf("must not also blame the ingress path; got %q", got)
		}
	})

	t.Run("no address exonerates external-dns", func(t *testing.T) {
		got := ingressAddressVerdict("", nil)
		if !strings.Contains(got, "NO load-balancer address") {
			t.Errorf("must say the address is absent; got %q", got)
		}
		// The load-bearing half: it must say external-dns is NOT the problem, or the reader keeps
		// investigating the thing that is working.
		if !strings.Contains(got, "NOT in external-dns") {
			t.Errorf("must exonerate external-dns; got %q", got)
		}
	})

	t.Run("a read failure is neither verdict", func(t *testing.T) {
		got := ingressAddressVerdict("", errors.New("connection refused"))
		if !strings.Contains(got, "UNKNOWN") || !strings.Contains(got, "does NOT distinguish") {
			t.Errorf("a failure to look must say so explicitly; got %q", got)
		}
		// An error with an empty address must NOT be read as "no address", which is a real verdict.
		if strings.Contains(got, "NO load-balancer address") {
			t.Errorf("could-not-look rendered as a genuine finding; got %q", got)
		}
	})

	t.Run("whitespace is not an address", func(t *testing.T) {
		// jsonpath over zero items prints an empty or blank string; treating that as an address
		// would blame external-dns for a load balancer that never came up.
		if got := ingressAddressVerdict("   ", nil); !strings.Contains(got, "NO load-balancer address") {
			t.Errorf("blank must read as absent; got %q", got)
		}
	})
}

// Covers the exec wrapper. Hermetic: kubectl absent or kubeconfig missing are both errors, and the
// only contract asserted is that a failure to READ never returns an address — which would otherwise
// blame external-dns for a load balancer nobody managed to look at.
func TestReadIngressAddressUnreachableIsAnError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	addr, err := readIngressAddress(ctx, filepath.Join(t.TempDir(), "no-such-kubeconfig"))
	if err == nil {
		t.Fatal("an unreachable cluster must not report an ingress address")
	}
	if addr != "" {
		t.Errorf("a failed read must return no address, got %q", addr)
	}
	// And it must flow into the verdict as "could not look", not as a finding.
	if v := ingressAddressVerdict(addr, err); !strings.Contains(v, "UNKNOWN") {
		t.Errorf("a failed read must render as UNKNOWN; got %q", v)
	}
}

// The max-config cluster probes must be RESERVED, not spent against someone else's headroom.
//
// `argocd-converge` pays for AssertArgoAppsHealthy and nothing else. The probes are a second,
// independent wait, and before #2652 they had no ladder term at all — the same defect this file
// already documents for the day-2 probes. It mattered little while only hetzner declared a probe;
// it matters on the four managed clouds, which are precisely the ones where the store is the thing
// hypothesised to be missing and the poll therefore runs to its ceiling.
//
// The size is asserted from the grid rather than against a literal, so adding a probed cell moves
// the reservation without anyone remembering to.
func TestMaxConfigProbesAreReservedInTheLadder(t *testing.T) {
	t.Setenv("ALETHIA_E2E_SOAK", "")
	t.Setenv("ALETHIA_E2E_DAY2_ACCESS", "")
	t.Setenv(envAcmCert, "")

	t.Setenv("ALETHIA_E2E_MAX_CONFIG", "")
	off, err := ResolveT2Budget("aws", "ladder")
	if err != nil {
		t.Fatalf("max-config off: %v", err)
	}
	if t2BudgetHasTerm(off, "max-config-probe") {
		t.Error("a run with no max-config reserved the probe budget it will never spend")
	}

	t.Setenv("ALETHIA_E2E_MAX_CONFIG", "1")
	on, err := ResolveT2Budget("aws", "ladder")
	if err != nil {
		t.Fatalf("max-config on: %v", err)
	}
	if !t2BudgetHasTerm(on, "max-config-probe") {
		t.Fatalf("max-config did not reserve the cluster probes; ladder = %s", on.Describe())
	}
	want := MaxConfigProbeBudget("aws")
	if want <= 0 {
		t.Fatal("aws declares no probed max-config cell, so this guard would pass vacuously")
	}
	if got := on.Ctx - off.Ctx; got != want {
		t.Errorf("max-config widened the ctx by %s, want %s — the probes would poll to their ceiling "+
			"against headroom the ladder never reserved, and a store that is genuinely absent would "+
			"surface as `context deadline exceeded` with the Ready condition thrown away", got, want)
	}
}
