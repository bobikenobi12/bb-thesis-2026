"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowRight, Loader2, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { globalHref } from "@/lib/routing";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";
import { Button } from "@repo/ui/button";
import { Textarea } from "@repo/ui/textarea";

import { RepoImportPanel } from "./repo-import-panel";
import {
	StartFromScratchCards,
	type ScratchKind,
} from "./start-from-scratch-cards";

/** Example prompts seeding the agent hero. */
const EXAMPLE_PROMPTS = [
	"An EKS cluster for an AI inference API — autoscaling GPU node pool, Postgres + pgvector, Redis.",
	"A GPU training cluster on AWS — spot node pool, shared storage, a Postgres metadata database.",
	"Postgres + pgvector, Redis, and an object store wired into a small cluster for a RAG backend.",
];

interface CreateProjectChooserProps {
	orgSlug: string;
	/** Whether the member can invite others (drives the Collaborate pill vs an upgrade nudge). */
	canCollaborate: boolean;
	/** Server flag — shows the BYO Helm scratch card. */
	byoHelmEnabled?: boolean;
	/** Server flag — shows the BYO IaC scratch card. */
	byoIacEnabled?: boolean;
}

/**
 * The `~/new` front door — **step 1: choose a source**. An Elench prompt hero on top, then two
 * first-class on-ramps side by side: **Import a repository** ({@link RepoImportPanel}, which scans →
 * `?scan=<jobId>`) and **Start from scratch** ({@link StartFromScratchCards}). Every source hands off
 * to the Configure screen (`?scan=` for import, `?scratch=<kind>` for the cards) where the project is
 * named, placed on a cloud, and its environments chosen before it's created.
 */
export function CreateProjectForm({
	orgSlug,
	canCollaborate,
	byoHelmEnabled,
	byoIacEnabled,
}: CreateProjectChooserProps) {
	const router = useRouter();
	const { openUpgrade } = useUpgradeSheet();
	const [prompt, setPrompt] = useState("");
	const [launching, setLaunching] = useState(false);

	/** Hands the hero prompt to the global Elench surface as a seed and opens it in org context. */
	const onAskAgent = () => {
		const seed = prompt.trim();
		if (!seed) {
			toast.error("Describe what you want to run first.");
			return;
		}
		setLaunching(true);
		useElenchStore.getState().setSeedPrompt(seed);
		useElenchStore.getState().openModal({ kind: "org" });
	};

	/** A scratch card hands off to the Configure screen for that source kind. */
	const onScratchSelect = (kind: ScratchKind) => {
		router.push(`${globalHref(orgSlug, "new")}?scratch=${kind}`);
	};

	return (
		<div className="mx-auto w-full max-w-5xl space-y-9 pb-20">
			{/* ===== agent hero (full width) ===== */}
			<section className="space-y-5">
				<div className="flex items-center justify-between gap-4">
					<h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
						Provision the future.
					</h1>
					{canCollaborate ? (
						<Link
							href={globalHref(orgSlug, "settings/members")}
							className="inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<Users className="size-3.5" />
							Collaborate
						</Link>
					) : (
						<button
							type="button"
							onClick={openUpgrade}
							className="inline-flex h-8 shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<Users className="size-3.5" />
							Collaborate
							<span className="rounded-full border border-border px-1.5 py-0.5 font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground">
								Pro
							</span>
						</button>
					)}
				</div>

				<div className="rounded-xl border border-border bg-card shadow-sm focus-within:border-ring">
					<div className="flex items-start gap-3 p-4 pb-2">
						<span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-border bg-foreground text-background">
							<Sparkles className="size-4" />
						</span>
						<Textarea
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							rows={2}
							placeholder="Ask the design agent to design your infrastructure — e.g. an EKS cluster for an AI inference API, with a Postgres + pgvector store…"
							className="min-h-0 resize-none border-0 bg-transparent p-0 pt-1 text-ui-lg shadow-none focus-visible:ring-0"
							onKeyDown={(e) => {
								if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
									e.preventDefault();
									onAskAgent();
								}
							}}
						/>
					</div>
					<div className="flex items-center justify-between px-4 pb-3">
						<span className="font-mono text-ui-2xs text-muted-foreground">
							⌘ + ⏎
						</span>
						<Button
							type="button"
							size="icon"
							className="size-9"
							onClick={onAskAgent}
							disabled={launching}
							aria-label="Design with the agent"
						>
							{launching ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<ArrowRight className="size-4" />
							)}
						</Button>
					</div>
				</div>

				<div className="flex flex-wrap gap-2">
					{EXAMPLE_PROMPTS.map((ex) => (
						<button
							key={ex}
							type="button"
							onClick={() => setPrompt(ex)}
							className="rounded-full border border-border bg-card px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							{ex.split(" — ")[0]}
						</button>
					))}
				</div>
			</section>

			{/* ===== the two source on-ramps ===== */}
			<div className="grid gap-6 lg:grid-cols-2">
				<div className="space-y-3">
					<ColHead>Import Git Repository</ColHead>
					<RepoImportPanel />
				</div>
				<div className="space-y-3">
					<ColHead>Start from scratch</ColHead>
					<StartFromScratchCards
						byoHelmEnabled={byoHelmEnabled ?? false}
						byoIacEnabled={byoIacEnabled ?? false}
						onSelect={onScratchSelect}
					/>
				</div>
			</div>
		</div>
	);
}

/** A small column heading with a trailing hairline rule. */
function ColHead({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-3">
			<span className="text-ui-md font-semibold tracking-tight">{children}</span>
			<span className="h-px flex-1 bg-border" />
		</div>
	);
}
