// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Instant skeleton shown while the runners route prefetches runners + fleet on the server. */
export default function RunnersLoading() {
	return (
		<div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(320px,0.36fr)_minmax(0,0.64fr)]">
			<div className="flex flex-col gap-6">
				<div className="space-y-3">
					<Skeleton className="h-5 w-24" />
					<Skeleton className="h-40 w-full rounded-lg" />
					<Skeleton className="h-40 w-full rounded-lg" />
				</div>
				<Skeleton className="h-48 w-full rounded-lg" />
			</div>
			<div className="min-w-0 space-y-4">
				<div className="flex items-center justify-between">
					<Skeleton className="h-6 w-28" />
					<Skeleton className="h-8 w-28 rounded-md" />
				</div>
				<Skeleton className="h-9 w-full rounded-md" />
				<div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
					{[1, 2, 3, 4].map((i) => (
						<Skeleton key={i} className="h-44 w-full rounded-lg" />
					))}
				</div>
			</div>
		</div>
	);
}
