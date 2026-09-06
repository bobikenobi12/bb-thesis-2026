"use client";

import { Button } from "@repo/ui/button";
import { ScrollArea } from "@repo/ui/scroll-area";
import { cn } from "@repo/ui/utils";
import type { ComponentProps } from "react";
import { useCallback } from "react";

export type SuggestionsProps = ComponentProps<typeof ScrollArea>;

/**
 * A horizontally scrolling strip of suggestion chips.
 *
 * `py-1` is the CLAMP'S REACH, not spacing for looks. Every `@repo/ui/button` carries `.vx-clamp`
 * (`packages/brand/src/tokens.css`), whose corner marks are a `::before` drawn at
 * `inset: calc(-1 * var(--cl-gap))` — 4px OUTSIDE the control's box, so a button never reflows when
 * it clamps. A scroll container measures that decoration as content, and this viewport is
 * `overflow: scroll` on BOTH axes (base-ui's ScrollArea sets it inline; `orientation="horizontal"`
 * only chooses which scrollbar is rendered). So the 4px below the last chip made the strip a second
 * vertical scroll container — measured at 36/32 at 768, 1280, 1440 and 1920, R3's only FAIL on this
 * route (#3885). Nothing is down there to scroll to; and the 4px above was clipped and unreachable,
 * so the chips' upper corner marks never drew at all.
 *
 * Reserving `--cl-gap` on the BLOCK axis settles both: the viewport stops overflowing vertically, and
 * the marks fit inside it. The inline axis is deliberately left alone — this strip is a horizontal
 * scroller by design, and its inline edges are supposed to move.
 */
export const Suggestions = ({
  className,
  children,
  ...props
}: SuggestionsProps) => (
  <ScrollArea
    className="w-full whitespace-nowrap"
    orientation="horizontal"
    {...props}
  >
    <div
      className={cn("flex w-max flex-nowrap items-center gap-2 py-1", className)}
    >
      {children}
    </div>
  </ScrollArea>
);

export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  variant = "outline",
  size = "sm",
  children,
  ...props
}: SuggestionProps) => {
  const handleClick = useCallback(() => {
    onClick?.(suggestion);
  }, [onClick, suggestion]);

  return (
    <Button
      className={cn("cursor-pointer rounded-none px-4", className)}
      onClick={handleClick}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      {children || suggestion}
    </Button>
  );
};
