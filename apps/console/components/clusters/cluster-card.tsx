"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ClusterData } from "@/app/server/actions/clusters";
import { ClassificationControl } from "@/components/classification/classification-control";
import type { AssignedValue } from "@/lib/queries/classification";
import { getProvider } from "@/lib/cloud-providers";
import { SectionHeading } from "@repo/ui/section-heading";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { Button } from "@repo/ui/button";
import { StatusBadge, statusTier, type StatusTier } from "@repo/ui/status-badge";
import {
	Boxes,
	Check,
	Copy,
	Database,
	ExternalLink,
	Globe,
	HardDrive,
	Server,
	Terminal,
} from "lucide-react";
import { useState } from "react";

/** The managed-Kubernetes product name per cloud — labels the control-plane row. */
const K8S_KIND: Record<string, string> = {
	aws: "EKS",
	gcp: "GKE",
	azure: "AKS",
	alibaba: "ACK",
	hetzner: "k8s",
};

/** Title-cases a SCREAMING_CASE component status ("UPDATING" → "Updating"). */
function humanize(status: string): string {
	return status.charAt(0) + status.slice(1).toLowerCase();
}

/** Component-health tally over the cluster + its data services. */
interface ComponentHealth {
	total: number;
	healthy: number;
	failed: number;
	pending: number;
}

/**
 * Rolls the cluster's own status plus every database/cache status into a single posture.
 * The badge is DERIVED, never hardcoded — a failed data service reads as degraded, an
 * in-flight reconcile reads as reconciling, and a project still provisioning (no cluster
 * row yet) reads from its environment status.
 */
function deriveHealth(
	clusterStatus: string | null,
	envStatus: string,
	componentStatuses: string[],
): {
	tier: StatusTier;
	/** Posture shown next to the cluster name (what an operator scans). */
	name: string;
	/** Short mono rollup label. */
	rollup: string;
	/** Secondary mono detail under the rollup. */
	detail: string;
	health: ComponentHealth;
} {
	const statuses = [
		...(clusterStatus ? [clusterStatus] : []),
		...componentStatuses,
	];
	const total = statuses.length;
	const healthy = statuses.filter((s) => statusTier(s) === "active").length;
	const failed = statuses.filter((s) => statusTier(s) === "failed").length;
	const pending = statuses.filter((s) => statusTier(s) === "pending").length;
	const health: ComponentHealth = { total, healthy, failed, pending };

	// No reconciled components yet — the project is provisioning; read the env status.
	if (total === 0) {
		const s = clusterStatus ?? envStatus;
		return {
			tier: statusTier(s),
			name: humanize(s),
			rollup: "Provisioning",
			detail: "no endpoint yet",
			health,
		};
	}
	const detail = `${healthy} / ${total} healthy`;
	if (failed > 0) {
		return { tier: "failed", name: "Degraded", rollup: `${failed} failed`, detail, health };
	}
	if (pending > 0) {
		// Surface the control plane's own in-flight verb when it's the one moving.
		const name =
			clusterStatus && statusTier(clusterStatus) === "pending"
				? humanize(clusterStatus)
				: "Reconciling";
		return { tier: "pending", name, rollup: "Reconciling", detail, health };
	}
	if (healthy === total) {
		return { tier: "active", name: "Active", rollup: "Healthy", detail, health };
	}
	const s = clusterStatus ?? envStatus;
	return { tier: statusTier(s), name: humanize(s), rollup: humanize(s), detail, health };
}

/** Copy-to-clipboard button used for endpoints and CLI commands. */
function CopyButton({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="ghost"
			size="icon"
			className="h-6 w-6 shrink-0 text-text-tertiary"
			aria-label={label}
			onClick={async () => {
				await navigator.clipboard.writeText(value);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
		>
			{copied ? (
				<Check className="h-3 w-3 text-text-primary" />
			) : (
				<Copy className="h-3 w-3" />
			)}
		</Button>
	);
}

/** A component row: icon + name + engine (+ endpoint) with its OWN derived status dot. */
function ComponentRow({
	icon: Icon,
	name,
	engine,
	endpoint,
	status,
	label,
}: {
	icon: typeof Database;
	name: string;
	engine?: string | null;
	endpoint?: string | null;
	status: string;
	/** Overrides the badge label (e.g. DNS "Enabled" instead of the raw status). */
	label?: string;
}) {
	return (
		<div className="flex items-center gap-2.5 py-2 first:pt-0 last:pb-0">
			<Icon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
			<span className="text-ui-sm text-text-primary">{name}</span>
			{engine && (
				<span className="font-mono text-ui-2xs text-text-tertiary">{engine}</span>
			)}
			{endpoint && (
				<div className="ml-auto flex min-w-0 items-center gap-1">
					<code className="max-w-[160px] truncate font-mono text-ui-2xs text-text-tertiary">
						{endpoint}
					</code>
					<CopyButton value={endpoint} label={`Copy ${name} endpoint`} />
				</div>
			)}
			<div className={endpoint ? "shrink-0" : "ml-auto shrink-0"}>
				<StatusBadge status={status} label={label ?? humanize(status)} />
			</div>
		</div>
	);
}

/**
 * A provisioned cluster and its data services. Status is derived from the real read model:
 * `project_cluster.status` plus each database/cache `status` roll up into one posture, and
 * every row carries its own `StatusBadge` — nothing is hardcoded to "Active".
 */
export function ClusterCard({
	data,
	initialAssignments,
}: {
	data: ClusterData;
	initialAssignments?: AssignedValue[];
}) {
	const provider = data.cloud_identities?.provider ?? "aws";
	const meta = getProvider(provider);
	const cluster = Array.isArray(data.project_cluster)
		? data.project_cluster[0]
		: data.project_cluster;
	const databases = data.project_databases ?? [];
	const caches = data.project_caches ?? [];
	const dns = data.project_dns;

	const health = deriveHealth(cluster?.status ?? null, data.status, [
		...databases.map((d) => d.status),
		...caches.map((c) => c.status),
	]);

	// kubeconfig is an AWS-specific command; only show it where it's actually correct.
	const kubeconfigCmd =
		provider === "aws" && cluster?.cluster_name
			? `aws eks update-kubeconfig --name ${cluster.cluster_name} --region ${data.region}`
			: null;

	// The ArgoCD admin password is never stored (it would be plaintext in our DB); it is
	// retrieved on demand from the cluster's argocd-initial-admin-secret. Show the command.
	const argocdPasswordCmd =
		"kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d";

	return (
		<div className="flex flex-col gap-3.5 rounded-lg border bg-surface p-[18px] shadow-sm">
			{/* Header: identity + derived posture rollup. */}
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-start gap-2.5">
					<ProviderIcon provider={provider} size={20} />
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							{/* The card's own heading rung, through the shared component: the card
							    used to hand-write an `<h3>` at `text-sm`, one of five sizes the
							    same rung was typeset at across the console.
							    `SectionHeading` fixes its heading at `text-ui-lg` whatever the
							    `level` — deliberately, so type scale is not chosen from the outline
							    — which inside an 18px-padded card over an 11px meta line would make
							    the title the largest type on the card, and larger than the sibling
							    environment card's name. The slot override keeps the card's rung and
							    takes only the tag from the component. */}
							<SectionHeading
								level={3}
								title={data.project_name}
								className="min-w-0 [&_[data-slot=section-heading-title]]:text-sm [&_[data-slot=section-heading-title]]:font-semibold"
							/>
							<StatusBadge status={health.tier} tier={health.tier} label={health.name} />
						</div>
						<p className="mt-0.5 font-mono text-ui-xs text-text-tertiary">
							{meta.shortName} · {data.region} · {data.environment_stage}
							{cluster?.cluster_version ? ` · K8s ${cluster.cluster_version}` : ""}
						</p>
						{cluster?.id && (
							<ClassificationControl
								kind="project_cluster"
								id={cluster.id}
								canEdit
								initialAssignments={initialAssignments}
								className="mt-1.5"
								compact
							/>
						)}
					</div>
				</div>
				<div className="shrink-0 text-right">
					<StatusBadge
						status={health.tier}
						tier={health.tier}
						label={health.rollup}
						className="justify-end"
					/>
					<div className="mt-1 font-mono text-ui-2xs tabular-nums text-text-tertiary">
						{health.detail}
					</div>
				</div>
			</div>

			{/* Components — each with its own derived status. */}
			<div className="flex flex-col border-t pt-1">
				<ComponentRow
					icon={Boxes}
					name="Control plane"
					engine={K8S_KIND[provider] ?? "k8s"}
					status={cluster?.status ?? data.status}
				/>
				{databases.map((db) => (
					<ComponentRow
						key={db.name}
						icon={Database}
						name={db.name}
						engine={db.engine}
						endpoint={db.endpoint}
						status={db.status}
					/>
				))}
				{caches.map((cache) => (
					<ComponentRow
						key={cache.name}
						icon={HardDrive}
						name={cache.name}
						engine={cache.engine}
						endpoint={cache.endpoint}
						status={cache.status}
					/>
				))}
				{dns?.domain_name && (
					<ComponentRow
						icon={Globe}
						name={dns.domain_name}
						engine="dns"
						status={dns.enabled ? "active" : "disabled"}
						label={dns.enabled ? "Enabled" : "Disabled"}
					/>
				)}
			</div>

			{/* Cluster access. */}
			{cluster?.cluster_endpoint && (
				<div className="flex flex-col gap-1.5 border-t pt-3">
					<div className="flex items-center gap-1.5 text-text-tertiary">
						<Terminal className="h-3.5 w-3.5" />
						<span className="text-ui-xs font-medium text-text-secondary">
							Cluster access
						</span>
					</div>
					<div className="flex items-center gap-2">
						<code className="flex-1 truncate rounded-sm border bg-surface-sunken px-2 py-1 font-mono text-ui-xs text-text-secondary">
							{cluster.cluster_endpoint}
						</code>
						<CopyButton value={cluster.cluster_endpoint} label="Copy cluster endpoint" />
					</div>
					{kubeconfigCmd && (
						<div className="flex items-center gap-2">
							<code className="flex-1 truncate rounded-sm border bg-surface-sunken px-2 py-1 font-mono text-ui-xs text-text-secondary">
								{kubeconfigCmd}
							</code>
							<CopyButton value={kubeconfigCmd} label="Copy kubeconfig command" />
						</div>
					)}
				</div>
			)}

			{/* ArgoCD. */}
			{cluster?.argocd_url && (
				<div className="flex flex-col gap-1.5 border-t pt-3">
					<div className="flex items-center gap-1.5 text-text-tertiary">
						<Server className="h-3.5 w-3.5" />
						<span className="text-ui-xs font-medium text-text-secondary">ArgoCD</span>
					</div>
					<div className="flex items-center gap-2">
						<code className="flex-1 truncate rounded-sm border bg-surface-sunken px-2 py-1 font-mono text-ui-xs text-text-secondary">
							{cluster.argocd_url}
						</code>
						<a href={cluster.argocd_url} target="_blank" rel="noopener noreferrer">
							<Button
								variant="ghost"
								size="icon"
								className="h-6 w-6 shrink-0 text-text-tertiary"
								aria-label="Open ArgoCD"
							>
								<ExternalLink className="h-3 w-3" />
							</Button>
						</a>
					</div>
					<p className="text-ui-2xs text-text-tertiary">
						Admin password (retrieve from the cluster):
					</p>
					<div className="flex items-center gap-2">
						<code className="flex-1 truncate rounded-sm border bg-surface-sunken px-2 py-1 font-mono text-ui-xs text-text-secondary">
							{argocdPasswordCmd}
						</code>
						<CopyButton value={argocdPasswordCmd} label="Copy ArgoCD admin password command" />
					</div>
				</div>
			)}
		</div>
	);
}
