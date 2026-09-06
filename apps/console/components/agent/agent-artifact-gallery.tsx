"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LayoutDashboard, Plus, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { listSharedArtifacts } from "@/app/server/actions/artifact-shares";
import { deleteArtifact, listArtifacts } from "@/app/server/actions/artifacts";
import { AgentArtifactViewer } from "@/components/agent/agent-artifact-viewer";
import { GALLERY_EMPTY } from "@/components/agent/gallery-empty";
import type { AgentArtifact } from "@/lib/db/schema";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { cn } from "@repo/ui/utils";
import { ScrollArea } from "@repo/ui/scroll-area";

type GalleryTab = "yours" | "shared";

/**
 * The Artifacts library — the modal's main region when the rail's "Artifacts" nav is active.
 *
 * Clicking a card OPENS THE ARTIFACT in a read-only viewer. It used to call `startThread(name)`,
 * which silently created a chat named after the artifact (or dumped it onto your last one) —
 * looking at a thing should never mutate a conversation. Every side-effect now lives behind a
 * named button in the viewer.
 */
export function AgentArtifactGallery({
	hasActiveChat,
	onAddToChat,
	onOpenInNewChat,
	onNewArtifact,
	onClose,
}: {
	/** Whether a conversation is open (gates the viewer's "Add to this chat"). */
	hasActiveChat: boolean;
	/** Materialize the artifact onto the OPEN conversation's grid. Explicit only. */
	onAddToChat: (id: string) => Promise<void>;
	/** Start a new conversation and materialize the artifact onto it. Explicit only. */
	onOpenInNewChat: (id: string, name: string) => Promise<void>;
	onNewArtifact: () => void;
	onClose: () => void;
}) {
	const [items, setItems] = useState<AgentArtifact[] | null>(null);
	const [selected, setSelected] = useState<AgentArtifact | null>(null);
	// "yours" = artifacts you created; "shared" = ones teammates shared into your org.
	const [tab, setTab] = useState<GalleryTab>("yours");

	const load = useCallback(() => {
		setItems(null);
		void (tab === "shared" ? listSharedArtifacts() : listArtifacts())
			.then(setItems)
			.catch(() => setItems([]));
	}, [tab]);

	useEffect(() => load(), [load]);

	/** Delete an artifact, then optimistically drop it from the list. */
	const remove = useCallback(async (id: string) => {
		try {
			await deleteArtifact(id);
			setItems((prev) => prev?.filter((a) => a.id !== id) ?? prev);
			setSelected((s) => (s?.id === id ? null : s));
		} catch {
			// Non-fatal — the next load reconciles.
		}
	}, []);

	// A selected artifact takes over the region — read-only, with explicit actions.
	if (selected) {
		return (
			<AgentArtifactViewer
				artifact={selected}
				hasActiveChat={hasActiveChat}
				owned={tab === "yours"}
				onBack={() => setSelected(null)}
				onAddToChat={() => onAddToChat(selected.id)}
				onOpenInNewChat={() => onOpenInNewChat(selected.id, selected.name)}
				onDelete={() => remove(selected.id)}
			/>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* Gallery top bar — mirrors the conversation top bar's height/rhythm. */}
			<div className="flex flex-none items-center gap-2 border-b border-border px-3 py-2.5">
				<div className="text-sm font-medium text-foreground">Artifacts</div>
				<span className="font-mono text-ui-xs text-muted-foreground">
					{items ? items.length : ""}
				</span>
				<div className="ml-3 flex items-center border border-border">
					{(["yours", "shared"] as const).map((t) => (
						<button
							key={t}
							type="button"
							onClick={() => setTab(t)}
							className={cn(
								"px-2.5 py-1 text-ui-sm transition-colors",
								tab === t
									? "bg-muted text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{t === "yours" ? "Yours" : "Shared with you"}
						</button>
					))}
				</div>
				<div className="ml-auto flex items-center gap-1.5">
					<Button
						size="sm"
						variant="outline"
						className="gap-1.5 rounded-none"
						onClick={onNewArtifact}
					>
						<Plus className="h-3.5 w-3.5" />
						New artifact
					</Button>
					<button
						type="button"
						aria-label="Close artifacts"
						onClick={onClose}
						className="flex size-8 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<X className="h-4 w-4" />
					</button>
				</div>
			</div>

			<ScrollArea className="min-h-0 flex-1">
				<div className="p-5">
				{items === null ? (
					<EmptyState className={GALLERY_EMPTY} title="Loading artifacts…" />
				) : items.length === 0 ? (
					tab === "shared" ? (
						<EmptyState
							className={GALLERY_EMPTY}
							icon={<LayoutDashboard />}
							title="Nothing shared with you yet"
							description="When a teammate shares an artifact with your org, a team you belong to, or a role you hold, it shows up here."
						/>
					) : (
						<EmptyState
							className={GALLERY_EMPTY}
							icon={<LayoutDashboard />}
							title="No artifacts yet"
							description="Start a chat, ask Elench to build a dashboard, then save it — it lands here for any conversation to reopen."
							action={
								<Button
									size="sm"
									className="gap-1.5 rounded-none"
									onClick={onNewArtifact}
								>
									<Plus className="h-3.5 w-3.5" />
									New artifact
								</Button>
							}
						/>
					)
				) : (
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{items.map((a) => (
							<div
								key={a.id}
								data-testid="artifact-card"
								className="group/card relative flex flex-col justify-between border border-border bg-background p-4 transition-colors hover:bg-muted"
							>
								<button
									type="button"
									// Opens the VIEWER. It does not touch any conversation.
									onClick={() => setSelected(a)}
									className="flex flex-1 flex-col items-start gap-3 text-left"
								>
									<span className="flex size-9 flex-none items-center justify-center border border-border text-muted-foreground">
										{a.kind === "dashboard" ? (
											<LayoutDashboard className="h-4 w-4" />
										) : (
											<Square className="h-4 w-4" />
										)}
									</span>
									<span
										title={a.name}
										className="line-clamp-2 min-w-0 break-words text-ui-lg font-medium text-foreground"
									>
										{a.name}
									</span>
								</button>
								<div className="mt-4 flex items-center justify-between">
									<span className="font-mono text-ui-2xs uppercase text-muted-foreground">
										{a.kind} · {a.spec.widgets.length}{" "}
										{a.spec.widgets.length === 1 ? "widget" : "widgets"}
									</span>
									{tab === "yours" && (
										<button
											type="button"
											aria-label={`Delete ${a.name}`}
											onClick={() => void remove(a.id)}
											className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/card:opacity-100"
										>
											<Trash2 className="h-3.5 w-3.5" />
										</button>
									)}
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
