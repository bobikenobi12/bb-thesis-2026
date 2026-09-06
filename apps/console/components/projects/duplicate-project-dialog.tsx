"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cross-cloud "Quick Duplicate" dialog. Copies a project's design onto another cloud, translating
// every provider-specific value (region, instance types, DB engines, cache nodes, …) via
// `convertProjectConfig` server-side and surfacing the conversion notes. The new project is created
// in DRAFT so nothing is provisioned until the user reviews it in the canvas ("duplicate & edit").

import {
	ArrowRight,
	CircleAlert,
	CircleX,
	Info,
	Loader2,
} from "lucide-react";
import { getProvider, isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	getVerifiedCloudIdentities,
	type CloudIdentityOption,
} from "@/app/server/actions/aws/identities";
import {
	type DuplicateCategory,
	duplicateProjectForProvider,
	getProjectDuplicateSummary,
} from "@/app/server/actions/projects";
import type { ConversionWarning } from "@/lib/cloud-providers";
import { groupRegions, REGION_LABELS } from "@/lib/cloud-providers";
import {
	type CloudProviderMeta,
	type CloudProviderSlug,
	PROVIDERS,
} from "@/lib/cloud-providers/generated/catalog";
import { projectHref } from "@/lib/routing";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { ScrollArea } from "@repo/ui/scroll-area";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Separator } from "@repo/ui/separator";
import { cn } from "@repo/ui/utils";

/** Clouds with full provisioning templates + a conversion mapping — the only valid duplicate targets. */
const TARGET_PROVIDERS: CloudProviderSlug[] = ["aws", "gcp", "azure", "alibaba"];

/** Maps a design category to its label + the provider-metadata field naming that cloud's service. */
const CATEGORY_SERVICE: Record<
	DuplicateCategory,
	{ label: string; field: keyof CloudProviderMeta }
> = {
	network: { label: "Network", field: "networkName" },
	cluster: { label: "Kubernetes", field: "clusterService" },
	dns: { label: "DNS", field: "dnsService" },
	databases: { label: "Database", field: "dbService" },
	caches: { label: "Cache", field: "cacheService" },
	nosql: { label: "NoSQL", field: "nosqlService" },
	queues: { label: "Queue", field: "queueService" },
	topics: { label: "Topic", field: "topicService" },
	secrets: { label: "Secrets", field: "secretsService" },
};

/** Grayscale severity treatment — icon + mono label, `destructive` reserved for hard errors. */
const SEVERITY_META = {
	error: { icon: CircleX, label: "ERROR", tone: "text-destructive" },
	warning: { icon: CircleAlert, label: "REVIEW", tone: "text-foreground" },
	info: { icon: Info, label: "NOTE", tone: "text-muted-foreground" },
} as const;

interface DuplicateResult {
	newProjectSlug: string;
	warnings: ConversionWarning[];
}

/**
 * Dialog for duplicating a project onto a different cloud provider. `sourceProjectId` /
 * `sourceProjectName` identify the project being copied; `orgSlug` is used to navigate into the new
 * project's canvas on success.
 */
export function DuplicateProjectDialog({
	open,
	onOpenChange,
	sourceProjectId,
	sourceProjectName,
	orgSlug,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sourceProjectId: string;
	sourceProjectName: string;
	orgSlug: string;
}) {
	const router = useRouter();

	const [sourceProvider, setSourceProvider] = useState<CloudProviderSlug | null>(
		null,
	);
	const [categories, setCategories] = useState<DuplicateCategory[]>([]);
	const [identities, setIdentities] = useState<CloudIdentityOption[]>([]);
	const [loadingContext, setLoadingContext] = useState(false);
	const [selectedIdentityId, setSelectedIdentityId] = useState("");
	const [targetRegion, setTargetRegion] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [result, setResult] = useState<DuplicateResult | null>(null);

	/** Resets every field to its initial state (on close + after a successful duplicate). */
	const reset = useCallback(() => {
		setSelectedIdentityId("");
		setTargetRegion("");
		setResult(null);
	}, []);

	// Load the source project's design summary + the user's other-cloud accounts when the dialog opens.
	useEffect(() => {
		if (!open) return;
		reset();
		let cancelled = false;
		setLoadingContext(true);
		(async () => {
			try {
				const [summary, allIdentities] = await Promise.all([
					getProjectDuplicateSummary(sourceProjectId),
					getVerifiedCloudIdentities(),
				]);
				if (cancelled) return;
				setSourceProvider(summary.provider);
				setCategories(summary.categories);
				// Only other-provider accounts on a cloud we can actually provision + convert to.
				setIdentities(
					allIdentities.filter(
						(i) =>
							i.provider !== summary.provider &&
							// `.some(===)` compares the identity's CloudProvider against the
							// CloudProviderSlug targets without a cast (the slugs derive from the enum).
							TARGET_PROVIDERS.some((t) => t === i.provider),
					),
				);
			} catch {
				if (!cancelled) toast.error("Failed to load project details");
			} finally {
				if (!cancelled) setLoadingContext(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, sourceProjectId, reset]);

	const targetIdentity = identities.find((i) => i.id === selectedIdentityId);
	const targetProvider =
		targetIdentity && isCloudProviderSlug(targetIdentity.provider)
			? targetIdentity.provider
			: undefined;

	/** Submits the duplication request and shows the conversion result. */
	async function handleDuplicate() {
		if (!selectedIdentityId || !targetRegion) return;
		setSubmitting(true);
		try {
			const res = await duplicateProjectForProvider(
				sourceProjectId,
				selectedIdentityId,
				targetRegion,
			);
			setResult({ newProjectSlug: res.newProjectSlug, warnings: res.warnings });
			toast.success("Project duplicated");
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to duplicate project",
			);
		} finally {
			setSubmitting(false);
		}
	}

	/** Opens the new project's canvas so the user can review before the first deploy. */
	function openInCanvas() {
		if (!result) return;
		onOpenChange(false);
		router.push(projectHref(orgSlug, result.newProjectSlug));
	}

	// --- Success state: conversion notes + "open in canvas" ---
	if (result) {
		const grouped = groupWarnings(result.warnings);
		return (
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Project duplicated</DialogTitle>
						<DialogDescription>
							<span className="font-medium text-foreground">
								{sourceProjectName}
							</span>{" "}
							was copied to{" "}
							{targetProvider ? getProvider(targetProvider).shortName : "the target cloud"}
							{" "}as a draft. Review it in the canvas before you deploy.
						</DialogDescription>
					</DialogHeader>

					{result.warnings.length > 0 ? (
						<ScrollArea className="max-h-64 rounded-md border border-border">
							<ul className="divide-y divide-border">
								{grouped.map((w, idx) => {
									const meta = SEVERITY_META[w.severity];
									const Icon = meta.icon;
									return (
										<li
											key={`${w.component}-${idx}`}
											className="flex items-start gap-2.5 p-3"
										>
											<Icon className={cn("mt-0.5 h-4 w-4 shrink-0", meta.tone)} />
											<div className="min-w-0 space-y-0.5">
												<div className="flex items-center gap-2">
													<span className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
														{meta.label}
													</span>
													<span className="text-xs font-medium">
														{w.component}
													</span>
												</div>
												<p className="text-xs text-muted-foreground">
													{w.message}
												</p>
											</div>
										</li>
									);
								})}
							</ul>
						</ScrollArea>
					) : (
						<p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
							No conversion notes — every service mapped cleanly.
						</p>
					)}

					<DialogFooter>
						<Button variant="outline" onClick={() => onOpenChange(false)}>
							Close
						</Button>
						<Button onClick={openInCanvas}>Open in canvas</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		);
	}

	// --- Form state ---
	const targetRegionCodes = targetProvider
		? Object.keys(REGION_LABELS[targetProvider] ?? {})
		: [];
	const noTargets = !loadingContext && identities.length === 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Duplicate to another cloud</DialogTitle>
					<DialogDescription>
						Copy{" "}
						<span className="font-medium text-foreground">{sourceProjectName}</span>
						{sourceProvider ? ` from ${getProvider(sourceProvider).shortName}` : ""} to a
						different cloud. Every service is translated to its native equivalent there.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-1.5">
						<label className="text-xs font-medium">Target cloud account</label>
						{loadingContext ? (
							<div className="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2 className="h-4 w-4 animate-spin" />
								Loading accounts…
							</div>
						) : noTargets ? (
							<p className="text-sm text-muted-foreground">
								No other-cloud accounts connected. Add one in Integrations to duplicate
								across clouds.
							</p>
						) : (
							<Select
								value={selectedIdentityId}
								onValueChange={(id) => {
									setSelectedIdentityId(id);
									setTargetRegion("");
								}}
							>
								<SelectTrigger className="h-9 text-sm">
									<SelectValue placeholder="Select cloud account" />
								</SelectTrigger>
								<SelectContent>
									{identities.map((identity) => (
										<SelectItem key={identity.id} value={identity.id}>
											<span className="flex items-center gap-2">
												<ProviderIcon
													provider={identity.provider}
													size={16}
													className="shrink-0 grayscale"
												/>
												<span>{identity.name}</span>
												{identity.displayId && (
													<span className="font-mono text-xs text-muted-foreground">
														{identity.displayId}
													</span>
												)}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					</div>

					<div className="space-y-1.5">
						<label className="text-xs font-medium">Target region</label>
						<Select
							value={targetRegion}
							onValueChange={setTargetRegion}
							disabled={!targetProvider}
						>
							<SelectTrigger className="h-9 text-sm">
								<SelectValue
									placeholder={
										targetProvider ? "Select region" : "Select an account first"
									}
								/>
							</SelectTrigger>
							<SelectContent>
								{targetProvider &&
									groupRegions(targetRegionCodes, targetProvider).map((group) => (
										<SelectGroup key={group.group}>
											<SelectLabel>{group.group}</SelectLabel>
											{group.regions.map((r) => (
												<SelectItem key={r.value} value={r.value}>
													{r.label}{" "}
													<span className="font-mono text-xs text-muted-foreground">
														({r.value})
													</span>
												</SelectItem>
											))}
										</SelectGroup>
									))}
							</SelectContent>
						</Select>
					</div>

					{/* Service-mapping preview — what each managed service becomes on the target. */}
					{sourceProvider && targetProvider && categories.length > 0 && (
						<div className="space-y-2">
							<Separator />
							<p className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
								Service mapping
							</p>
							<ul className="space-y-1">
								{categories.map((cat) => {
									const { label, field } = CATEGORY_SERVICE[cat];
									const from = PROVIDERS[sourceProvider][field];
									const to = PROVIDERS[targetProvider][field];
									return (
										<li
											key={cat}
											className="flex items-center gap-2 text-xs"
										>
											<span className="w-16 shrink-0 text-muted-foreground">
												{label}
											</span>
											<span className="font-mono">{from}</span>
											<ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
											<span className="font-mono">{to}</span>
										</li>
									);
								})}
							</ul>
						</div>
					)}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						onClick={handleDuplicate}
						disabled={submitting || !selectedIdentityId || !targetRegion}
					>
						{submitting ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								Duplicating…
							</>
						) : (
							"Duplicate"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Orders conversion warnings error → warning → info so the most severe surface first. */
function groupWarnings(warnings: ConversionWarning[]): ConversionWarning[] {
	const order = { error: 0, warning: 1, info: 2 } as const;
	return [...warnings].sort((a, b) => order[a.severity] - order[b.severity]);
}
