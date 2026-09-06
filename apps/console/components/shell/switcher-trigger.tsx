"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronsUpDown } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@repo/ui/button";
import { PopoverTrigger } from "@repo/ui/popover";
import { cn } from "@repo/ui/utils";

/** Where the trigger renders — `sidebar` (full-width org row) or `topbar` (compact quick-switcher). */
type SwitcherTriggerVariant = "sidebar" | "topbar";

type SwitcherTriggerProps = {
  /** Layout/sizing preset for the trigger row. */
  variant: SwitcherTriggerVariant;
  /** Popover open state — drives `aria-expanded`. */
  open: boolean;
  /** Leading visual: an `OrgAvatar` (sidebar) or a boxed lucide icon (topbar). Optional —
   * omit for a bare label (the topbar project switcher). */
  leading?: ReactNode;
  /** Two-line caption shown above the label on the topbar variant ("Project" | "Env"). */
  caption?: string;
  /** The current selection name. */
  label: string;
  /** Trailing badge (e.g. the org plan pill) — sidebar only. */
  badge?: ReactNode;
  /** When set, the body becomes a `<Link href>` (navigates) and only the chevron opens the
   * popover — i.e. a split button. When absent, the whole row opens the popover. */
  href?: string;
  /** What the trigger switches, e.g. "Switch organization" / "Switch project". In split mode it
   * names the chevron button; on a whole-row trigger it is prefixed to the current selection —
   * "Switch project: All projects". Required in both modes: a switcher whose only name is its
   * selection is a control nobody can identify by ear. */
  ariaLabel: string;
};

/**
 * The shared trigger row for every shell switcher (org / project / env). Renders a consistent
 * leading visual + label (optionally a two-line caption) + a single `ChevronsUpDown` open icon, so
 * all switchers look and behave identically. Pass `href` to make it a split button: the body links
 * to `href` and only the chevron toggles the popover (the org picker); omit it and the whole row
 * toggles the popover (the topbar project/env switchers). Must render inside a `<Popover>`.
 */
export function SwitcherTrigger({
  variant,
  open,
  leading,
  caption,
  label,
  badge,
  href,
  ariaLabel,
}: SwitcherTriggerProps) {
  const labelBlock = caption ? (
    <span className="flex min-w-0 flex-col items-start leading-tight">
      <span className="font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground/70">
        {caption}
      </span>
      <span className="max-w-[10rem] truncate text-ui-md font-medium text-foreground">
        {label}
      </span>
    </span>
  ) : (
    <span className="min-w-0 flex-1 truncate text-left text-ui-md font-medium">
      {label}
    </span>
  );

  const chevron = (
    <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
  );

  // `role="combobox"` used to sit on both triggers (the shadcn popover-picker idiom). It was
  // wrong twice over, and the second way was a CRITICAL axe failure on all 40 private routes:
  //  · these are not comboboxes — there is no text input and no owned listbox; base-ui already
  //    reports the truth as `aria-haspopup="dialog"`;
  //  · `combobox` takes its name FROM THE AUTHOR ONLY, so the role silently deleted the visible
  //    label from the accessible name. The topbar project switcher (every `/{org}/…` route) and
  //    the env switcher (every project route) were therefore buttons with no discernible text —
  //    the whole of the audit's `button-name` finding (#3731).
  // The split (org) trigger escaped only because its chevron already carried an `aria-label`.
  // The role is gone from both; `aria-expanded` stays, which is valid on a button that pops up a
  // dialog. Each trigger is then named explicitly below rather than left to name-from-content —
  // the reason is at the whole-row branch.

  // Split button (org): the body navigates, only the chevron opens the popover.
  if (href) {
    return (
      <div className="flex w-full items-center gap-1">
        <Button
          variant="ghost"
          className="h-auto min-w-0 flex-1 justify-start gap-2.5 px-2.5 py-2"
          nativeButton={false}
          render={<Link href={href} />}
        >
          {leading}
          {labelBlock}
          {badge}
        </Button>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-expanded={open}
              aria-label={ariaLabel}
              className="shrink-0"
            >
              {chevron}
            </Button>
          }
        />
      </div>
    );
  }

  // Whole-row trigger (project / env): clicking anywhere opens the popover.
  return (
    <PopoverTrigger
      render={
        <Button
          variant="ghost"
          aria-expanded={open}
          // Named explicitly rather than from content, for two reasons. The visible label is only
          // the CURRENT SELECTION — "All projects", "production" — which never says what the
          // control does; and it can be empty, which would leave the button unnamed again. An
          // `sr-only` prefix does not work here: accessible-name computation trims each node and
          // joins inline descendants with no separator, so it is announced as one run-on word.
          // The visible text stays part of the name, so WCAG 2.5.3 (label in name) holds.
          aria-label={label ? `${ariaLabel}: ${label}` : ariaLabel}
          className={cn(
            "h-auto",
            variant === "sidebar"
              ? "w-full justify-start gap-2.5 px-2.5 py-2"
              : "gap-2 px-2 py-1.5",
          )}
        >
          {leading}
          {labelBlock}
          {badge}
          {chevron}
        </Button>
      }
    />
  );
}
