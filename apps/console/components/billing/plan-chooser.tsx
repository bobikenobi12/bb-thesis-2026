"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Plan chooser for the create-org sheet: a vertical list of selectable plan rows, plus
// a dynamic "What's included" slice that updates to the selected plan (an
// "Everything in {parent}, plus:" rollup over the grouped feature breakdown).
// Presentational — the parent owns the selected value + the CTA. Grayscale + squared.

import {
	Boxes,
	Check,
	Fingerprint,
	KeyRound,
	LifeBuoy,
	type LucideIcon,
	ScrollText,
	Shield,
	ShieldCheck,
	Users,
} from "lucide-react";
import { Badge } from "@repo/ui/badge";
import {
	type PlanCatalogEntry,
	type PlanId,
	planMeta,
} from "@repo/plan-catalog";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { useLivePlanPrice } from "@/lib/billing/use-live-plan-price";
import { cn } from "@repo/ui/utils";

const GROUP_ICON: Record<string, LucideIcon> = {
	Platform: Boxes,
	Access: KeyRound,
	Collaboration: Users,
	Governance: ShieldCheck,
	Compliance: ScrollText,
	Identity: Fingerprint,
	"Security & compliance": Shield,
	Support: LifeBuoy,
};

interface PlanChooserProps {
	plans: PlanCatalogEntry[];
	value: BillingPlan;
	onChange: (plan: BillingPlan) => void;
}

export function PlanChooser({ plans, value, onChange }: PlanChooserProps) {
	const selected = plans.find((p) => p.id === value) ?? plans[0];
	const parent = selected.inheritsFrom
		? planMeta(selected.inheritsFrom)
		: null;

	return (
		<div className="space-y-5">
			{/* Selectable plan rows */}
			<div className="space-y-2">
				{plans.map((p) => {
					const active = p.id === value;
					return (
						<button
							key={p.id}
							type="button"
							onClick={() => onChange(p.id)}
							className={cn(
								"flex w-full items-center gap-3 border px-4 py-3 text-left transition-colors",
								active
									? "border-foreground bg-muted/40"
									: "border-border/60 hover:border-border hover:bg-muted/20",
							)}
						>
							{/* squared single-select indicator */}
							<span
								className={cn(
									"flex h-4 w-4 shrink-0 items-center justify-center border",
									active ? "border-foreground" : "border-muted-foreground/50",
								)}
							>
								{active && <span className="h-2 w-2 bg-foreground" />}
							</span>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="text-sm font-medium text-foreground">
										{p.name}
									</span>
									{p.popular && (
										<Badge variant="outline" className="text-ui-2xs uppercase">
											Popular
										</Badge>
									)}
								</div>
								<p className="truncate text-xs text-muted-foreground">
									{p.tagline}
								</p>
							</div>
							<PlanPriceLabel plan={p.id} />
						</button>
					);
				})}
			</div>

			{/* What's included — for the selected plan */}
			<div className="space-y-3 border-t border-border/40 pt-4">
				<p className="vx-eyebrow">What&apos;s included · {selected.name}</p>
				{parent && (
					<p className="text-sm text-muted-foreground">
						Everything in{" "}
						<span className="text-foreground">{parent.name}</span>, plus:
					</p>
				)}
				<div className="space-y-4">
					{selected.included.map((group) => {
						const Icon = GROUP_ICON[group.label] ?? Check;
						return (
							<div key={group.label} className="space-y-1.5">
								<div className="flex items-center gap-2">
									<Icon className="h-3.5 w-3.5 text-muted-foreground" />
									<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
										{group.label}
									</p>
								</div>
								<ul className="space-y-1.5 pl-5">
									{group.items.map((item) => (
										<li
											key={item}
											className="flex items-start gap-2 text-sm text-foreground"
										>
											<Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
											<span>{item}</span>
										</li>
									))}
								</ul>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}

/** The plan's price label, read live from Stripe (catalog fallback while loading). */
function PlanPriceLabel({ plan }: { plan: PlanId }) {
	const { label } = useLivePlanPrice(plan);
	return (
		<span className="shrink-0 text-sm font-medium text-foreground">{label}</span>
	);
}
