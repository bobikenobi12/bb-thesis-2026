"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The artifact panel's Build tab (#592, W2): per repo-sourced service, its image-build phase +
// resolved digest. Phase is DERIVED (deriveBuildStates) from the BUILD job's status × build_result —
// there is no per-service status column — so the surface can't claim more than the read model knows.
// Build LOGS aren't duplicated here: they stream in the Logs tab (a BUILD is just a job).

import { PANEL_EMPTY } from "@/components/agent/panel-empty";
import { CopyButton } from "@repo/ui/copy-button";
import { EmptyState } from "@repo/ui/empty";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import {
	type BuildJobState,
	type BuildPhase,
	type BuildServiceInput,
	deriveBuildStates,
	prebuiltImageCount,
} from "@/lib/agent/build-status";

/** Grayscale tier + label per build phase (status via dot fill/shape, never hue). */
const PHASE_META: Record<BuildPhase, { tier: StatusTier; label: string }> = {
	queued: { tier: "idle", label: "Queued" },
	building: { tier: "pending", label: "Building" },
	pushed: { tier: "active", label: "Pushed" },
	failed: { tier: "failed", label: "Failed" },
	"not-built": { tier: "disabled", label: "Not built" },
};

/** A short, legible form of an ECR digest URI: the repo path + the first 12 of the sha. */
function shortDigest(image: string): string {
	const [repo, digest] = image.split("@");
	const repoTail = repo?.split("/").slice(-1)[0] ?? repo ?? image;
	if (!digest) return repoTail;
	const sha = digest.replace(/^sha256:/, "").slice(0, 12);
	return `${repoTail}@${sha}`;
}

/** One service's build row: name, phase badge, and (once pushed) its resolved digest. */
function BuildRow({
	name,
	phase,
	image,
}: {
	name: string;
	phase: BuildPhase;
	image: string | null;
}) {
	const meta = PHASE_META[phase];
	return (
		<div className="flex items-start justify-between gap-3 border-b border-border py-2 last:border-0">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="truncate font-mono text-xs text-foreground">{name}</span>
				{image && phase === "pushed" && (
					<span className="flex items-center gap-1.5 text-ui-xs text-muted-foreground">
						<span className="truncate font-mono">{shortDigest(image)}</span>
						<CopyButton text={image} className="flex-none" />
					</span>
				)}
			</div>
			<StatusBadge status={meta.label} tier={meta.tier} />
		</div>
	);
}

/**
 * The Build tab. `services` is the project's service list; `build` is the open BUILD job's live state
 * (null → the persisted `resolved_image` is the whole truth). Renders one row per repo-sourced service;
 * image-sourced services are noted, not built.
 */
export function BuildPane({
	services,
	build,
}: {
	services: BuildServiceInput[];
	build: BuildJobState | null;
}) {
	const states = deriveBuildStates(services, build);
	const prebuilt = prebuiltImageCount(services);

	if (states.length === 0) {
		return (
			<EmptyState
				className={PANEL_EMPTY}
				title={
					prebuilt > 0
						? "Every service here deploys a prebuilt image — nothing to build."
						: "No repo-sourced services. Add a service built from a Git repo to see its image build here."
				}
			/>
		);
	}

	const pushed = states.filter((s) => s.phase === "pushed").length;
	const building = states.filter(
		(s) => s.phase === "building" || s.phase === "queued",
	).length;
	const failed = states.filter((s) => s.phase === "failed").length;
	const rollup = [
		`${states.length} service${states.length === 1 ? "" : "s"}`,
		...(building ? [`${building} in progress`] : []),
		...(pushed ? [`${pushed} pushed`] : []),
		...(failed ? [`${failed} failed`] : []),
	].join(" · ");

	return (
		<div className="space-y-4">
			<div className="font-mono text-ui-xs tracking-wide text-muted-foreground">
				{rollup}
			</div>

			<div>
				<div className="vx-eyebrow pb-1 text-ui-3xs">Workloads</div>
				<div className="border border-border px-3">
					{states.map((s) => (
						<BuildRow key={s.name} name={s.name} phase={s.phase} image={s.image} />
					))}
				</div>
				<p className="mx-0.5 mt-1.5 text-ui-xs leading-snug text-muted-foreground">
					Repo-sourced services build in an in-cluster job after the cluster is up, pushing a
					signed image to the registry — no keys held. Build logs stream in the Logs tab.
					{prebuilt > 0 &&
						` ${prebuilt} prebuilt-image service${prebuilt === 1 ? "" : "s"} not shown.`}
				</p>
			</div>
		</div>
	);
}
