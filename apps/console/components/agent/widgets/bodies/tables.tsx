"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Presentational grayscale tables for the list_* read tools, extracted from the
// transcript's ToolView so the chat AND the widget grid render the exact same bodies.
// Each takes parsed rows (zod parsing lives in the widget registry) plus optional
// row-click handlers for the artifact-panel click-throughs.

import type { ReactNode } from "react";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { StatusBadge } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";

/**
 * A status cell.
 *
 * This was a local dot-plus-label that drew the SAME grey dot for every value — a failed job
 * and a running one were visually identical, which is the opposite of what a status column is
 * for. `@repo/ui/status-badge` resolves the string to one of five grayscale tiers (fill, ring,
 * hollow, notched, faint) and is what the rest of the console already renders, so the agent's
 * tables now say the same thing the tables outside the agent do.
 *
 * `—` for a missing value is kept: it resolves to the `idle` tier, so an absent status reads as
 * absent rather than borrowing the look of a real one.
 */
function Status({ v }: { v: string | null | undefined }) {
	return <StatusBadge status={v ?? "—"} className="text-ui-2xs" />;
}

const TH = "vx-eyebrow h-auto py-2 text-ui-3xs";
const TD = "py-1.5 text-ui-sm";

/** Hairline table shell. */
export function Shell({ children }: { children: ReactNode }) {
	return <div className="overflow-hidden border border-border">{children}</div>;
}

export interface ProjectRow {
	id: string;
	name?: string | null;
	environment?: string | null;
	region?: string | null;
	status?: string | null;
}

/** Projects table (name/env/region/status), rows optionally clickable. */
export function ProjectsTable({
	rows,
	onRowClick,
}: {
	rows: ProjectRow[];
	onRowClick?: (id: string) => void;
}) {
	return (
		<Shell>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className={TH}>Project</TableHead>
						<TableHead className={TH}>Env</TableHead>
						<TableHead className={TH}>Region</TableHead>
						<TableHead className={TH}>Status</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((s) => (
						<TableRow
							key={s.id}
							onClick={onRowClick ? () => onRowClick(s.id) : undefined}
							className={onRowClick ? "cursor-pointer" : undefined}
						>
							<TableCell className={cn(TD, "font-medium")}>{s.name ?? "—"}</TableCell>
							<TableCell className={TD}>{s.environment ?? "—"}</TableCell>
							<TableCell className={cn(TD, "font-mono")}>{s.region ?? "—"}</TableCell>
							<TableCell className={TD}>
								<Status v={s.status} />
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</Shell>
	);
}

export interface JobRow {
	id: string;
	type?: string | null;
	project?: string | null;
	status?: string | null;
}

/** Jobs table (type/project/status), rows optionally clickable. */
export function JobsTable({
	rows,
	onRowClick,
}: {
	rows: JobRow[];
	onRowClick?: (id: string) => void;
}) {
	return (
		<Shell>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className={TH}>Type</TableHead>
						<TableHead className={TH}>Project</TableHead>
						<TableHead className={TH}>Status</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((j) => (
						<TableRow
							key={j.id}
							onClick={onRowClick ? () => onRowClick(j.id) : undefined}
							className={onRowClick ? "cursor-pointer" : undefined}
						>
							<TableCell className={cn(TD, "font-mono")}>{j.type ?? "—"}</TableCell>
							<TableCell className={TD}>{j.project ?? "—"}</TableCell>
							<TableCell className={TD}>
								<Status v={j.status} />
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</Shell>
	);
}

export interface ClusterRow {
	id: string;
	name?: string | null;
	region?: string | null;
	provider?: string | null;
	status?: string | null;
}

/** Clusters table (name/region/cloud/status). */
export function ClustersTable({ rows }: { rows: ClusterRow[] }) {
	return (
		<Shell>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className={TH}>Cluster</TableHead>
						<TableHead className={TH}>Region</TableHead>
						<TableHead className={TH}>Cloud</TableHead>
						<TableHead className={TH}>Status</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((c) => (
						<TableRow key={c.id}>
							<TableCell className={cn(TD, "font-medium")}>{c.name ?? "—"}</TableCell>
							<TableCell className={cn(TD, "font-mono")}>{c.region ?? "—"}</TableCell>
							<TableCell className={cn(TD, "font-mono")}>{c.provider ?? "—"}</TableCell>
							<TableCell className={TD}>
								<Status v={c.status} />
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</Shell>
	);
}

export interface ConnectorRow {
	slug: string;
	name?: string | null;
	category?: string | null;
	connected?: boolean | null;
}

/** Connectors table (name/category/connected). */
export function ConnectorsTable({ rows }: { rows: ConnectorRow[] }) {
	return (
		<Shell>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className={TH}>Connector</TableHead>
						<TableHead className={TH}>Category</TableHead>
						<TableHead className={TH}>Connected</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((c) => (
						<TableRow key={c.slug}>
							<TableCell className={cn(TD, "font-medium")}>{c.name ?? c.slug}</TableCell>
							<TableCell className={cn(TD, "font-mono")}>{c.category ?? "—"}</TableCell>
							<TableCell className={TD}>
								<Status v={c.connected ? "connected" : "not connected"} />
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</Shell>
	);
}

export interface RunnerRow {
	id: string;
	name?: string | null;
	operator?: string | null;
	online?: boolean | null;
	status?: string | null;
}

/** Runners table (name/operator/status) — grid-only (no transcript table today). */
export function RunnersTable({ rows }: { rows: RunnerRow[] }) {
	return (
		<Shell>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className={TH}>Runner</TableHead>
						<TableHead className={TH}>Operator</TableHead>
						<TableHead className={TH}>Status</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((r) => (
						<TableRow key={r.id}>
							<TableCell className={cn(TD, "font-medium")}>{r.name ?? r.id}</TableCell>
							<TableCell className={cn(TD, "font-mono")}>{r.operator ?? "—"}</TableCell>
							<TableCell className={TD}>
								<Status v={r.online ? "online" : (r.status ?? "offline")} />
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</Shell>
	);
}
