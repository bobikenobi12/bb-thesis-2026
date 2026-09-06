"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Create/edit a classification value — label + slug (auto-derived from the label until edited).
// react-hook-form + the shared valueInputSchema; wires createValue / updateValue. Grayscale: no
// color accent (the design system carries no hue).

import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { Input } from "@repo/ui/input";
import { Switch } from "@repo/ui/switch";
import { Check, ShieldCheck } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import type { ValueDTO } from "@/app/server/actions/classification/dimensions";
import {
	createValue,
	updateValue,
} from "@/app/server/actions/classification/dimensions";
import { type ValueInput, valueInputSchema } from "@/lib/validations/classification";
import { slugifyOrEmpty } from "@/lib/utils/slugify";
import { InfoHint, Spinner } from "./classification-ui";

/**
 * The value editor dialog. Pass an existing `value` to edit, or omit it to create one on
 * `dimensionId`. Calls `onSaved` after a successful write.
 */
export function ValueEditor({
	dimensionId,
	dimensionLabel,
	value,
	open,
	onOpenChange,
	onSaved,
}: {
	dimensionId: string;
	dimensionLabel: string;
	value?: ValueDTO;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved: () => void;
}) {
	const isEdit = Boolean(value);
	const form = useForm<ValueInput>({
		resolver: zodResolver(valueInputSchema),
		defaultValues: {
			value: value?.value ?? "",
			label: value?.label ?? "",
			enforcement: value?.enforcement ?? null,
			position: value?.position ?? 0,
		},
	});

	useEffect(() => {
		if (open) {
			form.reset({
				value: value?.value ?? "",
				label: value?.label ?? "",
				enforcement: value?.enforcement ?? null,
				position: value?.position ?? 0,
			});
		}
	}, [open, value, form]);

	const label = form.watch("label");
	const enforcement = form.watch("enforcement");
	const enforceOn = Boolean(enforcement);

	/** Toggles the enforcement policy on/off, seeding a sensible default (require approval). */
	const setEnforce = (on: boolean) => {
		form.setValue(
			"enforcement",
			on
				? { require_approval: true, require_verify_pass: false, min_approvals: 1 }
				: null,
			{ shouldDirty: true },
		);
	};

	const onSubmit = async (data: ValueInput) => {
		try {
			const payload = { ...data, value: data.value || slugifyOrEmpty(data.label) };
			if (value) {
				await updateValue(value.id, payload);
				toast.success("Value updated.");
			} else {
				await createValue(dimensionId, payload);
				toast.success("Value added.");
			}
			onOpenChange(false);
			onSaved();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't save the value.");
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[440px]">
				<DialogHeader>
					<DialogDescription className="font-mono text-ui-3xs uppercase tracking-[0.14em] text-text-tertiary">
						Value · {dimensionLabel}
					</DialogDescription>
					<DialogTitle className="font-display text-ui-xl">
						{isEdit ? "Edit value" : "New value"}
					</DialogTitle>
				</DialogHeader>

				<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
					<div className="flex gap-3">
						<div className="flex-1">
							<label className="mb-1.5 block text-xs font-medium">Label</label>
							<Input
								autoFocus
								placeholder="Production"
								{...form.register("label")}
								onChange={(e) => {
									form.setValue("label", e.target.value);
									if (!isEdit && !form.formState.dirtyFields.value) {
										form.setValue("value", slugifyOrEmpty(e.target.value));
									}
								}}
							/>
						</div>
						<div className="flex-1">
							<label className="mb-1.5 block text-xs font-medium">Slug</label>
							<Input
								placeholder="prod"
								className="font-mono text-xs"
								{...form.register("value")}
							/>
						</div>
					</div>

					{/* Promotion enforcement — the label drives policy. */}
					<div className="rounded-md border">
						<div className="flex items-center justify-between gap-4 p-3">
							<div className="flex items-start gap-2">
								<ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-text-tertiary" />
								<div>
									<div className="flex items-center gap-1.5 text-ui-sm font-medium">
										Enforce promotion gates
										<InfoHint>
											When an environment is tagged with this value, promotions{" "}
											<em>into</em> that environment require these gates — on top of the
											environment{"'"}s own protection rules. The classification becomes
											the policy.
										</InfoHint>
									</div>
									<p className="mt-0.5 text-ui-xs text-text-tertiary">
										Applies to any environment carrying this value.
									</p>
								</div>
							</div>
							<Switch checked={enforceOn} onCheckedChange={setEnforce} />
						</div>

						{enforceOn && enforcement && (
							<div className="space-y-3 border-t p-3">
								<div className="flex items-center justify-between gap-4">
									<div className="text-ui-sm">Require manual approval</div>
									<Switch
										checked={enforcement.require_approval}
										onCheckedChange={(v) =>
											form.setValue("enforcement.require_approval", v, {
												shouldDirty: true,
											})
										}
									/>
								</div>
								<div className="flex items-center justify-between gap-4">
									<div className="flex items-center gap-1.5 text-ui-sm">
										Require verify pass
										<InfoHint>
											The elench verify gate must pass on the promotion{"'"}s plan (no
											unwaived hard control failures).
										</InfoHint>
									</div>
									<Switch
										checked={enforcement.require_verify_pass}
										onCheckedChange={(v) =>
											form.setValue("enforcement.require_verify_pass", v, {
												shouldDirty: true,
											})
										}
									/>
								</div>
								{enforcement.require_approval && (
									<div className="flex items-center justify-between gap-4">
										<div className="text-ui-sm">Minimum approvals</div>
										<Input
											type="number"
											min={1}
											max={10}
											className="h-8 w-16 text-center text-ui-sm"
											{...form.register("enforcement.min_approvals", {
												valueAsNumber: true,
											})}
										/>
									</div>
								)}
							</div>
						)}
					</div>

					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={form.formState.isSubmitting || !label}>
							{form.formState.isSubmitting ? <Spinner /> : <Check className="size-3.5" />}
							Save value
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
