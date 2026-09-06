// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/**
 * Instant skeleton for Settings · Classification, while the page prefetches the org's taxonomy.
 *
 * Without this file the route fell back THREE segments to `[org]/loading.tsx` — the org overview's
 * card grid, at a width (`max-w-[1360px]`) that was not even this page's. Mirrors what the manager
 * actually renders: the search + count toolbar, then one panel per dimension.
 */
export default function ClassificationLoading() {
	return (
		<div>
			{/* Toolbar — search box, the match count, and the docs affordance on the right. */}
			<div className="mb-4 flex items-center gap-2.5">
				<Skeleton className="h-9 w-[240px] rounded-sm" />
				<Skeleton className="h-3 w-24" />
				<div className="flex-1" />
				<Skeleton className="size-9 rounded-sm" />
			</div>

			{/* Dimension panels — header row + a few value chips each. */}
			<div className="space-y-3">
				{[1, 2, 3, 4].map((i) => (
					<div key={i} className="rounded-md border border-border/40 p-4">
						<div className="mb-3 flex items-center gap-2.5">
							<Skeleton className="h-4 w-40" />
							<Skeleton className="h-4 w-16 rounded-full" />
						</div>
						<div className="flex flex-wrap gap-2">
							{[1, 2, 3, 4, 5].map((v) => (
								<Skeleton key={v} className="h-6 w-20 rounded-full" />
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
