"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Check, ChevronDown } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import type { AgentMode } from "@/lib/ai/tools";
import { AI_MODELS } from "@/lib/config/ai";
import { cn } from "@repo/ui/utils";

interface ChatTopBarProps {
	title: string;
	mode: AgentMode;
	onModeChange: (m: AgentMode) => void;
	model: string;
	onModelChange: (id: string) => void;
}

/** Agent chat header — thread title + Ask/Act segment + model picker. */
export function ChatTopBar({
	title,
	mode,
	onModeChange,
	model,
	onModelChange,
}: ChatTopBarProps) {
	const selected = AI_MODELS.find((m) => m.id === model) ?? AI_MODELS[0];

	return (
		<header className="flex h-[52px] flex-none items-center gap-3 border-b border-border px-5">
			<span title={title} className="min-w-0 truncate text-sm font-medium">
				{title}
			</span>

			<div className="ml-auto flex flex-none items-center gap-2.5">
				<div className="flex border border-border">
					{(["ask", "act"] as const).map((m) => (
						<button
							key={m}
							type="button"
							onClick={() => onModeChange(m)}
							className={cn(
								"px-3 py-1 text-xs capitalize transition-colors",
								m === "act" && "border-l border-border",
								mode === m
									? "bg-muted text-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{m}
						</button>
					))}
				</div>

				<DropdownMenu>
					<DropdownMenuTrigger className="flex items-center gap-2 border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted">
						<span className="h-1.5 w-1.5 rounded-full bg-foreground" />
						{selected.name}
						<ChevronDown className="h-3 w-3 text-muted-foreground" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="rounded-none">
						{AI_MODELS.map((m) => (
							<DropdownMenuItem
								key={m.id}
								onSelect={() => onModelChange(m.id)}
								className="gap-6 rounded-none text-xs"
							>
								<div className="flex flex-col">
									<span>{m.name}</span>
									<span className="font-mono text-ui-3xs text-muted-foreground">
										{m.provider}
									</span>
								</div>
								{m.id === model && <Check className="ml-auto h-3.5 w-3.5" />}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</header>
	);
}
