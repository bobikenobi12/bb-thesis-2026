"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Plan-history timeline (Billing page). Derived honestly from what we know today
// (org created + current plan) — there's no billing event log yet, so this stays
// minimal rather than inventing history.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getPlanHistory, type PlanHistoryEntry } from "@/app/server/actions/billing";
import { SettingsSection } from "@/components/settings/settings-ui";
import { formatDate } from "@repo/format";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";

export function PlanHistoryTimeline() {
	const [entries, setEntries] = useState<PlanHistoryEntry[] | null>(null);

	useEffect(() => {
		getPlanHistory()
			.then(setEntries)
			.catch(() => toast.error("Couldn't load plan history."));
	}, []);

	return (
		<SettingsSection title="Plan history">
			<div className="rounded-lg border border-border bg-surface px-6 pb-2.5 pt-5 shadow-sm">
				{!entries ? (
					<Skeleton className="h-20 w-full" />
				) : entries.length === 0 ? (
					<div className="text-ui-md text-text-tertiary">No plan history yet.</div>
				) : (
					<div className="relative pl-[26px] before:absolute before:bottom-[18px] before:left-1 before:top-1 before:w-px before:bg-border-strong before:content-['']">
						{entries.map((e) => (
							<div key={`${e.when}:${e.title}`} className="relative pb-5 last:pb-0">
								<div
									className={cn(
										"absolute -left-[26px] top-0.5 size-[9px] rounded-full border-[1.5px]",
										e.current
											? "border-text-primary bg-text-primary ring-[3px] ring-surface-muted"
											: "border-text-tertiary bg-surface",
									)}
								/>
								<div className="mb-1 font-mono text-ui-2xs text-text-tertiary">
									{formatDate(e.when)}
								</div>
								<div className="text-ui-md text-text-primary">{e.title}</div>
								<div className="mt-0.5 text-ui-sm text-text-tertiary">{e.detail}</div>
							</div>
						))}
					</div>
				)}
			</div>
		</SettingsSection>
	);
}
