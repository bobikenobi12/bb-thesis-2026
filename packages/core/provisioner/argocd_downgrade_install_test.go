// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What installArgoCD DOES with the downgrade verdict (#3521).
//
// The decision half is table-tested in argocd/version_preflight_test.go and cannot see this: a
// decision that names the right chart and a caller that ignores it are individually green. These
// tests drive the real installArgoCD against stubbed `kubectl` and `helm` binaries and assert the
// command it BUILT — because "which version reaches `helm --version`" is the entire behaviour
// change, and the operator-facing message is exactly what would make a wrong one look right.
package provisioner

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// stubArgoProbes puts a `kubectl` and a `helm` on PATH that answer the two preflight probes and
// nothing else. Anything unasked-for exits non-zero, so a run that took an unexpected path fails
// for its own reason rather than quietly passing.
func stubArgoProbes(t *testing.T, liveVersion, helmListJSON string) {
	t.Helper()
	dir := t.TempDir()

	live := `{"kind":"List","items":[{"kind":"StatefulSet","metadata":{"name":"argocd-application-controller"},` +
		`"spec":{"template":{"spec":{"containers":[{"image":"quay.io/argoproj/argocd:` + liveVersion + `"}]}}}}]}`
	body := filepath.Join(dir, "live.json")
	if err := os.WriteFile(body, []byte(live), 0o600); err != nil {
		t.Fatalf("write kubectl stub body: %v", err)
	}
	helmBody := filepath.Join(dir, "helm.json")
	if err := os.WriteFile(helmBody, []byte(helmListJSON), 0o600); err != nil {
		t.Fatalf("write helm stub body: %v", err)
	}

	kubectl := "#!/bin/sh\ncase \"$*\" in\n" +
		"  *'get statefulsets.apps,deployments.apps'*) cat '" + body + "'; exit 0;;\n" +
		"esac\nexit 0\n"
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(kubectl), 0o755); err != nil {
		t.Fatalf("write kubectl stub: %v", err)
	}
	helm := "#!/bin/sh\ncase \"$*\" in\n" +
		"  *list*) cat '" + helmBody + "'; exit 0;;\n" +
		"esac\nexit 7\n"
	if err := os.WriteFile(filepath.Join(dir, "helm"), []byte(helm), 0o755); err != nil {
		t.Fatalf("write helm stub: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// recordArgoCommands captures every shelled command instead of running it. It returns the slice the
// assertions read; the seam is restored by t.Cleanup.
func recordArgoCommands(t *testing.T) *[]string {
	t.Helper()
	origExec := executeCommand
	origExecOut := executeCommandWithOutput
	var seen []string
	executeCommand = func(cmd, _ string, _ []string, _, _ io.Writer) error {
		seen = append(seen, cmd)
		return nil
	}
	executeCommandWithOutput = func(cmd, _ string, _ []string) (string, error) {
		seen = append(seen, cmd)
		return "", nil
	}
	t.Cleanup(func() {
		executeCommand = origExec
		executeCommandWithOutput = origExecOut
	})
	return &seen
}

// helmUpgradeIn returns the `helm upgrade --install argo-cd` command from a recording, or "".
func helmUpgradeIn(cmds []string) string {
	for _, c := range cmds {
		if strings.Contains(c, "helm upgrade --install argo-cd") {
			return c
		}
	}
	return ""
}

// A cluster NEWER than the pin, installed by the helm release we know: the deploy must install the
// RUNNING chart, so its values are applied and its ArgoCD version does not move.
func TestInstallArgoCDInstallsTheRunningChartRatherThanDowngrading(t *testing.T) {
	stubArgoProbes(t, "v3.5.0",
		`[{"name":"argo-cd","namespace":"argocd","revision":"3","status":"deployed",`+
			`"chart":"argo-cd-9.9.1","app_version":"v3.5.0"}]`)
	seen := recordArgoCommands(t)

	var result PlanResult
	if err := installArgoCD(t.Context(), newLocalProjectConfig("alethia", "argo"), nil, &result, io.Discard, io.Discard); err != nil {
		t.Fatalf("a newer in-window ArgoCD must not fail the deploy: %v", err)
	}

	upgrade := helmUpgradeIn(*seen)
	if upgrade == "" {
		t.Fatalf("no helm upgrade was built at all; commands were %v", *seen)
	}
	// The ASSERTION THAT MATTERS. Both halves: the running chart is passed, and the pin is not.
	// Checking only the first would pass an implementation that appended both.
	// The version reaches the command SHELL-QUOTED (utils.ShellQuote), so the quotes are part of
	// the assertion: matching the bare number would also match a `--version 9.9.1.something`.
	if !strings.Contains(upgrade, "--version '9.9.1'") {
		t.Errorf("want the RUNNING chart 9.9.1 on the upgrade, got: %s", upgrade)
	}
	if strings.Contains(upgrade, "--version '"+defaultArgoChartForTest()+"'") {
		t.Errorf("the pinned chart must NOT be installed over a newer cluster: %s", upgrade)
	}
}

// The same cluster, with no helm release to install against: nothing may be applied, and the deploy
// still succeeds. Skipping is not a failure — it is the only option that does not move the version.
func TestInstallArgoCDSkipsTheChartWhenHelmNamesNoRelease(t *testing.T) {
	stubArgoProbes(t, "v3.5.0", `[]`)
	seen := recordArgoCommands(t)

	var out strings.Builder
	var result PlanResult
	if err := installArgoCD(t.Context(), newLocalProjectConfig("alethia", "argo"), nil, &result, &out, io.Discard); err != nil {
		t.Fatalf("skipping the chart is not a deploy failure: %v", err)
	}

	if upgrade := helmUpgradeIn(*seen); upgrade != "" {
		t.Errorf("no chart may be installed here — installing the pin IS the downgrade. Got: %s", upgrade)
	}
	// It must also not have touched the cluster on the way to deciding that: `helm repo add` and
	// the redis secret both run BEFORE the install and would be side effects of a skipped install.
	for _, c := range *seen {
		if strings.Contains(c, "helm repo add") || strings.Contains(c, "create namespace") {
			t.Errorf("a skipped install must not leave side effects behind: %s", c)
		}
	}
	// And the operator must be told what went unapplied, or a green deploy reads as a configured
	// ArgoCD. This is the sentence that stops that.
	if !strings.Contains(out.String(), "NOT APPLIED") {
		t.Errorf("stdout must name what went unapplied, got: %s", out.String())
	}
}

// A cluster at or below the pin is untouched by any of this: the ordinary install still runs with
// the pinned chart. Without this the two tests above would pass against an implementation that
// never installed the pin at all.
func TestInstallArgoCDStillInstallsThePinOnAnOlderCluster(t *testing.T) {
	stubArgoProbes(t, "v3.3.9",
		`[{"name":"argo-cd","namespace":"argocd","chart":"argo-cd-9.5.11","app_version":"v3.3.9"}]`)
	seen := recordArgoCommands(t)

	var result PlanResult
	if err := installArgoCD(t.Context(), newLocalProjectConfig("alethia", "argo"), nil, &result, io.Discard, io.Discard); err != nil {
		t.Fatalf("an in-window cluster at the pin must install normally: %v", err)
	}
	upgrade := helmUpgradeIn(*seen)
	if upgrade == "" {
		t.Fatalf("the ordinary install must still run; commands were %v", *seen)
	}
	if !strings.Contains(upgrade, "--version '"+defaultArgoChartForTest()+"'") {
		t.Errorf("want the pinned chart %s, got: %s", defaultArgoChartForTest(), upgrade)
	}
}

// defaultArgoChartForTest reads the shipped pin rather than restating it, so a chart bump does not
// silently turn these assertions into tests of a version nothing installs.
func defaultArgoChartForTest() string { return argocd.ResolvedArgoChartVersion() }
