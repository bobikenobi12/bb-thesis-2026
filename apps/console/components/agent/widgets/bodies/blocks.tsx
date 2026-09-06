// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Grayscale renderers for the generative dashboard DSL blocks (stat/bar/line/grid),
// extracted from the retired artifact-panel dashboard pane so grid widgets and any
// future surface share ONE implementation. Hand-rolled SVG/flex only — no chart lib
// (the design system is strictly grayscale).

import type { ReactNode } from "react";
import type { DashboardBlock } from "@/types/jsonb.types";

/** Small empty-state line for blocks without enough data. */
function BlockEmpty({ text }: { text: string }) {
	return <div className="py-3 text-center text-ui-xs text-muted-foreground">{text}</div>;
}

/** A stat block → a big mono value + optional caption. */
export function StatCard({
	title,
	value,
	sub,
}: {
	title: string;
	value: string | number;
	sub?: string;
}) {
	return (
		<div className="flex h-full flex-col justify-center px-3 py-3">
			<div className="vx-eyebrow text-ui-3xs">{title}</div>
			<div className="mt-1 truncate font-mono text-2xl font-semibold tracking-tight text-foreground">
				{value}
			</div>
			{sub && <div className="mt-0.5 truncate text-ui-xs text-muted-foreground">{sub}</div>}
		</div>
	);
}

/**
 * A bar block → vertical grayscale bars (ink-weight; heights normalized to the
 * block's max). No charting library — the design system is strictly grayscale.
 */
export function BarChart({ data }: { data: Array<{ label: string; value: number }> }) {
	const max = Math.max(1, ...data.map((d) => d.value));
	return (
		<div className="flex h-full min-h-24 items-end gap-2">
			{data.map((d) => (
				<div
					key={d.label}
					className="flex min-w-0 flex-1 flex-col items-center gap-1"
					title={`${d.label}: ${d.value}`}
				>
					<span className="font-mono text-ui-3xs text-muted-foreground">
						{d.value}
					</span>
					<div className="flex w-full flex-1 items-end">
						<div
							className="w-full bg-foreground"
							style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }}
						/>
					</div>
					<span className="w-full truncate text-center text-ui-3xs text-muted-foreground">
						{d.label}
					</span>
				</div>
			))}
		</div>
	);
}

/**
 * A line block → an ink-weight grayscale sparkline over the point series (min/max
 * normalized).
 */
export function Sparkline({ points, label }: { points: number[]; label?: string }) {
	if (points.length < 2) {
		return (
			<BlockEmpty text={label ? `${label}: not enough data` : "Not enough data"} />
		);
	}
	const W = 300;
	const H = 80;
	const min = Math.min(...points);
	const max = Math.max(...points);
	const range = max - min || 1;
	const coords = points.map((p, i) => {
		const x = (i / (points.length - 1)) * W;
		const y = H - ((p - min) / range) * H;
		return `${x.toFixed(1)} ${y.toFixed(1)}`;
	});
	const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c}`).join(" ");
	const areaPath = `${linePath} L${W} ${H} L0 ${H} Z`;
	return (
		<div className="h-full min-h-16 w-full">
			<svg
				viewBox={`0 0 ${W} ${H}`}
				preserveAspectRatio="none"
				className="block h-full w-full text-foreground"
				aria-hidden
			>
				<title>{label ?? "trend"}</title>
				<path d={areaPath} fill="currentColor" fillOpacity="0.06" />
				<path
					d={linePath}
					fill="none"
					stroke="currentColor"
					strokeOpacity="0.6"
					strokeWidth="2"
					strokeLinejoin="round"
					strokeLinecap="round"
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
		</div>
	);
}

/** A key/value list (the DSL's `grid` block; also usage/billing summaries). */
export function KeyValueList({
	rows,
}: {
	rows: Array<{ label: string; value: ReactNode }>;
}) {
	return (
		<div className="divide-y divide-border">
			{rows.map((r) => (
				<div
					key={r.label}
					className="flex items-center justify-between gap-3 px-3 py-1.5 text-ui-sm"
				>
					<span className="truncate text-muted-foreground">{r.label}</span>
					<span className="truncate font-mono text-foreground">{r.value}</span>
				</div>
			))}
		</div>
	);
}

/** Render one dashboard block by its kind (stat/bar/line/grid) — body only, no title
 * chrome (the widget card owns the title line). */
export function DashboardBlockBody({ block }: { block: DashboardBlock }) {
	if (block.kind === "stat") {
		return <StatCard title={block.title} value={block.value} sub={block.sub} />;
	}
	if (block.kind === "grid") {
		return <KeyValueList rows={block.cells} />;
	}
	if (block.kind === "bar") {
		return (
			<div className="h-full p-3">
				<BarChart data={block.data} />
			</div>
		);
	}
	return (
		<div className="h-full p-3">
			<Sparkline points={block.points} label={block.label} />
		</div>
	);
}
