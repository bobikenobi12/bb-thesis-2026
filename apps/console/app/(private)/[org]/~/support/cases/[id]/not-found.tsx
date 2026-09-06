"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The other route whose notFound() resolved all the way up to `[org]/not-found.tsx`: a case id that
// is not visible to you answered "Organization not found", naming a resource that is plainly fine.
// `page.tsx` calls notFound() when `getCase` returns nothing; this is the boundary scoped to the
// case segment, and it renders inside SupportShell with the rest of the chrome intact.
//
// Non-leaky like the other two: a case that never existed and a case belonging to another org read
// the same.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { globalHref } from "@/lib/routing";
import { ErrorState } from "@/components/errors/error-state";
import { Button } from "@repo/ui/button";

export default function SupportCaseNotFound() {
	// `/{org}/~/support/cases/{id}` — the org segment resolved, so the way back is its case list.
	const org = usePathname().split("/").filter(Boolean)[0];
	return (
		<ErrorState
			code="404"
			title="Case not found"
			description="This support case doesn't exist, or you don't have access to it."
			actions={
				<Button
					size="sm"
					nativeButton={false}
					render={<Link href={org ? globalHref(org, "support/my-cases") : "/"} />}
				>
					My cases
				</Button>
			}
		/>
	);
}
