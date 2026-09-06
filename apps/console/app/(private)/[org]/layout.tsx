// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type React from "react";
import { notFound, redirect } from "next/navigation";
import { resolveOrgScope } from "@/app/server/actions/resolve";
import { getOwner } from "@/lib/auth/owner";
import { deploymentMode } from "@/lib/billing/config";
import { orgHasSelfRunners } from "@/lib/queries/runner-capabilities";
import { AppShell } from "@/components/shell/app-shell";
import { UpgradeSheetProvider } from "@/components/org/upgrade-sheet-provider";

/**
 * C2 slug-tree layout. Resolves the `{org}` segment to a scope and syncs the
 * session's active organization to it (so the rest of the request is scoped to the
 * URL org), then renders the shared dashboard chrome. Unknown/forbidden org → 404.
 *
 * The 404 it throws is caught by `(private)/not-found.tsx`, NOT by the sibling
 * `[org]/not-found.tsx`: a segment's own boundary mounts inside its layout, so a throw
 * from the layout escapes it (#3891). Do not "fix" a wrong-looking 404 here by moving
 * the boundary back down beside this file — that is the defect, not the remedy, and
 * `scripts/check-route-states.mjs` refuses the tree if the boundary above disappears.
 */
export default async function OrgLayout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	// No valid session (e.g. a stale/expired cookie the optimistic middleware let
	// through, or a failed session lookup) → sign-in, not a dead-end 404.
	if (!(await getOwner())) redirect("/login");
	let orgId: string;
	try {
		({ orgId } = await resolveOrgScope(org));
	} catch (e) {
		// A lost session mid-request → sign-in; an authenticated-but-unknown/forbidden org → 404.
		// Both still THROW, and that is deliberate: redirect() throws NEXT_REDIRECT, which no
		// not-found boundary catches, so adding one above cannot turn this branch into a render.
		// notFound() throws NEXT_NOT_FOUND and lands on `(private)/not-found.tsx` with a real 404
		// status — the alternative, returning a not-found body from here, answers 200.
		if (e instanceof Error && e.message === "Unauthorized") redirect("/login");
		notFound();
	}
	// Feedback is a hosted-only feature (it emails Alethia Labs); the shell hides it
	// off the hosted control plane. Resolved server-side and passed to the client shell.
	const isHosted = deploymentMode() === "hosted";
	// Runners is a self-operator surface only — gate the nav item on whether this org runs
	// its own runners (managed warm pools are internal/support-admin). Resolved server-side.
	const selfRunners = await orgHasSelfRunners(orgId);
	return (
		<UpgradeSheetProvider>
			<AppShell isHosted={isHosted} selfRunners={selfRunners}>
				{children}
			</AppShell>
		</UpgradeSheetProvider>
	);
}
