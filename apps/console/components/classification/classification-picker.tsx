"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Popover to set/clear a resource's classification values. One section per dimension:
// single-valued dimensions behave like a radio (picking a value swaps the prior one;
// picking the selected value clears it), multi-valued like checkboxes. Writes through the
// server actions with optimistic TanStack Query updates (see use-classification-query).

import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { cn } from "@repo/ui/utils";
import { ArrowRight, Check, Tags } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { ReactElement, ReactNode } from "react";
import type { DimensionDTO } from "@/app/server/actions/classification/dimensions";
import type { ResourceKind } from "@/lib/db/schema/enums";
import type { AssignedValue } from "@/lib/queries/classification";
import {
  useAssignmentMutations,
  useAssignmentsQuery,
  useDimensionsQuery,
} from "@/lib/query/use-classification-query";

/** A single selectable value row inside a dimension section. */
function ValueRow({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60",
        selected ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <Check
        className={cn(
          "size-3.5 shrink-0",
          selected ? "opacity-100" : "opacity-0",
        )}
      />
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * The classification picker. Renders a trigger (default: a subtle "Classify" button) that
 * opens a popover of the org's dimensions; toggling a value assigns/clears it on the
 * resource. Falls back to a management hint when the org has no dimensions yet.
 */
export function ClassificationPicker({
  kind,
  id,
  trigger,
  align = "start",
  initialAssignments,
}: {
  kind: ResourceKind;
  id: string;
  trigger?: ReactElement;
  align?: "start" | "center" | "end";
  initialAssignments?: AssignedValue[];
}) {
  const { org } = useParams<{ org: string }>();
  const dimensionsQuery = useDimensionsQuery();
  const assignmentsQuery = useAssignmentsQuery(kind, id, initialAssignments);
  const allDimensions = dimensionsQuery.data ?? [];
  // Only dimensions scoped to this resource kind (empty applies_to ⇒ all kinds).
  const dimensions = allDimensions.filter(
    (d) => d.appliesTo.length === 0 || d.appliesTo.includes(kind),
  );
  const { assign, unassign } = useAssignmentMutations(kind, id, dimensions);

  const selectedValueIds = new Set(
    (assignmentsQuery.data ?? []).map((a) => a.value_id),
  );

  /** Toggles a value: clears it if already set, else assigns (single-valued swaps). */
  function toggle(dimension: DimensionDTO, valueId: string) {
    if (selectedValueIds.has(valueId)) {
      unassign.mutate(valueId);
    } else {
      assign.mutate(valueId);
    }
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          trigger ?? (
            <Button variant="outline" size="sm" className="gap-1.5">
              <Tags className="size-3.5" />
              Classify
            </Button>
          )
        }
      />
      <PopoverContent align={align} className="w-64 p-0">
        <div className="max-h-80 overflow-y-auto">
          {dimensions.length === 0 ? (
            <div className="px-3 py-4">
              <p className="mb-2 text-sm text-muted-foreground">
                {allDimensions.length === 0
                  ? "No classification dimensions yet."
                  : "No dimensions apply to this resource."}
              </p>
              <Link
                href={`/${org}/~/settings/classification`}
                className="inline-flex items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline"
              >
                {allDimensions.length === 0
                  ? "Create dimensions"
                  : "Manage classification"}
                <ArrowRight className="size-3.5" />
              </Link>
            </div>
          ) : (
            dimensions.map((dimension) => (
              <div
                key={dimension.id}
                className="border-b border-border/60 py-1.5 last:border-b-0"
              >
                <div className="flex items-center justify-between px-2 pb-1">
                  <span className="text-xs font-medium text-foreground">
                    {dimension.label}
                  </span>
                  <Badge
                    variant="outline"
                    className="h-4 px-1 text-ui-2xs font-normal text-muted-foreground"
                  >
                    {dimension.multi ? "multi" : "single"}
                  </Badge>
                </div>
                {dimension.values.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    No values defined.
                  </p>
                ) : (
                  dimension.values.map((value) => (
                    <ValueRow
                      key={value.id}
                      label={value.label}
                      selected={selectedValueIds.has(value.id)}
                      onSelect={() => toggle(dimension, value.id)}
                    />
                  ))
                )}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
