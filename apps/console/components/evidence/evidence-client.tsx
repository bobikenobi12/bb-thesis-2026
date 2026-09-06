"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Evidence surface — the org-wide "keep proving it" roll-up, and the reference
// implementation of the console filter standard: a URL-synced zustand filter store
// feeds a filter-in-key TanStack query (server-side filtering), the table dims while
// a refetch is in flight, and the count pill next to the Environments heading carries
// the result count. Read-only: the data is produced by the PLAN/DEPLOY + drift jobs.

import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@repo/ui/button";
import { SectionHeading } from "@repo/ui/section-heading";
import { ErrorState } from "@/components/errors/error-state";
import { DEFAULT_EVIDENCE_FILTERS } from "@/components/evidence/evidence-query";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useEvidenceQuery } from "@/lib/query/use-evidence-query";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useEvidenceFilters } from "@/lib/stores/use-evidence-filters";
import { EvidenceDrawer } from "./drawer/evidence-drawer";
import type { EvidenceEnvRow } from "./evidence-derive";
import { EvidenceNoMatch, EvidenceOnboarding } from "./evidence-empty";
import { EvidenceFilterBar } from "./evidence-filter-bar";
import { EvidenceTable } from "./evidence-table";
import { EvidenceWaivers } from "./evidence-waivers";
import { downloadReceipt } from "./receipt-download";

/** The default drawer tab for a row — Report if verified, else Receipt, else Drift. */
function defaultTab(row: EvidenceEnvRow): string {
	if (row.verify?.report) return "report";
	if (row.verify?.receipt) return "receipt";
	return "drift";
}

/** The Evidence page client (data comes hydrated from the route's prefetch). */
export function EvidenceClient() {
	const { org } = useParams<{ org: string }>();
	const filters = useEvidenceFilters((s) => s.filters);
	const reset = useEvidenceFilters((s) => s.reset);
	useFilterUrlSync(useEvidenceFilters, DEFAULT_EVIDENCE_FILTERS);
	const { data: result, isPlaceholderData, isError, refetch } = useEvidenceQuery();

	// Row interaction.
	const [drawerId, setDrawerId] = useState<string | null>(null);
	const [drawerTab, setDrawerTab] = useState("report");

	// The drawer opens only on a currently-visible row, so it's always in the grouped set.
	const drawerRow = useMemo(() => {
		for (const g of result?.groups ?? []) {
			const row = g.rows.find((r) => r.environmentId === drawerId);
			if (row) return row;
		}
		return null;
	}, [result?.groups, drawerId]);

	/** Opens the detail drawer — every row opens it; empty tabs show explained states. */
	const openDrawer = (row: EvidenceEnvRow) => {
		setDrawerTab(defaultTab(row));
		setDrawerId(row.environmentId);
	};

	/** Downloads the row's signed receipt and shows a confirmation toast. */
	const download = (row: EvidenceEnvRow) => {
		if (!row.verify?.receipt) return;
		// The shared `Toaster` (mounted bottom-center in `app/layout.tsx`) replaces the
		// fixed-position z-index-95 div this page used to hand-roll — one toast surface, one
		// dismiss affordance, one place in the layer scale.
		toast.success(downloadReceipt(row.verify.receipt, row.verify.jobId));
	};

	// A fetch failure must not render as a blank page (or fall through to onboarding) — show the
	// branded error surface with a retry instead.
	if (isError) {
		return (
			<ErrorState
				title="Couldn't load evidence"
				description="Something went wrong fetching your environment evidence. Check your connection and try again."
				actions={
					<Button variant="outline" size="sm" onClick={() => refetch()}>
						Retry
					</Button>
				}
			/>
		);
	}

	// Persisted-session filters can miss the prefetched key on a return visit —
	// nothing to render for exactly one frame while the refetch lands.
	if (!result) return null;

	const filtersActive =
		countActiveFilters(filters, DEFAULT_EVIDENCE_FILTERS) > 0;
	const onboarding = result.summary.environments === 0;

	return (
		<div className="pb-20">
			{onboarding ? (
				<EvidenceOnboarding org={org} />
			) : (
				<>
					<EvidenceFilterBar
						statusOptions={result.statusOptions}
						stageOptions={result.stageOptions}
						providerOptions={result.providerOptions}
					/>

					<div
						className={
							isPlaceholderData
								? "opacity-60 transition-opacity"
								: "transition-opacity"
						}
					>
						{/* The filter standard reference page finally takes the shared heading too:
						    the count beside it is the FILTERED result count, which is the one number
						    a filter bar exists to move. */}
						<SectionHeading
							className="mb-2.5"
							level={2}
							title="Environments"
							count={result.resultCount}
						/>

						{result.resultCount === 0 && filtersActive ? (
							<EvidenceNoMatch onClear={reset} />
						) : (
							<EvidenceTable groups={result.groups} onOpen={openDrawer} />
						)}

						<div className="mt-6">
							<EvidenceWaivers org={org} waivers={result.waivers} />
						</div>
					</div>
				</>
			)}

			<EvidenceDrawer
				org={org}
				row={drawerRow}
				waivers={result.waivers}
				tab={drawerTab}
				onTab={setDrawerTab}
				onClose={() => setDrawerId(null)}
				onDownload={download}
			/>
		</div>
	);
}
