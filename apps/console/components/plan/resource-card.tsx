"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatMonthlyRate } from "@repo/format";
import { Badge } from "@repo/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/ui/collapsible";
import type { PlanResource } from "@/lib/plan/parse-plan";
import {
  Network,
  GitBranch,
  ArrowUpRight,
  Globe,
  Route,
  Link,
  MapPin,
  Shield,
  ShieldCheck,
  ShieldAlert,
  KeyRound,
  Paperclip,
  FileKey,
  Server,
  Cpu,
  Puzzle,
  FileCode,
  Database,
  HardDrive,
  Layers,
  Zap,
  MessageSquare,
  Bell,
  Table,
  Lock,
  FileText,
  CheckCircle,
  Cloud,
  Container,
  FolderArchive,
  ScrollText,
  Box,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

const ICON_MAP: Record<string, LucideIcon> = {
  Network,
  GitBranch,
  ArrowUpRight,
  Globe,
  Route,
  Link,
  MapPin,
  Shield,
  ShieldCheck,
  ShieldAlert,
  KeyRound,
  Paperclip,
  FileKey,
  Server,
  Cpu,
  Puzzle,
  FileCode,
  Database,
  HardDrive,
  Layers,
  Zap,
  MessageSquare,
  Bell,
  Table,
  Lock,
  FileText,
  CheckCircle,
  Cloud,
  Container,
  FolderArchive,
  ScrollText,
  Box,
};

const ACTION_STYLES: Record<
  PlanResource["action"],
  { label: string; className: string }
> = {
  create: {
    label: "+ create",
    className: "border-border bg-muted text-foreground",
  },
  update: {
    label: "~ update",
    className: "border-border bg-muted text-muted-foreground",
  },
  delete: {
    label: "- destroy",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  replace: {
    label: "+/- replace",
    className: "border-border bg-muted text-muted-foreground",
  },
  "no-op": {
    label: "no change",
    className: "border-muted text-muted-foreground",
  },
};

interface ResourceCardProps {
  resource: PlanResource;
  cost?: number | null;
}

export function ResourceCard({ resource, cost }: ResourceCardProps) {
  const [open, setOpen] = useState(false);
  const Icon = ICON_MAP[resource.iconName] || Box;
  const actionStyle = ACTION_STYLES[resource.action];
  const propEntries = Object.entries(resource.properties);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-md border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
          />
        }
      >
        <ChevronRight
          className={`h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium">{resource.displayName}</span>
          <span className="ml-2 text-xs text-muted-foreground font-mono truncate">
            {resource.address}
          </span>
        </div>
        {cost !== undefined && cost !== null && (
          <span className="text-xs text-muted-foreground shrink-0">
            {formatMonthlyRate(cost, "exact")}
          </span>
        )}
        <Badge
          variant="outline"
          className={`text-ui-2xs shrink-0 ${actionStyle.className}`}
        >
          {actionStyle.label}
        </Badge>
      </CollapsibleTrigger>
      {propEntries.length > 0 && (
        <CollapsibleContent>
          <div className="ml-10 mr-3 mb-1 rounded-md border border-dashed bg-muted/20 px-3 py-2">
            <div className="grid gap-1">
              {propEntries.slice(0, 10).map(([key, prop]) => (
                <div key={key} className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground font-mono min-w-[140px]">
                    {key}:
                  </span>
                  <span
                    className={`font-mono truncate ${prop.computed ? "text-muted-foreground italic" : ""}`}
                  >
                    {prop.computed
                      ? "(known after apply)"
                      : typeof prop.value === "boolean"
                        ? prop.value
                          ? "true"
                          : "false"
                        : String(prop.value)}
                  </span>
                </div>
              ))}
              {propEntries.length > 10 && (
                <span className="text-xs text-muted-foreground">
                  +{propEntries.length - 10} more properties
                </span>
              )}
            </div>
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
