"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowLeft, TriangleAlert, X } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { formatMonthlyRate } from "@repo/format";
import { Alert, AlertDescription } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { CopyButton } from "@repo/ui/copy-button";
import { Input } from "@repo/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/tabs";
import { StatusBadge } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import {
	NODE_STATUS_META,
	useNodeStatus,
	type NodeStatusMeta,
	type NodeStatusState,
} from "@/lib/canvas/node-status";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { ago, JOB_LABEL, JOB_STATUS } from "@/lib/canvas/job-display";
import type {
	EnvironmentInfo,
	EnvironmentJob,
} from "@/lib/canvas/component-status";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import {
	collectionNodeId,
	isCollectionKind,
	kindFromCollectionId,
} from "@/lib/canvas/collections";
import { DeployPane } from "@/components/agent/deploy-pane";
import { ChartWorkloadPanel } from "./inspector/chart-workload-panel";
import { CollectionPanel } from "./inspector/collection-panel";
import { ExternalPanel } from "./inspector/external-panel";
import { NODE_REGISTRY } from "./graph/node-registry";
import type { CanvasNode } from "./graph/types";
import { configName } from "./graph/node-config";
import { getKindConfig, type KindConfig } from "./inspector/config-schema";
import { ConfigFields } from "./inspector/config-fields";
import { DangerZone } from "./inspector/danger-zone";
import { useNodeCapabilities } from "./inspector/use-node-capabilities";

interface InspectorPanelProps {
	/** Edit mode only: tear down the active environment (queues a DESTROY job). Surfaced as a
	 * danger action on the project settings panel. */
	onDestroyEnvironment?: () => void;
}

/**
 * The service-config body of the canvas's inline docked side panel. Configures the selected node:
 * a header (resource icon, editable name, type badge, live one-line summary, close) over
 * Overview · Cost · Activity · Settings tabs. Settings is built data-drivenly from the node's config
 * schema (collapsible sections, radio-cards, typed fields) plus a Danger zone; Cost breaks the
 * node's monthly spend down by Terraform address; Activity is the environment's recent job history.
 * Rendered only when a node is selected (`inspectorNodeId`).
 *
 * The cloud account is NOT set here — it's chosen once, at project creation, so there is no per-node
 * cloud selector. The effective provider is still resolved (it drives facts, zones, and the schema
 * summary), just never edited on the board.
 */
export function InspectorPanel({ onDestroyEnvironment }: InspectorPanelProps) {
	const inspectorNodeId = useCanvasStore((s) => s.inspectorNodeId);
	const node = useCanvasStore((s) =>
		inspectorNodeId ? s.nodes.find((n) => n.id === inspectorNodeId) : undefined,
	);
	const openInspector = useCanvasStore((s) => s.openInspector);
	const updateNodeConfig = useCanvasStore((s) => s.updateNodeConfig);
	const getEffectiveProvider = useCanvasStore((s) => s.getEffectiveProvider);

	const env = useEnvironmentStatus();
	const core = useCanvasStore((s) => s.getCoreIdentity());
	const provider = node ? getEffectiveProvider(node.id) : null;
	// Account-scoped picker options for THIS node's effective identity.
	const capabilities = useNodeCapabilities(node?.id ?? null);
	const def = node ? NODE_REGISTRY[node.data.kind] : null;
	const schema = node ? getKindConfig(node.data.kind) : undefined;

	// The project panel binds to the REAL environment being viewed. Its stage is a fact of that
	// environment, not a free choice — so when we're on a provisioned env the static `environment_stage`
	// radio is dropped (surfaced read-only above instead). In the create flow there's no env row yet
	// (`environment` is null), so the radio stays: it's what seeds the first environment's stage.
	const realEnv = node?.data.kind === "project" ? env.environment : null;
	const settingsSchema =
		realEnv && schema ? withoutField(schema, "environment_stage") : schema;

	// A collection card (the Secrets vault) is synthetic — it has no store row, so its id resolves to
	// no node. It gets the list panel instead, which is where its resources are actually managed.
	const collectionKind = inspectorNodeId ? kindFromCollectionId(inspectorNodeId) : null;
	if (collectionKind) return <CollectionPanel kind={collectionKind} />;

	if (!node || !def) return null;

	// An EXTERNAL card belongs to a bring-your-own IaC module. It has no editable config — changing
	// one of those resources means editing the customer's Terraform, not this panel — so it gets the
	// read-only member list instead of the config form (which would otherwise render an editable name
	// field and write a `name` into a config that has none).
	if (node.data.kind === "external") return <ExternalPanel nodeId={node.id} />;

	// A described chart workload (W5 Path A) is read-mostly: its `rendered` description is owned by the
	// chart (overwritten each scan), and only the overlay (W3 bindings + replicas/env + value-paths)
	// is editable — so it gets its own panel, not the generic config form.
	if (node.data.kind === "chart_workload")
		return <ChartWorkloadPanel nodeId={node.id} />;

	const gated =
		def.classification === "core" &&
		!!core &&
		(node.data.cloud_identity_id ?? core) !== core;

	// Which config key (if any) holds this node's editable display name.
	const nameKey =
		node.data.kind === "project"
			? "project_name"
			: NODE_REGISTRY[node.data.kind].cardinality === "array"
				? "name"
				: null;

	const Icon = def.icon;
	const summary = schema
		? schema.summary(node.data.config, provider)
		: undefined;

	// The GitOps Deploy tab (#574) is environment-wide, so it lives on the cluster — the
	// environment's control-plane node, where ArgoCD/gitops already surface (the cluster card's
	// ArgoCD section). It reads the same `env.gitops` the artifact panel's Deploy tab does,
	// riding the already-polled EnvironmentStatus — no per-node fetch.
	const showDeploy = node.data.kind === "cluster";

	// A member of a collapsed kind has no card of its own on the board, so without a way back up
	// you'd be stranded in a secret with no route to the vault it belongs to.
	const parentCollection = isCollectionKind(node.data.kind) ? node.data.kind : null;

	return (
		<div className="flex h-full flex-col">
			{parentCollection && (
				<button
					type="button"
					onClick={() => openInspector(collectionNodeId(parentCollection))}
					className="flex items-center gap-1.5 border-b border-border px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				>
					<ArrowLeft className="h-3.5 w-3.5" />
					{NODE_REGISTRY[parentCollection].collection?.title}
				</button>
			)}
			<div className="flex items-start gap-3 border-b border-border p-4">
				{Icon && (
					<span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-none border text-muted-foreground">
						<Icon className="h-4 w-4" />
					</span>
				)}
				<div className="min-w-0 flex-1 space-y-1">
					<div className="flex flex-wrap items-center gap-2">
						{nameKey ? (
							<Input
								value={configName(node.data) ?? ""}
								maxLength={nameKey === "project_name" ? 50 : undefined}
								placeholder={nameKey === "project_name" ? "My Project" : "name"}
								onChange={(e) =>
									updateNodeConfig(node.id, {
										[nameKey]:
											nameKey === "project_name"
												? e.target.value
												: e.target.value.toLowerCase(),
									})
								}
								className={cn(
									"h-8 max-w-[16rem] border-0 bg-transparent px-0 text-base font-semibold shadow-none focus-visible:ring-0",
									nameKey === "name" && "font-mono",
								)}
							/>
						) : (
							<span className="text-base font-semibold">{def.label}</span>
						)}
						<span className="vx-eyebrow rounded-none border border-border px-1.5 py-0.5">
							{def.eyebrow}
						</span>
					</div>
					<p className="truncate text-xs text-muted-foreground">
						{summary ||
							(def.classification === "root"
								? "Project basics and the stack's core cloud account."
								: def.classification === "core"
									? "Core resource — must run on the stack's cloud."
									: "Periphery — may run on any connected cloud.")}
					</p>
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

			<StatusHeader nodeId={node.id} />

			<Tabs
				defaultValue="overview"
				className="flex min-h-0 flex-1 flex-col gap-0"
			>
				<TabsList
					className={cn(
						"mx-4 mt-3 grid shrink-0",
						showDeploy ? "grid-cols-5" : "grid-cols-4",
					)}
				>
					<TabsTrigger value="overview">Overview</TabsTrigger>
					<TabsTrigger value="cost">Cost</TabsTrigger>
					<TabsTrigger value="activity">Activity</TabsTrigger>
					{showDeploy && <TabsTrigger value="deploy">Deploy</TabsTrigger>}
					<TabsTrigger value="settings">Settings</TabsTrigger>
				</TabsList>

				<TabsContent
					value="overview"
					className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-4"
				>
					<Overview node={node} />
				</TabsContent>

				<TabsContent
					value="cost"
					className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-4"
				>
					<CostTab node={node} />
				</TabsContent>

				<TabsContent
					value="activity"
					className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-4"
				>
					<ActivityTab />
				</TabsContent>

				{showDeploy && (
					<TabsContent
						value="deploy"
						className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-4"
					>
						<DeployPane status={env.gitops} />
					</TabsContent>
				)}

				<TabsContent
					value="settings"
					className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-10 pt-4"
				>
					{gated && (
						<Alert variant="default" className="border-border bg-muted">
							<AlertDescription className="text-xs">
								This core resource sits on a different cloud than the stack. Hot
								cross-cloud data-plane edges are on the roadmap — it can be
								drawn, but the project will not provision until colocated.
							</AlertDescription>
						</Alert>
					)}

					{realEnv && <EnvironmentBlock env={realEnv} />}

					{settingsSchema && (
						<ConfigFields
							schema={settingsSchema}
							config={node.data.config}
							provider={provider}
							kind={node.data.kind}
							capabilities={capabilities}
							onChange={(patch) => updateNodeConfig(node.id, patch)}
						/>
					)}

					{node.data.kind === "project" && onDestroyEnvironment && (
						<DestroyEnvironmentZone onDestroy={onDestroyEnvironment} />
					)}

					<DangerZone node={node} />
				</TabsContent>
			</Tabs>
		</div>
	);
}

/** Returns a copy of a config schema with one field removed from every section. */
function withoutField(schema: KindConfig, key: string): KindConfig {
	return {
		...schema,
		sections: schema.sections.map((s) => ({
			...s,
			fields: s.fields.filter((f) => f.key !== key),
		})),
	};
}

/** A provisioning status → the board's grayscale dot vocabulary. Status never reads as hue. */
const ENV_STATUS_VX: Record<string, NodeStatusMeta["vx"]> = {
	DRAFT: "idle",
	QUEUED: "pending",
	PROVISIONING: "live",
	ACTIVE: "active",
	FAILED: "failed",
	DESTROYING: "pending",
	DESTROYED: "disabled",
};

/**
 * The real environment the project panel is bound to — its name, stage, and provisioning status,
 * read straight from `project_environments`. This is what replaces the old free-choice stage radio:
 * the stage is a fact of the environment you're viewing, not something you pick on the board.
 */
function EnvironmentBlock({ env }: { env: EnvironmentInfo }) {
	const vx = ENV_STATUS_VX[env.status] ?? "idle";
	return (
		<div className="border border-border bg-surface-sunken">
			<div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
				<span className="vx-eyebrow">Environment</span>
				<StatusBadge
					status={env.status}
					tier={vx}
					label={env.status.charAt(0) + env.status.slice(1).toLowerCase()}
					className="shrink-0"
				/>
			</div>
			<dl className="grid grid-cols-[5rem_1fr] gap-y-1.5 px-3 py-2.5 text-xs">
				<dt className="text-muted-foreground">Name</dt>
				<dd className="truncate font-mono">{env.name}</dd>
				<dt className="text-muted-foreground">Stage</dt>
				<dd className="capitalize">{env.stage}</dd>
			</dl>
		</div>
	);
}

/** Project-panel danger action: tear down the active environment's provisioned infra. */
function DestroyEnvironmentZone({ onDestroy }: { onDestroy: () => void }) {
	const [confirm, setConfirm] = useState(false);
	return (
		<div className="rounded-none border border-destructive/30">
			<div className="flex items-center gap-2 border-b border-destructive/20 px-4 py-3">
				<TriangleAlert className="h-4 w-4 text-destructive" />
				<p className="text-sm font-medium text-destructive">Danger zone</p>
			</div>
			<div className="flex items-center justify-between gap-4 px-4 py-4">
				<div className="min-w-0">
					<p className="text-sm font-medium">Destroy environment</p>
					<p className="text-xs text-muted-foreground">
						Queue a teardown of the provisioned infrastructure for this environment.
					</p>
				</div>
				<Button
					type="button"
					variant="destructive"
					size="sm"
					onClick={() => setConfirm(true)}
				>
					Destroy
				</Button>
			</div>
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title="Destroy this environment?"
				description="This queues a DESTROY job that tears down the environment's provisioned cloud infrastructure. This cannot be undone."
				confirmLabel="Destroy environment"
				onConfirm={onDestroy}
			/>
		</div>
	);
}

/** The default line for a state when the server gave us no message of its own. */
const STATUS_HINT: Partial<Record<NodeStatusState, string>> = {
	gated: "Cross-cloud core placement — won't provision until colocated.",
	ready: "Configured and ready to deploy.",
	live: "Provisioned and matching the design.",
	"not-deployed": "Designed, but never applied.",
	queued: "Waiting for a runner to claim the job.",
	applying: "The runner is applying this resource now.",
	updating: "An apply is changing this resource in place.",
	"update-pending": "The design has moved ahead of what's deployed.",
	destroying: "Teardown in flight.",
	destroyed: "Torn down. Remove it from the design to clear it.",
	failed: "The last apply failed.",
	unreachable: "The cluster's API server did not answer the last probe.",
};

/**
 * A compact status strip under the inspector header: the node's RESOLVED status (design readiness
 * merged with the environment's server truth) and the most actionable line — the server's own
 * failure message when there is one, else a hint for the state. Drift rides alongside as an
 * overlay chip rather than replacing the state, because a drifted resource is still live.
 */
function StatusHeader({ nodeId }: { nodeId: string }) {
	const status = useNodeStatus(nodeId);
	const meta = NODE_STATUS_META[status.state];
	const drifted = status.drift.length;
	return (
		<div className="flex items-center gap-2.5 border-b border-border bg-surface-sunken/60 px-4 py-2.5">
			<StatusBadge status={meta.label} tier={meta.vx} className="shrink-0" />
			<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
				{status.message ?? STATUS_HINT[status.state] ?? ""}
			</span>
			{drifted > 0 && (
				<span
					className="shrink-0 border border-border-strong px-1.5 py-0.5 font-mono text-ui-2xs text-foreground"
					title={status.drift.map((d) => d.address).join("\n")}
				>
					{drifted} drifted
				</span>
			)}
		</div>
	);
}

/** Read-only summary of a node: its resolved status, cost, recent activity, drift, and config. */
function Overview({ node }: { node: CanvasNode }) {
	const status = useNodeStatus(node.id);
	const env = useEnvironmentStatus();
	const meta = NODE_STATUS_META[status.state];
	const def = NODE_REGISTRY[node.data.kind];
	// Only show scalar config (skip nested objects/arrays — those have their own UIs).
	const rows = Object.entries(node.data.config).filter(
		([, v]) => v != null && typeof v !== "object" && String(v) !== "",
	);
	return (
		<div className="space-y-4 text-sm">
			{node.data.kind === "project" && env.environment && (
				<EnvironmentBlock env={env.environment} />
			)}

			<dl className="grid grid-cols-[8rem_1fr] gap-y-2">
				<dt className="text-muted-foreground">Type</dt>
				<dd>{def.label}</dd>
				<dt className="text-muted-foreground">Status</dt>
				<dd className="text-muted-foreground">
					{meta.label}
					{status.message ? ` — ${status.message}` : ""}
				</dd>
			</dl>

			{/* What the deploy actually PRODUCED. `endpoint` / `reader_endpoint` / `cluster_endpoint` /
			    `argocd_url` / `repository_url` are all written by the deploy finalizer and were, until
			    now, surfaced NOWHERE — you had to open the cloud console to find your own database's
			    hostname. */}
			{status.outputs.length > 0 && (
				<div className="space-y-2 border-t border-border/60 pt-3">
					<span className="vx-eyebrow">Endpoints</span>
					<dl className="space-y-1">
						{status.outputs.map((o) => (
							<div
								key={o.label}
								className="flex items-center gap-2 border border-border bg-surface-sunken px-2 py-1.5"
							>
								<dt className="shrink-0 text-ui-xs text-muted-foreground">
									{o.label}
								</dt>
								<dd className="min-w-0 flex-1 truncate text-right font-mono text-ui-xs">
									{o.value}
								</dd>
								<CopyButton text={o.value} className="h-6 w-6 shrink-0" />
							</div>
						))}
					</dl>
				</div>
			)}

			{/* What this resource costs, from the last plan's Infracost breakdown. Null = never priced;
			    we say nothing rather than a misleading $0. The Cost tab holds the per-address detail. */}
			{status.monthlyCost != null && (
				<div className="space-y-2 border-t border-border/60 pt-3">
					<span className="vx-eyebrow">Cost</span>
					<div className="flex items-baseline justify-between">
						<span className="text-xs text-muted-foreground">Monthly</span>
						<span className="font-mono text-sm font-semibold">
							{formatMonthlyRate(status.monthlyCost, "exact")}
						</span>
					</div>
				</div>
			)}

			{/* The environment's recent jobs — the same history the Activity tab and floating rail show,
			    condensed to the latest few so the Overview answers "what just happened here". */}
			{env.recentJobs.length > 0 && (
				<div className="space-y-2 border-t border-border/60 pt-3">
					<span className="vx-eyebrow">Recent activity</span>
					<JobList jobs={env.recentJobs.slice(0, 3)} />
				</div>
			)}

			{/* Drift is an overlay, not a state — it's listed on its own, per drifted resource, with
			    the Terraform address that actually diverged. */}
			{status.drift.length > 0 && (
				<div className="space-y-2 border-t border-border/60 pt-3">
					<span className="vx-eyebrow">
						Drift · {status.drift.length} resource
						{status.drift.length > 1 ? "s" : ""}
					</span>
					<ul className="space-y-1">
						{status.drift.map((d) => (
							<li
								key={d.address}
								className="flex items-center gap-2 border border-border bg-surface-sunken px-2 py-1 font-mono text-ui-2xs"
							>
								<span className="min-w-0 flex-1 truncate">{d.address}</span>
								<span className="vx-eyebrow shrink-0 text-ui-3xs">{d.kind}</span>
							</li>
						))}
					</ul>
				</div>
			)}

			{rows.length > 0 && (
				<div className="space-y-2 border-t border-border/60 pt-3">
					<span className="vx-eyebrow">Configuration</span>
					<dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-xs">
						{rows.map(([k, v]) => (
							<div key={k} className="contents">
								<dt className="text-muted-foreground">
									{k.replace(/_/g, " ")}
								</dt>
								<dd className="truncate font-mono">{String(v)}</dd>
							</div>
						))}
					</dl>
				</div>
			)}
		</div>
	);
}

/**
 * The Cost tab — the node's monthly spend broken down by Terraform address. The rollup and the
 * per-line detail both come from the last plan's Infracost breakdown (resolved on the node's status).
 * A resource that was never priced (never planned, or unpriceable) says so rather than showing $0 —
 * a confident zero would be a lie.
 */
function CostTab({ node }: { node: CanvasNode }) {
	const status = useNodeStatus(node.id);
	const env = useEnvironmentStatus();
	const lines = [...status.costLines].sort(
		(a, b) => b.monthlyCost - a.monthlyCost,
	);

	if (status.monthlyCost == null && lines.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">
				Not priced yet. Run a plan and this resource&apos;s estimated monthly cost
				will appear here.
			</p>
		);
	}

	return (
		<div className="space-y-4 text-sm">
			<div className="flex items-baseline justify-between border border-border bg-surface-sunken px-3 py-2.5">
				<span className="vx-eyebrow">Monthly</span>
				<span className="font-mono text-lg font-semibold">
					{status.monthlyCost != null ? formatMonthlyRate(status.monthlyCost, "exact") : "—"}
				</span>
			</div>
			{env.costCapturedAt && (
				<p className="text-ui-xs text-muted-foreground">
					As of the last plan · {ago(env.costCapturedAt)} ago
				</p>
			)}
			{lines.length > 0 ? (
				<div className="space-y-2">
					<span className="vx-eyebrow">Breakdown</span>
					<ul className="space-y-1">
						{lines.map((l) => (
							<li
								key={l.address}
								className="flex items-center gap-2 border border-border bg-surface-sunken px-2 py-1.5 font-mono text-ui-2xs"
							>
								<span className="min-w-0 flex-1 truncate">{l.address}</span>
								<span className="shrink-0">{formatMonthlyRate(l.monthlyCost, "exact")}</span>
							</li>
						))}
					</ul>
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					This resource carries a total price with no per-line breakdown.
				</p>
			)}
		</div>
	);
}

/**
 * The Activity tab — the environment's recent job history. It's env-scoped, not per-node (a node has
 * no jobs of its own — a DEPLOY provisions the whole board), which is why it reads from the single
 * environment-status round-trip rather than threading the project/environment id into the panel.
 */
function ActivityTab() {
	const env = useEnvironmentStatus();
	if (env.recentJobs.length === 0) {
		return (
			<p className="text-xs text-muted-foreground">
				No activity yet for this environment.
			</p>
		);
	}
	return <JobList jobs={env.recentJobs} />;
}

/** A list of jobs in the board's grayscale job vocabulary — shared by Activity and the Overview. */
function JobList({ jobs }: { jobs: EnvironmentJob[] }) {
	return (
		<ul className="space-y-1">
			{jobs.map((job) => {
				const vx = JOB_STATUS[job.status] ?? "idle";
				return (
					<li
						key={job.id}
						className="flex items-center gap-2 border border-border bg-surface-sunken px-2.5 py-1.5"
					>
						<StatusBadge
							status={job.status}
							tier={vx}
							showLabel={false}
							className="shrink-0"
							suppressHydrationWarning
						/>
						<span className="min-w-0 flex-1 truncate font-mono text-ui-2xs uppercase tracking-wide">
							{JOB_LABEL[job.type] ?? job.type}
						</span>
						<span className="shrink-0 font-mono text-ui-3xs text-muted-foreground">
							{ago(job.createdAt)}
						</span>
					</li>
				);
			})}
		</ul>
	);
}
