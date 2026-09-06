"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { cn } from "@repo/ui/utils";
import type { DrillId, NavBadge, NavItem } from "./nav-config";

/** The small uppercase Beta/Soon tag shown on the right of a nav row. */
function NavItemBadge({ badge }: { badge: NavBadge }) {
	return (
		<span
			className={cn(
				"shrink-0 rounded-full px-1.5 py-px font-mono text-ui-3xs uppercase tracking-wide",
				badge.tone === "beta"
					? "border text-muted-foreground"
					: "border border-dashed text-muted-foreground/70",
			)}
		>
			{badge.text}
		</span>
	);
}

/**
 * A single sidebar nav row, shared by the main view and the drill sub-views. Renders a
 * `<Link>` for navigable items, a button for click-only drill triggers, and a disabled
 * button for not-yet-built stubs. Drill triggers with an `anchor` navigate (route-owned);
 * those without open the drill in place via `onOpenDrill`.
 */
export function NavRow({
	item,
	active,
	onOpenDrill,
	onClick,
}: {
	item: NavItem;
	active: boolean;
	onOpenDrill?: (id: DrillId) => void;
	/** Intercepts a navigable row's click (e.g. to anchor-scroll on the same page). */
	onClick?: (e: React.MouseEvent) => void;
}) {
	const Icon = item.icon;
	const className = cn(
		"flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-ui-md transition-colors",
		active
			? "bg-muted text-foreground"
			: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
		item.disabled &&
			"cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
	);

	const inner = (
		<>
			<Icon className="h-4 w-4 shrink-0 opacity-90" />
			<span className="flex-1 truncate text-left">{item.label}</span>
			{item.badge && <NavItemBadge badge={item.badge} />}
			{item.drill && (
				<ChevronRight className="h-[15px] w-[15px] shrink-0 text-muted-foreground/60" />
			)}
		</>
	);

	if (item.disabled) {
		return (
			<button type="button" disabled aria-disabled className={className}>
				{inner}
			</button>
		);
	}

	if (item.drill) {
		const drillId = item.drill;
		if (item.anchor) {
			return (
				<Link href={item.anchor} className={className}>
					{inner}
				</Link>
			);
		}
		return (
			<button type="button" className={className} onClick={() => onOpenDrill?.(drillId)}>
				{inner}
			</button>
		);
	}

	if (!item.href) {
		return (
			<button type="button" disabled aria-disabled className={className}>
				{inner}
			</button>
		);
	}

	return (
		<Link href={item.href} className={className} onClick={onClick}>
			{inner}
		</Link>
	);
}
