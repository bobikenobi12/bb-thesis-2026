"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One environment card — identity + drift/deploy badges, classification chips, the "gates into this
// env" protection summary, and a right rail (auto-heal + duplicate + delete). Presentational; the
// mutations are handled by the orchestrator.

import { formatMonthlyRate, formatRelative } from "@repo/format";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { Switch } from "@repo/ui/switch";
import { Check, Copy, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { EnvReconcileState } from "@/app/server/actions/reconcile";
import type { ProtectionSummary } from "@/app/server/actions/protection";
import { ClassificationControl } from "@/components/classification/classification-control";
import type { AssignedValue } from "@/lib/queries/classification";
import { envHref } from "@/lib/routing";
import type { EnvRow } from "./environments-view";
import { StatusDot } from "./env-ui";

/**
 * Gates a classification value tagged on this env forces onto promotions into it (the label drives
 * policy) — flattened to `{ label, source }` chips shown alongside the env's own rules.
 */
function inheritedGateChips(assignments: AssignedValue[] | undefined) {
	const out: { label: string; source: string }[] = [];
	for (const a of assignments ?? []) {
		const e = a.enforcement;
		if (!e) continue;
		if (e.require_approval)
			out.push({
				label: e.min_approvals > 1 ? `Approval ×${e.min_approvals}` : "Approval",
				source: a.value_label,
			});
		if (e.require_verify_pass) out.push({ label: "Verify", source: a.value_label });
	}
	return out;
}

/** The protection rules → gate chips (on = enforced, off = not required). */
function gateChips(p: ProtectionSummary | undefined) {
	if (!p) return [];
	return [
		{ label: "Predecessor", on: p.require_predecessor },
		{ label: "Verify", on: p.require_verify_pass },
		{
			label: p.require_approval && p.min_count ? `Approval ×${p.min_count}` : "Approval",
			on: p.require_approval,
		},
		{ label: p.soak_minutes != null ? `Soak ${p.soak_minutes}m` : "Soak", on: p.soak_minutes != null },
		{
			label:
				p.cost_delta_threshold != null
					? `Cost ${formatMonthlyRate(p.cost_delta_threshold, "exact")}`
					: "Cost",
			on: p.cost_delta_threshold != null,
		},
	];
}

export function EnvironmentCard({
	env,
	org,
	project,
	reconcile,
	protection,
	classAssignments,
	canEdit,
	onEditRules,
	onToggleHeal,
	onDuplicate,
	onDelete,
}: {
	env: EnvRow;
	org: string;
	project: string;
	reconcile: EnvReconcileState | undefined;
	protection: ProtectionSummary | undefined;
	classAssignments: AssignedValue[] | undefined;
	canEdit: boolean;
	onEditRules: () => void;
	onToggleHeal: (enabled: boolean) => void;
	onDuplicate: () => void;
	onDelete: () => void;
}) {
	const drifted = reconcile?.driftInSync === false;
	const deployPending = Boolean(reconcile?.deployPending);
	const isProd = env.stage === "production";
	const chips = gateChips(protection);
	const hasRules = chips.some((c) => c.on);
	const inherited = inheritedGateChips(classAssignments);

	return (
		<div className="grid grid-cols-1 gap-4 rounded-lg border bg-surface p-4 shadow-sm sm:grid-cols-[1fr_auto]">
			<div className="min-w-0">
				{/* identity */}
				<div className="flex flex-wrap items-center gap-2.5">
					<Link
						href={envHref(org, project, env.id)}
						className="font-mono text-ui-lg text-text-primary hover:underline"
					>
						{env.name}
					</Link>
					<StatusDot
						tier={deployPending ? "live" : "active"}
						label={deployPending ? "Deploying" : "Live"}
						className="text-ui-xs"
					/>
					{env.is_default && (
						<span className="shrink-0 rounded-full border px-1.5 py-px font-mono text-ui-3xs uppercase tracking-wide text-text-tertiary">
							Default
						</span>
					)}
					{drifted && (
						<Badge variant="secondary" className="gap-1.5 text-ui-2xs">
							<TriangleAlert className="size-3" />
							Drifted
						</Badge>
					)}
				</div>

				{/* meta */}
				<div className="mt-1.5 flex items-center gap-2 text-ui-sm text-text-tertiary">
					{drifted ? (
						<span>Diverged from provisioned state</span>
					) : (
						<span className="inline-flex items-center gap-1.5">
							<Check className="size-3" />
							In sync
						</span>
					)}
					<span className="opacity-50">·</span>
					<span>Updated {formatRelative(env.updated_at)}</span>
				</div>

				{/* classification chips + picker */}
				<ClassificationControl
					kind="project_environment"
					id={env.id}
					canEdit={canEdit}
					initialAssignments={classAssignments}
					className="mt-2.5"
				/>

				{/* protection summary */}
				<div className="mt-3 border-t border-border-faint pt-3">
					<div className="mb-2 flex items-center gap-2">
						<span className="font-mono text-ui-2xs uppercase tracking-[0.14em] text-text-tertiary">
							Gates into this env
						</span>
						{canEdit && (
							<button
								type="button"
								onClick={onEditRules}
								className="ml-auto text-ui-sm text-text-secondary underline underline-offset-2 hover:text-text-primary"
							>
								Edit rules
							</button>
						)}
					</div>
					{hasRules && (
						<div className="flex flex-wrap gap-1.5">
							{chips.map((c) =>
								c.on ? (
									<span
										key={c.label}
										className="inline-flex items-center gap-1.5 rounded-[5px] border border-border-strong bg-surface-muted px-2 py-0.5 font-mono text-ui-xs text-text-primary"
									>
										<span className="size-[5px] rounded-full bg-[var(--signal-strong)]" />
										{c.label}
									</span>
								) : (
									<span
										key={c.label}
										className="rounded-[5px] border border-dashed border-border px-2 py-0.5 font-mono text-ui-xs text-text-disabled"
									>
										{c.label}
									</span>
								),
							)}
						</div>
					)}

					{/* Gates inherited from a classification value tagged on this env (label drives policy). */}
					{inherited.length > 0 && (
						<div className={hasRules ? "mt-2" : undefined}>
							<div className="mb-1.5 text-ui-2xs text-text-tertiary">
								Inherited from classification
							</div>
							<div className="flex flex-wrap gap-1.5">
								{inherited.map((c) => (
									<span
										key={`${c.label}-${c.source}`}
										className="inline-flex items-center gap-1.5 rounded-[5px] border border-dashed border-border-strong bg-surface-muted px-2 py-0.5 font-mono text-ui-xs text-text-primary"
										title={`Required because this env is classified ${c.source}`}
									>
										<span className="size-[5px] rounded-full bg-[var(--signal-strong)]" />
										{c.label}
										<span className="text-text-tertiary">· {c.source}</span>
									</span>
								))}
							</div>
						</div>
					)}

					{!hasRules && inherited.length === 0 && (
						<span className="text-ui-sm italic text-text-tertiary">
							No protection — any editor can promote in.
						</span>
					)}
				</div>
			</div>

			{/* right rail */}
			<div className="flex min-w-[148px] flex-col items-end justify-between gap-3 border-t border-border-faint pt-3 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
				<div className="w-full">
					<div className="mb-1.5 font-mono text-ui-2xs uppercase tracking-[0.12em] text-text-tertiary">
						Auto-heal
					</div>
					{canEdit ? (
						<Switch
							checked={reconcile?.autoHeal ?? false}
							onCheckedChange={onToggleHeal}
							aria-label={`Toggle auto-heal for ${env.name}`}
						/>
					) : (
						<span className="font-mono text-ui-sm text-text-secondary">
							{reconcile?.autoHeal ? "On" : "Off"}
						</span>
					)}
					{isProd && (
						<div className="mt-1.5 text-ui-2xs leading-tight text-text-tertiary">
							Gated for production
						</div>
					)}
				</div>
				{canEdit && (
					<div className="flex gap-1">
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-8 text-text-tertiary hover:text-text-primary"
							title="Duplicate"
							onClick={onDuplicate}
						>
							<Copy className="size-4" />
						</Button>
						{!env.is_default && (
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-8 text-text-tertiary hover:text-destructive"
								title="Delete"
								onClick={onDelete}
							>
								<Trash2 className="size-4" />
							</Button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
