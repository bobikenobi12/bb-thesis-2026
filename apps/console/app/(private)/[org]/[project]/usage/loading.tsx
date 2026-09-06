// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PanelSkeleton } from "@/components/skeletons/page-skeletons";
import { Skeleton } from "@repo/ui/skeleton";

/**
 * Skeleton for the project Usage view — the same shape as the org usage route's, because the two
 * pages now render the same sections in the same order.
 *
 * It used to hand-roll `h-24` cards in an `sm:grid-cols-3` and its own comment called them "a stat
 * row". #3716 deleted the console's last stat-card strip, so for two waves this skeleton has been
 * promising a shape the page cannot produce. Its replacement is not `HeaderSkeleton` either: that
 * draws a 28px title bar, and neither usage page has a title — see the sibling note under
 * `~/usage`.
 */
export default function UsageLoading() {
	return (
		<div className="space-y-6">
			<div className="flex items-start justify-between gap-4 pb-2">
				<Skeleton className="h-4 w-64" />
				<Skeleton className="h-8 w-28 rounded-md" />
			</div>
			<PanelSkeleton lines={4} />
			<PanelSkeleton lines={6} />
		</div>
	);
}
