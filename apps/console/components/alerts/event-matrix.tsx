"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The category-grouped event selector shared by the policy create sheet and the inline
// policy editor. Each category is a Collapsible (collapsed by default, auto-open when it
// already has selections) with a switch per event — never click-rows. Security (authz.*)
// events are locked without the advancedAlerting entitlement (disabled + a tooltip).

import { Bell, ChevronRight, Lock } from "lucide-react";
import { CATEGORY_ICON } from "@/components/alerts/policy-shared";
import { type CatalogCategory, isSecurityKey } from "@/lib/alerts/catalog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/ui/collapsible";
import { Switch } from "@repo/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";

interface EventMatrixProps {
  categories: CatalogCategory[];
  /** Selected event keys/patterns. */
  selected: string[];
  onToggle: (key: string) => void;
  advancedAlerting: boolean;
  /** When false the matrix is read-only (status labels instead of switches). */
  editable: boolean;
}

/** A collapsible, switch-driven event picker. */
export function EventMatrix({
  categories,
  selected,
  onToggle,
  advancedAlerting,
  editable,
}: EventMatrixProps) {
  const set = new Set(selected);
  return (
    <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-background">
      {categories.map((cat) => {
        const Icon = CATEGORY_ICON[cat.icon] ?? Bell;
        const onCount = cat.events.filter((e) => set.has(e.key)).length;
        return (
          <Collapsible key={cat.id} defaultOpen={onCount > 0}>
            <CollapsibleTrigger className="group flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-muted/40">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="font-mono text-ui-2xs uppercase tracking-wider text-foreground/80">
                {cat.label}
              </span>
              <span className="ml-auto font-mono text-ui-2xs text-muted-foreground">
                {onCount}/{cat.events.length}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="border-t border-border/60">
                {cat.events.map((e) => {
                  const on = set.has(e.key);
                  const locked = isSecurityKey(e.key) && !advancedAlerting;
                  return (
                    // Not a table and not a grid: one label and one control per row, which is
                    // what a flex row is for. Spelling the same two tracks out as
                    // `grid-cols-[1fr_auto]` claimed a column structure that has no header
                    // row, no third column and nothing for a screen reader to associate.
                    <div
                      key={e.id}
                      className="flex items-center gap-4 px-4 py-2.5 pl-11 hover:bg-muted/30"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-ui-md">
                          {e.label}
                          <span className="rounded-full border border-border/60 px-1.5 py-0 font-mono text-ui-3xs uppercase tracking-wide text-muted-foreground">
                            {e.severity}
                          </span>
                          {!e.live && (
                            <span className="font-mono text-ui-3xs text-muted-foreground/60">
                              soon
                            </span>
                          )}
                        </div>
                        <div className="truncate font-mono text-ui-2xs text-muted-foreground/60">
                          {e.key}
                        </div>
                      </div>
                      {locked ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span className="inline-flex cursor-default items-center gap-1.5 font-mono text-ui-2xs uppercase text-muted-foreground/60">
                                <Lock className="size-3" />
                                Ent
                              </span>
                            }
                          />
                          <TooltipContent
                            side="left"
                            className="max-w-[200px] text-xs"
                          >
                            Security (PDP) events require an Enterprise plan.
                          </TooltipContent>
                        </Tooltip>
                      ) : editable ? (
                        <Switch
                          checked={on}
                          onCheckedChange={() => onToggle(e.key)}
                        />
                      ) : (
                        <span
                          className={cn(
                            "flex items-center gap-1.5 font-mono text-ui-2xs uppercase",
                            on ? "text-foreground" : "text-muted-foreground/50",
                          )}
                        >
                          <span
                            className={cn(
                              "size-1.5 rounded-full",
                              on
                                ? "bg-foreground"
                                : "border-[1.5px] border-border",
                            )}
                          />
                          {on ? "On" : "Off"}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}
