// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

import { JOB_DETAIL_COLUMN, JOB_VIEWPORT_HEIGHT } from "./detail-column";

/**
 * Instant skeleton for a single job.
 *
 * Without this file the route inherited `../loading.tsx` — the jobs LIST skeleton, a filter chip
 * row over a six-column table — which is not the shape of anything on this page. The job view is a
 * full-height log surface: a status header bar, the streamed log column, and the job's facts under
 * it. It breaks out of the shell padding with the same negative margins the page uses, so the swap
 * does not shift.
 *
 * IT IMPORTS THE PAGE'S COLUMN WIDTH RATHER THAN REPEATING IT. RUBRIC.md's S3 asks whether the
 * skeleton is the same width as the page, and the first version of this file answered yes by
 * hard-coding the layout the page had that day — which is an answer that goes stale silently the
 * next time the page moves. One literal, two importers (`detail-column.ts`), and the predicate
 * cannot be passed by a skeleton that is no longer the page's shape.
 */
export default function JobDetailLoading() {
	return (
		<div className={`-m-4 flex flex-col sm:-m-6 lg:-m-8 xl:-m-10 ${JOB_VIEWPORT_HEIGHT}`}>
			{/* Status header — icon, status pill + meta, and the action buttons. */}
			<div className="shrink-0 border-b border-border/40 bg-muted/5 px-6 py-4">
				<div className={JOB_DETAIL_COLUMN}>
					<div className="flex items-start gap-3">
						<Skeleton className="mt-0.5 size-5 shrink-0 rounded-sm" />
						<div className="min-w-0 flex-1 space-y-2">
							<div className="flex flex-wrap items-center gap-2">
								<Skeleton className="h-4 w-20 rounded-full" />
								<Skeleton className="h-3 w-12" />
								<Skeleton className="h-3 w-16" />
								<Skeleton className="h-3 w-28" />
							</div>
						</div>
						<Skeleton className="h-8 w-24 shrink-0 rounded-md" />
					</div>
				</div>
			</div>

			{/* Log column — line number, timestamp, message, at decreasing fill. Full width, like
			    the pane it stands in for: it is the one region that does not obey the column above. */}
			<div className="flex-1 space-y-1.5 overflow-hidden bg-muted/20 p-6">
				{["w-3/4", "w-2/3", "w-5/6", "w-1/2", "w-4/6", "w-3/5", "w-2/5", "w-3/4"].map(
					(w, i) => (
						<div key={i} className="flex gap-4">
							<Skeleton className="h-3 w-8 shrink-0" />
							<Skeleton className="h-3 w-[85px] shrink-0" />
							<Skeleton className={`h-3 ${w}`} />
						</div>
					),
				)}
			</div>

			{/* The collapsed detail sections, back inside the column. */}
			<div className="shrink-0 border-t border-border/40 px-6">
				<div className={JOB_DETAIL_COLUMN}>
					{/* `py-2.5` and a 22px row box, because that is what the page's own rows measure:
					    `SectionHeading` is `py-2.5` over an `h2` at `--text-ui-lg` (15px). The first
					    version of this block was `py-3` over a bare `h-3.5`, four pixels short per row
					    — three rows of it and the swap visibly jumps. */}
					{["w-24", "w-32", "w-40"].map((w) => (
						<div key={w} className="flex h-[22px] items-center gap-2 border-b border-border/40 py-2.5 box-content last:border-b-0">
							<Skeleton className="size-3 shrink-0" />
							<Skeleton className={`h-3.5 ${w}`} />
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
