// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared presentational primitives for the Usage surfaces (org + project panels). Stateless cells
// so the two panels render identically — promoted here rather than duplicated per panel, because
// the two panels answer the same question at two scopes and every difference between them is a
// claim that the org page and the project page are different products.
//
// The two usage pages now share a SPINE, not just cells: what constrains you (meters against the
// plan) · what you consumed in a window you pick (`OverTimeCard`) · what you run and what it costs
// outside the plan (`FactList`). Anything scoped to the range picker belongs to `OverTimeCard`;
// anything a picker cannot move belongs to the fact list.

import type { ReactNode } from "react";
import { formatMinutes } from "@repo/format";
import { EmptyState } from "@repo/ui/empty";
import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";

/**
 * The usage surface's ONE count rendering — a whole number with thousands separators.
 *
 * Why this is a bare `.toLocaleString()` and not a `@repo/format` call: the package has no count
 * formatter, and that is a recorded decision rather than a gap. `scripts/check-shared-surface.mjs`
 * (see its omissions header) states that with no options `.toLocaleString()` IS the correct way to
 * put separators in a count, and its self-test asserts the guard must not flag one — so a count is
 * the one quantity `@repo/format` deliberately does not own.
 *
 * What it fixes is the disagreement one level down. This surface rendered counts FOUR ways in two
 * files: `totals.jobs.toLocaleString()`, a raw `{counts.projects}`, a raw `{usage.runningJobs}`,
 * and `${jobCount.toLocaleString()} managed jobs` — so `1,204` and `1204` could sit in the same
 * `<dl>`. Every count on both usage pages now goes through here.
 *
 * Promoting this to `@repo/format` is a bigger change than it looks and is NOT this lane's: the
 * package is mirrored in Go through `packages/format/conformance/format-cases.json`, so a new
 * formatter means a new conformance section, a `packages/core/format` implementation and a
 * regenerated table — and it would be a console-wide sweep (19 bare call sites across 8 files),
 * not a usage-page one.
 */
export function count(n: number): string {
	if (!Number.isFinite(n)) return "—";
	return Math.round(n).toLocaleString();
}

/**
 * The count analogue of `@repo/format`'s `formatQuota`: a used-against-allowance pair.
 *
 * `formatQuota` exists so `47 min / 200` and `47 min / 200 min` cannot both be true; the same
 * argument applies to a pair of counts, and this surface was the counter-example. Seats printed
 * `3 / 5` when capped and a bare `3` when not, while concurrency two cells to its right printed
 * `2 / ∞` for the identical "no limit" case — one row, one kind of fact, two renderings, and the
 * one that dropped the denominator is the one that stops looking like a limit at all.
 *
 * So an absent limit is `∞` at BOTH sites, and the pair is assembled here rather than at either.
 *
 * @param limit the allowance, or null/non-finite when the plan sets none.
 */
export function countQuota(used: number, limit: number | null): string {
	return `${count(used)} / ${limit != null && Number.isFinite(limit) ? count(limit) : "∞"}`;
}

/**
 * One usage meter cell (key, value, fill %, sub note).
 *
 * THE CELL OWNS THE VALUE'S WEIGHT, and the call sites do not. They used to: two of the three
 * meters in the Plan-&-limits row wrapped their numerator in a local `<b>` and left the
 * denominator lighter, while the third — runner minutes, whose pair comes from `formatQuota` as
 * one string and cannot be split without re-assembling the pair that helper exists to prevent —
 * had no way to match. Three cells in one row, two renderings of one shape of fact. So the
 * emphasis moved here, where there is only one of it: the whole quantity reads as one quantity.
 */
export function Meter({
	label,
	value,
	sub,
	fill,
}: {
	label: string;
	value: ReactNode;
	sub: ReactNode;
	/** 0–100 fill percentage. */
	fill: number;
}) {
	return (
		<div className="border-r border-border px-6 py-4 last:border-r-0">
			<div className="mb-[9px] flex items-baseline justify-between">
				<span className="font-mono text-ui-2xs uppercase tracking-[0.1em] text-text-tertiary">
					{label}
				</span>
				<span className="text-ui-sm font-medium text-text-primary">{value}</span>
			</div>
			<div className="h-[5px] overflow-hidden rounded-full border border-border bg-surface-sunken">
				<div
					className="h-full rounded-full bg-text-primary"
					style={{ width: `${Math.min(100, Math.max(0, fill))}%` }}
				/>
			</div>
			<div className="mt-2 font-mono text-ui-2xs text-text-tertiary">{sub}</div>
		</div>
	);
}

/**
 * A list of facts about what a scope currently runs. Renders a `<dl>`; put {@link Fact} in it.
 *
 * This replaces the `Stat` card and the `grid grid-cols-2 sm:grid-cols-4` strip both usage
 * panels used to head their cards with. §6 bans stat-card strips with no qualifier, and the
 * Resources card was the argument for the ban in miniature: three 20px display figures across
 * the top, and then the number that actually costs somebody money — estimated cloud spend — as
 * a quiet label-and-value line at the bottom of the same card. Two renderings of the same kind
 * of fact, one card, and the loud one was the one that mattered least.
 *
 * So the card keeps the quiet shape and drops the loud one. A count is now read the way the
 * spend line was always read, and a `<dl>` says in the accessibility tree what the old grid of
 * divs only said in pixels: these are terms and their values.
 */
export function FactList({ children }: { children: ReactNode }) {
	return <dl>{children}</dl>;
}

/**
 * One fact: a term on the left, its value on the right, and an optional qualifier ON THE VALUE.
 *
 * `sub` belongs to the `<dd>` and never to the `<dt>`, and the difference is not cosmetic:
 * assistive tech reads a `<dt>` as ONE label, so putting the qualifier there made the term for
 * `5h 20m` read "Runner job-minutes 12 managed jobs this period" — a label containing a second,
 * unrelated measurement — and made `AI credits used *` carry a footnote marker whose footnote
 * lives outside the list. The qualifier says what the VALUE is of, so it is part of the value.
 */
export function Fact({
	label,
	value,
	sub,
	icon,
	className,
}: {
	label: string;
	value: ReactNode;
	/** What the VALUE is of — a time window, a scope note, a footnote marker. */
	sub?: ReactNode;
	/** A leading glyph on the term, for a fact the card marks as an estimate. */
	icon?: ReactNode;
	/** Row treatment, for the estimate row that closes a card. */
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex items-baseline justify-between gap-4 border-b border-border px-6 py-[11px] last:border-b-0",
				className,
			)}
		>
			<dt className="flex min-w-0 items-baseline gap-2 text-ui-sm text-text-secondary">
				{icon}
				<span className="min-w-0">{label}</span>
			</dt>
			<dd className="flex shrink-0 flex-wrap items-baseline justify-end gap-x-2 text-ui-sm">
				{sub && (
					<span className="font-mono text-ui-2xs text-text-tertiary">{sub}</span>
				)}
				<span className="font-mono text-text-primary">{value}</span>
			</dd>
		</div>
	);
}

/**
 * A lightweight CSS bar chart for one over-time metric (no chart dependency). Generic over
 * any day-keyed point so the org and project over-time series both render through it.
 */
function Bars<T extends { date: string }>({
	points,
	pick,
}: {
	points: T[];
	pick: (p: T) => number;
}) {
	const max = Math.max(1, ...points.map(pick));
	return (
		<div className="flex h-28 items-end gap-px">
			{points.map((p) => {
				const v = pick(p);
				return (
					<div
						key={p.date}
						title={`${p.date}: ${count(v)}`}
						className="min-w-[2px] flex-1 rounded-t-[1px] bg-text-primary/80 transition-colors hover:bg-text-primary"
						style={{ height: `${Math.max(2, (v / max) * 100)}%` }}
					/>
				);
			})}
		</div>
	);
}

/** The three over-time metrics. One list, so the org and project tabs cannot drift apart. */
export type Metric = "runnerMinutes" | "jobs" | "aiCredits";

/** Tab order, labels and TOTAL RENDERING for {@link OverTimeCard}. Module-private: the panels pass
 * a `metric`, they do not render the tabs themselves, so exporting this would be an export nothing
 * imports.
 *
 * `format` is here rather than at the call site because this card is the one place that renders a
 * window total, and the three metrics are not the same kind of quantity. Runner minutes are a
 * DURATION — CLAUDE.md §6's "minutes are read by a person" — so they go through `@repo/format`'s
 * `formatMinutes` and read `21h 24m`, the same answer the meters one section above give for the
 * same underlying number. Jobs and AI credits are counts and stay counts.
 *
 * `noun` is not the label lowercased, and that is the point: a formatted duration already carries
 * its unit, so pairing `21h 24m` with "runner minutes" says minutes twice. */
const METRICS: {
	id: Metric;
	label: string;
	format: (n: number) => string;
	noun: string;
}[] = [
	{
		id: "runnerMinutes",
		label: "Runner minutes",
		format: formatMinutes,
		noun: "runner time",
	},
	{ id: "jobs", label: "Jobs", format: count, noun: "jobs" },
	{ id: "aiCredits", label: "AI credits", format: count, noun: "AI credits" },
];

/**
 * The whole "usage over time" card: metric tabs, the selected metric's total for the window, and
 * the bars — or one empty state when the window holds nothing.
 *
 * THIS CARD OWNS EVERY RANGE-SCOPED NUMBER ON A USAGE PAGE, which is the reason it is a component
 * and not two copies of thirty lines. Both panels used to put the range's job TOTAL in a
 * point-in-time Resources card near the top while the range PICKER that changes it lived in a
 * different section further down — a control silently rewriting a number two sections above it.
 * The total lives here now, next to its picker, and "Resources" holds only facts a picker cannot
 * move.
 *
 * The empty branch is `EmptyState`, not the hand-rolled centred div each panel had: those two were
 * separately written, said the same sentence, and were invisible to the shared-surface guard's
 * `empty_state` matcher, which needs `text-center` AND `py-6`+ and so can only ever see the empty
 * states somebody wrote by hand in the shape it expects.
 */
export function OverTimeCard<T extends { date: string } & Record<Metric, number>>({
	metric,
	onMetricChange,
	series,
	totals,
	rangeLabel,
	error,
}: {
	metric: Metric;
	onMetricChange: (m: Metric) => void;
	/** The day-keyed series for the picked window; undefined while it loads. */
	series: T[] | undefined;
	/** Window totals per metric; undefined while they load. */
	totals: Record<Metric, number> | undefined;
	/** The picked window, as the picker names it ("Last 7 days"). */
	rangeLabel: string;
	/**
	 * The window's query FAILED — as distinct from not having answered yet.
	 *
	 * Without this the card cannot tell those apart, because both arrive as `series === undefined`,
	 * and it resolves the ambiguity the wrong way: a 500 renders the loading skeleton forever, with
	 * no error, no retry and nothing on screen that says anything is wrong. A caller that cannot
	 * fail may omit it; both of this card's callers can.
	 */
	error?: boolean;
}) {
	const active = METRICS.find((m) => m.id === metric);
	const format = active?.format ?? count;
	const noun = active?.noun ?? "";
	return (
		<div className="overflow-hidden rounded-lg border border-border bg-surface p-5 shadow-sm">
			<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
				{/* `aria-pressed` toggle buttons in a labelled group, NOT `role="tablist"` +
				    `role="tab"`. The tab role is a promise of the whole APG pattern — a
				    `tabpanel` each tab controls, roving tabindex, arrow-key navigation — and a
				    tablist that announces "tab 1 of 3" and then does nothing on an arrow key is
				    worse for a screen-reader user than the plain buttons this was. These are
				    toggles that swap one chart's series, and that is what a pressed button is. */}
				<div className="flex gap-1" role="group" aria-label="Metric">
					{METRICS.map((m) => (
						<button
							key={m.id}
							type="button"
							aria-pressed={metric === m.id}
							onClick={() => onMetricChange(m.id)}
							className={cn(
								"rounded-sm px-2.5 py-1 text-ui-sm transition-colors",
								metric === m.id
									? "bg-surface-muted text-text-primary"
									: "text-text-tertiary hover:text-text-secondary",
							)}
						>
							{m.label}
						</button>
					))}
				</div>
				<div className="font-mono text-ui-sm text-text-secondary">
					{/* An em-dash, not `count(0)`: the same distinction the chart branch below
					    draws. A window that has not answered yet has no total, and rendering `0`
					    states one. */}
					{totals && !error ? format(totals[metric]) : "—"}{" "}
					<span className="text-text-tertiary">
						{noun} · {rangeLabel.toLowerCase()}
					</span>
				</div>
			</div>
			{/* FOUR branches, and each one is a different answer to "what is in this window".
			    `error` is "we asked and it failed", `series === undefined` is "it has not answered
			    yet", `[]` is "it is genuinely empty" — the props' own docs say so, and collapsing
			    any pair of them states something untrue. Collapsing empty into loading renders
			    "Nothing was recorded" about a fetch still in flight; collapsing FAILED into loading
			    is worse, because a skeleton has no terminal state — a 500 spun it forever with
			    nothing on screen saying so.
			    None of this is hypothetical: the PROJECT panel keys its over-time query on the range
			    bounds, so `data` returns to `undefined` on EVERY picker change. */}
			{error ? (
				<EmptyState
					className="h-28 border-0 p-0 md:p-0"
					title="Usage over time is unavailable"
					description="We couldn't load this window. Pick the range again to retry."
				/>
			) : series === undefined ? (
				<Skeleton className="h-28 w-full" />
			) : series.length > 0 ? (
				<Bars points={series} pick={(p) => p[metric]} />
			) : (
				<EmptyState
					className="h-28 border-0 p-0 md:p-0"
					title="No usage in this range"
					description="Nothing was recorded in the window you picked."
				/>
			)}
		</div>
	);
}
