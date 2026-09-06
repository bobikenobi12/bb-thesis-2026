"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `@`-mention typeahead for the Lexical composer — Discord-style: type `@`, a scrollable,
// keyboard-navigable menu of the owner's taggable resources opens above the caret; picking one
// drops an atomic mention pill. Options come from the existing `searchMentions` action via the
// debounced `useMentionSearch` hook; the menu is its own scroll container so it never overflows.

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	LexicalTypeaheadMenuPlugin,
	MenuOption,
	useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import {
	COMMAND_PRIORITY_NORMAL,
	$createTextNode,
	type TextNode,
} from "lexical";
import {
	Boxes,
	Cpu,
	KeyRound,
	LayoutDashboard,
	Loader2,
	type LucideIcon,
	PlugZap,
	ScrollText,
	Server,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { MentionResult, MentionType } from "@/lib/ai/mentions";
import { cn } from "@repo/ui/utils";
import { $createMentionNode } from "./mention-node";
import { useMentionSearch } from "./use-mentions";

const TYPE_ICON: Record<MentionType, LucideIcon> = {
	project: Boxes,
	cluster: Server,
	connector: PlugZap,
	job: ScrollText,
	runner: Cpu,
	identity: KeyRound,
	artifact: LayoutDashboard,
};

/** A typeahead option wrapping one resolved mention candidate. */
class MentionMenuOption extends MenuOption {
	constructor(public readonly result: MentionResult) {
		super(`${result.type}:${result.id}`);
	}
}

/**
 * Registers the `@` typeahead on the enclosing Lexical editor.
 *
 * The menu is deliberately NOT rendered into Lexical's own anchor element: that anchor is
 * positioned **at the caret**, so a menu placed relative to it sits directly on top of the text
 * you are typing (it covered the `@` itself), and its scroll container was trapped inside that
 * zero-size anchor so the list could not scroll at all. Instead we portal into the composer's
 * own wrapper (`boxRef`) and open **upward from the top edge of the composer box** — which is
 * what the pre-Lexical popover did, and what Discord does.
 */
export function MentionTypeaheadPlugin({
	boxRef,
}: {
	/** The composer's `relative` wrapper — the menu is portaled into it and opens above it. */
	boxRef: React.RefObject<HTMLDivElement | null>;
}) {
	const [editor] = useLexicalComposerContext();
	// `null` query = menu closed. Empty string = `@` with no text yet (show everything).
	const [query, setQuery] = useState<string | null>(null);
	const { results, loading } = useMentionSearch(
		query === null ? null : { start: 0, query },
	);

	const options = useMemo(
		() => results.map((r) => new MentionMenuOption(r)),
		[results],
	);

	// `@` preceded by whitespace/start; allow an empty query so the menu opens on `@` alone.
	const triggerFn = useBasicTypeaheadTriggerMatch("@", { minLength: 0 });

	// The menu opens upward, so it can only be as tall as the gap above the composer — on the
	// empty landing the composer sits mid-screen and a fixed max-height ran off the top of the
	// viewport (the header was clipped). Measure the real space and cap to it.
	const [maxHeight, setMaxHeight] = useState(320);
	useEffect(() => {
		if (query === null) return;
		const el = boxRef.current;
		if (!el) return;
		const measure = () =>
			setMaxHeight(Math.max(160, el.getBoundingClientRect().top - 16));
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [query, boxRef]);

	const onSelect = useCallback(
		(
			option: MentionMenuOption,
			nodeToReplace: TextNode | null,
			closeMenu: () => void,
		) => {
			editor.update(() => {
				const { id, type, label } = option.result;
				const pill = $createMentionNode(`@${label}`, id, type);
				if (nodeToReplace) nodeToReplace.replace(pill);
				// Trailing space + caret after it (Discord behaviour).
				const space = $createTextNode(" ");
				pill.insertAfter(space);
				space.select(1, 1);
				closeMenu();
			});
		},
		[editor],
	);

	return (
		<LexicalTypeaheadMenuPlugin<MentionMenuOption>
			options={options}
			onQueryChange={setQuery}
			onSelectOption={onSelect}
			triggerFn={triggerFn}
			commandPriority={COMMAND_PRIORITY_NORMAL}
			// Highlight the first match, so Enter picks it (Discord/Slack). Without this the
			// typeahead declines Enter and the composer's own handler SENDS the message instead.
			preselectFirstItem
			menuRenderFn={(
				_anchorElementRef,
				{ selectedIndex, selectOptionAndCleanUp, setHighlightedIndex },
			) => {
				// Portal into the COMPOSER BOX, not Lexical's caret anchor (see the note above).
				if (!boxRef.current) return null;
				return createPortal(
					<div
						data-testid="mention-menu"
						style={{ maxHeight }}
						className="absolute bottom-full left-0 z-[var(--z-overlay)] mb-2 flex w-full flex-col border border-border bg-popover shadow-md"
					>
						<div className="vx-eyebrow flex flex-none items-center gap-1.5 border-b border-border px-2.5 py-1.5 text-ui-3xs">
							Tag a resource
							{loading && <Loader2 className="h-3 w-3 animate-spin" />}
						</div>
						<ul
							data-testid="mention-menu-list"
							className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
						>
							{options.length === 0 && !loading && (
								<li className="px-3 py-2 text-xs text-muted-foreground">
									No matching resources.
								</li>
							)}
							{options.map((option, i) => {
								const Icon = TYPE_ICON[option.result.type];
								const active = i === selectedIndex;
								return (
									<li key={option.key}>
										<button
											type="button"
											data-active={active}
											ref={(el) => {
												option.setRefElement(el);
												// A custom menuRenderFn owns keyboard scrolling: keep the
												// highlighted row in view as ↑/↓ walk past the fold.
												if (el && active)
													el.scrollIntoView({ block: "nearest" });
											}}
											onMouseEnter={() => setHighlightedIndex(i)}
											onClick={() => selectOptionAndCleanUp(option)}
											className={cn(
												"flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
												active ? "bg-muted" : "hover:bg-muted",
											)}
										>
											<Icon className="h-4 w-4 flex-none text-muted-foreground" />
											<span className="min-w-0 flex-1">
												<span className="block truncate text-ui-md text-foreground">
													{option.result.label}
												</span>
												<span className="block truncate font-mono text-ui-2xs text-muted-foreground">
													{option.result.type} · {option.result.sublabel}
												</span>
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					</div>,
					boxRef.current,
				);
			}}
		/>
	);
}
