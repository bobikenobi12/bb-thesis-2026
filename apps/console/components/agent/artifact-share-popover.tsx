"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Building2, Check, Loader2, Share2, Shield, Users } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  type ArtifactShareAccess,
  type ShareScopeType,
  getArtifactShareAccess,
  listArtifactShares,
  shareArtifact,
  unshareArtifact,
} from "@/app/server/actions/artifact-shares";
import { track } from "@/lib/analytics/track";
import { Button } from "@repo/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";

/** A share target's stable key — `${scopeType}:${scopeId ?? ""}`. */
function keyOf(scopeType: ShareScopeType, scopeId: string | null): string {
  return `${scopeType}:${scopeId ?? ""}`;
}

/**
 * The Claude-Code-style "Share" control on a saved artifact: a button + popover to grant it to
 * the whole org, a specific team, or a role. Self-gating — renders nothing unless the caller's
 * org can collaborate (paid, more than one member). Only the artifact's creator sees it.
 */
export function ArtifactSharePopover({ artifactId }: { artifactId: string }) {
  const [access, setAccess] = useState<ArtifactShareAccess | null>(null);
  const [open, setOpen] = useState(false);
  const [shared, setShared] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Whether the Share UI is available at all (one lookup per artifact view).
  useEffect(() => {
    let cancelled = false;
    void getArtifactShareAccess()
      .then((a) => {
        if (!cancelled) setAccess(a);
      })
      .catch(() => {
        if (!cancelled) setAccess({ canShare: false, teams: [], roles: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the current share targets whenever the popover opens.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void listArtifactShares(artifactId)
      .then((rows) =>
        setShared(new Set(rows.map((r) => keyOf(r.scopeType, r.scopeId)))),
      )
      .catch(() => setShared(new Set()))
      .finally(() => setLoading(false));
  }, [open, artifactId]);

  const toggle = useCallback(
    async (scopeType: ShareScopeType, scopeId: string | null) => {
      const k = keyOf(scopeType, scopeId);
      const isOn = shared.has(k);
      setBusy(k);
      setShared((prev) => {
        const next = new Set(prev);
        if (isOn) next.delete(k);
        else next.add(k);
        return next;
      });
      try {
        if (isOn) {
          await unshareArtifact(artifactId, scopeType, scopeId ?? undefined);
        } else {
          await shareArtifact(artifactId, scopeType, scopeId ?? undefined);
        }
        track(isOn ? "elench_artifact_unshared" : "elench_artifact_shared", {
          scope: scopeType,
        });
      } catch {
        // Revert the optimistic flip on failure.
        setShared((prev) => {
          const next = new Set(prev);
          if (isOn) next.add(k);
          else next.delete(k);
          return next;
        });
      } finally {
        setBusy(null);
      }
    },
    [artifactId, shared],
  );

  if (!access?.canShare) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button size="sm" variant="outline" className="gap-1.5 rounded-none">
            <Share2 className="h-3.5 w-3.5" />
            Share
          </Button>
        }
      />
      <PopoverContent align="end" className="w-72 rounded-none p-0">
        <div className="border-b border-border px-3 py-2.5">
          <div className="text-ui-md font-medium text-foreground">
            Share artifact
          </div>
          <div className="text-ui-xs text-muted-foreground">
            Choose who in your org can open this. Private to you otherwise.
          </div>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-4 text-ui-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="max-h-[320px] overflow-y-auto py-1">
            <ShareRow
              icon={<Building2 className="h-3.5 w-3.5" />}
              label="Everyone in org"
              sub="All members"
              checked={shared.has(keyOf("org", null))}
              busy={busy === keyOf("org", null)}
              onClick={() => void toggle("org", null)}
            />
            {access.teams.length > 0 && <SectionLabel>Teams</SectionLabel>}
            {access.teams.map((t) => (
              <ShareRow
                key={t.id}
                icon={<Users className="h-3.5 w-3.5" />}
                label={t.name}
                checked={shared.has(keyOf("team", t.id))}
                busy={busy === keyOf("team", t.id)}
                onClick={() => void toggle("team", t.id)}
              />
            ))}
            {access.roles.length > 0 && <SectionLabel>Roles</SectionLabel>}
            {access.roles.map((r) => (
              <ShareRow
                key={r.id}
                icon={<Shield className="h-3.5 w-3.5" />}
                label={r.name}
                checked={shared.has(keyOf("role", r.id))}
                busy={busy === keyOf("role", r.id)}
                onClick={() => void toggle("role", r.id)}
              />
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** A tiny uppercase mono section header inside the popover. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="vx-eyebrow px-3 pb-1 pt-2.5 text-ui-3xs text-muted-foreground">
      {children}
    </div>
  );
}

/** One toggleable share target with a leading icon and a right-aligned check box. */
function ShareRow({
  icon,
  label,
  sub,
  checked,
  busy,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  sub?: string;
  checked: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted disabled:opacity-60"
    >
      <span className="flex size-6 flex-none items-center justify-center border border-border text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui-md text-foreground">
          {label}
        </span>
        {sub && (
          <span className="block text-ui-2xs text-muted-foreground">
            {sub}
          </span>
        )}
      </span>
      <span
        className={
          "flex size-4 flex-none items-center justify-center border transition-colors " +
          (checked
            ? "border-foreground bg-foreground text-background"
            : "border-border")
        }
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : checked ? (
          <Check className="h-3 w-3" />
        ) : null}
      </span>
    </button>
  );
}
