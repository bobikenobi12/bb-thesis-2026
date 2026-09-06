"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { getRegionPrices } from "@/app/server/actions/pricing";
import { getGitopsDeployStatus } from "@/app/server/actions/gitops-status";
import { getPlanResult } from "@/app/server/actions/jobs";
import { getProject } from "@/app/server/actions/projects";
import { DeployPane } from "@/components/agent/deploy-pane";
import { BuildPane } from "@/components/agent/build-pane";
import { PANEL_EMPTY } from "@/components/agent/panel-empty";
import type {
	BuildJobState,
	BuildServiceInput,
} from "@/lib/agent/build-status";
import type {
	ProvisionJobStatus,
	ProvisionJobType,
} from "@/lib/db/schema/enums";
import type { GitopsDeployStatus } from "@/lib/gitops/deploy-status";
import { formatMonthlyRate } from "@repo/format";
import { Badge } from "@repo/ui/badge";
import { CountPill } from "@repo/ui/count-pill";
import { EmptyState } from "@repo/ui/empty";
import { ScrollArea } from "@repo/ui/scroll-area";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/tabs";
import { getProvider, type CloudProviderSlug } from "@/lib/cloud-providers";
import { type CostItem, computeCostItems } from "@/lib/cost/compute-cost-items";
import { type CostSummary, parseCostBreakdown } from "@/lib/plan/parse-cost";
import { type PlanSummary, parsePlanJSON } from "@/lib/plan/parse-plan";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";
import { useJobLogStream } from "@/hooks/use-job-log-stream";
import type { CompatReport } from "@/types/compat.types";
import type {
	SignedReceipt,
	VerifyReport,
	VerifyStatus,
} from "@/types/jsonb.types";
import { cn } from "@repo/ui/utils";

type ProjectDetail = Awaited<ReturnType<typeof getProject>>;

interface PlanState {
	status: ProvisionJobStatus;
	jobType: ProvisionJobType;
	error: string | null;
	planSummary: PlanSummary | null;
	costSummary: CostSummary | null;
	verifyReport: VerifyReport | null;
	/** PLAN/DEPLOY jobs: execution_metadata.compat_result (version-compatibility gate). */
	compatReport: CompatReport | null;
	receipt: SignedReceipt | null;
	/** BUILD jobs only: execution_metadata.build_result (service → pushed digest). */
	buildResult: Record<string, string> | null;
}

/** Narrow a free-form provider string to a known slug (no casts). */
function toSlug(p: string): CloudProviderSlug {
	return p === "gcp" || p === "azure" ? p : "aws";
}

/**
 * The agent's generative-UI split pane — Config / Plan / Deploy / Cost / Logs for the
 * active project/job (from `useArtifactStore`). All tabs read existing server
 * actions + pure parsers; Logs streams over the shared `useJobLogStream` SSE.
 * Grayscale/squared; fills the resizable split column the Elench modal gives it,
 * and self-hides (returns null) when no artifact is open.
 */
export function ArtifactPanel() {
	const artifact = useArtifactStore((s) => s.artifact);
	const tab = useArtifactStore((s) => s.tab);
	const setTab = useArtifactStore((s) => s.setTab);
	const close = useArtifactStore((s) => s.close);

	const projectId = artifact?.projectId;
	const jobId = artifact?.jobId;

	const [project, setProject] = useState<ProjectDetail | null>(null);
	const [cost, setCost] = useState<{ items: CostItem[]; total: number } | null>(
		null,
	);
	const [plan, setPlan] = useState<PlanState | null>(null);
	const [deploy, setDeploy] = useState<GitopsDeployStatus | null>(null);
	const { logs } = useJobLogStream(jobId ?? null);

	// Load the project + compute its cost.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			if (!projectId) {
				if (!cancelled) {
					setProject(null);
					setCost(null);
				}
				return;
			}
			const detail = await getProject(projectId);
			if (cancelled) return;
			setProject(detail);
			const region = detail.project.region;
			const prices = region ? await getRegionPrices(region) : null;
			if (cancelled) return;
			const c = detail.components.cluster;
			const n = detail.components.network;
			const meta = getProvider(toSlug(detail.cloudProvider));
			setCost(
				computeCostItems(
					{
						instanceTypes: c?.instance_types ?? [],
						nodeDesiredSize: c?.node_desired_size ?? 2,
						singleNatGateway: n?.single_nat_gateway ?? true,
						databases: (detail.components.databases ?? []).map((d) => ({
							name: d.name,
							min_capacity: d.min_capacity,
							max_capacity: d.max_capacity,
						})),
						caches: (detail.components.caches ?? []).map((ch) => ({
							name: ch.name,
							node_type: ch.node_type,
							num_cache_nodes: ch.num_cache_nodes,
						})),
						cloudfrontWaf: false,
						applicationWaf: detail.components.dns?.waf_enabled ?? false,
						nosqlCount: (detail.components.nosql_tables ?? []).length,
						secretsCount: (detail.components.secrets ?? []).length,
					},
					prices,
					{
						clusterService: meta.clusterService,
						secretsService: meta.secretsService,
					},
				),
			);
		})();
		return () => {
			cancelled = true;
		};
	}, [projectId]);

	// Load the environment's GitOps deploy status (#574) — same useEffect+server-action
	// pattern as the other panes; refetched whenever the artifact's project changes.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			if (!projectId) {
				if (!cancelled) setDeploy(null);
				return;
			}
			const status = await getGitopsDeployStatus(projectId).catch(() => null);
			if (!cancelled) setDeploy(status);
		})();
		return () => {
			cancelled = true;
		};
	}, [projectId]);

	// Load the job's plan result.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			if (!jobId) {
				if (!cancelled) setPlan(null);
				return;
			}
			const r = await getPlanResult(jobId);
			if (cancelled) return;
			const meta = r.execution_metadata;
			setPlan({
				status: r.status,
				jobType: r.job_type,
				error: r.error_message,
				planSummary: meta?.plan_result ? parsePlanJSON(meta.plan_result) : null,
				costSummary: meta?.cost_breakdown
					? parseCostBreakdown(meta.cost_breakdown)
					: null,
				verifyReport: meta?.verify_result ?? null,
				compatReport: meta?.compat_result ?? null,
				receipt: meta?.verify_receipt ?? null,
				buildResult: meta?.build_result ?? null,
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [jobId]);

	if (!artifact) return null;

	// Config/Cost need a project; Plan/Logs need a job. The tabs are shown only for
	// what the artifact actually carries.
	const hasProject = !!projectId;
	const hasJob = !!jobId;

	// Build (#592): shown when the project has a repo-sourced service (image-sourced ones don't build).
	// The BUILD job's live state feeds the phases; without a BUILD job open, the pane reads the
	// persisted resolved_image instead.
	const services: BuildServiceInput[] = project?.components.services ?? [];
	const hasBuild = services.some((s) => s.source.kind === "repo");
	const buildJob: BuildJobState | null =
		plan?.jobType === "BUILD"
			? { status: plan.status, buildResult: plan.buildResult ?? {} }
			: null;

	const title =
		project?.project.project_name ??
		(jobId ? `Job ${jobId.slice(0, 8)}` : "Artifact");

	return (
		<aside className="flex h-full w-full flex-col bg-card">
			<header className="flex h-[52px] flex-none items-center justify-between gap-2 border-b border-border px-4">
				<span className="truncate text-sm font-medium">{title}</span>
				<button
					type="button"
					onClick={close}
					aria-label="Close panel"
					className="flex h-7 w-7 flex-none items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
				>
					<X className="h-4 w-4" />
				</button>
			</header>

			<Tabs
				value={tab}
				onValueChange={(v) => {
					if (
						v === "config" ||
						v === "plan" ||
						v === "build" ||
						v === "deploy" ||
						v === "cost" ||
						v === "logs"
					)
						setTab(v);
				}}
				className="flex min-h-0 flex-1 flex-col gap-0"
			>
				<TabsList className="h-auto justify-start rounded-none border-b border-border bg-transparent px-2 py-1.5">
					{hasProject && (
						<TabsTrigger value="config" className="rounded-none text-xs">
							Config
						</TabsTrigger>
					)}
					{hasJob && (
						<TabsTrigger value="plan" className="rounded-none text-xs">
							Plan
						</TabsTrigger>
					)}
					{hasBuild && (
						<TabsTrigger value="build" className="rounded-none text-xs">
							Build
						</TabsTrigger>
					)}
					{hasProject && (
						<TabsTrigger value="deploy" className="rounded-none text-xs">
							Deploy
						</TabsTrigger>
					)}
					{hasProject && (
						<TabsTrigger value="cost" className="rounded-none text-xs">
							Cost
						</TabsTrigger>
					)}
					{hasJob && (
						<TabsTrigger value="logs" className="rounded-none text-xs">
							Logs
						</TabsTrigger>
					)}
				</TabsList>

				<div className="min-h-0 flex-1">
					<TabsContent value="config" className="m-0 h-full">
						<ScrollArea className="h-full">
							<div className="p-4">
								<ConfigPane project={project} />
							</div>
						</ScrollArea>
					</TabsContent>
					<TabsContent value="plan" className="m-0 h-full">
						<ScrollArea className="h-full">
							<div className="p-4">
								<PlanPane plan={plan} jobId={jobId} />
							</div>
						</ScrollArea>
					</TabsContent>
					<TabsContent value="build" className="m-0 h-full">
						<ScrollArea className="h-full">
							<div className="p-4">
								<BuildPane services={services} build={buildJob} />
							</div>
						</ScrollArea>
					</TabsContent>
					<TabsContent value="deploy" className="m-0 h-full">
						<ScrollArea className="h-full">
							<div className="p-4">
								{!projectId ? (
									<EmptyState title="Open a project to see its GitOps status." className={PANEL_EMPTY} />
								) : (
									<DeployPane status={deploy} />
								)}
							</div>
						</ScrollArea>
					</TabsContent>
					<TabsContent value="cost" className="m-0 h-full">
						<ScrollArea className="h-full">
							<div className="p-4">
								<CostPane cost={cost} />
							</div>
						</ScrollArea>
					</TabsContent>
					<TabsContent value="logs" className="m-0 h-full">
						<ScrollArea className="h-full">
							<div className="p-4">
								{!jobId ? (
									<EmptyState title="Open a job to stream its logs." className={PANEL_EMPTY} />
								) : logs.length === 0 ? (
									<EmptyState title="Waiting for logs…" className={PANEL_EMPTY} />
								) : (
									<div className="space-y-0.5 font-mono text-ui-xs leading-relaxed">
										{logs.map((l) => (
											<div
												key={l.id}
												className={cn(
													"whitespace-pre-wrap",
													l.stream_type === "STDERR"
														? "text-foreground"
														: "text-muted-foreground",
												)}
											>
												{l.log_chunk}
											</div>
										))}
									</div>
								)}
							</div>
						</ScrollArea>
					</TabsContent>
				</div>
			</Tabs>
		</aside>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div>
			<div className="vx-eyebrow pb-1 text-ui-3xs">{title}</div>
			<div className="border border-border px-3">{children}</div>
		</div>
	);
}

function Row({ k, v }: { k: string; v: ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-3 border-b border-border py-2 font-mono text-ui-xs last:border-0">
			<span className="text-muted-foreground">{k}</span>
			<span className="truncate text-right text-foreground">{v || "—"}</span>
		</div>
	);
}

function ListSection({
	title,
	items,
}: {
	title: string;
	items: Array<{ name: string; detail?: string }>;
}) {
	if (items.length === 0) return null;
	return (
		<Section title={title}>
			{items.map((i) => (
				<Row key={i.name} k={i.name} v={i.detail ?? ""} />
			))}
		</Section>
	);
}

function ConfigPane({ project }: { project: ProjectDetail | null }) {
	if (!project) return <EmptyState title="Loading…" className={PANEL_EMPTY} />;
	const { components, cloudProvider } = project;
	const c = components.cluster;
	const n = components.network;
	const dns = components.dns;
	return (
		<div className="space-y-4">
			<div className="border border-border bg-muted/40 p-3">
				<div className="text-sm font-medium">{project.project.project_name}</div>
				<div className="vx-eyebrow mt-1 text-ui-3xs">
					{cloudProvider} · {project.project.region ?? "—"} ·{" "}
					{project.project.environment_stage}
				</div>
			</div>

			{c && (
				<Section title="Cluster">
					<Row k="version" v={c.cluster_version} />
					<Row k="nodes" v={`${c.node_min_size}–${c.node_max_size} (desired ${c.node_desired_size})`} />
					<Row k="instances" v={(c.instance_types ?? []).join(", ")} />
				</Section>
			)}

			{n && (
				<Section title="Network">
					<Row k="provision" v={n.provision_network ? "new" : "existing"} />
					<Row k="cidr" v={n.cidr_block} />
					<Row k="nat" v={n.single_nat_gateway ? "single" : "per-AZ"} />
				</Section>
			)}

			{dns?.enabled && (
				<Section title="DNS">
					<Row k="domain" v={dns.domain_name} />
					<Row k="cert" v={dns.managed_certificate ? "managed" : "none"} />
					<Row k="waf" v={dns.waf_enabled ? "on" : "off"} />
				</Section>
			)}

			<ListSection
				title="Databases"
				items={(components.databases ?? []).map((d) => ({
					name: d.name,
					detail: d.engine ?? undefined,
				}))}
			/>
			<ListSection
				title="Caches"
				items={(components.caches ?? []).map((ch) => ({
					name: ch.name,
					detail: [ch.engine, ch.node_type].filter(Boolean).join(" · "),
				}))}
			/>
			<ListSection
				title="Queues"
				items={(components.queues ?? []).map((q) => ({ name: q.name }))}
			/>
			<ListSection
				title="Topics"
				items={(components.topics ?? []).map((t) => ({ name: t.name }))}
			/>
			<ListSection
				title="NoSQL"
				items={(components.nosql_tables ?? []).map((t) => ({ name: t.name }))}
			/>
			<ListSection
				title="Secrets"
				items={(components.secrets ?? []).map((s) => ({ name: s.name }))}
			/>
		</div>
	);
}

function CostPane({ cost }: { cost: { items: CostItem[]; total: number } | null }) {
	if (!cost) return <EmptyState title="Open a project to estimate its cost." className={PANEL_EMPTY} />;
	return (
		<div>
			<div className="space-y-1.5">
				{cost.items.map((item) => (
					<div
						key={item.label}
						className="flex items-center justify-between text-xs"
					>
						<div className="flex min-w-0 items-center gap-1.5">
							<span className="truncate text-muted-foreground">{item.label}</span>
							{item.detail && (
								<Badge
									variant="outline"
									className="shrink-0 rounded-none px-1 py-0 text-ui-3xs"
								>
									{item.detail}
								</Badge>
							)}
						</div>
						<span className="ml-2 shrink-0 font-mono text-foreground">
							{formatMonthlyRate(item.cost, "exact")}
						</span>
					</div>
				))}
			</div>
			<div className="mt-3 flex items-center justify-between border-t border-border pt-3">
				<span className="text-sm font-medium">Total</span>
				<span className="font-mono text-sm font-semibold">
					{formatMonthlyRate(cost.total, "exact")}
				</span>
			</div>
		</div>
	);
}

/**
 * One plan-summary count tile (add / change / destroy / replace).
 *
 * The NUMBER is `@repo/ui/count-pill` — mono, tabular, thousands-separated. The bordered tile
 * and its eyebrow caption stay here because the shared pill is the inline count that sits beside
 * a section heading and takes no label; a plan summary needs four labelled tiles. So this is the
 * composition the shared component was promoted for, not a second implementation of it.
 */
function PlanCountTile({ n, label }: { n: number; label: string }) {
	return (
		<div className="border border-border px-2.5 py-1.5 text-center">
			<CountPill
				count={n}
				// In a tile the count IS the content, not a marginal annotation beside a heading,
				// so the display size and weight are restored. Everything else — the mono face,
				// tabular figures, locale separators, the null guard — comes from the component.
				className="bg-transparent px-0 py-0 text-base font-semibold text-foreground"
			/>
			<div className="vx-eyebrow text-ui-3xs">{label}</div>
		</div>
	);
}

/**
 * Verdict/status → the shared grayscale status tier.
 *
 * `StatusBadge` resolves the infrastructure vocabulary (active/queued/failed/…) on its own, and
 * NONE of the gate's four words is in it: `statusTier("not_evaluable")` returns `idle` silently,
 * which would render "not evaluable" and "warnings" identically to a pass a reader has already
 * learned to trust. So this is the explicit `tier` the component asks for when a domain brings its
 * own words — a vocabulary map, not the local colour map it replaces.
 *
 * The ordering it preserves is the one the old Badge variants encoded: `fail` carries the most ink
 * (a solid dot with a cut-out), `pass` the settled one, and the two honest non-answers sit between
 * them without claiming either — `warn` still in flight, `not_evaluable` present but saying
 * nothing. A `not_evaluable` must never read as a pass.
 */
const VERDICT_TIER: Record<VerifyStatus, StatusTier> = {
	pass: "active",
	fail: "failed",
	warn: "pending",
	not_evaluable: "idle",
};

const VERDICT_LABEL: Record<VerifyStatus, string> = {
	pass: "passed",
	fail: "blocked",
	warn: "warnings",
	not_evaluable: "not evaluable",
};

/**
 * The verification gate's per-control result (elench). Renders the overall verdict,
 * each control's status + findings, and — importantly — the coverage notes that say
 * what the gate could NOT inspect, so a `not_evaluable` is never mistaken for a pass.
 */
export function VerifyBlock({ report }: { report: VerifyReport }) {
	return (
		<Section title="Verification">
			<div className="flex items-center justify-between border-b border-border py-2">
				<span className="font-mono text-ui-2xs text-muted-foreground">
					{report.provider} · {report.catalog_version}
				</span>
				<StatusBadge
					status={report.verdict}
					tier={VERDICT_TIER[report.verdict]}
					label={VERDICT_LABEL[report.verdict]}
					className="text-ui-3xs"
				/>
			</div>
			{report.controls.map((c) => (
				<div key={c.id} className="border-b border-border py-2 last:border-0">
					<div className="flex items-center justify-between gap-2">
						<span className="font-mono text-ui-xs text-foreground">{c.id}</span>
						<StatusBadge
							status={c.status}
							tier={VERDICT_TIER[c.status]}
							label={c.status.replace("_", " ")}
							className="text-ui-3xs"
						/>
					</div>
					<div className="text-ui-2xs text-muted-foreground">
						{c.title}
						{c.frameworks?.length ? ` · ${c.frameworks.join(", ")}` : ""}
					</div>
					{(c.findings ?? []).map((f, i) => (
						<div
							key={`${f.address}-${i}`}
							className="mt-1 font-mono text-ui-2xs text-foreground"
						>
							<span className="text-muted-foreground">{f.address}</span> — {f.message}
						</div>
					))}
					{c.coverage && (
						<div className="mt-1 text-ui-2xs italic text-muted-foreground">
							coverage: {c.coverage}
						</div>
					)}
				</div>
			))}
		</Section>
	);
}

/**
 * The version-compatibility gate (packages/core/compat): a 1:1 mirror of VerifyBlock
 * for the compat report the apply gate attaches on `execution_metadata.compat_result`
 * (#1215). CompatReport carries no `provider`/`frameworks`, so the header shows only the
 * catalog version and each control shows only its title. `CompatStatus` is the same union
 * as `VerifyStatus`, so it reuses `VERDICT_TIER` + `VERDICT_LABEL` verbatim.
 */
export function CompatBlock({ report }: { report: CompatReport }) {
	return (
		<Section title="Compatibility">
			<div className="flex items-center justify-between border-b border-border py-2">
				<span className="font-mono text-ui-2xs text-muted-foreground">
					compat · {report.catalog_version}
				</span>
				<StatusBadge
					status={report.verdict}
					tier={VERDICT_TIER[report.verdict]}
					label={VERDICT_LABEL[report.verdict]}
					className="text-ui-3xs"
				/>
			</div>
			{report.controls.map((c) => (
				<div key={c.id} className="border-b border-border py-2 last:border-0">
					<div className="flex items-center justify-between gap-2">
						<span className="font-mono text-ui-xs text-foreground">{c.id}</span>
						<StatusBadge
							status={c.status}
							tier={VERDICT_TIER[c.status]}
							label={c.status.replace("_", " ")}
							className="text-ui-3xs"
						/>
					</div>
					<div className="text-ui-2xs text-muted-foreground">{c.title}</div>
					{(c.findings ?? []).map((f, i) => (
						<div
							key={`${f.address}-${i}`}
							className="mt-1 font-mono text-ui-2xs text-foreground"
						>
							<span className="text-muted-foreground">{f.address}</span> — {f.message}
						</div>
					))}
					{c.coverage && (
						<div className="mt-1 text-ui-2xs italic text-muted-foreground">
							coverage: {c.coverage}
						</div>
					)}
				</div>
			))}
		</Section>
	);
}

/**
 * The signed evidence receipt (elench): shows whether the receipt is signed, the
 * plan hash it is bound to, any recorded exception, and a download of the raw
 * receipt JSON (which can be verified offline against the signing public key).
 */
function ReceiptBlock({ receipt, jobId }: { receipt: SignedReceipt; jobId: string }) {
	const signed = receipt.algorithm === "ed25519";
	const body = receipt.receipt;
	const download = () => {
		const blob = new Blob([JSON.stringify(receipt, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `elench-receipt-${jobId.slice(0, 8)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	};
	return (
		<Section title="Evidence receipt">
			<Row k="status" v={signed ? `signed · ${receipt.key_id ?? ""}` : "unsigned"} />
			<Row k="plan sha256" v={body.plan_sha256 ? `${body.plan_sha256.slice(0, 16)}…` : "—"} />
			<Row k="catalog" v={body.catalog_version} />
			{body.tofu_version && <Row k="opentofu" v={body.tofu_version} />}
			{body.evaluated_at && <Row k="evaluated" v={body.evaluated_at} />}
			{body.exception && (
				<Row
					k="exception"
					v={`${body.exception.controls.join(", ")} by ${body.exception.by}`}
				/>
			)}
			<div className="py-2">
				<button
					type="button"
					onClick={download}
					className="w-full border border-border px-2 py-1 text-ui-2xs uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
				>
					Download receipt
				</button>
			</div>
		</Section>
	);
}

function PlanPane({
	plan,
	jobId,
}: {
	plan: PlanState | null;
	jobId: string | undefined;
}) {
	if (!jobId) return <EmptyState title="Open a job to see its plan." className={PANEL_EMPTY} />;
	if (!plan) return <EmptyState title="Loading…" className={PANEL_EMPTY} />;
	return (
		<div className="space-y-3">
			{plan.verifyReport && <VerifyBlock report={plan.verifyReport} />}
			{plan.compatReport && <CompatBlock report={plan.compatReport} />}
			{plan.receipt && <ReceiptBlock receipt={plan.receipt} jobId={jobId} />}
			{plan.planSummary ? (
				<>
					<div className="flex gap-2">
						<PlanCountTile n={plan.planSummary.counts.create} label="add" />
						<PlanCountTile n={plan.planSummary.counts.update} label="change" />
						<PlanCountTile n={plan.planSummary.counts.delete} label="destroy" />
						{plan.planSummary.counts.replace > 0 && (
							<PlanCountTile n={plan.planSummary.counts.replace} label="replace" />
						)}
					</div>
					{plan.costSummary?.totalMonthlyCost != null && (
						<div className="font-mono text-xs text-muted-foreground">
							{formatMonthlyRate(plan.costSummary.totalMonthlyCost, "exact")}
						</div>
					)}
					<div className="divide-y divide-border border border-border">
						{plan.planSummary.resources.map((r) => (
							<div
								key={r.address}
								className="flex items-center justify-between gap-2 px-3 py-1.5 font-mono text-ui-xs"
							>
								<span className="truncate text-foreground">
									{r.displayName} · {r.name}
								</span>
								<span className="flex-none text-muted-foreground">{r.action}</span>
							</div>
						))}
					</div>
				</>
			) : (
				// The one call site with two registers: a failure names the failure and then
				// carries the reason, which is what `EmptyState`'s title/description split is
				// for. The local `Empty({text})` could only ever run them together as one line.
				<EmptyState
					className={PANEL_EMPTY}
					title={plan.error ? "Plan failed" : "No plan output yet"}
					description={
						plan.error ?? "Run a plan (deploy flow coming soon)."
					}
				/>
			)}
		</div>
	);
}
