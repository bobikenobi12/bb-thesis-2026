"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useMemo } from "react";
import { StatusBadge } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import { NODE_REGISTRY } from "../graph/node-registry";
import { configName } from "../graph/node-config";
import type { CollectionNodeData } from "@/lib/canvas/collections";
import { aggregateState } from "@/lib/canvas/collections";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { NODE_STATUS_META, resolveNodeStatusFor } from "@/lib/canvas/node-status";
import { useCanvasLod } from "@/lib/canvas/use-canvas-lod";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

const HANDLE_CLASS = "!h-2 !w-2 !rounded-none !border !border-border !bg-background";

/** How many member names the card lists before it just says "+N more". */
const PREVIEW = 4;

/**
 * The vault card — one card standing for every resource of a high-cardinality kind.
 *
 * Thirty secrets drawn as thirty cards bury the architecture. Drawn as one card that says
 * "Secrets · 30 · 1 failed", the architecture stays readable AND the trouble inside is still
 * visible: the card reports its WORST member's state, so a vault holding one failed secret never
 * reads "Live". Open it to get the full list.
 */
export function CollectionNode({
	id,
	data,
	selected,
}: NodeProps<Node<CollectionNodeData>>) {
	const def = NODE_REGISTRY[data.kind];
	const Icon = def.icon;
	const lod = useCanvasLod();
	const nodes = useCanvasStore((s) => s.nodes);
	const core = useCanvasStore((s) => s.getCoreIdentity());
	const env = useEnvironmentStatus();

	const members = useMemo(
		() => nodes.filter((n) => data.memberIds.includes(n.id)),
		[nodes, data.memberIds],
	);

	// Every member's REAL status, resolved through the same precedence ladder as any other node —
	// then the worst one is what the card shows. That's what stops collapsing from hiding trouble:
	// a vault holding one failed secret can never read "Live".
	// Resolved in a plain loop (not a hook per member) because the member count changes whenever a
	// secret is added, which would shift hook order.
	const worst = useMemo(() => {
		const statuses = members.map((m) => resolveNodeStatusFor(nodes, core, env, m.id));
		const state = aggregateState(statuses.map((s) => s.state));
		const first = statuses.find((s) => s.state === state);
		const drifted = statuses.reduce((n, s) => n + s.drift.length, 0);
		return { state, message: first?.message, drifted };
	}, [members, nodes, core, env]);

	const meta = NODE_STATUS_META[worst.state];
	const title = def.collection?.title ?? def.label;
	const count = members.length;

	if (lod === "glyph") {
		return (
			<div className="flex w-[76px] flex-col items-center gap-1.5">
				<Handle type="target" position={Position.Top} className={HANDLE_CLASS} />
				<span
					className={cn(
						"grid h-11 w-11 place-items-center border bg-card",
						selected ? "border-foreground" : "border-border-strong",
					)}
				>
					<Icon className="h-5 w-5 text-muted-foreground" />
				</span>
				<span className="max-w-[76px] truncate font-mono text-ui-2xs text-muted-foreground">
					{title} · {count}
				</span>
				<StatusBadge
					status={meta.label}
					tier={meta.vx}
					showLabel={false}
					suppressHydrationWarning
				/>
			</div>
		);
	}

	const compact = lod === "compact";
	const preview = members.slice(0, PREVIEW);

	return (
		<div
			className={cn(
				"relative rounded-none border bg-card text-card-foreground transition-colors",
				// A collection is periphery-classed like its members, so it carries the same rule.
				"before:absolute before:-inset-x-px before:-top-px before:h-0.5 before:bg-border before:content-['']",
				compact ? "w-[176px]" : "w-[248px]",
				selected
					? "border-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
					: "border-border hover:border-border-strong",
			)}
		>
			<Handle type="target" position={Position.Top} className={HANDLE_CLASS} />

			<div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
				<span className="grid h-[22px] w-[22px] shrink-0 place-items-center border border-border bg-surface-sunken">
					<Icon className="h-3.5 w-3.5 text-muted-foreground" />
				</span>
				<span className="vx-eyebrow truncate">{title}</span>
				{/* The label is HIDDEN on a nominal card, never unmounted — status comes from the
				    sessionStorage-persisted client store, so SSR and the first client paint can
				    disagree, and `showLabel={false}` would change the CHILD COUNT across hydration
				    (which `suppressHydrationWarning` does not cover). Same contract, and the same
				    `truncate`-on-the-flex-item reason, as `base-node.tsx`. */}
				<StatusBadge
					status={meta.label}
					tier={meta.vx}
					className={cn(
						"ml-auto min-w-0 shrink-0 [&>span:last-child]:truncate",
						(worst.state === "ready" || worst.state === "live") &&
							"[&>span:last-child]:hidden",
					)}
					title={worst.message ?? meta.label}
					suppressHydrationWarning
				/>
			</div>

			<div className="space-y-2 px-2.5 py-2.5">
				<div className="flex items-baseline gap-1.5">
					<span className="font-mono text-lg leading-none">{count}</span>
					<span className="text-xs text-muted-foreground">
						{count === 1 ? def.collection?.singular : `${def.collection?.singular}s`}
					</span>
					{worst.drifted > 0 && (
						<span className="ml-auto shrink-0 border border-border-strong px-1.5 py-0.5 font-mono text-ui-2xs text-foreground">
							{worst.drifted} drifted
						</span>
					)}
				</div>

				{/* The stack: a few names so the vault isn't opaque. Not the whole list — that's the
				    panel's job, and printing 30 names would just recreate the problem. */}
				{!compact && (
					<div className="space-y-px border border-border/60 bg-border/60">
						{preview.map((m) => (
							<div
								key={m.id}
								className="truncate bg-card px-1.5 py-1 font-mono text-ui-2xs text-muted-foreground"
							>
								{configName(m.data) || "—"}
							</div>
						))}
						{count > PREVIEW && (
							<div className="bg-card px-1.5 py-1 font-mono text-ui-2xs text-muted-foreground/60">
								+{count - PREVIEW} more
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

