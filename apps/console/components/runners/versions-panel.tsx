"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Versions panel (left column): the latest runner release, an "updates available" action
// that rolls every outdated deployed runner, and a changelog of recent releases. Replaces
// the old top-of-page updates banner.

import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { Card } from "@repo/ui/card";
import { Skeleton } from "@repo/ui/skeleton";
import { ReleaseNotesPopover } from "@/components/runners/release-notes-popover";
import { getRecentRunnerReleases } from "@/app/server/actions/runners";
import {
	useRunnersQuery,
	useUpdateAllOutdated,
	type RunnerReleaseInfo,
} from "@/lib/query/use-runners-query";
import { formatRelative } from "@repo/format";
import { ArrowUpCircle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const MONO_LABEL = "font-mono text-ui-3xs uppercase tracking-[0.12em] text-muted-foreground";

/** A clickable version label that opens the release-notes popover. */
function VersionLink({ version }: { version: string }) {
	return (
		<ReleaseNotesPopover version={version}>
			<button
				type="button"
				className="cursor-pointer font-mono text-xs font-medium text-foreground transition-colors hover:underline"
			>
				v{version}
			</button>
		</ReleaseNotesPopover>
	);
}

export function VersionsPanel() {
	const { data: runnersData } = useRunnersQuery();
	const runners = runnersData?.runners ?? [];
	const latestRelease = runnersData?.latestRelease ?? null;
	const { mutateAsync: updateAllOutdated } = useUpdateAllOutdated();
	const [releases, setReleases] = useState<RunnerReleaseInfo[] | null>(null);
	const [isUpdatingAll, setIsUpdatingAll] = useState(false);

	// Recent releases for the changelog. Re-fetched when the latest version changes (a poll
	// may have surfaced a new release).
	useEffect(() => {
		getRecentRunnerReleases(8)
			.then(setReleases)
			.catch(() => setReleases([]));
	}, [latestRelease?.version]);

	// Runners not on the latest release, and the subset we can roll in place (deployed, i.e. have a
	// deploy config). UPDATE re-mints a fresh token, so no stored token is needed. The rest need a
	// manual re-deploy.
	const { outdated, updatable } = useMemo(() => {
		if (!latestRelease) return { outdated: 0, updatable: Array<string>() };
		const out = runners.filter((r) => r.version && r.version !== latestRelease.version);
		const upd = out.filter(
			(r) => r.cloud_identity_id && r.metadata?.deploy_config,
		);
		return { outdated: out.length, updatable: upd.map((r) => r.id) };
	}, [runners, latestRelease]);

	const handleUpdateAll = async () => {
		setIsUpdatingAll(true);
		try {
			const { queued, failed } = await updateAllOutdated(updatable);
			if (failed === 0) toast.success(`${queued} update${queued !== 1 ? "s" : ""} queued`);
			else toast.warning(`${queued} queued, ${failed} failed`);
		} catch {
			toast.error("Failed to queue updates");
		} finally {
			setIsUpdatingAll(false);
		}
	};

	return (
		<section className="space-y-3">
			<div className="flex items-center justify-between gap-2">
				<span className="text-sm font-semibold tracking-tight text-foreground">Versions</span>
				{latestRelease && (
					<span className={MONO_LABEL}>latest v{latestRelease.version}</span>
				)}
			</div>

			<Card className="gap-0 overflow-hidden py-0">
				{/* latest release */}
				{latestRelease ? (
					<div className="flex flex-col gap-2 border-b border-border p-4">
						<span className={MONO_LABEL}>Latest release</span>
						<div className="flex items-center gap-2">
							<VersionLink version={latestRelease.version} />
							{latestRelease.is_breaking && (
								<Badge variant="destructive" className="py-0 text-ui-2xs">
									Breaking
								</Badge>
							)}
						</div>
						<span className="text-ui-xs text-muted-foreground">
							Released {formatRelative(latestRelease.released_at)}
						</span>
					</div>
				) : (
					<div className="p-4 text-xs text-muted-foreground">No runner releases yet.</div>
				)}

				{/* updates available */}
				{outdated > 0 && latestRelease && (
					<div className="flex items-start gap-2.5 border-b border-border bg-muted/40 p-4">
						<ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
						<div className="min-w-0 flex-1 space-y-2">
							<p className="text-xs text-foreground">
								<strong>
									{outdated} runner{outdated !== 1 ? "s" : ""}
								</strong>{" "}
								behind v{latestRelease.version}
								{outdated > updatable.length && (
									<span className="text-muted-foreground">
										{" "}
										· {outdated - updatable.length} need re-deploy
									</span>
								)}
							</p>
							{updatable.length > 0 && (
								<Button
									size="sm"
									variant="outline"
									className="h-7 text-xs"
									disabled={isUpdatingAll}
									onClick={handleUpdateAll}
								>
									{isUpdatingAll ? (
										<>
											<Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
											Updating…
										</>
									) : (
										<>Update all ({updatable.length})</>
									)}
								</Button>
							)}
						</div>
					</div>
				)}

				{/* changelog */}
				<div className="flex flex-col">
					<div className={`${MONO_LABEL} px-4 pb-1 pt-3`}>Changelog</div>
					{releases === null ? (
						<div className="space-y-2 p-4 pt-1">
							<Skeleton className="h-4 w-full" />
							<Skeleton className="h-4 w-3/4" />
						</div>
					) : releases.length === 0 ? (
						<div className="px-4 pb-4 pt-1 text-xs text-muted-foreground">No releases.</div>
					) : (
						<ul className="pb-2">
							{releases.map((r) => (
								<li
									key={r.version}
									className="flex items-center justify-between gap-2 px-4 py-1.5"
								>
									<VersionLink version={r.version} />
									<div className="flex items-center gap-2">
										{r.is_breaking && (
											<Badge variant="outline" className="border-border bg-muted py-0 text-ui-3xs text-muted-foreground">
												Breaking
											</Badge>
										)}
										<span className="font-mono text-ui-2xs text-muted-foreground">
											{formatRelative(r.released_at)}
										</span>
									</div>
								</li>
							))}
						</ul>
					)}
				</div>
			</Card>
		</section>
	);
}
