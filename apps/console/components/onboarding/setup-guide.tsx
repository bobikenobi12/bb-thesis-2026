"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// In-product first-run "Setup guide" (Stripe-style). A topbar button with a circular
// progress ring is the resting state (`SetupGuideButton`); clicking it toggles a
// bottom-right checklist card (`SetupGuideCard`). Steps tick off from the org's REAL
// state (connected clouds, projects, a successful provision, members) — never click-tracked
// — so there is no permanent dismiss: closing the card just parks it back in the topbar,
// and the whole thing self-hides once every step is done.

import {
	ArrowRight,
	Check,
	ChevronDown,
	Cloud,
	FileCode2,
	Server,
	Terminal,
	Users,
} from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import type { GettingStartedState } from "@/app/server/actions/onboarding";
import { globalHref, orgHref } from "@/lib/routing";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { useSetupGuideStore } from "@/lib/stores/use-setup-guide-store";
import { Button } from "@repo/ui/button";
import { SectionHeading } from "@repo/ui/section-heading";
import { cn } from "@repo/ui/utils";

interface Step {
	key: string;
	title: string;
	desc: string;
	href: string;
	done: boolean;
	icon: React.ReactNode;
}

/**
 * Builds the ordered checklist for an org from its real onboarding state. Pure and
 * shared by the topbar button (counts) and the card (render) so they never disagree —
 * including the Pro-gated "Invite your team" step. Returns [] until state has loaded.
 */
function getSetupSteps(
	orgSlug: string,
	state: GettingStartedState | null,
): Step[] {
	if (!state) return [];
	return [
		{
			key: "cloud",
			title: "Connect a cloud",
			desc: "Link AWS, GCP, or Azure — zero stored keys.",
			href: globalHref(orgSlug, "connectors"),
			done: state.hasCloud,
			icon: <Cloud className="size-4" />,
		},
		{
			key: "project",
			title: "Design your first Project",
			desc: "Compose infrastructure visually, then plan & apply.",
			href: globalHref(orgSlug, "new"),
			done: state.hasProject,
			icon: <FileCode2 className="size-4" />,
		},
		{
			key: "provision",
			title: "Provision your first environment",
			desc: "Run a plan & apply to bring your infrastructure live.",
			href: orgHref(orgSlug),
			done: state.hasProvisioned,
			icon: <Server className="size-4" />,
		},
		...(state.canInvite
			? [
					{
						key: "invite",
						title: "Invite your team",
						desc: "Add teammates with roles and shared access.",
						href: globalHref(orgSlug, "settings/members"),
						done: state.memberCount > 1,
						icon: <Users className="size-4" />,
					},
				]
			: []),
	];
}

/**
 * Topbar entry for the setup guide: a circular progress ring + label. Fetches progress
 * on mount and on org switch, and renders nothing until loaded or once every step is
 * done. Clicking it toggles the bottom-right card.
 */
export function SetupGuideButton() {
	const orgSlug = useActiveOrgSlug();
	const { state, fetch, toggle } = useSetupGuideStore();

	useEffect(() => {
		if (orgSlug) fetch();
	}, [orgSlug, fetch]);

	const steps = getSetupSteps(orgSlug, state);
	const total = steps.length;
	const doneCount = steps.filter((s) => s.done).length;
	if (!state || total === 0 || doneCount === total) return null;

	return (
		<Button
			variant="ghost"
			size="sm"
			onClick={toggle}
			title={`${doneCount} of ${total} done`}
			className="h-9 gap-2 text-muted-foreground hover:text-foreground"
		>
			<ProgressRing done={doneCount} total={total} size={16} />
			<span className="hidden sm:inline">Setup guide</span>
		</Button>
	);
}

/**
 * Bottom-right checklist card — the "open" state of the setup guide. Reads the shared
 * store; renders nothing unless it's open, loaded, and still incomplete. Closing simply
 * parks it back in the topbar (no permanent dismiss).
 */
export function SetupGuideCard() {
	const orgSlug = useActiveOrgSlug();
	const { state, open, setOpen } = useSetupGuideStore();

	const steps = getSetupSteps(orgSlug, state);
	const total = steps.length;
	const doneCount = steps.filter((s) => s.done).length;
	if (!open || total === 0 || doneCount === total) return null;

	return (
		// `--z-sticky-bar` is the top of the in-flow ladder in packages/brand/src/tokens.css, which
		// is exactly where the bare `z-40` sat: above any in-page sticky action bar this card can
		// float over, and below the header, every overlay and the toasts that report on it.
		<div className="fixed right-4 bottom-4 z-[var(--z-sticky-bar)] max-w-[calc(100vw-2rem)]">
			<section className="w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
				<div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
					<div>
						<p className="vx-eyebrow">Get started</p>
						<SectionHeading
							className="mt-1.5"
							title="Set up your organization"
							description={`${doneCount} of ${total} done — pick up where you left off.`}
						/>
					</div>
					<button
						type="button"
						aria-label="Minimize"
						onClick={() => setOpen(false)}
						className="rounded-sm p-1.5 text-text-tertiary transition-colors hover:bg-surface-muted hover:text-text-primary"
					>
						<ChevronDown className="size-4" />
					</button>
				</div>

				<ul className="divide-y divide-border">
					{steps.map((s) => (
						<li key={s.key}>
							<Link
								href={s.href}
								className={cn(
									"group flex items-center gap-3.5 px-5 py-3.5 transition-colors",
									s.done ? "opacity-60" : "hover:bg-surface-muted",
								)}
							>
								<span
									className={cn(
										"flex size-7 shrink-0 items-center justify-center rounded-full border",
										s.done
											? "border-ink bg-ink text-ink-foreground"
											: "border-border-strong text-text-secondary",
									)}
								>
									{s.done ? (
										<Check className="size-3.5" strokeWidth={3} />
									) : (
										s.icon
									)}
								</span>
								<div className="min-w-0 flex-1">
									<div
										className={cn(
											"text-ui-md font-medium text-text-primary",
											s.done && "line-through",
										)}
									>
										{s.title}
									</div>
									<div className="truncate text-ui-sm text-text-tertiary">
										{s.desc}
									</div>
								</div>
								{!s.done && (
									<ArrowRight className="size-4 shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-text-primary" />
								)}
							</Link>
						</li>
					))}
				</ul>

				<div className="flex items-center gap-4 border-t border-border px-5 py-3">
					<Link
						href="/docs"
						className="inline-flex items-center gap-1.5 font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
					>
						<Terminal className="size-3.5" />
						Install the alethia CLI
					</Link>
					<Link
						href="/docs"
						className="font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
					>
						Read the docs →
					</Link>
				</div>
			</section>
		</div>
	);
}

/** Circular progress ring — filled arc = done/total, with the done count centered. */
function ProgressRing({
	done,
	total,
	size = 26,
}: {
	done: number;
	total: number;
	size?: number;
}) {
	const stroke = size <= 18 ? 2 : 2.5;
	const r = (size - stroke) / 2;
	const circumference = 2 * Math.PI * r;
	const fraction = total > 0 ? done / total : 0;

	return (
		<span className="relative inline-flex shrink-0 items-center justify-center">
			<svg width={size} height={size} className="-rotate-90">
				<title>
					{done} of {total} steps done
				</title>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					strokeWidth={stroke}
					className="stroke-border-strong"
				/>
				<circle
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					strokeWidth={stroke}
					strokeLinecap="round"
					strokeDasharray={circumference}
					strokeDashoffset={circumference * (1 - fraction)}
					className="stroke-ink transition-[stroke-dashoffset]"
				/>
			</svg>
			<span
				className="absolute font-mono font-semibold text-text-primary"
				style={{ fontSize: size <= 18 ? 8 : 9 }}
			>
				{done}
			</span>
		</span>
	);
}
