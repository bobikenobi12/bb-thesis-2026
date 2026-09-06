"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useReactFlow } from "@xyflow/react";
import {
  Hand,
  Layers,
  LayoutGrid,
  Maximize,
  Redo2,
  Settings2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useContext } from "react";
import { elkLayout } from "@/lib/canvas/auto-layout";
import { CanvasInteractionContext } from "./canvas-flow";
import { Button } from "@repo/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { Separator } from "@repo/ui/separator";
import { Switch } from "@repo/ui/switch";
import { cn } from "@repo/ui/utils";
import { PROJECT_NODE_ID, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { addableKindsFor, NODE_REGISTRY } from "./graph/node-registry";

/** A square ghost icon button sized for the controls bar. `active` marks a toggled-on tool. */
function CtrlButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        "h-8 w-8 rounded-none",
        active && "bg-muted text-foreground",
      )}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  );
}

/**
 * Bottom-left canvas control cluster: a settings popover (show connections / repair
 * overlaps / reset layout), zoom + fit, undo/redo, and a visibility-layers popover.
 * Must render inside a ReactFlowProvider (uses useReactFlow for zoom/fit).
 */
export function CanvasControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const canUndo = useCanvasStore((s) => s.past.length > 0);
  const canRedo = useCanvasStore((s) => s.future.length > 0);
  const showConnections = useCanvasStore((s) => s.showConnections);
  const toggleConnections = useCanvasStore((s) => s.toggleConnections);
  const repairOverlaps = useCanvasStore((s) => s.repairOverlaps);
  const coreProvider = useCanvasStore((s) =>
    s.getEffectiveProvider(PROJECT_NODE_ID),
  );
  const hiddenKinds = useCanvasStore((s) => s.hiddenKinds);
  const toggleKindVisibility = useCanvasStore((s) => s.toggleKindVisibility);
  const { handTool, setHandTool } = useContext(CanvasInteractionContext);

  // W3 — auto-arrange (elkjs). Lay out the design nodes (the hidden project/cluster/network are the
  // implicit substrate, not part of the graph), then commit the positions; the fit follows so the
  // tidied board is framed. A manual drag afterwards overrides until the next arrange.
  const handleArrange = useCallback(async () => {
    const s = useCanvasStore.getState();
    const layoutNodes = s.nodes.filter(
      (n) =>
        n.data.kind !== "project" &&
        n.data.kind !== "cluster" &&
        n.data.kind !== "network",
    );
    const positions = await elkLayout(
      layoutNodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
      s.edges,
    );
    s.arrange(positions);
    requestAnimationFrame(() => fitView({ padding: 0.3, duration: 300 }));
  }, [fitView]);

  return (
    <div className="absolute bottom-3 left-3 z-10 flex items-center border border-border bg-background/90 backdrop-blur">
      {/* Canvas settings */}
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-none"
              aria-label="Canvas settings"
              title="Canvas settings"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
          }
        />
        <PopoverContent align="start" side="top" className="w-56 p-1">
          <label className="flex cursor-pointer items-center justify-between gap-2 px-2 py-1.5 text-sm">
            <span>Show connections</span>
            <Switch
              checked={showConnections}
              onCheckedChange={toggleConnections}
            />
          </label>
          <Separator className="my-1" />
          <button
            type="button"
            onClick={repairOverlaps}
            className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
          >
            Repair overlaps
          </button>
          <button
            type="button"
            onClick={() => void handleArrange()}
            className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
          >
            Auto-arrange
          </button>
        </PopoverContent>
      </Popover>

      <Separator orientation="vertical" className="h-5" />

      <CtrlButton
        label="Auto-arrange (elkjs)"
        onClick={() => void handleArrange()}
      >
        <LayoutGrid className="h-3.5 w-3.5" />
      </CtrlButton>

      <Separator orientation="vertical" className="h-5" />

      <CtrlButton
        label="Hand tool — pan (H, or hold Space)"
        active={handTool}
        onClick={() => setHandTool(!handTool)}
      >
        <Hand className="h-3.5 w-3.5" />
      </CtrlButton>

      <Separator orientation="vertical" className="h-5" />

      <CtrlButton label="Zoom out" onClick={() => zoomOut()}>
        <ZoomOut className="h-3.5 w-3.5" />
      </CtrlButton>
      <CtrlButton label="Zoom in" onClick={() => zoomIn()}>
        <ZoomIn className="h-3.5 w-3.5" />
      </CtrlButton>
      <CtrlButton label="Fit view" onClick={() => fitView({ padding: 0.3 })}>
        <Maximize className="h-3.5 w-3.5" />
      </CtrlButton>

      <Separator orientation="vertical" className="h-5" />

      <CtrlButton label="Undo" onClick={undo} disabled={!canUndo}>
        <Undo2 className="h-3.5 w-3.5" />
      </CtrlButton>
      <CtrlButton label="Redo" onClick={redo} disabled={!canRedo}>
        <Redo2 className="h-3.5 w-3.5" />
      </CtrlButton>

      <Separator orientation="vertical" className="h-5" />

      {/* Visibility layers */}
      <Popover>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-none"
              aria-label="Visibility layers"
              title="Visibility layers"
            >
              <Layers className="h-3.5 w-3.5" />
            </Button>
          }
        />
        <PopoverContent align="start" side="top" className="w-56 p-1">
          <p className="px-2 py-1.5 text-ui-xs font-medium uppercase tracking-wide text-muted-foreground">
            Layers
          </p>
          {addableKindsFor(coreProvider).map((kind) => {
            const def = NODE_REGISTRY[kind];
            const Icon = def.icon;
            const visible = !hiddenKinds.includes(kind);
            return (
              <label
                key={kind}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted",
                  !visible && "text-muted-foreground",
                )}
              >
                <span className="flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5" />
                  {def.label}
                </span>
                <Switch
                  checked={visible}
                  onCheckedChange={() => toggleKindVisibility(kind)}
                />
              </label>
            );
          })}
        </PopoverContent>
      </Popover>
    </div>
  );
}
