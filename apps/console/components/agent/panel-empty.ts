// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Density tuning for `@repo/ui/empty`'s `EmptyState` inside the artifact panel.
 *
 * The shared component is sized for a page: `p-6 md:p-12` and a `text-lg` headline. `md:` is a
 * VIEWPORT breakpoint, so a 340px side panel on a desktop still gets 48px of padding around a
 * headline wider than the column. The structure and semantics stay shared; only the scale is
 * local, which is the difference between tuning a component and forking one.
 *
 * It lives in its own module rather than in `artifact-panel.tsx` because the panel's TABS —
 * `build-pane` and `deploy-pane` — need the same scale, and the panel already imports both of
 * them: exporting it from there would make the import cycle. One string, three readers, no
 * cycle, and the three empty states of one panel cannot drift into three densities.
 */
export const PANEL_EMPTY =
	"gap-2 p-8 md:p-8 [&_[data-slot=empty-title]]:text-xs [&_[data-slot=empty-title]]:font-normal [&_[data-slot=empty-title]]:text-muted-foreground [&_[data-slot=empty-description]]:text-xs";
