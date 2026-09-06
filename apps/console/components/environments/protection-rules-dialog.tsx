"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-environment protection rules editor, as a right-side drawer. Each gate is individually
// toggleable; evaluated when a promotion into this environment is planned (lib/promotions/gates.ts).

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, X } from "lucide-react";
import { useEffect } from "react";
import { type Control, Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { getProtectionRules, setProtectionRules } from "@/app/server/actions/protection";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Sheet, SheetContent } from "@repo/ui/sheet";
import { Switch } from "@repo/ui/switch";

const rulesSchema = z.object({
	require_predecessor: z.boolean(),
	require_verify_pass: z.boolean(),
	require_approval: z.boolean(),
	min_count: z.number().int().min(1).max(10),
	soak_minutes: z.number().int().min(0).nullable(),
	cost_delta_threshold: z.number().min(0).nullable(),
});
type RulesForm = z.infer<typeof rulesSchema>;

const DEFAULTS: RulesForm = {
	require_predecessor: false,
	require_verify_pass: false,
	require_approval: false,
	min_count: 1,
	soak_minutes: null,
	cost_delta_threshold: null,
};

/** Drawer editor for one environment's promotion protection rules. */
export function ProtectionRulesDialog({
	open,
	onOpenChange,
	projectId,
	envId,
	envName,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	projectId: string;
	envId: string;
	envName: string;
}) {
	const { control, handleSubmit, reset, watch, formState } = useForm<RulesForm>({
		resolver: zodResolver(rulesSchema),
		defaultValues: DEFAULTS,
	});

	// Load current rules when the drawer opens.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		getProtectionRules(projectId, envId)
			.then((row) => {
				if (cancelled) return;
				reset(
					row
						? {
								require_predecessor: row.require_predecessor,
								require_verify_pass: row.require_verify_pass,
								require_approval: row.require_approval,
								min_count: row.approvers?.min_count ?? 1,
								soak_minutes: row.soak_minutes,
								cost_delta_threshold: row.cost_delta_threshold,
							}
						: DEFAULTS,
				);
			})
			.catch(() => toast.error("Failed to load protection rules"));
		return () => {
			cancelled = true;
		};
	}, [open, projectId, envId, reset]);

	const requireApproval = watch("require_approval");

	const onSubmit = handleSubmit(async (values) => {
		try {
			await setProtectionRules(projectId, envId, {
				require_predecessor: values.require_predecessor,
				require_verify_pass: values.require_verify_pass,
				require_approval: values.require_approval,
				approvers: { user_ids: [], role: null, min_count: values.min_count },
				soak_minutes: values.soak_minutes,
				cost_delta_threshold: values.cost_delta_threshold,
			});
			toast.success("Protection rules saved");
			onOpenChange(false);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save rules");
		}
	});

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="w-[min(420px,92vw)] gap-0 p-0 sm:max-w-none"
			>
				<form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
					{/* header */}
					<div className="flex items-start justify-between gap-3 border-b px-[22px] py-5">
						<div>
							<div className="font-mono text-ui-2xs uppercase tracking-[0.16em] text-text-tertiary">
								Protection rules
							</div>
							<div className="mt-1.5 font-mono text-ui-xl text-text-primary">
								{envName}
							</div>
							<p className="mt-2 max-w-[40ch] text-ui-sm text-text-tertiary">
								Gates a promotion must clear before it deploys into this environment.
							</p>
						</div>
						<button
							type="button"
							onClick={() => onOpenChange(false)}
							aria-label="Close"
							className="grid size-8 shrink-0 place-items-center rounded-sm text-text-tertiary transition-colors hover:bg-surface-muted hover:text-text-primary"
						>
							<X className="size-4" />
						</button>
					</div>

					{/* rules */}
					<div className="flex flex-1 flex-col gap-3 overflow-y-auto px-[22px] py-[18px]">
						<ToggleRow
							control={control}
							name="require_predecessor"
							title="Require predecessor"
							desc="The lower environment must have deployed this design and be in sync."
						/>
						<ToggleRow
							control={control}
							name="require_verify_pass"
							title="Require verify pass"
							desc="The plan's elench report must have no unwaived hard failures."
						/>
						<ToggleRow
							control={control}
							name="require_approval"
							title="Require approval"
							desc="A reviewer must approve before the deploy runs."
						/>
						{requireApproval && (
							<div className="flex items-center justify-between gap-3 pl-[26px] pr-3.5">
								<span className="text-ui-sm text-text-secondary">
									Approvals required
								</span>
								<Controller
									control={control}
									name="min_count"
									render={({ field }) => (
										<Input
											type="number"
											min={1}
											max={10}
											className="h-[34px] w-[84px] text-sm"
											value={field.value}
											onChange={(e) =>
												field.onChange(e.target.value === "" ? 1 : Number(e.target.value))
											}
										/>
									)}
								/>
							</div>
						)}
						<NumberRow
							control={control}
							name="soak_minutes"
							title="Soak timer (min)"
							desc="Minutes to wait after the predecessor deploy. Blank = off."
						/>
						<NumberRow
							control={control}
							name="cost_delta_threshold"
							title="Cost threshold ($/mo)"
							desc="Cost increases above this force approval. Blank = off."
						/>
					</div>

					{/* footer */}
					<div className="flex justify-end gap-2 border-t px-[22px] py-4">
						<Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
							Close
						</Button>
						<Button type="submit" size="sm" disabled={formState.isSubmitting}>
							{formState.isSubmitting && <Loader2 className="size-3.5 animate-spin" />}
							Save rules
						</Button>
					</div>
				</form>
			</SheetContent>
		</Sheet>
	);
}

/** A labelled boolean gate toggle bound to the form. */
function ToggleRow({
	control,
	name,
	title,
	desc,
}: {
	control: Control<RulesForm>;
	name: "require_predecessor" | "require_verify_pass" | "require_approval";
	title: string;
	desc: string;
}) {
	return (
		<label className="flex items-center justify-between gap-3 rounded-lg border px-3.5 py-3">
			<span className="min-w-0">
				<span className="text-ui-md font-medium text-text-primary">{title}</span>
				<span className="mt-0.5 block text-ui-xs text-text-tertiary">{desc}</span>
			</span>
			<Controller
				control={control}
				name={name}
				render={({ field }) => (
					<Switch checked={field.value} onCheckedChange={field.onChange} />
				)}
			/>
		</label>
	);
}

/** A nullable-number gate input bound to the form (blank = null = off). */
function NumberRow({
	control,
	name,
	title,
	desc,
}: {
	control: Control<RulesForm>;
	name: "soak_minutes" | "cost_delta_threshold";
	title: string;
	desc: string;
}) {
	return (
		<div className="flex items-center justify-between gap-3 rounded-lg border px-3.5 py-3">
			<span className="min-w-0">
				<span className="text-ui-md font-medium text-text-primary">{title}</span>
				<span className="mt-0.5 block text-ui-xs text-text-tertiary">{desc}</span>
			</span>
			<Controller
				control={control}
				name={name}
				render={({ field }) => (
					<Input
						type="number"
						min={0}
						placeholder="off"
						className="h-[34px] w-[92px] font-mono text-sm"
						value={field.value ?? ""}
						onChange={(e) =>
							field.onChange(e.target.value === "" ? null : Number(e.target.value))
						}
					/>
				)}
			/>
		</div>
	);
}
