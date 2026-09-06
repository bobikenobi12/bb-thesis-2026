// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Skeleton for the Environments view — a header + a few env rows + the create button. */
export default function EnvironmentsLoading() {
	return (
		<div className="mx-auto max-w-4xl space-y-10">
			<div className="space-y-2">
				<Skeleton className="h-6 w-40" />
				<Skeleton className="h-4 w-80" />
			</div>
			<div className="space-y-3">
				<div className="divide-y divide-border rounded-lg border border-border">
					{[0, 1, 2].map((i) => (
						<div key={i} className="flex items-center gap-3 px-4 py-3">
							<Skeleton className="h-4 w-4 rounded" />
							<div className="flex-1 space-y-1.5">
								<Skeleton className="h-4 w-32" />
								<Skeleton className="h-3 w-24" />
							</div>
						</div>
					))}
				</div>
				<Skeleton className="h-8 w-40 rounded-md" />
			</div>
		</div>
	);
}
