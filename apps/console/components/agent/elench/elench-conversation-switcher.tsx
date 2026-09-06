"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronDown, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentThread } from "@/lib/db/schema";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { ScrollArea } from "@repo/ui/scroll-area";

/** "13m ago" etc. */
function relTime(d: Date): string {
  const m = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * The panel header conversation switcher — a dropdown showing the active thread's
 * title, opening a search + recent-threads popover (org context). For the ephemeral
 * project context it degrades to a single "New conversation" action.
 */
export function ElenchConversationSwitcher({
  isOrg,
  threads,
  activeId,
  onSelectThread,
  onNewChat,
}: {
  isOrg: boolean;
  threads: AgentThread[];
  activeId: string | null;
  onSelectThread: (id: string) => void;
  onNewChat: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const label =
    threads.find((t) => t.id === activeId)?.title ?? "New conversation";

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return threads.filter(
      (t) => !needle || t.title.toLowerCase().includes(needle),
    );
  }, [threads, q]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 border border-border bg-background px-2.5 py-1.5 text-ui-md text-foreground transition-colors hover:bg-muted"
          >
            <span title={label} className="min-w-0 truncate">
              {label}
            </span>
            <ChevronDown className="h-3.5 w-3.5 flex-none text-muted-foreground" />
          </button>
        }
      />
      <PopoverContent
        align="start"
        side="bottom"
        className="w-[280px] rounded-none p-2"
      >
        {isOrg && (
          <>
            <div className="mb-1 flex items-center gap-2 bg-muted px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 flex-none text-muted-foreground" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search…"
                className="w-full bg-transparent text-ui-md text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
            {filtered.length > 0 && (
              <div className="vx-eyebrow px-2 pb-1 pt-2 text-ui-3xs">Recent</div>
            )}
            <ScrollArea className="max-h-[240px]">
              {filtered.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    onSelectThread(t.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-2.5 rounded-none px-2 py-2 text-left transition-colors hover:bg-muted"
                >
                  <span
                    title={t.title}
                    className="min-w-0 flex-1 truncate text-ui-md text-foreground"
                  >
                    {t.title}
                  </span>
                  <span className="flex-none font-mono text-ui-xs text-muted-foreground">
                    {relTime(new Date(t.updated_at))}
                  </span>
                </button>
              ))}
            </ScrollArea>
            <div className="my-1.5 h-px bg-border" />
          </>
        )}
        <button
          type="button"
          onClick={() => {
            onNewChat();
            setOpen(false);
          }}
          className="flex w-full items-center justify-center gap-2 rounded-none px-2 py-2 text-ui-md text-foreground transition-colors hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
          New conversation
        </button>
      </PopoverContent>
    </Popover>
  );
}
