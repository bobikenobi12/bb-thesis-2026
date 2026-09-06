"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Recent promotions — a compact history row per promotion (source → target, when, status). The
// in-flight one is flagged Active with a View into the detail overlay.

import { formatRelative } from "@repo/format";
import { Button } from "@repo/ui/button";
import { SectionHeading } from "@repo/ui/section-heading";
import type { PromotionRowView } from "./environments-view";
import { promoStatus, StatusDot } from "./env-ui";

const IN_FLIGHT = new Set([
	"PENDING_PLAN",
	"PENDING_APPROVAL",
	"APPROVED",
	"DEPLOYING",
]);

export function PromotionsHistory({
	promotions,
	envName,
	onView,
}: {
	promotions: PromotionRowView[];
	envName: (id: string) => string;
	onView: (id: string) => void;
}) {
	return (
		<section>
			<SectionHeading className="mb-3" level={2} title="Promotions" />
			<div className="overflow-hidden rounded-lg border bg-surface shadow-sm">
				{promotions.slice(0, 8).map((p) => {
					const status = promoStatus(p.status);
					const active = IN_FLIGHT.has(p.status);
					return (
						<div
							key={p.id}
							className="flex items-center gap-3 border-t border-border-faint px-4 py-3 first:border-t-0"
						>
							<StatusDot tier={status.tier} className="shrink-0" />
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2.5">
									<span className="font-mono text-ui-md text-text-primary">
										{envName(p.source_environment_id)} → {envName(p.target_environment_id)}
									</span>
									<span className="text-ui-xs text-text-tertiary">
										{formatRelative(p.created_at)}
									</span>
									{active && (
										<span className="rounded-full border px-1.5 py-px font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
											Active
										</span>
									)}
								</div>
								{p.error_message && (
									<div className="mt-0.5 font-mono text-ui-xs text-text-tertiary">
										{p.error_message}
									</div>
								)}
							</div>
							<span className="shrink-0 rounded-full border px-2 py-px font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
								{status.label}
							</span>
							{active && (
								<Button variant="ghost" size="sm" onClick={() => onView(p.id)}>
									View
								</Button>
							)}
						</div>
					);
				})}
			</div>
		</section>
	);
}
