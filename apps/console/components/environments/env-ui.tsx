"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared presentation for the Environments surface — the grayscale status dot, an initials
// avatar, and the mappings that turn a promotion's real data (status, gate results, protection
// rules) into pipeline / gate / chip views.

import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import {
	Clock,
	DollarSign,
	Layers,
	ShieldCheck,
	UserCheck,
	type LucideIcon,
} from "lucide-react";
import type { GateResult } from "@/types/jsonb.types";

/**
 * The status tiers, re-exported from the one place that defines them.
 *
 * This file used to declare its own copy of the union AND rebuild the `.vx-status` markup by
 * hand — a second source of truth for what a status looks like, invisible to
 * `check:shared-surface` because nothing about a hand-written class string says "status". A
 * tier added to `@repo/ui/status-badge` would have reached every console surface except this one.
 */
export type { StatusTier };

/**
 * A status dot (+ optional label) for a caller that already knows the TIER.
 *
 * A thin adapter over {@link StatusBadge}, not a second renderer: the tiers, the markup and the
 * dot come from `@repo/ui/status-badge`. It exists because the promotion surfaces resolve a tier
 * themselves (`promoStatus`, `pipelineSteps`, `gateView` below) from vocabulary `statusTier()`'s
 * lookup does not know, so there is no product status string to hand the badge. The last consumer
 * outside `components/environments/` is `components/create-project/environment-placement.tsx`
 * (#3624's lane); once that moves to `StatusBadge` this can go with it.
 *
 * The `size` prop is gone. It rendered the same device at 8px, 9px and 12px on three surfaces of
 * one product, which is exactly the disagreement §6 is about — every dot is now the shared 7px.
 */
export function StatusDot({
	tier,
	label,
	className,
}: {
	tier: StatusTier;
	label?: string;
	className?: string;
}) {
	return (
		<StatusBadge
			status={label ?? tier}
			tier={tier}
			label={label}
			showLabel={label !== undefined}
			className={className}
		/>
	);
}

/** A grayscale initials avatar. */
export function Avatar({
	initials,
	size = 26,
}: {
	initials: string;
	size?: number;
}) {
	return (
		<span
			className="grid shrink-0 place-items-center rounded-full border border-border-strong bg-surface-muted font-mono text-text-secondary"
			style={{ width: size, height: size, fontSize: size * 0.38 }}
		>
			{initials}
		</span>
	);
}

// ── Promotion status ─────────────────────────────────────────────────────────

export const PROMO_STATUS: Record<string, { label: string; tier: StatusTier }> = {
	PENDING_PLAN: { label: "Planning", tier: "pending" },
	PENDING_APPROVAL: { label: "Pending approval", tier: "pending" },
	APPROVED: { label: "Approved", tier: "active" },
	DEPLOYING: { label: "Deploying", tier: "live" },
	SUCCEEDED: { label: "Succeeded", tier: "active" },
	FAILED: { label: "Failed", tier: "failed" },
	BLOCKED: { label: "Blocked", tier: "failed" },
	CANCELLED: { label: "Cancelled", tier: "disabled" },
};

export function promoStatus(status: string): { label: string; tier: StatusTier } {
	return PROMO_STATUS[status] ?? { label: status, tier: "pending" };
}

// ── Pipeline (Plan → Approval → Deploy → Live) ───────────────────────────────

const STEP_TIER: Record<string, StatusTier> = {
	done: "active",
	current: "pending",
	todo: "idle",
	failed: "failed",
	cancelled: "disabled",
};
const STEP_MAP: Record<string, string[]> = {
	PENDING_PLAN: ["current", "todo", "todo", "todo"],
	PENDING_APPROVAL: ["done", "current", "todo", "todo"],
	APPROVED: ["done", "done", "current", "todo"],
	DEPLOYING: ["done", "done", "current", "todo"],
	SUCCEEDED: ["done", "done", "done", "done"],
	FAILED: ["done", "done", "failed", "todo"],
	BLOCKED: ["done", "failed", "todo", "todo"],
	CANCELLED: ["done", "cancelled", "todo", "todo"],
};
const STEP_LABELS = ["Plan", "Approval", "Deploy", "Live"];

export interface PipelineStep {
	label: string;
	tier: StatusTier;
}

/** The four-stage pipeline for a promotion status. */
export function pipelineSteps(status: string): PipelineStep[] {
	const arr = STEP_MAP[status] ?? STEP_MAP.PENDING_APPROVAL;
	return arr.map((st, i) => ({ label: STEP_LABELS[i], tier: STEP_TIER[st] }));
}

// ── Gates ────────────────────────────────────────────────────────────────────

const GATE_META: Record<GateResult["type"], { label: string; icon: LucideIcon }> = {
	predecessor_healthy: { label: "Predecessor healthy", icon: Layers },
	verify_pass: { label: "Verify pass", icon: ShieldCheck },
	soak_timer: { label: "Soak timer", icon: Clock },
	cost_delta: { label: "Cost delta", icon: DollarSign },
	manual_approval: { label: "Manual approval", icon: UserCheck },
};
const GATE_STATUS: Record<GateResult["status"], { tier: StatusTier; word: string }> = {
	pass: { tier: "active", word: "Pass" },
	fail: { tier: "failed", word: "Fail" },
	pending: { tier: "pending", word: "Pending" },
	skipped: { tier: "disabled", word: "Skipped" },
};

export interface GateView {
	type: string;
	label: string;
	icon: LucideIcon;
	tier: StatusTier;
	word: string;
	detail: string;
}

/** Maps a stored gate result to its display view. */
export function gateView(g: GateResult): GateView {
	const meta = GATE_META[g.type] ?? { label: g.type, icon: ShieldCheck };
	const st: { tier: StatusTier; word: string } =
		GATE_STATUS[g.status] ?? { tier: "pending", word: g.status };
	return { type: g.type, label: meta.label, icon: meta.icon, tier: st.tier, word: st.word, detail: g.detail };
}
