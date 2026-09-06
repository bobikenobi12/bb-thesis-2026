// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func isolatedConfigHome(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("ALETHIA_WEB_ORIGIN", "")
}

func TestNormalizeWebOrigin(t *testing.T) {
	ok := map[string]string{
		"https://alethialabs.io":      "https://alethialabs.io",
		"https://dev.alethialabs.io/": "https://dev.alethialabs.io",
		"http://localhost:3000":       "http://localhost:3000",
	}
	for in, want := range ok {
		got, err := normalizeWebOrigin(in)
		if err != nil || got != want {
			t.Errorf("normalizeWebOrigin(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"not-a-url", "ftp://x.io", "", "://nope"} {
		if _, err := normalizeWebOrigin(bad); err == nil {
			t.Errorf("expected error for %q", bad)
		}
	}
}

func TestRunConfigSetAndGet(t *testing.T) {
	isolatedConfigHome(t)
	var buf bytes.Buffer

	if err := runConfigSet(&buf, "web-origin", "https://dev.alethialabs.io/"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if types.LoadCliConfig().WebOrigin != "https://dev.alethialabs.io" {
		t.Errorf("web-origin not persisted (trailing slash trimmed?)")
	}

	// Unknown key errors.
	if err := runConfigSet(&buf, "bogus", "x"); err == nil {
		t.Error("expected error for unknown key")
	}
	// Invalid URL errors.
	if err := runConfigSet(&buf, "web-origin", "nope"); err == nil {
		t.Error("expected error for invalid url")
	}

	buf.Reset()
	if err := runConfigGet(&buf, ui.FormatTable, "web-origin"); err != nil {
		t.Fatalf("get: %v", err)
	}
	if !strings.Contains(buf.String(), "https://dev.alethialabs.io") {
		t.Errorf("get web-origin: %q", buf.String())
	}

	buf.Reset()
	if err := runConfigGet(&buf, ui.FormatTable, ""); err != nil {
		t.Fatalf("get all: %v", err)
	}
	if !strings.Contains(buf.String(), "web-origin:") {
		t.Errorf("get all: %q", buf.String())
	}

	if err := runConfigGet(&buf, ui.FormatTable, "bogus"); err == nil {
		t.Error("expected error for unknown get key")
	}
}

// Writing the active org must not clobber a previously-set web-origin.
func TestSaveActiveOrgPreservesWebOrigin(t *testing.T) {
	isolatedConfigHome(t)
	if err := types.SaveCliConfig(types.CliConfig{WebOrigin: "https://dev.alethialabs.io"}); err != nil {
		t.Fatal(err)
	}
	if err := saveActiveOrg(api.OrgSummary{ID: "o1", Name: "Acme", Slug: "acme"}); err != nil {
		t.Fatal(err)
	}
	cfg := types.LoadCliConfig()
	if cfg.WebOrigin != "https://dev.alethialabs.io" {
		t.Errorf("web-origin clobbered by org switch: %+v", cfg)
	}
	if cfg.ActiveOrgID != "o1" {
		t.Errorf("active org not saved: %+v", cfg)
	}
}

func TestRunConfigShowSource(t *testing.T) {
	var buf bytes.Buffer
	if err := runConfigShow(&buf, "table", "https://alethialabs.io", types.WebOriginFromDefault, types.CliConfig{}, "/c", "/cfg"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "(default)") {
		t.Errorf("expected source annotation in: %q", buf.String())
	}
}

func TestPromptWebOriginNoInput(t *testing.T) {
	isolatedConfigHome(t)
	prev := noInputMode
	noInputMode = true
	defer func() { noInputMode = prev }()
	// With --no-input, returns the resolved origin without prompting.
	got, err := promptWebOrigin("")
	if err != nil || got != types.DefaultWebOrigin {
		t.Errorf("promptWebOrigin no-input = %q, %v; want default", got, err)
	}
}
