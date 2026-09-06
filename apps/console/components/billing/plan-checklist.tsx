"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The persistent "What's included" column of the purchase flow — a check + bold title +
// sub-label per plan inclusion, from the shared catalog (so it never drifts from
// pricing). Stays put while the right panel swaps name → payment.

import { Check, ExternalLink } from "lucide-react";
import { env } from "next-runtime-env";
import type { PlanCatalogEntry } from "@repo/plan-catalog";
import { cn } from "@repo/ui/utils";

export function PlanChecklist({
	meta,
	className,
}: {
	meta: PlanCatalogEntry;
	className?: string;
}) {
	const features = meta.checkoutFeatures ?? [];
	const base = env("NEXT_PUBLIC_LEGAL_URL") ?? "https://alethialabs.io";
	const pricingUrl = `${base.replace(/\/+$/, "")}/pricing`;

	return (
		<div className={cn("flex flex-col", className)}>
			<span className="vx-eyebrow">What&apos;s included</span>
			<ul className="mt-4 space-y-4">
				{features.map((f) => (
					<li key={f.title} className="flex gap-2.5">
						<Check
							size={15}
							strokeWidth={2.4}
							className="mt-0.5 shrink-0 text-text-tertiary"
						/>
						<div className="flex flex-col">
							<span className="text-ui-md font-medium text-text-primary">
								{f.title}
							</span>
							<span className="text-ui-xs leading-snug text-text-tertiary">
								{f.detail}
							</span>
						</div>
					</li>
				))}
			</ul>
			<a
				href={pricingUrl}
				target="_blank"
				rel="noreferrer"
				className="mt-5 inline-flex items-center gap-1.5 text-ui-sm text-text-tertiary transition-colors hover:text-text-primary"
			>
				Learn more about pricing
				<ExternalLink size={12} />
			</a>
		</div>
	);
}
