// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The two type ladders `packages/brand/src/tokens.css` defines, taught to tailwind-merge as FONT
 * SIZES rather than left to its default reading of them.
 *
 * WHAT WENT WRONG. `text-` is an ambiguous prefix: it introduces both a size (`text-sm`) and a
 * colour (`text-foreground`). tailwind-merge resolves an unknown `text-<x>` as a COLOUR, so
 * `text-ui-xs` and `text-display-lg` landed in the colour group — and a class group only ever
 * keeps its LAST member. Measured on tailwind-merge 3.6.0:
 *
 *     cn("text-ui-xs", "text-foreground")   →  "text-foreground"       the RUNG is deleted
 *     cn("text-foreground", "text-ui-xs")   →  "text-ui-xs"            the COLOUR is deleted
 *     cn("text-display-xs", "text-primary") →  "text-primary"          both ladders, both ways
 *
 * Both directions are silent, and which one you get depends on argument order — so the same pair
 * of classes renders at the wrong size in one component and in the wrong colour in another.
 *
 * THE CONVERSION CAUSED IT. `text-[11px] text-foreground` survives this merge untouched, because
 * an arbitrary value is unambiguously a size. So #3809's 458 conversions from `text-[Npx]` to the
 * rungs did not inherit a pre-existing bug — they introduced one, at 20 call sites on `dev` where
 * a rung shares a `cn()` with a colour. That is the shape worth remembering: a fix whose failure
 * mode is invisible in the diff that makes it.
 *
 * WHY A PREDICATE AND NOT A LIST. The obvious form is to enumerate the eleven rungs. A hand-typed
 * list of what a guard covers stops covering silently — the twelfth rung would be added to
 * tokens.css by someone who has never read this file, and its call sites would start losing their
 * colour with nothing to say so. `ui-` and `display-` are the two namespaces the ladders own, so
 * the predicate is the rule rather than a snapshot of it.
 *
 * The namespaces are safe to claim wholesale: Tailwind ships no colour named `ui-*` or
 * `display-*`, and this repo defines none — `pnpm -F @repo/ui test` pins that both ladders merge
 * as sizes and that ordinary colours still merge as colours.
 */
const isTypeLadderRung = (value: string) => /^(ui|display)-/.test(value);

const twMerge = extendTailwindMerge({
	extend: { classGroups: { "font-size": [{ text: [isTypeLadderRung] }] } },
});

/** Merge Tailwind class lists, de-duplicating conflicting utilities. */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
