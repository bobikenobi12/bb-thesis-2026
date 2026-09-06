// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The evidence detail drawer — the full drill-down in-place (no bounce to the job page).
// Three tabs over one environment, ALWAYS all rendered: Report (per-control verdicts +
// findings + coverage blind-spots + env waivers), Receipt (signed/unsigned + field grid +
// sealed exception + download), and Drift (per-resource divergence). A tab without data
// shows a purposeful empty state — the sheet can never open blank.

import Link from "next/link";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { Sheet, SheetContent } from "@repo/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/tabs";
import { cn } from "@repo/ui/utils";
import type { EvidenceWaiver } from "@/lib/queries/evidence";
import type { EvidenceEnvRow } from "../evidence-derive";
import { stageShort } from "../evidence-derive";
import { EvIcon, isKnownCloud, stageTextClass } from "../evidence-status";
import { DriftTab } from "./drift-tab";
import { ReceiptTab } from "./receipt-tab";
import { ReportTab } from "./report-tab";

/** The evidence detail drawer for one environment. */
export function EvidenceDrawer({
	org,
	row,
	waivers,
	tab,
	onTab,
	onClose,
	onDownload,
}: {
	org: string;
	row: EvidenceEnvRow | null;
	waivers: EvidenceWaiver[];
	tab: string;
	onTab: (t: string) => void;
	onClose: () => void;
	onDownload: (row: EvidenceEnvRow) => void;
}) {
	return (
		<Sheet open={Boolean(row)} onOpenChange={(o) => !o && onClose()}>
			<SheetContent
				side="right"
				className="w-[min(560px,96vw)] gap-0 border-border-strong bg-surface-raised p-0 sm:max-w-none"
			>
				{row && (
					<>
						<div className="shrink-0 border-b px-5 pb-3.5 pt-5">
							<div className="mb-1.5 font-mono text-ui-3xs uppercase tracking-[0.16em] text-text-disabled">
								Evidence detail
							</div>
							<div className="flex items-center gap-2.5">
								{isKnownCloud(row.provider) ? (
									<ProviderIcon provider={row.provider} size={17} />
								) : (
									<EvIcon
										name="layers"
										size={16}
										className="text-text-tertiary"
									/>
								)}
								<span className="font-display text-lg font-semibold tracking-tight text-text-primary">
									{row.projectName}
								</span>
								<span
									className={cn(
										"font-mono text-ui-3xs uppercase tracking-[0.12em]",
										stageTextClass(row.stage),
									)}
								>
									{stageShort(row.stage)}
								</span>
							</div>
							<div className="mt-1.5 font-mono text-ui-xs text-text-tertiary">
								{row.environmentName} · {row.region}
								{row.verify && (
									<>
										{" · "}
										<Link
											href={`/${org}/~/jobs/${row.verify.jobId}`}
											className="underline-offset-2 hover:underline"
										>
											View job
										</Link>
									</>
								)}
							</div>
						</div>

						<Tabs
							value={tab}
							onValueChange={onTab}
							className="flex min-h-0 flex-1 flex-col"
						>
							<TabsList className="mx-5 mt-3.5 w-fit shrink-0">
								<TabsTrigger value="report">Report</TabsTrigger>
								<TabsTrigger value="receipt">Receipt</TabsTrigger>
								<TabsTrigger value="drift">Drift</TabsTrigger>
							</TabsList>

							<div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-4">
								<TabsContent value="report">
									<ReportTab org={org} row={row} waivers={waivers} />
								</TabsContent>
								<TabsContent value="receipt">
									<ReceiptTab row={row} onDownload={onDownload} />
								</TabsContent>
								<TabsContent value="drift">
									<DriftTab row={row} />
								</TabsContent>
							</div>
						</Tabs>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}
