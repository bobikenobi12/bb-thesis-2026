// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Instant skeleton shown while the org overview prefetches projects on the server. */
export default function OverviewLoading() {
	return (
		<div className="space-y-5">
			<Skeleton className="h-9 w-full max-w-md rounded-md" />
			<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(312px,0.35fr)_minmax(0,0.65fr)]">
				<div className="flex flex-col gap-4">
					<Skeleton className="h-40 w-full rounded-lg" />
					<Skeleton className="h-32 w-full rounded-lg" />
					<Skeleton className="h-48 w-full rounded-lg" />
				</div>
				<div>
					<Skeleton className="mb-3 h-5 w-28" />
					<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(238px,1fr))]">
						{[1, 2, 3, 4, 5, 6].map((i) => (
							<Skeleton key={i} className="h-32 w-full rounded-lg" />
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
