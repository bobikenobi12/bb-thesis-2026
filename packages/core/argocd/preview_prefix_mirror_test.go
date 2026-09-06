// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The namespace-prefix rule is written twice — here and in the console form — and they must not
// disagree. Same reasoning as apps_path_mirror_test.go, and the same asymmetry: the dangerous
// direction is the CONSOLE being looser, because a prefix the form accepts and the renderer then
// refuses is a preview that fails after the user was told the value was fine. It was looser: the
// console's rule was `^[a-z0-9-]+$` with a message calling it "a DNS-1123 label prefix", accepting
// `-`, `--` and `a-`.
//
// A hand-mirrored constant is drift detection at best, so the drift has to be detected by
// something rather than by someone reading the two side by side.

package argocd

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

const previewPrefixMirror = "apps/console/lib/validations/preview.ts"

var (
	tsPreviewLabelRe  = regexp.MustCompile(`const DNS1123_LABEL\s*=\s*/(.+?)/;`)
	tsPreviewMaxLenRe = regexp.MustCompile(`const PREVIEW_PREFIX_MAX_LEN\s*=\s*(\d+);`)
)

func TestPreviewPrefixRuleMirrorsTheConsole(t *testing.T) {
	// appsPathMirrorRoot walks up to go.work; "" outside a monorepo checkout, where there is no
	// console to mirror. Reused rather than copied.
	root := appsPathMirrorRoot(t)
	if root == "" {
		t.Skip("not a monorepo checkout — no console to mirror")
	}
	raw, err := os.ReadFile(filepath.Join(root, previewPrefixMirror))
	if err != nil {
		t.Fatalf("read %s: %v", previewPrefixMirror, err)
	}
	src := string(raw)

	label := tsPreviewLabelRe.FindStringSubmatch(src)
	if label == nil {
		t.Fatalf("%s: could not find DNS1123_LABEL — the shape changed; update tsPreviewLabelRe rather than deleting this test", previewPrefixMirror)
	}
	if got, want := label[1], dns1123Label.String(); got != want {
		t.Errorf("namespace-prefix grammar has drifted.\n  console (%s): %s\n  Go (authority):        %s\n"+
			"A console pattern LOOSER than this one accepts a prefix the renderer then refuses.",
			previewPrefixMirror, got, want)
	}

	maxLen := tsPreviewMaxLenRe.FindStringSubmatch(src)
	if maxLen == nil {
		t.Fatalf("%s: could not find PREVIEW_PREFIX_MAX_LEN — the shape changed; update tsPreviewMaxLenRe", previewPrefixMirror)
	}
	if got, want := maxLen[1], fmt.Sprint(previewPrefixMaxLen); got != want {
		t.Errorf("prefix length bound has drifted: console says %s, Go says %s", got, want)
	}
}

// The mirror proves the two constants agree. This proves the constant Go actually ENFORCES is the
// one being mirrored — otherwise the pair could agree with each other and both disagree with the
// validator, which is the failure the mirror is supposed to make impossible. Same shape as
// TestAppsPathBoundIsTheOneEnforced.
func TestPreviewPrefixBoundIsTheOneEnforced(t *testing.T) {
	atBound := ""
	for len(atBound) < previewPrefixMaxLen {
		atBound += "a"
	}
	if err := validatePreviewNamespacePrefix("t", atBound); err != nil {
		t.Errorf("a prefix of exactly previewPrefixMaxLen (%d) was rejected: %v", previewPrefixMaxLen, err)
	}
	if err := validatePreviewNamespacePrefix("t", atBound+"a"); err == nil {
		t.Errorf("a prefix one over previewPrefixMaxLen (%d) was accepted", previewPrefixMaxLen)
	}
	// And the grammar constant is the one enforced, not merely the one mirrored.
	if err := validatePreviewNamespacePrefix("t", "-"); err == nil {
		t.Error("a lone dash was accepted; dns1123Label is not the pattern being enforced")
	}
}
