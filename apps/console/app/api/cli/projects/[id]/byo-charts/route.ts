// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// /api/cli/projects/:id/byo-charts — read, attach and detach the customer's own Helm charts (source='byo') attached to
// an environment. Gated on project `view`; org-scoped via an explicit projects.org_id filter (RLS
// bypassed here). Mirrors getProjectByoCharts (web) but omits the full scan report — status only.

import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { attachByoChart, detachByoChart } from "@/app/server/actions/byo-charts";
import { runWithActor } from "@/lib/authz/actor-context";
import { authorizeCli } from "@/lib/authz/guard";
import {
	type CursorScope,
	MAX_PAGE_SIZE,
	cursorKey,
	paginate,
	parsePageOpts,
} from "@/lib/cli/paging";
import { byoWriteError, resolveByoScope } from "@/lib/cli/byo-write";
import {
	resolveCliEnvironment,
	resolveCliProject,
	resolveDefaultEnvironmentId,
} from "@/lib/cli/resolve-project";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { projectAddons, projects } from "@/lib/db/schema";
import {
	cliByoChartAttachResponse,
	cliByoChartsResponse,
	cliOkResponse,
} from "@/lib/validations/cli-contract";

const BYO_CHARTS_LIST = "project-byo-charts";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;
	const { searchParams } = new URL(req.url);
	const envParam = searchParams.get("env");
	const cursorScope: CursorScope = { orgId: actor.orgId, list: BYO_CHARTS_LIST };
	const parsed = parsePageOpts(searchParams, cursorScope);
	if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
	const asked = (key: string) => {
		const raw = searchParams.get(key);
		return raw !== null && raw !== "";
	};
	const opts =
		!asked("limit") && !asked("cursor")
			? { ...parsed.opts, limit: MAX_PAGE_SIZE }
			: parsed.opts;

	try {
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}

		let environmentId: string | null;
		let environmentName = "";
		if (envParam) {
			const env = await resolveCliEnvironment(project.id, envParam);
			if (!env) {
				return NextResponse.json(
					{ error: `Environment "${envParam}" not found` },
					{ status: 404 },
				);
			}
			environmentId = env.id;
			environmentName = env.name;
		} else {
			environmentId = await resolveDefaultEnvironmentId(project.id);
		}
		if (!environmentId) {
			return cliJson(cliByoChartsResponse, { environment: environmentName, charts: [] });
		}

		const db = getServiceDb();
		const { items, page } = await paginate({
			db,
			table: projectAddons,
			createdAt: projectAddons.created_at,
			id: projectAddons.id,
			scope: [
				eq(projectAddons.project_id, project.id),
				eq(projectAddons.environment_id, environmentId),
				eq(projectAddons.source, "byo"),
			],
			cursor: cursorScope,
			opts,
			rows: (query) =>
				db
					.select({
						id: projectAddons.id,
						addon_id: projectAddons.addon_id,
						chart_repo: projectAddons.chart_repo,
						chart_path: projectAddons.chart_path,
						version: projectAddons.version,
						namespace: projectAddons.namespace,
						status: projectAddons.status,
						health: projectAddons.health,
						sync_status: projectAddons.sync_status,
						scan_status: projectAddons.scan_status,
						scanned_at: projectAddons.scanned_at,
						cursor_key: cursorKey(projectAddons.created_at),
					})
					.from(projectAddons)
					.innerJoin(projects, eq(projectAddons.project_id, projects.id))
					.where(and(query.where, eq(projects.org_id, actor.orgId)))
					.orderBy(...query.orderBy)
					.limit(query.limit),
			positionOf: (row) => ({ createdAt: row.cursor_key, id: row.id }),
		});

		return cliJson(cliByoChartsResponse, {
			environment: environmentName,
			charts: items.map(({ id: _id, cursor_key: _cursor, ...r }) => ({
				id: r.addon_id,
				repo_url: r.chart_repo ?? "",
				chart_path: r.chart_path ?? "",
				ref: r.version ?? "HEAD",
				namespace: r.namespace ?? "default",
				status: r.status,
				health: r.health,
				sync: r.sync_status,
				scan_status: r.scan_status,
				scanned_at: r.scanned_at?.toISOString() ?? null,
			})),
			page,
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

/**
 * Body of POST .../byo-charts — attach or update one BYO Helm chart.
 *
 * snake_case on the wire, matching every other CLI route and `byoChartWire` above, then mapped to
 * `attachByoChart`'s camelCase input. The mapping is naming only: `byoChartAttachSchema.parse` inside
 * the action is what decides validity — the repo-URL shape, the git-chart-needs-a-path refinement,
 * and the YAML-mapping check — so there is still exactly one definition of a valid chart.
 */
const attachChartBody = z.object({
	id: z.string().trim().min(1),
	repo_url: z.string().trim().min(1),
	chart_path: z.string().trim().optional(),
	ref: z.string().trim().optional(),
	namespace: z.string().trim().optional(),
	values_yaml: z.string().nullish(),
	git_credential_id: z.string().min(1).nullish(),
	values: z.record(z.string(), z.unknown()).optional(),
});

/** Attaches (or updates) a BYO Helm chart in an environment. */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const parsed = attachChartBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid request body: id and repo_url are required" },
			{ status: 400 },
		);
	}
	const b = parsed.data;

	try {
		const scope = await resolveByoScope(actor.orgId, id, req);
		if ("error" in scope) return scope.error;

		const result = await runWithActor(actor, () =>
			attachByoChart({
				projectId: scope.projectId,
				environmentId: scope.environmentId,
				id: b.id,
				repoUrl: b.repo_url,
				chartPath: b.chart_path,
				ref: b.ref,
				namespace: b.namespace,
				valuesYaml: b.values_yaml ?? null,
				gitCredentialId: b.git_credential_id ?? null,
				values: b.values,
			}),
		);
		return cliJson(cliByoChartAttachResponse, { ok: true, id: result.id }, { status: 201 });
	} catch (err: unknown) {
		return byoWriteError(err);
	}
}

/** Body of DELETE .../byo-charts — detach one chart by id. */
const detachChartBody = z.object({ id: z.string().trim().min(1) });

/** Detaches a BYO Helm chart from an environment. */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "edit", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const parsed = detachChartBody.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid request body: id is required" },
			{ status: 400 },
		);
	}

	try {
		const scope = await resolveByoScope(actor.orgId, id, req);
		if ("error" in scope) return scope.error;

		await runWithActor(actor, () =>
			detachByoChart({
				projectId: scope.projectId,
				environmentId: scope.environmentId,
				id: parsed.data.id,
			}),
		);
		return cliJson(cliOkResponse, { ok: true });
	} catch (err: unknown) {
		return byoWriteError(err);
	}
}
