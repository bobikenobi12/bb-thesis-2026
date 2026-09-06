"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "@repo/ui/utils";
import type { ElenchSuggestion } from "./elench-suggestions";

/** How many suggestion cards show per carousel page. */
const CARDS_PER_PAGE = 3;
/** Total carousel pages (9 suggestions ÷ 3 cards). */
const PAGE_COUNT = 3;

/**
 * The paged suggestion carousel from the Elench landing — a windowed slice of three
 * cards, a right-hand button that cycles the page (0→1→2→0, pure slice swap, no scroll),
 * and dot indicators reflecting the active page (`aria-current`). Extracted so it can be
 * rendered/tested without the landing's composer + mention dependencies; `onSelect` is
 * fired with the picked suggestion's prompt when a card is clicked.
 */
export function SuggestionCarousel({
	suggestions,
	onSelect,
}: {
	suggestions: ElenchSuggestion[];
	onSelect: (prompt: string) => void;
}) {
	// The visible carousel page; the right-hand button cycles 0→1→2→0 (pure slice swap).
	const [page, setPage] = useState(0);
	const pageCards = suggestions.slice(
		page * CARDS_PER_PAGE,
		page * CARDS_PER_PAGE + CARDS_PER_PAGE,
	);
	return (
		<>
			{/* Paged suggestion carousel — a windowed slice of 3, a cycle button, and dot
				    indicators below (no horizontal scroll; the right button swaps pages). */}
			<div className="mt-4 flex gap-2.5">
				{pageCards.map((s) => (
					<button
						key={s.title}
						type="button"
						data-testid="elench-suggestion"
						onClick={() => onSelect(s.prompt)}
						className="flex min-w-0 flex-1 items-center gap-3 border border-border bg-muted/40 px-3 py-2.5 text-left transition-colors hover:bg-muted"
					>
						<span className="flex size-8 flex-none items-center justify-center border border-border bg-background text-muted-foreground">
							<s.icon className="h-4 w-4" />
						</span>
						<span className="min-w-0">
							<span className="block truncate text-ui-md font-medium text-foreground">
								{s.title}
							</span>
							<span className="block truncate text-xs text-muted-foreground">
								{s.sub}
							</span>
						</span>
					</button>
				))}
				<button
					type="button"
					aria-label="Next suggestions"
					onClick={() => setPage((p) => (p + 1) % PAGE_COUNT)}
					className="flex w-11 flex-none items-center justify-center border border-border bg-muted/40 text-muted-foreground transition-colors hover:bg-muted"
				>
					<ChevronRight className="h-4 w-4" />
				</button>
			</div>

			{/* Carousel page dots — active page filled, matching the DotDivider dot style. */}
			<div className="mt-3 flex justify-center gap-1.5">
				{Array.from({ length: PAGE_COUNT }, (_, i) => (
					<button
						key={i}
						type="button"
						aria-label={`Suggestions page ${i + 1}`}
						aria-current={i === page}
						onClick={() => setPage(i)}
						className={cn(
							"size-1 rounded-full transition-colors",
							i === page ? "bg-foreground" : "bg-border",
						)}
					/>
				))}
			</div>
		</>
	);
}
