"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCommandPalette } from "@/lib/stores/use-command-palette";
import {
	type DrillId,
	isNavItemActive,
	type SidebarNavGroups,
} from "./nav-config";
import { NavRow } from "./nav-row";

/**
 * The main sidebar view: a stubbed "Find…" box plus the nav groups (top, connect, and a
 * pinned-bottom group). The groups are built by the shell — org-wide or project-scoped — and
 * passed in. Drill triggers either navigate (route-owned) or call `onOpenDrill` to slide a
 * sub-view in.
 */
export function SidebarNav({
	groups,
	onOpenDrill,
}: {
	groups: SidebarNavGroups;
	onOpenDrill: (id: DrillId) => void;
}) {
	const pathname = usePathname();

	return (
		<div className="flex h-full flex-col">
			{/* Find box — opens the global command palette (also ⌘K / F). */}
			<div className="px-3 pb-2 pt-3">
				<button
					type="button"
					onClick={() => useCommandPalette.getState().setOpen(true)}
					className="flex h-9 w-full items-center gap-2.5 rounded-md border bg-muted/30 px-2.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
				>
					<Search className="h-[15px] w-[15px] shrink-0" />
					<span className="flex-1 text-left text-ui-md">Find…</span>
					<span className="shrink-0 rounded border px-1.5 font-mono text-ui-2xs">F</span>
				</button>
			</div>

			<nav className="flex flex-1 flex-col overflow-y-auto px-3 pb-3">
				<div className="space-y-0.5">
					{groups.top.map((item) => (
						<NavRow
							key={item.label}
							item={item}
							active={isNavItemActive(item, pathname)}
							onOpenDrill={onOpenDrill}
						/>
					))}
				</div>

				{/* The "connect" group is org-only (empty in project scope) — skip it + its
				    divider so the project sidebar doesn't show a dangling rule. */}
				{groups.connect.length > 0 && (
					<>
						<div className="my-2 h-px bg-border" />
						<div className="space-y-0.5">
							{groups.connect.map((item) => (
								<NavRow
									key={item.label}
									item={item}
									active={isNavItemActive(item, pathname)}
									onOpenDrill={onOpenDrill}
								/>
							))}
						</div>
					</>
				)}

				<div className="mt-auto space-y-0.5 pt-3">
					{groups.pinned.map((item) => (
						<NavRow
							key={item.label}
							item={item}
							active={isNavItemActive(item, pathname)}
							onOpenDrill={onOpenDrill}
						/>
					))}
				</div>
			</nav>
		</div>
	);
}
