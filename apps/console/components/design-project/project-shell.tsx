"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project workspace shell: a full-bleed flex row with the routed view on the left and the
// docked panel on the right. Because the dock lives in this LAYOUT (not the routed page), the AI
// assistant stays open as you switch views (Architecture / Environments / Jobs / …). The service
// inspector is canvas-only and is cleared when you leave Architecture.

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { destroyProject } from "@/app/server/actions/projects";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import {
	CanvasDock,
	useDockState,
} from "@/components/design-project/canvas/canvas-dock";
import { CONTENT_FRAME } from "@/components/shell/content-frame";
import { EMPTY_ENVIRONMENT_STATUS } from "@/lib/canvas/component-status";
import { EnvironmentStatusProvider } from "@/lib/canvas/environment-status-context";
import { useEnvironmentStatusQuery } from "@/lib/query/use-environment-status-query";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { cn } from "@repo/ui/utils";

export function ProjectShell({
	projectId,
	identities,
	children,
}: {
	projectId: string;
	identities: CloudIdentityOption[];
	children: React.ReactNode;
}) {
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const openInspector = useCanvasStore((s) => s.openInspector);
	const inspectorNodeId = useCanvasStore((s) => s.inspectorNodeId);

	// Architecture is the only env-scoped design surface; the inspector belongs to it alone.
	const onArchitecture = pathname.endsWith("/architecture");
	const dock = useDockState(onArchitecture);

	// The environment's server truth (component lifecycles, the in-flight job, drift, cluster
	// liveness) — fetched ONCE here, because the shell is the only place that wraps BOTH the board
	// and the docked inspector. Forty cards each running their own query would be forty round-trips
	// and forty poll timers; instead every node picks its row out of this by `nodeStatusKey()`.
	// An absent `environment_id` resolves to the project's default env server-side, exactly as the
	// Architecture page does.
	const envStatus = useEnvironmentStatusQuery(
		projectId,
		searchParams.get("environment_id"),
	);

	// Leaving Architecture closes the canvas-only inspector (the assistant stays open).
	useEffect(() => {
		if (!onArchitecture && inspectorNodeId) openInspector(null);
	}, [onArchitecture, inspectorNodeId, openInspector]);

	/** Tear down the active environment (queued from the Project settings inspector). */
	const handleDestroy = async () => {
		try {
			const envId = searchParams.get("environment_id") ?? undefined;
			const activeEnvId = await resolveActiveEnvironmentId(projectId, envId);
			await destroyProject(projectId, activeEnvId);
			toast.success("Destroy queued");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to destroy");
		}
	};

	return (
		<EnvironmentStatusProvider value={envStatus.data ?? EMPTY_ENVIRONMENT_STATUS}>
			<div className="-m-4 flex h-[calc(100dvh-3.5rem)] sm:-m-6 lg:-m-8 xl:-m-10">
				<div
					className={cn(
						"relative min-w-0 flex-1",
						dock && "border-r border-border",
					)}
				>
					{/* Architecture fills the board full-bleed — a pan/zoom canvas has no document
					    width, and centring it inside CONTENT_FRAME would leave gutters the board is
					    meant to use. Every other project view is a document and gets the console's
					    one content frame, the same 1200px SettingsShell and SupportShell own. */}
					{onArchitecture ? (
						<div className="h-full">{children}</div>
					) : (
						<div className="h-full overflow-y-auto p-4 sm:p-6 lg:p-8 xl:p-10">
							<div className={CONTENT_FRAME}>{children}</div>
						</div>
					)}
				</div>

				<CanvasDock
					dock={dock}
					projectId={projectId}
					onDestroyEnvironment={handleDestroy}
				/>
			</div>
		</EnvironmentStatusProvider>
	);
}
