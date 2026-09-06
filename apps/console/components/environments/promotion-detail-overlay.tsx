"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The promotion detail overlay — a right sheet with the full pipeline, per-gate results (with their
// detail), the approval slots, and the promotable diff. Read-only over a hydrated PromotionDetail.

import { Sheet, SheetContent } from "@repo/ui/sheet";
import { cn } from "@repo/ui/utils";
import { MinusCircle, Pencil, PlusCircle, X, type LucideIcon } from "lucide-react";
import type { PromotionDetail } from "@/app/server/actions/promotions";
import type { ComponentChange } from "@/types/jsonb.types";
import { Avatar, gateView, pipelineSteps, promoStatus, StatusDot } from "./env-ui";

const OP_META: Record<ComponentChange["op"], { label: string; icon: LucideIcon }> = {
	CREATE: { label: "add", icon: PlusCircle },
	UPDATE: { label: "update", icon: Pencil },
	DELETE: { label: "remove", icon: MinusCircle },
};

/** Renders a single field before → after, stringified. */
function fieldLine(key: string, from: unknown, to: unknown): string {
	const s = (v: unknown) => (v === null || v === undefined ? "∅" : String(v));
	return `${key} ${s(from)} → ${s(to)}`;
}

export function PromotionDetailOverlay({
	detail,
	onClose,
}: {
	detail: PromotionDetail | null;
	onClose: () => void;
}) {
	return (
		<Sheet open={Boolean(detail)} onOpenChange={(o) => !o && onClose()}>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="w-[min(560px,96vw)] gap-0 border-border-strong bg-surface-raised p-0 sm:max-w-none"
			>
				{detail && (
					<>
						<div className="sticky top-0 z-10 border-b bg-surface-raised px-5 pb-4 pt-[18px]">
							<div className="flex items-start justify-between gap-3">
								<div>
									<div className="mb-1.5 font-mono text-ui-3xs uppercase tracking-[0.16em] text-text-tertiary">
										Promotion
									</div>
									<div className="flex items-center gap-2">
										<span className="font-mono text-ui-lg text-text-primary">
											{detail.sourceName} → {detail.targetName}
										</span>
										<StatusDot {...promoStatus(detail.status)} className="text-ui-xs" />
									</div>
									{detail.initiator && (
										<div className="mt-1 font-mono text-ui-xs text-text-tertiary">
											by {detail.initiator}
										</div>
									)}
								</div>
								<button
									type="button"
									onClick={onClose}
									aria-label="Close"
									className="grid size-[30px] place-items-center rounded-[2px] border border-border-strong bg-surface text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary"
								>
									<X className="size-[15px]" />
								</button>
							</div>
						</div>

						<div className="flex-1 space-y-6 overflow-y-auto px-5 pb-10 pt-4">
							{/* pipeline */}
							<div className="flex items-start">
								{pipelineSteps(detail.status).map((s, i, arr) => (
									<div key={s.label} className={cn("flex items-start", i < arr.length - 1 && "flex-1")}>
										<div className="flex w-[62px] shrink-0 flex-col items-center gap-1.5">
											<StatusDot tier={s.tier} />
											<span className="font-mono text-ui-2xs uppercase tracking-wider text-text-tertiary">
												{s.label}
											</span>
										</div>
										{/* 3px centres the 2px rail on the shared 7px `.vx-status__dot` — see
										    active-promotion-panel.tsx, which draws the same pipeline. */}
										{i < arr.length - 1 && <div className="mx-1 mt-[3px] h-0.5 flex-1 bg-border" />}
									</div>
								))}
							</div>

							{/* gates */}
							{detail.gates.length > 0 && (
								<div>
									<div className="mb-2 font-mono text-ui-3xs uppercase tracking-[0.16em] text-text-tertiary">
										Gates
									</div>
									<div className="flex flex-col gap-2.5">
										{detail.gates.map(gateView).map((g) => (
											<div key={g.type} className="rounded-md border bg-surface px-3.5 py-2.5">
												<div className="flex items-center gap-2.5">
													<g.icon className="size-[15px] shrink-0 text-text-secondary" />
													<span className="flex-1 text-ui-md text-text-primary">{g.label}</span>
													<StatusDot tier={g.tier} label={g.word} className="text-ui-xs" />
												</div>
												{g.detail && (
													<div className="mt-1.5 pl-[25px] text-ui-sm leading-relaxed text-text-tertiary">
														{g.detail}
													</div>
												)}
											</div>
										))}
									</div>
								</div>
							)}

							{/* approvals */}
							{detail.approvals.length > 0 && (
								<div>
									<div className="mb-2 flex items-baseline justify-between">
										<span className="font-mono text-ui-3xs uppercase tracking-[0.16em] text-text-tertiary">
											Approvals
										</span>
										<span className="font-mono text-ui-xs text-text-secondary">
											{detail.approved} / {detail.required}
										</span>
									</div>
									<div className="flex flex-col gap-2.5">
										{detail.approvals.map((slot) => (
											<div key={slot.id} className="flex gap-2.5">
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
														{slot.requiredRole ? `Any ${slot.requiredRole}` : "Any listed approver"}
													</div>
													{slot.comment && (
														<div className="mt-1.5 rounded-md bg-surface-muted px-2.5 py-1.5 text-ui-sm leading-relaxed text-text-secondary">
															{slot.comment}
														</div>
													)}
												</div>
											</div>
										))}
									</div>
								</div>
							)}

							{/* diff */}
							{detail.diff && detail.diff.changes.length > 0 && (
								<div>
									<div className="mb-2 flex items-baseline justify-between">
										<span className="font-mono text-ui-3xs uppercase tracking-[0.16em] text-text-tertiary">
											Changes
										</span>
										<span className="font-mono text-ui-xs text-text-tertiary">
											{detail.diff.summary.join(" · ")}
										</span>
									</div>
									<div className="flex flex-col overflow-hidden rounded-md border">
										{detail.diff.changes.map((c) => {
											const op = OP_META[c.op];
											return (
												<div
													key={`${c.component_type}-${c.key}`}
													className="border-b border-border-faint bg-surface px-3.5 py-2.5 last:border-0"
												>
													<div className="flex items-center gap-2.5">
														<op.icon className="size-[15px] shrink-0 text-text-secondary" />
														<span className="font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
															{op.label}
														</span>
														<span className="text-ui-sm text-text-tertiary">{c.component_type}</span>
														<span className="font-mono text-ui-sm text-text-primary">{c.key}</span>
													</div>
													{c.fields && Object.keys(c.fields).length > 0 && (
														<div className="mt-1.5 pl-[25px] font-mono text-ui-xs leading-relaxed text-text-tertiary">
															{Object.entries(c.fields)
																.map(([k, f]) => fieldLine(k, f.from, f.to))
																.join(" · ")}
														</div>
													)}
												</div>
											);
										})}
									</div>
								</div>
							)}
						</div>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}
