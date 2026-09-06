"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { coerceEnum } from "@/lib/coerce";
import type {
	EnvironmentLifecycle,
	EnvironmentStage,
	PlacementMode,
} from "@/lib/db/schema";
import type { EnvironmentSpec } from "@/lib/queries/projects";
import { cn } from "@repo/ui/utils";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Switch } from "@repo/ui/switch";

/** A row in the onboarding environment catalog — the default fan-out the selector starts from. */
interface EnvironmentTemplate {
	name: string;
	stage: EnvironmentStage;
	/** Human label + one-line intent shown in the row. */
	label: string;
	description: string;
	placement_mode: PlacementMode;
	namespace?: string;
	lifecycle?: EnvironmentLifecycle;
	/** Production is the default env — always on, can't be toggled off. */
	required?: boolean;
}

/** The four environments the front door seeds by default (the #844 matrix). Order is display order. */
const ENVIRONMENT_CATALOG: EnvironmentTemplate[] = [
	{
		name: "production",
		stage: "production",
		label: "Production",
		description: "Its own isolated cluster.",
		placement_mode: "dedicated",
		required: true,
	},
	{
		name: "staging",
		stage: "staging",
		label: "Staging",
		description: "A dedicated pre-prod cluster.",
		placement_mode: "dedicated",
	},
	{
		name: "dev",
		stage: "development",
		label: "Development",
		description: "A namespace on a shared cluster.",
		placement_mode: "namespace",
		namespace: "dev",
	},
	{
		name: "preview",
		stage: "development",
		label: "Preview",
		description: "Ephemeral namespaces for pull requests.",
		placement_mode: "namespace",
		namespace: "preview",
		lifecycle: "ephemeral",
	},
];

/** Placement options in cost/isolation order, with the copy shown in the dropdown. */
const PLACEMENT_META: Record<PlacementMode, { label: string; hint: string }> = {
	namespace: { label: "Namespace", hint: "Shares a cluster — cheapest." },
	vcluster: {
		label: "Virtual cluster",
		hint: "Own control plane on a shared cluster.",
	},
	dedicated: { label: "Dedicated", hint: "Its own cluster (1:1)." },
};

const PLACEMENT_ORDER: PlacementMode[] = ["namespace", "vcluster", "dedicated"];

/** The default environment matrix — the initial value the host form seeds the selector with. */
export const DEFAULT_ENVIRONMENT_MATRIX: EnvironmentSpec[] =
	ENVIRONMENT_CATALOG.map((t) => ({
		name: t.name,
		stage: t.stage,
		placement_mode: t.placement_mode,
		lifecycle: t.lifecycle,
		namespace: t.placement_mode === "dedicated" ? null : (t.namespace ?? t.name),
		is_default: t.required ?? false,
	}));

interface PlacementSelectorProps {
	/** The enabled environments (a subset of the catalog); production is always present. */
	value: EnvironmentSpec[];
	onChange: (envs: EnvironmentSpec[]) => void;
}

/**
 * The onboarding placement selector (#844): choose which environments a new project seeds and how
 * each is placed onto a Fabric. Renders the four-environment catalog — production is always on; the
 * others toggle — each with a placement dropdown (`namespace` · `vcluster` · `dedicated`). Emits an
 * {@link EnvironmentSpec}[] that `createProject` fans out: a Fabric per `dedicated` env, with the
 * namespace/vcluster envs placed onto the default dedicated env's Fabric — only a dedicated env
 * provisions a cluster, so a tier placed anywhere else could never deploy. Everything is created
 * `DRAFT` — nothing provisions until a deploy — so seeding the full matrix is free.
 */
export function PlacementSelector({ value, onChange }: PlacementSelectorProps) {
	/** The spec for a catalog entry if it's currently enabled. */
	const enabledSpec = (name: string) => value.find((v) => v.name === name);

	/** Toggle an optional environment on/off, restoring its catalog default when re-enabled. */
	const toggle = (template: EnvironmentTemplate, on: boolean) => {
		if (template.required) return;
		if (on) {
			const restored: EnvironmentSpec = {
				name: template.name,
				stage: template.stage,
				placement_mode: template.placement_mode,
				lifecycle: template.lifecycle,
				namespace:
					template.placement_mode === "dedicated"
						? null
						: (template.namespace ?? template.name),
				is_default: false,
			};
			// Re-insert in catalog order so the emitted list stays stable.
			const next = ENVIRONMENT_CATALOG.map((t) =>
				t.name === template.name ? restored : enabledSpec(t.name),
			).filter((s): s is EnvironmentSpec => Boolean(s));
			onChange(next);
		} else {
			onChange(value.filter((v) => v.name !== template.name));
		}
	};

	/** Change one environment's placement, clearing/deriving its namespace to match. */
	const setPlacement = (template: EnvironmentTemplate, mode: PlacementMode) => {
		onChange(
			value.map((v) =>
				v.name === template.name
					? {
							...v,
							placement_mode: mode,
							namespace:
								mode === "dedicated"
									? null
									: (v.namespace ?? template.namespace ?? template.name),
						}
					: v,
			),
		);
	};

	return (
		<div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
			{ENVIRONMENT_CATALOG.map((template) => {
				const spec = enabledSpec(template.name);
				const on = Boolean(spec);
				return (
					<div
						key={template.name}
						className={cn(
							"flex items-center gap-4 px-4 py-3 transition-colors",
							!on && "opacity-55",
						)}
					>
						<Switch
							checked={on}
							disabled={template.required}
							onCheckedChange={(next) => toggle(template, next)}
							aria-label={`Include the ${template.label} environment`}
						/>
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<span className="text-ui-md font-medium text-foreground">
									{template.label}
								</span>
								{template.required && (
									<span className="rounded-full border border-border px-1.5 py-0.5 font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground">
										Default
									</span>
								)}
								{spec?.lifecycle === "ephemeral" && (
									<span className="rounded-full border border-border px-1.5 py-0.5 font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground">
										Ephemeral
									</span>
								)}
							</div>
							<p className="mt-0.5 truncate text-ui-xs text-muted-foreground">
								{template.description}
							</p>
						</div>
						<Select
							value={spec?.placement_mode ?? template.placement_mode}
							onValueChange={(v) =>
								setPlacement(
									template,
									coerceEnum(v, PLACEMENT_ORDER, template.placement_mode),
								)
							}
							disabled={!on}
						>
							<SelectTrigger className="w-[168px] shrink-0">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{PLACEMENT_ORDER.map((mode) => (
									<SelectItem key={mode} value={mode}>
										<span className="flex flex-col">
											<span>{PLACEMENT_META[mode].label}</span>
											<span className="text-ui-2xs text-muted-foreground">
												{PLACEMENT_META[mode].hint}
											</span>
										</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				);
			})}
		</div>
	);
}
