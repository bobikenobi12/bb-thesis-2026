// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func TestRunAddonList(t *testing.T) {
	ver := "1.2.3"
	c := &fakeClient{addons: &api.ProjectAddons{
		Environment: "production",
		Addons: []api.Addon{
			{AddonID: "kube-prometheus-stack", Enabled: true, Mode: "managed", Version: &ver, Status: "READY", Health: strptr("Healthy")},
			{AddonID: "cnpg", Enabled: false, Mode: "gitops", Status: "PENDING"},
		},
	}}
	var buf bytes.Buffer
	if err := runAddonList(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runAddonList: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"kube-prometheus-stack", "managed", "1.2.3", "READY", "cnpg", "gitops"} {
		if !strings.Contains(out, want) {
			t.Errorf("table output missing %q:\n%s", want, out)
		}
	}
}

func TestRunAddonListJSON(t *testing.T) {
	c := &fakeClient{addons: &api.ProjectAddons{Environment: "prod", Addons: []api.Addon{{AddonID: "x", Enabled: true, Mode: "managed", Status: "READY"}}}}
	var buf bytes.Buffer
	if err := runAddonList(c, &buf, "json", "proj", ""); err != nil {
		t.Fatalf("runAddonList json: %v", err)
	}
	if !strings.Contains(buf.String(), `"environment": "prod"`) || !strings.Contains(buf.String(), `"addon_id": "x"`) {
		t.Errorf("json output unexpected:\n%s", buf.String())
	}
}

func TestRunAddonListEmpty(t *testing.T) {
	c := &fakeClient{addons: &api.ProjectAddons{Environment: "prod", Addons: nil}}
	var buf bytes.Buffer
	if err := runAddonList(c, &buf, "table", "proj", ""); err != nil {
		t.Fatalf("runAddonList empty: %v", err)
	}
	if !strings.Contains(buf.String(), "No add-ons installed") {
		t.Errorf("expected empty notice, got: %q", buf.String())
	}
}

func TestRunAddonListError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runAddonList(c, &bytes.Buffer{}, "table", "proj", ""); err == nil {
		t.Error("expected error to propagate")
	}
}

// strOrDash renders nil/empty as the dash glyph and a value verbatim.
func TestStrOrDash(t *testing.T) {
	if ui.StrOrDash(nil) != ui.SymbolDash {
		t.Error("nil should be dash")
	}
	empty := ""
	if ui.StrOrDash(&empty) != ui.SymbolDash {
		t.Error("empty should be dash")
	}
	v := "x"
	if ui.StrOrDash(&v) != "x" {
		t.Error("value should pass through")
	}
}
