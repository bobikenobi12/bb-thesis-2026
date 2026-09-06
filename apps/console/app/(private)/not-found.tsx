// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE ORG 404 — AND WHY IT LIVES AT `(private)` RATHER THAN AT `[org]`.
//
// `[org]/layout.tsx` resolves the `{org}` slug and calls notFound() when it does not resolve. A
// segment's own `not-found.tsx` is handed to the LayoutRouter for that segment's CHILDREN slot
// (`next/dist/server/app-render/create-component-tree.js` — `notFoundElement` is passed only when
// `isChildrenRouteKey`), so it mounts INSIDE that segment's layout and cannot catch a throw from
// the layout itself. `[org]/not-found.tsx` therefore never saw the org's own failure: the throw
// unwound past it to `app/not-found.tsx`, and a bad org slug rendered the generic "Page not found"
// on all 38 routes beneath this layout (#3891, the same mechanism as #3880 one level down).
//
// The only boundary that can catch it sits at a segment STRICTLY ABOVE `[org]`, and `(private)` is
// that segment. A route group is a real layer of the loader tree — `next-app-loader` resolves the
// whole of FILE_TYPES, `not-found` included, from every layer's own directory — so this file needs
// no renames anywhere and no page below it has to learn to guard. The layout keeps throwing, which
// is what keeps the response a real HTTP 404 rather than a 200 with not-found content.
//
// `(private)/layout.tsx` returns its children bare, so this renders full-page. That is right: the
// org did not resolve, so there is no id to render the dashboard chrome with.
//
// Copy is deliberately non-leaky: an unknown org and a forbidden org read the same — we never
// disclose existence. Nothing else under `(private)` calls notFound() outside `[org]` today, and
// `scripts/check-route-states.mjs` reports any layout that starts to.

import Link from "next/link";
import { ErrorState } from "@/components/errors/error-state";
import { Button } from "@repo/ui/button";

/** The 404 for an org slug that does not resolve — the boundary above `[org]/layout.tsx`. */
export default function PrivateNotFound() {
	return (
		<ErrorState
			fullPage
			code="404"
			title="Organization not found"
			description="This organization doesn't exist, or you don't have access to it."
			actions={
				<Button size="sm" nativeButton={false} render={<Link href="/" />}>
					Go home
				</Button>
			}
		/>
	);
}
