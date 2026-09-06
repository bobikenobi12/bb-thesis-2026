"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The panel behind an EXTERNAL card — one kind's worth of a bring-your-own IaC module.
//
// It is deliberately READ-ONLY. Alethia plans, prices, drifts and audits these resources; it does not
// own their definition. Changing one means editing the customer's Terraform, not this panel — so this
// offers no fields, only the truth: every resource in the group, what the last plan would do to it,
// what it costs, and whether it has drifted.
//
// Collapsing is what keeps the board readable (a real module is 50–200 resources), so nothing is
// hidden — it is all here, one row per address.

import { Boxes } from "lucide-react";
import { formatMonthlyRate } from "@repo/format";
import { StatusBadge } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { NODE_STATUS_META, nodeStatusKey, useNodeStatus } from "@/lib/canvas/node-status";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { NODE_REGISTRY } from "../graph/node-registry";
import { type CanvasNode, nodeOfKind } from "../graph/types";

/** How a plan action reads. `no-op` is the calm one — it means "already live and unchanged". */
const ACTION_LABEL: Record<string, string> = {
	create: "will create",
	update: "will update",
	replace: "will replace",
	delete: "will delete",
	"no-op": "unchanged",
};

/** The read-only member list for one external group. */
export function ExternalPanel({ nodeId }: { nodeId: string }) {
	const raw = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId));
	const node = nodeOfKind(raw, "external");
	const env = useEnvironmentStatus();
	const status = useNodeStatus(nodeId);

	if (!node) return null;
	const config = node.data.config;
	const def = config.mappedKind ? NODE_REGISTRY[config.mappedKind] : null;
	const Icon = def?.icon ?? Boxes;
	const meta = NODE_STATUS_META[status.state];
	const costByAddress = env.iac?.costByAddress ?? {};

	// Drift arrives attributed by EXACT address, so a row can say "this one drifted" with certainty
	// rather than guessing from the resource's type and name.
	const server = env.components[nodeStatusKey(node)];
	const drifted = new Set((server?.drift ?? []).map((d) => d.address));

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-start gap-3 border-b border-border p-4">
				<span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-none border border-dashed text-muted-foreground">
					<Icon className="h-4 w-4" />
				</span>
				<div className="min-w-0 flex-1 space-y-1">
					<div className="truncate text-sm font-medium">
						{def?.label ?? "Other resources"}
					</div>
					<div className="truncate font-mono text-xs text-muted-foreground">
						{config.module || "root module"}
					</div>
					<StatusBadge
						status={meta.label}
						tier={meta.vx}
						title={status.message ?? meta.label}
					/>
				</div>
			</div>

			<div className="border-b border-border px-4 py-3 text-xs text-muted-foreground">
				{/* The honesty line. A plan's addresses are exact and count/for_each-expanded; the static
				    scan's are only DECLARED, so a `count = 3` block is one row here and three in reality.
				    Say which you're looking at, or the list is a guess wearing a fact's clothes. */}
				{config.source === "plan" ? (
					<>
						From this environment&rsquo;s last plan — these are the exact resources it manages.
					</>
				) : (
					<>
						Declared in the module, from its safety scan. Counts are not expanded yet — run a plan
						to see the exact resources.
					</>
				)}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<ul className="divide-y divide-border">
					{config.members.map((m) => {
						const cost = costByAddress[m.address];
						const hasDrift = drifted.has(m.address);
						return (
							<li key={m.address} className="space-y-1 px-4 py-2.5">
								<div className="truncate font-mono text-ui-xs text-foreground" title={m.address}>
									{m.address}
								</div>
								<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-ui-2xs text-muted-foreground">
									<span>{m.type}</span>
									{m.action && (
										<span className={cn(m.action !== "no-op" && "text-foreground")}>
											{ACTION_LABEL[m.action] ?? m.action}
										</span>
									)}
									{/* Never-priced reads as nothing at all. A fabricated $0.00 is worse than an
									    admitted unknown, because you'd believe it. */}
									{cost != null && (
										<span className="text-foreground">{formatMonthlyRate(cost, "exact")}</span>
									)}
									{hasDrift && (
										<span className="border border-border-strong px-1 uppercase tracking-wide">
											drifted
										</span>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			</div>
		</div>
	);
}
