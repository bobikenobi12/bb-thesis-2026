"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The dimensions rail — the left column of the master/detail. Selectable, and (with edit
// rights) drag-to-reorder, which persists `position`. Each row shows the label, a single/multi
// badge, the key, and a values + usage summary.

import { cn } from "@repo/ui/utils";
import { GripVertical } from "lucide-react";
import { useRef } from "react";
import type { DimensionDTO } from "@/app/server/actions/classification/dimensions";

/** Reorders `ids` by moving `dragId` to `targetId`'s slot. */
function moved(ids: string[], dragId: string, targetId: string): string[] {
	if (dragId === targetId) return ids;
	const next = ids.filter((i) => i !== dragId);
	const at = next.indexOf(targetId);
	next.splice(at, 0, dragId);
	return next;
}

/** The dimensions rail. */
export function DimensionRail({
	dims,
	selectedId,
	onSelect,
	reorderable: reorderableProp,
	onReorder,
}: {
	dims: DimensionDTO[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	/** Drag-reorder is enabled only when editable and not filtering by search. */
	reorderable: boolean;
	onReorder: (ids: string[]) => void;
}) {
	const dragId = useRef<string | null>(null);
	const reorderable = reorderableProp && dims.length > 1;

	return (
		<div className="rounded-lg border bg-surface p-1.5 shadow-sm">
			<div className="flex items-center justify-between px-2 pb-[7px] pt-2">
				<span className="font-mono text-ui-3xs uppercase tracking-[0.12em] text-text-tertiary">
					Dimensions
				</span>
				<span className="font-mono text-ui-2xs text-text-tertiary">
					{dims.length}
				</span>
			</div>
			{dims.map((d) => {
				const selected = d.id === selectedId;
				return (
					<div
						key={d.id}
						draggable={reorderable}
						onDragStart={() => {
							dragId.current = d.id;
						}}
						onDragOver={(e) => reorderable && e.preventDefault()}
						onDrop={() => {
							if (dragId.current && dragId.current !== d.id) {
								onReorder(moved(dims.map((x) => x.id), dragId.current, d.id));
							}
							dragId.current = null;
						}}
						onClick={() => onSelect(d.id)}
						className={cn(
							"flex cursor-pointer items-center gap-2 rounded-[3px] px-2 py-2 transition-colors hover:bg-surface-muted",
							selected && "bg-surface-muted",
						)}
					>
						{reorderable && (
							<GripVertical
								className="size-3 shrink-0 cursor-grab text-text-disabled"
								aria-hidden
							/>
						)}
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-[7px]">
								<span
									className={cn(
										"truncate text-ui-md",
										selected
											? "font-semibold text-text-primary"
											: "font-medium text-text-secondary",
									)}
								>
									{d.label}
								</span>
								<span
									title={d.multi ? "Multiple values per resource" : "One value per resource"}
									className="shrink-0 rounded-[2px] border px-1 font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary"
								>
									{d.multi ? "M" : "1"}
								</span>
							</div>
							<div className="truncate font-mono text-ui-2xs text-text-tertiary">
								{d.key}
							</div>
						</div>
						<div className="shrink-0 text-right">
							<div className="font-mono text-ui-xs text-text-secondary">
								{d.values.length}
							</div>
							<div className="font-mono text-ui-3xs text-text-tertiary">
								{d.resourceCount} tagged
							</div>
						</div>
					</div>
				);
			})}
		</div>
	);
}
