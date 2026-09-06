"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Channel routing for a policy: a searchable multi-select (FacetFilter) to bind channels,
// then a row per bound channel with an optional severity floor ("send only ≥ X"). Shared
// by the policy create sheet and the inline policy editor. Read-only mode lists the
// bindings. The value is the policyInput `channels[]` shape.

import { Send, X } from "lucide-react";
import type { ChannelDTO } from "@/app/server/actions/alerts";
import { ChannelIcon } from "@/components/alerts/channel-icon";
import { Button } from "@repo/ui/button";
import { FacetFilter } from "@repo/ui/facet-filter";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";

/** A channel binding with an optional per-channel severity floor. */
export interface ChannelBinding {
	id: string;
	/** "warning" | "critical"; absent = all severities. */
	min_severity?: string;
}

// Per-channel routing floors (info floor == all, so it's folded into "all").
const FLOOR_OPTIONS = [
	{ value: "any", label: "All severities" },
	{ value: "warning", label: "Warning & critical" },
	{ value: "critical", label: "Critical only" },
];

interface ChannelRoutingProps {
	channels: ChannelDTO[];
	value: ChannelBinding[];
	onChange: (next: ChannelBinding[]) => void;
	editable: boolean;
	onGoChannels?: () => void;
}

/** Bind channels (searchable) + set each one's severity floor. */
export function ChannelRouting({
	channels,
	value,
	onChange,
	editable,
	onGoChannels,
}: ChannelRoutingProps) {
	const byId = new Map(channels.map((c) => [c.id, c]));
	const bound = value.filter((b) => byId.has(b.id));

	if (!editable) {
		if (bound.length === 0)
			return (
				<p className="text-muted-foreground text-sm">
					No channels — this policy fires nothing.
				</p>
			);
		return (
			<div className="flex flex-col gap-2">
				{bound.map((b) => {
					const c = byId.get(b.id);
					if (!c) return null;
					return (
						<div
							key={b.id}
							className="flex items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-2 text-sm"
						>
							<ChannelIcon type={c.type} active={c.is_verified} size={16} />
							<span className="min-w-0 flex-1 truncate">{c.name}</span>
							<span className="font-mono text-ui-2xs text-muted-foreground">
								{FLOOR_OPTIONS.find((o) => o.value === (b.min_severity ?? "any"))?.label}
							</span>
						</div>
					);
				})}
			</div>
		);
	}

	// Reconcile a new id-set from the facet picker, preserving existing floors.
	const onPick = (ids: string[]) => {
		const existing = new Map(value.map((b) => [b.id, b]));
		onChange(ids.map((id) => existing.get(id) ?? { id }));
	};
	const setFloor = (id: string, floor: string) =>
		onChange(
			value.map((b) =>
				b.id === id
					? { id, min_severity: floor === "any" ? undefined : floor }
					: b,
			),
		);
	const remove = (id: string) => onChange(value.filter((b) => b.id !== id));

	return (
		<div className="space-y-2">
			<FacetFilter
				label="Add channels"
				icon={Send}
				options={channels.map((c) => ({
					value: c.id,
					label: c.name,
					hint: c.type,
				}))}
				value={bound.map((b) => b.id)}
				onChange={onPick}
				searchPlaceholder="Search channels…"
				emptyText="No channels."
			/>

			{bound.length === 0 ? (
				<p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-muted-foreground text-xs">
					No channels bound yet.{" "}
					{channels.length === 0 && onGoChannels && (
						<button
							type="button"
							onClick={onGoChannels}
							className="underline underline-offset-2 hover:text-foreground"
						>
							Add one in Channels
						</button>
					)}
				</p>
			) : (
				<div className="flex flex-col gap-2">
					{bound.map((b) => {
						const c = byId.get(b.id);
						if (!c) return null;
						return (
							<div
								key={b.id}
								className="flex items-center gap-2 rounded-lg border border-border/60 bg-background px-3 py-2"
							>
								<ChannelIcon type={c.type} active={c.is_verified} size={16} />
								<span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
								<Select
									value={b.min_severity ?? "any"}
									onValueChange={(val) => setFloor(b.id, val)}
								>
									<SelectTrigger className="h-7 w-[150px] text-xs">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{FLOOR_OPTIONS.map((o) => (
											<SelectItem key={o.value} value={o.value}>
												{o.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-7 text-muted-foreground hover:text-foreground"
									onClick={() => remove(b.id)}
									aria-label={`Remove ${c.name}`}
								>
									<X className="size-3.5" />
								</Button>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
