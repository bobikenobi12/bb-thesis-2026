"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { z } from "zod";
import { submitCase } from "@/app/server/actions/support";
import { supportAbuseCategory } from "@/lib/db/schema/enums";
import { globalHref } from "@/lib/routing";
import {
	SUPPORT_ABUSE_CATEGORY_LABELS,
	type SubmitCaseInput,
	submitCaseSchema,
} from "@/lib/validations/support";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Textarea } from "@repo/ui/textarea";

interface AbuseFormProps {
	/** Active org slug — targets the post-submit redirect to `/{org}/~/support/cases/{id}`. */
	orgSlug: string;
	/** Pre-fills the notification email (the signed-in user's address). */
	defaultEmail?: string;
}

/**
 * The form's raw field-value type — the pre-parse input shape of `submitCaseSchema`
 * (which transforms `contact.channel`), paired with the parsed {@link SubmitCaseInput}
 * output so `handleSubmit` yields the parsed values.
 */
type AbuseFormValues = z.input<typeof submitCaseSchema>;

/** Who is filing the report, relative to the abusive resource. */
const RELATIONSHIP_LABELS: Record<"third_party" | "affected_party", string> = {
	affected_party: "I'm directly affected",
	third_party: "I'm reporting on someone else's behalf",
};

/**
 * The focused abuse-report form. Presets the shared submit contract to `type: "abuse"`
 * (category `other`, high severity) and collects the abuse-specific fields plus a subject,
 * description, and notification email in a single page. Submits via `submitCase` and routes
 * to the created case thread.
 */
export function AbuseForm({ orgSlug, defaultEmail }: AbuseFormProps) {
	const router = useRouter();
	const {
		control,
		register,
		handleSubmit,
		setValue,
		formState: { errors, isSubmitting },
	} = useForm<AbuseFormValues, unknown, SubmitCaseInput>({
		resolver: zodResolver(submitCaseSchema),
		defaultValues: {
			type: "abuse",
			category: "other",
			severity: "high",
			context: {},
			contact: { notifyEmail: defaultEmail ?? "", channel: "email" },
			abuse: { reporterRelationship: "affected_party" },
		},
	});

	// Snapshot the browser context (deep link + UA) for triage.
	useEffect(() => {
		setValue("context.consoleUrl", window.location.href);
		setValue("context.userAgent", navigator.userAgent);
	}, [setValue]);

	/** Creates the abuse case, then routes to the thread. */
	const onSubmit = handleSubmit(async (values) => {
		try {
			const { id } = await submitCase(values);
			router.push(`${globalHref(orgSlug, "support")}/cases/${id}`);
		} catch {
			toast.error("Couldn't submit your report. Please try again.");
		}
	});

	return (
		<form onSubmit={onSubmit} className="max-w-2xl space-y-8 py-2">
			<PageToolbar
				description="Flag phishing, malware, spam, copyright, or other policy violations. Our trust & safety team reviews every report."
			/>

			<section className="space-y-5">
				<div className="space-y-2">
					<Label htmlFor="abuse-category">Category</Label>
					<Controller
						control={control}
						name="abuse.abuseCategory"
						render={({ field }) => (
							<Select value={field.value} onValueChange={field.onChange}>
								<SelectTrigger id="abuse-category" className="w-full max-w-md">
									<SelectValue placeholder="Select a category" />
								</SelectTrigger>
								<SelectContent>
									{supportAbuseCategory.enumValues.map((value) => (
										<SelectItem key={value} value={value}>
											{SUPPORT_ABUSE_CATEGORY_LABELS[value]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					/>
				</div>

				<div className="space-y-2">
					<Label htmlFor="abuse-resource">Reported resource</Label>
					<Input
						id="abuse-resource"
						placeholder="URL, IP, domain, or resource identifier"
						className="max-w-md"
						{...register("abuse.reportedResource")}
					/>
					<p className="text-xs text-muted-foreground">
						Where you saw the abusive content or activity.
					</p>
				</div>

				<div className="space-y-2">
					<Label htmlFor="abuse-relationship">Your relationship</Label>
					<Controller
						control={control}
						name="abuse.reporterRelationship"
						render={({ field }) => (
							<Select value={field.value} onValueChange={field.onChange}>
								<SelectTrigger
									id="abuse-relationship"
									className="w-full max-w-md"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="affected_party">
										{RELATIONSHIP_LABELS.affected_party}
									</SelectItem>
									<SelectItem value="third_party">
										{RELATIONSHIP_LABELS.third_party}
									</SelectItem>
								</SelectContent>
							</Select>
						)}
					/>
				</div>
			</section>

			<section className="space-y-5 border-t pt-6">
				<div className="space-y-2">
					<Label htmlFor="abuse-subject">Subject</Label>
					<Input
						id="abuse-subject"
						placeholder="Short summary of the report"
						{...register("subject")}
					/>
					{errors.subject && (
						<p className="text-xs text-destructive">{errors.subject.message}</p>
					)}
				</div>

				<div className="space-y-2">
					<Label htmlFor="abuse-description">Description</Label>
					<Textarea
						id="abuse-description"
						rows={7}
						placeholder="Describe the abuse, including any relevant details or evidence…"
						{...register("description")}
					/>
					{errors.description && (
						<p className="text-xs text-destructive">
							{errors.description.message}
						</p>
					)}
				</div>
			</section>

			<section className="space-y-5 border-t pt-6">
				<div className="space-y-2">
					<Label htmlFor="abuse-email">Notification email</Label>
					<Input
						id="abuse-email"
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
			</section>

			<div className="flex justify-end border-t pt-6">
				<Button type="submit" disabled={isSubmitting}>
					{isSubmitting ? "Submitting…" : "Submit report"}
				</Button>
			</div>
		</form>
	);
}
