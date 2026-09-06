// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The drawer's Report tab: verdict header, per-status counts, one card per control
// (severity, frameworks, findings by tofu address, honest coverage blind-spots), and
// the active waivers touching this environment (each linking to the sealing job).
// Renders a purposeful empty state when the environment has never been verified.

import Link from "next/link";
import { cn } from "@repo/ui/utils";
import type { EvidenceWaiver } from "@/lib/queries/evidence";
import type { VerifyControlResult, VerifyStatus } from "@/types/jsonb.types";
import type { EvidenceEnvRow } from "../evidence-derive";
import { EVIDENCE_HELP } from "../evidence-help";
import { EvIcon, type IconKey, TONE_TEXT } from "../evidence-status";
import { TabEmpty } from "./tab-empty";

/** Verdict → the header mark (icon + label + tone). */
const VERDICT_HEADER: Record<
	VerifyStatus,
	{ icon: IconKey; label: string; tone: "good" | "warn" | "bad" | "unknown" }
> = {
	pass: { icon: "shield-check", label: "Verified", tone: "good" },
	warn: { icon: "triangle-alert", label: "Warnings", tone: "warn" },
	fail: { icon: "shield-alert", label: "Failing", tone: "bad" },
	not_evaluable: {
		icon: "shield-question",
		label: "Not evaluable",
		tone: "unknown",
	},
};

const CONTROL_STATUS_ICON: Record<VerifyStatus, IconKey> = {
	pass: "shield-check",
	warn: "triangle-alert",
	fail: "shield-alert",
	not_evaluable: "shield-question",
};

const CONTROL_STATUS_TONE: Record<
	VerifyStatus,
	"good" | "warn" | "bad" | "unknown"
> = {
	pass: "good",
	warn: "warn",
	fail: "bad",
	not_evaluable: "unknown",
};

/** One control card: status + id/title, severity + provider chips, findings, coverage note. */
function ControlCard({ ctl }: { ctl: VerifyControlResult }) {
	const hasDetail =
		Boolean(ctl.frameworks?.length) ||
		Boolean(ctl.findings?.length) ||
		Boolean(ctl.coverage);
	return (
		<div className="overflow-hidden rounded-md border bg-surface">
			<div className="flex items-center gap-2.5 px-3 py-2.5">
				<EvIcon
					name={CONTROL_STATUS_ICON[ctl.status]}
					size={15}
					className={cn("shrink-0", TONE_TEXT[CONTROL_STATUS_TONE[ctl.status]])}
				/>
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<span className="font-mono text-ui-xs text-text-primary">{ctl.id}</span>
					<span className="truncate text-ui-sm text-text-secondary">
						{ctl.title}
					</span>
				</div>
				<span className="shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
					{ctl.severity}
				</span>
				<span className="shrink-0 font-mono text-ui-3xs text-text-disabled">
					{ctl.provider}
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
						<div
							key={`${f.address}-${i}`}
							className="border-l-2 border-border-strong pl-2.5"
						>
							<div className="font-mono text-ui-xs text-text-primary">
								{f.address}
							</div>
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

/** The Report tab body. */
export function ReportTab({
	org,
	row,
	waivers,
}: {
	org: string;
	row: EvidenceEnvRow;
	waivers: EvidenceWaiver[];
}) {
	const report = row.verify?.report ?? null;
	if (!report) {
		return (
			<TabEmpty
				icon="shield-question"
				title="No verification report yet"
				description="Evidence is generated when a plan runs against this environment — the verify gate evaluates every control over the plan and records the verdict here."
				docsHref={EVIDENCE_HELP.verify.docsHref}
				action={
					<Link
						href={row.projectSlug ? `/${org}/${row.projectSlug}` : `/${org}`}
						className="inline-flex items-center gap-1.5 border-b border-border-strong pb-0.5 text-ui-sm font-medium text-text-primary transition-colors hover:border-text-primary"
					>
						Open project
						<EvIcon name="arrow-right" size={12} />
					</Link>
				}
			/>
		);
	}

	const envWaivers = waivers.filter(
		(w) =>
			w.active &&
			w.projectName === row.projectName &&
			w.environmentName === row.environmentName,
	);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-3 rounded-md border bg-surface px-3.5 py-3">
				<span
					className={cn(
						"inline-flex items-center gap-2",
						TONE_TEXT[VERDICT_HEADER[report.verdict].tone],
					)}
				>
					<EvIcon name={VERDICT_HEADER[report.verdict].icon} size={17} />
					<span className="font-display text-ui-lg font-semibold text-text-primary">
						{VERDICT_HEADER[report.verdict].label}
					</span>
				</span>
				<span className="flex-1" />
				<span className="font-mono text-ui-2xs text-text-tertiary">
					{report.provider} · {report.catalog_version}
				</span>
			</div>
			<div className="font-mono text-ui-3xs uppercase tracking-[0.14em] text-text-disabled">
				Controls
			</div>
			<div className="flex flex-col gap-2.5">
				{report.controls.map((c) => (
					<ControlCard key={c.id} ctl={c} />
				))}
			</div>
			{envWaivers.length > 0 && (
				<>
					<div className="font-mono text-ui-3xs uppercase tracking-[0.14em] text-text-disabled">
						Active waivers touching this environment
					</div>
					<div className="flex flex-col gap-2">
						{envWaivers.map((w) => (
							<div
								key={w.jobId}
								className="flex flex-wrap items-baseline gap-2.5 rounded-md border border-dashed border-border-strong px-3 py-2.5"
							>
								<span className="flex flex-wrap gap-1">
									{w.controls.map((c) => (
										<span
											key={c}
											className="rounded-xs border bg-surface-sunken px-1.5 py-0.5 font-mono text-ui-2xs text-text-secondary"
										>
											{c}
										</span>
									))}
								</span>
								<span className="min-w-0 flex-1 text-ui-sm text-text-secondary">
									{w.reason}
									<span className="text-text-tertiary"> · {w.by}</span>
								</span>
								<Link
									href={`/${org}/~/jobs/${w.jobId}`}
									className="shrink-0 font-mono text-ui-2xs text-text-tertiary underline-offset-2 hover:text-text-primary hover:underline"
								>
									View job
								</Link>
							</div>
						))}
					</div>
				</>
			)}
		</div>
	);
}
