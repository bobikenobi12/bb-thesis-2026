"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The standalone AI plan/usage surface — shared by the Usage page and the Billing page's
// AI section. Shows the org's current AI plan and its usage as PERCENTAGES (the rolling
// 5-hour session + the fixed weekly limit, on the same windows the guard enforces) with
// reset times and a hard-limit indicator — never raw credit counts. CTAs: Upgrade AI plan
// (raise the limits) always; Buy credits (top-up packs) only on a PAID tier at/near a
// limit — free orgs can't top up, they upgrade. AI is metered independently of the org
// plan (lib/billing/ai-plan.ts).

import { ArrowUpRight, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	type AiUsageSummary,
	getAiUsageSummary,
} from "@/app/server/actions/billing";
import { CreditPackDialog } from "@/components/billing/credit-pack-dialog";
import { UpgradeAiSheet } from "@/components/billing/upgrade-ai-sheet";
import { AiSpendLimits } from "@/components/settings/usage/ai-spend-limits";
import { count } from "@/components/settings/usage/usage-primitives";
import { SettingsSection } from "@/components/settings/settings-ui";
import {
	isNearAiLimit,
	pctOf,
	sessionResetLabel,
	weeklyResetLabel,
} from "@/lib/billing/ai-usage-format";
import { useLiveAiPrice } from "@/lib/billing/use-live-plan-price";
import { aiPlanMeta } from "@repo/plan-catalog";
import { Skeleton } from "@repo/ui/skeleton";

/** A percent meter (bar + % value + reset sub). Shows proportions only, never raw counts. */
function PctMeter({
	label,
	pct,
	sub,
}: {
	label: string;
	pct: number;
	sub: string;
}) {
	const atLimit = pct >= 100;
	return (
		<div className="border-r border-border px-6 py-4 last:border-r-0">
			<div className="mb-[9px] flex items-baseline justify-between">
				<span className="font-mono text-ui-2xs uppercase tracking-[0.1em] text-text-tertiary">
					{label}
				</span>
				<span
					className={`text-ui-sm ${atLimit ? "font-semibold text-text-primary" : "text-text-secondary"}`}
				>
					{pct}%
				</span>
			</div>
			<div className="h-[5px] overflow-hidden rounded-full border border-border bg-surface-sunken">
				<div
					className="h-full rounded-full bg-text-primary"
					style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
				/>
			</div>
			<div className="mt-2 font-mono text-ui-2xs text-text-tertiary">
				{atLimit ? "At limit · " : ""}
				{sub}
			</div>
		</div>
	);
}

/**
 * The AI plan & usage card. Self-fetches the canonical AI summary and renders the plan +
 * session/weekly % + purchased balance + the plan-aware CTAs. Rendered on both the Usage
 * and Billing settings pages (one source of truth — no twin panel).
 */
export function AiUsageSection() {
	const [ai, setAi] = useState<AiUsageSummary | null>(null);
	const [upgradeOpen, setUpgradeOpen] = useState(false);
	const [creditsOpen, setCreditsOpen] = useState(false);

	/** (Re)load the canonical AI summary — also called after an upgrade / credit purchase. */
	const refetch = useCallback(() => {
		let alive = true;
		getAiUsageSummary()
			.then((s) => alive && setAi(s))
			.catch(() => {
				/* best-effort — the section just shows a skeleton */
			});
		return () => {
			alive = false;
		};
	}, []);

	useEffect(() => refetch(), [refetch]);

	const meta = ai ? aiPlanMeta(ai.tier) : null;
	// The tier's live (Stripe-authoritative) price in USD — placeholder catalog price until
	// the AI Stripe prices are cut over; the upgrade sheet owns the currency choice. Hooks
	// must run unconditionally, so resolve against the free tier until the summary loads.
	const aiPrice = useLiveAiPrice(ai?.tier ?? "ai_free");
	// Free/Plus can still upgrade the AI tier; Max is the top.
	const canUpgrade = ai ? ai.tier !== "ai_max" : false;
	const paid = ai ? ai.tier !== "ai_free" : false;
	// Top-up packs only make sense on a paid plan, and only once a limit is actually near —
	// below that, the plan's included allowance is the whole story.
	const showBuyCredits = ai !== null && paid && isNearAiLimit(ai);
	// The balance strip is noise for a free org that never bought packs.
	const showBalance = ai !== null && (paid || ai.purchasedBalance > 0);

	return (
		<SettingsSection title="AI plan & usage">
			<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
				{/* plan header */}
				<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
					<div className="flex flex-col gap-0.5">
						<div className="flex items-baseline gap-2">
							<span className="font-display text-ui-lg font-semibold text-text-primary">
								{meta ? meta.name : <Skeleton className="h-4 w-20" />}
							</span>
							{meta && (
								<span className="font-mono text-ui-xs text-text-secondary">
									· {aiPrice.label}
								</span>
							)}
						</div>
						{meta && (
							<span className="text-ui-xs text-text-tertiary">
								{meta.tagline}
							</span>
						)}
					</div>
					<div className="flex items-center gap-2">
						{showBuyCredits && (
							<button
								type="button"
								onClick={() => setCreditsOpen(true)}
								className="inline-flex items-center gap-1 text-ui-sm text-text-secondary transition-colors hover:text-text-primary"
							>
								Buy credits
								<ArrowUpRight size={13} />
							</button>
						)}
						{canUpgrade && (
							<button
								type="button"
								onClick={() => setUpgradeOpen(true)}
								className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2.5 py-1 text-ui-sm text-text-primary transition-colors hover:bg-surface-muted"
							>
								<Zap size={12} />
								Upgrade AI plan
							</button>
						)}
					</div>
				</div>

				{/* session + weekly % meters */}
				<div className="grid grid-cols-1 sm:grid-cols-2">
					{ai ? (
						<>
							<PctMeter
								label="Current session"
								pct={pctOf(ai.sessionUsed, ai.sessionBudget)}
								sub={sessionResetLabel(ai.sessionResetAt)}
							/>
							<PctMeter
								label="Weekly limit"
								pct={pctOf(ai.weeklyUsed, ai.weeklyBudget)}
								sub={weeklyResetLabel(ai.weeklyResetAt)}
							/>
						</>
					) : (
						<div className="px-6 py-4">
							<Skeleton className="h-10 w-full" />
						</div>
					)}
				</div>

				{/* purchased top-up balance — paid tiers (or a leftover balance) only */}
				{showBalance && (
					<div className="flex items-center justify-between border-t border-border bg-surface-sunken px-6 py-3 text-ui-sm text-text-tertiary">
						<span>Top-up credits never expire and stack on your plan.</span>
						<span className="font-mono text-text-secondary">
							{count(ai.purchasedBalance)} credits
						</span>
					</div>
				)}

				{/* admin spend limits — org admins (manage_billing) in a real org only */}
				{ai?.canManageCaps && (
					<AiSpendLimits
						key={`${ai.orgWeeklyCapCredits}-${ai.perUserWeeklyCapCredits}`}
						orgWeeklyCapCredits={ai.orgWeeklyCapCredits}
						perUserWeeklyCapCredits={ai.perUserWeeklyCapCredits}
						onSaved={refetch}
					/>
				)}
			</div>

			<UpgradeAiSheet
				open={upgradeOpen}
				onOpenChange={setUpgradeOpen}
				onUpgraded={refetch}
			/>
			<CreditPackDialog
				open={creditsOpen}
				onOpenChange={setCreditsOpen}
				onPurchased={refetch}
				onUpgradeInstead={() => setUpgradeOpen(true)}
			/>
		</SettingsSection>
	);
}
