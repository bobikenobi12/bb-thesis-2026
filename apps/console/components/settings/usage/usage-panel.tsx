"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The organization Usage page.
//
// ── The order, and why it is this one ────────────────────────────────────────────────────────
// An operator opens a usage page with three questions, and they are not equally urgent:
//
//   1. Am I about to be stopped or charged?   → "Plan & limits": seats, runner minutes and
//      concurrency as gauges against the plan, plus the hard cap that turns overage into a stop.
//      This is first because it is the only part that is ACTIONABLE NOW.
//   2. What used it?                          → "Usage over time": the range picker and every
//      number the range picker moves — runner minutes, jobs, AI credits.
//   3. What am I running, and what does that cost outside the plan? → "Resources": projects,
//      clusters, and the estimated cloud spend those clusters carry. LAST, because none of it is
//      a number anyone acts on — it is the context the two sections above are measured in.
//   4. AI is its own budget model (weekly window + purchased balance + top-up) and keeps its
//      own section.
//
// Two things moved, and each fixes a real defect rather than rearranging furniture:
//
//   • The range's JOB TOTAL used to sit in the Resources card near the top of the page while the
//     picker that changes it lived two sections below — a control silently rewriting a number
//     above it. Every range-scoped number now lives in `OverTimeCard`, beside its picker, and
//     what is left in the fact list is point-in-time only.
//   • "Your cloud-resource spend is billed separately by your provider" used to be a band on the
//     PLAN & LIMITS card, under the seats/minutes/concurrency meters — nowhere near a cloud
//     spend figure, qualifying numbers it has nothing to do with. It is now the footnote of the
//     card that states the cloud spend, which is the only figure on the page it is about.
//
// Hobby orgs get an inline "Upgrade to Pro" (UpgradeOrgSheet); subscription/payment management
// still lives on the Billing page.

import { formatMonthlyRate } from "@repo/format";
import { ArrowUpRight, Building2, Info } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	type BillingSummary,
	getBillingSummary,
	getOrgUsage,
	getResourceCounts,
	getUsageOverTime,
	type ResourceCountsReport,
	setUsageHardCap,
	type UsageOverTime,
	type UsageReport,
} from "@/app/server/actions/billing";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { UpgradeOrgSheet } from "@/components/org/upgrade-org-sheet";
import { AiUsageSection } from "@/components/settings/usage/ai-usage-section";
import {
	count,
	countQuota,
	Fact,
	FactList,
	type Metric,
	Meter,
	OverTimeCard,
} from "@/components/settings/usage/usage-primitives";
import { SettingsSection } from "@/components/settings/settings-ui";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { formatDate, formatMinutes, formatMoney, formatQuota } from "@repo/format";
import { planMeta } from "@repo/plan-catalog";
import { Button } from "@repo/ui/button";
import { Card } from "@repo/ui/card";
import { DateRangeFilter } from "@repo/ui/date-range-filter";
import { EmptyState } from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
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

/** Renders the organization's Usage view. See the taxonomy note at the top of this file. */
export function UsagePanel() {
	const orgSlug = useActiveOrgSlug();
	const [summary, setSummary] = useState<BillingSummary | null>(null);
	const [usage, setUsage] = useState<UsageReport | null>(null);
	const [counts, setCounts] = useState<ResourceCountsReport | null>(null);
	const [overTime, setOverTime] = useState<UsageOverTime | null>(null);
	// Distinct from `overTime === null`, which this panel also uses for "not asked yet".
	// Without the second flag a failed window is indistinguishable from a pending one and
	// `OverTimeCard` renders its skeleton forever. See the `error` prop's doc.
	const [overTimeFailed, setOverTimeFailed] = useState(false);

	const [range, setRange] = useState<DateRange>(() => presetRange(DEFAULT_PRESET));
	const [rangeLabel, setRangeLabel] = useState(
		RANGE_PRESETS.find((p) => p.id === DEFAULT_PRESET)?.label ?? "Last 7 days",
	);
	const [metric, setMetric] = useState<Metric>("runnerMinutes");

	const [pending, startTransition] = useTransition();
	const [createOpen, setCreateOpen] = useState(false);
	const [upgradeOpen, setUpgradeOpen] = useState(false);

	// Period-fixed data (seats, runner-minutes this period, resource counts, AI standing).
	const refresh = useCallback(() => {
		getBillingSummary()
			.then(setSummary)
			.catch(() => toast.error("Couldn't load usage."));
		getOrgUsage()
			.then(setUsage)
			.catch(() => {
				/* best-effort; the meter just shows a dash */
			});
		getResourceCounts()
			.then(setCounts)
			.catch(() => {
				/* best-effort */
			});
	}, []);
	useEffect(() => {
		refresh();
	}, [refresh]);

	// Range-driven data (the over-time chart) re-queries whenever the window changes.
	//
	// BOTH pieces of state are reset before the request, and the clear is the half that used to be
	// missing. `rangeLabel` updates synchronously with the picker, so leaving the previous window's
	// series in place captioned the OLD bars with the NEW window — seven days of data labelled
	// "last 30 days" for the length of the refetch. It also made the card's "has not answered yet"
	// branch unreachable on this panel while the PROJECT panel hit it on every picker change, which
	// is precisely the divergence the shared component exists to prevent.
	useEffect(() => {
		let active = true;
		setOverTime(null);
		setOverTimeFailed(false);
		getUsageOverTime({ from: range.from.toISOString(), to: range.to.toISOString() })
			.then((d) => active && setOverTime(d))
			.catch(() => active && setOverTimeFailed(true));
		return () => {
			active = false;
		};
	}, [range]);

	if (!summary) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	// Self-managed / community: no Stripe metering — usage is a hosted-billing concept.
	if (!summary.hosted) {
		return (
			<Card className="p-6">
				<SectionHeading
					title="Self-managed deployment"
					description="This instance isn't connected to hosted billing, so usage isn't metered here."
				/>
			</Card>
		);
	}

	// Free user with no org yet: usage is per-organization. This is an EMPTY STATE — a thing that
	// is not here plus the single step that makes it exist — so it renders through `@repo/ui/empty`
	// rather than a Card with a heading and a loose button under it, which is the shape that
	// component exists to stop being re-derived per page.
	if (!summary.hasOrg) {
		return (
			<div>
				<EmptyState
					className="border border-dashed border-border"
					icon={<Building2 size={20} />}
					title="No organization yet"
					description="Usage is metered per organization. Create one to track seats, runner minutes, and AI against a plan."
					action={
						<Button onClick={() => setCreateOpen(true)}>Create organization</Button>
					}
				/>
				<CreateOrgSheet open={createOpen} onOpenChange={setCreateOpen} />
			</div>
		);
	}

	const isCommunity = summary.plan === "community" || summary.status === "none";
	// An ABSENT seat cap fills 0, not 100 — the same answer the concurrency meter below already
	// gives for the identical "the plan sets no limit" case. Filling the gauge instead made a Hobby
	// org render `3 / ∞` above a bar drawn solid to its end: "no cap" and "at the cap" stated in one
	// cell. A gauge with no denominator has no fraction to draw, and 0 is the only reading of it
	// that does not assert one.
	const seatFill =
		summary.seats != null && summary.seats > 0
			? (summary.memberCount / summary.seats) * 100
			: 0;
	const concurrencyMax = usage?.maxConcurrentJobs ?? null;
	// ONE percentage, read twice. The two `sub` branches below each used to compute
	// `Math.round(usage.pct * 100)` for themselves — two expressions, two lines apart, that a
	// later edit could change independently while both claim to be "% of included".
	const pctUsed = usage ? Math.round(usage.pct * 100) : 0;

	return (
		<div className="space-y-2">
			{/* No page title: the sidebar entry and the breadcrumb both already say "Usage". What
			    neither of them says is WHICH PLAN and WHICH PERIOD every number below is measured
			    against, which is what this row carries — plus the one action a usage page has. */}
			<PageToolbar
				className="pb-2"
				description={
					<>
						{/* The plan name is its own element and the period is a quieter one beside
						    it: they are a fact and a qualifier ON that fact, not one sentence. */}
						<span>{planMeta(summary.plan).name} plan</span>
						{usage ? (
							<span className="text-text-tertiary">
								{" · "}period to {formatDate(usage.periodEnd)}
							</span>
						) : null}
					</>
				}
				actions={
					isCommunity ? (
						<Button size="sm" onClick={() => setUpgradeOpen(true)}>
							Upgrade to Pro
							<ArrowUpRight size={14} />
						</Button>
					) : (
						// A plain `<Link>`, not `<Button render={<Link/>} nativeButton={false}>`:
						// base-ui's non-native branch puts `role="button"` on the anchor, and this
						// is navigation to the billing page, not an action on this one. The
						// console uses the Button form for links that ARE the page's action; a
						// "go and read the other page" affordance stays a link.
						<Link
							href={`/${orgSlug}/settings/billing`}
							className="inline-flex items-center gap-1 text-ui-sm text-text-secondary transition-colors hover:text-text-primary"
						>
							Manage billing
							<ArrowUpRight size={13} />
						</Link>
					)
				}
			/>

			{/* 1 · Plan & limits — point-in-time gauges vs the plan, this billing period. First
			    because it is the only section an operator can act on right now. */}
			<SettingsSection title="Plan & limits">
				<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
					<div className="grid grid-cols-1 sm:grid-cols-3">
						<Meter
							label="Seats"
							// `countQuota`, not a locally assembled pair: this cell printed a bare
							// `3` when the plan set no seat cap while the concurrency cell two
							// columns right printed `2 / ∞` for the same "no limit". An absent
							// allowance is `∞` at both now.
							value={countQuota(summary.memberCount, summary.seats)}
							fill={seatFill}
							sub={
								summary.seats != null
									? `${count(Math.max(0, summary.seats - summary.memberCount))} seats available`
									: "members in this organization"
							}
						/>
						<Meter
							label="Runner minutes"
							value={
								// `formatQuota`, not a locally assembled pair. `usedMinutes` is a FLOAT
								// — rendered raw it read `0.943` here and `0` after a local Math.round
								// — and the pair around it is the second half of the same problem:
								// this file printed `47 min / 200` while the helper written for
								// exactly this readout prints `47 min / 200 min`. One function, one
								// answer; the allowance still stays the plain integer the plan and
								// the pricing page quote.
								usage ? formatQuota(usage.usedMinutes, usage.includedMinutes) : "—"
							}
							fill={usage ? usage.pct * 100 : 0}
							sub={
								!usage
									? "managed runner usage this period"
									: usage.overLimit
										// `overageCost` is USD MAJOR units (lib/billing/usage.ts rounds it to
										// cents), so it is scaled UP by 100 for formatMoney, which takes cents.
										? `${formatMinutes(usage.overageMinutes)} over · ~${formatMoney(Math.round(usage.overageCost * 100))} overage`
										: usage.approaching
											? `${pctUsed}% used — approaching included`
											: `${pctUsed}% of included · self-hosted is free`
							}
						/>
						<Meter
							label="Concurrency"
							value={countQuota(usage?.runningJobs ?? 0, concurrencyMax)}
							fill={
								concurrencyMax && concurrencyMax > 0
									? ((usage?.runningJobs ?? 0) / concurrencyMax) * 100
									: 0
							}
							sub="jobs running right now"
						/>
					</div>

					{/* Spend control: pause at the included allowance instead of overage. */}
					{usage && usage.plan !== "community" && (
						<label className="flex cursor-pointer items-center gap-2 border-t border-border px-6 py-3 text-ui-sm text-text-tertiary">
							<input
								type="checkbox"
								className="accent-ink"
								checked={usage.hardCap}
								disabled={pending}
								onChange={(e) => {
									const next = e.target.checked;
									setUsage((u) => (u ? { ...u, hardCap: next } : u));
									startTransition(async () => {
										try {
											await setUsageHardCap(next);
										} catch {
											toast.error("Couldn't update the usage cap.");
											setUsage((u) => (u ? { ...u, hardCap: !next } : u));
										}
									});
								}}
							/>
							Pause new jobs at my included minutes instead of billing overage
						</label>
					)}
				</div>
			</SettingsSection>

			{/* 2 · Usage over time — cumulative, and the ONLY home for a number the range picker
			    can move. The picker is this section's action, so the control and everything it
			    changes are on screen together. */}
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
					series={overTime?.series}
					totals={overTime?.totals}
					error={overTimeFailed}
					rangeLabel={rangeLabel}
				/>
			</SettingsSection>

			{/* 3 · Resources — what the org runs right now, and what those things cost OUTSIDE the
			    plan: Alethia meters the minutes, the cloud bills the clusters. Nothing here moves
			    when the range picker moves; the job count that did now lives in the section above,
			    which is why this card sits below it rather than above. */}
			<SettingsSection title="Resources">
				<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
					<FactList>
						<Fact label="Projects" value={counts ? count(counts.projects) : "—"} />
						<Fact
							label="Clusters"
							value={counts ? count(counts.clusters) : "—"}
							sub="under management"
						/>
						{/* Spend is a fact about what this org runs, so it is a row of the same list —
						    not a paragraph under it. It used to sit outside as a hand-rolled
						    flex row, which left a screen reader with three terms and their values
						    followed by a loose line for the fourth, and the fourth is the one that
						    costs money. The sunken band is a treatment, not a different kind of
						    thing. */}
						<Fact
							className="border-t bg-surface-sunken"
							icon={<Info size={13} />}
							label="Estimated cloud spend under management"
							value={counts ? formatMonthlyRate(counts.spendUnderManagement) : "—"}
						/>
					</FactList>
					{/* The footnote of the figure it qualifies. It used to close the PLAN & LIMITS
					    card — under the seats, minutes and concurrency meters, which no provider
					    bills for — a whole section away from the only cloud-spend number here. */}
					<div className="flex items-center gap-2 border-t border-border bg-surface-sunken px-6 py-[14px] text-ui-sm text-text-tertiary">
						<Info size={13} />
						Your cloud-resource spend is billed separately by your provider.
					</div>
				</div>
			</SettingsSection>

			{/* 4 · AI plan & usage — standalone metered product (daily/weekly % + top-ups). */}
			<AiUsageSection />

			<UpgradeOrgSheet
				open={upgradeOpen}
				onOpenChange={(o) => {
					setUpgradeOpen(o);
					if (!o) refresh();
				}}
				orgSlug={orgSlug}
			/>
		</div>
	);
}
