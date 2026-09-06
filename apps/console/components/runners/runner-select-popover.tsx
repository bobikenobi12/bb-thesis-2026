"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useRunnersQuery } from "@/lib/query/use-runners-query";
import { Button } from "@repo/ui/button";
import { StatusBadge } from "@repo/ui/status-badge";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/ui/tooltip";
import { AlertTriangle, Check, Loader2, Server } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@repo/ui/utils";

interface RunnerSelectPopoverProps {
  trigger: React.ReactElement<Record<string, unknown>>;
  onConfirm: (runnerId: string | null, rePlan?: boolean) => void;
  disabled?: boolean;
  showRePlan?: boolean;
  variant?: "default" | "destructive";
  confirmLabel?: string;
  description?: string;
  excludeId?: string;
}

/** Popover that shows before Plan/Deploy — lets the user pick a runner or "Any available". */
export function RunnerSelectPopover({
  trigger,
  onConfirm,
  disabled,
  showRePlan,
  variant = "default",
  confirmLabel,
  description,
  excludeId,
}: RunnerSelectPopoverProps) {
  const {
    data: runnersData,
    isPending: isLoading,
    refetch,
  } = useRunnersQuery();
  const allRunners = runnersData?.runners ?? [];
  const runners = useMemo(
    () =>
      excludeId ? allRunners.filter((t) => t.id !== excludeId) : allRunners,
    [allRunners, excludeId],
  );
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [rePlan, setRePlan] = useState(false);

  useEffect(() => {
    if (open) {
      void refetch();
      const defaultRunner = runners.find(
        (w) => w.is_default && w.status === "ONLINE",
      );
      setSelected(defaultRunner?.id ?? null);
    }
  }, [open, refetch, runners]);

  const handleConfirm = () => {
    setOpen(false);
    onConfirm(selected, rePlan);
    setRePlan(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger disabled={disabled} render={trigger} />
      <PopoverContent align="end" className="w-72 p-0">
        <div className="px-3 pt-3 pb-2 border-b border-border/40">
          <p className="text-sm font-medium">Select runner</p>
          <p className="text-xs text-muted-foreground">
            Choose which runner runs this job.
          </p>
          {variant === "destructive" && description && (
            <div className="mt-2 flex gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-ui-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
              <span>{description}</span>
            </div>
          )}
        </div>

        {isLoading && runners.length === 0 ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="max-h-52 overflow-y-auto py-1">
            <button
              type="button"
              className={cn(
                "flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-accent transition-colors",
                selected === null && "bg-accent/50",
              )}
              onClick={() => setSelected(null)}
            >
              <div className="flex items-center justify-center h-4 w-4 shrink-0">
                {selected === null && <Check className="h-3.5 w-3.5" />}
              </div>
              <Server className="h-3.5 w-3.5 text-muted-foreground" />
              <span>Any available</span>
            </button>

            {runners.map((w) => {
              const status = w.status ?? "OFFLINE";
              const isOnline = status === "ONLINE";
              return (
                <button
                  key={w.id}
                  type="button"
                  disabled={!isOnline}
                  className={cn(
                    "flex items-center gap-2 w-full px-3 py-2 text-left text-sm transition-colors",
                    isOnline
                      ? "hover:bg-accent"
                      : "opacity-50 cursor-not-allowed",
                    selected === w.id && "bg-accent/50",
                  )}
                  onClick={() => isOnline && setSelected(w.id)}
                >
                  <div className="flex items-center justify-center h-4 w-4 shrink-0">
                    {selected === w.id && <Check className="h-3.5 w-3.5" />}
                  </div>
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <StatusBadge
                            status={status}
                            showLabel={false}
                            className="shrink-0"
                          />
                        }
                      />
                      <TooltipContent side="top" className="text-xs">
                        {status}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <span className="truncate flex-1">{w.name}</span>
                  {w.is_default && (
                    <span className="text-ui-2xs text-muted-foreground font-medium uppercase tracking-wide">
                      Default
                    </span>
                  )}
                  <span className="text-ui-2xs text-muted-foreground">
                    {w.operator === "managed" ? "managed" : "self"}
                  </span>
                </button>
              );
            })}

            {runners.length === 0 && (
              <p className="px-3 py-4 text-xs text-muted-foreground text-center">
                No runners registered.
              </p>
            )}
          </div>
        )}

        <div className="border-t border-border/40 px-3 py-2 space-y-2">
          {showRePlan && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={rePlan}
                onChange={(e) => setRePlan(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border accent-primary"
              />
              <span className="text-xs text-muted-foreground">
                Re-plan before applying
              </span>
            </label>
          )}
          <Button
            size="sm"
            variant={variant === "destructive" ? "destructive" : "default"}
            className="w-full h-8 text-xs"
            onClick={handleConfirm}
            disabled={isLoading && runners.length === 0}
          >
            {confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
