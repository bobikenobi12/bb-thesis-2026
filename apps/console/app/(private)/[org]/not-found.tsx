// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// WHAT REACHES THIS FILE, AND WHAT DOES NOT.
//
// It used to say "the org layout calls notFound() before AppShell renders, so this shows
// full-page". The first clause was true and was precisely why the second was false: this boundary
// mounts inside `[org]/layout.tsx` (Next hands a segment's not-found.tsx to the LayoutRouter for
// that segment's CHILDREN slot), so a throw FROM that layout escapes it. The org's own failure
// never arrived here; it is answered by `(private)/not-found.tsx`, one segment up — see the
// mechanism written out there.
//
// What does arrive here is a notFound() thrown BELOW this layout by a route that has no nearer
// boundary of its own: a project slug that does not resolve, a support case id that does not
// exist. The org resolved for all of those, so this renders INSIDE AppShell and `fullPage` is the
// wrong variant — it would paint a min-h-screen centred panel inside the dashboard chrome. The
// compact in-content ErrorState is the right one.
//
// The copy is resource-neutral for the same reason. It is a fallback for whatever below `[org]`
// has not been given its own not-found.tsx yet; naming the organization here told the user the
// wrong thing about a missing project. A segment that wants to name its resource adds its own
// boundary beside its page (`scripts/check-route-states.mjs`, predicate T3), and takes precedence
// over this one.
//
// Still non-leaky: absent and forbidden read the same — we never disclose existence.

import Link from "next/link";
import { ErrorState } from "@/components/errors/error-state";
import { Button } from "@repo/ui/button";

/** The in-shell 404 for anything under a RESOLVED org that has no nearer not-found boundary. */
export default function OrgNotFound() {
	return (
		<ErrorState
			code="404"
			title="Not found"
			description="This page doesn't exist, or you don't have access to it."
			actions={
				<Button size="sm" nativeButton={false} render={<Link href="/" />}>
					Go home
				</Button>
			}
		/>
	);
}
