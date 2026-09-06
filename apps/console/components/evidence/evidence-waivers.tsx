// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The recorded-waivers panel — the org-wide log of authorized, time-boxed control
// overrides that let a fail-closed apply proceed deliberately. Read-only; produced when a
// DEPLOY carries a jobs.verify_override.
//
// SHELL. Like the posture table, this was a hand-rolled CSS grid — four columns held in a
// `grid-cols-[…]` string with no header row at all, so the columns were unlabelled and a
// screen reader read the log as an undifferentiated stack of text. It now renders through the
// shared `@repo/ui/table` primitives with real column headers. Not `DataTable`: the list is
// server-produced, capped at 100 by the query, and never sorted or paginated client-side.

import Link from "next/link";
import { formatRelative } from "@repo/format";
import { CountPill } from "@repo/ui/count-pill";
import { SectionHeading } from "@repo/ui/section-heading";
import { EmptyState } from "@repo/ui/empty";
import { FieldHelp } from "@repo/ui/field-help";
import { StatusBadge } from "@repo/ui/status-badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { cn } from "@repo/ui/utils";
import type { EvidenceWaiver } from "@/lib/queries/evidence";
import { EVIDENCE_HELP } from "./evidence-help";
import { EvIcon } from "./evidence-status";

/** Cell padding — matches the posture table so the two panels read as one surface. */
const CELL = "px-3 py-3.5 align-top first:pl-4 last:pr-4";

/** The header cell treatment — mono micro-caps, shared with the posture table. */
const HEAD = cn(
	CELL,
	"h-auto py-2.5 font-mono text-ui-3xs font-normal uppercase tracking-[0.13em] text-text-tertiary",
);

/** The recorded-waivers panel below the posture table. */
export function EvidenceWaivers({
	org,
	waivers,
}: {
	org: string;
	waivers: EvidenceWaiver[];
}) {
	const active = waivers.filter((w) => w.active).length;
	return (
		<div className="overflow-hidden rounded-lg border bg-surface shadow-sm">
			<div className="flex items-center gap-2.5 border-b px-4 py-3.5">
				<EvIcon name="scroll" size={15} className="text-text-secondary" />
				<SectionHeading level={3} title="Recorded waivers" />
				<FieldHelp
					title={EVIDENCE_HELP.waiver.title}
					docsHref={EVIDENCE_HELP.waiver.docsHref}
					side="bottom"
					className="text-text-disabled hover:text-text-secondary"
				>
					{EVIDENCE_HELP.waiver.body}
				</FieldHelp>
				{/* The count pill beside the section heading, per the filter standard. It counts
				    the ACTIVE waivers, not every recorded one, so the word stays. */}
				<span className="flex items-center gap-1.5 font-mono text-ui-2xs text-text-tertiary">
					<CountPill count={active} />
					active
				</span>
				<span className="flex-1" />
				{waivers.length >= 100 && (
					<span className="font-mono text-ui-2xs text-text-disabled">
						Showing the 100 most recent
					</span>
				)}
			</div>
			{waivers.length === 0 ? (
				<EmptyState
					className="px-4 py-10 md:p-10"
					title="No waivers"
					description="Every apply cleared the gate without an override."
				/>
			) : (
				<Table className="min-w-[720px]">
					{/* Auto layout, not `table-fixed`: the two prose columns need to breathe the
					    way the `minmax()` tracks they replace did, so these widths are hints. */}
					<colgroup>
						<col className="w-[24%]" />
						<col className="w-[38%]" />
						<col className="w-[170px]" />
						<col className="w-[128px]" />
					</colgroup>
					<TableHeader className="bg-surface-sunken">
						<TableRow className="hover:bg-transparent">
							<TableHead className={HEAD}>Waived</TableHead>
							<TableHead className={HEAD}>Reason</TableHead>
							<TableHead className={HEAD}>Recorded</TableHead>
							<TableHead className={HEAD}>Status</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{waivers.map((w) => (
							<TableRow
								key={w.jobId}
								className="border-border-faint hover:bg-transparent"
							>
								<TableCell className={cn(CELL, "whitespace-normal")}>
									<div className="flex min-w-0 flex-col gap-1.5">
										<div className="text-ui-sm font-medium text-text-primary">
											{w.projectName ?? "—"}
											{w.environmentName ? (
												<span className="text-text-tertiary">
													{" · "}
													{w.environmentName}
												</span>
											) : null}
										</div>
										<div className="flex flex-wrap gap-1">
											{w.controls.map((c) => (
												<span
													key={c}
													className="rounded-xs border bg-surface-sunken px-1.5 py-0.5 font-mono text-ui-2xs text-text-secondary"
												>
													{c}
												</span>
											))}
										</div>
									</div>
								</TableCell>
								<TableCell
									className={cn(
										CELL,
										"whitespace-normal text-ui-sm leading-relaxed text-text-secondary",
									)}
								>
									{w.reason}
								</TableCell>
								<TableCell className={CELL}>
									<div className="flex flex-col gap-0.5 font-mono text-ui-2xs text-text-tertiary">
										<span className="text-text-secondary">{w.by}</span>
										<span>{formatRelative(w.createdAt)}</span>
										<Link
											href={`/${org}/~/jobs/${w.jobId}`}
											className="w-fit underline-offset-2 hover:text-text-primary hover:underline"
										>
											View job
										</Link>
									</div>
								</TableCell>
								<TableCell className={CELL}>
									<div className="flex flex-col items-start gap-1">
										<StatusBadge
											status={w.active ? "active" : "expired"}
											tier={w.active ? "active" : "disabled"}
											label={w.active ? "Active" : "Expired"}
											className="text-ui-3xs"
										/>
										<span className="font-mono text-ui-2xs text-text-disabled">
											{w.expiry
												? `Expires ${formatRelative(w.expiry)}`
												: "No expiry"}
										</span>
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	);
}
