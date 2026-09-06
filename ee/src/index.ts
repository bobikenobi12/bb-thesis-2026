// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// Alethia Enterprise Edition entry point. `register(core)` runs once at app boot
// (via the core's allowlisted lib/enterprise.ts loader); it receives core
// capabilities and returns the implementations the seams consult. Only TYPE imports
// from core (`@/...`) are used (erased at compile time) — runtime data access goes
// through `core.db`, so this package never imports core runtime internals.

import type { EnterpriseEntrypoint } from "@alethia/enterprise-api";
import { sso } from "@better-auth/sso";
import { OpenFgaClient } from "@openfga/sdk";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins/organization";
import type { Actor, Entitlements } from "@/lib/authz/types";
import type { CoreContext, EnterpriseModule } from "@/lib/enterprise";
import { FgaTupleSync } from "./fga-tuple-sync";
import { resolveInstanceLicense } from "./license";
import { OpenFgaPdp } from "./openfga-pdp";
import { resolveActiveScope } from "./scope";

/** One OpenFGA client when configured (shared by the engine + the dual-write writer). */
function buildFgaClient(core: CoreContext): OpenFgaClient | null {
  if (!core.fga.isEnabled()) return null;
  const cfg = core.fga.getConfig();
  return new OpenFgaClient({
    apiUrl: cfg.apiUrl,
    storeId: cfg.storeId,
    authorizationModelId: cfg.modelId,
  });
}

/** Every enterprise feature on — the grant for a licensed instance / a paid org. */
const ALL_ENTITLEMENTS: Entitlements = {
  organizations: true,
  teams: true,
  sso: true, // OIDC + SAML via @better-auth/sso
  customRoles: true,
  activityExport: true,
  alerting: true,
  advancedAlerting: true,
  byoRunners: true,
  managedPools: true,
  // A licensed instance gets the enterprise tier's quotas (mirrors the ladder in
  // core's planEntitlements("enterprise"); inlined to keep this package type-only on core).
  quotas: {
    maxConcurrentJobs: null,
    priorityLevel: 30,
    includedRunnerMinutes: 20_000,
    activityRetentionDays: 365,
  },
  // NOTE: AI is no longer a plan entitlement — it's a standalone metered product with its
  // own tier ladder (console lib/billing/ai-plan.ts, resolved per-org via resolveAiTier).
};

/** Reads a string `organizationId` off an unknown request body, else null. */
function bodyOrgId(body: unknown): string | null {
  if (typeof body === "object" && body !== null && "organizationId" in body) {
    const value = body.organizationId;
    return typeof value === "string" ? value : null;
  }
  return null;
}

export const register: EnterpriseEntrypoint<CoreContext, EnterpriseModule> = (
  core,
) => {
  const fgaClient = buildFgaClient(core);
  const tupleSync = fgaClient ? new FgaTupleSync(core, fgaClient) : undefined;

  // Resolve + log the instance license once at boot (fire-and-forget — never blocks or crashes
  // register). Active ⇒ every org is enterprise; inactive ⇒ per-org billing decides, and the reason
  // (no license / expired / bad signature) is surfaced so a misconfigured license is diagnosable.
  void resolveInstanceLicense().then((instance) => {
    if (instance.active) {
      const exp = instance.license?.expiresAt;
      console.info(
        `[license] instance licensed (${instance.license?.subject ?? "unknown"}, tier=${
          instance.license?.tier ?? "enterprise"
        }${exp ? `, expires ${new Date(exp * 1000).toISOString()}` : ", perpetual"})`,
      );
    } else {
      console.info(
        `[license] instance not licensed — ${instance.reason}; using per-org billing`,
      );
    }
  });

  return {
    // Better Auth organization plugin: orgs / teams / members / invitations.
    authPlugins: [
      organization({
        creatorRole: "owner",
        // Group-based grants: a grant can target a team (grants.principal_type='team').
        // `defaultTeam.enabled: false` — DON'T let better-auth auto-create a per-org
        // default team on org create: that implicit team trips the Enterprise
        // `beforeCreateTeam` gate below (a new org has no `teams` entitlement), which
        // would 403 the whole `/organization/create`. Teams are created explicitly
        // (and stay Enterprise-gated); orgs don't need a default one.
        teams: { enabled: true, defaultTeam: { enabled: false } },
        // Membership roles = the PDP roles (owner/admin/operator/viewer), injected
        // from core so the org-plugin role vocabulary matches end-to-end.
        ac: core.orgAc,
        roles: core.orgRoles,
        // Send the invitation email (the drafted emails/invite.tsx) via core.
        sendInvitationEmail: async (data) => {
          await core.sendInviteEmail({
            to: data.email,
            inviterName:
              data.inviter.user.name ?? data.inviter.user.email ?? "A teammate",
            workspaceName: data.organization.name,
            role: typeof data.role === "string" ? data.role : data.role[0],
            token: data.id,
          });
          core.emitAlertEvent(data.organization.id, "system.member.invited", {
            title: `Member invited: ${data.email}`,
            severity: "info",
            actor_id: data.inviter.user.id,
            resource_type: "member",
          });
        },
        // Sync org membership → PDP grants on every lifecycle event, so the PDP
        // (which authorizes from grants, not member.role) actually grants access.
        organizationHooks: {
          // Pay-to-collaborate: a card-less Pro trial is solo. Block invites until
          // the org is on a paid (or card-backed) subscription — enforced here so
          // it holds regardless of the client (the UI shows the upsell separately).
          beforeCreateInvitation: async ({ invitation }) => {
            if (!(await core.canOrgInvite(invitation.organizationId))) {
              throw new APIError("FORBIDDEN", {
                message:
                  "Add a payment method to invite teammates — trials are single-member.",
              });
            }
          },
          // Teams are an Enterprise capability. Block creation server-side so the
          // gate holds regardless of the client (the UI shows the upsell separately).
          beforeCreateTeam: async ({ team }) => {
            if (!(await core.canOrgCreateTeams(team.organizationId))) {
              throw new APIError("FORBIDDEN", {
                message: "Teams require an Enterprise plan.",
              });
            }
          },
          afterCreateOrganization: async ({ organization: org, user }) => {
            await core.ensureMemberGrant(org.id, user.id, "owner");
          },
          afterAddMember: async ({ organization: org, user, member }) => {
            await core.ensureMemberGrant(org.id, user.id, member.role);
            // Per-seat billing: a new billable member bumps the subscription quantity.
            await core.syncOrgSeats(org.id);
            core.recordActivity({ userId: user.id, orgId: org.id }, "join", {
              type: "member",
              id: user.id,
            });
            core.emitAlertEvent(org.id, "system.member.joined", {
              title: `Member joined: ${user.email ?? user.id}`,
              severity: "info",
              actor_id: user.id,
              resource_type: "member",
              resource_id: user.id,
            });
          },
          // Accepting an invitation creates the member row via a DIFFERENT code path
          // than /organization/add-member: Better Auth fires afterAcceptInvitation
          // here, NOT afterAddMember. Without this hook an accepted member gets a
          // member row but NO PDP grant — and the PDP authorizes from grants, not
          // member.role, so they'd have zero access. Mirror afterAddMember so an
          // invited member is wired (grant + seat + activity) exactly like a direct add.
          afterAcceptInvitation: async ({
            organization: org,
            user,
            member,
          }) => {
            if (!member.role) {
              // An invitation with no role yields a member with no mappable role, so
              // ensureMemberGrant writes nothing (leaving the member ungranted). It now says so
              // itself for EVERY unmappable role — see core's `toPdpRole` / #3730, where
              // better-auth's own `member` role was unmapped and this branch never fired because
              // the role was present, just unrecognised. Kept because this one is the acceptance
              // path's own precondition and names the invitation.
              console.warn(
                `[authz] accepted invitation for user ${user.id} in org ${org.id} has no role — no grant written`,
              );
            }
            await core.ensureMemberGrant(org.id, user.id, member.role);
            // Per-seat billing: a new billable member bumps the subscription quantity.
            await core.syncOrgSeats(org.id);
            core.recordActivity({ userId: user.id, orgId: org.id }, "join", {
              type: "member",
              id: user.id,
            });
            core.emitAlertEvent(org.id, "system.member.joined", {
              title: `Member joined: ${user.email ?? user.id}`,
              severity: "info",
              actor_id: user.id,
              resource_type: "member",
              resource_id: user.id,
            });
          },
          afterUpdateMemberRole: async ({
            organization: org,
            user,
            member,
          }) => {
            await core.ensureMemberGrant(org.id, user.id, member.role);
            // A role change can flip billable status (e.g. viewer ⇄ operator).
            await core.syncOrgSeats(org.id);
            core.recordActivity(
              { userId: user.id, orgId: org.id },
              "role_change",
              {
                type: "member",
                id: user.id,
              },
            );
          },
          afterRemoveMember: async ({ organization: org, user }) => {
            await core.revokeMemberGrant(org.id, user.id);
            // Per-seat billing: removing a billable member frees a seat (prorated).
            await core.syncOrgSeats(org.id);
            core.recordActivity({ userId: user.id, orgId: org.id }, "remove", {
              type: "member",
              id: user.id,
            });
            core.emitAlertEvent(org.id, "system.member.removed", {
              title: `Member removed: ${user.email ?? user.id}`,
              severity: "warning",
              actor_id: user.id,
              resource_type: "member",
              resource_id: user.id,
            });
          },
          // Team membership → OpenFGA group tuples (team:T#member@user:U), so
          // team-scoped grants reach members. Postgres resolves team_member at
          // query time; this keeps the FGA store in step.
          afterAddTeamMember: async ({ teamMember, user }) => {
            await tupleSync?.syncTeamMember(teamMember.teamId, user.id);
          },
          afterRemoveTeamMember: async ({ teamMember, user }) => {
            await tupleSync?.removeTeamMember(teamMember.teamId, user.id);
          },
        },
      }),

      // Enterprise SSO (OIDC + SAML): Alethia as the Service Provider consuming
      // the customer's IdP (Okta / Entra ID / AWS IAM Identity Center / …).
      // Loaded after organization() so per-org providers (ssoProvider.organizationId)
      // resolve. SSO users are provisioned into their org as least-privileged
      // members. STANDUP: a JIT-provisioned user still gets NO PDP GRANT — see the
      // defaultRole comment below; plus add a getRole mapping (IdP group claim →
      // owner/admin/operator/viewer) and harden SAML (algorithms.onDeprecated:
      // "reject", enable InResponseTo validation).
      sso({
        organizationProvisioning: {
          // better-auth's org role (owner/admin/member) — least-privileged "member",
          // which core's `toPdpRole` maps to Alethia's viewer bundle.
          //
          // THAT MAPPING DOES NOT REACH A JIT-PROVISIONED USER. `assignOrganization()`
          // writes the member row with the generic adapter, not through the organization
          // plugin's routes, so none of the `organizationHooks` above fire — no
          // `ensureMemberGrant`, no grant row, no `syncOrgSeats`. The PDP authorizes from
          // grants, so an employee signing in through the IdP for the first time still
          // lands on `/{org}` denied. Fixing it needs a hook on the SSO path itself; the
          // role map (#3730) covers the INVITED member, not this one.
          defaultRole: "member",
        },
        // Prove the customer controls the domain before we trust the IdP for it.
        // This gates TWO things in @better-auth/sso: (1) sign-in through a provider
        // whose domain isn't verified is rejected, and (2) JIT account-linking by
        // email domain ("isTrustedProvider") — without it, registering a provider for
        // a domain you don't own would let you link into existing accounts on it.
        // The token is a DNS TXT record at `_alethia-sso-<providerId>`; the plugin
        // stores it in the core `verification` table (no schema change needed).
        domainVerification: { enabled: true, tokenPrefix: "alethia-sso" },
      }),

      // Entitlement gate for SSO registration. The @better-auth/sso plugin enforces
      // org membership/admin but NOT the plan — so without this a non-Enterprise org
      // admin could register a provider via direct POST. Block /sso/register unless
      // the target org holds the `sso` entitlement (the UI shows the upsell instead).
      {
        id: "alethia-sso-entitlement-guard",
        hooks: {
          before: [
            {
              matcher: (context: { path?: string }) =>
                context.path === "/sso/register",
              handler: createAuthMiddleware(async (ctx) => {
                const orgId = bodyOrgId(ctx.body);
                if (!orgId || !(await core.resolveOrgEntitlements(orgId)).sso) {
                  throw new APIError("FORBIDDEN", {
                    message: "Single Sign-On requires an Enterprise plan.",
                  });
                }
              }),
            },
          ],
        },
      },
    ],

    // Map a verified user to their active org — the personal org named explicitly, else a
    // membership row for the named org, else the primary (earliest) membership, else the
    // personal org. Lifted into ./scope so the rules can be driven directly by a test rather
    // than only through a booted enterprise module; see its JSDoc for why a named org the
    // caller is not a member of still falls back HERE and is refused by the header's reader.
    // STANDUP follow-up: honor session.activeOrganizationId for active-org switching
    // (needs the session/headers threaded into getActiveScope).
    resolveScope: (userId: string, activeOrgId?: string): Promise<Actor> =>
      resolveActiveScope(core.db, userId, activeOrgId),

    // Per-org entitlement resolution. A validly-licensed instance unlocks everything
    // (an explicit entitlements claim in the license narrows it, else the full set);
    // otherwise the org's plan + subscription status (from its billing record, via
    // core) decides — so an unsubscribed org falls back to the community baseline and
    // the org-creation gate bites. The license is a signed JWT verified offline (see
    // ./license), replacing the old ALETHIA_LICENSE_ACTIVE env placeholder.
    resolveEntitlements: async (orgId: string): Promise<Entitlements> => {
      const instance = await resolveInstanceLicense();
      if (instance.active)
        return instance.license?.entitlements ?? ALL_ENTITLEMENTS;
      return core.resolveOrgEntitlements(orgId);
    },

    // OpenFGA engine + dual-write, both only when OpenFGA is configured; otherwise
    // undefined ⇒ the community PostgresRbacPDP + no-op seam stay in place.
    pdp: fgaClient ? new OpenFgaPdp(core, fgaClient) : undefined,
    tupleSync,
  };
};
