"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@repo/ui/breadcrumb";
import { JOB_TYPES } from "@/components/jobs/columns";
import { buildCrumbs } from "@/components/shell/breadcrumb-trail";
import { useJobsQuery } from "@/lib/query/use-jobs-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useCallback, useMemo } from "react";

/**
 * Branding + route-aware breadcrumb bar for the dashboard header.
 *
 * The trail itself is `components/shell/breadcrumb-trail.ts` — a pure function, so the set of URLs
 * this bar links to can be swept against the console's real route set without rendering React
 * (#3805 R6: the `cases` crumb linked to a path that is not a route, and Next prefetched the 404).
 */
export function HeaderBreadcrumbs() {
	const pathname = usePathname();
	const { data: jobs = [] } = useJobsQuery();

	const jobLabel = useCallback(
		(id: string) => {
			const jobType = jobs.find((j) => j.id === id)?.job_type;
			return jobType ? JOB_TYPES[jobType]?.label : undefined;
		},
		[jobs],
	);

	const crumbs = useMemo(
		() => buildCrumbs(pathname, jobLabel),
		[pathname, jobLabel],
	);

	// On /dashboard there are no route crumbs — the bar is just "[·] / Org".
	if (crumbs.length === 0) return null;

	// `min-w-0` on both the nav and the list: the topbar gives the trail its own grid track, and a
	// track can only be narrower than the trail if every box between the track and the truncating
	// crumb is allowed to shrink below its content. Without these two the `truncate` on each crumb
	// never fires and the trail pushes its own track wider than the space the header has left.
	return (
		<Breadcrumb className="min-w-0">
			<BreadcrumbList className="min-w-0 flex-nowrap">
				{/* Separators sit between crumbs only — no leading chevron. */}
				{crumbs.map((crumb, i) => (
					<Fragment key={crumb.href ?? crumb.label}>
						{i > 0 && <BreadcrumbSeparator />}
						<BreadcrumbItem className="min-w-0">
							{i < crumbs.length - 1 && crumb.href ? (
								<BreadcrumbLink
									render={
										<Link
											href={crumb.href}
											className="truncate max-w-[120px] sm:max-w-[180px]"
										/>
									}
								>
									{crumb.label}
								</BreadcrumbLink>
							) : (
								<BreadcrumbPage className="truncate max-w-[120px] sm:max-w-[180px]">
									{crumb.label}
								</BreadcrumbPage>
							)}
						</BreadcrumbItem>
					</Fragment>
				))}
			</BreadcrumbList>
		</Breadcrumb>
	);
}
