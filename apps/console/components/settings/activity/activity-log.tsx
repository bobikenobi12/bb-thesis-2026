"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Activity — a Vercel-style natural-language feed of the org's Activity events
// (every recorded action + denials), fronted by reusable filters: time-range (quick + calendar),
// User, Project, and an event-type sheet. Viewing is available on every plan; CSV export is
// Enterprise-gated, and time windows older than the plan's retention prompt an upgrade.
// Filtering + pagination are server-side (cursor by id): every filter change refetches page 1,
// and "Load more" pages in older rows. Resource names are resolved from the projects store +
// members for the humanizer; the Project filter is resolved to project ids server-side. When
// pinned to a `projectId` (project settings) the feed locks to that project and hides the facet.

import { Boxes, Download, ListFilter, Users } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type ActivityRow,
	getActivityExportCsv,
} from "@/app/server/actions/activity";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useActivityQuery, useMembersQuery } from "@/lib/query/use-activity-query";
import { ErrorState } from "@/components/errors/error-state";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { UpgradeOrgSheet } from "@/components/org/upgrade-org-sheet";
import { useProjectsQuery } from "@/lib/query/use-projects-query";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useActivityFilters } from "@/lib/stores/use-settings-filters";
import {
	useActiveOrgSlug,
	useWorkspaceStore,
} from "@/lib/stores/use-workspace-store";
import { Button } from "@repo/ui/button";
import { DateRangeFilter } from "@repo/ui/date-range-filter";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { GroupedFilterSheet } from "@repo/ui/grouped-filter-sheet";
import { SectionHeading } from "@repo/ui/section-heading";
import { QuickRangeFilter } from "@repo/ui/quick-range-filter";
import {
	type DateRange,
	DEFAULT_PRESET,
	formatRangeLabel,
	presetRange,
	RANGE_PRESETS,
} from "@repo/ui/range";
import { Skeleton } from "@repo/ui/skeleton";
import {
	activityQueryFrom,
	activityRange,
	DEFAULT_ACTIVITY_FILTERS,
} from "./activity-filters";
import { ActivityFeed } from "./activity-feed";
import { type ActivityContext, EVENT_GROUPS } from "./humanize-event";

const DAY = 86_400_000;
// A small grace so a preset that lands exactly on the retention boundary (e.g. Hobby's
// "Last 7 days") isn't tripped as "too far back" by the few ms between resolving the
// preset and re-reading the clock in the guard.
const RETENTION_GRACE = 3_600_000;
const SEARCH_DEBOUNCE = 300;

/** The default range picker's trigger label. */
const DEFAULT_RANGE_LABEL =
	RANGE_PRESETS.find((p) => p.id === DEFAULT_PRESET)?.label ?? "Last 7 days";

/** The org Activity feed. Pass `projectId` (a project id) to scope it to a single project's
 * events — used by `/{org}/{project}/settings/activity`; the Project facet is then hidden. */
export function ActivityLog({ projectId }: { projectId?: string } = {}) {
	const orgSlug = useActiveOrgSlug();
	const canExport = useEntitlement("activityExport");
	const retentionDays = useWorkspaceStore(
		(s) => s.entitlements?.quotas.activityRetentionDays ?? 7,
	);
	const { data: projects = [] } = useProjectsQuery();

	// Members drive the filter options + the humanizer's name resolution (projects come
	// from the shared query cache; members from theirs — no fetch-into-state effect).
	const { data: members = [] } = useMembersQuery();

	// Filter state: the store is the source of truth, the URL mirrors it (shareable views),
	// and the free text is debounced before it can reach a query key. Nine `useState` calls
	// collapse to one store plus the two that are genuinely not filters (export + upgrade).
	const filters = useActivityFilters((s) => s.filters);
	const set = useActivityFilters((s) => s.set);
	const patch = useActivityFilters((s) => s.patch);
	const reset = useActivityFilters((s) => s.reset);
	useFilterUrlSync(useActivityFilters, DEFAULT_ACTIVITY_FILTERS);
	const debouncedSearch = useDebouncedValue(filters.search, SEARCH_DEBOUNCE);

	// The default window is resolved ONCE. Resolving it per render would move `to` forward
	// every time and produce a query key that never settles, refetching on every paint.
	const [defaultRange] = useState<DateRange>(() => presetRange(DEFAULT_PRESET));
	const range = useMemo(
		() => activityRange(filters, defaultRange),
		[filters, defaultRange],
	);
	const rangeLabel = filters.rangeLabel || DEFAULT_RANGE_LABEL;

	const [exporting, setExporting] = useState(false);
	const [upgradeOpen, setUpgradeOpen] = useState(false);

	// Resource-name lookups that drive the humanizer's name resolution.
	const lookups = useMemo(() => {
		const projectName = new Map<string, string>();
		for (const p of projects) projectName.set(p.id, p.project_name);
		const memberName = new Map<string, string>();
		for (const m of members) memberName.set(m.userId, m.name?.trim() || m.email);
		return { projectName, memberName };
	}, [projects, members]);

	const ctx = useMemo<ActivityContext>(
		() => ({
			resolveName: (type, id) => {
				if (!id) return null;
				if (type === "project") return lookups.projectName.get(id) ?? null;
				if (type === "member" || type === "invitation")
					return lookups.memberName.get(id) ?? null;
				return null;
			},
		}),
		[lookups],
	);

	// The NORMALIZED query the current filters describe (sans cursor) — it IS the query
	// key, so equal filters hit the cache (the standard). When the feed is locked to a
	// `projectId` (project settings) that scope is forced; otherwise the Project facet
	// drives the `resourceIds` (the selected project ids), keeping scoping server-side.
	const query = useMemo(
		() =>
			activityQueryFrom({
				filters,
				range,
				search: debouncedSearch,
				pinnedProjectId: projectId,
			}),
		[filters, range, debouncedSearch, projectId],
	);

	// Cursor-paginated fetch, filters in the key, keepPreviousData across filter changes —
	// replaces the raw `useEffect` + `cancelled`-flag chain (forbidden by the standard).
	const activity = useActivityQuery(query);
	const rows = useMemo<ActivityRow[]>(
		() => (activity.data?.pages ?? []).flatMap((p) => p.rows),
		[activity.data],
	);
	const nextCursor = activity.data?.pages.at(-1)?.nextCursor ?? null;
	const loading = activity.isPending;
	const loadingMore = activity.isFetchingNextPage;

	/** Fetch the next page (older rows); TanStack appends it to `pages`. */
	const onLoadMore = useCallback(async () => {
		if (nextCursor == null || loadingMore) return;
		try {
			await activity.fetchNextPage();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to load more activity");
		}
	}, [activity, nextCursor, loadingMore]);

	/** Apply a picked range, or prompt upgrade when it predates the plan's retention. */
	const applyRange = useCallback(
		(next: DateRange, label: string) => {
			const minFrom = Date.now() - retentionDays * DAY - RETENTION_GRACE;
			if (next.from.getTime() < minFrom) {
				setUpgradeOpen(true);
				return;
			}
			patch({
				from: next.from.toISOString(),
				to: next.to.toISOString(),
				rangeLabel: label,
			});
		},
		[retentionDays, patch],
	);

	// Facet options come from the org's FULL member / project lists (their own shared query
	// caches), never from the rows on screen — an option that vanished as you selected it
	// would make the facet unusable. That is the standard's unfiltered-universe rule.
	const userOptions = useMemo(
		() =>
			members.map((m) => ({
				value: m.userId,
				label: m.name?.trim() || m.email,
				hint: m.name?.trim() ? m.email : undefined,
			})),
		[members],
	);
	const projectOptions = useMemo(
		() => projects.map((p) => ({ value: p.id, label: p.project_name })),
		[projects],
	);
	const activeFilters = countActiveFilters(filters, DEFAULT_ACTIVITY_FILTERS);

	async function onExport() {
		setExporting(true);
		try {
			const csv = await getActivityExportCsv();
			const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = "activity-log.csv";
			a.click();
			URL.revokeObjectURL(url);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Export failed");
		} finally {
			setExporting(false);
		}
	}

	const projectName = projectId ? lookups.projectName.get(projectId) : undefined;

	return (
		<div>
			{projectId && (
				<p className="mb-3 text-ui-md text-text-tertiary">
					Activity in{" "}
					<span className="font-medium text-text-secondary">
						{projectName ?? "this project"}
					</span>
					.
				</p>
			)}
			{/* The result count lives beside the heading, never as prose in the bar. This feed is
			    cursor-paginated, so it counts the rows LOADED so far — "42" here means 42 on
			    screen, and "Load more" moves it.

			    `SectionHeading`'s `count` renders through the same `CountPill` this used to mount by
			    hand, which is the whole reason the pair belongs to the primitive: the standard
			    says where a result count goes, and a local heading + pill is a second answer to a
			    question already settled. */}
			<SectionHeading
				className="mb-3"
				title="Activity"
				count={loading ? null : rows.length}
			/>

			<FilterBar
				end={
					// `end` is the primitive's slot for a page-level action; export dumps the
					// WHOLE org log, so it only belongs on the org-scoped feed.
					!projectId ? (
						<Button
							variant="outline"
							size="sm"
							disabled={!canExport || exporting}
							title={
								canExport ? undefined : "Activity export requires the Enterprise plan"
							}
							onClick={() => void onExport()}
						>
							<Download size={13} />
							Export CSV
						</Button>
					) : undefined
				}
			>
				<FilterSearch
					value={filters.search}
					onChange={(v) => set("search", v)}
					placeholder="Search actor, action or resource…"
					className="w-[240px] max-w-[380px] flex-1"
				/>
				<QuickRangeFilter
					label={rangeLabel}
					value={range}
					onChange={(r, l) => applyRange(r, l)}
				/>
				<DateRangeFilter
					value={range}
					onChange={(r) => applyRange(r, formatRangeLabel(r))}
				/>
				<FacetFilter
					label="User"
					icon={Users}
					options={userOptions}
					value={filters.actorIds}
					onChange={(next) => set("actorIds", next)}
					searchPlaceholder="Search members…"
					emptyText="No members."
				/>
				{/* Project scope is locked when the feed is pinned to a project — hide the facet. */}
				{!projectId && (
					<FacetFilter
						label="Project"
						icon={Boxes}
						options={projectOptions}
						value={filters.projectIds}
						onChange={(next) => set("projectIds", next)}
						searchPlaceholder="Search projects…"
						emptyText="No projects."
					/>
				)}
				<GroupedFilterSheet
					label="Events"
					icon={ListFilter}
					groups={EVENT_GROUPS}
					value={filters.eventTokens}
					onChange={(next) => set("eventTokens", next)}
					title="Filter by event"
					description="Show only the event types you care about."
				/>
				<FilterBarReset count={activeFilters} onReset={reset} />
			</FilterBar>

			{activity.isError ? (
				// A fetch failure must not render as an empty activity feed.
				<ErrorState
					title="Couldn't load activity"
					description="Something went wrong fetching the activity log. Check your connection and try again."
					actions={
						<Button
							variant="outline"
							size="sm"
							onClick={() => activity.refetch()}
						>
							Retry
						</Button>
					}
				/>
			) : loading && rows.length === 0 ? (
				<div className="space-y-3">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : (
				<ActivityFeed
					rows={rows}
					ctx={ctx}
					onLoadMore={() => void onLoadMore()}
					hasMore={nextCursor != null}
					loadingMore={loadingMore}
				/>
			)}

			<UpgradeOrgSheet
				open={upgradeOpen}
				onOpenChange={setUpgradeOpen}
				orgSlug={orgSlug}
			/>
		</div>
	);
}
