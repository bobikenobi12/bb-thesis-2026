"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Bring-your-own IaC (E3) — the four-step attach flow (repository → path/ref → variables → review)
// opened from the canvas ⌘K "Sources" group. Step 0 reuses the production RepositorySelector (the
// same git-provider auth / repo fetch the BYO Helm flow uses); the remaining steps collect the
// root-module path + git ref and the non-secret tfvars, then Review calls attachIacSource — which
// pins a single project_iac_sources row per environment (v1 replace mode) and auto-queues the
// IAC_SCAN so provisioning can unlock. Mirrors ByoChartDialog; react-hook-form + zod throughout.

import { useCallback, useState } from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Boxes, Check, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { cn } from "@repo/ui/utils";
import { RepositorySelector } from "@/components/repository-selector";
import { attachIacSource } from "@/app/server/actions/byo-iac";
import {
	IAC_VAR_KINDS,
	iacSourceFormSchema,
	toIacVarValues,
	type IacSourceFormValues,
} from "@/lib/validations/byo-iac";

interface ByoIacDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	environmentId: string | null;
	/** Called after a source is attached (the canvas re-fetches + re-renders the IaC overlay). */
	onAttached?: () => void;
}

const STEPS = ["Repository", "Path & ref", "Variables", "Review"] as const;

/** The four-step "attach an IaC source" dialog. Self-contained: owns the RHF form + resets on close. */
export function ByoIacDialog({
	open,
	onOpenChange,
	projectId,
	environmentId,
	onAttached,
}: ByoIacDialogProps) {
	const form = useForm<IacSourceFormValues>({
		resolver: zodResolver(iacSourceFormSchema),
		mode: "onChange",
		defaultValues: { repo_url: "", path: "", ref: "", variables: [] },
	});
	const {
		control,
		register,
		handleSubmit,
		trigger,
		reset,
		watch,
		formState: { errors, isSubmitting },
	} = form;
	const { fields, append, remove } = useFieldArray({ control, name: "variables" });

	// The wizard step lives in plain component state (not a schema field).
	const [step, setStep] = useState(0);

	const repoUrl = watch("repo_url");
	const path = watch("path");
	const ref = watch("ref");

	const close = useCallback(
		(next: boolean) => {
			if (!next) {
				reset();
				setStep(0);
			}
			onOpenChange(next);
		},
		[onOpenChange, reset],
	);

	/** Validate the current step's fields before advancing; the last step submits instead. */
	const next = useCallback(async () => {
		if (step === 0) {
			if (!(await trigger("repo_url"))) return;
		}
		if (step === 2) {
			if (!(await trigger("variables"))) return;
		}
		setStep((s) => s + 1);
	}, [step, trigger]);

	const onSubmit = useCallback(
		async (values: IacSourceFormValues) => {
			try {
				await attachIacSource({
					projectId,
					environmentId,
					repoUrl: values.repo_url.trim(),
					ref: values.ref?.trim() ? values.ref.trim() : null,
					path: values.path?.trim() ?? "",
					varValues: toIacVarValues(values.variables),
				});
				// attachIacSource auto-queues the IAC_SCAN (best-effort) — no explicit scan call needed.
				toast.success("IaC source attached — scanning the module now.");
				onAttached?.();
				close(false);
			} catch (err) {
				toast.error(err instanceof Error ? err.message : "Could not attach the IaC source.");
			}
		},
		[projectId, environmentId, onAttached, close],
	);

	const effectiveRef = ref?.trim() || "HEAD";
	const effectivePath = path?.trim().replace(/^\/+|\/+$/g, "") || "(repo root)";
	const varCount = fields.length;

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Boxes className="h-4 w-4 text-muted-foreground" />
						Bring your own IaC
					</DialogTitle>
					<DialogDescription>
						Point this environment at a git repo holding an OpenTofu root module — Alethia plans,
						verifies, and applies it instead of the built-in template (replace mode).
					</DialogDescription>
				</DialogHeader>

				{/* Step rail */}
				<div className="flex items-center gap-2">
					{STEPS.map((label, i) => (
						<div key={label} className="flex flex-1 flex-col gap-1.5">
							<div
								className={cn(
									"h-0.5 rounded-full transition-colors",
									i <= step ? "bg-foreground" : "bg-border",
								)}
							/>
							<span
								className={cn(
									"font-mono text-ui-2xs uppercase tracking-wide",
									i === step ? "text-foreground" : "text-muted-foreground",
								)}
							>
								{label}
							</span>
						</div>
					))}
				</div>

				<form onSubmit={handleSubmit(onSubmit)}>
					<div className="min-h-[240px] py-2">
						{step === 0 && (
							<div className="flex flex-col gap-3">
								<Controller
									control={control}
									name="repo_url"
									render={({ field }) => (
										<RepositorySelector
											value={field.value}
											onChange={field.onChange}
											label="Module repository"
											placeholder="https://github.com/acme/infra-tofu"
											required
										/>
									)}
								/>
								{errors.repo_url && (
									<p className="text-xs text-destructive">{errors.repo_url.message}</p>
								)}
								<p className="text-xs text-muted-foreground">
									From the git providers you&apos;ve linked. No provider yet? The selector offers a
									connect step — identity comes from your existing connectors, no new login.
								</p>
							</div>
						)}

						{step === 1 && (
							<div className="flex flex-col gap-4">
								<div className="flex flex-col gap-2">
									<Label htmlFor="byo-iac-path">Root-module path</Label>
									<Input
										id="byo-iac-path"
										{...register("path")}
										placeholder="infra/prod (default: repo root)"
										className="font-mono"
										autoFocus
									/>
									<p className="text-xs text-muted-foreground">
										The directory inside the repo that holds the root <code>*.tf</code>. Leave blank
										for the repo root.
									</p>
								</div>
								<div className="flex flex-col gap-2">
									<Label htmlFor="byo-iac-ref">Git ref (optional)</Label>
									<Input
										id="byo-iac-ref"
										{...register("ref")}
										placeholder="main (default: HEAD)"
										className="font-mono"
									/>
									<p className="text-xs text-muted-foreground">
										Branch, tag, or commit the scan pins. Leave blank for <code>HEAD</code>.
									</p>
								</div>
							</div>
						)}

						{step === 2 && (
							<div className="flex flex-col gap-3">
								<div className="flex items-center justify-between">
									<Label>Variables (non-secret tfvars)</Label>
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="h-7 gap-1.5 text-xs"
										onClick={() => append({ key: "", kind: "string", value: "" })}
									>
										<Plus className="h-3.5 w-3.5" /> Add
									</Button>
								</div>
								{fields.length === 0 ? (
									<EmptyState
										className="border px-3 py-6 md:px-3 md:py-6"
										title="No variables"
										description="The module runs with its own defaults."
									/>
								) : (
									<div className="flex flex-col gap-2">
										{fields.map((f, i) => (
											<div key={f.id} className="flex items-start gap-2">
												<div className="flex-1">
													<Input
														{...register(`variables.${i}.key`)}
														placeholder="region"
														className="font-mono text-xs"
														aria-label={`Variable ${i + 1} name`}
													/>
													{errors.variables?.[i]?.key && (
														<p className="mt-1 text-ui-xs text-destructive">
															{errors.variables[i]?.key?.message}
														</p>
													)}
												</div>
												<Controller
													control={control}
													name={`variables.${i}.kind`}
													render={({ field }) => (
														<Select value={field.value} onValueChange={field.onChange}>
															<SelectTrigger
																className="w-[92px] font-mono text-xs"
																aria-label={`Variable ${i + 1} type`}
															>
																<SelectValue />
															</SelectTrigger>
															<SelectContent>
																{IAC_VAR_KINDS.map((k) => (
																	<SelectItem key={k} value={k} className="font-mono text-xs">
																		{k}
																	</SelectItem>
																))}
															</SelectContent>
														</Select>
													)}
												/>
												<div className="flex-1">
													<Input
														{...register(`variables.${i}.value`)}
														placeholder="us-east-1"
														className="font-mono text-xs"
														aria-label={`Variable ${i + 1} value`}
													/>
													{errors.variables?.[i]?.value && (
														<p className="mt-1 text-ui-xs text-destructive">
															{errors.variables[i]?.value?.message}
														</p>
													)}
												</div>
												<Button
													type="button"
													variant="ghost"
													size="icon"
													className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
													onClick={() => remove(i)}
													aria-label={`Remove variable ${i + 1}`}
												>
													<Trash2 className="h-3.5 w-3.5" />
												</Button>
											</div>
										))}
									</div>
								)}
								<p className="text-xs text-muted-foreground">
									Scalar values only (string / number / bool). Secrets belong in your cloud&apos;s
									secret store or the module&apos;s own data sources — never here.
								</p>
							</div>
						)}

						{step === 3 && (
							<div className="flex flex-col gap-3">
								<div className="rounded-md border border-border bg-muted/40 p-3 font-mono text-ui-xs text-muted-foreground">
									<div className="text-foreground">
										{repoUrl.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "") || "—"}
									</div>
									<div>
										path {effectivePath} · ref {effectiveRef}
									</div>
									<div>
										{varCount} variable{varCount === 1 ? "" : "s"} · replace mode · scan on attach
									</div>
								</div>
								<p className="text-xs text-muted-foreground">
									Attaching queues a safety scan of the module. This environment&apos;s components are
									then governed by the module — the built-in template no longer applies.
								</p>
							</div>
						)}
					</div>

					<div className="flex items-center justify-between">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() =>
								step === 0 ? close(false) : setStep((s) => s - 1)
							}
							disabled={isSubmitting}
						>
							{step === 0 ? (
								"Cancel"
							) : (
								<>
									<ArrowLeft className="h-3.5 w-3.5" /> Back
								</>
							)}
						</Button>
						{step < 3 ? (
							<Button type="button" size="sm" onClick={next}>
								Next <ArrowRight className="h-3.5 w-3.5" />
							</Button>
						) : (
							<Button type="submit" size="sm" disabled={isSubmitting}>
								{isSubmitting ? (
									<Loader2 className="h-3.5 w-3.5 animate-spin" />
								) : (
									<Check className="h-3.5 w-3.5" />
								)}
								Attach source
							</Button>
						)}
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
