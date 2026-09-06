"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolUIPart } from "ai";
import { ChevronDownIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@repo/ui/collapsible";
import { cn } from "@repo/ui/utils";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
	statusLabels,
	ToolInput,
	ToolOutput,
} from "@/components/ai-elements/tool";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ai-elements/marker";

/** Tool-part states in which the call is still doing work (marker dot pulses). */
const RUNNING_STATES = new Set<ToolUIPart["state"]>([
	"input-streaming",
	"input-available",
	"approval-requested",
]);

/** Whether a tool part has reached a terminal state (no further streaming). */
function isTerminal(state: ToolUIPart["state"]): boolean {
	return !RUNNING_STATES.has(state);
}

/**
 * Elapsed seconds for a tool call observed live: starts timing when the part mounts in a
 * running state and freezes on the terminal transition. Returns `null` while running and
 * for parts that mount already terminal (resumed transcripts carry no timing signal).
 */
function useToolDuration(state: ToolUIPart["state"]): number | null {
	const terminal = isTerminal(state);
	const startRef = useRef<number | null>(terminal ? null : Date.now());
	const mountedTerminalRef = useRef(terminal);
	const [duration, setDuration] = useState<number | null>(null);

	useEffect(() => {
		if (mountedTerminalRef.current) return;
		if (!terminal) {
			startRef.current ??= Date.now();
			return;
		}
		if (startRef.current !== null) {
			setDuration(Math.max(1, Math.round((Date.now() - startRef.current) / 1000)));
			startRef.current = null;
		}
	}, [terminal]);

	return duration;
}

/** Derive the human tool name from a part type (`tool-list_jobs` → `list_jobs`). */
function toolName(part: ToolUIPart): string {
	return part.type.split("-").slice(1).join("-");
}

export interface ToolResultFrameProps {
	part: ToolUIPart;
	/** Overrides the derived tool-name label (e.g. "Proposal"). */
	title?: string;
	/** Inline detail appended to the marker line (e.g. "4 rows", "10.0.0.0/23 · 512 IPs"). */
	detail?: string;
	/** Right-aligned action(s) on the marker row (Open in panel / canvas…). */
	actions?: ReactNode;
	/** Rich body under the marker; omitted → a collapsible generic params/result body. */
	children?: ReactNode;
	/** Default open state of the generic collapsible body (ignored with `children`). */
	defaultOpen?: boolean;
}

/**
 * The single labeled treatment every tool part renders inside: a `Marker` status line
 * (dot — pulsing while running — mono tool name, status label with shimmer while
 * streaming, live duration, optional inline detail, right-aligned actions) above an
 * optional rich body. With no body it falls back to a collapsed params/result view, so
 * a multi-tool turn always reads as a uniform stack of captioned results.
 */
export function ToolResultFrame({
	part,
	title,
	detail,
	actions,
	children,
	defaultOpen = false,
}: ToolResultFrameProps) {
	const running = RUNNING_STATES.has(part.state);
	const duration = useToolDuration(part.state);
	const [open, setOpen] = useState(defaultOpen);
	const label = statusLabels[part.state];
	const name = title ?? toolName(part);
	// The generic body only has content once params/results exist.
	const hasGenericBody =
		children === undefined &&
		(part.input !== undefined || part.output !== undefined || !!part.errorText);

	const marker = (
		<Marker
			data-slot="tool-result-frame-marker"
			className="min-h-5 font-mono text-ui-2xs uppercase tracking-wide"
		>
			<MarkerIcon className="flex size-auto items-center">
				<span
					className={cn(
						"h-1.5 w-1.5 rounded-full",
						part.state === "output-available" ? "bg-foreground" : "bg-muted-foreground/70",
						running && "animate-pulse bg-foreground",
					)}
				/>
			</MarkerIcon>
			<MarkerContent className="flex min-w-0 items-center gap-1.5 truncate">
				<span className="text-foreground">{name}</span>
				<span aria-hidden>·</span>
				{running ? <Shimmer duration={1.5}>{label}</Shimmer> : <span>{label}</span>}
				{duration !== null && (
					<>
						<span aria-hidden>·</span>
						<span>{duration}s</span>
					</>
				)}
				{detail && (
					<>
						<span aria-hidden>·</span>
						<span className="truncate">{detail}</span>
					</>
				)}
			</MarkerContent>
			<span className="ml-auto flex flex-none items-center gap-1 normal-case">
				{actions}
				{hasGenericBody && (
					<CollapsibleTrigger
						aria-label={open ? "Hide details" : "Show details"}
						className="flex h-5 w-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
					>
						<ChevronDownIcon
							className={cn("size-3.5 transition-transform", open && "rotate-180")}
						/>
					</CollapsibleTrigger>
				)}
			</span>
		</Marker>
	);

	// Rich body — always visible under the marker.
	if (children !== undefined) {
		return (
			<div data-slot="tool-result-frame" className="w-full">
				{marker}
				<div className="mt-1.5">{children}</div>
			</div>
		);
	}

	// Generic fallback — the raw params/result, collapsed behind the chevron.
	return (
		<Collapsible
			data-slot="tool-result-frame"
			className="w-full"
			open={open}
			onOpenChange={setOpen}
		>
			{marker}
			{hasGenericBody && (
				<CollapsibleContent className="mt-1.5 space-y-3 border border-border p-3">
					{(part.state === "input-available" ||
						part.state === "output-available") && <ToolInput input={part.input} />}
					<ToolOutput output={part.output} errorText={part.errorText} />
				</CollapsibleContent>
			)}
		</Collapsible>
	);
}
