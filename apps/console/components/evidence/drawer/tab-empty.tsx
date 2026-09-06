// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shared per-tab empty state of the evidence drawer — every tab is always
// rendered, so a tab without data explains what's missing and how it comes to exist
// (never a silently blank sheet).
//
// Composed from the `@repo/ui/empty` PARTS rather than the one-call `EmptyState`, which is
// what that module documents for a different arrangement: this state lives in a 560px drawer,
// carries a "Learn more →" docs affordance alongside its optional action, and wants a tighter
// type scale than a full-page state. The parts give it the shared structure and slots without
// pretending the page-level sizing fits.

import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@repo/ui/empty";
import { EvIcon, type IconKey } from "../evidence-status";

/** A purposeful empty state for one drawer tab: icon, headline, one honest sentence, and a
 * "Learn more →" docs link so the term is never a dead-end. */
export function TabEmpty({
	icon,
	title,
	description,
	docsHref,
	action,
}: {
	icon: IconKey;
	title: string;
	description: string;
	/** Docs link explaining the concept (renders a "Learn more →" affordance). */
	docsHref?: string;
	action?: React.ReactNode;
}) {
	return (
		<Empty className="gap-3 rounded-md border border-dashed px-6 py-10 md:p-10">
			<EmptyHeader className="gap-1">
				<EmptyMedia className="mb-1.5 text-text-tertiary">
					<EvIcon name={icon} size={20} />
				</EmptyMedia>
				<EmptyTitle className="text-ui-md font-medium text-text-primary">
					{title}
				</EmptyTitle>
				<EmptyDescription className="max-w-[40ch] text-ui-sm leading-relaxed text-text-tertiary">
					{description}
				</EmptyDescription>
			</EmptyHeader>
			{(docsHref || action) && (
				<EmptyContent className="gap-3">
					{docsHref && (
						<a
							href={docsHref}
							className="inline-flex items-center gap-1 border-b border-border-strong pb-0.5 font-mono text-ui-xs text-text-secondary transition-colors hover:border-text-primary hover:text-text-primary"
						>
							Learn more
							<EvIcon name="arrow-right" size={11} />
						</a>
					)}
					{action}
				</EmptyContent>
			)}
		</Empty>
	);
}
