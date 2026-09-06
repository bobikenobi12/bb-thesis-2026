"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { asRecord } from "@/lib/records";
import { cn } from "@repo/ui/utils";
import { NODE_REGISTRY } from "../graph/node-registry";
import { configName } from "../graph/node-config";
import type { AiActionParsed } from "@/lib/ai/proposal";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/**
 * What Accept is actually going to do.
 *
 * The proposal card used to render only the model's own one-line `label` — a string the model wrote
 * about itself — while the Accept button applied a list of `actions` the user never saw. That's a
 * trust bug: you were asked to approve a summary, and what got applied was the payload.
 *
 * This renders the payload. Every action, against the CURRENT canvas, with the old value beside the
 * new one — because "set min_capacity to 8" means nothing without knowing it was 0.5.
 */
export function ProposalDiff({ actions }: { actions: AiActionParsed[] }) {
	const nodes = useCanvasStore((s) => s.nodes);
	const identities = useCanvasStore((s) => s.identities);

	const nameOf = (nodeId: string) => {
		const node = nodes.find((n) => n.id === nodeId);
		if (!node) return nodeId;
		return configName(node.data) || NODE_REGISTRY[node.data.kind].label;
	};
	const identityLabel = (id: string | null | undefined) =>
		id ? (identities.find((i) => i.id === id)?.displayId ?? id) : "inherit project";

	return (
		<ul className="divide-y divide-border/60 border-t border-border/60">
			{actions.map((action, i) => (
				// Actions are positional — the index is their identity.
				// eslint-disable-next-line react/no-array-index-key
				<li key={i} className="flex items-start gap-2 px-2.5 py-1.5">
					<Marker action={action} />
					<div className="min-w-0 flex-1 space-y-0.5">
						<ActionLine
							action={action}
							nodes={nodes}
							nameOf={nameOf}
							identityLabel={identityLabel}
						/>
					</div>
				</li>
			))}
		</ul>
	);
}

/** +, ~, − — the shape of the change, in the terse grayscale the board speaks. */
function Marker({ action }: { action: AiActionParsed }) {
	const glyph =
		action.kind === "add_node" ? "+" : action.kind === "remove_node" ? "−" : "~";
	return (
		<span
			className={cn(
				"mt-px shrink-0 font-mono text-xs",
				action.kind === "remove_node" ? "text-foreground" : "text-muted-foreground",
			)}
			aria-hidden
		>
			{glyph}
		</span>
	);
}

function ActionLine({
	action,
	nodes,
	nameOf,
	identityLabel,
}: {
	action: AiActionParsed;
	nodes: ReturnType<typeof useCanvasStore.getState>["nodes"];
	nameOf: (id: string) => string;
	identityLabel: (id: string | null | undefined) => string;
}) {
	if (action.kind === "add_node") {
		const def = NODE_REGISTRY[action.nodeKind];
		const name =
			typeof action.config?.name === "string" ? action.config.name : def.label;
		const settings = Object.entries(action.config ?? {}).filter(
			([k]) => k !== "name",
		);
		return (
			<>
				<div className="font-mono text-ui-xs">
					<span className="text-muted-foreground">Add {def.eyebrow.toLowerCase()} </span>
					<span className="text-foreground">{name}</span>
				</div>
				{settings.length > 0 && (
					<div className="font-mono text-ui-2xs text-muted-foreground">
						{settings.map(([k, v]) => `${k} ${fmt(v)}`).join(" · ")}
					</div>
				)}
			</>
		);
	}

	if (action.kind === "remove_node") {
		return (
			<div className="font-mono text-ui-xs">
				<span className="text-muted-foreground">Remove </span>
				<span className="text-foreground">{nameOf(action.nodeId)}</span>
			</div>
		);
	}

	if (action.kind === "set_identity") {
		const node = nodes.find((n) => n.id === action.nodeId);
		return (
			<div className="font-mono text-ui-xs">
				<span className="text-foreground">{nameOf(action.nodeId)}</span>
				<span className="text-muted-foreground"> cloud </span>
				<span className="text-muted-foreground line-through">
					{identityLabel(node?.data.cloud_identity_id)}
				</span>
				<span className="text-muted-foreground"> → </span>
				<span className="text-foreground">{identityLabel(action.cloudIdentityId)}</span>
			</div>
		);
	}

	// update_config — the one that most needs a BEFORE. "set min_capacity to 8" tells you nothing
	// unless you know it was 0.5.
	const node = nodes.find((n) => n.id === action.nodeId);
	const before = asRecord(node?.data.config);
	return (
		<>
			<div className="font-mono text-ui-xs text-foreground">
				{nameOf(action.nodeId)}
			</div>
			<dl className="space-y-0.5">
				{Object.entries(action.patch).map(([key, next]) => (
					<div key={key} className="font-mono text-ui-2xs">
						<span className="text-muted-foreground">{key} </span>
						<span className="text-muted-foreground line-through">
							{fmt(before[key])}
						</span>
						<span className="text-muted-foreground"> → </span>
						<span className="text-foreground">{fmt(next)}</span>
					</div>
				))}
			</dl>
		</>
	);
}

/** A config value, rendered terse. Absent reads as an em dash, never as "undefined". */
function fmt(value: unknown): string {
	if (value == null || value === "") return "—";
	if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

export type { CloudProviderSlug };
