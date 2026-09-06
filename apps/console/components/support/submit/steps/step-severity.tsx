"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Controller, useFormContext } from "react-hook-form";
import { supportCaseSeverity } from "@/lib/db/schema/enums";
import { RadioCard } from "@/components/support/radio-card";
import {
	SUPPORT_SEVERITY_GUIDANCE,
	SUPPORT_SEVERITY_LABELS,
	type SubmitCaseInput,
} from "@/lib/validations/support";
import { SectionHeading } from "@repo/ui/section-heading";

/** Step 3 — pick severity, with per-option expected-response guidance. */
export function StepSeverity() {
	const {
		control,
		formState: { errors },
	} = useFormContext<SubmitCaseInput>();

	return (
		<div className="space-y-4">
			<SectionHeading
				level={2}
				title="How severe is this?"
				description="Set the urgency so we can prioritize your case."
			/>
			<Controller
				control={control}
				name="severity"
				render={({ field }) => (
					<div className="grid gap-2">
						{supportCaseSeverity.enumValues.map((value) => (
							<RadioCard
								key={value}
								selected={field.value === value}
								onSelect={() => field.onChange(value)}
								label={SUPPORT_SEVERITY_LABELS[value]}
								description={SUPPORT_SEVERITY_GUIDANCE[value]}
							/>
						))}
					</div>
				)}
			/>
			{errors.severity && (
				<p className="text-xs text-destructive">Select a severity to continue.</p>
			)}
		</div>
	);
}
