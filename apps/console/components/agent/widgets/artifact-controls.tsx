"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BookmarkPlus, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  listArtifacts,
  openArtifactOnGrid,
  saveArtifact,
} from "@/app/server/actions/artifacts";
import type { AgentArtifact, ThreadWidget } from "@/lib/db/schema";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";
import type { ArtifactSpec } from "@/types/jsonb.types";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";

/**
 * Portal these grid-header popovers to `<body>` instead of base-ui's default (which nests the popup
 * into the enclosing Elench `Dialog`'s floating-tree portal). Nested there, the popup lands DOM-before
 * the `position: relative` widget-grid, which then paints over it and swallows the click on "Save" /
 * an artifact row. Portaling to `<body>` makes the popup a later body child that paints above the
 * dialog content, while base-ui keeps it in the dialog's React floating tree (so dismiss + inert
 * exemption still work). Guarded for SSR — the portal only renders once the popover is open (client).
 */
function bodyContainer() {
  return typeof document !== "undefined" ? document.body : undefined;
}

/** Portable spec from live rows: positions normalized to the selection's top row. */
export function specFromWidgets(widgets: ThreadWidget[]): ArtifactSpec {
  const minY = widgets.reduce(
    (m, w) => Math.min(m, w.pos_y),
    Number.POSITIVE_INFINITY,
  );
  return {
    widgets: widgets.map((w) => ({
      kind: w.kind,
      title: w.title,
      source: w.source,
      data: w.data,
      mode: w.mode,
      position: { x: w.pos_x, y: w.pos_y - (Number.isFinite(minY) ? minY : 0) },
      size: { colspan: w.colspan, rowspan: w.rowspan },
    })),
  };
}

/**
 * Name-and-save popover: promotes the given widgets (one, or the whole grid) into a
 * named org-scoped artifact other chats can @-reference and edit.
 */
export function SaveArtifactButton({
  widgets,
  kind,
  iconOnly = false,
  defaultName = "",
}: {
  widgets: ThreadWidget[];
  kind: "widget" | "dashboard";
  iconOnly?: boolean;
  defaultName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );

  const save = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || widgets.length === 0) return;
    setState("saving");
    try {
      await saveArtifact(trimmed, kind, specFromWidgets(widgets));
      setState("saved");
      setTimeout(() => {
        setOpen(false);
        setState("idle");
      }, 900);
    } catch {
      setState("error");
    }
  }, [name, widgets, kind]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size={iconOnly ? "icon-sm" : "sm"}
            aria-label={
              kind === "widget"
                ? "Save widget as artifact"
                : "Save dashboard as artifact"
            }
            className="h-5 gap-1 rounded-none px-1 text-ui-2xs text-muted-foreground hover:text-foreground"
            disabled={widgets.length === 0}
          >
            <BookmarkPlus className="h-3 w-3" />
            {!iconOnly && "Save as artifact"}
          </Button>
        }
      />
      <PopoverContent
        align="end"
        container={bodyContainer()}
        // An overlay opened from INSIDE another overlay: portaled to <body> it is a sibling of the
        // enclosing fullscreen Elench Dialog, so it has to out-rank that dialog's --z-overlay to
        // paint above the grid — at an equal z the later-painted grid swallows the Save click.
        // That is exactly what --z-overlay-nested names (packages/brand/src/tokens.css).
        className="z-[var(--z-overlay-nested)] w-[240px] rounded-none p-2"
      >
        <div className="vx-eyebrow pb-1.5 text-ui-3xs">
          {kind === "widget"
            ? "Save widget as artifact"
            : "Save dashboard as artifact"}
        </div>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Artifact name"
          className="h-7 rounded-none text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-ui-2xs text-muted-foreground">
            {state === "error"
              ? "Save failed (name taken?)"
              : state === "saved"
                ? "Saved."
                : `${widgets.length} ${widgets.length === 1 ? "widget" : "widgets"}`}
          </span>
          <Button
            size="sm"
            className="h-6 rounded-none px-2 text-ui-xs"
            onClick={() => void save()}
            disabled={!name.trim() || state === "saving"}
          >
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Artifact browser: lists the org's saved artifacts; "Open on grid" materializes one
 * onto the active thread's grid (fresh linked rows, shifted below existing widgets).
 */
export function ArtifactBrowser({ threadId }: { threadId: string | null }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AgentArtifact[] | null>(null);
  const hydrate = useWidgetGridStore((s) => s.hydrate);

  useEffect(() => {
    if (!open) return;
    setItems(null);
    void listArtifacts()
      .then(setItems)
      .catch(() => setItems([]));
  }, [open]);

  const openOnGrid = useCallback(
    async (id: string) => {
      if (!threadId) return;
      await openArtifactOnGrid(id, threadId);
      // Re-pull the grid so the materialized rows appear.
      useWidgetGridStore.setState({ threadId: null });
      await hydrate(threadId);
      setOpen(false);
    },
    [threadId, hydrate],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label="Browse artifacts"
            className="h-5 gap-1 rounded-none px-1 text-ui-2xs text-muted-foreground hover:text-foreground"
          >
            <FolderOpen className="h-3 w-3" />
            Artifacts
          </Button>
        }
      />
      <PopoverContent
        align="end"
        container={bodyContainer()}
        // Same reason as SaveArtifactButton: a nested overlay that must sit above the enclosing
        // fullscreen dialog so the grid can't intercept clicks on artifact rows.
        className="z-[var(--z-overlay-nested)] w-[260px] rounded-none p-2"
      >
        <div className="vx-eyebrow pb-1.5 text-ui-3xs">Saved artifacts</div>
        {items === null ? (
          <div className="py-3 text-center text-ui-xs text-muted-foreground">
            Loading…
          </div>
        ) : items.length === 0 ? (
          <div className="py-3 text-center text-ui-xs text-muted-foreground">
            Nothing saved yet — pin widgets, then “Save as artifact”.
          </div>
        ) : (
          <div className="max-h-[240px] overflow-y-auto">
            {items.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => void openOnGrid(a.id)}
                disabled={!threadId}
                className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left transition-colors hover:bg-muted disabled:opacity-50"
              >
                <span
                  title={a.name}
                  className="min-w-0 flex-1 truncate text-ui-sm text-foreground"
                >
                  {a.name}
                </span>
                <span className="flex-none font-mono text-ui-3xs uppercase text-muted-foreground">
                  {a.kind} · {a.spec.widgets.length}
                </span>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
