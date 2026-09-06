"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Create / edit a classification dimension in a side sheet. Create mode offers an optional
// "start from a template" step that pre-fills the fields and stages a set of values — nothing is
// written until Save (then createDimensionWithValues). Edit mode updates the dimension only.

import { typedEntries } from "@/lib/typed-object";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { Switch } from "@repo/ui/switch";
import { Textarea } from "@repo/ui/textarea";
import { cn } from "@repo/ui/utils";
import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import type { DimensionDTO } from "@/app/server/actions/classification/dimensions";
import {
	createDimension,
	createDimensionWithValues,
	type SeedValue,
	updateDimension,
} from "@/app/server/actions/classification/dimensions";
import {
	type DimensionInput,
	dimensionInputSchema,
} from "@/lib/validations/classification";
import type { ResourceKind } from "@/lib/db/schema/enums";
import {
	CLASSIFICATION_TEMPLATES,
	type ClassificationTemplate,
} from "./classification-templates";
import { slugifyOrEmpty } from "@/lib/utils/slugify";
import { InfoHint, Spinner } from "./classification-ui";
import { RESOURCE_KIND_LABELS } from "./resource-kind-labels";

/** Create / edit a dimension. Controlled via `open` / `onOpenChange`. */
export function DimensionEditorSheet({
	dimension,
	initialTemplateKey,
	open,
	onOpenChange,
	onSaved,
}: {
	dimension?: DimensionDTO;
	/** Preselect a template when opening in create mode (from an empty-state card). */
	initialTemplateKey?: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved: () => void;
}) {
	const isEdit = Boolean(dimension);
	const [staged, setStaged] = useState<SeedValue[]>([]);
	const [templateKey, setTemplateKey] = useState<string | null>(null);
	const [addLabel, setAddLabel] = useState("");

	const form = useForm<DimensionInput>({
		resolver: zodResolver(dimensionInputSchema),
		defaultValues: { key: "", label: "", description: "", multi: false, applies_to: [], position: 0 },
	});

	// Apply a template's fields + stage its values (create mode only).
	const applyTemplate = (t: ClassificationTemplate) => {
		form.reset({
			key: t.key,
			label: t.label,
			description: t.description,
			multi: t.multi,
			applies_to: [],
			position: 0,
		});
		setStaged(t.values);
		setTemplateKey(t.key);
	};

	// Deselect the active template, back to a blank form.
	const clearTemplate = () => {
		form.reset({ key: "", label: "", description: "", multi: false, applies_to: [], position: 0 });
		setStaged([]);
		setTemplateKey(null);
	};

	// Reset when (re)opening.
	useEffect(() => {
		if (!open) return;
		if (dimension) {
			form.reset({
				key: dimension.key,
				label: dimension.label,
				description: dimension.description ?? "",
				multi: dimension.multi,
				applies_to: dimension.appliesTo,
				position: dimension.position,
			});
			setStaged([]);
			setTemplateKey(null);
		} else {
			const t = initialTemplateKey
				? CLASSIFICATION_TEMPLATES.find((x) => x.key === initialTemplateKey)
				: undefined;
			if (t) {
				applyTemplate(t);
			} else {
				form.reset({ key: "", label: "", description: "", multi: false, applies_to: [], position: 0 });
				setStaged([]);
				setTemplateKey(null);
			}
		}
		setAddLabel("");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, dimension, initialTemplateKey]);

	const multi = form.watch("multi");
	const appliesTo = form.watch("applies_to") ?? [];
	const toggleKind = (kind: ResourceKind) => {
		const set = new Set(appliesTo);
		if (set.has(kind)) set.delete(kind);
		else set.add(kind);
		form.setValue("applies_to", [...set]);
	};
	const KIND_ENTRIES = typedEntries(RESOURCE_KIND_LABELS);

	const addStaged = () => {
		const label = addLabel.trim();
		if (!label) return;
		const value = slugifyOrEmpty(label);
		if (staged.some((s) => s.value === value)) {
			setAddLabel("");
			return;
		}
		setStaged((s) => [...s, { value, label }]);
		setAddLabel("");
	};

	const onSubmit = async (data: DimensionInput) => {
		try {
			if (dimension) {
				await updateDimension(dimension.id, data);
				toast.success("Dimension updated.");
			} else if (staged.length > 0) {
				await createDimensionWithValues(data, staged);
				toast.success(`Created “${data.label}” with ${staged.length} values.`);
			} else {
				await createDimension(data);
				toast.success("Dimension created.");
			}
			onOpenChange(false);
			onSaved();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't save the dimension.");
		}
	};

	const submitting = form.formState.isSubmitting;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-[min(480px,96vw)] flex-col gap-0 p-0 sm:max-w-none"
			>
				<SheetHeader className="border-b p-5">
					<SheetTitle className="font-display text-ui-xl font-semibold tracking-tight">
						{isEdit ? "Edit dimension" : "New dimension"}
					</SheetTitle>
					<SheetDescription className="text-ui-sm">
						A named axis (e.g. Environment, Team) with a set of allowed values.
					</SheetDescription>
				</SheetHeader>

				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="flex min-h-0 flex-1 flex-col"
				>
					<div className="flex-1 space-y-5 overflow-y-auto p-5">
						{/* optional: start from a template (create only) */}
						{!isEdit && (
							<div>
								<div className="mb-2 font-mono text-ui-3xs uppercase tracking-[0.14em] text-text-tertiary">
									Start from a template
									<span className="ml-1.5 normal-case tracking-normal text-text-disabled">
										optional
									</span>
								</div>
								<div className="flex flex-wrap gap-1.5">
									{CLASSIFICATION_TEMPLATES.map((t) => (
										<button
											key={t.key}
											type="button"
											onClick={() =>
												templateKey === t.key ? clearTemplate() : applyTemplate(t)
											}
											className={cn(
												"rounded-[2px] border px-2.5 py-1 text-ui-sm transition-colors",
												templateKey === t.key
													? "border-ring bg-surface-muted text-text-primary"
													: "border-border-strong text-text-secondary hover:bg-surface-muted",
											)}
										>
											{t.label}
										</button>
									))}
								</div>
							</div>
						)}

						<div>
							<label className="mb-1.5 block text-xs font-medium">Label</label>
							<Input
								autoFocus
								placeholder="Environment"
								{...form.register("label")}
								onChange={(e) => {
									form.setValue("label", e.target.value);
									if (!isEdit && !form.formState.dirtyFields.key) {
										form.setValue("key", slugifyOrEmpty(e.target.value));
									}
								}}
							/>
						</div>

						<div>
							<label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
								Key
								<InfoHint>
									The stable, URL/wire-safe identifier. It{"'"}s fixed after creation so
									existing assignments never break — the label stays editable.
								</InfoHint>
							</label>
							<Input
								placeholder="environment"
								className="font-mono text-xs"
								disabled={isEdit}
								{...form.register("key")}
							/>
						</div>

						<div>
							<label className="mb-1.5 block text-xs font-medium">
								Description{" "}
								<span className="font-normal text-text-tertiary">— optional</span>
							</label>
							<Textarea
								rows={2}
								placeholder="What this axis means."
								{...form.register("description")}
							/>
						</div>

						<div className="flex items-center justify-between gap-4 rounded-md border p-3">
							<div className="flex items-center gap-1.5">
								<div className="text-ui-sm font-medium">Allow multiple values</div>
								<InfoHint>
									Off: a resource holds one value on this axis (assigning a new one
									replaces the old). On: a resource may carry several (e.g. a service
									owned by two teams).
								</InfoHint>
							</div>
							<Switch
								checked={multi}
								onCheckedChange={(v) => form.setValue("multi", v)}
							/>
						</div>

						{/* applies-to scope */}
						<div>
							<div className="mb-1.5 flex items-center gap-1.5">
								<label className="text-xs font-medium">Applies to</label>
								<InfoHint>
									Which resource kinds can carry this dimension. Leave all unchecked to
									apply everywhere; otherwise it only appears on the kinds you pick.
								</InfoHint>
								<span className="ml-auto font-mono text-ui-2xs text-text-tertiary">
									{appliesTo.length === 0 ? "All resources" : `${appliesTo.length} kinds`}
								</span>
							</div>
							<div className="flex flex-wrap gap-1.5">
								{KIND_ENTRIES.map(([kind, label]) => {
									const on = appliesTo.includes(kind);
									return (
										<button
											key={kind}
											type="button"
											onClick={() => toggleKind(kind)}
											className={cn(
												"rounded-[2px] border px-2 py-1 text-ui-xs transition-colors",
												on
													? "border-ring bg-surface-muted text-text-primary"
													: "border-border-strong text-text-tertiary hover:bg-surface-muted",
											)}
										>
											{label}
										</button>
									);
								})}
							</div>
						</div>

						{/* staged values (create only) */}
						{!isEdit && (
							<div>
								<div className="mb-2 font-mono text-ui-3xs uppercase tracking-[0.14em] text-text-tertiary">
									Values
									<span className="ml-1.5 normal-case tracking-normal text-text-disabled">
										{staged.length === 0 ? "add now or after" : `${staged.length} staged`}
									</span>
								</div>
								{staged.length > 0 && (
									<div className="mb-2 flex flex-wrap gap-1.5">
										{staged.map((v) => (
											<span
												key={v.value}
												className="inline-flex items-center gap-1.5 rounded-[2px] border bg-surface-sunken px-2 py-1 text-ui-sm"
											>
												{v.label}
												<button
													type="button"
													aria-label={`Remove ${v.label}`}
													onClick={() =>
														setStaged((s) => s.filter((x) => x.value !== v.value))
													}
													className="text-text-tertiary hover:text-text-primary"
												>
													<X className="size-3" />
												</button>
											</span>
										))}
									</div>
								)}
								<div className="flex items-center gap-2">
									<Input
										value={addLabel}
										onChange={(e) => setAddLabel(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												addStaged();
											}
										}}
										placeholder="Add a value — press Enter"
										className="h-8 text-ui-sm"
									/>
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="h-8 gap-1"
										disabled={!addLabel.trim()}
										onClick={addStaged}
									>
										<Plus className="size-3.5" />
										Add
									</Button>
								</div>
								<p className="mt-2 text-ui-xs text-text-tertiary">
									You can edit and reorder values after creating.
								</p>
							</div>
						)}
					</div>

					<SheetFooter className="flex-row justify-end gap-2 border-t p-4">
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={submitting}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={submitting || !form.watch("label")}>
							{submitting && <Spinner />}
							{isEdit ? "Save changes" : "Create dimension"}
						</Button>
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
	);
}
