"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Teams — the org's teams on the shared DataTable, on the console filter standard
// (lib/query/README.md → "Server-side filters"): a URL-synced zustand store → debounce →
// `normalizeTeamsQuery` → `qk.teams(org, q)` → TanStack Query. Replaces the page's own
// fetch-into-useState + un-debounced `.includes()` filter and its banned stat-card strip; the
// result count now lives in the page toolbar's count pill, which is where the standard puts it.
//
// Wired to the real backend: getTeams (name + members) + better-auth createTeam/removeTeam +
// ManageTeamDialog (add/remove members). The design's per-team description, stored slug and
// role-tag have no backend yet — omitted and tracked in
// dataroom/spec/features/settings-design-port.md.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Plus, Users } from "lucide-react";
import { useParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { getTeams, type TeamRow } from "@/app/server/actions/teams";
import { DataTable } from "@/components/data-table";
import { settingsControl, settingsControlSize } from "@/components/settings/settings-ui";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@repo/ui/alert-dialog";
import { Button } from "@repo/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { EmptyState } from "@repo/ui/empty";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import { UpgradeDialog } from "@/components/settings/upgrade/upgrade-dialog";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { authClient } from "@/lib/auth/client";
import { qk } from "@/lib/query/keys";
import { slugifyOrEmpty } from "@/lib/utils/slugify";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useTeamsFilters } from "@/lib/stores/use-settings-filters";
import { cn } from "@repo/ui/utils";
import {
	DEFAULT_TEAMS_FILTERS,
	filterTeams,
	normalizeTeamsQuery,
	TEAM_SIZE_OPTIONS,
	teamsFacetCounts,
} from "./teams-filters";
import { ManageTeamDialog } from "./manage-team-dialog";

/** Two-letter avatar initials for a team name. */
function monogram(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (!parts.length) return "TM";
	return (
		(parts[0][0] ?? "") + (parts[1]?.[0] ?? parts[0][1] ?? "")
	).toUpperCase();
}

export function TeamsList() {
	// Teams are an Enterprise capability. Without it the page stays fully visible —
	// existing teams render read-only and creation is replaced by an upsell — matching
	// the server-side `beforeCreateTeam` gate (no hard wall).
	const entitled = useEntitlement("teams");
	const { org } = useParams<{ org: string }>();
	const qc = useQueryClient();

	// Filter state: the store is the source of truth, the URL mirrors it (shareable views),
	// and the free text is debounced before it can reach a query key.
	const filters = useTeamsFilters((s) => s.filters);
	const set = useTeamsFilters((s) => s.set);
	const reset = useTeamsFilters((s) => s.reset);
	useFilterUrlSync(useTeamsFilters, DEFAULT_TEAMS_FILTERS);
	const search = useDebouncedValue(filters.search);
	const query = useMemo(
		() => normalizeTeamsQuery(filters, search),
		[filters, search],
	);

	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const [manage, setManage] = useState<TeamRow | null>(null);
	const [deleting, setDeleting] = useState<TeamRow | null>(null);

	// The UNFILTERED universe. `getTeams()` takes no filters (see teams-filters.ts), so the
	// base key holds every team and the narrowing happens below — which also means the facet
	// counts are over everything, never over the current result.
	const teamsQuery = useQuery({
		queryKey: qk.teams(org),
		queryFn: () => getTeams(),
	});
	const all = useMemo(() => teamsQuery.data ?? [], [teamsQuery.data]);
	const rows = useMemo(() => filterTeams(all, query), [all, query]);
	const counts = useMemo(() => teamsFacetCounts(all), [all]);

	const invalidate = useCallback(() => {
		void qc.invalidateQueries({ queryKey: ["teams", org] });
	}, [qc, org]);

	const create = async () => {
		if (!entitled || !name.trim()) return;
		const { error } = await authClient.organization.createTeam({
			name: name.trim(),
		});
		if (error) {
			toast.error(error.message ?? "Couldn't create team");
			return;
		}
		toast.success("Team created");
		setName("");
		setCreating(false);
		invalidate();
	};

	const remove = async (t: TeamRow) => {
		const { error } = await authClient.organization.removeTeam({ teamId: t.id });
		if (error) {
			toast.error(error.message ?? "Couldn't delete team");
			return;
		}
		toast.success("Team deleted");
		setDeleting(null);
		invalidate();
	};

	const columns: ColumnDef<TeamRow>[] = [
		{
			accessorKey: "name",
			header: "Team",
			cell: ({ row }) => {
				const t = row.original;
				return (
					<div className="flex min-w-0 items-center gap-3">
						<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink font-display text-ui-sm font-semibold text-ink-foreground">
							{monogram(t.name)}
						</span>
						<div className="flex min-w-0 flex-col">
							<span className="truncate text-ui-md font-medium text-text-primary">
								{t.name}
							</span>
							<span className="font-mono text-ui-2xs text-text-tertiary">
								{slugifyOrEmpty(t.name)}
							</span>
						</div>
					</div>
				);
			},
		},
		{
			accessorKey: "memberCount",
			header: "Members",
			cell: ({ row }) => {
				const t = row.original;
				return (
					<div className="flex items-center gap-3">
						{t.members.length > 0 && (
							<div className="flex -space-x-2">
								{t.members.slice(0, 4).map((m) => (
									<span
										key={m.userId}
										className="flex size-6 items-center justify-center rounded-full border-2 border-surface bg-surface-muted font-mono text-ui-3xs text-text-secondary"
									>
										{m.initials}
									</span>
								))}
								{t.members.length > 4 && (
									<span className="flex size-6 items-center justify-center rounded-full border-2 border-surface bg-surface-sunken font-mono text-ui-3xs text-text-tertiary">
										+{t.members.length - 4}
									</span>
								)}
							</div>
						)}
						<span className="whitespace-nowrap font-mono text-ui-xs text-text-tertiary">
							{t.memberCount} member{t.memberCount === 1 ? "" : "s"}
						</span>
					</div>
				);
			},
		},
		{
			id: "actions",
			header: "",
			enableSorting: false,
			cell: ({ row }) => {
				const t = row.original;
				return (
					<div className="text-right">
						<DropdownMenu>
							<DropdownMenuTrigger
								disabled={!entitled}
								render={
									<Button
										variant="ghost"
										size="icon"
										className="size-7"
										aria-label="Manage team"
										disabled={!entitled}
									>
										<MoreHorizontal size={16} />
									</Button>
								}
							/>
							<DropdownMenuContent align="end" className="w-44">
								<DropdownMenuItem onClick={() => setManage(t)}>
									Manage members
								</DropdownMenuItem>
								<DropdownMenuItem
									className="text-destructive focus:text-destructive"
									onClick={() => setDeleting(t)}
								>
									Delete team
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				);
			},
		},
	];

	const activeFilters = countActiveFilters(filters, DEFAULT_TEAMS_FILTERS);

	if (teamsQuery.isPending) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-20 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	const createAction = entitled ? (
		<Button size="sm" onClick={() => setCreating((v) => !v)}>
			<Plus size={13} />
			Create team
		</Button>
	) : (
		<UpgradeDialog
			feature="teams"
			trigger={
				<Button size="sm">
					<Plus size={13} />
					Create team
				</Button>
			}
		/>
	);

	return (
		<div>
			<PageToolbar
				className="mb-4"
				description="Grant access to a group of members at once."
				count={rows.length}
				actions={createAction}
			/>

			<FilterBar>
				<FilterSearch
					value={filters.search}
					onChange={(v) => set("search", v)}
					placeholder="Search teams…"
					className="w-[240px] max-w-[380px] flex-1"
				/>
				<FacetFilter
					label="Size"
					icon={Users}
					options={TEAM_SIZE_OPTIONS.map((o) => ({
						value: o.value,
						label: o.label,
						hint: String(counts[o.value] ?? 0),
					}))}
					value={filters.sizes}
					onChange={(next) => set("sizes", next)}
					searchPlaceholder="Filter size…"
					emptyText="No sizes."
				/>
				<FilterBarReset count={activeFilters} onReset={reset} />
			</FilterBar>

			{/* inline create panel */}
			{entitled && creating && (
				<div className="mb-4 rounded-lg border border-border bg-surface p-4 shadow-sm">
					<p className="mb-3 text-ui-md font-medium text-text-primary">New team</p>
					<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
						<div className="flex-1">
							<label
								htmlFor="team-name"
								className="mb-1.5 block text-ui-xs text-text-tertiary"
							>
								Team name
							</label>
							<input
								id="team-name"
								className={cn(settingsControl, settingsControlSize)}
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="e.g. Networking"
								autoComplete="off"
								autoFocus
							/>
						</div>
						<div className="flex gap-2">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									setCreating(false);
									setName("");
								}}
							>
								Cancel
							</Button>
							<Button size="sm" disabled={!name.trim()} onClick={() => void create()}>
								Create team
							</Button>
						</div>
					</div>
				</div>
			)}

			{/* table */}
			{rows.length === 0 ? (
				!entitled && all.length === 0 ? (
					<FeatureUpsell feature="teams" />
				) : (
					<EmptyState
						className="border border-border bg-surface-sunken"
						icon={<Users />}
						title={all.length === 0 ? "No teams yet" : "No matching teams"}
						description={
							all.length === 0
								? "Create one to grant access to a group of members at once."
								: "No team matches these filters."
						}
						action={
							all.length === 0 ? undefined : (
								<Button variant="outline" size="sm" onClick={reset}>
									Clear filters
								</Button>
							)
						}
					/>
				)
			) : (
				<DataTable columns={columns} data={rows} pageSize={10} />
			)}

			{manage && (
				<ManageTeamDialog
					teamId={manage.id}
					teamName={manage.name}
					open={manage !== null}
					onOpenChange={(o) => !o && setManage(null)}
					onChanged={invalidate}
				/>
			)}

			<AlertDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this team?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes the team and its membership. Grants made to the team are
							revoked. Members keep their own roles. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => deleting && void remove(deleting)}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							Delete team
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
