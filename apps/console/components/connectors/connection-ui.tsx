"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { FieldHelp } from "@repo/ui/field-help";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { Separator } from "@repo/ui/separator";
import { cn } from "@repo/ui/utils";
import {
  CheckCircle2,
  HelpCircle,
  KeyRound,
  Loader2,
  Lock,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  ConnTestPhase,
  ConnTestState,
  VerifyStatus,
} from "./use-connection-test";

// Design system: grayscale, hairline borders, no shadowed cards, no colored status fills.
// Status is a dot/icon + label, never hue. Mirrors components/connectors/connector-detail-sheet.tsx.

type CalloutVariant = "success" | "pending" | "error";

const VARIANT_ICON: Record<CalloutVariant, ReactNode> = {
  success: <CheckCircle2 className="size-4 shrink-0 text-foreground" />,
  pending: (
    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
  ),
  error: <XCircle className="mt-0.5 size-4 shrink-0 text-foreground" />,
};

/**
 * The status banner shown while saving / after a verification attempt. Hairline row,
 * grayscale — the state reads from the icon + title, not a colored fill. Shared across
 * every provider connection component so the states look identical everywhere.
 */
export function StatusCallout({
  variant,
  title,
  children,
}: {
  variant: CalloutVariant;
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex gap-3 rounded-md border border-border/60 bg-muted/20 p-3.5",
        variant === "error" ? "items-start" : "items-center",
      )}
    >
      {VARIANT_ICON[variant]}
      <div className="min-w-0">
        <p className="font-medium text-foreground text-sm">{title}</p>
        <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
          {children}
        </p>
      </div>
    </div>
  );
}

/**
 * Renders the in-progress / done states of an instant server-side connection verify (driven by
 * `useConnectionTest`): `saving` (the single save+verify round trip, with a Cancel so the flow can
 * never get stuck) and `success` — which distinguishes a fully CONNECTED account from a DEGRADED one
 * (authenticated, but missing some provisioning permissions). The caller handles `idle`/`failed` by
 * showing its credential form.
 */
export function ConnectionTestStatus({
  phase,
  successText,
  verifyingText,
  onCancel,
  status,
  missingPermissions,
}: {
  phase: ConnTestPhase;
  successText: string;
  verifyingText: string;
  onCancel: () => void;
  status?: VerifyStatus;
  missingPermissions?: string[];
}) {
  if (phase === "success") {
    if (status === "degraded") {
      const missing = missingPermissions?.length
        ? ` (${missingPermissions.join(", ")})`
        : "";
      return (
        <StatusCallout
          variant="pending"
          title="Connected — limited permissions"
        >
          {successText} Some provisioning permissions look missing{missing} —
          provisioning may fail until the role is widened.
        </StatusCallout>
      );
    }
    return (
      <StatusCallout variant="success" title="Connection verified">
        {successText}
      </StatusCallout>
    );
  }

  return (
    <div className="space-y-3">
      <StatusCallout variant="pending" title="Verifying connection…">
        {verifyingText}
      </StatusCallout>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 border-border/60 text-xs"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The muted "how your credentials are handled" footnote. Shared. */
export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <p className="text-ui-xs text-muted-foreground leading-relaxed">
      {children}
    </p>
  );
}

/**
 * The "How this works" popover — a quiet labelled trigger that opens a plain-language explanation of
 * the keyless trust model. Reassures a non-expert user before they touch their cloud console.
 */
function HowItWorks({ children }: { children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 text-ui-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <HelpCircle className="size-3.5" />
            How this works
          </button>
        }
      />
      <PopoverContent side="bottom" align="end" className="w-80 p-3.5">
        <p className="mb-1.5 font-medium text-foreground text-xs">
          How this works
        </p>
        <div className="space-y-1.5 text-muted-foreground text-xs leading-relaxed">
          {children}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The shared connect-sheet frame. The Sheet header (ConnectSheetHeader) already carries the provider
 * name + icon, so this renders only a lead-in — a keyless/encrypted badge, the one-line intro, and a
 * quiet "How this works" — a hairline rule, then the provider-specific body. No card, no shadow: flat
 * hairline sections in the grayscale system. Self-contained so it also works in the create-project flow.
 */
export function ConnectSheetShell({
  title,
  intro,
  howItWorks,
  badgeLabel = "Keyless",
  children,
}: {
  /** Retained for API compatibility; the Sheet header shows the title, so it's not repeated here. */
  title?: string;
  intro: ReactNode;
  howItWorks: ReactNode;
  /** The reassurance pill — "Keyless" for the federated clouds, "Encrypted" for token clouds. */
  badgeLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <Badge
            variant="secondary"
            className="h-5 gap-1 px-1.5 font-medium text-ui-2xs"
          >
            <ShieldCheck className="size-3" />
            {badgeLabel}
          </Badge>
          <HowItWorks>{howItWorks}</HowItWorks>
        </div>
        <p className="text-foreground/80 text-sm leading-relaxed">{intro}</p>
      </div>
      <Separator />
      {children}
    </div>
  );
}

/** One method choice in {@link MethodTabs}. */
export interface MethodTab {
  id: string;
  label: string;
  sub: string;
  icon: ReactNode;
}

/**
 * The setup-method selector (e.g. CloudFormation vs Terraform) — a compact segmented control with a
 * "?" popover explaining how to choose. Replaces the two oversized bordered cards.
 */
export function MethodTabs({
  tabs,
  value,
  onChange,
  help,
  label = "Choose a setup method",
}: {
  tabs: MethodTab[];
  value: string;
  onChange: (id: string) => void;
  help?: ReactNode;
  label?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="font-semibold text-ui-xs text-muted-foreground uppercase tracking-wider">
          {label}
        </span>
        {help && <FieldHelp title={label}>{help}</FieldHelp>}
      </div>
      <div className="inline-flex rounded-md border border-border/60 p-0.5">
        {tabs.map((t) => {
          const active = value === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              className={cn(
                "flex items-center gap-1.5 rounded px-3 py-1.5 font-medium text-xs transition-colors",
                active
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.icon}
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A numbered setup step. Flat hairline chip + title + body. Shared across every connect sheet. */
export function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex gap-3.5">
      <div className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border/60 font-medium text-ui-xs text-muted-foreground">
        {n}
      </div>
      <div className="min-w-0 flex-1 space-y-2.5 pt-0.5">
        <div className="font-medium text-foreground text-sm">{title}</div>
        {children}
      </div>
    </div>
  );
}

/**
 * The verify section + form. While the instant server-side verify is in flight it shows the shared
 * verifying/success status (with Cancel); on idle/failure it shows the provider-specific form
 * (`children`). A hairline rule separates it from the steps above.
 */
export function VerifySection({
  state,
  successText,
  verifyingText,
  onCancel,
  children,
}: {
  state: ConnTestState;
  successText: string;
  verifyingText: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  const inFlight = state.phase === "success" || state.phase === "saving";
  return (
    <div className="space-y-4 border-border/60 border-t pt-6">
      {inFlight ? (
        <ConnectionTestStatus
          phase={state.phase}
          status={state.status}
          missingPermissions={state.missingPermissions}
          successText={successText}
          verifyingText={verifyingText}
          onCancel={onCancel}
        />
      ) : (
        <>
          {state.phase === "failed" && (
            <StatusCallout variant="error" title="Verification failed">
              {state.error}
            </StatusCallout>
          )}
          {children}
        </>
      )}
    </div>
  );
}

/**
 * The reassurance footer: exactly what Alethia keeps, and how to cut access. One subtle inset so the
 * "we store almost nothing" promise reads consistently.
 */
export function StoredNote({
  stored,
  revoke,
}: {
  stored: ReactNode;
  revoke: ReactNode;
}) {
  return (
    <div className="grid gap-2 rounded-md border border-border/40 bg-muted/20 p-3 text-ui-xs text-muted-foreground">
      <div className="flex items-start gap-2">
        <Lock className="mt-0.5 size-3.5 shrink-0" />
        <p className="leading-relaxed">
          <span className="font-medium text-foreground">
            What&apos;s stored:{" "}
          </span>
          {stored}
        </p>
      </div>
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 size-3.5 shrink-0" />
        <p className="leading-relaxed">
          <span className="font-medium text-foreground">Revoke anytime: </span>
          {revoke}
        </p>
      </div>
    </div>
  );
}
