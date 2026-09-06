// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/utils"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
)

func resetDeploySeams(t *testing.T) {
	t.Helper()
	origExecuteCommand := executeCommand
	origExecuteCommandWithOutput := executeCommandWithOutput
	origNamespacePostMortem := namespacePostMortem
	origPreflightArgoVersion := preflightArgoVersion
	// The preflight shells kubectl directly, so without this every test that drives installArgoCD
	// probed whatever cluster the process KUBECONFIG pointed at (#3495). Stubbed to the answer a
	// fresh cluster gives — proceed — so the tests exercise the install they are about.
	// ABSENT, not a zero decision: the fresh-cluster answer carries no chart override and no skip,
	// which is what makes the install these tests are about the one that actually runs. A bare
	// `ArgoPreflightDecision{}` would happen to have the same two fields and would say nothing
	// about which verdict it stands for (#3521).
	preflightArgoVersion = func(context.Context, io.Writer) (argocd.ArgoPreflightDecision, error) {
		return argocd.ArgoPreflightDecision{Verdict: argocd.ArgoPreflightAbsent, Proceed: true}, nil
	}
	t.Cleanup(func() {
		executeCommand = origExecuteCommand
		executeCommandWithOutput = origExecuteCommandWithOutput
		namespacePostMortem = origNamespacePostMortem
		preflightArgoVersion = origPreflightArgoVersion
	})
}

func TestDeployHelperPolicyFunctions(t *testing.T) {
	t.Run("enabled add-on ids preserve desired order", func(t *testing.T) {
		got := enabledAddonIDs([]types.AddOnInstall{{ID: "db"}, {ID: "cache"}, {ID: "queue"}})
		if strings.Join(got, ",") != "db,cache,queue" {
			t.Fatalf("enabledAddonIDs = %#v", got)
		}
	})

	t.Run("compat add-on refs carry id + pinned version, nil for empty", func(t *testing.T) {
		if got := compatAddOnRefs(nil); got != nil {
			t.Fatalf("compatAddOnRefs(nil) = %#v, want nil (no add-ons → empty subject slice)", got)
		}
		got := compatAddOnRefs([]types.AddOnInstall{
			{ID: "kube-prometheus-stack", Version: "58.1.0"},
			{ID: "cnpg"}, // version may be empty (git-ref add-ons); the ref must still carry the id
		})
		if len(got) != 2 {
			t.Fatalf("compatAddOnRefs len = %d, want 2", len(got))
		}
		if got[0].ID != "kube-prometheus-stack" || got[0].Version != "58.1.0" {
			t.Errorf("ref[0] = %#v", got[0])
		}
		if got[1].ID != "cnpg" || got[1].Version != "" {
			t.Errorf("ref[1] = %#v", got[1])
		}
	})

	t.Run("phase marker is best effort and optional", func(t *testing.T) {
		writePhase("", "apply")
		path := filepath.Join(t.TempDir(), "phase")
		writePhase(path, "apply")
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read phase: %v", err)
		}
		if string(data) != "apply" {
			t.Fatalf("phase = %q, want apply", data)
		}
	})

	t.Run("gitops failure sanitizes token and records mode", func(t *testing.T) {
		status := gitopsFailure(true, "https://github.com/acme/apps.git", "repo_credentials", errors.New("clone failed with secret-token"), "secret-token")
		if status.Mode != "gitops" || status.AppsRepo != "https://github.com/acme/apps.git" || status.FailedStep != "repo_credentials" {
			t.Fatalf("unexpected GitopsStatus: %#v", status)
		}
		if strings.Contains(status.Error, "secret-token") {
			t.Fatalf("GitopsStatus leaked token in error: %q", status.Error)
		}

		direct := gitopsFailure(false, "", argocd.GitopsStepArgocdInstall, errors.New("helm timeout"))
		if direct.Mode != "direct" || direct.AppsRepo != "" ||
			direct.FailedStep != argocd.GitopsStepArgocdInstall || direct.Error != "helm timeout" {
			t.Fatalf("unexpected direct GitopsStatus: %#v", direct)
		}
	})

	t.Run("timeouts parse positive durations and fall back on invalid values", func(t *testing.T) {
		t.Setenv("ALETHIA_CLUSTER_READY_TIMEOUT", "42s")
		if clusterReadyTimeout() != 42*time.Second {
			t.Fatalf("clusterReadyTimeout = %s, want 42s", clusterReadyTimeout())
		}
		t.Setenv("ALETHIA_CLUSTER_READY_TIMEOUT", "-1s")
		if clusterReadyTimeout() != 15*time.Minute {
			t.Fatalf("clusterReadyTimeout invalid fallback = %s", clusterReadyTimeout())
		}

		t.Setenv("ALETHIA_ADDON_CONVERGE_TIMEOUT", "0")
		if addonConvergeTimeout() != 0 {
			t.Fatalf("addonConvergeTimeout = %s, want 0", addonConvergeTimeout())
		}
		t.Setenv("ALETHIA_ADDON_CONVERGE_TIMEOUT", "bad")
		if addonConvergeTimeout() != 10*time.Minute {
			t.Fatalf("addonConvergeTimeout invalid fallback = %s", addonConvergeTimeout())
		}
	})

	t.Run("node readiness env opt out values", func(t *testing.T) {
		for _, value := range []string{"0", "false", "no", "off"} {
			t.Setenv("ALETHIA_CLUSTER_READY_REQUIRE_NODE", value)
			if clusterReadyRequireNode() {
				t.Fatalf("clusterReadyRequireNode(%q) = true, want false", value)
			}
		}
		t.Setenv("ALETHIA_CLUSTER_READY_REQUIRE_NODE", "yes")
		if !clusterReadyRequireNode() {
			t.Fatal("clusterReadyRequireNode should default to true")
		}
	})

	t.Run("short hash handles short and long hashes", func(t *testing.T) {
		if shortHash("abc") != "abc" {
			t.Fatalf("shortHash short = %q", shortHash("abc"))
		}
		if got := shortHash("1234567890abcdef"); got != "1234567890ab…" {
			t.Fatalf("shortHash long = %q", got)
		}
	})
}

func TestResolveArgoTemplatesDirUsesEnvBeforeFallbacks(t *testing.T) {
	t.Chdir(t.TempDir())
	envDir := filepath.Join(t.TempDir(), "templates")
	if err := os.MkdirAll(envDir, 0755); err != nil {
		t.Fatalf("mkdir env templates: %v", err)
	}
	if err := os.MkdirAll("argocd-templates", 0755); err != nil {
		t.Fatalf("mkdir fallback templates: %v", err)
	}
	t.Setenv("ALETHIA_ARGOCD_TEMPLATES_DIR", envDir)

	if got := resolveArgoTemplatesDir(); got != envDir {
		t.Fatalf("resolveArgoTemplatesDir = %q, want %q", got, envDir)
	}
}

func TestApplyBootstrapManifests(t *testing.T) {
	resetDeploySeams(t)

	t.Run("no output is a no-op", func(t *testing.T) {
		executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
			t.Fatal("executeCommand called for empty bootstrap output")
			return nil
		}
		if err := applyBootstrapManifests(context.Background(), nil, io.Discard, io.Discard); err != nil {
			t.Fatalf("applyBootstrapManifests: %v", err)
		}
	})

	t.Run("writes manifests and applies server side", func(t *testing.T) {
		wantManifest := "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: cni\n"
		var gotCommand string
		executeCommand = func(command, dir string, _ []string, _, _ io.Writer) error {
			gotCommand = command
			if dir != "." {
				t.Fatalf("dir = %q, want .", dir)
			}
			path := strings.TrimSpace(strings.TrimPrefix(command[strings.LastIndex(command, "-f "):], "-f "))
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read manifest %q: %v", path, err)
			}
			if string(data) != wantManifest {
				t.Fatalf("manifest = %q, want %q", data, wantManifest)
			}
			return nil
		}
		if err := applyBootstrapManifests(context.Background(), map[string]interface{}{"bootstrap_manifests": wantManifest}, io.Discard, io.Discard); err != nil {
			t.Fatalf("applyBootstrapManifests: %v", err)
		}
		if !strings.Contains(gotCommand, "kubectl apply --server-side --force-conflicts -f ") {
			t.Fatalf("command = %q", gotCommand)
		}
	})

	t.Run("canceled context stops retries without waiting", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		executeCommand = func(string, string, []string, io.Writer, io.Writer) error {
			return errors.New("api not ready")
		}
		err := applyBootstrapManifests(ctx, map[string]interface{}{"bootstrap_manifests": "kind: Namespace\n"}, io.Discard, io.Discard)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("applyBootstrapManifests error = %v, want context.Canceled", err)
		}
	})
}

func TestEnsureArgoRedisSecret(t *testing.T) {
	resetDeploySeams(t)

	t.Run("existing secret is not overwritten", func(t *testing.T) {
		var commands []string
		executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
			commands = append(commands, command)
			return nil
		}
		executeCommandWithOutput = func(command, _ string, _ []string) (string, error) {
			if !strings.Contains(command, "argocd-redis") {
				t.Fatalf("unexpected output command: %q", command)
			}
			return "already-set", nil
		}
		if err := ensureArgoRedisSecret(io.Discard, io.Discard); err != nil {
			t.Fatalf("ensureArgoRedisSecret: %v", err)
		}
		if len(commands) != 1 || !strings.Contains(commands[0], "kubectl create namespace argocd") {
			t.Fatalf("commands = %#v, want namespace create only", commands)
		}
	})

	t.Run("missing secret applies helm-adoptable manifest", func(t *testing.T) {
		var appliedManifest string
		executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
			if strings.HasPrefix(command, "kubectl apply -f ") {
				path := strings.TrimPrefix(command, "kubectl apply -f ")
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatalf("read manifest: %v", err)
				}
				appliedManifest = string(data)
			}
			return nil
		}
		executeCommandWithOutput = func(string, string, []string) (string, error) {
			return "", errors.New("not found")
		}
		var stdout bytes.Buffer
		if err := ensureArgoRedisSecret(&stdout, io.Discard); err != nil {
			t.Fatalf("ensureArgoRedisSecret: %v", err)
		}
		for _, want := range []string{
			"name: argocd-redis",
			"namespace: argocd",
			"app.kubernetes.io/managed-by: Helm",
			"meta.helm.sh/release-name: argo-cd",
			"auth:",
		} {
			if !strings.Contains(appliedManifest, want) {
				t.Fatalf("manifest missing %q:\n%s", want, appliedManifest)
			}
		}
		if !strings.Contains(stdout.String(), "Pre-seeded argocd-redis secret") {
			t.Fatalf("stdout = %q", stdout.String())
		}
	})
}

func TestInstallArgoCDBuildsIngressCommandOnlyWhenCertificateExists(t *testing.T) {
	resetDeploySeams(t)

	executeCommandWithOutput = func(string, string, []string) (string, error) {
		return "existing-auth", nil
	}

	var commands []string
	executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
		commands = append(commands, command)
		return nil
	}

	result := &PlanResult{}
	vc := &types.ProjectConfig{
		DNS: types.ProjectDNSConfig{Enabled: true, DomainName: "example.com"},
	}
	err := installArgoCD(
		context.Background(),
		vc,
		map[string]interface{}{"acm_certificate_arn": "arn:aws:acm:region:acct:certificate/123"},
		result,
		io.Discard,
		io.Discard,
	)
	if err != nil {
		t.Fatalf("installArgoCD: %v", err)
	}
	if result.ArgocdURL != "https://argocd.example.com" {
		t.Fatalf("ArgocdURL = %q", result.ArgocdURL)
	}
	if len(commands) < 3 {
		t.Fatalf("commands = %#v, want helm repo, namespace, install", commands)
	}
	install := commands[len(commands)-1]
	for _, want := range []string{
		"helm upgrade --install argo-cd",
		"--set redisSecretInit.enabled=false",
		// Derived from the resolver, not a literal, so the assertion cannot drift from the source
		// when the default budget is retuned. The env-override case is covered separately below.
		"--wait --timeout " + utils.ShellQuote(argocd.ResolvedArgoInstallTimeout()),
		"server.ingress.enabled=true",
		"server.ingress.hostname=argocd.example.com",
		"arn:aws:acm:region:acct:certificate/123",
	} {
		if !strings.Contains(install, want) {
			t.Fatalf("install command missing %q:\n%s", want, install)
		}
	}

	result = &PlanResult{}
	commands = nil
	if err := installArgoCD(context.Background(), vc, nil, result, io.Discard, io.Discard); err != nil {
		t.Fatalf("installArgoCD without cert: %v", err)
	}
	if result.ArgocdURL != "" {
		t.Fatalf("ArgocdURL without cert = %q, want empty", result.ArgocdURL)
	}
	if strings.Contains(commands[len(commands)-1], "server.ingress.enabled=true") {
		t.Fatalf("install command enabled ingress without certificate:\n%s", commands[len(commands)-1])
	}
}

// TestInstallArgoCDHonoursTimeoutOverride pins that the env knob actually reaches the helm command.
// The assertion above derives its expectation from the same resolver, so it would pass even if the
// timeout were never interpolated — this is the case that proves the wiring.
func TestInstallArgoCDHonoursTimeoutOverride(t *testing.T) {
	resetDeploySeams(t)
	t.Setenv(argocd.ArgoInstallTimeoutEnv, "23m")

	executeCommandWithOutput = func(string, string, []string) (string, error) {
		return "existing-auth", nil
	}
	var commands []string
	executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
		commands = append(commands, command)
		return nil
	}

	err := installArgoCD(context.Background(), &types.ProjectConfig{}, nil, &PlanResult{}, io.Discard, io.Discard)
	if err != nil {
		t.Fatalf("installArgoCD: %v", err)
	}
	install := commands[len(commands)-1]
	if !strings.Contains(install, "--wait --timeout '23m'") {
		t.Fatalf("install command did not carry the overridden timeout:\n%s", install)
	}
}

// TestInstallArgoCDDumpsPostMortemOnHelmFailure pins the #1734 contract: when the helm install
// fails, the namespace's state is dumped to STDOUT before the error propagates — and the install
// still FAILS CLOSED (#1718). Three nights of the aws nightly died here with nothing to act on
// because helm's "context deadline exceeded" names neither the pod nor the reason.
func TestInstallArgoCDDumpsPostMortemOnHelmFailure(t *testing.T) {
	resetDeploySeams(t)

	executeCommandWithOutput = func(string, string, []string) (string, error) {
		return "existing-auth", nil
	}
	executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
		if strings.Contains(command, "helm upgrade --install argo-cd") {
			return errors.New("exit status 1")
		}
		return nil
	}
	var dumped []string
	namespacePostMortem = func(ns string) string {
		dumped = append(dumped, ns)
		return "POST-MORTEM BODY"
	}

	var stdout, stderr bytes.Buffer
	err := installArgoCD(context.Background(), &types.ProjectConfig{}, nil, &PlanResult{}, &stdout, &stderr)
	if err == nil {
		t.Fatal("installArgoCD returned nil — the install must still FAIL CLOSED (#1718)")
	}
	if len(dumped) != 1 || dumped[0] != "argocd" {
		t.Fatalf("post-mortem calls = %#v, want exactly one for the argocd namespace", dumped)
	}
	if !strings.Contains(stdout.String(), "POST-MORTEM BODY") {
		t.Fatalf("post-mortem did not reach stdout:\n%s", stdout.String())
	}
	if strings.Contains(stderr.String(), "POST-MORTEM BODY") {
		t.Fatal("post-mortem went to stderr; it must be on stdout so the runner log and console job log both carry it")
	}

	// The success path must not dump: a post-mortem on a healthy install is noise that trains
	// readers to ignore it.
	dumped = nil
	executeCommand = func(string, string, []string, io.Writer, io.Writer) error { return nil }
	if err := installArgoCD(context.Background(), &types.ProjectConfig{}, nil, &PlanResult{}, io.Discard, io.Discard); err != nil {
		t.Fatalf("installArgoCD on the success path: %v", err)
	}
	if len(dumped) != 0 {
		t.Fatalf("post-mortem ran on the success path: %#v", dumped)
	}
}

func TestAttachReceiptNoopsWithoutReport(t *testing.T) {
	result := &PlanResult{}
	attachReceipt(result, "missing-plan", nil, &verify.Override{Controls: []string{"x"}}, io.Discard)
	if result.VerifyReceipt != nil {
		t.Fatalf("VerifyReceipt = %#v, want nil without report", result.VerifyReceipt)
	}

	status := readGitopsSnapshot(false, "", io.Discard, io.Discard)
	if status.ArgocdApp != "" && status.ArgocdApp != argocd.UserAppsApplicationName {
		t.Fatalf("unexpected direct ArgocdApp: %q", status.ArgocdApp)
	}
}

// TestGitTokenValues asserts the collector gathers the apps-repo token plus every non-empty
// per-repo BYO token (and drops empties) so all of them can be redacted from error output (#948).
func TestGitTokenValues(t *testing.T) {
	got := gitTokenValues("apps-tok", map[string]string{
		"https://github.com/a/b":  "byo-1",
		"https://gitlab.com/c/d":  "byo-2",
		"https://example.com/e/f": "", // no token for this repo — must be skipped
	})
	want := map[string]bool{"apps-tok": true, "byo-1": true, "byo-2": true}
	if len(got) != len(want) {
		t.Fatalf("gitTokenValues = %#v, want the 3 non-empty tokens", got)
	}
	for _, tok := range got {
		if !want[tok] {
			t.Errorf("unexpected token %q", tok)
		}
	}

	// Empty apps token is dropped too; no tokens → empty (not nil-panic).
	if got := gitTokenValues("", nil); len(got) != 0 {
		t.Errorf("gitTokenValues empty = %#v, want none", got)
	}
}

// TestGitopsFailureRedactsAllTokens asserts a BYO per-repo token embedded in a wiring error is
// scrubbed from the persisted GitopsStatus.Error, not just the apps-repo token (#948).
func TestGitopsFailureRedactsAllTokens(t *testing.T) {
	byoTok := "glpat-byosecret"
	err := errors.New("clone https://x-access-token:" + byoTok + "@gitlab.com/acme/chart failed")
	gs := gitopsFailure(true, "https://github.com/acme/apps", "byo_charts", err,
		gitTokenValues("apps-tok", map[string]string{"https://gitlab.com/acme/chart": byoTok})...)
	if strings.Contains(gs.Error, byoTok) {
		t.Fatalf("BYO token survived in GitopsStatus.Error: %q", gs.Error)
	}
	if !strings.Contains(gs.Error, "[REDACTED]") {
		t.Errorf("want [REDACTED] marker, got %q", gs.Error)
	}
}

// TestInstallArgoCDAttachesWAFWebACLOnlyWhenPresent is the proof that the canvas WAF switch
// reaches something. The template has always BUILT a regional web ACL and associated it with
// nothing; the ALB ingress annotation is the attach. Two directions matter and they fail
// differently:
//
//   - the ARN present must reach `alb.ingress.kubernetes.io/wafv2-acl-arn` on the helm command
//     (otherwise the project pays for an ACL that inspects zero requests, silently);
//   - the ARN ABSENT must emit NO annotation key at all — an empty wafv2-acl-arn value is not
//     "no WAF", it is a malformed association the ALB controller refuses, which wedges the
//     whole ingress reconcile and takes ArgoCD's URL down with it.
func TestInstallArgoCDAttachesWAFWebACLOnlyWhenPresent(t *testing.T) {
	const wafArn = "arn:aws:wafv2:us-east-1:123456789012:regional/webacl/app-waf/0c4e-1"
	const certArn = "arn:aws:acm:us-east-1:123456789012:certificate/123"

	installCommandFor := func(t *testing.T, outputs map[string]interface{}) string {
		t.Helper()
		resetDeploySeams(t)
		executeCommandWithOutput = func(string, string, []string) (string, error) { return "existing-auth", nil }
		var commands []string
		executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
			commands = append(commands, command)
			return nil
		}
		vc := &types.ProjectConfig{DNS: types.ProjectDNSConfig{Enabled: true, DomainName: "example.com"}}
		if err := installArgoCD(context.Background(), vc, outputs, &PlanResult{}, io.Discard, io.Discard); err != nil {
			t.Fatalf("installArgoCD: %v", err)
		}
		if len(commands) == 0 {
			t.Fatal("no commands executed")
		}
		return commands[len(commands)-1]
	}

	t.Run("web ACL present is annotated onto the ingress", func(t *testing.T) {
		install := installCommandFor(t, map[string]interface{}{
			"acm_certificate_arn": certArn,
			"waf_webacl_arn":      wafArn,
		})
		for _, want := range []string{`alb\.ingress\.kubernetes\.io/wafv2-acl-arn=` + wafArn, "server.ingress.enabled=true"} {
			if !strings.Contains(install, want) {
				t.Fatalf("install command missing %q:\n%s", want, install)
			}
		}
	})

	t.Run("waf off emits no annotation key at all", func(t *testing.T) {
		install := installCommandFor(t, map[string]interface{}{"acm_certificate_arn": certArn})
		if strings.Contains(install, "wafv2-acl-arn") {
			t.Fatalf("install command carries a wafv2-acl-arn annotation with no web ACL:\n%s", install)
		}
		// The rest of the ingress must be untouched — this path is the common case.
		if !strings.Contains(install, "server.ingress.enabled=true") {
			t.Fatalf("install command lost the ingress:\n%s", install)
		}
	})

	// A null output (the shape tofu emits when application_waf_enabled is false) must behave
	// exactly like an absent one — ExtractOutput yields "", and "" must mean "no annotation".
	t.Run("a null waf output is not an empty annotation", func(t *testing.T) {
		install := installCommandFor(t, map[string]interface{}{
			"acm_certificate_arn": certArn,
			"waf_webacl_arn":      nil,
		})
		if strings.Contains(install, "wafv2-acl-arn") {
			t.Fatalf("a null waf_webacl_arn produced an annotation:\n%s", install)
		}
	})

	// No certificate ⇒ no ingress at all ⇒ nothing to annotate, even with a web ACL built.
	t.Run("no ingress means no annotation even with a web ACL", func(t *testing.T) {
		install := installCommandFor(t, map[string]interface{}{"waf_webacl_arn": wafArn})
		if strings.Contains(install, "wafv2-acl-arn") || strings.Contains(install, "server.ingress.enabled=true") {
			t.Fatalf("annotated an ingress that was never configured:\n%s", install)
		}
	})
}

// TestArgocdURLAndWAFDecisionsMatchWhatInstallArgoCDEmits is the anti-drift assertion between
// the two halves of the same claim: installArgoCD DECIDES what to emit, and
// argocd.InfraServiceDecisions REPORTS what was emitted, from separate packages that had no
// test forcing them to agree.
//
// They disagreed. installArgoCD renders the ingress inside `if vc.DNS.Enabled &&
// vc.DNS.DomainName != ""` and only then when the ACM certificate output is present;
// argocdURLGates["aws"] checked the certificate ALONE. A project with DNS off, a domain, a zone
// id and the certificate switch on therefore got a real certificate ARN, NO ingress, and a
// console reporting "installed — ArgoCD is exposed over the ALB ingress" plus a WAF "attached"
// via an annotation that was never emitted. Reachable in practice: acm_certificate_enable comes
// from DNS.ManagedCertificate, which is independent of DNS.Enabled and settable straight through
// provider_config.
//
// Asserting equivalence over the whole matrix rather than spot-checking the one broken cell is
// the point — it is what makes the next ingress lane unable to reintroduce the same gap.
func TestArgocdURLAndWAFDecisionsMatchWhatInstallArgoCDEmits(t *testing.T) {
	const wafArn = "arn:aws:wafv2:us-east-1:123456789012:regional/webacl/app-waf/0c4e-1"
	const certArn = "arn:aws:acm:us-east-1:123456789012:certificate/123"

	decisionStatus := func(t *testing.T, f *argocd.InfraFacts, service string) string {
		t.Helper()
		for _, d := range argocd.InfraServiceDecisions(f) {
			if d.Service == service {
				return d.Status
			}
		}
		t.Fatalf("no %q decision was produced", service)
		return ""
	}

	for _, dnsEnabled := range []bool{true, false} {
		for _, domain := range []string{"example.com", ""} {
			for _, cert := range []string{certArn, ""} {
				for _, acl := range []string{wafArn, ""} {
					name := fmt.Sprintf("dns=%t domain=%q cert=%t acl=%t", dnsEnabled, domain, cert != "", acl != "")
					t.Run(name, func(t *testing.T) {
						resetDeploySeams(t)
						executeCommandWithOutput = func(string, string, []string) (string, error) { return "existing-auth", nil }
						var commands []string
						executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
							commands = append(commands, command)
							return nil
						}
						vc := &types.ProjectConfig{DNS: types.ProjectDNSConfig{Enabled: dnsEnabled, DomainName: domain}}
						outputs := map[string]interface{}{}
						if cert != "" {
							outputs["acm_certificate_arn"] = cert
						}
						if acl != "" {
							outputs["waf_webacl_arn"] = acl
						}
						if err := installArgoCD(context.Background(), vc, outputs, &PlanResult{}, io.Discard, io.Discard); err != nil {
							t.Fatalf("installArgoCD: %v", err)
						}
						if len(commands) == 0 {
							t.Fatal("no commands executed")
						}
						install := commands[len(commands)-1]

						// The facts the runner would build from the same deploy.
						f := &argocd.InfraFacts{
							Provider: "aws", DNSEnabled: dnsEnabled, DomainName: domain,
							ACMCertificateArn: cert, WAFWebACLArn: acl,
						}

						emittedIngress := strings.Contains(install, "server.ingress.enabled=true")
						reportedURL := decisionStatus(t, f, "argocd-url") == "installed"
						if emittedIngress != reportedURL {
							t.Errorf("argocd-url decision (%t) disagrees with the emitted ingress (%t)\n%s",
								reportedURL, emittedIngress, install)
						}

						emittedWAF := strings.Contains(install, "wafv2-acl-arn")
						reportedWAF := decisionStatus(t, f, "waf") == "installed"
						if emittedWAF != reportedWAF {
							t.Errorf("waf decision (%t) disagrees with the emitted annotation (%t)\n%s",
								reportedWAF, emittedWAF, install)
						}
					})
				}
			}
		}
	}
}

// TestInstallArgoCDGKEIngress is the GCP half of "the canvas switch reaches something".
//
// GKE needs no ingress CONTROLLER — Google's runs in the managed control plane — so unlike AWS
// there is no Application to assert. What must be proven instead is that the two references the
// template now exports actually leave the runner: the Google-managed certificate onto a `gce`
// Ingress, and the Cloud Armor policy onto a BackendConfig bound to the ArgoCD server Service.
//
// The values reach helm as a FILE rather than `--set` flags, because the backend-config
// annotation's value is the JSON document {"default":"argocd-server"} and helm's --set parser
// reads a leading `{` as a list literal. The file is read back here, inside the fake executor,
// while it still exists — asserting the flag alone would prove only that a path was interpolated.
func TestInstallArgoCDGKEIngress(t *testing.T) {
	const policy = "alethia-nl-production-armor-policy"

	// run drives installArgoCD with the given outputs and returns every command it issued, the
	// contents of the per-cloud INGRESS values file (empty when none was rendered), the resulting
	// ArgocdURL, and the contents of EVERY values file the helm command referenced.
	//
	// The last two used to be one value. They had to split when the install started carrying the
	// unconditional probe values as well: "a `-f` was passed" no longer means "an ingress was
	// rendered", so the cases that assert on absence need the whole set, by content.
	run := func(t *testing.T, outputs map[string]interface{}) (cmds []string, values string, url string, allValues []string) {
		t.Helper()
		resetDeploySeams(t)
		executeCommandWithOutput = func(string, string, []string) (string, error) { return "existing-auth", nil }
		executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
			cmds = append(cmds, command)
			// Read any -f'd values file NOW: installArgoCD removes its temp dir on return, so a
			// read after the call would only ever say "no such file". `values` is the INGRESS one
			// specifically — "" when none was rendered, which several cases assert — while
			// `allValues` is every file, for the cases that assert on what is ABSENT.
			if i := strings.Index(command, "helm upgrade --install argo-cd"); i == 0 {
				allValues = argoValuesFiles(t, command)
				values = argoIngressValues(t, command)
			}
			return nil
		}
		// Seeded for every case: the GKE case now keys on a cluster plus cert-manager's readiness,
		// not on a certificate output. Individual cases still add/omit the armor policy.
		for k, v := range map[string]interface{}{
			"gke_cluster_name":             "gke-demo",
			"external_dns_service_account": "edns@demo.iam.gserviceaccount.com",
			"gcp_project_id":               "demo",
			"cloud_dns_zone_name":          "demo-zone",
		} {
			if _, ok := outputs[k]; !ok {
				outputs[k] = v
			}
		}
		result := &PlanResult{}
		// ManagedCertificate is the ASK cert-manager gates on; the gcp solver additionally needs
		// the external-dns identity, the project and the zone NAME (its dns.admin grant is
		// zone-scoped). `run` seeds those in `outputs` below.
		vc := &types.ProjectConfig{
			Provider: "gcp",
			DNS:      types.ProjectDNSConfig{Enabled: true, DomainName: "example.com", ManagedCertificate: true},
		}
		if err := installArgoCD(context.Background(), vc, outputs, result, io.Discard, io.Discard); err != nil {
			t.Fatalf("installArgoCD: %v", err)
		}
		return cmds, values, result.ArgocdURL, allValues
	}

	t.Run("certificate + policy: gce ingress, BackendConfig applied before helm", func(t *testing.T) {
		cmds, values, url, _ := run(t, map[string]interface{}{
			"cloud_armor_policy_name": policy,
		})
		if url != "https://argocd.example.com" {
			t.Errorf("ArgocdURL = %q", url)
		}
		for _, want := range []string{
			"ingressClassName: gce",
			"hostname: argocd.example.com",
			"tls: true",
			`cert-manager.io/cluster-issuer: "` + argocd.CertManagerIssuerName + `"`,
			`cloud.google.com/backend-config: '{"default":"` + argocd.GKEBackendConfigName + `"}'`,
		} {
			if !strings.Contains(values, want) {
				t.Errorf("helm values missing %q:\n%s", want, values)
			}
		}
		// ORDER is the point, not merely presence: the BackendConfig must exist before the chart
		// creates the Service that names it, or the load balancer is programmed once with no
		// security policy on it — the exact window this lane closes.
		applyIdx, helmIdx := -1, -1
		for i, c := range cmds {
			if strings.HasPrefix(c, "kubectl apply -f") && strings.Contains(c, "backendconfig.yaml") {
				applyIdx = i
			}
			if strings.HasPrefix(c, "helm upgrade --install argo-cd") {
				helmIdx = i
			}
		}
		if applyIdx < 0 {
			t.Fatalf("no BackendConfig apply issued:\n%v", cmds)
		}
		if helmIdx < 0 || applyIdx > helmIdx {
			t.Errorf("BackendConfig applied at %d, helm install at %d — it must come first", applyIdx, helmIdx)
		}
	})

	t.Run("WAF off: ingress intact, no BackendConfig anywhere", func(t *testing.T) {
		cmds, values, url, _ := run(t, map[string]interface{}{
			// null is the shape tofu emits when cloud_armor_enabled is false; it must behave
			// exactly like an absent key.
			"cloud_armor_policy_name": nil,
		})
		if url != "https://argocd.example.com" {
			t.Errorf("the ingress must still be configured with the WAF off, ArgocdURL = %q", url)
		}
		if !strings.Contains(values, "ingressClassName: gce") {
			t.Errorf("lost the ingress when the WAF switch was off:\n%s", values)
		}
		if strings.Contains(values, "backend-config") {
			t.Errorf("values name a BackendConfig with no Cloud Armor policy — GKE would stall on it:\n%s", values)
		}
		for _, c := range cmds {
			if strings.Contains(c, "backendconfig.yaml") {
				t.Errorf("applied a BackendConfig with no policy: %s", c)
			}
		}
	})

	t.Run("cert-manager cannot issue: no ingress, no URL, no BackendConfig", func(t *testing.T) {
		// A Cloud Armor policy with no way to get TLS must NOT produce a half-configured ingress.
		// The GKE Ingress sets allow-http=false, so one rendered without a certificate serves
		// NOTHING rather than falling back to plaintext — worse than not rendering it.
		//
		// The blocker here is the solver, not a certificate output: dropping the external-dns
		// identity makes CertManagerSolver return "" on gcp, so CertManagerEnabled is false. That
		// is the same arm the decision's skip reason reports, so the two cannot disagree.
		cmds, values, url, allValues := run(t, map[string]interface{}{
			"cloud_armor_policy_name":      policy,
			"external_dns_service_account": nil,
		})
		if url != "" {
			t.Errorf("ArgocdURL = %q, want empty when nothing can issue a certificate", url)
		}
		if values != "" {
			t.Errorf("rendered ingress values with no way to get TLS:\n%s", values)
		}
		// `-f` alone no longer means "an ingress was rendered": every install carries the
		// unconditional values files (argocd.InstallProbeValues, argocd.InstallResourceValues). So
		// the assertion is on the CONTENT — exactly those files, and nothing else.
		if want := argoUnconditionalValues(); !slices.Equal(allValues, want) {
			t.Errorf("helm received %d values file(s) with no way to get TLS, want only the %d unconditional ones:\n%#v", len(allValues), len(want), allValues)
		}
		for _, c := range cmds {
			if strings.Contains(c, "backendconfig.yaml") {
				t.Errorf("applied a BackendConfig for an ingress that was never rendered: %s", c)
			}
		}
	})

	// The AWS path must be completely unaffected by the new branch: its outputs are disjoint from
	// GCP's, and a deploy carrying an ACM certificate must still get the ALB `--set` chain.
	t.Run("aws is untouched by the gcp branch", func(t *testing.T) {
		cmds, values, _, allValues := run(t, map[string]interface{}{
			"acm_certificate_arn": "arn:aws:acm:us-east-1:111111111111:certificate/abc",
		})
		if values != "" {
			t.Errorf("aws must not use a values file:\n%s", values)
		}
		// Same content-level assertion as the case above: the AWS path drives its ingress purely
		// through `--set`, so the ONLY values files it may carry are the unconditional ones.
		if want := argoUnconditionalValues(); !slices.Equal(allValues, want) {
			t.Errorf("aws install received %d values file(s), want only the %d unconditional ones:\n%#v", len(allValues), len(want), allValues)
		}
		install := cmds[len(cmds)-1]
		if !strings.Contains(install, "server.ingress.ingressClassName=alb") {
			t.Errorf("aws lost its ALB ingress:\n%s", install)
		}
	})
}

// TestArgocdURLDecisionMatchesWhatInstallArgoCDEmitsOnAzure is the Azure half of the invariant the
// AWS test above pins, and it exists because that one cannot cover this cloud: it drives the ACM
// certificate output, and Azure exports no certificate at all (#1825 deleted the App Service order,
// a purchased product that bound to nothing). Without this, flipping argocdURLGates["azure"] off
// its constant-false predicate would be asserted by nothing.
//
// The invariant is the same one #1831 broke: a gate that reports an ingress must agree with the
// emitter on EVERY term, not a convenient subset. Azure has four — DNS, a domain, the Application
// Gateway, and cert-manager being able to issue — so the matrix drives all four independently and
// asserts the decision equals the emission in all 16 shapes.
func TestArgocdURLDecisionMatchesWhatInstallArgoCDEmitsOnAzure(t *testing.T) {
	for _, dnsEnabled := range []bool{true, false} {
		for _, domain := range []string{"example.com", ""} {
			for _, gw := range []string{"agw-weu-development-demo", ""} {
				// The solver's per-cloud identity requirement, driven through the ONE output that
				// gates it on Azure. The other three facts CertManagerSolver needs come from the
				// config below, so toggling this alone flips CertManagerEnabled().
				for _, edns := range []string{"client-id", ""} {
					name := fmt.Sprintf("dns=%t domain=%q gw=%t certmgr=%t", dnsEnabled, domain, gw != "", edns != "")
					t.Run(name, func(t *testing.T) {
						resetDeploySeams(t)
						executeCommandWithOutput = func(string, string, []string) (string, error) { return "existing-auth", nil }
						var commands []string
						var values string
						executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
							commands = append(commands, command)
							// Read the values file NOW — installArgoCD removes its temp dir on return.
							// The INGRESS one specifically: the install also carries the
							// unconditional probe values, and "" here means "no ingress".
							if strings.HasPrefix(command, "helm upgrade --install argo-cd") {
								values = argoIngressValues(t, command)
							}
							return nil
						}

						vc := &types.ProjectConfig{
							Provider:       "azure",
							CloudAccountID: "00000000-0000-0000-0000-000000000001",
							DNS: types.ProjectDNSConfig{
								Enabled: dnsEnabled, DomainName: domain, ManagedCertificate: true,
							},
						}
						outputs := map[string]interface{}{
							"resource_group_name": "rg-demo",
							"azure_tenant_id":     "00000000-0000-0000-0000-0000000000aa",
						}
						if gw != "" {
							outputs["application_gateway_name"] = gw
						}
						if edns != "" {
							outputs["external_dns_client_id"] = edns
						}

						if err := installArgoCD(context.Background(), vc, outputs, &PlanResult{}, io.Discard, io.Discard); err != nil {
							t.Fatalf("installArgoCD: %v", err)
						}
						if len(commands) == 0 {
							t.Fatal("no commands executed")
						}

						// The facts the runner builds from the SAME deploy — never hand-assembled,
						// so a fact-derivation bug cannot hide behind a hand-written fixture.
						f := argocd.BuildFromOutputs(outputs, vc)

						emitted := strings.Contains(values, "ingressClassName: "+argocd.AGWIngressClassName)
						reported := false
						for _, d := range argocd.InfraServiceDecisions(f) {
							if d.Service == "argocd-url" {
								reported = d.Status == "installed"
							}
						}
						if emitted != reported {
							t.Errorf("argocd-url decision (%t) disagrees with the emitted ingress (%t)\nvalues:\n%s", reported, emitted, values)
						}

						// When it IS emitted, the two things that make it a WORKING ingress rather
						// than a rendered one must both be present. `tls: true` is the whole TLS
						// contract with argo-cd 9.5.11 (there is no tlsSecret key), and without the
						// issuer annotation cert-manager never mints the Secret — the listener
						// would serve the gateway's default certificate forever, silently.
						if emitted {
							if !strings.Contains(values, "tls: true") {
								t.Errorf("emitted ingress has no `tls: true` — no TLS block is rendered at all:\n%s", values)
							}
							if !strings.Contains(values, "cert-manager.io/cluster-issuer: \""+argocd.CertManagerIssuerName+"\"") {
								t.Errorf("emitted ingress does not name the cert-manager ClusterIssuer:\n%s", values)
							}
							// AWS's WAF rides an annotation; Azure's policy is bound by the template
							// to the gateway. Emitting an AWS-shaped annotation here would be a
							// no-op AGIC ignores, and would suggest a binding that is not happening.
							if strings.Contains(values, "wafv2-acl-arn") {
								t.Errorf("Azure ingress must not carry the AWS WAF annotation:\n%s", values)
							}
						}
					})
				}
			}
		}
	}
}

// TestArgocdURLDecisionMatchesWhatInstallArgoCDEmitsOnGCP is the GCP half of the invariant, added
// when GCP converged onto cert-manager (#1858).
//
// It could not exist before: the old GCP gate keyed on `cloud_dns_managed_certificate_name`, an
// output that no longer exists, and the AWS invariant drives the ACM one. The shape it protects is
// #1831's — a gate that reports an ingress must agree with the emitter on EVERY term, not a
// convenient subset. GCP has four (DNS, a domain, a cluster, cert-manager being able to issue), so
// the matrix drives all four independently and asserts decision == emission in all 16 shapes.
func TestArgocdURLDecisionMatchesWhatInstallArgoCDEmitsOnGCP(t *testing.T) {
	for _, dnsEnabled := range []bool{true, false} {
		for _, domain := range []string{"example.com", ""} {
			for _, cluster := range []string{"gke-demo", ""} {
				// The gcp solver's identity requirement, driven through one output. The other facts
				// CertManagerSolver needs come from the config and outputs below, so toggling this
				// alone flips CertManagerEnabled().
				for _, edns := range []string{"edns@demo.iam.gserviceaccount.com", ""} {
					name := fmt.Sprintf("dns=%t domain=%q cluster=%t certmgr=%t", dnsEnabled, domain, cluster != "", edns != "")
					t.Run(name, func(t *testing.T) {
						resetDeploySeams(t)
						executeCommandWithOutput = func(string, string, []string) (string, error) { return "existing-auth", nil }
						var commands []string
						var values string
						executeCommand = func(command, _ string, _ []string, _, _ io.Writer) error {
							commands = append(commands, command)
							// Read the values file NOW — installArgoCD removes its temp dir on return.
							// The INGRESS one specifically: the install also carries the
							// unconditional probe values, and "" here means "no ingress".
							if strings.HasPrefix(command, "helm upgrade --install argo-cd") {
								values = argoIngressValues(t, command)
							}
							return nil
						}

						vc := &types.ProjectConfig{
							Provider: "gcp",
							DNS: types.ProjectDNSConfig{
								Enabled: dnsEnabled, DomainName: domain, ManagedCertificate: true,
							},
						}
						outputs := map[string]interface{}{
							"gcp_project_id":      "demo",
							"cloud_dns_zone_name": "demo-zone",
						}
						if cluster != "" {
							outputs["gke_cluster_name"] = cluster
						}
						if edns != "" {
							outputs["external_dns_service_account"] = edns
						}

						if err := installArgoCD(context.Background(), vc, outputs, &PlanResult{}, io.Discard, io.Discard); err != nil {
							t.Fatalf("installArgoCD: %v", err)
						}
						if len(commands) == 0 {
							t.Fatal("no commands executed")
						}

						// Facts built from the SAME deploy — never hand-assembled, so a
						// fact-derivation bug cannot hide behind a hand-written fixture.
						f := argocd.BuildFromOutputs(outputs, vc)

						emitted := strings.Contains(values, "ingressClassName: gce")
						reported := false
						for _, d := range argocd.InfraServiceDecisions(f) {
							if d.Service == "argocd-url" {
								reported = d.Status == "installed"
							}
						}
						if emitted != reported {
							t.Errorf("argocd-url decision (%t) disagrees with the emitted ingress (%t)\nvalues:\n%s", reported, emitted, values)
						}

						if emitted {
							// `tls: true` is the whole TLS contract with argo-cd 9.5.11, and without
							// the issuer annotation cert-manager never mints the Secret. With
							// allow-http=false the Ingress would then serve NOTHING — not plaintext
							// — which is a silent outage rather than a downgrade.
							if !strings.Contains(values, "tls: true") {
								t.Errorf("emitted ingress has no `tls: true` — no TLS block is rendered at all:\n%s", values)
							}
							if !strings.Contains(values, "cert-manager.io/cluster-issuer: \""+argocd.CertManagerIssuerName+"\"") {
								t.Errorf("emitted ingress does not name the cert-manager ClusterIssuer:\n%s", values)
							}
							if !strings.Contains(values, `kubernetes.io/ingress.allow-http: "false"`) {
								t.Errorf("emitted ingress lost allow-http=false — it would answer plaintext :80 while cert-manager is still issuing:\n%s", values)
							}
							// The resource this named was deleted with #1858, and Google documents
							// Secrets and pre-shared certs as separate options, not complementary.
							if strings.Contains(values, "pre-shared-cert") {
								t.Errorf("emitted ingress still carries the pre-shared-cert annotation:\n%s", values)
							}
						}
					})
				}
			}
		}
	}
}
