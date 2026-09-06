"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Copy, FileStack } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { addEnvironment, duplicateEnvironment } from "@/app/server/actions/projects";
import type { SwitcherEnv } from "@/app/server/actions/resolve";
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
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { cn } from "@repo/ui/utils";

type Mode = "duplicate" | "empty";

/** Docs entry for the "Learn More" link in the dialog header. */
const ENV_DOCS_HREF = "/docs/concepts/environments";

/**
 * The "New Environment" dialog, hosted by the env switcher. Collects a name and a creation mode:
 * **Duplicate** (copy an existing environment's services/variables/config — choose the base) or
 * **Empty** (a fresh environment with nothing in it). On success it calls `onCreated` with the new
 * environment name so the caller can refresh + navigate to it.
 */
export function NewEnvironmentDialog({
	open,
	onOpenChange,
	projectId,
	envs,
	defaultBaseId,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	/** The project the new environment belongs to. */
	projectId: string;
	/** The project's existing environments — the Duplicate base options. */
	envs: SwitcherEnv[];
	/** When opened via an env's "Duplicate" action, preselects that env as the base. */
	defaultBaseId?: string;
	/** Called with the created environment's name after a successful create. */
	onCreated: (name: string) => void | Promise<void>;
}) {
	const defaultBase = envs.find((e) => e.is_default) ?? envs[0];
	const [name, setName] = useState("");
	const [mode, setMode] = useState<Mode>("duplicate");
	const [baseId, setBaseId] = useState<string>(defaultBase?.id ?? "");
	const [submitting, setSubmitting] = useState(false);

	// When (re)opened, seed the base from `defaultBaseId` (the duplicated env) if given.
	useEffect(() => {
		if (open) {
			setMode("duplicate");
			setBaseId(defaultBaseId ?? defaultBase?.id ?? "");
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, defaultBaseId]);

	/** Resets the form to its defaults (called on close + after a successful create). */
	function reset() {
		setName("");
		setMode("duplicate");
		setBaseId(defaultBase?.id ?? "");
	}

	async function submit() {
		if (!name.trim()) {
			toast.error("Environment name is required");
			return;
		}
		if (mode === "duplicate" && !baseId) {
			toast.error("Pick a base environment to duplicate");
			return;
		}
		setSubmitting(true);
		try {
			const { environment } =
				mode === "duplicate"
					? await duplicateEnvironment(projectId, baseId, name)
					: await addEnvironment(projectId, { name, stage: "development" });
			toast.success(
				mode === "duplicate" ? "Environment duplicated" : "Environment created",
			);
			onOpenChange(false);
			reset();
			await onCreated(environment.name);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to create environment");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (!v) reset();
				onOpenChange(v);
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>New Environment</DialogTitle>
					<DialogDescription>
						All the changes will be isolated from other environments, you can sync
						environments to pass changes.{" "}
						<a
							href={ENV_DOCS_HREF}
							target="_blank"
							rel="noreferrer"
							className="font-medium text-foreground underline underline-offset-2"
						>
							Learn More
						</a>
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="env-name" className="text-xs">
							Environment name
						</Label>
						<Input
							id="env-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="staging"
							className="h-9 text-sm"
							autoFocus
						/>
					</div>

					<div className="space-y-2">
						<ModeCard
							icon={<Copy className="h-4 w-4" />}
							title="Duplicate Environment"
							description="Copy all the services, variables, and configuration from an existing environment."
							selected={mode === "duplicate"}
							onSelect={() => setMode("duplicate")}
						>
							{mode === "duplicate" && (
								<div className="mt-3 space-y-1.5">
									<Label className="text-ui-xs text-muted-foreground">
										Base environment
									</Label>
									<Select value={baseId} onValueChange={setBaseId}>
										<SelectTrigger className="h-8 text-sm">
											<SelectValue placeholder="Select an environment" />
										</SelectTrigger>
										<SelectContent>
											{envs.map((e) => (
												<SelectItem key={e.id} value={e.id}>
													{e.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							)}
						</ModeCard>

						<ModeCard
							icon={<FileStack className="h-4 w-4" />}
							title="Empty Environment"
							description="An empty environment with no services or variables included."
							selected={mode === "empty"}
							onSelect={() => setMode("empty")}
						/>
					</div>
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={submitting}
					>
						Cancel
					</Button>
					<Button onClick={submit} disabled={submitting}>
						{submitting ? "Creating…" : "Create environment"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** A selectable option card for the creation mode (Duplicate / Empty). */
function ModeCard({
	icon,
	title,
	description,
	selected,
	onSelect,
	children,
}: {
	icon: React.ReactNode;
	title: string;
	description: string;
	selected: boolean;
	onSelect: () => void;
	children?: React.ReactNode;
}) {
	return (
		// A <div> (not a <button>) so interactive `children` (the Base-environment Select, whose
		// Radix trigger is itself a <button>) aren't nested inside the selection button — nested
		// buttons are invalid HTML and cause a hydration error.
		<div
			className={cn(
				"w-full rounded-lg border transition-colors",
				selected
					? "border-foreground/30 bg-muted/40 ring-1 ring-foreground/20"
					: "border-border hover:bg-muted/30",
			)}
		>
			<button
				type="button"
				onClick={onSelect}
				aria-pressed={selected}
				className="flex w-full items-start gap-2.5 p-3 text-left"
			>
				<span className="mt-0.5 text-muted-foreground">{icon}</span>
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium text-foreground">{title}</p>
					<p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
				</div>
			</button>
			{children && <div className="pb-3 pl-[2.375rem] pr-3">{children}</div>}
		</div>
	);
}
