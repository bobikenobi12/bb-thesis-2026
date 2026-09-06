"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The artifact panel's Deploy tab (#574): GitOps wiring facts + per-component ArgoCD
// health for one environment, rendered from the GitopsDeployStatus read model. Fail-loud:
// when the wiring failed before the health read, service rows show Unknown — never a
// stale pass — and the failure banner says which step died and how to fix it.

import { formatDistanceToNow } from "date-fns";
import { ExternalLink } from "lucide-react";
import { PANEL_EMPTY } from "@/components/agent/panel-empty";
import { EmptyState } from "@repo/ui/empty";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import type {
	GitopsComponentRow,
	GitopsDeployStatus,
} from "@/lib/gitops/deploy-status";

/** Maps an ArgoCD health string onto the grayscale status tiers. */
function healthTier(health: string): StatusTier {
	switch (health) {
		case "Healthy":
			return "active";
		case "Progressing":
			return "pending";
		case "Degraded":
		case "Missing":
			return "failed";
		case "Suspended":
			return "idle";
		default:
			return "disabled"; // Unknown — an honest "we don't know", faint not alarming
	}
}

/** Maps an ArgoCD sync string onto the grayscale status tiers. */
function syncTier(sync: string): StatusTier {
	switch (sync) {
		case "Synced":
			return "active";
		case "OutOfSync":
			return "idle"; // hollow ring — divergent, not broken
		default:
			return "disabled";
	}
}

/** Per-step fix hints for the wiring failure banner, keyed by GitopsStep* (Go). */
const FIX_HINTS: Record<string, string> = {
	argocd_install:
		"Check the cluster's capacity and network egress, then re-run the deploy.",
	git_token: "Reconnect the git provider for this project, then re-run the deploy.",
	repo_credentials:
		"Verify the apps repo exists and the git connection can read it, then re-run the deploy.",
	templates_missing:
		"The runner image is missing its baked templates — update the runner, then re-run the deploy.",
	render: "The ArgoCD application templates failed to render — report this and re-run the deploy.",
	apply: "ArgoCD applications could not be applied — check cluster reachability, then re-run the deploy.",
};

/** The rollup line: component counts, or the honest fail-loud message. */
function rollup(status: GitopsDeployStatus): string {
	if (!status.statusAvailable) {
		return status.failedStep
			? "status unavailable · deploy failed before the health read"
			: "status unavailable · last deploy predates the health read";
	}
	const rows = [...status.services, ...status.addons, ...status.dataServices];
	const degraded = rows.filter((r) => r.health === "Degraded" || r.health === "Missing").length;
	const outOfSync = rows.filter((r) => r.sync === "OutOfSync").length;
	const warned = status.warnings.length;
	const parts = [`${rows.length} component${rows.length === 1 ? "" : "s"}`];
	if (degraded) parts.push(`${degraded} degraded`);
	if (outOfSync) parts.push(`${outOfSync} out of sync`);
	if (warned) parts.push(`${warned} warning${warned === 1 ? "" : "s"}`);
	if (!degraded && !outOfSync && !warned) parts.push("all healthy");
	return parts.join(" · ");
}

/** Section — the panel's shared eyebrow + bordered-rows idiom. */
function Section({
	title,
	hint,
	children,
}: {
	title: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<div className="vx-eyebrow pb-1 text-ui-3xs">{title}</div>
			<div className="border border-border px-3">{children}</div>
			{hint && (
				<p className="mx-0.5 mt-1.5 text-ui-xs leading-snug text-muted-foreground">
					{hint}
				</p>
			)}
		</div>
	);
}

/** One key/value wiring row (mono, right-aligned value). */
function Row({ k, v }: { k: string; v: React.ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-3 border-b border-border py-2 font-mono text-ui-xs last:border-0">
			<span className="text-muted-foreground">{k}</span>
			<span className="truncate text-right text-foreground">{v || "—"}</span>
		</div>
	);
}

/** One component row: name + optional ArgoCD message, health + sync badges. */
function ComponentRow({ row }: { row: GitopsComponentRow }) {
	return (
		<div className="flex items-start justify-between gap-3 border-b border-border py-2 last:border-0">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="truncate font-mono text-xs text-foreground">{row.name}</span>
				{row.message && (
					<span className="text-ui-xs leading-snug text-muted-foreground">
						{row.message}
					</span>
				)}
			</div>
			<div className="flex flex-none flex-col items-end gap-1">
				<StatusBadge status={row.health} tier={healthTier(row.health)} />
				<StatusBadge status={row.sync} tier={syncTier(row.sync)} />
			</div>
		</div>
	);
}

/** A component group; renders an empty-state note instead of rows when empty. */
function Group({
	title,
	rows,
	emptyText,
	hint,
}: {
	title: string;
	rows: GitopsComponentRow[];
	emptyText?: string;
	hint?: string;
}) {
	if (rows.length === 0 && !emptyText) return null;
	return (
		<Section title={title} hint={hint}>
			{rows.length === 0 ? (
				<div className="py-2.5 font-mono text-ui-xs leading-snug text-muted-foreground">
					{emptyText}
				</div>
			) : (
				rows.map((row) => <ComponentRow key={row.name} row={row} />)
			)}
		</Section>
	);
}

/** The Deploy tab's content — null status means the read hasn't landed yet. */
export function DeployPane({ status }: { status: GitopsDeployStatus | null }) {
	if (!status) {
		return <EmptyState className={PANEL_EMPTY} title="Loading…" />;
	}

	const gitops = status.mode === "gitops";
	const lastDeploy = status.lastDeployAt
		? formatDistanceToNow(new Date(status.lastDeployAt), { addSuffix: true })
		: null;

	return (
		<div className="space-y-4">
			<div className="font-mono text-ui-xs tracking-wide text-muted-foreground">
				{rollup(status)}
			</div>

			{status.failedStep && (
				<div className="border border-border bg-muted/40 p-3">
					<div className="flex items-center gap-2.5">
						<StatusBadge status="failed" label="Failed" />
						<span className="vx-eyebrow text-ui-3xs">
							GitOps deploy failed · {status.failedStep}
						</span>
					</div>
					{status.failureMessage && (
						<p className="mt-2.5 font-mono text-ui-xs leading-relaxed text-foreground">
							{status.failureMessage}
						</p>
					)}
					<div className="mt-2.5 flex items-baseline gap-2 border-t border-border pt-2.5">
						<span className="vx-eyebrow flex-none text-ui-3xs">Fix</span>
						<span className="text-xs leading-snug text-muted-foreground">
							{FIX_HINTS[status.failedStep] ?? "Re-run the deploy."}
						</span>
					</div>
				</div>
			)}

			{status.warnings.length > 0 && (
				<Section
					title={`Warnings · ${status.warnings.length}`}
					hint="Non-fatal — the deploy proceeded, but these workloads may boot misconfigured (a binding that couldn't resolve, a service skipped) until you fix them and re-deploy."
				>
					{status.warnings.map((w) => (
						<div
							key={w}
							className="flex items-start gap-2.5 border-b border-border py-2 last:border-0"
						>
							<span className="flex-none pt-px font-mono text-ui-xs leading-none text-muted-foreground">
								!
							</span>
							<span className="font-mono text-ui-xs leading-snug text-foreground">
								{w}
							</span>
						</div>
					))}
				</Section>
			)}

			<Section
				title="GitOps wiring"
				hint={
					gitops
						? undefined
						: "No GitOps repo connected — this environment applies directly. Add-on and data-service health is still read from ArgoCD."
				}
			>
				<Row k="mode" v={gitops ? "GitOps-managed" : "Direct apply"} />
				<Row k="apps repo" v={gitops ? status.appsRepo : "— none —"} />
				{gitops && (
					<Row
						k="argocd app"
						v={
							status.argocdUrl ? (
								<a
									href={status.argocdUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 underline underline-offset-2"
								>
									{status.argocdApp}
									<ExternalLink className="h-3 w-3" />
								</a>
							) : (
								status.argocdApp
							)
						}
					/>
				)}
				{gitops && <Row k="revision" v={status.revision?.slice(0, 7) ?? "—"} />}
				<Row
					k="last deploy"
					v={
						status.lastDeployFailed
							? `failed${lastDeploy ? ` · ${lastDeploy}` : ""}`
							: (lastDeploy ?? "never")
					}
				/>
			</Section>

			{gitops && (
				<Group
					title="Services"
					rows={status.services}
					emptyText="No services detected in the apps repo yet."
					hint={
						status.statusAvailable
							? undefined
							: status.failedStep
								? "The wiring failed before ArgoCD health could be read — services read Unknown, not a stale pass."
								: "This environment was deployed before per-service health reads existed — re-deploy (or wait for the next drift scan) to populate."
					}
				/>
			)}
			{!gitops && (
				<Group
					title="Services"
					rows={[]}
					emptyText="No apps repo — services are not GitOps-managed in this environment."
				/>
			)}

			<Group title="Add-ons" rows={status.addons} />
			<Group title="Data services" rows={status.dataServices} />
		</div>
	);
}
