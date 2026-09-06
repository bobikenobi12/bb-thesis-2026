"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useDraggable } from "@dnd-kit/core";
import { GripVertical, RefreshCw, Snowflake, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import { formatRelative } from "@repo/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";
import type { ThreadWidget } from "@/lib/db/schema";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";
import {
  clampToCols,
  collides,
  type GridRect,
  occupancyExcluding,
} from "@/lib/widgets/layout";
import type { DashboardBlock } from "@/types/jsonb.types";
import { SaveArtifactButton } from "./artifact-controls";
import { DashboardBlockBody } from "./bodies/blocks";
import { WIDGET_REGISTRY } from "./registry";

/** Drag intent a card hands to the grid (which owns the pointer math). */
export type DragMode = "move" | "resize";

/** The payload every widget renderer needs — shared by a live `thread_widgets` row and a
 * saved `ArtifactWidget`, so one body renders both. */
export type WidgetPayload = Pick<ThreadWidget, "source" | "data">;

/** Whether a widget's stored block payload is present (exploded dashboard widget). */
function blockOf(w: WidgetPayload): DashboardBlock | undefined {
  return w.data.block;
}

/** The widget's body: a dashboard block, or its source tool's registry body. Structural on
 * purpose, so it renders a live grid row, the drag overlay's clone, AND a widget inside a
 * SAVED artifact — all three carry the same `{source, data}` payload. */
export function WidgetBody({ widget }: { widget: WidgetPayload }) {
  const block = blockOf(widget);
  if (block) return <DashboardBlockBody block={block} />;
  const def = widget.source ? WIDGET_REGISTRY[widget.source.tool] : undefined;
  if (def && widget.data.output !== undefined) {
    return <def.Body output={widget.data.output} />;
  }
  return (
    <div className="flex h-full items-center justify-center text-ui-xs text-muted-foreground">
      No renderer for this widget.
    </div>
  );
}

/**
 * One bento-grid widget: hairline card with a lean caption row (drag grip, live/frozen,
 * refresh, save, delete) over its registry/block body. Pointer users drag from the grip
 * and resize from the corner handle (both delegated to the grid via `onDragStart`).
 * Keyboard users press Enter/Space on the focused grip to enter move mode, then step one
 * cell per arrow (Shift = resize), Enter commits, Esc reverts — announced via the grid's
 * live region. (The separate keyboard move/resize buttons were removed as redundant.)
 */
export function WidgetCard({
  widget,
  onDragStart,
  announce,
  onRefresh,
}: {
  widget: ThreadWidget;
  onDragStart: (e: React.PointerEvent, id: string, mode: DragMode) => void;
  announce: (msg: string) => void;
  /** Manual live-refresh (from the grid's polling hook). */
  onRefresh?: (id: string) => void;
}) {
  const place = useWidgetGridStore((s) => s.place);
  const remove = useWidgetGridStore((s) => s.remove);
  const setMode = useWidgetGridStore((s) => s.setMode);
  const widgets = useWidgetGridStore((s) => s.widgets);
  const [kb, setKb] = useState<{ mode: DragMode; rect: GridRect } | null>(null);
  // Pointer move is handled by dnd-kit: the grip is the drag handle and a DragOverlay
  // (owned by the grid) follows the cursor, so the source card just dims while active.
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: widget.id,
  });

  const rect: GridRect = kb?.rect ?? {
    x: widget.pos_x,
    y: widget.pos_y,
    colspan: widget.colspan,
    rowspan: widget.rowspan,
  };

  /** Step the keyboard rect one cell (move) or one span (resize). */
  const step = (dx: number, dy: number, resize: boolean) => {
    if (!kb) return;
    const next = clampToCols(
      resize || kb.mode === "resize"
        ? {
            ...kb.rect,
            colspan: kb.rect.colspan + dx,
            rowspan: kb.rect.rowspan + dy,
          }
        : { ...kb.rect, x: kb.rect.x + dx, y: kb.rect.y + dy },
    );
    setKb({ ...kb, rect: next });
    announce(
      `${widget.title}: row ${next.y + 1}, column ${next.x + 1}, ${next.colspan} by ${next.rowspan}`,
    );
  };

  const commitKb = () => {
    if (!kb) return;
    const occ = occupancyExcluding(
      widgets.map((w) => ({
        id: w.id,
        x: w.pos_x,
        y: w.pos_y,
        colspan: w.colspan,
        rowspan: w.rowspan,
      })),
      widget.id,
    );
    if (collides(occ, kb.rect)) {
      announce(`${widget.title}: target occupied — reverted`);
    } else {
      place(widget.id, kb.rect);
      announce(`${widget.title}: placed`);
    }
    setKb(null);
  };

  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-label={widget.title}
      data-testid="widget-card"
      data-widget-id={widget.id}
      style={{
        gridColumn: `${rect.x + 1} / span ${rect.colspan}`,
        gridRow: `${rect.y + 1} / span ${rect.rowspan}`,
      }}
      className={cn(
        "group/widget relative flex min-h-0 flex-col overflow-hidden border border-border bg-background",
        kb && "border-foreground",
        // While dragging, the floating overlay is the live copy — dim the source.
        isDragging && "opacity-40",
      )}
      onKeyDown={(e) => {
        if (!kb) return;
        const d: Record<string, [number, number]> = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        };
        const dir = d[e.key];
        if (dir) {
          e.preventDefault();
          step(dir[0], dir[1], e.shiftKey);
        } else if (e.key === "Enter") {
          e.preventDefault();
          commitKb();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setKb(null);
          announce(`${widget.title}: move cancelled`);
        }
      }}
    >
      <div className="flex h-7 flex-none items-center gap-1.5 border-b border-border px-2">
        {/* Drag to move (dnd-kit — a DragOverlay follows the cursor); Enter/Space enters
				    keyboard-move mode (arrows move, Shift+arrows resize). */}
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Move ${widget.title} — drag, or press Enter for keyboard mode`}
          aria-pressed={!!kb}
          className={cn(
            "flex h-full cursor-grab touch-none items-center text-muted-foreground hover:text-foreground",
            kb && "text-foreground",
          )}
          onKeyDown={(e) => {
            if (!kb && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              setKb({ mode: "move", rect });
            }
          }}
        >
          <GripVertical className="h-3 w-3" />
        </button>
        <span
          title={widget.title}
          className="min-w-0 flex-1 truncate font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground"
        >
          {widget.title}
        </span>
        {widget.source ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={
                    widget.mode === "live"
                      ? `Freeze ${widget.title}`
                      : `Make ${widget.title} live`
                  }
                  onClick={() =>
                    setMode(
                      widget.id,
                      widget.mode === "live" ? "frozen" : "live",
                    )
                  }
                  className={cn(
                    "flex flex-none items-center gap-1 font-mono text-ui-3xs uppercase transition-colors hover:text-foreground",
                    widget.mode === "live"
                      ? "text-foreground"
                      : "text-muted-foreground/70",
                  )}
                >
                  {widget.mode === "live" ? (
                    <Zap className="h-2.5 w-2.5" />
                  ) : (
                    <Snowflake className="h-2.5 w-2.5" />
                  )}
                  {widget.mode === "live" ? "Live" : "Frozen"}
                </button>
              }
            />
            <TooltipContent side="top" className="max-w-[220px] text-xs">
              {widget.mode === "live"
                ? "Live: refreshes on its own. Click to freeze as a fixed snapshot."
                : "Frozen: a fixed snapshot that won't update. Click to make it live."}
              {widget.refreshed_at
                ? ` · updated ${formatRelative(widget.refreshed_at)}`
                : ""}
            </TooltipContent>
          </Tooltip>
        ) : (
          widget.mode === "frozen" && (
            <span className="flex flex-none items-center gap-1 font-mono text-ui-3xs uppercase text-muted-foreground/70">
              <Snowflake className="h-2.5 w-2.5" />
              Frozen
            </span>
          )
        )}
        <span className="flex flex-none items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/widget:opacity-100">
          {widget.source && onRefresh && (
            <button
              type="button"
              aria-label={`Refresh ${widget.title}`}
              className="flex h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground"
              onClick={() => onRefresh(widget.id)}
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          )}
          <SaveArtifactButton
            widgets={[widget]}
            kind="widget"
            iconOnly
            defaultName={widget.title}
          />
          <button
            type="button"
            aria-label={`Remove ${widget.title}`}
            className="flex h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground"
            onClick={() => remove(widget.id)}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <WidgetBody widget={widget} />
      </div>
      {/* SE resize handle (pointer). */}
      <button
        type="button"
        aria-label={`Resize ${widget.title}`}
        className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize border-l border-t border-border bg-background opacity-0 transition-opacity group-hover/widget:opacity-100"
        onPointerDown={(e) => onDragStart(e, widget.id, "resize")}
      />
    </div>
  );
}
