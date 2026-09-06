"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connectors board's filter bar. It replaces a Radix <Select> — the one control
// lib/query/README.md explicitly bans from a filter bar — with the shared visual grammar:
// FilterSearch for free text, FilterChipGroup for the low-cardinality status axis (seeing
// every bucket at once is the point), FacetFilter for the seven presentation groups, and
// MultiCombobox for the long, searchable vendor list. Counts come from the UNFILTERED
// universe, so an option never vanishes as you select it.
//
// State lives in the page's URL-synced zustand store; this component is presentational.

import { Building2, Layers } from "lucide-react";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterChipGroup } from "@repo/ui/filter-chip";
import { FilterSearch } from "@repo/ui/filter-search";
import { FacetFilter } from "@repo/ui/facet-filter";
import { MultiCombobox } from "@repo/ui/multi-combobox";
import {
	DEFAULT_CONNECTOR_FILTERS,
	type ConnectorFacets,
	type ConnectorFilters,
} from "@/components/connectors/connectors-query";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useConnectorFilters } from "@/lib/stores/use-connector-filters";

/** Toggle one value in a selection array. */
function toggled(selection: string[], value: string): string[] {
	return selection.includes(value)
		? selection.filter((v) => v !== value)
		: [...selection, value];
}

/**
 * The connectors filter bar. `facets` carries each option's count over the unfiltered
 * catalog; `end` is the page-level slot (the view toggle and the docs link).
 */
export function ConnectorsFilterBar({
	facets,
	end,
}: {
	facets: ConnectorFacets;
	end?: React.ReactNode;
}) {
	const filters = useConnectorFilters((s) => s.filters);
	const set = useConnectorFilters((s) => s.set);
	const reset = useConnectorFilters((s) => s.reset);

	return (
		<FilterBar end={end}>
			<FilterSearch
				value={filters.search}
				onChange={(v) => set("search", v)}
				placeholder="Filter connectors…"
				// "Search connectors" — the ACCESSIBLE NAME is the stable e2e hook, and the four
				// connector specs target it. Placeholder copy is presentation and moves with the
				// filter standard; the a11y name must not, or a copy edit silently reds the gating
				// hero path (which is exactly what happened here). Same split as
				// support/cases/case-filter-bar.tsx and jobs-client.tsx, which kept a `Search <noun>`
				// ariaLabel when their placeholder became `Filter …`.
				ariaLabel="Search connectors"
				className="w-[200px] max-w-[320px] flex-1"
			/>

			{/* `title` is deliberately omitted: FilterChipGroup renders it as a stacked mono
			    header, which is a popover treatment. Inline in a bar the chips speak for
			    themselves. */}
			<FilterChipGroup
				inline
				options={facets.health}
				selected={filters.health}
				onToggle={(value) => set("health", toggled(filters.health, value))}
				render={(opt) => (
					<>
						{opt.label}
						<span className="font-mono text-ui-2xs opacity-60">{opt.count}</span>
					</>
				)}
			/>

			<FacetFilter
				label="Group"
				icon={Layers}
				options={facets.groups.map((o) => ({
					value: o.value,
					label: o.label,
					hint: String(o.count),
				}))}
				value={filters.groups}
				onChange={(next) => set("groups", next)}
				searchPlaceholder="Search groups…"
				emptyText="No groups."
			/>

			<MultiCombobox
				options={facets.vendors.map((o) => ({
					value: o.value,
					label: o.label,
					hint: String(o.count),
				}))}
				value={filters.vendors}
				onChange={(next) => set("vendors", next)}
				placeholder="All vendors"
				icon={Building2}
			/>

			<FilterBarReset
				count={countActiveFilters<ConnectorFilters>(
					filters,
					DEFAULT_CONNECTOR_FILTERS,
				)}
				onReset={reset}
			/>
		</FilterBar>
	);
}
