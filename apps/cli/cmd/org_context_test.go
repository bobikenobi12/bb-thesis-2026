// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

func TestCurrentOrgID(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Cleanup(func() { api.SetOrgOverride("") })

	// --org wins.
	api.SetOrgOverride("from-flag")
	if got, err := currentOrgID(); err != nil || got != "from-flag" {
		t.Errorf("expected from-flag, got %q (%v)", got, err)
	}

	// No flag, no config → error.
	api.SetOrgOverride("")
	if _, err := currentOrgID(); err == nil {
		t.Error("expected error with no active org")
	}

	// No flag, config active org → that org.
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "cfg-org"}); err != nil {
		t.Fatal(err)
	}
	if got, err := currentOrgID(); err != nil || got != "cfg-org" {
		t.Errorf("expected cfg-org, got %q (%v)", got, err)
	}

	// And the flag still outranks a config that now HAS an active org — the precedence, not just
	// the fallback. Asserted after the config is populated because that is the only ordering in
	// which the two sources disagree; with an empty config the first arm above would pass even if
	// the config were being read first.
	api.SetOrgOverride("from-flag")
	if got, err := currentOrgID(); err != nil || got != "from-flag" {
		t.Errorf("--org must outrank the persisted active org, got %q (%v)", got, err)
	}
}
