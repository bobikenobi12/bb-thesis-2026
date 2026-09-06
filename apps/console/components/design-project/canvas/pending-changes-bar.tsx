"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Loader2, Rocket } from "lucide-react";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { Button } from "@repo/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { Separator } from "@repo/ui/separator";
import { cn } from "@repo/ui/utils";
import { diffNodes, useCanvasStore } from "@/lib/stores/use-canvas-store";
import { NODE_REGISTRY } from "./graph/node-registry";

interface PendingChangesBarProps {
  /** Persist staged changes + queue provisioning (applyStagedChanges + provision in edit
   * mode; createProject in the create flow). */
  onDeploy: () => void;
  deploying?: boolean;
  /** What the primary button actually does. Defaults to "Deploy"; the create flow passes
   * "Create project", where the click persists the project and queues NO provisioning job. */
  deployLabel?: string;
  /** Clear durable server-side staged changes (edit mode), alongside the client revert. */
  onDiscard?: () => void;
}

const OP_LABEL: Record<"new" | "modified" | "removed", string> = {
  new: "Created",
  modified: "Updated",
  removed: "Removed",
};

const OP_GLYPH: Record<"new" | "modified" | "removed", string> = {
  new: "+",
  modified: "~",
  removed: "−",
};

/**
 * Floating bar that surfaces the project's staged changes (canvas vs. saved baseline)
 * and gates them behind Deploy / Discard / Destroy. The diff is computed client-side
 * from the canvas store; the durable backing store + real provisioning land in Part B.
 */
export function PendingChangesBar({
  onDeploy,
  deploying,
  deployLabel = "Deploy",
  onDiscard,
}: PendingChangesBarProps) {
  const nodes = useCanvasStore((s) => s.nodes);
  const baseline = useCanvasStore((s) => s.baseline);
  const discardChanges = useCanvasStore((s) => s.discardChanges);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  /** Revert the canvas to baseline and clear any durable server-side staged changes. */
  const handleDiscard = () => {
    discardChanges();
    onDiscard?.();
  };

  const changes = useMemo(() => diffNodes(baseline, nodes), [baseline, nodes]);
  const newCount = changes.filter((c) => c.op === "new").length;

  if (changes.length === 0) return null;

  return (
    <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
      <div className="flex items-center gap-1 rounded-none border border-border bg-card/95 p-1 shadow-[0_2px_10px_rgba(0,0,0,0.10)] backdrop-blur">
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                className="flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm transition-colors hover:bg-muted"
              >
                <span className="font-medium">Pending changes</span>
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 font-mono text-ui-2xs tabular-nums text-background">
                  {changes.length}
                </span>
              </button>
            }
          />
          <PopoverContent
            side="top"
            align="center"
            className="w-80 rounded-none p-0"
          >
            <div className="border-b border-border px-3.5 py-3">
              <div className="flex items-center justify-between">
                <p className="text-ui-md font-medium">Pending changes</p>
                {newCount > 0 && (
                  <span className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
                    +{newCount} new
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Staged before going live. Review, then {deployLabel}.
              </p>
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {changes.map((c) => {
                const def = NODE_REGISTRY[c.kind];
                const Icon = def.icon;
                return (
                  <div
                    key={`${c.op}-${c.id}`}
                    className="flex items-center gap-2.5 px-3.5 py-2"
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center border font-mono text-ui-xs leading-none",
                        c.op === "removed"
                          ? "border-destructive/40 text-destructive"
                          : "border-border text-muted-foreground",
                      )}
                      aria-hidden
                    >
                      {OP_GLYPH[c.op]}
                    </span>
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-ui-md leading-tight">
                        {c.name}
                      </div>
                      <div className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
                        {OP_LABEL[c.op]} · {def.label}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>

        <Separator orientation="vertical" className="h-5" />

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 text-xs"
          onClick={() => setConfirmDiscard(true)}
        >
          Discard
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-8 text-xs"
          onClick={onDeploy}
          disabled={deploying}
        >
          {deploying ? (
            <>
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              Deploying…
            </>
          ) : (
            <>
              <Rocket className="mr-1 h-3.5 w-3.5" />
              {deployLabel}
            </>
          )}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard staged changes?"
        description="This reverts the canvas to the last deployed state and clears all pending changes. This cannot be undone."
        confirmLabel="Discard"
        onConfirm={handleDiscard}
      />
    </div>
  );
}
