"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Billing page — the authored claude.ai/design panel composed from the shared
// settings primitives (shadcn + Tailwind tokens; no CSS module): page header, a
// current-plan card with usage meters, payment methods + billing details (two-column),
// plan-history timeline, transaction history, and invoices. A Hobby→Pro upgrade opens the
// shared in-place UpgradeOrgSheet (via useUpgradeSheet) rather than an inline plan dialog;
// cancel/resume + saved cards + invoices are all in-app.

import { Info } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { formatDate, formatMoney } from "@repo/format";
import {
	type BillingSummary,
	cancelSubscription,
	getBillingSummary,
	resumeSubscription,
} from "@/app/server/actions/billing";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";
import { AiUsageSection } from "@/components/settings/usage/ai-usage-section";
import { SettingsSection } from "@/components/settings/settings-ui";
import { Button } from "@repo/ui/button";
import { Card } from "@repo/ui/card";
import { SectionHeading } from "@repo/ui/section-heading";
import { Skeleton } from "@repo/ui/skeleton";
import { planMeta } from "@repo/plan-catalog";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { RecentInvoices } from "./recent-invoices";
import { PaymentMethodsCard } from "./payment-methods-card";
import { PlanHistoryTimeline } from "./plan-history-timeline";
import { TransactionsTable } from "./transactions-table";

const STATE_LABEL: Record<BillingSummary["state"], string> = {
	none: "No subscription",
	trialing: "Trialing",
	active: "Active",
	canceling: "Canceling",
	past_due: "Past due",
	canceled: "Canceled",
};

export function BillingPanel() {
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);

	const [summary, setSummary] = useState<BillingSummary | null>(null);
	const [pending, startTransition] = useTransition();
	const [createOpen, setCreateOpen] = useState(false);
	// Hobby → Pro upgrades open the shared in-place upgrade sheet (no inline plan dialog).
	const { openUpgrade } = useUpgradeSheet();

	const refresh = useCallback(() => {
		getBillingSummary()
			.then(setSummary)
			.catch(() => toast.error("Couldn't load billing details."));
		fetchWorkspace();
	}, [fetchWorkspace]);
	useEffect(() => {
		refresh();
	}, [refresh]);

	// A subscription exists to manage (show a period + Cancel/Resume) for any live-ish state.
	const hasSub =
		summary?.state === "active" ||
		summary?.state === "trialing" ||
		summary?.state === "canceling" ||
		summary?.state === "past_due";

	function toggleCancel() {
		startTransition(async () => {
			try {
				if (summary?.cancelAtPeriodEnd) {
					await resumeSubscription();
					toast.success("Subscription resumed.");
				} else {
					await cancelSubscription();
					toast.success("Subscription will cancel at the period end.");
				}
				refresh();
			} catch (e) {
				toast.error(e instanceof Error ? e.message : "Something went wrong.");
			}
		});
	}

	if (!summary) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	// Self-managed / community: no Stripe → entitlements come from the license.
	if (!summary.hosted) {
		return (
			<Card className="p-6">
				<SectionHeading
					title="Self-managed deployment"
					description="This instance is not connected to hosted billing. Enterprise features are unlocked by your license key. See the docs for self-managed licensing."
				/>
			</Card>
		);
	}

	// Free user with no org yet: an org is the paid, shared workspace — create one.
	if (!summary.hasOrg) {
		return (
			<>
				<Card className="p-6">
					{/* A section heading, not a page title: these fallback cards are the whole page in
					    this state, but the billing page has never carried an `h1` and the console no
					    longer has page titles at all — the breadcrumb says "Billing". */}
					<SectionHeading
						className="max-w-prose"
						title="Create an organization"
						description="Your account is a personal scope — your Projects are all yours. Create an organization to collaborate with teammates on a paid plan."
					/>
					<Button className="mt-4" onClick={() => setCreateOpen(true)}>
						Create organization
					</Button>
				</Card>
				<CreateOrgSheet open={createOpen} onOpenChange={setCreateOpen} />
			</>
		);
	}

	const meta = planMeta(summary.plan);
	// The unit price is Stripe-authoritative (summary.unitAmountUsd = the subscription's
	// actual price), never the catalog. Per-seat plans bill unit × seats; a null unit
	// (Enterprise/custom, or community) → `monthly` is null and we show meta.priceLabel.
	const seatCount = summary.seats ?? Math.max(1, summary.memberCount);
	// `unitAmountUsd` is MAJOR units (the action divides Stripe's `unit_amount` by 100),
	// while `formatMoney` takes MINOR units on purpose — so every render below multiplies
	// back up by 100. Passing the dollars straight in would print $0.20 for a $20 plan.
	const unit = summary.unitAmountUsd;
	const monthly = unit === null ? null : meta.perSeat ? unit * seatCount : unit;
	const { state } = summary;
	// The Hobby tier is the free baseline — its card shows only the plan name + tagline + an
	// Upgrade CTA (no lifecycle badge, no price figure). Only paid tiers show state + price.
	const isHobby = summary.plan === "community";
	// The plan is currently entitled (filled badge) for any live-ish state.
	const isEntitled =
		state === "active" || state === "trialing" || state === "canceling";
	// currentPeriodEnd is only populated while the sub is live, so this label is only ever
	// shown for active/trialing ("Renews") or canceling ("Cancels") — never a contradiction.
	const periodLabel = summary.currentPeriodEnd
		? `${state === "canceling" ? "Cancels" : "Renews"} ${formatDate(summary.currentPeriodEnd)}`
		: null;
	// A future charge only exists while renewing — never when canceling / canceled / past_due.
	const showNextCharge =
		(state === "active" || state === "trialing") &&
		monthly !== null &&
		monthly > 0 &&
		Boolean(summary.currentPeriodEnd);

	return (
		<div>
			{/* current plan */}
			<SettingsSection title="Current plan">
				<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
					<div className="flex flex-wrap items-start justify-between gap-5 px-6 py-[22px]">
						<div className="flex flex-col gap-[9px]">
							<div className="flex items-center gap-2.5">
								<span className="font-display text-display-xs font-semibold tracking-[-0.02em] text-text-primary">
									{meta.name}
								</span>
								{!isHobby && (
									<>
										<span
											className={
												isEntitled
													? "rounded-full border border-ink bg-ink px-2 py-[3px] font-mono text-ui-3xs uppercase tracking-[0.1em] text-ink-foreground"
													: "rounded-full border border-border-strong px-2 py-[3px] font-mono text-ui-3xs uppercase tracking-[0.1em] text-text-secondary"
											}
										>
											{STATE_LABEL[state]}
										</span>
										{isEntitled && (
											<span className="rounded-full border border-border-strong px-2 py-[3px] font-mono text-ui-3xs uppercase tracking-[0.1em] text-text-secondary">
												Monthly
											</span>
										)}
									</>
								)}
							</div>
							<div className="flex flex-wrap items-center gap-2 text-ui-sm text-text-tertiary">
								<span>{meta.tagline}</span>
								{periodLabel && (
									<>
										<span className="size-[3px] rounded-full bg-text-disabled" />
										<span>{periodLabel}</span>
									</>
								)}
							</div>
						</div>
						{!isHobby && (
							<div className="flex flex-col items-end gap-[3px] text-right">
								<div className="font-display text-display-xs font-semibold tracking-[-0.03em] text-text-primary">
									{monthly === null ? (
										meta.priceLabel
									) : (
										<>
											{formatMoney(monthly * 100)}
											<span className="font-mono text-ui-sm font-normal text-text-tertiary">
												/mo
											</span>
										</>
									)}
								</div>
								{meta.perSeat && unit !== null && monthly !== null && monthly > 0 && (
									<div className="font-mono text-ui-2xs text-text-tertiary">
										{formatMoney(unit * 100)}/seat · {seatCount} seat
										{seatCount === 1 ? "" : "s"}
									</div>
								)}
								{showNextCharge && monthly !== null && summary.currentPeriodEnd && (
									<div className="font-mono text-ui-2xs text-text-tertiary">
										next charge {formatMoney(monthly * 100)} ·{" "}
										{formatDate(summary.currentPeriodEnd)}
									</div>
								)}
							</div>
						)}
					</div>

					<div className="flex flex-wrap items-center justify-between gap-4 border-t border-border bg-surface-sunken px-6 py-[14px]">
						<div className="flex items-center gap-2 text-ui-sm text-text-tertiary">
							<Info size={13} />
							Your cloud-resource spend is billed separately by your provider.
						</div>
						<div className="flex gap-2.5">
							{hasSub ? (
								<Button
									variant="ghost"
									size="sm"
									disabled={pending}
									onClick={toggleCancel}
								>
									{state === "canceling" ? "Resume plan" : "Cancel plan"}
								</Button>
							) : (
								<Button size="sm" onClick={openUpgrade}>
									Upgrade to Pro
								</Button>
							)}
						</div>
					</div>
				</div>
			</SettingsSection>

			{/* AI plan & usage — the standalone metered AI product (tier + daily/weekly %). */}
			<AiUsageSection />

			{/* payment + billing details → Stripe Customer Portal (once a customer exists) */}
			{summary.canManage && <PaymentMethodsCard />}

			{/* plan history */}
			<PlanHistoryTimeline />

			{/* transactions + invoices — once a customer exists */}
			{summary.canManage && (
				<>
					<TransactionsTable />
					<RecentInvoices />
				</>
			)}

		</div>
	);
}
