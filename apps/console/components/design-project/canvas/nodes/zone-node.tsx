"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { asRecord } from "@/lib/records";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { Boxes, Maximize2, Network, Server } from "lucide-react";
import { cn } from "@repo/ui/utils";
import {
	CONTAINER_DRAG_HANDLE,
	EXTERNAL_CONTAINER_ID,
	zoneNodeId,
	type ZoneNodeData,
} from "@/lib/canvas/zones";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

const ZONE_META = {
	network: { label: "VPC", Icon: Network },
	cluster: { label: "Cluster", Icon: Server },
	external: { label: "External / BYO", Icon: Boxes },
} as const;

/** Squared grayscale resize handle — matches the design system (1px, no radius, no hue). */
const RESIZE_HANDLE_CLASS =
	"!h-2 !w-2 !rounded-none !border !border-border-strong !bg-background";

/**
 * A container region — the VPC, the cluster nested inside it, and one region per BYO IaC module.
 *
 * The geometry is derived from its members until the user drags or resizes it (then a stored override
 * takes over — the re-fit button clears it). The members are painted on top and keep absolute
 * positions; this region just tells you which part of the system you're looking at, and lets you move
 * or resize the whole group. Only the HEADER drags (so the body stays click-through for panning); the
 * resize handles show only while the region is selected.
 */
export function ZoneNode({ id, data, selected }: NodeProps<Node<ZoneNodeData>>) {
	const { label, Icon } = ZONE_META[data.zone];
	const resetContainerGeometry = useCanvasStore((s) => s.resetContainerGeometry);

	// The region's one-line summary. VPC/cluster read it off their anchor card (CIDR, k8s version); the
	// BYO-module region has no single anchor, so it states how many resources it holds.
	const anchorKind = data.zone === "external" ? null : data.zone;
	const anchor = useCanvasStore((s) =>
		anchorKind ? s.nodes.find((n) => n.data.kind === anchorKind) : undefined,
	);
	const meta =
		data.zone === "external"
			? `${data.memberCount} ${data.memberCount === 1 ? "resource" : "resources"}`
			: anchor
				? summarize(data.zone, anchor.data.config)
				: null;

	return (
		<>
			<NodeResizer
				isVisible={!!selected}
				minWidth={data.minWidth}
				minHeight={data.minHeight}
				handleClassName={RESIZE_HANDLE_CLASS}
				lineClassName="!border-border-strong"
			/>
			<div
				className={cn(
					"h-full w-full rounded-none border",
					// The nested region is drawn a shade lighter so the containment reads at a glance.
					data.depth === 0
						? "border-border-strong bg-foreground/[0.012]"
						: "border-border bg-foreground/[0.012]",
					// A selected region shows a slightly stronger edge alongside its handles.
					selected && "border-foreground/40",
				)}
			>
				<div
					className={cn(
						CONTAINER_DRAG_HANDLE,
						"flex cursor-move items-center gap-2 border-b border-border bg-card/80 px-2.5 py-1.5",
					)}
				>
					<span className="grid h-5 w-5 shrink-0 place-items-center border border-border bg-surface-sunken">
						<Icon className="h-3 w-3 text-muted-foreground" />
					</span>
					<span className="vx-eyebrow">{label}</span>
					{meta && (
						<span className="truncate font-mono text-ui-2xs text-muted-foreground">
							{meta}
						</span>
					)}
					{data.pinned && (
						<button
							type="button"
							// Stop the click from bubbling to the region's drag/select handling.
							onPointerDown={(e) => e.stopPropagation()}
							onClick={(e) => {
								e.stopPropagation();
								resetContainerGeometry(
									data.zone === "external" ? EXTERNAL_CONTAINER_ID : zoneNodeId(data.zone),
								);
							}}
							title="Re-fit to contents"
							aria-label="Re-fit region to its contents"
							className="ml-auto grid h-5 w-5 shrink-0 place-items-center border border-transparent text-muted-foreground transition-colors hover:border-border hover:text-foreground"
						>
							<Maximize2 className="h-3 w-3" />
						</button>
					)}
				</div>
			</div>
		</>
	);
}

/** The one-line summary a region header shows, read from its anchor card's config. */
function summarize(zone: "network" | "cluster", config: unknown): string | null {
	const c = asRecord(config);
	if (zone === "network") {
		if (c.provision_network === false) {
			return typeof c.network_id === "string" ? c.network_id : "existing network";
		}
		return typeof c.cidr_block === "string" ? c.cidr_block : null;
	}
	const version = typeof c.cluster_version === "string" ? c.cluster_version : null;
	const min = c.node_min_size;
	const max = c.node_max_size;
	const nodes =
		typeof min === "number" && typeof max === "number" ? `${min}–${max} nodes` : null;
	return [version && `k8s ${version}`, nodes].filter(Boolean).join(" · ") || null;
}
