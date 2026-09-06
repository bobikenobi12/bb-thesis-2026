// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useParams } from "next/navigation";
import { create } from "zustand";
import {
	getWorkspaceContext,
	setActiveOrganization,
	type WorkspaceOrg,
} from "@/app/server/actions/workspace";
import type { Entitlements } from "@/lib/authz/types";

interface WorkspaceStore {
	/** The org the session is scoped to (drives the PDP + RLS); null until loaded. */
	activeOrgId: string | null;
	/** Orgs the user can switch to (community = a single "Personal" workspace). */
	organizations: WorkspaceOrg[];
	/** Feature entitlements — gate the switcher's "create org" + the admin surfaces. */
	entitlements: Entitlements | null;
	/** Hosted SaaS vs self-managed deployment — gates platform-fleet surfaces. */
	isHosted: boolean;
	isLoading: boolean;
	fetchWorkspace: () => Promise<void>;
	/** Persist the active org server-side, then update local state. */
	switchOrg: (orgId: string) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
	activeOrgId: null,
	organizations: [],
	entitlements: null,
	isHosted: false,
	isLoading: false,
	fetchWorkspace: async () => {
		set({ isLoading: true });
		try {
			const ctx = await getWorkspaceContext();
			set({
				activeOrgId: ctx.activeOrgId,
				organizations: ctx.organizations,
				entitlements: ctx.entitlements,
				isHosted: ctx.isHosted,
			});
		} catch {
			// Unauthenticated / transient — keep defaults; the layout still renders.
		} finally {
			set({ isLoading: false });
		}
	},
	switchOrg: async (orgId) => {
		await setActiveOrganization(orgId);
		set({ activeOrgId: orgId });
	},
}));

/** Whether the console is the hosted SaaS (vs a self-managed/community deployment). */
export function useIsHosted(): boolean {
	return useWorkspaceStore((s) => s.isHosted);
}

/**
 * The active organization's URL slug (for building `/{org}/…` drilldown hrefs).
 *
 * **The URL is authoritative.** Every consumer of this hook renders inside
 * `app/(private)/[org]/layout.tsx`, so `useParams().org` IS the org segment the
 * address bar already shows. Reading it makes an href agree with the page it is
 * painted on BY CONSTRUCTION — there is no window in which the two disagree.
 *
 * That window was #4089, a tenancy defect. This hook used to read the store alone,
 * and `activeOrgId` is `null` until `fetchWorkspace()` resolves — so the lookup
 * missed and it returned the reserved personal `~` for "still loading" as well as
 * for "actually in personal scope". The two states are not distinguishable in the
 * value, and the old doc comment said so out loud ("while loading or in personal
 * scope") without registering that the first case is wrong.
 *
 * The consequence was not a cosmetic flicker. During hydration the sidebar painted
 * `/~/~/…` hrefs while the address bar said `/acme/…`; Next prefetches every link
 * in the viewport, each prefetch renders `[org]/layout.tsx`, and that layout calls
 * `resolveOrgScope("~")` — which WRITES `session.active_organization_id`. So a
 * speculative GET the user never made moved their tenant to personal, and their
 * next write landed in the personal org, invisible to the org and every teammate,
 * with no error. Run 33710964528's trace caught 36 `/~/~/` requests, every one
 * carrying `next-router-prefetch: 1` and none of them a navigation.
 *
 * Fixing the href is the whole fix, and it has to be, because the write itself
 * cannot be gated: Next 16.3.3 hides `next-router-prefetch` from userland — see the
 * comment on `resolveOrgScope` for the citation. Once every prefetchable href names
 * the org the address bar names, a speculative resolve can only re-assert the org
 * the user is already in, which is what a real navigation to that page would write
 * anyway. Idempotent, therefore harmless.
 *
 * ## There is deliberately NO session fallback
 *
 * An earlier version of this fix kept the old store read as a fallback for routes with
 * no `[org]` segment. That was a **positional** fix, not a causal one: the fallback
 * still answered `~` while `activeOrgId` was null, so the defect was intact inside it
 * and merely sat somewhere it did not currently fire. Worse, its doc invited the next
 * reader to add a store-derived `<Link>` on a non-`[org]` route — which is #4089
 * verbatim, since Next would prefetch the `/~/…` it painted during hydration.
 *
 * It was also dead code. `AppShell` is imported by exactly one module,
 * `app/(private)/[org]/layout.tsx`, and every consumer of this hook renders inside it.
 * The routes that fallback named render no consumer: `/onboarding` is under `(public)`,
 * `/dashboard` is a server-only `redirect()` with no client tree, and the CLI hand-off
 * imports none of this. So the branch could not execute, and tests pinning it pinned a
 * path that cannot occur. (`tests/hooks/use-active-org-slug.test.tsx` now asserts that
 * one-importer fact, because it is the premise this contract rests on.)
 *
 * So the fallback is gone and the absence of the segment is an error. Calling this
 * where there is no `{org}` in the URL has no correct answer — every value it could
 * return is a claim about which tenant the user is in, and `~` is a REAL tenant, not a
 * null. Refusing is the only honest branch, and it is what makes the fix causal: the
 * ambiguous value no longer exists anywhere to be rendered into an href.
 *
 * This also removes the last `?? PERSONAL_ORG_SLUG` alias in this file. `WorkspaceOrg.slug`
 * is nullable (`organizations.slug` is `text().unique()` with no notNull), so that
 * coalesce absorbed a real org with no slug onto the personal segment as well as a
 * find-miss — the same aliasing the switcher was fixed for.
 *
 * Note it no longer reads the store at all; it stays in this module because it is still
 * the workspace's org accessor and moving it would touch 19 imports for no behaviour.
 */
export function useActiveOrgSlug(): string {
	// `useParams()` returns null outside a router context (an isolated component test)
	// and `string[]` for a catch-all segment, so narrow the value rather than trusting
	// the type argument — it annotates the shape, it does not verify it.
	const params = useParams<{ org?: string }>();
	const org = params?.org;
	if (typeof org !== "string" || org.length === 0) {
		throw new Error(
			"useActiveOrgSlug() was called outside the /[org] route tree, so there is no org " +
				"segment to read. Do NOT reintroduce a session fallback here: it can only answer " +
				"`~`, which is a real tenant, and a prefetch of the href built from it moves the " +
				"user's active organization (#4089). Take the org from the route instead.",
		);
	}
	return org;
}
