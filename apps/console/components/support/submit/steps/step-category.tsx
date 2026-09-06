"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Controller, useFormContext } from "react-hook-form";
import { supportCaseCategory } from "@/lib/db/schema/enums";
import {
	SUPPORT_CATEGORY_LABELS,
	type SubmitCaseInput,
} from "@/lib/validations/support";
import { Label } from "@repo/ui/label";
import { SectionHeading } from "@repo/ui/section-heading";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";

/**
 * Step 2 — pick the service / area the case is about. A plain select for P1; a
 * resource-aware picker (link a specific cluster/job/connector) is a later enhancement.
 */
export function StepCategory() {
	const {
		control,
		formState: { errors },
	} = useFormContext<SubmitCaseInput>();

	// TODO(support): upgrade to a resource picker that pre-selects a cluster/job/connector
	// and stamps `context.{clusterId,jobId,connectorId}` from the current console scope.
	return (
		<div className="space-y-4">
			<SectionHeading
				level={2}
				title="Which area is this about?"
				description="Pick the service or area closest to your issue."
			/>
			<div className="space-y-2">
				<Label htmlFor="support-category">Service / area</Label>
				<Controller
					control={control}
					name="category"
					render={({ field }) => (
						<Select value={field.value} onValueChange={field.onChange}>
							<SelectTrigger id="support-category" className="w-full max-w-md">
								<SelectValue placeholder="Select an area" />
							</SelectTrigger>
							<SelectContent>
								{supportCaseCategory.enumValues.map((value) => (
									<SelectItem key={value} value={value}>
										{SUPPORT_CATEGORY_LABELS[value]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
				/>
				{errors.category && (
					<p className="text-xs text-destructive">Select an area to continue.</p>
				)}
			</div>
		</div>
	);
}
