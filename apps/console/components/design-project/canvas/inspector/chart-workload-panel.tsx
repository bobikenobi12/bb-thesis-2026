"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The panel behind a DESCRIBED chart-workload card (W5 Path A — Option B).
//
// It is deliberately READ-MOSTLY, which is what keeps it distinct from the first-class `service`
// panel (the two-model invariant). The `rendered` description — image, kind, ports, env KEY NAMES,
// resources, replicas — comes straight from `helm template` and is OVERWRITTEN on every re-scan, so
// it is shown read-only: editing it would be editing the chart, not this overlay. What the user CAN
// edit is the overlay the chart's own `values` don't already pin: the W3 bindings (reusing the exact
// service binding editor), the v1 `replicas`/`env`, and the value-path override that says where each
// knob writes into the chart's values. The overlay is persisted through Lane 2's (#664) server
// actions (`setChartWorkloadBindings` / `setChartWorkloadConfig` / `setChartWorkloadValuePaths`);
// Lane 2 also infers value-paths for new bindings and composes the overlay into the chart's Helm
// values at deploy (keyless secret-refs for credential facets).

import { useEffect, useState } from "react";
import { Package, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import {
	setChartWorkloadBindings,
	setChartWorkloadConfig,
	setChartWorkloadValuePaths,
} from "@/app/server/actions/byo-charts";
import { useByoChartCanvas } from "@/components/design-project/byo/byo-chart-canvas-context";
import type {
	ChartValuePathMap,
	ChartWorkloadConfig,
	ServiceBinding,
	ServiceEnvVar,
} from "@/types/jsonb.types";
import { type CanvasNode, nodeOfKind } from "../graph/types";
import { BindingsField } from "./bindings-field";

/** The user-editable overlay this panel stages. */
interface Overlay {
	bindings: ServiceBinding[];
	config: ChartWorkloadConfig;
	valuePaths: ChartValuePathMap;
}

/** Value-paths are an object; the editor needs stable ordered rows, so it edits a [key, path] list. */
type PathRow = [key: string, path: string];

/** Snapshot the node's persisted overlay into the local draft shape. */
function overlayOf(config: CanvasNode<"chart_workload">["data"]["config"]): Overlay {
	return {
		bindings: config.bindings ?? [],
		config: config.config ?? {},
		valuePaths: config.valuePaths ?? {},
	};
}

/** The read-mostly config + bind panel for one described chart workload. */
export function ChartWorkloadPanel({ nodeId }: { nodeId: string }) {
	const raw = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId));
	const node = nodeOfKind(raw, "chart_workload");
	const openInspector = useCanvasStore((s) => s.openInspector);
	const ctx = useByoChartCanvas();
	const [draft, setDraft] = useState<Overlay | null>(null);
	const [saving, setSaving] = useState(false);

	// Seed (and re-seed on a different node) the editable draft from the persisted overlay. Keyed on
	// nodeId only, so a background re-scan refresh never clobbers in-flight unsaved edits.
	useEffect(() => {
		setDraft(node ? overlayOf(node.data.config) : null);
	}, [nodeId, node]);

	if (!node || !draft) return null;
	const config = node.data.config;
	const r = config.rendered;

	const dirty = JSON.stringify(draft) !== JSON.stringify(overlayOf(config));
	const pathRows: PathRow[] = Object.entries(draft.valuePaths);

	const setPathRows = (rows: PathRow[]) =>
		setDraft({
			...draft,
			valuePaths: Object.fromEntries(rows.filter(([k]) => k.trim() !== "")),
		});
	const env = draft.config.env ?? [];
	const setEnv = (next: ServiceEnvVar[]) =>
		setDraft({ ...draft, config: { ...draft.config, env: next } });

	const save = async () => {
		if (!ctx) return;
		const base = overlayOf(config);
		const pid = ctx.projectId;
		const wid = config.id;
		setSaving(true);
		try {
			// Persist only the parts that changed, via Lane 2's (#664) granular setters. Bindings first:
			// setChartWorkloadBindings infers + merges value-paths for new bindings, so the explicit
			// value-path override must run after it to win.
			if (JSON.stringify(draft.bindings) !== JSON.stringify(base.bindings)) {
				await setChartWorkloadBindings({ projectId: pid, workloadId: wid, bindings: draft.bindings });
			}
			if (JSON.stringify(draft.config) !== JSON.stringify(base.config)) {
				await setChartWorkloadConfig({ projectId: pid, workloadId: wid, config: draft.config });
			}
			if (JSON.stringify(draft.valuePaths) !== JSON.stringify(base.valuePaths)) {
				await setChartWorkloadValuePaths({ projectId: pid, workloadId: wid, valuePaths: draft.valuePaths });
			}
			toast.success("Workload overlay saved.");
			ctx.refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Could not save the overlay.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex h-full flex-col">
			{/* Header — dashed icon plate echoes the node's `external` (not-owned) treatment. */}
			<div className="flex items-start gap-3 border-b border-border p-4">
				<span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-none border border-dashed text-muted-foreground">
					<Package className="h-4 w-4" />
				</span>
				<div className="min-w-0 flex-1 space-y-1">
					<div className="truncate text-sm font-semibold">{config.name}</div>
					<div className="flex flex-wrap items-center gap-2">
						<span className="vx-eyebrow rounded-none border border-border px-1.5 py-0.5">
							Chart workload
						</span>
						<span className="font-mono text-ui-2xs text-muted-foreground">
							{config.kind} · {config.chartId}
						</span>
					</div>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="h-7 w-7 shrink-0"
					onClick={() => openInspector(null)}
					aria-label="Close"
				>
					<X className="h-4 w-4" />
				</Button>
			</div>

			<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-10 pt-4 text-sm">
				{/* Read-only description — mirrors the chart, overwritten each scan. */}
				<section className="space-y-2">
					<span className="vx-eyebrow">Described from the chart</span>
					<p className="text-ui-xs leading-relaxed text-muted-foreground">
						Read-only — extracted from <span className="font-mono">helm template</span> and
						refreshed on every scan. The chart stays the deploy unit; these rows only describe
						what it runs.
					</p>
					<dl className="grid grid-cols-[5.5rem_1fr] gap-y-1.5 border border-border bg-surface-sunken px-3 py-2.5 text-xs">
						<dt className="text-muted-foreground">Image</dt>
						<dd className="truncate font-mono" title={r.image}>
							{r.image || "—"}
						</dd>
						<dt className="text-muted-foreground">Kind</dt>
						<dd className="font-mono">{config.kind}</dd>
						<dt className="text-muted-foreground">Replicas</dt>
						<dd className="font-mono">{r.replicas != null ? r.replicas : "—"}</dd>
						{r.ports.length > 0 && (
							<>
								<dt className="text-muted-foreground">Ports</dt>
								<dd className="font-mono">
									{r.ports
										.map((p) => `${p.container_port}${p.protocol ? `/${p.protocol}` : ""}`)
										.join(" · ")}
								</dd>
							</>
						)}
						{r.resources && (
							<>
								<dt className="text-muted-foreground">Resources</dt>
								<dd className="font-mono text-ui-xs">
									{r.resources.requests.cpu}/{r.resources.requests.memory} →{" "}
									{r.resources.limits.cpu}/{r.resources.limits.memory}
								</dd>
							</>
						)}
					</dl>
					{r.env_keys.length > 0 && (
						<div className="space-y-1">
							<span className="vx-eyebrow text-ui-3xs">Rendered env · keys only</span>
							<div className="flex flex-wrap gap-1">
								{r.env_keys.map((k) => (
									<span
										key={k}
										className="border border-border px-1.5 py-0.5 font-mono text-ui-2xs text-muted-foreground"
									>
										{k}
									</span>
								))}
							</div>
						</div>
					)}
				</section>

				{/* Bindings — the W3 editor, reused verbatim (the read model uses serviceBindingSchema). */}
				<section className="space-y-2 border-t border-border/60 pt-4">
					<span className="vx-eyebrow">Bindings</span>
					<BindingsField
						value={draft.bindings}
						onChange={(next) => setDraft({ ...draft, bindings: next })}
					/>
				</section>

				{/* Editable overlay (v1): replicas + env. Written into the chart's values on deploy (Lane 2). */}
				<section className="space-y-2 border-t border-border/60 pt-4">
					<span className="vx-eyebrow">Overrides</span>
					<div className="space-y-1">
						<span className="vx-eyebrow text-ui-3xs">Replicas</span>
						<Input
							type="number"
							min={0}
							value={draft.config.replicas ?? ""}
							placeholder={r.replicas != null ? String(r.replicas) : "from chart"}
							className="h-8 w-28 font-mono text-xs"
							onChange={(e) =>
								setDraft({
									...draft,
									config: {
										...draft.config,
										replicas:
											e.target.value === "" ? undefined : Number(e.target.value),
									},
								})
							}
						/>
					</div>
					<EnvEditor value={env} onChange={setEnv} />
				</section>

				{/* Value-path override — where each knob writes into the chart's Helm values (Lane 2 infers
				    these; this is the manual override affordance). */}
				<section className="space-y-2 border-t border-border/60 pt-4">
					<span className="vx-eyebrow">Value paths</span>
					<p className="font-mono text-ui-xs leading-relaxed text-muted-foreground">
						Where a knob writes into the chart&rsquo;s values (e.g.{" "}
						<span className="text-foreground">replicas → replicaCount</span>). Auto-inferred on
						scan; override here when the chart&rsquo;s shape is non-standard.
					</p>
					<PathEditor rows={pathRows} onChange={setPathRows} />
				</section>
			</div>

			{/* Commit bar — the overlay is out-of-band, so it never enters the Pending Changes diff; it's
			    saved straight to the row. */}
			<div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
				<span className="text-ui-xs text-muted-foreground">
					{ctx
						? dirty
							? "Unsaved overlay changes"
							: "Overlay in sync"
						: "Read-only (no project context)"}
				</span>
				<Button
					type="button"
					size="sm"
					disabled={!ctx || !dirty || saving}
					onClick={save}
				>
					{saving ? "Saving…" : "Save overlay"}
				</Button>
			</div>
		</div>
	);
}

/** A minimal name→value env editor (the workload's editable env overlay). */
function EnvEditor({
	value,
	onChange,
}: {
	value: ServiceEnvVar[];
	onChange: (next: ServiceEnvVar[]) => void;
}) {
	return (
		<div className="space-y-1.5">
			<span className="vx-eyebrow text-ui-3xs">Env</span>
			{value.map((row, i) => (
				// Positional rows — the index is their identity.
				<div key={i} className="flex items-center gap-1.5">
					<Input
						value={row.name}
						placeholder="NAME"
						className="h-8 flex-1 font-mono text-xs"
						onChange={(e) =>
							onChange(value.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
						}
					/>
					<Input
						value={row.value}
						placeholder="value"
						className="h-8 flex-1 font-mono text-xs"
						onChange={(e) =>
							onChange(value.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
						}
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
						aria-label="Remove env var"
						onClick={() => onChange(value.filter((_, j) => j !== i))}
					>
						<X className="h-3.5 w-3.5" />
					</Button>
				</div>
			))}
			<button
				type="button"
				onClick={() => onChange([...value, { name: "", value: "" }])}
				className="flex items-center gap-1.5 rounded-sm border border-dashed border-border-strong px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
			>
				<Plus className="h-3.5 w-3.5" />
				Add env var
			</button>
		</div>
	);
}

/** A minimal knob→dot-path editor for the value-path override. */
function PathEditor({
	rows,
	onChange,
}: {
	rows: PathRow[];
	onChange: (next: PathRow[]) => void;
}) {
	return (
		<div className="space-y-1.5">
			{rows.map(([key, path], i) => (
				// Positional rows — the index is their identity.
				<div key={i} className="flex items-center gap-1.5">
					<Input
						value={key}
						placeholder="knob"
						className="h-8 flex-1 font-mono text-xs"
						onChange={(e) =>
							onChange(rows.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))
						}
					/>
					<span className="shrink-0 font-mono text-xs text-muted-foreground">→</span>
					<Input
						value={path}
						placeholder="dot.path.in.values"
						className="h-8 flex-1 font-mono text-xs"
						onChange={(e) =>
							onChange(rows.map((x, j) => (j === i ? [x[0], e.target.value] : x)))
						}
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
						aria-label="Remove value path"
						onClick={() => onChange(rows.filter((_, j) => j !== i))}
					>
						<X className="h-3.5 w-3.5" />
					</Button>
				</div>
			))}
			<button
				type="button"
				onClick={() => onChange([...rows, ["", ""]])}
				className="flex items-center gap-1.5 rounded-sm border border-dashed border-border-strong px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
			>
				<Plus className="h-3.5 w-3.5" />
				Add value path
			</button>
		</div>
	);
}
