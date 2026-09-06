"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolUIPart } from "ai";
import { PanelRight, Telescope } from "lucide-react";
import Link from "next/link";
import { z } from "zod";
import type { RenderToolPart } from "@/components/agent/agent-chat";
import {
	TOOL_VIEW_TYPES,
	ToolView,
} from "@/components/agent/agent-tool-views";
import { ApprovalCard } from "@/components/agent/approval-card";
import { DashboardPinnedCard } from "@/components/agent/render-tool-parts/dashboard-pinned";
import { ToolResultFrame } from "@/components/agent/tool-result-frame";
import type { AddToolResult } from "@/components/agent/use-agent-chat";
import { proposeOperationInputSchema } from "@/lib/ai/operation";
import type { Artifact, ArtifactTab } from "@/lib/stores/use-artifact-store";
import { Button } from "@repo/ui/button";

const projectIdSchema = z.object({ projectId: z.string() });
const jobIdSchema = z.object({ jobId: z.string() });
const scanResultSchema = z.object({ openInCanvasUrl: z.string().optional() });

interface OrgToolPartsDeps {
	/** Open the inspector panel (config/plan/cost/logs) for a project/job. */
	openArtifact: (artifact: Artifact, tab: ArtifactTab) => void;
	/** Reveal the split pane's widget grid (maximizing a docked panel first). */
	openGrid: () => void;
	/** Feed a HITL tool's outcome back to the model so it continues after approval. */
	addToolResult: AddToolResult;
}

/**
 * The org-agent tool-render lanes: `propose_operation` → approval card, repo scan →
 * "Open in canvas", project/job/plan results → "Open in panel" (artifact panel), and
 * framed tables/one-liners for list_* + catalog tools. Every lane renders inside the
 * shared `ToolResultFrame` so multi-tool turns read as a uniform captioned stack.
 * Extracted from the agent page so the shared Elench surface can select it by context.
 */
export function orgRenderToolPart({
	openArtifact,
	openGrid,
	addToolResult,
}: OrgToolPartsDeps): RenderToolPart {
	return function renderOrgToolPart(part: ToolUIPart) {
		// HITL proposal (no execute): the frame's live marker while its input streams,
		// then the approval card — which feeds the outcome back via addToolResult.
		if (part.type === "tool-propose_operation") {
			if (part.state === "input-streaming")
				return <ToolResultFrame part={part} title="Proposal" />;
			const parsed = proposeOperationInputSchema.safeParse(part.input);
			if (!parsed.success) return null;
			return (
				<ToolResultFrame part={part} title="Proposal">
					<ApprovalCard
						proposal={{ id: part.toolCallId, ...parsed.data }}
						onResolve={(output) =>
							addToolResult({
								tool: "propose_operation",
								toolCallId: part.toolCallId,
								output,
							})
						}
					/>
				</ToolResultFrame>
			);
		}

		// Generative dashboard ready → its blocks auto-pin to the grid; the transcript
		// shows the framed receipt with an "Open grid" action.
		if (
			part.type === "tool-build_dashboard" &&
			part.state === "output-available"
		) {
			return <DashboardPinnedCard part={part} openGrid={openGrid} />;
		}

		// Repo scan ready → an "Open in canvas" action to review the proposed project.
		if (
			part.type === "tool-get_scan_result" &&
			part.state === "output-available"
		) {
			const parsed = scanResultSchema.safeParse(part.output);
			if (parsed.success && parsed.data.openInCanvasUrl) {
				return (
					<ToolResultFrame
						part={part}
						actions={
							<Button
								variant="outline"
								size="sm"
								className="h-6 gap-1.5 rounded-none px-2 text-ui-xs"
								nativeButton={false}
								render={<Link href={parsed.data.openInCanvasUrl} />}
							>
								<Telescope className="h-3 w-3" />
								Open in canvas
							</Button>
						}
					/>
				);
			}
		}

		let onOpen: (() => void) | undefined;
		if (part.type === "tool-get_project") {
			const p = projectIdSchema.safeParse(part.input);
			if (p.success) {
				const id = p.data.projectId;
				onOpen = () => openArtifact({ projectId: id }, "config");
			}
		} else if (
			part.type === "tool-get_job" ||
			part.type === "tool-get_plan_result"
		) {
			const p = jobIdSchema.safeParse(part.input);
			if (p.success) {
				const id = p.data.jobId;
				const tab = part.type === "tool-get_plan_result" ? "plan" : "logs";
				onOpen = () => openArtifact({ jobId: id }, tab);
			}
		}
		if (onOpen) {
			return (
				<ToolResultFrame
					part={part}
					actions={
						<Button
							variant="outline"
							size="sm"
							className="h-6 gap-1.5 rounded-none px-2 text-ui-xs"
							onClick={onOpen}
						>
							<PanelRight className="h-3 w-3" />
							Open in panel
						</Button>
					}
				/>
			);
		}

		// Framed tables/one-liners for list_* + catalog/CIDR tools; else the generic frame.
		if (TOOL_VIEW_TYPES.has(part.type)) return <ToolView part={part} />;
		return undefined;
	};
}
