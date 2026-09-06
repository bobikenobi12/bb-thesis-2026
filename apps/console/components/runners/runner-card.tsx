"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One runner as a card (replaces the former dense table row). Grayscale: status reads
// through a StatusBadge dot + mono label, never hue.

import { lookup } from "@/lib/typed-object";
import { Card } from "@repo/ui/card";
import { ProviderIcon, PROVIDER_LABELS, type Provider } from "@repo/ui/provider-icon";
import { StatusBadge } from "@repo/ui/status-badge";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import { JOB_TYPES } from "@/components/jobs/columns";
import { ClassificationControl } from "@/components/classification/classification-control";
import type { AssignedValue } from "@/lib/queries/classification";
import {
	RunnerActions,
	RunnerVersion,
	runnerBusyKind,
	type RunnerRow,
} from "@/components/runners/runner-actions";
import { formatRelative } from "@repo/format";
import { Cloud, Server, Star } from "lucide-react";
import Link from "next/link";

const MONO_LABEL = "font-mono text-ui-3xs uppercase tracking-[0.12em] text-muted-foreground";

/** Human label for a runner's operator + provisioning mode. */
function operatorLabel(runner: RunnerRow): string {
	if (runner.operator === "managed") return "Managed";
	return runner.provisioning === "deployed" ? "Self · Deployed" : "Self · Registered";
}

/** The StatusBadge status for a runner, lifting in-flight lifecycle jobs to their own state. */
function displayStatus(runner: RunnerRow): string {
	const busy = runnerBusyKind(runner);
	if (busy === "DEPLOY_RUNNER") return "PROVISIONING";
	if (busy === "UPDATE_RUNNER") return "UPDATING";
	if (busy === "DESTROY_RUNNER") return "DESTROYING";
	return runner.status ?? "OFFLINE";
}

/** A single labelled fact in the card body. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<span className={MONO_LABEL}>{label}</span>
			<span className="min-w-0 truncate text-xs text-foreground">{children}</span>
		</div>
	);
}

export function RunnerCard({
	runner,
	initialAssignments,
}: {
	runner: RunnerRow;
	initialAssignments?: AssignedValue[];
}) {
	const isManaged = runner.operator === "managed";
	const OperatorIcon = isManaged ? Cloud : Server;
	const providers = runner.supported_providers ?? [];
	const job = runner.activeJob;
	const jobInfo = job ? JOB_TYPES[job.job_type] : null;
	const JobIcon = jobInfo?.icon;
	const instanceId = isManaged ? runner.metadata?.cloud_instance_id : null;

	return (
		<Card className="gap-0 overflow-hidden py-0">
			{/* header */}
			<div className="flex items-start gap-2.5 border-b border-border p-4">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<span className="truncate text-sm font-semibold tracking-tight text-foreground">{runner.name}</span>
						{runner.is_default && <Star className="h-3 w-3 shrink-0 fill-foreground text-foreground" />}
					</div>
					<div className="mt-1 flex min-w-0 items-center gap-1.5">
						<StatusBadge status={displayStatus(runner)} className="text-ui-2xs" />
						{instanceId && (
							<span className="truncate font-mono text-ui-2xs text-muted-foreground">· {instanceId}</span>
						)}
					</div>
				</div>
				<span className="inline-flex shrink-0 items-center gap-1 border border-border bg-muted px-1.5 py-0.5 font-mono text-ui-3xs uppercase tracking-[0.08em] text-muted-foreground">
					<OperatorIcon className="h-3 w-3" />
					{operatorLabel(runner)}
				</span>
			</div>

			{/* body */}
			<div className="grid grid-cols-2 gap-x-4 gap-y-3 p-4">
				<Fact label="Cloud">
					{providers.length ? (
						<span className="flex items-center gap-1.5">
							{providers.slice(0, 4).map((p) => (
								<ProviderIcon key={p} provider={p} size={14} />
							))}
							<span className="truncate text-muted-foreground">
								{providers.length === 1
									? (lookup(PROVIDER_LABELS, providers[0]) ?? providers[0])
									: `${providers.length} clouds`}
							</span>
						</span>
					) : (
						<span className="text-muted-foreground">Any</span>
					)}
				</Fact>
				<Fact label="Region">
					<span className="font-mono text-muted-foreground">
						{(isManaged ? runner.location : null) ?? "—"}
					</span>
				</Fact>
				<Fact label="Version">
					<RunnerVersion runner={runner} />
				</Fact>
				<Fact label={isManaged ? "Provisioned" : "Last seen"}>
					<span className="text-muted-foreground">
						{isManaged
							? `${(runner.provisioned_hours ?? 0).toFixed(1)} h`
							: runner.last_heartbeat
								? formatRelative(runner.last_heartbeat)
								: "Never"}
					</span>
				</Fact>
			</div>

			{/* active job */}
			{job && jobInfo && (
				<Link
					href={`/dashboard/jobs/${job.id}`}
					className="flex items-center gap-1.5 border-t border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					{JobIcon && <JobIcon className="h-3 w-3 shrink-0" />}
					<span className="font-medium">{jobInfo.label}</span>
					{job.projects?.project_name && <span className="truncate">· {job.projects.project_name}</span>}
				</Link>
			)}

			{/* actions */}
			<div className={cn("flex items-center justify-between gap-2 border-t border-border px-3 py-2", job && jobInfo && "border-t-0")}>
				{/* Classification (Workstream B) — chips + a picker for org editors. */}
				<ClassificationControl
					kind="runner"
					id={runner.id}
					canEdit
					initialAssignments={initialAssignments}
					compact
				/>
				<RunnerActions runner={runner} />
			</div>
		</Card>
	);
}

/** Loading placeholder matching the runner card silhouette. */
export function RunnerCardSkeleton() {
	return (
		<Card className="gap-0 py-0">
			<div className="flex items-center gap-2.5 border-b border-border p-4">
				<Skeleton className="size-2.5 rounded-full" />
				<div className="flex-1 space-y-1.5">
					<Skeleton className="h-3.5 w-28" />
					<Skeleton className="h-2.5 w-16" />
				</div>
				<Skeleton className="h-5 w-20" />
			</div>
			<div className="grid grid-cols-2 gap-3 p-4">
				{[1, 2, 3, 4].map((i) => (
					<Skeleton key={i} className="h-7 w-full" />
				))}
			</div>
		</Card>
	);
}
