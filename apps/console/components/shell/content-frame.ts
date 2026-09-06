// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The console's ONE content width, written once and read by the shells.
 *
 * RUBRIC.md S2 is "exactly one max-width governs the content, and it comes from the shell". Before
 * this constant existed neither `AppShell` nor `ProjectShell` declared a width at all, so ten pages
 * ran edge-to-edge on a wide monitor and five others each hand-rolled a number of their own
 * (`max-w-[1360px]`, `max-w-[1200px]`, `max-w-4xl`, `max-w-5xl`, `max-w-[920px]`). Those numbers are
 * deleted; this is what replaces them.
 *
 * **1200px is not a new number.** `SettingsShell` and `SupportShell` already centre their column at
 * exactly this width, and both live outside this unit's scope, so adopting their value is what makes
 * the four shells agree rather than adding a fifth opinion. A page that re-declares it is an S4
 * failure precisely because the shell above it already owns it.
 *
 * `min-w-0` is load-bearing next to `w-full`: without it a flex/grid child holding a wide table sets
 * its own min-content width and the frame stops constraining anything.
 */
export const CONTENT_FRAME = "mx-auto w-full min-w-0 max-w-[1200px]";
