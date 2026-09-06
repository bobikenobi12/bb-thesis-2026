"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	BookOpen,
	ChevronDown,
	FileText,
	Loader2,
	Lock,
	Pencil,
	Plus,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	canEditAgentContext,
	getAgentContext,
	getProjectKnowledgePreview,
	upsertAgentContext,
} from "@/app/server/actions/agent-context";
import { KNOWLEDGE_LIMIT } from "@/lib/ai/knowledge-limits";
import type { KnowledgeDoc } from "@/types/jsonb.types";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { Input } from "@repo/ui/input";
import { ScrollArea } from "@repo/ui/scroll-area";
import { Textarea } from "@repo/ui/textarea";
import { cn } from "@repo/ui/utils";

/**
 * Density tuning for `@repo/ui/empty`'s `EmptyState` inside the knowledge panel.
 *
 * The shared component is sized for a page — `p-6 md:p-12` around a `text-lg` headline over a
 * `text-sm/relaxed` line. This panel's copy is a 13px headline over a 12px line, so BOTH slots
 * are tuned: tuning only the title leaves the description at 14px, larger than the headline it
 * sits under. The border is not in here because it belongs to the boxed docs affordance, not to
 * the transient loading line — which otherwise renders at a different scale from the state it
 * flashes before.
 */
const KNOWLEDGE_EMPTY =
	"gap-3 p-8 md:p-8 [&_[data-slot=empty-title]]:text-ui-md [&_[data-slot=empty-title]]:font-normal [&_[data-slot=empty-description]]:text-xs";

/** "2.1k" / "840" — knowledge size reads as a budget, so it's always a bare figure. */
function size(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** "2d ago" — "when did I last touch this" is the only useful reading of a doc's timestamp. */
function relTime(iso: string): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return "";
	const m = Math.floor((Date.now() - t) / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/** Turn the derived markdown block into `label · value` rows — never a raw <pre> dump. */
function parseDerived(block: string): Array<{ label: string; value: string }> {
	const rows: Array<{ label: string; value: string }> = [];
	for (const raw of block.split("\n")) {
		const line = raw.trim();
		if (!line.startsWith("-")) continue;
		const body = line.replace(/^-+\s*/, "");
		const i = body.indexOf(":");
		if (i === -1) rows.push({ label: "", value: body });
		else
			rows.push({
				label: body.slice(0, i).trim(),
				value: body.slice(i + 1).trim(),
			});
	}
	return rows;
}

/** A blank document, ready to edit. */
function emptyDoc(): KnowledgeDoc {
	return {
		id: crypto.randomUUID(),
		title: "",
		content: "",
		updated_at: new Date().toISOString(),
	};
}

/**
 * The Knowledge panel — a real knowledge base, not a pair of textareas.
 *
 * Modeled on a Claude Project: **custom instructions** (how Elench should behave here) plus a
 * knowledge base of **named documents** (what it should always know). Both ride the system prompt
 * of every chat in this scope, so their size is a real per-turn cost — hence the capacity meter.
 * The third section shows what Elench *already derives* from live state, so it's obvious what you
 * do NOT need to write down.
 *
 * Scope: `projectId` set → that infra project's row; null → the org-level row, which is layered
 * under every project's.
 */
export function AgentKnowledgePanel({
	projectId,
	onClose,
}: {
	projectId: string | null;
	onClose: () => void;
}) {
	const scope = projectId ? "Project" : "Organization";
	const [instructions, setInstructions] = useState("");
	const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
	const [derived, setDerived] = useState("");
	const [derivedOpen, setDerivedOpen] = useState(false);
	const [loading, setLoading] = useState(true);
	// Whether the caller may edit this scope's knowledge (org:edit / project:edit when the
	// org-shared flag is on; always true otherwise). Non-editors get a read-only panel instead of
	// a silent 403 on auto-save. Defaults true so the editable UI never flashes for an editor.
	const [canEdit, setCanEdit] = useState(true);
	const [editing, setEditing] = useState<KnowledgeDoc | null>(null);
	const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
		"idle",
	);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void (async () => {
			const [ctx, preview, editable] = await Promise.all([
				getAgentContext(projectId).catch(() => null),
				projectId
					? getProjectKnowledgePreview(projectId).catch(() => "")
					: Promise.resolve(""),
				canEditAgentContext(projectId).catch(() => false),
			]);
			if (cancelled) return;
			setInstructions(ctx?.instructions ?? "");
			setDocs(ctx?.documents ?? []);
			setDerived(preview);
			setCanEdit(editable);
			setLoading(false);
		})();
		return () => {
			cancelled = true;
		};
	}, [projectId]);

	const used = useMemo(
		() => docs.reduce((n, d) => n + d.content.length, 0),
		[docs],
	);
	const over = used > KNOWLEDGE_LIMIT;

	/** Persist instructions + the whole document set (one row, one write). */
	const save = useCallback(
		async (nextDocs: KnowledgeDoc[], nextInstructions: string) => {
			if (!canEdit) return; // read-only caller — the affordances are hidden; guard the seam too
			setState("saving");
			setError(null);
			try {
				await upsertAgentContext({
					projectId,
					instructions: nextInstructions,
					documents: nextDocs,
				});
				setState("saved");
				setTimeout(() => setState("idle"), 1200);
			} catch (e) {
				setState("error");
				setError(e instanceof Error ? e.message : "Save failed.");
			}
		},
		[projectId, canEdit],
	);

	/** Commit the open editor into the document set, then persist. */
	const commitDoc = useCallback(() => {
		if (!editing) return;
		const title = editing.title.trim();
		if (!title) return;
		const doc: KnowledgeDoc = {
			...editing,
			title,
			updated_at: new Date().toISOString(),
		};
		const next = docs.some((d) => d.id === doc.id)
			? docs.map((d) => (d.id === doc.id ? doc : d))
			: [...docs, doc];
		setDocs(next);
		setEditing(null);
		void save(next, instructions);
	}, [editing, docs, instructions, save]);

	const removeDoc = useCallback(
		(id: string) => {
			const next = docs.filter((d) => d.id !== id);
			setDocs(next);
			void save(next, instructions);
		},
		[docs, instructions, save],
	);

	const derivedRows = useMemo(() => parseDerived(derived), [derived]);

	return (
		<div data-testid="knowledge-panel" className="flex h-full min-h-0 flex-col">
			<div className="flex flex-none items-center gap-2 border-b border-border px-3 py-2.5">
				<BookOpen className="h-4 w-4 text-muted-foreground" />
				<div className="text-sm font-medium text-foreground">
					{scope} knowledge
				</div>
				<div className="ml-auto flex items-center gap-2">
					{!loading && !canEdit ? (
						<span className="flex items-center gap-1 text-ui-xs text-muted-foreground">
							<Lock className="h-3 w-3" />
							Read-only
						</span>
					) : (
						<span className="text-ui-xs text-muted-foreground">
							{state === "saving"
								? "Saving…"
								: state === "saved"
									? "Saved."
									: (error ?? "")}
						</span>
					)}
					<button
						type="button"
						aria-label="Close knowledge"
						onClick={onClose}
						className="flex size-8 items-center justify-center rounded-none text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					>
						<X className="h-4 w-4" />
					</button>
				</div>
			</div>

			<ScrollArea className="min-h-0 flex-1">
				<div className="mx-auto max-w-[760px] space-y-7 p-5">
					{loading ? (
						<EmptyState className={KNOWLEDGE_EMPTY} title="Loading…" />
					) : (
						<>
							{/* Read-only notice: this member can't edit the shared knowledge. */}
							{!canEdit && (
								<p
									data-testid="knowledge-readonly-notice"
									className="flex items-center gap-1.5 border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
								>
									<Lock className="h-3.5 w-3.5 flex-none" />
									Only members with edit access can change the{" "}
									{projectId ? "project" : "organization"} knowledge.
								</p>
							)}

							{/* ── Instructions ──────────────────────────────────────── */}
							<section className="space-y-2">
								<div className="vx-eyebrow text-ui-3xs">Instructions</div>
								<p className="text-xs text-muted-foreground">
									How Elench should behave in{" "}
									{projectId ? "this project" : "org chats"}. Rides every turn.
								</p>
								<Textarea
									data-testid="knowledge-instructions"
									value={instructions}
									readOnly={!canEdit}
									onChange={(e) => setInstructions(e.target.value)}
									onBlur={() => void save(docs, instructions)}
									rows={4}
									placeholder={
										canEdit
											? "e.g. This is production — always require approval before an apply, and never propose destroy."
											: "No instructions set."
									}
									className={cn(
										"rounded-none text-sm",
										!canEdit && "cursor-default bg-muted/20",
									)}
								/>
							</section>

							{/* ── Knowledge documents ───────────────────────────────── */}
							<section className="space-y-2">
								<div className="flex items-baseline justify-between gap-2">
									<div className="vx-eyebrow text-ui-3xs">Knowledge</div>
									<span
										className={cn(
											"font-mono text-ui-2xs",
											over ? "text-foreground" : "text-muted-foreground",
										)}
									>
										{size(used)} / {size(KNOWLEDGE_LIMIT)}
									</span>
								</div>
								<p className="text-xs text-muted-foreground">
									What Elench can’t work out on its own — conventions, owners,
									runbooks, gotchas. Each document is named, so it can tell you
									which one it drew on.
								</p>

								{/* Capacity meter — knowledge is paid for on every single turn. */}
								<div className="h-0.5 w-full bg-border">
									<div
										className={cn(
											"h-full",
											over ? "bg-foreground" : "bg-muted-foreground/50",
										)}
										style={{
											width: `${Math.min(100, (used / KNOWLEDGE_LIMIT) * 100)}%`,
										}}
									/>
								</div>

								{docs.length === 0 && !editing && (
									<EmptyState
										className={cn(KNOWLEDGE_EMPTY, "border border-border")}
										icon={<FileText />}
										title={
											canEdit
												? "No knowledge yet."
												: `No knowledge set for this ${projectId ? "project" : "organization"}.`
										}
										description={
											canEdit
												? "Add what Elench should always know. It can already read your live infrastructure on its own."
												: undefined
										}
									/>
								)}

								{docs.length > 0 && (
									<div className="divide-y divide-border border border-border">
										{docs.map((d) => (
											<div
												key={d.id}
												data-testid="knowledge-doc"
												className="group/doc flex items-center gap-3 bg-background px-3 py-2.5"
											>
												<FileText className="h-4 w-4 flex-none text-muted-foreground" />
												<span className="min-w-0 flex-1">
													<span
														title={d.title}
														className="block truncate text-ui-md font-medium text-foreground"
													>
														{d.title}
													</span>
													<span className="block font-mono text-ui-2xs text-muted-foreground">
														{size(d.content.length)} · {relTime(d.updated_at)}
													</span>
												</span>
												{canEdit && (
													<span className="flex flex-none items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/doc:opacity-100">
														<button
															type="button"
															aria-label={`Edit ${d.title}`}
															onClick={() => setEditing(d)}
															className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground"
														>
															<Pencil className="h-3.5 w-3.5" />
														</button>
														<button
															type="button"
															aria-label={`Delete ${d.title}`}
															onClick={() => removeDoc(d.id)}
															className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground"
														>
															<Trash2 className="h-3.5 w-3.5" />
														</button>
													</span>
												)}
											</div>
										))}
									</div>
								)}

								{editing ? (
									<div className="space-y-2 border border-border bg-muted/30 p-3">
										<Input
											data-testid="knowledge-doc-title"
											value={editing.title}
											onChange={(e) =>
												setEditing({ ...editing, title: e.target.value })
											}
											placeholder="Title — e.g. Runbook: production deploys"
											className="h-8 rounded-none text-sm"
										/>
										<Textarea
											data-testid="knowledge-doc-content"
											value={editing.content}
											onChange={(e) =>
												setEditing({ ...editing, content: e.target.value })
											}
											rows={8}
											placeholder="What should Elench know?"
											className="rounded-none text-sm"
										/>
										<div className="flex items-center justify-between">
											<span className="font-mono text-ui-2xs text-muted-foreground">
												{size(editing.content.length)}
											</span>
											<span className="flex items-center gap-1.5">
												<Button
													size="sm"
													variant="ghost"
													className="rounded-none"
													onClick={() => setEditing(null)}
												>
													Cancel
												</Button>
												<Button
													size="sm"
													data-testid="knowledge-doc-save"
													className="rounded-none"
													disabled={!editing.title.trim()}
													onClick={commitDoc}
												>
													{state === "saving" ? (
														<Loader2 className="h-3.5 w-3.5 animate-spin" />
													) : (
														"Save document"
													)}
												</Button>
											</span>
										</div>
									</div>
								) : canEdit ? (
									<Button
										size="sm"
										variant="outline"
										data-testid="knowledge-add"
										className="gap-1.5 rounded-none"
										onClick={() => setEditing(emptyDoc())}
									>
										<Plus className="h-3.5 w-3.5" />
										Add knowledge
									</Button>
								) : null}
							</section>

							{/* ── Already known (auto-derived) ──────────────────────── */}
							{projectId && derivedRows.length > 0 && (
								<section className="space-y-2">
									<button
										type="button"
										onClick={() => setDerivedOpen((o) => !o)}
										className="flex w-full items-center gap-1.5 text-left"
									>
										<span className="vx-eyebrow text-ui-3xs">
											Already known · auto-derived
										</span>
										<ChevronDown
											className={cn(
												"h-3.5 w-3.5 text-muted-foreground transition-transform",
												derivedOpen && "rotate-180",
											)}
										/>
									</button>
									<p className="text-xs text-muted-foreground">
										Elench reads this from live state on every turn. You don’t
										need to write any of it down.
									</p>
									{derivedOpen && (
										<dl className="divide-y divide-border border border-border">
											{derivedRows.map((r, i) => (
												<div
													key={`${r.label}-${i}`}
													className="flex gap-4 px-3 py-2"
												>
													<dt className="w-40 flex-none text-ui-sm text-muted-foreground">
														{r.label || "—"}
													</dt>
													<dd className="min-w-0 flex-1 break-words font-mono text-ui-xs text-foreground">
														{r.value}
													</dd>
												</div>
											))}
										</dl>
									)}
								</section>
							)}
						</>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
