// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

import { CountPill } from "./count-pill";
import { cn } from "./utils";

/**
 * A heading INSIDE a page — the thing that labels one section of it.
 *
 * A settings page with five sections still has to name them; it does not need five page titles.
 * That distinction is why this is its own component rather than a prop on the page toolbar: the
 * console lost its page TITLES (the sidebar entry and the breadcrumb already say the page's name
 * twice), and a section heading is a separate, smaller thing that survives untouched.
 *
 * `PageHeader`'s `level` prop used to be the answer here and it was the wrong one. It rendered
 * `text-lg font-medium` whatever the level, so a `<h2>` converted to it jumped from the
 * `text-[14.5px]`/`text-[15px]` the console actually typesets that rung at to 18px — which is how
 * the missing UI type scale was found at all.
 *
 * ONE SIZE FOR EVERY LEVEL, deliberately. `level` sets the tag, i.e. the document outline, and
 * nothing else: tying type scale to outline depth is how a heading gets picked for its looks. It
 * runs to `<h6>` for the reason `check-shared-surface` gives for reading that far — a ladder that
 * stopped at `<h3>` would be an instruction to demote.
 *
 * The rung is `--text-ui-lg` (15px) from `packages/brand/src/tokens.css`, which is the size the
 * console's own section headings already cluster at.
 */
function SectionHeading({
	title,
	description,
	count,
	actions,
	level = 2,
	className,
	...props
}: Omit<React.ComponentProps<"div">, "title"> & {
	/** The section's name. Rendered as the heading, so pass text or an inline node, not a block. */
	title: React.ReactNode;
	/** One line of supporting copy under the heading. Omit rather than restating the title. */
	description?: React.ReactNode;
	/** Result count for a filtered list; null/undefined while loading renders nothing. */
	count?: number | null;
	/** Buttons for this section. Right-aligned, and they wrap under the heading on narrow screens. */
	actions?: React.ReactNode;
	/** Heading level — the OUTLINE rung, never the size. `2` unless it nests under another. */
	level?: 2 | 3 | 4 | 5 | 6;
}) {
	const Heading = `h${level}` as const;
	return (
		<div
			data-slot="section-heading"
			className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2", className)}
			{...props}
		>
			<div className="flex min-w-0 flex-col gap-1">
				<div className="flex items-center gap-2">
					{/* `title` on the heading whenever the caller passed a plain string: the heading
					    truncates, and a support case's subject — where the text IS the section's
					    primary content — clipped with the full string recoverable nowhere on screen.
					    Screen readers already read it in full; `truncate` is CSS only. */}
					<Heading
						data-slot="section-heading-title"
						title={typeof title === "string" ? title : undefined}
						className="truncate text-ui-lg font-medium tracking-tight"
					>
						{title}
					</Heading>
					<CountPill count={count} />
				</div>
				{/* The body rung, not the 14px `text-sm` this used to be. See the note in
				    page-toolbar.tsx: it is a role choice, because 14px's own band is `--text-ui-lg`
				    — the rung of the heading directly above this line. */}
				{description ? (
					<p data-slot="section-heading-description" className="text-ui-md text-text-tertiary">
						{description}
					</p>
				) : null}
			</div>
			{actions ? (
				<div data-slot="section-heading-actions" className="flex shrink-0 items-center gap-2">
					{actions}
				</div>
			) : null}
		</div>
	);
}

export { SectionHeading };
