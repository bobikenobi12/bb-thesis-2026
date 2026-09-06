"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	DndContext,
	type DragEndEvent,
	type DragMoveEvent,
	type DragStartEvent,
	DragOverlay,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { LayoutDashboard } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { EmptyState } from "@repo/ui/empty";
import { ScrollArea } from "@repo/ui/scroll-area";
import { cn } from "@repo/ui/utils";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";
import {
	buildOccupancy,
	clampToCols,
	collides,
	GRID_COLS,
	type GridRect,
	type Occupancy,
	occupancyExcluding,
} from "@/lib/widgets/layout";
import { useWidgetRefresh } from "@/hooks/use-widget-refresh";
import { ArtifactBrowser, SaveArtifactButton } from "./artifact-controls";
import { CellPrompt } from "./cell-prompt";
import { type DragMode, WidgetBody, WidgetCard } from "./widget-card";

/** Fixed row height (px) — pairs with `gap-2` (8px) for the cell math. */
const ROW_H = 88;
const GAP = 8;

interface DragState {
	id: string;
	mode: DragMode;
	/** The candidate rect under the pointer. */
	rect: GridRect;
	valid: boolean;
	/** Pointer-grab offset in cells (move only). */
	grab: { dx: number; dy: number };
	start: GridRect;
}

/**
 * The per-chat bento canvas: a fixed 5-column CSS grid that grows downward inside its
 * own scroll area. Widgets land via auto-pin / pin_widget (first-fit) and are dragged/
 * resized with pointer capture — a ghost outline previews the target region and the
 * drop commits only when collision-free (else snaps back). Keyboard move/resize lives
 * on each card; placements announce through the polite live region here.
 */
export function WidgetGrid({ className }: { className?: string }) {
	const widgets = useWidgetGridStore((s) => s.widgets);
	const loading = useWidgetGridStore((s) => s.loading);
	const threadId = useWidgetGridStore((s) => s.threadId);
	const place = useWidgetGridStore((s) => s.place);
	const containerRef = useRef<HTMLDivElement>(null);
	const [drag, setDrag] = useState<DragState | null>(null);
	const [liveMsg, setLiveMsg] = useState("");
	// Live widgets poll on their registry cadence while the tab is visible.
	const refresh = useWidgetRefresh();
	const cellPrompt = useWidgetGridStore((s) => s.cellPrompt);
	const setCellPrompt = useWidgetGridStore((s) => s.setCellPrompt);
	const maxRow = widgets.reduce((m, w) => Math.max(m, w.pos_y + w.rowspan), 0);

	const announce = useCallback((msg: string) => setLiveMsg(msg), []);

	/** The grid cell under a pointer event (unclamped). */
	const cellAt = useCallback((e: { clientX: number; clientY: number }) => {
		const el = containerRef.current;
		if (!el) return { x: 0, y: 0 };
		const r = el.getBoundingClientRect();
		const cellW = (r.width - GAP * (GRID_COLS - 1)) / GRID_COLS;
		return {
			x: Math.floor((e.clientX - r.left) / (cellW + GAP)),
			y: Math.floor((e.clientY - r.top) / (ROW_H + GAP)),
		};
	}, []);

	const rectsOf = useCallback(
		() =>
			widgets.map((w) => ({
				id: w.id,
				x: w.pos_x,
				y: w.pos_y,
				colspan: w.colspan,
				rowspan: w.rowspan,
			})),
		[widgets],
	);

	// The free cells of the visible area (content rows + one landing row), each with the
	// contiguous free span to its right (1–2). These render as faint guide squares so the
	// bento reads as an actual grid, and they ARE the click targets for the cell composer —
	// so a click can only ever land on an empty cell, and the composer's width is clamped to
	// the real free span (never overlapping a neighbouring widget).
	const freeCells = useMemo(() => {
		const occ = buildOccupancy(rectsOf());
		const cells: { x: number; y: number; span: number }[] = [];
		for (let y = 0; y <= maxRow; y++) {
			for (let x = 0; x < GRID_COLS; x++) {
				if (occ.has(`${x},${y}`)) continue;
				let span = 1;
				while (span < 2 && x + span < GRID_COLS && !occ.has(`${x + span},${y}`)) {
					span++;
				}
				cells.push({ x, y, span });
			}
		}
		return cells;
	}, [rectsOf, maxRow]);

	const onDragStart = useCallback(
		(e: React.PointerEvent, id: string, mode: DragMode) => {
			const w = widgets.find((x) => x.id === id);
			if (!w) return;
			e.preventDefault();
			const start: GridRect = {
				x: w.pos_x,
				y: w.pos_y,
				colspan: w.colspan,
				rowspan: w.rowspan,
			};
			const cell = cellAt(e);
			setDrag({
				id,
				mode,
				rect: start,
				valid: true,
				grab: { dx: cell.x - start.x, dy: cell.y - start.y },
				start,
			});
			const occ = occupancyExcluding(rectsOf(), id);

			const onMove = (ev: PointerEvent) => {
				const c = cellAt(ev);
				setDrag((d) => {
					if (!d) return d;
					const next = clampToCols(
						d.mode === "move"
							? { ...d.rect, x: c.x - d.grab.dx, y: c.y - d.grab.dy }
							: {
									...d.rect,
									colspan: c.x - d.start.x + 1,
									rowspan: c.y - d.start.y + 1,
								},
					);
					return { ...d, rect: next, valid: !collides(occ, next) };
				});
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				setDrag((d) => {
					if (d && d.valid) place(d.id, d.rect);
					return null;
				});
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[widgets, cellAt, rectsOf, place],
	);

	// --- Pointer MOVE via dnd-kit (the SE resize handle still uses onDragStart above). A small
	// activation distance keeps plain clicks (cell composer) working; a DragOverlay renders the
	// live card clone that follows the cursor, and we map the pointer to a target cell for the
	// same valid/invalid ghost + collision-checked commit as before.
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
	);
	const dragStartClient = useRef<{ x: number; y: number } | null>(null);
	const dragGrab = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
	const dragOcc = useRef<Occupancy>(new Set<string>());

	const onDndStart = useCallback(
		(e: DragStartEvent) => {
			const w = widgets.find((x) => x.id === String(e.active.id));
			if (!w) return;
			const ae = e.activatorEvent;
			const clientX =
				ae && "clientX" in ae ? Number(ae.clientX) : 0;
			const clientY =
				ae && "clientY" in ae ? Number(ae.clientY) : 0;
			dragStartClient.current = { x: clientX, y: clientY };
			const cell = cellAt({ clientX, clientY });
			dragGrab.current = { dx: cell.x - w.pos_x, dy: cell.y - w.pos_y };
			dragOcc.current = occupancyExcluding(rectsOf(), w.id);
			const rect: GridRect = {
				x: w.pos_x,
				y: w.pos_y,
				colspan: w.colspan,
				rowspan: w.rowspan,
			};
			setDrag({ id: w.id, mode: "move", rect, valid: true, grab: dragGrab.current, start: rect });
		},
		[widgets, cellAt, rectsOf],
	);

	const onDndMove = useCallback(
		(e: DragMoveEvent) => {
			const sc = dragStartClient.current;
			if (!sc) return;
			const cell = cellAt({ clientX: sc.x + e.delta.x, clientY: sc.y + e.delta.y });
			setDrag((d) => {
				if (!d) return d;
				const next = clampToCols({
					...d.rect,
					x: cell.x - dragGrab.current.dx,
					y: cell.y - dragGrab.current.dy,
				});
				return { ...d, rect: next, valid: !collides(dragOcc.current, next) };
			});
		},
		[cellAt],
	);

	const onDndEnd = useCallback(
		(_e: DragEndEvent) => {
			setDrag((d) => {
				if (d?.valid) place(d.id, d.rect);
				return null;
			});
			dragStartClient.current = null;
		},
		[place],
	);

	const onDndCancel = useCallback(() => {
		setDrag(null);
		dragStartClient.current = null;
	}, []);

	// The widget being dragged (rendered in the overlay) sized to its pixel footprint.
	const activeWidget = drag ? widgets.find((w) => w.id === drag.id) : null;
	const overlaySize = (cols: number, rows: number) => {
		const el = containerRef.current;
		const cellW = el
			? (el.getBoundingClientRect().width - GAP * (GRID_COLS - 1)) / GRID_COLS
			: 160;
		return {
			width: cols * cellW + (cols - 1) * GAP,
			height: rows * ROW_H + (rows - 1) * GAP,
		};
	};

	return (
		<DndContext
			sensors={sensors}
			onDragStart={onDndStart}
			onDragMove={onDndMove}
			onDragEnd={onDndEnd}
			onDragCancel={onDndCancel}
		>
		<ScrollArea className={cn("h-full", className)}>
			<div className="p-4">
				<div className="mb-2 flex items-center justify-between">
					<span className="vx-eyebrow text-ui-3xs">Grid</span>
					<span className="flex items-center gap-1.5">
						<ArtifactBrowser threadId={threadId} />
						<SaveArtifactButton widgets={widgets} kind="dashboard" />
					</span>
				</div>
				{widgets.length === 0 && !loading && (
					<EmptyState
						className="gap-3 border border-border p-8 md:p-8 [&_[data-slot=empty-title]]:text-ui-md [&_[data-slot=empty-title]]:font-normal [&_[data-slot=empty-description]]:text-xs"
						icon={<LayoutDashboard />}
						title="The grid is empty."
						description="Ask Elench for your clusters, jobs, usage, or a full dashboard — structured results pin here as widgets."
					/>
				)}
				<div
					ref={containerRef}
					data-testid="widget-grid"
					className="relative grid grid-cols-5 gap-2"
					style={{
						gridAutoRows: `${ROW_H}px`,
						// Keep one clickable empty row below the content so "describe what goes
						// here…" always has somewhere to land.
						minHeight: (maxRow + 1) * (ROW_H + GAP),
					}}
				>
					{/* Faint guide cells give the bento visible structure AND are the only
					    click targets — clicking one opens the composer at that free cell,
					    sized to its real free span. Hidden while a composer is already open. */}
					{widgets.length > 0 &&
						!cellPrompt &&
						freeCells.map((c) => (
							<button
								key={`cell-${c.x}-${c.y}`}
								type="button"
								aria-label={`Add a widget at row ${c.y + 1}, column ${c.x + 1}`}
								onClick={() => setCellPrompt(c)}
								style={{
									gridColumn: `${c.x + 1} / span 1`,
									gridRow: `${c.y + 1} / span 1`,
								}}
								className="group/cell flex items-center justify-center border border-dashed border-border/60 text-transparent transition-colors hover:border-foreground/40 hover:bg-muted/40 hover:text-muted-foreground"
							>
								<span className="text-lg leading-none group-hover/cell:text-muted-foreground">
									+
								</span>
							</button>
						))}
					{widgets.map((w) => (
						<WidgetCard
							key={w.id}
							widget={w}
							onDragStart={onDragStart}
							announce={announce}
							onRefresh={refresh}
						/>
					))}
					{cellPrompt && <CellPrompt cell={cellPrompt} />}
					{/* Drop-target ghost while dragging. */}
					{drag && (
						<div
							aria-hidden
							className={cn(
								"pointer-events-none border border-dashed",
								drag.valid ? "border-foreground/60" : "border-foreground/20",
							)}
							style={{
								gridColumn: `${drag.rect.x + 1} / span ${drag.rect.colspan}`,
								gridRow: `${drag.rect.y + 1} / span ${drag.rect.rowspan}`,
							}}
						/>
					)}
				</div>
				{/* Keyboard placement announcements. */}
				<div aria-live="polite" className="sr-only">
					{liveMsg}
				</div>
			</div>
		</ScrollArea>
		{/* The floating clone that follows the cursor while dragging (sticks to the pointer). */}
		<DragOverlay dropAnimation={null}>
			{activeWidget ? (
				<div
					style={overlaySize(activeWidget.colspan, activeWidget.rowspan)}
					className="flex cursor-grabbing flex-col overflow-hidden border border-foreground bg-background opacity-95 shadow-lg"
				>
					<div className="flex h-7 flex-none items-center border-b border-border px-2">
						<span className="min-w-0 flex-1 truncate font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
							{activeWidget.title}
						</span>
					</div>
					<div className="min-h-0 flex-1 overflow-hidden">
						<WidgetBody widget={activeWidget} />
					</div>
				</div>
			) : null}
		</DragOverlay>
		</DndContext>
	);
}
