// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared visuals for the add-on marketplace: the lucide icon resolver (catalog data stays
// JSX-free, like the alerts catalog) and the ArgoCD health / install-status badges. Grayscale
// first — meaning is carried by icon + label; `destructive` is reserved for a failing state.

import {
	Archive,
	Boxes,
	CircleDashed,
	CircleCheck,
	CircleX,
	Database,
	Gauge,
	KeyRound,
	LineChart,
	Loader,
	Lock,
	Network,
	ScrollText,
	ShieldCheck,
	TriangleAlert,
	type LucideIcon,
} from "lucide-react";
import { Badge } from "@repo/ui/badge";
import type { AddOnIcon } from "@/lib/addons/types";
import type { ComponentStatus } from "@/lib/db/schema";
import { addonCompat } from "@/lib/compat";

const ICONS: Record<AddOnIcon, LucideIcon> = {
	LineChart,
	ScrollText,
	ShieldCheck,
	KeyRound,
	Network,
	Boxes,
	Gauge,
	Archive,
	Database,
	Lock,
};

/** Renders an add-on's catalog icon. */
export function AddonIcon({
	icon,
	className,
}: {
	icon: AddOnIcon;
	className?: string;
}) {
	const Icon = ICONS[icon] ?? Boxes;
	return <Icon className={className} />;
}

/**
 * The install/health badge for an add-on. Prefers the live ArgoCD health once it's read back;
 * before the first deploy it shows the component status (PENDING → "Pending deploy").
 */
export function AddonStatusBadge({
	status,
	health,
}: {
	status: ComponentStatus;
	health: string | null;
}) {
	// Live ArgoCD health (after a deploy read it back).
	if (health && health !== "Unknown") {
		if (health === "Healthy") {
			return (
				<Badge variant="secondary" className="gap-1.5">
					<CircleCheck className="h-3.5 w-3.5" />
					Healthy
				</Badge>
			);
		}
		if (health === "Degraded" || health === "Missing") {
			return (
				<Badge variant="destructive" className="gap-1.5">
					<CircleX className="h-3.5 w-3.5" />
					{health}
				</Badge>
			);
		}
		return (
			<Badge variant="outline" className="gap-1.5">
				<Loader className="h-3.5 w-3.5" />
				{health}
			</Badge>
		);
	}

	// Pre-deploy: the persisted component status.
	if (status === "PENDING") {
		return (
			<Badge variant="outline" className="gap-1.5 text-muted-foreground">
				<CircleDashed className="h-3.5 w-3.5" />
				Pending deploy
			</Badge>
		);
	}
	if (status === "FAILED") {
		return (
			<Badge variant="destructive" className="gap-1.5">
				<CircleX className="h-3.5 w-3.5" />
				Failed
			</Badge>
		);
	}
	return (
		<Badge variant="outline" className="gap-1.5">
			<Loader className="h-3.5 w-3.5" />
			{status}
		</Badge>
	);
}

/**
 * An add-on's Kubernetes-compatibility badge, for the marketplace palette (#1222).
 *
 * Renders NOTHING when the add-on is compatible — the same calm-canvas rule `gitopsBadge` follows
 * for Healthy+Synced. Ink is for the two states that want attention:
 *
 *   fail          — the recorded window excludes this cluster's Kubernetes minor.
 *   not_evaluable — no window is recorded (the majority of the catalogue today), or the cluster's
 *                   version is unset. Deliberately NOT styled like a pass: a compatibility we
 *                   could not check must never read as one we verified. The dashed hairline is the
 *                   design system's existing "admitted unknown" idiom (see CostChip's "Not priced").
 *
 * Advisory only — nothing here disables an add-on. The blocking gate is COMPAT-001 at apply time.
 */
export function AddonCompatBadge({
	addonId,
	k8sVersion,
}: {
	addonId: string;
	k8sVersion: string | undefined;
}) {
	const compat = addonCompat(addonId, k8sVersion);
	if (compat.status === "pass") return null;

	if (compat.status === "fail") {
		return (
			<Badge variant="destructive" className="shrink-0 gap-1" title={compat.note}>
				<TriangleAlert className="h-3 w-3" />
				K8s {compat.window}
			</Badge>
		);
	}
	return (
		<span
			className="shrink-0 border border-dashed border-border px-1.5 py-0.5 font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground"
			title={compat.note}
		>
			Unverified
		</span>
	);
}
