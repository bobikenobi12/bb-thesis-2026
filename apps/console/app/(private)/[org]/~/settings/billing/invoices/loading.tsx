// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { TableSkeleton } from "@/components/skeletons/page-skeletons";
import { Skeleton } from "@repo/ui/skeleton";

/**
 * Instant skeleton for Settings · Billing · Invoices.
 *
 * Without this file the route inherited `../loading.tsx` — the BILLING panel's skeleton, which is a
 * plan card and a few content lines, not a filtered table. Mirrors what this page renders: the back
 * link, the section header with its count pill, the filter bar, then the invoice rows.
 */
export default function InvoicesLoading() {
	return (
		<div>
			{/* ← Billing */}
			<Skeleton className="mb-4 h-4 w-20" />

			{/* Section header + count pill. */}
			<div className="mb-4 flex items-center gap-2.5">
				<Skeleton className="h-5 w-24" />
				<Skeleton className="h-4 w-8 rounded-full" />
			</div>

			{/* Filter bar — status facet, quick range, date range. */}
			<div className="mb-4 flex flex-wrap items-center gap-2.5">
				<Skeleton className="h-8 w-28 rounded-md" />
				<Skeleton className="h-8 w-32 rounded-md" />
				<Skeleton className="h-8 w-40 rounded-md" />
			</div>

			<TableSkeleton rows={8} />
		</div>
	);
}
