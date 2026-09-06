"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatStatus } from "ai";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { AlethiaMark } from "@repo/brand/lockup";
import type { Mention } from "@/lib/ai/mentions";
import { track } from "@/lib/analytics/track";
import type { AgentThread } from "@/lib/db/schema";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";
import { Button } from "@repo/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@repo/ui/empty";
import { cn } from "@repo/ui/utils";
import { ElenchComposer } from "./elench-composer";
import type { ElenchSuggestion } from "./elench-suggestions";
import { SuggestionCarousel } from "./suggestion-carousel";

/** Which Elench context the landing is rendered for (drives analytics + the Try-now prompt). */
export type ElenchContext = "org" | "project";

/**
 * A viz-forcing "Try now" prompt that always asks for a generative dashboard, tailored
 * to the current context so the model fetches the right metrics before it builds.
 */
function tryNowPrompt(context: ElenchContext): string {
	return context === "org"
		? "Build a dashboard of my infrastructure — clusters, jobs, cost, and drift — as stat cards and charts."
		: "Build a dashboard for this project — cost breakdown, plan/verify status, and cluster topology — as stat cards and charts.";
}

/** "9m", "3h", "2d" since a timestamp. */
function relTime(d: Date): string {
	const m = Math.floor((Date.now() - d.getTime()) / 60_000);
	if (m < 1) return "now";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

/** Local-time greeting ("Good morning/afternoon/evening"). */
function greeting(): string {
	const h = new Date().getHours();
	if (h < 12) return "Good morning.";
	if (h < 18) return "Good afternoon.";
	return "Good evening.";
}

/** The bracketed-point mark as the surface's focal graphic (grayscale, currentColor). */
function ElenchMark({ className }: { className?: string }) {
	return (
		<AlethiaMark
			aria-hidden
			className={cn("mx-auto text-foreground", className)}
		/>
	);
}

interface ModalLandingProps {
	onSend: (text: string, mentions?: Mention[]) => void;
	suggestions: ElenchSuggestion[];
	/** Recent threads for "Ready to keep going?" (empty → section hidden). */
	recents: AgentThread[];
	onOpenThread: (id: string) => void;
	/** Show the model picker in the hero composer (org only). */
	showModel?: boolean;
	/** Org vs project — drives the Try-now prompt + analytics context. */
	context: ElenchContext;
	status?: ChatStatus;
}

/**
 * The modal empty landing — the hero (mark + "What should we do today?" + composer),
 * a paged suggestion carousel (3 cards × 3 pages with dot indicators, cycled by the
 * right-hand button — no scroll), "Ready to keep going?" recents, and the
 * "Draw, describe, go!" viz section with a "Try now" generative-dashboard button.
 * Ported from the Elench design, rebranded to the grayscale system.
 */
export function ElenchModalLanding({
	onSend,
	suggestions,
	recents,
	onOpenThread,
	showModel,
	context,
	status,
}: ModalLandingProps) {
	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto max-w-[830px] px-6 pb-16 pt-24">
				<ElenchMark className="mb-6 h-20 w-auto" />
			<h1 className="mb-10 text-center text-4xl font-semibold tracking-tight">
				What should we do today?
			</h1>

			<ElenchComposer
				onSend={onSend}
				showModel={showModel}
				status={status}
				autoFocus
			/>

{/* Paged suggestion carousel — 3 cards × 3 pages, cycled by its own button
				    (no scroll). Selecting a card records analytics + sends its prompt. */}
				<SuggestionCarousel
					suggestions={suggestions}
					onSelect={(prompt) => {
						const s = suggestions.find((x) => x.prompt === prompt);
						track("elench_suggestion_clicked", { title: s?.title, context });
						onSend(prompt);
					}}
				/>

			<DotDivider />

			{/* Ready to keep going — recent threads. */}
			{recents.length > 0 && (
				<section className="border border-border bg-muted/40 p-5">
					<div className="flex items-start justify-between gap-3">
						<div>
							<div className="text-base font-semibold">Ready to keep going?</div>
							<div className="mt-0.5 text-ui-md text-muted-foreground">
								Continue your recent exploration.
							</div>
						</div>
					</div>
					<div className="mt-4 flex gap-3">
						{recents.slice(0, 2).map((t) => (
							<button
								key={t.id}
								type="button"
								onClick={() => onOpenThread(t.id)}
								className="flex min-h-[68px] min-w-0 flex-1 flex-col justify-between border border-border bg-background p-4 text-left transition-colors hover:bg-muted"
							>
								<span
									title={t.title}
									className="line-clamp-2 min-w-0 break-words text-ui-md text-foreground"
								>
									{t.title}
								</span>
								<span className="mt-4 font-mono text-ui-xs text-muted-foreground">
									{relTime(new Date(t.updated_at))}
								</span>
							</button>
						))}
					</div>
				</section>
			)}

			<DotDivider />

			{/* Draw, describe, go — a clean CTA that opens the split pane in a loading state and
				    asks the agent for a full generative dashboard (which then fills the pane). */}
			<section className="flex items-center justify-between gap-4 border border-border bg-muted/40 p-5">
				<div>
					<div className="text-base font-semibold">Draw, describe, go.</div>
					<div className="mt-0.5 text-ui-md text-muted-foreground">
						Build a live dashboard of your infrastructure — Elench gathers the data and
						composes it into stat cards and charts in the side panel.
					</div>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="flex-none gap-1.5 rounded-none"
					onClick={() => {
						track("elench_try_now_used", { context });
						// Open the split pane's widget grid immediately (its empty state is the
						// composing hint); the model's build_dashboard blocks auto-pin into it.
						useArtifactStore.getState().openGrid();
						onSend(tryNowPrompt(context));
					}}
				>
					<Sparkles className="h-3.5 w-3.5" />
					Try now
				</Button>
			</section>
			</div>
		</div>
	);
}

/** The three-dot section separator from the design. */
function DotDivider() {
	return (
		<div className="flex justify-center gap-1.5 py-7">
			{[0, 1, 2].map((i) => (
				<span key={i} className="size-1 rounded-full bg-border" />
			))}
		</div>
	);
}

interface PanelEmptyProps {
	onSend: (text: string, mentions?: Mention[]) => void;
	suggestions: ElenchSuggestion[];
	supportHref?: string;
}

/**
 * The panel empty state — a "Need more help?" banner, the mark + greeting, and the
 * suggestion cards. The docked composer is rendered by the shared chat below this.
 */
export function ElenchPanelEmpty({
	onSend,
	suggestions,
	supportHref,
}: PanelEmptyProps) {
	return (
		<div className="p-3.5">
			<div className="flex items-center justify-between border border-border bg-background px-3.5 py-2.5">
				<span className="text-ui-md text-foreground">Need more help?</span>
				{supportHref && (
					<Button
						variant="outline"
						size="xs"
						className="rounded-none"
						nativeButton={false}
						render={<Link href={supportHref} />}
					>
						Support
					</Button>
				)}
			</div>

			{/* The panel's own empty state — nothing has been said yet, so this IS the region's
			    "nothing here". Composed from the `@repo/ui/empty` PARTS rather than the one-call
			    `EmptyState` because the mark is the surface's focal graphic at 56px, not an icon
			    in a 40px muted tile, and the greeting is the agent's invitation rather than the
			    name of a page — the reason this file's `<h1>` is already a recorded decision. */}
			<Empty className="gap-3 p-0 py-10 md:p-0 md:py-10">
				<EmptyHeader className="gap-1">
					<EmptyMedia>
						<ElenchMark className="mb-4 h-14 w-auto" />
					</EmptyMedia>
					<EmptyTitle className="text-lg font-semibold">{greeting()}</EmptyTitle>
					<EmptyDescription className="text-sm">
						What are we doing today?
					</EmptyDescription>
				</EmptyHeader>
			</Empty>

			<div className="flex flex-col gap-2.5">
				{suggestions.map((s) => (
					<button
						key={s.title}
						type="button"
						onClick={() => onSend(s.prompt)}
						className="flex items-center gap-3 border border-border bg-background px-3 py-3 text-left transition-colors hover:bg-muted"
					>
						<span className="flex size-8 flex-none items-center justify-center border border-border text-muted-foreground">
							<s.icon className="h-4 w-4" />
						</span>
						<span className="min-w-0">
							<span className="block text-ui-md font-medium text-foreground">
								{s.title}
							</span>
							<span className="block text-xs text-muted-foreground">
								{s.sub}
							</span>
						</span>
					</button>
				))}
			</div>
		</div>
	);
}
