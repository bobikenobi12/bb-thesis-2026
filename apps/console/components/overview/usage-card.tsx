"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview Usage card — the org's real consumption this period. Plan-capped resources
// (runner minutes, concurrent jobs, AI credits) render as gauges vs their plan allowance;
// projects and seats are uncapped on paid plans, so they show as plain counts rather than
// misleading full rings. The header CTA is plan-aware: "Upgrade" only on the free plan, a
// plan pill + "Manage" on paid, and nothing at all when billing isn't hosted (self-managed).

import { useEffect, useState } from "react";
import Link from "next/link";
import { Info, Zap } from "lucide-react";
import { formatMinutes } from "@repo/format";
import { planMeta } from "@repo/plan-catalog";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/tooltip";
import {
  getAiUsageSummary,
  getBillingSummary,
  getOrgUsage,
} from "@/app/server/actions/billing";
import {
  sessionResetLabel,
  weeklyResetLabel,
} from "@/lib/billing/ai-usage-format";
import { globalHref } from "@/lib/routing";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";
import {
  NEAR_LIMIT_RATIO,
  formatUsagePercent,
  usageRatio,
} from "./usage-percent";
import { UsageRing } from "./usage-ring";

/** A gauge row: a metered resource with a real plan allowance. */
interface GaugeRow {
  label: string;
  used: number;
  limit: number;
  unit: string;
  tip: string;
  /**
   * Overrides the right-side readout for rows whose raw counts are the wrong thing to print —
   * AI rows show a reset time rather than credits, and runner minutes show a humanised
   * duration rather than the unrounded float the meter actually holds.
   */
  readout?: string;
}

/** Lowercase a reset label's first word so it fits the mono readout style. */
function asReadout(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/** A plain count stat (uncapped on paid plans, so no gauge). */
interface CountRow {
  label: string;
  value: number;
  tip: string;
}

/** Everything the card renders, resolved from the three usage actions. */
interface UsageData {
  hosted: boolean;
  plan: "community" | "team" | "enterprise";
  gauges: GaugeRow[];
  counts: CountRow[];
}

/** Usage card. `projectCount` is the live project total rolled up from the projects store. */
export function UsageCard({
  orgSlug,
  projectCount,
}: {
  orgSlug: string;
  projectCount: number;
}) {
  const [data, setData] = useState<UsageData | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([getOrgUsage(), getBillingSummary(), getAiUsageSummary()])
      .then(([usage, billing, ai]) => {
        if (!alive) return;
        const gauges: GaugeRow[] = [
          {
            label: "Runner minutes",
            used: usage.usedMinutes,
            limit: usage.includedMinutes,
            unit: "min",
            tip: "Managed-runner compute minutes consumed this billing period.",
            // `usedMinutes` is an unrounded float straight out of `extract(epoch from …) / 60.0`,
            // so the default `toLocaleString()` readout printed "0.943 / 200 min" (#2876).
            // The ALLOWANCE stays a plain minute count: it is the number the plan and the
            // pricing page quote, and "3h 20m" would no longer be recognisable as "200 minutes".
            readout: `${formatMinutes(usage.usedMinutes)} / ${usage.includedMinutes.toLocaleString()} min`,
          },
        ];
        // Concurrent jobs is only a gauge when the plan caps it (Enterprise is unlimited).
        if (usage.maxConcurrentJobs !== null) {
          gauges.push({
            label: "Concurrent jobs",
            used: usage.runningJobs,
            limit: usage.maxConcurrentJobs,
            unit: "",
            tip: "Provisioning jobs running at once vs your plan's concurrency limit.",
          });
        }
        if (ai.enabled) {
          // AI is a standalone metered product — show the rolling session + the weekly
          // limit as PERCENTAGES (the ring + "% used"), with the reset time as the
          // readout (never raw credits).
          gauges.push({
            label: "AI · current session",
            used: ai.sessionUsed,
            limit: ai.sessionBudget,
            unit: "",
            tip: "Included AI usage in the trailing 5-hour window vs your plan's session allowance.",
            readout: asReadout(sessionResetLabel(ai.sessionResetAt)),
          });
          gauges.push({
            label: "AI · weekly limit",
            used: ai.weeklyUsed,
            limit: ai.weeklyBudget,
            unit: "",
            tip: "Included AI usage this week vs your plan's fixed weekly allowance.",
            readout: asReadout(weeklyResetLabel(ai.weeklyResetAt)),
          });
        }

        const counts: CountRow[] = [
          {
            label: "Projects",
            value: projectCount,
            tip: "Infrastructure configurations in this organization.",
          },
          {
            label: "Seats",
            value: billing.memberCount,
            tip: "Members occupying a seat in this organization.",
          },
        ];

        setData({ hosted: billing.hosted, plan: billing.plan, gauges, counts });
      })
      .catch(() => {
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, [projectCount]);

  return (
    <div className="rounded-lg border bg-surface shadow-sm">
      <div className="flex min-h-[50px] items-center gap-2 border-b px-4 py-2.5">
        <span className="font-display text-sm font-semibold text-text-primary">
          Usage
        </span>
        <span className="font-mono text-ui-2xs text-text-tertiary">
          Last 30 days
        </span>
        {data && <UsageHeaderCta orgSlug={orgSlug} data={data} />}
      </div>

      <div className="px-4">
        {data === null ? (
          <div className="space-y-3 py-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : (
          <>
            {data.gauges.map((g) => (
              <UsageMeter key={g.label} row={g} />
            ))}
            {data.counts.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 border-t py-3">
                {data.counts.map((c) => (
                  <CountReadout key={c.label} row={c} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Plan-aware header CTA: Upgrade (free), plan pill + Manage (paid), nothing (self-managed). */
/** Free-plan header CTA — opens the in-place Pro upgrade sheet (not a route to billing). */
function UpgradeCta() {
  const { openUpgrade } = useUpgradeSheet();
  return (
    <Button
      variant="outline"
      size="xs"
      className="ml-auto gap-1.5 text-xs"
      onClick={openUpgrade}
    >
      <Zap className="h-3 w-3" />
      Upgrade
    </Button>
  );
}

function UsageHeaderCta({
  orgSlug,
  data,
}: {
  orgSlug: string;
  data: UsageData;
}) {
  if (!data.hosted) return null;
  const billingHref = globalHref(orgSlug, "settings/billing");

  if (data.plan === "community") {
    return <UpgradeCta />;
  }

  return (
    <div className="ml-auto flex items-center gap-2">
      <span className="rounded-full border px-2 py-0.5 font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
        {planMeta(data.plan).name}
      </span>
      <Link
        href={billingHref}
        className="font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
      >
        Manage →
      </Link>
    </div>
  );
}

/** One gauge row: ring + label (with info tooltip) + used/limit readout. */
function UsageMeter({ row }: { row: GaugeRow }) {
  // Percent and near-limit both come from the shared helpers the ring uses, so the caption,
  // the arc and the ink weight cannot disagree about the same pair of numbers.
  const near = usageRatio(row.used, row.limit) >= NEAR_LIMIT_RATIO;
  return (
    <div className="flex items-center gap-3 border-b border-border/60 py-2.5 last:border-b-0">
      <UsageRing used={row.used} limit={row.limit} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-ui-md text-text-primary">
          {row.label}
          <MetricTip tip={row.tip} />
        </div>
        <div className="mt-0.5 font-mono text-ui-2xs text-text-tertiary">
          {formatUsagePercent(row.used, row.limit)}% used
        </div>
      </div>
      <div
        className={`font-mono text-xs ${near ? "font-semibold text-text-primary" : "text-text-tertiary"}`}
      >
        {row.readout ??
          `${row.used.toLocaleString()} / ${row.limit.toLocaleString()}${row.unit ? ` ${row.unit}` : ""}`}
      </div>
    </div>
  );
}

/** A count readout — a label + mono value inline (uncapped on paid plans, so no gauge
 * and no KPI tile: counts live as mono text, not a bordered stat box). */
function CountReadout({ row }: { row: CountRow }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="flex items-center gap-1 text-ui-sm text-text-secondary">
        {row.label}
        <MetricTip tip={row.tip} />
      </span>
      <span className="font-mono text-ui-md tabular-nums text-text-primary">
        {row.value.toLocaleString()}
      </span>
    </div>
  );
}

/** The shared info-tooltip glyph next to a metric label. */
function MetricTip({ tip }: { tip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex cursor-default text-text-tertiary hover:text-text-secondary">
            <Info className="h-3 w-3" />
          </span>
        }
      />
      <TooltipContent side="top" className="max-w-[200px] text-xs">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}
