// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reusable route-loading skeletons. Each route's `loading.tsx` re-exports the shape that
// best matches its content (table / form / panel / cards) so navigation shows instant
// structure during the server prefetch instead of a blank gap.

import { Skeleton } from "@repo/ui/skeleton";

/** A page header block: title + one-line description. */
export function HeaderSkeleton() {
	return (
		<div className="space-y-2">
			<Skeleton className="h-7 w-40" />
			<Skeleton className="h-4 w-72" />
		</div>
	);
}

/** A bordered table: header row + N body rows. */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
	return (
		<div className="rounded-lg border border-border/40">
			<div className="flex gap-4 border-b border-border/40 p-3">
				{[1, 2, 3, 4].map((i) => (
					<Skeleton key={i} className="h-3 w-24" />
				))}
			</div>
			{Array.from({ length: rows }, (_, i) => (
				<div key={i} className="flex gap-4 border-b border-border/20 p-3 last:border-b-0">
					<Skeleton className="h-3 w-32" />
					<Skeleton className="h-3 w-20" />
					<Skeleton className="h-3 w-16 rounded-full" />
					<Skeleton className="h-3 w-28" />
				</div>
			))}
		</div>
	);
}

/** A form: N label + input rows, then a submit button. */
export function FormSkeleton({ fields = 4 }: { fields?: number }) {
	return (
		<div className="space-y-5">
			{Array.from({ length: fields }, (_, i) => (
				<div key={i} className="space-y-2">
					<Skeleton className="h-3.5 w-28" />
					<Skeleton className="h-9 w-full max-w-md rounded-md" />
				</div>
			))}
			<Skeleton className="h-9 w-32 rounded-md" />
		</div>
	);
}

/** A bordered panel: title bar + a few content lines. */
export function PanelSkeleton({ lines = 4 }: { lines?: number }) {
	return (
		<div className="rounded-lg border bg-card">
			<div className="border-b px-4 py-3">
				<Skeleton className="h-4 w-40" />
			</div>
			<div className="space-y-3 p-4">
				{Array.from({ length: lines }, (_, i) => (
					<Skeleton key={i} className="h-4 w-full" />
				))}
			</div>
		</div>
	);
}
