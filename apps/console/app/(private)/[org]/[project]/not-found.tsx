"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The boundary scoped to the PROJECT segment. Before #3880 every `[project]/**` route resolved to
// `[org]/not-found.tsx` and a bad project slug answered "Organization not found… or you don't have
// access", naming a resource that is plainly fine. This sits in the `[project]` segment, so it
// covers the throw each page makes when `resolveProjectId` fails — and it renders inside AppShell
// (the org resolved) but outside ProjectShell (there is no project to hang the dock on).
//
// Non-leaky like the org one: a project that never existed and a project belonging to another org
// read the same — we never disclose existence.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ErrorState } from "@/components/errors/error-state";
import { orgHref } from "@/lib/routing";
import { Button } from "@repo/ui/button";

export default function ProjectNotFound() {
	// `/{org}/{project}/…` — the org segment resolved, so the way back is its project list.
	const org = usePathname().split("/").filter(Boolean)[0];
	return (
		<ErrorState
			code="404"
			title="Project not found"
			description="This project doesn't exist, or you don't have access to it."
			actions={
				<Button
					size="sm"
					nativeButton={false}
					render={<Link href={org ? orgHref(org) : "/"} />}
				>
					All projects
				</Button>
			}
		/>
	);
}
