"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Project-scoped Usage server actions — the per-project analogue of the org usage actions in
// billing.ts. Every action takes a `projectId` (resolved from the URL slug in the page) and is
// tenant-guarded: the project must belong to the actor's active org, else it throws. Only what
// is genuinely scopeable per project is surfaced here — job counts, managed runner job-minutes,
// clusters, the project's estimated cloud cost, and AI credits attributed via ref_id. Seats,
// plan caps, and provisioned-runner hours stay org-wide (link out from the Usage page).

import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { currentActor } from "@/lib/authz/guard";
import { getOrgBilling } from "@/lib/billing/queries";
import { effectiveBillingPeriodStart } from "@/lib/billing/period";
import {
	aiCreditsSeriesByProject,
	sumCreditsByProject,
} from "@/lib/billing/ai-quota";
import { getServiceDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import {
	type ProjectResourceCounts,
	queryProjectResourceCounts,
	queryProjectRunningJobs,
} from "@/lib/queries/usage-counts";
import {
	queryJobMinutesByProject,
	queryJobMinutesSeriesByProject,
} from "@/lib/queries/runner-usage";

/**
 * Verifies `projectId` belongs to the actor's active org and returns the actor. The service
 * role bypasses RLS, so this cross-check is the tenancy wall for every project-scoped read
 * below (`projects.org_id` equals `user_id` in the personal scope, so this holds there too).
 */
async function assertProjectInScope(projectId: string) {
	const actor = await currentActor();
	const [row] = await getServiceDb()
		.select({ orgId: projects.org_id })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	if (!row || row.orgId !== actor.orgId) {
		// Missing OR foreign project on a render path → 404 (also hides existence from other tenants),
		// not a captured error. notFound()'s NEXT_NOT_FOUND is treated as expected by onRequestError.
		notFound();
	}
	return actor;
}

/**
 * Resolves the current billing period [start, now) for the actor's org — the same window
 * {@link getOrgUsage} meters against, so the project meter lines up with the org one. Falls
 * back to the calendar month start when there's no billing row (community / self-managed).
 */
async function currentPeriod(
	orgId: string,
): Promise<{ from: Date; to: Date; periodEnd: Date }> {
	const billing = await getOrgBilling(orgId).catch(() => null);
	const now = new Date();
	const from = effectiveBillingPeriodStart(
		billing?.currentPeriodStart,
		billing?.currentPeriodEnd,
		now,
	);
	return { from, to: now, periodEnd: billing?.currentPeriodEnd ?? now };
}

/** Managed runner job-minutes + concurrency for a project this billing period. */
export interface ProjectUsageReport {
	/** Managed-runner job-minutes this period (self-operated runners never count). */
	jobMinutes: number;
	/** Jobs that ran (completed) on a managed runner this period. */
	jobCount: number;
	/** Jobs currently in flight for this project (CLAIMED/PROCESSING). */
	runningJobs: number;
	periodStart: string;
	periodEnd: string;
}

/**
 * Job-minutes a project consumed on managed runners this billing period, plus its in-flight
 * job count. The project-scoped counterpart of {@link getOrgUsage} (read-only; any member).
 */
export async function getProjectUsage(
	projectId: string,
): Promise<ProjectUsageReport> {
	const actor = await assertProjectInScope(projectId);
	const { from, to, periodEnd } = await currentPeriod(actor.orgId);
	const [minutes, runningJobs] = await Promise.all([
		queryJobMinutesByProject(getServiceDb(), { from, to, projectId }),
		queryProjectRunningJobs(projectId),
	]);
	return {
		jobMinutes: minutes.job_minutes,
		jobCount: minutes.job_count,
		runningJobs,
		periodStart: from.toISOString(),
		periodEnd: periodEnd.toISOString(),
	};
}

/** Clusters + estimated cloud cost for one project's Usage view (read-only; any member). */
export type ProjectResourceCountsReport = ProjectResourceCounts;

/** Cluster count + estimated monthly cloud cost for a project. */
export async function getProjectResourceCounts(
	projectId: string,
): Promise<ProjectResourceCountsReport> {
	await assertProjectInScope(projectId);
	return queryProjectResourceCounts(projectId);
}

/** One day of cumulative project usage for the over-time chart. */
export interface ProjectUsagePoint {
	/** ISO date (YYYY-MM-DD), the bucket's UTC day. */
	date: string;
	runnerMinutes: number;
	jobs: number;
	aiCredits: number;
}

/** Range-windowed cumulative project usage (the picker-driven chart section). */
export interface ProjectUsageOverTime {
	series: ProjectUsagePoint[];
	totals: { runnerMinutes: number; jobs: number; aiCredits: number };
}

/** Inclusive list of UTC day keys (YYYY-MM-DD) spanning [from, to], to fill chart gaps. */
function utcDayKeys(from: Date, to: Date): string[] {
	const keys: string[] = [];
	const cursor = new Date(
		Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
	);
	const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
	// Guard against an inverted range; cap at ~13 months so a 12-month preset is safe.
	for (let i = 0; cursor.getTime() <= end && i < 400; i++) {
		keys.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return keys;
}

/**
 * Cumulative usage over an arbitrary window for one project — managed runner-minutes, jobs,
 * and AI credits, day-bucketed onto a continuous axis (empty days zero-filled). Mirrors
 * {@link getUsageOverTime} but scoped by `project_id` (and AI credits by ref_id attribution).
 * Read-only (any member); the window comes from the client's time-range picker as ISO strings.
 */
export async function getProjectUsageOverTime(
	projectId: string,
	input: { from: string; to: string },
): Promise<ProjectUsageOverTime> {
	await assertProjectInScope(projectId);
	const from = new Date(input.from);
	const to = new Date(input.to);
	if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
		return { series: [], totals: { runnerMinutes: 0, jobs: 0, aiCredits: 0 } };
	}

	const [minuteRows, aiRows] = await Promise.all([
		queryJobMinutesSeriesByProject(getServiceDb(), { from, to, projectId }),
		aiCreditsSeriesByProject(projectId, from, to),
	]);
	const minuteByDay = new Map(minuteRows.map((r) => [r.day, r]));
	const aiByDay = new Map(aiRows.map((r) => [r.day, r.credits]));

	const series: ProjectUsagePoint[] = utcDayKeys(from, to).map((date) => {
		const m = minuteByDay.get(date);
		return {
			date,
			runnerMinutes: Math.round(m?.job_minutes ?? 0),
			jobs: m?.job_count ?? 0,
			aiCredits: aiByDay.get(date) ?? 0,
		};
	});
	const totals = series.reduce(
		(acc, p) => ({
			runnerMinutes: acc.runnerMinutes + p.runnerMinutes,
			jobs: acc.jobs + p.jobs,
			aiCredits: acc.aiCredits + p.aiCredits,
		}),
		{ runnerMinutes: 0, jobs: 0, aiCredits: 0 },
	);
	return { series, totals };
}

/** AI credits attributed to a project this billing period (best-effort via ref_id). */
export interface ProjectAiUsage {
	/** Included + purchased credits attributed to this project this period. */
	creditsThisPeriod: number;
	periodStart: string;
	periodEnd: string;
}

/**
 * AI credits attributable to a project this billing period — included + purchased, best-effort
 * via `ref_id` (scan→jobs.project_id, agent→agent_threads.project_id). Rows matching neither
 * (support Ask-AI, legacy NULL ref_id) are excluded, so this is a lower bound; the Usage page
 * carries a coverage footnote. Read-only (any member).
 */
export async function getProjectAiUsage(
	projectId: string,
): Promise<ProjectAiUsage> {
	const actor = await assertProjectInScope(projectId);
	const { from, periodEnd } = await currentPeriod(actor.orgId);
	const [included, purchased] = await Promise.all([
		sumCreditsByProject(projectId, "included", from),
		sumCreditsByProject(projectId, "purchased", from),
	]);
	return {
		creditsThisPeriod: included + purchased,
		periodStart: from.toISOString(),
		periodEnd: periodEnd.toISOString(),
	};
}
