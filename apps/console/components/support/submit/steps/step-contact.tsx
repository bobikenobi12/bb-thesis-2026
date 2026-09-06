"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Controller, useFormContext, useWatch } from "react-hook-form";
import {
	SUPPORT_CASE_TYPE_LABELS,
	SUPPORT_CATEGORY_LABELS,
	SUPPORT_SEVERITY_LABELS,
	type SubmitCaseInput,
} from "@/lib/validations/support";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { SectionHeading } from "@repo/ui/section-heading";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";

interface StepContactProps {
	/** Attachment count, surfaced in the review summary. */
	attachmentCount: number;
}

/** A single label / value row in the review summary. */
function SummaryRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-baseline justify-between gap-4 py-1.5">
			<span className="text-sm text-muted-foreground">{label}</span>
			<span className="min-w-0 truncate text-sm font-medium">{value}</span>
		</div>
	);
}

/** Step 5 — where to notify the customer, plus a review summary before submit. */
export function StepContact({ attachmentCount }: StepContactProps) {
	const {
		control,
		register,
		formState: { errors },
	} = useFormContext<SubmitCaseInput>();
	const values = useWatch<SubmitCaseInput>({ control });

	return (
		<div className="space-y-5">
			<SectionHeading
				level={2}
				title="How should we reach you?"
				description="We'll send case updates to this address."
			/>

			<div className="space-y-2">
				<Label htmlFor="support-notify-email">Notification email</Label>
				<Input
					id="support-notify-email"
					type="email"
					placeholder="you@company.com"
					className="max-w-md"
					{...register("contact.notifyEmail")}
				/>
				{errors.contact?.notifyEmail && (
					<p className="text-xs text-destructive">
						Enter a valid email address.
					</p>
				)}
			</div>

			<div className="space-y-2">
				<Label htmlFor="support-channel">Preferred channel</Label>
				<Controller
					control={control}
					name="contact.channel"
					render={({ field }) => (
						<Select value={field.value} onValueChange={field.onChange}>
							<SelectTrigger id="support-channel" className="w-full max-w-md">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="email">Email</SelectItem>
								<SelectItem value="in_app">In-app</SelectItem>
							</SelectContent>
						</Select>
					)}
				/>
			</div>

			<div className="space-y-2 pt-1">
				<Label>Review</Label>
				<div className="divide-y rounded-lg border px-4">
					<SummaryRow
						label="Type"
						value={values.type ? SUPPORT_CASE_TYPE_LABELS[values.type] : "—"}
					/>
					<SummaryRow
						label="Area"
						value={
							values.category
								? SUPPORT_CATEGORY_LABELS[values.category]
								: "—"
						}
					/>
					<SummaryRow
						label="Severity"
						value={
							values.severity
								? SUPPORT_SEVERITY_LABELS[values.severity]
								: "—"
						}
					/>
					<SummaryRow label="Subject" value={values.subject || "—"} />
					<SummaryRow
						label="Attachments"
						value={String(attachmentCount)}
					/>
				</div>
			</div>
		</div>
	);
}
