"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The per-PROJECT Usage panel — the project analogue of usage-panel.tsx.
//
// It shows only what is genuinely scopeable to one project: its jobs, managed runner job-minutes,
// clusters, estimated cloud cost, and AI credits attributed via ref_id (best-effort — see the
// footnote). Org-wide meters (seats, plan limits, provisioned-runner hours) are NOT per-project,
// so the toolbar links out to the organization usage report for them. Data comes from the
// project-usage server actions through the shared TanStack cache (period-fixed reads are
// server-prefetched + hydrated; the over-time chart re-queries as the range picker changes).
//
// ── The order is usage-panel.tsx's order, deliberately ───────────────────────────────────────
// The two pages answer one question at two scopes, so a reader who has learned one has learned
// the other: what you consumed against the plan · what used it in the window you pick · what you
// run and what it costs outside the plan. They used to open differently (the org page led with
// its meters, this one with a Resources card), group differently, and disagree about where the
// range's job total lives. It lives in `OverTimeCard` on both now, next to the picker that
// changes it, and the fact lists on both hold only what a picker cannot move.
//
// A project has no quota of its own, so section 1 is a plain metered readout rather than gauges —
// that is the one honest difference between the two pages, and `formatMinutes` (not `formatQuota`)
// is where it shows.

import { formatMonthlyRate } from "@repo/format";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Info } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
	getProjectAiUsage,
	getProjectResourceCounts,
	getProjectUsage,
	getProjectUsageOverTime,
} from "@/app/server/actions/project-usage";
import { ErrorState } from "@/components/errors/error-state";
import { SettingsSection } from "@/components/settings/settings-ui";
import {
	count,
	Fact,
	FactList,
	type Metric,
	OverTimeCard,
} from "@/components/settings/usage/usage-primitives";
import { qk } from "@/lib/query/keys";
import { globalHref } from "@/lib/routing";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { formatMinutes } from "@repo/format";
import { Button } from "@repo/ui/button";
import { DateRangeFilter } from "@repo/ui/date-range-filter";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { QuickRangeFilter } from "@repo/ui/quick-range-filter";
import {
	type DateRange,
	DEFAULT_PRESET,
	formatRangeLabel,
	presetRange,
	RANGE_PRESETS,
} from "@repo/ui/range";
import { Skeleton } from "@repo/ui/skeleton";

/**
 * Renders the Usage view for a single project. `projectId` is resolved from the URL slug in
 * the server page; every read is tenant-guarded server-side against the actor's active org.
 */
export function ProjectUsagePanel({ projectId }: { projectId: string }) {
	const orgSlug = useActiveOrgSlug();

	const [range, setRange] = useState<DateRange>(() => presetRange(DEFAULT_PRESET));
	const [rangeLabel, setRangeLabel] = useState(
		RANGE_PRESETS.find((p) => p.id === DEFAULT_PRESET)?.label ?? "Last 7 days",
	);
	const [metric, setMetric] = useState<Metric>("runnerMinutes");

	// Period-fixed reads (server-prefetched + hydrated): runner job-minutes, resource counts, AI.
	const usage = useQuery({
		queryKey: [...qk.projectUsage(projectId), "report"] as const,
		queryFn: () => getProjectUsage(projectId),
	});
	const counts = useQuery({
		queryKey: [...qk.projectUsage(projectId), "counts"] as const,
		queryFn: () => getProjectResourceCounts(projectId),
	});
	const ai = useQuery({
		queryKey: [...qk.projectUsage(projectId), "ai"] as const,
		queryFn: () => getProjectAiUsage(projectId),
	});

	// Range-driven over-time series — re-queries whenever the window changes.
	const overTime = useQuery({
		queryKey: qk.projectUsageOverTime(
			projectId,
			range.from.toISOString(),
			range.to.toISOString(),
		),
		queryFn: () =>
			getProjectUsageOverTime(projectId, {
				from: range.from.toISOString(),
				to: range.to.toISOString(),
			}),
	});

	if (usage.isLoading && !usage.data) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	// A fetch failure must not read as "no usage" (dashes everywhere) — surface it with a retry
	// that refetches every read the panel needs.
	if (usage.isError && !usage.data) {
		return (
			<ErrorState
				title="Couldn't load usage"
				description="Something went wrong fetching this project's usage. Check your connection and try again."
				actions={
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							void usage.refetch();
							void counts.refetch();
							void ai.refetch();
							void overTime.refetch();
						}}
					>
						Retry
					</Button>
				}
			/>
		);
	}

	return (
		<div className="space-y-2">
			{/* No page title — the breadcrumb and the sidebar already say "Usage", and the old
			    "Project usage" heading said nothing more. What the toolbar carries instead is the
			    scope boundary a reader of this page actually needs, and the link that resolves it.
			    That sentence used to be a paragraph at the FOOT of the page carrying a second copy
			    of the same link; one statement, one link, at the top where the boundary applies. */}
			<PageToolbar
				className="pb-2"
				description="Seats, plan limits and provisioned-runner hours are billed org-wide, not per project."
				actions={
					// A plain `<Link>` — see the sibling note in usage-panel.tsx: base-ui's
					// non-native Button puts `role="button"` on the anchor, and this navigates.
					<Link
						href={globalHref(orgSlug, "usage")}
						className="inline-flex items-center gap-1 text-ui-sm text-text-secondary transition-colors hover:text-text-primary"
					>
						View organization usage
						<ArrowUpRight size={13} />
					</Link>
				}
			/>

			{/* 1 · Metered this period — runner job-minutes + AI credits, the units Alethia bills
			    for and can attribute to one project. The org page's section 1 in its project form:
			    a project has no quota, so these are readouts and not gauges. */}
			<SettingsSection title="Metered usage this period">
				<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
					<FactList>
						<Fact
							label="Runner job-minutes"
							value={
								// `jobMinutes` is a float; a local Math.round here was one of the four
								// disagreeing minutes readouts. formatMinutes owns the rounding now.
								// No allowance to render against — a project has no quota of its own,
								// so this is `formatMinutes` and not `formatQuota`.
								usage.data ? formatMinutes(usage.data.jobMinutes) : "—"
							}
							sub={
								usage.data
									? `${count(usage.data.jobCount)} managed jobs this period`
									: "managed runner usage this period"
							}
						/>
						<Fact
							label="AI credits used"
							value={ai.data ? count(ai.data.creditsThisPeriod) : "—"}
							sub="attributed to this project *"
						/>
					</FactList>
					<div className="flex items-center gap-2 border-t border-border bg-surface-sunken px-6 py-[14px] text-ui-sm text-text-tertiary">
						<Info size={13} />
						<span>
							* AI credits are attributed to a project via the scan job or agent thread
							that spent them; usage that isn&apos;t tied to a project (e.g. support
							Ask&nbsp;AI) is counted only at the organization level.
						</span>
					</div>
				</div>
			</SettingsSection>

			{/* 2 · Usage over time — cumulative, and the only home for a number the range picker
			    can move. The project's job total lived in the Resources card above the picker;
			    it lives beside the picker now. */}
			<SettingsSection
				title="Usage over time"
				action={
					<div className="flex flex-wrap items-center gap-2">
						<QuickRangeFilter
							label={rangeLabel}
							value={range}
							onChange={(r, l) => {
								setRange(r);
								setRangeLabel(l);
							}}
						/>
						<DateRangeFilter
							value={range}
							onChange={(r) => {
								setRange(r);
								setRangeLabel(formatRangeLabel(r));
							}}
						/>
					</div>
				}
			>
				<OverTimeCard
					metric={metric}
					onMetricChange={setMetric}
					series={overTime.data?.series}
					totals={overTime.data?.totals}
					// `&& !overTime.data` so a refetch that fails keeps showing the window it already
					// has rather than replacing real bars with an error; react-query leaves the last
					// good `data` in place across a failed refetch, and stale-but-labelled beats blank.
					error={overTime.isError && !overTime.data}
					rangeLabel={rangeLabel}
				/>
			</SettingsSection>

			{/* 3 · Resources — what this project runs right now, and what those things cost OUTSIDE
			    the plan. Same position, same closing row and same provider footnote as the org
			    page's third section, because it is the same distinction one scope down. The org
			    page stated that separately-billed caveat and this page did not. */}
			<SettingsSection title="Resources">
				<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
					<FactList>
						<Fact
							label="Clusters"
							value={counts.data ? count(counts.data.clusters) : "—"}
							sub="under management"
						/>
						<Fact
							label="Running jobs"
							value={usage.data ? count(usage.data.runningJobs) : "—"}
							sub="in flight right now"
						/>
						{/* In the list, not under it — see the sibling comment in usage-panel.tsx. */}
						<Fact
							className="border-t bg-surface-sunken"
							icon={<Info size={13} />}
							label="Estimated cloud spend for this project"
							value={
								counts.data
									? formatMonthlyRate(counts.data.estimatedMonthlyCost)
									: "—"
							}
						/>
					</FactList>
					<div className="flex items-center gap-2 border-t border-border bg-surface-sunken px-6 py-[14px] text-ui-sm text-text-tertiary">
						<Info size={13} />
						Your cloud-resource spend is billed separately by your provider.
					</div>
				</div>
			</SettingsSection>
		</div>
	);
}
