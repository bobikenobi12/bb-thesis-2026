"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The drill-down drawer for a value — "which resources carry this value", broken down by
// resource kind (e.g. 12 projects · 8 clusters · 4 runners). Read-only; loads lazily when
// opened. Individual resource names aren't resolved (they live across ~14 tables) — the
// per-kind counts are the honest, cheap answer.

import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { SectionHeading } from "@repo/ui/section-heading";
import { Sheet, SheetContent } from "@repo/ui/sheet";
import { Skeleton } from "@repo/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { Boxes, X } from "lucide-react";
import type { ValueDTO } from "@/app/server/actions/classification/dimensions";
import { getValueResourceBreakdown } from "@/app/server/actions/classification/assignments";
import { kindLabel } from "./resource-kind-labels";

/** The value drill-down drawer. Open when `value` is set. */
export function ValueDrillDrawer({
	value,
	dimensionLabel,
	onClose,
}: {
	value: ValueDTO | null;
	dimensionLabel: string;
	onClose: () => void;
}) {
	const { data, isPending, isError, refetch } = useQuery({
		queryKey: ["classification", "value-breakdown", value?.id],
		queryFn: () => getValueResourceBreakdown(value?.id ?? ""),
		enabled: Boolean(value),
	});

	const total = (data ?? []).reduce((n, r) => n + r.count, 0);

	return (
		<Sheet open={Boolean(value)} onOpenChange={(o) => !o && onClose()}>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="w-[400px] gap-0 border-border-strong bg-surface-raised p-0 sm:max-w-none"
			>
				{value && (
					<>
						<div className="sticky top-0 border-b bg-surface-raised px-5 pb-4 pt-[18px]">
							<div className="flex items-start justify-between gap-3">
								<div>
									<div className="mb-[7px] font-mono text-ui-3xs uppercase tracking-[0.14em] text-text-tertiary">
										{dimensionLabel} · value
									</div>
									{/* A SHEET title, which packages/brand/src/tokens.css names as the
									    --text-ui-xl role — the rung this drawer wrote as Tailwind's 18px
									    text-lg. The slot override takes the rung; the tag and the layout
									    come from the shared component. */}
									<SectionHeading
										level={3}
										title={value.label}
										className="[&_[data-slot=section-heading-title]]:text-ui-xl [&_[data-slot=section-heading-title]]:font-semibold"
									/>
									<div className="mt-1.5 text-ui-sm text-text-secondary">
										{isPending
											? "Loading…"
											: isError
												? "Couldn't load"
												: total === 0
													? "No resources"
													: `${total} resource${total === 1 ? "" : "s"} across ${(data ?? []).length} kind${(data ?? []).length === 1 ? "" : "s"}`}
									</div>
								</div>
								<button
									type="button"
									onClick={onClose}
									aria-label="Close"
									className="grid size-[30px] shrink-0 place-items-center rounded-[2px] border border-border-strong bg-surface text-text-secondary transition-colors hover:bg-surface-muted hover:text-text-primary"
								>
									<X className="size-[15px]" />
								</button>
							</div>
						</div>

						<div className="flex-1 overflow-y-auto px-2.5 pb-5 pt-2">
							{isPending ? (
								<div className="space-y-2 p-2">
									<Skeleton className="h-11 w-full" />
									<Skeleton className="h-11 w-full" />
									<Skeleton className="h-11 w-full" />
								</div>
							) : isError ? (
								// A fetch failure must not read as "no resources use this value" — that would
								// wrongly invite deleting a value that may be in use.
								<EmptyState
									className="px-4 py-9 md:p-9"
									title="Couldn't load which resources use this value."
									action={
										<Button variant="outline" size="sm" onClick={() => void refetch()}>
											Retry
										</Button>
									}
								/>
							) : total === 0 ? (
								<EmptyState
									className="px-4 py-9 md:p-9"
									title="No resources use this value."
									description="Unused values are safe to delete or repurpose."
								/>
							) : (
								(data ?? []).map((r) => (
									<div
										key={r.resource_kind}
										className="flex items-center gap-3 rounded-[2px] px-2.5 py-2.5 transition-colors hover:bg-surface-muted"
									>
										<span className="grid size-7 shrink-0 place-items-center rounded-[3px] border bg-surface-sunken text-text-tertiary">
											<Boxes className="size-3.5" />
										</span>
										<div className="min-w-0 flex-1">
											<div className="text-ui-md font-medium text-text-primary">
												{kindLabel(r.resource_kind)}
											</div>
											<div className="font-mono text-ui-2xs text-text-tertiary">
												{r.resource_kind}
											</div>
										</div>
										<span className="font-mono text-ui-md text-text-secondary">
											{r.count}
										</span>
									</div>
								))
							)}
						</div>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}
