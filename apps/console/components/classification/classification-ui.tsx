"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Small shared bits for the classification surface: an info hint (icon + tooltip that explains
// the *why*) and a spinner for pending buttons.

import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";
import { Info, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

/** An unobtrusive info icon that reveals an explanation on hover/focus. */
export function InfoHint({
  children,
  size = 13,
  className,
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            tabIndex={-1}
            aria-label="More information"
            className={cn(
              "inline-grid place-items-center text-text-tertiary transition-colors hover:text-text-secondary",
              className,
            )}
          >
            <Info style={{ width: size, height: size }} />
          </button>
        }
      />
      <TooltipContent className="max-w-[240px] text-ui-sm leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

/** A spinning loader for in-flight buttons. */
export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <Loader2 className="animate-spin" style={{ width: size, height: size }} />
  );
}
