"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Promote one environment's structural design changes onto another. Shows a live diff preview
// (adds/updates/removes) and an opt-in for applying removals, then queues the gated promotion.

import { ArrowRight, Loader2, MinusCircle, PencilLine, PlusCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { previewPromotion, promoteEnvironment } from "@/app/server/actions/promotions";
import type { ComponentChange, PromotionDiff } from "@/types/jsonb.types";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { ScrollArea } from "@repo/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Switch } from "@repo/ui/switch";

interface EnvOption {
	id: string;
	name: string;
	stage: string;
}

const OP_META = {
	CREATE: { icon: PlusCircle, label: "add" },
	UPDATE: { icon: PencilLine, label: "update" },
	DELETE: { icon: MinusCircle, label: "remove" },
} as const;

/** Dialog to promote `source` → `target` within a project. */
export function PromoteDialog({
	open,
	onOpenChange,
	projectId,
	envs,
	onPromoted,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	projectId: string;
	envs: EnvOption[];
	onPromoted: () => void | Promise<void>;
}) {
	const [sourceId, setSourceId] = useState("");
	const [targetId, setTargetId] = useState("");
	const [includeRemovals, setIncludeRemovals] = useState(false);
	const [diff, setDiff] = useState<PromotionDiff | null>(null);
	const [previewing, setPreviewing] = useState(false);
	const [submitting, setSubmitting] = useState(false);

	// Live diff preview whenever the pair or removal preference changes.
	useEffect(() => {
		if (!open || !sourceId || !targetId || sourceId === targetId) {
			setDiff(null);
			return;
		}
		let cancelled = false;
		setPreviewing(true);
		previewPromotion(projectId, sourceId, targetId, includeRemovals)
			.then((d) => {
				if (!cancelled) setDiff(d);
			})
			.catch(() => {
				if (!cancelled) setDiff(null);
			})
			.finally(() => {
				if (!cancelled) setPreviewing(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, projectId, sourceId, targetId, includeRemovals]);

	const shown = diff?.changes.filter(
		(c) => c.op !== "DELETE" || includeRemovals,
	);
	const nothingToDo = !!diff && (shown?.length ?? 0) === 0;

	async function submit() {
		if (!sourceId || !targetId) return;
		setSubmitting(true);
		try {
			await promoteEnvironment(projectId, sourceId, targetId, { includeRemovals });
			toast.success("Promotion queued");
			onOpenChange(false);
			await onPromoted();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to promote");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Promote environment</DialogTitle>
					<DialogDescription>
						Carry a source environment&apos;s structural changes onto a target. Sizing,
						capacity, and placement stay the target&apos;s.
					</DialogDescription>
				</DialogHeader>

				<div className="flex items-end gap-2">
					<div className="flex-1 space-y-1.5">
						<label className="text-xs font-medium">From</label>
						<Select value={sourceId} onValueChange={setSourceId}>
							<SelectTrigger className="h-9 text-sm">
								<SelectValue placeholder="Source" />
							</SelectTrigger>
							<SelectContent>
								{envs.map((e) => (
									<SelectItem key={e.id} value={e.id} disabled={e.id === targetId}>
										{e.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<ArrowRight className="mb-2 h-4 w-4 shrink-0 text-muted-foreground" />
					<div className="flex-1 space-y-1.5">
						<label className="text-xs font-medium">To</label>
						<Select value={targetId} onValueChange={setTargetId}>
							<SelectTrigger className="h-9 text-sm">
								<SelectValue placeholder="Target" />
							</SelectTrigger>
							<SelectContent>
								{envs.map((e) => (
									<SelectItem key={e.id} value={e.id} disabled={e.id === sourceId}>
										{e.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>

				{/* Diff preview */}
				<div className="min-h-[3rem]">
					{previewing ? (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" /> Computing changes…
						</div>
					) : diff ? (
						nothingToDo ? (
							<p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
								These environments are already aligned — nothing to promote.
							</p>
						) : (
							<div>
								<div className="mb-2 flex items-baseline justify-between">
									<span className="font-mono text-ui-2xs uppercase tracking-[0.14em] text-text-tertiary">
										Plan preview
									</span>
									<span className="font-mono text-ui-xs text-text-secondary">
										{diff.summary.join(" · ")}
									</span>
								</div>
								<ScrollArea className="max-h-56 rounded-md border border-border">
									<ul className="divide-y divide-border">
										{shown?.map((c: ComponentChange, i) => {
										const meta = OP_META[c.op];
										const Icon = meta.icon;
										return (
											<li key={`${c.component_type}-${c.key}-${i}`} className="flex items-start gap-2.5 p-2.5">
												<Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
												<div className="min-w-0 text-xs">
													<span className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
														{meta.label}
													</span>{" "}
													<span className="text-foreground">{c.component_type}</span>{" "}
													<span className="font-mono">{c.key}</span>
													{c.fields && (
														<div className="mt-0.5 text-muted-foreground">
															{Object.entries(c.fields)
																.map(([f, ch]) => `${f}: ${String(ch.from)} → ${String(ch.to)}`)
																.join(", ")}
														</div>
													)}
												</div>
											</li>
										);
									})}
									</ul>
								</ScrollArea>
							</div>
						)
					) : (
						<p className="text-xs text-muted-foreground">
							Pick a source and target to preview the changes.
						</p>
					)}
				</div>

				{/* Removals opt-in — only relevant when the target has components the source lacks. */}
				{diff && diff.changes.some((c) => c.op === "DELETE") && (
					<label className="flex items-center justify-between rounded-md border border-border p-2.5">
						<span className="text-xs">
							Apply removals
							<span className="block text-ui-xs text-muted-foreground">
								Delete target components the source no longer has (destructive).
							</span>
						</span>
						<Switch checked={includeRemovals} onCheckedChange={setIncludeRemovals} />
					</label>
				)}

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
						Cancel
					</Button>
					<Button
						onClick={submit}
						disabled={submitting || !sourceId || !targetId || sourceId === targetId || nothingToDo}
					>
						{submitting ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" /> Promoting…
							</>
						) : (
							"Promote"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
