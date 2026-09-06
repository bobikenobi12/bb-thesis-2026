// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/**
 * Instant skeleton for the support landing hub. It models all three of the page's bands — the
 * centred question over the four entry-point cards, the bordered "See what's new" strip, and the
 * knowledge-base topic grid — because a skeleton that stops after the first band tells the reader
 * the page is one band tall and then reflows the whole route under them. It takes its width from
 * `SupportShell`, exactly as the page does, and adds none of its own.
 */
export default function SupportLoading() {
	return (
		<div className="pb-4">
			{/* The question, then the 2x2 entry-point grid. */}
			<div className="pt-12 pb-14">
				{/* `mx-auto` sits on the flex row, never in a class list that also carries a
				    `max-w-*`: that pairing is what `check:route-states` reads as the page
				    declaring its own content width, and this skeleton's width is the shell's. */}
				<div className="mb-10 flex justify-center">
					<Skeleton className="h-9 w-[340px] max-w-full" />
				</div>
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					{Array.from({ length: 4 }, (_, i) => (
						<Skeleton key={i} className="h-40 w-full rounded-xl" />
					))}
				</div>
			</div>

			{/* "See what's new" — a bordered band with a heading, a line of copy and three chips. */}
			<div className="border-y bg-muted/20">
				<div className="space-y-6 py-12">
					<div className="space-y-3">
						<Skeleton className="h-7 w-52" />
						<Skeleton className="h-4 w-80 max-w-full" />
					</div>
					<div className="flex flex-wrap gap-3">
						{Array.from({ length: 3 }, (_, i) => (
							<Skeleton key={i} className="h-9 w-40 rounded-md" />
						))}
					</div>
				</div>
			</div>

			{/* "Browse by topic" — the bordered grid of six topic columns, five links each. */}
			<div className="py-4">
				<div className="mb-8 space-y-2">
					<Skeleton className="h-5 w-32 rounded-full" />
					<Skeleton className="h-7 w-48" />
					<Skeleton className="h-4 w-80 max-w-full" />
				</div>
				<div className="grid grid-cols-1 border-t border-l sm:grid-cols-2 lg:grid-cols-3">
					{Array.from({ length: 6 }, (_, column) => (
						<div key={column} className="border-r border-b p-6">
							<Skeleton className="mb-4 h-4 w-32" />
							<div className="flex flex-col gap-2.5">
								{Array.from({ length: 5 }, (_, row) => (
									<Skeleton key={row} className="h-4 w-36" />
								))}
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
