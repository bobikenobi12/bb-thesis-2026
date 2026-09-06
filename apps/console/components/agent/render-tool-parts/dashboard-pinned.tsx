"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolUIPart } from "ai";
import { LayoutDashboard } from "lucide-react";
import { ToolResultFrame } from "@/components/agent/tool-result-frame";
import { dashboardSpecSchema } from "@/lib/ai/tools/visualize";
import { Button } from "@repo/ui/button";

/**
 * The `build_dashboard` tool-result lane, shared by the org + project surfaces: the
 * spec's blocks auto-pin to the thread's widget grid (useWidgetAutoPin), so the
 * transcript shows a framed receipt — how many widgets landed — with an "Open grid"
 * action that reveals the split pane.
 */
export function DashboardPinnedCard({
	part,
	openGrid,
}: {
	part: ToolUIPart;
	openGrid: () => void;
}) {
	const parsed = dashboardSpecSchema.safeParse(part.output);
	if (!parsed.success) return <ToolResultFrame part={part} />;
	const n = parsed.data.blocks.length;
	return (
		<ToolResultFrame
			part={part}
			title={parsed.data.title}
			detail={`${n} ${n === 1 ? "widget" : "widgets"} pinned to grid`}
			actions={
				<Button
					variant="outline"
					size="sm"
					className="h-6 gap-1.5 rounded-none px-2 text-ui-xs"
					onClick={openGrid}
				>
					<LayoutDashboard className="h-3 w-3" />
					Open grid
				</Button>
			}
		/>
	);
}
