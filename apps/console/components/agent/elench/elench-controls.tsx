"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
  Brain,
  Check,
  ChevronsRight,
  type LucideIcon,
  Pencil,
  SlidersHorizontal,
  Sparkles,
  Zap,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/tooltip";
import { AI_MODELS } from "@/lib/config/ai";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { cn } from "@repo/ui/utils";
import { useAiTier } from "./use-ai-tier";

/**
 * The composer Ask-mode pill + popover. "Ask before editing" → `mode: "ask"`
 * (review & approve each change); "Automatically edit" → `mode: "act"` (allow edits
 * for this conversation). Drives the shared store's mode (the org agent route reads
 * it to gate the mutation tools).
 */
export function ElenchAskMode() {
  const mode = useElenchStore((s) => s.mode);
  const setMode = useElenchStore((s) => s.setMode);
  const isAsk = mode === "ask";

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground transition-colors hover:bg-muted"
          >
            {isAsk ? (
              <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronsRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            {isAsk ? "Ask" : "Auto"}
          </button>
        }
      />
      <PopoverContent
        align="start"
        side="top"
        className="w-[270px] rounded-none p-1.5"
      >
        <button
          type="button"
          onClick={() => setMode("ask")}
          className={cn(
            "flex w-full items-start gap-2.5 rounded-none px-2.5 py-2 text-left transition-colors hover:bg-muted",
            isAsk && "bg-muted",
          )}
        >
          <Pencil className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
          <span className="flex-1">
            <span className="block text-ui-md font-medium text-foreground">
              Ask before editing
            </span>
            <span className="block text-xs text-muted-foreground">
              Review and approve each change
            </span>
          </span>
          {isAsk && (
            <Check className="mt-0.5 h-3.5 w-3.5 flex-none text-foreground" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setMode("act")}
          className={cn(
            "flex w-full items-start gap-2.5 rounded-none px-2.5 py-2 text-left transition-colors hover:bg-muted",
            !isAsk && "bg-muted",
          )}
        >
          <ChevronsRight className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
          <span className="flex-1">
            <span className="block text-ui-md font-medium text-foreground">
              Automatically edit
            </span>
            <span className="block text-xs text-muted-foreground">
              Always allow edits for this conversation
            </span>
          </span>
          {!isAsk && (
            <Check className="mt-0.5 h-3.5 w-3.5 flex-none text-foreground" />
          )}
        </button>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The per-message "Deep reasoning" toggle. Renders ONLY on the `ai_max` tier, whose state
 * rides the request as `deepReasoning` (the route swaps in a deeper planning model for that
 * turn). Hidden on every other tier (and while the tier is still resolving), so it's a
 * Max-only affordance. Deliberately names no model — only the intent.
 */
export function ElenchDeepReasoning() {
  const tier = useAiTier();
  const deepReasoning = useElenchStore((s) => s.deepReasoning);
  const setDeepReasoning = useElenchStore((s) => s.setDeepReasoning);

  if (tier !== "ai_max") return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-pressed={deepReasoning}
            onClick={() => setDeepReasoning(!deepReasoning)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
              deepReasoning
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-foreground hover:bg-muted",
            )}
          >
            <Sparkles
              className={cn(
                "h-3.5 w-3.5",
                deepReasoning
                  ? "text-primary-foreground"
                  : "text-muted-foreground",
              )}
            />
            Deep reasoning
          </button>
        }
      />
      <TooltipContent side="top" className="max-w-[240px] text-xs">
        Think harder on this message — slower, deeper planning. A Max feature;
        off by default.
      </TooltipContent>
    </Tooltip>
  );
}

/** Intent icon for a picker entry — keyed off its `label` (never the model name). */
const MODEL_ICON: Record<string, LucideIcon> = {
  Fast: Zap,
  Thinking: Brain,
};

/**
 * The composer model picker — the sliders button that opens a two-choice intent popover
 * ("Fast" / "Thinking"). It deliberately shows only the INTENT, never the underlying model
 * name/provider; the store still holds (and the request still sends) the real
 * `provider/native-id` key. Org context only (the project route has no user-selectable model).
 */
export function ElenchModelButton() {
  const model = useElenchStore((s) => s.model);
  const setModel = useElenchStore((s) => s.setModel);

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Response style"
        className="inline-flex size-7 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <SlidersHorizontal className="h-4 w-4" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-[270px] rounded-none p-1.5"
      >
        {AI_MODELS.map((m) => {
          const Icon = MODEL_ICON[m.label] ?? Zap;
          const active = m.id === model;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setModel(m.id)}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-none px-2.5 py-2 text-left transition-colors hover:bg-muted",
                active && "bg-muted",
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 flex-none text-muted-foreground" />
              <span className="flex-1">
                <span className="block text-ui-md font-medium text-foreground">
                  {m.label}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {m.blurb}
                </span>
              </span>
              {active && (
                <Check className="mt-0.5 h-3.5 w-3.5 flex-none text-foreground" />
              )}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
