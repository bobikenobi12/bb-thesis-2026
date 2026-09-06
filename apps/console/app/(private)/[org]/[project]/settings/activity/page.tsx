// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { ActivityLog } from "@/components/settings/activity/activity-log";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Activity · Project settings",
	description: "Every change made to this project, who made it, and when.",
});

/** `/{org}/{project}/settings/activity` — Activity scoped to this project (project). Resolves
 * the project slug → project id and hands it to the shared feed, which forces the project filter. */
export default async function ProjectActivityPage({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { project } = await params;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}
	return <ActivityLog projectId={projectId} />;
}
