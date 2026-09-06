"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowRight, GitBranch, Loader2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import type { Repository } from "@/app/server/actions/git/types";
import { scanRepo } from "@/app/server/actions/scanner";
import { RepositorySelector } from "@/components/repository-selector";
import { cn } from "@repo/ui/utils";
import { Button } from "@repo/ui/button";
import { SectionHeading } from "@repo/ui/section-heading";

interface RepoImportPanelProps {
	/** Optional wrapper class so the front door can slot the panel into its layout. */
	className?: string;
}

/**
 * The first-class "Import a repository" on-ramp for `~/new`: pick a git repo, queue a scan, then
 * hand off to the scan-review bridge. Reuses {@link RepositorySelector} (git-provider → repo pick)
 * and {@link scanRepo} (queues an ANALYZE_REPO job), then navigates to `?scan=<jobId>` — the page
 * already renders the review via `getScanProposal` → `DesignProjectWorkbench` / `ScanReviewNotice`.
 * No agent involved and no new backend: this exposes the north-star motion as a button.
 */
export function RepoImportPanel({ className }: RepoImportPanelProps) {
	const router = useRouter();
	const pathname = usePathname();
	const [repoUrl, setRepoUrl] = useState<string | undefined>(undefined);
	// The repo's default branch, passed as the scan ref so the runner clones the right head.
	const [ref, setRef] = useState<string | undefined>(undefined);
	const [scanning, setScanning] = useState(false);

	/** Records the picked repo's URL + default branch (the scan ref). */
	const onRepositorySelect = (repo: Repository) => {
		setRepoUrl(repo.url);
		setRef(repo.default_branch || undefined);
	};

	/** Queues the scan and hands off to the `?scan=` review bridge on the same page. */
	const onScan = async () => {
		if (!repoUrl) {
			toast.error("Pick a repository to import.");
			return;
		}
		setScanning(true);
		try {
			const { jobId } = await scanRepo(repoUrl, ref ? { ref } : undefined);
			router.push(`${pathname}?scan=${jobId}`);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to start the scan.",
			);
			setScanning(false);
		}
	};

	return (
		<section className={cn("space-y-0", className)}>
			<div className="rounded-xl border border-border bg-card shadow-sm">
				<div className="flex items-start gap-3 p-4 pb-3">
					<span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-border text-muted-foreground">
						<GitBranch className="size-4" />
					</span>
					<SectionHeading
						className="min-w-0 flex-1"
						title="Import a repository"
						description="Scan a git repo — Alethia infers the stack and opens it on the canvas to review before you provision."
					/>
				</div>
				<div className="space-y-3 px-4 pb-4">
					<RepositorySelector
						value={repoUrl}
						onChange={(v) => setRepoUrl(v || undefined)}
						onRepositorySelect={onRepositorySelect}
						label=""
						placeholder="Select a repository to import…"
					/>
					<div className="flex items-center justify-between gap-3">
						<span className="truncate font-mono text-ui-2xs uppercase tracking-wider text-muted-foreground">
							{repoUrl
								? ref
									? `branch · ${ref}`
									: "default branch"
								: "no repository selected"}
						</span>
						<Button
							type="button"
							onClick={() => void onScan()}
							disabled={!repoUrl || scanning}
						>
							{scanning ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<>
									Scan repository
									<ArrowRight className="size-4" />
								</>
							)}
						</Button>
					</div>
				</div>
			</div>
		</section>
	);
}
