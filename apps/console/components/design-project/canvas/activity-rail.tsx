"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { StatusBadge } from "@repo/ui/status-badge";
import { getEnvironmentJobs } from "@/app/server/actions/canvas-jobs";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { ago, JOB_LABEL, JOB_STATUS } from "@/lib/canvas/job-display";
import { orgHref } from "@/lib/routing";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";

/**
 * The environment's activity — what has run against this board, and what's running now.
 *
 * The canvas showed a deploy's effects but never the deploy. A failed component said "Failed" with
 * no route to the job that failed it; a running apply looked identical to a settled one until you
 * reloaded. This is the missing half.
 */
export function ActivityRail({
	projectId,
	environmentId,
}: {
	projectId: string;
	environmentId: string;
}) {
	const orgSlug = useActiveOrgSlug();
	const env = useEnvironmentStatus();

	const { data: jobs } = useQuery({
		queryKey: ["environment-jobs", projectId, environmentId],
		queryFn: () => getEnvironmentJobs(projectId, environmentId),
		// Follow the environment: fast while something is running, a slow heartbeat once it settles.
		refetchInterval: env.activeJob ? 4_000 : 30_000,
	});

	if (!jobs || jobs.length === 0) return null;

	return (
		<div className="pointer-events-auto absolute left-3 top-3 z-10 w-56 border border-border bg-card">
			<div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
				<span className="vx-eyebrow">Activity</span>
				{env.activeJob && (
					<StatusBadge status="running" tier="live" className="ml-auto" />
				)}
			</div>

			<ul>
				{jobs.map((job) => {
					const vx = JOB_STATUS[job.status] ?? "idle";
					return (
						<li key={job.id}>
							<Link
								href={`${orgHref(orgSlug)}/~/jobs?job=${job.id}`}
								className="flex items-center gap-2 border-b border-border/60 px-2.5 py-1.5 transition-colors last:border-b-0 hover:bg-muted"
								// A failed job's reason is the most useful thing on this rail.
								title={job.error ?? job.status}
							>
								<StatusBadge
									status={job.status}
									tier={vx}
									showLabel={false}
									className="shrink-0"
									suppressHydrationWarning
								/>
								<span className="min-w-0 flex-1 truncate font-mono text-ui-2xs uppercase tracking-wide">
									{JOB_LABEL[job.type] ?? job.type}
								</span>
								<span className="shrink-0 font-mono text-ui-3xs text-muted-foreground">
									{ago(job.createdAt)}
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
