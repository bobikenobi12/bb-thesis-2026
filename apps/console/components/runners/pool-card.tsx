"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { lookup } from "@/lib/typed-object";
import type { FleetPoolView, PoolEconomics } from "@/app/server/actions/fleet";
import { formatMoney } from "@repo/format";
import { ProviderIcon, PROVIDER_LABELS, type Provider } from "@repo/ui/provider-icon";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@repo/ui/alert-dialog";
import { Card } from "@repo/ui/card";
import { EmptyState } from "@repo/ui/empty";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";
import { MoreVertical, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { useState } from "react";

/** Management callbacks; when `canManage` and these are provided the card shows its menu. */
export interface PoolCardActions {
	canManage?: boolean;
	onEdit?: () => void;
	onToggle?: () => void;
	onDelete?: () => void;
}

const MONO_LABEL = "font-mono text-ui-3xs uppercase tracking-[0.12em] text-muted-foreground";

/** One capacity slot: filled (online), hatched (online+busy), or dashed (missing vs target). */
function CapacitySegment({ kind }: { kind: "on" | "busy" | "miss" }) {
	if (kind === "miss") {
		return <span className="h-2.5 flex-1 border border-dashed border-border" />;
	}
	return (
		<span
			className="h-2.5 flex-1 border border-foreground bg-foreground"
			style={
				kind === "busy"
					? {
							backgroundImage:
								"repeating-linear-gradient(45deg, transparent 0 2px, var(--background) 2px 3px)",
						}
					: undefined
			}
		/>
	);
}

/** A mono pill for a version or location tally (×N), dashed when flagged (old / down). */
function Tally({ tally, strike }: { tally: { key: string; count: number; flagged: boolean }; strike?: boolean }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 border bg-muted px-2 py-0.5 font-mono text-ui-2xs text-foreground",
				tally.flagged ? "border-dashed text-muted-foreground" : "border-border",
				tally.flagged && strike && "line-through decoration-border",
			)}
		>
			{tally.key}
			<span className="text-muted-foreground">×{tally.count}</span>
		</span>
	);
}

/** Pool card: provider header, warm-capacity meter, rollout, version + location
 *  distribution, and (for owner/admin) an edit/pause/delete menu. Grayscale — status
 *  reads through a dot fill + label, never hue. */
export function PoolCard({ pool, economics, canManage, onEdit, onToggle, onDelete }: { pool: FleetPoolView; economics?: PoolEconomics } & PoolCardActions) {
	const label = pool.name?.trim() ? pool.name : (lookup(PROVIDER_LABELS, pool.provider) ?? pool.provider);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const segments: ("on" | "busy" | "miss")[] = Array.from({ length: pool.target }, (_, i) => {
		if (i >= pool.online) return "miss";
		return i < pool.busyOnline ? "busy" : "on";
	});

	const noteBits: string[] = [];
	if (pool.belowFloor) noteBits.push(`${pool.target - pool.online} below floor`);
	noteBits.push(`${pool.busy} busy`);
	if (pool.draining) noteBits.push(`${pool.draining} draining`);

	const liveTotal = pool.versions.reduce((sum, v) => sum + v.count, 0);
	const showMenu = canManage && (onEdit || onToggle || onDelete);

	return (
		<Card className={cn("gap-0 overflow-hidden py-0", pool.degraded && "shadow-md", !pool.enabled && "opacity-60")}>
			{/* header */}
			<div className="flex items-start gap-3 border-b border-border p-4">
				<div className="flex size-9 shrink-0 items-center justify-center border border-border bg-muted">
					<ProviderIcon provider={pool.provider} size={20} />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span className="truncate text-sm font-semibold tracking-tight text-foreground">{label}</span>
						{!pool.enabled && (
							<span className="shrink-0 border border-border bg-muted px-1.5 font-mono text-ui-3xs uppercase tracking-[0.1em] text-muted-foreground">
								Paused
							</span>
						)}
					</div>
					<div className={cn(MONO_LABEL, "mt-0.5 truncate")}>{pool.locations.join(" · ") || "—"}</div>
				</div>
				<div className="flex shrink-0 items-center gap-1.5 pt-0.5">
					<span
						className={cn(
							"size-2 rounded-full",
							pool.degraded ? "bg-foreground ring-2 ring-inset ring-background" : "bg-foreground",
						)}
					/>
					<span className={cn("font-mono text-ui-3xs uppercase tracking-[0.1em]", pool.degraded ? "text-foreground" : "text-muted-foreground")}>
						{pool.degraded ? "Degraded" : "Healthy"}
					</span>
					{showMenu && (
						<DropdownMenu>
							<DropdownMenuTrigger className="-mr-1 ml-0.5 flex size-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground">
								<MoreVertical className="size-4" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								{onEdit && (
									<DropdownMenuItem onClick={onEdit}>
										<Pencil className="size-3.5" /> Edit
									</DropdownMenuItem>
								)}
								{onToggle && (
									<DropdownMenuItem onClick={onToggle}>
										{pool.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
										{pool.enabled ? "Pause" : "Resume"}
									</DropdownMenuItem>
								)}
								{onDelete && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
											<Trash2 className="size-3.5" /> Delete
										</DropdownMenuItem>
									</>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</div>

			{onDelete && (
				<AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Delete the {label} pool?</AlertDialogTitle>
							<AlertDialogDescription>
								The controller will drain and reap this pool&rsquo;s runners on the next tick. This cannot be undone.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
								onClick={() => {
									setConfirmDelete(false);
									onDelete();
								}}
							>
								Delete
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}

			{/* body */}
			<div className="flex flex-col gap-4 p-4">
				{/* capacity */}
				<div className="flex flex-col gap-2">
					<div className="flex items-baseline justify-between gap-2">
						<span className={MONO_LABEL}>Warm capacity</span>
						<span className="flex items-baseline gap-1">
							<span className="text-lg font-semibold tracking-tight text-foreground tabular-nums">{pool.online}</span>
							<span className="font-mono text-xs text-muted-foreground">/ {pool.target} target</span>
						</span>
					</div>
					<div className="flex gap-[3px]">
						{segments.map((kind, i) => (
							<CapacitySegment key={i} kind={kind} />
						))}
					</div>
					<div className="font-mono text-ui-2xs text-muted-foreground">{noteBits.join("  ·  ")}</div>
				</div>

				{/* rollout */}
				<div className="flex flex-col gap-2">
					<div className="flex items-baseline justify-between gap-2">
						<span className={MONO_LABEL}>
							{pool.targetVersion ? `Rollout → ${pool.targetVersion}` : "Rollout"}
						</span>
						<span className="font-mono text-ui-xs text-muted-foreground tabular-nums">{pool.rolloutPct}%</span>
					</div>
					{pool.fullyRolled || !pool.targetVersion ? (
						<div className="font-mono text-ui-2xs uppercase tracking-[0.06em] text-muted-foreground">
							{liveTotal > 0 && pool.targetVersion
								? `All ${liveTotal} on ${pool.targetVersion}`
								: "No version target set"}
						</div>
					) : (
						<>
							<div className="text-xs text-foreground">
								<span className="font-semibold tabular-nums">
									{pool.versions.find((v) => v.key === pool.targetVersion)?.count ?? 0}
								</span>{" "}
								of {liveTotal} on {pool.targetVersion}
							</div>
							<div className="relative h-1.5 overflow-hidden bg-muted ring-1 ring-inset ring-border">
								<span className="block h-full bg-foreground transition-all" style={{ width: `${pool.rolloutPct}%` }} />
							</div>
						</>
					)}
				</div>

				{/* distribution */}
				<div className="flex flex-col gap-2.5 border-t border-border pt-3">
					<div className="flex items-center gap-2.5">
						<span className={cn(MONO_LABEL, "w-14 shrink-0")}>Versions</span>
						<div className="flex flex-1 flex-wrap gap-1.5">
							{pool.versions.length ? (
								pool.versions.map((v) => <Tally key={v.key} tally={v} />)
							) : (
								<span className="font-mono text-ui-2xs text-muted-foreground">—</span>
							)}
						</div>
					</div>
					<div className="flex items-center gap-2.5">
						<span className={cn(MONO_LABEL, "w-14 shrink-0")}>Locations</span>
						<div className="flex flex-1 flex-wrap gap-1.5">
							{pool.locDist.length ? (
								pool.locDist.map((l) => <Tally key={l.key} tally={l} strike />)
							) : (
								<span className="font-mono text-ui-2xs text-muted-foreground">—</span>
							)}
						</div>
					</div>
				</div>
			</div>

			{/* economics footer (manager-only; month-to-date) */}
			{economics && (
				<div className="flex items-center gap-3 border-t border-border bg-muted/40 px-4 py-2 font-mono text-ui-2xs text-muted-foreground">
					<span>{economics.provisionedHours.toFixed(1)}h</span>
					<span aria-hidden>·</span>
					{/* Month-to-date SPEND, not a monthly rate — an amount, so it takes formatMoney,
					    which wants minor units and gets a major-unit estimate from the fleet query. */}
					<span>{formatMoney(Math.round(economics.estCostEur * 100), "EUR")}</span>
					<span aria-hidden>·</span>
					<span>{economics.utilizationPct.toFixed(0)}% util</span>
				</div>
			)}
		</Card>
	);
}

/** Loading placeholder matching the pool card's silhouette. */
export function PoolCardSkeleton() {
	return (
		<Card className="gap-4 py-4">
			<div className="flex items-center gap-3 px-4">
				<Skeleton className="size-9" />
				<div className="flex-1 space-y-1.5">
					<Skeleton className="h-3.5 w-24" />
					<Skeleton className="h-2.5 w-16" />
				</div>
			</div>
			<div className="space-y-2 px-4">
				<Skeleton className="h-2.5 w-full" />
				<Skeleton className="h-3 w-3/5" />
				<Skeleton className="h-2 w-full" />
			</div>
		</Card>
	);
}

/** Empty state shown in the pools sidebar when no warm pools are configured. */
export function PoolsEmpty() {
	return (
		<EmptyState
			className="border border-border bg-card"
			// `level={3}` keeps the outline rung the hand-rolled `<h3>` had: this heads the pools
			// region of the runners page, so demoting it to `EmptyTitle`'s default `<div>` would
			// take an entry out of the document outline.
			level={3}
			title="No runner pools configured"
			description="Once a target cloud is connected, the controller provisions a warm pool of runners here and keeps it sized to demand."
			action={<span className={MONO_LABEL}>Connect a cloud in Settings to begin</span>}
		/>
	);
}
