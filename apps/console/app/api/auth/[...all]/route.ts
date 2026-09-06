// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Better Auth catch-all handler — owns OAuth callbacks, email-OTP verify,
// session, account linking, sign-out, AND (enterprise build) the organization
// plugin's HTTP surface (/api/auth/organization/*). Provider tokens persist to the
// `account` table.
//
// Server-side entitlement gate (project 14 / billing foundation F1). Pricing model:
// creating a workspace (org) is FREE — a single-member community org — but TEAMS and
// MEMBERS are the paid feature ("free org, pay to unlock teams"). The org plugin's UI
// hides team/member actions for unentitled users, but the HTTP endpoints underneath
// accept any authenticated request, so we wrap POST: team/member-mutation calls return
// 403 unless the actor's scope has the `organizations` entitlement. Org create/update
// is intentionally NOT gated. The check consumes the existing entitlement seam
// (getEntitlements → ee/ per-org resolution from the billing record), so an
// unsubscribed org gets the community baseline and the gate bites. Read/accept/leave
// flows stay open so a user invited into someone else's PAID org can still participate.

import { auth } from "@/lib/auth";
import { trustedIpFailure } from "@/lib/auth/trusted-ip";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";
import { toNextJsHandler } from "better-auth/next-js";

const handlers = toNextJsHandler(auth);

/** Serves Better Auth GET routes after verifying the trusted client-IP contract. */
export function GET(request: Request): Promise<Response> | Response {
	return trustedIpFailure(request) ?? handlers.GET(request);
}

/**
 * Organization-plugin actions that *consume* the paid TEAMS feature (manage teams,
 * add/manage members). Gated on the `organizations` entitlement. Deliberately
 * EXCLUDES org create/update (a free workspace) and invitee/read/exit actions
 * (accept-invitation, set-active, list*, leave, …) — those are how a user creates a
 * free workspace or joins/uses an org someone else pays for.
 */
const GATED_ORG_ACTIONS = new Set([
	"create-team",
	"update-team",
	"remove-team",
	"invite-member",
	"add-member",
	"remove-member",
	"update-member-role",
]);

/** The `<action>` in /api/auth/organization/<action>, or null if not an org route. */
function gatedOrgAction(pathname: string): string | null {
	const marker = "/organization/";
	const i = pathname.indexOf(marker);
	if (i === -1) return null;
	const action = pathname.slice(i + marker.length).split(/[/?]/)[0];
	return GATED_ORG_ACTIONS.has(action) ? action : null;
}

/** 403 with an upgrade hint — the response an unentitled caller gets. */
function upgradeRequired(action: string): Response {
	return Response.json(
		{
			error: "upgrade_required",
			message:
				"Organizations and teams are a paid feature. Upgrade your plan to create or manage a team.",
			action,
		},
		{ status: 403 },
	);
}

export async function POST(req: Request): Promise<Response> {
	const ingressFailure = trustedIpFailure(req);
	if (ingressFailure) return ingressFailure;

	const action = gatedOrgAction(new URL(req.url).pathname);
	if (action) {
		// Resolve the caller's scope; if there's no session, fall through and let
		// Better Auth return its own 401 (don't mask auth errors as 403).
		try {
			const actor = await currentActor();
			if (!getEntitlements(actor).organizations) {
				return upgradeRequired(action);
			}
		} catch {
			// Unauthenticated (or scope unresolvable) → defer to the auth handler.
		}
	}
	return handlers.POST(req);
}
