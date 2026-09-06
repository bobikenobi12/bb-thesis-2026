// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The box `@repo/ui/empty`'s `EmptyState` sits in inside the Artifacts library.
 *
 * NOT a density tuning — this is the one thing it does not do, and it is the opposite of
 * `PANEL_EMPTY`/`KNOWLEDGE_EMPTY`, which exist to SHRINK the type and padding for a side panel.
 * The scale here stays the shared page default (`p-6 md:p-12` around a `text-lg` headline)
 * because the library IS a page-sized region. What is local is the frame: the shared component
 * ships `border-dashed` with no border WIDTH, so a caller opts in with `border`, and the 420px
 * column stops the description running the width of a three-column grid.
 *
 * It lives in its own module for the reason `panel-empty.ts` does: the gallery imports the
 * viewer, so exporting it from `agent-artifact-gallery.tsx` would make the import cycle. One
 * string, two readers, and the library's four empty states — the gallery's loading, shared-tab
 * and no-artifacts states plus the viewer's no-widgets state — cannot drift into four different
 * column widths or disagree about whether the box is drawn.
 */
export const GALLERY_EMPTY = "mx-auto max-w-[420px] border border-border";
