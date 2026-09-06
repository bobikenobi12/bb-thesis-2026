// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The per-invocation organization behind the CLI's global `--org` flag.
//
// Every control-plane request this client makes names the org it is acting in, as the
// `X-Alethia-Org` header. Until #3817 that org had exactly one source — the active context
// persisted by `alethia org switch` — so targeting another org for one listing meant moving the
// context every other terminal on the machine shares, and moving it back afterwards. Eleven docs
// pages independently claimed a `--org` override existed, which is evidence about what an operator
// expects to be able to type.
//
// # This widens no tenancy boundary
//
// The header is a REQUEST for a scope, never a grant of one, and the control plane has always
// treated it as one. Verified against apps/console/lib/authz/guard.ts (`authorizeCli`) and
// apps/console/lib/cli/auth.ts (`verifyCliToken`):
//
//   - A user token's header is honoured only AFTER `isOrgMember(userId, headerOrg)`. A non-member
//     is refused with 403, so naming an org in `--org` reaches nothing that `alethia org switch`
//     could not already reach.
//   - A SERVICE token's org is fixed at mint time and WINS. A conflicting header is a 403, not a
//     silent ignore — a pipeline is told it asked for the wrong tenant rather than being allowed to
//     believe it wrote to org B while every write landed in org A. That pin is enforced at the
//     token chokepoint as well as in the guard, so it also covers the routes that resolve their own
//     scope.
//   - With no header the behaviour is byte-for-byte what it was: the caller's default active scope.
//
// So what this changes is only WHICH org a request names, and it names one the operator typed
// rather than one they set earlier and forgot.
//
// A package-level value rather than a field on Client, for the same reason `serviceTokenFlag` is
// one in apps/cli/cmd: the flag is global, one process serves one invocation, and *Client is
// constructed at ~60 call sites that would otherwise each have to remember to pass it — a
// per-client field whose call sites can forget it is how a header comes to be sent on some requests
// and not others.
var orgOverride string

// SetOrgOverride records the organization this invocation is scoped to. An empty (or blank) value
// clears it, which is what every non-CLI consumer of this package leaves it as.
func SetOrgOverride(orgID string) { orgOverride = strings.TrimSpace(orgID) }

// OrgOverride returns the organization named for this invocation, or "" when none was.
//
// Exported because `members` and `teams` carry the org in their request PATH
// (`/api/cli/orgs/:id/members`) rather than only in the header, and they resolve it from this same
// value — one source, so the path and the header cannot come to name different orgs.
func OrgOverride() string { return orgOverride }

// resolveOrgScope returns the org to send as `X-Alethia-Org`: the per-invocation override when one
// was named, otherwise the active organization persisted in the CLI config.
func resolveOrgScope() string {
	if orgOverride != "" {
		return orgOverride
	}
	return types.LoadCliConfig().ActiveOrgID
}
