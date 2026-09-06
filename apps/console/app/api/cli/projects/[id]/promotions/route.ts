// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/projects/:id/promotions — the project's environment promotions (source → target),
// optionally scoped to one target environment. Gated on project `view`; org-scoped via an explicit
// projects.org_id filter (RLS bypassed here). Mirrors listPromotions (web).

import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { NextResponse } from "next/server";
import { authorizeCli } from "@/lib/authz/guard";
import {
	type CursorScope,
	MAX_PAGE_SIZE,
	cursorKey,
	paginate,
	parsePageOpts,
} from "@/lib/cli/paging";
import { resolveCliEnvironment, resolveCliProject } from "@/lib/cli/resolve-project";
import { cliJson } from "@/lib/cli/respond";
import { getServiceDb } from "@/lib/db";
import { environmentPromotions, projectEnvironments, projects } from "@/lib/db/schema";
import { cliPromotionsResponse } from "@/lib/validations/cli-contract";

const PROMOTIONS_LIST = "project-promotions";

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
	const cursorScope: CursorScope = { orgId: actor.orgId, list: PROMOTIONS_LIST };
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

		let targetEnvId: string | null = null;
		if (envParam) {
			const env = await resolveCliEnvironment(project.id, envParam);
			if (!env) {
				return NextResponse.json(
					{ error: `Environment "${envParam}" not found` },
					{ status: 404 },
				);
			}
			targetEnvId = env.id;
		}

		const srcEnv = alias(projectEnvironments, "src_env");
		const tgtEnv = alias(projectEnvironments, "tgt_env");
		const db = getServiceDb();
		const { items, page } = await paginate({
			db,
			table: environmentPromotions,
			createdAt: environmentPromotions.created_at,
			id: environmentPromotions.id,
			scope: [
				eq(environmentPromotions.project_id, project.id),
				...(targetEnvId
					? [eq(environmentPromotions.target_environment_id, targetEnvId)]
					: []),
			],
			cursor: cursorScope,
			opts,
			rows: (query) =>
				db
					.select({
						id: environmentPromotions.id,
						source: srcEnv.name,
						target: tgtEnv.name,
						status: environmentPromotions.status,
						error_message: environmentPromotions.error_message,
						created_at: environmentPromotions.created_at,
						completed_at: environmentPromotions.completed_at,
						cursor_key: cursorKey(environmentPromotions.created_at),
					})
					.from(environmentPromotions)
					.innerJoin(projects, eq(environmentPromotions.project_id, projects.id))
					.leftJoin(srcEnv, eq(environmentPromotions.source_environment_id, srcEnv.id))
					.leftJoin(tgtEnv, eq(environmentPromotions.target_environment_id, tgtEnv.id))
					.where(and(query.where, eq(projects.org_id, actor.orgId)))
					.orderBy(...query.orderBy)
					.limit(query.limit),
			positionOf: (row) => ({ createdAt: row.cursor_key, id: row.id }),
		});

		return cliJson(cliPromotionsResponse, {
			promotions: items.map(({ cursor_key: _cursor, ...r }) => ({
				id: r.id,
				source: r.source ?? "—",
				target: r.target ?? "—",
				status: r.status,
				error_message: r.error_message,
				created_at: r.created_at.toISOString(),
				completed_at: r.completed_at?.toISOString() ?? null,
			})),
			page,
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
