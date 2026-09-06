// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/* Reached from BOTH graphs: Next renders the default export as this segment's server-side
   loading boundary, and `page.tsx` — a client component — imports `CliLoginBodySkeleton` for
   its Suspense fallback. A module reached from both without a declared boundary is what threw
   "Element type is invalid … got: undefined" twice during this rollout (see the same note at
   the top of components/auth/auth-shell.tsx), so the boundary is declared rather than
   inferred. Everything here is static markup, so the cost is a few divs in the client bundle. */
"use client";

import { Skeleton } from "@repo/ui/skeleton";

/**
 * The card's body while the approval UI resolves — everything below the heading.
 *
 * `page.tsx` renders this as its Suspense fallback. `useSearchParams` forces a client bailout,
 * and the picture it falls back to must be the same one the route skeleton draws, or the reader
 * watches the card change shape twice on the way to a single screen. Exported rather than
 * duplicated, so the two cannot drift apart.
 *
 * It is the BODY and not the whole card because the heading is not suspended: `page.tsx` renders
 * it above the boundary, so a fallback that redrew it would stack a skeleton heading under a real
 * one.
 */
export function CliLoginBodySkeleton() {
	return (
		<div className="flex flex-col gap-6">
			{/* the prompt above the code */}
			<div className="flex flex-col items-center gap-2">
				<Skeleton className="h-4 w-60" />
				<Skeleton className="h-3 w-full" />
				<Skeleton className="h-3 w-4/5" />
			</div>

			{/* the device-code plate */}
			<Skeleton className="h-[60px] w-full rounded-none" />

			{/* "Approving gives that terminal …" — the consent block */}
			<div className="space-y-2 border border-border/60 px-4 py-3">
				<Skeleton className="h-3 w-40" />
				<Skeleton className="h-2.5 w-52" />
				<Skeleton className="h-2.5 w-56" />
				<Skeleton className="h-2.5 w-48" />
			</div>

			{/* approve · decline */}
			<div className="flex flex-col gap-2">
				<Skeleton className="h-9 w-full rounded-sm" />
				<Skeleton className="h-9 w-full rounded-sm" />
			</div>

			<Skeleton className="mx-auto h-3 w-64" />
		</div>
	);
}

/**
 * The route skeleton for `/cli/login`, and the route had none anywhere in its chain — nothing
 * above `app/(private)` owns a `loading.tsx`, so the person arriving from `alethia login` watched
 * a blank viewport until the bundle resolved.
 *
 * It renders INSIDE `layout.tsx`'s `AuthShell`/`AuthCard`, so it draws only the card's contents
 * and inherits the shell's width. That is what makes S3 answerable at all: a skeleton and a page
 * that resolve to the same max-width because neither of them declares one.
 */
export default function CliLoginLoading() {
	return (
		<>
			{/* eyebrow + heading */}
			<div className="mb-6 flex flex-col items-center gap-2.5">
				<Skeleton className="h-2.5 w-32" />
				<Skeleton className="h-6 w-48" />
			</div>
			<CliLoginBodySkeleton />
		</>
	);
}
