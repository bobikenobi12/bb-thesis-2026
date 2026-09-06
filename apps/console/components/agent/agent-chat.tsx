"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { isToolUIPart, type ToolUIPart, type UIMessage } from "ai";
import {
	Check,
	CopyIcon,
	HelpCircle,
	Loader2,
	RefreshCcwIcon,
	ThumbsDown,
	ThumbsUp,
} from "lucide-react";
import { motion } from "motion/react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { Action, Actions } from "@/components/ai-elements/actions";
import { ChatError } from "@/components/agent/chat-error";
import {
	Message,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from "@/components/ai-elements/message-scroller";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { ToolResultFrame } from "@/components/agent/tool-result-frame";
import { Marker, MarkerContent } from "@/components/ai-elements/marker";
import {
	AGENT_STEP_PART_TYPE,
	agentStepDataSchema,
} from "@/lib/ai/agent-steps";
import { cn } from "@repo/ui/utils";

export type AgentChatStatus = "submitted" | "streaming" | "ready" | "error";

export interface AgentToolRenderContext {
	messageId: string;
	index: number;
}

/**
 * Render a tool part. Return `undefined` to fall back to the default `<Tool>`
 * card; return `null` to render nothing; return a node to render it. Lets each
 * surface own its proposal/approval lanes while sharing the transcript.
 */
export type RenderToolPart = (
	part: ToolUIPart,
	ctx: AgentToolRenderContext,
) => ReactNode | undefined;

export interface AgentChatProps {
	messages: UIMessage[];
	status: AgentChatStatus;
	error?: Error;
	onSend: (text: string) => void;
	suggestions?: string[];
	placeholder?: string;
	emptyState?: ReactNode;
	renderToolPart?: RenderToolPart;
	/** Shown when `error` is set (defaults to a generic unavailable message). */
	errorMessage?: ReactNode;
	/** When provided, the last assistant message gets a Retry action that re-runs it.
	 * Also drives the error state's always-present Retry. */
	onRetry?: () => void;
	/** Abort the in-flight stream. When set, the composer's submit becomes a Stop
	 * control while generating. */
	onStop?: () => void;
	className?: string;
	/** Rendered on the left of the composer footer (e.g. the Ask-mode pill). */
	composerLeft?: ReactNode;
	/** Rendered just before the submit button (e.g. a settings/model control). */
	composerRight?: ReactNode;
	/** Hide the docked composer entirely (the modal empty landing owns its own). */
	hideComposer?: boolean;
	/** Replace the default composer (e.g. the Elench composer with @-mentions). */
	renderComposer?: ReactNode;
	/** Override the composer container's classes (default: a top-bordered bar). The modal
	 * passes a padded, border-less variant so the composer floats as a card over the canvas. */
	composerClassName?: string;
	/** Per-message thumbs feedback (up/down). Shown on completed assistant turns. */
	onFeedback?: (messageId: string, value: "up" | "down") => void;
	/** Prior persisted thumbs, keyed by message id — seeds the filled state on load. */
	initialFeedback?: Record<string, "up" | "down">;
	/** When set, a "Support" action links here from each assistant turn. */
	supportHref?: string;
	/** In-app support handler — preferred over `supportHref` so we navigate same-tab
	 * (client router) instead of opening an external tab. */
	onSupport?: () => void;
}

/** Concatenate a message's text parts (for the Copy action). */
function messageText(message: UIMessage): string {
	return message.parts
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map((p) => p.text)
		.join("\n\n");
}

/**
 * Surface-agnostic chat transcript + composer, built on the AI Elements
 * primitives (grayscale/squared): streamed markdown responses, a `Reasoning`
 * panel for model thinking, `Tool` cards, and per-message `Actions`
 * (copy/regenerate). Consumed by the project assistant and the agent surfaces —
 * each passes its own transport (via `useAgentChat`) + an optional
 * `renderToolPart` for proposal/approval lanes.
 */
export function AgentChat({
	messages,
	status,
	error,
	onSend,
	suggestions,
	placeholder = "Ask the agent, or describe what to build…",
	emptyState,
	renderToolPart,
	errorMessage,
	onRetry,
	onStop,
	className,
	composerLeft,
	composerRight,
	hideComposer,
	renderComposer,
	composerClassName,
	onFeedback,
	supportHref,
	onSupport,
	initialFeedback,
}: AgentChatProps) {
	const pending = status === "submitted" || status === "streaming";
	const lastMessageId = messages.at(-1)?.id;
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [feedback, setFeedback] =
		useState<Record<string, "up" | "down">>(initialFeedback ?? {});
	// Re-seed when the hydrated map arrives / the active thread changes (the consumer passes a
	// stable object per thread, so this doesn't clobber optimistic clicks mid-conversation).
	useEffect(() => {
		setFeedback(initialFeedback ?? {});
	}, [initialFeedback]);

	const copyMessage = (message: UIMessage) => {
		void navigator.clipboard.writeText(messageText(message)).then(() => {
			setCopiedId(message.id);
			setTimeout(() => setCopiedId((id) => (id === message.id ? null : id)), 1500);
		});
	};

	const submit = (text: string) => {
		const t = text.trim();
		if (!t || pending) return;
		onSend(t);
	};

	return (
		<div className={cn("flex min-h-0 flex-1 flex-col", className)}>
			<MessageScrollerProvider autoScroll defaultScrollPosition="end">
				<MessageScroller className="flex-1">
					<MessageScrollerViewport className="scrollbar-thin">
						{/* The primitive pins a new user turn to the top by growing its trailing spacer
						    to the viewport-bottom overshoot — but never shrinks it back, leaving a
						    permanent blank region under short replies. Cap it to the viewport while a
						    turn is in flight (non-binding, keeps the pinned-question UX) and collapse
						    it once the turn settles. */}
						<MessageScrollerContent
							className="p-4"
							spacerClassName={cn(
								"transition-[max-height] duration-300 ease-out",
								pending ? "max-h-[100dvh]" : "max-h-0",
							)}
						>
							{messages.length === 0 &&
								(emptyState ??
									(suggestions && suggestions.length > 0 ? (
										<div className="space-y-3">
											<p className="text-sm text-muted-foreground">
												Try one of these:
											</p>
											<Suggestions>
												{suggestions.map((s) => (
													<Suggestion key={s} suggestion={s} onClick={submit} />
												))}
											</Suggestions>
										</div>
									) : null))}

							{messages.map((m) => {
								const isUser = m.role === "user";
								// Per-part nodes — shared by both roles; the wrapper differs (user →
								// bubble, assistant → bare text/tools). Text renders through Streamdown
								// for the assistant (markdown) and as plain text for the user.
								const partNodes = m.parts.map((part, i) => {
									const key = `${m.id}-${i}`;

									if (part.type === "reasoning" && part.text) {
										return (
											<Reasoning
												key={key}
												className="w-full"
												// Part-accurate: shimmer/auto-collapse track THIS part's
												// stream state, not the whole turn (a turn can keep
												// streaming tools long after the thinking finished).
												isStreaming={
													part.state === "streaming" && status === "streaming"
												}
											>
												<ReasoningTrigger />
												<ReasoningContent>{part.text}</ReasoningContent>
											</Reasoning>
										);
									}

									// Orchestration step marker — a hairline separator naming only
									// Elench and the phase (`Elench · Planning` / `Elench · Working`),
									// streamed by the route at each model boundary of the turn. The
									// underlying model is intentionally NOT shown (the route still
									// emits `model`/`label` in the part for metering/analytics — the
									// UI just ignores it).
									if (part.type === AGENT_STEP_PART_TYPE) {
										const parsed = agentStepDataSchema.safeParse(part.data);
										if (!parsed.success) return null;
										const phaseLabel =
											parsed.data.phase === "plan"
												? "Elench · Planning"
												: "Elench · Working";
										return (
											<Marker key={key} variant="separator" className="my-1">
												<MarkerContent className="font-mono text-ui-2xs uppercase tracking-wide">
													{phaseLabel}
												</MarkerContent>
											</Marker>
										);
									}

									if (part.type === "text" && part.text) {
										return isUser ? (
											<span key={key} className="whitespace-pre-wrap">
												{part.text}
											</span>
										) : (
											<MessageResponse key={key}>{part.text}</MessageResponse>
										);
									}

									if (isToolUIPart(part)) {
										if (part.type === "dynamic-tool") return null;

										const custom = renderToolPart?.(part, {
											messageId: m.id,
											index: i,
										});
										if (custom !== undefined)
											return <Fragment key={key}>{custom}</Fragment>;

										return <ToolResultFrame key={key} part={part} />;
									}

									return null;
								});

								const caret = m.role === "assistant" &&
									m.id === lastMessageId &&
									status === "streaming" && (
										<span
											aria-hidden
											className="ml-0.5 inline-block h-3.5 w-[7px] animate-pulse bg-foreground align-text-bottom"
										/>
									);

								return (
									<MessageScrollerItem
										key={m.id}
										messageId={m.id}
										scrollAnchor={isUser}
									>
										<motion.div
											initial={{ opacity: 0, y: 4 }}
											animate={{ opacity: 1, y: 0 }}
											transition={{ duration: 0.18, ease: "easeOut" }}
										>
											{/* `MessageContent` IS the user's bubble — the skin lives in the
											    component (`group-[.is-user]:bg-secondary …`), which is why the
											    separate `Bubble`/`BubbleContent` pair is gone. The two widths
											    are pinned because the shared default (`max-w-[95%]`, `w-fit`)
											    is tuned for a prose thread: the agent transcript renders tool
											    frames and tables the assistant column must not shrink-wrap. */}
											<Message
												from={m.role}
												className={isUser ? "max-w-[80%]" : "max-w-full"}
											>
												<MessageContent className={isUser ? undefined : "w-full"}>
													{isUser ? (
														partNodes
													) : (
														<div className="flex min-w-0 flex-col gap-2">
															{partNodes}
															{caret}
														</div>
													)}

													{/* Copy / regenerate on completed assistant turns. */}
													{m.role === "assistant" &&
														!(m.id === lastMessageId && pending) &&
														messageText(m) && (
															<Actions className="px-1">
																{onFeedback && (
																	<>
																		<Action
																			tooltip="Good response"
																			label="Good response"
																			onClick={() => {
																				setFeedback((f) => ({ ...f, [m.id]: "up" }));
																				onFeedback(m.id, "up");
																			}}
																		>
																			<ThumbsUp
																				className={cn(
																					"size-3.5",
																					feedback[m.id] === "up" && "fill-current",
																				)}
																			/>
																		</Action>
																		<Action
																			tooltip="Bad response"
																			label="Bad response"
																			onClick={() => {
																				setFeedback((f) => ({ ...f, [m.id]: "down" }));
																				onFeedback(m.id, "down");
																			}}
																		>
																			<ThumbsDown
																				className={cn(
																					"size-3.5",
																					feedback[m.id] === "down" && "fill-current",
																				)}
																			/>
																		</Action>
																	</>
																)}
																<Action
																	tooltip={copiedId === m.id ? "Copied" : "Copy"}
																	label="Copy message"
																	onClick={() => copyMessage(m)}
																>
																	{copiedId === m.id ? (
																		<Check className="size-3.5" />
																	) : (
																		<CopyIcon className="size-3.5" />
																	)}
																</Action>
																{onRetry && m.id === lastMessageId && (
																	<Action
																		tooltip="Retry"
																		label="Regenerate response"
																		onClick={onRetry}
																	>
																		<RefreshCcwIcon className="size-3.5" />
																	</Action>
																)}
																{(onSupport || supportHref) && (
																	<Action
																		tooltip="Support"
																		label="Get support"
																		onClick={() => {
																			if (onSupport) onSupport();
																			else if (supportHref)
																				window.open(supportHref, "_blank", "noopener");
																		}}
																	>
																		<HelpCircle className="size-3.5" />
																	</Action>
																)}
															</Actions>
														)}
												</MessageContent>
											</Message>
										</motion.div>
									</MessageScrollerItem>
								);
							})}

							{status === "submitted" && (
								<motion.div
									initial={{ opacity: 0 }}
									animate={{ opacity: 1 }}
									className="flex items-center gap-2 text-xs text-muted-foreground"
								>
									<Loader2 className="h-3 w-3 animate-spin" />
									Thinking…
								</motion.div>
							)}
							{error &&
								(errorMessage ? (
									<div className="border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
										{errorMessage}
									</div>
								) : (
									<ChatError error={error} onRetry={onRetry} />
								))}
						</MessageScrollerContent>
					</MessageScrollerViewport>
					<MessageScrollerButton />
				</MessageScroller>
			</MessageScrollerProvider>

			{!hideComposer && (
				<div className={cn("border-t border-border p-3", composerClassName)}>
					{renderComposer ?? (
						<PromptInput
							className="rounded-none"
							onSubmit={(message) => {
								if (message.text) submit(message.text);
							}}
						>
							<PromptInputBody>
								<PromptInputTextarea placeholder={placeholder} />
							</PromptInputBody>
							<PromptInputFooter
								className={composerLeft ? "justify-between" : "justify-end"}
							>
								{composerLeft}
								<div className="flex items-center gap-1">
									{composerRight}
									<PromptInputSubmit
										status={status}
										onStop={onStop}
										disabled={pending && !onStop}
									/>
								</div>
							</PromptInputFooter>
						</PromptInput>
					)}
				</div>
			)}
		</div>
	);
}
