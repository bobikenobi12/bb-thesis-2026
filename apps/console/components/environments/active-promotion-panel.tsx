"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The active-promotion panel — shown while a promotion is in flight. A Plan → Approval → Deploy →
// Live pipeline, the per-gate results, the approval slots (with approve/reject), and a
// blocked/failed/cancelled banner. Read-only over the hydrated PromotionDetail; the actions are
// handled by the orchestrator (reject/cancel confirm through an AlertDialog).

import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";
import { ArrowRight, Check, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { PromotionDetail } from "@/app/server/actions/promotions";
import {
	Avatar,
	gateView,
	pipelineSteps,
	promoStatus,
	StatusDot,
} from "./env-ui";

/** The blocked/failed/cancelled banner copy for a promotion. */
function banner(detail: PromotionDetail): { title: string; body: string } | null {
	if (detail.status === "BLOCKED")
		return {
			title: "Blocked — a required gate failed",
			body:
				detail.gates.find((g) => g.status === "fail")?.detail ??
				"A required gate failed. Resolve it, re-run the plan, then promote again.",
		};
	if (detail.status === "FAILED")
		return { title: "Deploy failed", body: "The promotion's deploy did not complete." };
	if (detail.status === "CANCELLED")
		return { title: "Promotion cancelled", body: "A reviewer rejected this promotion. Nothing was deployed." };
	return null;
}

export function ActivePromotionPanel({
	detail,
	canApprove,
	canCancel,
	onApprove,
	onReject,
	onCancel,
	onOpenDetail,
}: {
	detail: PromotionDetail;
	canApprove: boolean;
	canCancel: boolean;
	onApprove: () => Promise<void>;
	onReject: () => void;
	onCancel: () => void;
	onOpenDetail: () => void;
}) {
	const [approving, setApproving] = useState(false);
	const status = promoStatus(detail.status);
	const steps = pipelineSteps(detail.status);
	const gates = detail.gates.map(gateView);
	const b = banner(detail);

	return (
		<section className="overflow-hidden rounded-lg border bg-surface shadow-sm">
			{/* header */}
			<div className="flex items-center justify-between gap-3 border-b px-6 py-4">
				<div className="flex items-center gap-2.5">
					<span className="font-mono text-ui-md text-text-primary">
						{detail.sourceName}
					</span>
					<ArrowRight className="size-3.5 text-text-tertiary" />
					<span className="font-mono text-ui-md text-text-primary">
						{detail.targetName}
					</span>
					<StatusDot tier={status.tier} label={status.label} className="ml-1.5 text-ui-xs" />
				</div>
				<div className="flex items-center gap-2">
					{canCancel && (
						<Button variant="ghost" size="sm" onClick={onCancel}>
							Cancel
						</Button>
					)}
					<Button variant="ghost" size="sm" onClick={onOpenDetail} className="gap-1">
						Open detail
						<ArrowRight className="size-3.5" />
					</Button>
				</div>
			</div>

			{/* pipeline */}
			<div className="flex items-start px-6 pb-1.5 pt-5">
				{steps.map((s, i) => (
					<div
						key={s.label}
						className={cn("flex items-start", i < steps.length - 1 && "flex-1")}
					>
						<div className="flex w-[66px] shrink-0 flex-col items-center gap-1.5">
							<StatusDot tier={s.tier} />
							<span className="font-mono text-ui-2xs uppercase tracking-wider text-text-tertiary">
								{s.label}
							</span>
						</div>
						{/* The rail is centred on the dot, not on the column: `items-start` pins it to
						    the row's top edge, so the offset has to name the dot's own centre. The
						    shared `.vx-status__dot` is 7px and this rail is 2px, so 3px lands it
						    across the middle of the dot. It read `mt-2.5` while the dot was 12px. */}
						{i < steps.length - 1 && (
							<div className="mx-1 mt-[3px] h-0.5 flex-1 bg-border" />
						)}
					</div>
				))}
			</div>

			{/* banner */}
			{b && (
				<div className="px-5 pt-1">
					<div className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-[var(--signal-critical-surface)] px-3.5 py-3">
						<TriangleAlert className="mt-px size-4 shrink-0 text-destructive" />
						<div>
							<div className="text-ui-md font-medium text-text-primary">{b.title}</div>
							<div className="mt-0.5 font-mono text-ui-sm leading-relaxed text-text-secondary">
								{b.body}
							</div>
						</div>
					</div>
				</div>
			)}

			{/* gates + approvals */}
			<div className="grid grid-cols-1 gap-0 p-2 sm:grid-cols-2">
				<div className="border-border px-4 sm:border-r">
					<div className="mb-1.5 font-mono text-ui-2xs uppercase tracking-[0.16em] text-text-tertiary">
						Gates
					</div>
					{gates.length === 0 ? (
						<div className="py-3 font-mono text-ui-sm text-text-tertiary">
							Evaluated once the plan completes.
						</div>
					) : (
						gates.map((g) => (
							<div
								key={g.type}
								className="flex items-center gap-2.5 border-t border-border-faint py-2"
							>
								<g.icon className="size-[15px] shrink-0 text-text-secondary" />
								<span className="flex-1 text-ui-md text-text-primary">{g.label}</span>
								<StatusDot tier={g.tier} label={g.word} className="text-ui-xs" />
							</div>
						))
					)}
				</div>

				<div className="px-4">
					<div className="mb-1.5 flex items-baseline justify-between">
						<span className="font-mono text-ui-2xs uppercase tracking-[0.16em] text-text-tertiary">
							Approvals
						</span>
						<span className="font-mono text-ui-xs text-text-secondary">
							{detail.approved} / {detail.required}
						</span>
					</div>
					{detail.approvals.length === 0 ? (
						<div className="py-3 font-mono text-ui-sm text-text-tertiary">
							No approval required.
						</div>
					) : (
						detail.approvals.map((slot) => (
							<div key={slot.id} className="flex gap-2.5 border-t border-border-faint py-2.5">
								{slot.status === "pending" ? (
									<span className="size-[26px] shrink-0 rounded-full border-[1.5px] border-dashed border-border-strong" />
								) : (
									<Avatar initials={slot.initials ?? "?"} />
								)}
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="text-ui-md font-medium text-text-primary">
											{slot.name ?? "Awaiting a reviewer"}
										</span>
										{slot.status === "approved" && (
											<StatusDot tier="active" label="Approved" className="text-ui-xs" />
										)}
										{slot.status === "rejected" && (
											<StatusDot tier="failed" label="Rejected" className="text-ui-xs" />
										)}
									</div>
									<div className="mt-px text-ui-xs text-text-tertiary">
										{slot.requiredRole
											? `Any ${slot.requiredRole}`
											: "Any listed approver"}
									</div>
									{slot.comment && (
										<div className="mt-1.5 rounded-md bg-surface-muted px-2.5 py-1.5 text-ui-sm leading-relaxed text-text-secondary">
											{slot.comment}
										</div>
									)}
								</div>
							</div>
						))
					)}
					{canApprove && (
						<div className="mt-3 flex gap-2">
							<Button
								size="sm"
								className="flex-1 gap-1.5"
								disabled={approving}
								onClick={async () => {
									setApproving(true);
									try {
										await onApprove();
									} finally {
										setApproving(false);
									}
								}}
							>
								<Check className="size-3.5" />
								Approve
							</Button>
							<Button
								size="sm"
								variant="outline"
								className="flex-1"
								disabled={approving}
								onClick={onReject}
							>
								Reject
							</Button>
						</div>
					)}
				</div>
			</div>
		</section>
	);
}
