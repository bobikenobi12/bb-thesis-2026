// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Density tuning for `@repo/ui/empty`'s `EmptyState` inside an overview card.
 *
 * The shared component is sized for a page — `p-6 md:p-12` around a `text-lg` headline — and the
 * overview's cards are a third of a column with a 50px header strip above them. `md:` is a
 * VIEWPORT breakpoint, so a card on a desktop would take 48px of padding for a line of text that
 * says "No jobs yet"; the paddings are therefore restated at `md:` as well, which is the only way
 * to beat a variant with a base utility.
 *
 * The structure and the words stay shared and only the scale is local, which is the difference
 * between tuning a component and forking one. The type is the mono muted rung both cards already
 * typeset their nothing-here line at, so the alerts card and the recent-jobs card — which sit side
 * by side on one page — cannot answer "there is nothing here" in two different voices.
 *
 * It lives in its own module rather than in either card because both read it, and a constant
 * exported from one sibling and imported by the other is how two cards end up with one owning the
 * other's styling.
 */
export const CARD_EMPTY =
	"gap-2.5 px-4 py-8 md:px-4 md:py-8 [&_[data-slot=empty-title]]:font-mono [&_[data-slot=empty-title]]:text-ui-xs [&_[data-slot=empty-title]]:font-normal [&_[data-slot=empty-title]]:text-muted-foreground [&_[data-slot=empty-description]]:text-ui-xs";
