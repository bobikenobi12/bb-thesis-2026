// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PanelSkeleton } from "@/components/skeletons/page-skeletons";
import { Skeleton } from "@repo/ui/skeleton";

/**
 * Instant skeleton for the org usage route.
 *
 * NOT `HeaderSkeleton`: that shape is a 28px title bar over a description line, and this page has
 * no title — the breadcrumb names it and `PageToolbar` carries a single line of copy plus one
 * action. A skeleton that draws a heading the page will never render makes the content jump when
 * it resolves, which is the whole thing a skeleton exists to avoid.
 */
export default function UsageLoading() {
	return (
		<div className="space-y-6">
			{/* The toolbar: one description line, one action, on a row. */}
			<div className="flex items-start justify-between gap-4 pb-2">
				<Skeleton className="h-4 w-64" />
				<Skeleton className="h-8 w-28 rounded-md" />
			</div>
			<PanelSkeleton lines={4} />
			<PanelSkeleton lines={6} />
		</div>
	);
}
