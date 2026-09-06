"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The org posture table — grouped by project, one row per environment (env-led, with a stage
// tier pill), the four postures (Verify / Drift / Security / Receipt), and freshness. Each
// posture header carries a "?" that defines the term and links to the docs. A row click opens
// the detail drawer (one detail surface — no inline peek). Grayscale-first; the eye lands on
// destructive marks. Horizontally scrolls on narrow viewports to keep the dense columns.
//
// SHELL. This renders through the shared `@repo/ui/table` primitives — the same shell
// `components/data-table.tsx` renders through — rather than the CSS-grid table it used to be.
// It does NOT go through `DataTable` itself, for two reasons about this table's shape rather
// than about taste:
//
//   1. The rows are INTERLEAVED with project group headers, and each project is its own row
//      group. `DataTable` maps one flat `getRowModel().rows` list; expressing a group header
//      means feeding it a grouped row model plus a render hook — an API change on a component
//      with eight other consumers.
//   2. The filtering is SERVER-side (the filter standard: store -> key -> server action) and the
//      list is deliberately not paginated: every environment in the roll-up is meant to be on
//      screen. `DataTable` would layer a client filter + pagination row model on top of that,
//      and its default 20-row page would silently truncate the roll-up. A table whose job is
//      "here is everything you still have to prove" must not hide rows.
//
// Column widths come from a `<colgroup>` + `table-fixed` instead of a grid template, so the
// columns stay locked while the cells are real `<th>`/`<td>`s.
//
// NOTE on the sticky header: `Table` wraps itself in an `overflow-x-auto` container so the dense
// columns can scroll sideways, and a horizontal scroll container is also a vertical one as far
// as `position: sticky` is concerned — the header sticks to that box, not to the page. That is
// inherited behaviour, unchanged by this swap; fixing it means giving the container a height,
// which is a visual decision rather than a refactor.

import { formatRelative } from "@repo/format";
import { FieldHelp } from "@repo/ui/field-help";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { cn } from "@repo/ui/utils";
import type { EvidenceEnvRow, RowGroup } from "./evidence-derive";
import { isStale, lastChecked, stageShort } from "./evidence-derive";
import { EVIDENCE_HELP } from "./evidence-help";
import {
	driftMark,
	EvIcon,
	isKnownCloud,
	type Mark,
	receiptMark,
	securityMark,
	TONE_TEXT,
	verifyMark,
} from "./evidence-status";

/** Column count — the project group header row spans exactly this. */
const COLUMNS = 7;

/** Cell padding. Tighter than the shell default: seven dense columns share the width. */
const CELL = "px-3 py-2.5 first:pl-4 last:pr-4";

/**
 * Stage tier -> the shared status tier, ordered by ink weight: production carries the most,
 * development the least. Same ordering `stageTextClass` encodes for the drawer's plain-text
 * rendering (production `text-secondary` > staging `text-tertiary` > default `text-disabled`),
 * so the two surfaces cannot drift apart in opposite directions.
 */
function stageTier(stage: string): StatusTier {
	switch (stage) {
		case "production":
			return "active";
		case "staging":
			return "idle";
		default:
			return "disabled";
	}
}

/** The cloud logo — a provider mark for a known cloud, else a "layers" (mixed) glyph. */
function RowProvider({
	provider,
	size = 16,
}: {
	provider: string | null;
	size?: number;
}) {
	if (isKnownCloud(provider)) {
		return <ProviderIcon provider={provider} size={size} className="shrink-0" />;
	}
	return (
		<EvIcon name="layers" size={size - 1} className="shrink-0 text-text-tertiary" />
	);
}

/** A single posture cell: tone-colored icon + short label. */
function PostureCell({ mark }: { mark: Mark }) {
	return (
		<div
			className={cn(
				"inline-flex min-w-0 items-center gap-1.5",
				TONE_TEXT[mark.tone],
			)}
		>
			<EvIcon name={mark.iconKey} size={14} className="shrink-0" />
			<span className="truncate text-ui-sm">{mark.label}</span>
		</div>
	);
}

/** A posture column header with its "?" explainer + docs link. */
function HeaderCol({
	label,
	help,
}: {
	label: string;
	help: keyof typeof EVIDENCE_HELP;
}) {
	const h = EVIDENCE_HELP[help];
	return (
		<span className="inline-flex items-center gap-1">
			{label}
			<FieldHelp
				title={h.title}
				docsHref={h.docsHref}
				side="bottom"
				className="text-text-disabled hover:text-text-secondary"
			>
				{h.body}
			</FieldHelp>
		</span>
	);
}

/** The header cell treatment — mono micro-caps, shared by all seven columns. */
const HEAD = cn(
	CELL,
	"h-auto font-mono text-ui-3xs font-normal uppercase tracking-[0.13em] text-text-tertiary",
);

/**
 * One environment row. The whole row is clickable as a convenience, and the environment name is
 * a real `<button>` so the drawer stays reachable from the keyboard — a bare `<tr onClick>` is
 * not, which is the one thing the row-sized `<button>` of the old CSS-grid table got right and
 * a naive table conversion would have silently dropped.
 */
function EnvRow({
	row,
	onOpen,
}: {
	row: EvidenceEnvRow;
	onOpen: (row: EvidenceEnvRow) => void;
}) {
	const stale = isStale(row);
	return (
		<TableRow
			className="group/row cursor-pointer border-border-faint"
			onClick={() => onOpen(row)}
		>
			<TableCell className={CELL}>
				<div className="flex min-w-0 items-center gap-2.5">
					<div className="min-w-0">
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onOpen(row);
							}}
							className="block max-w-full truncate text-left text-ui-md font-medium text-text-primary outline-none focus-visible:underline focus-visible:underline-offset-2"
						>
							{row.environmentName}
						</button>
						<div className="truncate font-mono text-ui-2xs text-text-tertiary">
							{row.region}
						</div>
					</div>
					<StatusBadge
						status={row.stage}
						tier={stageTier(row.stage)}
						label={stageShort(row.stage)}
						className="shrink-0 text-ui-3xs tracking-wider"
					/>
				</div>
			</TableCell>
			<TableCell className={CELL}>
				<PostureCell mark={verifyMark(row.verify)} />
			</TableCell>
			<TableCell className={CELL}>
				<PostureCell mark={driftMark(row.drift)} />
			</TableCell>
			<TableCell className={CELL}>
				<PostureCell mark={securityMark(row.security)} />
			</TableCell>
			<TableCell className={CELL}>
				<PostureCell mark={receiptMark(row.verify)} />
			</TableCell>
			<TableCell className={CELL}>
				<div
					className={cn(
						"flex items-center justify-end gap-1.5 font-mono text-ui-xs",
						stale ? "text-text-tertiary" : "text-text-disabled",
					)}
				>
					{stale && <EvIcon name="clock" size={11} className="shrink-0" />}
					{formatRelative(lastChecked(row))}
				</div>
			</TableCell>
			<TableCell className={CELL}>
				<div className="grid place-items-center text-text-disabled opacity-0 transition-opacity group-hover/row:opacity-100">
					<EvIcon name="arrow-right" size={14} />
				</div>
			</TableCell>
		</TableRow>
	);
}

/** The project-grouped posture table. */
export function EvidenceTable({
	groups,
	onOpen,
}: {
	groups: RowGroup[];
	onOpen: (row: EvidenceEnvRow) => void;
}) {
	return (
		<div className="overflow-hidden rounded-lg border bg-surface shadow-sm">
			<Table className="min-w-[860px] table-fixed">
				<colgroup>
					{/* Unsized, so the environment name absorbs whatever width is left over. */}
					<col />
					<col className="w-[128px]" />
					<col className="w-[116px]" />
					<col className="w-[150px]" />
					<col className="w-[104px]" />
					<col className="w-[116px]" />
					<col className="w-[36px]" />
				</colgroup>
				<TableHeader className="sticky top-0 z-[var(--z-sticky-head)] bg-surface-sunken">
					<TableRow className="hover:bg-transparent">
						<TableHead className={HEAD}>Environment</TableHead>
						<TableHead className={HEAD}>
							<HeaderCol label="Verify" help="verify" />
						</TableHead>
						<TableHead className={HEAD}>
							<HeaderCol label="Drift" help="drift" />
						</TableHead>
						<TableHead className={HEAD}>
							<HeaderCol label="Security" help="security" />
						</TableHead>
						<TableHead className={HEAD}>
							<HeaderCol label="Receipt" help="receipt" />
						</TableHead>
						<TableHead className={cn(HEAD, "text-right")}>Checked</TableHead>
						<TableHead className={HEAD}>
							<span className="sr-only">Open detail</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				{/* One <tbody> per project. Multiple bodies in one table is valid HTML and is the
				    semantic the grid version was faking: a project IS a row group. */}
				{groups.map((g) => (
					<TableBody key={g.key}>
						<TableRow className="border-border-faint hover:bg-transparent">
							<TableCell colSpan={COLUMNS} className="px-4 pb-2 pt-3.5">
								<div className="flex items-center gap-2.5">
									<RowProvider provider={g.provider} size={17} />
									<span className="font-display text-ui-md font-semibold tracking-tight text-text-primary">
										{g.label}
									</span>
								</div>
							</TableCell>
						</TableRow>
						{g.rows.map((row) => (
							<EnvRow key={row.environmentId} row={row} onOpen={onOpen} />
						))}
					</TableBody>
				))}
			</Table>
		</div>
	);
}
