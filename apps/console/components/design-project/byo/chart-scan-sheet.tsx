"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The chart-safety scan sheet — surfaces the elench verify.Report over a bring-your-own Helm
// chart's rendered manifests (privileged pods, host access, missing limits, wildcard RBAC …) so a
// user sees what a chart would introduce before trusting it. Deliberately mirrors the Evidence
// Drawer (verdict header + per-status summary pills + per-control cards with findings + honest
// coverage), reusing the shared grayscale tone system — one security-report language across the
// product. Scan runs as a CHART_SCAN job; this reads the persisted report off the chart.

import { Loader2, RotateCw, ShieldCheck } from "lucide-react";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { Sheet, SheetContent } from "@repo/ui/sheet";
import { cn } from "@repo/ui/utils";
import { EvIcon, type IconKey, TONE_TEXT } from "@/components/evidence/evidence-status";
import type { Tone } from "@/components/evidence/evidence-derive";
import type {
	VerifyControlResult,
	VerifyReport,
	VerifyStatus,
} from "@/types/jsonb.types";

const STATUS_ICON: Record<VerifyStatus, IconKey> = {
	pass: "shield-check",
	warn: "triangle-alert",
	fail: "shield-alert",
	not_evaluable: "shield-question",
};

const STATUS_TONE: Record<VerifyStatus, Tone> = {
	pass: "good",
	warn: "warn",
	fail: "bad",
	not_evaluable: "unknown",
};

/** The verdict banner: icon + headline, toned so a `fail` draws the eye. */
const VERDICT: Record<VerifyStatus, { icon: IconKey; label: string; tone: Tone }> = {
	pass: { icon: "shield-check", label: "No issues found", tone: "good" },
	warn: { icon: "triangle-alert", label: "Warnings — review before deploying", tone: "warn" },
	fail: { icon: "shield-alert", label: "Issues found — review before deploying", tone: "bad" },
	not_evaluable: { icon: "shield-question", label: "Not evaluable", tone: "unknown" },
};

/** Worst-first ordering so the risky controls sit at the top. */
const STATUS_ORDER: Record<VerifyStatus, number> = {
	fail: 0,
	warn: 1,
	not_evaluable: 2,
	pass: 3,
};
const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** One control card — status mark + id/title, severity + provider chips, findings, coverage note
 * (mirrors the Evidence Drawer's ControlCard). */
function ControlCard({ ctl }: { ctl: VerifyControlResult }) {
	const hasDetail = Boolean(ctl.findings?.length) || Boolean(ctl.coverage) || Boolean(ctl.frameworks?.length);
	return (
		<div className="overflow-hidden rounded-md border bg-surface">
			<div className="flex items-center gap-2.5 px-3 py-2.5">
				<EvIcon
					name={STATUS_ICON[ctl.status]}
					size={15}
					className={cn("shrink-0", TONE_TEXT[STATUS_TONE[ctl.status]])}
				/>
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<span className="font-mono text-ui-xs text-text-primary">{ctl.id}</span>
					<span className="truncate text-ui-sm text-text-secondary">{ctl.title}</span>
				</div>
				<span className="shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
					{ctl.severity}
				</span>
			</div>
			{hasDetail && (
				<div className="flex flex-col gap-2.5 px-3 pb-3">
					{ctl.frameworks?.length ? (
						<div className="flex flex-wrap gap-1">
							{ctl.frameworks.map((fw) => (
								<span
									key={fw}
									className="rounded-xs bg-surface-sunken px-1.5 py-0.5 font-mono text-ui-3xs text-text-tertiary"
								>
									{fw}
								</span>
							))}
						</div>
					) : null}
					{(ctl.findings ?? []).map((f, i) => (
						<div key={`${f.address}-${i}`} className="border-l-2 border-border-strong pl-2.5">
							<div className="font-mono text-ui-xs text-text-primary">{f.address}</div>
							<div className="mt-0.5 text-ui-xs leading-relaxed text-text-tertiary">
								{f.message}
							</div>
						</div>
					))}
					{ctl.coverage && (
						<div className="flex gap-2.5 rounded-sm border border-dashed border-border-strong bg-surface-sunken px-2.5 py-2">
							<span className="shrink-0 pt-px font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
								Blind spot
							</span>
							<span className="text-ui-xs leading-relaxed text-text-secondary">
								{ctl.coverage}
							</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** A single per-status count pill in the summary row. */
function SummaryPill({ label, count, tone }: { label: string; count: number; tone: Tone }) {
	return (
		<div className="flex items-baseline gap-1.5 rounded-md border bg-surface px-2.5 py-1.5">
			<span className={cn("font-mono text-ui-md tabular-nums", TONE_TEXT[tone])}>{count}</span>
			<span className="text-ui-2xs uppercase tracking-wide text-text-tertiary">{label}</span>
		</div>
	);
}

export interface ChartScanSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	chartId: string;
	repoUrl: string;
	chartPath: string;
	chartRef: string;
	scanStatus: string;
	report: VerifyReport | null;
	scanning: boolean;
	/** Kick off (or re-run) the scan. */
	onRescan: () => void;
}

/** The scan sheet: header (chart coords) → verdict + summary + control cards, or a scanning /
 * unscanned / failed empty state. */
export function ChartScanSheet({
	open,
	onOpenChange,
	chartId,
	repoUrl,
	chartPath,
	chartRef,
	scanStatus,
	report,
	scanning,
	onRescan,
}: ChartScanSheetProps) {
	const controls = report
		? [...report.controls].sort(
				(a, b) =>
					STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
					(SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3),
			)
		: [];
	const verdict = report ? VERDICT[report.verdict] : null;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="w-[min(560px,96vw)] gap-0 border-border-strong bg-surface-raised p-0 sm:max-w-none"
			>
				{/* Header — chart identity */}
				<div className="border-b border-border-faint px-5 py-4">
					<div className="flex items-center gap-2">
						<ShieldCheck className="size-4 text-text-tertiary" />
						<span className="font-mono text-ui-2xs uppercase tracking-[0.16em] text-text-tertiary">
							Chart safety scan
						</span>
					</div>
					<div className="mt-2 text-ui-lg font-semibold text-text-primary">{chartId}</div>
					<div className="mt-1 font-mono text-ui-xs text-text-tertiary">
						{repoUrl.replace(/^https?:\/\/(www\.)?/, "")} · /{chartPath.replace(/^\/+/, "")} · {chartRef}
					</div>
				</div>

				<div className="flex-1 overflow-y-auto px-5 py-4">
					{scanning || scanStatus === "scanning" ? (
						<EmptyState
							className="px-0 py-16 md:px-0 md:py-16"
							icon={<Loader2 className="animate-spin" />}
							title="Running security checks…"
							description="Rendering the chart and evaluating it for privileged access, host mounts, missing resource limits, and over-broad RBAC."
						/>
					) : report && verdict ? (
						<div className="flex flex-col gap-4">
							{/* Verdict + rescan */}
							<div className="flex items-center gap-2.5">
								<EvIcon
									name={verdict.icon}
									size={17}
									className={cn("shrink-0", TONE_TEXT[verdict.tone])}
								/>
								<span className={cn("text-ui-md font-medium", TONE_TEXT[verdict.tone])}>
									{verdict.label}
								</span>
								<Button
									variant="ghost"
									size="sm"
									className="ml-auto h-7 gap-1.5 px-2 text-ui-xs"
									onClick={onRescan}
								>
									<RotateCw className="size-3" /> Rescan
								</Button>
							</div>

							{/* Per-status summary */}
							<div className="flex flex-wrap gap-2">
								<SummaryPill label="fail" count={report.summary.fail} tone="bad" />
								<SummaryPill label="warn" count={report.summary.warn} tone="warn" />
								<SummaryPill label="pass" count={report.summary.pass} tone="good" />
								<SummaryPill
									label="not evaluable"
									count={report.summary.not_evaluable}
									tone="unknown"
								/>
							</div>

							{/* Controls, worst-first */}
							<div className="flex flex-col gap-2">
								{controls.map((c) => (
									<ControlCard key={c.id} ctl={c} />
								))}
							</div>

							<p className="pt-1 text-ui-xs leading-relaxed text-text-tertiary">
								Advisory — findings are surfaced, not enforced, while charts are trusted-only. They
								become a hard admission gate when untrusted charts open up.
							</p>
						</div>
					) : (
						/* Unscanned / failed empty state */
						<EmptyState
							className="px-0 py-16 md:px-0 md:py-16"
							icon={
								<EvIcon
									name={scanStatus === "failed" ? "triangle-alert" : "shield-question"}
									className={scanStatus === "failed" ? TONE_TEXT.bad : TONE_TEXT.muted}
								/>
							}
							title={
								scanStatus === "failed"
									? "The last scan failed"
									: "This chart hasn't been scanned yet"
							}
							action={
								<Button size="sm" className="gap-1.5" onClick={onRescan}>
									<ShieldCheck className="size-3.5" />
									{scanStatus === "failed" ? "Retry scan" : "Scan chart"}
								</Button>
							}
						/>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
