"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The in-page upsell panel. Unlike the old SettingsGate, this does NOT replace the page —
// it sits where a gated feature's empty state / primary action would, while the rest of
// the surface stays visible (read-only). Shown when an Enterprise/Pro feature is locked.

import { planMeta } from "@repo/plan-catalog";
import { EmptyState } from "@repo/ui/empty";
import { cn } from "@repo/ui/utils";
import { FEATURE_UPSELLS, type GatedFeature } from "./feature-catalog";
import { UpsellActions } from "./upsell-actions";

/**
 * A polished "available on {plan}" panel for a gated feature.
 *
 * Composed from `EmptyState`, not hand-rolled, and the two are genuinely the same thing: this
 * panel stands exactly where a locked feature's rows would have been, which is the definition
 * §6 gives an empty state. Hand-rolling it meant a user who cannot use a feature yet met a
 * different shape of "nothing here" from a user whose list is simply empty.
 *
 * `level={3}` keeps the heading rung this panel already occupied — `EmptyState` renders its
 * title as a plain `<div>` by default, which would have quietly dropped it out of the outline.
 */
export function FeatureUpsell({
	feature,
	className,
}: {
	feature: GatedFeature;
	className?: string;
}) {
	const meta = FEATURE_UPSELLS[feature];
	const Icon = meta.icon;
	const planName = planMeta(meta.requiredPlan).name;

	return (
		<EmptyState
			// `Empty` sets `border-dashed` but deliberately leaves the WIDTH to the caller, and
			// Tailwind's preflight zeroes it — so the bare `border` here is what makes the dashed
			// outline this panel has always had actually paint.
			className={cn("border border-border bg-surface-sunken", className)}
			level={3}
			icon={<Icon />}
			title={meta.title}
			description={
				<>
					{meta.blurb}
					<span className="mt-2 block text-ui-sm font-medium text-text-secondary">
						Available on the {planName} plan.
					</span>
				</>
			}
			action={<UpsellActions feature={feature} />}
		/>
	);
}
