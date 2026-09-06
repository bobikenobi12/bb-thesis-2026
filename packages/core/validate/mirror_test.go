// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Two values in this package are restatements of constants that live — unexported — in the packages
// that actually enforce them. A restatement nobody checks is drift detection at best, so both are
// read out of their own source and compared here.
//
// Reading source as text is the same idiom argocd/apps_path_mirror_test.go already uses. Both files
// are in this module, so there is no "not a monorepo checkout" branch to skip on: if the file is
// missing, that is a failure and not a reason to pass.

package validate

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func readSibling(t *testing.T, parts ...string) string {
	t.Helper()
	path := filepath.Join(append([]string{".."}, parts...)...)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}

var reservedPrefixRe = regexp.MustCompile(`byoReservedVarPrefix\s*=\s*"([^"]*)"`)

// TestReservedTfvarPrefixMatchesTheProvisioner.
//
// provisioner.byoReservedVarPrefix is unexported, so rules.go states the literal. The console
// states it a third time (RESERVED_TFVAR_PREFIX). The conformance table binds this package to the
// console; this binds it to the runner, which is the surface that actually drops the variable.
func TestReservedTfvarPrefixMatchesTheProvisioner(t *testing.T) {
	src := readSibling(t, "provisioner", "byo_iac.go")
	m := reservedPrefixRe.FindStringSubmatch(src)
	if m == nil {
		t.Fatal("could not find byoReservedVarPrefix in provisioner/byo_iac.go — the shape changed; update reservedPrefixRe rather than deleting this test")
	}
	if m[1] != reservedTfvarPrefix {
		t.Errorf("reserved prefix drift: the provisioner uses %q, this package uses %q", m[1], reservedTfvarPrefix)
	}
}

// floorRe reads `<cloud>MaxNetworkPrefix = <expr>` where expr is `N` or `N - M` (alibaba is
// written as `32 - 4`, and rewriting it to 28 in the source is not this test's business).
var floorRe = regexp.MustCompile(`(?m)^\s*(aws|azure|gcp|hetzner|alibaba)MaxNetworkPrefix\s*=\s*(\d+)(?:\s*-\s*(\d+))?\s*$`)

// TestNetworkCIDRFloorsMatchTheApplyGate.
//
// The per-cloud floors are typed in the console (NETWORK_CIDR_MAX_PREFIX), projected into
// spec_gen.go as a RuleArg, and enforced for real by cloud.validateNetworkCIDR against constants
// this package cannot import. A CLI whose floor is TIGHTER than the gate's would refuse a network
// the apply accepts, which the invariant forbids — so the two are compared here rather than
// remembered.
func TestNetworkCIDRFloorsMatchTheApplyGate(t *testing.T) {
	src := readSibling(t, "cloud", "validate.go")
	found := map[string]int{}
	for _, m := range floorRe.FindAllStringSubmatch(src, -1) {
		base, err := strconv.Atoi(m[2])
		if err != nil {
			t.Fatalf("%sMaxNetworkPrefix: %v", m[1], err)
		}
		if m[3] != "" {
			sub, err := strconv.Atoi(m[3])
			if err != nil {
				t.Fatalf("%sMaxNetworkPrefix: %v", m[1], err)
			}
			base -= sub
		}
		found[m[1]] = base
	}
	if len(found) == 0 {
		t.Fatal("found no <cloud>MaxNetworkPrefix constants in cloud/validate.go — the shape changed; update floorRe rather than letting this test pass on an empty set")
	}

	// GCP deliberately has no floor: its template does not carve subnets out of the project network,
	// so validateNetworkCIDR is never called for it. The spec says so with 32 (nothing narrower than
	// a single address, i.e. nothing). If a gcpMaxNetworkPrefix ever appears, the spec is now too
	// permissive and this must be revisited rather than quietly kept.
	if got, ok := found["gcp"]; ok {
		t.Errorf("cloud/validate.go now declares gcpMaxNetworkPrefix = %d; the gcp spec still claims no floor", got)
	}

	checked := 0
	for cloud, floor := range found {
		spec, ok := Get("network_cidr_block." + cloud)
		if !ok {
			t.Errorf("cloud/validate.go enforces a floor for %q but there is no spec for it — the console form checks nothing there", cloud)
			continue
		}
		arg, err := ruleArgOf(spec, "network_cidr_max_prefix")
		if err != nil {
			t.Errorf("%s: %v", cloud, err)
			continue
		}
		if arg != floor {
			t.Errorf("%s floor drift: the apply gate allows /%d or wider, the generated spec says /%d. "+
				"A spec TIGHTER than the gate refuses a network the apply accepts.", cloud, floor, arg)
		}
		checked++
	}
	if checked == 0 {
		t.Fatal("compared zero floors")
	}

	// gcp is not in `found`, so it is checked separately rather than skipped silently.
	gcp, ok := Get("network_cidr_block.gcp")
	if !ok {
		t.Fatal("no network_cidr_block.gcp spec")
	}
	arg, err := ruleArgOf(gcp, "network_cidr_max_prefix")
	if err != nil {
		t.Fatalf("gcp: %v", err)
	}
	if arg != 32 {
		t.Errorf("the gcp spec carries a floor of /%d; with no gate constant behind it, anything below 32 refuses input the apply accepts", arg)
	}
}

// ruleArgOf returns the integer argument the named rule's step carries.
func ruleArgOf(spec Spec, rule string) (int, error) {
	for _, step := range spec.Steps {
		if step.Kind == StepRule && step.Rule == rule {
			if step.RuleArg == nil {
				return 0, fmt.Errorf("the %s step carries no RuleArg, so the rule abstains and the field is unchecked", rule)
			}
			return *step.RuleArg, nil
		}
	}
	return 0, fmt.Errorf("spec %q has no %s step", spec.ID, rule)
}

// TestTheConsoleStatesTheSameFloors reads the console's own table, so the three-way chain
// console -> generated spec -> apply gate has no unchecked link. Skipped nowhere: apps/console is
// in this repo, and its absence is a failure.
func TestTheConsoleStatesTheSameFloors(t *testing.T) {
	root := repoRoot(t)
	raw, err := os.ReadFile(filepath.Join(root, "apps", "console", "lib", "cloud-providers", "cidr.ts"))
	if err != nil {
		t.Fatalf("read the console's cidr table: %v", err)
	}
	tsFloorRe := regexp.MustCompile(`(?m)^\s*(aws|azure|gcp|hetzner|alibaba):\s*(\d+),`)
	matches := tsFloorRe.FindAllStringSubmatch(string(raw), -1)
	if len(matches) == 0 {
		t.Fatal("could not read NETWORK_CIDR_MAX_PREFIX out of the console — the shape changed; update tsFloorRe")
	}
	for _, m := range matches {
		want, err := strconv.Atoi(m[2])
		if err != nil {
			t.Fatalf("%s: %v", m[1], err)
		}
		spec, ok := Get("network_cidr_block." + m[1])
		if !ok {
			t.Errorf("the console states a floor for %q with no generated spec behind it", m[1])
			continue
		}
		arg, err := ruleArgOf(spec, "network_cidr_max_prefix")
		if err != nil {
			t.Errorf("%s: %v", m[1], err)
			continue
		}
		if arg != want {
			t.Errorf("%s: the console says /%d, the generated spec says /%d — regenerate", m[1], want, arg)
		}
	}
}

// repoRoot walks up to the monorepo root, identified by go.work.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("no go.work above %s", strings.TrimSpace(dir))
		}
		dir = parent
	}
}
