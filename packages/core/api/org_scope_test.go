// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The header is the whole mechanism, so it is asserted on a REAL request rather than by calling
// resolveOrgScope directly: what has to be true is that `X-Alethia-Org` arrives at the server, and
// a unit test of the resolver would pass just as happily if setAuthHeaders stopped calling it.

// orgScopeHeader drives one request through the client and returns the X-Alethia-Org it carried.
func orgScopeHeader(t *testing.T) string {
	t.Helper()
	got := ""
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("X-Alethia-Org")
		json.NewEncoder(w).Encode(map[string]any{"runners": []any{}})
	}))
	if _, err := client.GetRunners(); err != nil {
		t.Fatalf("GetRunners: %v", err)
	}
	return got
}

func TestSetAuthHeaders_OrgScope(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Cleanup(func() { SetOrgOverride("") })

	// No override, no active org: the header is absent rather than empty. An empty header would
	// still be a header, and the control plane treats a present one as a scope request.
	SetOrgOverride("")
	if got := orgScopeHeader(t); got != "" {
		t.Errorf("with nothing in scope the header must not be sent, got %q", got)
	}

	// The persisted active org, which is where the header came from before --org existed.
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "cfg-org"}); err != nil {
		t.Fatal(err)
	}
	if got := orgScopeHeader(t); got != "cfg-org" {
		t.Errorf("expected the active org, got %q", got)
	}

	// The override OUTRANKS it. Asserted against a config that names a DIFFERENT org, because
	// against an empty one this arm would pass even if the override were being ignored.
	SetOrgOverride("flag-org")
	if got := orgScopeHeader(t); got != "flag-org" {
		t.Errorf("--org must outrank the persisted active org, got %q", got)
	}
	if got := OrgOverride(); got != "flag-org" {
		t.Errorf("OrgOverride() = %q — members/teams read the path org from here, so it must be "+
			"the same value the header carries", got)
	}

	// Blank is not a value. `--org ""` and `--org "  "` clear the override rather than sending a
	// blank scope, which the server would read as a request for an org named "".
	SetOrgOverride("   ")
	if got := OrgOverride(); got != "" {
		t.Errorf("a blank --org must clear the override, got %q", got)
	}
	if got := orgScopeHeader(t); got != "cfg-org" {
		t.Errorf("a blank --org must fall back to the active org, got %q", got)
	}
}
