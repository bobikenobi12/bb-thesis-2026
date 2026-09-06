"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/ui/collapsible";
import { Switch } from "@repo/ui/switch";
import { PERMISSIONS, RESOURCES, type Resource } from "@/lib/authz/registry";

// "Per service" grouping — each resource type is its own section, so granting is
// granular (e.g. projects' plan/deploy/destroy independently of runners).
const RESOURCE_LABEL: Record<Resource, string> = {
  org: "Organization",
  project: "Projects",
  runner: "Runners",
  cloud_identity: "Cloud identities",
  job: "Jobs",
  connector: "Connectors",
  member: "Members",
  activity: "Activity",
  billing: "Billing",
  alert: "Alerts",
  fleet: "Fleet",
  support_case: "Support",
};

const GROUPS = RESOURCES.map((resource) => ({
  resource,
  label: RESOURCE_LABEL[resource],
  permissions: PERMISSIONS.filter((p) => p.resource === resource),
})).filter((g) => g.permissions.length > 0);

/**
 * Controlled permission picker (the chosen `resource:action` keys), grouped per
 * service. `readOnly` renders it as a disabled, view-only matrix (built-in roles).
 */
export function PermissionMatrix({
  value,
  onChange,
  readOnly,
}: {
  value: string[];
  onChange?: (keys: string[]) => void;
  readOnly?: boolean;
}) {
  const selected = new Set(value);
  const toggle = (key: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    onChange?.([...next]);
  };

  return (
    // Each resource group is a collapsible section — collapsed by default so the whole
    // matrix stays compact; a "granted/total" badge keeps the selection visible while
    // closed, and groups with any grant open on mount so edits aren't hidden.
    <div className="space-y-2.5">
      {GROUPS.map((g) => {
        const granted = g.permissions.filter((p) => selected.has(p.key)).length;
        return (
          <Collapsible
            key={g.resource}
            defaultOpen={granted > 0}
            className="overflow-hidden rounded-lg border border-border"
          >
            <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-muted">
              <span className="flex items-center gap-2">
                <span className="text-ui-md font-medium text-text-primary">
                  {g.label}
                </span>
                <span
                  className={
                    granted > 0
                      ? "rounded-full border border-border-strong px-1.5 py-0.5 font-mono text-ui-2xs text-text-secondary"
                      : "rounded-full border border-border px-1.5 py-0.5 font-mono text-ui-2xs text-text-tertiary"
                  }
                >
                  {granted}/{g.permissions.length}
                </span>
              </span>
              <ChevronDown
                size={15}
                className="shrink-0 text-text-tertiary transition-transform group-data-[panel-open]:rotate-180"
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="border-t border-border">
                {g.permissions.map((p) => (
                  <div
                    key={p.key}
                    className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="text-ui-md capitalize text-text-primary">
                        {p.action.replace(/_/g, " ")}
                      </p>
                      <p className="truncate font-mono text-ui-2xs text-text-tertiary">
                        {p.key}
                      </p>
                    </div>
                    <Switch
                      checked={selected.has(p.key)}
                      disabled={readOnly}
                      onCheckedChange={
                        readOnly ? undefined : (on) => toggle(p.key, on)
                      }
                    />
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}
