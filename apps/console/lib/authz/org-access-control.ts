// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Better Auth organization-plugin access control, defining OUR membership roles
// (owner / admin / operator / viewer) so the org-plugin's role vocabulary matches
// the PDP's — one role model end-to-end. This names the roles + their org-management
// permissions (who can manage members/invitations/the org); the real per-resource
// authorization is the PDP (grants), not this AC. Shared by the browser auth client
// and the ee organization() plugin (injected via CoreContext, so ee/ stays
// type-only on core).

import { createAccessControl } from "better-auth/plugins/access";

export const ORG_ROLES = ["owner", "admin", "operator", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

// Org-management actions the plugin gates (distinct from PDP resource actions).
const statement = {
	organization: ["update", "delete"],
	member: ["create", "update", "delete"],
	invitation: ["create", "cancel"],
} as const;

export const orgAc = createAccessControl(statement);

// owner = full org control; admin = manage members/invitations; operator + viewer
// hold no org-management rights (their power is PDP resource access via grants).
export const orgRoles = {
	owner: orgAc.newRole({
		organization: ["update", "delete"],
		member: ["create", "update", "delete"],
		invitation: ["create", "cancel"],
	}),
	admin: orgAc.newRole({
		member: ["create", "update", "delete"],
		invitation: ["create", "cancel"],
	}),
	operator: orgAc.newRole({}),
	viewer: orgAc.newRole({}),
};

/** Narrows a free-form string to an OrgRole (no unsafe cast). */
export function toOrgRole(value: string): OrgRole | null {
	switch (value) {
		case "owner":
		case "admin":
		case "operator":
		case "viewer":
			return value;
		default:
			return null;
	}
}

/**
 * Better Auth's OWN role vocabulary is `owner | admin | member` (its
 * `plugins/organization/schema` `defaultRoles`), and two of those three are ours already. The
 * third is not, and it is not hypothetical: `member` is what the `member.role` column DEFAULTS
 * to, what the ee SSO plugin provisions JIT users with
 * (`organizationProvisioning.defaultRole`), and what an invitation sent with the plugin's own
 * default carries. Alethia's least-privileged role is `viewer`, so that is what it means here.
 *
 * IT COST AN OUTAGE FOR EVERY INVITED MEMBER (#3730). `ensureMemberGrant` narrowed
 * `member.role` with `toOrgRole` above, which answers null for `member` — and the function
 * treats null as "nothing to grant" and returns. So an accepted invitation wrote a `member` row
 * and NO grant, the PDP (which authorizes from grants, never from `member.role`) denied
 * `project:view`, and `/{org}` threw ForbiddenError out of its server component into the `[org]`
 * error boundary: "Couldn't load this page".
 *
 * SSO JIT PROVISIONING IS **NOT** FIXED BY THIS MAP, and the SSO plugin's own comment claiming
 * otherwise was wrong. `@better-auth/sso`'s `assignOrganization()` writes the member row with the
 * GENERIC adapter (`ctx.context.adapter.create({ model: "member", … })`), not through the
 * organization plugin's routes — so no `organizationHooks` fire (`afterAddMember` /
 * `afterAcceptInvitation` appear nowhere in its dist), `ensureMemberGrant` is never called, and a
 * JIT-provisioned user still lands on `/{org}` with no grant at all. Nor would a
 * `databaseHooks.member.create.after` catch it: those run inside `getWithHooks`, which only the
 * INTERNAL adapter uses, and the core option type has no `member` key. Closing that hole needs an
 * SSO-side hook of its own; it is a separate defect from the one this map fixes.
 */
// A Map, not an object literal, and that is not a style choice: an object literal inherits
// Object.prototype, so `ALIASES["toString"]` answers a FUNCTION rather than undefined — truthy,
// so it would sail past the caller's `if (!resolved)` and index BUILTIN_ROLE_IDS with a
// non-role, writing a grant row with an undefined role_id. A Map has no prototype keys.
const MEMBERSHIP_ROLE_ALIASES: ReadonlyMap<string, OrgRole> = new Map([
	// Better Auth's built-in least-privileged role ⇒ ours.
	["member", "viewer"],
]);

/** Resolves ONE role name (already trimmed) — our four, plus Better Auth's aliases. */
function resolveRoleName(value: string): OrgRole | null {
	return toOrgRole(value) ?? MEMBERSHIP_ROLE_ALIASES.get(value) ?? null;
}

/**
 * Resolves a stored membership role (`member.role`) to the PDP role whose permission bundle it
 * grants — our four, plus Better Auth's built-ins that are not spelled the same.
 *
 * `member.role` is NOT always one role. The org plugin's invite body takes `role: string |
 * string[]`, `parseRoles` joins an array with `,`, and `acceptInvitation` copies that string
 * verbatim into the member row — so `"admin,viewer"` is a legitimate stored value, and the plugin
 * itself reads membership back as `role.split(",").map((r) => r.trim())`. We mirror that split
 * (trim included, so a value the plugin treats as `owner` is not denied here over a stray space)
 * and answer the MOST-PRIVILEGED component that maps, by {@link ORG_ROLES} order.
 *
 * That is deliberately a subset of the union of the listed bundles, not the union: a grant row
 * carries one role, and `operator` and `viewer` are incomparable (a viewer may read members and
 * activity; an operator may deploy). Under-granting is the safe direction — the member is denied
 * something they could have had, rather than handed something no single stored role gives.
 *
 * Deliberately NOT a fallback. A value with no component that maps returns null and the caller
 * writes no grant, because "anything I don't recognise means viewer" would turn a typo, a renamed
 * role or a deleted custom role into read access over the whole org. Use {@link toOrgRole}
 * instead wherever the question is "is this one of the roles a human may pick" (a role <select>),
 * not "what does this stored role grant".
 */
export function toPdpRole(value: string): OrgRole | null {
	let best: OrgRole | null = null;
	for (const part of value.split(",")) {
		const resolved = resolveRoleName(part.trim());
		if (!resolved) continue;
		if (!best || ORG_ROLES.indexOf(resolved) < ORG_ROLES.indexOf(best)) {
			best = resolved;
		}
	}
	return best;
}

/**
 * The role name to SHOW for a stored membership or invitation role: the PDP role it grants when
 * one resolves, the raw string otherwise (an unrecognised value stays visible rather than being
 * silently renamed to something a reader would trust).
 *
 * The alias must not stop at the PDP. A `member` row that authorizes as a viewer but renders as
 * "member" gives the members table a role its own <select> cannot offer — the control comes up
 * blank — and gives the role facet two buckets for one role. Normalise where the row is read.
 */
export function toDisplayRole(value: string): string {
	return toPdpRole(value) ?? value;
}

/**
 * Every stored spelling that {@link toPdpRole} resolves to `role` — the reverse map, so a query
 * that FILTERS or BILLS on a PDP role covers its aliases too. Without it a `member` row is a
 * viewer for authorization but a non-viewer to `countBillableSeats`, and a paid seat is charged
 * for read-only access. Single-role spellings only: a comma-joined value is normalised on read
 * (see {@link toDisplayRole}), never matched in SQL.
 */
export function storedRolesFor(role: OrgRole): string[] {
	const aliases: string[] = [];
	for (const [stored, mapped] of MEMBERSHIP_ROLE_ALIASES) {
		if (mapped === role) aliases.push(stored);
	}
	return [role, ...aliases];
}
