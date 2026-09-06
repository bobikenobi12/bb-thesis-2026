"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Check, Plus } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { SwitcherTrigger } from "@/components/shell/switcher-trigger";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { ProviderIcon } from "@repo/ui/provider-icon";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@repo/ui/command";
import { Popover, PopoverContent } from "@repo/ui/popover";
import { Separator } from "@repo/ui/separator";
import { useProjectsQuery } from "@/lib/query/use-projects-query";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { globalHref, projectHref } from "@/lib/routing";

/**
 * Header project switcher — the Vercel combobox between org and env. Lists the org's projects
 * (flat, from the projects store) and navigates to `/{org}/{project}`. Persistent across the
 * whole org (overview, `~` global pages, and project drilldowns) so you can jump into a project
 * from anywhere — shows the active project on a `/{org}/{project}/…` route, else "Select a
 * project". Hidden only on the legacy `/dashboard` tree or when the org has no projects.
 */
export function ProjectSwitcher() {
	const router = useRouter();
	const pathname = usePathname();
	const orgSlug = useActiveOrgSlug();
	const [open, setOpen] = useState(false);
	const { data: projects = [] } = useProjectsQuery();

	// Render across the whole org (overview, `~` global pages, project drilldowns) — never the
	// legacy `/dashboard/*` tree. The active project is only the one in a `/{org}/{project}/…`
	// path (segs[1] that isn't the reserved `~`); elsewhere there's no active selection.
	const segs = pathname.split("/").filter(Boolean);
	const inOrg = segs.length >= 1 && segs[0] !== "dashboard";
	const projectSlug = segs[1] !== "~" ? segs[1] : undefined;

	// Always present within an org (even with 0 projects → "All projects" + a Create entry);
	// only the legacy /dashboard tree opts out.
	if (!inOrg) return null;

	const active = projects.find((p) => p.slug === projectSlug) ?? null;

	const handleSelect = (slug: string) => {
		setOpen(false);
		router.push(projectHref(orgSlug, slug));
	};

	const startCreate = () => {
		setOpen(false);
		router.push(globalHref(orgSlug, "new"));
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<SwitcherTrigger
				variant="topbar"
				open={open}
				ariaLabel="Switch project"
				leading={
					active?.cloud_provider ? (
						<span className="flex h-5 w-5 shrink-0 items-center justify-center rounded border text-muted-foreground">
							<ProviderIcon provider={active.cloud_provider} size={12} />
						</span>
					) : undefined
				}
				label={active?.project_name ?? "All projects"}
			/>
			<PopoverContent className="w-72 p-0" align="start">
				<Command>
					{projects.length > 0 ? (
						<>
							<CommandInput placeholder="Find project…" className="h-9" />
							<CommandList>
								{/* Only on a genuine search miss — never as the empty-org state. */}
								<CommandEmpty>No project found.</CommandEmpty>
								<CommandGroup heading="Projects">
									{projects.map((p) => (
										<CommandItem
											key={p.id}
											value={p.project_name}
											onSelect={() => p.slug && handleSelect(p.slug)}
											className="gap-2"
										>
											<span className="flex-1 truncate">{p.project_name}</span>
											{p.id === active?.id && (
												<Check className="h-4 w-4 shrink-0" />
											)}
										</CommandItem>
									))}
								</CommandGroup>
							</CommandList>
						</>
					) : (
						<EmptyState title="No projects yet." className="px-3 py-6" />
					)}
					<Separator />
					{/* Pinned footer — outside CommandList so search never hides it. */}
					<div className="p-1">
						<Button
							variant="ghost"
							onClick={startCreate}
							className="w-full justify-start gap-2 px-2"
						>
							<Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
							<span className="text-sm">Create project</span>
						</Button>
					</div>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
