// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";
import { getVerifiedCloudIdentities } from "@/app/server/actions/aws/identities";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { ProjectShell } from "@/components/design-project/project-shell";

/**
 * The project workspace layout. Owns the docked panel (service inspector + AI assistant) so the
 * assistant persists across the project's views (Architecture / Environments / Jobs / …) — Next
 * keeps the layout mounted across route changes. The routed view renders in the shell's main area.
 *
 * WHY AN UNRESOLVABLE SLUG DOES NOT `notFound()` HERE. In the App Router a segment's
 * `not-found.tsx` is handed to the `LayoutRouter` for that segment's **children** slot
 * (`next/dist/server/app-render/create-component-tree.js`: `notFoundComponent = isChildrenRouteKey
 * ? notFoundElement : undefined`), so the `HTTPAccessFallbackBoundary` mounts INSIDE this layout.
 * A `notFound()` thrown in the layout body is outside it and unwinds to the next boundary above —
 * `[org]/not-found.tsx` — which answered "Organization not found" for a project that is missing
 * while its org is fine (#3880).
 *
 * So the layout resolves for `ProjectShell` and stops there. When the slug does not resolve there
 * is no shell to render and no `projectId` to render it with, so the layout renders the routed
 * segment bare; every page under `[project]` resolves the same slug and calls `notFound()` itself,
 * and THAT throw is inside this segment's children slot, so `[project]/not-found.tsx` catches it
 * and the response is a real 404 rather than a 200 carrying not-found content.
 */
export default async function ProjectLayout({
	children,
	params,
}: {
	children: ReactNode;
	params: Promise<{ org: string; project: string }>;
}) {
	const { project } = await params;
	let projectId: string | null = null;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		projectId = null;
	}
	// No project, no shell — the page below answers the miss inside the boundary (see above).
	if (projectId === null) return <>{children}</>;

	const identities = await getVerifiedCloudIdentities();

	return (
		<ProjectShell projectId={projectId} identities={identities}>
			{children}
		</ProjectShell>
	);
}
