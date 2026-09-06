"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview Alerts card — the org's most recent alert deliveries. Deliveries carry a
// delivery status (sent/failed/…), not a per-event severity, so the dot + right-hand pill
// read off the delivery status (grayscale, via StatusBadge tiers).

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatRelative } from "@repo/format";
import { BellOff, Zap } from "lucide-react";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { Skeleton } from "@repo/ui/skeleton";
import {
	type DeliveryDTO,
	getAlertsBootstrap,
} from "@/app/server/actions/alerts";
import { CARD_EMPTY } from "@/components/overview/card-empty";
import { globalHref } from "@/lib/routing";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";

/** Delivery status → grayscale tier for the left-hand dot. */
const DELIVERY_TIER: Record<string, StatusTier> = {
	failed: "failed",
	retrying: "pending",
	pending: "pending",
	sent: "active",
	skipped: "disabled",
};

const MAX_ROWS = 4;

/** Recent alert deliveries for the org. */
export function AlertsCard({ orgSlug }: { orgSlug: string }) {
	const { openUpgrade } = useUpgradeSheet();
	const [deliveries, setDeliveries] = useState<DeliveryDTO[] | null>(null);
	// null until loaded; true/false once the bootstrap resolves the plan's alerting grant.
	const [alerting, setAlerting] = useState<boolean | null>(null);

	useEffect(() => {
		let alive = true;
		getAlertsBootstrap()
			.then((b) => {
				if (!alive) return;
				setAlerting(b.alerting);
				setDeliveries(b.deliveries.slice(0, MAX_ROWS));
			})
			.catch(() => {
				if (alive) {
					setAlerting(true); // can't tell — fall back to the neutral empty state
					setDeliveries([]);
				}
			});
		return () => {
			alive = false;
		};
	}, []);

	return (
		<div className="rounded-lg border bg-card shadow-sm">
			<div className="flex min-h-[50px] items-center gap-2 border-b px-4 py-2.5">
				<span className="font-display text-sm font-semibold">Alerts</span>
				<span className="font-mono text-ui-2xs text-muted-foreground">
					{deliveries === null || alerting === false
						? ""
						: `${deliveries.length} recent`}
				</span>
				<Link
					href={globalHref(orgSlug, "alerts")}
					className="ml-auto font-mono text-ui-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					Manage →
				</Link>
			</div>

			{deliveries === null ? (
				<div className="space-y-2 p-4">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-9 w-full rounded-md" />
					))}
				</div>
			) : alerting === false ? (
				// A locked feature stands exactly where its rows would have been, which is what §6
				// calls an empty state — so it is the same shape as the one two lines below rather
				// than a second centred div that happens to sit in the same slot.
				<EmptyState
					className={CARD_EMPTY}
					icon={<BellOff />}
					title="Alerting is a Pro feature"
					description="Notification channels and policies unlock on the Pro plan."
					action={
						<Button
							variant="outline"
							size="xs"
							className="gap-1.5 text-xs"
							onClick={openUpgrade}
						>
							<Zap className="h-3 w-3" />
							Upgrade
						</Button>
					}
				/>
			) : deliveries.length === 0 ? (
				<EmptyState className={CARD_EMPTY} title="No recent alerts." />
			) : (
				deliveries.map((d) => (
					<div
						key={d.id}
						className="flex items-start gap-3 border-b border-border/60 px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/40"
					>
						<StatusBadge
							status={d.status}
							tier={DELIVERY_TIER[d.status] ?? "idle"}
							showLabel={false}
							className="mt-1"
						/>
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="truncate text-ui-md text-foreground">
								{d.title}
							</span>
							<span className="truncate font-mono text-ui-2xs text-muted-foreground">
								{d.event_key} · {formatRelative(d.created_at)}
							</span>
						</div>
						<span className="shrink-0 rounded-full border px-2 py-0.5 font-mono text-ui-3xs uppercase tracking-wide text-muted-foreground">
							{d.status}
						</span>
					</div>
				))
			)}
		</div>
	);
}
