"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@repo/ui/empty";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { LifeBuoy, SearchX } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { listMyCases } from "@/app/server/actions/support";
import { ErrorState } from "@/components/errors/error-state";
import {
	caseFacetOptions,
	DEFAULT_SUPPORT_CASE_FILTERS,
	matchesSupportCaseQuery,
	normalizeSupportCaseQuery,
	serverFilterForBucket,
	type SupportCaseFilters,
} from "@/components/support/cases/case-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { qk } from "@/lib/query/keys";
import type { CaseListItem as CaseListItemData } from "@/lib/queries/support";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useSupportFilters } from "@/lib/stores/use-support-filters";
import {
	SUPPORT_CASE_TYPE_LABELS,
	SUPPORT_SEVERITY_LABELS,
} from "@/lib/validations/support";
import { CaseFilterBar } from "./case-filter-bar";
import { CaseListItem } from "./case-list-item";

/**
 * The lifecycle bucket is the only filter the URL renames — `?status=active` reads better
 * than `?bucket=active`, and it is the param the old tab strip would have wanted.
 */
const PARAM_NAMES: Partial<Record<keyof SupportCaseFilters, string>> = {
	bucket: "status",
};

/** Stable empty result — see the note at its use site. */
const NO_ROWS: CaseListItemData[] = [];

/**
 * The support case list, on the console filter standard (lib/query/README.md →
 * "Server-side filters"): the URL-synced `useSupportFilters` store feeds a debounced,
 * normalized query into `qk.supportCases(bucket)` → `listMyCases`, and the search /
 * severity / type refinement runs as a pure predicate over the returned rows (see the
 * header of case-query.ts for why those three are client-side and the bucket is not).
 *
 * Result count lives in the page toolbar's pill, never as prose in the bar. When `seeAll`
 * (the caller holds manage_support) the list is the whole org's cases — the toolbar's line
 * says so and each foreign row shows its opener.
 */
export function CaseList({
	orgSlug,
	seeAll = false,
}: {
	orgSlug: string;
	seeAll?: boolean;
}) {
	const filters = useSupportFilters((s) => s.filters);
	const reset = useSupportFilters((s) => s.reset);
	useFilterUrlSync(useSupportFilters, DEFAULT_SUPPORT_CASE_FILTERS, PARAM_NAMES);

	// Only the DEBOUNCED search reaches the query, and the memo is keyed on the individual
	// filter fields rather than the `filters` object — that object gets a fresh identity on
	// every keystroke, which would re-derive (and re-filter) the whole list ahead of the
	// debounce it exists to wait for.
	const debouncedSearch = useDebouncedValue(filters.search);
	const query = useMemo(
		() =>
			normalizeSupportCaseQuery({
				bucket: filters.bucket,
				search: debouncedSearch,
				severity: filters.severity,
				type: filters.type,
			}),
		[filters.bucket, filters.severity, filters.type, debouncedSearch],
	);

	const { data, isPending, isPlaceholderData, isError, refetch } = useQuery({
		queryKey: qk.supportCases(query.bucket),
		queryFn: () => listMyCases(serverFilterForBucket(query.bucket)),
		placeholderData: keepPreviousData,
	});
	// A module-level empty array, not an inline `= []` default: a fresh literal on every
	// render would give the memos below a new dependency identity each time and defeat them.
	const rows = data ?? NO_ROWS;

	// Facet counts come off the bucket's rows BEFORE the client-side refinement, so an
	// option never disappears at the moment you select it.
	const severityOptions = useMemo(
		() => caseFacetOptions(rows, "severity", SUPPORT_SEVERITY_LABELS),
		[rows],
	);
	const typeOptions = useMemo(
		() => caseFacetOptions(rows, "type", SUPPORT_CASE_TYPE_LABELS),
		[rows],
	);

	const visible = useMemo(
		() => rows.filter((row) => matchesSupportCaseQuery(row, query)),
		[rows, query],
	);

	const activeFilters = countActiveFilters<SupportCaseFilters>(
		filters,
		DEFAULT_SUPPORT_CASE_FILTERS,
	);

	return (
		<div className="space-y-4">
			<PageToolbar
				description={
					seeAll
						? "Every support case in this organization."
						: "Your support cases and their conversation threads."
				}
				count={isPending ? null : visible.length}
				actions={
					<Button
						size="sm"
						nativeButton={false}
						render={<Link href={`/${orgSlug}/~/support/submit`} />}
					>
						Submit a case
					</Button>
				}
			/>

			<CaseFilterBar
				severityOptions={severityOptions}
				typeOptions={typeOptions}
			/>

			{isError ? (
				// A fetch failure must not render as "no cases yet".
				<ErrorState
					title="Couldn't load your cases"
					description="Something went wrong fetching your support cases. Check your connection and try again."
					actions={
						<Button variant="outline" size="sm" onClick={() => refetch()}>
							Retry
						</Button>
					}
				/>
			) : visible.length === 0 && !isPending ? (
				// Two different empties: nothing to show at all, versus nothing that
				// survived the filters — conflating them is how a filtered list comes to
				// look broken.
				activeFilters > 0 ? (
					<Empty className="rounded-md border">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<SearchX />
							</EmptyMedia>
							<EmptyTitle>No cases match these filters</EmptyTitle>
							<EmptyDescription>
								Nothing in this view matches what you&apos;ve selected.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button variant="outline" size="sm" onClick={reset}>
								Reset filters
							</Button>
						</EmptyContent>
					</Empty>
				) : (
					<Empty className="rounded-md border">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<LifeBuoy />
							</EmptyMedia>
							<EmptyTitle>No cases yet</EmptyTitle>
							<EmptyDescription>
								When you open a support case it will appear here.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button
								size="sm"
								nativeButton={false}
								render={<Link href={`/${orgSlug}/~/support/submit`} />}
							>
								Submit a case
							</Button>
						</EmptyContent>
					</Empty>
				)
			) : (
				<div
					className={
						isPlaceholderData
							? "overflow-hidden rounded-md border opacity-60"
							: "overflow-hidden rounded-md border"
					}
				>
					{visible.map((item) => (
						<CaseListItem key={item.id} item={item} orgSlug={orgSlug} />
					))}
				</div>
			)}
		</div>
	);
}
