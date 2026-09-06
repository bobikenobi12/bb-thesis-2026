"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Guided "add / edit warm pool" flow — a right Sheet that walks Cloud → Placement → Capacity
// → Version → Review (mirrors the alert PolicyWizard shell). A warm pool has many knobs; the
// wizard groups them, defaults the advanced ones, validates per step (with cross-field rules),
// and shows a live capacity preview so the sizing reads in plain English. Persists via
// useFleetStore.createPool / updatePool.

import { Button } from "@repo/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/ui/collapsible";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { ProviderIcon, PROVIDER_LABELS } from "@repo/ui/provider-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@repo/ui/sheet";
import { cn } from "@repo/ui/utils";
import {
  FieldHelp,
  FieldLabel,
  RequiredMark,
} from "@/components/runners/field-help";
import { cloudProvider, type FleetPool } from "@/lib/db/schema";
import { useCreatePool, useUpdatePool } from "@/lib/query/use-fleet-query";
import type { FleetPoolCreateInput } from "@/lib/validations/fleet";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

// Form-level schema: locations are entered as a comma-separated string and the version source
// is an explicit toggle; both map to the server input on submit. Cross-field rules live in the
// superRefine so the wizard can surface them inline.
const formSchema = z
  .object({
    provider: z.enum(cloudProvider.enumValues),
    name: z.string().trim().max(60).optional(),
    locationsCsv: z.string().trim().min(1, "Add at least one location code."),
    warmMin: z.number({ error: "Required" }).int().min(0, "Can't be negative"),
    max: z.number({ error: "Required" }).int().min(1, "At least 1"),
    slotsPerRunner: z.number({ error: "Required" }).int().min(1, "At least 1"),
    minPerLocation: z
      .number({ error: "Required" })
      .int()
      .min(0, "Can't be negative"),
    surge: z.number({ error: "Required" }).int().min(1, "At least 1"),
    buffer: z.number({ error: "Required" }).int().min(0, "Can't be negative"),
    scaleDownGraceTicks: z
      .number({ error: "Required" })
      .int()
      .min(1, "At least 1"),
    versionSource: z.enum(["channel", "pin"]),
    channel: z.string().trim().optional(),
    version: z.string().trim().optional(),
  })
  .superRefine((v, ctx) => {
    const locs = v.locationsCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (locs.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["locationsCsv"],
        message: "Add at least one location code.",
      });
    }
    if (v.max < v.warmMin) {
      ctx.addIssue({
        code: "custom",
        path: ["max"],
        message: "Max must be ≥ the warm minimum.",
      });
    }
    if (v.buffer > v.max) {
      ctx.addIssue({
        code: "custom",
        path: ["buffer"],
        message: "Buffer can't exceed max.",
      });
    }
    if (v.versionSource === "pin" && !v.version?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["version"],
        message: "Enter a version to pin.",
      });
    }
    if (v.versionSource === "channel" && !v.channel?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["channel"],
        message: "Enter a channel name.",
      });
    }
  });
type FormValues = z.infer<typeof formSchema>;

const DEFAULTS: FormValues = {
  provider: "aws",
  name: "",
  locationsCsv: "fsn1, nbg1",
  warmMin: 1,
  max: 10,
  slotsPerRunner: 1,
  minPerLocation: 0,
  surge: 1,
  buffer: 1,
  scaleDownGraceTicks: 5,
  versionSource: "channel",
  channel: "stable",
  version: "",
};

/** Fields validated when advancing past each step. */
const STEP_FIELDS: (keyof FormValues)[][] = [
  ["provider", "name"],
  ["locationsCsv", "minPerLocation"],
  ["warmMin", "max", "buffer", "slotsPerRunner"],
  ["versionSource", "version", "channel"],
  [],
];

/** Map a stored pool row to form values (edit mode). */
function poolToForm(pool: FleetPool): FormValues {
  return {
    provider: pool.provider,
    name: pool.name ?? "",
    locationsCsv: pool.locations.join(", "),
    warmMin: pool.warm_min,
    max: pool.max,
    slotsPerRunner: pool.slots_per_runner,
    minPerLocation: pool.min_per_location,
    surge: pool.surge,
    buffer: pool.buffer,
    scaleDownGraceTicks: pool.scale_down_grace_ticks,
    versionSource: pool.version ? "pin" : "channel",
    channel: pool.channel ?? "stable",
    version: pool.version ?? "",
  };
}

/** Map validated form values to the server create/update input. */
function formToInput(v: FormValues): FleetPoolCreateInput {
  return {
    provider: v.provider,
    name: v.name?.trim() ? v.name.trim() : undefined,
    locations: v.locationsCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    warmMin: v.warmMin,
    max: v.max,
    slotsPerRunner: v.slotsPerRunner,
    minPerLocation: v.minPerLocation,
    surge: v.surge,
    buffer: v.buffer,
    scaleDownGraceTicks: v.scaleDownGraceTicks,
    version:
      v.versionSource === "pin" ? v.version?.trim() || undefined : undefined,
    channel:
      v.versionSource === "channel"
        ? v.channel?.trim() || undefined
        : undefined,
  };
}

const STEPS = ["Cloud", "Placement", "Capacity", "Version", "Review"] as const;
const MONO_LABEL =
  "font-mono text-ui-3xs uppercase tracking-[0.12em] text-muted-foreground";

interface FleetPoolWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null = create; a row = edit (provider is then fixed). */
  pool: FleetPool | null;
  /** Providers that already have a pool (disabled in the create select). */
  usedProviders: string[];
}

/** Create/edit a managed warm pool. Provider is immutable once created (one pool per cloud). */
export function FleetPoolWizard({
  open,
  onOpenChange,
  pool,
  usedProviders,
}: FleetPoolWizardProps) {
  const { mutateAsync: createPool } = useCreatePool();
  const { mutateAsync: updatePool } = useUpdatePool();
  const isEdit = pool !== null;
  const [step, setStep] = useState(0);
  const wasOpen = useRef(false);

  const {
    control,
    register,
    handleSubmit,
    reset,
    trigger,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: DEFAULTS,
    mode: "onChange",
  });

  // Reset to step 0 + (re)seed the form only on the closed→open transition.
  useEffect(() => {
    if (open && !wasOpen.current) {
      setStep(0);
      reset(pool ? poolToForm(pool) : DEFAULTS);
    }
    wasOpen.current = open;
  }, [open, pool, reset]);

  const values = watch();
  const allProvidersUsed =
    !isEdit && cloudProvider.enumValues.every((p) => usedProviders.includes(p));
  const providerLabel = PROVIDER_LABELS[values.provider] ?? values.provider;
  const locations = values.locationsCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const overcommit =
    locations.length > 0 &&
    values.minPerLocation * locations.length > values.max;

  const goNext = async () => {
    const ok = await trigger(STEP_FIELDS[step]);
    if (ok) setStep((s) => s + 1);
  };

  const onSubmit = async (v: FormValues) => {
    try {
      const input = formToInput(v);
      if (isEdit && pool) {
        await updatePool({ id: pool.id, input });
        toast.success("Pool updated");
      } else {
        await createPool(input);
        toast.success("Pool created");
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save pool");
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="border-b border-border">
          <SheetTitle>{isEdit ? "Edit pool" : "Add a warm pool"}</SheetTitle>
          <SheetDescription>
            A declarative pool of managed runners the controller keeps sized to
            demand.
          </SheetDescription>
          {/* step rail */}
          <ol className="mt-2 flex items-center gap-1.5">
            {STEPS.map((label, i) => (
              <li key={label} className="flex flex-1 items-center gap-1.5">
                <span
                  className={cn(
                    "flex h-5 w-5 flex-none items-center justify-center rounded-full font-mono text-ui-2xs",
                    i < step
                      ? "bg-foreground text-background"
                      : i === step
                        ? "border border-foreground text-foreground"
                        : "border border-border text-muted-foreground",
                  )}
                >
                  {i < step ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                <span
                  className={cn(
                    "truncate text-xs",
                    i === step
                      ? "font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {label}
                </span>
              </li>
            ))}
          </ol>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4">
          {/* 1 · Cloud */}
          {step === 0 && (
            <div className="space-y-4">
              {allProvidersUsed && (
                <Notice>
                  Every cloud already has a pool. Close this and edit an
                  existing pool instead.
                </Notice>
              )}
              <div className="space-y-1.5">
                <FieldLabel
                  required
                  help={{
                    title: "Cloud provider",
                    description:
                      "The cloud whose runners this pool manages. One pool per cloud; the provider can't change after creation.",
                  }}
                >
                  Cloud provider
                </FieldLabel>
                <Controller
                  control={control}
                  name="provider"
                  render={({ field }) => (
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={isEdit}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {cloudProvider.enumValues.map((p) => (
                          <SelectItem
                            key={p}
                            value={p}
                            disabled={!isEdit && usedProviders.includes(p)}
                          >
                            <span className="flex items-center gap-2">
                              <ProviderIcon provider={p} size={16} />
                              {PROVIDER_LABELS[p] ?? p}
                              {!isEdit && usedProviders.includes(p) && (
                                <span className="text-ui-2xs text-muted-foreground">
                                  · pooled
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div className="space-y-1.5">
                <FieldLabel>Display name (optional)</FieldLabel>
                <Input placeholder="e.g. AWS primary" {...register("name")} />
                <FieldError message={errors.name?.message} />
                <p className="text-ui-xs text-muted-foreground">
                  Shown on the pool card. Defaults to the provider name.
                </p>
              </div>
            </div>
          )}

          {/* 2 · Placement */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <FieldLabel
                  required
                  help={{
                    title: "Locations",
                    description:
                      "Region/datacenter codes the controller spreads runners across (e.g. Hetzner fsn1, nbg1). More locations = better resilience if one region degrades.",
                  }}
                >
                  Locations
                </FieldLabel>
                <Input placeholder="fsn1, nbg1" {...register("locationsCsv")} />
                <FieldError message={errors.locationsCsv?.message} />
                <p className="text-ui-xs text-muted-foreground">
                  Comma-separated region codes for {providerLabel}.
                </p>
                {locations.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {locations.map((l) => (
                      <span
                        key={l}
                        className="border border-border bg-muted px-2 py-0.5 font-mono text-ui-xs text-foreground"
                      >
                        {l}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <NumberField
                label="Minimum per location"
                hint="0 = no per-location floor."
                help={{
                  title: "Minimum per location",
                  description:
                    "Keep at least this many healthy runners in every location, so a single region can always serve work. Leave 0 unless you need guaranteed per-region capacity.",
                }}
                error={errors.minPerLocation?.message}
                {...register("minPerLocation", { valueAsNumber: true })}
              />
            </div>
          )}

          {/* 3 · Capacity */}
          {step === 2 && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3">
                <NumberField
                  label="Warm minimum"
                  required
                  hint="Always-on floor"
                  help={{
                    title: "Warm minimum",
                    description:
                      "Runners kept booted and ready at all times, even with zero queued jobs — they absorb the first burst with no cold-start wait.",
                  }}
                  error={errors.warmMin?.message}
                  {...register("warmMin", { valueAsNumber: true })}
                />
                <NumberField
                  label="Maximum"
                  required
                  hint="Hard ceiling"
                  help={{
                    title: "Maximum",
                    description:
                      "The most runners this pool will ever provision, no matter how deep the queue gets. Caps spend.",
                  }}
                  error={errors.max?.message}
                  {...register("max", { valueAsNumber: true })}
                />
                <NumberField
                  label="Idle buffer"
                  hint="Spare above demand"
                  help={{
                    title: "Idle buffer",
                    description:
                      "Extra idle runners kept above current demand (N+1 headroom) so a new job rarely waits for a boot. 0 = scale exactly to demand.",
                  }}
                  error={errors.buffer?.message}
                  {...register("buffer", { valueAsNumber: true })}
                />
                <NumberField
                  label="Slots / runner"
                  required
                  hint="Concurrent jobs each"
                  help={{
                    title: "Slots per runner",
                    description:
                      "How many jobs one runner executes at once. Higher packs more work per VM (cheaper) but shares CPU/memory across jobs.",
                  }}
                  error={errors.slotsPerRunner?.message}
                  {...register("slotsPerRunner", { valueAsNumber: true })}
                />
              </div>

              {overcommit && (
                <Notice tone="warning">
                  {values.minPerLocation} per location × {locations.length}{" "}
                  locations needs {values.minPerLocation * locations.length}{" "}
                  runners — above your max of {values.max}. Raise max or lower
                  the per-location floor.
                </Notice>
              )}

              <PoolCapacityPreview
                warmMin={values.warmMin}
                max={values.max}
                buffer={values.buffer}
                slots={values.slotsPerRunner}
              />

              <Collapsible>
                <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-left">
                  <span className="text-xs font-medium text-foreground">
                    Advanced scaling
                  </span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <div className="grid grid-cols-2 gap-3">
                    <NumberField
                      label="Rollout surge"
                      hint="Extra during a version roll"
                      help={{
                        title: "Rollout surge",
                        description:
                          "During a version rollout the controller may run this many runners above the ceiling so it can replace old ones without dropping capacity.",
                      }}
                      error={errors.surge?.message}
                      {...register("surge", { valueAsNumber: true })}
                    />
                    <NumberField
                      label="Scale-down grace"
                      hint="Idle ticks before reap"
                      help={{
                        title: "Scale-down grace",
                        description:
                          "Consecutive 60s ticks a runner must sit idle before it's removed. Higher avoids flapping when demand is spiky.",
                      }}
                      error={errors.scaleDownGraceTicks?.message}
                      {...register("scaleDownGraceTicks", {
                        valueAsNumber: true,
                      })}
                    />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}

          {/* 4 · Version */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <FieldLabel
                  help={{
                    title: "Version source",
                    description:
                      "Channel tracks a moving release stream and auto-updates as new runner versions ship. Pinned holds one exact version until you change it.",
                  }}
                >
                  Version source
                </FieldLabel>
                <Controller
                  control={control}
                  name="versionSource"
                  render={({ field }) => (
                    <div className="grid grid-cols-2 gap-2">
                      {(
                        [
                          {
                            value: "channel",
                            title: "Channel",
                            desc: "Auto-update to the channel's newest release.",
                          },
                          {
                            value: "pin",
                            title: "Pinned",
                            desc: "Hold an exact version until you change it.",
                          },
                        ] as const
                      ).map((opt) => {
                        const on = field.value === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => field.onChange(opt.value)}
                            className={cn(
                              "flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors",
                              on
                                ? "border-foreground/40 bg-muted"
                                : "border-border hover:bg-muted/40",
                            )}
                          >
                            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                              <span
                                className={cn(
                                  "flex h-4 w-4 items-center justify-center rounded-full border",
                                  on
                                    ? "border-foreground bg-foreground text-background"
                                    : "border-border",
                                )}
                              >
                                {on && <Check className="h-3 w-3" />}
                              </span>
                              {opt.title}
                            </span>
                            <span className="text-ui-xs leading-relaxed text-muted-foreground">
                              {opt.desc}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                />
              </div>
              {values.versionSource === "pin" ? (
                <div className="space-y-1.5">
                  <FieldLabel required>Pinned version</FieldLabel>
                  <Input placeholder="e.g. v1.4.2" {...register("version")} />
                  <FieldError message={errors.version?.message} />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <FieldLabel required>Channel</FieldLabel>
                  <Input placeholder="stable" {...register("channel")} />
                  <FieldError message={errors.channel?.message} />
                  <p className="text-ui-xs text-muted-foreground">
                    Usually <span className="font-mono">stable</span>.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* 5 · Review */}
          {step === 4 && (
            <dl className="divide-y divide-border rounded-lg border border-border text-sm">
              <ReviewRow label="Provider" value={providerLabel} />
              {values.name?.trim() && (
                <ReviewRow label="Name" value={values.name.trim()} />
              )}
              <ReviewRow
                label="Locations"
                value={locations.join(", ") || "—"}
              />
              <ReviewRow
                label="Capacity"
                value={`warm ${values.warmMin} · max ${values.max} · +${values.buffer} spare`}
              />
              <ReviewRow
                label="Slots / runner"
                value={String(values.slotsPerRunner)}
              />
              {values.minPerLocation > 0 && (
                <ReviewRow
                  label="Min / location"
                  value={String(values.minPerLocation)}
                />
              )}
              <ReviewRow label="Surge" value={String(values.surge)} />
              <ReviewRow
                label="Scale-down grace"
                value={`${values.scaleDownGraceTicks} ticks`}
              />
              <ReviewRow
                label="Version"
                value={
                  values.versionSource === "pin"
                    ? values.version?.trim() || "—"
                    : `${values.channel?.trim() || "stable"} (channel)`
                }
              />
            </dl>
          )}
        </div>

        <SheetFooter className="flex-row items-center justify-between border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || isSubmitting}
          >
            <ChevronLeft className="mr-1 h-4 w-4" /> Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button size="sm" onClick={goNext} disabled={allProvidersUsed}>
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleSubmit(onSubmit)}
              disabled={isSubmitting}
            >
              {isSubmitting
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Create pool"}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** A labelled number input with a hint, optional help popover, and an inline error. */
function NumberField({
  label,
  hint,
  help,
  error,
  required,
  ...props
}: React.ComponentProps<"input"> & {
  label: string;
  hint: string;
  help?: { title: string; description: string };
  error?: string;
  required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs">
          {label}
          {required && <RequiredMark />}
        </Label>
        {help && (
          <FieldHelp title={help.title} description={help.description} />
        )}
      </div>
      <Input type="number" min={0} aria-invalid={!!error} {...props} />
      {error ? (
        <FieldError message={error} />
      ) : (
        <p className="text-ui-2xs leading-tight text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Inline field error message. */
function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-ui-xs text-destructive">{message}</p>;
}

/** A small inline notice block (informational by default, or a warning). */
function Notice({
  children,
  tone = "info",
}: {
  children: React.ReactNode;
  tone?: "info" | "warning";
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed",
        tone === "warning"
          ? "border-dashed border-foreground/30 bg-muted text-foreground"
          : "border-dashed border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {tone === "warning" && (
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      )}
      <span>{children}</span>
    </div>
  );
}

/** Live, plain-English read on what the capacity numbers mean, with a small grayscale meter:
 *  solid = always-warm floor, hatched = idle spare, outline = headroom up to the ceiling. */
function PoolCapacityPreview({
  warmMin,
  max,
  buffer,
  slots,
}: {
  warmMin: number;
  max: number;
  buffer: number;
  slots: number;
}) {
  const safeMax = Math.max(1, Number.isFinite(max) ? max : 1);
  const warm = Math.max(
    0,
    Math.min(Number.isFinite(warmMin) ? warmMin : 0, safeMax),
  );
  const spare = Math.max(
    0,
    Math.min(Number.isFinite(buffer) ? buffer : 0, safeMax - warm),
  );
  const slotCount = Math.max(1, Number.isFinite(slots) ? slots : 1);
  const cells = Math.min(safeMax, 16);

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
      <span className={MONO_LABEL}>What this means</span>
      <div className="flex gap-[3px]">
        {Array.from({ length: cells }, (_, i) => {
          const kind =
            i < warm ? "warm" : i < warm + spare ? "spare" : "ceiling";
          return (
            <span
              key={i}
              className={cn(
                "h-2.5 flex-1",
                kind === "warm" && "border border-foreground bg-foreground",
                kind === "spare" && "border border-foreground",
                kind === "ceiling" && "border border-dashed border-border",
              )}
              style={
                kind === "spare"
                  ? {
                      backgroundImage:
                        "repeating-linear-gradient(45deg, transparent 0 2px, var(--foreground) 2px 3px)",
                    }
                  : undefined
              }
            />
          );
        })}
      </div>
      <p className="text-xs leading-relaxed text-foreground">
        Keeps <strong>{warm}</strong> runner{warm !== 1 ? "s" : ""} warm, scales
        to demand{" "}
        {spare > 0 ? (
          <>
            plus <strong>{spare}</strong> idle spare
          </>
        ) : (
          "with no spare"
        )}
        , never past <strong>{safeMax}</strong>. Each runner takes{" "}
        <strong>{slotCount}</strong> job
        {slotCount !== 1 ? "s" : ""} at once
        {slotCount > 1 ? ` (up to ${safeMax * slotCount} concurrent jobs)` : ""}
        .
      </p>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-2.5">
      <dt className="font-mono text-ui-2xs uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="max-w-[60%] text-right text-ui-md">{value}</dd>
    </div>
  );
}
