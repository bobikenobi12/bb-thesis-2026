"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alerts hub's three filter bars, in the console's shared visual grammar
// (lib/query/README.md → "Server-side filters"): FilterBar is the row, FilterSearch the
// free-text input, FilterChipGroup the always-visible low-cardinality facets, FacetFilter
// the searchable popover for the transport list, MultiCombobox the entity list, and
// FilterBarReset the mono "Reset · N". No Select, and no "N of M" prose — result counts
// live in the count pill beside each section heading, rendered by alerts-page.tsx.
//
// These are presentational over the page's zustand stores, exactly as
// components/evidence/evidence-filter-bar.tsx is: facet options + counts arrive as props
// (computed over the UNFILTERED universe, so options never vanish as you select them) and
// the selections are read and written straight through the store.

import { Send, Webhook } from "lucide-react";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterChipGroup } from "@repo/ui/filter-chip";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterSearch } from "@repo/ui/filter-search";
import { MultiCombobox } from "@repo/ui/multi-combobox";
import {
	type ActivityFilters,
	type ChannelFilters,
	DEFAULT_ACTIVITY_FILTERS,
	DEFAULT_CHANNEL_FILTERS,
	DEFAULT_POLICY_FILTERS,
	type FacetCount,
	type PolicyFilters,
} from "@/components/alerts/alerts-query";
import type {
	ActivityView,
	ChannelsView,
	PoliciesView,
} from "@/components/alerts/alerts-filters";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import {
	useAlertActivityFilters,
	useAlertChannelFilters,
	useAlertPolicyFilters,
} from "@/lib/stores/use-alerts-filters";

/** Toggle one value in a selection array. */
function toggled(selection: string[], value: string): string[] {
	return selection.includes(value)
		? selection.filter((v) => v !== value)
		: [...selection, value];
}

/** A facet count rendered as the chip's trailing mono figure. */
function ChipLabel({ option }: { option: FacetCount }) {
	return (
		<>
			{option.label}
			<span className="font-mono text-ui-2xs opacity-60">{option.count}</span>
		</>
	);
}

/** Facet counts as the muted trailing `hint` FacetFilter / MultiCombobox rows reserve. */
function withCountHint(options: FacetCount[]) {
	return options.map((o) => ({
		value: o.value,
		label: o.label,
		hint: String(o.count),
	}));
}

/** Channels: free-text + the transport facet + the verification-state chips. */
export function ChannelsFilterBar({
	facets,
	action,
}: {
	facets: ChannelsView["facets"];
	/** The panel's primary action, right-aligned in the bar's `end` slot. */
	action?: React.ReactNode;
}) {
	const filters = useAlertChannelFilters((s) => s.filters);
	const set = useAlertChannelFilters((s) => s.set);
	const reset = useAlertChannelFilters((s) => s.reset);

	return (
		<FilterBar end={action}>
			<FilterSearch
				value={filters.search}
				onChange={(v) => set("search", v)}
				placeholder="Filter channels by name or transport…"
				className="w-[240px] max-w-[380px] flex-1"
			/>
			<FacetFilter
				label="Transport"
				icon={Webhook}
				options={withCountHint(facets.types)}
				value={filters.types}
				onChange={(next) => set("types", next)}
				searchPlaceholder="Search transports…"
				emptyText="No transports configured."
			/>
			<FilterChipGroup<FacetCount>
				options={facets.status}
				selected={filters.status}
				onToggle={(value) => set("status", toggled(filters.status, value))}
				render={(option) => <ChipLabel option={option} />}
				inline
			/>
			<FilterBarReset
				count={countActiveFilters<ChannelFilters>(
					filters,
					DEFAULT_CHANNEL_FILTERS,
				)}
				onReset={reset}
			/>
		</FilterBar>
	);
}

/** Policies: free-text + status/kind chips + the destination-channel combobox. */
export function PoliciesFilterBar({
	facets,
	action,
}: {
	facets: PoliciesView["facets"];
	/** The panel's primary action, right-aligned in the bar's `end` slot. */
	action?: React.ReactNode;
}) {
	const filters = useAlertPolicyFilters((s) => s.filters);
	const set = useAlertPolicyFilters((s) => s.set);
	const reset = useAlertPolicyFilters((s) => s.reset);

	return (
		<FilterBar end={action}>
			<FilterSearch
				value={filters.search}
				onChange={(v) => set("search", v)}
				placeholder="Filter policies by name or description…"
				className="w-[240px] max-w-[380px] flex-1"
			/>
			<FilterChipGroup<FacetCount>
				options={facets.status}
				selected={filters.status}
				onToggle={(value) => set("status", toggled(filters.status, value))}
				render={(option) => <ChipLabel option={option} />}
				inline
			/>
			<FilterChipGroup<FacetCount>
				options={facets.kinds}
				selected={filters.kinds}
				onToggle={(value) => set("kinds", toggled(filters.kinds, value))}
				render={(option) => <ChipLabel option={option} />}
				inline
			/>
			<MultiCombobox
				options={withCountHint(facets.channels)}
				value={filters.channels}
				onChange={(next) => set("channels", next)}
				placeholder="Any channel"
				icon={Send}
				className="w-[190px]"
			/>
			<FilterBarReset
				count={countActiveFilters<PolicyFilters>(filters, DEFAULT_POLICY_FILTERS)}
				onReset={reset}
			/>
		</FilterBar>
	);
}

/** Activity: free-text over the ledger + the delivery-status chips. */
export function ActivityFilterBar({ facets }: { facets: ActivityView["facets"] }) {
	const filters = useAlertActivityFilters((s) => s.filters);
	const set = useAlertActivityFilters((s) => s.set);
	const reset = useAlertActivityFilters((s) => s.reset);

	return (
		<FilterBar>
			<FilterSearch
				value={filters.search}
				onChange={(v) => set("search", v)}
				placeholder="Filter activity by title or event…"
				className="w-[240px] max-w-[380px] flex-1"
			/>
			<FilterChipGroup<FacetCount>
				options={facets.status}
				selected={filters.status}
				onToggle={(value) => set("status", toggled(filters.status, value))}
				render={(option) => <ChipLabel option={option} />}
				inline
			/>
			<FilterBarReset
				count={countActiveFilters<ActivityFilters>(
					filters,
					DEFAULT_ACTIVITY_FILTERS,
				)}
				onReset={reset}
			/>
		</FilterBar>
	);
}
