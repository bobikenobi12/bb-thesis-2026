"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Self-contained, reusable plan picker. Purely presentational — it renders the tier
// cards from PLAN_CATALOG and calls `onSelect(plan)`; the parent owns what happens
// (create-org + checkout, upgrade an existing org, …). Reused by the create-org sheet,
// the settings billing panel, and any future dialog. Grayscale + squared per the
// design system: a plan is signalled by an outline Badge label, never colour.

import { Check } from "lucide-react";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { Card } from "@repo/ui/card";
import { SectionHeading } from "@repo/ui/section-heading";
import { PAID_PLANS, type PlanId, PLAN_CATALOG } from "@repo/plan-catalog";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { useLivePlanPrice } from "@/lib/billing/use-live-plan-price";
import { cn } from "@repo/ui/utils";

interface PlanPickerProps {
	/** The org's current plan — that card shows "Current plan" (disabled). */
	currentPlan?: BillingPlan;
	/** Show only paid tiers (the create-org flow — free = no org). */
	paidOnly?: boolean;
	/** The plan whose action is in flight (button shows a pending label). */
	pendingPlan?: BillingPlan | null;
	/** Disable every action (e.g. a parallel request is running). */
	disabled?: boolean;
	/** CTA label for a selectable card (default "Select"). */
	ctaLabel?: string;
	onSelect: (plan: BillingPlan) => void;
}

export function PlanPicker({
	currentPlan,
	paidOnly,
	pendingPlan,
	disabled,
	ctaLabel = "Select",
	onSelect,
}: PlanPickerProps) {
	const plans = paidOnly ? PAID_PLANS : PLAN_CATALOG;

	return (
		<div
			className={cn(
				"grid gap-4",
				plans.length >= 3 ? "md:grid-cols-3" : "sm:grid-cols-2",
			)}
		>
			{plans.map((plan) => {
				const isCurrent = currentPlan === plan.id;
				const isPending = pendingPlan === plan.id;
				return (
					<Card key={plan.id} className="flex flex-col gap-4 p-5">
						<div className="space-y-1">
							{/* The card's name and its "Current" marker are the heading and its
							    actions — the same shape `SectionHeading` already lays out, so the
							    card no longer owns a second answer to how a heading is typeset. */}
							<SectionHeading
								level={3}
								title={plan.name}
								actions={
									isCurrent ? (
										<Badge variant="outline" className="text-ui-2xs uppercase">
											Current
										</Badge>
									) : undefined
								}
							/>
							<PlanPriceLabel plan={plan.id} />
							<p className="text-xs text-muted-foreground">{plan.tagline}</p>
						</div>

						<ul className="flex-1 space-y-1.5 text-sm text-muted-foreground">
							{plan.highlights.map((f) => (
								<li key={f} className="flex items-start gap-2">
									<Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground" />
									<span>{f}</span>
								</li>
							))}
						</ul>

						<Button
							variant={isCurrent ? "outline" : "default"}
							disabled={isCurrent || disabled || isPending}
							onClick={() => onSelect(plan.id)}
						>
							{isCurrent ? "Current plan" : isPending ? "Redirecting…" : ctaLabel}
						</Button>
					</Card>
				);
			})}
		</div>
	);
}

/** The plan's price label, read live from Stripe (catalog fallback while loading). */
function PlanPriceLabel({ plan }: { plan: PlanId }) {
	const { label } = useLivePlanPrice(plan);
	return <p className="text-sm font-medium text-foreground">{label}</p>;
}
