"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowRight, Boxes, Cpu, GitBranch, Loader2, Square } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@repo/ui/utils";

/** The four ways to start a project from scratch (no repo import). */
export type ScratchKind = "template" | "byo-helm" | "byo-iac" | "blank";

interface ScratchCard {
	kind: ScratchKind;
	title: string;
	description: string;
	icon: LucideIcon;
	/** Shows the "New" pill (the recently-added on-ramps). */
	isNew?: boolean;
}

interface StartFromScratchCardsProps {
	/** Gate the BYO Helm card (ALETHIA_BYO_HELM_ENABLED). */
	byoHelmEnabled: boolean;
	/** Gate the BYO IaC card (ALETHIA_BYO_IAC_ENABLED). */
	byoIacEnabled: boolean;
	/** Disable every card while a create is in flight. */
	busy?: boolean;
	/** Which card is mid-create (renders a spinner in its icon slot). */
	pending?: ScratchKind | null;
	/** The host wires each kind to a create-and-navigate handler (it owns name + cloud + placement). */
	onSelect: (kind: ScratchKind) => void;
}

/**
 * The start-from-scratch card grid — the right column of the `~/new` front door. A presentational
 * 2×2 grid of the four scratch on-ramps (Template · BYO Helm · BYO IaC · Blank); the host form owns
 * the create-and-navigate logic per kind (it holds the project name, selected cloud and placement)
 * and passes it as `onSelect`. Feature-gated cards drop out when their flag is off.
 *
 * - **Template** → a standard cluster the user configures (cloud + template) → canvas.
 * - **BYO Helm** → empty project → `?attachChart=1` (the ByoChartDialog on the canvas).
 * - **BYO IaC** → empty project → `?attachIac=1` (the ByoIacDialog on the canvas).
 * - **Blank** → an empty project → the canvas, components added by hand.
 */
export function StartFromScratchCards({
	byoHelmEnabled,
	byoIacEnabled,
	busy,
	pending,
	onSelect,
}: StartFromScratchCardsProps) {
	const cards: ScratchCard[] = [
		{
			kind: "template",
			title: "Start from a template",
			description:
				"A standard cluster you configure — pick a cloud and template, then design.",
			icon: Cpu,
		},
		...(byoHelmEnabled
			? [
					{
						kind: "byo-helm" as const,
						title: "Bring your own Helm chart",
						description:
							"Start from a git repo — Alethia deploys and governs it on your cluster via ArgoCD.",
						icon: GitBranch,
						isNew: true,
					},
				]
			: []),
		...(byoIacEnabled
			? [
					{
						kind: "byo-iac" as const,
						title: "Bring your own IaC",
						description:
							"Start from a git repo — Alethia plans, verifies, and applies your OpenTofu module.",
						icon: Boxes,
						isNew: true,
					},
				]
			: []),
		{
			kind: "blank",
			title: "Blank project",
			description: "An empty canvas — add components yourself and design from scratch.",
			icon: Square,
		},
	];

	return (
		<div className="grid gap-3 sm:grid-cols-2">
			{cards.map((card) => {
				const Icon = card.icon;
				const isPending = pending === card.kind;
				return (
					<button
						key={card.kind}
						type="button"
						onClick={() => onSelect(card.kind)}
						disabled={busy}
						className="group flex w-full items-start gap-4 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-ring disabled:opacity-60"
					>
						<span className="grid size-9 shrink-0 place-items-center rounded-md border border-border text-muted-foreground">
							{isPending ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<Icon className="size-4" />
							)}
						</span>
						<span className="min-w-0 flex-1">
							<span className="flex items-center gap-2 text-ui-lg font-medium text-foreground">
								{card.title}
								{card.isNew && (
									<span className="rounded-full border border-border px-1.5 py-0.5 font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground">
										New
									</span>
								)}
							</span>
							<span className="mt-0.5 block text-ui-sm text-muted-foreground">
								{card.description}
							</span>
						</span>
						<ArrowRight
							className={cn(
								"size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5",
							)}
						/>
					</button>
				);
			})}
		</div>
	);
}
