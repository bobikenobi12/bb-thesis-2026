"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useFormContext } from "react-hook-form";
import { AttachmentPicker } from "@/components/support/attachment-picker";
import type { SubmitCaseInput } from "@/lib/validations/support";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { SectionHeading } from "@repo/ui/section-heading";
import { Textarea } from "@repo/ui/textarea";

interface StepDetailsProps {
	/** Selected attachment files (owned by the parent form). */
	files: File[];
	/** Replaces the attachment list. */
	onFilesChange: (files: File[]) => void;
	/** Reports a rejected file so the parent can toast. */
	onFileReject: (reason: string) => void;
}

/** Step 4 — subject, description, and optional attachments. */
export function StepDetails({ files, onFilesChange, onFileReject }: StepDetailsProps) {
	const {
		register,
		formState: { errors },
	} = useFormContext<SubmitCaseInput>();

	return (
		<div className="space-y-5">
			<SectionHeading
				level={2}
				title="Tell us what's happening"
				description="A clear subject and detailed description help us resolve this faster."
			/>

			<div className="space-y-2">
				<Label htmlFor="support-subject">Subject</Label>
				<Input
					id="support-subject"
					placeholder="Short summary of the issue"
					{...register("subject")}
				/>
				{errors.subject && (
					<p className="text-xs text-destructive">{errors.subject.message}</p>
				)}
			</div>

			<div className="space-y-2">
				<Label htmlFor="support-description">Description</Label>
				<Textarea
					id="support-description"
					rows={7}
					placeholder="What happened, what you expected, and any steps to reproduce…"
					{...register("description")}
				/>
				{errors.description && (
					<p className="text-xs text-destructive">{errors.description.message}</p>
				)}
			</div>

			<div className="space-y-2">
				<Label>Attachments (optional)</Label>
				<AttachmentPicker
					files={files}
					onChange={onFilesChange}
					onReject={onFileReject}
				/>
			</div>
		</div>
	);
}
