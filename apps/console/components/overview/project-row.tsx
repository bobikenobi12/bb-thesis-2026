"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview project row — the table-view counterpart to `ProjectCard`. One project per row:
// provider glyph + name, cloud, region, status, environment count, add-ons, estimated cost,
// last-deploy time, and the shared actions menu.

import { Box } from "lucide-react";
import Link from "next/link";
import { formatMonthlyRate, formatRelative } from "@repo/format";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { StatusBadge } from "@repo/ui/status-badge";
import { TableCell, TableRow } from "@repo/ui/table";
import type { ProjectListItem } from "@/app/server/actions/projects";
import { ProjectActionsMenu } from "@/components/overview/project-actions-menu";
import { orgHref, projectHref } from "@/lib/routing";

/** Human label for a cloud provider slug (falls back to uppercase). */
const PROVIDER_LABEL: Record<string, string> = {
	aws: "AWS",
	gcp: "GCP",
	azure: "Azure",
	alibaba: "Alibaba",
	digitalocean: "DigitalOcean",
	hetzner: "Hetzner",
	civo: "Civo",
};

/** A single project as a table row. */
export function ProjectRow({
	project,
	orgSlug,
	isFavorite,
	onToggleFavorite,
	connectedProviders,
}: {
	project: ProjectListItem;
	orgSlug: string;
	isFavorite: boolean;
	onToggleFavorite: () => void;
	/** Cloud provider slugs with a live connection — the logo is full color when connected. */
	connectedProviders: string[];
}) {
	const href = project.slug
		? projectHref(orgSlug, project.slug)
		: orgHref(orgSlug);
	const provider = project.cloud_provider;
	const providerConnected = provider
		? connectedProviders.includes(provider)
		: false;

	return (
		<TableRow className="group/row">
			<TableCell>
				<Link href={href} className="flex items-center gap-2.5">
					{provider ? (
						<ProviderIcon
							provider={provider}
							size={18}
							mono={!providerConnected}
							className="shrink-0"
						/>
					) : (
						<Box className="size-4 shrink-0 text-muted-foreground" />
					)}
					<span className="truncate font-display text-ui-md font-medium text-foreground group-hover/row:underline">
						{project.project_name}
					</span>
				</Link>
			</TableCell>
			<TableCell className="text-muted-foreground">
				{provider ? (PROVIDER_LABEL[provider] ?? provider.toUpperCase()) : "—"}
			</TableCell>
			<TableCell className="font-mono text-ui-xs text-muted-foreground">
				{project.region || "—"}
			</TableCell>
			<TableCell>
				<StatusBadge status={project.status} />
			</TableCell>
			<TableCell className="font-mono text-ui-xs text-muted-foreground">
				{project.environments_count}
			</TableCell>
			<TableCell className="font-mono text-ui-xs text-muted-foreground">
				{project.addons_count}
			</TableCell>
			<TableCell className="text-right font-mono text-ui-xs text-muted-foreground">
				{project.estimated_monthly_cost
					? formatMonthlyRate(project.estimated_monthly_cost)
					: "—"}
			</TableCell>
			<TableCell className="text-right font-mono text-ui-xs text-muted-foreground">
				{project.last_deployed_at
					? formatRelative(project.last_deployed_at)
					: "Never"}
			</TableCell>
			<TableCell className="text-right">
				<ProjectActionsMenu
					project={project}
					orgSlug={orgSlug}
					isFavorite={isFavorite}
					onToggleFavorite={onToggleFavorite}
					triggerClassName="ml-auto opacity-0 focus-visible:opacity-100 data-[state=open]:opacity-100 group-hover/row:opacity-100"
				/>
			</TableCell>
		</TableRow>
	);
}
