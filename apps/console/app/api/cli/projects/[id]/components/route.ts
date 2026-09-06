// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import {
	getKindDef,
	listProjectComponents,
	parseComponentPageOpts,
} from "@/lib/cli/project-components";
import { MAX_PAGE_SIZE } from "@/lib/cli/paging";
import {
	resolveCliEnvironment,
	resolveCliProject,
} from "@/lib/cli/resolve-project";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";
import { cliComponentsResponse } from "@/lib/validations/cli-contract";

/**
 * Lists a project's components — all kinds, or filtered by `?kind=` and/or `?env=`.
 *
 * `?env=` used to be documented here as "accepted for forward-compatibility but a no-op today:
 * components are project-scoped, not per-environment". That was wrong about the schema — every
 * component table has carried `environment_id` with a composite unique on it — so the filter was
 * silently dropped and a two-environment project listed both environments' rows flattened together,
 * the same `kind` and `name` twice, distinguishable only by digging into `config`.
 *
 * Unlike the write routes, an ABSENT `?env=` still lists every environment rather than defaulting to
 * one: a bare `component list` should show the whole project, and narrowing it silently would hide
 * rows a caller did not ask to hide.
 */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;
	const { id } = await params;

	const url = new URL(req.url);
	const kind = url.searchParams.get("kind") ?? undefined;
	if (kind && !getKindDef(kind)) {
		return NextResponse.json(
			{ error: `Unknown component kind "${kind}"` },
			{ status: 400 },
		);
	}

	try {
		const project = await resolveCliProject(actor.orgId, id);
		if (!project) {
			return NextResponse.json({ error: "Project not found" }, { status: 404 });
		}
		const envParam = url.searchParams.get("env");
		let environmentId: string | undefined;
		if (envParam) {
			const env = await resolveCliEnvironment(project.id, envParam);
			if (!env) {
				return NextResponse.json(
					{ error: `Environment "${envParam}" not found` },
					{ status: 404 },
				);
			}
			environmentId = env.id;
		}
		const scope = {
			orgId: actor.orgId,
			projectId: project.id,
			kindFilter: kind,
			environmentId,
		};
		const parsed = parseComponentPageOpts(url.searchParams, scope);
		if (!parsed.ok) {
			return NextResponse.json({ error: parsed.error }, { status: 400 });
		}
		const asked = (key: string) => {
			const raw = url.searchParams.get(key);
			return raw !== null && raw !== "";
		};
		const opts =
			!asked("limit") && !asked("cursor")
				? { ...parsed.opts, limit: MAX_PAGE_SIZE }
				: parsed.opts;
		const result = await listProjectComponents(scope, opts);
		return cliJson(cliComponentsResponse, result);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
