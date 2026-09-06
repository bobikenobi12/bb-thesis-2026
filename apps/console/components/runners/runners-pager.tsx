"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

/** Minimal client-side pager for the runner-card grid: result count + page stepper.
 *  Renders nothing when everything fits on one page. */
export function RunnersPager({
	page,
	pageCount,
	total,
	onPageChange,
}: {
	page: number;
	pageCount: number;
	total: number;
	onPageChange: (page: number) => void;
}) {
	if (pageCount <= 1) {
		return (
			<div className="font-mono text-ui-2xs uppercase tracking-[0.08em] text-muted-foreground">
				{total} runner{total !== 1 ? "s" : ""}
			</div>
		);
	}

	return (
		<div className="flex items-center justify-between gap-3">
			<span className="font-mono text-ui-2xs uppercase tracking-[0.08em] text-muted-foreground">
				{total} runner{total !== 1 ? "s" : ""}
			</span>
			<div className="flex items-center gap-2">
				<Button
					variant="outline"
					size="icon"
					className="h-7 w-7"
					disabled={page <= 1}
					onClick={() => onPageChange(page - 1)}
					aria-label="Previous page"
				>
					<ChevronLeft className="h-4 w-4" />
				</Button>
				<span className="font-mono text-ui-xs tabular-nums text-muted-foreground">
					{page} / {pageCount}
				</span>
				<Button
					variant="outline"
					size="icon"
					className="h-7 w-7"
					disabled={page >= pageCount}
					onClick={() => onPageChange(page + 1)}
					aria-label="Next page"
				>
					<ChevronRight className="h-4 w-4" />
				</Button>
			</div>
		</div>
	);
}
