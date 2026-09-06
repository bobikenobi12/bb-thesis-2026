"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The "My cases" filter bar — search, the lifecycle bucket chips, the severity and type
// facets, and the mono reset. One language with the evidence bar
// (components/evidence/evidence-filter-bar.tsx, the reference implementation): every control
// is a @repo/ui filter primitive, filter state lives in the page's URL-synced zustand store,
// and no result-count prose appears here — the count belongs in the page toolbar's pill.
//
// The bucket group is a FilterChipGroup used as a RADIO, not a multi-select: three
// always-visible options where seeing all of them at once is the point, and "All" is the
// off state (which is why re-clicking the live chip is a no-op rather than a deselect).
// It replaces the `Tabs` strip this page used to drive its filtering with — tabs navigate,
// chips filter, and the standard's grammar is chips.

import { AlertTriangle, Tag } from "lucide-react";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterChipGroup } from "@repo/ui/filter-chip";
import { FilterSearch } from "@repo/ui/filter-search";
import {
	CASE_BUCKET_LABELS,
	CASE_BUCKETS,
	type CaseFacetOption,
	DEFAULT_SUPPORT_CASE_FILTERS,
	type SupportCaseFilters,
} from "@/components/support/cases/case-query";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useSupportFilters } from "@/lib/stores/use-support-filters";

/** The bucket chips, in lifecycle order. Static — the buckets are a closed set. */
const BUCKET_OPTIONS = CASE_BUCKETS.map((value) => ({
	value,
	label: CASE_BUCKET_LABELS[value],
}));

/** A facet's options carrying their row counts in the muted right-hand `hint` slot. */
function withCounts(options: CaseFacetOption[]) {
	return options.map((o) => ({
		value: o.value,
		label: o.label,
		hint: String(o.count),
	}));
}

/**
 * The case-list filter bar. `severityOptions` / `typeOptions` are computed over the
 * unfiltered rows of the current bucket so an option never vanishes as it is selected.
 */
export function CaseFilterBar({
	severityOptions,
	typeOptions,
}: {
	severityOptions: CaseFacetOption[];
	typeOptions: CaseFacetOption[];
}) {
	const filters = useSupportFilters((s) => s.filters);
	const set = useSupportFilters((s) => s.set);
	const reset = useSupportFilters((s) => s.reset);

	return (
		<FilterBar>
			<FilterSearch
				value={filters.search}
				onChange={(v) => set("search", v)}
				placeholder="Filter by case number or subject…"
				ariaLabel="Search cases"
				className="w-[240px] max-w-[380px] flex-1"
			/>
			<FilterChipGroup
				inline
				options={BUCKET_OPTIONS}
				selected={[filters.bucket]}
				onToggle={(value) => set("bucket", value)}
			/>
			<FacetFilter
				label="Severity"
				icon={AlertTriangle}
				options={withCounts(severityOptions)}
				value={filters.severity}
				onChange={(next) => set("severity", next)}
				searchPlaceholder="Search severity…"
			/>
			<FacetFilter
				label="Type"
				icon={Tag}
				options={withCounts(typeOptions)}
				value={filters.type}
				onChange={(next) => set("type", next)}
				searchPlaceholder="Search type…"
			/>
			<FilterBarReset
				count={countActiveFilters<SupportCaseFilters>(
					filters,
					DEFAULT_SUPPORT_CASE_FILTERS,
				)}
				onReset={reset}
			/>
		</FilterBar>
	);
}
