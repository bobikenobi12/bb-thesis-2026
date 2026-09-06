"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A section machine for Sheet-based editors: an auto-closing accordion where each section
// validates its own fields before advancing, shows a live summary line while collapsed, and a
// status dot (empty / invalid / complete). Opening one section closes the rest (Radix single +
// controlled value). Reads react-hook-form via context, so the parent wraps it in <FormProvider>;
// a child needs its own useFormState() subscription to re-render on error changes, so this must
// stay a child of the form owner (not receive `form` as a prop). Consumed by the role editor and
// the SSO provider editor.

import { asRecord } from "@/lib/records";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import {
  type FieldPath,
  type FieldValues,
  useFormContext,
  useFormState,
} from "react-hook-form";
import {
  Accordion,
  AccordionContent,
  AccordionHeader,
  AccordionItem,
  AccordionTrigger,
} from "@repo/ui/accordion";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";

/** Per-section completion state — drives the status dot and the auto-advance target. */
export type SectionStatus = "empty" | "invalid" | "complete";

export interface FormSectionDef<T extends FieldValues> {
  /** Stable id — the Accordion item value. */
  id: string;
  /** Mono eyebrow, e.g. "Identity" / "Permissions". */
  title: string;
  /** One-line hint, shown only while the section is open. */
  hint?: string;
  /** The fields `trigger()` validates before this section may advance. */
  fields: FieldPath<T>[];
  /** Collapsed summary, rendered from live watched values. Falsy → "Not set". */
  summary: (v: T) => ReactNode;
  /**
   * Completeness beyond zod validity — e.g. "at least one permission". Defaults to
   * "every field in `fields` is non-empty".
   */
  complete?: (v: T) => boolean;
  /** The section body. Sub-editors stay dumb: value / onChange / editable. */
  body: (v: T) => ReactNode;
  /** Terminal sections (Review) render no Continue button. */
  terminal?: boolean;
  /** Hide the section entirely (e.g. Classification in create mode). */
  hidden?: (v: T) => boolean;
}

export interface AccordionFormProps<T extends FieldValues> {
  sections: FormSectionDef<T>[];
  /** Controlled open section; "" = all closed. Lifted so the parent can force-open a section. */
  open: string;
  onOpenChange: (id: string) => void;
  /** Fired when the last section advances (every section complete). */
  onComplete?: () => void;
}

/** Reads a dotted path ("saml.entryPoint") out of a nested object, tolerating gaps. */
function at(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return asRecord(acc)[key];
  }, obj);
}

/** A field counts as filled when it's a non-empty string / non-empty array / any set value. */
function nonEmpty(x: unknown): boolean {
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === "string") return x.trim().length > 0;
  return x !== undefined && x !== null;
}

/**
 * The accordion section machine. `T` is the react-hook-form values type; every section
 * reads its slice from the live watched values, validates its own `fields` on Continue, and
 * hands off to the next incomplete section (auto-closing itself). Grayscale, token-driven.
 */
export function AccordionForm<T extends FieldValues>({
  sections,
  open,
  onOpenChange,
  onComplete,
}: AccordionFormProps<T>) {
  const form = useFormContext<T>();
  // A child-local formState subscription — required so error changes re-render THIS component
  // (reading form.formState from a prop would only re-render the useForm owner).
  const { errors } = useFormState<T>();
  const v = form.watch();

  const visible = sections.filter((s) => !s.hidden?.(v));

  /** empty (nothing entered) · invalid (a field has an error) · complete. */
  function statusOf(s: FormSectionDef<T>): SectionStatus {
    if (s.fields.some((f) => at(errors, f))) return "invalid";
    const done = s.complete
      ? s.complete(v)
      : s.fields.length > 0 && s.fields.every((f) => nonEmpty(at(v, f)));
    return done ? "complete" : "empty";
  }

  /** Validate section `i`; on pass, open the immediately-following section (linear). */
  async function advance(i: number) {
    const s = visible[i];
    if (s.fields.length > 0) {
      const ok = await form.trigger(s.fields, { shouldFocus: true });
      if (!ok) return; // stay open — RHF paints the messages
    }
    // Linear advance: open the next section (a terminal Review opens last). When this is
    // the last section, the form is done — fire onComplete and close all. Submit lives in
    // the sheet footer (always available), never on onComplete, so a terminal Review with
    // no Continue button doesn't strand the form.
    const next = visible[i + 1];
    if (next) onOpenChange(next.id);
    else {
      onOpenChange("");
      onComplete?.();
    }
  }

  return (
    <Accordion
      multiple={false}
      value={open ? [open] : []}
      onValueChange={(val) =>
        onOpenChange(typeof val[0] === "string" ? val[0] : "")
      }
      className="space-y-2.5"
    >
      {visible.map((s, i) => {
        const status = statusOf(s);
        const line = s.summary(v);
        return (
          <AccordionItem
            key={s.id}
            value={s.id}
            className="overflow-hidden rounded-lg border border-border"
          >
            <AccordionHeader>
              <AccordionTrigger className="group flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-muted">
                <StatusDot status={status} />
                <span className="font-mono text-ui-2xs uppercase tracking-wider text-foreground/70">
                  {s.title}
                </span>
                <span className="ml-auto min-w-0 truncate font-mono text-ui-2xs text-text-tertiary group-data-[panel-open]:hidden">
                  {line || "Not set"}
                </span>
                <ChevronRight
                  size={14}
                  className="shrink-0 text-text-tertiary transition-transform group-data-[panel-open]:rotate-90"
                />
              </AccordionTrigger>
            </AccordionHeader>
            <AccordionContent>
              <div className="space-y-4 border-t border-border p-3">
                {s.hint && (
                  <p className="text-ui-xs text-text-tertiary">{s.hint}</p>
                )}
                {s.body(v)}
                {!s.terminal && (
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void advance(i)}
                    >
                      Continue
                    </Button>
                  </div>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}

/** Grayscale state dot: hollow (empty) · destructive-ringed (invalid) · filled (complete). */
function StatusDot({ status }: { status: SectionStatus }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "complete" && "bg-text-primary",
        status === "invalid" && "bg-text-primary ring-2 ring-destructive/40",
        status === "empty" && "border border-border-strong",
      )}
    />
  );
}
