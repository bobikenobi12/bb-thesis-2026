// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// TestReadDataEndpointsRefusesShellMetacharactersInNamespace is #2020's repro, kept.
//
// AddOnInstall.Namespace rides the DEPLOY job's config snapshot and was interpolated straight into
// a kubectl command string that utils.ExecuteCommand runs via `bash -c`. A tampered snapshot or a
// catalog bug therefore executed arbitrary commands as the runner — which holds the cluster
// kubeconfig and the job's cloud credentials.
//
// This asserts the side effect, not the log line: the marker file is what proves the shell ran.
func TestReadDataEndpointsRefusesShellMetacharactersInNamespace(t *testing.T) {
	work := t.TempDir()
	marker := filepath.Join(work, "pwned")

	// A `kubectl` that succeeds and prints valid-but-empty JSON, so nothing but the injection can
	// make this test fail.
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "kubectl"),
		[]byte("#!/bin/sh\necho '{\"items\":[]}'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	addons := []types.AddOnInstall{{
		ID:        "db-primary",
		Mode:      "managed",
		Namespace: "default; touch " + marker + "; #",
	}}

	var stderr strings.Builder
	_ = ReadDataEndpoints(addons, io.Discard, &stderr)

	if _, err := os.Stat(marker); err == nil {
		t.Fatalf("COMMAND INJECTION: the namespace's payload executed — %s was created\nstderr:\n%s", marker, stderr.String())
	}
	if !strings.Contains(stderr.String(), "not a valid kubernetes name") {
		t.Errorf("the add-on was skipped, but not with the refusal warning that tells an operator why:\n%s", stderr.String())
	}
}

// TestReadDataEndpointsRefusesShellMetacharactersInAddOnID covers the other interpolated identifier.
// The release name is derived from the add-on id, so a hostile id reaches the same command.
func TestReadDataEndpointsRefusesShellMetacharactersInAddOnID(t *testing.T) {
	work := t.TempDir()
	marker := filepath.Join(work, "pwned-id")

	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "kubectl"),
		[]byte("#!/bin/sh\necho '{\"items\":[]}'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	addons := []types.AddOnInstall{{
		ID:        "db-primary; touch " + marker + "; #",
		Mode:      "managed",
		Namespace: "default",
	}}

	var stderr strings.Builder
	_ = ReadDataEndpoints(addons, io.Discard, &stderr)

	if _, err := os.Stat(marker); err == nil {
		t.Fatalf("COMMAND INJECTION via the add-on id — %s was created\nstderr:\n%s", marker, stderr.String())
	}
}

// TestReadOneEndpointRefusesUnvalidatedIdentifiers pins the restated check in the readers
// themselves. ReadDataEndpoints refuses these first, so without this test the inner guards could be
// deleted and everything above would stay green — and the next caller would reach the shell.
func TestReadOneEndpointRefusesUnvalidatedIdentifiers(t *testing.T) {
	bin := t.TempDir()
	// This kubectl FAILS the test if it is ever reached: the guard must return before exec.
	if err := os.WriteFile(filepath.Join(bin, "kubectl"),
		[]byte("#!/bin/sh\necho REACHED >&2\necho '{\"items\":[]}'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	bad := []struct{ release, namespace string }{
		{"rel; id", "default"},
		{"rel", "ns$(id)"},
		{"rel", "ns`id`"},
		{"rel", "-leading-hyphen"},
		{"rel", "UPPER"}, // k8s names are lowercase; uppercase means it did not come from the resolver
		{"", "default"},
		{"rel", ""},
	}
	for _, c := range bad {
		var stderr strings.Builder
		if _, ok := readOneEndpoint(c.release, c.namespace, "addon-"+c.release, &stderr); ok {
			t.Errorf("readOneEndpoint(%q, %q) = ok; want refused", c.release, c.namespace)
		}
		if got := readSecretRef(c.release, c.namespace, "addon-"+c.release, &stderr); got != "" {
			t.Errorf("readSecretRef(%q, %q) = %q; want empty", c.release, c.namespace, got)
		}
		if strings.Contains(stderr.String(), "REACHED") {
			t.Errorf("readers shelled out for (%q, %q) instead of refusing", c.release, c.namespace)
		}
	}
}
