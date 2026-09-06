"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { StatusDot } from "@/components/environments/env-ui";
import { coerceEnum } from "@/lib/coerce";
import type {
	EnvironmentLifecycle,
	EnvironmentStage,
	PlacementMode,
} from "@/lib/db/schema";
import type { EnvironmentSpec } from "@/lib/queries/projects";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Switch } from "@repo/ui/switch";
import { cn } from "@repo/ui/utils";

/** One environment in the onboarding catalog, grouped by stage like the environments view. */
interface EnvTemplate {
	name: string;
	stage: EnvironmentStage;
	group: string;
	placement_mode: PlacementMode;
	namespace?: string;
	lifecycle?: EnvironmentLifecycle;
	/** Production is the default env — always on. */
	required?: boolean;
}

/** The four seeded environments (#844 matrix), ordered + grouped by stage. */
const CATALOG: EnvTemplate[] = [
	{
		name: "production",
		stage: "production",
		group: "Production",
		placement_mode: "dedicated",
		required: true,
	},
	{
		name: "staging",
		stage: "staging",
		group: "Staging",
		placement_mode: "dedicated",
	},
	{
		name: "dev",
		stage: "development",
		group: "Development",
		placement_mode: "namespace",
		namespace: "dev",
	},
	{
		name: "preview",
		stage: "development",
		group: "Development",
		placement_mode: "namespace",
		namespace: "preview",
		lifecycle: "ephemeral",
	},
];

const GROUP_ORDER = ["Production", "Staging", "Development"];

const PLACEMENT_LABEL: Record<PlacementMode, string> = {
	namespace: "Namespace",
	vcluster: "Virtual cluster",
	dedicated: "Dedicated",
};
const PLACEMENT_ORDER: PlacementMode[] = ["namespace", "vcluster", "dedicated"];

interface EnvironmentPlacementProps {
	/** The enabled environments (production always present). */
	value: EnvironmentSpec[];
	onChange: (envs: EnvironmentSpec[]) => void;
}

/**
 * The Configure step's environments section — the create-time placement chooser rendered in the
 * **environments-view idiom** (stage-grouped, mono headers, `StatusDot`, `Default` marker). It edits
 * the same {@link EnvironmentSpec}[] the #844 fan-out consumes: production is always on; staging /
 * dev / preview toggle, each with a placement dropdown. Everything is a draft until deploy.
 */
export function EnvironmentPlacement({
	value,
	onChange,
}: EnvironmentPlacementProps) {
	const enabledSpec = (name: string) => value.find((v) => v.name === name);

	/** Toggle an optional env on/off, restoring its catalog default (in catalog order). */
	const toggle = (t: EnvTemplate, on: boolean) => {
		if (t.required) return;
		if (on) {
			const restored: EnvironmentSpec = {
				name: t.name,
				stage: t.stage,
				placement_mode: t.placement_mode,
				lifecycle: t.lifecycle,
				namespace:
					t.placement_mode === "dedicated" ? null : (t.namespace ?? t.name),
				is_default: false,
			};
			const next = CATALOG.map((c) =>
				c.name === t.name ? restored : enabledSpec(c.name),
			).filter((s): s is EnvironmentSpec => Boolean(s));
			onChange(next);
		} else {
			onChange(value.filter((v) => v.name !== t.name));
		}
	};

	/** Change one env's placement, deriving/clearing its namespace to match. */
	const setPlacement = (t: EnvTemplate, mode: PlacementMode) => {
		onChange(
			value.map((v) =>
				v.name === t.name
					? {
							...v,
							placement_mode: mode,
							namespace:
								mode === "dedicated"
									? null
									: (v.namespace ?? t.namespace ?? t.name),
						}
					: v,
			),
		);
	};

	return (
		<div className="space-y-5">
			{GROUP_ORDER.map((group) => {
				const items = CATALOG.filter((c) => c.group === group);
				return (
					<div key={group} className="space-y-2.5">
						<div className="font-mono text-ui-2xs uppercase tracking-[0.16em] text-muted-foreground">
							{group}
						</div>
						<div className="space-y-2.5">
							{items.map((t) => {
								const spec = enabledSpec(t.name);
								const on = Boolean(spec);
								return (
									<div
										key={t.name}
										className={cn(
											"flex items-center gap-4 rounded-lg border bg-card p-4 shadow-sm transition-colors",
											!on && "opacity-55",
										)}
									>
										<Switch
											checked={on}
											disabled={t.required}
											onCheckedChange={(next) => toggle(t, next)}
											aria-label={`Include the ${t.name} environment`}
										/>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span className="font-mono text-ui-lg text-foreground">
													{t.name}
												</span>
												{t.required && (
													<span className="shrink-0 rounded-full border px-1.5 py-px font-mono text-ui-3xs uppercase tracking-wide text-muted-foreground">
														Default
													</span>
												)}
											</div>
											<StatusDot
												tier="idle"
												label={
													spec?.lifecycle === "ephemeral" ? "Ephemeral" : "Draft"
												}
												className="mt-1.5 text-ui-xs"
											/>
										</div>
										<Select
											value={spec?.placement_mode ?? t.placement_mode}
											onValueChange={(v) =>
												setPlacement(
													t,
													coerceEnum(v, PLACEMENT_ORDER, t.placement_mode),
												)
											}
											disabled={!on}
										>
											<SelectTrigger className="w-[168px] shrink-0">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{PLACEMENT_ORDER.map((m) => (
													<SelectItem key={m} value={m}>
														{PLACEMENT_LABEL[m]}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
								);
							})}
						</div>
					</div>
				);
			})}
		</div>
	);
}
