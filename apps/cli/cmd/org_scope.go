// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The one place the CLI decides which organization an invocation acts in.
//
// `--org` used to be registered on `members` and `teams` alone, because those two are the only
// commands that carry the org in their request PATH (`/api/cli/orgs/:id/members`). Everything else
// is scoped by the `X-Alethia-Org` header, which came from the persisted active context and from
// nowhere else — so `alethia cluster list --org acme` was refused as an unknown flag, on eleven
// pages that said it would work (#3817).
//
// Registering it on the root instead of adding it group by group is not a preference. Cobra
// resolves a flag to the NEAREST definition, so a `--org` on the root beside a `--org` on `members`
// would leave `members` reading a different variable from every other command — the same flag,
// spelled the same way, quietly meaning two things. There is one registration (shell_fields.go) and
// one value.

// orgFlag is the --org value, set by the ROOT command's persistent flag. Registered from the shell
// field spec in shell_fields.go, exactly as `--token` is; see serviceTokenFlag for why the value a
// person typed at THIS invocation outranks whatever is on disk.
var orgFlag string

// applyOrgScope hands the --org value to the API client, which sends it as `X-Alethia-Org` in place
// of the persisted active org.
//
// Called from the root's PersistentPreRun, which is the first thing that runs after cobra has
// parsed the flags and before any subcommand's Run. The root's is the only PersistentPreRun in the
// tree, and cobra runs only the nearest one, so a subcommand growing its own would silently stop
// applying this — hyg_cli_orgscope_test.go asserts that the root's is still the one that runs.
func applyOrgScope() { api.SetOrgOverride(orgFlag) }

// currentOrgID resolves the organization to name in a request PATH: the `--org` override when one
// was given, otherwise the active organization from the CLI config.
//
// It reads the override back from the api package rather than from orgFlag, deliberately. That is
// the same value setAuthHeaders sends in the header, so the org in the path and the org in the
// header are one value and cannot disagree — which is what made `--org` safe to promote from two
// commands to all of them.
func currentOrgID() (string, error) {
	if o := api.OrgOverride(); o != "" {
		return o, nil
	}
	if o := types.LoadCliConfig().ActiveOrgID; o != "" {
		return o, nil
	}
	return "", fmt.Errorf("no active organization — run `alethia org switch` or pass --org")
}
