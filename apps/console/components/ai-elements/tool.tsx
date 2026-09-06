"use client";

import { Badge } from "@repo/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/ui/collapsible";
import { cn } from "@repo/ui/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, useId } from "react";

import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose w-full rounded-none border", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

export const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

// Grayscale per the Alethia design system — status is shape/label, never hue.
const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-muted-foreground" />,
  "approval-responded": (
    <CheckCircleIcon className="size-4 text-muted-foreground" />
  ),
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-foreground" />,
  "output-denied": <XCircleIcon className="size-4 text-muted-foreground" />,
  "output-error": <XCircleIcon className="size-4 text-foreground" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1.5 rounded-none text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-4 p-3",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2">
        <WrenchIcon className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">{title ?? derivedName}</span>
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[closed]:fade-out-0 data-[closed]:slide-out-to-top-2 data-[open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[closed]:animate-out data-[open]:animate-in",
      className,
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

/**
 * A tool call's arguments, under the console's eyebrow label.
 *
 * The label was a raw `<h4>`, which CLAUDE.md §6 routes to `PageHeader level={n}`. It is NOT one,
 * for two reasons that point the same way. A transcript renders this part once per tool call, so a
 * forty-turn conversation emitted forty `<h4>`s under no `<h3>` — a phantom rung per tool call,
 * inside a `role="log"`; `@repo/ui/empty`'s `EmptyTitle` defaults to a `<div>` over exactly this
 * hazard. And `PageHeader` fixes its type at `text-lg` on purpose ("the visual size does NOT change
 * with the level"), which is a page title's size above an 11px JSON block in a chat bubble.
 *
 * So it becomes what the rest of the agent surface already calls this shape — the `vx-eyebrow`
 * token, the same one `artifact-panel`'s `Section` and `build-pane`'s "Workloads" use — and the
 * region it labels is tied to it by `aria-labelledby`, which the orphan heading never did.
 */
export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const labelId = useId();
  return (
    <div
      aria-labelledby={labelId}
      className={cn("space-y-2 overflow-hidden", className)}
      role="group"
      {...props}
    >
      <div className="vx-eyebrow" id={labelId}>
        Parameters
      </div>
      <div className="rounded-md bg-muted/50">
        <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
      </div>
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  // Before the early return: a hook cannot sit behind one.
  const labelId = useId();

  if (!(output || errorText)) {
    return null;
  }

  let Output = (
    <div>
      {isValidElement(output) ||
      typeof output === "string" ||
      typeof output === "number" ||
      typeof output === "boolean"
        ? output
        : null}
    </div>
  );

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div
      aria-labelledby={labelId}
      className={cn("space-y-2", className)}
      role="group"
      {...props}
    >
      <div className="vx-eyebrow" id={labelId}>
        {errorText ? "Error" : "Result"}
      </div>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground",
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
