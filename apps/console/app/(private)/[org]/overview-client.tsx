"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org root — an organization overview. A search/filter toolbar over the projects list (right,
// card or table), alongside Usage / Alerts / Recent-jobs cards (left). Projects are searched,
// filtered and sorted SERVER-SIDE (state lives in the URL); favorites float to the top client-side
// (they're persisted per-browser in `useProjectsStore`).

import { Boxes, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useMemo, useTransition } from "react";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { SectionHeading } from "@repo/ui/section-heading";
import {
	Table,
	TableBody,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import type { ViewMode } from "@repo/ui/view-toggle";
import type {
	ProjectListItem,
	ProjectListResult,
} from "@/app/server/actions/projects";
import { AlertsCard } from "@/components/overview/alerts-card";
import { OverviewToolbar } from "@/components/overview/overview-toolbar";
import { ProjectCard } from "@/components/overview/project-card";
import { ProjectRow } from "@/components/overview/project-row";
import { RecentJobsCard } from "@/components/overview/recent-jobs-card";
import { UsageCard } from "@/components/overview/usage-card";
import { globalHref } from "@/lib/routing";
import { useProjectsStore } from "@/lib/stores/use-projects-store";

/** The grid's search/filter/sort/view state — mirrored 1:1 into the URL search params. */
export interface OverviewState {
	q: string;
	clouds: string[];
	repos: string[];
	sort: "activity" | "name";
	view: ViewMode;
}

export function OverviewClient({
	orgSlug,
	projects,
	facets,
	state,
	totalCount,
	connectedProviders,
}: {
	orgSlug: string;
	projects: ProjectListItem[];
	facets: ProjectListResult["facets"];
	state: OverviewState;
	totalCount: number;
	/** Cloud provider slugs with a live connection — drives full-color vs grayscale provider logos. */
	connectedProviders: string[];
}) {
	const router = useRouter();
	const pathname = usePathname();
	const [isPending, startTransition] = useTransition();

	// Merge a partial state change into the URL; the server re-resolves the filtered grid. Only
	// non-default values are written so a pristine view keeps a clean `/{org}` URL.
	const onChange = useCallback(
		(next: Partial<OverviewState>) => {
			const merged = { ...state, ...next };
			const params = new URLSearchParams();
			if (merged.q) params.set("q", merged.q);
			if (merged.clouds.length) params.set("cloud", merged.clouds.join(","));
			if (merged.repos.length) params.set("repo", merged.repos.join(","));
			if (merged.sort !== "activity") params.set("sort", merged.sort);
			if (merged.view !== "card") params.set("view", merged.view);
			const qs = params.toString();
			startTransition(() =>
				router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }),
			);
		},
		[state, pathname, router],
	);

	const { favoriteProjectIds, toggleFavorite } = useProjectsStore();

	// Float favorited projects to the top of the (already server-sorted) list — a stable,
	// presentation-only reorder that keeps the server's activity/name order within each group.
	const ordered = useMemo(() => {
		const favs: ProjectListItem[] = [];
		const rest: ProjectListItem[] = [];
		for (const p of projects) {
			(favoriteProjectIds.includes(p.id) ? favs : rest).push(p);
		}
		return [...favs, ...rest];
	}, [projects, favoriteProjectIds]);

	const filtered =
		Boolean(state.q) || state.clouds.length > 0 || state.repos.length > 0;

	return (
		<div className="space-y-5">
			<OverviewToolbar
				orgSlug={orgSlug}
				state={state}
				facets={facets}
				onChange={onChange}
			/>

			<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(312px,0.35fr)_minmax(0,0.65fr)]">
				{/* Left column — usage, alerts, recent jobs. */}
				<div className="flex flex-col gap-4">
					<UsageCard orgSlug={orgSlug} projectCount={totalCount} />
					<AlertsCard orgSlug={orgSlug} />
					<RecentJobsCard orgSlug={orgSlug} />
				</div>

				{/* Right column — projects list. */}
				<div>
					{/* "Projects" names a SECTION of the overview, not the route — the breadcrumb
					    above says "Overview". The count is the FILTERED result count, in the shared
					    count pill beside the heading, where the console filter standard puts it. */}
					<SectionHeading
						title="Projects"
						count={ordered.length}
						className="mb-3"
					/>

					<div
						className={
							isPending ? "opacity-60 transition-opacity" : "transition-opacity"
						}
					>
						{totalCount === 0 ? (
							<EmptyState
								icon={<Boxes />}
								title="No projects yet"
								description="Create your first project to provision infrastructure — it becomes a project you can manage here."
								action={
									<Link href={globalHref(orgSlug, "new")}>
										<Button size="sm" className="h-8 gap-1.5 text-xs">
											<Plus className="h-3.5 w-3.5" />
											Create a Project
										</Button>
									</Link>
								}
							/>
						) : ordered.length === 0 ? (
							// The org HAS projects; this view just resolved to none. Never say "no projects
							// yet" here — that reads as data loss rather than an active filter.
							<EmptyState
								title={
									filtered ? "No projects match your filters" : "No projects yet"
								}
								description={
									filtered
										? "Widen or clear the search, cloud and repository filters."
										: undefined
								}
								action={
									filtered ? (
										<Button
											variant="outline"
											size="sm"
											className="h-8 text-xs"
											onClick={() =>
												onChange({ q: "", clouds: [], repos: [] })
											}
										>
											Clear filters
										</Button>
									) : undefined
								}
							/>
						) : state.view === "table" ? (
							<div className="overflow-x-auto rounded-xl border border-border/60">
								<Table>
									<TableHeader>
										<TableRow className="hover:bg-transparent">
											<TableHead>Project</TableHead>
											<TableHead>Cloud</TableHead>
											<TableHead>Region</TableHead>
											<TableHead>Status</TableHead>
											<TableHead>Envs</TableHead>
											<TableHead>Add-ons</TableHead>
											<TableHead className="text-right">Cost</TableHead>
											<TableHead className="text-right">Last deploy</TableHead>
											<TableHead className="w-8" />
										</TableRow>
									</TableHeader>
									<TableBody>
										{ordered.map((project) => (
											<ProjectRow
												key={project.id}
												project={project}
												orgSlug={orgSlug}
												isFavorite={favoriteProjectIds.includes(project.id)}
												onToggleFavorite={() => toggleFavorite(project.id)}
												connectedProviders={connectedProviders}
											/>
										))}
									</TableBody>
								</Table>
							</div>
						) : (
							<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(238px,1fr))]">
								{ordered.map((project) => (
									<ProjectCard
										key={project.id}
										project={project}
										orgSlug={orgSlug}
										isFavorite={favoriteProjectIds.includes(project.id)}
										onToggleFavorite={() => toggleFavorite(project.id)}
										connectedProviders={connectedProviders}
									/>
								))}
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
