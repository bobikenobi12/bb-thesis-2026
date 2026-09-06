"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolUIPart } from "ai";
import { Check, Telescope } from "lucide-react";
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
import { VerifyBlock } from "@/components/agent/artifact-panel";
import { applyProposal } from "@/components/design-project/canvas/ai/apply-proposal";
import { ProposalDiff } from "@/components/design-project/canvas/ai/proposal-diff";
import { proposeOperationInputSchema } from "@/lib/ai/operation";
import { proposeChangesInputSchema } from "@/lib/ai/proposal";
import type { Artifact, ArtifactTab } from "@/lib/stores/use-artifact-store";
import { Button } from "@repo/ui/button";

const scanResultSchema = z.object({ openInCanvasUrl: z.string().optional() });

const verifyStatus = z.enum(["pass", "fail", "warn", "not_evaluable"]);
/** Mirrors the VerifyReport JSON shape (jsonb.types) so a tool output parses without `as`. */
const verifyReportSchema = z.object({
	verdict: verifyStatus,
	catalog_version: z.string(),
	provider: z.string(),
	controls: z.array(
		z.object({
			id: z.string(),
			title: z.string(),
			severity: z.enum(["high", "medium", "low"]),
			status: verifyStatus,
			frameworks: z.array(z.string()).optional(),
			provider: z.string(),
			findings: z
				.array(z.object({ address: z.string(), message: z.string() }))
				.optional(),
			coverage: z.string().optional(),
		}),
	),
	summary: z.object({
		pass: z.number(),
		fail: z.number(),
		warn: z.number(),
		not_evaluable: z.number(),
	}),
});
const planResultSchema = z.object({
	verify_result: verifyReportSchema.nullish(),
});

interface ProjectToolPartsDeps {
	/** Accepted-proposal map (id → true) so re-renders keep the "Added" state. */
	accepted: Record<string, boolean>;
	setAccepted: (updater: (a: Record<string, boolean>) => Record<string, boolean>) => void;
	/** Feed a HITL tool's outcome back to the model so it continues after approval. */
	addToolResult: AddToolResult;
	/** Open the inspector panel (config/plan/cost/logs) for a project/job. */
	openArtifact: (artifact: Artifact, tab: ArtifactTab) => void;
	/** Reveal the split pane's widget grid (maximizing a docked panel first). */
	openGrid: () => void;
}

/**
 * The project-assistant tool-render lanes: design proposal → Accept (applies to the
 * canvas), plan/deploy proposal → approval card, plan result → inline elench verdict
 * (VerifyBlock), repo scan → review link, and polished tables/chips for list_* tools.
 * Extracted from the docked assistant so the shared Elench surface selects it by context.
 */
export function projectRenderToolPart({
	accepted,
	setAccepted,
	addToolResult,
	openArtifact,
	openGrid,
}: ProjectToolPartsDeps): RenderToolPart {
	return function renderProjectToolPart(part: ToolUIPart) {
		// Generative dashboard ready → its blocks auto-pin to the grid; the transcript
		// shows the framed receipt with an "Open grid" action.
		if (
			part.type === "tool-build_dashboard" &&
			part.state === "output-available"
		) {
			return <DashboardPinnedCard part={part} openGrid={openGrid} />;
		}

		// Design proposal → accept lane (HITL: applies to the canvas, then feeds the
		// accepted outcome back so the model continues).
		if (part.type === "tool-propose_changes") {
			if (part.state === "input-streaming")
				return <ToolResultFrame part={part} title="Changes" />;
			const parsed = proposeChangesInputSchema.safeParse(part.input);
			if (!parsed.success) return null;
			const proposal = { id: part.toolCallId, ...parsed.data };
			const isAccepted = accepted[proposal.id];
			return (
				<ToolResultFrame part={part} title="Changes">
					<div className="w-full border border-border">
						<div className="flex items-center justify-between px-2.5 py-1.5">
							<span className="font-mono text-xs">{proposal.label}</span>
							{isAccepted ? (
								<span className="vx-status vx-status--active">
									<span className="vx-status__dot" />
									Applied
								</span>
							) : (
								<Button
									type="button"
									size="sm"
									className="h-6 px-2 text-ui-xs"
									onClick={() => {
										applyProposal(proposal);
										setAccepted((a) => ({ ...a, [proposal.id]: true }));
										addToolResult({
											tool: "propose_changes",
											toolCallId: part.toolCallId,
											output: { status: "accepted", label: proposal.label },
										});
									}}
								>
									<Check className="mr-1 h-3 w-3" />
									Accept
								</Button>
							)}
						</div>

						{/* WHAT ACCEPT WILL ACTUALLY DO. The card used to show only the model's own
						    one-line label while Accept applied a list of actions the user never saw —
						    you were asked to approve a summary and the payload got applied. */}
						<ProposalDiff actions={proposal.actions} />
					</div>
				</ToolResultFrame>
			);
		}

		// Plan/deploy proposal → approval card (HITL: runs plan/deploy on the user's click,
		// then feeds the outcome back so the model continues).
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

		// Plan result → render the elench verification verdict inline (the proof beat),
		// so the user sees pass/fail per control before approving a deploy.
		if (
			part.type === "tool-get_plan_result" &&
			part.state === "output-available"
		) {
			const parsed = planResultSchema.safeParse(part.output);
			if (parsed.success && parsed.data.verify_result) {
				return (
					<ToolResultFrame part={part}>
						<VerifyBlock report={parsed.data.verify_result} />
					</ToolResultFrame>
				);
			}
		}

		// Repo scan ready → a link to review the proposed project in the design surface.
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
								Review proposed project
							</Button>
						}
					/>
				);
			}
		}

		// Polished tables/chips for list_* + catalog tools; else the default card.
		if (TOOL_VIEW_TYPES.has(part.type)) return <ToolView part={part} />;
		return undefined;
	};
}
