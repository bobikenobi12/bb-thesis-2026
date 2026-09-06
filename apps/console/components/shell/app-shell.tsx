"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The dashboard shell (Vercel-style): a fixed sidebar + a main column with the topbar and a
// scrolling canvas. Mounted once by `app/(private)/[org]/layout.tsx` for the whole C2 slug
// tree. Replaces the legacy header-centric `DashboardChrome`.

import type React from "react";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "@repo/ui/sheet";
import { cn } from "@repo/ui/utils";
import { useJobsQuery } from "@/lib/query/use-jobs-query";
import { useSidebarCollapse } from "@/lib/stores/use-sidebar-store";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { ElenchSurface } from "@/components/agent/elench/elench-surface";
import { AnalyticsIdentity } from "@/components/analytics/analytics-identity";
import { SetupGuideCard } from "@/components/onboarding/setup-guide";
import { AppSidebar } from "./app-sidebar";
import { CommandPalette } from "./command-palette";
import { CONTENT_FRAME } from "./content-frame";
import { JobToaster } from "./job-toaster";
import { SidebarRail } from "./sidebar-rail";
import { SupportToaster } from "./support-toaster";
import { Topbar } from "./topbar";

/** The authenticated dashboard chrome: sidebar + topbar + scrolling content canvas. */
export function AppShell({
	children,
	isHosted = false,
	selfRunners = false,
}: {
	children: React.ReactNode;
	/** Hosted control plane → enables the in-app feedback widget in the sidebar. */
	isHosted?: boolean;
	/** Org runs its own runners → surfaces the gated Runners nav item. */
	selfRunners?: boolean;
}) {
	const [mobileOpen, setMobileOpen] = useState(false);

	// Inside a project the sidebar can collapse to a 56px icon rail (the Architecture canvas wants the
	// width); it stays the full sidebar on every other project view and always at org scope. A nested
	// drill (Settings) force-expands it, and a manual toggle pins the user's choice. See useSidebarCollapse.
	const { collapsed } = useSidebarCollapse();

	// The project workspace is the one subtree this frame must NOT wrap. `ProjectShell` mounts
	// below this shell and is a full-viewport surface — the Architecture canvas pans to the edge
	// and the docked inspector is pinned to the right rail — so it applies CONTENT_FRAME itself,
	// to its scrolling views only. A cap on this ancestor would be inescapable from down there:
	// ProjectShell's `-m-4 … -m-10` cancels padding, but no negative margin can cancel a
	// `max-w-*` whose overflow it cannot measure. Org-scoped routes are `/{org}` and `/{org}/~/…`;
	// anything with a second segment that is not `~` is the workspace.
	const segments = usePathname().split("/").filter(Boolean);
	const isProjectWorkspace = segments.length >= 2 && segments[1] !== "~";

	// Load the workspace once here so every nav href resolves to the active org even
	// before the org switcher mounts (the switcher used to be the only loader).
	useEffect(() => {
		useWorkspaceStore.getState().fetchWorkspace();
	}, []);

	// Warm the shared jobs cache session-wide so the command palette, breadcrumbs, and
	// overview resolve job names everywhere; TanStack Query dedupes and polls it.
	useJobsQuery();

	return (
		<div className="flex h-dvh w-full overflow-hidden bg-background">
			{/* Desktop sidebar — collapses to a 56px icon rail on the project canvas. */}
			<aside
				className={cn(
					"hidden shrink-0 border-r lg:block",
					collapsed ? "w-[56px]" : "w-[252px]",
				)}
			>
				{collapsed ? (
					<SidebarRail selfRunners={selfRunners} />
				) : (
					<AppSidebar isHosted={isHosted} selfRunners={selfRunners} />
				)}
			</aside>

			{/* Mobile sidebar */}
			<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
				<SheetContent
					side="left"
					className="w-[252px] p-0"
					onClick={(e) => {
						// Close the drawer when a nav link is tapped (mobile UX).
						if (e.target instanceof Element && e.target.closest("a")) {
							setMobileOpen(false);
						}
					}}
				>
					<SheetTitle className="sr-only">Navigation</SheetTitle>
					<AppSidebar isHosted={isHosted} selfRunners={selfRunners} />
				</SheetContent>
			</Sheet>

			{/* Main column */}
			<div className="flex min-w-0 flex-1 flex-col">
				<Topbar onOpenSidebar={() => setMobileOpen(true)} />
				<main className="flex-1 overflow-y-auto">
					<Suspense
						fallback={
							<div className="flex min-h-[50vh] items-center justify-center">
								<div className="h-6 w-6 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
							</div>
						}
					>
						<div className="p-4 sm:p-6 lg:p-8 xl:p-10">
							{isProjectWorkspace ? (
								children
							) : (
								<div className={CONTENT_FRAME}>{children}</div>
							)}
						</div>
					</Suspense>
				</main>
			</div>

			{/* The global Elench assistant surface. In panel view it renders as an in-flow flex
			    child here — its width animates from 0 and squeezes the main column (true seam
			    border, like the canvas inspector). In modal view it portals out (Radix Dialog),
			    leaving this slot empty. One surface per session. */}
			<ElenchSurface />

			{/* Global command palette (the sidebar "Find…" box + ⌘K / F). */}
			<CommandPalette selfRunners={selfRunners} />

			{/* Single job-lifecycle toast driver (loading → success/failed in place). */}
			<JobToaster />

			{/* Ties the analytics session to the person + active org (identify + group). Headless. */}
			<AnalyticsIdentity />

			{/* Single support-reply toast driver (staff/AI reply → "New reply on CASE-…"). */}
			<SupportToaster />

			{/* First-run "Setup guide" — toggled from the topbar button, floats bottom-right. */}
			<SetupGuideCard />
		</div>
	);
}
