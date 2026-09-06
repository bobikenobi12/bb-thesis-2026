"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Box,
	Boxes,
	Check,
	Database,
	GitBranch,
	KeyRound,
	Layers,
	ListOrdered,
	Loader2,
	Radio,
	Server,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { InferredNeed, ScanProposal } from "@/lib/scanner/schema";
import { cn } from "@repo/ui/utils";

/** One line in the inferred-stack summary. */
interface StackItem {
	icon: LucideIcon;
	name: string;
	detail: string;
	/** 0–1 model confidence; omitted for deterministic rows (cluster/services). */
	confidence?: number;
}

const NEED_ICON: Record<InferredNeed["kind"], LucideIcon> = {
	database: Database,
	cache: Layers,
	queue: ListOrdered,
	topic: Radio,
	nosql: Boxes,
	secret: KeyRound,
};
const NEED_LABEL: Record<InferredNeed["kind"], string> = {
	database: "Database",
	cache: "Cache",
	queue: "Queue",
	topic: "Topic",
	nosql: "NoSQL table",
	secret: "Secret",
};

/** Turns a scan proposal into the rail's summary rows: cluster + services + inferred needs. */
function stackItems(proposal: ScanProposal): StackItem[] {
	const items: StackItem[] = [
		{ icon: Box, name: "Kubernetes cluster", detail: "base · autoscaling nodes" },
	];
	for (const s of proposal.proposedProject.services ?? []) {
		items.push({ icon: Server, name: s.name, detail: "detected workload" });
	}
	for (const n of proposal.stack.needs) {
		items.push({
			icon: NEED_ICON[n.kind],
			name: n.engine ? `${NEED_LABEL[n.kind]} · ${n.engine}` : NEED_LABEL[n.kind],
			detail: n.rationale,
			confidence: n.confidence,
		});
	}
	return items;
}

/** Confidence → a coarse label + dot weight. */
function confLevel(c: number): { label: string; cls: string } {
	if (c >= 0.75) return { label: "high", cls: "bg-foreground" };
	if (c >= 0.5) return { label: "med", cls: "bg-muted-foreground" };
	return { label: "low", cls: "bg-border" };
}

interface SourceSummaryProps {
	mode: "import" | "scratch";
	/** import: `owner/repo`. */
	repo?: string;
	branch?: string;
	/** import + scan still running. */
	scanning?: boolean;
	proposal?: ScanProposal | null;
	/** scratch: the on-ramp label + one-liner. */
	scratchLabel?: string;
	scratchDesc?: string;
}

/**
 * The Configure step's left rail: the chosen **source** (repo or scratch template) and the
 * **inferred stack** it will seed. For an import it streams the scan proposal's cluster + services +
 * inferred needs (each with the model's rationale + confidence); while the scan runs it shows a
 * scanning state. Nothing here is provisioned — it's the read model the canvas will open with.
 */
export function SourceSummary({
	mode,
	repo,
	branch = "main",
	scanning,
	proposal,
	scratchLabel,
	scratchDesc,
}: SourceSummaryProps) {
	const items = proposal ? stackItems(proposal) : [];

	return (
		<div className="flex flex-col gap-[18px]">
			<div className="flex flex-col gap-2.5">
				<span className="font-mono text-ui-2xs uppercase tracking-[0.22em] text-muted-foreground">
					Source
				</span>
				<div className="flex items-center gap-3 rounded-xl border border-border bg-card p-[13px]">
					<span className="grid size-[34px] shrink-0 place-items-center rounded-lg border border-border text-muted-foreground">
						{mode === "import" ? (
							<GitBranch className="size-4" />
						) : (
							<Boxes className="size-4" />
						)}
					</span>
					<div className="min-w-0 flex-1">
						<div className="truncate font-mono text-ui-md text-foreground">
							{mode === "import" ? repo : scratchLabel}
						</div>
						<div className="font-mono text-ui-2xs text-muted-foreground">
							{mode === "import" ? `branch · ${branch}` : scratchDesc}
						</div>
					</div>
					{mode === "import" && proposal && (
						<Check className="size-4 shrink-0 text-muted-foreground" />
					)}
				</div>
			</div>

			<div className="flex flex-col gap-2.5">
				<span className="font-mono text-ui-2xs uppercase tracking-[0.22em] text-muted-foreground">
					{mode === "scratch" ? "Starting point" : "Inferred stack"}
				</span>

				{mode === "import" && scanning && !proposal ? (
					<div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
						<div className="flex items-center gap-2.5 text-ui-sm text-muted-foreground">
							<Loader2 className="size-4 animate-spin" />
							Scanning {repo}…
						</div>
						<div className="h-2.5 w-[70%] animate-pulse rounded bg-muted" />
						<div className="h-2.5 w-[52%] animate-pulse rounded bg-muted" />
						<div className="h-2.5 w-[63%] animate-pulse rounded bg-muted" />
					</div>
				) : mode === "import" && proposal ? (
					<div className="overflow-hidden rounded-xl border border-border bg-card">
						{items.map((it, i) => {
							const Icon = it.icon;
							const c = it.confidence != null ? confLevel(it.confidence) : null;
							return (
								<div
									key={`${it.name}-${i}`}
									className="flex items-center gap-[11px] border-b border-border/60 px-[13px] py-[11px] last:border-b-0"
								>
									<span className="grid size-7 shrink-0 place-items-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
										<Icon className="size-3.5" />
									</span>
									<div className="min-w-0 flex-1">
										<div className="truncate text-ui-sm font-medium text-foreground">
											{it.name}
										</div>
										<div className="truncate text-ui-2xs text-muted-foreground">
											{it.detail}
										</div>
									</div>
									{c && (
										<span className="flex shrink-0 items-center gap-1.5 font-mono text-ui-3xs uppercase tracking-wide text-muted-foreground">
											<span className={cn("size-1.5 rounded-full", c.cls)} />
											{c.label}
										</span>
									)}
								</div>
							);
						})}
						<div className="bg-muted/30 px-[13px] py-2.5 font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
							scanned · {items.length} components
						</div>
					</div>
				) : (
					<div className="overflow-hidden rounded-xl border border-border bg-card">
						<div className="flex items-center gap-[11px] px-[13px] py-[11px]">
							<span className="grid size-7 shrink-0 place-items-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
								<Box className="size-3.5" />
							</span>
							<div>
								<div className="text-ui-sm font-medium text-foreground">
									Cluster
								</div>
								<div className="text-ui-2xs text-muted-foreground">
									standard preset · add the rest on the canvas
								</div>
							</div>
						</div>
					</div>
				)}
			</div>

			<p className="border-l-2 border-border pl-[11px] text-ui-xs leading-relaxed text-muted-foreground">
				Nothing is provisioned yet. Creating the project saves a draft; you
				review and deploy the full design on the canvas.
			</p>
		</div>
	);
}
