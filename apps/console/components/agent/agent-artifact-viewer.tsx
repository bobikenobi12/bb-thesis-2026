"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronLeft, Loader2, MessageSquarePlus, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { ArtifactSharePopover } from "@/components/agent/artifact-share-popover";
import { GALLERY_EMPTY } from "@/components/agent/gallery-empty";
import type { AgentArtifact } from "@/lib/db/schema";
import { WidgetBody } from "@/components/agent/widgets/widget-card";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { ScrollArea } from "@repo/ui/scroll-area";

/** Fixed row height (px) — matches the live grid so a saved artifact previews at true scale. */
const ROW_H = 88;

/**
 * Read-only view of a saved artifact.
 *
 * Clicking an artifact used to `startThread(name)` — it silently created a chat named after the
 * artifact, or dumped its widgets onto whatever conversation you happened to be in. Opening a
 * thing should never mutate a conversation. So: this previews the artifact's widgets exactly as
 * saved, and every side-effect is an explicit, named button.
 */
export function AgentArtifactViewer({
	artifact,
	hasActiveChat,
	owned = true,
	onBack,
	onAddToChat,
	onOpenInNewChat,
	onDelete,
}: {
	artifact: AgentArtifact;
	/** Whether a conversation is open to add this to (otherwise that action is disabled). */
	hasActiveChat: boolean;
	/** False for an artifact shared to you by a teammate — view-only (no add/delete/share). */
	owned?: boolean;
	onBack: () => void;
	onAddToChat: () => Promise<void>;
	onOpenInNewChat: () => Promise<void>;
	onDelete: () => Promise<void>;
}) {
	const [busy, setBusy] = useState<null | "add" | "new" | "delete">(null);

	/** Run one explicit action, keeping the button in a busy state until it settles. */
	const run = async (kind: "add" | "new" | "delete", fn: () => Promise<void>) => {
		setBusy(kind);
		try {
			await fn();
		} finally {
			setBusy(null);
		}
	};

	const widgets = artifact.spec.widgets;
	const rows = widgets.reduce(
		(m, w) => Math.max(m, w.position.y + w.size.rowspan),
		0,
	);

	return (
		<div data-testid="artifact-viewer" className="flex h-full min-h-0 flex-col">
			<div className="flex flex-none items-center gap-2 border-b border-border px-3 py-2.5">
				<button
					type="button"
					onClick={onBack}
					className="flex items-center gap-1 rounded-none px-1.5 py-1 text-ui-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				>
					<ChevronLeft className="h-4 w-4" />
					Artifacts
				</button>
				<div className="mx-1 h-4 w-px bg-border" />
				<div
					title={artifact.name}
					className="min-w-0 truncate text-sm font-medium text-foreground"
				>
					{artifact.name}
				</div>
				<span className="flex-none font-mono text-ui-2xs uppercase text-muted-foreground">
					{artifact.kind} · {widgets.length}{" "}
					{widgets.length === 1 ? "widget" : "widgets"}
				</span>

				<div className="ml-auto flex items-center gap-1.5">
					{owned ? (
						<>
							<Button
								size="sm"
								variant="outline"
								className="gap-1.5 rounded-none"
								disabled={!hasActiveChat || busy !== null}
								title={
									hasActiveChat
										? "Add these widgets to the open conversation's grid"
										: "Open a conversation first"
								}
								onClick={() => void run("add", onAddToChat)}
							>
								{busy === "add" ? (
									<Loader2 className="h-3.5 w-3.5 animate-spin" />
								) : (
									<Plus className="h-3.5 w-3.5" />
								)}
								Add to this chat
							</Button>
							<Button
								size="sm"
								variant="outline"
								className="gap-1.5 rounded-none"
								disabled={busy !== null}
								onClick={() => void run("new", onOpenInNewChat)}
							>
								{busy === "new" ? (
									<Loader2 className="h-3.5 w-3.5 animate-spin" />
								) : (
									<MessageSquarePlus className="h-3.5 w-3.5" />
								)}
								Open in new chat
							</Button>
							<ArtifactSharePopover artifactId={artifact.id} />
							<button
								type="button"
								aria-label={`Delete ${artifact.name}`}
								disabled={busy !== null}
								onClick={() => void run("delete", onDelete)}
								className="flex size-8 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
							>
								<Trash2 className="h-4 w-4" />
							</button>
						</>
					) : (
						<span className="font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground">
							Shared with you
						</span>
					)}
				</div>
			</div>

			<ScrollArea className="min-h-0 flex-1">
				<div className="p-5">
					{widgets.length === 0 ? (
						<EmptyState
							className={GALLERY_EMPTY}
							title="This artifact has no widgets."
						/>
					) : (
						<div
							className="grid grid-cols-5 gap-2"
							style={{
								gridAutoRows: `${ROW_H}px`,
								minHeight: rows * ROW_H,
							}}
						>
							{widgets.map((w, i) => (
								<div
									key={`${w.title}-${w.position.x}-${w.position.y}-${i}`}
									style={{
										gridColumn: `${w.position.x + 1} / span ${w.size.colspan}`,
										gridRow: `${w.position.y + 1} / span ${w.size.rowspan}`,
									}}
									className="flex min-h-0 flex-col overflow-hidden border border-border bg-background"
								>
									<div className="flex h-7 flex-none items-center border-b border-border px-2">
										<span
											title={w.title}
											className="min-w-0 flex-1 truncate font-mono text-ui-2xs uppercase tracking-wide text-muted-foreground"
										>
											{w.title}
										</span>
									</div>
									<div className="min-h-0 flex-1 overflow-auto">
										<WidgetBody widget={w} />
									</div>
								</div>
							))}
						</div>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
