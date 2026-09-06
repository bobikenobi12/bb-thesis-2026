"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Fleet / Runners page. A two-column layout (mirrors the org overview): the left column
// stacks the warm Pools and the Versions changelog; the right column is the filterable,
// paginated grid of runner cards. No eyebrow/title/KPI chrome — pools and runners show first.

import { lookup } from "@/lib/typed-object";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { AddRunnerButton } from "@/components/runners/add-runner-button";
import { ErrorState } from "@/components/errors/error-state";
import { PoolCard, PoolCardSkeleton, PoolsEmpty } from "@/components/runners/pool-card";
import { FleetPoolWizard } from "@/components/runners/fleet-pool-wizard";
import { RunnerCard, RunnerCardSkeleton } from "@/components/runners/runner-card";
import { type RunnerRow } from "@/components/runners/runner-actions";
import {
	RunnersToolbar,
	matchesRunnerFilters,
	type RunnerFacetOption,
} from "@/components/runners/runners-toolbar";
import { RunnersPager } from "@/components/runners/runners-pager";
import { VersionsPanel } from "@/components/runners/versions-panel";
import type { CloudFilterOption } from "@/components/filters/cloud-filter";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import {
	DEFAULT_RUNNER_FILTERS,
	useRunnerFilters,
} from "@/lib/stores/use-runner-filters";
import { PROVIDER_LABELS, type Provider } from "@repo/ui/provider-icon";
import { useRunnersQuery, type ActiveJob } from "@/lib/query/use-runners-query";
import { useAssignmentsForKind } from "@/lib/query/use-classification-query";
import { useJobsQuery } from "@/lib/query/use-jobs-query";
import {
	useFleetQuery,
	useSetPoolEnabled,
	useDeletePool,
} from "@/lib/query/use-fleet-query";
import { useIsHosted } from "@/lib/stores/use-workspace-store";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { FeatureUpsell } from "@/components/settings/upgrade/feature-upsell";
import type { FleetPool, ProvisionJobType as PublicProvisionJobType } from "@/lib/db/schema";
import { Plus, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const PAGE_SIZE = 9;
const RUNNER_JOB_TYPES = new Set<PublicProvisionJobType>([
	"DEPLOY_RUNNER",
	"UPDATE_RUNNER",
	"DESTROY_RUNNER",
]);

export function RunnersClient() {
	const {
		data: runnersData,
		isPending: isLoading,
		isError,
		refetch,
	} = useRunnersQuery();
	const runners = runnersData?.runners ?? [];
	// Deployment-mode + entitlement gating. Self-managed operators see everything; hosted tenants
	// need the byoRunners entitlement (Pro+) for the runner surface, and never see managed pools.
	const isHosted = useIsHosted();
	const canByoRunners = useEntitlement("byoRunners");

	const { data: allJobs = [] } = useJobsQuery();
	const activeJobs: ActiveJob[] = useMemo(
		() =>
			allJobs
				.filter((j) => j.status === "QUEUED" || j.status === "CLAIMED" || j.status === "PROCESSING")
				.map((j) => ({
					id: j.id,
					job_type: j.job_type,
					status: j.status,
					config_snapshot: j.config_snapshot,
					runner_id: j.runner_id,
					project_id: j.project_id,
					projects: j.project_name ? { project_name: j.project_name } : null,
				})),
		[allJobs],
	);

	// Configured warm pools joined with observed reality (left column). Polled on the same
	// cadence as the runner list by the fleet query.
	const { data: fleet, isSuccess: fleetLoaded } = useFleetQuery();
	const poolViews = fleet?.pools ?? [];
	const poolConfigs = fleet?.configs ?? [];
	const economics = fleet?.economics ?? null;
	const fleetProviderActive = fleet?.fleetProviderActive ?? false;
	const canManageFleet = fleet?.canManageFleet ?? false;
	const { mutateAsync: setPoolEnabled } = useSetPoolEnabled();
	const { mutateAsync: deletePool } = useDeletePool();

	const econByProvider = useMemo(
		() => new Map((economics?.pools ?? []).map((p) => [p.provider, p])),
		[economics],
	);

	// The console filter standard (#578): zustand store + URL sync + debounced search.
	const filters = useRunnerFilters((s) => s.filters);
	useFilterUrlSync(useRunnerFilters, DEFAULT_RUNNER_FILTERS);
	const search = useDebouncedValue(filters.search, 300);
	const [page, setPage] = useState(1);

	// Pool editor dialog: null pool = create, a row = edit.
	const [poolDialogOpen, setPoolDialogOpen] = useState(false);
	const [editingPool, setEditingPool] = useState<FleetPool | null>(null);

	// Reset to the first page whenever the result set changes shape.
	useEffect(() => {
		setPage(1);
	}, [search, filters]);

	const openCreatePool = () => {
		setEditingPool(null);
		setPoolDialogOpen(true);
	};
	const openEditPool = (id: string) => {
		setEditingPool(poolConfigs.find((c) => c.id === id) ?? null);
		setPoolDialogOpen(true);
	};
	const handleTogglePool = async (id: string, enabled: boolean) => {
		try {
			await setPoolEnabled({ id, enabled: !enabled });
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to update pool");
		}
	};
	const handleDeletePool = async (id: string) => {
		try {
			await deletePool(id);
			toast.success("Pool deleted");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to delete pool");
		}
	};

	// Join each runner to its in-flight lifecycle job (deploy/update/destroy target it by id
	// in the config snapshot; everything else by runner_id).
	const jobsByRunner = useMemo(() => {
		const map = new Map<string, ActiveJob>();
		for (const job of activeJobs) {
			if (RUNNER_JOB_TYPES.has(job.job_type)) {
				const targetId = job.config_snapshot.runner_id;
				if (typeof targetId === "string") map.set(targetId, job);
			} else if (job.runner_id) {
				map.set(job.runner_id, job);
			}
		}
		return map;
	}, [activeJobs]);

	const runnerRows: RunnerRow[] = useMemo(
		() => runners.map((w) => ({ ...w, activeJob: jobsByRunner.get(w.id) ?? null })),
		[runners, jobsByRunner],
	);

	// Filter facets with counts over the UNFILTERED runner set (the standard: options never
	// disappear as you select them — the whole universe is already loaded on this page).
	const facets = useMemo(() => {
		const clouds = new Map<string, number>();
		const regions = new Map<string, number>();
		const versions = new Map<string, number>();
		const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
		for (const r of runnerRows) {
			if (!r.supported_providers || r.supported_providers.length === 0) bump(clouds, "any");
			else for (const p of r.supported_providers) bump(clouds, p);
			if (r.location) bump(regions, r.location);
			const v = r.runner_releases?.version ?? r.version;
			if (v) bump(versions, v);
		}
		const cloudOptions: CloudFilterOption[] = [...clouds.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([value, count]) => ({
				value,
				label:
					value === "any" ? "Any" : (lookup(PROVIDER_LABELS, value) ?? value.toUpperCase()),
				count,
			}));
		const asOptions = (m: Map<string, number>, label: (v: string) => string): RunnerFacetOption[] =>
			[...m.entries()].map(([value, count]) => ({ value, label: label(value), count }));
		return {
			clouds: cloudOptions,
			regions: asOptions(regions, (v) => v).sort((a, b) => a.value.localeCompare(b.value)),
			versions: asOptions(versions, (v) => `v${v}`).sort((a, b) =>
				b.value.localeCompare(a.value),
			),
		};
	}, [runnerRows]);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		return runnerRows.filter((r) => {
			if (q && !r.name.toLowerCase().includes(q)) return false;
			return matchesRunnerFilters(r, filters);
		});
	}, [runnerRows, search, filters]);

	const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	const safePage = Math.min(page, pageCount);
	const pageItems = useMemo(
		() => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
		[filtered, safePage],
	);

	const hasPools = poolViews.length > 0;

	// One batched query hydrates the visible runner cards' classification chips.
	const { data: classMap = {} } = useAssignmentsForKind(
		"runner",
		pageItems.map((r) => r.id),
	);

	// Hosted tenants without the BYO-runners entitlement get the upsell in place of the page.
	// (Self-managed operators are never gated here.)
	if (isHosted && !canByoRunners) {
		return <FeatureUpsell feature="byoRunners" />;
	}

	return (
		<>
			<div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(320px,0.36fr)_minmax(0,0.64fr)]">
				{/* Left column — pools (self-managed only), then versions. */}
				<div className="flex flex-col gap-6">
					{!isHosted && (
					<section className="space-y-3">
						<div className="flex items-center justify-between gap-2">
							<div className="flex items-baseline gap-2">
								<span className="text-sm font-semibold tracking-tight text-foreground">Pools</span>
								{hasPools && (
									<span className="font-mono text-ui-2xs uppercase tracking-[0.08em] text-muted-foreground">
										{poolViews.length} configured
									</span>
								)}
							</div>
							{canManageFleet && (
								<Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={openCreatePool}>
									<Plus className="mr-1 h-3.5 w-3.5" /> Add pool
								</Button>
							)}
						</div>

						{canManageFleet && hasPools && !fleetProviderActive && (
							<p className="border border-dashed border-border px-3 py-2 font-mono text-ui-2xs leading-relaxed text-muted-foreground">
								No cloud provider wired — pools are advisory. Set{" "}
								<span className="text-foreground">FLEET_PROVIDER=hcloud</span> to provision real runners.
							</p>
						)}

						{!fleetLoaded ? (
							<div className="space-y-4">
								<PoolCardSkeleton />
								<PoolCardSkeleton />
							</div>
						) : hasPools ? (
							<div className="space-y-4">
								{poolViews.map((pool) => (
									<PoolCard
										key={pool.id}
										pool={pool}
										economics={econByProvider.get(pool.provider)}
										canManage={canManageFleet}
										onEdit={canManageFleet ? () => openEditPool(pool.id) : undefined}
										onToggle={canManageFleet ? () => handleTogglePool(pool.id, pool.enabled) : undefined}
										onDelete={canManageFleet ? () => handleDeletePool(pool.id) : undefined}
									/>
								))}
							</div>
						) : (
							<PoolsEmpty />
						)}
					</section>
					)}

					<VersionsPanel />
				</div>

				{/* Right column — runners. */}
				<div className="min-w-0 space-y-4">
					<div className="flex items-center justify-between gap-3">
						<div className="flex items-baseline gap-2">
								<span className="font-display text-ui-lg font-semibold tracking-tight">Runners</span>
							{/* The count pill shows the RESULT count (the standard) — never "N of M" prose. */}
								<span className="rounded-full border px-2 py-0.5 font-mono text-ui-2xs text-muted-foreground">
								{filtered.length}
							</span>
						</div>
						<AddRunnerButton />
					</div>

					<RunnersToolbar
						cloudOptions={facets.clouds}
						regionOptions={facets.regions}
						versionOptions={facets.versions}
					/>

					{isError ? (
						// A fetch failure must not render as "no runners".
						<ErrorState
							title="Couldn't load runners"
							description="Something went wrong fetching your runners. Check your connection and try again."
							actions={
								<Button variant="outline" size="sm" onClick={() => refetch()}>
									Retry
								</Button>
							}
						/>
					) : isLoading && runners.length === 0 ? (
						<div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
							{[1, 2, 3, 4].map((i) => (
								<RunnerCardSkeleton key={i} />
							))}
						</div>
					) : runnerRows.length === 0 ? (
						<EmptyRunners />
					) : filtered.length === 0 ? (
						<EmptyState title="No runners match your filters." className="py-12" />
					) : (
						<>
							<div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
								{pageItems.map((runner) => (
									<RunnerCard
										key={runner.id}
										runner={runner}
										initialAssignments={classMap[runner.id]}
									/>
								))}
							</div>
							<RunnersPager
								page={safePage}
								pageCount={pageCount}
								total={filtered.length}
								onPageChange={setPage}
							/>
						</>
					)}
				</div>
			</div>

			{canManageFleet && (
				<FleetPoolWizard
					open={poolDialogOpen}
					onOpenChange={setPoolDialogOpen}
					pool={editingPool}
					usedProviders={poolConfigs.map((c) => c.provider)}
				/>
			)}
		</>
	);
}

/** First-run state when no runners exist at all. */
function EmptyRunners() {
	return (
		<EmptyState
			icon={<Server />}
			level={3}
			title="No runners yet"
			description="Runners execute provisioning jobs. Managed runners are operated and billed by Alethia; you can also deploy your own into a cloud account or register an existing one."
			action={<AddRunnerButton />}
			className="py-16"
		/>
	);
}
