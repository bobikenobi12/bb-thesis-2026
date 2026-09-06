// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The width the job view's PROSE obeys — and the one its log deliberately does not.
 *
 * This route is the console's one HYBRID page, and the split is a reading decision rather than a
 * styling one. Everything except the log is label/value pairs and sentences: a status line, the
 * job's facts, an error message, a config snapshot. Those are read left-to-right and a line of
 * them 1200px wide is a line the eye loses its place in. A log line is not read that way — it is
 * scanned for a token, it is monospaced, its length is decided by whatever the runner printed, and
 * every character of it wrapping onto a second line costs more than the width ever saved.
 *
 * So the log pane runs edge to edge and the rest of the page sits in this column, centred in it.
 *
 * HOW WIDE "EDGE TO EDGE" ACTUALLY IS, stated rather than left to be discovered. The page renders
 * inside `AppShell`'s `CONTENT_FRAME` (1200px) inside its `p-4 … p-10`. The page root's matching
 * negative margins cancel the PADDING, so the log spans 1200px + 2×40px at the widest rung — and
 * on a monitor wider than that it is centred with gutters, because no negative margin can cancel a
 * `max-w-*` whose overflow it cannot measure (`app-shell.tsx` says exactly this about its own
 * `ProjectShell` exception). Escaping the 1200px cap is a shell change, not a page change: it is
 * the exception `ProjectShell` has, it lives in `app-shell.tsx`, and that file is outside this
 * route's scope. What this column buys is therefore real but bounded — 896px of prose against
 * ~1280px of log, not against the viewport.
 *
 * IT LIVES IN ITS OWN MODULE FOR ONE REASON: `loading.tsx` must use the SAME width, and RUBRIC.md's
 * S3 ("the loading skeleton is the same width as the page") is the predicate that says so. A
 * skeleton that hard-codes a width the page has since changed swaps to a page of a different shape
 * and reports nothing — so there is one literal, imported by both, and the two cannot drift. It is
 * a `.ts` constant and not an export from `page.tsx` because `page.tsx` is `"use client"` and
 * `loading.tsx` is a server component; a module holding a React value and pulled into both graphs
 * is how this console last produced an "element type is undefined" on a page whose every child
 * rendered fine alone. A bare string is inert either way, and keeping it inert is the point.
 *
 * `max-w-4xl` (896px) and NOT the shell's 1200px: re-declaring a width a shell already owns is
 * RUBRIC.md's S4, whose fix is to delete the class. This is a genuinely narrower column, which is
 * the only honest way to have a second width on a page at all.
 */
export const JOB_DETAIL_COLUMN = "mx-auto w-full min-w-0 max-w-4xl";

/**
 * The height of the job view's frame — one screen, less the topbar.
 *
 * DERIVED, not guessed. `AppShell`'s root is `h-dvh` and `Topbar` is `h-[53px]`, so `<main>` is
 * exactly this tall. The string this replaces was `h-[calc(100vh-3.5rem)]`, which was wrong twice
 * and quietly: 3.5rem is 56px against a 53px topbar, and `100vh` against an `h-dvh` shell means the
 * pane keeps counting a mobile URL bar that the shell above it already stopped counting. Neither
 * shows as a scrollbar — the frame comes out SHORTER than its parent, so it just leaves a strip.
 *
 * Exported beside the column for the same reason the column is exported: `loading.tsx` needs the
 * identical value, and two copies of a viewport calculation drift the moment the topbar does.
 */
export const JOB_VIEWPORT_HEIGHT = "h-[calc(100dvh-53px)]";
