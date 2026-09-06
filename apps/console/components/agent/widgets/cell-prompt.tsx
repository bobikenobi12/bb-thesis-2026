"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CornerDownLeft } from "lucide-react";
import { useState } from "react";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";

/**
 * The empty-cell inline composer: click a blank cell → describe what goes there.
 * Enter submits (staged as a cell-targeted chat request the conversation dispatches —
 * the agent answers with ONE read tool + `pin_widget` at these coordinates); Esc
 * cancels. Rendered inside the CSS grid at the clicked cell.
 */
export function CellPrompt({
	cell,
}: {
	cell: { x: number; y: number; span: number };
}) {
	const submit = useWidgetGridStore((s) => s.submitCellPrompt);
	const cancel = useWidgetGridStore((s) => s.setCellPrompt);
	const [text, setText] = useState("");

	return (
		<div
			data-testid="cell-prompt"
			style={{
				// `span` is the real number of free columns to the right (1–2), so the
				// composer never overlaps a neighbouring widget.
				gridColumn: `${cell.x + 1} / span ${cell.span}`,
				gridRow: `${cell.y + 1} / span 1`,
			}}
			className="flex items-center gap-1.5 border border-dashed border-foreground/60 bg-background px-2"
		>
			<input
				// The composer exists only after an intentional cell click — focus belongs here.
				// eslint-disable-next-line jsx-a11y/no-autofocus
				autoFocus
				value={text}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						submit(text);
					} else if (e.key === "Escape") {
						e.preventDefault();
						cancel(null);
					}
				}}
				onBlur={() => {
					if (!text.trim()) cancel(null);
				}}
				placeholder="Describe what goes here…"
				aria-label={`Describe the widget for row ${cell.y + 1}, column ${cell.x + 1}`}
				className="min-w-0 flex-1 bg-transparent text-ui-sm text-foreground outline-none placeholder:text-muted-foreground"
			/>
			<CornerDownLeft className="h-3 w-3 flex-none text-muted-foreground" />
		</div>
	);
}
