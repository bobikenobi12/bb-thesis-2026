"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	type CloudProviderSlug,
	REGION_LABELS,
} from "@/lib/cloud-providers";
import { groupRegions } from "@/lib/cloud-providers/region-groups";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";

interface RegionSelectProps {
	provider: CloudProviderSlug;
	value: string;
	onChange: (region: string) => void;
	disabled?: boolean;
}

/**
 * A grouped region picker for the chosen cloud — reads the generated `REGION_LABELS` catalog and
 * groups codes geographically via {@link groupRegions}. The create front door feeds the selection
 * into `CreateProjectInput.project.region`.
 */
export function RegionSelect({
	provider,
	value,
	onChange,
	disabled,
}: RegionSelectProps) {
	const groups = groupRegions(
		Object.keys(REGION_LABELS[provider] ?? {}),
		provider,
	);

	return (
		<Select value={value} onValueChange={onChange} disabled={disabled}>
			<SelectTrigger className="w-full max-w-[280px]">
				<SelectValue placeholder="Select a region" />
			</SelectTrigger>
			<SelectContent>
				{groups.map((g) => (
					<SelectGroup key={g.group}>
						<SelectLabel>{g.group}</SelectLabel>
						{g.regions.map((r) => (
							<SelectItem key={r.value} value={r.value}>
								<span className="flex items-center gap-2">
									{r.label}
									<span className="font-mono text-ui-xs text-muted-foreground">
										{r.value}
									</span>
								</span>
							</SelectItem>
						))}
					</SelectGroup>
				))}
			</SelectContent>
		</Select>
	);
}
